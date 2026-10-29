import { expect, test } from 'vitest'
import { canEditOriginalGoal, cockpitDataState, initialSelectedNode, resumeDriverMessage, resumeDriverMode, sessionDriverMode, shouldDriveBoundSession, waitingForSessionDriver } from '../client/task-model.js'
import { ensureSessionTopSlot } from '../client/index.js'
import { cockpitLayoutPresentation, formatRuntimeMetrics, goalObjectivePresentation, quotaRecoveryPresentation, taskAreaPanelCss, taskAreaPresentation } from '../client/task-presentation.js'

test('任务区挂载到原生会话流，不保留浮层容器', () => {
  expect(taskAreaPresentation()).toEqual({
    panelClassName: 'ltr-task-area-panel',
  })
})

test('任务区面板按会话列宽度收缩，不使用视口定宽', () => {
  expect(taskAreaPanelCss).toContain('width:100%')
  expect(taskAreaPanelCss).toContain('max-width:1160px')
  expect(taskAreaPanelCss).not.toContain('100vw')
})

test('缺少会话顶部插槽时明确拒绝挂载', () => {
  expect(() => ensureSessionTopSlot({ spec: () => undefined })).toThrow(/conversation\.session\.top/)
  expect(() => ensureSessionTopSlot({ spec: () => ({ kind: 'list', scope: 'session' }) })).not.toThrow()
})

test('驾驶舱将身份、操作、等高主体和可滚动事件分区', () => {
  expect(cockpitLayoutPresentation()).toEqual({
    identityClassName: 'ltr-cockpit-identity',
    actionsClassName: 'ltr-cockpit-actions',
    mainClassName: 'ltr-cockpit-main',
    inspectorClassName: 'ltr-inspector ltr-cockpit-inspector',
    eventListClassName: 'ltr-event-list ltr-cockpit-events',
  })
})

test('将过长任务目标标记为单行省略并可悬浮查看完整内容', () => {
  const objective = '这是一个很长的任务目标，用于验证驾驶舱标题不会因自动换行挤压操作区。'

  expect(goalObjectivePresentation(objective)).toEqual({
    className: 'ltr-goal-objective',
    singleLine: true,
    title: objective,
  })
})

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

test('formats task runtime rounds and both time measures for the cockpit', () => {
  expect(formatRuntimeMetrics({ runRoundCount: 3, activeRunTimeMs: 65_000, elapsedRunTimeMs: 125_000 })).toEqual({
    summary: '第 3 轮 · 已运行 1 分 5 秒',
    detail: '自然经过 2 分 5 秒',
  })
})
