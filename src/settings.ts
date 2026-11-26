import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { CallRouter } from './call-routing.js'
import { parseWorkflow } from './workflow.js'
import type { Config, WorkerConfig } from './tools.js'
import type { ExecutionProfile } from './execution-profiles.js'

const limit = z.number().int().min(1).max(1000)
const name = z.string().trim().min(1).max(128)
const worker = z.strictObject({ id: name, kind: z.enum(['dsh', 'codex-cli', 'claude-cli', 'custom-exec']), maxConcurrent: limit })
const group = z.strictObject({ id: name, workerIds: z.array(name).max(40), modelRole: name.optional() })
const endpoint = z.strictObject({ id: name, provider: name, model: name, roles: z.array(name).min(1).max(16), maxConcurrent: limit })
const tool = z.strictObject({ name, maxConcurrent: limit })
const draftSchema = z.strictObject({
  maxConcurrentTasks: limit,
  workers: z.array(worker).max(40),
  executionProfiles: z.array(group).min(1).max(40),
  defaultExecutionProfile: name,
  modelEndpoints: z.array(endpoint).max(40),
  toolConcurrency: z.array(tool).max(80),
  workflowTemplates: z.record(name, z.unknown()).refine(value => Object.keys(value).length <= 40, '最多 40 个模板'),
  defaultWorkflow: name,
})

type Draft = z.infer<typeof draftSchema>
export type SettingsOverride = Pick<Config, 'maxConcurrentTasks' | 'workers' | 'executionProfiles' | 'defaultExecutionProfile' | 'modelEndpoints' | 'toolConcurrency' | 'workflowTemplates' | 'defaultWorkflow'>
const settingsKeys = ['maxConcurrentTasks', 'workers', 'executionProfiles', 'defaultExecutionProfile', 'modelEndpoints', 'toolConcurrency', 'workflowTemplates', 'defaultWorkflow'] as const

export function selectSettingsOverlay(config: SettingsOverride): SettingsOverride {
  return Object.fromEntries(settingsKeys.filter(key => config[key] !== undefined).map(key => [key, config[key]])) as SettingsOverride
}

const begin = '# BEGIN long-task-settings'
const end = '# END long-task-settings'

export function settingsRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Own one appended overlay while preserving the bytes and tags of other rows. */
export function renderSettingsPatch(text: string, config: Record<string, unknown>): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => line === begin ? [index] : [])
  const ends = lines.flatMap((line, index) => line === end ? [index] : [])
  if (starts.length !== ends.length || starts.length > 1 || (starts[0] !== undefined && ends[0]! <= starts[0])) {
    throw new Error('配置文件中的长任务托管块不完整')
  }
  const owned = [begin, '- id: long-task-web-preferences', '  config: ' + JSON.stringify({ draft: config }), end]
  if (starts[0] !== undefined) {
    lines.splice(starts[0], ends[0]! - starts[0] + 1, ...owned)
    return lines.join(newline)
  }
  const content = lines.flatMap((line, index) => {
    const trimmed = line.trim()
    return trimmed === '' || trimmed.startsWith('#') || trimmed === '---' ? [] : [{ line: trimmed, index }]
  })
  if (content.length === 1 && content[0]!.line === '[]') {
    lines.splice(content[0]!.index, 1, ...owned)
  } else {
    if (content[0] !== undefined && !/^-(?:\s|$)/.test(content[0].line)) throw new Error('用户配置不是 Cordis patch 列表')
    const documentEnd = lines.findIndex(line => line.trim() === '...')
    if (documentEnd >= 0) lines.splice(documentEnd, 0, ...owned)
    else {
      if (lines.at(-1) === '') lines.pop()
      lines.push(...owned, '')
    }
  }
  return lines.join(newline)
}

type WorkerView = z.infer<typeof worker> & { readonly cwd?: string }
export type SettingsView = Omit<Draft, 'workers'> & {
  readonly workers: readonly WorkerView[]
  readonly revision: string
  readonly editable: boolean
  readonly busy: boolean
  readonly warning?: string
}

export class LongTaskSettings {
  constructor(
    private readonly config: Config,
    private readonly active: () => boolean,
    private readonly hold: () => () => void,
    private readonly validate: (override: SettingsOverride) => void,
    private readonly trustedConfig: Config = config,
    private readonly warning?: string,
  ) {}

  read(): SettingsView {
    const path = this.config.settingsPatchPath
    const content = this.readPatch()
    const workers = this.workers().map(({ id, kind, maxConcurrent, ...rest }) => ({
      id, kind, maxConcurrent, ...('cwd' in rest ? { cwd: rest.cwd } : {}),
    }))
    return {
      maxConcurrentTasks: this.config.maxConcurrentTasks ?? 1,
      workers,
      executionProfiles: this.profiles().map(item => ({
        id: item.id, workerIds: [...(item.workerIds ?? [])], ...(item.modelRole === undefined ? {} : { modelRole: item.modelRole }),
      })),
      defaultExecutionProfile: this.config.defaultExecutionProfile ?? this.profiles()[0]!.id,
      modelEndpoints: (this.config.modelEndpoints ?? []).map(item => ({ ...item, roles: [...item.roles] })),
      toolConcurrency: [...(this.config.toolConcurrency ?? [])],
      workflowTemplates: structuredClone(this.config.workflowTemplates ?? {}),
      defaultWorkflow: this.config.defaultWorkflow ?? 'dynamic',
      revision: settingsRevision(content),
      editable: path !== undefined,
      busy: this.active(),
      ...(this.warning === undefined ? {} : { warning: this.warning }),
    }
  }

  save(expectedRevision: string, requested: unknown): { readonly revision: string } {
    const path = this.config.settingsPatchPath
    if (path === undefined) throw new Error('当前配置未启用 Web 用户层写入')
    const original = this.readPatch()
    if (settingsRevision(original) !== expectedRevision) throw new Error('配置文件已变更，请重新加载设置')
    const draft = draftSchema.parse(requested)
    const override = applySettingsPreferences(this.trustedConfig, draft, true)
    this.validate(override)
    const content = renderSettingsPatch(original, draft)
    if (this.active()) throw new Error('有长任务正在规划或执行，请在任务空闲后保存')
    const release = this.hold()
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: statSync(path).mode & 0o777 })
      if (settingsRevision(this.readPatch()) !== expectedRevision) throw new Error('配置文件已变更，请重新加载设置')
      renameSync(temporary, path)
      return { revision: settingsRevision(content) }
    } catch (error) {
      release()
      throw error
    } finally {
      try { unlinkSync(temporary) } catch { /* rename may already own the contents */ }
    }
  }

  private readPatch(): string {
    const path = this.config.settingsPatchPath
    if (path === undefined) return ''
    if (!isAbsolute(path)) throw new Error('Web 用户配置路径必须是绝对路径')
    return readFileSync(path, 'utf8')
  }

  private workers(): readonly WorkerConfig[] { return registeredWorkers(this.config) }
  private profiles(): readonly ExecutionProfile[] { return registeredProfiles(this.config) }
}

/** Merge preferences against live host registrations. No executable metadata is saved in the user block. */
export function applySettingsPreferences(host: Config, requested: unknown, fromEditor = false): SettingsOverride {
  const draft = draftSchema.parse(requested)
  const current = new Map(registeredWorkers(host).map(item => [item.id, item]))
  const workers: WorkerConfig[] = draft.workers.map(item => {
    const existing = current.get(item.id)
    if (existing === undefined) {
      if (item.kind !== 'dsh') throw new Error('执行器已从宿主配置移除或尚未登记：' + item.id)
      return { ...item, kind: 'dsh' }
    }
    if (existing.kind !== item.kind) throw new Error('执行器与宿主登记的类型不一致：' + item.id)
    return { ...existing, maxConcurrent: item.maxConcurrent }
  })
  const requestedIds = new Set(workers.map(item => item.id))
  for (const item of current.values()) {
    if (item.kind === 'dsh' || requestedIds.has(item.id)) continue
    if (fromEditor) throw new Error('只能在宿主配置中移除外部执行器')
    workers.push(item)
  }

  const currentProfiles = new Map(registeredProfiles(host).map(profile => [profile.id, profile]))
  const executionProfiles: ExecutionProfile[] = draft.executionProfiles.map(({ id, workerIds, modelRole }) => {
    const { workerIds: _oldWorkers, modelRole: _oldRole, ...profile } = currentProfiles.get(id) ?? { id, providerName: host.executionProvider }
    return { ...profile, ...(workerIds.length ? { workerIds } : {}), ...(modelRole === undefined ? {} : { modelRole }) }
  })
  const workflowTemplates = Object.fromEntries(Object.entries(draft.workflowTemplates).map(([id, spec]) => [id, parseWorkflow(spec)]))
  new CallRouter(draft.modelEndpoints, draft.toolConcurrency)
  return { ...draft, workers, executionProfiles, workflowTemplates }
}

function registeredWorkers(config: Config): readonly WorkerConfig[] {
  const workers = config.workers ?? []
  return workers.some(item => item.id === 'dsh') ? workers
    : [{ id: 'dsh', kind: 'dsh', maxConcurrent: config.maxConcurrentTasks ?? 1 }, ...workers]
}

function registeredProfiles(config: Config): readonly ExecutionProfile[] {
  return config.executionProfiles ?? [{
    id: 'default', providerName: config.executionProvider,
    ...(config.defaultAgentProfile === undefined ? {} : { agentOptions: config.defaultAgentProfile }),
  }]
}
