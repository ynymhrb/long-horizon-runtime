# LLM Quota Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Preserve LLM quota recovery times, wait without consuming ordinary task retries, and resume a live-parent task safely when the provider window reopens.

**Architecture:** The DSH adapter exposes only proven quota diagnostics through the existing execution-result seam. The durable scheduler converts those results into a quota-specific event sequence and a recoverable in-memory wake-up. Runtime owns timers because only it holds a live parent Agent; projections/UI expose the durable recovery information after restarts without autonomous child creation.

**Tech Stack:** TypeScript, Node.js timers, node:sqlite projections, Vitest, Cordis/Typert remote, React task Cockpit.

**Spec:** \`docs/superpowers/specs/2026-09-01-llm-quota-recovery-design.md\`

## Global Constraints

- Apply only to \`read_only\` and \`idempotent\` task attempts; \`external_effect\` remains operator-resolved.
- Never classify opaque \`stopReason: error\` as quota without a diagnostic.
- Persist no raw provider bodies, credentials, or secrets; keep only bounded sanitized diagnostics.
- A quota wait never consumes \`RetryPolicy.maxAttempts\`, terminalizes a task, or triggers automatic replanning.
- Only resume when a currently live DSH parent Agent is available; host restart requires an explicit continuation from an attached session.
- Cancellation, manual pause, archive, and revision changes must invalidate live quota wake-ups.

---

### Task 1: Model and adapter quota diagnostics

**Files:**

- Modify: \`src/adapters.ts\`, \`src/dsh-adapters.ts\`
- Test: \`tests/dsh-adapters.spec.ts\`

**Interfaces:**

- Produces \`FailureKind = 'output' | 'infrastructure' | 'interrupted' | 'quota'\`.
- Produces \`ExecutionResult.retryAt?: string\` and \`ExecutionResult.failureDiagnostic?: string\` on a quota failure.
- Produces module-private \`quotaFailure(message: string, now: number): Pick<ExecutionResult, 'failureKind' | 'retryAt' | 'failureDiagnostic'> | undefined\`.

- [ ] **Step 1: Write the failing adapter tests**

\`\`\`ts
test('preserves an explicit retry-after quota diagnostic from a child failure', async () => {
  const adapter = createDshExecutionAdapter(failingRuntime('HTTP 429 rate limit; retry-after: 2026-09-01T10:05:00.000Z') as never, { providerName: 'worker' })
  await expect(adapter.execute(executionInput())).resolves.toMatchObject({
    status: 'failed', failureKind: 'quota', retryAt: '2026-09-01T10:05:00.000Z',
  })
})

test('keeps an opaque DSH error as infrastructure rather than guessing quota', async () => {
  const adapter = createDshExecutionAdapter(errorStopRuntime() as never, { providerName: 'worker' })
  await expect(adapter.execute(executionInput())).resolves.toMatchObject({ failureKind: 'infrastructure' })
})
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run tests/dsh-adapters.spec.ts -t "retry-after quota|opaque DSH error"\`

Expected: the first test fails because \`failureKind\` is \`infrastructure\` and \`retryAt\` is absent; the opaque-error behavior remains green.

- [ ] **Step 3: Write minimal implementation**

\`\`\`ts
export type FailureKind = 'output' | 'infrastructure' | 'interrupted' | 'quota'

export interface ExecutionResult {
  // existing fields
  readonly retryAt?: string
  readonly failureDiagnostic?: string
}

function quotaFailure(message: string, now: number): Pick<ExecutionResult, 'failureKind' | 'retryAt' | 'failureDiagnostic'> | undefined {
  const match = /(?:retry-after|retry_at|reset_at)\s*[:=]\s*(\S+)/i.exec(message)
  const retryAt = match === null ? undefined : Date.parse(match[1])
  if (!/\b429\b|rate[ -]?limit|quota/i.test(message) || retryAt === undefined || !Number.isFinite(retryAt) || retryAt <= now || retryAt - now > 86_400_000) return undefined
  return { failureKind: 'quota', retryAt: new Date(retryAt).toISOString(), failureDiagnostic: boundedDiagnostic(message) }
}
\`\`\`

Use the parser only on adapter-thrown messages or structured child diagnostics. Keep opaque \`stopReason: error\` on its existing infrastructure path.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run tests/dsh-adapters.spec.ts -t "retry-after quota|opaque DSH error"; pnpm typecheck\`

Expected: PASS; explicit diagnostic becomes \`quota\`, opaque stop error stays \`infrastructure\`.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/adapters.ts src/dsh-adapters.ts tests/dsh-adapters.spec.ts
git commit -m "feat: classify LLM quota diagnostics"
\`\`\`

### Task 2: Durable quota scheduling without retry-budget consumption

**Files:**

- Modify: \`src/scheduler.ts\`, \`src/projections.ts\`, \`src/event-store.ts\`, \`src/domain.ts\`
- Test: \`tests/scheduler.spec.ts\`, \`tests/event-store.spec.ts\`

**Interfaces:**

- Produces \`QuotaRecovery { goalId, taskId, attemptId, retryAt, diagnostic }\` from \`RuntimeEventStore.getQuotaRecovery(goalId)\`.
- Produces \`QuotaRecoveryScheduled\` durable events.
- Extends scheduler construction with \`onQuotaRecovery?: (recovery: QuotaRecovery) => void\`.

- [ ] **Step 1: Write the failing scheduler and projection tests**

\`\`\`ts
test('pauses a quota-limited task until its provider reset without consuming ordinary retries', async () => {
  const { scheduler, store } = durableScheduler({ status: 'failed', summary: '429', failureKind: 'quota', retryAt: '2026-09-01T10:05:00.000Z', artifacts: [], evidence: [] })
  await scheduler.runRound('goal', undefined, parent)
  expect(store.getQuotaRecovery('goal')).toMatchObject({ taskId: 'task', retryAt: '2026-09-01T10:05:00.000Z' })
  expect(store.listEvents('goal').map(event => event.type)).toContain('QuotaRecoveryScheduled')
  expect(store.listEvents('goal').map(event => event.type)).not.toContain('TaskRetryBudgetExhausted')
})

test('clears pending quota recovery when a goal is cancelled', () => {
  appendQuotaRecovery(store, 'goal')
  scheduler.cancel('goal')
  expect(store.getQuotaRecovery('goal')).toBeUndefined()
})
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run tests/scheduler.spec.ts tests/event-store.spec.ts -t "quota-limited|pending quota"\`

Expected: FAIL because the event and \`getQuotaRecovery\` projection do not exist.

- [ ] **Step 3: Write minimal implementation**

\`\`\`ts
if (failureKind === 'quota' && result.retryAt !== undefined && task.sideEffectClass !== 'external_effect') {
  this.retryAfter.set(this.key(goalId, task.id), Date.parse(result.retryAt))
  events.push({ type: 'QuotaRecoveryScheduled', goalId, taskId: task.id, payload: {
    attemptId, retryAfter: result.retryAt, diagnostic: result.failureDiagnostic ?? 'LLM quota exhausted',
  } })
  events.push({ type: 'GoalPaused', goalId, payload: { reason: \`LLM quota exhausted; retry after \${result.retryAt}\` } })
}
\`\`\`

Make this branch precede ordinary retry accounting. Project only the latest scheduled recovery, clear it on \`GoalResumed\`, \`GoalCancelled\`, \`GoalArchived\`, and plan replacement, and never decrement task retry policy based on quota attempts.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run tests/scheduler.spec.ts tests/event-store.spec.ts -t "quota|retry budget|cancel"\`

Expected: PASS; pre-existing infrastructure and output retry tests remain green.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/scheduler.ts src/projections.ts src/event-store.ts src/domain.ts tests/scheduler.spec.ts tests/event-store.spec.ts
git commit -m "feat: persist quota recovery schedules"
\`\`\`

### Task 3: Live-parent timed recovery and restart-safe behavior

**Files:**

- Modify: \`src/runtime.ts\`, \`src/tools.ts\`
- Test: \`tests/runtime.spec.ts\`, \`tests/plugin.spec.ts\`

**Interfaces:**

- Produces \`LongTaskRuntime.scheduleQuotaRecovery(goalId, parent): void\` and \`cancelQuotaRecovery(goalId): void\`.
- Extends \`LongTaskRuntime.startBackground(goalId, parent)\` to arm a due recovery after a quota pause.
- Produces \`getStatus(goalId).quotaRecovery?: QuotaRecovery\`.

- [ ] **Step 1: Write the failing runtime tests with a fake clock**

\`\`\`ts
test('resumes a quota-paused goal once at the scheduled time with its live parent', async () => {
  const { runtime, advance, adapter } = quotaRuntime('2026-09-01T10:05:00.000Z')
  runtime.startBackground('goal', parent)
  await advance('2026-09-01T10:05:01.000Z')
  expect(adapter.execute).toHaveBeenCalledTimes(2)
  expect(runtime.getStatus('goal')?.goal.state).not.toBe('PAUSED')
})

test('does not create a child after restart when a persisted quota recovery is due', async () => {
  const runtime = reconstructedRuntimeWithDueQuotaRecovery()
  await runtime.runUntilIdle('goal')
  expect(runtime.getStatus('goal')?.quotaRecovery).toBeDefined()
  expect(runtime.getStatus('goal')?.goal.state).toBe('PAUSED')
})
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run tests/runtime.spec.ts tests/plugin.spec.ts -t "quota-paused|persisted quota"\`

Expected: FAIL because there is no quota recovery timer or DTO field.

- [ ] **Step 3: Write minimal implementation**

\`\`\`ts
private readonly quotaRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()

scheduleQuotaRecovery(goalId: string, parent: unknown): void {
  const recovery = this.store.getQuotaRecovery(goalId)
  if (recovery === undefined || parent === undefined || this.quotaRecoveryTimers.has(goalId)) return
  const delay = Math.max(0, Date.parse(recovery.retryAt) - this.now()) + deterministicJitter(goalId)
  this.quotaRecoveryTimers.set(goalId, setTimeout(() => {
    this.quotaRecoveryTimers.delete(goalId)
    if (this.store.getQuotaRecovery(goalId)?.attemptId !== recovery.attemptId) return
    void this.resumeQuotaGoal(goalId, parent, recovery)
  }, delay))
}
\`\`\`

\`resumeQuotaGoal\` must require the same recovery event, append the existing resume lifecycle event through the control/runtime seam, then call \`startBackground\`. It must not run after cancellation, archive, revision mismatch, explicit pause, or absent parent. Wire cancellation and pause paths to \`cancelQuotaRecovery\`; wire a quota pause in the background loop to arm it.

- [ ] **Step 4: Run test to verify it passes**

Run: \`pnpm vitest run tests/runtime.spec.ts tests/plugin.spec.ts -t "quota-paused|persisted quota|cancel.*quota"\`

Expected: PASS; due recovery executes once only with a live parent; reconstructed runtime remains paused.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/runtime.ts src/tools.ts tests/runtime.spec.ts tests/plugin.spec.ts
git commit -m "feat: resume quota waits with a live parent"
\`\`\`

### Task 4: Task presentation and operator-facing documentation

**Files:**

- Modify: \`src/task-ui-api.ts\`, \`client/task-presentation.js\`, \`client/task-presentation.d.ts\`, \`client/TaskCockpit.js\`, \`README.md\`
- Test: \`tests/task-ui.spec.ts\`, \`tests/task-cockpit.spec.ts\`

**Interfaces:**

- Extends UI task DTO with \`quotaRecovery?: { retryAt: string; diagnostic: string; due: boolean }\`.
- Produces \`quotaRecoveryPresentation(recovery, now)\` for text labels, never raw provider payloads.

- [ ] **Step 1: Write the failing UI DTO and presentation tests**

\`\`\`ts
test('exposes a sanitized pending quota recovery in the task DTO', () => {
  appendQuotaRecovery(store, 'goal', '2026-09-01T10:05:00.000Z', '429 rate limit')
  expect(ui.getTask({ taskId: 'goal' }).task).toMatchObject({ quotaRecovery: { retryAt: '2026-09-01T10:05:00.000Z', diagnostic: '429 rate limit' } })
})

test('renders a due quota wait as an actionable continuation message', () => {
  expect(quotaRecoveryPresentation({ retryAt: '2026-09-01T10:05:00.000Z', diagnostic: '429' }, new Date('2026-09-01T10:06:00.000Z')))
    .toMatchObject({ label: '额度恢复时间已到，请在已关联会话中继续' })
})
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`pnpm vitest run tests/task-ui.spec.ts tests/task-cockpit.spec.ts -t "quota recovery|额度恢复"\`

Expected: FAIL because the DTO and presentation function do not exist.

- [ ] **Step 3: Write minimal implementation**

\`\`\`js
export function quotaRecoveryPresentation(recovery, now = new Date()) {
  if (Date.parse(recovery.retryAt) <= now.getTime()) return { tone: 'warning', label: '额度恢复时间已到，请在已关联会话中继续' }
  return { tone: 'warning', label: \`LLM 额度耗尽，预计 \${new Date(recovery.retryAt).toLocaleTimeString()} 后重试\` }
}
\`\`\`

Render this alongside the existing goal state label and format \`QuotaRecoveryScheduled\` in the timeline. Pass only the sanitized diagnostic returned by the store.

- [ ] **Step 4: Run test to verify it passes and run full verification**

Run: \`pnpm vitest run tests/task-ui.spec.ts tests/task-cockpit.spec.ts; pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check\`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

\`\`\`bash
git add src/task-ui-api.ts client/task-presentation.js client/task-presentation.d.ts client/TaskCockpit.js README.md tests/task-ui.spec.ts tests/task-cockpit.spec.ts
git commit -m "feat: show LLM quota recovery status"
\`\`\`

