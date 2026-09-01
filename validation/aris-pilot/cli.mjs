#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPilot } from './runner.mjs'

/** @param {readonly string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--config' && flag !== '--evidence-root') throw new TypeError(`unknown argument ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new TypeError(`${flag} requires a value`)
    flags[flag] = value
    index += 1
  }
  if (flags['--config'] === undefined || flags['--evidence-root'] === undefined) throw new TypeError('usage: pnpm aris:pilot -- --config <file> --evidence-root <directory>')
  return { configFile: flags['--config'], evidenceRoot: flags['--evidence-root'] }
}

/** @param {readonly string[]} argv */
export async function main(argv) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    return { code: 2, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    const result = await runPilot({ configFile: path.resolve(flags.configFile), evidenceRoot: path.resolve(flags.evidenceRoot) })
    const summary = {
      pilot_id: result.config.id,
      evidence_dir: result.evidenceDir,
      groups: result.groups.map(group => ({ id: group.id, exit_code: group.exitCode, signal: group.signal, duration_ms: group.durationMs })),
    }
    return { code: result.groups.every(group => group.exitCode === 0 && group.signal === null) ? 0 : 1, summary }
  } catch (error) {
    return { code: 2, error: error instanceof Error ? error.message : String(error) }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcome = await main(process.argv.slice(2))
  if ('summary' in outcome) process.stdout.write(`${JSON.stringify(outcome.summary, null, 2)}\n`)
  else process.stderr.write(`${outcome.error}\n`)
  process.exitCode = outcome.code
}
