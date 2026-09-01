---
feature_ids: [aris-pilot]
topics: [aris, benchmarking, long-horizon-runtime, evidence]
doc_kind: implementation_plan
created: 2026-09-02
---

# ARIS Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, reproducible CLI that executes one ARIS-only and one ARIS-plus-plugin task seed and writes comparable evidence.

**Architecture:** A small ESM module under `validation/aris-pilot/` validates an explicit JSON configuration, proves the control variables are identical, then executes supplied command/argument vectors through `spawn`. An evidence writer redacts output and hashes every finalized file. The CLI is an adapter only; it does not launch DSH implicitly or alter any DSH configuration.

**Tech Stack:** Node.js ESM, node:child_process, node:crypto, node:fs/promises, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-aris-pilot-design.md`

## Global Constraints

- Do not modify DSH source or a user-profile configuration.
- Treat every supplied command as an explicit operator-authorized experiment invocation; use `spawn(command, args, { shell: false })`.
- Reject any control-variable drift and any group difference besides `longTaskPlugin.enabled` before launching a command.
- Redact credential-looking keys and values before writing evidence.
- Every behavior change starts with a focused failing Vitest test.

---

### Task 1: Pilot contract and control fence

**Files:**
- Create: `validation/aris-pilot/contract.mjs`, `validation/aris-pilot/contract.d.mts`
- Create: `tests/aris-pilot.spec.ts`

**Interfaces:**
- Produces `validatePilotConfig(value)` with two normalized group definitions.
- Produces `assertComparable(config)` which throws before execution on drift.

- [x] **Step 1: Write failing tests** for a valid pair, a changed model field, and an invalid plugin flag.
- [x] **Step 2: Run** `pnpm vitest run tests/aris-pilot.spec.ts` and observe the missing-module failure.
- [x] **Step 3: Implement** strict field checks and a stable deep comparison of `shared` values.
- [x] **Step 4: Re-run** the focused test and confirm it passes.

### Task 2: Command execution and immutable evidence

**Files:**
- Create: `validation/aris-pilot/runner.mjs`, `validation/aris-pilot/runner.d.mts`
- Modify: `tests/aris-pilot.spec.ts`

**Interfaces:**
- Produces `runPilot({ configFile, evidenceRoot })` and an evidence directory.
- Each group result contains command, exit code, elapsed time, and paths to redacted captured output.

- [x] **Step 1: Write failing tests** using `process.execPath` to create deterministic output and prove the manifest hashes outputs.
- [x] **Step 2: Run** `pnpm vitest run tests/aris-pilot.spec.ts` and observe the missing runner failure.
- [x] **Step 3: Implement** no-shell child execution, output capture/redaction, and a manifest written after all evidence.
- [x] **Step 4: Re-run** the focused test and confirm it passes.

### Task 3: CLI, example, and operator handoff

**Files:**
- Create: `validation/aris-pilot/cli.mjs`, `validation/aris-pilot/README.md`, `validation/aris-pilot/example.json`
- Modify: `package.json`, `README.md`, `tests/aris-pilot.spec.ts`

**Interfaces:**
- Produces `pnpm aris:pilot -- --config <file> --evidence-root <dir>`.

- [x] **Step 1: Write failing CLI tests** for required flags and a successful fixture run.
- [x] **Step 2: Run** `pnpm vitest run tests/aris-pilot.spec.ts` and observe the missing CLI failure.
- [x] **Step 3: Implement** flag validation, example configuration, and documentation that explains the one-seed limitation.
- [x] **Step 4: Run** focused tests, `pnpm typecheck`, `pnpm build`, and a CLI smoke invocation using a temporary evidence directory.
- [ ] **Step 5: Commit** the tested change, then merge the branch into `master` while preserving unrelated work.

## Plan self-review

The plan covers the design's contract, comparability fence, safe execution,
evidence bundle, CLI, and documentation. It intentionally excludes evaluation
quality claims, plugin installation, and external profile mutation.
