import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const policyPath = path.join(
    root,
    'skills/issue-orchestration/scripts/stage-profile-policy.mjs'
)
const canonicalCompilerPath = path.join(
    root,
    'skills/issue-orchestration/scripts/execution-route-compiler.mjs'
)
const contract = readJson('stage-profile-test-contract.json')
const acceptance = readJson('stage-profile-acceptance-map.json')
const controls = readJson('stage-profile-mutation-controls.json').controls
const probes = readJson('stage-profile-runtime-probes.json').probes

const hash = (character) => character.repeat(64)
const REQUIRED_CLASSIFICATION_FIELDS = [
    'domain', 'effectiveOwnerRepository', 'engineeringRiskClass',
    'uiDecisionClass', 'contractState', 'verificationClass',
    'modelRoutingEvidenceDigest', 'routingPolicyVersion'
]
const REQUIRED_PROFILE_FIELDS = [
    'stageProfilePolicyVersion', 'stageRole', 'stagePhase', 'allowedProfiles',
    'defaultProfile', 'routingAuthority', 'routingInputDigest',
    'selectedProfile', 'selectedProfileReason',
    'routeCellId', 'canonicalPolicyDigest', 'requiredProfile',
    'routeDecisionDigest', 'executionClass',
    'stateAuthority', 'outputAuthority', 'remoteAuthority',
    'leaseRequirement', 'mutationContract',
    'requiredPostconditionEvidenceClass', 'mutationPostconditionRequired',
    'writeScope',
    'requiredSkillDigests', 'capabilityDigest'
]
const EXPECTED_POOLS = {
    'root-scheduler:scheduling':
        [['terra-low'], 'terra-low'],
    'root-scheduler:recovery-takeover':
        [['terra-medium'], 'terra-medium'],
    'dag-creator-updater:semantic-proposal':
        [['terra-high', 'sol-high', 'sol-xhigh', 'sol-max'],
            'terra-high'],
    'test-owner:test-contract-planning':
        [['terra-high', 'sol-high', 'sol-xhigh'],
            'terra-high'],
    'test-owner:test-contract':
        [['terra-medium', 'terra-high',
            'sol-high', 'sol-xhigh'], 'terra-medium'],
    'test-owner:behavior-verification':
        [['terra-high', 'sol-high', 'sol-xhigh'],
            'terra-high'],
    'code-implementer:implementation':
        [['terra-low', 'terra-medium', 'terra-high',
            'sol-medium', 'sol-high', 'sol-xhigh'], 'terra-medium'],
    'code-implementer:landing-conflict-resolution':
        [['terra-medium', 'terra-high', 'sol-high', 'sol-xhigh'],
            'terra-medium'],
    'ui-ux-implementer:ui-implementation':
        [['sol-low', 'sol-medium'], 'sol-low'],
    'ui-ux-implementer:landing-conflict-resolution':
        [['terra-medium', 'terra-high', 'sol-medium', 'sol-high',
            'sol-xhigh'], 'terra-medium'],
    'ui-system-adjudicator:adjudication':
        [['sol-high', 'sol-xhigh'], 'sol-high'],
    'ux-acceptance-verifier:ux-acceptance':
        [['sol-medium', 'sol-high', 'sol-xhigh'], 'sol-medium'],
    'documentation-writer:documentation':
        [['terra-low', 'terra-medium', 'sol-medium', 'sol-high'],
            'terra-medium']
}

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

async function policy() {
    return import(`${pathToFileURL(policyPath).href}?contract=${Date.now()}-${Math.random()}`)
}

function classification(overrides = {}) {
    return {
        domain: 'generic-code',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: hash('a'),
        routingPolicyVersion: 'stage-model-pool.v4',
        ...overrides
    }
}

function assignment(overrides = {}) {
    return {
        schema: 'issue-orchestration.stage-assignment.v3',
        stageProfilePolicyVersion: 'stage-model-pool.v4',
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        allowedProfiles: [
            'terra-low', 'terra-medium', 'terra-high',
            'sol-medium', 'sol-high', 'sol-xhigh'
        ],
        defaultProfile: 'terra-medium',
        routingAuthority: 'canonical-route-cell-compiler',
        routingInputDigest: hash('b'),
        selectedProfile: 'terra-medium',
        selectedProfileReason: 'engineering-risk-bounded',
        routeCellId: 'implementation.ordinary-bounded-single-module',
        canonicalPolicyDigest: hash('7'),
        requiredProfile: 'terra-medium',
        routeDecisionDigest: hash('8'),
        executionClass: 'leased-writer',
        stateAuthority: 'none',
        outputAuthority: 'implementation-candidate',
        remoteAuthority: 'none',
        leaseRequirement: 'stage-write-lease',
        mutationContract: 'lease-and-slice-allowlist',
        requiredPostconditionEvidenceClass:
            'leased-writer-mutation-postcondition',
        mutationPostconditionRequired: true,
        writeScope: 'implementation-only',
        requiredSkillDigests: [],
        capabilityDigest: hash('c'),
        classification: classification(),
        memberIssueId: 'ExampleOrg/RepositoryA#1819',
        memberRoutingReceiptDigest: hash('d'),
        freshContext: false,
        forkTurns: '3',
        inheritedThreadId: null,
        runtimeCapability: {
            requestedModel: 'gpt-5.6-terra',
            effectiveModel: 'gpt-5.6-terra',
            requestedEffort: 'medium',
            effectiveEffort: 'medium',
            multiAgentBackend: 'v2',
            available: true
        },
        executionRouteDecision: {
            schema: 'issue-orchestration.execution-route-decision.v2',
            policyVersion: 'execution-capability-routing.v5',
            routingAuthority: 'canonical-route-cell-compiler',
            stageRole: 'code-implementer',
            stagePhase: 'implementation',
            selectedProfile: 'terra-medium',
            selectedProfileReason: 'engineering-risk-bounded',
            requiredProfile: 'terra-medium',
            routeCellId:
                'implementation.ordinary-bounded-single-module',
            canonicalPolicyDigest: hash('7'),
            routeDecisionDigest: hash('8')
        },
        candidate: {
            status: 'candidate-green',
            attemptId: 'attempt-1819-1',
            frozenTestTreeDigestBefore: hash('e'),
            frozenTestTreeDigestAfter: hash('e'),
            modifiedPaths: ['skills/issue-orchestration/scripts/stage-profile-policy.mjs']
        },
        ...overrides
    }
}

function assertCode(error, expectedCode) {
    return error?.code === expectedCode
}

function requireFunction(module, name) {
    assert.equal(typeof module[name], 'function',
        `stage-model-pool.v4 must export ${name}()`)
    return module[name]
}

function legacyDiscoveries() {
    const discoveries = []
    const source = fs.readFileSync(policyPath, 'utf8')
    if (/stage-profiles\.v1/u.test(source)) discoveries.push('stage-profiles.v1')
    if (/export const STAGE_PROFILES/u.test(source)) discoveries.push('fixed-STAGE_PROFILES')
    for (const name of [
        'issue-dag-agent.toml', 'issue-test-owner.toml',
        'issue-code-implementer.toml', 'issue-ui-ux-implementer.toml',
        'issue-ux-acceptance-verifier.toml', 'issue-documentation-writer.toml',
        'issue-cleanup-verifier.toml'
    ]) {
        const file = path.join(root, '.codex/agents', name)
        if (fs.existsSync(file) && /^model\s*=/mu.test(fs.readFileSync(file, 'utf8'))) {
            discoveries.push(name)
        }
    }
    return discoveries
}

test('contract assets are frozen against the merged issue body', () => {
    assert.equal(contract.schema, 'issue-orchestration.stage-profile-test-contract.v4')
    assert.equal(contract.baseSha, '3b2f76362ec09f8267f2fb0a21dbe3a775cb000b')
    assert.deepEqual(contract.authority, {
        kind: 'superseding-package-issues',
        issueIds: [
            'Ozwasyd/issue-orchestration#5',
            'Ozwasyd/issue-orchestration#11',
            'Ozwasyd/issue-orchestration#16',
            'Ozwasyd/issue-orchestration#77'
        ],
        updatedAt: '2026-08-06T00:44:00+08:00'
    })
    assert.deepEqual(
        acceptance.acceptance.flatMap(({ mutations }) => mutations).sort(),
        controls.map(({ id }) => id).sort()
    )
    assert.deepEqual(probes.map(({ mutation }) => mutation),
        controls.map(({ id }) => id))
    for (const [relative, expected] of Object.entries(contract.fileHashes)) {
        assert.equal(digest(fs.readFileSync(path.join(root, relative))), expected)
    }
    const unsigned = structuredClone(contract)
    delete unsigned.testContractDigest
    assert.equal(digest(unsigned), contract.testContractDigest)
})

test('P01 mandatory classification fields and enums are versioned', async () => {
    const module = await policy()
    assert.deepEqual(module.REQUIRED_ROUTING_FIELDS, REQUIRED_CLASSIFICATION_FIELDS)
    assert.equal(module.ROUTING_POLICY_VERSION, 'stage-model-pool.v4')
    assert.deepEqual(module.ROUTING_ENUMS, {
        domain: [
            'generic-code', 'ui-ux', 'documentation', 'orchestration-core',
            'deterministic-cleanup'
        ],
        engineeringRiskClass: ['bounded', 'complex', 'high-risk', 'frontier'],
        uiDecisionClass: [
            'none', 'prescribed', 'bounded-composition', 'layout-judgment',
            'interaction-judgment', 'system-design-dispute'
        ],
        contractState: ['frozen', 'disputed', 'owner-unresolved', 'authority-conflict'],
        verificationClass: [
            'focused', 'cross-module', 'runtime', 'protocol', 'security',
            'ux-local', 'ux-path', 'ux-system'
        ]
    })
})

test('P02 classification validation rejects missing or invalid authority evidence', async () => {
    const validate = requireFunction(await policy(), 'validateRoutingClassification')
    assert.doesNotThrow(() => validate(classification()))
    for (const mutation of [
        (value) => { delete value.domain },
        (value) => { value.engineeringRiskClass = 'medium' },
        (value) => { value.modelRoutingEvidenceDigest = 'agent-self-report' }
    ]) {
        const value = classification()
        mutation(value)
        assert.throws(() => validate(value))
    }
})

test('P03 one manifest owns every allowed pool and the full stage schema', async () => {
    const module = await policy()
    const manifest = module.STAGE_MODEL_POOL_POLICY
    assert.equal(manifest?.schema, 'issue-orchestration.stage-model-pool-policy.v4')
    assert.equal(manifest?.version, 'stage-model-pool.v4')
    assert.deepEqual(Object.keys(manifest?.stages ?? {}).sort(),
        Object.keys(EXPECTED_POOLS).sort())
    for (const [key, [allowedProfiles, defaultProfile]] of Object.entries(EXPECTED_POOLS)) {
        assert.deepEqual(manifest.stages[key].allowedProfiles, allowedProfiles)
        assert.equal(manifest.stages[key].defaultProfile, defaultProfile)
    }
    assert.equal(manifest.cleanup.greenAuthority, 'machine-resource-verifier')
    assert.equal(manifest.cleanup.llmProfile, null)
    assert.deepEqual(manifest.requiredStageProfileFields, REQUIRED_PROFILE_FIELDS)
})

test('P04-P09 stage identity does not select and one canonical compiler owns routing', async () => {
    const stageModule = await policy()
    const compileIdentity = requireFunction(
        stageModule,
        'compileStageRoutingIdentity'
    )
    for (const key of Object.keys(EXPECTED_POOLS)) {
        const [stageRole, stagePhase] = key.split(':')
        const identity = compileIdentity({
            ...classification(),
            stageRole,
            stagePhase
        })
        assert.equal(Object.hasOwn(identity, 'selectedProfile'), false)
        assert.equal(Object.hasOwn(identity, 'routeCellId'), false)
        assert.equal(identity.routingAuthority,
            'canonical-route-cell-compiler')
    }
    assert.equal(stageModule.compileStageRoute, undefined)
    const canonicalModule = await import(
        `${pathToFileURL(canonicalCompilerPath).href}`
        + `?contract=${Date.now()}-${Math.random()}`
    )
    requireFunction(canonicalModule, 'compileCanonicalRoute')
    assert.equal(canonicalModule.compileExecutionRoute, undefined)
    assert.equal(canonicalModule.compileExecutionReroute, undefined)
})

test('P10-P12 self-test, reclassification and member continuity validators exist', async () => {
    const module = await policy()
    for (const name of [
        'validateStageAssignment', 'validateRouteReclassification',
        'validateContinuity'
    ]) requireFunction(module, name)
})

test('P13 legacy fixed-profile shared authority is absent', () => {
    assert.deepEqual(legacyDiscoveries(), [])
    for (const pathName of [
        '.codex/agents/issue-implementer.toml',
        '.codex/agents/issue-reviewer.toml'
    ]) assert.equal(fs.existsSync(path.join(root, pathName)), false)
})

const negativeCases = {
    'N01-root-sol-rejected': () => assignment({
        stageRole: 'root-scheduler', stagePhase: 'scheduling',
        allowedProfiles: ['terra-low'],
        defaultProfile: 'terra-low',
        selectedProfile: 'sol-low', writeScope: 'none'
    }),
    'N02-bounded-terra-without-evidence': () => assignment({
        selectedProfile: 'terra-max'
    }),
    'N03-high-risk-luna': () => assignment({
        classification: classification({ engineeringRiskClass: 'high-risk' }),
        selectedProfile: 'luna-max'
    }),
    'N04-ui-forbidden-model': () => ['terra-max', 'sol-high'].map(
        (selectedProfile) => assignment({
            stageRole: 'ui-ux-implementer',
            stagePhase: 'ui-implementation',
            allowedProfiles: ['sol-low', 'sol-medium'], defaultProfile: 'sol-low',
            selectedProfile,
            classification: classification({
                domain: 'ui-ux', uiDecisionClass: 'layout-judgment'
            })
        })
    ),
    'N05-ui-dispute-bypasses-adjudicator': () => assignment({
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation',
        allowedProfiles: ['sol-low', 'sol-medium'], defaultProfile: 'sol-low',
        selectedProfile: 'sol-medium',
        classification: classification({
            domain: 'ui-ux', uiDecisionClass: 'system-design-dispute'
        }),
        adjudicationReceiptDigest: null
    }),
    'N06-verifier-context-inheritance': () => assignment({
        stageRole: 'test-owner', stagePhase: 'behavior-verification',
        allowedProfiles: [
            'terra-high', 'terra-xhigh', 'terra-max', 'sol-high', 'sol-xhigh'
        ],
        defaultProfile: 'terra-high', selectedProfile: 'terra-high',
        writeScope: 'none',
        freshContext: false, forkTurns: 'all',
        inheritedThreadId: 'implementer-thread'
    }),
    'N07-frozen-test-modified': () => assignment({
        candidate: {
            status: 'candidate-green', attemptId: 'attempt-1819-1',
            frozenTestTreeDigestBefore: hash('e'),
            frozenTestTreeDigestAfter: hash('f'),
            modifiedPaths: ['tests/tools/issue-orchestration-stage-profiles.test.mjs']
        }
    }),
    'N08-internal-red-escalates': () => ({
        schema: 'issue-orchestration.route-reclassification.v1',
        previousProfile: 'terra-medium',
        blockerClass: 'implementer-internal-red',
        blockerReceiptDigest: hash('1'),
        newRiskOrVerificationClass: 'complex',
        newProfile: 'sol-high',
        policyVersion: 'stage-model-pool.v4',
        sourceRole: 'code-implementer',
        sourcePhase: 'self-test',
        opensNewAttempt: true,
        triggersSemanticDagUpdate: true
    }),
    'N09-silent-capability-fallback': () => assignment({
        runtimeCapability: {
            requestedProfile: 'terra-medium',
            effectiveProfile: 'sol-high',
            available: false
        },
        capabilityMissingReceipt: null
    }),
    'N10-group-member-inherits-route': () => ({
        previous: assignment({
            memberIssueId: 'ExampleOrg/RepositoryA#1818',
            memberRoutingReceiptDigest: hash('8')
        }),
        next: assignment({
            memberIssueId: 'ExampleOrg/RepositoryA#1819',
            memberRoutingReceiptDigest: hash('8')
        })
    }),
    'N11-telemetry-controls-policy': () => assignment({
        routingAuthority: 'telemetry-cost-optimizer',
        selectedProfileReason: 'cheapest-current-profile'
    })
}

for (const control of controls) {
    test(`NEGATIVE ${control.id}: ${control.requirement}`, async () => {
        if (control.surface === 'source-discovery') {
            assert.deepEqual(legacyDiscoveries(), [], control.expectedCode)
            return
        }
        const module = await policy()
        const name = control.surface === 'assignment'
            ? 'validateStageAssignment'
            : control.surface === 'reclassification'
                ? 'validateRouteReclassification'
                : 'validateContinuity'
        const validate = requireFunction(module, name)
        const values = negativeCases[control.id]()
        for (const value of Array.isArray(values) ? values : [values]) {
            assert.throws(() => validate(value),
                (error) => assertCode(error, control.expectedCode))
        }
    })
}
