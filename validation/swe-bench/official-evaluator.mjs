import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * 使用调用方提供的官方 harness 命令评测一个候选补丁。命令必须读取 input
 * JSON 并写出 output JSON；此模块不拼接 shell 字符串。
 */
export function createOfficialSweBenchEvaluator(options) {
  if (!Array.isArray(options.command) || options.command.length === 0 || options.command.some(part => typeof part !== 'string' || part === '')) throw new Error('官方 harness 命令无效')
  return { async evaluate(input) {
    await mkdir(options.evidenceRoot, { recursive: true })
    const id = safeName(`${input.context.instanceId}-${input.action.id}`)
    const inputFile = path.join(options.evidenceRoot, `${id}.input.json`)
    const outputFile = path.join(options.evidenceRoot, `${id}.output.json`)
    await writeFile(inputFile, JSON.stringify(input), 'utf8')
    const [file, ...args] = options.command
    const status = await run(file, [...args, inputFile, outputFile], options.cwd)
    if (status !== 0) throw new Error(`官方 SWE-bench harness 退出码：${status}`)
    const output = JSON.parse(await readFile(outputFile, 'utf8'))
    if (typeof output.resolved !== 'boolean') throw new Error('官方 harness 输出缺少 resolved')
    return { resolved: output.resolved, evidenceRef: outputFile }
  } }
}

function run(file, args, cwd) { return new Promise((resolve, reject) => { const child = spawn(file, args, { cwd, shell: false, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) }) }
function safeName(value) { return value.replace(/[^A-Za-z0-9_.-]/g, '_') }
