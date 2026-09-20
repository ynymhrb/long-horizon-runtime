import { describe, expect, test } from 'vitest'
import { aggregateDecisionQuality, deriveCausalAdvantages, kendallTauB, scoreDecisionPoint } from '../validation/decision-quality/metrics.mjs'

describe('反事实决策指标', () => {
  test('以最佳替代行动为基线计算 GCCA', () => {
    expect(deriveCausalAdvantages([
      { actionId: 'diagnose', utility: 1 },
      { actionId: 'patch', utility: 0.4 },
      { actionId: 'rewrite', utility: 0 },
    ])).toEqual([
      { actionId: 'diagnose', advantage: 0.6 },
      { actionId: 'patch', advantage: -0.6 },
      { actionId: 'rewrite', advantage: -1 },
    ])
  })

  test('并列最佳行动均视为命中且保留并列标记', () => {
    const score = scoreDecisionPoint([
      { actionId: 'diagnose', estimate: 1 },
      { actionId: 'patch', estimate: 0.5 },
      { actionId: 'rewrite', estimate: 0 },
    ], [
      { actionId: 'diagnose', utility: 1 },
      { actionId: 'patch', utility: 1 },
      { actionId: 'rewrite', utility: 0 },
    ])
    expect(score).toMatchObject({ verdict: 'complete', bestActionHit: true, tieAware: true })
  })

  test('缺少任一候选行动结果时决策点为 inconclusive', () => {
    expect(scoreDecisionPoint([
      { actionId: 'a', estimate: 1 },
      { actionId: 'b', estimate: 0 },
    ], [{ actionId: 'a', utility: 1 }])).toMatchObject({ verdict: 'inconclusive' })
  })

  test('聚合空记录不产生 NaN', () => {
    const result = aggregateDecisionQuality([])
    expect(result.best_action_accuracy).toEqual({ numerator: 0, denominator: 0, rate: 0 })
    expect(result.gcca_mse).toBeNull()
    expect(JSON.stringify(result)).not.toContain('NaN')
  })

  test('Kendall tau-b 对排序一致、相反和并列给出可解释结果', () => {
    expect(kendallTauB([3, 2, 1], [9, 8, 7])).toBe(1)
    expect(kendallTauB([3, 2, 1], [7, 8, 9])).toBe(-1)
    expect(kendallTauB([1, 1, 2], [1, 1, 2])).toBe(1)
  })
})
