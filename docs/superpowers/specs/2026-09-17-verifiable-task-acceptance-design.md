# 可验证的节点验收设计

## 目标

只有当运行时独立执行并记录节点声明的验收检查后，长任务节点才可成功。子 Agent 可以提交候选产物与证据提示，但不能凭借“任务已完成”的自述让自身成功。

## 范围

本设计为长任务运行时新增通用、声明式的验收框架。首批支持本地命令、文件、JSON Schema、HTTP 回读、只读数据库查询及外部副作用确认。独立 LLM 审查可作为辅助证据，但永远不能成为唯一的通过条件。

不在本期范围内：

- 为自然语言交付物提供通用的语义正确性证明；
- 允许规划器任意执行 shell、访问 URL、执行 SQL 或获取凭据；
- 替换现有的持久化事件日志、重试、重规划或归档机制；
- 对状态不明的外部副作用静默自动恢复。

## 当前基线与缺口

目前调度器接受任务结果前，会检查结构：返回状态为成功、结果字段齐全、产物类型在允许集合内，以及可选的产物类型/MIME 输出契约。内置命名 validator `required` 由插件调度器注册，在这些结构检查通过后返回成功；它不是 DSH 或子 Agent 的验证器。`completionCriteria` 目前仅作为上下文文本，`evidence` 是 Agent 提交的字符串列表。

新设计保留上述行为作为 `structural_only` 兼容模式；除经批准的开放式任务外，它不再满足生产计划的默认验收要求。

## 验收契约

每个计划 `TaskNode` 新增可选的结构化 `acceptanceChecks` 列表。现有 `completionCriteria` 保留为供人和 Agent 阅读的简明目标说明，并应与检查一致，但绝不作为可执行代码解析。

```ts
type AcceptanceCheck =
  | CommandCheck
  | FileCheck
  | JsonSchemaCheck
  | HttpCheck
  | DatabaseCheck
  | ExternalEffectCheck
  | ReviewCheck

interface TaskNode {
  // existing fields
  readonly completionCriteria?: string
  readonly acceptanceChecks?: readonly AcceptanceCheck[]
  readonly acceptancePolicy?: 'required' | 'structural_only' | 'human_review'
}
```

新计划的 `acceptancePolicy` 默认值为 `required`。使用 `structural_only` 的节点必须是 `read_only`、提供人类可读的原因，并在 Cockpit 与审计流中明确展示风险；它不可用于 `idempotent` 或 `external_effect` 工作。

规划器 schema 仅接受这些检查类型的判别式 JSON 表示，不接受可执行 JavaScript、任意环境变量名、不受限 URL、任意连接串或 LLM 提供的自由 SQL。

### 检查类型

| 类型 | 规划器可声明 | 运行时独立验证 |
|---|---|---|
| `command` | 白名单命令 ID、参数、工作范围 ID、期望退出码、受限超时、输出匹配器 | 解析后的可执行文件、允许参数/路径、进程退出码、输出匹配器与超时 |
| `file` | 工作区相对路径、预期文件种类、大小范围、可选 SHA-256 | 规范化路径未离开任务工作区；文件系统元数据和字节内容符合声明 |
| `json_schema` | artifact/相对文件引用和 schema ID | 实际输入可解析为 JSON 且通过已注册 schema |
| `http` | 已注册端点 ID、方法、请求模板 ID、状态/正文断言 | 端点策略、请求构造、真实状态/头部/正文断言 |
| `database` | 已注册只读模型 ID、查询模板 ID、类型化参数、行/结果断言 | 只读连接、固定查询模板、类型绑定、结果断言 |
| `external_effect` | 幂等键引用、已注册回读检查、期望观测状态 | 动作后的回读；结果不明确时暂停任务 |
| `review` | 审查量规 ID 与产物引用 | 独立配置的审查器输出结构化意见；不能单独让 required 节点通过 |

首版不向计划暴露原始命令字符串、原始 URL、原始 SQL、秘密或凭据。部署配置拥有命令、端点、数据库查询、schema、回读和审查量规 ID 的注册表。计划仅能选择注册表项目，并提供经过校验的类型化值。

## 运行时流程

```text
已验证计划
  -> 子 Agent 尝试产生候选产物
  -> 调度器保存候选产物与 Agent 提示
  -> 验收引擎解析并执行每一项声明检查
  -> 保存不可变 evidence bundle
  -> 所有 required 检查通过：ValidationRecorded(ok) + TaskCompleted
  -> 任一确定性检查失败：ValidationRecorded(false) + 重试/失败
  -> 外部副作用结果不明确：TaskRecoveryBlocked + GoalPaused
```

执行 Agent 无权调用验收引擎的特权注册表。宿主仅在接收子结果后调用验收引擎。因此模型无法通过篡改其结构化输出伪造测试退出码、HTTP 响应、数据库结果或文件哈希。

现有 `ArtifactProduced`、`EvidenceRecorded`、`ValidationRecorded` 和终态任务事件依然保持追加写。新增检查级事件：

- `AcceptanceCheckStarted`
- `AcceptanceEvidenceRecorded`
- `AcceptanceCheckFinished`
- `AcceptanceBundleFinalized`

每个事件均记录 `goalId`、`taskId`、`attemptId`、计划修订、检查 ID、时间和紧凑的脱敏摘要。大型命令输出、响应正文和结果集作为内容寻址产物保存。bundle 包含产物哈希清单、适用时的环境/工具版本、开始/结束时间及最终 verdict。只有所属 attempt 的验收 bundle 通过后，产物才允许传递给下游上下文。

## 失败与重试语义

- 确定性验收检查失败属于 `output` 失败，遵循节点重试策略；在终态失败证据已持久化后，才可触发现有的有界自动重规划。
- 执行器崩溃、超时、验证服务不可用或数据库不可用属于 `infrastructure` 失败：保留证据，不将其视为内容验证失败，并按现有策略暂停或重试。
- HTTP/数据库断言成功执行但观察到错误值，属于 `output` 失败。
- 对外部副作用，执行和验证分离：正向回读通过；明确的负向回读按节点恢复策略失败；不可用或矛盾回读暂停目标并等待人工决定，绝不自动重试。
- `review` 可以拒绝候选结果并要求重试或审查门槛，但批准的审查不能覆盖失败的确定性 required 检查。

## 安全与隔离

验收引擎运行在区别于子 Agent 工具权限的宿主策略中。

- 命令引用部署拥有的模板，并在专用任务工作区执行；设置受限超时、输出大小上限与脱敏环境。模板参数均类型化且路径规范化。
- 文件引用必须规范化；若离开分配工作区或产物目录则拒绝。
- HTTP 检查使用命名端点策略：允许的主机/路径/方法、由宿主提供的认证、请求/响应大小上限、重定向策略和 SSRF 安全地址规则。
- 数据库检查使用命名只读连接与命名参数化查询模板。即使注册错误，执行器也拒绝修改语句，并强制查询时间/行数上限。
- 外部副作用必须拥有稳定的幂等键和已注册的回读函数，且不能使用 `structural_only` 验收。
- 证据在写入事件与 UI 前完成脱敏；原始秘密、认证头和连接串绝不进入 evidence artifact。

## 配置模型

插件 bundle 默认配置仍仅放在 `cordis.patch.yml`，用户 profile 覆盖不属于本设计范围。插件配置新增 `acceptance` 章节，注册允许能力，例如：

```yaml
acceptance:
  commandTemplates:
    test_unit:
      executable: pnpm
      argsPrefix: [test, --]
      workspace: task_workspace
      maxTimeoutMs: 600000
  httpEndpoints:
    app_health:
      baseUrl: https://service.example.invalid
      allowedMethods: [GET]
  databaseQueries:
    user_by_id:
      connection: app_readonly
      sql: SELECT id, state FROM users WHERE id = :id
```

敏感具体值必须通过 DSH/宿主的秘密处理注入，不能写入提交的 bundle。若注册项格式不合法或检查 ID 重复，配置校验必须令插件激活失败。

## UI 与 API

`GoalView` 及 Typert task remote 暴露紧凑的验收状态：

- 每个任务：策略、声明检查、最新 verdict、最近失败原因；
- 每次尝试：bundle ID 和检查结果；
- 每个 bundle：脱敏摘要及允许访问的证据产物链接。

Cockpit 在 DAG 节点旁渲染独立验收状态：`未验证`、`验证中`、`已验证`、`验证失败`、`需人工确认`。文本标签始终可见，颜色仅作为补充。事件时间线为每项检查提供可读标签，并允许用户打开脱敏证据详情；UI 不得展示含秘密的值或未脱敏原始日志。

## 迁移与兼容性

1. 历史计划修订可在没有 `acceptanceChecks` 的情况下反序列化，并保持原始 `required` 行为。
2. 当部署至少配置一个注册表时，新计划默认要求验收。未配置注册表的部署保持兼容模式，但在启动时给出警告，并在 UI 中标识风险。
3. 新的 required 节点若没有确定性检查则被计划验证拒绝；仅白名单开放式类别允许显式 `human_review` 任务。
4. 重规划保留已成功任务及其验收 bundle 不变；自动重规划不得使已验证证据失效。

## 交付顺序

1. 定义判别式契约、配置注册表类型、持久化证据投影与兼容模式；暂不执行特权操作。
2. 实现隔离的本地执行器及 `command`、`file`、`json_schema` 检查，为代码任务提供核心保障。
3. 实现策略注册的 `http` 检查和脱敏响应证据。
4. 实现只读 `database` 检查、固定模板与结果断言。
5. 实现外部副作用的回读/确认和操作员 UI。
6. 增加非权威 `review` 辅助检查、Cockpit 证据展示、场景覆盖、文档与迁移指南。

每阶段都可独立发布。命令/文件/schema 检查必须先于远程服务和数据库集成落地，以低风险本地场景先验证特权执行器与证据模型。

## 本功能验收标准

- 子 Agent 即使上报 `succeeded`，只要一项宿主执行的 required 检查失败或缺失，就不能完成 required 节点。
- 下游节点不可消费验收 bundle 缺失、失败、已取代或已失效 attempt 的产物。
- 所有检查执行及 verdict 经受宿主重启后仍可用追加运行时事件和内容寻址证据重建。
- 规划器不得造成任意命令执行、SSRF、写 SQL、路径逃逸、凭据泄漏或自动重放状态不明的外部副作用。
- 历史任务仍可读取，并保留其原始审计语义。
