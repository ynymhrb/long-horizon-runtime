# Long-Task Runtime V5–V7 Design

## Status

Proposed for review. This document designs three serial releases. V8 remains
explicitly out of scope.

## Goal

Add safe heterogeneous agent routing (V5), enforceable budgets and
evidence-based execution policy (V6), and explainable local memory retrieval
(V7), without weakening durable task, artifact, replan, or delegated-tool
authority boundaries.

## Revised delivery gates

The roadmap's requirement for prior real-production execution data is replaced
with an auditable staged gate for these releases:

1. deterministic unit/replay tests and synthetic benchmark fixtures;
2. fault-injection tests covering timeout, provider/profile rejection, budget
   exhaustion, restart/replay, and invalid memory candidates;
3. a local, opt-in DSH Web smoke run using only configured `spawn` profiles;
4. explicit per-feature configuration enablement.

No feature automatically becomes enabled merely because a preceding phase is
implemented. Metrics collected by V6 may later justify changing the deployment
default, but that is a separate configuration decision.

## Non-negotiable invariants

- SQLite events and projections remain the source of truth; profiles, budgets,
  evaluations, index entries, and retrieval decisions are append-only records.
- Existing plans, task IDs, artifact identities, goal revisions, control
  revisions, cancellation, archival retention, and replan safety rules retain
  their semantics.
- A delegated planner or worker always receives the existing lifecycle/native
  goal deny-list plus its selected profile's tool restriction. Profile routing
  cannot grant a tool absent from the host policy.
- A profile may narrow a node's allowed capability or effect class but can
  never upgrade `read_only` into `idempotent`/`external_effect`, or bypass
  confirmation for an external effect.
- Unknown, disabled, incompatible, or over-budget choices reject before a
  child starts. There is no silent fallback to another model/profile.
- New persistent data is migratable and replayable. Removing a configuration
  entry never erases the historic profile/capability snapshot held by attempts.

## V5: heterogeneous profiles and deterministic routing

### Configuration and profiles

`cordis.patch.yml` retains `spawn` as the default. A new optional
`agentProfiles` configuration declares named profiles with a DSH provider name,
optional agent options, a maximum child timeout, optional tool deny additions,
and declared capabilities. A profile is enabled only when it is explicitly
listed. The default profile is represented by a normalized immutable snapshot,
so existing tasks continue to run unchanged.

Each `TaskDraft` gains an optional `executionProfile` selector and optional
`requiredCapabilities`. The planner schema may request them, but validation
requires that names are nonempty, required capabilities are declared by the
chosen profile, and profile timeout only narrows an existing node/deployment
limit. A task without a selector uses the configured default profile.

### Routing decision

Before scheduling an attempt, `ProfileRouter.resolve()` receives the current
node, normalized configuration, and goal policy. It returns either an exact
`ResolvedExecutionProfile` or a typed rejection reason. Its decision is pure:
the scheduler persists `ExecutionProfileResolved` before starting the child.
The stored payload includes profile ID, provider name, agent-option hash,
effective timeout, capability snapshot, effective deny list, and selection
reason. Provider secrets or arbitrary agent-option values are never written.

The execution adapter accepts a resolved profile rather than looking up global
configuration itself. DSH child start uses that profile's provider and options;
the final tool filter is the union of `CHILD_TASK_TOOL_DENY` and the profile
deny additions. This preserves adapter substitutability and makes every
attempt comparable.

### Failure and recovery

Routing rejection records a durable failed/blocked scheduling decision without
creating a child attempt. A provider start failure has the ordinary durable
attempt failure/retry behavior. Recovery reuses the resolved profile snapshot
of an already-started attempt; a new retry performs and records a new routing
decision. Removing a profile makes future work reject, never reroute history.

### V5 acceptance

Tests demonstrate two tasks selecting different profiles, exact DSH child
provider/options/deny-list forwarding, deterministic rejection of unknown or
capability-incompatible profiles, replay of historic selection records, and
unchanged behavior for a task with no selector.

## V6: budgets, telemetry, and bounded policy choice

### Budget model

Goals and nodes may declare `BudgetLimit` values: `maxAttempts`,
`maxWallTimeMs`, `maxEstimatedTokens`, and `maxEstimatedCostMicros`. Omitted
dimensions are unlimited; a non-negative integer is required for each present
dimension. Goal budget combines with node budget by taking the stricter limit.

Before a child starts, the scheduler asks `BudgetLedger.reserve()` for the
selected profile and effective timeout. It appends `BudgetReserved` only if the
reservation fits every finite dimension. On settle, it appends
`BudgetSettled`, actual duration, and reported/estimated usage. If a provider
does not report token/cost usage, the profile's explicit fixed estimate is
used and marked `estimated`; no fabricated precision is displayed.

If no reservation fits, append `BudgetExhausted`, pause the goal with a durable
reason, and expose a revision-fenced `extend_budget` control. Resuming without
an approved extension must not dispatch more children. Cancellation and child
start failure release an unsettled reservation through a compensating event.

### Evaluation telemetry

Each settled attempt writes an `ExecutionEvaluationRecorded` event with the
profile snapshot reference, outcome, duration, retry ordinal, validator
outcome, artifact-contract outcome, and normalized usage. Evaluation events
are facts, not a model self-rating. Aggregated summaries are projection-only
and can be rebuilt from events.

### Adaptive policy

`ExecutionPolicy` is a pure interface whose initial implementation is
deterministic and opt-in: it ranks only compatible, enabled profiles from the
node's allowed profile set using configured preference order and the replayable
aggregate success/latency/cost summaries. It emits a `PolicyDecision` with all
candidates, excluded reasons, scores, selected profile, and policy version.

Default configuration remains `policyMode: fixed`: the task selector/default
profile is used. `policyMode: evaluated` requires explicit enablement and
cannot choose a profile outside the node's declared allow-list, choose one
with an incompatible capability/effect class, or override a rejected budget.
The decision is persisted before budget reservation and child start.

### V6 acceptance

Tests cover budget composition, atomic reservation/settlement/release under
replay, exhaustion before child start, revision-fenced extension, recorded
telemetry, deterministic ranking, exclusion explanations, and fixed-mode
backward compatibility.

## V7: source-linked, explainable memory retrieval

### Memory records and index

Existing L1–L3 memory remains authoritative. V7 adds a `MemoryIndex` boundary
and durable `MemoryIndexed`/`MemoryIndexSuperseded` events. Index content is a
versioned local derived projection keyed by memory ID and content hash. The
initial implementation uses deterministic token/BM25-style lexical scoring
with optional lightweight embedding vectors supplied by an injected local
embedder; it introduces no hosted vector service or network requirement.

The index may be rebuilt from source memory records. An index entry is never
itself evidence of validity: retrieval first filters active, source-linked,
workspace-compatible, non-invalidated memory.

### Retrieval contract

`MemoryRetriever.retrieve()` takes a goal/node context, declared memory budget,
and query terms generated from the durable objective, node objective, contracts
and dependency summaries. It returns a `RetrievalDecision`: candidates with
component scores, exclusions with reasons, selected memory IDs, token estimate,
algorithm/version, and query-hash. Deterministic tie breaking is memory ID.

Context assembly adds only selected items to `ContextManifest`. The manifest
stores the retrieval decision reference and each item's source event/artifact
reference and selection reason. A hard item-count/token budget is applied
after mandatory direct-dependency artifacts; memory can never displace an
explicit required artifact. The caller can inspect all candidates without
recovering raw private content from an event payload.

### Learning boundary

V7 may record explicit retrieval feedback from validator outcomes and user
decisions as `MemoryRetrievalFeedbackRecorded`. It does not train a model or
silently alter ranking in this release. An optional policy can use only
approved feedback weights with a persisted policy version; the default ranking
is deterministic lexical/hybrid retrieval. This preserves explainability and
allows an eventual learned retriever to be evaluated against the V6 fixtures.

### V7 acceptance

Tests demonstrate deterministic ranking, source/validity filtering, mandatory
artifact precedence, complete manifest explanation, index rebuild/replay,
feedback audit events, and stable legacy context when retrieval is disabled.

## Release sequence

1. V5 publishes profile types, validation, routing events/projections and DSH
   adapter forwarding. It does not enable evaluated profile choice.
2. V6 consumes V5 resolved-profile events, introduces ledger/evaluation/policy,
   and remains fixed-mode by default.
3. V7 consumes V2 memory/context records and V6 evaluation-format fixtures,
   adding a disabled-by-default retriever/index and manifest explanations.

Each release increments the plugin's minor version, updates the roadmap and
README, runs the full test/typecheck/build/package checks, and has an opt-in
local DSH smoke test. V8's cross-environment execution protocol is not
designed or implemented here.
