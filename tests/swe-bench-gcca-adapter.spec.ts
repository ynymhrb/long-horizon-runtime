import { expect, test } from 'vitest'
import { evaluateSweBenchBranches, publicSweBenchContext } from '../validation/swe-bench/gcca-adapter.mjs'

const record = { instance_id: 'repo__x-1', repo: 'repo/x', base_commit: 'abc', problem_statement: '修复问题', FAIL_TO_PASS: 'test_a', PASS_TO_PASS: 'test_b', patch: 'secret', test_patch: 'also-secret' }

test('公开 GCCA 上下文不泄漏 gold patch 或测试补丁', () => {
  const context = publicSweBenchContext(record)
  expect(JSON.stringify(context)).not.toContain('secret')
  expect(context).toMatchObject({ instanceId: 'repo__x-1', baseCommit: 'abc' })
})

test('分支真值只能来自官方评测器', async () => {
  const result = await evaluateSweBenchBranches({ record, actions: [{ id: 'a', patch: 'x' }, { id: 'b', patch: 'y' }], continuationPolicy: { id: 'fixed' }, officialEvaluator: { async evaluate({ action }: { action: { id: string } }) { return { resolved: action.id === 'a', evidenceRef: 'docker-log' } } })
  expect(result.results.map(row => row.utility)).toEqual([1, 0])
})
