export declare const REVIEW_OUTCOMES: string[]
export declare const UI_FINDING_STATUSES: string[]

export type ReviewOutcome = 'confirmed_bug' | 'test_problem' | 'product_decision' | 'insufficient_evidence'

export interface UiFindingDisposition {
  id: string
  status: 'resolved' | 'accepted' | 'retained'
  owner: string | null
}

export interface ReviewEntry {
  runId: string
  scenarioId: string | null
  outcome: ReviewOutcome
  reviewedAt: string | null
  reproductionTimeMs: number | null
  permanentScenarioId: string | null
  uiFindings: UiFindingDisposition[]
}

export declare class ReviewLedgerError extends Error {
  constructor(problems: string[], source?: string)
  problems: string[]
  source?: string
}

export declare function loadReviewLedger(file: string): Promise<ReviewEntry[]>
export declare function validateReviewLedger(raw: unknown, source?: string): ReviewEntry[]
