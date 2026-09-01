/**
 * Immutable evidence bundle loader for triage (handbook "Evidence bundle").
 *
 * Reads the runner's eight evidence files from one bundle directory into a
 * single JSON-safe `EvidenceBundle` value the triager consumes. All content
 * was redacted by the runner's evidence writer before it touched disk; this
 * loader never reads outside the bundle directory and never mutates it.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * @typedef {Object} EvidenceBundle
 * @property {string} dir absolute bundle directory
 * @property {Record<string, unknown>} run run.json
 * @property {Record<string, unknown>[]} commands commands.ndjson rows
 * @property {Record<string, unknown>} task task.json
 * @property {{ type?: string, seq?: number }[]} events events.json event list
 * @property {Record<string, unknown>} snapshot snapshot.json
 * @property {Record<string, unknown>} artifacts artifacts.json
 * @property {Record<string, unknown>} assertions assertions.json
 * @property {Record<string, unknown>} environment environment.json
 * @property {string[]} screenshots screenshot file names (UI scenarios)
 * @property {string[]} files bundle file inventory (relative names)
 */

/**
 * Load one evidence bundle directory into memory.
 * @param {string} dir absolute evidence bundle directory
 * @returns {Promise<EvidenceBundle>}
 */
export async function loadEvidenceBundle(dir) {
  const [run, commandsText, task, eventsDoc, snapshot, artifacts, assertions, environment] = await Promise.all([
    readJson(dir, 'run.json'),
    readFile(path.join(dir, 'commands.ndjson'), 'utf8'),
    readJson(dir, 'task.json'),
    readJson(dir, 'events.json'),
    readJson(dir, 'snapshot.json'),
    readJson(dir, 'artifacts.json'),
    readJson(dir, 'assertions.json'),
    readJson(dir, 'environment.json'),
  ])

  const commands = commandsText
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => /** @type {Record<string, unknown>} */ (JSON.parse(line)))

  const events = Array.isArray(eventsDoc) ? eventsDoc : (/** @type {Record<string, unknown>} */ (eventsDoc).events ?? [])
  const screenshots = Array.isArray(/** @type {Record<string, unknown>} */ (run).screenshots) ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (run).screenshots) : []

  return {
    dir,
    run: /** @type {Record<string, unknown>} */ (run),
    commands,
    task: /** @type {Record<string, unknown>} */ (task),
    events: /** @type {{ type?: string, seq?: number }[]} */ (events),
    snapshot: /** @type {Record<string, unknown>} */ (snapshot),
    artifacts: /** @type {Record<string, unknown>} */ (artifacts),
    assertions: /** @type {Record<string, unknown>} */ (assertions),
    environment: /** @type {Record<string, unknown>} */ (environment),
    screenshots,
    files: ['run.json', 'commands.ndjson', 'task.json', 'events.json', 'snapshot.json', 'artifacts.json', 'assertions.json', 'environment.json', ...screenshots.map(name => `screenshots/${name}`)],
  }
}

/**
 * A compact, JSON-safe digest of the bundle for an LLM triager prompt. The
 * digest carries identifiers and outcomes, never artifact bodies or command
 * output; the triager cites evidence ids from it.
 * @param {EvidenceBundle} bundle
 */
export function summarizeBundle(bundle) {
  const run = bundle.run
  const assertionOutcomes = Array.isArray(bundle.assertions.outcomes) ? bundle.assertions.outcomes : []
  return {
    scenario_id: run.scenario_id,
    run_id: run.run_id,
    verdict: run.verdict,
    started_at: run.started_at,
    finished_at: run.finished_at,
    hard_stops: run.hard_stops ?? [],
    errors: run.errors ?? [],
    missing_evidence: /** @type {Record<string, unknown>} */ (run.evidence)?.missing ?? [],
    assertion_outcomes: assertionOutcomes.map(outcome => ({
      id: /** @type {Record<string, unknown>} */ (outcome).id,
      status: /** @type {Record<string, unknown>} */ (outcome).status,
      oracle: /** @type {Record<string, unknown>} */ (outcome).oracle,
      expected: /** @type {Record<string, unknown>} */ (outcome).expected,
      actual: /** @type {Record<string, unknown>} */ (outcome).actual,
      detail: /** @type {Record<string, unknown>} */ (outcome).detail,
    })),
    commands: bundle.commands.map((command, index) => ({
      evidence_id: `commands.ndjson#${index + 1}`,
      name: command.name,
      exit_code: command.exit_code,
      timed_out: command.timed_out ?? false,
      duration_ms: command.duration_ms,
    })),
    events: bundle.events.map((event, index) => ({
      evidence_id: `events.json#${event.seq ?? index}`,
      type: event.type,
    })),
    goal_states: goalStates(bundle.task),
    files: bundle.files,
  }
}

/** @param {Record<string, unknown>} task */
function goalStates(task) {
  const goals = Array.isArray(task.goals) ? task.goals : []
  return goals.map(goal => {
    const record = /** @type {Record<string, unknown>} */ (goal)
    return { id: record.id, state: record.state, revision: record.revision }
  })
}

/** @param {string} dir @param {string} file */
async function readJson(dir, file) {
  const text = await readFile(path.join(dir, file), 'utf8')
  return JSON.parse(text)
}
