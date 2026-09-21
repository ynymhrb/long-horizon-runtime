# SWE-bench GCCA 实验集

开发集固定为 SWE-bench Lite 的 10 个实例，golden set 固定为 SWE-bench Verified 的 30 个实例。清单按实例 ID 的公开 SHA-256 排序截断，而不是按模型效果、难度或仓库选择。

每个实例须在官方容器化评测环境中执行。GCCA 适配层必须只从 issue、仓库快照、构建/测试反馈和公开工具输出构造候选行动；不得读取 `patch`、`test_patch` 或隐藏测试。候选行动在同一 `base_commit` 的隔离副本中运行，使用官方 FAIL_TO_PASS/PASS_TO_PASS oracle。

本机预检要求 Docker 可用。当前 Windows 主机未安装 Docker，因此允许完成清单校验与数据下载，但禁止宣称已经执行 SWE-bench 终局 oracle。安装 Docker 后先运行 10 个开发实例，再冻结 prompt、分支策略和预算，最后运行 30 个 golden 实例。
