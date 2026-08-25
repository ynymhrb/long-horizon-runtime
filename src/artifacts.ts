import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { V1_ARTIFACT_TYPES } from './domain.js'

/** Artifact value persisted inline or as a content-addressed file. */
export interface StoredArtifact {
  readonly id: string
  readonly taskId: string
  readonly type: string
  readonly contentHash: string
  readonly storage: 'inline' | 'file'
  readonly content?: string
  readonly path?: string
  readonly mimeType?: string
}

/** Content-addressed artifact writer. */
export class ArtifactStore {
  constructor(private readonly directory: string, private readonly inlineLimitBytes: number) {
    mkdirSync(directory, { recursive: true })
  }

  /** Store an artifact without trusting a path supplied by the caller. */
  put(input: { id: string; taskId: string; type: string; content: string; mimeType?: string }): StoredArtifact {
    if (!(new Set<string>(V1_ARTIFACT_TYPES).has(input.type))) throw new TypeError(`artifact type must be one of the V1 artifact types: ${V1_ARTIFACT_TYPES.join(', ')}`)
    if (input.mimeType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) throw new TypeError('artifact mimeType must be type/subtype')
    const bytes = Buffer.from(input.content, 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength <= this.inlineLimitBytes) return { ...input, contentHash, storage: 'inline' }
    const path = join(this.directory, contentHash)
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
    return { id: input.id, taskId: input.taskId, type: input.type, contentHash, storage: 'file', path, ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }) }
  }

  /** Read an artifact handed off by reference and reject corruption before context injection. */
  read(artifact: Pick<StoredArtifact, 'storage' | 'content' | 'path' | 'contentHash'>): string {
    const bytes = artifact.storage === 'inline' ? Buffer.from(artifact.content ?? '', 'utf8') : readFileSync(requiredPath(artifact.path))
    const value = createHash('sha256').update(bytes).digest('hex')
    if (value !== artifact.contentHash) throw new Error(`artifact content hash mismatch: ${artifact.contentHash}`)
    return bytes.toString('utf8')
  }

  /** Remove an unreferenced file artifact, but never traverse outside this store's directory. */
  removeIfOwned(path: string): void {
    const directory = resolve(this.directory)
    const candidate = resolve(path)
    const relation = relative(directory, candidate)
    if (relation === '' || relation.startsWith('..') || relation.includes('..\\') || relation.includes('../')) return
    rmSync(candidate, { force: true })
  }
}

function requiredPath(path: string | undefined): string { if (path === undefined) throw new Error('file artifact is missing a path'); return path }
