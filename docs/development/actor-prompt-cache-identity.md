# Actor prompt cache identity

`actor-prompt-cache-identity.mjs` compiles every validated actor context envelope into two ordered prompt sections without adding lifecycle authority.

## Stable prefix

The stable prefix contains only the exact role and phase, the concise role boundary, the actor-context-envelope and typed-output interfaces, and immutable package, manifest, policy, policy-set, and agent-instruction digests. Run, node, repository, action, route, slice, candidate, checkpoint, lease, runtime-session, and current evidence fields are forbidden keys anywhere in this section.

## Volatile suffix

The volatile suffix contains the complete validated `issue-orchestration.actor-context-envelope.v1`, including the current slice, candidate, checkpoint cursor, required evidence, progressive source references, and the #75 repository evidence pack.

The complete prompt digest binds the ordered pair `[stablePrefix, volatileSuffix]`; substitution or section reordering fails validation. `issue-orchestration.actor-prompt-cache-identity.v1` additionally records optional observable tokenizer/runtime identity and grants no authority.

Adapters that explicitly support prompt caching receive the stable prefix and cache identity. Unsupported adapters receive the same complete prompt and remain fully functional. Provider cache status, hit state, cache key, and token counts are sanitized into dispatcher performance telemetry only and are excluded from routing, retries, stage admission, receipts, mutation, delivery, cleanup, and terminal inputs.
