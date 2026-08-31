import { describe, expect, test, vi } from 'vitest'
import { LongTaskRuntime } from '../src/runtime.js'
import type { ExecutionAdapter, PlannerAdapter } from '../src/adapters.js'

function strictTask(id: string, objective: string, dependsOn: string[] = []) {
  return { id, objective, dependsOn, priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only' as const, validator: 'required' }
}

describe('LongTaskRuntime', () => {
  test('revises the original goal and holds its new plan for confirmation', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const created = await runtime.createGoal({ objective: 'original', planningMode: 'require_confirmation' })
    const edited = await runtime.editOriginalGoal(created.id, { objective: 'corrected', reason: 'user corrected scope' })

    expect(edited.objective).toBe('corrected')
    expect(edited.state).toBe('AWAITING_CONFIRMATION')
    expect(edited.pendingProposal?.baseRevision).toBe(0)
    expect(runtime.store.listGoalVersions(created.id).at(-1)).toMatchObject({ version: 1, objective: 'corrected', reason: 'user corrected scope' })
  })
  test('automatically applies a read-only replan after terminal validation failure', async () => {
    let planningCalls = 0
    const planner: PlannerAdapter = { async plan(input) { planningCalls += 1; return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', planningCalls === 1 ? 'fails once' : 'replacement work')] } } }
    let executions = 0
    const execution: ExecutionAdapter = { async execute() { executions += 1; return executions === 1 ? { status: 'failed' as const, summary: 'broken', artifacts: [], evidence: [] } : { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const task = await runtime.createGoal({ objective: 'recover automatically' }, {})
    expect(task.revision).toBe(2)
    expect(task.state).toBe('SUCCEEDED')
    expect(task.tasks[0]?.objective).toBe('replacement work')
  })
  test('holds an external-effect automatic replan for confirmation', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'external replacement'), sideEffectClass: 'external_effect' as const }] } } }
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } })
    const task = await runtime.createGoal({ objective: 'requires confirmation' })
    const replan = await runtime.requestAutomaticReplan(task.id, { task: task.tasks[0]!, reason: 'evidence contradicts result' })
    expect(replan.state).toBe('AWAITING_CONFIRMATION')
  })
  test('keeps a scheduler-triggered unsafe automatic replan awaiting confirmation instead of failing the goal', async () => {
    const planner: PlannerAdapter = {
      async plan(input) {
        // Initial plan: one read-only task that fails terminally.
        if (input.baseRevision === undefined) return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] }
        // Replan candidate: external-effect task -> classified unsafe -> await confirmation.
        return { goalId: input.goalId, revision: 2, tasks: [{ ...strictTask('b', 'external replacement'), sideEffectClass: 'external_effect' as const }] }
      },
    }
    const execution: ExecutionAdapter = { async execute(input) { return input.taskId === 'a' ? { status: 'failed' as const, summary: 'broken', artifacts: [], evidence: [] } : { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const created = await runtime.createGoal({ objective: 'needs confirmation' })
    await runtime.runUntilIdle(created.id, {})
    const awaiting = runtime.getStatus(created.id)!
    expect(awaiting.state).toBe('AWAITING_CONFIRMATION')
    expect(awaiting.pendingProposal?.revision).toBe(2)
    expect(awaiting.availableActions).toContain('confirm')
    // The proposal must remain confirmable; confirming applies revision 2 and resumes execution.
    const confirmed = await runtime.confirmGoal(created.id, {})
    expect(confirmed.state).toBe('SUCCEEDED')
  })
  test('pauses a goal when the automatic replan planner itself fails, instead of failing it', async () => {
    const planner: PlannerAdapter = {
      async plan(input) {
        if (input.baseRevision === undefined) return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] }
        throw new Error('planner unavailable')
      },
    }
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed' as const, summary: 'broken', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const created = await runtime.createGoal({ objective: 'planner fails' })
    await runtime.runUntilIdle(created.id, {})
    const paused = runtime.getStatus(created.id)!
    expect(paused.state).toBe('PAUSED')
    expect(paused.decisions.some(decision => decision.type === 'automatic_replan_failed')).toBe(true)
  })
  test('forwards a per-task execution timeoutMs to the child adapter', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'heavy download'), timeoutMs: 900_000 }] } } }
    let receivedTimeout: number | undefined
    const execution: ExecutionAdapter = { async execute(input) { receivedTimeout = input.timeoutMs; return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const created = await runtime.createGoal({ objective: 'honors timeout override' })
    await runtime.runUntilIdle(created.id, {})
    expect(receivedTimeout).toBe(900_000)
    expect(runtime.getStatus(created.id)?.state).toBe('SUCCEEDED')
  })
  test('rejects a child artifact whose type is not in the V1 set with the valid list', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded' as const, summary: 'done', artifacts: [{ type: 'markdown', content: 'oops' }], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const created = await runtime.createGoal({ objective: 'artifact contract' })
    await runtime.runUntilIdle(created.id, {})
    const failed = runtime.getStatus(created.id)!
    expect(failed.state).toBe('FAILED')
    const reason = failed.attempts.flatMap(attempt => attempt.summary === undefined ? [] : [attempt.summary]).join('\n')
    expect(reason).toContain('markdown')
    expect(reason).toContain('analysis')
    expect(reason).toContain('note')
  })
  test('holds a valid initial plan until explicit confirmation', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'ship', planningMode: 'require_confirmation' })
    expect(goal.state).toBe('AWAITING_CONFIRMATION')
    await runtime.confirmGoal(goal.id)
    expect(runtime.getStatus(goal.id)?.state).toBe('RUNNING')
  })

  test('exposes pause as a running task control', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } })
    const goal = await runtime.createGoal({ objective: 'pause me', planningMode: 'require_confirmation' })
    const running = await runtime.confirmGoal(goal.id)

    expect(running.availableActions).toContain('pause')
  })

  test('runs every superstep and terminalizes a successful goal', async () => {
    const calls: string[] = []
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'first'), strictTask('b', 'second', ['a'])] } } }
    const execution: ExecutionAdapter = { async execute(input) { calls.push(input.taskId); return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'ship' })
    await runtime.runUntilIdle(goal.id)
    expect(calls).toEqual(['a', 'b'])
    expect(runtime.getStatus(goal.id)?.state).toBe('SUCCEEDED')
  })

  test('planner failure returns a discoverable durable failed goal', async () => {
    const planner: PlannerAdapter = { async plan() { throw new Error('bad plan') } }
    const execution: ExecutionAdapter = { async execute() { throw new Error('unreachable') } }
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'ship' })
    expect(goal.state).toBe('FAILED')
    expect(goal.recentEvents.at(-1)?.payload).toMatchObject({ phase: 'planning', reason: 'bad plan' })
  })

  test('forwards a stopped conversation signal to initial planning', async () => {
    let receivedSignal: AbortSignal | undefined
    const planner: PlannerAdapter = { async plan(input) {
      receivedSignal = (input as { signal?: AbortSignal }).signal
      if (receivedSignal?.aborted) throw new Error('conversation stopped')
      return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] }
    } }
    const controller = new AbortController()
    controller.abort('user stopped generation')
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } })

    const goal = await runtime.createGoal({ objective: 'stop while planning', planningMode: 'require_confirmation' }, {}, controller.signal)

    expect(receivedSignal).toBe(controller.signal)
    expect(goal.state).toBe('PAUSED')
    expect(goal.pauseReason).toBe('planning interrupted by conversation stop')
  })

  test('drives rounds when a live parent resumes an already-running goal', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const calls: string[] = []
    const execution: ExecutionAdapter = { async execute(input) { calls.push(input.taskId); return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    // A web-side confirm marks the goal RUNNING without a live parent, so no round dispatches.
    const goal = await runtime.createGoal({ objective: 'web marked running', planningMode: 'require_confirmation' })
    const running = await runtime.confirmGoal(goal.id)
    expect(running.state).toBe('RUNNING')
    expect(calls).toEqual([])
    // A later model-side resume with a live parent must drive the DAG, not fail with "not paused".
    const driven = await runtime.resumeGoal(goal.id, {})
    expect(calls).toEqual(['a'])
    expect(driven.state).toBe('SUCCEEDED')
  })

  test('idempotently accepts a web-side resume of an already-running goal without a live parent', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } })
    const goal = await runtime.createGoal({ objective: 'double resume', planningMode: 'require_confirmation' })
    await runtime.confirmGoal(goal.id)
    const again = await runtime.resumeGoal(goal.id)
    expect(again.state).toBe('RUNNING')
  })

  test('pauses an executing goal on conversation stop without automatic replanning', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute(input) {
      started()
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'failed', summary: 'subagent request was aborted before child publication', artifacts: [], evidence: [] }
    } }
    const controller = new AbortController()
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const pending = runtime.createGoal({ objective: 'stop running task' }, {}, controller.signal)
    await running
    controller.abort('user stopped generation')
    const goal = await pending

    expect(goal.state).toBe('PAUSED')
    expect(goal.revision).toBe(1)
    expect(goal.tasks[0]?.state).toBe('PENDING')
    expect(goal.decisions.some(decision => decision.type === 'automatic_replan')).toBe(false)
  })

  test('pauses instead of replanning when an infrastructure failure exhausts its attempt budget', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed', summary: '429 AccountQuotaExceeded', failureKind: 'infrastructure', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const goal = await runtime.createGoal({ objective: 'quota exhausted' }, {})

    expect(goal.state).toBe('PAUSED')
    expect(goal.pauseReason).toContain('infrastructure')
    // The task is not terminalized: an infrastructure failure is not a
    // validation outcome, so a later resume can re-run it.
    expect(goal.tasks[0]?.state).toBe('PENDING')
    expect(goal.decisions.some(decision => decision.type === 'automatic_replan')).toBe(false)
  })

  test('pauses for a provider quota reset without consuming the task retry budget', async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString()
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed' as const, summary: 'HTTP 429 rate limit', failureKind: 'quota' as const, retryAt, failureDiagnostic: 'HTTP 429 rate limit', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const goal = await runtime.createGoal({ objective: 'wait for quota reset' }, {})

    expect(goal.state).toBe('PAUSED')
    expect(goal.pauseReason).toContain(retryAt)
    expect(goal.tasks[0]?.state).toBe('PENDING')
    expect(goal.attempts).toHaveLength(1)
    expect(runtime.store.getQuotaRecovery(goal.id)).toMatchObject({ taskId: 'a', retryAt, diagnostic: 'HTTP 429 rate limit' })
    expect(runtime.store.listEvents(goal.id, 0, 50).map(event => event.type)).toContain('QuotaRecoveryScheduled')
    expect(runtime.store.listEvents(goal.id, 0, 50).map(event => event.type)).not.toContain('TaskRetryBudgetExhausted')
  })

  test('bounds untrusted quota recovery data before persisting it', async () => {
    const now = Date.now()
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed' as const, summary: 'HTTP 429 rate limit', failureKind: 'quota' as const, retryAt: new Date(now + 3 * 86_400_000).toISOString(), failureDiagnostic: 'HTTP 429 api_key=secret', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'sanitize quota recovery' }, {})
    const recovery = runtime.store.getQuotaRecovery(goal.id)!

    expect(Date.parse(recovery.retryAt)).toBeLessThan(now + 86_400_000)
    expect(recovery.diagnostic).not.toContain('secret')
  })

  test('automatically resumes a quota-paused task once with its live parent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
    try {
      let executions = 0
      const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
      const execution: ExecutionAdapter = { async execute() {
        executions += 1
        return executions === 1
          ? { status: 'failed' as const, summary: 'HTTP 429 rate limit', failureKind: 'quota' as const, retryAt: '2026-09-01T10:01:00.000Z', failureDiagnostic: 'HTTP 429 rate limit', artifacts: [], evidence: [] }
          : { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] }
      } }
      const runtime = new LongTaskRuntime(planner, execution)
      const created = await runtime.createGoal({ objective: 'recover automatically', planningMode: 'require_confirmation' })
      await runtime.confirmGoal(created.id)
      runtime.startBackground(created.id, { id: 'live-parent' })
      await runtime.awaitBackground(created.id)
      expect(runtime.getStatus(created.id)?.state).toBe('PAUSED')

      await vi.advanceTimersByTimeAsync(60_000)

      expect(executions).toBe(2)
      expect(runtime.getStatus(created.id)?.state).toBe('SUCCEEDED')
    } finally {
      vi.useRealTimers()
    }
  })

  test('cancelling a quota-paused goal prevents its scheduled retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
    try {
      let executions = 0
      const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
      const execution: ExecutionAdapter = { async execute() { executions += 1; return { status: 'failed' as const, summary: 'HTTP 429 rate limit', failureKind: 'quota' as const, retryAt: '2026-09-01T10:01:00.000Z', artifacts: [], evidence: [] } } }
      const runtime = new LongTaskRuntime(planner, execution)
      const created = await runtime.createGoal({ objective: 'cancel quota wait', planningMode: 'require_confirmation' })
      await runtime.confirmGoal(created.id)
      runtime.startBackground(created.id, { id: 'live-parent' })
      await runtime.awaitBackground(created.id)
      runtime.cancelGoal(created.id)

      await vi.advanceTimersByTimeAsync(60_000)

      expect(executions).toBe(1)
      expect(runtime.getStatus(created.id)?.state).toBe('CANCELLED')
      expect(runtime.getStatus(created.id)?.quotaRecovery).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test('retries an infrastructure failure after a backoff delay and succeeds', async () => {
    let executions = 0
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'flaky'), retryPolicy: { maxAttempts: 3 } }] } } }
    const execution: ExecutionAdapter = { async execute() {
      executions += 1
      return executions === 1
        ? { status: 'failed' as const, summary: '429 rate limit', failureKind: 'infrastructure' as const, artifacts: [], evidence: [] }
        : { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] }
    } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true, retryBackoffMs: 5 })
    const goal = await runtime.createGoal({ objective: 'backoff' }, {})

    expect(goal.state).toBe('SUCCEEDED')
    const retryEvents = runtime.store.listEvents(goal.id, 0, 200).filter(event => event.type === 'TaskRetryScheduled')
    expect(retryEvents).toHaveLength(1)
    expect(retryEvents[0]?.payload).toMatchObject({ failureKind: 'infrastructure' })
    expect(retryEvents[0]?.payload.retryInMs).toBeGreaterThanOrEqual(5)
    expect(retryEvents[0]?.payload.retryAfter).toEqual(expect.any(String))
  })

  test('records the child session once per attempt despite the settle-time id', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const execution: ExecutionAdapter = { async execute(input) {
      input.onSessionId?.('child-session-1')
      return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [], dshSessionId: 'child-session-1' }
    } }
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'dedupe session' }, {})

    const sessionEvents = runtime.store.listEvents(goal.id, 0, 200).filter(event => event.type === 'TaskAttemptSessionRecorded')
    expect(sessionEvents).toHaveLength(1)
    expect(sessionEvents[0]?.payload).toMatchObject({ dshSessionId: 'child-session-1' })
  })

  test('does not append a stale checkpoint after a replan proposal supersedes the round', async () => {
    const planner: PlannerAdapter = {
      async plan(input) {
        if (input.baseRevision === undefined) return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] }
        return { goalId: input.goalId, revision: 2, tasks: [{ ...strictTask('b', 'external replacement'), sideEffectClass: 'external_effect' as const }] }
      },
    }
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed', summary: 'broken', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const goal = await runtime.createGoal({ objective: 'checkpoint' })
    await runtime.runUntilIdle(goal.id, {})

    expect(runtime.getStatus(goal.id)?.state).toBe('AWAITING_CONFIRMATION')
    const events = runtime.store.listEvents(goal.id, 0, 300)
    const proposalIndex = events.findLastIndex(event => event.type === 'PlanProposed')
    expect(proposalIndex).toBeGreaterThan(-1)
    expect(events.slice(proposalIndex + 1).some(event => event.type === 'CheckpointCreated')).toBe(false)
  })

  test('auto-applies a replan that only rewrites the text of a completed task and keeps its original objective', async () => {
    let planningCalls = 0
    const planner: PlannerAdapter = { async plan(input) {
      planningCalls += 1
      if (planningCalls === 1) return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work'), { ...strictTask('b', 'second'), priority: 1 }] }
      return { goalId: input.goalId, revision: 2, tasks: [{ ...strictTask('a', 'work') }, { ...strictTask('b', 'second【已完成于 revision 1，保留成果】') }] }
    } }
    // Single concurrency + higher priority guarantees `b` is durably SUCCEEDED
    // before `a` fails and triggers the automatic replan.
    const failedOnce = new Set<string>()
    const execution: ExecutionAdapter = { async execute(input) {
      if (input.taskId === 'a' && !failedOnce.has('a')) { failedOnce.add('a'); return { status: 'failed' as const, summary: 'broken', artifacts: [], evidence: [] } }
      return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] }
    } }
    const runtime = new LongTaskRuntime(planner, execution, { autoReplan: true })
    const goal = await runtime.createGoal({ objective: 'text rewrite' }, {})

    expect(goal.state).toBe('SUCCEEDED')
    expect(goal.revision).toBe(2)
    // The planner's text edit to the completed task must neither force a
    // confirmation nor mutate the applied plan's historical objective.
    expect(goal.tasks.find(task => task.id === 'b')?.objective).toBe('second')
  })

  test('confirms without blocking and drives the remaining DAG in the background', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execution: ExecutionAdapter = { async execute(input) { started.push(input.taskId); await gate; return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const created = await runtime.createGoal({ objective: 'background', planningMode: 'require_confirmation' })

    const confirmed = await runtime.confirmGoal(created.id)
    expect(confirmed.state).toBe('RUNNING')
    expect(started).toEqual([])
    // A live parent starts a background loop instead of blocking the tool call.
    runtime.startBackground(created.id, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toEqual(['a'])
    release()
    await runtime.awaitBackground(created.id)
    expect(runtime.getStatus(created.id)?.state).toBe('SUCCEEDED')
  })
  test('caps a per-task timeout at the configured maximum wall time', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'heavy download'), timeoutMs: 900_000 }] } } }
    let receivedTimeout: number | undefined
    const execution: ExecutionAdapter = { async execute(input) { receivedTimeout = input.timeoutMs; return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { maxWallTimeMs: 1_000 })
    const created = await runtime.createGoal({ objective: 'cap timeout override' })

    await runtime.runUntilIdle(created.id, {})

    expect(receivedTimeout).toBe(1_000)
    expect(runtime.getStatus(created.id)?.attempts[0]?.maxWallExpiresAt).toBeDefined()
  })
  test('never automatically retries a failed external-effect task', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'send request'), sideEffectClass: 'external_effect', retryPolicy: { maxAttempts: 3 } }] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed' as const, summary: 'network failure', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const created = await runtime.createGoal({ objective: 'do not replay effects' })

    await runtime.runUntilIdle(created.id, {})

    expect(runtime.getStatus(created.id)?.state).toBe('PAUSED')
    expect(runtime.getStatus(created.id)?.tasks[0]?.state).toBe('BLOCKED')
    expect(runtime.store.listEvents(created.id, 0, 100).some(event => event.type === 'TaskRetryScheduled')).toBe(false)
  })

  test('background watchdog reconciles an idle child while its execution promise is still pending', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } } }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execution: ExecutionAdapter = { async execute() { await gate; return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { idleTimeoutMs: 20, maxWallTimeMs: 60_000 })
    const created = await runtime.createGoal({ objective: 'watch idle child', planningMode: 'require_confirmation' })

    await runtime.confirmGoal(created.id)
    runtime.startBackground(created.id, {})
    await new Promise(resolve => setTimeout(resolve, 100))

    // Read the projection directly so this assertion cannot itself trigger a
    // reconciliation through getStatus().
    expect(runtime.store.getGoal(created.id)?.state).toBe('PAUSED')
    expect(runtime.store.listEvents(created.id, 0, 100).some(event => event.type === 'TaskAttemptTimedOut')).toBe(true)
    await expect(Promise.race([
      runtime.awaitBackground(created.id)!,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('background loop did not settle')), 100)),
    ])).resolves.toBeUndefined()
    release()
  })
})
