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

## Reference model: DSH native same-session Goal

DSH's native `GoalService` is the reference for a *current-session objective*,
not for the long-task scheduler. Its useful design rules are deliberately
adopted where they fit; its same-session execution semantics are not copied.

### Native rules worth preserving

- A session has one current Goal slot. It is event-sourced in that session's
  log as complete post-mutation snapshots; clearing writes a revisioned
  tombstone rather than deleting history.
- Every durable change is compare-and-set against an exact `{ id, revision }`.
  A stale mutation fails rather than applying to a newer state.
- Durable phase (`active`, `paused`, `blocked`, `complete`) is separate from
  process-local continuation activation. A resumed session is deliberately
  disarmed; an explicit resume action is required before another round starts.
- Its GoalBar reads the host's authoritative session projection instead of
  owning a second client cache. It shows no strip for absent, cleared, or
  completed goals; mutations are single-flight and surface rejected Remote
  errors inline while waiting for the authoritative projection to catch up.
- The native round driver treats a Stop/cancellation as a lifecycle fact: it
  prevents automatic continuation and durably pauses a goal that had an
  admitted/reserved goal round. A human message can preempt the automatic
  continuation queue.

### Boundary: why long tasks differ

The native Goal belongs to one live Agent and one session log, executes
sequentially against that conversation's retained history, and has one current
objective by construction. A long task instead has a profile-local Task ID,
an SQLite event stream, DAG nodes, isolated child attempts, artifacts, and
cross-session provenance. Its durable state must never be reconstructed from
one chat's native Goal projection.

Long-task recovery policy also remains independent: native Goal intentionally
requires explicit rearming after a session-start edge, whereas a long-task
deployment may choose policy-driven recovery when it has a suitable live
parent. The two systems must not silently pause, resume, or complete each
other.

### Adopted session-binding rule

`TaskSessionLink` remains the complete, many-to-many audit relation: a task
may be linked to many conversations and a conversation may retain links to
many tasks. In addition, each conversation owns exactly one nullable
`currentTaskId` binding for its task strip and default Task Area target.

Changing that binding is an explicit, revisioned long-task event. Attaching or
continuing a task may set it, and a user may switch it from the Task Area;
switching never erases older links. A fresh ordinary conversation has no
binding and therefore no long-task strip. When a task reaches a terminal state
the strip hides by default, while its link and inspection history remain.

The long-task strip follows native GoalBar interaction discipline: it reads a
server-owned `currentTaskForSession` projection, never invents local status,
single-flights controls, sends the current control revision, reports errors
inline, and refreshes from the authoritative result or projection. It is a
separate dock card after the native GoalBar, so a native session Goal and a
linked long task can coexist without either UI replacing the other.

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
- `conversation.session.header.actions`: a Task Area entry for every
  non-blank conversation; it is the entry point when the session has no
  current long task;
- `shell.overlay`: the full Task Area overlay, which preserves the underlying
  conversation when opened and closed.

The plugin does not add a sidebar Task Area action. A new ordinary chat has no
long-task strip, but its session-header Task Area action still opens the
profile-wide inventory. This keeps the long-task UI additive and avoids
changing DSH Web source.

### Task UI read and control contract

The browser uses one versioned `TaskUiApi` remote surface. It is the only
source of Task Area data and the only route for browser mutations; browser
code never reads SQLite or reaches `LongTaskRuntime` directly.

| Method | Result and purpose |
| --- | --- |
| `listTasks({ filter, cursor })` | Cursor page of compact task summaries for the profile-wide overview. A summary contains Task ID, objective, task state, current revision, progress counts, current/last node, waiting reason, last activity, and workspace label. |
| `getTask({ taskId })` | Full current task snapshot for the Cockpit. |
| `getTaskGraph({ taskId, revision? })` | Immutable graph snapshot for the requested revision, including nodes, `dependsOn` edges, and revision metadata. |
| `listTaskEvents({ taskId, cursor, taskNodeId? })` | Cursor page of durable task events, optionally narrowed to one selected node. |
| `getCurrentTaskForSession({ sessionId })` | The nullable authoritative current-task projection used by the conversation strip. |
| `updateTask({ taskId, expectedRevision, action, payload, sessionId })` | Revision-fenced browser control command. It returns either the updated task snapshot or a conflict carrying the newest snapshot. |

The remote host validates the Task ID, state transition, workspace
compatibility, and expected control revision. The client submits no local
state transition. Every mutation is single-flight per task, disables its
originating controls while pending, displays a rejected remote error inline,
and replaces stale UI state with the returned snapshot or conflict snapshot.

`TaskControlApi` remains the domain implementation behind `updateTask`.
Its browser actions are: `confirm`, `attach_current_session`,
`set_current_for_session`, `pause`, `resume`, `cancel`,
`resolve_external_effect`, `accept_replan`, and `reject_replan`. No direct
browser mutation edits a node or rewires an edge. A plan change begins as a
V3 replan proposal and applies only through its revision-fenced decision.

### Session binding and navigation

`TaskSessionLink` is durable provenance, while `currentTaskId` is the
conversation's one nullable display binding. The binding is persisted through
explicit `TaskSessionCurrentSet` and `TaskSessionCurrentCleared` events and
is projected by session ID. A task may have many links; changing the current
binding never deletes them.

The following flows are normative:

1. Creating a long task records the origin link and sets it as that
   conversation's current task.
2. In a new conversation, “continue `lt_xxx`” attaches the session after the
   workspace check, then sets the task as current before the caller submits a
   revision-fenced resume.
3. In the Task Area, “attach to this conversation” first creates the link and
   then sets the binding. “Set as current” requires an existing compatible
   link.
4. The task strip opens its bound task's Cockpit. The Cockpit can switch the
   current binding but cannot silently do so while merely inspecting another
   task.
5. A Cockpit session link uses DSH's ordinary `ctx.sessions.open(sessionId)`
   only when that session is present in the browser's live session list. A
   terminal or absent child session remains inspectable text, not a false
   navigation button.

### Task strip and state presentation

The long-task strip is a dock card after DSH's native GoalBar. It is rendered
only when `getCurrentTaskForSession` yields a non-terminal task. It contains
the long-task glyph, a concise task-state label, truncated objective, progress
`succeeded / total`, and either the running node or the durable pause/block
reason. Clicking its body opens the bound task Cockpit; controls expose only
the actions currently advertised by the authoritative task snapshot.

Task state is presentation data, not a client inference:

| Durable value | UI label and treatment |
| --- | --- |
| `AWAITING_CONFIRMATION` | Awaiting confirmation; amber and confirmation action. |
| `RUNNING` | Running; blue, with active node when one exists. |
| `PAUSED` | Paused; amber, with the durable pause/interruption reason. |
| `SUCCEEDED` | Completed; green; hidden from the strip by default but retained in the overview. |
| `FAILED` | Failed; red; hidden from the strip by default but retained in the overview. |
| `CANCELLED` | Cancelled; neutral; hidden from the strip by default but retained in the overview. |

Node colors use their durable state independently: `PENDING`/`READY` neutral,
`RUNNING` blue, `BLOCKED` amber, `SUCCEEDED` green, `FAILED` red, and
`INVALIDATED`/`SUPERSEDED`/`CANCELLED` muted. A selected node highlights its
direct incoming and outgoing dependency edges.

The DSH composer Stop button retains its native meaning: it aborts the current
conversation generation. It is not rendered as a long-task pause control and
does not itself claim to alter durable task state. Long-task pause/resume is
always explicit through `TaskUiApi`; an interrupted task is displayed only
after its durable interruption/recovery state is recorded.

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

The view may fold an exclusive downstream subgraph. A join node with another
visible prerequisite remains visible rather than being duplicated into a tree;
the renderer therefore preserves true DAG semantics while reducing clutter.
It offers individual fold controls plus expand-all, fold-all, and fit-view.

V4a is read-only. V4b adds confirmation, attach-current-session, pause,
resume, cancellation, and replan-proposal controls through `TaskControlApi`.
Every write presents the target revision; a conflict refreshes the displayed
snapshot rather than retrying silently.

The client consumes committed event increments by cursor through subscription
or polling. V4 uses bounded polling while the Task Area or a task strip is
visible: refresh the compact current-task projection and selected task
snapshot, then fetch events after the newest stored cursor. During a connection
failure it retains the last valid snapshot and marks it stale; after reconnect
it catches up from the cursor. It never derives scheduler state or makes local
state transitions.

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
