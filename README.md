# issue-orchestration

Permanent multi-issue orchestration Skill and runtime shared by
`Ozwasyd/FsusBlog` and `Ozwasyd/FsusUI`.

This repository is the only editable source for the Skill, runtime scripts,
contracts, policies, graph schemas, and agent definitions. Runtime state must
remain outside this repository and outside every product worktree.

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

```bash
npm ci --prefix tools/test-matrix/schema-validator
node --test --test-concurrency=1 \
  tests/tools/issue-orchestration-*.test.mjs \
  tests/tools/issue-orchestration/*.test.mjs
```

Live Codex and remote acceptance lanes remain opt-in through their documented
environment variables.
