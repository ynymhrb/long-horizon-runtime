const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
/** Work that is no longer runnable in the current plan revision: real progress. */
const settledStates = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'INVALIDATED', 'SUPERSEDED', 'CANCELLED']);
/** Browser read model. It derives compact JSON DTOs from durable runtime projections only. */
export class TaskUiApi {
    runtime;
    control;
    constructor(runtime, control) {
        this.runtime = runtime;
        this.control = control;
    }
    listTasks(input = {}) {
        this.runtime.purgeExpiredArchives();
        const cursor = input.cursor ?? 0;
        const activeForSession = input.filter?.sessionId === undefined ? undefined : this.runtime.store.getCurrentTaskForSession(input.filter.sessionId)?.taskId;
        const all = this.runtime.listGoals({ ...(input.filter?.archived === undefined ? {} : { archived: input.filter.archived }) }).filter(task => (activeForSession === undefined ? input.filter?.sessionId === undefined : task.id === activeForSession) && matches(task, input.filter)).map(task => this.summary(task)).sort(compareTaskSummary);
        const items = all.slice(cursor, cursor + 50);
        return { items, ...(cursor + items.length < all.length ? { nextCursor: cursor + items.length } : {}) };
    }
    getTask(input) { return this.runtime.getStatus(input.taskId) ?? null; }
    getTaskGraph(input) {
        const task = this.runtime.getStatus(input.taskId);
        if (task === undefined)
            return null;
        const plan = this.runtime.store.getPlan(input.taskId, input.revision);
        if (plan === undefined)
            return null;
        const nodes = input.revision === undefined && task.tasks.length > 0 ? task.tasks : plan.tasks;
        return { taskId: input.taskId, revision: plan.revision, nodes, edges: nodes.flatMap(node => node.dependsOn.map(from => ({ from, to: node.id }))) };
    }
    listTaskEvents(input) {
        const items = this.runtime.store.listEvents(input.taskId, input.cursor ?? 0, 50, input.taskNodeId);
        return { items, ...(items.length === 50 ? { nextCursor: items[items.length - 1].seq } : {}) };
    }
    getCurrentTaskForSession(input) {
        const binding = this.runtime.store.getCurrentTaskForSession(input.sessionId);
        if (binding === undefined)
            return null;
        const task = this.runtime.getStatus(binding.taskId);
        return task === undefined || terminalStates.has(task.state) ? null : { ...this.summary(task), availableActions: task.availableActions };
    }
    async updateTask(input) {
        return this.control.update({ taskId: input.taskId, expectedRevision: input.expectedRevision, action: input.action, ...(input.recoveryResolution === undefined ? {} : { recoveryResolution: input.recoveryResolution }) }, { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }), ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    }
    /** Explicit user action: create a durable cross-session link and make it current. */
    async attachCurrentSession(input) {
        return this.control.attachSession(input.taskId, { sessionId: input.sessionId, ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }) });
    }
    /** Explicit user action for a session that is already linked to this task. */
    setCurrentSession(input) {
        return this.control.setCurrentSessionTask(input.taskId, { sessionId: input.sessionId, ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }) });
    }
    /** Hide the strip for this conversation without erasing its task provenance. */
    clearCurrentSession(input) {
        this.control.clearCurrentSessionTask(input.sessionId);
        return null;
    }
    rejectReplan(input) {
        return this.control.rejectReplanAtRevision(input.taskId, input.expectedRevision);
    }
    async editTaskGoal(input) {
        return this.control.editGoal({ taskId: input.taskId, expectedRevision: input.expectedRevision, objective: input.objective, reason: input.reason }, { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }), ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    }
    async acceptReplan(input) {
        return this.control.acceptReplan({ taskId: input.taskId, expectedRevision: input.expectedRevision }, { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }), ...(input.parent === undefined ? {} : { parent: input.parent }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    }
    async archiveTask(input) {
        const current = this.runtime.getStatus(input.taskId);
        if (current === undefined)
            throw new Error(`unknown task ${input.taskId}`);
        if (current.controlRevision !== input.expectedRevision)
            return { kind: 'conflict', current };
        return { kind: 'applied', task: this.runtime.archiveGoal(input.taskId) };
    }
    restoreTask(input) { return this.runtime.restoreGoal(input.taskId); }
    getTaskNavigation(input) {
        const task = this.runtime.getStatus(input.taskId);
        if (task === undefined)
            throw new Error(`unknown task ${input.taskId}`);
        const attachedSessionIds = task.sessionLinks.map(link => link.sessionId);
        // A task may be bound by several conversations; the most recently bound one is its jump target.
        const current = task.sessionLinks
            .map(link => ({ link, binding: this.runtime.store.getCurrentTaskForSession(link.sessionId) }))
            .filter((entry) => entry.binding !== undefined && entry.binding.taskId === task.id)
            .sort((left, right) => right.binding.updatedOrder - left.binding.updatedOrder)[0];
        return { attachedSessionIds, ...(current === undefined ? {} : { currentSessionId: current.link.sessionId }) };
    }
    summary(task) {
        const nodes = currentNodes(this.runtime, task);
        const current = nodes.find(node => node.state === 'RUNNING') ?? nodes.find(node => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'].includes(node.state)) ?? nodes.at(-1);
        return {
            id: task.id,
            objective: task.objective,
            state: task.state,
            revision: task.revision,
            controlRevision: task.controlRevision,
            ...(task.workspaceScope === undefined ? {} : { workspaceScope: task.workspaceScope }),
            ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
            progress: { settled: nodes.filter(node => settledStates.has(node.state)).length, total: nodes.length },
            ...(current === undefined ? {} : { currentOrLastNode: { id: current.id, objective: current.objective, state: current.state } }),
            ...(task.pauseReason === undefined ? {} : { reason: task.pauseReason }),
            latestEventCursor: this.runtime.store.latestSeq(task.id),
        };
    }
}
function currentNodes(runtime, task) {
    return task.tasks.length > 0 ? task.tasks : runtime.store.getPlan(task.id)?.tasks ?? [];
}
function matches(task, filter) {
    if (filter?.state !== undefined && task.state !== filter.state)
        return false;
    const query = filter?.query?.trim().toLowerCase();
    return query === undefined || query === '' || task.id.toLowerCase().includes(query) || task.objective.toLowerCase().includes(query);
}
/** Operator attention first; activity breaks ties deterministically. */
const taskStateOrder = { RUNNING: 0, AWAITING_CONFIRMATION: 1, PAUSED: 2, DRAFT: 3, FAILED: 4, CANCELLED: 5, SUCCEEDED: 6 };
function compareTaskSummary(left, right) {
    return taskStateOrder[left.state] - taskStateOrder[right.state] || right.latestEventCursor - left.latestEventCursor || left.id.localeCompare(right.id);
}
