import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateDecisionScenario } from './contract.mjs'
import { aggregateDecisionQuality, deriveCausalAdvantages, scoreDecisionPoint } from './metrics.mjs'
import { createScorer } from './scorers.mjs'
import { renderChineseReport } from './report.mjs'
import { runCounterfactualBranches } from './branch-runner.mjs'

/** @param {{ scenarioFile: string, method: 'local_progress' | 'goal_value' | 'causal_advantage' | 'full', evidenceRoot: string }} input */
export async function runFixture(input) {
  const scenario = validateDecisionScenario(JSON.parse(await readFile(input.scenarioFile, 'utf8')), input.scenarioFile)
  const point = scenario.decision_points[0]
  if (point === undefined) throw new Error('场景没有决策点')
  const evidenceIds = ['synthetic-prior']
  const estimates = await createScorer(input.method).score({ actions: point.actions, evidenceIds })
  const runId = `${scenario.id}-${input.method}`
  const evidenceDir = path.join(input.evidenceRoot, scenario.id, runId)
  const executable = scenario.execution
  const branchResult = executable === undefined ? undefined : await runCounterfactualBranches({
    initialSnapshot: path.resolve(path.dirname(input.scenarioFile), executable.snapshot_dir),
    workspaceRoot: path.join(evidenceDir, 'branches'), evidenceRoot: evidenceDir,
    actions: point.actions, continuationCommand: executable.continuation_command, oracleCommand: scenario.oracle.command,
  })
  if (branchResult?.verdict === 'hard_stop') throw new Error('反事实分支检测到初始快照污染，已硬停止')
  const outcomes = branchResult === undefined ? point.actions.map(action => ({ actionId: action.id, utility: action.potential_outcome ?? 0 })) : branchResult.branches.map(row => ({ actionId: row.actionId, utility: row.utility }))
  const truth = new Map(deriveCausalAdvantages(outcomes).map(row => [row.actionId, row.advantage]))
  const decision = scoreDecisionPoint(estimates.map(row => ({ actionId: row.actionId, estimate: row.total })), outcomes)
  const enriched = { ...decision, gccaMse: estimates.reduce((sum, row) => sum + (row.causalAdvantage - /** @type {number} */ (truth.get(row.actionId))) ** 2, 0) / estimates.length, taskSuccess: decision.bestActionHit, cost: estimates.find(row => row.actionId === decision.chosen[0])?.total ?? 0 }
  const metrics = aggregateDecisionQuality([enriched])
  await mkdir(evidenceDir, { recursive: true })
  const decisionText = JSON.stringify({ scenario_id: scenario.id, method: input.method, estimates, outcomes, decision: enriched }, null, 2)
  await writeFile(path.join(evidenceDir, 'decision.json'), decisionText, 'utf8')
  await writeFile(path.join(evidenceDir, '报告.md'), renderChineseReport(metrics), 'utf8')
  const files = ['decision.json', '报告.md', ...(branchResult === undefined ? [] : ['branch-outcomes.json'])]
  await writeFile(path.join(evidenceDir, 'manifest.json'), JSON.stringify({ complete: true, files: await Promise.all(files.map(async name => ({ name, sha256: createHash('sha256').update(await readFile(path.join(evidenceDir, name))).digest('hex') }))) }, null, 2), 'utf8')
  return { evidenceDir, metrics }
}

/**
 * 运行一次真实模型“评分”调用。它只验证模型在公开决策 DTO 上生成可审计
 * 评分；并不执行候选代码行动，因而不会生成真实干预因果结论。
 * @param {{ scenarioFile: string, method: 'local_progress' | 'goal_value' | 'causal_advantage' | 'full', evidenceRoot: string, model: { evaluate(input: object): Promise<{ output: unknown, usage: { totalTokens: number, usedTokens: number } }> }, acknowledgedCost: boolean }} input
 */
export async function runLive(input) {
  if (input.acknowledgedCost !== true) throw new Error('真实模型运行需要显式确认成本')
  const scenario = validateDecisionScenario(JSON.parse(await readFile(input.scenarioFile, 'utf8')), input.scenarioFile)
  const point = scenario.decision_points[0]
  if (point === undefined) throw new Error('场景没有决策点')
  const settled = await input.model.evaluate({ goal: scenario.goal, constraints: scenario.constraints, actions: point.actions })
  const output = Array.isArray(settled.output) ? settled.output : /** @type {any} */ (settled.output)?.scores
  const estimates = await createScorer(input.method, { model: async () => output }).score({ goal: scenario.goal, constraints: scenario.constraints, actions: point.actions, evidenceIds: ['live-model'] })
  const runId = `${scenario.id}-${input.method}-live`
  const evidenceDir = path.join(input.evidenceRoot, scenario.id, runId)
  await mkdir(evidenceDir, { recursive: true })
  const decisionText = JSON.stringify({ scenario_id: scenario.id, method: input.method, estimates, usage: settled.usage, verdict: 'inconclusive', note: '仅模型评分；未执行行动分支或独立 oracle' }, null, 2)
  await writeFile(path.join(evidenceDir, 'decision.json'), decisionText, 'utf8')
  await writeFile(path.join(evidenceDir, 'usage.json'), JSON.stringify(settled.usage, null, 2), 'utf8')
  await writeFile(path.join(evidenceDir, 'verdict.json'), JSON.stringify({ verdict: 'inconclusive', reason: 'live scoring does not execute counterfactual branches' }, null, 2), 'utf8')
  return { evidenceDir, usage: settled.usage }
}

async function main() {
  const [command, scenarioFile, ...rest] = process.argv.slice(2)
  const options = Object.fromEntries(rest.reduce((pairs, value, index) => index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), rest[index + 1]]] : pairs, []))
  if (scenarioFile === undefined || typeof options.method !== 'string' || typeof options['evidence-root'] !== 'string') throw new Error('用法：run-fixture <场景> --method <方法> --evidence-root <目录>')
  const result = command === 'run-fixture'
    ? await runFixture({ scenarioFile, method: /** @type {any} */ (options.method), evidenceRoot: options['evidence-root'] })
    : await liveCli(command, scenarioFile, options)
  process.stdout.write(`${result.evidenceDir}\n`)
}

/** @param {string | undefined} command @param {string} scenarioFile @param {Record<string, string | undefined>} options */
async function liveCli(command, scenarioFile, options) {
  if (command !== 'run-live' || options['i-understand-live-cost'] !== 'true') throw new Error('真实运行用法：run-live <场景> --method <方法> --evidence-root <目录> --model <模型> --token-budget <整数> --i-understand-live-cost true')
  const { createDeepSeekDecisionModel } = await import('./live-model.mjs')
  const tokenBudget = Number(options['token-budget'])
  const apiKey = process.env.DEEPSEEK_API_KEY
  const model = createDeepSeekDecisionModel({ apiKey: apiKey ?? '', model: options.model ?? 'deepseek-chat', tokenBudget, timeoutMs: 180_000 })
  return runLive({ scenarioFile, method: /** @type {any} */ (options.method), evidenceRoot: /** @type {string} */ (options['evidence-root']), model, acknowledgedCost: true })
}
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
