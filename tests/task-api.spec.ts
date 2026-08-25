import { describe, expect, test } from 'vitest'
import { TaskControlApi } from '../src/task-api.js'
import { LongTaskRuntime, type GoalView } from '../src/runtime.js'
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

  test('binds the session that confirms or resumes a historical task so its jump target resolves', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'continue me', planningMode: 'require_confirmation' }, { sessionId: 'origin' })

    // A second conversation confirms the waiting plan and becomes its current binding.
    const confirmed = await api.update({ taskId: created.id, expectedRevision: created.controlRevision, action: 'confirm' }, { sessionId: 'next' })
    expect(confirmed.kind).toBe('applied')
    if (confirmed.kind !== 'applied') throw new Error('expected applied confirm')
    expect(confirmed.task.state).toBe('RUNNING')
    expect(runtime.store.getCurrentTaskForSession('next')?.taskId).toBe(created.id)
    expect(runtime.getStatus(created.id)?.sessionLinks).toContainEqual({ sessionId: 'next', kind: 'attached' })

    // Pausing is a management action: it never rebinds the invoking session.
    const paused = await api.update({ taskId: created.id, expectedRevision: confirmed.task.controlRevision, action: 'pause' }, { sessionId: 'bystander' })
    expect(paused.kind).toBe('applied')
    expect(runtime.store.getCurrentTaskForSession('bystander')).toBeUndefined()

    // Resuming from yet another session links and binds it while preserving origin provenance.
    const resumed = await api.update({ taskId: created.id, expectedRevision: (paused as { task: GoalView }).task.controlRevision, action: 'resume' }, { sessionId: 'next' })
    expect(resumed.kind).toBe('applied')
    if (resumed.kind !== 'applied') throw new Error('expected applied resume')
    expect(runtime.store.getCurrentTaskForSession('next')?.taskId).toBe(created.id)
    const links = runtime.getStatus(created.id)?.sessionLinks.map(link => link.sessionId) ?? []
    expect(links).toContain('origin')
    expect(links).toContain('next')
  })

  test('accepting a replan from another session binds that session as current', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'replan me', planningMode: 'require_confirmation' }, { sessionId: 'origin' })
    const edited = await api.editGoal({ taskId: created.id, expectedRevision: created.controlRevision, objective: 'revised goal', reason: 'scope change' }, { sessionId: 'editor' })
    expect(edited.kind).toBe('applied')
    // Editing alone does not hijack the session binding.
    expect(runtime.store.getCurrentTaskForSession('editor')).toBeUndefined()
    const accepted = await api.acceptReplan({ taskId: created.id, expectedRevision: (edited as { task: GoalView }).task.controlRevision }, { sessionId: 'editor' })
    expect(accepted.kind).toBe('applied')
    if (accepted.kind !== 'applied') throw new Error('expected applied replan acceptance')
    expect(runtime.store.getCurrentTaskForSession('editor')?.taskId).toBe(created.id)
  })

  test('management actions never bind the invoking session', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'manage me', planningMode: 'require_confirmation' }, { sessionId: 'origin' })
    const cancelled = await api.update({ taskId: created.id, expectedRevision: created.controlRevision, action: 'cancel' }, { sessionId: 'bystander' })
    expect(cancelled.kind).toBe('applied')
    if (cancelled.kind !== 'applied') throw new Error('expected applied cancel')
    expect(runtime.store.getCurrentTaskForSession('bystander')).toBeUndefined()
    expect(runtime.getStatus(created.id)?.sessionLinks).toEqual([{ sessionId: 'origin', kind: 'origin' }])
  })

  test('lists durable events as a model-friendly summary without raw context payloads', async () => {
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [], dshSessionId: 'child-session-1' } } })
    const api = new TaskControlApi(runtime)
    const goal = await runtime.createGoal({ objective: 'events', planningMode: 'auto' }, {})

    const page = api.listEvents({ taskId: goal.id }, {})
    expect(page).not.toBeNull()
    const types = page!.items.map(item => item.type)
    expect(types).toContain('TaskAttemptStarted')
    expect(types).toContain('TaskCompleted')
    // The model-facing projection never leaks full context or inline artifact content.
    for (const item of page!.items) {
      expect(item.payload.context).toBeUndefined()
      expect(item.payload.content).toBeUndefined()
      expect(item.payload.tasks).toBeUndefined()
    }
  })

  test('pages events with a next cursor and filters by task node', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const goal = await runtime.createGoal({ objective: 'paging', planningMode: 'auto' }, {})

    const page1 = api.listEvents({ taskId: goal.id, limit: 1 }, {})
    expect(page1!.items).toHaveLength(1)
    expect(page1!.nextCursor).toBe(page1!.items[0]!.seq)
    const cursor1 = page1!.nextCursor!
    const page2 = api.listEvents({ taskId: goal.id, cursor: cursor1, limit: 1 }, {})
    expect(page2!.items).toHaveLength(1)
    expect(page2!.items[0]!.seq).toBeGreaterThan(cursor1)
    const cursor2 = page2!.nextCursor!
    const page3 = api.listEvents({ taskId: goal.id, cursor: cursor2 }, {})
    expect(page3!.nextCursor).toBeUndefined()
  })

  test('lists child session ids of attempts for jump-away visibility', async () => {
    const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [], dshSessionId: 'child-session-9' } } })
    const api = new TaskControlApi(runtime)
    const goal = await runtime.createGoal({ objective: 'sessions', planningMode: 'auto' }, {})

    const view = api.listAttemptSessions({ taskId: goal.id }, {})
    expect(view?.attempts).toHaveLength(1)
    expect(view?.attempts[0]).toMatchObject({ taskId: 'research', state: 'SUCCEEDED', dshSessionId: 'child-session-9' })
  })

  test('rejects reading events or attempt sessions of a task in another workspace scope', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const goal = await api.create({ objective: 'scoped', planningMode: 'require_confirmation', workspaceScope: 'D:/repo' }, { workspaceScope: 'D:/repo' })

    expect(() => api.listEvents({ taskId: goal.id }, { workspaceScope: 'D:/other' })).toThrow(/workspace scope/)
    expect(() => api.listAttemptSessions({ taskId: goal.id }, { workspaceScope: 'D:/other' })).toThrow(/workspace scope/)
  })

  test('returns null for an unknown task when listing events or attempt sessions', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    expect(api.listEvents({ taskId: 'lt_missing' }, {})).toBeNull()
    expect(api.listAttemptSessions({ taskId: 'lt_missing' }, {})).toBeNull()
  })
})
