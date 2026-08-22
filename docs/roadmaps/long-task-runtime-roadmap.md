# Long-Horizon Agent Runtime roadmap

## Purpose

This roadmap sequences the Long-Horizon Agent Runtime from its durable single-agent base to heterogeneous multi-agent execution. It defines intended outcomes, dependencies, acceptance results, and risks; detailed behavior remains in a version-specific design document created when that phase begins.

## Principles

- The Runtime state, not a conversation transcript, is the authority for every long task.
- Every phase adds on durable events, versioned graphs, explicit artifacts, and source-linked evidence.
- A phase starts only after its prerequisite behavior has been exercised with representative long tasks.
- UI and agent adapters consume the same Runtime service API; neither independently owns task state.
- Scope may be reprioritized after each phase's validation. The phase number is an ordering aid, not a release-date promise.

## Phase sequence

| Phase | Outcome | Depends on | Completion evidence | Principal risk |
| --- | --- | --- | --- | --- |
| V1 | Durable single-agent Runtime foundation: SQLite event store, checkpointed DAG scheduling, DSH child-agent execution, chat controls, safe retry, and constrained graph mutation. | DSH plugin, session, tool, and subagent seams. | A process interruption resumes without rerunning successful tasks; a chat user can create, inspect, confirm, resume, cancel, split, and invalidate a goal. | Recovery semantics diverge from DSH child-session lifecycle. |
| V2 | Artifact contracts, context reconstruction, and layered task/project/episodic memory. | V1 durable artifacts and execution records. | A downstream task receives only explicit dependency artifacts and relevant memory, with sources traceable to executions. | Context selection becomes too large or too lossy. |
| V3 | Policy-driven local replan: Planner proposes graph changes from failure or evidence, and Runtime validates and applies or awaits approval. | V1 GraphMutation and V2 evidence/context. | A disproven assumption invalidates only its reachable dependent subgraph; the replacement graph preserves unrelated successful work. | A planner proposes unsafe or low-quality graph changes. |
| V4 | Long-task UI: graph, timeline, task detail, executions, artifacts, evidence, memory, and accounting views. | Stable V1-V3 query and event APIs. | UI reconstructs a goal solely from Runtime queries/events and controls it without bypassing the service. | UI requirements expose missing Runtime query semantics. |
| V5 | Heterogeneous multi-agent execution and routing policies. | Stable ExecutionAdapter and AgentProfile boundaries. | One graph routes tasks to different model/agent profiles while preserving uniform execution history and recovery. | Model-specific capability and permission differences leak into Task semantics. |
| V6 | Budgeting, evaluation, and adaptive execution policy. | V5 aggregate accounting and comparable execution telemetry. | Runtime enforces per-goal/task budgets and compares retry/agent choices against recorded outcomes. | Measurements are incomplete or misleading across providers. |
| V7 | Learned and vector-backed memory retrieval. | V2 source-linked memory and V6 evaluation. | Retrieval can improve context selection while every included memory item remains inspectable and source-linked. | Opaque retrieval degrades correctness or traceability. |
| V8 | Cross-environment execution and advanced autonomy. | Proven durable state, security policy, and multi-agent routing. | Goals recover across approved execution environments with auditable capability and identity boundaries. | Distributed consistency, security, and operator complexity. |

## Decision gates

- Do not begin V2 until V1 has run representative coding or research goals through interruption and resume.
- Do not automate V3 replanning until user-reviewed mutations demonstrate valid local replacement behavior.
- Do not begin V4 until the Runtime query API exposes stable, paginated state and event views.
- Do not begin V5 until one ExecutionAdapter can be replaced without changing Task or event semantics.
- Do not begin V6-V8 until the preceding phase has enough real execution data to evaluate it.

## Documents

- V1 detailed design: `docs/specs/2026-08-22-long-task-runtime-v1-design.md`.
- Each later phase receives its own approved design and implementation plan before development begins.
