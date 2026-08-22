# Long-Task Runtime V1.1–V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver V1.1 through V4b serially: cross-session durable task control, explainable context and memory, evidence-driven replanning, and an out-of-tree DSH task UI.

**Architecture:** V1.1 introduces a revision-fenced query/control seam and separates interruption facts from live execution leases. V2 and V3 extend that seam with manifests and replan proposals. V4 consumes only Host RPC projections from a browser `./client` entry.

**Tech Stack:** TypeScript, Node 22 SQLite `DatabaseSync`, Vitest, DSH Cordis, DSH client modules/slots, React 18 client bundle.

**Spec:** `docs/superpowers/specs/2026-08-23-long-task-runtime-v1.1-v4-design.md`

## Global Constraints

- Preserve V1's six tools as compatibility adapters.
- All durable writes append events; exposed controls carry an expected revision.
- Browser code uses Host RPC only and never opens SQLite.
- Do not modify any DSH Web repository source file.
- Use a focused failing test before each production behavior; run the whole suite only after V4b.
- Work serially on `master`, committing each completed boundary.

---

### Task 1: V1.1 durable task control

**Files:**
- Create: `src/task-api.ts`
- Modify: `src/domain.ts`, `src/event-store.ts`, `src/projections.ts`, `src/runtime.ts`
- Test: `tests/task-api.spec.ts`, `tests/event-store.spec.ts`

**Interfaces:**
- Produces `TaskQueryApi`, `TaskControlApi`, `TaskSnapshot`, `TaskSessionLink`, `Interruption`, and `ControlConflict`.
- Adds projections/events for session links, interruption, and revision-fenced state changes.

- [ ] **Step 1: Write the failing test**

```ts
const task = await api.create({ objective: 'research' }, invocation)
await api.attachSession(task.id, { sessionId: 'session-new', workspaceScope: task.workspaceScope })
await expect(api.update({ taskId: task.id, expectedRevision: task.revision - 1, action: 'pause' }, invocation))
  .resolves.toMatchObject({ kind: 'conflict', current: { revision: task.revision } })
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/task-api.spec.ts`

Expected: FAIL because `TaskControlApi` does not exist.

- [ ] **Step 3: Implement the smallest control seam**

```ts
export type TaskUpdateResult =
  | { kind: 'applied'; task: TaskSnapshot }
  | { kind: 'conflict'; current: TaskSnapshot }
export interface TaskControlApi {
  update(command: TaskUpdateCommand, invocation: TaskInvocation): Promise<TaskUpdateResult>
}
```

Append every link/control event inside an event-store transaction and derive returned snapshots from projections.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run tests/task-api.spec.ts tests/event-store.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src tests && git commit -m "feat: add revision-fenced task control api"`

### Task 2: V1.1 interruption, recovery policy, and canonical tools

**Files:**
- Modify: `src/scheduler.ts`, `src/runtime.ts`, `src/tools.ts`, `src/dsh-adapters.ts`, `src/index.ts`
- Test: `tests/runtime.spec.ts`, `tests/scheduler.spec.ts`, `tests/plugin.spec.ts`

**Interfaces:**
- Consumes Task 1 APIs.
- Produces process-local `ExecutionLease`, `RecoveryPolicy`, and canonical `long_task_create/get/update` tool definitions.

- [ ] **Step 1: Write the failing test**

```ts
await runtime.interrupt(goal.id, { cause: 'user_stop', signal: controller.signal })
expect(runtime.getStatus(goal.id)?.recentEvents.at(-1)?.type).toBe('ExecutionInterrupted')
expect(runtime.getStatus(goal.id)?.state).not.toBe('PAUSED')
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/runtime.spec.ts -t interrupt`

Expected: FAIL because an interrupt is currently cancellation/pause.

- [ ] **Step 3: Implement interruption ownership**

Thread `exec.signal` through planning/scheduling, combine it with attempt timeout signals, append `ExecutionInterrupted` on abort, release only the in-memory lease, and use `RecoveryPolicy` to choose requeue, wait-for-parent, resolution, or termination. Translate old six tools into canonical control commands.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run tests/runtime.spec.ts tests/scheduler.spec.ts tests/plugin.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src tests && git commit -m "feat: add interruptible cross-session task control"`

### Task 3: V2 context manifests and memory

**Files:**
- Create: `src/memory.ts`
- Modify: `src/context.ts`, `src/artifacts.ts`, `src/event-store.ts`, `src/projections.ts`, `src/scheduler.ts`
- Test: `tests/context.spec.ts`, `tests/memory.spec.ts`, `tests/scheduler.spec.ts`

**Interfaces:**
- Produces `ContextManifest`, `ContextSelectionPolicy`, and source-linked L1/L2/L3 memory projections.

- [ ] **Step 1: Write the failing test**

```ts
const manifest = await broker.assemble(task, { maxItems: 8 })
expect(manifest.entries).toContainEqual(expect.objectContaining({
  sourceRef: 'artifact:a1', selectionReason: 'direct-dependency',
}))
expect(manifest.entries.some(entry => entry.sourceRef === 'artifact:invalid')).toBe(false)
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/context.spec.ts tests/memory.spec.ts`

Expected: FAIL because manifests/memory projections are absent.

- [ ] **Step 3: Implement manifest-first context**

Record `ContextManifestRecorded` before adapter execution. Select validated direct artifacts before source-linked L1/L2/L3 memory within the configured budget. Record `MemoryRecorded` summaries without copying raw events.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run tests/context.spec.ts tests/memory.spec.ts tests/scheduler.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src tests && git commit -m "feat: record explainable task context and memory"`

### Task 4: V3 replan proposals

**Files:**
- Modify: `src/domain.ts`, `src/graph.ts`, `src/event-store.ts`, `src/projections.ts`, `src/runtime.ts`, `src/task-api.ts`
- Test: `tests/graph.spec.ts`, `tests/task-api.spec.ts`, `tests/runtime.spec.ts`

**Interfaces:**
- Produces `ReplanProposal` and control actions `propose_replan`, `accept_replan`, `reject_replan`.

- [ ] **Step 1: Write the failing test**

```ts
const proposal = await api.update({ taskId, expectedRevision: 3, action: 'propose_replan', payload: mutation }, invocation)
const accepted = await api.update({ taskId, expectedRevision: 3, action: 'accept_replan', payload: { proposalId: proposal.id } }, invocation)
expect(accepted.task.tasks.find(node => node.id === 'unrelated')?.state).toBe('SUCCEEDED')
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/graph.spec.ts tests/task-api.spec.ts -t replan`

Expected: FAIL because mutations apply directly in V1.

- [ ] **Step 3: Implement proposal lifecycle**

Validate base revision/evidence, append `ReplanProposed`, accept through a revision-fenced command, reuse `applyMutation` for only the affected closure, and append `ReplanAccepted` plus `PlanRevisionApplied`; rejection appends `ReplanRejected`.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run tests/graph.spec.ts tests/task-api.spec.ts tests/runtime.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src tests && git commit -m "feat: add evidence-driven replan proposals"`

### Task 5: V4 Host bridge and client package surface

**Files:**
- Create: `src/ui-api.ts`, `src/client/index.ts`, `src/client/task-store.ts`, `src/client/locales.ts`, `tsdown.client.ts`
- Modify: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`
- Test: `tests/ui-api.spec.ts`, `tests/package.spec.ts`

**Interfaces:**
- Produces cursor-based `TaskUiApi` snapshots/event pages and a `./client` export declared as `dsh.client`.

- [ ] **Step 1: Write the failing test**

```ts
const page = await uiApi.listTasks({ cursor: undefined, limit: 20 })
expect(page.items[0]).toMatchObject({ id: expect.stringMatching(/^lt_/), revision: expect.any(Number) })
expect(packageJson.dsh.client.platform).toBe('web')
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/ui-api.spec.ts tests/package.spec.ts`

Expected: FAIL because the bridge/client export is absent.

- [ ] **Step 3: Implement bridge and bundle**

Expose query projections and committed cursor deltas from the Host. Produce a lazy-CJS client bundle compatible with DSH `dsh.client`; client code has no filesystem/database imports.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run tests/ui-api.spec.ts tests/package.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add package.json tsconfig.json tsconfig.build.json src tests tsdown.client.ts && git commit -m "feat: expose long-task ui api and client bundle"`

### Task 6: V4a read-only Task Area

**Files:**
- Create: `src/client/TaskStrip.tsx`, `src/client/TaskArea.tsx`, `src/client/TaskOverview.tsx`, `src/client/TaskCockpit.tsx`, `src/client/TaskGraph.tsx`, `src/client/TaskTimeline.tsx`, `src/client/task-ui.module.css`
- Modify: `src/client/index.ts`, `src/client/task-store.ts`, `src/client/locales.ts`
- Test: `tests/client/task-strip.client.spec.tsx`, `tests/client/task-area.client.spec.tsx`, `tests/client/task-cockpit.client.spec.tsx`

**Interfaces:**
- Consumes Task 5 API and DSH slots `conversation.input.dock`, `sidebar.footer.action`, `shell.overlay`.

- [ ] **Step 1: Write the failing test**

```tsx
render(<TaskStrip sessionId="s-1" store={store} />)
expect(screen.queryByText('Task ID')).toBeNull()
store.attach('s-1', task)
expect(await screen.findByText(task.id)).toBeVisible()
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/client/task-strip.client.spec.tsx tests/client/task-area.client.spec.tsx`

Expected: FAIL because components are absent.

- [ ] **Step 3: Implement V4a**

Register the session strip, always-visible Task Area action, and overlay. Render Task-ID search/filters plus linked DAG, selected-node detail, and timeline. Retain last snapshot after delta failure, mark it stale, then continue from cursor after reconnect.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest run tests/client/task-strip.client.spec.tsx tests/client/task-area.client.spec.tsx tests/client/task-cockpit.client.spec.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/client tests/client && git commit -m "feat: add read-only long-task task area"`

### Task 7: V4b controls and complete-system verification

**Files:**
- Modify: `src/client/TaskArea.tsx`, `src/client/TaskCockpit.tsx`, `src/client/task-store.ts`, `src/ui-api.ts`, `README.md`, `examples/cordis.yml`, `docs/decisions/2026-08-22-long-task-runtime-v1.md`
- Test: `tests/client/task-controls.client.spec.tsx`, `tests/acceptance.spec.ts`, all existing tests

**Interfaces:**
- Produces revision-fenced UI controls for confirm, attach, pause, resume, cancel, and replan decisions.

- [ ] **Step 1: Write the failing test**

```tsx
api.update.mockResolvedValueOnce({ kind: 'conflict', current: next })
render(<TaskCockpit task={stale} api={api} />)
await user.click(screen.getByRole('button', { name: 'Pause task' }))
expect(await screen.findByText(`Revision ${next.revision}`)).toBeVisible()
```

- [ ] **Step 2: Verify red**

Run: `pnpm vitest run tests/client/task-controls.client.spec.tsx`

Expected: FAIL because controls do not exist.

- [ ] **Step 3: Implement V4b and acceptance path**

Submit every control with its displayed revision; replace local state on conflict and never retry automatically. Add the path create → execute → interrupt → attach by Task ID in a new session → replan → complete. Document client installation and Task ID continuation.

- [ ] **Step 4: Run complete verification**

Run: `pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`

Expected: all commands succeed.

- [ ] **Step 5: Verify DSH installation and commit**

Pack and install the plugin into the DSH web profile, start `pnpm dsh web`, and verify the Task Area loads without any DSH Web source modification. Then run:

```bash
git add src tests README.md examples docs package.json
git commit -m "feat: complete long-task runtime v1.1 through v4"
```
