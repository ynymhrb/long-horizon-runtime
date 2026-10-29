import type { GoalState, PauseOrigin, TaskNode } from './domain.js';
import type { BudgetLimit, BudgetUsage } from './budgets.js';
/** Durable event accepted by the runtime event log. Payloads must be JSON serializable. */
export interface RuntimeEvent {
    readonly type: string;
    readonly goalId: string;
    readonly taskId?: string;
    readonly payload: Record<string, unknown>;
    readonly seq?: number;
    readonly createdAt?: string;
}
export interface TaskSessionLink {
    readonly sessionId: string;
    readonly kind: 'origin' | 'attached' | 'execution_child';
}
export interface CurrentTaskBinding {
    readonly sessionId: string;
    readonly taskId: string;
    readonly controlRevision: number;
    readonly updatedOrder: number;
}
export interface GoalProjection {
    readonly id: string;
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly planningMode: 'auto' | 'require_confirmation';
    readonly state: GoalState;
    readonly revision: number;
    readonly controlRevision: number;
    readonly workspaceScope?: string;
    readonly pauseReason?: string;
    readonly pauseOrigin?: PauseOrigin;
    readonly archivedAt?: string;
}
export interface GoalVersion {
    readonly version: number;
    readonly objective: string;
    readonly reason: string;
    readonly source: string;
    readonly createdAt: string;
}
export interface AttemptProjection {
    readonly id: string;
    readonly goalId: string;
    readonly taskId: string;
    readonly revision: number;
    readonly state: string;
    readonly dshSessionId?: string;
    readonly context: Record<string, unknown>;
    readonly summary?: string;
    readonly startedAt?: string;
    readonly lastActivityAt?: string;
    readonly leaseExpiresAt?: string;
    readonly maxWallExpiresAt?: string;
    readonly latestProgress?: {
        readonly phase: string;
        readonly message: string;
        readonly completed?: number;
        readonly total?: number;
    };
}
export interface ArtifactProjection {
    readonly id: string;
    readonly goalId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly type: string;
    readonly contentHash: string;
    readonly storage: 'inline' | 'file';
    readonly content?: string;
    readonly path?: string;
    readonly mimeType?: string;
    readonly active: boolean;
    readonly validated: boolean;
}
export interface DecisionProjection {
    readonly type: string;
    readonly payload: Record<string, unknown>;
}
export interface EvidenceProjection {
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly value: unknown;
}
export interface CheckpointProjection {
    readonly eventSeq?: number;
    readonly revision: number;
    readonly payload: Record<string, unknown>;
}
export interface ContextManifestProjection {
    readonly attemptId: string;
    readonly taskId: string;
    readonly revision: number;
    readonly selectionReason: string;
    readonly context: Record<string, unknown>;
}
export interface QuotaRecovery {
    readonly goalId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly retryAt: string;
    readonly diagnostic: string;
}
export interface ExecutionProfileResolutionProjection {
    readonly taskId: string;
    readonly attemptId: string;
    readonly profileId: string;
    readonly providerName: string;
    readonly agentOptionsHash: string;
    readonly capabilities: readonly string[];
    readonly toolDeny: readonly string[];
    readonly timeoutMs: number;
    readonly selectionReason: string;
}
export interface BudgetSummaryProjection {
    readonly goal: BudgetLimit;
    readonly usage: BudgetUsage;
    readonly reservations: readonly {
        readonly attemptId: string;
        readonly usage: BudgetUsage;
    }[];
}
export interface ExecutionEvaluationProjection {
    readonly taskId: string;
    readonly attemptId: string;
    readonly profileId?: string;
    readonly outcome: string;
    readonly wallTimeMs: number;
    readonly validatorOk: boolean;
    readonly artifactContractOk: boolean;
}
export interface ExecutionPolicyDecisionProjection {
    readonly taskId: string;
    readonly attemptId: string;
    readonly selectedProfileId: string;
    readonly policyVersion: string;
    readonly candidates: readonly {
        readonly profileId: string;
        readonly score: number;
    }[];
    readonly excluded: readonly {
        readonly profileId: string;
        readonly reason: string;
    }[];
}
export interface MemoryIndexEntryProjection {
    readonly memoryId: string;
    readonly contentHash: string;
    readonly sourceRef: string;
    readonly active: boolean;
}
export interface MemoryRecordProjection {
    readonly memoryId: string;
    readonly text: string;
    readonly sourceRef: string;
    readonly active: boolean;
    readonly workspaceId?: string;
}
export interface RunRoundProjection {
    readonly round: number;
    readonly revision: number;
    readonly startedAt: string;
    readonly finishedAt?: string;
    readonly outcome?: string;
}
export interface RuntimeMetrics {
    readonly runRoundCount: number;
    readonly activeRunTimeMs: number;
    readonly elapsedRunTimeMs: number;
    readonly firstStartedAt?: string;
    readonly lastFinishedAt?: string;
    readonly activeRound?: Pick<RunRoundProjection, 'round' | 'revision' | 'startedAt'>;
}
/** SQLite append-only event log and entirely rebuildable materialized projections. */
export declare class RuntimeEventStore {
    private readonly db;
    constructor(path: string);
    /** Append events and project them within the caller's transaction, if any. */
    append(events: readonly RuntimeEvent[]): void;
    /** Run related event writes atomically. Nested transactions are intentionally not supported. */
    transaction<T>(work: () => T): T;
    /** Rebuild every owned projection from ordered append-only events. */
    rebuild(): void;
    getGoal(goalId: string): GoalProjection | undefined;
    getQuotaRecovery(goalId: string): QuotaRecovery | undefined;
    /** All profile-local goals, newest first.  Task Area intentionally spans sessions. */
    listGoals(options?: {
        readonly archived?: boolean;
    }): GoalProjection[];
    listGoalVersions(goalId: string): GoalVersion[];
    /** Physical removal is reserved for expired archives; ordinary lifecycle stays append-only. */
    purgeArchivedBefore(cutoff: string): string[];
    /** File-backed artifacts belonging to archives eligible for physical removal. */
    listArchivedArtifactPathsBefore(cutoff: string): string[];
    /** Content-addressed files can be shared; delete one only after its final projection reference is gone. */
    isArtifactPathReferenced(path: string): boolean;
    listSessionLinks(goalId: string): TaskSessionLink[];
    /** One explicit display binding per conversation; historic task links remain separate. */
    getCurrentTaskForSession(sessionId: string): CurrentTaskBinding | undefined;
    listContextManifests(goalId: string): ContextManifestProjection[];
    listExecutionProfileResolutions(goalId: string): ExecutionProfileResolutionProjection[];
    getBudgetSummary(goalId: string): BudgetSummaryProjection | undefined;
    listExecutionEvaluations(goalId: string): ExecutionEvaluationProjection[];
    listExecutionPolicyDecisions(goalId: string): ExecutionPolicyDecisionProjection[];
    listMemoryIndexEntries(goalId: string): MemoryIndexEntryProjection[];
    listMemoryRecords(goalId: string): MemoryRecordProjection[];
    getPlan(goalId: string, revision?: number): {
        readonly revision: number;
        readonly state: string;
        readonly tasks: TaskNode[];
        readonly invalidatedTaskIds: readonly string[];
        readonly staleTaskIds: readonly string[];
        readonly baseRevision?: number;
        readonly trigger?: Record<string, unknown>;
    } | undefined;
    /** Current task projection only; historical revisions remain queryable through getPlan(). */
    listTasks(goalId: string): TaskNode[];
    getTask(goalId: string, taskId: string): TaskNode | undefined;
    listAttempts(taskId: string, goalId?: string): AttemptProjection[];
    listRunRounds(goalId: string): RunRoundProjection[];
    getRuntimeMetrics(goalId: string, now?: number): RuntimeMetrics;
    listRunningAttempts(): AttemptProjection[];
    getRunningAttemptBySession(sessionId: string): AttemptProjection | undefined;
    listActiveValidatedArtifacts(goalId: string, taskIds?: readonly string[]): ArtifactProjection[];
    listDecisions(goalId: string): DecisionProjection[];
    listEvidence(goalId: string): EvidenceProjection[];
    latestCheckpoint(goalId: string): CheckpointProjection | undefined;
    latestSeq(goalId: string): number;
    /** Cursor-based event page in append order; the event log remains the only authority. */
    listEvents(goalId: string, afterSeq?: number, limit?: number, taskId?: string): RuntimeEvent[];
    listRecentEvents(goalId: string, limit?: number): RuntimeEvent[];
    snapshot(goalId: string): Record<string, unknown>;
    close(): void;
}
