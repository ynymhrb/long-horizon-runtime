import { describe, expect, test } from 'vitest'
import { layoutTaskGraph, stableCanvasSize, truncateGraphText, visibleTaskGraph } from '../client/task-graph.js'
import { dagToneCss, formatTaskProgress, taskStatePresentation } from '../client/task-presentation.js'

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
})

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
  expect(formatTaskProgress({ succeeded: 2, total: 7 }, { objective: '检索并去重资料' })).toBe('2/7 · 当前：检索并去重资料')
  expect(formatTaskProgress({ succeeded: 2, total: 7 }, { objective: '系统研究影响 RAG 准确率的文档处理因素：数据清洗、去重、元数据，以及需要保留的执行说明。' })).toBe('2/7 · 当前：系统研究影响 RAG 准确率的文档处理因素：数据清洗、去重、元数据…')
})
