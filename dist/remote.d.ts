import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { LongTaskRuntime } from './runtime.js';
/** Browser-safe host query surface; payloads deliberately remain JSON values. */
export declare class LongTaskRemote extends TypertRemoteService {
    private readonly runtime;
    private readonly ui;
    constructor(ctx: Context, runtime: LongTaskRuntime);
    get(taskId: string): unknown;
    list(): unknown;
    listTasks(input: {
        cursor?: number;
        filter?: {
            state?: string;
            query?: string;
            archived?: boolean;
            sessionId?: string;
        };
    }): unknown;
    getTask(input: {
        taskId: string;
    }): unknown;
    getTaskGraph(input: {
        taskId: string;
        revision?: number;
    }): unknown;
    listTaskEvents(input: {
        taskId: string;
        cursor?: number;
        taskNodeId?: string;
    }): unknown;
    getCurrentTaskForSession(input: {
        sessionId: string;
    }): unknown;
    updateTask(input: {
        taskId: string;
        expectedRevision: number;
        action: 'confirm' | 'resume' | 'pause' | 'cancel';
        sessionId?: string;
        workspaceScope?: string;
        recoveryResolution?: 'retry' | 'confirmed_succeeded';
    }): Promise<unknown>;
    attachCurrentSession(input: {
        taskId: string;
        sessionId: string;
        workspaceScope?: string;
    }): Promise<unknown>;
    setCurrentSession(input: {
        taskId: string;
        sessionId: string;
        workspaceScope?: string;
    }): unknown;
    clearCurrentSession(input: {
        sessionId: string;
    }): unknown;
    rejectReplan(input: {
        taskId: string;
        expectedRevision: number;
    }): unknown;
    editTaskGoal(input: {
        taskId: string;
        expectedRevision: number;
        objective: string;
        reason: string;
        sessionId?: string;
    }): Promise<unknown>;
    acceptReplan(input: {
        taskId: string;
        expectedRevision: number;
        sessionId?: string;
    }): Promise<unknown>;
    archiveTask(input: {
        taskId: string;
        expectedRevision: number;
    }): Promise<unknown>;
    restoreTask(input: {
        taskId: string;
    }): unknown;
    getTaskNavigation(input: {
        taskId: string;
    }): unknown;
}
/** Separate host-plane loader row: Gateway can enumerate this active Service. */
export declare const name = "long-task-runtime-remote";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
