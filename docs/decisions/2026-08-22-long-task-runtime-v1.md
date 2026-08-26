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

## V4 task-area integration decisions

* **Model-created task binding:** `long_task_create` goes through `TaskControlApi.create` with the live parent Agent's session ID. It therefore records the origin link and sets the session's one current-task binding; calling `runtime.createGoal` directly would create a valid task that the originating conversation cannot surface in its task strip.
* **Host boundary:** browser code uses only the Typert `longTasks` remote. Every remote method takes a single named input object with no default parameter, because the DSH gateway rejects a source method that uses parameter defaults, destructuring, or rest parameters.
* **Cross-session intent:** merely viewing a task never changes its links. “附加到当前会话” creates the durable link and current binding together; a linked but non-current task exposes “设为当前任务”, while the actual current task shows a disabled “当前会话任务” state.
* **V4b controls:** confirmation, pause/resume, cancellation, external-effect resolutions, and replan rejection all use the durable `controlRevision`. Plan edits remain conversation-led: the Cockpit explains that a change request produces a reviewable replan rather than exposing an unsafe in-browser graph editor.

## V4 visual-navigation decisions

* **DAG, not a tree:** `dependsOn` is kept as a true directed acyclic graph. The Cockpit may fold an exclusive downstream subgraph, but a join node with another visible prerequisite is never hidden or duplicated. Folding is therefore a view projection, not a plan rewrite.
* **Operator-friendly density:** the profile-wide Task Area is a sorted vertical list rather than a card grid. Runnable/awaiting work appears before paused, draft, failed, cancelled, and completed history; newest durable activity breaks ties.
* **Native visual language:** the current-task strip follows the DSH GoalBar's compact 36px composition and uses host theme tokens rather than fixed dark colors. Its icon actions open the task, pause/resume where valid, and hide only the session display binding; they never delete durable task provenance.
* **Stable DAG viewport:** the Cockpit uses a fixed logical SVG canvas rather than a content-sized viewBox, so folding a branch cannot enlarge the remaining nodes. “适应视图” deliberately scales the complete graph when desired; normal navigation pans the stable canvas. Node labels are truncated at the graph boundary, and selection changes color rather than frame geometry.
* **Pre-plan history:** a Goal that ended during planning can legitimately have no plan revision or DAG. The Task Area presents its durable goal state and events as “no plan” history, rather than treating a `null` graph response as an in-flight request.
* **Goal changes and autonomy:** original user goals are versioned independently of task IDs and graph revisions. User edits always produce a reviewable replacement; automatic replanning is enabled only for terminal failures and applies solely to bounded read-only changes that preserve completed nodes and verified outputs. All other candidates await confirmation.
* **Deletion lifecycle:** deletion means cancel then archive. Archive visibility is reversible for 30 days; expiry is the sole path to physical removal of a task's durable projections and artifacts.

## V4 lifecycle-delivery decisions

* **Retention cleanup:** activation and every Task Area list run a 30-day archive sweep. File-backed artifacts are removed only after the archival projections are deleted and no remaining projection refers to the same content-addressed path.
* **Session navigation:** `shell.overlay` receives no session-opening callback. The client plugin injects DSH's `sessions` service and calls `ctx.sessions.open(sessionId)` after the host remote resolves a durable task-session link. Historic tasks created before session-link persistence remain readable and show an attach instruction instead of a misleading failed jump.
* **Conversation stop:** a stopped DSH turn is neither a validation failure nor evidence for replanning. The same abort signal now reaches initial planning and task children. An interrupted active attempt emits `TaskInterrupted`, pauses its goal, and waits for an explicit later resume; it cannot increment plan revisions or spawn replacement children.

## Open-source routing and V5 profile decisions

* **Public entry point:** Long Horizon Runtime is a standard-chat capability, not a user-selectable “long-task mode”. The public installer must leave ordinary users in their normal DSH preset and make durable long work available through `long_task_*` tools, the Task Area, and a routing policy. The former `long-task` preset is not a public capability gate; its successor is the internal `task-orchestrator` execution profile.
* **Routing policy:** a named `long-task:routing` system-prompt section decides only between no goal, DSH-native lightweight goals, and runtime-owned durable goals. It gives durable task IDs (`lt_…`) and explicitly long, resumable, DAG/subagent, cross-session, auditable, or plan-review work precedence for `long_task_*`; it forbids creating a native and a durable goal for the same objective. New long tasks default to `require_confirmation`.
* **Delegated-child exclusion:** DSH spawn children compose their parent preset, so a static preset section would leak into planner and worker sessions. The routing section must be a dynamic text provider: it returns `''` when the assembled agent has subagent origin or positive subagent depth. Empty sections are omitted by DSH rendering. This is prompt hygiene, not an authorization boundary.
* **Delegated-child authority fence:** every planner and execution child is started with a deny-list that removes all `long_task_*` lifecycle tools and DSH native goal-management tools. DSH's in-process `spawn` provider applies `toolFilter` both to the child schema and execution surface. A child cannot recursively create, resume, edit, or cancel a parent task even if a future prompt regresses.
* **Routing modes:** `advisory` is the packaged default: both native goal tools and runtime tools remain visible and the routing section guides selection. `strict` is an advanced deployment configuration: for a top-level user Agent, native `create_goal`, `get_goal`, and `update_goal` are omitted from that Agent's assembled tool schema; normal one-turn work still creates no goal. Strict mode must be scoped to the model-facing Agent assembly, never applied by a Host-global `tools.restrict()`, and must be verified against DSH's tool-call validation before being advertised as a hard enforcement boundary.
* **V5 boundary:** V5 routes each DAG node to an internal `AgentProfile` (`task-orchestrator`, `task-generalist`, then specialist profiles). Profile identity, selected provider/model, persona, and tool restriction are recorded with the execution attempt, while task state, artifact, retry, recovery, and event semantics stay profile-neutral.
