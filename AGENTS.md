# Project Rules

## Long-task runtime configuration and deployment

The plugin bundle owns its default host configuration. When developing or
releasing this plugin, change defaults only in
`D:\code\long-horizon-runtime\cordis.patch.yml`. This file is installed into
every target profile by `dsh plugin --profile web add` and is the sole source
of truth for plugin defaults.

Do not edit a user's profile configuration to change plugin defaults.

For a machine-local deployment override that must not alter the packaged
plugin, edit only
`C:\Users\19632\.dsh\profiles\web\cordis.patch.yml`. Leave this user-layer
patch empty by default; use it only for an intentional local customization.

`C:\Users\19632\.dsh\.agent-presets\long-task\agent.cordis.yml` belongs to
the agent plane, not the Web host plane. It assembles what an agent session
looks like: the plugins it mounts and the tools and prompts visible to the
model. It mounts `long-task-runtime` in an isolate realm so the agent receives
the `long_task_*` tools.

The `databasePath` in that agent preset must resolve to the same SQLite file
configured by the installed host bundle. Tool writes and host/UI reads must
therefore always use one shared durable database.

## Long-task lifecycle and replan rules

### Task identity and original-goal versions

- A durable task ID never changes. A user edit changes the task's original
  goal through an append-only goal-version record, with the requested text,
  authoring source, timestamp, and required reason.
- A goal edit pauses scheduling and asks the planner for a new revision using
  the new goal, verified artifacts, and remaining work. Previous plans,
  events, and artifacts remain auditable.
- Preserve completed work only when the planner can prove it remains within
  the new goal's scope. Any affected downstream region is superseded in the
  next revision; external effects and scope-reducing changes require explicit
  confirmation.

### Automatic replanning

- A failed validation, missing dependency artifact, or recorded contradictory
  evidence may cause the runtime to request a local replan.
- Apply a proposal automatically only when it replaces uncompleted,
  `read_only` work, leaves verified artifacts and completed nodes intact, and
  does not expand the original goal's scope.
- Any proposal that touches external effects, invalidates completed work,
  expands scope, or cannot establish a bounded affected subgraph must pause
  the task awaiting confirmation. No replan may overwrite the current plan;
  every proposal is a revision-fenced, durable event.

### Task Area controls and accessibility

- The Cockpit exposes: modify original goal, pause/resume, jump to an attached
  current session, and delete/archive. It uses the same revision-fenced
  service API as model tools.
- “Modify original goal” opens a goal-and-reason form; it never offers an
  unsafe free-form DAG editor. “Jump to conversation” opens the task's current
  session link through DSH's injected `sessions` service, or guides the user
  to attach a session when none exists. Overlay slot props are never used for
  navigation because the host supplies no session callback there.
- Delete cancels active execution first, then archives the task. Archived
  tasks are hidden from the default list, recoverable for 30 days, and then
  physically purged with their plan revisions, events, links, and artifacts.
  Retention runs at plugin activation and before Task Area list queries; a
  file is removed only once no artifact projection references it.
- The DAG uses status-colored frames plus visible text labels and a persistent
  legend. Color is never the only state signal. The event panel is a readable
  chronological audit trail with timestamps, reason/impact summaries, and
  revision navigation rather than raw internal event names.

### Compatibility and failure presentation

- A historical task that fails before planning may have no plan revision or
  DAG. The UI must present its durable state and failure timeline as no-plan
  history, never as an indefinitely loading Cockpit.

# Task Lifecycle, Goal Revision, and Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [x]`) syntax for tracking.

**Goal:** Add durable goal-version editing, policy-gated automatic replanning,
archive/purge lifecycle management, and usable Cockpit controls without
modifying DeepSeek Harness source.

**Architecture:** The append-only runtime event log remains authoritative.
New lifecycle events project goal versions and archival state; a replan
orchestrator converts a user edit or classified execution failure into either
an applied safe revision or a durable confirmation proposal. The Typert remote
exposes only named DTO methods, and the browser consumes those methods for
controls, readable events, status legend, and session navigation.

**Tech Stack:** TypeScript, Node `node:sqlite`, Vitest, Cordis/Typert remotes,
React 18, DSH client slots.

**Design authority:** The lifecycle and replan rules directly above this plan.

## Global Constraints

- Modify only `D:\code\long-horizon-runtime`; do not modify DeepSeek Harness
  source or user-profile configuration.
- Keep task IDs stable and all non-purged changes append-only and
  revision-fenced.
- Never automatically apply a replan that touches external effects, completed
  work, verified artifacts, or original-goal scope.
- The browser uses only the `longTasks` Typert remote with a single named input
  object per method.
- Every behavior change begins with a focused failing Vitest test.

---

### Task 1: Durable goal-version and archive projections

**Files:**
- Modify: `src/event-store.ts`, `src/projections.ts`, `src/runtime.ts`, `src/domain.ts`
- Test: `tests/event-store.spec.ts`, `tests/durable-core.spec.ts`

**Interfaces:**
- Produces `GoalVersion { version, objective, reason, source, createdAt }` and
  `GoalProjection.archivedAt?: string`.
- Produces `LongTaskRuntime.editOriginalGoal(goalId, input, parent?, signal?)`,
  `archiveGoal(goalId, now)`, `restoreGoal(goalId)`, and
  `purgeArchived(before): PurgedGoal[]`.

- [x] **Step 1: Write failing projection tests**

```ts
test('projects a new original-goal version without changing its task id', () => {
  store.append([{ type: 'GoalCreated', goalId: 'lt_a', payload: { objective: 'old', constraints: [], planningMode: 'auto' } }])
  store.append([{ type: 'GoalObjectiveRevised', goalId: 'lt_a', payload: { version: 1, objective: 'new', reason: 'scope corrected', source: 'user', createdAt: '2026-08-23T00:00:00.000Z' } }])
  expect(store.listGoalVersions('lt_a')).toMatchObject([{ version: 0, objective: 'old' }, { version: 1, objective: 'new' }])
  expect(store.getGoal('lt_a')?.id).toBe('lt_a')
})

test('hides archived goals from the default inventory and restores them before purge', () => { /* archive, list(false), list(true), restore */ })
```

- [x] **Step 2: Run the focused tests and verify they fail because the APIs and projections do not exist.**

Run: `pnpm vitest run tests/event-store.spec.ts tests/durable-core.spec.ts -t "goal-version|archived"`

- [x] **Step 3: Add migrations and event projections.**

Create `goal_versions(goal_id, version, objective, reason, source, created_at,
created_order)` and add nullable `archived_at` to `goals` through idempotent
column migration. Project `GoalCreated` as version zero, and project
`GoalObjectiveRevised`, `GoalArchived`, and `GoalRestored`. Extend event reads
with `createdAt` from `runtime_events.created_at` for the UI timeline.

- [x] **Step 4: Implement runtime lifecycle methods.**

`archiveGoal` cancels only active goals before appending `GoalArchived`; terminal
goals archive directly. `restoreGoal` removes the archive marker but never
restarts cancelled execution. `purgeArchived` selects only archives older than
the supplied cutoff, removes file-backed artifacts through `ArtifactStore`,
then deletes the goal's projections and events transactionally.

- [x] **Step 5: Run focused tests, then commit.**

Run: `pnpm vitest run tests/event-store.spec.ts tests/durable-core.spec.ts -t "goal-version|archived"`

Commit: `git add src tests && git commit -m "feat: add goal versions and task archival"`

### Task 2: Planner-backed goal edits and policy-gated replan commands

**Files:**
- Modify: `src/adapters.ts`, `src/runtime.ts`, `src/task-api.ts`, `src/tools.ts`
- Test: `tests/runtime.spec.ts`, `tests/task-api.spec.ts`, `tests/plugin.spec.ts`

**Interfaces:**
- Extends `PlannerAdapter.plan()` input with `baseRevision`, `trigger`, and
  `priorTasks` as optional JSON-safe fields.
- Produces `TaskControlApi.editGoal(input, invocation)` and model tool
  `long_task_edit_goal`.
- Produces `TaskControlApi.acceptReplan()` and model tool
  `long_task_accept_replan`.

- [x] **Step 1: Write failing runtime tests.**

```ts
test('edits the original goal by pausing and proposing a new revision', async () => {
  const result = await runtime.editOriginalGoal(goal.id, { objective: 'new objective', reason: 'user correction' })
  expect(result.state).toBe('AWAITING_CONFIRMATION')
  expect(result.pendingProposal?.baseRevision).toBe(0)
  expect(result.objective).toBe('new objective')
})

test('automatically applies only a local read-only replan', async () => {
  const result = await runtime.requestAutomaticReplan(goal.id, safeReplacement)
  expect(result.state).toBe('RUNNING')
  expect(result.revision).toBe(1)
})

test('holds an external-effect replan for confirmation', async () => {
  expect((await runtime.requestAutomaticReplan(goal.id, externalReplacement)).state).toBe('AWAITING_CONFIRMATION')
})
```

- [x] **Step 2: Run focused tests and verify they fail because the commands do not exist.**

Run: `pnpm vitest run tests/runtime.spec.ts tests/task-api.spec.ts -t "original goal|automatic.*replan|external-effect.*replan"`

- [x] **Step 3: Implement one replan classification function.**

Add `classifyReplan(currentPlan, candidatePlan, trigger)` returning
`'auto_apply' | 'await_confirmation'` and reasons. It must reject automatic
application when task IDs of succeeded nodes change, any completed node becomes
invalidated/superseded, verified output is deactivated, a changed/new node has
`sideEffectClass: 'external_effect'`, or the candidate is not a bounded
downstream replacement. The function must be the sole source of the policy.

- [x] **Step 4: Implement goal editing and tool/API controls.**

Pause active scheduling with `scheduler.interrupt`, append
`GoalObjectiveRevised` and `DecisionRecorded`, ask the planner for the next
revision, classify it, and append either `PlanRevisionApplied` or
`PlanProposed` with a trigger and policy decision. Add revision-fenced accept
and reject methods to `TaskControlApi`; register `long_task_edit_goal` and
`long_task_accept_replan` with exact named parameters.

- [x] **Step 5: Run focused tests and commit.**

Run: `pnpm vitest run tests/runtime.spec.ts tests/task-api.spec.ts tests/plugin.spec.ts -t "original goal|automatic.*replan|accept.*replan"`

Commit: `git add src tests && git commit -m "feat: add policy-gated goal replanning"`

### Task 3: Automatic replan triggers from execution evidence

**Files:**
- Modify: `src/scheduler.ts`, `src/runtime.ts`, `src/domain.ts`
- Test: `tests/scheduler.spec.ts`, `tests/durable-core.spec.ts`

**Interfaces:**
- Produces `ReplanTrigger { kind: 'validation_failed' | 'missing_artifact' |
  'contradictory_evidence'; taskId, reason, evidenceRefs }`.
- Scheduler calls a runtime-owned `onReplanTrigger` callback only after it has
  durably recorded failure evidence and terminalized the attempt.

- [x] **Step 1: Write failing scheduler tests.**

```ts
test('emits a replan trigger after a terminal validation failure', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(triggers).toEqual([expect.objectContaining({ kind: 'validation_failed', taskId: 'a' })])
})

test('does not trigger replanning for a retriable attempt', async () => {
  await scheduler.runRound('g', undefined, parent)
  expect(triggers).toEqual([])
})
```

- [x] **Step 2: Run focused tests and verify the callback is missing.**

Run: `pnpm vitest run tests/scheduler.spec.ts -t "replan trigger"`

- [x] **Step 3: Add the callback after durable terminalization.**

Do not invoke the planner inside a projection transaction. After a task reaches
terminal validation failure or a required dependency artifact is demonstrably
missing, append `DecisionRecorded` evidence first, then invoke the runtime
callback. Ignore cancelled, archived, superseded, or already-proposed goals.

- [x] **Step 4: Connect the callback to planner-backed local replan.**

The runtime passes the current plan and trigger into the planner, verifies the
candidate through `validatePlan`, classifies it, and writes the outcome. A
planner failure appends `AutomaticReplanFailed` while leaving the currently
valid revision and goal state intact (or paused if the task is terminally
blocked).

- [x] **Step 5: Run focused tests and commit.**

Run: `pnpm vitest run tests/scheduler.spec.ts tests/durable-core.spec.ts -t "replan trigger|AutomaticReplan"`

Commit: `git add src tests && git commit -m "feat: trigger safe replans from execution evidence"`

### Task 4: Remote API, archived-task maintenance, and session navigation

**Files:**
- Modify: `src/task-ui-api.ts`, `src/remote.ts`, `src/tools.ts`
- Test: `tests/task-ui.spec.ts`, `tests/plugin.spec.ts`

**Interfaces:**
- `listTasks({ filter: { archived?: boolean } })` excludes archives by default.
- Produces remote methods `editTaskGoal`, `archiveTask`, `restoreTask`,
  `purgeArchivedTasks`, `acceptReplan`, and `getTaskNavigation`.
- `getTaskNavigation({ taskId })` returns `{ currentSessionId?: string,
  attachedSessionIds: string[] }` and never changes bindings.

- [x] **Step 1: Write failing API tests.**

```ts
test('lists archived tasks only when explicitly requested', () => { /* active and archived task expectations */ })
test('returns the bound current session for a task without changing any binding', () => { /* navigation DTO */ })
```

- [x] **Step 2: Run focused tests and verify the named remote/API methods are missing.**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/plugin.spec.ts -t "archived|navigation|editTaskGoal"`

- [x] **Step 3: Implement typed UI DTOs and revision-fenced commands.**

Use a single input object for every remote method. `archiveTask` receives the
displayed control revision, returns an applied/conflict result, and performs
the cancel-then-archive sequence. `purgeArchivedTasks` is host maintenance and
uses a cutoff timestamp; invoke it during plugin activation and before list
queries using a fixed 30-day cutoff.

- [x] **Step 4: Decorate and expose every remote method.**

Register each `Remote(...)` initializer in `src/remote.ts`, matching its public
method name exactly. Add model tools for edit/accept replan but keep physical
purge host-only.

- [x] **Step 5: Run focused tests and commit.**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/plugin.spec.ts -t "archived|navigation|editTaskGoal|acceptReplan"`

Commit: `git add src tests && git commit -m "feat: expose lifecycle controls to task UI"`

### Task 5: Cockpit controls, legend, and readable event timeline

**Files:**
- Modify: `client/TaskArea.js`, `client/TaskCockpit.js`, `client/TaskDag.js`,
  `client/task-presentation.js`, `client/index.js`
- Create: `client/task-events.js`, `client/task-events.d.ts`
- Test: `tests/task-cockpit.spec.ts`, `tests/task-graph.spec.ts`

**Interfaces:**
- `formatTaskEvent(event): { label, detail, tone }` maps durable events to
  human-readable timeline rows without losing revision and reason detail.
- `TaskDag` receives status presentation and renders a persistent legend.

- [x] **Step 1: Write failing presentation tests.**

```ts
test('formats a replan event with its impact and revision', () => {
  expect(formatTaskEvent({ type: 'PlanProposed', payload: { revision: 2, trigger: { reason: 'validator failed' } } })).toMatchObject({ label: '等待确认的重规划', detail: expect.stringContaining('修订 2') })
})

test('maps every visual task state to a visible label and legend tone', () => {
  expect(taskStatePresentation('BLOCKED')).toMatchObject({ label: '受阻', tone: 'error' })
})
```

- [x] **Step 2: Run focused tests and verify the formatter/legend mapping is absent.**

Run: `pnpm vitest run tests/task-cockpit.spec.ts tests/task-graph.spec.ts -t "formats a replan|legend"`

- [x] **Step 3: Implement the compact goal-edit modal and controls.**

The Cockpit renders `修改原始目标`, `暂停/继续`, `跳转到会话`, and
`删除` only when authorized by the current DTO. The edit modal requires both
nonblank objective and reason, sends `editTaskGoal`, and replaces its local
task snapshot from the response. Delete requests confirmation, then calls
`archiveTask`; restore appears only in archived-list mode.

- [x] **Step 4: Implement navigation and replan controls.**

Use the host session store only to resolve a returned `currentSessionId`; open
that session through the existing host navigation capability. If it is absent
or not loaded, show an actionable attach message. Render accept/reject for
proposed replans with the displayed control revision.

- [x] **Step 5: Render status legend and readable timeline.**

Place a labeled persistent legend next to DAG controls. Give state frames
theme-token colors for running, pending, awaiting confirmation, succeeded,
failed/blocked, paused, and cancelled/archive; retain textual state labels.
Replace raw event names with `formatTaskEvent` rows, relative/absolute
timestamps, details, and a revision-focus action where a graph revision exists.

- [x] **Step 6: Run focused tests and commit.**

Run: `pnpm vitest run tests/task-cockpit.spec.ts tests/task-graph.spec.ts`

Commit: `git add client tests && git commit -m "feat: add lifecycle controls to task cockpit"`

### Task 6: Full verification and live DSH acceptance

**Files:**
- Modify: `README.md`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`
- Test: all test suites

- [x] **Step 1: Document controls and safety policy.**

Document goal editing, automatic-replan limits, archive/restore/30-day purge,
and the fact that auto replan never applies external-effect or completed-work
changes.

- [x] **Step 2: Run complete automated verification.**

Run: `pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`

- [x] **Step 3: Perform real DSH Web acceptance without executing work.**

Build the plugin, start `pnpm --dir D:\code_github\deepseek-harness dsh web
--port <unused-port>`, open a historical and a drafted task, verify the legend
and readable timeline, open the goal-edit form then cancel it, verify jump
targets the linked session, and archive/restore only a disposable test task.
Do not confirm or execute a user task.

- [x] **Step 4: Commit documentation and report evidence.**

Commit: `git add README.md docs && git commit -m "docs: document task lifecycle controls"`
