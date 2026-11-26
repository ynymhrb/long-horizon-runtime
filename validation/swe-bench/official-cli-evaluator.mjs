import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const MODEL_NAME = 'gcca-counterfactual'

/**
 * 直接调用官方 SWE-bench 评测模块。每个候选补丁都有独立的 run_id，避免
 * 官方 harness 按 run_id 与 instance_id 缓存时混淆不同反事实分支。
 */
export function createSweBenchCliEvaluator(options) {
  if (typeof options?.python !== 'string' || options.python === '') throw new Error('需要 Python 解释器路径')
  if (typeof options.datasetName !== 'string' || options.datasetName === '') throw new Error('需要 SWE-bench 数据集名称')
  if (typeof options.evidenceRoot !== 'string' || options.evidenceRoot === '') throw new Error('需要证据目录')
  if (options.maxWorkers !== undefined && (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1)) throw new Error('maxWorkers 必须为正整数')
  const run = options.run ?? runProcess
  const maxWorkers = options.maxWorkers ?? 1
  return { async evaluate(input) {
    const instanceId = requiredString(input?.context?.instanceId, '实例 ID')
    const actionId = requiredString(input?.action?.id, '行动 ID')
    const patch = requiredString(input?.action?.patch, '候选补丁')
    const patchHash = createHash('sha256').update(patch).digest('hex').slice(0, 12)
    const actionHash = createHash('sha256').update(actionId).digest('hex').slice(0, 12)
    const runId = `gcca-${safeName(instanceId)}-${safeName(actionId)}-${actionHash}-${patchHash}`
    const evidenceDir = path.join(options.evidenceRoot, safeName(instanceId), `${safeName(actionId)}-${actionHash}-${patchHash}`)
    await mkdir(evidenceDir, { recursive: true })
    const predictionPath = path.join(evidenceDir, 'prediction.jsonl')
    await writeFile(predictionPath, `${JSON.stringify({ instance_id: instanceId, model_name_or_path: MODEL_NAME, model_patch: patch })}\n`, 'utf8')
    const args = ['-m', 'swebench.harness.run_evaluation', '--dataset_name', options.datasetName, '--predictions_path', predictionPath, '--max_workers', String(maxWorkers), '--run_id', runId, '--instance_ids', instanceId]
    const command = { file: options.python, args, cwd: options.evidenceRoot, runId, datasetName: options.datasetName, instanceId, actionId, patchSha256: createHash('sha256').update(patch).digest('hex') }
    await writeFile(path.join(evidenceDir, 'command.json'), JSON.stringify(command, null, 2), 'utf8')
    const executed = await run(options.python, args, { cwd: options.evidenceRoot, env: options.env })
    await writeFile(path.join(evidenceDir, 'harness-output.json'), JSON.stringify(executed, null, 2), 'utf8')
    if (executed.status !== 0) throw new Error(`官方 SWE-bench harness 退出码：${executed.status}`)
    const reportPath = path.join(options.evidenceRoot, 'logs', 'run_evaluation', runId, MODEL_NAME, instanceId, 'report.json')
    let report
    try { report = JSON.parse(await readFile(reportPath, 'utf8')) } catch { throw new Error(`官方 SWE-bench 未生成实例报告：${reportPath}`) }
    const resolved = report?.resolved ?? report?.[instanceId]?.resolved
    if (typeof resolved !== 'boolean') throw new Error(`官方 SWE-bench 实例报告不含 resolved：${reportPath}`)
    await writeFile(path.join(evidenceDir, 'report-ref.json'), JSON.stringify({ reportPath, resolved }, null, 2), 'utf8')
    return { resolved, evidenceRef: reportPath }
  } }
}

function requiredString(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  return value
}

function safeName(value) { return value.replace(/[^A-Za-z0-9_.-]/g, '_') }

function runProcess(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env === undefined ? process.env : { ...process.env, ...options.env }, shell: false, windowsHide: true })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ status: code ?? 1, stdout, stderr }))
  })
}
