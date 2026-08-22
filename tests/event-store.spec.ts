import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  test('creates a missing parent directory for a file-backed database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'long-task-runtime-'))
    directories.push(directory)
    const databasePath = join(directory, 'state', 'runtime.sqlite')
    const runtime = new RuntimeEventStore(databasePath)
    stores.push(runtime)
    expect(existsSync(databasePath)).toBe(true)
  })

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

  test('scopes task attempts by goal as well as task id', () => {
    const runtime = store()
    runtime.append([
      { type: 'TaskAttemptStarted', goalId: 'g-1', taskId: 'same', payload: { attemptId: 'a-1' } },
      { type: 'TaskAttemptStarted', goalId: 'g-2', taskId: 'same', payload: { attemptId: 'a-2' } },
    ])
    expect(runtime.listAttempts('same', 'g-1').map(item => item.id)).toEqual(['a-1'])
  })

  test('replays one current task per session without deleting historic links', () => {
    const runtime = store()
    runtime.append([
      { type: 'TaskSessionAttached', goalId: 'lt_a', payload: { sessionId: 'session-1', kind: 'attached' } },
      { type: 'TaskSessionAttached', goalId: 'lt_b', payload: { sessionId: 'session-1', kind: 'attached' } },
      { type: 'TaskSessionCurrentSet', goalId: 'lt_a', payload: { sessionId: 'session-1', controlRevision: 1 } },
      { type: 'TaskSessionCurrentSet', goalId: 'lt_b', payload: { sessionId: 'session-1', controlRevision: 2 } },
    ])

    expect(runtime.getCurrentTaskForSession('session-1')).toEqual({ sessionId: 'session-1', taskId: 'lt_b', controlRevision: 2 })
    expect(runtime.listSessionLinks('lt_a')).toContainEqual({ sessionId: 'session-1', kind: 'attached' })

    runtime.rebuild()
    expect(runtime.getCurrentTaskForSession('session-1')).toEqual({ sessionId: 'session-1', taskId: 'lt_b', controlRevision: 2 })
  })
})
