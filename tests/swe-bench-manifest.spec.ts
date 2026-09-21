import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { checkSweBenchPreflight } from '../validation/swe-bench/preflight.mjs'

test('SWE-bench 清单固定 10 个开发实例和 30 个 golden 实例且无重复', async () => {
  const manifest = JSON.parse(await readFile('validation/swe-bench/manifest.json', 'utf8'))
  expect(manifest.development.instances).toHaveLength(10)
  expect(manifest.golden.instances).toHaveLength(30)
  expect(new Set([...manifest.development.instances, ...manifest.golden.instances]).size).toBe(40)
  expect(manifest.selection.algorithm).toContain('sha256')
})

test('Docker 缺失时明确阻止 SWE-bench 真实执行', () => {
  expect(checkSweBenchPreflight(() => ({ status: 1, stdout: '' }))).toMatchObject({ ready: false, reason: expect.stringMatching(/Docker/) })
})
