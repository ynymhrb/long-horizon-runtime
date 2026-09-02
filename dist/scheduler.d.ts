import { type ExecutionAdapter } from './adapters.js';
import { type TaskNode } from './domain.js';
import { RuntimeEventStore } from './event-store.js';
import { ArtifactStore } from './artifacts.js';
export type RecoveryResult = 'succeeded' | 'retry' | 'indeterminate';
export interface SchedulerOptions {
    readonly store: RuntimeEventStore;
    readonly maxConcurrentTasks: number;
    readonly defaultRetryPolicy?: {
        readonly maxAttempts: number;
    };
    /** Base delay before the first retry; each further attempt doubles it (capped by maxRetryBackoffMs). */
    readonly retryBackoffMs?: number;
    /** Upper bound for the exponential retry delay. */
    readonly maxRetryBackoffMs?: number;
    readonly idleTimeoutMs?: number;
    readonly maxWallTimeMs?: number;
    /** Injectable clock for deterministic backoff tests. */
    readonly now?: () => number;
    readonly recoveryValidator?: (input: {
        readonly goalId: string;
        readonly task: TaskNode;
        readonly attemptId: string;
    }) => Promise<RecoveryResult>;
    /** Opaque live parent used only by a DSH adapter; never persisted. */
    readonly executionParent?: unknown;
    readonly validator?: (input: {
        readonly goalId: string;
        readonly task: TaskNode;
        readonly attemptId: string;
        readonly result: import('./adapters.js').ExecutionResult;
    }) => Promise<{
        readonly ok: boolean;
        readonly reason?: string;
    }>;
    /** Named planner validators; unknown names reject the result rather than silently succeeding. */
    readonly validators?: Readonly<Record<string, NonNullable<SchedulerOptions['validator']>>>;
    readonly artifactStore?: ArtifactStore;
    readonly onTerminalFailure?: (input: {
        readonly goalId: string;
        readonly task: TaskNode;
        readonly reason: string;
    }) => Promise<void>;
}
/** Deterministic super-step scheduler. With a store, all state transitions are durable. */
export declare class Scheduler {
    private readonly adapter;
    private readonly store;
    private readonly maxConcurrentTasks;
    private readonly defaultAttempts;
    private readonly retryBackoffMs;
    private readonly maxRetryBackoffMs;
    private readonly idleTimeoutMs;
    private readonly maxWallTimeMs;
    private readonly now;
    private readonly recoveryValidator?;
    private readonly validator?;
    private readonly validators;
    private readonly artifactStore;
    private readonly onTerminalFailure?;
    private readonly aborters;
    /** Resolves an in-process dispatch when its durable lease is terminalized. */
    private readonly livenessSettlers;
    /** Durable retry due timestamps keyed by `${goalId}\u0000${taskId}`; respected by ready selection. */
    private readonly retryAfter;
    constructor(adapter: ExecutionAdapter, options: number | SchedulerOptions);
    /** Dispatch one bounded ready set. Legacy map mode is retained for a narrow unit-test boundary. */
    runRound(goalId: string, legacyTasks?: Map<string, TaskNode>, executionParent?: unknown, executionSignal?: AbortSignal): Promise<boolean>;
    /** Reconcile durable leases even when a provider promise or host process is lost. */
    reconcileLiveness(goalId?: string): void;
    /** Accept a bounded heartbeat only from the child session that owns the running attempt. */
    reportProgress(sessionId: string, attemptId: string, phase: string, message: string, completed?: number, total?: number): void;
    /** Recover nonterminal attempts. No agent is persisted or used unless a caller provides one later. */
    recover(): Promise<readonly string[]>;
    cancel(goalId: string): void;
    /** Stop in-flight child work without choosing a durable lifecycle transition. */
    interrupt(goalId: string): void;
    /** Stop active child work and durably return its logical nodes to PENDING. */
    pause(goalId: string): void;
    /** Milliseconds until the earliest pending retry for this goal, or undefined when none is waiting. */
    nextRetryDelayMs(goalId: string): number | undefined;
    private key;
    private inBackoff;
    private backoffMs;
    private clearRetryAfter;
    private dependenciesSatisfied;
    private context;
    private executeOne;
    private terminalFailure;
    private runLegacyRound;
    private setState;
}
