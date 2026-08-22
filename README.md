# DSH Long-Task Runtime

`@deepseek-ai/dsh-long-task-runtime` is a durable, single-machine control plane for long-running DSH goals. It stores plans, attempts, outputs, validation, and recovery state in its own SQLite event log; DSH child sessions provide planning and execution but are never the source of task state.

## Install and configure

Install this package alongside a compatible DSH deployment, then add the configuration shown in [examples/cordis.yml](examples/cordis.yml). `plannerProvider` and `executionProvider` are names from `ctx.subagents.list()` (for example, an installed `spawn` provider). The package declares its DSH dependencies as peer dependencies so the host controls the compatible harness version.

Required settings are `databasePath`, `artifactDirectory`, `plannerProvider`, and `executionProvider`. Optional settings are `maxConcurrentTasks` (default 1), `defaultPlanningMode` (`auto` by default), `executionTimeoutMs` (default 300000), `retryPolicy.maxAttempts` (default 1), `artifactInlineLimitBytes` (default 65536), and `defaultAgentProfile`.

The plugin exports `apply(ctx, config)`. It calls `ctx.provide('longTaskRuntime', runtime)` so other DSH plugins can use the same durable service. It also registers six stateless model tools:

- `long_task_create`
- `long_task_confirm`
- `long_task_status`
- `long_task_resume`
- `long_task_cancel`
- `long_task_invalidate`

Each tool requires a current DSH parent Agent. Planner and worker children are started with `ctx.subagents.start(providerName, request)`, receive a structured JSON schema, and are always disposed after settlement. A missing parent Agent is rejected rather than creating an orphan child.

## Execution semantics

Planning creates a validated DAG. Task attempts run in isolated one-shot child sessions. The runtime only accepts declared task output after result validation, and it persists event history separately from DSH session history. On restart, safe `read_only` / `idempotent` work can retry; an interrupted `external_effect` task is paused when recovery cannot establish whether the effect occurred.

The children must return schema-conforming JSON. Planner output must contain `revision` and `tasks`; worker output must contain `summary`, `artifacts`, and `evidence`. If a provider does not deliver `structured` output, the adapter accepts an exactly JSON final text response instead.
