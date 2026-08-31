# LLM Quota Recovery Design

## Purpose

Treat provider quota/rate-limit exhaustion as a temporary availability state,
not a task-output failure or a generic infrastructure retry.  A known provider
reset time must be preserved durably and used as the earliest eligible retry
time without consuming the task's ordinary retry budget.

## Scope and non-goals

This change applies only to `read_only` and `idempotent` task attempts.
`external_effect` attempts keep their existing operator-resolution fence.
It does not add a provider-specific SDK, make network availability probes, or
resume a task after a host restart without a live DSH parent Agent.

## Failure model

`FailureKind` gains `quota`.  Failed executions may attach a structured
`retryAt` ISO timestamp and a bounded provider diagnostic.  The DSH adapter
extracts this only from a structured or thrown provider diagnostic; the
existing opaque `stopReason: error` remains `infrastructure` because it does
not prove quota exhaustion.  Supported signals are explicit `retry-after`,
`retry_at`, `reset_at`, HTTP 429, and quota/rate-limit wording.  Invalid,
past, or implausibly distant timestamps are ignored and retain the ordinary
infrastructure path.

## Durable lifecycle

When a quota failure has a usable recovery time, the scheduler appends, in one
transaction:

1. `ValidationRecorded` and `TaskAttemptFailed`, with `failureKind: quota`;
2. `QuotaRecoveryScheduled`, carrying the attempt ID, sanitized diagnostic,
   and `retryAfter` timestamp; and
3. `GoalPaused`, whose reason identifies the scheduled recovery time.

The projection keeps the task `PENDING`; it does not emit
`TaskRetryBudgetExhausted`, `TaskFailed`, an automatic replan trigger, or a
normal retry-budget event.  Cancellation, manual pause, archive, and plan
revision changes invalidate the outstanding in-memory wake-up and leave the
durable audit trail intact.

## Recovery execution

`LongTaskRuntime` tracks one recovery timer per goal while it holds the live
parent Agent passed by the current user session.  It schedules at
`retryAfter + deterministic bounded jitter`, then revision-checks that the
goal is still paused for the same quota event, appends `GoalResumed`, and
re-enters the existing background scheduler loop.

On process restart there is intentionally no autonomous child start: a DSH
parent Agent is process-local.  The persisted recovery time is still exposed
in task status/UI.  If the due time has passed, the attached conversation can
resume the task through the normal control path, which starts a fresh child
under a live parent.

If no usable recovery time exists, quota falls back to a bounded exponential
retry schedule that likewise does not decrement `maxAttempts`; after that
policy ceiling, the task remains paused with an actionable quota reason rather
than becoming a failed task.

## Presentation and observability

The task DTO exposes pending quota recovery metadata.  The Cockpit and task
strip render a textual status such as `LLM 额度耗尽，预计 14:05 后重试`; when
the time is due but a host restart removed the parent, they instead render
`额度恢复时间已到，请在已关联会话中继续`.

The event timeline formats quota events with the provider diagnostic and
recovery timestamp.  Raw error bodies and secrets are never persisted or
rendered.

## Verification

Focused tests prove: extraction of a valid quota diagnostic; opaque child
errors remain infrastructure; quota with a reset time pauses without consuming
attempt budget; the live parent resumes exactly once after the due time;
cancellation prevents that retry; and persisted state after a simulated
restart remains actionable without an autonomous child start.  Existing retry,
interruption, external-effect, liveness, and UI suites remain green.
