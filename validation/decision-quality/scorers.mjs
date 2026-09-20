/** 决策方法的统一评分接口；任何模型只接收剥离真值后的公开视图。 */

const METHODS = new Set(['local_progress', 'goal_value', 'causal_advantage', 'full'])

/** @param {string} method @param {{ model?: (input: object) => Promise<object[]> | object[], lambda?: number, alpha?: number, beta?: number, gamma?: number }} [options] */
export function createScorer(method, options = {}) {
  if (!METHODS.has(method)) throw new Error(`未知评分方法：${method}`)
  return { async score(input) {
    const view = publicDecisionView(input)
    const raw = options.model === undefined ? heuristic(method, view) : await options.model(view)
    return validateAndNormalize(raw, input, method, options)
  } }
}

/** @param {{ actions: object[] } & Record<string, unknown>} input */
export function publicDecisionView(input) {
  const { actions, ...rest } = input
  return {
    ...rest,
    actions: (actions ?? []).map(action => {
      const { potential_outcome: _hidden, ...visible } = action
      return visible
    }),
  }
}

/** @param {{ actionId: string, total: number, lower: number, upper: number, irreversibilityRisk: number, constraintRisk: number }[]} estimates @param {{ negativeAction: string }} options */
export function chooseConservatively(estimates, options) {
  if (!Array.isArray(estimates) || estimates.length === 0) return { actionId: options.negativeAction, reason: '没有可用估计' }
  const best = Math.max(...estimates.map(row => row.total))
  const contenders = estimates.filter(row => row.upper >= best && row.lower <= best)
  const safe = contenders.sort((left, right) => (left.irreversibilityRisk + left.constraintRisk) - (right.irreversibilityRisk + right.constraintRisk) || left.actionId.localeCompare(right.actionId))[0]
  if (safe === undefined || safe.lower < 0) return { actionId: options.negativeAction, reason: '所有行动的保守下界为负' }
  return { actionId: safe.actionId, reason: contenders.length > 1 ? '置信区间重叠，选择风险最低行动' : '最高保守评分行动' }
}

/** @param {object[]} raw @param {{ actions: any[], evidenceIds?: string[] }} input @param {string} method @param {any} options */
function validateAndNormalize(raw, input, method, options) {
  if (!Array.isArray(raw) || raw.length !== input.actions.length) throw new Error('评分输出必须覆盖全部候选行动')
  const expected = new Set(input.actions.map(action => action.id))
  const seen = new Set()
  const evidenceIds = new Set(input.evidenceIds ?? [])
  return raw.map(row => {
    if (row === null || typeof row !== 'object' || typeof row.actionId !== 'string' || !expected.has(row.actionId) || seen.has(row.actionId)) throw new Error('评分输出包含未知或重复行动')
    seen.add(row.actionId)
    const action = input.actions.find(candidate => candidate.id === row.actionId)
    const causalAdvantage = number(row.causalAdvantage)
    const informationValue = number(row.informationValue)
    const lower = number(row.lower)
    const upper = number(row.upper)
    if (lower > upper) throw new Error('评分输出的置信区间无效')
    if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length === 0 || row.evidenceRefs.some(ref => typeof ref !== 'string' || !evidenceIds.has(ref))) throw new Error('评分输出缺少可用证据引用')
    const total = method === 'full'
      ? causalAdvantage + (options.lambda ?? 1) * informationValue - (options.alpha ?? 1) * action.cost - (options.beta ?? 1) * action.irreversibility_risk - (options.gamma ?? 1) * action.constraint_risk
      : method === 'causal_advantage' ? causalAdvantage : method === 'goal_value' ? causalAdvantage + informationValue : informationValue - action.cost
    return { actionId: row.actionId, total, lower, upper, causalAdvantage, informationValue, evidenceRefs: [...row.evidenceRefs], irreversibilityRisk: action.irreversibility_risk, constraintRisk: action.constraint_risk }
  })
}

/** @param {string} method @param {{ actions: any[] }} view */
function heuristic(method, view) {
  return view.actions.map(action => ({
    actionId: action.id,
    causalAdvantage: method === 'local_progress' ? 0 : -action.cost,
    informationValue: action.kind === 'diagnose' ? 0.1 : 0,
    lower: -action.cost,
    upper: 1 - action.cost,
    evidenceRefs: ['synthetic-prior'],
  }))
}
/** @param {unknown} value */
function number(value) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('评分输出包含非有限数'); return value }
