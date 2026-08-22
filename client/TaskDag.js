import React from 'react'
import { layoutTaskGraph, NODE_HEIGHT, NODE_WIDTH } from './task-graph.js'
import { taskStatePresentation } from './task-presentation.js'
const e = React.createElement

export function TaskDag({ nodes, selectedId, onSelect }) {
  const graph = React.useMemo(() => layoutTaskGraph(nodes), [nodes])
  const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 })
  const drag = React.useRef(null)
  const fit = () => setView({ x: 16, y: 16, scale: 1 })
  return e('section', { className: 'ltr-dag-wrap' },
    e('div', { className: 'ltr-dag-tools' }, e('button', { type: 'button', onClick: fit }, '适应视图'), e('span', null, `${graph.nodes.length} 个节点`)),
    graph.danglingDependencyIds.length ? e('p', { className: 'ltr-warning' }, `缺少依赖：${graph.danglingDependencyIds.join(', ')}`) : null,
    e('svg', { className: 'ltr-dag', viewBox: `0 0 ${graph.width} ${graph.height}`, onWheel: event => { event.preventDefault(); setView(value => ({ ...value, scale: Math.min(1.8, Math.max(.55, value.scale + (event.deltaY < 0 ? .1 : -.1))) })) }, onPointerDown: event => { if (event.target === event.currentTarget) drag.current = { x: event.clientX, y: event.clientY } }, onPointerMove: event => { if (drag.current) { const dx = event.clientX - drag.current.x; const dy = event.clientY - drag.current.y; drag.current = { x: event.clientX, y: event.clientY }; setView(value => ({ ...value, x: value.x + dx, y: value.y + dy })) } }, onPointerUp: () => { drag.current = null } },
      e('g', { transform: `translate(${view.x} ${view.y}) scale(${view.scale})` },
        ...graph.edges.map(edge => { const from = graph.nodes.find(node => node.id === edge.from); const to = graph.nodes.find(node => node.id === edge.to); const selected = selectedId === edge.from || selectedId === edge.to; return from && to ? e('line', { key: `${edge.from}-${edge.to}`, className: `ltr-edge${selected ? ' is-selected' : ''}`, x1: from.x + NODE_WIDTH, y1: from.y + NODE_HEIGHT / 2, x2: to.x, y2: to.y + NODE_HEIGHT / 2 }) : null }),
        ...graph.nodes.map(node => { const state = taskStatePresentation(node.state); const selected = node.id === selectedId; return e('g', { key: node.id, className: `ltr-node tone-${state.tone}${selected ? ' is-selected' : ''}`, transform: `translate(${node.x} ${node.y})`, role: 'button', tabIndex: 0, 'aria-label': `${node.id} ${node.objective}`, onClick: () => onSelect(node.id), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') onSelect(node.id) } }, e('rect', { width: NODE_WIDTH, height: NODE_HEIGHT, rx: 10 }), e('text', { x: 12, y: 25, className: 'ltr-node-title' }, node.id), e('text', { x: 12, y: 47, className: 'ltr-node-objective' }, node.objective.slice(0, 22)), e('text', { x: 12, y: 64, className: 'ltr-node-state' }, state.label)) }),
      ),
    ),
  )
}
