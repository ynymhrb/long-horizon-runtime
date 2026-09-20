import { describe, expect, test } from 'vitest'
import { DecisionScenarioError, validateDecisionScenario } from '../validation/decision-quality/contract.mjs'

function scenario(overrides: Record<string, unknown> = {}) {
  return {
    id: 'DQ-DIAGNOSE-001',
    version: 1,
    goal: '修复解析器且保留全部回归测试',
    constraints: ['不得删除既有测试'],
    initial_state: { hash: 'sha256:initial', fixture: 'parser' },
    continuation_policy: { id: 'fixed-test-and-stop', version: 1 },
    oracle: { id: 'hidden-regression', command: ['node', 'oracle.mjs'] },
    decision_points: [{
      id: 'diagnosis-or-edit',
      actions: [
        { id: 'diagnose', kind: 'diagnose', command: ['node', 'inspect.mjs'], cost: 0.1, irreversibility_risk: 0, constraint_risk: 0, potential_outcome: 1 },
        { id: 'patch', kind: 'edit', command: ['node', 'patch.mjs'], cost: 0.2, irreversibility_risk: 0.1, constraint_risk: 0.1, potential_outcome: 0.4 },
        { id: 'rewrite', kind: 'edit', command: ['node', 'rewrite.mjs'], cost: 0.8, irreversibility_risk: 0.8, constraint_risk: 0.7, potential_outcome: 0 },
      ],
    }],
    ...overrides,
  }
}

describe('validateDecisionScenario', () => {
  test('接受含三个候选行动和独立 oracle 的决策场景', () => {
    const parsed = validateDecisionScenario(scenario(), 'fixture')
    expect(parsed.decision_points[0]?.actions).toHaveLength(3)
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  test('一次报告空候选集、重复行动和缺失 oracle', () => {
    const invalid = scenario({
      oracle: undefined,
      decision_points: [
        { id: 'empty', actions: [] },
        { id: 'duplicate', actions: [
          { id: 'same', kind: 'edit', command: ['node'], cost: 1, irreversibility_risk: 0, constraint_risk: 0 },
          { id: 'same', kind: 'edit', command: ['node'], cost: 1, irreversibility_risk: 0, constraint_risk: 0 },
        ] },
      ],
    })
    expect(() => validateDecisionScenario(invalid, 'fixture')).toThrow(DecisionScenarioError)
    expect(() => validateDecisionScenario(invalid, 'fixture')).toThrow(/候选行动.*重复.*oracle/s)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('拒绝非法行动成本 %s', cost => {
    const invalid = scenario({ decision_points: [{ id: 'd', actions: [
      { id: 'a', kind: 'edit', command: ['node'], cost, irreversibility_risk: 0, constraint_risk: 0 },
      { id: 'b', kind: 'edit', command: ['node'], cost: 0, irreversibility_risk: 0, constraint_risk: 0 },
    ] }] })
    expect(() => validateDecisionScenario(invalid)).toThrow(/cost/)
  })
})
