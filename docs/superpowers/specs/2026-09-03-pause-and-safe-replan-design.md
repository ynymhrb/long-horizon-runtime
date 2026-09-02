# Pause, Quota Recovery, and Safe Replan Design

## Goal

Make a user-requested pause durably stop in-flight child attempts, make quota
recovery visibly report when it resumes work, and prevent automatic replans
from altering anything outside a provably unfinished read-only downstream
region.

## Pause and resume

`pause` is an execution control, not merely a goal-state transition. The
runtime will call a scheduler-owned `pause(goalId)` operation before recording
`GoalPaused`. It aborts every active attempt controller, asks the execution
adapter to cancel the corresponding child session, and appends a
`TaskInterrupted` event for each active attempt in the same durable operation.
The event projection returns those nodes to `PENDING`; a late child settlement
is ignored because its attempt is no longer `RUNNING`.

Resuming never reuses an interrupted child session. A UI-only resume makes the
goal eligible but does not dispatch. `long_task_resume` supplies a live parent
Agent and starts a new attempt with a new ID.

## Quota recovery visibility

When the in-memory quota timer fires for the unchanged paused recovery record,
the runtime appends `QuotaRecoveryResumed` before its normal `GoalResumed`
transition and execution. The event records the recovery attempt ID and is
shown in the timeline as an automatic recovery. The Cockpit derives a concise
status notice from the most recent such event: while work runs it says that
quota recovery has resumed execution; after success it says that recovered
execution completed. This is an audit-visible notice, not an unbounded toast
or an autonomous restart after process loss.

## Automatic replan classification

`classifyAutomaticReplan(previous, candidate, failedTaskId, artifacts)` returns
`{ outcome: 'auto_apply' | 'await_confirmation', reasons: string[] }`.
Automatic application requires all of the following:

1. The failed task exists, is unfinished, and every changed or new candidate
   node lies in the failed task's downstream region in the previous DAG.
2. Every succeeded node is byte-for-byte structurally identical for its ID,
   objective, dependencies, input/output contracts, completion criteria,
   validator, timeout, retry policy, and side-effect class.
3. Every active validated artifact remains owned by an unchanged succeeded node
   and that node is not in the affected region.
4. No candidate node is `external_effect` and no new node is introduced
   outside the affected region. Candidate plan validation still enforces a
   valid DAG.

The classifier emits durable human-readable reasons. Unsafe candidates are
stored as `PlanProposed`; only the user can confirm them. An `output` failure
after its retry budget is the sole automatic-replan trigger. Infrastructure,
quota, interruption, and external-effect failures never enter the planner
replan path.

## Tests

Tests use real runtime/scheduler behavior and prove: pause aborts and
terminalizes a live attempt; its late result cannot complete the task; resuming
creates a second attempt; quota recovery emits a visible event; and each
unsafe replan condition produces confirmation rather than automatic mutation.
