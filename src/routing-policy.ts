/** Model-facing policy for deciding when durable long-task tools own a goal. */
export const ROUTING_POLICY = `# Long-task routing policy

Use exactly one goal system for one user objective. Never create a DSH native goal and a durable long task for the same objective.

- If the user gives an lt_ task ID, or asks to continue, inspect, pause, resume, modify, or cancel an existing long task, use only long_task_* tools.
- Use long_task_create for explicitly long, resumable, cross-session, DAG/subagent, auditable, or plan-review work. Default to planning_mode=require_confirmation unless the user explicitly asks to execute.
- Use a native lightweight goal only for short, single-session progress tracking with no DAG, durable recovery, or independent artifact audit.
- Do not create a goal for ordinary questions or one-shot work.
- If a requested continuation is ambiguous and has no task ID, ask for the task ID or ask the user to select it in Task Area; do not create a duplicate task.
- A user stop is an interruption, not failure evidence. Do not retry or replan solely because the user stopped generation.`

/** Tools that delegated planner/worker agents must never use to mutate task ownership. */
export const CHILD_TASK_TOOL_DENY = [
  'long_task_create', 'long_task_get', 'long_task_update', 'long_task_confirm',
  'long_task_status', 'long_task_resume', 'long_task_cancel', 'long_task_events',
  'long_task_attempt_sessions', 'long_task_invalidate', 'long_task_edit_goal',
  'long_task_accept_replan', 'create_goal', 'get_goal', 'update_goal',
] as const

/** Return no routing prose for any delegated child, even though it composes its parent's preset. */
export function routingPolicyText(agent: { readonly session?: { readonly header?: { readonly origin?: string } }; readonly options?: { readonly subagentDepth?: number } } | undefined): string {
  if (agent?.session?.header?.origin === 'subagent' || (agent?.options?.subagentDepth ?? 0) > 0) return ''
  return ROUTING_POLICY
}
