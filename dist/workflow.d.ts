import { z } from 'zod';
import type { TaskDraft } from './domain.js';
import type { ExecutionResult } from './adapters.js';
declare const specSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    mode: z.ZodLiteral<"workflow">;
    entry: z.ZodString;
    stages: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        objective: z.ZodString;
        profile: z.ZodString;
        next: z.ZodOptional<z.ZodString>;
        onChangesRequested: z.ZodOptional<z.ZodString>;
        maxVisits: z.ZodOptional<z.ZodNumber>;
        sideEffectClass: z.ZodOptional<z.ZodEnum<{
            read_only: "read_only";
            idempotent: "idempotent";
            external_effect: "external_effect";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    mode: z.ZodLiteral<"discussion">;
    participants: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        id: z.ZodString;
        profile: z.ZodString;
        instruction: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>>;
    rounds: z.ZodNumber;
    moderator: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        id: z.ZodString;
        profile: z.ZodString;
        instruction: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>]>;
    convergence: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "mode">;
declare const verdictSchema: z.ZodObject<{
    verdict: z.ZodEnum<{
        approved: "approved";
        changes_requested: "changes_requested";
    }>;
    reason: z.ZodString;
}, z.core.$strict>;
export type WorkflowSpec = z.infer<typeof specSchema>;
export type WorkflowVerdict = z.infer<typeof verdictSchema>;
export interface WorkflowTask extends TaskDraft {
    readonly workflowReview?: true;
}
export declare function parseWorkflow(value: unknown, profileIds?: readonly string[]): WorkflowSpec;
export declare function readWorkflowVerdict(artifacts: readonly Pick<ExecutionResult['artifacts'][number], 'type' | 'content'>[]): WorkflowVerdict | undefined;
export declare class WorkflowVisitLimit extends Error {
}
export declare function workflowStep(spec: WorkflowSpec, objective: string, history: readonly string[], verdict?: WorkflowVerdict): WorkflowTask | undefined;
export {};
