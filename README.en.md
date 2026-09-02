# Long Horizon Runtime · DSH Long-Task Plugin

[中文](README.md) | English

> Turn a long piece of work into one task you can confirm, track, and resume.

[What it solves](#what-it-solves) · [Quick start](#quick-start) · [How to use it](#how-to-use-it)

Long Horizon Runtime is a long-task plugin for [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness). It is for research, development, debugging, and other work that needs several steps and more than one conversation: see a plan first, confirm before execution, follow progress as it happens, and resume after an interruption.

## What it solves

|  | A normal chat | With Long Horizon Runtime |
| --- | --- | --- |
| Complex work | The process lives in chat history | Review a step-by-step task plan, then execute it after confirmation |
| Progress | Scroll through the conversation | See steps, dependencies, and current status in Task Area |
| A change of direction | Restate the request and risk losing context | Change the goal, keep completed work, and get a new plan for what remains |
| A paused or interrupted chat | Recover progress manually | Return to the same task and continue its unfinished steps |

![A completed task in Task Area: steps, dependencies, and status at a glance](docs/assets/readme/task-dag-completed.png)

## Quick start

You need DeepSeek Harness installed and able to run `dsh web`. Installing from GitHub also requires Node.js `^22.19.0` or `>=24.0.0` and pnpm.

### Install from GitHub

```bash
dsh plugin --profile web add github:ynymhrb/long-horizon-runtime#master
dsh web
```

### Install a local checkout

Run this from the repository root:

```bash
dsh plugin --profile web add .
dsh web
```

## How to use it

Do not switch modes. Describe what you want to accomplish in a normal chat:

```text
Research the factors that affect RAG recall; split the work into verifiable subtasks, show me the plan first, and wait for confirmation before execution.
```

The plugin turns this into a long task:

1. It presents a step-by-step plan.
2. Work starts after your confirmation.
3. You follow every step and result in Task Area.
4. Pause, change the goal, or continue from another conversation while keeping the same task.

You can also say:

```text
Pause lt_abc123.
Change lt_abc123 to “research Chinese technical materials only.”
Continue lt_abc123 and tell me which steps are unfinished.
```
