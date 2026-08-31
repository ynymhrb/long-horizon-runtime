---
feature_ids: [long-task-liveness]
topics: [durable-execution, heartbeats, leases, streaming-progress]
doc_kind: implementation_plan
created: 2026-08-31
---

# Long-task liveness implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-minute absolute child deadline with durable liveness leases, a five-hour wall limit, and visible compact progress.

**Architecture:** The DSH adapter exposes bounded child progress and always settles locally on an elapsed deadline. The scheduler writes attempt leases and progress events, reconciles them on every round/read/activation, and applies existing retry or conservative pause policy. The UI consumes the resulting projection without storing raw child output in parent context.

**Tech Stack:** TypeScript, node:sqlite, Vitest, Cordis/Typert, React 18.

**Spec:** `docs/superpowers/specs/2026-08-31-long-task-liveness-design.md`

## Global constraints

- Modify only this isolated `D:\code\long-horizon-runtime` worktree; preserve existing runtime semantics outside liveness.
- Defaults: `idleTimeoutMs=300000`, `maxWallTimeMs=18000000`, `heartbeatIntervalMs=30000`.
- `external_effect` never retries automatically after lease/wall expiry.
- Persist compact phase/progress only; do not store raw model token streams in parent context.
- Every behavior change begins with a focused failing Vitest test.

### Task 1: Execution liveness contract and hard-settling DSH adapter

**Files:**
- Modify: `src/adapters.ts`, `src/dsh-adapters.ts`, `src/tools.ts`
- Test: `tests/dsh-adapters.spec.ts`, `tests/plugin.spec.ts`

**Interfaces:** Add `AttemptLiveness { idleTimeoutMs, maxWallTimeMs, heartbeatIntervalMs }`; extend `ExecutionAdapter.execute()` with `liveness` and `onProgress`; make `ExecutionResult.failureKind` distinguish `idle_timeout` and `wall_timeout` through its summary while retaining infrastructure classification.

- [ ] **Step 1: Write failing adapter tests.**

```ts
test('settles locally when a DSH child ignores an elapsed deadline', async () => {
  const result = await adapter.execute({ ...attempt, liveness: { idleTimeoutMs: 5, maxWallTimeMs: 50, heartbeatIntervalMs: 1 } })
  expect(result).toMatchObject({ status: 'failed', failureKind: 'infrastructure' })
  expect(result.summary).toContain('idle timeout')
})

test('renews an idle deadline after child progress without extending its wall limit', async () => {
  const progress: unknown[] = []
  await adapter.execute({ ...attempt, liveness: { idleTimeoutMs: 20, maxWallTimeMs: 50, heartbeatIntervalMs: 1 }, onProgress: item => progress.push(item) })
  expect(progress).toContainEqual(expect.objectContaining({ phase: 'model' }))
})
```

- [ ] **Step 2: Run `pnpm vitest run tests/dsh-adapters.spec.ts -t "deadline|idle"` and verify the tests fail because no liveness contract exists.**
- [ ] **Step 3: Implement the narrow contract and local `Promise.race` watchdog.** Add typed liveness/progress input, derive defaults in `tools.ts`, race `run.result` against independently refreshed idle and fixed wall timers, call best-effort dispose/cancel without awaiting an unbounded cleanup path, and return a structured infrastructure failure with session ID.
- [ ] **Step 4: Run the focused adapter and plugin tests, then mark this task complete.**

### Task 2: Durable attempt lease, progress projection, and scheduler reconciliation

**Files:**
- Modify: `src/event-store.ts`, `src/projections.ts`, `src/scheduler.ts`, `src/runtime.ts`, `src/task-ui-api.ts`
- Test: `tests/event-store.spec.ts`, `tests/scheduler.spec.ts`, `tests/runtime.spec.ts`, `tests/task-ui.spec.ts`

**Interfaces:** `AttemptProjection` exposes `startedAt`, `lastActivityAt`, `leaseExpiresAt`, `maxWallExpiresAt`, and latest compact progress. `Scheduler.reconcileLiveness(goalId?)` terminalizes expired attempts. `LongTaskRuntime` calls it before rounds, reads, and recovery.

- [ ] **Step 1: Write failing projection and scheduler tests.**

```ts
test('projects a progress event and renews only its idle lease', () => {
  store.append([{ type: 'AttemptProgressRecorded', goalId: 'g', taskId: 'a', payload: { attemptId: 'x', at: now, phase: 'tool', message: 'running test' } }])
  expect(store.listAttempts('a', 'g')[0]).toMatchObject({ lastActivityAt: now, latestProgress: { phase: 'tool' } })
})

test('reconciles a stale read-only lease and schedules its retry', async () => {
  await scheduler.reconcileLiveness('g')
  expect(store.listRecentEvents('g').map(event => event.type)).toContain('TaskAttemptTimedOut')
})

test('pauses an external-effect attempt when its wall lease expires', async () => {
  await scheduler.reconcileLiveness('g')
  expect(store.getGoal('g')?.state).toBe('PAUSED')
})
```

- [ ] **Step 2: Run `pnpm vitest run tests/event-store.spec.ts tests/scheduler.spec.ts tests/runtime.spec.ts -t "lease|progress|wall"` and verify the tests fail for the missing projection/reconciler.**
- [ ] **Step 3: Add idempotent schema migration and projections.** Add nullable attempt timing/progress columns, project start/progress/timeout events, and return the values from attempt queries and task views.
- [ ] **Step 4: Implement reconciliation and lifecycle policy.** On every dispatch/read/recovery, atomically examine RUNNING attempts. An idle expiry appends `TaskAttemptTimedOut`, then uses existing infrastructure retry handling for safe work; a wall expiry appends the same durable fact plus `GoalPaused`. Cancel the local child best-effort when it belongs to this process. Late settlement must not append a second terminal outcome.
- [ ] **Step 5: Run focused tests and mark this task complete.**

### Task 3: Narrow child progress report, remote DTO, and Cockpit visibility

**Files:**
- Modify: `src/tools.ts`, `src/task-ui-api.ts`, `src/remote.ts`, `client/task-model.js`, `client/TaskCockpit.js`, `client/task-model.d.ts`
- Test: `tests/plugin.spec.ts`, `tests/task-ui.spec.ts`, `tests/task-cockpit.spec.ts`

**Interfaces:** Register `long_task_report_progress({ attempt_id, phase, message, completed?, total? })` only for a child attempt identity; `GoalView` and task DTOs include current attempt liveness; Cockpit renders phase, last activity, elapsed time, and expiry reason.

- [ ] **Step 1: Write failing authorization and presentation tests.**

```ts
test('accepts bounded progress only from the matching execution child', async () => {
  await expect(report({ attempt_id: 'other', phase: 'tool', message: 'x' })).rejects.toThrow(/attempt/i)
})

test('presents durable attempt activity without rendering raw child output', () => {
  expect(attemptLivenessPresentation({ lastActivityAt: '2026-08-31T00:00:00.000Z', latestProgress: { phase: 'tool', message: 'tests' } })).toMatchObject({ phase: '工具执行中' })
})
```

- [ ] **Step 2: Run `pnpm vitest run tests/plugin.spec.ts tests/task-ui.spec.ts tests/task-cockpit.spec.ts -t "progress|activity"` and verify failure.**
- [ ] **Step 3: Implement report authorization and DTO/UI projection.** Keep lifecycle tools denied to children; the reporter only appends bounded progress for its own attempt. Expose only the latest compact progress and timestamps through the named remote DTO. Render them in the Cockpit and task strip with visible text labels.
- [ ] **Step 4: Run focused UI tests and mark this task complete.**

### Task 4: Documentation and release verification

**Files:**
- Modify: `README.md`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`
- Test: all suites

- [ ] **Step 1: Document the five-hour wall limit, idle heartbeats, restart reconciliation, and external-effect safety behavior.**
- [ ] **Step 2: Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm pack --dry-run`, and `git diff --check`; fix only failures caused by this change.**
- [ ] **Step 3: Review the resulting diff and report the exact verification output.**
