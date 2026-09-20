# 目标条件因果优势评测

该目录原型化评测长程软件工程 Agent 在关键决策点上是否选择了提高终局目标效用的行动，而非只完成眼前子任务；只有接入真实分支执行和独立 oracle 后，才可据此得出因果结论。

## 确定性运行

```powershell
pnpm run experiment:decision-quality -- run-fixture validation/decision-quality/fixtures/diagnose-before-edit.json --method full --evidence-root .tmp/decision-quality
```

可用方法为 `local_progress`、`goal_value`、`causal_advantage` 和 `full`。结果目录包含候选行动评分、由 fixture 声明的合成潜在结果、中文报告与哈希清单；它验证评测链路，不构成真实代码干预实验。

确定性 fixture 的 `potential_outcome` 仅用于生成实验真值；评分器输入会剥离该字段，避免真值泄漏。

## 真实模型运行

真实模型驱动器只从 `DEEPSEEK_API_KEY` 环境变量读取密钥，且不会把密钥写入请求体、证据或日志。它当前只是结构化调用与 usage 门禁适配器；`run-live` 编排、操作系统级隔离、真实 oracle 和试验套件尚未实现，因此不得把它用于无人工监督的真实实验。

不要提交真实运行的原始模型响应、密钥、临时工作区或 `.tmp` 证据目录。只提交脱敏后的聚合摘要、场景版本和证据哈希。
