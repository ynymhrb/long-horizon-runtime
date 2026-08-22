/** One artifact eligible for a child agent's focused context. */
export interface ContextArtifact {
  readonly id: string
  readonly taskId: string
  readonly type: string
  readonly content: string
  readonly validated: boolean
}

/** Bounded context handed to an execution adapter. */
export interface ContextView {
  readonly objective: string
  readonly task: { readonly id: string; readonly objective: string }
  readonly artifacts: readonly ContextArtifact[]
}

/** Builds child contexts from direct validated task outputs only. */
export class ContextBroker {
  constructor(private readonly source: {
    readonly objective: string
    readonly tasks: ReadonlyMap<string, { readonly id: string; readonly objective: string; readonly dependsOn: readonly string[] }>
    readonly artifacts: readonly ContextArtifact[]
  }) {}

  /** Build a focused view for one task. */
  build(taskId: string): ContextView {
    const task = this.source.tasks.get(taskId)
    if (task === undefined) throw new Error(`unknown task ${taskId}`)
    const directDependencies = new Set(task.dependsOn)
    return {
      objective: this.source.objective,
      task: { id: task.id, objective: task.objective },
      artifacts: this.source.artifacts.filter(artifact => artifact.validated && directDependencies.has(artifact.taskId)),
    }
  }
}
