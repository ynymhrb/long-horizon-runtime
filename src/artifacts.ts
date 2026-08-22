import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
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
}

/** Content-addressed artifact writer. */
export class ArtifactStore {
  constructor(private readonly directory: string, private readonly inlineLimitBytes: number) {
    mkdirSync(directory, { recursive: true })
  }

  /** Store an artifact without trusting a path supplied by the caller. */
  put(input: { id: string; taskId: string; type: string; content: string }): StoredArtifact {
    const bytes = Buffer.from(input.content, 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength <= this.inlineLimitBytes) return { ...input, contentHash, storage: 'inline' }
    const path = join(this.directory, contentHash)
    writeFileSync(path, bytes, { flag: 'wx' })
    return { id: input.id, taskId: input.taskId, type: input.type, contentHash, storage: 'file', path }
  }
}
