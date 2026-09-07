export type { BudgetLimit } from './domain.js'
import type { BudgetLimit } from './domain.js'

export interface BudgetUsage {
  readonly attempts: number
  readonly wallTimeMs: number
  readonly estimatedTokens: number
  readonly estimatedCostMicros: number
}

export type BudgetReservation = BudgetUsage
export type BudgetReservationResult = { readonly ok: true; readonly limit: BudgetLimit } | { readonly ok: false; readonly reason: string }

export function combineBudgetLimits(goal?: BudgetLimit, task?: BudgetLimit): BudgetLimit {
  return compact({
    maxAttempts: minimum(goal?.maxAttempts, task?.maxAttempts),
    maxWallTimeMs: minimum(goal?.maxWallTimeMs, task?.maxWallTimeMs),
    maxEstimatedTokens: minimum(goal?.maxEstimatedTokens, task?.maxEstimatedTokens),
    maxEstimatedCostMicros: minimum(goal?.maxEstimatedCostMicros, task?.maxEstimatedCostMicros),
  })
}

export class BudgetLedger {
  private current: BudgetUsage
  constructor(initial: BudgetUsage = zeroUsage()) { this.current = { ...initial }; validateUsage(this.current) }
  get usage(): BudgetUsage { return { ...this.current } }
  reserve(input: { readonly goal?: BudgetLimit; readonly task?: BudgetLimit; readonly estimate: BudgetReservation }): BudgetReservationResult {
    validateUsage(input.estimate)
    const limit = combineBudgetLimits(input.goal, input.task)
    for (const [limitField, usageField] of [['maxAttempts', 'attempts'], ['maxWallTimeMs', 'wallTimeMs'], ['maxEstimatedTokens', 'estimatedTokens'], ['maxEstimatedCostMicros', 'estimatedCostMicros']] as const) {
      const maximum = limit[limitField]
      if (maximum !== undefined && this.current[usageField] + input.estimate[usageField] > maximum) return { ok: false, reason: `${limitField} exhausted` }
    }
    this.current = add(this.current, input.estimate)
    return { ok: true, limit }
  }
  settle(reservation: BudgetReservation, actual: BudgetReservation): void { validateUsage(reservation); validateUsage(actual); this.current = add(subtract(this.current, reservation), actual) }
  release(reservation: BudgetReservation): void { validateUsage(reservation); this.current = subtract(this.current, reservation) }
}

function minimum(left: number | undefined, right: number | undefined): number | undefined { if (left === undefined) return right; if (right === undefined) return left; return Math.min(left, right) }
function compact(value: Record<string, number | undefined>): BudgetLimit { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as BudgetLimit }
function zeroUsage(): BudgetUsage { return { attempts: 0, wallTimeMs: 0, estimatedTokens: 0, estimatedCostMicros: 0 } }
function add(left: BudgetUsage, right: BudgetUsage): BudgetUsage { return { attempts: left.attempts + right.attempts, wallTimeMs: left.wallTimeMs + right.wallTimeMs, estimatedTokens: left.estimatedTokens + right.estimatedTokens, estimatedCostMicros: left.estimatedCostMicros + right.estimatedCostMicros } }
function subtract(left: BudgetUsage, right: BudgetUsage): BudgetUsage { const value = { attempts: left.attempts - right.attempts, wallTimeMs: left.wallTimeMs - right.wallTimeMs, estimatedTokens: left.estimatedTokens - right.estimatedTokens, estimatedCostMicros: left.estimatedCostMicros - right.estimatedCostMicros }; validateUsage(value); return value }
function validateUsage(value: BudgetUsage): void { for (const [name, amount] of Object.entries(value)) if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError(`${name} must be a non-negative safe integer`) }
