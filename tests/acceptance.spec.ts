import { describe, expect, test } from 'vitest'
import { AcceptanceEngine } from '../src/acceptance.js'

describe('宿主验收引擎', () => {
  test('命令检查以真实退出码拒绝 Agent 声称的成功', async () => {
    const engine = new AcceptanceEngine({ commandTemplates: { fail: { executable: process.execPath, argsPrefix: ['-e', 'process.exit(1)'], maxTimeoutMs: 1_000 } } })
    const result = await engine.evaluate({ attemptId: 'a', workspace: process.cwd(), checks: [{ id: 'test', kind: 'command', templateId: 'fail', args: [], expectedExitCode: 0 }] })
    expect(result.verdict).toBe('failed')
    expect(result.checks[0]).toMatchObject({ id: 'test', ok: false, exitCode: 1 })
  })
})
