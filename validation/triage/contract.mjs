/**
 * The handbook's exact LLM triage JSON contract ("LLM triage contract"
 * section) plus a strict structural validator.
 *
 * The contract shape (required keys at every level, enum-constrained fields):
 *
 *   verdict            "candidate_bug" | "likely_test_issue" | "insufficient_evidence"
 *   earliest_anomaly   { evidence_id, timestamp, observation } | null
 *   hypotheses         0..3 of { title, confidence: "low"|"medium"|"high",
 *                                evidence: string[], minimal_reproduction: string[],
 *                                automatable_oracle: string }
 *   usability_findings any number of { user_goal, friction,
 *                                      observable_evidence, suggested_validation }
 *   stop_reason        string | null
 *
 * `validateTriageReport` collects every violation instead of failing on the
 * first, mirroring the scenario contract validator's reporting style.
 */

/** Verdicts the triage contract permits. */
export const TRIAGE_VERDICTS = ['candidate_bug', 'likely_test_issue', 'insufficient_evidence']

/** Confidence levels a hypothesis may carry. */
export const TRIAGE_CONFIDENCES = ['low', 'medium', 'high']

/** The handbook's hard cap on hypotheses per triage report. */
export const MAX_HYPOTHESES = 3

/**
 * The exact contract skeleton: every required key, in the handbook's order,
 * with contract-valid default values. Used as the deterministic fallback base
 * and as the canonical shape documentation.
 * @returns {{ verdict: string, earliest_anomaly: null, hypotheses: never[], usability_findings: never[], stop_reason: null }}
 */
export function triageContractSkeleton() {
  return {
    verdict: 'insufficient_evidence',
    earliest_anomaly: null,
    hypotheses: [],
    usability_findings: [],
    stop_reason: null,
  }
}

export class TriageContractError extends Error {
  /**
   * @param {string[]} problems
   * @param {string} [source] description used in the error message
   */
  constructor(problems, source) {
    super(`triage contract violation${source === undefined ? '' : ` in ${source}`}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.name = 'TriageContractError'
    this.problems = problems
    this.source = source
  }
}

/**
 * Validate a parsed triage report against the handbook's exact JSON contract.
 * Returns the list of violations; an empty list means the report is valid.
 * @param {unknown} report
 * @returns {string[]} violation descriptions (empty when contract-valid)
 */
export function triageContractProblems(report) {
  /** @type {string[]} */
  const problems = []
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return ['report must be a JSON object at the top level']
  }
  const doc = /** @type {Record<string, unknown>} */ (report)

  for (const key of ['verdict', 'earliest_anomaly', 'hypotheses', 'usability_findings', 'stop_reason']) {
    if (!(key in doc)) problems.push(`missing required key: ${key}`)
  }

  if ('verdict' in doc && !TRIAGE_VERDICTS.includes(/** @type {string} */ (doc.verdict))) {
    problems.push(`verdict must be one of ${TRIAGE_VERDICTS.join(' | ')}, got ${JSON.stringify(doc.verdict)}`)
  }

  if ('earliest_anomaly' in doc) validateAnomaly(doc.earliest_anomaly, problems)
  if ('hypotheses' in doc) validateHypotheses(doc.hypotheses, problems)
  if ('usability_findings' in doc) validateUsabilityFindings(doc.usability_findings, problems)

  if ('stop_reason' in doc && doc.stop_reason !== null && typeof doc.stop_reason !== 'string') {
    problems.push(`stop_reason must be null or a string, got ${JSON.stringify(doc.stop_reason)}`)
  }

  return problems
}

/**
 * Validate and return the report when contract-valid; throw a
 * TriageContractError listing every violation otherwise.
 * @param {unknown} report
 * @param {string} [source]
 * @returns {import('./contract.js').TriageReport}
 */
export function validateTriageReport(report, source) {
  const problems = triageContractProblems(report)
  if (problems.length > 0) throw new TriageContractError(problems, source)
  return /** @type {import('./contract.js').TriageReport} */ (report)
}

/** @param {unknown} anomaly @param {string[]} problems */
function validateAnomaly(anomaly, problems) {
  if (anomaly === null || anomaly === undefined) return
  if (typeof anomaly !== 'object' || Array.isArray(anomaly)) {
    problems.push('earliest_anomaly must be null or an object with evidence_id, timestamp and observation')
    return
  }
  const record = /** @type {Record<string, unknown>} */ (anomaly)
  for (const key of ['evidence_id', 'timestamp', 'observation']) {
    if (!(key in record)) problems.push(`earliest_anomaly missing required key: ${key}`)
  }
  for (const key of ['evidence_id', 'timestamp', 'observation']) {
    if (key in record && typeof record[key] !== 'string') problems.push(`earliest_anomaly.${key} must be a string, got ${JSON.stringify(record[key])}`)
  }
}

/** @param {unknown} hypotheses @param {string[]} problems */
function validateHypotheses(hypotheses, problems) {
  if (!Array.isArray(hypotheses)) {
    problems.push('hypotheses must be a list')
    return
  }
  if (hypotheses.length > MAX_HYPOTHESES) {
    problems.push(`hypotheses must contain at most ${MAX_HYPOTHESES} entries, got ${hypotheses.length}`)
  }
  hypotheses.forEach((hypothesis, index) => {
    const label = `hypotheses[${index}]`
    if (hypothesis === null || typeof hypothesis !== 'object' || Array.isArray(hypothesis)) {
      problems.push(`${label} must be an object`)
      return
    }
    const record = /** @type {Record<string, unknown>} */ (hypothesis)
    for (const key of ['title', 'confidence', 'evidence', 'minimal_reproduction', 'automatable_oracle']) {
      if (!(key in record)) problems.push(`${label} missing required key: ${key}`)
    }
    if ('title' in record && typeof record.title !== 'string') problems.push(`${label}.title must be a string`)
    if ('confidence' in record && !TRIAGE_CONFIDENCES.includes(/** @type {string} */ (record.confidence))) {
      problems.push(`${label}.confidence must be one of ${TRIAGE_CONFIDENCES.join(' | ')}, got ${JSON.stringify(record.confidence)}`)
    }
    if ('evidence' in record && (!Array.isArray(record.evidence) || record.evidence.some(item => typeof item !== 'string'))) {
      problems.push(`${label}.evidence must be a list of evidence id strings`)
    }
    if ('minimal_reproduction' in record && (!Array.isArray(record.minimal_reproduction) || record.minimal_reproduction.some(item => typeof item !== 'string'))) {
      problems.push(`${label}.minimal_reproduction must be a list of step strings`)
    }
    if ('automatable_oracle' in record && typeof record.automatable_oracle !== 'string') problems.push(`${label}.automatable_oracle must be a string`)
  })
}

/** @param {unknown} findings @param {string[]} problems */
function validateUsabilityFindings(findings, problems) {
  if (!Array.isArray(findings)) {
    problems.push('usability_findings must be a list')
    return
  }
  findings.forEach((finding, index) => {
    const label = `usability_findings[${index}]`
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      problems.push(`${label} must be an object`)
      return
    }
    const record = /** @type {Record<string, unknown>} */ (finding)
    for (const key of ['user_goal', 'friction', 'observable_evidence', 'suggested_validation']) {
      if (!(key in record)) problems.push(`${label} missing required key: ${key}`)
      else if (typeof record[key] !== 'string') problems.push(`${label}.${key} must be a string`)
    }
  })
}
