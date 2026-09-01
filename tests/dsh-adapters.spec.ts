import { describe, expect, test } from 'vitest'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { createDshExecutionAdapter, createDshPlannerAdapter, withDshParent } from '../src/dsh-adapters.js'
import { V1_ARTIFACT_TYPES } from '../src/domain.js'
import { CHILD_TASK_TOOL_DENY } from '../src/routing-policy.js'

describe('DSH adapters', () => {
  test('uses the current parent, parses structured planner output, and disposes the child run', async () => {
    let disposed = false
    let request: Record<string, unknown> | undefined
    const subagents = {
      async start(provider: string, received: Record<string, unknown>) {
        expect(provider).toBe('planner')
        request = received
        return {
          id: 'child-session-1',
          localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed',
            output: [],
            structured: { revision: 1, tasks: [{ id: 'research', objective: 'research', dependsOn: [] }] },
          }),
          async dispose() { disposed = true },
        }
      },
    }
    const planner = createDshPlannerAdapter(subagents as never, { providerName: 'planner' })

    const plan = await withDshParent({ id: 'parent' } as never, () => planner.plan({
      goalId: 'goal-1', objective: 'research topic', constraints: [],
    }))

    expect(plan).toMatchObject({ goalId: 'goal-1', revision: 1 })
    expect(request).toMatchObject({ parent: { id: 'parent' } })
    expect(request?.toolFilter).toEqual({ deny: CHILD_TASK_TOOL_DENY })
    expect(() => assertObjectJsonSchema(request!.outputSchema)).not.toThrow()
    expect(disposed).toBe(true)
  })

  test('carries the active parent request route into a planner child start', async () => {
    let request: Record<string, unknown> | undefined
    const subagents = {
      async start(_provider: string, received: Record<string, unknown>) {
        request = received
        return { id: 'child-session-route', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { revision: 1, tasks: [{ id: 'research', objective: 'research', dependsOn: [] }] } }), async dispose() {} }
      },
    }
    const planner = createDshPlannerAdapter(subagents as never, { providerName: 'planner' })
    const parent = { id: 'parent-route', session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } } as never

    await withDshParent(parent, () => planner.plan({ goalId: 'goal-1', objective: 'research topic', constraints: [] }))

    expect(request?.agentOptions).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  test('carries the active parent request route into an execution child start', async () => {
    let request: Record<string, unknown> | undefined
    const adapter = createDshExecutionAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        request = received
        return { id: 'child-route', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { summary: 'done', artifacts: [], evidence: [] } }), async dispose() {} }
      },
    } as never, { providerName: 'worker' })
    const parent = { id: 'parent-route-exec', session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } } as never

    await withDshParent(parent, () => adapter.execute({ attemptId: 'a', taskId: 't', signal: new AbortController().signal, context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] } }))

    expect(request?.agentOptions).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  test('lets an explicit deployment defaultAgentProfile override the inherited parent route', async () => {
    let request: Record<string, unknown> | undefined
    const planner = createDshPlannerAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        request = received
        return { id: 'child-override', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { revision: 1, tasks: [] } }), async dispose() {} }
      },
    } as never, { providerName: 'planner', agentOptions: { provider: 'override-p', model: 'override-m' } })
    const parent = { id: 'parent-override', session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }) } } as never

    await withDshParent(parent, () => planner.plan({ goalId: 'g', objective: 'o', constraints: [] }))

    expect(request?.agentOptions).toMatchObject({ provider: 'override-p', model: 'override-m' })
  })

  test('omits agentOptions when the parent has no active request route', async () => {
    let request: Record<string, unknown> | undefined
    const planner = createDshPlannerAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        request = received
        return { id: 'child-no-route', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { revision: 1, tasks: [] } }), async dispose() {} }
      },
    } as never, { providerName: 'planner' })

    await withDshParent({ id: 'parent-no-session' } as never, () => planner.plan({ goalId: 'g', objective: 'o', constraints: [] }))

    expect(request?.agentOptions).toBeUndefined()
  })

  test('requires the planner to generate a concise summary for every task', async () => {
    let request: Record<string, unknown> | undefined
    const planner = createDshPlannerAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        request = received
        return { id: 'child', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { revision: 1, tasks: [{ id: 'research', objective: '完整任务说明', summary: '检索资料', dependsOn: [] }] } }), async dispose() {} }
      },
    } as never, { providerName: 'planner' })

    await withDshParent({ id: 'parent' } as never, () => planner.plan({ goalId: 'goal-1', objective: 'research topic', constraints: [] }))

    const taskSchema = (request!.outputSchema as { properties: { tasks: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.tasks.items
    expect(taskSchema.properties.summary).toEqual({ type: 'string' })
    expect(taskSchema.required).toContain('summary')
    expect((request!.prompt as Array<{ text: string }>)[0]!.text).toContain('summary')
  })

  test('enumerates the V1 artifact types in the execution result schema so children learn them up front', async () => {
    let request: Record<string, unknown> | undefined
    const adapter = createDshExecutionAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        request = received
        return { id: 'child', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { summary: 'done', artifacts: [], evidence: [] } }), async dispose() {} }
      },
    } as never, { providerName: 'worker' })
    await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))
    const artifactsSchema = (request!.outputSchema as { properties: { artifacts: { items: { properties: { type: { enum: string[] } } } } } }).properties.artifacts.items.properties.type
    expect(artifactsSchema.enum).toEqual([...V1_ARTIFACT_TYPES])
    expect(request?.toolFilter).toEqual({ deny: CHILD_TASK_TOOL_DENY })
  })

  test('maps a completed execution child result into the runtime contract', async () => {
    const adapter = createDshExecutionAdapter({
      async start() {
        return {
          id: 'child-session-2', localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed', output: [],
            structured: { summary: 'complete', artifacts: [{ type: 'report', content: 'result' }], evidence: ['source'] },
          }),
          async dispose() {},
        }
      },
    } as never, { providerName: 'worker' })

    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'attempt-1', taskId: 'task-1', signal: new AbortController().signal,
      context: { objective: 'goal', task: { id: 'task-1', objective: 'do it' }, artifacts: [] },
    }))

    expect(result).toMatchObject({ status: 'succeeded', summary: 'complete', artifacts: [{ type: 'report', content: 'result' }], evidence: ['source'], dshSessionId: 'child-session-2' })
  })

  test('reports a published unsettled child as live and clears it after settlement', async () => {
    let release!: (result: { stopReason: 'completed'; output: never[]; structured: { summary: string; artifacts: never[]; evidence: never[] } }) => void
    const pending = new Promise<{ stopReason: 'completed'; output: never[]; structured: { summary: string; artifacts: never[]; evidence: never[] } }>(resolve => { release = resolve })
    const adapter = createDshExecutionAdapter({
      async start() { return { id: 'live-child', localAgent: undefined, result: pending, async dispose() {} } },
    } as never, { providerName: 'worker' })
    let started!: () => void
    const published = new Promise<void>(resolve => { started = resolve })
    const execution = withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'attempt-live', taskId: 'task-1', signal: new AbortController().signal,
      context: { objective: 'goal', task: { id: 'task-1', objective: 'do it' }, artifacts: [] },
      onSessionId: () => started(),
    }))

    await published
    expect(adapter.isAttemptAlive?.('attempt-live')).toBe(true)
    release({ stopReason: 'completed', output: [], structured: { summary: 'complete', artifacts: [], evidence: [] } })
    await execution
    expect(adapter.isAttemptAlive?.('attempt-live')).toBe(false)
  })

  test('maps non-completed DSH stop reasons to a classified failed execution result', async () => {
    const adapter = createDshExecutionAdapter({
      async start() { return { id: 'child', localAgent: undefined, result: Promise.resolve({ stopReason: 'max-tokens', output: [] }), async dispose() {} } },
    } as never, { providerName: 'worker' })
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))
    expect(result).toMatchObject({ status: 'failed', failureKind: 'infrastructure' })
    expect(result.summary).toContain('max-tokens')
  })

  test('classifies a child model/transport error as infrastructure and preserves its session id', async () => {
    const adapter = createDshExecutionAdapter({
      async start() { return { id: 'child-session-error', localAgent: undefined, result: Promise.resolve({ stopReason: 'error', output: [] }), async dispose() {} } },
    } as never, { providerName: 'worker' })
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))
    expect(result).toMatchObject({ status: 'failed', failureKind: 'infrastructure', dshSessionId: 'child-session-error' })
    // The opaque "DSH child stopped: error" detail must not be the whole story.
    expect(result.summary).not.toBe('DSH child stopped: error')
    expect(result.summary).toContain('child-session-error')
  })

  test('extracts a quota reset time from a local child turn error', async () => {
    const resetAt = new Date(Date.now() + 60_000)
    const providerResetAt = resetAt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000 UTC')
    const failure = { code: 'QUOTA', message: `429 {"error":{"code":"AccountQuotaExceeded","message":"quota exhausted; reset at ${providerResetAt}"}}` }
    const localAgent = { session: { events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: failure } } }] } }
    const adapter = createDshExecutionAdapter({
      async start() {
        return {
          id: 'quota-child',
          localAgent: localAgent as never,
          result: Promise.resolve({ stopReason: 'error', output: [] }),
          async dispose() {},
        }
      },
    } as never, { providerName: 'worker' })

    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'quota-attempt', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))

    expect(result.failureKind).toBe('quota')
    expect(Date.parse(result.retryAt!)).toBeGreaterThan(Date.now())
    expect(result.failureDiagnostic).toContain('AccountQuotaExceeded')
  })

  test('preserves an explicit future retry-after quota diagnostic from a rejected child run', async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString()
    const adapter = createDshExecutionAdapter({
      async start() { return { id: 'quota-child', localAgent: undefined, result: Promise.reject(new Error(`HTTP 429 rate limit; retry-after: ${retryAt}`)), async dispose() {} } },
    } as never, { providerName: 'worker' })
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))
    expect(result).toMatchObject({ status: 'failed', failureKind: 'quota', retryAt })
  })

  test('interprets Retry-After delta seconds as a quota recovery delay', async () => {
    const before = Date.now()
    const adapter = createDshExecutionAdapter({
      async start() { return { id: 'quota-child', localAgent: undefined, result: Promise.reject(new Error('HTTP 429 rate limit; Retry-After: 60')), async dispose() {} } },
    } as never, { providerName: 'worker' })
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))
    expect(result.failureKind).toBe('quota')
    expect(Date.parse(result.retryAt!)).toBeGreaterThanOrEqual(before + 59_000)
  })

  test('classifies an aborted child as an interruption, never a validation failure', async () => {
    const adapter = createDshExecutionAdapter({
      async start() { return { id: 'child', localAgent: undefined, result: Promise.resolve({ stopReason: 'aborted', output: [] }), async dispose() {} } },
    } as never, { providerName: 'worker' })
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))
    expect(result).toMatchObject({ status: 'failed', failureKind: 'interrupted' })
    expect(result.summary).toContain('aborted')
  })

  test('reports a child timeout with its budget and a remedy instead of a bare abort', async () => {
    let childSignal: AbortSignal | undefined
    const adapter = createDshExecutionAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        childSignal = received.signal as AbortSignal
        return {
          id: 'child', localAgent: undefined,
          result: new Promise((_resolve, reject) => { childSignal!.addEventListener('abort', () => reject(new Error('aborted'))) }),
          async dispose() {},
        }
      },
    } as never, { providerName: 'worker' })
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
      timeoutMs: 30,
    }))
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('DSH child stopped: timeout after 30ms')
    expect(result.summary).toContain('executionTimeoutMs')
  })

  test('prefers a per-task timeoutMs over the adapter default', async () => {
    let childSignal: AbortSignal | undefined
    const adapter = createDshExecutionAdapter({
      async start(_provider: string, received: Record<string, unknown>) {
        childSignal = received.signal as AbortSignal
        return {
          id: 'child', localAgent: undefined,
          result: new Promise((_resolve, reject) => { childSignal!.addEventListener('abort', () => reject(new Error('aborted'))) }),
          async dispose() {},
        }
      },
    } as never, { providerName: 'worker', timeoutMs: 5000 })
    const started = Date.now()
    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
      timeoutMs: 30,
    }))
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('timeout after 30ms')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('settles locally when a child ignores the timeout abort signal', async () => {
    let disposed = false
    const adapter = createDshExecutionAdapter({
      async start() {
        return {
          id: 'lost-child', localAgent: undefined,
          result: new Promise(() => {}),
          async dispose() { disposed = true },
        }
      },
    } as never, { providerName: 'worker', timeoutMs: 30 })

    const result = await withDshParent({ id: 'parent' } as never, () => adapter.execute({
      attemptId: 'a', taskId: 't', signal: new AbortController().signal,
      context: { objective: 'g', task: { id: 't', objective: 'work' }, artifacts: [] },
    }))

    expect(result).toMatchObject({ status: 'failed', failureKind: 'infrastructure', dshSessionId: 'lost-child' })
    expect(result.summary).toContain('timeout after 30ms')
    expect(disposed).toBe(true)
  }, 1_000)
})
