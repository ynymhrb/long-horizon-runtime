import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDshExecutionAdapter, createDshPlannerAdapter, withDshParent } from './dsh-adapters.js';
import { LongTaskRuntime } from './runtime.js';
import { TaskControlApi } from './task-api.js';
import { filterRoutingTools, routingPolicyText } from './routing-policy.js';
export const name = 'long-task-runtime';
export const inject = ['tools', 'subagents', 'systemPrompt'];
/** Mount the runtime service and six stateless model-facing controls. */
export function apply(ctx, input) {
    const config = resolveConfig(input);
    const profile = config.defaultAgentProfile === undefined ? {} : { agentOptions: config.defaultAgentProfile };
    const planner = createDshPlannerAdapter(ctx.subagents, { providerName: config.plannerProvider, ...profile });
    const execution = createDshExecutionAdapter(ctx.subagents, { providerName: config.executionProvider, timeoutMs: config.maxWallTimeMs, ...profile });
    const runtime = config.runtimeFactory?.(planner, execution, config) ?? new LongTaskRuntime(planner, execution, {
        databasePath: config.databasePath, artifactDirectory: config.artifactDirectory, artifactInlineLimitBytes: config.artifactInlineLimitBytes, maxConcurrentTasks: config.maxConcurrentTasks, defaultRetryPolicy: config.retryPolicy, idleTimeoutMs: config.idleTimeoutMs, maxWallTimeMs: config.maxWallTimeMs, autoReplan: config.autoReplan ?? true,
    });
    ctx.provide('longTaskRuntime', runtime);
    ctx.systemPrompt.section({
        name: 'long-task:routing',
        order: 130,
        text: assembly => routingPolicyText(assembly.agent),
    });
    if (config.routingMode === 'strict') {
        ctx.on('system-prompt/assemble', async (assembly, context, next) => {
            const resolved = await next();
            return { ...resolved, tools: [...filterRoutingTools(config.routingMode, context.agent, resolved.tools)] };
        });
    }
    const taskApi = new TaskControlApi(runtime);
    ctx.effect(() => () => runtime.close(), 'long-task-runtime.close()');
    // Reconcile persisted attempts at activation. Execution itself remains tied to a later live tool parent.
    runtime.purgeExpiredArchives();
    void runtime.recover().catch(() => undefined);
    // This is deliberately not a lifecycle control. A child can prove liveness
    // only for its own session-bound attempt; it cannot inspect or mutate a goal.
    ctx.tools.register(defineTool({
        name: 'long_task_report_progress', description: 'Report compact execution progress for your own current long-task attempt. Call at meaningful phases and before/after long tool work; do not include raw logs or secrets.',
        parameters: { attempt_id: { type: 'string', required: true }, phase: { type: 'string', required: true }, message: { type: 'string', required: true }, completed: { type: 'number' }, total: { type: 'number' } }, output: toolOutput,
        execute: (args, exec) => toolValue(async () => {
            const agent = requireParent(exec.agent);
            runtime.reportAttemptProgress(String(agent.id), args.attempt_id, args.phase, args.message, args.completed, args.total);
            return { recorded: true };
        }),
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_create', description: 'Create and plan a durable long-running goal. With planning_mode "auto" execution begins immediately in the background and this call returns right away; poll long_task_status or long_task_events for progress. Use planning_mode "require_confirmation" to review the generated plan before execution.',
        parameters: { objective: { type: 'string', required: true }, constraints: { type: 'array', items: { type: 'string' } }, planning_mode: { type: 'string', enum: ['auto', 'require_confirmation'] } }, output: toolOutput,
        execute: (args, exec) => {
            const agent = requireParent(exec.agent);
            return toolValue(() => withDshParent(agent, async () => {
                const task = await taskApi.create({
                    objective: args.objective,
                    ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
                    planningMode: args.planning_mode ?? config.defaultPlanningMode,
                    ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
                }, {
                    sessionId: String(agent.id), signal: exec.signal,
                    ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
                });
                // Planning-only creation never runs inline; an auto-mode goal is
                // executed in the background so the tool call does not block the turn.
                if (task.state === 'RUNNING')
                    runtime.startBackground(task.id, agent);
                return task;
            }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_get', description: 'Read a long task by its durable lt_ task ID, including cross-session continuation state.', parameters: goalParameter, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.get(args.goal_id, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { task: null })),
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_update', description: 'Apply a compare-and-swap task action. On conflict, reread its current control revision before retrying. Confirm and resume start background execution and return immediately.',
        parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, action: { type: 'string', required: true, enum: ['confirm', 'resume', 'pause', 'cancel'] }, recovery_resolution: { type: 'string', enum: ['retry', 'confirmed_succeeded'] } }, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => {
            const result = await taskApi.update({ taskId: args.goal_id, expectedRevision: args.expected_revision, action: args.action, ...(args.recovery_resolution === undefined ? {} : { recoveryResolution: args.recovery_resolution }) }, { signal: exec.signal, ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }), ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) });
            // Confirming or resuming a plan must not block the turn for the whole
            // DAG; a live parent continues execution in the background.
            if (result.kind === 'applied' && (args.action === 'confirm' || args.action === 'resume') && result.task.state === 'RUNNING')
                runtime.startBackground(args.goal_id, exec.agent);
            return result;
        })),
    }));
    ctx.tools.register(defineTool({ name: 'long_task_confirm', description: 'Confirm a proposed plan and begin its durable execution in the background; returns immediately with the running task, poll long_task_status for progress.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => { if (exec.agent !== undefined)
            taskApi.continueInSession(args.goal_id, { sessionId: String(exec.agent.id), ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }); const goal = runtime.confirmGoal(args.goal_id); runtime.startBackground(args.goal_id, exec.agent); return goal; })) }));
    ctx.tools.register(defineTool({ name: 'long_task_status', description: 'Read a durable long-task goal status.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.getStatus(args.goal_id) ?? { goal: null })) }));
    ctx.tools.register(defineTool({ name: 'long_task_resume', description: 'Resume a paused or already-marked-running durable long-task goal and continue its execution in the background; returns immediately. An indeterminate external effect requires an explicit resolution.', parameters: { ...goalParameter, recovery_resolution: { type: 'string', enum: ['retry', 'confirmed_succeeded'] } }, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => { if (exec.agent !== undefined)
            taskApi.continueInSession(args.goal_id, { sessionId: String(exec.agent.id), ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }); const goal = await runtime.resumeGoal(args.goal_id, undefined, args.recovery_resolution); runtime.startBackground(args.goal_id, exec.agent); return goal; })) }));
    ctx.tools.register(defineTool({ name: 'long_task_cancel', description: 'Cancel a durable long-task goal without deleting its audit history.', parameters: goalParameter, output: toolOutput, execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.cancelGoal(args.goal_id))) }));
    ctx.tools.register(defineTool({
        name: 'long_task_events', description: 'Read a page of durable runtime events for a long task, oldest first, with a cursor for incremental polling. Payloads are compact summaries: context manifests and inline artifact content are excluded. Use this to observe what the scheduler and task children actually did (TaskAttemptStarted, ValidationRecorded, TaskCompleted, replan decisions, etc.).',
        parameters: { ...goalParameter, cursor: { type: 'number' }, limit: { type: 'number' }, task_id: { type: 'string' } }, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.listEvents({ taskId: args.goal_id, ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.task_id === undefined ? {} : { taskNodeId: args.task_id }) }, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { events: null })),
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_attempt_sessions', description: 'List the durable child session IDs of a long task\'s execution attempts. Each attempt ran in its own DSH session; return these IDs to the user so they can jump into and inspect the subagent\'s own conversation log.',
        parameters: { ...goalParameter, task_id: { type: 'string' } }, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => taskApi.listAttemptSessions({ taskId: args.goal_id, ...(args.task_id === undefined ? {} : { taskNodeId: args.task_id }) }, { ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }) ?? { attempts: null })),
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_invalidate', description: 'Invalidate one task and its reachable downstream work using recorded evidence.',
        parameters: { goal_id: { type: 'string', required: true }, task_id: { type: 'string', required: true }, reason: { type: 'string', required: true }, evidence_refs: { type: 'array', items: { type: 'string' } } }, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => runtime.invalidateTask(args.goal_id, args.task_id, args.reason, args.evidence_refs ?? []))),
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_edit_goal', description: 'Revise a task original goal and produce a confirmation-fenced replacement plan.',
        parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true }, objective: { type: 'string', required: true }, reason: { type: 'string', required: true } }, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, () => taskApi.editGoal({ taskId: args.goal_id, expectedRevision: args.expected_revision, objective: args.objective, reason: args.reason }, { parent: exec.agent, signal: exec.signal, ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) }))),
    }));
    ctx.tools.register(defineTool({
        name: 'long_task_accept_replan', description: 'Accept the current revision-fenced long-task replan proposal and continue execution in the background; returns immediately.',
        parameters: { goal_id: { type: 'string', required: true }, expected_revision: { type: 'number', required: true } }, output: toolOutput,
        execute: (args, exec) => toolValue(() => withParent(exec.agent, async () => {
            const result = await taskApi.acceptReplan({ taskId: args.goal_id, expectedRevision: args.expected_revision }, { signal: exec.signal, ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }) });
            if (result.kind === 'applied' && result.task.state === 'RUNNING')
                runtime.startBackground(args.goal_id, exec.agent);
            return result;
        })),
    }));
}
const goalParameter = { goal_id: { type: 'string', required: true } };
const toolOutput = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
function withParent(agent, work) {
    if (agent === undefined)
        return Promise.reject(new Error('long-task tools require a current parent Agent'));
    return withDshParent(agent, work);
}
function requireParent(agent) {
    if (agent === undefined)
        throw new Error('long-task tools require a current parent Agent');
    return agent;
}
/** Goal views contain only JSON values, but their narrow TypeScript shape lacks an index signature. */
async function toolValue(work) { return JSON.parse(JSON.stringify(await work())); }
function resolveConfig(config) {
    requiredText(config.databasePath, 'databasePath');
    requiredText(config.artifactDirectory, 'artifactDirectory');
    requiredText(config.plannerProvider, 'plannerProvider');
    requiredText(config.executionProvider, 'executionProvider');
    const maxConcurrentTasks = config.maxConcurrentTasks ?? 1;
    const executionTimeoutMs = config.executionTimeoutMs ?? 300_000;
    const idleTimeoutMs = config.idleTimeoutMs ?? executionTimeoutMs;
    const maxWallTimeMs = config.maxWallTimeMs ?? 18_000_000;
    const artifactInlineLimitBytes = config.artifactInlineLimitBytes ?? 65_536;
    const retryPolicy = config.retryPolicy ?? { maxAttempts: 1 };
    const routingMode = config.routingMode ?? 'advisory';
    if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)
        throw new TypeError('maxConcurrentTasks must be a positive safe integer');
    if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1)
        throw new TypeError('executionTimeoutMs must be a positive safe integer');
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1)
        throw new TypeError('idleTimeoutMs must be a positive safe integer');
    if (!Number.isSafeInteger(maxWallTimeMs) || maxWallTimeMs < idleTimeoutMs)
        throw new TypeError('maxWallTimeMs must be a positive safe integer no smaller than idleTimeoutMs');
    if (!Number.isSafeInteger(artifactInlineLimitBytes) || artifactInlineLimitBytes < 0)
        throw new TypeError('artifactInlineLimitBytes must be a non-negative safe integer');
    if (!Number.isSafeInteger(retryPolicy.maxAttempts) || retryPolicy.maxAttempts < 1)
        throw new TypeError('retryPolicy.maxAttempts must be a positive safe integer');
    const defaultPlanningMode = config.defaultPlanningMode ?? 'auto';
    if (defaultPlanningMode !== 'auto' && defaultPlanningMode !== 'require_confirmation')
        throw new TypeError('defaultPlanningMode must be auto or require_confirmation');
    if (routingMode !== 'advisory' && routingMode !== 'strict')
        throw new TypeError('routingMode must be advisory or strict');
    return { ...config, maxConcurrentTasks, executionTimeoutMs, idleTimeoutMs, maxWallTimeMs, artifactInlineLimitBytes, retryPolicy, defaultPlanningMode, routingMode };
}
function requiredText(value, name) { if (value.trim().length === 0)
    throw new TypeError(`${name} must be non-empty`); }
