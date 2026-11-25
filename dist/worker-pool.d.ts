import type { SideEffectClass } from './domain.js';
import type { ExecutionAdapter, ExecutionResult } from './adapters.js';
export interface WorkerBackend {
    readonly id: string;
    readonly maxConcurrent: number;
    readonly workspaceKey?: string;
    readonly adapter: ExecutionAdapter;
}
export interface WorkerLease {
    readonly workerId: string;
    execute(input: Parameters<ExecutionAdapter['execute']>[0]): Promise<ExecutionResult>;
    release(): void;
}
/** Single-process admission control, independent of the backend's transport. */
export declare class WorkerPool {
    private readonly maxConcurrent;
    private readonly slots;
    private readonly waiting;
    private readonly workspaces;
    private readonly running;
    private active;
    constructor(maxConcurrent: number, backends: readonly WorkerBackend[]);
    admit(ids: readonly string[], signal: AbortSignal, sideEffectClass?: SideEffectClass): Promise<WorkerLease>;
    cancel(attemptId: string): void;
    isAttemptAlive(attemptId: string): boolean;
    private dispatch;
    private workspaceAvailable;
    private lease;
}
