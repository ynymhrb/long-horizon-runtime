# Long-Task Runtime V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@deepseek-ai/dsh-long-task-runtime`, a durable DSH plugin that plans, validates, schedules, recovers, and controls single-machine long-running goals.

**Architecture:** The package owns a SQLite append-only event log and rebuildable projections. Pure domain modules validate graph revisions and derive state; an orchestration service records commands and drives a scheduler. DSH is reached only via injectable planner/execution adapters and a thin Cordis plugin surface.

**Tech Stack:** Node `^22.19.0 || >=24.0.0`, TypeScript 6, Vitest 4, pnpm, ESM, `node:sqlite`, Cordis, DSH peer dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-long-task-runtime-v1-validated-design.md`

## Global Constraints

- Publish as ESM package `@deepseek-ai/dsh-long-task-runtime` with DSH packages declared as peer dependencies and local file-linked dev dependencies.
- Use `node:sqlite` `DatabaseSync`; introduce no native SQLite dependency.
- `runtime_events` is the authority; every projection must be reproducible from it.
- Persist each attempt start before calling DSH and persist artifacts, validation, result, and checkpoint atomically.
- Only validated active direct-dependency artifacts enter an execution context.
- A recovery of an interrupted `external_effect` task pauses on indeterminate validation; it does not blindly replay the task.
- Keep all deployment tuning in validated plugin config.

---

## File Structure

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`: standalone package tooling and local DSH development links.
- `src/domain.ts`: branded IDs, command/request/view types, events, lifecycle unions, artifact and task contracts.
- `src/graph.ts`: DAG validation, topological reachability, and constrained revision mutation.
- `src/event-store.ts`: SQLite schema, event append, projection rebuild, and transaction API.
- `src/projections.ts`: deterministic event-to-projection reducers and query views.
- `src/artifacts.ts`: inline/file artifact persistence and integrity hashes.
- `src/context.ts`: bounded direct-dependency ContextView construction.
- `src/adapters.ts`: planner/execution adapter interfaces and DSH implementation.
- `src/scheduler.ts`: super-step dispatch, validation, retries, checkpoints, and recovery.
- `src/runtime.ts`: command service and lifecycle-transition owner.
- `src/tools.ts`, `src/index.ts`: Cordis service declaration, configuration, and model-facing tools.
- `tests/*.spec.ts`: unit, recovery, replay, scheduler, and DSH composition coverage.
- `docs/decisions/2026-08-22-long-task-runtime-v1.md`: implementation decisions made within the approved specification.

### Task 1: Scaffold a buildable standalone package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `tests/package.spec.ts`
- Create: `docs/decisions/2026-08-22-long-task-runtime-v1.md`

**Interfaces:**
- Produces the `@deepseek-ai/dsh-long-task-runtime` ESM package and `pnpm test` command used by every later task.

- [ ] **Step 1: Write the failing package surface test**

```ts
import { describe, expect, test } from 'vitest'
import { pluginName } from '../src/index.ts'

describe('package surface', () => {
  test('exports its DSH plugin name', () => {
    expect(pluginName).toBe('@deepseek-ai/dsh-long-task-runtime')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails because the package surface is missing**

Run: `pnpm test tests/package.spec.ts`

Expected: FAIL because `src/index.ts` or its export is absent.

- [ ] **Step 3: Add the smallest ESM package configuration and export**

```ts
/** Published package identity. */
export const pluginName = '@deepseek-ai/dsh-long-task-runtime'
```

Set Node, TypeScript, Vitest, and DSH peer dependency versions to the local DSH checkout's `0.1.0-rc.7` surface. Use a `pnpm.overrides` or local development link strategy without placing DSH packages in published `dependencies`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `pnpm test tests/package.spec.ts && pnpm typecheck`

Expected: PASS with zero TypeScript errors.

- [ ] **Step 5: Record package-linking and module-format decisions**

Write the rationale and exact development-link mechanism in `docs/decisions/2026-08-22-long-task-runtime-v1.md`.

### Task 2: Define domain types and validate a complete DAG

**Files:**
- Create: `src/domain.ts`, `src/graph.ts`, `tests/graph.spec.ts`

**Interfaces:**
- Produces `validatePlan(plan: PlanDraft): ValidatedPlan` and `applyMutation(plan: ValidatedPlan, mutation: GraphMutation): ValidatedPlan`.
- Consumed by event store, planner, scheduler, and runtime.

- [ ] **Step 1: Write failing graph tests**

```ts
test('rejects a cycle before a plan becomes runnable', () => {
  expect(() => validatePlan(planWithEdges(['a', 'b'], [['a', 'b'], ['b', 'a']]))).toThrow('cycle')
})

test('invalidates only reachable descendants in a replacement revision', () => {
  const next = applyMutation(fourNodePlan(), { kind: 'invalidateTask', taskId: 'b', reason: 'bad evidence', evidenceRefs: [] })
  expect(next.tasks.get('b')?.state).toBe('INVALIDATED')
  expect(next.tasks.get('c')?.state).toBe('INVALIDATED')
  expect(next.tasks.get('d')?.state).toBe('PENDING')
})
```

- [ ] **Step 2: Run graph tests and verify expected failure**

Run: `pnpm test tests/graph.spec.ts`

Expected: FAIL because graph functions do not exist.

- [ ] **Step 3: Implement minimal domain and graph logic**

Define explicit discriminated unions for task/goal/attempt states, side-effect classes, task contracts, plan drafts, mutations, and validation errors. Validate duplicate IDs, self dependencies, missing dependencies, cycles, and unreachable nodes. Build a new revision instead of mutating the old revision.

- [ ] **Step 4: Run graph tests**

Run: `pnpm test tests/graph.spec.ts`

Expected: PASS.

### Task 3: Implement event sourcing and deterministic projections

**Files:**
- Create: `src/event-store.ts`, `src/projections.ts`, `tests/event-store.spec.ts`

**Interfaces:**
- Produces `RuntimeEventStore.append(events)`, `RuntimeEventStore.transaction(work)`, `RuntimeEventStore.rebuild()`, and projection query methods.
- Consumes domain events and produces goal, task, attempt, artifact, decision, and checkpoint views.

- [ ] **Step 1: Write failing replay and transaction tests**

```ts
test('rebuilds the same goal projection from append-only events', () => {
  store.append([goalCreated, planApplied, taskAttemptStarted, taskCompleted])
  const before = store.getGoal(goalId)
  store.rebuild()
  expect(store.getGoal(goalId)).toEqual(before)
})

test('does not expose an attempt start when its transaction fails', () => {
  expect(() => store.transaction(() => { store.append([attemptStarted]); throw new Error('abort') })).toThrow('abort')
  expect(store.listAttempts(taskId)).toEqual([])
})
```

- [ ] **Step 2: Run the tests and verify expected failure**

Run: `pnpm test tests/event-store.spec.ts`

Expected: FAIL because `RuntimeEventStore` is absent.

- [ ] **Step 3: Implement schema, append path, reducers, and rebuild**

Create `runtime_events` with increasing sequence, JSON payloads, and indexed aggregate IDs. Create projections named in the specification. Use one `DatabaseSync` transaction to append events and invoke projection reducers. Make `rebuild()` clear only owned projections and replay ordered events.

- [ ] **Step 4: Run replay tests**

Run: `pnpm test tests/event-store.spec.ts`

Expected: PASS.

### Task 4: Persist artifacts and construct bounded contexts

**Files:**
- Create: `src/artifacts.ts`, `src/context.ts`, `tests/context.spec.ts`

**Interfaces:**
- Produces `ArtifactStore.put`, `ArtifactStore.read`, and `ContextBroker.build(taskId): ContextView`.
- Consumes active artifact projections and task dependencies.

- [ ] **Step 1: Write failing artifact/context tests**

```ts
test('stores oversized content by hash-addressed file reference', () => {
  const artifact = artifacts.put({ type: 'analysis', content: 'x'.repeat(101) })
  expect(artifact.storage).toBe('file')
  expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/)
})

test('includes only validated direct-dependency artifacts', () => {
  const view = broker.build(taskC)
  expect(view.artifacts.map(a => a.taskId)).toEqual([taskB])
})
```

- [ ] **Step 2: Run focused tests and verify expected failure**

Run: `pnpm test tests/context.spec.ts`

Expected: FAIL because the stores are absent.

- [ ] **Step 3: Implement content addressing and context selection**

Use SHA-256, store small text/JSON inline, write large bytes under the configured artifact directory, and record MIME/path/hash/source attempt. Build ContextView from goal brief, current task contracts, direct validated artifact inputs, L1/L2 memories, evidence, and retry summary; never load a transcript or transitive task artifacts.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test tests/context.spec.ts`

Expected: PASS.

### Task 5: Implement adapters and task-result validation

**Files:**
- Create: `src/adapters.ts`, `tests/adapters.spec.ts`

**Interfaces:**
- Produces `PlannerAdapter.plan`, `ExecutionAdapter.execute`, `TaskResultValidator.validate`, and test adapters.
- DSH adapter later consumes `ctx.subagents.start` and returns a DSH child Session ID.

- [ ] **Step 1: Write failing adapter contract tests**

```ts
test('rejects a successful adapter result when its validator rejects the declared artifact', async () => {
  await expect(validateTaskResult(task, successfulResult, rejectingValidator)).resolves.toMatchObject({ ok: false })
})
```

- [ ] **Step 2: Run the test and verify expected failure**

Run: `pnpm test tests/adapters.spec.ts`

Expected: FAIL because validator/adapters are absent.

- [ ] **Step 3: Implement typed adapter boundaries**

Keep planner and execution interfaces independent of Cordis. Require planner output to validate with `validatePlan`; require execution results to declare artifacts or explicit `no_artifact`. Implement validators for declared result contracts and injectable task-specific validators.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test tests/adapters.spec.ts`

Expected: PASS.

### Task 6: Implement scheduler retries, checkpoints, and crash recovery

**Files:**
- Create: `src/scheduler.ts`, `tests/scheduler.spec.ts`, `tests/recovery.spec.ts`

**Interfaces:**
- Produces `Scheduler.runRound(goalId)`, `Scheduler.recover()`, and `Scheduler.cancel(goalId)`.
- Consumes event store, graph projection, context broker, artifact store, execution adapter, and validators.

- [ ] **Step 1: Write failing dispatch and recovery tests**

```ts
test('dispatches independent ready tasks in one bounded super-step', async () => {
  await scheduler.runRound(goalId)
  expect(adapter.started).toEqual(['a', 'b'])
  expect(adapter.maxActive).toBeLessThanOrEqual(2)
})

test('pauses an interrupted external-effect task when recovery cannot prove its effect', async () => {
  await scheduler.recover()
  expect(store.getGoal(goalId)?.state).toBe('PAUSED')
})
```

- [ ] **Step 2: Run scheduler tests and verify expected failure**

Run: `pnpm test tests/scheduler.spec.ts tests/recovery.spec.ts`

Expected: FAIL because scheduler is absent.

- [ ] **Step 3: Implement deterministic super-steps and recovery policy**

Select READY tasks by dependencies, priority, and creation order. Persist each attempt start before adapter invocation. Persist artifacts, evidence, validation result, terminal event, and a checkpoint atomically. Retry only according to policy; after restart mark nonterminal attempts interrupted, retry `read_only`/`idempotent`, and validate then pause indeterminate `external_effect` tasks.

- [ ] **Step 4: Run scheduler and recovery tests**

Run: `pnpm test tests/scheduler.spec.ts tests/recovery.spec.ts`

Expected: PASS.

### Task 7: Implement runtime commands and constrained plan revisions

**Files:**
- Create: `src/runtime.ts`, `tests/runtime.spec.ts`

**Interfaces:**
- Produces `LongTaskRuntime.createGoal`, `confirmGoal`, `getStatus`, `resumeGoal`, `cancelGoal`, and `invalidateTask`.
- Consumed by chat tools and composition tests.

- [ ] **Step 1: Write failing runtime lifecycle tests**

```ts
test('holds a valid initial plan until confirmation when requested', async () => {
  const goal = await runtime.createGoal({ objective: 'ship', planningMode: 'require_confirmation' })
  expect(goal.state).toBe('AWAITING_CONFIRMATION')
  await runtime.confirmGoal(goal.id)
  expect(runtime.getStatus(goal.id).state).toBe('RUNNING')
})
```

- [ ] **Step 2: Run runtime tests and verify expected failure**

Run: `pnpm test tests/runtime.spec.ts`

Expected: FAIL because runtime service is absent.

- [ ] **Step 3: Implement command handlers**

Translate each command into validated durable events. Invoke the planner only from `createGoal`; invoke scheduler only after an auto-accepted or confirmed plan. On invalidation, build and validate a new revision and either apply or pause it according to planning mode. Make status query projections only.

- [ ] **Step 4: Run runtime tests**

Run: `pnpm test tests/runtime.spec.ts`

Expected: PASS.

### Task 8: Mount the DSH Cordis plugin and model-facing tools

**Files:**
- Modify: `src/index.ts`
- Create: `src/tools.ts`, `tests/plugin.spec.ts`, `examples/cordis.yml`, `README.md`

**Interfaces:**
- Produces `apply(ctx, config)`, `ctx.longTaskRuntime`, and the six documented `long_task_*` tools.
- DSH adapter uses `ctx.subagents.start(provider, request)` and records returned child Session IDs.

- [ ] **Step 1: Write failing plugin composition test**

```ts
test('long_task_create calls the runtime and records the DSH child session', async () => {
  const result = await harness.executeTool('long_task_create', { objective: 'produce report' })
  expect(result.goalId).toBeDefined()
  expect(harness.runtime.getStatus(result.goalId).attempts[0]?.dshSessionId).toBeDefined()
})
```

- [ ] **Step 2: Run plugin test and verify expected failure**

Run: `pnpm test tests/plugin.spec.ts`

Expected: FAIL because the plugin and tools are absent.

- [ ] **Step 3: Implement Cordis registration and DSH adapters**

Declare the `Context.longTaskRuntime` extension, validate all config values, register the service in an effect, and register stateless `defineTool` handlers that delegate to it. Use configured planner/execution providers and a current calling Agent as DSH parent. Add a runnable `cordis.yml` example and install/configuration documentation.

- [ ] **Step 4: Run plugin composition test**

Run: `pnpm test tests/plugin.spec.ts`

Expected: PASS.

### Task 9: Verify the complete package and document decisions

**Files:**
- Modify: `README.md`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`

- [ ] **Step 1: Add acceptance-test coverage gaps found during a spec-to-test checklist review**

Add explicit tests for replay equivalence, retry history, cancellation, and replacement/split preservation if any are not already present.

- [ ] **Step 2: Run the complete verification suite**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all tests pass, typecheck succeeds, and package build completes.

- [ ] **Step 3: Write final implementation decisions**

Record all decisions not fixed by the approved spec, including schema serialization, package linking, default retry values, validator resolution, and DSH output transport.

- [ ] **Step 4: Commit implementation**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts src tests examples README.md docs/decisions docs/superpowers
git commit -m "feat: add durable long-task runtime v1"
```
