import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
    compileVerifiedWriterStageContinuation,
    evaluateWriterStageObservation,
    evaluateSliceTerminalGate,
    sealSliceTerminalReceipt,
    sealWriterStageEvidenceReceipt,
    sealWriterStageRuntimeProgressObservation,
    validateSealedWriterStageCheckpointEvidence,
    validateWriterStageCheckpointEvidence
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    sealProgressCheckpoint,
    writerStageAuthorityLocation
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    observeWriterStageCheckpointEvidence,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function seal(value, field) {
    const result = structuredClone(value)
    delete result[field]
    result[field] = digest(result)
    return result
}

function binding(plan, slice, compiledPromptDigest, routeDigest) {
    return {
        runId: plan.runId,
        repository: plan.repository,
        issue: plan.issue,
        node: plan.node,
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        routeDigest,
        compiledPromptDigest,
        stageAttemptId: plan.stageAttemptId,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        resourceLeaseReceiptDigest: plan.resourceLeaseReceiptDigest,
        runtimeStateRootDigest: plan.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            plan.runtimeAuthorityIdentityDigest
    }
}

function operationRecord({
    binding: identity,
    sequence,
    kind,
    startedAt,
    completedAt,
    targetPath = null,
    toolName = null,
    command = null,
    writePath = null,
    evidenceReceiptDigest = null,
    artifactReceiptDigest = null,
    checkpointKind = null,
    checkpointStatus = null,
    nextRequiredAction = null
}) {
    return {
        type: 'event_msg',
        payload: seal({
            type: 'writer_stage_operation',
            source: 'machine-runtime-instrumentation',
            identity,
            sequence,
            kind,
            startedAt,
            completedAt,
            targetPath,
            toolName,
            command,
            writePath,
            evidenceReceiptDigest,
            artifactReceiptDigest,
            checkpointKind,
            checkpointStatus,
            nextRequiredAction
        }, 'observationDigest')
    }
}

function externalTrace({
    current,
    plan,
    slice,
    compiledPromptDigest,
    records,
    routeDigest
}) {
    const runtimeObservation = {
        schema: 'issue-orchestration.runtime-observation.v2',
        rolloutId: `rollout-${slice.sliceId}`,
        threadId: `thread-${slice.sliceId}`,
        effectiveWorkingDirectory: plan.worktreeIdentity
    }
    const dispatchReceipt = seal({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        runId: plan.runId,
        nodeId: plan.node,
        attemptId: plan.stageAttemptId,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        planDigest: plan.planDigest,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        actualWorkingDirectory: plan.worktreeIdentity,
        rolloutId: runtimeObservation.rolloutId,
        threadId: runtimeObservation.threadId,
        runtimeMetadataDigest: digest(runtimeObservation),
        verificationStatus: 'verified'
    }, 'receiptDigest')
    const rolloutRecords = [
        {
            type: 'session_meta',
            payload: {
                id: runtimeObservation.rolloutId,
                session_id: runtimeObservation.threadId
            }
        },
        ...records
    ]
    const source = `${rolloutRecords.map((record) =>
        JSON.stringify(canonical(record))).join('\n')}\n`
    const authorityLocation = writerStageAuthorityLocation({
        runId: plan.runId,
        node: plan.node,
        stageAttemptId: plan.stageAttemptId
    })
    const traceSnapshot = seal({
        schema:
            'issue-orchestration.machine-writer-runtime-trace-snapshot.v1',
        records: rolloutRecords.map(canonical),
        prefixByteLength: Buffer.byteLength(source),
        prefixDigest:
            createHash('sha256').update(source).digest('hex'),
        recordCount: rolloutRecords.length,
        checkpointOrdinal: 1,
        previousPrefixDigest: null,
        previousPrefixByteLength: null
    }, 'snapshotDigest')
    const tracePath = path.join(
        path.dirname(authorityLocation.writerLeasePath),
        'runtime-rollout-snapshots',
        `${traceSnapshot.prefixDigest}.jsonl`
    )
    fs.mkdirSync(path.dirname(tracePath), { recursive: true })
    if (fs.existsSync(tracePath)) {
        assert.equal(fs.readFileSync(tracePath, 'utf8'), source)
    } else {
        fs.writeFileSync(tracePath, source, {
            flag: 'wx',
            mode: 0o444
        })
        fs.chmodSync(tracePath, 0o444)
    }
    current.after(() => {
        if (!fs.existsSync(tracePath)) return
        fs.chmodSync(tracePath, 0o600)
        fs.rmSync(tracePath, { force: true })
    })
    return seal({
        schema:
            'issue-orchestration.machine-writer-runtime-trace-handle.v1',
        source: 'codex-rollout-jsonl',
        verificationStatus: 'verified',
        tracePath: fs.realpathSync(tracePath),
        traceDigest: traceSnapshot.prefixDigest,
        traceSnapshot,
        runtimeStateRootDigest: plan.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            plan.runtimeAuthorityIdentityDigest,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        resourceLeaseReceiptDigest: plan.resourceLeaseReceiptDigest,
        routeDigest,
        runtimeObservation,
        dispatchReceipt
    }, 'receiptDigest')
}

function replaceTraceSnapshot({
    current,
    machineRuntimeTrace,
    source
}) {
    const records = source.split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    const canonicalSource = `${records.map((record) =>
        JSON.stringify(canonical(record))).join('\n')}\n`
    const traceSnapshot = seal({
        schema:
            'issue-orchestration.machine-writer-runtime-trace-snapshot.v1',
        records: records.map(canonical),
        prefixByteLength: Buffer.byteLength(canonicalSource),
        prefixDigest:
            createHash('sha256').update(canonicalSource).digest('hex'),
        recordCount: records.length,
        checkpointOrdinal:
            machineRuntimeTrace.traceSnapshot.checkpointOrdinal,
        previousPrefixDigest:
            machineRuntimeTrace.traceSnapshot.previousPrefixDigest,
        previousPrefixByteLength:
            machineRuntimeTrace.traceSnapshot.previousPrefixByteLength
    }, 'snapshotDigest')
    const tracePath = path.join(
        path.dirname(machineRuntimeTrace.tracePath),
        `${traceSnapshot.prefixDigest}.jsonl`
    )
    fs.writeFileSync(tracePath, canonicalSource, { mode: 0o444 })
    fs.chmodSync(tracePath, 0o444)
    current.after(() => {
        if (!fs.existsSync(tracePath)) return
        fs.chmodSync(tracePath, 0o600)
        fs.rmSync(tracePath, { force: true })
    })
    return seal({
        ...machineRuntimeTrace,
        tracePath: fs.realpathSync(tracePath),
        traceDigest: traceSnapshot.prefixDigest,
        traceSnapshot
    }, 'receiptDigest')
}

function artifactsFor({
    fixture,
    stagePhase = 'implementation',
    stageRole = 'code-implementer',
    requiredEvidence = ['filesystem-git-command-evidence'],
    sliceId = `progress-evidence-slice-${
        digest(fixture.worktreeIdentity).slice(0, 12)
    }`
}) {
    return compileWriterStageTestArtifacts({
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: 'ExampleOrg/RepositoryA#1874',
        stageRole,
        stagePhase,
        baseSha: fixture.baseSha,
        epochId: 'epoch-progress-evidence-1',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: ['src/**'],
        requiredFiles: ['src/a.mjs'],
        requiredCommands: ['node --check src/a.mjs'],
        requiredEvidence,
        sliceId,
        runId: `run-${sliceId}`,
        stageAttemptId: `attempt-${sliceId}`
    })
}

function defaultOperations(
    identity,
    commandReceiptDigest,
    fileReceiptDigest,
    checkpointStatus,
    sliceId
) {
    return [
        operationRecord({
            binding: identity,
            sequence: 1,
            kind: 'read-only',
            startedAt: '2026-08-02T00:00:01.000Z',
            completedAt: '2026-08-02T00:00:01.010Z',
            targetPath: 'src/a.mjs',
            evidenceReceiptDigest: fileReceiptDigest
        }),
        operationRecord({
            binding: identity,
            sequence: 2,
            kind: 'tool-call',
            startedAt: '2026-08-02T00:00:02.000Z',
            completedAt: '2026-08-02T00:00:02.010Z',
            toolName: 'exec',
            command: 'node --check src/a.mjs',
            evidenceReceiptDigest: commandReceiptDigest
        }),
        operationRecord({
            binding: identity,
            sequence: 3,
            kind: 'artifact',
            startedAt: '2026-08-02T00:00:03.000Z',
            completedAt: '2026-08-02T00:00:03.010Z',
            writePath: 'src/a.mjs',
            evidenceReceiptDigest: fileReceiptDigest,
            artifactReceiptDigest: fileReceiptDigest
        }),
        operationRecord({
            binding: identity,
            sequence: 4,
            kind: 'checkpoint',
            startedAt: '2026-08-02T00:00:04.000Z',
            completedAt: '2026-08-02T00:00:04.010Z',
            checkpointKind: 'stage-progress',
            checkpointStatus,
            nextRequiredAction: checkpointStatus === 'complete'
                ? null
                : `complete:${sliceId}`
        })
    ]
}

function checkpointInput({ plan, slice, evidence, status = 'complete' }) {
    return {
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        runId: plan.runId,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        verificationStatus: plan.contractBindingStatus === 'verified'
            ? 'verified'
            : 'unbound-test-only',
        status,
        cursor: {
            kind: 'executable-slice-action',
            completedActionCount: 3,
            nextActionIndex: 4,
            lastCompletedAction: 'artifact:src/a.mjs'
        },
        nextRequiredAction: status === 'complete'
            ? null
            : `complete:${slice.sliceId}`,
        evidence,
        evidenceDigest: evidence.evidenceDigest
    }
}

function buildVerifiedCheckpoint({
    current,
    fixture,
    status = 'complete'
}) {
    const artifacts = artifactsFor({ fixture })
    return buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts,
        fixture,
        activateIndexes: 0,
        status,
        routeDigest: writerTestDigest({
        route: 'code-implementation',
            sliceDigest: artifacts.executableSlice.sliceDigest
        })
    })
}

test('verified checkpoint requires replayable typed receipts and an external rollout trace', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const {
        artifacts,
        checkpoint,
        routeDigest
    } = buildVerifiedCheckpoint({ current, fixture })

    assert.deepEqual(validateWriterStageCheckpointEvidence({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest
    }), [])
})

test('sealed checkpoint replay survives live authority retirement and rejects tampering', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const {
        artifacts,
        checkpoint,
        checkpointVerificationReceipt,
        routeDigest
    } = buildVerifiedCheckpoint({ current, fixture })
    const options = {
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint,
        compiledPrompt: artifacts.compiledPrompt,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        checkpointVerificationReceipt,
        sealedAuthority: {
            expectedSourceEventDigest:
                artifacts.stageWorkPlan.sourceEventDigest,
            expectedSourceLedgerDigest:
                artifacts.stageWorkPlan.sourceLedgerDigest
        }
    }
    assert.deepEqual(
        validateSealedWriterStageCheckpointEvidence({
            ...options,
            verificationReceipt: checkpointVerificationReceipt
        }),
        []
    )

    const authorityLocation = writerStageAuthorityLocation({
        runId: artifacts.stageWorkPlan.runId,
        node: artifacts.stageWorkPlan.node,
        stageAttemptId: artifacts.stageWorkPlan.stageAttemptId
    })
    const tracePath = checkpoint.evidence.machineRuntimeTrace.tracePath
    fs.chmodSync(tracePath, 0o600)
    fs.rmSync(tracePath, { force: true })
    fs.rmSync(authorityLocation.writerLeasePath, { force: true })
    fs.appendFileSync(
        path.join(fixture.worktreeIdentity, 'src/a.mjs'),
        "export const retiredAuthorityMutation = true\n"
    )

    assert.deepEqual(
        validateSealedWriterStageCheckpointEvidence({
            ...options,
            verificationReceipt: checkpointVerificationReceipt
        }),
        []
    )
    assert.notDeepEqual(validateWriterStageCheckpointEvidence(options), [])

    const tamperedReceipt = {
        ...checkpointVerificationReceipt,
        verifiedAt: '2026-08-02T00:02:00.000Z'
    }
    assert.ok(validateSealedWriterStageCheckpointEvidence({
        ...options,
        verificationReceipt: tamperedReceipt
    }).some((error) => /verification receipt/iu.test(error)))

    const tamperedCheckpoint = structuredClone(checkpoint)
    tamperedCheckpoint.evidence.machineRuntimeTrace
        .traceSnapshot.records.push({
            type: 'assistant',
            payload: {
                authorization: 'Bearer should-never-enter-ledger'
            }
        })
    assert.ok(validateSealedWriterStageCheckpointEvidence({
        ...options,
        checkpoint: tamperedCheckpoint,
        verificationReceipt: checkpointVerificationReceipt
    }).some((error) => /snapshot|checkpoint|receipt/iu.test(error)))
})

test('checkpoint fork chain requires an exact sanitized immutable prefix', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const artifacts = artifactsFor({ fixture })
    const first = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts,
        fixture,
        activateIndexes: 0,
        status: 'partial'
    })
    const firstSnapshot =
        first.machineRuntimeTrace.traceSnapshot
    const sealedAuthority = {
        expectedSourceEventDigest:
            artifacts.stageWorkPlan.sourceEventDigest,
        expectedSourceLedgerDigest:
            artifacts.stageWorkPlan.sourceLedgerDigest
    }
    const continuation = compileVerifiedWriterStageContinuation({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint: first.checkpoint,
        compiledPrompt: artifacts.compiledPrompt,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest: first.routeDigest,
        checkpointVerificationReceipt:
            first.checkpointVerificationReceipt,
        sealedAuthority
    })
    assert.equal(
        continuation.checkpointVerificationReceiptDigest,
        first.checkpointVerificationReceipt.receiptDigest
    )
    assert.equal(continuation.checkpointOrdinal, 1)
    assert.equal(continuation.previousCheckpointDigest, null)
    const second = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts,
        fixture,
        activateIndexes: 0,
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
    const sourceFor = (snapshot) => `${snapshot.records.map((record) =>
        JSON.stringify(canonical(record))).join('\n')}\n`
    assert.ok(
        sourceFor(second.machineRuntimeTrace.traceSnapshot)
            .startsWith(sourceFor(firstSnapshot))
    )
    const sealedOptions = {
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint: second.checkpoint,
        compiledPrompt: artifacts.compiledPrompt,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest: second.routeDigest,
        checkpointOrdinal: 2,
        previousCheckpointDigest:
            first.checkpoint.checkpointDigest,
        previousCheckpointVerificationReceiptDigest:
            first.checkpointVerificationReceipt.receiptDigest,
        previousMachineTracePrefixDigest:
            firstSnapshot.prefixDigest,
        previousMachineTracePrefixByteLength:
            firstSnapshot.prefixByteLength,
        previousMachineTraceSnapshot: firstSnapshot,
        sealedAuthority,
        verificationReceipt:
            second.checkpointVerificationReceipt
    }
    assert.deepEqual(
        validateSealedWriterStageCheckpointEvidence(sealedOptions),
        []
    )
    assert.ok(validateSealedWriterStageCheckpointEvidence({
        ...sealedOptions,
        previousMachineTraceSnapshot: null
    }).some((error) => /prior immutable snapshot/iu.test(error)))

    const secretCheckpoint = structuredClone(second.checkpoint)
    secretCheckpoint.evidence.machineRuntimeTrace
        .traceSnapshot.records.push({
            type: 'event_msg',
            payload: {
                authorization: 'Bearer forbidden-secret-material'
            }
        })
    assert.ok(validateSealedWriterStageCheckpointEvidence({
        ...sealedOptions,
        checkpoint: secretCheckpoint
    }).some((error) => /sanitized|snapshot|checkpoint/iu.test(error)))
})

test('terminal receipt binds checkpoint verification and ordered slice chain', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const {
        artifacts,
        checkpoint,
        checkpointVerificationReceipt,
        routeDigest
    } = buildVerifiedCheckpoint({ current, fixture })
    const sealedAuthority = {
        expectedSourceEventDigest:
            artifacts.stageWorkPlan.sourceEventDigest,
        expectedSourceLedgerDigest:
            artifacts.stageWorkPlan.sourceLedgerDigest
    }
    const terminalReceipt = sealSliceTerminalReceipt({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint,
        compiledPrompt: artifacts.compiledPrompt,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        checkpointVerificationReceipt,
        sealedAuthority,
        completedSlicePrefixDigest: digest([]),
        priorTerminalReceipts: [],
        changedPaths: ['src/a.mjs'],
        commandEvidenceDigests:
            checkpoint.evidence.commands.map((entry) =>
                entry.outputDigest)
    })
    assert.equal(terminalReceipt.sliceOrdinal, 1)
    assert.equal(terminalReceipt.planSliceCount, 1)
    assert.deepEqual(terminalReceipt.priorTerminalReceiptDigests, [])
    assert.equal(
        terminalReceipt.checkpointVerificationReceiptDigest,
        checkpointVerificationReceipt.receiptDigest
    )
    assert.match(terminalReceipt.terminalChainDigest, /^[a-f0-9]{64}$/u)
    const gate = evaluateSliceTerminalGate({
        plan: artifacts.stageWorkPlan,
        currentSlice: artifacts.executableSlice,
        currentCheckpoint: checkpoint,
        compiledPrompt: artifacts.compiledPrompt,
        checkpointVerificationReceipt,
        sealedAuthority,
        completedSlicePrefixDigest: digest([]),
        terminalReceipts: [terminalReceipt]
    })
    assert.equal(gate.nextState, 'candidate-green')
})

test('complete checkpoint rejects omitted machine-observed required work', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const {
        artifacts,
        checkpoint,
        routeDigest
    } = buildVerifiedCheckpoint({ current, fixture })
    const machineRuntimeTrace =
        checkpoint.evidence.machineRuntimeTrace
    const records = fs.readFileSync(
        machineRuntimeTrace.tracePath,
        'utf8'
    ).trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    const commandRecord = records.find((record) =>
        record?.payload?.kind === 'tool-call')
    commandRecord.payload.evidenceReceiptDigest = null
    commandRecord.payload.observationDigest = digest(
        Object.fromEntries(Object.entries(commandRecord.payload)
            .filter(([field]) => field !== 'observationDigest'))
    )
    const mutatedSource = `${records.map((record) =>
        JSON.stringify(record)).join('\n')}\n`
    const mutatedTrace = replaceTraceSnapshot({
        current,
        machineRuntimeTrace,
        source: mutatedSource
    })

    assert.throws(() => sealWriterStageRuntimeProgressObservation({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        checkpointEvidence: checkpoint.evidence,
        typedEvidenceReceipts:
            checkpoint.evidence.typedEvidenceReceipts,
        machineRuntimeTrace: mutatedTrace
    }), /complete checkpoint is missing machine-observed required/iu)

    const noArtifactRecords = fs.readFileSync(
        machineRuntimeTrace.tracePath,
        'utf8'
    ).trim().split(/\r?\n/u).map((line) => JSON.parse(line))
        .filter((record) => record?.payload?.kind !== 'artifact')
    const terminalRecord = noArtifactRecords.find((record) =>
        record?.payload?.kind === 'checkpoint')
    terminalRecord.payload.sequence -= 1
    terminalRecord.payload.observationDigest = digest(
        Object.fromEntries(Object.entries(terminalRecord.payload)
            .filter(([field]) => field !== 'observationDigest'))
    )
    const noArtifactSource = `${noArtifactRecords.map((record) =>
        JSON.stringify(record)).join('\n')}\n`
    const noArtifactTrace = replaceTraceSnapshot({
        current,
        machineRuntimeTrace,
        source: noArtifactSource
    })
    assert.throws(() => sealWriterStageRuntimeProgressObservation({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        checkpointEvidence: checkpoint.evidence,
        typedEvidenceReceipts:
            checkpoint.evidence.typedEvidenceReceipts,
        machineRuntimeTrace: noArtifactTrace
    }), /complete checkpoint is missing machine-observed required/iu)
})

test('typed artifact claims cannot replace the required Git changed delta', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs', 'src/b.mjs']
    })
    current.after(() => fixture.dispose())
    const artifacts = artifactsFor({ fixture })

    assert.throws(() => buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts,
        fixture,
        activateIndexes: 1
    }), /required.*current.*delta|changed.*required|filesystem evidence|current slice/iu)
})

test('satisfiedEvidenceIds and arbitrary hash-shaped claims cannot replace typed receipts', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    fixture.activate(0)
    const artifacts = artifactsFor({ fixture })
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice: artifacts.executableSlice
    })
    const checkpoint = sealProgressCheckpoint({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint: checkpointInput({
            plan: artifacts.stageWorkPlan,
            slice: artifacts.executableSlice,
            evidence
        })
    })
    const errors = validateWriterStageCheckpointEvidence({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest: 'a'.repeat(64)
    })

    assert.ok(errors.some((error) =>
        /satisfiedEvidenceIds alone|typed evidence receipts/iu.test(error)))
})

test('UI render, conflict mapping and documentation no-change receipts re-observe real content', (current) => {
    const uiFixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => uiFixture.dispose())
    uiFixture.activate(0)
    const ui = artifactsFor({
        fixture: uiFixture,
        stagePhase: 'ui-implementation',
        stageRole: 'ui-ux-implementer',
        requiredEvidence: ['ui-render-evidence'],
        sliceId: 'ui-render-evidence-slice'
    })
    const uiEvidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: uiFixture.worktreeIdentity,
        slice: ui.executableSlice
    })
    assert.throws(() => sealWriterStageEvidenceReceipt({
        plan: ui.stageWorkPlan,
        slice: ui.executableSlice,
        compiledPromptDigest: ui.compiledPrompt.promptDigest,
        routeDigest: '1'.repeat(64),
        checkpointEvidence: uiEvidence,
        evidenceId: 'ui-render-evidence',
        evidenceType: 'ui-render',
        payload: {
            artifactPath: 'src/a.mjs',
            realPath: uiEvidence.requiredFiles[0].realPath,
            gitObjectDigest: uiEvidence.requiredFiles[0].gitObjectDigest,
            contentDigest: 'f'.repeat(64),
            renderer: 'browser',
            viewport: '1280x720'
        }
    }), /content digest mismatch/iu)

    const landing = artifactsFor({
        fixture: uiFixture,
        stagePhase: 'landing-conflict-resolution',
        stageRole: 'code-implementer',
        requiredEvidence: ['conflict-mapping'],
        sliceId: 'conflict-mapping-slice'
    })
    const landingEvidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: uiFixture.worktreeIdentity,
        slice: landing.executableSlice
    })
    assert.throws(() => sealWriterStageEvidenceReceipt({
        plan: landing.stageWorkPlan,
        slice: landing.executableSlice,
        compiledPromptDigest: landing.compiledPrompt.promptDigest,
        routeDigest: '2'.repeat(64),
        checkpointEvidence: landingEvidence,
        evidenceId: 'conflict-mapping',
        evidenceType: 'conflict-mapping',
        payload: {
            entries: [{
                sourceRevision: uiFixture.baseSha,
                sourcePath: 'src/a.mjs',
                sourceGitObjectDigest: 'a'.repeat(40),
                destinationPath: 'src/a.mjs',
                destinationGitObjectDigest:
                    landingEvidence.requiredFiles[0].gitObjectDigest
            }]
        }
    }), /observable Git objects|source or destination/iu)

    const docsFixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => docsFixture.dispose())
    const docs = artifactsFor({
        fixture: docsFixture,
        stagePhase: 'documentation',
        stageRole: 'documentation-writer',
        requiredEvidence: ['verified-no-change-evidence'],
        sliceId: 'documentation-no-change-slice'
    })
    const docsEvidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: docsFixture.worktreeIdentity,
        slice: docs.executableSlice
    })
    assert.throws(() => sealWriterStageEvidenceReceipt({
        plan: docs.stageWorkPlan,
        slice: docs.executableSlice,
        compiledPromptDigest: docs.compiledPrompt.promptDigest,
        routeDigest: '3'.repeat(64),
        checkpointEvidence: docsEvidence,
        evidenceId: 'verified-no-change-evidence',
        evidenceType: 'documentation-no-change',
        payload: {
            headSha: docsFixture.baseSha,
            worktreeStatus: ' M docs/fabricated.md',
            inspectedFiles: [docsEvidence.requiredFiles[0]]
        }
    }), /independently clean worktree/iu)
})

test('capacity and safe checkpoint thresholds are derived from raw machine records', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs', 'src/b.mjs']
    })
    current.after(() => fixture.dispose())
    fixture.activate(0)
    const artifacts = artifactsFor({ fixture })
    const {
        stageWorkPlan: plan,
        executableSlice: slice,
        compiledPrompt
    } = artifacts
    const routeDigest = '4'.repeat(64)
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice
    })
    const receipt = sealWriterStageEvidenceReceipt({
        plan,
        slice,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest,
        checkpointEvidence: evidence,
        evidenceId: slice.requiredEvidence[0],
        evidenceType: 'file',
        payload: evidence.requiredFiles[0]
    })
    const identity = binding(
        plan,
        slice,
        compiledPrompt.promptDigest,
        routeDigest
    )
    const attempt = ({
        records,
        checkpointKind = slice.safeCheckpointKind
    }) => {
        const lastCompletedAt = records.at(-1)?.payload?.completedAt ??
            '2026-08-02T00:00:01.001Z'
        const checkpointStartedAt = new Date(
            Date.parse(lastCompletedAt) + 1_000
        ).toISOString()
        const checkpointCompletedAt = new Date(
            Date.parse(lastCompletedAt) + 1_001
        ).toISOString()
        const tracedRecords = [
            ...records,
            operationRecord({
                binding: identity,
                sequence: records.length + 1,
                kind: 'checkpoint',
                startedAt: checkpointStartedAt,
                completedAt: checkpointCompletedAt,
                checkpointKind,
                checkpointStatus: 'complete',
                nextRequiredAction: null
            })
        ]
        const machineRuntimeTrace = externalTrace({
            current,
            plan,
            slice,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDigest,
            records: tracedRecords
        })
        return () => sealWriterStageRuntimeProgressObservation({
            plan,
            slice,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDigest,
            checkpointEvidence: evidence,
            typedEvidenceReceipts: [receipt],
            machineRuntimeTrace
        })
    }
    const record = (sequence, kind, startedAt, completedAt, fields = {}) =>
        operationRecord({
            binding: identity,
            sequence,
            kind,
            startedAt,
            completedAt,
            ...fields
        })

    const canonicalTrace = externalTrace({
        current,
        plan,
        slice,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest,
        records: [
            record(1, 'checkpoint',
                '2026-08-02T00:00:01.000Z',
                '2026-08-02T00:00:01.001Z',
                {
                    checkpointKind: slice.safeCheckpointKind,
                    checkpointStatus: 'complete',
                    nextRequiredAction: null
                })
        ]
    })
    const selfMintedPath = path.join(
        fixture.worktreeIdentity,
        'self-minted-rollout.jsonl'
    )
    fs.copyFileSync(canonicalTrace.tracePath, selfMintedPath)
    fs.chmodSync(selfMintedPath, 0o444)
    current.after(() => {
        if (!fs.existsSync(selfMintedPath)) return
        fs.chmodSync(selfMintedPath, 0o600)
        fs.rmSync(selfMintedPath, { force: true })
    })
    const selfMintedTrace = seal({
        ...canonicalTrace,
        tracePath: fs.realpathSync(selfMintedPath)
    }, 'receiptDigest')
    assert.throws(() => sealWriterStageRuntimeProgressObservation({
        plan,
        slice,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest,
        checkpointEvidence: evidence,
        typedEvidenceReceipts: [receipt],
        machineRuntimeTrace: selfMintedTrace
    }), /canonical|external rollout|machine trace|authority/iu)

    assert.throws(attempt({
        records: [
            record(1, 'read-only',
                '2026-08-02T00:00:01.000Z',
                '2026-08-02T00:00:01.001Z',
                { targetPath: 'src/a.mjs' }),
            record(2, 'read-only',
                '2026-08-02T00:00:02.000Z',
                '2026-08-02T00:00:02.001Z',
                { targetPath: 'src/b.mjs' })
        ]
    }), /maxOwnedModules/iu)

    assert.throws(attempt({
        records: Array.from({ length: 9 }, (_, index) =>
            record(
                index + 1,
                'read-only',
                `2026-08-02T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
                `2026-08-02T00:00:${String(index + 1).padStart(2, '0')}.001Z`,
                { targetPath: 'src/a.mjs' }
            ))
    }), /maxReadOnlyOperationsBeforeCheckpoint/iu)

    assert.throws(attempt({
        records: Array.from({ length: 7 }, (_, index) =>
            record(
                index + 1,
                'tool-call',
                `2026-08-02T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
                `2026-08-02T00:00:${String(index + 1).padStart(2, '0')}.001Z`,
                {
                    toolName: 'exec',
                    command: slice.requiredCommands[0]
                }
            ))
    }), /maxNoArtifactToolCalls/iu)

    assert.throws(attempt({
        records: [
            record(1, 'tool-call',
                '2026-08-02T00:00:00.000Z',
                '2026-08-02T00:00:00.001Z',
                {
                    toolName: 'exec',
                    command: slice.requiredCommands[0]
                }),
            record(2, 'tool-call',
                '2026-08-02T00:06:00.000Z',
                '2026-08-02T00:06:00.001Z',
                {
                    toolName: 'exec',
                    command: slice.requiredCommands[0]
                })
        ]
    }), /maxNoArtifactActiveDurationClass/iu)

    assert.throws(attempt({
        checkpointKind: 'unsafe-freeform',
        records: [
            record(1, 'tool-call',
                '2026-08-02T00:00:01.000Z',
                '2026-08-02T00:00:01.001Z',
                {
                    toolName: 'exec',
                    command: slice.requiredCommands[0]
                })
        ]
    }), /safeCheckpointKind|checkpoint kind/iu)
})

test('first action and checkpoint cursor are derived from the trusted operation prefix', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const {
        artifacts,
        checkpoint,
        routeDigest
    } = buildVerifiedCheckpoint({ current, fixture })
    const forgedCursorInput = structuredClone(checkpoint)
    delete forgedCursorInput.checkpointDigest
    forgedCursorInput.cursor = {
        ...forgedCursorInput.cursor,
        completedActionCount: 999,
        nextActionIndex: 1_000,
        lastCompletedAction: 'caller-claimed-progress'
    }
    try {
        const forgedCursor = sealProgressCheckpoint({
            plan: artifacts.stageWorkPlan,
            slice: artifacts.executableSlice,
            checkpoint: forgedCursorInput
        })
        assert.ok(validateWriterStageCheckpointEvidence({
            plan: artifacts.stageWorkPlan,
            slice: artifacts.executableSlice,
            checkpoint: forgedCursor,
            compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
            routeDigest
        }).some((error) => /cursor|operation prefix/iu.test(error)))
    } catch (error) {
        assert.match(error.message, /cursor|action|checkpoint/iu)
    }

    const tracePath = checkpoint.evidence.machineRuntimeTrace.tracePath
    const records = fs.readFileSync(tracePath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line))
    const commandRecord = records.find((record) =>
        record?.payload?.kind === 'tool-call')
    commandRecord.payload.command = 'echo caller-changed-first-action'
    commandRecord.payload.observationDigest = digest(
        Object.fromEntries(Object.entries(commandRecord.payload)
            .filter(([field]) => field !== 'observationDigest'))
    )
    const mutatedSource = `${records.map((record) =>
        JSON.stringify(record)).join('\n')}\n`
    const machineRuntimeTrace = replaceTraceSnapshot({
        current,
        machineRuntimeTrace:
            checkpoint.evidence.machineRuntimeTrace,
        source: mutatedSource
    })
    assert.throws(() => sealWriterStageRuntimeProgressObservation({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        checkpointEvidence: checkpoint.evidence,
        typedEvidenceReceipts:
            checkpoint.evidence.typedEvidenceReceipts,
        machineRuntimeTrace
    }), /first action|firstReadTargets|operation kind/iu)
})

test('trace mutation fails continuation and terminal failure evaluation closed', (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/a.mjs']
    })
    current.after(() => fixture.dispose())
    const {
        artifacts,
        checkpoint,
        routeDigest
    } = buildVerifiedCheckpoint({
        current,
        fixture,
        status: 'partial'
    })
    const tracePath = checkpoint.evidence.machineRuntimeTrace.tracePath
    fs.chmodSync(tracePath, 0o644)
    fs.appendFileSync(tracePath, '{"tampered":true}\n')
    fs.chmodSync(tracePath, 0o444)

    assert.throws(() => compileVerifiedWriterStageContinuation({
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlice,
        checkpoint,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest
    }), /machine evidence|trace|digest|checkpoint/iu)

    const commandEvidence = checkpoint.evidence.commands
    const observation = {
        schema: 'issue-orchestration.writer-stage-observation.v1',
        runId: artifacts.stageWorkPlan.runId,
        repository: artifacts.stageWorkPlan.repository,
        issue: artifacts.stageWorkPlan.issue,
        node: artifacts.stageWorkPlan.node,
        baseSha: artifacts.stageWorkPlan.baseSha,
        epochId: artifacts.stageWorkPlan.epochId,
        worktreeIdentity: artifacts.stageWorkPlan.worktreeIdentity,
        sliceId: artifacts.executableSlice.sliceId,
        sliceDigest: artifacts.executableSlice.sliceDigest,
        planDigest: artifacts.stageWorkPlan.planDigest,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        stageRole: artifacts.executableSlice.stageRole,
        stagePhase: artifacts.executableSlice.stagePhase,
        attemptId: artifacts.stageWorkPlan.stageAttemptId,
        agentId: 'agent-progress-evidence',
        plan: artifacts.stageWorkPlan,
        currentSlice: artifacts.executableSlice,
        invocationObservation: { started: true },
        environmentObservation: { ready: true },
        runtimeCapabilityObservation: {
            available: true,
            effectiveMetadataObserved: true
        },
        firstRequiredActionExecuted: true,
        filesystemObservation: {
            createdFiles: [],
            modifiedFiles: checkpoint.evidence.requiredFiles,
            treeDigest: checkpoint.treeDigest
        },
        gitObservation: {
            changedPaths: ['src/a.mjs'],
            diffDigest: checkpoint.diffDigest,
            unauthorizedPaths: []
        },
        commandObservation: {
            commands: commandEvidence.map(({ command }) => command),
            statuses: commandEvidence.map(({ exitStatus }) => exitStatus),
            evidenceDigests:
                commandEvidence.map(({ outputDigest }) => outputDigest)
        },
        checkpoint,
        terminalReceipt: null,
        sliceTerminalReceipts: []
    }
    const result = evaluateWriterStageObservation(observation)

    assert.equal(result.status, 'failed')
    assert.equal(result.eventType, 'writer-stage.receipt-rejected')
    assert.ok(result.failureReceipt.receiptValidationErrors.some((error) =>
        /trace|rollout|checkpoint/iu.test(error)))
})
