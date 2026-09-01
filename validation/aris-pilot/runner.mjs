import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from '../runner/evidence.mjs'
import { assertComparable, validatePilotConfig } from './contract.mjs'

/** @param {string} value */
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

/** @param {string} file @param {unknown} value */
async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, 'utf8')
}

/** @param {{ executable: string, args: string[], cwd?: string, env?: Record<string, string> }} command @param {string} baseDirectory */
async function execute(command, baseDirectory) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const cwd = command.cwd === undefined ? baseDirectory : path.resolve(baseDirectory, command.cwd)
  return await new Promise(resolve => {
    const child = spawn(command.executable, command.args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...command.env },
    })
    const stdout = []
    const stderr = []
    /** @type {Error | undefined} */
    let launchError
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', error => { launchError = error })
    child.once('close', (exitCode, signal) => resolve({
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      ...(launchError === undefined ? {} : { launchError: launchError.message }),
    }))
  })
}

/** @param {string} directory */
async function manifest(directory) {
  const files = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.name === 'manifest.json') continue
    const bytes = await readFile(path.join(directory, entry.name))
    files[entry.name] = { bytes: bytes.length, sha256: sha256(bytes) }
  }
  return { version: 1, files }
}

/**
 * Run exactly the two operator-supplied groups in a validated pilot config.
 * This function is intentionally agnostic to DSH: the command vectors make
 * the actual launcher explicit and therefore auditable.
 * @param {{ configFile: string, evidenceRoot: string, runId?: string }} input
 */
export async function runPilot(input) {
  const configFile = path.resolve(input.configFile)
  const config = validatePilotConfig(JSON.parse(await readFile(configFile, 'utf8')))
  assertComparable(config)
  const runId = input.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const evidenceDir = path.resolve(input.evidenceRoot, config.id, runId)
  await mkdir(evidenceDir, { recursive: true })
  const configDirectory = path.dirname(configFile)
  const results = []

  await writeJson(path.join(evidenceDir, 'pilot.json'), { id: config.id, version: config.version, config_sha256: sha256(JSON.stringify(config)) })
  await writeJson(path.join(evidenceDir, 'preflight.json'), { comparable: true, shared: config.shared, groups: config.groups.map(group => ({ id: group.id, longTaskPlugin: group.longTaskPlugin })) })

  for (const group of config.groups) {
    const result = await execute(group.command, configDirectory)
    await writeFile(path.join(evidenceDir, `${group.id}.stdout.txt`), String(redactSecrets(result.stdout)), 'utf8')
    await writeFile(path.join(evidenceDir, `${group.id}.stderr.txt`), String(redactSecrets(result.stderr)), 'utf8')
    const summary = {
      id: group.id,
      longTaskPlugin: group.longTaskPlugin,
      command: { executable: group.command.executable, args: group.command.args, ...(group.command.cwd === undefined ? {} : { cwd: group.command.cwd }), ...(group.command.env === undefined ? {} : { env: group.command.env }) },
      ...result,
      stdout: undefined,
      stderr: undefined,
    }
    results.push(summary)
  }

  await writeFile(path.join(evidenceDir, 'commands.ndjson'), `${results.map(result => JSON.stringify(redactSecrets(result))).join('\n')}\n`, 'utf8')
  await writeJson(path.join(evidenceDir, 'manifest.json'), await manifest(evidenceDir))
  return { evidenceDir, config, groups: results }
}
