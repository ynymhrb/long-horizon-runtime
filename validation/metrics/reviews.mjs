/**
 * Reviewer outcome ledger (handbook "Reviewer" / "Review loop").
 *
 * The deterministic runner and triager produce evidence and candidates; the
 * human/scripted reviewer records outcomes in a small JSON ledger so metrics
 * can compute candidate confirmation rate, median reproduction time,
 * permanent scenarios added, unreviewed hard failures and UI finding
 * disposition. The ledger is optional: with no ledger, those metrics report
 * deterministic zero/empty values and the "no unreviewed hard failures" gate
 * reports every hard failure as unreviewed.
 *
 * Ledger shape (all entries optional except run_id + outcome):
 *
 *   {
 *     "reviews": [
 *       {
 *         "run_id": "<uuid>",                // matches run.json run_id
 *         "scenario_id": "LT-FAULT-001",      // informational
 *         "outcome": "confirmed_bug",         // see REVIEW_OUTCOMES
 *         "reviewed_at": "2026-08-27T00:00:00.000Z",
 *         "reproduction_time_ms": 420000,     // time to reproduce the candidate
 *         "permanent_scenario_id": "LT-FAULT-011",  // regression scenario added
 *         "ui_findings": [                     // UI review dispositions
 *           { "id": "F-1", "status": "resolved" },
 *           { "id": "F-2", "status": "retained", "owner": "alice" }
 *         ]
 *       }
 *     ]
 *   }
 */

import { readFile } from 'node:fs/promises'

/** Reviewer outcomes (handbook "Reviewer"). */
export const REVIEW_OUTCOMES = ['confirmed_bug', 'test_problem', 'product_decision', 'insufficient_evidence']

/** UI finding dispositions accepted by the UI release gate. */
export const UI_FINDING_STATUSES = ['resolved', 'accepted', 'retained']

/**
 * @typedef {Object} UiFindingDisposition
 * @property {string} id
 * @property {'resolved' | 'accepted' | 'retained'} status
 * @property {string | null} owner required when status is 'retained'
 */

/**
 * @typedef {Object} ReviewEntry
 * @property {string} runId
 * @property {string | null} scenarioId
 * @property {'confirmed_bug' | 'test_problem' | 'product_decision' | 'insufficient_evidence'} outcome
 * @property {string | null} reviewedAt
 * @property {number | null} reproductionTimeMs
 * @property {string | null} permanentScenarioId
 * @property {UiFindingDisposition[]} uiFindings
 */

export class ReviewLedgerError extends Error {
  /** @param {string[]} problems @param {string} [source] */
  constructor(problems, source) {
    super(`review ledger violation${source === undefined ? '' : ` in ${source}`}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.name = 'ReviewLedgerError'
    this.problems = problems
    this.source = source
  }
}

/**
 * Load and validate a review ledger file. A missing file (`ENOENT`) is an
 * empty ledger, not an error — metrics must handle "no reviews yet".
 * @param {string} file absolute path to the ledger JSON file
 * @returns {Promise<ReviewEntry[]>}
 */
export async function loadReviewLedger(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
    throw error
  }
  /** @type {unknown} */
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ReviewLedgerError([`file is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`], file)
  }
  return validateReviewLedger(raw, file)
}

/**
 * Validate a parsed review ledger, collecting every problem. Returns the
 * normalized entries when valid; throws ReviewLedgerError otherwise.
 * @param {unknown} raw
 * @param {string} [source]
 * @returns {ReviewEntry[]}
 */
export function validateReviewLedger(raw, source) {
  /** @type {string[]} */
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReviewLedgerError(['ledger must be a JSON object with a "reviews" list'], source)
  }
  const doc = /** @type {Record<string, unknown>} */ (raw)
  if (!Array.isArray(doc.reviews)) {
    throw new ReviewLedgerError(['ledger "reviews" must be a list'], source)
  }
  /** @type {ReviewEntry[]} */
  const entries = []
  doc.reviews.forEach((item, index) => {
    const label = `reviews[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${label} must be an object`)
      return
    }
    const record = /** @type {Record<string, unknown>} */ (item)
    if (typeof record.run_id !== 'string' || record.run_id.trim() === '') problems.push(`${label}.run_id must be a non-empty string`)
    if (!REVIEW_OUTCOMES.includes(/** @type {string} */ (record.outcome))) {
      problems.push(`${label}.outcome must be one of ${REVIEW_OUTCOMES.join(' | ')}, got ${JSON.stringify(record.outcome)}`)
    }
    if (record.scenario_id !== undefined && typeof record.scenario_id !== 'string') problems.push(`${label}.scenario_id must be a string`)
    if (record.reviewed_at !== undefined && typeof record.reviewed_at !== 'string') problems.push(`${label}.reviewed_at must be a string`)
    if (record.reproduction_time_ms !== undefined && !(typeof record.reproduction_time_ms === 'number' && record.reproduction_time_ms >= 0)) {
      problems.push(`${label}.reproduction_time_ms must be a non-negative number`)
    }
    if (record.permanent_scenario_id !== undefined && typeof record.permanent_scenario_id !== 'string') {
      problems.push(`${label}.permanent_scenario_id must be a string`)
    }
    const uiFindings = validateUiFindings(record.ui_findings, label, problems)
    const entryValid = !problems.some(problem => problem.startsWith(label))
    if (entryValid) {
      entries.push({
        runId: String(record.run_id),
        scenarioId: typeof record.scenario_id === 'string' ? record.scenario_id : null,
        outcome: /** @type {ReviewEntry['outcome']} */ (record.outcome),
        reviewedAt: typeof record.reviewed_at === 'string' ? record.reviewed_at : null,
        reproductionTimeMs: typeof record.reproduction_time_ms === 'number' ? record.reproduction_time_ms : null,
        permanentScenarioId: typeof record.permanent_scenario_id === 'string' ? record.permanent_scenario_id : null,
        uiFindings,
      })
    }
  })
  if (problems.length > 0) throw new ReviewLedgerError(problems, source)
  return entries
}

/**
 * @param {unknown} raw @param {string} label @param {string[]} problems
 * @returns {UiFindingDisposition[]}
 */
function validateUiFindings(raw, label, problems) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push(`${label}.ui_findings must be a list`)
    return []
  }
  /** @type {UiFindingDisposition[]} */
  const findings = []
  raw.forEach((item, index) => {
    const entryLabel = `${label}.ui_findings[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${entryLabel} must be an object`)
      return
    }
    const record = /** @type {Record<string, unknown>} */ (item)
    if (typeof record.id !== 'string' || record.id.trim() === '') problems.push(`${entryLabel}.id must be a non-empty string`)
    if (!UI_FINDING_STATUSES.includes(/** @type {string} */ (record.status))) {
      problems.push(`${entryLabel}.status must be one of ${UI_FINDING_STATUSES.join(' | ')}, got ${JSON.stringify(record.status)}`)
    }
    if (record.status === 'retained' && (typeof record.owner !== 'string' || record.owner.trim() === '')) {
      problems.push(`${entryLabel}.owner is required when status is retained (handbook: retained with an owner)`)
    }
    if (record.owner !== undefined && typeof record.owner !== 'string') problems.push(`${entryLabel}.owner must be a string`)
    findings.push({
      id: String(record.id),
      status: /** @type {UiFindingDisposition['status']} */ (record.status),
      owner: typeof record.owner === 'string' ? record.owner : null,
    })
  })
  return findings
}
