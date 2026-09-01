import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { assertComparable, validatePilotConfig } from '../validation/aris-pilot/contract.mjs'
import { runPilot } from '../validation/aris-pilot/runner.mjs'
import { main } from '../validation/aris-pilot/cli.mjs'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function validConfig() {
  return {
    version: 1,
    id: 'ARIS-PILOT-001',
    shared: {
      dshVersion: '0.1.0-rc.7', arisCommit: 'd08400b4', arisSkillCount: 187,
      model: 'test-model', modelParameters: { temperature: 0 }, promptSha256: 'a'.repeat(64),
      initialInputSha256: 'b'.repeat(64), toolsSha256: 'c'.repeat(64), mcpSha256: 'd'.repeat(64),
      networkCondition: 'offline fixture', computeEnvironment: 'local', tokenBudget: 10_000,
      wallTimeBudgetMs: 60_000, seed: 1,
    },
    groups: [
      { id: 'aris_only', longTaskPlugin: { enabled: false }, command: { executable: process.execPath, args: ['--version'] } },
      { id: 'aris_plus_long_task', longTaskPlugin: { enabled: true }, command: { executable: process.execPath, args: ['--version'] } },
    ],
  }
}

describe('ARIS pilot contract', () => {
  test('accepts one comparable ARIS-only and ARIS-plus-plugin pair', () => {
    const config = validatePilotConfig(validConfig())
    expect(() => assertComparable(config)).not.toThrow()
  })

  test('rejects a changed shared model parameter before commands can start', () => {
    const config = validConfig() as ReturnType<typeof validConfig> & { groups: Array<Record<string, unknown>> }
    config.groups[1]!.modelParameters = { temperature: 1 }
    expect(() => validatePilotConfig(config)).toThrow(/only longTaskPlugin.enabled|unknown/i)
  })

  test('requires the expected opposite plugin flags', () => {
    const config = validConfig()
    config.groups[1]!.longTaskPlugin.enabled = false
    expect(() => validatePilotConfig(config)).toThrow(/enabled/i)
  })

  test('runs each group once and writes redacted hash-addressed evidence', async () => {
    const root = await temporaryDirectory('aris-pilot-')
    const config = validConfig()
    config.groups[0]!.command.args = ['-e', "console.log('baseline sk-abcdefghijklmnopqrstuvwxyz')"]
    config.groups[1]!.command.args = ['-e', "console.error('experiment complete')"]
    const configFile = path.join(root, 'pilot.json')
    await writeFile(configFile, JSON.stringify(config), 'utf8')

    const result = await runPilot({ configFile, evidenceRoot: path.join(root, 'evidence') })

    expect(result.groups).toEqual([
      expect.objectContaining({ id: 'aris_only', exitCode: 0 }),
      expect.objectContaining({ id: 'aris_plus_long_task', exitCode: 0 }),
    ])
    expect(await readFile(path.join(result.evidenceDir, 'aris_only.stdout.txt'), 'utf8')).toContain('<redacted>')
    const manifest = JSON.parse(await readFile(path.join(result.evidenceDir, 'manifest.json'), 'utf8'))
    expect(manifest.files['aris_only.stdout.txt'].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.files['commands.ndjson']).toBeDefined()
  })

  test('CLI requires explicit config and evidence root', async () => {
    expect(await main([])).toMatchObject({ code: 2, error: expect.stringMatching(/--config.*--evidence-root/i) })
  })

  test('CLI returns a successful summary for a complete two-group fixture', async () => {
    const root = await temporaryDirectory('aris-pilot-cli-')
    const configFile = path.join(root, 'pilot.json')
    await writeFile(configFile, JSON.stringify(validConfig()), 'utf8')

    const outcome = await main(['--config', configFile, '--evidence-root', path.join(root, 'evidence')])

    expect(outcome.code).toBe(0)
    if (!('summary' in outcome)) throw new Error(outcome.error)
    expect(outcome.summary).toMatchObject({ groups: [{ id: 'aris_only', exit_code: 0 }, { id: 'aris_plus_long_task', exit_code: 0 }] })
  })
})
