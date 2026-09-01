const SHA256 = /^[a-f0-9]{64}$/i

const SHARED_FIELDS = [
  'dshVersion', 'arisCommit', 'arisSkillCount', 'model', 'modelParameters',
  'promptSha256', 'initialInputSha256', 'toolsSha256', 'mcpSha256',
  'networkCondition', 'computeEnvironment', 'tokenBudget', 'wallTimeBudgetMs', 'seed',
]

/** @param {unknown} value @param {string} path */
function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {string} path */
function exactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${path} has unknown field ${key}; only longTaskPlugin.enabled may vary between groups`)
}

/** @param {unknown} value @param {string} path */
function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${path} must be a non-empty string`)
  return value
}

/** @param {Record<string, unknown>} shared */
function validateShared(shared) {
  exactKeys(shared, SHARED_FIELDS, 'shared')
  for (const field of SHARED_FIELDS) if (!(field in shared)) throw new TypeError(`shared.${field} is required`)
  for (const field of ['dshVersion', 'arisCommit', 'model', 'networkCondition', 'computeEnvironment']) nonEmptyString(shared[field], `shared.${field}`)
  for (const field of ['promptSha256', 'initialInputSha256', 'toolsSha256', 'mcpSha256']) {
    if (typeof shared[field] !== 'string' || !SHA256.test(shared[field])) throw new TypeError(`shared.${field} must be a SHA-256 hex digest`)
  }
  for (const field of ['arisSkillCount', 'tokenBudget', 'wallTimeBudgetMs', 'seed']) {
    if (!Number.isSafeInteger(shared[field]) || Number(shared[field]) < 0) throw new TypeError(`shared.${field} must be a non-negative integer`)
  }
  object(shared.modelParameters, 'shared.modelParameters')
}

/** @param {unknown} value @param {string} expectedId @param {boolean} expectedEnabled */
function validateGroup(value, expectedId, expectedEnabled) {
  const group = object(value, `groups.${expectedId}`)
  exactKeys(group, ['id', 'longTaskPlugin', 'command'], `groups.${expectedId}`)
  if (group.id !== expectedId) throw new TypeError(`groups must contain ${expectedId}`)
  const plugin = object(group.longTaskPlugin, `groups.${expectedId}.longTaskPlugin`)
  exactKeys(plugin, ['enabled'], `groups.${expectedId}.longTaskPlugin`)
  if (plugin.enabled !== expectedEnabled) throw new TypeError(`groups.${expectedId}.longTaskPlugin.enabled must be ${expectedEnabled}`)
  const command = object(group.command, `groups.${expectedId}.command`)
  exactKeys(command, ['executable', 'args', 'cwd', 'env'], `groups.${expectedId}.command`)
  nonEmptyString(command.executable, `groups.${expectedId}.command.executable`)
  if (!Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string')) throw new TypeError(`groups.${expectedId}.command.args must be a string array`)
  if (command.cwd !== undefined) nonEmptyString(command.cwd, `groups.${expectedId}.command.cwd`)
  if (command.env !== undefined) {
    const env = object(command.env, `groups.${expectedId}.command.env`)
    for (const [key, item] of Object.entries(env)) if (typeof item !== 'string') throw new TypeError(`groups.${expectedId}.command.env.${key} must be a string`)
  }
  return /** @type {{ id: string, longTaskPlugin: { enabled: boolean }, command: { executable: string, args: string[], cwd?: string, env?: Record<string, string> } }} */ (group)
}

/** @param {unknown} value */
export function validatePilotConfig(value) {
  const config = object(value, 'pilot config')
  exactKeys(config, ['version', 'id', 'shared', 'groups'], 'pilot config')
  if (config.version !== 1) throw new TypeError('pilot config.version must be 1')
  nonEmptyString(config.id, 'pilot config.id')
  const shared = object(config.shared, 'shared')
  validateShared(shared)
  if (!Array.isArray(config.groups) || config.groups.length !== 2) throw new TypeError('pilot config.groups must contain exactly two groups')
  const arisOnly = validateGroup(config.groups[0], 'aris_only', false)
  const arisPlusLongTask = validateGroup(config.groups[1], 'aris_plus_long_task', true)
  return { version: 1, id: /** @type {string} */ (config.id), shared, groups: [arisOnly, arisPlusLongTask] }
}

/** @param {ReturnType<typeof validatePilotConfig>} config */
export function assertComparable(config) {
  validateShared(config.shared)
  if (config.groups[0].id !== 'aris_only' || config.groups[0].longTaskPlugin.enabled !== false || config.groups[1].id !== 'aris_plus_long_task' || config.groups[1].longTaskPlugin.enabled !== true) {
    throw new TypeError('the pilot must compare aris_only (plugin disabled) with aris_plus_long_task (plugin enabled)')
  }
}
