import fs from 'node:fs'
import path from 'node:path'

import {
    assertDigest,
    assertText,
    digest,
    fail,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    STAGE_ROUTE_DEFINITIONS,
    verifyRuntimeProfileMetadata
} from './stage-profile-policy.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'
import {
    validateRuntimeTrustBinding
} from './runtime-trust-policy.mjs'

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/runtime-execution-binding-policy.json'
)

export const RUNTIME_EXECUTION_BINDING_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const RUNTIME_EXECUTION_BINDING_POLICY_DIGEST =
    digest(RUNTIME_EXECUTION_BINDING_POLICY)

function stageDefinition(stageRole, stagePhase) {
    const definition = STAGE_ROUTE_DEFINITIONS[
        `${stageRole}:${stagePhase}`
    ]
    if (!definition) fail('runtime-execution-stage-unknown')
    return definition
}

function validateObservation(value) {
    if (value?.schema !==
            'issue-orchestration.runtime-execution-observation.v1' ||
        value.producerAuthority !==
            RUNTIME_EXECUTION_BINDING_POLICY
                .trustedProducerAuthority ||
        !RUNTIME_EXECUTION_BINDING_POLICY.supportedRuntimeIds
            .includes(value.runtimeId) ||
        value.effectiveMultiAgentBackend !== 'v2' ||
        value.observationDigest !==
            unsignedDigest(value, 'observationDigest')) {
        fail('runtime-execution-observation-untrusted')
    }
    for (const field of [
        'runtimeVersion',
        'actorInvocationId',
        'actorSessionId',
        'rootInvocationId',
        'requestedRole',
        'effectiveRole',
        'requestedPhase',
        'effectivePhase',
        'effectivePermissionProfile',
        'permissionInheritance',
        'permissionGuarantee'
    ]) {
        assertText(
            value[field],
            'runtime-execution-observation-incomplete'
        )
    }
    for (const field of [
        'sandbox',
        'requiredSandbox',
        'supportedSandboxes'
    ]) {
        if (Object.hasOwn(value, field)) {
            fail('runtime-execution-legacy-sandbox-authority')
        }
    }
    return value
}

export function compileRuntimeExecutionBinding({
    stageRole,
    stagePhase,
    selectedProfile,
    routeDecisionDigest,
    runtimeObservation,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    writeLeaseDigest = null
} = {}) {
    const definition = stageDefinition(stageRole, stagePhase)
    const observation = validateObservation(runtimeObservation)
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    validateRuntimeTrustBinding(runtimeTrustBinding, {
        repositoryTargets,
        startup
    })
    assertDigest(
        routeDecisionDigest,
        'runtime-execution-route-decision-required'
    )
    if (!definition.allowedProfiles.includes(selectedProfile)) {
        fail('runtime-execution-profile-not-authorized')
    }
    try {
        verifyRuntimeProfileMetadata({
            selectedProfile,
            requestedModel: observation.requestedModel,
            effectiveModel: observation.effectiveModel,
            requestedEffort: observation.requestedEffort,
            effectiveEffort: observation.effectiveEffort,
            multiAgentBackend:
                observation.effectiveMultiAgentBackend
        })
    } catch {
        fail('runtime-execution-profile-mismatch')
    }
    if (observation.requestedProfile !== selectedProfile ||
        observation.effectiveProfile !== selectedProfile ||
        observation.routeDecisionDigest !== routeDecisionDigest ||
        observation.packageDigest !==
            startup.observation.packageDigest ||
        observation.modelPoolPolicyDigest !==
            startup.observation.policyDigests.modelPool ||
        observation.executionRoutingPolicyDigest !==
            startup.observation.policyDigests.executionRouting) {
        fail('runtime-execution-profile-or-policy-binding-mismatch')
    }
    if (observation.rootInvocationId !==
            startupBinding.runtimeInvocationId ||
        observation.requestedRole !== stageRole ||
        observation.effectiveRole !== stageRole ||
        observation.requestedPhase !== stagePhase ||
        observation.effectivePhase !== stagePhase ||
        observation.runtimeId !== runtimeTrustBinding.runtimeId ||
        observation.effectiveMultiAgentBackend !==
            runtimeTrustBinding.multiAgentBackend ||
        observation.effectivePermissionProfile !==
            runtimeTrustBinding.effectivePermissionProfile ||
        observation.permissionInheritance !==
            runtimeTrustBinding.childPermissionInheritance ||
        observation.permissionGuarantee !==
            runtimeTrustBinding.permissionGuarantee) {
        fail('runtime-execution-stage-or-permission-binding-mismatch')
    }
    if (definition.executionClass === 'root-control') {
        if (observation.actorInvocationId !==
                startupBinding.runtimeInvocationId ||
            observation.actorSessionId !==
                startupBinding.runtimeSessionId) {
            fail('runtime-execution-root-identity-mismatch')
        }
    } else if (observation.actorInvocationId ===
        startupBinding.runtimeInvocationId) {
        fail('runtime-execution-child-identity-required')
    }
    if ([
        'stage-write-lease',
        'root-control-lease'
    ].includes(definition.leaseRequirement)) {
        assertDigest(
            writeLeaseDigest,
            definition.leaseRequirement === 'root-control-lease'
                ? 'runtime-execution-root-lease-required'
                : 'runtime-execution-write-lease-required'
        )
    } else if (writeLeaseDigest !== null) {
        fail('runtime-execution-write-lease-forbidden')
    }
    return seal({
        schema:
            'issue-orchestration.runtime-execution-binding.v1',
        policyDigest:
            RUNTIME_EXECUTION_BINDING_POLICY_DIGEST,
        status: 'verified',
        stageRole,
        stagePhase,
        executionClass: definition.executionClass,
        runtimeId: observation.runtimeId,
        runtimeVersion: observation.runtimeVersion,
        actorInvocationId: observation.actorInvocationId,
        actorSessionId: observation.actorSessionId,
        rootInvocationId: observation.rootInvocationId,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeTrustBindingDigest:
            runtimeTrustBinding.bindingDigest,
        runtimeObservationDigest:
            observation.observationDigest,
        selectedProfile,
        requestedModel: observation.requestedModel,
        effectiveModel: observation.effectiveModel,
        requestedEffort: observation.requestedEffort,
        effectiveEffort: observation.effectiveEffort,
        routeDecisionDigest,
        packageDigest: observation.packageDigest,
        modelPoolPolicyDigest:
            observation.modelPoolPolicyDigest,
        executionRoutingPolicyDigest:
            observation.executionRoutingPolicyDigest,
        effectiveMultiAgentBackend:
            observation.effectiveMultiAgentBackend,
        effectivePermissionProfile:
            observation.effectivePermissionProfile,
        permissionInheritance:
            observation.permissionInheritance,
        permissionGuarantee:
            observation.permissionGuarantee,
        machineEnforcedRoleIsolation:
            runtimeTrustBinding.machineEnforcedRoleIsolation,
        mutationContract:
            definition.mutationContract,
        requiredPostconditionEvidenceClass:
            definition.requiredPostconditionEvidenceClass,
        mutationPostconditionRequired:
            definition.mutationPostconditionRequired,
        writeLeaseDigest
    }, 'bindingDigest')
}

export function validateRuntimeExecutionBinding(value, {
    stageRole,
    stagePhase,
    selectedProfile,
    routeDecisionDigest,
    startup,
    runtimeTrustBinding,
    repositoryTargets
} = {}) {
    if (value?.schema !==
            'issue-orchestration.runtime-execution-binding.v1' ||
        value.policyDigest !==
            RUNTIME_EXECUTION_BINDING_POLICY_DIGEST ||
        value.status !== 'verified' ||
        value.bindingDigest !==
            unsignedDigest(value, 'bindingDigest')) {
        fail('runtime-execution-binding-invalid')
    }
    const definition = stageDefinition(stageRole, stagePhase)
    if (value.stageRole !== stageRole ||
        value.stagePhase !== stagePhase ||
        value.executionClass !== definition.executionClass ||
        value.selectedProfile !== selectedProfile ||
        value.routeDecisionDigest !== routeDecisionDigest) {
        fail('runtime-execution-stage-binding-mismatch')
    }
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    validateRuntimeTrustBinding(runtimeTrustBinding, {
        repositoryTargets,
        startup
    })
    if (value.startupAttestationDigest !==
            startupBinding.startupAttestationDigest ||
        value.rootInvocationId !==
            startupBinding.runtimeInvocationId ||
        value.packageDigest !==
            startup.observation.packageDigest ||
        value.modelPoolPolicyDigest !==
            startup.observation.policyDigests.modelPool ||
        value.executionRoutingPolicyDigest !==
            startup.observation.policyDigests.executionRouting ||
        value.runtimeTrustBindingDigest !==
            runtimeTrustBinding.bindingDigest ||
        value.effectivePermissionProfile !==
            runtimeTrustBinding.effectivePermissionProfile ||
        value.permissionInheritance !==
            runtimeTrustBinding.childPermissionInheritance ||
        value.permissionGuarantee !==
            runtimeTrustBinding.permissionGuarantee ||
        value.mutationContract !== definition.mutationContract ||
        value.requiredPostconditionEvidenceClass !==
            definition.requiredPostconditionEvidenceClass ||
        value.mutationPostconditionRequired !== true) {
        fail('runtime-execution-permission-binding-mismatch')
    }
    return value
}
