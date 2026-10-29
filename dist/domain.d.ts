/** Goal lifecycle states. */
export type GoalState = 'DRAFT' | 'AWAITING_CONFIRMATION' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
/** Logical task lifecycle states. */
export type TaskState = 'PENDING' | 'READY' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'INVALIDATED' | 'SUPERSEDED' | 'CANCELLED';
/** How a scheduler may recover an interrupted task. */
export type SideEffectClass = 'read_only' | 'idempotent' | 'external_effect';
/**
 * Who paused a goal. An operator pause is sticky: only an operator-authorized
 * resume may clear it, so an in-flight agent instruction cannot silently undo
 * the pause a user just requested.
 */
export type PauseOrigin = 'operator' | 'agent' | 'system';
import type { AcceptanceCheck, AcceptancePolicy } from './acceptance-contract.js';
/** Durable observation, separate from the policy chosen for what happens next. */
export type InterruptionCause = 'user_stop' | 'timeout' | 'process_loss' | 'child_failure';
export type RecoveryPolicyOutcome = 'requeue' | 'wait_for_live_parent' | 'require_resolution' | 'terminate';
/** Retry limits are per logical task; attempts are never overwritten. */
export interface RetryPolicy {
    readonly maxAttempts: number;
}
export interface BudgetLimit {
    readonly maxAttempts?: number;
    readonly maxWallTimeMs?: number;
    readonly maxEstimatedTokens?: number;
    readonly maxEstimatedCostMicros?: number;
}
/** The seven artifact types the V1 runtime accepts from a completed child. */
export declare const V1_ARTIFACT_TYPES: readonly ["plan", "analysis", "code_patch", "command_result", "test_report", "review", "note"];
export type ArtifactType = typeof V1_ARTIFACT_TYPES[number];
/** One logical task supplied by a planner. */
export interface TaskDraft {
    readonly id: string;
    readonly objective: string;
    /** Concise planner-generated label for task lists and DAG nodes. */
    readonly summary?: string;
    readonly dependsOn: readonly string[];
    readonly priority?: number;
    readonly sideEffectClass?: SideEffectClass;
    readonly inputContract?: Record<string, unknown>;
    readonly outputContract?: Record<string, unknown>;
    readonly completionCriteria?: string;
    readonly retryPolicy?: RetryPolicy;
    readonly validator?: string;
    readonly acceptanceChecks?: readonly AcceptanceCheck[];
    readonly acceptancePolicy?: AcceptancePolicy;
    /** Per-task child execution budget in milliseconds; overrides the deployment default when set. */
    readonly timeoutMs?: number;
    /** Optional named execution profile selected by the planner. */
    readonly executionProfile?: string;
    /** Capabilities that the selected profile must advertise. */
    readonly requiredCapabilities?: readonly string[];
    /** Profiles the evaluated policy may consider; omitted preserves fixed routing. */
    readonly allowedExecutionProfiles?: readonly string[];
    /** Optional task budget composed with the durable goal budget. */
    readonly budget?: BudgetLimit;
}
/** Planner output before validation. */
export interface PlanDraft {
    readonly goalId: string;
    readonly revision: number;
    readonly tasks: readonly TaskDraft[];
}
/** A validated logical task in a stored revision. */
export interface TaskNode extends TaskDraft {
    readonly priority: number;
    readonly sideEffectClass: SideEffectClass;
    readonly state: TaskState;
    readonly inputContract?: Record<string, unknown>;
    readonly outputContract?: Record<string, unknown>;
    readonly completionCriteria?: string;
    readonly retryPolicy?: RetryPolicy;
    readonly timeoutMs?: number;
    /** Persisted projection ordering; planner task array order is the stable tie-break. */
    readonly createdOrder?: number;
}
/** Immutable validated plan revision. */
export interface ValidatedPlan {
    readonly goalId: string;
    readonly revision: number;
    readonly tasks: ReadonlyMap<string, TaskNode>;
}
/** The constrained graph changes available in V1. */
export type GraphMutation = {
    readonly kind: 'invalidateTask';
    readonly taskId: string;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
} | {
    readonly kind: 'addTask';
    readonly task: TaskDraft;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
} | {
    readonly kind: 'addEdge';
    readonly taskId: string;
    readonly dependencyId: string;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
} | {
    readonly kind: 'replaceTask';
    readonly taskId: string;
    readonly replacement: TaskDraft;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
};
/** Raised when planner or mutation data does not form a runnable DAG. */
export declare class PlanValidationError extends Error {
    constructor(message: string);
}
