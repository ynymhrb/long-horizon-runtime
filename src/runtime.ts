import { randomUUID } from 'node:crypto'
import { planWithValidation, type ExecutionAdapter, type PlannerAdapter } from './adapters.js'
import { applyMutation } from './graph.js'
import type { GoalState, GraphMutation, InterruptionCause, RecoveryPolicyOutcome } from './domain.js'
import { RuntimeEventStore, type TaskSessionLink } from './event-store.js'
import { Scheduler, type RecoveryResult } from './scheduler.js'
import { ArtifactStore } from './artifacts.js'

export type RecoveryResolution = 'retry' | 'confirmed_succeeded'
export interface OriginalGoalEdit { readonly objective: string; readonly reason: string; readonly source?: 'user' | 'model' }

export interface CreateGoalRequest { readonly objective: string; readonly constraints?: readonly string[]; readonly planningMode?: 'auto' | 'require_confirmation'; readonly workspaceScope?: string }
export interface GoalView { readonly id: string; readonly objective: string; readonly constraints: readonly string[]; readonly state: GoalState; readonly revision: number; readonly controlRevision: number; readonly workspaceScope?: string; readonly archivedAt?: string; readonly sessionLinks: readonly TaskSessionLink[]; readonly pendingProposal?: { readonly revision: number; readonly baseRevision: number; readonly trigger?: Record<string, unknown> }; readonly pauseReason?: string; readonly tasks: readonly import('./domain.js').TaskNode[]; readonly attempts: readonly import('./event-store.js').AttemptProjection[]; readonly artifacts: readonly import('./event-store.js').ArtifactProjection[]; readonly decisions: readonly import('./event-store.js').DecisionProjection[]; readonly checkpoint?: import('./event-store.js').CheckpointProjection; readonly accounting: { readonly attemptCount: number; readonly succeededTaskCount: number; readonly failedTaskCount: number }; readonly recentEvents: readonly import('./event-store.js').RuntimeEvent[]; readonly availableActions: readonly string[] }
export interface RuntimeOptions { readonly store?: RuntimeEventStore; readonly databasePath?: string; readonly artifactDirectory?: string; readonly artifactInlineLimitBytes?: number; readonly maxConcurrentTasks?: number; readonly defaultRetryPolicy?: { readonly maxAttempts: number }; readonly recoveryValidator?: (input: { readonly goalId: string; readonly task: import('./domain.js').TaskNode; readonly attemptId: string }) => Promise<RecoveryResult>; readonly validator?: import('./scheduler.js').SchedulerOptions['validator']; readonly validators?: import('./scheduler.js').SchedulerOptions['validators']; readonly autoReplan?: boolean }

/** Durable command service. Agent/session objects may be supplied at activation time but are never persisted. */
export class LongTaskRuntime {
  readonly store: RuntimeEventStore
  private readonly ownsStore: boolean
  private readonly scheduler: Scheduler
  constructor(private readonly planner: PlannerAdapter, execution: ExecutionAdapter, options: number | RuntimeOptions = {}) {
    const normalized = typeof options === 'number' ? { maxConcurrentTasks: options } : options
    this.ownsStore = normalized.store === undefined
    this.store = normalized.store ?? new RuntimeEventStore(normalized.databasePath ?? ':memory:')
    this.scheduler = new Scheduler(execution, { store: this.store, maxConcurrentTasks: normalized.maxConcurrentTasks ?? 1, ...(normalized.defaultRetryPolicy === undefined ? {} : { defaultRetryPolicy: normalized.defaultRetryPolicy }), ...(normalized.recoveryValidator === undefined ? {} : { recoveryValidator: normalized.recoveryValidator }), ...(normalized.validator === undefined ? {} : { validator: normalized.validator }), ...(normalized.validators === undefined ? {} : { validators: normalized.validators }), ...(normalized.artifactDirectory === undefined ? {} : { artifactStore: new ArtifactStore(normalized.artifactDirectory, normalized.artifactInlineLimitBytes ?? 65_536) }), ...(normalized.autoReplan === true ? { onTerminalFailure: async input => { await this.requestAutomaticReplan(input.goalId, input); } } : {}) })
  }
  async createGoal(request: CreateGoalRequest, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView> {
    if (request.objective.trim().length === 0) throw new Error('goal objective must not be empty')
    const id = `lt_${randomUUID()}`
    const mode = request.planningMode ?? 'auto'
    this.store.transaction(() => this.store.append([{ type: 'GoalCreated', goalId: id, payload: { objective: request.objective, constraints: request.constraints ?? [], planningMode: mode, workspaceScope: request.workspaceScope } }]))
    let plan
    try { plan = await planWithValidation(this.planner, { goalId: id, objective: request.objective, constraints: request.constraints ?? [] }) }
    catch (error) {
      this.store.transaction(() => this.store.append([{ type: 'GoalFailed', goalId: id, payload: { phase: 'planning', reason: error instanceof Error ? error.message : String(error) } }]))
      return this.view(id)
    }
    this.store.transaction(() => this.store.append([{ type: mode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId: id, payload: { revision: plan.revision, tasks: [...plan.tasks.values()] } }]))
    if (mode === 'auto' && executionParent !== undefined) await this.runUntilIdle(id, executionParent, executionSignal)
    return this.view(id)
  }
  async confirmGoal(goalId: string, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView> {
    const goal = this.requireGoal(goalId)
    if (goal.state !== 'AWAITING_CONFIRMATION') throw new Error(`goal ${goalId} is not awaiting confirmation`)
    const plan = this.store.getPlan(goalId)
    if (plan === undefined) throw new Error(`goal ${goalId} has no proposed plan`)
    const invalidatedTaskIds = plan.invalidatedTaskIds.length > 0 ? plan.invalidatedTaskIds : plan.tasks.filter(task => task.state === 'INVALIDATED').map(task => task.id)
    this.store.transaction(() => this.store.append([{ type: 'PlanConfirmed', goalId, payload: { revision: plan.revision, invalidatedTaskIds, staleTaskIds: plan.staleTaskIds } }, { type: 'PlanRevisionApplied', goalId, payload: { revision: plan.revision, tasks: plan.tasks, invalidatedTaskIds, staleTaskIds: plan.staleTaskIds } }]))
    if (executionParent !== undefined) await this.runUntilIdle(goalId, executionParent, executionSignal)
    return this.view(goalId)
  }
  getStatus(goalId: string): GoalView | undefined { return this.store.getGoal(goalId) === undefined ? undefined : this.view(goalId) }
  /** Profile-local task inventory for the cross-session Task Area. */
  listGoals(options: { readonly archived?: boolean } = {}): GoalView[] { return this.store.listGoals(options).map(goal => this.view(goal.id)) }
  /** Archive hides a task from the default inventory without discarding its audit history. */
  archiveGoal(goalId: string, now: Date = new Date()): GoalView {
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined) return this.view(goalId)
    if (['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state)) this.scheduler.cancel(goalId)
    this.store.transaction(() => this.store.append([{ type: 'GoalArchived', goalId, payload: { archivedAt: now.toISOString() } }]))
    return this.view(goalId)
  }
  /** Restoring an archive affects visibility only; it never replays cancelled work. */
  restoreGoal(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined) this.store.transaction(() => this.store.append([{ type: 'GoalRestored', goalId, payload: {} }]))
    return this.view(goalId)
  }
  /** Revise the durable user objective and create a confirmation-fenced replacement plan. */
  async editOriginalGoal(goalId: string, input: OriginalGoalEdit, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView> {
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined) throw new Error(`goal ${goalId} is archived`)
    if (input.objective.trim().length === 0 || input.reason.trim().length === 0) throw new Error('goal objective and revision reason must not be empty')
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(goal.state)) throw new Error(`goal ${goalId} is terminal and cannot be edited`)
    if (goal.state === 'RUNNING') this.scheduler.interrupt(goalId)
    const nextVersion = this.store.listGoalVersions(goalId).length
    const baseRevision = goal.revision
    this.store.transaction(() => this.store.append([
      ...(goal.state === 'RUNNING' ? [{ type: 'GoalPaused', goalId, payload: { reason: 'original_goal_edit' } }] : []),
      { type: 'GoalObjectiveRevised', goalId, payload: { version: nextVersion, objective: input.objective, reason: input.reason, source: input.source ?? 'user', createdAt: new Date().toISOString() } },
      { type: 'DecisionRecorded', goalId, payload: { type: 'original_goal_edit', baseRevision, reason: input.reason } },
    ]))
    try {
      const planned = await planWithValidation(this.planner, { goalId, objective: input.objective, constraints: goal.constraints })
      const revision = baseRevision + 1
      this.store.transaction(() => this.store.append([{ type: 'PlanProposed', goalId, payload: { revision, baseRevision, trigger: { kind: 'original_goal_edit', reason: input.reason }, tasks: [...planned.tasks.values()] } }]))
    } catch (error) {
      this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'goal_replan_failed', reason: error instanceof Error ? error.message : String(error) } }]))
    }
    void executionParent; void executionSignal
    return this.view(goalId)
  }
  /** Replan only after a terminal failure has already been durably recorded. */
  async requestAutomaticReplan(goalId: string, trigger: { readonly task: import('./domain.js').TaskNode; readonly reason: string }): Promise<GoalView> {
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined || goal.state !== 'RUNNING') return this.view(goalId)
    const currentTasks = this.store.listTasks(goalId)
    try {
      const planned = await planWithValidation(this.planner, { goalId, objective: goal.objective, constraints: goal.constraints, baseRevision: goal.revision, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason }, priorTasks: currentTasks })
      const candidate = [...planned.tasks.values()]
      const safe = automaticReplanIsSafe(currentTasks, candidate)
      const revision = goal.revision + 1
      const tasks = preserveCompletedTasks(currentTasks, candidate)
      this.store.transaction(() => this.store.append([
        { type: 'DecisionRecorded', goalId, payload: { type: 'automatic_replan', outcome: safe ? 'auto_applied' : 'await_confirmation', trigger: { taskId: trigger.task.id, reason: trigger.reason } } },
        safe
          ? { type: 'PlanRevisionApplied', goalId, payload: { revision, tasks, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason } } }
          : { type: 'PlanProposed', goalId, payload: { revision, baseRevision: goal.revision, tasks, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason } } },
      ]))
    } catch (error) {
      this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'automatic_replan_failed', taskId: trigger.task.id, reason: error instanceof Error ? error.message : String(error) } }, { type: 'GoalPaused', goalId, payload: { reason: `automatic replan failed for ${trigger.task.id}` } }]))
    }
    return this.view(goalId)
  }
  attachSession(goalId: string, sessionId: string, kind: TaskSessionLink['kind'] = 'attached'): GoalView {
    if (sessionId.trim().length === 0) throw new Error('session id must not be empty')
    const goal = this.requireGoal(goalId)
    const exists = this.store.listSessionLinks(goalId).some(link => link.sessionId === sessionId && link.kind === kind)
    if (!exists) this.store.transaction(() => this.store.append([
      { type: 'TaskSessionAttached', goalId, payload: { sessionId, kind } },
      { type: 'TaskControlRevisionAdvanced', goalId, payload: { controlRevision: goal.controlRevision + 1 } },
    ]))
    return this.view(goalId)
  }
  async resumeGoal(goalId: string, executionParent?: unknown, recoveryResolution?: RecoveryResolution, executionSignal?: AbortSignal): Promise<GoalView> {
    const goal = this.requireGoal(goalId)
    if (goal.state !== 'PAUSED') throw new Error(`goal ${goalId} is not paused`)
    const blockedExternalTask = this.store.listTasks(goalId).find(task => task.state === 'BLOCKED' && task.sideEffectClass === 'external_effect')
    if (blockedExternalTask !== undefined) {
      if (recoveryResolution === undefined) throw new Error(`goal ${goalId} requires an explicit recovery resolution for external task ${blockedExternalTask.id}`)
      this.store.transaction(() => this.store.append([
        { type: 'DecisionRecorded', goalId, payload: { type: 'external_recovery_resolution', taskId: blockedExternalTask.id, resolution: recoveryResolution } },
        { type: 'TaskRecoveryResolved', goalId, taskId: blockedExternalTask.id, payload: { resolution: recoveryResolution } },
        { type: 'GoalResumed', goalId, payload: { recoveryResolution, taskId: blockedExternalTask.id } },
      ]))
    } else {
      if (recoveryResolution !== undefined) throw new Error(`goal ${goalId} has no indeterminate external effect to resolve`)
      this.store.transaction(() => this.store.append([{ type: 'GoalResumed', goalId, payload: {} }]))
    }
    if (executionParent !== undefined) await this.runUntilIdle(goalId, executionParent, executionSignal)
    return this.view(goalId)
  }
  cancelGoal(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be cancelled while ${goal.state}`)
    this.scheduler.cancel(goalId)
    return this.view(goalId)
  }
  /** Record the interruption cause before applying the caller-selected recovery policy. */
  interruptGoal(goalId: string, cause: InterruptionCause, recoveryOutcome: RecoveryPolicyOutcome): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be interrupted while ${goal.state}`)
    this.scheduler.interrupt(goalId)
    this.store.transaction(() => this.store.append([{ type: 'ExecutionInterrupted', goalId, payload: { cause, recoveryOutcome } }]))
    if (recoveryOutcome === 'terminate') this.scheduler.cancel(goalId)
    return this.view(goalId)
  }
  invalidateTask(goalId: string, taskId: string, reason: string, evidenceRefs: readonly string[] = []): GoalView {
    return this.mutatePlan(goalId, { kind: 'invalidateTask', taskId, reason, evidenceRefs })
  }
  /** Apply one of the constrained V1 graph mutations, preserving every prior revision. */
  mutatePlan(goalId: string, mutation: GraphMutation): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be changed while ${goal.state}`)
    const plan = this.store.getPlan(goalId)
    if (plan === undefined) throw new Error(`goal ${goalId} has no active plan`)
    // The revision JSON is immutable historical input. Current task projections
    // include success/failure since that revision and must seed every mutation.
    const current = { goalId, revision: goal.revision, tasks: new Map(this.store.listTasks(goalId).map(task => [task.id, task])) }
    const next = applyMutation(current, mutation)
    const invalidatedTaskIds = [...next.tasks.values()].filter(task => task.state === 'INVALIDATED').map(task => task.id)
    const staleTaskIds = mutation.kind === 'replaceTask' || mutation.kind === 'addEdge'
      ? [...next.tasks.values()].filter(task => task.state === 'PENDING' && this.store.getTask(goalId, task.id)?.state === 'SUCCEEDED').map(task => task.id)
      : []
    const event = { type: goal.planningMode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId, payload: { revision: next.revision, tasks: [...next.tasks.values()], reason: mutation.reason, evidenceRefs: mutation.evidenceRefs, invalidatedTaskIds, staleTaskIds } } as const
    this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: mutation.kind, mutation } }, event]))
    return this.view(goalId)
  }
  proposeReplan(goalId: string, mutation: GraphMutation): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be replanned while ${goal.state}`)
    const current = { goalId, revision: goal.revision, tasks: new Map(this.store.listTasks(goalId).map(task => [task.id, task])) }
    const next = applyMutation(current, mutation)
    this.store.transaction(() => this.store.append([
      { type: 'DecisionRecorded', goalId, payload: { type: 'replan_proposed', mutation } },
      { type: 'PlanProposed', goalId, payload: { revision: next.revision, baseRevision: goal.revision, trigger: { reason: mutation.reason, evidenceRefs: mutation.evidenceRefs }, tasks: [...next.tasks.values()] } },
    ]))
    return this.view(goalId)
  }
  rejectReplan(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    const proposal = this.store.getPlan(goalId)
    if (goal.state !== 'AWAITING_CONFIRMATION' || proposal?.state !== 'PROPOSED' || proposal.baseRevision === undefined) throw new Error(`goal ${goalId} has no replan proposal`)
    this.store.transaction(() => this.store.append([{ type: 'PlanRejected', goalId, payload: { revision: proposal.revision, restoreState: 'RUNNING' } }]))
    return this.view(goalId)
  }
  /** Advance at most one round repeatedly, used by non-DSH callers and tests with a live parent. */
  async runUntilIdle(goalId: string, executionParent?: unknown, executionSignal?: AbortSignal): Promise<void> {
    for (;;) {
      const dispatched = await this.scheduler.runRound(goalId, undefined, executionParent, executionSignal)
      const state = this.requireGoal(goalId).state
      if (!dispatched || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(state)) return
    }
  }
  async recover(executionParent?: unknown): Promise<void> {
    const recoveredGoals = await this.scheduler.recover()
    if (executionParent !== undefined) for (const goal of recoveredGoals) {
      // An indeterminate external effect is a durable operator choice.  A
      // live parent is not authority to silently decide whether to replay it.
      const requiresResolution = this.store.listTasks(goal).some(task => task.state === 'BLOCKED' && task.sideEffectClass === 'external_effect')
      if (this.store.getGoal(goal)?.state === 'PAUSED' && !requiresResolution) await this.resumeGoal(goal, executionParent)
    }
  }
  close(): void { if (this.ownsStore) this.store.close() }
  private requireGoal(goalId: string) { const goal = this.store.getGoal(goalId); if (goal === undefined) throw new Error(`unknown goal ${goalId}`); return goal }
  private view(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    const tasks = this.store.listTasks(goalId)
    const actions = goal.state === 'AWAITING_CONFIRMATION' ? ['confirm', 'cancel'] : goal.state === 'PAUSED' ? ['resume', 'cancel', 'invalidate'] : goal.state === 'RUNNING' ? ['cancel', 'invalidate'] : []
    const attempts = tasks.flatMap(task => this.store.listAttempts(task.id, goalId))
    const plan = this.store.getPlan(goalId)
    return { id: goal.id, objective: goal.objective, constraints: goal.constraints, state: goal.state, revision: goal.revision, controlRevision: goal.controlRevision, ...(goal.workspaceScope === undefined ? {} : { workspaceScope: goal.workspaceScope }), ...(goal.archivedAt === undefined ? {} : { archivedAt: goal.archivedAt }), sessionLinks: this.store.listSessionLinks(goalId), ...(plan?.state === 'PROPOSED' && plan.baseRevision !== undefined ? { pendingProposal: { revision: plan.revision, baseRevision: plan.baseRevision, ...(plan.trigger === undefined ? {} : { trigger: plan.trigger }) } } : {}), tasks, attempts, artifacts: this.store.listActiveValidatedArtifacts(goalId), decisions: this.store.listDecisions(goalId), ...(this.store.latestCheckpoint(goalId) === undefined ? {} : { checkpoint: this.store.latestCheckpoint(goalId)! }), accounting: { attemptCount: attempts.length, succeededTaskCount: tasks.filter(task => task.state === 'SUCCEEDED').length, failedTaskCount: tasks.filter(task => task.state === 'FAILED').length }, recentEvents: this.store.listRecentEvents(goalId), availableActions: actions, ...(goal.pauseReason === undefined ? {} : { pauseReason: goal.pauseReason }) }
  }
}

function automaticReplanIsSafe(previous: readonly import('./domain.js').TaskNode[], candidate: readonly import('./domain.js').TaskNode[]): boolean {
  const next = new Map(candidate.map(task => [task.id, task]))
  for (const task of previous) {
    const replacement = next.get(task.id)
    if (task.state === 'SUCCEEDED' && (replacement === undefined || replacement.objective !== task.objective || replacement.sideEffectClass !== task.sideEffectClass || JSON.stringify(replacement.dependsOn) !== JSON.stringify(task.dependsOn))) return false
  }
  return candidate.every(task => task.sideEffectClass !== 'external_effect')
}

function preserveCompletedTasks(previous: readonly import('./domain.js').TaskNode[], candidate: readonly import('./domain.js').TaskNode[]): import('./domain.js').TaskNode[] {
  const old = new Map(previous.map(task => [task.id, task]))
  return candidate.map(task => old.get(task.id)?.state === 'SUCCEEDED' ? { ...task, state: 'SUCCEEDED' as const } : task)
}
