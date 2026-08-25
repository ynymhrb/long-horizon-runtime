import { createHash, randomUUID } from 'node:crypto'
import { validateExecutionResult, type ExecutionAdapter } from './adapters.js'
import type { ContextView } from './context.js'
import type { TaskNode, TaskState } from './domain.js'
import { RuntimeEventStore } from './event-store.js'
import { ArtifactStore } from './artifacts.js'

type MutableTask = { -readonly [Key in keyof TaskNode]: TaskNode[Key] }
export type RecoveryResult = 'succeeded' | 'retry' | 'indeterminate'
export interface SchedulerOptions {
  readonly store: RuntimeEventStore
  readonly maxConcurrentTasks: number
  readonly defaultRetryPolicy?: { readonly maxAttempts: number }
  readonly recoveryValidator?: (input: { readonly goalId: string; readonly task: TaskNode; readonly attemptId: string }) => Promise<RecoveryResult>
  /** Opaque live parent used only by a DSH adapter; never persisted. */
  readonly executionParent?: unknown
  readonly validator?: (input: { readonly goalId: string; readonly task: TaskNode; readonly attemptId: string; readonly result: import('./adapters.js').ExecutionResult }) => Promise<{ readonly ok: boolean; readonly reason?: string }>
  /** Named planner validators; unknown names reject the result rather than silently succeeding. */
  readonly validators?: Readonly<Record<string, NonNullable<SchedulerOptions['validator']>>>
  readonly artifactStore?: ArtifactStore
  readonly onTerminalFailure?: (input: { readonly goalId: string; readonly task: TaskNode; readonly reason: string }) => Promise<void>
}

/** Deterministic super-step scheduler. With a store, all state transitions are durable. */
export class Scheduler {
  private readonly store: RuntimeEventStore | undefined
  private readonly maxConcurrentTasks: number
  private readonly defaultAttempts: number
  private readonly recoveryValidator?: SchedulerOptions['recoveryValidator']
  private readonly validator?: SchedulerOptions['validator']
  private readonly validators: Readonly<Record<string, NonNullable<SchedulerOptions['validator']>>>
  private readonly artifactStore: ArtifactStore | undefined
  private readonly onTerminalFailure?: SchedulerOptions['onTerminalFailure']
  private readonly aborters = new Map<string, { readonly goalId: string; readonly controller: AbortController }>()

  constructor(private readonly adapter: ExecutionAdapter, options: number | SchedulerOptions) {
    this.maxConcurrentTasks = typeof options === 'number' ? options : options.maxConcurrentTasks
    this.store = typeof options === 'number' ? undefined : options.store
    this.defaultAttempts = typeof options === 'number' ? 1 : options.defaultRetryPolicy?.maxAttempts ?? 1
    this.recoveryValidator = typeof options === 'number' ? undefined : options.recoveryValidator
    this.validator = typeof options === 'number' ? undefined : options.validator
    // `required` is the portable validator emitted by the built-in planner prompt.
    // It deliberately adds no deployment-specific policy beyond the structural
    // result/output contract checks performed below.
    this.validators = { required: async () => ({ ok: true }), ...(typeof options === 'number' ? {} : options.validators ?? {}) }
    this.artifactStore = typeof options === 'number' ? undefined : options.artifactStore
    this.onTerminalFailure = typeof options === 'number' ? undefined : options.onTerminalFailure
    if (!Number.isSafeInteger(this.maxConcurrentTasks) || this.maxConcurrentTasks < 1) throw new Error('maxConcurrentTasks must be at least one')
  }

  /** Dispatch one bounded ready set. Legacy map mode is retained for a narrow unit-test boundary. */
  async runRound(goalId: string, legacyTasks?: Map<string, TaskNode>, executionParent?: unknown, executionSignal?: AbortSignal): Promise<boolean> {
    if (this.store === undefined) { if (legacyTasks === undefined) throw new Error('legacy scheduler requires tasks'); await this.runLegacyRound(goalId, legacyTasks); return true }
    const goal = this.store.getGoal(goalId)
    if (goal?.state !== 'RUNNING') return false
    const tasks = this.store.listTasks(goalId)
    const ready = tasks.filter(task => task.state === 'PENDING' && this.dependenciesSatisfied(goalId, task, tasks))
      .sort((a, b) => b.priority - a.priority || (a.createdOrder ?? Number.MAX_SAFE_INTEGER) - (b.createdOrder ?? Number.MAX_SAFE_INTEGER)).slice(0, this.maxConcurrentTasks)
    this.store.transaction(() => this.store!.append(ready.map(task => ({ type: 'TaskReady', goalId, taskId: task.id, payload: {} }))))
    await Promise.all(ready.map(task => this.executeOne(goalId, task, executionParent, executionSignal)))
    this.store.transaction(() => {
      const events: Array<{ type: string; goalId: string; payload: Record<string, unknown> }> = [{ type: 'CheckpointCreated', goalId, payload: { eventSeq: this.store!.latestSeq(goalId), revision: goal.revision, readySet: ready.map(task => task.id), maxConcurrentTasks: this.maxConcurrentTasks, verifiedArtifactIds: this.store!.listActiveValidatedArtifacts(goalId).map(artifact => artifact.id), environmentSnapshotRef: null } }]
      const latest = this.store!.listTasks(goalId)
      // A replan proposal recorded during this round (e.g. by onTerminalFailure)
      // already moved the goal to AWAITING_CONFIRMATION, and a failed replan
      // planner pauses it. Appending GoalFailed here would overwrite either
      // decision and orphan the proposal or the pause.
      const currentState = this.store!.getGoal(goalId)?.state
      const lifecycleDecided = currentState !== undefined && currentState !== 'RUNNING'
      if (latest.length > 0 && latest.every(task => task.state === 'SUCCEEDED')) events.push({ type: 'GoalSucceeded', goalId, payload: {} })
      else if (!lifecycleDecided && latest.some(task => task.state === 'FAILED') && !latest.some(task => ['PENDING', 'READY', 'RUNNING'].includes(task.state))) events.push({ type: 'GoalFailed', goalId, payload: {} })
      this.store!.append(events)
    })
    return ready.length > 0
  }

  /** Recover nonterminal attempts. No agent is persisted or used unless a caller provides one later. */
  async recover(): Promise<readonly string[]> {
    if (this.store === undefined) return []
    const recoveredGoals = new Set<string>()
    for (const attempt of this.store.listRunningAttempts()) {
      recoveredGoals.add(attempt.goalId)
      const task = this.store.getTask(attempt.goalId, attempt.taskId)
      if (task === undefined) continue
      this.store.transaction(() => this.store!.append([{ type: 'TaskInterrupted', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id } }]))
      if (task.sideEffectClass === 'external_effect') {
        const verdict = await this.recoveryValidator?.({ goalId: attempt.goalId, task, attemptId: attempt.id }) ?? 'indeterminate'
        if (verdict === 'succeeded') this.store.transaction(() => this.store!.append([{ type: 'ValidationRecorded', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id, ok: true, validator: 'recovery' } }, { type: 'TaskCompleted', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id, summary: 'recovery confirmed effect' } }]))
        else if (verdict === 'indeterminate') this.store.transaction(() => this.store!.append([{ type: 'TaskRecoveryBlocked', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id, reason: 'external effect is indeterminate; operator must invalidate or resolve it' } }, { type: 'GoalPaused', goalId: attempt.goalId, payload: { reason: `external effect for ${task.id} is indeterminate` } }]))
      }
      // A process-local parent Agent cannot survive restart.  Safe attempts are
      // eligible to retry, but only after a later resume supplies a live parent.
      if (this.store.getGoal(attempt.goalId)?.state === 'RUNNING') this.store.transaction(() => this.store!.append([{ type: 'GoalPaused', goalId: attempt.goalId, payload: { reason: `attempt ${attempt.id} was interrupted; resume with a live parent` } }]))
    }
    for (const goalId of recoveredGoals) {
      const tasks = this.store.listTasks(goalId)
      if (tasks.length > 0 && tasks.every(task => task.state === 'SUCCEEDED')) this.store.transaction(() => this.store!.append([{ type: 'GoalSucceeded', goalId, payload: { recovered: true } }]))
    }
    return [...recoveredGoals]
  }

  cancel(goalId: string): void {
    for (const [attemptId, active] of this.aborters) if (active.goalId === goalId) { active.controller.abort(); this.adapter.cancel?.(attemptId) }
    if (this.store?.getGoal(goalId)?.state !== 'CANCELLED') this.store?.transaction(() => this.store!.append([{ type: 'GoalCancelled', goalId, payload: {} }]))
  }

  /** Stop in-flight child work without choosing a durable lifecycle transition. */
  interrupt(goalId: string): void {
    for (const [attemptId, active] of this.aborters) if (active.goalId === goalId) { active.controller.abort(); this.adapter.cancel?.(attemptId) }
  }

  private dependenciesSatisfied(goalId: string, task: TaskNode, tasks: readonly TaskNode[]): boolean {
    const byId = new Map(tasks.map(item => [item.id, item]))
    if (!task.dependsOn.every(id => byId.get(id)?.state === 'SUCCEEDED')) return false
    const requiredTypes = task.inputContract?.requiredArtifactTypes
    if (requiredTypes === undefined) return true
    if (!Array.isArray(requiredTypes) || requiredTypes.some(type => typeof type !== 'string')) return false
    const artifacts = this.store!.listActiveValidatedArtifacts(goalId, task.dependsOn)
    return requiredTypes.every(type => artifacts.some(artifact => artifact.type === type))
  }
  private context(goalId: string, task: TaskNode): ContextView {
    const artifacts = this.store!.listActiveValidatedArtifacts(goalId, task.dependsOn).map(artifact => ({ id: artifact.id, taskId: artifact.taskId, type: artifact.type, content: artifact.content ?? (artifact.path === undefined ? '' : this.artifactStore?.read(artifact) ?? ''), validated: true }))
    const goal = this.store!.getGoal(goalId)
    const priorFailure = this.store!.listAttempts(task.id, goalId).filter(attempt => attempt.state === 'FAILED').at(-1)?.summary
    const dependencySummaries = task.dependsOn.map(dependencyId => {
      const dependency = this.store!.getTask(goalId, dependencyId)
      const summary = this.store!.listAttempts(dependencyId, goalId).filter(attempt => attempt.state === 'SUCCEEDED').at(-1)?.summary
      return { taskId: dependencyId, objective: dependency?.objective ?? dependencyId, ...(summary === undefined ? {} : { summary }) }
    })
    return { objective: goal?.objective ?? goalId, ...(goal === undefined ? {} : { constraints: goal.constraints, revision: goal.revision }), task: { id: task.id, objective: task.objective, ...(task.inputContract === undefined ? {} : { inputContract: task.inputContract }), ...(task.outputContract === undefined ? {} : { outputContract: task.outputContract }), ...(task.completionCriteria === undefined ? {} : { completionCriteria: task.completionCriteria }) }, artifacts, l1DependencySummaries: dependencySummaries, l2ProjectContext: { constraints: goal?.constraints ?? [], decisions: this.store!.listDecisions(goalId), evidence: this.store!.listEvidence(goalId) }, ...(priorFailure === undefined ? {} : { priorFailureSummary: priorFailure }) }
  }
  private async executeOne(goalId: string, task: TaskNode, executionParent: unknown, executionSignal?: AbortSignal): Promise<void> {
    const attemptId = randomUUID()
    const controller = new AbortController()
    const relayAbort = () => controller.abort()
    if (executionSignal?.aborted === true) controller.abort()
    else executionSignal?.addEventListener('abort', relayAbort, { once: true })
    const attemptRevision = this.store!.getGoal(goalId)?.revision ?? 1
    const idempotencyKey = `${goalId}:${task.id}:${attemptRevision}`
    this.aborters.set(attemptId, { goalId, controller })
    let context: ContextView
    try { context = this.context(goalId, task) }
    catch (error) {
      // A corrupt/missing dependency artifact is a deterministic failed attempt,
      // not an exception that strands the goal in RUNNING.
      context = { objective: goalId, task: { id: task.id, objective: task.objective }, artifacts: [] }
      this.store!.transaction(() => this.store!.append([
        { type: 'ContextManifestRecorded', goalId, taskId: task.id, payload: { attemptId, revision: attemptRevision, selectionReason: 'direct_dependencies_and_durable_l2', context } },
        { type: 'TaskAttemptStarted', goalId, taskId: task.id, payload: { attemptId, revision: attemptRevision, context, idempotencyKey, executionParentPresent: executionParent !== undefined } },
      ]))
      this.aborters.delete(attemptId)
      this.terminalFailure(goalId, task, attemptId, failureMessage(error))
      return
    }
    this.store!.transaction(() => this.store!.append([
      { type: 'ContextManifestRecorded', goalId, taskId: task.id, payload: { attemptId, revision: attemptRevision, selectionReason: 'direct_dependencies_and_durable_l2', context } },
      { type: 'TaskAttemptStarted', goalId, taskId: task.id, payload: { attemptId, revision: attemptRevision, context, idempotencyKey, executionParentPresent: executionParent !== undefined } },
    ]))
    let result
    try { result = await this.adapter.execute({ attemptId, taskId: task.id, context, signal: controller.signal, idempotencyKey, retryPolicy: task.retryPolicy ?? { maxAttempts: this.defaultAttempts }, sideEffectClass: task.sideEffectClass, onSessionId: dshSessionId => this.store!.transaction(() => this.store!.append([{ type: 'TaskAttemptSessionRecorded', goalId, taskId: task.id, payload: { attemptId, dshSessionId } }])), ...(executionParent === undefined ? {} : { parent: executionParent }) }) } catch (error) {
      const failure = error as Error & { dshSessionId?: string }
      result = { status: 'failed' as const, summary: failure instanceof Error ? failure.message : String(failure), artifacts: [], evidence: [], ...(failure.dshSessionId === undefined ? {} : { dshSessionId: failure.dshSessionId }) }
    }
    this.aborters.delete(attemptId)
    executionSignal?.removeEventListener('abort', relayAbort)
    if (this.store!.getGoal(goalId)?.state === 'CANCELLED') return
    // A conversation stop is an operator interruption, not a failed unit of
    // work.  In particular, it must never feed the automatic-replan loop.
    if (controller.signal.aborted) {
      this.store!.transaction(() => this.store!.append([
        { type: 'TaskInterrupted', goalId, taskId: task.id, payload: { attemptId, reason: 'conversation stopped' } },
        { type: 'GoalPaused', goalId, payload: { reason: 'conversation stopped; resume with a live parent' } },
      ]))
      return
    }
    if (this.store!.getGoal(goalId)?.revision !== attemptRevision) {
      this.store!.transaction(() => this.store!.append([{ type: 'TaskAttemptSuperseded', goalId, taskId: task.id, payload: { attemptId, revision: attemptRevision, reason: 'task result belongs to an obsolete plan revision' } }]))
      return
    }
    try {
      const baseContract = validateExecutionResult(result)
      const outputContract = validateOutputContract(task, result)
      const selectedValidator = task.validator === undefined ? this.validator : this.validators[task.validator]
      const namedValidatorResult = task.validator !== undefined && selectedValidator === undefined
        ? { ok: false as const, reason: `unknown task validator: ${task.validator}` }
        : baseContract.ok && outputContract.ok && selectedValidator !== undefined ? await selectedValidator({ goalId, task, attemptId, result }) : undefined
      const contract = namedValidatorResult ?? (baseContract.ok ? outputContract : baseContract)
      const attemptCount = this.store!.listAttempts(task.id, goalId).length
      const maxAttempts = Math.max(task.retryPolicy?.maxAttempts ?? 0, this.defaultAttempts)
      this.store!.transaction(() => {
      const events: Array<{ type: string; goalId: string; taskId?: string; payload: Record<string, unknown> }> = []
      if (result.dshSessionId !== undefined) events.push({ type: 'TaskAttemptSessionRecorded', goalId, taskId: task.id, payload: { attemptId, dshSessionId: result.dshSessionId } })
      for (const [index, artifact] of result.artifacts.entries()) {
        const id = `${attemptId}:artifact:${index}`
        const stored = this.artifactStore?.put({ id, taskId: task.id, type: artifact.type, content: artifact.content, ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }) })
        events.push({ type: 'ArtifactProduced', goalId, taskId: task.id, payload: stored === undefined
          ? { id, attemptId, type: artifact.type, contentHash: createHash('sha256').update(artifact.content).digest('hex'), storage: 'inline', content: artifact.content, ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }) }
          : { ...stored, attemptId } })
      }
      for (const evidence of result.evidence) events.push({ type: 'EvidenceRecorded', goalId, taskId: task.id, payload: { attemptId, evidence } })
      events.push({ type: 'ValidationRecorded', goalId, taskId: task.id, payload: { attemptId, ok: contract.ok, validator: task.validator ?? 'result-contract', reason: contract.reason } })
      if (contract.ok) events.push({ type: 'TaskCompleted', goalId, taskId: task.id, payload: { attemptId, summary: result.summary } })
      else {
        const reason = contract.reason ?? result.summary
        events.push({ type: 'TaskAttemptFailed', goalId, taskId: task.id, payload: { attemptId, reason } })
        if (attemptCount < maxAttempts) events.push({ type: 'TaskRetryScheduled', goalId, taskId: task.id, payload: { attemptId } })
        else events.push({ type: 'TaskFailed', goalId, taskId: task.id, payload: { attemptId, reason } })
      }
      this.store!.append(events)
      })
      if (!contract.ok && attemptCount >= maxAttempts) await this.onTerminalFailure?.({ goalId, task, reason: contract.reason ?? result.summary })
    } catch (error) { this.terminalFailure(goalId, task, attemptId, failureMessage(error), result.dshSessionId) }
  }
  private terminalFailure(goalId: string, task: TaskNode, attemptId: string, reason: string, dshSessionId?: string): void {
    if (this.store!.getGoal(goalId)?.state === 'CANCELLED') return
    const attemptCount = this.store!.listAttempts(task.id, goalId).length
    const maxAttempts = Math.max(task.retryPolicy?.maxAttempts ?? 0, this.defaultAttempts)
    this.store!.transaction(() => this.store!.append([
      ...(dshSessionId === undefined ? [] : [{ type: 'TaskAttemptSessionRecorded', goalId, taskId: task.id, payload: { attemptId, dshSessionId } }]),
      { type: 'ValidationRecorded', goalId, taskId: task.id, payload: { attemptId, ok: false, validator: task.validator ?? 'runtime', reason } },
      { type: 'TaskAttemptFailed', goalId, taskId: task.id, payload: { attemptId, reason } },
      ...(attemptCount < maxAttempts ? [{ type: 'TaskRetryScheduled', goalId, taskId: task.id, payload: { attemptId } }] : [{ type: 'TaskFailed', goalId, taskId: task.id, payload: { attemptId, reason } }]),
    ]))
  }
  private async runLegacyRound(goalId: string, tasks: Map<string, TaskNode>): Promise<void> {
    const ready = [...tasks.values()].filter(task => task.state === 'PENDING' && task.dependsOn.every(id => tasks.get(id)?.state === 'SUCCEEDED')).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    for (const task of ready) this.setState(tasks, task.id, 'READY')
    await Promise.all(ready.slice(0, this.maxConcurrentTasks).map(async task => { this.setState(tasks, task.id, 'RUNNING'); const result = await this.adapter.execute({ attemptId: `${goalId}:${task.id}:${Date.now()}`, taskId: task.id, context: { objective: goalId, task: { id: task.id, objective: task.objective }, artifacts: [] }, signal: new AbortController().signal }); this.setState(tasks, task.id, validateExecutionResult(result).ok ? 'SUCCEEDED' : 'FAILED') }))
  }
  private setState(tasks: Map<string, TaskNode>, taskId: string, state: TaskState): void { const task = tasks.get(taskId); if (task === undefined) throw new Error(`unknown task ${taskId}`); tasks.set(taskId, { ...(task as MutableTask), state }) }
}

function validateOutputContract(task: TaskNode, result: import('./adapters.js').ExecutionResult): { readonly ok: boolean; readonly reason?: string } {
  if (result.status === 'failed') return { ok: false, reason: result.summary }
  const allowedTypes = new Set(['plan', 'analysis', 'code_patch', 'command_result', 'test_report', 'review', 'note'])
  if (result.artifacts.some(artifact => !allowedTypes.has(artifact.type))) return { ok: false, reason: 'result artifact type is not a V1 artifact type' }
  if (result.artifacts.some(artifact => artifact.mimeType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(artifact.mimeType))) return { ok: false, reason: 'result artifact MIME type must be type/subtype' }
  const contract = task.outputContract ?? {}
  const types = contract.artifactTypes
  if (types !== undefined) {
    if (!Array.isArray(types) || types.some(type => typeof type !== 'string')) return { ok: false, reason: 'outputContract.artifactTypes must be a string array' }
    if (result.artifacts.some(artifact => !types.includes(artifact.type))) return { ok: false, reason: 'result artifact type violates output contract' }
  }
  const mimeTypes = contract.mimeTypes
  if (mimeTypes !== undefined) {
    if (!Array.isArray(mimeTypes) || mimeTypes.some(type => typeof type !== 'string')) return { ok: false, reason: 'outputContract.mimeTypes must be a string array' }
    if (result.artifacts.some(artifact => artifact.mimeType === undefined || !mimeTypes.includes(artifact.mimeType))) return { ok: false, reason: 'result artifact MIME type violates output contract' }
  }
  return { ok: true }
}

function failureMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
