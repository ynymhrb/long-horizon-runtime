import type { Context } from '@deepseek-ai/cordis';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
export type ModelRole = string;
export interface ModelEndpoint {
    readonly id: string;
    readonly provider: string;
    readonly model: string;
    readonly roles: readonly ModelRole[];
    readonly maxConcurrent: number;
}
export interface ToolConcurrency {
    readonly name: string;
    readonly maxConcurrent: number;
}
export declare class CallRouter {
    private readonly children;
    private readonly nestedTool;
    private readonly admission;
    private readonly models;
    private readonly tools;
    constructor(endpoints: readonly ModelEndpoint[], tools?: readonly ToolConcurrency[]);
    run<T>(role: ModelRole, parent: string, work: () => Promise<T>): Promise<T>;
    route(sessionId: string, signal: AbortSignal, config: LlmCallConfig): Promise<LlmCallConfig>;
    stream<T>(sessionId: string, provider: string, model: string, next: () => AsyncIterable<T>): AsyncIterable<T>;
    tool<T>(sessionId: string, name: string, signal: AbortSignal, next: () => Promise<T>): Promise<T>;
    install(ctx: Context): void;
}
