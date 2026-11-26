import type { AcceptanceCheck } from './acceptance-contract.js';
export interface CommandTemplate {
    readonly executable: string;
    readonly argsPrefix: readonly string[];
    readonly maxTimeoutMs: number;
}
export interface AcceptanceEngineOptions {
    readonly commandTemplates: Readonly<Record<string, CommandTemplate>>;
}
export interface AcceptanceCheckOutcome {
    readonly id: string;
    readonly kind: AcceptanceCheck['kind'];
    readonly ok: boolean;
    readonly summary: string;
    readonly exitCode?: number;
}
export interface AcceptanceBundle {
    readonly id: string;
    readonly attemptId: string;
    readonly verdict: 'passed' | 'failed';
    readonly checks: readonly AcceptanceCheckOutcome[];
    readonly startedAt: string;
    readonly finishedAt: string;
}
export declare class AcceptanceEngine {
    private readonly options;
    constructor(options: AcceptanceEngineOptions);
    evaluate(input: {
        readonly attemptId: string;
        readonly workspace: string;
        readonly checks: readonly AcceptanceCheck[];
    }): Promise<AcceptanceBundle>;
    private check;
}
