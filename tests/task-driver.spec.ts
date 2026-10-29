import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { DRIVER_REDRIVE_GRACE_MS, canDriveSessionDriver, driveBoundSessionOnce, sessionDriverKey, sessionDriverStatus } from '../client/task-driver.js'

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `session-driver-${sessionCounter}`
}

function readClientFile(name: string): string {
  return readFileSync(new URL(`../client/${name}`, import.meta.url), 'utf8')
}

test('两个面板同时触发时一次恢复只注入一条驱动消息', async () => {
  const sessionId = nextSessionId()
  let injections = 0
  const drive = async () => { injections += 1; return true }
  const input = { sessionId, taskId: 'lt_a', controlRevision: 4, objective: '研究任务', drive }
  const results = await Promise.all([driveBoundSessionOnce(input), driveBoundSessionOnce(input)])
  expect(injections).toBe(1)
  expect(results.map(result => result.outcome).sort()).toEqual(['injected', 'skipped'])
})

test('同一控制版本再次自动驱动会被跳过', async () => {
  const sessionId = nextSessionId()
  let injections = 0
  const drive = async () => { injections += 1; return true }
  const input = { sessionId, taskId: 'lt_b', controlRevision: 2, objective: '目标', drive }
  expect((await driveBoundSessionOnce(input)).outcome).toBe('injected')
  expect((await driveBoundSessionOnce(input)).outcome).toBe('skipped')
  expect(injections).toBe(1)
})

test('注入进行中时并发调用被跳过而不是再发一条', async () => {
  const sessionId = nextSessionId()
  let release: (value: boolean) => void = () => undefined
  let injections = 0
  const drive = () => { injections += 1; return new Promise<boolean>(resolve => { release = resolve }) }
  const input = { sessionId, taskId: 'lt_c', controlRevision: 1, objective: '目标', drive }
  const first = driveBoundSessionOnce(input)
  const second = await driveBoundSessionOnce(input)
  expect(second.outcome).toBe('skipped')
  expect(second.status?.outcome).toBe('pending')
  release(true)
  expect((await first).outcome).toBe('injected')
  expect(injections).toBe(1)
})

test('注入真实失败后允许立即重试', async () => {
  const sessionId = nextSessionId()
  let injections = 0
  const failing = async () => { injections += 1; return false }
  const input = { sessionId, taskId: 'lt_d', controlRevision: 3, objective: '目标', drive: failing }
  const failed = await driveBoundSessionOnce(input)
  expect(failed.outcome).toBe('failed')
  expect(failed.status?.outcome).toBe('failed')
  expect(sessionDriverStatus(sessionId, 'lt_d', 3)?.outcome).toBe('failed')
  expect(canDriveSessionDriver(failed.status)).toBe(true)
  const injected = await driveBoundSessionOnce({ ...input, drive: async () => { injections += 1; return true } })
  expect(injected.outcome).toBe('injected')
  expect(injections).toBe(2)
})

test('注入抛错记为失败并保留原因', async () => {
  const sessionId = nextSessionId()
  const input = { sessionId, taskId: 'lt_e', controlRevision: 1, objective: '目标', drive: async () => { throw new Error('会话不可用') } }
  const result = await driveBoundSessionOnce(input)
  expect(result.outcome).toBe('failed')
  expect(result.status?.reason).toContain('会话不可用')
})

test('控制版本推进后重新允许驱动', async () => {
  const sessionId = nextSessionId()
  let injections = 0
  const drive = async () => { injections += 1; return true }
  expect((await driveBoundSessionOnce({ sessionId, taskId: 'lt_f', controlRevision: 1, objective: '目标', drive })).outcome).toBe('injected')
  expect((await driveBoundSessionOnce({ sessionId, taskId: 'lt_f', controlRevision: 2, objective: '目标', drive })).outcome).toBe('injected')
  expect(injections).toBe(2)
})

test('成功注入后在宽限期内禁止人工重发，超过宽限期才允许', async () => {
  const sessionId = nextSessionId()
  let injections = 0
  const drive = async () => { injections += 1; return true }
  const input = { sessionId, taskId: 'lt_g', controlRevision: 1, objective: '目标', drive, now: 1_000 }
  expect((await driveBoundSessionOnce(input)).outcome).toBe('injected')
  const status = sessionDriverStatus(sessionId, 'lt_g', 1)
  expect(canDriveSessionDriver(status, 1_000 + DRIVER_REDRIVE_GRACE_MS - 1)).toBe(false)
  expect(canDriveSessionDriver(status, 1_000 + DRIVER_REDRIVE_GRACE_MS)).toBe(true)
  const early = await driveBoundSessionOnce({ ...input, now: 1_000 + 500 })
  expect(early.outcome).toBe('skipped')
  const late = await driveBoundSessionOnce({ ...input, now: 1_000 + DRIVER_REDRIVE_GRACE_MS })
  expect(late.outcome).toBe('injected')
  expect(injections).toBe(2)
})

test('未尝试、进行中、失败、已注入四种状态的可用性判定', () => {
  expect(canDriveSessionDriver(undefined)).toBe(true)
  expect(canDriveSessionDriver({ outcome: 'pending', at: 0 })).toBe(false)
  expect(canDriveSessionDriver({ outcome: 'failed', at: 0, reason: 'x' })).toBe(true)
  expect(canDriveSessionDriver({ outcome: 'injected', at: 0 }, 1_000)).toBe(false)
})

test('去重键按会话、任务与控制版本隔离', () => {
  expect(sessionDriverKey('s1', 'lt_h', 2)).toBe('s1::lt_h::2')
  expect(sessionDriverKey('s1', 'lt_h', 3)).not.toBe(sessionDriverKey('s1', 'lt_h', 2))
  expect(sessionDriverKey('s2', 'lt_h', 2)).not.toBe(sessionDriverKey('s1', 'lt_h', 2))
})

test('任务面板不再各自持有驱动去重集合，只走共享驱动入口', () => {
  for (const name of ['TaskCockpit.js', 'TaskStrip.js']) {
    const source = readClientFile(name)
    expect(source).toContain("from './task-driver.js'")
    expect(source).toContain('driveBoundSessionOnce')
    expect(source).not.toContain('automaticallyDriven')
    expect(source).not.toContain('.current.has(')
  }
})

test('驱动消息仍以 queue 模式注入绑定会话', () => {
  const source = readClientFile('index.js')
  expect(source).toContain("session.prompt([{ type: 'text', text: resumeDriverMessage(taskId, objective) }], 'queue')")
})
