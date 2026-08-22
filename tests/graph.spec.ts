import { describe, expect, test } from 'vitest'
import { applyMutation, validatePlan } from '../src/graph.js'
import type { PlanDraft } from '../src/domain.js'

function plan(tasks: PlanDraft['tasks'], revision = 1): PlanDraft {
  return { goalId: 'goal-1', revision, tasks }
}

describe('plan validation', () => {
  test('rejects a cyclic dependency before the plan can run', () => {
    expect(() => validatePlan(plan([
      { id: 'a', objective: 'first', dependsOn: ['b'] },
      { id: 'b', objective: 'second', dependsOn: ['a'] },
    ]))).toThrow(/cycle/i)
  })

  test('invalidates a task and only its reachable descendants in a new revision', () => {
    const current = validatePlan(plan([
      { id: 'a', objective: 'root', dependsOn: [] },
      { id: 'b', objective: 'bad branch', dependsOn: ['a'] },
      { id: 'c', objective: 'dependent', dependsOn: ['b'] },
      { id: 'd', objective: 'independent child', dependsOn: ['a'] },
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
})
