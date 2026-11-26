import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { LongTaskRuntime } from '../src/runtime.js'
import type { ExecutionAdapter, PlannerAdapter } from '../src/adapters.js'

function strictTask(id: string, objective: string) {
  return { id, objective, dependsOn: [], priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only' as const, validator: 'required' }
}

const planner: PlannerAdapter = {
  async plan(input) { return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'work')] } },
}
const execution: ExecutionAdapter = {
  async execute() { return { status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] } },
}

async function runningGoal(): Promise<LongTaskRuntime> {
  const runtime = new LongTaskRuntime(planner, execution)
  const created = await runtime.createGoal({ objective: 'read only research', planningMode: 'require_confirmation' })
  const confirmed = await runtime.confirmGoal(created.id)
  expect(confirmed.state).toBe('RUNNING')
  return runtime
}

function goalIdOf(runtime: LongTaskRuntime): string {
  const goal = runtime.listGoals()[0]
  if (goal === undefined) throw new Error('no goal created')
  return goal.id
}

test('操作者暂停后代理无法把它恢复运行', async () => {
  const runtime = await runningGoal()
  const id = goalIdOf(runtime)
  runtime.pauseGoal(id, 'operator')

  await expect(runtime.resumeGoal(id)).rejects.toThrow(/paused by the operator/)
  expect(runtime.getStatus(id)?.state).toBe('PAUSED')
  expect(runtime.store.getGoal(id)?.pauseOrigin).toBe('operator')
  expect(runtime.store.listEvents(id).filter(event => event.type === 'GoalResumed')).toHaveLength(0)
})

test('操作者暂停后操作者可以恢复', async () => {
  const runtime = await runningGoal()
  const id = goalIdOf(runtime)
  runtime.pauseGoal(id, 'operator')

  const resumed = await runtime.resumeGoal(id, undefined, undefined, undefined, 'operator')
  expect(resumed.state).toBe('RUNNING')
  expect(runtime.store.getGoal(id)?.pauseOrigin).toBeUndefined()
})

test('代理自己暂停的任务仍允许代理恢复', async () => {
  const runtime = await runningGoal()
  const id = goalIdOf(runtime)
  const paused = runtime.pauseGoal(id, 'agent')

  expect(paused.pauseReason).toBe('agent_requested')
  expect(runtime.store.getGoal(id)?.pauseOrigin).toBe('agent')
  expect((await runtime.resumeGoal(id)).state).toBe('RUNNING')
})

test('系统来源（重启恢复/额度恢复）同样不能解除操作者暂停', async () => {
  const runtime = await runningGoal()
  const id = goalIdOf(runtime)
  runtime.pauseGoal(id, 'operator')

  await expect(runtime.resumeGoal(id, undefined, undefined, undefined, 'system')).rejects.toThrow(/paused by the operator/)
  // 重启恢复扫描不得崩溃，也不得改变已暂停的任务状态。
  await runtime.recover({})
  expect(runtime.getStatus(id)?.state).toBe('PAUSED')
  expect(runtime.store.listEvents(id).filter(event => event.type === 'GoalResumed')).toHaveLength(0)
})

test('任务条不再静默吞掉暂停/恢复请求失败', () => {
  const source = readFileSync(new URL('../client/TaskStrip.js', import.meta.url), 'utf8')
  expect(source).not.toContain(".catch(() => undefined)\n      .then(() => remote.getCurrentTaskForSession")
  expect(source).toContain('setDriverNotice')
  expect(source).toContain('conflict')
})

test('驱动消息提醒代理不要覆盖用户暂停', () => {
  const source = readFileSync(new URL('../client/task-model.js', import.meta.url), 'utf8')
  expect(source).toContain('已被用户暂停')
})
