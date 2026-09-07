export type { BudgetLimit } from './domain.js';
import type { BudgetLimit } from './domain.js';
export interface BudgetUsage {
    readonly attempts: number;
    readonly wallTimeMs: number;
    readonly estimatedTokens: number;
    readonly estimatedCostMicros: number;
}
export type BudgetReservation = BudgetUsage;
export type BudgetReservationResult = {
    readonly ok: true;
    readonly limit: BudgetLimit;
} | {
    readonly ok: false;
    readonly reason: string;
};
export declare function combineBudgetLimits(goal?: BudgetLimit, task?: BudgetLimit): BudgetLimit;
export declare class BudgetLedger {
    private current;
    constructor(initial?: BudgetUsage);
    get usage(): BudgetUsage;
    reserve(input: {
        readonly goal?: BudgetLimit;
        readonly task?: BudgetLimit;
        readonly estimate: BudgetReservation;
    }): BudgetReservationResult;
    settle(reservation: BudgetReservation, actual: BudgetReservation): void;
    release(reservation: BudgetReservation): void;
}
