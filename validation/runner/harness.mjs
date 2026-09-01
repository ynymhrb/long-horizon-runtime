/**
 * Runtime harness: the executable binding between scenario actions and the
 * built long-task runtime (dist/). Scenario actions invoke it as a local test
 * command inside the disposable workspace:
 *
 *   node validation/runner/harness.mjs <command> [--flag value]
 *
 * Environment (provided by the runner):
 *   LT_DATABASE_PATH  fresh durable SQLite database unique to this run
 *   LT_STAGING_DIR    where evidence exports are staged for the runner
 *   LT_WORKSPACE      the unique disposable workspace
 *
 * Every command is read_only by construction: fixture planners and executors
 * below only produce/consume read_only plans, and exports only read the run's
 * own database. Tracked source, configuration and tests are never modified.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = pathToFileURL(path.resolve(HERE, '..', '..', 'dist', 'index.js')).href

const { LongTaskRuntime, TaskControlApi } = await import(DIST)

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

function requireEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`environment variable ${name} is required (the scenario runner provides it)`)
  return value
}

/** One strict read_only task, matching the runtime's validated contract. */
function strictTask(id, objective, dependsOn = []) {
  return { id, objective, dependsOn, priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }
}

/**
 * Fixture planner kinds (local test doubles; no LLM, no network):
 *   static-success       one read_only task
 *   static-chain         two read_only tasks, b depends on a
 *   static-chain-required two read_only tasks, b depends on a and requires a
 *                      'note' artifact from it (inputContract.requiredArtifactTypes),
 *                      so a missing artifact keeps b undispatchable
 *   static-retry         one read_only task with retryPolicy maxAttempts 2
 *   invalid-json         throws a non-parseable planner error (fault injection)
 *   cyclic-dag           a<->b dependency cycle (fault injection)
 *   missing-field        a task with a required contract field undefined (fault injection)
 *   external-effect      a task with sideEffectClass external_effect (safety probe)
 *   external-on-replan   revision 1 is read_only; later revisions carry an
 *                      external_effect task (external-effect replan proposal)
 *   fail-on-replan       plans read_only revision 1; any replan call (one that
 *                      carries a trigger) throws (automatic replan planner
 *                      failure). Trigger-based so the fixture works across the
 *                      harness's per-command runtime instances.
 */
function makePlanner(kind) {
  let planCalls = 0
  return {
    async plan(input) {
      planCalls += 1
      switch (kind) {
        case 'static-success':
          return { goalId: input.goalId, revision: (input.baseRevision ?? 0) + 1, tasks: [strictTask('a', 'read the goal and report')] }
        case 'static-chain':
          return { goalId: input.goalId, revision: (input.baseRevision ?? 0) + 1, tasks: [strictTask('a', 'first read'), strictTask('b', 'second read', ['a'])] }
        case 'static-chain-required':
          return { goalId: input.goalId, revision: (input.baseRevision ?? 0) + 1, tasks: [strictTask('a', 'first read'), { ...strictTask('b', 'second read requires a note', ['a']), inputContract: { requiredArtifactTypes: ['note'] } }] }
        case 'static-retry':
          return { goalId: input.goalId, revision: (input.baseRevision ?? 0) + 1, tasks: [{ ...strictTask('a', 'read and retry'), retryPolicy: { maxAttempts: 2 } }] }
        case 'invalid-json':
          throw new Error('planner returned non-parseable output: <not-json>')
        case 'cyclic-dag':
          return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'cycle a', ['b']), strictTask('b', 'cycle b', ['a'])] }
        case 'missing-field':
          return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'incomplete'), sideEffectClass: undefined }] }
        case 'external-effect':
          return { goalId: input.goalId, revision: 1, tasks: [{ ...strictTask('a', 'external write'), sideEffectClass: 'external_effect' }] }
        case 'external-on-replan':
          if (planCalls === 1) return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'read the goal and report')] }
          return { goalId: input.goalId, revision: (input.baseRevision ?? 0) + 1, tasks: [{ ...strictTask('a', 'external write'), sideEffectClass: 'external_effect' }] }
        case 'fail-on-replan':
          // A replan call is identified by its trigger: initial planning never
          // carries one, every automatic/edited replan does. Throwing on the
          // first replan call leaves the currently applied revision intact and
          // the goal paused (LT-FAULT-010 hard oracle).
          if (input.trigger === undefined) return { goalId: input.goalId, revision: 1, tasks: [strictTask('a', 'read the goal and report')] }
          throw new Error('planner failed on replan: fixture double')
        default:
          throw new Error(`unknown planner kind ${JSON.stringify(kind)}`)
      }
    },
  }
}

/**
 * Fixture executor kinds:
 *   succeed            always succeeds with one note artifact
 *   fail-once          first attempt fails (output), later attempts succeed
 *   fail-always        always fails (output)
 *   slow               succeeds after --delay-ms
 *   no-artifacts       succeeds but returns zero artifacts (missing artifact)
 *   interrupt          returns an interrupted failure (conversation stop)
 *   cannot-start       returns an infrastructure failure: the child session
 *                      could not start at all (session-start fault)
 *   timeout            returns an infrastructure failure after a short delay:
 *                      the child exceeded its execution timeout
 *   oversized          succeeds with one note artifact larger than the runtime's
 *                      inline limit (needs --artifact-dir to be enforceable)
 *   no-artifact        succeeds with zero artifacts and the exact summary
 *                      'no_artifact', so the result-contract validator accepts
 *                      it (a producer that declares no artifact at all)
 */
function makeExecutor(kind, options = {}) {
  let calls = 0
  return {
    async execute(input) {
      calls += 1
      if (kind === 'slow') await new Promise(resolve => setTimeout(resolve, Number(options.delayMs ?? 200)))
      if (kind === 'timeout') {
        await new Promise(resolve => setTimeout(resolve, Number(options.delayMs ?? 50)))
        return { status: 'failed', summary: 'child exceeded its execution timeout', failureKind: 'infrastructure', artifacts: [], evidence: [] }
      }
      if (kind === 'cannot-start') {
        return { status: 'failed', summary: 'child session could not start', failureKind: 'infrastructure', artifacts: [], evidence: [] }
      }
      if (kind === 'oversized') {
        const size = Math.max(1024, Number(options.oversizedBytes ?? 70_000))
        return { status: 'succeeded', summary: 'oversized read-only artifact', artifacts: [{ type: 'note', content: `oversized note for ${input.taskId} `.padEnd(size, 'x') }], evidence: ['fixture'] }
      }
      if (kind === 'no-artifact') {
        return { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] }
      }
      if (kind === 'fail-always' || (kind === 'fail-once' && calls === 1)) {
        return { status: 'failed', summary: `fixture failure for ${input.taskId}`, failureKind: 'output', artifacts: [], evidence: ['fixture'] }
      }
      if (kind === 'interrupt') {
        return { status: 'failed', summary: 'conversation stopped by operator', failureKind: 'interrupted', artifacts: [], evidence: [] }
      }
      if (kind === 'no-artifacts') {
        return { status: 'succeeded', summary: `fixture success for ${input.taskId}`, artifacts: [], evidence: ['fixture'] }
      }
      return { status: 'succeeded', summary: `fixture success for ${input.taskId}`, artifacts: [{ type: 'note', content: `evidence note for ${input.taskId}` }], evidence: ['fixture'] }
    },
  }
}

/** @param {string} databasePath @param {string} plannerKind @param {string} executorKind @param {Record<string, unknown>} [options] */
function makeRuntime(databasePath, plannerKind, executorKind, options = {}) {
  return new LongTaskRuntime(makePlanner(plannerKind), makeExecutor(executorKind, options), {
    databasePath,
    artifactDirectory: options.artifactDirectory,
    artifactInlineLimitBytes: options.artifactInlineLimitBytes,
    autoReplan: options.autoReplan === true,
    retryBackoffMs: 0,
    maxRetryBackoffMs: 0,
  })
}

/**
 * Read-only artifact-store flags shared by create-goal and run-goal:
 *   --artifact-dir <dir>                enable the ArtifactStore rooted at dir
 *   --artifact-inline-limit-bytes <n>   inline limit (default 65_536)
 * Both only influence where the run's own artifacts are stored; nothing tracked
 * is ever written.
 * @param {Record<string, string | boolean>} flags
 */
function artifactOptions(flags) {
  return {
    ...(typeof flags['artifact-dir'] === 'string' ? { artifactDirectory: flags['artifact-dir'] } : {}),
    ...(flags['artifact-inline-limit-bytes'] !== undefined ? { artifactInlineLimitBytes: Number(flags['artifact-inline-limit-bytes']) } : {}),
  }
}

/**
 * Export the durable state of every goal in the run's database into the
 * staging directory: task.json, events.json, snapshot.json, artifacts.json.
 * Reads only; safe to run after every action.
 * @param {string} databasePath @param {string} stagingDir
 */
async function exportState(databasePath, stagingDir) {
  const { RuntimeEventStore } = await import(DIST)
  const store = new RuntimeEventStore(databasePath)
  try {
    await mkdir(stagingDir, { recursive: true })
    // listGoals({archived: true}) selects ONLY archived goals; the bundle must
    // contain every goal in the run's database, active and archived.
    const goals = [...store.listGoals(), ...store.listGoals({ archived: true })]
    const goalViews = goals.map(goal => ({
      id: goal.id,
      objective: goal.objective,
      state: goal.state,
      revision: goal.revision,
      controlRevision: goal.controlRevision,
      planningMode: goal.planningMode,
      pauseReason: goal.pauseReason,
      archivedAt: goal.archivedAt,
    }))
    await writeFile(path.join(stagingDir, 'task.json'), `${JSON.stringify({ goals: goalViews, count: goalViews.length }, null, 2)}\n`, 'utf8')

    const events = []
    for (const goal of goals) {
      let after = 0
      for (;;) {
        const page = store.listEvents(goal.id, after, 500)
        if (page.length === 0) break
        events.push(...page)
        after = page.at(-1).seq ?? after
        if (page.length < 500) break
      }
    }
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    await writeFile(path.join(stagingDir, 'events.json'), `${JSON.stringify({ events, count: events.length }, null, 2)}\n`, 'utf8')

    const snapshots = []
    for (const goal of goals) {
      const plan = store.getPlan(goal.id)
      snapshots.push({
        goal: { id: goal.id, state: goal.state, revision: goal.revision, controlRevision: goal.controlRevision, planningMode: goal.planningMode, pauseReason: goal.pauseReason, archivedAt: goal.archivedAt },
        plan: plan === undefined ? null : { revision: plan.revision, state: plan.state, baseRevision: plan.baseRevision, tasks: plan.tasks },
        attempts: store.listTasks(goal.id).flatMap(task => store.listAttempts(task.id, goal.id)),
        tasks: store.listTasks(goal.id),
        artifacts: store.listActiveValidatedArtifacts(goal.id).map(artifact => ({ id: artifact.id, type: artifact.type, storage: artifact.storage, contentHash: artifact.contentHash, validated: artifact.validated, active: artifact.active, path: artifact.path })),
        decisions: store.listDecisions(goal.id),
        goalVersions: store.listGoalVersions(goal.id),
        latestSeq: store.latestSeq(goal.id),
      })
    }
    const snapshot = snapshots.length === 1 ? snapshots[0] : { goals: snapshots }
    await writeFile(path.join(stagingDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

    const artifactManifest = []
    for (const goal of goals) {
      for (const artifact of store.listActiveValidatedArtifacts(goal.id)) {
        artifactManifest.push({ id: artifact.id, goalId: artifact.goalId, taskId: artifact.taskId, type: artifact.type, storage: artifact.storage, contentHash: artifact.contentHash, validated: artifact.validated, active: artifact.active, path: artifact.path })
      }
    }
    await writeFile(path.join(stagingDir, 'artifacts.json'), `${JSON.stringify({ artifacts: artifactManifest, count: artifactManifest.length }, null, 2)}\n`, 'utf8')
  } finally {
    store.close()
  }
}

const COMMANDS = {
  /**
   * create-goal: create one goal with the fixture planner; --mode
   * auto|require_confirmation (default auto). Prints the goal id.
   */
  async 'create-goal'(flags) {
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'), { autoReplan: flags['auto-replan'] === true, ...artifactOptions(flags) })
    try {
      const goal = await runtime.createGoal({ objective: String(flags.objective ?? 'validation goal'), planningMode: flags.mode === 'require_confirmation' ? 'require_confirmation' : 'auto' })
      process.stdout.write(`${JSON.stringify({ goal_id: goal.id, state: goal.state, revision: goal.revision })}\n`)
      await persistGoalId(goal.id)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** run-goal: drive the run's goal until idle with a live parent. */
  async 'run-goal'(flags) {
    const goalId = await readGoalId(flags)
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'), { autoReplan: flags['auto-replan'] === true, delayMs: flags['delay-ms'], ...artifactOptions(flags) })
    try {
      await runtime.runUntilIdle(goalId, {})
      const goal = runtime.getStatus(goalId)
      process.stdout.write(`${JSON.stringify({ goal_id: goalId, state: goal?.state, revision: goal?.revision })}\n`)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** confirm-goal: confirm an awaiting proposal. */
  async 'confirm-goal'(flags) {
    const goalId = await readGoalId(flags)
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'))
    try {
      const goal = await runtime.confirmGoal(goalId, flags.run === true ? {} : undefined)
      process.stdout.write(`${JSON.stringify({ goal_id: goalId, state: goal.state, revision: goal.revision })}\n`)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** pause-goal / resume-goal / cancel-goal: lifecycle controls. */
  async 'pause-goal'(flags) {
    await control(flags, runtime => {
      const goalId = /** @type {string} */ (runtime.goalId)
      const goal = runtime.runtime.getStatus(goalId)
      if (goal?.state !== 'RUNNING') throw new Error(`goal ${goalId} is not RUNNING (state ${goal?.state})`)
      // Pause is exposed through interruption with a wait policy in V1.
      return runtime.runtime.interruptGoal(goalId, 'user_stop', 'wait_for_live_parent')
    })
  },
  async 'resume-goal'(flags) {
    await control(flags, runtime => runtime.runtime.resumeGoal(/** @type {string} */ (runtime.goalId), flags.run === true ? {} : undefined))
  },
  async 'cancel-goal'(flags) {
    await control(flags, runtime => runtime.runtime.cancelGoal(/** @type {string} */ (runtime.goalId)))
  },
  async 'archive-goal'(flags) {
    await control(flags, runtime => runtime.runtime.archiveGoal(/** @type {string} */ (runtime.goalId)))
  },
  async 'restore-goal'(flags) {
    await control(flags, runtime => runtime.runtime.restoreGoal(/** @type {string} */ (runtime.goalId)))
  },

  /** edit-goal: revise the original goal (append-only version + fenced proposal). */
  async 'edit-goal'(flags) {
    const goalId = await readGoalId(flags)
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'))
    try {
      const goal = await runtime.editOriginalGoal(goalId, { objective: String(flags.objective ?? 'revised objective'), reason: String(flags.reason ?? 'scenario edit') })
      process.stdout.write(`${JSON.stringify({ goal_id: goalId, state: goal.state, revision: goal.revision })}\n`)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** reject-goal: reject the proposal observed at the expected control revision. */
  async 'reject-goal'(flags) {
    const goalId = await readGoalId(flags)
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'))
    try {
      const expected = typeof flags['expected-revision'] === 'string' ? Number(flags['expected-revision']) : undefined
      const control = new TaskControlApi(runtime)
      const result = control.rejectReplanAtRevision(goalId, expected)
      process.stdout.write(`${JSON.stringify({ goal_id: goalId, kind: result.kind, control_revision: result.task?.controlRevision })}\n`)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** accept-replan: accept the proposal observed at the expected control revision. */
  async 'accept-replan'(flags) {
    const goalId = await readGoalId(flags)
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'))
    try {
      const expected = typeof flags['expected-revision'] === 'string' ? Number(flags['expected-revision']) : undefined
      const control = new TaskControlApi(runtime)
      const result = await control.acceptReplan({ taskId: goalId, expectedRevision: expected }, {})
      process.stdout.write(`${JSON.stringify({ goal_id: goalId, kind: result.kind, control_revision: result.task?.controlRevision })}\n`)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** purge-archived: purge archives older than the retention window. */
  async 'purge-archived'(flags) {
    const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'))
    try {
      const retentionDays = typeof flags['retention-days'] === 'string' ? Number(flags['retention-days']) : 30
      const removed = runtime.purgeExpiredArchives(new Date(), retentionDays)
      process.stdout.write(`${JSON.stringify({ removed })}\n`)
      await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    } finally {
      runtime.close()
    }
  },

  /** verify-replay: append every goal's recorded events to a fresh store and compare projections. */
  async 'verify-replay'() {
    const { RuntimeEventStore } = await import(DIST)
    const source = new RuntimeEventStore(requireEnv('LT_DATABASE_PATH'))
    try {
      const goals = [...source.listGoals(), ...source.listGoals({ archived: true })]
      if (goals.length === 0) {
        process.stdout.write(`${JSON.stringify({ replayed: 0, consistent: true, note: 'no goals to replay' })}\n`)
        return
      }
      const goalId = goals[0].id
      const events = source.listEvents(goalId, 0, 10_000)
      const sourceGoal = source.getGoal(goalId)
      const replayPath = path.join(requireEnv('LT_WORKSPACE'), 'replay.sqlite')
      const replay = new RuntimeEventStore(replayPath)
      try {
        replay.append(events)
        const replayGoal = replay.getGoal(goalId)
        const consistent = replayGoal !== undefined && replayGoal.state === sourceGoal?.state && replayGoal.revision === sourceGoal?.revision
        process.stdout.write(`${JSON.stringify({ replayed: events.length, consistent, source_state: sourceGoal?.state, replay_state: replayGoal?.state })}\n`)
        // Exit non-zero when the replayed projection diverges so the oracle
        // command_exit_code_equals(verify_replay, 0) is executable (LT-FAULT-009:
        // the projection must replay idempotently and stay ordered).
        if (!consistent) process.exitCode = 1
      } finally {
        replay.close()
      }
    } finally {
      source.close()
    }
  },

  /** export-state: (re)export the durable state into staging. */
  async 'export-state'() {
    await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
    process.stdout.write('{"exported": true}\n')
  },
}

/** Shared lifecycle-control wrapper. */
async function control(flags, operation) {
  const goalId = await readGoalId(flags)
  const runtime = makeRuntime(requireEnv('LT_DATABASE_PATH'), String(flags.planner ?? 'static-success'), String(flags.executor ?? 'succeed'))
  try {
    const goal = await operation({ runtime, goalId })
    process.stdout.write(`${JSON.stringify({ goal_id: goalId, state: goal?.state, revision: goal?.revision })}\n`)
    await exportState(requireEnv('LT_DATABASE_PATH'), requireEnv('LT_STAGING_DIR'))
  } finally {
    runtime.close()
  }
}

/** Remember the run's goal id across harness processes. */
async function persistGoalId(goalId) {
  const file = process.env.LT_GOAL_FILE ?? path.join(requireEnv('LT_WORKSPACE'), '.lt-goal-id')
  await writeFile(file, goalId, 'utf8')
}

/** @param {Record<string, string | boolean>} flags */
async function readGoalId(flags) {
  if (typeof flags['goal-id'] === 'string') return flags['goal-id']
  const { readFile } = await import('node:fs/promises')
  const file = process.env.LT_GOAL_FILE ?? path.join(requireEnv('LT_WORKSPACE'), '.lt-goal-id')
  return (await readFile(file, 'utf8')).trim()
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || !(command in COMMANDS)) {
    process.stderr.write(`usage: node validation/runner/harness.mjs <${Object.keys(COMMANDS).join('|')}> [--flag value]\n`)
    process.exitCode = 2
    return
  }
  try {
    await COMMANDS[command](parseFlags(rest))
  } catch (error) {
    process.stderr.write(`harness ${command} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

await main()
