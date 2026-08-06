# Batch actor-wave preparation

`lifecycle-production-dispatcher.mjs` prepares every compatible actor action selected from one verified action set through one wave boundary. The dispatcher projects the run once, consumes one shared pre-dispatch repository-base epoch, and passes only the current action plus its node projection and exact base-epoch binding to preparation.

Providers may implement `prepareBatch` with `issue-orchestration.dispatch-context-batch-request.v1`. Providers that implement only `prepare` remain supported; those calls run concurrently rather than serially. A batch result must return exactly one ordered `prepared` or `failed` item for every requested action digest.

All accepted outputs are compiled and validated before any dispatch event or actor spawn. Attempt identity is node-scoped; slot, runtime binding, lease, and resource identities are wave-unique. Unknown/reordered outputs or cross-action identity collisions fail before canonical append. An action-local preparation failure removes only that action from the accepted subset.

The accepted subset is appended once through `recordLifecycleDispatchBatchStarted`, then every actor is launched. Preparation data is read/compile/allocation planning only: it cannot alter the action set, route, execution class, write scope, base observation, or ordering. Performance telemetry records one wave-preparation span and has no lifecycle authority.
