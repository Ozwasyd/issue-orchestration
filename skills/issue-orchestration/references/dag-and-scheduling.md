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

根代理是完整运行态（ledger、锁、槽位和事件）的唯一写入者。各 stage agent 只接收当前闭环任务、局部 diff 与所需 evidence 投影，不得读取或修改完整 DAG、ledger、锁、槽位或状态根。根代理可以追加已验证的阶段事件，但不得自行生成、删除或修补 completed-prerequisite tombstone；tombstone 只能由 root scheduler 拉起、绑定 `stage-model-pool.v3` semantic-proposal route 的 fresh-context、observe-only DAG updater 提议，经 mutation postcondition 和机器门禁校验后纳入 v2 DAG。

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

这条状态机按 member/node 独立运行，不是阻断整个 scope 的全局许可门。每个
member 的 `dag-startup-gate-receipt.v2` 只能消费自己的 bounded projection：
route/actual runtime identity、lease、member receipts 与 completed-prerequisite
tombstones；`stageReceipts`、`testContractDigest`、节点 `model`/`effort`、
难度或 rework promotion 都没有启动权威。该 member 的 `dispatch_enabled`
之前不得为它创建写入型 attempt。顺序如下：

1. 在状态根查找当前仓库组合和 issue 范围对应的 DAG；不存在、不可读或损坏时标记需要重建，不得继续派发。
2. 重新读取本次范围全部远端 open issues 和会改变范围或验收的评论，生成当前启动时间之后的 issue snapshot。
3. 读取相邻代码、直接测试、适用 current 文档和依赖事实，核对责任仓、依赖、执行顺序、验收组和 terminal 恢复条件。
4. 校验 DAG schema、状态根、仓库路径和远端、默认分支、base/HEAD、dirty fingerprint、issue 精确集合及更新时间、评论 fingerprint、节点依赖和验收组。
5. 缺失、损坏、过期、范围不完整、出现新 issue、仓库身份或 base SHA 不同、评论变化、owner/依赖/验收组失真时，在状态根重建或完成一致性恢复；恢复失败保持 `dispatchEnabled=false`。
6. 有效 DAG 仍须刷新远端 snapshot。事实和 fingerprint 未变时只更新 freshness/consistency evidence，复用节点、terminal 指纹、执行 ledger 和有效 evidence，不无理由重建或重复探针。

DAG 和 issue snapshot 均必须在已验证状态根内。所有 `runtimeFiles` 路径必须相对状态根，且不得包含父目录跳转或穿过 symlink。至少使用以下 schema 字段：

- DAG：`issue-orchestration.dag.v2`、run id、规范状态根、刷新时间、仓库 facts/fingerprint、active issue fingerprint、包含 active issue 与 prerequisite observation 的 `remoteSnapshotDigest`、节点、验收组、运行态相对路径、阶段 receipts 和 consistency evidence；
- issue snapshot：`issue-orchestration.issue-snapshot.v1`、刷新时间、只包含本次 scope 的 open executable issues（仓库、编号、状态、更新时间和评论 fingerprint），以及独立的 `prerequisiteObservations`。observation 不是 active issue node，而是远端复核投影，至少绑定 `dependencyKey`、仓库/issue identity、`remoteState`、`stateReason`、`closedAt`、`deliveredCommit`、`remoteDefaultBranch`、完成 evidence 和 `evidenceDigest`、`verifiedAt`；
- 节点：精确 issue identity、owner、`dependencyKeys`、互斥的 `activeDependencies` 与 `satisfiedDependencies`、验收组、状态、难度、调查过的代码/测试/current 文档/约束；terminal 节点另含类别、直接证据和恢复 fingerprint。不得再使用 v1 的隐式 `dependencies` 删除即满足语义。

### Completed prerequisite tombstone authority

`issue-orchestration.dag.v2` 把一条依赖的声明和分类分开：`dependencyKeys` 保留完整边；仍需执行的边放在 `activeDependencies`，已由远端完成事实满足的边放在 `satisfiedDependencies`。同一个 key 不得同时出现在两组，且每个 key 必须出现在其中一组；未知 key、删除边或把 closed issue 塞进 active `nodes` 都 fail closed。

每个 satisfied entry 是不可变 tombstone，必须与 snapshot 中同 key 的 observation 完全一致，并绑定：

- `issue`、`repository`、`issueNumber` 三者一致的远端身份；
- `remoteState=CLOSED`、`stateReason=completed`、已发生且不晚于 snapshot `refreshedAt` 的 `closedAt`；
- 默认分支上的完整 40-hex `deliveredCommit`，且该 commit 可由当前仓库 default branch 的 ancestry 证明；
- `remoteDefaultBranch`、完成 evidence payload、其规范化 SHA-256 `evidenceDigest` 和 `verifiedAt`。

`closed:not_planned`、`duplicate`（没有明确合法替代节点）、缺少交付 commit、commit 不可达或 evidence 缺失/篡改均不得自动满足依赖。远端 issue reopen、state reason、默认分支、交付 ancestry 或 evidence digest 任一漂移，会让旧 tombstone 在下一次远端 snapshot 刷新时失效；dependent 必须恢复为 unsatisfied，不能继续 `ready`、`implementing`、`independent-verifying`、`delivery-ready` 或 `delivering`。completed prerequisite 不进入 active issue snapshot、DAG `nodes`、`readyFrontier` 或 `activeAttempts`，也不消耗执行槽位。

门禁对依赖解析输出稳定 reason code：`dependency-active`、`dependency-satisfied`、`dependency-unknown`；不合法 tombstone 使用对应的 `tombstone-*` 或 `dependency-classification-overlap` / `dependency-edge-deleted` 错误码。`dag.v1` 只能作为诊断输入；启动时必须重新读取远端 issue、默认分支和完成 evidence 重建 v2，禁止填空 tombstone、只写 `status=closed` 或把缺失 dependency 当作已满足。

远端 snapshot 写入状态根后，先用下列命令加 `--facts-only`，取得规范仓库 facts、issue fingerprint 和 repository fingerprint；该阶段固定输出 `dispatchEnabled=false`，只用于新建或核对 DAG。写入或恢复 DAG 后，去掉 `--facts-only` 运行完整门禁：

```bash
node .agents/skills/issue-orchestration/scripts/check-dag-gate.mjs \
  --state-root <state-root> \
  --dag <state-root>/dag.json \
  --issues-snapshot <state-root>/issue-snapshot.json \
  --repository <repository-id>=<repository-root> \
  --default-branch <repository-id>=<resolved-default-branch> \
  --workspace <common-or-launch-workspace> \
  --startup-time <ISO-8601>
```

只有 member receipt 输出 `valid=true` 且 `dispatchEnabled=true` 才能让该节点进入 `ready`；另一个 member 的失败不得把已满足投影的节点全局阻塞。该机器检查不替代语义调查；仅从 issue 标题、数量或时间猜测依赖不构成一致性。

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

## 工作守恒

存在 `ready` writer stage、已验证的下一 executable slice 且有空闲槽位时，下一次调度动作必须派发该 slice；不得以等待、轮询或汇总代替派发。完整 issue、完整 stage 或手写 prompt 不是 dispatch unit。只在没有可执行 slice、没有空闲槽位或需要完成一次不可并行的根代理交付动作时等待。

预计超过 5 分钟的 build、Fresh、consumer、visual 或性能任务启动后，立即返回调度循环，为其他独立 `ready` 节点分配空闲槽位。长任务只占自己的槽位；不得让根线程只轮询它。

`subagentSlotsEffective` 取运行时实际 V2 capacity、调用者显式上限和环境资源上限三者的最小值。每个 active slice writer、independent verifier/adjudicator 或仍运行的长任务各占一个 agent 槽位。槽位满时才等待最早能改变 DAG 的事件。

## 根调度模型

根调度进程（root scheduler）固定使用 `terra-low`。进入调度循环前先从本轮运行时元数据核验 requested/effective model、reasoning effort 与 multi-agent backend V2；不匹配时分类为调用问题，停止本次父调用并以 recovery receipt 接管 checkpoint。Root 只执行有界投影上的机械动作并调用唯一 canonical route-cell compiler；`stage-model-pool.v3` 只提供 stage identity 与权限，不选择 profile。Root 不读取完整 issue/DAG/state，不执行语义调查，也不得自行判断风险、UI 分类、模型或 fallback。

## Stage model pool 与重分类

永久 routing 的唯一 authority 是 `execution-capability-routing.v4` 的 `canonical-route-cell-compiler`：它把 stage semantics、verified executable slice 与 observed execution shape 一次性编译为一个 route cell 和一个 exact production profile。不存在之后的全局 ladder 或 profile search。普通 roster 固定为 `terra-low/medium/high`、`luna-max`、`sol-low/medium/high/xhigh`，`sol-max` 只允许 Advisor 或机器证明的 frontier exception；`terra-xhigh/max` 与 `luna-low/medium/high/xhigh` 只有 catalog 可见性，没有 dispatch、retry、fallback 或 override authority。`luna-max` 还必须通过 fresh、narrow、single-module、短工具链、精确 tokenizer 与 32K token 上限合同，并在 dispatch 前绑定 trusted availability；唯一 availability fallback 是 `terra-high`。安装只验证完整性、availability、reachability 与 fallback，不运行付费比较。UI、长链和 frontier 仍必须由机器 evidence 决定，不能由节点字段或 Root 偏好决定。logical model capability 不含 sandbox/permission label；checked-in reviewed assumptions 只校验 exact profile，不是 runtime observation 或 selector。Cleanup/quiescence 不进入 LLM pool，绿色 authority 是 machine collector/verifier。

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

“未取得 CI evidence”不是 terminal 类别。CI 未执行、实际失败和不可替代的 CI 专属门禁按 [`group-delivery.md`](group-delivery.md) 的唯一关闭规则处理；计费或额度导致 job 未启动本身不得自动产生 `externally_blocked`。

## 60 分钟恢复

若连续 60 分钟没有以下任一实际产出：

- 新 commit；
- 经远端核验的 issue closure；
- 有直接证据的 terminal blocker；

则立即重裁 DAG，取消或释放无效工作，把过大的 writer stage 重新编译为更小的 material-revised slices，重新计算依赖与验收组，并按资源调整并行度。存在合法 checkpoint 时必须从 continuation cursor 恢复，不能从 issue 正文重启调查、重做已 terminal 的 slice 或重建未漂移的 attempt。不得增加评审层、重复原验收或保留没有进展路径的槽位占用。

## 全局完成

只有 Skill 入口定义的三项停止条件同时成立才完成。存在未阻塞节点、未交付验收组、未核验 closure，或没有直接证据的 open issue 时，均不得结束。
