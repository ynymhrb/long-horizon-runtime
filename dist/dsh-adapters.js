/** DSH one-shot child adapters. They translate DSH transport results into the durable-core contracts. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { V1_ARTIFACT_TYPES } from './domain.js';
import { CHILD_TASK_TOOL_DENY } from './routing-policy.js';
const parents = new AsyncLocalStorage();
/** Bind a model-facing tool invocation's Agent to child starts made during its async work. */
export function withDshParent(parent, work) {
    if (parent === undefined || parent === null)
        throw new Error('long-task DSH execution requires a current parent Agent');
    return parents.run(parent, work);
}
function currentParent() {
    const parent = parents.getStore();
    if (parent === undefined)
        throw new Error('long-task DSH execution requires a current parent Agent');
    return parent;
}
const PLAN_SCHEMA = {
    type: 'object', properties: {
        revision: { type: 'integer' },
        tasks: {
            type: 'array', items: {
                type: 'object', properties: {
                    id: { type: 'string' }, objective: { type: 'string' }, summary: { type: 'string' },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                    priority: { type: 'number' },
                    inputContract: { type: 'object' }, outputContract: { type: 'object' },
                    completionCriteria: { type: 'string' },
                    retryPolicy: { type: 'object', properties: { maxAttempts: { type: 'integer' } }, required: ['maxAttempts'], additionalProperties: false },
                    sideEffectClass: { type: 'string', enum: ['read_only', 'idempotent', 'external_effect'] }, validator: { type: 'string' },
                    timeoutMs: { type: 'integer' },
                }, required: ['id', 'objective', 'summary', 'dependsOn', 'priority', 'inputContract', 'outputContract', 'completionCriteria', 'retryPolicy', 'sideEffectClass', 'validator'], additionalProperties: false,
            },
        },
    }, required: ['revision', 'tasks'], additionalProperties: false,
};
const RESULT_SCHEMA = {
    type: 'object', properties: {
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: V1_ARTIFACT_TYPES }, content: { type: 'string' }, mimeType: { type: 'string' } }, required: ['type', 'content'], additionalProperties: false } },
        evidence: { type: 'array', items: { type: 'string' } },
    }, required: ['summary', 'artifacts', 'evidence'], additionalProperties: false,
};
/** Build an initial-plan adapter backed by a configured DSH one-shot provider. */
export function createDshPlannerAdapter(subagents, options) {
    requireProviderName(options.providerName);
    return {
        async plan(input) {
            const result = await runStructured(subagents, options, 'Long-task planner', `${plannerPrompt(input)}\nEvery task summary must be concise and no more than 100 characters.`, PLAN_SCHEMA, input.signal);
            if (result.stopReason !== 'completed')
                throw new Error(`DSH planner stopped: ${result.stopReason}`);
            const value = objectValue(result.value, 'planner');
            return { goalId: input.goalId, revision: integer(value.revision, 'planner revision'), tasks: array(value.tasks, 'planner tasks') };
        },
    };
}
/** Build an isolated task-attempt adapter backed by a configured DSH one-shot provider. */
export function createDshExecutionAdapter(subagents, options) {
    requireProviderName(options.providerName);
    const liveAttempts = new Map();
    return {
        async execute(input) {
            // A per-task timeoutMs overrides the deployment default, which itself
            // overrides an absent timeout. Distinguish a timeout abort from an
            // operator/other abort so the failure summary is actionable.
            const timeoutMs = input.timeoutMs ?? options.timeoutMs;
            const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
            const signal = timeout === undefined ? input.signal : AbortSignal.any([input.signal, timeout]);
            let settled;
            let dshSessionId;
            try {
                try {
                    settled = await runStructured(subagents, options, `Long-task attempt ${input.attemptId}`, executionPrompt(input), RESULT_SCHEMA, signal, sessionId => { dshSessionId = sessionId; liveAttempts.set(input.attemptId, sessionId); input.onSessionId?.(sessionId); }, timeoutMs);
                }
                catch (error) {
                    // The seam could not represent the outcome as a stop reason: an
                    // infrastructure fault. A conversation stop through the caller signal
                    // is an interruption, not a failure.
                    const failure = error;
                    const interrupted = input.signal.aborted === true;
                    const summary = timeout?.aborted === true ? `DSH child stopped: timeout after ${timeoutMs}ms; consider raising executionTimeoutMs or splitting the task` : failure.message;
                    const quota = interrupted ? undefined : quotaFailure(summary, Date.now());
                    return { status: 'failed', summary, failureKind: interrupted ? 'interrupted' : quota?.failureKind ?? 'infrastructure', artifacts: [], evidence: [], ...(quota === undefined ? {} : quota), ...(failure.dshSessionId === undefined && dshSessionId === undefined ? {} : { dshSessionId: failure.dshSessionId ?? dshSessionId }) };
                }
                if (settled.stopReason !== 'completed') {
                    // Preserve the child session id in the summary so the operator can
                    // jump into the child's own log when the detail is unavailable.
                    const reason = timeout?.aborted === true ? `timeout after ${timeoutMs}ms; consider raising executionTimeoutMs or splitting the task` : settled.stopReason;
                    const quota = settled.stopReason === 'error' ? quotaFailure(settled.failureDiagnostic ?? '', Date.now()) : undefined;
                    return { status: 'failed', summary: `DSH child stopped: ${stopReasonSummary(reason, settled.dshSessionId)}`, failureKind: quota?.failureKind ?? failureKindOf(reason), artifacts: [], evidence: [], dshSessionId: settled.dshSessionId, ...(quota === undefined ? {} : quota) };
                }
                try {
                    const value = objectValue(settled.value, 'execution result');
                    return {
                        status: 'succeeded', summary: string(value.summary, 'execution summary'),
                        artifacts: array(value.artifacts, 'execution artifacts').map((artifact) => {
                            const item = objectValue(artifact, 'artifact');
                            return { type: string(item.type, 'artifact type'), content: string(item.content, 'artifact content'), ...(item.mimeType === undefined ? {} : { mimeType: string(item.mimeType, 'artifact mimeType') }) };
                        }),
                        evidence: array(value.evidence, 'execution evidence').map(item => string(item, 'evidence')),
                        dshSessionId: settled.dshSessionId,
                    };
                }
                catch (error) {
                    return { status: 'failed', summary: error instanceof Error ? error.message : String(error), artifacts: [], evidence: [], dshSessionId: settled.dshSessionId };
                }
            }
            finally {
                liveAttempts.delete(input.attemptId);
            }
        },
        isAttemptAlive(attemptId) { return liveAttempts.has(attemptId); },
    };
}
async function runStructured(subagents, options, label, prompt, outputSchema, signal = new AbortController().signal, onStarted, hardTimeoutMs) {
    const run = await subagents.start(options.providerName, {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent: currentParent(),
        signal,
        ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
        toolFilter: { deny: [...CHILD_TASK_TOOL_DENY] },
        outputSchema: outputSchema,
    });
    onStarted?.(String(run.id));
    const settled = settleAndDispose(run);
    if (hardTimeoutMs === undefined)
        return settled;
    let timer;
    try {
        return await Promise.race([
            settled,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    // DSH providers are expected to observe the signal, but a provider
                    // that does not must never strand the durable scheduler forever.
                    void run.dispose().catch(() => undefined);
                    const error = new Error(`timeout after ${hardTimeoutMs}ms; consider raising executionTimeoutMs or splitting the task`);
                    Object.assign(error, { dshSessionId: String(run.id) });
                    reject(error);
                }, hardTimeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
async function settleAndDispose(run) {
    try {
        const result = await run.result;
        const failureDiagnostic = result.stopReason === 'error' ? childFailureDiagnostic(run) : undefined;
        return { stopReason: result.stopReason, value: result.structured ?? (result.stopReason === 'completed' ? parseJsonOutput(result.output) : undefined), dshSessionId: String(run.id), ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }) };
    }
    catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        Object.assign(failure, { dshSessionId: String(run.id) });
        throw failure;
    }
    finally {
        await run.dispose();
    }
}
/** Recover the structured LLM failure that the one-shot seam flattens to `error`. */
function childFailureDiagnostic(run) {
    const events = run.localAgent?.session.events ?? [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const message = event.type === 'turn/end' && event.data?.reason?.kind === 'error' ? event.data.reason.error?.message : undefined;
        if (typeof message === 'string' && message.trim().length > 0)
            return message;
    }
    return undefined;
}
function parseJsonOutput(output) {
    const text = output.filter((block) => block.type === 'text').map(block => block.text).join('\n').trim();
    if (text.length === 0)
        throw new Error('DSH child returned neither structured output nor JSON text');
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('DSH child output must be valid JSON when structured output is absent');
    }
}
function plannerPrompt(input) {
    return `Create a dependency DAG for this long-running objective. Every task must declare priority, inputContract, outputContract, completionCriteria, retryPolicy, sideEffectClass, and validator. Use validator \"required\" unless the deployment explicitly supports a stricter named validator. Tasks that need a different child execution budget than the deployment default may declare a positive integer timeoutMs. Return only JSON matching the supplied schema.\nObjective: ${input.objective}\nConstraints: ${JSON.stringify(input.constraints)}${input.baseRevision === undefined ? '' : `\nThis is a replan from revision ${input.baseRevision}. Preserve unaffected completed work when safe. Never alter the id, dependsOn, objective text, or contracts of tasks that have already succeeded; leave them exactly as they are.\nTrigger: ${JSON.stringify(input.trigger ?? {})}\nCurrent tasks: ${JSON.stringify(input.priorTasks ?? [])}`}`;
}
function executionPrompt(input) {
    return `Execute the assigned task and return only JSON matching the supplied schema. The artifacts array must use one of these artifact types: ${V1_ARTIFACT_TYPES.join(', ')}. Write long outputs to files with the write tool and summarize paths in your summary; the artifact content itself should stay compact.\nWorkspace discipline: write task outputs only under the session workspace or a disposable temporary directory you create; never modify tracked source, configuration, dependency manifests, or any file outside your task's declared scope.\nLiveness: call long_task_report_progress with attempt_id ${input.attemptId} at each meaningful phase and before/after long tool work. Keep its message concise and never include raw logs, secrets, or full outputs.\nTask: ${input.taskId}\nIdempotency key: ${input.idempotencyKey ?? 'none'}\nRetry policy: ${JSON.stringify(input.retryPolicy ?? {})}\nSide effect class: ${input.sideEffectClass ?? 'read_only'}\nExecution timeout: ${input.timeoutMs ?? 'deployment default'} ms\nContext: ${JSON.stringify(input.context)}`;
}
function requireProviderName(value) { if (value.trim().length === 0)
    throw new TypeError('providerName must be non-empty'); }
function objectValue(value, label) { if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`); return value; }
function array(value, label) { if (!Array.isArray(value))
    throw new Error(`${label} must be an array`); return value; }
function string(value, label) { if (typeof value !== 'string')
    throw new Error(`${label} must be a string`); return value; }
function integer(value, label) { if (!Number.isSafeInteger(value))
    throw new Error(`${label} must be a safe integer`); return value; }
function quotaFailure(message, now) {
    if (!/\b429\b|rate[ -]?limit|quota/i.test(message))
        return undefined;
    const retryMs = retryAfterMillis(retryAfterValue(message), now);
    if (!Number.isFinite(retryMs) || retryMs <= now || retryMs - now > 86_400_000)
        return undefined;
    return { failureKind: 'quota', retryAt: new Date(retryMs).toISOString(), failureDiagnostic: boundedDiagnostic(message) };
}
function retryAfterValue(message) {
    const named = /(?:retry-after|retry_at|reset_at)\s*[:=]\s*(\S+)/i.exec(message)?.[1];
    if (named !== undefined)
        return named;
    return /\breset\s+at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:Z|[+-]\d{4})(?:\s+[A-Z]{2,5})?)/i.exec(message)?.[1];
}
function retryAfterMillis(value, now) {
    if (value === undefined)
        return Number.NaN;
    if (/^\d+$/.test(value))
        return now + Number(value) * 1000;
    return Date.parse(value);
}
function boundedDiagnostic(message) {
    return message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
}
/**
 * Classify a non-completed child stop. `error`/`max-tokens` are model or
 * transport failures (retriable infrastructure); `aborted` is an operator
 * interruption or cancellation (never failure evidence); `refusal` is a
 * deterministic child decision (an output-class failure). Unknown reasons are
 * treated as infrastructure so they never fabricate validation evidence.
 */
function failureKindOf(reason) {
    switch (reason) {
        case 'aborted': return 'interrupted';
        case 'refusal': return 'output';
        case 'error':
        case 'max-tokens':
        default: return 'infrastructure';
    }
}
/** Human-readable detail for a non-completed stop, including the child session id when useful. */
function stopReasonSummary(reason, dshSessionId) {
    switch (reason) {
        case 'error': return `error (child session ${dshSessionId} ended with a model/transport failure)`;
        case 'max-tokens': return `max-tokens (child session ${dshSessionId} exceeded its token ceiling)`;
        case 'refusal': return `refusal (child session ${dshSessionId} declined the task)`;
        case 'aborted': return 'aborted (operator interruption or cancellation)';
        default: return String(reason);
    }
}
