import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createOfficialSweBenchEvaluator } from '../validation/swe-bench/official-evaluator.mjs'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
test('评测器通过文件契约调用官方 harness 而不把补丁放入命令行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'swe-eval-')); dirs.push(root)
  const harness = path.join(root, 'harness.mjs')
  await writeFile(harness, "import { readFile, writeFile } from 'node:fs/promises'; const input=JSON.parse(await readFile(process.argv[2])); await writeFile(process.argv[3], JSON.stringify({resolved:input.action.patch==='ok'}))", 'utf8')
  const evaluator = createOfficialSweBenchEvaluator({ command: ['node', harness], evidenceRoot: root })
  const verdict = await evaluator.evaluate({ context: { instanceId: 'x' }, action: { id: 'a', patch: 'ok' } })
  expect(verdict.resolved).toBe(true)
  expect(await readFile(path.join(root, 'x-a.input.json'), 'utf8')).toContain('ok')
})
