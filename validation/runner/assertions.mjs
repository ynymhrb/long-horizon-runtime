/**
 * Deterministic hard-assertion evaluation (handbook: "Each hard assertion must
 * be executable and observable").
 *
 * An assertion is evaluated only through its explicit `evaluate:` executable
 * oracle binding against evidence files. Assertions without an executable
 * binding, or whose evidence is absent, evaluate to `unevaluated` — a run can
 * never pass on an assertion it could not check. Subjective assertions are
 * impossible here by construction: every oracle below reads recorded evidence.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** Oracles the runner knows how to execute. */
export const ORACLES = [
  'goal_state_equals',
  'goal_field_equals',
  'event_present',
  'event_absent',
  'event_order',
  'event_field_equals',
  'attempt_state_equals',
  'attempt_count_equals',
  'task_state_equals',
  'command_exit_code_equals',
  'json_field_equals',
  'json_field_matches',
  'file_exists',
  'file_absent',
  'no_external_effect',
]

/**
 * @typedef {Object} AssertionOutcome
 * @property {string} id assertion id
 * @property {'pass'|'fail'|'unevaluated'} status
 * @property {string} oracle oracle kind or 'none'
 * @property {unknown} expected
 * @property {unknown} actual
 * @property {string} detail human-readable explanation
 * @property {string} check the scenario's prose description of the oracle
 */

/**
 * Evaluate one hard assertion against the evidence bundle.
 * @param {Record<string, unknown>} assertion scenario hard_assertions entry
 * @param {string} evidenceDir absolute evidence directory
 * @returns {Promise<AssertionOutcome>}
 */
export async function evaluateAssertion(assertion, evidenceDir) {
  const id = String(assertion.id ?? 'unknown')
  const check = String(assertion.check ?? '')
  const evaluate = assertion.evaluate
  if (evaluate === undefined || evaluate === null || typeof evaluate !== 'object' || Array.isArray(evaluate)) {
    return { id, status: 'unevaluated', oracle: 'none', expected: 'executable evaluate binding', actual: null, detail: 'assertion has no executable oracle binding; a hard assertion that cannot be executed can never pass', check }
  }
  const spec = /** @type {Record<string, unknown>} */ (evaluate)
  const oracle = String(spec.oracle ?? '')
  if (!ORACLES.includes(oracle)) {
    return { id, status: 'unevaluated', oracle, expected: `one of ${ORACLES.join(' | ')}`, actual: oracle, detail: `unknown oracle ${JSON.stringify(oracle)}`, check }
  }
  try {
    return await ORACLE_IMPL[oracle](id, spec, evidenceDir, check)
  } catch (error) {
    return { id, status: 'unevaluated', oracle, expected: spec, actual: null, detail: `oracle could not be evaluated: ${error instanceof Error ? error.message : String(error)}`, check }
  }
}

/** @param {string} evidenceDir @param {string} file */
async function readEvidenceJson(evidenceDir, file) {
  const text = await readFile(path.join(evidenceDir, file), 'utf8')
  return JSON.parse(text)
}

/** @param {string} evidenceDir */
async function readEvents(evidenceDir) {
  const doc = await readEvidenceJson(evidenceDir, 'events.json')
  return Array.isArray(doc) ? doc : doc.events ?? []
}

/** @param {string} evidenceDir */
async function readCommands(evidenceDir) {
  const text = await readFile(path.join(evidenceDir, 'commands.ndjson'), 'utf8')
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/**
 * Resolve a dotted path (`a.b.0.c`) inside a JSON value.
 * @param {unknown} value @param {string} dotted
 */
function atPath(value, dotted) {
  let current = value
  for (const segment of dotted.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = /** @type {Record<string, unknown>} */ (current)[segment]
  }
  return current
}

const ORACLE_IMPL = {
  /** @param {string} id @param {Record<string, unknown>} spec @param {string} dir @param {string} check */
  async goal_state_equals(id, spec, dir, check) {
    const task = await readEvidenceJson(dir, 'task.json')
    const actual = atPath(task, 'state')
    const pass = actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'goal_state_equals', expected: spec.expected, actual, detail: pass ? 'goal state matches' : `goal state ${JSON.stringify(actual)} != ${JSON.stringify(spec.expected)}`, check }
  },
  async goal_field_equals(id, spec, dir, check) {
    const task = await readEvidenceJson(dir, 'task.json')
    const actual = atPath(task, String(spec.field ?? ''))
    const pass = actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'goal_field_equals', expected: spec.expected, actual, detail: pass ? `field ${spec.field} matches` : `field ${spec.field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(spec.expected)}`, check }
  },
  async event_present(id, spec, dir, check) {
    const events = await readEvents(dir)
    const matches = events.filter(event => eventMatches(event, spec))
    const pass = matches.length > 0
    return { id, status: pass ? 'pass' : 'fail', oracle: 'event_present', expected: eventExpectation(spec), actual: events.map(event => event.type), detail: pass ? `found ${matches.length} matching event(s)` : 'no matching event in events.json', check }
  },
  async event_absent(id, spec, dir, check) {
    const events = await readEvents(dir)
    const matches = events.filter(event => eventMatches(event, spec))
    const pass = matches.length === 0
    return { id, status: pass ? 'pass' : 'fail', oracle: 'event_absent', expected: `absent: ${JSON.stringify(eventExpectation(spec))}`, actual: matches.map((event, index) => `events.json#${event.seq ?? index} ${event.type}`), detail: pass ? 'no matching event' : `${matches.length} forbidden event(s) present`, check }
  },
  async event_order(id, spec, dir, check) {
    const events = await readEvents(dir)
    const sequence = Array.isArray(spec.sequence) ? spec.sequence.map(String) : []
    const types = events.map(event => String(event.type))
    let cursor = 0
    const found = []
    for (const wanted of sequence) {
      const at = types.indexOf(wanted, cursor)
      if (at === -1) {
        return { id, status: 'fail', oracle: 'event_order', expected: sequence, actual: types, detail: `event ${JSON.stringify(wanted)} does not appear after position ${cursor}`, check }
      }
      found.push(at)
      cursor = at + 1
    }
    return { id, status: 'pass', oracle: 'event_order', expected: sequence, actual: found.map((at, index) => `events.json#${events[at]?.seq ?? at} ${sequence[index]}`), detail: 'all events appear in the required order', check }
  },
  async event_field_equals(id, spec, dir, check) {
    const events = await readEvents(dir)
    const event = events.find(candidate => candidate.type === spec.type)
    if (event === undefined) return { id, status: 'fail', oracle: 'event_field_equals', expected: `${spec.type} with ${spec.field} = ${JSON.stringify(spec.expected)}`, actual: null, detail: `no ${JSON.stringify(spec.type)} event in events.json`, check }
    const actual = atPath(event, String(spec.field ?? ''))
    const pass = actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'event_field_equals', expected: spec.expected, actual, detail: pass ? 'event field matches' : `${spec.type}.${spec.field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(spec.expected)}`, check }
  },
  async attempt_state_equals(id, spec, dir, check) {
    const snapshot = await readEvidenceJson(dir, 'snapshot.json')
    const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : []
    const wantedTask = spec.task_id === undefined ? undefined : String(spec.task_id)
    const scoped = wantedTask === undefined ? attempts : attempts.filter(attempt => attempt.taskId === wantedTask)
    const latest = scoped.at(-1)
    const actual = latest?.state
    const pass = actual === spec.expected && scoped.length > 0
    return { id, status: pass ? 'pass' : 'fail', oracle: 'attempt_state_equals', expected: spec.expected, actual, detail: pass ? 'latest attempt state matches' : `latest attempt state is ${JSON.stringify(actual)} across ${scoped.length} attempt(s)`, check }
  },
  async attempt_count_equals(id, spec, dir, check) {
    const snapshot = await readEvidenceJson(dir, 'snapshot.json')
    const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : []
    const wantedTask = spec.task_id === undefined ? undefined : String(spec.task_id)
    const scoped = wantedTask === undefined ? attempts : attempts.filter(attempt => attempt.taskId === wantedTask)
    const actual = scoped.length
    const pass = actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'attempt_count_equals', expected: spec.expected, actual, detail: pass ? 'attempt count matches' : `${actual} attempt(s), expected ${JSON.stringify(spec.expected)}`, check }
  },
  async task_state_equals(id, spec, dir, check) {
    const snapshot = await readEvidenceJson(dir, 'snapshot.json')
    const tasks = Array.isArray(snapshot.plan?.tasks) ? snapshot.plan.tasks : []
    const task = tasks.find(candidate => candidate.id === spec.task_id)
    const actual = task?.state
    const pass = actual !== undefined && actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'task_state_equals', expected: spec.expected, actual, detail: pass ? 'task state matches' : `task ${JSON.stringify(spec.task_id)} state is ${JSON.stringify(actual)}`, check }
  },
  async command_exit_code_equals(id, spec, dir, check) {
    const commands = await readCommands(dir)
    const command = commands.find(entry => entry.name === spec.command || entry.step === spec.command)
    if (command === undefined) return { id, status: 'fail', oracle: 'command_exit_code_equals', expected: spec.expected, actual: null, detail: `no recorded command named ${JSON.stringify(spec.command)}`, check }
    const actual = command.exit_code
    const pass = actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'command_exit_code_equals', expected: spec.expected, actual, detail: pass ? 'exit code matches' : `command ${spec.command} exited ${JSON.stringify(actual)}`, check }
  },
  async json_field_equals(id, spec, dir, check) {
    const doc = await readEvidenceJson(dir, String(spec.file ?? ''))
    const actual = atPath(doc, String(spec.field ?? ''))
    const pass = actual === spec.expected
    return { id, status: pass ? 'pass' : 'fail', oracle: 'json_field_equals', expected: spec.expected, actual, detail: pass ? `${spec.file}#${spec.field} matches` : `${spec.file}#${spec.field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(spec.expected)}`, check }
  },
  async json_field_matches(id, spec, dir, check) {
    const doc = await readEvidenceJson(dir, String(spec.file ?? ''))
    const actual = atPath(doc, String(spec.field ?? ''))
    const pattern = new RegExp(String(spec.pattern ?? ''))
    const pass = typeof actual === 'string' && pattern.test(actual)
    return { id, status: pass ? 'pass' : 'fail', oracle: 'json_field_matches', expected: `/${spec.pattern}/`, actual, detail: pass ? `${spec.file}#${spec.field} matches pattern` : `${spec.file}#${spec.field} does not match /${spec.pattern}/`, check }
  },
  async file_exists(id, spec, dir, check) {
    const file = path.join(dir, String(spec.file ?? ''))
    try {
      await readFile(file)
      return { id, status: 'pass', oracle: 'file_exists', expected: spec.file, actual: spec.file, detail: 'file exists in evidence bundle', check }
    } catch {
      return { id, status: 'fail', oracle: 'file_exists', expected: spec.file, actual: null, detail: `file ${JSON.stringify(spec.file)} missing from evidence bundle`, check }
    }
  },
  async file_absent(id, spec, dir, check) {
    const file = path.join(dir, String(spec.file ?? ''))
    try {
      await readFile(file)
      return { id, status: 'fail', oracle: 'file_absent', expected: `absent: ${spec.file}`, actual: spec.file, detail: `file ${JSON.stringify(spec.file)} unexpectedly exists`, check }
    } catch {
      return { id, status: 'pass', oracle: 'file_absent', expected: `absent: ${spec.file}`, actual: null, detail: 'file is absent', check }
    }
  },
  async no_external_effect(id, spec, dir, check) {
    const events = await readEvents(dir)
    const flagged = []
    for (const [index, event] of events.entries()) {
      const hits = findExternalEffect(event)
      for (const hit of hits) flagged.push({ evidence_id: `events.json#${event.seq ?? index}`, path: hit })
    }
    try {
      const snapshot = await readEvidenceJson(dir, 'snapshot.json')
      for (const hit of findExternalEffect(snapshot)) flagged.push({ evidence_id: 'snapshot.json', path: hit })
    } catch {
      // snapshot may legitimately be absent; the missing-evidence rule handles that.
    }
    const pass = flagged.length === 0
    return { id, status: pass ? 'pass' : 'fail', oracle: 'no_external_effect', expected: 'no sideEffectClass external_effect anywhere in the evidence', actual: flagged, detail: pass ? 'no external effect recorded' : `${flagged.length} external-effect occurrence(s) in evidence`, check }
  },
}

/**
 * Does an event match an event_present/event_absent spec (type + optional payload field equality)?
 * @param {Record<string, unknown>} event @param {Record<string, unknown>} spec
 */
function eventMatches(event, spec) {
  if (spec.type !== undefined && event.type !== spec.type) return false
  if (spec.field !== undefined) {
    return atPath(event, String(spec.field)) === spec.expected
  }
  return true
}

/** @param {Record<string, unknown>} spec */
function eventExpectation(spec) {
  return spec.field === undefined ? { type: spec.type } : { type: spec.type, field: spec.field, expected: spec.expected }
}

/**
 * Find paths whose value indicates a planned/attempted external effect.
 * @param {unknown} value @param {string} [prefix]
 * @returns {string[]}
 */
function findExternalEffect(value, prefix = '') {
  const hits = []
  if (value === null || typeof value !== 'object') return hits
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findExternalEffect(item, `${prefix}[${index}]`)))
    return hits
  }
  for (const [key, item] of Object.entries(value)) {
    const here = prefix === '' ? key : `${prefix}.${key}`
    if ((key === 'sideEffectClass' || key === 'side_effect_class') && item === 'external_effect') hits.push(here)
    else hits.push(...findExternalEffect(item, here))
  }
  return hits
}

/**
 * Fold assertion outcomes into the assertion section of the verdict.
 * @param {AssertionOutcome[]} outcomes
 * @returns {'pass'|'fail'|'unevaluated'}
 */
export function summarizeAssertions(outcomes) {
  if (outcomes.some(outcome => outcome.status === 'fail')) return 'fail'
  if (outcomes.some(outcome => outcome.status === 'unevaluated')) return 'unevaluated'
  return 'pass'
}
