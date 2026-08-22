import { describe, expect, test } from 'vitest'
import { createDshExecutionAdapter, createDshPlannerAdapter, withDshParent } from '../src/dsh-adapters.js'

describe('DSH adapters', () => {
  test('uses the current parent, parses structured planner output, and disposes the child run', async () => {
    let disposed = false
    let request: Record<string, unknown> | undefined
    const subagents = {
      async start(provider: string, received: Record<string, unknown>) {
        expect(provider).toBe('planner')
        request = received
        return {
          id: 'child-session-1',
          localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed',
            output: [],
            structured: { revision: 1, tasks: [{ id: 'research', objective: 'research', dependsOn: [] }] },
          }),
          async dispose() { disposed = true },
        }
      },
    }
    const planner = createDshPlannerAdapter(subagents as never, { providerName: 'planner' })

    const plan = await withDshParent({ id: 'parent' } as never, () => planner.plan({
      goalId: 'goal-1', objective: 'research topic', constraints: [],
    }))

    expect(plan).toMatchObject({ goalId: 'goal-1', revision: 1 })
    expect(request).toMatchObject({ parent: { id: 'parent' } })
    expect(disposed).toBe(true)
  })

  test('maps a completed execution child result into the runtime contract', async () => {
    const adapter = createDshExecutionAdapter({
      async start() {
        return {
          id: 'child-session-2', localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed', output: [],
            structured: { summary: 'complete', artifacts: [{ type: 'report', content: 'result' }], evidence: ['source'] },
          }),
          async dispose() {},
        }
      },
    } as never, { providerName: 'worker' })

    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'attempt-1', taskId: 'task-1', signal: new AbortController().signal,
      context: { objective: 'goal', task: { id: 'task-1', objective: 'do it' }, artifacts: [] },
    }))

    expect(result).toMatchObject({ status: 'succeeded', summary: 'complete', artifacts: [{ type: 'report', content: 'result' }], evidence: ['source'], dshSessionId: 'child-session-2' })
  })
})
