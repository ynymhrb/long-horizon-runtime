# Long-Task runtime live-research audit (2026-08-25)

## Context

Two DSH sessions ran the same research request ("适合中国投资者的低回撤核心组合")
in the same workspace (`D:\code\test`): a native single-turn session
(`session-dab00f0f`) and a long-task session (`session-d4a0ff5b`) that drove the
`long_task_create` runtime. The long-task session created four goals; the first
three failed, and the fourth only succeeded after the model reverse-engineered
runtime constraints (local-only data to avoid the 5-minute child timeout, and
artifact `type: "analysis"` to satisfy V1 validation). This record keeps the
findings and the resulting fix in the audit trail.

## Observed failure modes (ordered by impact)

1. **Terminal failure orphaned a pending replan proposal.** Each failed goal
   ended in `FAILED` with a `pendingProposal` (revision 2) attached, yet
   `availableActions` was empty. `long_task_confirm` rejected with "goal is not
   awaiting confirmation" and `long_task_resume` with "goal is not paused", so
   the proposal could never be accepted and completed work could not be reused.
2. **5-minute hard child timeout surfaced as an opaque abort.** `executionTimeoutMs`
   defaults to `300000` (`cordis.patch.yml` and `tools.ts`); `dsh-adapters.ts`
   wraps every child in `AbortSignal.timeout(300000)`. Research tasks that
   download 10 years of market data cannot finish in one child turn, so they
   settled as `DSH child stopped: aborted` (dsh-adapters.ts:84) with no hint
   that this was a timeout or how to fix it.
3. **Artifact type contract is invisible to children.** The child JSON schema
   accepts any `type: string` (dsh-adapters.ts RESULT_SCHEMA) while validation
   accepts only the seven V1 types (`plan`, `analysis`, `code_patch`,
   `command_result`, `test_report`, `review`, `note` — artifacts.ts:25,
   scheduler.ts:229). Children naturally chose `markdown`/`json`/`report` and
   failed with an error that does not list the valid types; retries did not
   converge because `priorFailureSummary` did not teach the accepted set.
4. **`long_task_create` (auto mode) blocks inside the tool call.** `createGoal`
   runs `runUntilIdle` synchronously, so one tool call blocked ~30 minutes and
   returned an already-failed goal; the model could not observe progress or
   confirm a proposal before the goal was terminalized.

## Root cause of failure mode 1 (fixed)

In `scheduler.runRound`, the round-end terminalization appended `GoalFailed`
whenever a task was `FAILED` and nothing was pending — even when
`onTerminalFailure` had just appended `PlanProposed` (goal →
`AWAITING_CONFIRMATION`) or a failed replan planner had appended `GoalPaused`
(goal → `PAUSED`). Event order in the observed session was exactly
`DecisionRecorded → PlanProposed → CheckpointCreated → GoalFailed`, so the
confirmation state existed only for an instant before being overwritten.

## Fix (this commit)

`scheduler.runRound` now reads the goal state inside the terminalization
transaction and skips `GoalFailed` when the goal is no longer `RUNNING` (i.e.
the replan flow already decided `AWAITING_CONFIRMATION` or `PAUSED`). The
pending proposal stays confirmable, and a planner failure leaves the goal
paused per the V1 "await confirmation" policy.

Regression tests added in `tests/runtime.spec.ts`:
- "keeps a scheduler-triggered unsafe automatic replan awaiting confirmation
  instead of failing the goal" — full scheduler path: terminal failure →
  unsafe replan → `AWAITING_CONFIRMATION` with `confirm` action; confirming
  applies revision 2 and succeeds.
- "pauses a goal when the automatic replan planner itself fails, instead of
  failing it" — planner throws during replan → goal stays `PAUSED` with an
  `automatic_replan_failed` decision.

## Follow-up fixes (child budget and artifact contract visibility)

* **Actionable timeout failure (P0-2):** `dsh-adapters.ts` now distinguishes a
  timeout abort from an operator/other abort. The failed summary becomes
  `DSH child stopped: timeout after <ms>ms; consider raising executionTimeoutMs
  or splitting the task` instead of the opaque `DSH child stopped: aborted`.
* **Per-task timeout override (P0-2):** a planner task may declare a positive
  integer `timeoutMs` (validated in `graph.ts`, carried on `TaskNode`,
  forwarded through `Scheduler.executeOne` to the execution adapter). It
  overrides the deployment default, which itself is the fallback. This lets a
  known-heavy task (e.g. data acquisition) get more budget without raising the
  global default.
* **Artifact type contract visible to children (P0-3):** the seven V1 types are
  now a single shared constant `V1_ARTIFACT_TYPES` in `domain.ts`. The child
  result schema enumerates them as an `enum`, the execution prompt lists them
  explicitly, and both validation errors (`scheduler.ts`, `artifacts.ts`) name
  the rejected type and list the valid ones, so a retry can converge.
* **Create-mode documentation (P1-1):** `long_task_create`'s description now
  states that `planning_mode: "auto"` executes the whole DAG synchronously and
  only returns at a terminal/awaiting state, directing callers to
  `require_confirmation` or polling when they need visibility.

## Remaining known issues (not fixed in this commit)

- Child timeout is still a hard 5-minute default with an opaque failure
  message; consider surfacing timeout as the reason and allowing per-goal or
  per-task overrides.
- Artifact type contract is still invisible to children; consider enumerating
  valid types in the RESULT_SCHEMA/execution prompt and in the validation error.
- `long_task_create` (auto mode) still executes synchronously; consider
  returning a RUNNING goal for the caller to observe.

---

## Resolved follow-ups (supersedes the previous list)

The three items above were all addressed in a follow-up commit:

* **Timeout reason + per-task override** — `dsh-adapters.ts` reports
  `DSH child stopped: timeout after <ms>ms; consider raising
  executionTimeoutMs or splitting the task` when the child budget fires, and a
  planner-declared task `timeoutMs` overrides the deployment default
  (validated in `graph.ts`, threaded through `Scheduler` → adapter).
* **Artifact type contract visibility** — the seven V1 types are a single
  shared `V1_ARTIFACT_TYPES` constant; the result schema enumerates them, the
  execution prompt lists them, and both the scheduler and artifact-store
  validation errors name the rejected type and list the valid set.
* **Create-mode documentation** — `long_task_create`'s description now warns
  that `planning_mode: "auto"` runs the whole DAG synchronously and only
  returns at a terminal/awaiting state, and points to `require_confirmation`
  or polling for visibility.

Tests: timeout surfacing and per-task override in `tests/dsh-adapters.spec.ts`;
`timeoutMs` validation in `tests/graph.spec.ts`; scheduler forwarding and the
actionable artifact-type error in `tests/runtime.spec.ts`; result-schema enum
in `tests/dsh-adapters.spec.ts`.

---

## Model-facing execution visibility (option B)

The long-task audit and the Claude/LangGraph/OpenAI comparison concluded that
real-time streaming into the parent model's turn (Claude's cross-post style)
is out of scope for this plugin: it requires harness round-execution support,
and the synchronous `auto` create (V1 "superstep ownership") makes an
in-turn stream architecturally impossible. The chosen level is option B —
incremental, model-addressable reads of the execution trail that already
exists durably:

* **`long_task_events` (goal_id, cursor?, limit?, task_id?)** — pages
  `runtime_events` oldest-first with an `afterSeq` cursor. Events are projected
  to a compact summary (`EventSummary`) that **excludes `context`, `content`,
  and `tasks` payload keys**, so polling a long goal does not flood the model
  context with context manifests or inline artifacts. Honours
  `workspaceScope` isolation like every other model tool.
* **`long_task_attempt_sessions` (goal_id, task_id?)** — resolves the durable
  child session IDs (`dshSessionId`) of execution attempts. The model returns
  these to the user so they can jump into the subagent's own conversation log
  (the same `.jsonl.zstd` format as a native session). Honours
  `workspaceScope` isolation.

Both are pure reads on existing projections (`RuntimeEventStore.listEvents`,
`listAttempts`) plus a new scope assertion; no storage, lifecycle, or recovery
semantics change. Tests: summary projection, cursor paging, attempt session
resolution, scope rejection, and unknown-task nulls in `tests/task-api.spec.ts`;
tool registration in `tests/plugin.spec.ts`.
