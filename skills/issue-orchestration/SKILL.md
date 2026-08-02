---
schema: fsusblog.markdown-document.v1
name: issue-orchestration
description: Use only to coordinate multiple open FsusBlog/FsusUI issues that require a dependency DAG, sustained parallel dispatch, or overlapping acceptance groups. Do not use for one independent issue or ordinary single-task work.
---

<!-- Authoritative source: tools/codex/issue-orchestration-package -->

# Issue Orchestration

把根代理保留为调度者，把详细规则按阶段加载。此 Skill 只定义入口、循环和状态路由，不重定义 FsusBlog 或 FsusUI 的产品协议、设计、安全、测试、文档生命周期或发布事实。

## 适用边界

仅在输入同时给出以下内容时启动：

- 两个或更多 open issues，或一个会持续产生依赖节点、返工节点或重合验收组的 issue 集合；
- FsusBlog、FsusUI 或两仓的明确范围。

单一、独立且无需持续调度的普通任务不适用。即使被显式调用，也应退出本 Skill，改用仓库常规工作流。

本 Skill 请求的并发度只能来自运行时实际可观察的 V2 capacity；根调度线程不计入 agent 槽位。固定槽位数字、旧 bootstrap capacity 或节点字段都没有并发授权。

开始前确认两个仓库路径、共同启动工作区、默认分支、HEAD、dirty state、可写权限和远端身份。随后完整读取 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md)。每个 member/node 在取得自己的 read-only facts、route、lease、receipt 与 tombstone 投影后独立通过 `dag-startup-gate-receipt.v2`；不存在阻断全局的旧 bootstrap 门。所有调度运行态由根代理独占写入已验证的仓库外状态根。

## 权威边界

每次进入一个仓库或 worktree，都重新发现并遵守从项目根到当前目录最近的 `AGENTS.md` / override 指令链，再读取该仓库与本次修改相关的 current 文档、代码和测试。仓库事实与产品边界以这些来源为准；本 Skill 只拥有 issue 调度语义。表面冲突时先区分“调度策略”和“仓库事实”，不得互相覆盖或猜测。

## 永久 writer 合同与临时修复授权

永久运行时不能把完整 issue 正文、标题或 Root 手写任务直接派发给 writer。每个 writer stage 必须依次取得经过验证的 `issue-orchestration.stage-work-plan.v1`、当前 `issue-orchestration.executable-slice.v1` 和由该 slice 确定性编译的 `issue-orchestration.compiled-dispatch-prompt.v1`。对应 API、机器 checkpoint、continuation、slice terminal gate、stage-generic failure 与 retry 规则以 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md) 和 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 为准。

共享 package 永久只发布七个角色：`code-implementer`、`dag-creator-updater`、`documentation-writer`、`test-owner`、`ui-system-adjudicator`、`ui-ux-implementer` 和 `ux-acceptance-verifier`。Landing conflict slice 继续由 `code-implementer` 或 `ui-ux-implementer` 执行；不得新增 `landing-owner` 或其它第八个 dispatch role。

某次修复 issue 对 Sol Ultra 或其它实现者的直接授权只适用于该次实现批次，不能写入永久 `stage-model-pool.v3`、routing、dispatch 或 fallback policy。临时 bootstrap runner、旧 run id、receipt、breaker 和 failure evidence只能作为冻结测试保管、恢复、审计 fixture 与最终退役对象；它们不是永久 dispatcher，也不能阻止当前获授权实现者修改永久源码或成为兼容入口。

## 永久组合 E2E

`scripts/permanent-e2e.mjs` 是永久 package 的组合验收 owner；它不是
bootstrap dispatcher。单一入口为：

```bash
FSUSBLOG_E2E_LIVE=1 node --test --test-concurrency=1 tests/tools/issue-orchestration/*.test.mjs
```

该入口从 `tests/tools/issue-orchestration/` 的固定 lane 读取永久 package
能力，启动真实 child test processes 和真实 Codex V2 rollouts，执行真实
Git/worktree/landing、五种 cwd 安装发现、跨 FsusBlog/FsusUI baseline、
首次 writer 冷启动、一次性空 rollout 恢复、在线 watchdog、候选变更后
fresh verifier、UI 双 Skills、human gate、真实 mutation controls 与 live
machine quiescence collector，并产生严格的
`issue-orchestration.permanent-e2e-receipt.v2`。最终 receipt 只能由
`reducePermanentE2EEvidence` 归约全部绑定同一 package/policy/source/
run-family/candidate 的 child receipts；布尔结论、mutation 数量和
quiescence 结果不得硬编码。Fixture 模式只能签
`fixture-verified/productionReady=false`。
Live 模式必须复读 GitHub 依赖和两个默认分支远端 SHA；child rollout
若没有实际测试、退出非零或只有自然语言报告均失败。
临时 runner 只能作为 audit-only 历史证据，不能参与这条永久 E2E
制造绿灯。

## 总循环

根代理负责 DAG、调用确定性 compiler、槽位调度、完成度复核、最终验收、本地整合、提交、推送、issue 评论与关闭；Root 不编写测试、实现或文档，不手写或修改 compiled prompt。实现者和独立 verifier/adjudicator 不执行远端交付。

1. **建立或刷新 DAG**：按 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md) 验证仓库外状态根，读取或重建当前范围 DAG；由 fresh read-only `dag-creator-updater` 生成完整 requirement inventory、acceptance contract 与 semantic proposal，Root 只接收有界投影并机械纳入通过 validator 的结果。
2. **选择 stage**：继续按同一 reference 的 ready、槽位、长任务、模型和 terminal 规则选择下一动作；完整 issue 不能成为 writer dispatch unit。
3. **编译 work plan 与 slice**：读取 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md)，先由 fresh read-only semantic agent 提议 slices，再由确定性 validator 校验完整性、ownership、拓扑、路径、动作和 capacity；Root 不得提议或修改 slice。首次 test writer 严格按 acceptance contract → planning request/receipt → resource/lease → frozen contract → verified slice/prompt → writer 的冷启动顺序执行。
4. **编译 execution route**：只对当前 verified slice 重算 `execution-shape-classification.v1 → stage-capability-requirement.v1 → execution-route-decision.v1`。Profile 必须来自唯一 capability matrix 的机器 fixture evidence；Root、成本、失败次数和 telemetry 都不能选模。
5. **编译并派发 prompt**：从 verified plan/slice确定性生成 compiled prompt，先验证 prompt digest和route decision binding，再调用对应 writer role。保留的 task template只能呈现 compiler输出，不得由 Root手填、删减验收或修改 prompt。
6. **收口 slice**：writer必须在阈值前返回机器可验证 checkpoint、合法 continuation或 terminal receipt。非最终 slice只进入`next-slice`；只有完整 plan的有序 terminal receipts全部通过，stage才可进入`candidate-green`。
7. **分类与独立验证**：按 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 处理 writer failure、在线 watchdog、一次性空 rollout retry 和 verifier blocker。完整 stage candidate 稳定后，按 fresh read-only 条件调用 `test-owner` 的 behavior-verification phase；blocker 修复或 candidate identity 改变后旧 receipt 立即失效，必须先编译 impact plan 再由 fresh-context candidate B verifier 重验受影响边界，不增加第二评审层。
8. **立即交付验收组**：一组全部通过后，读取 [`references/group-delivery.md`](references/group-delivery.md)，按其中的 CI evidence 分类与关闭门禁完成提交、主分支推送、远端核验和 issue 关闭；dry-run 时停在明确的首个有副作用动作之前。
9. **回写运行态并继续**：由根代理在已验证的仓库外状态根追加 verified plan/slice/shape/capability/route/prompt/checkpoint/terminal/failure/retry事件，更新 DAG、证据键、槽位和恢复指纹，然后回到步骤 1；不得靠记忆补全尚未读取的阶段规则。
10. **最终 quiescence**：全部目标节点已远端关闭后，以新的 observe-only machine inventory 调用 `scripts/quiescence.mjs`。必须同时枚举 issue/stage/attempt/group/actor、work plan/slice/checkpoint/continuation/breaker/route、Git/resource/process/port/Docker/lock/lease/slot、landing/source mapping/human retention、Skill/DAG/telemetry 与 bootstrap retirement。只有可重算的 `issue-orchestration.quiescence-receipt.v1` 为 `quiescent` 且 `violations=[]` 才能结束整轮。该 gate 只观察；发现残留后返回 violation，不能自行清理、恢复 continuation、重路由、landing 或选择人工决定。

## 状态与停止

节点沿 `discovered → test-contracting → test-contract-frozen → implementing-self-testing → candidate-green → independent-verifying → behavior-green → (ux-acceptance → ux-accepted) → documenting → documentation-green → delivery-ready → delivering → cleaning → closed` 推进。每个 writer stage 内部另按 verified plan 的 slice 顺序推进；partial checkpoint、continuation或非最终 slice terminal receipt都不能冒充 stage green。UI 节点必须经过 UX acceptance，cleanup green 由机器 resource verifier 签发。失败、返工、阻塞和 terminal 的合法转换由对应 reference 定义，不得跳过证据条件。

仅当以下条件同时成立才结束：

- 所有本地可完成 issue 均已交付并经远端核验为 closed；
- DAG 没有 ready、running、independent-verifying、delivery-ready 或 delivering 节点；
- 其余 open issues 均按 DAG reference 以直接证据进入合法 terminal 状态。
- 新鲜 machine inventory 生成并验证了与当前远端、baseline、允许保留集合和全部依赖 receipts 绑定的 quiescence receipt；active actor、attempt/group、slice/continuation、landing/human wait、ownerless/dirty/quarantine 与 bootstrap fallback 计数均为零。

连续 60 分钟没有有效产出时，不结束；执行 DAG reference 的恢复动作。任何能力、权限、仓库事实或 prompt 信息不足以安全继续时，保留节点状态和证据，报告缺口及恢复条件，不自行降级。
