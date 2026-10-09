import { expect, test } from 'vitest'
import { canEditOriginalGoal, cockpitDataState, initialSelectedNode, resumeDriverMessage, resumeDriverMode, sessionDriverMode, shouldDriveBoundSession, waitingForSessionDriver } from '../client/task-model.js'
import { quotaRecoveryPresentation } from '../client/task-presentation.js'

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

test('does not offer original-goal edits for terminal tasks', () => {
  expect(canEditOriginalGoal({ state: 'SUCCEEDED' })).toBe(false)
  expect(canEditOriginalGoal({ state: 'FAILED' })).toBe(false)
  expect(canEditOriginalGoal({ state: 'CANCELLED' })).toBe(false)
  expect(canEditOriginalGoal({ state: 'PAUSED' })).toBe(true)
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

test('marks a running task with no running node as waiting for its bound session', () => {
  expect(waitingForSessionDriver({ state: 'RUNNING', tasks: [{ state: 'PENDING' }] })).toBe(true)
  expect(waitingForSessionDriver({ state: 'RUNNING', tasks: [{ state: 'RUNNING' }] })).toBe(false)
})

test('会话驱动恢复只对运行时明确标记的缺失父会话生效', () => {
  const needsDriver = { state: 'RUNNING', requiresSessionDriver: true, tasks: [{ state: 'PENDING' }] }
  expect(sessionDriverMode(needsDriver, { currentSessionId: 'session-1' }, 'session-1')).toBe('inject')
  expect(sessionDriverMode(needsDriver, { currentSessionId: 'session-2' }, 'session-1')).toBe('open')
  expect(sessionDriverMode(needsDriver, {}, 'session-1')).toBe('attach')
  expect(sessionDriverMode({ state: 'RUNNING', requiresSessionDriver: false, tasks: [{ state: 'PENDING' }] }, { currentSessionId: 'session-1' }, 'session-1')).toBe('none')
})

test('drives both current and opened bound sessions after a web resume', () => {
  expect(shouldDriveBoundSession('inject')).toBe(true)
  expect(shouldDriveBoundSession('open')).toBe(true)
  expect(shouldDriveBoundSession('attach')).toBe(false)
})

test('renders a due quota recovery as an actionable continuation message', () => {
  expect(quotaRecoveryPresentation({ retryAt: '2026-09-01T10:05:00.000Z', diagnostic: 'HTTP 429 rate limit' }, new Date('2026-09-01T10:06:00.000Z')))
    .toMatchObject({ tone: 'warning', label: '额度恢复时间已到，请在已关联会话中继续' })
})

test('renders an automatic quota recovery notice while work resumes', () => {
  expect(quotaRecoveryPresentation(undefined, new Date(), { type: 'QuotaRecoveryResumed' }))
    .toMatchObject({ tone: 'ongoing', label: '额度已恢复，正在自动继续执行' })
})
