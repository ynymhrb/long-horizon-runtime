import type { TaskNode } from './domain.js';
import type { RuntimeEvent } from './event-store.js';
import type { GoalView, LongTaskRuntime } from './runtime.js';
import type { TaskControlApi, TaskUpdateResult } from './task-api.js';
export interface CursorPage<T> {
    readonly items: readonly T[];
    readonly nextCursor?: number;
}
export interface TaskListFilter {
    readonly state?: GoalView['state'];
    readonly query?: string;
    readonly archived?: boolean;
    readonly sessionId?: string;
}
export interface TaskProgress {
    readonly settled: number;
    readonly total: number;
}
export interface TaskSummary {
    readonly id: string;
    readonly objective: string;
    readonly state: GoalView['state'];
    readonly revision: number;
    readonly controlRevision: number;
    readonly workspaceScope?: string;
    readonly archivedAt?: string;
    readonly progress: TaskProgress;
    readonly currentOrLastNode?: {
        readonly id: string;
        readonly objective: string;
        readonly state: string;
    };
    readonly reason?: string;
    readonly latestEventCursor: number;
}
export interface TaskStripView extends TaskSummary {
    readonly availableActions: readonly string[];
}
export interface TaskGraphView {
    readonly taskId: string;
    readonly revision: number;
    readonly nodes: readonly TaskNode[];
    readonly edges: readonly {
        readonly from: string;
        readonly to: string;
    }[];
}
/** Browser read model. It derives compact JSON DTOs from durable runtime projections only. */
export declare class TaskUiApi {
    private readonly runtime;
    private readonly control;
    constructor(runtime: LongTaskRuntime, control: TaskControlApi);
    listTasks(input?: {
        readonly cursor?: number;
        readonly filter?: TaskListFilter;
    }): CursorPage<TaskSummary>;
    getTask(input: {
        readonly taskId: string;
    }): GoalView | null;
    getTaskGraph(input: {
        readonly taskId: string;
        readonly revision?: number;
    }): TaskGraphView | null;
    listTaskEvents(input: {
        readonly taskId: string;
        readonly cursor?: number;
        readonly taskNodeId?: string;
    }): CursorPage<RuntimeEvent>;
    getCurrentTaskForSession(input: {
        readonly sessionId: string;
    }): TaskStripView | null;
    updateTask(input: {
        readonly taskId: string;
        readonly expectedRevision: number;
        readonly action: 'confirm' | 'resume' | 'pause' | 'cancel';
        readonly sessionId?: string;
        readonly workspaceScope?: string;
        readonly recoveryResolution?: 'retry' | 'confirmed_succeeded';
        readonly parent?: unknown;
        readonly signal?: AbortSignal;
    }): Promise<TaskUpdateResult>;
    /** Explicit user action: create a durable cross-session link and make it current. */
    attachCurrentSession(input: {
        readonly taskId: string;
        readonly sessionId: string;
        readonly workspaceScope?: string;
    }): Promise<TaskUpdateResult>;
    /** Explicit user action for a session that is already linked to this task. */
    setCurrentSession(input: {
        readonly taskId: string;
        readonly sessionId: string;
        readonly workspaceScope?: string;
    }): TaskUpdateResult;
    /** Hide the strip for this conversation without erasing its task provenance. */
    clearCurrentSession(input: {
        readonly sessionId: string;
    }): null;
    rejectReplan(input: {
        readonly taskId: string;
        readonly expectedRevision: number;
    }): TaskUpdateResult;
    editTaskGoal(input: {
        readonly taskId: string;
        readonly expectedRevision: number;
        readonly objective: string;
        readonly reason: string;
        readonly sessionId?: string;
        readonly workspaceScope?: string;
        readonly parent?: unknown;
        readonly signal?: AbortSignal;
    }): Promise<TaskUpdateResult>;
    acceptReplan(input: {
        readonly taskId: string;
        readonly expectedRevision: number;
        readonly sessionId?: string;
        readonly workspaceScope?: string;
        readonly parent?: unknown;
        readonly signal?: AbortSignal;
    }): Promise<TaskUpdateResult>;
    archiveTask(input: {
        readonly taskId: string;
        readonly expectedRevision: number;
    }): Promise<TaskUpdateResult>;
    restoreTask(input: {
        readonly taskId: string;
    }): GoalView;
    getTaskNavigation(input: {
        readonly taskId: string;
    }): {
        readonly attachedSessionIds: readonly string[];
        readonly currentSessionId?: string;
    };
    private summary;
}
