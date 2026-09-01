/** One parsed evidence bundle directory the triager consumes. */
export interface EvidenceBundle {
  /** absolute bundle directory */
  dir: string
  /** run.json */
  run: Record<string, unknown>
  /** commands.ndjson rows */
  commands: Record<string, unknown>[]
  /** task.json */
  task: Record<string, unknown>
  /** events.json event list */
  events: { type?: string; seq?: number }[]
  /** snapshot.json */
  snapshot: Record<string, unknown>
  /** artifacts.json */
  artifacts: Record<string, unknown>
  /** assertions.json */
  assertions: Record<string, unknown>
  /** environment.json */
  environment: Record<string, unknown>
  /** screenshot file names (UI scenarios) */
  screenshots: string[]
  /** bundle file inventory (relative names) */
  files: string[]
}

export declare function loadEvidenceBundle(dir: string): Promise<EvidenceBundle>
export declare function summarizeBundle(bundle: EvidenceBundle): Record<string, unknown>
