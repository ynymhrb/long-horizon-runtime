/**
 * Focused self-tests for validation/metrics/ (handbook "Failure handling and
 * metrics" / release gates).
 *
 * Proves the output contract of the implement-metrics-module task:
 *   - aggregation over an evidence root computes all ten handbook metrics
 *     with the handbook's exact definitions
 *   - failure rates group deterministically by risk and by tag
 *   - empty and partial evidence inputs never crash and never produce NaN
 *   - the review ledger drives candidate confirmation rate, median
 *     reproduction time, permanent scenarios added, and the UI gate
 *   - each of the four release gates returns an explicit pass/fail verdict
 *     with reasons, including the empty-suite and unreviewed-failure cases
 *   - the end-to-end suite report (via buildSuiteReport over real runner
 *     bundles) is deterministic and matches a hand-computed expectation
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { evaluateReleaseGates, gateCriticalHighDeterministicPass, gateNoExternalEffectViolation, gateNoUnreviewedHardFailures, gateUiFindingsDispositioned } from '../validation/metrics/gates.mjs'
import { aggregateMetrics, isHardFailure, median, rate } from '../validation/metrics/metrics.mjs'
import { buildSuiteReport } from '../validation/metrics/report.mjs'
import { ReviewLedgerError, loadReviewLedger, validateReviewLedger, type ReviewEntry } from '../validation/metrics/reviews.mjs'
import { loadRunRecords, type RunRecord } from '../validation/metrics/runs.mjs'

const REPO_ROOT = path.resolve(__dirname, '..')

const createdDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Build a RunRecord with sensible defaults. */
function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scenarioId: 'LT-TEST-001',
    runId: 'run-1',
    verdict: 'pass',
    risk: 'high',
    kind: 'deterministic',
    tags: ['read_only'],
    startedAt: '2026-08-27T00:00:00.000Z',
    finishedAt: '2026-08-27T00:01:00.000Z',
    durationMs: 60_000,
    timedOut: false,
    missingEvidence: [],
    evidenceComplete: true,
    hardStops: [],
    errors: [],
    assertionFailed: false,
    evidenceDir: '/nonexistent',
    ...overrides,
  }
}

function reviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    runId: 'run-1',
    scenarioId: 'LT-TEST-001',
    outcome: 'confirmed_bug',
    reviewedAt: '2026-08-27T02:00:00.000Z',
    reproductionTimeMs: null,
    permanentScenarioId: null,
    uiFindings: [],
    ...overrides,
  }
}

/** Write one minimal evidence bundle into <root>/<scenarioId>/<runId>/. */
async function writeBundle(root: string, scenarioId: string, runId: string, run: Record<string, unknown>, options: { commands?: Record<string, unknown>[]; assertions?: Record<string, unknown> } = {}): Promise<string> {
  const dir = path.join(root, scenarioId, runId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({ scenario_id: scenarioId, run_id: runId, ...run }, null, 2), 'utf8')
  const commands = options.commands ?? []
  await writeFile(path.join(dir, 'commands.ndjson'), commands.length === 0 ? '' : `${commands.map(command => JSON.stringify(command)).join('\n')}\n`, 'utf8')
  await writeFile(path.join(dir, 'assertions.json'), JSON.stringify(options.assertions ?? { outcomes: [] }), 'utf8')
  // Remaining evidence files exist so the triage bundle loader can read them.
  for (const [name, shell] of Object.entries({ 'task.json': { goals: [] }, 'events.json': { events: [] }, 'snapshot.json': { goal: null }, 'artifacts.json': { artifacts: [] }, 'environment.json': {} })) {
    await writeFile(path.join(dir, name), JSON.stringify(shell), 'utf8')
  }
  return dir
}

describe('rate and median primitives', () => {
  test('rate is 0 for an empty denominator, never NaN', () => {
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: 0 })
    expect(rate(3, 4)).toEqual({ numerator: 3, denominator: 4, rate: 0.75 })
  })

  test('median of an empty list is null; odd/even lists follow the definition', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([1, 3, 9])).toBe(3)
  })
})

describe('aggregateMetrics', () => {
  test('computes all ten handbook metrics for a mixed run set', () => {
    const runs = [
      runRecord({ scenarioId: 'LT-STATE-001', runId: 'a', verdict: 'pass', risk: 'critical', tags: ['state', 'read_only'] }),
      runRecord({ scenarioId: 'LT-STATE-002', runId: 'b', verdict: 'fail', risk: 'high', tags: ['state', 'read_only'], assertionFailed: true }),
      runRecord({ scenarioId: 'LT-FAULT-001', runId: 'c', verdict: 'fail', risk: 'high', kind: 'fault_injection', tags: ['fault_injection', 'read_only'], timedOut: true }),
      runRecord({ scenarioId: 'LT-FAULT-002', runId: 'd', verdict: 'hard_stop', risk: 'medium', kind: 'fault_injection', tags: ['fault_injection', 'read_only'], hardStops: ['external effect'] }),
      runRecord({ scenarioId: 'LT-UI-001', runId: 'e', verdict: 'inconclusive', risk: 'low', kind: 'exploratory_ui', tags: ['ui'], missingEvidence: ['screenshots'], evidenceComplete: false }),
    ]
    const metrics = aggregateMetrics(runs, {
      triageReports: [
        { runId: 'b', verdict: 'candidate_bug' },
        { runId: 'c', verdict: 'candidate_bug' },
        { runId: 'e', verdict: 'insufficient_evidence' },
      ],
      reviews: [
        reviewEntry({ runId: 'b', outcome: 'confirmed_bug', reproductionTimeMs: 300_000, permanentScenarioId: 'LT-STATE-015' }),
        reviewEntry({ runId: 'c', outcome: 'test_problem', reproductionTimeMs: 900_000 }),
      ],
    })

    expect(metrics.total_executions).toBe(5)
    expect(metrics.hard_pass_rate).toEqual({ numerator: 1, denominator: 5, rate: 0.2 })
    // failure rate by risk: critical 0/1, high 2/2, medium 1/1, low 0/1
    expect(metrics.failure_rate_by_risk.critical).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(metrics.failure_rate_by_risk.high).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(metrics.failure_rate_by_risk.medium).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(metrics.failure_rate_by_risk.low).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    // failure rate by tag: state 1/2, fault_injection 2/2, read_only 3/4, ui 0/1
    expect(metrics.failure_rate_by_tag.state).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(metrics.failure_rate_by_tag.fault_injection).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(metrics.failure_rate_by_tag.read_only).toEqual({ numerator: 3, denominator: 4, rate: 0.75 })
    expect(metrics.failure_rate_by_tag.ui).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(metrics.timeout_rate).toEqual({ numerator: 1, denominator: 5, rate: 0.2 })
    expect(metrics.evidence_completeness_rate).toEqual({ numerator: 4, denominator: 5, rate: 0.8 })
    expect(metrics.llm_candidate_count).toBe(2)
    expect(metrics.candidate_confirmation_rate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(metrics.median_reproduction_time_ms).toBe(600_000)
    expect(metrics.permanent_scenarios_added).toEqual({ count: 1, scenario_ids: ['LT-STATE-015'] })
  })

  test('handles an empty run set deterministically without NaN', () => {
    const metrics = aggregateMetrics([])
    expect(metrics.total_executions).toBe(0)
    expect(metrics.hard_pass_rate).toEqual({ numerator: 0, denominator: 0, rate: 0 })
    expect(metrics.failure_rate_by_risk).toEqual({})
    expect(metrics.failure_rate_by_tag).toEqual({})
    expect(metrics.timeout_rate.rate).toBe(0)
    expect(metrics.evidence_completeness_rate.rate).toBe(0)
    expect(metrics.llm_candidate_count).toBe(0)
    expect(metrics.candidate_confirmation_rate).toEqual({ numerator: 0, denominator: 0, rate: 0 })
    expect(metrics.median_reproduction_time_ms).toBeNull()
    expect(metrics.permanent_scenarios_added).toEqual({ count: 0, scenario_ids: [] })
    expect(JSON.stringify(metrics)).not.toContain('NaN')
  })

  test('candidate confirmation rate counts only reviewed candidates, not other reviews', () => {
    const runs = [runRecord({ runId: 'x', verdict: 'fail' })]
    const metrics = aggregateMetrics(runs, {
      triageReports: [{ runId: 'x', verdict: 'candidate_bug' }],
      reviews: [reviewEntry({ runId: 'unrelated', outcome: 'confirmed_bug' })],
    })
    // The unrelated review is not for a candidate run: denominator is 0.
    expect(metrics.candidate_confirmation_rate).toEqual({ numerator: 0, denominator: 0, rate: 0 })
  })

  test('grouping keys are sorted for byte-identical repeated aggregation', () => {
    const runs = [
      runRecord({ runId: '1', risk: 'low', tags: ['zeta', 'alpha'] }),
      runRecord({ runId: '2', risk: 'critical', tags: ['beta'], verdict: 'fail' }),
    ]
    const metrics = aggregateMetrics(runs)
    expect(Object.keys(metrics.failure_rate_by_risk)).toEqual(['critical', 'low'])
    expect(Object.keys(metrics.failure_rate_by_tag)).toEqual(['alpha', 'beta', 'zeta'])
  })

  test('runs without tags contribute to the deterministic untagged bucket', () => {
    const metrics = aggregateMetrics([runRecord({ runId: '1', tags: [], verdict: 'fail' })])
    expect(metrics.failure_rate_by_tag.untagged).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  })
})

describe('isHardFailure', () => {
  test('fail and hard_stop verdicts are hard failures', () => {
    expect(isHardFailure(runRecord({ verdict: 'fail' }))).toBe(true)
    expect(isHardFailure(runRecord({ verdict: 'hard_stop' }))).toBe(true)
  })

  test('inconclusive with missing evidence is a hard failure; without is not', () => {
    expect(isHardFailure(runRecord({ verdict: 'inconclusive', missingEvidence: ['events'], evidenceComplete: false }))).toBe(true)
    expect(isHardFailure(runRecord({ verdict: 'inconclusive' }))).toBe(false)
    expect(isHardFailure(runRecord({ verdict: 'pass' }))).toBe(false)
  })
})

describe('release gates', () => {
  test('gate 1 passes when all critical/high deterministic runs pass', () => {
    const gate = gateCriticalHighDeterministicPass([
      runRecord({ runId: '1', risk: 'critical', kind: 'deterministic', verdict: 'pass' }),
      runRecord({ runId: '2', risk: 'high', kind: 'fault_injection', verdict: 'pass' }),
      runRecord({ runId: '3', risk: 'low', kind: 'deterministic', verdict: 'fail' }),
    ])
    expect(gate.verdict).toBe('pass')
  })

  test('gate 1 fails an empty suite and enumerates failing gated runs', () => {
    expect(gateCriticalHighDeterministicPass([]).verdict).toBe('fail')
    expect(gateCriticalHighDeterministicPass([]).reasons[0]).toContain('no critical/high deterministic')
    const gate = gateCriticalHighDeterministicPass([
      runRecord({ scenarioId: 'LT-STATE-009', runId: 'x', risk: 'critical', kind: 'deterministic', verdict: 'inconclusive' }),
      runRecord({ scenarioId: 'LT-UI-001', runId: 'y', risk: 'high', kind: 'exploratory_ui', verdict: 'fail' }),
    ])
    expect(gate.verdict).toBe('fail')
    // The UI run is not a deterministic scenario: gate 1 does not cover it.
    expect(gate.reasons).toHaveLength(1)
    expect(gate.reasons[0]).toContain('LT-STATE-009')
    expect(gate.reasons[0]).toContain('inconclusive')
  })

  test('gate 2 fails on unreviewed hard failures and passes once reviewed', () => {
    const runs = [runRecord({ scenarioId: 'LT-FAULT-003', runId: 'f', verdict: 'fail' })]
    const unreviewed = gateNoUnreviewedHardFailures(runs, [])
    expect(unreviewed.verdict).toBe('fail')
    expect(unreviewed.reasons[0]).toContain('LT-FAULT-003')
    expect(unreviewed.reasons[0]).toContain('no reviewer outcome')
    const reviewed = gateNoUnreviewedHardFailures(runs, [reviewEntry({ runId: 'f', outcome: 'confirmed_bug' })])
    expect(reviewed.verdict).toBe('pass')
  })

  test('gate 2 treats inconclusive-with-missing-evidence as a hard failure', () => {
    const runs = [runRecord({ runId: 'g', verdict: 'inconclusive', missingEvidence: ['task'], evidenceComplete: false })]
    expect(gateNoUnreviewedHardFailures(runs, []).verdict).toBe('fail')
    expect(gateNoUnreviewedHardFailures(runs, [reviewEntry({ runId: 'g', outcome: 'test_problem' })]).verdict).toBe('pass')
  })

  test('gate 3 fails on any external-effect hard stop', () => {
    expect(gateNoExternalEffectViolation([runRecord({ verdict: 'pass' })]).verdict).toBe('pass')
    const gate = gateNoExternalEffectViolation([runRecord({ runId: 'h', verdict: 'hard_stop', hardStops: ['step x declares external_effect'] })])
    expect(gate.verdict).toBe('fail')
    expect(gate.reasons[0]).toContain('external-effect')
  })

  test('gate 4 passes for resolved/accepted/retained-with-owner findings', () => {
    const gate = gateUiFindingsDispositioned([
      reviewEntry({
        uiFindings: [
          { id: 'F-1', status: 'resolved', owner: null },
          { id: 'F-2', status: 'accepted', owner: null },
          { id: 'F-3', status: 'retained', owner: 'alice' },
        ],
      }),
    ])
    expect(gate.verdict).toBe('pass')
    // Defensive: a retained finding without an owner fails the gate.
    const bad = gateUiFindingsDispositioned([reviewEntry({ uiFindings: [{ id: 'F-4', status: 'retained', owner: null }] })])
    expect(bad.verdict).toBe('fail')
    expect(bad.reasons[0]).toContain('F-4')
  })

  test('evaluateReleaseGates returns all four gates with explicit verdicts', () => {
    const gates = evaluateReleaseGates([runRecord({ runId: '1', risk: 'critical', kind: 'deterministic', verdict: 'pass' })], { reviews: [] })
    expect(gates.map(gate => gate.gate)).toEqual(['critical_high_deterministic_pass', 'no_unreviewed_hard_failures', 'no_external_effect_violation', 'ui_findings_dispositioned'])
    for (const gate of gates) expect(['pass', 'fail']).toContain(gate.verdict)
  })
})

describe('review ledger', () => {
  test('accepts a valid ledger and normalizes entries', () => {
    const entries = validateReviewLedger({
      reviews: [
        { run_id: 'r1', outcome: 'confirmed_bug', reproduction_time_ms: 120, permanent_scenario_id: 'LT-X-001', ui_findings: [{ id: 'F-1', status: 'retained', owner: 'bob' }] },
        { run_id: 'r2', outcome: 'insufficient_evidence' },
      ],
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ runId: 'r1', outcome: 'confirmed_bug', reproductionTimeMs: 120, permanentScenarioId: 'LT-X-001' })
    expect(entries[0]?.uiFindings[0]).toEqual({ id: 'F-1', status: 'retained', owner: 'bob' })
    expect(entries[1]).toMatchObject({ runId: 'r2', uiFindings: [], reproductionTimeMs: null })
  })

  test('rejects invalid outcomes, missing run_id, and retained findings without owner', () => {
    for (const doc of [
      { reviews: [{ run_id: 'r', outcome: 'maybe' }] },
      { reviews: [{ outcome: 'confirmed_bug' }] },
      { reviews: [{ run_id: 'r', outcome: 'confirmed_bug', ui_findings: [{ id: 'F', status: 'retained' }] }] },
      { reviews: [{ run_id: 'r', outcome: 'confirmed_bug', reproduction_time_ms: -1 }] },
      { reviews: 'not-a-list' },
    ]) {
      expect(() => validateReviewLedger(doc, 'test')).toThrowError(ReviewLedgerError)
    }
  })

  test('a missing ledger file is an empty ledger, not an error', async () => {
    const dir = await tempDir('lt-ledger-')
    await expect(loadReviewLedger(path.join(dir, 'absent.json'))).resolves.toEqual([])
  })

  test('an unparseable ledger file is a ReviewLedgerError', async () => {
    const dir = await tempDir('lt-ledger-')
    const file = path.join(dir, 'bad.json')
    await writeFile(file, '{not json', 'utf8')
    await expect(loadReviewLedger(file)).rejects.toBeInstanceOf(ReviewLedgerError)
  })
})

describe('loadRunRecords', () => {
  test('an absent evidence root yields zero runs', async () => {
    const dir = path.join(await tempDir('lt-runs-'), 'no-such-dir')
    await expect(loadRunRecords(dir)).resolves.toEqual([])
  })

  test('loads runs, derives timeout/completeness flags, and skips malformed bundles', async () => {
    const root = await tempDir('lt-evidence-')
    await writeBundle(root, 'LT-A-001', 'run-ok', {
      verdict: 'pass',
      started_at: '2026-08-27T00:00:00.000Z',
      finished_at: '2026-08-27T00:02:00.000Z',
      evidence: { missing: [] },
      hard_stops: [],
      errors: [],
    })
    await writeBundle(root, 'LT-A-002', 'run-timeout', {
      verdict: 'fail',
      evidence: { missing: ['events'] },
      hard_stops: [],
      errors: ['action: command slow exceeded its timeout'],
    }, { commands: [{ kind: 'command', name: 'slow', timed_out: true, exit_code: null }] })
    // Malformed bundle: no parseable run.json -> skipped deterministically.
    const badDir = path.join(root, 'LT-A-003', 'run-bad')
    await mkdir(badDir, { recursive: true })
    await writeFile(path.join(badDir, 'run.json'), '{broken', 'utf8')

    const records = await loadRunRecords(root)
    expect(records).toHaveLength(2)
    const ok = records.find(record => record.runId === 'run-ok')
    const timedOut = records.find(record => record.runId === 'run-timeout')
    expect(ok).toMatchObject({ scenarioId: 'LT-A-001', verdict: 'pass', evidenceComplete: true, timedOut: false, durationMs: 120_000, risk: 'unknown' })
    expect(timedOut).toMatchObject({ scenarioId: 'LT-A-002', verdict: 'fail', timedOut: true, evidenceComplete: false, missingEvidence: ['events'] })
    // Records are deterministically ordered by scenario id then run id.
    expect(records.map(record => record.runId)).toEqual(['run-ok', 'run-timeout'])
  })

  test('joins risk/kind/tags from scenario files when a scenario root is supplied', async () => {
    const root = await tempDir('lt-evidence-')
    await writeBundle(root, 'LT-META-001', 'run-1', { verdict: 'pass', evidence: { missing: [] } })
    const scenarioRoot = await tempDir('lt-scenarios-')
    await writeFile(path.join(scenarioRoot, 'LT-META-001.json'), JSON.stringify({
      version: 1,
      id: 'LT-META-001',
      title: 'meta scenario',
      risk: 'critical',
      kind: 'deterministic',
      tags: ['meta', 'read_only'],
      preconditions: [],
      setup: [],
      actions: [{ name: 'noop', do: 'nothing' }],
      hard_assertions: [],
      evidence_required: ['run'],
      llm_review: 'never',
      expected_user_outcome: 'x',
      cleanup: 'delete_disposable_workspace',
    }), 'utf8')
    const records = await loadRunRecords(root, { scenarioRoot })
    expect(records[0]).toMatchObject({ risk: 'critical', kind: 'deterministic', tags: ['meta', 'read_only'] })
  })
})

describe('buildSuiteReport end to end', () => {
  test('aggregates a fixture bundle tree and evaluates gates explicitly', async () => {
    const evidenceRoot = await tempDir('lt-evidence-')
    await writeBundle(evidenceRoot, 'LT-EXAMPLE-001', 'run-pass', {
      verdict: 'pass',
      started_at: '2026-08-27T00:00:00.000Z',
      finished_at: '2026-08-27T00:01:00.000Z',
      evidence: { required: ['run', 'command_log'], missing: [] },
      hard_stops: [],
      errors: [],
    })

    const report = await buildSuiteReport(evidenceRoot, { scenarioRoot: path.join(REPO_ROOT, 'validation', 'scenarios') })
    expect(report.metrics.total_executions).toBe(1)
    expect(report.metrics.hard_pass_rate).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.metrics.evidence_completeness_rate.rate).toBe(1)
    expect(report.metrics.timeout_rate.rate).toBe(0)
    expect(report.metrics.llm_candidate_count).toBe(0)
    // The example scenario is risk medium: gate 1 has no gated runs and fails
    // with an explicit reason rather than silently passing.
    const gate1 = report.release_gates.gates.find(gate => gate.gate === 'critical_high_deterministic_pass')
    expect(gate1?.verdict).toBe('fail')
    expect(gate1?.reasons[0]).toContain('no critical/high deterministic')
    expect(report.release_gates.gates.find(gate => gate.gate === 'no_external_effect_violation')?.verdict).toBe('pass')
    expect(report.release_gates.gates.find(gate => gate.gate === 'no_unreviewed_hard_failures')?.verdict).toBe('pass')
    // Risk/kind were joined from the real versioned scenario file.
    expect(report.runs).toEqual([{ scenario_id: 'LT-EXAMPLE-001', run_id: 'run-pass', verdict: 'pass', risk: 'medium', kind: 'deterministic' }])
  })

  test('deterministic triage counts a failed run as one candidate and gates fail without review', async () => {
    const evidenceRoot = await tempDir('lt-evidence-')
    const workspace = await tempDir('lt-work-')
    // A failing run with a failed assertion outcome: the deterministic
    // triager classifies it candidate_bug, so it counts as one candidate.
    await writeBundle(evidenceRoot, 'LT-FAIL-001', 'run-fail', {
      verdict: 'fail',
      started_at: '2026-08-27T00:00:00.000Z',
      finished_at: '2026-08-27T00:01:00.000Z',
      evidence: { required: ['run'], missing: [] },
      hard_stops: [],
      errors: [],
    }, {
      assertions: { outcomes: [{ id: 'HA-1', oracle: 'goal_state_equals', status: 'fail', expected: 'SUCCEEDED', actual: 'RUNNING', detail: 'goal.state is RUNNING' }] },
    })

    const report = await buildSuiteReport(evidenceRoot, { skipTriage: false })
    expect(report.metrics.llm_candidate_count).toBe(1)
    expect(report.metrics.hard_pass_rate.rate).toBe(0)
    expect(report.metrics.failure_rate_by_risk.unknown).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    const gates = Object.fromEntries(report.release_gates.gates.map(gate => [gate.gate, gate.verdict]))
    expect(gates.critical_high_deterministic_pass).toBe('fail')
    expect(gates.no_unreviewed_hard_failures).toBe('fail')
    expect(gates.no_external_effect_violation).toBe('pass')
    expect(report.release_gates.verdict).toBe('fail')

    // With a confirming review the candidate confirmation flips and gate 2 passes.
    const ledgerFile = path.join(workspace, 'reviews.json')
    await writeFile(ledgerFile, JSON.stringify({ reviews: [{ run_id: 'run-fail', outcome: 'confirmed_bug', reproduction_time_ms: 60_000, permanent_scenario_id: 'LT-REG-001' }] }), 'utf8')
    const reviewed = await buildSuiteReport(evidenceRoot, { reviewLedgerFile: ledgerFile })
    expect(reviewed.metrics.candidate_confirmation_rate).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(reviewed.metrics.median_reproduction_time_ms).toBe(60_000)
    expect(reviewed.metrics.permanent_scenarios_added).toEqual({ count: 1, scenario_ids: ['LT-REG-001'] })
    expect(reviewed.release_gates.gates.find(gate => gate.gate === 'no_unreviewed_hard_failures')?.verdict).toBe('pass')
  })

  test('an empty evidence root reports zeroed metrics without crashing', async () => {
    const evidenceRoot = await tempDir('lt-evidence-empty-')
    const report = await buildSuiteReport(evidenceRoot, {})
    expect(report.metrics.total_executions).toBe(0)
    expect(report.metrics.hard_pass_rate.rate).toBe(0)
    expect(report.metrics.median_reproduction_time_ms).toBeNull()
    expect(report.runs).toEqual([])
    const json = JSON.stringify(report)
    expect(json).not.toContain('NaN')
  })
})
