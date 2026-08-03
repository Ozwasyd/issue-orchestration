# Repository guidance

This repository owns the permanent `issue-orchestration` Skill package. Keep
product API, design, documentation, and runtime authority in FsusBlog and
FsusUI; consume those repositories at verification time instead of copying
their authority here.

Do not use the installed Skill to modify its own source. Runtime state, DAGs,
receipts, ledgers, worktrees, and generated execution artifacts must stay
outside this repository.

After changing an installable artifact, rebuild `manifest.json`, run focused
tests, and verify a clean workspace installation before publishing.
