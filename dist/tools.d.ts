import type { Context } from '@deepseek-ai/cordis';
import { createDshExecutionAdapter, createDshPlannerAdapter } from './dsh-adapters.js';
import { LongTaskRuntime } from './runtime.js';
import { type RoutingMode } from './routing-policy.js';
/** Deployment configuration supplied from cordis.yml. Every operational knob is validated at activation. */
export interface Config {
    readonly databasePath: string;
    readonly artifactDirectory: string;
    readonly plannerProvider: string;
    readonly executionProvider: string;
    readonly maxConcurrentTasks?: number;
    readonly defaultPlanningMode?: 'auto' | 'require_confirmation';
    readonly executionTimeoutMs?: number;
    readonly retryPolicy?: {
        readonly maxAttempts: number;
    };
    readonly artifactInlineLimitBytes?: number;
    readonly autoReplan?: boolean;
    readonly routingMode?: RoutingMode;
    /** Profile-local compatibility scope for tasks resumed from another chat. */
    readonly workspaceScope?: string;
    readonly defaultAgentProfile?: Record<string, unknown>;
    /** Test/composition seam; normal deployments use the configured DSH adapters. */
    readonly runtimeFactory?: (planner: ReturnType<typeof createDshPlannerAdapter>, execution: ReturnType<typeof createDshExecutionAdapter>, config: ResolvedConfig) => LongTaskRuntime;
}
interface ResolvedConfig extends Omit<Config, 'maxConcurrentTasks' | 'defaultPlanningMode' | 'executionTimeoutMs' | 'retryPolicy' | 'artifactInlineLimitBytes'> {
    readonly maxConcurrentTasks: number;
    readonly defaultPlanningMode: 'auto' | 'require_confirmation';
    readonly executionTimeoutMs: number;
    readonly retryPolicy: {
        readonly maxAttempts: number;
    };
    readonly artifactInlineLimitBytes: number;
    readonly routingMode: RoutingMode;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        longTaskRuntime: LongTaskRuntime;
    }
}
export declare const name = "long-task-runtime";
export declare const inject: string[];
/** Mount the runtime service and six stateless model-facing controls. */
export declare function apply(ctx: Context, input: Config): void;
export {};
