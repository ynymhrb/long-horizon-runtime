/**
 * Focused self-tests for the deterministic scenario runner (validation/runner/).
 *
 * Proves the output contract of the implement-scenario-runner task:
 *   - contract validation rejects missing fields and non-read_only scenarios
 *   - the evidence writer produces the 8 required evidence files before cleanup
 *   - missing required evidence forces an inconclusive verdict, never pass
 *   - evidence is captured before the disposable workspace is deleted
 *   - environment.json carries no secrets
 *   - a detected external effect hard-stops the run
 *   - one example scenario produces a complete contract-compliant bundle
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { evaluateAssertion, summarizeAssertions, type AssertionOutcome } from '../validation/runner/assertions.mjs'
import { loadScenarioFile, ScenarioContractError, validateScenario } from '../validation/runner/contract.mjs'
import { redactSecrets, sanitizeEnvironment } from '../validation/runner/evidence.mjs'
import { findFreePort, RESERVED_PORTS } from '../validation/runner/ports.mjs'
import { deriveVerdict, runScenario } from '../validation/runner/runner.mjs'
import { parseYaml, YamlParseError } from '../validation/runner/yaml.mjs'

const REPO_ROOT = path.resolve(__dirname, '..')
const EXAMPLE_SCENARIO = path.join(REPO_ROOT, 'validation', 'scenarios', 'examples', 'LT-EXAMPLE-001.yaml')
const SCENARIO_ROOT = path.join(REPO_ROOT, 'scenarios')
const FAULT_SCENARIO_DIR = path.join(SCENARIO_ROOT, 'fault-injection')

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

/** A minimal contract-valid read_only scenario document. */
function minimalScenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'LT-TEST-001',
    title: 'contract test scenario',
    risk: 'low',
    kind: 'deterministic',
    tags: ['test', 'read_only'],
    preconditions: ['fresh durable database'],
    setup: [],
    actions: [{ name: 'noop', do: 'observe only' }],
    hard_assertions: [{ id: 'HA-1', check: 'task.json exists in the bundle', evaluate: { oracle: 'file_exists', file: 'task.json' } }],
    evidence_required: ['run', 'command_log', 'task', 'events', 'runtime_snapshot', 'artifacts', 'assertions', 'environment'],
    llm_review: 'never',
    expected_user_outcome: 'the contract is enforced',
    cleanup: 'delete_disposable_workspace',
    ...overrides,
  }
}

async function writeScenario(dir: string, doc: Record<string, unknown>, name = 'scenario.json'): Promise<string> {
  const file = path.join(dir, name)
  await writeFile(file, JSON.stringify(doc, null, 2), 'utf8')
  return file
}

describe('scenario contract validation', () => {
  test('accepts a minimal contract-valid read_only scenario', () => {
    const scenario = validateScenario(minimalScenario(), 'test')
    expect(scenario.id).toBe('LT-TEST-001')
    expect(scenario.kind).toBe('deterministic')
  })

  const REQUIRED_FIELDS = ['id', 'title', 'risk', 'kind', 'tags', 'preconditions', 'setup', 'actions', 'hard_assertions', 'evidence_required', 'llm_review', 'expected_user_outcome', 'cleanup']
  for (const field of REQUIRED_FIELDS) {
    test(`rejects a scenario missing the required field ${field}`, () => {
      const doc = minimalScenario()
      delete doc[field]
      try {
        validateScenario(doc, 'test')
        expect.unreachable(`missing ${field} must be rejected`)
      } catch (error) {
        expect(error).toBeInstanceOf(ScenarioContractError)
        expect((error as ScenarioContractError).problems.some(problem => problem.includes(field))).toBe(true)
      }
    })
  }

  test('reports every missing field at once', () => {
    try {
      validateScenario({ id: 'LT-TEST-002' }, 'test')
      expect.unreachable('must reject')
    } catch (error) {
      const problems = (error as ScenarioContractError).problems
      expect(problems.filter(problem => problem.startsWith('missing required field:')).length).toBe(REQUIRED_FIELDS.length - 1)
    }
  })

  test('rejects a scenario whose planned work is external_effect', () => {
    expect(() => validateScenario(minimalScenario({ side_effect_class: 'external_effect' }), 'test')).toThrowError(/read_only/)
  })

  test('rejects a scenario planning an external effect through fault injection', () => {
    const doc = minimalScenario({ fault_injection: { injected_fault: 'x', planned_side_effect_class: 'external_effect' } })
    expect(() => validateScenario(doc, 'test')).toThrowError(/read_only/)
  })

  test('rejects a scenario with no read_only declaration at all', () => {
    const doc = minimalScenario({ tags: ['test'] })
    expect(() => validateScenario(doc, 'test')).toThrowError(/read_only/)
  })

  test('rejects a scenario action that declares an external effect', () => {
    const doc = minimalScenario({ actions: [{ name: 'evil', do: 'send a message', side_effect_class: 'external_effect' }] })
    expect(() => validateScenario(doc, 'test')).toThrowError(ScenarioContractError)
  })

  test('accepts read_only declared through fault_injection.planned_side_effect_class', () => {
    const doc = minimalScenario({ kind: 'fault_injection', tags: ['test'], fault_injection: { injected_fault: 'x', planned_side_effect_class: 'read_only' } })
    expect(validateScenario(doc, 'test').kind).toBe('fault_injection')
  })

  test('rejects invalid risk, kind and llm_review values', () => {
    expect(() => validateScenario(minimalScenario({ risk: 'extreme' }), 'test')).toThrowError(/risk/)
    expect(() => validateScenario(minimalScenario({ kind: 'chaos' }), 'test')).toThrowError(/kind/)
    expect(() => validateScenario(minimalScenario({ llm_review: 'sometimes' }), 'test')).toThrowError(/llm_review/)
  })

  test('rejects empty actions and unknown evidence items', () => {
    expect(() => validateScenario(minimalScenario({ actions: [] }), 'test')).toThrowError(/actions/)
    expect(() => validateScenario(minimalScenario({ evidence_required: ['vibes'] }), 'test')).toThrowError(/evidence_required/)
  })

  test('rejects a UI scenario that does not require screenshots', () => {
    const doc = minimalScenario({ kind: 'exploratory_ui' })
    expect(() => validateScenario(doc, 'test')).toThrowError(/screenshots/)
    const ok = validateScenario(minimalScenario({ kind: 'exploratory_ui', evidence_required: [...(minimalScenario().evidence_required as string[]), 'screenshots'] }), 'test')
    expect(ok.kind).toBe('exploratory_ui')
  })

  test('rejects assertions without an id or check', () => {
    expect(() => validateScenario(minimalScenario({ hard_assertions: [{ evaluate: { oracle: 'file_exists', file: 'task.json' } }] }), 'test')).toThrowError(/hard_assertions/)
    expect(() => validateScenario(minimalScenario({ hard_assertions: [{ id: 'HA-1' }] }), 'test')).toThrowError(/hard_assertions/)
  })

  test('loads JSON and YAML scenario files equivalently', async () => {
    const dir = await tempDir('lt-scenario-format-')
    const jsonFile = await writeScenario(dir, minimalScenario())
    const yamlFile = path.join(dir, 'scenario.yaml')
    await writeFile(yamlFile, [
      'version: 1',
      'id: LT-TEST-001',
      'title: contract test scenario',
      'risk: low',
      'kind: deterministic',
      'tags: [test, read_only]',
      'preconditions:',
      '  - fresh durable database',
      'setup: []',
      'actions:',
      '  - name: noop',
      '    do: observe only',
      'hard_assertions:',
      '  - id: HA-1',
      '    check: task.json exists',
      '    evaluate:',
      '      oracle: file_exists',
      '      file: task.json',
      'evidence_required: [run, command_log]',
      'llm_review: never',
      'expected_user_outcome: the contract is enforced',
      'cleanup: delete_disposable_workspace',
      '',
    ].join('\n'), 'utf8')
    const fromJson = await loadScenarioFile(jsonFile)
    const fromYaml = await loadScenarioFile(yamlFile)
    expect(fromYaml.id).toBe(fromJson.id)
    expect(fromYaml.tags).toEqual(['test', 'read_only'])
    expect(fromYaml.actions[0]?.name).toBe('noop')
  })

  test('rejects an unparseable scenario file with a contract error', async () => {
    const dir = await tempDir('lt-scenario-broken-')
    const file = path.join(dir, 'broken.json')
    await writeFile(file, '{ not json', 'utf8')
    await expect(loadScenarioFile(file)).rejects.toBeInstanceOf(ScenarioContractError)
  })

  test('every shipped scenario file passes contract validation', async () => {
    const example = await loadScenarioFile(EXAMPLE_SCENARIO)
    expect(example.id).toBe('LT-EXAMPLE-001')

    // Handbook suite inventory: 20 state/safety/recovery (LT-STATE-001..014,
    // LT-RECOVERY-001..006), 10 fault-injection (LT-FAULT-001..010), 5 UI
    // (LT-UI-001..005). Every file must load under the contract and carry the
    // expected id pattern and kind for its directory.
    const suite: Record<string, { kind: string; count: number; idPrefix: RegExp }> = {
      'state-recovery': { kind: 'deterministic', count: 20, idPrefix: /^LT-(?:STATE|RECOVERY)-\d{3}$/ },
      'fault-injection': { kind: 'fault_injection', count: 10, idPrefix: /^LT-FAULT-\d{3}$/ },
      'ui': { kind: 'exploratory_ui', count: 5, idPrefix: /^LT-UI-\d{3}$/ },
    }
    const expectedIds = [
      ...Array.from({ length: 14 }, (_, i) => `LT-STATE-${String(i + 1).padStart(3, '0')}`),
      ...Array.from({ length: 6 }, (_, i) => `LT-RECOVERY-${String(i + 1).padStart(3, '0')}`),
      ...Array.from({ length: 10 }, (_, i) => `LT-FAULT-${String(i + 1).padStart(3, '0')}`),
      ...Array.from({ length: 5 }, (_, i) => `LT-UI-${String(i + 1).padStart(3, '0')}`),
    ]
    const seen: string[] = []
    for (const [dir, spec] of Object.entries(suite)) {
      const files = (await readdir(path.join(SCENARIO_ROOT, dir))).filter(name => name.endsWith('.yaml')).sort()
      expect(files.length).toBe(spec.count)
      for (const name of files) {
        const scenario = await loadScenarioFile(path.join(SCENARIO_ROOT, dir, name))
        expect(scenario.id).toMatch(spec.idPrefix)
        expect(scenario.kind).toBe(spec.kind)
        expect(seen).not.toContain(scenario.id)
        seen.push(scenario.id)
      }
    }
    expect([...seen].sort()).toEqual([...expectedIds].sort())
  })
})

describe('yaml subset parser', () => {
  test('parses nested mappings, sequences of maps, flow lists and typed scalars', () => {
    const doc = parseYaml([
      'version: 1',
      'risk: high',
      'timeout: 1.5',
      'enabled: true',
      'nothing: null',
      'tags: [a, "b", 3]',
      'empty_list: []',
      'actions:',
      '  - name: first',
      '    step: 1',
      '  - name: second',
      '    run:',
      '      command: echo hi',
      'fault_injection:',
      '  injected_fault: broken',
      '  planned_side_effect_class: read_only',
    ].join('\n')) as Record<string, unknown>
    expect(doc.version).toBe(1)
    expect(doc.risk).toBe('high')
    expect(doc.timeout).toBe(1.5)
    expect(doc.enabled).toBe(true)
    expect(doc.nothing).toBeNull()
    expect(doc.tags).toEqual(['a', 'b', 3])
    expect(doc.empty_list).toEqual([])
    expect(doc.actions).toEqual([
      { name: 'first', step: 1 },
      { name: 'second', run: { command: 'echo hi' } },
    ])
    expect(doc.fault_injection).toEqual({ injected_fault: 'broken', planned_side_effect_class: 'read_only' })
  })

  test('folds wrapped plain scalars and strips comments', () => {
    const doc = parseYaml([
      'check: The goal reaches a durable state after the   # trailing comment',
      '  read_only run completes.',
      '# full-line comment',
      'title: "quoted # not a comment"',
    ].join('\n')) as Record<string, unknown>
    expect(doc.check).toBe('The goal reaches a durable state after the read_only run completes.')
    expect(doc.title).toBe('quoted # not a comment')
  })

  test('parses literal and folded block scalars', () => {
    const doc = parseYaml(['literal: |', '  line one', '  line two', 'folded: >', '  part one', '  part two'].join('\n')) as Record<string, unknown>
    expect(doc.literal).toBe('line one\nline two\n')
    expect(doc.folded).toBe('part one part two\n')
  })

  test('rejects garbage with a line-numbered error', () => {
    expect(() => parseYaml('just a bare scalar line\nanother: map')).toThrowError(YamlParseError)
    expect(() => parseYaml('key: [unterminated')).toThrowError(YamlParseError)
    expect(() => parseYaml('\tbad: tab indent')).toThrowError(YamlParseError)
  })
})

describe('verdict logic', () => {
  const passing: AssertionOutcome = { id: 'HA-1', status: 'pass', oracle: 'file_exists', expected: 'task.json', actual: 'task.json', detail: '', check: '' }
  const failing: AssertionOutcome = { ...passing, id: 'HA-2', status: 'fail' }
  const pending: AssertionOutcome = { ...passing, id: 'HA-3', status: 'unevaluated' }

  test('passes only when assertions pass, evidence is complete and nothing errored', () => {
    expect(deriveVerdict({ assertionOutcomes: [passing], errors: [], hardStops: [], missingEvidence: [] })).toBe('pass')
  })

  test('a failed assertion fails the run', () => {
    expect(deriveVerdict({ assertionOutcomes: [passing, failing], errors: [], hardStops: [], missingEvidence: [] })).toBe('fail')
  })

  test('missing required evidence forces inconclusive even when every assertion passed', () => {
    expect(deriveVerdict({ assertionOutcomes: [passing], errors: [], hardStops: [], missingEvidence: ['events'] })).toBe('inconclusive')
  })

  test('an unevaluated assertion forces inconclusive, never pass', () => {
    expect(deriveVerdict({ assertionOutcomes: [passing, pending], errors: [], hardStops: [], missingEvidence: [] })).toBe('inconclusive')
  })

  test('a detected external effect is a hard stop above every other outcome', () => {
    expect(deriveVerdict({ assertionOutcomes: [failing], errors: ['boom'], hardStops: ['external effect observed'], missingEvidence: [] })).toBe('hard_stop')
  })

  test('run errors fail the run', () => {
    expect(deriveVerdict({ assertionOutcomes: [passing], errors: ['timeout'], hardStops: [], missingEvidence: [] })).toBe('fail')
  })

  test('summarizeAssertions folds fail over unevaluated over pass', () => {
    expect(summarizeAssertions([passing])).toBe('pass')
    expect(summarizeAssertions([passing, pending])).toBe('unevaluated')
    expect(summarizeAssertions([pending, failing])).toBe('fail')
  })
})

describe('runner end to end', () => {
  test('executes the example scenario into a complete contract-compliant bundle and cleans the workspace', async () => {
    const evidenceRoot = await tempDir('lt-evidence-')
    const result = await runScenario({ scenarioFile: EXAMPLE_SCENARIO, evidenceRoot, repoRoot: REPO_ROOT, commandVersions: { node: process.version } })

    expect(result.verdict).toBe('pass')
    expect(result.missingEvidence).toEqual([])
    expect(result.assertions.map(outcome => outcome.status)).toEqual(result.assertions.map(() => 'pass'))

    // The 8 required evidence files exist.
    for (const file of ['run.json', 'commands.ndjson', 'task.json', 'events.json', 'snapshot.json', 'artifacts.json', 'assertions.json', 'environment.json']) {
      const fileStat = await stat(path.join(result.evidenceDir, file))
      expect(fileStat.isFile()).toBe(true)
    }

    // task.json records the durable goal; events.json shows the ordered audit trail.
    const task = JSON.parse(await readFile(path.join(result.evidenceDir, 'task.json'), 'utf8')) as { goals: { id: string; state: string }[] }
    expect(task.goals).toHaveLength(1)
    expect(task.goals[0]?.id).toMatch(/^lt_/)
    expect(task.goals[0]?.state).toBe('SUCCEEDED')
    const events = JSON.parse(await readFile(path.join(result.evidenceDir, 'events.json'), 'utf8')) as { events: { type: string }[] }
    const types = events.events.map(event => event.type)
    expect(types.indexOf('GoalCreated')).toBeLessThan(types.indexOf('PlanRevisionApplied'))
    expect(types.indexOf('PlanRevisionApplied')).toBeLessThan(types.indexOf('TaskAttemptStarted'))

    // commands.ndjson records both shell exit codes.
    const commands = (await readFile(path.join(result.evidenceDir, 'commands.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { name: string; exit_code: number })
    expect(commands.map(command => command.name)).toEqual(['create_goal', 'run_until_idle'])
    expect(commands.every(command => command.exit_code === 0)).toBe(true)

    // run.json carries the verdict, timestamps and an inventory of every other file.
    const run = JSON.parse(await readFile(path.join(result.evidenceDir, 'run.json'), 'utf8')) as { verdict: string; started_at: string; finished_at: string; inventory: Record<string, { sha256: string }> }
    expect(run.verdict).toBe('pass')
    expect(Object.keys(run.inventory).sort()).toEqual(['artifacts.json', 'assertions.json', 'commands.ndjson', 'environment.json', 'events.json', 'snapshot.json', 'task.json'])

    // Evidence was captured before cleanup: the bundle outlives the workspace.
    await expect(stat(result.workspace)).rejects.toThrow()
    const environment = JSON.parse(await readFile(path.join(result.evidenceDir, 'environment.json'), 'utf8')) as { workspace: string }
    expect(environment.workspace).toBe(result.workspace)
  }, 60_000)

  test('forces inconclusive when a required evidence item is missing despite passing assertions', async () => {
    const dir = await tempDir('lt-missing-evidence-')
    const scenarioFile = await writeScenario(dir, minimalScenario({
      // screenshots can never be produced by a deterministic scenario, so the
      // required item will be missing at verdict time.
      evidence_required: ['run', 'command_log', 'task', 'events', 'runtime_snapshot', 'artifacts', 'assertions', 'environment', 'screenshots'],
    }))
    const evidenceRoot = await tempDir('lt-evidence-')
    const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT })
    expect(result.missingEvidence).toContain('screenshots')
    expect(result.assertions.every(outcome => outcome.status === 'pass')).toBe(true)
    expect(result.verdict).toBe('inconclusive')
    // The bundle is still complete for the review loop.
    await expect(stat(path.join(result.evidenceDir, 'run.json'))).resolves.toBeDefined()
    await expect(stat(path.join(result.evidenceDir, 'assertions.json'))).resolves.toBeDefined()
  }, 60_000)

  test('captures evidence before cleanup even when a command fails', async () => {
    const dir = await tempDir('lt-failing-command-')
    const scenarioFile = await writeScenario(dir, minimalScenario({
      actions: [{ name: 'boom', run: { command: 'node -e "process.exit(3)"', must_succeed: true } }],
    }))
    const evidenceRoot = await tempDir('lt-evidence-')
    const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT })
    expect(result.verdict).toBe('fail')
    expect(result.errors.some(error => error.includes('boom'))).toBe(true)
    for (const file of ['run.json', 'commands.ndjson', 'assertions.json', 'environment.json']) {
      await expect(stat(path.join(result.evidenceDir, file))).resolves.toBeDefined()
    }
    const commands = (await readFile(path.join(result.evidenceDir, 'commands.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { name: string; exit_code: number })
    expect(commands.find(command => command.name === 'boom')?.exit_code).toBe(3)
    await expect(stat(result.workspace)).rejects.toThrow()
  }, 60_000)

  test('hard-stops immediately when tool output reveals an external effect', async () => {
    const dir = await tempDir('lt-external-effect-')
    const scenarioFile = await writeScenario(dir, minimalScenario({
      actions: [
        { name: 'leak', run: { command: 'node -e "console.log(JSON.stringify({sideEffectClass:\\"external_effect\\"}))"' } },
        { name: 'never-reached', run: { command: 'node -e "process.exit(0)"' } },
      ],
    }))
    const evidenceRoot = await tempDir('lt-evidence-')
    const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT })
    expect(result.verdict).toBe('hard_stop')
    expect(result.hardStops.some(stop => stop.includes('leak'))).toBe(true)
    const commands = (await readFile(path.join(result.evidenceDir, 'commands.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { name: string })
    expect(commands.some(command => command.name === 'never-reached')).toBe(false)
    // Evidence is still complete for the incident record.
    for (const file of ['run.json', 'commands.ndjson', 'assertions.json', 'environment.json']) {
      await expect(stat(path.join(result.evidenceDir, file))).resolves.toBeDefined()
    }
  }, 60_000)

  test('marks narrative-only assertions unevaluated and the run inconclusive', async () => {
    const dir = await tempDir('lt-narrative-')
    const scenarioFile = await writeScenario(dir, minimalScenario({
      hard_assertions: [{ id: 'HA-1', check: 'the workflow feels clear' }],
    }))
    const evidenceRoot = await tempDir('lt-evidence-')
    const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT })
    expect(result.assertions[0]?.status).toBe('unevaluated')
    expect(result.verdict).toBe('inconclusive')
  }, 60_000)

  test('a command exceeding its timeout is a hard failure', async () => {
    const dir = await tempDir('lt-timeout-')
    const scenarioFile = await writeScenario(dir, minimalScenario({
      actions: [{ name: 'slow', run: { command: 'node -e "setTimeout(() => process.exit(0), 30000)"', timeout_ms: 500 } }],
    }))
    const evidenceRoot = await tempDir('lt-evidence-')
    const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT })
    expect(result.verdict).toBe('fail')
    expect(result.errors.some(error => error.includes('timeout'))).toBe(true)
  }, 60_000)

  test('redacts secrets from environment.json even when scenario-scoped variables look secret', async () => {
    const dir = await tempDir('lt-redaction-')
    const scenarioFile = await writeScenario(dir, minimalScenario())
    const evidenceRoot = await tempDir('lt-evidence-')
    process.env.LT_RUNNER_TEST_API_KEY = 'sk-testsecretkey1234567890'
    try {
      const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT })
      const raw = await readFile(path.join(result.evidenceDir, 'environment.json'), 'utf8')
      expect(raw).not.toContain('sk-testsecretkey1234567890')
      expect(raw).not.toContain('LT_RUNNER_TEST_API_KEY')
    } finally {
      delete process.env.LT_RUNNER_TEST_API_KEY
    }
  }, 60_000)
})

describe('new read_only harness fixture kinds (create-missing-scenarios)', () => {
  // The 8 versioned scenarios added by create-missing-scenarios exercise the
  // read_only fixture kinds and artifact-store flags the harness gained:
  //   LT-RECOVERY-006  executor 'interrupt'  (conversation stop -> INTERRUPTED)
  //   LT-FAULT-004     executor 'cannot-start' + planner 'static-retry'
  //                    (infrastructure fault, retry policy honored to budget)
  //   LT-FAULT-005     executor 'timeout'    (infrastructure fault, terminal)
  //   LT-FAULT-006     executor 'fail-once'  (validation failure -> auto replan)
  //   LT-FAULT-007     planner 'static-chain-required' + executor 'no-artifact'
  //                    (dependency stays undispatchable, no fabricated context)
  //   LT-FAULT-008     executor 'oversized' + --artifact-dir /
  //                    --artifact-inline-limit-bytes (file-backed artifact)
  //   LT-FAULT-009     harness 'verify-replay' exit-code oracle (idempotent,
  //                    ordered projection; non-zero when divergent)
  //   LT-FAULT-010     planner 'fail-on-replan' trigger-based (replan fails,
  //                    revision stays 1, goal paused)
  const NEW_FIXTURE_SCENARIOS: Array<[string, string]> = [
    ['LT-RECOVERY-006', 'state-recovery'],
    ['LT-FAULT-004', 'fault-injection'],
    ['LT-FAULT-005', 'fault-injection'],
    ['LT-FAULT-006', 'fault-injection'],
    ['LT-FAULT-007', 'fault-injection'],
    ['LT-FAULT-008', 'fault-injection'],
    ['LT-FAULT-009', 'fault-injection'],
    ['LT-FAULT-010', 'fault-injection'],
  ]

  for (const [scenarioId, subdir] of NEW_FIXTURE_SCENARIOS) {
    test(`${scenarioId} executes end to end through the runner and passes its hard oracle`, async () => {
      const evidenceRoot = await tempDir('lt-evidence-')
      const scenarioFile = path.join(REPO_ROOT, 'scenarios', subdir, `${scenarioId}.yaml`)
      const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot: REPO_ROOT, commandVersions: { node: process.version } })
      expect(result.verdict).toBe('pass')
      expect(result.missingEvidence).toEqual([])
      expect(result.hardStops).toEqual([])
      for (const file of ['run.json', 'commands.ndjson', 'task.json', 'events.json', 'snapshot.json', 'artifacts.json', 'assertions.json', 'environment.json']) {
        await expect(stat(path.join(result.evidenceDir, file))).resolves.toBeDefined()
      }
    }, 120_000)
  }
})

describe('assertion oracles', () => {
  test('unknown oracles are unevaluated rather than passing', async () => {
    const dir = await tempDir('lt-oracle-')
    const outcome = await evaluateAssertion({ id: 'HA-1', check: 'x', evaluate: { oracle: 'feels_right' } }, dir)
    expect(outcome.status).toBe('unevaluated')
  })

  test('event_order enforces relative ordering only', async () => {
    const dir = await tempDir('lt-oracle-')
    await writeFile(path.join(dir, 'events.json'), JSON.stringify({ events: [{ seq: 1, type: 'A' }, { seq: 2, type: 'B' }, { seq: 3, type: 'C' }] }), 'utf8')
    expect((await evaluateAssertion({ id: 'ok', check: '', evaluate: { oracle: 'event_order', sequence: ['A', 'C'] } }, dir)).status).toBe('pass')
    expect((await evaluateAssertion({ id: 'bad', check: '', evaluate: { oracle: 'event_order', sequence: ['C', 'A'] } }, dir)).status).toBe('fail')
  })

  test('no_external_effect scans nested evidence for external_effect', async () => {
    const dir = await tempDir('lt-oracle-')
    await writeFile(path.join(dir, 'events.json'), JSON.stringify({ events: [{ seq: 1, type: 'PlanRevisionApplied', payload: { tasks: [{ id: 'a', sideEffectClass: 'external_effect' }] } }] }), 'utf8')
    await writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({ plan: null, attempts: [] }), 'utf8')
    const outcome = await evaluateAssertion({ id: 'HA', check: '', evaluate: { oracle: 'no_external_effect' } }, dir)
    expect(outcome.status).toBe('fail')
    expect(JSON.stringify(outcome.actual)).toContain('events.json#1')
  })
})

describe('secret redaction', () => {
  test('redacts secret-looking keys and credential-shaped values recursively', () => {
    const redacted = redactSecrets({
      api_key: 'abc',
      nested: { Authorization: 'Bearer token', note: 'safe' },
      list: [{ password: 'hunter2' }, 'sk-abcdefghijklmnop1234'],
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }) as Record<string, unknown>
    expect(redacted.api_key).toBe('<redacted>')
    expect((redacted.nested as Record<string, unknown>).Authorization).toBe('<redacted>')
    expect((redacted.nested as Record<string, unknown>).note).toBe('safe')
    expect(((redacted.list as unknown[])[0] as Record<string, unknown>).password).toBe('<redacted>')
    expect((redacted.list as unknown[])[1]).toBe('<redacted>')
    expect(redacted.jwt).toBe('<redacted>')
  })

  test('sanitizeEnvironment drops secret keys and unlisted variables', () => {
    const env = sanitizeEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'sk-x', LT_SCENARIO_ID: 'LT-X-001', RANDOM_USER_DATA: 'nope' })
    expect(env.PATH).toBe('/bin')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.LT_SCENARIO_ID).toBe('LT-X-001')
    expect(env.RANDOM_USER_DATA).toBeUndefined()
  })
})

describe('port selection', () => {
  test('never returns a reserved port and returns a connectable free port', async () => {
    for (let i = 0; i < 5; i += 1) {
      const port = await findFreePort()
      expect(RESERVED_PORTS.has(port)).toBe(false)
      expect(port).toBeGreaterThanOrEqual(4100)
    }
  })
})
