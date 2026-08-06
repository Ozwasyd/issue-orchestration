# DAG 与调度

<!-- Shared package authority. -->

本文件是仓库外状态根、DAG 启动门禁、issue 图、槽位、难度选型、terminal 与全局完成条件的唯一详细来源。

## 唯一状态根

所有 DAG、执行 ledger、槽位、锁、issue 状态、恢复指纹和临时 evidence 只能位于同一个本机状态根。其规范化真实路径必须与以下保护根完全分离，既不能位于其中，也不能成为其父目录：

- 当前 package authoring source；
- caller 明确提供的每个目标仓库；
- 本次启动工作区；
- `git worktree list --porcelain` 从这些目标仓库发现的每个 worktree。

优先从操作系统用户状态目录或系统临时目录选择本轮独立子目录。禁止使用任一仓库或共同工作区内的 `.tmp`、cache、ignored 子目录；不得新增 ignored fallback、读取旧仓库内状态作为权威，或把本地状态路径写成产品事实。

在创建候选目录或写入任何状态前，运行：

```bash
node .agents/skills/issue-orchestration/scripts/validate-state-root.mjs \
  --candidate <state-root> \
  --repository <target-repository-root> \
  --workspace <launch-workspace>
```

守卫会按输入遍历顺序解析相对路径和 `..`，拒绝 symlink 组件，以最近存在祖先推导不存在尾部的规范路径，并同时核验 Linux mount coordinate、device/inode identity 和实际 Git worktree。对无法证明 backing path 的 FUSE/overlay alias mount 直接拒绝。它不以字符串前缀作为充分证据；无法读取 mount 或 worktree 身份时 fail closed。第一次校验通过后，只能使用输出的 `candidate.canonical` 以 `0700` 权限创建状态根；创建后必须用同一参数复验，复验通过前不得写 DAG。

根代理是完整运行态（ledger、锁、槽位和事件）的唯一写入者。各 stage agent 只接收当前闭环任务、局部 diff 与所需 evidence 投影，不得读取或修改完整 DAG、ledger、锁、槽位或状态根。根代理可以追加已验证的阶段事件，但不得自行生成、删除或修补 completed-prerequisite tombstone；tombstone 只能由 root scheduler 拉起、绑定 `stage-model-pool.v4` semantic-proposal route 的 fresh-context、observe-only DAG updater 提议，经 mutation postcondition 和机器门禁校验后纳入 v2 DAG。


### 两级运行态账本

每个 run 使用 `<state-root>/runs/<run-key>/control-ledger.jsonl` 保存唯一 run-level authority，并使用 `nodes/<node-key>/event-ledger.jsonl` 保存每个节点自己的 stage history。Control ledger 不接受 checkpoint、writer failure、candidate 或 verification event；node ledger 不接受 scope、batch、acceptance-group delivery 或 run terminal effect。每个 node ledger 独立绑定 repository/base/epoch/selector/remote identity，并拥有自己的 sequence、hash chain、`projection.json` 与 `writer-attempts/`。

`node-index.json` 只能登记 replay-verifiable 的 ledger head 和 node projection digest。Root 通过 `multi-node-state.mjs` replay control ledger 和每个 indexed node ledger，生成 `aggregate-runtime-projection.json`；不得把未验证 JSON summary 当作运行态。单节点损坏只 quarantine 该节点，除非 dependency 或 acceptance-group invariant 要求传播 blocker。Push、issue close、delivery completion 与 cleanup finalization 仍由 control ledger exactly-once 序列化。

## Member/node 启动门禁

读取适用指令链并确认两仓路径、远端、默认分支、HEAD 和 dirty state 后，按以下状态机启动：

```text
instructions_loaded
  -> repository_facts_verified
  -> state_root_validated
  -> dag_loaded | dag_missing
  -> remote_reconciled
  -> consistency_passed
  -> dispatch_enabled
```

这条状态机按 member/node 独立运行，不是阻断整个 scope 的全局许可门。唯一可写图合同是 `issue-orchestration.semantic-graph.v2`，唯一生产启动门是 `validateDagStartupGate`；CLI 直接读取同一个 `dag-startup-gate-request.v2` JSON 并调用该函数，不再维护第二套文件探针或旧 DAG validator。

图顶层必须绑定 selector receipt、remote snapshot、scope、semantic input、安装 policy、仓库 base/binding 和规范图摘要。每个 node 必须绑定同一 selector/remote/repository identity、已验证 semantic facts 和一个由共享 `lifecycle-state-machine.mjs` 定义的 lifecycle state。阶段证据只存在于 node 自己的 `receipts` 中，不存在全局 `testContractDigest` 或全局 `stageReceipts`。

启动门按当前 lifecycle state 验证可达证据：

- `discovered`：只允许 selector/remote/repository/semantic-fact bindings，不要求未来阶段收据；
- `acceptance-frozen`：requirement inventory 与 acceptance contract；
- `test-contract-planning`：acceptance chain 加 planning route/attempt；
- `test-contract-frozen`：planning result、slice proposal/validation、work plan、first slice、route、compiled prompt 与 resource acquisition；
- `implementing`：distinct writer dispatch/attempt 与 active write lease；
- `candidate-green`：terminal implementation 与 candidate receipt；
- `behavior-green`：candidate 与 independent behavior receipt；
- 后续 UI、documentation、delivery、cleanup、closure state：只要求其已可产生的完整前序证据。

任何不在当前 state allowlist 内的 future receipt 都以 `dag-gate-premature-receipt` 拒绝。任何已出现的 receipt 都必须通过 schema、规范 digest、member/selector/remote/repository binding、actor 或 deterministic compiler authority、route/runtime/mutation-postcondition 和 predecessor digest chain 验证；只带 member ID 与任意 64-hex 的 candidate/behavior placeholder 无效。

`issue-orchestration.dag.v2`、`issue-orchestration.semantic-graph.v1`、全局 `testContractDigest`、全局 `stageReceipts` 和旧 gate fallback 统一以 `dag-gate-canonical-migration-required` 拒绝，不存在兼容模式。

规范 CLI 只接受一个 request JSON 文件，或从 stdin 读取同一 JSON：

```bash
node .agents/skills/issue-orchestration/scripts/check-dag-gate.mjs \
  <state-root>/dag-startup-gate-request.json
# 或
cat <state-root>/dag-startup-gate-request.json | \
  node .agents/skills/issue-orchestration/scripts/check-dag-gate.mjs
```

CLI stdout 是 `validateDagStartupGate(request)` 的逐字节 JSON 序列化结果。只有 receipt `status=verified` 的 node 才可继续；一个 node 的失败不得伪造为另一个 node 的全局失败或全局成功。

## 运行态图

DAG 至少记录：

- run id、刷新时间、V2 runtime 实际可用槽位及能力证据；
- 每个 caller-supplied 目标仓的绝对路径、默认分支、HEAD、dirty state 与远端身份；
- 每个节点的 issue URL/编号、当前标题、依赖、责任仓、验收组、状态、routing classification、writer、独立 verifier、开始时间；
- 当前 writer stage 的 verified plan digest、有序 slice identities、compiled prompt/checkpoint/continuation/terminal receipt digests，以及 failure/breaker/retry authorization identity；
- 状态根内运行态相对路径、已执行命令的 evidence key、产物 fingerprint、合法重跑原因；
- terminal 类别、直接证据、恢复条件及恢复指纹。

不得提交运行态，也不得把 issue 状态、槽位、锁或临时 evidence 复制到 `AGENTS.md`、current 产品文档或 Skill 入口。

## 刷新与重算

每轮调度先重新读取所选范围的 open issues 及相关评论，再吸收：

1. 远端新出现且属于本次范围的 issue；
2. 执行中由直接证据确认的真实实现缺陷；
3. independent behavior/UX verifier blocker 或验收失败形成的返工节点。

随后重算每个受影响节点的依赖、责任仓、执行顺序和重合验收组。不得把执行期缺陷放在图外处理。责任仓必须来自当前代码、测试、文档和本地 alias 事实，不从 issue 标签或标题猜测。

只有满足全部条件的节点才是 `ready`：

- 当前启动的状态根与 DAG 门禁已经输出 `dispatchEnabled=true`；
- 所有前置依赖已交付，或已有直接证据证明与本节点独立；
- 责任仓、base SHA、修改边界、验收组和难度已确定；
- 当前 writer stage 已有覆盖全部 acceptance/required commands 的 verified work plan，且下一 executable slice 的前置 terminal receipts 完整；
- 不处于未变化的 terminal 状态；
- 没有同一 slice 正在被另一名 writer 处理。


## 确定性 lifecycle action compiler

`lifecycle-transition-compiler.mjs` 是 verified run state 到下一组合法动作的唯一生产 authority。输入只允许 current selector/remote receipts、`semantic-graph.v2`、从 control/node ledgers 重放得到的 `aggregate-runtime-projection.v1`、installed route policy 和 runtime capability binding；caller 提供的 stage state、projection summary、semantic/test/implementation scope、prompt 或自然语言指令一律拒绝。

compiler 返回 canonical `lifecycle-action-set.v1`。所有非 `idle` action 都必须绑定 run/node/repository/issue/base/epoch、selector/remote/graph/aggregate digest、node projection digest、prior ledger head、policy/capability digest，以及当前已验证的 route/plan/slice/prompt/resource/receipt digests。它是纯函数：不得 spawn agent、调用 Git/GitHub、修改文件、选择 canonical routing 之外的模型或充当 daemon。

`lifecycle-production-dispatcher.mjs` 是 action set 到 production owner 的唯一可执行桥梁。dispatcher 固定执行：复核 startup/trust authority → 重放 control/node ledgers → live scope/base freshness → 编译并逐字验证 action set → 按冻结穷尽映射执行 production owner → 通过专用 recorder 写入 verified event → 立即重放、重编译和补位。pre-dispatch wave 对每个唯一 repository 只产生一个机器观察，并让精确匹配的 action 共享该 epoch；post-admission 边界同样按就绪 dispatch 集合去重仓库。epoch 只绑定当前 control-ledger head、repository/base binding、startup authority 和 action/dispatch 集合，不使用 TTL，也不授予 delivery、cleanup、retry、terminal 或 mutation authority。actor attempt 必须在等待结果前落盘 slot/lease/resource/runtime binding；active dispatch 抑制重复派发。Root 不得读取 action set 后自行选择 handler 或直接调用 action-family executor。canonical `idle` 只授权 quiescence finalizer，直到 `run.terminalized` 成功追加并重放才表示整轮终止。

## 工作守恒

存在 `ready` writer stage、已验证的下一 executable slice 且有空闲槽位时，dispatcher 的下一次动作必须派发该 slice；不得以等待、轮询或汇总代替派发。完整 issue、完整 stage 或手写 prompt 不是 dispatch unit。只在没有可执行 slice、没有空闲槽位或需要完成一次不可并行的根代理交付动作时等待。

预计超过 5 分钟的 build、Fresh、consumer、visual 或性能任务启动后，立即返回调度循环，为其他独立 `ready` 节点分配空闲槽位。长任务只占自己的 canonical dispatch 槽位；dispatcher 必须在任一独立结果到达后立即重放并补位，不得等待整批或让根线程只轮询它。

`subagentSlotsEffective` 取运行时实际 V2 capacity、调用者显式上限和环境资源上限三者的最小值。每个 active slice writer、independent verifier/adjudicator 或仍运行的长任务各占一个 agent 槽位。槽位满时才等待最早能改变 DAG 的事件。

## 根调度模型

根调度进程（root scheduler）固定使用 `terra-low`。进入调度循环前先从本轮运行时元数据核验 requested/effective model、reasoning effort 与 multi-agent backend V2；不匹配时分类为调用问题，停止本次父调用并以 recovery receipt 接管 checkpoint。Root 只执行有界投影上的机械动作并调用唯一 canonical route-cell compiler；`stage-model-pool.v4` 只提供 stage identity 与权限，不选择 profile。Root 不读取完整 issue/DAG/state，不执行语义调查，也不得自行判断风险、UI 分类、模型或 fallback。

## Stage model pool 与重分类

永久 routing 的唯一 authority 是 `execution-capability-routing.v5` 的 `canonical-route-cell-compiler`：它把 stage semantics、verified executable slice 与 observed execution shape 一次性编译为一个 route cell 和一个 exact production profile。不存在之后的全局 ladder、profile search、availability fallback 或 failure escalation。普通 roster 固定为 `terra-low/medium/high` 与 `sol-low/medium/high/xhigh`，`sol-max` 只允许 Advisor 或机器证明的 frontier exception；`terra-xhigh/max` 仅保留为 disabled catalog 项。所有 `luna-*` profile 已在 `stage-model-pool.v4` 一次性退役，旧 route decision、receipt 或 runtime metadata 在 actor spawn 前以 `stage-model-pool-luna-profile-retired` 失败，不存在 alias 或兼容 fallback。两个 narrow-deep-cost-sensitive route cell 均精确选择 `terra-high`。安装只验证完整性、availability 与 exact-route reachability，不运行付费比较。UI、长链和 frontier 仍必须由机器 evidence 决定，不能由节点字段或 Root 偏好决定。logical model capability 不含 sandbox/permission label；checked-in reviewed assumptions 只校验 exact profile，不是 runtime observation 或 selector。Cleanup/quiescence 不进入 LLM pool，绿色 authority 是 machine collector/verifier。

`reworkCount`、失败次数、余额、token、成本、telemetry、当前 root profile 和人工偏好不是 routing input。`writer-stage.output-missing`、failure、retry、rework 或 `profile-capability-mismatch` 都不能推进 profile。只有 independently revised semantic classification 或 executable slice 才能作为新 dispatch 输入调用 canonical compiler，并绑定旧 failure receipt、breaker reset/retry authorization 和可观察 requested/effective metadata。Acceptance-group 的每个 member 与 landing/reverification slice 都独立编译 route，不能继承上一 member 的 profile、candidate receipt 或 verifier context。不可用或不可观察 profile 必须 fail closed，不得静默 fallback。

共享 package 永久只拥有七个 agent role：`code-implementer`、`dag-creator-updater`、`documentation-writer`、`test-owner`、`ui-system-adjudicator`、`ui-ux-implementer` 和 `ux-acceptance-verifier`。Landing conflict resolution 复用 `code-implementer` 或 `ui-ux-implementer`，不创建 `landing-owner`。某个修复批次对 Sol Ultra 的直接实现授权是该批次的 delivery authority，不是永久 runtime profile、fallback 或 routing input；临时 bootstrap run 也只能保留作历史审计、冻结测试恢复和退役 evidence，不能成为 dispatcher 或兼容权威。

## Telemetry projection

`scripts/telemetry.mjs` 只消费 ledger、dispatch/batch、epoch、resource、acceptance-group、DAG decision、landing、human-decision、stage-work-plan 与 execution-route 的 verified source projection，确定性生成 telemetry event、run/model/group/DAG/landing/human/slice/shape/checkpoint summary。Source 顺序和完全重复项不改变 digest；同 source digest 的不同 projection、未验证 source、未知字段或 output schema 反向作为 source 均 fail closed。

不可观察 effective model/effort/sandbox、duration、artifact、checkpoint 或 cost 写 `not-observed`，不得从 requested metadata、agent 自述或自然语言补值。Projection allowlist 拒绝 raw prompt、issue body、source diff、command output、human free text、secret、PII 与 chain-of-thought。

Telemetry 能报告 whole-issue dispatch、prompt/slice 缺口、continuation 重启、机械升档、group member 掩盖、漏 commit mapping、跨 member conflict、旧 receipt replay、force push、错误 human request 和 cleanup 覆盖 first failure，但无权修改 correctness policy、DAG、slice plan、landing/human/resource state 或 route。失败次数、等待、human preference、余额、token 与可观察成本永远不是 routing input；`falsePositiveDagDispatchCount` 必须为零。

## Terminal

合法 terminal 只有：

- `impossible`：当前仓库和允许环境内不可实现；
- `externally_blocked`：需要无法由本地工作消除的外部状态或权限；
- `not_applicable`：直接证据证明该 issue 不适用于当前事实。

进入 terminal 前，先执行 [`group-delivery.md`](group-delivery.md) 的“Terminal 前本地交付”，完成全部本地可行工作。terminal issue 保持 open。评论必须列出：

1. 已完成并已推送的本地可行工作；
2. 精确阻碍或不适用事实；
3. 命令、输出、远端状态或其他直接证据；
4. 可观察的恢复条件。

把恢复条件规范化为指纹。后续刷新时条件与指纹未变化，不得重派；发生可观察变化后才移出 terminal，重新调查并重算图。静态推测、subagent 自述或“暂时看起来不能”不是 terminal 证据。

机器词表只来自 `policy/terminal-policy.json`，并由 `contracts/terminal-policy.schema.json` 与 `scripts/terminal-policy.mjs` 共同验证。`terminalize-node` 只能经 `scripts/lifecycle-terminalization-executor.mjs` 执行：它重放 canonical ledgers，绑定第一项失败，重新观察 direct evidence、所有恢复路径和 remote/repository/runtime/dependency/human-decision/evidence 域，记录仍需保留的资源，然后通过专用 recorder 追加一次 terminal receipt chain。普通 batch recorder、Root 自写 category、caller 提供的 fingerprint 或 narration 不能产生 terminal authority。terminalization 不关闭远端 issue，不删除资源，不释放 lease/slot，也不生成 cleanup、delivery 或 quiescence evidence。

恢复事件必须引用当前 terminal receipt 的 observable fingerprint。指纹未变化时拒绝恢复；发生真实可观察变化时，append-only history 保留，但当前 terminal receipt chain 从 projection 中被 supersede，节点回到重新调查与重算图的 canonical 路径。

“未取得 CI evidence”不是 terminal 类别。CI 未执行、实际失败和不可替代的 CI 专属门禁按 [`group-delivery.md`](group-delivery.md) 的唯一关闭规则处理；计费或额度导致 job 未启动本身不得自动产生 `externally_blocked`。

## 60 分钟恢复

若连续 60 分钟没有以下任一实际产出：

- 新 commit；
- 经远端核验的 issue closure；
- 有直接证据的 terminal blocker；

则立即重裁 DAG，取消或释放无效工作，把过大的 writer stage 重新编译为更小的 material-revised slices，重新计算依赖与验收组，并按资源调整并行度。存在合法 checkpoint 时必须从 continuation cursor 恢复，不能从 issue 正文重启调查、重做已 terminal 的 slice 或重建未漂移的 attempt。不得增加评审层、重复原验收或保留没有进展路径的槽位占用。

## 全局完成

只有 Skill 入口定义的三项停止条件同时成立才完成。存在未阻塞节点、未交付验收组、未核验 closure，或没有直接证据的 open issue 时，均不得结束。
