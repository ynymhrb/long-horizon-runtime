import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runFixture, runLive, runLiveSuite } from '../validation/decision-quality/cli.mjs'

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
  const branches = JSON.parse(await readFile(path.join(result.evidenceDir, 'branch-outcomes.json'), 'utf8'))
  expect(branches.verdict).toBe('pass')
  expect(branches.branches.map((row: { actionId: string, utility: number }) => [row.actionId, row.utility])).toEqual([['diagnose', 1], ['patch', 0], ['rewrite', 0]])
})

test('runLive 要求显式成本确认并保存脱敏 usage', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'dq-live-'))
  dirs.push(output)
  const scenarioFile = path.resolve('validation/decision-quality/fixtures/diagnose-before-edit.json')
  await expect(runLive({ scenarioFile, method: 'full', evidenceRoot: output, model: fakeModel(), acknowledgedCost: false })).rejects.toThrow(/显式确认/)
  const result = await runLive({ scenarioFile, method: 'full', evidenceRoot: output, model: fakeModel(), acknowledgedCost: true })
  expect(result.usage).toEqual({ totalTokens: 3, usedTokens: 3 })
  const decision = JSON.parse(await readFile(path.join(result.evidenceDir, 'decision.json'), 'utf8'))
  expect(decision.verdict).toBe('complete')
  expect(decision.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: 'diagnose', utility: 1 })]))
  expect(JSON.stringify(decision)).not.toContain('test-secret')
})

test('runLiveSuite 汇总逐场景的完整 verdict 与 token 使用量', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'dq-suite-'))
  dirs.push(output)
  const scenarioFile = path.resolve('validation/decision-quality/fixtures/diagnose-before-edit.json')
  const result = await runLiveSuite({ scenarioFiles: [scenarioFile], methods: ['full', 'causal_advantage'], evidenceRoot: output, model: fakeModel(), acknowledgedCost: true })
  expect(result.records).toHaveLength(2)
  expect(result.totalTokens).toBe(6)
  expect(JSON.parse(await readFile(path.join(result.evidenceDir, 'suite.json'), 'utf8'))).toMatchObject({ complete: true, totalTokens: 6 })
})

function fakeModel() {
  return { async evaluate() {
    return { output: [
      { actionId: 'diagnose', causalAdvantage: 1, informationValue: 0.1, lower: 0.8, upper: 1.1, evidenceRefs: ['live-model'] },
      { actionId: 'patch', causalAdvantage: 0.1, informationValue: 0, lower: 0, upper: 0.2, evidenceRefs: ['live-model'] },
      { actionId: 'rewrite', causalAdvantage: -1, informationValue: 0, lower: -1, upper: -0.5, evidenceRefs: ['live-model'] },
    ], usage: { totalTokens: 3, usedTokens: 3 } }
  } }
}
