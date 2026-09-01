#!/usr/bin/env node
/**
 * Validation metrics CLI — the handbook's suite-level report entrypoint.
 *
 *   node validation/metrics/cli.mjs <evidence-root>
 *        [--scenario-root <dir>]    join risk/kind/tags from scenario files
 *        [--reviews <file>]         reviewer outcome ledger (JSON)
 *        [--compact]                single-line JSON output
 *
 * Prints the handbook's ten required run metrics and the four release gates
 * with explicit pass/fail verdicts and reasons. Exit codes: 0 all gates
 * pass, 1 at least one gate fails, 2 usage/ledger error.
 *
 * Deterministic and offline by construction: candidate counts come from the
 * deterministic no-LLM triager over the same bundles; nothing here performs
 * network or external LLM calls.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSuiteReport } from './report.mjs'
import { ReviewLedgerError } from './reviews.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

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
  const [evidenceRoot] = positional
  if (evidenceRoot === undefined) {
    process.stderr.write('usage: node validation/metrics/cli.mjs <evidence-root> [--scenario-root <dir>] [--reviews <file>] [--compact]\n')
    process.exitCode = 2
    return
  }

  let report
  try {
    report = await buildSuiteReport(path.resolve(evidenceRoot), {
      scenarioRoot: path.resolve(String(flags['scenario-root'] ?? path.join(REPO_ROOT, 'scenarios'))),
      ...(typeof flags.reviews === 'string' ? { reviewLedgerFile: path.resolve(flags.reviews) } : {}),
    })
  } catch (error) {
    if (error instanceof ReviewLedgerError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
      return
    }
    throw error
  }

  const json = JSON.stringify(report, null, flags.compact === true ? 0 : 2)
  process.stdout.write(`${json}\n`)
  process.exitCode = report.release_gates.verdict === 'pass' ? 0 : 1
}

await main()
