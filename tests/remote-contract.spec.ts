import { Context } from '@deepseek-ai/cordis'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { expect, test } from 'vitest'
import { apply } from '../src/remote.js'
import { LongTaskRuntime } from '../src/runtime.js'

test('任务区在宿主 Typert 注册表显式贡献路由和参数契约', () => {
  const ctx = new Context()
  const runtime = new LongTaskRuntime({ async plan() { throw new Error('unexpected') } }, { async execute() { throw new Error('unexpected') } })
  let registered: readonly InvocationDescriptor[] = []
  ctx.provide('longTaskRuntime', runtime)
  ctx.provide('typert', {
    register(contribution: { invocations: readonly InvocationDescriptor[] }) { registered = contribution.invocations },
  })
  try {
    apply(ctx)
    expect(ctx.get('longTasks')).toBeDefined()
    expect(registered).toHaveLength(18)
    const list = registered.find(item => item.method === 'listTasks')
    expect(list).toMatchObject({ service: 'longTasks', namespace: 'longTasks', parameters: [{ wire: 'input', codec: { mode: 'strict' } }] })
    const codec = registered.find(item => item.method === 'updateTask')!.parameters[0]!.codec
    if (codec.mode !== 'strict') throw new Error('缺少更新参数契约')
    expect(() => codec.schema.parse({ taskId: 'a', expectedRevision: 1, action: 'bad' })).toThrow()
  } finally { runtime.close() }
})
