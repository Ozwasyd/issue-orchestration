import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    ROOT_TAKEOVER_POLICY,
    authorizeRecoveryRootLaunch,
    compileRootRecoveryHandoff,
    compileRootTakeoverAuthorization,
    compileRootTakeoverEligibility,
    completeRecoveryTakeover,
    fenceOldRoot,
    rejectFencedOldRootAction,
    terminalizeRecoveryTakeover
} from '../../skills/issue-orchestration/scripts/root-takeover-supervisor.mjs'
import {
    attestRuntimeStartup,
    compileRuntimeStartupObservation,
    currentRuntimeStartupAuthority
} from '../../skills/issue-orchestration/scripts/runtime-startup-attestation.mjs'
import {
    compileStageRoute
} from '../../skills/issue-orchestration/scripts/stage-profile-policy.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    runtimeStartupRecords,
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)

function schema(name) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', name),
        'utf8'
    ))
}

function classification() {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'Ozwasyd/FsusBlog',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('route-evidence'),
        routingPolicyVersion: 'stage-model-pool.v3'
    }
}

function takeoverFixture() {
    const authority = currentRuntimeStartupAuthority()
    const oldStartup = verifiedRuntimeStartup({
        invocationId: 'old-root-invocation',
        sessionId: 'old-root-session'
    })
    const eligibility = compileRootTakeoverEligibility({
        runId: 'run-takeover-1',
        oldRootInvocationId: 'old-root-invocation',
        oldRootSessionId: 'old-root-session',
        reasonCode: 'root-heartbeat-expired',
        directEvidenceDigest: digest('heartbeat-evidence'),
        failureProjectionDigest: digest('failure-projection'),
        advisorDisposition: 'not-applicable-root-unavailable',
        advisorEvidenceDigest: null,
        lowerCostRecoveryExhausted: true,
        issuedAt: '2026-08-03T04:00:00.000Z'
    })
    const authorization = compileRootTakeoverAuthorization({
        eligibilityReceipt: eligibility,
        runId: eligibility.runId,
        oldRootInvocationId: eligibility.oldRootInvocationId,
        oldRootSessionId: eligibility.oldRootSessionId,
        oldRootAuthorityEpoch:
            oldStartup.attestation.rootAuthorityEpoch,
        oldRootControlLeaseDigest:
            digest('old-root-control-lease'),
        oldRootStartupAttestationDigest:
            oldStartup.attestation.attestationDigest,
        expectedNewInvocationId: 'new-root-invocation',
        newRootAuthorityEpoch: 'root-authority-epoch-2',
        reasonCode: eligibility.reasonCode,
        directEvidenceDigest: eligibility.directEvidenceDigest,
        advisorRequestDigest: null,
        advisorProposalDigest: null,
        recoveryPlanDigest: null,
        deterministicRecoveryDisposition:
            eligibility.advisorDisposition,
        packageDigest: authority.packageDigest,
        policySetDigest: digest(authority.policyDigests),
        stateRootDigest: digest('state-root'),
        checkpointIdentityDigest: digest('checkpoint'),
        repositoryStateDigest: digest('repository-state'),
        baseSha: 'a'.repeat(40),
        deliveryEpoch: 'delivery-epoch-1',
        remoteSnapshotDigest: digest('remote-snapshot'),
        activeInventoryDigest: digest('active-inventory'),
        requiredDispositionDigest:
            digest('required-disposition'),
        fencingRequirementsDigest:
            digest(ROOT_TAKEOVER_POLICY.fencingCoverage),
        issuedAt: '2026-08-03T04:00:01.000Z',
        expiresAt: '2026-08-03T04:05:01.000Z'
    })
    const fencingReceipt = fenceOldRoot({
        authorization,
        oldRootProcessDisposition: 'machine-fenced',
        oldRootLeaseStatus: 'revoked',
        activeActorInventoryDigest:
            digest('active-actor-inventory'),
        activeResourceInventoryDigest:
            digest('active-resource-inventory'),
        inventoryDispositionDigest:
            digest('inventory-disposition'),
        observedFencingCoverage:
            ROOT_TAKEOVER_POLICY.fencingCoverage,
        fencedAt: '2026-08-03T04:00:02.000Z'
    })
    const handoff = compileRootRecoveryHandoff({
        authorization,
        fencingReceipt,
        stateRootDigest: authorization.stateRootDigest,
        ledgerDigest: digest('ledger'),
        dagDigest: digest('dag'),
        checkpointDigest:
            authorization.checkpointIdentityDigest,
        rootCursorDigest: digest('root-cursor'),
        activeInventoryDigest:
            authorization.activeInventoryDigest,
        evidenceSetDigest: digest('evidence-set'),
        repositoryStateDigest:
            authorization.repositoryStateDigest,
        remoteSnapshotDigest:
            authorization.remoteSnapshotDigest,
        advisorRecoveryChainDigest: null
    })
    const launchReceipt = authorizeRecoveryRootLaunch({
        authorization,
        fencingReceipt,
        handoff,
        launchedAt: '2026-08-03T04:00:03.000Z'
    })
    const observation = compileRuntimeStartupObservation(
        runtimeStartupRecords({
            profile: 'terra-medium',
            invocationId: 'new-root-invocation',
            sessionId: 'new-root-session',
            observedAt: '2026-08-03T04:00:04.000Z',
            authority
        })
    )
    const takeoverContext = {
        authorization,
        fencingReceipt,
        handoff
    }
    const attestation = attestRuntimeStartup({
        observation,
        takeoverContext,
        attestedAt: '2026-08-03T04:00:05.000Z'
    })
    const startup = {
        observation,
        attestation,
        takeoverContext
    }
    return {
        authority,
        oldStartup,
        eligibility,
        authorization,
        fencingReceipt,
        handoff,
        launchReceipt,
        startup
    }
}

test('normal and recovery root phases are disjoint route identities', () => {
    const normal = compileStageRoute({
        ...classification(),
        stageRole: 'root-scheduler',
        stagePhase: 'scheduling'
    })
    assert.deepEqual(normal.allowedProfiles, ['terra-low'])
    assert.equal(normal.selectedProfile, 'terra-low')
    assert.throws(() => compileStageRoute({
        ...classification(),
        stageRole: 'root-scheduler',
        stagePhase: 'scheduling',
        controlPlaneRecovery: true
    }), { code: 'routing-root-in-session-upgrade-forbidden' })
    const recovery = compileStageRoute({
        ...classification(),
        stageRole: 'root-scheduler',
        stagePhase: 'recovery-takeover',
        newParentInvocation: true,
        takeoverAuthorizationDigest: digest('authorization'),
        recoveryHandoffDigest: digest('handoff'),
        oldRootFencingReceiptDigest: digest('fencing')
    })
    assert.deepEqual(recovery.allowedProfiles, ['terra-medium'])
    assert.equal(recovery.selectedProfile, 'terra-medium')
    assert.notEqual(
        recovery.routingInputDigest,
        normal.routingInputDigest
    )
})

test('supervisor completes one fenced fresh-parent takeover with all schemas', () => {
    const fixture = takeoverFixture()
    assert.equal(fixture.startup.attestation.status, 'verified')
    const revalidationReceiptDigests = Object.fromEntries(
        ROOT_TAKEOVER_POLICY.requiredRevalidationGates
            .map((gate) => [gate, digest(`revalidated:${gate}`)])
    )
    const completion = completeRecoveryTakeover({
        ...fixture,
        rootControlLeaseDigest: digest('new-root-control-lease'),
        activeRootLeaseCount: 1,
        revalidationReceiptDigests,
        activeInventoryDigest:
            fixture.handoff.activeInventoryDigest,
        resultingState: 'valid-scheduling',
        completedAt: '2026-08-03T04:00:06.000Z'
    })
    assert.equal(completion.status, 'completed')
    for (const [value, name] of [
        [ROOT_TAKEOVER_POLICY,
            'root-takeover-policy.schema.json'],
        [fixture.eligibility,
            'root-takeover-eligibility-receipt.schema.json'],
        [fixture.authorization,
            'root-takeover-authorization.schema.json'],
        [fixture.fencingReceipt,
            'root-fencing-receipt.schema.json'],
        [fixture.handoff,
            'root-recovery-handoff.schema.json'],
        [fixture.launchReceipt,
            'root-recovery-launch-receipt.schema.json'],
        [completion,
            'root-takeover-completion-receipt.schema.json']
    ]) {
        assert.deepEqual(
            validateJsonSchema(value, schema(name)),
            [],
            name
        )
    }
})

test('ordinary member difficulty and live old lease cannot authorize takeover', () => {
    assert.throws(() => compileRootTakeoverEligibility({
        runId: 'run',
        oldRootInvocationId: 'old',
        oldRootSessionId: 'session',
        reasonCode: 'writer-failure',
        directEvidenceDigest: digest('direct'),
        failureProjectionDigest: digest('failure'),
        advisorDisposition: 'deterministic-handler-exhausted',
        lowerCostRecoveryExhausted: true,
        issuedAt: '2026-08-03T04:00:00.000Z'
    }), { code: 'root-takeover-ineligible' })

    const fixture = takeoverFixture()
    assert.throws(() => fenceOldRoot({
        authorization: fixture.authorization,
        oldRootProcessDisposition: 'machine-fenced',
        oldRootLeaseStatus: 'active',
        activeActorInventoryDigest: digest('actors'),
        activeResourceInventoryDigest: digest('resources'),
        inventoryDispositionDigest: digest('disposition'),
        observedFencingCoverage:
            ROOT_TAKEOVER_POLICY.fencingCoverage,
        fencedAt: '2026-08-03T04:00:02.000Z'
    }), { code: 'root-takeover-fencing-incomplete' })
})

test('authorization is one-shot and old root actions stay fenced', () => {
    const fixture = takeoverFixture()
    assert.throws(() => authorizeRecoveryRootLaunch({
        authorization: fixture.authorization,
        fencingReceipt: fixture.fencingReceipt,
        handoff: fixture.handoff,
        launchedAt: '2026-08-03T04:00:04.000Z',
        consumedAuthorizationDigests: [
            fixture.authorization.authorizationDigest
        ]
    }), {
        code: 'root-takeover-authorization-invalid-or-consumed'
    })
    assert.throws(() => rejectFencedOldRootAction({
        fencingReceipt: fixture.fencingReceipt,
        actorInvocationId:
            fixture.authorization.oldRootInvocationId,
        actorAuthorityEpoch:
            fixture.authorization.oldRootAuthorityEpoch
    }), { code: 'old-root-action-after-fencing' })
})

test('medium child or stale handoff cannot masquerade as recovery root', () => {
    const fixture = takeoverFixture()
    const childObservation = compileRuntimeStartupObservation(
        runtimeStartupRecords({
            profile: 'terra-medium',
            invocationId: 'medium-child-invocation',
            sessionId: 'medium-child-session',
            observedAt: '2026-08-03T04:00:04.000Z',
            authority: fixture.authority
        })
    )
    const childAttestation = attestRuntimeStartup({
        observation: childObservation,
        takeoverContext: fixture.startup.takeoverContext,
        attestedAt: '2026-08-03T04:00:05.000Z'
    })
    assert.equal(childAttestation.status, 'rejected')
    assert.ok(childAttestation.reasonCodes.includes(
        'runtime-startup-takeover-unverified'
    ))

    const stale = structuredClone(fixture.handoff)
    stale.remoteSnapshotDigest = digest('drifted-remote')
    delete stale.handoffDigest
    stale.handoffDigest = digest(stale)
    assert.throws(() => authorizeRecoveryRootLaunch({
        authorization: fixture.authorization,
        fencingReceipt: fixture.fencingReceipt,
        handoff: stale,
        launchedAt: '2026-08-03T04:00:03.000Z'
    }), { code: 'root-recovery-handoff-invalid' })
})

test('failed takeover terminalizes once without restart or low rollback', () => {
    const fixture = takeoverFixture()
    const terminal = terminalizeRecoveryTakeover({
        authorization: fixture.authorization,
        fencingReceipt: fixture.fencingReceipt,
        failureCode: 'new-root-startup-attestation-rejected',
        failureEvidenceDigest: digest('startup-failure'),
        failedNewInvocationId:
            fixture.authorization.expectedNewInvocationId,
        resourcesTerminalized: true,
        terminalizedAt: '2026-08-03T04:01:00.000Z'
    })
    assert.equal(terminal.status, 'recovery-takeover-terminal')
    assert.equal(terminal.automaticRestartAllowed, false)
    assert.equal(terminal.mediumToLowRollbackAllowed, false)
    assert.deepEqual(validateJsonSchema(
        terminal,
        schema('root-takeover-terminal-receipt.schema.json')
    ), [])
})
