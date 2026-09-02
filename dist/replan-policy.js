export function classifyAutomaticReplan(input) {
    const previousById = new Map(input.previous.map(task => [task.id, task]));
    const candidateById = new Map(input.candidate.map(task => [task.id, task]));
    const reasons = [];
    const failed = previousById.get(input.failedTaskId);
    if (failed === undefined || failed.state === 'SUCCEEDED')
        reasons.push('failed task is not an unfinished current node');
    const affected = downstream(input.previous, input.failedTaskId);
    for (const task of input.candidate) {
        if (task.sideEffectClass === 'external_effect')
            reasons.push(`candidate task ${task.id} has external effects`);
        if (!previousById.has(task.id))
            reasons.push(`candidate adds task ${task.id} outside the current affected region`);
    }
    for (const previous of input.previous) {
        const next = candidateById.get(previous.id);
        if (next === undefined) {
            reasons.push(`candidate removes current task ${previous.id}`);
            continue;
        }
        if (!sameTask(previous, next) && !affected.has(previous.id))
            reasons.push(`candidate changes task ${previous.id} outside the affected downstream region`);
        if (previous.state === 'SUCCEEDED' && !sameTask(previous, next))
            reasons.push(`candidate changes succeeded task ${previous.id}`);
    }
    for (const artifact of input.activeArtifacts)
        if (affected.has(artifact.taskId) || !candidateById.has(artifact.taskId))
            reasons.push(`candidate affects validated artifact owner ${artifact.taskId}`);
    return reasons.length === 0 ? { outcome: 'auto_apply', reasons: [] } : { outcome: 'await_confirmation', reasons: [...new Set(reasons)] };
}
function downstream(tasks, root) {
    const affected = new Set([root]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of tasks)
            if (!affected.has(task.id) && task.dependsOn.some(dependency => affected.has(dependency))) {
                affected.add(task.id);
                changed = true;
            }
    }
    return affected;
}
function sameTask(left, right) {
    const normalize = (task) => {
        const { state: _state, createdOrder: _createdOrder, ...definition } = task;
        return definition;
    };
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
