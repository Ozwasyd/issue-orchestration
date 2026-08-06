import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const packageRoot = path.join(
    root,
    '.'
)
const policyRoot = path.join(packageRoot, 'policy')
const scriptsRoot = path.join(
    packageRoot,
    'skills/issue-orchestration/scripts'
)
const expectedProfiles = [
    'sol-high',
    'sol-low',
    'sol-max',
    'sol-medium',
    'sol-xhigh',
    'terra-high',
    'terra-low',
    'terra-max',
    'terra-medium',
    'terra-xhigh'
]
const expectedStages = {
    'root-scheduler:scheduling': {
        allowedProfiles: ['terra-low'],
        defaultProfile: 'terra-low'
    },
    'root-scheduler:recovery-takeover': {
        allowedProfiles: ['terra-medium'],
        defaultProfile: 'terra-medium'
    },
    'dag-creator-updater:semantic-proposal': {
        allowedProfiles: [
            'terra-high',
            'sol-high',
            'sol-xhigh',
            'sol-max'
        ],
        defaultProfile: 'terra-high'
    },
    'test-owner:test-contract-planning': {
        allowedProfiles: [
            'terra-high',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-high'
    },
    'test-owner:test-contract': {
        allowedProfiles: [
            'terra-medium',
            'terra-high',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-medium'
    },
    'test-owner:behavior-verification': {
        allowedProfiles: [
            'terra-high',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-high'
    },
    'code-implementer:implementation': {
        allowedProfiles: [
            'terra-low',
            'terra-medium',
            'terra-high',
            'sol-medium',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-medium'
    },
    'code-implementer:landing-conflict-resolution': {
        allowedProfiles: [
            'terra-medium',
            'terra-high',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-medium'
    },
    'ui-ux-implementer:ui-implementation': {
        allowedProfiles: ['sol-low', 'sol-medium'],
        defaultProfile: 'sol-low'
    },
    'ui-ux-implementer:landing-conflict-resolution': {
        allowedProfiles: [
            'terra-medium',
            'terra-high',
            'sol-medium',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-medium'
    },
    'ui-system-adjudicator:adjudication': {
        allowedProfiles: ['sol-high', 'sol-xhigh'],
        defaultProfile: 'sol-high'
    },
    'ux-acceptance-verifier:ux-acceptance': {
        allowedProfiles: ['sol-medium', 'sol-high', 'sol-xhigh'],
        defaultProfile: 'sol-medium'
    },
    'documentation-writer:documentation': {
        allowedProfiles: [
            'terra-low',
            'terra-medium',
            'sol-medium',
            'sol-high'
        ],
        defaultProfile: 'terra-medium'
    }
}
const loadJson = (relative) => JSON.parse(
    fs.readFileSync(path.join(packageRoot, relative), 'utf8')
)
const importRuntime = (name) => import(pathToFileURL(
    path.join(scriptsRoot, name)
).href)

test('V4-01 freezes the reviewed Terra/Sol production roster', () => {
    const pool = loadJson('policy/model-pool.json')
    assert.equal(
        pool.schema,
        'issue-orchestration.stage-model-pool-policy.v4'
    )
    assert.equal(pool.version, 'stage-model-pool.v4')
    assert.deepEqual(Object.keys(pool.profiles).sort(), expectedProfiles)
    assert.deepEqual(pool.productionRoster, [
        'terra-low', 'terra-medium', 'terra-high',
        'sol-low', 'sol-medium', 'sol-high', 'sol-xhigh'
    ])
    assert.deepEqual(pool.frontierOnlyProfiles, ['sol-max'])
    assert.deepEqual(pool.disabledProfiles, [
        'terra-xhigh', 'terra-max'
    ])
    for (const [profileId, profile] of Object.entries(pool.profiles)) {
        const [family, effort] = profileId.split('-')
        assert.equal(profile.model, `gpt-5.6-${family}`)
        assert.equal(profile.effort, effort)
        assert.equal(profile.multiAgentBackend, 'v2')
        assert.match(profile.reviewedAssumptionDigest, /^[a-f0-9]{64}$/u)
    }
    assert.deepEqual(pool.stages, expectedStages)
})

test('V4-02 upgrades deterministic execution routing to canonical v5 cells', () => {
    const pool = loadJson('policy/model-pool.json')
    const routing = loadJson('policy/execution-routing-policy.json')
    assert.equal(
        routing.schema,
        'issue-orchestration.execution-routing-policy.v5'
    )
    assert.equal(routing.version, 'execution-capability-routing.v5')
    assert.equal(routing.modelPoolPolicyVersion, pool.version)
    assert.equal(
        routing.routingAuthority,
        'canonical-route-cell-compiler'
    )
    for (const forbidden of [
        'balance',
        'failureCount',
        'reworkCount',
        'requestedProfile',
        'selectedProfile',
        'profileOverride'
    ]) assert.ok(routing.forbiddenInputs.includes(forbidden))
    assert.equal(
        routing.routeCells['implementation.narrow-deep-cost-sensitive']
            .requiredProfile,
        'terra-high'
    )
    assert.equal(
        routing.routeCells['verification.narrow-deep-cost-sensitive']
            .requiredProfile,
        'terra-high'
    )
    assert.deepEqual(routing.legacyProfileMigration, {
        retiredProfiles: [
            'luna-low', 'luna-medium', 'luna-high', 'luna-xhigh', 'luna-max'
        ],
        errorCode: 'stage-model-pool-luna-profile-retired',
        aliasesForbidden: true,
        fallbackForbidden: true
    })
    assert.equal(Object.hasOwn(routing, 'lunaAvailabilityFallback'), false)
})

test('V4-03 reviewed assumptions cover every registered profile exactly', async () => {
    const pool = loadJson('policy/model-pool.json')
    const assumptions = loadJson(
        'policy/reviewed-routing-assumptions.json'
    )
    assert.deepEqual(
        Object.keys(assumptions.profiles).sort(),
        expectedProfiles
    )
    for (const [profileId, assumption] of
        Object.entries(assumptions.profiles)) {
        assert.equal(assumption.multiAgentBackend, 'v2')
        assert.equal(assumption.routeValidation,
            'exact-required-profile-only')
        assert.equal(
            pool.profiles[profileId].reviewedAssumptionDigest,
            assumption.assumptionDigest
        )
    }
    const { verifyReviewedRoutingAssumptions } = await importRuntime(
        'execution-route-compiler.mjs'
    )
    assert.equal(
        verifyReviewedRoutingAssumptions(assumptions),
        assumptions
    )
})

test('V4-04 normal Root is terra-low and recovery Root is receipt-bound', async () => {
    const {
        compileCanonicalRoute
    } = await importRuntime('execution-route-compiler.mjs')
    const {
        verifyRuntimeProfileMetadata
    } = await importRuntime('stage-profile-policy.mjs')
    const classification = {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: 'a'.repeat(64),
        routingPolicyVersion: 'stage-model-pool.v4'
    }
    const normal = compileCanonicalRoute({
        ...classification,
        stageRole: 'root-scheduler',
        stagePhase: 'scheduling'
    })
    assert.equal(
        normal.executionRouteDecision.selectedProfile,
        'terra-low'
    )
    assert.throws(
        () => compileCanonicalRoute({
            ...classification,
            stageRole: 'root-scheduler',
            stagePhase: 'scheduling',
            controlPlaneRecovery: true
        }),
        { code: 'routing-root-in-session-upgrade-forbidden' }
    )
    const recovery = compileCanonicalRoute({
        ...classification,
        stageRole: 'root-scheduler',
        stagePhase: 'recovery-takeover',
        newParentInvocation: true,
        takeoverAuthorizationDigest: 'b'.repeat(64),
        recoveryHandoffDigest: 'c'.repeat(64),
        oldRootFencingReceiptDigest: 'd'.repeat(64)
    })
    assert.equal(
        recovery.executionRouteDecision.selectedProfile,
        'terra-medium'
    )
    assert.equal(verifyRuntimeProfileMetadata({
        selectedProfile: 'terra-low',
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: 'low',
        effectiveEffort: 'low',
        multiAgentBackend: 'v2'
    }).status, 'verified')
})

test('V4-05 requested/effective runtime mismatches fail closed', async () => {
    const { verifyRuntimeProfileMetadata } = await importRuntime(
        'stage-profile-policy.mjs'
    )
    for (const mutate of [
        (value) => { value.effectiveModel = 'gpt-5.6-sol' },
        (value) => { value.effectiveEffort = 'medium' },
        (value) => { value.multiAgentBackend = 'v1' },
        (value) => { delete value.effectiveModel }
    ]) {
        const value = {
            selectedProfile: 'terra-low',
            requestedModel: 'gpt-5.6-terra',
            effectiveModel: 'gpt-5.6-terra',
            requestedEffort: 'low',
            effectiveEffort: 'low',
            multiAgentBackend: 'v2'
        }
        mutate(value)
        assert.throws(
            () => verifyRuntimeProfileMetadata(value),
            { code: 'runtime-profile-metadata-mismatch' }
        )
    }
})

test('V4-06 rejects every legacy Luna profile with one migration code', async () => {
    const {
        splitProfile,
        verifyRuntimeProfileMetadata
    } = await importRuntime('stage-profile-policy.mjs')
    for (const profile of [
        'luna-low', 'luna-medium', 'luna-high', 'luna-xhigh', 'luna-max'
    ]) {
        assert.throws(() => splitProfile(profile), {
            code: 'stage-model-pool-luna-profile-retired'
        })
        assert.throws(() => verifyRuntimeProfileMetadata({
            selectedProfile: profile,
            requestedModel: 'gpt-5.6-luna',
            effectiveModel: 'gpt-5.6-luna',
            requestedEffort: profile.split('-')[1],
            effectiveEffort: profile.split('-')[1],
            multiAgentBackend: 'v2'
        }), { code: 'stage-model-pool-luna-profile-retired' })
    }
    for (const profile of [
        'terra-xhigh', 'terra-max', 'sol-ultra', 'terra-ultra',
        'gpt-5.6-terra/low', 'terra-bounded'
    ]) assert.throws(() => splitProfile(profile), { code: 'routing-profile-id' })
})

test('V4-07 UI, documentation and cleanup boundaries match the frozen map', () => {
    const pool = loadJson('policy/model-pool.json')
    assert.deepEqual(
        pool.stages['ui-ux-implementer:ui-implementation']
            .allowedProfiles,
        ['sol-low', 'sol-medium']
    )
    assert.deepEqual(
        pool.stages['ui-ux-implementer:landing-conflict-resolution']
            .allowedProfiles,
        ['terra-medium', 'terra-high', 'sol-medium', 'sol-high', 'sol-xhigh']
    )
    assert.ok(pool.stages[
        'documentation-writer:documentation'
    ].allowedProfiles.every((profile) =>
        ['terra-low', 'terra-medium', 'sol-medium', 'sol-high']
            .includes(profile)))
    assert.deepEqual(pool.cleanup, {
        greenAuthority: 'machine-resource-verifier',
        llmProfile: null,
        diagnosticProfiles: ['terra-low', 'terra-medium']
    })
})

test('V4-08 sol-max is restricted to a machine-proven DAG exception', async () => {
    const { compileCanonicalRoute } = await importRuntime(
        'execution-route-compiler.mjs'
    )
    const base = {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'frontier',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'protocol',
        modelRoutingEvidenceDigest: 'c'.repeat(64),
        routingPolicyVersion: 'stage-model-pool.v4',
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal'
    }
    assert.notEqual(
        compileCanonicalRoute(base)
            .executionRouteDecision.selectedProfile,
        'sol-max'
    )
    assert.throws(
        () => compileCanonicalRoute({
            ...base,
            frontierException: true
        }),
        { code: 'execution-route-frontier-exception-invalid' }
    )
    assert.equal(compileCanonicalRoute({
        ...base,
        frontierException: true,
        frontierExceptionReceipt: {
            schema: 'issue-orchestration.frontier-exception-receipt.v1',
            sliceMinimal: true,
            solXhighCapabilityInsufficient: true,
            evidenceDigest: 'd'.repeat(64)
        },
        machineFrontierEvidence: {
            source: 'machine-frontier-exception-verifier',
            evidenceDigest: 'e'.repeat(64)
        }
    }).executionRouteDecision.selectedProfile, 'sol-max')
})

test('V4-09 production agents consume envelopes and never self-select a model', () => {
    const agentRoot = path.join(packageRoot, 'agents')
    for (const file of fs.readdirSync(agentRoot)) {
        const source = fs.readFileSync(path.join(agentRoot, file), 'utf8')
        assert.match(
            source,
            /issue-orchestration\.actor-context-envelope\.v1/u
        )
        assert.doesNotMatch(source, /stage-model-pool\.v\d+/u)
        assert.doesNotMatch(
            source,
            /gpt-5\.|(?:terra|sol|luna)-(?:low|medium|high|xhigh|max)/u
        )
        assert.doesNotMatch(source, /\b(?:self-select|promote)\s+(?:a\s+)?(?:model|profile)\b/iu)
    }
})

test('V4-10 selector, frontier and gate do not own model selection', () => {
    for (const file of [
        'scope-selector.mjs',
        'frontier-compiler.mjs',
        'check-dag-gate.mjs'
    ]) {
        const source = fs.readFileSync(path.join(scriptsRoot, file), 'utf8')
        assert.doesNotMatch(
            source,
            /expectedCandidate\s*\([^)]*\)\s*\{[^}]*\b(?:model|effort)\s*:/su
        )
        assert.doesNotMatch(
            source,
            /reworkCount\s*(?:>=|>|===?).{0,80}(?:model|effort|profile)/su
        )
        assert.doesNotMatch(
            source,
            /node\?\?\.(?:model|effort)|node\.(?:model|effort)/u
        )
    }
})

test('V4-11 disabled profiles have zero stage or ordinary-route authority', () => {
    const pool = loadJson('policy/model-pool.json')
    const routing = loadJson('policy/execution-routing-policy.json')
    const selected = [
        ...Object.values(pool.stages)
            .flatMap(({ allowedProfiles }) => allowedProfiles),
        ...Object.values(routing.routeCells)
            .map(({ requiredProfile }) => requiredProfile)
    ]
    for (const disabled of pool.disabledProfiles) {
        assert.equal(selected.includes(disabled), false, disabled)
    }
    assert.equal(
        Object.entries(routing.routeCells)
            .filter(([, cell]) => cell.requiredProfile === 'sol-max')
            .every(([, cell]) => cell.advisorOnly === true),
        true
    )
})

test('V4-12 one policy digest is bound by manifest and all five cwd installs', () => {
    const manifest = loadJson('manifest.json')
    const pool = loadJson('policy/model-pool.json')
    assert.equal(manifest.modelPoolPolicyVersion, pool.version)
    assert.match(manifest.modelPoolDigest, /^[a-f0-9]{64}$/u)
    assert.ok(Array.isArray(manifest.installTargets))
    assert.ok(manifest.installTargets.some(({ source, target }) =>
        source === 'skills/issue-orchestration' &&
        target === '.agents/skills/issue-orchestration'))
    assert.ok(manifest.installTargets.some(({ source, target }) =>
        source === 'policy' && target === '.agents/policy'))
    assert.equal(
        manifest.excludedAuthorities.includes('repo-local-orchestration-copy'),
        true
    )
})
