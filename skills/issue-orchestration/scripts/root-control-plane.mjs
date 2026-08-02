import {
    assertArray,
    assertDigest,
    digest,
    fail,
    sameValue,
    seal
} from './runtime-contract-lib.mjs'
import {
    verifyRuntimeProfileMetadata
} from './stage-profile-policy.mjs'

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

function validateRootRuntime(value) {
    const route = value?.routeDecision
    if (route?.schema !==
            'issue-orchestration.execution-route-decision.v1' ||
        route.policyVersion !== 'execution-capability-routing.v2' ||
        route.modelPoolPolicyVersion !== 'stage-model-pool.v3' ||
        route.routingAuthority !==
            'deterministic-execution-capability-compiler' ||
        route.stageRole !== 'root-scheduler' ||
        route.stagePhase !== 'scheduling' ||
        !['terra-low', 'terra-medium'].includes(
            route.selectedProfile
        )) {
        fail('root-control-profile')
    }
    if (route.selectedProfile === 'terra-medium' &&
        (typeof value.recoveryClassification !== 'string' ||
            !value.recoveryClassification ||
            !/^[a-f0-9]{64}$/u.test(
                value.recoveryReceiptDigest ?? ''
            ))) {
        fail('root-control-recovery')
    }
    try {
        verifyRuntimeProfileMetadata({
            selectedProfile: route.selectedProfile,
            requestedModel: value.metadata?.requestedModel,
            effectiveModel: value.metadata?.effectiveModel,
            requestedEffort: value.metadata?.requestedEffort,
            effectiveEffort: value.metadata?.effectiveEffort,
            multiAgentBackend: value.metadata?.multiAgentBackend
        })
    } catch {
        fail('root-control-runtime-metadata')
    }
    if (value.metadata?.role !== 'root-scheduler' ||
        value.metadata?.sandbox !== 'read-only') {
        fail('root-control-runtime-metadata')
    }
    return route.selectedProfile
}

export function compileRootControlAction({
    projection,
    rootRuntime,
    requestedAction
}) {
    validateDispatchInvestigationProjection(projection)
    const rootProfile = validateRootRuntime(rootRuntime)
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
