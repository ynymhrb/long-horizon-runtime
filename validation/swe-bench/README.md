# SWE-bench GCCA 实验集

开发集固定为 SWE-bench Lite 的 10 个实例，golden set 固定为 SWE-bench Verified 的 30 个实例。清单按实例 ID 的公开 SHA-256 排序截断，而不是按模型效果、难度或仓库选择。

每个实例须在官方容器化评测环境中执行。GCCA 适配层必须只从 issue、仓库快照、构建/测试反馈和公开工具输出构造候选行动；不得读取 `patch`、`test_patch` 或隐藏测试。候选行动在同一 `base_commit` 的隔离副本中运行，使用官方 FAIL_TO_PASS/PASS_TO_PASS oracle。

本机预检要求 Docker 可用。若 Docker Desktop 未加入当前终端的 `PATH`，调用 `checkSweBenchPreflight` 时必须显式传入 `dockerCommand`；例如本机安装在 `D:\env\DockerDesktop` 时传入 `D:\env\DockerDesktop\resources\bin\docker.exe`。预检失败时，只允许完成清单校验与数据下载，禁止宣称已经执行 SWE-bench 终局 oracle。

## 官方评测执行器

`official-cli-evaluator.mjs` 直接调用官方 `python -m swebench.harness.run_evaluation`。它为每个“实例 × 行动 × 补丁摘要”生成不同的 `run_id`，因为官方 harness 会按 `run_id` 和实例缓存结果；复用标识会把另一候选补丁的旧结果误当成反事实结果。

调用方须提供：

- 使用 Python 3.11 或兼容版本安装的 `swebench`；
- 固定的数据集名称；Lite 使用 `SWE-bench/SWE-bench_Lite`，Verified 使用 `SWE-bench/SWE-bench_Verified`；
- 候选行动的统一 diff 补丁；
- 证据目录。执行器会保存预测 JSONL、官方调用参数、标准输出/错误和官方 `report.json` 引用。

只有 `report.json` 中的 `resolved: true` 才映射为效用 1。进程退出码为零、镜像构建成功或模型自报成功都不是解决证据。首次运行前先对一个开发实例运行官方 `--gold` 校准；校准仅验证环境，不得计入 GCCA 的模型效果或 golden set 统计。
