/** Verdicts the handbook's LLM triage contract permits. */
export type TriageVerdict = 'candidate_bug' | 'likely_test_issue' | 'insufficient_evidence'

/** Confidence levels a hypothesis may carry. */
export type TriageConfidence = 'low' | 'medium' | 'high'

/** The earliest observable discrepancy, citing an evidence identifier. */
export interface TriageAnomaly {
  evidence_id: string
  timestamp: string
  observation: string
}

/** A falsifiable bug hypothesis backed by cited evidence. */
export interface TriageHypothesis {
  title: string
  confidence: TriageConfidence
  evidence: string[]
  minimal_reproduction: string[]
  automatable_oracle: string
}

/** An evidence-backed usability friction finding (UI scenarios). */
export interface TriageUsabilityFinding {
  user_goal: string
  friction: string
  observable_evidence: string
  suggested_validation: string
}

/**
 * The handbook's exact LLM triage JSON contract: every key required at the
 * top level, verdict/confidence enum-constrained, at most three hypotheses.
 */
export interface TriageReport {
  verdict: TriageVerdict
  earliest_anomaly: TriageAnomaly | null
  hypotheses: TriageHypothesis[]
  usability_findings: TriageUsabilityFinding[]
  stop_reason: string | null
}

export declare const TRIAGE_VERDICTS: string[]
export declare const TRIAGE_CONFIDENCES: string[]
export declare const MAX_HYPOTHESES: number

export declare class TriageContractError extends Error {
  constructor(problems: string[], source?: string)
  problems: string[]
  source?: string
}

export declare function triageContractSkeleton(): TriageReport
export declare function triageContractProblems(report: unknown): string[]
export declare function validateTriageReport(report: unknown, source?: string): TriageReport
