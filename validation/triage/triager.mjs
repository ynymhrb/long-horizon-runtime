/**
 * Incident triager (handbook "Incident triager" / "LLM triage contract").
 *
 * Given a failing, inconclusive or passing evidence bundle, produce a triage
 * report that strictly matches the handbook's JSON contract. Every claim
 * cites an evidence identifier; hypotheses never exceed three.
 *
 * Deterministic fallback: when no LLM analyzer is supplied, the built-in
 * deterministic analyzer derives the report from recorded evidence alone —
 * same input, same report, byte for byte — and never performs network or
 * external LLM calls. An optional caller-supplied `analyze` function may
 * implement genuine LLM triage OUTSIDE deterministic validation runs; its
 * output is still forced through the contract validator before it is used.
 */

import { loadEvidenceBundle } from './bundle.mjs'
import { MAX_HYPOTHESES, triageContractSkeleton, validateTriageReport } from './contract.mjs'

/**
 * @typedef {Object} TriageOptions
 * @property {(bundle: import('./bundle.mjs').EvidenceBundle) => Promise<unknown> | unknown} [analyze]
 *   optional LLM analyzer; receives the loaded bundle and returns a candidate
 *   report. Never used in deterministic runs (no analyzer is wired there).
 * @property {string} [source] description used in contract error messages
 */

/**
 * Triage one evidence bundle directory.
 * @param {string} evidenceDir absolute evidence bundle directory
 * @param {TriageOptions} [options]
 * @returns {Promise<import('./contract.js').TriageReport>}
 */
export async function triageBundle(evidenceDir, options = {}) {
  const bundle = await loadEvidenceBundle(evidenceDir)
  return triageEvidence(bundle, options)
}

/**
 * Triage an already-loaded evidence bundle.
 * @param {import('./bundle.mjs').EvidenceBundle} bundle
 * @param {TriageOptions} [options]
 * @returns {Promise<import('./contract.js').TriageReport>}
 */
export async function triageEvidence(bundle, options = {}) {
  const fallback = deterministicFallbackReport(bundle)
  if (typeof options.analyze !== 'function') return fallback

  let candidate
  try {
    candidate = await options.analyze(bundle)
  } catch {
    // An analyzer failure never breaks a run; the deterministic report stands.
    return fallback
  }
  try {
    return validateTriageReport(candidate, options.source ?? 'llm triage report')
  } catch {
    // A contract-violating LLM report is discarded, never repaired by guesswork.
    return fallback
  }
}

/**
 * Build the deterministic no-LLM triage report from recorded evidence.
 *
 * Rules (all evidence-backed, all citing evidence ids):
 *   - hard_stop verdict or recorded     -> candidate_bug, high confidence; the
 *     hard stop (external effect)         safety boundary itself fired. A
 *                                         detected external effect is a hard
 *                                         stop, never an inconclusive run.
 *   - fail with a failed assertion     -> candidate_bug, low confidence;
 *                                         a reviewer decides with the oracle.
 *   - fail without assertion outcomes  -> likely_test_issue (a command errored
 *                                         before any oracle could run).
 *   - inconclusive / unevaluated /     -> insufficient_evidence; classifying
 *     missing evidence                     evidence as insufficient is
 *                                         preferable to inventing a root cause.
 *   - pass                             -> insufficient_evidence with an empty
 *                                         report (triage of a passing run
 *                                         finds nothing to claim).
 * @param {import('./bundle.mjs').EvidenceBundle} bundle
 * @returns {import('./contract.js').TriageReport}
 */
export function deterministicFallbackReport(bundle) {
  const report = triageContractSkeleton()
  const verdict = String(bundle.run.verdict ?? '')
  const assertionOutcomes = Array.isArray(bundle.assertions.outcomes) ? bundle.assertions.outcomes : []
  const failed = assertionOutcomes.filter(outcome => /** @type {Record<string, unknown>} */ (outcome).status === 'fail')
  const unevaluated = assertionOutcomes.filter(outcome => /** @type {Record<string, unknown>} */ (outcome).status === 'unevaluated')
  const missingEvidence = /** @type {Record<string, unknown>} */ (bundle.run.evidence)?.missing
  const missing = Array.isArray(missingEvidence) ? missingEvidence.map(String) : []
  const recordedStops = Array.isArray(bundle.run.hard_stops) ? bundle.run.hard_stops.map(String) : []
  const errors = Array.isArray(bundle.run.errors) ? bundle.run.errors.map(String) : []
  // The runner's hard_stop verdict is fail-class terminal for a detected
  // external effect. Treat the verdict itself as the safety signal even when
  // the run recorded no stop detail (defense in depth against partial bundles).
  const hardStop = verdict === 'hard_stop' || recordedStops.length > 0
  const hardStops = recordedStops.length > 0 ? recordedStops : verdict === 'hard_stop' ? ['the runner recorded a hard_stop verdict'] : []

  if (verdict === 'pass' && !hardStop) return report

  if (hardStop) {
    report.verdict = 'candidate_bug'
    const anomalyRef = firstExternalEffectRef(failed, bundle)
    report.earliest_anomaly = {
      evidence_id: anomalyRef?.evidence_id ?? 'run.json#hard_stops',
      timestamp: String(bundle.run.finished_at ?? bundle.run.started_at ?? ''),
      observation: `An external effect was planned or attempted and the run hard-stopped: ${hardStops[0]}`,
    }
    report.hypotheses = [
      {
        title: 'The runtime or scenario attempted an external effect despite the read_only boundary',
        confidence: 'high',
        evidence: [report.earliest_anomaly.evidence_id, 'run.json#hard_stops'],
        minimal_reproduction: ['Re-run the scenario through the deterministic runner', 'Inspect the recorded hard stop and the flagged evidence entry'],
        automatable_oracle: 'The no_external_effect oracle passes: no event or snapshot entry carries sideEffectClass external_effect',
      },
    ]
    report.stop_reason = hardStops[0] ?? null
    return report
  }

  if (verdict === 'fail' && failed.length > 0) {
    report.verdict = 'candidate_bug'
    const first = /** @type {Record<string, unknown>} */ (failed[0])
    const anomalyRef = earliestFailedEventRef(bundle) ?? { evidence_id: `assertions.json#${String(first.id)}` }
    report.earliest_anomaly = {
      evidence_id: anomalyRef.evidence_id,
      timestamp: String(bundle.run.finished_at ?? bundle.run.started_at ?? ''),
      observation: `Hard assertion ${String(first.id)} (${String(first.oracle)}) failed: ${String(first.detail)}`,
    }
    report.hypotheses = [
      {
        title: `Observable behavior violates assertion ${String(first.id)}: ${String(first.check ?? first.detail)}`,
        confidence: 'low',
        evidence: [report.earliest_anomaly.evidence_id],
        minimal_reproduction: minimalReproduction(bundle),
        automatable_oracle: `Assertion ${String(first.id)} passes: expected ${summarizeJson(first.expected)}, observed ${summarizeJson(first.actual)}`,
      },
    ]
    return report
  }

  if (verdict === 'fail') {
    report.verdict = 'likely_test_issue'
    const failedCommand = bundle.commands.find(command => typeof command.exit_code === 'number' && command.exit_code !== 0)
    const timedOutCommand = bundle.commands.find(command => command.timed_out === true)
    const culprit = timedOutCommand ?? failedCommand
    if (culprit !== undefined) {
      const commandIndex = bundle.commands.indexOf(culprit)
      report.earliest_anomaly = {
        evidence_id: `commands.ndjson#${commandIndex + 1}`,
        timestamp: String(bundle.run.finished_at ?? bundle.run.started_at ?? ''),
        observation: `Command ${String(culprit.name)} ${timedOutCommand !== undefined ? 'exceeded its timeout' : `exited ${String(culprit.exit_code)}`} before assertions could run${errors.length > 0 ? `: ${errors[0]}` : ''}`,
      }
      report.hypotheses = [
        {
          title: `The scenario command ${String(culprit.name)} failed before any hard assertion could evaluate`,
          confidence: 'medium',
          evidence: [report.earliest_anomaly.evidence_id],
          minimal_reproduction: minimalReproduction(bundle),
          automatable_oracle: `Command ${String(culprit.name)} exits 0 within its timeout and the staged evidence appears`,
        },
      ]
    }
    return report
  }

  // inconclusive (or an unknown verdict): evidence is insufficient by rule.
  report.verdict = 'insufficient_evidence'
  const causes = []
  if (missing.length > 0) causes.push(`missing required evidence: ${missing.join(', ')}`)
  if (unevaluated.length > 0) causes.push(`${unevaluated.length} assertion(s) could not be executed`)
  if (causes.length > 0) {
    const firstUnevaluated = /** @type {Record<string, unknown>} */ (unevaluated[0] ?? {})
    report.earliest_anomaly = {
      evidence_id: unevaluated.length > 0 ? `assertions.json#${String(firstUnevaluated.id)}` : 'run.json#evidence',
      timestamp: String(bundle.run.finished_at ?? bundle.run.started_at ?? ''),
      observation: `The run is inconclusive: ${causes.join('; ')}`,
    }
  }
  return report
}

/**
 * Locate the evidence id of the first externally-flagged entry, preferring a
 * failed no_external_effect assertion's own actual list.
 * @param {unknown[]} failed @param {import('./bundle.mjs').EvidenceBundle} bundle
 */
function firstExternalEffectRef(failed, bundle) {
  for (const outcome of failed) {
    const record = /** @type {Record<string, unknown>} */ (outcome)
    if (record.oracle === 'no_external_effect' && Array.isArray(record.actual) && record.actual.length > 0) {
      const hit = /** @type {Record<string, unknown>} */ (record.actual[0])
      if (typeof hit.evidence_id === 'string') return { evidence_id: hit.evidence_id }
    }
  }
  const index = bundle.events.findIndex(event => /sideEffectClass|side_effect_class/.test(JSON.stringify(event)))
  if (index === -1) return undefined
  return { evidence_id: `events.json#${bundle.events[index]?.seq ?? index}` }
}

/**
 * The earliest durable event that looks anomalous (failure/cancel/block), as
 * the anomaly anchor for assertion failures.
 * @param {import('./bundle.mjs').EvidenceBundle} bundle
 */
function earliestFailedEventRef(bundle) {
  const pattern = /Failed|Cancelled|Blocked|Interrupted/
  const index = bundle.events.findIndex(event => pattern.test(String(event.type ?? '')))
  if (index === -1) return undefined
  return { evidence_id: `events.json#${bundle.events[index]?.seq ?? index}` }
}

/**
 * A falsifiable reproduction from the recorded command log: the exact
 * commands, in order, that a reviewer must re-run.
 * @param {import('./bundle.mjs').EvidenceBundle} bundle
 * @returns {string[]}
 */
function minimalReproduction(bundle) {
  const steps = bundle.commands
    .filter(command => command.kind === 'command')
    .map(command => `Run ${String(command.name)}: ${String(command.command)}`)
  return steps.length === 0 ? ['Re-run the scenario through the deterministic runner'] : steps.slice(0, 5)
}

/** @param {unknown} value */
function summarizeJson(value) {
  const text = JSON.stringify(value)
  return text !== undefined && text.length > 160 ? `${text.slice(0, 160)}…` : text
}

export { MAX_HYPOTHESES }
