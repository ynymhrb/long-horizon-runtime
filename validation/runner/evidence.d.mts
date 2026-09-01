export declare const BASE_EVIDENCE_FILES: [string, string][]
export declare const MAX_INLINE_ARTIFACT_BYTES: number

export declare function redactSecrets(value: unknown): unknown
export declare function sanitizeEnvironment(env: NodeJS.ProcessEnv, extraAllowlist?: string[]): Record<string, string>
export declare function baseEvidenceItems(): string[]

export declare class EvidenceWriter {
  constructor(dir: string)
  dir: string
  files: Map<string, string>
  commandLines: string[]
  init(): Promise<void>
  idOf(fileName: string): string
  writeJson(fileName: string, value: unknown): Promise<void>
  recordCommand(record: Record<string, unknown>): void
  flushCommands(): Promise<void>
  ensureScreenshotsDir(): Promise<void>
  importStagedJson(stagedPath: string, fileName: string): Promise<void>
  static summarizeArtifacts(artifacts: { path?: string; content?: string; storage?: string; validated?: boolean; active?: boolean; type?: string; id?: string }[]): Record<string, unknown>[]
  missingRequired(evidenceRequired: string[]): Promise<string[]>
  inventory(): Promise<Record<string, { size: number; sha256: string }>>
}
