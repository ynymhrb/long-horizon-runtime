/** Artifact value persisted inline or as a content-addressed file. */
export interface StoredArtifact {
    readonly id: string;
    readonly taskId: string;
    readonly type: string;
    readonly contentHash: string;
    readonly storage: 'inline' | 'file';
    readonly content?: string;
    readonly path?: string;
    readonly mimeType?: string;
}
/** Content-addressed artifact writer. */
export declare class ArtifactStore {
    private readonly directory;
    private readonly inlineLimitBytes;
    constructor(directory: string, inlineLimitBytes: number);
    /** Store an artifact without trusting a path supplied by the caller. */
    put(input: {
        id: string;
        taskId: string;
        type: string;
        content: string;
        mimeType?: string;
    }): StoredArtifact;
    /** Read an artifact handed off by reference and reject corruption before context injection. */
    read(artifact: Pick<StoredArtifact, 'storage' | 'content' | 'path' | 'contentHash'>): string;
    /** Remove an unreferenced file artifact, but never traverse outside this store's directory. */
    removeIfOwned(path: string): void;
}
