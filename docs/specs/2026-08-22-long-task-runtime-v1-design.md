# Long-Horizon Agent Runtime V1 design

## Status

Proposed implementation design for an out-of-tree DSH plugin.

## Purpose

`@deepseek-ai/dsh-long-task-runtime` adds a durable, single-machine runtime for long-running user goals. It treats a DSH conversation as an entry point, not as the source of execution state. The runtime plans a goal into a versioned task graph, schedules individual task attempts through DSH child agents, persists progress in SQLite, and rebuilds focused context for every attempt.

The first release must let a chat user create a long task, review or automatically accept a plan, inspect progress, resume it after a process exit, cancel it, and apply safe local graph changes. A future UI must be able to use the same service API without duplicating runtime behavior.

## DSH integration

The plugin mounts beside existing DSH plugins; it does not modify `agent-loop`. It has two roles:

- `LongTaskRuntime` is a Cordis service registered as `ctx.longTaskRuntime`. It owns the runtime lifecycle and exposes programmatic query and control methods for future UI and plugin consumers.
- Model-facing tools are the chat entry points. They call the service but own no durable task state: `long_task_create`, `long_task_confirm`, `long_task_status`, `long_task_resume`, `long_task_cancel`, and `long_task_invalidate`.

Each task attempt is launched through an `ExecutionAdapter`. The initial adapter starts a distinct DSH child agent and records its DSH Session ID. The adapter receives a prepared context and returns an outcome plus declared artifacts. It cannot alter task state directly. This separation permits later adapters for different models, agent presets, or a DSH workflow-backed execution policy.

DSH's `dsh-workflow` remains optional infrastructure, not the task graph authority. Its documented lack of journaling and restart resume means it cannot own a long task's durable state.

### Required DSH source study

The DSH source checkout used for implementation is `D:\code_github\deepseek-harness`. The implementation must study the following source surfaces before it fixes plugin interfaces or starts V1 coding:

- Cordis plugin loading and profile composition, to package and mount the out-of-tree plugin correctly.
- `dsh-session`, to associate a Runtime Execution with its child Session and preserve durable references without making the Session the Runtime authority.
- `dsh-subagent` and the Agent registry, to start, cancel, and observe each isolated task execution.
- `dsh-tools`, to expose the chat entry tools and recover the current session Agent as the execution parent.
- `dsh-workflow`, to reuse compatible child-agent mechanics while retaining the Runtime's independent event log, checkpoint, and recovery behavior.
- Existing package and composition-test examples, to follow DSH's service, configuration, lifecycle, and test conventions.

The initial implementation does not need a full-repository study. Model adapters, shell, web, LSP, and unrelated capability packages remain out of scope unless an ExecutionAdapter introduces a concrete dependency on them.

## Runtime model

The principal entities are:

```text
Goal
  -> GraphVersion
       -> Task
            -> Execution (one or more attempts)
                 -> Artifact / Evidence
```

- A `Goal` stores the user objective, constraints, planning mode, current graph version, lifecycle status, and aggregate accounting.
- A `Task` is a stable logical unit with a goal, completion criteria, dependencies, retry policy, priority, and active status.
- An `Execution` is an immutable attempt of a task. It records the agent profile snapshot, DSH Session ID, prepared ContextView summary, timing, cost and token data when available, outcome, and produced artifacts.
- `Artifact` is a versioned, typed output. Its source execution, content hash, storage location, and active or superseded state are retained.
- `Evidence`, `Claim`, and `Decision` preserve why a task or graph mutation exists and what supports a conclusion.

Task states are `PENDING`, `READY`, `RUNNING`, `BLOCKED`, `SUCCEEDED`, `FAILED`, `INVALIDATED`, `SUPERSEDED`, and `CANCELLED`. Goal states are `DRAFT`, `AWAITING_CONFIRMATION`, `RUNNING`, `PAUSED`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. An `Execution` additionally has a terminal `INTERRUPTED` outcome used during crash recovery.

## Versioned task graph

The initial planner creates `Graph v1`, but it is not immutable. The graph uses LangGraph-inspired concepts without importing LangGraph or exposing arbitrary executable graph code:

- Tasks are graph nodes and dependencies are directed edges.
- A scheduler round is a super-step. Independent ready tasks may run in the same round, up to a configured concurrency limit.
- A completed round writes a checkpoint. Successful work is never rerun merely because a sibling failed or the process stopped.
- A confirmation or manual-review pause is a durable interrupt, not a live agent waiting indefinitely.

The V1 graph is a validated dependency DAG. It does not expose general conditional edges or arbitrary node functions. The `DagValidator` rejects duplicate IDs, self-dependencies, cycles, missing dependencies, unreachable nodes, illegal states, and malformed planner data before the graph becomes runnable.

Execution discoveries can change a graph through a versioned `GraphMutation`:

```text
GraphMutation {
  baseGraphVersion
  reason
  evidenceRefs
  operations: addTask | replaceTask | addEdge | invalidateTask
  proposedBy: user | planner | runtime-policy
}
```

A mutation can split an incomplete task into smaller tasks, replace an incorrect task, or invalidate only the downstream region that depends on a disproven task or artifact. The old task and artifacts remain in history, marked `SUPERSEDED` or `INVALIDATED`; unrelated completed branches stay active. The validator checks every mutation before it creates the next graph version. According to `planningMode`, a valid mutation is applied automatically or held for user confirmation. V1 supports this constrained mutation set; free-form graph programming, complex routing, and learned adaptive policies are deferred.

## Persistence and recovery

The plugin owns a local SQLite database. Append-only `runtime_events` is the source of truth; read-optimized tables are projections rebuilt from it:

```text
runtime_events
goals, graph_versions, tasks, task_edges, executions
artifacts, evidence, claims, decisions, memories, checkpoints
```

Every event has a monotonic sequence number, timestamp, aggregate IDs, type, and JSON payload. Core events include `GoalCreated`, `GraphPlanned`, `TaskCreated`, `TaskStarted`, `ExecutionStarted`, `ArtifactProduced`, `TaskCompleted`, `TaskFailed`, `TaskInvalidated`, `GraphMutated`, `CheckpointCreated`, `GoalPaused`, and `GoalCancelled`.

The scheduler writes an execution-start event and `TaskStarted` projection in one SQLite transaction before it invokes DSH. Terminal outcomes and artifacts are likewise committed transactionally. A new process finds executions without a terminal event, marks them `INTERRUPTED`, and applies their task retry policy. It never assumes an interrupted model request completed. A previously successful task and its active artifacts are not rerun.

V1 therefore guarantees recovery from a durable checkpoint, not continuation of an already-killed model request. Checkpoints contain the latest event sequence, projection version, graph version, ready-set summary, and scheduler configuration snapshot. They support future replay and fork workflows.

## Scheduling and execution

The scheduler derives `READY` tasks only when every dependency has succeeded and has an active, valid artifact where one is required. It chooses by dependency readiness, task priority, and creation order. `maxConcurrentTasks` defaults to one but is configurable.

On success, an execution declares artifacts, task memory, and evidence references; the task succeeds and may unlock downstream tasks. On failure, the scheduler applies a configured attempt limit and backoff. It creates a new execution for every retry. When attempts are exhausted, the task fails and dependent tasks remain blocked. Cancelling a goal cancels queued tasks and signals active execution adapters to stop; all history remains queryable.

## Context, artifacts, evidence, and memory

`ContextBroker` reconstructs a bounded `ContextView` for each execution:

```text
Goal brief and constraints
+ current task objective, inputs, and completion criteria
+ active artifacts from direct dependencies
+ L1 task memory
+ relevant L2 project memory
+ relevant evidence
+ recent failure or retry summary
```

The adapter does not inherit an unbounded transcript. DSH retains each child Session as raw interaction evidence, and the runtime stores its ID plus a contextual summary and artifact references.

Small text and JSON artifacts are stored in SQLite. Larger payloads live in the configured plugin data directory with hash, MIME type, path, execution source, and version metadata in SQLite. Initial types are `plan`, `analysis`, `code_patch`, `command_result`, `test_report`, `review`, and `note`. A successful task declares at least one artifact or an explicit `no_artifact` result.

Evidence records a file location, command result, external fact, or artifact. Claims cite evidence; decisions cite claims and explain task or graph changes. V1 memory has four levels:

- L0 working context is the ephemeral ContextView.
- L1 task memory is a structured completion or failure summary with source references.
- L2 project memory stores controlled project constraints, repository maps, and architecture decisions.
- L3 episodic memory is derived from the event stream and Goal summary rather than duplicated in a second log.

V1 uses structured tags and source links for retrieval. Vector retrieval is a future replaceable retriever.

## Chat experience and configuration

`long_task_create` creates a goal and asks the planner for a draft graph. `planningMode` supports `auto` and `require_confirmation`; the user chooses it in chat now and in the future task UI later. `long_task_confirm` starts a held graph or accepted mutation. `long_task_status` exposes goal progress, graph version, task states, active executions, recent events, artifacts, accounting, and available actions. Resume, cancel, and invalidation are explicit tools.

All deployment policy is validated plugin configuration in `cordis.yml`: database and artifact directories, concurrency limit, planning-mode default, execution timeout, retry/backoff policy, artifact size limit, and default agent profile. These values are not hardcoded.

## Error handling

Errors are classified by owner:

- Adapter or model failures are execution failures and may retry.
- Retry exhaustion is a task failure and blocks dependent tasks.
- A disproven result is an invalidation and may create a localized graph mutation.
- User confirmation and operator review are durable pauses.
- Process loss produces interrupted executions and recovery policy decisions.

All mutations and user controls are durable events. The runtime treats invalid planner or graph-change input as a visible validation error; it never silently repairs a malformed graph.

## Acceptance tests

1. An invalid planner DAG cannot become runnable.
2. Dependencies and configured concurrency control dispatch; unrelated ready tasks can execute in one super-step.
3. A successful task's active artifacts appear explicitly in its dependent task's ContextView.
4. After restart, completed tasks do not rerun and interrupted executions follow retry policy.
5. Retrying produces a distinct execution with preserved history.
6. Confirmation, pause, cancellation, invalidation, and graph mutation replay from events into the same projection.
7. A focused DSH composition test covers chat tool to runtime to child agent to DSH Session and artifact persistence.
8. Splitting or replacing a task makes a new graph version while preserving unrelated completed work and prior artifacts.

## Deferred work

The first release excludes a graphical task UI, free-form conditional graph execution, arbitrary dynamic routing, cross-machine execution, vector memory retrieval, learned routing, and heterogeneous agent selection policy. Its ExecutionAdapter and Agent Profile snapshot make those extensions additive. The future UI reads and controls `LongTaskRuntime` rather than implementing its own state transitions.

