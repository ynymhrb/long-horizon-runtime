/** 决策质量评测场景的运行前契约。 */

export class DecisionScenarioError extends Error {
  /** @param {string} source @param {string[]} problems */
  constructor(source, problems) {
    super(`决策场景契约错误（${source}）：\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.name = 'DecisionScenarioError'
    this.problems = problems
  }
}

/**
 * 校验并冻结一个可重复的决策场景。隐藏的 potential_outcome 只允许 fixture
 * 使用，公开视图由 scorer 层负责剥离。
 * @param {unknown} raw
 * @param {string} [source]
 */
export function validateDecisionScenario(raw, source = 'scenario') {
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DecisionScenarioError(source, ['场景必须是对象'])
  }
  const doc = /** @type {Record<string, unknown>} */ (raw)
  if (!nonBlank(doc.id)) problems.push('id 必须是非空字符串')
  if (!positiveInteger(doc.version)) problems.push('version 必须是正整数')
  if (!nonBlank(doc.goal)) problems.push('goal 必须是非空字符串')
  if (!Array.isArray(doc.constraints) || doc.constraints.some(item => !nonBlank(item))) problems.push('constraints 必须是字符串数组')
  if (!isInitialState(doc.initial_state)) problems.push('initial_state 必须包含稳定 hash')
  if (!isContinuationPolicy(doc.continuation_policy)) problems.push('continuation_policy 必须包含 id 和正整数 version')

  const points = Array.isArray(doc.decision_points) ? doc.decision_points : []
  if (!Array.isArray(doc.decision_points) || points.length === 0) problems.push('decision_points 必须是非空数组')
  const pointIds = new Set()
  for (const [pointIndex, point] of points.entries()) {
    if (point === null || typeof point !== 'object' || Array.isArray(point)) {
      problems.push(`decision_points[${pointIndex}] 必须是对象`)
      continue
    }
    const value = /** @type {Record<string, unknown>} */ (point)
    if (!nonBlank(value.id)) problems.push(`decision_points[${pointIndex}].id 必须是非空字符串`)
    else if (pointIds.has(value.id)) problems.push(`决策点 ID 重复：${value.id}`)
    else pointIds.add(value.id)
    const actions = Array.isArray(value.actions) ? value.actions : []
    if (actions.length < 2) problems.push(`decision_points[${pointIndex}] 的候选行动至少需要两个`)
    const actionIds = new Set()
    for (const [actionIndex, action] of actions.entries()) validateAction(action, pointIndex, actionIndex, actionIds, problems)
  }

  if (!isOracle(doc.oracle)) problems.push('oracle 必须包含非空 id 和 command 数组')
  if (problems.length > 0) throw new DecisionScenarioError(source, problems)
  return deepFreeze(structuredClone(/** @type {object} */ (raw)))
}

/** @param {unknown} action @param {number} pointIndex @param {number} actionIndex @param {Set<string>} actionIds @param {string[]} problems */
function validateAction(action, pointIndex, actionIndex, actionIds, problems) {
  const label = `decision_points[${pointIndex}].actions[${actionIndex}]`
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    problems.push(`${label} 必须是对象`)
    return
  }
  const value = /** @type {Record<string, unknown>} */ (action)
  if (!nonBlank(value.id)) problems.push(`${label}.id 必须是非空字符串`)
  else if (actionIds.has(value.id)) problems.push(`候选行动 ID 重复：${value.id}`)
  else actionIds.add(value.id)
  if (!nonBlank(value.kind)) problems.push(`${label}.kind 必须是非空字符串`)
  if (!Array.isArray(value.command) || value.command.length === 0 || value.command.some(part => !nonBlank(part))) problems.push(`${label}.command 必须是非空字符串数组`)
  if (!finiteNonNegative(value.cost)) problems.push(`${label}.cost 必须是非负有限数`)
  if (!unitInterval(value.irreversibility_risk)) problems.push(`${label}.irreversibility_risk 必须在 0 到 1 之间`)
  if (!unitInterval(value.constraint_risk)) problems.push(`${label}.constraint_risk 必须在 0 到 1 之间`)
  if (value.potential_outcome !== undefined && !finiteNumber(value.potential_outcome)) problems.push(`${label}.potential_outcome 必须是有限数`)
}

/** @param {unknown} value */
function nonBlank(value) { return typeof value === 'string' && value.trim() !== '' }
/** @param {unknown} value */
function positiveInteger(value) { return typeof value === 'number' && Number.isInteger(value) && value > 0 }
/** @param {unknown} value */
function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value) }
/** @param {unknown} value */
function finiteNonNegative(value) { return finiteNumber(value) && value >= 0 }
/** @param {unknown} value */
function unitInterval(value) { return finiteNumber(value) && value >= 0 && value <= 1 }
/** @param {unknown} value */
function isInitialState(value) { return value !== null && typeof value === 'object' && nonBlank(/** @type {Record<string, unknown>} */ (value).hash) }
/** @param {unknown} value */
function isContinuationPolicy(value) { return value !== null && typeof value === 'object' && nonBlank(/** @type {Record<string, unknown>} */ (value).id) && positiveInteger(/** @type {Record<string, unknown>} */ (value).version) }
/** @param {unknown} value */
function isOracle(value) { return value !== null && typeof value === 'object' && nonBlank(/** @type {Record<string, unknown>} */ (value).id) && Array.isArray(/** @type {Record<string, unknown>} */ (value).command) && /** @type {Record<string, unknown>} */ (value).command.length > 0 }

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
