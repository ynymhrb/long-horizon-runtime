import { z } from 'zod';
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const profile = z.string().trim().min(1).max(128);
const stage = z.strictObject({
    id: identifier,
    objective: z.string().trim().min(1).max(4000),
    profile,
    next: identifier.optional(),
    onChangesRequested: identifier.optional(),
    maxVisits: z.number().int().min(1).max(20).optional(),
    sideEffectClass: z.enum(['read_only', 'idempotent', 'external_effect']).optional(),
});
const participant = z.union([profile, z.strictObject({ id: identifier, profile, instruction: z.string().trim().min(1).max(4000).optional() })]);
const specSchema = z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('workflow'), entry: identifier, stages: z.array(stage).min(1).max(15) }),
    z.strictObject({ mode: z.literal('discussion'), participants: z.array(participant).min(2).max(10), rounds: z.number().int().min(1).max(30), moderator: participant, convergence: z.string().trim().min(1).max(4000).optional() }),
]);
const verdictSchema = z.strictObject({
    verdict: z.enum(['approved', 'changes_requested']),
    reason: z.string().trim().min(1).max(4000),
});
export function parseWorkflow(value, profileIds) {
    const spec = specSchema.parse(value);
    const profiles = workflowProfiles(spec);
    if (profileIds !== undefined) {
        for (const id of profiles)
            if (!profileIds.includes(id))
                throw new Error('未知执行配置 ' + id);
    }
    if (spec.mode === 'discussion')
        return spec;
    if (spec.stages.some(step => step.onChangesRequested !== undefined && (step.sideEffectClass ?? 'read_only') !== 'read_only'))
        throw new Error('带返工分支的评审阶段必须为只读');
    const stages = new Map(spec.stages.map(step => [step.id, step]));
    if (stages.size !== spec.stages.length)
        throw new Error('流程阶段 ID 重复');
    if (!stages.has(spec.entry))
        throw new Error('未知流程入口 ' + spec.entry);
    const reachable = new Set();
    function visit(id) {
        if (reachable.has(id))
            return;
        const step = stages.get(id);
        if (step === undefined)
            throw new Error('未知流程阶段 ' + id);
        reachable.add(id);
        if (step.next !== undefined)
            visit(step.next);
        if (step.onChangesRequested !== undefined)
            visit(step.onChangesRequested);
    }
    visit(spec.entry);
    if (reachable.size !== stages.size)
        throw new Error('流程存在不可达阶段');
    return spec;
}
export function workflowProfiles(spec) {
    return spec.mode === 'workflow' ? spec.stages.map(step => step.profile)
        : [...spec.participants, spec.moderator].map(item => typeof item === 'string' ? item : item.profile);
}
export function readWorkflowVerdict(artifacts) {
    const candidates = artifacts.filter(artifact => artifact.type === 'review');
    if (candidates.length !== 1)
        return undefined;
    try {
        return verdictSchema.parse(JSON.parse(candidates[0].content));
    }
    catch {
        return undefined;
    }
}
const reviewInstruction = '提交且只提交一个 review 类型的产物，其 content 为 JSON 对象，包含 verdict（approved 或 changes_requested）和非空 reason。';
export class WorkflowVisitLimit extends Error {
}
export function workflowStep(spec, objective, history, verdict) {
    const index = history.length;
    if (spec.mode === 'discussion') {
        if (history.at(-1)?.startsWith('wf-summary-'))
            return undefined;
        const turns = spec.rounds * spec.participants.length;
        const spoken = history.filter(id => id.startsWith('wf-speaker-')).length;
        const moderated = history.at(-1)?.startsWith('wf-convergence-') === true;
        const check = spec.convergence !== undefined && spoken > 0 && spoken < turns && spoken % spec.participants.length === 0 && !moderated;
        const summary = spoken >= turns || (moderated && verdict?.verdict === 'approved');
        const actor = check || summary ? spec.moderator : spec.participants[spoken % spec.participants.length];
        const instruction = check
            ? '检查讨论是否达到收敛条件：' + spec.convergence + '。' + reviewInstruction
            : summary
                ? '根据最近发言与累计摘要总结共识、剩余分歧和最终结论。'
                : '这是第 ' + (Math.floor(spoken / spec.participants.length) + 1) + ' 轮第 ' + (spoken % spec.participants.length + 1) + ' 位发言。回应前文并在产物中更新累计摘要和未决分歧。';
        const role = typeof actor === 'string' ? '' : '\n角色 ' + actor.id + '。' + (actor.instruction ?? '');
        const task = node(check ? 'convergence' : summary ? 'summary' : 'speaker', index, objective, instruction + role, typeof actor === 'string' ? actor : actor.profile, history.slice(-6), 'read_only');
        return check ? { ...task, workflowReview: true } : task;
    }
    const stageId = (taskId) => taskId.slice(3, taskId.lastIndexOf('-'));
    const previous = index === 0 ? undefined : spec.stages.find(step => step.id === stageId(history[index - 1]));
    if (index !== 0 && previous === undefined)
        throw new Error('找不到已执行流程阶段');
    const next = previous === undefined ? spec.entry : verdict?.verdict === 'changes_requested' ? previous.onChangesRequested : previous.next;
    if (next === undefined)
        return undefined;
    const step = spec.stages.find(item => item.id === next);
    if (history.filter(id => stageId(id) === next).length >= (step.maxVisits ?? 1)) {
        throw new WorkflowVisitLimit('达到流程阶段执行上限：' + next);
    }
    const review = step.onChangesRequested !== undefined;
    const instruction = step.objective + (review
        ? '\n' + reviewInstruction
        : '');
    return {
        ...node(step.id, index, objective, instruction, step.profile, history.slice(-2), step.sideEffectClass ?? 'read_only'),
        ...(review ? { workflowReview: true } : {}),
    };
}
function node(id, index, objective, instruction, executionProfile, dependsOn, sideEffectClass) {
    return {
        id: 'wf-' + id + '-' + (index + 1),
        objective: '总目标：' + objective + '\n当前步骤：' + instruction,
        summary: id,
        dependsOn,
        executionProfile,
        priority: 0,
        sideEffectClass: sideEffectClass ?? 'read_only',
        inputContract: {},
        outputContract: { requiresArtifact: true },
        completionCriteria: '完成当前步骤并提供可验证产物',
        retryPolicy: { maxAttempts: 1 },
        validator: 'workflow-result',
    };
}
