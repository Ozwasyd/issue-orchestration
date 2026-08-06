# Ready-result batch admission

`lifecycle-production-dispatcher.mjs` owns one process-local settlement queue for actor promises. The queue is disposable scheduling state, never ledger or recovery authority. After at least one actor settles, the dispatcher drains every result already published in the same ready window without waiting for unfinished actors.

The drained set is handled through one post-wave repository observation and one `recordLifecycleDispatchedActionResultBatch` call. Entries are ordered by stable `dispatchId`, not completion time. Each result is revalidated against its persisted dispatch, attempt, route, repository base, node epoch, candidate, action-set identity, and current canonical node state before any append.

Valid independent results append their existing node and control events. Base-stale, identity-stale, or malformed results append only a control settlement with `outcome=excluded`; they release their own slot and cannot change node state. A rejected executor promise remains run-fatal, but unrelated valid results from the same drained window are admitted first. Root-only scope, delivery, cleanup, terminalization, and quiescence actions never enter this batch.

Restart discards the in-memory queue and reconstructs active dispatches only from canonical ledgers. Batch and stable one-at-a-time reference admission use the same recorder internals and must produce byte-identical canonical state.
