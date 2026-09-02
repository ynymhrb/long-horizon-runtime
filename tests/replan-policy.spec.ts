import { expect, test } from 'vitest'
import { classifyAutomaticReplan } from '../src/replan-policy.js'
import type { TaskNode } from '../src/domain.js'

function task(id: string, dependsOn: string[] = [], state: TaskNode['state'] = 'PENDING'): TaskNode {
  return { id, objective: id, dependsOn, priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only', validator: 'required', state }
}

test('auto-applies a replacement confined to the failed unfinished downstream region', () => {
  const previous = [task('done', [], 'SUCCEEDED'), task('failed', ['done'], 'FAILED'), task('downstream', ['failed'])]
  const candidate = [task('done', [], 'SUCCEEDED'), { ...task('failed', ['done']), objective: 'retry differently' }, { ...task('downstream', ['failed']), objective: 'review retry' }]
  expect(classifyAutomaticReplan({ previous, candidate, failedTaskId: 'failed', activeArtifacts: [] })).toEqual({ outcome: 'auto_apply', reasons: [] })
})

test('requires confirmation when the candidate changes a succeeded node', () => {
  const previous = [task('done', [], 'SUCCEEDED'), task('failed', ['done'], 'FAILED')]
  const candidate = [{ ...task('done', [], 'SUCCEEDED'), objective: 'changed' }, task('failed', ['done'])]
  expect(classifyAutomaticReplan({ previous, candidate, failedTaskId: 'failed', activeArtifacts: [] })).toMatchObject({ outcome: 'await_confirmation' })
})

test('requires confirmation when the candidate adds unrelated work or external effects', () => {
  const previous = [task('failed', [], 'FAILED')]
  expect(classifyAutomaticReplan({ previous, candidate: [task('failed'), task('unrelated')], failedTaskId: 'failed', activeArtifacts: [] }).outcome).toBe('await_confirmation')
  expect(classifyAutomaticReplan({ previous, candidate: [{ ...task('failed'), sideEffectClass: 'external_effect' }], failedTaskId: 'failed', activeArtifacts: [] }).outcome).toBe('await_confirmation')
})

test('requires confirmation when the affected region owns a validated artifact', () => {
  const previous = [task('failed', [], 'FAILED')]
  expect(classifyAutomaticReplan({ previous, candidate: [task('failed')], failedTaskId: 'failed', activeArtifacts: [{ taskId: 'failed' }] }))
    .toMatchObject({ outcome: 'await_confirmation', reasons: ['candidate affects validated artifact owner failed'] })
})
