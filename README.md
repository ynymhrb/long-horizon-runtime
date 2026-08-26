# DSH Long-Task Runtime

`@deepseek-ai/dsh-long-task-runtime` is a durable, single-machine control plane for long-running DSH goals. It stores plans, attempts, outputs, validation, and recovery state in its own SQLite event log; DSH child sessions provide planning and execution but are never the source of task state.

## Install and configure

Install this package through `dsh plugin --profile web add <tarball-or-package>`. Its `dsh.bundle` declaration contributes `cordis.patch.yml` to the profile composition, which mounts both the host runtime and its web client without editing DSH source. `plannerProvider` and `executionProvider` are names from `ctx.subagents.list()` (for example, an installed `spawn` provider). The package declares its DSH dependencies as peer dependencies so the host controls the compatible harness version.

Required settings are `databasePath`, `artifactDirectory`, `plannerProvider`, and `executionProvider`. Optional settings are `maxConcurrentTasks` (default 1), `defaultPlanningMode` (`auto` by default), `executionTimeoutMs` (default 300000), `retryPolicy.maxAttempts` (default 1), `artifactInlineLimitBytes` (default 65536), `autoReplan` (default true in the DSH plugin), `defaultAgentProfile`, `routingMode` (`advisory` by default), and profile-local `workspaceScope`.

The plugin exports `apply(ctx, config)`. It calls `ctx.provide('longTaskRuntime', runtime)` so other DSH plugins can use the same durable service. It registers the six V1 compatibility tools plus the V1.1 task-ID control API:

- `long_task_create`
- `long_task_confirm`
- `long_task_status`
- `long_task_resume`
- `long_task_cancel`
- `long_task_invalidate`
- `long_task_get`
- `long_task_update`
- `long_task_edit_goal`
- `long_task_accept_replan`

New tasks use an `lt_` ID. `long_task_get` supports a new chat continuing a task by ID; `long_task_update` uses `controlRevision` as its compare-and-swap guard. This is separate from the plan/DAG `revision`.

The package also exposes a DSH web client at `@deepseek-ai/dsh-long-task-runtime/client`. The loader discovers it from `dsh.client`; it adds a global Task Area action, a task strip only for chats with a current task, and an additive overlay. No `apps/web` source modification is needed.

## Standard-chat routing

Long Horizon Runtime is available from normal DSH chat; users do not need to select a “long-task mode”. The plugin contributes a routing policy to top-level conversations:

- explicit `lt_` task IDs and requests to continue, inspect, pause, resume, edit, or cancel a long task use `long_task_*` tools;
- work that is resumable, cross-session, DAG/subagent based, auditable, or requires plan review uses `long_task_create` and defaults to `require_confirmation`;
- short, single-session progress tracking may use DSH's native goal tools; ordinary one-shot work creates no goal.

The plugin never asks planner or worker children to make that choice. Their routing section renders empty, and their DSH `toolFilter` removes both `long_task_*` lifecycle tools and native goal-management tools. This prevents a delegated task node from recursively creating or changing the parent task.

`routingMode: advisory` is the default and keeps native goal schemas visible. `routingMode: strict` is an advanced deployment option: it omits native `create_goal`, `get_goal`, and `update_goal` schemas from root conversation turns, so any persistent goal created by the model uses Long Horizon Runtime. It does not create a task for ordinary one-shot requests, and it does not modify DSH source or a user profile's local patch.

## Goal changes, automatic replanning, and deletion

“修改原始目标” creates an append-only goal version and asks the planner for a new revision. The replacement waits for confirmation, while automatic replanning is limited to a terminal validation failure whose candidate changes only unfinished `read_only` work and leaves completed nodes and verified artifacts intact. Any external-effect, completed-work, or scope-changing candidate waits for confirmation.

Deleting a task cancels active work and archives it. Archived tasks are hidden from the default Task Area list and can be restored for 30 days; profile maintenance purges expired task records and their associated projections. The Cockpit also exposes status legend, readable event timeline, and the task's attached-session navigation target.

Each tool requires a current DSH parent Agent. Planner and worker children are started with `ctx.subagents.start(providerName, request)`, receive a structured JSON schema, and are always disposed after settlement. A missing parent Agent is rejected rather than creating an orphan child.

## Execution semantics

Planning creates a validated DAG. Task attempts run in isolated one-shot child sessions. The runtime only accepts declared task output after result validation, and it persists event history separately from DSH session history. On restart, safe `read_only` / `idempotent` work can retry; an interrupted `external_effect` task is paused when recovery cannot establish whether the effect occurred.

The children must return schema-conforming JSON. Planner output must contain `revision` and `tasks`; worker output must contain `summary`, `artifacts`, and `evidence`. If a provider does not deliver `structured` output, the adapter accepts an exactly JSON final text response instead.
