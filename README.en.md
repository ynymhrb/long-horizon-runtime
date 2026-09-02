# Long Horizon Runtime for DeepSeek Harness

[中文](README.md) | English

> Durable, inspectable multi-step work for DeepSeek Harness chats.

[Overview](#overview) · [Capabilities](#capabilities) · [Quick start](#quick-start) · [Use it from a normal chat](#use-it-from-a-normal-chat)

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

From the repository root:

```bash
dsh plugin --profile web add .
dsh web
```

## Use it from a normal chat

Just chat normally: when work needs a plan, dependent stages, pause/recovery, audit history, or cross-session continuation, the model creates a durable long task. Short one-shot questions create no task.

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
