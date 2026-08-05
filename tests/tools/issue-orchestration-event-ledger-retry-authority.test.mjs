import assert from 'node:assert/strict'
import test from 'node:test'

import {
    appendEventAtomic,
    canonicalEventLedgerLocation,
    recoverEventLedger
} from '../../skills/issue-orchestration/scripts/event-ledger.mjs'
import {
    authorizeWriterStageRetry,
    evaluateWriterStageObservation,
    sealSliceTerminalReceipt,
    sealWriterStageRetryRevisionEvidence
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    buildCanonicalWriterStageLedger,
    compileWriterStageTestArtifacts,
    createCanonicalWriterDispatchReceipt,
    createWriterStageGitFixture,
    sealCanonicalWriterLedgerEvent,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

const REPOSITORY = 'ExampleOrg/RepositoryA'
const ISSUE = 1874
const NODE = 'ExampleOrg/RepositoryA#1874:retry-carry'

function seal(value) {
    return {
        ...value,
        receiptDigest: writerTestDigest(value)
    }
}

function stagePayload(artifacts, sliceIndex) {
    return {
        transitionSchema: 'issue-orchestration.transition.v2',
        actorId: 'canonical-code-writer',
        stageWorkPlan: artifacts.stageWorkPlan,
        currentSlice: artifacts.executableSlices[sliceIndex],
        executableSlice: artifacts.executableSlices[sliceIndex],
        compiledPrompt: artifacts.compiledPrompts[sliceIndex]
    }
}

function dispatchReceipt(artifacts, sliceIndex) {
    if (sliceIndex === 0) {
        return createCanonicalWriterDispatchReceipt({ artifacts })
    }
    const plan = artifacts.stageWorkPlan
    const slice = artifacts.executableSlices[sliceIndex]
    const compiledPrompt = artifacts.compiledPrompts[sliceIndex]
    return seal({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId: `request-${plan.stageAttemptId}-${slice.sliceId}`,
        requestDigest: writerTestDigest({
            runId: plan.runId,
            node: plan.node,
            attemptId: plan.stageAttemptId,
            planDigest: plan.planDigest,
            sliceDigest: slice.sliceDigest
        }),
        runId: plan.runId,
        nodeId: plan.node,
        attemptId: plan.stageAttemptId,
        epochId: plan.epochId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        policyVersion: 'stage-model-pool.v4',
        routingPolicyDigest:
            writerTestDigest('canonical-retry-routing-policy'),
        routingInputDigest: plan.routingInputDigest,
        baseSha: plan.baseSha,
        candidateSha: plan.baseSha,
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        testContractDigest: plan.testContractDigest,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        resourceLeaseReceiptDigest:
            plan.resourceLeaseReceiptDigest,
        verificationStatus: 'verified',
        mismatchReasons: []
    })
}

function activeFailureObservation(artifacts, sliceIndex) {
    const plan = artifacts.stageWorkPlan
    const slice = artifacts.executableSlices[sliceIndex]
    const compiledPrompt = artifacts.compiledPrompts[sliceIndex]
    return {
        schema: 'issue-orchestration.writer-stage-observation.v1',
        runId: plan.runId,
        repository: plan.repository,
        issue: plan.issue,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        planDigest: plan.planDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest: plan.routingInputDigest,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        attemptId: plan.stageAttemptId,
        agentId: 'canonical-code-writer',
        firstRequiredActionExecuted: true,
        runtimeCapabilityObservation: {
            available: false,
            effectiveMetadataObserved: false,
            reason: 'runtime capability unavailable'
        },
        filesystemObservation: {
            createdFiles: [],
            modifiedFiles: [],
            treeDigest: writerTestDigest([])
        },
        gitObservation: {
            changedPaths: [],
            diffDigest: writerTestDigest([]),
            unauthorizedPaths: []
        },
        commandObservation: {
            commands: [],
            statuses: [],
            evidenceDigests: []
        },
        checkpoint: null,
        terminalReceipt: null
    }
}

function runtimeRevisionReceipt(artifacts, sliceIndex) {
    const plan = artifacts.stageWorkPlan
    const slice = artifacts.executableSlices[sliceIndex]
    const compiledPrompt = artifacts.compiledPrompts[sliceIndex]
    const runtimeMaterial = {
        runtimeMetadataDigest: writerTestDigest({
            status: 'verified-runtime-capability'
        }),
        actualModel: 'gpt-5.6-sol',
        actualEffort: 'ultra',
        actualRole: plan.stageRole,
        actualMode: 'work',
        actualSandbox: 'workspace-write',
        actualForkTurns: 'all',
        actualWorkingDirectory: plan.worktreeIdentity
    }
    return seal({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        verificationStatus: 'verified',
        runId: plan.runId,
        nodeId: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        planDigest: plan.planDigest,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        rolloutId: `rollout-${plan.stageAttemptId}`,
        threadId: `thread-${plan.stageAttemptId}`,
        ...runtimeMaterial
    })
}

function cleanupReceipt(failure) {
    return seal({
        schema: 'issue-orchestration.resource-cleanup-receipt.v1',
        actorRole: 'machine-resource-verifier',
        status: 'resources-clean',
        runId: failure.runId,
        attemptId: failure.attemptId,
        epochId: failure.epochId,
        baselineDigest: writerTestDigest('retry-cleanup-baseline'),
        ownedResourceDigest:
            writerTestDigest('retry-cleanup-owned-resources'),
        cleanupActions: [],
        lockReleaseObservations: [],
        finalFilesystemObservations: [],
        retainedResources: [],
        quarantinedResources: [],
        failedResources: [],
        postInventory: [],
        postCleanupInventoryDigest: writerTestDigest([]),
        verifiedAt: '2026-08-02T08:00:00.000Z'
    })
}

function completedChangedPaths(checkpoint, accepted = []) {
    return (checkpoint.evidence.git.worktreeStatus ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter((filePath) => !accepted.includes(filePath))
        .sort()
}

test('a failed second slice carries the immutable first-slice prefix into a fresh attempt and completes', async (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/retry-carry-one.mjs',
            'src/retry-carry-two.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const runId = `run-1874-retry-carry-${process.pid}`
    const common = {
        repository: REPOSITORY,
        issue: ISSUE,
        node: NODE,
        runId,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-retry-carry-1',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [...fixture.filePaths],
        requiredFiles: [...fixture.filePaths],
        requiredCommands: fixture.filePaths.map(
            (filePath) => `node --check ${filePath}`
        ),
        sliceId: 'slice-1874-retry-carry',
        sliceCount: 2
    }
    const canonical = await buildCanonicalWriterStageLedger({
        current,
        ...common,
        stageAttemptId: 'attempt-1874-retry-carry-old'
    })
    current.after(canonical.dispose)
    const oldArtifacts = canonical.artifacts
    const ledger = structuredClone(canonical.ledger)
    const location = canonicalEventLedgerLocation({
        runId,
        nodeId: NODE,
        stageAttemptId:
            oldArtifacts.stageWorkPlan.stageAttemptId
    })
    const append = async (event, stageAttemptId) => {
        const result = await appendEventAtomic({
            event,
            ledgerPath: location.ledgerPath,
            projectionPath: location.projectionPath,
            stateRoot: location.stateRoot,
            stageAttemptId,
            writerRole: 'root-scheduler'
        })
        ledger.events.push(event)
        return result.projection
    }
    const event = (input) =>
        sealCanonicalWriterLedgerEvent({
            ledger,
            ...input
        })

    await append(event({
        actorRole: 'code-implementer',
        attemptId: oldArtifacts.stageWorkPlan.stageAttemptId,
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        toState: 'implementing-self-testing',
        payload: {
            ...stagePayload(oldArtifacts, 0),
            dispatchReceipt: dispatchReceipt(oldArtifacts, 0),
            effort: 'ultra',
            model: 'gpt-5.6-sol'
        }
    }), oldArtifacts.stageWorkPlan.stageAttemptId)

    const oldSliceOneArtifacts = {
        ...oldArtifacts,
        executableSlice: oldArtifacts.executableSlices[0],
        compiledPrompt: oldArtifacts.compiledPrompts[0]
    }
    const firstProgress = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: oldSliceOneArtifacts,
        fixture,
        activateIndexes: [0],
        routeDigest:
            oldArtifacts.stageWorkPlan.routingInputDigest,
        status: 'complete'
    })
    const firstCheckpointPayload = {
        ...stagePayload(oldArtifacts, 0),
        checkpoint: firstProgress.checkpoint,
        checkpointVerificationReceipt:
            firstProgress.checkpointVerificationReceipt
    }
    await append(event({
        actorRole: 'code-implementer',
        attemptId: oldArtifacts.stageWorkPlan.stageAttemptId,
        eventType: 'writer-stage.checkpoint-recorded',
        fromState: 'implementing-self-testing',
        toState: 'implementing-self-testing',
        payload: firstCheckpointPayload
    }), oldArtifacts.stageWorkPlan.stageAttemptId)

    const firstChangedPaths =
        completedChangedPaths(firstProgress.checkpoint)
    const firstTerminal = sealSliceTerminalReceipt({
        plan: oldArtifacts.stageWorkPlan,
        slice: oldArtifacts.executableSlices[0],
        checkpoint: firstProgress.checkpoint,
        compiledPrompt: oldArtifacts.compiledPrompts[0],
        compiledPromptDigest:
            oldArtifacts.compiledPrompts[0].promptDigest,
        routeDigest:
            oldArtifacts.stageWorkPlan.routingInputDigest,
        checkpointVerificationReceipt:
            firstProgress.checkpointVerificationReceipt,
        sealedAuthority: canonical.anchors,
        priorTerminalReceipts: [],
        changedPaths: firstChangedPaths,
        commandEvidenceDigests:
            firstProgress.checkpoint.evidence.commands.map(
                ({ outputDigest }) => outputDigest
            )
    })
    const firstTerminalPayload = {
        ...stagePayload(oldArtifacts, 0),
        currentCheckpoint: firstProgress.checkpoint,
        checkpointVerificationReceipt:
            firstProgress.checkpointVerificationReceipt,
        terminalReceipt: firstTerminal,
        sliceTerminalReceipts: [firstTerminal],
        nextSlice: oldArtifacts.executableSlices[1],
        nextCompiledPrompt: oldArtifacts.compiledPrompts[1],
        nextDispatchReceipt: dispatchReceipt(oldArtifacts, 1)
    }
    await append(event({
        actorRole: 'code-implementer',
        attemptId: oldArtifacts.stageWorkPlan.stageAttemptId,
        eventType: 'writer-stage.slice-completed',
        fromState: 'implementing-self-testing',
        toState: 'implementing-self-testing',
        payload: firstTerminalPayload
    }), oldArtifacts.stageWorkPlan.stageAttemptId)

    const observation = activeFailureObservation(oldArtifacts, 1)
    const failure = evaluateWriterStageObservation(observation)
    assert.equal(
        failure.eventType,
        'writer-stage.runtime-capability-missing'
    )
    const failureEvent = event({
        actorRole: 'code-implementer',
        attemptId: oldArtifacts.stageWorkPlan.stageAttemptId,
        eventType: failure.eventType,
        fromState: 'implementing-self-testing',
        toState: 'terminal',
        payload: {
            ...stagePayload(oldArtifacts, 1),
            currentCheckpoint: null,
            writerStageObservation: observation,
            failureReceipt: failure.failureReceipt,
            countsAsImplementationRework: false,
            reworkCountDelta: 0,
            triggersHumanDecision: false
        }
    })
    const failureProjection = await append(
        failureEvent,
        oldArtifacts.stageWorkPlan.stageAttemptId
    )
    const completedPrefix = structuredClone(
        failureProjection.nodes[NODE].completedSlicePrefix
    )
    assert.equal(completedPrefix.length, 1)

    const newArtifacts = compileWriterStageTestArtifacts({
        ...common,
        stageAttemptId: 'attempt-1874-retry-carry-new'
    })
    const currentSlice = newArtifacts.executableSlices[1]
    const currentPrompt = newArtifacts.compiledPrompts[1]
    const authorityReceipt =
        runtimeRevisionReceipt(newArtifacts, 1)
    const proposed = {
        stageWorkPlan: newArtifacts.stageWorkPlan,
        executableSlice: currentSlice,
        compiledPrompt: currentPrompt,
        completedSlicePrefix: completedPrefix,
        authorityReceipt
    }
    const revisionEvidence =
        sealWriterStageRetryRevisionEvidence({
            priorFailure: failure.failureReceipt,
            sourceFailureEvent: failureEvent,
            proposed,
            revisionKind: 'runtime-revision',
            changedRequirementIds: [
                currentSlice.acceptanceItemIds[0]
            ],
            authorityReceipt
        })
    const cleanup = cleanupReceipt(failure.failureReceipt)
    const authorization = authorizeWriterStageRetry({
        priorFailure: failure.failureReceipt,
        proposed,
        revisions: [revisionEvidence],
        sourceFailureEvent: failureEvent,
        resourceCleanupReceipt: cleanup
    })
    assert.equal(
        authorization.authorized,
        true,
        authorization.reason
    )
    assert.equal(
        authorization.carryForwardPrefix.entries.length,
        1
    )
    assert.equal(
        authorization.carryForwardPrefix.entries[0]
            .previousTerminalReceiptDigest,
        firstTerminal.receiptDigest
    )
    assert.notEqual(
        newArtifacts.stageWorkPlan.activeWriteLeaseId,
        oldArtifacts.stageWorkPlan.activeWriteLeaseId
    )

    await append(event({
        actorRole: 'root-scheduler',
        attemptId: null,
        eventType: 'writer-stage.retry-authorized',
        fromState: 'terminal',
        toState: 'test-contract-frozen',
        payload: {
            transitionSchema:
                'issue-orchestration.transition.v2',
            priorFailureReceipt: failure.failureReceipt,
            proposedRetry: proposed,
            revisions: [revisionEvidence],
            sourceFailureEvent: failureEvent,
            resourceCleanupReceipt: cleanup,
            retryAuthorization: authorization
        }
    }), oldArtifacts.stageWorkPlan.stageAttemptId)

    await append(event({
        actorRole: 'code-implementer',
        attemptId: newArtifacts.stageWorkPlan.stageAttemptId,
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        toState: 'implementing-self-testing',
        payload: {
            ...stagePayload(newArtifacts, 1),
            dispatchReceipt: dispatchReceipt(newArtifacts, 1),
            effort: 'ultra',
            model: 'gpt-5.6-sol'
        }
    }), newArtifacts.stageWorkPlan.stageAttemptId)

    const newSliceTwoArtifacts = {
        ...newArtifacts,
        executableSlice: currentSlice,
        compiledPrompt: currentPrompt
    }
    const completedPrefixDigest =
        writerTestDigest(completedPrefix)
    const secondProgress = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: newSliceTwoArtifacts,
        fixture,
        activateIndexes: [0, 1],
        routeDigest:
            newArtifacts.stageWorkPlan.routingInputDigest,
        status: 'complete',
        acceptedPriorChangedPaths: firstChangedPaths,
        completedSlicePrefixDigest: completedPrefixDigest
    })
    await append(event({
        actorRole: 'code-implementer',
        attemptId: newArtifacts.stageWorkPlan.stageAttemptId,
        eventType: 'writer-stage.checkpoint-recorded',
        fromState: 'implementing-self-testing',
        toState: 'implementing-self-testing',
        payload: {
            ...stagePayload(newArtifacts, 1),
            checkpoint: secondProgress.checkpoint,
            checkpointVerificationReceipt:
                secondProgress.checkpointVerificationReceipt
        }
    }), newArtifacts.stageWorkPlan.stageAttemptId)

    const secondChangedPaths = completedChangedPaths(
        secondProgress.checkpoint,
        firstChangedPaths
    )
    const finalTerminal = sealSliceTerminalReceipt({
        carryForwardPrefix:
            authorization.carryForwardPrefix,
        plan: newArtifacts.stageWorkPlan,
        slice: currentSlice,
        checkpoint: secondProgress.checkpoint,
        compiledPrompt: currentPrompt,
        compiledPromptDigest: currentPrompt.promptDigest,
        routeDigest:
            newArtifacts.stageWorkPlan.routingInputDigest,
        checkpointVerificationReceipt:
            secondProgress.checkpointVerificationReceipt,
        sealedAuthority: {
            expectedSourceEventDigest:
                newArtifacts.stageWorkPlan.sourceEventDigest,
            expectedSourceLedgerDigest:
                newArtifacts.stageWorkPlan.sourceLedgerDigest
        },
        acceptedPriorChangedPaths: firstChangedPaths,
        completedSlicePrefixDigest: completedPrefixDigest,
        priorTerminalReceipts: [firstTerminal],
        changedPaths: secondChangedPaths,
        commandEvidenceDigests:
            secondProgress.checkpoint.evidence.commands.map(
                ({ outputDigest }) => outputDigest
            )
    })
    const completed = await append(event({
        actorRole: 'code-implementer',
        attemptId: newArtifacts.stageWorkPlan.stageAttemptId,
        eventType: 'writer-stage.completed',
        fromState: 'implementing-self-testing',
        toState: 'implementing-self-testing',
        payload: {
            ...stagePayload(newArtifacts, 1),
            currentCheckpoint: secondProgress.checkpoint,
            checkpointVerificationReceipt:
                secondProgress.checkpointVerificationReceipt,
            terminalReceipt: finalTerminal,
            sliceTerminalReceipts: [
                firstTerminal,
                finalTerminal
            ]
        }
    }), newArtifacts.stageWorkPlan.stageAttemptId)
    assert.equal(
        completed.nodes[NODE].completedSlicePrefix.length,
        2
    )
    assert.equal(
        completed.nodes[NODE].completedSlicePrefix[0]
            .stageAttemptId,
        oldArtifacts.stageWorkPlan.stageAttemptId
    )
    assert.equal(
        completed.nodes[NODE].completedSlicePrefix[1]
            .stageAttemptId,
        newArtifacts.stageWorkPlan.stageAttemptId
    )

    const recovered = await recoverEventLedger({
        runId,
        nodeId: NODE,
        stageAttemptId:
            newArtifacts.stageWorkPlan.stageAttemptId,
        ledgerPath: location.ledgerPath,
        projectionPath: location.projectionPath,
        stateRoot: location.stateRoot
    })
    assert.equal(
        recovered.projection.projectionDigest,
        completed.projectionDigest
    )
})
