import { randomUUID } from 'node:crypto'
import { planWithValidation, type ExecutionAdapter, type PlannerAdapter } from './adapters.js'
import { applyMutation, validatePlan } from './graph.js'
import type { TaskNode, GoalState, GraphMutation, InterruptionCause, PauseOrigin, RecoveryPolicyOutcome } from './domain.js'
import { RuntimeEventStore, type TaskSessionLink } from './event-store.js'
import type { WorkerPool } from './worker-pool.js'
import { Scheduler, type RecoveryResult } from './scheduler.js'
import { ArtifactStore } from './artifacts.js'
import { withDshParent } from './dsh-adapters.js'
import { classifyAutomaticReplan } from './replan-policy.js'
import type { ProfileRouter } from './execution-profiles.js'
import type { ExecutionPolicy } from './execution-policy.js'
import type { MemoryRetriever } from './memory-retrieval.js'
import type { BudgetLimit } from './budgets.js'
import { parseWorkflow, readWorkflowVerdict, workflowProfiles, workflowStep, WorkflowVisitLimit, type WorkflowSpec } from './workflow.js'

export type RecoveryResolution = 'retry' | 'confirmed_succeeded'
export interface OriginalGoalEdit { readonly objective: string; readonly reason: string; readonly source?: 'user' | 'model' }

export interface CreateGoalRequest { readonly objective: string; readonly orchestration?: WorkflowSpec; readonly constraints?: readonly string[]; readonly planningMode?: 'auto' | 'require_confirmation'; readonly workspaceScope?: string }
export interface GoalView { readonly id: string; readonly objective: string; readonly constraints: readonly string[]; readonly state: GoalState; readonly revision: number; readonly controlRevision: number; readonly workspaceScope?: string; readonly archivedAt?: string; readonly sessionLinks: readonly TaskSessionLink[]; readonly pendingProposal?: { readonly revision: number; readonly baseRevision: number; readonly trigger?: Record<string, unknown> }; readonly pauseReason?: string; readonly pauseOrigin?: PauseOrigin; readonly quotaRecovery?: import('./event-store.js').QuotaRecovery; readonly tasks: readonly import('./domain.js').TaskNode[]; readonly attempts: readonly import('./event-store.js').AttemptProjection[]; readonly artifacts: readonly import('./event-store.js').ArtifactProjection[]; readonly decisions: readonly import('./event-store.js').DecisionProjection[]; readonly checkpoint?: import('./event-store.js').CheckpointProjection; readonly accounting: { readonly attemptCount: number; readonly succeededTaskCount: number; readonly failedTaskCount: number }; readonly runtimeMetrics: import('./event-store.js').RuntimeMetrics; readonly recentEvents: readonly import('./event-store.js').RuntimeEvent[]; readonly availableActions: readonly string[]; readonly requiresSessionDriver: boolean; readonly orchestration?: WorkflowSpec; readonly proposedOrchestration?: WorkflowSpec }
export interface RuntimeOptions { readonly store?: RuntimeEventStore; readonly workerPool?: WorkerPool; readonly databasePath?: string; readonly artifactDirectory?: string; readonly artifactInlineLimitBytes?: number; readonly maxConcurrentTasks?: number; readonly defaultRetryPolicy?: { readonly maxAttempts: number }; readonly retryBackoffMs?: number; readonly maxRetryBackoffMs?: number; readonly idleTimeoutMs?: number; readonly maxWallTimeMs?: number; readonly now?: () => number; readonly recoveryValidator?: (input: { readonly goalId: string; readonly task: import('./domain.js').TaskNode; readonly attemptId: string }) => Promise<RecoveryResult>; readonly validator?: import('./scheduler.js').SchedulerOptions['validator']; readonly validators?: import('./scheduler.js').SchedulerOptions['validators']; readonly autoReplan?: boolean; readonly profileRouter?: ProfileRouter; readonly executionPolicy?: ExecutionPolicy; readonly memoryRetriever?: MemoryRetriever; readonly maxMemoryItems?: number; readonly goalBudget?: BudgetLimit }

/** Durable command service. Agent/session objects may be supplied at activation time but are never persisted. */
export class LongTaskRuntime {
  readonly store: RuntimeEventStore
  private closed = false
  private settingsReloadUntil = 0
  private readonly ownsStore: boolean
  private readonly artifactStore: ArtifactStore | undefined
  private readonly scheduler: Scheduler
  private readonly livenessCheckIntervalMs: number
  private readonly now: () => number
  private readonly goalBudget: BudgetLimit | undefined
  private readonly profileRouter: ProfileRouter | undefined
  constructor(private readonly planner: PlannerAdapter, execution: ExecutionAdapter, options: number | RuntimeOptions = {}) {
    const normalized = typeof options === 'number' ? { maxConcurrentTasks: options } : options
    this.ownsStore = normalized.store === undefined
    this.store = normalized.store ?? new RuntimeEventStore(normalized.databasePath ?? ':memory:')
    this.artifactStore = normalized.artifactDirectory === undefined ? undefined : new ArtifactStore(normalized.artifactDirectory, normalized.artifactInlineLimitBytes ?? 65_536)
    this.livenessCheckIntervalMs = Math.max(10, Math.min(normalized.idleTimeoutMs ?? 300_000, 30_000))
    this.now = normalized.now ?? Date.now
    this.goalBudget = normalized.goalBudget
    this.profileRouter = normalized.profileRouter
    this.scheduler = new Scheduler(execution, { store: this.store, ...(normalized.workerPool === undefined ? {} : { workerPool: normalized.workerPool }), advanceWorkflow: goalId => this.advanceWorkflow(goalId), maxConcurrentTasks: normalized.maxConcurrentTasks ?? 1, ...(normalized.defaultRetryPolicy === undefined ? {} : { defaultRetryPolicy: normalized.defaultRetryPolicy }), ...(normalized.retryBackoffMs === undefined ? {} : { retryBackoffMs: normalized.retryBackoffMs }), ...(normalized.maxRetryBackoffMs === undefined ? {} : { maxRetryBackoffMs: normalized.maxRetryBackoffMs }), ...(normalized.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: normalized.idleTimeoutMs }), ...(normalized.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: normalized.maxWallTimeMs }), ...(normalized.now === undefined ? {} : { now: normalized.now }), ...(normalized.recoveryValidator === undefined ? {} : { recoveryValidator: normalized.recoveryValidator }), ...(normalized.validator === undefined ? {} : { validator: normalized.validator }), ...(normalized.validators === undefined ? {} : { validators: normalized.validators }), ...(normalized.profileRouter === undefined ? {} : { profileRouter: normalized.profileRouter }), ...(normalized.executionPolicy === undefined ? {} : { executionPolicy: normalized.executionPolicy }), ...(normalized.memoryRetriever === undefined ? {} : { memoryRetriever: normalized.memoryRetriever }), ...(normalized.maxMemoryItems === undefined ? {} : { maxMemoryItems: normalized.maxMemoryItems }), ...(this.artifactStore === undefined ? {} : { artifactStore: this.artifactStore }), ...(normalized.autoReplan === true ? { onTerminalFailure: async input => { await this.requestAutomaticReplan(input.goalId, input); } } : {}) })
  }
  settingsBusy(): boolean {
    return this.settingsReloadUntil > Date.now() || this.background.size > 0 || this.store.listRunningAttempts().length > 0
      || this.store.listGoals().some(goal => goal.state === 'RUNNING' || goal.state === 'DRAFT')
  }

  settingsReferencedProfiles(): readonly string[] {
    const profiles = new Set<string>()
    for (const goal of this.store.listGoals()) {
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(goal.state)) continue
      const plan = this.store.getPlan(goal.id)
      for (const task of [...this.store.listTasks(goal.id), ...(plan?.state === 'PROPOSED' ? plan.tasks : [])]) {
        if (task.state === 'SUCCEEDED') continue
        if (task.executionProfile !== undefined) profiles.add(task.executionProfile)
        for (const id of task.allowedExecutionProfiles ?? []) profiles.add(id)
      }
      const active = this.workflow(goal.id)
      const proposal = plan?.state === 'PROPOSED' ? this.proposedWorkflow(goal.id, plan.revision) : undefined
      for (const spec of [active, proposal]) {
        if (spec !== undefined) for (const id of workflowProfiles(spec)) profiles.add(id)
      }
    }
    return [...profiles]
  }

  holdSettingsReload(): () => void {
    if (this.settingsBusy()) throw new Error('长任务尚未空闲')
    const deadline = Date.now() + 120_000
    this.settingsReloadUntil = deadline
    return () => { if (this.settingsReloadUntil === deadline) this.settingsReloadUntil = 0 }
  }

  private assertSettingsReloadComplete(): void {
    if (this.settingsReloadUntil > Date.now()) throw new Error('长任务配置正在重新加载，请稍候')
  }

  async createGoal(request: CreateGoalRequest, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView> {
    this.assertSettingsReloadComplete()
    if (request.objective.trim().length === 0) throw new Error('goal objective must not be empty')
    const orchestration = request.orchestration === undefined ? undefined : parseWorkflow(request.orchestration, this.profileRouter?.profileIds())
    const id = `lt_${randomUUID()}`
    const mode = request.planningMode ?? 'auto'
    const workflowPlan = orchestration === undefined ? undefined : validatePlan({ goalId: id, revision: 1, tasks: [workflowStep(orchestration, request.objective, [])!] })
    this.store.transaction(() => this.store.append([
      { type: 'GoalCreated', goalId: id, payload: { objective: request.objective, constraints: request.constraints ?? [], planningMode: mode, workspaceScope: request.workspaceScope } },
      ...(normalizedGoalBudget(this.goalBudget) === undefined ? [] : [{ type: 'BudgetConfigured', goalId: id, payload: { scope: 'goal', limit: this.goalBudget } }]),
      ...(workflowPlan === undefined ? [] : [
        { type: 'WorkflowConfigured', goalId: id, payload: { revision: 1, spec: orchestration } },
        { type: mode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId: id, payload: { revision: workflowPlan.revision, tasks: [...workflowPlan.tasks.values()] } },
      ]),
    ]))
    if (workflowPlan !== undefined) {
      if (mode === 'auto' && executionParent !== undefined) { await this.runUntilIdle(id, executionParent, executionSignal); this.scheduleQuotaRecovery(id, executionParent) }
      return this.view(id)
    }
    let plan
    try { plan = await planWithValidation(this.planner, { goalId: id, objective: request.objective, constraints: request.constraints ?? [], ...(executionSignal === undefined ? {} : { signal: executionSignal }) }) }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.store.transaction(() => this.store.append([executionSignal?.aborted === true
        ? { type: 'GoalPaused', goalId: id, payload: { reason: 'planning interrupted by conversation stop', origin: 'operator' } }
        : { type: 'GoalFailed', goalId: id, payload: { phase: 'planning', reason } }]))
      return this.view(id)
    }
    this.store.transaction(() => this.store.append([{ type: mode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId: id, payload: { revision: plan.revision, tasks: [...plan.tasks.values()] } }]))
    if (mode === 'auto' && executionParent !== undefined) { await this.runUntilIdle(id, executionParent, executionSignal); this.scheduleQuotaRecovery(id, executionParent) }
    return this.view(id)
  }
  async confirmGoal(goalId: string, executionParent?: unknown, executionSignal?: AbortSignal, authority: PauseOrigin = 'agent'): Promise<GoalView> {
    this.assertSettingsReloadComplete()
    const goal = this.requireGoal(goalId)
    if (goal.state !== 'AWAITING_CONFIRMATION') throw new Error(`goal ${goalId} is not awaiting confirmation`)
    const plan = this.store.getPlan(goalId)
    if (plan === undefined) throw new Error(`goal ${goalId} has no proposed plan`)
    const invalidatedTaskIds = plan.invalidatedTaskIds.length > 0 ? plan.invalidatedTaskIds : plan.tasks.filter(task => task.state === 'INVALIDATED').map(task => task.id)
    const workflow = this.proposedWorkflow(goalId, plan.revision)
    if (workflow !== undefined && authority !== 'operator') throw new Error('请从任务区确认流程变更')
    this.store.transaction(() => {
      this.store.append([
        ...(workflow === undefined ? [] : [{ type: 'WorkflowConfigured', goalId, payload: { revision: plan.revision, spec: workflow } }]),
        { type: 'PlanConfirmed', goalId, payload: { revision: plan.revision, invalidatedTaskIds, staleTaskIds: plan.staleTaskIds } },
        { type: 'PlanRevisionApplied', goalId, payload: { revision: plan.revision, tasks: plan.tasks, invalidatedTaskIds, staleTaskIds: plan.staleTaskIds } },
      ])
      this.reconcileFinishedWorkflow(goalId)
    })
    if (executionParent !== undefined) { await this.runUntilIdle(goalId, executionParent, executionSignal); this.scheduleQuotaRecovery(goalId, executionParent) }
    return this.view(goalId)
  }
  getStatus(goalId: string): GoalView | undefined {
    if (this.store.getGoal(goalId) === undefined) return undefined
    this.scheduler.reconcileLiveness(goalId)
    return this.view(goalId)
  }
  reportAttemptProgress(sessionId: string, attemptId: string, phase: string, message: string, completed?: number, total?: number): void {
    this.scheduler.reportProgress(sessionId, attemptId, phase, message, completed, total)
  }
  /** Profile-local task inventory for the cross-session Task Area. */
  listGoals(options: { readonly archived?: boolean } = {}): GoalView[] { return this.store.listGoals(options).map(goal => this.view(goal.id)) }
  /** Archive hides a task from the default inventory without discarding its audit history. */
  archiveGoal(goalId: string, now: Date = new Date()): GoalView {
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined) return this.view(goalId)
    if (['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state)) this.scheduler.cancel(goalId)
    this.cancelQuotaRecovery(goalId)
    this.store.transaction(() => this.store.append([{ type: 'GoalArchived', goalId, payload: { archivedAt: now.toISOString() } }]))
    return this.view(goalId)
  }
  /** Restoring an archive affects visibility only; it never replays cancelled work. */
  restoreGoal(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined) this.store.transaction(() => this.store.append([{ type: 'GoalRestored', goalId, payload: {} }]))
    return this.view(goalId)
  }
  /** Remove archives older than the retention window and their unshared file artifacts. */
  purgeExpiredArchives(now: Date = new Date(), retentionDays = 30): string[] {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString()
    const paths = this.store.listArchivedArtifactPathsBefore(cutoff)
    const removed = this.store.purgeArchivedBefore(cutoff)
    for (const path of paths) if (!this.store.isArtifactPathReferenced(path)) this.artifactStore?.removeIfOwned(path)
    return removed
  }
  /** Revise the durable user objective and create a confirmation-fenced replacement plan. */
  async editOriginalGoal(goalId: string, input: OriginalGoalEdit, executionParent?: unknown, executionSignal?: AbortSignal): Promise<GoalView> {
    this.assertSettingsReloadComplete()
    this.assertPlannerManaged(goalId)
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined) throw new Error(`goal ${goalId} is archived`)
    if (input.objective.trim().length === 0 || input.reason.trim().length === 0) throw new Error('goal objective and revision reason must not be empty')
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(goal.state)) throw new Error(`goal ${goalId} is terminal and cannot be edited`)
    if (goal.state === 'RUNNING') this.scheduler.interrupt(goalId)
    this.cancelQuotaRecovery(goalId)
    const nextVersion = this.store.listGoalVersions(goalId).length
    const baseRevision = goal.revision
    this.store.transaction(() => this.store.append([
      ...(goal.state === 'RUNNING' ? [{ type: 'GoalPaused', goalId, payload: { reason: 'original_goal_edit', origin: 'system' } }] : []),
      { type: 'GoalObjectiveRevised', goalId, payload: { version: nextVersion, objective: input.objective, reason: input.reason, source: input.source ?? 'user', createdAt: new Date().toISOString() } },
      { type: 'DecisionRecorded', goalId, payload: { type: 'original_goal_edit', baseRevision, reason: input.reason } },
    ]))
    try {
      const planned = await planWithValidation(this.planner, { goalId, objective: input.objective, constraints: goal.constraints, ...(executionSignal === undefined ? {} : { signal: executionSignal }) })
      const revision = baseRevision + 1
      this.store.transaction(() => this.store.append([{ type: 'PlanProposed', goalId, payload: { revision, baseRevision, trigger: { kind: 'original_goal_edit', reason: input.reason }, tasks: [...planned.tasks.values()] } }]))
    } catch (error) {
      this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'goal_replan_failed', reason: error instanceof Error ? error.message : String(error) } }]))
    }
    void executionParent; void executionSignal
    return this.view(goalId)
  }
  /** Replan only after a terminal failure has already been durably recorded. */
  async requestAutomaticReplan(goalId: string, trigger: { readonly task: import('./domain.js').TaskNode; readonly reason: string }): Promise<GoalView> {
    if (this.store.latestEventPayload(goalId, 'WorkflowConfigured') !== undefined) return this.view(goalId)
    const goal = this.requireGoal(goalId)
    if (goal.archivedAt !== undefined || goal.state !== 'RUNNING') return this.view(goalId)
    const currentTasks = this.store.listTasks(goalId)
    try {
      const planned = await planWithValidation(this.planner, { goalId, objective: goal.objective, constraints: goal.constraints, baseRevision: goal.revision, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason }, priorTasks: currentTasks })
      const candidate = [...planned.tasks.values()]
      const classification = classifyAutomaticReplan({ previous: currentTasks, candidate, failedTaskId: trigger.task.id, activeArtifacts: this.store.listActiveValidatedArtifacts(goalId) })
      const safe = classification.outcome === 'auto_apply'
      const revision = goal.revision + 1
      const tasks = preserveCompletedTasks(currentTasks, candidate)
      this.store.transaction(() => this.store.append([
        { type: 'DecisionRecorded', goalId, payload: { type: 'automatic_replan', outcome: safe ? 'auto_applied' : 'await_confirmation', reasons: classification.reasons, trigger: { taskId: trigger.task.id, reason: trigger.reason } } },
        safe
          ? { type: 'PlanRevisionApplied', goalId, payload: { revision, tasks, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason } } }
          : { type: 'PlanProposed', goalId, payload: { revision, baseRevision: goal.revision, tasks, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason, reasons: classification.reasons } } },
      ]))
    } catch (error) {
      this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'automatic_replan_failed', taskId: trigger.task.id, reason: error instanceof Error ? error.message : String(error) } }, { type: 'GoalPaused', goalId, payload: { origin: 'system', reason: `automatic replan failed for ${trigger.task.id}` } }]))
    }
    return this.view(goalId)
  }
  attachSession(goalId: string, sessionId: string, kind: TaskSessionLink['kind'] = 'attached'): GoalView {
    if (sessionId.trim().length === 0) throw new Error('session id must not be empty')
    const goal = this.requireGoal(goalId)
    const exists = this.store.listSessionLinks(goalId).some(link => link.sessionId === sessionId && link.kind === kind)
    if (!exists) this.store.transaction(() => this.store.append([
      { type: 'TaskSessionAttached', goalId, payload: { sessionId, kind } },
      { type: 'TaskControlRevisionAdvanced', goalId, payload: { controlRevision: goal.controlRevision + 1 } },
    ]))
    return this.view(goalId)
  }
  async resumeGoal(goalId: string, executionParent?: unknown, recoveryResolution?: RecoveryResolution, executionSignal?: AbortSignal, authority: PauseOrigin = 'agent'): Promise<GoalView> {
    this.assertSettingsReloadComplete()
    const goal = this.requireGoal(goalId)
    // 操作者暂停是粘性的：代理在长 turn 里重复执行旧的继续指令时，不得静默
    // 覆盖用户刚做出的暂停决定。只有浏览器任务区（操作者）可以解除它。
    if (goal.state === 'PAUSED' && goal.pauseOrigin === 'operator' && authority !== 'operator') {
      throw new Error(`goal ${goalId} was paused by the operator; ask the user to resume it from the task area`)
    }
    // A web-side resume/confirm marks the goal RUNNING without a live parent
    // (durably eligible, nothing dispatched). A later model-side resume must
    // therefore accept an already-running goal and drive it with a live parent
    // instead of failing with "not paused" and stranding the task.
    if (goal.state !== 'PAUSED' && goal.state !== 'RUNNING') throw new Error(`goal ${goalId} cannot be resumed while ${goal.state}`)
    if (goal.state === 'PAUSED') {
      if (this.store.getPlan(goalId) === undefined) {
        this.store.transaction(() => this.store.append([{ type: 'GoalResumed', goalId, payload: { reason: 'resume interrupted planning' } }]))
        try {
          const plan = await planWithValidation(this.planner, { goalId, objective: goal.objective, constraints: goal.constraints, ...(executionSignal === undefined ? {} : { signal: executionSignal }) })
          this.store.transaction(() => this.store.append([{ type: goal.planningMode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId, payload: { revision: plan.revision, tasks: [...plan.tasks.values()] } }]))
          if (goal.planningMode === 'auto' && executionParent !== undefined) { await this.runUntilIdle(goalId, executionParent, executionSignal); this.scheduleQuotaRecovery(goalId, executionParent) }
        } catch (error) {
          this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { origin: 'system', reason: executionSignal?.aborted === true ? 'planning interrupted by conversation stop' : `planning resume failed: ${error instanceof Error ? error.message : String(error)}` } }]))
        }
        return this.view(goalId)
      }
      const blockedExternalTask = this.store.listTasks(goalId).find(task => task.state === 'BLOCKED' && task.sideEffectClass === 'external_effect')
      if (blockedExternalTask !== undefined) {
        if (recoveryResolution === undefined) throw new Error(`goal ${goalId} requires an explicit recovery resolution for external task ${blockedExternalTask.id}`)
        this.store.transaction(() => {
          this.store.append([
            { type: 'DecisionRecorded', goalId, payload: { type: 'external_recovery_resolution', taskId: blockedExternalTask.id, resolution: recoveryResolution } },
            { type: 'TaskRecoveryResolved', goalId, taskId: blockedExternalTask.id, payload: { resolution: recoveryResolution } },
            { type: 'GoalResumed', goalId, payload: { recoveryResolution, taskId: blockedExternalTask.id } },
          ])
          this.reconcileFinishedWorkflow(goalId)
        })
      } else {
        if (recoveryResolution !== undefined) throw new Error(`goal ${goalId} has no indeterminate external effect to resolve`)
        this.store.transaction(() => {
          this.store.append([{ type: 'GoalResumed', goalId, payload: {} }])
          this.reconcileFinishedWorkflow(goalId)
        })
      }
    }
    if (executionParent !== undefined) { await this.runUntilIdle(goalId, executionParent, executionSignal); this.scheduleQuotaRecovery(goalId, executionParent) }
    return this.view(goalId)
  }
  cancelGoal(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be cancelled while ${goal.state}`)
    this.scheduler.cancel(goalId)
    this.cancelQuotaRecovery(goalId)
    return this.view(goalId)
  }
  /** Pause scheduling and terminate all currently running child attempts. */
  pauseGoal(goalId: string, origin: PauseOrigin = 'system'): GoalView {
    const goal = this.requireGoal(goalId)
    if (goal.state !== 'RUNNING') throw new Error(`goal ${goalId} is not running`)
    this.scheduler.pause(goalId)
    this.cancelQuotaRecovery(goalId)
    this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { reason: origin === 'operator' ? 'user_requested' : origin === 'agent' ? 'agent_requested' : 'system_requested', origin } }]))
    return this.view(goalId)
  }
  extendGoalBudget(goalId: string, limit: BudgetLimit): GoalView {
    const goal = this.requireGoal(goalId)
    const previous = this.store.getBudgetSummary(goalId)?.goal ?? {}
    for (const [name, value] of Object.entries(limit)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`budget ${name} must be a non-negative safe integer`)
      const old = previous[name as keyof BudgetLimit]
      if (old !== undefined && value < old) throw new Error(`budget ${name} may not reduce`)
    }
    this.store.transaction(() => this.store.append([{ type: 'BudgetExtended', goalId, payload: { previous, limit } }, { type: 'BudgetConfigured', goalId, payload: { scope: 'goal', limit: { ...previous, ...limit } } }]))
    return this.view(goal.id)
  }
  /** Record the interruption cause before applying the caller-selected recovery policy. */
  interruptGoal(goalId: string, cause: InterruptionCause, recoveryOutcome: RecoveryPolicyOutcome): GoalView {
    const goal = this.requireGoal(goalId)
    if (!['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be interrupted while ${goal.state}`)
    this.scheduler.interrupt(goalId)
    this.cancelQuotaRecovery(goalId)
    this.store.transaction(() => this.store.append([{ type: 'ExecutionInterrupted', goalId, payload: { cause, recoveryOutcome } }]))
    if (recoveryOutcome === 'terminate') this.scheduler.cancel(goalId)
    return this.view(goalId)
  }
  invalidateTask(goalId: string, taskId: string, reason: string, evidenceRefs: readonly string[] = []): GoalView {
    return this.mutatePlan(goalId, { kind: 'invalidateTask', taskId, reason, evidenceRefs })
  }
  /** Apply one of the constrained V1 graph mutations, preserving every prior revision. */
  mutatePlan(goalId: string, mutation: GraphMutation): GoalView {
    this.assertPlannerManaged(goalId)
    const goal = this.requireGoal(goalId)
    if (!['RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be changed while ${goal.state}`)
    const plan = this.store.getPlan(goalId)
    if (plan === undefined) throw new Error(`goal ${goalId} has no active plan`)
    // The revision JSON is immutable historical input. Current task projections
    // include success/failure since that revision and must seed every mutation.
    const current = { goalId, revision: goal.revision, tasks: new Map(this.store.listTasks(goalId).map(task => [task.id, task])) }
    const next = applyMutation(current, mutation)
    const invalidatedTaskIds = [...next.tasks.values()].filter(task => task.state === 'INVALIDATED').map(task => task.id)
    const staleTaskIds = mutation.kind === 'replaceTask' || mutation.kind === 'addEdge'
      ? [...next.tasks.values()].filter(task => task.state === 'PENDING' && this.store.getTask(goalId, task.id)?.state === 'SUCCEEDED').map(task => task.id)
      : []
    const event = { type: goal.planningMode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId, payload: { revision: next.revision, tasks: [...next.tasks.values()], reason: mutation.reason, evidenceRefs: mutation.evidenceRefs, invalidatedTaskIds, staleTaskIds } } as const
    this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: mutation.kind, mutation } }, event]))
    return this.view(goalId)
  }
  proposeReplan(goalId: string, mutation: GraphMutation): GoalView {
    this.assertPlannerManaged(goalId)
    const goal = this.requireGoal(goalId)
    if (!['RUNNING', 'PAUSED'].includes(goal.state)) throw new Error(`goal ${goalId} cannot be replanned while ${goal.state}`)
    const current = { goalId, revision: goal.revision, tasks: new Map(this.store.listTasks(goalId).map(task => [task.id, task])) }
    const next = applyMutation(current, mutation)
    this.store.transaction(() => this.store.append([
      { type: 'DecisionRecorded', goalId, payload: { type: 'replan_proposed', mutation } },
      { type: 'PlanProposed', goalId, payload: { revision: next.revision, baseRevision: goal.revision, trigger: { reason: mutation.reason, evidenceRefs: mutation.evidenceRefs }, tasks: [...next.tasks.values()] } },
    ]))
    return this.view(goalId)
  }
  rejectReplan(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    const proposal = this.store.getPlan(goalId)
    if (goal.state !== 'AWAITING_CONFIRMATION' || proposal?.state !== 'PROPOSED' || proposal.baseRevision === undefined) throw new Error(`goal ${goalId} has no replan proposal`)
    const restoreState = this.proposedWorkflow(goalId, proposal.revision) === undefined ? 'RUNNING' : 'PAUSED'
    this.store.transaction(() => this.store.append([{ type: 'PlanRejected', goalId, payload: { revision: proposal.revision, restoreState } }]))
    return this.view(goalId)
  }
  proposeWorkflow(goalId: string, requested: unknown, reason: string, expectedRevision: number): GoalView {
    const goal = this.requireGoal(goalId)
    if (goal.controlRevision !== expectedRevision) throw new Error('流程变更的控制修订已过期')
    if (reason.trim() === '') throw new Error('流程变更需要原因')
    if (goal.state !== 'PAUSED' || this.workflow(goalId) === undefined) throw new Error('只能为已暂停的配置流程提出新修订')
    const spec = parseWorkflow(requested, this.profileRouter?.profileIds())
    const current = this.store.listTasks(goalId)
    const completed: TaskNode[] = []
    let verdict
    for (const task of current) {
      if (task.state !== 'SUCCEEDED') {
        if (task.state === 'RUNNING' || (task.sideEffectClass === 'external_effect' && this.store.listAttempts(task.id, goalId).length > 0)) {
          throw new Error('仍有执行中的尝试或需要人工判定的外部操作')
        }
        continue
      }
      const candidate = workflowStep(spec, goal.objective, completed.map(node => node.id), verdict)
      if (candidate === undefined || candidate.id !== task.id || candidate.objective !== task.objective
        || candidate.executionProfile !== task.executionProfile || candidate.sideEffectClass !== task.sideEffectClass
        || JSON.stringify(candidate.dependsOn) !== JSON.stringify(task.dependsOn)) {
        throw new Error('新流程会改动已完成阶段：' + task.id)
      }
      completed.push(task)
      verdict = this.workflowVerdict(goalId, task)
    }
    const next = workflowStep(spec, goal.objective, completed.map(node => node.id), verdict)
    const revision = this.store.nextPlanRevision(goalId)
    const plan = validatePlan({ goalId, revision, tasks: [...completed, ...(next === undefined ? [] : [next])] })
    const completedIds = new Set(completed.map(node => node.id))
    this.store.transaction(() => this.store.append([
      { type: 'WorkflowChangeProposed', goalId, payload: { revision, spec, reason } },
      { type: 'PlanProposed', goalId, payload: {
        baseRevision: goal.revision, revision, trigger: { kind: 'workflow_change', reason },
        tasks: [...plan.tasks.values()].map(task => ({ ...task, state: completedIds.has(task.id) ? 'SUCCEEDED' : task.state })),
      } },
      { type: 'TaskControlRevisionAdvanced', goalId, payload: { controlRevision: expectedRevision + 1 } },
    ]))
    return this.view(goalId)
  }

  private workflow(goalId: string): WorkflowSpec | undefined {
    return this.store.latestEventPayload(goalId, 'WorkflowConfigured')?.spec as WorkflowSpec | undefined
  }

  private proposedWorkflow(goalId: string, revision: number): WorkflowSpec | undefined {
    const event = this.store.latestEventPayload(goalId, 'WorkflowChangeProposed')
    return event?.revision === revision ? event.spec as WorkflowSpec : undefined
  }

  private workflowVerdict(goalId: string, task: TaskNode) {
    if (task.workflowReview !== true) return undefined
    const verdict = readWorkflowVerdict(this.store.listActiveValidatedArtifacts(goalId, [task.id]).map(artifact => ({
      type: artifact.type, content: artifact.content ?? this.artifactStore?.read(artifact) ?? '',
    })))
    if (verdict === undefined) throw new Error('已完成的评审缺少已验证结论')
    return verdict
  }

  private reconcileFinishedWorkflow(goalId: string): void {
    if (this.store.getGoal(goalId)?.state !== 'RUNNING' || this.workflow(goalId) === undefined) return
    const tasks = this.store.listTasks(goalId)
    if (tasks.length === 0 || !tasks.every(task => task.state === 'SUCCEEDED')) return
    if (!this.advanceWorkflow(goalId)) this.store.append([{ type: 'GoalSucceeded', goalId, payload: {} }])
  }

  /** Called inside the scheduler's end-of-round transaction. */
  private advanceWorkflow(goalId: string): boolean {
    const spec = this.workflow(goalId)
    if (spec === undefined) return false
    const goal = this.requireGoal(goalId)
    const tasks = this.store.listTasks(goalId)
    const last = tasks.at(-1)
    if (last === undefined || last.state !== 'SUCCEEDED') return false
    const verdict = this.workflowVerdict(goalId, last)
    let next
    try {
      next = workflowStep(spec, goal.objective, tasks.map(task => task.id), verdict)
    } catch (error) {
      if (!(error instanceof WorkflowVisitLimit)) throw error
      this.store.append([
        { type: 'WorkflowLimitReached', goalId, taskId: last.id, payload: { reason: error.message } },
        { type: 'GoalFailed', goalId, payload: { phase: 'workflow', reason: error.message } },
      ])
      return true
    }
    if (next === undefined) return false
    const revision = this.store.nextPlanRevision(goalId)
    const validated = validatePlan({ goalId, revision, tasks: [...tasks, next] })
    const states = new Map(tasks.map(task => [task.id, task.state]))
    this.store.append([
      { type: 'WorkflowAdvanced', goalId, taskId: last.id, payload: { revision, nextTaskId: next.id, ...(verdict === undefined ? {} : verdict) } },
      { type: 'PlanRevisionApplied', goalId, payload: { revision, tasks: [...validated.tasks.values()].map(task => ({ ...task, state: states.get(task.id) ?? task.state })) } },
    ])
    return true
  }

  /** Advance at most one round repeatedly, used by non-DSH callers and tests with a live parent. */
  async runUntilIdle(goalId: string, executionParent?: unknown, executionSignal?: AbortSignal): Promise<void> {
    this.assertSettingsReloadComplete()
    while (!this.closed) {
      const dispatched = await this.scheduler.runRound(goalId, undefined, executionParent, executionSignal)
      if (this.closed) return
      const state = this.requireGoal(goalId).state
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(state)) return
      if (dispatched) continue
      // Nothing was ready, but a failed attempt may be in retry backoff: wait
      // until the earliest retry is due instead of returning while the goal is
      // still running. Without a pending retry the goal is idle.
      const delay = this.scheduler.nextRetryDelayMs(goalId)
      if (delay === undefined) return
      await sleep(delay, executionSignal)
    }
  }

  private readonly background = new Map<string, Promise<void>>()
  private readonly quotaRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Begin background execution of a RUNNING goal with a live parent and return
   * immediately. The model tool call no longer blocks for the whole DAG; the
   * loop keeps dispatching rounds until the goal is idle, awaiting confirmation,
   * paused, or terminal. Idempotent per goal.
   */
  startBackground(goalId: string, executionParent: unknown): void {
    if (this.closed || this.background.has(goalId) || executionParent === undefined) return
    this.assertSettingsReloadComplete()
    let watchdog: ReturnType<typeof setInterval> | undefined
    const promise = withDshParent(executionParent as import('@deepseek-ai/dsh-agent').Agent, () => this.runUntilIdle(goalId, executionParent))
      .catch(error => {
        // A failed supervisory loop is itself durable operator information;
        // silently swallowing it used to leave a goal apparently RUNNING.
        if (!this.closed && this.store.getGoal(goalId)?.state === 'RUNNING') this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { origin: 'system', reason: `background scheduler failed: ${error instanceof Error ? error.message : String(error)}` } }]))
      })
      .finally(() => {
        if (watchdog !== undefined) clearInterval(watchdog)
        this.background.delete(goalId)
        if (!this.closed) this.scheduleQuotaRecovery(goalId, executionParent)
      })
    this.background.set(goalId, promise)
    watchdog = setInterval(() => {
      try { this.scheduler.reconcileLiveness(goalId) }
      catch (error) {
        if (!this.closed && this.store.getGoal(goalId)?.state === 'RUNNING') this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { origin: 'system', reason: `liveness watchdog failed: ${error instanceof Error ? error.message : String(error)}` } }]))
      }
    }, this.livenessCheckIntervalMs)
  }

  /** Resolve the in-flight background execution for a goal, if any (test seam). */
  awaitBackground(goalId: string): Promise<void> | undefined { return this.background.get(goalId) }
  async recover(executionParent?: unknown): Promise<void> {
    // Preserve the actual lease-expiry evidence across a host restart before
    // generic interruption recovery examines the same running attempt.
    this.scheduler.reconcileLiveness()
    const recoveredGoals = await this.scheduler.recover()
    if (this.closed) return
    // A crash can occur after TaskCompleted but before the end-of-round flow expansion.
    for (const goal of this.store.listGoals()) {
      if (goal.state !== 'RUNNING' || this.workflow(goal.id) === undefined) continue
      this.store.transaction(() => this.reconcileFinishedWorkflow(goal.id))
    }
    if (executionParent !== undefined) for (const goal of recoveredGoals) {
      // An indeterminate external effect is a durable operator choice.  A
      // live parent is not authority to silently decide whether to replay it.
      const requiresResolution = this.store.listTasks(goal).some(task => task.state === 'BLOCKED' && task.sideEffectClass === 'external_effect')
      if (this.store.getGoal(goal)?.state !== 'PAUSED' || requiresResolution) continue
      try {
        // 主机重启恢复属于系统行为：保留操作者暂停，并记录被尊重的证据。
        await this.resumeGoal(goal, executionParent, undefined, undefined, 'system')
      } catch (error) {
        this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId: goal, payload: { type: 'operator_pause_respected', reason: error instanceof Error ? error.message : String(error) } }]))
      }
    }
  }
  close(): void { if (this.closed) return; this.closed = true; this.scheduler.close(); this.background.clear(); for (const timer of this.quotaRecoveryTimers.values()) clearTimeout(timer); this.quotaRecoveryTimers.clear(); if (this.ownsStore) this.store.close() }
  private scheduleQuotaRecovery(goalId: string, executionParent: unknown): void {
    const recovery = this.store.getQuotaRecovery(goalId)
    if (recovery === undefined || executionParent === undefined || this.quotaRecoveryTimers.has(goalId)) return
    const delay = Math.max(0, Date.parse(recovery.retryAt) - this.now())
    this.quotaRecoveryTimers.set(goalId, setTimeout(() => {
      this.quotaRecoveryTimers.delete(goalId)
      if (this.store.getQuotaRecovery(goalId)?.attemptId !== recovery.attemptId || this.store.getGoal(goalId)?.state !== 'PAUSED') return
      void withDshParent(executionParent as import('@deepseek-ai/dsh-agent').Agent, async () => {
        this.store.transaction(() => this.store.append([{ type: 'QuotaRecoveryResumed', goalId, taskId: recovery.taskId, payload: { attemptId: recovery.attemptId, retryAt: recovery.retryAt } }]))
        // 额度恢复是系统行为，同样不能解除操作者暂停。
        await this.resumeGoal(goalId, executionParent, undefined, undefined, 'system')
      }).catch(error => {
        this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'quota_recovery_declined', reason: error instanceof Error ? error.message : String(error) } }]))
      })
    }, delay))
  }
  private cancelQuotaRecovery(goalId: string): void {
    const timer = this.quotaRecoveryTimers.get(goalId)
    if (timer !== undefined) clearTimeout(timer)
    this.quotaRecoveryTimers.delete(goalId)
  }
  private assertPlannerManaged(goalId: string): void {
    if (this.store.latestEventPayload(goalId, 'WorkflowConfigured') !== undefined) throw new Error('该目标由已保存的流程定义编排')
  }

  private requireGoal(goalId: string) { const goal = this.store.getGoal(goalId); if (goal === undefined) throw new Error(`unknown goal ${goalId}`); return goal }
  private view(goalId: string): GoalView {
    const goal = this.requireGoal(goalId)
    const tasks = this.store.listTasks(goalId)
    const actions = goal.state === 'AWAITING_CONFIRMATION' ? ['confirm', 'cancel'] : goal.state === 'PAUSED' ? ['resume', 'cancel', 'invalidate'] : goal.state === 'RUNNING' ? ['pause', 'cancel', 'invalidate'] : []
    const attempts = tasks.flatMap(task => this.store.listAttempts(task.id, goalId))
    const plan = this.store.getPlan(goalId)
    const quotaRecovery = this.store.getQuotaRecovery(goalId)
    const orchestration = this.workflow(goalId)
    const proposedOrchestration = plan?.state === 'PROPOSED' ? this.proposedWorkflow(goalId, plan.revision) : undefined
    const requiresSessionDriver = goal.state === 'RUNNING'
      && !this.background.has(goalId)
      && !tasks.some(task => task.state === 'RUNNING')
      && tasks.some(task => task.state === 'PENDING' || task.state === 'READY')
    return { id: goal.id, objective: goal.objective, constraints: goal.constraints, state: goal.state, revision: goal.revision, controlRevision: goal.controlRevision, ...(goal.workspaceScope === undefined ? {} : { workspaceScope: goal.workspaceScope }), ...(goal.archivedAt === undefined ? {} : { archivedAt: goal.archivedAt }), sessionLinks: this.store.listSessionLinks(goalId), ...(plan?.state === 'PROPOSED' && plan.baseRevision !== undefined ? { pendingProposal: { revision: plan.revision, baseRevision: plan.baseRevision, ...(plan.trigger === undefined ? {} : { trigger: plan.trigger }) } } : {}), ...(quotaRecovery === undefined ? {} : { quotaRecovery }), tasks, attempts, artifacts: this.store.listActiveValidatedArtifacts(goalId), decisions: this.store.listDecisions(goalId), ...(this.store.latestCheckpoint(goalId) === undefined ? {} : { checkpoint: this.store.latestCheckpoint(goalId)! }), accounting: { attemptCount: attempts.length, succeededTaskCount: tasks.filter(task => task.state === 'SUCCEEDED').length, failedTaskCount: tasks.filter(task => task.state === 'FAILED').length }, runtimeMetrics: this.store.getRuntimeMetrics(goalId, this.now()), recentEvents: this.store.listRecentEvents(goalId), availableActions: actions, requiresSessionDriver, ...(orchestration === undefined ? {} : { orchestration }), ...(proposedOrchestration === undefined ? {} : { proposedOrchestration }), ...(goal.pauseReason === undefined ? {} : { pauseReason: goal.pauseReason }), ...(goal.pauseOrigin === undefined ? {} : { pauseOrigin: goal.pauseOrigin }) }
  }
}

function preserveCompletedTasks(previous: readonly import('./domain.js').TaskNode[], candidate: readonly import('./domain.js').TaskNode[]): import('./domain.js').TaskNode[] {
  const old = new Map(previous.map(task => [task.id, task]))
  return candidate.map(task => {
    const prior = old.get(task.id)
    if (prior?.state !== 'SUCCEEDED') return task
    // Completed work is immutable: keep the original objective text so a safe
    // replan stays auto-applicable and the applied plan never mutates history.
    return { ...task, objective: prior.objective, state: 'SUCCEEDED' as const }
  })
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

function normalizedGoalBudget(value: BudgetLimit | undefined): BudgetLimit | undefined { return value === undefined || Object.keys(value).length === 0 ? undefined : value }
