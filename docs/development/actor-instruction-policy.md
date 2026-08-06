# Actor instruction policy

Model-visible actor instructions are intentionally smaller than the machine policy that governs them.

Each of the seven actor TOML files contains exactly five ordered sections:

1. `Responsibility:` semantic work owned by the role;
2. `Forbidden ownership:` semantic or mutation authority the role never owns;
3. `Envelope:` the sole model-visible input contract;
4. `Output:` the typed interface to return;
5. `Stop:` bounded failure vocabulary for missing or disputed input.

Route selection, runtime binding, leases, mutation postconditions, checkpoint verification, continuation, terminal admission, retry authorization, fresh verification, delivery, cleanup, and quiescence remain in deterministic production compilers and validators. Their schema names and procedures must not be copied back into actor prose.

`tests/fixtures/issue-orchestration/actor-instruction-baselines.json` freezes the pre-migration byte and deterministic token estimates. `issue-orchestration-actor-instructions.test.mjs` requires a material reduction for every role and rejects stale profile literals, copied machine-policy blocks, unknown instruction layouts, and the retired broad-prompt wording.

The stage prompt carries only the current slice facts and tells the actor to consume the stage-specific context envelope and return its typed output. It does not teach the actor how to mint machine authority.
