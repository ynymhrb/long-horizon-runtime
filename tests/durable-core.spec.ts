import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RuntimeEventStore } from '../src/event-store.js'
import { LongTaskRuntime } from '../src/runtime.js'
import { ArtifactStore } from '../src/artifacts.js'
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
        { id: 'a', objective: 'first', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
        { id: 'b', objective: 'second', dependsOn: ['a'], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
      ],
    }
  },
}

describe('durable runtime core', () => {
  test('archives a running goal by cancelling it first and can restore it', async () => {
    const store = createStore()
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } } }, { store })
    const goal = await runtime.createGoal({ objective: 'archive me', planningMode: 'require_confirmation' })

    const archived = runtime.archiveGoal(goal.id, new Date('2026-08-23T00:00:00.000Z'))
    expect(archived.state).toBe('CANCELLED')
    expect(archived.archivedAt).toBe('2026-08-23T00:00:00.000Z')
    expect(runtime.listGoals()).toEqual([])
    expect(runtime.restoreGoal(goal.id).archivedAt).toBeUndefined()
  })
  test('physically removes expired archive artifacts only after their final reference is gone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'long-task-runtime-retention-'))
    directories.push(directory)
    const store = new RuntimeEventStore(join(directory, 'runtime.sqlite'))
    stores.push(store)
    const artifactDirectory = join(directory, 'artifacts')
    const artifact = new ArtifactStore(artifactDirectory, 1).put({ id: 'artifact', taskId: 'a', type: 'analysis', content: 'retained file' })
    store.append([
      { type: 'GoalCreated', goalId: 'expired', payload: { objective: 'expired', planningMode: 'auto' } },
      { type: 'ArtifactProduced', goalId: 'expired', taskId: 'a', payload: { id: 'artifact', attemptId: 'attempt', type: 'analysis', contentHash: artifact.contentHash, storage: artifact.storage, path: artifact.path } },
      { type: 'GoalArchived', goalId: 'expired', payload: { archivedAt: '2026-07-01T00:00:00.000Z' } },
    ])
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'unused', artifacts: [], evidence: [] } } }, { store, artifactDirectory })
    expect(runtime.purgeExpiredArchives(new Date('2026-08-23T00:00:00.000Z'))).toEqual(['expired'])
    expect(existsSync(artifact.path!)).toBe(false)
  })
  test('uses the built-in required validator without deployment-specific validator registration', async () => {
    const store = createStore()
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const strictPlanner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }] } } }
    const runtime = new LongTaskRuntime(strictPlanner, execution, { store })
    const goal = await runtime.createGoal({ objective: 'ship' }, {})
    expect(goal.state).toBe('SUCCEEDED')
  })

  test('pauses a recovered safe attempt until a live parent resumes it without rerunning completed work', async () => {
    const store = createStore()
    store.append([
      { type: 'GoalCreated', goalId: 'g', payload: { objective: 'ship', planningMode: 'auto' } },
      { type: 'PlanRevisionApplied', goalId: 'g', payload: { revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 2 }, sideEffectClass: 'idempotent', validator: 'required' }] } },
      { type: 'TaskAttemptStarted', goalId: 'g', taskId: 'a', payload: { attemptId: 'lost', revision: 1, context: {} } },
    ])
    let executions = 0
    const runtime = new LongTaskRuntime(planner, { async execute() { executions += 1; return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }, { store })
    await runtime.recover()
    expect(store.getGoal('g')?.state).toBe('PAUSED')
    await runtime.resumeGoal('g', {})
    expect(store.getGoal('g')?.state).toBe('SUCCEEDED')
    expect(executions).toBe(1)
  })

  test('terminalizes an attempt when artifact persistence throws after it started', async () => {
    const store = createStore()
    const strictPlanner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }] } } }
    const runtime = new LongTaskRuntime(strictPlanner, { async execute() { return { status: 'succeeded', summary: 'done', artifacts: [{ type: 'analysis', content: 'x', mimeType: 'not a mime' }], evidence: [] } } }, { store, artifactDirectory: directories[0]! })
    const goal = await runtime.createGoal({ objective: 'ship' }, {})
    expect(store.listAttempts('a', goal.id)[0]?.state).toBe('FAILED')
    expect(goal.state).toBe('FAILED')
  })

  test('continues an independent branch after another branch exhausts retries', async () => {
    const store = createStore()
    const twoBranchPlanner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [
      { id: 'bad', objective: 'bad', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
      { id: 'good', objective: 'good', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
    ] } } }
    const runtime = new LongTaskRuntime(twoBranchPlanner, { async execute(input) { return input.taskId === 'bad' ? { status: 'failed', summary: 'no', artifacts: [], evidence: [] } : { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }, { store })
    const goal = await runtime.createGoal({ objective: 'ship' }, {})
    expect(store.getTask(goal.id, 'good')?.state).toBe('SUCCEEDED')
    expect(goal.state).toBe('FAILED')
  })

  test('a graph replacement resets only the replaced branch and deactivates its old artifact', async () => {
    const store = createStore()
    store.append([
      { type: 'GoalCreated', goalId: 'g2', payload: { objective: 'ship', planningMode: 'auto' } },
      { type: 'PlanRevisionApplied', goalId: 'g2', payload: { revision: 1, tasks: [
        { id: 'a', objective: 'a', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required', state: 'SUCCEEDED' },
        { id: 'b', objective: 'b', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required', state: 'SUCCEEDED' },
      ] } },
      { type: 'ArtifactProduced', goalId: 'g2', taskId: 'a', payload: { id: 'old-a', attemptId: 'old', type: 'analysis', contentHash: 'a', storage: 'inline', content: 'a' } },
      { type: 'ValidationRecorded', goalId: 'g2', taskId: 'a', payload: { attemptId: 'old', ok: true, validator: 'required' } },
    ])
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }, { store })
    runtime.mutatePlan('g2', { kind: 'replaceTask', taskId: 'a', replacement: { id: 'a', objective: 'new a', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }, reason: 'corrected', evidenceRefs: [] })
    expect(store.getTask('g2', 'a')?.state).toBe('PENDING')
    expect(store.getTask('g2', 'b')?.state).toBe('SUCCEEDED')
    expect(store.listActiveValidatedArtifacts('g2')).toEqual([])
    expect(store.getPlan('g2', 1)?.tasks.find(task => task.id === 'a')?.state).toBe('SUCCEEDED')
  })
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
    const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { store, recoveryValidator: async () => 'indeterminate' })
    await runtime.recover({})
    expect(store.getGoal('g')?.state).toBe('PAUSED')
    expect(store.listAttempts('deploy')[0]?.state).toBe('INTERRUPTED')
    await expect(runtime.resumeGoal('g', {})).rejects.toThrow('explicit recovery resolution')
    expect(store.getGoal('g')?.state).toBe('PAUSED')
    await runtime.resumeGoal('g', {}, 'retry')
    expect(store.getGoal('g')?.state).toBe('SUCCEEDED')
  })

  test('fences an in-flight attempt from an obsolete plan revision', async () => {
    const store = createStore()
    let finish!: () => void
    const execution: ExecutionAdapter = { async execute() {
      await new Promise<void>(resolve => { finish = resolve })
      return { status: 'succeeded', summary: 'late result', artifacts: [], evidence: [] }
    } }
    const oneTaskPlanner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [
      { id: 'a', objective: 'work', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
    ] } } }
    const runtime = new LongTaskRuntime(oneTaskPlanner, execution, { store })
    const goal = await runtime.createGoal({ objective: 'ship' })
    const round = (runtime as unknown as { scheduler: { runRound(goalId: string, legacyTasks?: undefined, parent?: unknown): Promise<boolean> } }).scheduler.runRound(goal.id, undefined, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    runtime.mutatePlan(goal.id, { kind: 'replaceTask', taskId: 'a', replacement: { id: 'a', objective: 'new work', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }, reason: 'change', evidenceRefs: [] })
    finish()
    await round
    expect(store.getTask(goal.id, 'a')?.state).toBe('PENDING')
    expect(store.listAttempts('a', goal.id)[0]?.state).toBe('SUPERSEDED')
  })

  test('confirmation preserves stale task ids from a proposed mutation', async () => {
    const store = createStore()
    store.append([
      { type: 'GoalCreated', goalId: 'g-confirm', payload: { objective: 'ship', planningMode: 'require_confirmation' } },
      { type: 'PlanRevisionApplied', goalId: 'g-confirm', payload: { revision: 1, tasks: [{ id: 'a', objective: 'a', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required', state: 'SUCCEEDED' }] } },
      { type: 'ArtifactProduced', goalId: 'g-confirm', taskId: 'a', payload: { id: 'old-a', attemptId: 'old', type: 'analysis', contentHash: 'a', storage: 'inline', content: 'a' } },
      { type: 'ValidationRecorded', goalId: 'g-confirm', taskId: 'a', payload: { attemptId: 'old', ok: true, validator: 'required' } },
    ])
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded', summary: 'done', artifacts: [], evidence: [] } } }, { store })
    runtime.mutatePlan('g-confirm', { kind: 'replaceTask', taskId: 'a', replacement: { id: 'a', objective: 'replacement', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }, reason: 'stale', evidenceRefs: [] })
    await runtime.confirmGoal('g-confirm')
    expect(store.listActiveValidatedArtifacts('g-confirm')).toEqual([])
  })

  test('uses planner task creation order to break equal priority ties', async () => {
    const store = createStore()
    const calls: string[] = []
    const orderedPlanner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [
      { id: 'z-first', objective: 'first', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
      { id: 'a-second', objective: 'second', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
    ] } } }
    const runtime = new LongTaskRuntime(orderedPlanner, { async execute(input) { calls.push(input.taskId); return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }, { store, maxConcurrentTasks: 1 })
    const goal = await runtime.createGoal({ objective: 'ship' }, {})
    expect(calls).toEqual(['z-first', 'a-second'])
    expect(store.getGoal(goal.id)?.state).toBe('SUCCEEDED')
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

  test('does not block a dependent while a retry remains available', async () => {
    const store = createStore()
    let calls = 0
    const execution: ExecutionAdapter = { async execute(input) { calls += 1; return input.taskId === 'a' && calls === 1 ? { status: 'failed', summary: 'temporary', artifacts: [], evidence: [] } : { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }
    const runtime = new LongTaskRuntime(planner, execution, { store, defaultRetryPolicy: { maxAttempts: 2 } })
    const goal = await runtime.createGoal({ objective: 'ship' })
    await runtime.runUntilIdle(goal.id)
    expect(store.getTask(goal.id, 'b')?.state).toBe('SUCCEEDED')
  })

  test('invalidating a branch deactivates only that branch artifacts', async () => {
    const store = createStore()
    store.append([
      { type: 'GoalCreated', goalId: 'g', payload: { objective: 'ship', planningMode: 'auto' } },
      { type: 'PlanRevisionApplied', goalId: 'g', payload: { revision: 1, tasks: [{ id: 'a', objective: 'a', dependsOn: [], priority: 0, sideEffectClass: 'read_only', inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, validator: 'required', state: 'SUCCEEDED' }, { id: 'b', objective: 'b', dependsOn: [], priority: 0, sideEffectClass: 'read_only', inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, validator: 'required', state: 'SUCCEEDED' }] } },
      { type: 'ArtifactProduced', goalId: 'g', taskId: 'a', payload: { id: 'aa', attemptId: 'x', type: 'analysis', contentHash: 'a', storage: 'inline', content: 'a' } },
      { type: 'ValidationRecorded', goalId: 'g', taskId: 'a', payload: { attemptId: 'x', ok: true, validator: 'x' } },
      { type: 'ArtifactProduced', goalId: 'g', taskId: 'b', payload: { id: 'bb', attemptId: 'y', type: 'analysis', contentHash: 'b', storage: 'inline', content: 'b' } },
      { type: 'ValidationRecorded', goalId: 'g', taskId: 'b', payload: { attemptId: 'y', ok: true, validator: 'x' } },
    ])
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } } }, { store })
    runtime.invalidateTask('g', 'a', 'stale')
    expect(store.listActiveValidatedArtifacts('g').map(artifact => artifact.id)).toEqual(['bb'])
    expect(store.getTask('g', 'b')?.state).toBe('SUCCEEDED')
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
    expect(goal.state).toBe('SUCCEEDED')
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
