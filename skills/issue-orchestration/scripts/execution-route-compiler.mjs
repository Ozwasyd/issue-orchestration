import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
    STAGE_MODEL_POOL_POLICY,
    STAGE_ROUTE_DEFINITIONS,
    splitProfile,
    validateRoutingClassification,
    verifyRuntimeProfileMetadata
} from './stage-profile-policy.mjs'
import {
    compileExecutableSlice
} from './executable-slice-compiler.mjs'

const HASH = /^[a-f0-9]{64}$/u
const POLICY_ROOT = path.resolve(import.meta.dirname, '../../../policy')

function readPolicy(name) {
    return JSON.parse(fs.readFileSync(path.join(POLICY_ROOT, name), 'utf8'))
}

const ROUTING_POLICY = readPolicy('execution-routing-policy.json')
const CAPABILITY_MATRIX = readPolicy('profile-capability-matrix.json')
const CAPABILITY_OBSERVATIONS =
    readPolicy('profile-capability-observations.json')

export const EXECUTION_ROUTING_POLICY_VERSION = ROUTING_POLICY.version
export const EXECUTION_ROUTING_AUTHORITY = ROUTING_POLICY.routingAuthority
export const EXECUTION_ROUTING_POLICY_DIGEST = digest({
    policy: ROUTING_POLICY,
    capabilityMatrixEvidenceDigest:
        CAPABILITY_MATRIX.evidenceDigest
})
export const EXECUTION_ROUTING_POLICY = Object.freeze(
    structuredClone(ROUTING_POLICY)
)
export const PROFILE_CAPABILITY_MATRIX = Object.freeze(
    structuredClone(CAPABILITY_MATRIX)
)

export class ExecutionRouteError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'ExecutionRouteError'
        this.code = code
    }
}

function fail(code, message = code) {
    throw new ExecutionRouteError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function sameValue(left, right) {
    return JSON.stringify(canonical(left)) ===
        JSON.stringify(canonical(right))
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function seal(value, digestField) {
    const sealed = structuredClone(value)
    sealed[digestField] = digest(sealed)
    return Object.freeze(sealed)
}

function assertDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

function toolPersistenceLevel(depth) {
    if (depth >= 16) return 5
    if (depth >= 12) return 4
    if (depth >= 8) return 3
    if (depth >= 4) return 2
    return 1
}

function capabilityFromObservation(observation) {
    return {
        planningDepth: observation.observedPlanningDepth,
        toolChainPersistence:
            toolPersistenceLevel(observation.successfulToolChainDepth),
        contextRetentionClass:
            observation.observedContextRetentionClass,
        checkpointReliability:
            observation.observedCheckpointReliability,
        runtimeProbeCapability:
            observation.observedRuntimeProbeCapability,
        crossModuleReasoningClass:
            observation.observedCrossModuleReasoningClass,
        supportedSandboxes: [...observation.supportedSandboxes],
        allowedContinuationModes:
            [...observation.supportedContinuationModes],
        evidenceDigest: digest(observation)
    }
}

export function verifyProfileCapabilityMatrix({
    matrix = CAPABILITY_MATRIX,
    observations = CAPABILITY_OBSERVATIONS
} = {}) {
    if (matrix?.schema !==
            'issue-orchestration.profile-capability-matrix.v2' ||
        matrix.policyVersion !== ROUTING_POLICY.version ||
        matrix.modelPoolPolicyVersion !==
            STAGE_MODEL_POOL_POLICY.version ||
        matrix.evidenceAuthority !==
            'recomputed-codex-v2-runtime-observations' ||
        matrix.modelSelfReportAccepted !== false ||
        observations?.schema !==
            'issue-orchestration.profile-capability-observations.v2' ||
        observations.authority !==
            'codex-v2-runtime-metadata-observer' ||
        matrix.evidenceDigest !== digest(observations)) {
        fail('execution-route-capability-matrix-invalid')
    }
    const requiredObservationFields = [
        'firstArtifactLatency',
        'firstWriteLatency',
        'readOnlyOperationsBeforeArtifact',
        'successfulToolChainDepth',
        'checkpointProduced',
        'continuationRecovered',
        'visibleCommandLoopCount',
        'sliceCompletionStatus',
        'outputMissingClass',
        'runtimeInvocationFailure',
        'requestedModel',
        'effectiveModel',
        'requestedEffort',
        'effectiveEffort',
        'multiAgentBackend',
        'runtimeMetadataObserved'
    ]
    const observationProfiles = new Set()
    for (const observation of observations.observations ?? []) {
        if (observation.source !== 'machine-runtime-observation' ||
            requiredObservationFields.some((field) =>
                !Object.hasOwn(observation, field)) ||
            observationProfiles.has(observation.profileId)) {
            fail('execution-route-capability-evidence-invalid')
        }
        observationProfiles.add(observation.profileId)
        try {
            verifyRuntimeProfileMetadata({
                selectedProfile: observation.profileId,
                requestedModel: observation.requestedModel,
                effectiveModel: observation.effectiveModel,
                requestedEffort: observation.requestedEffort,
                effectiveEffort: observation.effectiveEffort,
                multiAgentBackend: observation.multiAgentBackend
            })
        } catch {
            fail('execution-route-capability-runtime-metadata-invalid')
        }
        if (observation.runtimeMetadataObserved !== true) {
            fail('execution-route-capability-runtime-metadata-invalid')
        }
        if (!sameValue(
            matrix.profiles?.[observation.profileId],
            capabilityFromObservation(observation)
        )) {
            fail('execution-route-capability-matrix-not-recomputable')
        }
    }
    const modelProfiles =
        Object.keys(STAGE_MODEL_POOL_POLICY.profiles).sort()
    if (!sameValue(
        [...observationProfiles].sort(),
        modelProfiles
    ) || !sameValue(
        Object.keys(matrix.profiles ?? {}).sort(),
        modelProfiles
    )) {
        fail('execution-route-capability-profile-coverage')
    }
    return matrix
}

verifyProfileCapabilityMatrix()

function assertNoForbiddenInputs(input) {
    for (const field of ROUTING_POLICY.forbiddenInputs) {
        if (Object.hasOwn(input ?? {}, field)) {
            fail(
                field === 'requestedProfile' ||
                    field === 'selectedProfile' ||
                    field === 'profileOverride'
                    ? 'execution-route-root-profile-selection-forbidden'
                    : 'execution-route-forbidden-input'
            )
        }
    }
}

function verifiedSlice(input) {
    const plan = input?.stageWorkPlan
    const slice = input?.executableSlice
    if (plan?.schema !== 'issue-orchestration.stage-work-plan.v1' ||
        slice?.schema !== 'issue-orchestration.executable-slice.v1' ||
        !HASH.test(slice.sliceDigest ?? '') ||
        !HASH.test(plan.planDigest ?? '')) {
        fail('execution-route-verified-slice-required')
    }
    let expected
    try {
        expected = compileExecutableSlice({
            plan,
            sliceId: slice.sliceId
        })
    } catch {
        fail('execution-route-verified-slice-required')
    }
    if (!sameValue(expected, slice) ||
        slice.planDigest !== plan.planDigest ||
        slice.stageRole !== plan.stageRole ||
        slice.stagePhase !== plan.stagePhase) {
        fail('execution-route-verified-slice-required')
    }
    return slice
}

const INTEGER_METRICS = Object.freeze([
    'expectedChangedFileCount',
    'ownedModuleCount',
    'commandLoopCount',
    'runtimeProbeDepth',
    'toolInteractionDepth'
])

function validatedMetrics(input, slice) {
    const metrics = input?.executionMetrics
    if (!metrics || typeof metrics !== 'object' ||
        INTEGER_METRICS.some((field) =>
            !Number.isInteger(metrics[field]) || metrics[field] < 0) ||
        !ROUTING_POLICY.contextBreadthOrder.includes(metrics.contextBreadth) ||
        typeof metrics.statefulContinuationRequired !== 'boolean' ||
        !['simple', 'resumable', 'durable']
            .includes(metrics.checkpointSupportRequired) ||
        typeof metrics.firstActionDeterministic !== 'boolean' ||
        typeof metrics.wholeIssueScope !== 'boolean') {
        fail('execution-route-shape-metrics-invalid')
    }
    if (metrics.wholeIssueScope === true) {
        fail('execution-route-whole-issue-forbidden')
    }
    if (!metrics.firstActionDeterministic ||
        typeof slice.firstRequiredAction !== 'string' ||
        !slice.firstRequiredAction ||
        (!slice.firstWritablePath && !slice.explicitReadOnlyOutput)) {
        fail('execution-route-first-action-not-deterministic')
    }
    if (metrics.expectedChangedFileCount > slice.maxChangedFiles ||
        metrics.ownedModuleCount > slice.maxOwnedModules) {
        fail('execution-route-shape-exceeds-slice')
    }
    return metrics
}

function shapeCandidates(metrics, slice, stageDefinition) {
    const shapes = []
    if (stageDefinition.writeScope === 'none' ||
        slice.explicitReadOnlyOutput) {
        shapes.push('read-only-adjudication')
    }
    const longHorizon =
        metrics.toolInteractionDepth >= 16 ||
        (metrics.contextBreadth === 'very-broad' &&
            metrics.statefulContinuationRequired &&
            metrics.toolInteractionDepth >= 12)
    if (longHorizon) shapes.push('long-horizon-cross-module')
    if (metrics.toolInteractionDepth >= 10) {
        shapes.push('high-tool-depth')
    }
    if (metrics.contextBreadth === 'broad' ||
        metrics.contextBreadth === 'very-broad') {
        shapes.push('context-heavy')
    }
    if (metrics.runtimeProbeDepth >= 4) {
        shapes.push('runtime-probe-heavy')
    }
    if (metrics.commandLoopCount >= 3) {
        shapes.push('iterative-debug')
    }
    if (metrics.expectedChangedFileCount > 1 ||
        metrics.ownedModuleCount > 1) {
        shapes.push('bounded-multifile')
    }
    shapes.push('atomic-edit')
    return [...new Set(shapes)]
}

function validateUnsplittable(input, metrics, dominantShape) {
    if (dominantShape !== 'long-horizon-cross-module') return null
    const evidence = input.machinePartitionEvidence
    if (typeof metrics.unsplittableReason !== 'string' ||
        !metrics.unsplittableReason.trim() ||
        evidence?.schema !==
            'issue-orchestration.slice-partition-evidence.v1' ||
        evidence.source !== 'machine-slice-partition-analyzer' ||
        evidence.safePartitionCount !== 1 ||
        evidence.dependencyCutCount !== 0 ||
        !HASH.test(evidence.evidenceDigest ?? '')) {
        fail('execution-route-unsplittable-evidence-required')
    }
    return evidence.evidenceDigest
}

function compileShape(input, slice, classification, stageDefinition) {
    const metrics = validatedMetrics(input, slice)
    const evidence = input.machineClassificationEvidence
    if (evidence?.schema !==
            'issue-orchestration.execution-shape-observation.v1' ||
        evidence.source !== 'machine-slice-and-runtime-observer' ||
        typeof evidence.observedAt !== 'string' ||
        !evidence.observedAt ||
        !HASH.test(evidence.evidenceDigest ?? '')) {
        fail('execution-route-classification-evidence-required')
    }
    const shapes = shapeCandidates(metrics, slice, stageDefinition)
    const dominantWorkShape = shapes[0]
    const partitionEvidenceDigest =
        validateUnsplittable(input, metrics, dominantWorkShape)
    const evidenceDigest = digest({
        evidence,
        metrics,
        partitionEvidenceDigest,
        sliceDigest: slice.sliceDigest,
        planDigest: slice.planDigest
    })
    return seal({
        schema:
            'issue-orchestration.execution-shape-classification.v1',
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        domain: classification.domain,
        engineeringRiskClass: classification.engineeringRiskClass,
        uiDecisionClass: classification.uiDecisionClass,
        verificationClass: classification.verificationClass,
        dominantWorkShape,
        secondaryShapes: shapes.slice(1),
        expectedChangedFileCount: metrics.expectedChangedFileCount,
        ownedModuleCount: metrics.ownedModuleCount,
        commandLoopCount: metrics.commandLoopCount,
        runtimeProbeDepth: metrics.runtimeProbeDepth,
        toolInteractionDepth: metrics.toolInteractionDepth,
        contextBreadth: metrics.contextBreadth,
        statefulContinuationRequired:
            metrics.statefulContinuationRequired,
        checkpointSupportRequired:
            metrics.checkpointSupportRequired,
        firstActionDeterministic: metrics.firstActionDeterministic,
        unsplittableReason:
            dominantWorkShape === 'long-horizon-cross-module'
                ? metrics.unsplittableReason
                : null,
        classificationEvidenceDigest: evidenceDigest
    }, 'classificationDigest')
}

function compileCapabilityRequirement(shape, stageDefinition) {
    const levels =
        ROUTING_POLICY.shapeRequirements[shape.dominantWorkShape]
    if (!Array.isArray(levels) || levels.length !== 6) {
        fail('execution-route-shape-policy-invalid')
    }
    const continuationMode =
        shape.checkpointSupportRequired === 'durable'
            ? 'durable-continuation'
            : shape.statefulContinuationRequired ||
                shape.checkpointSupportRequired === 'resumable'
                ? 'checkpoint-resume'
                : 'none'
    return seal({
        schema:
            'issue-orchestration.stage-capability-requirement.v1',
        sliceId: shape.sliceId,
        sliceDigest: shape.sliceDigest,
        classificationDigest: shape.classificationDigest,
        minimumPlanningDepth: levels[0],
        minimumToolChainPersistence: levels[1],
        minimumContextRetentionClass: levels[2],
        minimumCheckpointReliability: levels[3],
        runtimeProbeCapability: levels[4],
        crossModuleReasoningClass: levels[5],
        requiredFreshContext: stageDefinition.freshContext,
        requiredSandbox: stageDefinition.sandbox,
        allowedContinuationMode: continuationMode
    }, 'capabilityDigest')
}

function profileSatisfies(profile, requirement) {
    return profile.planningDepth >= requirement.minimumPlanningDepth &&
        profile.toolChainPersistence >=
            requirement.minimumToolChainPersistence &&
        profile.contextRetentionClass >=
            requirement.minimumContextRetentionClass &&
        profile.checkpointReliability >=
            requirement.minimumCheckpointReliability &&
        profile.runtimeProbeCapability >=
            requirement.runtimeProbeCapability &&
        profile.crossModuleReasoningClass >=
            requirement.crossModuleReasoningClass &&
        profile.supportedSandboxes.includes(requirement.requiredSandbox) &&
        profile.allowedContinuationModes.includes(
            requirement.allowedContinuationMode
        )
}

function selectProfile({
    input,
    shape,
    requirement,
    stageDefinition,
    classification
}) {
    const isUiWriter = shape.stageRole === 'ui-ux-implementer'
    if (isUiWriter && [
        'context-heavy',
        'high-tool-depth',
        'long-horizon-cross-module'
    ].includes(shape.dominantWorkShape)) {
        fail('execution-route-ui-reslice-or-adjudicate')
    }
    const stageAllowed = stageDefinition.allowedProfiles
    const capable = stageAllowed.filter((profileId) =>
        profileSatisfies(
            CAPABILITY_MATRIX.profiles[profileId],
            requirement
        ))
    if (isUiWriter) {
        const selected = ['prescribed', 'bounded-composition']
            .includes(classification.uiDecisionClass)
            ? 'sol-low'
            : ['layout-judgment', 'interaction-judgment']
                .includes(classification.uiDecisionClass)
                ? 'sol-medium'
                : null
        if (!selected) fail('execution-route-ui-reslice-or-adjudicate')
        if (!capable.includes(selected) ||
            !ROUTING_POLICY.uiImplementationProfiles.includes(selected)) {
            fail('execution-route-ui-reslice-or-adjudicate')
        }
        return {
            allowedProfiles: capable.filter((profileId) =>
                ROUTING_POLICY.uiImplementationProfiles
                    .includes(profileId)),
            selectedProfile: selected,
            selectedProfileReason:
                `ui-${classification.uiDecisionClass}-capability-fit`
        }
    }
    if (input.frontierException === true) {
        if (classification.engineeringRiskClass !== 'frontier' ||
            shape.dominantWorkShape !==
                'long-horizon-cross-module' ||
            input.machineFrontierEvidence?.source !==
                'machine-frontier-exception-verifier' ||
            !HASH.test(
                input.machineFrontierEvidence?.evidenceDigest ?? ''
            ) ||
            !capable.includes('sol-max')) {
            fail('execution-route-frontier-exception-invalid')
        }
        return {
            allowedProfiles: capable,
            selectedProfile: 'sol-max',
            selectedProfileReason:
                'frontier-exception-only-capability-fit'
        }
    }
    const priority =
        ROUTING_POLICY.selectionPriority[shape.dominantWorkShape]
    const selectedProfile = priority.find((profileId) =>
        capable.includes(profileId) && profileId !== 'sol-max')
    if (!selectedProfile) fail('execution-route-no-capable-profile')
    return {
        allowedProfiles: capable.filter((profileId) =>
            profileId !== 'sol-max'),
        selectedProfile,
        selectedProfileReason:
            `${shape.dominantWorkShape}-minimum-capability-fit`
    }
}

function validateRuntimeObservation(observation, selectedProfile) {
    if (observation === undefined) return 'pending-observation'
    if (observation?.schema !==
            'issue-orchestration.runtime-capability-observation.v1' ||
        observation.source !== 'runtime-capability-registry' ||
        observation.observable !== true ||
        !HASH.test(observation.observationDigest ?? '')) {
        fail('execution-route-runtime-unobservable')
    }
    try {
        verifyRuntimeProfileMetadata({
            selectedProfile,
            requestedModel: observation.requestedModel,
            effectiveModel: observation.effectiveModel,
            requestedEffort: observation.requestedEffort,
            effectiveEffort: observation.effectiveEffort,
            multiAgentBackend: observation.multiAgentBackend
        })
    } catch {
        fail('execution-route-runtime-profile-mismatch')
    }
    return 'verified'
}

function compileDecision({
    input,
    shape,
    requirement,
    stageDefinition,
    classification
}) {
    const selected = selectProfile({
        input,
        shape,
        requirement,
        stageDefinition,
        classification
    })
    const runtimeVerificationStatus = validateRuntimeObservation(
        input.runtimeCapabilityObservation,
        selected.selectedProfile
    )
    const runtime = splitProfile(selected.selectedProfile)
    return seal({
        schema: 'issue-orchestration.execution-route-decision.v1',
        policyVersion: ROUTING_POLICY.version,
        modelPoolPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
        routingAuthority: ROUTING_POLICY.routingAuthority,
        sliceId: shape.sliceId,
        sliceDigest: shape.sliceDigest,
        stageRole: shape.stageRole,
        stagePhase: shape.stagePhase,
        classificationDigest: shape.classificationDigest,
        capabilityDigest: requirement.capabilityDigest,
        matrixEvidenceDigest: CAPABILITY_MATRIX.evidenceDigest,
        allowedProfiles: selected.allowedProfiles,
        selectedProfile: selected.selectedProfile,
        selectedProfileReason: selected.selectedProfileReason,
        requestedModel: runtime.model,
        requestedEffort: runtime.effort,
        multiAgentBackend:
            STAGE_MODEL_POOL_POLICY.profiles[
                selected.selectedProfile
            ].multiAgentBackend,
        requiredSandbox: requirement.requiredSandbox,
        runtimeVerificationStatus,
        previousRouteDecisionDigest: null,
        previousFailureReceiptDigest: null,
        retryAuthorizationDigest: null,
        previousCandidateReceiptDigest: null
    }, 'routeDecisionDigest')
}

export function compileExecutionRoute(input = {}) {
    assertNoForbiddenInputs(input)
    const slice = verifiedSlice(input)
    let classification
    try {
        classification = validateRoutingClassification(
            input.routingClassification
        )
    } catch {
        fail('execution-route-routing-classification-invalid')
    }
    if (slice.stageRole !== input.stageWorkPlan.stageRole ||
        slice.stagePhase !== input.stageWorkPlan.stagePhase) {
        fail('execution-route-stage-binding')
    }
    const stageKey = `${slice.stageRole}:${slice.stagePhase}`
    const stageDefinition = STAGE_ROUTE_DEFINITIONS[stageKey]
    if (!stageDefinition) fail('execution-route-stage-binding')
    const executionShapeClassification = compileShape(
        input,
        slice,
        classification,
        stageDefinition
    )
    const stageCapabilityRequirement = compileCapabilityRequirement(
        executionShapeClassification,
        stageDefinition
    )
    const executionRouteDecision = compileDecision({
        input,
        shape: executionShapeClassification,
        requirement: stageCapabilityRequirement,
        stageDefinition,
        classification
    })
    return Object.freeze({
        schema: 'issue-orchestration.execution-route-bundle.v1',
        executionShapeClassification,
        stageCapabilityRequirement,
        executionRouteDecision
    })
}

export function compileExecutionReroute({
    previousDecision,
    revisedRouteInput,
    failureReceipt,
    retryAuthorization,
    previousCandidateReceiptDigest,
    nextCandidateReceiptDigest
} = {}) {
    if (failureReceipt?.failureClass !==
        ROUTING_POLICY.rerouteFailureClass) {
        fail('execution-reroute-profile-mismatch-required')
    }
    if (failureReceipt.schema !==
            'issue-orchestration.writer-stage-failure-receipt.v1' ||
        !HASH.test(failureReceipt.receiptDigest ?? '') ||
        failureReceipt.previousRouteDecisionDigest !==
            previousDecision?.routeDecisionDigest) {
        fail('execution-reroute-prior-failure-required')
    }
    if (retryAuthorization?.schema !==
            'issue-orchestration.writer-stage-retry-authorization.v1' ||
        retryAuthorization.failureReceiptDigest !==
            failureReceipt.receiptDigest ||
        !HASH.test(
            retryAuthorization.breakerResetReceiptDigest ?? ''
        ) ||
        !HASH.test(retryAuthorization.authorizationDigest ?? '')) {
        fail('execution-reroute-retry-authorization-required')
    }
    if (!HASH.test(previousCandidateReceiptDigest ?? '') ||
        !HASH.test(nextCandidateReceiptDigest ?? '') ||
        previousCandidateReceiptDigest !==
            failureReceipt.candidateReceiptDigest ||
        previousCandidateReceiptDigest === nextCandidateReceiptDigest) {
        fail('execution-reroute-candidate-reuse')
    }
    if (revisedRouteInput?.runtimeCapabilityObservation === undefined) {
        fail('execution-route-runtime-unobservable')
    }
    const bundle = compileExecutionRoute(revisedRouteInput)
    const initial = bundle.executionRouteDecision
    if (initial.selectedProfile === previousDecision.selectedProfile) {
        fail('execution-reroute-profile-unchanged')
    }
    const nextDecision = { ...initial }
    delete nextDecision.routeDecisionDigest
    nextDecision.previousRouteDecisionDigest =
        previousDecision.routeDecisionDigest
    nextDecision.previousFailureReceiptDigest =
        failureReceipt.receiptDigest
    nextDecision.retryAuthorizationDigest =
        retryAuthorization.authorizationDigest
    nextDecision.previousCandidateReceiptDigest =
        previousCandidateReceiptDigest
    return Object.freeze({
        ...bundle,
        executionRouteDecision: seal(
            nextDecision,
            'routeDecisionDigest'
        )
    })
}
