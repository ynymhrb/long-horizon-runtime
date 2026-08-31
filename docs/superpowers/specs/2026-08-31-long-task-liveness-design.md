---
feature_ids: [long-task-liveness]
topics: [durable-execution, heartbeats, leases, streaming-progress]
doc_kind: design
created: 2026-08-31
---

# Long-task liveness and five-hour execution design

## Status

Approved in conversation on 2026-08-31.

## Goal

Let a read-only or idempotent long-task attempt run for up to five hours when
it is demonstrably active, while guaranteeing that a lost child, hung adapter,
or restarted host cannot leave a durable attempt running forever.

## Problem

`executionTimeoutMs` is currently an absolute five-minute abort signal.  The
adapter then waits indefinitely for `run.result`, so a DSH child that ignores
or delays abort can strand the scheduler loop.  The only orphan reconciliation
runs at plugin activation.  The UI therefore cannot distinguish active work
from a lost attempt, and there is no durable live progress.

## Execution policy

Each execution has three independent bounds:

| Bound | Default | Meaning |
| --- | --- | --- |
| `idleTimeoutMs` | 5 minutes | Maximum interval without a persisted progress heartbeat. |
| `maxWallTimeMs` | 5 hours | Maximum attempt lifetime. Reaching it pauses the goal for an operator decision. |
| `heartbeatIntervalMs` | 30 seconds | Target maximum interval for a child to report its live phase/progress. |

The existing per-task `timeoutMs` remains backward-compatible as an optional
node override for `maxWallTimeMs`; it no longer means an idle timeout.  A
configuration field uses the same defaults when a node does not override it.

`external_effect` attempts never retry automatically after either lease expiry
or wall-time expiry. They record the fact, cancel the child best-effort, and
pause for explicit resolution. Read-only and idempotent attempts use their
existing retry policy after an idle expiry.

## Durable model

`TaskAttemptStarted` records `startedAt`, `leaseExpiresAt`, and
`maxWallExpiresAt`. `AttemptProgressRecorded` is append-only and carries the
attempt ID, timestamp, phase, compact message, optional completed/total counts,
and optional child session ID. Its projection updates `task_attempts` with
`last_activity_at` and the compact latest progress record.

Lease inspection uses durable timestamps, never process-local timers. A
watchdog runs before every scheduler round, on status reads, and at plugin
activation. It atomically terminalizes an expired attempt with a durable reason
and releases the node back into the existing retry/paused lifecycle. A late
child result is ignored through the existing settled-attempt/revision fencing.

## Adapter boundary

The DSH adapter races the child result with its current idle lease and its wall
lease. Its own result always settles after a deadline even if DSH's returned
`run.result` does not. On a deadline it requests abort and disposal without
awaiting an unbounded cleanup promise, then returns a typed timeout result to
the scheduler. Any child activity received from the DSH run is forwarded as a
progress callback; the callback renews the durable idle lease.

The exact DSH activity subscription must be feature-detected. If the installed
DSH `SubagentRun` exposes no incremental event API, the child receives a
narrow, non-lifecycle `long_task_report_progress` tool. It may only append a
bounded progress event for its own attempt. It cannot read, pause, resume,
cancel, replan, or otherwise control task lifecycle state.

## Streaming and UI

Progress is streamed to the Cockpit by polling/reading durable events. Raw
model tokens are not appended to the parent model's context. The UI displays
phase, latest compact message, activity time, elapsed wall time, and the two
deadlines. Full child output remains in its child-session log; terminal output
to the parent remains the existing structured summary and artifact references.

At wall expiry the task becomes `PAUSED` with an explicit operator action:
resume (which starts a fresh fenced attempt), cancel, or inspect the child
session. No automatic extension is implied.

## Non-goals

- An unattended worker service independent of a live DSH parent.
- Streaming arbitrary raw model tokens into parent conversation history.
- Automatic retry or automatic continuation of an external effect after loss.
- Changing DSH source, profile configuration, or the user-layer patch.

## Acceptance criteria

- A child that reports activity beyond five minutes is not aborted before its
  five-hour wall lease.
- A child whose `run.result` never settles produces a durable timeout outcome
  and no longer blocks dependent scheduling.
- A restart or status read reconciles a past-due durable lease.
- Wall expiry pauses the goal and does not silently retry the work.
- The Cockpit shows the current attempt's progress and activity timestamp from
  durable data after reload.
- Focused tests cover each condition, followed by test, typecheck, build,
  package dry-run, and whitespace checks.
