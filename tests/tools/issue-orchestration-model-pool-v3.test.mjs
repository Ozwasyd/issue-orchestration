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
            'terra-xhigh',
            'terra-max',
            'sol-xhigh',
            'sol-max'
        ],
        defaultProfile: 'terra-high'
    },
    'test-owner:test-contract-planning': {
        allowedProfiles: [
            'terra-high',
            'terra-xhigh',
            'terra-max',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-high'
    },
    'test-owner:test-contract': {
        allowedProfiles: [
            'terra-medium',
            'terra-high',
            'terra-xhigh',
            'terra-max',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-medium'
    },
    'test-owner:behavior-verification': {
        allowedProfiles: [
            'terra-high',
            'terra-xhigh',
            'terra-max',
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
            'terra-xhigh',
            'terra-max',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-medium'
    },
    'code-implementer:landing-conflict-resolution': {
        allowedProfiles: [
            'terra-medium',
            'terra-high',
            'terra-xhigh',
            'terra-max',
            'sol-high',
            'sol-xhigh'
        ],
        defaultProfile: 'terra-high'
    },
    'ui-ux-implementer:ui-implementation': {
        allowedProfiles: ['sol-low', 'sol-medium'],
        defaultProfile: 'sol-low'
    },
    'ui-ux-implementer:landing-conflict-resolution': {
        allowedProfiles: ['sol-low', 'sol-medium'],
        defaultProfile: 'sol-medium'
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
        allowedProfiles: ['terra-low', 'terra-medium', 'terra-high'],
        defaultProfile: 'terra-medium'
    }
}
const loadJson = (relative) => JSON.parse(
    fs.readFileSync(path.join(packageRoot, relative), 'utf8')
)
const importRuntime = (name) => import(pathToFileURL(
    path.join(scriptsRoot, name)
).href)

test('V3-01 freezes the sole Terra/Sol production pool and V2 evidence', () => {
    const pool = loadJson('policy/model-pool.json')
    assert.equal(
        pool.schema,
        'issue-orchestration.stage-model-pool-policy.v3'
    )
    assert.equal(pool.version, 'stage-model-pool.v3')
    assert.deepEqual(Object.keys(pool.profiles).sort(), expectedProfiles)
    for (const [profileId, profile] of Object.entries(pool.profiles)) {
        const [family, effort] = profileId.split('-')
        assert.equal(profile.model, `gpt-5.6-${family}`)
        assert.equal(profile.effort, effort)
        assert.equal(profile.multiAgentBackend, 'v2')
        assert.match(profile.capabilityEvidenceDigest, /^[a-f0-9]{64}$/u)
    }
    assert.deepEqual(pool.stages, expectedStages)
})

test('V3-02 upgrades deterministic execution routing to v3', () => {
    const pool = loadJson('policy/model-pool.json')
    const routing = loadJson('policy/execution-routing-policy.json')
    assert.equal(
        routing.schema,
        'issue-orchestration.execution-routing-policy.v3'
    )
    assert.equal(routing.version, 'execution-capability-routing.v3')
    assert.equal(routing.modelPoolPolicyVersion, pool.version)
    assert.equal(
        routing.routingAuthority,
        'deterministic-execution-capability-compiler'
    )
    for (const forbidden of [
        'balance',
        'failureCount',
        'reworkCount',
        'requestedProfile',
        'selectedProfile',
        'profileOverride'
    ]) assert.ok(routing.forbiddenInputs.includes(forbidden))
})

test('V3-03 capability evidence covers every registered profile exactly', async () => {
    const pool = loadJson('policy/model-pool.json')
    const matrix = loadJson('policy/profile-capability-matrix.json')
    const observations = loadJson(
        'policy/profile-capability-observations.json'
    )
    assert.deepEqual(Object.keys(matrix.profiles).sort(), expectedProfiles)
    assert.deepEqual(
        observations.observations.map(({ profileId }) => profileId).sort(),
        expectedProfiles
    )
    for (const observation of observations.observations) {
        assert.equal(observation.requestedModel, observation.effectiveModel)
        assert.equal(observation.requestedEffort, observation.effectiveEffort)
        assert.equal(observation.multiAgentBackend, 'v2')
        assert.equal(observation.runtimeMetadataObserved, true)
        assert.equal(
            pool.profiles[observation.profileId].capabilityEvidenceDigest,
            matrix.profiles[observation.profileId].evidenceDigest
        )
    }
    const { verifyProfileCapabilityMatrix } = await importRuntime(
        'execution-route-compiler.mjs'
    )
    assert.equal(
        verifyProfileCapabilityMatrix({ matrix, observations }),
        matrix
    )
})

test('V3-04 normal Root is terra-low and recovery Root is receipt-bound', async () => {
    const {
        compileStageRoute,
        verifyRuntimeProfileMetadata
    } = await importRuntime('stage-profile-policy.mjs')
    const classification = {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'Ozwasyd/FsusBlog',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: 'a'.repeat(64),
        routingPolicyVersion: 'stage-model-pool.v3'
    }
    const normal = compileStageRoute({
        ...classification,
        stageRole: 'root-scheduler',
        stagePhase: 'scheduling'
    })
    assert.equal(normal.selectedProfile, 'terra-low')
    assert.throws(
        () => compileStageRoute({
            ...classification,
            stageRole: 'root-scheduler',
            stagePhase: 'scheduling',
            controlPlaneRecovery: true
        }),
        { code: 'routing-root-in-session-upgrade-forbidden' }
    )
    const recovery = compileStageRoute({
        ...classification,
        stageRole: 'root-scheduler',
        stagePhase: 'recovery-takeover',
        newParentInvocation: true,
        takeoverAuthorizationDigest: 'b'.repeat(64),
        recoveryHandoffDigest: 'c'.repeat(64),
        oldRootFencingReceiptDigest: 'd'.repeat(64)
    })
    assert.equal(recovery.selectedProfile, 'terra-medium')
    assert.equal(verifyRuntimeProfileMetadata({
        selectedProfile: 'terra-low',
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: 'low',
        effectiveEffort: 'low',
        multiAgentBackend: 'v2'
    }).status, 'verified')
})

test('V3-05 requested/effective runtime mismatches fail closed', async () => {
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

test('V3-06 Luna, Ultra, aliases and unregistered profiles are rejected', async () => {
    const {
        splitProfile,
        verifyRuntimeProfileMetadata
    } = await importRuntime('stage-profile-policy.mjs')
    for (const profile of [
        'luna-low',
        'luna-high',
        'luna-max',
        'sol-ultra',
        'terra-ultra',
        'gpt-5.6-terra/low',
        'terra-bounded'
    ]) {
        assert.throws(() => splitProfile(profile), {
            code: 'routing-profile-id'
        })
        assert.throws(() => verifyRuntimeProfileMetadata({
            selectedProfile: profile,
            requestedModel: 'gpt-5.6-terra',
            effectiveModel: 'gpt-5.6-terra',
            requestedEffort: 'low',
            effectiveEffort: 'low',
            multiAgentBackend: 'v2'
        }))
    }
})

test('V3-07 UI, documentation and cleanup boundaries match the frozen map', () => {
    const pool = loadJson('policy/model-pool.json')
    for (const key of [
        'ui-ux-implementer:ui-implementation',
        'ui-ux-implementer:landing-conflict-resolution'
    ]) {
        assert.ok(pool.stages[key].allowedProfiles.every((profile) =>
            ['sol-low', 'sol-medium'].includes(profile)))
    }
    assert.ok(pool.stages[
        'documentation-writer:documentation'
    ].allowedProfiles.every((profile) => profile.startsWith('terra-')))
    assert.deepEqual(pool.cleanup, {
        greenAuthority: 'machine-resource-verifier',
        llmProfile: null,
        diagnosticProfiles: ['terra-low', 'terra-medium']
    })
})

test('V3-08 sol-max is restricted to a machine-proven DAG exception', async () => {
    const { compileStageRoute } = await importRuntime(
        'stage-profile-policy.mjs'
    )
    const base = {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'Ozwasyd/FsusBlog',
        engineeringRiskClass: 'frontier',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'protocol',
        modelRoutingEvidenceDigest: 'c'.repeat(64),
        routingPolicyVersion: 'stage-model-pool.v3',
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal'
    }
    assert.notEqual(compileStageRoute(base).selectedProfile, 'sol-max')
    assert.throws(
        () => compileStageRoute({ ...base, frontierException: true }),
        { code: 'routing-frontier-exception-receipt' }
    )
    assert.equal(compileStageRoute({
        ...base,
        frontierException: true,
        frontierExceptionReceipt: {
            schema: 'issue-orchestration.frontier-exception-receipt.v1',
            sliceMinimal: true,
            solXhighCapabilityInsufficient: true,
            evidenceDigest: 'd'.repeat(64)
        }
    }).selectedProfile, 'sol-max')
})

test('V3-09 production agents consume v3 and never self-select a model', () => {
    const agentRoot = path.join(packageRoot, 'agents')
    for (const file of fs.readdirSync(agentRoot)) {
        const source = fs.readFileSync(path.join(agentRoot, file), 'utf8')
        assert.match(source, /stage-model-pool\.v3/u)
        assert.doesNotMatch(source, /stage-model-pool\.v2/u)
        assert.doesNotMatch(source, /gpt-5\.6-luna|luna-(?:low|high|max)/u)
    }
})

test('V3-10 selector, frontier and gate do not own model selection', () => {
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

test('V3-11 no positive production policy retains Luna or Ultra', () => {
    for (const relative of [
        'policy/model-pool.json',
        'policy/routing-policy.json',
        'policy/execution-routing-policy.json',
        'policy/profile-capability-matrix.json',
        'policy/profile-capability-observations.json'
    ]) {
        const source = fs.readFileSync(path.join(packageRoot, relative), 'utf8')
        assert.doesNotMatch(
            source,
            /gpt-5\.6-luna|luna-(?:low|high|max)|(?:sol|terra)-ultra/u
        )
    }
})

test('V3-12 one policy digest is bound by manifest and all five cwd installs', () => {
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
