# 派发与运行时探针

<!-- Shared package authority. -->

本文件是派发前调查、最小真实探针、闭环 prompt 和实现者行为的唯一详细来源。

## 派发前调查

根代理在每次派发前亲自完成以下工作：

1. 读取完整 issue、全部范围约束和会改变验收的评论；
2. 记录目标仓库的 base SHA、当前分支、dirty state、适用的 `AGENTS.md` / override 指令链；
3. 读取相邻实现、直接测试、依赖关系和本次改动相关的 current 文档；
4. 查明已确认事实、责任仓、设计方案、允许修改边界、禁止范围和验收组；
5. 核对仓库事实与调度策略是否属于不同权威层。

信息不足、base SHA 漂移、owner 未确定或设计仍有分叉时不得派发。继续调查并刷新 DAG；不得把选择题交给实现者。

## 最小真实探针

当任务依赖 Docker、systemd、数据库、浏览器、包管理器或其他外部运行时语义时，派发前运行能确认关键行为的最小真实探针。每条探针记录：

- base SHA 与 dirty state；
- 操作系统、工具/服务版本及影响结论的环境设置；
- cwd、精确命令、输入和前置状态；
- 原始输出、退出状态和证据位置；
- 观察结论、限制及由此新增的动态验收条件。

把观察结论和动态验收直接填入任务模板。静态字符串、mock、文件名、源码推断或网络文章不能成为外部运行时边界的唯一证据。

纯代码任务不机械增加外部探针。完整 build、Fresh、consumer、visual 或性能验收通常不是“最小探针”；只有关键行为无法用更小真实动作确认时才运行，并明确成本。

探针不得执行未经任务授权的 push、issue close、包发布或生产状态修改。缺少依赖时，可按当前环境提供的凭据安装；任何凭据、token 或秘密都不得写入 prompt、DAG、日志摘要或受跟踪文件。

## 闭环 prompt

复制并完整填写 [`../templates/subagent-task.md`](../templates/subagent-task.md)。所有字段必须有已调查的值；确实不适用时写明“不适用”及事实理由。

禁止：

- 只转发 issue、标题或评论；
- 使用“全面检查并修好”等开放式指令；
- 省略隐含验收、反例、失败分类或停止条件；
- 把 owner、方案、范围、兼容策略或测试强度留给实现者选择；
- 允许兼容兜底、绕过、降级、阈值放宽、正确基线刷新或测试弱化。

填完后逐项对照原始 issue、代码事实和适用仓库指令。任何冲突都由根代理先解决。

## Implementer contract

具体 stage implementer（`code_implementer` 或 `ui_ux_implementer`）只执行已填充的闭环 prompt：

- 仅在允许路径内修改指定代码、测试和文档；
- 执行 prompt 指定的局部验收；
- 按验收条件逐项返回文件、命令、退出结果与直接证据；
- 明确列出未运行项、风险和未解决事实。

实现者只接收当前节点的任务投影，不接收状态根路径或完整 DAG。不得读取或修改完整 DAG、ledger、槽位、锁、issue 状态或恢复指纹；不得扩大范围、重新设计、添加未授权兼容层、猜测隐含要求、伪造或弱化测试、放宽阈值、刷新正确基线，也不得 push、发布包、评论或关闭 issue。状态汇报不是交付物。

若 prompt 与代码事实冲突，或发现范围外异常，停止相关修改并上报路径、事实和影响；不得猜测处理。根代理调查后把确认的实现缺陷或返工按 DAG 规则入图。

## 派发

使用共享 package custom agent `code_implementer` 或 `ui_ux_implementer`，传入完整模板内容，并按 [`dag-and-scheduling.md`](dag-and-scheduling.md) 传递 routing compiler 生成的 stage assignment 与非 full-history fork。角色文件只负责加载本合同，不拥有模型选择规则；实际 requested/effective profile 必须由 `stage-model-pool.v2` receipt 证明。

实现者返回后，根代理先检查实际 diff、产物和局部 evidence 是否存在，再进入 independent verification；不得用完成声明代替产出。
