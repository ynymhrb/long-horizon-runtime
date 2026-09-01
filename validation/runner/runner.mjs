/**
 * Deterministic scenario runner (handbook "Operating model" / "Roles and
 * permissions" / "Evidence bundle").
 *
 * One run:
 *   1. loads and validates the scenario (missing fields and non-read_only
 *      scenarios are rejected before anything executes),
 *   2. provisions a unique disposable workspace and a fresh durable database,
 *   3. executes setup and each action literally, in order, recording shell exit
 *      codes, tool output, task ids, event cursors, event export and runtime
 *      snapshots,
 *   4. hard-stops immediately if an external effect is planned or attempted,
 *   5. writes the complete evidence bundle BEFORE cleanup,
 *   6. evaluates only the listed hard assertions through their executable
 *      oracle bindings,
 *   7. derives the verdict: pass | fail | inconclusive | hard_stop — missing
 *      required evidence forces inconclusive, never pass,
 *   8. applies the scenario cleanup policy.
 *
 * The runner never edits tracked source, configuration, agent presets, or
 * external systems. It may create and delete the unique temporary workspace,
 * run the scenario's local commands, start a local DSH Web host on a
 * non-reserved port, and read the run's own database and artifacts.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateAssertion, summarizeAssertions } from './assertions.mjs'
import { assertReadOnlyScenario, loadScenarioFile, ScenarioContractError } from './contract.mjs'
import { baseEvidenceItems, EvidenceWriter, sanitizeEnvironment } from './evidence.mjs'
import { findFreePort } from './ports.mjs'

/** Default per-command timeout; scenarios may raise it per command. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/** Verdicts a run can end with. hard_stop is a fail-class terminal signal for a detected external effect. */
export const VERDICTS = ['pass', 'fail', 'inconclusive', 'hard_stop']

/**
 * @typedef {Object} RunOptions
 * @property {string} scenarioFile absolute path to the scenario file
 * @property {string} [workspace] supplied disposable workspace; created when absent
 * @property {string} [evidenceRoot] root under which the immutable evidence directory is created
 * @property {boolean} [keepWorkspace] skip workspace deletion (debugging; evidence still written first)
 * @property {string} [runId] stable run id (defaults to a uuid)
 * @property {string} [repoRoot] repository root for command cwd defaults
 * @property {Record<string, string>} [commandVersions] tool versions recorded in run.json
 * @property {number} [now] epoch ms override for tests
 */

/**
 * @typedef {Object} RunResult
 * @property {'pass'|'fail'|'inconclusive'|'hard_stop'} verdict
 * @property {string} evidenceDir
 * @property {string} workspace
 * @property {string} scenarioId
 * @property {string} runId
 * @property {string[]} missingEvidence
 * @property {import('./assertions.mjs').AssertionOutcome[]} assertions
 * @property {string[]} hardStops
 * @property {string[]} errors
 */

/**
 * Execute exactly one scenario end to end.
 * @param {RunOptions} options
 * @returns {Promise<RunResult>}
 */
export async function runScenario(options) {
  const runId = options.runId ?? randomUUID()
  const scenario = await loadScenarioFile(options.scenarioFile)
  // Defense in depth: loadScenarioFile already enforces this; keep the runner
  // safe against any future loader that skips validation.
  assertReadOnlyScenario(scenario, options.scenarioFile)

  const repoRoot = options.repoRoot ?? process.cwd()
  const workspace = options.workspace ?? (await mkdtemp(path.join(tmpdir(), `lt-validation-${scenario.id}-`)))
  await mkdir(workspace, { recursive: true })
  const databasePath = path.join(workspace, 'durable.sqlite')
  const stagingDir = path.join(workspace, '.evidence-staging')
  await mkdir(stagingDir, { recursive: true })

  const evidenceRoot = options.evidenceRoot ?? path.join(repoRoot, 'validation', 'evidence')
  const evidenceDir = path.join(evidenceRoot, scenario.id, runId)
  const evidence = new EvidenceWriter(evidenceDir)
  await evidence.init()
  if (scenario.kind === 'exploratory_ui') await evidence.ensureScreenshotsDir()

  const startedAt = new Date(options.now ?? Date.now())
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const hardStops = []
  /** @type {import('./assertions.mjs').AssertionOutcome[]} */
  let assertionOutcomes = []
  /** @type {string[]} */
  let missingEvidence = []
  let phase = 'execute'
  let hostProcess

  // run.json exists from the first moment so a crashed run still leaves a bundle.
  await evidence.writeJson('run.json', {
    scenario_id: scenario.id,
    scenario_version: scenario.version ?? 1,
    run_id: runId,
    verdict: 'running',
    started_at: startedAt.toISOString(),
    command_versions: options.commandVersions ?? {},
  })
  await evidence.writeJson('environment.json', buildEnvironmentDoc(workspace, databasePath, evidenceDir, repoRoot))
  await evidence.flushCommands()

  try {
    const context = {
      scenario,
      workspace,
      databasePath,
      stagingDir,
      evidenceDir,
      repoRoot,
      record: record => evidence.recordCommand(record),
      importStaging: () => importStagedEvidence(evidence, stagingDir),
      startHost: async () => {
        hostProcess = await startWebHost(context, evidence)
        return hostProcess
      },
    }

    for (const step of scenario.setup) await executeStep(step, context, 'setup')
    for (const action of scenario.actions) await executeStep(action, context, 'action')

    await importStagedEvidence(evidence, stagingDir)
    // Structurally complete the bundle BEFORE assertions: an assertion on a
    // staged-but-absent export evaluates against an explicit empty shell
    // (recorded absence), never against a missing file.
    await ensureEvidenceShells(evidence)
    // Flush the command log BEFORE assertions: command-based oracles read
    // commands.ndjson from the immutable bundle, not from memory.
    await evidence.flushCommands()
    phase = 'assert'
    assertionOutcomes = []
    for (const assertion of scenario.hard_assertions) {
      const outcome = await evaluateAssertion(assertion, evidenceDir)
      assertionOutcomes.push(outcome)
      if (outcome.oracle === 'no_external_effect' && outcome.status === 'fail') {
        hardStops.push(`assertion ${outcome.id} observed an external effect in evidence: ${JSON.stringify(outcome.actual)}`)
      }
    }
  } catch (error) {
    if (error instanceof ExternalEffectSignal) {
      hardStops.push(error.message)
    } else {
      errors.push(`${phase}: ${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    if (hostProcess !== undefined) await hostProcess.stop()
  }

  // ---- Evidence completion BEFORE cleanup ----
  await evidence.writeJson('assertions.json', {
    scenario_id: scenario.id,
    run_id: runId,
    outcomes: assertionOutcomes,
    summary: summarizeAssertions(assertionOutcomes),
  })
  await ensureEvidenceShells(evidence)
  await evidence.flushCommands()

  const requiredEvidence = [...new Set([...baseEvidenceItems(), ...scenario.evidence_required])]
  missingEvidence = await evidence.missingRequired(requiredEvidence)

  const verdict = deriveVerdict({ assertionOutcomes, errors, hardStops, missingEvidence })

  // Final run.json is written last; the inventory hashes every other file
  // (run.json cannot contain its own hash).
  const inventory = await evidence.inventory()
  delete inventory['run.json']
  await evidence.writeJson('run.json', {
    scenario_id: scenario.id,
    scenario_version: scenario.version ?? 1,
    run_id: runId,
    verdict,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    command_versions: options.commandVersions ?? {},
    evidence: { required: requiredEvidence, missing: missingEvidence },
    hard_stops: hardStops,
    errors,
    inventory,
  })

  // ---- Cleanup only after evidence is complete ----
  if (scenario.cleanup === 'delete_disposable_workspace' && options.keepWorkspace !== true) {
    // Windows may briefly hold the directory after killed child processes exit.
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  return { verdict, evidenceDir, workspace, scenarioId: scenario.id, runId, missingEvidence, assertions: assertionOutcomes, hardStops, errors }
}

/** Signal thrown when an external effect is detected mid-run. */
class ExternalEffectSignal extends Error {
  constructor(detail) {
    super(detail)
    this.name = 'ExternalEffectSignal'
  }
}

/**
 * @param {{ assertionOutcomes: import('./assertions.mjs').AssertionOutcome[], errors: string[], hardStops: string[], missingEvidence: string[] }} input
 * @returns {'pass'|'fail'|'inconclusive'|'hard_stop'}
 */
export function deriveVerdict({ assertionOutcomes, errors, hardStops, missingEvidence }) {
  if (hardStops.length > 0) return 'hard_stop'
  if (errors.length > 0) return 'fail'
  if (assertionOutcomes.some(outcome => outcome.status === 'fail')) return 'fail'
  // Missing required evidence or an assertion that could not be executed turns
  // a passing execution into inconclusive, never pass.
  if (missingEvidence.length > 0) return 'inconclusive'
  if (assertionOutcomes.some(outcome => outcome.status === 'unevaluated')) return 'inconclusive'
  return 'pass'
}

/**
 * Execute one setup/action step literally.
 * @param {unknown} step
 * @param {Record<string, unknown>} context
 * @param {'setup'|'action'} phase
 */
async function executeStep(step, context, phase) {
  const record = /** @type {Record<string, unknown>} */ (typeof step === 'string' ? { do: step } : step)
  const name = typeof record.name === 'string' ? record.name : `${phase}-${String(context.scenario.actions?.indexOf(step) ?? 0)}`

  // Runtime-declared external effect on a step is an immediate hard stop.
  const declared = record.side_effect_class ?? record.sideEffectClass
  if (declared === 'external_effect') throw new ExternalEffectSignal(`step ${name} declares side_effect_class external_effect`)

  if (record.run !== undefined && record.run !== null) {
    const run = /** @type {Record<string, unknown>} */ (record.run)
    await executeCommand(name, run, context)
  } else if (record.uses !== undefined && record.uses !== null) {
    await executeBuiltin(name, /** @type {Record<string, unknown>} */ (record.uses), context)
  } else {
    // Narrative-only step: recorded for the audit trail; assertions on its
    // observations will be unevaluated unless another step stages evidence.
    context.record({ kind: 'narrative', phase, name, do: record.do ?? '', observe: record.observe ?? null, exit_code: null, duration_ms: 0 })
  }
}

/**
 * Run one shell command inside the disposable workspace with scenario-scoped
 * environment variables, recording exit code, duration and output refs.
 * @param {string} name
 * @param {Record<string, unknown>} run
 * @param {Record<string, unknown>} context
 */
async function executeCommand(name, run, context) {
  const command = substitutePlaceholders(String(run.command), context)
  const timeoutMs = typeof run.timeout_ms === 'number' ? run.timeout_ms : DEFAULT_COMMAND_TIMEOUT_MS
  const cwd = typeof run.cwd === 'string' ? path.resolve(context.workspace, run.cwd) : context.workspace
  const shell = typeof run.shell === 'string' ? run.shell : undefined
  const env = {
    ...baseCommandEnv(),
    LT_RUNNER_DIR: path.dirname(fileURLToPath(import.meta.url)),
    LT_WORKSPACE: context.workspace,
    LT_DATABASE_PATH: context.databasePath,
    LT_STAGING_DIR: context.stagingDir,
    LT_EVIDENCE_DIR: context.evidenceDir,
    LT_SCENARIO_ID: context.scenario.id,
  }
  const startedAt = Date.now()
  const outcome = await runShellCommand(command, { cwd, env, timeoutMs, shell })
  const { exitCode, stdout, stderr, timedOut } = outcome
  const errorMessage = outcome.errorMessage
  const durationMs = Date.now() - startedAt

  if (containsExternalEffect(stdout) || containsExternalEffect(stderr)) {
    context.record(commandRecord({ name, command, cwd, exitCode, durationMs, stdout, stderr, timedOut, errorMessage }))
    throw new ExternalEffectSignal(`command ${name} output indicates an external effect was planned or attempted`)
  }

  // Large outputs are summarized; full bodies stay out of the evidence bundle.
  context.record(commandRecord({ name, command, cwd, exitCode, durationMs, stdout, stderr, timedOut, errorMessage }))

  if (timedOut) throw new Error(`command ${name} exceeded its ${timeoutMs}ms timeout (unbounded timeout is a hard failure)`)
  if (run.expect_exit_code !== undefined && exitCode !== run.expect_exit_code) {
    throw new Error(`command ${name} exited ${String(exitCode)}, expected ${String(run.expect_exit_code)}`)
  }
  if (run.must_succeed === true && exitCode !== 0) throw new Error(`command ${name} exited ${String(exitCode)} but must_succeed is true`)
}

/**
 * Spawn one shell command with a hard timeout. On timeout the whole process
 * TREE is killed (cmd.exe alone would orphan the real child, which keeps its
 * cwd — the disposable workspace — locked on Windows).
 *
 * stdout/stderr are redirected to files inside the disposable workspace and
 * read back after the child exits — never piped. Named-pipe creation is
 * blocked in confined/sandboxed environments (spawn EPERM), and a large child
 * write to an undrained pipe would deadlock the run once the buffer fills.
 * File handles work everywhere, never deadlock, and the files live in the
 * disposable workspace and are removed with it. Output is truncated in memory
 * long before the evidence writer's own limit.
 * @param {string} command
 * @param {{ cwd: string, env: Record<string, string>, timeoutMs: number, shell?: string }} options
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean, errorMessage?: string }>}
 */
function runShellCommand(command, options) {
  return new Promise(resolve => {
    const OUTPUT_LIMIT = 1024 * 1024
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const outFile = path.join(options.cwd, `.lt-spawn-${unique}.out`)
    const errFile = path.join(options.cwd, `.lt-spawn-${unique}.err`)
    let outFd
    let errFd
    let child
    let timer
    let timedOut = false
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    const closeFiles = () => {
      for (const fd of [outFd, errFd]) {
        if (fd !== undefined) {
          try { closeSync(fd) } catch { /* already closed */ }
        }
      }
      outFd = undefined
      errFd = undefined
      try { rmSync(outFile, { force: true }) } catch { /* best effort */ }
      try { rmSync(errFile, { force: true }) } catch { /* best effort */ }
    }
    const readBack = () => {
      // Bounded read: never hold more than OUTPUT_LIMIT bytes per stream in
      // memory, matching the old pipe-truncation behavior.
      const read = file => {
        try {
          const size = statSync(file).size
          if (size === 0) return ''
          const fd = openSync(file, 'r')
          try {
            const buf = Buffer.alloc(Math.min(size, OUTPUT_LIMIT + 1))
            readSync(fd, buf, 0, buf.length, 0)
            return buf.toString('utf8')
          } finally {
            closeSync(fd)
          }
        } catch {
          return ''
        }
      }
      return { stdout: read(outFile), stderr: read(errFile) }
    }
    try {
      outFd = openSync(outFile, 'w')
      errFd = openSync(errFile, 'w')
      child = spawn(command, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell ?? true,
        windowsHide: true,
        // Process group leader on POSIX so the group can be signalled at once.
        detached: process.platform !== 'win32',
        stdio: ['ignore', outFd, errFd],
      })
    } catch (error) {
      closeFiles()
      finish({ exitCode: null, stdout: '', stderr: '', timedOut: false, errorMessage: error.message })
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, options.timeoutMs)
    child.on('error', error => {
      const { stdout, stderr } = readBack()
      closeFiles()
      finish({ exitCode: null, stdout, stderr, timedOut, errorMessage: error.message })
    })
    child.on('close', code => {
      const { stdout, stderr } = readBack()
      closeFiles()
      finish({ exitCode: typeof code === 'number' ? code : null, stdout, stderr, timedOut })
    })
  })
}

/**
 * Kill a spawned command's whole process tree.
 * @param {import('node:child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T covers the cmd.exe wrapper and every descendant.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => {})
    killer.unref()
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/**
 * Built-in executable bindings (`uses:`) implemented by the runner itself.
 * @param {string} name
 * @param {Record<string, unknown>} uses
 * @param {Record<string, unknown>} context
 */
async function executeBuiltin(name, uses, context) {
  const binding = String(uses.binding ?? '')
  const startedAt = Date.now()
  if (binding === 'import_staging') {
    await context.importStaging()
    context.record({ kind: 'builtin', name, binding, exit_code: 0, duration_ms: Date.now() - startedAt })
    return
  }
  if (binding === 'ui_web_host') {
    const host = await context.startHost()
    context.record({ kind: 'builtin', name, binding, exit_code: 0, duration_ms: Date.now() - startedAt, host_url: host.url, port: host.port })
    return
  }
  context.record({ kind: 'builtin', name, binding, exit_code: null, duration_ms: Date.now() - startedAt, error: `unknown builtin binding ${JSON.stringify(binding)}` })
  throw new Error(`unknown builtin binding ${JSON.stringify(binding)} for step ${name}`)
}

/**
 * Copy staged task/events/snapshot/artifacts exports into the immutable bundle.
 * Staging is produced by scenario commands (e.g. the runtime harness); missing
 * staged files are tolerated here — the required-evidence check decides the
 * verdict.
 * @param {EvidenceWriter} evidence
 * @param {string} stagingDir
 */
async function importStagedEvidence(evidence, stagingDir) {
  for (const fileName of ['task.json', 'events.json', 'snapshot.json', 'artifacts.json']) {
    try {
      await evidence.importStagedJson(path.join(stagingDir, fileName), fileName)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

/**
 * Create empty-but-valid shells for any base evidence file no action produced,
 * so the bundle is structurally complete and the missing-evidence verdict
 * reflects the scenario's own evidence_required list.
 * @param {EvidenceWriter} evidence
 */
async function ensureEvidenceShells(evidence) {
  const shells = {
    'task.json': { goals: [], note: 'no task export was staged by scenario actions' },
    'events.json': { events: [], note: 'no event export was staged by scenario actions' },
    'snapshot.json': { goal: null, plan: null, attempts: [], artifacts: [], decisions: [], note: 'no runtime snapshot was staged by scenario actions' },
    'artifacts.json': { artifacts: [], note: 'no artifact manifest was staged by scenario actions' },
  }
  for (const [fileName, shell] of Object.entries(shells)) {
    if (evidence.files.has(fileName)) continue
    try {
      await readFile(path.join(evidence.dir, fileName))
    } catch {
      await evidence.writeJson(fileName, shell)
    }
  }
}

/**
 * @param {string} workspace @param {string} databasePath @param {string} evidenceDir @param {string} repoRoot
 */
function buildEnvironmentDoc(workspace, databasePath, evidenceDir, repoRoot) {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd: repoRoot,
    workspace,
    database_path: databasePath,
    evidence_dir: evidenceDir,
    local_host_url: null,
    env: sanitizeEnvironment(process.env, ['LT_WORKSPACE', 'LT_DATABASE_PATH', 'LT_STAGING_DIR', 'LT_EVIDENCE_DIR', 'LT_SCENARIO_ID']),
  }
}

/**
 * Start a local DSH Web host on a non-reserved free port (UI scenarios only).
 * The host runs against the disposable workspace only.
 * @param {Record<string, unknown>} context
 * @param {EvidenceWriter} evidence
 */
async function startWebHost(context, evidence) {
  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`
  const dshRoot = process.env.LT_DSH_ROOT
  if (dshRoot === undefined || dshRoot === '') {
    throw new Error('ui_web_host requires LT_DSH_ROOT pointing at a deepseek-harness checkout; not configured in this environment')
  }
  const child = (await import('node:child_process')).spawn(process.execPath, [path.join(dshRoot, 'apps', 'cli', 'dist', 'cli.js'), 'web', '--port', String(port)], {
    cwd: context.workspace,
    env: { ...baseCommandEnv(), LT_WORKSPACE: context.workspace },
    stdio: 'ignore',
    detached: false,
  })
  return {
    port,
    url,
    async stop() {
      if (child.killed) return
      child.kill('SIGKILL')
    },
  }
}

/**
 * Substitute %LT_*% placeholders in scenario commands. Only the runner's own
 * run-scoped values are substituted — arbitrary environment access would leak.
 * @param {string} command @param {Record<string, unknown>} context
 */
function substitutePlaceholders(command, context) {
  const runnerDir = path.dirname(fileURLToPath(import.meta.url))
  const values = {
    LT_RUNNER_DIR: runnerDir,
    LT_WORKSPACE: context.workspace,
    LT_DATABASE_PATH: context.databasePath,
    LT_STAGING_DIR: context.stagingDir,
    LT_EVIDENCE_DIR: context.evidenceDir,
  }
  return command.replace(/%([A-Z_]+)%|\$\{([A-Z_]+)\}/g, (match, pct, brace) => {
    const key = pct ?? brace
    return values[key] ?? match
  })
}

/** Minimal environment for spawned commands: no secrets cross the boundary. */
function baseCommandEnv() {
  /** @type {Record<string, string>} */
  const env = {}
  for (const key of ['PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NUMBER_OF_PROCESSORS', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

/** @param {{ name: string, command: string, cwd: string, exitCode: number | null, durationMs: number, stdout: string, stderr: string, timedOut: boolean, errorMessage?: string }} input */
function commandRecord({ name, command, cwd, exitCode, durationMs, stdout, stderr, timedOut, errorMessage }) {
  return {
    kind: 'command',
    name,
    command,
    cwd,
    exit_code: exitCode,
    duration_ms: durationMs,
    timed_out: timedOut,
    stdout: summarizeOutput(stdout),
    stderr: summarizeOutput(stderr),
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  }
}

/** @param {string} text */
function summarizeOutput(text) {
  const limit = 8_192
  const trimmed = text.length > limit ? `${text.slice(0, limit)}\n... <truncated ${text.length - limit} chars>` : text
  return { length: text.length, tail: trimmed.slice(-limit) }
}

/** Scan tool output for an external-effect signal (planned or attempted). */
function containsExternalEffect(output) {
  return /sideEffectClass"?\s*[:=]\s*"external_effect"/.test(output) || /side_effect_class"?\s*[:=]\s*"?external_effect"?/.test(output)
}
