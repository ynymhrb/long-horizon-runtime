import type { TaskNode } from './domain.js'
import type { RuntimeEvent } from './event-store.js'
import type { GoalView, LongTaskRuntime } from './runtime.js'
import type { TaskControlApi, TaskUpdateResult } from './task-api.js'

export interface CursorPage<T> { readonly items: readonly T[]; readonly nextCursor?: number }
export interface TaskListFilter { readonly state?: GoalView['state']; readonly query?: string; readonly archived?: boolean }
export interface TaskProgress { readonly succeeded: number; readonly total: number }
export interface TaskSummary {
  readonly id: string
  readonly objective: string
  readonly state: GoalView['state']
  readonly revision: number
  readonly controlRevision: number
  readonly workspaceScope?: string
  readonly progress: TaskProgress
  readonly currentOrLastNode?: { readonly id: string; readonly objective: string; readonly state: string }
  readonly reason?: string
  readonly latestEventCursor: number
}
export interface TaskStripView extends TaskSummary { readonly availableActions: readonly string[] }
export interface TaskGraphView { readonly taskId: string; readonly revision: number; readonly nodes: readonly TaskNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }

const terminalStates = new Set<GoalView['state']>(['SUCCEEDED', 'FAILED', 'CANCELLED'])

/** Browser read model. It derives compact JSON DTOs from durable runtime projections only. */
export class TaskUiApi {
  constructor(private readonly runtime: LongTaskRuntime, private readonly control: TaskControlApi) {}

  listTasks(input: { readonly cursor?: number; readonly filter?: TaskListFilter } = {}): CursorPage<TaskSummary> {
    const cursor = input.cursor ?? 0
    const all = this.runtime.listGoals({ ...(input.filter?.archived === undefined ? {} : { archived: input.filter.archived }) }).filter(task => matches(task, input.filter)).map(task => this.summary(task)).sort(compareTaskSummary)
    const items = all.slice(cursor, cursor + 50)
    return { items, ...(cursor + items.length < all.length ? { nextCursor: cursor + items.length } : {}) }
  }

  getTask(input: { readonly taskId: string }): GoalView | null { return this.runtime.getStatus(input.taskId) ?? null }

  getTaskGraph(input: { readonly taskId: string; readonly revision?: number }): TaskGraphView | null {
    const task = this.runtime.getStatus(input.taskId)
    if (task === undefined) return null
    const plan = this.runtime.store.getPlan(input.taskId, input.revision)
    if (plan === undefined) return null
    const nodes = input.revision === undefined && task.tasks.length > 0 ? task.tasks : plan.tasks
    return { taskId: input.taskId, revision: plan.revision, nodes, edges: nodes.flatMap(node => node.dependsOn.map(from => ({ from, to: node.id }))) }
  }

  listTaskEvents(input: { readonly taskId: string; readonly cursor?: number; readonly taskNodeId?: string }): CursorPage<RuntimeEvent> {
    const items = this.runtime.store.listEvents(input.taskId, input.cursor ?? 0, 50, input.taskNodeId)
    return { items, ...(items.length === 50 ? { nextCursor: items[items.length - 1]!.seq } : {}) }
  }

  getCurrentTaskForSession(input: { readonly sessionId: string }): TaskStripView | null {
    const binding = this.runtime.store.getCurrentTaskForSession(input.sessionId)
    if (binding === undefined) return null
    const task = this.runtime.getStatus(binding.taskId)
    return task === undefined || terminalStates.has(task.state) ? null : { ...this.summary(task), availableActions: task.availableActions }
  }

  async updateTask(input: { readonly taskId: string; readonly expectedRevision: number; readonly action: 'confirm' | 'resume' | 'pause' | 'cancel'; readonly sessionId?: string; readonly workspaceScope?: string; readonly recoveryResolution?: 'retry' | 'confirmed_succeeded'; readonly parent?: unknown; readonly signal?: AbortSignal }): Promise<TaskUpdateResult> {
    return this.control.update({ taskId: input.taskId, expectedRevision: input.expectedRevision, action: input.action, ...(input.recoveryResolution === undefined ? {} : { recoveryResolution: input.recoveryResolution }) }, { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }), ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.signal === undefined ? {} : { signal: input.signal }) })
  }

  /** Explicit user action: create a durable cross-session link and make it current. */
  async attachCurrentSession(input: { readonly taskId: string; readonly sessionId: string; readonly workspaceScope?: string }): Promise<TaskUpdateResult> {
    return this.control.attachSession(input.taskId, { sessionId: input.sessionId, ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }) })
  }

  /** Explicit user action for a session that is already linked to this task. */
  setCurrentSession(input: { readonly taskId: string; readonly sessionId: string; readonly workspaceScope?: string }): TaskUpdateResult {
    return this.control.setCurrentSessionTask(input.taskId, { sessionId: input.sessionId, ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }) })
  }

  /** Hide the strip for this conversation without erasing its task provenance. */
  clearCurrentSession(input: { readonly sessionId: string }): null {
    this.control.clearCurrentSessionTask(input.sessionId)
    return null
  }

  rejectReplan(input: { readonly taskId: string; readonly expectedRevision: number }): TaskUpdateResult {
    return this.control.rejectReplanAtRevision(input.taskId, input.expectedRevision)
  }
  async editTaskGoal(input: { readonly taskId: string; readonly expectedRevision: number; readonly objective: string; readonly reason: string; readonly sessionId?: string; readonly workspaceScope?: string; readonly parent?: unknown; readonly signal?: AbortSignal }): Promise<TaskUpdateResult> {
    return this.control.editGoal({ taskId: input.taskId, expectedRevision: input.expectedRevision, objective: input.objective, reason: input.reason }, { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }), ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.signal === undefined ? {} : { signal: input.signal }) })
  }
  async acceptReplan(input: { readonly taskId: string; readonly expectedRevision: number; readonly sessionId?: string; readonly workspaceScope?: string; readonly parent?: unknown; readonly signal?: AbortSignal }): Promise<TaskUpdateResult> {
    return this.control.acceptReplan({ taskId: input.taskId, expectedRevision: input.expectedRevision }, { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }), ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.signal === undefined ? {} : { signal: input.signal }) })
  }
  async archiveTask(input: { readonly taskId: string; readonly expectedRevision: number }): Promise<TaskUpdateResult> {
    const current = this.runtime.getStatus(input.taskId)
    if (current === undefined) throw new Error(`unknown task ${input.taskId}`)
    if (current.controlRevision !== input.expectedRevision) return { kind: 'conflict', current }
    return { kind: 'applied', task: this.runtime.archiveGoal(input.taskId) }
  }
  restoreTask(input: { readonly taskId: string }): GoalView { return this.runtime.restoreGoal(input.taskId) }
  getTaskNavigation(input: { readonly taskId: string }): { readonly attachedSessionIds: readonly string[]; readonly currentSessionId?: string } {
    const task = this.runtime.getStatus(input.taskId)
    if (task === undefined) throw new Error(`unknown task ${input.taskId}`)
    const attachedSessionIds = task.sessionLinks.map(link => link.sessionId)
    const currentSessionId = task.sessionLinks.find(link => this.runtime.store.getCurrentTaskForSession(link.sessionId)?.taskId === task.id)?.sessionId
    return { attachedSessionIds, ...(currentSessionId === undefined ? {} : { currentSessionId }) }
  }

  private summary(task: GoalView): TaskSummary {
    const nodes = currentNodes(this.runtime, task)
    const current = nodes.find(node => node.state === 'RUNNING') ?? nodes.find(node => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'].includes(node.state)) ?? nodes.at(-1)
    return {
      id: task.id,
      objective: task.objective,
      state: task.state,
      revision: task.revision,
      controlRevision: task.controlRevision,
      ...(task.workspaceScope === undefined ? {} : { workspaceScope: task.workspaceScope }),
      progress: { succeeded: nodes.filter(node => node.state === 'SUCCEEDED').length, total: nodes.length },
      ...(current === undefined ? {} : { currentOrLastNode: { id: current.id, objective: current.objective, state: current.state } }),
      ...(task.pauseReason === undefined ? {} : { reason: task.pauseReason }),
      latestEventCursor: this.runtime.store.latestSeq(task.id),
    }
  }
}

function currentNodes(runtime: LongTaskRuntime, task: GoalView): readonly TaskNode[] {
  return task.tasks.length > 0 ? task.tasks : runtime.store.getPlan(task.id)?.tasks ?? []
}

function matches(task: GoalView, filter: TaskListFilter | undefined): boolean {
  if (filter?.state !== undefined && task.state !== filter.state) return false
  const query = filter?.query?.trim().toLowerCase()
  return query === undefined || query === '' || task.id.toLowerCase().includes(query) || task.objective.toLowerCase().includes(query)
}

/** Operator attention first; activity breaks ties deterministically. */
const taskStateOrder: Record<GoalView['state'], number> = { RUNNING: 0, AWAITING_CONFIRMATION: 1, PAUSED: 2, DRAFT: 3, FAILED: 4, CANCELLED: 5, SUCCEEDED: 6 }
function compareTaskSummary(left: TaskSummary, right: TaskSummary): number {
  return taskStateOrder[left.state] - taskStateOrder[right.state] || right.latestEventCursor - left.latestEventCursor || left.id.localeCompare(right.id)
}
