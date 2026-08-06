# Typed actor-stage failure admission

`lifecycle-executor-failure-admission.mjs` is the only boundary that may convert a rejected actor promise into a node-local lifecycle result. It accepts only `issue-orchestration.actor-stage-failure.v1` values containing a complete, already sealed lifecycle stage result from an enumerated existing contract.

The accepted families are writer retry authorization, validated writer terminal failure, and independent verifier rejection. Every value binds the persisted dispatch, action, node, attempt, route-derived result, artifact set, and result digest. Error names, exception classes, messages, prose, or partial receipts have no admission authority.

Validated failures enter the same drained batch recorder as successful results and settle only their dispatch with `outcome=failed`. Unrelated active actors remain running and the freed slot is eligible for the next canonical action set. Malformed failures, unknown exceptions, ledger ambiguity, authority drift, forbidden mutation, and unattributable control-plane failures remain run-fatal.

The failure envelope and ready queue are process-local transport only. Restart recovery trusts canonical node events and control settlements, never a pre-restart exception or completion object.
