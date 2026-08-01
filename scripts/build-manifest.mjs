#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
    digest,
    fileDigest,
    unsignedDigest,
    walkFiles
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
const artifactDigests = Object.fromEntries(walkFiles(packageRoot)
    .filter((file) => file !== manifestPath)
    .map((file) => [
        path.relative(packageRoot, file),
        fileDigest(file)
    ]).sort(([left], [right]) => left.localeCompare(right)))

const manifest = {
    schema: 'issue-orchestration.shared-package-manifest.v1',
    packageIdentity: 'issue-orchestration',
    packageVersion: '1.0.0',
    sourceCommit: 'd98bed01a76fcca5dc1657e63886b8da48ce346d',
    sourceTreeDigest: digest(artifactDigests),
    skillIdentity: 'issue-orchestration',
    skillDigest: artifactDigests['skills/issue-orchestration/SKILL.md'],
    agentDigests: Object.fromEntries(agentIds.map((agentId) => [
        agentId,
        artifactDigests[`agents/${agentId}.toml`]
    ])),
    modelPoolPolicyVersion: 'stage-model-pool.v2',
    modelPoolDigest: artifactDigests['policy/model-pool.json'],
    routingPolicyDigest: artifactDigests['policy/routing-policy.json'],
    stagePermissionDigest:
        artifactDigests['policy/stage-permissions.json'],
    remoteMutationPolicyDigest:
        artifactDigests['policy/remote-mutation-policy.json'],
    graphSchemaDigest:
        artifactDigests['graph/semantic-graph.schema.json'],
    patchSchemaDigest:
        artifactDigests['graph/graph-patch.schema.json'],
    runtimeProjectionSchemaDigest:
        artifactDigests['graph/runtime-projection.schema.json'],
    projectorDigest: artifactDigests[
        'skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
    ],
    supportedRepositories: [
        'Ozwasyd/FsusBlog',
        'Ozwasyd/FsusUI'
    ],
    requiredCapabilities: [
        'external-runtime-state-root',
        'fresh-context-routing',
        'git-worktree-discovery',
        'read-only-verification-sandbox',
        'runtime-model-effort-observation',
        'stage-scoped-write-lease'
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
        'receipts',
        'resource-lifecycle',
        'runtime-projection',
        'scope-selector',
        'semantic-graph',
        'stage-dispatch'
    ],
    excludedAuthorities: [
        'product-api',
        'product-design',
        'product-documentation',
        'product-runtime',
        'repository-agents'
    ],
    artifactDigests
}
manifest.manifestDigest = unsignedDigest(manifest, 'manifestDigest')
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
