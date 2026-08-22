import { createHash, randomUUID } from 'node:crypto'
import { validateExecutionResult, type ExecutionAdapter } from './adapters.js'
import type { ContextView } from './context.js'
import type { TaskNode, TaskState } from './domain.js'
import { RuntimeEventStore } from './event-store.js'

type MutableTask = { -readonly [Key in keyof TaskNode]: TaskNode[Key] }
export type RecoveryResult = 'succeeded' | 'retry' | 'indeterminate'
export interface SchedulerOptions {
  readonly store: RuntimeEventStore
  readonly maxConcurrentTasks: number
  readonly defaultRetryPolicy?: { readonly maxAttempts: number }
  readonly recoveryValidator?: (input: { readonly goalId: string; readonly task: TaskNode; readonly attemptId: string }) => Promise<RecoveryResult>
  /** Opaque live parent used only by a DSH adapter; never persisted. */
  readonly executionParent?: unknown
}

/** Deterministic super-step scheduler. With a store, all state transitions are durable. */
export class Scheduler {
  private readonly store: RuntimeEventStore | undefined
  private readonly maxConcurrentTasks: number
  private readonly defaultAttempts: number
  private readonly recoveryValidator?: SchedulerOptions['recoveryValidator']

  constructor(private readonly adapter: ExecutionAdapter, options: number | SchedulerOptions) {
    this.maxConcurrentTasks = typeof options === 'number' ? options : options.maxConcurrentTasks
    this.store = typeof options === 'number' ? undefined : options.store
    this.defaultAttempts = typeof options === 'number' ? 1 : options.defaultRetryPolicy?.maxAttempts ?? 1
    this.recoveryValidator = typeof options === 'number' ? undefined : options.recoveryValidator
    if (!Number.isSafeInteger(this.maxConcurrentTasks) || this.maxConcurrentTasks < 1) throw new Error('maxConcurrentTasks must be at least one')
  }

  /** Dispatch one bounded ready set. Legacy map mode is retained for a narrow unit-test boundary. */
  async runRound(goalId: string, legacyTasks?: Map<string, TaskNode>, executionParent?: unknown): Promise<boolean> {
    if (this.store === undefined) { if (legacyTasks === undefined) throw new Error('legacy scheduler requires tasks'); await this.runLegacyRound(goalId, legacyTasks); return true }
    const goal = this.store.getGoal(goalId)
    if (goal?.state !== 'RUNNING') return false
    const tasks = this.store.listTasks(goalId)
    const ready = tasks.filter(task => task.state === 'PENDING' && this.dependenciesSatisfied(goalId, task, tasks))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, this.maxConcurrentTasks)
    this.store.transaction(() => this.store!.append(ready.map(task => ({ type: 'TaskReady', goalId, taskId: task.id, payload: {} }))))
    await Promise.all(ready.map(task => this.executeOne(goalId, task, executionParent)))
    this.store.transaction(() => this.store!.append([{ type: 'CheckpointCreated', goalId, payload: { eventSeq: this.store!.latestSeq(goalId), revision: goal.revision, readySet: ready.map(task => task.id), environmentSnapshotRef: null } }]))
    return ready.length > 0
  }

  /** Recover nonterminal attempts. No agent is persisted or used unless a caller provides one later. */
  async recover(): Promise<void> {
    if (this.store === undefined) return
    for (const attempt of this.store.listRunningAttempts()) {
      const task = this.store.getTask(attempt.goalId, attempt.taskId)
      if (task === undefined) continue
      this.store.transaction(() => this.store!.append([{ type: 'TaskInterrupted', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id } }]))
      if (task.sideEffectClass === 'external_effect') {
        const verdict = await this.recoveryValidator?.({ goalId: attempt.goalId, task, attemptId: attempt.id }) ?? 'indeterminate'
        if (verdict === 'succeeded') this.store.transaction(() => this.store!.append([{ type: 'ValidationRecorded', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id, ok: true, validator: 'recovery' } }, { type: 'TaskCompleted', goalId: attempt.goalId, taskId: task.id, payload: { attemptId: attempt.id, summary: 'recovery confirmed effect' } }]))
        else if (verdict === 'indeterminate') this.store.transaction(() => this.store!.append([{ type: 'GoalPaused', goalId: attempt.goalId, payload: { reason: `external effect for ${task.id} is indeterminate` } }]))
      }
    }
  }

  cancel(goalId: string): void { this.store?.transaction(() => this.store!.append([{ type: 'GoalCancelled', goalId, payload: {} }])) }

  private dependenciesSatisfied(goalId: string, task: TaskNode, tasks: readonly TaskNode[]): boolean {
    const byId = new Map(tasks.map(item => [item.id, item]))
    return task.dependsOn.every(id => byId.get(id)?.state === 'SUCCEEDED' && this.store!.listActiveValidatedArtifacts(goalId, [id]).length >= 0)
  }
  private context(goalId: string, task: TaskNode): ContextView {
    const artifacts = this.store!.listActiveValidatedArtifacts(goalId, task.dependsOn).map(artifact => ({ id: artifact.id, taskId: artifact.taskId, type: artifact.type, content: artifact.content ?? '', validated: true }))
    return { objective: this.store!.getGoal(goalId)?.objective ?? goalId, task: { id: task.id, objective: task.objective }, artifacts }
  }
  private async executeOne(goalId: string, task: TaskNode, executionParent: unknown): Promise<void> {
    const attemptId = randomUUID()
    const context = this.context(goalId, task)
    this.store!.transaction(() => this.store!.append([{ type: 'TaskAttemptStarted', goalId, taskId: task.id, payload: { attemptId, revision: this.store!.getGoal(goalId)?.revision ?? 1, context, executionParentPresent: executionParent !== undefined } }]))
    let result
    try { result = await this.adapter.execute({ attemptId, taskId: task.id, context, signal: new AbortController().signal }) } catch (error) { result = { status: 'failed' as const, summary: error instanceof Error ? error.message : String(error), artifacts: [], evidence: [] } }
    const contract = validateExecutionResult(result)
    const attemptCount = this.store!.listAttempts(task.id).length
    const maxAttempts = Math.max(task.retryPolicy?.maxAttempts ?? 0, this.defaultAttempts)
    this.store!.transaction(() => {
      const events: Array<{ type: string; goalId: string; taskId?: string; payload: Record<string, unknown> }> = []
      for (const [index, artifact] of result.artifacts.entries()) events.push({ type: 'ArtifactProduced', goalId, taskId: task.id, payload: { id: `${attemptId}:artifact:${index}`, attemptId, type: artifact.type, contentHash: createHash('sha256').update(artifact.content).digest('hex'), storage: 'inline', content: artifact.content } })
      for (const evidence of result.evidence) events.push({ type: 'EvidenceRecorded', goalId, taskId: task.id, payload: { attemptId, evidence } })
      events.push({ type: 'ValidationRecorded', goalId, taskId: task.id, payload: { attemptId, ok: contract.ok, validator: task.validator ?? 'result-contract', reason: contract.reason } })
      if (contract.ok) events.push({ type: 'TaskCompleted', goalId, taskId: task.id, payload: { attemptId, summary: result.summary } })
      else { events.push({ type: 'TaskFailed', goalId, taskId: task.id, payload: { attemptId, reason: contract.reason ?? result.summary } }); if (attemptCount < maxAttempts) events.push({ type: 'TaskRetryScheduled', goalId, taskId: task.id, payload: { attemptId } }) }
      this.store!.append(events)
    })
  }
  private async runLegacyRound(goalId: string, tasks: Map<string, TaskNode>): Promise<void> {
    const ready = [...tasks.values()].filter(task => task.state === 'PENDING' && task.dependsOn.every(id => tasks.get(id)?.state === 'SUCCEEDED')).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    for (const task of ready) this.setState(tasks, task.id, 'READY')
    await Promise.all(ready.slice(0, this.maxConcurrentTasks).map(async task => { this.setState(tasks, task.id, 'RUNNING'); const result = await this.adapter.execute({ attemptId: `${goalId}:${task.id}:${Date.now()}`, taskId: task.id, context: { objective: goalId, task: { id: task.id, objective: task.objective }, artifacts: [] }, signal: new AbortController().signal }); this.setState(tasks, task.id, validateExecutionResult(result).ok ? 'SUCCEEDED' : 'FAILED') }))
  }
  private setState(tasks: Map<string, TaskNode>, taskId: string, state: TaskState): void { const task = tasks.get(taskId); if (task === undefined) throw new Error(`unknown task ${taskId}`); tasks.set(taskId, { ...(task as MutableTask), state }) }
}
