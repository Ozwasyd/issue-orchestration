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

永久运行时不能把完整 issue 正文、标题或 Root 手写任务直接派发给 writer。每个 writer stage 必须依次取得经过验证的 `issue-orchestration.stage-work-plan.v1`、当前 `issue-orchestration.executable-slice.v1` 和由该 slice 确定性编译的 `issue-orchestration.compiled-dispatch-prompt.v1`。对应 API、机器 checkpoint、continuation、slice terminal gate、stage-generic failure 与 retry 规则以 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md) 和 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 为准。

共享 package 永久只发布七个角色：`code-implementer`、`dag-creator-updater`、`documentation-writer`、`test-owner`、`ui-system-adjudicator`、`ui-ux-implementer` 和 `ux-acceptance-verifier`。Landing conflict slice 继续由 `code-implementer` 或 `ui-ux-implementer` 执行；不得新增 `landing-owner` 或其它第八个 dispatch role。 所有 actor-bearing proposal/receipt 都必须绑定通过验证的 `issue-orchestration.execution-route-decision.v2` 与 runtime execution binding；除 canonical routing policy/compiler 外，任何脚本不得把 actor 自声明的 model、profile 或 effort 当作独立授权来源。

某次修复 issue 对 Sol Ultra 或其它实现者的直接授权只适用于该次实现批次，不能写入永久 `stage-model-pool.v3`、routing、dispatch 或 fallback policy。临时 bootstrap runner、旧 run id、receipt、breaker 和 failure evidence只能作为冻结测试保管、恢复、审计 fixture 与最终退役对象；它们不是永久 dispatcher，也不能阻止当前获授权实现者修改永久源码或成为兼容入口。

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

根代理负责 DAG、调用确定性 compiler、槽位调度、完成度复核、最终验收、本地整合、提交、推送、issue 评论与关闭；Root 不编写测试、实现或文档，不手写或修改 compiled prompt。实现者和独立 verifier/adjudicator 不执行远端交付。

1. **建立或刷新 DAG**：按 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md) 验证仓库外状态根与 runtime trust binding，读取或重建当前范围 DAG；由 fresh observe-only `dag-creator-updater` 生成完整 requirement inventory、acceptance contract 与 semantic proposal，Root 只接收有界投影并机械纳入通过 validator 与 mutation postcondition 的结果。
2. **选择 stage**：继续按同一 reference 的 ready、槽位、长任务、模型和 terminal 规则选择下一动作；完整 issue 不能成为 writer dispatch unit。
3. **编译 work plan 与 slice**：读取 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md)，先由 fresh observe-only semantic agent 提议 slices，再由确定性 validator 校验完整性、ownership、拓扑、路径、动作和 capacity；Root 不得提议或修改 slice。首次 test writer 严格按 acceptance contract → planning request/receipt → mutation postcondition → resource/lease → frozen contract → verified slice/prompt → writer 的冷启动顺序执行。
4. **编译 execution route**：只对当前 verified slice 调用唯一 `canonical-route-cell-compiler`，一次性把 stage semantics 与 observed execution shape 编译为 `execution-shape-classification.v1 → stage-capability-requirement.v2 → execution-route-decision.v2`。每个 route cell 要求一个 exact profile；checked-in reviewed routing assumptions 只验证该 exact profile，不声称 runtime observation，也不提供 selector authority。Root、成本、失败次数和 telemetry 都不能选模。
5. **编译并派发 prompt**：从 verified plan/slice确定性生成 compiled prompt，先验证 prompt digest和route decision binding，再调用对应 writer role。保留的 task template只能呈现 compiler输出，不得由 Root手填、删减验收或修改 prompt。
6. **收口 slice**：writer必须在阈值前返回机器可验证 checkpoint、合法 continuation或 terminal receipt。非最终 slice只进入`next-slice`；只有完整 plan的有序 terminal receipts全部通过，stage才可进入`candidate-green`。
7. **分类与独立验证**：按 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 处理 writer failure、在线 watchdog、一次性空 rollout retry 和 verifier blocker。完整 stage candidate 稳定后，按 fresh observe-only 条件调用 `test-owner` 的 behavior-verification phase；blocker 修复或 candidate identity 改变后旧 receipt 立即失效，必须先编译 impact plan 再由 fresh-context candidate B verifier 重验受影响边界，不增加第二评审层。
8. **立即交付验收组**：一组全部通过后，读取 [`references/group-delivery.md`](references/group-delivery.md)，按其中的 CI evidence 分类与关闭门禁完成提交、主分支推送、远端核验和 issue 关闭；dry-run 时停在明确的首个有副作用动作之前。
9. **回写运行态并继续**：由根代理在已验证的仓库外状态根追加 verified plan/slice/shape/capability/route/prompt/checkpoint/terminal/failure/retry事件，更新 DAG、证据键、槽位和恢复指纹，然后回到步骤 1；不得靠记忆补全尚未读取的阶段规则。
10. **最终 quiescence**：全部目标节点已远端关闭后，以新的 observe-only machine inventory 调用 `scripts/quiescence.mjs`。必须同时枚举 issue/stage/attempt/group/actor、work plan/slice/checkpoint/continuation/breaker/route、Git/resource/process/port/Docker/lock/lease/slot、landing/source mapping/human retention、Skill/DAG/telemetry 与 bootstrap retirement。只有可重算的 `issue-orchestration.quiescence-receipt.v1` 为 `quiescent` 且 `violations=[]` 才能结束整轮。该 gate 只观察；发现残留后返回 violation，不能自行清理、恢复 continuation、重路由、landing 或选择人工决定。

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
