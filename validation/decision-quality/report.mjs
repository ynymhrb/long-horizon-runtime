/** @param {Record<string, unknown>} metrics */
export function renderChineseReport(metrics) {
  const accuracy = /** @type {{ numerator: number, denominator: number, rate: number }} */ (metrics.best_action_accuracy)
  return `# 目标条件因果优势评测报告\n\n- 完整决策点：${/** @type {{ complete: number }} */ (metrics.decision_points).complete}\n- 最佳行动命中率：${accuracy.numerator}/${accuracy.denominator}（${accuracy.rate.toFixed(3)}）\n- GCCA 均方误差：${metrics.gcca_mse ?? '无完整数据'}\n`
}
