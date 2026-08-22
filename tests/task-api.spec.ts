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

  test('records an interruption as a durable fact and applies the configured recovery outcome', async () => {
    const runtime = new LongTaskRuntime(planner, execution)
    const api = new TaskControlApi(runtime)
    const created = await api.create({ objective: 'interruptible', workspaceScope: 'D:/repo', planningMode: 'require_confirmation' }, { workspaceScope: 'D:/repo' })
    const interrupted = api.interrupt(created.id, 'user_stop', 'wait_for_live_parent')
    expect(interrupted.state).toBe('PAUSED')
    expect(interrupted.recentEvents.some(event => event.type === 'ExecutionInterrupted')).toBe(true)
    expect(interrupted.pauseReason).toContain('user_stop')
  })
})
