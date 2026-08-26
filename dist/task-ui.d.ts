import type { GoalView } from './runtime.js';
/** JSON-safe projection deliberately shared by a web Task Area and a chat task strip. */
export interface TaskAreaItem {
    readonly id: string;
    readonly objective: string;
    readonly state: GoalView['state'];
    readonly controlRevision: number;
    readonly taskCount: number;
    readonly completedCount: number;
    readonly hasPendingProposal: boolean;
}
export declare function toTaskAreaItem(task: GoalView): TaskAreaItem;
/** The conversation dock intentionally stays absent until a chat explicitly attaches a task. */
export declare function currentTaskStrip(task: GoalView | undefined): TaskAreaItem | undefined;
