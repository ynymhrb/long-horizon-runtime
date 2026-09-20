import { describe, expect, test } from 'vitest'
import { chooseConservatively, createScorer, publicDecisionView } from '../validation/decision-quality/scorers.mjs'

const actions = [
  { id: 'diagnose', kind: 'diagnose', cost: 0.1, irreversibility_risk: 0, constraint_risk: 0, potential_outcome: 1 },
  { id: 'patch', kind: 'edit', cost: 0.1, irreversibility_risk: 0.7, constraint_risk: 0.1, potential_outcome: 1 },
]

describe('决策评分器', () => {
  test('公开输入不会泄漏隐藏潜在结果', () => {
    expect(JSON.stringify(publicDecisionView({ actions }))).not.toContain('potential_outcome')
  })

  test('完整方法在置信区间重叠时选择可逆诊断行动', async () => {
    const scorer = createScorer('full', { model: async () => ([
      { actionId: 'diagnose', causalAdvantage: 1, informationValue: 0, lower: 0.4, upper: 1.2, evidenceRefs: ['event-1'] },
      { actionId: 'patch', causalAdvantage: 1, informationValue: 0, lower: 0.4, upper: 1.2, evidenceRefs: ['event-1'] },
    ]) })
    const estimates = await scorer.score({ actions, evidenceIds: ['event-1'] })
    expect(chooseConservatively(estimates, { negativeAction: 'replan' })).toMatchObject({ actionId: 'diagnose' })
  })

  test('拒绝缺少证据引用的评分输出', async () => {
    const scorer = createScorer('full', { model: async () => ([
      { actionId: 'diagnose', causalAdvantage: 1, informationValue: 0, lower: 0, upper: 1, evidenceRefs: [] },
      { actionId: 'patch', causalAdvantage: 0, informationValue: 0, lower: 0, upper: 0, evidenceRefs: [] },
    ]) })
    await expect(scorer.score({ actions, evidenceIds: ['event-1'] })).rejects.toThrow(/评分输出/)
  })
})
