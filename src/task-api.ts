import type { GoalView, CreateGoalRequest, LongTaskRuntime, RecoveryResolution } from './runtime.js'
import type { InterruptionCause, RecoveryPolicyOutcome } from './domain.js'
import type { GraphMutation } from './domain.js'

export interface TaskInvocation { readonly sessionId?: string; readonly workspaceScope?: string; readonly parent?: unknown; readonly signal?: AbortSignal }
export interface CreateTaskRequest extends CreateGoalRequest { readonly workspaceScope: string }
export type TaskUpdateAction = 'confirm' | 'resume' | 'pause' | 'cancel'
export type TaskUpdateResult = { readonly kind: 'applied'; readonly task: GoalView } | { readonly kind: 'conflict'; readonly current: GoalView }

/** Stable, session-neutral control surface. DSH tools and the future task UI both use this API. */
export class TaskControlApi {
  constructor(private readonly runtime: LongTaskRuntime) {}

  async create(request: CreateTaskRequest, invocation: TaskInvocation): Promise<GoalView> {
    this.assertScope(request.workspaceScope, invocation.workspaceScope)
    const task = await this.runtime.createGoal({ ...request, planningMode: request.planningMode ?? 'require_confirmation' }, invocation.parent, invocation.signal)
    if (invocation.sessionId === undefined) return task
    this.runtime.attachSession(task.id, invocation.sessionId, 'origin')
    return this.setCurrentSessionTask(task.id, { sessionId: invocation.sessionId, workspaceScope: request.workspaceScope }).task
  }

  async attachSession(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId' | 'workspaceScope'>>): Promise<TaskUpdateResult> {
    const current = this.requireTask(taskId)
    this.assertScope(current.workspaceScope, invocation.workspaceScope)
    this.runtime.attachSession(taskId, invocation.sessionId)
    return this.setCurrentSessionTask(taskId, invocation)
  }

  /** Explicitly choose which linked task occupies this conversation's one task-strip slot. */
  setCurrentSessionTask(taskId: string, invocation: Required<Pick<TaskInvocation, 'sessionId' | 'workspaceScope'>>): Extract<TaskUpdateResult, { kind: 'applied' }> {
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
    return { kind: 'applied', task: this.advance(request.taskId, task.controlRevision) }
  }

  get(taskId: string, invocation?: Pick<TaskInvocation, 'workspaceScope'>): GoalView | undefined {
    const task = this.runtime.getStatus(taskId)
    if (task !== undefined && invocation?.workspaceScope !== undefined) this.assertScope(task.workspaceScope, invocation.workspaceScope)
    return task
  }
  interrupt(taskId: string, cause: InterruptionCause, recoveryOutcome: RecoveryPolicyOutcome): GoalView {
    return this.runtime.interruptGoal(taskId, cause, recoveryOutcome)
  }
  proposeReplan(taskId: string, mutation: GraphMutation): GoalView { return this.runtime.proposeReplan(taskId, mutation) }
  rejectReplan(taskId: string): GoalView { return this.runtime.rejectReplan(taskId) }

  private pause(taskId: string): GoalView {
    const task = this.requireTask(taskId)
    if (task.state !== 'RUNNING') throw new Error(`task ${taskId} is not running`)
    this.runtime.store.transaction(() => this.runtime.store.append([{ type: 'GoalPaused', goalId: taskId, payload: { reason: 'user_requested' } }]))
    return this.requireTask(taskId)
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
