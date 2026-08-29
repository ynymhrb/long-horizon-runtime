export function combineBudgetLimits(goal, task) {
    return compact({
        maxAttempts: minimum(goal?.maxAttempts, task?.maxAttempts),
        maxWallTimeMs: minimum(goal?.maxWallTimeMs, task?.maxWallTimeMs),
        maxEstimatedTokens: minimum(goal?.maxEstimatedTokens, task?.maxEstimatedTokens),
        maxEstimatedCostMicros: minimum(goal?.maxEstimatedCostMicros, task?.maxEstimatedCostMicros),
    });
}
export class BudgetLedger {
    current;
    constructor(initial = zeroUsage()) { this.current = { ...initial }; validateUsage(this.current); }
    get usage() { return { ...this.current }; }
    reserve(input) {
        validateUsage(input.estimate);
        const limit = combineBudgetLimits(input.goal, input.task);
        for (const [limitField, usageField] of [['maxAttempts', 'attempts'], ['maxWallTimeMs', 'wallTimeMs'], ['maxEstimatedTokens', 'estimatedTokens'], ['maxEstimatedCostMicros', 'estimatedCostMicros']]) {
            const maximum = limit[limitField];
            if (maximum !== undefined && this.current[usageField] + input.estimate[usageField] > maximum)
                return { ok: false, reason: `${limitField} exhausted` };
        }
        this.current = add(this.current, input.estimate);
        return { ok: true, limit };
    }
    settle(reservation, actual) { validateUsage(reservation); validateUsage(actual); this.current = add(subtract(this.current, reservation), actual); }
    release(reservation) { validateUsage(reservation); this.current = subtract(this.current, reservation); }
}
function minimum(left, right) { if (left === undefined)
    return right; if (right === undefined)
    return left; return Math.min(left, right); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function zeroUsage() { return { attempts: 0, wallTimeMs: 0, estimatedTokens: 0, estimatedCostMicros: 0 }; }
function add(left, right) { return { attempts: left.attempts + right.attempts, wallTimeMs: left.wallTimeMs + right.wallTimeMs, estimatedTokens: left.estimatedTokens + right.estimatedTokens, estimatedCostMicros: left.estimatedCostMicros + right.estimatedCostMicros }; }
function subtract(left, right) { const value = { attempts: left.attempts - right.attempts, wallTimeMs: left.wallTimeMs - right.wallTimeMs, estimatedTokens: left.estimatedTokens - right.estimatedTokens, estimatedCostMicros: left.estimatedCostMicros - right.estimatedCostMicros }; validateUsage(value); return value; }
function validateUsage(value) { for (const [name, amount] of Object.entries(value))
    if (!Number.isSafeInteger(amount) || amount < 0)
        throw new TypeError(`${name} must be a non-negative safe integer`); }
