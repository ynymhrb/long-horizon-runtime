import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RuntimeEventStore } from '../src/event-store.js'

const directories: string[] = []
const stores: RuntimeEventStore[] = []

function store(): RuntimeEventStore {
  const directory = mkdtempSync(join(tmpdir(), 'long-task-runtime-'))
  directories.push(directory)
  const runtime = new RuntimeEventStore(join(directory, 'runtime.sqlite'))
  stores.push(runtime)
  return runtime
}

afterEach(() => {
  for (const runtime of stores.splice(0)) runtime.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('RuntimeEventStore', () => {
  test('rebuilds the same goal projection from append-only events', () => {
    const events = [
      { type: 'GoalCreated', goalId: 'g-1', payload: { objective: 'ship' } },
      { type: 'PlanApplied', goalId: 'g-1', payload: { revision: 1 } },
      { type: 'TaskAttemptStarted', goalId: 'g-1', taskId: 't-1', payload: { attemptId: 'a-1' } },
      { type: 'TaskCompleted', goalId: 'g-1', taskId: 't-1', payload: { attemptId: 'a-1' } },
    ] as const
    const runtime = store()
    runtime.append(events)
    const before = runtime.getGoal('g-1')
    runtime.rebuild()
    expect(runtime.getGoal('g-1')).toEqual(before)
  })

  test('rolls back an attempt start when the enclosing transaction throws', () => {
    const runtime = store()
    expect(() => runtime.transaction(() => {
      runtime.append([{ type: 'TaskAttemptStarted', goalId: 'g-1', taskId: 't-1', payload: { attemptId: 'a-1' } }])
      throw new Error('abort')
    })).toThrow('abort')
    expect(runtime.listAttempts('t-1')).toEqual([])
  })
})
