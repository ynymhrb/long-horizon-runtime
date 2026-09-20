import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * 在单独目录中执行候选行动，并在每次执行后确认只读初始快照没有改变。
 * @param {{ initialSnapshot: string, workspaceRoot: string, evidenceRoot: string, actions: { id: string }[], executor: { execute(input: { branch: string, action: { id: string } }): Promise<{ utility: number }> } }} input
 */
export async function runCounterfactualBranches(input) {
  const before = await directoryHash(input.initialSnapshot)
  await mkdir(input.workspaceRoot, { recursive: true })
  await mkdir(input.evidenceRoot, { recursive: true })
  const branches = []
  const contamination = []
  for (const action of input.actions) {
    const branch = path.join(input.workspaceRoot, `branch-${safeName(action.id)}`)
    await cp(input.initialSnapshot, branch, { recursive: true, force: false, errorOnExist: true })
    let outcome
    try {
      outcome = input.executor === undefined
        ? await executeCommands(branch, action, input.continuationCommand, input.oracleCommand)
        : await input.executor.execute({ branch, action })
    } catch (error) { outcome = { utility: 0, error: error instanceof Error ? error.message : String(error) } }
    const after = await directoryHash(input.initialSnapshot)
    if (after !== before) contamination.push('initial_snapshot_modified')
    branches.push({ actionId: action.id, branch, initialStateHash: before, utility: outcome.utility, ...(outcome.error === undefined ? {} : { error: outcome.error }) })
    if (contamination.length > 0) break
  }
  const verdict = contamination.length === 0 ? 'pass' : 'hard_stop'
  const result = { verdict, branches, contamination: [...new Set(contamination)] }
  await writeEvidence(input.evidenceRoot, result)
  return result
}

/** @param {string} cwd @param {{ command?: string[] }} action @param {string[] | undefined} continuationCommand @param {string[] | undefined} oracleCommand */
async function executeCommands(cwd, action, continuationCommand, oracleCommand) {
  if (!Array.isArray(action.command) || action.command.length === 0) throw new Error('命令分支需要非空 action.command')
  if (!await runCommand(action.command, cwd)) return { utility: 0, error: 'action command failed' }
  if (continuationCommand !== undefined && !await runCommand(continuationCommand, cwd)) return { utility: 0, error: 'continuation command failed' }
  return { utility: oracleCommand === undefined || await runCommand(oracleCommand, cwd) ? 1 : 0 }
}

/** @param {string[]} command @param {string} cwd */
function runCommand(command, cwd) {
  return new Promise(resolve => {
    const [file, ...args] = command
    if (file === undefined) return resolve(false)
    const child = spawn(file, args, { cwd, shell: false, stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
}

/** @param {string} root */
async function directoryHash(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const parts = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) parts.push(`d:${entry.name}:${await directoryHash(full)}`)
    else if (entry.isFile()) parts.push(`f:${entry.name}:${createHash('sha256').update(await readFile(full)).digest('hex')}`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** @param {string} value */
function safeName(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`非法行动 ID：${value}`)
  return value
}

/** @param {string} root @param {object} result */
async function writeEvidence(root, result) {
  const run = JSON.stringify(result, null, 2)
  await writeFile(path.join(root, 'branch-outcomes.json'), run, 'utf8')
  const hash = createHash('sha256').update(run).digest('hex')
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ complete: true, files: [{ name: 'branch-outcomes.json', sha256: hash }] }, null, 2), 'utf8')
}
