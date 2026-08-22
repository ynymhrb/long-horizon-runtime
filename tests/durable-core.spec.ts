import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RuntimeEventStore } from '../src/event-store.js'
import { LongTaskRuntime } from '../src/runtime.js'
import type { ExecutionAdapter, PlannerAdapter } from '../src/adapters.js'

const directories: string[] = []
const stores: RuntimeEventStore[] = []

function createStore(): RuntimeEventStore {
  const directory = mkdtempSync(join(tmpdir(), 'long-task-runtime-core-'))
  directories.push(directory)
  const store = new RuntimeEventStore(join(directory, 'runtime.sqlite'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const planner: PlannerAdapter = {
  async plan(input) {
    return {
      goalId: input.goalId,
      revision: 1,
      tasks: [
        { id: 'a', objective: 'first', dependsOn: [], inputContract: {}, outputContract: {}, completionCriteria: 'done' },
        { id: 'b', objective: 'second', dependsOn: ['a'], inputContract: {}, outputContract: {}, completionCriteria: 'done' },
      ],
    }
  },
}

describe('durable runtime core', () => {
  test('persists a complete plan and rebuilds task and artifact projections', () => {
    const store = createStore()
    store.append([
      { type: 'GoalCreated', goalId: 'g', payload: { objective: 'ship', planningMode: 'auto' } },
      { type: 'PlanRevisionApplied', goalId: 'g', payload: { revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [], priority: 0, sideEffectClass: 'read_only', inputContract: {}, outputContract: {}, completionCriteria: 'done' }] } },
      { type: 'TaskAttemptStarted', goalId: 'g', taskId: 'a', payload: { attemptId: 'attempt-1', revision: 1, context: {}, dshSessionId: 'session-1' } },
      { type: 'ArtifactProduced', goalId: 'g', taskId: 'a', payload: { id: 'artifact-1', attemptId: 'attempt-1', type: 'analysis', contentHash: 'hash', storage: 'inline', content: 'result' } },
      { type: 'ValidationRecorded', goalId: 'g', taskId: 'a', payload: { attemptId: 'attempt-1', ok: true, validator: 'default' } },
      { type: 'TaskCompleted', goalId: 'g', taskId: 'a', payload: { attemptId: 'attempt-1' } },
    ])
    const before = store.snapshot('g')
    store.rebuild()
    expect(store.snapshot('g')).toEqual(before)
    expect(store.getTask('g', 'a')?.state).toBe('SUCCEEDED')
    expect(store.listActiveValidatedArtifacts('g', ['a']).map(artifact => artifact.id)).toEqual(['artifact-1'])
  })

  test('creates a new durable attempt when an idempotent task retries', async () => {
    const store = createStore()
    let calls = 0
    const execution: ExecutionAdapter = {
      async execute() {
        calls += 1
        return calls === 1
          ? { status: 'failed', summary: 'temporary', artifacts: [], evidence: [] }
          : { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] }
      },
    }
    const runtime = new LongTaskRuntime(planner, execution, { store, maxConcurrentTasks: 1, defaultRetryPolicy: { maxAttempts: 2 } })
    const goal = await runtime.createGoal({ objective: 'ship' })
    await runtime.runUntilIdle(goal.id)
    expect(store.listAttempts('a')).toHaveLength(2)
    expect(store.getTask(goal.id, 'a')?.state).toBe('SUCCEEDED')
  })

  test('recovery pauses an indeterminate interrupted external effect', async () => {
    const store = createStore()
    store.append([
      { type: 'GoalCreated', goalId: 'g', payload: { objective: 'deploy', planningMode: 'auto' } },
      { type: 'PlanRevisionApplied', goalId: 'g', payload: { revision: 1, tasks: [{ id: 'deploy', objective: 'deploy', dependsOn: [], priority: 0, sideEffectClass: 'external_effect', inputContract: {}, outputContract: {}, completionCriteria: 'done' }] } },
      { type: 'TaskAttemptStarted', goalId: 'g', taskId: 'deploy', payload: { attemptId: 'attempt-1', revision: 1, context: {} } },
    ])
    const execution: ExecutionAdapter = { async execute() { throw new Error('must not replay') } }
    const runtime = new LongTaskRuntime(planner, execution, { store, recoveryValidator: async () => 'indeterminate' })
    await runtime.recover()
    expect(store.getGoal('g')?.state).toBe('PAUSED')
    expect(store.listAttempts('deploy')[0]?.state).toBe('INTERRUPTED')
  })

  test('blocks only dependent pending tasks after an exhausted failure', async () => {
    const store = createStore()
    const execution: ExecutionAdapter = { async execute() { return { status: 'failed', summary: 'permanent', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { store })
    const goal = await runtime.createGoal({ objective: 'ship' })
    await runtime.runUntilIdle(goal.id)
    expect(store.getTask(goal.id, 'a')?.state).toBe('FAILED')
    expect(store.getTask(goal.id, 'b')?.state).toBe('BLOCKED')
  })

  test('forwards a live execution parent to the adapter without storing it', async () => {
    const store = createStore()
    const parent = { ephemeral: true }
    let received: unknown
    const execution: ExecutionAdapter = { async execute(input) { received = input.parent; return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { store })
    const goal = await runtime.createGoal({ objective: 'ship' }, parent)
    expect(received).toBe(parent)
    expect(JSON.stringify(store.listAttempts('a')[0]?.context)).not.toContain('ephemeral')
    expect(goal.state).toBe('RUNNING')
  })

  test('records the child DSH session after an attempt starts', async () => {
    const store = createStore()
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [], dshSessionId: 'child-session-42' } } }
    const runtime = new LongTaskRuntime(planner, execution, { store })
    const goal = await runtime.createGoal({ objective: 'ship' }, {})
    expect(store.listAttempts('a')[0]?.dshSessionId).toBe('child-session-42')
    expect(store.listRecentEvents(goal.id).map(event => event.type)).toContain('TaskAttemptSessionRecorded')
  })
})
