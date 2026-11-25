import { describe, expect, test, vi } from 'vitest'
import { LongTaskRuntime } from '../src/runtime.js'
import { parseWorkflow, workflowStep } from '../src/workflow.js'

const delivery = {
  mode: 'workflow', entry: 'design', stages: [
    { id: 'design', objective: '设计', profile: 'claude', maxVisits: 3, next: 'review' },
    { id: 'review', objective: '评审', profile: 'codex', maxVisits: 3, next: 'build', onChangesRequested: 'design' },
    { id: 'build', objective: '开发', profile: 'codex', sideEffectClass: 'idempotent' },
  ],
} as const

describe('声明式流程', () => {
  test('评审退回后追加新设计，开发只依赖已通过的设计版本', async () => {
    const plan = vi.fn()
    const seen: Array<{ id: string; dependencies: string[] }> = []
    const runtime = new LongTaskRuntime({ plan }, {
      async execute(input) {
        seen.push({ id: input.taskId, dependencies: input.context.artifacts.map(artifact => artifact.taskId) })
        const isReview = input.taskId.includes('review')
        const text = input.taskId.endsWith('-2')
          ? '{"verdict":"changes_requested","reason":"缺少输入契约"}'
          : '{"verdict":"approved","reason":"已覆盖"}'
        return { status: 'succeeded', summary: '完成', evidence: [], artifacts: [{ type: isReview ? 'review' : 'note', content: isReview ? text : input.taskId }] }
      },
    })
    try {
      const created = await runtime.createGoal({ objective: '交付功能', orchestration: parseWorkflow(delivery) }, {})
      expect(plan).not.toHaveBeenCalled()
      expect(created.state).toBe('SUCCEEDED')
      expect(seen.map(x => x.id)).toEqual(['wf-design-1', 'wf-review-2', 'wf-design-3', 'wf-review-4', 'wf-build-5'])
      expect(seen.at(-1)?.dependencies).toEqual(expect.arrayContaining(['wf-design-3', 'wf-review-4']))
      expect(seen.at(-1)?.dependencies).not.toContain('wf-design-1')
      expect(runtime.store.listEvents(created.id, 0, 200).filter(x => x.type === 'WorkflowAdvanced')).toHaveLength(4)
      runtime.store.rebuild()
      expect(runtime.getStatus(created.id)?.state).toBe('SUCCEEDED')
    } finally { runtime.close() }
  })

  test('讨论按轮次分配发言和总结，拒绝未登记的角色', () => {
    const spec = parseWorkflow({ mode: 'discussion', participants: ['a', 'b', 'c'], rounds: 2, moderator: 'a' }, ['a', 'b', 'c'])
    const ids = [] as string[]
    for (let i = 0; i < 7; i++) ids.push(workflowStep(spec, '目标', ids)!.id)
    expect(ids).toEqual(['wf-speaker-1', 'wf-speaker-2', 'wf-speaker-3', 'wf-speaker-4', 'wf-speaker-5', 'wf-speaker-6', 'wf-summary-7'])
    expect(workflowStep(spec, '目标', ids)).toBeUndefined()
    expect(() => parseWorkflow(delivery, ['claude'])).toThrow(/codex/)
  })
})
test('流程变更保留已完成前缀，拒绝改写历史并等待新修订确认', async () => {
  const observed: string[] = []
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, {
    async execute(input) {
      observed.push(input.taskId)
      if (input.taskId === 'wf-first-1') runtime.pauseGoal(runtime.store.listGoals()[0]!.id, 'operator')
      return { status: 'succeeded', summary: '完成', evidence: [], artifacts: [{ type: 'note', content: '结果' }] }
    },
  })
  const spec = parseWorkflow({
    mode: 'workflow', entry: 'first', stages: [
      { id: 'first', objective: '设计', profile: 'a', next: 'last' },
      { id: 'last', objective: '旧评审', profile: 'a' },
    ],
  })
  try {
    const task = await runtime.createGoal({ objective: '任务', orchestration: spec })
    runtime.store.transaction(() => runtime.store.append([
      { type: 'TaskAttemptStarted', goalId: task.id, taskId: 'wf-first-1', payload: { attemptId: 'first', revision: 1 } },
      { type: 'TaskCompleted', goalId: task.id, taskId: 'wf-first-1', payload: { attemptId: 'first' } },
    ]))
    const paused = runtime.pauseGoal(task.id, 'operator')
    if (spec.mode !== 'workflow') throw new Error('测试结构错误')
    const modified = { ...spec, stages: [spec.stages[0]!, { ...spec.stages[1]!, objective: '新评审', profile: 'b' }] }
    expect(() => runtime.proposeWorkflow(task.id, { ...modified, stages: [{ ...spec.stages[0]!, objective: '更换历史' }, modified.stages[1]!] }, '更新', paused.controlRevision)).toThrow(/已完成/)
    const proposed = runtime.proposeWorkflow(task.id, modified, '更新评审', paused.controlRevision)
    expect(proposed.state).toBe('AWAITING_CONFIRMATION')
    await expect(runtime.confirmGoal(task.id, {})).rejects.toThrow('任务区')
    await runtime.confirmGoal(task.id, {}, undefined, 'operator')
    expect(observed).toEqual(['wf-last-2'])
    expect(runtime.getStatus(task.id)?.state).toBe('SUCCEEDED')
  } finally { runtime.close() }
})

test('已完成评审在重启后只生成一次后续节点', async () => {
  const spec = parseWorkflow({
    mode: 'workflow', entry: 'a', stages: [
      { id: 'a', objective: '开始', profile: 'a', next: 'b' },
      { id: 'b', objective: '收尾', profile: 'a' },
    ],
  })
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, { execute: vi.fn() })
  try {
    const task = await runtime.createGoal({ objective: '目标', orchestration: spec })
    runtime.store.transaction(() => runtime.store.append([
      { type: 'TaskAttemptStarted', goalId: task.id, taskId: 'wf-a-1', payload: { attemptId: 'a1', revision: 1 } },
      { type: 'TaskCompleted', goalId: task.id, taskId: 'wf-a-1', payload: { attemptId: 'a1' } },
    ]))
    await runtime.recover()
    await runtime.recover()
    expect(runtime.getStatus(task.id)?.tasks.map(node => [node.id, node.state])).toEqual([['wf-a-1', 'SUCCEEDED'], ['wf-b-2', 'PENDING']])
    expect(runtime.store.listEvents(task.id, 0, 100).filter(event => event.type === 'WorkflowAdvanced')).toHaveLength(1)
  } finally { runtime.close() }
})

test('主持人可在完整轮次后收敛并生成总结', async () => {
  const seen: string[] = []
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, { async execute(input) {
    seen.push(input.taskId)
    const review = input.taskId.includes('convergence')
    return { status: 'succeeded', summary: '结果', evidence: [], artifacts: [
      { type: review ? 'review' : 'note', content: review ? '{"verdict":"approved","reason":"达成共识"}' : '累计摘要' },
    ] }
  } })
  try {
    const goal = await runtime.createGoal({ objective: '决策', orchestration: {
      mode: 'discussion', rounds: 10, participants: [{ id: 'A', profile: 'p' }, { id: 'B', profile: 'q' }, 'r'], moderator: 'p', convergence: '意见一致',
    } }, {})
    expect(goal.state).toBe('SUCCEEDED')
    expect(seen).toEqual(['wf-speaker-1', 'wf-speaker-2', 'wf-speaker-3', 'wf-convergence-4', 'wf-summary-5'])
  } finally { runtime.close() }
})

test('任务区确认外部操作已完成后，不依赖父会话展开后续步骤', async () => {
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, {
    async execute() { return { status: 'failed', failureKind: 'infrastructure', summary: '连接中断', evidence: [], artifacts: [] } },
  })
  try {
    const spec = parseWorkflow({ mode: 'workflow', entry: 'publish', stages: [
      { id: 'publish', objective: '提交结果', profile: 'a', sideEffectClass: 'external_effect', next: 'verify' },
      { id: 'verify', objective: '验证回执', profile: 'a' },
    ] })
    const paused = await runtime.createGoal({ objective: '发布', orchestration: spec }, {})
    expect(paused.state).toBe('PAUSED')
    const resumed = await runtime.resumeGoal(paused.id, undefined, 'confirmed_succeeded', undefined, 'operator')
    expect(resumed.requiresSessionDriver).toBe(true)
    expect(resumed.tasks.map(task => [task.id, task.state])).toEqual([['wf-publish-1', 'SUCCEEDED'], ['wf-verify-2', 'PENDING']])
  } finally { runtime.close() }
})
