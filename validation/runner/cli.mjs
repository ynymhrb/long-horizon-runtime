#!/usr/bin/env node
/**
 * Scenario runner CLI — the documented entrypoint.
 *
 * Execute exactly one named scenario in a supplied disposable workspace:
 *
 *   node validation/runner/cli.mjs run <scenario-id-or-file>
 *        [--scenario-root <dir>]     default: <repo>/scenarios
 *        [--workspace <dir>]         default: a unique mkdtemp workspace
 *        [--evidence-root <dir>]     default: <repo>/validation/evidence
 *        [--keep-workspace]          keep the disposable workspace after the run
 *
 * Exit codes: 0 pass, 1 fail, 2 usage/contract rejection, 3 inconclusive,
 *             4 hard_stop (external effect detected).
 *
 * The command prints the verdict and the immutable evidence directory as JSON.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findScenarioFile, ScenarioContractError } from './contract.mjs'
import { runScenario } from './runner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const EXIT_BY_VERDICT = { pass: 0, fail: 1, inconclusive: 3, hard_stop: 4 }

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i += 1
      }
    } else positional.push(arg)
  }
  return { flags, positional }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const [verb, target] = positional
  if (verb !== 'run' || target === undefined) {
    process.stderr.write('usage: node validation/runner/cli.mjs run <scenario-id-or-file> [--scenario-root <dir>] [--workspace <dir>] [--evidence-root <dir>] [--keep-workspace]\n')
    process.exitCode = 2
    return
  }

  const scenarioRoot = path.resolve(String(flags['scenario-root'] ?? path.join(REPO_ROOT, 'scenarios')))
  let scenarioFile
  try {
    scenarioFile = target.includes(path.sep) || /\.(ya?ml|json)$/i.test(target)
      ? path.resolve(target)
      : await findScenarioFile(scenarioRoot, target)
  } catch (error) {
    if (error instanceof ScenarioContractError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
      return
    }
    throw error
  }

  let result
  try {
    result = await runScenario({
      scenarioFile,
      repoRoot: REPO_ROOT,
      ...(typeof flags.workspace === 'string' ? { workspace: path.resolve(flags.workspace) } : {}),
      ...(typeof flags['evidence-root'] === 'string' ? { evidenceRoot: path.resolve(flags['evidence-root']) } : {}),
      keepWorkspace: flags['keep-workspace'] === true,
      commandVersions: { node: process.version },
    })
  } catch (error) {
    if (error instanceof ScenarioContractError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
      return
    }
    throw error
  }

  process.stdout.write(`${JSON.stringify({
    scenario_id: result.scenarioId,
    run_id: result.runId,
    verdict: result.verdict,
    evidence_dir: result.evidenceDir,
    missing_evidence: result.missingEvidence,
    hard_stops: result.hardStops,
    errors: result.errors,
    assertions: result.assertions.map(outcome => ({ id: outcome.id, status: outcome.status, oracle: outcome.oracle, detail: outcome.detail })),
  }, null, 2)}\n`)
  process.exitCode = EXIT_BY_VERDICT[result.verdict]
}

await main()
