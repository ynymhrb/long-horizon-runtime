export function toTaskAreaItem(task) {
    return {
        id: task.id,
        objective: task.objective,
        state: task.state,
        controlRevision: task.controlRevision,
        taskCount: task.tasks.length,
        completedCount: task.tasks.filter(node => node.state === 'SUCCEEDED').length,
        hasPendingProposal: task.pendingProposal !== undefined,
    };
}
/** The conversation dock intentionally stays absent until a chat explicitly attaches a task. */
export function currentTaskStrip(task) {
    return task === undefined ? undefined : toTaskAreaItem(task);
}
