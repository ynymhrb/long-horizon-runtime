import { describe, expect, test } from 'vitest'
import { Scheduler } from '../src/scheduler.js'
import type { ExecutionAdapter } from '../src/adapters.js'
import type { TaskNode } from '../src/domain.js'

function task(id: string, dependsOn: string[] = []): TaskNode {
  return { id, objective: id, dependsOn, priority: 0, sideEffectClass: 'read_only', state: 'PENDING' }
}

describe('Scheduler', () => {
  test('dispatches independent ready tasks up to its concurrency limit', async () => {
    const started: string[] = []
    const adapter: ExecutionAdapter = {
      async execute(input) {
        started.push(input.taskId)
        return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] }
      },
    }
    const scheduler = new Scheduler(adapter, 2)
    const tasks = new Map([['a', task('a')], ['b', task('b')], ['c', task('c')]])
    await scheduler.runRound('goal', tasks)
    expect(started).toEqual(['a', 'b'])
    expect(tasks.get('a')?.state).toBe('SUCCEEDED')
    expect(tasks.get('c')?.state).toBe('READY')
  })
})
