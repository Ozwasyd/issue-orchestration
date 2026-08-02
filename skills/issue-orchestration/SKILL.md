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

本 Skill 固定请求 15 个 subagent 槽位，根调度线程不计入这 15 个槽位；实际环境不足时按 DAG reference 收缩，不要求每次 goal 重复声明槽位。

开始前确认两个仓库路径、共同启动工作区、默认分支、HEAD、dirty state、可写权限和远端身份。随后完整读取 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md)，先通过其中的仓库外状态根与 DAG 启动门禁。门禁通过前不得修改产品代码、创建 worktree 或派发 subagent；所有调度运行态由根代理独占写入已验证的仓库外状态根。

## 权威边界

每次进入一个仓库或 worktree，都重新发现并遵守从项目根到当前目录最近的 `AGENTS.md` / override 指令链，再读取该仓库与本次修改相关的 current 文档、代码和测试。仓库事实与产品边界以这些来源为准；本 Skill 只拥有 issue 调度语义。表面冲突时先区分“调度策略”和“仓库事实”，不得互相覆盖或猜测。

## 永久 writer 合同与临时修复授权

永久运行时不能把完整 issue 正文、标题或 Root 手写任务直接派发给 writer。每个 writer stage 必须依次取得经过验证的 `issue-orchestration.stage-work-plan.v1`、当前 `issue-orchestration.executable-slice.v1` 和由该 slice 确定性编译的 `issue-orchestration.compiled-dispatch-prompt.v1`。对应 API、机器 checkpoint、continuation、slice terminal gate、stage-generic failure 与 retry 规则以 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md) 和 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 为准。

共享 package 永久只发布七个角色：`code-implementer`、`dag-creator-updater`、`documentation-writer`、`test-owner`、`ui-system-adjudicator`、`ui-ux-implementer` 和 `ux-acceptance-verifier`。Landing conflict slice 继续由 `code-implementer` 或 `ui-ux-implementer` 执行；不得新增 `landing-owner` 或其它第八个 dispatch role。

某次修复 issue 对 Sol Ultra 或其它实现者的直接授权只适用于该次实现批次，不能写入永久 `stage-model-pool.v2`、routing、dispatch 或 fallback policy。临时 bootstrap runner、旧 run id、receipt、breaker 和 failure evidence只能作为冻结测试保管、恢复、审计 fixture 与最终退役对象；它们不是永久 dispatcher，也不能阻止当前获授权实现者修改永久源码或成为兼容入口。

## 总循环

根代理负责 DAG、调用确定性 compiler、槽位调度、完成度复核、最终验收、本地整合、提交、推送、issue 评论与关闭；Root 不编写测试、实现或文档，不手写或修改 compiled prompt。实现者和独立 verifier/adjudicator 不执行远端交付。

1. **建立或刷新 DAG**：按 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md) 验证仓库外状态根，读取或重建当前范围 DAG，对照远端与仓库事实通过一致性门禁，再重算受影响节点。
2. **选择 stage**：继续按同一 reference 的 ready、槽位、长任务、模型和 terminal 规则选择下一动作；完整 issue 不能成为 writer dispatch unit。
3. **编译 work plan 与 slice**：读取 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md)，完成调查与必要的最小真实探针；由 canonical compiler覆盖全部 acceptance、生成有序 slices，并选择所有 prerequisite terminal receipt 已完成的下一 slice。
4. **编译并派发 prompt**：从 verified plan/slice确定性生成 compiled prompt，先验证 prompt digest和route binding，再调用对应 writer role。保留的 task template只能呈现 compiler输出，不得由 Root手填、删减验收或修改 prompt。
5. **收口 slice**：writer必须在阈值前返回机器可验证 checkpoint、合法 continuation或 terminal receipt。非最终 slice只进入`next-slice`；只有完整 plan的有序 terminal receipts全部通过，stage才可进入`candidate-green`。
6. **分类与独立验证**：按 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md) 处理 writer failure/breaker/retry 和 verifier blocker。完整 stage candidate 稳定后，按 fresh read-only 条件调用 `test-owner` 的 behavior-verification phase；UI system dispute 先调用 `ui-system-adjudicator`，UX 路径再调用 `ux-acceptance-verifier`。
7. **立即交付验收组**：一组全部通过后，读取 [`references/group-delivery.md`](references/group-delivery.md)，按其中的 CI evidence 分类与关闭门禁完成提交、主分支推送、远端核验和 issue 关闭；dry-run 时停在明确的首个有副作用动作之前。
8. **回写运行态并继续**：由根代理在已验证的仓库外状态根追加 verified plan/slice/prompt/checkpoint/terminal/failure/retry事件，更新 DAG、证据键、槽位和恢复指纹，然后回到步骤 1；不得靠记忆补全尚未读取的阶段规则。

## 状态与停止

节点沿 `discovered → test-contracting → test-contract-frozen → implementing-self-testing → candidate-green → independent-verifying → behavior-green → (ux-acceptance → ux-accepted) → documenting → documentation-green → delivery-ready → delivering → cleaning → closed` 推进。每个 writer stage 内部另按 verified plan 的 slice 顺序推进；partial checkpoint、continuation或非最终 slice terminal receipt都不能冒充 stage green。UI 节点必须经过 UX acceptance，cleanup green 由机器 resource verifier 签发。失败、返工、阻塞和 terminal 的合法转换由对应 reference 定义，不得跳过证据条件。

仅当以下条件同时成立才结束：

- 所有本地可完成 issue 均已交付并经远端核验为 closed；
- DAG 没有 ready、running、independent-verifying、delivery-ready 或 delivering 节点；
- 其余 open issues 均按 DAG reference 以直接证据进入合法 terminal 状态。

连续 60 分钟没有有效产出时，不结束；执行 DAG reference 的恢复动作。任何能力、权限、仓库事实或 prompt 信息不足以安全继续时，保留节点状态和证据，报告缺口及恢复条件，不自行降级。
