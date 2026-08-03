#!/usr/bin/env node
// Shared issue-orchestration package runtime.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    STAGE_MODEL_POOL_POLICY,
    STAGE_ROUTE_DEFINITIONS,
    compileStageRoute,
    compileStageRoutingIdentity,
    splitProfile
} from './stage-profile-policy.mjs'
import {
    EXECUTION_ROUTING_POLICY_DIGEST,
    compileExecutionRoute
} from './execution-route-compiler.mjs'
import {
    compileExecutableSlice,
    validateCompiledDispatchPrompt
} from './executable-slice-compiler.mjs'
import { evaluateSliceTerminalGate } from './writer-stage-progress.mjs'
import { verifyCleanupReceipt } from './resource-lifecycle.mjs'
import {
    attestRuntimeStartup,
    compileRuntimeStartupObservation
} from './runtime-startup-attestation.mjs'
import {
    RUNTIME_EXECUTION_BINDING_POLICY_DIGEST,
    compileRuntimeExecutionBinding
} from './runtime-execution-binding.mjs'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

const V2_REQUEST_FIELDS = [
    'schema', 'policyVersion', 'routingPolicyDigest',
    'stagePermissionsPolicyDigest', 'stageRole', 'stagePhase',
    'stageProfileId', 'allowedProfilesDigest', 'defaultProfileId',
    'routingAuthority', 'routingInputDigest', 'selectedProfileReason',
    'selectedProfileId', 'routingClassification', 'routeTransitionFrom',
    'routeTransitionReason', 'requestedByRole', 'requestId', 'runId', 'nodeId',
    'executionRoutingPolicyDigest', 'executionMetrics',
    'machineClassificationEvidence', 'machinePartitionEvidence',
    'machineFrontierEvidence', 'executionShapeClassification',
    'stageCapabilityRequirement', 'executionRouteDecision',
    'executionShapeClassificationDigest',
    'stageCapabilityRequirementDigest', 'executionRouteDecisionDigest',
    'attemptId', 'promptDigest', 'sourceDagDigest', 'frontierDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'scopeIdentityDigest',
    'dependencyIdentityDigest', 'repository', 'baseSha', 'epochId',
    'requestedModel', 'requestedEffort', 'requestedMultiAgentBackend',
    'requestedMode', 'executionClass',
    'runtimeExecutionBindingPolicyDigest',
    'startupAttestationDigest', 'runtimeInvocationId',
    'runtimeTrustBindingDigest',
    'mutationContract', 'requiredPostconditionEvidenceClass',
    'mutationPostconditionRequired',
    'requestedForkTurns', 'requestedWorkingDirectory', 'requiredSkills',
    'requiredSkillIds', 'requiredSkillDigests', 'designAuthorityDigests',
    'uiImpact', 'allowedPathsDigest', 'forbiddenPathsDigest',
    'semanticWriteScope', 'observeOnlyPolicy',
    'candidateSha', 'candidateDigest', 'testOwnerId',
    'testContractDigest', 'behaviorReceiptDigest', 'uxAcceptanceReceiptDigest',
    'documentationReceiptDigest', 'groupId', 'groupSessionDigest',
    'memberIssueId', 'memberStage', 'activeWriteLeaseId',
    'groupWorktreeIdentity', 'groupBranchIdentity',
    'testOwnerContinuityIdentity', 'implementerContinuityIdentity',
    'freshVerificationRollout', 'memberTestContractDigest',
    'memberCandidateIdentity', 'createdAt'
]

const WRITER_STAGE_KEYS = new Set([
    'test-owner:test-contract',
    'code-implementer:implementation',
    'code-implementer:landing-conflict-resolution',
    'ui-ux-implementer:ui-implementation',
    'ui-ux-implementer:landing-conflict-resolution',
    'documentation-writer:documentation',
])

class ReceiptError extends Error {
    constructor(code, message = code) {
        super(message)
        this.code = code
    }
}

function fail(code, message = code) {
    throw new ReceiptError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function sameValues(left, right) {
    return JSON.stringify(canonical(left)) ===
        JSON.stringify(canonical(right))
}

function orderedCanonical(value) {
    if (Array.isArray(value)) return value.map(orderedCanonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, orderedCanonical(value[key])]))
}

function orderedDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(orderedCanonical(value)))
        .digest('hex')
}

function unsignedDigest(value, digestField) {
    const unsigned = { ...value }
    delete unsigned[digestField]
    return digest(unsigned)
}

function containsSecret(value) {
    if (Array.isArray(value)) return value.some(containsSecret)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => {
        const sensitive =
            /(?:secret|token|password|credential|api[-_]?key|authorization)/iu
                .test(key)
        const sealedAuthorityReference =
            /(?:authorization|authority).*digest/iu.test(key) &&
            (child === null || HASH.test(child ?? ''))
        const nonSecretRoutingMetric =
            key === 'compiledContextTokens' &&
                (child === null ||
                    Number.isInteger(child) && child >= 0) ||
            key === 'exactTokenizerAvailable' &&
                typeof child === 'boolean'
        return sensitive &&
                !sealedAuthorityReference &&
                !nonSecretRoutingMetric ||
            containsSecret(child)
    })
}

function unique(values) {
    return [...new Set(values)]
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function loadStagePermissionsPolicy() {
    const policyPath = path.resolve(
        import.meta.dirname,
        '../../../policy/stage-permissions.json'
    )
    let policy
    try {
        policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
    } catch {
        throw new Error('stage-permissions-policy-source-invalid')
    }
    const expectedStageKeys = Object.keys(STAGE_ROUTE_DEFINITIONS).sort()
    const actualStageKeys = Object.keys(policy?.stages ?? {}).sort()
    if (policy?.schema !==
        'issue-orchestration.stage-permissions.v2' ||
        JSON.stringify(actualStageKeys) !==
            JSON.stringify(expectedStageKeys)) {
        throw new Error('stage-permissions-policy-source-invalid')
    }
    for (const key of expectedStageKeys) {
        const permission = policy.stages[key]
        const route = STAGE_ROUTE_DEFINITIONS[key]
        if (!permission || typeof permission !== 'object' ||
            Array.isArray(permission) ||
            JSON.stringify(Object.keys(permission).sort()) !==
                JSON.stringify([
                    'executionClass',
                    'freshContext',
                    'outputAuthority',
                    'writeScope'
                ]) ||
            !['root-control', 'observe-only', 'leased-writer']
                .includes(permission.executionClass) ||
            !['none', 'tests-only', 'implementation-only',
                'documentation-only',
                'orchestration-control-only'].includes(
                permission.writeScope
            ) ||
            typeof permission.outputAuthority !== 'string' ||
            !permission.outputAuthority ||
            typeof permission.freshContext !== 'boolean' ||
            permission.executionClass !==
                route.executionClass ||
            permission.outputAuthority !==
                route.outputAuthority ||
            permission.writeScope !== route.writeScope ||
            permission.freshContext !== route.freshContext) {
            throw new Error('stage-permissions-policy-source-invalid')
        }
    }
    return deepFreeze(policy)
}

export const STAGE_PERMISSIONS_POLICY =
    loadStagePermissionsPolicy()
export const STAGE_PERMISSIONS_POLICY_DIGEST =
    digest(STAGE_PERMISSIONS_POLICY)

export function sealCleanupReceipt(receipt) {
    verifyCleanupReceipt(receipt)
    return deepFreeze(structuredClone(receipt))
}

function observationByKind(observations, kind) {
    return observations.find((item) => item?.kind === kind)
}

function hasV2Schema(value, prefix) {
    return value?.schema === `issue-orchestration.${prefix}.v2`
}

function expectedRoutingPolicyDigest() {
    return digest(STAGE_MODEL_POOL_POLICY)
}

function expectedV2Route(input) {
    try {
        const routeInput = {
            ...input.routingClassification,
            stageRole: input.stageRole,
            stagePhase: input.stagePhase,
            requiredSkillDigests: input.requiredSkillDigests
        }
        const key = `${input.stageRole}:${input.stagePhase}`
        if (!WRITER_STAGE_KEYS.has(key)) {
            return compileStageRoute(routeInput)
        }
        const baseRoute = compileStageRoutingIdentity(routeInput)
        const bundle = compileExecutionRoute({
            stageWorkPlan: input.stageWorkPlan,
            executableSlice: input.executableSlice,
            routingClassification: input.routingClassification,
            executionMetrics: input.executionMetrics,
            machineClassificationEvidence:
                input.machineClassificationEvidence,
            machinePartitionEvidence: input.machinePartitionEvidence ??
                undefined,
            machineFrontierEvidence: input.machineFrontierEvidence ??
                undefined,
            frontierException: input.frontierException === true
        })
        const shape = bundle.executionShapeClassification
        const requirement = bundle.stageCapabilityRequirement
        const decision = bundle.executionRouteDecision
        if (!sameValues(input.executionShapeClassification, shape) ||
            !sameValues(input.stageCapabilityRequirement, requirement) ||
            !sameValues(input.executionRouteDecision, decision) ||
            input.executionShapeClassificationDigest !==
                shape.classificationDigest ||
            input.stageCapabilityRequirementDigest !==
                requirement.capabilityDigest ||
            input.executionRouteDecisionDigest !==
                decision.routeDecisionDigest) {
            fail('dispatch-execution-route-binding')
        }
        return {
            ...baseRoute,
            allowedProfiles: decision.allowedProfiles,
            routingAuthority: decision.routingAuthority,
            selectedProfile: decision.selectedProfile,
            selectedProfileReason: decision.selectedProfileReason,
            executionRouteDecisionDigest:
                decision.routeDecisionDigest
        }
    } catch (error) {
        if (error?.code === 'dispatch-execution-route-binding') {
            throw error
        }
        if (error?.code === 'routing-ui-adjudication-required') {
            fail('dispatch-ui-adjudication-required')
        }
        if (error?.code ===
                'execution-route-ui-reslice-or-adjudicate' &&
            input.routingClassification?.uiDecisionClass ===
                'system-design-dispute') {
            fail('dispatch-ui-adjudication-required')
        }
        if (typeof error?.code === 'string' &&
            error.code.startsWith('execution-route-')) {
            fail(error.code)
        }
        fail(
            'dispatch-routing-selection-mismatch',
            `dispatch-routing-selection-mismatch:${error?.code ?? error?.message ?? 'unknown'}`
        )
    }
}

function assertV2Hashes(input) {
    for (const field of [
        'routingPolicyDigest', 'stagePermissionsPolicyDigest',
        'executionRoutingPolicyDigest',
        'runtimeExecutionBindingPolicyDigest',
        'startupAttestationDigest',
        'runtimeTrustBindingDigest',
        'allowedProfilesDigest', 'routingInputDigest',
        'executionShapeClassificationDigest',
        'stageCapabilityRequirementDigest',
        'executionRouteDecisionDigest',
        'promptDigest', 'sourceDagDigest', 'frontierDigest',
        'issueSnapshotFingerprint', 'repositoryFingerprint',
        'scopeIdentityDigest', 'dependencyIdentityDigest', 'candidateDigest',
        'testContractDigest', 'allowedPathsDigest', 'forbiddenPathsDigest',
        'memberCandidateIdentity'
    ]) {
        if (!HASH.test(input[field] ?? '')) fail('dispatch-request-field-missing')
    }
}

function assertV2WriterStageBinding(input) {
    const key = `${input.stageRole}:${input.stagePhase}`
    if (!WRITER_STAGE_KEYS.has(key)) return
    for (const field of [
        'planDigest', 'sliceDigest', 'compiledPromptDigest'
    ]) {
        if (!HASH.test(input[field] ?? '')) {
            fail('dispatch-executable-slice-binding')
        }
    }
    if (!HASH.test(input.slicePolicyDigest ?? '') ||
        !HASH.test(input.plannerReceiptDigest ?? '')) {
        fail('dispatch-executable-slice-binding')
    }
    const plan = input.stageWorkPlan
    const slice = input.executableSlice
    const compiledPrompt = input.compiledPrompt
    const sequence = input.writerSequenceBinding
    let expectedSlice
    try {
        expectedSlice = compileExecutableSlice({
            plan,
            sliceId: slice?.sliceId
        })
    } catch {
        fail('dispatch-executable-slice-binding')
    }
    const sliceIndex = plan?.orderedSlices?.findIndex(
        ({ sliceId }) => sliceId === expectedSlice.sliceId
    )
    const sequenceFields = [
        'schema',
        'source',
        'projectionStatus',
        'planDigest',
        'stageAttemptId',
        'stageRole',
        'stagePhase',
        'sliceIndex',
        'expectedNextSliceId',
        'expectedNextSliceDigest',
        'prerequisiteSliceIds',
        'completedSliceReceiptDigests',
        'writerStageProjectionDigest'
    ]
    const sequenceStructurallyValid = sequence &&
        typeof sequence === 'object' &&
        !Array.isArray(sequence) &&
        JSON.stringify(Object.keys(sequence).sort()) === JSON.stringify(
            sequenceFields.sort()
        ) &&
        HASH.test(input.writerSequenceBindingDigest ?? '') &&
        orderedDigest(sequence) === input.writerSequenceBindingDigest &&
        sequence.schema ===
            'issue-orchestration.writer-slice-sequence-binding.v1' &&
        sequence.planDigest === plan?.planDigest &&
        sequence.stageAttemptId === plan?.stageAttemptId &&
        sequence.stageRole === plan?.stageRole &&
        sequence.stagePhase === plan?.stagePhase &&
        sequence.sliceIndex === sliceIndex &&
        sequence.expectedNextSliceId === expectedSlice.sliceId &&
        sequence.expectedNextSliceDigest === expectedSlice.sliceDigest &&
        JSON.stringify(sequence.prerequisiteSliceIds) === JSON.stringify(
            expectedSlice.prerequisiteSliceIds
        ) &&
        Array.isArray(sequence.completedSliceReceiptDigests) &&
        sequence.completedSliceReceiptDigests.length === sliceIndex &&
        sequence.completedSliceReceiptDigests.every((value) =>
            HASH.test(value))
    const initialSequenceValid =
        sequence?.source === 'initial-stage-plan' &&
        sequence.projectionStatus === null &&
        sliceIndex === 0 &&
        sequence.prerequisiteSliceIds.length === 0 &&
        sequence.completedSliceReceiptDigests.length === 0 &&
        (sequence.writerStageProjectionDigest === null ||
            HASH.test(sequence.writerStageProjectionDigest ?? ''))
    const projectedSequenceValid =
        sequence?.source === 'semantic-runtime-projection' &&
        ['next-slice', 'retry-authorized'].includes(
            sequence.projectionStatus
        ) &&
        HASH.test(sequence.writerStageProjectionDigest ?? '')
    if (!sequenceStructurallyValid ||
        !initialSequenceValid && !projectedSequenceValid ||
        input.plannerBindingStatus !== 'verified' ||
        plan.plannerBindingStatus !== 'verified' ||
        slice.plannerBindingStatus !== 'verified' ||
        input.plannerBindingStatus !== plan.plannerBindingStatus ||
        input.plannerBindingStatus !== slice.plannerBindingStatus ||
        input.slicePolicyDigest !== plan.slicePolicyDigest ||
        input.slicePolicyDigest !== slice.slicePolicyDigest ||
        input.slicePolicyDigest !== compiledPrompt?.slicePolicyDigest ||
        input.plannerReceiptDigest !== plan.plannerReceiptDigest ||
        input.plannerReceiptDigest !== slice.plannerReceiptDigest ||
        input.plannerReceiptDigest !== compiledPrompt?.plannerReceiptDigest ||
        input.planDigest !== plan.planDigest ||
        plan.contractBindingStatus !== 'verified' ||
        !HASH.test(plan.frozenStageContractReceiptDigest ?? '') ||
        !HASH.test(plan.resourceLeaseReceiptDigest ?? '') ||
        slice.contractBindingStatus !== 'verified' ||
        slice.frozenStageContractReceiptDigest !==
            plan.frozenStageContractReceiptDigest ||
        slice.resourceLeaseReceiptDigest !==
            plan.resourceLeaseReceiptDigest ||
        slice.activeWriteLeaseId !== plan.activeWriteLeaseId ||
        slice.stageAttemptId !== plan.stageAttemptId ||
        input.attemptId !== plan.stageAttemptId ||
        input.sliceDigest !== expectedSlice.sliceDigest ||
        slice?.sliceDigest !== expectedSlice.sliceDigest ||
        input.compiledPromptDigest !== compiledPrompt?.promptDigest ||
        input.promptDigest !== compiledPrompt?.promptDigest ||
        input.runId !== plan.runId ||
        input.repository !== plan.repository ||
        input.nodeId !== plan.node ||
        input.baseSha !== plan.baseSha ||
        input.epochId !== plan.epochId ||
        input.requestedWorkingDirectory !== plan.worktreeIdentity ||
        input.stageRole !== plan.stageRole ||
        input.stagePhase !== plan.stagePhase ||
        input.testContractDigest !== plan.testContractDigest ||
        input.routingInputDigest !== plan.routingInputDigest ||
        input.allowedPathsDigest !== digest(expectedSlice.allowedPaths) ||
        input.forbiddenPathsDigest !== digest(expectedSlice.forbiddenPaths) ||
        validateCompiledDispatchPrompt({
            plan,
            slice: expectedSlice,
            compiled: compiledPrompt
        }).length > 0) {
        fail('dispatch-executable-slice-binding')
    }
}

function assertV2SkillBinding(input) {
    if (!Array.isArray(input.requiredSkills) ||
        !Array.isArray(input.requiredSkillIds) ||
        !Array.isArray(input.requiredSkillDigests) ||
        !Array.isArray(input.designAuthorityDigests)) {
        fail('dispatch-request-field-missing')
    }
    const ids = input.requiredSkills.map(({ id }) => id)
    const digests = input.requiredSkills.map(({ digest: value }) => value)
    if (ids.some((id) => typeof id !== 'string' || !id) ||
        digests.some((value) => !HASH.test(value ?? '')) ||
        JSON.stringify(input.requiredSkillIds) !== JSON.stringify(ids) ||
        JSON.stringify(input.requiredSkillDigests) !== JSON.stringify(digests)) {
        fail('dispatch-required-skill-binding')
    }
    if (!['ui-ux-implementer', 'ux-acceptance-verifier'].includes(input.stageRole)) {
        return
    }
    const expectedIds = input.repository === 'Ozwasyd/FsusUI'
        ? ['fsusui-design-conformance']
        : ['fsusblog-design-conformance', 'fsusui-design-conformance']
    if (input.repository !== 'Ozwasyd/FsusBlog' && input.repository !== 'Ozwasyd/FsusUI') {
        fail('dispatch-ui-design-authority-policy')
    }
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds) ||
        JSON.stringify(input.designAuthorityDigests) !== JSON.stringify(digests)) {
        fail('dispatch-ui-design-authority-policy')
    }
}

function assertV2GroupBinding(input) {
    if (input.groupId === null) {
        for (const field of [
            'groupSessionDigest', 'groupWorktreeIdentity',
            'groupBranchIdentity', 'testOwnerContinuityIdentity',
            'implementerContinuityIdentity'
        ]) {
            if (input[field] !== null) fail('dispatch-group-identity-mismatch')
        }
        if (input.memberIssueId !== input.nodeId ||
            input.memberStage !== input.stagePhase ||
            input.memberTestContractDigest !== input.testContractDigest) {
            fail('dispatch-group-identity-mismatch')
        }
        return
    }
    if (typeof input.groupId !== 'string' || !input.groupId ||
        input.previousMemberRoutingReceiptDigest !== undefined ||
        input.previousMemberProfileId !== undefined) {
        fail('dispatch-member-routing-inherited')
    }
    for (const field of [
        'groupSessionDigest', 'groupWorktreeIdentity', 'groupBranchIdentity',
        'testOwnerContinuityIdentity', 'implementerContinuityIdentity'
    ]) {
        if (!HASH.test(input[field] ?? '')) fail('dispatch-group-identity-mismatch')
    }
    if (typeof input.memberIssueId !== 'string' || !input.memberIssueId ||
        typeof input.memberStage !== 'string' || !input.memberStage ||
        input.memberTestContractDigest !== input.testContractDigest) {
        fail('dispatch-group-identity-mismatch')
    }
}

function validateV2DispatchRequest(input) {
    if (containsSecret(input)) fail('dispatch-secret-material')
    for (const field of [
        'requestedSandbox',
        'requiredSandbox',
        'supportedSandboxes',
        'writePolicy',
        'readOnlyPolicy'
    ]) {
        if (Object.hasOwn(input ?? {}, field)) {
            fail('dispatch-legacy-sandbox-authority')
        }
    }
    for (const field of V2_REQUEST_FIELDS) {
        if (!Object.hasOwn(input, field)) {
            fail(field === 'groupId'
                ? 'dispatch-group-identity-missing'
                : 'dispatch-request-field-missing')
        }
    }
    if (input.schema !== 'issue-orchestration.dispatch-request.v2' ||
        input.policyVersion !== 'stage-model-pool.v3' ||
        input.routingClassification?.routingPolicyVersion !== 'stage-model-pool.v3' ||
        !SHA.test(input.baseSha ?? '') || !SHA.test(input.candidateSha ?? '')) {
        fail('dispatch-request-field-missing')
    }
    assertV2Hashes(input)
    assertV2WriterStageBinding(input)
    if (input.routingPolicyDigest !== expectedRoutingPolicyDigest()) {
        fail('dispatch-routing-policy-replay')
    }
    if (input.executionRoutingPolicyDigest !==
        EXECUTION_ROUTING_POLICY_DIGEST) {
        fail('dispatch-execution-routing-policy-replay')
    }
    if (input.stagePermissionsPolicyDigest !==
        STAGE_PERMISSIONS_POLICY_DIGEST) {
        fail('dispatch-stage-permissions-policy-replay')
    }
    if (input.runtimeExecutionBindingPolicyDigest !==
        RUNTIME_EXECUTION_BINDING_POLICY_DIGEST) {
        fail('dispatch-runtime-execution-policy-replay')
    }
    if (input.routingOverride !== undefined ||
        input.selectedByRole !== undefined ||
        input.routeSelectedBy !== undefined ||
        input.requestedByRole !== 'root-scheduler') {
        fail('dispatch-routing-authority')
    }
    if (input.routeTransitionFrom === 'ui-system-design-dispute' &&
        (!HASH.test(input.adjudicationReceiptDigest ?? '') ||
            input.routeTransitionReason !== 'ui-adjudication-complete')) {
        fail('dispatch-ui-adjudication-required')
    }
    assertV2GroupBinding(input)
    const route = expectedV2Route(input)
    const selected = splitProfile(route.selectedProfile)
    const stagePermission = STAGE_PERMISSIONS_POLICY.stages[
        `${input.stageRole}:${input.stagePhase}`
    ]
    const routeFieldsMatch = input.stageProfileId === route.selectedProfile &&
        input.selectedProfileId === route.selectedProfile &&
        input.selectedProfileReason === route.selectedProfileReason &&
        input.allowedProfilesDigest === digest(route.allowedProfiles) &&
        input.defaultProfileId === route.defaultProfile &&
        input.routingAuthority === route.routingAuthority &&
        input.routingInputDigest === route.routingInputDigest &&
        input.executionRouteDecisionDigest ===
            route.executionRouteDecisionDigest &&
        input.requestedModel === selected.model &&
        input.requestedEffort === selected.effort &&
        input.requestedMultiAgentBackend === 'v2' &&
        input.executionRouteDecision.multiAgentBackend === 'v2' &&
        input.executionClass === route.executionClass &&
        input.executionClass === stagePermission.executionClass &&
        input.mutationContract === route.mutationContract &&
        input.mutationContract ===
            STAGE_ROUTE_DEFINITIONS[
                `${input.stageRole}:${input.stagePhase}`
            ].mutationContract &&
        input.requiredPostconditionEvidenceClass ===
            route.requiredPostconditionEvidenceClass &&
        input.mutationPostconditionRequired === true &&
        input.semanticWriteScope === stagePermission.writeScope &&
        input.observeOnlyPolicy ===
            (stagePermission.executionClass === 'observe-only') &&
        input.executionRouteDecision.executionClass ===
            stagePermission.executionClass &&
        input.executionRouteDecision.runtimeExecutionBindingDigest ===
            null &&
        input.executionRouteDecision
            .runtimeExecutionBindingStatus === 'pending-observation' &&
        HASH.test(input.startupAttestationDigest ?? '') &&
        typeof input.runtimeInvocationId === 'string' &&
        input.runtimeInvocationId.length > 0 &&
        HASH.test(input.runtimeTrustBindingDigest ?? '')
    if (!routeFieldsMatch) fail('dispatch-routing-selection-mismatch')
    assertV2SkillBinding(input)
    if (input.requestDigest !== undefined &&
        input.requestDigest !== unsignedDigest(input, 'requestDigest')) {
        fail('dispatch-request-digest')
    }
    return route
}

async function sealDispatchRequestV2(input) {
    validateV2DispatchRequest(input)
    const request = structuredClone(input)
    delete request.requestDigest
    request.requestDigest = digest(request)
    return deepFreeze(request)
}

function trustedV2Observation(item) {
    const trustedSources = new Set([
        'machine-dispatch-context', 'machine-git-observation',
        'runtime-skill-loader', 'runtime-capability-registry',
        'machine-lease-registry'
    ])
    return item && trustedSources.has(item.source) &&
        item.observationDigest === unsignedDigest(item, 'observationDigest')
}

function observeRuntimeV2(request, rolloutRecords, machineObservations) {
    const session = rolloutRecords.find((item) => item?.type === 'session_meta')?.payload
    const contexts = rolloutRecords.filter((item) => item?.type === 'turn_context')
        .map((item) => item.payload)
    const context = contexts[0] ?? {}
    const spawn = session?.source?.subagent?.thread_spawn ?? {}
    const dispatch = observationByKind(machineObservations, 'dispatch-context.v2')
    const git = observationByKind(machineObservations, 'git-worktree-identity')
    const skill = observationByKind(machineObservations, 'skill-loader')
    const capability = observationByKind(machineObservations, 'runtime-capability.v2')
    const lease =
        observationByKind(machineObservations, 'group-member-lease') ??
        observationByKind(machineObservations, 'writer-stage-lease')
    return {
        schema: 'issue-orchestration.runtime-observation.v2',
        threadId: session?.session_id,
        rolloutId: session?.id,
        startedAt: rolloutRecords[0]?.timestamp,
        effectiveModel: context.model,
        effectiveEffort: context.effort,
        effectiveMultiAgentBackend:
            context.multiAgentBackend ??
            context.multi_agent_backend ??
            session?.multiAgentBackend ??
            session?.multi_agent_backend,
        effectiveRole: spawn.agent_role,
        effectiveMode: context.mode,
        effectivePermissionProfile:
            context.permission_profile ??
            context.sandbox_policy?.type,
        effectiveForkTurns: spawn.fork_turns,
        effectiveWorkingDirectory: context.cwd,
        effectiveProfileId: capability?.effectiveProfileId,
        routingInputDigest: dispatch?.routingInputDigest,
        executionRouteDecisionDigest:
            dispatch?.executionRouteDecisionDigest,
        stagePermissionsPolicyDigest:
            dispatch?.stagePermissionsPolicyDigest,
        planDigest: dispatch?.planDigest,
        sliceDigest: dispatch?.sliceDigest,
        compiledPromptDigest: dispatch?.compiledPromptDigest,
        writerSequenceBindingDigest:
            dispatch?.writerSequenceBindingDigest,
        loadedSkills: skill?.loadedSkills,
        session,
        contexts,
        dispatch,
        git,
        skill,
        capability,
        lease,
        provenanceTrusted: [dispatch, git, skill, capability, lease]
            .every(trustedV2Observation)
    }
}

function compareRuntimeV2(request, observed, priorReceipts) {
    const reasons = []
    const missing = [
        ['threadId', 'runtime-thread-id-unobservable'],
        ['rolloutId', 'runtime-rollout-id-unobservable'],
        ['startedAt', 'runtime-started-at-unobservable'],
        ['effectiveModel', 'runtime-model-unobservable'],
        ['effectiveEffort', 'runtime-effort-unobservable'],
        [
            'effectiveMultiAgentBackend',
            'runtime-multi-agent-backend-unobservable'
        ],
        ['effectiveRole', 'runtime-role-unobservable'],
        ['effectiveMode', 'runtime-mode-unobservable'],
        [
            'effectivePermissionProfile',
            'runtime-permission-profile-unobservable'
        ],
        ['effectiveForkTurns', 'runtime-fork-unobservable'],
        ['effectiveWorkingDirectory', 'runtime-working-directory-unobservable']
    ]
    for (const [field, reason] of missing) {
        if (!observed[field]) reasons.push(reason)
    }
    const actualPairs = [
        [observed.effectiveModel, request.requestedModel, 'runtime-model-mismatch'],
        [observed.effectiveEffort, request.requestedEffort, 'runtime-effort-mismatch'],
        [
            observed.effectiveMultiAgentBackend,
            request.requestedMultiAgentBackend,
            'runtime-multi-agent-backend-mismatch'
        ],
        [observed.effectiveRole, request.stageRole, 'runtime-role-mismatch'],
        [observed.effectiveMode, request.requestedMode, 'runtime-mode-mismatch'],
        [observed.effectiveForkTurns, request.requestedForkTurns, 'runtime-fork-mismatch'],
        [observed.effectiveWorkingDirectory, request.requestedWorkingDirectory,
            'runtime-working-directory-mismatch']
    ]
    for (const [actual, expected, reason] of actualPairs) {
        if (actual && actual !== expected) reasons.push(reason)
    }
    if (observed.effectiveForkTurns === 'all') reasons.push('runtime-full-history-fork')
    if (new Set(observed.contexts.map(({ model }) => model)).size > 1 ||
        new Set(observed.contexts.map(({ effort }) => effort)).size > 1 ||
        new Set(observed.contexts.map(({ mode }) => mode)).size > 1) {
        reasons.push('runtime-context-drift')
    }
    if (!observed.skill) reasons.push('runtime-skill-load-unobservable')
    const bindings = [
        [observed.dispatch?.requestId, request.requestId, 'runtime-request-id-mismatch'],
        [observed.dispatch?.promptDigest, request.promptDigest, 'runtime-prompt-digest-mismatch'],
        [observed.dispatch?.planDigest, request.planDigest,
            'runtime-plan-digest-mismatch'],
        [observed.dispatch?.sliceDigest, request.sliceDigest,
            'runtime-slice-digest-mismatch'],
        [observed.dispatch?.compiledPromptDigest, request.compiledPromptDigest,
            'runtime-compiled-prompt-digest-mismatch'],
        [observed.dispatch?.writerSequenceBindingDigest,
            request.writerSequenceBindingDigest,
            'runtime-writer-sequence-digest-mismatch'],
        [observed.dispatch?.sourceDagDigest, request.sourceDagDigest,
            'runtime-source-dag-digest-mismatch'],
        [observed.dispatch?.frontierDigest, request.frontierDigest,
            'runtime-frontier-digest-mismatch'],
        [observed.dispatch?.issueSnapshotFingerprint, request.issueSnapshotFingerprint,
            'runtime-issue-snapshot-mismatch'],
        [observed.dispatch?.repositoryFingerprint, request.repositoryFingerprint,
            'runtime-repository-fingerprint-mismatch'],
        [observed.dispatch?.scopeIdentityDigest, request.scopeIdentityDigest,
            'runtime-scope-identity-mismatch'],
        [observed.dispatch?.dependencyIdentityDigest, request.dependencyIdentityDigest,
            'runtime-dependency-identity-mismatch'],
        [observed.dispatch?.policyVersion, request.policyVersion,
            'runtime-policy-version-mismatch'],
        [observed.dispatch?.routingPolicyDigest, request.routingPolicyDigest,
            'runtime-routing-policy-digest-mismatch'],
        [observed.dispatch?.stagePermissionsPolicyDigest,
            request.stagePermissionsPolicyDigest,
            'runtime-stage-permissions-policy-digest-mismatch'],
        [observed.dispatch?.routingInputDigest, request.routingInputDigest,
            'runtime-routing-input-digest-mismatch'],
        [observed.dispatch?.executionRouteDecisionDigest,
            request.executionRouteDecisionDigest,
            'runtime-execution-route-decision-mismatch'],
        [observed.dispatch?.testContractDigest, request.testContractDigest,
            'runtime-test-contract-digest-mismatch'],
        [observed.dispatch?.epochId, request.epochId, 'runtime-epoch-id-mismatch'],
        [observed.git?.repository, request.repository, 'runtime-repository-mismatch'],
        [observed.git?.baseSha, request.baseSha, 'runtime-base-sha-mismatch'],
        [observed.git?.candidateSha, request.candidateSha,
            'runtime-candidate-identity-mismatch'],
        [observed.git?.candidateDigest, request.candidateDigest,
            'runtime-candidate-identity-mismatch'],
        [observed.git?.workingDirectory, request.requestedWorkingDirectory,
            'runtime-working-directory-mismatch']
    ]
    for (const [actual, expected, reason] of bindings) {
        if (actual !== expected) reasons.push(reason)
    }
    const capability = observed.capability
    if (!capability || capability.available !== true ||
        capability.requestedProfileId !== request.selectedProfileId ||
        capability.effectiveProfileId !== request.selectedProfileId ||
        capability.requestedModel !== request.requestedModel ||
        capability.effectiveModel !== request.requestedModel ||
        capability.requestedEffort !== request.requestedEffort ||
        capability.effectiveEffort !== request.requestedEffort ||
        capability.multiAgentBackend !==
            request.requestedMultiAgentBackend) {
        reasons.push('runtime-capability-missing')
    }
    if (!observed.provenanceTrusted) reasons.push('runtime-provenance-request-copy')
    const loaded = new Map((observed.loadedSkills ?? []).map((item) => [item.id, item.digest]))
    for (const requirement of request.requiredSkills) {
        if (!loaded.has(requirement.id)) reasons.push('runtime-required-skill-missing')
        else if (loaded.get(requirement.id) !== requirement.digest) {
            reasons.push('runtime-skill-digest-mismatch')
        }
    }
    const lease = observed.lease ?? {}
    const leasePairs = [
        [lease.groupId, request.groupId, 'runtime-group-id-mismatch'],
        [lease.memberIssueId, request.memberIssueId, 'runtime-group-member-mismatch'],
        [lease.memberStage, request.memberStage, 'runtime-group-member-stage-mismatch'],
        [lease.freshVerificationRollout, request.freshVerificationRollout,
            'runtime-verification-not-fresh']
    ]
    for (const [actual, expected, reason] of leasePairs) {
        if (actual !== expected) reasons.push(reason)
    }
    const writerKey = `${request.stageRole}:${request.stagePhase}`
    if (WRITER_STAGE_KEYS.has(writerKey)) {
        const plan = request.stageWorkPlan ?? {}
        const writerLeasePairs = [
            [lease.leaseId, plan.activeWriteLeaseId,
                'runtime-write-lease-mismatch'],
            [lease.leaseDigest, plan.resourceLeaseReceiptDigest,
                'runtime-write-lease-mismatch'],
            [lease.attemptId, request.attemptId,
                'runtime-write-lease-mismatch'],
            [lease.ownerId, request.stageRole,
                'runtime-write-lease-mismatch'],
            [lease.worktreeIdentity, request.requestedWorkingDirectory,
                'runtime-write-lease-mismatch']
        ]
        for (const [actual, expected, reason] of writerLeasePairs) {
            if (actual !== expected) reasons.push(reason)
        }
        if (lease.state !== 'active' ||
            (lease.activeLeaseOwners ?? [])
                .filter((item) =>
                    item.leaseId === plan.activeWriteLeaseId &&
                    item.attemptId === request.attemptId)
                .length !== 1) {
            reasons.push('runtime-write-lease-conflict')
        }
    }
    if (request.groupId !== null) {
        const groupedPairs = [
            [lease.groupSessionDigest, request.groupSessionDigest,
                'runtime-group-session-mismatch'],
            [lease.activeWriteLeaseId, request.activeWriteLeaseId,
                'runtime-write-lease-mismatch'],
            [lease.memberTestContractDigest, request.memberTestContractDigest,
                'runtime-member-test-contract-mismatch'],
            [lease.memberCandidateIdentity, request.memberCandidateIdentity,
                'runtime-member-candidate-mismatch'],
            [lease.testOwnerContinuityIdentity, request.testOwnerContinuityIdentity,
                'runtime-test-owner-continuity-mismatch'],
            [lease.implementerContinuityIdentity, request.implementerContinuityIdentity,
                'runtime-implementer-continuity-mismatch']
        ]
        for (const [actual, expected, reason] of groupedPairs) {
            if (actual !== expected) reasons.push(reason)
        }
        if (request.observeOnlyPolicy !== true &&
            (typeof request.activeWriteLeaseId !== 'string' ||
                !request.activeWriteLeaseId ||
                (lease.activeLeaseOwners ?? []).filter((item) =>
                    item.leaseId === request.activeWriteLeaseId).length !== 1)) {
            reasons.push('runtime-write-lease-conflict')
        }
    }
    if (['test-owner:behavior-verification',
        'ui-system-adjudicator:adjudication',
        'ux-acceptance-verifier:ux-acceptance']
        .includes(`${request.stageRole}:${request.stagePhase}`) &&
        (request.freshVerificationRollout !== true ||
            observed.effectiveForkTurns === 'all')) {
        reasons.push('runtime-verification-not-fresh')
    }
    for (const item of priorReceipts) {
        if (item?.verificationStatus !== 'verified' ||
            (item.requestId !== request.requestId &&
                item.requestDigest !== request.requestDigest)) continue
        if (item.baseSha !== request.baseSha || item.candidateSha !== request.candidateSha ||
            item.epochId !== request.epochId ||
            item.routingPolicyDigest !== request.routingPolicyDigest) {
            reasons.push('dispatch-receipt-replay')
        }
    }
    return unique(reasons)
}

function sealDispatchReceiptV2(
    request,
    runtimeObservation,
    reasons,
    runtimeExecutionBinding = null
) {
    const capabilityReasons = reasons.filter((reason) =>
        reason.endsWith('-unobservable') ||
        reason === 'runtime-provenance-request-copy' ||
        reason === 'runtime-skill-load-unobservable')
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        epochId: request.epochId,
        stageRole: request.stageRole,
        stagePhase: request.stagePhase,
        stageProfileId: request.stageProfileId,
        policyVersion: request.policyVersion,
        routingPolicyDigest: request.routingPolicyDigest,
        stagePermissionsPolicyDigest:
            request.stagePermissionsPolicyDigest,
        routingInputDigest: request.routingInputDigest,
        executionRoutingPolicyDigest:
            request.executionRoutingPolicyDigest,
        executionShapeClassificationDigest:
            request.executionShapeClassificationDigest,
        stageCapabilityRequirementDigest:
            request.stageCapabilityRequirementDigest,
        executionRouteDecisionDigest:
            request.executionRouteDecisionDigest,
        runtimeExecutionBindingDigest:
            runtimeExecutionBinding?.bindingDigest ?? null,
        runtimeRouteDigest: runtimeExecutionBinding
            ? digest({
                logicalRouteDecisionDigest:
                    request.executionRouteDecisionDigest,
                runtimeExecutionBindingDigest:
                    runtimeExecutionBinding.bindingDigest
            })
            : null,
        executionClass: request.executionClass,
        mutationContract: request.mutationContract,
        requiredPostconditionEvidenceClass:
            request.requiredPostconditionEvidenceClass,
        mutationPostconditionRequired:
            request.mutationPostconditionRequired,
        startupAttestationDigest:
            request.startupAttestationDigest,
        runtimeInvocationId:
            request.runtimeInvocationId,
        runtimeTrustBindingDigest:
            request.runtimeTrustBindingDigest,
        selectedProfileId: request.selectedProfileId,
        selectedProfileReason: request.selectedProfileReason,
        baseSha: request.baseSha,
        candidateSha: request.candidateSha,
        candidateDigest: request.candidateDigest,
        planDigest: request.planDigest ?? null,
        sliceDigest: request.sliceDigest ?? null,
        compiledPromptDigest: request.compiledPromptDigest ?? null,
        writerSequenceBindingDigest:
            request.writerSequenceBindingDigest ?? null,
        scopeIdentityDigest: request.scopeIdentityDigest,
        dependencyIdentityDigest: request.dependencyIdentityDigest,
        memberIssueId: request.memberIssueId,
        groupId: request.groupId,
        groupSessionDigest: request.groupSessionDigest,
        activeWriteLeaseId: request.activeWriteLeaseId,
        freshVerificationRollout: request.freshVerificationRollout,
        threadId: runtimeObservation.threadId,
        rolloutId: runtimeObservation.rolloutId,
        actualModel: runtimeObservation.effectiveModel,
        actualEffort: runtimeObservation.effectiveEffort,
        actualMultiAgentBackend:
            runtimeObservation.effectiveMultiAgentBackend,
        actualRole: runtimeObservation.effectiveRole,
        actualMode: runtimeObservation.effectiveMode,
        actualPermissionProfile:
            runtimeObservation.effectivePermissionProfile,
        actualForkTurns: runtimeObservation.effectiveForkTurns,
        actualWorkingDirectory: runtimeObservation.effectiveWorkingDirectory,
        actualSkillIds: (runtimeObservation.loadedSkills ?? []).map(({ id }) => id),
        runtimeMetadataDigest: digest(runtimeObservation),
        verificationStatus: reasons.length === 0
            ? 'verified'
            : capabilityReasons.length === reasons.length
                ? 'capability-unverified'
                : 'rejected',
        mismatchReasons: unique(reasons)
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

async function verifyRuntimeDispatchV2(input) {
    if (containsSecret(input.extraMetadata) || containsSecret(input.machineObservations)) {
        return {
            runtimeObservation: null,
            dispatchReceipt: sealDispatchReceiptV2(
                input.request,
                {},
                ['dispatch-secret-material']
            )
        }
    }
    let requestReasons = []
    try {
        validateV2DispatchRequest(input.request)
    } catch (error) {
        requestReasons = [error.code ?? 'dispatch-request-invalid']
    }
    const runtimeObservation = observeRuntimeV2(
        input.request,
        input.rolloutRecords ?? [],
        input.machineObservations ?? []
    )
    const reasons = requestReasons.concat(compareRuntimeV2(
        input.request,
        runtimeObservation,
        input.priorReceipts ?? []
    ))
    let runtimeExecutionBinding = null
    try {
        const stagePermission =
            STAGE_PERMISSIONS_POLICY.stages[
                `${input.request.stageRole}:` +
                input.request.stagePhase
            ]
        runtimeExecutionBinding =
            compileRuntimeExecutionBinding({
                stageRole: input.request.stageRole,
                stagePhase: input.request.stagePhase,
                selectedProfile:
                    input.request.selectedProfileId,
                routeDecisionDigest:
                    input.request.executionRouteDecisionDigest,
                runtimeObservation:
                    input.runtimeExecutionObservation,
                startup: input.startup,
                runtimeTrustBinding:
                    input.runtimeTrustBinding,
                repositoryTargets:
                    input.repositoryTargets,
                writeLeaseDigest:
                    stagePermission?.executionClass ===
                        'leased-writer'
                        ? input.request.stageWorkPlan
                            ?.resourceLeaseReceiptDigest ??
                            input.request.activeWriteLeaseId
                        : null
            })
        if (runtimeExecutionBinding.bindingDigest !==
                input.runtimeExecutionBindingDigest &&
            input.runtimeExecutionBindingDigest !== undefined) {
            reasons.push(
                'runtime-execution-binding-claimed-digest-mismatch'
            )
        }
        if (runtimeExecutionBinding.actorInvocationId !==
                runtimeObservation.rolloutId ||
            runtimeExecutionBinding.actorSessionId !==
                runtimeObservation.threadId ||
            runtimeExecutionBinding.startupAttestationDigest !==
                input.request.startupAttestationDigest ||
            runtimeExecutionBinding.runtimeTrustBindingDigest !==
                input.request.runtimeTrustBindingDigest) {
            reasons.push('runtime-execution-binding-dispatch-mismatch')
        }
    } catch (error) {
        reasons.push(
            error?.code ??
            'runtime-execution-binding-invalid'
        )
    }
    if (input.claimedRuntimeMetadataDigest &&
        input.claimedRuntimeMetadataDigest !== digest(runtimeObservation)) {
        reasons.push('runtime-metadata-digest')
    }
    return {
        runtimeObservation,
        runtimeExecutionBinding,
        dispatchReceipt: sealDispatchReceiptV2(
            input.request,
            runtimeObservation,
            unique(reasons),
            runtimeExecutionBinding
        )
    }
}

export async function verifyRootStartup(input) {
    let observation = null
    const preflightReasonCodes = []
    try {
        observation = compileRuntimeStartupObservation({
            launcherRecord: input?.launcherRecord,
            runtimeRecord: input?.runtimeRecord,
            capacityRecord: input?.capacityRecord
        })
    } catch (error) {
        preflightReasonCodes.push(
            error?.code ?? 'runtime-startup-observation-invalid'
        )
    }
    const attestation = attestRuntimeStartup({
        observation,
        takeoverContext: input?.takeoverContext ?? null,
        attestedAt: input?.attestedAt,
        preflightReasonCodes
    })
    return {
        runtimeStartupObservation: observation,
        runtimeStartupAttestation: attestation
    }
}

function hasValidReceiptDigest(receipt) {
    return receipt?.receiptDigest === unsignedDigest(receipt, 'receiptDigest')
}

function selfTestV2Reasons({ request, dispatchReceipt, contract, execution, priorReceipts }) {
    const reasons = []
    if (dispatchReceipt?.schema === 'issue-orchestration.dispatch-receipt.v1') {
        reasons.push('receipt-v1-historical-only')
    } else if (!hasV2Schema(dispatchReceipt, 'dispatch-receipt') ||
        dispatchReceipt.verificationStatus !== 'verified' ||
        !hasValidReceiptDigest(dispatchReceipt) ||
        dispatchReceipt.requestId !== request.requestId ||
        dispatchReceipt.requestDigest !== request.requestDigest ||
        dispatchReceipt.attemptId !== request.attemptId ||
        dispatchReceipt.epochId !== request.epochId ||
        dispatchReceipt.baseSha !== request.baseSha ||
        dispatchReceipt.candidateSha !== request.candidateSha ||
        dispatchReceipt.stagePhase !== request.stagePhase ||
        dispatchReceipt.planDigest !== (request.planDigest ?? null) ||
        dispatchReceipt.sliceDigest !== (request.sliceDigest ?? null)) {
        reasons.push('verified-dispatch-receipt-required')
    }
    const expectedCommands = contract.visibleTestMatrix ?? []
    if (!Array.isArray(execution.commandResults) ||
        execution.commandResults.length !== expectedCommands.length ||
        expectedCommands.some((item, index) => {
            const actual = execution.commandResults[index]
            return actual?.id !== item.id ||
                JSON.stringify(actual?.command) !== JSON.stringify(item.command) ||
                actual?.exitStatus !== 0 || actual?.skipped === true ||
                !HASH.test(actual?.resultDigest ?? '')
        })) reasons.push('self-test-visible-matrix-incomplete')
    if (execution.visibleTestMatrixDigest !== digest(expectedCommands)) {
        reasons.push('self-test-visible-matrix-incomplete')
    }
    if (execution.frozenTestContractDigest !== contract.testContractDigest ||
        execution.frozenTestTreeDigestBefore !== contract.frozenTestTree?.digest ||
        execution.frozenTestTreeDigestAfter !== contract.frozenTestTree?.digest ||
        execution.frozenTestTreeDigestBefore !== execution.frozenTestTreeDigestAfter) {
        reasons.push('self-test-frozen-tree-drift')
    }
    if (execution.runId !== request.runId || execution.nodeId !== request.nodeId ||
        execution.attemptId !== request.attemptId || execution.stageRole !== request.stageRole ||
        execution.stageProfileId !== request.stageProfileId ||
        execution.routingInputDigest !== request.routingInputDigest ||
        execution.requestDigest !== request.requestDigest ||
        execution.candidateSha !== request.candidateSha ||
        execution.baseSha !== request.baseSha) {
        reasons.push('self-test-request-mismatch')
    }
    if (!Array.isArray(execution.firstFailureRefs) || !execution.firstFailureRefs.length ||
        !execution.failureHistory?.some((item) =>
            execution.firstFailureRefs.includes(item.ref) && item.outcome === 'failed') ||
        execution.firstFailureRefs[0] !== execution.failureHistory?.[0]?.ref) {
        reasons.push('self-test-command-history-incomplete')
    }
    if (!Number.isInteger(execution.fixCycleCount) || execution.fixCycleCount < 1 ||
        !Array.isArray(execution.remainingFailures) || execution.remainingFailures.length) {
        reasons.push('self-test-remaining-failures')
    }
    if (Object.values(execution.lintTypecheckBuildResults ?? {}).includes('failed')) {
        reasons.push('self-test-quality-gate-failed')
    }
    if (!HASH.test(execution.implementationDiffDigest ?? '') ||
        !HASH.test(execution.workingTreeStatusDigest ?? '') ||
        execution.workingTreeStatusDigest !== execution.observedWorkingTreeStatusDigest) {
        reasons.push('self-test-working-tree-drift')
    }
    if (!Array.isArray(execution.modifiedPaths) || execution.modifiedPaths.some((path) =>
        !contract.allowedImplementationPaths?.includes(path))) {
        reasons.push('self-test-frozen-path-modified')
    }
    if (execution.verifierRole !== 'deterministic-machine') {
        reasons.push('self-test-verifier-authority')
    }
    for (const prior of priorReceipts ?? []) {
        if (prior?.verificationStatus === 'verified' &&
            prior.requestDigest === request.requestDigest &&
            (prior.candidateSha !== request.candidateSha ||
                prior.baseSha !== request.baseSha || prior.epochId !== request.epochId)) {
            reasons.push('self-test-receipt-replay')
        }
    }
    return unique(reasons)
}

async function verifyImplementerSelfTestV2({
    request, dispatchReceipt, contract, execution, priorReceipts = []
}) {
    const reasons = selfTestV2Reasons({
        request, dispatchReceipt, contract, execution, priorReceipts
    })
    const receipt = {
        schema: 'issue-orchestration.implementer-self-test-receipt.v2',
        runId: execution.runId,
        nodeId: execution.nodeId,
        attemptId: execution.attemptId,
        stageRole: execution.stageRole,
        stagePhase: request.stagePhase,
        planDigest: request.planDigest ?? null,
        sliceDigest: request.sliceDigest ?? null,
        stageProfileId: execution.stageProfileId,
        routingInputDigest: execution.routingInputDigest,
        requestDigest: execution.requestDigest,
        requestId: request.requestId,
        candidateSha: execution.candidateSha,
        baseSha: execution.baseSha,
        frozenTestContractDigest: execution.frozenTestContractDigest,
        frozenTestTreeDigestBefore: execution.frozenTestTreeDigestBefore,
        frozenTestTreeDigestAfter: execution.frozenTestTreeDigestAfter,
        implementationDiffDigest: execution.implementationDiffDigest,
        commands: (execution.commandResults ?? []).map(({ command }) => command),
        exitStatuses: (execution.commandResults ?? []).map(({ exitStatus }) => exitStatus),
        commandResults: structuredClone(execution.commandResults ?? []),
        visibleTestMatrixDigest: execution.visibleTestMatrixDigest,
        lintTypecheckBuildResults: structuredClone(execution.lintTypecheckBuildResults ?? {}),
        firstFailureRefs: structuredClone(execution.firstFailureRefs ?? []),
        fixCycleCount: execution.fixCycleCount,
        remainingFailures: structuredClone(execution.remainingFailures ?? []),
        workingTreeStatusDigest: execution.workingTreeStatusDigest,
        modifiedPaths: structuredClone(execution.modifiedPaths ?? []),
        verificationStatus: reasons.length ? 'rejected' : 'verified',
        mismatchReasons: reasons
    }
    receipt.receiptDigest = digest(receipt)
    return deepFreeze(receipt)
}

function assertVerifiedV2DispatchForTransition(input) {
    const receipt = input.dispatchReceipt
    if (receipt?.schema === 'issue-orchestration.dispatch-receipt.v1') {
        fail('receipt-v1-historical-only')
    }
    if (!hasV2Schema(receipt, 'dispatch-receipt') ||
        receipt.verificationStatus !== 'verified' || !hasValidReceiptDigest(receipt)) {
        fail('verified-dispatch-receipt-required')
    }
    return receipt
}

async function authorizeReceiptTransitionV2(input) {
    const dispatchReceipt = assertVerifiedV2DispatchForTransition(input)
    if (input.eventType === 'implementation.candidate-green') {
        const receipt = input.selfTestReceipt
        if (receipt?.schema === 'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-v1-historical-only')
        }
        if (!hasV2Schema(receipt, 'implementer-self-test-receipt')) {
            fail('receipt-schema-stage-mismatch')
        }
        if (receipt.verificationStatus !== 'verified' || !hasValidReceiptDigest(receipt)) {
            fail('verified-self-test-receipt-required')
        }
        if (input.candidateSha && receipt.candidateSha !== input.candidateSha ||
            receipt.candidateSha !== dispatchReceipt.candidateSha ||
            receipt.baseSha !== dispatchReceipt.baseSha ||
            receipt.requestDigest !== dispatchReceipt.requestDigest ||
            receipt.attemptId !== dispatchReceipt.attemptId) {
            fail('self-test-candidate-mismatch')
        }
        if (dispatchReceipt.sliceDigest) {
            let gate
            try {
                gate = evaluateSliceTerminalGate({
                    plan: input.stageWorkPlan,
                    currentSlice: input.currentSlice,
                    currentCheckpoint: input.currentCheckpoint,
                    terminalReceipts: input.sliceTerminalReceipts
                })
            } catch {
                fail('writer-stage-terminal-gate-required')
            }
            if (gate.nextState !== 'candidate-green' ||
                gate.candidateEligible !== true ||
                input.stageWorkPlan?.planDigest !==
                    dispatchReceipt.planDigest ||
                input.currentSlice?.sliceDigest !==
                    dispatchReceipt.sliceDigest) {
                fail('writer-stage-terminal-gate-required')
            }
        }
    }
    if (input.eventType === 'independent-verification.passed') {
        const receipt = input.behaviorReceipt
        if (hasV2Schema(receipt, 'implementer-self-test-receipt') ||
            receipt?.schema === 'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-schema-stage-mismatch')
        }
        if (!hasV2Schema(receipt, 'behavior-receipt') ||
            receipt.verificationStatus !== 'verified' || !hasValidReceiptDigest(receipt)) {
            fail('independent-behavior-receipt-required')
        }
        if (receipt.freshVerificationRollout !== true || receipt.readOnly !== true ||
            receipt.stageRole !== 'test-owner') {
            fail('independent-verifier-freshness-required')
        }
        if (input.candidateSha && receipt.candidateSha !== input.candidateSha ||
            receipt.candidateSha !== dispatchReceipt.candidateSha) {
            fail('candidate-identity-mismatch')
        }
    }
    if (input.eventType === 'documentation.started') {
        const behavior = input.behaviorReceipt
        if (!hasV2Schema(behavior, 'behavior-receipt') ||
            behavior.verificationStatus !== 'verified') {
            fail('documentation-before-behavior-green')
        }
        if (input.uiImpact === true &&
            (!hasV2Schema(input.uxAcceptanceReceipt, 'ux-acceptance-receipt') ||
                input.uxAcceptanceReceipt?.verificationStatus !== 'verified')) {
            fail('documentation-before-ux-accepted')
        }
    }
    return true
}

export async function sealDispatchRequest(input) {
    if (input?.schema === 'issue-orchestration.dispatch-request.v1') {
        fail('dispatch-v1-historical-only')
    }
    if (input?.schema !== 'issue-orchestration.dispatch-request.v2') {
        fail('dispatch-request-v2-required')
    }
    return sealDispatchRequestV2(input)
}

export async function verifyRuntimeDispatch(input) {
    if (input?.request?.schema === 'issue-orchestration.dispatch-request.v1') {
        fail('dispatch-v1-historical-only')
    }
    if (input?.request?.schema !== 'issue-orchestration.dispatch-request.v2') {
        fail('dispatch-request-v2-required')
    }
    return verifyRuntimeDispatchV2(input)
}

export async function sealImplementerSelfTestReceipt(input) {
    if (input?.request?.schema === 'issue-orchestration.dispatch-request.v1') {
        fail('dispatch-v1-historical-only')
    }
    if (input?.request?.schema !== 'issue-orchestration.dispatch-request.v2') {
        fail('dispatch-request-v2-required')
    }
    return verifyImplementerSelfTestV2(input)
}

export async function authorizeReceiptTransition(input) {
    if (input?.transitionSchema !== 'issue-orchestration.transition.v2') {
        fail('transition-v2-required')
    }
    return authorizeReceiptTransitionV2(input)
}

export function auditHistoricalDispatchEvidence(input) {
    const artifacts = [
        {
            digestField: 'requestDigest',
            expectedSchema: 'issue-orchestration.dispatch-request.v1',
            field: 'request'
        },
        {
            digestField: 'receiptDigest',
            expectedSchema: 'issue-orchestration.dispatch-receipt.v1',
            field: 'dispatchReceipt'
        },
        {
            digestField: 'receiptDigest',
            expectedSchema:
                'issue-orchestration.implementer-self-test-receipt.v1',
            field: 'selfTestReceipt'
        }
    ]
    const present = artifacts.filter(({ field }) => input?.[field])
    if (present.length === 0) fail('historical-dispatch-evidence-required')
    const findings = []
    const summaries = {}
    for (const artifact of present) {
        const value = input[artifact.field]
        if (value.schema !== artifact.expectedSchema) {
            fail('historical-dispatch-v1-required')
        }
        const suppliedDigest = value[artifact.digestField]
        const digestIntact = typeof suppliedDigest === 'string' &&
            suppliedDigest === unsignedDigest(value, artifact.digestField)
        if (!digestIntact) {
            findings.push(`${artifact.field}-digest-invalid`)
        }
        summaries[artifact.field] = {
            schema: value.schema,
            suppliedDigest: suppliedDigest ?? null,
            digestIntact
        }
    }
    const { request, dispatchReceipt, selfTestReceipt } = input
    if (request && dispatchReceipt && (
        dispatchReceipt.requestId !== request.requestId ||
        dispatchReceipt.requestDigest !== request.requestDigest ||
        dispatchReceipt.attemptId !== request.attemptId ||
        dispatchReceipt.epochId !== request.epochId
    )) {
        findings.push('dispatch-receipt-request-binding-invalid')
    }
    if (request && selfTestReceipt && (
        selfTestReceipt.requestId !== request.requestId ||
        selfTestReceipt.requestDigest !== request.requestDigest ||
        selfTestReceipt.attemptId !== request.attemptId ||
        selfTestReceipt.epochId !== request.epochId
    )) {
        findings.push('self-test-receipt-request-binding-invalid')
    }
    return deepFreeze({
        schema: 'issue-orchestration.historical-dispatch-audit.v1',
        mode: 'read-only-historical-audit',
        mutationAuthority: 'none',
        canCreateDispatchRequest: false,
        canCreateReceipt: false,
        canAuthorizeTransition: false,
        integrityStatus: findings.length === 0 ? 'intact' : 'damaged',
        findings: unique(findings),
        artifacts: summaries
    })
}

async function runCli(argv) {
    if (argv[0] !== 'verify-runtime') fail('dispatch-cli-command')
    const options = {}
    for (let index = 1; index < argv.length; index += 2) {
        if (!argv[index]?.startsWith('--') || !argv[index + 1]) fail('dispatch-cli-arguments')
        options[argv[index].slice(2)] = argv[index + 1]
    }
    for (const field of ['request', 'rollout', 'machine-observations']) {
        if (!options[field]) fail('dispatch-cli-arguments')
    }
    const request = JSON.parse(fs.readFileSync(options.request, 'utf8'))
    const rolloutRecords = fs.readFileSync(options.rollout, 'utf8').split('\n')
        .filter(Boolean).map((line) => JSON.parse(line))
    const observations = JSON.parse(fs.readFileSync(options['machine-observations'], 'utf8'))
    const result = await verifyRuntimeDispatch({
        request: await sealDispatchRequest(request),
        rolloutRecords,
        machineObservations: observations.machineObservations ?? observations,
        priorReceipts: observations.priorReceipts ?? []
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.dispatchReceipt.verificationStatus !== 'verified') process.exitCode = 1
}

if (process.argv[1] && import.meta.url.split('?')[0] === pathToFileURL(process.argv[1]).href) {
    runCli(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`)
        process.exitCode = 1
    })
}
