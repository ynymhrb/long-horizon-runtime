import React from 'react'
import { TaskDag } from './TaskDag.js'
import { initialSelectedNode } from './task-model.js'
import { taskStatePresentation } from './task-presentation.js'
const e = React.createElement
export function TaskCockpit({ task, graph, events, onBack, remote, sessionId, onTaskChanged }) {
  const [selectedId, setSelectedId] = React.useState(() => initialSelectedNode(graph?.nodes ?? []))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState(null)
  React.useEffect(() => setSelectedId(initialSelectedNode(graph?.nodes ?? [])), [task?.id, graph])
  if (!task || !graph) return e('p', null, '正在加载任务…')
  const selected = graph.nodes.find(node => node.id === selectedId)
  const state = taskStatePresentation(task.state)
  const action = label => { setPending(true); setError(null); Promise.resolve(remote.updateTask({ taskId: task.id, expectedRevision: task.controlRevision, action: label, ...(sessionId ? { sessionId } : {}) })).then(result => { onTaskChanged(result.kind === 'conflict' ? result.current : result.task) }).catch(reason => setError(String(reason))).finally(() => setPending(false)) }
  const labels = { confirm: '确认执行', pause: '暂停任务', resume: '继续任务', cancel: '取消任务' }
  return e('section', { className: 'ltr-cockpit' }, e('header', { className: 'ltr-cockpit-header' }, e('button', { type: 'button', onClick: onBack }, '← 全部任务'), e('div', null, e('strong', null, task.objective), e('small', null, `${task.id} · 修订 ${task.revision}`)), e('span', { className: `ltr-state tone-${state.tone}` }, state.label), ...(task.availableActions ?? []).filter(name => labels[name]).map(name => e('button', { key: name, type: 'button', disabled: pending, onClick: () => action(name) }, labels[name]))), error ? e('p', { className: 'ltr-error', role: 'alert' }, error) : null, e('div', { className: 'ltr-cockpit-body' }, e(TaskDag, { nodes: graph.nodes, selectedId, onSelect: setSelectedId }), e('aside', { className: 'ltr-inspector' }, selected ? e(React.Fragment, null, e('h3', null, selected.objective), e('p', null, `节点 ${selected.id} · ${taskStatePresentation(selected.state).label}`), e('p', null, selected.completionCriteria ?? '未声明完成条件'), e('h4', null, '近期事件'), e('ol', null, ...events.filter(event => !event.taskId || event.taskId === selected.id).slice(-8).map((event, index) => e('li', { key: `${event.seq ?? index}-${event.type}` }, event.type)))) : e('p', null, '选择一个节点查看详情'))))
}
