import { describe, expect, test } from 'vitest'
import { validateExecutionResult } from '../src/adapters.js'

describe('execution result validation', () => {
  test('rejects a success that declares neither an artifact nor explicit no_artifact', () => {
    expect(validateExecutionResult({ status: 'succeeded', summary: 'finished', artifacts: [], evidence: [] })).toEqual({
      ok: false, reason: 'successful task declared no artifact',
    })
  })
})
