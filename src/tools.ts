import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDshExecutionAdapter, createDshPlannerAdapter, withDshParent } from './dsh-adapters.js'
import { LongTaskRuntime } from './runtime.js'
import { TaskControlApi } from './task-api.js'

/** Deployment configuration supplied from cordis.yml. Every operational knob is validated at activation. */
export interface Config {
  readonly databasePath: string
  readonly artifactDirectory: string
  readonly plannerProvider: string
  readonly executionProvider: string
  readonly maxConcurrentTasks?: number
  readonly defaultPlanningMode?: 'auto' | 'require_confirmation'
  readonly executionTimeoutMs?: number
  readonly retryPolicy?: { readonly maxAttempts: number }
  readonly artifactInlineLimitBytes?: number
  /** Profile-local compatibility scope for tasks resumed from another chat. */
  readonly workspaceScope?: string
  readonly defaultAgentProfile?: Record<string, unknown>
  /** Test/composition seam; normal deployments use the configured DSH adapters. */
  readonly runtimeFactory?: (planner: ReturnType<typeof createDshPlannerAdapter>, execution: ReturnType<typeof createDshExecutionAdapter>, config: ResolvedConfig) => LongTaskRuntime
}

interface ResolvedConfig extends Omit<Config, 'maxConcurrentTasks' | 'defaultPlanningMode' | 'executionTimeoutMs' | 'retryPolicy' | 'artifactInlineLimitBytes'> {
  readonly maxConcurrentTasks: number
  readonly defaultPlanningMode: 'auto' | 'require_confirmation'
  readonly executionTimeoutMs: number
  readonly retryPolicy: { readonly maxAttempts: number }
  readonly artifactInlineLimitBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { longTaskRuntime: LongTaskRuntime }
}

export const name = 'long-task-runtime'
export const inject = ['tools', 'subagents']

/** Mount the runtime service and six stateless model-facing controls. */
export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input)
  const profile = config.defaultAgentProfile === undefined ? {} : { agentOptions: config.defaultAgentProfile }
  const planner = createDshPlannerAdapter(ctx.subagents, { providerName: config.plannerProvider, ...profile })
  const execution = createDshExecutionAdapter(ctx.subagents, { providerName: config.executionProvider, timeoutMs: config.executionTimeoutMs, ...profile })
  const runtime = config.runtimeFactory?.(planner, execution, config) ?? new LongTaskRuntime(planner, execution, {
    databasePath: config.databasePath, artifactDirectory: config.artifactDirectory, artifactInlineLimitBytes: config.artifactInlineLimitBytes, maxConcurrentTasks: config.maxConcurrentTasks, defaultRetryPolicy: config.retryPolicy,
  })
  ctx.provide('longTaskRuntime', runtime)
  const taskApi = new TaskControlApi(runtime)
  ctx.effect(() => () => runtime.close(), 'long-task-runtime.close()')
  // Reconcile persisted attempts at activation. Execution itself remains tied to a later live tool parent.
  void runtime.recover().catch(() => undefined)

  ctx.tools.register(defineTool({
    name: 'long_task_create', description: 'Create and plan a durable long-running goal.',
    parameters: { objective: { type: 'string', required: true }, constraints: { type: 'array', items: { type: 'string' } }, planning_mode: { type: 'string', enum: ['auto', 'require_confirmation'] } }, output: toolOutput,
    execute: (args, exec) => {
      const agent = requireParent(exec.agent)
      return toolValue(() => withDshParent(agent, () => taskApi.create({
        objective: args.objective,
        ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
        planningMode: args.planning_mode ?? config.defaultPlanningMode,
        ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
      }, {
        sessionId: String(agent.id), parent: agent, signal: exec.signal,
        ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
      })))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_get', description: 'Read a long task by its durable lt_ task ID, including cross-session continuation state.', parameters: goalParameter, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.get(args.goal_id, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { task: null })),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_update', description: 'Apply a compare-and-swap task action. On conflict, reread its current control revision before retrying.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, action: { type: 'string', required: true, enum: ['confirm', 'resume', 'pause', 'cancel'] }, recovery_resolution: { type: 'string', enum: ['retry', 'confirmed_succeeded'] } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, () => taskApi.update({ taskId: args.goal_id, expectedRevision: args.expected_revision, action: args.action as 'confirm' | 'resume' | 'pause' | 'cancel', ...(args.recovery_resolution === undefined ? {} : { recoveryResolution: args.recovery_resolution }) }, { parent: exec.agent, signal: exec.signal, ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }))),
  }))
  ctx.tools.register(defineTool({ name: 'long_task_confirm', description: 'Confirm a proposed plan and begin its durable execution.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, () => runtime.confirmGoal(args.goal_id, exec.agent, exec.signal))) }))
  ctx.tools.register(defineTool({ name: 'long_task_status', description: 'Read a durable long-task goal status.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.getStatus(args.goal_id) ?? { goal: null })) }))
  ctx.tools.register(defineTool({ name: 'long_task_resume', description: 'Resume a paused durable long-task goal. An indeterminate external effect requires an explicit resolution.', parameters: { ...goalParameter, recovery_resolution: { type: 'string', enum: ['retry', 'confirmed_succeeded'] } }, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, () => runtime.resumeGoal(args.goal_id, exec.agent, args.recovery_resolution, exec.signal))) }))
  ctx.tools.register(defineTool({ name: 'long_task_cancel', description: 'Cancel a durable long-task goal without deleting its audit history.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.cancelGoal(args.goal_id))) }))
  ctx.tools.register(defineTool({
    name: 'long_task_invalidate', description: 'Invalidate one task and its reachable downstream work using recorded evidence.',
    parameters: { goal_id: { type: 'string', required: true }, task_id: { type: 'string', required: true }, reason: { type: 'string', required: true }, evidence_refs: { type: 'array', items: { type: 'string' } } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.invalidateTask(args.goal_id, args.task_id, args.reason, args.evidence_refs ?? []))),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_edit_goal', description: 'Revise a task original goal and produce a confirmation-fenced replacement plan.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, objective: { type: 'string', required: true }, reason: { type: 'string', required: true } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, () => taskApi.editGoal({ taskId: args.goal_id, expectedRevision: args.expected_revision, objective: args.objective, reason: args.reason }, { parent: exec.agent, signal: exec.signal, ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }))),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_accept_replan', description: 'Accept the current revision-fenced long-task replan proposal.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, () => taskApi.acceptReplan({ taskId: args.goal_id, expectedRevision: args.expected_revision }, { parent: exec.agent, signal: exec.signal, ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }))),
  }))
}

const goalParameter = { goal_id: { type: 'string', required: true } } as const
const toolOutput = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

function withParent<T>(agent: Agent | undefined, work: () => Promise<T>): Promise<T> {
  if (agent === undefined) return Promise.reject(new Error('long-task tools require a current parent Agent'))
  return withDshParent(agent, work)
}

function requireParent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('long-task tools require a current parent Agent')
  return agent
}

/** Goal views contain only JSON values, but their narrow TypeScript shape lacks an index signature. */
async function toolValue<T>(work: () => Promise<T>): Promise<any> { return JSON.parse(JSON.stringify(await work())) }

function resolveConfig(config: Config): ResolvedConfig {
  requiredText(config.databasePath, 'databasePath'); requiredText(config.artifactDirectory, 'artifactDirectory'); requiredText(config.plannerProvider, 'plannerProvider'); requiredText(config.executionProvider, 'executionProvider')
  const maxConcurrentTasks = config.maxConcurrentTasks ?? 1
  const executionTimeoutMs = config.executionTimeoutMs ?? 300_000
  const artifactInlineLimitBytes = config.artifactInlineLimitBytes ?? 65_536
  const retryPolicy = config.retryPolicy ?? { maxAttempts: 1 }
  if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) throw new TypeError('maxConcurrentTasks must be a positive safe integer')
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1) throw new TypeError('executionTimeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(artifactInlineLimitBytes) || artifactInlineLimitBytes < 0) throw new TypeError('artifactInlineLimitBytes must be a non-negative safe integer')
  if (!Number.isSafeInteger(retryPolicy.maxAttempts) || retryPolicy.maxAttempts < 1) throw new TypeError('retryPolicy.maxAttempts must be a positive safe integer')
  const defaultPlanningMode = config.defaultPlanningMode ?? 'auto'
  if (defaultPlanningMode !== 'auto' && defaultPlanningMode !== 'require_confirmation') throw new TypeError('defaultPlanningMode must be auto or require_confirmation')
  return { ...config, maxConcurrentTasks, executionTimeoutMs, artifactInlineLimitBytes, retryPolicy, defaultPlanningMode }
}

function requiredText(value: string, name: string): void { if (value.trim().length === 0) throw new TypeError(`${name} must be non-empty`) }
