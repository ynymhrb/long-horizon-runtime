import { describe, expect, test } from 'vitest'
import { ExecutionPolicy } from '../src/execution-policy.js'

describe('execution policy', () => {
  test('fixed mode retains the requested profile', () => {
    expect(new ExecutionPolicy('fixed').choose({ requestedProfileId: 'requested', candidates: [{ profileId: 'requested', compatible: true, enabled: true }, { profileId: 'better', compatible: true, enabled: true, successRate: 1 }] })).toMatchObject({ selectedProfileId: 'requested', policyVersion: 'v1-fixed' })
  })

  test('evaluated mode excludes ineligible candidates and deterministically ranks the rest', () => {
    expect(new ExecutionPolicy('evaluated').choose({ requestedProfileId: 'requested', candidates: [
      { profileId: 'cheap', compatible: true, enabled: true, budgetAllowed: false },
      { profileId: 'reliable', compatible: true, enabled: true, successRate: 0.9, averageWallTimeMs: 5 },
      { profileId: 'slow', compatible: true, enabled: true, successRate: 0.9, averageWallTimeMs: 10 },
    ] })).toMatchObject({ selectedProfileId: 'reliable', excluded: [{ profileId: 'cheap', reason: 'budget' }] })
  })
})
