import type { RunRecord } from './runs.mjs'
import type { ReviewEntry } from './reviews.mjs'

export declare const FAILURE_VERDICTS: Set<string>

export interface TriageInput {
  runId: string
  verdict: string
}

export interface MetricRate {
  numerator: number
  denominator: number
  rate: number
}

export interface RunMetrics {
  total_executions: number
  hard_pass_rate: MetricRate
  failure_rate_by_risk: Record<string, MetricRate>
  failure_rate_by_tag: Record<string, MetricRate>
  timeout_rate: MetricRate
  evidence_completeness_rate: MetricRate
  llm_candidate_count: number
  candidate_confirmation_rate: MetricRate
  median_reproduction_time_ms: number | null
  permanent_scenarios_added: { count: number; scenario_ids: string[] }
}

export declare function rate(numerator: number, denominator: number): MetricRate
export declare function aggregateMetrics(runs: RunRecord[], inputs?: { triageReports?: TriageInput[]; reviews?: ReviewEntry[] }): RunMetrics
export declare function median(sorted: number[]): number | null
export declare function isHardFailure(run: RunRecord): boolean
