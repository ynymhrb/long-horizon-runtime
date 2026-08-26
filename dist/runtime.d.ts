import { type ExecutionAdapter, type PlannerAdapter } from './adapters.js';
import type { GoalState, GraphMutation, InterruptionCause, RecoveryPolicyOutcome } from './domain.js';
import { RuntimeEventStore, type TaskSessionLink } from './event-store.js';
import { type RecoveryResult } from './scheduler.js';
export type RecoveryResolution = 'retry' | 'confirmed_succeeded';
export interface OriginalGoalEdit {
    readonly objective: string;
    readonly reason: string;
    readonly source?: 'user' | 'model';
}
export interface CreateGoalRequest {
    readonly objective: string;
    readonly constraints?: readonly string[];
    readonly planningMode?: 'auto' | 'require_confirmation';
    readonly workspaceScope?: string;
}
export interface GoalView {
    readonly id: string;
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly state: GoalState;
    readonly revision: number;
    readonly controlRevision: number;
    readonly workspaceScope?: string;
    readonly archivedAt?: string;
    readonly sessionLinks: readonly TaskSessionLink[];
    readonly pendingProposal?: {
        readonly revision: number;
        readonly baseRevision: number;
        readonly trigger?: Record<string, unknown>;
    };
    readonly pauseReason?: string;
    readonly tasks: readonly import('./domain.js').TaskNode[];
    readonly attempts: readonly import('./event-store.js').AttemptProjection[];
    readonly artifacts: readonly import('./event-store.js').ArtifactProjection[];
    readonly decisions: readonly import('./event-store.js').DecisionProjection[];
    readonly checkpoint?: import('./event-store.js').CheckpointProjection;
    readonly accounting: {
        readonly attemptCount: number;
        readonly succeededTaskCount: number;
        readonly failedTaskCount: number;
    };
    readonly recentEvents: readonly import('./event-store.js').RuntimeEvent[];
    readonly availableActions: readonly string[];
}
export interface RuntimeOptions {
    readonly store?: RuntimeEventStore;
    readonly databasePath?: string;
    readonly artifactDirectory?: string;
    readonly artifactInlineLimitBytes?: number;
    readonly maxConcurrentTasks?: number;
    readonly defaultRetryPolicy?: {
        readonly maxAttempts: number;
    };
    readonly recoveryValidator?: (input: {
        readonly goalId: string;
        readonly task: import('./domain.js').TaskNode;
        readonly attemptId: string;
    }) => Promise<RecoveryResult>;
    readonly validator?: import('./scheduler.js').SchedulerOptions['validator'];
    readonly validators?: import('./scheduler.js').SchedulerOptions['validators'];
    readonly autoReplan?: boolean;
}
/** Durable command service. Agent/session objects may be supplied at activation time but are never persisted. */
export declare class LongTaskRuntime {
    private readonly planner;
    readonly store: RuntimeEventStore;
    private readonly ownsStore;
    private readonly artifactStore;
    private readonly scheduler;
    constructor(planner: PlannerAdapter, execution: ExecutionAdapter, options?: number | RuntimeOptions);
    createGoal(request: CreateGoalRequest, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView>;
    confirmGoal(goalId: string, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView>;
    getStatus(goalId: string): GoalView | undefined;
    /** Profile-local task inventory for the cross-session Task Area. */
    listGoals(options?: {
        readonly archived?: boolean;
    }): GoalView[];
    /** Archive hides a task from the default inventory without discarding its audit history. */
    archiveGoal(goalId: string, now?: Date): GoalView;
    /** Restoring an archive affects visibility only; it never replays cancelled work. */
    restoreGoal(goalId: string): GoalView;
    /** Remove archives older than the retention window and their unshared file artifacts. */
    purgeExpiredArchives(now?: Date, retentionDays?: number): string[];
    /** Revise the durable user objective and create a confirmation-fenced replacement plan. */
    editOriginalGoal(goalId: string, input: OriginalGoalEdit, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView>;
    /** Replan only after a terminal failure has already been durably recorded. */
    requestAutomaticReplan(goalId: string, trigger: {
        readonly task: import('./domain.js').TaskNode;
        readonly reason: string;
    }): Promise<GoalView>;
    attachSession(goalId: string, sessionId: string, kind?: TaskSessionLink['kind']): GoalView;
    resumeGoal(goalId: string, executionParent?: unknown, recoveryResolution?: RecoveryResolution, executionSignal?: AbortSignal): Promise<GoalView>;
    cancelGoal(goalId: string): GoalView;
    /** Record the interruption cause before applying the caller-selected recovery policy. */
    interruptGoal(goalId: string, cause: InterruptionCause, recoveryOutcome: RecoveryPolicyOutcome): GoalView;
    invalidateTask(goalId: string, taskId: string, reason: string, evidenceRefs?: readonly string[]): GoalView;
    /** Apply one of the constrained V1 graph mutations, preserving every prior revision. */
    mutatePlan(goalId: string, mutation: GraphMutation): GoalView;
    proposeReplan(goalId: string, mutation: GraphMutation): GoalView;
    rejectReplan(goalId: string): GoalView;
    /** Advance at most one round repeatedly, used by non-DSH callers and tests with a live parent. */
    runUntilIdle(goalId: string, executionParent?: unknown, executionSignal?: AbortSignal): Promise<void>;
    recover(executionParent?: unknown): Promise<void>;
    close(): void;
    private requireGoal;
    private view;
}
