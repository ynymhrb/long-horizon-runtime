# Pause and Safe Replan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durably stop child agents on pause, expose automatic quota recovery, and apply automatic replans only to a provably safe unfinished read-only downstream region.

**Architecture:** The Scheduler gains a durable pause primitive that owns active-attempt aborting and terminalization. Runtime delegates pause to it and emits a quota-resumed lifecycle event before resumption. A pure replan classifier replaces the current Boolean check and returns an auditable decision and reasons.

**Tech Stack:** TypeScript, Node SQLite, Vitest, React 18.

**Spec:** `docs/superpowers/specs/2026-09-03-pause-and-safe-replan-design.md`

## Global Constraints

- Modify only this repository and use an isolated `.worktrees/` checkout on a `codex/` branch.
- Every behavior change begins with a focused failing Vitest test.
- A pause must never permit a late result to complete the interrupted attempt.
- Automatic replanning remains forbidden for infrastructure, quota, interruption, and external-effect failures.
- Never automatically alter succeeded nodes or their active validated artifacts.

---

### Task 1: Make pause cancel and terminalize active child attempts

**Files:** Modify `src/scheduler.ts`, `src/runtime.ts`, `src/task-api.ts`; test `tests/runtime.spec.ts`, `tests/task-api.spec.ts`.

**Interfaces:** Produce `Scheduler.pause(goalId: string): void` and `LongTaskRuntime.pauseGoal(goalId: string): GoalView`.

- [ ] **Step 1: Write the failing pause regression test.**

```ts
test('pausing aborts and durably interrupts an active child attempt', async () => {
  const { runtime, started, cancelled } = pausedRuntime()
  const goal = await runtime.createGoal({ objective: 'pause', planningMode: 'require_confirmation' })
  await runtime.confirmGoal(goal.id)
  runtime.startBackground(goal.id, {})
  await started
  const paused = runtime.pauseGoal(goal.id)
  expect(cancelled()).toBe(1)
  expect(paused.state).toBe('PAUSED')
  expect(paused.attempts[0]?.state).toBe('INTERRUPTED')
  expect(paused.tasks[0]?.state).toBe('PENDING')
})
```

- [ ] **Step 2: Run RED.** Run `pnpm vitest run tests/runtime.spec.ts tests/task-api.spec.ts -t "pausing aborts"`; expect failure because `pauseGoal` does not exist.

- [ ] **Step 3: Write the minimal implementation.** Store `taskId` beside each abort controller. `Scheduler.pause` clears retry timers, aborts and adapter-cancels every active attempt for a goal, and appends `TaskInterrupted` for each. `runtime.pauseGoal` calls it, cancels quota recovery, appends `GoalPaused { reason: 'user_requested' }`, and returns the view. Change `TaskControlApi.pause` to use it. Add a second test proving late success after pause is ignored and resume creates a distinct attempt.

- [ ] **Step 4: Run GREEN.** Run `pnpm vitest run tests/runtime.spec.ts tests/task-api.spec.ts -t "pausing aborts|late child success|pause as a running"`; expect pass.

- [ ] **Step 5: Commit.** Stage changed runtime, scheduler, API, and tests; commit `fix: stop child attempts when pausing tasks`.

### Task 2: Record and present automatic quota recovery

**Files:** Modify `src/runtime.ts`, `client/task-events.js`, `client/task-presentation.js`, `client/TaskCockpit.js`; test `tests/runtime.spec.ts`, `tests/task-cockpit.spec.ts`.

**Interfaces:** Produce `QuotaRecoveryResumed { attemptId }` and extend `quotaRecoveryPresentation` with a recovery-success notice.

- [ ] **Step 1: Write failing recovery notice tests.** Assert that a quota failure followed by fake-timer recovery emits `QuotaRecoveryResumed`; assert `quotaRecoveryPresentation(undefined, now, { type: 'QuotaRecoveryResumed' })` returns `额度已恢复，正在自动继续执行`.

- [ ] **Step 2: Run RED.** Run `pnpm vitest run tests/runtime.spec.ts tests/task-cockpit.spec.ts -t "quota recovery before|automatic quota recovery"`; expect failure because no event or presentation exists.

- [ ] **Step 3: Write the minimal implementation.** After rechecking the persisted recovery attempt and paused state, append `QuotaRecoveryResumed` immediately before `resumeGoal`. Add a timeline label. In `TaskCockpit`, find the newest recovery event, pass it to the presentation helper, and render the notice before the generic plan hint. Do not create timers after restart or without a live parent.

- [ ] **Step 4: Run GREEN.** Run `pnpm vitest run tests/runtime.spec.ts tests/task-cockpit.spec.ts -t "quota recovery before|automatic quota recovery|quota-paused"`; expect pass.

- [ ] **Step 5: Commit.** Stage runtime, client, and tests; commit `feat: show automatic quota recovery`.

### Task 3: Classify replan candidates against the affected downstream region

**Files:** Create `src/replan-policy.ts`; modify `src/runtime.ts`; test `tests/replan-policy.spec.ts`, `tests/runtime.spec.ts`.

**Interfaces:** Produce `classifyAutomaticReplan(input): { outcome: 'auto_apply' | 'await_confirmation'; reasons: readonly string[] }` from previous tasks, candidate tasks, failed task ID, and active artifacts.

- [ ] **Step 1: Write failing classifier tests.** Prove a replacement confined to the failed unfinished downstream region auto-applies. Separately prove confirmation is required if a candidate changes a succeeded node, adds unrelated work, introduces external effects, or affects an active validated artifact owner.

- [ ] **Step 2: Run RED.** Run `pnpm vitest run tests/replan-policy.spec.ts`; expect failure because the module does not exist.

- [ ] **Step 3: Write the minimal policy module and integrate it.** Build reverse reachability from previous dependencies. Compare task definitions excluding only runtime `state` and `createdOrder`. Reject candidate additions, external effects, changes outside the affected region, succeeded-node changes, and artifacts owned by missing or affected nodes. Return a reason for every violation. Persist reasons in `DecisionRecorded` and proposal trigger metadata; preserve completed tasks only after `auto_apply`.

- [ ] **Step 4: Run GREEN.** Run `pnpm vitest run tests/replan-policy.spec.ts tests/runtime.spec.ts -t "automatic.*replan|confined|requires confirmation"`; expect pass.

- [ ] **Step 5: Commit.** Stage policy, runtime, and tests; commit `fix: fence automatic replans to safe downstream work`.

### Task 4: Verify behavior and document operating semantics

**Files:** Modify `README.md`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`; test all suites.

- [ ] **Step 1: Document behavior.** State pause cancels active children and recovery starts a new attempt; quota retry needs a live parent and creates an audit event; enumerate the replan safety fence and confirmation fallback.

- [ ] **Step 2: Run focused suites.** Run `pnpm vitest run tests/runtime.spec.ts tests/task-api.spec.ts tests/task-cockpit.spec.ts tests/replan-policy.spec.ts`; expect pass.

- [ ] **Step 3: Run complete verification.** Run `pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`; expect all commands to exit 0.

- [ ] **Step 4: Commit.** Stage README, docs, and tests; commit `docs: explain pause recovery and replan safety`.
