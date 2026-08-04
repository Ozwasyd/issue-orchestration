import fs from 'node:fs'

import {
    digest,
    seal
} from '../../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'

function routeActor({ routeDecision, actorId }) {
    return {
        actorId,
        actorRole: routeDecision.stageRole,
        role: routeDecision.stageRole,
        stagePhase: routeDecision.stagePhase,
        phase: routeDecision.stagePhase,
        routeDecision,
        executionRouteDecision: routeDecision,
        routeDecisionDigest: routeDecision.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            routeDecision.runtimeExecutionBindingDigest,
        executionClass: routeDecision.executionClass,
        mutationContract: 'no-protected-mutation',
        writeScope: 'none',
        freshContext: true,
        proposalOnly: true,
        mutationPostconditionReceiptDigest:
            digest(`${actorId}:actor-observed-postcondition`)
    }
}

function semantic({ routeDecision, request, actorId }) {
    const actorRuntime = routeActor({ routeDecision, actorId })
    const classifications = request.normativeBlocks.map((block) => ({
        sourceIdentity: block.sourceIdentity,
        sourceSpanDigest: block.spanDigest,
        classification: block.sourceKind === 'body'
            ? 'acceptance'
            : block.sourceKind === 'comment'
                ? 'constraint'
                : 'context',
        contextReason: block.sourceKind === 'title'
            ? 'Title names the bounded objective.'
            : null,
        ownerRepository: request.repository,
        affectedStageClasses: ['test-contract'],
        aliases: []
    }))
    return {
        semanticProposal: seal({
            schema:
                'issue-orchestration.issue-requirement-inventory-proposal.v1',
            actorRole: 'dag-creator-updater',
            rootAuthored: false,
            repository: request.repository,
            issueNumber: request.issueNumber,
            selectorReceiptDigest: request.selectorReceiptDigest,
            remoteSnapshotDigest: request.remoteSnapshotDigest,
            classifications,
            actorRuntime
        }, 'proposalDigest')
    }
}

function planning({ routeDecision, request, actorId }) {
    const planningRequest = request.planningRequest
    const acceptance = request.acceptanceContract
    const actor = routeActor({ routeDecision, actorId })
    const testPath = 'tests/prewriter-stage.test.mjs'
    const command = `node --test ${testPath}`
    const sliceProposal = seal({
        schema: 'issue-orchestration.slice-plan-proposal.v1',
        proposalAuthoredBy: 'test-owner:test-contract-planning',
        rootAuthored: false,
        acceptanceContractDigest: acceptance.contractDigest,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        objective: 'Write the frozen test contract for the selected issue',
        allowedPaths: [testPath],
        forbiddenPaths: ['skills/', 'src/'],
        requiredCommands: [command],
        requiredEvidence: ['test-output'],
        orderedSlices: [{
            sliceId: 'test-contract-slice-1',
            objective: 'Create the deterministic test contract',
            acceptanceIds: [...acceptance.executableAcceptanceIds],
            allowedPaths: [testPath],
            firstRequiredAction: `write:${testPath}`,
            firstReadTargets: [testPath],
            firstWritablePath: testPath,
            explicitReadOnlyOutput: null,
            requiredCreatedOrModifiedFiles: [testPath],
            requiredCommands: [command],
            requiredEvidence: ['test-output'],
            explicitNonGoals: ['do-not-edit-production-code'],
            expectedFailureOrProgressSignal: 'test file exists',
            maxChangedFiles: 1,
            maxOwnedModules: 1,
            maxReadOnlyOperationsBeforeCheckpoint: 8,
            maxNoArtifactToolCalls: 4,
            maxNoArtifactActiveDurationClass: 'short',
            safeCheckpointKind: 'stage-progress'
        }],
        sliceDependencyGraph: {
            'test-contract-slice-1': []
        },
        planningAttemptId: planningRequest.attemptId,
        routeDecisionDigest: planningRequest.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            planningRequest.runtimeExecutionBindingDigest,
        mutationPostconditionReceiptDigest:
            actor.mutationPostconditionReceiptDigest,
        actorRuntime: actor
    }, 'proposalDigest')
    const planningReceipt = seal({
        schema: 'issue-orchestration.test-contract-plan-receipt.v1',
        status: 'verified',
        rootAuthored: false,
        attemptId: planningRequest.attemptId,
        acceptanceContractDigest: acceptance.contractDigest,
        nodeDiscoveredReceiptDigest:
            planningRequest.nodeDiscoveredReceiptDigest,
        requestDigest: planningRequest.requestDigest,
        routeDecisionDigest: planningRequest.routeDecisionDigest,
        ownerRepository: request.repository,
        testPaths: [testPath],
        commands: [command],
        fixturePaths: [],
        runtimeProbes: [],
        stageBoundaries: ['tests-only'],
        sliceProposalDigest: sliceProposal.proposalDigest,
        filesystemWrites: [],
        disputedAuthority: null,
        ...actor
    }, 'receiptDigest')
    const investigationReceipt = seal({
        schema:
            'issue-orchestration.test-planning-investigation-receipt.v1',
        status: 'verified',
        actorRole: 'test-owner',
        phase: 'test-contract-planning',
        rootAuthored: false,
        attemptId: planningRequest.attemptId,
        requestDigest: planningRequest.requestDigest,
        sourceFingerprint: request.sourceFingerprint,
        acceptanceContractDigest: acceptance.contractDigest,
        routeDecisionDigest: planningRequest.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            planningRequest.runtimeExecutionBindingDigest,
        mutationPostconditionReceiptDigest:
            actor.mutationPostconditionReceiptDigest
    }, 'receiptDigest')
    const repositoryEvidence = {
        repository: request.repository,
        testPaths: [testPath],
        commands: [command],
        sourceFingerprint: request.sourceFingerprint
    }
    const dispatchInvestigation = seal({
        schema: 'issue-orchestration.dispatch-investigation.v1',
        status: 'complete',
        rootAuthored: false,
        actorRole: 'test-owner',
        attemptId: planningRequest.attemptId,
        confirmedOwner: request.repository,
        baseSha: request.baseSha,
        sourceFingerprint: request.sourceFingerprint,
        repositoryEvidence,
        repositoryEvidenceDigest: digest(repositoryEvidence)
    }, 'receiptDigest')
    return {
        planningReceipt,
        investigationReceipt,
        sliceProposal,
        dispatchInvestigation
    }
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const output = input.stagePhase === 'semantic-proposal'
    ? semantic(input)
    : input.stagePhase === 'test-contract-planning'
        ? planning(input)
        : (() => { throw new Error('unsupported actor phase') })()
process.stdout.write(JSON.stringify(output))
