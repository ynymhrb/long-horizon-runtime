import { validatePlan } from './graph.js'
import type { PlanDraft, ValidatedPlan } from './domain.js'
import type { ContextView } from './context.js'

/**
 * Why a failed attempt failed. Only `output` failures are task-result
 * validation failures (deterministic, may trigger replanning after the retry
 * budget is exhausted). `infrastructure` covers environment/transport/LLM
 * failures that are retriable and must never count as validation evidence.
 * `interrupted` means the child was stopped or cancelled — an operator
 * interruption, never failure evidence.
 */
export type FailureKind = 'output' | 'infrastructure' | 'interrupted' | 'quota'

/** Result returned by a planner or task child agent. */
export interface ExecutionResult {
  readonly status: 'succeeded' | 'failed'
  readonly summary: string
  /** Classifies a failed result. Absent means `output` (legacy adapters). */
  readonly failureKind?: FailureKind
  /** Earliest provider-supplied time at which a quota-limited attempt may retry. */
  readonly retryAt?: string
  /** Bounded, secret-free provider diagnostic for operator visibility. */
  readonly failureDiagnostic?: string
  readonly artifacts: readonly { readonly type: string; readonly content: string; readonly mimeType?: string }[]
  readonly evidence: readonly string[]
  /** Durable reference to the child created by the DSH execution adapter. */
  readonly dshSessionId?: string
}

/** Boundary for deriving the first graph from a user goal. */
export interface PlannerAdapter {
  plan(input: { readonly goalId: string; readonly objective: string; readonly constraints: readonly string[]; readonly signal?: AbortSignal; readonly baseRevision?: number; readonly trigger?: Record<string, unknown>; readonly priorTasks?: readonly import('./domain.js').TaskNode[] }): Promise<PlanDraft>
}

/** Boundary for one isolated DSH child attempt. */
export interface ExecutionAdapter {
  /** parent is a live, opaque DSH Agent supplied by a tool call and is never durable state. */
  execute(input: { readonly attemptId: string; readonly taskId: string; readonly context: ContextView; readonly signal: AbortSignal; readonly parent?: unknown; /** Always present for runtime dispatch; optional for legacy test adapters. */ readonly idempotencyKey?: string; readonly retryPolicy?: import('./domain.js').RetryPolicy; readonly sideEffectClass?: import('./domain.js').SideEffectClass; /** Per-task execution budget override; falls back to the adapter default when absent. */ readonly timeoutMs?: number; /** Called as soon as a child session exists, before its result settles. */ readonly onSessionId?: (dshSessionId: string) => void }): Promise<ExecutionResult>
  cancel?(attemptId: string): void
  /** Whether this process still owns a published, unsettled child session. */
  isAttemptAlive?(attemptId: string): boolean
}

/** Validate a planner's untrusted structured output. */
export async function planWithValidation(adapter: PlannerAdapter, input: Parameters<PlannerAdapter['plan']>[0]): Promise<ValidatedPlan> {
  return validatePlan(await adapter.plan(input))
}

/** Validate the minimum task-result contract before accepting a success. */
export function validateExecutionResult(result: ExecutionResult): { readonly ok: boolean; readonly reason?: string } {
  if (result.status === 'failed') return { ok: false, reason: result.summary }
  if (result.artifacts.length === 0 && result.summary.trim() !== 'no_artifact') return { ok: false, reason: 'successful task declared no artifact' }
  return { ok: true }
}
