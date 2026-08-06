# Opt-in paid Codex model-pool qualification

`node scripts/model-pool-qualification.mjs` is a local diagnostic command for comparing the checked-in production model profiles against frozen issue-orchestration workloads. It is not a test, installer, release gate, route selector, fallback mechanism, or source of lifecycle authority.

The command is inert unless every control below is supplied:

```bash
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_LIVE=1 \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_PROFILES=terra-low,terra-medium \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_SCENARIOS=atomic-mechanical,bounded-single-module \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_MAX_INVOCATIONS=4 \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_MAX_TOKENS=20000 \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_BUDGET_USD=1.00 \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_PRICING_FILE=/absolute/path/pricing.json \
ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_OUTPUT=/absolute/path/receipt.json \
node scripts/model-pool-qualification.mjs
```

`PRICING_FILE` must use `issue-orchestration.model-qualification-pricing.v1`, currency `USD`, and provide non-negative input, cached-input, and output prices per million tokens for every selected profile. Pricing is operator-supplied because provider prices are not permanent package policy. The output path must be outside this package checkout and must not already exist.

## Safety and budget gates

The command rejects CI and GitHub Actions before reading credentials or launching Codex. It also rejects missing controls, whitespace-normalized or duplicate allowlists, non-production profiles, unknown scenarios, incomplete pricing, an output path inside the package, or a matrix whose reserved invocation, token, or worst-case cost total exceeds a supplied cap.

Every actual invocation is checked again before launch and after completion. A successful receipt requires observable requested and effective model/effort/backend/sandbox/cwd, token usage, tool interactions, elapsed time, cost, mutation boundary, checkpoint evidence, acceptance result, and retry/recovery evidence. Missing or contradictory runtime, token, cost, tool, or checkpoint evidence fails closed. A partial matrix can emit only `issue-orchestration.model-qualification-failure.v1`, never a successful complete receipt.

Codex runs in generated local repositories with no remotes, `workspace-write`, and network disabled. Registered tool calls are rejected if they invoke GitHub, remote Git, SSH, download tools, package installation, or publication. The package checkout is hashed before and after the matrix, and any source mutation rejects the run. Scenario roots and the temporary credential copy are removed on success. On failure the credential copy is always deleted while generated repository evidence is retained for diagnosis unless the caller explicitly disables retention.

## Frozen scenarios

The versioned catalog at `policy/model-qualification-scenarios.json` contains:

- atomic mechanical implementation;
- bounded single-module implementation;
- stateful multi-file implementation with serialized checkpoint continuation;
- runtime-probe debugging with one injected recoverable failure;
- fresh independent verification after deterministic candidate replacement;
- prescribed UI implementation and bounded UX judgment;
- long-context retention across a serialized checkpoint and fresh reload.

Each selected profile receives a byte-identical frozen input repository, identical prompts, tools, timeout, mutation roots, and deterministic evaluator. Two-phase scenarios use separate fresh `codex exec` threads. The command records the frozen input digest for every scenario and rejects drift before the first model call for that run.

## Receipt authority

A complete receipt uses `issue-orchestration.model-qualification-receipt.v1` and validates against `contracts/model-qualification-receipt.schema.json`. It is diagnostic evidence only:

- `diagnosticAuthority` is always `none`;
- `automaticPolicyMutation` is always `false`;
- no model-pool, routing, issue, PR, repository, delivery, or lifecycle mutation is authorized;
- qualification scores cannot promote, demote, select, or fallback a profile.

Human review may use the receipt as one input to a separate explicit policy change, but the runner never writes that policy.
