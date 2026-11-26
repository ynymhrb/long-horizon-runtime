export type DecisionMethod = 'local_progress' | 'goal_value' | 'causal_advantage' | 'full'
export function createScorer(method: DecisionMethod, options?: object): { score(input: object): Promise<object[]> }
export function publicDecisionView(input: { actions: object[] } & Record<string, unknown>): object
export function chooseConservatively(estimates: object[], options: { negativeAction: string }): { actionId: string; reason: string }
