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

/**
 * SVG node stroke rules for every DAG tone, embedded by the client bundle so
 * the graph and its legend always agree. RUNNING must be visibly distinct
 * from pending work, so `tone-ongoing` gets the business accent like other
 * active tones; cancelled/superseded work is dashed to read as retired.
 */
export const dagToneCss = '.ltr-node.tone-done>rect{stroke:var(--dsw-alias-state-success-primary)}.ltr-node.tone-error>rect{stroke:var(--dsw-alias-state-error-primary)}.ltr-node.tone-warning>rect{stroke:var(--dsw-alias-state-warning-primary)}.ltr-node.tone-ongoing>rect{stroke:var(--dsw-alias-state-business-primary)}.ltr-node.tone-muted>rect{stroke:var(--dsw-alias-label-tertiary);stroke-dasharray:5 4}'

export function taskStripPresentation(task) {
  const state = taskStatePresentation(task.state)
  return { ...state, progress: formatTaskProgress(task.progress, task.currentOrLastNode), detail: task.reason ?? task.currentOrLastNode?.objective ?? '' }
}

export function formatTaskProgress(progress, node) {
  const objective = node?.objective
  const compactObjective = objective && objective.length > 33 ? `${objective.slice(0, 33)}…` : objective
  const settled = progress.settled ?? progress.succeeded
  return `${settled}/${progress.total}${compactObjective ? ` · 当前：${compactObjective}` : ''}`
}
