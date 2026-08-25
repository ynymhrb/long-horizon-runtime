import { describe, expect, test } from 'vitest'
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
})
