import { describe, expect, test } from 'vitest'
import { apply } from '../src/tools.js'

describe('Cordis plugin surface', () => {
  test('provides one durable runtime and registers compatibility plus canonical control tools', async () => {
    const registered = new Map<string, { execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }>()
    const provided = new Map<string, unknown>()
    const ctx = {
      tools: { register(tool: { name: string; execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> }) { registered.set(tool.name, tool); return () => {} } },
      subagents: { async start() { return { id: 'child', localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { revision: 1, tasks: [{ id: 'a', objective: 'work', dependsOn: [] }] } }), async dispose() {} } } },
      provide(name: string, service: unknown) { provided.set(name, service) },
      effect() { return () => {} },
    }
    apply(ctx as never, { databasePath: ':memory:', artifactDirectory: 'artifacts', plannerProvider: 'planner', executionProvider: 'worker' })

    expect(provided.get('longTaskRuntime')).toBeDefined()
    expect([...registered.keys()].sort()).toEqual([
      'long_task_cancel', 'long_task_confirm', 'long_task_create',
      'long_task_get', 'long_task_invalidate', 'long_task_resume', 'long_task_status', 'long_task_update',
    ])
    await expect(registered.get('long_task_create')!.execute({ objective: 'ship' }, { signal: new AbortController().signal }))
      .rejects.toThrow('current parent Agent')
  })
})
