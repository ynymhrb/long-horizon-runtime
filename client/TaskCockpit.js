import React from 'react'
import { TaskDag } from './TaskDag.js'
import { cockpitDataState, initialSelectedNode, resumeDriverMode } from './task-model.js'
import { taskStatePresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
import { formatTaskEvent } from './task-events.js'
const e = React.createElement

export function TaskCockpit({ task, graph, events, onBack, remote, sessionId, openSession, driveInSession, isCurrent, onTaskChanged, onCurrentChanged }) {
  const [selectedId, setSelectedId] = React.useState(() => initialSelectedNode(graph?.nodes ?? []))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [editing, setEditing] = React.useState(false)
  const [objective, setObjective] = React.useState('')
  const [reason, setReason] = React.useState('')
  React.useEffect(() => setSelectedId(previous => (previous !== undefined && graph?.nodes.some(node => node.id === previous)) ? previous : initialSelectedNode(graph?.nodes ?? [])), [task?.id, graph])
  const dataState = cockpitDataState(task, graph)
  if (dataState === 'loading') return e('p', null, '正在加载任务…')
  if (dataState === 'missing') return e('section', { className: 'ltr-cockpit' }, e('button', { type: 'button', className: 'ltr-btn', onClick: onBack }, '← 全部任务'), e('p', { className: 'ltr-error' }, '任务不存在或已被清理。'))
  if (dataState === 'no-plan') return e('section', { className: 'ltr-cockpit ltr-no-plan' },
    e('header', { className: 'ltr-cockpit-header' }, e('button', { type: 'button', className: 'ltr-btn', onClick: onBack }, '← 全部任务'), e('div', null, e('strong', null, task.objective), e('small', null, `${task.id} · 修订 ${task.revision}`)), e('span', { className: `ltr-state tone-${taskStatePresentation(task.state).tone}` }, taskStatePresentation(task.state).label)),
    e('p', { className: 'ltr-warning' }, '此历史任务在生成计划前结束，因此没有可展示的 DAG。'),
    e('h4', null, '近期事件'), e('ol', null, ...events.slice(-8).map((event, index) => e('li', { key: `${event.seq ?? index}-${event.type}` }, event.type)))
  )
  const selected = graph.nodes.find(node => node.id === selectedId)
  const activeAttempt = selected ? task.attempts?.find(attempt => attempt.taskId === selected.id && attempt.state === 'RUNNING') : undefined
  const state = taskStatePresentation(task.state)
  const attached = sessionId && task.sessionLinks?.some(link => link.sessionId === sessionId)
  const invoke = (method, input) => {
    setPending(true); setError(null)
    return Promise.resolve(remote[method](input)).then(result => {
      const value = remoteValue(result)
      onTaskChanged(value.kind === 'conflict' ? value.current : value.task)
      const continuesInSession = method === 'attachCurrentSession' || method === 'setCurrentSession' || method === 'acceptReplan' || (method === 'updateTask' && ['confirm', 'resume'].includes(input?.action))
      if (continuesInSession) onCurrentChanged?.(task.id)
      // After a web resume the goal is durably RUNNING but nothing has been
      // dispatched: hand the task to the bound session's Agent (the live
      // parent). If that session is the current one, inject a driver message
      // so the model starts the round without any extra user input.
      if (method === 'updateTask' && input?.action === 'resume' && value.kind === 'applied') return guideAfterResume()
      return undefined
    }).catch(reason => setError(String(reason))).finally(() => setPending(false))
  }
  const guideAfterResume = () => Promise.resolve(remote.getTaskNavigation({ taskId: task.id })).then(result => {
    const navigation = remoteValue(result)
    const mode = resumeDriverMode(navigation, sessionId)
    if (mode === 'inject') {
      if (typeof driveInSession !== 'function') { setError('任务已标记为运行：本会话无法自动注入驱动消息，请让模型调用 long_task_resume 继续执行。'); return }
      setError(null)
      Promise.resolve(driveInSession(sessionId, task.id, task.objective))
        .then(driven => setError(driven ? '任务已标记为运行，已向本会话发送继续执行指令。' : '任务已标记为运行：本会话未能注入驱动消息，请直接让模型继续执行。'))
        .catch(() => setError('任务已标记为运行：注入驱动消息失败，请直接让模型继续执行。'))
      return
    }
    if (mode === 'open') {
      if (typeof openSession === 'function') { setError(null); openSession(navigation.currentSessionId) }
      else setError('任务已标记为运行，但绑定会话不在当前窗口，且当前 DSH 槽未提供会话跳转能力。')
      return
    }
    setError('任务已标记为运行，但尚未绑定可跳转的会话：先点击“附加到当前会话”绑定本会话，再让模型继续执行。')
  }).catch(value => setError(String(value)))
  const action = (label, recoveryResolution) => invoke('updateTask', { taskId: task.id, expectedRevision: task.controlRevision, action: label, ...(sessionId ? { sessionId } : {}), ...(recoveryResolution ? { recoveryResolution } : {}) })
  const attach = () => invoke(attached ? 'setCurrentSession' : 'attachCurrentSession', { taskId: task.id, sessionId })
  const edit = () => invoke('editTaskGoal', { taskId: task.id, expectedRevision: task.controlRevision, objective, reason, ...(sessionId ? { sessionId } : {}) })
  const archive = () => { if (window.confirm('删除任务会先取消正在进行的工作，并归档 30 天。是否继续？')) invoke('archiveTask', { taskId: task.id, expectedRevision: task.controlRevision }) }
  const restore = () => { setPending(true); setError(null); Promise.resolve(remote.restoreTask({ taskId: task.id })).then(result => onTaskChanged(remoteValue(result))).catch(value => setError(String(value))).finally(() => setPending(false)) }
  const jump = () => Promise.resolve(remote.getTaskNavigation({ taskId: task.id })).then(result => { const target = remoteValue(result)?.currentSessionId; if (target && target === sessionId) setError('该任务绑定的会话就是当前会话，无需跳转。'); else if (target && typeof openSession === 'function') openSession(target); else setError(target ? '当前 DSH 槽未提供会话跳转能力。' : '此任务尚未关联可跳转的会话：先点击“附加到当前会话”绑定本会话，或从创建它的会话继续运行。') }).catch(value => setError(String(value)))
  const labels = { confirm: '确认执行', pause: '暂停任务', resume: '继续任务', cancel: '取消任务' }
  const externalResolutionRequired = task.state === 'PAUSED' && task.tasks?.some(node => node.state === 'BLOCKED' && node.sideEffectClass === 'external_effect')
  // A web-side resume only marks the goal RUNNING; an agent session must drive
  // the rounds. Surface that instead of implying the task is executing alone.
  const waitingForDriver = task.state === 'RUNNING' && task.tasks.length > 0 && !task.tasks.some(node => node.state === 'RUNNING')
  return e('section', { className: 'ltr-cockpit' },
    e('header', { className: 'ltr-cockpit-header' },
      e('button', { type: 'button', className: 'ltr-btn', onClick: onBack }, '← 全部任务'),
      e('div', null, e('strong', null, task.objective), e('small', null, `${task.id} · 修订 ${task.revision}`)),
      e('span', { className: `ltr-state tone-${state.tone}` }, state.label),
      sessionId ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending || isCurrent, onClick: attach }, isCurrent ? '当前会话任务' : attached ? '设为当前任务' : '附加到当前会话') : null,
      task.pendingProposal ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => invoke('rejectReplan', { taskId: task.id, expectedRevision: task.controlRevision }) }, '拒绝改计划') : null,
      task.pendingProposal ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => invoke('acceptReplan', { taskId: task.id, expectedRevision: task.controlRevision, ...(sessionId ? { sessionId } : {}) }) }, '接受重规划') : null,
      e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => { setEditing(value => !value); setObjective(task.objective); setReason('') } }, '修改原始目标'),
      e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: jump }, '当前会话'),
      e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: task.archivedAt ? restore : archive }, task.archivedAt ? '恢复归档任务' : '删除'),
      ...(task.availableActions ?? []).filter(name => labels[name]).flatMap(name => name === 'resume' && externalResolutionRequired
        ? [e('button', { key: 'resume-retry', type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => action('resume', 'retry') }, '重试外部操作'), e('button', { key: 'resume-confirmed', type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => action('resume', 'confirmed_succeeded') }, '外部操作已完成')]
        : [e('button', { key: name, type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => action(name) }, labels[name])])),
    error ? e('p', { className: 'ltr-error', role: 'alert' }, error) : null,
    editing ? e('form', { className: 'ltr-goal-edit', onSubmit: event => { event.preventDefault(); if (objective.trim() && reason.trim()) edit() } }, e('label', null, '新原始目标', e('textarea', { value: objective, onChange: event => setObjective(event.target.value) })), e('label', null, '修改原因', e('input', { value: reason, onChange: event => setReason(event.target.value) })), e('button', { type: 'submit', className: 'ltr-btn', disabled: pending || !objective.trim() || !reason.trim() }, '生成重规划')) : null,
    e('p', { className: 'ltr-plan-hint' }, waitingForDriver ? '任务已标记为运行，但尚未派发节点：请在绑定的会话中让模型继续执行（long_task_resume），由代理会话驱动调度。' : '修改原始目标会生成可确认的计划修订；低风险执行失败可自动局部重规划。'),
    e('div', { className: 'ltr-cockpit-body' },
      e(TaskDag, { nodes: graph.nodes, selectedId, onSelect: setSelectedId }),
      e('aside', { className: 'ltr-inspector' }, selected ? e(React.Fragment, null,
        e('h3', null, selected.objective), e('p', null, `节点 ${selected.id} · ${taskStatePresentation(selected.state).label}`), e('p', null, selected.completionCriteria ?? '未声明完成条件'),
        activeAttempt ? e('section', { className: 'ltr-attempt-liveness' }, e('h4', null, '执行活动'), e('p', null, `${activeAttempt.latestProgress?.phase ?? '执行中'}：${activeAttempt.latestProgress?.message ?? '等待子会话进度'}`), activeAttempt.lastActivityAt ? e('time', null, `最近活动：${new Date(activeAttempt.lastActivityAt).toLocaleString()}`) : null, activeAttempt.maxWallExpiresAt ? e('time', null, `最长运行至：${new Date(activeAttempt.maxWallExpiresAt).toLocaleString()}`) : null) : null,
        e('h4', null, '近期事件'), e('ol', { className: 'ltr-event-list' }, ...events.filter(event => !event.taskId || event.taskId === selected.id).slice(-8).map((event, index) => { const item = formatTaskEvent(event); return e('li', { key: `${event.seq ?? index}-${event.type}`, className: `tone-${item.tone}` }, e('strong', null, item.label), e('small', null, item.detail), event.createdAt ? e('time', null, new Date(event.createdAt).toLocaleString()) : null) }))) : e('p', null, '选择一个节点查看详情'))))
}
