# Issue orchestration scope and remote snapshot

本文件是多 issue 调度中 scope selector、远端 live snapshot、分层 investigation projection、frontier 和 DAG 更新触发条件的 current authority。它只约束调度运行态，不改变任何目标仓库的产品 API、数据库、发布或前端运行时。

## Versioned selector

每轮运行使用一个 `issue-orchestration.scope-selector.v1` selector。selector 至少固定以下字段：

```text
schema
selectorVersion
type
repositories
statePolicy
dependencyClosure
implicitExpansion
parameters
remoteQueryIdentity
```

支持的 `type` 是 `explicit-issues`、`repository-open-issues`、`label-query`、`milestone-query`、`dependency-closure` 和 `parent-tracking-issue`。

- `explicit-issues` 只解析 `parameters.issueIds`。相同 label、相似标题、`related` 或 `mentioned` issue 不会隐式进入；selector 版本和 canonical parameters 不能复用到另一组 issue。
- `repository-open-issues`、`label-query` 和 `milestone-query` 是动态查询。每次远端重取都按 selector 的 repository、state policy 和 query parameters 解析匹配集合；关闭、reopen 或离开查询的节点不得静默删除。
- `dependency-closure` 只沿远端事实中明确声明的 `dependsOn` 边扩展。
- `parent-tracking-issue` 只沿 parent 的 `trackedIssueIds` 选择子 issue；是否包含 parent 由 selector parameter 明确决定。

`repositories`、集合参数和远端结果在计算 digest 前 canonicalize（对象按 key、数组按 canonical value 排序），因此同一 selector 和远端事实不受返回顺序影响。没有 selector 中明示的隐式扩张规则。

## Selector receipt and live facts

解析结果写成 `issue-orchestration.selector-receipt.v1` receipt。每个 receipt 记录：

```text
selectorVersion/type/parametersDigest/selectorDigest
resolvedIssueSet[]
exclusionReasons{}
remoteQueryIdentity
previousRemoteSnapshotDigest
remoteSnapshotDigest
remoteChangeSet{added,changed,closed,removed,reopened}
issueHistory{}
resolvedAt
receiptDigest
```

每个 resolved issue 的 remote fact 包括 issue identity、state、state reason、updatedAt、title、body、relevant comments、labels 和 milestone。`remoteSnapshotDigest` 同时绑定 selector digest、排序后的 issue set 和这些 remote fact digests；本地 test failure、rework、agent blocker、epoch、slot、lease、worktree、resource 或 cleanup 状态不属于 remote fact。动态 selector 中离开的 issue 进入 `issueHistory`，并带有 `left-selector-scope` disposition 与此前的 snapshot digest。

## Layered investigation projection

Frontier 不再把单个节点上的完整 investigation 记录当作 dispatch authority。DAG 节点必须使用三层、可独立校验的事实链：

```text
discoveryFacts
  → classificationFacts
  → dispatchInvestigation（仅在需要完整 dispatch 调查时存在）
```

对应的调查阶段是 `discovered → dependency-classified → candidate-ready → dispatch-investigated`。`discoveryFacts` 只承载 issue identity/state、显式依赖、scope membership 和候选 owner；`classificationFacts` 承载 owner evidence、active/satisfied dependencies、conflict/resource domains、risk flags、instruction roots、confidence 与 unresolved decisions；`dispatchInvestigation` 承载 exact base/worktree、AGENTS 链、允许/禁止边界、code/test/current-doc paths、实现决定、acceptance mapping、runtime probes、mutation controls 和完整 prompt inputs。浅层事实不能直接生成 implementer prompt。

各层的 schema 分别是 `issue-orchestration.discovery-facts.v1`、`issue-orchestration.classification-facts.v1` 和 `issue-orchestration.dispatch-investigation.v1`。每层都必须是 `status=complete`、带有自洽的 SHA-256 `digest`，并通过前一层 digest、selector receipt digest 和 member remote-fact digest 串联；dispatch 层还必须绑定节点的 `baseSha`。发现层与分类层由非 root 的 `dag-creator-updater` 以 `stage-model-pool.v4` 的确定性 semantic-proposal route、`executionClass=observe-only`、fresh-context、proposal-only 身份产生且共享同一 actor identity；dispatch investigation 由 fresh observe-only `test-owner:test-contract-planning` 在同一个 planning bundle 中产生，并绑定 planning attempt、route、mutation postcondition 与 `testOwnerId`，不得由 leased test-contract writer 或未定义的独立阶段补写。实际 profile 由 canonical routing compiler 决定，不能从 root 或 agent 自述推断。

三层事实由 `issue-orchestration.investigation-projection.v1` 汇总。projection 必须覆盖 selector receipt 中每个 member 恰好一次，并携带 `selectorReceiptDigest`、`remoteSnapshotDigest`、`inputDigest`、`projectionDigest`、`testOwnerCandidates` 和 `implementationReady`。其 validation 必须使用 `issue-orchestration.investigation-validation-receipt.v1`，由 `layered-investigation-validator` / `machine` / `observe-only` 签发，状态为 `passed`，且 freshness 仍绑定当前 selector、remote snapshot 和每个 member 的 remote fact digest。派生列表只能由 member phase 重新计算：`candidate-ready` 只产生 `test-contract-ready`，`dispatch-investigated` 才产生 `implementation-ready`；`dependency-classified` 仍需保留 `investigation-incomplete`。

调查队列按 ready-adjacent、downstream unlock、critical path、priority、waiting age 和稳定 member identity 确定排序，数组顺序不参与权威。有 machine-ready stage 和空槽时必须先派发；后台深度调查不能压住 ready work。100 个 shallow member 中只要两个即将执行的 member 完成所需层，就可派发对应 test-owner/implementation stage，无需等待其余 98 个。长期阻塞的深度调查必须记录 `blockedSince`、blocker owner 和直接 evidence；没有 owner/evidence 的 starvation 不能成为永久停留理由。

Freshness 按 member 和 layer 隔离。issue/relevant-comment 或 selector member fact 漂移只失效受影响 member 的 discovery/classification 及其下游；base、delivery epoch、AGENTS chain、current docs、owner code 或 test-entry digest 漂移只失效该 member 的 dispatch investigation。未漂移层必须幂等复用，不能因另一 member 变化而全 scope 重做。深度 member 只能出现在 implementation 输出或 dispatch-investigation queue 之一，不能双重派发。

Acceptance group 可以复用共享 code/test/docs 索引、schema/runtime facts 和 conflict/resource evidence，但每个 member 在冻结合同前仍独立绑定 issue-specific paths、tests/probes、current docs、constraints/non-goals、owner repository、allowed/forbidden paths、acceptance map 和 investigation digest。组级 evidence 不能替代 member contract；一个 member 缺证据只阻塞该 member。Implementer 只消费完整、base/receipt-bound prompt；缺 owner、design、acceptance、counterexample、command、probe、mutation 或 stop condition 时必须返回 `test-contract-disputed`，不得自行补调查。

Projection、validation 和每层事实的 digest 或 selector/freshness 任一漂移都使 frontier 重新计算并 fail closed。旧的 `node.investigation` 属性及任何兼容 fallback 不是 current schema；出现时必须拒绝，不能把旧字段重放为 dispatch authority。

## Deterministic test-contract cold start

新选中的 open issue 从空 state root 到首个 test-contract writer dispatch 只能调用公共 `advanceTestContractColdStart`。调用方提供的初始事实限于已验证 selector receipt、当前 remote issue snapshot、accepted semantic proposal、runtime capability observations 与 installed policy；不得注入 prebuilt receipt、frozen contract、work plan、slice、prompt、checkpoint、candidate、projection、完整 issue body 或 caller-authored authority。

确定性顺序为：

1. 从 title、body 和所有 relevant comment blocks 构建 exact、digest-bound normative source coverage；
2. 从 accepted proposal 编译 requirement inventory 与 acceptance contract；
3. 编译并验证 `issue-orchestration.node-discovered-receipt.v1`，随后首次追加仅含 discovery/acceptance facts 的 `node.discovered`；
4. fresh observe-only `test-owner:test-contract-planning` 在一个 `test-contract-planning-bundle.v1` 中返回 planning receipt、dispatch investigation、slice proposal 与 passed mutation postcondition；
5. deterministic validators 编译 slice validation、stage work plan、first executable slice、compiled prompt 与 pending canonical route selection；
6. 使用 distinct writer attempt 获取 exclusive lease/resource，再编译 runtime-bound final route；
7. 只有 plan、slice、prompt、route、resource 与 predecessor mutually digest-bound 后，才追加 `stage.contract-frozen` 并生成 `test-contract-writer-dispatch.v1`。

Planning attempt 与 writer attempt 重用、selector/comment/base 漂移、source coverage 缺失、`authority-choice-required`、mutation postcondition 缺失、route/runtime mismatch 或 stale canonical authority 都必须返回 typed blocker。API 可重复调用，但不得重写既有 `node.discovered` ledger、回退 projection 或制造第二份 frozen authority。

## Writer work plan、executable slice 与可恢复进度

完整 issue、标题、正文、评论和 Root 手写任务都不是 writer dispatch authority。每个 writer stage 必须先由 `compileStageWorkPlan(input)` 生成 `issue-orchestration.stage-work-plan.v1`，再由 `compileExecutableSlice({ plan, sliceId })` 提取当前 `issue-orchestration.executable-slice.v1`，最后由 `compileDispatchPrompt({ plan, slice })` 确定性生成 `issue-orchestration.compiled-dispatch-prompt.v1`。`validateCompiledDispatchPrompt` 必须重算 prompt 并核对 plan/slice/stage identity 与 digest；Root 只能调用 compiler/validator、选择 ready slice 和路由输出，不能 author、编辑、删减或重写 compiled prompt。

Verified work plan 绑定 run/repository/issue/node、stage role/phase、base SHA、epoch、worktree identity、semantic/test/authority/Skill/baseline/routing digests、单一 stage objective、acceptance items、有序 slices、slice dependency graph、stage 允许/禁止路径、required commands 与 terminal artifacts。每条 acceptance item 和 required command 都必须有且只有一个 slice owner；不完整 coverage、重复 owner、stage identity 漂移或没有 terminal artifact 的 plan 必须 fail closed。

每个 executable slice 只承载一个有界 objective，并固定：

- first required action、read targets、允许写路径或 explicit no-change output、forbidden paths；
- required files、commands、evidence 与 non-goals；
- completion/continuation predicates；
- `maxChangedFiles`、`maxModules`、`maxReadOperations`、`maxNoArtifactCalls` 和 duration class 等 thresholds；
- checkpoint kind、predecessor terminal receipts 和 next slice identity。

Writer 不能把 slice 扩展回完整 issue，也不能自行选择 owner、方案、兼容策略或验收强度。永久 writer phase/role/output mapping 为：

| Stage phase | Writer role | Terminal 前必需输出 |
| --- | --- | --- |
| `test-contract` | `test-owner` | tests/fixtures、commands、checkpoint |
| `implementation` | `code-implementer` | diff、commands、checkpoint |
| `ui-implementation` | `ui-ux-implementer` | diff、render evidence、checkpoint |
| `documentation` | `documentation-writer` | diff 或 verified no-change evidence、checkpoint |
| `landing-conflict-resolution` | `code-implementer` 或 `ui-ux-implementer` | conflict mapping、diff、checkpoint |

Landing 复用 code/UI writer，不存在 `landing-owner` dispatch role。冻结审计 fixture 可以原样保留历史 `frozenObservationRole=landing-owner` 标签，但该标签不能进入 role registry、routing、permission 或 dispatch。Package 的七角色集合保持 `code-implementer`、`dag-creator-updater`、`documentation-writer`、`test-owner`、`ui-system-adjudicator`、`ui-ux-implementer`、`ux-acceptance-verifier`，不能因 landing 或恢复新增第八个角色。

Writer 在 threshold 前必须通过 `sealProgressCheckpoint` 生成 `issue-orchestration.stage-progress-checkpoint.v1`，并由 `validateProgressCheckpoint` 复核真实 filesystem、Git 和 command evidence。Checkpoint 至少封存文件 canonical realpath 与 `git hash-object`、Git HEAD/status、命令 exit/output digest、tree/diff/command/evidence digests、cursor、status 与 next required action。`partial` 必须带 `nextRequiredAction` 且不能 candidate-green；`complete` 必须令该字段为 `null`。自然语言进度、文件名、命令字符串或 agent 自述不能代替 checkpoint。

暂停或运行时中断只能通过 `compileContinuation` 生成 `issue-orchestration.stage-continuation-receipt.v1`。Continuation 必须绑定原 run/node/base/epoch/worktree/plan/slice/checkpoint/cursor，保持 `restartInvestigation=false`，并从封存 cursor 的下一 required action 继续；新 thread、attempt 或 agent 不能从 issue body 重启调查、重做已证明动作或丢弃未漂移 evidence。

完成 slice 时，`sealSliceTerminalReceipt` 生成 `issue-orchestration.slice-terminal-receipt.v1`，绑定 plan/slice/compiled prompt/route、complete checkpoint、changed paths、command evidence 与 next slice。`evaluateSliceTerminalGate` 按 `orderedSlices` 检查无遗漏、无重复、无乱序：非最终 slice 只能产生 `writer-stage.slice-completed → next-slice`，且 `candidateEligible=false`；只有 final slice 连同此前所有 terminal receipts 都有效，才能产生 `writer-stage.completed → candidate-green`。Partial checkpoint、continuation、单次 command pass 或单个 diff 都不能提前完成 stage。

`evaluateWriterStageObservation` 对 test-contract、implementation、ui-implementation、documentation 和 landing-conflict-resolution 使用同一失败合同。Invocation、environment、runtime capability、first required action、required output、checkpoint 或 terminal receipt 任一失败，都必须签发 `issue-orchestration.writer-stage-failure-receipt.v1`，进入 terminal 并打开 breaker。`writer-stage.output-missing` 包括 agent 返回但没有该 phase 必需产物；它不计 implementation rework、不增加 `reworkCount`、不触发 human decision，也不能改写成 verifier blocker或直接重试。

Breaker 使用 failure receipt 的 semantic identity，绑定 repository/issue/node/base/epoch、plan/slice/route、stage role/phase、event type 与 evidence。改变 attempt、agent、prompt wording、worktree、slice id、时间或重复相同调用都不能清除 breaker。`authorizeWriterStageRetry` 只有在验证 `issue-orchestration.writer-stage-retry-authorization.v1` 时才允许重派：authorization 必须引用 prior failure receipt 与 `semanticFailureDigest`，并提供 `slice-revision`、`compiled-prompt-revision`、`runtime-revision` 或 `capability-revision` 的 material evidence，包括不同的 previous/current digest、非空 `changedRequirementIds` 与可重算 evidence digest。只改 identity 或措辞不是 material retry。

上述八个 schema 与 compiler/progress API 是永久 runtime 合同。某次 repair issue 直接授权 Sol Ultra 完成代码、文档和交付，只是该批次的实现授权，不能写入永久 `stage-model-pool.v4`、routing 或 fallback policy。任何临时 bootstrap run、旧 receipt、first failure 与 breaker 只保留作冻结测试恢复、历史审计 fixture 和最终退役证据；它们不是永久 dispatcher、执行前置或兼容入口。

## Semantic graph 与 runtime projection 分层

语义图和运行态投影是两份独立、可分别校验和持久化的事实。`issue-orchestration.semantic-graph.v2` 只承载节点的 semantic facts（依赖、owner、conflict key、risk/UI class、acceptance group 和 contract digest），并以 `semanticGraphDigest` 封存；`issue-orchestration.runtime-projection.v1` 只承载 immutable runtime ledger 与 runtime facts 的确定性 replay 结果，并以 `runtimeProjectionDigest` 封存。两者必须分别通过 validator，写入 state root 的 `semantic-graph.json` 与 `runtime-projection.json`；不得把运行态字段写回 semantic graph，也不得把 `graphPatch`、`semanticGraph` 或其它语义 payload 嵌入 runtime projection。旧的合并对象或 compatibility fallback 一律拒绝。

三层 digest 的 ownership 不可互换：

- `scopeDigest` 覆盖 selector 及远端 snapshot 的 scope facts（issue identity、state、labels、comments、title/body、milestone 等）；
- `semanticGraphInputDigest` 只覆盖 snapshot 中用于生成 semantic graph 的 `semanticFacts`；
- `runtimeProjectionDigest` 覆盖 projector replay 的 completed、ready/blocked、critical path、conflict、lease/slot、epoch、candidate/delivery commit 和 cleanup 结果。

三者在 canonical JSON 后计算，数组返回顺序不改变 digest，且不得互相 alias。projector 版本和 digest（`issue-orchestration.runtime-projector.v1`）必须绑定 projection；projector 只能读取 semantic graph，不能解释、修改或新增 semantic edge/class。

### Remote mutation reconciliation 与 DAG mode

每轮 remote refresh 先按 `issue-orchestration.expected-remote-mutations.v1` 封存 expected registry 和 `expectedRemoteMutationDigest`，再将观测到的 completion comment、state/reason transition、delivery label change 等逐项 reconcile。expected delivery window（包括 acceptance-group window）若匹配，semantic graph digest 保持稳定，决策为 `projection-only`，`dagUpdaterDispatchCount` 必须为 0。slot、lease、epoch、ready/frontier、candidate、delivery、cleanup、telemetry，以及本地 failure/rework/verifier/agent event 同样只能更新 runtime projection，不得请求 semantic DAG work。

只有 `semanticGraphInputDigest` 发生未预期变化（dependency、owner、conflict、contract 或 acceptance-group 等 semantic fact）时，决策才是 `semantic-patch`，并且必须授权恰好一次 fresh、observe-only DAG updater。普通 semantic update 只能返回 `issue-orchestration.semantic-graph-patch.v1`：patch 绑定 base `semanticGraphDigest`、允许的最小 operation、直接 evidence digests、runtime execution binding、mutation postcondition、可重算的 result digest，且不得嵌入 full graph；root 只能原样接受已封存 patch，不能自行 author/edit，应用必须经过 root-acceptance gate。`full-create` 仅用于 initial create；`full-recovery` 仅用于带 machine evidence 的 `graph-corruption-recovery` 或显式 `scope-replacement`。其它 full proposal、base drift、非法 operation、结果 digest 不匹配或 root-authored patch 必须 fail closed。

每个判断必须签发 `issue-orchestration.dag-update-decision-receipt.v1`，并完整包含：`dagUpdateMode`、`remoteMutationClassification`、`expectedRemoteMutationDigest`/`expectedRemoteMutationMatched`、scope/semantic-input/semantic-graph/runtime-projection 的 before/after digests、`baseSemanticGraphDigest`、`graphPatchDigest`/`graphPatchOperationCount`、`dagUpdaterDispatchRequestId`/`dagUpdaterDispatchReceiptDigest`、`fullProposalReason`、`projectorVersion`/`projectorDigest` 和自身 `receiptDigest`。`none`/`projection-only` 必须没有 updater dispatch、patch digest、patch operation 或 full-proposal reason；`semantic-patch` 必须有一次 updater dispatch 和至少一个 patch operation，但不得有 full-proposal reason；`full-create`/`full-recovery` 必须有 updater dispatch 和非空 full-proposal reason，但不得有 patch identity。所有 digest 都是 canonical SHA-256，缺字段、错误 digest 或 mode-specific nullability 不匹配必须 fail closed。`#1826` telemetry 只能由已验证 receipt 派生；`falsePositiveDagDispatchCount` 必须恒为 `0`，不能由手写计数器或本地 stage event 推断。

## Ready frontier 与 stage eligibility

Frontier 的计算粒度是 `member issue + stage`，不是根代理手写的 `status=ready`。编译器接收同一份 DAG、selector receipt 和 frontier runtime，输出 `issue-orchestration.frontier-projection.v1`：

```text
eligibilityInputDigest
frontierDigest
readyFrontier[]
notReadyReasons{}
executionProjection[]
computedAt
```

`readyFrontier` 是当前 scope 内所有没有 compiler reason 的 member-stage 对的最大集合。DAG 的节点顺序、issue 返回顺序、文件遍历顺序、root narration 和手写 status 都不参与 eligibility；节点必须与 selector receipt 的 `resolvedIssueSet` 精确相等。因而遗漏一个 eligible member、把 blocked member 加入 ready，或只改写 digest，都会使独立重算失败。

每个 issue 只有一个确定的下一 stage。frontier 的语义 stage 映射到事件账本中的严格链：非 UI 节点按 `test-contracting → test-contract-frozen → implementing-self-testing → candidate-green → independent-verifying → behavior-green → documenting → documentation-green → delivery-ready → delivering → cleaning` 推进，UI/UX 节点在 `behavior-green` 后必须先经过 `ux-acceptance → ux-accepted`，再进入 `documenting`。对应 stage receipt 未通过时，后续 stage 不得进入 frontier；所有 receipt 通过后，该 issue 不再产生 ready 或 not-ready projection。`review`、通用 `verifying`、`deliverable` 和 `delivered` 不是当前 stage 或兼容入口。

编译器至少检查 active dependency/tombstone、上述 layered investigation projection 的完整度与 freshness、owner repository、base SHA、selector/remote fact identity、同 stage active attempt、未变化 terminal、候选能力与权限、delivery freeze、exclusive lease 和 remote facts freshness。候选的 role、model、effort、mode、允许路径、UI 所需 design Skill/authority digest 也属于 eligibility input；local stage progress 只重新计算 execution frontier，不触发 semantic DAG update。

所有非 ready active member 必须由编译器产生稳定、排序固定的 reason。reason 只能使用以下枚举，并绑定直接 evidence identity 或 digest：

| 顺序 | `notReadyReason` |
| ---: | --- |
| 1 | `dependency-unsatisfied` |
| 2 | `investigation-incomplete` |
| 3 | `owner-unresolved` |
| 4 | `base-drift` |
| 5 | `scope-drift` |
| 6 | `active-attempt` |
| 7 | `terminal-unchanged` |
| 8 | `runtime-capability-missing` |
| 9 | `delivery-frozen` |
| 10 | `exclusive-lease-held` |
| 11 | `remote-facts-stale` |

自由文本 reason、没有 evidence 的 reason、数组重排导致的 digest 漂移以及 stale selector/comment、base、scope、terminal 或 candidate permission 下继续复用旧 projection 均 fail closed。`notReadyReasons` 为空只有在所有 active member 已完成 stage chain 时合法；空 frontier 但仍有无 blocker 的 member 不合法。

## Dispatch candidate 与 fail-closed 边界

Root scheduler 只消费 compiler projection 和 selector/batch 输出，不得编辑 ready、reason、rank 或当前 stage。DAG gate 把 `frontierProjection`、`frontierRuntime`、`selectorReceipt`、`dispatchFrontier`、`dispatchRankingPolicy` 和 `dispatchBatch` 作为一个不可拆分单元；缺少一个或全部缺失都 fail closed。dispatch frontier 必须与已验证 ready frontier 的 issue/stage 集合精确相等，并把每个 DAG node 的 priority、critical-path、downstream unlock、starvation、acceptance group、conflict/resource evidence、role/worktree/write scope、receipt/Skill、candidate 和 epoch facts 原样绑定。

版本化 `critical-unlock-conflict.v1` policy 先严格按 `P0 → P1 → P2`，同一 priority 内再按 starvation threshold、downstream blocked count、critical-path length、acceptance-group completion value、starvation age 和稳定 `taskId` 排序。高 acceptance completion 不能越过更高 priority；长期等待只能在同 priority 内前移，不能越过 semantic dependency 或 stage receipt prerequisite。input 顺序和 issue number 不具有调度权威。

selector 按该确定顺序逐项加入不超过 `availableSlots` 的安全任务，得到 deterministic maximal safe batch。20 个互不冲突任务与 15 个槽必须选择 15 个；只有 N 个安全任务时精确选择 N 个。共享显式 write conflict key、同一 issue worktree 的两个 writer、共享 exclusive resource key 或命中 active lease 的任务不能共选；长任务只占自己的 slot 和显式 resource keys，不冻结无关 ready work。conflict key 必须来自 investigated owner/write-surface evidence，不能只按路径前缀猜测，也不能伪造成 semantic dependency。root-only delivery 同样只阻塞其 repository 或显式 keys。

输出 `issue-orchestration.dispatch-batch.v1` 必须完整列出 `selected`、`deferred`、机器 `selectionReasons`、结构化 `deferReasons`、全部 rank components 和 `batchDigest`。ready work 被空 batch 隐藏、遗漏仍可安全填槽的任务、超出 slot、派发非法 stage、绕过 conflict/resource lease、root 重排或改写 reason/digest，均由独立重算拒绝。acceptance group 只有在 shared surface、same epoch、atomic independent commits、有限且有界的 cold-start/lost-parallelism evidence 和 canonical member order 全部成立时可用；group session 没有 active member 时不占 slot，也不能降低 work conservation 或替代 member receipt。

依赖未满足、scope/remote facts 漂移、base 不一致、候选能力缺失、未变化 terminal、freeze 或 exclusive lease 只能减少可选安全集合，不能通过手写 ready 绕过。completed prerequisite 只在合法 `CLOSED/completed` tombstone、可达 delivered commit 和 evidence digest 都一致时满足依赖；reopen 或 tombstone 漂移会在下一次编译中移除 dependent。

DAG gate 必须使用当前 runtime 和 selector receipt 独立重算 frontier 与 dispatch batch，并比较 `eligibilityInputDigest`、`frontierDigest`、ready frontier、execution projection、ranking explanations 和 `batchDigest`；任何缺失、篡改或 scope 不完整都保持 `dispatchEnabled=false`，直到生成新的绑定 projection/batch。该合同不改变产品 API、数据库、发布或前端运行时。

## Dispatch receipt 与 runtime identity

每次阶段派发都必须先生成不可变的 `issue-orchestration.dispatch-request.v2`。Writer request 在 `stage-model-pool.v4` stage/execution-class identity 外，还必须绑定 `execution-capability-routing.v5` policy digest、verified plan/slice、`execution-shape-classification.v1`、`stage-capability-requirement.v2`、checked-in reviewed routing assumption digest、exact `execution-route-decision.v2`、独立 runtime execution binding、compiled prompt、requested/effective runtime identity 和 group/member/lease continuity。完整 issue、Root 手选 profile、成本/余额/token/telemetry/human preference、按失败次数升档或 silent fallback 都不能生成合法 request。`requestDigest` 覆盖去掉自身后的完整 request；完整 prompt、credential 和 secret environment 不进入 receipt；request/receipt 只写仓库外状态根。

Root 启动必须先由 launcher/runtime integration 产生 `issue-orchestration.runtime-startup-observation.v1`，再生成 `issue-orchestration.runtime-startup-attestation.v1`。requested 字段不能代替 effective evidence；Root narration、prompt JSON、环境变量回显、policy default 和历史 receipt 都不是 observation authority。attestation 必须实际绑定 model、effort、V2 backend、trust mode、`danger-full-access` sandbox、`approval_policy=never`、inheritance/guarantee、capacity、package/policy digest、route、invocation/session 与 root authority epoch。缺失、不可观察、stale、replay 或 drift 一律 `status=rejected`、`orchestrationEnabled=false`，并在任何 repository/remote/scope/state-root/DAG/lease/actor side effect 前终止 parent invocation。

正常 `root-scheduler:scheduling` 只允许 `terra-low`。`terra-medium` 只允许新 parent invocation 的 `root-scheduler:recovery-takeover`，且其 fresh observation/attestation 必须绑定 machine-issued takeover authorization、bounded handoff、old-root fencing 和新的 root authority epoch。`controlPlaneRecovery=true`、同 invocation 改 metadata 或 low root 启动 medium child 都不能取得 takeover authority。DAG gate 及所有后续 dispatch/continuation/landing/delivery/terminal/quiescence receipt 必须绑定同一 current attestation 与 invocation，不能回退到 `rootRuntime.metadata`。

`issue-orchestration.runtime-observation.v2` 必须从真实 child rollout 和机器 observation 读取，而不是复制 request 字段。它至少记录 `threadId`、`rolloutId`、`startedAt`、effective model/effort/role/mode/sandbox/fork/cwd/profile、runtime metadata digest，以及带 observation digest 的 dispatch/git/Skill/capability/lease observation。`skill-loader`、git identity、capability 和 lease observation 必须来自受信机器来源并自洽哈希；agent 自述不是 authority。缺少字段或 capability 时只能返回 `capability-unverified`，任何 mismatch、漂移、重放、secret material、错误 worktree、full-history fork 或不符合角色的 sandbox 都返回 `rejected`，不得进入 active attempt。

永久 writer route 的唯一 correctness authority 是 `execution-capability-routing.v5` 的 `canonical-route-cell-compiler`。它一次性消费 stage semantics、verified slice 与机器 execution metrics，产生 shape、capability requirement 和 exact route decision；不存在第二个 stage selector、数值 capability ladder、后续全局 profile 搜索、availability fallback 或 failure escalation。`reviewed-routing-assumptions.json` 是显式 checked-in policy assumption，不声称 runtime observation，也无 selector authority；catalog 只证明 availability，per-dispatch runtime identity 与 fully bound live capability evidence 分别使用独立合同。普通 production roster 固定为 `terra-low/medium/high` 与 `sol-low/medium/high/xhigh`；`sol-max` 只服务 Advisor/frontier，`terra-xhigh/max` 仅为 disabled catalog 项。`stage-model-pool.v4` 已移除全部 `luna-*` profile，两个 narrow-deep-cost-sensitive route cell 精确映射到 `terra-high`，旧 Luna route/receipt 统一在 actor spawn 前以 `stage-model-pool-luna-profile-retired` 拒绝，不提供 alias 或 compatibility fallback。安装不运行付费模型比较。logical capability selection 不含 sandbox 或 runtime permission label。UI implementation 永久限 `sol-low`/`sol-medium`，超出能力必须重切片或停止进入 fresh observe-only adjudication。

`writer-stage.output-missing` 不能按次数或措辞变化重路由。Failure、retry、rework 和 `profile-capability-mismatch` 都不能推进 profile，runtime 不提供 `compileExecutionReroute`。只有独立修订的 semantic classification 或 executable slice 才能作为新 dispatch 输入重新调用 canonical compiler，并绑定旧 failure/route/candidate receipt、breaker reset/retry authorization、不同的新 candidate identity及可观察 requested/effective runtime metadata。Acceptance-group member、landing conflict 和 reverification各自独立编译 route；Telemetry只消费 route/outcome receipt作观察，不反向控制 correctness。Quiescence inventory必须保留 route decision、failure、retry和runtime receipt的引用，资源清理由机器 verifier签发。

Documentation 仅在 behavior-green，且 UI work 已 ux-accepted 后启动；普通同步使用 `terra-medium`，跨文档 authority 迁移可使用 `terra-high`，不得按余额、失败次数、reworkCount、telemetry 或人工偏好切换。UI/UX stage 必须从目标仓库当前指令与机器 load evidence 取得一个或多个 caller-supplied design-authority Skill exact digest；本仓不内置仓名或设计 Skill 名。`uiDecisionClass=system-design-dispute` 时必须先由 fresh observe-only `ui-system-adjudicator` 使用 `sol-high`/`sol-xhigh` 输出 machine-readable owner、边界、design authority 和允许的 low/medium implementation class；裁决者没有实现权。behavior verification、UX acceptance 和 adjudication 都必须 fresh、observe-only 且不继承 implementer 对话；每个结果必须绑定 passed mutation postcondition。group continuity 必须重新按 member 分类和 routing，不能继承上一 member 的 profile、权限或 verifier context。

旧 `issue-implementer`、`issue-reviewer`、`cleanup-verifier` role/agent alias，以及 node-local `model`/`effort`、`implementationProfile`、`reviewProfile` 均无 authority 或 fallback。Code/UI implementer 不能签 behavior/UX receipt；behavior verification 仍由冻结合同的独立 `test-owner` 执行。Cleanup 不进入 LLM model pool：确定性 resource registry、inventory 和 machine resource verifier 才能签发 `resources-clean`，异常诊断可读但不能替代机器绿色 authority。

dispatch receipt `issue-orchestration.dispatch-receipt.v2` 只有在 request digest、runtime metadata digest、thread/rollout identity、prompt/DAG/frontier/base/candidate/epoch、routing policy/input、execution class/mutation contract、runtime execution binding、effective model/effort/permission/fork/cwd/profile、Skills/capability 和 group/member/lease 全部一致时才是 `verified`。`implementation.started` 必须引用 verified v2 dispatch receipt；`implementation.candidate-green` 必须引用同一 request/base/candidate/attempt/epoch 的 `issue-orchestration.implementer-self-test-receipt.v2`，其 visible matrix、命令结果、failure history/fix cycle、frozen test tree、working-tree 和 modified paths 均由 deterministic machine verifier 封存。`independent-verification.passed` 只能引用 `issue-orchestration.behavior-receipt.v3`，且必须由 fresh、observe-only 的 `test-owner` 产生并绑定 passed mutation postcondition；不得用 self-test receipt、implementer 自述或旧 verifier 代替。旧 dispatch/self-test/behavior receipts 仅可读取为 historical evidence，不能授权 current transition。

## Run control ledger、per-node ledger 与 aggregate projection

运行状态采用两级持久化模型，普通 stage 事件不再写入 run-wide ledger：

```text
<state-root>/runs/<run-key>/
  control-ledger.jsonl
  control-projection.json
  node-index.json
  aggregate-runtime-projection.json
  nodes/<node-key>/
    event-ledger.jsonl
    projection.json
    writer-attempts/<attempt-key>/...
```

`issue-orchestration.control-ledger.v1` 只允许 scope/remote refresh、node registration/removal/tombstone、dependency/acceptance-group 更新、slot/batch 决策、delivery freeze/effect、cleanup finalization 和 run terminalization。Implementation checkpoint、writer failure、slice terminal、candidate、behavior 或其它 node-local event 写入 control ledger 时必须在任何字节追加前失败。

每个普通节点拥有独立的 `issue-orchestration.node-ledger.v1`。Header 不可变地绑定 run/node/member、repository、issue number、selector receipt、remote member、node epoch、external state root、base SHA 和 remote/repository fingerprints，并由 `headerDigest` 封存。节点事件使用 `issue-orchestration.event.v2`；event 的 node identity 必须等于 header，跨节点 append 必须在写入前拒绝。旧 `issue-orchestration.ledger.v2` run-wide writer ledger 仅返回一次性迁移错误，不存在兼容写入模式。

每个 node ledger 有自己的 sequence、hash-chain head、projection 和 writer-attempt directory。两个节点可并发 append，且不得共享序列或 authority path。节点 projection 使用 `issue-orchestration.node-projection.v1`，只由该节点 ledger replay 产生。

`node-index.json` 使用 `issue-orchestration.node-index.v1`，把每个 active node 绑定到规范 ledger/projection 相对路径、ledger head digest、projection digest 和 verified/quarantined 状态。`issue-orchestration.aggregate-runtime-projection.v1` 只能消费已重放验证的 control projection 与 index 中逐个验证的 node projection，确定性暴露全部节点 lifecycle、active attempt、dependency readiness、acceptance group、candidate/delivery 和 slot 状态。它不能信任调用方提供的 projection JSON 摘要。

恢复时先 replay control ledger，再按 node index replay 每个 node ledger。单一 node ledger 损坏只 quarantine 该节点；无依赖的其它 ready node 仍可派发，依赖该节点的后继必须带 typed evidence blocked。Push、issue close、delivery completion 和 cleanup finalization 等 exactly-once run effect 只通过 control ledger 序列化；相同 effect key 的重放或重试不得重复执行远端副作用。

所有写入都位于 external state root，使用受控 JSONL append 与 fsync/atomic rename。仓库 source、install root、工作区和任何 worktree 中出现 `control-ledger.jsonl`、`node-index.json`、node `event-ledger.jsonl`、projection 或 writer-attempt state 都视为 runtime-state leak。

## Grouped delivery window

Acceptance-group delivery 在窗口开始前记录 `preWindowRemoteSnapshotDigest`。一次 push 和窗口内逐 issue side effect 完成后，只做一次 live remote refresh，形成 `postWindowReceipt`；refresh 必须标记为 `post-window`、`live-remote` 且确实发生在 side effect 之后。禁止按 member 刷新、用本地推算替代真实刷新，或因已知 side effect 跳过窗口末刷新。

窗口中断时，恢复记录已完成的远端 side effect，并在恢复后重新取得 live snapshot；不得继续使用 pre-window scope。窗口最多产生一次 DAG updater launch，且仅当窗口末 digest 与 pre-window digest 不同。

## Stable denial codes and checks

调用方应保留以下错误码，便于故障定位：`invalid-selector-schema`、`selector-version-parameters-mismatch`、`dag-launch-required`、`dag-launch-denied`、`proposal-mismatch`、`delivery-window-invalid`、`writer-stage.invocation-failed`、`writer-stage.environment-failed`、`writer-stage.runtime-capability-missing`、`writer-stage.first-action-not-executed`、`writer-stage.output-missing`、`writer-stage.checkpoint-missing` 和 `writer-stage.receipt-rejected`。这些拒绝表示合同不满足，不应通过重试未变化的 selector、snapshot、launch request 或 writer semantic identity 绕过。

Selector 行为合同位于 `tests/tools/issue-orchestration-scope-selector.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/scope-selector-cases.json`，实现入口为 `skills/issue-orchestration/scripts/scope-selector.mjs`；frontier 行为合同位于 `tests/tools/issue-orchestration-ready-frontier.test.mjs`，实现入口为 `skills/issue-orchestration/scripts/frontier-compiler.mjs`；stage model pool 行为合同位于 `tests/tools/issue-orchestration-stage-profiles.test.mjs`，其 v2 acceptance/mutation/runtime fixtures 位于 `tests/fixtures/issue-orchestration/stage-profile-*.json`，实现入口为 `skills/issue-orchestration/scripts/stage-profile-policy.mjs`；event ledger 行为合同位于 `tests/tools/issue-orchestration-event-ledger.test.mjs`，其 acceptance/mutation/runtime fixtures 位于 `tests/fixtures/issue-orchestration/event-ledger-*.json`，实现入口为 `skills/issue-orchestration/scripts/event-ledger.mjs`；dispatch/runtime/self-test 行为合同位于 `tests/tools/issue-orchestration-dispatch-receipt.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/dispatch-receipt-*.json`，实现入口为 `skills/issue-orchestration/scripts/dispatch-receipt.mjs`；semantic graph/runtime projection 行为合同位于 `tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs`，fixture 位于 `tests/fixtures/issue-orchestration/semantic-runtime-projection-*.json`，实现入口为 `skills/issue-orchestration/scripts/semantic-runtime-projection.mjs`。修改 selector、snapshot、frontier、stage model pool、ledger、dispatch receipt 或 semantic/runtime projection 合同时运行：

```bash
node --test tests/tools/issue-orchestration-scope-selector.test.mjs
node --test tests/tools/issue-orchestration-ready-frontier.test.mjs
node --test tests/tools/issue-orchestration-stage-profiles.test.mjs
node --test tests/tools/issue-orchestration-dispatch-receipt.test.mjs
node --test tests/tools/issue-orchestration-event-ledger.test.mjs
node --check skills/issue-orchestration/scripts/dispatch-receipt.mjs
node --test tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs
node tools/docs/generate-document-lifecycle.mjs --check
node tools/docs/check-authoritative-development-docs.mjs
```

Writer 永久合同由三个冻结测试和一个永久 integration contract 共同约束：`tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs` 与 `tests/tools/issue-orchestration-progress-checkpoint.test.mjs` 的唯一 runtime owner 是 `executable-slice-compiler.mjs`；`tests/tools/issue-orchestration-writer-stage-failure.test.mjs` 的唯一 runtime owner 是 `writer-stage-progress.mjs`；`tests/tools/issue-orchestration-issue-1874-permanent-contract.test.mjs` 绑定八个 schemas、两个 canonical runtime owners、固定七角色和冻结 test-tree audit。修改 writer plan/slice/prompt/checkpoint/continuation/terminal/failure/retry 合同时运行：

```bash
node --test tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs
node --test tests/tools/issue-orchestration-progress-checkpoint.test.mjs
node --test tests/tools/issue-orchestration-writer-stage-failure.test.mjs
node --test tests/tools/issue-orchestration-issue-1874-permanent-contract.test.mjs
node --check skills/issue-orchestration/scripts/executable-slice-compiler.mjs
node --check skills/issue-orchestration/scripts/writer-stage-progress.mjs
```

本合同不自动创建远端 issue，也不改变产品代码、API、数据库、发布或前端运行时。
