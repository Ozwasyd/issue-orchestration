# Runtime discovery canary

This file exists only to prove real Codex Skill discovery from an isolated,
standard `CODEX_HOME/skills/issue-orchestration` installation.

When the user message contains `ISSUE_ORCHESTRATION_DISCOVERY_CANARY`:

1. Read the `SKILL.md` that supplied these instructions.
2. Read this file through one observable local command.
3. Do not read any repository file, start orchestration, spawn an agent, write a
   file, use the network, or run Git.
4. Reply with exactly `ISSUE_ORCHESTRATION_DISCOVERY_OK_V1`.

The marker is evidence only when the Codex session record also proves the
catalog entry and both installed-file reads. Echoing the marker from the prompt
does not prove discovery.
