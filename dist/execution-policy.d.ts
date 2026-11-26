export type PolicyMode = 'fixed' | 'evaluated';
export interface PolicyCandidate {
    readonly profileId: string;
    readonly compatible: boolean;
    readonly enabled: boolean;
    readonly budgetAllowed?: boolean;
    readonly successRate?: number;
    readonly averageWallTimeMs?: number;
}
export interface PolicyDecision {
    readonly selectedProfileId: string;
    readonly policyVersion: string;
    readonly candidates: readonly {
        readonly profileId: string;
        readonly score: number;
    }[];
    readonly excluded: readonly {
        readonly profileId: string;
        readonly reason: string;
    }[];
}
export declare class ExecutionPolicy {
    private readonly mode;
    constructor(mode?: PolicyMode);
    choose(input: {
        readonly requestedProfileId: string;
        readonly candidates: readonly PolicyCandidate[];
    }): PolicyDecision;
}
