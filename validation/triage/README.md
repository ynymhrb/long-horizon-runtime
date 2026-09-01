# Validation incident triage (`validation/triage/`)

LLM-assisted incident triage for the long-task production validation handbook
(`docs/superpowers/specs/2026-08-27-long-task-production-validation-handbook.md`).
The deterministic runner is the correctness oracle; this module is the
read-only incident triager that turns a failing, inconclusive, or
risk-signaled evidence bundle into the handbook's exact triage JSON contract.

## Files

- `contract.mjs` — the handbook "LLM triage contract" output shape plus a
  strict structural validator (`validateTriageReport`): required keys,
  enum-constrained `verdict` / `confidence`, at most three hypotheses.
- `prompts.mjs` — the runner and triager prompts, verbatim from the handbook.
  Asserted word-for-word against the handbook document by the self-tests.
- `bundle.mjs` — immutable evidence bundle loader; reads the runner's eight
  evidence files into one JSON-safe `EvidenceBundle` value.
- `triager.mjs` — produces the triage report from a bundle.
- `cli.mjs` — `node validation/triage/cli.mjs <evidence-dir>` prints the
  deterministic report; `--prompt runner|triager` prints the verbatim prompt.

## The exact triage JSON contract

```json
{
  "verdict": "candidate_bug | likely_test_issue | insufficient_evidence",
  "earliest_anomaly": {
    "evidence_id": "events.json#123",
    "timestamp": "2026-08-27T00:00:00.000Z",
    "observation": "A concise observable discrepancy."
  },
  "hypotheses": [
    {
      "title": "Falsifiable one-line statement",
      "confidence": "low | medium | high",
      "evidence": ["events.json#123", "assertions.json#4"],
      "minimal_reproduction": ["step 1", "step 2"],
      "automatable_oracle": "Exact assertion that would confirm or refute it"
    }
  ],
  "usability_findings": [
    {
      "user_goal": "What the user was trying to do",
      "friction": "Observed obstacle, not a preference",
      "observable_evidence": "Screenshot/DOM/DTO/event reference",
      "suggested_validation": "A concrete follow-up check"
    }
  ],
  "stop_reason": null
}
```

## Deterministic no-LLM behavior

Deterministic validation runs never perform network or external LLM calls.
When no analyzer is supplied, `triager.mjs` derives the report from recorded
evidence alone — same input, same report, byte for byte:

| run signal | deterministic verdict |
|---|---|
| `hard_stop` verdict or recorded hard stop | `candidate_bug` (high confidence; the safety boundary fired) |
| `fail` with a failed assertion | `candidate_bug` (low confidence; the reviewer decides with the oracle) |
| `fail` without assertion outcomes | `likely_test_issue` (a command errored before any oracle ran) |
| `inconclusive` / unevaluated / missing evidence | `insufficient_evidence` (never invent a root cause) |
| `pass` | `insufficient_evidence`, empty report (nothing to claim) |

An optional caller-supplied `analyze(bundle)` function may implement genuine
LLM triage outside deterministic runs. Its output is forced through the
contract validator; a throwing analyzer or a contract-violating report is
discarded and the deterministic report stands — triage can never crash a run.

## Permission boundary

The triager is read-only: it consumes only the supplied redacted evidence
bundle, cites an evidence id for every claim, offers no more than three
hypotheses, and never proposes code changes, runs commands, accepts replans,
or claims a bug is confirmed. Only a reviewer converts a candidate bug into a
permanent regression scenario.
