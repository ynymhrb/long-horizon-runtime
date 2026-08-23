import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { LongTaskRuntime } from './runtime.js'
import { TaskControlApi } from './task-api.js'
import { TaskUiApi } from './task-ui-api.js'

/** Browser-safe host query surface; payloads deliberately remain JSON values. */
export class LongTaskRemote extends TypertRemoteService {
  private readonly runtime: LongTaskRuntime
  private readonly ui: TaskUiApi

  constructor(ctx: Context, runtime: LongTaskRuntime) {
    super(ctx, 'longTasks')
    this.runtime = runtime
    this.ui = new TaskUiApi(runtime, new TaskControlApi(runtime))
    for (const initialize of remoteInitializers) initialize.call(this)
  }

  get(taskId: string): unknown { return this.runtime.getStatus(taskId) ?? null }
  list(): unknown { return this.runtime.listGoals() }
  listTasks(input: { cursor?: number; filter?: { state?: string; query?: string; archived?: boolean; sessionId?: string } }): unknown { return this.ui.listTasks(input as Parameters<TaskUiApi['listTasks']>[0]) }
  getTask(input: { taskId: string }): unknown { return this.ui.getTask(input) }
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
export const inject = ['longTaskRuntime']
export function apply(ctx: Context): void {
  const runtime = ctx.get('longTaskRuntime') as LongTaskRuntime | undefined
  if (runtime === undefined) throw new Error('longTaskRuntime service is unavailable')
  new LongTaskRemote(ctx, runtime)
}

// The host's Remote decorator uses the standard decorator initializer API.
// Invoke the same public API explicitly so this source stays executable by
// Node's strip-only TypeScript loader during DSH/plugin test composition.
const remoteInitializers: Array<(this: LongTaskRemote) => void> = []
Remote('get')(LongTaskRemote.prototype.get, {
  kind: 'method', name: 'get', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.get },
  metadata: undefined,
} as never)
Remote('list')(LongTaskRemote.prototype.list, {
  kind: 'method', name: 'list', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.list },
  metadata: undefined,
} as never)
Remote('listTasks')(LongTaskRemote.prototype.listTasks, {
  kind: 'method', name: 'listTasks', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.listTasks }, metadata: undefined,
} as never)
Remote('getTask')(LongTaskRemote.prototype.getTask, {
  kind: 'method', name: 'getTask', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.getTask }, metadata: undefined,
} as never)
Remote('getTaskGraph')(LongTaskRemote.prototype.getTaskGraph, {
  kind: 'method', name: 'getTaskGraph', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.getTaskGraph }, metadata: undefined,
} as never)
Remote('listTaskEvents')(LongTaskRemote.prototype.listTaskEvents, {
  kind: 'method', name: 'listTaskEvents', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.listTaskEvents }, metadata: undefined,
} as never)
Remote('getCurrentTaskForSession')(LongTaskRemote.prototype.getCurrentTaskForSession, {
  kind: 'method', name: 'getCurrentTaskForSession', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.getCurrentTaskForSession }, metadata: undefined,
} as never)
Remote('updateTask')(LongTaskRemote.prototype.updateTask, {
  kind: 'method', name: 'updateTask', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.updateTask }, metadata: undefined,
} as never)
Remote('attachCurrentSession')(LongTaskRemote.prototype.attachCurrentSession, {
  kind: 'method', name: 'attachCurrentSession', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.attachCurrentSession }, metadata: undefined,
} as never)
Remote('setCurrentSession')(LongTaskRemote.prototype.setCurrentSession, {
  kind: 'method', name: 'setCurrentSession', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.setCurrentSession }, metadata: undefined,
} as never)
Remote('clearCurrentSession')(LongTaskRemote.prototype.clearCurrentSession, {
  kind: 'method', name: 'clearCurrentSession', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.clearCurrentSession }, metadata: undefined,
} as never)
Remote('rejectReplan')(LongTaskRemote.prototype.rejectReplan, {
  kind: 'method', name: 'rejectReplan', static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object.rejectReplan }, metadata: undefined,
} as never)
for (const method of ['editTaskGoal', 'acceptReplan', 'archiveTask', 'restoreTask', 'getTaskNavigation'] as const) Remote(method)(LongTaskRemote.prototype[method], {
  kind: 'method', name: method, static: false, private: false,
  addInitializer(initializer: (this: LongTaskRemote) => void) { remoteInitializers.push(initializer) },
  access: { has: () => true, get: (object: LongTaskRemote) => object[method] }, metadata: undefined,
} as never)
