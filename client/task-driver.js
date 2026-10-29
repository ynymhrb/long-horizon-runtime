/**
 * 单一会话驱动入口。
 *
 * 长任务在 Web 侧恢复后仍需要一条「请调用 long_task_resume」的驱动消息才能
 * 真正派发节点。历史上这个动作由三处独立实现：Cockpit 的显式恢复路径、
 * Cockpit 的自动驱动 effect、任务条的自动驱动 effect，各自持有一份组件内
 * 去重集合，导致一次点击会注入 2~3 条完全相同的排队消息。
 *
 * 这里把「同一会话 + 同一任务 + 同一控制版本只自动驱动一次」收敛为一个模块级
 * 状态机：所有入口共用同一份状态，跨组件、跨重挂载、跨轮询周期都生效；真实
 * 注入失败允许立即重试，成功之后只在宽限期外才允许人工重发。
 */
export const DRIVER_REDRIVE_GRACE_MS = 60_000
const DRIVER_STATE_TTL_MS = 30 * 60_000
const MAX_TRACKED_DRIVERS = 512
const drivers = new Map()

/** 去重键：同一任务的不同控制版本是不同意图，绑定到不同会话也是不同意图。 */
export function sessionDriverKey(sessionId, taskId, controlRevision) {
  return `${sessionId}::${taskId}::${controlRevision}`
}

/** 读取当前驱动状态；undefined 表示从未尝试过。 */
export function sessionDriverStatus(sessionId, taskId, controlRevision) {
  return drivers.get(sessionDriverKey(sessionId, taskId, controlRevision))
}

/**
 * 判断此刻是否还允许发送驱动消息。
 * - 从未尝试：允许。
 * - 注入进行中：禁止，避免并发重复。
 * - 注入失败：允许重试。
 * - 注入成功：宽限期内禁止（防止人工连点），超过宽限期允许重新发送。
 */
export function canDriveSessionDriver(status, now = Date.now(), graceMs = DRIVER_REDRIVE_GRACE_MS) {
  if (status === undefined) return true
  if (status.outcome === 'pending') return false
  if (status.outcome === 'failed') return true
  return now - status.at >= graceMs
}

/**
 * 向绑定会话至多注入一次驱动消息。
 * @param input.sessionId 目标会话。
 * @param input.taskId 任务 ID。
 * @param input.controlRevision 该任务被推进到的控制版本。
 * @param input.objective 任务目标，用于拼装驱动消息。
 * @param input.drive 实际注入函数，签名 (sessionId, taskId, objective) => Promise<boolean>。
 * @param input.now 可选时钟，便于确定性测试。
 * @param input.graceMs 可选宽限期覆盖值。
 * @returns 结果为 'injected' | 'failed' | 'skipped'，并附带最终状态。
 */
export async function driveBoundSessionOnce(input) {
  const graceMs = input.graceMs ?? DRIVER_REDRIVE_GRACE_MS
  const clock = () => (input.now === undefined ? Date.now() : input.now)
  const key = sessionDriverKey(input.sessionId, input.taskId, input.controlRevision)
  const existing = drivers.get(key)
  if (!canDriveSessionDriver(existing, clock(), graceMs)) return { outcome: 'skipped', status: existing }
  // 先同步占位再 await：两个面板在同一次事件循环里同时触发时只有一个能通过。
  remember(key, { outcome: 'pending', at: clock() })
  try {
    const driven = await input.drive(input.sessionId, input.taskId, input.objective)
    const status = driven === true
      ? { outcome: 'injected', at: clock() }
      : { outcome: 'failed', at: clock(), reason: '绑定会话拒绝了驱动消息' }
    remember(key, status)
    return { outcome: status.outcome, status }
  } catch (error) {
    const status = { outcome: 'failed', at: clock(), reason: error instanceof Error ? error.message : String(error) }
    remember(key, status)
    return { outcome: status.outcome, status }
  }
}

function remember(key, status) {
  drivers.set(key, status)
  if (drivers.size <= MAX_TRACKED_DRIVERS) return
  const cutoff = status.at - DRIVER_STATE_TTL_MS
  for (const [existingKey, existing] of drivers) if (existing.at < cutoff) drivers.delete(existingKey)
  while (drivers.size > MAX_TRACKED_DRIVERS) {
    let oldestKey
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [existingKey, existing] of drivers) {
      if (existing.at < oldestAt) { oldestAt = existing.at; oldestKey = existingKey }
    }
    if (oldestKey === undefined) return
    drivers.delete(oldestKey)
  }
}
