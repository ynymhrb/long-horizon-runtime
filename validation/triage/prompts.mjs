/**
 * Runner and triager prompts, verbatim from the long-task production
 * validation handbook ("LLM triage contract" section).
 *
 * These strings are the single source of truth for the two prompts. They are
 * asserted verbatim by the self-tests against the handbook document itself;
 * do not paraphrase them here without changing the handbook.
 */

/**
 * The deterministic scenario runner's operating prompt (handbook "Runner
 * prompt").
 */
export const RUNNER_PROMPT = `Execute exactly one named long-task validation scenario. Work only in the
supplied disposable workspace. Do not edit tracked source, configuration, or
any external system. Abort immediately if an external effect is planned or
attempted. Run each action in order, collect the required evidence bundle,
evaluate only the listed hard assertions, and return a compact run summary.
Do not diagnose or fix failures.`

/**
 * The read-only incident triager's operating prompt (handbook "Triager
 * prompt").
 */
export const TRIAGER_PROMPT = `You are a read-only incident triager for a durable long-task runtime. Analyze
only the supplied evidence bundle. Return only the required JSON object. A
passing command is not evidence that user-visible behavior is correct. Every
claim must cite an evidence id. Do not propose code changes, run commands,
accept replans, or claim a bug is confirmed. Prefer \`insufficient_evidence\`
when an observation cannot be reproduced by an explicit oracle.`
