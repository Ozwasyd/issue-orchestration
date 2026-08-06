# Verified lifecycle action-set cache

`compileLifecycleRunActionSet` owns one disposable in-process cache for validated `issue-orchestration.lifecycle-action-set.v1` values. It is a speed layer, not a second compiler or authority source.

## Exact identity

A cache entry is scoped to the canonical state root and run, then keyed by the exact verified compiler-input digests for:

- selector receipt;
- remote snapshot receipt;
- semantic graph;
- aggregate runtime projection;
- installed route policy;
- runtime capability binding;
- lifecycle authority binding.

Wall-clock time, object identity, paths, mtimes, action count, caller summaries, partial node state, and caller-supplied action sets are never cache identities.

## Admission and invalidation

Every hit reruns `validateLifecycleActionSet`, verifies the cached action set still matches the graph/projection/policy/capability/authority identities, and returns an isolated clone. Callers cannot mutate the stored value or attach copied cache metadata to authorize a stale action set.

A node or control append, scope refresh, repository-base rebind, route-policy change, capability change, or authority-epoch change changes at least one key digest and forces compilation. `forceRecompile` provides a diagnostic reference path and returns the same byte-identical canonical action set for unchanged verified input.

The cache is never persisted and grants no ledger, route, retry, mutation, delivery, terminal, or quiescence authority. Performance telemetry counts an action-set compilation only when the underlying deterministic compiler is actually invoked; cache hits do not inflate that count.
