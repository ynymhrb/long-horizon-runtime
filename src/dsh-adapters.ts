/** DSH one-shot child adapters. They translate DSH transport results into the durable-core contracts. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
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
          priority: { type: 'number' }, sideEffectClass: { type: 'string' },
          inputContract: { type: 'object' }, outputContract: { type: 'object' },
          completionCriteria: { type: 'string' },
          retryPolicy: { type: 'object', properties: { maxAttempts: { type: 'integer' } } },
          validator: { type: 'string' },
        }, required: ['id', 'objective', 'dependsOn', 'inputContract', 'outputContract', 'completionCriteria', 'retryPolicy', 'sideEffectClass', 'validator'],
      },
    },
  }, required: ['revision', 'tasks'],
} as const

const RESULT_SCHEMA = {
  type: 'object', properties: {
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, content: { type: 'string' } }, required: ['type', 'content'] } },
    evidence: { type: 'array', items: { type: 'string' } },
  }, required: ['summary', 'artifacts', 'evidence'],
} as const

/** Build an initial-plan adapter backed by a configured DSH one-shot provider. */
export function createDshPlannerAdapter(subagents: Pick<SubagentRuntime, 'start'>, options: DshAdapterOptions): PlannerAdapter {
  requireProviderName(options.providerName)
  return {
    async plan(input): Promise<PlanDraft> {
      const result = await runStructured(subagents, options, 'Long-task planner', plannerPrompt(input), PLAN_SCHEMA)
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
      const timeout = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
      const signal = timeout === undefined ? input.signal : AbortSignal.any([input.signal, timeout])
      let settled: { readonly stopReason: string; readonly value: unknown; readonly dshSessionId: string }
      try { settled = await runStructured(subagents, options, `Long-task attempt ${input.attemptId}`, executionPrompt(input), RESULT_SCHEMA, signal) }
      catch (error) {
        const failure = error as Error & { dshSessionId?: string }
        return { status: 'failed', summary: failure.message, artifacts: [], evidence: [], ...(failure.dshSessionId === undefined ? {} : { dshSessionId: failure.dshSessionId }) }
      }
      if (settled.stopReason !== 'completed') {
        return { status: 'failed', summary: `DSH child stopped: ${settled.stopReason}`, artifacts: [], evidence: [] }
      }
      const value = objectValue(settled.value, 'execution result')
      return {
        status: 'succeeded', summary: string(value.summary, 'execution summary'),
        artifacts: array(value.artifacts, 'execution artifacts').map((artifact) => {
          const item = objectValue(artifact, 'artifact')
          return { type: string(item.type, 'artifact type'), content: string(item.content, 'artifact content') }
        }),
        evidence: array(value.evidence, 'execution evidence').map(item => string(item, 'evidence')),
        dshSessionId: settled.dshSessionId,
      } as ExecutionResult
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
): Promise<{ readonly stopReason: string; readonly value: unknown; readonly dshSessionId: string }> {
  const run = await subagents.start(options.providerName, {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent: currentParent(),
    signal,
    ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions as never }),
    outputSchema: outputSchema as never,
  })
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

function plannerPrompt(input: { readonly objective: string; readonly constraints: readonly string[] }): string {
  return `Create a dependency DAG for this long-running objective. Every task must declare inputContract, outputContract, completionCriteria, retryPolicy, sideEffectClass, and a named validator. Return only JSON matching the supplied schema.\nObjective: ${input.objective}\nConstraints: ${JSON.stringify(input.constraints)}`
}

function executionPrompt(input: Parameters<ExecutionAdapter['execute']>[0]): string {
  return `Execute the assigned task and return only JSON matching the supplied schema.\nTask: ${input.taskId}\nIdempotency key: ${input.idempotencyKey ?? 'none'}\nRetry policy: ${JSON.stringify(input.retryPolicy ?? {})}\nSide effect class: ${input.sideEffectClass ?? 'read_only'}\nContext: ${JSON.stringify(input.context)}`
}

function requireProviderName(value: string): void { if (value.trim().length === 0) throw new TypeError('providerName must be non-empty') }
function objectValue(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`); return value as Record<string, unknown> }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value }
function string(value: unknown, label: string): string { if (typeof value !== 'string') throw new Error(`${label} must be a string`); return value }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`); return value as number }
