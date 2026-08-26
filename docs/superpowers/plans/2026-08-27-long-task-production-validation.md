# Long-task production validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe, deterministic validation harness that turns disposable long-task executions into evidence bundles, machine-checked outcomes, and LLM-readable candidate incident reports.

**Architecture:** A new src/validation subsystem validates versioned scenario files and enforces the read-only/disposable-workspace policy before creating a runtime fixture. It runs deterministic lifecycle and injected-failure scenarios, writes an immutable evidence bundle, then optionally validates a separately supplied triage JSON report. Scenario definitions and hard oracles stay in code and fixtures; the LLM remains an untrusted, read-only analyst.

**Tech Stack:** TypeScript 6, Node node:sqlite, Node filesystem APIs, Zod 4, Vitest 4, existing LongTaskRuntime/RuntimeEventStore fixtures, DSH Web for manual isolated UI acceptance.

**Spec:** docs/superpowers/specs/2026-08-27-long-task-production-validation-handbook.md

## Global Constraints

- Modify only D:\code\long-horizon-runtime; never modify DeepSeek Harness source or user-profile configuration.
- Every executable scenario uses a fresh temporary workspace and a unique SQLite database below it; cleanup may delete only that verified workspace.
- Reject tasks not declared read_only; never execute an external_effect, deploy, message, or third-party write as part of validation.
- The runner never invokes an LLM and never accepts a replan or edits source; it only writes its requested evidence directory.
- Use the existing Zod dependency for untrusted scenario/report input. Keep runtime behavior unchanged except for exporting an optional validation entry point.
- Each behavior change begins with a focused failing Vitest test. Preserve all existing user worktree changes and stage only task-owned files.

---

## File structure

- Create src/validation/contracts.ts: Zod schemas and TypeScript types for scenarios, hard assertions, evidence manifests, run summaries, and triage reports.
- Create src/validation/policy.ts: pure safety policy and path containment checks.
- Create src/validation/evidence.ts: append-only evidence-bundle writer and redacted projections.
- Create src/validation/runner.ts: workspace allocation, scenario dispatch, hard-oracle evaluation, and cleanup.
- Create src/validation/scenarios.ts: registry for the initial code-executable scenarios.
- Create src/validation/triage.ts: prompt rendering, externally supplied report validation, and run metrics.
- Create src/validation/cli.ts: node dist/validation/cli.js command.
- Create tests/validation/*.spec.ts and tests/validation/helpers.ts: focused unit/integration coverage and safe test adapters.
- Create validation/scenarios/{state,faults,ui-manual}.json: reviewed manifests for every handbook ID.
- Create validation/prompts/{runner,triager}.md: the approved worker prompts.
- Modify package.json and README.md: command, safety limits, evidence layout, and human review handoff.

### Task 1: Define scenario contracts and fail-closed safety policy

**Files:**
- Create: src/validation/contracts.ts, src/validation/policy.ts
- Create: tests/validation/contracts.spec.ts, tests/validation/policy.spec.ts

**Interfaces:**
- Produces ValidationScenario, ValidationRunSummary, EvidenceManifest, TriageReport, and parseScenario(value): ValidationScenario.
- Produces assertSafeScenario(scenario), assertPathWithinWorkspace(workspace, target), and createRunWorkspace(prefix): Promise<string>.
- Consumed by every later validation component.

- [ ] **Step 1: Write the failing contract tests**

~~~ts
import { expect, test } from 'vitest'
import { parseScenario } from '../../src/validation/contracts.js'

test('accepts a fully specified read-only deterministic scenario', () => {
  expect(parseScenario({
    id: 'LT-STATE-001', title: 'Create goal', risk: 'high',
    kind: 'deterministic', tags: ['state'], preconditions: ['fresh database'],
    setup: [], actions: ['create_goal'], hardAssertions: ['goal id is stable'],
    evidenceRequired: ['events', 'runtime_snapshot'], llmReview: 'on_failure',
    expectedUserOutcome: 'The task is visible.', cleanup: 'delete_workspace',
    taskSideEffectClass: 'read_only',
  })).toMatchObject({ id: 'LT-STATE-001', taskSideEffectClass: 'read_only' })
})

test('rejects a scenario without hard evidence requirements', () => {
  expect(() => parseScenario({ id: 'LT-STATE-001' })).toThrow(/title|evidence/i)
})
~~~

- [ ] **Step 2: Run the focused test to verify it fails**

Run: pnpm vitest run tests/validation/contracts.spec.ts

Expected: FAIL because src/validation/contracts.ts does not exist.

- [ ] **Step 3: Write the failing safety-policy tests**

~~~ts
import { expect, test } from 'vitest'
import { assertPathWithinWorkspace, assertSafeScenario } from '../../src/validation/policy.js'

test('refuses an external-effect scenario before any runner action', () => {
  expect(() => assertSafeScenario({ taskSideEffectClass: 'external_effect' } as never))
    .toThrow(/read_only/)
})

test('refuses cleanup outside the temporary workspace', () => {
  expect(() => assertPathWithinWorkspace('D:/tmp/lt-run', 'D:/tmp/other/file'))
    .toThrow(/workspace/)
})
~~~

- [ ] **Step 4: Run the focused test to verify it fails**

Run: pnpm vitest run tests/validation/policy.spec.ts

Expected: FAIL because src/validation/policy.ts does not exist.

- [ ] **Step 5: Implement the contracts and policy**

~~~ts
export const validationScenarioSchema = z.object({
  id: z.string().regex(/^LT-[A-Z]+-\d{3}$/), title: z.string().min(1),
  risk: z.enum(['critical', 'high', 'medium', 'low']),
  kind: z.enum(['deterministic', 'fault_injection', 'exploratory_ui']),
  tags: z.array(z.string()).min(1), preconditions: z.array(z.string()),
  setup: z.array(z.string()), actions: z.array(z.string()),
  hardAssertions: z.array(z.string()),
  evidenceRequired: z.array(z.enum(['events', 'runtime_snapshot', 'command_log', 'artifacts', 'screenshots'])).min(1),
  llmReview: z.enum(['never', 'on_failure', 'always']),
  expectedUserOutcome: z.string().min(1), cleanup: z.literal('delete_workspace'),
  taskSideEffectClass: z.literal('read_only'),
}).strict()

export function assertPathWithinWorkspace(workspace: string, target: string): void {
  const relative = relativePath(resolve(workspace), resolve(target))
  if (relative === '' || relative.startsWith('..') || isAbsolute(relative)) {
    throw new Error('target escapes validation workspace')
  }
}
~~~

Implement assertSafeScenario by parsing the input and rejecting all exploratory_ui scenarios from automatic execution. Implement createRunWorkspace with mkdtemp(join(tmpdir(), 'long-task-validation-')); its returned path is the only permitted cleanup root.

- [ ] **Step 6: Run focused tests and typecheck**

Run: pnpm vitest run tests/validation/contracts.spec.ts tests/validation/policy.spec.ts; pnpm typecheck

Expected: PASS.

- [ ] **Step 7: Commit the contract boundary**

~~~bash
git add src/validation/contracts.ts src/validation/policy.ts tests/validation/contracts.spec.ts tests/validation/policy.spec.ts
git commit -m "feat: add safe validation scenario contracts"
~~~

### Task 2: Create immutable evidence bundles

**Files:**
- Create: src/validation/evidence.ts, tests/validation/evidence.spec.ts
- Modify: src/validation/contracts.ts

**Interfaces:**
- Consumes ValidationScenario, RuntimeEventStore, and GoalView.
- Produces EvidenceBundleWriter.create(root, metadata), writeCommand(), writeTask(), writeRuntime(), writeAssertion(), finalize(), and EvidenceManifest.
- Later runner code relies on the finalized bundle path and manifest only.

- [ ] **Step 1: Write the failing evidence test**

~~~ts
test('writes redacted ordered events, snapshot, assertion and manifest', async () => {
  const writer = await EvidenceBundleWriter.create(directory, { scenarioId: 'LT-STATE-001' })
  await writer.writeRuntime({ goal: { id: 'lt_a' }, events: [{ seq: 7, type: 'GoalCreated', payload: { token: 'secret' } }] })
  await writer.writeAssertion({ id: 'goal-created', passed: true, expected: 'event', actual: 'event' })
  const manifest = await writer.finalize()
  expect(manifest.items.map(item => item.id)).toEqual(expect.arrayContaining(['events.json#7', 'assertions.json#goal-created']))
  expect(readFileSync(join(directory, 'events.json'), 'utf8')).not.toContain('secret')
})
~~~

- [ ] **Step 2: Run the focused test to verify it fails**

Run: pnpm vitest run tests/validation/evidence.spec.ts

Expected: FAIL because EvidenceBundleWriter is missing.

- [ ] **Step 3: Implement the evidence writer**

~~~ts
export class EvidenceBundleWriter {
  static async create(root: string, metadata: RunMetadata): Promise<EvidenceBundleWriter>
  async writeCommand(entry: CommandEvidence): Promise<void>
  async writeTask(value: Record<string, unknown>): Promise<void>
  async writeRuntime(snapshot: Record<string, unknown>): Promise<void>
  async writeAssertion(result: HardAssertionResult): Promise<void>
  async finalize(): Promise<EvidenceManifest>
}
~~~

Use mkdir(..., { recursive: true }) only below the supplied run directory. Serialize events in ascending seq; redact recursively by replacing keys matching /token|secret|authorization|api.?key/i with "[REDACTED]". Write run.json, commands.ndjson, task.json, events.json, snapshot.json, artifacts.json, assertions.json, environment.json, and manifest.json. Emit an empty JSON array for required-but-empty evidence. Finalize must throw when a required file is absent.

- [ ] **Step 4: Run focused tests and typecheck**

Run: pnpm vitest run tests/validation/evidence.spec.ts; pnpm typecheck

Expected: PASS.

- [ ] **Step 5: Commit evidence support**

~~~bash
git add src/validation/contracts.ts src/validation/evidence.ts tests/validation/evidence.spec.ts
git commit -m "feat: capture durable validation evidence bundles"
~~~

### Task 3: Implement deterministic scenario execution and initial registry

**Files:**
- Create: src/validation/runner.ts, src/validation/scenarios.ts
- Create: tests/validation/helpers.ts, tests/validation/runner.spec.ts
- Create: validation/scenarios/state.json, validation/scenarios/faults.json, validation/scenarios/ui-manual.json

**Interfaces:**
- Consumes parsed scenario, safety policy, and EvidenceBundleWriter.
- Produces runScenario(input): Promise<ValidationRunSummary> and findScenario(id): RegisteredScenario.
- A RegisteredScenario exposes run(context) and returns named HardAssertionResult[]; it has no filesystem authority except its supplied workspace.

- [ ] **Step 1: Write the failing runner integration test**

~~~ts
test('runs LT-STATE-001 in a fresh workspace and emits a passing evidence bundle', async () => {
  const result = await runScenario({ scenarioId: 'LT-STATE-001', evidenceRoot: directory })
  expect(result.status).toBe('passed')
  expect(result.workspace).not.toBe(directory)
  expect(result.assertions.every(item => item.passed)).toBe(true)
  expect(existsSync(join(result.evidenceDirectory, 'manifest.json'))).toBe(true)
})

test('does not dispatch a manual UI scenario from the automatic runner', async () => {
  await expect(runScenario({ scenarioId: 'LT-UI-001', evidenceRoot: directory }))
    .rejects.toThrow(/manual|exploratory_ui/)
})
~~~

- [ ] **Step 2: Run the focused test to verify it fails**

Run: pnpm vitest run tests/validation/runner.spec.ts

Expected: FAIL because runScenario and the scenario registry do not exist.

- [ ] **Step 3: Create test-only deterministic adapters**

In tests/validation/helpers.ts, provide strictTask(id, objective), plannerReturning(tasks), executionReturning(results), and a Vitest afterEach cleanup that removes only directories allocated by mkdtemp. Use these adapters rather than mocking event-store internals, so each deterministic scenario exercises LongTaskRuntime, Scheduler, projections, and durable SQLite together.

- [ ] **Step 4: Implement three executable seed scenarios**

~~~ts
export const registeredScenarios: readonly RegisteredScenario[] = [
  { id: 'LT-STATE-001', async run(ctx) { /* create read-only goal; assert stable ID and GoalCreated */ } },
  { id: 'LT-RECOVERY-001', async run(ctx) { /* close/reopen RuntimeEventStore; compare projection */ } },
  { id: 'LT-FAULT-006', async run(ctx) { /* validator rejects output; assert evidence before replan */ } },
]
~~~

runScenario must parse the manifest, call assertSafeScenario, create a fresh workspace, create database/artifact paths below it, execute the matching registry function, write required evidence before cleanup, and return passed, failed, or inconclusive. It must never delete the evidence directory. Delete its generated workspace only after assertPathWithinWorkspace succeeds.

- [ ] **Step 5: Add the reviewed 35 scenario manifests**

Create all IDs and metadata from the approved handbook. The 20 state/recovery and 10 fault manifests are deterministic or fault_injection; LT-UI-001 through LT-UI-005 use exploratory_ui and llmReview: always. Initially map unimplemented deterministic IDs to inconclusive with the precise not_registered reason; do not silently pass them.

- [ ] **Step 6: Run focused tests and build**

Run: pnpm vitest run tests/validation/runner.spec.ts tests/runtime.spec.ts tests/scheduler.spec.ts; pnpm build

Expected: PASS. Existing runtime suites demonstrate that the harness did not change task semantics.

- [ ] **Step 7: Commit the runner and seed scenarios**

~~~bash
git add src/validation/runner.ts src/validation/scenarios.ts tests/validation/helpers.ts tests/validation/runner.spec.ts validation/scenarios
git commit -m "feat: run isolated long-task validation scenarios"
~~~

### Task 4: Add LLM handoff validation, prompts, and metrics

**Files:**
- Create: src/validation/triage.ts, tests/validation/triage.spec.ts
- Create: validation/prompts/runner.md, validation/prompts/triager.md
- Modify: src/validation/contracts.ts

**Interfaces:**
- Produces buildTriagerPrompt(manifest, scenario): string, parseTriageReport(value): TriageReport, and summarizeValidationRuns(runs): ValidationMetrics.
- Consumes an already-finalized evidence manifest; it never writes evidence or calls a model.

- [ ] **Step 1: Write failing triage tests**

~~~ts
test('rejects an LLM hypothesis that cites evidence absent from the manifest', () => {
  expect(() => parseTriageReport(reportWith('events.json#999'), manifestWith(['events.json#7']))).toThrow(/evidence/i)
})

test('counts hard failures separately from unconfirmed usability findings', () => {
  expect(summarizeValidationRuns([
    { status: 'failed', risk: 'high', hardFailure: true },
    { status: 'passed', risk: 'low', usabilityFindings: 2 },
  ])).toMatchObject({ total: 2, hardFailures: 1, usabilityCandidates: 2 })
})
~~~

- [ ] **Step 2: Run focused tests to verify they fail**

Run: pnpm vitest run tests/validation/triage.spec.ts

Expected: FAIL because triage APIs do not exist.

- [ ] **Step 3: Implement fail-closed report parsing and prompt rendering**

Use a strict Zod report schema with the approved verdict, earliest anomaly, at most three hypotheses, evidence references, usability findings, and nullable stopReason. Reject reports citing an identifier absent from EvidenceManifest.items. buildTriagerPrompt embeds the exact JSON schema, expected user outcome, and compact/redacted evidence paths only—not artifact bodies or secrets.

Copy the exact runner/triager instructions from the approved handbook to the two prompt files. Tests must assert the triager prompt forbids code edits, external effects, and confirmed-bug claims.

- [ ] **Step 4: Implement metrics**

~~~ts
export interface ValidationMetrics {
  readonly total: number; readonly hardPasses: number; readonly hardFailures: number
  readonly timeouts: number; readonly incompleteEvidence: number
  readonly byRisk: Readonly<Record<ValidationRisk, { total: number; failures: number }>>
  readonly llmCandidates: number; readonly usabilityCandidates: number
}
~~~

Calculate only metrics present in local run summaries. Keep reviewer-only confirmation rate and median reproduction time as optional inputs, never inferred from runner data.

- [ ] **Step 5: Run focused tests and typecheck**

Run: pnpm vitest run tests/validation/triage.spec.ts; pnpm typecheck

Expected: PASS.

- [ ] **Step 6: Commit triage boundaries**

~~~bash
git add src/validation/contracts.ts src/validation/triage.ts tests/validation/triage.spec.ts validation/prompts
git commit -m "feat: add evidence-bound validation triage"
~~~

### Task 5: Provide CLI, documentation, and first safe acceptance run

**Files:**
- Create: src/validation/cli.ts, tests/validation/cli.spec.ts
- Modify: package.json, README.md

**Interfaces:**
- Produces pnpm validation:run -- --scenario LT-STATE-001 --evidence <dir>.
- Optional --triage-report <file> validates and includes a pre-generated report; it never sends an API request.

- [ ] **Step 1: Write the failing CLI tests**

~~~ts
test('requires an explicit scenario id and evidence directory', async () => {
  await expect(main([])).rejects.toThrow(/--scenario.*--evidence/i)
})

test('returns nonzero for a hard scenario failure but leaves its evidence bundle', async () => {
  const code = await main(['--scenario', 'LT-FAULT-006', '--evidence', directory])
  expect(code).toBe(1)
  expect(existsSync(join(directory, 'LT-FAULT-006', 'manifest.json'))).toBe(true)
})
~~~

- [ ] **Step 2: Run the focused CLI test to verify it fails**

Run: pnpm vitest run tests/validation/cli.spec.ts

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 3: Implement the CLI and package script**

Export main(argv: readonly string[]): Promise<number> for testability. Parse only --scenario, --evidence, and --triage-report; reject unknown flags. Resolve and validate --evidence before writing. Print one JSON summary to stdout and diagnostics to stderr. Return 0 only for passed, 1 for a hard failure, and 2 for invalid input or inconclusive execution.

Add this exact package script:

~~~json
"validation:run": "pnpm build && node dist/validation/cli.js"
~~~

- [ ] **Step 4: Document the constrained workflow**

Add a README section showing:

~~~powershell
pnpm validation:run -- --scenario LT-STATE-001 --evidence .tmp-validation-evidence
~~~

Document that UI manifests are intentionally rejected by this CLI and must be run manually in local DSH Web by a constrained browser worker. Link the handbook, identify manifest.json as the sole triager handoff index, and state that a triage report is a candidate, not a bug verdict.

- [ ] **Step 5: Run full automated verification**

Run: pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check

Expected: all commands succeed. Investigate any failure before proceeding.

- [ ] **Step 6: Perform the first safe acceptance run**

Run: pnpm validation:run -- --scenario LT-STATE-001 --evidence .tmp-validation-evidence

Verify: summary is passed; the bundle has a manifest, ordered event export, snapshot, assertion record, and no redaction leak; the created goal uses only a disposable database/workspace. Do not invoke DSH external tools or a model for this first run.

- [ ] **Step 7: Commit CLI and handoff docs**

~~~bash
git add src/validation/cli.ts tests/validation/cli.spec.ts package.json README.md
git commit -m "feat: add long-task validation runner CLI"
~~~

## Plan self-review

- Spec coverage: Tasks 1–3 implement isolation policy, scenario contract, the 35-scenario inventory, hard oracles, and durable evidence. Task 4 implements bounded read-only LLM handoff and local metrics. Task 5 implements operator workflow and first-run verification.
- Scope: no LLM SDK, browser automation dependency, database schema change, or DSH source patch is introduced. Those are deliberately deferred until deterministic bundles are trustworthy.
- Interface consistency: all later tasks consume ValidationScenario, EvidenceManifest, and ValidationRunSummary from Tasks 1–2; only Task 3 dispatches runtime fixtures; only Task 4 parses LLM output.
