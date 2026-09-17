# 可验证节点验收实施计划

> **供代理执行者使用：** 必须使用 `superpowers:executing-plans` 逐项执行本计划。步骤以复选框（`- [ ]`）跟踪。

**目标：** 让长任务节点仅在宿主独立执行的声明式验收检查全部通过后完成，并持久化可审计、脱敏的证据包。

**架构：** 规划器只生成受限的 `acceptanceChecks` 声明；调度器在子 Agent 返回候选产物后调用宿主验收引擎。引擎由部署配置中的白名单注册表解析命令、schema、HTTP、数据库与外部回读能力，将逐项结果与证据摘要追加到现有事件日志；只有 required 检查通过才发出 `TaskCompleted`。

**技术栈：** TypeScript、Node `node:sqlite`、Node `child_process`/`fetch`、现有 Cordis 配置、Vitest、React 18。

**设计：** [`docs/superpowers/specs/2026-09-17-verifiable-task-acceptance-design.md`](../specs/2026-09-17-verifiable-task-acceptance-design.md)

## 全局约束

- 仅修改 `D:\code\long-horizon-runtime`；不要修改 DeepSeek Harness 源码或用户 profile 配置。
- 所有新建或修改的文档使用中文；代码标识符和第三方协议字段保持其既有语言。
- 运行时事件日志是权威数据源；验收结果、证据和计划修订必须追加写且可从事件重建。
- 规划器不能声明任意 shell、URL、SQL、连接串、环境变量名或秘密；它只能引用 bundle 配置注册表中的 ID。
- required 节点必须至少有一个确定性检查。`structural_only` 只能用于带原因的 `read_only` 节点，不能用于外部副作用。
- HTTP、数据库、命令和外部副作用检查均在宿主侧执行，不能由同一执行 Agent 的自述替代。
- 不确定的外部副作用必须暂停，绝不自动重试或自动标记成功。
- 每个行为变更先编写聚焦的失败 Vitest 测试；每个任务独立提交。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/acceptance-contract.ts` | 定义检查判别联合、策略、证据摘要、结果及严格输入解析。 |
| `src/acceptance-policy.ts` | 将部署注册表与节点声明组合为安全的可执行计划；校验白名单与副作用规则。 |
| `src/acceptance.ts` | 宿主验收引擎：执行检查、脱敏、生成证据产物和最终 verdict。 |
| `src/domain.ts` | 将 `acceptanceChecks`、`acceptancePolicy` 纳入计划任务模型。 |
| `src/dsh-adapters.ts` | 扩展 planner JSON Schema 和提示词，要求规划器提供受限验收声明。 |
| `src/scheduler.ts` | 在候选产物持久化后调用验收引擎，并以 verdict 决定任务成功、重试、暂停。 |
| `src/event-store.ts`、`src/projections.ts` | 保存和读取验收检查、bundle 及其事件投影。 |
| `src/runtime.ts`、`src/task-ui-api.ts`、`src/remote.ts` | 将紧凑验收摘要提供给模型工具和 Cockpit remote。 |
| `src/tools.ts`、`cordis.patch.yml` | 配置验收注册表；仅 bundle 默认值可修改。 |
| `client/TaskCockpit.js`、`client/task-model.js`、`client/task-events.js` | 展示文本化验收状态、失败原因和脱敏证据。 |
| `tests/acceptance-*.spec.ts` | 对合同、策略、执行器和安全边界做独立测试。 |

## 任务 1：验收合同、计划校验和兼容策略

**文件：**

- 创建：`src/acceptance-contract.ts`、`src/acceptance-policy.ts`
- 修改：`src/domain.ts`、`src/graph.ts`、`src/dsh-adapters.ts`
- 测试：`tests/acceptance-contract.spec.ts`、`tests/graph.spec.ts`、`tests/dsh-adapters.spec.ts`

**接口：**

- 产生 `AcceptanceCheck`、`AcceptancePolicy`、`AcceptanceCheckResult`、`AcceptanceBundle`。
- 产生 `parseAcceptanceChecks(value: unknown): readonly AcceptanceCheck[]`。
- 产生 `validateTaskAcceptance(task: TaskDraft, capabilities: AcceptanceCapabilities): void`。
- `TaskDraft` 和 `TaskNode` 新增 `acceptanceChecks?: readonly AcceptanceCheck[]` 与 `acceptancePolicy?: 'required' | 'structural_only' | 'human_review'`。

- [ ] **步骤 1：编写失败测试，锁定安全合同和历史兼容性。**

```ts
test('拒绝 required 节点缺少确定性验收检查', () => {
  expect(() => validateTaskAcceptance({
    id: 'unit', objective: '运行测试', dependsOn: [],
    acceptancePolicy: 'required', acceptanceChecks: [],
  }, capabilities)).toThrow('required task must declare a deterministic acceptance check')
})

test('仅允许 read_only 节点使用 structural_only', () => {
  expect(() => validateTaskAcceptance({
    id: 'send', objective: '发送邮件', dependsOn: [],
    sideEffectClass: 'external_effect', acceptancePolicy: 'structural_only',
  }, capabilities)).toThrow('structural_only is only allowed for read_only tasks')
})
```

- [ ] **步骤 2：运行失败测试，确认缺少合同与校验入口。**

运行：`pnpm vitest run tests/acceptance-contract.spec.ts tests/graph.spec.ts tests/dsh-adapters.spec.ts -t "验收|acceptance|structural_only"`

预期：失败，原因是 `acceptanceChecks`、`validateTaskAcceptance` 及 planner schema 尚不存在。

- [ ] **步骤 3：实现最小合同与解析器。**

```ts
export type AcceptanceCheck =
  | { readonly id: string; readonly kind: 'command'; readonly templateId: string; readonly args: readonly string[]; readonly expectedExitCode: number }
  | { readonly id: string; readonly kind: 'file'; readonly path: string; readonly sha256?: string }
  | { readonly id: string; readonly kind: 'json_schema'; readonly source: { readonly kind: 'artifact' | 'file'; readonly ref: string }; readonly schemaId: string }
  | { readonly id: string; readonly kind: 'http'; readonly endpointId: string; readonly requestId: string; readonly expectedStatus: number }
  | { readonly id: string; readonly kind: 'database'; readonly queryId: string; readonly parameters: Readonly<Record<string, string | number | boolean | null>> }
  | { readonly id: string; readonly kind: 'external_effect'; readonly readbackId: string; readonly idempotencyKeyRef: string }
  | { readonly id: string; readonly kind: 'review'; readonly rubricId: string; readonly artifactIds: readonly string[] }

export type AcceptancePolicy = 'required' | 'structural_only' | 'human_review'
```

解析器拒绝未知字段、重复 `id`、空字符串、负超时、无效路径及未注册的检查类型。`graph.ts` 在正常 DAG 校验后调用 `validateTaskAcceptance`；没有验收字段的历史任务保持现有 `required` 语义。`PLAN_SCHEMA` 采用判别式 JSON 子对象，不包含 `command`、`url`、`sql`、`headers` 或凭据字段。

- [ ] **步骤 4：运行聚焦测试，确认合同、schema 与旧计划兼容。**

运行：`pnpm vitest run tests/acceptance-contract.spec.ts tests/graph.spec.ts tests/dsh-adapters.spec.ts`

预期：通过；测试同时证明未知检查、任意命令字段、外部副作用的 structural-only 均被拒绝。

- [ ] **步骤 5：提交。**

```powershell
git add src/acceptance-contract.ts src/acceptance-policy.ts src/domain.ts src/graph.ts src/dsh-adapters.ts tests/acceptance-contract.spec.ts tests/graph.spec.ts tests/dsh-adapters.spec.ts
git commit -m "feat: define declarative task acceptance contracts"
```

## 任务 2：配置注册表与计划安全策略

**文件：**

- 修改：`src/tools.ts`、`cordis.patch.yml`、`src/index.ts`
- 创建：`tests/acceptance-policy.spec.ts`
- 修改：`tests/plugin.spec.ts`

**接口：**

- 产生 `AcceptanceCapabilities`：命令模板、schema、HTTP 端点、数据库查询和外部回读的只读注册表。
- 产生 `resolveAcceptancePlan(task, capabilities): ResolvedAcceptancePlan`。
- `Config` 新增 `acceptance?: AcceptanceConfig`；未配置时只允许历史兼容任务。

- [ ] **步骤 1：编写失败测试，证明配置是白名单而非 Agent 权限。**

```ts
test('只解析配置中注册的命令模板和参数', () => {
  expect(() => resolveAcceptancePlan(commandTask('missing_template'), capabilities))
    .toThrow('unknown command template: missing_template')
})

test('拒绝含写入 SQL 的数据库注册项', () => {
  expect(() => normalizeAcceptanceConfig({
    databaseQueries: { mutate: { connection: 'readonly', sql: 'DELETE FROM users' } },
  })).toThrow('database query must be a single SELECT statement')
})
```

- [ ] **步骤 2：运行失败测试。**

运行：`pnpm vitest run tests/acceptance-policy.spec.ts tests/plugin.spec.ts -t "命令模板|数据库注册|acceptance"`

预期：失败，原因是配置和安全策略不存在。

- [ ] **步骤 3：实现配置规范化及安全解析。**

命令模板仅允许 `executable`、固定 `argsPrefix`、工作区 ID、参数规则及最大超时；检查参数逐一按规则验证。HTTP 端点仅允许 HTTPS、固定主机与路径前缀、允许方法和响应大小上限。数据库注册项仅允许命名连接、参数化的单条 `SELECT`/`WITH ... SELECT` 模板和行数上限。外部回读只能引用 host 安装的函数 ID。所有秘密保持在宿主注入层，`cordis.patch.yml` 只放空注册表和非敏感示例注释。

- [ ] **步骤 4：运行聚焦测试。**

运行：`pnpm vitest run tests/acceptance-policy.spec.ts tests/plugin.spec.ts`

预期：通过；测试证明 planner 不能借由声明实现路径逃逸、任意 URL 或写 SQL。

- [ ] **步骤 5：提交。**

```powershell
git add src/tools.ts src/index.ts cordis.patch.yml tests/acceptance-policy.spec.ts tests/plugin.spec.ts
git commit -m "feat: add allowlisted acceptance capability policy"
```

## 任务 3：持久化证据包与本地确定性执行器

**文件：**

- 创建：`src/acceptance.ts`、`tests/acceptance.spec.ts`
- 修改：`src/event-store.ts`、`src/projections.ts`、`src/artifacts.ts`
- 修改：`tests/event-store.spec.ts`、`tests/durable-core.spec.ts`

**接口：**

- 产生 `AcceptanceEngine.evaluate(input): Promise<AcceptanceBundle>`。
- `AcceptanceBundle` 包含 `id`、`attemptId`、`verdict`、`checks`、`artifactIds`、`startedAt`、`finishedAt`。
- event store 增加 `listAcceptanceBundles(goalId, taskId?)` 与 `getAcceptanceBundle(attemptId)`。

- [ ] **步骤 1：编写失败测试，证明 evidence 由宿主生成且可重建。**

```ts
test('命令检查保存退出码与脱敏输出，并以失败 verdict 结束', async () => {
  const bundle = await engine.evaluate(commandInput('unit_test', ['--fails']))
  expect(bundle).toMatchObject({ verdict: 'failed', checks: [expect.objectContaining({ exitCode: 1 })] })
  expect(bundle.checks[0].summary).not.toContain('secret-value')
})

test('重建投影后仍能读取通过的验收 bundle', () => {
  store.rebuildProjections()
  expect(store.getAcceptanceBundle('attempt-1')?.verdict).toBe('passed')
})
```

- [ ] **步骤 2：运行失败测试。**

运行：`pnpm vitest run tests/acceptance.spec.ts tests/event-store.spec.ts tests/durable-core.spec.ts -t "验收 bundle|命令检查|重建"`

预期：失败，原因是引擎、事件和投影不存在。

- [ ] **步骤 3：实现证据事件、投影及三类本地检查。**

验收引擎先追加 `AcceptanceCheckStarted`，随后执行 `command`、`file` 或 `json_schema`，为每项追加 `AcceptanceEvidenceRecorded` 与 `AcceptanceCheckFinished`，最后追加 `AcceptanceBundleFinalized`。命令以 `spawn` 参数数组执行，绝不使用 shell 字符串；cwd 由已解析工作区提供；stdout/stderr 做大小截断与秘密脱敏。文件路径用 `resolve` 与相对路径检查限制在工作区。JSON schema 仅通过 schema 注册表解析。大输出用 `ArtifactStore.put` 保存，摘要存入事件。

- [ ] **步骤 4：运行聚焦测试。**

运行：`pnpm vitest run tests/acceptance.spec.ts tests/event-store.spec.ts tests/durable-core.spec.ts`

预期：通过；同时覆盖超时、路径逃逸、hash 不一致、无效 JSON、输出脱敏和事件重建。

- [ ] **步骤 5：提交。**

```powershell
git add src/acceptance.ts src/event-store.ts src/projections.ts src/artifacts.ts tests/acceptance.spec.ts tests/event-store.spec.ts tests/durable-core.spec.ts
git commit -m "feat: persist host-generated acceptance evidence"
```

## 任务 4：将验收 verdict 接入调度、重试和下游依赖

**文件：**

- 修改：`src/scheduler.ts`、`src/runtime.ts`、`src/context.ts`
- 修改：`tests/scheduler.spec.ts`、`tests/runtime.spec.ts`、`tests/context.spec.ts`

**接口：**

- `SchedulerOptions` 新增 `acceptanceEngine?: AcceptanceEngine`。
- 成功条件变为 `resultContract.ok && acceptanceBundle.verdict === 'passed'`。
- `ContextBuilder` 仅选择具有通过验收 bundle 的上游产物。

- [ ] **步骤 1：编写失败测试，证明子 Agent 自述不能完成节点。**

```ts
test('子 Agent 返回 succeeded 但命令验收失败时不发送 TaskCompleted', async () => {
  await scheduler.runRound('goal', undefined, parent)
  expect(store.listEvents('goal').map(event => event.type)).toContain('ValidationRecorded')
  expect(store.listEvents('goal').map(event => event.type)).not.toContain('TaskCompleted')
})

test('下游节点不会收到验收失败 attempt 的 artifact', async () => {
  expect(builder.forTask('downstream').artifacts).toEqual([])
})
```

- [ ] **步骤 2：运行失败测试。**

运行：`pnpm vitest run tests/scheduler.spec.ts tests/runtime.spec.ts tests/context.spec.ts -t "验收失败|不会收到|TaskCompleted"`

预期：失败，因为 scheduler 尚未调用验收引擎。

- [ ] **步骤 3：按顺序接入 scheduler。**

保留候选产物和 Agent evidence 的现有持久化顺序；随后调用验收引擎。bundle 通过才产生 `ValidationRecorded(ok)` 和 `TaskCompleted`。确定性失败生成 `ValidationRecorded(false, failureKind: 'output')`，沿用退避、重试和终态重规划。验收基础设施不可用生成 `infrastructure`，不得触发自动重规划。`structural_only` 必须产生一条含风险原因的决策/验收事件。对历史计划，继续沿用旧结构验证，不回写或伪造 bundle。

- [ ] **步骤 4：运行聚焦测试。**

运行：`pnpm vitest run tests/scheduler.spec.ts tests/runtime.spec.ts tests/context.spec.ts`

预期：通过；现有重试、取消、超时及重规划测试不退化。

- [ ] **步骤 5：提交。**

```powershell
git add src/scheduler.ts src/runtime.ts src/context.ts tests/scheduler.spec.ts tests/runtime.spec.ts tests/context.spec.ts
git commit -m "feat: gate task completion on acceptance verdicts"
```

## 任务 5：HTTP、数据库与外部副作用回读

**文件：**

- 修改：`src/acceptance.ts`、`src/acceptance-policy.ts`
- 创建：`tests/acceptance-http.spec.ts`、`tests/acceptance-database.spec.ts`、`tests/acceptance-external.spec.ts`
- 修改：`tests/scheduler.spec.ts`、`tests/plugin.spec.ts`

**接口：**

- `AcceptanceEngine` 新增 `evaluateHttp`、`evaluateDatabase`、`evaluateExternalEffect` 私有分支。
- 外部回读返回 `'passed' | 'failed' | 'indeterminate'`；`indeterminate` 映射到既有 `TaskRecoveryBlocked` 与 `GoalPaused`。

- [ ] **步骤 1：编写失败测试，覆盖远程检查的安全和不确定性。**

```ts
test('HTTP 检查拒绝未注册主机，且不发起请求', async () => {
  await expect(engine.evaluate(httpInput('unknown'))).rejects.toThrow('unknown HTTP endpoint')
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('数据库检查仅运行固定 SELECT 模板与绑定参数', async () => {
  await engine.evaluate(databaseInput('user_by_id', { id: 'u1' }))
  expect(querySpy).toHaveBeenCalledWith('SELECT id, state FROM users WHERE id = :id', { id: 'u1' })
})

test('外部回读不明确时暂停而非重试或完成', async () => {
  await scheduler.runRound('goal', undefined, parent)
  expect(store.getGoal('goal')?.state).toBe('PAUSED')
})
```

- [ ] **步骤 2：运行失败测试。**

运行：`pnpm vitest run tests/acceptance-http.spec.ts tests/acceptance-database.spec.ts tests/acceptance-external.spec.ts tests/scheduler.spec.ts -t "HTTP|数据库|外部回读"`

预期：失败，因为远程检查分支尚不存在。

- [ ] **步骤 3：实现受限远程检查。**

HTTP 仅接受策略解析后的 HTTPS URL、允许方法、固定请求模板和受限响应体；禁止跟随跨主机重定向。数据库通过配置的只读适配器执行单条模板 SQL，绑定类型化参数，并执行结果断言；不将连接字符串或行数据原文写进事件。外部副作用只调用已注册回读函数，传入稳定 idempotency key 与预期状态；`indeterminate` 在同一事务中写入阻塞/暂停事件，不排入 retry 队列。

- [ ] **步骤 4：运行聚焦测试。**

运行：`pnpm vitest run tests/acceptance-http.spec.ts tests/acceptance-database.spec.ts tests/acceptance-external.spec.ts tests/scheduler.spec.ts tests/plugin.spec.ts`

预期：通过；测试证明无 SSRF、无写 SQL、无外部副作用自动重放。

- [ ] **步骤 5：提交。**

```powershell
git add src/acceptance.ts src/acceptance-policy.ts tests/acceptance-http.spec.ts tests/acceptance-database.spec.ts tests/acceptance-external.spec.ts tests/scheduler.spec.ts tests/plugin.spec.ts
git commit -m "feat: verify service and external task outcomes"
```

## 任务 6：远程 DTO、Cockpit、审计与完整验证

**文件：**

- 修改：`src/runtime.ts`、`src/task-ui-api.ts`、`src/remote.ts`、`client/task-model.js`、`client/task-events.js`、`client/TaskCockpit.js`
- 修改：`tests/task-ui.spec.ts`、`tests/task-cockpit.spec.ts`、`tests/plugin.spec.ts`
- 修改：`README.md`、`docs/decisions/2026-08-22-long-task-runtime-v1.md`

**接口：**

- `GoalView` 增加 `acceptance: readonly AcceptanceBundleSummary[]`。
- `TaskUiApi.getTaskAudit({ taskId })` 返回每个 attempt 的 bundle 摘要和仅允许的 evidence artifact 元数据。
- `formatTaskEvent` 增加四类 `Acceptance*` 事件的中文标签、详情和 tone。

- [ ] **步骤 1：编写失败测试，锁定面向用户的状态与脱敏边界。**

```ts
test('Cockpit 用文本展示验证失败和最近失败原因', () => {
  expect(renderedText).toContain('验证失败')
  expect(renderedText).toContain('测试命令退出码为 1')
})

test('任务审计返回 bundle 摘要但不返回认证头或原始秘密', () => {
  const audit = ui.getTaskAudit({ taskId: 'lt_a' })
  expect(JSON.stringify(audit)).not.toContain('Bearer secret-value')
})
```

- [ ] **步骤 2：运行失败测试。**

运行：`pnpm vitest run tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts -t "验证失败|bundle|秘密|acceptance"`

预期：失败，因为 DTO、事件格式化和 Cockpit 渲染尚未包含验收数据。

- [ ] **步骤 3：实现只读 API 和 UI 呈现。**

为每个节点显示 `未验证`、`验证中`、`已验证`、`验证失败`、`需人工确认` 或 `仅结构验证（风险）` 的文本状态。时间线逐项展示检查名称、时间和脱敏摘要；证据详情只通过现有 artifact 权限路径打开。remote 方法继续使用单个命名输入对象，且不提供浏览器端执行检查的能力。README 与决策记录说明：`required` 不等于语义证明，确定性检查是通过条件，LLM review 是辅助证据。

- [ ] **步骤 4：运行聚焦测试和完整验证。**

运行：`pnpm vitest run tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts`

运行：`pnpm test; pnpm typecheck; pnpm build; pnpm pack --dry-run; git diff --check`

预期：全部通过；不包含未提交的用户既有 UI 改动。

- [ ] **步骤 5：提交。**

```powershell
git add src/runtime.ts src/task-ui-api.ts src/remote.ts client/task-model.js client/task-events.js client/TaskCockpit.js tests/task-ui.spec.ts tests/task-cockpit.spec.ts tests/plugin.spec.ts README.md docs/decisions/2026-08-22-long-task-runtime-v1.md
git commit -m "feat: expose verifiable task acceptance in cockpit"
```

## 计划自查

- 设计中的合同、白名单、持久证据、本地检查、HTTP、数据库、外部副作用、审查限制、UI、迁移和验收标准均分别由任务 1 至 6 覆盖。
- 每项任务均包含具体的失败测试、运行命令、最小实现说明和提交命令。
- 所有跨任务接口均以 `AcceptanceCheck`、`AcceptanceBundle`、`AcceptanceEngine`、`AcceptanceCapabilities` 和 `acceptancePolicy` 为唯一名称，后续任务不引入同义接口。
