import { createHash } from 'node:crypto';
export function normalizeExecutionProfiles(input) {
    const profiles = new Map();
    for (const profile of input.profiles) {
        requiredText(profile.id, 'execution profile id');
        requiredText(profile.providerName, `execution profile ${profile.id} providerName`);
        if (profiles.has(profile.id))
            throw new TypeError(`duplicate execution profile: ${profile.id}`);
        if (profile.workerIds !== undefined && (!Array.isArray(profile.workerIds) || profile.workerIds.length === 0))
            throw new Error('workerIds 必须包含至少一个 Worker');
        if (profile.modelRole !== undefined)
            requiredText(profile.modelRole, '模型角色');
        validateNames(profile.workerIds ?? [], 'Worker ID');
        validateNames(profile.capabilities ?? [], `execution profile ${profile.id} capability`);
        validateNames(profile.toolDeny ?? [], `execution profile ${profile.id} tool deny entry`);
        if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1))
            throw new TypeError(`execution profile ${profile.id} timeoutMs must be a positive safe integer`);
        profiles.set(profile.id, { ...profile, ...(profile.workerIds === undefined ? {} : { workerIds: [...new Set(profile.workerIds)] }), capabilities: [...(profile.capabilities ?? [])], toolDeny: [...(profile.toolDeny ?? [])] });
    }
    const defaultProfile = input.defaultProfile ?? input.profiles[0]?.id;
    if (defaultProfile === undefined)
        throw new TypeError('at least one execution profile is required');
    if (!profiles.has(defaultProfile))
        throw new TypeError(`unknown default execution profile: ${defaultProfile}`);
    return { defaultProfile, profiles };
}
export class ProfileRouter {
    profiles;
    constructor(profiles) {
        this.profiles = profiles;
    }
    resolve(input) {
        const id = input.task.executionProfile ?? this.profiles.defaultProfile;
        const profile = this.profiles.profiles.get(id);
        if (profile === undefined)
            throw new Error(`unknown execution profile: ${id}`);
        const capabilities = profile.capabilities ?? [];
        for (const capability of input.task.requiredCapabilities ?? []) {
            if (!capabilities.includes(capability))
                throw new Error(`execution profile ${id} does not provide required capability: ${capability}`);
        }
        const timeoutMs = Math.min(input.defaultTimeoutMs, profile.timeoutMs ?? input.defaultTimeoutMs, input.task.timeoutMs ?? input.defaultTimeoutMs);
        return {
            id, providerName: profile.providerName, ...(profile.workerIds === undefined ? {} : { workerIds: profile.workerIds }), ...(profile.modelRole === undefined ? {} : { modelRole: profile.modelRole }), capabilities: [...capabilities], toolDeny: [...(profile.toolDeny ?? [])], timeoutMs,
            ...(profile.agentOptions === undefined ? {} : { agentOptions: structuredClone(profile.agentOptions) }),
            agentOptionsHash: createHash('sha256').update(JSON.stringify(profile.agentOptions ?? {})).digest('hex'),
            selectionReason: input.task.executionProfile === undefined ? `default profile ${id}` : `task selected ${id}`,
        };
    }
    profileIds() { return [...this.profiles.profiles.keys()].sort(); }
}
function requiredText(value, label) { if (value.trim().length === 0)
    throw new TypeError(`${label} must be non-empty`); }
function validateNames(values, label) { for (const value of values)
    requiredText(value, label); }
