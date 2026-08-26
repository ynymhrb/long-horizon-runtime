import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { ExecutionAdapter, PlannerAdapter } from './adapters.js';
/** Bind a model-facing tool invocation's Agent to child starts made during its async work. */
export declare function withDshParent<T>(parent: Agent, work: () => Promise<T>): Promise<T>;
export interface DshAdapterOptions {
    readonly providerName: string;
    readonly agentOptions?: Record<string, unknown>;
    readonly timeoutMs?: number;
}
/** Build an initial-plan adapter backed by a configured DSH one-shot provider. */
export declare function createDshPlannerAdapter(subagents: Pick<SubagentRuntime, 'start'>, options: DshAdapterOptions): PlannerAdapter;
/** Build an isolated task-attempt adapter backed by a configured DSH one-shot provider. */
export declare function createDshExecutionAdapter(subagents: Pick<SubagentRuntime, 'start'>, options: DshAdapterOptions): ExecutionAdapter;
