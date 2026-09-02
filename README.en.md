# Long Horizon Runtime for DeepSeek Harness

[中文](README.md) | English

> Durable, inspectable multi-step work for DeepSeek Harness chats.

[Overview](#overview) · [Capabilities](#capabilities) · [Quick start](#quick-start) · [Use it from a normal chat](#use-it-from-a-normal-chat) · [Safety and evidence](#safety-and-evidence) · [Development](#development)

`@deepseek-ai/dsh-long-task-runtime` adds durable, inspectable long-running work to [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) without modifying DSH source. Task state lives in a local SQLite event log; DSH conversations and child agents are execution surfaces, never the source of truth.

## Overview

Multi-step work becomes hard to review when plans change, execution is interrupted, or results need validation. Long Horizon Runtime brings safe replanning, visible task state, and durable attempts to ordinary DSH chats.

| What you get | What happens in a long task | Evidence boundary |
| --- | --- | --- |
| Safe replanning | Goal changes and validation failures leave revisioned decisions and durable evidence. A replan is applied automatically only when policy permits it. | Bounded, unfinished `read_only` work only; external effects and completed work require confirmation. |
| Inspectable progress | Task Cockpit presents the task through a dependency DAG and persistent status legend. | The capture below shows the current completed DAG and legend; formal UI scenarios are linked, not reported as passed. |
| Durable recovery | An interruption becomes a durable attempt. A permitted `read_only` retry or resume receives a distinct attempt record. | Interruptions are recorded; retry and resume still follow the task safety policy. |

![Completed Task Cockpit DAG with seven tasks, dependency edges, and a persistent status legend](docs/assets/readme/task-dag-completed.png)

The capture shows the completed-DAG presentation in the current Task Cockpit. Confirmation-fenced replan and archive/restore UI are represented by tracked contracts instead: [LT-UI-002 task inspection](scenarios/ui/LT-UI-002.yaml), [LT-UI-003 replan proposal](scenarios/ui/LT-UI-003.yaml), and [LT-UI-005 archive and restore](scenarios/ui/LT-UI-005.yaml). Those formal UI flows are not reported as passed here.

## Capabilities

- Stable `lt_` task IDs that can continue from another conversation.
- Versioned DAG plans, dependency-aware scheduling, retries, validated artifacts, and durable attempts.
- Five-hour per-attempt wall leases and compact child heartbeats.
- A Web Task Area with task list, status DAG, event timeline, goal editing, pause/resume, archive/restore, and linked-session navigation.
- A compact current-task strip in conversations attached to a long task.
- Goal versions and revision fences, so stale writes cannot overwrite newer state.
- Policy-gated automatic replanning and planner/worker child-agent isolation from parent lifecycle tools.
- Standard-chat routing: no user-facing “long-task mode”.

## Quick start

### Requirements

- A compatible DeepSeek Harness installation with the Web profile and an in-process `spawn` subagent provider.
- Node.js `^22.19.0` or `>=24.0.0`, plus pnpm on `PATH`, for Git-source installation.
- A configured DSH model/provider capable of normal chats and child agents.

### Install from GitHub

```bash
dsh plugin --profile web add github:ynymhrb/long-horizon-runtime#master
dsh web
```

The repository includes its compiled `dist/` bundle, so Git installation does not run a build or depend on a local DeepSeek Harness checkout. `#master` is the project's supported release branch.

### Install a local checkout

```bash
dsh plugin --profile web add .
dsh web
```

### Install a built tarball

```bash
pnpm pack
dsh plugin --profile web add ./deepseek-ai-dsh-long-task-runtime-<version>.tgz
dsh web
```

The bundle contributes its own `cordis.patch.yml`; package defaults install with it. Do not modify DSH source to install or use the plugin.

## Use it from a normal chat

The default routing mode is `advisory`: when work needs a plan, dependent stages, child agents, task artifacts, pause/recovery, audit history, or cross-session continuation, the model may choose a durable task. Short, single-session progress tracking can still use DSH's native goal feature. One-shot questions create no goal.

### Create a draft long task

```text
Research the factors that affect RAG recall; split the work into verifiable subtasks, show me the plan first, and wait for confirmation before execution.
```

The model should create a durable `AWAITING_CONFIRMATION` task, return an `lt_…` ID, and show it in Task Area. No work starts until confirmation.

### Confirm, pause, or change the goal

```text
Confirm lt_abc123.
Pause lt_abc123.
Change lt_abc123's original goal to “research Chinese technical materials only” because the scope is narrowing.
```

Goal edits preserve history and produce a reviewable replacement plan. A conversation stop pauses the durable task; it is not failure evidence and does not trigger automatic replanning.

### Continue from another conversation

```text
Continue lt_abc123. First show its current state and unfinished nodes.
```

The new conversation can attach the task as its current task, so its task strip and Task Area focus on the same durable record.

### Routing configuration

```yaml
routingMode: advisory
```

For an intentional machine-local customization only, add this to the `long-task-runtime` row in your Web profile's `cordis.patch.yml`:

```yaml
- id: long-task-runtime
  config:
    routingMode: strict
```

`strict` removes DSH-native `create_goal`, `get_goal`, and `update_goal` schemas from top-level model turns. It does not create a task for every request; it means that if the model creates a persistent goal, it must use Long Horizon Runtime. It is an advanced deployment option because native lightweight goals are no longer available to the model in that profile.

## Safety and evidence

- New tasks receive stable `lt_` IDs; task state, plans, attempts, evidence, and artifacts are append-only or revisioned.
- Automatic replanning never applies a change that expands scope, touches external effects, invalidates completed work, or deactivates verified artifacts.
- Deleting a task first cancels active work, then archives it. Archives are restorable for 30 days before purge.
- An interrupted external-effect node remains blocked until an operator explicitly resolves its outcome.
- A provider-reported LLM quota reset pauses the affected task without consuming its ordinary retry budget. After a host restart, Task Area preserves that recovery time and asks the user to continue from the linked conversation instead of autonomously starting a child.

The [validation handbook](docs/superpowers/specs/2026-08-27-long-task-production-validation-handbook.md) records `30/30 deterministic state/recovery and fault-injection scenarios`. This is deterministic scenario evidence, not completed manual UI acceptance or a live-LLM validation claim. The reproducible contracts for a revision-fenced safe replan, interrupted `read_only` recovery, and validator-failure evidence before a permitted replan are [LT-STATE-008](scenarios/state-recovery/LT-STATE-008.yaml), [LT-RECOVERY-003](scenarios/state-recovery/LT-RECOVERY-003.yaml), and [LT-FAULT-006](scenarios/fault-injection/LT-FAULT-006.yaml). These cases use local fixture doubles and disposable resources.

## Storage and integration boundary

The default bundle stores its database under DSH Home at `long-task-runtime/long-task-runtime.sqlite` and file artifacts under `long-task-runtime/artifacts`. Browser code uses only the plugin's Typert remote API; the package injects additive Task Area and conversation task-strip slots. No DSH application file is patched.

The exported plugin entry is `apply(ctx, config)`. It provides `ctx.longTaskRuntime` and registers `long_task_*` tools. It does **not** replace DSH's agent loop.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

The repository includes a configuration-driven, one-seed ARIS evidence runner that compares ARIS only against ARIS with this plugin. It installs neither plugin and makes no research-quality claim; it records exactly what the two operator-supplied commands did. See [validation/aris-pilot/README.md](validation/aris-pilot/README.md).

The implementation roadmap, including V5 heterogeneous multi-agent routing, is in [docs/roadmaps/long-task-runtime-roadmap.md](docs/roadmaps/long-task-runtime-roadmap.md).
