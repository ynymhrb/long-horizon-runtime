# 发布文章大纲（中文首发，英文改编）

> 定位：**技术经验帖 / 架构解析**，不是广告帖。读者 star 的是"学到了东西，并且这个工具正好解决我的问题"。
> 中英各写一版：中文投掘金/V2EX/知乎；英文改写成 Show HN + Reddit + dev.to。

## 标题候选（结果导向，非技术堆砌）

中文：
1. 《我把 DeepSeek Harness 变成了能跑几小时、断点续跑的长任务框架》
2. 《AI 任务跑到一半会话断了怎么办：给 DeepSeek Harness 装上"任务内存"》
3. 《从"翻聊天记录找回进度"到"任务原地续跑"：一个 DSH 长任务插件的设计》

英文：
1. "I gave DeepSeek Harness durable long-horizon tasks: plan → confirm → resume after your session dies"
2. "Losing agent runs to context limits? We made DeepSeek Harness tasks resumable across sessions"
3. "Designing a resumable task runtime for DeepSeek Harness (everything-is-a-plugin)"

## 文章结构

### 1. 开篇：具体地写痛（前 200 字决定是否读完）
用一个真实场景开头：某次长任务跑到一半，会话超时/关错窗口，上下文全没，重来一遍花了 N 小时。
要点：**量化损失**（重跑成本、token 成本、时间），读者立刻代入。

### 2. 为什么做成"插件"
呼应 DeepSeek Harness 的 everything-is-a-plugin 卖点：不改框架源码，纯插件装配（Cordis patch）。
顺便建立信任：插件边界 = 只动自己该动的东西。

### 3. 核心设计决策（每节配一张图/一个代码/一段数据）
建议按此顺序讲，都是真实实现：

1. **计划-确认门禁**：默认先出计划、等你确认再执行（`defaultPlanningMode: require_confirmation`）——为什么"先给人一个反悔点"对长任务至关重要。
2. **任务即 DAG**：子任务 + 依赖 + 状态，Task Area 可视化——执行不再是聊天记录里的黑盒。
3. **持久化与事件溯源**：SQLite 追加式事件日志，目标修订、决策、产物全部可审计——重跑/恢复有据可依。
4. **跨会话暂停/恢复**：任务与某一段对话解耦；恢复时只续未完成步骤。可给租约/超时策略（idle 5 分钟、单步最长、整任务墙钟上限、自动重试 2 次）的真实数字。
5. **重规划的安全策略**（工程严谨度加分项）：只有"本地、只读、不碰已完成工作"的替换才自动应用；涉及外部效应或已完成工作的变更必须人工确认。
6. **子代理授权围栏**：planner/执行子代理不持有任务生命周期工具——讲清"让 AI 拆任务但不让它自己改任务规则"的边界。
7. **Web 侧 Task Area**：状态图例、可读时间线、修改目标、跳转会话。

> 写作时每节配 1 张真实截图；把 `docs/decisions/`、`docs/specs/` 里的设计动机翻译成"为什么这么做"的故事，不要贴内部术语表。

### 4. 真实运行案例（发布前跑一个，收集数字）
- 任务示例、计划步数、实际执行时长、中断/恢复次数、最终结果。
- 一张"恢复前 vs 恢复后"的对比截图最有说服力。

### 5. 局限与取舍（主动说，反而涨信任）
- 单任务串行（`maxConcurrentTasks: 1`）、执行成本取决于所用模型、哪些场景不适合（快速问答不值得建任务）。

### 6. 怎么用（最短路径）
```bash
dsh plugin --profile web add github:ynymhrb/long-horizon-runtime#master
dsh web
```
一句话使用示例（沿用 README 的 RAG 例子）。

### 7. 收尾 CTA
- 中文：`如果你也丢过 AI 长任务的进度，欢迎试用并给仓库 ⭐，Issues 里聊聊你的长任务场景。`
- 英文：`If you've ever lost a long agent run — try it and ⭐; tell us about your long-task use case in Issues.`

## 分发执行单

### 中文渠道（同一天或 1–2 天内）
- [ ] **掘金**（首发）：申请流量扶持/创作者等级；文末挂项目链接。
- [ ] **V2EX** → 分享创造：标题用"我做了个 X"，正文第一人称讲痛点，低调给链接，回复里答问题。
- [ ] **知乎**：专栏发全文，再发一个"如何让 AI 稳定执行长任务？"问题下的回答（贴文章精华 + 链接）。
- [ ] **B 站/视频号**：demo 视频 + 简介带链接（与 demo-storyboard.md 配套）。
- [ ] 技术微信群/朋友圈：只发一句话钩子 + 链接，不刷屏。

### 英文渠道（错开 1–2 天，吸收中文反馈再改）
- [ ] **Hacker News（Show HN）**：美东时间 07:00–09:00 发；标题结果导向（用上面英文候选 1 的风格）；第一帖内容=痛点+demo GIF+安装一行命令。
- [ ] **Reddit**：r/LocalLLaMA（+ r/programming 若契合）。第一人称经验帖，标题不提"my plugin is great"，正文讲问题与做法，结尾轻量带链接；先读版规，避免纯广告被踩。
- [ ] **X/Twitter**：demo 动图 + 一句话 + 话题 `#DeepSeekHarness #AIagents #opensource`，@ 相关生态账号。
- [ ] **dev.to** 转载英文全文。

### 生态收录（发布日前后做，长期流量）
- [ ] 向 `fendouai/awesome-deepseek-harness` 提 PR 收录（README 里已注明收录标准）。
- [ ] 查找其他 DSH 插件/awesome 列表，逐个提 PR。
- [ ] 若 DeepSeek Harness 官方文档有插件案例/Community 区，申请收录。

### 发布日纪律
- 发布当天**每一条评论都回复**（HN 前 2 小时决定生死）。
- 备好 2–3 张"对比表/架构图/运行数据"随时补发。
- 别在多平台刷同一段话——平台算法和社区都讨厌复制粘贴。
