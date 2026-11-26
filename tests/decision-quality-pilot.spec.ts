import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { validateDecisionScenario } from '../validation/decision-quality/contract.mjs'

test('试验清单冻结十二个版本化可执行场景', async () => {
  const manifest = JSON.parse(await readFile('validation/decision-quality/pilot-manifest.json', 'utf8'))
  expect(manifest.scenarios).toHaveLength(12)
  for (const entry of manifest.scenarios) {
    const file = path.join('validation/decision-quality', entry)
    const scenario = validateDecisionScenario(JSON.parse(await readFile(file, 'utf8')), file)
    expect(scenario.execution).toBeDefined()
    expect(scenario.decision_points[0].actions).toHaveLength(3)
  }
})
