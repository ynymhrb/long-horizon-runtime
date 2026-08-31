import React from 'react'
import { layoutTaskGraph, NODE_HEIGHT, NODE_WIDTH, stableCanvasSize, truncateGraphText, visibleTaskGraph } from './task-graph.js'
import { taskStatePresentation } from './task-presentation.js'
const e = React.createElement

export function TaskDag({ nodes, selectedId, onSelect }) {
  const [collapsedIds, setCollapsedIds] = React.useState(() => new Set())
  React.useEffect(() => setCollapsedIds(previous => new Set([...previous].filter(id => nodes.some(node => node.id === id)))), [nodes])
  const visible = React.useMemo(() => visibleTaskGraph(nodes, collapsedIds), [nodes, collapsedIds])
  const graph = React.useMemo(() => layoutTaskGraph(visible.nodes), [visible.nodes])
  const canvas = stableCanvasSize(graph)
  const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 })
  const drag = React.useRef(null)
  const fit = () => setView({ x: 16, y: 16, scale: Math.min(1, (canvas.width - 32) / graph.width, (canvas.height - 32) / graph.height) })
  const toggle = id => setCollapsedIds(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next })
  const hasChildren = id => nodes.some(node => (node.dependsOn ?? []).includes(id))
  const legend = [['selected', '选中'], ['ongoing', '运行中'], ['neutral', '待执行'], ['warning', '等待确认 / 暂停'], ['done', '已完成'], ['error', '失败 / 受阻'], ['muted', '已取消 / 已替代']]
  return e('section', { className: 'ltr-dag-wrap' },
    e('div', { className: 'ltr-dag-tools' }, e('div', null, e('button', { type: 'button', className: 'ltr-btn', onClick: fit }, '适应视图'), e('button', { type: 'button', className: 'ltr-btn', onClick: () => setCollapsedIds(new Set()) }, '全部展开'), e('button', { type: 'button', className: 'ltr-btn', onClick: () => setCollapsedIds(new Set(nodes.filter(node => hasChildren(node.id)).map(node => node.id))) }, '全部折叠')), e('span', null, `${graph.nodes.length}/${nodes.length} 个节点`)),
    e('div', { className: 'ltr-dag-legend', 'aria-label': '节点状态图例' }, ...legend.map(([tone, label]) => e('span', { key: tone, className: `tone-${tone}` }, e('i', { className: `ltr-legend-swatch tone-${tone}` }), label))),
    graph.danglingDependencyIds.length ? e('p', { className: 'ltr-warning' }, `缺少依赖：${graph.danglingDependencyIds.join(', ')}`) : null,
    e('svg', { className: 'ltr-dag', viewBox: `0 0 ${canvas.width} ${canvas.height}`, preserveAspectRatio: 'xMinYMin meet', onWheel: event => { event.preventDefault(); setView(value => ({ ...value, scale: Math.min(1.8, Math.max(.55, value.scale + (event.deltaY < 0 ? .1 : -.1))) })) }, onPointerDown: event => { if (event.target === event.currentTarget) drag.current = { x: event.clientX, y: event.clientY } }, onPointerMove: event => { if (drag.current) { const dx = event.clientX - drag.current.x; const dy = event.clientY - drag.current.y; drag.current = { x: event.clientX, y: event.clientY }; setView(value => ({ ...value, x: value.x + dx, y: value.y + dy })) } }, onPointerUp: () => { drag.current = null } },
      e('g', { transform: `translate(${view.x} ${view.y}) scale(${view.scale})` },
        ...graph.edges.map(edge => {
          const from = graph.nodes.find(node => node.id === edge.from)
          const to = graph.nodes.find(node => node.id === edge.to)
          const selected = selectedId === edge.from || selectedId === edge.to
          if (!from || !to) return null
          const x1 = from.x + NODE_WIDTH
          const y1 = from.y + NODE_HEIGHT / 2
          const x2 = to.x
          const y2 = to.y + NODE_HEIGHT / 2
          const bend = Math.max(10, Math.min(44, (x2 - x1) / 3))
          return e('path', { key: `${edge.from}-${edge.to}`, className: `ltr-edge${selected ? ' is-selected' : ''}`, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` })
        }),
        ...graph.nodes.map(node => { const state = taskStatePresentation(node.state); const selected = node.id === selectedId; const collapsed = collapsedIds.has(node.id); const hiddenCount = visible.hiddenBy.get(node.id)?.length ?? 0; return e('g', { key: node.id, className: `ltr-node tone-${state.tone}${selected ? ' is-selected' : ''}`, transform: `translate(${node.x} ${node.y})`, role: 'button', tabIndex: 0, 'aria-label': `${node.id} ${node.objective}`, onClick: () => onSelect(node.id), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') onSelect(node.id) } }, e('rect', { width: NODE_WIDTH, height: NODE_HEIGHT, rx: 10 }), e('text', { x: 12, y: 25, className: 'ltr-node-title' }, truncateGraphText(node.id, 19)), e('text', { x: 12, y: 47, className: 'ltr-node-objective' }, truncateGraphText(node.objective, 14)), e('text', { x: 12, y: 64, className: 'ltr-node-state' }, truncateGraphText(state.label, 14)), hasChildren(node.id) ? e('g', { className: 'ltr-collapse-control', role: 'button', tabIndex: 0, 'aria-label': `${collapsed ? '展开' : '折叠'} ${node.id} 下游任务`, onClick: event => { event.stopPropagation(); toggle(node.id) }, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); toggle(node.id) } } }, e('rect', { x: NODE_WIDTH - 31, y: 9, width: 21, height: 18, rx: 5 }), e('text', { x: NODE_WIDTH - 20, y: 23, textAnchor: 'middle' }, collapsed ? `+${hiddenCount}` : '−')) : null) }),
      ),
    ),
  )
}
