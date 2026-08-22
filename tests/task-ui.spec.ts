import { expect, test } from 'vitest'
import { currentTaskStrip, toTaskAreaItem } from '../src/task-ui.js'
import type { GoalView } from '../src/runtime.js'

const task = { id: 'lt_demo', objective: 'Research RAG', state: 'RUNNING', revision: 1, controlRevision: 3, sessionLinks: [], tasks: [{ id: 'research', state: 'SUCCEEDED' }, { id: 'review', state: 'PENDING' }], attempts: [], artifacts: [], decisions: [], accounting: { attemptCount: 1, succeededTaskCount: 1, failedTaskCount: 0 }, recentEvents: [], availableActions: ['cancel'] } as unknown as GoalView

test('task area projection is compact and a chat strip stays absent without an attached task', () => {
  expect(toTaskAreaItem(task)).toMatchObject({ id: 'lt_demo', completedCount: 1, taskCount: 2 })
  expect(currentTaskStrip(undefined)).toBeUndefined()
})
