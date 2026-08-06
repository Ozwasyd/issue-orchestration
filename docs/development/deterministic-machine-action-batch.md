# Deterministic machine-action batch

`lifecycle-production-dispatcher.mjs` batches only machine actions explicitly listed in `BATCHABLE_MACHINE_ACTION_TYPES`. The first and currently only member is `compile-acceptance-contract`; future machine actions remain serial until they declare the same deterministic independence and batch-admission contract.

One batch consumes one verified action set, one shared projection, and one wave-scoped repository-base observation. Machine preparation and execution use a bounded local worker pool capped by the runtime-observed `maxConcurrentThreadsPerSession`; this pool does not acquire actor slots, leases, Git authority, remote authority, or model/runtime capacity.

Every selected action must yield one exact result entry. `recordLifecycleCurrentMachineActionResultBatch` sorts entries by stable `actionDigest`, validates every result and compiles every node event before the first append, then appends only valid independent events. A malformed action-local result is excluded without discarding valid peers; unknown action sets, ledger corruption, authority drift, or append ambiguity remain batch-fatal. The dispatcher reports an excluded result only after valid peer progress is durably recorded, so restart recovery trusts canonical node ledgers rather than an in-memory worker result.

The batch performs no network, model, repository, remote, lease, or actor operation. After admission the dispatcher rebuilds the projection and recompiles once. Telemetry records one machine execution span and one admission boundary for the batch, while canonical lifecycle state remains equivalent to the deterministic one-at-a-time reference path.
