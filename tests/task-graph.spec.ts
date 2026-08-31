import { describe, expect, test } from 'vitest'
import { LANE_GAP, layoutTaskGraph, NODE_HEIGHT, NODE_WIDTH, stableCanvasSize, truncateGraphText, visibleTaskGraph } from '../client/task-graph.js'
import { dagToneCss, formatTaskProgress, taskStatePresentation, taskStripPresentation } from '../client/task-presentation.js'

describe('long task DAG layout', () => {
  test('places dependencies in increasing stable ranks', () => {
    const graph = layoutTaskGraph([
      { id: 'review', objective: 'review', dependsOn: ['research'], state: 'PENDING' },
      { id: 'research', objective: 'research', dependsOn: [], state: 'SUCCEEDED' },
    ])

    const research = graph.nodes.find(node => node.id === 'research')!
    const review = graph.nodes.find(node => node.id === 'review')!
    expect(research.x).toBeLessThan(review.x)
    expect(graph.nodes.map(node => node.id)).toEqual(['research', 'review'])
    expect(graph.edges).toEqual([{ from: 'research', to: 'review' }])
  })

  test('keeps same-rank ordering stable and reports dangling dependencies', () => {
    const graph = layoutTaskGraph([
      { id: 'zeta', objective: 'zeta', dependsOn: [], state: 'PENDING' },
      { id: 'alpha', objective: 'alpha', dependsOn: [], state: 'PENDING' },
      { id: 'dangling', objective: 'dangling', dependsOn: ['missing'], state: 'PENDING' },
    ])

    expect(graph.nodes.map(node => node.id)).toEqual(['alpha', 'dangling', 'zeta'])
    expect(graph.danglingDependencyIds).toEqual(['missing'])
  })

  test('reorders a layer to eliminate an avoidable edge crossing', () => {
    const graph = layoutTaskGraph([
      { id: 'a', objective: 'a', dependsOn: [], state: 'PENDING' },
      { id: 'b', objective: 'b', dependsOn: [], state: 'PENDING' },
      { id: 'x', objective: 'x', dependsOn: ['b'], state: 'PENDING' },
      { id: 'y', objective: 'y', dependsOn: ['a'], state: 'PENDING' },
    ])

    // Alphabetical layering puts x before y and crosses a→y with b→x; the
    // reduced layout must flip the second layer and cross nothing.
    expect(graph.nodes.filter(node => node.rank === 1).map(node => node.id)).toEqual(['y', 'x'])
    expect(geometricCrossings(graph.nodes, graph.edges)).toBe(0)
  })

  test('reduces crossings on a three-layer graph below the alphabetical layout', () => {
    const graph = layoutTaskGraph([
      { id: 'a', objective: 'a', dependsOn: [], state: 'PENDING' },
      { id: 'b', objective: 'b', dependsOn: [], state: 'PENDING' },
      { id: 'c', objective: 'c', dependsOn: [], state: 'PENDING' },
      { id: 'x', objective: 'x', dependsOn: ['c'], state: 'PENDING' },
      { id: 'y', objective: 'y', dependsOn: ['b'], state: 'PENDING' },
      { id: 'z', objective: 'z', dependsOn: ['a'], state: 'PENDING' },
    ])

    expect(graph.nodes.filter(node => node.rank === 1).map(node => node.id)).toEqual(['z', 'y', 'x'])
    expect(geometricCrossings(graph.nodes, graph.edges)).toBe(0)
    expect(graph.nodes).toHaveLength(6)
  })

  test('keeps long edges spanning multiple ranks dependency-faithful without dummy leakage', () => {
    const graph = layoutTaskGraph([
      { id: 'a', objective: 'a', dependsOn: [], state: 'PENDING' },
      { id: 'b', objective: 'b', dependsOn: ['a'], state: 'PENDING' },
      { id: 'c', objective: 'c', dependsOn: ['a'], state: 'PENDING' },
      { id: 'd', objective: 'd', dependsOn: ['b', 'c'], state: 'PENDING' },
      { id: 'e', objective: 'e', dependsOn: ['a'], state: 'PENDING' },
    ])

    expect(graph.nodes).toHaveLength(5)
    expect(graph.nodes.every(node => !node.id.includes('\u0000'))).toBe(true)
    expect(graph.nodes.find(node => node.id === 'a')!.rank).toBe(0)
    expect(graph.nodes.find(node => node.id === 'd')!.rank).toBe(2)
  })

  test('spreads layers with long edges so dummy rows reserve vertical space', () => {
    const graph = layoutTaskGraph([
      { id: 'a', objective: 'a', dependsOn: [], state: 'PENDING' },
      { id: 'b', objective: 'b', dependsOn: ['a'], state: 'PENDING' },
      { id: 'c', objective: 'c', dependsOn: ['a'], state: 'PENDING' },
      { id: 'd', objective: 'd', dependsOn: ['b', 'c'], state: 'PENDING' },
      { id: 'e', objective: 'e', dependsOn: ['a'], state: 'PENDING' },
      { id: 'f', objective: 'f', dependsOn: ['a', 'b'], state: 'PENDING' },
    ])

    // Rank 1 holds b, c, e plus the dummy of the a→f edge, so the canvas
    // height must account for 4 rows instead of compacting to 3.
    expect(graph.nodes.find(node => node.id === 'f')!.rank).toBe(2)
    expect(graph.height).toBe(80 + 4 * NODE_HEIGHT + 3 * LANE_GAP)
  })

  test('produces a deterministic layout for the same input', () => {
    const input = [
      { id: 'a', objective: 'a', dependsOn: [], state: 'PENDING' },
      { id: 'b', objective: 'b', dependsOn: [], state: 'PENDING' },
      { id: 'x', objective: 'x', dependsOn: ['a', 'b'], state: 'PENDING' },
      { id: 'y', objective: 'y', dependsOn: ['b'], state: 'PENDING' },
    ]
    const first = layoutTaskGraph(input)
    const second = layoutTaskGraph(input)
    expect(first.nodes.map(node => [node.id, node.x, node.y])).toEqual(second.nodes.map(node => [node.id, node.x, node.y]))
  })
})

/** Counts crossings of the rendered straight-line edge segments. */
function geometricCrossings(nodes: Array<{ id: string; x: number; y: number }>, edges: Array<{ from: string; to: string }>) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const segments = edges.map(edge => {
    const from = byId.get(edge.from)!
    const to = byId.get(edge.to)!
    return { x1: from.x + NODE_WIDTH, y1: from.y + NODE_HEIGHT / 2, x2: to.x, y2: to.y + NODE_HEIGHT / 2, edge }
  })
  let count = 0
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const left = segments[i]!
      const right = segments[j]!
      const sharedEndpoint = [left.edge.from, left.edge.to].some(id => id === right.edge.from || id === right.edge.to)
      if (!sharedEndpoint && properIntersection(left, right)) count++
    }
  }
  return count
}

function properIntersection(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }) {
  const orientation = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => {
    const value = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
    return value > 0 ? 1 : value < 0 ? -1 : 0
  }
  const o1 = orientation({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 })
  const o2 = orientation({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x2, y: b.y2 })
  const o3 = orientation({ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }, { x: a.x1, y: a.y1 })
  const o4 = orientation({ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }, { x: a.x2, y: a.y2 })
  return o1 !== o2 && o3 !== o4
}

test('collapsing a branch hides only exclusive downstream work and retains shared joins', () => {
  const graph = visibleTaskGraph([
    { id: 'a', objective: 'a', dependsOn: [], state: 'PENDING' },
    { id: 'b', objective: 'b', dependsOn: [], state: 'PENDING' },
    { id: 'd', objective: 'd', dependsOn: ['a'], state: 'PENDING' },
    { id: 'shared', objective: 'shared', dependsOn: ['b', 'd'], state: 'PENDING' },
  ], new Set(['a']))

  expect(graph.nodes.map(node => node.id)).toEqual(['a', 'b', 'shared'])
  expect(graph.hiddenBy.get('a')).toEqual(['d'])
  expect(graph.edges).toEqual([{ from: 'b', to: 'shared' }])
})

test('truncates SVG node labels before they can exceed the fixed node width', () => {
  expect(truncateGraphText('这是一个很长很长很长的中文任务目标', 8)).toBe('这是一个很长很…')
  expect(truncateGraphText('short', 8)).toBe('short')
})

test('keeps a minimum SVG canvas after a branch is folded', () => {
  expect(stableCanvasSize({ width: 472, height: 192 })).toEqual({ width: 1100, height: 640 })
  expect(stableCanvasSize({ width: 1200, height: 720 })).toEqual({ width: 1100, height: 640 })
})

test('maps durable states to a closed visual vocabulary', () => {
  expect(taskStatePresentation('BLOCKED')).toMatchObject({ tone: 'error', label: '受阻' })
  expect(taskStatePresentation('INVALIDATED')).toMatchObject({ tone: 'muted', label: '已失效' })
  expect(taskStatePresentation('UNKNOWN')).toMatchObject({ tone: 'muted', label: '未知状态' })
})

test('gives every DAG state tone a visible node stroke, including running', () => {
  expect(dagToneCss).toContain('.ltr-node.tone-ongoing>rect')
  expect(dagToneCss).toContain('.ltr-node.tone-done>rect')
  expect(dagToneCss).toContain('.ltr-node.tone-error>rect')
  expect(dagToneCss).toContain('.ltr-node.tone-warning>rect')
  expect(dagToneCss).toContain('.ltr-node.tone-muted>rect')
})

test('renders progress with the current task objective instead of its internal id', () => {
  expect(formatTaskProgress({ settled: 2, total: 7 }, { objective: '检索并去重资料' })).toBe('2/7 · 当前：检索并去重资料')
  expect(formatTaskProgress({ settled: 2, total: 7 }, { objective: '系统研究影响 RAG 准确率的文档处理因素：数据清洗、去重、元数据，以及需要保留的执行说明。' })).toBe('2/7 · 当前：系统研究影响 RAG 准确率的文档处理因素：数据清洗、去重、元数据…')
})

test('counts settled work including failed and blocked nodes as real progress', () => {
  expect(taskStripPresentation({ state: 'RUNNING', progress: { settled: 1, total: 14 }, currentOrLastNode: { objective: '调研嵌入模型' } })).toMatchObject({ progress: '1/14 · 当前：调研嵌入模型' })
  expect(formatTaskProgress({ settled: 5, total: 14 }, { objective: '调研嵌入模型' })).toBe('5/14 · 当前：调研嵌入模型')
})

test('never crashes the strip on a raw goal view that lacks summary progress fields', () => {
  expect(formatTaskProgress(undefined, undefined)).toBe('0/0')
  expect(taskStripPresentation({ state: 'RUNNING' })).toMatchObject({ progress: '0/0', label: '运行中', detail: '' })
})

test('labels a web-marked-running task as waiting for a session driver', () => {
  expect(taskStripPresentation({ state: 'RUNNING', progress: { settled: 0, total: 14 }, currentOrLastNode: { objective: '调研嵌入模型', state: 'PENDING' } })).toMatchObject({ progress: '0/14 · 当前：调研嵌入模型', detail: '等待会话驱动执行 · 调研嵌入模型' })
  expect(taskStripPresentation({ state: 'RUNNING', progress: { settled: 2, total: 14 }, currentOrLastNode: { objective: '调研嵌入模型', state: 'RUNNING' } })).toMatchObject({ detail: '调研嵌入模型' })
})

test('keeps the selected-node frame visually distinct from the running tone', () => {
  expect(dagToneCss).toContain('.ltr-node.is-selected>rect')
  expect(dagToneCss).toMatch(/\.ltr-node\.is-selected>rect\{[^}]*label-primary/)
  expect(dagToneCss).not.toContain('.ltr-node-ring')
  expect(dagToneCss).not.toContain('.ltr-node.is-selected .ltr-node-ring')
})
