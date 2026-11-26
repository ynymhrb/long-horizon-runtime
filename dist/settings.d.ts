import { z } from 'zod';
import type { Config } from './tools.js';
declare const worker: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        dsh: "dsh";
        "codex-cli": "codex-cli";
        "claude-cli": "claude-cli";
        "custom-exec": "custom-exec";
    }>;
    maxConcurrent: z.ZodNumber;
}, z.core.$strict>;
declare const draftSchema: z.ZodObject<{
    maxConcurrentTasks: z.ZodNumber;
    workers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            dsh: "dsh";
            "codex-cli": "codex-cli";
            "claude-cli": "claude-cli";
            "custom-exec": "custom-exec";
        }>;
        maxConcurrent: z.ZodNumber;
    }, z.core.$strict>>;
    executionProfiles: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        workerIds: z.ZodArray<z.ZodString>;
        modelRole: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    defaultExecutionProfile: z.ZodString;
    modelEndpoints: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        provider: z.ZodString;
        model: z.ZodString;
        roles: z.ZodArray<z.ZodString>;
        maxConcurrent: z.ZodNumber;
    }, z.core.$strict>>;
    toolConcurrency: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        maxConcurrent: z.ZodNumber;
    }, z.core.$strict>>;
    workflowTemplates: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    defaultWorkflow: z.ZodString;
}, z.core.$strict>;
type Draft = z.infer<typeof draftSchema>;
export type SettingsOverride = Pick<Config, 'maxConcurrentTasks' | 'workers' | 'executionProfiles' | 'defaultExecutionProfile' | 'modelEndpoints' | 'toolConcurrency' | 'workflowTemplates' | 'defaultWorkflow'>;
export declare function selectSettingsOverlay(config: SettingsOverride): SettingsOverride;
export declare function settingsRevision(text: string): string;
/** Own one appended overlay while preserving the bytes and tags of other rows. */
export declare function renderSettingsPatch(text: string, config: Record<string, unknown>): string;
type WorkerView = z.infer<typeof worker> & {
    readonly cwd?: string;
};
export type SettingsView = Omit<Draft, 'workers'> & {
    readonly workers: readonly WorkerView[];
    readonly revision: string;
    readonly editable: boolean;
    readonly busy: boolean;
    readonly warning?: string;
};
export declare class LongTaskSettings {
    private readonly config;
    private readonly active;
    private readonly hold;
    private readonly validate;
    private readonly trustedConfig;
    private readonly warning?;
    constructor(config: Config, active: () => boolean, hold: () => () => void, validate: (override: SettingsOverride) => void, trustedConfig?: Config, warning?: string | undefined);
    read(): SettingsView;
    save(expectedRevision: string, requested: unknown): {
        readonly revision: string;
    };
    private readPatch;
    private workers;
    private profiles;
}
/** Merge preferences against live host registrations. No executable metadata is saved in the user block. */
export declare function applySettingsPreferences(host: Config, requested: unknown, fromEditor?: boolean): SettingsOverride;
export {};
