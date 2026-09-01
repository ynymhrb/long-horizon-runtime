---
feature_ids: [aris-pilot]
topics: [aris, benchmarking, long-horizon-runtime, evidence]
doc_kind: design
created: 2026-09-02
---

# ARIS single-task pilot design

## Goal

Provide one reproducible, single-seed comparison between `ARIS Only` and
`ARIS + Long Horizon Runtime`. The runner measures execution evidence and
control-variable integrity; it deliberately does not claim a research-quality
effect from one sample.

## Boundary

The operator supplies the two DSH launch commands and a fully pinned
environment snapshot. The runner launches each command once, without a shell,
records exit/timing/stdout/stderr, and creates an immutable evidence bundle.
It never installs plugins, edits a DSH profile, starts a model itself, or
performs a blind review.

## Comparability

Both groups carry the same `shared` object: DSH version, ARIS commit and skill
count, model/provider parameters, prompt/data hashes, tool/MCP inventories,
token and wall-time budgets, and seed. A comparison is rejected unless those
objects are deeply equal. The only allowed group difference is
`longTaskPlugin.enabled`, which must be `false` for `aris_only` and `true` for
`aris_plus_long_task`.

## Evidence

The pilot writes `pilot.json`, `preflight.json`, `commands.ndjson`, two
redacted stdout/stderr files, and `manifest.json`. The manifest hashes every
other file, allowing a reviewer to identify exactly what was run without
collecting secrets. A non-zero child exit remains evidence, not a runner crash.

## Non-goals

This is not a multi-seed evaluator, an LLM judge, an ARIS installer, or a
replacement for the existing deterministic validation scenario runner.
