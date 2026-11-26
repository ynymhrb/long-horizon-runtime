import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'
import { LongTaskRuntime } from '../src/runtime.js'
import { WorkerPool } from '../src/worker-pool.js'
import { createProcessWorker } from '../src/process-worker.js'

test('池跨任务共享名额，并在兼容后端之间选择空闲执行器', async () => {
  const execute = async () => ({ status: 'succeeded' as const, summary: 'no_artifact', artifacts: [], evidence: [] })
  const pool = new WorkerPool(2, [
    { id: 'a', maxConcurrent: 1, adapter: { execute } },
    { id: 'b', maxConcurrent: 1, adapter: { execute } },
  ])
  const signal = new AbortController().signal
  const a = await pool.admit(['a', 'b'], signal)
  const b = await pool.admit(['a', 'b'], signal)
  expect([a.workerId, b.workerId]).toEqual(['a', 'b'])
  const controller = new AbortController()
  const waiting = pool.admit(['b'], controller.signal)
  controller.abort(new Error('已取消'))
  await expect(waiting).rejects.toThrow('已取消')
  a.release()
  b.release()
  const next = await pool.admit(['b'], signal)
  expect(next.workerId).toBe('b')
  next.release()
})

test('自定义子进程接收任务 JSON，输出会话和经过校验的结果', async () => {
  const code = "let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{const x=JSON.parse(input);if(x.protocolVersion!==1 || x.attemptId!=='a' || x.context.revision!==3) process.exit(4); console.log(JSON.stringify({type:'started',sessionId:'custom-42'}));console.log(JSON.stringify({type:'result',result:{status:'succeeded',summary:'no_artifact',artifacts:[],evidence:[]}}))})"
  const adapter = createProcessWorker({ kind: 'custom-exec', executable: process.execPath, args: ['-e', code], cwd: process.cwd() })
  const sessions: string[] = []
  const result = await adapter.execute({
    attemptId: 'a', taskId: 't', signal: new AbortController().signal,
    context: { revision: 3, objective: '目标', task: { id: 't', objective: '验证' }, artifacts: [] },
    onExternalSessionId: id => sessions.push(id),
  })
  expect(result.status).toBe('succeeded')
  expect(sessions).toEqual(['custom-42'])
})

test('等待共享 Worker 名额时暂停，不会创建执行尝试', async () => {
  const calls: string[] = []
  const adapter = { async execute(input: { taskId: string }) {
    calls.push(input.taskId)
    return { status: 'succeeded' as const, summary: '完成', evidence: [], artifacts: [{ type: 'note', content: '完成' }] }
  } }
  const pool = new WorkerPool(1, [{ id: 'dsh', maxConcurrent: 1, adapter }])
  const lease = await pool.admit(['dsh'], new AbortController().signal)
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, adapter, { workerPool: pool })
  const task = await runtime.createGoal({ objective: '任务', planningMode: 'require_confirmation', orchestration: {
    mode: 'workflow', entry: 'first', stages: [{ id: 'first', objective: '分析', profile: 'default' }],
  } })
  try {
    const run = runtime.confirmGoal(task.id, {})
    expect(runtime.getStatus(task.id)?.attempts).toHaveLength(0)
    runtime.pauseGoal(task.id, 'operator')
    await run
    lease.release()
    expect(calls).toEqual([])
    expect(runtime.getStatus(task.id)?.attempts).toHaveLength(0)
    await runtime.resumeGoal(task.id, {}, undefined, undefined, 'operator')
    expect(calls).toEqual(['wf-first-1'])
    expect(runtime.getStatus(task.id)?.state).toBe('SUCCEEDED')
  } finally { lease.release(); runtime.close() }
})

test('暂停期间到达的异步验证结果无法提交产物', async () => {
  const entered = Promise.withResolvers<void>()
  const validation = Promise.withResolvers<{ ok: boolean }>()
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, {
    async execute() { return { status: 'succeeded', summary: '完成', artifacts: [{ type: 'note', content: '未提交' }], evidence: [] } },
  }, { validator: async () => { entered.resolve(); return validation.promise } })
  try {
    const goal = await runtime.createGoal({ objective: '目标', orchestration: { mode: 'workflow', entry: 'a', stages: [
      { id: 'a', objective: '外部操作', profile: 'default', sideEffectClass: 'external_effect' },
    ] } })
    const run = runtime.runUntilIdle(goal.id, {})
    await entered.promise
    runtime.pauseGoal(goal.id, 'operator')
    validation.resolve({ ok: true })
    await run
    const status = runtime.getStatus(goal.id)
    expect(status?.state).toBe('PAUSED')
    expect(status?.tasks[0]?.state).toBe('BLOCKED')
    expect(status?.artifacts).toEqual([])
    await expect(runtime.resumeGoal(goal.id, undefined, undefined, undefined, 'operator')).rejects.toThrow('explicit recovery resolution')
  } finally { runtime.close() }
})

test('同一工作区的写入不与其他 Worker 读取并发', async () => {
  const execute = vi.fn()
  const pool = new WorkerPool(2, [
    { id: 'a', maxConcurrent: 1, adapter: { execute }, workspaceKey: 'repo' },
    { id: 'b', maxConcurrent: 1, adapter: { execute }, workspaceKey: 'repo' },
  ])
  const signal = new AbortController().signal
  const first = await pool.admit(['a'], signal, 'idempotent')
  let secondReady = false
  const second = pool.admit(['b'], signal, 'read_only').then(lease => { secondReady = true; return lease })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(secondReady).toBe(false)
  first.release()
  const next = await second
  expect(next.workerId).toBe('b')
  next.release()
})

test.each([
  { kind: 'codex-cli' as const, events: [
    { type: 'thread.started', thread_id: 'codex-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"status":"succeeded","summary":"no_artifact","artifacts":[],"evidence":[]}' } },
    { type: 'turn.completed' },
  ] },
  { kind: 'claude-cli' as const, events: [
    { type: 'system', subtype: 'init', session_id: 'claude-1' },
    { type: 'result', is_error: false, structured_output: { status: 'succeeded', summary: 'no_artifact', artifacts: [], evidence: [] } },
  ] },
])('$kind 将进程事件转换为 Worker 结果', async ({ kind, events }) => {
  const code = 'process.stdin.resume(); process.stdin.on("end",()=>{for(const event of ' + JSON.stringify(events) + ') console.log(JSON.stringify(event))})'
  const adapter = createProcessWorker({
    kind, executable: process.execPath, args: ['-e', code, '--'], cwd: process.cwd(), scratchDirectory: process.env.LONG_TASK_TEST_TMP ?? tmpdir(),
  })
  const session = vi.fn()
  const result = await adapter.execute({
    attemptId: 'a', taskId: 't', signal: new AbortController().signal, timeoutMs: 3000,
    context: { revision: 1, objective: '目标', task: { id: 't', objective: '节点' }, artifacts: [] },
    onExternalSessionId: session,
  })
  expect(result.status).toBe('succeeded')
  expect(session).toHaveBeenCalledWith(kind.replace('-cli', '-1'))
})
