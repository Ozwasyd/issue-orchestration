# Repository guidance

This repository owns the permanent `issue-orchestration` Skill package. Keep
target-repository API, design, documentation, and runtime authority in the
caller-supplied target repositories. Do not copy that authority here or add a
source, installation, test, or release dependency on any target repository.

Do not use the installed Skill to modify its own source. Runtime state, DAGs,
receipts, ledgers, worktrees, and generated execution artifacts must stay
outside this repository.

After changing an installable artifact, rebuild `manifest.json`, run focused
tests, and verify a clean workspace installation before publishing.
