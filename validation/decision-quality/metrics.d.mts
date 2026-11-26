export interface ActionOutcome { actionId: string; utility: number }
export interface ActionEstimate { actionId: string; estimate: number }
export function deriveCausalAdvantages(outcomes: ActionOutcome[]): { actionId: string; advantage: number }[]
export function scoreDecisionPoint(estimates: ActionEstimate[], outcomes: ActionOutcome[]): Record<string, unknown>
export function aggregateDecisionQuality(records: Record<string, unknown>[]): Record<string, unknown>
