import React from 'react'
import { TaskDag } from './TaskDag.js'
import { canEditOriginalGoal, cockpitDataState, initialSelectedNode, resumeDriverMode, waitingForSessionDriver } from './task-model.js'
import { canDriveSessionDriver, driveBoundSessionOnce, sessionDriverStatus } from './task-driver.js'
import { cockpitLayoutPresentation, formatRuntimeMetrics, goalObjectivePresentation, quotaRecoveryPresentation, taskStatePresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
import { formatTaskEvent } from './task-events.js'
const e = React.createElement

export function TaskCockpit({ task, graph, events, onBack, remote, sessionId, openSession, driveInSession, isCurrent, onTaskChanged, onCurrentChanged }) {
  const [selectedId, setSelectedId] = React.useState(() => initialSelectedNode(graph?.nodes ?? []))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [editing, setEditing] = React.useState(false)
  const [objective, setObjective] = React.useState('')
  const [reason, setReason] = React.useState('')
  // 驱动状态保存在 task-driver 模块里（跨组件共享），这里只用一个计数器在注入
  // 结束后触发重渲染，让按钮可用性与提示立即反映真实的驱动状态。
  const [, setDriverTick] = React.useState(0)
  React.useEffect(() => setSelectedId(previous => (previous !== undefined && graph?.nodes.some(node => node.id === previous)) ? previous : initialSelectedNode(graph?.nodes ?? [])), [task?.id, graph])
  React.useEffect(() => {
    if (!task?.requiresSessionDriver || !sessionId || typeof driveInSession !== 'function') return
    let live = true
    void Promise.resolve(remote.getTaskNavigation({ taskId: task.id })).then(result => {
      const navigation = remoteValue(result)
      if (resumeDriverMode(navigation, sessionId) !== 'inject') return undefined
      return driveBoundSessionOnce({ sessionId, taskId: task.id, controlRevision: task.controlRevision, objective: task.objective, drive: driveInSession })
    }).then(outcome => {
      if (!live || outcome === undefined) return
      setDriverTick(tick => tick + 1)
      if (outcome.outcome === 'failed') setError(`未能向绑定会话发送继续指令：${outcome.status?.reason ?? '未知原因'}；请点击“继续执行会话”重试。`)
    }).catch(() => { if (live) setError('无法读取绑定会话；请点击“继续执行会话”重试。') })
    return () => { live = false }
  }, [task?.id, task?.controlRevision, task?.requiresSessionDriver, task?.objective, sessionId, remote, driveInSession])
  const layout = cockpitLayoutPresentation()
  const dataState = cockpitDataState(task, graph)
  if (dataState === 'loading') return e('p', null, '正在加载任务…')
  if (dataState === 'missing') return e('section', { className: 'ltr-cockpit' }, e('button', { type: 'button', className: 'ltr-btn', onClick: onBack }, '← 全部任务'), e('p', { className: 'ltr-error' }, '任务不存在或已被清理。'))
  if (dataState === 'no-plan') return e('section', { className: 'ltr-cockpit ltr-no-plan' },
    e('header', { className: 'ltr-cockpit-header' }, e('button', { type: 'button', className: 'ltr-btn', onClick: onBack }, '← 全部任务'), e('div', { className: layout.identityClassName }, e('div', { className: 'ltr-cockpit-identity-row' }, e('strong', goalObjectivePresentation(task.objective), task.objective), e('span', { className: `ltr-state tone-${taskStatePresentation(task.state).tone}` }, taskStatePresentation(task.state).label)), e('small', null, `${task.id} · 修订 ${task.revision}`))),
    e('p', { className: 'ltr-warning' }, '此历史任务在生成计划前结束，因此没有可展示的 DAG。'),
    e('h4', null, '近期事件'), e('ol', null, ...events.slice(-8).map((event, index) => e('li', { key: `${event.seq ?? index}-${event.type}` }, event.type)))
  )
  const selected = graph.nodes.find(node => node.id === selectedId)
  const activeAttempt = selected ? task.attempts?.find(attempt => attempt.taskId === selected.id && attempt.state === 'RUNNING') : undefined
  const waitingForDriver = waitingForSessionDriver(task)
  // 驱动状态来自共享模块：注入进行中或刚注入成功时按钮禁用，避免人工连点再产生一条排队消息。
  const driverStatus = sessionId ? sessionDriverStatus(sessionId, task.id, task.controlRevision) : undefined
  const driverAvailable = canDriveSessionDriver(driverStatus)
  const state = waitingForDriver ? { label: '等待会话继续', tone: 'warning' } : taskStatePresentation(task.state)
  const attached = sessionId && task.sessionLinks?.some(link => link.sessionId === sessionId)
  const invoke = (method, input) => {
    setPending(true); setError(null)
    return Promise.resolve(remote[method](input)).then(result => {
      const value = remoteValue(result)
      onTaskChanged(value.kind === 'conflict' ? value.current : value.task)
      // 版本冲突必须显式告知：否则用户会以为暂停/继续已经生效。
      if (value.kind === 'conflict') setError('任务已被其他操作更新，界面已刷新为最新状态；如需继续操作请再点一次。')
      const continuesInSession = method === 'attachCurrentSession' || method === 'setCurrentSession' || method === 'acceptReplan' || (method === 'updateTask' && ['confirm', 'resume'].includes(input?.action))
      if (continuesInSession) onCurrentChanged?.(task.id)
      // After a web resume the goal is durably RUNNING but nothing has been
      // dispatched: hand the task to the bound session's Agent (the live
      // parent). If that session is the current one, inject a driver message
      // so the model starts the round without any extra user input.
      if (method === 'updateTask' && input?.action === 'resume' && value.kind === 'applied') return guideAfterResume(value.task)
      return undefined
    }).catch(reason => setError(String(reason))).finally(() => setPending(false))
  }
  // 显式恢复路径与自动驱动 effect 必须共用同一个去重键，否则同一控制版本会被
  // 注入两次：这里始终用恢复后返回的新 GoalView 计算键。
  const driveSession = nextTask => driveBoundSessionOnce({ sessionId, taskId: nextTask.id, controlRevision: nextTask.controlRevision, objective: nextTask.objective, drive: driveInSession }).then(outcome => {
    setDriverTick(tick => tick + 1)
    if (outcome.outcome === 'injected') setError('已向绑定会话发送继续执行指令。')
    else if (outcome.outcome === 'skipped') setError('继续指令已发送，正在等待绑定会话执行；如需再次发送请稍候再点。')
    else setError(`未能注入继续指令：${outcome.status?.reason ?? '未知原因'}；可再次点击“继续执行会话”重试。`)
    return outcome
  })
  const guideAfterResume = nextTask => {
    const target = nextTask ?? task
    return Promise.resolve(remote.getTaskNavigation({ taskId: target.id })).then(result => {
      const navigation = remoteValue(result)
      const mode = resumeDriverMode(navigation, sessionId)
      if (mode === 'inject') {
        if (typeof driveInSession !== 'function') { setError('任务正在等待绑定会话继续：当前 DSH 槽无法注入驱动消息，请让模型调用 long_task_resume。'); return undefined }
        return driveSession(target)
      }
      if (mode === 'open' && navigation.currentSessionId && typeof openSession === 'function') { openSession(navigation.currentSessionId); setError('已打开绑定会话，请在该会话继续执行。'); return undefined }
      setError('任务正在等待会话继续：先点击“附加到当前会话”绑定本会话，再让模型调用 long_task_resume。')
      return undefined
    }).catch(value => { setError(`无法读取绑定会话：${String(value)}`); return undefined })
  }
  const action = (label, recoveryResolution) => invoke('updateTask', { taskId: task.id, expectedRevision: task.controlRevision, action: label, ...(sessionId ? { sessionId } : {}), ...(recoveryResolution ? { recoveryResolution } : {}) })
  const attach = () => invoke(attached ? 'setCurrentSession' : 'attachCurrentSession', { taskId: task.id, sessionId })
  const edit = () => invoke('editTaskGoal', { taskId: task.id, expectedRevision: task.controlRevision, objective, reason, ...(sessionId ? { sessionId } : {}) })
  const archive = () => { if (window.confirm('删除任务会先取消正在进行的工作，并归档 30 天。是否继续？')) invoke('archiveTask', { taskId: task.id, expectedRevision: task.controlRevision }) }
  const restore = () => { setPending(true); setError(null); Promise.resolve(remote.restoreTask({ taskId: task.id })).then(result => onTaskChanged(remoteValue(result))).catch(value => setError(String(value))).finally(() => setPending(false)) }
  const jump = () => Promise.resolve(remote.getTaskNavigation({ taskId: task.id })).then(result => { const target = remoteValue(result)?.currentSessionId; if (target && target === sessionId) setError('该任务绑定的会话就是当前会话，无需跳转。'); else if (target && typeof openSession === 'function') openSession(target); else setError(target ? '当前 DSH 槽未提供会话跳转能力。' : '此任务尚未关联可跳转的会话：先点击“附加到当前会话”绑定本会话，或从创建它的会话继续运行。') }).catch(value => setError(String(value)))
  const orchestration = task.proposedOrchestration ?? task.orchestration
  const labels = { confirm: '确认执行', pause: '暂停任务', resume: '继续任务', cancel: '取消任务' }
  const externalResolutionRequired = task.state === 'PAUSED' && task.tasks?.some(node => node.state === 'BLOCKED' && node.sideEffectClass === 'external_effect')
  const latestQuotaRecovery = [...(task.recentEvents ?? [])].reverse().find(event => event.type === 'QuotaRecoveryResumed')
  const quotaRecovery = quotaRecoveryPresentation(task.quotaRecovery, new Date(), latestQuotaRecovery)
  const editableOriginalGoal = canEditOriginalGoal(task)
  const runtimeMetrics = formatRuntimeMetrics(task.runtimeMetrics)
  const eventRows = events.filter(event => !event.taskId || event.taskId === selected?.id).slice(-8).map((event, index) => {
    const item = formatTaskEvent(event)
    return e('li', { key: `${event.seq ?? index}-${event.type}`, className: `tone-${item.tone}` }, e('strong', null, item.label), e('small', null, item.detail), event.createdAt ? e('time', null, new Date(event.createdAt).toLocaleString()) : null)
  })
  const actionButtons = (task.availableActions ?? []).filter(name => labels[name]).flatMap(name => name === 'resume' && externalResolutionRequired
    ? [e('button', { key: 'resume-retry', type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => action('resume', 'retry') }, '重试外部操作'), e('button', { key: 'resume-confirmed', type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => action('resume', 'confirmed_succeeded') }, '外部操作已完成')]
    : [e('button', { key: name, type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => action(name) }, labels[name])])
  return e('section', { className: 'ltr-cockpit' },
    e('header', { className: 'ltr-cockpit-header' },
      e('button', { type: 'button', className: 'ltr-btn', onClick: onBack }, '← 全部任务'),
      e('div', { className: layout.identityClassName }, e('div', { className: 'ltr-cockpit-identity-row' }, e('strong', goalObjectivePresentation(task.objective), task.objective), e('span', { className: `ltr-state tone-${state.tone}` }, state.label)), e('small', { title: runtimeMetrics.detail }, `${task.id} · 修订 ${task.revision} · ${runtimeMetrics.summary}`))),
    e('nav', { className: layout.actionsClassName, 'aria-label': '任务操作' },
      sessionId ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending || isCurrent, onClick: attach }, isCurrent ? '当前会话任务' : attached ? '设为当前任务' : '附加到当前会话') : null,
      task.pendingProposal ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => invoke('rejectReplan', { taskId: task.id, expectedRevision: task.controlRevision }) }, '拒绝改计划') : null,
      task.pendingProposal ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => invoke('acceptReplan', { taskId: task.id, expectedRevision: task.controlRevision, ...(sessionId ? { sessionId } : {}) }) }, task.proposedOrchestration ? '确认流程变更' : '接受重规划') : null,
      editableOriginalGoal ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: () => { setEditing(value => !value); setObjective(task.objective); setReason('') } }, '修改原始目标') : null,
      e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: jump }, '当前会话'),
      waitingForDriver ? e('button', { type: 'button', className: 'ltr-btn', disabled: pending || !driverAvailable, title: driverAvailable ? '向绑定会话发送继续执行指令' : '继续指令已发送，正在等待绑定会话执行', onClick: () => { void guideAfterResume(task) } }, driverAvailable ? '继续执行会话' : '驱动已发送，等待执行') : null,
      e('button', { type: 'button', className: 'ltr-btn', disabled: pending, onClick: task.archivedAt ? restore : archive }, task.archivedAt ? '恢复归档任务' : '删除'),
      ...actionButtons,
    ),
    orchestration ? e('details', { className: 'ltr-plan-hint', open: task.state === 'AWAITING_CONFIRMATION' },
      e('summary', null, orchestration.mode === 'discussion' ? '讨论流程' : '工作流定义'),
      orchestration.mode === 'discussion'
        ? e('p', null, orchestration.rounds + ' 轮 · ' + orchestration.participants.map(item => typeof item === 'string' ? item : item.id).join(' → ') + ' · 总结 ' + (typeof orchestration.moderator === 'string' ? orchestration.moderator : orchestration.moderator.id))
        : e('ul', null, ...orchestration.stages.map(stage => e('li', { key: stage.id },
          stage.id + ' · ' + stage.profile + ' · ' + stage.objective
          + (stage.next ? ' · 下一步 ' + stage.next : '')
          + (stage.onChangesRequested ? ' · 退回 ' + stage.onChangesRequested : ''))))) : null,
    error ? e('p', { className: 'ltr-error', role: 'alert' }, error) : null,
    editing && editableOriginalGoal ? e('form', { className: 'ltr-goal-edit', onSubmit: event => { event.preventDefault(); if (objective.trim() && reason.trim()) edit() } }, e('label', null, '新原始目标', e('textarea', { value: objective, onChange: event => setObjective(event.target.value) })), e('label', null, '修改原因', e('input', { value: reason, onChange: event => setReason(event.target.value) })), e('button', { type: 'submit', className: 'ltr-btn', disabled: pending || !objective.trim() || !reason.trim() }, '生成重规划')) : null,
    e('p', { className: 'ltr-plan-hint' }, quotaRecovery ? quotaRecovery.label : waitingForDriver ? '任务已标记为运行，但尚未派发节点：请在绑定的会话中让模型继续执行（long_task_resume），由代理会话驱动调度。' : orchestration ? '流程按已保存定义执行。暂停后可以在会话中提出流程修订。' : '修改原始目标会生成可确认的计划修订；低风险执行失败可自动局部重规划。'),
    e('div', { className: layout.mainClassName },
      e(TaskDag, { nodes: graph.nodes, selectedId, onSelect: setSelectedId }),
      e('details', { className: `${layout.inspectorClassName} ltr-cockpit-inspector-details` }, e('summary', null, '节点详情'), selected ? e(React.Fragment, null,
        e('h3', null, selected.objective), e('p', null, `节点 ${selected.id} · ${taskStatePresentation(selected.state).label}`), e('p', null, selected.completionCriteria ?? '未声明完成条件'),
        activeAttempt ? e('section', { className: 'ltr-attempt-liveness' }, e('h4', null, '执行活动'), e('p', null, `${activeAttempt.latestProgress?.phase ?? '执行中'}：${activeAttempt.latestProgress?.message ?? '等待子会话进度'}`), activeAttempt.lastActivityAt ? e('time', null, `最近活动：${new Date(activeAttempt.lastActivityAt).toLocaleString()}`) : null, activeAttempt.maxWallExpiresAt ? e('time', null, `最长运行至：${new Date(activeAttempt.maxWallExpiresAt).toLocaleString()}`) : null) : null,
        e('h4', null, '近期事件'), e('ol', { className: layout.eventListClassName }, ...eventRows)) : e('p', null, '选择一个节点查看详情'))))
}
