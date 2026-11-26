import { spawnSync } from 'node:child_process'

/** 在发起任何模型成本前验证官方容器 oracle 的最小前提。 */
export function checkSweBenchPreflight(run = spawnSync, options = {}) {
  const dockerCommand = options.dockerCommand ?? 'docker'
  const result = run(dockerCommand, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    return { ready: false, reason: '未检测到可用 Docker；不能执行 SWE-bench 官方容器化 oracle' }
  }
  return { ready: true, dockerVersion: result.stdout.trim() }
}
