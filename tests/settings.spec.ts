import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { LongTaskRuntime } from '../src/runtime.js'
import { applySettingsPreferences, LongTaskSettings, renderSettingsPatch, settingsRevision } from '../src/settings.js'

test('在既有用户 YAML 末尾管理自身配置，并保留其他插件与 !!js 表达式', () => {
  const original = '# 用户配置\r\n- id: other\r\n  config:\r\n    path: !!js dshHomePath("other")\r\n'
  const first = renderSettingsPatch(original, { maxConcurrentTasks: 3 })
  expect(first.startsWith(original)).toBe(true)
  expect(first).toContain('"maxConcurrentTasks":3')
  const next = renderSettingsPatch(first, { maxConcurrentTasks: 5 })
  expect(next.startsWith(original)).toBe(true)
  expect(next.match(/# BEGIN long-task-settings/g)).toHaveLength(1)
  expect(next).not.toContain('"maxConcurrentTasks":3')
  expect(settingsRevision(next)).not.toBe(settingsRevision(first))
})

test('空 patch 文档保留注释并替换空序列，损坏的托管块被拒绝', () => {
  expect(renderSettingsPatch('# 用户配置\n[]\n', { maxConcurrentTasks: 2 })).toMatch(/^# 用户配置\n# BEGIN/)
  expect(() => renderSettingsPatch('- id: test\n# BEGIN long-task-settings\n', {})).toThrow(/托管块/)
})

test('设置页贡献到独立设置导航，兼容未装设置壳的客户端', async () => {
  const { registerLongTaskSettings } = await import('../client/LongTaskSettingsPage.js')
  const registered: Array<{ name: string; id: string; label: string }> = []
  const slots = {
    spec: () => ({ kind: 'list', scope: 'root' }),
    inject: (_name: string, run: () => void) => run(),
    register: (item: typeof registered[number]) => registered.push(item),
  }
  registerLongTaskSettings(slots, {})
  expect(registered).toEqual([expect.objectContaining({ name: 'settings.section', id: 'long-task-settings', label: '长任务' })])
})

test('仅在空闲时持久化设置，保留宿主执行器命令并拒绝过期写入', () => {
  const home = mkdtempSync(join(process.env.LONG_TASK_TEST_TMP ?? tmpdir(), 'ltr-settings-'))
  const path = join(home, 'cordis.patch.yml')
  const original = '# 用户层\n[]\n'
  writeFileSync(path, original, 'utf8')
  let busy = true
  let holds = 0
  const settings = new LongTaskSettings({
    databasePath: ':memory:', artifactDirectory: home, settingsPatchPath: path,
    plannerProvider: 'spawn', executionProvider: 'spawn',
    workers: [{ id: 'local', kind: 'custom-exec', executable: process.execPath, args: ['private-argument'], cwd: home, maxConcurrent: 1 }],
  }, () => busy, () => { holds++; return () => { holds-- } }, () => undefined)
  try {
    const { revision, editable, busy: _busy, workers, ...config } = settings.read()
    const draft = { ...config, workers: workers.map(({ id, kind, maxConcurrent }) => ({ id, kind, maxConcurrent })), maxConcurrentTasks: 4 }
    expect(editable).toBe(true)
    expect(JSON.stringify(workers)).not.toContain('private-argument')
    expect(() => settings.save(revision, draft)).toThrow(/空闲/)
    expect(readFileSync(path, 'utf8')).toBe(original)
    busy = false
    expect(() => settings.save(revision, { ...draft, workers: [{ id: 'unknown', kind: 'custom-exec', maxConcurrent: 1 }] })).toThrow(/宿主配置/)
    const saved = settings.save(revision, draft)
    expect(saved.revision).not.toBe(revision)
    expect(readFileSync(path, 'utf8')).not.toContain('private-argument')
    expect(() => settings.save(revision, draft)).toThrow(/已变更/)
    expect(holds).toBe(1)
  } finally {
    unlinkSync(path)
    rmdirSync(home)
  }
})

test('托管补丁只指向设置覆盖，不替换运行时的宿主配置', () => {
  const result = renderSettingsPatch('[]\n', { maxConcurrentTasks: 6 })
  expect(result).toContain('- id: long-task-web-preferences')
  expect(result).not.toContain('- id: long-task-runtime')
})

test('运行时合并设置时使用当前登记的命令和权限，而非设置文件快照', () => {
  const host = { databasePath: ':memory:', artifactDirectory: 'artifacts', plannerProvider: 'spawn', executionProvider: 'spawn',
    workers: [{ id: 'custom', kind: 'custom-exec' as const, executable: process.execPath, args: ['current'], cwd: process.cwd(), maxConcurrent: 1 }] }
  const draft = { maxConcurrentTasks: 4, workers: [{ id: 'custom', kind: 'custom-exec', maxConcurrent: 2 }], executionProfiles: [{ id: 'default', workerIds: [] }], defaultExecutionProfile: 'default', defaultWorkflow: 'dynamic', modelEndpoints: [], toolConcurrency: [], workflowTemplates: {} }
  expect(applySettingsPreferences(host, draft).workers?.find(item => item.id === 'custom')).toMatchObject({ args: ['current'], maxConcurrent: 2 })
  expect(() => applySettingsPreferences({ ...host, workers: [] }, draft)).toThrow(/宿主配置/)
})

test('待确认任务的阶段绑定会参与设置校验，取消后释放引用', async () => {
  const runtime = new LongTaskRuntime({ plan: vi.fn() }, { execute: vi.fn() })
  try {
    const task = await runtime.createGoal({ objective: '测试', planningMode: 'require_confirmation', orchestration: {
      mode: 'workflow', entry: 'one', stages: [
        { id: 'one', profile: 'design', objective: '设计', next: 'two' },
        { id: 'two', profile: 'coding', objective: '开发' },
      ],
    } })
    expect(runtime.settingsReferencedProfiles()).toEqual(['design', 'coding'])
    runtime.cancelGoal(task.id)
    expect(runtime.settingsReferencedProfiles()).toEqual([])
  } finally { runtime.close() }
})
