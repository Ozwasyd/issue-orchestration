import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
    sealWriterStageEvidenceReceipt,
    sealWriterStageRuntimeProgressObservation,
    verifyWriterStageCheckpointLiveEvidence
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    sealProgressCheckpoint,
    writerStageAuthorityLocation
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    observeWriterStageCheckpointEvidence,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

export function writerProgressTestDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

export function sealWriterProgressTestValue(value, digestField) {
    const result = structuredClone(value)
    delete result[digestField]
    result[digestField] = writerProgressTestDigest(result)
    return result
}

export function writerProgressBinding(
    plan,
    slice,
    compiledPromptDigest,
    routeDigest
) {
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

export function writerProgressOperationRecord({
    binding,
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
        payload: sealWriterProgressTestValue({
            type: 'writer_stage_operation',
            source: 'machine-runtime-instrumentation',
            identity: binding,
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

export function createExternalWriterProgressTrace({
    current,
    plan,
    slice,
    compiledPromptDigest,
    records,
    routeDigest,
    checkpointOrdinal = 1,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    previousMachineTraceSnapshot = null
}) {
    const runtimeObservation = {
        schema: 'issue-orchestration.runtime-observation.v2',
        rolloutId: `rollout-${slice.sliceId}`,
        threadId: `thread-${slice.sliceId}`,
        effectiveWorkingDirectory: plan.worktreeIdentity
    }
    const dispatchReceipt = sealWriterProgressTestValue({
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
        runtimeMetadataDigest:
            writerProgressTestDigest(runtimeObservation),
        verificationStatus: 'verified'
    }, 'receiptDigest')
    const currentRecords = [
        {
            type: 'session_meta',
            payload: {
                id: runtimeObservation.rolloutId,
                session_id: runtimeObservation.threadId
            }
        },
        ...records
    ]
    const rolloutRecords = [
        ...(previousMachineTraceSnapshot?.records ?? []),
        ...currentRecords
    ].map(canonical)
    const authorityLocation = writerStageAuthorityLocation({
        runId: plan.runId,
        node: plan.node,
        stageAttemptId: plan.stageAttemptId
    })
    const source = `${rolloutRecords.map((record) =>
        JSON.stringify(canonical(record))).join('\n')}\n`
    const traceSnapshot = sealWriterProgressTestValue({
        schema:
            'issue-orchestration.machine-writer-runtime-trace-snapshot.v1',
        records: rolloutRecords,
        prefixByteLength: Buffer.byteLength(source),
        prefixDigest:
            createHash('sha256').update(source).digest('hex'),
        recordCount: rolloutRecords.length,
        checkpointOrdinal,
        previousPrefixDigest:
            previousMachineTracePrefixDigest,
        previousPrefixByteLength:
            previousMachineTracePrefixByteLength
    }, 'snapshotDigest')
    const tracePath = path.join(
        path.dirname(authorityLocation.writerLeasePath),
        'runtime-rollout-snapshots',
        `${traceSnapshot.prefixDigest}.jsonl`
    )
    fs.mkdirSync(path.dirname(tracePath), { recursive: true })
    if (fs.existsSync(tracePath)) {
        if (fs.readFileSync(tracePath, 'utf8') !== source) {
            throw new Error(
                'content-addressed trace snapshot collision'
            )
        }
    } else {
        fs.writeFileSync(tracePath, source, {
            flag: 'wx',
            mode: 0o444
        })
        fs.chmodSync(tracePath, 0o444)
    }
    current?.after(() => {
        if (!fs.existsSync(tracePath)) return
        fs.chmodSync(tracePath, 0o600)
        fs.rmSync(tracePath, { force: true })
    })
    return sealWriterProgressTestValue({
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

function requiredEvidenceTypes(evidenceId) {
    if (/filesystem.*git.*command|file.*command/iu.test(evidenceId)) {
        return ['file', 'command']
    }
    if (/command/iu.test(evidenceId)) return ['command']
    if (/file|filesystem|git/iu.test(evidenceId)) return ['file']
    throw new Error(
        `writer progress test helper only supports file/command evidence: ${evidenceId}`
    )
}

function operationTimes(sequence) {
    const second = String(sequence).padStart(2, '0')
    return {
        startedAt: `2026-08-02T00:00:${second}.000Z`,
        completedAt: `2026-08-02T00:00:${second}.010Z`
    }
}

export function buildVerifiedWriterProgressCheckpoint({
    current,
    artifacts,
    fixture = null,
    activateIndexes = null,
    routeDigest = null,
    status = 'complete',
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = writerProgressTestDigest([]),
    checkpointOrdinal = 1,
    previousCheckpointDigest = null,
    previousCheckpointVerificationReceiptDigest = null,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    previousMachineTraceSnapshot = null
}) {
    const plan = artifacts?.stageWorkPlan
    const slice = artifacts?.executableSlice
    const compiledPrompt = artifacts?.compiledPrompt
    if (!plan || !slice || !compiledPrompt ||
        !['partial', 'complete'].includes(status)) {
        throw new TypeError(
            'verified writer artifacts and partial/complete status are required'
        )
    }
    if (activateIndexes !== null) {
        if (!fixture?.activate) {
            throw new TypeError(
                'activateIndexes requires a writer-stage Git fixture'
            )
        }
        fixture.activate(activateIndexes)
    }
    const effectiveRouteDigest = routeDigest ?? writerTestDigest({
        route: `${slice.stageRole}:${slice.stagePhase}`,
        sliceDigest: slice.sliceDigest
    })
    const checkpointEvidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: plan.worktreeIdentity,
        slice
    })
    const evidenceIds = slice.requiredEvidence ?? []
    const requiredFiles = slice.requiredCreatedOrModifiedFiles ??
        slice.requiredFiles ?? []
    const requiredCommands = slice.requiredCommands ?? []
    const fileEvidenceByPath = new Map(
        checkpointEvidence.requiredFiles.map((entry) => [entry.path, entry])
    )
    const commandEvidenceByCommand = new Map(
        checkpointEvidence.commands.map((entry) => [entry.command, entry])
    )
    const receipts = []
    const fileReceiptByPath = new Map()
    const commandReceiptByCommand = new Map()
    const sealReceipt = (evidenceId, evidenceType, payload) => {
        const receipt = sealWriterStageEvidenceReceipt({
            plan,
            slice,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDigest: effectiveRouteDigest,
            checkpointEvidence,
            evidenceId,
            evidenceType,
            payload
        })
        receipts.push(receipt)
        return receipt
    }
    for (const evidenceId of evidenceIds) {
        for (const evidenceType of requiredEvidenceTypes(evidenceId)) {
            if (evidenceType === 'file') {
                const filePath = requiredFiles[0]
                const receipt = sealReceipt(
                    evidenceId,
                    evidenceType,
                    fileEvidenceByPath.get(filePath)
                )
                fileReceiptByPath.set(filePath, receipt)
            } else {
                const command = requiredCommands[0]
                const receipt = sealReceipt(
                    evidenceId,
                    evidenceType,
                    commandEvidenceByCommand.get(command)
                )
                commandReceiptByCommand.set(command, receipt)
            }
        }
    }
    for (const filePath of requiredFiles) {
        if (!fileReceiptByPath.has(filePath)) {
            fileReceiptByPath.set(filePath, sealReceipt(
                `machine-file:${filePath}`,
                'file',
                fileEvidenceByPath.get(filePath)
            ))
        }
    }
    for (const command of requiredCommands) {
        if (!commandReceiptByCommand.has(command)) {
            commandReceiptByCommand.set(command, sealReceipt(
                `machine-command:${command}`,
                'command',
                commandEvidenceByCommand.get(command)
            ))
        }
    }
    const binding = writerProgressBinding(
        plan,
        slice,
        compiledPrompt.promptDigest,
        effectiveRouteDigest
    )
    const operationInputs = []
    for (const targetPath of slice.firstReadTargets ?? []) {
        operationInputs.push({
            kind: 'read-only',
            targetPath,
            evidenceReceiptDigest:
                fileReceiptByPath.get(targetPath)?.receiptDigest ?? null
        })
    }
    const observedCommands = new Set()
    const observedArtifacts = new Set()
    if (slice.firstAction?.kind === 'command') {
        const command = slice.firstAction.command
        const receipt = commandReceiptByCommand.get(command)
        operationInputs.push({
            kind: 'tool-call',
            toolName: 'exec',
            command,
            evidenceReceiptDigest: receipt?.receiptDigest ?? null
        })
        observedCommands.add(command)
    } else if (slice.firstAction?.kind === 'filesystem-write') {
        const filePath = slice.firstAction.path
        const receipt = fileReceiptByPath.get(filePath)
        operationInputs.push({
            kind: 'artifact',
            writePath: filePath,
            evidenceReceiptDigest: receipt?.receiptDigest ?? null,
            artifactReceiptDigest: receipt?.receiptDigest ?? null
        })
        observedArtifacts.add(filePath)
    } else {
        throw new Error('unsupported writer firstAction in test helper')
    }
    for (const command of requiredCommands) {
        if (observedCommands.has(command)) continue
        const receipt = commandReceiptByCommand.get(command)
        operationInputs.push({
            kind: 'tool-call',
            toolName: 'exec',
            command,
            evidenceReceiptDigest: receipt.receiptDigest
        })
    }
    for (const filePath of requiredFiles) {
        if (observedArtifacts.has(filePath)) continue
        const receipt = fileReceiptByPath.get(filePath)
        operationInputs.push({
            kind: 'artifact',
            writePath: filePath,
            evidenceReceiptDigest: receipt.receiptDigest,
            artifactReceiptDigest: receipt.receiptDigest
        })
    }
    const nextRequiredAction = status === 'complete'
        ? null
        : `complete:${slice.sliceId}`
    operationInputs.push({
        kind: 'checkpoint',
        checkpointKind: slice.safeCheckpointKind,
        checkpointStatus: status,
        nextRequiredAction
    })
    const records = operationInputs.map((input, index) =>
        writerProgressOperationRecord({
            binding,
            sequence: index + 1,
            ...operationTimes(index + 1),
            ...input
        }))
    const machineRuntimeTrace = createExternalWriterProgressTrace({
        current,
        plan,
        slice,
        compiledPromptDigest: compiledPrompt.promptDigest,
        routeDigest: effectiveRouteDigest,
        records,
        checkpointOrdinal,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength,
        previousMachineTraceSnapshot
    })
    const runtimeProgressObservation =
        sealWriterStageRuntimeProgressObservation({
            plan,
            slice,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDigest: effectiveRouteDigest,
            checkpointEvidence,
            typedEvidenceReceipts: receipts,
            machineRuntimeTrace,
            checkpointOrdinal,
            previousCheckpointDigest,
            previousCheckpointVerificationReceiptDigest,
            previousMachineTracePrefixDigest,
            previousMachineTracePrefixByteLength,
            previousMachineTraceSnapshot
        })
    const evidence = {
        ...checkpointEvidence,
        typedEvidenceReceipts: receipts,
        machineRuntimeTrace,
        runtimeProgressObservation
    }
    delete evidence.evidenceDigest
    evidence.evidenceDigest = writerProgressTestDigest(evidence)
    const checkpoint = sealProgressCheckpoint({
        plan,
        slice,
        acceptedPriorChangedPaths,
        checkpoint: {
            schema: 'issue-orchestration.stage-progress-checkpoint.v1',
            runId: plan.runId,
            node: plan.node,
            baseSha: plan.baseSha,
            epochId: plan.epochId,
            worktreeIdentity: plan.worktreeIdentity,
            sliceId: slice.sliceId,
            sliceDigest: slice.sliceDigest,
            verificationStatus: 'verified',
            status,
            cursor: runtimeProgressObservation.derivedCursor,
            nextRequiredAction,
            evidence,
            evidenceDigest: evidence.evidenceDigest
        }
    })
    const checkpointVerificationReceipt =
        verifyWriterStageCheckpointLiveEvidence({
            plan,
            slice,
            checkpoint,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDigest: effectiveRouteDigest,
            acceptedPriorChangedPaths,
            completedSlicePrefixDigest,
            checkpointOrdinal,
            previousCheckpointDigest,
            previousCheckpointVerificationReceiptDigest,
            previousMachineTracePrefixDigest,
            previousMachineTracePrefixByteLength,
            previousMachineTraceSnapshot,
            verifiedAt: '2026-08-02T00:01:00.000Z'
        })
    return Object.freeze({
        artifacts,
        checkpoint,
        checkpointVerificationReceipt,
        acceptedPriorChangedPaths: Object.freeze([
            ...acceptedPriorChangedPaths
        ]),
        completedSlicePrefixDigest,
        checkpointOrdinal,
        routeDigest: effectiveRouteDigest,
        typedEvidenceReceipts: Object.freeze(receipts),
        machineRuntimeTrace,
        runtimeProgressObservation
    })
}
