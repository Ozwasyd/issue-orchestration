import {
    assertArray,
    assertDigest,
    digest,
    fail,
    sameValue,
    seal
} from './runtime-contract-lib.mjs'
import {
    compileRuntimePermissionEvidence,
    validateRuntimeTrustBinding
} from './runtime-trust-policy.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'
import {
    STAGE_ROUTE_DEFINITIONS
} from './stage-profile-policy.mjs'

const ROOT_SCHEDULING_PROFILE = STAGE_ROUTE_DEFINITIONS[
    'root-scheduler:scheduling'
]?.defaultProfile
if (!ROOT_SCHEDULING_PROFILE) {
    throw new Error('root-control-route-policy-missing')
}

const PROJECTION_FIELDS = new Set([
    'schema',
    'repository',
    'issueNumber',
    'sourceFingerprint',
    'semanticReceiptDigest',
    'acceptanceContractDigest',
    'testPlanningReceiptDigest',
    'sliceValidationReceiptDigest',
    'uiAdjudicationReceiptDigest',
    'stageRole',
    'stagePhase',
    'allowedPaths',
    'requiredCommands',
    'acceptanceIds',
    'selectedSliceId',
    'selectedSliceDigest',
    'compiledPromptDigest',
    'nextActions',
    'fullIssueBodyIncluded',
    'fullDagIncluded',
    'stateRootIncluded',
    'projectionDigest'
])

export function validateDispatchInvestigationProjection(value) {
    if (value?.schema !==
            'issue-orchestration.dispatch-investigation-projection.v1' ||
        value.fullIssueBodyIncluded !== false ||
        value.fullDagIncluded !== false ||
        value.stateRootIncluded !== false ||
        Object.keys(value).some((key) => !PROJECTION_FIELDS.has(key))) {
        fail('root-projection-authority-boundary')
    }
    for (const field of [
        'sourceFingerprint',
        'semanticReceiptDigest',
        'acceptanceContractDigest',
        'testPlanningReceiptDigest',
        'sliceValidationReceiptDigest',
        'selectedSliceDigest',
        'compiledPromptDigest'
    ]) assertDigest(value[field], 'root-projection-binding')
    if (value.uiAdjudicationReceiptDigest !== null) {
        assertDigest(
            value.uiAdjudicationReceiptDigest,
            'root-projection-binding'
        )
    }
    for (const field of [
        'allowedPaths',
        'requiredCommands',
        'acceptanceIds'
    ]) assertArray(value[field], 'root-projection-boundary')
    const actions = assertArray(
        value.nextActions,
        'root-projection-next-action',
        { min: 1 }
    )
    if (actions.length !== 1 ||
        actions[0].sliceId !== value.selectedSliceId ||
        actions[0].sliceDigest !== value.selectedSliceDigest) {
        fail('root-projection-next-action')
    }
    if (value.projectionDigest !== digest(Object.fromEntries(
        Object.entries(value).filter(
            ([key]) => key !== 'projectionDigest'
        )
    ))) {
        fail('root-projection-digest')
    }
    return value
}

function validateRootRuntime({
    startup,
    runtimeTrustBinding,
    repositoryTargets
}) {
    let startupBinding
    try {
        startupBinding = requireRuntimeStartupBinding({ startup })
    } catch {
        fail('root-control-startup-attestation')
    }
    if (startupBinding.rootPhase !== 'scheduling' ||
        startupBinding.rootProfile !== ROOT_SCHEDULING_PROFILE) {
        fail('root-control-profile')
    }
    try {
        validateRuntimeTrustBinding(runtimeTrustBinding, {
            expectedRole: 'root-scheduler',
            expectedExecutionClass: 'root-control',
            repositoryTargets,
            startup
        })
    } catch {
        fail('root-control-runtime-trust')
    }
    const runtimePermissionEvidence =
        compileRuntimePermissionEvidence({
            binding: runtimeTrustBinding,
            evidenceClass: 'run',
            repositoryTargets,
            startup
        })
    return {
        rootProfile: startupBinding.rootProfile,
        startupBinding,
        runtimePermissionEvidence
    }
}

export function compileRootControlAction({
    projection,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    requestedAction
}) {
    validateDispatchInvestigationProjection(projection)
    const {
        rootProfile,
        startupBinding,
        runtimePermissionEvidence
    } = validateRootRuntime({
        startup,
        runtimeTrustBinding,
        repositoryTargets
    })
    if (!sameValue(requestedAction, projection.nextActions[0])) {
        fail('root-control-action-not-recomputable')
    }
    if (![
        'dispatch-ready-slice',
        'accept-authority-receipt',
        'reject-authority-receipt',
        'authority-reinvestigation-required',
        'persist-checkpoint',
        'resume-continuation',
        'delivery-control',
        'resource-cleanup-gate'
    ].includes(requestedAction.action)) {
        fail('root-control-action')
    }
    return seal({
        schema:
            'issue-orchestration.root-control-action-receipt.v1',
        status: 'authorized',
        rootProfile,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeInvocationId:
            startupBinding.runtimeInvocationId,
        runtimeSessionId:
            startupBinding.runtimeSessionId,
        rootAuthorityEpoch:
            startupBinding.rootAuthorityEpoch,
        runtimeTrustMode:
            runtimePermissionEvidence.runtimeTrustMode,
        runtimeTrustBindingDigest:
            runtimePermissionEvidence.runtimeTrustBindingDigest,
        runtimePermissionEvidenceDigest:
            runtimePermissionEvidence.evidenceDigest,
        effectivePermissionProfile:
            runtimePermissionEvidence.effectivePermissionProfile,
        permissionInheritance:
            runtimePermissionEvidence.permissionInheritance,
        machineEnforcedRoleIsolation:
            runtimePermissionEvidence.machineEnforcedRoleIsolation,
        mutationPostconditionRequired:
            runtimePermissionEvidence.mutationPostconditionRequired,
        projectionDigest: projection.projectionDigest,
        action: requestedAction.action,
        actionInputDigest: digest(requestedAction),
        semanticWorkPerformedByRoot: false
    }, 'receiptDigest')
}

export function createInvestigationCache({
    sourceFingerprint,
    semanticReceiptDigest,
    testPlanningReceiptDigest
}) {
    for (const value of [
        sourceFingerprint,
        semanticReceiptDigest,
        testPlanningReceiptDigest
    ]) assertDigest(value, 'investigation-cache-binding')
    return seal({
        schema: 'issue-orchestration.investigation-cache.v1',
        sourceFingerprint,
        semanticReceiptDigest,
        testPlanningReceiptDigest,
        reviewerRequired: false
    }, 'cacheDigest')
}

export function resolveInvestigationCache({
    cache,
    sourceFingerprint
}) {
    if (cache?.schema !==
            'issue-orchestration.investigation-cache.v1' ||
        cache.reviewerRequired !== false) {
        fail('investigation-cache-invalid')
    }
    assertDigest(sourceFingerprint, 'investigation-cache-fingerprint')
    return Object.freeze({
        action: cache.sourceFingerprint === sourceFingerprint
            ? 'reuse-authority-evidence'
            : 'authority-reinvestigation-required',
        sourceFingerprint,
        cacheDigest: cache.cacheDigest
    })
}
