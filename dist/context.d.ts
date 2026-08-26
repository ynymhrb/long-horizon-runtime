/** One artifact eligible for a child agent's focused context. */
export interface ContextArtifact {
    readonly id: string;
    readonly taskId: string;
    readonly type: string;
    readonly content: string;
    readonly validated: boolean;
}
export interface DependencySummary {
    readonly taskId: string;
    readonly objective: string;
    readonly summary?: string;
}
export interface ProjectDecision {
    readonly type: string;
    readonly payload: Record<string, unknown>;
}
export interface ProjectEvidence {
    readonly taskId?: string;
    readonly value: unknown;
}
/** Bounded context handed to an execution adapter. */
export interface ContextView {
    readonly objective: string;
    readonly constraints?: readonly string[];
    readonly revision?: number;
    readonly task: {
        readonly id: string;
        readonly objective: string;
        readonly inputContract?: Record<string, unknown>;
        readonly outputContract?: Record<string, unknown>;
        readonly completionCriteria?: string;
    };
    readonly artifacts: readonly ContextArtifact[];
    /** L1: direct prerequisite outcomes, without their unbounded raw transcripts. */
    readonly l1DependencySummaries?: readonly DependencySummary[];
    /** L2: goal-wide constraints and auditable decisions/evidence relevant to execution. */
    readonly l2ProjectContext?: {
        readonly constraints: readonly string[];
        readonly decisions: readonly ProjectDecision[];
        readonly evidence: readonly ProjectEvidence[];
    };
    readonly priorFailureSummary?: string;
}
/** Builds child contexts from direct validated task outputs only. */
export declare class ContextBroker {
    private readonly source;
    constructor(source: {
        readonly objective: string;
        readonly constraints?: readonly string[];
        readonly decisions?: readonly ProjectDecision[];
        readonly evidence?: readonly ProjectEvidence[];
        readonly tasks: ReadonlyMap<string, {
            readonly id: string;
            readonly objective: string;
            readonly dependsOn: readonly string[];
            readonly summary?: string;
        }>;
        readonly artifacts: readonly ContextArtifact[];
    });
    /** Build a focused view for one task. */
    build(taskId: string): ContextView;
}
