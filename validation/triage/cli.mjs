#!/usr/bin/env node
/**
 * Incident triage CLI.
 *
 *   node validation/triage/cli.mjs <evidence-dir>
 *   node validation/triage/cli.mjs --prompt runner|triager
 *
 * With an evidence directory, prints the deterministic no-LLM triage report
 * (exactly the handbook's JSON contract). With --prompt, prints the verbatim
 * handbook prompt text.
 *
 * This entrypoint is deterministic and offline by construction: it never
 * performs network or external LLM calls. Exit codes: 0 success,
 * 2 usage/bundle error.
 */

import { loadEvidenceBundle } from './bundle.mjs'
import { RUNNER_PROMPT, TRIAGER_PROMPT } from './prompts.mjs'
import { triageBundle } from './triager.mjs'

async function main() {
  const [target, flag] = process.argv.slice(2)
  if (target === '--prompt') {
    if (flag === 'runner') {
      process.stdout.write(`${RUNNER_PROMPT}\n`)
      return
    }
    if (flag === 'triager') {
      process.stdout.write(`${TRIAGER_PROMPT}\n`)
      return
    }
    process.stderr.write('usage: node validation/triage/cli.mjs --prompt runner|triager\n')
    process.exitCode = 2
    return
  }
  if (target === undefined || target.startsWith('--')) {
    process.stderr.write('usage: node validation/triage/cli.mjs <evidence-dir> | --prompt runner|triager\n')
    process.exitCode = 2
    return
  }
  try {
    const report = await triageBundle(target)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`triage failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

await main()
