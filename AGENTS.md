# Project Rules

## Long-task runtime configuration and deployment

The plugin bundle owns its default host configuration. When developing or
releasing this plugin, change defaults only in
`D:\code\long-horizon-runtime\cordis.patch.yml`. This file is installed into
every target profile by `dsh plugin --profile web add` and is the sole source
of truth for plugin defaults.

Do not edit a user's profile configuration to change plugin defaults.

For a machine-local deployment override that must not alter the packaged
plugin, edit only
`C:\Users\19632\.dsh\profiles\web\cordis.patch.yml`. Leave this user-layer
patch empty by default; use it only for an intentional local customization.

`C:\Users\19632\.dsh\.agent-presets\long-task\agent.cordis.yml` belongs to
the agent plane, not the Web host plane. It assembles what an agent session
looks like: the plugins it mounts and the tools and prompts visible to the
model. It mounts `long-task-runtime` in an isolate realm so the agent receives
the `long_task_*` tools.

The `databasePath` in that agent preset must resolve to the same SQLite file
configured by the installed host bundle. Tool writes and host/UI reads must
therefore always use one shared durable database.

## Long-task lifecycle and replan rules

### Task identity and original-goal versions

- A durable task ID never changes. A user edit changes the task's original
  goal through an append-only goal-version record, with the requested text,
  authoring source, timestamp, and required reason.
- A goal edit pauses scheduling and asks the planner for a new revision using
  the new goal, verified artifacts, and remaining work. Previous plans,
  events, and artifacts remain auditable.
- Preserve completed work only when the planner can prove it remains within
  the new goal's scope. Any affected downstream region is superseded in the
  next revision; external effects and scope-reducing changes require explicit
  confirmation.

### Automatic replanning

- A failed validation, missing dependency artifact, or recorded contradictory
  evidence may cause the runtime to request a local replan.
- Apply a proposal automatically only when it replaces uncompleted,
  `read_only` work, leaves verified artifacts and completed nodes intact, and
  does not expand the original goal's scope.
- Any proposal that touches external effects, invalidates completed work,
  expands scope, or cannot establish a bounded affected subgraph must pause
  the task awaiting confirmation. No replan may overwrite the current plan;
  every proposal is a revision-fenced, durable event.

### Task Area controls and accessibility

- The Cockpit exposes: modify original goal, pause/resume, jump to an attached
  current session, and delete/archive. It uses the same revision-fenced
  service API as model tools.
- “Modify original goal” opens a goal-and-reason form; it never offers an
  unsafe free-form DAG editor. “Jump to conversation” opens the task's current
  session link, or guides the user to attach a session when none exists.
- Delete cancels active execution first, then archives the task. Archived
  tasks are hidden from the default list, recoverable for 30 days, and then
  physically purged with their plan revisions, events, links, and artifacts.
- The DAG uses status-colored frames plus visible text labels and a persistent
  legend. Color is never the only state signal. The event panel is a readable
  chronological audit trail with timestamps, reason/impact summaries, and
  revision navigation rather than raw internal event names.

### Compatibility and failure presentation

- A historical task that fails before planning may have no plan revision or
  DAG. The UI must present its durable state and failure timeline as no-plan
  history, never as an indefinitely loading Cockpit.
