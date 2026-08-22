# Long-Task Runtime V1.1–V4 Design

## Status

Approved design for the runtime control plane and the next three published
versions. V1 remains frozen except for defect fixes.

## Goal

Make a durable long task independently addressable across conversations,
recoverable through explicit policy, explainable through durable context and
evidence, locally replannable, and controllable through an out-of-tree DSH
browser plugin.

## Version boundaries

```text
V1      durable DAG, attempts, artifacts, validation
V1.1    control plane, cross-session identity, recovery policy, unified API
V2      context manifests, artifacts, layered memory
V3      evidence-driven local replanning
V4      out-of-tree task UI (read-only V4a, control-capable V4b)
```

The design is shared before implementation so that V2, V3, and V4a may be
developed against V1.1 contracts in parallel. V4b waits for the real V1.1
control API.

## Terminology

The product calls the aggregate a **long task** and gives it a persistent,
copyable **Task ID**. Runtime source continues to use `Goal` for the aggregate
and `TaskNode` for a DAG leaf; this avoids conflating the aggregate with an
individual planned node.

## V1.1: control plane and cross-session model

### Durable and live state

A goal is durable and independently addressable. It contains its Task ID,
current revision, `workspaceScope`, plan, audit history, and goal-intent state.
`workspaceScope` is a same-profile compatibility check, not a multi-user access
control system.

`TaskSessionLink` records the relation between a goal and DSH sessions:

- `origin`: the conversation that created it;
- `attached`: a conversation that may inspect or continue it;
- `execution-child`: a DSH child session created for an attempt.

The links are audit/context references, not task ownership. Any conversation in
the same profile can find a task by Task ID and attach to it when its workspace
is compatible.

`ExecutionLease` is deliberately process-local. It binds one execution to a
live parent Agent, abort signal, and revision. It is never written to SQLite.

The durable task-intent state is distinct from its derived execution-observation
state. Intent covers plan confirmation, activation, pause, and terminal result.
Observation is derived from attempts, active leases, checkpoints, and
interruptions: idle, leased, running, interrupted, or waiting for a recovery
decision.

### Interruption and recovery policy

An interruption is a durable fact, not an implicit pause. `ExecutionInterrupted`
records a cause (`user_stop`, `timeout`, `process_loss`, or `child_failure`),
affected attempts, the final checkpoint, and recovery eligibility.

`RecoveryPolicy` consumes those facts and returns one of:

- `requeue`;
- `wait_for_live_parent`;
- `require_resolution`;
- `terminate`.

This keeps policy replaceable: the domain state machine does not hardcode what
every deployment does after Stop or restart. V1.1 does not introduce an
unattended runner. Automatic continuation may occur only when the policy allows
it and an attached conversation supplies a live parent Agent; otherwise the
task remains durably eligible but does not execute.

Indeterminate external effects require `require_resolution`. The decision is an
explicit `retry` or `confirmed_succeeded` command, persisted with its reason.

### Public service contract

`TaskQueryApi` is the read contract used by model tools and the browser client:

- `listTasks(filter, cursor)`;
- `getTask(taskId)`;
- `listEvents(taskId, cursor)`;
- `getTaskGraph(taskId, revision?)`;
- `getAttempt(taskId, attemptId)`;
- `getArtifact(taskId, artifactId)`.

Every list has a cursor and every snapshot exposes its revision.

`TaskControlApi` is the only mutation contract:

- `create(request, invocation)`;
- `attachSession(taskId, invocation)`;
- `update({ taskId, expectedRevision, action, payload }, invocation)`.

Actions cover plan confirmation, attach/detach, pause, resume, cancellation,
external-effect resolution, and constrained graph changes. A stale revision
returns a conflict containing the latest snapshot and performs no scheduling
side effect. The existing six tools remain compatibility adapters while the
model-facing surface converges on `long_task_create`, `long_task_get`, and
`long_task_update`.

### Continuing from a new conversation

For “continue `lt_xxx`”, the model reads the task, checks its workspace scope,
attaches the current session, then submits a revision-fenced resume. The current
Agent becomes an `ExecutionLease`; if the selected policy permits it, the
scheduler starts a new attempt. The session then displays its persistent task
strip. A Task ID is a locator, not a replacement for workspace compatibility.

## V2: explainable context, artifacts, and memory

Each attempt records a `ContextManifest`. It is the authoritative explanation
of its assembled input: goal summary, current node, direct dependency artifacts,
constraints, decisions, evidence, selected memories, source references, and
selection reason.

`ContextSelectionPolicy` first satisfies declared input contracts and direct
dependencies, then chooses relevant memory within the attempt budget. It cannot
silently admit invalidated artifacts.

Memory remains inspectable and source-linked:

- L0: ephemeral attempt `ContextView`;
- L1: task-node completion/failure summaries and references;
- L2: controlled project constraints, architectural decisions, and reusable
  facts;
- L3: episodic summaries derived from the event stream.

V2 records `ContextManifestRecorded` and `MemoryRecorded`. Vector or learned
retrieval is deferred to V7.

## V3: evidence-driven local replanning

Failure, validation evidence, or a new fact creates a `ReplanProposal`; it does
not mutate the DAG directly. A proposal contains the base revision, trigger
evidence, affected dependency closure, constrained `GraphMutation`, and expected
artifact consequences.

The proposal is created and decided through revision-fenced V1.1 control
commands. Policy may accept automatically, await confirmation, or reject it.
Acceptance writes a new plan revision, resets only the affected downstream
closure, and preserves unrelated successful nodes, active artifacts, and all
history. Core events are `ReplanProposed`, `ReplanAccepted`,
`ReplanRejected`, and `PlanRevisionApplied`.

## V4: out-of-tree browser plugin

The package gains a `./client` browser entry declared with `dsh.client`. It is
loaded through DSH's public Client Module system and Slots; no source change or
rebuild of the DSH Web application is required. Browser code reads and mutates
only through a versioned Host-to-Client `TaskUiApi` bridge and never accesses
SQLite.

### Entry points

- `conversation.input.dock`: current-session task strip, rendered only for an
  attached task;
- `sidebar.footer.action`: an always-visible Task Area entry;
- `shell.overlay`: the full Task Area overlay, which preserves the underlying
  conversation when opened and closed.

### Task Area

The sidebar entry always opens a profile-wide task overview. It supports Task
ID paste/search and filters for task state, workspace, pending decision, and
recent activity. Cards show objective, Task ID, progress, current or last node,
reason, latest activity, and workspace.

Selecting a task opens its cockpit:

- the cockpit header renders Task ID, workspace, revision, progress,
  execution observation, and a return to the overview;
- the main pane renders the versioned DAG and allows historical-revision
  selection;
- the inspector renders the selected node's objective, attempts,
  `ContextManifest`, artifacts, evidence, validation, child sessions, and a
  task/node-filtered event and decision timeline.

Selections are linked between the graph and inspector.

### DAG renderer

The V4 renderer is a read-only, dependency-faithful SVG view, not a workflow
editor. It receives durable task nodes and their `dependsOn` edges only; it
does not infer delegation, causality, or scheduler state from model text.

Layout is deterministic and ranked left-to-right: a task's topological rank
sets its horizontal position and Task ID establishes the stable ordering within
one rank. Reopening a task, polling fresh data, or selecting another node must
not arbitrarily move unchanged nodes. Nodes use the durable task state
(`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED`, and terminal
invalidation states) as their visual status.

The graph supports only the inspection interactions needed for V4: select a
node, pan the blank canvas, zoom around the pointer, and fit the graph to the
available viewport. Selecting a node updates the inspector and highlights its
direct dependency edges. V4 does not permit drag-to-rewire, graph editing,
manual layout, or a third-party workflow-editor dependency. This keeps the
out-of-tree client compact and makes the visual projection independently
testable from durable runtime data.

V4a is read-only. V4b adds confirmation, attach-current-session, pause,
resume, cancellation, and replan-proposal controls through `TaskControlApi`.
Every write presents the target revision; a conflict refreshes the displayed
snapshot rather than retrying silently.

The client consumes committed event increments by cursor through subscription
or polling. During a connection failure it retains the last valid snapshot and
marks it stale; after reconnect it catches up from the cursor. It never derives
scheduler state or makes local state transitions.

## Parallel implementation and acceptance

| Workstream | May begin after | Merge condition |
| --- | --- | --- |
| V1.1 control plane | immediately | public event and API contract passes replay tests |
| V2 context/memory | V1.1 types/events freeze | manifests and memory projections replay correctly |
| V3 replan | V1.1 contract freeze; V2 may be mocked | integrates with real V2 evidence/context API |
| V4a UI | query API mock freeze | external browser plugin loads and reads real projections |
| V4b UI | V1.1 controls stable | every UI write matches model-tool event semantics |

Acceptance includes: cross-session Task ID continuation; distinct interruption
causes without orphaned execution; no side effects on stale revisions;
source-linked and replayable context; local replan preservation of unrelated
success; external plugin installation with no DSH Web changes; cursor recovery;
and the full path create → execute → stop → continue in a new session → inspect
evidence → locally replan → complete.
