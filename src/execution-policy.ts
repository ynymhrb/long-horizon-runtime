export type PolicyMode = 'fixed' | 'evaluated'
export interface PolicyCandidate { readonly profileId: string; readonly compatible: boolean; readonly enabled: boolean; readonly budgetAllowed?: boolean; readonly successRate?: number; readonly averageWallTimeMs?: number }
export interface PolicyDecision { readonly selectedProfileId: string; readonly policyVersion: string; readonly candidates: readonly { readonly profileId: string; readonly score: number }[]; readonly excluded: readonly { readonly profileId: string; readonly reason: string }[] }

export class ExecutionPolicy {
  constructor(private readonly mode: PolicyMode = 'fixed') {}
  choose(input: { readonly requestedProfileId: string; readonly candidates: readonly PolicyCandidate[] }): PolicyDecision {
    const excluded: Array<{ profileId: string; reason: string }> = []
    const eligible = input.candidates.filter(candidate => {
      const reason = !candidate.enabled ? 'disabled' : !candidate.compatible ? 'incompatible' : candidate.budgetAllowed === false ? 'budget' : undefined
      if (reason !== undefined) excluded.push({ profileId: candidate.profileId, reason })
      return reason === undefined
    })
    if (this.mode === 'fixed') {
      const selected = eligible.find(candidate => candidate.profileId === input.requestedProfileId)
      if (selected === undefined) throw new Error(`requested execution profile is not eligible: ${input.requestedProfileId}`)
      return { selectedProfileId: selected.profileId, policyVersion: 'v1-fixed', candidates: [{ profileId: selected.profileId, score: 0 }], excluded }
    }
    if (eligible.length === 0) throw new Error('no eligible execution profile')
    const scored = eligible.map(candidate => ({ profileId: candidate.profileId, score: (candidate.successRate ?? 0) * 1_000_000 - (candidate.averageWallTimeMs ?? Number.MAX_SAFE_INTEGER) }))
      .sort((left, right) => right.score - left.score || left.profileId.localeCompare(right.profileId))
    return { selectedProfileId: scored[0]!.profileId, policyVersion: 'v1-evaluated', candidates: scored, excluded }
  }
}
