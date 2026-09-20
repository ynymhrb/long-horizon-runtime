import { expect, test } from 'vitest'
import { createDeepSeekDecisionModel } from '../validation/decision-quality/live-model.mjs'

test('缺少密钥时安全拒绝创建模型', () => {
  expect(() => createDeepSeekDecisionModel({ apiKey: '', model: 'deepseek-chat', tokenBudget: 100 })).toThrow(/DEEPSEEK_API_KEY/)
})

test('请求和错误对象均不包含 API 密钥，且累计 usage 受预算限制', async () => {
  const secret = 'test-secret-value'
  let request: Request | undefined
  const model = createDeepSeekDecisionModel({
    apiKey: secret, model: 'deepseek-chat', tokenBudget: 8,
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(url, init)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ actionId: 'a', causalAdvantage: 1, informationValue: 0, lower: 0, upper: 1, evidenceRefs: ['e'] }]) } }], usage: { total_tokens: 8 } }), { status: 200 })
    },
  })
  const result = await model.evaluate({ actions: [{ id: 'a' }] })
  expect(result.usage.totalTokens).toBe(8)
  expect(await request?.text()).not.toContain(secret)
  await expect(model.evaluate({ actions: [{ id: 'a' }] })).rejects.toThrow(/预算/)
})
