/** 安全、显式预算门禁下的 DeepSeek 结构化决策调用。 */

/** @param {{ apiKey: string, model: string, tokenBudget: number, timeoutMs?: number, fetchImpl?: typeof fetch }} options */
export function createDeepSeekDecisionModel(options) {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') throw new Error('缺少 DEEPSEEK_API_KEY')
  if (!Number.isInteger(options.tokenBudget) || options.tokenBudget <= 0) throw new Error('token 预算必须为正整数')
  const fetchImpl = options.fetchImpl ?? fetch
  let used = 0
  return {
    async evaluate(input) {
      if (used >= options.tokenBudget) throw new Error('token 预算已耗尽')
      const body = JSON.stringify({ model: options.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: JSON.stringify({ task: '为候选行动给出结构化评分', input }) }] })
      let response
      try {
        response = await fetchImpl('https://api.deepseek.com/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` }, body,
          signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
        })
      } catch (error) { throw new Error(`模型请求失败：${safeError(error)}`) }
      if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status}`)
      let payload
      try { payload = await response.json() } catch { throw new Error('模型返回非 JSON 响应') }
      const totalTokens = payload?.usage?.total_tokens
      if (!Number.isInteger(totalTokens) || totalTokens < 0) throw new Error('模型响应缺少可审计 usage')
      used += totalTokens
      if (used > options.tokenBudget) throw new Error('token 预算已耗尽')
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('模型响应缺少 choices 内容')
      try { return { output: JSON.parse(content), usage: { totalTokens, usedTokens: used } } } catch { throw new Error('模型输出不是 JSON') }
    },
    usage() { return { usedTokens: used, tokenBudget: options.tokenBudget } },
  }
}

/** @param {unknown} error */
function safeError(error) { return error instanceof Error ? error.name : 'unknown' }
