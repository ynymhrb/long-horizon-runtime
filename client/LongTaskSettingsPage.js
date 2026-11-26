import React from 'react'
import { remoteValue } from './remote-value.js'

const e = React.createElement
const workerNames = { dsh: 'DSH', 'codex-cli': 'Codex', 'claude-cli': 'Claude Code', 'custom-exec': '自定义' }
const tabs = [['workers', '执行器'], ['limits', '模型与工具'], ['flows', '编排']]
const noSelection = ['', '请选择']

export function registerLongTaskSettings(slots, remote) {
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section', id: 'long-task-settings', order: 31, label: '长任务',
  }, () => e(LongTaskSettingsPage, { remote })))
}

function Field({ label, value, onChange, options, numeric, multiline, min = 1, max = 1000 }) {
  const control = options !== undefined
    ? e('select', { value, onChange: event => onChange(event.target.value) },
      ...options.map(([id, text]) => e('option', { key: id, value: id }, text)))
    : multiline
      ? e('textarea', { value, rows: 2, onChange: event => onChange(event.target.value) })
      : e('input', {
        value, type: numeric ? 'number' : 'text', ...(numeric ? { min, max, step: 1 } : {}),
        onChange: event => onChange(numeric ? Number(event.target.value) : event.target.value),
      })
  return e('label', { className: 'lts-field' }, e('span', null, label), control)
}

function ChoiceList({ label, values, options, onChange }) {
  return e('fieldset', { className: 'lts-choices' },
    e('legend', null, label),
    ...options.map(id => e('label', { key: id },
      e('input', {
        type: 'checkbox', checked: values.includes(id),
        onChange: event => onChange(event.target.checked ? [...values, id] : values.filter(value => value !== id)),
      }), id)))
}

function Button({ label, onClick, disabled }) {
  return e('button', { type: 'button', className: 'lts-button', onClick, disabled }, label)
}

function title(label, action) {
  return e('div', { className: 'lts-line' }, e('h3', null, label), action)
}

function nextId(prefix, ids) {
  let index = 1
  while (ids.includes(prefix + '-' + index)) index++
  return prefix + '-' + index
}

function field(label, value, onChange, options = {}) {
  return e(Field, { label, value, onChange, ...options })
}
function options(ids) { return ids.map(id => [id, id]) }
function changeRow(update, list, index, key, value) {
  update(draft => { draft[list][index][key] = value })
}
function removeRow(update, list, index) { update(draft => { draft[list].splice(index, 1) }) }
function addRow(update, list, item) { update(draft => { draft[list].push(item) }) }
function rowField(d, onUpdate, list, index, key, label, attrs) {
  return field(label, d[list][index][key] ?? '', value => changeRow(onUpdate, list, index, key, value), attrs)
}

function Workers({ view, draft: d, update }) {
  const workerIds = d.workers.map(item => item.id)
  const workspaces = new Map(view.workers.map(item => [item.id, item.cwd]))
  const groupIds = d.executionProfiles.map(item => item.id)
  return e(React.Fragment, null,
    title('执行额度'),
    e('div', { className: 'lts-row' },
      field('同时运行的任务数', d.maxConcurrentTasks, value => update(x => { x.maxConcurrentTasks = value }), { numeric: true }),
      field('默认执行组', d.defaultExecutionProfile, value => update(x => { x.defaultExecutionProfile = value }), { options: options([...new Set([...groupIds, ...workerIds])]) })),
    title('已登记的执行器', e(Button, { label: '添加 DSH 执行器', onClick: () => addRow(update, 'workers', { id: nextId('dsh', workerIds), kind: 'dsh', maxConcurrent: 1 }) })),
    ...d.workers.map((item, index) => e('div', { className: 'lts-card lts-worker', key: index },
      e('div', null, e('strong', null, item.id), e('small', null, workerNames[item.kind]),
        workspaces.get(item.id) ? e('div', { className: 'lts-path', title: workspaces.get(item.id) }, workspaces.get(item.id)) : null),
      rowField(d, update, 'workers', index, 'maxConcurrent', '并发上限', { numeric: true }),
      item.kind === 'dsh' && item.id !== 'dsh' ? e(Button, { label: '移除 ' + item.id, onClick: () => removeRow(update, 'workers', index) }) : null)),
    e('p', { className: 'lts-help' }, 'Codex、Claude Code 和自定义命令从宿主配置登记，登记后可在这里调整并发。'),
    title('执行组', e(Button, { label: '添加执行组', onClick: () => addRow(update, 'executionProfiles', { id: nextId('group', [...groupIds, ...workerIds]), workerIds: [] }) })),
    ...d.executionProfiles.map((item, index) => e('div', { className: 'lts-card', key: index },
      e('div', { className: 'lts-line' }, e('strong', null, item.id), d.executionProfiles.length > 1 ? e(Button, { label: '移除执行组 ' + item.id, onClick: () => removeRow(update, 'executionProfiles', index) }) : null),
      e(ChoiceList, { label: '组内执行器（留空使用 DSH）', values: item.workerIds, options: workerIds, onChange: value => changeRow(update, 'executionProfiles', index, 'workerIds', value) }),
      field('DSH 模型职责', item.modelRole ?? '', value => update(x => {
        if (value === '') delete x.executionProfiles[index].modelRole
        else x.executionProfiles[index].modelRole = value
      }), { options: [['', 'execution（默认）'], ...options([...new Set(d.modelEndpoints.flatMap(route => route.roles))].filter(role => role !== 'execution'))] }))))
}

function Limits({ draft: d, update }) {
  return e(React.Fragment, null,
    title('模型端点', e(Button, { label: '添加模型端点', onClick: () => addRow(update, 'modelEndpoints', {
      id: nextId('model', d.modelEndpoints.map(row => row.id)), provider: '', model: '', roles: ['execution'], maxConcurrent: 1,
    }) })),
    e('p', { className: 'lts-help' }, '填写 DSH「模型」中已登记的提供方和模型 ID。API 密钥在「模型」管理。'),
    ...d.modelEndpoints.map((item, index) => e('div', { className: 'lts-card', key: index },
      e('div', { className: 'lts-line' }, e('strong', null, item.id), e(Button, { label: '移除端点 ' + item.id, onClick: () => removeRow(update, 'modelEndpoints', index) })),
      e('div', { className: 'lts-row' },
        rowField(d, update, 'modelEndpoints', index, 'provider', '提供方 ID'),
        rowField(d, update, 'modelEndpoints', index, 'model', '模型 ID'),
        field('职责（逗号分隔）', item.roles.join(','), value => changeRow(update, 'modelEndpoints', index, 'roles', value.split(','))),
        rowField(d, update, 'modelEndpoints', index, 'maxConcurrent', '模型并发', { numeric: true })))),
    title('工具额度', e(Button, { label: '添加工具额度', onClick: () => addRow(update, 'toolConcurrency', { name: '', maxConcurrent: 1 }) })),
    e('p', { className: 'lts-help' }, '按 DSH 工具的注册名限制并发调用。'),
    ...d.toolConcurrency.map((_item, index) => e('div', { className: 'lts-card lts-row', key: index },
      rowField(d, update, 'toolConcurrency', index, 'name', '工具名'),
      rowField(d, update, 'toolConcurrency', index, 'maxConcurrent', '工具并发', { numeric: true }),
      e(Button, { label: '移除工具额度', onClick: () => removeRow(update, 'toolConcurrency', index) }))))
}

function Workflow({ draft, update }) {
  const [selected, select] = React.useState('')
  const ids = Object.keys(draft.workflowTemplates)
  const id = ids.includes(selected) ? selected : ids[0]
  const spec = id === undefined ? undefined : draft.workflowTemplates[id]
  const profiles = options([...new Set([
    ...draft.executionProfiles.map(item => item.id), ...draft.workers.map(item => item.id),
  ])])
  const addTemplate = mode => {
    const next = nextId(mode === 'workflow' ? 'workflow' : 'discussion', ids)
    const profile = draft.defaultExecutionProfile
    update(x => {
      x.workflowTemplates[next] = mode === 'workflow' ? {
        mode, entry: 'stage-1', stages: [{ id: 'stage-1', objective: '', profile }],
      } : { mode, rounds: 3, participants: [{ id: 'A', profile }, { id: 'B', profile }], moderator: profile }
    })
    select(next)
  }
  const changeSpec = change => update(x => change(x.workflowTemplates[id]))
  const removeTemplate = () => update(x => {
    delete x.workflowTemplates[id]
    if (x.defaultWorkflow === id) x.defaultWorkflow = 'dynamic'
  })
  return e(React.Fragment, null,
    title('默认编排'),
    field('新任务使用', draft.defaultWorkflow, value => update(x => { x.defaultWorkflow = value }), { options: [['dynamic', '动态任务子图'], ...options(ids)] }),
    title('流程模板', e('div', { className: 'lts-actions' },
      e(Button, { label: '添加工作流', onClick: () => addTemplate('workflow') }),
      e(Button, { label: '添加讨论', onClick: () => addTemplate('discussion') }))),
    spec === undefined ? e('p', { className: 'lts-help' }, '添加模板后，可在聊天或 Skill 中按名称使用。')
      : e(React.Fragment, null,
        e('div', { className: 'lts-row' }, field('编辑模板', id, select, { options: options(ids) }),
          e(Button, { label: '移除模板 ' + id, onClick: removeTemplate })),
        spec.mode === 'workflow'
          ? e(Stages, { spec, change: changeSpec, profiles })
          : e(Discussion, { spec, change: changeSpec, profiles })))
}

function Stages({ spec, change, profiles }) {
  const ids = spec.stages.map(stage => stage.id)
  const [active, activate] = React.useState('')
  const selected = ids.includes(active) ? active : spec.entry
  const index = ids.indexOf(selected)
  const stage = spec.stages[index]
  if (stage === undefined) return null
  const set = (key, value) => change(x => {
    if (value === '') delete x.stages[index][key]
    else x.stages[index][key] = value
  })
  const add = () => {
    const id = nextId('stage', ids)
    change(x => {
      const last = x.stages.at(-1)
      if (!last.next) last.next = id
      x.stages.push({ id, objective: '', profile: profiles[0]?.[0] ?? 'default' })
    })
    activate(id)
  }
  const swap = offset => change(x => {
    const target = index + offset
    const ordered = x.stages.map((item, i, array) => i === index ? array[target] : i === target ? array[index] : item)
    const linear = x.stages.every((item, i, array) => item.next === array[i + 1]?.id)
    if (linear) ordered.forEach((item, i) => {
      if (ordered[i + 1]) item.next = ordered[i + 1].id
      else delete item.next
    })
    if (linear) x.entry = ordered[0].id
    x.stages = ordered
  })
  const remove = () => change(x => {
    x.stages.splice(index, 1)
    if (x.entry === selected) x.entry = stage.next ?? x.stages[0].id
    for (const item of x.stages) {
      if (item.next === selected) {
        if (stage.next && stage.next !== item.id) item.next = stage.next
        else delete item.next
      }
      if (item.onChangesRequested === selected) delete item.onChangesRequested
    }
  })
  return e('div', { className: 'lts-workflow' },
    e('div', { className: 'lts-stages' },
      ...spec.stages.map(item => e('button', {
        type: 'button', key: item.id, className: 'lts-stage', 'aria-pressed': item.id === selected, onClick: () => activate(item.id),
      }, e('strong', null, item.objective || item.id), e('small', null, item.profile))),
      e(Button, { label: '添加阶段', onClick: add })),
    e('div', { className: 'lts-card lts-stage-editor' },
      e('div', { className: 'lts-line' }, e('strong', null, selected),
        e('div', { className: 'lts-actions' },
          e(Button, { label: '上移', disabled: index === 0, onClick: () => swap(-1) }),
          e(Button, { label: '下移', disabled: index === ids.length - 1, onClick: () => swap(1) }),
          e(Button, { label: '移除阶段', disabled: ids.length === 1, onClick: remove }))),
      field('阶段说明', stage.objective, value => change(x => { x.stages[index].objective = value }), { multiline: true }),
      field('由谁执行', stage.profile, value => set('profile', value), { options: profiles }),
      e('div', { className: 'lts-row' },
        field('通过后', stage.next ?? '', value => set('next', value), { options: [['', '结束'], ...options(ids)] }),
        field('评审退回到', stage.onChangesRequested ?? '', value => set('onChangesRequested', value), { options: [['', '无评审分支'], ...options(ids)] })),
      e('div', { className: 'lts-row' },
        field('最多执行次数', stage.maxVisits ?? 1, value => set('maxVisits', value), { numeric: true, max: 20 }),
        field('执行权限', stage.sideEffectClass ?? 'read_only', value => set('sideEffectClass', value), {
          options: [['read_only', '只读'], ['idempotent', '可重复写入'], ['external_effect', '外部操作']],
        })),
      field('起始阶段', spec.entry, value => change(x => { x.entry = value }), { options: options(ids) })))
}

function Discussion({ spec, change, profiles }) {
  const moderator = typeof spec.moderator === 'string' ? spec.moderator : spec.moderator.profile
  return e('div', { className: 'lts-card' },
    e('div', { className: 'lts-row' },
      field('讨论轮数', spec.rounds, value => change(x => { x.rounds = value }), { numeric: true, max: 30 }),
      field('主持人执行组', moderator, value => change(x => {
        x.moderator = typeof x.moderator === 'string' ? value : { ...x.moderator, profile: value }
      }), { options: profiles })),
    field('提前收敛条件', spec.convergence ?? '', value => change(x => {
      if (value.trim() === '') delete x.convergence
      else x.convergence = value
    }), { multiline: true }),
    title('发言顺序', e(Button, { label: '添加成员', onClick: () => change(x => {
      const ids = x.participants.map((item, index) => typeof item === 'string' ? 'member-' + (index + 1) : item.id)
      x.participants.push({ id: nextId('member', ids), profile: profiles[0]?.[0] ?? 'default' })
    }) })),
    ...spec.participants.map((item, index) => {
      const participant = typeof item === 'string' ? { id: 'member-' + (index + 1), profile: item } : item
      const set = (key, value) => change(x => {
        const updated = { ...participant, [key]: value }
        if (updated.instruction === '') delete updated.instruction
        x.participants[index] = updated
      })
      return e('div', { className: 'lts-row lts-discussion-row', key: index },
        field('成员', participant.id, value => set('id', value)),
        field('由谁执行', participant.profile, value => set('profile', value), { options: profiles }),
        field('发言要求', participant.instruction ?? '', value => set('instruction', value)),
        e(Button, { label: '上移成员', disabled: index === 0, onClick: () => change(x => {
          [x.participants[index - 1], x.participants[index]] = [x.participants[index], x.participants[index - 1]]
        }) }),
        e(Button, { label: '移除成员', disabled: spec.participants.length <= 2, onClick: () => change(x => { x.participants.splice(index, 1) }) }))
    }))
}

function toDraft(view) {
  const { revision: _revision, editable: _editable, busy: _busy, warning: _warning, workers, ...rest } = view
  return { ...rest, workers: workers.map(({ id, kind, maxConcurrent }) => ({ id, kind, maxConcurrent })) }
}

export function LongTaskSettingsPage({ remote }) {
  const [section, choose] = React.useState('workers')
  const [view, setView] = React.useState(undefined)
  const [draft, setDraft] = React.useState(undefined)
  const [saving, setSaving] = React.useState(false)
  const [message, show] = React.useState(null)
  const [dirty, setDirty] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const current = remoteValue(await remote.getLongTaskSettings())
      setView(current)
      setDraft(current === null ? undefined : toDraft(current))
      setDirty(false)
      show(null)
    } catch (error) { show({ error: true, text: String(error.message ?? error) }) }
  }, [remote])
  React.useEffect(() => { void load() }, [load])

  const update = change => {
    setDraft(current => {
      const editable = structuredClone(current)
      change(editable)
      return editable
    })
    setDirty(true)
    show(null)
  }

  const save = async event => {
    event.preventDefault()
    if (view?.editable !== true || saving) return
    setSaving(true)
    show(null)
    try {
      const result = remoteValue(await remote.saveLongTaskSettings({ expectedRevision: view.revision, draft }))
      setView({ ...view, revision: result.revision })
      setDirty(false)
      show({ error: false, text: '配置已保存。DSH 正在重新加载。' })
    } catch (error) { show({ error: true, text: String(error.message ?? error) }) }
    finally { setSaving(false) }
  }

  const content = draft === undefined ? null
    : section === 'workers' ? e(Workers, { view, draft, update })
      : section === 'limits' ? e(Limits, { draft, update })
        : e(Workflow, { draft, update })

  return e('form', { className: 'lts-root', onSubmit: save },
    e('div', { className: 'lts-heading' },
      e('h2', null, '长任务'),
      view?.busy ? e('span', null, '任务执行中，空闲后可保存') : null),
    view?.warning ? e('p', { role: 'alert', className: 'lts-error' }, view.warning) : null,
    e('nav', { 'aria-label': '长任务设置分类', className: 'lts-nav' },
      ...tabs.map(([id, label]) => e('button', { key: id, type: 'button', 'aria-pressed': id === section, onClick: () => choose(id) }, label))),
    e('fieldset', { className: 'lts-content', disabled: view?.editable !== true || saving },
      content ?? e('p', { className: 'lts-help' }, view === null ? '当前运行时未提供设置。' : '正在读取设置…')),
    e('footer', { className: 'lts-footer' },
      message ? e('span', { role: message.error ? 'alert' : 'status', className: message.error ? 'lts-error' : '' }, message.text)
        : view?.editable === false ? e('span', null, '当前 Web 实例以只读方式展示配置。') : null,
      e(Button, { label: '重新加载', onClick: load, disabled: saving }),
      e('button', { type: 'submit', className: 'lts-button lts-primary', disabled: view?.editable !== true || !dirty || saving || view.busy }, saving ? '正在保存…' : '保存配置')))
}

export const longTaskSettingsCss = `
.lts-root{font:inherit;color:var(--dsw-alias-label-primary);max-width:820px;padding:0 2px;min-width:0}
.lts-heading,.lts-line,.lts-footer{display:flex;justify-content:space-between;align-items:center;gap:12px}
.lts-heading h2{margin:0;font-size:21px;font-weight:650}.lts-heading span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.lts-nav{margin:14px 0 4px;display:flex;gap:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.lts-nav button{border:0;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary);padding:7px 2px 9px;font:inherit;cursor:pointer}
.lts-nav button[aria-pressed=true]{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.lts-content{padding:0;margin:0;border:0;min-width:0}.lts-line h3{font-weight:620;font-size:14px;margin:13px 0 7px}
.lts-card{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:9px 12px;margin:7px 0;min-width:0}
.lts-row,.lts-worker{display:grid;grid-template-columns:repeat(auto-fit,minmax(122px,1fr));align-items:end;gap:8px}
.lts-worker{grid-template-columns:minmax(150px,1fr) minmax(110px,145px) auto;align-items:center}
.lts-worker strong{font-size:13px;margin-right:12px}.lts-worker small,.lts-stage small,.lts-path,.lts-help{font-size:12px;color:var(--dsw-alias-label-secondary)}
.lts-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:310px}.lts-help{margin:7px 0 10px;line-height:1.4}
.lts-field{display:grid;gap:4px;font-size:12px;min-width:0}.lts-field input,.lts-field select,.lts-field textarea{box-sizing:border-box;padding:5px 7px;min-height:29px;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit}.lts-field textarea{resize:vertical}
.lts-choices{margin:7px 0;border:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px}.lts-choices legend{padding:0;margin-bottom:4px}.lts-choices label{display:inline-flex;gap:5px;align-items:center}
.lts-button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);padding:4px 9px;color:inherit;font:inherit;font-size:12px;min-height:28px;cursor:pointer}
.lts-button:disabled{opacity:.46;cursor:default}.lts-actions{display:flex;flex-wrap:wrap;gap:5px}.lts-primary{font-weight:700;border-color:var(--dsw-alias-label-primary)}
.lts-workflow{display:grid;grid-template-columns:minmax(110px,1fr) minmax(230px,2fr);gap:8px;align-items:start}.lts-stages{display:grid;gap:5px;margin-top:7px}.lts-stage{display:grid;gap:3px;align-items:center;text-align:left;min-width:0;padding:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;cursor:pointer}.lts-stage strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lts-stage[aria-pressed=true]{border-color:var(--dsw-alias-label-primary)}
.lts-stage-editor{display:grid;gap:7px}.lts-discussion-row{margin-top:7px}
.lts-footer{justify-content:flex-end;position:sticky;bottom:0;padding:9px 0;margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);z-index:1;font-size:12px}.lts-footer span{margin-right:auto}.lts-error{color:var(--dsw-alias-state-error-primary)}
@media(max-width:540px){.lts-worker,.lts-workflow{grid-template-columns:1fr}.lts-footer{flex-wrap:wrap}.lts-line{flex-wrap:wrap}}
`
