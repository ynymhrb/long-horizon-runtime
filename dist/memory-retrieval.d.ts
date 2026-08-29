export interface MemoryCandidate {
    readonly id: string;
    readonly content: string;
    readonly active: boolean;
    readonly sourceRef?: string;
}
export interface RetrievalDecision {
    readonly algorithm: 'lexical-v1';
    readonly queryHash: string;
    readonly selected: readonly {
        readonly memoryId: string;
        readonly score: number;
        readonly selectionReason: string;
    }[];
    readonly excluded: readonly {
        readonly memoryId: string;
        readonly reason: string;
    }[];
}
export declare class MemoryRetriever {
    retrieve(input: {
        readonly query: string;
        readonly maxItems: number;
        readonly memories: readonly MemoryCandidate[];
    }): RetrievalDecision;
}
