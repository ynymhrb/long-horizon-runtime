import type { TaskNode } from './domain.js';
export interface AutomaticReplanClassification {
    readonly outcome: 'auto_apply' | 'await_confirmation';
    readonly reasons: readonly string[];
}
export declare function classifyAutomaticReplan(input: {
    readonly previous: readonly TaskNode[];
    readonly candidate: readonly TaskNode[];
    readonly failedTaskId: string;
    readonly activeArtifacts: readonly {
        readonly taskId: string;
    }[];
}): AutomaticReplanClassification;
