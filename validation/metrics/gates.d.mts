import type { RunRecord } from './runs.mjs'
import type { ReviewEntry } from './reviews.mjs'

export declare const GATED_RISKS: Set<string>
export declare const DETERMINISTIC_KINDS: Set<string>

export interface GateResult {
  gate: string
  verdict: 'pass' | 'fail'
  reasons: string[]
}

export declare function evaluateReleaseGates(runs: RunRecord[], inputs?: { reviews?: ReviewEntry[] }): GateResult[]
export declare function gateCriticalHighDeterministicPass(runs: RunRecord[]): GateResult
export declare function gateNoUnreviewedHardFailures(runs: RunRecord[], reviews: ReviewEntry[]): GateResult
export declare function gateNoExternalEffectViolation(runs: RunRecord[]): GateResult
export declare function gateUiFindingsDispositioned(reviews: ReviewEntry[]): GateResult
export declare function summarizeGates(gates: GateResult[]): { verdict: 'pass' | 'fail'; gates: GateResult[] }
