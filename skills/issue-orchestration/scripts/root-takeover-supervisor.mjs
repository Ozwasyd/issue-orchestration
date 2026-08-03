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

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/root-takeover-policy.json'
)

export const ROOT_TAKEOVER_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const ROOT_TAKEOVER_POLICY_DIGEST =
    digest(ROOT_TAKEOVER_POLICY)

const SHA = /^[a-f0-9]{40}$/u

function timestamp(value, code) {
    const result = Date.parse(value)
    if (!Number.isFinite(result)) fail(code)
    return result
}

export function compileRootTakeoverEligibility({
    runId,
    oldRootInvocationId,
    oldRootSessionId,
    reasonCode,
    directEvidenceDigest,
    failureProjectionDigest,
    advisorDisposition,
    advisorEvidenceDigest = null,
    lowerCostRecoveryExhausted,
    issuedAt
} = {}) {
    for (const value of [
        runId,
        oldRootInvocationId,
        oldRootSessionId,
        advisorDisposition,
        issuedAt
    ]) assertText(value, 'root-takeover-eligibility-incomplete')
    if (!ROOT_TAKEOVER_POLICY.eligibleReasonCodes
        .includes(reasonCode) ||
        ROOT_TAKEOVER_POLICY.forbiddenReasonCodes
            .includes(reasonCode) ||
        !ROOT_TAKEOVER_POLICY
            .advisorDispositionsPermittingTakeover
            .includes(advisorDisposition) ||
        lowerCostRecoveryExhausted !== true) {
        fail('root-takeover-ineligible')
    }
    for (const value of [
        directEvidenceDigest,
        failureProjectionDigest
    ]) assertDigest(value, 'root-takeover-eligibility-incomplete')
    if (advisorEvidenceDigest !== null) {
        assertDigest(
            advisorEvidenceDigest,
            'root-takeover-eligibility-incomplete'
        )
    }
    timestamp(issuedAt, 'root-takeover-eligibility-incomplete')
    return seal({
        schema:
            'issue-orchestration.root-takeover-eligibility-receipt.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.eligibilityAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        status: 'eligible',
        runId,
        oldRootInvocationId,
        oldRootSessionId,
        reasonCode,
        directEvidenceDigest,
        failureProjectionDigest,
        advisorDisposition,
        advisorEvidenceDigest,
        lowerCostRecoveryExhausted: true,
        issuedAt
    }, 'receiptDigest')
}

function validateEligibility(value) {
    if (value?.schema !==
            'issue-orchestration.root-takeover-eligibility-receipt.v1' ||
        value.producerAuthority !==
            ROOT_TAKEOVER_POLICY.eligibilityAuthority ||
        value.policyDigest !== ROOT_TAKEOVER_POLICY_DIGEST ||
        value.status !== 'eligible' ||
        value.receiptDigest !==
            unsignedDigest(value, 'receiptDigest')) {
        fail('root-takeover-eligibility-invalid')
    }
    return value
}

export function compileRootTakeoverAuthorization(input = {}) {
    const eligibility = validateEligibility(
        input.eligibilityReceipt
    )
    if (eligibility.runId !== input.runId ||
        eligibility.oldRootInvocationId !==
            input.oldRootInvocationId ||
        eligibility.oldRootSessionId !==
            input.oldRootSessionId ||
        eligibility.reasonCode !== input.reasonCode ||
        input.expectedNewInvocationId ===
            input.oldRootInvocationId ||
        input.oldRootAuthorityEpoch ===
            input.newRootAuthorityEpoch) {
        fail('root-takeover-authorization-identity-mismatch')
    }
    for (const field of [
        'runId',
        'oldRootInvocationId',
        'oldRootSessionId',
        'oldRootAuthorityEpoch',
        'expectedNewInvocationId',
        'newRootAuthorityEpoch',
        'reasonCode',
        'deterministicRecoveryDisposition',
        'deliveryEpoch',
        'issuedAt',
        'expiresAt'
    ]) assertText(
        input[field],
        'root-takeover-authorization-incomplete'
    )
    for (const field of [
        'oldRootControlLeaseDigest',
        'oldRootStartupAttestationDigest',
        'directEvidenceDigest',
        'packageDigest',
        'policySetDigest',
        'stateRootDigest',
        'checkpointIdentityDigest',
        'repositoryStateDigest',
        'remoteSnapshotDigest',
        'activeInventoryDigest',
        'requiredDispositionDigest',
        'fencingRequirementsDigest'
    ]) assertDigest(
        input[field],
        'root-takeover-authorization-incomplete'
    )
    if (!SHA.test(input.baseSha ?? '')) {
        fail('root-takeover-authorization-incomplete')
    }
    for (const field of [
        'advisorRequestDigest',
        'advisorProposalDigest',
        'recoveryPlanDigest'
    ]) {
        if (input[field] !== null) {
            assertDigest(
                input[field],
                'root-takeover-authorization-incomplete'
            )
        }
    }
    const issued = timestamp(
        input.issuedAt,
        'root-takeover-authorization-expiry'
    )
    const expires = timestamp(
        input.expiresAt,
        'root-takeover-authorization-expiry'
    )
    if (expires <= issued ||
        expires - issued >
            ROOT_TAKEOVER_POLICY.authorizationTtlSeconds *
                1000) {
        fail('root-takeover-authorization-expiry')
    }
    return seal({
        schema:
            'issue-orchestration.root-takeover-authorization.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.eligibilityAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        status: 'authorized',
        runId: input.runId,
        oldRootInvocationId: input.oldRootInvocationId,
        oldRootSessionId: input.oldRootSessionId,
        oldRootAuthorityEpoch: input.oldRootAuthorityEpoch,
        oldRootControlLeaseDigest:
            input.oldRootControlLeaseDigest,
        oldRootStartupAttestationDigest:
            input.oldRootStartupAttestationDigest,
        expectedNewRootPhase:
            ROOT_TAKEOVER_POLICY.recoveryRootPhase,
        expectedNewRootProfile:
            ROOT_TAKEOVER_POLICY.recoveryRootProfile,
        expectedNewInvocationClass: 'parent-invocation',
        expectedNewInvocationId:
            input.expectedNewInvocationId,
        newRootAuthorityEpoch: input.newRootAuthorityEpoch,
        reasonCode: input.reasonCode,
        directEvidenceDigest: input.directEvidenceDigest,
        eligibilityReceiptDigest:
            eligibility.receiptDigest,
        advisorRequestDigest: input.advisorRequestDigest,
        advisorProposalDigest: input.advisorProposalDigest,
        recoveryPlanDigest: input.recoveryPlanDigest,
        deterministicRecoveryDisposition:
            input.deterministicRecoveryDisposition,
        packageDigest: input.packageDigest,
        policySetDigest: input.policySetDigest,
        stateRootDigest: input.stateRootDigest,
        checkpointIdentityDigest:
            input.checkpointIdentityDigest,
        repositoryStateDigest:
            input.repositoryStateDigest,
        baseSha: input.baseSha,
        deliveryEpoch: input.deliveryEpoch,
        remoteSnapshotDigest: input.remoteSnapshotDigest,
        activeInventoryDigest: input.activeInventoryDigest,
        requiredDispositionDigest:
            input.requiredDispositionDigest,
        fencingRequirementsDigest:
            input.fencingRequirementsDigest,
        attemptOrdinal: 1,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt
    }, 'authorizationDigest')
}

export function validateRootTakeoverAuthorization(value, {
    now,
    consumedAuthorizationDigests = []
} = {}) {
    if (value?.schema !==
            'issue-orchestration.root-takeover-authorization.v1' ||
        value.producerAuthority !==
            ROOT_TAKEOVER_POLICY.eligibilityAuthority ||
        value.policyDigest !== ROOT_TAKEOVER_POLICY_DIGEST ||
        value.status !== 'authorized' ||
        value.authorizationDigest !==
            unsignedDigest(value, 'authorizationDigest') ||
        value.attemptOrdinal !== 1 ||
        consumedAuthorizationDigests.includes(
            value.authorizationDigest
        ) ||
        now !== undefined &&
            timestamp(now, 'root-takeover-authorization-expired') >
                timestamp(
                    value.expiresAt,
                    'root-takeover-authorization-expired'
                )) {
        fail('root-takeover-authorization-invalid-or-consumed')
    }
    return value
}

export function fenceOldRoot({
    authorization,
    oldRootProcessDisposition,
    oldRootLeaseStatus,
    activeActorInventoryDigest,
    activeResourceInventoryDigest,
    inventoryDispositionDigest,
    observedFencingCoverage,
    fencedAt
} = {}) {
    validateRootTakeoverAuthorization(authorization)
    if (!['terminated', 'machine-fenced']
        .includes(oldRootProcessDisposition) ||
        oldRootLeaseStatus !== 'revoked' ||
        !sameValue(
            [...observedFencingCoverage].sort(),
            [...ROOT_TAKEOVER_POLICY.fencingCoverage].sort()
        )) {
        fail('root-takeover-fencing-incomplete')
    }
    for (const value of [
        activeActorInventoryDigest,
        activeResourceInventoryDigest,
        inventoryDispositionDigest
    ]) assertDigest(value, 'root-takeover-fencing-incomplete')
    timestamp(fencedAt, 'root-takeover-fencing-incomplete')
    return seal({
        schema: 'issue-orchestration.root-fencing-receipt.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.supervisorAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        status: 'fenced',
        runId: authorization.runId,
        takeoverAuthorizationDigest:
            authorization.authorizationDigest,
        oldRootInvocationId:
            authorization.oldRootInvocationId,
        oldRootSessionId: authorization.oldRootSessionId,
        oldRootControlLeaseDigest:
            authorization.oldRootControlLeaseDigest,
        oldRootLeaseStatus: 'revoked',
        oldRootProcessDisposition,
        oldRootControlAuthorityRevoked: true,
        fencingCoverage: [
            ...ROOT_TAKEOVER_POLICY.fencingCoverage
        ],
        activeActorInventoryDigest,
        activeResourceInventoryDigest,
        inventoryDispositionDigest,
        uniqueRootLeaseAvailable: true,
        newRootAuthorityEpoch:
            authorization.newRootAuthorityEpoch,
        fencedAt
    }, 'receiptDigest')
}

function validateFencing(value, authorization) {
    if (value?.schema !==
            'issue-orchestration.root-fencing-receipt.v1' ||
        value.producerAuthority !==
            ROOT_TAKEOVER_POLICY.supervisorAuthority ||
        value.policyDigest !== ROOT_TAKEOVER_POLICY_DIGEST ||
        value.status !== 'fenced' ||
        value.receiptDigest !==
            unsignedDigest(value, 'receiptDigest') ||
        value.takeoverAuthorizationDigest !==
            authorization.authorizationDigest ||
        value.oldRootControlAuthorityRevoked !== true ||
        value.uniqueRootLeaseAvailable !== true ||
        !sameValue(
            [...value.fencingCoverage].sort(),
            [...ROOT_TAKEOVER_POLICY.fencingCoverage].sort()
        )) {
        fail('root-takeover-fencing-invalid')
    }
    return value
}

export function compileRootRecoveryHandoff({
    authorization,
    fencingReceipt,
    stateRootDigest,
    ledgerDigest,
    dagDigest,
    checkpointDigest,
    rootCursorDigest,
    activeInventoryDigest,
    evidenceSetDigest,
    repositoryStateDigest,
    remoteSnapshotDigest,
    advisorRecoveryChainDigest = null,
    requiredRevalidationGates =
        ROOT_TAKEOVER_POLICY.requiredRevalidationGates,
    freeFormConversationIncluded = false
} = {}) {
    validateRootTakeoverAuthorization(authorization)
    validateFencing(fencingReceipt, authorization)
    for (const value of [
        stateRootDigest,
        ledgerDigest,
        dagDigest,
        checkpointDigest,
        rootCursorDigest,
        activeInventoryDigest,
        evidenceSetDigest,
        repositoryStateDigest,
        remoteSnapshotDigest
    ]) assertDigest(value, 'root-recovery-handoff-incomplete')
    if (advisorRecoveryChainDigest !== null) {
        assertDigest(
            advisorRecoveryChainDigest,
            'root-recovery-handoff-incomplete'
        )
    }
    if (freeFormConversationIncluded !== false ||
        !sameValue(
            [...requiredRevalidationGates].sort(),
            [...ROOT_TAKEOVER_POLICY
                .requiredRevalidationGates].sort()
        ) ||
        stateRootDigest !== authorization.stateRootDigest ||
        checkpointDigest !==
            authorization.checkpointIdentityDigest ||
        activeInventoryDigest !==
            authorization.activeInventoryDigest ||
        repositoryStateDigest !==
            authorization.repositoryStateDigest ||
        remoteSnapshotDigest !==
            authorization.remoteSnapshotDigest) {
        fail('root-recovery-handoff-authority-mismatch')
    }
    return seal({
        schema: 'issue-orchestration.root-recovery-handoff.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.supervisorAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        runId: authorization.runId,
        takeoverAuthorizationDigest:
            authorization.authorizationDigest,
        fencingReceiptDigest: fencingReceipt.receiptDigest,
        oldRootInvocationId:
            authorization.oldRootInvocationId,
        expectedNewInvocationId:
            authorization.expectedNewInvocationId,
        oldRootAuthorityEpoch:
            authorization.oldRootAuthorityEpoch,
        newRootAuthorityEpoch:
            authorization.newRootAuthorityEpoch,
        stateRootDigest,
        ledgerDigest,
        dagDigest,
        checkpointDigest,
        rootCursorDigest,
        activeInventoryDigest,
        evidenceSetDigest,
        repositoryStateDigest,
        remoteSnapshotDigest,
        advisorRecoveryChainDigest,
        requiredRevalidationGates: [
            ...ROOT_TAKEOVER_POLICY.requiredRevalidationGates
        ],
        freeFormConversationIncluded: false
    }, 'handoffDigest')
}

function validateHandoff(value, authorization, fencingReceipt) {
    if (value?.schema !==
            'issue-orchestration.root-recovery-handoff.v1' ||
        value.producerAuthority !==
            ROOT_TAKEOVER_POLICY.supervisorAuthority ||
        value.policyDigest !== ROOT_TAKEOVER_POLICY_DIGEST ||
        value.handoffDigest !==
            unsignedDigest(value, 'handoffDigest') ||
        value.takeoverAuthorizationDigest !==
            authorization.authorizationDigest ||
        value.fencingReceiptDigest !==
            fencingReceipt.receiptDigest ||
        value.runId !== authorization.runId ||
        value.oldRootInvocationId !==
            authorization.oldRootInvocationId ||
        value.expectedNewInvocationId !==
            authorization.expectedNewInvocationId ||
        value.oldRootAuthorityEpoch !==
            authorization.oldRootAuthorityEpoch ||
        value.newRootAuthorityEpoch !==
            authorization.newRootAuthorityEpoch ||
        value.stateRootDigest !==
            authorization.stateRootDigest ||
        value.checkpointDigest !==
            authorization.checkpointIdentityDigest ||
        value.activeInventoryDigest !==
            authorization.activeInventoryDigest ||
        value.repositoryStateDigest !==
            authorization.repositoryStateDigest ||
        value.remoteSnapshotDigest !==
            authorization.remoteSnapshotDigest ||
        !sameValue(
            [...value.requiredRevalidationGates].sort(),
            [...ROOT_TAKEOVER_POLICY
                .requiredRevalidationGates].sort()
        ) ||
        value.freeFormConversationIncluded !== false) {
        fail('root-recovery-handoff-invalid')
    }
    return value
}

export function authorizeRecoveryRootLaunch({
    authorization,
    fencingReceipt,
    handoff,
    launchedAt,
    consumedAuthorizationDigests = []
} = {}) {
    validateRootTakeoverAuthorization(authorization, {
        now: launchedAt,
        consumedAuthorizationDigests
    })
    validateFencing(fencingReceipt, authorization)
    validateHandoff(handoff, authorization, fencingReceipt)
    return seal({
        schema:
            'issue-orchestration.root-recovery-launch-receipt.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.supervisorAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        status: 'launch-authorized',
        runId: authorization.runId,
        takeoverAuthorizationDigest:
            authorization.authorizationDigest,
        fencingReceiptDigest: fencingReceipt.receiptDigest,
        handoffDigest: handoff.handoffDigest,
        expectedNewInvocationId:
            authorization.expectedNewInvocationId,
        expectedInvocationClass: 'parent-invocation',
        requestedStage:
            ROOT_TAKEOVER_POLICY.recoveryRootPhase,
        requestedProfile:
            ROOT_TAKEOVER_POLICY.recoveryRootProfile,
        requestedModel: 'gpt-5.6-terra',
        requestedEffort: 'medium',
        requestedMultiAgentBackend: 'v2',
        requestedTrustMode: 'trusted-owner-repositories',
        requestedPermissionProfile: 'danger-full-access',
        requestedApprovalPolicy: 'never',
        newRootAuthorityEpoch:
            authorization.newRootAuthorityEpoch,
        attemptOrdinal: 1,
        launchedAt
    }, 'receiptDigest')
}

export function completeRecoveryTakeover({
    authorization,
    fencingReceipt,
    handoff,
    launchReceipt,
    startup,
    rootControlLeaseDigest,
    activeRootLeaseCount,
    revalidationReceiptDigests,
    activeInventoryDigest,
    resultingState,
    completedAt
} = {}) {
    validateRootTakeoverAuthorization(authorization)
    validateFencing(fencingReceipt, authorization)
    validateHandoff(handoff, authorization, fencingReceipt)
    if (launchReceipt?.schema !==
            'issue-orchestration.root-recovery-launch-receipt.v1' ||
        launchReceipt.receiptDigest !==
            unsignedDigest(launchReceipt, 'receiptDigest') ||
        launchReceipt.takeoverAuthorizationDigest !==
            authorization.authorizationDigest) {
        fail('root-recovery-launch-receipt-invalid')
    }
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    if (startupBinding.rootPhase !== 'recovery-takeover' ||
        startupBinding.rootProfile !== 'terra-medium' ||
        startupBinding.runtimeInvocationId !==
            authorization.expectedNewInvocationId ||
        startupBinding.runtimeInvocationId ===
            authorization.oldRootInvocationId ||
        startupBinding.rootAuthorityEpoch !==
            authorization.newRootAuthorityEpoch ||
        startup.attestation.recoveryAuthorizationDigest !==
            authorization.authorizationDigest ||
        startup.attestation.takeoverHandoffDigest !==
            handoff.handoffDigest ||
        startup.attestation.oldRootFencingReceiptDigest !==
            fencingReceipt.receiptDigest ||
        activeRootLeaseCount !== 1 ||
        activeInventoryDigest !== handoff.activeInventoryDigest ||
        !['valid-scheduling', 'bounded-terminal']
            .includes(resultingState)) {
        fail('root-recovery-takeover-completion-invalid')
    }
    assertDigest(
        rootControlLeaseDigest,
        'root-recovery-takeover-completion-invalid'
    )
    if (!sameValue(
        Object.keys(revalidationReceiptDigests ?? {}).sort(),
        [...ROOT_TAKEOVER_POLICY
            .requiredRevalidationGates].sort()
    ) ||
        Object.values(revalidationReceiptDigests ?? {})
            .some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
        fail('root-recovery-revalidation-incomplete')
    }
    return seal({
        schema:
            'issue-orchestration.root-takeover-completion-receipt.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.supervisorAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        status: 'completed',
        runId: authorization.runId,
        takeoverAuthorizationDigest:
            authorization.authorizationDigest,
        launchReceiptDigest: launchReceipt.receiptDigest,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        newRootInvocationId:
            startupBinding.runtimeInvocationId,
        newRootSessionId: startupBinding.runtimeSessionId,
        newRootAuthorityEpoch:
            startupBinding.rootAuthorityEpoch,
        oldRootFencingReceiptDigest:
            fencingReceipt.receiptDigest,
        rootControlLeaseDigest,
        activeRootLeaseCount: 1,
        handoffDigest: handoff.handoffDigest,
        revalidationReceiptDigests:
            structuredClone(revalidationReceiptDigests),
        activeInventoryDigest,
        resultingState,
        completedAt
    }, 'receiptDigest')
}

export function terminalizeRecoveryTakeover({
    authorization,
    fencingReceipt,
    failureCode,
    failureEvidenceDigest,
    failedNewInvocationId,
    resourcesTerminalized,
    terminalizedAt
} = {}) {
    validateRootTakeoverAuthorization(authorization)
    validateFencing(fencingReceipt, authorization)
    assertText(failureCode, 'root-recovery-terminal-incomplete')
    assertText(
        failedNewInvocationId,
        'root-recovery-terminal-incomplete'
    )
    assertDigest(
        failureEvidenceDigest,
        'root-recovery-terminal-incomplete'
    )
    if (resourcesTerminalized !== true) {
        fail('root-recovery-terminal-incomplete')
    }
    return seal({
        schema:
            'issue-orchestration.root-takeover-terminal-receipt.v1',
        producerAuthority:
            ROOT_TAKEOVER_POLICY.supervisorAuthority,
        policyDigest: ROOT_TAKEOVER_POLICY_DIGEST,
        status: 'recovery-takeover-terminal',
        runId: authorization.runId,
        takeoverAuthorizationDigest:
            authorization.authorizationDigest,
        attemptOrdinal: 1,
        failureCode,
        failureEvidenceDigest,
        oldRootFencingReceiptDigest:
            fencingReceipt.receiptDigest,
        failedNewInvocationId,
        newRootAuthorityGranted: false,
        automaticRestartAllowed: false,
        mediumToLowRollbackAllowed: false,
        resourcesTerminalized: true,
        terminalizedAt
    }, 'receiptDigest')
}

export function rejectFencedOldRootAction({
    fencingReceipt,
    actorInvocationId,
    actorAuthorityEpoch
} = {}) {
    if (fencingReceipt?.status === 'fenced' &&
        (actorInvocationId ===
            fencingReceipt.oldRootInvocationId ||
        actorAuthorityEpoch !==
            fencingReceipt.newRootAuthorityEpoch)) {
        fail('old-root-action-after-fencing')
    }
    return true
}
