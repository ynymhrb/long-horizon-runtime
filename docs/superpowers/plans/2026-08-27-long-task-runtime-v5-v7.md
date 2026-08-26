# Long-Task Runtime V5–V7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver serial V5 heterogeneous profile routing, V6 budget/evaluation policy, and V7 source-linked explainable memory retrieval.

**Architecture:** Add replayable projections for profile decisions, budget facts, evaluation facts, and memory decisions. Pure routing, budget, policy and retrieval services feed the scheduler/context broker; the DSH adapter only receives a prior resolved profile.

**Tech Stack:** TypeScript, Node `node:sqlite`, Vitest, Cordis/DSH subagents.

**Spec:** `docs/superpowers/specs/2026-08-27-long-task-runtime-v5-v7-design.md`

## Global Constraints

- Modify only this repository and package defaults only in `cordis.patch.yml`.
- Preserve append-only events, task IDs, revision fences, artifact/replan rules and archival retention.
- Every child retains `CHILD_TASK_TOOL_DENY`; a profile may only add denied tools.
- Unknown/incompatible profiles and exhausted budgets reject before any child starts; never fall back silently.
- All capabilities remain disabled/fixed by default; do not implement V8 or a remote service.
- Begin every behavior change with a focused failing Vitest test.

---

### Task 1: V5 profile domain, configuration, and replay projection

**Files:** Create `src/execution-profiles.ts`; modify `src/domain.ts`, `src/projections.ts`, `src/event-store.ts`, `src/tools.ts`, `cordis.patch.yml`; test `tests/execution-profiles.spec.ts`, `tests/event-store.spec.ts`, `tests/plugin.spec.ts`.

**Interfaces:** Produce `ExecutionProfile`, `ResolvedExecutionProfile`, `ProfileRouter.resolve(input)`, `normalizeExecutionProfiles(input)`, and `RuntimeEventStore.listExecutionProfileResolutions(goalId)`. Extend `TaskDraft` with `executionProfile?: string` and `requiredCapabilities?: readonly string[]`.

- [ ] **Step 1: Write failing tests.**

```ts
test('resolves a declared compatible profile with an effective deny snapshot', () => {
  expect(router.resolve({ task: { executionProfile: 'fast', requiredCapabilities: ['research'] }, defaultTimeoutMs: 60_000 })).toMatchObject({ id: 'fast', providerName: 'spawn-fast', toolDeny: ['shell'] })
})
test('rejects an unknown profile without fallback', () => {
  expect(() => router.resolve({ task: { executionProfile: 'missing' }, defaultTimeoutMs: 1 })).toThrow('unknown execution profile')
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/execution-profiles.spec.ts tests/plugin.spec.ts -t "profile"`; expect missing types/router/config.
- [ ] **Step 3: Implement minimal types and projection.** Normalize explicitly configured profiles plus a default `spawn` snapshot; validate nonempty IDs/providers, unique names, capabilities, timeout narrowing and JSON-safe options. Add an `execution_profile_resolutions` table and project `ExecutionProfileResolved` with ID/provider/options hash/capabilities/deny/effective timeout/selection reason only.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/execution-profiles.spec.ts tests/event-store.spec.ts tests/plugin.spec.ts`; include event-store rebuild coverage.
- [ ] **Step 5: Commit.** Run `git add src/execution-profiles.ts src/domain.ts src/projections.ts src/event-store.ts src/tools.ts cordis.patch.yml tests/execution-profiles.spec.ts tests/event-store.spec.ts tests/plugin.spec.ts` then `git commit -m "feat: add durable execution profile routing"`.

### Task 2: V5 resolved profile dispatch

**Files:** Modify `src/adapters.ts`, `src/dsh-adapters.ts`, `src/scheduler.ts`, `src/runtime.ts`; test `tests/dsh-adapters.spec.ts`, `tests/scheduler.spec.ts`, `tests/runtime.spec.ts`.

**Interfaces:** `ExecutionAdapter.execute(input)` consumes `profile: ResolvedExecutionProfile`. `SchedulerOptions` consumes `profileRouter?: ProfileRouter` and persists decisions before child start.

- [ ] **Step 1: Write failing tests.**

```ts
test('forwards selected provider, options, and union deny list', async () => {
  await execution.execute({ attemptId: 'a1', taskId: 'task', context, signal, profile })
  expect(start).toHaveBeenCalledWith('spawn-fast', expect.objectContaining({ toolFilter: { deny: expect.arrayContaining([...CHILD_TASK_TOOL_DENY, 'shell']) } }))
})
test('records routing rejection before any adapter execution', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(execute).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/dsh-adapters.spec.ts tests/scheduler.spec.ts tests/runtime.spec.ts -t "resolved profile|routing rejection"`; expect no profile parameter/lifecycle.
- [ ] **Step 3: Implement dispatch.** Use profile provider/options in DSH `start`, union deny lists through a `Set`, resolve before `TaskAttemptStarted`, append `ExecutionProfileResolved`, and append `ExecutionProfileRejected` plus a durable pause when resolution rejects. Inject a normalized default profile for compatibility.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/dsh-adapters.spec.ts tests/scheduler.spec.ts tests/runtime.spec.ts`.
- [ ] **Step 5: Commit.** Run `git add src/adapters.ts src/dsh-adapters.ts src/scheduler.ts src/runtime.ts tests/dsh-adapters.spec.ts tests/scheduler.spec.ts tests/runtime.spec.ts` then `git commit -m "feat: route attempts through resolved execution profiles"`.

### Task 3: V6 durable budget ledger and controls

**Files:** Create `src/budgets.ts`; modify `src/domain.ts`, `src/projections.ts`, `src/event-store.ts`, `src/scheduler.ts`, `src/runtime.ts`, `src/task-api.ts`, `src/tools.ts`; test `tests/budgets.spec.ts`, `tests/event-store.spec.ts`, `tests/scheduler.spec.ts`, `tests/task-api.spec.ts`.

**Interfaces:** Produce `BudgetLimit`, `BudgetUsage`, `BudgetLedger.reserve/settle/release`, `RuntimeEventStore.getBudgetSummary(goalId)`, and revision-fenced `TaskControlApi.extendBudget(input, invocation)`.

- [ ] **Step 1: Write failing tests.**

```ts
test('uses the stricter node and goal maxAttempts before reservation', () => {
  expect(ledger.reserve({ goal: { maxAttempts: 2 }, task: { maxAttempts: 1 }, current: { attempts: 1 }, estimate })).toMatchObject({ ok: false, reason: 'maxAttempts exhausted' })
})
test('pauses before executing when reservation cannot fit', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(execute).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/budgets.spec.ts tests/scheduler.spec.ts tests/task-api.spec.ts -t "budget|reservation|extension"`; expect no ledger/events/control.
- [ ] **Step 3: Implement ledger and extension.** Add validated nonnegative limits for attempts/wall time/tokens/cost micros. Project `BudgetConfigured`, `BudgetReserved`, `BudgetSettled`, `BudgetReleased`, `BudgetExhausted`, `BudgetExtended`. Reserve before child start, settle/release on every path, pause on exhaustion, and allow only a nondecreasing exact-revision extension to reactivate a budget pause.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/budgets.spec.ts tests/event-store.spec.ts tests/scheduler.spec.ts tests/task-api.spec.ts`; include rebuild and stale-conflict tests.
- [ ] **Step 5: Commit.** Run `git add src/budgets.ts src/domain.ts src/projections.ts src/event-store.ts src/scheduler.ts src/runtime.ts src/task-api.ts src/tools.ts tests/budgets.spec.ts tests/event-store.spec.ts tests/scheduler.spec.ts tests/task-api.spec.ts` then `git commit -m "feat: enforce durable long-task budgets"`.

### Task 4: V6 evaluation facts and opt-in execution policy

**Files:** Create `src/execution-policy.ts`; modify `src/projections.ts`, `src/event-store.ts`, `src/scheduler.ts`, `src/tools.ts`, `cordis.patch.yml`; test `tests/execution-policy.spec.ts`, `tests/scheduler.spec.ts`, `tests/plugin.spec.ts`.

**Interfaces:** Produce `ExecutionPolicy.choose(input): PolicyDecision`, `RuntimeEventStore.listExecutionEvaluations(goalId)`, and config `policyMode: 'fixed' | 'evaluated'` with `'fixed'` default.

- [ ] **Step 1: Write failing tests.**

```ts
test('ranks compatible candidates while recording exclusions', () => {
  expect(policy.choose(input)).toMatchObject({ selectedProfileId: 'reliable', excluded: [{ profileId: 'cheap', reason: 'budget' }] })
})
test('fixed mode retains the task-selected profile', () => {
  expect(policy.choose(input).selectedProfileId).toBe('requested')
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/execution-policy.spec.ts tests/scheduler.spec.ts tests/plugin.spec.ts -t "policy|evaluation"`; expect missing policy/evaluation.
- [ ] **Step 3: Implement policy facts.** Persist `ExecutionPolicyDecided` before reservation and `ExecutionEvaluationRecorded` after every settled attempt. Evaluated mode ranks only enabled/compatible/allow-listed profiles using deterministic success/latency/cost summaries and ID tie breaks. Fixed mode uses V5 selection unchanged.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/execution-policy.spec.ts tests/scheduler.spec.ts tests/plugin.spec.ts`.
- [ ] **Step 5: Commit.** Run `git add src/execution-policy.ts src/projections.ts src/event-store.ts src/scheduler.ts src/tools.ts cordis.patch.yml tests/execution-policy.spec.ts tests/scheduler.spec.ts tests/plugin.spec.ts` then `git commit -m "feat: add evaluated execution policy telemetry"`.

### Task 5: V7 replayable memory index and retrieval

**Files:** Create `src/memory-retrieval.ts`; modify `src/context.ts`, `src/projections.ts`, `src/event-store.ts`, `src/runtime.ts`; test `tests/memory-retrieval.spec.ts`, `tests/context.spec.ts`, `tests/event-store.spec.ts`.

**Interfaces:** Produce `MemoryRetriever.retrieve(input): RetrievalDecision`, `MemoryIndex`, `RuntimeEventStore.listMemoryIndexEntries(goalId)`, and optional source-linked `ContextView.retrieval` explanation.

- [ ] **Step 1: Write failing tests.**

```ts
test('selects active source-linked memories by score then stable ID', () => {
  expect(retriever.retrieve(input).selected.map(item => item.memoryId)).toEqual(['m-a', 'm-b'])
})
test('filters stale memory and preserves mandatory artifacts', () => {
  expect(decision.excluded).toContainEqual(expect.objectContaining({ memoryId: 'stale', reason: 'inactive' }))
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/memory-retrieval.spec.ts tests/context.spec.ts tests/event-store.spec.ts -t "retrieval|memory index"`; expect missing services/explanations.
- [ ] **Step 3: Implement index and deterministic lexical retrieval.** Project `MemoryIndexed`/`MemoryIndexSuperseded`, rebuild from events, filter active/source/workspace validity before scoring, perform tokenized lexical scoring with optional injected local vectors, enforce memory budget after required artifacts, and persist candidates/exclusions/scores/query hash/policy version in the manifest.
- [ ] **Step 4: Verify green.** Run `pnpm vitest run tests/memory-retrieval.spec.ts tests/context.spec.ts tests/event-store.spec.ts`; include disabled-retriever legacy context coverage.
- [ ] **Step 5: Commit.** Run `git add src/memory-retrieval.ts src/context.ts src/projections.ts src/event-store.ts src/runtime.ts tests/memory-retrieval.spec.ts tests/context.spec.ts tests/event-store.spec.ts` then `git commit -m "feat: add explainable memory retrieval"`.

### Task 6: V7 feedback, visibility, roadmap, and release verification

**Files:** Modify `src/task-api.ts`, `src/task-ui-api.ts`, `src/remote.ts`, `src/tools.ts`, `client/task-events.js`, `README.md`, `docs/roadmaps/long-task-runtime-roadmap.md`; test `tests/task-api.spec.ts`, `tests/task-ui.spec.ts`, `tests/task-cockpit.spec.ts`, `tests/plugin.spec.ts`.

**Interfaces:** Produce revision-fenced feedback recording and compact API/UI fields for profile, budget and retrieval decisions.

- [ ] **Step 1: Write failing tests.**

```ts
test('records retrieval feedback without implicit ranking mutation', () => {
  expect(api.recordMemoryRetrievalFeedback(input, invocation)).toMatchObject({ applied: true })
  expect(store.listEvents('g').at(-1)?.type).toBe('MemoryRetrievalFeedbackRecorded')
})
test('formats profile and budget events for the audit timeline', () => {
  expect(formatTaskEvent({ type: 'BudgetExhausted', payload: { reason: 'maxAttempts' } }).detail).toContain('maxAttempts')
})
```

- [ ] **Step 2: Verify red.** Run `pnpm vitest run tests/task-api.spec.ts tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts -t "feedback|BudgetExhausted|ExecutionProfileResolved"`; expect absent public visibility.
- [ ] **Step 3: Implement public presentation and documentation.** Expose compact JSON-safe decisions only through existing typed APIs/remotes, persist exact-revision feedback without changing default ranking, format all new events, document opt-in config, and change V5–V7 roadmap gates to synthetic benchmark/fault injection/local smoke evidence while leaving V8 unchanged.
- [ ] **Step 4: Verify release.** Run `pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`; all commands must exit 0.
- [ ] **Step 5: Local smoke and commit.** Build, start a disposable DSH Web profile, check default compatibility and readable fixture-backed events without executing a real task, stop it, then run `git add src client README.md docs tests cordis.patch.yml package.json pnpm-lock.yaml` and `git commit -m "feat: complete long-task runtime v5 through v7"`.

## Plan self-review

- Tasks 1–2 cover V5; Tasks 3–4 cover V6; Tasks 5–6 cover V7 and documentation.
- Every task declares files, interfaces, red/green verification, and a commit boundary.
- Profile resolution feeds policy/budget checks; retrieval consumes source-linked context and does not introduce V8.
