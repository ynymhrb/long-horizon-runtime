import type { GraphMutation, PlanDraft, ValidatedPlan } from './domain.js';
/** Validate planner output and return a normalized immutable plan revision. */
export declare function validatePlan(draft: PlanDraft): ValidatedPlan;
/** Apply one V1 mutation by deriving and validating a complete new revision. */
export declare function applyMutation(current: ValidatedPlan, mutation: GraphMutation): ValidatedPlan;
