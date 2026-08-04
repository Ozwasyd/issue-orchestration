# 派发与运行时探针

<!-- Shared package authority. -->

本文件是派发前调查、最小真实探针、verified stage work plan、executable slice、compiled prompt 和 writer 行为的唯一详细来源。

## 派发前调查

每次派发前，由 fresh-context、observe-only semantic agent 完成以下工作并产生
有界 `dispatch-investigation-projection.v1`；Root 只校验 fingerprint、缓存与
receipt identity，不读取完整 issue、完整 DAG/state 或语义源文件：

1. 读取完整 issue、全部范围约束和会改变验收的评论；
2. 记录目标仓库的 base SHA、当前分支、dirty state、适用的 `AGENTS.md` / override 指令链；
3. 读取相邻实现、直接测试、依赖关系和本次改动相关的 current 文档；
4. 查明已确认事实、责任仓、设计方案、允许修改边界、禁止范围和验收组；
5. 核对仓库事实与调度策略是否属于不同权威层。

信息不足、base SHA 漂移、owner 未确定或设计仍有分叉时不得派发。继续由对应语义 agent 调查并刷新投影；不得由 Root 补写结论或把选择题交给 writer。

## 最小真实探针

当任务依赖 Docker、systemd、数据库、浏览器、包管理器或其他外部运行时语义时，派发前运行能确认关键行为的最小真实探针。每条探针记录：

- base SHA 与 dirty state；
- 操作系统、工具/服务版本及影响结论的环境设置；
- cwd、精确命令、输入和前置状态；
- 原始输出、退出状态和证据位置；
- 观察结论、限制及由此新增的动态验收条件。

把观察结论和动态验收写入 stage work plan 的输入证据。静态字符串、mock、文件名、源码推断或网络文章不能成为外部运行时边界的唯一证据。

纯代码任务不机械增加外部探针。完整 build、Fresh、consumer、visual 或性能验收通常不是“最小探针”；只有关键行为无法用更小真实动作确认时才运行，并明确成本。

探针不得执行未经任务授权的 push、issue close、包发布或生产状态修改。缺少依赖时，可按当前环境提供的凭据安装；任何凭据、token 或秘密都不得写入 prompt、DAG、日志摘要或受跟踪文件。

## Verified plan、slice 与 compiled prompt

完整 issue 不是 writer 任务。新节点只能通过公共
`advanceTestContractColdStart` 推进。Fresh observe-only
`dag-creator-updater:semantic-proposal` 只提交 discovery/classification 与
requirement-classification proposal；确定性 compiler 从 selector receipt、
当前 remote member facts、accepted proposal 和 title/body/relevant-comment
规范来源块精确编译 immutable requirement inventory、acceptance contract 与
`node-discovered-receipt.v1`。Root 只能接受或拒绝 typed proposal，不能增删改
requirement、acceptance scope、test scope、slice 或 prompt。随后 fresh
observe-only `test-owner:test-contract-planning` 必须在一个绑定响应中产生
planning receipt、issue-specific dispatch investigation 与 test-contract writer
slice proposal；`slice-plan-validator.mjs` 再独立验证 acceptance/command
ownership、无环顺序、路径、first action 与 capacity。Canonical compiler 只
处理通过验证的投影：

1. `compileStageWorkPlan(input)` 生成并验证 `issue-orchestration.stage-work-plan.v1`；
2. `compileExecutableSlice({ plan, sliceId })` 只提取当前 `issue-orchestration.executable-slice.v1`；
3. `compileDispatchPrompt({ plan, slice })` 确定性生成 `issue-orchestration.compiled-dispatch-prompt.v1`；
4. `validateCompiledDispatchPrompt({ plan, slice, compiled })` 在派发前重算并核对 plan、slice、stage 和 prompt digest。

Work plan 必须绑定 run/repository/issue/node、stage role/phase、base SHA、epoch、worktree identity、semantic/test/authority/Skill/baseline/routing digests、单一 stage objective、全部 acceptance items、有序 slices、slice dependency graph、stage 允许/禁止路径、required commands 和 terminal artifacts。每条 acceptance 与 required command 都必须恰好有 slice owner；遗漏、重复或无 owner 都 fail closed。

每个 slice 只允许一个有界 objective，并绑定 first required action、read targets、允许写路径或只读输出、forbidden paths、required files/commands/evidence、non-goals、completion/continuation predicates 和 thresholds。阈值至少限制 changed files、modules、read operations、无产出调用与 duration class；达到阈值前没有 terminal artifact 时必须 checkpoint，不得继续开放式调查。

Root 只能调用 compiler/validator、选择已 ready 的 slice 并传递编译结果。Root 不得手写、补写、删减或改写 compiled prompt，也不得直接把 issue 正文、标题、评论或“全面检查并修好”之类开放式指令派发给 writer。[`../templates/subagent-task.md`](../templates/subagent-task.md) 只能是 compiled prompt 的 renderer；模板内容与编译结果不一致时以机器验证失败处理，不能人工修补 digest。

Writer stage 与永久输出合同如下：

| Stage phase | Writer role | 必需输出 |
| --- | --- | --- |
| `test-contract-planning` | `test-owner` | fresh observe-only planning receipt及 passed mutation postcondition；不得写文件 |
| `test-contract` | `test-owner` | tests/fixtures、命令证据、checkpoint |
| `implementation` | `code-implementer` | diff、命令证据、checkpoint |
| `ui-implementation` | `ui-ux-implementer` | diff、render evidence、checkpoint |
| `documentation` | `documentation-writer` | diff 或 verified no-change evidence、checkpoint |
| `landing-conflict-resolution` | `code-implementer` 或 `ui-ux-implementer` | conflict mapping、diff、checkpoint |

Landing 不定义 `landing-owner`；共享 package 永久角色总数仍为七个。某次修复批次直接授权 Sol Ultra 实现永久能力，不会改变上述 writer role、`stage-model-pool.v3` 或永久 routing policy。

首次 test-contract writer 不允许依赖虚构历史或空白 attempt。固定冷启动顺序
是：selector/remote freshness → accepted semantic proposal → deterministic
requirement inventory/acceptance contract/`node-discovered-receipt.v1` → fresh
observe-only planning bundle → validated slice/work plan/compiled prompt → pending
canonical route selection → exclusive lease/resource acquisition → runtime-bound
final route → `stage.contract-frozen` → fresh writer dispatch。Planning 与 writer
必须是不同 rollout/thread；`node.discovered` 只包含 discovery/acceptance freeze
时已存在的事实，不能携带 test contract、writer paths、commands、plan、slice、
prompt、candidate 或 verification history。只有 planning bundle、slice validation、
work plan、executable slice、route、prompt 与 resource mutually digest-bound 后才
能追加 `stage.contract-frozen`。历史 bootstrap、旧 runner、旧 checkpoint、
`preexistingFrozenContract`、caller-supplied authority 或完整 issue body 都不能替代。

## Implementer contract

具体 stage writer 只执行已验证的 compiled prompt：

- 仅在允许路径内修改指定代码、测试和文档；
- 先执行 slice 的 first required action，再执行指定的局部验收；
- 按验收条件逐项返回文件、命令、退出结果与直接证据；
- 在达到 slice threshold 前返回 complete checkpoint 和 terminal artifacts，或返回 partial checkpoint 与 continuation；
- 明确列出未运行项、风险和未解决事实。

Writer 只接收当前 slice 投影，不接收状态根路径、完整 issue 或完整 DAG。不得读取或修改完整 DAG、ledger、槽位、锁、issue 状态或恢复指纹；不得扩大范围、重新设计、添加未授权兼容层、猜测隐含要求、伪造或弱化测试、放宽阈值、刷新正确基线，也不得 push、发布包、评论或关闭 issue。状态汇报和自然语言“已完成”不是 checkpoint 或 terminal artifact。

`sealProgressCheckpoint` / `validateProgressCheckpoint` 只接受真实 filesystem、Git 和 command evidence：文件 realpath 与 `git hash-object`、HEAD/status、命令 exit/output digest、tree/diff/command/evidence digests，以及精确 cursor。Partial checkpoint 必须给出 `nextRequiredAction` 且不能 candidate-green；complete checkpoint 的该字段必须为 `null`。`compileContinuation` 必须绑定原 run/node/base/epoch/worktree/plan/slice/checkpoint/cursor 并保持 `restartInvestigation=false`，只能从 cursor 的下一动作恢复，不能从 issue 正文重新开始。

若 compiled prompt 与代码事实冲突，或发现范围外异常，停止相关修改并返回绑定当前 slice 的 checkpoint、路径、事实和影响；不得猜测处理。Root 调查后只能通过新 verified plan/slice 或合法 material retry authorization 改变任务。

## 派发

使用共享 package 中当前 stage 对应的 writer role，传入通过验证的 compiled prompt，并按 [`dag-and-scheduling.md`](dag-and-scheduling.md) 先对 verified slice 调用唯一 `canonical-route-cell-compiler`。Dispatch request/receipt 必须绑定 plan、slice、execution shape、capability requirement、reviewed routing assumption、exact route decision、compiled prompt 和非 full-history fork；任何 identity 漂移都必须拒绝。角色文件只负责加载本合同，不拥有模型选择规则。实际 requested/effective model、effort、permission profile、permission inheritance、cwd、checkpoint 与 continuation capability 必须由受信、per-dispatch runtime observation 证明；不可观察时 fail closed。`trusted-owner-repositories` 下 Codex V2 child 可以继承 Root 的 `danger-full-access`，该事实必须进入 route/run/terminal permission evidence，不能写成 child machine-enforced read-only。语义 authority 仍由 stage contract 限制，权限或 credential 的技术可用性不授予 writer、landing、delivery 或 independent-verifier authority。

Writer spawn 前必须创建在线 watchdog；运行中逐事件校验 first action/artifact、
read/no-artifact/time budgets、command heartbeat/lease、cancel acknowledgment
与 checkpoint/terminal artifact。预算越界、heartbeat 丢失或取消不收敛时
先取消 writer、封存 trace，再 fail closed，不能在返回后补造证据。Writer
返回后，Root 调用机器 gate 校验 watchdog receipt、checkpoint、terminal
receipt、实际 diff/产物和局部 evidence。非最终 slice 的合法结果只能是
`next-slice`；只有 final slice 及此前所有有序 terminal receipts 全部有效，
stage 才能进入 `candidate-green` 和 independent verification。失败语义、
breaker 与 retry 见 [`review-failure-and-verification.md`](review-failure-and-verification.md)。
