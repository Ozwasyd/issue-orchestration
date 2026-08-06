# Delta-aware scope refresh

The production scope observer remains complete-v1 unless the adapter explicitly declares delta-v1 support. A delta request binds the prior verified selector receipt, selected remote snapshot, complete remote-observation snapshot, and adapter-owned cursor or conditional identity.

An authoritative `unchanged` response must bind those identities exactly. It reuses the prior selector receipt byte-for-byte, performs no selector rebuild, and appends no scope event. A `changed` response contains complete facts for every upsert plus explicit removals; canonical selector resolution must converge with a complete observation of the same facts.

Partial members, stale cursors, contradictory digests, wrong selectors or authority, unknown removals, and uncertain observations fail closed. Adapters without delta support retain the complete observation path. Changes outside selected scope advance only the verified remote-observation snapshot and continuation through an observation-only control refresh; active node epochs and node ledgers are unchanged.

Dispatcher telemetry records protocol, transferred fact count, changed-member count, and whether the selector was rebuilt. These fields are diagnostic only and never authorize lifecycle, routing, retry, terminal, or mutation decisions.
