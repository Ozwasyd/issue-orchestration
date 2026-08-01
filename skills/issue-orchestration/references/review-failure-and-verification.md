# 独立验证、失败分类与验收

<!-- Shared package authority. -->

本文件是实现者/独立 verifier 数量、验证合同、失败分类、重跑、evidence 复用和验收顺序的唯一详细来源。

## 角色与只读边界

每项修改最多一名实现者和一名独立 behavior verifier。不得为同一修改并行派发第二名实现者或增加评审层。

`test_owner` 的 `behavior-verification` phase 只审查指定 issue、已填充的闭环 prompt、实际 diff、测试与局部 evidence 投影，不接收状态根路径或完整 DAG，也不得读取或修改完整 DAG、ledger、槽位、锁或恢复指纹。它必须使用 `stage-model-pool.v2` 的 fresh read-only route，只报告会阻止当前验收组交付的 blocker；每条必须包含：

- 准确路径或产物；
- 可复核的事实依据；
- 被违反的验收条件；
- 最小必要修正。

没有 blocker 时明确返回 `no delivery blocker`。不得修改代码、扩大范围、启动额外 agent、重复完整验收或提出纯偏好型风格意见。UI 的 `system-design-dispute` 由独立 `ui_system_adjudicator` 只读裁决；不得让 behavior verifier 或 implementer 代替该 authority。

当前 Codex 会把父 turn 的实时 sandbox 重新应用到 child，因此 custom-agent 文件中的 `sandbox_mode = "read-only"` 只是默认值，不能单独证明只读。调用 behavior verifier、UX verifier 或 UI adjudicator 前必须把父 turn 设为 read-only，使用非 full-history fork，并在 child rollout 或等价元数据中核验实际 `sandbox_policy` 为 `read-only`。若当前 surface 不能建立并核验该边界，不运行 verifier/adjudicator，也不声称已独立只读验收。

## Blocker 回路

每项修改只调用一次全量 independent verifier（UI dispute 另按 policy 调用一次 adjudicator）。blocker 由原实现者修复；根代理只复验 blocker 指向的路径、验收条件和受影响检查。

只有修复重新触及安全、公开契约或架构边界时，才允许再次全量 verification，并记录触发事实。普通修复不得增加第二 verifier 或重复整套验收。

每次确认实现缺陷或 verifier blocker 并回派原实现者时，根代理递增 DAG 节点的 `reworkCount`。该计数不属于 routing input，也不得自动升档；只有冻结 policy 允许的结构化 blocker receipt 才能生成 route-reclassification。其他失败类别不得伪装成返工，也不得触发或重置该计数。

## 先分类再修改

任何失败先归为一类，分类完成前不得修改：

| 类别 | 判据 | 唯一处理 owner |
| --- | --- | --- |
| 实现 | 当前实现违反已确认需求或产生真实回归 | 原实现者；形成闭环返工节点并留在当前验收组 |
| 测试/基线 | 测试、fixture 或已失真的预期本身错误 | 对应测试/基线 owner |
| 环境 | 工具、服务、权限、资源或外部状态阻止有效执行 | 环境 owner；先明确修复环境 |
| 调用 | 命令、参数、cwd、输入或调用方式无效 | 调用者；只修正调用方式 |

禁止以放宽阈值、刷新正确基线、删除/弱化测试或重复执行掩盖失败。

## 执行 ledger 与重跑

由根代理把验证执行记录到 [`dag-and-scheduling.md`](dag-and-scheduling.md) 已验证状态根中 DAG `runtimeFiles.ledger` 指向的唯一 ledger；不得另建仓库内 ignored ledger。执行键是：

```text
不可变 source SHA + 环境指纹 + 规范化 cwd/命令/参数
```

同一执行键最多运行一次。只有以下变化之一有直接证据时允许重跑，并记录旧键、新键、触发原因和影响步骤：

1. 源码变化；
2. 测试或基线 owner 已修正；
3. 环境已明确修复；
4. 上次调用方式被证明无效。

“再试一次”、时间经过、未分类失败或希望得到成功结果都不是合法原因。

## Evidence 与 artifact 复用

artifact 内容或 fingerprint 未变，且 candidate verification 对当前 source、环境和验收条件仍有效时，必须复用。只失效并重跑受影响步骤；不得无理由重建完整 package、Fresh 或 consumer fixture。

复用记录至少绑定 artifact/fingerprint、candidate verification、source SHA、环境、原命令和仍成立的验收条件。仓库现有 test matrix、receipt、package candidate 或 artifact cache 是产品证据的权威来源；本文件不重新定义其 fingerprint 算法。

## 验收顺序与完成复核

先运行直接覆盖改动的 focused/低成本检查，再扩大到验收组要求的高成本步骤。高成本 build、Fresh、consumer、visual 或性能检查在候选基线稳定后运行，避免被后续修改淘汰；一旦验收组全部必需检查通过，立即进入交付，不等待无关节点。

根代理逐项对照原始 issue、当前代码事实、闭环 prompt 和实际 evidence。subagent 自述、状态汇报、历史 evidence、mock 或文件存在本身不能证明完成。
