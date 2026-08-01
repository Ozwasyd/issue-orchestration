---
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

## 总循环

根代理负责 DAG、任务裁剪、闭环 prompt、槽位调度、完成度复核、最终验收、本地整合、提交、推送、issue 评论与关闭；实现者和独立 verifier/adjudicator 不执行远端交付。

1. **建立或刷新 DAG**：按 [`references/dag-and-scheduling.md`](references/dag-and-scheduling.md) 验证仓库外状态根，读取或重建当前范围 DAG，对照远端与仓库事实通过一致性门禁，再重算受影响节点。
2. **选择节点**：继续按同一 reference 的 ready、槽位、长任务、模型和 terminal 规则选择下一动作。
3. **准备任务**：读取 [`references/dispatch-and-runtime-probe.md`](references/dispatch-and-runtime-probe.md)；完成调查，必要时运行最小真实探针，再填写 [`templates/subagent-task.md`](templates/subagent-task.md)。
4. **派发实现者**：按 dispatch reference 调用具体 stage role（`code_implementer` 或 `ui_ux_implementer`），使用 `stage-model-pool.v2` routing compiler 产出的 profile。
5. **独立验证**：实现者返回产出后，完整读取 [`references/review-failure-and-verification.md`](references/review-failure-and-verification.md)，按其中的 fresh read-only 条件调用 `test_owner` 的 behavior-verification phase；UI system dispute 先调用 `ui_system_adjudicator`，UX 路径再调用 `ux_acceptance_verifier`。
6. **分类与验证**：按独立验证 reference 分类任何失败、处理 blocker、复用有效 evidence，并从 focused/低成本检查推进到稳定候选所需的高成本检查。
7. **立即交付验收组**：一组全部通过后，读取 [`references/group-delivery.md`](references/group-delivery.md)，按其中的 CI evidence 分类与关闭门禁完成提交、主分支推送、远端核验和 issue 关闭；dry-run 时停在明确的首个有副作用动作之前。
8. **回写运行态并继续**：由根代理在已验证的仓库外状态根更新 DAG、证据键、槽位和恢复指纹，然后回到步骤 1；不得靠记忆补全尚未读取的阶段规则。

## 状态与停止

节点沿 `discovered → test-contracting → test-contract-frozen → implementing-self-testing → candidate-green → independent-verifying → behavior-green → (ux-acceptance → ux-accepted) → documenting → documentation-green → delivery-ready → delivering → cleaning → closed` 推进；UI 节点必须经过 UX acceptance，cleanup green 由机器 resource verifier 签发。失败、返工、阻塞和 terminal 的合法转换由对应 reference 定义，不得跳过证据条件。

仅当以下条件同时成立才结束：

- 所有本地可完成 issue 均已交付并经远端核验为 closed；
- DAG 没有 ready、running、independent-verifying、delivery-ready 或 delivering 节点；
- 其余 open issues 均按 DAG reference 以直接证据进入合法 terminal 状态。

连续 60 分钟没有有效产出时，不结束；执行 DAG reference 的恢复动作。任何能力、权限、仓库事实或 prompt 信息不足以安全继续时，保留节点状态和证据，报告缺口及恢复条件，不自行降级。
