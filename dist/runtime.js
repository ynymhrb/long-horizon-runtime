import { randomUUID } from 'node:crypto';
import { planWithValidation } from './adapters.js';
import { applyMutation } from './graph.js';
import { RuntimeEventStore } from './event-store.js';
import { Scheduler } from './scheduler.js';
import { ArtifactStore } from './artifacts.js';
import { withDshParent } from './dsh-adapters.js';
/** Durable command service. Agent/session objects may be supplied at activation time but are never persisted. */
export class LongTaskRuntime {
    planner;
    store;
    ownsStore;
    artifactStore;
    scheduler;
    livenessCheckIntervalMs;
    now;
    constructor(planner, execution, options = {}) {
        this.planner = planner;
        const normalized = typeof options === 'number' ? { maxConcurrentTasks: options } : options;
        this.ownsStore = normalized.store === undefined;
        this.store = normalized.store ?? new RuntimeEventStore(normalized.databasePath ?? ':memory:');
        this.artifactStore = normalized.artifactDirectory === undefined ? undefined : new ArtifactStore(normalized.artifactDirectory, normalized.artifactInlineLimitBytes ?? 65_536);
        this.livenessCheckIntervalMs = Math.max(10, Math.min(normalized.idleTimeoutMs ?? 300_000, 30_000));
        this.now = normalized.now ?? Date.now;
        this.scheduler = new Scheduler(execution, { store: this.store, maxConcurrentTasks: normalized.maxConcurrentTasks ?? 1, ...(normalized.defaultRetryPolicy === undefined ? {} : { defaultRetryPolicy: normalized.defaultRetryPolicy }), ...(normalized.retryBackoffMs === undefined ? {} : { retryBackoffMs: normalized.retryBackoffMs }), ...(normalized.maxRetryBackoffMs === undefined ? {} : { maxRetryBackoffMs: normalized.maxRetryBackoffMs }), ...(normalized.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: normalized.idleTimeoutMs }), ...(normalized.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: normalized.maxWallTimeMs }), ...(normalized.now === undefined ? {} : { now: normalized.now }), ...(normalized.recoveryValidator === undefined ? {} : { recoveryValidator: normalized.recoveryValidator }), ...(normalized.validator === undefined ? {} : { validator: normalized.validator }), ...(normalized.validators === undefined ? {} : { validators: normalized.validators }), ...(this.artifactStore === undefined ? {} : { artifactStore: this.artifactStore }), ...(normalized.autoReplan === true ? { onTerminalFailure: async (input) => { await this.requestAutomaticReplan(input.goalId, input); } } : {}) });
    }
    async createGoal(request, executionParent, executionSignal) {
        if (request.objective.trim().length === 0)
            throw new Error('goal objective must not be empty');
        const id = `lt_${randomUUID()}`;
        const mode = request.planningMode ?? 'auto';
        this.store.transaction(() => this.store.append([{ type: 'GoalCreated', goalId: id, payload: { objective: request.objective, constraints: request.constraints ?? [], planningMode: mode, workspaceScope: request.workspaceScope } }]));
        let plan;
        try {
            plan = await planWithValidation(this.planner, { goalId: id, objective: request.objective, constraints: request.constraints ?? [], ...(executionSignal === undefined ? {} : { signal: executionSignal }) });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.store.transaction(() => this.store.append([executionSignal?.aborted === true
                    ? { type: 'GoalPaused', goalId: id, payload: { reason: 'planning interrupted by conversation stop' } }
                    : { type: 'GoalFailed', goalId: id, payload: { phase: 'planning', reason } }]));
            return this.view(id);
        }
        this.store.transaction(() => this.store.append([{ type: mode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId: id, payload: { revision: plan.revision, tasks: [...plan.tasks.values()] } }]));
        if (mode === 'auto' && executionParent !== undefined) {
            await this.runUntilIdle(id, executionParent, executionSignal);
            this.scheduleQuotaRecovery(id, executionParent);
        }
        return this.view(id);
    }
    async confirmGoal(goalId, executionParent, executionSignal) {
        const goal = this.requireGoal(goalId);
        if (goal.state !== 'AWAITING_CONFIRMATION')
            throw new Error(`goal ${goalId} is not awaiting confirmation`);
        const plan = this.store.getPlan(goalId);
        if (plan === undefined)
            throw new Error(`goal ${goalId} has no proposed plan`);
        const invalidatedTaskIds = plan.invalidatedTaskIds.length > 0 ? plan.invalidatedTaskIds : plan.tasks.filter(task => task.state === 'INVALIDATED').map(task => task.id);
        this.store.transaction(() => this.store.append([{ type: 'PlanConfirmed', goalId, payload: { revision: plan.revision, invalidatedTaskIds, staleTaskIds: plan.staleTaskIds } }, { type: 'PlanRevisionApplied', goalId, payload: { revision: plan.revision, tasks: plan.tasks, invalidatedTaskIds, staleTaskIds: plan.staleTaskIds } }]));
        if (executionParent !== undefined) {
            await this.runUntilIdle(goalId, executionParent, executionSignal);
            this.scheduleQuotaRecovery(goalId, executionParent);
        }
        return this.view(goalId);
    }
    getStatus(goalId) {
        if (this.store.getGoal(goalId) === undefined)
            return undefined;
        this.scheduler.reconcileLiveness(goalId);
        return this.view(goalId);
    }
    reportAttemptProgress(sessionId, attemptId, phase, message, completed, total) {
        this.scheduler.reportProgress(sessionId, attemptId, phase, message, completed, total);
    }
    /** Profile-local task inventory for the cross-session Task Area. */
    listGoals(options = {}) { return this.store.listGoals(options).map(goal => this.view(goal.id)); }
    /** Archive hides a task from the default inventory without discarding its audit history. */
    archiveGoal(goalId, now = new Date()) {
        const goal = this.requireGoal(goalId);
        if (goal.archivedAt !== undefined)
            return this.view(goalId);
        if (['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state))
            this.scheduler.cancel(goalId);
        this.cancelQuotaRecovery(goalId);
        this.store.transaction(() => this.store.append([{ type: 'GoalArchived', goalId, payload: { archivedAt: now.toISOString() } }]));
        return this.view(goalId);
    }
    /** Restoring an archive affects visibility only; it never replays cancelled work. */
    restoreGoal(goalId) {
        const goal = this.requireGoal(goalId);
        if (goal.archivedAt !== undefined)
            this.store.transaction(() => this.store.append([{ type: 'GoalRestored', goalId, payload: {} }]));
        return this.view(goalId);
    }
    /** Remove archives older than the retention window and their unshared file artifacts. */
    purgeExpiredArchives(now = new Date(), retentionDays = 30) {
        const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
        const paths = this.store.listArchivedArtifactPathsBefore(cutoff);
        const removed = this.store.purgeArchivedBefore(cutoff);
        for (const path of paths)
            if (!this.store.isArtifactPathReferenced(path))
                this.artifactStore?.removeIfOwned(path);
        return removed;
    }
    /** Revise the durable user objective and create a confirmation-fenced replacement plan. */
    async editOriginalGoal(goalId, input, executionParent, executionSignal) {
        const goal = this.requireGoal(goalId);
        if (goal.archivedAt !== undefined)
            throw new Error(`goal ${goalId} is archived`);
        if (input.objective.trim().length === 0 || input.reason.trim().length === 0)
            throw new Error('goal objective and revision reason must not be empty');
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(goal.state))
            throw new Error(`goal ${goalId} is terminal and cannot be edited`);
        if (goal.state === 'RUNNING')
            this.scheduler.interrupt(goalId);
        this.cancelQuotaRecovery(goalId);
        const nextVersion = this.store.listGoalVersions(goalId).length;
        const baseRevision = goal.revision;
        this.store.transaction(() => this.store.append([
            ...(goal.state === 'RUNNING' ? [{ type: 'GoalPaused', goalId, payload: { reason: 'original_goal_edit' } }] : []),
            { type: 'GoalObjectiveRevised', goalId, payload: { version: nextVersion, objective: input.objective, reason: input.reason, source: input.source ?? 'user', createdAt: new Date().toISOString() } },
            { type: 'DecisionRecorded', goalId, payload: { type: 'original_goal_edit', baseRevision, reason: input.reason } },
        ]));
        try {
            const planned = await planWithValidation(this.planner, { goalId, objective: input.objective, constraints: goal.constraints, ...(executionSignal === undefined ? {} : { signal: executionSignal }) });
            const revision = baseRevision + 1;
            this.store.transaction(() => this.store.append([{ type: 'PlanProposed', goalId, payload: { revision, baseRevision, trigger: { kind: 'original_goal_edit', reason: input.reason }, tasks: [...planned.tasks.values()] } }]));
        }
        catch (error) {
            this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'goal_replan_failed', reason: error instanceof Error ? error.message : String(error) } }]));
        }
        void executionParent;
        void executionSignal;
        return this.view(goalId);
    }
    /** Replan only after a terminal failure has already been durably recorded. */
    async requestAutomaticReplan(goalId, trigger) {
        const goal = this.requireGoal(goalId);
        if (goal.archivedAt !== undefined || goal.state !== 'RUNNING')
            return this.view(goalId);
        const currentTasks = this.store.listTasks(goalId);
        try {
            const planned = await planWithValidation(this.planner, { goalId, objective: goal.objective, constraints: goal.constraints, baseRevision: goal.revision, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason }, priorTasks: currentTasks });
            const candidate = [...planned.tasks.values()];
            const safe = automaticReplanIsSafe(currentTasks, candidate);
            const revision = goal.revision + 1;
            const tasks = preserveCompletedTasks(currentTasks, candidate);
            this.store.transaction(() => this.store.append([
                { type: 'DecisionRecorded', goalId, payload: { type: 'automatic_replan', outcome: safe ? 'auto_applied' : 'await_confirmation', trigger: { taskId: trigger.task.id, reason: trigger.reason } } },
                safe
                    ? { type: 'PlanRevisionApplied', goalId, payload: { revision, tasks, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason } } }
                    : { type: 'PlanProposed', goalId, payload: { revision, baseRevision: goal.revision, tasks, trigger: { kind: 'validation_failed', taskId: trigger.task.id, reason: trigger.reason } } },
            ]));
        }
        catch (error) {
            this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: 'automatic_replan_failed', taskId: trigger.task.id, reason: error instanceof Error ? error.message : String(error) } }, { type: 'GoalPaused', goalId, payload: { reason: `automatic replan failed for ${trigger.task.id}` } }]));
        }
        return this.view(goalId);
    }
    attachSession(goalId, sessionId, kind = 'attached') {
        if (sessionId.trim().length === 0)
            throw new Error('session id must not be empty');
        const goal = this.requireGoal(goalId);
        const exists = this.store.listSessionLinks(goalId).some(link => link.sessionId === sessionId && link.kind === kind);
        if (!exists)
            this.store.transaction(() => this.store.append([
                { type: 'TaskSessionAttached', goalId, payload: { sessionId, kind } },
                { type: 'TaskControlRevisionAdvanced', goalId, payload: { controlRevision: goal.controlRevision + 1 } },
            ]));
        return this.view(goalId);
    }
    async resumeGoal(goalId, executionParent, recoveryResolution, executionSignal) {
        const goal = this.requireGoal(goalId);
        // A web-side resume/confirm marks the goal RUNNING without a live parent
        // (durably eligible, nothing dispatched). A later model-side resume must
        // therefore accept an already-running goal and drive it with a live parent
        // instead of failing with "not paused" and stranding the task.
        if (goal.state !== 'PAUSED' && goal.state !== 'RUNNING')
            throw new Error(`goal ${goalId} cannot be resumed while ${goal.state}`);
        if (goal.state === 'PAUSED') {
            if (this.store.getPlan(goalId) === undefined) {
                this.store.transaction(() => this.store.append([{ type: 'GoalResumed', goalId, payload: { reason: 'resume interrupted planning' } }]));
                try {
                    const plan = await planWithValidation(this.planner, { goalId, objective: goal.objective, constraints: goal.constraints, ...(executionSignal === undefined ? {} : { signal: executionSignal }) });
                    this.store.transaction(() => this.store.append([{ type: goal.planningMode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId, payload: { revision: plan.revision, tasks: [...plan.tasks.values()] } }]));
                    if (goal.planningMode === 'auto' && executionParent !== undefined) {
                        await this.runUntilIdle(goalId, executionParent, executionSignal);
                        this.scheduleQuotaRecovery(goalId, executionParent);
                    }
                }
                catch (error) {
                    this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { reason: executionSignal?.aborted === true ? 'planning interrupted by conversation stop' : `planning resume failed: ${error instanceof Error ? error.message : String(error)}` } }]));
                }
                return this.view(goalId);
            }
            const blockedExternalTask = this.store.listTasks(goalId).find(task => task.state === 'BLOCKED' && task.sideEffectClass === 'external_effect');
            if (blockedExternalTask !== undefined) {
                if (recoveryResolution === undefined)
                    throw new Error(`goal ${goalId} requires an explicit recovery resolution for external task ${blockedExternalTask.id}`);
                this.store.transaction(() => this.store.append([
                    { type: 'DecisionRecorded', goalId, payload: { type: 'external_recovery_resolution', taskId: blockedExternalTask.id, resolution: recoveryResolution } },
                    { type: 'TaskRecoveryResolved', goalId, taskId: blockedExternalTask.id, payload: { resolution: recoveryResolution } },
                    { type: 'GoalResumed', goalId, payload: { recoveryResolution, taskId: blockedExternalTask.id } },
                ]));
            }
            else {
                if (recoveryResolution !== undefined)
                    throw new Error(`goal ${goalId} has no indeterminate external effect to resolve`);
                this.store.transaction(() => this.store.append([{ type: 'GoalResumed', goalId, payload: {} }]));
            }
        }
        if (executionParent !== undefined) {
            await this.runUntilIdle(goalId, executionParent, executionSignal);
            this.scheduleQuotaRecovery(goalId, executionParent);
        }
        return this.view(goalId);
    }
    cancelGoal(goalId) {
        const goal = this.requireGoal(goalId);
        if (!['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state))
            throw new Error(`goal ${goalId} cannot be cancelled while ${goal.state}`);
        this.scheduler.cancel(goalId);
        this.cancelQuotaRecovery(goalId);
        return this.view(goalId);
    }
    /** Record the interruption cause before applying the caller-selected recovery policy. */
    interruptGoal(goalId, cause, recoveryOutcome) {
        const goal = this.requireGoal(goalId);
        if (!['AWAITING_CONFIRMATION', 'RUNNING', 'PAUSED'].includes(goal.state))
            throw new Error(`goal ${goalId} cannot be interrupted while ${goal.state}`);
        this.scheduler.interrupt(goalId);
        this.cancelQuotaRecovery(goalId);
        this.store.transaction(() => this.store.append([{ type: 'ExecutionInterrupted', goalId, payload: { cause, recoveryOutcome } }]));
        if (recoveryOutcome === 'terminate')
            this.scheduler.cancel(goalId);
        return this.view(goalId);
    }
    invalidateTask(goalId, taskId, reason, evidenceRefs = []) {
        return this.mutatePlan(goalId, { kind: 'invalidateTask', taskId, reason, evidenceRefs });
    }
    /** Apply one of the constrained V1 graph mutations, preserving every prior revision. */
    mutatePlan(goalId, mutation) {
        const goal = this.requireGoal(goalId);
        if (!['RUNNING', 'PAUSED'].includes(goal.state))
            throw new Error(`goal ${goalId} cannot be changed while ${goal.state}`);
        const plan = this.store.getPlan(goalId);
        if (plan === undefined)
            throw new Error(`goal ${goalId} has no active plan`);
        // The revision JSON is immutable historical input. Current task projections
        // include success/failure since that revision and must seed every mutation.
        const current = { goalId, revision: goal.revision, tasks: new Map(this.store.listTasks(goalId).map(task => [task.id, task])) };
        const next = applyMutation(current, mutation);
        const invalidatedTaskIds = [...next.tasks.values()].filter(task => task.state === 'INVALIDATED').map(task => task.id);
        const staleTaskIds = mutation.kind === 'replaceTask' || mutation.kind === 'addEdge'
            ? [...next.tasks.values()].filter(task => task.state === 'PENDING' && this.store.getTask(goalId, task.id)?.state === 'SUCCEEDED').map(task => task.id)
            : [];
        const event = { type: goal.planningMode === 'auto' ? 'PlanRevisionApplied' : 'PlanProposed', goalId, payload: { revision: next.revision, tasks: [...next.tasks.values()], reason: mutation.reason, evidenceRefs: mutation.evidenceRefs, invalidatedTaskIds, staleTaskIds } };
        this.store.transaction(() => this.store.append([{ type: 'DecisionRecorded', goalId, payload: { type: mutation.kind, mutation } }, event]));
        return this.view(goalId);
    }
    proposeReplan(goalId, mutation) {
        const goal = this.requireGoal(goalId);
        if (!['RUNNING', 'PAUSED'].includes(goal.state))
            throw new Error(`goal ${goalId} cannot be replanned while ${goal.state}`);
        const current = { goalId, revision: goal.revision, tasks: new Map(this.store.listTasks(goalId).map(task => [task.id, task])) };
        const next = applyMutation(current, mutation);
        this.store.transaction(() => this.store.append([
            { type: 'DecisionRecorded', goalId, payload: { type: 'replan_proposed', mutation } },
            { type: 'PlanProposed', goalId, payload: { revision: next.revision, baseRevision: goal.revision, trigger: { reason: mutation.reason, evidenceRefs: mutation.evidenceRefs }, tasks: [...next.tasks.values()] } },
        ]));
        return this.view(goalId);
    }
    rejectReplan(goalId) {
        const goal = this.requireGoal(goalId);
        const proposal = this.store.getPlan(goalId);
        if (goal.state !== 'AWAITING_CONFIRMATION' || proposal?.state !== 'PROPOSED' || proposal.baseRevision === undefined)
            throw new Error(`goal ${goalId} has no replan proposal`);
        this.store.transaction(() => this.store.append([{ type: 'PlanRejected', goalId, payload: { revision: proposal.revision, restoreState: 'RUNNING' } }]));
        return this.view(goalId);
    }
    /** Advance at most one round repeatedly, used by non-DSH callers and tests with a live parent. */
    async runUntilIdle(goalId, executionParent, executionSignal) {
        for (;;) {
            const dispatched = await this.scheduler.runRound(goalId, undefined, executionParent, executionSignal);
            const state = this.requireGoal(goalId).state;
            if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(state))
                return;
            if (dispatched)
                continue;
            // Nothing was ready, but a failed attempt may be in retry backoff: wait
            // until the earliest retry is due instead of returning while the goal is
            // still running. Without a pending retry the goal is idle.
            const delay = this.scheduler.nextRetryDelayMs(goalId);
            if (delay === undefined)
                return;
            await sleep(delay, executionSignal);
        }
    }
    background = new Map();
    quotaRecoveryTimers = new Map();
    /**
     * Begin background execution of a RUNNING goal with a live parent and return
     * immediately. The model tool call no longer blocks for the whole DAG; the
     * loop keeps dispatching rounds until the goal is idle, awaiting confirmation,
     * paused, or terminal. Idempotent per goal.
     */
    startBackground(goalId, executionParent) {
        if (this.background.has(goalId) || executionParent === undefined)
            return;
        let watchdog;
        const promise = withDshParent(executionParent, () => this.runUntilIdle(goalId, executionParent))
            .catch(error => {
            // A failed supervisory loop is itself durable operator information;
            // silently swallowing it used to leave a goal apparently RUNNING.
            if (this.store.getGoal(goalId)?.state === 'RUNNING')
                this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { reason: `background scheduler failed: ${error instanceof Error ? error.message : String(error)}` } }]));
        })
            .finally(() => {
            if (watchdog !== undefined)
                clearInterval(watchdog);
            this.background.delete(goalId);
            this.scheduleQuotaRecovery(goalId, executionParent);
        });
        this.background.set(goalId, promise);
        watchdog = setInterval(() => {
            try {
                this.scheduler.reconcileLiveness(goalId);
            }
            catch (error) {
                if (this.store.getGoal(goalId)?.state === 'RUNNING')
                    this.store.transaction(() => this.store.append([{ type: 'GoalPaused', goalId, payload: { reason: `liveness watchdog failed: ${error instanceof Error ? error.message : String(error)}` } }]));
            }
        }, this.livenessCheckIntervalMs);
    }
    /** Resolve the in-flight background execution for a goal, if any (test seam). */
    awaitBackground(goalId) { return this.background.get(goalId); }
    async recover(executionParent) {
        // Preserve the actual lease-expiry evidence across a host restart before
        // generic interruption recovery examines the same running attempt.
        this.scheduler.reconcileLiveness();
        const recoveredGoals = await this.scheduler.recover();
        if (executionParent !== undefined)
            for (const goal of recoveredGoals) {
                // An indeterminate external effect is a durable operator choice.  A
                // live parent is not authority to silently decide whether to replay it.
                const requiresResolution = this.store.listTasks(goal).some(task => task.state === 'BLOCKED' && task.sideEffectClass === 'external_effect');
                if (this.store.getGoal(goal)?.state === 'PAUSED' && !requiresResolution)
                    await this.resumeGoal(goal, executionParent);
            }
    }
    close() { this.background.clear(); for (const timer of this.quotaRecoveryTimers.values())
        clearTimeout(timer); this.quotaRecoveryTimers.clear(); if (this.ownsStore)
        this.store.close(); }
    scheduleQuotaRecovery(goalId, executionParent) {
        const recovery = this.store.getQuotaRecovery(goalId);
        if (recovery === undefined || executionParent === undefined || this.quotaRecoveryTimers.has(goalId))
            return;
        const delay = Math.max(0, Date.parse(recovery.retryAt) - this.now());
        this.quotaRecoveryTimers.set(goalId, setTimeout(() => {
            this.quotaRecoveryTimers.delete(goalId);
            if (this.store.getQuotaRecovery(goalId)?.attemptId !== recovery.attemptId || this.store.getGoal(goalId)?.state !== 'PAUSED')
                return;
            void withDshParent(executionParent, async () => {
                await this.resumeGoal(goalId, executionParent);
            }).catch(() => undefined);
        }, delay));
    }
    cancelQuotaRecovery(goalId) {
        const timer = this.quotaRecoveryTimers.get(goalId);
        if (timer !== undefined)
            clearTimeout(timer);
        this.quotaRecoveryTimers.delete(goalId);
    }
    requireGoal(goalId) { const goal = this.store.getGoal(goalId); if (goal === undefined)
        throw new Error(`unknown goal ${goalId}`); return goal; }
    view(goalId) {
        const goal = this.requireGoal(goalId);
        const tasks = this.store.listTasks(goalId);
        const actions = goal.state === 'AWAITING_CONFIRMATION' ? ['confirm', 'cancel'] : goal.state === 'PAUSED' ? ['resume', 'cancel', 'invalidate'] : goal.state === 'RUNNING' ? ['pause', 'cancel', 'invalidate'] : [];
        const attempts = tasks.flatMap(task => this.store.listAttempts(task.id, goalId));
        const plan = this.store.getPlan(goalId);
        const quotaRecovery = this.store.getQuotaRecovery(goalId);
        return { id: goal.id, objective: goal.objective, constraints: goal.constraints, state: goal.state, revision: goal.revision, controlRevision: goal.controlRevision, ...(goal.workspaceScope === undefined ? {} : { workspaceScope: goal.workspaceScope }), ...(goal.archivedAt === undefined ? {} : { archivedAt: goal.archivedAt }), sessionLinks: this.store.listSessionLinks(goalId), ...(plan?.state === 'PROPOSED' && plan.baseRevision !== undefined ? { pendingProposal: { revision: plan.revision, baseRevision: plan.baseRevision, ...(plan.trigger === undefined ? {} : { trigger: plan.trigger }) } } : {}), ...(quotaRecovery === undefined ? {} : { quotaRecovery }), tasks, attempts, artifacts: this.store.listActiveValidatedArtifacts(goalId), decisions: this.store.listDecisions(goalId), ...(this.store.latestCheckpoint(goalId) === undefined ? {} : { checkpoint: this.store.latestCheckpoint(goalId) }), accounting: { attemptCount: attempts.length, succeededTaskCount: tasks.filter(task => task.state === 'SUCCEEDED').length, failedTaskCount: tasks.filter(task => task.state === 'FAILED').length }, recentEvents: this.store.listRecentEvents(goalId), availableActions: actions, ...(goal.pauseReason === undefined ? {} : { pauseReason: goal.pauseReason }) };
    }
}
function automaticReplanIsSafe(previous, candidate) {
    const next = new Map(candidate.map(task => [task.id, task]));
    for (const task of previous) {
        if (task.state !== 'SUCCEEDED')
            continue;
        // A completed task's identity is structural: id, dependencies, and side
        // effect class. Planner text edits to a completed task's objective are not
        // plan changes and must not force a safe replan into confirmation.
        const replacement = next.get(task.id);
        if (replacement === undefined)
            return false;
        if (replacement.sideEffectClass !== task.sideEffectClass)
            return false;
        if (JSON.stringify(replacement.dependsOn) !== JSON.stringify(task.dependsOn))
            return false;
    }
    return candidate.every(task => task.sideEffectClass !== 'external_effect');
}
function preserveCompletedTasks(previous, candidate) {
    const old = new Map(previous.map(task => [task.id, task]));
    return candidate.map(task => {
        const prior = old.get(task.id);
        if (prior?.state !== 'SUCCEEDED')
            return task;
        // Completed work is immutable: keep the original objective text so a safe
        // replan stays auto-applicable and the applied plan never mutates history.
        return { ...task, objective: prior.objective, state: 'SUCCEEDED' };
    });
}
async function sleep(ms, signal) {
    if (signal?.aborted === true)
        return;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}
