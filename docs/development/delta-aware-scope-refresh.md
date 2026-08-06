# Delta-aware scope refresh

`lifecycle-live-refresh.mjs` supports an optional `observeRemoteIssueDelta` adapter boundary. The request is `issue-orchestration.lifecycle-remote-scope-delta-request.v1` and binds the current selector, prior selector receipt, prior remote snapshot, lifecycle authority, and the adapter-owned observation cursor/conditional identity stored in the canonical selector receipt.

An authoritative `unchanged` response must preserve the exact prior cursor and conditional identity. It reuses the verified selector receipt, appends no scope event, and does not call the selector resolver. A `changed` response carries the complete current issue identity set, every complete changed/new issue fact, and the exact removed identity set. The runtime reconstructs the full fact set from the prior canonical selector receipt, rejects partial or contradictory deltas, and sends the result through the normal selector resolver. Delta and full observation therefore share one selection authority.

Adapters without delta support, receipts without an adapter cursor, and explicit `unsupported` responses use the existing full-observation path. Wrong selector/authority bindings, stale cursors, unknown fields, incomplete new members, or contradictory removals fail closed rather than falling back to `unchanged`.

The selector receipt stores normalized remote facts for every observed issue. Only enumerated authoritative fields are retained; irrelevant comments and local execution/cache metadata are excluded. This state is ledger-backed and replayable, not an in-memory issue cache.

Dispatcher telemetry records `mode`, `fallbackReason`, `remoteFactsTransferred`, and `selectorRebuildCount` on the diagnostic remote-scope span. These fields grant no selector, routing, retry, mutation, delivery, cleanup, or terminal authority.
