import { validatePlan } from './graph.js';
/** Validate a planner's untrusted structured output. */
export async function planWithValidation(adapter, input) {
    return validatePlan(await adapter.plan(input));
}
/** Validate the minimum task-result contract before accepting a success. */
export function validateExecutionResult(result) {
    if (result.status === 'failed')
        return { ok: false, reason: result.summary };
    if (result.artifacts.length === 0 && result.summary.trim() !== 'no_artifact')
        return { ok: false, reason: 'successful task declared no artifact' };
    return { ok: true };
}
