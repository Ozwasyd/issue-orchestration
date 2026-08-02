# 验收组交付

<!-- Shared package authority. -->

本文件是重合验收组、立即交付、默认分支、worktree、本地 alias 与跨仓 owner 的唯一详细来源。

## 交付单位

重合验收组是验证、提交、推送和关闭的单位；单独成组的 issue 使用相同流程。组内每个 writer stage 必须先通过自己的 ordered slice terminal gate；非最终 slice、partial checkpoint 或 continuation 不能让 member 进入候选或交付。组内所有 issue 在全部必要验收通过前保持 open。

跨仓验收组可包含按依赖排序的 FsusUI 与 FsusBlog 交付 leg。每个 leg 在责任仓形成独立 commit 并推该仓默认分支；只有全部 leg 的远端 commit 和验收仍有效后，才关闭组内 issues。

## 立即交付

一组通过后，根代理立即：

1. 复读组内 issue、验收条件、实际 diff、evidence 与未运行项；
2. 检查两仓 `git status`，只暂存本组文件，不带入用户无关改动；
3. 按各仓 current 变更契约生成 commit；FsusBlog 使用 `master`，FsusUI 使用 `main`，除非该仓最近的适用指令明确改变；
4. 由根代理直接 push 对应默认分支；
5. 复读远端 commit 与 issue 状态，提交需要的完成评论并核验组内 issues 已关闭；
6. 更新运行态 DAG 和 evidence。

不得等待无关 issue、全仓最终验收、其他分支、其他任务或长任务。不得用 draft PR、临时发布或“稍后统一交付”替代上述流程。

dry-run 必须生成同样的逐步交付计划，但停在第一个 commit、push、评论或 close 动作之前，并明确标记未执行；不得伪造远端结果。

## Landing conflict writer

Landing 时出现的真实 conflict 仍是 writer work，必须编译 `issue-orchestration.stage-work-plan.v1 → issue-orchestration.executable-slice.v1 → issue-orchestration.compiled-dispatch-prompt.v1`，并用 checkpoint、continuation 与 ordered terminal receipts 收口。代码 conflict 由 `code-implementer` 执行；UI conflict 由 `ui-ux-implementer` 执行。Root 只编译、验证、路由与落地已经 terminal 的产出，不直接编辑冲突，也不得新增 `landing-owner` 或其它第八个角色。

Landing conflict slice 必须绑定冲突 mapping、允许/禁止路径、base/epoch/worktree、required commands 和 material diff evidence。只有该 landing stage 的 final slice gate 通过后才可继续 commit/push；原 member 的旧 terminal receipt 不能替代新冲突基线上的 receipt。

## CI evidence 与关闭

交付后把自动化结果严格区分为三类：

| 状态 | 语义 | 动作 |
| --- | --- | --- |
| CI 实际执行并通过 | 已取得 CI pass evidence | 与其他验收 evidence 一并复核 |
| CI 未创建或未启动 | 未取得 CI evidence；包括额度、计费、spending limit 或平台自动化不可用 | 不得写成 pass；按下述等价本地门禁判断能否 completed |
| CI 实际执行并失败 | 已取得真实失败 evidence | 进入实现/测试/环境/调用分类，不得使用未执行例外 |

CI 未创建或未启动时，只有以下条件全部成立，才不得以该外部状态为唯一理由阻止 issue 以 `completed` 关闭：

1. 实现已经提交并推送到目标默认分支，且远端 commit 内容已复读；
2. 所有可在本地等价执行的必需验收在同一候选基线通过，并记录命令、环境、退出状态和 evidence；
3. 未执行 CI 与本地验收之间不存在已知语义缺口；存在不可本地替代的强制 CI 专属门禁时不适用；
4. 当前不存在已知实现、产品、公开契约、安全或测试缺陷；
5. 完成评论明确列出未执行 checks、外部原因、等价本地命令和结果，且不声称 CI passed。

候选 SHA 漂移、本地等价验收失败、CI 实际失败或存在不可替代 CI 专属门禁时，issue 保持 open 并进入正常失败分类。不得放宽阈值、弱化/删除测试、刷新正确基线或把真实失败改写成计费问题。

workflow 后续恢复并在已关闭候选上暴露真实缺陷时，重新打开原 issue，或在边界已独立时建立引用原 issue 与 commit 的原子缺陷 issue。

关闭前把上述事实写入状态根内 `issue-orchestration.delivery-evidence.v1` JSON，并运行：

```bash
node .agents/skills/issue-orchestration/scripts/evaluate-delivery-closure.mjs \
  --state-root <state-root> \
  --input <state-root>/delivery-evidence.json \
  --repository <FsusBlog-root> \
  --repository <FsusUI-root> \
  --workspace <common-or-launch-workspace>
```

只有输出 `closeAllowed=true` 才执行 close。该脚本只判定关闭门禁，不评论、不关闭 issue，也不把 `not_started` 转写为 CI pass。

## 分支与 worktree

可为隔离本地实现使用分支或 worktree，但只有根代理可直接 push `master`/`main`。不得创建或遗留无意义的 `codex/*` 分支、draft PR、worktree、锁或无关提交。验收组交付或放弃后，先核对远端与本地引用，再清理只属于该组的临时资源。

## 两仓 alias 与 owner

交付前解析实际生效的 FsusBlog→FsusUI 本地 alias，记录 FsusUI 绝对路径、HEAD 和 dirty state。两仓同步通过该 alias 验证；禁止为了同步发布 npm、NuGet 或其他包。

跨仓缺陷修复责任仓。可复用组件、公开 token、组件状态、共享 motion、键盘或共享可访问性缺陷归 FsusUI；产品路由、文案、组合和 FsusBlog 语义归 FsusBlog，具体事实仍以两个设计 Skill 与 current 文档为准。不得在调用仓添加兼容兜底、私有 selector 修补、假 token、组件 fork 或降级路径来隐藏责任仓缺陷。

## Terminal 前本地交付

将 issue 转为 terminal candidate 前，完成并推送全部本地可行工作；若这部分与其他 issue 重合，按正常验收组交付。随后回到 [`dag-and-scheduling.md`](dag-and-scheduling.md) 的 Terminal 合同：issue 保持 open，并使用那里唯一规定的证据、评论、恢复条件和重派门禁。

CI 计费、额度或平台侧未启动 job 不能单独成为 terminal blocker。满足本文件等价本地关闭门禁时直接 completed；只有存在不可替代的强制 CI 专属门禁或其他直接外部阻碍时，才可能按 DAG reference 进入 `externally_blocked`。
