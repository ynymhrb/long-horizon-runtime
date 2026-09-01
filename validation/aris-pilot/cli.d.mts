export type PilotCliOutcome =
  | { readonly code: 0 | 1; readonly summary: { readonly pilot_id: string; readonly evidence_dir: string; readonly groups: readonly { readonly id: string; readonly exit_code: number | null; readonly signal: string | null; readonly duration_ms: number }[] } }
  | { readonly code: 2; readonly error: string }
export declare function main(argv: readonly string[]): Promise<PilotCliOutcome>
