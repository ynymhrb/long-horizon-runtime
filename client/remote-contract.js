import { z } from 'zod'

const owner = '@deepseek-ai/dsh-long-task-runtime'
const namespace = 'longTasks'
const result = { mode: 'strict', typeSymbol: 'LongTaskRemoteResult', schema: z.unknown() }

function descriptor(method, schema, name = 'input', acceptsUndefined = false) {
  return {
    id: owner + '#' + namespace + '/' + method,
    service: namespace,
    namespace,
    method,
    invocation: { kind: 'direct' },
    parameters: schema === undefined ? [] : [{
      name, wire: name, source: 'json', ...(acceptsUndefined ? { acceptsUndefined } : {}),
      codec: { mode: 'strict', typeSymbol: method + 'Input', schema },
    }],
    result,
  }
}

const taskId = z.string()
const task = z.object({ taskId })
const sessionId = z.string()
const control = { taskId, expectedRevision: z.number() }
const workspaceScope = z.string().optional()
const link = z.object({ taskId, sessionId, workspaceScope })

export const longTaskRemote = {
  package: owner,
  descriptors: [
    descriptor('getLongTaskSettings'),
    descriptor('saveLongTaskSettings', z.object({ expectedRevision: z.string().length(64), draft: z.unknown() })),
    descriptor('get', taskId, 'taskId'),
    descriptor('list'),
    descriptor('listTasks', z.object({
      cursor: z.number().optional(),
      filter: z.object({ state: z.string().optional(), query: z.string().optional(), archived: z.boolean().optional(), sessionId: sessionId.optional() }).optional(),
    }).optional(), 'input', true),
    descriptor('getTask', task),
    descriptor('getTaskAudit', task),
    descriptor('getTaskGraph', z.object({ taskId, revision: z.number().optional() })),
    descriptor('listTaskEvents', z.object({ taskId, cursor: z.number().optional(), taskNodeId: z.string().optional() })),
    descriptor('getCurrentTaskForSession', z.object({ sessionId })),
    descriptor('updateTask', z.object({
      ...control,
      action: z.enum(['confirm', 'resume', 'pause', 'cancel']),
      sessionId: sessionId.optional(),
      workspaceScope,
      recoveryResolution: z.enum(['retry', 'confirmed_succeeded']).optional(),
    })),
    descriptor('attachCurrentSession', link),
    descriptor('setCurrentSession', link),
    descriptor('clearCurrentSession', z.object({ sessionId })),
    descriptor('rejectReplan', z.object(control)),
    descriptor('editTaskGoal', z.object({ ...control, objective: z.string(), reason: z.string(), sessionId: sessionId.optional() })),
    descriptor('acceptReplan', z.object({ ...control, sessionId: sessionId.optional() })),
    descriptor('archiveTask', z.object(control)),
    descriptor('restoreTask', task),
    descriptor('getTaskNavigation', task),
  ],
}
