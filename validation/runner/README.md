# Deterministic scenario runner

This directory is the runner tooling for the
[long-task production validation handbook](../../docs/superpowers/specs/2026-08-27-long-task-production-validation-handbook.md).
It turns a versioned scenario file into one immutable evidence bundle with a
deterministic verdict. Runner tooling is new code: it never modifies tracked
runtime source, configuration, dependency manifests, or tests, and it never
touches user-layer configuration, agent presets, or external systems.

## Entrypoint

Execute exactly one named scenario in a supplied disposable workspace:

```sh
node validation/runner/cli.mjs run <scenario-id-or-file> \
     [--scenario-root <dir>]   # default: <repo>/scenarios
     [--workspace <dir>]       # default: a unique mkdtemp workspace
     [--evidence-root <dir>]   # default: <repo>/validation/evidence
     [--keep-workspace]        # keep the disposable workspace after the run
```

`<scenario-id-or-file>` is either a scenario id such as `LT-EXAMPLE-001`
(found recursively under the scenario root) or a direct path to a
`.yaml`/`.yml`/`.json` scenario file.

Exit codes: `0` pass · `1` fail · `2` usage/contract rejection ·
`3` inconclusive · `4` hard_stop (external effect detected). The command
prints a compact JSON run summary; the evidence bundle is the durable output.

Programmatic use (this is what the self-tests do):

```js
import { runScenario } from './validation/runner/runner.mjs'
const result = await runScenario({ scenarioFile, evidenceRoot, repoRoot })
// result.verdict: 'pass' | 'fail' | 'inconclusive' | 'hard_stop'
```

## Contract validation

`contract.mjs` loads YAML (a strict, dependency-free subset — see `yaml.mjs`)
or JSON and enforces the handbook Scenario contract. A scenario is **rejected
before anything executes** when:

- any required field is missing (`id`, `title`, `risk`, `kind`, `tags`,
  `preconditions`, `setup`, `actions`, `hard_assertions`, `evidence_required`,
  `llm_review`, `expected_user_outcome`, `cleanup` — all reported at once);
- `risk`/`kind`/`llm_review` hold values outside the contract, `actions` is
  empty, an evidence item name is unknown, or an `exploratory_ui` scenario
  does not require `screenshots`;
- the planned work is not unambiguously `read_only`: an explicit
  `side_effect_class` or `fault_injection.planned_side_effect_class` must
  equal `read_only`, or the tags must include `read_only`; a scenario action
  declaring `side_effect_class: external_effect` is likewise rejected.

## Run model

For each run the runner:

1. creates (or adopts the supplied) unique disposable workspace and a **fresh
   durable database** at `<workspace>/durable.sqlite`;
2. executes `setup` and every action literally, in order: `run:` commands go
   through the local shell inside the workspace with a per-command timeout
   (process-tree kill on timeout), `%LT_*%` placeholders and `LT_*`
   scenario-scoped environment variables; `uses:` names a runner built-in
   (`import_staging`, `ui_web_host`); narrative-only steps are recorded for
   the audit trail;
3. **hard-stops immediately** when an action declares an external effect or
   command output reveals one — an external effect is a hard stop, never a
   scenario failure to work around;
4. captures the **evidence bundle before cleanup**: `run.json`,
   `commands.ndjson`, `task.json`, `events.json`, `snapshot.json`,
   `artifacts.json`, `assertions.json`, `environment.json` (redacted), plus
   `screenshots/` for UI scenarios. Absent staged exports become explicit
   empty shells; secrets, large artifact bodies and unrelated user data never
   enter the bundle;
5. evaluates **only the listed hard assertions**, each through its explicit
   `evaluate:` oracle binding against recorded evidence (no subjective
   assertions — an assertion without an executable oracle is `unevaluated`);
6. derives the verdict: `hard_stop` > `fail` (assertion failure, run error,
   timeout) > `inconclusive` (**missing required evidence or an unevaluated
   assertion — never pass**) > `pass`;
7. applies the scenario cleanup policy (the disposable workspace is deleted
   only after the bundle is complete; `run.json` carries a SHA-256 inventory
   of every other bundle file).

`harness.mjs` is the executable binding between scenario actions and the built
runtime (`dist/`): it drives fixture planner/executor doubles against the
run's fresh database (goal lifecycle, replans, fault injection) and stages
`task.json`/`events.json`/`snapshot.json`/`artifacts.json` exports for the
runner. All fixture plans are `read_only` by construction.

UI scenarios (`kind: exploratory_ui`) get a `screenshots/` directory and may
start a local DSH Web host through the `ui_web_host` binding, which selects a
free port that never collides with the reserved ports 3003/3004/3080
(`ports.mjs`, `LT_DSH_ROOT` must point at a deepseek-harness checkout).

## Example

```sh
node validation/runner/cli.mjs run LT-EXAMPLE-001 \
     --scenario-root validation/scenarios
```

`../scenarios/examples/LT-EXAMPLE-001.yaml` creates a read-only goal through
the harness, runs it to a durable success, and verifies exact goal state,
stable task id, event ordering, attempt state/count, absence of external
effects and command exit codes.

## Self-tests

`tests/scenario-runner.spec.ts` (run with `pnpm test`) proves: rejection of
missing fields and non-read_only scenarios, YAML/JSON parity, the verdict
lattice (missing evidence ⇒ inconclusive, unevaluated ⇒ inconclusive,
external effect ⇒ hard_stop), evidence-before-cleanup on failures, secret
redaction, timeout tree-kill, port reservation, and the end-to-end example
bundle.
