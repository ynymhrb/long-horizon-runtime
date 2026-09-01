/**
 * Focused self-tests for the incident triage module (validation/triage/).
 *
 * Proves the output contract of the implement-triage-module task:
 *   - runner and triager prompts match the handbook verbatim
 *   - the triage contract validator enforces required keys, enums and the
 *     three-hypothesis cap
 *   - the deterministic no-LLM fallback triages representative failing,
 *     inconclusive, hard-stop, command-error and passing evidence bundles
 *     into contract-valid reports with the handbook's verdict mapping
 *   - an optional analyzer is contract-checked and never crashes a run
 *   - no network or external LLM call occurs during deterministic runs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { loadEvidenceBundle, summarizeBundle } from '../validation/triage/bundle.mjs'
import {
  MAX_HYPOTHESES,
  TRIAGE_CONFIDENCES,
  TRIAGE_VERDICTS,
  TriageContractError,
  triageContractProblems,
  triageContractSkeleton,
  validateTriageReport,
} from '../validation/triage/contract.mjs'
import { RUNNER_PROMPT, TRIAGER_PROMPT } from '../validation/triage/prompts.mjs'
import { deterministicFallbackReport, triageBundle, triageEvidence } from '../validation/triage/triager.mjs'

const REPO_ROOT = path.resolve(__dirname, '..')
const HANDBOOK = path.join(REPO_ROOT, 'docs', 'superpowers', 'specs', '2026-08-27-long-task-production-validation-handbook.md')

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

type Outcome = { id: string; status: string; oracle: string; expected: unknown; actual: unknown; detail: string; check?: string }

function commandRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'command', name: 'create-goal', command: 'node validation/runner/harness.mjs create-goal', cwd: '.', exit_code: 0, duration_ms: 12, timed_out: false, ...overrides }
}

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scenario_id: 'LT-TEST-001',
    scenario_version: 1,
    run_id: 'run-1',
    verdict: 'pass',
    started_at: '2026-08-27T00:00:00.000Z',
    finished_at: '2026-08-27T00:00:01.000Z',
    command_versions: { node: 'v22' },
    evidence: { required: ['run'], missing: [] },
    hard_stops: [],
    errors: [],
    ...overrides,
  }
}

/** Write one complete evidence bundle directory; returns its path. */
async function writeBundle(input: {
  run: Record<string, unknown>
  commands?: Record<string, unknown>[]
  task?: Record<string, unknown>
  events?: { type?: string; seq?: number }[]
  snapshot?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  assertions?: Record<string, unknown>
  environment?: Record<string, unknown>
}): Promise<string> {
  const dir = await tempDir('lt-triage-bundle-')
  const commands = input.commands ?? [commandRow()]
  const events = input.events ?? [{ seq: 1, type: 'GoalCreated' }, { seq: 2, type: 'TaskAttemptStarted' }, { seq: 3, type: 'TaskCompleted' }, { seq: 4, type: 'GoalSucceeded' }]
  const writes: Array<[string, string]> = [
    ['run.json', JSON.stringify(input.run)],
    ['commands.ndjson', commands.map(row => JSON.stringify(row)).join('\n') + '\n'],
    ['task.json', JSON.stringify(input.task ?? { goals: [{ id: 'lt_a', state: 'SUCCEEDED', revision: 1 }], count: 1 })],
    ['events.json', JSON.stringify({ events, count: events.length })],
    ['snapshot.json', JSON.stringify(input.snapshot ?? { goal: { id: 'lt_a', state: 'SUCCEEDED' } })],
    ['artifacts.json', JSON.stringify(input.artifacts ?? { artifacts: [], count: 0 })],
    ['assertions.json', JSON.stringify(input.assertions ?? { scenario_id: input.run.scenario_id, run_id: input.run.run_id, outcomes: [], summary: 'pass' })],
    ['environment.json', JSON.stringify(input.environment ?? { workspace: '<redacted>' })],
  ]
  for (const [name, text] of writes) await writeFile(path.join(dir, name), text, 'utf8')
  return dir
}

describe('triage prompts match the handbook verbatim', () => {
  test('runner prompt is the handbook block quote, word for word', async () => {
    const handbook = await readFile(HANDBOOK, 'utf8')
    expect(handbook).toContain(`Runner prompt:\n\n> ${RUNNER_PROMPT.split('\n').join('\n> ')}`)
  })

  test('triager prompt is the handbook block quote, word for word', async () => {
    const handbook = await readFile(HANDBOOK, 'utf8')
    expect(handbook).toContain(`Triager prompt:\n\n> ${TRIAGER_PROMPT.split('\n').join('\n> ')}`)
  })

  test('prompts carry the safety clauses the handbook requires', () => {
    expect(RUNNER_PROMPT.replace(/\s+/g, ' ')).toContain('Abort immediately if an external effect is planned or attempted.')
    expect(RUNNER_PROMPT).toContain('Do not diagnose or fix failures.')
    expect(TRIAGER_PROMPT).toContain('read-only incident triager')
    expect(TRIAGER_PROMPT.replace(/\s+/g, ' ')).toContain('Do not propose code changes, run commands, accept replans, or claim a bug is confirmed.')
    expect(TRIAGER_PROMPT).toContain('insufficient_evidence')
  })
})

describe('triage contract validation', () => {
  test('the contract skeleton is itself contract-valid', () => {
    expect(triageContractProblems(triageContractSkeleton())).toEqual([])
    expect(validateTriageReport(triageContractSkeleton())).toMatchObject({ verdict: 'insufficient_evidence', stop_reason: null })
  })

  test('accepts the handbook example shape with every section populated', () => {
    const report = {
      verdict: 'candidate_bug',
      earliest_anomaly: { evidence_id: 'events.json#123', timestamp: '2026-08-27T00:00:00.000Z', observation: 'A concise observable discrepancy.' },
      hypotheses: [{ title: 'Falsifiable one-line statement', confidence: 'medium', evidence: ['events.json#123', 'assertions.json#4'], minimal_reproduction: ['step 1', 'step 2'], automatable_oracle: 'Exact assertion that would confirm or refute it' }],
      usability_findings: [{ user_goal: 'What the user was trying to do', friction: 'Observed obstacle, not a preference', observable_evidence: 'screenshots/failed.png', suggested_validation: 'A concrete follow-up check' }],
      stop_reason: null,
    }
    expect(triageContractProblems(report)).toEqual([])
  })

  test('rejects a non-object report and reports every missing key', () => {
    expect(triageContractProblems(null)).toEqual(['report must be a JSON object at the top level'])
    const problems = triageContractProblems({})
    for (const key of ['verdict', 'earliest_anomaly', 'hypotheses', 'usability_findings', 'stop_reason']) {
      expect(problems).toContain(`missing required key: ${key}`)
    }
  })

  test('enforces the verdict and confidence enums', () => {
    const problems = triageContractProblems({ ...triageContractSkeleton(), verdict: 'bug', hypotheses: [{ title: 'x', confidence: 'certain', evidence: [], minimal_reproduction: [], automatable_oracle: 'y' }] })
    expect(problems.some(problem => problem.startsWith('verdict must be one of'))).toBe(true)
    expect(problems.some(problem => problem.includes('confidence must be one of'))).toBe(true)
    expect(TRIAGE_VERDICTS).toEqual(['candidate_bug', 'likely_test_issue', 'insufficient_evidence'])
    expect(TRIAGE_CONFIDENCES).toEqual(['low', 'medium', 'high'])
  })

  test('caps hypotheses at three, per the handbook', () => {
    expect(MAX_HYPOTHESES).toBe(3)
    const hypothesis = { title: 'x', confidence: 'low', evidence: ['events.json#1'], minimal_reproduction: ['s'], automatable_oracle: 'o' }
    const problems = triageContractProblems({ ...triageContractSkeleton(), hypotheses: [hypothesis, hypothesis, hypothesis, hypothesis] })
    expect(problems.some(problem => problem.includes('at most 3'))).toBe(true)
  })

  test('validateTriageReport throws a TriageContractError listing problems', () => {
    try {
      validateTriageReport({ verdict: 'nope' }, 'test report')
      expect.unreachable('must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(TriageContractError)
      expect((error as TriageContractError).problems.length).toBeGreaterThan(0)
      expect((error as TriageContractError).source).toBe('test report')
    }
  })
})

describe('deterministic no-LLM triage of evidence bundles', () => {
  test('a failing bundle (failed assertion) yields a low-confidence candidate_bug citing evidence', async () => {
    const outcome: Outcome = { id: 'HA-1', status: 'fail', oracle: 'goal_state_equals', expected: 'SUCCEEDED', actual: 'PAUSED', detail: 'goal state "PAUSED" != "SUCCEEDED"', check: 'goal succeeds' }
    const dir = await writeBundle({
      run: baseRun({ verdict: 'fail' }),
      assertions: { scenario_id: 'LT-TEST-001', run_id: 'run-1', outcomes: [outcome], summary: 'fail' },
      events: [{ seq: 1, type: 'GoalCreated' }, { seq: 2, type: 'TaskAttemptFailed' }],
    })
    const report = await triageBundle(dir)
    expect(triageContractProblems(report)).toEqual([])
    expect(report.verdict).toBe('candidate_bug')
    expect(report.earliest_anomaly?.evidence_id).toMatch(/^(events|assertions)\.json#/)
    expect(report.hypotheses).toHaveLength(1)
    expect(report.hypotheses[0]?.confidence).toBe('low')
    expect(report.hypotheses[0]?.evidence.length).toBeGreaterThan(0)
  })

  test('an inconclusive bundle (missing evidence) yields insufficient_evidence, never an invented cause', async () => {
    const dir = await writeBundle({
      run: baseRun({ verdict: 'inconclusive', evidence: { required: ['run', 'events'], missing: ['events'] } }),
      assertions: { scenario_id: 'LT-TEST-001', run_id: 'run-1', outcomes: [{ id: 'HA-1', status: 'unevaluated', oracle: 'event_present', expected: 'x', actual: null, detail: 'events.json missing', check: 'c' }], summary: 'unevaluated' },
    })
    const report = await triageBundle(dir)
    expect(triageContractProblems(report)).toEqual([])
    expect(report.verdict).toBe('insufficient_evidence')
    expect(report.hypotheses).toEqual([])
    expect(report.earliest_anomaly?.observation).toContain('inconclusive')
  })

  test('a hard_stop bundle yields a high-confidence candidate_bug with stop_reason', async () => {
    const outcome: Outcome = { id: 'HA-9', status: 'fail', oracle: 'no_external_effect', expected: 'no sideEffectClass external_effect anywhere in the evidence', actual: [{ evidence_id: 'events.json#7', path: 'payload.sideEffectClass' }], detail: '1 external-effect occurrence(s) in evidence', check: 'no external effect' }
    const dir = await writeBundle({
      run: baseRun({ verdict: 'hard_stop', hard_stops: ['assertion HA-9 observed an external effect in evidence'] }),
      assertions: { scenario_id: 'LT-TEST-001', run_id: 'run-1', outcomes: [outcome], summary: 'fail' },
      events: [{ seq: 1, type: 'GoalCreated' }, { seq: 7, type: 'PlanProposed' }],
    })
    const report = await triageBundle(dir)
    expect(triageContractProblems(report)).toEqual([])
    expect(report.verdict).toBe('candidate_bug')
    expect(report.hypotheses[0]?.confidence).toBe('high')
    expect(report.stop_reason).toContain('external effect')
    expect(report.earliest_anomaly?.evidence_id).toBe('events.json#7')
  })

  test('a hard_stop verdict without recorded stop detail is still a candidate_bug (defense in depth)', async () => {
    const dir = await writeBundle({ run: baseRun({ verdict: 'hard_stop', hard_stops: [] }) })
    const report = await triageBundle(dir)
    expect(triageContractProblems(report)).toEqual([])
    expect(report.verdict).toBe('candidate_bug')
    expect(report.stop_reason).not.toBeNull()
  })

  test('a failing bundle with a broken command and no assertions yields likely_test_issue', async () => {
    const dir = await writeBundle({
      run: baseRun({ verdict: 'fail', errors: ['execute: command create-goal exited 1, expected 0'] }),
      commands: [commandRow({ exit_code: 1, name: 'create-goal' })],
    })
    const report = await triageBundle(dir)
    expect(triageContractProblems(report)).toEqual([])
    expect(report.verdict).toBe('likely_test_issue')
    expect(report.earliest_anomaly?.evidence_id).toBe('commands.ndjson#1')
    expect(report.hypotheses[0]?.confidence).toBe('medium')
  })

  test('a passing bundle yields an empty insufficient_evidence report (nothing to claim)', async () => {
    const dir = await writeBundle({ run: baseRun({ verdict: 'pass' }) })
    const report = await triageBundle(dir)
    expect(report).toEqual(triageContractSkeleton())
    expect(report.verdict).toBe('insufficient_evidence')
    expect(report.hypotheses).toEqual([])
    expect(report.usability_findings).toEqual([])
    expect(report.stop_reason).toBeNull()
  })

  test('the fallback is deterministic: same bundle, byte-for-byte identical report', async () => {
    const outcome: Outcome = { id: 'HA-1', status: 'fail', oracle: 'goal_state_equals', expected: 'SUCCEEDED', actual: 'PAUSED', detail: 'mismatch', check: 'c' }
    const dir = await writeBundle({
      run: baseRun({ verdict: 'fail' }),
      assertions: { scenario_id: 'LT-TEST-001', run_id: 'run-1', outcomes: [outcome], summary: 'fail' },
    })
    const first = await triageBundle(dir)
    const second = await triageBundle(dir)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  test('triageEvidence consumes an already-loaded bundle and summarizeBundle stays JSON-safe', async () => {
    const dir = await writeBundle({ run: baseRun({ verdict: 'fail' }), commands: [commandRow({ exit_code: 2, name: 'run-goal' })] })
    const bundle = await loadEvidenceBundle(dir)
    const report = await triageEvidence(bundle)
    expect(triageContractProblems(report)).toEqual([])
    expect(report.verdict).toBe('likely_test_issue')
    const summary = summarizeBundle(bundle)
    expect(() => JSON.stringify(summary)).not.toThrow()
    expect(summary.scenario_id).toBe('LT-TEST-001')
  })
})

describe('optional analyzer behavior (outside deterministic runs)', () => {
  test('a contract-valid analyzer report is used instead of the fallback', async () => {
    const dir = await writeBundle({ run: baseRun({ verdict: 'fail', errors: ['execute: boom'] }), commands: [commandRow({ exit_code: 1 })] })
    const llmReport = {
      verdict: 'candidate_bug',
      earliest_anomaly: { evidence_id: 'events.json#2', timestamp: '2026-08-27T00:00:00.500Z', observation: 'LLM-observed discrepancy.' },
      hypotheses: [{ title: 'LLM hypothesis', confidence: 'high', evidence: ['events.json#2'], minimal_reproduction: ['step 1'], automatable_oracle: 'oracle' }],
      usability_findings: [],
      stop_reason: null,
    }
    const report = await triageBundle(dir, { analyze: () => llmReport })
    expect(report).toEqual(llmReport)
  })

  test('a contract-violating analyzer report is discarded for the deterministic fallback', async () => {
    const dir = await writeBundle({ run: baseRun({ verdict: 'fail', errors: ['execute: boom'] }), commands: [commandRow({ exit_code: 1 })] })
    const report = await triageBundle(dir, { analyze: () => ({ verdict: 'definitely_a_bug' }) })
    expect(report.verdict).toBe('likely_test_issue')
    expect(triageContractProblems(report)).toEqual([])
  })

  test('a throwing analyzer never breaks the run; the fallback stands', async () => {
    const dir = await writeBundle({ run: baseRun({ verdict: 'pass' }) })
    const report = await triageBundle(dir, {
      analyze: () => {
        throw new Error('llm backend unreachable')
      },
    })
    expect(report).toEqual(triageContractSkeleton())
  })
})
