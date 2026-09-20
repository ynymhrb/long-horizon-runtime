/** 反事实行动真值与决策质量指标。 */

/** @param {{ actionId: string, utility: number }[]} outcomes */
export function deriveCausalAdvantages(outcomes) {
  assertOutcomes(outcomes)
  return outcomes.map(current => {
    const alternatives = outcomes.filter(row => row.actionId !== current.actionId)
    return { actionId: current.actionId, advantage: current.utility - Math.max(...alternatives.map(row => row.utility)) }
  })
}

/**
 * @param {{ actionId: string, estimate: number }[]} estimates
 * @param {{ actionId: string, utility: number }[]} outcomes
 */
export function scoreDecisionPoint(estimates, outcomes) {
  try {
    assertOutcomes(outcomes)
    if (!Array.isArray(estimates) || estimates.length !== outcomes.length || new Set(estimates.map(row => row.actionId)).size !== outcomes.length) return { verdict: 'inconclusive', reason: '候选行动估计不完整' }
    const outcomeIds = new Set(outcomes.map(row => row.actionId))
    if (estimates.some(row => !outcomeIds.has(row.actionId) || !Number.isFinite(row.estimate))) return { verdict: 'inconclusive', reason: '候选行动估计无效' }
    const maxEstimate = Math.max(...estimates.map(row => row.estimate))
    const chosen = estimates.filter(row => row.estimate === maxEstimate).map(row => row.actionId)
    const maxUtility = Math.max(...outcomes.map(row => row.utility))
    const optimal = outcomes.filter(row => row.utility === maxUtility).map(row => row.actionId)
    const truth = new Map(deriveCausalAdvantages(outcomes).map(row => [row.actionId, row.advantage]))
    const mse = estimates.reduce((sum, estimate) => sum + (estimate.estimate - /** @type {number} */ (truth.get(estimate.actionId))) ** 2, 0) / estimates.length
    return { verdict: 'complete', bestActionHit: chosen.some(id => optimal.includes(id)), tieAware: chosen.length > 1 || optimal.length > 1, gccaMse: mse, chosen, optimal }
  } catch (error) {
    return { verdict: 'inconclusive', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** @param {{ verdict: string, bestActionHit?: boolean, gccaMse?: number, rankTau?: number, taskSuccess?: boolean, wrongPathLength?: number, replanTimingError?: number, constraintViolation?: boolean, cost?: number }[]} records */
export function aggregateDecisionQuality(records) {
  const complete = records.filter(record => record.verdict === 'complete')
  const hits = complete.filter(record => record.bestActionHit === true).length
  const finite = (field) => complete.map(record => record[field]).filter(value => typeof value === 'number' && Number.isFinite(value))
  return {
    decision_points: { complete: complete.length, inconclusive: records.length - complete.length },
    best_action_accuracy: rate(hits, complete.length),
    gcca_mse: average(finite('gccaMse')),
    rank_tau_b: average(finite('rankTau')),
    task_success_rate: rate(complete.filter(record => record.taskSuccess === true).length, complete.filter(record => typeof record.taskSuccess === 'boolean').length),
    wrong_path_length: average(finite('wrongPathLength')),
    replan_timing_error: average(finite('replanTimingError')),
    constraint_violation_rate: rate(complete.filter(record => record.constraintViolation === true).length, complete.filter(record => typeof record.constraintViolation === 'boolean').length),
    mean_cost: average(finite('cost')),
  }
}

/**
 * 排名估计与反事实效用之间的 Kendall tau-b；并列对不被误当作排序错误。
 * @param {number[]} estimates @param {number[]} outcomes
 */
export function kendallTauB(estimates, outcomes) {
  if (!Array.isArray(estimates) || !Array.isArray(outcomes) || estimates.length !== outcomes.length || estimates.length < 2 || estimates.some(value => !Number.isFinite(value)) || outcomes.some(value => !Number.isFinite(value))) return null
  let concordant = 0
  let discordant = 0
  let estimateTies = 0
  let outcomeTies = 0
  for (let left = 0; left < estimates.length; left += 1) {
    for (let right = left + 1; right < estimates.length; right += 1) {
      const estimateDelta = Math.sign(estimates[left] - estimates[right])
      const outcomeDelta = Math.sign(outcomes[left] - outcomes[right])
      if (estimateDelta === 0 && outcomeDelta === 0) continue
      if (estimateDelta === 0) { estimateTies += 1; continue }
      if (outcomeDelta === 0) { outcomeTies += 1; continue }
      if (estimateDelta === outcomeDelta) concordant += 1
      else discordant += 1
    }
  }
  const denominator = Math.sqrt((concordant + discordant + estimateTies) * (concordant + discordant + outcomeTies))
  return denominator === 0 ? null : (concordant - discordant) / denominator
}

/** @param {number} numerator @param {number} denominator */
function rate(numerator, denominator) { return { numerator, denominator, rate: denominator === 0 ? 0 : numerator / denominator } }
/** @param {number[]} values */
function average(values) { return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length }
/** @param {unknown} outcomes */
function assertOutcomes(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length < 2) throw new Error('至少需要两个完整候选行动结果')
  const ids = new Set()
  for (const row of outcomes) {
    if (row === null || typeof row !== 'object' || typeof row.actionId !== 'string' || row.actionId === '' || !Number.isFinite(row.utility)) throw new Error('候选行动结果无效')
    if (ids.has(row.actionId)) throw new Error(`候选行动结果重复：${row.actionId}`)
    ids.add(row.actionId)
  }
}
