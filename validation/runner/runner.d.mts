import type { AssertionOutcome } from './assertions.mjs'

export declare const DEFAULT_COMMAND_TIMEOUT_MS: number
export declare const VERDICTS: string[]

export interface RunOptions {
  scenarioFile: string
  workspace?: string
  evidenceRoot?: string
  keepWorkspace?: boolean
  runId?: string
  repoRoot?: string
  commandVersions?: Record<string, string>
  now?: number
}

export interface RunResult {
  verdict: 'pass' | 'fail' | 'inconclusive' | 'hard_stop'
  evidenceDir: string
  workspace: string
  scenarioId: string
  runId: string
  missingEvidence: string[]
  assertions: AssertionOutcome[]
  hardStops: string[]
  errors: string[]
}

export declare function runScenario(options: RunOptions): Promise<RunResult>
export declare function deriveVerdict(input: { assertionOutcomes: AssertionOutcome[]; errors: string[]; hardStops: string[]; missingEvidence: string[] }): 'pass' | 'fail' | 'inconclusive' | 'hard_stop'
