import type { ExecutionAdapter } from './adapters.js';
export interface ProcessWorkerConfig {
    readonly kind: 'codex-cli' | 'claude-cli' | 'custom-exec';
    readonly executable: string;
    readonly args?: readonly string[];
    readonly cliArgs?: readonly string[];
    readonly cwd: string;
    readonly scratchDirectory?: string;
    readonly environmentKeys?: readonly string[];
}
type Input = Parameters<ExecutionAdapter['execute']>[0];
export interface ProcessWorkerRequest {
    readonly protocolVersion: 1;
    readonly taskId: string;
    readonly attemptId: string;
    readonly revision?: number;
    readonly workspace: string;
    readonly idempotencyKey?: string;
    readonly sideEffectClass?: Input['sideEffectClass'];
    readonly timeoutMs?: number;
    readonly context: Input['context'];
}
export declare function createProcessWorker(config: ProcessWorkerConfig): ExecutionAdapter;
export {};
