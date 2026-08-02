import {
    HASH,
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal
} from './runtime-contract-lib.mjs'
import {
    verifyRuntimeProfileMetadata
} from './stage-profile-policy.mjs'

const EMPTY_EVENT_FIELDS = Object.freeze([
    'assistantContentEvents',
    'toolCallEvents',
    'commandEvents',
    'filesystemWriteEvents',
    'checkpointEvents',
    'terminalArtifactEvents'
])
const TRANSIENT_TERMINATIONS = new Set([
    'transport-termination',
    'service-termination',
    'empty-assistant-turn'
])

function validateFailure(value) {
    if (value?.schema !==
            'issue-orchestration.writer-stage-failure-receipt.v1' ||
        value.classification !== 'writer-stage.output-missing' ||
        value.status !== 'terminal') {
        fail('transient-retry-failure-receipt')
    }
    assertDigest(
        value.failureReceiptDigest,
        'transient-retry-first-failure'
    )
    if (value.firstFailureReceiptDigest !==
        value.failureReceiptDigest) {
        fail('transient-retry-first-failure')
    }
    if (value.reworkCountDelta !== 0 ||
        value.humanDecisionRequired !== false) {
        fail('transient-retry-side-effect')
    }
    if (!value.semanticIdentity ||
        value.semanticFailureIdentity !==
            digest(value.semanticIdentity)) {
        fail('transient-retry-semantic-identity')
    }
    for (const field of [
        'planDigest',
        'sliceDigest',
        'promptDigest',
        'routeDecisionDigest',
        'candidateDigest'
    ]) assertDigest(
        value.semanticIdentity[field],
        'transient-retry-semantic-identity'
    )
    return value
}

function validateRuntime(observation, failure) {
    if (observation?.schema !==
            'issue-orchestration.writer-runtime-observation.v2' ||
        observation.source !== 'trusted-codex-runtime-trace' ||
        observation.dispatchAccepted !== true) {
        fail('transient-retry-runtime-identity')
    }
    for (const field of ['threadId', 'rolloutId', 'requestId']) {
        assertText(
            observation[field],
            'transient-retry-runtime-identity'
        )
    }
    assertDigest(
        observation.observationDigest,
        'transient-retry-runtime-identity'
    )
    try {
        verifyRuntimeProfileMetadata({
            selectedProfile: failure.selectedProfile,
            requestedModel: observation.requestedModel,
            effectiveModel: observation.effectiveModel,
            requestedEffort: observation.requestedEffort,
            effectiveEffort: observation.effectiveEffort,
            multiAgentBackend: observation.multiAgentBackend
        })
    } catch {
        fail('transient-retry-runtime-mismatch')
    }
    if (observation.selectedProfile !== failure.selectedProfile ||
        typeof observation.role !== 'string' ||
        typeof observation.sandbox !== 'string' ||
        typeof observation.cwd !== 'string' ||
        !HASH.test(observation.skillsDigest ?? '') ||
        !HASH.test(observation.leaseDigest ?? '')) {
        fail('transient-retry-runtime-mismatch')
    }
    for (const field of EMPTY_EVENT_FIELDS) {
        if (!Array.isArray(observation[field]) ||
            observation[field].length !== 0) {
            fail('transient-retry-not-empty')
        }
    }
    if (!TRANSIENT_TERMINATIONS.has(
        observation.terminationClass
    )) {
        fail('transient-retry-termination-class')
    }
    return observation
}

export function classifyTransientEmptyRollout(input) {
    const failure = validateFailure(input?.failureReceipt)
    const observation = validateRuntime(
        input.runtimeObservation,
        failure
    )
    return Object.freeze({
        schema:
            'issue-orchestration.transient-rollout-classification.v1',
        classification: 'writer-stage.transient-rollout-empty',
        semanticFailureIdentity:
            failure.semanticFailureIdentity,
        failureReceiptDigest: failure.failureReceiptDigest,
        runtimeObservationDigest:
            observation.observationDigest,
        actionCount: 0
    })
}

export function authorizeTransientEmptyRolloutRetry(input) {
    const classification = classifyTransientEmptyRollout(input)
    const failure = input.failureReceipt
    const retrySemanticIdentity =
        input.retrySemanticIdentity ??
        failure.semanticIdentity
    if (!sameValue(
        retrySemanticIdentity,
        failure.semanticIdentity
    )) {
        fail('transient-retry-semantic-drift')
    }
    const prior = Array.isArray(input.priorAuthorizations)
        ? input.priorAuthorizations
        : []
    if (prior.some((receipt) =>
        receipt.status === 'authorized' &&
        receipt.semanticFailureIdentity ===
            failure.semanticFailureIdentity)) {
        fail('transient-retry-budget-exhausted')
    }
    const next = input.newRolloutIdentity
    for (const field of ['threadId', 'rolloutId', 'requestId']) {
        assertText(next?.[field], 'transient-retry-new-identity')
        if (next[field] === input.runtimeObservation[field]) {
            fail('transient-retry-new-identity')
        }
    }
    return seal({
        schema:
            'issue-orchestration.transient-rollout-retry-authorization.v1',
        status: 'authorized',
        classification:
            'writer-stage.transient-rollout-retry-authorized',
        retryOrdinal: 1,
        semanticFailureIdentity:
            classification.semanticFailureIdentity,
        semanticIdentity:
            structuredClone(failure.semanticIdentity),
        firstFailureReceiptDigest:
            failure.failureReceiptDigest,
        firstFailurePreserved: true,
        previousRuntimeObservationDigest:
            input.runtimeObservation.observationDigest,
        newRolloutIdentity: structuredClone(next),
        selectedProfile: failure.selectedProfile,
        profileChangeAllowed: false,
        reworkCountDelta: 0,
        humanDecisionRequired: false
    }, 'authorizationDigest')
}
