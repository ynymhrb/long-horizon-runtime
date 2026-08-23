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
