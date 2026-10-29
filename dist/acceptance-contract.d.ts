import type { TaskDraft } from './domain.js';
export type AcceptancePolicy = 'required' | 'structural_only' | 'human_review';
export type AcceptanceCheck = {
    readonly id: string;
    readonly kind: 'command';
    readonly templateId: string;
    readonly args: readonly string[];
    readonly expectedExitCode: number;
} | {
    readonly id: string;
    readonly kind: 'file';
    readonly path: string;
    readonly sha256?: string;
} | {
    readonly id: string;
    readonly kind: 'json_schema';
    readonly source: {
        readonly kind: 'artifact' | 'file';
        readonly ref: string;
    };
    readonly schemaId: string;
} | {
    readonly id: string;
    readonly kind: 'http';
    readonly endpointId: string;
    readonly requestId: string;
    readonly expectedStatus: number;
} | {
    readonly id: string;
    readonly kind: 'database';
    readonly queryId: string;
    readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
} | {
    readonly id: string;
    readonly kind: 'external_effect';
    readonly readbackId: string;
    readonly idempotencyKeyRef: string;
} | {
    readonly id: string;
    readonly kind: 'review';
    readonly rubricId: string;
    readonly artifactIds: readonly string[];
};
export interface AcceptanceCapabilities {
    readonly commandTemplates: ReadonlySet<string>;
    readonly fileSchemas: ReadonlySet<string>;
    readonly httpEndpoints: ReadonlySet<string>;
    readonly databaseQueries: ReadonlySet<string>;
    readonly externalReadbacks: ReadonlySet<string>;
    readonly reviewRubrics: ReadonlySet<string>;
}
export declare function parseAcceptanceChecks(value: unknown): readonly AcceptanceCheck[];
export declare function validateTaskAcceptance(task: Pick<TaskDraft, 'acceptancePolicy' | 'acceptanceChecks' | 'sideEffectClass'>, capabilities: AcceptanceCapabilities): void;
