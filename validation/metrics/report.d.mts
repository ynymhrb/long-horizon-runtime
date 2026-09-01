import type { RunMetrics, TriageInput } from './metrics.mjs'
import type { GateResult } from './gates.mjs'

export interface SuiteReport {
  generated_from: string
  metrics: RunMetrics
  release_gates: { verdict: 'pass' | 'fail'; gates: GateResult[] }
  runs: { scenario_id: string; run_id: string; verdict: string; risk: string; kind: string }[]
}

export declare function buildSuiteReport(
  evidenceRoot: string,
  options?: {
    scenarioRoot?: string
    reviewLedgerFile?: string
    triageReports?: TriageInput[]
    skipTriage?: boolean
  },
): Promise<SuiteReport>
