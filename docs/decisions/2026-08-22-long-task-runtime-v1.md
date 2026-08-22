# Long-Task Runtime V1 implementation decisions

## Development dependency links

The published package declares DSH packages as peer dependencies. Local development links its DSH dev dependencies to `D:\code_github\deepseek-harness` package directories so tests compile against the requested checkout rather than a mismatched registry release. `@deepseek-ai/cordis` is version `4.0.1`; it is not part of the `0.1.0-rc.7` DSH package version family.

## DSH plugin boundary

The plugin uses `ctx.provide('longTaskRuntime', runtime)` rather than assigning a property, and every model-facing handler requires the current `ToolRunContext.agent`. The agent is retained in an `AsyncLocalStorage` scope only while the tool invokes the runtime, allowing planner and worker adapters to call `ctx.subagents.start(providerName, request)` without persisting a live Agent object.

The adapters request DSH structured output, fall back to parsing a final JSON text response for compatible providers, and always call `run.dispose()` in `finally`. Worker results include the returned child session id as `dshSessionId`; the scheduler must persist that id in a follow-up event because the attempt-start event precedes child creation.
