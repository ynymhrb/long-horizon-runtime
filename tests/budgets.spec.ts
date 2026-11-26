import { describe, expect, test } from 'vitest'
import { BudgetLedger, combineBudgetLimits } from '../src/budgets.js'

describe('budget ledger', () => {
  test('takes the stricter goal and task limits before reserving', () => {
    expect(combineBudgetLimits({ maxAttempts: 2, maxWallTimeMs: 100 }, { maxAttempts: 1, maxWallTimeMs: 200 })).toEqual({ maxAttempts: 1, maxWallTimeMs: 100 })
    const ledger = new BudgetLedger({ attempts: 1, wallTimeMs: 0, estimatedTokens: 0, estimatedCostMicros: 0 })
    expect(ledger.reserve({ goal: { maxAttempts: 2 }, task: { maxAttempts: 1 }, estimate: { attempts: 1, wallTimeMs: 10, estimatedTokens: 0, estimatedCostMicros: 0 } })).toEqual({ ok: false, reason: 'maxAttempts exhausted' })
  })

  test('settles and releases reservations without consuming twice', () => {
    const ledger = new BudgetLedger({ attempts: 0, wallTimeMs: 0, estimatedTokens: 0, estimatedCostMicros: 0 })
    expect(ledger.reserve({ goal: { maxAttempts: 2 }, estimate: { attempts: 1, wallTimeMs: 10, estimatedTokens: 2, estimatedCostMicros: 3 } })).toMatchObject({ ok: true })
    ledger.release({ attempts: 1, wallTimeMs: 10, estimatedTokens: 2, estimatedCostMicros: 3 })
    expect(ledger.usage).toEqual({ attempts: 0, wallTimeMs: 0, estimatedTokens: 0, estimatedCostMicros: 0 })
  })
})
