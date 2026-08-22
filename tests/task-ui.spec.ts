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

test('declares the Task UI query methods on the DSH remote service', () => {
  const methods = remoteMethods(new LongTaskRemote(new Context(), {} as LongTaskRuntime))
  expect(methods.map(method => method.method)).toEqual(expect.arrayContaining([
    'listTasks', 'getTask', 'getTaskGraph', 'listTaskEvents', 'getCurrentTaskForSession', 'updateTask',
  ]))
})
