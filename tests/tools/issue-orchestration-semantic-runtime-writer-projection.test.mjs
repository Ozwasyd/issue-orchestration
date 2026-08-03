import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'

import {
    createSemanticGraph,
    projectRuntime
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    replayEventLedgerSync
} from '../../skills/issue-orchestration/scripts/event-ledger.mjs'
import {
    sealSliceTerminalReceipt
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    buildCanonicalWriterStageLedger,
    compileWriterStageTestArtifacts,
    createCanonicalWriterDispatchReceipt,
    createWriterStageGitFixture,
    sealCanonicalWriterLedgerEvent
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

const GENESIS = '0'.repeat(64)
const SOURCE_DAG_DIGEST = '1'.repeat(64)

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort()
            .map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(
            typeof value === 'string'
                ? value
                : JSON.stringify(canonical(value))
        )
        .digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function nestedKeys(value) {
    if (Array.isArray(value)) return value.flatMap(nestedKeys)
    if (!value || typeof value !== 'object') return []
    return [
        ...Object.keys(value),
        ...Object.values(value).flatMap(nestedKeys)
    ]
}

function assertSanitizedCheckpointProjection(
    projected,
    verificationReceipt
) {
    assert.deepEqual({
        acceptedPriorChangedPathsDigest:
            projected.acceptedPriorChangedPathsDigest,
        checkpointOrdinal: projected.checkpointOrdinal,
        checkpointVerificationReceiptDigest:
            projected.checkpointVerificationReceiptDigest,
        completedSlicePrefixDigest:
            projected.completedSlicePrefixDigest,
        machineTracePrefixByteLength:
            projected.machineTracePrefixByteLength,
        machineTracePrefixDigest:
            projected.machineTracePrefixDigest,
        machineTraceSnapshotDigest:
            projected.machineTraceSnapshotDigest,
        operationsDigest: projected.operationsDigest,
        previousCheckpointDigest:
            projected.previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest:
            projected.previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixByteLength:
            projected.previousMachineTracePrefixByteLength,
        previousMachineTracePrefixDigest:
            projected.previousMachineTracePrefixDigest,
        runtimeProgressObservationDigest:
            projected.runtimeProgressObservationDigest
    }, {
        acceptedPriorChangedPathsDigest:
            verificationReceipt.acceptedPriorChangedPathsDigest,
        checkpointOrdinal: verificationReceipt.checkpointOrdinal,
        checkpointVerificationReceiptDigest:
            verificationReceipt.receiptDigest,
        completedSlicePrefixDigest:
            verificationReceipt.completedSlicePrefixDigest,
        machineTracePrefixByteLength:
            verificationReceipt.machineTracePrefixByteLength,
        machineTracePrefixDigest:
            verificationReceipt.machineTracePrefixDigest,
        machineTraceSnapshotDigest:
            verificationReceipt.machineTraceSnapshotDigest,
        operationsDigest: verificationReceipt.operationsDigest,
        previousCheckpointDigest:
            verificationReceipt.previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest:
            verificationReceipt
                .previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixByteLength:
            verificationReceipt
                .previousMachineTracePrefixByteLength,
        previousMachineTracePrefixDigest:
            verificationReceipt.previousMachineTracePrefixDigest,
        runtimeProgressObservationDigest:
            verificationReceipt.runtimeProgressObservationDigest
    })
    const keys = new Set(nestedKeys(projected))
    for (const forbidden of [
        'records',
        'source',
        'tracePath',
        'traceSnapshot'
    ]) {
        assert.equal(
            keys.has(forbidden),
            false,
            `reader projection leaked ${forbidden}`
        )
    }
}

function graphFor(nodeId) {
    return createSemanticGraph({
        scopeDigest: digest('writer-projection-scope'),
        semanticGraphInputDigest:
            digest('writer-projection-semantic-input'),
        nodes: [{
            id: nodeId,
            owner: 'issue-orchestration',
            dependencyKeys: [],
            conflictKeys: ['issue-orchestration'],
            riskClass: 'high',
            uiClass: 'none',
            acceptanceGroup: null,
            contractDigest: digest('writer-projection-contract')
        }]
    })
}

function runtimeFor(nodeId, candidateCommits = {}) {
    return {
        completed: [],
        active: [nodeId],
        availableSlots: 0,
        leases: [],
        epochId: 'epoch-writer-projection',
        candidateCommits,
        deliveryCommits: {},
        cleanup: {}
    }
}

function sealEvent(ledger, {
    actorRole,
    attemptId = null,
    eventType,
    fromState,
    nodeId,
    payload = {},
    toState
}) {
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId:
            `writer-projection-event-${ledger.events.length + 1}`,
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        nodeId,
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest:
            ledger.events.at(-1)?.sourceDagDigest ??
            SOURCE_DAG_DIGEST,
        issueSnapshotFingerprint:
            ledger.header.issueSnapshotFingerprint,
        repositoryFingerprint:
            ledger.header.repositoryFingerprint,
        baseSha: ledger.header.baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs: [`evidence://${eventType}`],
        createdAt: new Date(
            Date.parse(
                ledger.events.at(-1)?.createdAt ??
                ledger.header.createdAt
            ) + 1_000
        ).toISOString(),
        previousEventDigest:
            ledger.events.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = digest(event)
    ledger.events.push(event)
    return event
}

function resealEvents(ledger, startIndex = 0) {
    for (let index = startIndex; index < ledger.events.length; index += 1) {
        const event = ledger.events[index]
        event.sequence = index + 1
        event.previousEventDigest = index === 0
            ? GENESIS
            : ledger.events[index - 1].eventDigest
        event.payloadDigest = digest(event.payload)
        delete event.eventDigest
        event.eventDigest = digest(event)
    }
    return ledger
}

function dispatchReceipt({ plan, slice, compiledPrompt }) {
    const requestIdentity = {
        schema: 'issue-orchestration.dispatch-request.v2',
        runId: plan.runId,
        nodeId: plan.node,
        attemptId: plan.stageAttemptId,
        epochId: plan.epochId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        baseSha: plan.baseSha,
        planDigest: plan.planDigest,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest
    }
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId:
            `request-${plan.stageAttemptId}-${slice.sliceId}`,
        requestDigest: digest(requestIdentity),
        runId: plan.runId,
        nodeId: plan.node,
        attemptId: plan.stageAttemptId,
        epochId: plan.epochId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        policyVersion: 'stage-model-pool.v3',
        routingPolicyDigest:
            digest('writer-projection-routing-policy'),
        routingInputDigest: plan.routingInputDigest,
        baseSha: plan.baseSha,
        candidateSha: plan.baseSha,
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        verificationStatus: 'verified',
        mismatchReasons: []
    }
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

function writerArtifactsFor(artifacts, index) {
    return {
        ...artifacts,
        executableSlice: artifacts.executableSlices[index],
        compiledPrompt: artifacts.compiledPrompts[index]
    }
}

function startedWriterLedger(artifacts) {
    const plan = artifacts.stageWorkPlan
    const slice = artifacts.executableSlices[0]
    const compiledPrompt = artifacts.compiledPrompts[0]
    const sourceEntries = fs.readFileSync(
        artifacts.writerAuthority.location.sourceLedgerPath,
        'utf8'
    ).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const ledger = {
        header: sourceEntries[0],
        events: sourceEntries.slice(1)
    }
    sealEvent(ledger, {
        actorRole: plan.stageRole,
        attemptId: plan.stageAttemptId,
        eventType: 'test-contract.started',
        fromState: 'discovered',
        nodeId: plan.node,
        payload: {
            actorId: 'test-owner-writer-projection',
            dispatchReceipt: dispatchReceipt({
                plan,
                slice,
                compiledPrompt
            }),
            stageWorkPlan: plan,
            currentSlice: slice,
            executableSlice: slice,
            compiledPrompt
        },
        toState: 'test-contracting'
    })
    return ledger
}

function changedPathsFromCheckpoint(checkpoint) {
    return checkpoint.evidence.git.worktreeStatus
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => line.slice(3).trim())
        .sort()
}

function terminalReceiptFor({
    plan,
    slice,
    compiledPrompt,
    verifiedCheckpoint,
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = digest([]),
    previousMachineTraceSnapshot = null,
    priorTerminalReceipts = []
}) {
    return sealSliceTerminalReceipt({
        plan,
        slice,
        checkpoint: verifiedCheckpoint.checkpoint,
        checkpointVerificationReceipt:
            verifiedCheckpoint.checkpointVerificationReceipt,
        compiledPrompt,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest: plan.routingInputDigest,
        sealedAuthority: {
            expectedSourceEventDigest: plan.sourceEventDigest,
            expectedSourceLedgerDigest: plan.sourceLedgerDigest
        },
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest,
        previousMachineTraceSnapshot,
        priorTerminalReceipts,
        changedPaths: changedPathsFromCheckpoint(
            verifiedCheckpoint.checkpoint
        ).filter((filePath) =>
            !acceptedPriorChangedPaths.includes(filePath)),
        commandEvidenceDigests:
            verifiedCheckpoint.checkpoint.evidence.commands
                .map(({ outputDigest }) =>
                outputDigest)
    })
}

function appendWriterCheckpoint(
    ledger,
    artifacts,
    verifiedCheckpoint
) {
    const plan = artifacts.stageWorkPlan
    sealEvent(ledger, {
        actorRole: plan.stageRole,
        attemptId: plan.stageAttemptId,
        eventType: 'writer-stage.checkpoint-recorded',
        fromState: 'test-contracting',
        nodeId: plan.node,
        payload: {
            stageWorkPlan: plan,
            currentSlice: artifacts.executableSlice,
            compiledPrompt: artifacts.compiledPrompt,
            checkpoint: verifiedCheckpoint.checkpoint,
            checkpointVerificationReceipt:
                verifiedCheckpoint.checkpointVerificationReceipt
        },
        toState: 'test-contracting'
    })
}

function appendWriterTerminal({
    ledger,
    artifacts,
    verifiedCheckpoint,
    terminalReceipt,
    terminalReceipts,
    nextArtifacts = null
}) {
    const plan = artifacts.stageWorkPlan
    const nextSlice = nextArtifacts?.executableSlice ?? null
    sealEvent(ledger, {
        actorRole: plan.stageRole,
        attemptId: plan.stageAttemptId,
        eventType: nextSlice
            ? 'writer-stage.slice-completed'
            : 'writer-stage.completed',
        fromState: 'test-contracting',
        nodeId: plan.node,
        payload: {
            stageWorkPlan: plan,
            currentSlice: artifacts.executableSlice,
            compiledPrompt: artifacts.compiledPrompt,
            currentCheckpoint: verifiedCheckpoint.checkpoint,
            checkpointVerificationReceipt:
                verifiedCheckpoint.checkpointVerificationReceipt,
            terminalReceipt,
            sliceTerminalReceipts: terminalReceipts,
            ...(nextSlice
                ? {
                    nextSlice,
                    nextCompiledPrompt: nextArtifacts.compiledPrompt,
                    nextDispatchReceipt: dispatchReceipt({
                        plan,
                        slice: nextSlice,
                        compiledPrompt: nextArtifacts.compiledPrompt
                    })
                }
                : {})
        },
        toState: 'test-contracting'
    })
}

function compileTwoSliceArtifacts(fixture) {
    return compileWriterStageTestArtifacts({
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: 'ExampleOrg/RepositoryA#1874:writer-projection',
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-writer-projection-001',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [...fixture.filePaths],
        requiredFiles: [...fixture.filePaths],
        requiredCommands: fixture.filePaths.map((filePath) =>
            `node --check ${filePath}`),
        routingInputDigest:
            digest('writer-projection-route'),
        sliceId: 'writer-projection-slice-1',
        sliceCount: 2
    })
}

function project(artifacts, ledger, candidateCommits = {}) {
    return projectRuntime({
        semanticGraph: graphFor(artifacts.stageWorkPlan.node),
        ledger,
        runtime: runtimeFor(
            artifacts.stageWorkPlan.node,
            candidateCommits
        )
    })
}

test('active writer events reject the legacy immutable-ledger wrapper', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/projection-v1-rejected-1.mjs',
            'src/projection-v1-rejected-2.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const artifacts = compileTwoSliceArtifacts(fixture)
    const active = startedWriterLedger(artifacts)

    assert.throws(() => project(artifacts, {
        schema: 'issue-orchestration.immutable-runtime-ledger.v1',
        events: active.events
    }), {
        code: 'runtime-projector-active-writer-ledger-v2-required'
    })
})

test('canonical ledger v2 projects the exact active writer attempt', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/projection-v2-active-1.mjs',
            'src/projection-v2-active-2.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const artifacts = compileTwoSliceArtifacts(fixture)
    const projection = project(
        artifacts,
        startedWriterLedger(artifacts)
    )
    const plan = artifacts.stageWorkPlan
    const writer = projection.writerStages[plan.node]

    assert.deepEqual({
        status: writer.status,
        planDigest: writer.planDigest,
        sliceDigest: writer.sliceDigest,
        compiledPromptDigest: writer.compiledPromptDigest,
        stageAttemptId: writer.stageAttemptId,
        stagePhase: writer.stagePhase,
        stageRole: writer.stageRole
    }, {
        status: 'active',
        planDigest: plan.planDigest,
        sliceDigest: artifacts.executableSlices[0].sliceDigest,
        compiledPromptDigest:
            artifacts.compiledPrompts[0].promptDigest,
        stageAttemptId: plan.stageAttemptId,
        stagePhase: 'test-contract',
        stageRole: 'test-owner'
    })
})

test('canonical test-contract predecessor projects the exact active implementation attempt', async (current) => {
    const filePath =
        'src/projection-canonical-implementation.mjs'
    const fixture = createWriterStageGitFixture({
        filePaths: [filePath]
    })
    current.after(() => fixture.dispose())
    const canonicalLedger = await buildCanonicalWriterStageLedger({
        current,
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node:
            'ExampleOrg/RepositoryA#1874:canonical-implementation-projection',
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId:
            'epoch-1874-canonical-implementation-projection-001',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [filePath],
        requiredFiles: [filePath],
        requiredCommands: [`node --check ${filePath}`],
        routingInputDigest:
            digest('canonical-implementation-projection-route'),
        sliceId: 'canonical-implementation-projection-slice-1'
    })
    const { artifacts } = canonicalLedger
    const { stageWorkPlan: plan } = artifacts
    const ledger = clone(canonicalLedger.ledger)
    ledger.events.push(sealCanonicalWriterLedgerEvent({
        ledger,
        actorRole: plan.stageRole,
        attemptId: plan.stageAttemptId,
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        toState: 'implementing-self-testing',
        payload: {
            transitionSchema:
                'issue-orchestration.transition.v2',
            actorId: 'canonical-projection-implementer',
            dispatchReceipt:
                createCanonicalWriterDispatchReceipt({
                    artifacts
                }),
            stageWorkPlan: plan,
            currentSlice: artifacts.executableSlice,
            executableSlice: artifacts.executableSlice,
            compiledPrompt: artifacts.compiledPrompt
        }
    }))

    const writer = project(artifacts, ledger)
        .writerStages[plan.node]
    assert.deepEqual({
        status: writer.status,
        planDigest: writer.planDigest,
        sliceDigest: writer.sliceDigest,
        compiledPromptDigest: writer.compiledPromptDigest,
        stageAttemptId: writer.stageAttemptId,
        stagePhase: writer.stagePhase,
        stageRole: writer.stageRole
    }, {
        status: 'active',
        planDigest: plan.planDigest,
        sliceDigest: artifacts.executableSlice.sliceDigest,
        compiledPromptDigest:
            artifacts.compiledPrompt.promptDigest,
        stageAttemptId: plan.stageAttemptId,
        stagePhase: 'implementation',
        stageRole: 'code-implementer'
    })
})

test('two sealed slices project only the ledger-owned ordered prefix and final gate', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/projection-two-slice-1.mjs',
            'src/projection-two-slice-2.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const artifacts = compileTwoSliceArtifacts(fixture)
    const plan = artifacts.stageWorkPlan
    const first = writerArtifactsFor(artifacts, 0)
    const second = writerArtifactsFor(artifacts, 1)
    const ledger = startedWriterLedger(artifacts)

    const firstPartialCheckpoint =
        buildVerifiedWriterProgressCheckpoint({
            current,
            artifacts: first,
            fixture,
            activateIndexes: [0],
            routeDigest: plan.routingInputDigest,
            status: 'partial'
        })
    appendWriterCheckpoint(
        ledger,
        first,
        firstPartialCheckpoint
    )
    const firstCheckpoint = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: first,
        fixture,
        activateIndexes: [0],
        routeDigest: plan.routingInputDigest,
        checkpointOrdinal: 2,
        previousCheckpointDigest:
            firstPartialCheckpoint.checkpoint.checkpointDigest,
        previousCheckpointVerificationReceiptDigest:
            firstPartialCheckpoint
                .checkpointVerificationReceipt.receiptDigest,
        previousMachineTracePrefixDigest:
            firstPartialCheckpoint
                .checkpointVerificationReceipt
                .machineTracePrefixDigest,
        previousMachineTracePrefixByteLength:
            firstPartialCheckpoint
                .checkpointVerificationReceipt
                .machineTracePrefixByteLength,
        previousMachineTraceSnapshot:
            firstPartialCheckpoint.machineRuntimeTrace.traceSnapshot,
        status: 'complete'
    })
    appendWriterCheckpoint(ledger, first, firstCheckpoint)
    let projection = project(artifacts, ledger)
    let writer = projection.writerStages[plan.node]
    assert.equal(writer.status, 'checkpointed')
    assertSanitizedCheckpointProjection(
        writer,
        firstCheckpoint.checkpointVerificationReceipt
    )
    const firstTerminal = terminalReceiptFor({
        plan,
        slice: first.executableSlice,
        compiledPrompt: first.compiledPrompt,
        verifiedCheckpoint: firstCheckpoint,
        previousMachineTraceSnapshot:
            firstPartialCheckpoint.machineRuntimeTrace.traceSnapshot
    })
    appendWriterTerminal({
        ledger,
        artifacts: first,
        verifiedCheckpoint: firstCheckpoint,
        terminalReceipt: firstTerminal,
        terminalReceipts: [firstTerminal],
        nextArtifacts: second
    })

    projection = project(artifacts, ledger)
    writer = projection.writerStages[plan.node]
    assert.deepEqual({
        status: writer.status,
        completedSliceReceiptDigests:
            writer.completedSliceReceiptDigests,
        sliceId: writer.sliceId,
        sliceDigest: writer.sliceDigest,
        compiledPromptDigest: writer.compiledPromptDigest,
        checkpointDigest: writer.checkpointDigest,
        expectedNextSliceId: writer.expectedNextSliceId,
        expectedNextSliceDigest: writer.expectedNextSliceDigest
    }, {
        status: 'next-slice',
        completedSliceReceiptDigests: [
            firstTerminal.receiptDigest
        ],
        sliceId: second.executableSlice.sliceId,
        sliceDigest: second.executableSlice.sliceDigest,
        compiledPromptDigest: second.compiledPrompt.promptDigest,
        checkpointDigest: null,
        expectedNextSliceId: second.executableSlice.sliceId,
        expectedNextSliceDigest: second.executableSlice.sliceDigest
    })
    assert.equal(writer.completedSlicePrefix.length, 1)
    assertSanitizedCheckpointProjection(
        writer.completedSlicePrefix[0],
        firstCheckpoint.checkpointVerificationReceipt
    )
    assert.deepEqual({
        sliceOrdinal: writer.completedSlicePrefix[0].sliceOrdinal,
        planSliceCount: writer.completedSlicePrefix[0].planSliceCount,
        priorTerminalReceiptDigests:
            writer.completedSlicePrefix[0]
                .priorTerminalReceiptDigests,
        terminalChainDigest:
            writer.completedSlicePrefix[0].terminalChainDigest
    }, {
        sliceOrdinal: 1,
        planSliceCount: 2,
        priorTerminalReceiptDigests: [],
        terminalChainDigest: firstTerminal.terminalChainDigest
    })
    assert.equal(writer.checkpointVerificationReceiptDigest, null)
    assert.equal(writer.machineTraceSnapshotDigest, null)
    assert.throws(() => project(artifacts, ledger, {
        [plan.node]: '4'.repeat(40)
    }), {
        code: 'runtime-projector-writer-candidate-premature'
    })

    const canonicalPrefix = replayEventLedgerSync(ledger)
        .nodes[plan.node].completedSlicePrefix
    const acceptedPriorChangedPaths = [
        ...new Set(canonicalPrefix.flatMap(
            ({ changedPaths }) => changedPaths
        ))
    ].sort()
    const secondCheckpoint = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: second,
        fixture,
        activateIndexes: [0, 1],
        routeDigest: plan.routingInputDigest,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest: digest(canonicalPrefix),
        status: 'complete'
    })
    appendWriterCheckpoint(ledger, second, secondCheckpoint)
    const secondTerminal = terminalReceiptFor({
        plan,
        slice: second.executableSlice,
        compiledPrompt: second.compiledPrompt,
        verifiedCheckpoint: secondCheckpoint,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest: digest(canonicalPrefix),
        priorTerminalReceipts: [firstTerminal]
    })
    appendWriterTerminal({
        ledger,
        artifacts: second,
        verifiedCheckpoint: secondCheckpoint,
        terminalReceipt: secondTerminal,
        terminalReceipts: [firstTerminal, secondTerminal]
    })
    projection = project(artifacts, ledger)
    writer = projection.writerStages[plan.node]
    assert.deepEqual({
        status: writer.status,
        completedSliceReceiptDigests:
            writer.completedSliceReceiptDigests,
        checkpointDigest: writer.checkpointDigest,
        terminalReceiptDigest: writer.terminalReceiptDigest,
        expectedNextSliceId: writer.expectedNextSliceId,
        expectedNextSliceDigest: writer.expectedNextSliceDigest,
        stageAttemptId: writer.stageAttemptId
    }, {
        status: 'completed',
        completedSliceReceiptDigests: [
            firstTerminal.receiptDigest,
            secondTerminal.receiptDigest
        ],
        checkpointDigest: secondCheckpoint.checkpoint.checkpointDigest,
        terminalReceiptDigest: secondTerminal.receiptDigest,
        expectedNextSliceId: null,
        expectedNextSliceDigest: null,
        stageAttemptId: plan.stageAttemptId
    })
    assert.equal(writer.completedSlicePrefix.length, 2)
    assertSanitizedCheckpointProjection(
        writer,
        secondCheckpoint.checkpointVerificationReceipt
    )
    assertSanitizedCheckpointProjection(
        writer.completedSlicePrefix[1],
        secondCheckpoint.checkpointVerificationReceipt
    )
    assert.deepEqual({
        sliceOrdinal: writer.completedSlicePrefix[1].sliceOrdinal,
        planSliceCount: writer.completedSlicePrefix[1].planSliceCount,
        priorTerminalReceiptDigests:
            writer.completedSlicePrefix[1]
                .priorTerminalReceiptDigests,
        terminalChainDigest: writer.terminalChainDigest
    }, {
        sliceOrdinal: 2,
        planSliceCount: 2,
        priorTerminalReceiptDigests: [firstTerminal.receiptDigest],
        terminalChainDigest: secondTerminal.terminalChainDigest
    })

    const proseOnly = clone(ledger)
    const proseCheckpointIndex = proseOnly.events.findIndex((event) =>
        event.eventType === 'writer-stage.checkpoint-recorded')
    const proseCheckpoint =
        proseOnly.events[proseCheckpointIndex].payload.checkpoint
    proseCheckpoint.evidence = {
        summary: 'all requested work is complete',
        satisfiedEvidenceIds: ['self-reported-green']
    }
    proseCheckpoint.evidence.evidenceDigest =
        digest(proseCheckpoint.evidence)
    proseCheckpoint.evidenceDigest =
        proseCheckpoint.evidence.evidenceDigest
    delete proseCheckpoint.checkpointDigest
    proseCheckpoint.checkpointDigest = digest(proseCheckpoint)
    resealEvents(proseOnly, proseCheckpointIndex)
    assert.throws(
        () => project(artifacts, proseOnly),
        (error) =>
            error.code ===
                'runtime-projector-active-writer-ledger-replay-invalid' &&
            typeof error.ledgerErrorCode === 'string'
    )

    const forkedCheckpoint = clone(ledger)
    const forkIndex = forkedCheckpoint.events.findIndex((event) =>
        event.eventType === 'writer-stage.checkpoint-recorded' &&
        event.payload.checkpointVerificationReceipt
            ?.checkpointOrdinal === 2)
    const forkReceipt =
        forkedCheckpoint.events[forkIndex]
            .payload.checkpointVerificationReceipt
    forkReceipt.previousCheckpointDigest = 'f'.repeat(64)
    delete forkReceipt.receiptDigest
    forkReceipt.receiptDigest = digest(forkReceipt)
    resealEvents(forkedCheckpoint, forkIndex)
    assert.throws(
        () => project(artifacts, forkedCheckpoint),
        (error) =>
            error.code ===
                'runtime-projector-active-writer-ledger-replay-invalid' &&
            typeof error.ledgerErrorCode === 'string'
    )

    const permutedPrefix = clone(ledger)
    const terminalIndex = permutedPrefix.events.findIndex((event) =>
        event.eventType === 'writer-stage.completed')
    permutedPrefix.events[terminalIndex]
        .payload.sliceTerminalReceipts.reverse()
    resealEvents(permutedPrefix, terminalIndex)
    assert.throws(
        () => project(artifacts, permutedPrefix),
        (error) =>
            error.code ===
                'runtime-projector-active-writer-ledger-replay-invalid' &&
            typeof error.ledgerErrorCode === 'string'
    )
})
