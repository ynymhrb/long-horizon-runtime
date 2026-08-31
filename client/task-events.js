const labels = {
  GoalCreated: '已创建任务', GoalObjectiveRevised: '已修改原始目标', PlanProposed: '等待确认的重规划', PlanRevisionApplied: '已应用计划修订',
  PlanConfirmed: '已确认计划', PlanRejected: '已拒绝重规划', GoalPaused: '任务已暂停', GoalResumed: '任务已继续', GoalCancelled: '任务已取消',
  GoalArchived: '任务已归档', GoalRestored: '任务已恢复', TaskCompleted: '节点已完成', TaskFailed: '节点失败',
  TaskAttemptFailed: '节点尝试失败', ValidationRecorded: '已完成验证', DecisionRecorded: '已记录决策',
  TaskRetryBudgetExhausted: '重试预算已耗尽', TaskInterrupted: '节点已中断', TaskAttemptSuperseded: '尝试已被新修订取代', TaskReady: '节点已就绪', TaskAttemptStarted: '节点开始执行', TaskRetryScheduled: '已计划重试', TaskAttemptSessionRecorded: '已记录子会话', ArtifactProduced: '已产出产物', EvidenceRecorded: '已记录证据', TaskRecoveryBlocked: '恢复受阻', GoalSucceeded: '任务成功',
}

export function formatTaskEvent(event) {
  const payload = event.payload ?? {}
  const revision = typeof payload.revision === 'number' ? `修订 ${payload.revision}` : ''
  const reason = typeof payload.reason === 'string' ? payload.reason : typeof payload.trigger?.reason === 'string' ? payload.trigger.reason : ''
  return { label: labels[event.type] ?? event.type, detail: [revision, reason].filter(Boolean).join(' · ') || '已记录', tone: event.type.includes('Failed') ? 'error' : event.type.includes('Paused') || event.type.includes('Proposed') ? 'warning' : 'neutral' }
}
