import { expect, test } from 'vitest'
import { currentTaskStrip, toTaskAreaItem } from '../src/task-ui.js'
import type { GoalView } from '../src/runtime.js'
import { LongTaskRuntime } from '../src/runtime.js'
import { TaskControlApi } from '../src/task-api.js'
import { TaskUiApi } from '../src/task-ui-api.js'
import type { ExecutionAdapter, PlannerAdapter } from '../src/adapters.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { LongTaskRemote } from '../src/remote.js'
import { Context } from '@deepseek-ai/cordis'

const task = { id: 'lt_demo', objective: 'Research RAG', state: 'RUNNING', revision: 1, controlRevision: 3, sessionLinks: [], tasks: [{ id: 'research', state: 'SUCCEEDED' }, { id: 'review', state: 'PENDING' }], attempts: [], artifacts: [], decisions: [], accounting: { attemptCount: 1, succeededTaskCount: 1, failedTaskCount: 0 }, recentEvents: [], availableActions: ['cancel'] } as unknown as GoalView

test('task area projection is compact and a chat strip stays absent without an attached task', () => {
  expect(toTaskAreaItem(task)).toMatchObject({ id: 'lt_demo', completedCount: 1, taskCount: 2 })
  expect(currentTaskStrip(undefined)).toBeUndefined()
})

test('returns a bound non-terminal task strip with progress and immutable graph data', async () => {
  const planner: PlannerAdapter = {
    async plan(input) {
      return { goalId: input.goalId, revision: 1, tasks: [
        { id: 'research', objective: 'research', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
        { id: 'review', objective: 'review', dependsOn: ['research'], priority: 1, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' },
      ] }
    },
  }
  const execution: ExecutionAdapter = { async execute() { return { status: 'succeeded', summary: 'done', artifacts: [], evidence: [] } } }
  const runtime = new LongTaskRuntime(planner, execution)
  const control = new TaskControlApi(runtime)
  const created = await control.create({ objective: 'research RAG', workspaceScope: 'D:/repo', planningMode: 'require_confirmation' }, { sessionId: 'session-1', workspaceScope: 'D:/repo' })
  const ui = new TaskUiApi(runtime, control)

  expect(ui.getCurrentTaskForSession({ sessionId: 'session-1' })).toMatchObject({ id: created.id, progress: { succeeded: 0, total: 2 } })
  expect(ui.getTaskGraph({ taskId: created.id })).toMatchObject({ revision: 1, nodes: [{ id: 'research' }, { id: 'review' }] })
  expect(ui.listTaskEvents({ taskId: created.id, cursor: 0 }).items.map(event => event.type)).toContain('TaskSessionCurrentSet')
})

test('attaches a cross-session task only on explicit request and can reject a revision-fenced replan', async () => {
  const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'a', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }] } } }
  const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded', summary: 'done', artifacts: [], evidence: [] } } })
  const control = new TaskControlApi(runtime)
  const created = await control.create({ objective: 'cross session', planningMode: 'auto' }, { sessionId: 'origin' })
  const ui = new TaskUiApi(runtime, control)
  expect(runtime.store.getCurrentTaskForSession('next')).toBeUndefined()
  const attached = await ui.attachCurrentSession({ taskId: created.id, sessionId: 'next' })
  expect(attached.kind).toBe('applied')
  expect(runtime.store.getCurrentTaskForSession('next')?.taskId).toBe(created.id)

  const proposed = runtime.proposeReplan(created.id, { kind: 'addTask', task: { id: 'b', objective: 'b', dependsOn: ['a'], priority: 1, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }, reason: 'new evidence', evidenceRefs: [] })
  const rejected = ui.rejectReplan({ taskId: created.id, expectedRevision: proposed.controlRevision })
  expect(rejected).toMatchObject({ kind: 'applied', task: { state: 'RUNNING' } })
})

test('clearing a current session task leaves its durable session link intact', async () => {
  const planner: PlannerAdapter = { async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'a', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }] } } }
  const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded', summary: 'done', artifacts: [], evidence: [] } } })
  const control = new TaskControlApi(runtime)
  const created = await control.create({ objective: 'clear strip', planningMode: 'require_confirmation' }, { sessionId: 'session-1' })
  const ui = new TaskUiApi(runtime, control)
  ui.clearCurrentSession({ sessionId: 'session-1' })
  expect(ui.getCurrentTaskForSession({ sessionId: 'session-1' })).toBeNull()
  expect(runtime.getStatus(created.id)?.sessionLinks).toContainEqual({ sessionId: 'session-1', kind: 'origin' })
})

test('task overview lists actionable tasks before terminal and failed history', async () => {
  let call = 0
  const planner: PlannerAdapter = { async plan(input) { call++; if (call === 2) throw new Error('planner failure'); return { goalId: input.goalId, revision: 1, tasks: [{ id: 'a', objective: 'a', dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }] } } }
  const runtime = new LongTaskRuntime(planner, { async execute() { return { status: 'succeeded', summary: 'done', artifacts: [], evidence: [] } } })
  const control = new TaskControlApi(runtime)
  await control.create({ objective: 'awaiting confirmation', planningMode: 'require_confirmation' }, {})
  await control.create({ objective: 'failed historical task', planningMode: 'require_confirmation' }, {})
  const page = new TaskUiApi(runtime, control).listTasks({})
  expect(page.items.map(item => item.state)).toEqual(['AWAITING_CONFIRMATION', 'FAILED'])
})

test('declares the Task UI query methods on the DSH remote service', () => {
  const methods = remoteMethods(new LongTaskRemote(new Context(), {} as LongTaskRuntime))
  expect(methods.map(method => method.method)).toEqual(expect.arrayContaining([
    'listTasks', 'getTask', 'getTaskGraph', 'listTaskEvents', 'getCurrentTaskForSession', 'updateTask', 'attachCurrentSession', 'setCurrentSession', 'clearCurrentSession', 'rejectReplan',
  ]))
})
