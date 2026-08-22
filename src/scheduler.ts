import { validateExecutionResult, type ExecutionAdapter } from './adapters.js'
import type { TaskNode, TaskState } from './domain.js'

type MutableTask = { -readonly [Key in keyof TaskNode]: TaskNode[Key] }

/** Deterministic super-step scheduler for validated task graphs. */
export class Scheduler {
  constructor(private readonly adapter: ExecutionAdapter, private readonly maxConcurrentTasks: number) {
    if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) throw new Error('maxConcurrentTasks must be at least one')
  }

  /** Dispatch one bounded ready set and update only its task states. */
  async runRound(goalId: string, tasks: Map<string, TaskNode>): Promise<void> {
    const ready = [...tasks.values()]
      .filter(task => task.state === 'PENDING' && task.dependsOn.every(id => tasks.get(id)?.state === 'SUCCEEDED'))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    for (const task of tasks.values()) {
      if (task.state === 'PENDING' && task.dependsOn.every(id => tasks.get(id)?.state === 'SUCCEEDED')) this.setState(tasks, task.id, 'READY')
    }
    await Promise.all(ready.slice(0, this.maxConcurrentTasks).map(async task => {
      this.setState(tasks, task.id, 'RUNNING')
      const controller = new AbortController()
      const result = await this.adapter.execute({
        attemptId: `${goalId}:${task.id}:${Date.now()}`,
        taskId: task.id,
        context: { objective: goalId, task: { id: task.id, objective: task.objective }, artifacts: [] },
        signal: controller.signal,
      })
      this.setState(tasks, task.id, validateExecutionResult(result).ok ? 'SUCCEEDED' : 'FAILED')
    }))
  }

  private setState(tasks: Map<string, TaskNode>, taskId: string, state: TaskState): void {
    const task = tasks.get(taskId)
    if (task === undefined) throw new Error(`unknown task ${taskId}`)
    tasks.set(taskId, { ...(task as MutableTask), state })
  }
}
