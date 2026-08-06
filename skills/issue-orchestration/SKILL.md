---
schema: issue-orchestration.markdown-document.v1
name: issue-orchestration
description: Use only to coordinate multiple open issues in caller-supplied target repositories when they require a dependency DAG, sustained parallel dispatch, or overlapping acceptance groups. Do not use for one independent issue or ordinary single-task work.
---

<!-- Authoritative source: https://github.com/Ozwasyd/issue-orchestration -->

# Issue Orchestration

把根代理保留为调度者，把详细规则按阶段加载。此 Skill 只定义入口、循环和状态路由，不重定义任何目标仓库的产品协议、设计、安全、测试、文档生命周期或发布事实。

## Runtime discovery canary

当且仅当输入包含 `ISSUE_ORCHESTRATION_DISCOVERY_CANARY` 时，不进入下方适用边界和总循环。完整读取
[`references/runtime-discovery-canary.md`](references/runtime-discovery-canary.md)，严格执行其中的只读探针并立即退出。该入口只证明 Codex 从标准安装位置实际发现并读取了本 Skill，不授予调度、仓库读取、写入、联网或 agent 权限。

## 适用边界

仅在输入同时给出以下内容时启动：

- 两个或更多 open issues，或一个会持续产生依赖节点、返工节点或重合验收组的 issue 集合；
- 一个或多个由 caller 明确提供的目标仓库范围。

单一、独立且无需持续调度的普通任务不适用。即使被显式调用，也应退出本 Skill，改用仓库常规工作流。

本 Skill 请求的并发度只能来自运行时实际可观察的 V2 capacity；根调度线程不计入 agent 槽位。固定槽位数字、旧 bootstrap capacity 或节点字段都没有并发授权。

永久无人值守运行使用 `trusted-owner-repositories` mode：Root 必须实际观测为 `approval_policy=never`、`danger-full-access` 和 Codex V2，children 可以继承同一 effective permission profile。该 mode 不声称 machine-enforced child read-only isolation；角色边界来自 execution class、lease、receipt 与必需的 mutation postcondition。策略不内置任何目标仓库 allowlist；只有 caller 为本轮明确提供且远端身份与本地 checkout 一致的 operator-owned trusted repositories 可进入。远端身份无法解析、caller identity 不匹配或运行中 origin/path identity 漂移都在派发前 fail closed。该 threat model 不适用于 third-party、untrusted 或 multi-tenant workload。`strict-machine-isolation` 作为 disabled future mode 单独表示，不能被静默映射到 trusted mode。

任何仓库、远端 issue、scope、DAG、状态根、lease 或 actor 操作之前，launcher/runtime integration 必须先产生 `runtime-startup-observation.v1`，再由 `runtime-startup-attestation.v1` 确定性验证 actual model、effort、V2 backend、trust mode、sandbox、approval、inheritance、capacity、package/policy digest 与 invocation/session。Root 手写 metadata、环境变量回显、prompt JSON 和历史 receipt 都不是 observation authority；缺失或不可观察字段直接终止该 parent invocation。正常 `root-scheduler:scheduling` 只允许 `terra-low`。`terra-medium` 只属于全新 parent 的 `root-scheduler:recovery-takeover`，且必须绑定 machine takeover authorization、handoff、old-root fencing 与新 authority epoch；boolean recovery flag 或 medium child 不能升级 low root。

attestation verified 后才确认 caller 本轮明确提供的目标仓库路径、启动工作区、默认分支、HEAD、dirty state、可写权限和远端身份，并用 `runtime-trust-policy.mjs` 生成和复核绑定同一 attestation/invocation 的 `runtime-trust-binding.v1`。随后完整读取 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md)。每个 member/node 按 `lifecycle-state-machine.mjs` 的当前 state 独立通过唯一 `validateDagStartupGate`，并取得 `dag-startup-gate-receipt.v2`；fresh `discovered` node 不要求未来收据。DAG gate 只消费 startup attestation，不接受旧 `rootRuntime.metadata`、`dag.v2`、`semantic-graph.v1`、全局 `testContractDigest` 或全局 `stageReceipts`。所有调度运行态由根代理独占写入已验证的仓库外状态根。

所有 stage 都以 `root-control`、`observe-only` 或 `leased-writer` 表示语义 authority；logical profile selection 不得消费 sandbox/permission label。实际 permission、inheritance 与 guarantee 只进入独立 runtime execution binding。每个 accepted stage result 必须通过 `stage-runtime-guard.mjs` 的 machine pre/post snapshot 和 mutation postcondition：observe-only 的 protected repository/state-root/remote delta 必须为空；leased-writer 的所有 delta 必须落在当前 lease/slice allowlist 内。任一 violation 都使 actor result 失效，不能被 Root metadata 转成合法 writer 或 independent evidence。

运行状态必须使用两级账本：run-level scope、batch、delivery 与 cleanup effect 只写 `control-ledger.jsonl`；每个 node 的 stage event、checkpoint、failure、candidate 与 verification evidence 只写该 node 的 `nodes/<node-key>/event-ledger.jsonl`。Root 只消费逐 ledger replay 验证后的 `node-index.v1` 与 `aggregate-runtime-projection.v1`，不得信任 caller-supplied projection JSON 或把普通 writer event 写入 run control ledger。

远端 mutation 仅 `root-control` 可执行，且每个动作都必须先由 `remote-mutation-authority.mjs` 验证 current delivery-control receipt、intended mutation、expected pre-state、expiry 与 startup/runtime binding，再验证 post-state。child credential/tool 可用性不授予远端 authority；child mutation 必须按 policy 失效并在不可逆、共享或不可归因时 run-fatal。

未知复杂 control-plane anomaly 必须先穷尽 deterministic handlers，再由 `control-plane-advisor.mjs` 按唯一 `control.unknown-complex-advisor` route cell 对同一 failure digest 最多启动一次 fresh、`sol-max`、observe-only Advisor。不存在 strongest-first 搜索或后续 profile ladder。Advisor 只接收 bounded projection，只能输出冻结 action vocabulary 内的 proposal；passed mutation postcondition 后才能编译 recovery plan。`terra-low` Root 只能逐字节、按序机械执行该 plan，不得修改、重排或绕过任何 gate。只有 Root 本身失效、不可用或必须迁移 parent invocation 时，`root-takeover-supervisor.mjs` 才可在 machine authorization、bounded handoff、完整 old-root fencing 和唯一 root-control lease 成立后启动新 `terra-medium` parent；失败 takeover terminalizes，不能自动 medium 重启或回滚 low。

## 权威边界

每次进入一个仓库或 worktree，都重新发现并遵守从项目根到当前目录最近的 `AGENTS.md` / override 指令链，再读取该仓库与本次修改相关的 current 文档、代码和测试。仓库事实与产品边界以这些来源为准；本 Skill 只拥有 issue 调度语义。表面冲突时先区分“调度策略”和“仓库事实”，不得互相覆盖或猜测。

## 永久 writer 合同与临时修复授权

永久 actor 只消费当前 `issue-orchestration.actor-context-envelope.v1`，不接收完整 issue、Root 手写任务或旧 broad-prompt 格式。plan、slice、compiled prompt、route、lease、checkpoint、failure、retry 与 terminal 仍由 production compiler/executor/validator 机械拥有；角色说明不再复述这些流程，也不能替代它们。对应机器接口以 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md) 和 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 为准。

共享 package 永久只发布七个角色：`code-implementer`、`dag-creator-updater`、`documentation-writer`、`test-owner`、`ui-system-adjudicator`、`ui-ux-implementer` 和 `ux-acceptance-verifier`。Landing conflict slice 继续由 `code-implementer` 或 `ui-ux-implementer` 执行；不得新增 `landing-owner` 或其它第八个 dispatch role。 所有 actor-bearing proposal/receipt 都必须绑定通过验证的 `issue-orchestration.execution-route-decision.v2` 与 runtime execution binding；除 canonical routing policy/compiler 外，任何脚本不得把 actor 自声明的 model、profile 或 effort 当作独立授权来源。

每个 actor-bearing action 在 runtime preparation 前必须由 `actor-context-envelope.mjs` 确定性编译 `issue-orchestration.actor-context-envelope.v1`。包络只包含当前角色/阶段的不可变身份、相关验收项、当前 slice/candidate/verification evidence、适用 AGENTS 指令、typed output interface 与受限 content-addressed source references；完整 ledger/DAG/projection、无关节点、未来阶段历史、Root 摘要、秘密和 writer 对话均不得进入。writer 包络还必须由 `repository-evidence-pack.mjs` 在 actor 启动前确定性编译 `issue-orchestration.repository-evidence-pack.v1`：只观察当前 slice 已声明的路径、命令、适用指令、内容寻址文件/搜索结果、绑定 first-failure 的输出和 scoped Git 状态；不得扫描整仓、联网或执行语义判断。大块 source 只能经绑定 referenceId、role、phase、node、path 与 digest 的只读 resolver 渐进读取。该包络不授予 route、retry、mutation、checkpoint、candidate、verification、delivery、cleanup 或 terminal authority；各 production executor 仍必须复核 action/role/phase binding 并通过原有 machine validators。

每个已验证 actor envelope 还必须由 `actor-prompt-cache-identity.mjs` 编译为有序的 stable prefix 与 volatile suffix。stable prefix 只包含精简角色边界、role/phase、envelope/output interface 版本及 package/policy/agent 指令摘要；run、node、repository、action、route、slice、candidate、checkpoint、lease、当前证据与 repository evidence pack 必须留在 volatile suffix。完整 prompt 与 `issue-orchestration.actor-prompt-cache-identity.v1` 绑定两个 section 的顺序和摘要；支持 prompt caching 的 adapter 可消费 stable prefix/cache identity，不支持者必须执行逐字相同的完整 prompt。provider cache hit、token 与状态只能写入 diagnostic telemetry，不能影响 route、retry、admission、terminal 或任何 lifecycle authority。

某次修复 issue 对 Sol Ultra 或其它实现者的直接授权只适用于该次实现批次，不能写入永久 `stage-model-pool.v4`、routing、dispatch 或 fallback policy。临时 bootstrap runner、旧 run id、receipt、breaker 和 failure evidence只能作为冻结测试保管、恢复、审计 fixture 与最终退役对象；它们不是永久 dispatcher，也不能阻止当前获授权实现者修改永久源码或成为兼容入口。

## 本地付费模型池资格诊断

`node scripts/model-pool-qualification.mjs` 只是在仓库外输出诊断收据的显式本地工具。它要求 live flag、精确 profile/scenario allowlist、invocation cap、token cap、美元预算、operator-supplied pricing file 与仓库外 output path 全部存在；CI、GitHub Actions、安装、构建、普通测试、永久 E2E 和 live target canary 永远不得引用或启动它。每个 profile 只能在无 remote 的一次性本地仓库上消费字节相同的冻结场景，Codex 必须使用 `workspace-write`、关闭网络，并回报可验证的 effective runtime、token、tool、elapsed time、checkpoint、accepted/rejected、recovery 与 cost。缺失 accounting、越界 mutation、remote/network/tool 调用、部分矩阵或任一 cap 超限都只能生成 failure evidence，不能生成 complete receipt。

该命令及 `issue-orchestration.model-qualification-receipt.v1` 永久为 `diagnosticAuthority=none`、`automaticPolicyMutation=false`；不得自动写 model pool、routing/fallback、issue、PR、仓库或 lifecycle authority。详细合同见 [`references/model-pool-qualification.md`](references/model-pool-qualification.md)。

## 永久组合 E2E

`scripts/permanent-e2e.mjs` 是永久 package 的组合验收 owner；它不是
bootstrap dispatcher。单一入口为：

```bash
ISSUE_ORCHESTRATION_E2E_LIVE=1 node --test --test-concurrency=1 tests/tools/issue-orchestration/*.test.mjs
```

该入口从 `tests/tools/issue-orchestration/` 的固定 lane 读取永久 package
能力，启动真实 child test processes 和真实 Codex V2 rollouts，执行真实
Git/worktree/landing、五种隔离 cwd 安装发现、当前仓 baseline、
首次 writer 冷启动、一次性空 rollout 恢复、在线 watchdog、候选变更后
fresh verifier、UI 双 Skills、human gate、真实 mutation controls 与 live
machine quiescence collector，并产生严格的
`issue-orchestration.permanent-e2e-receipt.v2`。最终 receipt 只能由
`reducePermanentE2EEvidence` 归约全部绑定同一 package/policy/source/
run-family/candidate 的 child receipts；布尔结论、mutation 数量和
quiescence 结果不得硬编码。Fixture 模式只能签
`fixture-verified/productionReady=false`。
Live 模式只复读当前 package 仓默认分支远端 SHA；不查询或依赖任何
产品仓 checkout、issue 或默认分支。child rollout
若没有实际测试、退出非零或只有自然语言报告均失败。
临时 runner 只能作为 audit-only 历史证据，不能参与这条永久 E2E
制造绿灯。

## 总循环

根代理只负责建立经过 startup/trust 验证的 run genesis、调用唯一生产调度入口 `scripts/lifecycle-production-dispatcher.mjs#runLifecycleProductionDispatcher`，以及在该入口返回已重放的 `run.terminalized` 后执行仓库外的最终报告。Root 不选择 action、stage、handler、profile 或执行顺序，不直接调用 action-family executor，不编写测试、实现或文档，也不手写或修改 compiled prompt。实现者和独立 verifier/adjudicator 不执行远端交付。

1. **建立或刷新 DAG**：按 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md) 验证仓库外状态根与 runtime trust binding，读取或重建当前范围 DAG；远端 adapter 只有显式声明 delta-v1、绑定上一份 verified selector/snapshot/cursor，并返回 authoritative `unchanged` 或完整 changed-member facts 时才能省略全量传输。`unchanged` 逐字复用 selector receipt 且不追加 scope event；任何 partial、stale、wrong-authority 或无法观察的 delta 都 fail closed，旧 adapter 保持完整观察。fresh observe-only `dag-creator-updater` 只提交 issue-specific discovery/classification 与 requirement-classification proposal。Root 只能接受或拒绝 typed proposal；requirement inventory、acceptance contract 与 `node-discovered-receipt.v1` 必须由确定性 compiler 从 selector、remote facts、accepted proposal 和完整规范来源覆盖生成。
2. **进入唯一生产 dispatcher**：Root 只把 canonical ledger handle、startup authority 和受约束 runtime context provider 交给 `runLifecycleProductionDispatcher`。dispatcher 每轮自行复核 startup/trust/package/policy authority，重放 control/node ledgers，执行 live scope/base freshness，调用唯一 lifecycle compiler，逐字验证 action set，并通过冻结的穷尽映射交给对应 production owner。同一 dispatcher wave 内，所有绑定相同 repository/base/head/authority 的 action 必须共享一个 `repository-base-observation-epoch.v1`；跨仓观察可并发，但 control-ledger head、scope、base、repository identity 或 authority epoch 任一变化都会使旧 epoch 失效。actor wave 必须从同一 verified projection 和 action set 进行准备：provider 支持 `prepareBatch` 时只调用一次，否则对旧 `prepare` 并发调用；batch API 只接收当前 action 的受限 node projection 与精确 repository-base epoch binding。所有 accepted preparation 的 node-scoped attempt、slot、runtime、lease、resource 与 action identity 必须在任何 dispatch append 或 actor spawn 前完整验证，随后一次性落盘 dispatch batch 再并发执行；单项准备失败只能剔除该 action。任一结果到达后立即录入、释放精确槽位、重放并补位。Root 不得读取 action set 后自行 switch、调用 action-family executor、等待整批完成、复制 projection JSON，或用 prose summary 替代 verified input。
   可选性能诊断只能通过独立时钟的 `performanceTelemetry` 旁路生成 `issue-orchestration.dispatcher-performance-receipt.v1`。该收据仅为 `diagnostic-only`，不得写入 canonical ledger，也不得参与 action、route、retry、mutation、terminal 或 correctness 判断；关闭诊断后 canonical 事件序列与状态必须逐字不变。
3. **由 dispatcher 推进 test-contract 冷启动**：读取 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md)，对新节点只调用公共 `advanceTestContractColdStart`。该 API 依次验证 selector/remote facts 与 accepted semantic proposal，确定性编译 requirement inventory、acceptance contract 和 `node-discovered-receipt.v1`，请求 fresh observe-only `test-owner:test-contract-planning` 一次性返回 planning receipt、dispatch investigation 与 slice proposal，再确定性校验 slice/work plan/prompt。Writer 路由必须按 pending canonical selection → exclusive lease/resource → runtime-bound final route → `stage.contract-frozen` → distinct fresh writer dispatch 推进。Root 不得手拼 receipt、plan、slice、route、prompt、资源 authority 或 frozen history，也不得把完整 issue body 传给 writer。
4. **由 production owner 编译 execution route**：只对当前 verified slice 调用唯一 `canonical-route-cell-compiler`，一次性把 stage semantics 与 observed execution shape 编译为 `execution-shape-classification.v1 → stage-capability-requirement.v2 → execution-route-decision.v2`。每个 route cell 要求一个 exact profile；checked-in reviewed routing assumptions 只验证该 exact profile，不声称 runtime observation，也不提供 selector authority。Root、成本、失败次数和 telemetry 都不能选模。
5. **由 dispatcher 编译 actor 输入**：从 verified projection/action、plan/slice 与适用指令确定性生成 actor context envelope，并在 writer action 中预计算 stage-scoped repository evidence pack；模型只判断当前责任并返回 envelope 声明的 typed output。Root 不得手填、扩展或降级该输入。
6. **由机器收口 slice**：production executor 独立观察 actor 输出、文件系统、Git、命令与运行时结果，并按既有 checkpoint/continuation/terminal validator 推进；模型叙述本身不能使 stage 变绿。
7. **由 dispatcher 重放并继续**：每个 action 的结果必须通过专用 recorder 写入对应 control/node ledger；dispatcher 只可使用 `multi-node-state.mjs` 的进程内 verified replay/projection cache 复用已验证组件。命中键必须完整绑定 state root、run、startup/trust/package/policy authority、control-ledger head、node index digest 与所有 active node ledger heads；路径、mtime、对象引用、调用者 projection 或时间戳都没有命中权威。Node append 只替换该 node 的 verified component，control append 只重放 control 并复用 registration 未变的 node components；进程重启、authority/key 漂移、corruption suspicion、explicit audit 与最终 quiescence 必须完整磁盘 replay。缓存是可丢弃 derived state，不得持久化第二套 projection 或参与 action、route、retry、mutation、terminal authority。对同一 verified compiler input，dispatcher 只能通过 `lifecycle-run-loop.mjs` 的进程内 action-set cache 复用已经完整校验的 `lifecycle-action-set.v1`；键必须精确绑定 selector receipt、remote snapshot receipt、semantic graph、aggregate projection、route policy、runtime capability 与 lifecycle authority 七个 digest，任何 ledger/scope/base/policy/capability/authority 变化都必须重新编译。调用者 action set、时间戳、对象身份、action 数量或局部 node summary 都不能命中缓存。dispatcher 随后只从唯一 compiler 取得下一 action set。actor promise 终态只能先进入进程内 ready queue；至少一个结果就绪后，dispatcher 必须立即 drain 同一 ready window 中全部已完成项，不等待未完成 actor，并按稳定 `dispatchId` 通过一次 shared post-wave base observation 与 `recordLifecycleDispatchedActionResultBatch` 入账。合法结果使用原有 node/control event，base/identity stale 或 malformed 结果只能写 control-only `outcome=excluded` settlement；只有 `lifecycle-executor-failure-admission.mjs` 穷举接受、完整绑定 persisted dispatch 且内部 stage result 通过既有专用 validator 的 `actor-stage-failure.v1` 才能作为 node-local `outcome=failed` 成员进入同一 batch。错误类名、message、prose、半截 receipt、未知异常、ledger/authority/forbidden-mutation 或 unattributable control-plane failure 均保持 run-fatal。任一项不得依赖 wall-clock completion order。ready queue 与异常对象不得持久化，进程重启只能从 canonical active dispatches 恢复。对同一 verified action set 中由 compiler 明确声明互相独立的 `executionClass=machine` action，dispatcher 必须使用 bounded local worker pool 和 `recordLifecycleCurrentMachineActionResultBatch` 一批执行与入账；当前仅 `compile-acceptance-contract` 具备该资格。worker 上限不得超过 runtime-observed `maxConcurrentThreadsPerSession`，不得消耗 actor slot、lease、Git、remote 或 model authority。全部 node event 必须在首次 append 前完成验证，并按稳定 `actionDigest` 写入；malformed machine result 只能排除自身，未知 action、ledger corruption、authority drift 或 append ambiguity 仍整批 fail closed。一个 stage、节点、验收组或仓库完成都不能停止循环；普通 `idle` 只能交给 quiescence finalization owner，不能直接返回 Root。
8. **分类与独立验证**：按 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 处理 writer failure、在线 watchdog、一次性空 rollout retry 和 verifier blocker。完整 stage candidate 稳定后，按 fresh observe-only 条件调用 `test-owner` 的 behavior-verification phase；blocker 修复或 candidate identity 改变后旧 receipt 立即失效，必须先编译 impact plan 再由 fresh-context candidate B verifier 重验受影响边界，不增加第二评审层。
9. **立即交付验收组**：一组全部通过后，读取 [`references/group-delivery.md`](references/group-delivery.md)，按其中的 CI evidence 分类与关闭门禁完成提交、主分支推送、远端核验和 issue 关闭；dry-run 时停在明确的首个有副作用动作之前。
10. **由 dispatcher 回写运行态并继续**：只有对应 production recorder 可以在已验证的仓库外状态根追加 verified plan/slice/shape/capability/route/prompt/checkpoint/terminal/failure/retry 事件。dispatcher 从重放结果更新 DAG、证据键、槽位和恢复指纹并继续循环；Root 不得直接追加、修补或重签任何 lifecycle event。
11. **最终 quiescence**：compiler 产生 canonical `idle` 后，dispatcher 只能调用 `scripts/lifecycle-quiescence-finalizer.mjs`。finalizer 重新解析 selector/remote facts，采集新的 observe-only machine inventory，并调用纯 `scripts/quiescence.mjs`。必须同时枚举 issue/stage/attempt/group/actor、work plan/slice/checkpoint/continuation/breaker/route、Git/resource/process/port/Docker/lock/lease/slot、landing/source mapping/human retention、Skill/DAG/telemetry 与 bootstrap retirement。只有可重算的 `issue-orchestration.quiescence-receipt.v1` 为 `quiescent` 且 `violations=[]` 才能结束整轮。该 gate 只观察；发现残留后返回 violation，不能自行清理、恢复 continuation、重路由、landing 或选择人工决定。

Worktree 与 child branch 不走通用目录/ref 删除。必须由
`scripts/git-resource-cleanup.mjs` 按
`active → frozen → inventoried → candidate-disposition-proven → actors-and-processes-stopped → worktree-removed → local-ref-retired|quarantined → lease-and-slot-released → post-cleanup-verified`
完整推进。Merge ancestry 只允许 `branch -d`；squash/rebase/cherry-pick
只有 exact candidate-to-landing mapping 后才能 `branch -D`；未映射提交、
staged/dirty/untracked 内容必须先保存 quarantine ref、patch、index 与
untracked manifests。旧 `resource-lifecycle.mjs` 只能消费最终机器回执，
不能自行删除 Git 资源或提前释放 lease/slot。

## 状态与停止

节点沿 `discovered → test-contracting → test-contract-frozen → implementing-self-testing → candidate-green → independent-verifying → behavior-green → (ux-acceptance → ux-accepted) → documenting → documentation-green → delivery-ready → delivering → cleaning → closed` 推进。每个 writer stage 内部另按 verified plan 的 slice 顺序推进；partial checkpoint、continuation或非最终 slice terminal receipt都不能冒充 stage green。UI 节点必须经过 UX acceptance，cleanup green 由机器 resource verifier 签发。失败、返工、阻塞和 terminal 的合法转换由对应 reference 定义，不得跳过证据条件。

仅当以下条件同时成立才结束：

- 所有本地可完成 issue 均已交付并经远端核验为 closed；
- DAG 没有 ready、running、independent-verifying、delivery-ready 或 delivering 节点；
- 其余 open issues 均按 DAG reference 以直接证据进入合法 terminal 状态。
- 新鲜 machine inventory 生成并验证了与当前远端、baseline、允许保留集合和全部依赖 receipts 绑定的 quiescence receipt；active actor、attempt/group、slice/continuation、landing/human wait、ownerless/dirty/quarantine 与 bootstrap fallback 计数均为零。

连续 60 分钟没有有效产出时，不结束；执行 DAG reference 的恢复动作。任何能力、权限、仓库事实或 prompt 信息不足以安全继续时，保留节点状态和证据，报告缺口及恢复条件，不自行降级。
