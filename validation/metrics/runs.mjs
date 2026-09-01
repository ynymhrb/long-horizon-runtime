/**
 * Run record loader for validation metrics (handbook "Failure handling and
 * metrics").
 *
 * Scans an evidence root (`<root>/<scenario-id>/<run-id>/`) and folds every
 * bundle's `run.json`, `commands.ndjson` and `assertions.json` into one flat,
 * JSON-safe RunRecord. Scenario metadata (risk, kind, tags) is joined from the
 * versioned scenario files when a scenario root is supplied; runs whose
 * scenario file is unavailable keep deterministic `unknown` placeholders so
 * aggregation never crashes on a partial evidence tree.
 *
 * Read-only by construction: this module never writes and never reads outside
 * the supplied evidence and scenario roots.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { loadScenarioFile } from '../runner/contract.mjs'

/** Risk bucket used when no scenario file can supply the run's risk. */
export const UNKNOWN_RISK = 'unknown'

/**
 * @typedef {Object} RunRecord
 * @property {string} scenarioId
 * @property {string} runId
 * @property {string} verdict pass | fail | inconclusive | hard_stop | running
 * @property {string} risk scenario risk, or UNKNOWN_RISK when unavailable
 * @property {string} kind scenario kind, or 'unknown' when unavailable
 * @property {string[]} tags scenario tags ([] when unavailable)
 * @property {string | null} startedAt ISO timestamp from run.json
 * @property {string | null} finishedAt ISO timestamp from run.json
 * @property {number | null} durationMs finished_at - started_at when both exist
 * @property {boolean} timedOut any recorded command hit its timeout
 * @property {string[]} missingEvidence required evidence items absent from the bundle
 * @property {boolean} evidenceComplete missingEvidence is empty
 * @property {string[]} hardStops external-effect hard stops recorded by the run
 * @property {string[]} errors run errors recorded by the runner
 * @property {boolean} assertionFailed any assertion outcome failed
 * @property {string} evidenceDir absolute bundle directory
 */

/**
 * Load every run record under an evidence root. Missing or malformed bundles
 * are skipped deterministically (a run.json that does not parse is not a
 * metrics input). An absent evidence root yields an empty list, never a throw.
 * @param {string} evidenceRoot absolute evidence root directory
 * @param {{ scenarioRoot?: string }} [options]
 * @returns {Promise<RunRecord[]>}
 */
export async function loadRunRecords(evidenceRoot, options = {}) {
  const scenarioMeta = options.scenarioRoot !== undefined ? await loadScenarioMetadata(options.scenarioRoot) : new Map()
  /** @type {RunRecord[]} */
  const records = []
  let scenarioDirs
  try {
    scenarioDirs = await readdir(evidenceRoot, { withFileTypes: true })
  } catch {
    return records
  }
  for (const scenarioEntry of scenarioDirs) {
    if (!scenarioEntry.isDirectory()) continue
    const scenarioDir = path.join(evidenceRoot, scenarioEntry.name)
    const runDirs = await readdir(scenarioDir, { withFileTypes: true })
    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory()) continue
      const bundleDir = path.join(scenarioDir, runEntry.name)
      const record = await readRunRecord(bundleDir, scenarioMeta.get(scenarioEntry.name))
      if (record !== null) records.push(record)
    }
  }
  // Deterministic order: sort by scenario id, then run id.
  records.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.runId.localeCompare(b.runId))
  return records
}

/**
 * Read one bundle directory into a RunRecord; null when run.json is absent or
 * unparseable (a crashed runner that never finalized still leaves run.json
 * with verdict "running", which IS a valid metrics input).
 * @param {string} bundleDir
 * @param {{ risk?: string, kind?: string, tags?: string[] } | undefined} meta
 * @returns {Promise<RunRecord | null>}
 */
async function readRunRecord(bundleDir, meta) {
  /** @type {Record<string, unknown>} */
  let run
  try {
    run = JSON.parse(await readFile(path.join(bundleDir, 'run.json'), 'utf8'))
  } catch {
    return null
  }
  const commands = await readNdjson(path.join(bundleDir, 'commands.ndjson'))
  const assertions = await readJsonSafe(path.join(bundleDir, 'assertions.json'))

  const startedAt = typeof run.started_at === 'string' ? run.started_at : null
  const finishedAt = typeof run.finished_at === 'string' ? run.finished_at : null
  const startMs = startedAt !== null ? Date.parse(startedAt) : Number.NaN
  const finishMs = finishedAt !== null ? Date.parse(finishedAt) : Number.NaN
  const durationMs = Number.isFinite(startMs) && Number.isFinite(finishMs) && finishMs >= startMs ? finishMs - startMs : null

  const missingEvidence = Array.isArray(/** @type {Record<string, unknown>} */ (run.evidence)?.missing)
    ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (run.evidence).missing).map(String)
    : []
  const outcomes = assertions !== null && Array.isArray(/** @type {Record<string, unknown>} */ (assertions).outcomes)
    ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (assertions).outcomes)
    : []

  return {
    scenarioId: String(run.scenario_id ?? path.basename(path.dirname(bundleDir))),
    runId: String(run.run_id ?? path.basename(bundleDir)),
    verdict: String(run.verdict ?? 'unknown'),
    risk: meta?.risk ?? UNKNOWN_RISK,
    kind: meta?.kind ?? 'unknown',
    tags: meta?.tags ?? [],
    startedAt,
    finishedAt,
    durationMs,
    timedOut: commands.some(command => command.timed_out === true),
    missingEvidence,
    evidenceComplete: missingEvidence.length === 0,
    hardStops: Array.isArray(run.hard_stops) ? run.hard_stops.map(String) : [],
    errors: Array.isArray(run.errors) ? run.errors.map(String) : [],
    assertionFailed: outcomes.some(outcome => /** @type {Record<string, unknown>} */ (outcome).status === 'fail'),
    evidenceDir: bundleDir,
  }
}

/**
 * Build a scenario-id -> { risk, kind, tags } map from every scenario file
 * under a root. Unparseable or contract-violating scenarios are skipped: a
 * broken scenario file must not break metrics for the runs that did execute.
 * @param {string} scenarioRoot
 * @returns {Promise<Map<string, { risk: string, kind: string, tags: string[] }>>}
 */
export async function loadScenarioMetadata(scenarioRoot) {
  /** @type {Map<string, { risk: string, kind: string, tags: string[] }>} */
  const meta = new Map()
  /** @param {string} dir */
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (['.yaml', '.yml', '.json'].includes(path.extname(entry.name).toLowerCase())) {
        try {
          const scenario = await loadScenarioFile(full)
          meta.set(scenario.id, { risk: scenario.risk, kind: scenario.kind, tags: [...scenario.tags] })
        } catch {
          // Skip files that are not contract-valid scenarios.
        }
      }
    }
  }
  await walk(scenarioRoot)
  return meta
}

/** @param {string} file @returns {Promise<Record<string, unknown>[]>} */
async function readNdjson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // Skip malformed lines deterministically.
    }
  }
  return rows
}

/** @param {string} file @returns {Promise<Record<string, unknown> | null>} */
async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} file @returns {Promise<boolean>} */
export async function isDirectory(file) {
  try {
    return (await stat(file)).isDirectory()
  } catch {
    return false
  }
}
