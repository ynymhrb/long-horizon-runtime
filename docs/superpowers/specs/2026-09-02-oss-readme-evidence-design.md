# Open-source README evidence design

## Goal

Make the repository landing page communicate the runtime's differentiated value within one screen: safe replanning, inspectable task progress, and durable recovery, backed by reproducible local evidence rather than unqualified claims.

## Audience and message

The primary reader is a DeepSeek Harness user evaluating whether to install an open-source plugin for multi-step work. The page must make four claims in plain language:

1. A failed bounded read-only region can be replanned without discarding completed verified work.
2. The Task Area makes task state, DAG dependencies, timeline, decisions, and next actions inspectable.
3. Interrupted read-only work is durably recorded and can resume safely; external effects remain fenced for explicit operator resolution.
4. Task identity, plans, evidence, and artifacts persist across conversations.

## Evidence policy

- Every behavior statement is traceable to an immutable local validation bundle, a tracked scenario contract, or a source-level documented invariant.
- Do not claim a benchmark improvement, a reliability percentage, or passed UI acceptance unless a current cited run measured it.
- Use only disposable local databases, profiles, and workspaces. Do not use real user tasks, modify a user profile patch, or trigger external effects.
- Curated screenshots come from a local DSH Web host and tracked UI scenarios, contain no credential, personal path, or unrelated conversation, and are omitted if not reproducible.
- Deterministic and manual UI evidence are labeled separately. The recorded 30/30 deterministic result may be cited with its scope; the five UI scenarios are not called passed without new evidence.

## README structure

Add an early `Why Long Horizon Runtime` section before installation. It contains a concise positioning paragraph, a three-row capability/evidence table, and up to three annotated screenshots: replan proposal, task DAG/timeline, and safe recovery. Keep installation, routing configuration, and lifecycle details where they are. Add a short `Evidence and demos` section linking the validation handbook and reproduction workflow.

## Assets

Committed image assets live in `docs/assets/readme/` with stable descriptive names. README uses relative Markdown links. Original captures and machine-readable evidence remain ignored under `validation/evidence/`; only reviewed, redacted product screenshots are committed.

## Verification and release

Run selected deterministic scenarios from a clean build and inspect `assertions.json`, `events.json`, `snapshot.json`, and `run.json`. When local DSH Web is available, execute the three UI flows in a disposable profile and use their required screenshots as sources. Before publishing run Markdown/link checks, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm pack --dry-run`, and `git diff --check`. Merge the verified isolated branch into `master` and push `origin/master`.

