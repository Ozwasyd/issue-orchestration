# Repository base observation epochs

The production dispatcher validates repository identity and default-branch
freshness through
`issue-orchestration.repository-base-observation-epoch.v1`.

An epoch is scoped to exactly one dispatcher boundary:

- `pre-dispatch` binds one current canonical action set and the compatible
  actions selected from it;
- `post-admission` binds the exact active dispatch records whose results are
  being considered for admission.

For each unique repository/base pair in that boundary, the runtime performs one
trusted Git observation. Different repositories are observed concurrently.
Actions in the same wave may consume the same repository observation only when
their expected base SHA and repository binding are identical.

Every epoch binds:

- run and control-ledger head identity;
- lifecycle/startup authority, root authority epoch, package, and policy set;
- exact action, action-set, and active-dispatch identities;
- repository binding, canonical path, common Git directory, origin, default
  branch, local head, remote head, and dirty entries;
- the expected base SHA for every consuming action.

The timestamp is evidence of when the observation occurred, not a TTL. A scope
refresh, control-ledger append, base rebind, startup or authority change, or
repository identity drift prevents reuse. A pre-dispatch remote-head change
produces the existing canonical base-rebind path before a side effect. A
post-admission remote-head change rejects the stale result before admission.

The epoch is freshness evidence only. It cannot select a route, authorize a
retry, mint a lifecycle result, deliver or close an issue, clean a resource, or
terminalize a node. Canonical ledgers and the existing action-family validators
remain the only lifecycle and mutation authority.
