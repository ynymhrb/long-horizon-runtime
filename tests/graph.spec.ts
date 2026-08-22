import { describe, expect, test } from 'vitest'
import { applyMutation, validatePlan } from '../src/graph.js'
import type { PlanDraft } from '../src/domain.js'

function plan(tasks: PlanDraft['tasks'], revision = 1): PlanDraft {
  return { goalId: 'goal-1', revision, tasks }
}
function strictTask(id: string, objective: string, dependsOn: string[] = []) {
  return { id, objective, dependsOn, priority: 0, inputContract: {}, outputContract: {}, completionCriteria: 'done', retryPolicy: { maxAttempts: 1 }, sideEffectClass: 'read_only' as const, validator: 'required' }
}

describe('plan validation', () => {
  test('rejects a cyclic dependency before the plan can run', () => {
    expect(() => validatePlan(plan([
      strictTask('a', 'first', ['b']), strictTask('b', 'second', ['a']),
    ]))).toThrow(/cycle/i)
  })

  test('invalidates a task and only its reachable descendants in a new revision', () => {
    const current = validatePlan(plan([
      strictTask('a', 'root'), strictTask('b', 'bad branch', ['a']), strictTask('c', 'dependent', ['b']), strictTask('d', 'independent child', ['a']),
    ]))

    const next = applyMutation(current, {
      kind: 'invalidateTask', taskId: 'b', reason: 'contradicted evidence', evidenceRefs: [],
    })

    expect(next.revision).toBe(2)
    expect(next.tasks.get('b')?.state).toBe('INVALIDATED')
    expect(next.tasks.get('c')?.state).toBe('INVALIDATED')
    expect(next.tasks.get('d')?.state).toBe('PENDING')
    expect(current.tasks.get('b')?.state).toBe('PENDING')
  })

  test('rejects a planner task missing a required durable execution field', () => {
    expect(() => validatePlan(plan([{ id: 'a', objective: 'first', dependsOn: [] }]))).toThrow(/priority.*required/i)
  })
})
