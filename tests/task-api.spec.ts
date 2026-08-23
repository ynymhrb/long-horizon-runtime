import { describe, expect, test } from 'vitest'
import { TaskControlApi } from '../src/task-api.js'
import { LongTaskRuntime } from '../src/runtime.js'
import type { ExecutionAdapter, PlannerAdapter } from '../src/adapters.js'

const planner: PlannerAdapter = {
  async plan(input) {
    return {
      goalId: input.goalId,
      revision: 1,
      tasks: [{
        id: 'research',
        objective: 'research',
        dependsOn: [],
        priority: 0,
        inputContract: {},
        outputContract: {},
        completionCriteria: 'done',
        retryPolicy: { maxAttempts: 1 },
        sideEffectClass: 'read_only',
        validator: 'required',
      }],
    }
  },
}

const execution: ExecutionAdapter = {
  async execute() { return { status: 'succeeded', summary: 'done', artifacts: [], evidence: [] } },
}

describe('TaskControlApi', () => {
  test('creates a cross-session task and rejects a stale control revision without mutation', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'research RAG', workspaceScope: 'D:/repo' }, { sessionId: 'session-origin', workspaceScope: 'D:/repo' })

    expect(created.id).toMatch(/^lt_/)
    expect(created.sessionLinks).toEqual([{ sessionId: 'session-origin', kind: 'origin' }])

    const attached = await api.attachSession(created.id, { sessionId: 'session-new', workspaceScope: 'D:/repo' })
    expect(attached.kind).toBe('applied')
    if (attached.kind !== 'applied') throw new Error('expected attached task')
    expect(attached.task.sessionLinks).toContainEqual({ sessionId: 'session-new', kind: 'attached' })

    const conflict = await api.update({
      taskId: created.id,
      expectedRevision: created.controlRevision,
      action: 'pause',
    }, { sessionId: 'session-new', workspaceScope: 'D:/repo' })

    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') throw new Error('expected control conflict')
    expect(conflict.current.controlRevision).toBe(attached.task.controlRevision)
    expect(conflict.current.state).toBe('AWAITING_CONFIRMATION')
  })

  test('binds an origin and attached task as the session current task', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'current task', workspaceScope: 'D:/repo' }, { sessionId: 'origin', workspaceScope: 'D:/repo' })

    expect(runtime.store.getCurrentTaskForSession('origin')?.taskId).toBe(created.id)

    const attached = await api.attachSession(created.id, { sessionId: 'next', workspaceScope: 'D:/repo' })
    expect(attached.kind).toBe('applied')
    expect(runtime.store.getCurrentTaskForSession('next')?.taskId).toBe(created.id)

    await api.clearCurrentSessionTask('next')
    expect(runtime.store.getCurrentTaskForSession('next')).toBeUndefined()
  })

  test('records an interruption as a durable fact and applies the configured recovery outcome', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'interruptible', workspaceScope: 'D:/repo', planningMode: 'require_confirmation' }, { workspaceScope: 'D:/repo' })
    const interrupted = api.interrupt(created.id, 'user_stop', 'wait_for_live_parent')
    expect(interrupted.state).toBe('PAUSED')
    expect(interrupted.recentEvents.some(event => event.type === 'ExecutionInterrupted')).toBe(true)
    expect(interrupted.pauseReason).toContain('user_stop')
  })

  test('records a context manifest before a worker receives the attempt context', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const goal = await runtime.createGoal({ objective: 'manifest', planningMode: 'auto' }, {})
    const manifest = runtime.store.listContextManifests(goal.id)
    expect(manifest).toHaveLength(1)
    expect(manifest[0]?.taskId).toBe('research')
    expect(manifest[0]?.selectionReason).toBe('direct_dependencies_and_durable_l2')
  })

  test('keeps a replan proposal pending until it is explicitly accepted or rejected', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const task = await runtime.createGoal({ objective: 'replan', planningMode: 'auto' })
    const proposed = api.proposeReplan(task.id, { kind: 'addTask', task: { id: 'review', objective: 'review', dependsOn: ['research'], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }, reason: 'review needed', evidenceRefs: [] })
    expect(proposed.state).toBe('AWAITING_CONFIRMATION')
    expect(proposed.pendingProposal?.baseRevision).toBe(1)
    const rejected = api.rejectReplan(task.id)
    expect(rejected.state).toBe('RUNNING')
    expect(rejected.pendingProposal).toBeUndefined()
  })

  test('edits the original goal and accepts its revision through the fenced control API', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const task = await api.create({ objective: 'old goal', planningMode: 'require_confirmation' }, {})
    const edited = await api.editGoal({ taskId: task.id, expectedRevision: task.controlRevision, objective: 'new goal', reason: 'correct scope' }, {})
    expect(edited.kind).toBe('applied')
    if (edited.kind !== 'applied') throw new Error('expected applied edit')
    expect(edited.task.objective).toBe('new goal')
    const accepted = await api.acceptReplan({ taskId: task.id, expectedRevision: edited.task.controlRevision }, {})
    expect(accepted.kind).toBe('applied')
    if (accepted.kind !== 'applied') throw new Error('expected accepted replan')
    expect(accepted.task.state).toBe('RUNNING')
  })
})
