import { expect, test } from 'vitest'
import { cockpitDataState, initialSelectedNode, resumeDriverMessage, resumeDriverMode } from '../client/task-model.js'

test('prefers a running node then pending work for the Cockpit inspector', () => {
  expect(initialSelectedNode([{ id: 'done', state: 'SUCCEEDED' }, { id: 'run', state: 'RUNNING' }, { id: 'pending', state: 'PENDING' }])).toBe('run')
  expect(initialSelectedNode([{ id: 'done', state: 'SUCCEEDED' }, { id: 'pending', state: 'PENDING' }])).toBe('pending')
})

test('identifies historical tasks that failed before a plan existed', () => {
  expect(cockpitDataState(undefined, undefined)).toBe('loading')
  expect(cockpitDataState(null, null)).toBe('missing')
  expect(cockpitDataState({ id: 'goal-old', state: 'FAILED' }, null)).toBe('no-plan')
  expect(cockpitDataState({ id: 'lt_current', state: 'FAILED' }, { nodes: [], edges: [] })).toBe('ready')
})

test('builds a session driver message that asks the model to resume the task', () => {
  const message = resumeDriverMessage('lt_a', '继续执行研究任务')
  expect(message).toContain('lt_a')
  expect(message).toContain('long_task_resume')
  expect(message).toContain('继续执行研究任务')
})

test('decides how to hand a web resume to a live parent session', () => {
  expect(resumeDriverMode({ currentSessionId: 'session-1' }, 'session-1')).toBe('inject')
  expect(resumeDriverMode({ currentSessionId: 'session-2' }, 'session-1')).toBe('open')
  expect(resumeDriverMode({}, 'session-1')).toBe('attach')
  expect(resumeDriverMode({ currentSessionId: 'session-2' }, undefined)).toBe('open')
})
