import type { GoalState, TaskNode } from './domain.js';
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
