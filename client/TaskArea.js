import React from 'react'
import { TaskCockpit } from './TaskCockpit.js'
import { remoteValue } from './remote-value.js'
const e = React.createElement
export function TaskArea({ open, onClose, remote, initialTaskId, useSessions }) {
  const [items, setItems] = React.useState([]); const [selectedId, setSelectedId] = React.useState(initialTaskId ?? null); const [task, setTask] = React.useState(null); const [graph, setGraph] = React.useState(null); const [events, setEvents] = React.useState([]); const [error, setError] = React.useState(null)
  React.useEffect(() => { if (!open) return; let live = true; const load = () => Promise.resolve(remote.listTasks({})).then(value => { const page = remoteValue(value); if (live) setItems(page?.items ?? []) }).catch(reason => { if (live) setError(String(reason)) }); void load(); const timer = setInterval(load, 4000); return () => { live = false; clearInterval(timer) } }, [open, remote])
  React.useEffect(() => { if (!selectedId) return; Promise.all([remote.getTask({ taskId: selectedId }), remote.getTaskGraph({ taskId: selectedId }), remote.listTaskEvents({ taskId: selectedId, cursor: 0 })]).then(([nextTask, nextGraph, page]) => { setTask(remoteValue(nextTask)); setGraph(remoteValue(nextGraph)); setEvents(remoteValue(page)?.items ?? []) }).catch(reason => setError(String(reason))) }, [selectedId, remote])
  React.useEffect(() => { if (initialTaskId) setSelectedId(initialTaskId) }, [initialTaskId])
  const sessions = typeof useSessions === 'function' ? useSessions(value => value) : undefined
  const sessionId = sessions?.current
  if (!open) return null
  return e('div', { className: 'ltr-modal-layer' }, e('div', { className: 'ltr-mask', onClick: onClose }), e('section', { className: 'ltr-modal', role: 'dialog', 'aria-label': '任务区' }, e('button', { className: 'ltr-close', type: 'button', onClick: onClose }, '关闭'), error ? e('p', { className: 'ltr-error' }, error) : null, selectedId ? e(TaskCockpit, { task, graph, events, remote, sessionId, onTaskChanged: setTask, onBack: () => setSelectedId(null) }) : e('section', null, e('h2', null, '任务区'), e('p', null, '跨会话长任务'), e('ol', { className: 'ltr-task-list' }, ...items.map(item => e('li', { key: item.id }, e('button', { type: 'button', onClick: () => setSelectedId(item.id) }, e('strong', null, item.objective), e('small', null, `${item.id} · ${item.progress.succeeded}/${item.progress.total}`))))))))
}
