# Open-source README evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the README into an evidence-backed open-source landing page that demonstrates safe replanning, task visualization, and durable recovery.

**Architecture:** Preserve the existing English README and installation workflow. Add a concise value-and-evidence section near the top, fed only by tracked scenario contracts and freshly generated disposable evidence bundles; commit only reviewed, redacted UI screenshots in a documentation-assets directory. Raw run bundles remain ignored and the README links readers to the validation handbook for reproduction.

**Tech Stack:** Markdown, local Node.js/Pnpm scripts, deterministic validation runner, DeepSeek Harness Web (local disposable profile), Git.

**Spec:** `docs/superpowers/specs/2026-09-02-oss-readme-evidence-design.md`

## Global Constraints

- Modify only `D:\\code\\long-horizon-runtime`; never edit DSH source, a user profile patch, or agent presets.
- Run all executable evidence in fresh disposable workspaces/databases; no scenario may perform an `external_effect`.
- Do not present UI scenarios as passed until a local browser run supplies their required screenshots and assertions.
- Never commit `validation/evidence/`, `validation/reports/`, temporary profiles, secrets, or unredacted captures.
- Use an isolated `.worktrees/` worktree on a `codex/` branch, preserve unrelated changes, merge verified work into `master`, then push.

---

### Task 1: Establish reproducible claim evidence

**Files:**
- Read: `README.md`, `docs/superpowers/specs/2026-08-27-long-task-production-validation-handbook.md`
- Read: `scenarios/state-recovery/LT-STATE-008.yaml`, `scenarios/state-recovery/LT-RECOVERY-003.yaml`, `scenarios/fault-injection/LT-FAULT-006.yaml`
- Generate (ignored): `validation/evidence/readme-YYYYMMDD-HHMMSS/`

**Interfaces:**
- Consumes: `node validation/runner/cli.mjs run <scenario> --evidence-root <directory>`.
- Produces: an untracked ledger mapping each README claim to scenario ID, verdict, assertion IDs, bundle paths, and qualification.

- [ ] **Step 1: Build the tracked runtime**

Run:

```powershell
pnpm build
```

Expected: exit code `0`; `dist/` is current for the harness.

- [ ] **Step 2: Run the safe-replan scenario**

Run:

```powershell
$readmeEvidenceRun = "validation/evidence/readme-$(Get-Date -Format yyyyMMdd-HHmmss)"
node validation/runner/cli.mjs run LT-STATE-008 --scenario-root scenarios --evidence-root $readmeEvidenceRun
```

Expected: `pass`; record the assertion proving the revision fence and accepted safe proposal.

- [ ] **Step 3: Run interruption-recovery and validation-failure scenarios**

Run:

```powershell
node validation/runner/cli.mjs run LT-RECOVERY-003 --scenario-root scenarios --evidence-root $readmeEvidenceRun
node validation/runner/cli.mjs run LT-FAULT-006 --scenario-root scenarios --evidence-root $readmeEvidenceRun
```

Expected: both `pass`; recovery shows a new safe attempt, and validator failure records evidence before a permitted replan trigger.

- [ ] **Step 4: Inspect evidence before public copy**

Inspect each bundle's `run.json`, `assertions.json`, `events.json`, and `snapshot.json`. Make a local ledger with exactly:

```text
README claim | scenario | verdict | assertion IDs | evidence file references | qualification
```

Expected: every proposed behavior sentence has a ledger row; remove or soften unsupported copy.

- [ ] **Step 5: Check generated evidence stays untracked**

Run:

```powershell
git status --short validation/evidence validation/reports
```

Expected: no generated file is staged.

### Task 2: Capture and curate product screenshots

**Files:**
- Read: `scenarios/ui/LT-UI-002.yaml`, `scenarios/ui/LT-UI-003.yaml`, `scenarios/ui/LT-UI-005.yaml`
- Create: `docs/assets/readme/replan-proposal.png`
- Create: `docs/assets/readme/task-inspection.png`
- Create: `docs/assets/readme/recovery-timeline.png`

**Interfaces:**
- Consumes: local DSH Web with the built plugin in a disposable profile and the three named scenario contracts.
- Produces: reviewed PNGs plus corresponding disposable evidence bundles.

- [ ] **Step 1: Prepare a disposable host and profile**

Use a new profile/database/workspace outside the user profile; install the built plugin there and choose a free port excluding `3003`, `3004`, and `3080`.

Expected: `environment.json` identifies the temporary URL and no file under `C:\\Users\\19632\\.dsh\\profiles\\web\\` changes.

- [ ] **Step 2: Capture task inspection**

Follow `LT-UI-002` literally, exporting its required evidence. Capture the DAG, visible state label, and readable failure timeline for `task-inspection.png`.

Expected: no raw event type, credential, local absolute path, or unrelated task appears.

- [ ] **Step 3: Capture the fenced replan**

Follow `LT-UI-003` literally. Capture the Cockpit with `等待确认`, revision/reason, and accept/reject controls for `replan-proposal.png`.

Expected: the screenshot proves a proposal is held for confirmation rather than silently applied.

- [ ] **Step 4: Capture recovery or omit it**

Capture a read-only recovery state with durable interruption and safe resume for `recovery-timeline.png`. If the UI cannot make preservation of completed work and a new attempt ID legible, omit the asset and link deterministic evidence instead.

Expected: no placeholder or illustrative mock is committed.

- [ ] **Step 5: Stage only reviewed assets**

Run:

```powershell
git status --short docs/assets/readme validation/evidence
```

Expected: only curated PNGs are candidates for staging; original captures and bundles remain ignored.

### Task 3: Rewrite the README landing narrative

**Files:**
- Modify: `README.md:1-16`
- Modify: `README.md:105-116`
- Create or modify: `docs/assets/readme/*.png`

**Interfaces:**
- Consumes: Task 1 evidence ledger and Task 2 approved assets.
- Produces: `Why Long Horizon Runtime` with qualified value claims and GitHub-renderable images.

- [ ] **Step 1: Add positioning and capability/evidence table**

Insert `## Why Long Horizon Runtime` after the opening paragraph and before `## What it provides`, with this table shape:

```markdown
| What you get | What happens in a long task | Evidence boundary |
| --- | --- | --- |
| Safe replanning | ... | Bounded unfinished `read_only` work only; external effects and completed work require confirmation. |
| Inspectable progress | ... | ... |
| Durable recovery | ... | Interrupted work is recorded; retry/resume follows the task safety policy. |
```

Expected: terminology matches the implementation: `read_only`, verified artifacts, revision fence, and durable attempts; no unmeasured percentage appears.

- [ ] **Step 2: Embed visual proof only when it exists**

Use descriptive Markdown for each approved PNG:

```markdown
![A confirmation-fenced replan in the Task Cockpit](docs/assets/readme/replan-proposal.png)
```

For unavailable captures, link the relevant tracked scenario and handbook instead.

Expected: every image resolves in a clean clone and has explanatory alt text.

- [ ] **Step 3: Add evidence and limits note**

Near lifecycle safety, cite the recorded result as `30/30 deterministic state/recovery and fault-injection scenarios`, link the handbook, distinguish it from manual UI acceptance, and retain the strict auto-replan limits.

Expected: no statement calls the UI flows passed without new corresponding evidence.

- [ ] **Step 4: Check public text**

Run:

```powershell
rg -n "TODO|TBD|<timestamp>|30/30|LT-STATE-008|LT-RECOVERY-003|LT-FAULT-006|docs/assets/readme" README.md
```

Expected: no template marker remains; all scenario/numeric claims match the Task 1 ledger and every asset exists.

- [ ] **Step 5: Commit documentation**

Run:

```powershell
git add README.md docs/assets/readme docs/superpowers/specs/2026-09-02-oss-readme-evidence-design.md docs/superpowers/plans/2026-09-02-oss-readme-evidence.md
git commit -m "docs: showcase durable task runtime evidence"
```

Expected: the commit contains no generated evidence or profile data.

### Task 4: Verify, integrate, and publish

**Files:**
- Verify: `README.md`, `docs/assets/readme/*.png`, generated evidence bundles

**Interfaces:**
- Consumes: the committed feature branch.
- Produces: a verified `master` commit pushed to `origin`.

- [ ] **Step 1: Run repository verification**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
git diff --check
```

Expected: all exit `0`; report an unrelated existing failure rather than masking it.

- [ ] **Step 2: Verify the exact diff and remote**

Run:

```powershell
git status --short
git diff master...HEAD -- README.md docs/assets/readme docs/superpowers/specs/2026-09-02-oss-readme-evidence-design.md docs/superpowers/plans/2026-09-02-oss-readme-evidence.md
git remote -v
```

Expected: only intended documentation/assets differ and `origin` has a push URL; stop for direction if merging is unsafe or no remote exists.

- [ ] **Step 3: Merge safely**

From the primary checkout, merge the verified branch into `master` non-destructively. Do not reset, checkout over, or stash user changes.

Expected: `master` has the documentation commit and retains unrelated local work.

- [ ] **Step 4: Push**

Run:

```powershell
git push origin master
```

Expected: remote reports the new `master` commit; record SHA and remote URL in the delivery note.

## Plan self-review

- Spec coverage: Task 1 binds copy to evidence; Task 2 supplies reproducible/redacted visuals; Task 3 changes landing narrative and limits; Task 4 verifies, merges, and pushes.
- Scope: no runtime behavior, DSH source, user profile, provider account, or evaluation methodology changes.
- Interface consistency: Task 3 consumes the ledger/assets from Tasks 1–2; Task 4 verifies the exact committed paths from Task 3.
