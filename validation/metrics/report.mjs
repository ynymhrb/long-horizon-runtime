/**
 * Suite report orchestrator (handbook "Failure handling and metrics").
 *
 * One call turns an evidence root into the full suite report: the handbook's
 * ten required metrics plus the four release gates with explicit verdicts.
 *
 * Triage inputs come from the deterministic no-LLM triager by default — same
 * bundles in, same candidate counts out — so `llm_candidate_count` reflects
 * what the handbook's review loop would send to a reviewer. A caller running
 * genuine LLM triage outside deterministic validation may pass its reports
 * in explicitly.
 */

import { loadRunRecords } from './runs.mjs'
import { loadReviewLedger } from './reviews.mjs'
import { aggregateMetrics } from './metrics.mjs'
import { evaluateReleaseGates, summarizeGates } from './gates.mjs'
import { loadEvidenceBundle } from '../triage/bundle.mjs'
import { triageEvidence } from '../triage/triager.mjs'

/**
 * @typedef {Object} SuiteReport
 * @property {string} generated_from evidence root the report was built from
 * @property {import('./metrics.mjs').RunMetrics} metrics
 * @property {{ verdict: 'pass' | 'fail', gates: import('./gates.mjs').GateResult[] }} release_gates
 * @property {{ scenario_id: string, run_id: string, verdict: string, risk: string, kind: string }[]} runs
 */

/**
 * Build the complete suite report for one evidence root.
 * @param {string} evidenceRoot absolute evidence root directory
 * @param {{
 *   scenarioRoot?: string,
 *   reviewLedgerFile?: string,
 *   triageReports?: { runId: string, verdict: string }[],
 *   skipTriage?: boolean,
 * }} [options]
 * @returns {Promise<SuiteReport>}
 */
export async function buildSuiteReport(evidenceRoot, options = {}) {
  const runs = await loadRunRecords(evidenceRoot, options.scenarioRoot !== undefined ? { scenarioRoot: options.scenarioRoot } : {})
  const reviews = options.reviewLedgerFile !== undefined ? await loadReviewLedger(options.reviewLedgerFile) : []
  const triageReports = options.triageReports ?? (options.skipTriage === true ? [] : await triageAllRuns(runs))

  const metrics = aggregateMetrics(runs, { triageReports, reviews })
  const gates = evaluateReleaseGates(runs, { reviews })

  return {
    generated_from: evidenceRoot,
    metrics,
    release_gates: summarizeGates(gates),
    runs: runs.map(run => ({ scenario_id: run.scenarioId, run_id: run.runId, verdict: run.verdict, risk: run.risk, kind: run.kind })),
  }
}

/**
 * Run the deterministic no-LLM triager over every run's bundle to classify
 * candidates. Bundles that cannot be loaded are skipped (a partial evidence
 * tree never breaks the report).
 * @param {import('./runs.mjs').RunRecord[]} runs
 * @returns {Promise<{ runId: string, verdict: string }[]>}
 */
async function triageAllRuns(runs) {
  /** @type {{ runId: string, verdict: string }[]} */
  const reports = []
  for (const run of runs) {
    try {
      const bundle = await loadEvidenceBundle(run.evidenceDir)
      const report = await triageEvidence(bundle)
      reports.push({ runId: run.runId, verdict: report.verdict })
    } catch {
      // An unloadable bundle contributes no candidate; metrics stay deterministic.
    }
  }
  return reports
}
