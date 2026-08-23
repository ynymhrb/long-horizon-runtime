import React from 'react'
import { taskStripPresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
const e = React.createElement

/** Native GoalBar-shaped compact session face for the current long task. */
export function TaskStrip({ sessionId, remote, onOpen }) {
  const [task, setTask] = React.useState(null)
  const [pending, setPending] = React.useState(false)
  React.useEffect(() => {
    if (!sessionId) return
    let live = true
    const load = () => Promise.resolve(remote.getCurrentTaskForSession({ sessionId })).then(value => { if (live) setTask(remoteValue(value)) }).catch(() => { if (live) setTask(null) })
    void load(); const timer = setInterval(load, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [sessionId, remote])
  if (!task) return null
  const view = taskStripPresentation(task)
  const update = action => {
    setPending(true)
    Promise.resolve(remote.updateTask({ taskId: task.id, expectedRevision: task.controlRevision, action, sessionId })).then(result => setTask(remoteValue(result).task ?? remoteValue(result).current)).finally(() => setPending(false))
  }
  const clear = () => { setPending(true); Promise.resolve(remote.clearCurrentSession({ sessionId })).then(() => setTask(null)).finally(() => setPending(false)) }
  return e('div', { className: `ltr-strip tone-${view.tone}`, 'data-testid': 'long-task-strip' },
    e('span', { className: 'ltr-strip-glyph', 'aria-hidden': true }, '◎'),
    e('span', { className: 'ltr-strip-label' }, view.label),
    e('button', { type: 'button', className: 'ltr-strip-objective', onClick: () => onOpen(task.id), title: task.objective }, task.objective),
    e('span', { className: 'ltr-strip-progress' }, view.progress),
    e('div', { className: 'ltr-strip-actions' },
      (task.availableActions ?? []).includes('pause') ? e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: () => update('pause'), 'aria-label': '暂停长任务', title: '暂停长任务' }, 'Ⅱ') : null,
      (task.availableActions ?? []).includes('resume') ? e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: () => update('resume'), 'aria-label': '继续长任务', title: '继续长任务' }, '▶') : null,
      e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: () => onOpen(task.id), 'aria-label': '打开任务区', title: '打开任务区' }, '↗'),
      e('button', { type: 'button', className: 'ltr-icon-button', disabled: pending, onClick: clear, 'aria-label': '隐藏当前任务条', title: '隐藏当前任务条' }, '×')))
}
