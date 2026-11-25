import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDshExecutionAdapter, createDshPlannerAdapter, withDshParent } from './dsh-adapters.js'
import { LongTaskRuntime } from './runtime.js'
import { TaskControlApi } from './task-api.js'
import { filterRoutingTools, routingPolicyText, type RoutingMode } from './routing-policy.js'
import { normalizeExecutionProfiles, ProfileRouter, type ExecutionProfile, type ExecutionProfileSet } from './execution-profiles.js'
import { ExecutionPolicy, type PolicyMode } from './execution-policy.js'
import { CallRouter, type ModelEndpoint, type ToolConcurrency } from './call-routing.js'
import { WorkerPool } from './worker-pool.js'
import { createProcessWorker, type ProcessWorkerConfig } from './process-worker.js'
import { parseWorkflow, type WorkflowSpec } from './workflow.js'

export type WorkerConfig = (
  | { readonly kind: 'dsh'; readonly modelRole?: string }
  | ProcessWorkerConfig
) & { readonly id: string; readonly maxConcurrent: number; readonly capabilities?: readonly string[] }

/** Deployment configuration supplied from cordis.yml. Every operational knob is validated at activation. */
export interface Config {
  readonly databasePath: string
  readonly artifactDirectory: string
  readonly plannerProvider: string
  readonly executionProvider: string
  readonly maxConcurrentTasks?: number
  readonly workers?: readonly WorkerConfig[]
  readonly modelEndpoints?: readonly ModelEndpoint[]
  readonly toolConcurrency?: readonly ToolConcurrency[]
  readonly workflowTemplates?: Readonly<Record<string, WorkflowSpec>>
  readonly defaultWorkflow?: string
  readonly defaultPlanningMode?: 'auto' | 'require_confirmation'
  readonly executionTimeoutMs?: number
  /** Maximum no-progress interval; legacy executionTimeoutMs remains accepted for compatibility. */
  readonly idleTimeoutMs?: number
  /** Maximum wall time of one child attempt; defaults to five hours. */
  readonly maxWallTimeMs?: number
  readonly retryPolicy?: { readonly maxAttempts: number }
  readonly artifactInlineLimitBytes?: number
  readonly autoReplan?: boolean
  readonly routingMode?: RoutingMode
  /** Profile-local compatibility scope for tasks resumed from another chat. */
  readonly workspaceScope?: string
  readonly defaultAgentProfile?: Record<string, unknown>
  /** Explicit worker profiles; omitted keeps the historic single spawn worker. */
  readonly executionProfiles?: readonly ExecutionProfile[]
  readonly defaultExecutionProfile?: string
  readonly policyMode?: PolicyMode
  /** Test/composition seam; normal deployments use the configured DSH adapters. */
  readonly runtimeFactory?: (planner: ReturnType<typeof createDshPlannerAdapter>, execution: ReturnType<typeof createDshExecutionAdapter>, config: ResolvedConfig) => LongTaskRuntime
}

interface ResolvedConfig extends Omit<Config, 'maxConcurrentTasks' | 'defaultPlanningMode' | 'executionTimeoutMs' | 'idleTimeoutMs' | 'maxWallTimeMs' | 'retryPolicy' | 'artifactInlineLimitBytes' | 'executionProfiles' | 'defaultExecutionProfile' | 'policyMode' | 'workflowTemplates'> {
  readonly maxConcurrentTasks: number
  readonly workflowTemplates: ReadonlyMap<string, WorkflowSpec>
  readonly defaultPlanningMode: 'auto' | 'require_confirmation'
  readonly executionTimeoutMs: number
  readonly idleTimeoutMs: number
  readonly maxWallTimeMs: number
  readonly retryPolicy: { readonly maxAttempts: number }
  readonly artifactInlineLimitBytes: number
  readonly routingMode: RoutingMode
  readonly executionProfiles: ExecutionProfileSet
  readonly policyMode: PolicyMode
}

declare module '@deepseek-ai/cordis' {
  interface Context { longTaskRuntime: LongTaskRuntime }
}

export const name = 'long-task-runtime'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Mount the runtime service and six stateless model-facing controls. */
export function apply(ctx: Context, input: Config): void {
  const config = resolveConfig(input)
  const router = (config.modelEndpoints?.length || config.toolConcurrency?.length)
    ? new CallRouter(config.modelEndpoints ?? [], config.toolConcurrency ?? []) : undefined
  const profile = config.defaultAgentProfile === undefined ? {} : { agentOptions: config.defaultAgentProfile }
  const planner = createDshPlannerAdapter(ctx.subagents, { providerName: config.plannerProvider, ...profile, ...(router === undefined ? {} : { callRouter: router }) })
  const execution = createDshExecutionAdapter(ctx.subagents, { providerName: config.executionProvider, timeoutMs: config.maxWallTimeMs, ...profile, ...(router === undefined ? {} : { callRouter: router }) })
  const declaredWorkers = config.workers ?? []
  const workers = declaredWorkers.some(worker => worker.id === 'dsh')
    ? declaredWorkers : [{ kind: 'dsh' as const, id: 'dsh', maxConcurrent: config.maxConcurrentTasks }, ...declaredWorkers]
  const pool = new WorkerPool(config.maxConcurrentTasks, workers.map(worker => ({
    id: worker.id, maxConcurrent: worker.maxConcurrent,
    ...(worker.kind === 'dsh' ? { adapter: execution } : { adapter: createProcessWorker(worker), workspaceKey: processWorkspaceKey(worker.cwd) }),
  })))
  router?.install(ctx)
  const runtime = config.runtimeFactory?.(planner, execution, config) ?? new LongTaskRuntime(planner, execution, {
    databasePath: config.databasePath, artifactDirectory: config.artifactDirectory, artifactInlineLimitBytes: config.artifactInlineLimitBytes, maxConcurrentTasks: config.maxConcurrentTasks, workerPool: pool, defaultRetryPolicy: config.retryPolicy, idleTimeoutMs: config.idleTimeoutMs, maxWallTimeMs: config.maxWallTimeMs, autoReplan: config.autoReplan ?? true, profileRouter: new ProfileRouter(config.executionProfiles), ...(config.policyMode === 'evaluated' ? { executionPolicy: new ExecutionPolicy('evaluated') } : {}),
  })
  ctx.provide('longTaskRuntime', runtime)
  ctx.systemPrompt.section({
    name: 'long-task:routing',
    order: 130,
    text: assembly => {
      const base = routingPolicyText(assembly.agent)
      if (base === '') return base
      const templates = [...config.workflowTemplates.keys()].join(', ') || '无'
      const profiles = [...config.executionProfiles.profiles.keys()].join(', ')
      return base + '\n用户指定流程、评审退回或轮流讨论时，long_task_create 接受 workflow_template 或 orchestration_json。只使用已注册的执行配置：' + profiles + '。流程模板：' + templates + '。'
    },
  })
  if (config.routingMode === 'strict') {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const resolved = await next()
      return { ...resolved, tools: [...filterRoutingTools(config.routingMode, context.agent, resolved.tools)] }
    })
  }
  const taskApi = new TaskControlApi(runtime)
  ctx.effect(() => () => runtime.close(), 'long-task-runtime.close()')
  // Reconcile persisted attempts at activation. Execution itself remains tied to a later live tool parent.
  runtime.purgeExpiredArchives()
  void runtime.recover().catch(() => undefined)

  // This is deliberately not a lifecycle control. A child can prove liveness
  // only for its own session-bound attempt; it cannot inspect or mutate a goal.
  ctx.tools.register(defineTool({
    name: 'long_task_report_progress', description: 'Report compact execution progress for your own current long-task attempt. Call at meaningful phases and before/after long tool work; do not include raw logs or secrets.',
    parameters: { attempt_id: { type: 'string', required: true }, phase: { type: 'string', required: true }, message: { type: 'string', required: true }, completed: { type: 'number' }, total: { type: 'number' } }, output: toolOutput,
    execute: (args, exec) => toolValue(async () => {
      const agent = requireParent(exec.agent)
      runtime.reportAttemptProgress(String(agent.id), args.attempt_id, args.phase, args.message, args.completed, args.total)
      return { recorded: true }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'long_task_create', description: 'Create and plan a durable long-running goal. With planning_mode "auto" execution begins immediately in the background and this call returns right away; poll long_task_status or long_task_events for progress. Use planning_mode "require_confirmation" to review the generated plan before execution.',
    parameters: {
      objective: { type: 'string' },
      // qwen3.5:4b emits a task-description shape for this tool. Accept its
      // description field as a backwards-compatible objective alias.
      description: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' } },
      planning_mode: { type: 'string', enum: ['auto', 'require_confirmation'] },
      workflow_template: { type: 'string', description: '已注册的流程模板 ID，dynamic 表示使用动态规划' },
      orchestration_json: { type: 'string', description: '完整流程 JSON。mode=workflow 时包含 entry 与 stages（id/objective/profile/next/onChangesRequested/maxVisits/sideEffectClass）；mode=discussion 时包含 participants（执行配置 ID 或含 id/profile/instruction 的角色对象）、rounds、moderator 和可选 convergence。与 workflow_template 二选一。' },
    }, output: toolOutput,
    execute: (args, exec) => {
      const agent = requireParent(exec.agent)
      return toolValue(() => withDshParent(agent, async () => {
        const objective = createObjective(args)
        const orchestration = resolveOrchestration(config, args.workflow_template, args.orchestration_json)
        const task = await taskApi.create({
          objective,
          ...(orchestration === undefined ? {} : { orchestration }),
          ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
          planningMode: args.planning_mode ?? config.defaultPlanningMode,
          ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
        }, {
          sessionId: String(agent.id), signal: exec.signal,
          ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
        })
        // Planning-only creation never runs inline; an auto-mode goal is
        // executed in the background so the tool call does not block the turn.
        if (task.state === 'RUNNING') runtime.startBackground(task.id, agent)
        return task
      }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_get', description: 'Read a long task by its durable lt_ task ID, including cross-session continuation state.', parameters: goalParameter, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.get(args.goal_id, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { task: null })),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_update', description: 'Apply a compare-and-swap task action. On conflict, reread its current control revision before retrying. Confirm and resume start background execution and return immediately.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, action: { type: 'string', required: true, enum: ['confirm', 'resume', 'pause', 'cancel'] }, recovery_resolution: { type: 'string', enum: ['retry', 'confirmed_succeeded'] } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => {
      const result = await taskApi.update({ taskId: args.goal_id, expectedRevision: args.expected_revision, action: args.action as 'confirm' | 'resume' | 'pause' | 'cancel', ...(args.recovery_resolution === undefined ? {} : { recoveryResolution: args.recovery_resolution }) }, { signal: exec.signal, ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }), ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) })
      // Confirming or resuming a plan must not block the turn for the whole
      // DAG; a live parent continues execution in the background.
      if (result.kind === 'applied' && (args.action === 'confirm' || args.action === 'resume') && result.task.state === 'RUNNING') runtime.startBackground(args.goal_id, exec.agent)
      return result
    })),
  }))
  ctx.tools.register(defineTool({ name: 'long_task_confirm', description: 'Confirm a proposed plan and begin its durable execution in the background; returns immediately with the running task, poll long_task_status for progress.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => { if (exec.agent !== undefined) taskApi.continueInSession(args.goal_id, { sessionId: String(exec.agent.id), ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }); const goal = runtime.confirmGoal(args.goal_id); runtime.startBackground(args.goal_id, exec.agent); return goal })) }))
  ctx.tools.register(defineTool({
    name: 'long_task_propose_workflow',
    description: '为已暂停的配置流程提出新修订，保留所有已完成阶段。请用户在任务区确认。',
    parameters: {
      goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true },
      reason: { type: 'string', required: true }, workflow_template: { type: 'string' }, orchestration_json: { type: 'string' },
    },
    output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => {
      if (args.workflow_template === undefined && args.orchestration_json === undefined) throw new Error('请提供新流程')
      const spec = resolveOrchestration(config, args.workflow_template, args.orchestration_json)
      if (spec === undefined) throw new Error('流程修订需要声明式流程或讨论定义')
      return taskApi.proposeWorkflow({ taskId: args.goal_id, expectedRevision: args.expected_revision, spec, reason: args.reason }, {
        ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
      })
    })),
  }))
  ctx.tools.register(defineTool({ name: 'long_task_status', description: 'Read a durable long-task goal status.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.getStatus(args.goal_id) ?? { goal: null })) }))
  ctx.tools.register(defineTool({ name: 'long_task_resume', description: 'Resume a paused or already-marked-running durable long-task goal and continue its execution in the background; returns immediately. An indeterminate external effect requires an explicit resolution. A goal paused by the user must be resumed by the user from the task area; this call is rejected in that case.', parameters: { ...goalParameter, recovery_resolution: { type: 'string', enum: ['retry', 'confirmed_succeeded'] } }, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => { if (exec.agent !== undefined) taskApi.continueInSession(args.goal_id, { sessionId: String(exec.agent.id), ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }); const goal = await runtime.resumeGoal(args.goal_id, undefined, args.recovery_resolution); runtime.startBackground(args.goal_id, exec.agent); return goal })) }))
  ctx.tools.register(defineTool({ name: 'long_task_cancel', description: 'Cancel a durable long-task goal without deleting its audit history.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.cancelGoal(args.goal_id))) }))
  ctx.tools.register(defineTool({
    name: 'long_task_events', description: 'Read a page of durable runtime events for a long task, oldest first, with a cursor for incremental polling. Payloads are compact summaries: context manifests and inline artifact content are excluded. Use this to observe what the scheduler and task children actually did (TaskAttemptStarted, ValidationRecorded, TaskCompleted, replan decisions, etc.).',
    parameters: { ...goalParameter, cursor: { type: 'number' }, limit: { type: 'number' }, task_id: { type: 'string' } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.listEvents({ taskId: args.goal_id, ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.task_id === undefined ? {} : { taskNodeId: args.task_id }) }, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { events: null })),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_attempt_sessions', description: 'List the durable child session IDs of a long task\'s execution attempts. Each attempt ran in its own DSH session; return these IDs to the user so they can jump into and inspect the subagent\'s own conversation log.',
    parameters: { ...goalParameter, task_id: { type: 'string' } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.listAttemptSessions({ taskId: args.goal_id, ...(args.task_id === undefined ? {} : { taskNodeId: args.task_id }) }, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { attempts: null })),
  }))
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
    name: 'long_task_accept_replan', description: 'Accept the current revision-fenced long-task replan proposal and continue execution in the background; returns immediately.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => {
      const result = await taskApi.acceptReplan({ taskId: args.goal_id, expectedRevision: args.expected_revision }, { signal: exec.signal, ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) })
      if (result.kind === 'applied' && result.task.state === 'RUNNING') runtime.startBackground(args.goal_id, exec.agent)
      return result
    })),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_extend_budget', description: 'Increase a durable task budget using the displayed control revision. Budget limits may only increase.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, limit: { type: 'object', required: true, properties: { max_attempts: { type: 'number' }, max_wall_time_ms: { type: 'number' }, max_estimated_tokens: { type: 'number' }, max_estimated_cost_micros: { type: 'number' } }, additionalProperties: false } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.extendBudget({ taskId: args.goal_id, expectedRevision: args.expected_revision, limit: { ...(args.limit.max_attempts === undefined ? {} : { maxAttempts: args.limit.max_attempts }), ...(args.limit.max_wall_time_ms === undefined ? {} : { maxWallTimeMs: args.limit.max_wall_time_ms }), ...(args.limit.max_estimated_tokens === undefined ? {} : { maxEstimatedTokens: args.limit.max_estimated_tokens }), ...(args.limit.max_estimated_cost_micros === undefined ? {} : { maxEstimatedCostMicros: args.limit.max_estimated_cost_micros }) } }, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }))),
  }))
  ctx.tools.register(defineTool({
    name: 'long_task_record_memory_feedback', description: 'Record revision-fenced user or validator feedback about one memory retrieval. This creates an audit record only and never changes ranking automatically.',
    parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, memory_id: { type: 'string', required: true }, helpful: { type: 'boolean', required: true }, reason: { type: 'string', required: true } }, output: toolOutput,
    execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.recordMemoryRetrievalFeedback({ taskId: args.goal_id, expectedRevision: args.expected_revision, memoryId: args.memory_id, helpful: args.helpful, reason: args.reason }, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }))),
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

/** Normalize the canonical field and the local-model task-description alias. */
function createObjective(args: Record<string, unknown>): string {
  for (const value of [args.objective, args.description]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  throw new TypeError('long_task_create requires a non-empty objective or description')
}

/** Goal views contain only JSON values, but their narrow TypeScript shape lacks an index signature. */
async function toolValue<T>(work: () => Promise<T>): Promise<any> { return JSON.parse(JSON.stringify(await work())) }

function resolveConfig(config: Config): ResolvedConfig {
  requiredText(config.databasePath, 'databasePath'); requiredText(config.artifactDirectory, 'artifactDirectory'); requiredText(config.plannerProvider, 'plannerProvider'); requiredText(config.executionProvider, 'executionProvider')
  const maxConcurrentTasks = config.maxConcurrentTasks ?? 1
  const executionTimeoutMs = config.executionTimeoutMs ?? 300_000
  const idleTimeoutMs = config.idleTimeoutMs ?? executionTimeoutMs
  const maxWallTimeMs = config.maxWallTimeMs ?? 18_000_000
  const artifactInlineLimitBytes = config.artifactInlineLimitBytes ?? 65_536
  const retryPolicy = config.retryPolicy ?? { maxAttempts: 1 }
  const routingMode = config.routingMode ?? 'advisory'
  const policyMode = config.policyMode ?? 'fixed'
  if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) throw new TypeError('maxConcurrentTasks must be a positive safe integer')
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1) throw new TypeError('executionTimeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new TypeError('idleTimeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(maxWallTimeMs) || maxWallTimeMs < idleTimeoutMs) throw new TypeError('maxWallTimeMs must be a positive safe integer no smaller than idleTimeoutMs')
  if (!Number.isSafeInteger(artifactInlineLimitBytes) || artifactInlineLimitBytes < 0) throw new TypeError('artifactInlineLimitBytes must be a non-negative safe integer')
  if (!Number.isSafeInteger(retryPolicy.maxAttempts) || retryPolicy.maxAttempts < 1) throw new TypeError('retryPolicy.maxAttempts must be a positive safe integer')
  const defaultPlanningMode = config.defaultPlanningMode ?? 'auto'
  if (defaultPlanningMode !== 'auto' && defaultPlanningMode !== 'require_confirmation') throw new TypeError('defaultPlanningMode must be auto or require_confirmation')
  if (routingMode !== 'advisory' && routingMode !== 'strict') throw new TypeError('routingMode must be advisory or strict')
  if (policyMode !== 'fixed' && policyMode !== 'evaluated') throw new TypeError('policyMode must be fixed or evaluated')
  const configuredProfiles: readonly ExecutionProfile[] = config.executionProfiles ?? [{
    id: 'default', providerName: config.executionProvider, ...(config.defaultAgentProfile === undefined ? {} : { agentOptions: config.defaultAgentProfile }),
  }]
  const workerMap = new Map((config.workers ?? []).map(worker => [worker.id, worker]))
  for (const worker of workerMap.values()) if (!['dsh', 'codex-cli', 'claude-cli', 'custom-exec'].includes(worker.kind)) throw new Error('未知 Worker 类型：' + worker.kind)
  const aliases = [...workerMap.values()].filter(worker => !configuredProfiles.some(profile => profile.id === worker.id))
    .map(worker => ({ id: worker.id, providerName: config.executionProvider, workerIds: [worker.id], ...(worker.kind === 'dsh' && worker.modelRole !== undefined ? { modelRole: worker.modelRole } : {}), ...(worker.capabilities === undefined ? {} : { capabilities: worker.capabilities }) }))
  const executionProfiles = normalizeExecutionProfiles({
    ...(config.defaultExecutionProfile === undefined ? {} : { defaultProfile: config.defaultExecutionProfile }),
    profiles: [...configuredProfiles, ...aliases],
  })
  for (const profile of executionProfiles.profiles.values()) {
    if (profile.modelRole !== undefined && !config.modelEndpoints?.some(endpoint => endpoint.roles.includes(profile.modelRole!))) {
      throw new Error('执行配置引用未注册的模型角色：' + profile.modelRole)
    }
    for (const id of profile.workerIds ?? ['dsh']) {
      const worker = workerMap.get(id)
      if (worker === undefined && id !== 'dsh') throw new Error('执行配置引用未知 Worker：' + id)
      if (worker === undefined || worker.kind === 'dsh') continue
      if (profile.modelRole !== undefined) throw new Error('外部 Worker 不支持插件的模型角色路由：' + id)
      if ((profile.toolDeny?.length ?? 0) > 0) throw new Error('外部 Worker 无法应用 DSH 工具拒绝列表：' + id)
      if (profile.capabilities?.some(capability => !worker.capabilities?.includes(capability)) === true) throw new Error('Worker 缺少执行配置声明的能力：' + id)
    }
  }
  const profileIds = [...executionProfiles.profiles.keys()]
  const workflowTemplates = new Map(Object.entries(config.workflowTemplates ?? {}).map(([id, value]) => {
    if (id.trim() === '' || id === 'dynamic') throw new Error('无效的流程模板 ID：' + id)
    return [id, parseWorkflow(value, profileIds)] as const
  }))
  if (config.defaultWorkflow !== undefined && config.defaultWorkflow !== 'dynamic' && !workflowTemplates.has(config.defaultWorkflow)) throw new Error('未知默认流程模板：' + config.defaultWorkflow)
  return { ...config, maxConcurrentTasks, executionTimeoutMs, idleTimeoutMs, maxWallTimeMs, artifactInlineLimitBytes, retryPolicy, defaultPlanningMode, routingMode, policyMode, executionProfiles, workflowTemplates }
}

function resolveOrchestration(config: ResolvedConfig, requested?: string, json?: string): WorkflowSpec | undefined {
  if (requested !== undefined && json !== undefined) throw new Error('workflow_template 和 orchestration_json 只能使用一个')
  if (json !== undefined) {
    if (json.length > 100_000) throw new Error('流程配置过长')
    return parseWorkflow(JSON.parse(json), [...config.executionProfiles.profiles.keys()])
  }
  const id = requested ?? config.defaultWorkflow
  if (id === undefined || id === 'dynamic') return undefined
  const workflow = config.workflowTemplates.get(id)
  if (workflow === undefined) throw new Error('未知流程模板：' + id)
  return workflow
}

function processWorkspaceKey(cwd: string): string {
  let path: string
  try { path = realpathSync.native(cwd) }
  catch { path = resolve(cwd) }
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function requiredText(value: string, name: string): void { if (value.trim().length === 0) throw new TypeError(`${name} must be non-empty`) }
