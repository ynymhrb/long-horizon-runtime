# Long-Task V4 Task Area Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype long-task modal with a durable, cross-session Task Area containing a native-style current-task strip, a read-only SVG DAG Cockpit, and revision-fenced V4b controls.

**Architecture:** Extend the append-only long-task event store with a session-scoped nullable current-task binding and expose all browser needs through a versioned Typert remote. Keep layout, state presentation, and DTO projection in pure modules; the browser module composes a Task Area through public DSH Slots and reads only the remote service. The client does not edit DAGs or access SQLite.

**Tech Stack:** TypeScript 6, Node `node:sqlite`, Cordis 4, DSH rc.7 Typert Remote, React 18, native SVG, Vitest 4, tsdown client bundle.

**Spec:** `docs/superpowers/specs/2026-08-23-long-task-runtime-v1.1-v4-design.md`

## Global Constraints

- Modify only `D:\code\long-horizon-runtime`; do not modify DeepSeek Harness source.
- Plugin defaults live only in `cordis.patch.yml`; do not write default configuration to a profile-local patch.
- Browser code composes only through public DSH Slots and Typert Remote; it never opens the SQLite database.
- Use no React Flow, D3, or workflow-editor dependency. DAG is deterministic, read-only SVG.
- A task may link to many sessions; every session has at most one nullable `currentTaskId` display binding.
- The long-task strip follows native GoalBar discipline: authoritative remote state, one mutation in flight, revision fencing, inline error, no optimistic state transition.
- DSH composer Stop retains its native generation-abort meaning; it is not a long-task pause button.
- Preserve unrelated uncommitted workspace edits. Commit only files belonging to each task.

---

### Task 1: Persist and project the session current-task binding

**Files:**
- Modify: `src/event-store.ts`, `src/projections.ts`, `src/runtime.ts`, `src/task-api.ts`
- Modify: `tests/event-store.spec.ts`, `tests/task-api.spec.ts`

**Interfaces:**
- Produces `CurrentTaskBinding { sessionId: string; taskId: string; controlRevision: number }`.
- Produces `RuntimeEventStore.getCurrentTaskForSession(sessionId): CurrentTaskBinding | undefined`.
- Produces `TaskControlApi.setCurrentSessionTask(taskId, { sessionId, workspaceScope }): TaskUpdateResult` and `clearCurrentSessionTask(sessionId)`.
- `TaskSessionCurrentSet` and `TaskSessionCurrentCleared` are append-only events and rebuild into the same projection.

- [ ] **Step 1: Write the failing projection tests**

```ts
it('replays one current task per session without deleting historic links', () => {
  store.append([{ type: 'TaskSessionAttached', goalId: 'lt_a', payload: { sessionId: 's', kind: 'attached' } }])
  store.append([{ type: 'TaskSessionCurrentSet', goalId: 'lt_a', payload: { sessionId: 's', controlRevision: 1 } }])
  store.append([{ type: 'TaskSessionCurrentSet', goalId: 'lt_b', payload: { sessionId: 's', controlRevision: 2 } }])
  expect(store.getCurrentTaskForSession('s')).toEqual({ sessionId: 's', taskId: 'lt_b', controlRevision: 2 })
  expect(store.listSessionLinks('lt_a')).toContainEqual({ sessionId: 's', kind: 'attached' })
})
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm vitest run tests/event-store.spec.ts tests/task-api.spec.ts`

Expected: FAIL because the projection table and `getCurrentTaskForSession()` do not exist.

- [ ] **Step 3: Add the projection and runtime operations**

Create the `current_task_bindings` projection table keyed by `session_id`. In `projectEvent`, upsert it on `TaskSessionCurrentSet` and delete it on `TaskSessionCurrentCleared`; include it in `rebuild()` cleanup. `TaskControlApi.setCurrentSessionTask()` must require an existing compatible task/session link, append one set event plus `TaskControlRevisionAdvanced`, and return the fresh task view. Creation and `attachSession()` must set the new task current for that supplied session.

```ts
export interface CurrentTaskBinding {
  readonly sessionId: string
  readonly taskId: string
  readonly controlRevision: number
}

getCurrentTaskForSession(sessionId: string): CurrentTaskBinding | undefined
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest run tests/event-store.spec.ts tests/task-api.spec.ts`

Expected: PASS, including rebuild/replay and workspace-mismatch rejection coverage.

- [ ] **Step 5: Commit the durable binding**

```bash
git add src/event-store.ts src/projections.ts src/runtime.ts src/task-api.ts tests/event-store.spec.ts tests/task-api.spec.ts
git commit -m "feat: persist current long task per session"
```

### Task 2: Define the browser-safe Task UI query/control surface

**Files:**
- Create: `src/task-ui-api.ts`
- Modify: `src/remote.ts`, `src/runtime.ts`, `src/event-store.ts`
- Modify: `tests/plugin.spec.ts`, `tests/task-ui.spec.ts`

**Interfaces:**
- Produces `TaskSummary`, `TaskStripView`, `TaskGraphView`, and cursor-page DTOs containing JSON-only data.
- Produces `TaskUiApi.listTasks`, `getTask`, `getTaskGraph`, `listTaskEvents`, `getCurrentTaskForSession`, and `updateTask`.
- Extends `LongTaskRemote` with the matching decorated remote methods. The legacy `get/list` methods may remain as compatibility aliases.

- [ ] **Step 1: Write the failing DTO and remote contract tests**

```ts
it('returns a strip view only for a bound non-terminal task', () => {
  api.setCurrentSessionTask('lt_a', { sessionId: 's', workspaceScope: 'D:/repo' })
  expect(ui.getCurrentTaskForSession({ sessionId: 's' })?.progress).toEqual({ succeeded: 1, total: 3 })
  runtime.cancelGoal('lt_a')
  expect(ui.getCurrentTaskForSession({ sessionId: 's' })).toBeNull()
})

it('exposes the versioned longTasks methods', () => {
  expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('longTasks/listTasks')
  expect(remoteMethodNames(LongTaskRemote)).toEqual(expect.arrayContaining(['listTasks', 'getTaskGraph', 'updateTask']))
})
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/plugin.spec.ts`

Expected: FAIL because no versioned browser DTO/query/control service exists.

- [ ] **Step 3: Implement immutable DTO projection and remote methods**

`TaskSummary` must use only durable values: Task ID/objective/state/control revision/workspace, `succeeded/total`, current-or-last node, pause/block reason, and latest event cursor. `TaskGraphView` must return the requested immutable plan revision and `dependsOn` edges. `listTaskEvents` must page in ascending sequence order and permit an optional `taskNodeId` filter. `updateTask` dispatches only the explicit action union from the spec and returns `{ kind: 'applied', task } | { kind: 'conflict', current }`.

```ts
export interface TaskUiApi {
  listTasks(input: { cursor?: number; filter?: TaskListFilter }): CursorPage<TaskSummary>
  getTask(input: { taskId: string }): GoalView | null
  getTaskGraph(input: { taskId: string; revision?: number }): TaskGraphView | null
  listTaskEvents(input: { taskId: string; cursor?: number; taskNodeId?: string }): CursorPage<RuntimeEvent>
  getCurrentTaskForSession(input: { sessionId: string }): TaskStripView | null
  updateTask(input: TaskUiUpdate): Promise<TaskUpdateResult>
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/plugin.spec.ts`

Expected: PASS, including terminal strip suppression, graph revision lookup, event cursor continuation, stale control conflict, and remote descriptor execution.

- [ ] **Step 5: Commit the Task UI API**

```bash
git add src/task-ui-api.ts src/remote.ts src/runtime.ts src/event-store.ts tests/task-ui.spec.ts tests/plugin.spec.ts
git commit -m "feat: expose long task UI query and control API"
```

### Task 3: Build deterministic SVG DAG projection primitives

**Files:**
- Create: `client/task-graph.js`, `client/task-presentation.js`
- Create: `tests/task-graph.spec.ts`

**Interfaces:**
- Produces `layoutTaskGraph(nodes): { nodes: GraphNodePosition[]; edges: GraphEdge[]; width: number; height: number }`.
- Produces `taskStatePresentation(state)` and `taskStripPresentation(task)` for one shared status label/color mapping.

- [ ] **Step 1: Write the failing layout and state tests**

```ts
it('places dependencies in increasing stable ranks', () => {
  const graph = layoutTaskGraph([
    { id: 'review', dependsOn: ['research'], state: 'PENDING' },
    { id: 'research', dependsOn: [], state: 'SUCCEEDED' },
  ])
  expect(node(graph, 'research').x).toBeLessThan(node(graph, 'review').x)
  expect(graph.nodes.map(node => node.id)).toEqual(['research', 'review'])
})

it('maps blocked and invalidated values without client inference', () => {
  expect(taskStatePresentation('BLOCKED')).toMatchObject({ tone: 'warning', label: '受阻' })
  expect(taskStatePresentation('INVALIDATED')).toMatchObject({ tone: 'muted' })
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest run tests/task-graph.spec.ts`

Expected: FAIL because layout and presentation modules do not exist.

- [ ] **Step 3: Implement the minimal ranked layout**

Use Kahn topological rank computation. Sort every rank lexicographically by Task ID. Use fixed constants `NODE_WIDTH = 196`, `NODE_HEIGHT = 72`, `RANK_GAP = 96`, and `LANE_GAP = 28`; compute each edge endpoint from the source right midpoint to target left midpoint. Invalid/missing dependency references produce no fabricated edge and an explicit `danglingDependencyIds` list for the Cockpit warning.

```js
export function layoutTaskGraph(nodes) { /* returns stable viewport geometry */ }
export function taskStatePresentation(state) { /* closed durable-state mapping */ }
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest run tests/task-graph.spec.ts`

Expected: PASS for linear, fan-out/fan-in, stable same-rank ordering, and dangling dependency fixtures.

- [ ] **Step 5: Commit the graph primitives**

```bash
git add client/task-graph.js client/task-presentation.js tests/task-graph.spec.ts
git commit -m "feat: add deterministic long task DAG layout"
```

### Task 4: Replace the prototype client with overview, strip, and Cockpit components

**Files:**
- Create: `client/TaskArea.js`, `client/TaskStrip.js`, `client/TaskCockpit.js`, `client/TaskDag.js`, `client/task-area.css`
- Modify: `client/index.js`, `tsdown.client.config.ts`
- Modify: `tests/task-ui.spec.ts`

**Interfaces:**
- Consumes Task 2 remote methods and Task 3 pure layout/presentation modules.
- Produces a session-header Task Area action, a `conversation.input.dock` current-task strip, and a `shell.overlay` three-layer flow.

- [ ] **Step 1: Write the failing component-behavior tests**

```ts
it('shows no strip for an unbound session and opens its bound task from the strip', async () => {
  renderTaskStrip({ sessionId: 's', current: null })
  expect(screen.queryByTestId('long-task-strip')).toBeNull()
  rerenderTaskStrip({ sessionId: 's', current: stripTask })
  await user.click(screen.getByTestId('long-task-strip'))
  expect(openCockpit).toHaveBeenCalledWith(stripTask.id)
})

it('selecting a graph node updates the inspector and highlights its edges', async () => {
  renderCockpit(taskFixture)
  await user.click(screen.getByRole('button', { name: /review/i }))
  expect(screen.getByText('review objective')).toBeVisible()
  expect(screen.getByTestId('edge-research-review')).toHaveAttribute('data-selected', 'true')
})
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm vitest run tests/task-ui.spec.ts`

Expected: FAIL because the current modal has neither a real strip nor Cockpit selection state.

- [ ] **Step 3: Implement the three UI layers**

Split the current one-file client into focused components. `TaskArea` owns overlay state, overview filters/search, selected Task ID, stale/loading/error display, and bounded polling only while visible. `TaskStrip` polls `getCurrentTaskForSession` only for the active non-blank session and renders a native-GoalBar-shaped card after it. `TaskCockpit` renders header summary, SVG `TaskDag`, and selected-node inspector/timeline; initial selection is the running node, otherwise the first non-terminal node, otherwise the first stable node. `TaskDag` handles pointer-drag pan, wheel zoom, fit-to-view, node selection, and keyboard-accessible node buttons.

Register only `conversation.session.header.actions`, `conversation.input.dock`, and `shell.overlay`. Do not restore the removed sidebar action.

- [ ] **Step 4: Run focused UI tests and build the browser bundle**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/task-graph.spec.ts; pnpm run build:client`

Expected: PASS and `dist/client.js` contains the split client modules with React externalized once.

- [ ] **Step 5: Commit the read-only Task Area**

```bash
git add client/index.js client/TaskArea.js client/TaskStrip.js client/TaskCockpit.js client/TaskDag.js client/task-area.css tsdown.client.config.ts tests/task-ui.spec.ts
git commit -m "feat: add long task overview and DAG cockpit"
```

### Task 5: Add V4b controls and cross-session navigation

**Files:**
- Modify: `client/TaskArea.js`, `client/TaskStrip.js`, `client/TaskCockpit.js`, `src/task-ui-api.ts`, `src/remote.ts`
- Modify: `tests/task-ui.spec.ts`, `tests/task-api.spec.ts`

**Interfaces:**
- Consumes `TaskUiApi.updateTask` and the client session service's `sessions.open(sessionId)`.
- Produces controls for confirm, attach current session, set current, pause, resume, cancel, external-effect resolution, and replan accept/reject.

- [ ] **Step 1: Write the failing mutation and navigation tests**

```ts
it('replaces the Cockpit snapshot on a revision conflict without retrying', async () => {
  api.updateTask.mockResolvedValueOnce({ kind: 'conflict', current: revisionTwo })
  renderCockpit(revisionOne)
  await user.click(screen.getByRole('button', { name: '暂停任务' }))
  expect(api.updateTask).toHaveBeenCalledTimes(1)
  expect(screen.getByText('修订 2')).toBeVisible()
})

it('opens only a session present in the ordinary session list', async () => {
  renderCockpit({ ...taskFixture, sessionLinks: [{ sessionId: 'child', kind: 'execution_child' }] }, { sessions: [] })
  expect(screen.queryByRole('button', { name: /打开会话/i })).toBeNull()
})
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/task-api.spec.ts`

Expected: FAIL because no browser control actions or guarded session navigation exist.

- [ ] **Step 3: Implement controls without optimistic mutation**

Render only `availableActions` plus binding/replan actions authorized by the full snapshot. Every button sends the displayed control revision and session ID, replaces state from the settled response, and is disabled until that response settles. On an external-effect resume, first render the two explicit resolution choices. Use `ctx.sessions.open()` only after checking `useSessions` contains the linked session. “Modify plan” exposes proposal acceptance/rejection only; it directs free-form changes to the attached conversation rather than adding a graph editor.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `pnpm vitest run tests/task-ui.spec.ts tests/task-api.spec.ts`

Expected: PASS for each control, pending lock, conflict refresh, terminal control suppression, workspace rejection, and guarded session opening.

- [ ] **Step 5: Commit V4b controls**

```bash
git add client/TaskArea.js client/TaskStrip.js client/TaskCockpit.js src/task-ui-api.ts src/remote.ts tests/task-ui.spec.ts tests/task-api.spec.ts
git commit -m "feat: add revision-fenced long task controls"
```

### Task 6: Verify package composition and the real DSH Web UI

**Files:**
- Modify: `README.md`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`
- Modify if required by client imports only: `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml`
- Test: all existing test files and the running DSH Web profile

**Interfaces:**
- Produces documented installation, current-task binding, Task ID continuation, task strip, Cockpit, and control behavior.
- Confirms packaged client loading and actual browser rendering without a DSH source modification.

- [ ] **Step 1: Add final acceptance coverage before release verification**

```ts
it('supports create → origin binding → cockpit → pause → attach in a new session → set current → resume', async () => {
  const created = await api.create(request, { sessionId: 'origin', workspaceScope: 'D:/repo', parent })
  expect(ui.getCurrentTaskForSession({ sessionId: 'origin' })?.id).toBe(created.id)
  await api.update({ taskId: created.id, expectedRevision: created.controlRevision, action: 'pause' }, origin)
  await api.attachSession(created.id, { sessionId: 'next', workspaceScope: 'D:/repo' })
  expect(ui.getCurrentTaskForSession({ sessionId: 'next' })?.id).toBe(created.id)
})
```

- [ ] **Step 2: Run all static and package verification**

Run: `pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`

Expected: all commands exit 0; packed payload includes `dist/client.js`, `cordis.patch.yml`, and documentation.

- [ ] **Step 3: Install exactly as a plugin and run DSH Web**

Run:

```powershell
pnpm pack
dsh plugin --profile web add .\deepseek-ai-dsh-long-task-runtime-<version>.tgz
pnpm --dir D:\code_github\deepseek-harness dsh web
```

Expected: profile composition resolves this plugin package, default configuration originates from this repository's `cordis.patch.yml`, and no DSH source file changes are needed.

- [ ] **Step 4: Perform browser acceptance using a model-created, non-executing task**

In the actual DSH Web UI, ask the model to create a long task with
`planning_mode: require_confirmation` and explicitly do not confirm it. This
uses the real agent/tool/SQLite/UI path without dispatching a worker attempt.
Verify: a non-blank conversation exposes the session-header Task Area action;
the created task produces one strip after the native GoalBar; the overview
opens the Cockpit; the SVG has correctly ordered DAG nodes; selecting a node
updates its inspector/timeline; pan/zoom/fit work; the `AWAITING_CONFIRMATION`
state and confirm/cancel controls render; and a second ordinary conversation
can attach that Task ID and set it as current without executing it.

- [ ] **Step 5: Commit release-facing completion**

```bash
git add README.md docs/decisions/2026-08-22-long-task-runtime-v1.md package.json pnpm-lock.yaml cordis.patch.yml tests
git commit -m "feat: complete long task V4 task area"
```

## Plan self-review

- **Spec coverage:** Task 1 implements the session binding and durable audit; Task 2 implements every TaskUiApi read/control route; Task 3 satisfies deterministic status/DAG projection; Task 4 implements the no-sidebar overview, strip, Cockpit and interaction model; Task 5 covers revision-fenced actions and session navigation; Task 6 covers staleness/acceptance, package composition, and real DSH verification.
- **Placeholder scan:** no TODO/TBD or unspecified test action remains; each task specifies files, interfaces, failing test, exact verification command, and commit boundary.
- **Type consistency:** all later client tasks consume the `TaskUiApi`, `TaskStripView`, `TaskGraphView`, and current-session binding established by Tasks 1–2; no direct SQLite client access is introduced.
