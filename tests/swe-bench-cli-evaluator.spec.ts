import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createSweBenchCliEvaluator } from '../validation/swe-bench/official-cli-evaluator.mjs'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

test('以唯一运行标识调用官方模块并从实例报告读取 resolved', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'swe-cli-')); dirs.push(root)
  const calls: Array<{ file: string, args: string[] }> = []
  const evaluator = createSweBenchCliEvaluator({
    python: 'python', datasetName: 'SWE-bench/SWE-bench_Lite', evidenceRoot: root,
    run: async (file, args) => {
      calls.push({ file, args })
      const runId = args[args.indexOf('--run_id') + 1]
      const model = 'gcca-counterfactual'
      const report = path.join(root, 'logs', 'run_evaluation', runId, model, 'repo__x-1', 'report.json')
      await mkdir(path.dirname(report), { recursive: true })
      await writeFile(report, JSON.stringify({ resolved: true }), 'utf8')
      return { status: 0, stdout: 'official output', stderr: '' }
    },
  })

  const result = await evaluator.evaluate({ context: { instanceId: 'repo__x-1' }, action: { id: 'repair', patch: 'diff --git a/a b/a' } })

  expect(result.resolved).toBe(true)
  expect(calls[0]).toMatchObject({ file: 'python' })
  expect(calls[0].args).toContain('--dataset_name')
  expect(calls[0].args).toContain('SWE-bench/SWE-bench_Lite')
  expect(calls[0].args).toContain('--predictions_path')
  expect(calls[0].args).toContain('--run_id')
  const predictionPath = calls[0].args[calls[0].args.indexOf('--predictions_path') + 1]
  expect(JSON.parse(await readFile(predictionPath, 'utf8'))).toMatchObject({ instance_id: 'repo__x-1', model_patch: 'diff --git a/a b/a' })
  expect(result.evidenceRef).toContain('report.json')
})

test('当官方模块没有生成实例报告时拒绝把执行成功当作已解决', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'swe-cli-')); dirs.push(root)
  const evaluator = createSweBenchCliEvaluator({ python: 'python', datasetName: 'SWE-bench/SWE-bench_Verified', evidenceRoot: root, run: async () => ({ status: 0, stdout: '', stderr: '' }) })
  await expect(evaluator.evaluate({ context: { instanceId: 'repo__x-1' }, action: { id: 'repair', patch: 'diff' } })).rejects.toThrow('未生成实例报告')
})

test('不同的行动标识即使清洗后相同也使用不同的官方缓存键', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'swe-cli-')); dirs.push(root)
  const runIds: string[] = []
  const evaluator = createSweBenchCliEvaluator({
    python: 'python', datasetName: 'SWE-bench/SWE-bench_Lite', evidenceRoot: root,
    run: async (_file, args) => {
      const runId = args[args.indexOf('--run_id') + 1]
      runIds.push(runId)
      const report = path.join(root, 'logs', 'run_evaluation', runId, 'gcca-counterfactual', 'repo__x-1', 'report.json')
      await mkdir(path.dirname(report), { recursive: true })
      await writeFile(report, JSON.stringify({ resolved: true }), 'utf8')
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  await evaluator.evaluate({ context: { instanceId: 'repo__x-1' }, action: { id: 'a/b', patch: 'same patch' } })
  await evaluator.evaluate({ context: { instanceId: 'repo__x-1' }, action: { id: 'a?b', patch: 'same patch' } })
  expect(new Set(runIds).size).toBe(2)
})
