import type { EvidenceBundle } from './bundle.mjs'
import type { TriageReport } from './contract.mjs'

export interface TriageOptions {
  /**
   * Optional LLM analyzer; receives the loaded bundle and returns a candidate
   * report. Never used in deterministic runs (no analyzer is wired there).
   */
  analyze?: (bundle: EvidenceBundle) => Promise<unknown> | unknown
  /** description used in contract error messages */
  source?: string
}

export declare function triageBundle(evidenceDir: string, options?: TriageOptions): Promise<TriageReport>
export declare function triageEvidence(bundle: EvidenceBundle, options?: TriageOptions): Promise<TriageReport>
export declare function deterministicFallbackReport(bundle: EvidenceBundle): TriageReport
export declare const MAX_HYPOTHESES: number
