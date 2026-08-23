import React from 'react'
import { TaskCockpit } from './TaskCockpit.js'
import { taskStatePresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'

const e = React.createElement
const FILTER_STATES = ['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED']

export function TaskArea({ open, onClose, remote, initialTaskId, useSessions }) {
  const [items, setItems] = React.useState([])
  const [selectedId, setSelectedId] = React.useState(initialTaskId ?? null)
  const [task, setTask] = React.useState(null)
  const [graph, setGraph] = React.useState(null)
  const [events, setEvents] = React.useState([])
  const [currentTaskId, setCurrentTaskId] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [state, setState] = React.useState('')
  const sessions = typeof useSessions === 'function' ? useSessions(value => value) : undefined
  const sessionId = sessions?.current
  React.useEffect(() => {
    if (!open) return
    let live = true
    const load = () => Promise.resolve(remote.listTasks({ filter: { ...(query ? { query } : {}), ...(state ? { state } : {}) } }))
      .then(value => { const page = remoteValue(value); if (live) setItems(page?.items ?? []) })
      .catch(reason => { if (live) setError(String(reason)) })
    void load()
    const timer = setInterval(load, 4000)
    return () => { live = false; clearInterval(timer) }
  }, [open, remote, query, state])
  React.useEffect(() => {
    if (!selectedId) return
    Promise.all([remote.getTask({ taskId: selectedId }), remote.getTaskGraph({ taskId: selectedId }), remote.listTaskEvents({ taskId: selectedId, cursor: 0 })])
      .then(([nextTask, nextGraph, page]) => { setTask(remoteValue(nextTask)); setGraph(remoteValue(nextGraph)); setEvents(remoteValue(page)?.items ?? []) })
      .catch(reason => setError(String(reason)))
  }, [selectedId, remote])
  React.useEffect(() => { if (initialTaskId) setSelectedId(initialTaskId) }, [initialTaskId])
  React.useEffect(() => {
    if (!open || !sessionId) return
    Promise.resolve(remote.getCurrentTaskForSession({ sessionId })).then(value => setCurrentTaskId(remoteValue(value)?.id ?? null)).catch(() => setCurrentTaskId(null))
  }, [open, remote, sessionId])
  if (!open) return null
  const overview = e('section', null,
    e('h2', null, '任务区'), e('p', null, '跨会话长任务'),
    e('div', { className: 'ltr-task-filter' },
      e('input', { value: query, placeholder: '搜索任务 ID 或目标', onChange: event => setQuery(event.target.value) }),
      e('select', { value: state, onChange: event => setState(event.target.value) },
        e('option', { value: '' }, '全部状态'),
        ...FILTER_STATES.map(value => e('option', { key: value, value }, taskStatePresentation(value).label)))),
    e('h3', { className: 'ltr-task-list-title' }, '任务列表'),
    e('div', { className: 'ltr-task-list-header', 'aria-hidden': true }, e('span', null, '状态'), e('span', null, '任务目标'), e('span', null, '进度 / 当前节点')),
    e('ol', { className: 'ltr-task-list' }, ...items.map(item => {
      const presentation = taskStatePresentation(item.state)
      return e('li', { key: item.id }, e('button', { type: 'button', onClick: () => setSelectedId(item.id) },
        e('span', { className: `ltr-state tone-${presentation.tone}` }, presentation.label),
        e('strong', null, item.objective),
        e('small', null, `${item.id} · ${item.progress.succeeded}/${item.progress.total}${item.currentOrLastNode ? ` · ${item.currentOrLastNode.id}` : ''}`)))
    })))
  return e('div', { className: 'ltr-modal-layer' },
    e('div', { className: 'ltr-mask', onClick: onClose }),
    e('section', { className: 'ltr-modal', role: 'dialog', 'aria-label': '任务区' },
      e('button', { className: 'ltr-close', type: 'button', onClick: onClose }, '关闭'),
      error ? e('p', { className: 'ltr-error' }, error) : null,
      selectedId ? e(TaskCockpit, { task, graph, events, remote, sessionId, isCurrent: selectedId === currentTaskId, onCurrentChanged: setCurrentTaskId, onTaskChanged: setTask, onBack: () => setSelectedId(null) }) : overview))
}
