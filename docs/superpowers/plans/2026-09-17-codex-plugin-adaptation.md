# Long Horizon Runtime Codex 插件适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 为现有 Long Horizon Runtime 增加可安装、可恢复且保留领域行为的 Codex 本地 MCP 插件。

**架构：** 复用现有无 DSH 依赖的领域核心，在 `codex-plugin` 中增加独立 stdio MCP 宿主及 `codex exec` 进程适配器。DSH Cordis 层不变；两个宿主通过相同的 `LongTaskRuntime`、事件与重规划规则工作。

**技术栈：** TypeScript、Node.js、MCP SDK、Zod、SQLite、Vitest、Codex plugin manifest、Codex CLI。

**规范：** `docs/superpowers/specs/2026-09-17-codex-plugin-adaptation-design.md`

## 全局约束

- 仅修改 `D:\code\long-horizon-runtime`；不改 DeepSeek Harness 或用户 profile。
- 所有新增/修改文档必须为中文。
- DSH 默认配置仅可保留在 `cordis.patch.yml`，本任务不得修改其默认值。
- 所有行为改动先写失败的 Vitest 测试。
- Codex worker 不得获得任何 `long_task_*` 生命周期工具或父任务数据库路径。
- 任务 ID、追加事件和 revision fence 必须复用现有领域规则。

---

### Task 1: 建立 Codex 可复用运行时装配接口

**文件：**
- 修改：`src/runtime.ts`、`src/adapters.ts`、`src/index.ts`
- 创建：`src/codex-runtime.ts`
- 测试：`tests/codex-runtime.spec.ts`

**接口：**
- 产生 `createCodexRuntime(options): LongTaskRuntime`，其中 options 仅包含数据库、工件、并发、planner 与 execution adapter。
- 不导入 Cordis、DSH Agent 或 Typert 类型。

- [ ] **Step 1: 编写失败测试**

```ts
test('通过 Codex 装配器创建的运行时保留目标与计划语义', async () => {
  const runtime = createCodexRuntime({ databasePath, artifactDirectory, planner, execution })
  const goal = await runtime.createGoal({ objective: '验证 Codex 核心', constraints: [], planningMode: 'require_confirmation' })
  expect(goal.id).toMatch(/^lt_/)
  expect(goal.state).toBe('AWAITING_CONFIRMATION')
})
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm vitest run tests/codex-runtime.spec.ts`

- [ ] **Step 3: 实现最小装配器**

```ts
export function createCodexRuntime(options: CodexRuntimeOptions): LongTaskRuntime {
  return new LongTaskRuntime(options.planner, options.execution, options)
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`pnpm vitest run tests/codex-runtime.spec.ts`

- [ ] **Step 5: 提交**

```text
git add src tests
git commit -m "feat: expose codex runtime assembly"
```

### Task 2: 实现 Codex CLI 受限子进程适配器

**文件：**
- 创建：`codex-plugin/server/codex-process-adapter.ts`、`codex-plugin/server/worker-prompt.ts`
- 测试：`tests/codex-process-adapter.spec.ts`

**接口：**
- 产生 `CodexProcessAdapter`，实现 `PlannerAdapter` 与 `ExecutionAdapter`。
- 产生 `CodexCommandRunner.run(input): Promise<CodexRunResult>` 以便测试替身检查命令与输入。

- [ ] **Step 1: 编写失败测试**

```ts
test('worker 命令使用隔离配置且输入不包含生命周期工具或数据库路径', async () => {
  await adapter.execute(executionInput)
  expect(runner.calls[0].args).toContain('exec')
  expect(runner.calls[0].prompt).not.toContain('long_task_')
  expect(runner.calls[0].environment.LONG_TASK_DATABASE_PATH).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm vitest run tests/codex-process-adapter.spec.ts`

- [ ] **Step 3: 实现 JSON 输出解析、超时和中断映射**

```ts
const run = await runner.run({ mode: 'worker', prompt, signal, timeoutMs })
if (run.stopReason === 'aborted') return interruptedResult(run)
return decodeExecutionResult(run.json)
```

- [ ] **Step 4: 运行测试确认通过**

运行：`pnpm vitest run tests/codex-process-adapter.spec.ts`

- [ ] **Step 5: 提交**

```text
git add codex-plugin/server tests
git commit -m "feat: add isolated codex worker adapter"
```

### Task 3: 增加 MCP 控制服务与耐久恢复

**文件：**
- 创建：`codex-plugin/server/mcp-server.ts`、`codex-plugin/server/daemon.ts`、`codex-plugin/server/index.ts`
- 修改：`src/task-api.ts`
- 测试：`tests/codex-mcp.spec.ts`、`tests/codex-daemon.spec.ts`

**接口：**
- 产生 `createCodexMcpServer(dependencies)` 和 `CodexDaemon`。
- 每个 MCP 工具只接收一个对象；控制操作要求 `controlRevision`。

- [ ] **Step 1: 编写失败 MCP 契约测试**

```ts
test('确认计划使用 revision fence 并返回冲突而不修改任务', async () => {
  const result = await callTool('long_task_confirm_plan', { taskId, controlRevision: 999 })
  expect(result).toMatchObject({ kind: 'conflict' })
  expect(runtime.getGoal(taskId)?.state).toBe('AWAITING_CONFIRMATION')
})
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm vitest run tests/codex-mcp.spec.ts tests/codex-daemon.spec.ts`

- [ ] **Step 3: 注册全部生命周期工具与启动恢复**

```ts
server.tool('long_task_pause', schema, async input => asMcp(await api.pause(input)))
daemon.start = async () => { runtime.purgeExpiredArchives(); await runtime.recover() }
```

- [ ] **Step 4: 运行测试确认通过**

运行：`pnpm vitest run tests/codex-mcp.spec.ts tests/codex-daemon.spec.ts`

- [ ] **Step 5: 提交**

```text
git add src codex-plugin/server tests
git commit -m "feat: expose durable runtime through codex mcp"
```

### Task 4: 生成可安装 Codex 插件与仓库 marketplace

**文件：**
- 创建：`codex-plugin/.codex-plugin/plugin.json`、`codex-plugin/.mcp.json`、`codex-plugin/skills/long-horizon-runtime/SKILL.md`、`.agents/plugins/marketplace.json`
- 修改：`package.json`
- 测试：`tests/codex-plugin-package.spec.ts`

**接口：**
- manifest 名称为 `long-horizon-runtime`，MCP server 指向编译后的本地入口。
- marketplace 以仓库根目录为基准，插件 source 为 `./codex-plugin`。

- [ ] **Step 1: 编写失败清单测试**

```ts
test('Codex manifest、MCP 配置和 marketplace 指向同一插件根目录', () => {
  expect(manifest.name).toBe('long-horizon-runtime')
  expect(manifest.mcpServers).toBe('./.mcp.json')
  expect(marketplace.plugins[0].source.path).toBe('./codex-plugin')
})
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm vitest run tests/codex-plugin-package.spec.ts`

- [ ] **Step 3: 使用 Codex 插件脚手架并补充中文 skill**

```json
{ "name": "long-horizon-runtime", "mcpServers": "./.mcp.json", "skills": "./skills/" }
```

- [ ] **Step 4: 运行清单测试和官方验证器**

运行：`pnpm vitest run tests/codex-plugin-package.spec.ts; python C:\Users\19632\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py codex-plugin`

- [ ] **Step 5: 提交**

```text
git add codex-plugin .agents package.json tests
git commit -m "feat: package long horizon runtime for codex"
```

### Task 5: 交叉宿主回归、中文文档与完整验证

**文件：**
- 创建：`tests/cross-host-contract.spec.ts`
- 修改：`README.md`、`README.en.md`
- 测试：全部现有与新增测试

**接口：**
- 相同 event sequence 由 DSH 和 Codex 装配的共享核心投影为相同状态。

- [ ] **Step 1: 编写失败跨宿主测试**

```ts
test('DSH 与 Codex 入口对相同重规划事件给出一致的待确认决策', async () => {
  expect(classifyReplan(dshPlan, candidate, trigger)).toEqual(classifyReplan(codexPlan, candidate, trigger))
})
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm vitest run tests/cross-host-contract.spec.ts`

- [ ] **Step 3: 补齐适配器与中文安装、恢复、隔离说明**

```md
## Codex 安装

使用仓库 marketplace 注册插件后，在新的 Codex 任务中使用长任务控制工具。
```

- [ ] **Step 4: 运行完整验证**

运行：`pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`

- [ ] **Step 5: 提交**

```text
git add README.md README.en.md tests docs
git commit -m "docs: document codex long task plugin"
```
