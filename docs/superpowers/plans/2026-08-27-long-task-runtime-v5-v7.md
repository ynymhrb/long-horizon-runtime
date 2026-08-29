# Long-Task Runtime V5–V7 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete V5–V7 integration, safety, visibility, release, and evidence work without enabling V8.

**Architecture:** V5's resolved-profile snapshot remains the only execution-adapter input. V6 completes scheduler-owned budget settlement and optionally selects from a task's bounded profile allow-list using replayed evaluations. V7 projects authoritative source-linked memory, performs retrieval during actual context creation, and stores a compact explanation in the dispatched context.

**Tech Stack:** TypeScript, Node `node:sqlite`, Vitest, Cordis/DSH subagents.

**Spec:** `docs/superpowers/specs/2026-08-27-long-task-runtime-v5-v7-design.md`

## Global Constraints

- Modify only this repository and package defaults only in `cordis.patch.yml`.
- Preserve append-only events, task IDs, revision fences, artifact/replan rules and archival retention.
- Every child retains `CHILD_TASK_TOOL_DENY`; profiles can only add denied tools.
- Unknown/incompatible profiles and exhausted budgets reject before any child starts; never fall back silently.
- All new capabilities remain disabled/fixed by default; V8 and remote services are out of scope.
- Every behavior change starts with a focused failing Vitest test.

---

## Completed implementation record

- [x] V5 profile types/configuration/validation/projection/router (`4894c5c`, `6a9901b`).
- [x] V5 scheduler routing and DSH provider/options/union-deny dispatch (`380c09c`).
- [x] V6 ledger/projection/pre-dispatch reservation/extension control/evaluation projection (`b0f55c8`–`f2637fd`).
- [x] V6 pure deterministic policy and V7 pure lexical retriever/context explanation/index replay/feedback audit (`5b54659`, `1f23520`, `4e4337e`, `defcf17`, `c9c7850`, `d2a26f9`).

These commits create the building blocks only. The following tasks close the unconnected behavior and release gates.

### Task 1: Settle every budget reservation on every terminal path — completed (`f96c084`)

**Files:** Modify `src/adapters.ts`, `src/dsh-adapters.ts`, `src/scheduler.ts`, `src/projections.ts`, `src/event-store.ts`; test `tests/scheduler.spec.ts`, `tests/budgets.spec.ts`, `tests/event-store.spec.ts`.

**Interfaces:** `ExecutionResult` gains `usage?: { tokens?: number; costMicros?: number; estimated?: boolean }`. Every `BudgetReserved` must be matched by exactly one `BudgetSettled` or `BudgetReleased`.

- [ ] **Step 1: Write failing tests.**

```ts
test('releases a pre-dispatch reservation when the adapter throws', async () => {
  execute.mockRejectedValueOnce(new Error('provider start failed'))
  await scheduler.runRound('g', undefined, parent)
  expect(store.listEvents('g').map(event => event.type)).toContain('BudgetReleased')
})

test('settles reported usage rather than a fabricated value', async () => {
  execute.mockResolvedValueOnce({ status: 'succeeded', output, usage: { tokens: 21, costMicros: 8, estimated: false } })
  await scheduler.runRound('g', undefined, parent)
  expect(store.listEvents('g').find(event => event.type === 'BudgetSettled')?.payload).toMatchObject({ actualTokens: 21, actualCostMicros: 8, estimated: false })
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/scheduler.spec.ts tests/budgets.spec.ts -t "releases a pre-dispatch|settles reported usage"`; expect absent compensating events and usage fields.
- [ ] **Step 3: Implement a single terminal-budget helper.** Carry the reservation ID and profile estimate through execution. Use one terminal path so provider throw, retry, validation failure, success, and operator interruption emit one settlement/release while preserving current attempt/retry events. Use a profile fixed estimate only when the provider omits that dimension.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/scheduler.spec.ts tests/budgets.spec.ts tests/event-store.spec.ts`.
- [ ] **Step 5: Commit.** `git add src/adapters.ts src/dsh-adapters.ts src/scheduler.ts src/projections.ts src/event-store.ts tests/scheduler.spec.ts tests/budgets.spec.ts tests/event-store.spec.ts; git commit -m "fix: settle every long-task budget reservation"`.

### Task 2: Apply opt-in evaluated profile policy in Scheduler — completed (`1218d44`)

**Files:** Modify `src/domain.ts`, `src/execution-profiles.ts`, `src/execution-policy.ts`, `src/projections.ts`, `src/event-store.ts`, `src/scheduler.ts`, `src/tools.ts`, `cordis.patch.yml`; test `tests/execution-policy.spec.ts`, `tests/scheduler.spec.ts`, `tests/event-store.spec.ts`, `tests/plugin.spec.ts`.

**Interfaces:** `TaskDraft.allowedExecutionProfiles?: readonly string[]`; config `policyMode: 'fixed' | 'evaluated'` defaults to `'fixed'`; `RuntimeEventStore.listExecutionPolicyDecisions(goalId)` projects `ExecutionPolicyDecided` before `BudgetReserved`.

- [ ] **Step 1: Write failing tests.**

```ts
test('evaluated mode selects a declared compatible profile and persists exclusions', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(store.listEvents('g')).toContainEqual(expect.objectContaining({ type: 'ExecutionPolicyDecided', payload: expect.objectContaining({ selectedProfileId: 'reliable', excluded: expect.arrayContaining([expect.objectContaining({ profileId: 'cheap' })]) }) }))
})

test('fixed mode keeps the selected profile and emits no adaptive decision', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ id: 'requested' }) }))
  expect(store.listEvents('g').some(event => event.type === 'ExecutionPolicyDecided')).toBe(false)
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/execution-policy.spec.ts tests/scheduler.spec.ts tests/event-store.spec.ts tests/plugin.spec.ts -t "evaluated mode selects|fixed mode keeps"`; expect no config/scheduler decision.
- [ ] **Step 3: Implement bounded selection.** Validate unique nonblank allow-list IDs. In evaluated mode, derive enabled candidates from the allow-list, filter incompatibilities, consume replayed aggregates, persist candidates/exclusions/scores/version, and then route the selected ID. Fixed mode preserves V5 routing and does not invoke policy. No policy can override routing or budget rejection.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/execution-policy.spec.ts tests/scheduler.spec.ts tests/event-store.spec.ts tests/plugin.spec.ts`.
- [ ] **Step 5: Commit.** `git add src/domain.ts src/execution-profiles.ts src/execution-policy.ts src/projections.ts src/event-store.ts src/scheduler.ts src/tools.ts cordis.patch.yml tests/execution-policy.spec.ts tests/scheduler.spec.ts tests/event-store.spec.ts tests/plugin.spec.ts; git commit -m "feat: apply opt-in execution profile policy"`.

### Task 3: Retrieve source-linked memory in real task context — completed (`d37ce57`)

**Files:** Modify `src/context.ts`, `src/memory-retrieval.ts`, `src/projections.ts`, `src/event-store.ts`, `src/runtime.ts`, `src/scheduler.ts`; test `tests/context.spec.ts`, `tests/memory-retrieval.spec.ts`, `tests/scheduler.spec.ts`, `tests/event-store.spec.ts`.

**Interfaces:** Add `MemoryRecordProjection` and `RuntimeEventStore.listMemoryRecords(goalId)`. Scheduler consumes a `ContextBroker`/retrieval source so dispatched `ContextManifest` gets optional `retrieval`.

- [ ] **Step 1: Write failing end-to-end tests.**

```ts
test('includes a source-linked active memory retrieval explanation in dispatched context', async () => {
  store.append([{ type: 'MemoryRecorded', goalId: 'g', payload: { memoryId: 'm1', text: 'schema migration notes', sourceEventId: 'e1', workspaceId: 'local' } }])
  await scheduler.runRound('g', undefined, parent)
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ retrieval: expect.objectContaining({ selected: [expect.objectContaining({ memoryId: 'm1' })] }) }) }))
})

test('disabled retrieval leaves legacy context unchanged', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(execute.mock.calls[0][0].context.retrieval).toBeUndefined()
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/context.spec.ts tests/memory-retrieval.spec.ts tests/scheduler.spec.ts tests/event-store.spec.ts -t "source-linked active|disabled retrieval"`; expect no memory record projection/dispatch wiring.
- [ ] **Step 3: Implement replay and wiring.** Project authoritative `MemoryRecorded` plus invalidation; derive `MemoryIndexed` from content hash without raw private content in index events. Build queries from objective/node/contracts/dependencies, filter inactive/invalid/missing-source/workspace-mismatched records, and add selected items only after required artifacts. Run retrieval only when explicitly configured.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/context.spec.ts tests/memory-retrieval.spec.ts tests/scheduler.spec.ts tests/event-store.spec.ts`.
- [ ] **Step 5: Commit.** `git add src/context.ts src/memory-retrieval.ts src/projections.ts src/event-store.ts src/runtime.ts src/scheduler.ts tests/context.spec.ts tests/memory-retrieval.spec.ts tests/scheduler.spec.ts tests/event-store.spec.ts; git commit -m "feat: retrieve source-linked memory in task context"`.

### Task 4: Expose compact audit data and feedback controls — completed (`1fddf99`)

**Files:** Modify `src/task-api.ts`, `src/task-ui-api.ts`, `src/remote.ts`, `src/tools.ts`, `client/task-events.js`, `client/TaskCockpit.js`; test `tests/task-api.spec.ts`, `tests/task-ui.spec.ts`, `tests/task-cockpit.spec.ts`, `tests/plugin.spec.ts`.

**Interfaces:** Register `long_task_record_memory_feedback`; task DTOs expose compact audit facts (IDs, hashes, reasons, budget/policy/evaluation/retrieval summaries) and never raw memory content, provider options, or secrets.

- [ ] **Step 1: Write failing tests.**

```ts
test('records revision-fenced retrieval feedback through the registered model tool', async () => {
  await invokeTool('long_task_record_memory_feedback', { goal_id: 'g', control_revision: 2, memory_id: 'm1', decision: 'useful', reason: 'validator accepted output' })
  expect(store.listEvents('g').at(-1)?.type).toBe('MemoryRetrievalFeedbackRecorded')
})

test('returns compact audit data without memory text or profile options', () => {
  const audit = api.getTask({ taskId: 'g' }).audit
  expect(audit).toMatchObject({ budget: expect.any(Object), profiles: expect.any(Array) })
  expect(JSON.stringify(audit)).not.toContain('secret memory')
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/task-api.spec.ts tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts -t "feedback through|compact audit"`; expect absent tool/DTO fields.
- [ ] **Step 3: Implement exact public wiring.** Preserve revision conflicts, one named remote input object, audit-only feedback, and timeline labels/details for policy/budget/retrieval events. No public method returns raw memory content or profile options.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/task-api.spec.ts tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts`.
- [ ] **Step 5: Commit.** `git add src/task-api.ts src/task-ui-api.ts src/remote.ts src/tools.ts client/task-events.js client/TaskCockpit.js tests/task-api.spec.ts tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts; git commit -m "feat: expose long-task execution audit"`.

### Task 5: Release evidence, documentation, and independent review handoff — automation complete; isolated Web smoke/review handoff pending

**Files:** Modify `README.md`, `docs/roadmaps/long-task-runtime-roadmap.md`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`; test all suites.

- [ ] **Step 1: Add fault-injection/replay assertions.** Cover provider rejection, adapter throw/timeout reservation release, budget exhaustion, restart replay, invalid memory candidates, disabled defaults, and rendered audit events.
- [ ] **Step 2: Verify focused acceptance.** Run `pnpm vitest run tests/scheduler.spec.ts tests/budgets.spec.ts tests/execution-policy.spec.ts tests/memory-retrieval.spec.ts tests/event-store.spec.ts`; all tests exit 0.
- [ ] **Step 3: Document explicit opt-ins and gates.** Document `agentProfiles`, `policyMode`, budgets and retrieval configuration; record that profile options/raw memory are not exposed and V8 remains unimplemented. Mark only evidence-backed V5–V7 gates complete.
- [ ] **Step 4: Run release commands.** Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm pack --dry-run`, and `git diff --check`; every command must exit 0.
- [ ] **Step 5: Local smoke and review handoff.** Build and run a disposable DSH Web smoke on a non-reserved unused port, using only configured spawn profiles and no real user work; record observed evidence, stop cleanly, commit `feat: complete long-task runtime v5 through v7`, and obtain required independent review before claiming completion.

## Plan self-review

- Tasks 1–2 cover uncompleted V6 reservation/policy behavior; Task 3 covers real V7 source/index/retrieval integration; Task 4 covers safe visibility and feedback; Task 5 covers all staged gates and V8 boundary.
- Each task has explicit files, interfaces, red/green tests, and commit scope; no task relies on an unspecified later type.
