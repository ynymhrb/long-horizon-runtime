import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runCounterfactualBranches } from '../validation/decision-quality/branch-runner.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'dq-branch-'))
  roots.push(root)
  const snapshot = path.join(root, 'snapshot')
  await (await import('node:fs/promises')).mkdir(snapshot)
  await writeFile(path.join(snapshot, 'state.txt'), 'original', 'utf8')
  return { root, snapshot, evidenceRoot: path.join(root, 'evidence') }
}

test('三个行动从同一快照运行且互不读取其他分支写入', async () => {
  const { root, snapshot, evidenceRoot } = await setup()
  const result = await runCounterfactualBranches({
    initialSnapshot: snapshot, workspaceRoot: root, evidenceRoot,
    actions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    executor: { async execute({ branch, action }: { branch: string, action: { id: string } }) { await writeFile(path.join(branch, `${action.id}.txt`), action.id); return { utility: action.id === 'a' ? 1 : 0 } } },
  })
  expect(result.verdict).toBe('pass')
  expect(new Set(result.branches.map(row => (row as { initialStateHash: string }).initialStateHash)).size).toBe(1)
  expect(await readFile(path.join(snapshot, 'state.txt'), 'utf8')).toBe('original')
})

test('分支写入初始快照时硬停止并保留污染证据', async () => {
  const { root, snapshot, evidenceRoot } = await setup()
  const result = await runCounterfactualBranches({
    initialSnapshot: snapshot, workspaceRoot: root, evidenceRoot,
    actions: [{ id: 'bad' }],
    executor: { async execute() { await writeFile(path.join(snapshot, 'state.txt'), 'mutated'); return { utility: 0 } } },
  })
  expect(result.verdict).toBe('hard_stop')
  expect(result.contamination).toContain('initial_snapshot_modified')
})

test('命令分支在各自副本中执行并由 oracle 产生效用', async () => {
  const { root, snapshot, evidenceRoot } = await setup()
  await writeFile(path.join(snapshot, 'action.mjs'), "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], process.argv[3])", 'utf8')
  await writeFile(path.join(snapshot, 'oracle.mjs'), "import { readFile } from 'node:fs/promises'; process.exit(await readFile('result.txt', 'utf8') === 'pass' ? 0 : 1)", 'utf8')
  const result = await runCounterfactualBranches({
    initialSnapshot: snapshot, workspaceRoot: root, evidenceRoot,
    actions: [
      { id: 'pass', command: ['node', 'action.mjs', 'result.txt', 'pass'] },
      { id: 'fail', command: ['node', 'action.mjs', 'result.txt', 'fail'] },
    ],
    continuationCommand: ['node', 'action.mjs', 'continued.txt', 'yes'],
    oracleCommand: ['node', 'oracle.mjs'],
  })
  expect(result.verdict).toBe('pass')
  expect(result.branches.map(row => row.utility)).toEqual([1, 0])
})

test('命令模式拒绝未允许的可执行文件和越界脚本路径', async () => {
  const { root, snapshot, evidenceRoot } = await setup()
  await expect(runCounterfactualBranches({
    initialSnapshot: snapshot, workspaceRoot: root, evidenceRoot,
    actions: [{ id: 'unsafe', command: ['powershell', '-Command', 'Write-Output no'] }],
  })).resolves.toMatchObject({ branches: [expect.objectContaining({ error: expect.stringMatching(/不在允许列表/) })] })
  await expect(runCounterfactualBranches({
    initialSnapshot: snapshot, workspaceRoot: path.join(root, 'next'), evidenceRoot: path.join(root, 'next-evidence'),
    actions: [{ id: 'traversal', command: ['node', '../escape.mjs'] }],
  })).resolves.toMatchObject({ branches: [expect.objectContaining({ error: expect.stringMatching(/越界/) })] })
})
