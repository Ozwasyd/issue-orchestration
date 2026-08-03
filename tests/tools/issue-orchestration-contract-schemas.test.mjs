import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    compileExecutableSlice,
    compileStageWorkPlan,
    sealProgressCheckpoint
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    authorizeWriterStageRetry,
    compileVerifiedWriterStageContinuation,
    evaluateWriterStageObservation,
    sealSliceTerminalReceipt,
    sealWriterStageRuntimeProgressObservation,
    sealWriterStageRetryRevisionEvidence
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    observeWriterStageCheckpointEvidence,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const permanentContract = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/issue-1874-permanent-test-contract.json'
), 'utf8'))
const runtimeFixtures = new Set()
const checkpointVerificationSchemaIdentity =
    'issue-orchestration.writer-stage-checkpoint-verification-receipt.v1'
const supplementalSchemaFiles = Object.freeze({
    [checkpointVerificationSchemaIdentity]:
        'contracts/'
        + 'writer-stage-checkpoint-verification-receipt.schema.json'
})

test.after(() => {
    for (const fixture of runtimeFixtures) fixture.dispose()
})

const typeMutations = Object.freeze({
    'issue-orchestration.stage-work-plan.v1': {
        field: 'issue',
        value: []
    },
    'issue-orchestration.executable-slice.v1': {
        field: 'order',
        value: '1'
    },
    'issue-orchestration.compiled-dispatch-prompt.v1': {
        field: 'prompt',
        value: 42
    },
    'issue-orchestration.stage-progress-checkpoint.v1': {
        field: 'runId',
        value: 42
    },
    'issue-orchestration.stage-continuation-receipt.v1': {
        field: 'runId',
        value: 42
    },
    'issue-orchestration.slice-terminal-receipt.v1': {
        field: 'stageComplete',
        value: 'true'
    },
    'issue-orchestration.writer-stage-failure-receipt.v1': {
        field: 'runId',
        value: 42
    },
    'issue-orchestration.writer-stage-retry-authorization.v1': {
        field: 'changedRequirementIds',
        value: 'schema-runtime-output'
    },
    [checkpointVerificationSchemaIdentity]: {
        field: 'machineTracePrefixByteLength',
        value: '100'
    }
})

const stageBoundSchemas = Object.freeze([
    'issue-orchestration.stage-work-plan.v1',
    'issue-orchestration.executable-slice.v1',
    'issue-orchestration.compiled-dispatch-prompt.v1',
    'issue-orchestration.slice-terminal-receipt.v1',
    'issue-orchestration.writer-stage-failure-receipt.v1'
])

const invalidWriterBindings = Object.freeze([
    {
        stageRole: 'test-owner',
        stagePhase: 'implementation'
    },
    {
        stageRole: 'code-implementer',
        stagePhase: 'test-contract'
    },
    {
        stageRole: 'ui-ux-implementer',
        stagePhase: 'documentation'
    },
    {
        stageRole: 'documentation-writer',
        stagePhase: 'implementation'
    }
])

const permanentWriterBindings = Object.freeze([
    {
        stageRole: 'test-owner',
        stagePhase: 'test-contract'
    },
    {
        stageRole: 'code-implementer',
        stagePhase: 'implementation'
    },
    {
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation'
    },
    {
        stageRole: 'documentation-writer',
        stagePhase: 'documentation'
    },
    {
        stageRole: 'code-implementer',
        stagePhase: 'landing-conflict-resolution'
    },
    {
        stageRole: 'ui-ux-implementer',
        stagePhase: 'landing-conflict-resolution'
    }
])

function schemaFor(identity) {
    const relativePath = permanentContract.schemaFiles[identity] ??
        supplementalSchemaFiles[identity]
    assert.equal(typeof relativePath, 'string', `unknown schema ${identity}`)
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function checkpointInput({ plan, slice, evidence, status }) {
    return {
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        runId: plan.runId,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        status,
        cursor: {
            kind: 'executable-slice-action',
            completedActionCount: status === 'complete' ? 2 : 1,
            nextActionIndex: status === 'complete' ? 3 : 2,
            lastCompletedAction: `observed ${slice.sliceId}`
        },
        nextRequiredAction: status === 'complete'
            ? null
            : `continue the bounded ${slice.sliceId} cursor`,
        evidence,
        evidenceDigest: evidence.evidenceDigest
    }
}

function outputMissingObservation({ artifacts }) {
    const {
        stageWorkPlan: plan,
        executableSlice: slice,
        compiledPrompt
    } = artifacts
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
        routeDigest: '7'.repeat(64),
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        attemptId: plan.stageAttemptId,
        agentId: 'agent-1874-schema-output-missing',
        firstRequiredActionExecuted: true,
        requiredArtifactManifest: {
            requiredOutputs: ['diff', 'commands', 'checkpoint']
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
        renderEvidence: null,
        verifiedNoChangeEvidence: null,
        conflictMapping: null,
        checkpoint: null,
        terminalReceipt: null,
        priorFailureReceipt: null,
        runtimeCapabilityObservation: {
            runtimeMetadataDigest: '6'.repeat(64),
            actualModel: 'gpt-5.6-sol',
            actualEffort: 'high',
            actualRole: slice.stageRole,
            actualMode: 'write',
            actualSandbox: 'workspace-write',
            actualForkTurns: 'all',
            actualWorkingDirectory: plan.worktreeIdentity
        }
    }
}

function sealTestValue(value, digestField = 'receiptDigest') {
    const unsigned = structuredClone(value)
    delete unsigned[digestField]
    return {
        ...unsigned,
        [digestField]: writerTestDigest(unsigned)
    }
}

function buildVerifiedRetryAuthorization({
    artifacts,
    failureReceipt
}) {
    const previousPlan = artifacts.stageWorkPlan
    const previousSlice = artifacts.executableSlice
    const previousPrompt = artifacts.compiledPrompt
    const observation = outputMissingObservation({ artifacts })
    const payload = {
        failureReceipt,
        stageWorkPlan: previousPlan,
        currentSlice: previousSlice,
        compiledPrompt: previousPrompt,
        writerStageObservation: observation
    }
    const eventBody = {
        schema: 'issue-orchestration.event.v2',
        eventId: 'event-1874-schema-runtime-output-missing',
        sequence: 4,
        runId: previousPlan.runId,
        nodeId: previousPlan.node,
        eventType: failureReceipt.eventType,
        fromState: 'implementing-self-testing',
        toState: 'terminal',
        attemptId: failureReceipt.attemptId,
        actorRole: failureReceipt.stageRole,
        sourceDagDigest: 'a'.repeat(64),
        issueSnapshotFingerprint: 'b'.repeat(64),
        repositoryFingerprint: 'c'.repeat(64),
        baseSha: previousPlan.baseSha,
        payload,
        payloadDigest: writerTestDigest(payload),
        evidenceRefs: [
            'evidence://writer-stage.output-missing'
        ],
        createdAt: '2026-08-02T00:02:00.000Z',
        previousEventDigest: 'd'.repeat(64)
    }
    const sourceFailureEvent =
        sealTestValue(eventBody, 'eventDigest')
    const proposedArtifacts = compileWriterStageTestArtifacts({
        repository: previousPlan.repository,
        issue: previousPlan.issue,
        node: previousPlan.node,
        stageRole: previousPlan.stageRole,
        stagePhase: previousPlan.stagePhase,
        baseSha: previousPlan.baseSha,
        epochId: previousPlan.epochId,
        worktreeIdentity: previousPlan.worktreeIdentity,
        allowedPaths: [...previousSlice.allowedPaths],
        forbiddenPaths: [...previousSlice.forbiddenPaths],
        requiredFiles: [
            ...previousSlice.requiredCreatedOrModifiedFiles
        ],
        requiredCommands: [...previousSlice.requiredCommands],
        requiredEvidence: [...previousSlice.requiredEvidence],
        sliceId: previousSlice.sliceId,
        runId: previousPlan.runId,
        testContractDigest: previousPlan.testContractDigest,
        routingInputDigest: previousPlan.routingInputDigest,
        stageAttemptId: `${previousPlan.stageAttemptId}-retry`
    })
    const currentPlan = proposedArtifacts.stageWorkPlan
    const currentSlice = proposedArtifacts.executableSlice
    const currentPrompt = proposedArtifacts.compiledPrompt
    const runtimeMetadataDigest = writerTestDigest({
        source: 'schema-runtime-output-retry',
        stageAttemptId: currentPlan.stageAttemptId
    })
    const authorityReceipt = sealTestValue({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        verificationStatus: 'verified',
        runId: currentPlan.runId,
        nodeId: currentPlan.node,
        baseSha: currentPlan.baseSha,
        epochId: currentPlan.epochId,
        stageRole: currentPlan.stageRole,
        stagePhase: currentPlan.stagePhase,
        planDigest: currentPlan.planDigest,
        sliceDigest: currentSlice.sliceDigest,
        compiledPromptDigest: currentPrompt.promptDigest,
        runtimeMetadataDigest,
        rolloutId: 'rollout-1874-schema-retry',
        threadId: 'thread-1874-schema-retry',
        actualModel: 'gpt-5.6-sol',
        actualEffort: 'xhigh',
        actualRole: currentPlan.stageRole,
        actualMode: 'write',
        actualSandbox: 'workspace-write',
        actualForkTurns: 'all',
        actualWorkingDirectory: currentPlan.worktreeIdentity
    })
    const proposed = {
        stageWorkPlan: currentPlan,
        executableSlice: currentSlice,
        compiledPrompt: currentPrompt,
        completedSlicePrefix: [],
        authorityReceipt
    }
    const changedRequirementIds = [
        currentSlice.acceptanceItemIds[0]
    ]
    const revisionEvidence =
        sealWriterStageRetryRevisionEvidence({
            priorFailure: failureReceipt,
            sourceFailureEvent,
            proposed,
            revisionKind: 'runtime-revision',
            changedRequirementIds,
            authorityReceipt
        })
    const resourceCleanupReceipt = sealTestValue({
        schema:
            'issue-orchestration.resource-cleanup-receipt.v1',
        actorRole: 'machine-resource-verifier',
        status: 'resources-clean',
        runId: failureReceipt.runId,
        attemptId: failureReceipt.attemptId,
        epochId: failureReceipt.epochId,
        postInventory: [],
        failedResources: [],
        quarantinedResources: [],
        retainedResources: []
    })
    const authorization = authorizeWriterStageRetry({
        priorFailure: failureReceipt,
        proposed,
        revisions: [revisionEvidence],
        sourceFailureEvent,
        resourceCleanupReceipt
    })
    assert.equal(
        authorization.authorized,
        true,
        authorization.reason
    )
    assert.equal(
        authorization.verificationStatus,
        'verified'
    )
    assert.equal(
        authorization.carryForwardPrefix.entries.length,
        0
    )
    return authorization
}

function buildRuntimeOutputs() {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/issue-1874-schema-runtime-output.mjs']
    })
    runtimeFixtures.add(fixture)
    const filePath = fixture.filePaths[0]
    const command = `node --check ${filePath}`
    const artifacts = compileWriterStageTestArtifacts({
        repository: 'Ozwasyd/FsusBlog',
        issue: 1874,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-schema-runtime-output-1',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [filePath],
        requiredFiles: [filePath],
        requiredCommands: [command],
        sliceId: 'slice-1874-schema-runtime-output'
    })
    const {
        stageWorkPlan: plan,
        executableSlice: slice,
        compiledPrompt
    } = artifacts
    const sealedAuthority = {
        expectedSourceEventDigest: plan.sourceEventDigest,
        expectedSourceLedgerDigest: plan.sourceLedgerDigest
    }
    const partial = buildVerifiedWriterProgressCheckpoint({
        artifacts,
        fixture,
        activateIndexes: 0,
        status: 'partial'
    })
    const continuationReceipt =
        compileVerifiedWriterStageContinuation({
            plan,
            slice,
            checkpoint: partial.checkpoint,
            compiledPrompt,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDigest: partial.routeDigest,
            checkpointVerificationReceipt:
                partial.checkpointVerificationReceipt,
            sealedAuthority,
            acceptedPriorChangedPaths:
                partial.acceptedPriorChangedPaths,
            completedSlicePrefixDigest:
                partial.completedSlicePrefixDigest,
            previousMachineTraceSnapshot: null,
            requestedResume: {
                mode: 'checkpoint-cursor'
            }
        })
    const complete = buildVerifiedWriterProgressCheckpoint({
        artifacts,
        fixture,
        activateIndexes: 0,
        status: 'complete'
    })
    const completeCheckpoint = complete.checkpoint
    const terminalReceipt = sealSliceTerminalReceipt({
        plan,
        slice,
        checkpoint: completeCheckpoint,
        compiledPrompt,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest: complete.routeDigest,
        checkpointVerificationReceipt:
            complete.checkpointVerificationReceipt,
        sealedAuthority,
        acceptedPriorChangedPaths:
            complete.acceptedPriorChangedPaths,
        completedSlicePrefixDigest:
            complete.completedSlicePrefixDigest,
        previousMachineTraceSnapshot: null,
        priorTerminalReceipts: [],
        changedPaths: [filePath],
        commandEvidenceDigests:
            completeCheckpoint.evidence.commands.map(
                ({ outputDigest }) => outputDigest
            )
    })
    const failureReceipt = evaluateWriterStageObservation(
        outputMissingObservation({ artifacts })
    ).failureReceipt
    const retryAuthorization = buildVerifiedRetryAuthorization({
        artifacts,
        failureReceipt
    })

    return {
        fixture,
        supplementalOutputs: {
            [checkpointVerificationSchemaIdentity]:
                complete.checkpointVerificationReceipt
        },
        outputs: {
            [plan.schema]: plan,
            [slice.schema]: slice,
            [compiledPrompt.schema]: compiledPrompt,
            [completeCheckpoint.schema]: completeCheckpoint,
            [continuationReceipt.schema]: continuationReceipt,
            [terminalReceipt.schema]: terminalReceipt,
            [failureReceipt.schema]: failureReceipt,
            [retryAuthorization.schema]: retryAuthorization
        }
    }
}

let cachedRuntimeOutputBundle = null

function canonicalRuntimeOutputBundle() {
    if (cachedRuntimeOutputBundle === null) {
        const bundle = buildRuntimeOutputs()
        cachedRuntimeOutputBundle = Object.freeze({
            outputs: bundle.outputs,
            supplementalOutputs: bundle.supplementalOutputs
        })
    }
    return cachedRuntimeOutputBundle
}

function buildDocumentationNoChangeCheckpoint() {
    const fixture = createWriterStageGitFixture({
        filePaths: ['docs/issue-1874-schema-no-change.md']
    })
    runtimeFixtures.add(fixture)
    const filePath = fixture.filePaths[0]
    const sliceId = 'slice-1874-schema-documentation-no-change'
    const command = 'git diff --quiet'
    const digestFor = (owner) => writerTestDigest({
        owner,
        sliceId,
        baseSha: fixture.baseSha
    })
    const plan = compileStageWorkPlan({
        schema: 'issue-orchestration.stage-work-plan-input.v1',
        runId: 'run-1874-schema-documentation-no-change',
        repository: 'Ozwasyd/FsusBlog',
        issue: 1874,
        node: 'Ozwasyd/FsusBlog#1874:documentation-no-change-schema',
        stageRole: 'documentation-writer',
        stagePhase: 'documentation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-schema-documentation-no-change-1',
        worktreeIdentity: fixture.worktreeIdentity,
        semanticContractDigest: digestFor('semantic-contract'),
        testContractDigest: digestFor('test-contract'),
        authorityDigest: digestFor('authority'),
        skillDigest: digestFor('skill'),
        baselineDigest: digestFor('baseline'),
        routingInputDigest: digestFor('routing-input'),
        stageObjective:
            'Verify the focused documentation slice needs no source change',
        acceptanceItems: ['documentation-no-change-schema'],
        orderedSlices: [{
            sliceId,
            order: 1,
            prerequisiteSliceIds: [],
            singleObjective:
                'Seal machine evidence for the documentation no-change result',
            firstRequiredAction: command,
            firstReadTargets: [filePath],
            explicitReadOnlyOutput:
                'verified documentation no-change evidence',
            allowedPaths: [],
            forbiddenPaths: [],
            requiredCreatedOrModifiedFiles: [],
            requiredCommands: [command],
            requiredEvidence: ['verified-no-change-evidence'],
            expectedFailureOrProgressSignal:
                'a complete no-change checkpoint or terminal failure receipt',
            explicitNonGoals: [
                'manufacture a documentation diff',
                'write outside the documentation stage'
            ],
            maxChangedFiles: 1,
            maxOwnedModules: 1,
            maxReadOnlyOperationsBeforeCheckpoint: 4,
            maxNoArtifactToolCalls: 3,
            maxNoArtifactActiveDurationClass: 'short',
            safeCheckpointKind: 'documentation-no-change',
            acceptanceItemIds: ['documentation-no-change-schema'],
            completionPredicate:
                'the no-change command and evidence are machine verified',
            continuationPredicate:
                'resume the same documentation evidence cursor'
        }],
        sliceDependencyGraph: {
            [sliceId]: []
        },
        stageAllowedPaths: ['docs/**'],
        stageForbiddenPaths: [],
        stageRequiredCommands: [command],
        stageTerminalArtifacts: [
            'issue-orchestration.slice-terminal-receipt.v1'
        ]
    })
    const slice = compileExecutableSlice({ plan, sliceId })
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice,
        requiredFiles: []
    })
    const checkpoint = sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({
            plan,
            slice,
            evidence,
            status: 'complete'
        })
    })
    return {
        fixture,
        checkpoint
    }
}

test('all eight canonical runtime outputs pass their real Ajv schemas', () => {
    const { outputs } = canonicalRuntimeOutputBundle()
    assert.deepEqual(
        Object.keys(outputs),
        permanentContract.requiredSchemas
    )
    for (const [identity, output] of Object.entries(outputs)) {
        assert.deepEqual(
            validateJsonSchema(output, schemaFor(identity)),
            [],
            identity
        )
    }
})

test('the permanent checkpoint verification receipt passes its real Ajv schema', () => {
    const { supplementalOutputs } = canonicalRuntimeOutputBundle()
    const receipt =
        supplementalOutputs[checkpointVerificationSchemaIdentity]
    assert.deepEqual(
        validateJsonSchema(
            receipt,
            schemaFor(checkpointVerificationSchemaIdentity)
        ),
        []
    )
})

test('a chained checkpoint and continuation pass their schemas and reject a broken fork', () => {
    const filePath = 'src/issue-1874-schema-checkpoint-fork.mjs'
    const fixture = createWriterStageGitFixture({
        filePaths: [filePath]
    })
    runtimeFixtures.add(fixture)
    try {
        const artifacts = compileWriterStageTestArtifacts({
            repository: 'Ozwasyd/FsusBlog',
            issue: 1874,
            stageRole: 'code-implementer',
            stagePhase: 'implementation',
            baseSha: fixture.baseSha,
            epochId: 'epoch-1874-schema-checkpoint-fork-1',
            worktreeIdentity: fixture.worktreeIdentity,
            allowedPaths: [filePath],
            requiredFiles: [filePath],
            requiredCommands: [`node --check ${filePath}`],
            sliceId: 'slice-1874-schema-checkpoint-fork'
        })
        const first = buildVerifiedWriterProgressCheckpoint({
            artifacts,
            fixture,
            activateIndexes: 0,
            status: 'partial'
        })
        const firstSnapshot =
            first.machineRuntimeTrace.traceSnapshot
        const second = buildVerifiedWriterProgressCheckpoint({
            artifacts,
            fixture,
            activateIndexes: 0,
            status: 'partial',
            checkpointOrdinal: 2,
            previousCheckpointDigest:
                first.checkpoint.checkpointDigest,
            previousCheckpointVerificationReceiptDigest:
                first.checkpointVerificationReceipt.receiptDigest,
            previousMachineTracePrefixDigest:
                firstSnapshot.prefixDigest,
            previousMachineTracePrefixByteLength:
                firstSnapshot.prefixByteLength,
            previousMachineTraceSnapshot: firstSnapshot
        })
        const plan = artifacts.stageWorkPlan
        const slice = artifacts.executableSlice
        const compiledPrompt = artifacts.compiledPrompt
        const continuation =
            compileVerifiedWriterStageContinuation({
                plan,
                slice,
                checkpoint: second.checkpoint,
                compiledPrompt,
                compiledPromptDigest:
                    compiledPrompt.promptDigest,
                routeDigest: second.routeDigest,
                checkpointVerificationReceipt:
                    second.checkpointVerificationReceipt,
                sealedAuthority: {
                    expectedSourceEventDigest:
                        plan.sourceEventDigest,
                    expectedSourceLedgerDigest:
                        plan.sourceLedgerDigest
                },
                previousMachineTraceSnapshot: firstSnapshot,
                requestedResume: {
                    mode: 'checkpoint-cursor'
                }
            })
        for (const output of [
            second.checkpoint,
            second.checkpointVerificationReceipt,
            continuation
        ]) {
            assert.deepEqual(
                validateJsonSchema(output, schemaFor(output.schema)),
                [],
                output.schema
            )
        }

        const brokenFork = structuredClone(
            second.checkpointVerificationReceipt
        )
        brokenFork.previousCheckpointDigest = null
        assert.notDeepEqual(
            validateJsonSchema(
                brokenFork,
                schemaFor(brokenFork.schema)
            ),
            [],
            'second checkpoint receipt accepted a missing predecessor'
        )
    } finally {
        fixture.dispose()
    }
})

test('the runtime documentation no-change checkpoint passes its schema with no fabricated files', () => {
    const { fixture, checkpoint } = buildDocumentationNoChangeCheckpoint()
    try {
        assert.deepEqual(checkpoint.evidence.requiredFiles, [])
        assert.deepEqual(
            validateJsonSchema(checkpoint, schemaFor(checkpoint.schema)),
            []
        )
    } finally {
        fixture.dispose()
    }
})

test('permanent writer schemas reject UI phase aliases and active landing-owner authority', () => {
    const { outputs } = canonicalRuntimeOutputBundle()
    for (const identity of stageBoundSchemas) {
        const schema = schemaFor(identity)
        const uiAlias = structuredClone(outputs[identity])
        uiAlias.stageRole = 'ui-ux-implementer'
        uiAlias.stagePhase = 'implementation'
        assert.notDeepEqual(
            validateJsonSchema(uiAlias, schema),
            [],
            `${identity} accepted the retired UI implementation alias`
        )

        const activeLandingOwner = structuredClone(outputs[identity])
        activeLandingOwner.stageRole = 'landing-owner'
        activeLandingOwner.stagePhase = 'landing-conflict-resolution'
        if (Object.hasOwn(activeLandingOwner, 'authorityStatus')) {
            activeLandingOwner.authorityStatus = 'active-writer'
        }
        assert.notDeepEqual(
            validateJsonSchema(activeLandingOwner, schema),
            [],
            `${identity} accepted landing-owner as an active writer`
        )

        for (const binding of invalidWriterBindings) {
            const mismatched = structuredClone(outputs[identity])
            Object.assign(mismatched, binding)
            assert.notDeepEqual(
                validateJsonSchema(mismatched, schema),
                [],
                `${identity} accepted ${binding.stageRole}:`
                + binding.stagePhase
            )
        }
    }
})

test('all five permanent writer phases produce schema-valid plan, slice and prompt outputs', () => {
    for (const [index, binding] of permanentWriterBindings.entries()) {
        const filePath =
            `src/issue-1874-schema-binding-${index + 1}.mjs`
        const fixture = createWriterStageGitFixture({
            filePaths: [filePath]
        })
        runtimeFixtures.add(fixture)
        try {
            const artifacts = compileWriterStageTestArtifacts({
                repository: 'Ozwasyd/FsusBlog',
                issue: 1874,
                node:
                    `Ozwasyd/FsusBlog#1874:schema-binding-${index + 1}`,
                ...binding,
                baseSha: fixture.baseSha,
                epochId:
                    `epoch-1874-schema-binding-${index + 1}`,
                worktreeIdentity: fixture.worktreeIdentity,
                allowedPaths: [filePath],
                requiredFiles: [filePath],
                requiredCommands: [`node --check ${filePath}`],
                sliceId:
                    `slice-1874-schema-binding-${index + 1}`
            })
            for (const output of [
                artifacts.stageWorkPlan,
                artifacts.executableSlice,
                artifacts.compiledPrompt
            ]) {
                assert.deepEqual(
                    validateJsonSchema(output, schemaFor(output.schema)),
                    [],
                    `${binding.stageRole}:${binding.stagePhase}:`
                    + output.schema
                )
            }
            if (index === 0) {
                const tampered = structuredClone(
                    artifacts.stageWorkPlan
                )
                tampered.frozenStageContract.selfMintedAuthority = true
                assert.ok(
                    validateJsonSchema(
                        tampered,
                        schemaFor(tampered.schema)
                    ).some((error) =>
                        /additional properties/iu.test(error)),
                    'embedded frozen contract accepted self-minted authority'
                )
            }
        } finally {
            fixture.dispose()
        }
    }
})

test('a two-slice plan produces schema-valid ordered slices and deterministic prompts', () => {
    const filePaths = [
        'src/issue-1874-schema-two-slice-1.mjs',
        'src/issue-1874-schema-two-slice-2.mjs'
    ]
    const fixture = createWriterStageGitFixture({ filePaths })
    runtimeFixtures.add(fixture)
    try {
        const artifacts = compileWriterStageTestArtifacts({
            repository: 'Ozwasyd/FsusBlog',
            issue: 1874,
            node: 'Ozwasyd/FsusBlog#1874:schema-two-slice',
            stageRole: 'code-implementer',
            stagePhase: 'implementation',
            baseSha: fixture.baseSha,
            epochId: 'epoch-1874-schema-two-slice-1',
            worktreeIdentity: fixture.worktreeIdentity,
            allowedPaths: filePaths,
            requiredFiles: filePaths,
            requiredCommands: filePaths.map((filePath) =>
                `node --check ${filePath}`),
            sliceId: 'slice-1874-schema-two-slice',
            sliceCount: 2
        })
        assert.equal(artifacts.executableSlices.length, 2)
        assert.equal(artifacts.compiledPrompts.length, 2)
        assert.deepEqual(
            artifacts.executableSlices[1].prerequisiteSliceIds,
            [artifacts.executableSlices[0].sliceId]
        )
        for (const output of [
            artifacts.stageWorkPlan,
            ...artifacts.executableSlices,
            ...artifacts.compiledPrompts
        ]) {
            assert.deepEqual(
                validateJsonSchema(output, schemaFor(output.schema)),
                [],
                output.schema
            )
        }
    } finally {
        fixture.dispose()
    }
})

test('ordered multi-slice terminal receipts pass the schema without premature green', () => {
    const filePaths = [
        'src/issue-1874-schema-terminal-chain-1.mjs',
        'src/issue-1874-schema-terminal-chain-2.mjs'
    ]
    const fixture = createWriterStageGitFixture({ filePaths })
    runtimeFixtures.add(fixture)
    try {
        const artifacts = compileWriterStageTestArtifacts({
            repository: 'Ozwasyd/FsusBlog',
            issue: 1874,
            node: 'Ozwasyd/FsusBlog#1874:schema-terminal-chain',
            stageRole: 'code-implementer',
            stagePhase: 'implementation',
            baseSha: fixture.baseSha,
            epochId: 'epoch-1874-schema-terminal-chain-1',
            worktreeIdentity: fixture.worktreeIdentity,
            allowedPaths: filePaths,
            requiredFiles: filePaths,
            requiredCommands: filePaths.map((filePath) =>
                `node --check ${filePath}`),
            sliceId: 'slice-1874-schema-terminal-chain',
            sliceCount: 2
        })
        const plan = artifacts.stageWorkPlan
        const authority = {
            expectedSourceEventDigest: plan.sourceEventDigest,
            expectedSourceLedgerDigest: plan.sourceLedgerDigest
        }
        const firstArtifacts = {
            ...artifacts,
            executableSlice: artifacts.executableSlices[0],
            compiledPrompt: artifacts.compiledPrompts[0]
        }
        const first = buildVerifiedWriterProgressCheckpoint({
            artifacts: firstArtifacts,
            fixture,
            activateIndexes: 0
        })
        const firstTerminal = sealSliceTerminalReceipt({
            plan,
            slice: firstArtifacts.executableSlice,
            checkpoint: first.checkpoint,
            compiledPrompt: firstArtifacts.compiledPrompt,
            compiledPromptDigest:
                firstArtifacts.compiledPrompt.promptDigest,
            routeDigest: first.routeDigest,
            checkpointVerificationReceipt:
                first.checkpointVerificationReceipt,
            sealedAuthority: authority,
            completedSlicePrefixDigest:
                first.completedSlicePrefixDigest,
            priorTerminalReceipts: [],
            changedPaths: [filePaths[0]],
            commandEvidenceDigests:
                first.checkpoint.evidence.commands.map(
                    ({ outputDigest }) => outputDigest
                )
        })
        const secondArtifacts = {
            ...artifacts,
            executableSlice: artifacts.executableSlices[1],
            compiledPrompt: artifacts.compiledPrompts[1]
        }
        const completedSlicePrefixDigest = writerTestDigest([
            firstTerminal.receiptDigest
        ])
        const second = buildVerifiedWriterProgressCheckpoint({
            artifacts: secondArtifacts,
            fixture,
            activateIndexes: [0, 1],
            acceptedPriorChangedPaths: [filePaths[0]],
            completedSlicePrefixDigest
        })
        const finalTerminal = sealSliceTerminalReceipt({
            plan,
            slice: secondArtifacts.executableSlice,
            checkpoint: second.checkpoint,
            compiledPrompt: secondArtifacts.compiledPrompt,
            compiledPromptDigest:
                secondArtifacts.compiledPrompt.promptDigest,
            routeDigest: second.routeDigest,
            checkpointVerificationReceipt:
                second.checkpointVerificationReceipt,
            sealedAuthority: authority,
            acceptedPriorChangedPaths: [filePaths[0]],
            completedSlicePrefixDigest,
            priorTerminalReceipts: [firstTerminal],
            changedPaths: [filePaths[1]],
            commandEvidenceDigests:
                second.checkpoint.evidence.commands.map(
                    ({ outputDigest }) => outputDigest
                )
        })
        assert.equal(firstTerminal.stageComplete, false)
        assert.equal(firstTerminal.candidateEligible, false)
        assert.equal(finalTerminal.stageComplete, true)
        assert.equal(finalTerminal.candidateEligible, true)
        for (const receipt of [firstTerminal, finalTerminal]) {
            assert.deepEqual(
                validateJsonSchema(
                    receipt,
                    schemaFor(receipt.schema)
                ),
                [],
                receipt.sliceId
            )
        }
    } finally {
        fixture.dispose()
    }
})

test('verified checkpoint schema requires machine provenance and rejects a forged cursor', () => {
    const { outputs } = canonicalRuntimeOutputBundle()
    const identity = 'issue-orchestration.stage-progress-checkpoint.v1'
    const checkpoint = outputs[identity]
    const schema = schemaFor(identity)
    assert.equal(checkpoint.verificationStatus, 'verified')
    assert.equal(checkpoint.candidateState, 'slice-complete')

    for (const field of [
        'satisfiedEvidenceIds',
        'typedEvidenceReceipts',
        'machineRuntimeTrace',
        'runtimeProgressObservation'
    ]) {
        const missing = structuredClone(checkpoint)
        delete missing.evidence[field]
        assert.notDeepEqual(
            validateJsonSchema(missing, schema),
            [],
            `verified checkpoint accepted missing ${field}`
        )
    }

    const forgedCursor = structuredClone(checkpoint)
    forgedCursor.cursor.completedActionCount = 999
    forgedCursor.cursor.nextActionIndex = 1_000
    assert.notDeepEqual(
        validateJsonSchema(forgedCursor, schema),
        [],
        'verified checkpoint schema accepted an impossible cursor'
    )

    const selfMintedAuthority = structuredClone(checkpoint)
    selfMintedAuthority.evidence.typedEvidenceReceipts[0]
        .payload.selfMintedAuthority = true
    assert.ok(
        validateJsonSchema(selfMintedAuthority, schema).some((error) =>
            /additional properties/iu.test(error)),
        'typed evidence accepted a self-minted authority field'
    )

    for (const field of ['runtimeObservation', 'dispatchReceipt']) {
        const selfMintedRuntimeIdentity =
            structuredClone(checkpoint)
        selfMintedRuntimeIdentity.evidence.machineRuntimeTrace[field]
            .selfMintedAuthority = true
        assert.ok(
            validateJsonSchema(
                selfMintedRuntimeIdentity,
                schema
            ).some((error) =>
                /additional properties/iu.test(error)),
            `${field} accepted a self-minted authority field`
        )
    }

    const plan =
        outputs['issue-orchestration.stage-work-plan.v1']
    const slice =
        outputs['issue-orchestration.executable-slice.v1']
    for (const mutate of [
        (value) => {
            value.selfMintedCheckpointAuthority = true
        },
        (value) => {
            value.evidence.selfMintedEvidenceAuthority = true
        }
    ]) {
        const selfMintedCheckpoint = structuredClone(checkpoint)
        mutate(selfMintedCheckpoint)
        assert.throws(() => sealProgressCheckpoint({
            plan,
            slice,
            checkpoint: selfMintedCheckpoint
        }), /unexpected fields/iu)
    }

    for (const field of ['runtimeObservation', 'dispatchReceipt']) {
        const selfMintedTrace =
            structuredClone(checkpoint.evidence.machineRuntimeTrace)
        selfMintedTrace[field].selfMintedAuthority = true
        const resealedTrace = sealTestValue(
            selfMintedTrace,
            'receiptDigest'
        )
        assert.throws(
            () => sealWriterStageRuntimeProgressObservation({
                plan,
                slice,
                compiledPromptDigest:
                    outputs[
                        'issue-orchestration.compiled-dispatch-prompt.v1'
                    ].promptDigest,
                routeDigest: resealedTrace.routeDigest,
                checkpointEvidence: checkpoint.evidence,
                typedEvidenceReceipts:
                    checkpoint.evidence.typedEvidenceReceipts,
                machineRuntimeTrace: resealedTrace
            }),
            /dispatch receipt|machine trace|runtime progress/iu,
            `${field} runtime accepted self-minted authority`
        )
    }
})

test('failure schema separates active permanent writers from historical landing observations', () => {
    const { outputs } = canonicalRuntimeOutputBundle()
    const identity =
        'issue-orchestration.writer-stage-failure-receipt.v1'
    const schema = schemaFor(identity)
    const activeFailure = outputs[identity]
    assert.deepEqual(validateJsonSchema(activeFailure, schema), [])

    const historicalLanding = structuredClone(activeFailure)
    historicalLanding.stageRole = 'landing-owner'
    historicalLanding.stagePhase = 'landing-conflict-resolution'
    historicalLanding.authorityStatus = 'historical-observation-only'
    assert.deepEqual(
        validateJsonSchema(historicalLanding, schema),
        [],
        'historical landing observation is required for frozen audit evidence'
    )

    const historicalActiveWriter = structuredClone(activeFailure)
    historicalActiveWriter.authorityStatus =
        'historical-observation-only'
    assert.notDeepEqual(
        validateJsonSchema(historicalActiveWriter, schema),
        [],
        'permanent active writer was downgraded to historical authority'
    )
})

for (const identity of [
    ...permanentContract.requiredSchemas,
    checkpointVerificationSchemaIdentity
]) {
    test(`${identity} fails closed for additional, required and type mutations`, () => {
        const {
            outputs,
            supplementalOutputs
        } = canonicalRuntimeOutputBundle()
        const output = outputs[identity] ??
            supplementalOutputs[identity]
        const schema = schemaFor(identity)

        const additional = structuredClone(output)
        additional.unexpectedSchemaField = true
        assert.ok(
            validateJsonSchema(additional, schema).some((error) =>
                /additional properties/iu.test(error)),
            `${identity} accepted an additional property`
        )

        const missing = structuredClone(output)
        delete missing[schema.required[0]]
        assert.ok(
            validateJsonSchema(missing, schema).some((error) =>
                /required property/iu.test(error)),
            `${identity} accepted a missing required property`
        )

        const typeMutation = typeMutations[identity]
        assert.ok(typeMutation, `${identity} lacks a type mutation`)
        const wrongType = structuredClone(output)
        wrongType[typeMutation.field] = typeMutation.value
        assert.notDeepEqual(
            validateJsonSchema(wrongType, schema),
            [],
            `${identity} accepted ${typeMutation.field} with the wrong type`
        )
    })
}
