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

  test('projects compact attempt progress and lease timestamps from append-only events', () => {
    const runtime = store()
    runtime.append([
      { type: 'TaskAttemptStarted', goalId: 'g', taskId: 't', payload: { attemptId: 'a', startedAt: '2026-08-31T00:00:00.000Z', leaseExpiresAt: '2026-08-31T00:05:00.000Z', maxWallExpiresAt: '2026-08-31T05:00:00.000Z' } },
      { type: 'AttemptProgressRecorded', goalId: 'g', taskId: 't', payload: { attemptId: 'a', at: '2026-08-31T00:01:00.000Z', leaseExpiresAt: '2026-08-31T00:06:00.000Z', phase: 'tool', message: 'running tests' } },
    ])

    expect(runtime.listAttempts('t', 'g')[0]).toMatchObject({
      startedAt: '2026-08-31T00:00:00.000Z', lastActivityAt: '2026-08-31T00:01:00.000Z', leaseExpiresAt: '2026-08-31T00:06:00.000Z', maxWallExpiresAt: '2026-08-31T05:00:00.000Z', latestProgress: { phase: 'tool', message: 'running tests' },
    })
  })

  test('replays one current task per session without deleting historic links', () => {
    const runtime = store()
    runtime.append([
      { type: 'TaskSessionAttached', goalId: 'lt_a', payload: { sessionId: 'session-1', kind: 'attached' } },
      { type: 'TaskSessionAttached', goalId: 'lt_b', payload: { sessionId: 'session-1', kind: 'attached' } },
      { type: 'TaskSessionCurrentSet', goalId: 'lt_a', payload: { sessionId: 'session-1', controlRevision: 1 } },
      { type: 'TaskSessionCurrentSet', goalId: 'lt_b', payload: { sessionId: 'session-1', controlRevision: 2 } },
    ])

    expect(runtime.getCurrentTaskForSession('session-1')).toMatchObject({ sessionId: 'session-1', taskId: 'lt_b', controlRevision: 2 })
    expect(runtime.listSessionLinks('lt_a')).toContainEqual({ sessionId: 'session-1', kind: 'attached' })

    runtime.rebuild()
    expect(runtime.getCurrentTaskForSession('session-1')).toMatchObject({ sessionId: 'session-1', taskId: 'lt_b', controlRevision: 2 })
  })

  test('projects append-only original-goal versions while retaining its task id', () => {
    const runtime = store()
    runtime.append([
      { type: 'GoalCreated', goalId: 'lt_goal', payload: { objective: 'original goal', constraints: [], planningMode: 'auto' } },
      { type: 'GoalObjectiveRevised', goalId: 'lt_goal', payload: { version: 1, objective: 'corrected goal', reason: 'user corrected scope', source: 'user', createdAt: '2026-08-23T00:00:00.000Z' } },
    ])

    expect(runtime.getGoal('lt_goal')?.id).toBe('lt_goal')
    expect(runtime.listGoalVersions('lt_goal')).toEqual([
      { version: 0, objective: 'original goal', reason: 'initial objective', source: 'user', createdAt: expect.any(String) },
      { version: 1, objective: 'corrected goal', reason: 'user corrected scope', source: 'user', createdAt: '2026-08-23T00:00:00.000Z' },
    ])
  })

  test('hides archived goals by default and restores them before purging', () => {
    const runtime = store()
    runtime.append([
      { type: 'GoalCreated', goalId: 'lt_archive', payload: { objective: 'archive me', constraints: [], planningMode: 'auto' } },
      { type: 'GoalArchived', goalId: 'lt_archive', payload: { archivedAt: '2026-07-01T00:00:00.000Z' } },
    ])

    expect(runtime.listGoals()).toEqual([])
    expect(runtime.listGoals({ archived: true }).map(goal => goal.id)).toEqual(['lt_archive'])
    runtime.append([{ type: 'GoalRestored', goalId: 'lt_archive', payload: {} }])
    expect(runtime.listGoals().map(goal => goal.id)).toEqual(['lt_archive'])
  })

  test('purges only archives older than the supplied cutoff', () => {
    const runtime = store()
    runtime.append([
      { type: 'GoalCreated', goalId: 'lt_old', payload: { objective: 'old', constraints: [], planningMode: 'auto' } },
      { type: 'GoalArchived', goalId: 'lt_old', payload: { archivedAt: '2026-07-01T00:00:00.000Z' } },
      { type: 'GoalCreated', goalId: 'lt_recent', payload: { objective: 'recent', constraints: [], planningMode: 'auto' } },
      { type: 'GoalArchived', goalId: 'lt_recent', payload: { archivedAt: '2026-08-22T00:00:00.000Z' } },
    ])

    expect(runtime.purgeArchivedBefore('2026-08-01T00:00:00.000Z')).toEqual(['lt_old'])
    expect(runtime.getGoal('lt_old')).toBeUndefined()
    expect(runtime.listGoals({ archived: true }).map(goal => goal.id)).toEqual(['lt_recent'])
  })
})
