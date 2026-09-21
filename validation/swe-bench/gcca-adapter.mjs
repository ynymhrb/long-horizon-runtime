/** 将公开 SWE-bench 记录收敛成不含答案泄漏的 GCCA 输入。 */
export function publicSweBenchContext(record) {
  if (record === null || typeof record !== 'object') throw new Error('SWE-bench 记录无效')
  const value = record
  for (const field of ['instance_id', 'repo', 'base_commit', 'problem_statement', 'FAIL_TO_PASS', 'PASS_TO_PASS']) {
    if (typeof value[field] !== 'string') throw new Error(`SWE-bench 记录缺少 ${field}`)
  }
  return Object.freeze({ instanceId: value.instance_id, repo: value.repo, baseCommit: value.base_commit, problemStatement: value.problem_statement, failToPass: value.FAIL_TO_PASS, passToPass: value.PASS_TO_PASS })
}

/**
 * 以同一 base commit 的分支执行候选补丁。officialEvaluator 必须运行官方
 * SWE-bench 容器 oracle，不能由模型自报成功。
 */
export async function evaluateSweBenchBranches(input) {
  const context = publicSweBenchContext(input.record)
  if (!Array.isArray(input.actions) || input.actions.length < 2) throw new Error('至少需要两个候选行动')
  if (typeof input.officialEvaluator?.evaluate !== 'function') throw new Error('需要官方 SWE-bench 容器评测器')
  const results = []
  for (const action of input.actions) {
    if (typeof action.id !== 'string' || typeof action.patch !== 'string') throw new Error('候选行动必须包含 id 和 patch')
    const verdict = await input.officialEvaluator.evaluate({ context, action, continuationPolicy: input.continuationPolicy })
    if (typeof verdict?.resolved !== 'boolean') throw new Error('官方评测器必须返回 resolved 布尔值')
    results.push({ actionId: action.id, utility: verdict.resolved ? 1 : 0, evidenceRef: verdict.evidenceRef })
  }
  return { context, results }
}
