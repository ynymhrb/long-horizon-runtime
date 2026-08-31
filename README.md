# Long Horizon Runtime for DeepSeek Harness

`@deepseek-ai/dsh-long-task-runtime` adds durable, inspectable long-running work to [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) without modifying DSH source. It keeps task state in a local SQLite event log; DSH conversations and child agents are execution surfaces, never the source of truth.

## What it provides

- Durable `lt_` task IDs that can continue from another conversation.
- Versioned DAG plans, dependency-aware scheduling, retries, validated artifacts, and checkpoint recovery.
- Five-hour per-attempt wall leases, compact child heartbeats, and durable recovery from a lost child session.
- A Web Task Area with task list, status-colored DAG, timeline, goal editing, pause/resume, archive/restore, and linked-session navigation.
- A compact current-task strip in conversations attached to a long task.
- Goal versions and revision-fenced controls, so stale writes cannot overwrite newer state.
- Policy-gated automatic replanning: only bounded, unfinished `read_only` work may be applied automatically.
- Planner and worker child-agent isolation: they cannot recursively create, edit, resume, or cancel the parent task.
- Standard-chat routing: users stay in their normal DSH chat mode; they do not need a “long-task mode”.

## Requirements

- A compatible DeepSeek Harness installation with the Web profile and an in-process `spawn` subagent provider.
- Node.js `^22.19.0` or `>=24.0.0` and pnpm on `PATH` for Git-source installation.
- A configured DSH model/provider capable of normal chats and child agents.

## Install

### Install from GitHub

```bash
dsh plugin --profile web add github:ynymhrb/long-horizon-runtime#master
dsh web
```

The repository includes its compiled `dist/` bundle, so Git installation does not run a build or depend on a local DeepSeek Harness checkout. `#master` is intentional: it is the project's supported release branch.

### Install a local checkout

Run this from the repository root:

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

The bundle contributes its own `cordis.patch.yml`; plugin defaults are installed with the package. Do not edit DSH source to install or use it.

## Use it from a normal chat

The default routing mode is `advisory`: the model chooses a durable task for work that needs a plan, multiple dependent stages, child agents, task artifacts, pause/recovery, audit history, or cross-session continuation. Short, single-session progress tracking can still use DSH's native goal feature. One-shot questions create no goal.

### Create a draft long task

Ask normally:

```text
研究 RAG 召回率的影响因素；拆成可验证的子任务，先给我计划，等我确认再执行。
```

The model should create a durable task in `AWAITING_CONFIRMATION`, return an `lt_…` ID, and show it in Task Area. No work starts until you confirm.

### Confirm, pause, or change the goal

Use natural language or Task Area controls:

```text
确认执行 lt_abc123。
暂停 lt_abc123。
把 lt_abc123 的原始目标改为“只研究中文技术资料”，原因是范围收窄。
```

Goal edits preserve history and produce a reviewable replacement plan. A conversation stop pauses the durable task; it is not failure evidence and does not trigger automatic replanning.

### Continue from another conversation

```text
继续任务 lt_abc123，先告诉我当前状态和未完成节点。
```

The new conversation can attach the task as its current task, so its task strip and Task Area focus on the same durable record.

## Routing configuration

The package default is:

```yaml
routingMode: advisory
```

For an intentional machine-local customization only, add this to the `long-task-runtime` row in your Web profile's `cordis.patch.yml`:

```yaml
- id: long-task-runtime
  config:
    routingMode: strict
```

`strict` removes DSH-native `create_goal`, `get_goal`, and `update_goal` schemas from top-level model turns. It does not create a task for every request; it means that if the model creates a persistent goal, it must use Long Horizon Runtime. It is an advanced deployment choice because native lightweight goals are no longer available to the model in that profile.

## Task lifecycle and safety

- New tasks receive stable `lt_` IDs; task state, plans, attempts, evidence, and artifacts are append-only or revisioned.
- A task's original goal may be edited, but its ID never changes.
- Automatic replanning never applies a change that expands scope, touches external effects, invalidates completed work, or deactivates verified artifacts.
- Deleting a task first cancels active work, then archives it. Archives are restorable for 30 days before purge.
- An interrupted external-effect node remains blocked until an operator explicitly resolves its outcome.

## Storage and integration boundary

The default bundle stores its database under DSH Home at `long-task-runtime/long-task-runtime.sqlite` and file artifacts under `long-task-runtime/artifacts`. Browser code uses only the plugin's Typert remote API; the package injects additive DSH slots for Task Area and the conversation task strip. No DSH application file is patched.

The exported plugin entry is `apply(ctx, config)`. It provides `ctx.longTaskRuntime` and registers `long_task_*` tools. It does **not** replace DSH's agent loop.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

The implementation roadmap, including V5 heterogeneous multi-agent routing, is in [docs/roadmaps/long-task-runtime-roadmap.md](docs/roadmaps/long-task-runtime-roadmap.md).
