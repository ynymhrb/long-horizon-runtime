export interface DecisionAction {
  readonly id: string
  readonly kind: string
  readonly command: readonly string[]
  readonly cost: number
  readonly irreversibility_risk: number
  readonly constraint_risk: number
  readonly potential_outcome?: number
}
export interface DecisionScenario {
  readonly id: string
  readonly version: number
  readonly goal: string
  readonly constraints: readonly string[]
  readonly initial_state: { readonly hash: string; readonly fixture?: string }
  readonly continuation_policy: { readonly id: string; readonly version: number }
  readonly oracle: { readonly id: string; readonly command: readonly string[] }
  readonly decision_points: readonly { readonly id: string; readonly actions: readonly DecisionAction[] }[]
}
export class DecisionScenarioError extends Error { readonly problems: readonly string[] }
export function validateDecisionScenario(raw: unknown, source?: string): DecisionScenario
