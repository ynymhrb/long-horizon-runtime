# GitHub 仓库门面配置（粘贴即用）

> 目标：让访问者在 GitHub 列表页、搜索引擎、`dsh plugin add` 场景下 3 秒内看懂"这是什么、给谁用、解决什么"。

## 1. 仓库 Description（设置入口：仓库页 → 右侧 About → 齿轮图标）

建议中英各一份，按你常用的主语言选；描述字段**用英文更利于 GitHub 内搜索和搜索引擎收录**。

英文（推荐主用）：

```
Durable long-horizon task runtime for DeepSeek Harness — plan, confirm, track, and resume AI work across sessions and interruptions.
```

中文备选：

```
DeepSeek Harness 长任务插件：把复杂 AI 工作变成可确认、可跟踪、可断点续跑的任务。
```

## 2. Topics（同上 About 编辑区）

一次全填：

```
deepseek-harness, dsh-plugin, ai-agents, agent-runtime, long-horizon-tasks, task-orchestration, durable-execution, autonomous-agents, cordis, llm
```

> 提示：GitHub Topics 支持聚合页（如 `https://github.com/topics/dsh-plugin`），填上后你的仓库会出现在对应 topic 列表里，带来长尾发现流量。

## 3. README 首屏 star 引导（埋在 tagline 下方、目录上方）

英文版（README.en.md）：

```markdown
> If Long Horizon Runtime has saved one of your agent runs — please ⭐ this repo.
> It helps people who keep losing long AI work find a way to finish it.
```

中文版（README.md）：

```markdown
> 如果这个插件帮你保住过一场长任务，请给仓库点个 ⭐，让更多受"任务中断、进度丢失"困扰的人找到它。
```

放置位置：紧跟现有引言块（`> 把一件很长的事……` / `> Turn a long piece of work……`）之后、目录行之前。两处居中加粗 ⭐ 更醒目。

## 4. 仓库级设置检查清单

- [ ] Settings → General：开启 **Issues**（用来接反馈，活跃信号）
- [ ] Settings → General：开启 **Discussions**（或用 Issues 分类代替）
- [ ] Settings → General：开启 **Projects**（roadmap 可视化，可选）
- [ ] About：填入上方的 Description + Topics
- [ ] About：Website 可先留空，等 demo 视频上线后填视频/演示链接
- [ ] 确认根目录 `LICENSE`（MIT）已提交 —— 已生成草稿，见仓库根 `LICENSE`
- [ ] 确认默认分支发布说明（Releases）存在，README 徽章区可挂 release 徽章

## 5. 与官方关系的表述（建议在 README 顶部加一句，消除信任疑虑）

由于仓库在个人账号 `ynymhrb` 下、包名却是 `@deepseek-ai/dsh-long-task-runtime`，访问者会不确定是否官方。二选一，说明白：

- 社区独立插件：`非 DeepSeek 官方出品，由社区独立开发与维护。`
- 官方生态插件（若属实）：`DeepSeek Harness 官方生态插件。`

对应英文：`Community-maintained plugin, not an official DeepSeek project.` /
`An official plugin for the DeepSeek Harness ecosystem.`

> 若不写，海外开发者默认按"非官方但想蹭官方名头"理解，反而伤信任。
