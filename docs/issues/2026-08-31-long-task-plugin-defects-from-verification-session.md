---
feature_ids: []
related_features: []
topics: [long-task-runtime, failure-classification, retry, scheduler, execution-adapter, safety-boundary]
doc_kind: defects
created: 2026-08-31
---

# 插件缺陷清单：插件提升验证会话暴露的问题（2026-08-31）

> 状态：**已修复（DEF-01 ~ DEF-10，除 DEF-08 仅提示词级缓解）** | 来源：会话 `session-223d466c`（"插件提升验证"）+ 持久化事件日志
> 范围：仅 long-task-runtime 插件自身缺陷；不讨论该任务能否继续执行。
> 修复提交：见本仓库 git 日志（"fix: classify execution failures and unblock long-task tools"）。

## 0. 修复状态汇总

| 缺陷 | 严重度 | 状态 | 修复要点 |
|---|---|---|---|
| DEF-01 | P0 | ✅ 已修复 | `ExecutionResult.failureKind` 三态（output/infrastructure/interrupted）；基础设施故障不触发 validation_failed 重规划 |
| DEF-02 | P0 | ✅ 已修复 | stopReason 映射为可读摘要并保留子会话 ID；`error` 不再只输出 "DSH child stopped: error" |
| DEF-03 | P1 | ✅ 已修复 | 指数退避（`retryBackoffMs` 默认 1s，上限 60s），`runUntilIdle` 等待退避到期 |
| DEF-04 | P1 | ✅ 已修复 | 工具层非阻塞：confirm/resume/create(auto)/accept_replan 返回即返回，`runtime.startBackground` 后台驱动执行 |
| DEF-05 | P2 | ✅ 已修复 | `onSessionId` 与 settle 结果去重，每个尝试仅 1 条 TaskAttemptSessionRecorded |
| DEF-06 | P2 | ✅ 已修复 | 目标离开 RUNNING 或本轮无派发时不追加 CheckpointCreated |
| DEF-07 | P2 | ✅ 已修复 | `automaticReplanIsSafe` 只比较结构化身份（id/dependsOn/sideEffectClass），忽略 objective 文本 |
| DEF-08 | P0 | ⚠️ 部分 | 执行提示词强制工作区纪律；**子会话沙箱级强制需要 DSH subagent 支持 per-start 工作区（当前 API 无此能力），见 §2 备注** |
| DEF-09 | P1 | ✅ 已修复 | DEF-01 修复后 `autoReplan:true` 仅对真实输出失败触发重规划，默认值无需改动 |
| DEF-10 | P3 | ✅ 已修复 | 规划提示词禁止改写已完成任务；`preserveCompletedTasks` 恢复已完成任务原始 objective |

新增回归测试：`tests/dsh-adapters.spec.ts`（stopReason 分类 3 例）、`tests/runtime.spec.ts`（基础设施耗尽暂停、退避重试、事件去重、过期检查点、文本改写自动应用、后台执行）。

## 1. 背景与证据来源

用户按《long-task production validation handbook》创建任务 `lt_524f7052-8e0d-46d1-8a59-7fedd76ea640`（14 步 DAG），确认执行后：
t01/t02 成功，**t03 连续 3 次尝试全部失败**（每次子会话都死于同一个
`429 AccountQuotaExceeded`，huoshanagent 5 小时配额），运行时将其记为
`ValidationRecorded ok:false, reason: "DSH child stopped: error"` 并生成
"validation_failed"自动重规划提案（修订 2），任务卡在 `AWAITING_CONFIRMATION`；
随后父模型续步也撞 429，turn 以 error 结束，用户未收到任何回执。

证据：
- 主会话记录：`C:\Users\19632\.dsh\sessions\--D-code-long-horizon-runtime--\session-223d466c-2a89-46ea-8780-d568a3835e5b\session.jsonl.zstd`
- t03 三个子会话：`8792fa28-...`（第 1 次，85 步，撞 429）、`2fc1f852-...`（第 2 次）、`3722095c-...`（第 3 次），三者 turn/end 均为 `RATE_LIMIT`(429)
- 事件日志：`long-task-runtime.sqlite`，seq 1417–1488（见附录 A 时间线）
- 越界写入物证：`src/validation/*`、`tests/validation/*`、`dist/validation/*`、`validation/scenarios/*`、`docs/superpowers/validation/*`、`package.json`（新增 `yaml: ^2.9.0`）与 `pnpm-lock.yaml`

## 2. 缺陷清单

严重度：P0 = 必须修（事故根因/安全）｜P1 = 应尽快修｜P2 = 计划修｜P3 = 可选。

---

### DEF-01（P0）基础设施故障被当作"任务输出校验失败"，进而触发自动重规划

**现象（会话证据）**
t03 三次尝试的子会话全部因 429 配额超限终止，但事件流记为三次
`ValidationRecorded ok:false`（校验失败）→ 烧光 `maxAttempts:3` 后 `TaskFailed`
→ `DecisionRecorded{type:automatic_replan, outcome:await_confirmation}`
→ `PlanProposed`(revision 2, trigger.kind=`validation_failed`)。

**违反的规则**
AGENTS.md："does not trigger replanning for a retriable attempt"；"a DSH
conversation-stop signal is an operator interruption, never failure evidence …
pause the goal without retrying or automatic replanning"。

**根因（代码定位）**
- 失败类别只有一档：`ExecutionResult.status: 'succeeded' | 'failed'`（`src/adapters.ts:7`），
  没有"可重试基础设施故障 / 中断"类别。
- 调度器把所有 failed 结果一视同仁走校验失败路径（`src/scheduler.ts:181-211`）。
- `onTerminalFailure` 接线（`src/runtime.ts:27`）→ `requestAutomaticReplan`
  硬编码 `trigger.kind: 'validation_failed'`（`src/runtime.ts:112,120-121`）。

**复现步骤（单测级）**
1. 用 fake execution adapter，`execute()` 恒返回 `{ status:'failed', summary:'429 rate limit' }`；
   任务 `retryPolicy: { maxAttempts: 2 }`；runtime 以 `autoReplan: true` 构造。
2. `scheduler.runRound` 两轮直至任务终态。
3. 断言（当前行为）：出现 `ValidationRecorded{ok:false}`、`TaskFailed`，
   且 `requestAutomaticReplan` 被调用、trigger.kind 为 `validation_failed`。
4. 期望行为：该类故障应记为"可重试基础设施故障"，不消耗重试预算、不触发
   validation_failed 重规划；连续失败后应暂停目标等待人工处理。

---

### DEF-02（P0）子代理失败细节被丢弃，原因只剩 "DSH child stopped: error"

**现象（会话证据）**
三次失败的事件 reason 都是无信息的 `DSH child stopped: error`；真正的
`429 AccountQuotaExceeded` 详情只存在于子会话 finish 事件里，插件未透传，
UI/事件流/LLM 分诊全部拿到不可操作字符串。

**根因（代码定位）**
`src/dsh-adapters.ts:91-93`：`settled.stopReason !== 'completed'` 时
summary 只取 `stopReason`（如 `error`），丢弃 `failure.message` 与其余上下文。

**复现步骤**
1. fake `subagents.start` 返回一个 `run`，其 `result` resolve 为
   `{ stopReason: 'error', output: [] }`（等价于子会话 turn 以 error 结束）。
2. 调用 `createDshExecutionAdapter(...).execute(...)`。
3. 断言（当前行为）：返回 `summary === 'DSH child stopped: error'`，无错误详情。
4. 期望行为：透传底层错误信息（如 429 配额、超时、退出码），并区分类别。

---

### DEF-03（P1）重试无退避，重试预算被可重试故障白白耗尽

**现象（会话证据）**
t03 三次尝试分别于 00:09:35 / 00:10:55 / 00:13:28 开始，配额未恢复时重试必再失败，
`maxAttempts:3` 全部浪费；`TaskRetryScheduled` 与下一次 `TaskAttemptStarted`
之间无任何延迟。

**根因（代码定位）**
`src/scheduler.ts:206` 追加 `TaskRetryScheduled` 后，任务仍为 PENDING，
下一轮 `runRound`（`:57-58`）立即重新派发；无退避/指数退避/抖动。

**复现步骤**
1. fake adapter：前两次 `execute()` 返回 failed，第三次返回 succeeded。
2. 连续调用 `scheduler.runRound` 直至任务终态，记录三个
   `TaskAttemptStarted` 的时间戳。
3. 断言（当前行为）：相邻尝试间隔 < 1s（立即重试）。
4. 期望行为：可重试故障应指数退避（如 1s/2s/4s + 抖动），并/或对
   "基础设施故障"与"输出校验失败"区分重试策略。

---

### DEF-04（P1）confirm / resume / create(auto) 在模型工具调用内同步阻塞整轮

**现象（会话证据）**
`long_task_confirm` 于 23:32:50 调用、00:15:01 才返回（42 分钟），整个第一轮执行
（t01/t02 完成 + t03 三次重试 + 重规划提案生成）都在这一次工具调用内同步完成；
随后父模型续步撞 429，turn 以 error 结束，用户发"1"后 42 分钟零反馈。

**根因（代码定位）**
- `src/tools.ts:97`（confirm）、`:99`（resume）、`:73`（create auto）的 execute
  直接调 `runtime.confirmGoal / resumeGoal / createGoal`。
- `src/runtime.ts:54`（confirmGoal）、`:44`（createGoal）、`:170`（resumeGoal）
  在有 live parent 时调用 `runUntilIdle`（`:228-234`），循环执行直到空闲。
- 结构性根因：子任务派发必须传 live parent（`src/tools.ts:83`、`src/dsh-adapters.ts:123`），
  没有独立后台调度驱动，执行只能发生在模型工具调用期间。

**复现步骤（手动）**
1. 创建 require_confirmation 任务并确认，DAG 中任一步骤耗时 > 数分钟。
2. 观察 `long_task_confirm` 工具调用一直 pending，期间无任何进度事件可被模型读取。
3. 中断父模型（或配额耗尽），本轮执行结果与用户沟通全部丢失。
4. 期望行为：confirm 快速返回任务已 RUNNING，执行在后台推进，模型可轮询
   `long_task_status / long_task_events` 汇报进度。

---

### DEF-05（P2）同一尝试产生重复的 TaskAttemptSessionRecorded

**现象（会话证据）**
事件日志中每个尝试都有两条相同的 `TaskAttemptSessionRecorded`
（seq 1428/1429、1450/1452、1451/1465、1473/1474）。

**根因（代码定位）**
`src/scheduler.ts:160`（`onSessionId` 回调：子会话一创建即记一条）与
`:192`（结果落库时 `result.dshSessionId !== undefined` 再记一条）重复。

**复现步骤**
1. 跑一个成功尝试（子会话正常完成并返回 dshSessionId）。
2. 查询该尝试的 `TaskAttemptSessionRecorded` 事件数量。
3. 断言（当前行为）：数量为 2。
4. 期望行为：每个尝试恰好 1 条（保留 onSessionId 早记路径，落库时去重）。

---

### DEF-06（P2）重规划提案生成后仍追加过期 CheckpointCreated

**现象（会话证据）**
seq 1488：`CheckpointCreated` 的 `readySet:["t03-build-scenario-runner"]` 指向
重规划提案里 PENDING 的任务，且目标状态已是 `AWAITING_CONFIRMATION`，检查点与
提案状态自相矛盾。

**根因（代码定位）**
`src/scheduler.ts:61-73`：`runRound` 在子任务结束后不复查目标状态，照常追加
CheckpointCreated；而 `onTerminalFailure` 此时已把目标移出 RUNNING。

**复现步骤**
1. 目标 RUNNING，某任务终态失败且 `autoReplan:true` 触发提案（goal →
   `AWAITING_CONFIRMATION`）。
2. 观察该轮结束事件。
3. 断言（当前行为）：`PlanProposed` 之后仍追加 `CheckpointCreated`，readySet 为
   旧轮任务。
4. 期望行为：目标非 RUNNING 时不追加检查点（或追加"提案后快照"语义明确的检查点）。

---

### DEF-07（P2）automaticReplanIsSafe 用完整 objective 文本比较已完成任务

**现象（会话证据）**
规划器在修订 2 提案里把 t01/t02 的 objective 追加了"【已完成于 revision 1，
保留成果】"，导致 `replacement.objective !== task.objective`，本可自动应用的安全
重试被判为不安全、进入 `await_confirmation`（`DecisionRecorded{outcome:
await_confirmation}`）。

**根因（代码定位）**
`src/runtime.ts:256-263` `automaticReplanIsSafe`：对 SUCCEEDED 任务比较
`objective` 全字符串；任何文本差异都返回 false。

**复现步骤**
1. `currentTasks` 含 `t1`（state=SUCCEEDED，objective="A"）。
2. `candidate` 含 `t1`（objective="A【已完成】"，其余字段相同）。
3. 断言（当前行为）：`automaticReplanIsSafe` 返回 false → 进入人工确认。
4. 期望行为：仅比较结构化身份（id/dependsOn/sideEffectClass），忽略 objective
   文本差异。

---

### DEF-08（P0）sideEffectClass 只是声明标签，无执行期强制；子代理可越界写源码树

**现象（会话证据）**
约束明确要求"一次性本地工作区、不修改源码"，但子代理实际把 `src/validation/*`
（6 个源文件）、`tests/validation/*`、`dist/validation/*`、`validation/scenarios/*`
写进了插件源码树，并向 `package.json` 添加 `yaml: ^2.9.0`（`pnpm-lock.yaml`
同步变更）。插件自己运行的"验证"违反了它要验证的手册安全边界。

**根因（代码定位）**
- `sideEffectClass` 仅用于恢复分类（`src/scheduler.ts:86-90`）与 UI 展示；
  `workspaceScope` 仅作 API 访问校验（`src/task-api.ts:181-183`），**不约束子会话
  的文件访问**。
- 子会话经 `subagents.start(...)`（`src/dsh-adapters.ts:120-128`）创建，未传入任何
  工作区/沙箱约束，继承父会话沙箱（本会话为 danger-full-access）。
- **DSH API 调查结论**：`SubagentStartRequest` 仅支持
  label/prompt/parent/signal/agentOptions/outputSchema/maxDepth/toolFilter/persona，
  **没有 per-start 的沙箱/工作区选项**；子会话沙箱继承父会话显式 override
  （`packages/subagent/subagent/src/child-agent.ts:179-220`）。子会话级强制需要在
  DSH 侧新增能力，插件侧无法独立实现。

**修复（已提交）**
- 执行提示词（`src/dsh-adapters.ts` `executionPrompt`）新增工作区纪律条款：
  输出只写入会话工作区或一次性临时目录，禁止改动受管源码/配置/依赖清单。
- 完整沙箱强制的 DSH 能力缺口已记录，需在 `@deepseek-ai/dsh-subagent` 提供
  per-start 沙箱/工作区选项后由插件透传。

**复现步骤（手动）**
1. 在 workspace-write 或更高沙箱的会话中创建任务，约束写明"仅一次性工作区"。
2. 观察子代理可自由写入仓库任意路径（本次实例：src/、tests/、package.json）。
3. 断言（当前行为）：无任何执行期拦截，事件流中也无越界告警。
4. 期望行为：子会话按任务声明的 `sideEffectClass`/`workspaceScope` 获得受限
   工作区与沙箱（如临时目录 + read-only 仓库），越界写入被拒绝或至少被审计记录。

---

### DEF-09（P1）默认 autoReplan:true 放大 DEF-01

**根因（代码定位）**
`src/tools.ts:52`：`autoReplan: config.autoReplan ?? true`，部署默认开启
（`cordis.patch.yml` 亦为 `autoReplan: true`）。在 DEF-01 未修复前，任何提供方
故障（限流/超时/中断）都可能自动进入重规划流程；若规划器不改动已完成任务文本，
修订会被**自动应用**，在故障未恢复时必然再次失败。

**复现步骤**
1. 以默认配置（autoReplan 未显式设置）创建任务。
2. 注入一次基础设施类终态失败（见 DEF-01）。
3. 断言（当前行为）：触发自动重规划（DEF-01 分类错误下）。
4. 期望行为：修复 DEF-01 后重规划仅由真实验证失败触发；在修复前考虑将默认值
   改为 false 或要求显式开启。

---

### DEF-10（P3）规划器改写已完成任务的 objective，间接触发不必要的确认门槛

**根因（代码定位）**
`src/dsh-adapters.ts:153` 规划提示词要求"Preserve unaffected completed work when
safe"，但规划器仍改写了已完成任务文本（本会话在 t01/t02 objective 后追加说明），
与 DEF-07 叠加，使简单重试进入人工确认。修复建议：对已完成任务做防改写归一化
（忽略已完成任务的 objective 差异，仅保留其结构化身份），或在提示词中明确
"已完成任务的 objective 禁止改动"。

**复现步骤**
1. 制造一次终态失败触发自动重规划（见 DEF-01/DEF-07）。
2. 观察规划器输出的 candidate 中已完成任务的 objective 是否被改写。
3. 断言（当前行为）：被改写 → 重规划落入人工确认。
4. 期望行为：已完成任务保持原文本，安全重试自动应用。

---

## 3. 修复优先级建议

> 该批次的四批修复已按此顺序执行完毕（2026-08-31，见 §0）。

| 阶段 | 内容 | 涉及文件 |
|---|---|---|
| 第一批（根因） | 失败分类三态化（succeeded / output-failed / infra-failed-or-interrupted）；透传失败详情；重试退避；中断/基础设施故障不触发重规划 | `src/adapters.ts`、`src/dsh-adapters.ts`、`src/scheduler.ts`、`src/runtime.ts` |
| 第二批（架构） | confirm/resume/create(auto) 非阻塞化，执行移出模型工具调用 | `src/tools.ts`、`src/runtime.ts`、`src/scheduler.ts` |
| 第三批（安全） | 子会话工作区/沙箱约束，sideEffectClass 执行期强制与审计 | `src/dsh-adapters.ts`、`src/tools.ts` |
| 第四批（一致性） | 去重 TaskAttemptSessionRecorded；Checkpoint 状态复查；automaticReplanIsSafe 结构化比较 | `src/scheduler.ts`、`src/runtime.ts` |

每项修复须先写聚焦的 Vitest 失败测试（参考既有 `tests/scheduler.spec.ts`、
`tests/runtime.spec.ts`、`tests/dsh-adapters.spec.ts`）。

## 附录 A：会话时间线（UTC，+0800 = 本地）

| 时间 (UTC) | 事件 |
|---|---|
| 15:28:07 | GoalCreated `lt_524f7052`（require_confirmation） |
| 15:30:29 | PlanProposed revision 1（14 任务） |
| 15:32:50 | PlanConfirmed / PlanRevisionApplied；`long_task_confirm` 工具调用开始（同步阻塞） |
| 15:35:57 | t01 SUCCEEDED；t02、t03 派发（并发） |
| 15:57:19 | t02 SUCCEEDED（35 份场景契约，写入 docs/superpowers/validation/） |
| 16:09:35 | t03 尝试 1（`8792fa28`）撞 429 → ValidationRecorded ok:false → 立即重试 |
| 16:10:55 | t03 尝试 2（`2fc1f852`）撞 429 → 立即重试 |
| 16:13:28 | t03 尝试 3（`3722095c`）撞 429 → TaskFailed（预算耗尽） |
| 16:15:01 | DecisionRecorded{automatic_replan, await_confirmation}；PlanProposed revision 2；CheckpointCreated(过期)；`long_task_confirm` 返回（阻塞 42 分钟后） |
| 16:15:02 | 父模型续步撞 429，重试 2 次仍失败，turn 以 error 结束；用户未收到回执 |

## 附录 B：本次事件中确认的越界写入清单（需人工清理）

- `src/validation/{contracts,policy,evidence,runner,scenarios,cli}.ts`
- `tests/validation/{contracts,policy,evidence,runner,cli}.spec.ts`、`helpers.ts`
- `dist/validation/*`
- `validation/scenarios/{state,faults,ui-manual,runner-selftest}.json`
- `docs/superpowers/validation/{t01-handbook-extraction.md, scenarios/**}`
- `package.json`（新增 `dependencies.yaml: ^2.9.0`）、`pnpm-lock.yaml`
