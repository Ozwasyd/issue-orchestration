import fs from 'node:fs'
import path from 'node:path'

import {
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'
import {
    validateStageMutationPostconditionReceipt
} from './stage-runtime-guard.mjs'

const POLICY_ROOT = path.resolve(import.meta.dirname, '../../../policy')
const POLICY_PATH = path.join(
    POLICY_ROOT,
    'control-plane-advisor-policy.json'
)

export const CONTROL_PLANE_ADVISOR_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const CONTROL_PLANE_ADVISOR_POLICY_DIGEST =
    digest(CONTROL_PLANE_ADVISOR_POLICY)
const REVIEWED_ASSUMPTIONS = JSON.parse(fs.readFileSync(
    path.join(POLICY_ROOT, 'reviewed-routing-assumptions.json'),
    'utf8'
))

const BOUNDED_PROJECTION_FIELDS = new Set([
    'actorDigests',
    'slotDigests',
    'leaseDigests',
    'resourceDigests',
    'checkpointDigests',
    'continuationDigests',
    'routeDigests',
    'breakerDigests',
    'receiptDigests',
    'baseSha',
    'epochId',
    'candidateDigest',
    'remoteSnapshotDigest'
])

function containsSensitive(value) {
    if (Array.isArray(value)) return value.some(containsSensitive)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) =>
        /(?:credential|secret|token|password|api[-_]?key)/iu
            .test(key) ||
        containsSensitive(child)
    )
}

function validateDigestArray(value, code) {
    if (!Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((item) => !/^[a-f0-9]{64}$/u.test(item))) {
        fail(code)
    }
    return value
}

export function compileUnresolvedControlPlaneReceipt({
    runId,
    failureDomain,
    failureDigest,
    failureEventDigest,
    classifierEvidenceDigest,
    unresolvedReasonCode,
    deterministicHandlersExhausted,
    boundedScopeDigest
} = {}) {
    assertText(runId, 'advisor-unresolved-receipt-incomplete')
    assertText(
        unresolvedReasonCode,
        'advisor-unresolved-receipt-incomplete'
    )
    for (const value of [
        failureDigest,
        failureEventDigest,
        classifierEvidenceDigest,
        boundedScopeDigest
    ]) assertDigest(value, 'advisor-unresolved-receipt-incomplete')
    if (failureDomain !==
            CONTROL_PLANE_ADVISOR_POLICY.allowedFailureDomain ||
        deterministicHandlersExhausted !== true) {
        fail('advisor-deterministic-handler-not-exhausted')
    }
    return seal({
        schema:
            'issue-orchestration.unresolved-control-plane-receipt.v1',
        producerAuthority: 'machine-failure-classifier',
        status: 'unresolved',
        runId,
        failureDomain,
        failureDigest,
        failureEventDigest,
        classifierEvidenceDigest,
        unresolvedReasonCode,
        deterministicHandlersExhausted: true,
        boundedScopeDigest
    }, 'receiptDigest')
}

function validateUnresolved(value) {
    if (value?.schema !==
            'issue-orchestration.unresolved-control-plane-receipt.v1' ||
        value.producerAuthority !== 'machine-failure-classifier' ||
        value.status !== 'unresolved' ||
        value.receiptDigest !==
            unsignedDigest(value, 'receiptDigest')) {
        fail('advisor-unresolved-receipt-invalid')
    }
    return value
}

function selectProfile({
    capabilityEvidence,
    runtimeAvailability
}) {
    if (capabilityEvidence?.schema !==
            'issue-orchestration.advisor-route-cell-evidence.v1' ||
        capabilityEvidence.producerAuthority !==
            'canonical-route-cell-compiler' ||
        capabilityEvidence.capabilityClass !==
            CONTROL_PLANE_ADVISOR_POLICY.capabilityClass ||
        capabilityEvidence.routeCellId !==
            CONTROL_PLANE_ADVISOR_POLICY.routeCellId ||
        capabilityEvidence.requiredProfile !==
            CONTROL_PLANE_ADVISOR_POLICY.requiredProfile ||
        capabilityEvidence.reviewedAssumptionDigest !==
            CONTROL_PLANE_ADVISOR_POLICY
                .reviewedAssumptionDigest ||
        capabilityEvidence.evidenceDigest !==
            unsignedDigest(capabilityEvidence, 'evidenceDigest') ||
        runtimeAvailability?.schema !==
            'issue-orchestration.advisor-runtime-availability.v1' ||
        runtimeAvailability.producerAuthority !==
            'runtime-capability-registry' ||
        runtimeAvailability.observationDigest !==
            unsignedDigest(
                runtimeAvailability,
                'observationDigest'
            )) {
        fail('advisor-capability-evidence-invalid')
    }
    const profileId =
        CONTROL_PLANE_ADVISOR_POLICY.requiredProfile
    const assumption = REVIEWED_ASSUMPTIONS.profiles?.[profileId]
    if (assumption?.assumptionDigest !==
            CONTROL_PLANE_ADVISOR_POLICY.reviewedAssumptionDigest ||
        assumption.policyStatus !== 'frontier-service-only' ||
        runtimeAvailability.profiles?.[profileId]?.available !==
            true) {
        fail('advisor-qualified-profile-unavailable')
    }
    return {
        selectedProfile: profileId,
        routeCellEvidenceDigest:
            capabilityEvidence.evidenceDigest,
        runtimeAvailabilityObservationDigest:
            runtimeAvailability.observationDigest
    }
}

function validateBoundedProjection(value) {
    if (!value || typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((field) =>
            !BOUNDED_PROJECTION_FIELDS.has(field)) ||
        containsSensitive(value)) {
        fail('advisor-request-unbounded')
    }
    for (const [field, child] of Object.entries(value)) {
        if (field.endsWith('Digests')) {
            validateDigestArray(child, 'advisor-request-unbounded')
        }
    }
    return structuredClone(value)
}

export function compileControlPlaneAdvisorRequest(input = {}) {
    const unresolved = validateUnresolved(
        input.unresolvedControlPlaneReceipt
    )
    const startupBinding =
        requireRuntimeStartupBinding({ startup: input.startup })
    if (startupBinding.rootPhase !== 'scheduling' ||
        startupBinding.rootProfile !== 'terra-low' ||
        unresolved.runId !== input.runId ||
        unresolved.failureDigest !== input.failureDigest ||
        input.consultedFailureDigests?.includes(
            input.failureDigest
        )) {
        fail('advisor-eligibility-invalid')
    }
    if (!Array.isArray(input.affectedTargets) ||
        input.affectedTargets.length < 1 ||
        input.affectedTargets.length >
            CONTROL_PLANE_ADVISOR_POLICY.maxAffectedTargets ||
        new Set(input.affectedTargets.map(({ identity }) =>
            identity)).size !== input.affectedTargets.length ||
        input.affectedTargets.some((target) =>
            typeof target.identity !== 'string' ||
            !target.identity ||
            !/^[a-f0-9]{64}$/u.test(
                target.currentDigest ?? ''
            ))) {
        fail('advisor-scope-unbounded')
    }
    if (input.slotReservation?.schema !==
            'issue-orchestration.advisor-slot-reservation.v1' ||
        input.slotReservation.producerAuthority !==
            'machine-capacity-controller' ||
        input.slotReservation.status !== 'reserved' ||
        input.slotReservation.failureDigest !==
            input.failureDigest ||
        input.slotReservation.receiptDigest !==
            unsignedDigest(
                input.slotReservation,
                'receiptDigest'
            )) {
        fail('advisor-slot-unavailable')
    }
    const selection = selectProfile(input)
    const questions = input.diagnosticQuestions
    if (!Array.isArray(questions) ||
        questions.length < 1 ||
        questions.length >
            CONTROL_PLANE_ADVISOR_POLICY.maxDiagnosticQuestions ||
        questions.some((question) =>
            typeof question !== 'string' || !question)) {
        fail('advisor-questions-unbounded')
    }
    const boundedProjection = validateBoundedProjection(
        input.boundedProjection
    )
    const presumed = validateDigestArray(
        input.presumedValidEvidenceDigests,
        'advisor-evidence-projection-invalid'
    )
    const suspected = validateDigestArray(
        input.suspectedInvalidEvidenceDigests,
        'advisor-evidence-projection-invalid'
    )
    if (presumed.some((value) => suspected.includes(value)) ||
        containsSensitive(input) ||
        input.fullHistoryIncluded !== false ||
        input.unrelatedHistoryIncluded !== false ||
        input.writableStateRootPathIncluded !== false ||
        input.rootPreferredConclusionIncluded !== false) {
        fail('advisor-request-unbounded')
    }
    return seal({
        schema:
            'issue-orchestration.control-plane-advisor-request.v1',
        producerAuthority:
            'machine-control-plane-advisor-gate',
        policyDigest: CONTROL_PLANE_ADVISOR_POLICY_DIGEST,
        status: 'authorized',
        runId: input.runId,
        rootInvocationId:
            startupBinding.runtimeInvocationId,
        rootSessionId: startupBinding.runtimeSessionId,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        packageDigest: input.startup.observation.packageDigest,
        policySetDigest: digest(
            input.startup.observation.policyDigests
        ),
        failureDigest: input.failureDigest,
        unresolvedControlPlaneReceiptDigest:
            unresolved.receiptDigest,
        affectedTargets:
            structuredClone(input.affectedTargets),
        boundedProjection,
        presumedValidEvidenceDigests: [...presumed],
        suspectedInvalidEvidenceDigests: [...suspected],
        selectedProfile: selection.selectedProfile,
        capabilityClass:
            CONTROL_PLANE_ADVISOR_POLICY.capabilityClass,
        routeCellEvidenceDigest:
            selection.routeCellEvidenceDigest,
        runtimeAvailabilityObservationDigest:
            selection.runtimeAvailabilityObservationDigest,
        slotReservationDigest:
            input.slotReservation.receiptDigest,
        allowedRecommendationKinds: [
            ...CONTROL_PLANE_ADVISOR_POLICY
                .allowedRecommendationKinds
        ],
        forbiddenActions: [
            ...CONTROL_PLANE_ADVISOR_POLICY.forbiddenActions
        ],
        diagnosticQuestions: [...questions],
        freshContext: true,
        executionClass: 'observe-only',
        fullHistoryIncluded: false,
        unrelatedHistoryIncluded: false,
        writableStateRootPathIncluded: false,
        rootPreferredConclusionIncluded: false
    }, 'requestDigest')
}

export function compileAdvisorRuntimeBinding({
    request,
    runtimeObservation
} = {}) {
    if (request?.schema !==
            'issue-orchestration.control-plane-advisor-request.v1' ||
        request.requestDigest !==
            unsignedDigest(request, 'requestDigest') ||
        runtimeObservation?.schema !==
            'issue-orchestration.control-plane-advisor-runtime-observation.v1' ||
        runtimeObservation.producerAuthority !== 'runtime-owned' ||
        runtimeObservation.requestDigest !== request.requestDigest ||
        runtimeObservation.rootInvocationId !==
            request.rootInvocationId ||
        runtimeObservation.selectedProfile !==
            request.selectedProfile ||
        runtimeObservation.effectiveProfile !==
            request.selectedProfile ||
        runtimeObservation.effectiveMultiAgentBackend !== 'v2' ||
        runtimeObservation.executionClass !== 'observe-only' ||
        runtimeObservation.freshContext !== true ||
        runtimeObservation.forkTurns === 'all' ||
        runtimeObservation.effectivePermissionProfile === undefined ||
        runtimeObservation.permissionInheritance === undefined ||
        runtimeObservation.permissionGuarantee === undefined ||
        runtimeObservation.observationDigest !==
            unsignedDigest(
                runtimeObservation,
                'observationDigest'
            )) {
        fail('advisor-runtime-binding-invalid')
    }
    return seal({
        schema:
            'issue-orchestration.control-plane-advisor-runtime-binding.v1',
        status: 'verified',
        requestDigest: request.requestDigest,
        failureDigest: request.failureDigest,
        rootInvocationId: request.rootInvocationId,
        advisorInvocationId:
            runtimeObservation.advisorInvocationId,
        advisorSessionId: runtimeObservation.advisorSessionId,
        selectedProfile: request.selectedProfile,
        effectiveProfile:
            runtimeObservation.effectiveProfile,
        effectiveModel: runtimeObservation.effectiveModel,
        effectiveEffort: runtimeObservation.effectiveEffort,
        effectiveMultiAgentBackend: 'v2',
        executionClass: 'observe-only',
        freshContext: true,
        effectivePermissionProfile:
            runtimeObservation.effectivePermissionProfile,
        permissionInheritance:
            runtimeObservation.permissionInheritance,
        permissionGuarantee:
            runtimeObservation.permissionGuarantee,
        runtimeObservationDigest:
            runtimeObservation.observationDigest
    }, 'bindingDigest')
}

function validateAction(action, request) {
    const operation =
        CONTROL_PLANE_ADVISOR_POLICY.actionVocabulary[
            action?.kind
        ]
    const target = request.affectedTargets.find(
        ({ identity }) => identity === action?.targetIdentity
    )
    if (!operation || !target ||
        action.currentDigest !== target.currentDigest ||
        !Array.isArray(action.preconditions) ||
        !Array.isArray(action.postconditions) ||
        action.preconditions.length === 0 ||
        action.postconditions.length === 0 ||
        !Array.isArray(action.requiredRevalidationGates) ||
        action.requiredRevalidationGates.length === 0 ||
        action.requiredRevalidationGates.some((gate) =>
            !CONTROL_PLANE_ADVISOR_POLICY
                .mandatoryRevalidationGates.includes(gate)) ||
        !action.failureDisposition) {
        fail('advisor-proposal-action-invalid')
    }
    validateDigestArray(
        action.preconditions,
        'advisor-proposal-action-invalid'
    )
    validateDigestArray(
        action.postconditions,
        'advisor-proposal-action-invalid'
    )
    return operation
}

export function sealControlPlaneRecoveryProposal({
    request,
    advisorRuntimeBinding,
    mutationPostconditionReceipt,
    payload
} = {}) {
    if (advisorRuntimeBinding?.requestDigest !==
            request?.requestDigest ||
        advisorRuntimeBinding.executionClass !== 'observe-only') {
        fail('advisor-proposal-runtime-binding-invalid')
    }
    validateStageMutationPostconditionReceipt(
        mutationPostconditionReceipt,
        {
            runtimeExecutionBindingDigest:
                advisorRuntimeBinding.bindingDigest,
            resultDigest: digest(payload)
        }
    )
    if (mutationPostconditionReceipt.executionClass !==
            'observe-only' ||
        mutationPostconditionReceipt.outputClass !== 'proposal' ||
        payload?.requestDigest !== request.requestDigest ||
        payload.failureDigest !== request.failureDigest ||
        payload.rootInvocationId !== request.rootInvocationId ||
        payload.startupAttestationDigest !==
            request.startupAttestationDigest ||
        payload.policySetDigest !== request.policySetDigest ||
        !CONTROL_PLANE_ADVISOR_POLICY.allowedRecommendationKinds
            .includes(payload.recommendationKind) ||
        !Array.isArray(payload.actions) ||
        payload.actions.length < 1 ||
        payload.actions.length >
            CONTROL_PLANE_ADVISOR_POLICY.maxActions) {
        fail('advisor-proposal-binding-invalid')
    }
    const preserve = validateDigestArray(
        payload.preserveEvidenceDigests,
        'advisor-proposal-evidence-invalid'
    )
    const invalidated = payload.invalidateEvidence ?? []
    if (invalidated.some((entry) =>
        !request.suspectedInvalidEvidenceDigests
            .includes(entry.digest) ||
        !entry.reasonCode) ||
        invalidated.some(({ digest: value }) =>
            preserve.includes(value)) ||
        preserve.some((value) =>
            !request.presumedValidEvidenceDigests.includes(value))) {
        fail('advisor-proposal-evidence-invalid')
    }
    for (const action of payload.actions) {
        validateAction(action, request)
    }
    if (!sameValue(
        [...payload.requiredRevalidationGates].sort(),
        [...new Set(payload.actions.flatMap((action) =>
            action.requiredRevalidationGates))].sort()
    ) ||
        payload.actions.some(({ kind }) =>
            CONTROL_PLANE_ADVISOR_POLICY.forbiddenActions
                .includes(kind))) {
        fail('advisor-proposal-gate-bypass')
    }
    const proposalPayloadDigest = digest(payload)
    return seal({
        schema:
            'issue-orchestration.control-plane-recovery-proposal.v1',
        producerAuthority: 'control-plane-advisor',
        status: 'proposal-only',
        ...structuredClone(payload),
        advisorProfile: advisorRuntimeBinding.selectedProfile,
        advisorRuntimeBindingDigest:
            advisorRuntimeBinding.bindingDigest,
        mutationPostconditionReceiptDigest:
            mutationPostconditionReceipt.receiptDigest,
        proposalPayloadDigest
    }, 'proposalDigest')
}

export function compileControlPlaneRecoveryPlan({
    request,
    proposal,
    consultedFailureDigests = []
} = {}) {
    if (request?.requestDigest !==
            unsignedDigest(request ?? {}, 'requestDigest') ||
        proposal?.proposalDigest !==
            unsignedDigest(proposal ?? {}, 'proposalDigest') ||
        proposal.requestDigest !== request.requestDigest ||
        proposal.failureDigest !== request.failureDigest ||
        consultedFailureDigests.filter((value) =>
            value === request.failureDigest).length > 1) {
        fail('advisor-proposal-replay-or-stale')
    }
    let previous = null
    const actions = proposal.actions.map((action, index) => {
        const compiled = {
            ordinal: index + 1,
            kind: action.kind,
            targetIdentity: action.targetIdentity,
            currentDigest: action.currentDigest,
            owningMachineOperation:
                CONTROL_PLANE_ADVISOR_POLICY.actionVocabulary[
                    action.kind
                ],
            preconditions: [...action.preconditions],
            postconditions: [...action.postconditions],
            failureDisposition: action.failureDisposition,
            requiredRevalidationGates:
                [...action.requiredRevalidationGates],
            dependsOnActionDigest: previous,
            actionDigest: null
        }
        delete compiled.actionDigest
        compiled.actionDigest = digest(compiled)
        previous = compiled.actionDigest
        return compiled
    })
    return seal({
        schema:
            'issue-orchestration.control-plane-recovery-plan.v1',
        producerAuthority:
            'deterministic-control-plane-recovery-compiler',
        status: 'compiled',
        requestDigest: request.requestDigest,
        proposalDigest: proposal.proposalDigest,
        failureDigest: request.failureDigest,
        rootInvocationId: request.rootInvocationId,
        startupAttestationDigest:
            request.startupAttestationDigest,
        actions,
        requiredRevalidationGates: [
            ...proposal.requiredRevalidationGates
        ],
        rootMayEditPlan: false
    }, 'planDigest')
}

export function executeControlPlaneRecoveryAction({
    plan,
    startup,
    action,
    previousActionReceipts = [],
    observedPostStateDigest,
    executedAt
} = {}) {
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    if (startupBinding.rootPhase !== 'scheduling' ||
        startupBinding.rootProfile !== 'terra-low' ||
        plan?.planDigest !==
            unsignedDigest(plan ?? {}, 'planDigest') ||
        plan.rootInvocationId !==
            startupBinding.runtimeInvocationId ||
        plan.startupAttestationDigest !==
            startupBinding.startupAttestationDigest) {
        fail('advisor-plan-root-execution-invalid')
    }
    const expected = plan.actions[
        previousActionReceipts.length
    ]
    if (!expected ||
        !sameValue(action, expected) ||
        previousActionReceipts.some((receipt, index) =>
            receipt?.schema !==
                'issue-orchestration.control-plane-recovery-action-receipt.v1' ||
            receipt.planDigest !== plan.planDigest ||
            receipt.actionDigest !==
                plan.actions[index].actionDigest ||
            receipt.receiptDigest !==
                unsignedDigest(receipt, 'receiptDigest')) ||
        expected.dependsOnActionDigest !==
            (previousActionReceipts.at(-1)?.actionDigest ?? null)) {
        fail('advisor-plan-action-order-or-content-mismatch')
    }
    assertDigest(
        observedPostStateDigest,
        'advisor-plan-action-postcondition-missing'
    )
    if (!expected.postconditions.includes(
        observedPostStateDigest
    )) {
        fail('advisor-plan-action-postcondition-mismatch')
    }
    return seal({
        schema:
            'issue-orchestration.control-plane-recovery-action-receipt.v1',
        producerAuthority: expected.owningMachineOperation,
        status: 'completed',
        planDigest: plan.planDigest,
        actionOrdinal: expected.ordinal,
        actionDigest: expected.actionDigest,
        previousActionReceiptDigest:
            previousActionReceipts.at(-1)?.receiptDigest ?? null,
        observedPostStateDigest,
        executedByRootInvocationId:
            startupBinding.runtimeInvocationId,
        executedAt
    }, 'receiptDigest')
}
