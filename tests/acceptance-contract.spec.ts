import { describe, expect, test } from 'vitest'
import { parseAcceptanceChecks, validateTaskAcceptance } from '../src/acceptance-contract.js'

const capabilities = { commandTemplates: new Set(['unit']), fileSchemas: new Set(['report']), httpEndpoints: new Set(['health']), databaseQueries: new Set(['user']), externalReadbacks: new Set(['email']), reviewRubrics: new Set(['quality']) }

describe('验收合同', () => {
  test('拒绝 required 节点缺少确定性验收检查', () => {
    expect(() => validateTaskAcceptance({ acceptancePolicy: 'required', acceptanceChecks: [] }, capabilities)).toThrow('required task must declare a deterministic acceptance check')
  })

  test('仅允许 read_only 节点使用 structural_only', () => {
    expect(() => validateTaskAcceptance({ sideEffectClass: 'external_effect', acceptancePolicy: 'structural_only' }, capabilities)).toThrow('structural_only is only allowed for read_only tasks')
  })

  test('拒绝规划器提供的任意命令字段', () => {
    expect(() => parseAcceptanceChecks([{ id: 'a', kind: 'command', templateId: 'unit', args: [], expectedExitCode: 0, command: 'rm -rf' }])).toThrow('unknown acceptance check field: command')
  })
})
