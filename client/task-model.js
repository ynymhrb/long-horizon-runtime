export function initialSelectedNode(nodes) {
  const active = nodes.find(node => node.state === 'RUNNING')
  if (active !== undefined) return active.id
  const pending = nodes.find(node => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'].includes(node.state))
  return pending?.id ?? nodes[0]?.id
}

/** Distinguish a request in flight from an older task that never produced a plan. */
export function cockpitDataState(task, graph) {
  if (task === undefined || graph === undefined) return 'loading'
  if (task === null) return 'missing'
  if (graph === null) return 'no-plan'
  return 'ready'
}

/**
 * Build the message injected into the bound session after a web-side resume.
 * The session's model receives it as its next prompt and drives the DAG with
 * `long_task_resume` (its Agent becomes the live parent), so the user never
 * has to type a second message.
 */
export function resumeDriverMessage(taskId, objective) {
  return `任务区已把长任务 ${taskId} 标记为运行（${objective ?? ''}）。请立即调用 long_task_resume 工具以当前会话为执行父级驱动该任务执行，无需再向我确认。`
}

/**
 * Decide how a web resume hands execution to a live parent session.
 * - 'inject': the bound session is the current one -> push the driver message
 *   into it so the model starts the round automatically.
 * - 'open': the bound session is elsewhere -> navigate there (its model drives
 *   the resume on arrival / next prompt).
 * - 'attach': no bound session -> the user must attach one first.
 */
export function resumeDriverMode(navigation, currentSessionId) {
  const bound = navigation?.currentSessionId
  if (bound === undefined) return 'attach'
  if (bound === currentSessionId) return 'inject'
  return 'open'
}
