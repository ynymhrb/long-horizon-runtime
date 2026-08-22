# Long-Horizon Agent Runtime V1 validated design

## Status

User-reviewed implementation design for `@deepseek-ai/dsh-long-task-runtime`, an out-of-tree DSH plugin.

## Goal

Provide a durable, single-machine control plane for long-running user goals. A DSH conversation creates and controls work, but the runtime's SQLite event stream is the authority for plans, task attempts, outputs, recovery, and operator decisions.

## Scope

V1 creates an independently publishable ESM TypeScript pnpm package. It integrates with the DSH source checkout at `D:\code_github\deepseek-harness` through public `@deepseek-ai/dsh-*` peer dependencies, and uses local workspace links for development and composition tests.

V1 includes a validated task DAG, child-agent planning and execution, SQLite persistence, synchronous durable checkpoints, focused execution context, artifacts and evidence, retry and recovery, constrained graph revisions, and model-facing chat tools. It excludes a graphical UI, free-form conditional graphs, distributed execution, vector retrieval, heterogeneous routing policies, and environment rollback.

## Runtime ownership

The package exports a Cordis plugin `apply(ctx, config)`. It creates `LongTaskRuntime` and exposes it as `ctx.longTaskRuntime`; this service owns all durable state transitions. It registers six model-facing tools through `ctx.tools`: `long_task_create`, `long_task_confirm`, `long_task_status`, `long_task_resume`, `long_task_cancel`, and `long_task_invalidate`.

The tools are stateless adapters. Future UI, HTTP, or CLI consumers call `LongTaskRuntime` methods directly and cannot bypass its validation or persistence rules.

```text
Chat Agent or future UI
  -> stateless tool/API adapter
    -> LongTaskRuntime
      -> event store, projections, scheduler, context and artifact services
        -> DSH child agents through PlannerAdapter or ExecutionAdapter
```

## Domain model

```text
Goal
  -> PlanRevision (validated DAG version)
       -> TaskNode (logical work specification)
            -> TaskAttempt (immutable child-agent execution)
                 -> Artifact / Evidence / ValidationResult
  -> Decision
  -> Checkpoint
```

- `Goal` stores immutable objective and constraints, planning mode, active plan revision, lifecycle state, and accounting totals.
- `PlanRevision` contains one complete validated dependency DAG. A graph change always creates a later revision; it never mutates historical records.
- `TaskNode` stores a stable logical task identifier, objective, dependencies, `inputContract`, `outputContract`, completion criteria, priority, retry policy, `sideEffectClass`, validator reference, and active state.
- `TaskAttempt` is one immutable execution. It records its DSH child Session ID, agent profile snapshot, prepared `ContextView`, timestamps, cost/token information when available, terminal outcome, and declared output references.
- `Artifact` is a versioned typed output with content hash, storage location, MIME type, source attempt, active state, and supersession relation.
- `Evidence` records a source such as a file path, command result, external fact, or artifact. `ValidationResult` records which validator accepted or rejected a task output. `Decision` captures a user, planner, or runtime-policy choice and cites supporting evidence.
- `Checkpoint` stores the event sequence, plan revision, scheduler configuration, ready-set summary, verified output references, and optional `environmentSnapshotRef`. V1 records but does not create or restore environment snapshots.

Task states are `PENDING`, `READY`, `RUNNING`, `BLOCKED`, `SUCCEEDED`, `FAILED`, `INVALIDATED`, `SUPERSEDED`, and `CANCELLED`. Goal states are `DRAFT`, `AWAITING_CONFIRMATION`, `RUNNING`, `PAUSED`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. Task attempts add terminal `INTERRUPTED`.

Each task declares one of these side-effect classes:

- `read_only`: recovery can safely retry after an interruption.
- `idempotent`: recovery can retry using a stable operation key.
- `external_effect`: recovery first runs a recovery validator against the actual workspace or external target. A proven effect converges to success; an indeterminate effect pauses the Goal for operator confirmation.

## Persistence and replay

`runtime_events` is append-only and is the source of truth. Every event has a monotonic sequence number, timestamp, aggregate identifiers, event type, and JSON payload. Core events include `GoalCreated`, `PlanProposed`, `PlanConfirmed`, `PlanRevisionApplied`, `TaskAttemptStarted`, `ArtifactProduced`, `ValidationRecorded`, `TaskCompleted`, `TaskFailed`, `TaskInterrupted`, `TaskInvalidated`, `GoalPaused`, `GoalCancelled`, and `CheckpointCreated`.

Read-optimized SQLite projections are `goals`, `plan_revisions`, `task_nodes`, `task_edges`, `task_attempts`, `artifacts`, `evidence`, `validation_results`, `decisions`, `memories`, and `checkpoints`. The runtime can rebuild all projections solely from `runtime_events`; a replay test compares rebuilt and live projections.

Before invoking DSH, the scheduler atomically writes `TaskAttemptStarted` and its task-running projection. On completion it atomically records artifacts, validation, the attempt outcome, task state, and any resulting checkpoint. A process restart marks every attempt lacking a terminal event as `INTERRUPTED`; it never assumes a killed model request completed.

## Planning and graph revisions

`PlannerAdapter` starts a configured DSH child agent and requires structured JSON containing the initial task DAG. Planner output must include task IDs, objectives, dependencies, input/output contracts, completion criteria, priority, retry policy, and side-effect class. `DagValidator` rejects duplicate IDs, self dependencies, cycles, missing dependencies, unreachable nodes, malformed fields, illegal states, and invalid contracts before a plan becomes a `PlanRevision`.

`planningMode` is `auto` or `require_confirmation`. In confirmation mode, the initial plan and every valid mutation pause as a durable proposed revision until `long_task_confirm` accepts it. In auto mode, a valid proposed revision becomes active immediately.

Allowed mutations are `addTask`, `replaceTask`, `addEdge`, and `invalidateTask`. Every mutation cites a reason and evidence references. Applying one constructs a complete new candidate DAG, validates it, writes a new `PlanRevision`, and preserves old nodes and artifacts as history. Invalidation traverses only the affected node's reachable downstream region; unrelated completed branches remain active.

## Scheduling, execution, and validation

The scheduler operates in super-steps. It derives READY nodes only when all dependencies succeeded and every required dependency artifact is active and has a passing validation result. It orders tasks by dependency readiness, descending priority, then creation order, dispatching no more than `maxConcurrentTasks` per round.

`DshExecutionAdapter` starts one isolated, one-shot DSH child agent per task attempt using `ctx.subagents.start`. It stores the child Session ID but treats the DSH Session only as raw interaction evidence, not runtime state. The adapter returns a structured task result and declared artifacts; it cannot update task state directly.

On an adapter success, the runtime persists artifacts and evidence, invokes the configured task validator, and marks the task successful only after validation passes. Failed validation is a task failure with evidence. Adapter or model failures use the task retry policy; every retry creates a distinct task attempt. Exhaustion fails the task and blocks only dependent nodes.

After every completed scheduling round, the runtime writes a synchronous checkpoint. Completed, validated tasks remain completed if another task in the same super-step fails or the process exits.

## Context, artifacts, evidence, and memory

`ContextBroker` prepares a bounded `ContextView` containing:

1. Goal brief and constraints.
2. Current task objective, input contract, output contract, and completion criteria.
3. Active, validated artifacts from direct dependencies only.
4. L1 task completion or failure summaries with source references.
5. Relevant L2 project constraints and architecture decisions.
6. Relevant evidence and a recent retry or failure summary.

It never supplies an unbounded parent transcript. Small text and JSON artifacts are stored inline in SQLite. Larger payloads are stored under `artifactDirectory`; SQLite stores their content hash, MIME type, path, source attempt, and active/superseded metadata. V1 artifact types are `plan`, `analysis`, `code_patch`, `command_result`, `test_report`, `review`, and `note`. A successful task produces a validated artifact or an explicit validated `no_artifact` output.

L0 is ephemeral `ContextView`; L1 is structured task memory; L2 is controlled project memory; L3 is derived from the event stream and Goal summary. Retrieval uses structured tags and source links. Vector retrieval is deferred.

## Controls and configuration

`LongTaskRuntime` exposes `createGoal`, `confirmGoal`, `getStatus`, `resumeGoal`, `cancelGoal`, and `invalidateTask`. Each method validates the requested lifecycle transition, writes durable events, and returns a query view. Status includes the current plan revision, task and attempt states, verified artifacts, recent decisions/events, accounting, pauses, and available actions.

`cordis.yml` configuration must validate `databasePath`, `artifactDirectory`, `maxConcurrentTasks`, `defaultPlanningMode`, `executionTimeoutMs`, `retryPolicy`, `artifactInlineLimitBytes`, `plannerProvider`, `executionProvider`, and `defaultAgentProfile`. V1 targets Node `^22.19.0 || >=24.0.0`, TypeScript 6, Vitest 4, and Node's built-in `node:sqlite` `DatabaseSync`; it introduces no native SQLite dependency.

## Acceptance tests

1. Invalid planner DAGs cannot become runnable.
2. Dependency readiness, priority, and configured concurrency control dispatch; independent ready nodes can complete in one super-step.
3. A dependent attempt receives only active, validated artifacts from direct dependencies in its `ContextView`.
4. A process restart does not rerun completed, validated tasks; interrupted attempts follow their side-effect-class recovery policy.
5. An idempotent retry creates a new attempt while preserving history.
6. An indeterminate `external_effect` interruption pauses for confirmation rather than replaying blindly.
7. Confirmation, pause, cancel, invalidation, and plan revision replay into the same projection state.
8. A focused DSH composition test covers chat tool to runtime to child agent to recorded DSH Session and artifact persistence.
9. Replacing or splitting a task creates a new PlanRevision while preserving unrelated successful work and historical artifacts.

## Rationale

The design follows the planner/executor separation demonstrated by Plan-and-Act, DAG-scoped planning and local replanning from Task-Decoupled Planning, task-level writes plus super-step checkpointing from LangGraph, and isolated-context artifact handoffs used by DeepAgents. It reserves aligned environment snapshot references for the recovery direction explored by AgentRewind without expanding V1 into environment rollback.
