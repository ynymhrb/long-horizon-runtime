import { validatePlan } from './graph.js'
import type { PlanDraft, ValidatedPlan } from './domain.js'
import type { ContextView } from './context.js'

/** Result returned by a planner or task child agent. */
export interface ExecutionResult {
  readonly status: 'succeeded' | 'failed'
  readonly summary: string
  readonly artifacts: readonly { readonly type: string; readonly content: string }[]
  readonly evidence: readonly string[]
}

/** Boundary for deriving the first graph from a user goal. */
export interface PlannerAdapter {
  plan(input: { readonly goalId: string; readonly objective: string; readonly constraints: readonly string[] }): Promise<PlanDraft>
}

/** Boundary for one isolated DSH child attempt. */
export interface ExecutionAdapter {
  execute(input: { readonly attemptId: string; readonly taskId: string; readonly context: ContextView; readonly signal: AbortSignal }): Promise<ExecutionResult>
  cancel?(attemptId: string): void
}

/** Validate a planner's untrusted structured output. */
export async function planWithValidation(adapter: PlannerAdapter, input: { readonly goalId: string; readonly objective: string; readonly constraints: readonly string[] }): Promise<ValidatedPlan> {
  return validatePlan(await adapter.plan(input))
}

/** Validate the minimum task-result contract before accepting a success. */
export function validateExecutionResult(result: ExecutionResult): { readonly ok: boolean; readonly reason?: string } {
  if (result.status === 'failed') return { ok: false, reason: result.summary }
  if (result.artifacts.length === 0 && result.summary.trim() !== 'no_artifact') return { ok: false, reason: 'successful task declared no artifact' }
  return { ok: true }
}
