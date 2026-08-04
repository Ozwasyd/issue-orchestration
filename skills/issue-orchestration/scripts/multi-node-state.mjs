import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
    replayEventLedgerSync,
    transitionTable
} from './event-ledger.mjs'

const GENESIS = '0'.repeat(64)
const SHA256 = /^[a-f0-9]{64}$/u
const GIT_SHA = /^[a-f0-9]{40}$/u

export const CONTROL_EVENT_TYPES = Object.freeze([
    'scope.refreshed',
    'remote-snapshot.refreshed',
    'node.registered',
    'node.removed',
    'node.tombstoned',
    'dependency.updated',
    'acceptance-group.updated',
    'slots.updated',
    'dispatch-batch.recorded',
    'delivery.freeze-acquired',
    'delivery.freeze-released',
    'delivery.effect-recorded',
    'cleanup.finalized',
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
    nodeId
} = {}) {
    requireString(nodeId, 'node-id-required')
    const run = canonicalRunStateLocation({ stateRoot, runId })
    const nodeKey = stateDigest({ runId, nodeId })
    const nodeRoot = path.join(run.nodesRoot, nodeKey)
    return Object.freeze({
        ...run,
        nodeId,
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
    nodeId
} = {}) {
    const location = canonicalNodeStateLocation({
        stateRoot,
        runId,
        nodeId
    })
    return readLedger(location.ledgerPath)
}

export function sealControlLedgerHeader({ runId, createdAt } = {}) {
    requireString(runId, 'control-ledger-run-id-invalid')
    requireString(createdAt, 'control-ledger-created-at-invalid')
    const header = {
        schema: 'issue-orchestration.control-ledger.v1',
        runId,
        createdAt
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
    createdAt
} = {}) {
    validateControlHeader(ledger?.header)
    if (!Array.isArray(ledger.events)) fail('control-ledger-events-invalid')
    assertControlEventType(eventType)
    if (actorRole !== 'root-scheduler') fail('control-ledger-writer-role')
    requireString(createdAt, 'control-event-created-at-invalid')
    requireObject(payload, 'control-event-payload-invalid')
    const event = {
        schema: 'issue-orchestration.control-event.v1',
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        eventType,
        actorRole,
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
    return {
        nodeId: payload.nodeId,
        memberId: payload.memberId,
        repository: payload.repository,
        issueNumber: payload.issueNumber,
        selectorReceiptDigest: payload.selectorReceiptDigest,
        remoteMemberDigest: payload.remoteMemberDigest,
        nodeEpoch: payload.nodeEpoch,
        baseSha: payload.baseSha,
        dependencyKeys: sortedUnique(
            payload.dependencyKeys ?? [],
            'control-node-dependencies-invalid'
        ),
        acceptanceGroup: payload.acceptanceGroup ?? null,
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
        selectorReceiptDigest: null,
        remoteSnapshotDigest: null,
        nodes: {},
        dependencies: {},
        acceptanceGroups: {},
        slots: { capacity: 0, active: [] },
        dispatchBatches: [],
        deliveryFreezes: {},
        deliveryEffects: {},
        cleanupFinalizations: {},
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
        switch (event.eventType) {
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
                if (projection.nodes[registration.nodeId]) {
                    fail('control-node-duplicate')
                }
                projection.nodes[registration.nodeId] = registration
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
            case 'node.removed':
            case 'node.tombstoned': {
                const node = ensureNode(projection, event.payload.nodeId)
                node.status = event.eventType === 'node.removed'
                    ? 'removed'
                    : 'tombstoned'
                node.removalReason = event.payload.reason ?? null
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
                projection.dispatchBatches.push(normalize(event.payload))
                break
            case 'delivery.freeze-acquired': {
                requireString(
                    event.payload.freezeId,
                    'control-delivery-freeze-id-invalid'
                )
                if (projection.deliveryFreezes[event.payload.freezeId]) {
                    fail('control-delivery-freeze-duplicate')
                }
                projection.deliveryFreezes[event.payload.freezeId] = {
                    active: true,
                    groupId: event.payload.groupId ?? null
                }
                break
            }
            case 'delivery.freeze-released': {
                const freeze = projection.deliveryFreezes[
                    event.payload.freezeId
                ]
                if (!freeze?.active) fail('control-delivery-freeze-not-active')
                freeze.active = false
                break
            }
            case 'delivery.effect-recorded': {
                requireString(
                    event.payload.effectId,
                    'control-delivery-effect-id-invalid'
                )
                if (projection.deliveryEffects[event.payload.effectId]) {
                    fail('control-run-effect-duplicate')
                }
                projection.deliveryEffects[event.payload.effectId] =
                    normalize(event.payload)
                break
            }
            case 'cleanup.finalized': {
                requireString(
                    event.payload.cleanupId,
                    'control-cleanup-id-invalid'
                )
                if (projection.cleanupFinalizations[
                    event.payload.cleanupId
                ]) {
                    fail('control-run-effect-duplicate')
                }
                projection.cleanupFinalizations[
                    event.payload.cleanupId
                ] = normalize(event.payload)
                break
            }
            case 'run.terminalized':
                if (projection.terminal) fail('control-run-terminal-duplicate')
                projection.terminal = normalize(event.payload)
                break
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
        ['baseSha', 'node-index-base-sha-mismatch']
    ]) {
        if (header[field] !== registration[field]) fail(code)
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
            nodeId
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
        'test-contracting',
        'test-contract-frozen',
        'implementing-self-testing',
        'candidate-green',
        'independent-verifying',
        'behavior-green',
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

export function projectAggregateRun({
    stateRoot,
    controlLedger,
    nodeLedgers
} = {}) {
    const controlProjection = replayControlLedger(controlLedger)
    const { index, projections } = replayRegisteredNodes({
        stateRoot,
        controlProjection,
        nodeLedgers
    })
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
            candidateGreen: statusAtOrAfter(
                lifecycleState,
                'candidate-green'
            ),
            deliveryComplete: lifecycleState === 'closed',
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
        controlProjectionDigest:
            controlProjection.controlProjectionDigest,
        nodeIndexDigest: index.nodeIndexDigest,
        nodes,
        acceptanceGroups: controlProjection.acceptanceGroups,
        slots: controlProjection.slots,
        deliveryFreezes: controlProjection.deliveryFreezes,
        deliveryEffects: controlProjection.deliveryEffects,
        cleanupFinalizations: controlProjection.cleanupFinalizations,
        terminal: controlProjection.terminal
    }
    projection.aggregateProjectionDigest = stateDigest(projection)
    return { controlProjection, nodeIndex: index, projection }
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
            nodeId: ledger.header.nodeId
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
    return result
}

export function recoverAggregateRunState({ stateRoot, runId } = {}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    const controlLedger = readLedger(location.controlLedgerPath)
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
    const nodeLedgers = Object.entries(controlProjection.nodes)
        .filter(([, registration]) => registration.status === 'active')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId]) => {
            const nodeLocation = canonicalNodeStateLocation({
                stateRoot,
                runId,
                nodeId
            })
            try {
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
        })
    const result = projectAggregateRun({
        stateRoot,
        controlLedger,
        nodeLedgers
    })
    atomicWrite(
        location.controlProjectionPath,
        `${JSON.stringify(result.controlProjection, null, 2)}\n`
    )
    for (const ledger of nodeLedgers) {
        if (ledger.recoveryErrorCode) continue
        const nodeLocation = canonicalNodeStateLocation({
            stateRoot,
            runId,
            nodeId: ledger.header.nodeId
        })
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
    return result
}

export async function appendNodeEventAtomic({
    stateRoot,
    runId,
    nodeId,
    event,
    writerRole
} = {}) {
    if (writerRole !== 'root-scheduler') fail('ledger-writer-role')
    const location = canonicalNodeStateLocation({ stateRoot, runId, nodeId })
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
    return projection
}

export async function appendControlEventAtomic({
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
    return projection
}
