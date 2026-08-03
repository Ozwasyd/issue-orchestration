# issue-orchestration

Permanent, repository-independent multi-issue orchestration Skill and runtime.

This repository is the only editable source for the Skill, runtime scripts,
contracts, policies, graph schemas, and agent definitions. Runtime state must
remain outside this repository and outside every product worktree.

It builds, tests, installs, and runs its permanent acceptance suite from this
checkout alone. It has no source, test, installation, issue-API,
sibling-checkout, or release dependency on a target repository.

## Runtime trust model

The supported unattended mode is `trusted-owner-repositories`. The root
scheduler runs with `approval_policy=never` and an observed
`danger-full-access` permission profile. Codex V2 children may inherit that
effective profile; the package therefore does not claim machine-enforced
per-child read-only isolation.

`policy/runtime-trust-policy.json` admits only repositories explicitly supplied
for the current run by the operator. It contains no product-repository
allowlist. Startup and continuation fail closed when an origin URL cannot be
resolved, does not match the caller-supplied identity, or drifts after the trust
binding was compiled. Role separation remains semantic and receipt-based, with
required mutation postconditions. Full runtime access does not authorize Root
to author target-repository code, tests, UI, or documentation.

This threat model is only for repositories owned and trusted by the operator.
It is unsuitable for third-party, untrusted, or multi-tenant workloads. A
future `strict-machine-isolation` mode remains explicitly representable but is
disabled; it is never silently mapped to the trusted-owner mode.

## Startup attestation

Unattended orchestration is unsupported until a launcher/runtime-owned
`runtime-startup-observation.v1` has passed the deterministic
`runtime-startup-attestation.v1` preflight. Before that receipt is verified,
the runtime may load package policy and collect the trusted observation only;
it may not inspect repositories or remote issues, select scope, restore a DAG,
write runtime state, allocate resources, or start an actor.

Normal `root-scheduler:scheduling` is permanently `terra-low`. A
`terra-medium` root is valid only in the separate
`root-scheduler:recovery-takeover` phase for a newly launched parent
invocation whose machine takeover authorization, bounded handoff, old-root
fencing, and new authority epoch all validate. A recovery flag or medium
child cannot upgrade a running low root. All later control receipts bind the
startup attestation and invocation; runtime or policy drift blocks the next
side effect.

## Execution and mutation authority

Stage semantics use `root-control`, `observe-only`, and `leased-writer`.
Logical model selection never grants filesystem or remote authority and never
uses sandbox names as profile capabilities. A separate runtime execution
binding records the actual permission profile and inheritance behavior.

Every accepted stage result requires a machine-owned pre/post mutation
receipt. Observe-only actors must leave protected repository, control-plane,
and remote state unchanged. Leased writers must remain inside the current
lease and slice allowlist. Remote mutation is exclusive to root-control and
requires a fresh delivery-control receipt plus verified before/after remote
snapshots.

Unknown complex control-plane failures may use one fresh, exact-route `sol-max`
observe-only Advisor consultation. The Advisor can emit only a bounded
proposal; the low root may execute only the byte-identical deterministic
recovery plan. Root takeover remains a separate external-supervisor path for
root liveness or parent-invocation failure, with old-root fencing and a
single root-control lease.

## Git resource retirement

Worktrees and child branches are retired only through
`scripts/git-resource-cleanup.mjs`. The machine-owned lifecycle freezes the
resource, inventories exact Git/filesystem/process identities, proves one
candidate disposition, stops and re-observes actors/processes, performs an
exact Git-aware worktree removal, retires or quarantines the local ref, then
releases the lease/slot and independently verifies the post-state.

Merge ancestry uses safe branch deletion. Squash/rebase/cherry-pick retirement
requires an exact candidate-to-landing mapping. Dirty, staged, untracked, or
otherwise unmapped work is preserved under a protected quarantine ref with
patch/index/untracked manifests before the physical worktree is removed. The
generic resource lifecycle cannot delete Git resources or release their lease
without the final Git-resource verification receipt.

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

The repository test suite is self-contained. It uses committed fixtures,
the current checkout, and isolated temporary Git repositories; no sibling
product checkout is required.

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
ISSUE_ORCHESTRATION_E2E_LIVE=1 node --test --test-concurrency=1 \
  tests/tools/issue-orchestration/*.test.mjs
```

Live mode requires authenticated Codex plus a
clean, single-worktree, single-branch, remote-synchronized checkout of this
repository only. It installs the current committed Skill into an isolated
standard Codex home and proves discovery from five fresh sessions. It also
executes non-zero child test groups, an isolated local Git/bare-remote landing,
a live observe-only quiescence collection, and all mutation controls. It
deletes its isolated home, temporary workspaces, Git remote, and state root,
then proves this repository is unchanged. Target repositories and their issues
are not queried or required.
