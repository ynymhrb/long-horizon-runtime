/** The seven artifact types the V1 runtime accepts from a completed child. */
export const V1_ARTIFACT_TYPES = ['plan', 'analysis', 'code_patch', 'command_result', 'test_report', 'review', 'note'];
/** Raised when planner or mutation data does not form a runnable DAG. */
export class PlanValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PlanValidationError';
    }
}
