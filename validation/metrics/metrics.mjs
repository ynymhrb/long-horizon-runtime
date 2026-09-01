/**
 * Run metrics aggregation (handbook "Failure handling and metrics").
 *
 * Folds a list of RunRecords (validation/metrics/runs.mjs) plus triage
 * reports and reviewer ledger entries into the handbook's required per-suite
 * metrics:
 *
 *   total_executions               every run in the evidence root
 *   hard_pass_rate                 pass / total (hard verdicts only; a run is
 *                                  either pass or not — inconclusive and
 *                                  hard_stop both count against the rate)
 *   failure_rate_by_risk           fail+hard_stop / total, per risk bucket
 *   failure_rate_by_tag            fail+hard_stop / total, per scenario tag
 *   timeout_rate                   runs with a timed-out command / total
 *   evidence_completeness_rate     runs with zero missing required evidence / total
 *   llm_candidate_count            triage reports with verdict candidate_bug
 *   candidate_confirmation_rate    confirmed_bug reviews / reviewed candidates
 *   median_reproduction_time_ms    median of review reproduction_time_ms values
 *   permanent_scenarios_added      distinct permanent_scenario_id in reviews
 *
 * All arithmetic is deterministic: empty inputs yield zero rates (never NaN),
 * medians of empty lists are null, and grouping keys are sorted.
 */

/**
 * @typedef {Object} TriageInput
 * @property {string} runId run the triage report belongs to
 * @property {string} verdict candidate_bug | likely_test_issue | insufficient_evidence
 */

/**
 * @typedef {Object} MetricRate
 * @property {number} numerator
 * @property {number} denominator
 * @property {number} rate 0 when denominator is 0 (never NaN)
 */

/**
 * @typedef {Object} RunMetrics
 * @property {number} total_executions
 * @property {MetricRate} hard_pass_rate
 * @property {Record<string, MetricRate>} failure_rate_by_risk
 * @property {Record<string, MetricRate>} failure_rate_by_tag
 * @property {MetricRate} timeout_rate
 * @property {MetricRate} evidence_completeness_rate
 * @property {number} llm_candidate_count
 * @property {MetricRate} candidate_confirmation_rate
 * @property {number | null} median_reproduction_time_ms
 * @property {{ count: number, scenario_ids: string[] }} permanent_scenarios_added
 */

/** Verdicts that count as a failure for failure-rate metrics. */
export const FAILURE_VERDICTS = new Set(['fail', 'hard_stop'])

/**
 * Compute a numerator/denominator rate pair. The rate is 0 when the
 * denominator is 0 so empty evidence roots produce deterministic metrics.
 * @param {number} numerator @param {number} denominator
 * @returns {MetricRate}
 */
export function rate(numerator, denominator) {
  return { numerator, denominator, rate: denominator === 0 ? 0 : numerator / denominator }
}

/**
 * Aggregate run records into the handbook's required metrics.
 * @param {import('./runs.mjs').RunRecord[]} runs
 * @param {{ triageReports?: TriageInput[], reviews?: import('./reviews.mjs').ReviewEntry[] }} [inputs]
 * @returns {RunMetrics}
 */
export function aggregateMetrics(runs, inputs = {}) {
  const triageReports = inputs.triageReports ?? []
  const reviews = inputs.reviews ?? []
  const total = runs.length

  const hardPasses = runs.filter(run => run.verdict === 'pass').length
  const timedOut = runs.filter(run => run.timedOut).length
  const evidenceComplete = runs.filter(run => run.evidenceComplete).length

  const candidateRunIds = new Set(triageReports.filter(report => report.verdict === 'candidate_bug').map(report => report.runId))
  const reviewedCandidates = reviews.filter(review => candidateRunIds.has(review.runId))
  const confirmedCandidates = reviewedCandidates.filter(review => review.outcome === 'confirmed_bug')

  const reproductionTimes = reviews
    .map(review => review.reproductionTimeMs)
    .filter(/** @returns {value is number} */ value => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)

  const permanentScenarioIds = [...new Set(
    reviews
      .map(review => review.permanentScenarioId)
      .filter(/** @returns {value is string} */ value => typeof value === 'string' && value !== ''),
  )].sort()

  return {
    total_executions: total,
    hard_pass_rate: rate(hardPasses, total),
    failure_rate_by_risk: groupedFailureRate(runs, run => run.risk),
    failure_rate_by_tag: groupedFailureRate(
      runs.flatMap(run => (run.tags.length === 0 ? ['untagged'] : run.tags).map(tag => ({ run, tag }))),
      pair => pair.tag,
      pair => pair.run,
    ),
    timeout_rate: rate(timedOut, total),
    evidence_completeness_rate: rate(evidenceComplete, total),
    llm_candidate_count: candidateRunIds.size,
    candidate_confirmation_rate: rate(confirmedCandidates.length, reviewedCandidates.length),
    median_reproduction_time_ms: median(reproductionTimes),
    permanent_scenarios_added: { count: permanentScenarioIds.length, scenario_ids: permanentScenarioIds },
  }
}

/**
 * Failure rate (fail + hard_stop) per grouping key. Keys are sorted in the
 * output so repeated aggregations over the same input are byte-identical.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} keyOf
 * @param {(item: T) => import('./runs.mjs').RunRecord} [runOf] defaults to identity
 * @returns {Record<string, MetricRate>}
 */
function groupedFailureRate(items, keyOf, runOf = item => /** @type {import('./runs.mjs').RunRecord} */ (item)) {
  /** @type {Map<string, { failures: number, total: number }>} */
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    const run = runOf(item)
    const group = groups.get(key) ?? { failures: 0, total: 0 }
    group.total += 1
    if (FAILURE_VERDICTS.has(run.verdict)) group.failures += 1
    groups.set(key, group)
  }
  /** @type {Record<string, MetricRate>} */
  const out = {}
  for (const key of [...groups.keys()].sort()) {
    const group = /** @type {{ failures: number, total: number }} */ (groups.get(key))
    out[key] = rate(group.failures, group.total)
  }
  return out
}

/**
 * Median of an ascending-sorted list of numbers; null for an empty list.
 * @param {number[]} sorted ascending
 * @returns {number | null}
 */
export function median(sorted) {
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? /** @type {number} */ (sorted[middle]) : (/** @type {number} */ (sorted[middle - 1]) + /** @type {number} */ (sorted[middle])) / 2
}

/**
 * Is this run a hard failure in the handbook's sense (assertion failure,
 * unbounded timeout, external-effect attempt, or incomplete evidence)? The
 * runner's verdict lattice already encodes assertion/timeout/error as `fail`
 * and external effect as `hard_stop`; incomplete evidence surfaces as
 * `inconclusive` with a non-empty missing-evidence list.
 * @param {import('./runs.mjs').RunRecord} run
 * @returns {boolean}
 */
export function isHardFailure(run) {
  if (FAILURE_VERDICTS.has(run.verdict)) return true
  if (run.verdict === 'inconclusive' && run.missingEvidence.length > 0) return true
  return false
}
