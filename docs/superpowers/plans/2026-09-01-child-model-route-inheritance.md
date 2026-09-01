# Child Model Route Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure long-task planner and execution children use the provider/model selected for the invoking parent request instead of falling back to DSH's global default model.

**Architecture:** `src/dsh-adapters.ts` already owns every `SubagentRuntime.start()` request. Resolve the parent route from `parent.session.requestHeader()?.config`, which is the durable source for the active request route; use it only when both strings are nonblank. Merge any deployment `defaultAgentProfile` over that inherited route so an intentional plugin configuration remains an explicit override.

**Tech Stack:** TypeScript, Vitest, DSH `Agent`/`SubagentRuntime` APIs.

**Spec:** `AGENTS.md` 鈥?child subagents must run through DSH with bounded delegated authority; incident evidence from session `session-00865ab5-9b37-48fb-be00-010d1782eb29`.

## Global Constraints

- Modify only `D:\code\long-horizon-runtime`; do not alter DeepSeek Harness source or user-profile configuration.
- Preserve the existing child lifecycle fields: parent, signal, tool deny-list, and output schema.
- Prefer the parent request's effective provider/model; retain `defaultAgentProfile` as an explicit higher-priority override.
- Every behavior change starts with a focused failing Vitest test.

---

### Task 1: Carry the active parent route into one-shot child starts

**Files:**
- Modify: `src/dsh-adapters.ts`
- Test: `tests/dsh-adapters.spec.ts`

**Interfaces:**
- Consumes: `Agent.session.requestHeader()?.config` with optional `provider` and `model` strings.
- Produces: `SubagentRuntime.start()` requests whose `agentOptions` include `{ provider, model }` when the parent request has a complete route.

- [x] **Step 1: Write the failing planner regression test**

Add a test that invokes `createDshPlannerAdapter()` through `withDshParent()` with a parent whose `options` are the fallback GLM route but whose `session.requestHeader()` returns `{ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }`. Capture the fake provider's request and assert:

```ts
expect(request?.agentOptions).toMatchObject({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
})
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/dsh-adapters.spec.ts -t "active parent route"`

Expected: FAIL because `runStructured()` currently omits `agentOptions` when no deployment override exists.

- [x] **Step 3: Implement the minimal route resolver**

In `src/dsh-adapters.ts`, read `currentParent()` once in `runStructured()`. Add a small helper that returns the request-header provider/model only when both are nonempty strings; otherwise return no route. Pass this route as `agentOptions`, then merge `options.agentOptions` after it:

```ts
const parent = currentParent()
const inheritedRoute = activeParentRoute(parent)
const agentOptions = {
  ...inheritedRoute,
  ...options.agentOptions,
}
```

Only add `agentOptions` to the DSH request when the merged object has at least one key.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `pnpm vitest run tests/dsh-adapters.spec.ts -t "active parent route"`

Expected: PASS.

- [x] **Step 5: Add an execution-path assertion**

Extend the execution schema test's parent to carry the same request header and assert the captured execution child request has the same `agentOptions` route. This proves planner and execution share the start boundary.

- [x] **Step 6: Run the adapter suite and commit**

Run: `pnpm vitest run tests/dsh-adapters.spec.ts`

Expected: PASS.

Commit:

```bash
git add src/dsh-adapters.ts tests/dsh-adapters.spec.ts docs/superpowers/plans/2026-09-01-child-model-route-inheritance.md
git commit -m "fix: inherit active parent route for long-task children"
```
