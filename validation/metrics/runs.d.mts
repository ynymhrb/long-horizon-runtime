export declare const UNKNOWN_RISK: string

export interface RunRecord {
  scenarioId: string
  runId: string
  verdict: string
  risk: string
  kind: string
  tags: string[]
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  timedOut: boolean
  missingEvidence: string[]
  evidenceComplete: boolean
  hardStops: string[]
  errors: string[]
  assertionFailed: boolean
  evidenceDir: string
}

export interface ScenarioMetadata {
  risk: string
  kind: string
  tags: string[]
}

export declare function loadRunRecords(evidenceRoot: string, options?: { scenarioRoot?: string }): Promise<RunRecord[]>
export declare function loadScenarioMetadata(scenarioRoot: string): Promise<Map<string, ScenarioMetadata>>
export declare function isDirectory(file: string): Promise<boolean>
