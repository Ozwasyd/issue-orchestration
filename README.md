# issue-orchestration

Permanent multi-issue orchestration Skill and runtime shared by
`Ozwasyd/FsusBlog` and `Ozwasyd/FsusUI`.

This repository is the only editable source for the Skill, runtime scripts,
contracts, policies, graph schemas, and agent definitions. Runtime state must
remain outside this repository and outside every product worktree.

## Install for Codex discovery

Use Codex's built-in `skill-installer` with private repository
`Ozwasyd/issue-orchestration` and path `skills/issue-orchestration`. It installs
the Skill into `$CODEX_HOME/skills/issue-orchestration`; a new Codex turn or
session will then discover it.

## Install for the shared projects workspace

Build the manifest after source changes, commit the resulting source, and then
install the committed package into the common workspace:

```bash
node scripts/build-manifest.mjs
node scripts/install-workspace.mjs \
  --source-root "$PWD" \
  --workspace-root /home/lyuaoss/projects
node scripts/verify-workspace-install.mjs \
  --source-root "$PWD" \
  --workspace-root /home/lyuaoss/projects
```

The workspace installer owns only the files listed in
`/home/lyuaoss/projects/.agents/issue-orchestration-install.json`. It refuses
unknown target files, symbolic links, source drift, and version drift; it does
not replace other workspace or repository Skills.

The isolated install flow remains available through `scripts/install.mjs`,
`scripts/verify-install.mjs`, and `scripts/uninstall.mjs`.

## Tests

Product integration tests resolve sibling `FsusBlog` and `FsusUI`
repositories by default. Set `FSUSBLOG_ROOT` or `FSUSUI_ROOT` to override
those locations.

```bash
npm ci --prefix tools/test-matrix/schema-validator
node --test --test-concurrency=1 \
  tests/tools/issue-orchestration-*.test.mjs \
  tests/tools/issue-orchestration/*.test.mjs
```

The default command is fixture-only: it does not launch Codex, consume a paid
model, or mutate a remote:

```bash
node --test --test-concurrency=1 \
  tests/tools/issue-orchestration/*.test.mjs
```

The permanent live acceptance is explicitly opt-in:

```bash
FSUSBLOG_E2E_LIVE=1 node --test --test-concurrency=1 \
  tests/tools/issue-orchestration/*.test.mjs
```

Live mode requires authenticated Codex and read-only GitHub access plus clean,
single-worktree, single-branch, remote-synchronized checkouts of this
repository, FsusBlog, and FsusUI. It installs the current committed Skill into
an isolated standard Codex home and proves discovery from five fresh sessions.
It also executes non-zero child test groups, an isolated local Git/bare-remote
landing, a live observe-only quiescence collection, and all mutation controls.
It deletes its isolated home, workspaces, Git remote, and state root, then
proves all three repositories are unchanged. No product remote is mutated.
