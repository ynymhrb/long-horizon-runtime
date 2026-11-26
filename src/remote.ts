import { TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { LongTaskRuntime } from './runtime.js'
import { TaskControlApi } from './task-api.js'
import { TaskUiApi } from './task-ui-api.js'
import type { LongTaskSettings } from './settings.js'
import { longTaskRemote } from '../client/remote-contract.js'

/** Browser-safe host query surface; payloads deliberately remain JSON values. */
export class LongTaskRemote extends TypertRemoteService {
  private readonly runtime: LongTaskRuntime
  private readonly ui: TaskUiApi

  constructor(ctx: Context, runtime: LongTaskRuntime, private readonly settings?: LongTaskSettings) {
    super(ctx, 'longTasks')
    this.runtime = runtime
    this.ui = new TaskUiApi(runtime, new TaskControlApi(runtime))
  }

  getLongTaskSettings(): unknown { return this.settings?.read() ?? null }
  saveLongTaskSettings(input: { expectedRevision: string; draft: unknown }): unknown {
    if (this.settings === undefined) throw new Error('当前运行时不可编辑设置')
    return this.settings.save(input.expectedRevision, input.draft)
  }

  get(taskId: string): unknown { return this.runtime.getStatus(taskId) ?? null }
  list(): unknown { return this.runtime.listGoals() }
  listTasks(input: { cursor?: number; filter?: { state?: string; query?: string; archived?: boolean; sessionId?: string } }): unknown { return this.ui.listTasks(input as Parameters<TaskUiApi['listTasks']>[0]) }
  getTask(input: { taskId: string }): unknown { return this.ui.getTask(input) }
  getTaskAudit(input: { taskId: string }): unknown { return this.ui.getTaskAudit(input) }
  getTaskGraph(input: { taskId: string; revision?: number }): unknown { return this.ui.getTaskGraph(input) }
  listTaskEvents(input: { taskId: string; cursor?: number; taskNodeId?: string }): unknown { return this.ui.listTaskEvents(input) }
  getCurrentTaskForSession(input: { sessionId: string }): unknown { return this.ui.getCurrentTaskForSession(input) }
  updateTask(input: { taskId: string; expectedRevision: number; action: 'confirm' | 'resume' | 'pause' | 'cancel'; sessionId?: string; workspaceScope?: string; recoveryResolution?: 'retry' | 'confirmed_succeeded' }): Promise<unknown> { return this.ui.updateTask(input) }
  attachCurrentSession(input: { taskId: string; sessionId: string; workspaceScope?: string }): Promise<unknown> { return this.ui.attachCurrentSession(input) }
  setCurrentSession(input: { taskId: string; sessionId: string; workspaceScope?: string }): unknown { return this.ui.setCurrentSession(input) }
  clearCurrentSession(input: { sessionId: string }): unknown { return this.ui.clearCurrentSession(input) }
  rejectReplan(input: { taskId: string; expectedRevision: number }): unknown { return this.ui.rejectReplan(input) }
  editTaskGoal(input: { taskId: string; expectedRevision: number; objective: string; reason: string; sessionId?: string }): Promise<unknown> { return this.ui.editTaskGoal(input) }
  acceptReplan(input: { taskId: string; expectedRevision: number; sessionId?: string }): Promise<unknown> { return this.ui.acceptReplan(input) }
  archiveTask(input: { taskId: string; expectedRevision: number }): Promise<unknown> { return this.ui.archiveTask(input) }
  restoreTask(input: { taskId: string }): unknown { return this.ui.restoreTask(input) }
  getTaskNavigation(input: { taskId: string }): unknown { return this.ui.getTaskNavigation(input) }
}

/** Separate host-plane loader row: Gateway can enumerate this active Service. */
export const name = 'long-task-runtime-remote'
export const inject = ['longTaskRuntime', 'typert']
export function apply(ctx: Context): void {
  const runtime = ctx.get('longTaskRuntime') as LongTaskRuntime | undefined
  if (runtime === undefined) throw new Error('longTaskRuntime service is unavailable')
  const registry = ctx.get('typert') as TypertHostRegistry | undefined
  if (registry === undefined) throw new Error('Typert registry is unavailable')
  new LongTaskRemote(ctx, runtime, ctx.get('longTaskSettings') as LongTaskSettings | undefined)
  registry.register({
    package: longTaskRemote.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: longTaskRemote.descriptors,
  })
}

interface TypertHostRegistry {
  register(contribution: {
    readonly package: string
    readonly face: 'host'
    readonly schemas: readonly []
    readonly model: { readonly services: readonly []; readonly events: readonly []; readonly objects: readonly [] }
    readonly invocations: readonly InvocationDescriptor[]
  }): unknown
}
