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
})
