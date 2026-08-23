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

export function taskStripPresentation(task) {
  const state = taskStatePresentation(task.state)
  return { ...state, progress: `${task.progress.succeeded}/${task.progress.total}`, detail: task.reason ?? task.currentOrLastNode?.objective ?? '' }
}
