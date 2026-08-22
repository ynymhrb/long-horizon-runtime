import { planWithValidation, type ExecutionAdapter, type PlannerAdapter } from './adapters.js'
import type { GoalState, ValidatedPlan } from './domain.js'
import { Scheduler } from './scheduler.js'

/** Goal creation command. */
export interface CreateGoalRequest { readonly objective: string; readonly constraints?: readonly string[]; readonly planningMode?: 'auto' | 'require_confirmation' }

/** Queryable runtime goal view. */
export interface GoalView { readonly id: string; readonly objective: string; readonly state: GoalState; readonly revision: number }

interface GoalRecord {
  readonly id: string
  readonly objective: string
  state: GoalState
  readonly revision: number
  readonly planningMode: 'auto' | 'require_confirmation'
  readonly plan: ValidatedPlan
}

/** In-memory command coordinator; persistence is injected by plugin composition in later revisions. */
export class LongTaskRuntime {
  private readonly goals = new Map<string, GoalRecord>()
  private sequence = 0
  private readonly scheduler: Scheduler

  constructor(private readonly planner: PlannerAdapter, execution: ExecutionAdapter, maxConcurrentTasks = 1) {
    this.scheduler = new Scheduler(execution, maxConcurrentTasks)
  }

  /** Create a goal and obtain its validated first plan. */
  async createGoal(request: CreateGoalRequest): Promise<GoalView> {
    const id = `goal-${++this.sequence}`
    const planningMode = request.planningMode ?? 'auto'
    const plan = await planWithValidation(this.planner, { goalId: id, objective: request.objective, constraints: request.constraints ?? [] })
    const record: GoalRecord = { id, objective: request.objective, state: planningMode === 'auto' ? 'RUNNING' : 'AWAITING_CONFIRMATION', revision: plan.revision, planningMode, plan }
    this.goals.set(id, record)
    if (planningMode === 'auto') await this.scheduler.runRound(id, plan.tasks as Map<string, never>)
    return this.view(record)
  }

  /** Confirm a pending initial plan and start scheduling it. */
  async confirmGoal(goalId: string): Promise<GoalView> {
    const record = this.requireGoal(goalId)
    if (record.state !== 'AWAITING_CONFIRMATION') throw new Error(`goal ${goalId} is not awaiting confirmation`)
    record.state = 'RUNNING'
    await this.scheduler.runRound(goalId, record.plan.tasks as Map<string, never>)
    return this.view(record)
  }

  /** Read the current goal view. */
  getStatus(goalId: string): GoalView | undefined { const record = this.goals.get(goalId); return record === undefined ? undefined : this.view(record) }

  /** Cancel a nonterminal goal. */
  cancelGoal(goalId: string): GoalView { const record = this.requireGoal(goalId); record.state = 'CANCELLED'; return this.view(record) }

  private requireGoal(goalId: string): GoalRecord { const record = this.goals.get(goalId); if (record === undefined) throw new Error(`unknown goal ${goalId}`); return record }
  private view(record: GoalRecord): GoalView { return { id: record.id, objective: record.objective, state: record.state, revision: record.revision } }
}
