export interface ScenarioAction {
  name?: string
  do?: string
  observe?: string
  step?: number
  run?: { command: string; cwd?: string; shell?: string; timeout_ms?: number; must_succeed?: boolean; expect_exit_code?: number }
  uses?: { binding: string; [key: string]: unknown }
  side_effect_class?: string
  sideEffectClass?: string
  [key: string]: unknown
}

export interface HardAssertion {
  id: string
  check: string
  oracle?: string
  evaluate?: { oracle: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface Scenario {
  id: string
  title: string
  version?: number
  risk: 'critical' | 'high' | 'medium' | 'low'
  kind: 'deterministic' | 'fault_injection' | 'exploratory_ui'
  tags: string[]
  preconditions: unknown[]
  setup: unknown[]
  actions: ScenarioAction[]
  hard_assertions: HardAssertion[]
  evidence_required: string[]
  llm_review: 'never' | 'on_failure' | 'always'
  expected_user_outcome: string
  cleanup: string
  side_effect_class?: string
  sideEffectClass?: string
  fault_injection?: { boundary?: string; injected_fault?: string; planned_side_effect_class?: string; [key: string]: unknown }
  [key: string]: unknown
}

export declare const SCENARIO_RISKS: string[]
export declare const SCENARIO_KINDS: string[]
export declare const LLM_REVIEW_MODES: string[]
export declare const EVIDENCE_ITEMS: string[]
export declare const REQUIRED_SCENARIO_FIELDS: string[]

export declare class ScenarioContractError extends Error {
  constructor(problems: string[], source?: string)
  problems: string[]
  source?: string
}

export declare class ExternalEffectError extends Error {
  constructor(detail: string)
  detail: string
}

export declare function loadScenarioFile(filePath: string): Promise<Scenario>
export declare function validateScenario(raw: unknown, source?: string): Scenario
export declare function assertReadOnlyScenario(scenario: Scenario, source?: string): void
export declare function findScenarioFile(scenarioRoot: string, scenarioId: string): Promise<string>
