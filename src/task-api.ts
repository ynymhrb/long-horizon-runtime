import type { GoalView, CreateGoalRequest, LongTaskRuntime, RecoveryResolution } from './runtime.js'
import type { InterruptionCause, RecoveryPolicyOutcome } from './domain.js'
import type { GraphMutation } from './domain.js'
import type { RuntimeEvent } from './event-store.js'

export interface TaskInvocation { readonly sessionId?: string; readonly workspaceScope?: string; readonly parent?: unknown; readonly signal?: AbortSignal }
export interface CreateTaskRequest extends CreateGoalRequest { readonly workspaceScope?: string }
export type TaskUpdateAction = 'confirm' | 'resume' | 'pause' | 'cancel'
export type TaskUpdateResult = { readonly kind: 'applied'; readonly task: GoalView } | { readonly kind: 'conflict'; readonly current: GoalView }

/** Compact event projection for model-facing reads; raw context/content never leaves the store. */
export interface EventSummary {
  readonly seq?: number
  readonly type: string
  readonly goalId: string
  readonly taskId?: string
  readonly createdAt?: string
  readonly payload: Record<string, unknown>
}
export interface AttemptSessionSummary { readonly id: string; readonly taskId: string; readonly state: string; readonly revision: number; readonly dshSessionId?: string; readonly summary?: string }

/** Payload keys that can carry unbounded or sensitive content; excluded from model-facing pages. */
const EVENT_PAYLOAD_EXCLUDED_KEYS = new Set(['context', 'content', 'tasks'])

function summarizeEvent(event: RuntimeEvent): EventSummary {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event.payload)) if (!EVENT_PAYLOAD_EXCLUDED_KEYS.has(key)) payload[key] = value
  return { ...(event.seq === undefined ? {} : { seq: event.seq }), type: event.type, goalId: event.goalId, ...(event.taskId === undefined ? {} : { taskId: event.taskId }), ...(event.createdAt === undefined ? {} : { createdAt: event.createdAt }), payload }
}

/** Stable, session-neutral control surface. DSH tools and the future task UI both use this API. */
export class TaskControlApi {
  constructor(private readonly runtime: LongTaskRuntime) {}

  async create(request: CreateTaskRequest, invocation: TaskInvocation): Promise<GoalView> {
    this.assertScope(request.workspaceScope, invocation.workspaceScope)
    const task = await this.runtime.createGoal({ ...request, planningMode: request.planningMode ?? 'require_confirmation' }, invocation.parent, invocation.signal)
    if (invocation.sessionId === undefined) return task
    this.runtime.attachSession(task.id, invocation.sessionId, 'origin')
    return this.setCurrentSessionTask(task.id, { sessionId: invocation.sessionId, ...(request.workspaceScope === undefined ? {} : { workspaceScope: request.workspaceScope }) }).task
  }

  async attachSession(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId'>> & Pick<TaskInvocation, 'workspaceScope'>): Promise<TaskUpdateResult> {
    const current = this.requireTask(taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    this.runtime.attachSession(taskId, invocation.sessionId)
    return this.setCurrentSessionTask(taskId, invocation)
  }

  /** Explicitly choose which linked task occupies this conversation's one task-strip slot. */
  setCurrentSessionTask(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId'>> & Pick<TaskInvocation, 'workspaceScope'>): Extract<TaskUpdateResult, { kind: 'applied' }> {
    const current = this.requireTask(taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    if (!current.sessionLinks.some(link => link.sessionId === invocation.sessionId)) throw new Error(`session ${invocation.sessionId} is not attached to task ${taskId}`)
    const nextControlRevision = current.controlRevision + 1
    this.runtime.store.transaction(() => this.runtime.store.append([
      { type: 'TaskSessionCurrentSet', goalId: taskId, payload: { sessionId: invocation.sessionId, controlRevision: nextControlRevision } },
      { type: 'TaskControlRevisionAdvanced', goalId: taskId, payload: { controlRevision: nextControlRevision } },
    ]))
    return { kind: 'applied', task: this.requireTask(taskId) }
  }

  /** Remove only the conversation display binding; its durable task links remain available for later selection. */
  clearCurrentSessionTask(sessionId: string): void {
    const binding = this.runtime.store.getCurrentTaskForSession(sessionId)
    if (binding === undefined) return
    const current = this.requireTask(binding.taskId)
    const nextControlRevision = current.controlRevision + 1
    this.runtime.store.transaction(() => this.runtime.store.append([
      { type: 'TaskSessionCurrentCleared', goalId: binding.taskId, payload: { sessionId } },
      { type: 'TaskControlRevisionAdvanced', goalId: binding.taskId, payload: { controlRevision: nextControlRevision } },
    ]))
  }

  async update(request: { readonly taskId: string; readonly expectedRevision: number; readonly action: TaskUpdateAction; readonly recoveryResolution?: RecoveryResolution }, invocation: TaskInvocation): Promise<TaskUpdateResult> {
    const current = this.requireTask(request.taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    if (request.expectedRevision !== current.controlRevision) return { kind: 'conflict', current }
    let task: GoalView
    switch (request.action) {
      case 'confirm': task = await this.runtime.confirmGoal(request.taskId, invocation.parent, invocation.signal); break
      case 'resume': task = await this.runtime.resumeGoal(request.taskId, invocation.parent, request.recoveryResolution, invocation.signal); break
      case 'cancel': task = this.runtime.cancelGoal(request.taskId); break
      case 'pause': task = this.pause(request.taskId); break
    }
    const bound = this.bindOnContinue(request.taskId, request.action, invocation)
    return { kind: 'applied', task: this.advance(request.taskId, (bound ?? task).controlRevision) }
  }

  async editGoal(request: { readonly taskId: string; readonly expectedRevision: number; readonly objective: string; readonly reason: string }, invocation: TaskInvocation): Promise<TaskUpdateResult> {
    const current = this.requireTask(request.taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    if (request.expectedRevision !== current.controlRevision) return { kind: 'conflict', current }
    const task = await this.runtime.editOriginalGoal(request.taskId, { objective: request.objective, reason: request.reason }, invocation.parent, invocation.signal)
    return { kind: 'applied', task: this.advance(request.taskId, task.controlRevision) }
  }
  async acceptReplan(request: { readonly taskId: string; readonly expectedRevision: number }, invocation: TaskInvocation): Promise<TaskUpdateResult> {
    const current = this.requireTask(request.taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    if (request.expectedRevision !== current.controlRevision) return { kind: 'conflict', current }
    const task = await this.runtime.confirmGoal(request.taskId, invocation.parent, invocation.signal)
    const bound = this.bindOnContinue(request.taskId, 'confirm', invocation)
    return { kind: 'applied', task: this.advance(request.taskId, (bound ?? task).controlRevision) }
  }

  get(taskId: string, invocation?: Pick<TaskInvocation, 'workspaceScope'>): GoalView | undefined {
    const task = this.runtime.getStatus(taskId)
    if (task !== undefined && invocation?.workspaceScope !== undefined) this.assertScope(task.workspaceScope, invocation.workspaceScope)
    return task
  }

  /**
   * Model-friendly incremental event page. Events are projected to a compact
   * summary: raw context manifests and inline artifact content are excluded so
   * polling a long goal does not flood the model context.
   */
  listEvents(request: { readonly taskId: string; readonly cursor?: number; readonly limit?: number; readonly taskNodeId?: string }, invocation: Pick<TaskInvocation, 'workspaceScope'>): { readonly items: readonly EventSummary[]; readonly nextCursor?: number } | null {
    const task = this.runtime.getStatus(request.taskId)
    if (task === undefined) return null
    this.assertScope(task.workspaceScope, invocation.workspaceScope)
    const limit = request.limit === undefined ? 50 : Math.min(Math.max(Number(request.limit), 1), 100)
    const events = this.runtime.store.listEvents(request.taskId, request.cursor ?? 0, limit, request.taskNodeId)
    return { items: events.map(summarizeEvent), ...(events.length === limit ? { nextCursor: events.at(-1)!.seq } : {}) }
  }

  /** Resolve durable child session IDs of attempts so the caller can jump to or cite subagent logs. */
  listAttemptSessions(request: { readonly taskId: string; readonly taskNodeId?: string }, invocation: Pick<TaskInvocation, 'workspaceScope'>): { readonly attempts: readonly AttemptSessionSummary[] } | null {
    const task = this.runtime.getStatus(request.taskId)
    if (task === undefined) return null
    this.assertScope(task.workspaceScope, invocation.workspaceScope)
    const taskIds = request.taskNodeId === undefined ? task.tasks.map(node => node.id) : [request.taskNodeId]
    const attempts = taskIds.flatMap(id => this.runtime.store.listAttempts(id, request.taskId))
    return { attempts: attempts.map(attempt => ({ id: attempt.id, taskId: attempt.taskId, state: attempt.state, revision: attempt.revision, ...(attempt.dshSessionId === undefined ? {} : { dshSessionId: attempt.dshSessionId }), ...(attempt.summary === undefined ? {} : { summary: attempt.summary }) })) }
  }
  interrupt(taskId: string, cause: InterruptionCause, recoveryOutcome: RecoveryPolicyOutcome): GoalView {
    return this.runtime.interruptGoal(taskId, cause, recoveryOutcome)
  }
  proposeReplan(taskId: string, mutation: GraphMutation): GoalView { return this.runtime.proposeReplan(taskId, mutation) }
  rejectReplan(taskId: string): GoalView { return this.runtime.rejectReplan(taskId) }

  /** Reject only the proposal observed at this control revision; never discard a newer plan. */
  rejectReplanAtRevision(taskId: string, expectedRevision: number): TaskUpdateResult {
    const current = this.requireTask(taskId)
    if (current.controlRevision !== expectedRevision) return { kind: 'conflict', current }
    const task = this.runtime.rejectReplan(taskId)
    return { kind: 'applied', task: this.advance(taskId, task.controlRevision) }
  }

  private pause(taskId: string): GoalView {
    const task = this.requireTask(taskId)
    if (task.state !== 'RUNNING') throw new Error(`task ${taskId} is not running`)
    this.runtime.store.transaction(() => this.runtime.store.append([{ type: 'GoalPaused', goalId: taskId, payload: { reason: 'user_requested' } }]))
    return this.requireTask(taskId)
  }

  /**
   * Idempotently ensure a session is durably linked to the task and is its
   * current binding. Continuing a task from a conversation must make that
   * conversation the task's jump target (origin provenance is preserved).
   */
  continueInSession(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId'>> & Pick<TaskInvocation, 'workspaceScope'>): GoalView {
    const current = this.requireTask(taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    if (!current.sessionLinks.some(link => link.sessionId === invocation.sessionId)) this.runtime.attachSession(taskId, invocation.sessionId)
    if (this.runtime.store.getCurrentTaskForSession(invocation.sessionId)?.taskId !== taskId) return this.setCurrentSessionTask(taskId, invocation).task
    return this.requireTask(taskId)
  }

  /** Only actions that continue a task in a conversation (confirm/resume) bind that session; pause/cancel stay explicit-attach-only. */
  private bindOnContinue(taskId: string, action: TaskUpdateAction, invocation: TaskInvocation): GoalView | undefined {
    const sessionId = invocation.sessionId
    if (sessionId === undefined || (action !== 'confirm' && action !== 'resume')) return undefined
    return this.continueInSession(taskId, { sessionId, ...(invocation.workspaceScope === undefined ? {} : { workspaceScope: invocation.workspaceScope }) })
  }

  private advance(taskId: string, currentRevision: number): GoalView {
    this.runtime.store.transaction(() => this.runtime.store.append([{ type: 'TaskControlRevisionAdvanced', goalId: taskId, payload: { controlRevision: currentRevision + 1 } }]))
    return this.requireTask(taskId)
  }
  private requireTask(taskId: string): GoalView { const task = this.runtime.getStatus(taskId); if (task === undefined) throw new Error(`unknown task ${taskId}`); return task }
  private assertScope(taskScope: string | undefined, invocationScope: string | undefined): void {
    if (taskScope !== undefined && invocationScope !== undefined && taskScope !== invocationScope) throw new Error('task belongs to a different workspace scope')
  }
}
