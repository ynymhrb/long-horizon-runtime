/**
 * Scenario contract loading and validation (handbook "Scenario contract").
 *
 * The runner must reject a scenario with any missing required field and reject
 * any scenario whose planned work is not unambiguously `read_only`. Validation
 * collects every problem instead of failing on the first, so scenario authors
 * get a complete rejection report.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseYaml, YamlParseError } from './yaml.mjs'

export const SCENARIO_RISKS = ['critical', 'high', 'medium', 'low']
export const SCENARIO_KINDS = ['deterministic', 'fault_injection', 'exploratory_ui']
export const LLM_REVIEW_MODES = ['never', 'on_failure', 'always']
export const EVIDENCE_ITEMS = ['run', 'command_log', 'task', 'events', 'runtime_snapshot', 'artifacts', 'assertions', 'environment', 'screenshots']

/** Fields every scenario must define (handbook Scenario contract). */
export const REQUIRED_SCENARIO_FIELDS = [
  'id',
  'title',
  'risk',
  'kind',
  'tags',
  'preconditions',
  'setup',
  'actions',
  'hard_assertions',
  'evidence_required',
  'llm_review',
  'expected_user_outcome',
  'cleanup',
]

export class ScenarioContractError extends Error {
  /** @param {string[]} problems @param {string} [source] */
  constructor(problems, source) {
    super(`scenario contract violation${source === undefined ? '' : ` in ${source}`}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.name = 'ScenarioContractError'
    this.problems = problems
    this.source = source
  }
}

export class ExternalEffectError extends Error {
  /** @param {string} detail */
  constructor(detail) {
    super(`external effect planned or attempted: ${detail}`)
    this.name = 'ExternalEffectError'
    this.detail = detail
  }
}

/**
 * Load and validate a scenario file (`.yaml`/`.yml`/`.json`).
 * Rejects missing fields and non-read_only scenarios.
 * @param {string} filePath absolute path to the scenario file
 * @returns {Promise<import('./contract.js').Scenario>}
 */
export async function loadScenarioFile(filePath) {
  const text = await readFile(filePath, 'utf8')
  const extension = path.extname(filePath).toLowerCase()
  let raw
  try {
    raw = extension === '.json' ? JSON.parse(text) : parseYaml(text)
  } catch (error) {
    if (error instanceof YamlParseError || error instanceof SyntaxError) {
      throw new ScenarioContractError([`file is not parseable: ${error.message}`], filePath)
    }
    throw error
  }
  return validateScenario(raw, filePath)
}

/**
 * Validate a parsed scenario document against the handbook Scenario contract.
 * @param {unknown} raw
 * @param {string} [source] description used in error messages
 * @returns {import('./contract.js').Scenario}
 */
export function validateScenario(raw, source) {
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScenarioContractError(['document must be a mapping at the top level'], source)
  }
  const doc = /** @type {Record<string, unknown>} */ (raw)

  for (const field of REQUIRED_SCENARIO_FIELDS) {
    if (!(field in doc) || doc[field] === undefined || doc[field] === null) problems.push(`missing required field: ${field}`)
  }
  if (problems.length > 0) throw new ScenarioContractError(problems, source)

  if (typeof doc.id !== 'string' || !/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/.test(doc.id)) {
    problems.push(`id must be a stable upper-case identifier such as LT-STATE-001, got ${JSON.stringify(doc.id)}`)
  }
  if (typeof doc.title !== 'string' || doc.title.trim() === '') problems.push('title must be a non-empty string')
  if (doc.version !== undefined && !(typeof doc.version === 'number' && Number.isInteger(doc.version) && doc.version >= 1)) {
    problems.push(`version must be a positive integer when present, got ${JSON.stringify(doc.version)}`)
  }
  if (!SCENARIO_RISKS.includes(/** @type {string} */ (doc.risk))) {
    problems.push(`risk must be one of ${SCENARIO_RISKS.join(' | ')}, got ${JSON.stringify(doc.risk)}`)
  }
  if (!SCENARIO_KINDS.includes(/** @type {string} */ (doc.kind))) {
    problems.push(`kind must be one of ${SCENARIO_KINDS.join(' | ')}, got ${JSON.stringify(doc.kind)}`)
  }
  if (!Array.isArray(doc.tags) || doc.tags.some(tag => typeof tag !== 'string')) problems.push('tags must be a list of strings')
  if (!Array.isArray(doc.preconditions)) problems.push('preconditions must be a list')
  if (!Array.isArray(doc.setup)) problems.push('setup must be a list')
  if (!Array.isArray(doc.actions)) problems.push('actions must be a list')
  if (Array.isArray(doc.actions) && doc.actions.length === 0) problems.push('actions must not be empty: a scenario must do something observable')
  if (!Array.isArray(doc.hard_assertions)) problems.push('hard_assertions must be a list')
  if (!Array.isArray(doc.evidence_required) || doc.evidence_required.some(item => typeof item !== 'string')) {
    problems.push('evidence_required must be a list of evidence item names')
  } else {
    for (const item of doc.evidence_required) {
      if (!EVIDENCE_ITEMS.includes(/** @type {string} */ (item))) {
        problems.push(`evidence_required item ${JSON.stringify(item)} is not a known evidence item (${EVIDENCE_ITEMS.join(' | ')})`)
      }
    }
  }
  if (!LLM_REVIEW_MODES.includes(/** @type {string} */ (doc.llm_review))) {
    problems.push(`llm_review must be one of ${LLM_REVIEW_MODES.join(' | ')}, got ${JSON.stringify(doc.llm_review)}`)
  }
  if (typeof doc.expected_user_outcome !== 'string' || doc.expected_user_outcome.trim() === '') {
    problems.push('expected_user_outcome must be a non-empty string')
  }
  if (typeof doc.cleanup !== 'string' || doc.cleanup.trim() === '') problems.push('cleanup must name a cleanup policy such as delete_disposable_workspace')

  if (Array.isArray(doc.actions)) {
    doc.actions.forEach((action, index) => validateAction(action, index, problems))
  }
  if (Array.isArray(doc.hard_assertions)) {
    doc.hard_assertions.forEach((assertion, index) => validateAssertion(assertion, index, problems))
  }
  if (doc.kind === 'exploratory_ui' && Array.isArray(doc.evidence_required) && !doc.evidence_required.includes('screenshots')) {
    problems.push('exploratory_ui scenarios must require the screenshots evidence item')
  }
  if (problems.length > 0) throw new ScenarioContractError(problems, source)

  const scenario = /** @type {import('./contract.js').Scenario} */ (doc)
  assertReadOnlyScenario(scenario, source)
  return scenario
}

/** @param {unknown} action @param {number} index @param {string[]} problems */
function validateAction(action, index, problems) {
  const label = `actions[${index}]`
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    problems.push(`${label} must be a mapping`)
    return
  }
  const record = /** @type {Record<string, unknown>} */ (action)
  if (typeof record.name !== 'string' || record.name.trim() === '') problems.push(`${label}.name must be a non-empty string`)
  if (record.do === undefined && record.run === undefined && record.uses === undefined) {
    problems.push(`${label} must declare what it does (a "do" description, a "run" command, or a "uses" executable binding)`)
  }
  if (record.run !== undefined) {
    if (typeof record.run !== 'object' || record.run === null || Array.isArray(record.run)) {
      problems.push(`${label}.run must be a mapping with a command`)
    } else {
      const run = /** @type {Record<string, unknown>} */ (record.run)
      if (typeof run.command !== 'string' || run.command.trim() === '') problems.push(`${label}.run.command must be a non-empty string`)
      if (run.timeout_ms !== undefined && !(typeof run.timeout_ms === 'number' && run.timeout_ms > 0)) {
        problems.push(`${label}.run.timeout_ms must be a positive number`)
      }
      if (run.shell !== undefined && typeof run.shell !== 'string') problems.push(`${label}.run.shell must be a string`)
    }
  }
  const sideEffect = record.side_effect_class ?? record.sideEffectClass
  if (sideEffect !== undefined && !['read_only', 'idempotent'].includes(/** @type {string} */ (sideEffect))) {
    problems.push(`${label} declares side_effect_class ${JSON.stringify(sideEffect)}; only read_only/idempotent scenario actions are permitted`)
  }
}

/** @param {unknown} assertion @param {number} index @param {string[]} problems */
function validateAssertion(assertion, index, problems) {
  const label = `hard_assertions[${index}]`
  if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion)) {
    problems.push(`${label} must be a mapping`)
    return
  }
  const record = /** @type {Record<string, unknown>} */ (assertion)
  if (typeof record.id !== 'string' || record.id.trim() === '') problems.push(`${label}.id must be a non-empty string`)
  if (typeof record.check !== 'string' || record.check.trim() === '') problems.push(`${label}.check must describe the oracle in words`)
  if (record.evaluate !== undefined && (typeof record.evaluate !== 'object' || record.evaluate === null || Array.isArray(record.evaluate))) {
    problems.push(`${label}.evaluate must be a mapping naming an executable oracle`)
  }
  if (record.evaluate !== undefined && typeof record.evaluate === 'object' && record.evaluate !== null && !Array.isArray(record.evaluate)) {
    const evaluate = /** @type {Record<string, unknown>} */ (record.evaluate)
    if (typeof evaluate.oracle !== 'string' || evaluate.oracle.trim() === '') problems.push(`${label}.evaluate.oracle must be a non-empty string`)
  }
}

/**
 * Enforce the handbook's read-only boundary. A scenario is accepted only when
 * its planned work is unambiguously read_only:
 *   - an explicit `side_effect_class` must equal `read_only`, or
 *   - `fault_injection.planned_side_effect_class` must equal `read_only`, or
 *   - the tags must include `read_only`.
 * Anything else is rejected at load time — an external effect is a hard stop,
 * never a scenario failure to work around.
 * @param {import('./contract.js').Scenario} scenario
 * @param {string} [source]
 */
export function assertReadOnlyScenario(scenario, source) {
  const declared = scenario.side_effect_class ?? scenario.sideEffectClass
  if (declared !== undefined) {
    if (declared !== 'read_only') {
      throw new ScenarioContractError([`scenario declares side_effect_class ${JSON.stringify(declared)}; only read_only scenarios may run`], source)
    }
    return
  }
  const fault = scenario.fault_injection
  if (fault !== undefined && fault !== null && typeof fault === 'object' && !Array.isArray(fault)) {
    const planned = /** @type {Record<string, unknown>} */ (fault).planned_side_effect_class
    if (planned !== undefined) {
      if (planned !== 'read_only') {
        throw new ScenarioContractError([`scenario plans side_effect_class ${JSON.stringify(planned)}; only read_only scenarios may run`], source)
      }
      return
    }
  }
  if (!scenario.tags.includes('read_only')) {
    throw new ScenarioContractError(['scenario does not declare read_only work (no side_effect_class: read_only, no fault_injection.planned_side_effect_class: read_only, no read_only tag)'], source)
  }
}

/**
 * Locate a scenario file by id under a scenario root (recursive search for
 * `<id>.yaml`, `<id>.yml` or `<id>.json`).
 * @param {string} scenarioRoot
 * @param {string} scenarioId
 * @returns {Promise<string>} absolute path
 */
export async function findScenarioFile(scenarioRoot, scenarioId) {
  const { readdir } = await import('node:fs/promises')
  /** @param {string} dir @returns {Promise<string[]>} */
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) files.push(...(await walk(full)))
      else files.push(full)
    }
    return files
  }
  const candidates = (await walk(scenarioRoot)).filter(file => {
    const base = path.basename(file).toLowerCase()
    return ['.yaml', '.yml', '.json'].includes(path.extname(base)) && path.basename(file, path.extname(file)) === scenarioId
  })
  if (candidates.length === 0) throw new ScenarioContractError([`no scenario file named ${scenarioId}.yaml/.yml/.json under ${scenarioRoot}`], scenarioId)
  if (candidates.length > 1) throw new ScenarioContractError([`scenario id ${scenarioId} is ambiguous: ${candidates.join(', ')}`], scenarioId)
  return candidates[0]
}
