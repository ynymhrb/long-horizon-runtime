import React from 'react'
import { taskStripPresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
import { resumeDriverMode } from './task-model.js'
import { canDriveSessionDriver, driveBoundSessionOnce, sessionDriverStatus } from './task-driver.js'
const e = React.createElement

/** Native GoalBar-shaped compact session face for the current long task. */
export function TaskStrip({ sessionId, remote, onOpen, openSession, driveInSession }) {
  const [task, setTask] = React.useState(null)
  const [pending, setPending] = React.useState(false)
  const [driverNotice, setDriverNotice] = React.useState(null)
  // 驱动去重状态在 task-driver 模块里共享；这里只负责注入结束后重渲染。
  const [, setDriverTick] = React.useState(0)
  React.useEffect(() => {
    if (!sessionId) return
    let live = true
    const load = () => Promise.resolve(remote.getCurrentTaskForSession({ sessionId })).then(value => { if (live) setTask(remoteValue(value)) }).catch(() => { if (live) setTask(null) })
    void load(); const timer = setInterval(load, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [sessionId, remote])
  // 去重键必须来自最新的 GoalView：点击时刻的 task 可能是恢复前的控制版本，
  // 用它算键会绕过模块级去重并再注入一条重复消息。
  const driveTask = freshTask => Promise.resolve(remote.getTaskNavigation({ taskId: freshTask.id })).then(value => {
    const navigation = remoteValue(value)
    const mode = resumeDriverMode(navigation, sessionId)
    if (mode === 'attach') { setDriverNotice('任务尚未绑定可继续的会话，请先在任务区附加当前会话。'); return { outcome: 'attach' } }
    if (mode === 'open') { openSession?.(navigation.currentSessionId); setDriverNotice('已打开绑定会话，请在该会话继续执行。'); return { outcome: 'opened' } }
    if (typeof driveInSession !== 'function') { setDriverNotice('当前页面无法向绑定会话发送继续指令。'); return { outcome: 'unsupported' } }
    return driveBoundSessionOnce({ sessionId, taskId: freshTask.id, controlRevision: freshTask.controlRevision, objective: freshTask.objective, drive: driveInSession }).then(result => {
      setDriverTick(tick => tick + 1)
      if (result.outcome === 'injected') setDriverNotice('已向绑定会话发送继续执行指令。')
      else if (result.outcome === 'skipped') setDriverNotice('继续指令已发送，正在等待绑定会话执行。')
      else setDriverNotice(`继续指令发送失败：${result.status?.reason ?? '未知原因'}，可再次点击重试。`)
      return result
    })
  }).catch(() => { setDriverNotice('无法读取绑定会话，可再次点击重试。'); return { outcome: 'failed' } })
  const continueInBoundSession = () => (task === null || task === undefined ? Promise.resolve({ outcome: 'none' }) : driveTask(task))
  React.useEffect(() => {
    if (!task?.requiresSessionDriver || !sessionId) return
    void continueInBoundSession()
  }, [task?.id, task?.controlRevision, task?.requiresSessionDriver, sessionId])
  if (!task) return null
  const view = taskStripPresentation(task)
  const actionLabel = action => ({ pause: '暂停', resume: '继续', cancel: '取消', confirm: '确认' })[action] ?? action
  const reasonText = reason => String(reason?.message ?? reason ?? '未知原因')
  const update = action => {
    setPending(true)
    setDriverNotice(null)
    // updateTask resolves with a raw GoalView (no strip summary fields);
    // reload the summary shape so the strip presentation never crashes.
    // 失败与版本冲突必须可见：静默吞掉会让用户以为暂停/继续已经生效。
    Promise.resolve(remote.updateTask({ taskId: task.id, expectedRevision: task.controlRevision, action, sessionId }))
      .then(result => {
        const value = remoteValue(result)
        if (value !== null && typeof value === 'object' && value.kind === 'conflict') setDriverNotice(`任务已被其他操作更新，已刷新为最新状态；如需${actionLabel(action)}请再操作一次。`)
        return remote.getCurrentTaskForSession({ sessionId })
      })
      .then(value => { const fresh = remoteValue(value); setTask(fresh); return fresh })
      .then(fresh => (action === 'resume' && fresh !== null && fresh !== undefined ? driveTask(fresh) : undefined))
      .catch(reason => setDriverNotice(`${actionLabel(action)}失败：${reasonText(reason)}，可重试。`))
      .finally(() => setPending(false))
  }
  const clear = () => { setPending(true); Promise.resolve(remote.clearCurrentSession({ sessionId })).then(() => setTask(null)).finally(() => setPending(false)) }
  const driverStatus = sessionDriverStatus(sessionId, task.id, task.controlRevision)
  const driverAvailable = canDriveSessionDriver(driverStatus)
  return e('div', { className: `ltr-strip tone-${view.tone}`, 'data-testid': 'long-task-strip' },
    e('span', { className: 'ltr-strip-glyph', 'aria-hidden': true }, '◎'),
    e('span', { className: 'ltr-strip-label' }, view.label),
    e('button', { type: 'button', className: 'ltr-strip-objective', onClick: () => onOpen(task.id), title: task.objective }, task.objective),
    e('span', { className: 'ltr-strip-progress', title: view.detail || task.objective }, `${view.progress} · ${task.runtimeMetrics ? taskStripRuntime(task.runtimeMetrics) : ''}`),
    driverNotice ? e('span', { className: 'ltr-strip-progress', role: 'status' }, driverNotice) : null,
    e('div', { className: 'ltr-strip-actions' },
      (task.availableActions ?? []).includes('pause') ? e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: () => update('pause'), 'aria-label': '暂停长任务', title: '暂停长任务' }, 'Ⅱ') : null,
      (task.availableActions ?? []).includes('resume') ? e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: () => update('resume'), 'aria-label': '继续长任务', title: '继续长任务' }, '▶') : null,
      task.requiresSessionDriver ? e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending || !driverAvailable, onClick: () => { void continueInBoundSession() }, 'aria-label': driverAvailable ? '继续执行会话' : '继续指令已发送', title: driverAvailable ? '继续执行会话' : '继续指令已发送，等待绑定会话执行' }, '▶') : null,
      e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: () => onOpen(task.id), 'aria-label': '打开任务区', title: '打开任务区' }, '↗'),
      e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: clear, 'aria-label': '隐藏当前任务条', title: '隐藏当前任务条' }, '×')))
}

function taskStripRuntime(metrics) { return `第 ${metrics.runRoundCount} 轮 · 已运行 ${Math.floor(metrics.activeRunTimeMs / 1000)} 秒` }
