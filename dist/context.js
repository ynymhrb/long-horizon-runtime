/** Builds child contexts from direct validated task outputs only. */
export class ContextBroker {
    source;
    constructor(source) {
        this.source = source;
    }
    /** Build a focused view for one task. */
    build(taskId) {
        const task = this.source.tasks.get(taskId);
        if (task === undefined)
            throw new Error(`unknown task ${taskId}`);
        const directDependencies = new Set(task.dependsOn);
        return {
            objective: this.source.objective,
            task: { id: task.id, objective: task.objective },
            artifacts: this.source.artifacts.filter(artifact => artifact.validated && directDependencies.has(artifact.taskId)),
            l1DependencySummaries: task.dependsOn.map(dependencyId => {
                const dependency = this.source.tasks.get(dependencyId);
                return { taskId: dependencyId, objective: dependency?.objective ?? dependencyId, ...(dependency?.summary === undefined ? {} : { summary: dependency.summary }) };
            }),
            l2ProjectContext: { constraints: this.source.constraints ?? [], decisions: this.source.decisions ?? [], evidence: this.source.evidence ?? [] },
        };
    }
}
