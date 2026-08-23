import React from 'react'
import { TaskDag } from './TaskDag.js'
import { cockpitDataState, initialSelectedNode } from './task-model.js'
import { taskStatePresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
import { formatTaskEvent } from './task-events.js'
const e = React.createElement

export function TaskCockpit({ task, graph, events, onBack, remote, sessionId, openSession, isCurrent, onTaskChanged, onCurrentChanged }) {
  const [selectedId, setSelectedId] = React.useState(() => initialSelectedNode(graph?.nodes ?? []))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [editing, setEditing] = React.useState(false)
  const [objective, setObjective] = React.useState('')
  const [reason, setReason] = React.useState('')
  React.useEffect(() => setSelectedId(initialSelectedNode(graph?.nodes ?? [])), [task?.id, graph])
  const dataState = cockpitDataState(task, graph)
  if (dataState === 'loading') return e('p', null, '正在加载任务…')
  if (dataState === 'missing') return e('section', { className: 'ltr-cockpit' }, e('button', { type: 'button', onClick: onBack }, '← 全部任务'), e('p', { className: 'ltr-error' }, '任务不存在或已被清理。'))
  if (dataState === 'no-plan') return e('section', { className: 'ltr-cockpit ltr-no-plan' },
    e('header', { className: 'ltr-cockpit-header' }, e('button', { type: 'button', onClick: onBack }, '← 全部任务'), e('div', null, e('strong', null, task.objective), e('small', null, `${task.id} · 修订 ${task.revision}`)), e('span', { className: `ltr-state tone-${taskStatePresentation(task.state).tone}` }, taskStatePresentation(task.state).label)),
    e('p', { className: 'ltr-warning' }, '此历史任务在生成计划前结束，因此没有可展示的 DAG。'),
    e('h4', null, '近期事件'), e('ol', null, ...events.slice(-8).map((event, index) => e('li', { key: `${event.seq ?? index}-${event.type}` }, event.type)))
  )
  const selected = graph.nodes.find(node => node.id === selectedId)
  const state = taskStatePresentation(task.state)
  const attached = sessionId && task.sessionLinks?.some(link => link.sessionId === sessionId)
  const invoke = (method, input) => {
    setPending(true); setError(null)
    Promise.resolve(remote[method](input)).then(result => {
      const value = remoteValue(result)
      onTaskChanged(value.kind === 'conflict' ? value.current : value.task)
      if (method === 'attachCurrentSession' || method === 'setCurrentSession') onCurrentChanged?.(task.id)
    }).catch(reason => setError(String(reason))).finally(() => setPending(false))
  }
  const action = (label, recoveryResolution) => invoke('updateTask', { taskId: task.id, expectedRevision: task.controlRevision, action: label, ...(sessionId ? { sessionId } : {}), ...(recoveryResolution ? { recoveryResolution } : {}) })
  const attach = () => invoke(attached ? 'setCurrentSession' : 'attachCurrentSession', { taskId: task.id, sessionId })
  const edit = () => invoke('editTaskGoal', { taskId: task.id, expectedRevision: task.controlRevision, objective, reason, ...(sessionId ? { sessionId } : {}) })
  const archive = () => { if (window.confirm('删除任务会先取消正在进行的工作，并归档 30 天。是否继续？')) invoke('archiveTask', { taskId: task.id, expectedRevision: task.controlRevision }) }
  const jump = () => Promise.resolve(remote.getTaskNavigation({ taskId: task.id })).then(result => { const target = remoteValue(result)?.currentSessionId; if (target && typeof openSession === 'function') openSession(target); else setError(target ? '当前 DSH 槽未提供会话跳转能力。' : '此任务尚未关联可跳转的会话。') }).catch(value => setError(String(value)))
  const labels = { confirm: '确认执行', pause: '暂停任务', resume: '继续任务', cancel: '取消任务' }
  const externalResolutionRequired = task.state === 'PAUSED' && task.tasks?.some(node => node.state === 'BLOCKED' && node.sideEffectClass === 'external_effect')
  return e('section', { className: 'ltr-cockpit' },
    e('header', { className: 'ltr-cockpit-header' },
      e('button', { type: 'button', onClick: onBack }, '← 全部任务'),
      e('div', null, e('strong', null, task.objective), e('small', null, `${task.id} · 修订 ${task.revision}`)),
      e('span', { className: `ltr-state tone-${state.tone}` }, state.label),
      sessionId ? e('button', { type: 'button', disabled: pending || isCurrent, onClick: attach }, isCurrent ? '当前会话任务' : attached ? '设为当前任务' : '附加到当前会话') : null,
      task.pendingProposal ? e('button', { type: 'button', disabled: pending, onClick: () => invoke('rejectReplan', { taskId: task.id, expectedRevision: task.controlRevision }) }, '拒绝改计划') : null,
      task.pendingProposal ? e('button', { type: 'button', disabled: pending, onClick: () => invoke('acceptReplan', { taskId: task.id, expectedRevision: task.controlRevision, ...(sessionId ? { sessionId } : {}) }) }, '接受重规划') : null,
      e('button', { type: 'button', disabled: pending, onClick: () => { setEditing(value => !value); setObjective(task.objective); setReason('') } }, '修改原始目标'),
      e('button', { type: 'button', disabled: pending, onClick: jump }, '跳转到会话'),
      e('button', { type: 'button', disabled: pending, onClick: archive }, '删除'),
      ...(task.availableActions ?? []).filter(name => labels[name]).flatMap(name => name === 'resume' && externalResolutionRequired
        ? [e('button', { key: 'resume-retry', type: 'button', disabled: pending, onClick: () => action('resume', 'retry') }, '重试外部操作'), e('button', { key: 'resume-confirmed', type: 'button', disabled: pending, onClick: () => action('resume', 'confirmed_succeeded') }, '外部操作已完成')]
        : [e('button', { key: name, type: 'button', disabled: pending, onClick: () => action(name) }, labels[name])])),
    error ? e('p', { className: 'ltr-error', role: 'alert' }, error) : null,
    editing ? e('form', { className: 'ltr-goal-edit', onSubmit: event => { event.preventDefault(); if (objective.trim() && reason.trim()) edit() } }, e('label', null, '新原始目标', e('textarea', { value: objective, onChange: event => setObjective(event.target.value) })), e('label', null, '修改原因', e('input', { value: reason, onChange: event => setReason(event.target.value) })), e('button', { type: 'submit', disabled: pending || !objective.trim() || !reason.trim() }, '生成重规划')) : null,
    e('p', { className: 'ltr-plan-hint' }, '修改原始目标会生成可确认的计划修订；低风险执行失败可自动局部重规划。'),
    e('div', { className: 'ltr-cockpit-body' },
      e(TaskDag, { nodes: graph.nodes, selectedId, onSelect: setSelectedId }),
      e('aside', { className: 'ltr-inspector' }, selected ? e(React.Fragment, null,
        e('h3', null, selected.objective), e('p', null, `节点 ${selected.id} · ${taskStatePresentation(selected.state).label}`), e('p', null, selected.completionCriteria ?? '未声明完成条件'),
        e('h4', null, '近期事件'), e('ol', { className: 'ltr-event-list' }, ...events.filter(event => !event.taskId || event.taskId === selected.id).slice(-8).map((event, index) => { const item = formatTaskEvent(event); return e('li', { key: `${event.seq ?? index}-${event.type}`, className: `tone-${item.tone}` }, e('strong', null, item.label), e('small', null, item.detail), event.createdAt ? e('time', null, new Date(event.createdAt).toLocaleString()) : null) }))) : e('p', null, '选择一个节点查看详情'))))
}
