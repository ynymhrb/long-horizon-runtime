export interface ExecutionProfile {
    readonly id: string;
    readonly providerName: string;
    readonly workerIds?: readonly string[];
    readonly modelRole?: string;
    readonly capabilities?: readonly string[];
    readonly toolDeny?: readonly string[];
    readonly timeoutMs?: number;
    readonly agentOptions?: Record<string, unknown>;
}
export interface ResolvedExecutionProfile {
    readonly id: string;
    readonly providerName: string;
    readonly workerIds?: readonly string[];
    readonly modelRole?: string;
    readonly capabilities: readonly string[];
    readonly toolDeny: readonly string[];
    readonly timeoutMs: number;
    readonly agentOptions?: Record<string, unknown>;
    readonly agentOptionsHash: string;
    readonly selectionReason: string;
}
export interface ExecutionProfileSet {
    readonly defaultProfile: string;
    readonly profiles: ReadonlyMap<string, ExecutionProfile>;
}
export interface ProfileTask {
    readonly executionProfile?: string;
    readonly requiredCapabilities?: readonly string[];
    readonly timeoutMs?: number;
}
export declare function normalizeExecutionProfiles(input: {
    readonly defaultProfile?: string;
    readonly profiles: readonly ExecutionProfile[];
}): ExecutionProfileSet;
export declare class ProfileRouter {
    private readonly profiles;
    constructor(profiles: ExecutionProfileSet);
    resolve(input: {
        readonly task: ProfileTask;
        readonly defaultTimeoutMs: number;
    }): ResolvedExecutionProfile;
    profileIds(): readonly string[];
}
