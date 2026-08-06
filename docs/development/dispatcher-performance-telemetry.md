# Dispatcher performance telemetry

`runLifecycleProductionDispatcher` accepts an optional `performanceTelemetry`
configuration. The configuration is disabled by default and is not part of the
canonical lifecycle input:

```js
const result = await runLifecycleProductionDispatcher({
    ledger,
    startup,
    contextProvider,
    clock: lifecycleClock,
    performanceTelemetry: {
        clock: performanceClock,
        onReceipt(receipt) {
            consumeDiagnosticReceipt(receipt)
        }
    }
})
```

The performance clock is deliberately separate from the lifecycle clock.
Instrumentation must never consume a timestamp used by an event, receipt,
action set, dispatch, retry, mutation guard, terminal decision, or route. The
optional sink is best-effort. A sink failure cannot change lifecycle state.

The dispatcher emits
`issue-orchestration.dispatcher-performance-receipt.v1` when it terminalizes
or fails. The receipt is `diagnostic-only`, grants no authority, and is not
written into canonical control or node ledgers. It records deterministic spans
and summaries for:

- canonical replay and aggregate projection rebuild boundaries;
- action-set compilation and live remote-scope observation;
- repository-base observation, grouped by repository and annotated with the
  pre-dispatch or post-admission wave action/dispatch set;
- `contextProvider.prepare` calls and prepared-context bytes;
- actor start, completion, admission, slot samples, and slot refill delay;
- machine-action execution;
- canonical-ledger bytes observed at replay boundaries;
- Root control-plane observed duration separately from actor wall duration.

`normalizeDispatcherPerformanceReceipt` converts absolute timestamps to
millisecond offsets from the receipt start. Repeated execution of a fixed
offline fixture with the same deterministic adapters must then produce a
byte-identical normalized receipt.

Performance fields are forbidden inputs to route selection, retry,
terminalization, mutation authority, and correctness gates. Disabling the
configuration must remove instrumentation overhead without changing action
ordering, canonical events, ledger heads, projections, or quiescence.
