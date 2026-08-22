import { describe, expect, test } from 'vitest'
import { LongTaskRuntime } from '../src/runtime.js'
import type { ExecutionAdapter, PlannerAdapter } from '../src/adapters.js'

describe('LongTaskRuntime', () => {
  test('holds a valid initial plan until explicit confirmation', async () => {
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [] }] } } }
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'ship', planningMode: 'require_confirmation' })
    expect(goal.state).toBe('AWAITING_CONFIRMATION')
    await runtime.confirmGoal(goal.id)
    expect(runtime.getStatus(goal.id)?.state).toBe('RUNNING')
  })

  test('runs every superstep and terminalizes a successful goal', async () => {
    const calls: string[] = []
    const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'first', dependsOn: [] }, { id: 'b', objective: 'second', dependsOn: ['a'] }] } } }
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
})
