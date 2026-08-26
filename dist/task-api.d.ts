import type { GoalView, CreateGoalRequest, LongTaskRuntime, RecoveryResolution } from './runtime.js';
import type { InterruptionCause, RecoveryPolicyOutcome } from './domain.js';
import type { GraphMutation } from './domain.js';
export interface TaskInvocation {
    readonly sessionId?: string;
    readonly workspaceScope?: string;
    readonly parent?: unknown;
    readonly signal?: AbortSignal;
}
export interface CreateTaskRequest extends CreateGoalRequest {
    readonly workspaceScope?: string;
}
export type TaskUpdateAction = 'confirm' | 'resume' | 'pause' | 'cancel';
export type TaskUpdateResult = {
    readonly kind: 'applied';
    readonly task: GoalView;
} | {
    readonly kind: 'conflict';
    readonly current: GoalView;
};
/** Compact event projection for model-facing reads; raw context/content never leaves the store. */
export interface EventSummary {
    readonly seq?: number;
    readonly type: string;
    readonly goalId: string;
    readonly taskId?: string;
    readonly createdAt?: string;
    readonly payload: Record<string, unknown>;
}
export interface AttemptSessionSummary {
    readonly id: string;
    readonly taskId: string;
    readonly state: string;
    readonly revision: number;
    readonly dshSessionId?: string;
    readonly summary?: string;
}
/** Stable, session-neutral control surface. DSH tools and the future task UI both use this API. */
export declare class TaskControlApi {
    private readonly runtime;
    constructor(runtime: LongTaskRuntime);
    create(request: CreateTaskRequest, invocation: TaskInvocation): Promise<GoalView>;
    attachSession(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId'>> & Pick<TaskInvocation, 'workspaceScope'>): Promise<TaskUpdateResult>;
    /** Explicitly choose which linked task occupies this conversation's one task-strip slot. */
    setCurrentSessionTask(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId'>> & Pick<TaskInvocation, 'workspaceScope'>): Extract<TaskUpdateResult, {
        kind: 'applied';
    }>;
    /** Remove only the conversation display binding; its durable task links remain available for later selection. */
    clearCurrentSessionTask(sessionId: string): void;
    update(request: {
        readonly taskId: string;
        readonly expectedRevision: number;
        readonly action: TaskUpdateAction;
        readonly recoveryResolution?: RecoveryResolution;
    }, invocation: TaskInvocation): Promise<TaskUpdateResult>;
    editGoal(request: {
        readonly taskId: string;
        readonly expectedRevision: number;
        readonly objective: string;
        readonly reason: string;
    }, invocation: TaskInvocation): Promise<TaskUpdateResult>;
    acceptReplan(request: {
        readonly taskId: string;
        readonly expectedRevision: number;
    }, invocation: TaskInvocation): Promise<TaskUpdateResult>;
    get(taskId: string, invocation?: Pick<TaskInvocation, 'workspaceScope'>): GoalView | undefined;
    /**
     * Model-friendly incremental event page. Events are projected to a compact
     * summary: raw context manifests and inline artifact content are excluded so
     * polling a long goal does not flood the model context.
     */
    listEvents(request: {
        readonly taskId: string;
        readonly cursor?: number;
        readonly limit?: number;
        readonly taskNodeId?: string;
    }, invocation: Pick<TaskInvocation, 'workspaceScope'>): {
        readonly items: readonly EventSummary[];
        readonly nextCursor?: number;
    } | null;
    /** Resolve durable child session IDs of attempts so the caller can jump to or cite subagent logs. */
    listAttemptSessions(request: {
        readonly taskId: string;
        readonly taskNodeId?: string;
    }, invocation: Pick<TaskInvocation, 'workspaceScope'>): {
        readonly attempts: readonly AttemptSessionSummary[];
    } | null;
    interrupt(taskId: string, cause: InterruptionCause, recoveryOutcome: RecoveryPolicyOutcome): GoalView;
    proposeReplan(taskId: string, mutation: GraphMutation): GoalView;
    rejectReplan(taskId: string): GoalView;
    /** Reject only the proposal observed at this control revision; never discard a newer plan. */
    rejectReplanAtRevision(taskId: string, expectedRevision: number): TaskUpdateResult;
    private pause;
    /**
     * Idempotently ensure a session is durably linked to the task and is its
     * current binding. Continuing a task from a conversation must make that
     * conversation the task's jump target (origin provenance is preserved).
     */
    continueInSession(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId'>> & Pick<TaskInvocation, 'workspaceScope'>): GoalView;
    /** Only actions that continue a task in a conversation (confirm/resume) bind that session; pause/cancel stay explicit-attach-only. */
    private bindOnContinue;
    private advance;
    private requireTask;
    private assertScope;
}
