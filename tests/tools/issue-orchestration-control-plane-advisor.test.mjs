import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    CONTROL_PLANE_ADVISOR_POLICY,
    compileAdvisorRuntimeBinding,
    compileControlPlaneAdvisorRequest,
    compileControlPlaneRecoveryPlan,
    compileUnresolvedControlPlaneReceipt,
    executeControlPlaneRecoveryAction,
    sealControlPlaneRecoveryProposal
} from '../../skills/issue-orchestration/scripts/control-plane-advisor.mjs'
import {
    STAGE_MUTATION_GUARD_POLICY_DIGEST
} from '../../skills/issue-orchestration/scripts/stage-runtime-guard.mjs'
import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
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

function sealed(value, field) {
    return seal(value, field)
}

function advisorFixture(overrides = {}) {
    const startup = verifiedRuntimeStartup({
        invocationId: 'advisor-root-invocation',
        sessionId: 'advisor-root-session'
    })
    const failureDigest = digest('complex-control-plane-failure')
    const unresolved = compileUnresolvedControlPlaneReceipt({
        runId: 'run-advisor-1',
        failureDomain: 'orchestration-control-plane',
        failureDigest,
        failureEventDigest: digest('failure-event'),
        classifierEvidenceDigest: digest('classifier'),
        unresolvedReasonCode: 'unknown-control-plane-anomaly',
        deterministicHandlersExhausted: true,
        boundedScopeDigest: digest('bounded-scope')
    })
    const capabilityEvidence = sealed({
        schema:
            'issue-orchestration.advisor-route-cell-evidence.v1',
        producerAuthority:
            'canonical-route-cell-compiler',
        capabilityClass: 'frontier-control-plane-advisor',
        routeCellId:
            CONTROL_PLANE_ADVISOR_POLICY.routeCellId,
        requiredProfile:
            CONTROL_PLANE_ADVISOR_POLICY.requiredProfile,
        reviewedAssumptionDigest:
            CONTROL_PLANE_ADVISOR_POLICY
                .reviewedAssumptionDigest
    }, 'evidenceDigest')
    const runtimeAvailability = sealed({
        schema:
            'issue-orchestration.advisor-runtime-availability.v1',
        producerAuthority: 'runtime-capability-registry',
        profiles: {
            'sol-max': {
                available: overrides.solMaxAvailable !== false
            },
            'sol-xhigh': {
                available: true
            }
        }
    }, 'observationDigest')
    const slotReservation = sealed({
        schema:
            'issue-orchestration.advisor-slot-reservation.v1',
        producerAuthority: 'machine-capacity-controller',
        status: 'reserved',
        failureDigest,
        slotId: 'slot-15',
        capacityBefore: 1,
        capacityAfter: 0
    }, 'receiptDigest')
    const affectedTargets = [{
        identity: 'member:ExampleOrg/RepositoryA#1901',
        currentDigest: digest('member-current')
    }]
    const presumedValidEvidenceDigests = [digest('valid-evidence')]
    const suspectedInvalidEvidenceDigests = [
        digest('suspected-evidence')
    ]
    const request = compileControlPlaneAdvisorRequest({
        runId: unresolved.runId,
        startup,
        failureDigest,
        unresolvedControlPlaneReceipt: unresolved,
        consultedFailureDigests:
            overrides.consultedFailureDigests ?? [],
        affectedTargets,
        boundedProjection: {
            actorDigests: [digest('actor')],
            slotDigests: [digest('slot')],
            leaseDigests: [digest('lease')],
            resourceDigests: [digest('resource')],
            checkpointDigests: [digest('checkpoint')],
            continuationDigests: [digest('continuation')],
            routeDigests: [digest('route')],
            breakerDigests: [digest('breaker')],
            receiptDigests: [digest('receipt')],
            baseSha: 'a'.repeat(40),
            epochId: 'epoch-advisor-1',
            candidateDigest: digest('candidate'),
            remoteSnapshotDigest: digest('remote')
        },
        presumedValidEvidenceDigests,
        suspectedInvalidEvidenceDigests,
        capabilityEvidence,
        runtimeAvailability,
        slotReservation,
        diagnosticQuestions: [
            'Which frozen control invariant first diverged?'
        ],
        fullHistoryIncluded: false,
        unrelatedHistoryIncluded: false,
        writableStateRootPathIncluded: false,
        rootPreferredConclusionIncluded:
            overrides.rootPreferredConclusionIncluded ?? false
    })
    const runtimeObservation = sealed({
        schema:
            'issue-orchestration.control-plane-advisor-runtime-observation.v1',
        producerAuthority: 'runtime-owned',
        requestDigest: request.requestDigest,
        rootInvocationId: request.rootInvocationId,
        advisorInvocationId: 'advisor-invocation-1',
        advisorSessionId: 'advisor-session-1',
        selectedProfile: 'sol-max',
        effectiveProfile: 'sol-max',
        effectiveModel: 'gpt-5.6-sol',
        effectiveEffort: 'max',
        effectiveMultiAgentBackend: 'v2',
        executionClass: 'observe-only',
        freshContext: true,
        forkTurns: '3',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition'
    }, 'observationDigest')
    const runtimeBinding = compileAdvisorRuntimeBinding({
        request,
        runtimeObservation
    })
    const payload = {
        requestDigest: request.requestDigest,
        failureDigest,
        rootInvocationId: request.rootInvocationId,
        startupAttestationDigest:
            request.startupAttestationDigest,
        policySetDigest: request.policySetDigest,
        recommendationKind: 'bounded-recovery',
        failureClassification: 'stale-member-projection',
        classificationEvidenceDigests: [digest('classification')],
        rootCause: 'The member projection predates the current checkpoint.',
        preserveEvidenceDigests: [...presumedValidEvidenceDigests],
        invalidateEvidence: [{
            digest: suspectedInvalidEvidenceDigests[0],
            reasonCode: 'checkpoint-projection-stale'
        }],
        actions: [{
            kind: 'rebuild-member-projection',
            targetIdentity: affectedTargets[0].identity,
            currentDigest: affectedTargets[0].currentDigest,
            preconditions: [affectedTargets[0].currentDigest],
            postconditions: [digest('projection-rebuilt')],
            failureDisposition: 'terminalize-member',
            requiredRevalidationGates: [
                'breaker',
                'mutation-postcondition'
            ]
        }],
        requiredRevalidationGates: [
            'breaker',
            'mutation-postcondition'
        ],
        abortConditions: ['target-digest-drift'],
        terminalConditions: ['projection-remains-invalid'],
        unresolvedFacts: []
    }
    const mutationPostconditionReceipt = sealed({
        schema:
            'issue-orchestration.stage-mutation-postcondition-receipt.v1',
        producerAuthority: 'machine-stage-runtime-guard',
        policyDigest: STAGE_MUTATION_GUARD_POLICY_DIGEST,
        status: 'verified',
        runId: request.runId,
        actorInvocationId:
            runtimeBinding.advisorInvocationId,
        actorSessionId: runtimeBinding.advisorSessionId,
        attemptId: 'advisor-attempt-1',
        stageRole: 'control-plane-advisor',
        stagePhase: 'recovery-proposal',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        runtimeExecutionBindingDigest:
            runtimeBinding.bindingDigest,
        preSnapshotDigest: digest('pre'),
        postSnapshotDigest: digest('post'),
        routeDecisionDigest: digest('advisor-route'),
        compiledPromptDigest: digest('advisor-prompt'),
        resourceIdentityDigest: digest('advisor-resource'),
        baseSha: 'a'.repeat(40),
        deliveryEpoch: 'epoch-advisor-1',
        candidateIdentity: 'a'.repeat(40),
        candidateDigest: digest('advisor-candidate'),
        leaseDigest: null,
        sliceDigest: null,
        allowedPathsDigest: digest([]),
        changedPaths: [],
        changedPathsDigest: digest([]),
        stateRootChanged: false,
        remoteSnapshotChanged: false,
        prohibitedReceiptEmitted: false,
        outputClass: 'proposal',
        outputDigest: digest(payload),
        violationCodes: [],
        recoveryDisposition: 'accept'
    }, 'receiptDigest')
    return {
        startup,
        failureDigest,
        unresolved,
        capabilityEvidence,
        runtimeAvailability,
        slotReservation,
        request,
        runtimeObservation,
        runtimeBinding,
        payload,
        mutationPostconditionReceipt
    }
}

test('one exact route-cell observe-only advisor compiles and low root executes exactly', () => {
    const fixture = advisorFixture()
    assert.equal(fixture.request.selectedProfile, 'sol-max')
    assert.equal(fixture.request.executionClass, 'observe-only')
    const proposal = sealControlPlaneRecoveryProposal({
        request: fixture.request,
        advisorRuntimeBinding: fixture.runtimeBinding,
        mutationPostconditionReceipt:
            fixture.mutationPostconditionReceipt,
        payload: fixture.payload
    })
    const plan = compileControlPlaneRecoveryPlan({
        request: fixture.request,
        proposal,
        consultedFailureDigests: [fixture.failureDigest]
    })
    const receipt = executeControlPlaneRecoveryAction({
        plan,
        startup: fixture.startup,
        action: plan.actions[0],
        previousActionReceipts: [],
        observedPostStateDigest:
            plan.actions[0].postconditions[0],
        executedAt: '2026-08-03T05:00:00.000Z'
    })
    assert.equal(receipt.status, 'completed')
    assert.equal(
        receipt.executedByRootInvocationId,
        fixture.request.rootInvocationId
    )
    for (const [value, name] of [
        [CONTROL_PLANE_ADVISOR_POLICY,
            'control-plane-advisor-policy.schema.json'],
        [fixture.unresolved,
            'unresolved-control-plane-receipt.schema.json'],
        [fixture.request,
            'control-plane-advisor-request.schema.json'],
        [proposal,
            'control-plane-recovery-proposal.schema.json'],
        [plan,
            'control-plane-recovery-plan.schema.json']
    ]) {
        assert.deepEqual(
            validateJsonSchema(value, schema(name)),
            [],
            name
        )
    }
})

test('same failure cannot consult twice and unqualified fallback is impossible', () => {
    assert.throws(() => advisorFixture({
        consultedFailureDigests: [
            digest('complex-control-plane-failure')
        ]
    }), { code: 'advisor-eligibility-invalid' })
    assert.throws(() => advisorFixture({
        solMaxAvailable: false
    }), { code: 'advisor-qualified-profile-unavailable' })
})

test('unbounded request and root-authored preferred conclusion are rejected', () => {
    assert.throws(() => advisorFixture({
        rootPreferredConclusionIncluded: true
    }), { code: 'advisor-request-unbounded' })
    const fixture = advisorFixture()
    assert.throws(() => compileControlPlaneAdvisorRequest({
        runId: fixture.request.runId,
        startup: fixture.startup,
        failureDigest: fixture.failureDigest,
        unresolvedControlPlaneReceipt: fixture.unresolved,
        consultedFailureDigests: [],
        affectedTargets: fixture.request.affectedTargets,
        boundedProjection: {
            ...fixture.request.boundedProjection,
            fullDag: { unrestricted: true }
        },
        presumedValidEvidenceDigests:
            fixture.request.presumedValidEvidenceDigests,
        suspectedInvalidEvidenceDigests:
            fixture.request.suspectedInvalidEvidenceDigests,
        capabilityEvidence: fixture.capabilityEvidence,
        runtimeAvailability: fixture.runtimeAvailability,
        slotReservation: fixture.slotReservation,
        diagnosticQuestions: ['Inspect everything'],
        fullHistoryIncluded: false,
        unrelatedHistoryIncluded: false,
        writableStateRootPathIncluded: false,
        rootPreferredConclusionIncluded: false
    }), { code: 'advisor-request-unbounded' })
})

test('unknown, remote, gate-bypass and unrelated invalidation proposals fail', () => {
    for (const mutate of [
        (payload) => {
            payload.actions[0].kind = 'shell-command'
        },
        (payload) => {
            payload.actions[0].kind = 'force-remote-mutation'
        },
        (payload) => {
            payload.actions[0].requiredRevalidationGates =
                ['bypass-delivery']
            payload.requiredRevalidationGates =
                ['bypass-delivery']
        },
        (payload) => {
            payload.invalidateEvidence[0].digest =
                digest('unrelated-valid-evidence')
        }
    ]) {
        const fixture = advisorFixture()
        const payload = structuredClone(fixture.payload)
        mutate(payload)
        const guard = structuredClone(
            fixture.mutationPostconditionReceipt
        )
        guard.outputDigest = digest(payload)
        delete guard.receiptDigest
        guard.receiptDigest = digest(guard)
        assert.throws(() => sealControlPlaneRecoveryProposal({
            request: fixture.request,
            advisorRuntimeBinding: fixture.runtimeBinding,
            mutationPostconditionReceipt: guard,
            payload
        }))
    }
})

test('failed mutation postcondition and replayed invocation reject proposal', () => {
    const fixture = advisorFixture()
    const failed = structuredClone(
        fixture.mutationPostconditionReceipt
    )
    failed.status = 'rejected'
    failed.violationCodes = ['observe-only-repository-mutation']
    failed.recoveryDisposition = 'quarantine-attempt'
    delete failed.receiptDigest
    failed.receiptDigest = digest(failed)
    assert.throws(() => sealControlPlaneRecoveryProposal({
        request: fixture.request,
        advisorRuntimeBinding: fixture.runtimeBinding,
        mutationPostconditionReceipt: failed,
        payload: fixture.payload
    }), {
        code: 'stage-mutation-postcondition-receipt-invalid'
    })

    const replayPayload = structuredClone(fixture.payload)
    replayPayload.rootInvocationId = 'other-root'
    const replayGuard = structuredClone(
        fixture.mutationPostconditionReceipt
    )
    replayGuard.outputDigest = digest(replayPayload)
    delete replayGuard.receiptDigest
    replayGuard.receiptDigest = digest(replayGuard)
    assert.throws(() => sealControlPlaneRecoveryProposal({
        request: fixture.request,
        advisorRuntimeBinding: fixture.runtimeBinding,
        mutationPostconditionReceipt: replayGuard,
        payload: replayPayload
    }), { code: 'advisor-proposal-binding-invalid' })
})

test('root cannot edit, reorder or omit compiled actions', () => {
    const fixture = advisorFixture()
    const proposal = sealControlPlaneRecoveryProposal({
        request: fixture.request,
        advisorRuntimeBinding: fixture.runtimeBinding,
        mutationPostconditionReceipt:
            fixture.mutationPostconditionReceipt,
        payload: fixture.payload
    })
    const plan = compileControlPlaneRecoveryPlan({
        request: fixture.request,
        proposal
    })
    const edited = structuredClone(plan.actions[0])
    edited.targetIdentity = 'different-target'
    assert.throws(() => executeControlPlaneRecoveryAction({
        plan,
        startup: fixture.startup,
        action: edited,
        previousActionReceipts: [],
        observedPostStateDigest:
            plan.actions[0].postconditions[0],
        executedAt: '2026-08-03T05:00:00.000Z'
    }), {
        code: 'advisor-plan-action-order-or-content-mismatch'
    })
})
