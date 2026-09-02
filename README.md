# Long Horizon Runtime for DeepSeek Harness

中文 | [English](README.en.md)

> 让 DeepSeek Harness 中跨回合、可中断的多步骤工作，拥有可审计的持久状态。

[是什么](#是什么) · [核心能力](#核心能力) · [快速开始](#快速开始) · [在普通对话中使用](#在普通对话中使用) · [安全与证据](#安全与证据) · [开发](#开发)

`@deepseek-ai/dsh-long-task-runtime` 为 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) 提供可持久化、可检查的长任务能力，无需修改 DSH 源码。任务状态写入本机 SQLite 事件日志；DSH 对话和子代理只是执行界面，而非状态真相来源。

## 是什么

长任务最容易在计划变化、会话中断或结果需要验证时失去上下文。Long Horizon Runtime 把可安全重规划、可视化任务状态和可恢复的执行尝试带入普通 DSH 对话。

| 你获得什么 | 长任务中发生什么 | 证据与边界 |
| --- | --- | --- |
| 安全重规划 | 修改目标或验证失败会留下带修订号的决策与持久证据；只有符合策略的重规划才会自动应用。 | 仅限边界明确、未完成的 `read_only` 工作；外部副作用和已完成工作必须确认。 |
| 可检查进度 | Task Cockpit 用依赖 DAG 和持续显示的状态图例呈现任务进展。 | 下图是当前产品的已完成 DAG 与图例；正式 UI 场景只链接，不宣称已通过。 |
| 持久恢复 | 中断会记录为持久执行尝试；允许的 `read_only` 重试或恢复会生成独立尝试记录。 | 中断本身会被记录；重试与恢复仍受任务安全策略约束。 |

![已完成的 Task Cockpit DAG：七个任务、依赖边和持续状态图例](docs/assets/readme/task-dag-completed.png)

这张图展示当前 Task Cockpit 的已完成 DAG 视图。需要确认的重规划以及归档/恢复界面，暂以可复现的契约表示：[LT-UI-002 任务检查](scenarios/ui/LT-UI-002.yaml)、[LT-UI-003 重规划提案](scenarios/ui/LT-UI-003.yaml)、[LT-UI-005 归档与恢复](scenarios/ui/LT-UI-005.yaml)。这些正式 UI 流程在这里不被报告为已通过。

## 核心能力

- 稳定的 `lt_` 任务 ID，可在另一段对话继续。
- 版本化 DAG 计划、依赖调度、重试、已验证产物与持久执行尝试。
- 每次尝试最长五小时的墙钟租约，以及紧凑的子代理心跳。
- Web Task Area：任务列表、状态 DAG、事件时间线、目标编辑、暂停/继续、归档/恢复与会话跳转。
- 对话内的当前任务条，可快速看到已绑定长任务的状态。
- 目标版本和修订栅栏，避免过期写入覆盖新状态。
- 策略门控的自动重规划，以及与父任务生命周期工具隔离的规划/执行子代理。
- 标准对话路由：不需要一个面向用户的“长任务模式”。

## 快速开始

### 前提条件

- 兼容的 DeepSeek Harness：启用 Web profile，并具备进程内 `spawn` 子代理提供方。
- 通过 Git 安装时，`PATH` 中有 Node.js `^22.19.0` 或 `>=24.0.0` 与 pnpm。
- 已配置可进行普通对话和子代理工作的 DSH 模型/提供方。

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:ynymhrb/long-horizon-runtime#master
dsh web
```

仓库包含已编译的 `dist/`，Git 安装无需构建，也不依赖本机的 DeepSeek Harness 检出。`#master` 是本项目支持的发布分支。

### 安装本地检出

在仓库根目录执行：

```bash
dsh plugin --profile web add .
dsh web
```

### 安装已构建 tarball

```bash
pnpm pack
dsh plugin --profile web add ./deepseek-ai-dsh-long-task-runtime-<version>.tgz
dsh web
```

插件包自带 `cordis.patch.yml`，默认配置会随安装写入。安装或使用时不应修改 DSH 源码。

## 在普通对话中使用

默认路由模式是 `advisory`：当工作需要计划、多个依赖阶段、子代理、任务产物、暂停/恢复、审计记录或跨会话继续时，模型可选择创建持久任务。简短的单会话进度跟踪仍可使用 DSH 原生目标；一次性问答不会创建任务。

### 创建待确认的长任务

```text
研究 RAG 召回率的影响因素；拆成可验证的子任务，先给我计划，等我确认再执行。
```

模型应创建一个 `AWAITING_CONFIRMATION` 状态的持久任务，返回 `lt_…` ID，并在 Task Area 显示它。确认前不会开始工作。

### 确认、暂停或修改目标

```text
确认执行 lt_abc123。
暂停 lt_abc123。
把 lt_abc123 的原始目标改为“只研究中文技术资料”，原因是范围收窄。
```

目标修改会保留历史，并形成可审查的替代计划。对话停止会暂停持久任务；它不是失败证据，也不会触发自动重规划。

### 在另一段对话继续

```text
继续任务 lt_abc123，先告诉我当前状态和未完成节点。
```

新对话可以绑定同一任务，并在任务条和 Task Area 中聚焦这份持久记录。

### 路由配置

```yaml
routingMode: advisory
```

仅在刻意进行机器本地定制时，才在 Web profile 的 `cordis.patch.yml` 中为 `long-task-runtime` 添加：

```yaml
- id: long-task-runtime
  config:
    routingMode: strict
```

`strict` 会从顶层模型回合移除 DSH 原生的 `create_goal`、`get_goal` 与 `update_goal` schema。它不会为每个请求创建任务；它表示模型一旦创建持久目标，就必须使用 Long Horizon Runtime。由于原生轻量目标不再对该 profile 中的模型可用，这是高级部署选项。

## 安全与证据

- 新任务拥有稳定的 `lt_` ID；任务状态、计划、尝试、证据与产物均为追加式或修订式记录。
- 自动重规划绝不会自动应用会扩大范围、触及外部副作用、使已完成工作失效，或停用已验证产物的变更。
- 删除任务会先取消活跃工作，再归档；归档可在 30 天内恢复，之后才会清理。
- 被中断的外部副作用节点会保持受阻状态，直到操作员明确处理其结果。
- 由提供方报告的 LLM 配额重置会暂停受影响任务，而不消耗普通重试次数；主机重启后，Task Area 保留恢复时间，并要求从关联对话继续，而不会自行启动子代理。

[验证手册](docs/superpowers/specs/2026-08-27-long-task-production-validation-handbook.md) 记录了 `30/30 deterministic state/recovery and fault-injection scenarios`。这是确定性场景证据，不是已完成的人工 UI 验收，也不宣称真实 LLM 验证。可复现的修订栅栏安全重规划、中断 `read_only` 恢复、以及验证失败后再进行允许重规划的契约分别为 [LT-STATE-008](scenarios/state-recovery/LT-STATE-008.yaml)、[LT-RECOVERY-003](scenarios/state-recovery/LT-RECOVERY-003.yaml) 和 [LT-FAULT-006](scenarios/fault-injection/LT-FAULT-006.yaml)。这些场景使用本地 fixture doubles 与一次性资源。

## 存储与集成边界

默认 bundle 将数据库存于 DSH Home 的 `long-task-runtime/long-task-runtime.sqlite`，文件产物存于 `long-task-runtime/artifacts`。浏览器端只调用插件 Typert remote API；包以附加方式注入 Task Area 和对话任务条。不修改任何 DSH 应用文件。

导出的插件入口是 `apply(ctx, config)`。它提供 `ctx.longTaskRuntime`，并注册 `long_task_*` 工具；它不会替换 DSH 的 agent loop。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

仓库含有一个配置驱动的单种子 ARIS 证据运行器，用来比较 ARIS 与“ARIS + 本插件”。它不安装任一插件，也不做研究级结论；只记录操作员提供的两条命令实际做了什么。详见 [validation/aris-pilot/README.md](validation/aris-pilot/README.md)。

V5 异构多代理路由等实施路线见 [docs/roadmaps/long-task-runtime-roadmap.md](docs/roadmaps/long-task-runtime-roadmap.md)。
