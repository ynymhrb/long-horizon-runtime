import { randomUUID } from 'node:crypto'
import { planWithValidation, type ExecutionAdapter, type PlannerAdapter } from './adapters.js'
import { applyMutation } from './graph.js'
import type { GoalState, GraphMutation } from './domain.js'
import { RuntimeEventStore } from './event-store.js'
import { Scheduler, type RecoveryResult } from './scheduler.js'
import { ArtifactStore } from './artifacts.js'

export interface CreateGoalRequest { readonly objective: string; readonly constraints?: readonly string[]; readonly planningMode?: 'auto' | 'require_confirmation' }
export interface GoalView { readonly id: string; readonly objective: string; readonly constraints: readonly string[]; readonly state: GoalState; readonly revision: number; readonly pauseReason?: string; readonly tasks: readonly import('./domain.js').TaskNode[]; readonly attempts: readonly import('./event-store.js').AttemptProjection[]; readonly artifacts: readonly import('./event-store.js').ArtifactProjection[]; readonly recentEvents: readonly import('./event-store.js').RuntimeEvent[]; readonly availableActions: readonly string[] }
export interface RuntimeOptions { readonly store?: RuntimeEventStore; readonly databasePath?: string; readonly artifactDirectory?: string; readonly artifactInlineLimitBytes?: number; readonly maxConcurrentTasks?: number; readonly defaultRetryPolicy?: { readonly maxAttempts: number }; readonly recoveryValidator?: (input: { readonly goalId: string; readonly task: import('./domain.js').TaskNode; readonly attemptId: string }) => Promise<RecoveryResult>; readonly validator?: import('./scheduler.js').SchedulerOptions['validator'] }

/** Durable command service. Agent/session objects may be supplied at activation time but are never persisted. */
export class LongTaskRuntime {
  readonly store: RuntimeEventStore
  private readonly ownsStore: boolean
  private readonly scheduler: Scheduler
  constructor(private readonly planner: PlannerAdapter, execution: ExecutionAdapter, options: number | RuntimeOptions = {}) {
    const normalized = typeof options === 'number' ? { maxConcurrentTasks: options } : options
    this.ownsStore = normalized.store === undefined
    this.store = normalized.store ?? new RuntimeEventStore(normalized.databasePath ?? ':memory:')
    this.scheduler = new Scheduler(execution, { store: this.store, maxConcurrentTasks: normalized.maxConcurrentTasks ?? 1, ...(normalized.defaultRetryPolicy === undefined ? {} : { defaultRetryPolicy: normalized.defaultRetryPolicy }), ...(normalized.recoveryValidator === undefined ? {} : { recoveryValidator: normalized.recoveryValidator }), ...(normalized.validator === undefined ? {} : { validator: normalized.validator }), ...(normalized.artifactDirectory === undefined ? {} : { artifactStore: new ArtifactStore(normalized.artifactDirectory, normalized.artifactInlineLimitBytes ?? 65_536) }) })
  }
  async createGoal(request: CreateGoalRequest, executionParent?: unknown): Promise<GoalView> {
    if (request.objective.trim().length === 0) throw new Error('goal objective must not be empty')
    const id = `goal-${randomUUID()}`
    const mode = request.planningMode ?? 'auto'
    this.store.transaction(() => this.store.append([{ type: 'GoalCreated', goalId: id, payload: { objective: request.objective, constraints: request.constraints ?? [], planningMode: mode } }]))
    let plan
    try { plan = await planWithValidation(this.planner, { goalId: id, objective: request.objective, constraints: request.constraints ?? [] }) }
    catch (error) {
      this.store.transaction(() => this.store.append([{ type: 'GoalFailed', goalId: id, payload: { phase: 'planning', reason: error instanceof Error ? error.message : String(error) } }]))
      throw error
    }
    this.store.transaction(() => this.store.append([{ type: mode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId: id, payload: { revision: plan.revision, tasks: [...plan.tasks.values()] } }]))
    if (mode === 'auto' && executionParent !== undefined) await this.runUntilIdle(id, executionParent)
    return this.view(id)
  }
  async confirmGoal(goalId: string, executionParent?: unknown): Promise<GoalView> {
    const goal = this.requireGoal(goalId)
    if (goal.state !== 'AWAITING_CONFIRMATION') throw new Error(`goal ${goalId} is not awaiting confirmation`)
    const plan = this.store.getPlan(goalId)
    if (plan === undefined) throw new Error(`goal ${goalId} has no proposed plan`)
    this.store.transaction(() => this.store.append([{ type: 'PlanConfirmed', goalId, payload: { revision: plan.revision } }, { type: 'PlanRevisionApplied', goalId, payload: { revision: plan.revision, tasks: plan.tasks } }]))
    if (executionParent !== undefined) await this.runUntilIdle(goalId, executionParent)
    return this.view(goalId)
  }
  getStatus(goalId: string): GoalView | undefined { return this.store.getGoal(goalId) === undefined ? undefined : this.view(goalId) }
  async resumeGoal(goalId: string, executionParent?: unknown): Promise<GoalView> { const goal = this.requireGoal(goalId); if (goal.state !== 'PAUSED') throw new Error(`goal ${goalId} is not paused`); this.store.transaction(() => this.store.append([{ type: 'GoalResumed', goalId, payload: {} }])); if (executionParent !== undefined) await this.runUntilIdle(goalId, executionParent); return this.view(goalId) }
  cancelGoal(goalId: string): GoalView { this.requireGoal(goalId); this.scheduler.cancel(goalId); return this.view(goalId) }
  invalidateTask(goalId: string, taskId: string, reason: string, evidenceRefs: readonly string[] = []): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be changed while ${goal.state}`)
    const plan = this.store.getPlan(goalId)
    if (plan === undefined) throw new Error(`goal ${goalId} has no active plan`)
    const current = { goalId, revision: plan.revision, tasks: new Map(plan.tasks.map(task => [task.id, task])) }
    const next = applyMutation(current, { kind: 'invalidateTask', taskId, reason, evidenceRefs })
    const invalidatedTaskIds = [...next.tasks.values()].filter(task => task.state === 'INVALIDATED').map(task => task.id)
    const event = { type: goal.planningMode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId, payload: { revision: next.revision, tasks: [...next.tasks.values()], reason, evidenceRefs, invalidatedTaskIds } } as const
    this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'invalidateTask', taskId, reason, evidenceRefs } }, event]))
    return this.view(goalId)
  }
  /** Advance at most one round repeatedly, used by non-DSH callers and tests with a live parent. */
  async runUntilIdle(goalId: string, executionParent?: unknown): Promise<void> {
    for (;;) {
      const dispatched = await this.scheduler.runRound(goalId, undefined, executionParent)
      const state = this.requireGoal(goalId).state
      if (!dispatched || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(state)) return
    }
  }
  async recover(executionParent?: unknown): Promise<void> {
    const recoveredGoals = await this.scheduler.recover()
    if (executionParent !== undefined) for (const goal of recoveredGoals) await this.scheduler.runRound(goal, undefined, executionParent)
  }
  close(): void { if (this.ownsStore) this.store.close() }
  private requireGoal(goalId: string) { const goal = this.store.getGoal(goalId); if (goal === undefined) throw new Error(`unknown goal ${goalId}`); return goal }
  private view(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    const tasks = this.store.listTasks(goalId)
    const actions = goal.state === 'AWAITING_CONFIRMATION' ? ['confirm', 'cancel'] : goal.state === 'PAUSED' ? ['resume', 'cancel', 'invalidate'] : goal.state === 'RUNNING' ? ['cancel', 'invalidate'] : []
    return { id: goal.id, objective: goal.objective, constraints: goal.constraints, state: goal.state, revision: goal.revision, tasks, attempts: tasks.flatMap(task => this.store.listAttempts(task.id, goalId)), artifacts: this.store.listActiveValidatedArtifacts(goalId), recentEvents: this.store.listRecentEvents(goalId), availableActions: actions, ...(goal.pauseReason === undefined ? {} : { pauseReason: goal.pauseReason }) }
  }
}
