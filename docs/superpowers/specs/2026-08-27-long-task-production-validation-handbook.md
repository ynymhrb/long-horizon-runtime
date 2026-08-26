# Long-task production validation handbook

## Purpose and non-goals

This handbook turns real, safe usage of `long-task-runtime` into reproducible
quality evidence. It is for inexpensive LLM workers and deterministic runners.
Its output is evidence and candidate defects, never an autonomous production
change.

Version one is deliberately limited to `read_only` work and disposable local
workspaces. It must not send messages, deploy, write to third-party services,
modify a user profile, or execute a plan with `sideEffectClass` equal to
`external_effect`. A detected external effect is a hard stop, not a scenario
failure to work around.

The handbook does not authorize a worker to edit source, change configuration,
accept a replan, or execute a real user task.

## Operating model

```
versioned scenario -> deterministic runner -> evidence bundle -> hard oracle
                                                         | pass -> metrics
                                                         | fail/risk signal
                                                         v
                                                LLM incident triage
                                                         v
                                           scripted/person review and outcome
                                                         v
                                           permanent regression scenario
```

The deterministic runner is the source of truth for setup, actions and hard
assertions. A low-cost LLM expands observability: it may identify an earliest
anomaly and propose falsifiable bug hypotheses from the evidence bundle. It is
not the correctness oracle and cannot claim a fix.

## Roles and permissions

### Scenario runner

The runner may create and delete a unique temporary workspace, run the local
test commands named by a scenario, start the local DSH Web host, use the local
browser for the named UI steps, and read the task's local runtime database and
artifacts. It may not edit tracked source, user-layer configuration, agent
presets, or external systems.

It follows a scenario literally. It records shell exit codes, tool output,
browser screenshots, task IDs, event cursors, event export and runtime snapshot
before deciding whether to invoke a triager.

### Incident triager

The triager receives only a redacted evidence bundle. It is read-only. It must
produce the JSON contract below, cite evidence identifiers for every claim and
offer no more than three hypotheses. It may classify evidence as insufficient;
that is preferable to inventing a root cause.

### Reviewer

The reviewer uses the supplied reproduction and an automatable oracle to mark
the outcome `confirmed_bug`, `test_problem`, `product_decision`, or
`insufficient_evidence`. Only a confirmed bug becomes a permanent regression
scenario. A reviewer may create an issue or request a repair, but repair work
is a separate, test-first task.

## Scenario contract

Store each scenario as versioned YAML or JSON. The runner must reject a missing
field and reject a scenario whose planned task is not `read_only`.

```yaml
id: LT-RECOVERY-003
title: Restart recovers an interrupted read-only attempt
risk: high                 # critical | high | medium | low
kind: deterministic        # deterministic | fault_injection | exploratory_ui
tags: [recovery, restart, read_only]
preconditions:
  - fresh durable database
  - unique disposable workspace
setup: []
actions: []
hard_assertions: []
evidence_required: [events, runtime_snapshot, command_log]
llm_review: on_failure     # never | on_failure | always
expected_user_outcome: User can see the interruption and a safe next action.
cleanup: delete_disposable_workspace
```

Each hard assertion must be executable and observable, for example an exact
goal state, an event ordering, a task-attempt state, an artifact projection, a
DTO response or a visible UI label. Do not use a subjective assertion such as
“the workflow feels clear.”

## Evidence bundle

Create one immutable directory per run. Give every file a stable identifier
referenced by the report.

```
run.json                 scenario id, version, timestamps, command versions
commands.ndjson          command, cwd, exit code, duration, stdout/stderr refs
task.json                goal id, revision, control revision, task ids
events.json              ordered, compact durable event export
snapshot.json            goal, plan, attempts, artifact projections, decisions
artifacts.json           paths, hashes, size and validation status; no large body
screenshots/             named screenshots for UI scenarios
assertions.json          assertion, actual, expected, pass/fail
environment.json         temporary paths and local host URL; redact secrets
```

The runner must capture evidence before cleanup. Secrets, large artifact bodies,
and unrelated user data are excluded. A missing required evidence item turns a
passing execution into `inconclusive`, not pass.

## LLM triage contract

Use this exact output shape:

```json
{
  "verdict": "candidate_bug | likely_test_issue | insufficient_evidence",
  "earliest_anomaly": {
    "evidence_id": "events.json#123",
    "timestamp": "2026-08-27T00:00:00.000Z",
    "observation": "A concise observable discrepancy."
  },
  "hypotheses": [
    {
      "title": "Falsifiable one-line statement",
      "confidence": "low | medium | high",
      "evidence": ["events.json#123", "assertions.json#4"],
      "minimal_reproduction": ["step 1", "step 2"],
      "automatable_oracle": "Exact assertion that would confirm or refute it"
    }
  ],
  "usability_findings": [
    {
      "user_goal": "What the user was trying to do",
      "friction": "Observed obstacle, not a preference",
      "observable_evidence": "Screenshot/DOM/DTO/event reference",
      "suggested_validation": "A concrete follow-up check"
    }
  ],
  "stop_reason": null
}
```

Runner prompt:

> Execute exactly one named long-task validation scenario. Work only in the
> supplied disposable workspace. Do not edit tracked source, configuration, or
> any external system. Abort immediately if an external effect is planned or
> attempted. Run each action in order, collect the required evidence bundle,
> evaluate only the listed hard assertions, and return a compact run summary.
> Do not diagnose or fix failures.

Triager prompt:

> You are a read-only incident triager for a durable long-task runtime. Analyze
> only the supplied evidence bundle. Return only the required JSON object. A
> passing command is not evidence that user-visible behavior is correct. Every
> claim must cite an evidence id. Do not propose code changes, run commands,
> accept replans, or claim a bug is confirmed. Prefer `insufficient_evidence`
> when an observation cannot be reproduced by an explicit oracle.

## First validation suite: 35 scenarios

### State, safety and recovery (20)

| ID | Scenario | Hard oracle |
|---|---|---|
| LT-STATE-001 | Create read-only goal | Stable task ID; valid initial state and revision |
| LT-STATE-002 | Confirmation-required plan | No attempt starts before confirmation |
| LT-STATE-003 | Confirm plan and run | Attempt follows `TaskAttemptStarted` and terminal result |
| LT-STATE-004 | Pause running goal | Scheduler stops; state and reason are durable |
| LT-STATE-005 | Resume paused read-only goal | New execution progresses without changing goal ID |
| LT-STATE-006 | Cancel running goal | Attempt is terminalized as interrupted/cancelled; no retry |
| LT-STATE-007 | Reject plan proposal | Current applied revision remains unchanged |
| LT-STATE-008 | Accept safe pending replan | Revision fence holds and accepted revision becomes current |
| LT-STATE-009 | External-effect replan proposal | Never auto-applied; state awaits confirmation |
| LT-STATE-010 | Stale control revision | Named API returns conflict with current revision |
| LT-STATE-011 | Edit original goal | Append-only goal version; scheduler pauses; proposal is fenced |
| LT-STATE-012 | Archive terminal goal | Hidden from default list, visible in archived inventory |
| LT-STATE-013 | Restore archived goal | Archive marker removed; execution does not restart |
| LT-STATE-014 | Purge expired archive | Only old archive is removed with its projections |
| LT-RECOVERY-001 | Restart after completed goal | Projection and artifacts reconstruct identically |
| LT-RECOVERY-002 | Restart during read-only attempt | Attempt terminalizes/interruption is durable |
| LT-RECOVERY-003 | Resume interrupted read-only task | Safe retry gets a distinct attempt ID |
| LT-RECOVERY-004 | Interrupted external effect | Goal pauses pending explicit resolution |
| LT-RECOVERY-005 | Duplicate resume request | No duplicate concurrent attempt |
| LT-RECOVERY-006 | Conversation-stop signal | Interruption, not failure/replan evidence |

### Fault injection and contracts (10)

| ID | Scenario | Hard oracle |
|---|---|---|
| LT-FAULT-001 | Planner returns invalid JSON | No plan revision is applied; failure recorded |
| LT-FAULT-002 | Planner returns cyclic DAG | Plan validation rejects it atomically |
| LT-FAULT-003 | Missing task contract field | Plan validation rejects it atomically |
| LT-FAULT-004 | Child session cannot start | Attempt fails with evidence and retry policy is honored |
| LT-FAULT-005 | Child exceeds timeout | Attempt reaches durable terminal state once |
| LT-FAULT-006 | Validator rejects output | Failure evidence precedes permitted replan trigger |
| LT-FAULT-007 | Required artifact missing | Dependency does not receive fabricated context |
| LT-FAULT-008 | Artifact exceeds inline limit | Manifest persists without oversized inline payload |
| LT-FAULT-009 | Event append replay | Projection remains idempotent and ordered |
| LT-FAULT-010 | Automatic replan planner failure | Existing revision remains inspectable; goal is safely paused |

### UI task completion and comprehension (5)

| ID | Scenario | Hard oracle and LLM review target |
|---|---|---|
| LT-UI-001 | Create and locate active task | Status label, goal and next action are visible |
| LT-UI-002 | Inspect a failed task | Failure reason and safe next action are visible without raw event names |
| LT-UI-003 | Inspect a replan proposal | Revision, impact and accept/reject controls are comprehensible |
| LT-UI-004 | Jump to current session | Opens linked session or shows actionable attach guidance |
| LT-UI-005 | Archive and restore disposable task | Confirmation, archived filtering and restore feedback are visible |

For UI scenarios, the LLM may flag only evidence-backed friction: absent status
text, no actionable recovery route, conflicting state across surfaces, no action
feedback, unexplained destructive action, or a control unavailable in the
displayed state. Visual taste is out of scope.

## Failure handling and metrics

Hard failures are assertion failures, unbounded timeout, broken event invariant,
external-effect attempt, or incomplete evidence. They automatically create a
review item. LLM usability observations are soft findings until a reviewer or a
new executable oracle corroborates them.

Every run reports: total executions; hard pass rate; failure rate by risk and
tag; timeout rate; evidence-completeness rate; LLM candidate count; candidate
confirmation rate; median reproduction time; and permanent scenarios added.

Release gates: all critical/high deterministic scenarios pass; no unreviewed
hard failures; no external-effect safety violation; and all UI findings are
either resolved, accepted as a product decision, or retained with an owner.

## Review loop

1. Run deterministic scenarios first: state/recovery, then fault injection.
2. Inspect runner reliability and evidence completeness before enabling UI
   triage.
3. Send only failed or risk-signaled bundles to the low-cost triager, except
   the five UI scenarios which receive review on every run.
4. Reproduce candidate bugs with the triager's oracle.
5. Convert confirmed bugs into a minimal deterministic regression scenario.
6. Track false positives as prompt counterexamples; retain original evidence.
