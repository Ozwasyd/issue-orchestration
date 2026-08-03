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
    validateRuntimeExecutionBinding
} from './runtime-execution-binding.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/remote-mutation-policy.json'
)

export const REMOTE_MUTATION_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const REMOTE_MUTATION_POLICY_DIGEST =
    digest(REMOTE_MUTATION_POLICY)

const SHA = /^[a-f0-9]{40}$/u

export function sealRemoteStateSnapshot(value = {}) {
    if (value.producerAuthority !==
            REMOTE_MUTATION_POLICY.snapshotAuthority ||
        !SHA.test(value.defaultBranchSha ?? '')) {
        fail('remote-snapshot-authority-invalid')
    }
    for (const field of [
        'repository',
        'issueId',
        'defaultBranch',
        'observedAt'
    ]) assertText(value[field], 'remote-snapshot-incomplete')
    assertDigest(
        value.issueStateDigest,
        'remote-snapshot-incomplete'
    )
    return seal({
        schema: 'issue-orchestration.remote-state-snapshot.v1',
        producerAuthority: value.producerAuthority,
        repository: value.repository,
        issueId: value.issueId,
        defaultBranch: value.defaultBranch,
        defaultBranchSha: value.defaultBranchSha,
        issueStateDigest: value.issueStateDigest,
        observedAt: value.observedAt
    }, 'snapshotDigest')
}

export function validateRemoteStateSnapshot(value) {
    if (value?.schema !==
            'issue-orchestration.remote-state-snapshot.v1' ||
        value.producerAuthority !==
            REMOTE_MUTATION_POLICY.snapshotAuthority ||
        value.snapshotDigest !==
            unsignedDigest(value, 'snapshotDigest')) {
        fail('remote-snapshot-invalid')
    }
    return value
}

function validateMutation(mutation) {
    const required = REMOTE_MUTATION_POLICY.rootActions[
        mutation?.action
    ]
    if (!required || !mutation.evidence ||
        typeof mutation.evidence !== 'object' ||
        Array.isArray(mutation.evidence)) {
        fail('remote-mutation-action-forbidden')
    }
    const actualKeys = Object.keys(mutation.evidence).sort()
    if (JSON.stringify(actualKeys) !==
        JSON.stringify([...required].sort())) {
        fail('remote-mutation-evidence-incomplete')
    }
    for (const field of required) {
        const value = mutation.evidence[field]
        if (field.includes('Sha')) {
            if (!SHA.test(value ?? '')) {
                fail('remote-mutation-evidence-incomplete')
            }
        } else {
            assertDigest(
                value,
                'remote-mutation-evidence-incomplete'
            )
        }
    }
    return structuredClone(mutation)
}

export function compileDeliveryControlReceipt({
    runId,
    deliveryEpoch,
    rootControlLeaseDigest,
    runtimeExecutionBinding,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    repository,
    issueId,
    candidateSha,
    defaultBranchSha,
    terminalEvidenceDigest,
    acceptanceGroupDigest = null,
    mutation,
    expectedPostStateDigest,
    preRemoteSnapshot,
    issuedAt,
    expiresAt
} = {}) {
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    validateRuntimeExecutionBinding(runtimeExecutionBinding, {
        stageRole: 'root-scheduler',
        stagePhase: startupBinding.rootPhase,
        startup,
        runtimeTrustBinding,
        repositoryTargets
    })
    if (runtimeExecutionBinding.executionClass !== 'root-control' ||
        runtimeExecutionBinding.actorInvocationId !==
            startupBinding.runtimeInvocationId ||
        runtimeExecutionBinding.actorSessionId !==
            startupBinding.runtimeSessionId ||
        runtimeExecutionBinding.writeLeaseDigest !==
            rootControlLeaseDigest) {
        fail('remote-mutation-root-authority-invalid')
    }
    validateRemoteStateSnapshot(preRemoteSnapshot)
    for (const field of [
        'runId',
        'deliveryEpoch',
        'repository',
        'issueId'
    ]) assertText(
        { runId, deliveryEpoch, repository, issueId }[field],
        'delivery-control-identity-incomplete'
    )
    if (preRemoteSnapshot.repository !== repository ||
        preRemoteSnapshot.issueId !== issueId ||
        preRemoteSnapshot.defaultBranchSha !==
            defaultBranchSha ||
        !SHA.test(candidateSha ?? '') ||
        !SHA.test(defaultBranchSha ?? '')) {
        fail('delivery-control-prestate-mismatch')
    }
    for (const value of [
        rootControlLeaseDigest,
        terminalEvidenceDigest,
        expectedPostStateDigest
    ]) assertDigest(value,
        'delivery-control-evidence-incomplete')
    if (acceptanceGroupDigest !== null) {
        assertDigest(
            acceptanceGroupDigest,
            'delivery-control-evidence-incomplete'
        )
    }
    const intendedMutation = validateMutation(mutation)
    const issued = Date.parse(issuedAt)
    const expires = Date.parse(expiresAt)
    if (!Number.isFinite(issued) ||
        !Number.isFinite(expires) ||
        expires <= issued ||
        expires - issued >
            REMOTE_MUTATION_POLICY.authorizationTtlSeconds *
                1000) {
        fail('delivery-control-expiry-invalid')
    }
    const mutationDigest = digest(intendedMutation)
    return seal({
        schema:
            'issue-orchestration.delivery-control-receipt.v1',
        producerAuthority:
            REMOTE_MUTATION_POLICY.producerAuthority,
        policyDigest: REMOTE_MUTATION_POLICY_DIGEST,
        status: 'authorized',
        runId,
        deliveryEpoch,
        rootInvocationId:
            startupBinding.runtimeInvocationId,
        rootSessionId: startupBinding.runtimeSessionId,
        rootAuthorityEpoch:
            startupBinding.rootAuthorityEpoch,
        rootControlLeaseDigest,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeTrustBindingDigest:
            runtimeTrustBinding.bindingDigest,
        runtimeExecutionBindingDigest:
            runtimeExecutionBinding.bindingDigest,
        repository,
        issueId,
        candidateSha,
        defaultBranchSha,
        terminalEvidenceDigest,
        acceptanceGroupDigest,
        mutation: intendedMutation,
        mutationDigest,
        expectedPostStateDigest,
        preRemoteSnapshotDigest:
            preRemoteSnapshot.snapshotDigest,
        issuedAt,
        expiresAt,
        consumptionKey: digest({
            runId,
            deliveryEpoch,
            rootAuthorityEpoch:
                startupBinding.rootAuthorityEpoch,
            mutationDigest,
            preRemoteSnapshotDigest:
                preRemoteSnapshot.snapshotDigest
        })
    }, 'receiptDigest')
}

export function authorizeRemoteMutation({
    deliveryControlReceipt,
    runtimeExecutionBinding,
    currentRemoteSnapshot,
    now,
    consumedKeys = []
} = {}) {
    validateRemoteStateSnapshot(currentRemoteSnapshot)
    if (deliveryControlReceipt?.schema !==
            'issue-orchestration.delivery-control-receipt.v1' ||
        deliveryControlReceipt.producerAuthority !==
            REMOTE_MUTATION_POLICY.producerAuthority ||
        deliveryControlReceipt.policyDigest !==
            REMOTE_MUTATION_POLICY_DIGEST ||
        deliveryControlReceipt.status !== 'authorized' ||
        deliveryControlReceipt.receiptDigest !==
            unsignedDigest(
                deliveryControlReceipt,
                'receiptDigest'
            ) ||
        runtimeExecutionBinding?.executionClass !== 'root-control' ||
        runtimeExecutionBinding.bindingDigest !==
            deliveryControlReceipt
                .runtimeExecutionBindingDigest ||
        runtimeExecutionBinding.actorInvocationId !==
            deliveryControlReceipt.rootInvocationId ||
        currentRemoteSnapshot.snapshotDigest !==
            deliveryControlReceipt.preRemoteSnapshotDigest ||
        Date.parse(now) > Date.parse(
            deliveryControlReceipt.expiresAt
        ) ||
        consumedKeys.includes(
            deliveryControlReceipt.consumptionKey
        )) {
        fail('remote-mutation-authorization-invalid-or-stale')
    }
    return Object.freeze({
        status: 'authorized',
        mutation:
            structuredClone(deliveryControlReceipt.mutation),
        consumptionKey:
            deliveryControlReceipt.consumptionKey
    })
}

export function observeRemoteMutation({
    actorExecutionClass,
    actorInvocationId,
    mutation,
    preRemoteSnapshot,
    postRemoteSnapshot,
    observedPostStateDigest,
    deliveryControlReceipt = null,
    observedAt
} = {}) {
    validateRemoteStateSnapshot(preRemoteSnapshot)
    validateRemoteStateSnapshot(postRemoteSnapshot)
    const mutationDigest = digest(mutation)
    assertText(
        actorInvocationId,
        'remote-mutation-actor-unobservable'
    )
    assertDigest(
        observedPostStateDigest,
        'remote-mutation-poststate-unobservable'
    )
    const violations = []
    if (!['root-control', 'observe-only', 'leased-writer']
        .includes(actorExecutionClass)) {
        violations.push('remote-mutation-actor-class-invalid')
    }
    if (actorExecutionClass !== 'root-control') {
        violations.push('child-actor-remote-mutation')
    } else if (deliveryControlReceipt?.receiptDigest !==
            unsignedDigest(
                deliveryControlReceipt ?? {},
                'receiptDigest'
            ) ||
        deliveryControlReceipt.mutationDigest !==
            mutationDigest ||
        deliveryControlReceipt.rootInvocationId !==
            actorInvocationId ||
        deliveryControlReceipt.preRemoteSnapshotDigest !==
            preRemoteSnapshot.snapshotDigest) {
        violations.push('root-remote-mutation-unauthorized')
    }
    const expectedPostStateDigest =
        deliveryControlReceipt?.expectedPostStateDigest ??
        digest('unauthorized-expected-post-state')
    if (actorExecutionClass === 'root-control' &&
        observedPostStateDigest !== expectedPostStateDigest) {
        violations.push('remote-mutation-poststate-mismatch')
    }
    const uniqueViolations = [...new Set(violations)].sort()
    return seal({
        schema:
            'issue-orchestration.remote-mutation-receipt.v1',
        producerAuthority:
            REMOTE_MUTATION_POLICY.producerAuthority,
        policyDigest: REMOTE_MUTATION_POLICY_DIGEST,
        status: uniqueViolations.length === 0
            ? 'verified'
            : 'rejected',
        actorExecutionClass,
        actorInvocationId,
        deliveryControlReceiptDigest:
            deliveryControlReceipt?.receiptDigest ?? null,
        mutationDigest,
        preRemoteSnapshotDigest:
            preRemoteSnapshot.snapshotDigest,
        postRemoteSnapshotDigest:
            postRemoteSnapshot.snapshotDigest,
        expectedPostStateDigest,
        observedPostStateDigest,
        mutationPostconditionEvidenceClass:
            'root-control-remote-mutation-postcondition',
        violationCodes: uniqueViolations,
        disposition: uniqueViolations.length === 0
            ? 'accept'
            : actorExecutionClass === 'root-control'
                ? 'invalidate-attempt'
                : 'run-fatal',
        observedAt
    }, 'receiptDigest')
}
