# Actor context envelope

Every actor-bearing lifecycle action is compiled into one
`issue-orchestration.actor-context-envelope.v1` before actor preparation. The
envelope is model input only. It grants no route, retry, mutation, checkpoint,
candidate, verification, delivery, cleanup, terminal, or ledger authority.

## Exact contents

The compiler owns a closed action-to-role/phase map for semantic proposal,
test-contract planning and writing, implementation/UI implementation,
behavior verification, UI adjudication, UX acceptance, and documentation.
Each envelope contains only:

- immutable run, node, repository, issue, base, epoch, startup, route-policy,
  capability, lifecycle-authority, action, and action-set identities;
- the acceptance item IDs relevant to the current stage;
- one stage-specific context object;
- the applicable `AGENTS.md` and `AGENTS.override.md` chain for the current
  allowlisted paths;
- bounded inline source excerpts and content-addressed progressive references;
- the typed output interface and stable actor failure vocabulary;
- deterministic byte and token estimates.

Writer stages receive only the current work plan, executable slice, compiled
prompt, first action, read targets, write allowlist, commands, and an authorized
recovery cursor. Behavior and UX verifiers receive the exact candidate and
acceptance evidence without writer history. Semantic and planning actors may
receive authoritative issue facts through the bounded source interface.

Complete ledgers, complete DAGs or projections, unrelated nodes, future-stage
history, Root summaries, secrets, complete logs, state-root paths, lifecycle
authority objects, and writer conversations are forbidden envelope fields.
A writer cannot request a raw complete issue as a fallback.

## Progressive reads

Large allowlisted sources are not embedded. The runtime keeps a separate
in-memory source catalog and exposes a read-only resolver. A read succeeds only
when the caller supplies the exact reference ID, role, phase, node, path, and
content digest recorded in the envelope. Wrong or changed identity fails
closed. The catalog is not persisted, appended to ledgers, or provided as a
bulk model context.

Source and instruction size limits fail closed; the compiler never silently
truncates normative evidence. The envelope and resolver make no network or
paid-model calls.

## Production boundary

`lifecycle-production-dispatcher.mjs` compiles the envelope after the canonical
action and verified projection are selected. The pre-writer, writer, and
observe-only executors revalidate the action/role/phase binding before passing
it to the runtime adapter. Existing route, runtime execution binding, mutation
postcondition, checkpoint, candidate, and independent-verifier validators
remain the only stage authority.
