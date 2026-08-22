# Long-Task Runtime V1 implementation decisions

## Development dependency links

The published package declares DSH packages as peer dependencies. Local development links its DSH dev dependencies to `D:\code_github\deepseek-harness` package directories so tests compile against the requested checkout rather than a mismatched registry release. `@deepseek-ai/cordis` is version `4.0.1`; it is not part of the `0.1.0-rc.7` DSH package version family.

## DSH plugin boundary

The plugin uses `ctx.provide('longTaskRuntime', runtime)` rather than assigning a property, and every model-facing handler requires the current `ToolRunContext.agent`. The agent is retained in an `AsyncLocalStorage` scope only while the tool invokes the runtime, allowing planner and worker adapters to call `ctx.subagents.start(providerName, request)` without persisting a live Agent object.

The adapters request DSH structured output, fall back to parsing a final JSON text response for compatible providers, and always call `run.dispose()` in `finally`. Worker results include the returned child session id as `dshSessionId`; the scheduler must persist that id in a follow-up event because the attempt-start event precedes child creation.

## Final V1 correctness rulings

* **Superstep ownership:** model-facing create, confirm, and resume calls advance the goal through every immediately runnable superstep, rather than stopping after the first ready set. A Goal terminal event is emitted only once all tasks succeed, or after an exhausted task failure. This makes a one-shot DSH tool call complete a finite DAG without a hidden polling loop.
* **Retry and failure distinction:** a failed *attempt* is recorded independently from a failed logical task. Dependents are blocked only by `TaskFailed` after the retry budget is exhausted; a retry returns the node to `PENDING` and retains its attempt history.
* **External-effect recovery:** an interrupted external-effect attempt is never replayed automatically when recovery cannot prove its outcome. It becomes `BLOCKED`, the goal is durably paused, and an operator must invalidate/replace it before running a new action.
* **Idempotency:** every attempt has a deterministic `goalId:taskId:revision` idempotency key in its durable start event. Providers may use this to deduplicate idempotent external calls; the runtime does not claim exactly-once effects.
* **Artifact lifecycle:** artifacts are stored through the configured `ArtifactStore`; content is inline only below its limit and otherwise content-addressed on disk. Applying an invalidation revision deactivates artifacts only for the invalidated downstream region; unrelated successful nodes and artifacts remain active.
* **Published surface:** the build writes `dist/`, exactly matching the package export map. `dist/` is deliberately ignored by Git and is produced by `pnpm build` before packing; `pnpm pack --dry-run` and an ESM import are release checks.
* **Historical revisions:** task projections are keyed by goal, task, and revision. Runtime status reads only the goal's current revision while immutable `plan_revisions` and prior task rows remain auditable.
* **Cancellation:** cancellation terminalizes every active attempt and all nonterminal nodes in the current revision. A late child result is ignored after the durable goal cancellation event.
* **Artifact handoff:** file-backed artifacts are SHA-256 verified before their text is included in a child context. Output contracts may constrain `artifactTypes` and `mimeTypes`, and validation failures cannot activate task output.
* **Startup recovery:** plugin activation reconciles persisted attempts immediately, but does not execute a DSH child without a live parent Agent. Read-only/idempotent attempts become eligible for the next explicit resume; indeterminate external effects pause the goal.

## Final hardening rulings

* **Portable validation:** the built-in planner emits the `required` validator, which validates the runtime result and output contracts without requiring an operator-defined validator registry. Other names remain explicit deployment policy and reject when unregistered.
* **Interrupted work:** every replayable interrupted attempt pauses its Goal after reconciliation. A subsequent `resume` carrying a live parent creates a fresh attempt; no previous successful node is replayed.
* **Revision semantics:** mutations are derived from current task projections, never stale serialized plan input. Replace/add-edge reset their affected downstream region to `PENDING` in the new revision and deactivate its old artifacts; unrelated successes remain active and historical revisions remain immutable.
* **Attempt safety:** context assembly, adapters, validators, and artifact persistence all run behind durable attempt terminalization. A failure after `TaskAttemptStarted` records a failed attempt rather than leaving a RUNNING orphan.
* **DSH provenance:** child Session IDs are recorded immediately when `subagents.start` returns, before awaiting child output, and are retained for stopped or malformed outputs.
* **Artifact boundary:** V1 accepts only the seven documented artifact types. MIME strings are syntactically checked and `outputContract.mimeTypes` requires a matching declared MIME value.

## Final review decisions

* **Revision fencing:** every attempt is bound to the plan revision written in `TaskAttemptStarted`. A child result from an obsolete revision is retained as `SUPERSEDED`, but it cannot validate artifacts or transition the current logical task. Projection-level completion fencing provides the same protection while replaying an event log.
* **Confirmed graph mutations:** proposal metadata includes both invalidated and stale task ids. Confirmation carries that metadata into the applied revision, so stale artifacts are deactivated even when a mutation waits for operator approval.
* **External recovery authority:** an indeterminate external effect remains `BLOCKED` and its Goal remains paused. `resume` must explicitly choose `retry` or `confirmed_succeeded`, records that decision, and activation recovery never infers the choice from the existence of a live parent Agent.
* **Deterministic scheduling:** equal-priority tasks use planner-array creation order, stored in the projection, rather than lexical task IDs as the stable scheduling tie-break.
* **Bounded contextual layers:** execution contexts retain direct prerequisite summaries at L1 and goal constraints, decisions, and evidence at L2. Raw artifact handoff remains limited to validated direct dependencies.

## V1.1 control-plane decisions

* **Two revision counters:** `revision` remains the immutable plan/DAG revision. `controlRevision` advances for session attachment and control actions, and is the compare-and-swap value exposed to task UI and tools. This prevents a pause from looking like a graph rewrite.
* **Cross-session scope:** task IDs use the `lt_` prefix and session links are durable profile-local provenance records. `workspaceScope` is a compatibility guard, not an authorization system; multi-user access control remains explicitly out of scope.
* **Interruption policy:** `ExecutionInterrupted` records only the observed cause plus a selected recovery outcome. The runtime therefore does not impose a universal "Stop means pause" rule; callers can choose requeue, wait for a live parent, require resolution, or terminate.

## V2–V4 delivery decisions

* **Context manifest:** immediately before `TaskAttemptStarted`, the scheduler records a durable `ContextManifestRecorded` event. It stores the selected context and the selection rule, making the prompt assembly auditable without storing a live parent Agent.
* **Replanning authority:** a runtime graph change can be represented as `PlanProposed` with `baseRevision` and trigger evidence. Rejection restores the prior runnable state; acceptance continues through the existing confirmation path. This keeps replan review explicit while retaining the V1 append-only plan history.
* **Non-invasive task UI:** the published package exposes `./client` and a `dsh.client` web declaration. Its Task Area button, chat-only current-task strip, and overlay use only additive DSH slots (`sidebar.footer.action`, `conversation.input.dock`, `shell.overlay`). The UI bridge is a small host-provided `longTaskUi` façade; no DSH application files are patched.
* **Stop propagation:** the current DSH tool `AbortSignal` is relayed to the child attempt controller. The durable state transition remains policy-driven (`ExecutionInterrupted`) so a cancelled interaction never silently determines how work should recover.
