import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
    if (!/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(input.type)) throw new TypeError('artifact type must be a non-empty safe identifier')
    if (input.mimeType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) throw new TypeError('artifact mimeType must be type/subtype')
    const bytes = Buffer.from(input.content, 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength <= this.inlineLimitBytes) return { ...input, contentHash, storage: 'inline' }
    const path = join(this.directory, contentHash)
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
    return { id: input.id, taskId: input.taskId, type: input.type, contentHash, storage: 'file', path, ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }) }
  }
}
