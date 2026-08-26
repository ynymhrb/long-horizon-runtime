/** One artifact eligible for a child agent's focused context. */
import type { MemoryCandidate, MemoryRetriever, RetrievalDecision } from './memory-retrieval.js'
export interface ContextArtifact {
  readonly id: string
  readonly taskId: string
  readonly type: string
  readonly content: string
  readonly validated: boolean
}

export interface DependencySummary { readonly taskId: string; readonly objective: string; readonly summary?: string }
export interface ProjectDecision { readonly type: string; readonly payload: Record<string, unknown> }
export interface ProjectEvidence { readonly taskId?: string; readonly value: unknown }

/** Bounded context handed to an execution adapter. */
export interface ContextView {
  readonly objective: string
  readonly constraints?: readonly string[]
  readonly revision?: number
  readonly task: { readonly id: string; readonly objective: string; readonly inputContract?: Record<string, unknown>; readonly outputContract?: Record<string, unknown>; readonly completionCriteria?: string }
  readonly artifacts: readonly ContextArtifact[]
  /** L1: direct prerequisite outcomes, without their unbounded raw transcripts. */
  readonly l1DependencySummaries?: readonly DependencySummary[]
  /** L2: goal-wide constraints and auditable decisions/evidence relevant to execution. */
  readonly l2ProjectContext?: { readonly constraints: readonly string[]; readonly decisions: readonly ProjectDecision[]; readonly evidence: readonly ProjectEvidence[] }
  readonly priorFailureSummary?: string
  /** Explainable optional L3 retrieval; mandatory artifacts are always separate. */
  readonly retrieval?: RetrievalDecision
}

/** Builds child contexts from direct validated task outputs only. */
export class ContextBroker {
  constructor(private readonly source: {
    readonly objective: string
    readonly constraints?: readonly string[]
    readonly decisions?: readonly ProjectDecision[]
    readonly evidence?: readonly ProjectEvidence[]
    readonly tasks: ReadonlyMap<string, { readonly id: string; readonly objective: string; readonly dependsOn: readonly string[]; readonly summary?: string }>
    readonly artifacts: readonly ContextArtifact[]
    readonly memories?: readonly MemoryCandidate[]
    readonly memoryRetriever?: MemoryRetriever
    readonly maxMemoryItems?: number
  }) {}

  /** Build a focused view for one task. */
  build(taskId: string): ContextView {
    const task = this.source.tasks.get(taskId)
    if (task === undefined) throw new Error(`unknown task ${taskId}`)
    const directDependencies = new Set(task.dependsOn)
    const retrieval = this.source.memoryRetriever === undefined || this.source.memories === undefined ? undefined : this.source.memoryRetriever.retrieve({ query: `${this.source.objective} ${task.objective}`, maxItems: this.source.maxMemoryItems ?? 0, memories: this.source.memories })
    return {
      objective: this.source.objective,
      task: { id: task.id, objective: task.objective },
      artifacts: this.source.artifacts.filter(artifact => artifact.validated && directDependencies.has(artifact.taskId)),
      l1DependencySummaries: task.dependsOn.map(dependencyId => {
        const dependency = this.source.tasks.get(dependencyId)
        return { taskId: dependencyId, objective: dependency?.objective ?? dependencyId, ...(dependency?.summary === undefined ? {} : { summary: dependency.summary }) }
      }),
      l2ProjectContext: { constraints: this.source.constraints ?? [], decisions: this.source.decisions ?? [], evidence: this.source.evidence ?? [] },
      ...(retrieval === undefined ? {} : { retrieval }),
    }
  }
}
