/** DSH one-shot child adapters. They translate DSH transport results into the durable-core contracts. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { V1_ARTIFACT_TYPES } from './domain.js'
import { CHILD_TASK_TOOL_DENY } from './routing-policy.js'
import type { ExecutionAdapter, ExecutionResult, PlannerAdapter } from './adapters.js'
import type { PlanDraft } from './domain.js'

const parents = new AsyncLocalStorage<Agent>()

/** Bind a model-facing tool invocation's Agent to child starts made during its async work. */
export function withDshParent<T>(parent: Agent, work: () => Promise<T>): Promise<T> {
  if (parent === undefined || parent === null) throw new Error('long-task DSH execution requires a current parent Agent')
  return parents.run(parent, work)
}

function currentParent(): Agent {
  const parent = parents.getStore()
  if (parent === undefined) throw new Error('long-task DSH execution requires a current parent Agent')
  return parent
}

export interface DshAdapterOptions {
  readonly providerName: string
  readonly agentOptions?: Record<string, unknown>
  readonly timeoutMs?: number
}

const PLAN_SCHEMA = {
  type: 'object', properties: {
    revision: { type: 'integer' },
    tasks: {
      type: 'array', items: {
        type: 'object', properties: {
          id: { type: 'string' }, objective: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          priority: { type: 'number' },
          inputContract: { type: 'object' }, outputContract: { type: 'object' },
          completionCriteria: { type: 'string' },
          retryPolicy: { type: 'object', properties: { maxAttempts: { type: 'integer' } }, required: ['maxAttempts'], additionalProperties: false },
          sideEffectClass: { type: 'string', enum: ['read_only', 'idempotent', 'external_effect'] }, validator: { type: 'string' },
          timeoutMs: { type: 'integer' },
        }, required: ['id', 'objective', 'dependsOn', 'priority', 'inputContract', 'outputContract', 'completionCriteria', 'retryPolicy', 'sideEffectClass', 'validator'], additionalProperties: false,
      },
    },
  }, required: ['revision', 'tasks'], additionalProperties: false,
} as const

const RESULT_SCHEMA = {
  type: 'object', properties: {
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: V1_ARTIFACT_TYPES }, content: { type: 'string' }, mimeType: { type: 'string' } }, required: ['type', 'content'], additionalProperties: false } },
    evidence: { type: 'array', items: { type: 'string' } },
  }, required: ['summary', 'artifacts', 'evidence'], additionalProperties: false,
} as const

/** Build an initial-plan adapter backed by a configured DSH one-shot provider. */
export function createDshPlannerAdapter(subagents: Pick<SubagentRuntime, 'start'>, options: DshAdapterOptions): PlannerAdapter {
  requireProviderName(options.providerName)
  return {
    async plan(input): Promise<PlanDraft> {
      const result = await runStructured(subagents, options, 'Long-task planner', plannerPrompt(input), PLAN_SCHEMA, input.signal)
      if (result.stopReason !== 'completed') throw new Error(`DSH planner stopped: ${result.stopReason}`)
      const value = objectValue(result.value, 'planner')
      return { goalId: input.goalId, revision: integer(value.revision, 'planner revision'), tasks: array(value.tasks, 'planner tasks') as PlanDraft['tasks'] }
    },
  }
}

/** Build an isolated task-attempt adapter backed by a configured DSH one-shot provider. */
export function createDshExecutionAdapter(subagents: Pick<SubagentRuntime, 'start'>, options: DshAdapterOptions): ExecutionAdapter {
  requireProviderName(options.providerName)
  return {
    async execute(input): Promise<ExecutionResult> {
      // A per-task timeoutMs overrides the deployment default, which itself
      // overrides an absent timeout. Distinguish a timeout abort from an
      // operator/other abort so the failure summary is actionable.
      const timeoutMs = input.timeoutMs ?? options.timeoutMs
      const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
      const signal = timeout === undefined ? input.signal : AbortSignal.any([input.signal, timeout])
      let settled: { readonly stopReason: string; readonly value: unknown; readonly dshSessionId: string }
      let dshSessionId: string | undefined
      try { settled = await runStructured(subagents, options, `Long-task attempt ${input.attemptId}`, executionPrompt(input), RESULT_SCHEMA, signal, sessionId => { dshSessionId = sessionId; input.onSessionId?.(sessionId) }) }
      catch (error) {
        const failure = error as Error & { dshSessionId?: string }
        const summary = timeout?.aborted === true ? `DSH child stopped: timeout after ${timeoutMs}ms; consider raising executionTimeoutMs or splitting the task` : failure.message
        return { status: 'failed', summary, artifacts: [], evidence: [], ...(failure.dshSessionId === undefined && dshSessionId === undefined ? {} : { dshSessionId: failure.dshSessionId ?? dshSessionId! }) }
      }
      if (settled.stopReason !== 'completed') {
        const reason = timeout?.aborted === true ? `timeout after ${timeoutMs}ms; consider raising executionTimeoutMs or splitting the task` : settled.stopReason
        return { status: 'failed', summary: `DSH child stopped: ${reason}`, artifacts: [], evidence: [], dshSessionId: settled.dshSessionId }
      }
      try {
        const value = objectValue(settled.value, 'execution result')
        return {
        status: 'succeeded', summary: string(value.summary, 'execution summary'),
        artifacts: array(value.artifacts, 'execution artifacts').map((artifact) => {
          const item = objectValue(artifact, 'artifact')
          return { type: string(item.type, 'artifact type'), content: string(item.content, 'artifact content'), ...(item.mimeType === undefined ? {} : { mimeType: string(item.mimeType, 'artifact mimeType') }) }
        }),
        evidence: array(value.evidence, 'execution evidence').map(item => string(item, 'evidence')),
        dshSessionId: settled.dshSessionId,
        } as ExecutionResult
      } catch (error) { return { status: 'failed', summary: error instanceof Error ? error.message : String(error), artifacts: [], evidence: [], dshSessionId: settled.dshSessionId } }
    },
  }
}

async function runStructured(
  subagents: Pick<SubagentRuntime, 'start'>,
  options: DshAdapterOptions,
  label: string,
  prompt: string,
  outputSchema: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
  onStarted?: (dshSessionId: string) => void,
): Promise<{ readonly stopReason: string; readonly value: unknown; readonly dshSessionId: string }> {
  const run = await subagents.start(options.providerName, {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent: currentParent(),
    signal,
    ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions as never }),
    toolFilter: { deny: [...CHILD_TASK_TOOL_DENY] },
    outputSchema: outputSchema as never,
  })
  onStarted?.(String(run.id))
  return settleAndDispose(run)
}

async function settleAndDispose(run: SubagentRun): Promise<{ readonly stopReason: string; readonly value: unknown; readonly dshSessionId: string }> {
  try {
    const result = await run.result
    return { stopReason: result.stopReason, value: result.structured ?? (result.stopReason === 'completed' ? parseJsonOutput(result.output) : undefined), dshSessionId: String(run.id) }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    Object.assign(failure, { dshSessionId: String(run.id) })
    throw failure
  } finally {
    await run.dispose()
  }
}

function parseJsonOutput(output: readonly ContentBlock[]): unknown {
  const text = output.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n').trim()
  if (text.length === 0) throw new Error('DSH child returned neither structured output nor JSON text')
  try { return JSON.parse(text) } catch { throw new Error('DSH child output must be valid JSON when structured output is absent') }
}

function plannerPrompt(input: Parameters<PlannerAdapter['plan']>[0]): string {
  return `Create a dependency DAG for this long-running objective. Every task must declare priority, inputContract, outputContract, completionCriteria, retryPolicy, sideEffectClass, and validator. Use validator \"required\" unless the deployment explicitly supports a stricter named validator. Tasks that need a different child execution budget than the deployment default may declare a positive integer timeoutMs. Return only JSON matching the supplied schema.\nObjective: ${input.objective}\nConstraints: ${JSON.stringify(input.constraints)}${input.baseRevision === undefined ? '' : `\nThis is a replan from revision ${input.baseRevision}. Preserve unaffected completed work when safe.\nTrigger: ${JSON.stringify(input.trigger ?? {})}\nCurrent tasks: ${JSON.stringify(input.priorTasks ?? [])}`}`
}

function executionPrompt(input: Parameters<ExecutionAdapter['execute']>[0]): string {
  return `Execute the assigned task and return only JSON matching the supplied schema. The artifacts array must use one of these artifact types: ${V1_ARTIFACT_TYPES.join(', ')}. Write long outputs to files with the write tool and summarize paths in your summary; the artifact content itself should stay compact.\nTask: ${input.taskId}\nIdempotency key: ${input.idempotencyKey ?? 'none'}\nRetry policy: ${JSON.stringify(input.retryPolicy ?? {})}\nSide effect class: ${input.sideEffectClass ?? 'read_only'}\nExecution timeout: ${input.timeoutMs ?? 'deployment default'} ms\nContext: ${JSON.stringify(input.context)}`
}

function requireProviderName(value: string): void { if (value.trim().length === 0) throw new TypeError('providerName must be non-empty') }
function objectValue(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`); return value as Record<string, unknown> }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value }
function string(value: unknown, label: string): string { if (typeof value !== 'string') throw new Error(`${label} must be a string`); return value }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`); return value as number }
