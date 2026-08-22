/** Goal lifecycle states. */
export type GoalState = 'DRAFT' | 'AWAITING_CONFIRMATION' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

/** Logical task lifecycle states. */
export type TaskState = 'PENDING' | 'READY' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'INVALIDATED' | 'SUPERSEDED' | 'CANCELLED'

/** How a scheduler may recover an interrupted task. */
export type SideEffectClass = 'read_only' | 'idempotent' | 'external_effect'

/** Retry limits are per logical task; attempts are never overwritten. */
export interface RetryPolicy { readonly maxAttempts: number }

/** One logical task supplied by a planner. */
export interface TaskDraft {
  readonly id: string
  readonly objective: string
  readonly dependsOn: readonly string[]
  readonly priority?: number
  readonly sideEffectClass?: SideEffectClass
  readonly inputContract?: Record<string, unknown>
  readonly outputContract?: Record<string, unknown>
  readonly completionCriteria?: string
  readonly retryPolicy?: RetryPolicy
  readonly validator?: string
}

/** Planner output before validation. */
export interface PlanDraft {
  readonly goalId: string
  readonly revision: number
  readonly tasks: readonly TaskDraft[]
}

/** A validated logical task in a stored revision. */
export interface TaskNode extends TaskDraft {
  readonly priority: number
  readonly sideEffectClass: SideEffectClass
  readonly state: TaskState
  readonly inputContract?: Record<string, unknown>
  readonly outputContract?: Record<string, unknown>
  readonly completionCriteria?: string
  readonly retryPolicy?: RetryPolicy
}

/** Immutable validated plan revision. */
export interface ValidatedPlan {
  readonly goalId: string
  readonly revision: number
  readonly tasks: ReadonlyMap<string, TaskNode>
}

/** The constrained graph changes available in V1. */
export type GraphMutation =
  | { readonly kind: 'invalidateTask'; readonly taskId: string; readonly reason: string; readonly evidenceRefs: readonly string[] }
  | { readonly kind: 'addTask'; readonly task: TaskDraft; readonly reason: string; readonly evidenceRefs: readonly string[] }
  | { readonly kind: 'addEdge'; readonly taskId: string; readonly dependencyId: string; readonly reason: string; readonly evidenceRefs: readonly string[] }
  | { readonly kind: 'replaceTask'; readonly taskId: string; readonly replacement: TaskDraft; readonly reason: string; readonly evidenceRefs: readonly string[] }

/** Raised when planner or mutation data does not form a runnable DAG. */
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanValidationError'
  }
}
