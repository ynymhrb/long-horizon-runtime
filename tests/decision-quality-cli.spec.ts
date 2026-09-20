import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runFixture } from '../validation/decision-quality/cli.mjs'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

test('runFixture 生成完整证据和中文报告', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'dq-cli-'))
  dirs.push(output)
  const scenarioFile = path.resolve('validation/decision-quality/fixtures/diagnose-before-edit.json')
  const result = await runFixture({ scenarioFile, method: 'full', evidenceRoot: output })
  expect(result.metrics.best_action_accuracy).toEqual({ numerator: 1, denominator: 1, rate: 1 })
  expect(JSON.parse(await readFile(path.join(result.evidenceDir, 'manifest.json'), 'utf8'))).toMatchObject({ complete: true })
  expect(await readFile(path.join(result.evidenceDir, '报告.md'), 'utf8')).toContain('最佳行动命中率')
})
