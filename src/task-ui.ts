import type { GoalView } from './runtime.js'

/** JSON-safe projection deliberately shared by a web Task Area and a chat task strip. */
export interface TaskAreaItem {
  readonly id: string
  readonly objective: string
  readonly state: GoalView['state']
  readonly controlRevision: number
  readonly taskCount: number
  readonly completedCount: number
  readonly hasPendingProposal: boolean
}

export function toTaskAreaItem(task: GoalView): TaskAreaItem {
  return {
    id: task.id,
    objective: task.objective,
    state: task.state,
    controlRevision: task.controlRevision,
    taskCount: task.tasks.length,
    completedCount: task.tasks.filter(node => node.state === 'SUCCEEDED').length,
    hasPendingProposal: task.pendingProposal !== undefined,
  }
}

/** The conversation dock intentionally stays absent until a chat explicitly attaches a task. */
export function currentTaskStrip(task: GoalView | undefined): TaskAreaItem | undefined {
  return task === undefined ? undefined : toTaskAreaItem(task)
}
