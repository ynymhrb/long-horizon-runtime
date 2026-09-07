import { describe, expect, test } from 'vitest'
import { ProfileRouter, normalizeExecutionProfiles } from '../src/execution-profiles.js'

describe('execution profiles', () => {
  const profiles = normalizeExecutionProfiles({
    defaultProfile: 'default',
    profiles: [
      { id: 'default', providerName: 'spawn', capabilities: ['research'] },
      { id: 'fast', providerName: 'spawn-fast', capabilities: ['research', 'code'], toolDeny: ['shell'], timeoutMs: 30_000, agentOptions: { model: 'fast' } },
    ],
  })

  test('resolves a compatible declared profile and snapshots effective restrictions', () => {
    const router = new ProfileRouter(profiles)
    expect(router.resolve({ task: { executionProfile: 'fast', requiredCapabilities: ['research'] }, defaultTimeoutMs: 60_000 })).toMatchObject({
      id: 'fast', providerName: 'spawn-fast', capabilities: ['research', 'code'], toolDeny: ['shell'], timeoutMs: 30_000, selectionReason: 'task selected fast',
    })
  })

  test('rejects an unknown or capability-incompatible profile without fallback', () => {
    const router = new ProfileRouter(profiles)
    expect(() => router.resolve({ task: { executionProfile: 'missing' }, defaultTimeoutMs: 60_000 })).toThrow('unknown execution profile: missing')
    expect(() => router.resolve({ task: { executionProfile: 'default', requiredCapabilities: ['code'] }, defaultTimeoutMs: 60_000 })).toThrow('does not provide required capability: code')
  })

  test('rejects duplicate profile IDs during normalization', () => {
    expect(() => normalizeExecutionProfiles({ profiles: [{ id: 'same', providerName: 'spawn' }, { id: 'same', providerName: 'other' }] })).toThrow('duplicate execution profile: same')
  })
})
