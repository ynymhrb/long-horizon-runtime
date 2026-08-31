import { describe, expect, test } from 'vitest'
import { apply } from '../src/tools.js'
import { LongTaskRuntime } from '../src/runtime.js'
import { filterRoutingTools, routingPolicyText } from '../src/routing-policy.js'

describe('long-task routing policy', () => {
  test('renders only for a top-level conversation agent', () => {
    expect(routingPolicyText({ session: { header: { origin: 'user' } }, options: { subagentDepth: 0 } } as never)).toContain('long_task_create')
    expect(routingPolicyText({ session: { header: { origin: 'subagent' } }, options: { subagentDepth: 1 } } as never)).toBe('')
  })

  test('strict routing removes native goal schemas only from a top-level agent', () => {
    const tools = [{ name: 'create_goal' }, { name: 'get_goal' }, { name: 'update_goal' }, { name: 'long_task_create' }, { name: 'read_file' }]
    const root = { session: { header: { origin: 'user' } }, options: { subagentDepth: 0 } } as never
    const child = { session: { header: { origin: 'subagent' } }, options: { subagentDepth: 1 } } as never
    expect(filterRoutingTools('advisory', root, tools)).toEqual(tools)
    expect(filterRoutingTools('strict', root, tools).map(tool => tool.name)).toEqual(['long_task_create', 'read_file'])
    expect(filterRoutingTools('strict', child, tools)).toEqual(tools)
  })
})

describe('Cordis plugin surface', () => {
  test('installs strict routing as a root-only prompt assembly filter', async () => {
    let assemble: ((assembly: unknown, context: { agent?: unknown }, next: () => Promise<{ tools: readonly { name: string }[] }>) => Promise<{ tools: readonly { name: string }[] }>) | undefined
    const ctx = {
      tools: { register() { return () => {} } }, subagents: {}, provide() {}, reflect: { provide() {} }, effect() { return () => {} },
      systemPrompt: { section() { return () => {} } },
      on(event: string, listener: typeof assemble) { if (event === 'system-prompt/assemble') assemble = listener },
    }
    apply(ctx as never, { databasePath: ':memory:', artifactDirectory: 'artifacts', plannerProvider: 'planner', executionProvider: 'worker', routingMode: 'strict' })
    const tools = [{ name: 'create_goal' }, { name: 'long_task_create' }]
    const root = await assemble!({}, { agent: { session: { header: { origin: 'user' } }, options: { subagentDepth: 0 } } }, async () => ({ tools }))
    const child = await assemble!({}, { agent: { session: { header: { origin: 'subagent' } }, options: { subagentDepth: 1 } } }, async () => ({ tools }))
    expect(root.tools.map(tool => tool.name)).toEqual(['long_task_create'])
    expect(child.tools).toEqual(tools)
  })

  test('provides one durable runtime and registers compatibility plus canonical control tools', async () => {
    const registered = new Map<string, { execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }>()
    const provided = new Map<string, unknown>()
    const ctx = {
      tools: { register(tool: { name: string; execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }) { registered.set(tool.name, tool); return () => {} } },
      subagents: { async start() { return { id: 'child', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [] }] } }), async dispose() {} } } },
      provide(name: string, service: unknown) { provided.set(name, service) },
      reflect: { provide() {} },
      effect() { return () => {} }, systemPrompt: { section() { return () => {} } },
    }
    apply(ctx as never, { databasePath: ':memory:', artifactDirectory: 'artifacts', plannerProvider: 'planner', executionProvider: 'worker' })

    expect(provided.get('longTaskRuntime')).toBeDefined()
    expect([...registered.keys()].sort()).toEqual([
      'long_task_accept_replan', 'long_task_attempt_sessions', 'long_task_cancel', 'long_task_confirm', 'long_task_create',
      'long_task_edit_goal',
      'long_task_events', 'long_task_get', 'long_task_invalidate', 'long_task_report_progress', 'long_task_resume', 'long_task_status', 'long_task_update',
    ])
    await expect(registered.get('long_task_create')!.execute({ objective: 'ship' }, { signal: new AbortController().signal }))
      .rejects.toThrow('current parent Agent')
  })

  test('binds a tool-created task to the calling agent session', async () => {
    const registered = new Map<string, { execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }>()
    const provided = new Map<string, unknown>()
    const ctx = {
      tools: { register(tool: { name: string; execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }) { registered.set(tool.name, tool); return () => {} } },
      subagents: {}, provide(name: string, service: unknown) { provided.set(name, service) }, reflect: { provide() {} }, effect() { return () => {} }, systemPrompt: { section() { return () => {} } },
    }
    apply(ctx as never, {
      databasePath: ':memory:', artifactDirectory: 'artifacts', plannerProvider: 'planner', executionProvider: 'worker',
      runtimeFactory: (() => new LongTaskRuntime((async () => ({ revision: 1, tasks: [{ id: 'plan', objective: 'plan', dependsOn: [], priority: 1, inputContracts: [], outputContracts: [], completion: { kind: 'manual' }, retry: { maxAttempts: 1 }, sideEffect: 'read_only', validator: 'required' }] })) as never, (async () => ({ outputs: [] })) as never, { databasePath: ':memory:', artifactDirectory: 'artifacts' })) as never,
    })
    const result = await registered.get('long_task_create')!.execute({ objective: 'ship', planning_mode: 'require_confirmation' }, { agent: { id: 'session-tool' }, signal: new AbortController().signal }) as { id: string }
    const runtime = provided.get('longTaskRuntime') as LongTaskRuntime
    expect(runtime.store.getCurrentTaskForSession('session-tool')?.taskId).toBe(result.id)
  })

  test('continuing a tool task from a new session binds that session as current', async () => {
    const registered = new Map<string, { execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }>()
    const provided = new Map<string, unknown>()
    const ctx = {
      tools: { register(tool: { name: string; execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }) { registered.set(tool.name, tool); return () => {} } },
      subagents: {}, provide(name: string, service: unknown) { provided.set(name, service) }, reflect: { provide() {} }, effect() { return () => {} }, systemPrompt: { section() { return () => {} } },
    }
    apply(ctx as never, {
      databasePath: ':memory:', artifactDirectory: 'artifacts', plannerProvider: 'planner', executionProvider: 'worker',
      runtimeFactory: (() => new LongTaskRuntime(
        { plan: async (input: { goalId: string }) => ({ goalId: input.goalId, revision: 1, tasks: [{ id: 'plan', objective: 'plan', dependsOn: [], priority: 1, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required' }] }) } as never,
        { execute: async () => ({ status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] }) } as never,
        { databasePath: ':memory:', artifactDirectory: 'artifacts' },
      )) as never,
    })
    const created = await registered.get('long_task_create')!.execute({ objective: 'ship', planning_mode: 'require_confirmation' }, { agent: { id: 'origin' }, signal: new AbortController().signal }) as { id: string; controlRevision: number }
    const runtime = provided.get('longTaskRuntime') as LongTaskRuntime
    expect(runtime.getStatus(created.id)?.state).toBe('AWAITING_CONFIRMATION')
    await registered.get('long_task_update')!.execute({ goal_id: created.id, expected_revision: created.controlRevision, action: 'confirm' }, { agent: { id: 'next' }, signal: new AbortController().signal })
    expect(runtime.store.getCurrentTaskForSession('next')?.taskId).toBe(created.id)
    expect(runtime.getStatus(created.id)?.sessionLinks).toContainEqual({ sessionId: 'next', kind: 'attached' })
  })
})
