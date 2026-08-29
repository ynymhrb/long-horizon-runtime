import { expect, test } from 'vitest'
import { cockpitDataState, initialSelectedNode } from '../client/task-model.js'

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

test('formats profile, budget, and retrieval events as readable audit rows', async () => {
  const { formatTaskEvent } = await import('../client/task-events.js')
  expect(formatTaskEvent({ type: 'BudgetExhausted', payload: { reason: 'maxAttempts exhausted' } }).detail).toContain('maxAttempts')
  expect(formatTaskEvent({ type: 'ExecutionProfileResolved', payload: { profileId: 'fast' } }).label).not.toBe('ExecutionProfileResolved')
  expect(formatTaskEvent({ type: 'MemoryRetrievalFeedbackRecorded', payload: { reason: 'useful' } }).label).not.toBe('MemoryRetrievalFeedbackRecorded')
})
