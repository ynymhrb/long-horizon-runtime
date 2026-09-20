import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateDecisionScenario } from './contract.mjs'
import { aggregateDecisionQuality, deriveCausalAdvantages, scoreDecisionPoint } from './metrics.mjs'
import { createScorer } from './scorers.mjs'
import { renderChineseReport } from './report.mjs'

/** @param {{ scenarioFile: string, method: 'local_progress' | 'goal_value' | 'causal_advantage' | 'full', evidenceRoot: string }} input */
export async function runFixture(input) {
  const scenario = validateDecisionScenario(JSON.parse(await readFile(input.scenarioFile, 'utf8')), input.scenarioFile)
  const point = scenario.decision_points[0]
  if (point === undefined) throw new Error('场景没有决策点')
  const evidenceIds = ['synthetic-prior']
  const estimates = await createScorer(input.method).score({ actions: point.actions, evidenceIds })
  const outcomes = point.actions.map(action => ({ actionId: action.id, utility: action.potential_outcome ?? 0 }))
  const truth = new Map(deriveCausalAdvantages(outcomes).map(row => [row.actionId, row.advantage]))
  const decision = scoreDecisionPoint(estimates.map(row => ({ actionId: row.actionId, estimate: row.total })), outcomes)
  const enriched = { ...decision, gccaMse: estimates.reduce((sum, row) => sum + (row.causalAdvantage - /** @type {number} */ (truth.get(row.actionId))) ** 2, 0) / estimates.length, taskSuccess: decision.bestActionHit, cost: estimates.find(row => row.actionId === decision.chosen[0])?.total ?? 0 }
  const metrics = aggregateDecisionQuality([enriched])
  const runId = `${scenario.id}-${input.method}`
  const evidenceDir = path.join(input.evidenceRoot, scenario.id, runId)
  await mkdir(evidenceDir, { recursive: true })
  const decisionText = JSON.stringify({ scenario_id: scenario.id, method: input.method, estimates, outcomes, decision: enriched }, null, 2)
  await writeFile(path.join(evidenceDir, 'decision.json'), decisionText, 'utf8')
  await writeFile(path.join(evidenceDir, '报告.md'), renderChineseReport(metrics), 'utf8')
  const files = ['decision.json', '报告.md']
  await writeFile(path.join(evidenceDir, 'manifest.json'), JSON.stringify({ complete: true, files: files.map(name => ({ name, sha256: createHash('sha256').update(name === 'decision.json' ? decisionText : renderChineseReport(metrics)).digest('hex') })) }, null, 2), 'utf8')
  return { evidenceDir, metrics }
}

async function main() {
  const [command, scenarioFile, ...rest] = process.argv.slice(2)
  const options = Object.fromEntries(rest.reduce((pairs, value, index) => index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), rest[index + 1]]] : pairs, []))
  if (command !== 'run-fixture' || scenarioFile === undefined || typeof options.method !== 'string' || typeof options['evidence-root'] !== 'string') throw new Error('用法：run-fixture <场景> --method <方法> --evidence-root <目录>')
  const result = await runFixture({ scenarioFile, method: /** @type {any} */ (options.method), evidenceRoot: options['evidence-root'] })
  process.stdout.write(`${result.evidenceDir}\n`)
}
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
