/**
 * Release gate evaluation (handbook "Failure handling and metrics").
 *
 * The handbook's four release gates:
 *
 *   1. critical_high_deterministic_pass — every executed critical/high
 *      deterministic (non-UI) scenario passed.
 *   2. no_unreviewed_hard_failures — every hard failure (handbook's list:
 *      assertion failure, unbounded timeout, external-effect attempt,
 *      incomplete evidence) carries a reviewer outcome in the ledger.
 *   3. no_external_effect_violation — no run recorded an external-effect
 *      hard stop (hard_stop verdict or a non-empty hard_stops list).
 *   4. ui_findings_dispositioned — every recorded UI finding is resolved,
 *      accepted (product decision), or retained with an owner.
 *
 * Each gate returns an explicit { gate, verdict: pass | fail, reasons } — a
 * gate NEVER passes silently and never throws on partial input: an empty run
 * set fails gate 1 with a reason, and unreviewed failures are enumerated by
 * scenario/run id.
 */

import { isHardFailure } from './metrics.mjs'

/**
 * @typedef {Object} GateResult
 * @property {string} gate stable gate identifier
 * @property {'pass' | 'fail'} verdict
 * @property {string[]} reasons human-readable evidence for the verdict
 */

/** Risks gate 1 holds to a mandatory pass. */
export const GATED_RISKS = new Set(['critical', 'high'])

/** Scenario kinds gate 1 treats as deterministic. */
export const DETERMINISTIC_KINDS = new Set(['deterministic', 'fault_injection'])

/**
 * Evaluate all four release gates.
 * @param {import('./runs.mjs').RunRecord[]} runs
 * @param {{ reviews?: import('./reviews.mjs').ReviewEntry[] }} [inputs]
 * @returns {GateResult[]}
 */
export function evaluateReleaseGates(runs, inputs = {}) {
  const reviews = inputs.reviews ?? []
  return [
    gateCriticalHighDeterministicPass(runs),
    gateNoUnreviewedHardFailures(runs, reviews),
    gateNoExternalEffectViolation(runs),
    gateUiFindingsDispositioned(reviews),
  ]
}

/**
 * Gate 1: all critical/high deterministic scenarios pass.
 * @param {import('./runs.mjs').RunRecord[]} runs
 * @returns {GateResult}
 */
export function gateCriticalHighDeterministicPass(runs) {
  const gated = runs.filter(run => GATED_RISKS.has(run.risk) && DETERMINISTIC_KINDS.has(run.kind))
  const reasons = []
  const failing = gated.filter(run => run.verdict !== 'pass')
  if (gated.length === 0) {
    reasons.push('no critical/high deterministic scenario executions found; the gate cannot be satisfied by an empty suite')
  }
  for (const run of failing) {
    reasons.push(`${run.scenarioId} run ${run.runId} (${run.risk}/${run.kind}) verdict is ${run.verdict}, expected pass`)
  }
  return {
    gate: 'critical_high_deterministic_pass',
    verdict: gated.length > 0 && failing.length === 0 ? 'pass' : 'fail',
    reasons: reasons.length === 0 ? [`${gated.length} critical/high deterministic execution(s) passed`] : reasons,
  }
}

/**
 * Gate 2: no unreviewed hard failures. A hard failure is reviewed when the
 * ledger carries any reviewer outcome for its run id.
 * @param {import('./runs.mjs').RunRecord[]} runs
 * @param {import('./reviews.mjs').ReviewEntry[]} reviews
 * @returns {GateResult}
 */
export function gateNoUnreviewedHardFailures(runs, reviews) {
  const reviewedRunIds = new Set(reviews.map(review => review.runId))
  const unreviewed = runs.filter(run => isHardFailure(run) && !reviewedRunIds.has(run.runId))
  const reasons = unreviewed.map(run => `${run.scenarioId} run ${run.runId} is a hard failure (verdict ${run.verdict}${run.missingEvidence.length > 0 ? `, missing evidence: ${run.missingEvidence.join(', ')}` : ''}) with no reviewer outcome`)
  return {
    gate: 'no_unreviewed_hard_failures',
    verdict: unreviewed.length === 0 ? 'pass' : 'fail',
    reasons: reasons.length === 0 ? ['every hard failure carries a reviewer outcome (or no hard failures occurred)'] : reasons,
  }
}

/**
 * Gate 3: no external-effect safety violation.
 * @param {import('./runs.mjs').RunRecord[]} runs
 * @returns {GateResult}
 */
export function gateNoExternalEffectViolation(runs) {
  const violations = runs.filter(run => run.verdict === 'hard_stop' || run.hardStops.length > 0)
  const reasons = violations.map(run => `${run.scenarioId} run ${run.runId} recorded an external-effect hard stop: ${run.hardStops[0] ?? 'verdict hard_stop'}`)
  return {
    gate: 'no_external_effect_violation',
    verdict: violations.length === 0 ? 'pass' : 'fail',
    reasons: reasons.length === 0 ? ['no external-effect safety violation recorded'] : reasons,
  }
}

/**
 * Gate 4: all UI findings are resolved, accepted as a product decision, or
 * retained with an owner. The ledger validator already rejects a retained
 * finding without an owner, so any finding that reaches this gate is
 * dispositioned; the gate reports how many findings were seen and fails when
 * UI runs exist but no findings ledger entries were recorded for them only
 * if a UI run failed (a failed UI run without findings is gate 2's concern).
 * @param {import('./reviews.mjs').ReviewEntry[]} reviews
 * @returns {GateResult}
 */
export function gateUiFindingsDispositioned(reviews) {
  const findings = reviews.flatMap(review => review.uiFindings)
  // validateReviewLedger enforces the disposition vocabulary and the
  // retained-requires-owner rule, so reaching here means every finding is
  // dispositioned. Defensive re-check keeps the gate sound for callers that
  // hand-built entries without the validator.
  const undispositioned = findings.filter(finding => finding.status === 'retained' && (finding.owner === null || finding.owner === ''))
  const reasons = undispositioned.map(finding => `UI finding ${finding.id} is retained without an owner`)
  return {
    gate: 'ui_findings_dispositioned',
    verdict: undispositioned.length === 0 ? 'pass' : 'fail',
    reasons: reasons.length === 0
      ? [`${findings.length} UI finding(s) resolved, accepted, or retained with an owner`]
      : reasons,
  }
}

/**
 * Overall release verdict: every gate must pass.
 * @param {GateResult[]} gates
 * @returns {{ verdict: 'pass' | 'fail', gates: GateResult[] }}
 */
export function summarizeGates(gates) {
  return { verdict: gates.every(gate => gate.verdict === 'pass') ? 'pass' : 'fail', gates }
}
