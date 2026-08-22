import type { ExecutionAdapter, PlannerAdapter } from './adapters.js'
import { LongTaskRuntime } from './runtime.js'

/** Deployment configuration supplied from `cordis.yml`. */
export interface Config {
  readonly maxConcurrentTasks?: number
  readonly defaultPlanningMode?: 'auto' | 'require_confirmation'
  readonly planner: PlannerAdapter
  readonly execution: ExecutionAdapter
}

/** Minimal Cordis-compatible context required by the plugin. */
export interface RuntimeContext {
  longTaskRuntime?: LongTaskRuntime
  tools: { register(tool: { readonly name: string; execute(args: Record<string, unknown>): Promise<unknown> }): unknown }
}

/** Mount the long-task Runtime service and its stateless chat controls. */
export function apply(ctx: RuntimeContext, config: Config): void {
  const runtime = new LongTaskRuntime(config.planner, config.execution, config.maxConcurrentTasks ?? 1)
  ctx.longTaskRuntime = runtime
  ctx.tools.register({ name: 'long_task_create', async execute(args) {
    return runtime.createGoal({
      objective: String(args.objective),
      planningMode: args.planningMode === 'require_confirmation' ? 'require_confirmation' : config.defaultPlanningMode ?? 'auto',
    })
  } })
  ctx.tools.register({ name: 'long_task_confirm', async execute(args) { return runtime.confirmGoal(String(args.goalId)) } })
  ctx.tools.register({ name: 'long_task_status', async execute(args) { return runtime.getStatus(String(args.goalId)) } })
  ctx.tools.register({ name: 'long_task_cancel', async execute(args) { return runtime.cancelGoal(String(args.goalId)) } })
}
