import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
    replayEventLedgerSync,
    transitionTable
} from './event-ledger.mjs'
import {
    validateLifecycleAuthorityBinding
} from './lifecycle-genesis-authority.mjs'

const GENESIS = '0'.repeat(64)
const SHA256 = /^[a-f0-9]{64}$/u
const GIT_SHA = /^[a-f0-9]{40}$/u
const CACHE_RESULT_CONTROL_LEDGER = Symbol(
    'verified-replay-cache-control-ledger'
)
const CACHE_RESULT_OBSERVATION = Symbol(
    'verified-replay-cache-observation'
)
const VERIFIED_REPLAY_CACHE = new Map()
const VERIFIED_REPLAY_AUTHORITY_INDEX = new Map()
const VERIFIED_REPLAY_RUN_KEYS = new Map()
const VERIFIED_REPLAY_STATS = new Map()

export const CONTROL_EVENT_TYPES = Object.freeze([
    'scope.refreshed',
    'runtime-authority.rebound',
    'remote-snapshot.refreshed',
    'node.registered',
    'node.rebound',
    'node.reopened',
    'node.removed',
    'node.tombstoned',
    'repository.base-changed',
    'dependency.updated',
    'acceptance-group.updated',
    'slots.updated',
    'dispatch-batch.recorded',
    'dispatch.action-started',
    'dispatch.action-settled',
    'delivery.freeze-acquired',
    'delivery.freeze-released',
    'delivery.effect-recorded',
    'delivery.effect-completed',
    'cleanup.finalized',
    'closure.authorization-recorded',
    'closure.effect-recorded',
    'closure.effect-completed',
    'run.terminalized'
])
const CONTROL_EVENT_TYPE_SET = new Set(CONTROL_EVENT_TYPES)

function fail(code, message = code, details = {}) {
    const error = new Error(message)
    error.code = code
    Object.assign(error, details)
    throw error
}

function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, normalize(value[key])])
    )
}

export function stateDigest(value) {
    return createHash('sha256')
        .update(typeof value === 'string'
            ? value
            : JSON.stringify(normalize(value)))
        .digest('hex')
}

function unsignedDigest(value, digestField) {
    const unsigned = structuredClone(value)
    delete unsigned[digestField]
    return stateDigest(unsigned)
}

function requireObject(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
    return value
}

function requireString(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
}

function requireDigest(value, code) {
    if (!SHA256.test(value ?? '')) fail(code)
}

function requireGitSha(value, code) {
    if (!GIT_SHA.test(value ?? '')) fail(code)
}

function sortedUnique(values, code) {
    if (!Array.isArray(values)) fail(code)
    if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
        fail(code)
    }
    return [...new Set(values)].sort()
}

function atomicWrite(filePath, source) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temporary = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, source, { mode: 0o600 })
    const descriptor = fs.openSync(temporary, 'r')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    fs.renameSync(temporary, filePath)
}

function writeLedger(filePath, ledger) {
    const lines = [ledger.header, ...ledger.events]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    atomicWrite(filePath, `${lines}\n`)
}

function readLedger(filePath) {
    const source = fs.readFileSync(filePath, 'utf8')
    const lines = source.split('\n').filter(Boolean)
    if (lines.length === 0) fail('ledger-empty')
    const entries = lines.map((line, index) => {
        try {
            return JSON.parse(line)
        } catch {
            fail('ledger-tail-corrupt', 'ledger tail is corrupt', {
                filePath,
                line: index + 1
            })
        }
    })
    return { header: entries[0], events: entries.slice(1) }
}


function fileContentDigest(filePath) {
    return createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex')
}

function readBoundaryLine(filePath, fromEnd = false) {
    const descriptor = fs.openSync(filePath, 'r')
    try {
        const { size } = fs.fstatSync(descriptor)
        if (size === 0) fail('ledger-empty')
        const chunkSize = 4_096
        let position = fromEnd ? size : 0
        let text = ''
        let bytesRead = 0
        while (fromEnd ? position > 0 : position < size) {
            const length = Math.min(chunkSize, fromEnd ? position : size - position)
            const start = fromEnd ? position - length : position
            const buffer = Buffer.allocUnsafe(length)
            const count = fs.readSync(descriptor, buffer, 0, length, start)
            bytesRead += count
            const piece = buffer.subarray(0, count).toString('utf8')
            text = fromEnd ? `${piece}${text}` : `${text}${piece}`
            if (fromEnd) {
                position = start
                const trimmed = text.replace(/\n+$/u, '')
                const boundary = trimmed.lastIndexOf('\n')
                if (boundary >= 0 || position === 0) {
                    return {
                        line: trimmed.slice(boundary + 1),
                        bytesRead
                    }
                }
            } else {
                position += count
                const boundary = text.indexOf('\n')
                if (boundary >= 0 || position === size) {
                    return {
                        line: boundary >= 0 ? text.slice(0, boundary) : text,
                        bytesRead
                    }
                }
            }
        }
        fail('ledger-empty')
    } finally {
        fs.closeSync(descriptor)
    }
}

function readLedgerIdentity(filePath) {
    const first = readBoundaryLine(filePath, false)
    const last = readBoundaryLine(filePath, true)
    let header
    let tail
    try {
        header = JSON.parse(first.line)
        tail = JSON.parse(last.line)
    } catch {
        fail('ledger-tail-corrupt', 'ledger boundary is corrupt', { filePath })
    }
    const sameLine = first.line === last.line
    const headDigest = sameLine
        ? GENESIS
        : tail.eventDigest
    requireDigest(header.headerDigest, 'ledger-header-digest-invalid')
    if (unsignedDigest(header, 'headerDigest') !== header.headerDigest) {
        fail('ledger-header-digest-invalid')
    }
    if (!sameLine) {
        requireDigest(headDigest, 'ledger-head-digest-invalid')
        if (unsignedDigest(tail, 'eventDigest') !== headDigest) {
            fail('ledger-head-digest-invalid')
        }
    }
    return Object.freeze({
        headerDigest: header.headerDigest,
        headDigest,
        runId: header.runId,
        nodeId: header.nodeId ?? null,
        nodeEpoch: header.nodeEpoch ?? null,
        bytesRead: first.bytesRead + last.bytesRead
    })
}

function cacheRunIdentity({ stateRoot, runId }) {
    return `${path.resolve(stateRoot)}\u0000${runId}`
}

function cacheAuthorityIdentity({ stateRoot, runId, cacheAuthorityDigest }) {
    return stateDigest({
        schema: 'issue-orchestration.verified-replay-cache-authority.v1',
        stateRoot: path.resolve(stateRoot),
        runId,
        cacheAuthorityDigest
    })
}

function statsForRun({ stateRoot, runId }) {
    const key = cacheRunIdentity({ stateRoot, runId })
    if (!VERIFIED_REPLAY_STATS.has(key)) {
        VERIFIED_REPLAY_STATS.set(key, {
            fullReplays: 0,
            cacheHits: 0,
            controlLedgerReplays: 0,
            nodeLedgerReplays: 0,
            aggregateProjectionRebuilds: 0,
            ledgerIdentityReads: 0,
            canonicalLedgerBytesRead: 0
        })
    }
    return VERIFIED_REPLAY_STATS.get(key)
}

function noteLedgerIdentity(stats, identity) {
    stats.ledgerIdentityReads += 1
    stats.canonicalLedgerBytesRead += identity.bytesRead
}

function noteFullLedgerRead(stats, filePath) {
    stats.canonicalLedgerBytesRead += fs.statSync(filePath).size
}

function registerCacheKey(runIdentity, key) {
    const keys = VERIFIED_REPLAY_RUN_KEYS.get(runIdentity) ?? new Set()
    keys.add(key)
    VERIFIED_REPLAY_RUN_KEYS.set(runIdentity, keys)
}

function cloneCacheResult(result, controlLedger, observation) {
    const clone = structuredClone(result)
    Object.defineProperty(clone, CACHE_RESULT_CONTROL_LEDGER, {
        value: structuredClone(controlLedger),
        enumerable: false
    })
    Object.defineProperty(clone, CACHE_RESULT_OBSERVATION, {
        value: Object.freeze(structuredClone(observation)),
        enumerable: false
    })
    return clone
}

export function verifiedReplayProjectionCacheObservation(value) {
    return Object.freeze(structuredClone(
        value?.[CACHE_RESULT_OBSERVATION] ?? {
            status: 'unobserved',
            controlLedgerReplays: 0,
            nodeLedgerReplays: 0,
            aggregateProjectionRebuilds: 0,
            canonicalLedgerBytesRead: 0
        }
    ))
}

export function canonicalControlLedgerFromRecovered(value) {
    const ledger = value?.[CACHE_RESULT_CONTROL_LEDGER]
    if (!ledger) fail('verified-replay-control-ledger-unavailable')
    return structuredClone(ledger)
}

export function verifiedReplayProjectionCacheStats({ stateRoot, runId } = {}) {
    return Object.freeze(structuredClone(statsForRun({ stateRoot, runId })))
}

export function clearVerifiedReplayProjectionCache({ stateRoot, runId } = {}) {
    if (stateRoot === undefined && runId === undefined) {
        VERIFIED_REPLAY_CACHE.clear()
        VERIFIED_REPLAY_AUTHORITY_INDEX.clear()
        VERIFIED_REPLAY_RUN_KEYS.clear()
        VERIFIED_REPLAY_STATS.clear()
        return
    }
    const runIdentity = cacheRunIdentity({ stateRoot, runId })
    for (const key of VERIFIED_REPLAY_RUN_KEYS.get(runIdentity) ?? []) {
        const entry = VERIFIED_REPLAY_CACHE.get(key)
        if (entry?.authorityLookupKey) {
            VERIFIED_REPLAY_AUTHORITY_INDEX.delete(
                entry.authorityLookupKey
            )
        }
        VERIFIED_REPLAY_CACHE.delete(key)
    }
    VERIFIED_REPLAY_RUN_KEYS.delete(runIdentity)
    VERIFIED_REPLAY_STATS.delete(runIdentity)
}

export function canonicalRunStateLocation({ stateRoot, runId } = {}) {
    requireString(stateRoot, 'state-root-required')
    requireString(runId, 'run-id-required')
    const canonicalStateRoot = path.resolve(stateRoot)
    const runKey = stateDigest({ runId })
    const runRoot = path.join(canonicalStateRoot, 'runs', runKey)
    return Object.freeze({
        stateRoot: canonicalStateRoot,
        runId,
        runKey,
        runRoot,
        controlLedgerPath: path.join(runRoot, 'control-ledger.jsonl'),
        controlProjectionPath: path.join(runRoot, 'control-projection.json'),
        nodeIndexPath: path.join(runRoot, 'node-index.json'),
        aggregateProjectionPath: path.join(runRoot, 'aggregate-runtime-projection.json'),
        nodesRoot: path.join(runRoot, 'nodes')
    })
}

export function canonicalNodeStateLocation({
    stateRoot,
    runId,
    nodeId,
    nodeEpoch = 1
} = {}) {
    requireString(nodeId, 'node-id-required')
    if (!Number.isInteger(nodeEpoch) || nodeEpoch < 1) {
        fail('node-epoch-required')
    }
    const run = canonicalRunStateLocation({ stateRoot, runId })
    const nodeKey = stateDigest({ runId, nodeId, nodeEpoch })
    const nodeRoot = path.join(run.nodesRoot, nodeKey)
    return Object.freeze({
        ...run,
        nodeId,
        nodeEpoch,
        nodeKey,
        nodeRoot,
        ledgerPath: path.join(nodeRoot, 'event-ledger.jsonl'),
        projectionPath: path.join(nodeRoot, 'projection.json'),
        writerAttemptsRoot: path.join(nodeRoot, 'writer-attempts')
    })
}

export function readCanonicalControlLedger({ stateRoot, runId } = {}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    return readLedger(location.controlLedgerPath)
}

export function readCanonicalNodeLedger({
    stateRoot,
    runId,
    nodeId,
    nodeEpoch = 1
} = {}) {
    const location = canonicalNodeStateLocation({
        stateRoot,
        runId,
        nodeId,
        nodeEpoch
    })
    return readLedger(location.ledgerPath)
}

export function sealControlLedgerHeader({
    runId,
    createdAt,
    lifecycleAuthorityBinding = null
} = {}) {
    requireString(runId, 'control-ledger-run-id-invalid')
    requireString(createdAt, 'control-ledger-created-at-invalid')
    if (lifecycleAuthorityBinding !== null) {
        validateLifecycleAuthorityBinding(lifecycleAuthorityBinding)
        if (lifecycleAuthorityBinding.runId !== runId) {
            fail('control-ledger-authority-run-id-invalid')
        }
    }
    const header = {
        schema: 'issue-orchestration.control-ledger.v1',
        runId,
        createdAt,
        lifecycleAuthorityBinding:
            lifecycleAuthorityBinding === null
                ? null
                : normalize(lifecycleAuthorityBinding)
    }
    return Object.freeze({
        ...header,
        headerDigest: stateDigest(header)
    })
}

export function createControlLedger(input) {
    return {
        header: sealControlLedgerHeader(input),
        events: []
    }
}

function validateControlHeader(header) {
    requireObject(header, 'control-ledger-header-invalid')
    if (header.schema !== 'issue-orchestration.control-ledger.v1') {
        fail('control-ledger-schema-invalid')
    }
    requireString(header.runId, 'control-ledger-run-id-invalid')
    requireString(header.createdAt, 'control-ledger-created-at-invalid')
    if (header.lifecycleAuthorityBinding !== null &&
        header.lifecycleAuthorityBinding !== undefined) {
        validateLifecycleAuthorityBinding(
            header.lifecycleAuthorityBinding
        )
        if (header.lifecycleAuthorityBinding.runId !== header.runId) {
            fail('control-ledger-authority-run-id-invalid')
        }
    }
    requireDigest(header.headerDigest, 'control-ledger-header-digest-invalid')
    if (unsignedDigest(header, 'headerDigest') !== header.headerDigest) {
        fail('control-ledger-header-digest-mismatch')
    }
    return header
}

function assertControlEventType(eventType) {
    if (CONTROL_EVENT_TYPE_SET.has(eventType)) return
    if (Object.hasOwn(transitionTable, eventType)
        || eventType.startsWith('writer-stage.')
        || eventType.startsWith('implementation.')
        || eventType.startsWith('independent-verification.')
        || eventType.startsWith('documentation.')) {
        fail('control-ledger-node-local-event')
    }
    fail('control-event-type-unsupported')
}

export function compileControlEvent({
    ledger,
    eventType,
    payload = {},
    actorRole = 'root-scheduler',
    createdAt,
    lifecycleAuthorityBinding = null
} = {}) {
    validateControlHeader(ledger?.header)
    if (!Array.isArray(ledger.events)) fail('control-ledger-events-invalid')
    assertControlEventType(eventType)
    if (actorRole !== 'root-scheduler') fail('control-ledger-writer-role')
    requireString(createdAt, 'control-event-created-at-invalid')
    requireObject(payload, 'control-event-payload-invalid')
    const authorityBinding = lifecycleAuthorityBinding ??
        ledger.header.lifecycleAuthorityBinding ?? null
    if (authorityBinding !== null) {
        validateLifecycleAuthorityBinding(authorityBinding)
        if (authorityBinding.runId !== ledger.header.runId) {
            fail('control-event-authority-run-id-invalid')
        }
    }
    const event = {
        schema: 'issue-orchestration.control-event.v1',
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        eventType,
        actorRole,
        lifecycleAuthorityBinding:
            authorityBinding === null
                ? null
                : normalize(authorityBinding),
        payload: normalize(payload),
        payloadDigest: stateDigest(payload),
        createdAt,
        previousEventDigest:
            ledger.events.at(-1)?.eventDigest ?? GENESIS
    }
    return Object.freeze({
        ...event,
        eventDigest: stateDigest(event)
    })
}

function registrationFromPayload(payload) {
    requireString(payload.nodeId, 'control-node-id-invalid')
    requireString(payload.memberId, 'control-member-id-invalid')
    if (payload.memberId !== payload.nodeId) {
        fail('control-node-member-identity-mismatch')
    }
    requireString(payload.repository, 'control-node-repository-invalid')
    if (!Number.isInteger(payload.issueNumber) || payload.issueNumber <= 0) {
        fail('control-node-issue-number-invalid')
    }
    requireDigest(
        payload.selectorReceiptDigest,
        'control-node-selector-binding-invalid'
    )
    requireDigest(
        payload.remoteMemberDigest,
        'control-node-remote-binding-invalid'
    )
    if (!Number.isInteger(payload.nodeEpoch) || payload.nodeEpoch < 1) {
        fail('control-node-epoch-invalid')
    }
    requireGitSha(payload.baseSha, 'control-node-base-sha-invalid')
    const repositoryBindingDigest = payload.repositoryBindingDigest ??
        stateDigest({
            repository: payload.repository,
            baseSha: payload.baseSha
        })
    requireDigest(
        repositoryBindingDigest,
        'control-node-repository-binding-invalid'
    )
    const issueSnapshotFingerprint =
        payload.issueSnapshotFingerprint ?? null
    const repositoryFingerprint =
        payload.repositoryFingerprint ?? null
    const lifecycleAuthorityBinding =
        payload.lifecycleAuthorityBinding ?? null
    if (lifecycleAuthorityBinding !== null) {
        validateLifecycleAuthorityBinding(lifecycleAuthorityBinding)
    }
    if (issueSnapshotFingerprint !== null) {
        requireDigest(
            issueSnapshotFingerprint,
            'control-node-issue-fingerprint-invalid'
        )
    }
    if (repositoryFingerprint !== null) {
        requireDigest(
            repositoryFingerprint,
            'control-node-repository-fingerprint-invalid'
        )
    }
    return {
        nodeId: payload.nodeId,
        memberId: payload.memberId,
        repository: payload.repository,
        issueNumber: payload.issueNumber,
        selectorReceiptDigest: payload.selectorReceiptDigest,
        remoteMemberDigest: payload.remoteMemberDigest,
        nodeEpoch: payload.nodeEpoch,
        baseSha: payload.baseSha,
        repositoryBindingDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        lifecycleAuthorityBinding,
        dependencyKeys: sortedUnique(
            payload.dependencyKeys ?? [],
            'control-node-dependencies-invalid'
        ),
        acceptanceGroup: payload.acceptanceGroup ?? null,
        graphNode: payload.graphNode ?? null,
        status: 'active'
    }
}

function ensureNode(projection, nodeId) {
    const node = projection.nodes[nodeId]
    if (!node || node.status !== 'active') fail('control-node-not-active')
    return node
}

export function replayControlLedger(ledger) {
    const header = validateControlHeader(ledger?.header)
    if (!Array.isArray(ledger.events)) fail('control-ledger-events-invalid')
    const projection = {
        schema: 'issue-orchestration.run-control-projection.v1',
        runId: header.runId,
        lifecycleAuthorityBinding:
            header.lifecycleAuthorityBinding ?? null,
        selectorReceiptDigest: null,
        remoteSnapshotDigest: null,
        nodes: {},
        dependencies: {},
        acceptanceGroups: {},
        slots: { capacity: 0, active: [] },
        dispatchBatches: [],
        activeDispatches: {},
        dispatchHistory: [],
        repositoryBases: {},
        deliveryFreezes: {},
        pendingDeliveryEffects: {},
        deliveryEffects: {},
        cleanupFinalizations: {},
        pendingClosureAuthorizations: {},
        pendingClosureEffects: {},
        closureEffects: {},
        terminal: null,
        lastSequence: 0,
        lastEventDigest: GENESIS
    }
    let expectedDigest = GENESIS
    for (const [index, event] of ledger.events.entries()) {
        requireObject(event, 'control-event-invalid')
        if (event.schema !== 'issue-orchestration.control-event.v1') {
            fail('control-event-schema-invalid')
        }
        assertControlEventType(event.eventType)
        if (event.sequence !== index + 1) fail('control-ledger-sequence')
        if (event.runId !== header.runId) fail('control-event-run-id')
        if (event.actorRole !== 'root-scheduler') {
            fail('control-ledger-writer-role')
        }
        if (event.previousEventDigest !== expectedDigest) {
            fail('control-ledger-hash-chain')
        }
        requireObject(event.payload, 'control-event-payload-invalid')
        if (event.payloadDigest !== stateDigest(event.payload)) {
            fail('control-event-payload-digest')
        }
        if (unsignedDigest(event, 'eventDigest') !== event.eventDigest) {
            fail('control-event-digest')
        }
        const eventAuthority = event.eventType ===
            'runtime-authority.rebound'
            ? event.payload?.lifecycleAuthority?.binding
            : projection.lifecycleAuthorityBinding
        if (eventAuthority !== null && eventAuthority !== undefined) {
            validateLifecycleAuthorityBinding(eventAuthority)
            if (!event.lifecycleAuthorityBinding ||
                event.lifecycleAuthorityBinding.bindingDigest !==
                    eventAuthority.bindingDigest ||
                event.lifecycleAuthorityBinding.runId !== header.runId) {
                fail('control-event-authority-binding-invalid')
            }
        }
        switch (event.eventType) {
            case 'runtime-authority.rebound': {
                const priorBinding = projection.lifecycleAuthorityBinding
                const nextAuthority = event.payload?.lifecycleAuthority
                const nextBinding = nextAuthority?.binding
                if (!priorBinding ||
                    event.payload?.priorLifecycleAuthorityBindingDigest !==
                        priorBinding.bindingDigest ||
                    nextAuthority?.schema !==
                        'issue-orchestration.lifecycle-run-authority.v1' ||
                    nextAuthority.status !== 'verified' ||
                    nextAuthority.authorityKind !== 'takeover' ||
                    nextAuthority.runId !== header.runId ||
                    nextAuthority.authorityDigest !==
                        unsignedDigest(
                            nextAuthority,
                            'authorityDigest'
                        )) {
                    fail('control-authority-rebound-invalid')
                }
                validateLifecycleAuthorityBinding(nextBinding)
                if (nextBinding.authorityKind !== 'takeover' ||
                    nextBinding.rootPhase !== 'recovery-takeover' ||
                    nextBinding.runtimeInvocationId ===
                        priorBinding.runtimeInvocationId ||
                    nextBinding.rootAuthorityEpoch ===
                        priorBinding.rootAuthorityEpoch ||
                    !SHA256.test(
                        nextBinding.recoveryAuthorizationDigest ?? ''
                    ) ||
                    !SHA256.test(nextBinding.takeoverHandoffDigest ?? '') ||
                    !SHA256.test(
                        nextBinding.oldRootFencingReceiptDigest ?? ''
                    )) {
                    fail('control-authority-rebound-invalid')
                }
                projection.lifecycleAuthorityBinding = nextBinding
                break
            }
            case 'scope.refreshed':
                requireDigest(
                    event.payload.selectorReceiptDigest,
                    'control-scope-selector-invalid'
                )
                projection.selectorReceiptDigest =
                    event.payload.selectorReceiptDigest
                break
            case 'remote-snapshot.refreshed':
                requireDigest(
                    event.payload.remoteSnapshotDigest,
                    'control-remote-snapshot-invalid'
                )
                projection.remoteSnapshotDigest =
                    event.payload.remoteSnapshotDigest
                break
            case 'node.registered': {
                const registration = registrationFromPayload(event.payload)
                if (projection.lifecycleAuthorityBinding &&
                    (!registration.lifecycleAuthorityBinding ||
                    registration.lifecycleAuthorityBinding.bindingDigest !==
                        projection.lifecycleAuthorityBinding.bindingDigest)) {
                    fail('control-node-authority-binding-invalid')
                }
                if (projection.nodes[registration.nodeId]) {
                    fail('control-node-duplicate')
                }
                projection.nodes[registration.nodeId] = registration
                projection.repositoryBases[registration.repository] ??= {
                    repository: registration.repository,
                    baseSha: registration.baseSha,
                    repositoryBindingDigest:
                        registration.repositoryBindingDigest
                }
                projection.dependencies[registration.nodeId] =
                    registration.dependencyKeys
                if (registration.acceptanceGroup) {
                    const members = projection.acceptanceGroups[
                        registration.acceptanceGroup
                    ] ?? []
                    projection.acceptanceGroups[
                        registration.acceptanceGroup
                    ] = [...new Set([
                        ...members,
                        registration.nodeId
                    ])].sort()
                }
                break
            }
            case 'node.rebound': {
                const prior = ensureNode(
                    projection,
                    event.payload.nodeId
                )
                const registration = registrationFromPayload(
                    event.payload
                )
                if (projection.lifecycleAuthorityBinding &&
                    (!registration.lifecycleAuthorityBinding ||
                    registration.lifecycleAuthorityBinding.bindingDigest !==
                        projection.lifecycleAuthorityBinding.bindingDigest)) {
                    fail('control-node-authority-binding-invalid')
                }
                if (registration.nodeEpoch !== prior.nodeEpoch + 1) {
                    fail('control-node-epoch-not-monotonic')
                }
                if (registration.repository !== prior.repository ||
                    registration.issueNumber !== prior.issueNumber ||
                    registration.memberId !== prior.memberId) {
                    fail('control-node-rebind-identity-drift')
                }
                projection.nodes[registration.nodeId] = registration
                projection.dependencies[registration.nodeId] =
                    registration.dependencyKeys
                for (const [groupId, members] of Object.entries(
                    projection.acceptanceGroups
                )) {
                    if (groupId === registration.acceptanceGroup) continue
                    projection.acceptanceGroups[groupId] = members.filter(
                        (memberId) => memberId !== registration.nodeId
                    )
                }
                if (registration.acceptanceGroup) {
                    const members = projection.acceptanceGroups[
                        registration.acceptanceGroup
                    ] ?? []
                    projection.acceptanceGroups[
                        registration.acceptanceGroup
                    ] = [...new Set([
                        ...members,
                        registration.nodeId
                    ])].sort()
                }
                projection.repositoryBases[registration.repository] = {
                    repository: registration.repository,
                    baseSha: registration.baseSha,
                    repositoryBindingDigest:
                        registration.repositoryBindingDigest
                }
                break
            }
            case 'node.reopened': {
                const prior = projection.nodes[event.payload.nodeId]
                if (!prior || prior.status === 'active') {
                    fail('control-node-reopen-state-invalid')
                }
                const registration = registrationFromPayload(
                    event.payload
                )
                if (projection.lifecycleAuthorityBinding &&
                    (!registration.lifecycleAuthorityBinding ||
                    registration.lifecycleAuthorityBinding.bindingDigest !==
                        projection.lifecycleAuthorityBinding.bindingDigest)) {
                    fail('control-node-authority-binding-invalid')
                }
                if (registration.nodeEpoch !== prior.nodeEpoch + 1) {
                    fail('control-node-epoch-not-monotonic')
                }
                if (registration.repository !== prior.repository ||
                    registration.issueNumber !== prior.issueNumber ||
                    registration.memberId !== prior.memberId) {
                    fail('control-node-reopen-identity-drift')
                }
                projection.nodes[registration.nodeId] = registration
                projection.dependencies[registration.nodeId] =
                    registration.dependencyKeys
                for (const [groupId, members] of Object.entries(
                    projection.acceptanceGroups
                )) {
                    if (groupId === registration.acceptanceGroup) continue
                    projection.acceptanceGroups[groupId] = members.filter(
                        (memberId) => memberId !== registration.nodeId
                    )
                }
                if (registration.acceptanceGroup) {
                    const members = projection.acceptanceGroups[
                        registration.acceptanceGroup
                    ] ?? []
                    projection.acceptanceGroups[
                        registration.acceptanceGroup
                    ] = [...new Set([
                        ...members,
                        registration.nodeId
                    ])].sort()
                }
                projection.repositoryBases[registration.repository] = {
                    repository: registration.repository,
                    baseSha: registration.baseSha,
                    repositoryBindingDigest:
                        registration.repositoryBindingDigest
                }
                break
            }
            case 'node.removed':
            case 'node.tombstoned': {
                const node = ensureNode(projection, event.payload.nodeId)
                node.status = event.eventType === 'node.removed'
                    ? 'removed'
                    : 'tombstoned'
                node.removalReason = event.payload.reason ?? null
                break
            }
            case 'repository.base-changed': {
                requireString(
                    event.payload.repository,
                    'control-repository-base-repository-invalid'
                )
                requireGitSha(
                    event.payload.baseSha,
                    'control-repository-base-sha-invalid'
                )
                requireDigest(
                    event.payload.repositoryBindingDigest,
                    'control-repository-binding-invalid'
                )
                projection.repositoryBases[event.payload.repository] = {
                    repository: event.payload.repository,
                    baseSha: event.payload.baseSha,
                    repositoryBindingDigest:
                        event.payload.repositoryBindingDigest
                }
                break
            }
            case 'dependency.updated': {
                const node = ensureNode(projection, event.payload.nodeId)
                const dependencies = sortedUnique(
                    event.payload.dependencyKeys,
                    'control-node-dependencies-invalid'
                )
                node.dependencyKeys = dependencies
                projection.dependencies[node.nodeId] = dependencies
                break
            }
            case 'acceptance-group.updated': {
                requireString(
                    event.payload.groupId,
                    'control-acceptance-group-id-invalid'
                )
                const members = sortedUnique(
                    event.payload.memberIds,
                    'control-acceptance-group-members-invalid'
                )
                for (const memberId of members) ensureNode(projection, memberId)
                projection.acceptanceGroups[event.payload.groupId] = members
                break
            }
            case 'slots.updated': {
                if (!Number.isInteger(event.payload.capacity)
                    || event.payload.capacity < 0) {
                    fail('control-slot-capacity-invalid')
                }
                const active = sortedUnique(
                    event.payload.activeNodeIds ?? [],
                    'control-slot-active-invalid'
                )
                if (active.length > event.payload.capacity) {
                    fail('control-slot-capacity-exceeded')
                }
                for (const nodeId of active) ensureNode(projection, nodeId)
                const dispatchNodes = Object.values(
                    projection.activeDispatches
                ).map(({ nodeId }) => nodeId).sort()
                if (dispatchNodes.length > 0 &&
                    stateDigest(dispatchNodes) !== stateDigest(active)) {
                    fail('control-slot-active-dispatch-mismatch')
                }
                projection.slots = {
                    capacity: event.payload.capacity,
                    active
                }
                break
            }
            case 'dispatch-batch.recorded':
                requireDigest(
                    event.payload.batchDigest,
                    'control-dispatch-batch-digest-invalid'
                )
                if (unsignedDigest(event.payload, 'batchDigest') !==
                    event.payload.batchDigest) {
                    fail('control-dispatch-batch-digest-invalid')
                }
                projection.dispatchBatches.push(normalize(event.payload))
                break
            case 'dispatch.action-started': {
                const payload = event.payload
                for (const [field, code] of [
                    ['dispatchId', 'control-dispatch-id-invalid'],
                    ['actionType', 'control-dispatch-action-type-invalid'],
                    ['owner', 'control-dispatch-owner-invalid'],
                    ['nodeId', 'control-dispatch-node-invalid'],
                    ['attemptId', 'control-dispatch-attempt-invalid'],
                    ['slotId', 'control-dispatch-slot-invalid']
                ]) requireString(payload[field], code)
                for (const [field, code] of [
                    ['actionDigest', 'control-dispatch-action-digest-invalid'],
                    ['actionSetDigest', 'control-dispatch-action-set-invalid'],
                    ['actionBindingsDigest', 'control-dispatch-bindings-invalid'],
                    ['runtimeBindingDigest', 'control-dispatch-runtime-invalid'],
                    ['leaseDigest', 'control-dispatch-lease-invalid'],
                    ['resourceDigest', 'control-dispatch-resource-invalid']
                ]) requireDigest(payload[field], code)
                const action = requireObject(
                    payload.action,
                    'control-dispatch-action-invalid'
                )
                const actionSet = requireObject(
                    payload.actionSet,
                    'control-dispatch-action-set-invalid'
                )
                if (action.actionDigest !== payload.actionDigest ||
                    action.type !== payload.actionType ||
                    action.nodeId !== payload.nodeId ||
                    actionSet.actionSetDigest !== payload.actionSetDigest ||
                    !Array.isArray(actionSet.actions) ||
                    !actionSet.actions.some((candidate) =>
                        candidate.actionDigest === payload.actionDigest &&
                        stateDigest(candidate) === stateDigest(action)) ||
                    stateDigest(action.bindings) !==
                        payload.actionBindingsDigest) {
                    fail('control-dispatch-authority-invalid')
                }
                requireDigest(
                    payload.receiptDigest,
                    'control-dispatch-receipt-invalid'
                )
                if (unsignedDigest(payload, 'receiptDigest') !==
                    payload.receiptDigest) {
                    fail('control-dispatch-receipt-invalid')
                }
                if (payload.executionClass !== 'actor') {
                    fail('control-dispatch-execution-class-invalid')
                }
                ensureNode(projection, payload.nodeId)
                if (projection.activeDispatches[payload.dispatchId] ||
                    Object.values(projection.activeDispatches).some(
                        (dispatch) =>
                            dispatch.actionDigest === payload.actionDigest ||
                            dispatch.nodeId === payload.nodeId ||
                            dispatch.slotId === payload.slotId
                    )) {
                    fail('control-dispatch-active-duplicate')
                }
                if (projection.slots.active.includes(payload.nodeId)) {
                    fail('control-dispatch-node-slot-duplicate')
                }
                if (projection.slots.active.length >=
                    projection.slots.capacity) {
                    fail('control-slot-capacity-exceeded')
                }
                projection.activeDispatches[payload.dispatchId] =
                    normalize(payload)
                projection.slots.active = [...projection.slots.active,
                    payload.nodeId].sort()
                break
            }
            case 'dispatch.action-settled': {
                const payload = event.payload
                requireString(
                    payload.dispatchId,
                    'control-dispatch-id-invalid'
                )
                requireDigest(
                    payload.actionDigest,
                    'control-dispatch-action-digest-invalid'
                )
                requireDigest(
                    payload.resultDigest,
                    'control-dispatch-result-invalid'
                )
                requireDigest(
                    payload.settlementDigest,
                    'control-dispatch-settlement-invalid'
                )
                if (unsignedDigest(payload, 'settlementDigest') !==
                    payload.settlementDigest) {
                    fail('control-dispatch-settlement-invalid')
                }
                if (!['completed', 'failed', 'excluded'].includes(
                    payload.outcome
                )) {
                    fail('control-dispatch-outcome-invalid')
                }
                if (payload.outcome === 'excluded') {
                    requireString(
                        payload.exclusionCode,
                        'control-dispatch-exclusion-code-invalid'
                    )
                    if (payload.failureFamily !== undefined) {
                        fail('control-dispatch-failure-family-forbidden')
                    }
                } else if (payload.outcome === 'failed') {
                    requireString(
                        payload.failureFamily,
                        'control-dispatch-failure-family-invalid'
                    )
                    if (payload.exclusionCode !== undefined) {
                        fail('control-dispatch-exclusion-code-forbidden')
                    }
                } else if (payload.exclusionCode !== undefined ||
                    payload.failureFamily !== undefined) {
                    fail('control-dispatch-settlement-detail-forbidden')
                }
                const active = projection.activeDispatches[
                    payload.dispatchId
                ]
                if (!active || active.actionDigest !==
                    payload.actionDigest) {
                    fail('control-dispatch-not-active')
                }
                delete projection.activeDispatches[payload.dispatchId]
                projection.slots.active = projection.slots.active.filter(
                    (nodeId) => nodeId !== active.nodeId
                )
                projection.dispatchHistory.push(normalize({
                    ...active,
                    ...payload
                }))
                break
            }
            case 'delivery.freeze-acquired': {
                requireString(
                    event.payload.freezeId,
                    'control-delivery-freeze-id-invalid'
                )
                if (projection.deliveryFreezes[event.payload.freezeId]
                    ?.active) {
                    fail('control-delivery-freeze-duplicate')
                }
                projection.deliveryFreezes[event.payload.freezeId] =
                    normalize({
                        ...event.payload,
                        active: true
                    })
                break
            }
            case 'delivery.freeze-released': {
                const freeze = projection.deliveryFreezes[
                    event.payload.freezeId
                ]
                if (!freeze?.active) fail('control-delivery-freeze-not-active')
                if (event.payload.effectId && freeze.effectId &&
                    event.payload.effectId !== freeze.effectId) {
                    fail('control-delivery-freeze-owner-mismatch')
                }
                freeze.active = false
                freeze.releasedAt = event.payload.releasedAt ?? null
                break
            }
            case 'delivery.effect-recorded': {
                requireString(
                    event.payload.effectId,
                    'control-delivery-effect-id-invalid'
                )
                const duplicate = [
                    ...Object.values(projection.pendingDeliveryEffects),
                    ...Object.values(projection.deliveryEffects)
                ].some(({ effectId }) =>
                    effectId === event.payload.effectId)
                if (duplicate) {
                    fail('control-run-effect-duplicate')
                }
                const key = event.payload.groupId ?? event.payload.effectId
                if (event.payload.status === 'remote-effect-applied') {
                    projection.pendingDeliveryEffects[key] =
                        normalize(event.payload)
                } else {
                    projection.deliveryEffects[key] =
                        normalize(event.payload)
                }
                break
            }
            case 'delivery.effect-completed': {
                requireString(
                    event.payload.effectId,
                    'control-delivery-effect-id-invalid'
                )
                const key = event.payload.groupId ?? event.payload.effectId
                const pending = projection.pendingDeliveryEffects[key]
                if (!pending || pending.effectId !== event.payload.effectId) {
                    fail('control-delivery-effect-unobserved')
                }
                if (projection.deliveryEffects[key]) {
                    fail('control-run-effect-duplicate')
                }
                projection.deliveryEffects[key] = normalize({
                    ...pending,
                    ...event.payload,
                    status: 'completed'
                })
                delete projection.pendingDeliveryEffects[key]
                break
            }
            case 'cleanup.finalized': {
                requireString(
                    event.payload.cleanupId,
                    'control-cleanup-id-invalid'
                )
                requireString(
                    event.payload.nodeId,
                    'control-cleanup-node-id-invalid'
                )
                requireDigest(
                    event.payload.cleanupReceiptDigest,
                    'control-cleanup-receipt-invalid'
                )
                requireDigest(
                    event.payload.cleanupArtifactsDigest,
                    'control-cleanup-artifacts-invalid'
                )
                requireObject(
                    event.payload.cleanupArtifacts,
                    'control-cleanup-artifacts-invalid'
                )
                if (event.payload.cleanupId !== event.payload.nodeId ||
                    projection.cleanupFinalizations[
                        event.payload.cleanupId
                    ]) {
                    fail('control-run-effect-duplicate')
                }
                projection.cleanupFinalizations[
                    event.payload.cleanupId
                ] = normalize(event.payload)
                break
            }
            case 'closure.authorization-recorded': {
                requireString(
                    event.payload.nodeId,
                    'control-closure-node-id-invalid'
                )
                requireString(
                    event.payload.effectId,
                    'control-closure-effect-id-invalid'
                )
                requireDigest(
                    event.payload.cleanupReceiptDigest,
                    'control-closure-cleanup-invalid'
                )
                requireDigest(
                    event.payload.authorizationDigest,
                    'control-closure-authorization-invalid'
                )
                requireObject(
                    event.payload.authorizationState,
                    'control-closure-authorization-invalid'
                )
                const cleanup = projection.cleanupFinalizations[
                    event.payload.nodeId
                ]
                if (!cleanup || cleanup.cleanupReceiptDigest !==
                        event.payload.cleanupReceiptDigest ||
                    projection.pendingClosureAuthorizations[
                        event.payload.nodeId
                    ] || projection.pendingClosureEffects[
                        event.payload.nodeId
                    ] || projection.closureEffects[
                        event.payload.nodeId
                    ]) {
                    fail('control-closure-authorization-stale')
                }
                projection.pendingClosureAuthorizations[
                    event.payload.nodeId
                ] = normalize(event.payload)
                break
            }
            case 'closure.effect-recorded': {
                requireString(
                    event.payload.nodeId,
                    'control-closure-node-id-invalid'
                )
                requireString(
                    event.payload.effectId,
                    'control-closure-effect-id-invalid'
                )
                requireDigest(
                    event.payload.cleanupReceiptDigest,
                    'control-closure-cleanup-invalid'
                )
                requireDigest(
                    event.payload.effectDigest,
                    'control-closure-effect-invalid'
                )
                requireObject(
                    event.payload.effectState,
                    'control-closure-effect-invalid'
                )
                const pendingAuthorization =
                    projection.pendingClosureAuthorizations[
                        event.payload.nodeId
                    ]
                if (!pendingAuthorization ||
                    pendingAuthorization.effectId !==
                        event.payload.effectId ||
                    pendingAuthorization.cleanupReceiptDigest !==
                        event.payload.cleanupReceiptDigest ||
                    projection.pendingClosureEffects[
                        event.payload.nodeId
                    ] || projection.closureEffects[
                        event.payload.nodeId
                    ]) {
                    fail('control-closure-effect-unauthorized')
                }
                projection.pendingClosureEffects[
                    event.payload.nodeId
                ] = normalize({
                    ...pendingAuthorization,
                    ...event.payload,
                    status: 'remote-effect-applied'
                })
                delete projection.pendingClosureAuthorizations[
                    event.payload.nodeId
                ]
                break
            }
            case 'closure.effect-completed': {
                requireString(
                    event.payload.nodeId,
                    'control-closure-node-id-invalid'
                )
                requireString(
                    event.payload.effectId,
                    'control-closure-effect-id-invalid'
                )
                const pending = projection.pendingClosureEffects[
                    event.payload.nodeId
                ]
                if (!pending || pending.effectId !==
                        event.payload.effectId ||
                    projection.closureEffects[event.payload.nodeId]) {
                    fail('control-closure-effect-unobserved')
                }
                projection.closureEffects[event.payload.nodeId] = normalize({
                    ...pending,
                    ...event.payload,
                    status: 'completed'
                })
                delete projection.pendingClosureEffects[
                    event.payload.nodeId
                ]
                break
            }
            case 'run.terminalized': {
                if (projection.terminal) fail('control-run-terminal-duplicate')
                const payload = requireObject(
                    event.payload,
                    'control-run-terminal-payload-invalid'
                )
                if (payload.schema !==
                        'issue-orchestration.run-terminalization.v1' ||
                    payload.status !== 'quiescent' ||
                    !Array.isArray(payload.violations) ||
                    payload.violations.length !== 0) {
                    fail('control-run-terminal-status-invalid')
                }
                for (const [field, code] of [
                    ['actionDigest', 'control-run-terminal-action-invalid'],
                    ['actionSetDigest', 'control-run-terminal-action-set-invalid'],
                    ['receiptDigest', 'control-run-terminal-receipt-invalid'],
                    ['observationDigest', 'control-run-terminal-observation-invalid'],
                    ['verifierIdentityDigest', 'control-run-terminal-verifier-invalid'],
                    ['aggregateProjectionDigest', 'control-run-terminal-projection-invalid'],
                    ['preTerminalControlEventDigest', 'control-run-terminal-head-invalid'],
                    ['completedIssueEvidenceDigest', 'control-run-terminal-evidence-invalid']
                ]) requireDigest(payload[field], code)
                const receipt = requireObject(
                    payload.quiescenceReceipt,
                    'control-run-terminal-receipt-payload-invalid'
                )
                if (receipt.status !== 'quiescent' ||
                    !Array.isArray(receipt.violations) ||
                    receipt.violations.length !== 0) {
                    fail('control-run-terminal-receipt-status-invalid')
                }
                if (receipt.receiptDigest !== payload.receiptDigest ||
                    receipt.observationDigest !== payload.observationDigest) {
                    fail('control-run-terminal-receipt-reference-invalid')
                }
                projection.terminal = normalize(payload)
                break
            }
        }
        projection.lastSequence = event.sequence
        projection.lastEventDigest = event.eventDigest
        expectedDigest = event.eventDigest
    }
    projection.controlProjectionDigest = stateDigest(projection)
    return projection
}

function verifyNodeIdentity(runId, registration, header) {
    if (header.runId !== runId) fail('node-index-run-id-mismatch')
    for (const [field, code] of [
        ['nodeId', 'node-index-node-id-mismatch'],
        ['memberId', 'node-index-member-id-mismatch'],
        ['repository', 'node-index-repository-mismatch'],
        ['issueNumber', 'node-index-issue-number-mismatch'],
        ['selectorReceiptDigest', 'node-index-selector-mismatch'],
        ['remoteMemberDigest', 'node-index-remote-member-mismatch'],
        ['nodeEpoch', 'node-index-epoch-mismatch'],
        ['baseSha', 'node-index-base-sha-mismatch'],
    ]) {
        if (header[field] !== registration[field]) fail(code)
    }
    for (const [field, code] of [
        ['issueSnapshotFingerprint',
            'node-index-issue-fingerprint-mismatch'],
        ['repositoryFingerprint',
            'node-index-repository-fingerprint-mismatch']
    ]) {
        if (registration[field] !== null &&
            registration[field] !== undefined &&
            header[field] !== registration[field]) {
            fail(code)
        }
    }
}

function replayRegisteredNodes({ stateRoot, controlProjection, nodeLedgers }) {
    if (!Array.isArray(nodeLedgers)) fail('node-ledgers-invalid')
    const supplied = new Map()
    for (const ledger of nodeLedgers) {
        const nodeId = ledger?.header?.nodeId
        requireString(nodeId, 'node-ledger-node-id-invalid')
        if (supplied.has(nodeId)) fail('node-ledger-duplicate')
        supplied.set(nodeId, ledger)
    }
    const entries = {}
    const projections = {}
    for (const [nodeId, registration] of Object.entries(
        controlProjection.nodes
    ).sort(([left], [right]) => left.localeCompare(right))) {
        if (registration.status !== 'active') continue
        const location = canonicalNodeStateLocation({
            stateRoot,
            runId: controlProjection.runId,
            nodeId,
            nodeEpoch: registration.nodeEpoch
        })
        const ledger = supplied.get(nodeId)
        if (!ledger) {
            entries[nodeId] = {
                nodeId,
                nodeKey: location.nodeKey,
                ledgerPath: path.relative(
                    location.runRoot,
                    location.ledgerPath
                ),
                projectionPath: path.relative(
                    location.runRoot,
                    location.projectionPath
                ),
                status: 'quarantined',
                errorCode: 'node-ledger-missing',
                ledgerHeadDigest: null,
                projectionDigest: null
            }
            continue
        }
        try {
            verifyNodeIdentity(controlProjection.runId, registration, ledger.header)
            const projection = replayEventLedgerSync(ledger)
            const nodeProjection = projection.nodes[nodeId]
            if (!nodeProjection) fail('node-projection-node-missing')
            projections[nodeId] = projection
            entries[nodeId] = {
                nodeId,
                nodeKey: location.nodeKey,
                ledgerPath: path.relative(
                    location.runRoot,
                    location.ledgerPath
                ),
                projectionPath: path.relative(
                    location.runRoot,
                    location.projectionPath
                ),
                status: 'verified',
                errorCode: null,
                ledgerHeadDigest: projection.lastEventDigest,
                projectionDigest: projection.projectionDigest
            }
        } catch (error) {
            entries[nodeId] = {
                nodeId,
                nodeKey: location.nodeKey,
                ledgerPath: path.relative(
                    location.runRoot,
                    location.ledgerPath
                ),
                projectionPath: path.relative(
                    location.runRoot,
                    location.projectionPath
                ),
                status: 'quarantined',
                errorCode: error?.code ?? 'node-ledger-replay-invalid',
                ledgerHeadDigest: null,
                projectionDigest: null
            }
        }
    }
    const index = {
        schema: 'issue-orchestration.node-index.v1',
        runId: controlProjection.runId,
        lifecycleAuthorityBinding:
            controlProjection.lifecycleAuthorityBinding,
        controlProjectionDigest:
            controlProjection.controlProjectionDigest,
        nodes: entries
    }
    index.nodeIndexDigest = stateDigest(index)
    return { index, projections }
}

export function buildNodeIndex({
    stateRoot,
    controlProjection,
    nodeLedgers
} = {}) {
    requireObject(controlProjection, 'control-projection-invalid')
    const { index } = replayRegisteredNodes({
        stateRoot,
        controlProjection,
        nodeLedgers
    })
    return index
}

function statusAtOrAfter(status, expected) {
    const order = [
        'none',
        'discovered',
        'acceptance-frozen',
        'test-contract-planning',
        'test-contracting',
        'test-contract-frozen',
        'implementing',
        'implementing-self-testing',
        'candidate-green',
        'independent-verifying',
        'behavior-green',
        'ui-adjudicating',
        'ux-acceptance',
        'ux-accepted',
        'documenting',
        'documentation-green',
        'delivery-ready',
        'delivering',
        'cleaning',
        'closed',
        'terminal'
    ]
    return order.indexOf(status) >= order.indexOf(expected)
}

function assembleAggregateRun({
    controlProjection,
    index,
    projections
}) {
    const nodes = {}
    for (const [nodeId, registration] of Object.entries(
        controlProjection.nodes
    ).sort(([left], [right]) => left.localeCompare(right))) {
        const entry = index.nodes[nodeId]
        const nodeProjection = projections[nodeId]?.nodes?.[nodeId] ?? null
        const dependencies = controlProjection.dependencies[nodeId] ?? []
        const blockedBy = []
        for (const dependencyId of dependencies) {
            const dependencyEntry = index.nodes[dependencyId]
            const dependencyProjection =
                projections[dependencyId]?.nodes?.[dependencyId]
            if (!dependencyEntry
                || dependencyEntry.status !== 'verified'
                || dependencyProjection?.status !== 'closed') {
                blockedBy.push(dependencyId)
            }
        }
        if (entry?.status === 'quarantined') {
            nodes[nodeId] = {
                ...registration,
                lifecycleState: 'quarantined',
                activeAttemptId: null,
                candidateGreen: false,
                deliveryComplete: false,
                dispatchable: false,
                blockedBy,
                quarantine: { errorCode: entry.errorCode }
            }
            continue
        }
        const lifecycleState = nodeProjection?.status ?? 'none'
        nodes[nodeId] = {
            ...registration,
            nodeId,
            ledgerHeadDigest: entry?.ledgerHeadDigest ?? null,
            nodeProjectionDigest: entry?.projectionDigest ?? null,
            lifecycleState,
            activeAttemptId: nodeProjection?.activeAttemptId ?? null,
            firstFailure: structuredClone(
                nodeProjection?.firstFailure ?? null
            ),
            terminalCandidate: structuredClone(
                nodeProjection?.terminal ?? null
            ),
            recoveryState: {
                expectedNextSliceId:
                    nodeProjection?.expectedNextSliceId ?? null,
                expectedNextSliceDigest:
                    nodeProjection?.expectedNextSliceDigest ?? null,
                latestContinuationReceiptDigest:
                    nodeProjection?.latestContinuationReceiptDigest ?? null,
                writerStageRetryAuthorizationDigest:
                    nodeProjection?.writerStageRetryAuthorizationDigest ?? null,
                reworkCount: nodeProjection?.reworkCount ?? 0
            },
            candidateGreen: statusAtOrAfter(
                lifecycleState,
                'candidate-green'
            ),
            deliveryComplete: [
                'cleaning', 'closed'
            ].includes(lifecycleState),
            dispatchable:
                registration.status === 'active'
                && blockedBy.length === 0
                && !nodeProjection?.activeAttemptId
                && lifecycleState !== 'closed'
                && lifecycleState !== 'terminal',
            blockedBy,
            quarantine: null
        }
    }
    const projection = {
        schema: 'issue-orchestration.aggregate-runtime-projection.v1',
        runId: controlProjection.runId,
        lifecycleAuthorityBinding:
            controlProjection.lifecycleAuthorityBinding,
        controlProjectionDigest:
            controlProjection.controlProjectionDigest,
        nodeIndexDigest: index.nodeIndexDigest,
        nodes,
        acceptanceGroups: controlProjection.acceptanceGroups,
        slots: controlProjection.slots,
        activeDispatches: controlProjection.activeDispatches,
        dispatchHistory: controlProjection.dispatchHistory,
        repositoryBases: controlProjection.repositoryBases,
        deliveryFreezes: controlProjection.deliveryFreezes,
        pendingDeliveryEffects:
            controlProjection.pendingDeliveryEffects,
        deliveryEffects: controlProjection.deliveryEffects,
        cleanupFinalizations: controlProjection.cleanupFinalizations,
        pendingClosureAuthorizations:
            controlProjection.pendingClosureAuthorizations,
        pendingClosureEffects: controlProjection.pendingClosureEffects,
        closureEffects: controlProjection.closureEffects,
        terminal: controlProjection.terminal
    }
    projection.aggregateProjectionDigest = stateDigest(projection)
    return projection
}

function indexFromVerifiedComponents({
    stateRoot,
    controlProjection,
    components
}) {
    const entries = {}
    const projections = {}
    for (const [nodeId, registration] of Object.entries(
        controlProjection.nodes
    ).sort(([left], [right]) => left.localeCompare(right))) {
        if (registration.status !== 'active') continue
        const location = canonicalNodeStateLocation({
            stateRoot,
            runId: controlProjection.runId,
            nodeId,
            nodeEpoch: registration.nodeEpoch
        })
        const component = components.get(nodeId)
        if (!component || component.status !== 'verified') {
            entries[nodeId] = {
                nodeId,
                nodeKey: location.nodeKey,
                ledgerPath: path.relative(
                    location.runRoot,
                    location.ledgerPath
                ),
                projectionPath: path.relative(
                    location.runRoot,
                    location.projectionPath
                ),
                status: 'quarantined',
                errorCode: component?.errorCode ?? 'node-ledger-missing',
                ledgerHeadDigest: null,
                projectionDigest: null
            }
            continue
        }
        projections[nodeId] = component.projection
        entries[nodeId] = {
            nodeId,
            nodeKey: location.nodeKey,
            ledgerPath: path.relative(
                location.runRoot,
                location.ledgerPath
            ),
            projectionPath: path.relative(
                location.runRoot,
                location.projectionPath
            ),
            status: 'verified',
            errorCode: null,
            ledgerHeadDigest: component.projection.lastEventDigest,
            projectionDigest: component.projection.projectionDigest
        }
    }
    const index = {
        schema: 'issue-orchestration.node-index.v1',
        runId: controlProjection.runId,
        lifecycleAuthorityBinding:
            controlProjection.lifecycleAuthorityBinding,
        controlProjectionDigest:
            controlProjection.controlProjectionDigest,
        nodes: entries
    }
    index.nodeIndexDigest = stateDigest(index)
    return { index, projections }
}

function verifiedNodeComponent({
    stateRoot,
    controlProjection,
    nodeId,
    registration,
    ledger
}) {
    try {
        verifyNodeIdentity(controlProjection.runId, registration, ledger.header)
        const projection = replayEventLedgerSync(ledger)
        if (!projection.nodes[nodeId]) fail('node-projection-node-missing')
        return {
            nodeId,
            nodeEpoch: registration.nodeEpoch,
            registrationDigest: stateDigest(registration),
            status: 'verified',
            errorCode: null,
            ledger: structuredClone(ledger),
            projection: structuredClone(projection),
            ledgerIdentity: {
                headerDigest: ledger.header.headerDigest,
                headDigest: projection.lastEventDigest
            }
        }
    } catch (error) {
        return {
            nodeId,
            nodeEpoch: registration.nodeEpoch,
            registrationDigest: stateDigest(registration),
            status: 'quarantined',
            errorCode: error?.code ?? 'node-ledger-replay-invalid',
            ledger: null,
            projection: null,
            ledgerIdentity: null
        }
    }
}

function resultFromVerifiedComponents({
    stateRoot,
    controlLedger,
    controlProjection,
    components
}) {
    const { index, projections } = indexFromVerifiedComponents({
        stateRoot,
        controlProjection,
        components
    })
    const projection = assembleAggregateRun({
        controlProjection,
        index,
        projections
    })
    return {
        controlProjection,
        nodeIndex: index,
        nodeProjections: projections,
        projection
    }
}

export function projectAggregateRun({
    stateRoot,
    controlLedger,
    nodeLedgers
} = {}) {
    if (!Array.isArray(nodeLedgers)) fail('node-ledgers-invalid')
    const controlProjection = replayControlLedger(controlLedger)
    const components = new Map()
    const supplied = new Map()
    for (const ledger of nodeLedgers) {
        const nodeId = ledger?.header?.nodeId
        requireString(nodeId, 'node-ledger-node-id-invalid')
        if (supplied.has(nodeId)) fail('node-ledger-duplicate')
        supplied.set(nodeId, ledger)
    }
    for (const [nodeId, registration] of Object.entries(
        controlProjection.nodes
    ).filter(([, value]) => value.status === 'active')) {
        const ledger = supplied.get(nodeId)
        if (!ledger) {
            components.set(nodeId, {
                nodeId,
                nodeEpoch: registration.nodeEpoch,
                registrationDigest: stateDigest(registration),
                status: 'quarantined',
                errorCode: 'node-ledger-missing',
                ledger: null,
                projection: null,
                ledgerIdentity: null
            })
            continue
        }
        components.set(nodeId, verifiedNodeComponent({
            stateRoot,
            controlProjection,
            nodeId,
            registration,
            ledger
        }))
    }
    return resultFromVerifiedComponents({
        stateRoot,
        controlLedger,
        controlProjection,
        components
    })
}

export async function appendNodeEventAtomic(input = {}) {
    return appendNodeEventAtomicSync(input)
}

export async function appendControlEventAtomic(input = {}) {
    return appendControlEventAtomicSync(input)
}

export function persistAggregateRunState({
    stateRoot,
    controlLedger,
    nodeLedgers
} = {}) {
    const result = projectAggregateRun({
        stateRoot,
        controlLedger,
        nodeLedgers
    })
    const location = canonicalRunStateLocation({
        stateRoot,
        runId: controlLedger.header.runId
    })
    writeLedger(location.controlLedgerPath, controlLedger)
    atomicWrite(
        location.controlProjectionPath,
        `${JSON.stringify(result.controlProjection, null, 2)}\n`
    )
    for (const ledger of nodeLedgers) {
        const nodeLocation = canonicalNodeStateLocation({
            stateRoot,
            runId: controlLedger.header.runId,
            nodeId: ledger.header.nodeId,
            nodeEpoch: ledger.header.nodeEpoch
        })
        writeLedger(nodeLocation.ledgerPath, ledger)
        const projection = replayEventLedgerSync(ledger)
        atomicWrite(
            nodeLocation.projectionPath,
            `${JSON.stringify(projection, null, 2)}\n`
        )
    }
    atomicWrite(
        location.nodeIndexPath,
        `${JSON.stringify(result.nodeIndex, null, 2)}\n`
    )
    atomicWrite(
        location.aggregateProjectionPath,
        `${JSON.stringify(result.projection, null, 2)}\n`
    )
    const supplied = new Map(nodeLedgers.map((ledger) => [
        ledger?.header?.nodeId,
        ledger
    ]))
    const components = new Map()
    for (const [nodeId, registration] of activeRegistrations(
        result.controlProjection
    )) {
        const ledger = supplied.get(nodeId)
        components.set(nodeId, ledger
            ? verifiedNodeComponent({
                stateRoot,
                controlProjection: result.controlProjection,
                nodeId,
                registration,
                ledger
            })
            : {
                nodeId,
                nodeEpoch: registration.nodeEpoch,
                registrationDigest: stateDigest(registration),
                status: 'quarantined',
                errorCode: 'node-ledger-missing',
                ledger: null,
                projection: null,
                ledgerIdentity: null
            })
    }
    installReplayCacheEntry({
        stateRoot,
        runId: controlLedger.header.runId,
        authorityDigest: fallbackCacheAuthorityDigest(
            result.controlProjection
        ),
        controlLedger,
        controlProjection: result.controlProjection,
        controlIdentity: {
            headerDigest: controlLedger.header.headerDigest,
            headDigest: result.controlProjection.lastEventDigest
        },
        components,
        result
    })
    return result
}

function fallbackCacheAuthorityDigest(controlProjection) {
    return stateDigest({
        schema: 'issue-orchestration.verified-replay-fallback-authority.v1',
        runId: controlProjection.runId,
        lifecycleAuthorityBinding:
            controlProjection.lifecycleAuthorityBinding ?? null
    })
}

function activeRegistrations(controlProjection) {
    return Object.entries(controlProjection.nodes)
        .filter(([, registration]) => registration.status === 'active')
        .sort(([left], [right]) => left.localeCompare(right))
}

function captureDerivedArtifactDigests({
    stateRoot,
    runId,
    components
}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    const nodeProjections = {}
    for (const [nodeId, component] of components) {
        if (component.status !== 'verified') continue
        const nodeLocation = canonicalNodeStateLocation({
            stateRoot,
            runId,
            nodeId,
            nodeEpoch: component.nodeEpoch
        })
        nodeProjections[nodeId] = fileContentDigest(
            nodeLocation.projectionPath
        )
    }
    return Object.freeze({
        controlProjection: fileContentDigest(
            location.controlProjectionPath
        ),
        nodeIndex: fileContentDigest(location.nodeIndexPath),
        aggregateProjection: fileContentDigest(
            location.aggregateProjectionPath
        ),
        nodeProjections
    })
}

function derivedArtifactsMatch(entry) {
    try {
        const current = captureDerivedArtifactDigests({
            stateRoot: entry.stateRoot,
            runId: entry.runId,
            components: entry.components
        })
        return stateDigest(current) ===
            stateDigest(entry.derivedArtifactDigests)
    } catch {
        return false
    }
}

function startupPolicyBindingDigest(controlLedger, controlProjection) {
    const genesis = controlLedger.events.find(({ eventType, payload }) =>
        eventType === 'scope.refreshed' && payload?.runGenesis
    )?.payload?.runGenesis ?? null
    const rebound = [...controlLedger.events].reverse().find(
        ({ eventType, payload }) =>
            eventType === 'runtime-authority.rebound' &&
            payload?.lifecycleAuthority
    )?.payload?.lifecycleAuthority ?? null
    return stateDigest({
        schema:
            'issue-orchestration.verified-replay-startup-policy-binding.v1',
        startupAttestationDigest:
            controlProjection.lifecycleAuthorityBinding
                ?.startupAttestationDigest ?? null,
        runtimeTrustBindingDigest:
            controlProjection.lifecycleAuthorityBinding
                ?.runtimeTrustBindingDigest ?? null,
        repositoryBindingSetDigest:
            controlProjection.lifecycleAuthorityBinding
                ?.repositoryBindingSetDigest ?? null,
        runtimeCapabilityBindingDigest:
            controlProjection.lifecycleAuthorityBinding
                ?.runtimeCapabilityBindingDigest ?? null,
        installedPolicyDigest:
            genesis?.installedPolicy?.policyDigest ?? null,
        packageBinding: genesis?.lifecycleAuthority?.packageBinding ??
            genesis?.lifecycleAuthority?.binding ?? null,
        currentAuthorityBinding: rebound?.binding ??
            controlProjection.lifecycleAuthorityBinding ?? null
    })
}

function immutableReplayKey({
    stateRoot,
    runId,
    authorityDigest,
    controlLedger,
    controlProjection,
    controlIdentity,
    result
}) {
    return stateDigest({
        schema: 'issue-orchestration.verified-replay-cache-key.v1',
        stateRoot: path.resolve(stateRoot),
        runId,
        authorityDigest,
        startupPolicyBindingDigest: startupPolicyBindingDigest(
            controlLedger,
            controlProjection
        ),
        controlLedgerHeadDigest: controlIdentity.headDigest,
        nodeIndexDigest: result.nodeIndex.nodeIndexDigest,
        nodeLedgerHeads: Object.fromEntries(
            Object.entries(result.nodeIndex.nodes)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([nodeId, node]) => [nodeId, node.ledgerHeadDigest])
        )
    })
}

function installReplayCacheEntry({
    stateRoot,
    runId,
    authorityDigest,
    controlLedger,
    controlProjection,
    controlIdentity,
    components,
    result
}) {
    const authorityLookupKey = cacheAuthorityIdentity({
        stateRoot,
        runId,
        cacheAuthorityDigest: authorityDigest
    })
    const runIdentity = cacheRunIdentity({ stateRoot, runId })
    const entry = {
        stateRoot: path.resolve(stateRoot),
        runId,
        authorityDigest,
        authorityLookupKey,
        controlLedger: structuredClone(controlLedger),
        controlProjection: structuredClone(controlProjection),
        controlIdentity: structuredClone(controlIdentity),
        components: new Map([...components].map(([nodeId, component]) => [
            nodeId,
            structuredClone(component)
        ])),
        result: structuredClone(result),
        immutableKey: immutableReplayKey({
            stateRoot,
            runId,
            authorityDigest,
            controlLedger,
            controlProjection,
            controlIdentity,
            result
        }),
        derivedArtifactDigests: captureDerivedArtifactDigests({
            stateRoot,
            runId,
            components
        })
    }
    const previousImmutableKey =
        VERIFIED_REPLAY_AUTHORITY_INDEX.get(authorityLookupKey)
    if (previousImmutableKey &&
        previousImmutableKey !== entry.immutableKey) {
        VERIFIED_REPLAY_CACHE.delete(previousImmutableKey)
        VERIFIED_REPLAY_RUN_KEYS.get(runIdentity)?.delete(
            previousImmutableKey
        )
    }
    VERIFIED_REPLAY_CACHE.set(entry.immutableKey, entry)
    VERIFIED_REPLAY_AUTHORITY_INDEX.set(
        authorityLookupKey,
        entry.immutableKey
    )
    registerCacheKey(runIdentity, entry.immutableKey)
    return entry
}

function writeRecoveredDerivedArtifacts({
    stateRoot,
    runId,
    result,
    components,
    writeControlProjection = true,
    changedNodeIds = null
}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    if (writeControlProjection) {
        atomicWrite(
            location.controlProjectionPath,
            `${JSON.stringify(result.controlProjection, null, 2)}\n`
        )
    }
    const changed = changedNodeIds === null
        ? new Set(components.keys())
        : new Set(changedNodeIds)
    for (const nodeId of changed) {
        const component = components.get(nodeId)
        if (!component || component.status !== 'verified') continue
        const nodeLocation = canonicalNodeStateLocation({
            stateRoot,
            runId,
            nodeId,
            nodeEpoch: component.nodeEpoch
        })
        atomicWrite(
            nodeLocation.projectionPath,
            `${JSON.stringify(component.projection, null, 2)}\n`
        )
    }
    atomicWrite(
        location.nodeIndexPath,
        `${JSON.stringify(result.nodeIndex, null, 2)}\n`
    )
    atomicWrite(
        location.aggregateProjectionPath,
        `${JSON.stringify(result.projection, null, 2)}\n`
    )
}

function readNodeLedgerOrCorrupt({
    stateRoot,
    runId,
    nodeId,
    nodeEpoch,
    stats
}) {
    const nodeLocation = canonicalNodeStateLocation({
        stateRoot,
        runId,
        nodeId,
        nodeEpoch
    })
    try {
        noteFullLedgerRead(stats, nodeLocation.ledgerPath)
        return readLedger(nodeLocation.ledgerPath)
    } catch (error) {
        return {
            header: {
                schema: 'issue-orchestration.corrupt-node-ledger.v1',
                runId,
                nodeId,
                memberId: nodeId
            },
            events: [],
            recoveryErrorCode:
                error?.code ?? 'node-ledger-replay-invalid'
        }
    }
}

function componentForLedger({
    stateRoot,
    controlProjection,
    nodeId,
    registration,
    ledger
}) {
    if (ledger.recoveryErrorCode) {
        return {
            nodeId,
            nodeEpoch: registration.nodeEpoch,
            registrationDigest: stateDigest(registration),
            status: 'quarantined',
            errorCode: ledger.recoveryErrorCode,
            ledger: null,
            projection: null,
            ledgerIdentity: null
        }
    }
    return verifiedNodeComponent({
        stateRoot,
        controlProjection,
        nodeId,
        registration,
        ledger
    })
}

function fullReplayAggregateRunState({
    stateRoot,
    runId,
    cacheAuthorityDigest = null,
    stats
}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    noteFullLedgerRead(stats, location.controlLedgerPath)
    const controlLedger = readLedger(location.controlLedgerPath)
    stats.controlLedgerReplays += 1
    const controlProjection = replayControlLedger(controlLedger)
    const storedIndex = JSON.parse(
        fs.readFileSync(location.nodeIndexPath, 'utf8')
    )
    if (storedIndex.schema !== 'issue-orchestration.node-index.v1' ||
        storedIndex.runId !== runId ||
        !SHA256.test(storedIndex.nodeIndexDigest ?? '') ||
        unsignedDigest(storedIndex, 'nodeIndexDigest') !==
            storedIndex.nodeIndexDigest) {
        fail('node-index-digest-invalid')
    }
    const components = new Map()
    for (const [nodeId, registration] of activeRegistrations(
        controlProjection
    )) {
        const ledger = readNodeLedgerOrCorrupt({
            stateRoot,
            runId,
            nodeId,
            nodeEpoch: registration.nodeEpoch,
            stats
        })
        stats.nodeLedgerReplays += 1
        components.set(nodeId, componentForLedger({
            stateRoot,
            controlProjection,
            nodeId,
            registration,
            ledger
        }))
    }
    const result = resultFromVerifiedComponents({
        stateRoot,
        controlLedger,
        controlProjection,
        components
    })
    stats.fullReplays += 1
    stats.aggregateProjectionRebuilds += 1
    writeRecoveredDerivedArtifacts({
        stateRoot,
        runId,
        result,
        components
    })
    const controlIdentity = {
        headerDigest: controlLedger.header.headerDigest,
        headDigest: controlProjection.lastEventDigest
    }
    const authorityDigest = cacheAuthorityDigest ??
        fallbackCacheAuthorityDigest(controlProjection)
    const entry = installReplayCacheEntry({
        stateRoot,
        runId,
        authorityDigest,
        controlLedger,
        controlProjection,
        controlIdentity,
        components,
        result
    })
    return { entry, observation: {
        status: 'full-replay',
        immutableKey: entry.immutableKey,
        controlLedgerReplays: 1,
        nodeLedgerReplays: components.size,
        aggregateProjectionRebuilds: 1
    } }
}

function validateCurrentCachedIdentities(entry, stats) {
    const controlLocation = canonicalRunStateLocation({
        stateRoot: entry.stateRoot,
        runId: entry.runId
    })
    const controlIdentity = readLedgerIdentity(
        controlLocation.controlLedgerPath
    )
    noteLedgerIdentity(stats, controlIdentity)
    const nodeIdentities = new Map()
    for (const [nodeId, component] of entry.components) {
        const nodeLocation = canonicalNodeStateLocation({
            stateRoot: entry.stateRoot,
            runId: entry.runId,
            nodeId,
            nodeEpoch: component.nodeEpoch
        })
        try {
            const identity = readLedgerIdentity(nodeLocation.ledgerPath)
            noteLedgerIdentity(stats, identity)
            nodeIdentities.set(nodeId, identity)
        } catch (error) {
            nodeIdentities.set(nodeId, {
                errorCode: error?.code ?? 'node-ledger-replay-invalid'
            })
        }
    }
    return { controlIdentity, nodeIdentities }
}

function reconcileComponents({
    entry,
    controlLedger,
    controlProjection,
    identities,
    stats
}) {
    const components = new Map()
    const changedNodeIds = []
    for (const [nodeId, registration] of activeRegistrations(
        controlProjection
    )) {
        const cached = entry.components.get(nodeId)
        const identity = identities.nodeIdentities.get(nodeId)
        if (cached &&
            cached.registrationDigest === stateDigest(registration) &&
            cached.status === 'verified' &&
            identity && !identity.errorCode &&
            identity.headerDigest ===
                cached.ledgerIdentity.headerDigest &&
            identity.headDigest === cached.ledgerIdentity.headDigest) {
            components.set(nodeId, structuredClone(cached))
            continue
        }
        const ledger = readNodeLedgerOrCorrupt({
            stateRoot: entry.stateRoot,
            runId: entry.runId,
            nodeId,
            nodeEpoch: registration.nodeEpoch,
            stats
        })
        stats.nodeLedgerReplays += 1
        changedNodeIds.push(nodeId)
        components.set(nodeId, componentForLedger({
            stateRoot: entry.stateRoot,
            controlProjection,
            nodeId,
            registration,
            ledger
        }))
    }
    const result = resultFromVerifiedComponents({
        stateRoot: entry.stateRoot,
        controlLedger,
        controlProjection,
        components
    })
    stats.aggregateProjectionRebuilds += 1
    return { components, result, changedNodeIds }
}

export function recoverAggregateRunState({
    stateRoot,
    runId,
    cacheAuthorityDigest = null,
    forceFullReplay = false,
    explicitAudit = false,
    corruptionSuspected = false
} = {}) {
    const canonicalStateRoot = path.resolve(stateRoot)
    const stats = statsForRun({ stateRoot: canonicalStateRoot, runId })
    const beforeBytes = stats.canonicalLedgerBytesRead
    const authorityDigest = cacheAuthorityDigest
    const authorityLookupKey = authorityDigest === null
        ? null
        : cacheAuthorityIdentity({
            stateRoot: canonicalStateRoot,
            runId,
            cacheAuthorityDigest: authorityDigest
        })
    const immutableLookupKey = authorityLookupKey === null
        ? null
        : VERIFIED_REPLAY_AUTHORITY_INDEX.get(authorityLookupKey)
    let entry = immutableLookupKey === null ||
        immutableLookupKey === undefined
        ? null
        : VERIFIED_REPLAY_CACHE.get(immutableLookupKey)
    if (!entry && authorityLookupKey === null) {
        const runIdentity = cacheRunIdentity({
            stateRoot: canonicalStateRoot,
            runId
        })
        const candidates = [...(VERIFIED_REPLAY_RUN_KEYS.get(runIdentity) ?? [])]
            .map((key) => VERIFIED_REPLAY_CACHE.get(key))
            .filter(Boolean)
        if (candidates.length === 1) entry = candidates[0]
    }
    if (!entry || forceFullReplay || explicitAudit || corruptionSuspected ||
        !derivedArtifactsMatch(entry)) {
        const replayed = fullReplayAggregateRunState({
            stateRoot: canonicalStateRoot,
            runId,
            cacheAuthorityDigest: authorityDigest,
            stats
        })
        return cloneCacheResult(
            replayed.entry.result,
            replayed.entry.controlLedger,
            {
                ...replayed.observation,
                canonicalLedgerBytesRead:
                    stats.canonicalLedgerBytesRead - beforeBytes
            }
        )
    }
    const identities = validateCurrentCachedIdentities(entry, stats)
    const controlUnchanged =
        identities.controlIdentity.headerDigest ===
            entry.controlIdentity.headerDigest &&
        identities.controlIdentity.headDigest ===
            entry.controlIdentity.headDigest
    const nodesUnchanged = [...entry.components].every(
        ([nodeId, component]) => {
            const current = identities.nodeIdentities.get(nodeId)
            return current && !current.errorCode &&
                current.headerDigest ===
                    component.ledgerIdentity?.headerDigest &&
                current.headDigest === component.ledgerIdentity?.headDigest
        }
    )
    if (controlUnchanged && nodesUnchanged) {
        stats.cacheHits += 1
        return cloneCacheResult(entry.result, entry.controlLedger, {
            status: 'cache-hit',
            immutableKey: entry.immutableKey,
            controlLedgerReplays: 0,
            nodeLedgerReplays: 0,
            aggregateProjectionRebuilds: 0,
            canonicalLedgerBytesRead:
                stats.canonicalLedgerBytesRead - beforeBytes
        })
    }
    let controlLedger = entry.controlLedger
    let controlProjection = entry.controlProjection
    if (!controlUnchanged) {
        const location = canonicalRunStateLocation({
            stateRoot: canonicalStateRoot,
            runId
        })
        noteFullLedgerRead(stats, location.controlLedgerPath)
        controlLedger = readLedger(location.controlLedgerPath)
        stats.controlLedgerReplays += 1
        controlProjection = replayControlLedger(controlLedger)
        if (stateDigest(controlProjection.lifecycleAuthorityBinding ?? null) !==
            stateDigest(entry.controlProjection.lifecycleAuthorityBinding ?? null)) {
            const replayed = fullReplayAggregateRunState({
                stateRoot: canonicalStateRoot,
                runId,
                cacheAuthorityDigest: authorityDigest,
                stats
            })
            return cloneCacheResult(
                replayed.entry.result,
                replayed.entry.controlLedger,
                {
                    ...replayed.observation,
                    status: 'authority-change-full-replay',
                    canonicalLedgerBytesRead:
                        stats.canonicalLedgerBytesRead - beforeBytes
                }
            )
        }
    }
    const reconciled = reconcileComponents({
        entry,
        controlLedger,
        controlProjection,
        identities,
        stats
    })
    writeRecoveredDerivedArtifacts({
        stateRoot: canonicalStateRoot,
        runId,
        result: reconciled.result,
        components: reconciled.components,
        writeControlProjection: !controlUnchanged,
        changedNodeIds: reconciled.changedNodeIds
    })
    const nextControlIdentity = {
        headerDigest: controlLedger.header.headerDigest,
        headDigest: controlProjection.lastEventDigest
    }
    const next = installReplayCacheEntry({
        stateRoot: canonicalStateRoot,
        runId,
        authorityDigest: authorityDigest ?? entry.authorityDigest,
        controlLedger,
        controlProjection,
        controlIdentity: nextControlIdentity,
        components: reconciled.components,
        result: reconciled.result
    })
    return cloneCacheResult(next.result, next.controlLedger, {
        status: controlUnchanged
            ? 'node-incremental-replay'
            : 'control-incremental-replay',
        immutableKey: next.immutableKey,
        controlLedgerReplays: controlUnchanged ? 0 : 1,
        nodeLedgerReplays: reconciled.changedNodeIds.length,
        aggregateProjectionRebuilds: 1,
        canonicalLedgerBytesRead:
            stats.canonicalLedgerBytesRead - beforeBytes
    })
}


function cacheEntriesForRun({ stateRoot, runId }) {
    const runIdentity = cacheRunIdentity({ stateRoot, runId })
    return [...(VERIFIED_REPLAY_RUN_KEYS.get(runIdentity) ?? [])]
        .map((key) => VERIFIED_REPLAY_CACHE.get(key))
        .filter(Boolean)
}

function updateEntriesAfterNodeAppend({
    stateRoot,
    runId,
    nodeId,
    candidateLedger,
    nodeProjection
}) {
    const entries = cacheEntriesForRun({ stateRoot, runId })
    if (entries.length === 0) return null
    const stats = statsForRun({ stateRoot, runId })
    const compatible = entries.filter((entry) => {
        const registration = entry.controlProjection.nodes[nodeId]
        return registration?.status === 'active' &&
            entry.controlIdentity.headDigest ===
                entry.controlProjection.lastEventDigest
    })
    if (compatible.length === 0) return null
    let canonical = null
    for (const entry of compatible) {
        const registration = entry.controlProjection.nodes[nodeId]
        const component = verifiedNodeComponent({
            stateRoot,
            controlProjection: entry.controlProjection,
            nodeId,
            registration,
            ledger: candidateLedger
        })
        if (component.status !== 'verified' ||
            component.projection.projectionDigest !==
                nodeProjection.projectionDigest) {
            fail('verified-replay-node-append-invalid')
        }
        const components = new Map([...entry.components].map(
            ([key, value]) => [key, structuredClone(value)]
        ))
        components.set(nodeId, component)
        const result = resultFromVerifiedComponents({
            stateRoot,
            controlLedger: entry.controlLedger,
            controlProjection: entry.controlProjection,
            components
        })
        if (!canonical) {
            canonical = { result, components }
            stats.nodeLedgerReplays += 1
            stats.aggregateProjectionRebuilds += 1
            writeRecoveredDerivedArtifacts({
                stateRoot,
                runId,
                result,
                components,
                writeControlProjection: false,
                changedNodeIds: [nodeId]
            })
        } else if (stateDigest(result) !== stateDigest(canonical.result)) {
            fail('verified-replay-cache-entry-diverged')
        }
        installReplayCacheEntry({
            stateRoot,
            runId,
            authorityDigest: entry.authorityDigest,
            controlLedger: entry.controlLedger,
            controlProjection: entry.controlProjection,
            controlIdentity: entry.controlIdentity,
            components,
            result
        })
    }
    return canonical.result
}

function updateEntriesAfterControlAppend({
    stateRoot,
    runId,
    previousControlHeadDigest,
    candidateLedger,
    controlProjection
}) {
    const entries = cacheEntriesForRun({ stateRoot, runId })
        .filter((entry) =>
            entry.controlIdentity.headDigest === previousControlHeadDigest)
    if (entries.length === 0) return null
    const bindingChanged = entries.some((entry) =>
        stateDigest(entry.controlProjection.lifecycleAuthorityBinding ?? null) !==
        stateDigest(controlProjection.lifecycleAuthorityBinding ?? null))
    if (bindingChanged) return null
    const stats = statsForRun({ stateRoot, runId })
    let canonical = null
    for (const entry of entries) {
        const components = new Map()
        const changedNodeIds = []
        for (const [nodeId, registration] of activeRegistrations(
            controlProjection
        )) {
            const cached = entry.components.get(nodeId)
            if (cached &&
                cached.registrationDigest === stateDigest(registration)) {
                components.set(nodeId, structuredClone(cached))
                continue
            }
            const ledger = readNodeLedgerOrCorrupt({
                stateRoot,
                runId,
                nodeId,
                nodeEpoch: registration.nodeEpoch,
                stats
            })
            stats.nodeLedgerReplays += 1
            changedNodeIds.push(nodeId)
            components.set(nodeId, componentForLedger({
                stateRoot,
                controlProjection,
                nodeId,
                registration,
                ledger
            }))
        }
        const result = resultFromVerifiedComponents({
            stateRoot,
            controlLedger: candidateLedger,
            controlProjection,
            components
        })
        if (!canonical) {
            canonical = { result, components, changedNodeIds }
            stats.controlLedgerReplays += 1
            stats.aggregateProjectionRebuilds += 1
            writeRecoveredDerivedArtifacts({
                stateRoot,
                runId,
                result,
                components,
                writeControlProjection: false,
                changedNodeIds
            })
        } else if (stateDigest(result) !== stateDigest(canonical.result)) {
            fail('verified-replay-cache-entry-diverged')
        }
        installReplayCacheEntry({
            stateRoot,
            runId,
            authorityDigest: entry.authorityDigest,
            controlLedger: candidateLedger,
            controlProjection,
            controlIdentity: {
                headerDigest: candidateLedger.header.headerDigest,
                headDigest: controlProjection.lastEventDigest
            },
            components,
            result
        })
    }
    return canonical.result
}

function loadActiveNodeLedgers({ stateRoot, controlProjection }) {
    return Object.entries(controlProjection.nodes)
        .filter(([, registration]) => registration.status === 'active')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, registration]) => {
            const nodeLocation = canonicalNodeStateLocation({
                stateRoot,
                runId: controlProjection.runId,
                nodeId,
                nodeEpoch: registration.nodeEpoch
            })
            try {
                return readLedger(nodeLocation.ledgerPath)
            } catch (error) {
                return {
                    header: {
                        schema:
                            'issue-orchestration.corrupt-node-ledger.v1',
                        runId: controlProjection.runId,
                        nodeId,
                        memberId: nodeId
                    },
                    events: [],
                    recoveryErrorCode:
                        error?.code ?? 'node-ledger-replay-invalid'
                }
            }
        })
}

function writeAggregateDerivedArtifacts({
    stateRoot,
    runId,
    result,
    writeControlProjection = false
}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    if (writeControlProjection) {
        atomicWrite(
            location.controlProjectionPath,
            `${JSON.stringify(result.controlProjection, null, 2)}\n`
        )
    }
    atomicWrite(
        location.nodeIndexPath,
        `${JSON.stringify(result.nodeIndex, null, 2)}\n`
    )
    atomicWrite(
        location.aggregateProjectionPath,
        `${JSON.stringify(result.projection, null, 2)}\n`
    )
}

function refreshAggregateDerivedState({
    stateRoot,
    controlLedger,
    writeControlProjection = false
}) {
    const controlProjection = replayControlLedger(controlLedger)
    const nodeLedgers = loadActiveNodeLedgers({
        stateRoot,
        controlProjection
    })
    const result = projectAggregateRun({
        stateRoot,
        controlLedger,
        nodeLedgers
    })
    writeAggregateDerivedArtifacts({
        stateRoot,
        runId: controlLedger.header.runId,
        result,
        writeControlProjection
    })
    return result
}

export function appendNodeEventAtomicSync({
    stateRoot,
    runId,
    nodeId,
    event,
    writerRole
} = {}) {
    if (writerRole !== 'root-scheduler') fail('ledger-writer-role')
    const controlLedger = readCanonicalControlLedger({ stateRoot, runId })
    const controlProjection = replayControlLedger(controlLedger)
    const registration = controlProjection.nodes[nodeId]
    if (!registration || registration.status !== 'active') {
        fail('control-node-not-active')
    }
    const location = canonicalNodeStateLocation({
        stateRoot,
        runId,
        nodeId,
        nodeEpoch: registration.nodeEpoch
    })
    const ledger = readLedger(location.ledgerPath)
    if (ledger.header.nodeId !== nodeId || event?.nodeId !== nodeId) {
        fail('event-node-identity')
    }
    const candidate = {
        header: ledger.header,
        events: [...ledger.events, event]
    }
    const projection = replayEventLedgerSync(candidate)
    fs.appendFileSync(
        location.ledgerPath,
        `${JSON.stringify(event)}\n`,
        { flush: true }
    )
    atomicWrite(
        location.projectionPath,
        `${JSON.stringify(projection, null, 2)}\n`
    )
    const aggregate = updateEntriesAfterNodeAppend({
        stateRoot,
        runId,
        nodeId,
        candidateLedger: candidate,
        nodeProjection: projection
    }) ?? refreshAggregateDerivedState({
        stateRoot,
        controlLedger
    })
    return { projection, aggregate }
}

export function appendControlEventAtomicSync({
    stateRoot,
    runId,
    event,
    writerRole
} = {}) {
    if (writerRole !== 'root-scheduler') fail('control-ledger-writer-role')
    const location = canonicalRunStateLocation({ stateRoot, runId })
    const ledger = readLedger(location.controlLedgerPath)
    if (event.runId !== runId) fail('control-event-run-id')
    assertControlEventType(event.eventType)
    const candidate = {
        header: ledger.header,
        events: [...ledger.events, event]
    }
    const projection = replayControlLedger(candidate)
    fs.appendFileSync(
        location.controlLedgerPath,
        `${JSON.stringify(event)}\n`,
        { flush: true }
    )
    atomicWrite(
        location.controlProjectionPath,
        `${JSON.stringify(projection, null, 2)}\n`
    )
    const aggregate = updateEntriesAfterControlAppend({
        stateRoot,
        runId,
        previousControlHeadDigest:
            ledger.events.at(-1)?.eventDigest ?? GENESIS,
        candidateLedger: candidate,
        controlProjection: projection
    }) ?? refreshAggregateDerivedState({
        stateRoot,
        controlLedger: candidate,
        writeControlProjection: false
    })
    return { projection, aggregate }
}
