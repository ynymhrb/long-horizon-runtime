import type { PilotConfig } from './contract.mjs'
export interface PilotRunGroup { readonly id: string; readonly exitCode: number | null; readonly signal: string | null; readonly durationMs: number }
export declare function runPilot(input: { readonly configFile: string; readonly evidenceRoot: string; readonly runId?: string }): Promise<{ readonly evidenceDir: string; readonly config: PilotConfig; readonly groups: readonly PilotRunGroup[] }>
