const STATES = {
  AWAITING_CONFIRMATION: { tone: 'warning', label: '等待确认' },
  RUNNING: { tone: 'ongoing', label: '运行中' },
  PAUSED: { tone: 'warning', label: '已暂停' },
  SUCCEEDED: { tone: 'done', label: '已完成' },
  FAILED: { tone: 'error', label: '失败' },
  CANCELLED: { tone: 'muted', label: '已取消' },
  PENDING: { tone: 'neutral', label: '待执行' },
  READY: { tone: 'neutral', label: '就绪' },
  BLOCKED: { tone: 'error', label: '受阻' },
  INVALIDATED: { tone: 'muted', label: '已失效' },
  SUPERSEDED: { tone: 'muted', label: '已替代' },
}

/** Closed durable-state mapping shared by overview, strip, graph and inspector. */
export function taskStatePresentation(state) {
  return STATES[state] ?? { tone: 'muted', label: '未知状态' }
}

export function quotaRecoveryPresentation(recovery, now = new Date(), latestRecoveryEvent) {
  if (latestRecoveryEvent?.type === 'QuotaRecoveryResumed') return { tone: 'ongoing', label: '额度已恢复，正在自动继续执行' }
  if (!recovery) return undefined
  if (Date.parse(recovery.retryAt) <= now.getTime()) return { tone: 'warning', label: '额度恢复时间已到，请在已关联会话中继续' }
  return { tone: 'warning', label: `LLM 额度耗尽，预计 ${new Date(recovery.retryAt).toLocaleString()} 后重试` }
}

/**
 * SVG node stroke rules for every DAG tone, embedded by the client bundle so
 * the graph and its legend always agree. RUNNING must be visibly distinct
 * from pending work, so `tone-ongoing` gets the business accent like other
 * active tones; cancelled/superseded work is dashed to read as retired.
 * The selection ring uses the foreground label color, never a state tone,
 * so a selected pending node can not be mistaken for a running one.
 */
export const dagToneCss = '.ltr-node.tone-done>rect{stroke:var(--dsw-alias-state-success-primary)}.ltr-node.tone-error>rect{stroke:var(--dsw-alias-state-error-primary)}.ltr-node.tone-warning>rect{stroke:var(--dsw-alias-state-warning-primary)}.ltr-node.tone-ongoing>rect{stroke:var(--dsw-alias-state-business-primary)}.ltr-node.tone-muted>rect{stroke:var(--dsw-alias-label-tertiary);stroke-dasharray:5 4}.ltr-node.is-selected>rect{stroke:var(--dsw-alias-label-primary);stroke-width:2.5}'

export function taskStripPresentation(task) {
  const state = taskStatePresentation(task.state)
  // A web-side resume only marks the goal RUNNING; a live agent session must
  // drive the actual rounds. Surface that "waiting for driver" state instead
  // of pretending the task is executing on its own.
  const waitingForDriver = task.state === 'RUNNING' && task.currentOrLastNode?.state !== undefined && task.currentOrLastNode.state !== 'RUNNING'
  const current = task.currentOrLastNode?.objective
  return { ...state, progress: formatTaskProgress(task.progress, task.currentOrLastNode), detail: waitingForDriver ? `等待会话驱动执行${current ? ` · ${current}` : ''}` : (task.reason ?? current ?? '') }
}

export function formatTaskProgress(progress, node) {
  const objective = node?.objective
  const compactObjective = objective && objective.length > 33 ? `${objective.slice(0, 33)}…` : objective
  const settled = progress?.settled ?? progress?.succeeded ?? 0
  return `${settled}/${progress?.total ?? 0}${compactObjective ? ` · 当前：${compactObjective}` : ''}`
}
