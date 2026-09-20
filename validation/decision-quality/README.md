# 目标条件因果优势评测

该目录评测长程软件工程 Agent 在关键决策点上是否选择了真正提高终局目标效用的行动，而非只完成眼前子任务。

## 确定性运行

```powershell
pnpm run experiment:decision-quality -- run-fixture validation/decision-quality/fixtures/diagnose-before-edit.json --method full --evidence-root .tmp/decision-quality
```

可用方法为 `local_progress`、`goal_value`、`causal_advantage` 和 `full`。结果目录包含候选行动评分、隐藏 fixture 的反事实结果、中文报告与哈希清单。

确定性 fixture 的 `potential_outcome` 仅用于生成实验真值；评分器输入会剥离该字段，避免真值泄漏。

## 真实模型运行

真实模型驱动器只从 `DEEPSEEK_API_KEY` 环境变量读取密钥，且不会把密钥写入请求体、证据或日志。真实实验必须先配置一个已轮换的密钥、显式 token 预算、墙钟超时和临时工作区。缺少 usage、超时、限流或非结构化响应时，运行必须标记为 `inconclusive`。

不要提交真实运行的原始模型响应、密钥、临时工作区或 `.tmp` 证据目录。只提交脱敏后的聚合摘要、场景版本和证据哈希。
