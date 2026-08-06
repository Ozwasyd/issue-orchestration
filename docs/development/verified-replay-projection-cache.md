# Verified replay and projection cache

The lifecycle runtime keeps one optional in-process cache for already verified control and node ledger components. It reduces repeated disk replay and aggregate projection rebuilds. It is derived diagnostic state only and grants no lifecycle authority.

## Immutable identity

A cache entry is addressed by the canonical state root and run identity, the current startup, trust, package, and policy authority binding, the control-ledger head, the node-index digest, and the ordered active node ledger heads. Paths, mtimes, object identity, caller-provided projection JSON, and wall-clock timestamps are not cache keys.

A hit is accepted only after the runtime re-reads the canonical ledger boundaries, verifies header and tail digests, and confirms that the derived control projection, node projections, node index, and aggregate projection files still match the verified entry.

## Incremental invalidation

- A node append replaces only that node's verified ledger/projection component and rebuilds the aggregate from verified siblings.
- A control append replays the control ledger and preserves node components only when their canonical registrations remain byte-identical.
- Authority, state-root, run, node-index, registration, or ledger-head drift produces a different immutable key and forces the required replay.
- Corruption suspicion and explicit audit bypass every cache entry.

The cache never writes a second persistent projection format, ledger, database, or compatibility file. Process restart therefore begins with a complete canonical disk replay.

## Final audit

Quiescence finalization always requests an explicit full replay before machine inventory evaluation and again after `run.terminalized` is appended. A cached projection cannot sign final release acceptance.

## Telemetry

Dispatcher performance telemetry consumes cache statistics only after the replay boundary returns. Counts report actual control/node ledger replays, aggregate rebuilds, boundary identity reads, and canonical bytes read. Telemetry remains absent from route, retry, mutation, terminal, and correctness inputs.
