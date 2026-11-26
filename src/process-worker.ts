import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { ExecutionAdapter, ExecutionResult } from './adapters.js'

const text = z.string().max(2_000_000)
const resultSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed']),
  summary: text,
  artifacts: z.array(z.strictObject({ type: z.string(), content: text, mimeType: z.string().optional() })).max(100),
  evidence: z.array(text).max(100),
})
const cliResultSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'summary', 'artifacts', 'evidence'],
  properties: {
    status: { type: 'string', enum: ['succeeded', 'failed'] },
    summary: { type: 'string' },
    artifacts: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['type', 'content'],
        properties: { type: { type: 'string' }, content: { type: 'string' } },
      },
    },
    evidence: { type: 'array', items: { type: 'string' } },
  },
}

export interface ProcessWorkerConfig {
  readonly kind: 'codex-cli' | 'claude-cli' | 'custom-exec'
  readonly executable: string
  readonly args?: readonly string[]
  readonly cliArgs?: readonly string[]
  readonly cwd: string
  readonly scratchDirectory?: string
  readonly environmentKeys?: readonly string[]
}

type Input = Parameters<ExecutionAdapter['execute']>[0]

export interface ProcessWorkerRequest {
  readonly protocolVersion: 1
  readonly taskId: string
  readonly attemptId: string
  readonly revision?: number
  readonly workspace: string
  readonly idempotencyKey?: string
  readonly sideEffectClass?: Input['sideEffectClass']
  readonly timeoutMs?: number
  readonly context: Input['context']
}

export function createProcessWorker(config: ProcessWorkerConfig): ExecutionAdapter {
  if (!isAbsolute(config.executable) || !isAbsolute(config.cwd)) throw new Error('Worker 的 executable 和 cwd 必须使用绝对路径')
  for (const args of [config.args, config.cliArgs]) if (!Array.isArray(args ?? []) || args?.some(arg => typeof arg !== 'string')) throw new Error('Worker 参数必须是字符串数组')
  if (config.environmentKeys?.some(key => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))) throw new Error('无效的 Worker 环境变量名')
  if (config.kind === 'codex-cli' && (config.scratchDirectory === undefined || !isAbsolute(config.scratchDirectory))) throw new Error('Codex Worker 需要绝对路径 scratchDirectory')
  const active = new Set<string>()
  return {
    async execute(input) {
      const timeout = input.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.timeoutMs)
      const signal = timeout === undefined ? input.signal : AbortSignal.any([input.signal, timeout])
      let directory: string | undefined
      try {
        signal.throwIfAborted()
        if (config.kind === 'codex-cli') {
          await mkdir(config.scratchDirectory!, { recursive: true })
          directory = await mkdtemp(join(config.scratchDirectory!, 'codex-worker-'))
          await writeFile(join(directory, 'result-schema.json'), JSON.stringify(cliResultSchema))
        }
        const args = [...(config.args ?? []), ...argumentsFor(config, input, directory)]
        active.add(input.attemptId)
        const result = await runProcess(config, args, input, signal)
        const parsed = resultSchema.parse(result)
        return {
          ...parsed,
          artifacts: parsed.artifacts.map(({ mimeType, ...artifact }) => ({ ...artifact, ...(mimeType === undefined ? {} : { mimeType }) })),
        }
      } catch {
        const interrupted = input.signal.aborted
        return {
          status: 'failed',
          failureKind: interrupted ? 'interrupted' : 'infrastructure',
          summary: interrupted ? 'Worker 已取消' : timeout?.aborted ? 'Worker 执行超时' : 'Worker 启动失败、异常退出或返回了无效的进程协议结果',
          artifacts: [], evidence: [],
        } satisfies ExecutionResult
      } finally {
        active.delete(input.attemptId)
        if (directory !== undefined) {
          await unlink(join(directory, 'result-schema.json')).catch(() => undefined)
          await rmdir(directory).catch(() => undefined)
        }
      }
    },
    isAttemptAlive(attemptId) { return active.has(attemptId) },
  }
}

function workerEnvironment(extra: readonly string[]): NodeJS.ProcessEnv {
  const defaults = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PATHEXT', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LANG']
  const allowed = new Set([...defaults, ...extra].map(key => process.platform === 'win32' ? key.toUpperCase() : key))
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(process.platform === 'win32' ? key.toUpperCase() : key)))
}

function argumentsFor(config: ProcessWorkerConfig, input: Input, directory?: string): string[] {
  const kind = config.kind
  const cliArgs = config.cliArgs ?? []
  const readOnly = input.sideEffectClass === undefined || input.sideEffectClass === 'read_only'
  if (kind === 'codex-cli') return ['exec', ...cliArgs, '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '--output-schema', join(directory!, 'result-schema.json'), '-']
  const claudeTools = readOnly ? 'Read,Grep,Glob' : 'Read,Grep,Glob,Edit,Write'
  if (kind === 'claude-cli') return [
    '-p', ...cliArgs, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(cliResultSchema),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', claudeTools, '--allowedTools', claudeTools,
    '--permission-mode', readOnly ? 'default' : 'acceptEdits',
  ]
  return []
}

function runProcess(config: ProcessWorkerConfig, args: readonly string[], input: Input, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, args, {
      cwd: config.cwd, env: workerEnvironment(config.environmentKeys ?? []),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32',
    })
    let chunks = ''
    let total = 0
    let result: unknown
    let invalid = false
    let terminal = false
    let stopping = false
    const stop = (): void => {
      if (stopping || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      stopping = true
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', () => { child.kill() })
        killer.once('close', code => { if (code !== 0) child.kill() })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch { child.kill('SIGKILL') }
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    child.stderr.resume()
    child.stdin.on('error', () => undefined)
    child.stdout.setEncoding('utf8')
    const consume = (line: string): void => {
      if (invalid || line.trim() === '') return
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        if (config.kind === 'custom-exec') {
          if (event.type === 'started' && typeof event.sessionId === 'string') input.onExternalSessionId?.(event.sessionId)
          if (event.type === 'progress' && typeof event.message === 'string') input.onProgress?.(event.message)
          if (event.type === 'result') {
            if (terminal) throw new Error('重复结果')
            result = event.result
            terminal = true
          }
        } else if (config.kind === 'codex-cli') {
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') input.onExternalSessionId?.(event.thread_id)
          const item = event.item as Record<string, unknown> | undefined
          if (event.type === 'item.completed' && item?.type === 'agent_message') result = item.text
          if (event.type === 'turn.completed') terminal = true
          if (event.type === 'turn.failed') throw new Error('Codex 执行失败')
        } else if (event.type === 'result') {
          if (event.is_error === true) throw new Error('Claude 执行失败')
          result = event.structured_output
          terminal = true
        } else if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
          input.onExternalSessionId?.(event.session_id)
        }
      } catch {
        invalid = true
        stop()
      }
    }
    child.stdout.on('data', (chunk: string) => {
      total += Buffer.byteLength(chunk)
      if (total > 8 * 1024 * 1024) { invalid = true; stop(); return }
      const lines = (chunks + chunk).split('\n')
      chunks = lines.pop()!
      for (const line of lines) consume(line)
    })
    child.once('error', error => { signal.removeEventListener('abort', stop); reject(error) })
    child.once('close', code => {
      signal.removeEventListener('abort', stop)
      consume(chunks)
      if (code !== 0 || signal.aborted || invalid || !terminal) { reject(new Error('Worker 进程未提交有效结果')); return }
      try {
        resolve(config.kind === 'codex-cli' && typeof result === 'string' ? JSON.parse(result) : result)
      } catch (error) { reject(error) }
    })
    const request = JSON.stringify({
      protocolVersion: 1, taskId: input.taskId, attemptId: input.attemptId, workspace: config.cwd,
      ...(input.context.revision === undefined ? {} : { revision: input.context.revision }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.sideEffectClass === undefined ? {} : { sideEffectClass: input.sideEffectClass }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      context: input.context,
    } satisfies ProcessWorkerRequest)
    const prompt = '执行下列任务 JSON 表示的当前节点，遵守约束与输出契约。返回结构化结果。可用 artifact 类型为 plan、analysis、code_patch、command_result、test_report、review、note。\n'
    child.stdin.end(config.kind === 'custom-exec' ? request + '\n' : prompt + request + '\n')
  })
}
