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

test('预检允许显式指定未加入 PATH 的 Docker 程序', () => {
  const calls: unknown[][] = []
  const result = checkSweBenchPreflight(((file: string, args: string[]) => {
    calls.push([file, args])
    return { status: 0, stdout: '29.8.0\n' }
  }) as any, { dockerCommand: 'D:\\env\\DockerDesktop\\resources\\bin\\docker.exe' })
  expect(result).toEqual({ ready: true, dockerVersion: '29.8.0' })
  expect(calls).toEqual([['D:\\env\\DockerDesktop\\resources\\bin\\docker.exe', ['version', '--format', '{{.Server.Version}}']]])
})
