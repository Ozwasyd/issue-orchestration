import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
    compileSealedContinuation,
    compileDispatchPrompt,
    compileExecutableSlice,
    compileSealedExecutableSlice,
    validateActiveWriterResourceAuthority,
    validateSealedCompiledDispatchPrompt,
    validateSealedExecutableSlice,
    validateSealedStageWorkPlan,
    validateProgressCheckpoint,
    writerStageAuthorityLocation
} from './executable-slice-compiler.mjs'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const GIT_DIGEST = /^[a-f0-9]{40,64}$/u
const TYPED_EVIDENCE_SCHEMA =
    'issue-orchestration.writer-stage-evidence-receipt.v1'
const RUNTIME_PROGRESS_SCHEMA =
    'issue-orchestration.writer-stage-runtime-progress-observation.v1'
const MACHINE_TRACE_SNAPSHOT_SCHEMA =
    'issue-orchestration.machine-writer-runtime-trace-snapshot.v1'
const CHECKPOINT_VERIFICATION_SCHEMA =
    'issue-orchestration.writer-stage-checkpoint-verification-receipt.v1'
const EVIDENCE_TYPES = new Set([
    'command',
    'file',
    'ui-render',
    'conflict-mapping',
    'documentation-no-change',
    'evidence-bundle'
])
const DURATION_CLASSES = Object.freeze([
    'instant',
    'short',
    'medium',
    'long',
    'extended'
])
const DURATION_CLASS_LIMITS_MS = Object.freeze({
    instant: 30_000,
    short: 5 * 60_000,
    medium: 30 * 60_000,
    long: 2 * 60 * 60_000,
    extended: Number.POSITIVE_INFINITY
})
const STAGE_REQUIREMENTS = Object.freeze({
    'test-contract:test-owner': ['tests-or-fixtures', 'commands', 'checkpoint'],
    'implementation:code-implementer': ['diff', 'commands', 'checkpoint'],
    'ui-implementation:ui-ux-implementer': [
        'diff', 'render-evidence', 'checkpoint'
    ],
    'documentation:documentation-writer': [
        'diff', 'verified-no-change-evidence', 'checkpoint'
    ],
    'landing-conflict-resolution:code-implementer': [
        'conflict-mapping', 'diff', 'checkpoint'
    ],
    'landing-conflict-resolution:ui-ux-implementer': [
        'conflict-mapping', 'diff', 'checkpoint'
    ]
})
const HISTORICAL_STAGE_REQUIREMENTS = Object.freeze({
    'landing-conflict-resolution:landing-owner': [
        'conflict-mapping', 'diff', 'checkpoint'
    ]
})
export const authorizedStageRoles = Object.freeze([
    'test-owner',
    'code-implementer',
    'ui-ux-implementer',
    'documentation-writer'
])

function historicalLandingObservation(observation) {
    return observation?.stagePhase === 'landing-conflict-resolution' &&
        observation?.stageRole === 'landing-owner'
}

function stageRequirements(observation) {
    const key = `${observation.stagePhase}:${observation.stageRole}`
    return STAGE_REQUIREMENTS[key] ??
        HISTORICAL_STAGE_REQUIREMENTS[key] ??
        null
}

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
    const sealed = structuredClone(value)
    delete sealed[field]
    sealed[field] = digest(sealed)
    return Object.freeze(sealed)
}

function validReceipt(value, schema) {
    if (!value || value.schema !== schema || !HASH.test(value.receiptDigest ?? '')) {
        return false
    }
    const unsigned = { ...value }
    delete unsigned.receiptDigest
    return value.receiptDigest === digest(unsigned)
}

function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function unsignedDigest(value, digestField) {
    const unsigned = structuredClone(value)
    delete unsigned[digestField]
    return digest(unsigned)
}

function realWorktreePath(worktreeIdentity, relativePath) {
    if (typeof worktreeIdentity !== 'string' ||
        typeof relativePath !== 'string' ||
        !relativePath.trim() ||
        path.isAbsolute(relativePath)) {
        throw new Error('repository-relative evidence path is required')
    }
    const root = fs.realpathSync(worktreeIdentity)
    const candidate = fs.realpathSync(path.resolve(root, relativePath))
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        throw new Error('evidence path escaped the verified worktree')
    }
    return { candidate, root }
}

function gitObjectDigest(worktreeIdentity, relativePath) {
    const { root } = realWorktreePath(worktreeIdentity, relativePath)
    return execFileSync(
        'git',
        ['hash-object', '--', relativePath],
        { cwd: root, encoding: 'utf8' }
    ).trim()
}

function gitStatus(worktreeIdentity) {
    const root = fs.realpathSync(worktreeIdentity)
    return execFileSync(
        'git',
        ['status', '--short', '--untracked-files=all'],
        { cwd: root, encoding: 'utf8' }
    ).replace(/(?:\r?\n)+$/u, '')
}

function gitHead(worktreeIdentity) {
    return execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        {
            cwd: fs.realpathSync(worktreeIdentity),
            encoding: 'utf8'
        }
    ).trim()
}

function fileContentDigest(absolutePath) {
    return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
}

function pathMatches(candidate, declared) {
    if (typeof candidate !== 'string' || typeof declared !== 'string') {
        return false
    }
    if (declared === candidate) return true
    if (declared.endsWith('/**')) {
        const prefix = declared.slice(0, -3).replace(/\/$/u, '')
        return candidate === prefix || candidate.startsWith(`${prefix}/`)
    }
    if (!declared.includes('*')) return candidate.startsWith(`${declared}/`)
    const escaped = declared
        .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
        .replaceAll('**', '\u0000')
        .replaceAll('*', '[^/]*')
        .replaceAll('\u0000', '.*')
    return new RegExp(`^${escaped}$`, 'u').test(candidate)
}

function evidenceBinding({ plan, slice, compiledPromptDigest, routeDigest }) {
    return {
        runId: plan?.runId,
        repository: plan?.repository,
        issue: plan?.issue,
        node: plan?.node,
        stageRole: slice?.stageRole,
        stagePhase: slice?.stagePhase,
        planDigest: plan?.planDigest,
        sliceId: slice?.sliceId,
        sliceDigest: slice?.sliceDigest,
        baseSha: plan?.baseSha,
        epochId: plan?.epochId,
        worktreeIdentity: plan?.worktreeIdentity,
        routeDigest,
        compiledPromptDigest,
        stageAttemptId: plan?.stageAttemptId,
        activeWriteLeaseId: plan?.activeWriteLeaseId,
        resourceLeaseReceiptDigest: plan?.resourceLeaseReceiptDigest,
        runtimeStateRootDigest: plan?.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            plan?.runtimeAuthorityIdentityDigest
    }
}

function evidenceReceiptBindingErrors(receipt, binding) {
    const errors = []
    for (const [field, expected] of Object.entries(binding)) {
        if (receipt?.[field] !== expected) {
            errors.push(`typed evidence ${field} identity mismatch`)
        }
    }
    if (receipt?.schema !== TYPED_EVIDENCE_SCHEMA ||
        !EVIDENCE_TYPES.has(receipt?.evidenceType) ||
        typeof receipt?.evidenceId !== 'string' ||
        !receipt.evidenceId.trim() ||
        !HASH.test(receipt?.receiptDigest ?? '') ||
        receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest')) {
        errors.push('typed evidence receipt schema or digest is invalid')
    }
    return errors
}

function verifyFileEvidencePayload(payload, worktreeIdentity) {
    const errors = []
    if (!validFileEvidencePayloadShape(payload)) {
        return ['typed file evidence payload is invalid']
    }
    try {
        const { candidate } = realWorktreePath(
            worktreeIdentity,
            payload.path
        )
        if (payload.realPath !== candidate) {
            errors.push('typed file evidence real path mismatch')
        }
        if (gitObjectDigest(worktreeIdentity, payload.path) !==
            payload.gitObjectDigest) {
            errors.push('typed file evidence Git object digest mismatch')
        }
    } catch {
        errors.push('typed file evidence is not independently observable')
    }
    return errors
}

function validFileEvidencePayloadShape(payload) {
    return Boolean(
        payload &&
        typeof payload.path === 'string' &&
        payload.path.trim() &&
        typeof payload.realPath === 'string' &&
        path.isAbsolute(payload.realPath) &&
        GIT_DIGEST.test(payload.gitObjectDigest ?? '')
    )
}

function validateTypedEvidencePayload({
    checkpoint,
    receipt,
    validReceiptDigests,
    worktreeIdentity,
    liveObservation = true
}) {
    const errors = []
    const payload = receipt?.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return ['typed evidence payload is required']
    }
    switch (receipt.evidenceType) {
        case 'command': {
            if (typeof payload.command !== 'string' ||
                !Number.isInteger(payload.exitStatus) ||
                !HASH.test(payload.outputDigest ?? '') ||
                !(checkpoint?.evidence?.commands ?? []).some((entry) =>
                    sameValue(entry, payload))) {
                errors.push(
                    'typed command receipt does not match independently verified command evidence'
                )
            }
            break
        }
        case 'file': {
            if (liveObservation) {
                errors.push(...verifyFileEvidencePayload(
                    payload,
                    worktreeIdentity
                ))
            } else if (!validFileEvidencePayloadShape(payload)) {
                errors.push('typed file evidence payload is invalid')
            }
            if (!(checkpoint?.evidence?.requiredFiles ?? []).some((entry) =>
                sameValue(entry, payload))) {
                errors.push(
                    'typed file receipt does not match checkpoint filesystem evidence'
                )
            }
            break
        }
        case 'ui-render': {
            if (receipt.stagePhase !== 'ui-implementation' ||
                receipt.stageRole !== 'ui-ux-implementer') {
                errors.push(
                    'typed UI render receipt requires the UI writer stage'
                )
            }
            const uiFilePayload = {
                path: payload.artifactPath,
                realPath: payload.realPath,
                gitObjectDigest: payload.gitObjectDigest
            }
            if (liveObservation) {
                errors.push(...verifyFileEvidencePayload(
                    uiFilePayload,
                    worktreeIdentity
                ))
            } else if (!validFileEvidencePayloadShape(uiFilePayload)) {
                errors.push('typed UI render artifact payload is invalid')
            }
            if (!HASH.test(payload.contentDigest ?? '') ||
                typeof payload.renderer !== 'string' ||
                !payload.renderer.trim() ||
                typeof payload.viewport !== 'string' ||
                !payload.viewport.trim()) {
                errors.push('typed UI render receipt metadata is invalid')
                break
            }
            if (liveObservation) {
                try {
                    const { candidate } = realWorktreePath(
                        worktreeIdentity,
                        payload.artifactPath
                    )
                    if (fileContentDigest(candidate) !==
                        payload.contentDigest) {
                        errors.push('typed UI render content digest mismatch')
                    }
                } catch {
                    errors.push(
                        'typed UI render artifact is not observable'
                    )
                }
            }
            break
        }
        case 'conflict-mapping': {
            if (receipt.stagePhase !== 'landing-conflict-resolution' ||
                !['code-implementer', 'ui-ux-implementer'].includes(
                    receipt.stageRole
                )) {
                errors.push(
                    'typed conflict mapping receipt requires an authorized landing writer'
                )
            }
            if (!Array.isArray(payload.entries) ||
                payload.entries.length === 0) {
                errors.push('typed conflict mapping entries are required')
                break
            }
            for (const entry of payload.entries) {
                if (!SHA.test(entry?.sourceRevision ?? '') ||
                    typeof entry?.sourcePath !== 'string' ||
                    !entry.sourcePath.trim() ||
                    !GIT_DIGEST.test(entry?.sourceGitObjectDigest ?? '') ||
                    typeof entry?.destinationPath !== 'string' ||
                    !entry.destinationPath.trim() ||
                    !GIT_DIGEST.test(
                        entry?.destinationGitObjectDigest ?? ''
                    )) {
                    errors.push('typed conflict mapping entry is invalid')
                    break
                }
                if (liveObservation) {
                    try {
                        const root = fs.realpathSync(worktreeIdentity)
                        const sourceObject = execFileSync(
                            'git',
                            [
                                'rev-parse',
                                `${entry.sourceRevision}:${entry.sourcePath}`
                            ],
                            { cwd: root, encoding: 'utf8' }
                        ).trim()
                        const destinationObject = gitObjectDigest(
                            worktreeIdentity,
                            entry.destinationPath
                        )
                        if (sourceObject !==
                                entry.sourceGitObjectDigest ||
                            destinationObject !==
                                entry.destinationGitObjectDigest) {
                            errors.push(
                                'typed conflict mapping content is not bound to observable Git objects'
                            )
                            break
                        }
                    } catch {
                        errors.push(
                            'typed conflict mapping source or destination is not observable'
                        )
                        break
                    }
                }
            }
            break
        }
        case 'documentation-no-change': {
            if (receipt.stagePhase !== 'documentation' ||
                receipt.stageRole !== 'documentation-writer') {
                errors.push(
                    'typed documentation no-change receipt requires the documentation writer stage'
                )
            }
            if (payload.headSha !== checkpoint?.evidence?.git?.headSha ||
                payload.worktreeStatus !==
                    checkpoint?.evidence?.git?.worktreeStatus ||
                payload.worktreeStatus !== '' ||
                liveObservation &&
                    (payload.headSha !== gitHead(worktreeIdentity) ||
                        payload.worktreeStatus !==
                            gitStatus(worktreeIdentity))) {
                errors.push(
                    'typed documentation no-change receipt requires an independently clean worktree'
                )
            }
            if (!Array.isArray(payload.inspectedFiles) ||
                payload.inspectedFiles.length === 0) {
                errors.push(
                    'typed documentation no-change receipt requires inspected files'
                )
                break
            }
            for (const entry of payload.inspectedFiles) {
                if (liveObservation) {
                    errors.push(...verifyFileEvidencePayload(
                        entry,
                        worktreeIdentity
                    ))
                } else if (!validFileEvidencePayloadShape(entry)) {
                    errors.push(
                        'typed documentation inspected file payload is invalid'
                    )
                }
            }
            break
        }
        case 'evidence-bundle': {
            if (!Array.isArray(payload.receiptDigests) ||
                payload.receiptDigests.length === 0 ||
                payload.receiptDigests.some((value) =>
                    !HASH.test(value) ||
                    !validReceiptDigests.has(value))) {
                errors.push(
                    'typed evidence bundle must reference verified typed receipts'
                )
            }
            break
        }
        default:
            errors.push('typed evidence type is not supported')
    }
    return errors
}

function requiredEvidenceTypes(evidenceId) {
    if (/verified[-_ ]?no[-_ ]?change/iu.test(evidenceId)) {
        return ['documentation-no-change']
    }
    if (/(?:ui[-_ ]?)?render|screenshot|visual/iu.test(evidenceId)) {
        return ['ui-render']
    }
    if (/conflict[-_ ]?mapping/iu.test(evidenceId)) {
        return ['conflict-mapping']
    }
    if (/filesystem.*git.*command|file.*command/iu.test(evidenceId)) {
        return ['file', 'command']
    }
    if (/command/iu.test(evidenceId)) return ['command']
    if (/file|filesystem|git/iu.test(evidenceId)) return ['file']
    return ['evidence-bundle']
}

function durationClass(durationMs) {
    return DURATION_CLASSES.find((item) =>
        durationMs <= DURATION_CLASS_LIMITS_MS[item]) ?? 'extended'
}

function moduleIdentity(filePath) {
    const segments = path.posix.normalize(filePath).split('/')
        .filter((segment) => segment && segment !== '.')
    if (segments.length <= 1) return segments[0] ?? null
    return segments.slice(0, 2).join('/')
}

const TRACE_RUNTIME_OBSERVATION_FIELDS = Object.freeze([
    'schema',
    'rolloutId',
    'threadId',
    'effectiveWorkingDirectory'
])
const TRACE_DISPATCH_RECEIPT_FIELDS = Object.freeze([
    'schema',
    'runId',
    'nodeId',
    'attemptId',
    'baseSha',
    'epochId',
    'planDigest',
    'sliceDigest',
    'compiledPromptDigest',
    'activeWriteLeaseId',
    'actualWorkingDirectory',
    'rolloutId',
    'threadId',
    'runtimeMetadataDigest',
    'verificationStatus',
    'receiptDigest'
])

function validDispatchReceiptForTrace(receipt, runtimeObservation, binding) {
    if (!exactFields(
        runtimeObservation,
        TRACE_RUNTIME_OBSERVATION_FIELDS
    ) ||
        runtimeObservation.schema !==
            'issue-orchestration.runtime-observation.v2' ||
        runtimeObservation.effectiveWorkingDirectory !==
            binding.worktreeIdentity ||
        !exactFields(receipt, TRACE_DISPATCH_RECEIPT_FIELDS) ||
        receipt?.schema !== 'issue-orchestration.dispatch-receipt.v2' ||
        receipt.verificationStatus !== 'verified' ||
        receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest') ||
        receipt.runId !== binding.runId ||
        receipt.nodeId !== binding.node ||
        receipt.baseSha !== binding.baseSha ||
        receipt.epochId !== binding.epochId ||
        receipt.attemptId !== binding.stageAttemptId ||
        receipt.planDigest !== binding.planDigest ||
        receipt.sliceDigest !== binding.sliceDigest ||
        receipt.compiledPromptDigest !== binding.compiledPromptDigest ||
        receipt.actualWorkingDirectory !== binding.worktreeIdentity ||
        receipt.activeWriteLeaseId !== binding.activeWriteLeaseId ||
        receipt.runtimeMetadataDigest !== digest(runtimeObservation) ||
        receipt.rolloutId !== runtimeObservation?.rolloutId ||
        receipt.threadId !== runtimeObservation?.threadId) {
        return false
    }
    return true
}

function checkpointChainErrors({
    checkpointOrdinal,
    previousCheckpointDigest,
    previousCheckpointVerificationReceiptDigest,
    previousMachineTracePrefixDigest,
    previousMachineTracePrefixByteLength
}) {
    const errors = []
    if (!Number.isInteger(checkpointOrdinal) ||
        checkpointOrdinal < 1) {
        return ['checkpoint ordinal must be a positive integer']
    }
    const previousValues = [
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest
    ]
    if (checkpointOrdinal === 1) {
        if (previousValues.some((value) => value !== null) ||
            previousMachineTracePrefixByteLength !== null) {
            errors.push(
                'first checkpoint must have a null previous checkpoint and trace prefix'
            )
    }
    } else if (previousValues.some((value) => !HASH.test(value ?? '')) ||
        !Number.isInteger(previousMachineTracePrefixByteLength) ||
        previousMachineTracePrefixByteLength <= 0) {
        errors.push(
            'later checkpoint must bind the previous checkpoint, verification, and trace prefix'
        )
    }
    return errors
}

function operationRecordPayload(record) {
    if (record?.type !== 'event_msg' ||
        record?.payload?.type !== 'writer_stage_operation') {
        return null
    }
    return record.payload
}

const SENSITIVE_KEY = /secret|token|password|credential|api[-_]?key|authorization/iu
const SENSITIVE_MATERIAL =
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}|(?:api[-_]?key|token|password|credential|authorization)\s*[:=]\s*\S+/iu
const OPERATION_PAYLOAD_FIELDS = Object.freeze([
    'type',
    'source',
    'identity',
    'sequence',
    'kind',
    'startedAt',
    'completedAt',
    'targetPath',
    'toolName',
    'command',
    'writePath',
    'evidenceReceiptDigest',
    'artifactReceiptDigest',
    'checkpointKind',
    'checkpointStatus',
    'nextRequiredAction',
    'observationDigest'
])

function exactFields(value, fields) {
    return value && typeof value === 'object' &&
        !Array.isArray(value) &&
        sameValue(Object.keys(value).sort(), [...fields].sort())
}

function containsSensitiveSnapshotMaterial(value) {
    if (Array.isArray(value)) {
        return value.some(containsSensitiveSnapshotMaterial)
    }
    if (!value || typeof value !== 'object') {
        return typeof value === 'string' &&
            SENSITIVE_MATERIAL.test(value)
    }
    return Object.entries(value).some(([key, item]) =>
        SENSITIVE_KEY.test(key) ||
        containsSensitiveSnapshotMaterial(item))
}

function sanitizedTraceRecord(record) {
    if (!exactFields(record, ['type', 'payload'])) return false
    if (record.type === 'session_meta') {
        return exactFields(record.payload, ['id', 'session_id']) &&
            typeof record.payload.id === 'string' &&
            record.payload.id.trim() &&
            typeof record.payload.session_id === 'string' &&
            record.payload.session_id.trim()
    }
    return record.type === 'event_msg' &&
        exactFields(record.payload, OPERATION_PAYLOAD_FIELDS) &&
        record.payload.type === 'writer_stage_operation' &&
        record.payload.source === 'machine-runtime-instrumentation'
}

function machineTraceSnapshotSource(records) {
    return `${records.map((record) =>
        JSON.stringify(canonical(record))).join('\n')}\n`
}

function prefixRecordCount(records, prefixByteLength) {
    if (prefixByteLength === null) return 0
    for (let index = 1; index <= records.length; index += 1) {
        if (Buffer.byteLength(
            machineTraceSnapshotSource(records.slice(0, index))
        ) === prefixByteLength) {
            return index
        }
    }
    return -1
}

function validateMachineTraceSnapshot(snapshot, checkpointChain) {
    const errors = []
    const records = snapshot?.records
    const source = Array.isArray(records)
        ? machineTraceSnapshotSource(records)
        : ''
    if (!exactFields(snapshot, [
        'schema',
        'records',
        'prefixByteLength',
        'prefixDigest',
        'recordCount',
        'checkpointOrdinal',
        'previousPrefixDigest',
        'previousPrefixByteLength',
        'snapshotDigest'
    ]) ||
        snapshot?.schema !== MACHINE_TRACE_SNAPSHOT_SCHEMA ||
        !Array.isArray(records) ||
        records.length === 0 ||
        records.some((record) => !sanitizedTraceRecord(record)) ||
        containsSensitiveSnapshotMaterial(records) ||
        !Number.isInteger(snapshot?.prefixByteLength) ||
        snapshot.prefixByteLength <= 0 ||
        Buffer.byteLength(source) !==
            snapshot.prefixByteLength ||
        !HASH.test(snapshot?.prefixDigest ?? '') ||
        createHash('sha256').update(source).digest('hex') !==
            snapshot.prefixDigest ||
        !Number.isInteger(snapshot?.recordCount) ||
        snapshot.recordCount !== records?.length ||
        snapshot.checkpointOrdinal !==
            checkpointChain.checkpointOrdinal ||
        snapshot.previousPrefixDigest !==
            checkpointChain.previousMachineTracePrefixDigest ||
        snapshot.previousPrefixByteLength !==
            checkpointChain.previousMachineTracePrefixByteLength ||
        !HASH.test(snapshot?.snapshotDigest ?? '') ||
        snapshot.snapshotDigest !==
            unsignedDigest(snapshot, 'snapshotDigest')) {
        return {
            errors: [
                'machine runtime trace snapshot is not canonical sanitized content-addressed evidence'
            ],
            rolloutRecords: [],
            currentRecords: [],
            source
        }
    }
    const previousRecordCount = prefixRecordCount(
        records,
        snapshot.previousPrefixByteLength
    )
    if (previousRecordCount < 0) {
        errors.push(
            'machine runtime trace snapshot does not preserve its previous prefix boundary'
        )
    }
    const currentRecords = previousRecordCount < 0
        ? []
        : records.slice(previousRecordCount)
    if (currentRecords.length === 0 ||
        currentRecords[0]?.type !== 'session_meta' ||
        currentRecords.filter((record) =>
            record.type === 'session_meta').length !== 1) {
        errors.push(
            'machine runtime trace snapshot current window lacks one sanitized session identity'
        )
    }
    return {
        errors,
        rolloutRecords: records,
        currentRecords,
        source
    }
}

function validateMachineRuntimeTrace(
    trace,
    binding,
    {
        liveObservation = true,
        checkpointChain,
        previousMachineTraceSnapshot = null
    } = {}
) {
    const errors = []
    if (trace?.schema !==
        'issue-orchestration.machine-writer-runtime-trace-handle.v1' ||
        trace?.source !== 'codex-rollout-jsonl' ||
        trace?.verificationStatus !== 'verified' ||
        typeof trace?.tracePath !== 'string' ||
        !path.isAbsolute(trace.tracePath) ||
        !HASH.test(trace?.traceDigest ?? '') ||
        !HASH.test(trace?.receiptDigest ?? '') ||
        trace.receiptDigest !== unsignedDigest(trace, 'receiptDigest') ||
        trace.runtimeStateRootDigest !==
            binding.runtimeStateRootDigest ||
        trace.runtimeAuthorityIdentityDigest !==
            binding.runtimeAuthorityIdentityDigest ||
        trace.activeWriteLeaseId !== binding.activeWriteLeaseId ||
        trace.resourceLeaseReceiptDigest !==
            binding.resourceLeaseReceiptDigest ||
        trace.routeDigest !== binding.routeDigest) {
        errors.push('trusted machine runtime trace receipt is invalid')
        return { errors, operations: [] }
    }
    const snapshotResult = validateMachineTraceSnapshot(
        trace.traceSnapshot,
        checkpointChain
    )
    errors.push(...snapshotResult.errors)
    if (snapshotResult.errors.length ||
        trace.traceDigest !== trace.traceSnapshot.prefixDigest ||
        !trace.tracePath.endsWith(
            `${path.sep}runtime-rollout-snapshots${path.sep}` +
            `${trace.traceSnapshot.prefixDigest}.jsonl`
        )) {
        errors.push(
            'machine runtime trace handle does not bind its immutable snapshot'
        )
    }
    if (liveObservation) {
        try {
            const authorityLocation = writerStageAuthorityLocation({
                runId: binding.runId,
                node: binding.node,
                stageAttemptId: binding.stageAttemptId
            })
            const canonicalTracePath = path.join(
                path.dirname(authorityLocation.writerLeasePath),
                'runtime-rollout-snapshots',
                `${trace.traceSnapshot.prefixDigest}.jsonl`
            )
            const worktreeRoot = fs.realpathSync(
                binding.worktreeIdentity
            )
            const tracePath = fs.realpathSync(trace.tracePath)
            const stat = fs.statSync(tracePath)
            if (!stat.isFile() ||
                stat.mode & 0o222 ||
                tracePath !== canonicalTracePath ||
                tracePath === worktreeRoot ||
                tracePath.startsWith(`${worktreeRoot}${path.sep}`)) {
                throw new Error(
                    'trace authority boundary is not immutable'
                )
            }
            const source = fs.readFileSync(tracePath, 'utf8')
            if (source !== snapshotResult.source) {
                throw new Error('trace snapshot source mismatch')
            }
            if (checkpointChain.checkpointOrdinal > 1) {
                const previousTracePath = path.join(
                    path.dirname(authorityLocation.writerLeasePath),
                    'runtime-rollout-snapshots',
                    `${checkpointChain
                        .previousMachineTracePrefixDigest}.jsonl`
                )
                const previousStat = fs.statSync(previousTracePath)
                const previousSource = fs.readFileSync(
                    previousTracePath,
                    'utf8'
                )
                if (!previousStat.isFile() ||
                    previousStat.mode & 0o222 ||
                    Buffer.byteLength(previousSource) !==
                        checkpointChain
                            .previousMachineTracePrefixByteLength ||
                    createHash('sha256')
                        .update(previousSource).digest('hex') !==
                        checkpointChain
                            .previousMachineTracePrefixDigest ||
                    !source.startsWith(previousSource)) {
                    throw new Error(
                        'trace snapshot does not extend the immutable previous prefix'
                    )
                }
            }
        } catch {
            errors.push(
                'machine runtime trace handle is not an immutable external rollout snapshot'
            )
        }
    } else if (checkpointChain.checkpointOrdinal > 1) {
        const previousRecords =
            previousMachineTraceSnapshot?.records
        const previousSource = Array.isArray(previousRecords)
            ? machineTraceSnapshotSource(previousRecords)
            : ''
        if (!Array.isArray(previousRecords) ||
            previousRecords.some((record) =>
                !sanitizedTraceRecord(record)) ||
            containsSensitiveSnapshotMaterial(previousRecords) ||
            previousMachineTraceSnapshot.snapshotDigest !==
                unsignedDigest(
                    previousMachineTraceSnapshot,
                    'snapshotDigest'
                ) ||
            Buffer.byteLength(previousSource) !==
                checkpointChain
                    .previousMachineTracePrefixByteLength ||
            createHash('sha256').update(previousSource).digest('hex') !==
                checkpointChain.previousMachineTracePrefixDigest ||
            !snapshotResult.source.startsWith(previousSource)) {
            errors.push(
                'sealed machine runtime trace does not extend the prior immutable snapshot'
            )
        }
    }
    const rolloutRecords = snapshotResult.currentRecords
    if (!validDispatchReceiptForTrace(
        trace.dispatchReceipt,
        trace.runtimeObservation,
        binding
    )) {
        errors.push(
            'machine runtime trace lacks a matching verified dispatch receipt'
        )
    }
    const session = rolloutRecords.find((record) =>
        record?.type === 'session_meta')?.payload
    if (session?.id !== trace.runtimeObservation?.rolloutId ||
        session?.session_id !== trace.runtimeObservation?.threadId) {
        errors.push(
            'machine runtime trace rollout identity does not match trusted dispatch provenance'
        )
    }
    const operations = []
    for (const record of rolloutRecords) {
        const payload = operationRecordPayload(record)
        if (!payload) continue
        const identity = payload.identity ?? {}
        if (!exactFields(identity, Object.keys(binding)) ||
            Object.entries(binding).some(([field, expected]) =>
            identity[field] !== expected) ||
            payload.source !== 'machine-runtime-instrumentation' ||
            payload.observationDigest !==
                unsignedDigest(payload, 'observationDigest')) {
            errors.push(
                'machine runtime operation record identity or provenance is invalid'
            )
            continue
        }
        operations.push({
            sequence: payload.sequence,
            kind: payload.kind,
            startedAt: payload.startedAt,
            completedAt: payload.completedAt,
            targetPath: payload.targetPath ?? null,
            toolName: payload.toolName ?? null,
            command: payload.command ?? null,
            writePath: payload.writePath ?? null,
            evidenceReceiptDigest:
                payload.evidenceReceiptDigest ?? null,
            artifactReceiptDigest:
                payload.artifactReceiptDigest ?? null,
            checkpointKind: payload.checkpointKind ?? null,
            checkpointStatus: payload.checkpointStatus ?? null,
            nextRequiredAction: payload.nextRequiredAction ?? null,
            sourceReceiptDigest: digest(record)
        })
    }
    if (operations.length === 0) {
        errors.push('trusted machine runtime trace has no operation records')
    }
    return { errors, operations }
}

function progressBindingErrors(progress, binding) {
    const errors = []
    for (const [field, expected] of Object.entries(binding)) {
        if (progress?.[field] !== expected) {
            errors.push(`runtime progress ${field} identity mismatch`)
        }
    }
    if (progress?.schema !== RUNTIME_PROGRESS_SCHEMA ||
        progress?.source !== 'machine-writer-runtime' ||
        !HASH.test(progress?.observationDigest ?? '') ||
        progress.observationDigest !==
            unsignedDigest(progress, 'observationDigest')) {
        errors.push('runtime progress observation schema or digest is invalid')
    }
    return errors
}

function operationTimestamp(value) {
    if (typeof value !== 'string') return Number.NaN
    return Date.parse(value)
}

function evidenceReceiptPaths(receipt, receiptByDigest, seen = new Set()) {
    if (!receipt || seen.has(receipt.receiptDigest)) return []
    seen.add(receipt.receiptDigest)
    switch (receipt.evidenceType) {
        case 'file':
            return [receipt.payload.path]
        case 'ui-render':
            return [receipt.payload.artifactPath]
        case 'conflict-mapping':
            return receipt.payload.entries.map((entry) =>
                entry.destinationPath)
        case 'documentation-no-change':
            return receipt.payload.inspectedFiles.map((entry) =>
                entry.path)
        case 'evidence-bundle':
            return receipt.payload.receiptDigests.flatMap((receiptDigest) =>
                evidenceReceiptPaths(
                    receiptByDigest.get(receiptDigest),
                    receiptByDigest,
                    seen
                ))
        default:
            return []
    }
}

function machineActionLabel(operation) {
    if (operation.kind === 'read-only') {
        return `read:${operation.targetPath}`
    }
    if (operation.kind === 'tool-call') return operation.command
    if (operation.kind === 'artifact') {
        return `artifact:${operation.writePath ??
            operation.evidenceReceiptDigest}`
    }
    return null
}

function remainingMachineActions({
    checkpointStatus,
    receiptByDigest,
    slice,
    operations
}) {
    const observedReceipts = operations.flatMap((operation) => {
        const receipt = receiptByDigest.get(
            operation.evidenceReceiptDigest
        )
        return receipt ? [receipt] : []
    })
    const observedCommands = new Set(operations.flatMap((operation) => {
        const receipt = receiptByDigest.get(
            operation.evidenceReceiptDigest
        )
        return operation.kind === 'tool-call' &&
            receipt?.evidenceType === 'command' &&
            receipt.payload.command === operation.command
            ? [operation.command]
            : []
    }))
    const observedPaths = new Set(operations.flatMap((operation) => {
        if (operation.kind !== 'artifact') return []
        return evidenceReceiptPaths(
            receiptByDigest.get(operation.evidenceReceiptDigest),
            receiptByDigest
        ).filter((filePath) => filePath === operation.writePath)
    }))
    const missing = []
    for (const filePath of slice.requiredCreatedOrModifiedFiles ??
        slice.requiredFiles ?? []) {
        if (!observedPaths.has(filePath)) {
            missing.push(`write:${filePath}`)
        }
    }
    for (const command of slice.requiredCommands ?? []) {
        if (!observedCommands.has(command)) missing.push(command)
    }
    for (const evidenceId of slice.requiredEvidence ?? []) {
        for (const evidenceType of requiredEvidenceTypes(evidenceId)) {
            if (!observedReceipts.some((receipt) =>
                receipt.evidenceId === evidenceId &&
                receipt.evidenceType === evidenceType)) {
                missing.push(`evidence:${evidenceId}:${evidenceType}`)
            }
        }
    }
    if (missing.length > 0) return missing
    return checkpointStatus === 'complete'
        ? []
        : [`complete:${slice.sliceId}`]
}

function validateRuntimeProgressObservation({
    checkpoint,
    machineRuntimeTrace,
    progress,
    receiptByDigest,
    slice,
    binding,
    liveObservation = true,
    checkpointChain,
    previousMachineTraceSnapshot = null
}) {
    const errors = progressBindingErrors(progress, binding)
    if (errors.length) return errors
    const replay = validateMachineRuntimeTrace(
        machineRuntimeTrace,
        binding,
        {
            liveObservation,
            checkpointChain,
            previousMachineTraceSnapshot
        }
    )
    errors.push(...replay.errors)
    if (!sameValue(progress.operations, replay.operations) ||
        progress.machineTraceReceiptDigest !==
            machineRuntimeTrace?.receiptDigest ||
        progress.dispatchReceiptDigest !==
            machineRuntimeTrace?.dispatchReceipt?.receiptDigest ||
        progress.rolloutId !==
            machineRuntimeTrace?.runtimeObservation?.rolloutId ||
        progress.threadId !==
            machineRuntimeTrace?.runtimeObservation?.threadId) {
        errors.push(
            'runtime progress does not replay the trusted machine operation trace'
        )
    }
    if (!Array.isArray(progress.operations) ||
        progress.operations.length === 0) {
        errors.push('runtime progress operation trace is required')
        return errors
    }
    const checkpointOperations = progress.operations.filter((operation) =>
        operation.kind === 'checkpoint')
    if (progress.checkpointKind !== slice.safeCheckpointKind ||
        checkpointOperations.length !== 1 ||
        progress.operations.at(-1)?.kind !== 'checkpoint' ||
        checkpointOperations[0].checkpointKind !==
            slice.safeCheckpointKind) {
        errors.push(
            'runtime progress checkpoint kind does not match safeCheckpointKind'
        )
    }
    let previousCompletedAt = Number.NEGATIVE_INFINITY
    let noArtifactToolCalls = 0
    let maximumNoArtifactToolCalls = 0
    let noArtifactWindowStart = null
    let noArtifactWindowEnd = null
    let maximumNoArtifactDurationMs = 0
    let readOnlyOperations = 0
    const touchedPaths = new Set()
    for (const [index, operation] of progress.operations.entries()) {
        const startedAt = operationTimestamp(operation?.startedAt)
        const completedAt = operationTimestamp(operation?.completedAt)
        if (operation?.sequence !== index + 1 ||
            !['read-only', 'tool-call', 'artifact', 'checkpoint'].includes(
                operation?.kind
            ) ||
            !Number.isFinite(startedAt) ||
            !Number.isFinite(completedAt) ||
            completedAt < startedAt ||
            startedAt < previousCompletedAt ||
            !HASH.test(operation?.sourceReceiptDigest ?? '')) {
            errors.push(
                'runtime progress operations must be ordered machine observations'
            )
            break
        }
        if (operation.kind === 'tool-call' &&
                (typeof operation.command !== 'string' ||
                    !operation.command.trim() ||
                    typeof operation.toolName !== 'string' ||
                    !operation.toolName.trim()) ||
            operation.kind === 'artifact' &&
                (typeof operation.writePath !== 'string' ||
                    !operation.writePath.trim()) ||
            operation.kind === 'checkpoint' &&
                (operation.checkpointStatus !== checkpoint.status ||
                    operation.nextRequiredAction !==
                        checkpoint.nextRequiredAction)) {
            errors.push(
                'runtime progress operation detail is incomplete or does not match the checkpoint'
            )
        }
        if (operation.evidenceReceiptDigest !== null &&
            (!HASH.test(operation.evidenceReceiptDigest) ||
                !receiptByDigest.has(operation.evidenceReceiptDigest))) {
            errors.push(
                'runtime progress operation references unverified typed evidence'
            )
        } else if (operation.evidenceReceiptDigest !== null) {
            const evidenceReceipt = receiptByDigest.get(
                operation.evidenceReceiptDigest
            )
            const evidenceType = evidenceReceipt.evidenceType
            for (const filePath of evidenceReceiptPaths(
                evidenceReceipt,
                receiptByDigest
            )) {
                touchedPaths.add(filePath)
            }
            if (operation.kind === 'read-only' &&
                    (!['file', 'documentation-no-change'].includes(
                        evidenceType
                    ) ||
                        !evidenceReceiptPaths(
                            evidenceReceipt,
                            receiptByDigest
                        ).includes(operation.targetPath)) ||
                operation.kind === 'tool-call' &&
                    (evidenceType !== 'command' ||
                        evidenceReceipt.payload.command !==
                            operation.command) ||
                operation.kind === 'artifact' &&
                    (evidenceType === 'command' ||
                        !evidenceReceiptPaths(
                            evidenceReceipt,
                            receiptByDigest
                        ).includes(operation.writePath))) {
                errors.push(
                    'runtime operation kind does not match its typed evidence receipt'
                )
            }
        }
        previousCompletedAt = completedAt
        if (operation.kind === 'checkpoint') {
            maximumNoArtifactToolCalls = Math.max(
                maximumNoArtifactToolCalls,
                noArtifactToolCalls
            )
            maximumNoArtifactDurationMs = Math.max(
                maximumNoArtifactDurationMs,
                noArtifactWindowStart === null
                    ? 0
                    : startedAt - noArtifactWindowStart
            )
        } else if (operation.kind === 'artifact') {
            if (!HASH.test(operation.artifactReceiptDigest ?? '') ||
                !receiptByDigest.has(operation.artifactReceiptDigest)) {
                errors.push(
                    'runtime progress artifact must reference verified typed evidence'
                )
            }
            maximumNoArtifactToolCalls = Math.max(
                maximumNoArtifactToolCalls,
                noArtifactToolCalls
            )
            maximumNoArtifactDurationMs = Math.max(
                maximumNoArtifactDurationMs,
                noArtifactWindowStart === null
                    ? 0
                    : startedAt - noArtifactWindowStart
            )
            noArtifactToolCalls = 0
            noArtifactWindowStart = null
            noArtifactWindowEnd = null
        } else {
            noArtifactToolCalls += 1
            noArtifactWindowStart ??= startedAt
            noArtifactWindowEnd = completedAt
            if (operation.kind === 'read-only') {
                readOnlyOperations += 1
                if (typeof operation.targetPath !== 'string' ||
                    !operation.targetPath.trim()) {
                    errors.push(
                        'runtime read-only operation target path is required'
                    )
                } else if (liveObservation) {
                    touchedPaths.add(operation.targetPath)
                    try {
                        realWorktreePath(
                            binding.worktreeIdentity,
                            operation.targetPath
                        )
                    } catch {
                        errors.push(
                            'runtime read-only operation target is not observable'
                        )
                    }
                } else {
                    touchedPaths.add(operation.targetPath)
                }
            }
        }
    }
    maximumNoArtifactToolCalls = Math.max(
        maximumNoArtifactToolCalls,
        noArtifactToolCalls
    )
    maximumNoArtifactDurationMs = Math.max(
        maximumNoArtifactDurationMs,
        noArtifactWindowStart === null
            ? 0
            : noArtifactWindowEnd - noArtifactWindowStart
    )
    const executableOperations = progress.operations.filter((operation) =>
        operation.kind !== 'checkpoint')
    const firstRequiredOperationIndex = executableOperations.findIndex(
        (operation) => operation.kind !== 'read-only'
    )
    const firstRequiredOperation =
        executableOperations[firstRequiredOperationIndex]
    const observedFirstReadTargets = executableOperations
        .slice(
            0,
            firstRequiredOperationIndex < 0
                ? executableOperations.length
                : firstRequiredOperationIndex
        )
        .map((operation) => operation.targetPath)
    if (firstRequiredOperationIndex < 0 ||
        !sameValue(
            observedFirstReadTargets,
            slice.firstReadTargets
        )) {
        errors.push(
            'runtime progress did not observe the exact firstReadTargets prefix'
        )
    }
    const firstAction = slice.firstAction
    if (firstAction?.kind === 'command' &&
            (firstRequiredOperation?.kind !== 'tool-call' ||
                firstRequiredOperation.command !== firstAction.command) ||
        firstAction?.kind === 'filesystem-write' &&
            (firstRequiredOperation?.kind !== 'artifact' ||
                firstRequiredOperation.writePath !== firstAction.path) ||
        !['command', 'filesystem-write'].includes(firstAction?.kind)) {
        errors.push(
            'runtime progress did not execute the machine-bound first action'
        )
    }
    const lastCompletedAction = machineActionLabel(
        executableOperations.at(-1)
    )
    const maximumCursorActions =
        slice.maxReadOnlyOperationsBeforeCheckpoint +
        slice.maxNoArtifactToolCalls +
        slice.maxChangedFiles +
        (slice.requiredCommands ?? []).length +
        (slice.requiredEvidence ?? []).length
    if (checkpoint.cursor?.kind !== 'executable-slice-action' ||
        checkpoint.cursor?.completedActionCount !==
            executableOperations.length ||
        checkpoint.cursor?.nextActionIndex !==
            executableOperations.length + 1 ||
        checkpoint.cursor?.lastCompletedAction !== lastCompletedAction ||
        executableOperations.length > maximumCursorActions) {
        errors.push(
            'checkpoint cursor does not match the bounded machine operation prefix'
        )
    }
    const remainingActions = remainingMachineActions({
        checkpointStatus: checkpoint.status,
        receiptByDigest,
        slice,
        operations: executableOperations
    })
    if (checkpoint.status === 'complete' &&
        remainingActions.length > 0) {
        errors.push(
            'complete checkpoint is missing machine-observed required files, commands, or evidence'
        )
    }
    const expectedNextRequiredAction = remainingActions[0] ?? null
    if (checkpoint.nextRequiredAction !== expectedNextRequiredAction ||
        !sameValue(progress.derivedCursor, checkpoint.cursor) ||
        !sameValue(progress.remainingActions, remainingActions)) {
        errors.push(
            'checkpoint cursor or remaining work does not match the machine-derived prefix'
        )
    }
    const unauthorizedTouchedPath = [...touchedPaths].some((filePath) =>
        !(slice.allowedPaths ?? []).some((allowedPath) =>
            pathMatches(filePath, allowedPath)))
    if (unauthorizedTouchedPath) {
        errors.push('runtime progress touched a path outside slice ownership')
    }
    const ownedModules = [...new Set(
        [...touchedPaths].map(moduleIdentity)
    )]
    const observedOwnedModules = [...(progress.observedOwnedModules ?? [])]
        .sort()
    if (!sameValue(
        observedOwnedModules,
        ownedModules.filter(Boolean).sort()
    )) {
        errors.push(
            'runtime progress owned modules do not match machine-observed paths'
        )
    }
    const observedClass = durationClass(maximumNoArtifactDurationMs)
    if (progress.observedReadOnlyOperationsBeforeCheckpoint !==
            readOnlyOperations ||
        progress.observedMaxNoArtifactToolCalls !==
            maximumNoArtifactToolCalls ||
        progress.observedMaxNoArtifactActiveDurationClass !== observedClass) {
        errors.push('runtime progress derived counters or duration class mismatch')
    }
    if (ownedModules.filter(Boolean).length > slice.maxOwnedModules) {
        errors.push('runtime progress exceeded maxOwnedModules')
    }
    if (readOnlyOperations >
        slice.maxReadOnlyOperationsBeforeCheckpoint) {
        errors.push(
            'runtime progress exceeded maxReadOnlyOperationsBeforeCheckpoint'
        )
    }
    if (maximumNoArtifactToolCalls > slice.maxNoArtifactToolCalls) {
        errors.push('runtime progress exceeded maxNoArtifactToolCalls')
    }
    const observedClassIndex = DURATION_CLASSES.indexOf(observedClass)
    const maximumClassIndex = DURATION_CLASSES.indexOf(
        slice.maxNoArtifactActiveDurationClass
    )
    if (maximumClassIndex < 0 ||
        observedClassIndex > maximumClassIndex) {
        errors.push(
            'runtime progress exceeded maxNoArtifactActiveDurationClass'
        )
    }
    return errors
}

function typedEvidenceReceipts(checkpoint) {
    return checkpoint?.evidence?.typedEvidenceReceipts ?? []
}

function sealedCheckpointEnvelopeErrors({
    plan,
    slice,
    checkpoint,
    compiledPromptDigest,
    routeDigest
}) {
    const errors = []
    if (!plan || !slice || !checkpoint ||
        plan.contractBindingStatus !== 'verified') {
        return ['verified plan, executable slice, and checkpoint are required']
    }
    if (checkpoint.verificationStatus !== 'verified') {
        errors.push(
            'active writer checkpoint verificationStatus must be verified'
        )
    }
    const plannedSlice = plan.orderedSlices?.find((item) =>
        item.sliceId === slice.sliceId)
    const plannedSliceMismatch = !plannedSlice ||
        Object.keys(plannedSlice).some((field) =>
            !sameValue(plannedSlice[field], slice[field]))
    if (slice.schema !== 'issue-orchestration.executable-slice.v1' ||
        !HASH.test(slice.sliceDigest ?? '') ||
        slice.planDigest !== plan.planDigest ||
        slice.stageRole !== plan.stageRole ||
        slice.stagePhase !== plan.stagePhase ||
        plannedSliceMismatch) {
        errors.push('typed evidence executable slice identity mismatch')
    }
    if (checkpoint.schema !==
            'issue-orchestration.stage-progress-checkpoint.v1' ||
        !HASH.test(checkpoint.checkpointDigest ?? '') ||
        checkpoint.checkpointDigest !==
            unsignedDigest(checkpoint, 'checkpointDigest') ||
        !HASH.test(checkpoint.evidence?.evidenceDigest ?? '') ||
        checkpoint.evidence.evidenceDigest !==
            unsignedDigest(checkpoint.evidence, 'evidenceDigest') ||
        checkpoint.evidenceDigest !==
            checkpoint.evidence.evidenceDigest ||
        checkpoint.runId !== plan.runId ||
        checkpoint.node !== plan.node ||
        checkpoint.baseSha !== plan.baseSha ||
        checkpoint.epochId !== plan.epochId ||
        checkpoint.worktreeIdentity !== plan.worktreeIdentity ||
        checkpoint.sliceId !== slice.sliceId ||
        checkpoint.sliceDigest !== slice.sliceDigest ||
        !['partial', 'complete'].includes(checkpoint.status)) {
        errors.push('sealed writer checkpoint envelope is invalid')
    }
    if (!HASH.test(compiledPromptDigest ?? '')) {
        errors.push('typed evidence compiled prompt digest is invalid')
    }
    if (!HASH.test(routeDigest ?? '')) {
        errors.push('typed evidence route digest is invalid')
    }
    return errors
}

function validateWriterStageCheckpointEvidenceInternal({
    plan,
    slice,
    checkpoint,
    compiledPrompt = null,
    compiledPromptDigest,
    routeDigest,
    sealedAuthority = null,
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = digest([]),
    checkpointOrdinal = 1,
    previousCheckpointDigest = null,
    previousCheckpointVerificationReceiptDigest = null,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    previousMachineTraceSnapshot = null
} = {}, { liveObservation = true } = {}) {
    const errors = sealedCheckpointEnvelopeErrors({
        plan,
        slice,
        checkpoint,
        compiledPromptDigest,
        routeDigest
    })
    if (!plan || !slice || !checkpoint ||
        plan.contractBindingStatus !== 'verified') {
        return [...new Set(errors)]
    }
    if (!Array.isArray(acceptedPriorChangedPaths) ||
        acceptedPriorChangedPaths.some((filePath) =>
            typeof filePath !== 'string' ||
            !filePath.trim() ||
            path.isAbsolute(filePath)) ||
        new Set(acceptedPriorChangedPaths).size !==
            acceptedPriorChangedPaths.length ||
        acceptedPriorChangedPaths.some((filePath) =>
            !(plan.stageAllowedPaths ?? []).some((allowedPath) =>
                pathMatches(filePath, allowedPath)))) {
        errors.push(
            'accepted prior changed paths are not a valid ledger-derived prefix'
        )
    }
    if (!HASH.test(completedSlicePrefixDigest ?? '')) {
        errors.push('completed slice prefix digest is invalid')
    }
    const checkpointChain = {
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength
    }
    errors.push(...checkpointChainErrors(checkpointChain))
    if (liveObservation) {
        try {
            validateActiveWriterResourceAuthority(plan)
            const expectedSlice = compileExecutableSlice({
                plan,
                sliceId: slice.sliceId
            })
            if (!sameValue(expectedSlice, slice)) {
                errors.push(
                    'typed evidence executable slice identity mismatch'
                )
            }
            const expectedPrompt = compileDispatchPrompt({ plan, slice })
            if (compiledPromptDigest !== expectedPrompt.promptDigest) {
                errors.push(
                    'typed evidence compiled prompt digest mismatch'
                )
            }
            const checkpointValidationErrors =
                validateProgressCheckpoint({
                    plan,
                    slice,
                    checkpoint,
                    acceptedPriorChangedPaths
                })
            if (checkpointValidationErrors.length) {
                errors.push(...checkpointValidationErrors.map((item) =>
                    `checkpoint: ${item}`))
            }
        } catch (error) {
            errors.push(error.message)
        }
    } else {
        errors.push(...validateSealedStageWorkPlan(
            plan,
            sealedAuthority
        ))
        errors.push(...validateSealedExecutableSlice({
            plan,
            slice,
            authority: sealedAuthority
        }))
        errors.push(...validateSealedCompiledDispatchPrompt({
            plan,
            slice,
            compiled: compiledPrompt,
            authority: sealedAuthority
        }))
        if (compiledPrompt?.promptDigest !==
            compiledPromptDigest) {
            errors.push(
                'sealed compiled prompt digest does not match checkpoint authority'
            )
        }
    }
    const binding = evidenceBinding({
        plan,
        slice,
        compiledPromptDigest,
        routeDigest
    })
    const receipts = typedEvidenceReceipts(checkpoint)
    if (!Array.isArray(receipts) || receipts.length === 0) {
        errors.push(
            'typed evidence receipts are required; satisfiedEvidenceIds alone are not evidence'
        )
        return [...new Set(errors)]
    }
    const receiptByDigest = new Map()
    for (const receipt of receipts) {
        const bindingErrors = evidenceReceiptBindingErrors(receipt, binding)
        errors.push(...bindingErrors)
        if (bindingErrors.length === 0 &&
            receipt.evidenceType !== 'evidence-bundle') {
            receiptByDigest.set(receipt.receiptDigest, receipt)
        }
    }
    for (const receipt of receipts.filter((item) =>
        item?.evidenceType !== 'evidence-bundle')) {
        const payloadErrors = validateTypedEvidencePayload({
            checkpoint,
            receipt,
            validReceiptDigests: receiptByDigest,
            worktreeIdentity: plan.worktreeIdentity,
            liveObservation
        })
        errors.push(...payloadErrors)
        if (payloadErrors.length > 0) {
            receiptByDigest.delete(receipt.receiptDigest)
        }
    }
    for (const receipt of receipts.filter((item) =>
        item?.evidenceType === 'evidence-bundle')) {
        const payloadErrors = validateTypedEvidencePayload({
            checkpoint,
            receipt,
            validReceiptDigests: receiptByDigest,
            worktreeIdentity: plan.worktreeIdentity,
            liveObservation
        })
        errors.push(...payloadErrors)
        if (payloadErrors.length === 0) {
            receiptByDigest.set(receipt.receiptDigest, receipt)
        }
    }
    for (const evidenceId of slice.requiredEvidence ?? []) {
        const matching = receipts.filter((receipt) =>
            receipt.evidenceId === evidenceId &&
            receiptByDigest.has(receipt.receiptDigest))
        for (const evidenceType of requiredEvidenceTypes(evidenceId)) {
            if (!matching.some((receipt) =>
                receipt.evidenceType === evidenceType)) {
                errors.push(
                    `required typed evidence ${evidenceId} lacks ${evidenceType} receipt`
                )
            }
        }
    }
    const progress = checkpoint.evidence.runtimeProgressObservation
    errors.push(...validateRuntimeProgressObservation({
        checkpoint,
        machineRuntimeTrace: checkpoint.evidence.machineRuntimeTrace,
        progress,
        receiptByDigest,
        slice,
        binding,
        liveObservation,
        checkpointChain,
        previousMachineTraceSnapshot
    }))
    const observedTypedEvidenceDigests = new Set(
        (progress?.operations ?? []).flatMap((operation) => [
            operation.evidenceReceiptDigest,
            operation.artifactReceiptDigest
        ]).filter(Boolean)
    )
    for (const evidenceId of slice.requiredEvidence ?? []) {
        const matching = receipts.filter((receipt) =>
            receipt.evidenceId === evidenceId &&
            receiptByDigest.has(receipt.receiptDigest))
        for (const evidenceType of requiredEvidenceTypes(evidenceId)) {
            if (!matching.some((receipt) =>
                receipt.evidenceType === evidenceType &&
                observedTypedEvidenceDigests.has(
                    receipt.receiptDigest
                ))) {
                errors.push(
                    `required typed evidence ${evidenceId} lacks a machine-observed ${evidenceType} receipt`
                )
            }
        }
    }
    return [...new Set(errors)]
}

export function validateWriterStageCheckpointEvidence(options = {}) {
    return validateWriterStageCheckpointEvidenceInternal(
        options,
        { liveObservation: true }
    )
}

function canonicalTimestamp(value) {
    const timestamp = Date.parse(value)
    return typeof value === 'string' &&
        Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === value
}

function sealCheckpointVerificationReceipt({
    plan,
    slice,
    checkpoint,
    compiledPromptDigest,
    routeDigest,
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = digest([]),
    checkpointOrdinal = 1,
    previousCheckpointDigest = null,
    previousCheckpointVerificationReceiptDigest = null,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    verifiedAt
}) {
    const receipts = typedEvidenceReceipts(checkpoint)
    const trace = checkpoint.evidence.machineRuntimeTrace
    const progress = checkpoint.evidence.runtimeProgressObservation
    return seal({
        schema: CHECKPOINT_VERIFICATION_SCHEMA,
        verificationStatus: 'verified',
        runId: plan.runId,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        checkpointDigest: checkpoint.checkpointDigest,
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest,
        routeDigest,
        stageAttemptId: plan.stageAttemptId,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        resourceRegistrySnapshotDigest:
            plan.resourceRegistrySnapshotDigest,
        resourceLeaseReceiptDigest: plan.resourceLeaseReceiptDigest,
        acceptedPriorChangedPathsDigest: digest(
            [...acceptedPriorChangedPaths].sort()
        ),
        completedSlicePrefixDigest,
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength,
        typedEvidenceReceiptDigests: receipts
            .map((receipt) => receipt.receiptDigest)
            .sort(),
        machineTraceSnapshotDigest:
            trace?.traceSnapshot?.snapshotDigest ?? null,
        machineTracePrefixDigest:
            trace?.traceSnapshot?.prefixDigest ?? null,
        machineTracePrefixByteLength:
            trace?.traceSnapshot?.prefixByteLength ?? null,
        runtimeProgressObservationDigest:
            progress?.observationDigest ?? null,
        operationsDigest: digest(progress?.operations ?? []),
        verifiedAt
    }, 'receiptDigest')
}

export function verifyWriterStageCheckpointLiveEvidence({
    verificationReceipt = null,
    verifiedAt = verificationReceipt?.verifiedAt ??
        new Date().toISOString(),
    ...options
} = {}) {
    const errors = validateWriterStageCheckpointEvidenceInternal(
        options,
        { liveObservation: true }
    )
    if (!canonicalTimestamp(verifiedAt)) {
        errors.push(
            'writer checkpoint live verification timestamp is invalid'
        )
    }
    if (errors.length) {
        throw new Error(
            `writer checkpoint live evidence is invalid: ${
                [...new Set(errors)].join('; ')
            }`
        )
    }
    const receipt = sealCheckpointVerificationReceipt({
        ...options,
        verifiedAt
    })
    if (verificationReceipt &&
        !sameValue(receipt, verificationReceipt)) {
        throw new Error(
            'writer checkpoint live verification receipt mismatch'
        )
    }
    return receipt
}

export function validateSealedWriterStageCheckpointEvidence({
    verificationReceipt,
    ...options
} = {}) {
    const errors = validateWriterStageCheckpointEvidenceInternal(
        options,
        { liveObservation: false }
    )
    if (!canonicalTimestamp(verificationReceipt?.verifiedAt) ||
        verificationReceipt?.schema !==
            CHECKPOINT_VERIFICATION_SCHEMA ||
        verificationReceipt?.verificationStatus !== 'verified' ||
        !HASH.test(verificationReceipt?.receiptDigest ?? '')) {
        errors.push(
            'sealed writer checkpoint verification receipt is required'
        )
        return [...new Set(errors)]
    }
    const expectedReceipt = sealCheckpointVerificationReceipt({
        ...options,
        verifiedAt: verificationReceipt.verifiedAt
    })
    if (!sameValue(expectedReceipt, verificationReceipt)) {
        errors.push(
            'sealed writer checkpoint verification receipt binding mismatch'
        )
    }
    return [...new Set(errors)]
}

export function sealWriterStageEvidenceReceipt({
    plan,
    slice,
    compiledPromptDigest,
    routeDigest,
    checkpointEvidence,
    evidenceId,
    evidenceType,
    payload,
    verifiedReceipts = []
} = {}) {
    if (!plan || !slice || !checkpointEvidence ||
        !EVIDENCE_TYPES.has(evidenceType) ||
        typeof evidenceId !== 'string' ||
        !evidenceId.trim()) {
        throw new Error(
            'verified plan, slice, checkpoint evidence, evidence id and type are required'
        )
    }
    if (plan.contractBindingStatus === 'verified') {
        validateActiveWriterResourceAuthority(plan)
    }
    const receipt = seal({
        schema: TYPED_EVIDENCE_SCHEMA,
        ...evidenceBinding({
            plan,
            slice,
            compiledPromptDigest,
            routeDigest
        }),
        evidenceId,
        evidenceType,
        payload: structuredClone(payload)
    }, 'receiptDigest')
    const checkpoint = {
        evidence: checkpointEvidence
    }
    const validReceiptDigests = new Map(
        verifiedReceipts.map((item) => [item.receiptDigest, item])
    )
    const errors = [
        ...evidenceReceiptBindingErrors(
            receipt,
            evidenceBinding({
                plan,
                slice,
                compiledPromptDigest,
                routeDigest
            })
        ),
        ...validateTypedEvidencePayload({
            checkpoint,
            receipt,
            validReceiptDigests,
            worktreeIdentity: plan.worktreeIdentity
        })
    ]
    if (errors.length) {
        throw new Error(
            `writer stage typed evidence is invalid: ${errors.join('; ')}`
        )
    }
    return receipt
}

export function sealWriterStageRuntimeProgressObservation({
    plan,
    slice,
    compiledPromptDigest,
    routeDigest,
    checkpointEvidence,
    typedEvidenceReceipts: receipts,
    machineRuntimeTrace,
    checkpointOrdinal = 1,
    previousCheckpointDigest = null,
    previousCheckpointVerificationReceiptDigest = null,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    previousMachineTraceSnapshot = null
} = {}) {
    if (plan?.contractBindingStatus === 'verified') {
        validateActiveWriterResourceAuthority(plan)
    }
    const binding = evidenceBinding({
        plan,
        slice,
        compiledPromptDigest,
        routeDigest
    })
    const provisional = {
        schema: RUNTIME_PROGRESS_SCHEMA,
        source: 'machine-writer-runtime',
        ...binding,
        checkpointKind: null
    }
    const checkpointChain = {
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength
    }
    const chainErrors = checkpointChainErrors(checkpointChain)
    if (chainErrors.length) {
        throw new Error(
            `writer checkpoint chain is invalid: ${
                chainErrors.join('; ')
            }`
        )
    }
    const replay = validateMachineRuntimeTrace(
        machineRuntimeTrace,
        binding,
        {
            liveObservation: true,
            checkpointChain,
            previousMachineTraceSnapshot
        }
    )
    if (replay.errors.length) {
        throw new Error(
            `writer stage machine trace is invalid: ${replay.errors.join('; ')}`
        )
    }
    provisional.machineTraceReceiptDigest =
        machineRuntimeTrace.receiptDigest
    provisional.dispatchReceiptDigest =
        machineRuntimeTrace.dispatchReceipt.receiptDigest
    provisional.rolloutId = machineRuntimeTrace.runtimeObservation.rolloutId
    provisional.threadId = machineRuntimeTrace.runtimeObservation.threadId
    provisional.operations = replay.operations
    provisional.checkpointKind =
        replay.operations.at(-1)?.checkpointKind ?? null
    const receiptByDigest = new Map(
        (receipts ?? []).map((item) => [item.receiptDigest, item])
    )
    let noArtifactToolCalls = 0
    let maximumNoArtifactToolCalls = 0
    let noArtifactWindowStart = null
    let noArtifactWindowEnd = null
    let maximumNoArtifactDurationMs = 0
    let readOnlyOperations = 0
    const touchedPaths = new Set()
    for (const operation of replay.operations) {
        const startedAt = operationTimestamp(operation.startedAt)
        const completedAt = operationTimestamp(operation.completedAt)
        const observedReceipt = receiptByDigest.get(
            operation.evidenceReceiptDigest
        )
        for (const filePath of evidenceReceiptPaths(
            observedReceipt,
            receiptByDigest
        )) {
            touchedPaths.add(filePath)
        }
        if (operation.kind === 'checkpoint') {
            maximumNoArtifactToolCalls = Math.max(
                maximumNoArtifactToolCalls,
                noArtifactToolCalls
            )
            maximumNoArtifactDurationMs = Math.max(
                maximumNoArtifactDurationMs,
                noArtifactWindowStart === null
                    ? 0
                    : startedAt - noArtifactWindowStart
            )
        } else if (operation.kind === 'artifact') {
            maximumNoArtifactToolCalls = Math.max(
                maximumNoArtifactToolCalls,
                noArtifactToolCalls
            )
            maximumNoArtifactDurationMs = Math.max(
                maximumNoArtifactDurationMs,
                noArtifactWindowStart === null
                    ? 0
                    : startedAt - noArtifactWindowStart
            )
            noArtifactToolCalls = 0
            noArtifactWindowStart = null
            noArtifactWindowEnd = null
        } else {
            noArtifactToolCalls += 1
            noArtifactWindowStart ??= startedAt
            noArtifactWindowEnd = completedAt
            if (operation.kind === 'read-only') {
                readOnlyOperations += 1
                touchedPaths.add(operation.targetPath)
            }
        }
    }
    maximumNoArtifactToolCalls = Math.max(
        maximumNoArtifactToolCalls,
        noArtifactToolCalls
    )
    maximumNoArtifactDurationMs = Math.max(
        maximumNoArtifactDurationMs,
        noArtifactWindowStart === null
            ? 0
            : noArtifactWindowEnd - noArtifactWindowStart
    )
    provisional.observedOwnedModules = [...new Set(
        [...touchedPaths].map(moduleIdentity)
    )].filter(Boolean).sort()
    provisional.observedReadOnlyOperationsBeforeCheckpoint =
        readOnlyOperations
    provisional.observedMaxNoArtifactToolCalls =
        maximumNoArtifactToolCalls
    provisional.observedMaxNoArtifactActiveDurationClass =
        durationClass(maximumNoArtifactDurationMs)
    const checkpointOperation = replay.operations.at(-1)
    const executableOperations = replay.operations.filter((operation) =>
        operation.kind !== 'checkpoint')
    provisional.derivedCursor = {
        kind: 'executable-slice-action',
        completedActionCount: executableOperations.length,
        nextActionIndex: executableOperations.length + 1,
        lastCompletedAction: machineActionLabel(
            executableOperations.at(-1)
        )
    }
    provisional.remainingActions = remainingMachineActions({
        checkpointStatus: checkpointOperation?.checkpointStatus,
        receiptByDigest,
        slice,
        operations: executableOperations
    })
    const progress = seal(provisional, 'observationDigest')
    const checkpoint = {
        status: checkpointOperation?.checkpointStatus,
        cursor: provisional.derivedCursor,
        nextRequiredAction: checkpointOperation?.nextRequiredAction,
        evidence: {
            ...checkpointEvidence,
            typedEvidenceReceipts: receipts,
            machineRuntimeTrace
        }
    }
    const errors = validateRuntimeProgressObservation({
        checkpoint,
        machineRuntimeTrace,
        progress,
        receiptByDigest,
        slice,
        binding,
        checkpointChain,
        previousMachineTraceSnapshot
    })
    if (errors.length) {
        throw new Error(
            `writer stage runtime progress is invalid: ${errors.join('; ')}`
        )
    }
    return progress
}

export function compileVerifiedWriterStageContinuation({
    plan,
    slice,
    checkpoint,
    compiledPrompt,
    compiledPromptDigest,
    routeDigest,
    checkpointVerificationReceipt,
    sealedAuthority,
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = digest([]),
    previousMachineTraceSnapshot = null,
    requestedResume
} = {}) {
    const errors = validateSealedWriterStageCheckpointEvidence({
        plan,
        slice,
        checkpoint,
        compiledPrompt,
        compiledPromptDigest,
        routeDigest,
        verificationReceipt: checkpointVerificationReceipt,
        sealedAuthority,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest,
        checkpointOrdinal:
            checkpointVerificationReceipt?.checkpointOrdinal,
        previousCheckpointDigest:
            checkpointVerificationReceipt?.previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest:
            checkpointVerificationReceipt
                ?.previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest:
            checkpointVerificationReceipt
                ?.previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength:
            checkpointVerificationReceipt
                ?.previousMachineTracePrefixByteLength,
        previousMachineTraceSnapshot
    })
    if (errors.length || checkpoint.status !== 'partial') {
        throw new Error(
            'writer stage continuation requires sealed partial machine '
            + `evidence: ${errors.join('; ')}`
        )
    }
    return compileSealedContinuation({
        plan,
        slice,
        compiledPrompt,
        checkpoint,
        checkpointVerificationReceiptDigest:
            checkpointVerificationReceipt.receiptDigest,
        checkpointOrdinal:
            checkpointVerificationReceipt.checkpointOrdinal,
        previousCheckpointDigest:
            checkpointVerificationReceipt.previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest:
            checkpointVerificationReceipt
                .previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest:
            checkpointVerificationReceipt
                .previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength:
            checkpointVerificationReceipt
                .previousMachineTracePrefixByteLength,
        machineTracePrefixDigest:
            checkpointVerificationReceipt.machineTracePrefixDigest,
        machineTracePrefixByteLength:
            checkpointVerificationReceipt
                .machineTracePrefixByteLength,
        completedSlicePrefixDigest:
            checkpointVerificationReceipt
                .completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest:
            checkpointVerificationReceipt
                .acceptedPriorChangedPathsDigest,
        authority: sealedAuthority,
        requestedResume
    })
}

function assertObservation(observation) {
    if (observation?.schema !==
        'issue-orchestration.writer-stage-observation.v1') {
        throw new Error('writer stage observation schema is required')
    }
    for (const field of [
        'runId', 'repository', 'node', 'epochId', 'worktreeIdentity',
        'sliceId', 'stageRole', 'stagePhase', 'attemptId', 'agentId'
    ]) {
        if (typeof observation[field] !== 'string' ||
            !observation[field].trim()) {
            throw new Error(`writer stage observation ${field} is required`)
        }
    }
    if (!Number.isInteger(observation.issue) &&
        typeof observation.issue !== 'string') {
        throw new Error('writer stage observation issue is required')
    }
    if (!SHA.test(observation.baseSha ?? '')) {
        throw new Error('writer stage observation baseSha is invalid')
    }
    for (const field of [
        'sliceDigest', 'planDigest', 'compiledPromptDigest', 'routeDigest'
    ]) {
        if (!HASH.test(observation[field] ?? '')) {
            throw new Error(`writer stage observation ${field} is invalid`)
        }
    }
    const key = `${observation.stagePhase}:${observation.stageRole}`
    if (!STAGE_REQUIREMENTS[key] &&
        !HISTORICAL_STAGE_REQUIREMENTS[key]) {
        throw new Error('writer stage role and phase are not authorized')
    }
}

function hasDiff(observation) {
    const git = observation.gitObservation
    const filesystem = observation.filesystemObservation
    return Array.isArray(git?.changedPaths) &&
        git.changedPaths.length > 0 &&
        HASH.test(git.diffDigest ?? '') &&
        Array.isArray(git.unauthorizedPaths) &&
        git.unauthorizedPaths.length === 0 &&
        Array.isArray(filesystem?.createdFiles) &&
        Array.isArray(filesystem?.modifiedFiles) &&
        HASH.test(filesystem.treeDigest ?? '') &&
        (filesystem.createdFiles.length + filesystem.modifiedFiles.length > 0)
}

function hasCommands(observation) {
    const command = observation.commandObservation
    return Array.isArray(command?.commands) &&
        command.commands.length > 0 &&
        Array.isArray(command.statuses) &&
        command.statuses.length === command.commands.length &&
        command.statuses.every((status) => status === 0) &&
        Array.isArray(command.evidenceDigests) &&
        command.evidenceDigests.length === command.commands.length &&
        command.evidenceDigests.every((value) => HASH.test(value))
}

function hasTestContractArtifacts(observation) {
    const filesystem = observation.filesystemObservation
    const changed = [
        ...(filesystem?.createdFiles ?? []),
        ...(filesystem?.modifiedFiles ?? [])
    ]
    return hasDiff(observation) &&
        changed.length > 0 &&
        changed.every((entry) => {
            const candidate = typeof entry === 'string' ? entry : entry?.path
            return typeof candidate === 'string' &&
                (candidate.startsWith('tests/') ||
                    candidate.includes('/tests/') ||
                    candidate.startsWith('fixtures/') ||
                    candidate.includes('/fixtures/'))
        })
}

function hasCheckpoint(observation, machineEvidenceErrors = []) {
    const checkpoint = observation.checkpoint
    return checkpoint?.schema ===
        'issue-orchestration.stage-progress-checkpoint.v1' &&
        checkpoint.sliceId === observation.sliceId &&
        checkpoint.sliceDigest === observation.sliceDigest &&
        HASH.test(checkpoint.checkpointDigest ?? '') &&
        machineEvidenceErrors.length === 0
}

function hasTypedEvidenceType(observation, evidenceType) {
    if (observation.plan?.contractBindingStatus !== 'verified') return false
    const binding = evidenceBinding({
        plan: observation.plan,
        slice: observation.currentSlice,
        compiledPromptDigest: observation.compiledPromptDigest,
        routeDigest: observation.routeDigest
    })
    return typedEvidenceReceipts(observation.checkpoint).some((receipt) =>
        receipt.evidenceType === evidenceType &&
        evidenceReceiptBindingErrors(receipt, binding).length === 0)
}

function hasRenderEvidence(observation) {
    if (observation.plan?.contractBindingStatus === 'verified') {
        return hasTypedEvidenceType(observation, 'ui-render')
    }
    const evidence = observation.renderEvidence
    return evidence && typeof evidence === 'object' &&
        HASH.test(evidence.evidenceDigest ?? evidence.receiptDigest ?? '')
}

function hasNoChangeEvidence(observation) {
    if (observation.plan?.contractBindingStatus === 'verified') {
        return hasTypedEvidenceType(
            observation,
            'documentation-no-change'
        )
    }
    const evidence = observation.verifiedNoChangeEvidence
    return validReceipt(
        evidence,
        'issue-orchestration.writer-stage-no-change-evidence.v1'
    ) && evidence.status === 'verified' &&
        evidence.sliceDigest === observation.sliceDigest
}

function hasConflictMapping(observation) {
    if (observation.plan?.contractBindingStatus === 'verified') {
        return hasTypedEvidenceType(observation, 'conflict-mapping')
    }
    const mapping = observation.conflictMapping
    return mapping && typeof mapping === 'object' &&
        Array.isArray(mapping.entries) &&
        mapping.entries.length > 0 &&
        HASH.test(mapping.mappingDigest ?? '')
}

function pathFromObservationEntry(entry) {
    return typeof entry === 'string' ? entry : entry?.path
}

function statusChangedPaths(worktreeStatus) {
    if (typeof worktreeStatus !== 'string' || !worktreeStatus.trim()) return []
    const decode = (candidate) => {
        if (candidate.startsWith('"') && candidate.endsWith('"')) {
            try {
                return JSON.parse(candidate)
            } catch {
                return candidate
            }
        }
        return candidate
    }
    return worktreeStatus.split('\n').flatMap((line) => {
        const raw = line.slice(3)
        return raw.includes(' -> ')
            ? raw.split(' -> ').map(decode)
            : [decode(raw)]
    }).filter(Boolean)
}

function sameStringSet(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
        JSON.stringify([...new Set(left)].sort()) ===
            JSON.stringify([...new Set(right)].sort())
}

function requirementSatisfied(
    requirement,
    observation,
    machineEvidenceErrors = []
) {
    switch (requirement) {
        case 'diff':
            return hasDiff(observation)
        case 'commands':
            return hasCommands(observation)
        case 'tests-or-fixtures':
            return hasTestContractArtifacts(observation)
        case 'checkpoint':
            return hasCheckpoint(observation, machineEvidenceErrors)
        case 'render-evidence':
            return hasRenderEvidence(observation)
        case 'verified-no-change-evidence':
            return hasNoChangeEvidence(observation)
        case 'conflict-mapping':
            return hasConflictMapping(observation)
        default:
            return false
    }
}

function requiredOutputs(observation, machineEvidenceErrors = []) {
    const requirements = stageRequirements(observation)
    if (observation.stagePhase === 'documentation') {
        const diffOrNoChange = hasDiff(observation) || hasNoChangeEvidence(observation)
        return [
            ...(diffOrNoChange ? [] : ['diff', 'verified-no-change-evidence']),
            ...(hasCheckpoint(observation, machineEvidenceErrors)
                ? []
                : ['checkpoint'])
        ]
    }
    return requirements.filter((requirement) =>
        !requirementSatisfied(
            requirement,
            observation,
            machineEvidenceErrors
        ))
}

function evidenceIdentity(observation) {
    return {
        stagePhase: observation.stagePhase,
        stageRole: observation.stageRole,
        firstRequiredActionExecuted:
            observation.firstRequiredActionExecuted === true,
        changedPaths: observation.gitObservation?.changedPaths ?? [],
        diffDigest: observation.gitObservation?.diffDigest ?? null,
        unauthorizedPaths: observation.gitObservation?.unauthorizedPaths ?? [],
        commands: observation.commandObservation?.commands ?? [],
        statuses: observation.commandObservation?.statuses ?? [],
        commandEvidenceDigests:
            observation.commandObservation?.evidenceDigests ?? [],
        renderEvidenceDigest:
            observation.renderEvidence?.evidenceDigest ??
            observation.renderEvidence?.receiptDigest ??
            null,
        verifiedNoChangeEvidenceDigest:
            observation.verifiedNoChangeEvidence?.receiptDigest ?? null,
        conflictMappingDigest:
            observation.conflictMapping?.mappingDigest ?? null,
        typedEvidenceReceiptDigests:
            typedEvidenceReceipts(observation.checkpoint)
                .map(({ receiptDigest }) => receiptDigest),
        runtimeProgressObservationDigest:
            observation.checkpoint?.evidence
                ?.runtimeProgressObservation?.observationDigest ?? null,
        machineRuntimeTraceReceiptDigest:
            observation.checkpoint?.evidence
                ?.machineRuntimeTrace?.receiptDigest ?? null,
        checkpointDigest: observation.checkpoint?.checkpointDigest ?? null,
        terminalReceiptDigest: observation.terminalReceipt?.receiptDigest ?? null
    }
}

function semanticFailureDigest(observation, eventType, evidenceDigest) {
    const slice = observation.currentSlice
    const semanticRequirement = slice
        ? {
            singleObjective: slice.singleObjective,
            stageRole: slice.stageRole,
            stagePhase: slice.stagePhase,
            allowedPaths: slice.allowedPaths,
            forbiddenPaths: slice.forbiddenPaths,
            requiredFiles:
                slice.requiredCreatedOrModifiedFiles ?? slice.requiredFiles,
            requiredCommands: slice.requiredCommands,
            requiredEvidence: slice.requiredEvidence,
            completionPredicate: slice.completionPredicate,
            continuationPredicate: slice.continuationPredicate
        }
        : {
            stageRole: observation.stageRole,
            stagePhase: observation.stagePhase,
            requiredArtifactManifest:
                observation.requiredArtifactManifest ??
                stageRequirements(observation)
        }
    return digest({
        repository: observation.repository,
        issue: observation.issue,
        node: observation.node,
        baseSha: observation.baseSha,
        epochId: observation.epochId,
        semanticRequirement,
        eventType,
        evidenceDigest
    })
}

function classifyFailure(observation, missing, machineEvidenceErrors = []) {
    if (observation.invocationObservation?.started === false) {
        return 'writer-stage.invocation-failed'
    }
    if (observation.environmentObservation?.ready === false) {
        return 'writer-stage.environment-failed'
    }
    if (observation.runtimeCapabilityObservation &&
        (observation.runtimeCapabilityObservation.available !== true ||
            observation.runtimeCapabilityObservation
                .effectiveMetadataObserved !== true)) {
        return 'writer-stage.runtime-capability-missing'
    }
    if (!(observation.plan?.contractBindingStatus === 'verified' &&
            observation.currentSlice &&
            observation.checkpoint) &&
        observation.firstRequiredActionExecuted !== true) {
        return 'writer-stage.first-action-not-executed'
    }
    if (machineEvidenceErrors.length > 0) {
        return 'writer-stage.receipt-rejected'
    }
    if (missing.includes('checkpoint') && missing.length === 1) {
        return 'writer-stage.checkpoint-missing'
    }
    if (missing.length > 0) return 'writer-stage.output-missing'
    return 'writer-stage.receipt-rejected'
}

function verifiedCompletionObservation(observation) {
    if (!observation.plan || !observation.currentSlice ||
        !Array.isArray(observation.sliceTerminalReceipts) ||
        observation.plan.contractBindingStatus !== 'verified' ||
        observation.invocationObservation?.started !== true ||
        observation.environmentObservation?.ready !== true ||
        observation.runtimeCapabilityObservation?.available !== true ||
        observation.runtimeCapabilityObservation
            ?.effectiveMetadataObserved !== true) {
        return false
    }
    try {
        const slice = compileExecutableSlice({
            plan: observation.plan,
            sliceId: observation.currentSlice.sliceId
        })
        if (!sameValue(slice, observation.currentSlice)) return false
        const identities = [
            ['runId', observation.plan.runId],
            ['repository', observation.plan.repository],
            ['issue', observation.plan.issue],
            ['node', observation.plan.node],
            ['baseSha', observation.plan.baseSha],
            ['epochId', observation.plan.epochId],
            ['worktreeIdentity', observation.plan.worktreeIdentity],
            ['planDigest', observation.plan.planDigest],
            ['sliceId', slice.sliceId],
            ['sliceDigest', slice.sliceDigest],
            ['stageRole', slice.stageRole],
            ['stagePhase', slice.stagePhase]
        ]
        if (identities.some(([field, expected]) =>
            observation[field] !== expected)) {
            return false
        }
        const compiledPrompt = compileDispatchPrompt({
            plan: observation.plan,
            slice
        })
        if (observation.compiledPromptDigest !== compiledPrompt.promptDigest) {
            return false
        }
        const checkpointErrors = validateProgressCheckpoint({
            plan: observation.plan,
            slice,
            checkpoint: observation.checkpoint
        })
        if (checkpointErrors.length || observation.checkpoint.status !== 'complete') {
            return false
        }
        const checkpointCommands = observation.checkpoint.evidence.commands
        const expectedCommands = checkpointCommands.map(({ command }) => command)
        const expectedStatuses = checkpointCommands.map(({ exitStatus }) => exitStatus)
        const expectedCommandDigests =
            checkpointCommands.map(({ outputDigest }) => outputDigest)
        if (!sameValue(observation.commandObservation?.commands, expectedCommands) ||
            !sameValue(observation.commandObservation?.statuses, expectedStatuses) ||
            !sameValue(
                observation.commandObservation?.evidenceDigests,
                expectedCommandDigests
            ) ||
            observation.gitObservation?.diffDigest !==
                observation.checkpoint.diffDigest ||
            observation.filesystemObservation?.treeDigest !==
                observation.checkpoint.treeDigest) {
            return false
        }
        const observedFilesystemPaths = [
            ...(observation.filesystemObservation?.createdFiles ?? []),
            ...(observation.filesystemObservation?.modifiedFiles ?? [])
        ].map(pathFromObservationEntry)
        const changedPaths = observation.gitObservation?.changedPaths
        const checkpointChangedPaths = statusChangedPaths(
            observation.checkpoint.evidence.git.worktreeStatus
        )
        if (!sameStringSet(changedPaths, checkpointChangedPaths) ||
            !sameStringSet(observedFilesystemPaths, checkpointChangedPaths) ||
            !Array.isArray(observation.gitObservation?.unauthorizedPaths) ||
            observation.gitObservation.unauthorizedPaths.length !== 0) {
            return false
        }
    const expectedTerminalReceipt = sealSliceTerminalReceipt({
            plan: observation.plan,
            slice,
            checkpoint: observation.checkpoint,
            compiledPromptDigest: observation.compiledPromptDigest,
            routeDigest: observation.routeDigest,
            changedPaths,
            commandEvidenceDigests: expectedCommandDigests
        })
        if (!sameValue(expectedTerminalReceipt, observation.terminalReceipt)) {
            return false
        }
        const receiptIndex = observation.plan.orderedSlices.findIndex(
            ({ sliceId }) => sliceId === slice.sliceId
        )
        return sameValue(
            observation.sliceTerminalReceipts[receiptIndex],
            observation.terminalReceipt
        )
    } catch {
        return false
    }
}

function evaluateWriterStageObservationInternal(
    observation,
    authorityStatus
) {
    assertObservation(observation)
    const machineEvidenceErrors =
        observation.plan?.contractBindingStatus === 'verified' &&
        observation.currentSlice &&
        observation.checkpoint
            ? validateWriterStageCheckpointEvidence({
                plan: observation.plan,
                slice: observation.currentSlice,
                checkpoint: observation.checkpoint,
                compiledPromptDigest: observation.compiledPromptDigest,
                routeDigest: observation.routeDigest
            })
            : []
    const missingRequiredOutputs = requiredOutputs(
        observation,
        machineEvidenceErrors
    )
    const terminalReceiptValid = validReceipt(
        observation.terminalReceipt,
        'issue-orchestration.slice-terminal-receipt.v1'
    ) && observation.terminalReceipt.sliceDigest === observation.sliceDigest &&
        observation.terminalReceipt.outcome === 'completed' &&
        typeof observation.terminalReceipt.candidateEligible === 'boolean' &&
        typeof observation.terminalReceipt.stageComplete === 'boolean' &&
        HASH.test(observation.terminalReceipt.evidenceDigest ?? '') &&
        HASH.test(observation.terminalReceipt.checkpointDigest ?? '')
    if (missingRequiredOutputs.length === 0 && terminalReceiptValid &&
        verifiedCompletionObservation(observation)) {
        return evaluateSliceTerminalGate({
            plan: observation.plan,
            currentSlice: observation.currentSlice,
            currentCheckpoint: observation.checkpoint,
            terminalReceipts: observation.sliceTerminalReceipts
        })
    }
    const eventType = classifyFailure(
        observation,
        missingRequiredOutputs,
        machineEvidenceErrors
    )
    const evidenceDigest = digest(evidenceIdentity(observation))
    const failureReceipt = seal({
        schema: 'issue-orchestration.writer-stage-failure-receipt.v1',
        runId: observation.runId,
        repository: observation.repository,
        issue: observation.issue,
        node: observation.node,
        baseSha: observation.baseSha,
        epochId: observation.epochId,
        worktreeIdentity: observation.worktreeIdentity,
        sliceId: observation.sliceId,
        sliceDigest: observation.sliceDigest,
        planDigest: observation.planDigest,
        compiledPromptDigest: observation.compiledPromptDigest,
        routeDigest: observation.routeDigest,
        stageRole: observation.stageRole,
        stagePhase: observation.stagePhase,
        attemptId: observation.attemptId,
        agentId: observation.agentId,
        status: 'terminal',
        authorityStatus,
        eventType,
        breakerOpen: true,
        missingRequiredOutputs,
        receiptValidationErrors: machineEvidenceErrors,
        evidenceDigest,
        semanticFailureDigest: semanticFailureDigest(
            observation,
            eventType,
            evidenceDigest
        )
    }, 'receiptDigest')
    return Object.freeze({
        status: 'failed',
        eventType,
        terminalTransition: true,
        breakerOpen: true,
        missingRequiredOutputs,
        countsAsImplementationRework: false,
        reworkCountDelta: 0,
        triggersHumanDecision: false,
        nextState: 'terminal',
        failureReceipt
    })
}

export function auditHistoricalWriterStageObservation(observation) {
    if (!historicalLandingObservation(observation)) {
        throw new Error(
            'historical writer-stage audit only accepts landing-owner observations'
        )
    }
    return evaluateWriterStageObservationInternal(
        observation,
        'historical-observation-only'
    )
}

export function evaluateWriterStageObservation(observation) {
    if (historicalLandingObservation(observation)) {
        return auditHistoricalWriterStageObservation(observation)
    }
    return evaluateWriterStageObservationInternal(
        observation,
        'active-writer'
    )
}

function terminalChainDigestFor(receipt) {
    return digest({
        planDigest: receipt.planDigest,
        sliceId: receipt.sliceId,
        sliceDigest: receipt.sliceDigest,
        sliceOrdinal: receipt.sliceOrdinal,
        planSliceCount: receipt.planSliceCount,
        checkpointDigest: receipt.checkpointDigest,
        checkpointVerificationReceiptDigest:
            receipt.checkpointVerificationReceiptDigest,
        completedSlicePrefixDigest:
            receipt.completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest:
            receipt.acceptedPriorChangedPathsDigest,
        priorTerminalReceiptDigests:
            receipt.priorTerminalReceiptDigests
    })
}

function terminalReceiptForSlice(plan, slice, receipt) {
    const index = plan.orderedSlices.findIndex(({ sliceId }) =>
        sliceId === slice.sliceId)
    const expectedNextSliceId = index === plan.orderedSlices.length - 1
        ? null
        : plan.orderedSlices[index + 1].sliceId
    return validReceipt(
        receipt,
        'issue-orchestration.slice-terminal-receipt.v1'
    ) &&
        receipt.planDigest === plan.planDigest &&
        receipt.sliceId === slice.sliceId &&
        HASH.test(receipt.sliceDigest ?? '') &&
        (slice.sliceDigest === undefined ||
            receipt.sliceDigest === slice.sliceDigest) &&
        HASH.test(receipt.compiledPromptDigest ?? '') &&
        receipt.stageRole === plan.stageRole &&
        receipt.stagePhase === plan.stagePhase &&
        receipt.outcome === 'completed' &&
        HASH.test(receipt.checkpointDigest ?? '') &&
        HASH.test(
            receipt.checkpointVerificationReceiptDigest ?? ''
        ) &&
        HASH.test(receipt.evidenceDigest ?? '') &&
        receipt.sliceOrdinal === index + 1 &&
        receipt.planSliceCount === plan.orderedSlices.length &&
        Array.isArray(receipt.priorTerminalReceiptDigests) &&
        receipt.priorTerminalReceiptDigests.length === index &&
        receipt.priorTerminalReceiptDigests.every((value) =>
            HASH.test(value)) &&
        HASH.test(receipt.completedSlicePrefixDigest ?? '') &&
        HASH.test(
            receipt.acceptedPriorChangedPathsDigest ?? ''
        ) &&
        receipt.terminalChainDigest ===
            terminalChainDigestFor(receipt) &&
        receipt.nextSliceId === expectedNextSliceId
}

function carriedTerminalReceiptForSlice({
    carryForwardPrefix,
    currentPlan,
    index,
    receipt
}) {
    const mapping = carryForwardPrefix?.entries?.[index]
    return carryForwardPrefix?.schema ===
            'issue-orchestration.writer-stage-completed-prefix-carry-forward.v1' &&
        carryForwardPrefix.verificationStatus === 'verified' &&
        carryForwardPrefix.receiptDigest ===
            unsignedDigest(carryForwardPrefix, 'receiptDigest') &&
        carryForwardPrefix.currentPlanDigest ===
            currentPlan.planDigest &&
        carryForwardPrefix.currentStageAttemptId ===
            currentPlan.stageAttemptId &&
        mapping?.order === index + 1 &&
        mapping.sliceId ===
            currentPlan.orderedSlices[index]?.sliceId &&
        mapping.currentPlanDigest === currentPlan.planDigest &&
        mapping.currentStageAttemptId ===
            currentPlan.stageAttemptId &&
        mapping.previousTerminalReceiptDigest ===
            receipt?.receiptDigest &&
        mapping.previousPlanDigest === receipt?.planDigest &&
        mapping.previousSliceDigest === receipt?.sliceDigest &&
        mapping.previousCheckpointDigest ===
            receipt?.checkpointDigest &&
        mapping.previousTerminalChainDigest ===
            receipt?.terminalChainDigest &&
        mapping.previousSliceOrdinal ===
            receipt?.sliceOrdinal &&
        mapping.previousPlanSliceCount ===
            receipt?.planSliceCount &&
        sameValue(
            mapping.previousPriorTerminalReceiptDigests,
            receipt?.priorTerminalReceiptDigests
        ) &&
        mapping.previousCompletedSlicePrefixDigest ===
            receipt?.completedSlicePrefixDigest &&
        mapping.previousAcceptedPriorChangedPathsDigest ===
            receipt?.acceptedPriorChangedPathsDigest &&
        sameValue(
            mapping.changedPaths,
            [...(receipt?.changedPaths ?? [])].sort()
        ) &&
        validReceipt(
            receipt,
            'issue-orchestration.slice-terminal-receipt.v1'
        ) &&
        receipt.sliceId === mapping.sliceId &&
        receipt.stageRole === currentPlan.stageRole &&
        receipt.stagePhase === currentPlan.stagePhase &&
        receipt.outcome === 'completed' &&
        receipt.stageComplete === false &&
        receipt.candidateEligible === false
}

export function sealSliceTerminalReceipt({
    carryForwardPrefix = null,
    plan,
    slice,
    checkpoint,
    compiledPrompt,
    compiledPromptDigest,
    routeDigest,
    checkpointVerificationReceipt,
    sealedAuthority,
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = digest([]),
    previousMachineTraceSnapshot = null,
    priorTerminalReceipts = [],
    changedPaths = [],
    commandEvidenceDigests = []
} = {}) {
    const sliceErrors = validateSealedExecutableSlice({
        plan,
        slice,
        authority: sealedAuthority
    })
    if (sliceErrors.length) {
        throw new Error('slice terminal receipt requires the verified executable slice')
    }
    const checkpointErrors =
        validateSealedWriterStageCheckpointEvidence({
            plan,
            slice,
            checkpoint,
            compiledPrompt,
            compiledPromptDigest,
            routeDigest,
            sealedAuthority,
            verificationReceipt:
                checkpointVerificationReceipt,
            acceptedPriorChangedPaths,
            completedSlicePrefixDigest,
            checkpointOrdinal:
                checkpointVerificationReceipt
                    ?.checkpointOrdinal,
            previousCheckpointDigest:
                checkpointVerificationReceipt
                    ?.previousCheckpointDigest,
            previousCheckpointVerificationReceiptDigest:
                checkpointVerificationReceipt
                    ?.previousCheckpointVerificationReceiptDigest,
            previousMachineTracePrefixDigest:
                checkpointVerificationReceipt
                    ?.previousMachineTracePrefixDigest,
            previousMachineTracePrefixByteLength:
                checkpointVerificationReceipt
                    ?.previousMachineTracePrefixByteLength,
            previousMachineTraceSnapshot
        })
    if (checkpointErrors.length || checkpoint.status !== 'complete') {
        throw new Error(
            `slice terminal receipt requires a complete machine checkpoint: ${checkpointErrors.join('; ')}`
        )
    }
    if (!Array.isArray(changedPaths) ||
        changedPaths.some((item) => typeof item !== 'string' || !item) ||
        !Array.isArray(commandEvidenceDigests) ||
        commandEvidenceDigests.some((value) => !HASH.test(value)) ||
        !Array.isArray(priorTerminalReceipts) ||
        !HASH.test(compiledPromptDigest ?? '') ||
        !HASH.test(routeDigest ?? '')) {
        throw new Error('slice terminal receipt machine evidence is invalid')
    }
    const observedChangedPaths = statusChangedPaths(
        checkpoint.evidence.git.worktreeStatus
    ).filter((filePath) =>
        !acceptedPriorChangedPaths.includes(filePath))
    const expectedCommandEvidenceDigests =
        checkpoint.evidence.commands.map(({ outputDigest }) => outputDigest)
    const terminalEvidenceErrors = []
    if (!sameStringSet(changedPaths, observedChangedPaths)) {
        terminalEvidenceErrors.push(
            `changed paths mismatch (claimed=${JSON.stringify(changedPaths)}, `
            + `observed=${JSON.stringify(observedChangedPaths)})`
        )
    }
    if (!sameValue(
        commandEvidenceDigests,
        expectedCommandEvidenceDigests
    )) {
        terminalEvidenceErrors.push('command evidence mismatch')
    }
    if (slice.stagePhase !== 'documentation' && changedPaths.length === 0) {
        terminalEvidenceErrors.push('writer diff missing')
    }
    if (terminalEvidenceErrors.length) {
        throw new Error(
            'slice terminal receipt does not match independently verified '
            + `prompt, Git, or command evidence: ${terminalEvidenceErrors.join('; ')}`
        )
    }
    const index = plan.orderedSlices.findIndex(({ sliceId }) =>
        sliceId === slice.sliceId)
    if (index < 0 ||
        priorTerminalReceipts.length !== index ||
        priorTerminalReceipts.some((receipt, receiptIndex) =>
            !(
                receiptIndex <
                    (carryForwardPrefix?.entries?.length ?? 0)
                    ? carriedTerminalReceiptForSlice({
                        carryForwardPrefix,
                        currentPlan: plan,
                        index: receiptIndex,
                        receipt
                    })
                    : terminalReceiptForSlice(
                        plan,
                        plan.orderedSlices[receiptIndex],
                        receipt
                    )
            ) ||
            receipt.priorTerminalReceiptDigests.length !==
                receiptIndex ||
            !sameValue(
                receipt.priorTerminalReceiptDigests,
                priorTerminalReceipts.slice(0, receiptIndex)
                    .map((item) => item.receiptDigest)
            ))) {
        throw new Error(
            'slice terminal receipt predecessor chain is invalid'
        )
    }
    const finalSlice = index === plan.orderedSlices.length - 1
    const body = {
        schema: 'issue-orchestration.slice-terminal-receipt.v1',
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
        compiledPromptDigest,
        routeDigest,
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        checkpointDigest: checkpoint.checkpointDigest,
        checkpointVerificationReceiptDigest:
            checkpointVerificationReceipt.receiptDigest,
        sliceOrdinal: index + 1,
        planSliceCount: plan.orderedSlices.length,
        priorTerminalReceiptDigests: priorTerminalReceipts
            .map((receipt) => receipt.receiptDigest),
        completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest: digest(
            [...acceptedPriorChangedPaths].sort()
        ),
        outcome: 'completed',
        stageComplete: finalSlice,
        candidateEligible: finalSlice,
        evidenceDigest: checkpoint.evidenceDigest,
        changedPaths: [...changedPaths],
        commandEvidenceDigests: [...commandEvidenceDigests],
        nextSliceId: finalSlice
            ? null
            : plan.orderedSlices[index + 1].sliceId
    }
    body.terminalChainDigest = terminalChainDigestFor(body)
    return seal(body, 'receiptDigest')
}

export function evaluateSliceTerminalGate({
    carryForwardPrefix = null,
    plan,
    currentSlice,
    currentCheckpoint,
    compiledPrompt = null,
    checkpointVerificationReceipt = null,
    sealedAuthority = null,
    acceptedPriorChangedPaths = [],
    completedSlicePrefixDigest = digest([]),
    previousMachineTraceSnapshot = null,
    terminalReceipts,
    nextSlice = null
} = {}) {
    const currentSliceErrors = validateSealedExecutableSlice({
        plan,
        slice: currentSlice,
        authority: sealedAuthority
    })
    if (currentSliceErrors.length) {
        throw new Error('slice terminal gate current slice identity mismatch')
    }
    if (!Array.isArray(terminalReceipts) || terminalReceipts.length === 0) {
        throw new Error('slice terminal gate requires ordered terminal receipts')
    }
    const currentIndex = plan.orderedSlices.findIndex(({ sliceId }) =>
        sliceId === currentSlice.sliceId)
    if (terminalReceipts.length !== currentIndex + 1) {
        throw new Error('slice terminal receipts are missing, duplicated, or out of order')
    }
    const currentReceipt = terminalReceipts[currentIndex]
    const expectedCurrentReceipt = sealSliceTerminalReceipt({
        carryForwardPrefix,
        plan,
        slice: currentSlice,
        checkpoint: currentCheckpoint,
        compiledPrompt,
        compiledPromptDigest: currentReceipt?.compiledPromptDigest,
        routeDigest: currentReceipt?.routeDigest,
        checkpointVerificationReceipt,
        sealedAuthority,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest,
        previousMachineTraceSnapshot,
        priorTerminalReceipts:
            terminalReceipts.slice(0, currentIndex),
        changedPaths: currentReceipt?.changedPaths,
        commandEvidenceDigests: currentReceipt?.commandEvidenceDigests
    })
    if (!sameValue(expectedCurrentReceipt, currentReceipt)) {
        throw new Error(
            'slice terminal receipt is not backed by the current independently verified checkpoint'
        )
    }
    const receiptIds = new Set()
    for (let index = 0; index <= currentIndex; index += 1) {
        const slice = plan.orderedSlices[index]
        const receipt = terminalReceipts[index]
        const carried = index <
            (carryForwardPrefix?.entries?.length ?? 0)
        if (!(carried
            ? carriedTerminalReceiptForSlice({
                carryForwardPrefix,
                currentPlan: plan,
                index,
                receipt
            })
            : terminalReceiptForSlice(plan, slice, receipt)) ||
            receiptIds.has(receipt.sliceId)) {
            throw new Error('slice terminal receipt identity, digest, evidence, or order is invalid')
        }
        receiptIds.add(receipt.sliceId)
        const final = index === plan.orderedSlices.length - 1
        if (receipt.stageComplete !== final ||
            receipt.candidateEligible !== final) {
            throw new Error('slice terminal receipt attempted premature candidate-green')
        }
    }
    const finalStageSlice = currentIndex === plan.orderedSlices.length - 1
    if (finalStageSlice) {
        return Object.freeze({
            status: 'completed',
            eventType: 'writer-stage.completed',
            nextState: 'candidate-green',
            candidateEligible: true,
            stageComplete: true,
            nextSlice: null,
            terminalReceipt:
                terminalReceipts[terminalReceipts.length - 1]
        })
    }
    if (!nextSlice ||
        validateSealedExecutableSlice({
            plan,
            slice: nextSlice,
            authority: sealedAuthority
        }).length ||
        nextSlice.sliceId !==
            plan.orderedSlices[currentIndex + 1].sliceId) {
        throw new Error(
            'slice terminal gate requires the sealed next executable slice'
        )
    }
    return Object.freeze({
        status: 'completed',
        eventType: 'writer-stage.slice-completed',
        nextState: 'next-slice',
        candidateEligible: false,
        stageComplete: false,
        nextSlice,
        terminalReceipt: terminalReceipts[terminalReceipts.length - 1]
    })
}

function validFailureReceipt(receipt) {
    if (receipt?.schema !==
        'issue-orchestration.writer-stage-failure-receipt.v1' ||
        receipt.breakerOpen !== true ||
        receipt.authorityStatus !== undefined &&
            receipt.authorityStatus !== 'active-writer' ||
        !HASH.test(receipt.receiptDigest ?? '')) {
        return false
    }
    const unsigned = { ...receipt }
    delete unsigned.receiptDigest
    return receipt.receiptDigest === digest(unsigned)
}

const RETRY_REVISION_SCHEMA =
    'issue-orchestration.writer-stage-revision-evidence.v1'
const RETRY_REVISION_KINDS = new Set([
    'slice-revision',
    'compiled-prompt-revision',
    'runtime-revision',
    'capability-revision'
])
const RETRY_AUTHORITY = Object.freeze({
    'slice-revision': Object.freeze({
        actorId: 'deterministic-slice-compiler',
        actorRole: 'deterministic-slice-compiler',
        sourceKind: 'verified-executable-slice',
        sourceFile: 'executable-slice-compiler.mjs'
    }),
    'compiled-prompt-revision': Object.freeze({
        actorId: 'deterministic-prompt-compiler',
        actorRole: 'deterministic-prompt-compiler',
        sourceKind: 'verified-compiled-prompt',
        sourceFile: 'executable-slice-compiler.mjs'
    }),
    'runtime-revision': Object.freeze({
        actorId: 'independent-runtime-verifier',
        actorRole: 'independent-runtime-verifier',
        sourceKind: 'verified-runtime-dispatch-receipt',
        sourceFile: 'dispatch-receipt.mjs'
    }),
    'capability-revision': Object.freeze({
        actorId: 'independent-capability-verifier',
        actorRole: 'independent-capability-verifier',
        sourceKind: 'verified-runtime-capability-receipt',
        sourceFile: 'dispatch-receipt.mjs'
    })
})
const SLICE_MATERIAL_FIELDS = Object.freeze([
    'order',
    'prerequisiteSliceIds',
    'singleObjective',
    'firstRequiredAction',
    'firstAction',
    'firstReadTargets',
    'firstWritablePath',
    'explicitReadOnlyOutput',
    'allowedPaths',
    'forbiddenPaths',
    'requiredCreatedOrModifiedFiles',
    'requiredFiles',
    'requiredCommands',
    'requiredEvidence',
    'expectedFailureOrProgressSignal',
    'explicitNonGoals',
    'maxChangedFiles',
    'maxOwnedModules',
    'maxReadOnlyOperationsBeforeCheckpoint',
    'maxNoArtifactToolCalls',
    'maxNoArtifactActiveDurationClass',
    'safeCheckpointKind',
    'acceptanceItemIds',
    'completionPredicate',
    'continuationPredicate'
])

function semanticDigestForFailure(priorFailure) {
    return priorFailure.semanticFailureDigest ?? digest({
        repository: priorFailure.repository,
        issue: priorFailure.issue,
        node: priorFailure.node,
        stageRole: priorFailure.stageRole,
        stagePhase: priorFailure.stagePhase,
        eventType: priorFailure.eventType,
        evidenceDigest: priorFailure.evidenceDigest,
        sliceDigest: priorFailure.sliceDigest
    })
}

function validLegacyFrozenRevision(revision, priorFailure) {
    if (priorFailure.authorityStatus !== undefined ||
        !revision || revision.kind !== 'slice-revision' ||
        !HASH.test(revision.previousDigest ?? '') ||
        !HASH.test(revision.currentDigest ?? '') ||
        revision.previousDigest === revision.currentDigest ||
        !Array.isArray(revision.changedRequirementIds) ||
        revision.changedRequirementIds.length === 0 ||
        revision.changedRequirementIds.some((item) =>
            typeof item !== 'string' || !item.trim()) ||
        !HASH.test(revision.evidenceDigest ?? '')) {
        return false
    }
    return revision.previousDigest === priorFailure.sliceDigest &&
        revision.evidenceDigest === digest({
            changedRequirementIds: revision.changedRequirementIds,
            previousDigest: revision.previousDigest,
            currentDigest: revision.currentDigest
        })
}

function sealedArtifact(value, schema, digestField) {
    return value?.schema === schema &&
        HASH.test(value[digestField] ?? '') &&
        value[digestField] === unsignedDigest(value, digestField)
}

function exactFailureEvent(sourceFailureEvent, priorFailure) {
    if (sourceFailureEvent?.schema !==
        'issue-orchestration.event.v2' ||
        sourceFailureEvent.eventType !== priorFailure.eventType ||
        sourceFailureEvent.runId !== priorFailure.runId ||
        sourceFailureEvent.nodeId !== priorFailure.node ||
        sourceFailureEvent.baseSha !== priorFailure.baseSha ||
        sourceFailureEvent.attemptId !== priorFailure.attemptId ||
        sourceFailureEvent.actorRole !== priorFailure.stageRole ||
        sourceFailureEvent.payload?.failureReceipt?.receiptDigest !==
            priorFailure.receiptDigest ||
        !sameValue(
            sourceFailureEvent.payload.failureReceipt,
            priorFailure
        ) ||
        !HASH.test(sourceFailureEvent.eventDigest ?? '')) {
        return false
    }
    const unsigned = structuredClone(sourceFailureEvent)
    delete unsigned.eventDigest
    return sourceFailureEvent.eventDigest === digest(unsigned)
}

function stablePlanContractMatches(previous, current) {
    const stableFields = [
        'runId',
        'repository',
        'issue',
        'node',
        'stageRole',
        'stagePhase',
        'baseSha',
        'epochId',
        'testContractDigest',
        'skillDigest',
        'baselineDigest',
        'routingInputDigest',
        'stageObjective',
        'acceptanceItems',
        'stageAllowedPaths',
        'stageForbiddenPaths',
        'stageRequiredCommands',
        'stageTerminalArtifacts'
    ]
    return stableFields.every((field) =>
        sameValue(previous?.[field], current?.[field]))
}

function sliceMaterial(slice) {
    return Object.fromEntries(SLICE_MATERIAL_FIELDS.map(
        (field) => [field, structuredClone(slice?.[field])]
    ))
}

export function writerStageSliceMaterialDigest(slice) {
    const material = sliceMaterial(slice)
    delete material.firstAction
    delete material.requiredFiles
    material.firstRequiredAction =
        slice?.firstRequiredAction ?? slice?.firstAction
    material.requiredCreatedOrModifiedFiles =
        slice?.requiredCreatedOrModifiedFiles ??
        slice?.requiredFiles
    return digest(material)
}

function promptMaterial({ prompt, slice }) {
    return {
        slice: sliceMaterial(slice),
        stopContract: (prompt?.prompt ?? '').split('\n')
            .filter((line) =>
                line.startsWith('Stop with ') ||
                line.startsWith('Before returning, '))
    }
}

function revisionRequirements(previousSlice, currentSlice) {
    return new Set([
        ...(previousSlice?.acceptanceItemIds ?? []),
        ...(currentSlice?.acceptanceItemIds ?? []),
        ...(previousSlice?.requiredEvidence ?? []),
        ...(currentSlice?.requiredEvidence ?? [])
    ])
}

function validCompletedPrefixEntry(entry) {
    return entry &&
        HASH.test(entry.planDigest ?? '') &&
        typeof entry.sliceId === 'string' &&
        entry.sliceId.trim() &&
        HASH.test(entry.sliceDigest ?? '') &&
        HASH.test(entry.sliceMaterialDigest ?? '') &&
        HASH.test(entry.checkpointDigest ?? '') &&
        HASH.test(
            entry.checkpointVerificationReceiptDigest ?? ''
        ) &&
        HASH.test(entry.tracePrefixDigest ?? '') &&
        HASH.test(entry.terminalReceiptDigest ?? '') &&
        HASH.test(entry.terminalChainDigest ?? '') &&
        Number.isInteger(entry.sliceOrdinal) &&
        entry.sliceOrdinal > 0 &&
        Number.isInteger(entry.planSliceCount) &&
        entry.planSliceCount >= entry.sliceOrdinal &&
        Array.isArray(entry.priorTerminalReceiptDigests) &&
        entry.priorTerminalReceiptDigests.length ===
            entry.sliceOrdinal - 1 &&
        entry.priorTerminalReceiptDigests.every((value) =>
            HASH.test(value)) &&
        HASH.test(entry.completedSlicePrefixDigest ?? '') &&
        HASH.test(
            entry.acceptedPriorChangedPathsDigest ?? ''
        ) &&
        typeof entry.stageRole === 'string' &&
        typeof entry.stagePhase === 'string' &&
        typeof entry.stageAttemptId === 'string' &&
        entry.stageAttemptId.trim() &&
        Array.isArray(entry.changedPaths) &&
        sameValue(
            entry.changedPaths,
            [...new Set(entry.changedPaths)].sort()
        )
}

function sealCompletedSliceCarryForward({
    completedSlicePrefix,
    currentPlan,
    priorFailure,
    revisionEvidence,
    sourceFailureEvent
}) {
    const previousPlan = sourceFailureEvent.payload.stageWorkPlan
    const failedSliceId =
        sourceFailureEvent.payload.currentSlice.sliceId
    const failedIndex = previousPlan.orderedSlices.findIndex(
        ({ sliceId }) => sliceId === failedSliceId
    )
    if (failedIndex < 0 ||
        !Array.isArray(completedSlicePrefix) ||
        completedSlicePrefix.length !== failedIndex ||
        currentPlan.orderedSlices?.[failedIndex]?.sliceId !==
            failedSliceId ||
        currentPlan.stageAttemptId === priorFailure.attemptId ||
        currentPlan.activeWriteLeaseId ===
            previousPlan.activeWriteLeaseId ||
        currentPlan.resourceLeaseReceiptDigest ===
            previousPlan.resourceLeaseReceiptDigest) {
        throw new Error(
            'retry requires a fresh attempt and lease with the exact ledger-owned completed prefix'
        )
    }
    const entries = completedSlicePrefix.map((entry, index) => {
        if (!validCompletedPrefixEntry(entry) ||
            previousPlan.orderedSlices[index]?.sliceId !==
                entry.sliceId ||
            entry.stageRole !== previousPlan.stageRole ||
            entry.stagePhase !== previousPlan.stagePhase ||
            entry.sliceMaterialDigest !==
                writerStageSliceMaterialDigest(
                    previousPlan.orderedSlices[index]
                )) {
            throw new Error(
                'retry completed prefix does not match the failed canonical plan'
            )
        }
        const currentSlice = compileExecutableSlice({
            plan: currentPlan,
            sliceId: entry.sliceId
        })
        const currentSliceMaterialDigest =
            writerStageSliceMaterialDigest(currentSlice)
        if (currentSliceMaterialDigest !==
            entry.sliceMaterialDigest) {
            throw new Error(
                'retry cannot carry forward a completed slice whose requirements changed'
            )
        }
        return {
            order: index + 1,
            sliceId: entry.sliceId,
            previousPlanDigest: entry.planDigest,
            previousStageAttemptId:
                entry.stageAttemptId,
            previousSliceDigest: entry.sliceDigest,
            previousSliceMaterialDigest:
                entry.sliceMaterialDigest,
            previousCheckpointDigest:
                entry.checkpointDigest,
            previousCheckpointVerificationReceiptDigest:
                entry.checkpointVerificationReceiptDigest,
            previousTracePrefixDigest:
                entry.tracePrefixDigest,
            previousTerminalReceiptDigest:
                entry.terminalReceiptDigest,
            previousTerminalChainDigest:
                entry.terminalChainDigest,
            previousSliceOrdinal: entry.sliceOrdinal,
            previousPlanSliceCount:
                entry.planSliceCount,
            previousPriorTerminalReceiptDigests:
                [...entry.priorTerminalReceiptDigests],
            previousCompletedSlicePrefixDigest:
                entry.completedSlicePrefixDigest,
            previousAcceptedPriorChangedPathsDigest:
                entry.acceptedPriorChangedPathsDigest,
            changedPaths: [...entry.changedPaths],
            currentPlanDigest: currentPlan.planDigest,
            currentStageAttemptId:
                currentPlan.stageAttemptId,
            currentSliceDigest: currentSlice.sliceDigest,
            unchangedSliceMaterialDigest:
                currentSliceMaterialDigest
        }
    })
    return seal({
        schema:
            'issue-orchestration.writer-stage-completed-prefix-carry-forward.v1',
        verificationStatus: 'verified',
        priorFailureReceiptDigest: priorFailure.receiptDigest,
        sourceFailureEventId: sourceFailureEvent.eventId,
        sourceFailureEventDigest:
            sourceFailureEvent.eventDigest,
        revisionEvidenceDigest:
            revisionEvidence.receiptDigest,
        previousPrefixDigest: digest(completedSlicePrefix),
        currentPlanDigest: currentPlan.planDigest,
        currentStageAttemptId: currentPlan.stageAttemptId,
        entries
    }, 'receiptDigest')
}

function canonicalRetrySourceObservation(revisionKind) {
    const authority = RETRY_AUTHORITY[revisionKind]
    const moduleRoot = fs.realpathSync(path.dirname(
        decodeURIComponent(new URL(import.meta.url).pathname)
    ))
    const sourcePath = fs.realpathSync(path.join(
        moduleRoot,
        authority.sourceFile
    ))
    const repositoryRoot = fs.realpathSync(execFileSync(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd: moduleRoot, encoding: 'utf8' }
    ).trim())
    if (sourcePath !== repositoryRoot &&
        !sourcePath.startsWith(`${repositoryRoot}${path.sep}`)) {
        throw new Error('retry authority source escaped the canonical repository')
    }
    const sourceRelativePath = path.relative(repositoryRoot, sourcePath)
    const headSha = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repositoryRoot, encoding: 'utf8' }
    ).trim()
    const sourceGitObjectDigest = execFileSync(
        'git',
        ['hash-object', '--', sourceRelativePath],
        { cwd: repositoryRoot, encoding: 'utf8' }
    ).trim()
    execFileSync(
        process.execPath,
        ['--check', sourcePath],
        { cwd: repositoryRoot, encoding: 'utf8' }
    )
    const observation = {
        repositoryRoot,
        sourcePath,
        sourceRelativePath,
        headSha,
        sourceGitObjectDigest,
        syntaxProbeDigest: digest({
            executable: process.execPath,
            arguments: ['--check', sourcePath],
            exitStatus: 0
        })
    }
    return {
        ...observation,
        observationDigest: digest(observation)
    }
}

function validRuntimeAuthorityReceipt(receipt, proposed) {
    if (receipt?.schema !== 'issue-orchestration.dispatch-receipt.v2' ||
        receipt.verificationStatus !== 'verified' ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest') ||
        receipt.runId !== proposed.stageWorkPlan.runId ||
        receipt.nodeId !== proposed.stageWorkPlan.node ||
        receipt.baseSha !== proposed.stageWorkPlan.baseSha ||
        receipt.epochId !== proposed.stageWorkPlan.epochId ||
        receipt.stageRole !== proposed.stageWorkPlan.stageRole ||
        receipt.stagePhase !== proposed.stageWorkPlan.stagePhase ||
        receipt.planDigest !== proposed.stageWorkPlan.planDigest ||
        receipt.sliceDigest !== proposed.executableSlice.sliceDigest ||
        receipt.compiledPromptDigest !== proposed.compiledPrompt.promptDigest ||
        !HASH.test(receipt.runtimeMetadataDigest ?? '') ||
        typeof receipt.rolloutId !== 'string' ||
        !receipt.rolloutId ||
        typeof receipt.threadId !== 'string' ||
        !receipt.threadId) {
        return false
    }
    return true
}

function verifiedProposedArtifacts(proposed) {
    const plan = proposed?.stageWorkPlan
    const slice = proposed?.executableSlice
    const compiledPrompt = proposed?.compiledPrompt
    if (plan?.contractBindingStatus !== 'verified' ||
        plan.plannerBindingStatus !== 'verified' ||
        slice?.contractBindingStatus !== 'verified' ||
        slice.plannerBindingStatus !== 'verified' ||
        !HASH.test(plan.frozenStageContractReceiptDigest ?? '') ||
        !HASH.test(plan.resourceLeaseReceiptDigest ?? '')) {
        throw new Error(
            'retry requires a verified current plan, contract, source ledger, and resource lease'
        )
    }
    const expectedSlice = compileExecutableSlice({
        plan,
        sliceId: slice?.sliceId
    })
    const expectedPrompt = compileDispatchPrompt({
        plan,
        slice: expectedSlice
    })
    if (!sameValue(expectedSlice, slice) ||
        !sameValue(expectedPrompt, compiledPrompt)) {
        throw new Error(
            'retry proposed plan, slice, or prompt is not the canonical compiler output'
        )
    }
    return { compiledPrompt, plan, slice }
}

export function sealWriterStageRetryRevisionEvidence({
    priorFailure,
    sourceFailureEvent,
    proposed,
    revisionKind,
    changedRequirementIds,
    authorityReceipt = null
} = {}) {
    if (!validFailureReceipt(priorFailure) ||
        priorFailure.authorityStatus !== 'active-writer' ||
        !exactFailureEvent(sourceFailureEvent, priorFailure) ||
        !RETRY_REVISION_KINDS.has(revisionKind) ||
        !Array.isArray(changedRequirementIds) ||
        changedRequirementIds.length === 0 ||
        new Set(changedRequirementIds).size !==
            changedRequirementIds.length ||
        changedRequirementIds.some((item) =>
            typeof item !== 'string' || !item.trim())) {
        throw new Error(
            'active retry revision requires the exact terminal failure event and typed change ids'
        )
    }
    const previousPlan = sourceFailureEvent.payload?.stageWorkPlan
    const previousSlice = sourceFailureEvent.payload?.currentSlice
    const previousPrompt = sourceFailureEvent.payload?.compiledPrompt
    if (!sealedArtifact(
        previousPlan,
        'issue-orchestration.stage-work-plan.v1',
        'planDigest'
    ) ||
        !sealedArtifact(
            previousSlice,
            'issue-orchestration.executable-slice.v1',
            'sliceDigest'
        ) ||
        !sealedArtifact(
            previousPrompt,
            'issue-orchestration.compiled-dispatch-prompt.v1',
            'promptDigest'
        ) ||
        previousPlan.contractBindingStatus !== 'verified' ||
        previousSlice.contractBindingStatus !== 'verified' ||
        previousPlan.planDigest !== priorFailure.planDigest ||
        previousSlice.sliceDigest !== priorFailure.sliceDigest ||
        previousPrompt.promptDigest !==
            priorFailure.compiledPromptDigest) {
        throw new Error(
            'retry revision source event lacks the verified failed plan, slice, and prompt'
        )
    }
    const {
        compiledPrompt: currentPrompt,
        plan: currentPlan,
        slice: currentSlice
    } = verifiedProposedArtifacts(proposed)
    if (!stablePlanContractMatches(previousPlan, currentPlan)) {
        throw new Error(
            'contract, permission, base, epoch, owner, or routing changes require a new authority, not breaker reset'
        )
    }
    const knownRequirements = revisionRequirements(
        previousSlice,
        currentSlice
    )
    if (changedRequirementIds.some((item) =>
        !knownRequirements.has(item))) {
        throw new Error(
            'retry changedRequirementIds must name compiler-owned acceptance or evidence requirements'
        )
    }

    let previousDigest
    let currentDigest
    let previousMaterial
    let currentMaterial
    if (revisionKind === 'slice-revision') {
        previousDigest = previousSlice.sliceDigest
        currentDigest = currentSlice.sliceDigest
        previousMaterial = sliceMaterial(previousSlice)
        currentMaterial = sliceMaterial(currentSlice)
    } else if (revisionKind === 'compiled-prompt-revision') {
        previousDigest = previousPrompt.promptDigest
        currentDigest = currentPrompt.promptDigest
        previousMaterial = promptMaterial({
            prompt: previousPrompt,
            slice: previousSlice
        })
        currentMaterial = promptMaterial({
            prompt: currentPrompt,
            slice: currentSlice
        })
    } else {
        if (!validRuntimeAuthorityReceipt(authorityReceipt, proposed)) {
            throw new Error(
                'runtime and capability revisions require a verified fresh runtime dispatch receipt'
            )
        }
        const previousObservation =
            sourceFailureEvent.payload?.writerStageObservation
                ?.runtimeCapabilityObservation
        previousDigest = digest(previousObservation ?? null)
        currentDigest = authorityReceipt.runtimeMetadataDigest
        previousMaterial = previousObservation ?? null
        currentMaterial = {
            runtimeMetadataDigest: authorityReceipt.runtimeMetadataDigest,
            actualModel: authorityReceipt.actualModel,
            actualEffort: authorityReceipt.actualEffort,
            actualRole: authorityReceipt.actualRole,
            actualMode: authorityReceipt.actualMode,
            actualSandbox: authorityReceipt.actualSandbox,
            actualForkTurns: authorityReceipt.actualForkTurns,
            actualWorkingDirectory:
                authorityReceipt.actualWorkingDirectory
        }
    }
    const previousMaterialDigest = digest(previousMaterial)
    const currentMaterialDigest = digest(currentMaterial)
    if (previousDigest === currentDigest ||
        previousMaterialDigest === currentMaterialDigest) {
        throw new Error(
            'identity shell, prompt wording, failure count, or unchanged material cannot reset the breaker'
        )
    }
    if (revisionKind === 'slice-revision' &&
        previousDigest !== priorFailure.sliceDigest) {
        throw new Error('slice revision does not bind the failed slice')
    }
    if (revisionKind === 'compiled-prompt-revision' &&
        previousDigest !== priorFailure.compiledPromptDigest) {
        throw new Error('prompt revision does not bind the failed compiled prompt')
    }
    const authority = RETRY_AUTHORITY[revisionKind]
    const replayEvidence = canonicalRetrySourceObservation(revisionKind)
    const authoritySourceDigest =
        revisionKind === 'slice-revision'
            ? currentSlice.sliceDigest
            : revisionKind === 'compiled-prompt-revision'
                ? currentPrompt.promptDigest
                : authorityReceipt.receiptDigest
    return seal({
        schema: RETRY_REVISION_SCHEMA,
        verificationStatus: 'verified',
        revisionKind,
        priorFailureReceiptDigest: priorFailure.receiptDigest,
        semanticFailureDigest: semanticDigestForFailure(priorFailure),
        sourceFailureEventId: sourceFailureEvent.eventId,
        sourceFailureEventDigest: sourceFailureEvent.eventDigest,
        previousDigest,
        currentDigest,
        previousMaterialDigest,
        currentMaterialDigest,
        changedRequirementIds: [...changedRequirementIds],
        authorityActorId: authority.actorId,
        authorityActorRole: authority.actorRole,
        authoritySourceKind: authority.sourceKind,
        authoritySourceDigest,
        currentPlanDigest: currentPlan.planDigest,
        currentSliceId: currentSlice.sliceId,
        currentSliceDigest: currentSlice.sliceDigest,
        currentCompiledPromptDigest: currentPrompt.promptDigest,
        contractReceiptDigest:
            currentPlan.frozenStageContractReceiptDigest,
        resourceLeaseReceiptDigest:
            currentPlan.resourceLeaseReceiptDigest,
        replayEvidence,
        authorityReceiptDigest:
            authorityReceipt?.receiptDigest ?? null
    }, 'receiptDigest')
}

function validResourceCleanupReceipt(receipt, priorFailure) {
    if (receipt?.schema !==
        'issue-orchestration.resource-cleanup-receipt.v1' ||
        receipt.actorRole !== 'machine-resource-verifier' ||
        receipt.status !== 'resources-clean' ||
        receipt.runId !== priorFailure.runId ||
        receipt.attemptId !== priorFailure.attemptId ||
        receipt.epochId !== priorFailure.epochId ||
        !Array.isArray(receipt.postInventory) ||
        receipt.postInventory.length !== 0 ||
        !Array.isArray(receipt.failedResources) ||
        receipt.failedResources.length !== 0 ||
        !Array.isArray(receipt.quarantinedResources) ||
        receipt.quarantinedResources.length !== 0 ||
        !Array.isArray(receipt.retainedResources) ||
        receipt.retainedResources.some((item) =>
            item?.reason !==
                'group-resource-retained-until-bound-group-cleanup') ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest')) {
        return false
    }
    return true
}

function expectedTypedRevision({
    priorFailure,
    proposed,
    revision,
    sourceFailureEvent
}) {
    try {
        return sealWriterStageRetryRevisionEvidence({
            priorFailure,
            sourceFailureEvent,
            proposed,
            revisionKind: revision.revisionKind,
            changedRequirementIds: revision.changedRequirementIds,
            authorityReceipt: proposed.authorityReceipt ?? null
        })
    } catch {
        return null
    }
}

export function authorizeWriterStageRetry({
    priorFailure,
    proposed,
    revisions = [],
    sourceFailureEvent = null,
    resourceCleanupReceipt = null
} = {}) {
    const rejected = (reason) => Object.freeze({
        authorized: false,
        breakerOpen: true,
        reason
    })
    if (!validFailureReceipt(priorFailure)) {
        return rejected('unchanged failure: valid prior terminal failure receipt required')
    }
    if (!proposed || typeof proposed !== 'object') {
        return rejected('substantive proposed retry identity is required')
    }
    const semanticFailureDigest = semanticDigestForFailure(priorFailure)
    if (priorFailure.authorityStatus === undefined) {
        const legacyRevision = revisions.find((item) =>
            validLegacyFrozenRevision(item, priorFailure))
        if (!legacyRevision) {
            return rejected(
                'unchanged failure: material revision evidence is required; identity or prompt wording changes are not substantive'
            )
        }
        return seal({
            schema:
                'issue-orchestration.writer-stage-retry-authorization.v1',
            verificationStatus: 'unbound-test-only',
            priorFailureReceiptDigest: priorFailure.receiptDigest,
            semanticFailureDigest,
            priorSliceDigest: priorFailure.sliceDigest,
            nextSliceId: proposed.sliceId ?? null,
            nextSliceDigest: legacyRevision.currentDigest,
            nextPlanDigest: null,
            nextCompiledPromptDigest: null,
            revisionKind: legacyRevision.kind,
            changedRequirementIds: [
                ...legacyRevision.changedRequirementIds
            ],
            revisionEvidence: {
                schema: RETRY_REVISION_SCHEMA,
                verificationStatus: 'unbound-test-only',
                revisionKind: legacyRevision.kind,
                previousDigest: legacyRevision.previousDigest,
                currentDigest: legacyRevision.currentDigest,
                changedRequirementIds: [
                    ...legacyRevision.changedRequirementIds
                ],
                receiptDigest: legacyRevision.evidenceDigest
            },
            revisionEvidenceDigest: legacyRevision.evidenceDigest,
            sourceFailureEventId: null,
            sourceFailureEventDigest: null,
            authorityActorId: 'frozen-test-only',
            authorityActorRole: 'frozen-test-only',
            authoritySourceKind: 'unbound-test-only',
            authoritySourceDigest: legacyRevision.evidenceDigest,
            resourceCleanupReceiptDigest: null,
            authorized: true,
            breakerOpen: false
        }, 'receiptDigest')
    }
    if (!validResourceCleanupReceipt(
        resourceCleanupReceipt,
        priorFailure
    )) {
        return rejected(
            'retry requires a verified #1828 clean resource disposition for the failed attempt'
        )
    }
    const revision = revisions.find((item) =>
        item?.schema === RETRY_REVISION_SCHEMA &&
        item.verificationStatus === 'verified')
    const expectedRevision = revision
        ? expectedTypedRevision({
            priorFailure,
            proposed,
            revision,
            sourceFailureEvent
        })
        : null
    if (!revision || !expectedRevision ||
        !sameValue(revision, expectedRevision) ||
        revision.priorFailureReceiptDigest !== priorFailure.receiptDigest ||
        revision.semanticFailureDigest !== semanticFailureDigest) {
        return rejected(
            'unchanged failure: verified compiler, runtime, or capability revision evidence is required; identity or prompt wording changes are not substantive'
        )
    }
    let carryForwardPrefix
    try {
        carryForwardPrefix = sealCompletedSliceCarryForward({
            completedSlicePrefix:
                proposed.completedSlicePrefix ?? [],
            currentPlan: proposed.stageWorkPlan,
            priorFailure,
            revisionEvidence: revision,
            sourceFailureEvent
        })
    } catch (error) {
        return rejected(error.message)
    }
    const authorization = {
        schema: 'issue-orchestration.writer-stage-retry-authorization.v1',
        verificationStatus: 'verified',
        priorFailureReceiptDigest: priorFailure.receiptDigest,
        semanticFailureDigest,
        priorSliceDigest: priorFailure.sliceDigest,
        nextSliceId: proposed.executableSlice.sliceId,
        nextSliceDigest: proposed.executableSlice.sliceDigest,
        nextPlanDigest: proposed.stageWorkPlan.planDigest,
        nextCompiledPromptDigest: proposed.compiledPrompt.promptDigest,
        revisionKind: revision.revisionKind,
        changedRequirementIds: [...revision.changedRequirementIds],
        revisionEvidence: structuredClone(revision),
        revisionEvidenceDigest: revision.receiptDigest,
        sourceFailureEventId: revision.sourceFailureEventId,
        sourceFailureEventDigest: revision.sourceFailureEventDigest,
        authorityActorId: revision.authorityActorId,
        authorityActorRole: revision.authorityActorRole,
        authoritySourceKind: revision.authoritySourceKind,
        authoritySourceDigest: revision.authoritySourceDigest,
        resourceCleanupReceiptDigest:
            resourceCleanupReceipt.receiptDigest,
        carryForwardPrefix,
        carryForwardPrefixDigest:
            carryForwardPrefix.receiptDigest,
        authorized: true,
        breakerOpen: false
    }
    return seal(authorization, 'receiptDigest')
}

export function validateSealedWriterStageRetryAuthorization({
    authorization,
    completedSlicePrefix = [],
    priorFailure,
    proposed,
    resourceCleanupReceipt,
    revisions = [],
    sealedAuthority,
    sourceFailureEvent
} = {}) {
    const errors = []
    const reject = (message) => errors.push(message)
    if (!validFailureReceipt(priorFailure) ||
        priorFailure.authorityStatus !== 'active-writer' ||
        !exactFailureEvent(sourceFailureEvent, priorFailure) ||
        !validResourceCleanupReceipt(
            resourceCleanupReceipt,
            priorFailure
        )) {
        reject('sealed retry source failure or cleanup receipt is invalid')
        return [...new Set(errors)]
    }
    const plan = proposed?.stageWorkPlan
    const slice = proposed?.executableSlice
    const compiledPrompt = proposed?.compiledPrompt
    if (validateSealedStageWorkPlan(plan, sealedAuthority).length ||
        validateSealedExecutableSlice({
            plan,
            slice,
            authority: sealedAuthority
        }).length ||
        validateSealedCompiledDispatchPrompt({
            plan,
            slice,
            compiled: compiledPrompt,
            authority: sealedAuthority
        }).length) {
        reject('sealed retry proposed writer artifacts are invalid')
        return [...new Set(errors)]
    }
    const previousPlan = sourceFailureEvent.payload?.stageWorkPlan
    const previousSlice = sourceFailureEvent.payload?.currentSlice
    const previousPrompt = sourceFailureEvent.payload?.compiledPrompt
    if (!sealedArtifact(
        previousPlan,
        'issue-orchestration.stage-work-plan.v1',
        'planDigest'
    ) ||
        !sealedArtifact(
            previousSlice,
            'issue-orchestration.executable-slice.v1',
            'sliceDigest'
        ) ||
        !sealedArtifact(
            previousPrompt,
            'issue-orchestration.compiled-dispatch-prompt.v1',
            'promptDigest'
        ) ||
        !stablePlanContractMatches(previousPlan, plan) ||
        !sameValue(
            proposed.completedSlicePrefix ?? [],
            completedSlicePrefix
        )) {
        reject('sealed retry contract or ledger prefix is invalid')
    }
    const revision = authorization?.revisionEvidence
    const authorityDefinition =
        RETRY_AUTHORITY[revision?.revisionKind]
    if (revision?.schema !== RETRY_REVISION_SCHEMA ||
        revision.verificationStatus !== 'verified' ||
        !authorityDefinition ||
        revision.receiptDigest !==
            unsignedDigest(revision, 'receiptDigest') ||
        !revisions.some((item) => sameValue(item, revision)) ||
        revision.priorFailureReceiptDigest !==
            priorFailure.receiptDigest ||
        revision.semanticFailureDigest !==
            semanticDigestForFailure(priorFailure) ||
        revision.sourceFailureEventId !==
            sourceFailureEvent.eventId ||
        revision.sourceFailureEventDigest !==
            sourceFailureEvent.eventDigest ||
        revision.currentPlanDigest !== plan.planDigest ||
        revision.currentSliceId !== slice.sliceId ||
        revision.currentSliceDigest !== slice.sliceDigest ||
        revision.currentCompiledPromptDigest !==
            compiledPrompt.promptDigest ||
        revision.contractReceiptDigest !==
            plan.frozenStageContractReceiptDigest ||
        revision.resourceLeaseReceiptDigest !==
            plan.resourceLeaseReceiptDigest ||
        revision.authorityActorId !==
            authorityDefinition.actorId ||
        revision.authorityActorRole !==
            authorityDefinition.actorRole ||
        revision.authoritySourceKind !==
            authorityDefinition.sourceKind ||
        revision.replayEvidence?.observationDigest !==
            digest(Object.fromEntries(
                Object.entries(
                    revision.replayEvidence ?? {}
                ).filter(([field]) =>
                    field !== 'observationDigest')
            ))) {
        reject('sealed retry revision authority is invalid')
    } else {
        let previousMaterial
        let currentMaterial
        let expectedPreviousDigest
        let expectedCurrentDigest
        if (revision.revisionKind === 'slice-revision') {
            previousMaterial = sliceMaterial(previousSlice)
            currentMaterial = sliceMaterial(slice)
            expectedPreviousDigest = previousSlice.sliceDigest
            expectedCurrentDigest = slice.sliceDigest
        } else if (revision.revisionKind ===
            'compiled-prompt-revision') {
            previousMaterial = promptMaterial({
                prompt: previousPrompt,
                slice: previousSlice
            })
            currentMaterial = promptMaterial({
                prompt: compiledPrompt,
                slice
            })
            expectedPreviousDigest = previousPrompt.promptDigest
            expectedCurrentDigest = compiledPrompt.promptDigest
        } else {
            const receipt = proposed.authorityReceipt
            if (!validRuntimeAuthorityReceipt(receipt, proposed)) {
                reject(
                    'sealed runtime retry authority receipt is invalid'
                )
            }
            previousMaterial = sourceFailureEvent.payload
                ?.writerStageObservation
                ?.runtimeCapabilityObservation ?? null
            currentMaterial = {
                runtimeMetadataDigest:
                    receipt?.runtimeMetadataDigest,
                actualModel: receipt?.actualModel,
                actualEffort: receipt?.actualEffort,
                actualRole: receipt?.actualRole,
                actualMode: receipt?.actualMode,
                actualSandbox: receipt?.actualSandbox,
                actualForkTurns: receipt?.actualForkTurns,
                actualWorkingDirectory:
                    receipt?.actualWorkingDirectory
            }
            expectedPreviousDigest = digest(previousMaterial)
            expectedCurrentDigest =
                receipt?.runtimeMetadataDigest
        }
        if (revision.previousDigest !== expectedPreviousDigest ||
            revision.currentDigest !== expectedCurrentDigest ||
            revision.previousMaterialDigest !==
                digest(previousMaterial) ||
            revision.currentMaterialDigest !==
                digest(currentMaterial) ||
            revision.previousMaterialDigest ===
                revision.currentMaterialDigest) {
            reject('sealed retry material revision is invalid')
        }
    }
    const carry = authorization?.carryForwardPrefix
    if (carry?.schema !==
            'issue-orchestration.writer-stage-completed-prefix-carry-forward.v1' ||
        carry.verificationStatus !== 'verified' ||
        carry.receiptDigest !==
            unsignedDigest(carry, 'receiptDigest') ||
        carry.previousPrefixDigest !==
            digest(completedSlicePrefix) ||
        carry.currentPlanDigest !== plan.planDigest ||
        carry.currentStageAttemptId !== plan.stageAttemptId ||
        carry.revisionEvidenceDigest !== revision?.receiptDigest ||
        carry.entries?.length !== completedSlicePrefix.length) {
        reject('sealed retry carry-forward prefix is invalid')
    } else {
        for (const [index, entry] of
            completedSlicePrefix.entries()) {
            const mapping = carry.entries[index]
            let currentSlice
            try {
                currentSlice = compileSealedExecutableSlice({
                    plan,
                    sliceId: entry.sliceId,
                    authority: sealedAuthority
                })
            } catch {
                reject(
                    'sealed retry carry-forward current slice is invalid'
                )
                continue
            }
            if (!validCompletedPrefixEntry(entry) ||
                mapping?.order !== index + 1 ||
                mapping.sliceId !== entry.sliceId ||
                mapping.previousPlanDigest !== entry.planDigest ||
                mapping.previousStageAttemptId !==
                    entry.stageAttemptId ||
                mapping.previousSliceDigest !== entry.sliceDigest ||
                mapping.previousSliceMaterialDigest !==
                    entry.sliceMaterialDigest ||
                mapping.previousCheckpointDigest !==
                    entry.checkpointDigest ||
                mapping.previousCheckpointVerificationReceiptDigest !==
                    entry.checkpointVerificationReceiptDigest ||
                mapping.previousTracePrefixDigest !==
                    entry.tracePrefixDigest ||
                mapping.previousTerminalReceiptDigest !==
                    entry.terminalReceiptDigest ||
                mapping.previousTerminalChainDigest !==
                    entry.terminalChainDigest ||
                mapping.previousSliceOrdinal !==
                    entry.sliceOrdinal ||
                mapping.previousPlanSliceCount !==
                    entry.planSliceCount ||
                !sameValue(
                    mapping.previousPriorTerminalReceiptDigests,
                    entry.priorTerminalReceiptDigests
                ) ||
                mapping.previousCompletedSlicePrefixDigest !==
                    entry.completedSlicePrefixDigest ||
                mapping.previousAcceptedPriorChangedPathsDigest !==
                    entry.acceptedPriorChangedPathsDigest ||
                !sameValue(mapping.changedPaths, entry.changedPaths) ||
                mapping.currentPlanDigest !== plan.planDigest ||
                mapping.currentStageAttemptId !==
                    plan.stageAttemptId ||
                mapping.currentSliceDigest !==
                    currentSlice.sliceDigest ||
                mapping.unchangedSliceMaterialDigest !==
                    entry.sliceMaterialDigest ||
                writerStageSliceMaterialDigest(currentSlice) !==
                    entry.sliceMaterialDigest) {
                reject(
                    'sealed retry carry-forward entry is invalid'
                )
            }
        }
    }
    if (authorization?.schema !==
            'issue-orchestration.writer-stage-retry-authorization.v1' ||
        authorization.verificationStatus !== 'verified' ||
        authorization.receiptDigest !==
            unsignedDigest(authorization, 'receiptDigest') ||
        authorization.priorFailureReceiptDigest !==
            priorFailure.receiptDigest ||
        authorization.semanticFailureDigest !==
            semanticDigestForFailure(priorFailure) ||
        authorization.nextPlanDigest !== plan.planDigest ||
        authorization.nextSliceId !== slice.sliceId ||
        authorization.nextSliceDigest !== slice.sliceDigest ||
        authorization.nextCompiledPromptDigest !==
            compiledPrompt.promptDigest ||
        authorization.revisionEvidenceDigest !==
            revision?.receiptDigest ||
        authorization.resourceCleanupReceiptDigest !==
            resourceCleanupReceipt.receiptDigest ||
        authorization.carryForwardPrefixDigest !==
            carry?.receiptDigest ||
        authorization.authorized !== true ||
        authorization.breakerOpen !== false) {
        reject('sealed retry authorization envelope is invalid')
    }
    return [...new Set(errors)]
}
