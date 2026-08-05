import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    STAGE_MODEL_POOL_POLICY,
    STAGE_ROUTE_DEFINITIONS,
    compileStageRoutingIdentity
} from '../../skills/issue-orchestration/scripts/stage-profile-policy.mjs'
import {
    compileRuntimeExecutionBinding
} from '../../skills/issue-orchestration/scripts/runtime-execution-binding.mjs'
import {
    compileRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    REVIEWED_ROUTING_ASSUMPTIONS
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    createTrustedRepositoryFixture
} from './issue-orchestration-trusted-repository-test-helper.mjs'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const repositoryRoot = createTrustedRepositoryFixture()
const stagePolicy = JSON.parse(fs.readFileSync(
    path.join(root, 'policy/stage-permissions.json'),
    'utf8'
))

function schema(file) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', file),
        'utf8'
    ))
}

function trustFixture() {
    const startup = verifiedRuntimeStartup({})
    const repositoryTargets = [{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath: repositoryRoot
    }]
    const runtimeTrustBinding = compileRuntimeTrustBinding({
        role: 'root-scheduler',
        executionClass: 'root-control',
        runtimeId: 'codex',
        multiAgentBackend: 'v2',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        repositoryTargets,
        startup
    })
    return {
        startup,
        repositoryTargets,
        runtimeTrustBinding
    }
}

function executionObservation({
    fixture,
    actorInvocationId = 'actor-invocation-1',
    actorSessionId = 'actor-session-1',
    profile = 'terra-high',
    stageRole = 'code-implementer',
    stagePhase = 'implementation',
    overrides = {}
}) {
    const effort = profile.split('-').at(-1)
    const model = profile.startsWith('sol-')
        ? 'gpt-5.6-sol'
        : profile.startsWith('luna-')
            ? 'gpt-5.6-terra'
        : 'gpt-5.6-terra'
    const value = {
        schema:
            'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId,
        actorSessionId,
        rootInvocationId:
            fixture.startup.attestation.runtimeInvocationId,
        requestedRole: stageRole,
        effectiveRole: stageRole,
        requestedPhase: stagePhase,
        effectivePhase: stagePhase,
        requestedProfile: profile,
        effectiveProfile: profile,
        requestedModel: model,
        effectiveModel: model,
        requestedEffort: effort,
        effectiveEffort: effort,
        routeDecisionDigest:
            digest({ profile, stageRole, stagePhase }),
        packageDigest:
            fixture.startup.observation.packageDigest,
        modelPoolPolicyDigest:
            fixture.startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            fixture.startup.observation.policyDigests
                .executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-03T01:01:00.000Z',
        ...overrides
    }
    value.observationDigest = digest(value)
    return value
}

function routeIdentity(runtimeObservation) {
    return {
        selectedProfile: runtimeObservation.requestedProfile,
        routeDecisionDigest:
            runtimeObservation.routeDecisionDigest
    }
}

test('stage-permissions.v2 defines every stage by semantic execution class', () => {
    assert.deepEqual(
        validateJsonSchema(
            stagePolicy,
            schema('stage-permissions-policy.schema.json')
        ),
        []
    )
    assert.deepEqual(
        Object.keys(stagePolicy.stages).sort(),
        Object.keys(STAGE_ROUTE_DEFINITIONS).sort()
    )
    assert.equal(
        JSON.stringify(stagePolicy).includes('sandbox'),
        false
    )
    for (const definition of Object.values(
        STAGE_ROUTE_DEFINITIONS
    )) {
        assert.ok([
            'root-control',
            'observe-only',
            'leased-writer'
        ].includes(definition.executionClass))
        assert.equal(
            definition.mutationPostconditionRequired,
            true
        )
        assert.equal(Object.hasOwn(definition, 'sandbox'), false)
    }
})

test('logical stage routes contain execution semantics but no runtime sandbox authority', () => {
    const route = compileStageRoutingIdentity({
        domain: 'generic-code',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('routing-evidence'),
        routingPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        requiredSkillDigests: []
    })
    assert.equal(route.executionClass, 'leased-writer')
    assert.equal(route.writeScope, 'implementation-only')
    assert.equal(route.leaseRequirement, 'stage-write-lease')
    assert.equal(Object.hasOwn(route, 'sandbox'), false)
    assert.throws(() => compileStageRoutingIdentity({
        domain: 'generic-code',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('routing-evidence'),
        routingPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        sandbox: 'workspace-write'
    }), { code: 'routing-legacy-sandbox-authority' })
})

test('actual full permission binds independently to observe-only and leased-writer semantics', () => {
    const fixture = trustFixture()
    const observeObservation = executionObservation({
        fixture,
        profile: 'sol-max',
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal'
    })
    const observe = compileRuntimeExecutionBinding({
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        runtimeObservation: observeObservation,
        ...routeIdentity(observeObservation),
        ...fixture
    })
    assert.equal(observe.executionClass, 'observe-only')
    assert.equal(
        observe.effectivePermissionProfile,
        'danger-full-access'
    )
    assert.equal(observe.writeLeaseDigest, null)
    assert.equal(observe.mutationContract, 'no-protected-mutation')
    assert.equal(
        observe.requiredPostconditionEvidenceClass,
        'observe-only-mutation-postcondition'
    )

    const leaseDigest = digest('writer-lease')
    const writerObservation = executionObservation({ fixture })
    const writer = compileRuntimeExecutionBinding({
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        runtimeObservation: writerObservation,
        ...routeIdentity(writerObservation),
        writeLeaseDigest: leaseDigest,
        ...fixture
    })
    assert.equal(writer.executionClass, 'leased-writer')
    assert.equal(
        writer.mutationContract,
        'lease-and-slice-allowlist'
    )
    assert.equal(writer.writeLeaseDigest, leaseDigest)
    assert.deepEqual(
        validateJsonSchema(
            writer,
            schema('runtime-execution-binding.schema.json')
        ),
        []
    )
})

test('leases and legacy sandbox claims cannot change execution class', () => {
    const fixture = trustFixture()
    const writerObservation = executionObservation({ fixture })
    assert.throws(() => compileRuntimeExecutionBinding({
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        runtimeObservation: writerObservation,
        ...routeIdentity(writerObservation),
        ...fixture
    }), { code: 'runtime-execution-write-lease-required' })
    const observer = executionObservation({
        fixture,
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal'
    })
    assert.throws(() => compileRuntimeExecutionBinding({
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        runtimeObservation: observer,
        ...routeIdentity(observer),
        writeLeaseDigest: digest('forged-lease'),
        ...fixture
    }), { code: 'runtime-execution-write-lease-forbidden' })

    const legacy = executionObservation({
        fixture,
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal'
    })
    delete legacy.observationDigest
    legacy.sandbox = 'read-only'
    legacy.observationDigest = digest(legacy)
    assert.throws(() => compileRuntimeExecutionBinding({
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        runtimeObservation: legacy,
        ...routeIdentity(legacy),
        ...fixture
    }), { code: 'runtime-execution-legacy-sandbox-authority' })

    const writerMasquerade = executionObservation({ fixture })
    assert.throws(() => compileRuntimeExecutionBinding({
        stageRole: 'test-owner',
        stagePhase: 'behavior-verification',
        runtimeObservation: writerMasquerade,
        ...routeIdentity(writerMasquerade),
        ...fixture
    }), {
        code:
            'runtime-execution-stage-or-permission-binding-mismatch'
    })
})

test('reviewed routing assumptions and logical eligibility contain no sandbox dimension', () => {
    assert.equal(
        JSON.stringify(REVIEWED_ROUTING_ASSUMPTIONS)
            .includes('Sandbox'),
        false
    )
    assert.equal(
        JSON.stringify(REVIEWED_ROUTING_ASSUMPTIONS)
            .includes('sandbox'),
        false
    )
})
