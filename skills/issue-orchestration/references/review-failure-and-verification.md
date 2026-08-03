# 独立验证、失败分类与验收

<!-- Shared package authority. -->

本文件是实现者/独立 verifier 数量、验证合同、失败分类、重跑、evidence 复用和验收顺序的唯一详细来源。

## 角色与 observe-only 边界

每个 executable slice 同时最多一名 writer；完整 stage 达到 `candidate-green` 后最多一名独立 behavior verifier。不得为同一 slice 并行派发第二名 writer 或增加评审层。

`test-owner` 的 `behavior-verification` phase 只审查指定 issue、verified work plan、全部有序 slice terminal receipts、compiled prompt digests、实际 diff、测试与局部 evidence 投影，不接收状态根路径或完整 DAG，也不得读取或修改完整 DAG、ledger、槽位、锁或恢复指纹。它必须使用 `stage-model-pool.v3` 的 fresh observe-only route，并在结果被接收前通过 mutation postcondition；只报告会阻止当前验收组交付的 blocker；每条必须包含：

- 准确路径或产物；
- 可复核的事实依据；
- 被违反的验收条件；
- 最小必要修正。

没有 blocker 时明确返回 `no delivery blocker`。不得修改代码、扩大范围、启动额外 agent、重复完整验收或提出纯偏好型风格意见。UI 的 `system-design-dispute` 由独立 `ui-system-adjudicator` 只读裁决；不得让 behavior verifier 或 implementer 代替该 authority。

`trusted-owner-repositories` mode 中 Codex V2 child 可以继承 Root 的 `danger-full-access`。因此 verifier/adjudicator 的 `observe-only` 是语义 execution class，不是 machine-enforced sandbox 声明。调用 behavior verifier、UX verifier 或 UI adjudicator 时必须使用 fresh non-full-history context，记录实际 effective permission profile、inheritance 和 `permissionGuarantee=contract-and-postcondition`，并在接收结果前验证必需 mutation postcondition。任何源码、control-plane state 或 remote mutation 都使结果及 independent evidence 失效。只有未来 runtime 真实提供并观察到严格边界时，才可以单独记录 `permissionGuarantee=machine-enforced`；这不会改变 stage 的 observe-only 语义。

## Blocker 回路

每项修改只调用一次全量 independent verifier（UI dispute 另按 policy 调用一次 adjudicator）。blocker 由原实现者修复；根代理只复验 blocker 指向的路径、验收条件和受影响检查。

Verifier blocker、修复提交或 candidate identity 任一改变都会立即使旧
behavior receipt 失效。Root 先用 `compileVerificationImpactPlan` 确定受影响
requirement、路径与命令，再启动 fresh-context candidate B verifier；它不是
第二评审层，也不得继承 candidate A 对话。未受影响且仍绑定当前 source 的
evidence 可复用，受影响边界必须重验。普通修复不得增加第二 reviewer 或重复
不受影响的整套验收。

每次独立 verifier 确认实现缺陷或 blocker 并回派原 writer 时，根代理递增 DAG 节点的 `reworkCount`。该计数不属于 routing input，也不得自动升档；只有冻结 policy 允许的结构化 blocker receipt 才能生成 route-reclassification。Writer 自身的 invocation、environment、runtime capability、first action、output、checkpoint、receipt 或 retry failure 都不是 verifier 返工，不得触发或重置该计数。

## Slice terminal gate

Writer 返回的自然语言说明不能改变 stage。Root 必须先校验 `issue-orchestration.stage-progress-checkpoint.v1` 和 `issue-orchestration.slice-terminal-receipt.v1`，再调用 `evaluateSliceTerminalGate` 对照 verified plan 重算：

- receipt 必须绑定同一 run/repository/issue/node/base/epoch/worktree、plan/slice、compiled prompt、route、complete checkpoint、changed paths 和 command evidence；
- receipts 必须按 `orderedSlices` 无遗漏、无重复、无乱序出现；
- 非最终 slice 的唯一成功转换是 `writer-stage.slice-completed → next-slice`，且 `candidateEligible=false`、`stageComplete=false`；
- 只有 final slice 与此前全部 terminal receipts 同时有效，才产生 `writer-stage.completed → candidate-green`。

Partial checkpoint、continuation receipt、单个 diff、命令成功或 agent 自述都不能绕过该 gate。Continuation 必须从已封存 cursor 的 `nextRequiredAction` 继续；不能重读完整 issue、重启调查或用新 attempt 冒充进度恢复。

## Stage-generic failure、breaker 与 material retry

`evaluateWriterStageObservation` 对 `test-contract`、`implementation`、`ui-implementation`、`documentation` 和 `landing-conflict-resolution` 使用同一失败状态机。Writer observation 必须绑定 plan/slice/compiled prompt/route identity；机器按事实产生以下 stage-generic terminal event：

- `writer-stage.invocation-failed`
- `writer-stage.environment-failed`
- `writer-stage.runtime-capability-missing`
- `writer-stage.first-action-not-executed`
- `writer-stage.output-missing`
- `writer-stage.checkpoint-missing`
- `writer-stage.receipt-rejected`

任何必需输出缺失，尤其“agent 已返回但没有产物”的 output-missing，都必须签发 `issue-orchestration.writer-stage-failure-receipt.v1`、进入 terminal 并打开 breaker。它既不计 implementation rework，也不触发 human decision；Root 不得把它改写成 verifier blocker、`reworkCount` 或人工接管。

唯一例外是 runtime-created 且完全空白的 transient rollout：没有 tool call、
message、artifact、checkpoint 或可恢复 cursor，且 request/route/slice/contract
identity 完全未变时，`transient-rollout-retry.mjs` 可授权同 contract 恰好一次
fresh retry。首次空 rollout 必须封存 classification 与 authorization；第二次
空 rollout、任何部分输出、身份漂移或非 transient failure 都立即 terminal，
不能再试。

`writer-stage.output-missing` 本身不是 profile upgrade evidence。先在 `slice-not-executable`、`compiled-prompt-incomplete`、`runtime invocation/capability failure`、`sandbox/cwd/worktree/permission mismatch`、`agent-first-action-not-executed` 与 `profile-capability-mismatch` 中由机器分类。任何 failure、retry 或 rework 都不能推进 profile，runtime 不导出 reroute API。只有 independently revised semantic classification 或 executable slice 才能作为新 dispatch 输入重新调用 canonical compiler；它必须引用旧 route/failure/candidate receipt、breaker reset 和 retry authorization，且新 candidate identity 不复用旧 receipt。

Breaker 的语义 identity 绑定 repository/issue/node/base/epoch、plan/slice/route、stage role/phase、event type 与 evidence，而不依赖可替换的 shell identity。改变 attempt id、agent id、prompt 措辞、worktree、slice id、等待时间或重复同一命令都不能清除 breaker。

只有 `authorizeWriterStageRetry` 验证 `issue-orchestration.writer-stage-retry-authorization.v1` 后才能重派。授权必须引用 prior failure receipt 和 `semanticFailureDigest`，并包含 `slice-revision`、`compiled-prompt-revision`、`runtime-revision` 或 `capability-revision` 中至少一种实质修订：previous/current digest 必须不同，`changedRequirementIds` 非空且有可重算的 revision evidence digest。只改措辞或 identity 不是 material change；未变化失败保持 breaker open。

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
