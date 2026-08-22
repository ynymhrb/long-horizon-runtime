/** Published package identity. */
export const pluginName = '@deepseek-ai/dsh-long-task-runtime'
export { name, inject } from './tools.js'

export { LongTaskRuntime } from './runtime.js'
export type { CreateGoalRequest, GoalView } from './runtime.js'
export { TaskControlApi } from './task-api.js'
export type { CreateTaskRequest, TaskInvocation, TaskUpdateAction, TaskUpdateResult } from './task-api.js'
export { RuntimeEventStore } from './event-store.js'
export { validatePlan, applyMutation } from './graph.js'
export type { InterruptionCause, RecoveryPolicyOutcome } from './domain.js'
export type { Config } from './tools.js'
export { apply } from './tools.js'
export { createDshExecutionAdapter, createDshPlannerAdapter, withDshParent } from './dsh-adapters.js'
