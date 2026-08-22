import React from 'react'
import { taskStripPresentation } from './task-presentation.js'
import { remoteValue } from './remote-value.js'
const e = React.createElement
export function TaskStrip({ sessionId, remote, onOpen }) {
  const [task, setTask] = React.useState(null)
  React.useEffect(() => { if (!sessionId) return; let live = true; const load = () => Promise.resolve(remote.getCurrentTaskForSession({ sessionId })).then(value => { if (live) setTask(remoteValue(value)) }).catch(() => { if (live) setTask(null) }); void load(); const timer = setInterval(load, 3000); return () => { live = false; clearInterval(timer) } }, [sessionId, remote])
  if (!task) return null
  const view = taskStripPresentation(task)
  return e('button', { type: 'button', className: `ltr-strip tone-${view.tone}`, onClick: () => onOpen(task.id), 'data-testid': 'long-task-strip' }, e('span', null, '长任务'), e('strong', null, task.objective), e('span', null, view.progress), e('span', null, view.detail || view.label))
}
