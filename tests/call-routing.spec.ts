import { expect, test } from 'vitest'
import { CallRouter } from '../src/call-routing.js'

test('模型端点按角色、可用名额路由，并在流结束后释放', async () => {
  const router = new CallRouter([
    { id: 'primary', provider: 'a', model: 'm', roles: ['execution'], maxConcurrent: 1 },
    { id: 'secondary', provider: 'b', model: 'm', roles: ['execution'], maxConcurrent: 1 },
    { id: 'planner', provider: 'p', model: 'm', roles: ['planner'], maxConcurrent: 1 },
  ])
  async function* stream() { yield 'chunk' }
  const a = new AbortController()
  const b = new AbortController()
  const prior = { provider: 'parent', model: 'fallback' }
  await Promise.all([
    router.run('execution', 'parent', async () => {
      expect(await router.route('child-a', a.signal, prior)).toMatchObject({ provider: 'a' })
      await new Promise<void>(resolve => setImmediate(resolve))
      for await (const chunk of router.stream('child-a', 'a', 'm', stream)) expect(chunk).toBe('chunk')
    }),
    router.run('execution', 'parent', async () => {
      expect(await router.route('child-b', b.signal, prior)).toMatchObject({ provider: 'b' })
    }),
  ])
  await router.run('planner', 'parent', async () => {
    expect(await router.route('parent', a.signal, prior)).toBe(prior)
    expect(await router.route('p-child', a.signal, prior)).toMatchObject({ provider: 'p' })
  })
})

test('工具并发只约束当前受管子 Agent，取消等待时不会派发', async () => {
  const router = new CallRouter([], [{ name: 'read', maxConcurrent: 1 }])
  const hold = Promise.withResolvers<string>()
  const signal = new AbortController().signal
  const abort = new AbortController()
  await router.run('execution', 'parent', async () => {
    await router.route('child', signal, { provider: 'a', model: 'a' })
    const first = router.tool('child', 'read', signal, () => hold.promise)
    await expect(router.tool('parent', 'read', signal, async () => 'parent')).resolves.toBe('parent')
    const second = router.tool('child', 'read', abort.signal, async () => 'unexpected')
    abort.abort(new Error('cancelled'))
    await expect(second).rejects.toThrow('cancelled')
    hold.resolve('first')
    await expect(first).resolves.toBe('first')
  })
})
