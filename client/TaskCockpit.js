import React from 'react'
import { TaskDag } from './TaskDag.js'
import { initialSelectedNode } from './task-model.js'
import { taskStatePresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
const e = React.createElement

export function TaskCockpit({ task, graph, events, onBack, remote, sessionId, isCurrent, onTaskChanged, onCurrentChanged }) {
  const [selectedId, setSelectedId] = React.useState(() => initialSelectedNode(graph?.nodes ?? []))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => setSelectedId(initialSelectedNode(graph?.nodes ?? [])), [task?.id, graph])
  if (!task || !graph) return e('p', null, '正在加载任务…')
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
  const labels = { confirm: '确认执行', pause: '暂停任务', resume: '继续任务', cancel: '取消任务' }
  const externalResolutionRequired = task.state === 'PAUSED' && task.tasks?.some(node => node.state === 'BLOCKED' && node.sideEffectClass === 'external_effect')
  return e('section', { className: 'ltr-cockpit' },
    e('header', { className: 'ltr-cockpit-header' },
      e('button', { type: 'button', onClick: onBack }, '← 全部任务'),
      e('div', null, e('strong', null, task.objective), e('small', null, `${task.id} · 修订 ${task.revision}`)),
      e('span', { className: `ltr-state tone-${state.tone}` }, state.label),
      sessionId ? e('button', { type: 'button', disabled: pending || isCurrent, onClick: attach }, isCurrent ? '当前会话任务' : attached ? '设为当前任务' : '附加到当前会话') : null,
      task.pendingProposal ? e('button', { type: 'button', disabled: pending, onClick: () => invoke('rejectReplan', { taskId: task.id, expectedRevision: task.controlRevision }) }, '拒绝改计划') : null,
      ...(task.availableActions ?? []).filter(name => labels[name]).flatMap(name => name === 'resume' && externalResolutionRequired
        ? [e('button', { key: 'resume-retry', type: 'button', disabled: pending, onClick: () => action('resume', 'retry') }, '重试外部操作'), e('button', { key: 'resume-confirmed', type: 'button', disabled: pending, onClick: () => action('resume', 'confirmed_succeeded') }, '外部操作已完成')]
        : [e('button', { key: name, type: 'button', disabled: pending, onClick: () => action(name) }, labels[name])])),
    error ? e('p', { className: 'ltr-error', role: 'alert' }, error) : null,
    e('p', { className: 'ltr-plan-hint' }, '修改计划请在已关联会话中说明变更；系统会生成可确认或拒绝的计划修订。'),
    e('div', { className: 'ltr-cockpit-body' },
      e(TaskDag, { nodes: graph.nodes, selectedId, onSelect: setSelectedId }),
      e('aside', { className: 'ltr-inspector' }, selected ? e(React.Fragment, null,
        e('h3', null, selected.objective), e('p', null, `节点 ${selected.id} · ${taskStatePresentation(selected.state).label}`), e('p', null, selected.completionCriteria ?? '未声明完成条件'),
        e('h4', null, '近期事件'), e('ol', null, ...events.filter(event => !event.taskId || event.taskId === selected.id).slice(-8).map((event, index) => e('li', { key: `${event.seq ?? index}-${event.type}` }, event.type)))) : e('p', null, '选择一个节点查看详情'))))
}
