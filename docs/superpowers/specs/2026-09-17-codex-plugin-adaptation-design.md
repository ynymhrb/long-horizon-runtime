# Long Horizon Runtime Codex 插件适配设计

## 目标

在不迁移、删除或改变现有 DSH 插件行为的前提下，为 `v1.0.0` 的长任务运行时增加可由 Codex 安装的本地插件。Codex 版必须保留耐久任务、计划确认、DAG 调度、任务状态、目标修订、安全重规划、暂停恢复、归档恢复、工件与审计事件的领域语义。

## 非目标

- 不修改 DeepSeek Harness、`cordis.patch.yml` 或用户 DSH 配置。
- 不复制 DSH 的 Cordis Task Area、Typert Remote 或会话导航 UI。
- 不把任务数据迁移到云端，也不要求 OpenAI API 密钥。
- 不改变既有 `long_task_*` 的 DSH 工具名称或参数。

## 总体架构

运行时分为共享领域核心和两个宿主适配层。共享核心继续拥有 SQLite 事件日志、投影、任务图、调度器、重规划策略和工件存储。DSH 适配层保留当前 Cordis 工具、DSH 子 Agent 适配器和浏览器 UI；Codex 适配层新增一个 stdio MCP 服务、一个本地守护进程入口和 Codex 插件清单。

Codex 对话调用 MCP 的控制工具。服务在本机使用独立的数据库与工件目录，并把每个持久任务的 planner/worker 子进程元数据写入同一事件模型。守护进程通过本机 `codex exec` 运行无生命周期权限的 planner 或节点 worker；当调用方对话结束，守护进程仍能恢复可执行的队列。所有状态变更必须由共享核心的 revision fence 校验。

## 目录与边界

| 路径 | 职责 |
| --- | --- |
| `src/` | 当前共享领域代码与 DSH 适配层；仅将 Codex 可复用的接口放在不依赖 DSH 的模块中。 |
| `codex-plugin/` | 可安装的 Codex 插件根目录，含 manifest、MCP 配置、技能说明及启动脚本。 |
| `codex-plugin/server/` | stdio MCP 服务器、守护调度入口、Codex CLI 进程适配器。 |
| `tests/codex-*.spec.ts` | MCP 契约、CLI 适配、恢复和跨宿主领域语义测试。 |
| `.agents/plugins/marketplace.json` | 仓库随附的本地 marketplace，使源码检出可注册为 Codex 插件；不写入用户目录。 |

## MCP 契约

服务命名为 `long-horizon-runtime`，提供以下工具。每个工具只接收一个对象参数，并返回稳定的 JSON 对象：

- `long_task_create`：创建耐久任务并请求计划。
- `long_task_get`、`long_task_list`：读取任务、计划、状态和事件摘要。
- `long_task_confirm_plan`：在显示 revision 一致时确认计划并开始调度。
- `long_task_pause`、`long_task_resume`：中断或恢复调度，不把中断视为失败证据。
- `long_task_edit_goal`、`long_task_accept_replan`、`long_task_reject_replan`：保留追加式目标版本与安全重规划策略。
- `long_task_archive`、`long_task_restore`：保留 30 天归档保留期；物理清理由守护进程启动和列表调用触发。
- `long_task_artifacts`：列出任务可读取的工件元数据和内容引用。

工具输出不会声称提供 DSH 会话跳转；取而代之的是返回 Codex worker 执行记录及可读事件时间线。

## Worker 隔离与恢复

`CodexProcessAdapter` 只负责启动、终止及解释 `codex exec --json` 的结构化输出。它不拥有领域状态。每次 planner 或 worker 启动都会由守护进程生成 attempt 标识，先写入 durable event，再关联进程号、命令和开始时间。完成、超时、异常与操作员中断同样先写入事件再改变队列。

worker 使用最小化配置启动：不加载该插件的 MCP server，不接收其 SQLite 路径，也不暴露生命周期工具。prompt 只含当前节点、输入工件引用、输出契约、预算和允许的工作目录。这样 worker 无法创建、确认、暂停、修改或归档父任务。

服务重启时，恢复逻辑检查未终态 attempt：已消失的进程被记录为可恢复中断；仍活跃的进程保留；没有活跃进程的已确认任务重新进入可调度队列。DSH 的恢复语义不变。

## 安全与兼容性

任务 ID、事件类型、投影字段、重规划分类和副作用策略由共享核心定义。自动重规划仅可替换未完成的 `read_only` 下游节点，不能失效已验证工件或已完成工作，不能扩大原目标，也不能引入 `external_effect`。其他候选计划一律进入待确认状态。

Codex 与 DSH 默认使用不同本地数据目录，避免无意共享运行中的执行权；可通过明确的守护进程配置指向同一数据库，但本次不自动启用该高级场景。

## 验收标准

1. 当前 DSH 单元测试及打包行为不变。
2. Codex 插件清单通过官方本地验证脚本，且仓库 marketplace 可注册该插件。
3. MCP 服务器可以创建、读取、确认、暂停、恢复、改目标、接受/拒绝重规划、归档/恢复任务。
4. 同一事件序列在 DSH 和 Codex 入口下生成一致的共享核心投影。
5. worker 进程没有生命周期 MCP 工具，服务重启后耐久任务的状态可恢复。
6. README 以中文说明 DSH 与 Codex 的安装、数据目录、能力边界和恢复方式。
