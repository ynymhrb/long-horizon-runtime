import React from 'react'

/**
 * Browser half of the out-of-tree task UI.  The DSH client loader discovers
 * this module from package.json; it only occupies additive slots and never
 * modifies the harness shell. Host applications may provide `longTaskUi`
 * (list/open/current) as a bridge service.
 */
export const inject = ['slots']

const e = React.createElement
const bridge = ctx => ctx.longTaskUi

function TaskAreaButton({ open }) {
  return e('button', { type: 'button', onClick: open, className: 'dsh-long-task-area-button' }, '任务区')
}

function TaskOverlay({ close, ui }) {
  const items = ui?.list?.() ?? []
  return e('section', { className: 'dsh-long-task-overlay', role: 'dialog', 'aria-label': '任务区' },
    e('header', null, e('strong', null, '任务区'), e('button', { type: 'button', onClick: close }, '关闭')),
    e('p', { className: 'dsh-long-task-caption' }, '跨会话任务 · 输入 lt_ 任务 ID 可继续'),
    e('ol', null, ...items.map(item => e('li', { key: item.id }, e('button', { type: 'button', onClick: () => ui?.open?.(item.id) }, `${item.id} · ${item.objective} · ${item.state}`))))
  )
}

function CurrentTaskStrip({ ui }) {
  const task = ui?.current?.()
  if (task == null) return null
  return e('button', { type: 'button', className: 'dsh-long-task-strip', onClick: () => ui.open?.(task.id) }, `当前任务 ${task.id} · ${task.objective} · ${task.state}`)
}

export function apply(ctx) {
  let open = false
  const renderOverlay = () => open ? e(TaskOverlay, { ui: bridge(ctx), close: () => { open = false; ctx.slots.refresh?.('shell.overlay') } }) : null
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'long-task-area', order: 90 }, () => e(TaskAreaButton, { open: () => { open = true; ctx.slots.refresh?.('shell.overlay') } })))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'long-task-current', order: 20 }, () => e(CurrentTaskStrip, { ui: bridge(ctx) })))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'long-task-overlay', order: 90 }, renderOverlay))
}
