#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
    collectArtifactDigests,
    digest,
    resolveSourceCommit,
    unsignedDigest,
    WRITER_STAGE_CONTRACT_FILES,
    WRITER_STAGE_RUNTIME_FILES
} from './package-lib.mjs'

const packageRoot = path.resolve(import.meta.dirname, '..')
const manifestPath = path.join(packageRoot, 'manifest.json')
const agentIds = [
    'code-implementer',
    'dag-creator-updater',
    'documentation-writer',
    'test-owner',
    'ui-system-adjudicator',
    'ui-ux-implementer',
    'ux-acceptance-verifier'
]
const artifactDigests = collectArtifactDigests(packageRoot)
const selectArtifactDigests = (files) => Object.fromEntries(
    files.map((relative) => [relative, artifactDigests[relative]])
)

const manifest = {
    schema: 'issue-orchestration.shared-package-manifest.v1',
    packageIdentity: 'issue-orchestration',
    packageVersion: '1.0.0',
    sourceCommit: resolveSourceCommit(packageRoot),
    sourceTreeDigest: digest(artifactDigests),
    skillIdentity: 'issue-orchestration',
    skillDigest: artifactDigests['skills/issue-orchestration/SKILL.md'],
    agentDigests: Object.fromEntries(agentIds.map((agentId) => [
        agentId,
        artifactDigests[`agents/${agentId}.toml`]
    ])),
    modelPoolPolicyVersion: 'stage-model-pool.v4',
    modelPoolDigest: artifactDigests['policy/model-pool.json'],
    routingPolicyDigest: artifactDigests['policy/routing-policy.json'],
    stagePermissionDigest:
        artifactDigests['policy/stage-permissions.json'],
    terminalPolicyDigest:
        artifactDigests['policy/terminal-policy.json'],
    remoteMutationPolicyDigest:
        artifactDigests['policy/remote-mutation-policy.json'],
    runtimeTrustPolicyDigest:
        artifactDigests['policy/runtime-trust-policy.json'],
    runtimeStartupPolicyDigest:
        artifactDigests['policy/runtime-startup-policy.json'],
    executionRoutingPolicyDigest:
        artifactDigests['policy/execution-routing-policy.json'],
    runtimeExecutionBindingPolicyDigest:
        artifactDigests[
            'policy/runtime-execution-binding-policy.json'
        ],
    stageMutationGuardPolicyDigest:
        artifactDigests['policy/stage-mutation-guard-policy.json'],
    rootTakeoverPolicyDigest:
        artifactDigests['policy/root-takeover-policy.json'],
    controlPlaneAdvisorPolicyDigest:
        artifactDigests['policy/control-plane-advisor-policy.json'],
    graphSchemaDigest:
        artifactDigests['graph/semantic-graph.schema.json'],
    patchSchemaDigest:
        artifactDigests['graph/graph-patch.schema.json'],
    runtimeProjectionSchemaDigest:
        artifactDigests['graph/runtime-projection.schema.json'],
    projectorDigest: artifactDigests[
        'skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
    ],
    writerStageContractDigests:
        selectArtifactDigests(WRITER_STAGE_CONTRACT_FILES),
    writerStageRuntimeDigests:
        selectArtifactDigests(WRITER_STAGE_RUNTIME_FILES),
    repositoryTargetPolicy:
        'caller-supplied-operator-owned-remote-identity',
    sourceRepositoryDependencies: [],
    requiredCapabilities: [
        'external-runtime-state-root',
        'per-node-event-ledger',
        'verified-aggregate-runtime-projection',
        'deterministic-test-contract-cold-start',
        'deterministic-lifecycle-transition-compiler',
        'fresh-context-routing',
        'git-worktree-discovery',
        'runtime-permission-observation',
        'semantic-role-isolation',
        'runtime-model-effort-observation',
        'runtime-startup-attestation',
        'runtime-execution-binding',
        'stage-mutation-postcondition',
        'root-control-remote-mutation-authority',
        'bounded-control-plane-advisor',
        'root-recovery-takeover',
        'invocation-bound-downstream-authority',
        'caller-supplied-repository-identity',
        'stage-scoped-write-lease',
        'typed-terminalization-authority',
        'deterministic-dispatcher-performance-telemetry',
        'delta-aware-remote-scope-observation',
        'wave-scoped-repository-base-observation',
        'verified-replay-projection-cache',
        'verified-lifecycle-action-set-cache',
        'canonical-ready-result-batch-admission',
        'typed-actor-stage-failure-isolation',
        'shared-projection-batch-actor-preparation',
        'canonical-deterministic-machine-action-batch',
        'stage-specific-actor-context-envelope',
        'concise-envelope-bound-actor-instructions',
        'deterministic-repository-evidence-pack',
        'content-addressed-actor-prompt-prefix',
        'opt-in-paid-model-pool-qualification'
    ],
    installTargets: [
        {
            source: 'skills/issue-orchestration',
            target: '.agents/skills/issue-orchestration'
        },
        {
            source: 'agents',
            target: '.codex/agents'
        },
        {
            source: 'contracts',
            target: '.agents/contracts'
        },
        {
            source: 'policy',
            target: '.agents/policy'
        },
        {
            source: 'graph',
            target: '.agents/graph'
        },
        {
            source: 'manifest.json',
            target: '.agents/issue-orchestration-manifest.json'
        }
    ],
    ownedDomains: [
        'acceptance-group',
        'delivery',
        'model-routing',
        'mutation-postcondition',
        'receipts',
        'remote-mutation-authority',
        'resource-lifecycle',
        'root-recovery-takeover',
        'run-control-ledger',
        'runtime-projection',
        'runtime-startup',
        'scope-selector',
        'semantic-graph',
        'stage-dispatch',
        'control-plane-advisor',
        'test-contract-cold-start',
        'lifecycle-action-compilation',
        'terminalization'
    ],
    excludedAuthorities: [
        'product-api',
        'product-design',
        'product-documentation',
        'product-runtime',
        'repository-agents',
        'repo-local-orchestration-copy',
        'temporary-scheduler',
        'bootstrap-executor'
    ],
    artifactDigests
}
manifest.manifestDigest = unsignedDigest(manifest, 'manifestDigest')
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`)
