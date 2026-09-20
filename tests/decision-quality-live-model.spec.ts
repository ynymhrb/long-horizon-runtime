import { expect, test } from 'vitest'
import { createDeepSeekDecisionModel } from '../validation/decision-quality/live-model.mjs'

test('缺少密钥时安全拒绝创建模型', () => {
  expect(() => createDeepSeekDecisionModel({ apiKey: '', model: 'deepseek-chat', tokenBudget: 100 })).toThrow(/DEEPSEEK_API_KEY/)
})

test('请求和错误对象均不包含 API 密钥，且累计 usage 受预算限制', async () => {
  const secret = 'test-secret-value'
  let request: Request | undefined
  const model = createDeepSeekDecisionModel({
    apiKey: secret, model: 'deepseek-chat', tokenBudget: 1_000, maxCompletionTokens: 64,
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(url, init)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ actionId: 'a', causalAdvantage: 1, informationValue: 0, lower: 0, upper: 1, evidenceRefs: ['e'] }]) } }], usage: { total_tokens: 8 } }), { status: 200 })
    },
  })
  const result = await model.evaluate({ actions: [{ id: 'a' }] })
  expect(result.usage.totalTokens).toBe(8)
  const requestBody = await request?.text() ?? '{}'
  expect(requestBody).not.toContain(secret)
  expect(JSON.parse(requestBody).max_tokens).toBeGreaterThan(0)
})

test('请求前为输入和输出预留 token，预算不足时不发出请求', async () => {
  let called = false
  const model = createDeepSeekDecisionModel({
    apiKey: 'test-secret', model: 'deepseek-chat', tokenBudget: 10,
    fetchImpl: async () => { called = true; return new Response('{}') },
  })
  await expect(model.evaluate({ goal: '这是一个足够长的中文目标，用于证明输入本身会耗尽极小预算。', actions: [{ id: 'a' }] })).rejects.toThrow(/预留/)
  expect(called).toBe(false)
})
