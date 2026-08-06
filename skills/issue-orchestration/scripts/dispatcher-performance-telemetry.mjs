import fs from 'node:fs'
import path from 'node:path'

import {
    canonical,
    digest
} from './runtime-contract-lib.mjs'
import {
    canonicalRunStateLocation
} from './multi-node-state.mjs'
import {
    sanitizeProviderPromptCacheMetadata
} from './actor-prompt-cache-identity.mjs'

const SCHEMA =
    'issue-orchestration.dispatcher-performance-receipt.v1'
const HASH = /^[a-f0-9]{64}$/u
const METRICS = Object.freeze([
    'canonicalReplay',
    'aggregateProjectionRebuild',
    'actionSetCompilation',
    'remoteScopeObservation',
    'repositoryBaseObservation',
    'contextPreparation',
    'machineActionExecution',
    'actorResultAdmission'
])
const METRIC_SET = new Set(METRICS)

export class DispatcherPerformanceTelemetryError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'DispatcherPerformanceTelemetryError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new DispatcherPerformanceTelemetryError(code, details)
}

function requireObject(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function requireText(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function instant(value, code = 'dispatcher-performance-clock-invalid') {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        fail(code)
    }
    return value
}

function duration(startedAt, completedAt) {
    const value = Date.parse(completedAt) - Date.parse(startedAt)
    if (!Number.isFinite(value) || value < 0) {
        fail('dispatcher-performance-clock-regressed', {
            startedAt,
            completedAt
        })
    }
    return value
}

function byteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value))
    } catch (error) {
        fail('dispatcher-performance-byte-measurement-failed', {
            cause: error?.message ?? 'json-serialization-failed'
        })
    }
}

function ledgerBytes({ stateRoot, runId }) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    let total = 0
    const add = (filePath) => {
        try {
            total += fs.statSync(filePath).size
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error
        }
    }
    add(location.controlLedgerPath)
    try {
        for (const entry of fs.readdirSync(location.nodesRoot, {
            withFileTypes: true
        })) {
            if (!entry.isDirectory()) continue
            add(path.join(
                location.nodesRoot,
                entry.name,
                'event-ledger.jsonl'
            ))
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }
    return total
}

function repositoriesForAction(action) {
    const direct = action?.bindings?.repository
    if (typeof direct === 'string' && direct.length > 0) return [direct]
    const members = action?.bindings?.memberBindings
    if (!Array.isArray(members)) return []
    return [...new Set(members
        .map(({ repository }) => repository)
        .filter((repository) =>
            typeof repository === 'string' && repository.length > 0))]
        .sort()
}

function emptySummary() {
    return Object.fromEntries(METRICS.map((metric) => [metric, {
        count: 0,
        durationMs: 0
    }]))
}

function stableMetadata(value = {}) {
    const metadata = {}
    for (const field of [
        'boundary', 'transition', 'actionDigest', 'actionType', 'nodeId',
        'dispatchId', 'phase', 'status', 'protocol', 'observationStatus'
    ]) {
        if (value[field] !== undefined && value[field] !== null) {
            metadata[field] = value[field]
        }
    }
    for (const field of ['remoteFactsTransferred', 'deltaMembers']) {
        if (Number.isInteger(value[field]) && value[field] >= 0) {
            metadata[field] = value[field]
        }
    }
    if (typeof value.selectorRebuilt === 'boolean') {
        metadata.selectorRebuilt = value.selectorRebuilt
    }
    if (Array.isArray(value.repositories) && value.repositories.length > 0) {
        metadata.repositories = [...new Set(value.repositories)].sort()
    }
    for (const field of ['actionDigests', 'dispatchIds']) {
        if (Array.isArray(value[field]) && value[field].length > 0) {
            metadata[field] = [...new Set(value[field])].sort()
        }
    }
    return metadata
}

export function createDispatcherPerformanceCollector({
    runId,
    stateRoot,
    clock = () => new Date().toISOString()
} = {}) {
    requireText(runId, 'dispatcher-performance-run-id-required')
    requireText(stateRoot, 'dispatcher-performance-state-root-required')
    if (typeof clock !== 'function') {
        fail('dispatcher-performance-clock-required')
    }
    let lastTimestamp = null
    let sequence = 0
    let finalized = false
    let transition = 0
    let slotCapacity = 0
    const spans = []
    const dispatches = new Map()
    const slotSamples = []
    const slotRefills = []
    const promptCacheObservations = []
    const unrefilled = []
    const summary = emptySummary()
    const repositorySummary = new Map()
    const bytes = {
        canonicalLedgersRead: 0,
        actorContextPrepared: 0
    }

    function now() {
        const value = instant(clock())
        if (lastTimestamp && Date.parse(value) < Date.parse(lastTimestamp)) {
            fail('dispatcher-performance-clock-regressed', {
                previous: lastTimestamp,
                current: value
            })
        }
        lastTimestamp = value
        return value
    }

    const startedAt = now()

    function addMetric(metric, elapsed) {
        if (!METRIC_SET.has(metric)) {
            fail('dispatcher-performance-metric-invalid', { metric })
        }
        summary[metric].count += 1
        summary[metric].durationMs += elapsed
    }

    function recordSpan({
        metrics,
        metadata,
        startedAt: spanStartedAt,
        completedAt,
        canonicalBytes = 0,
        contextBytes = 0
    }) {
        const elapsed = duration(spanStartedAt, completedAt)
        for (const metric of metrics) addMetric(metric, elapsed)
        bytes.canonicalLedgersRead += canonicalBytes
        bytes.actorContextPrepared += contextBytes
        const repositories = metadata?.repositories ?? []
        if (metrics.includes('repositoryBaseObservation')) {
            for (const repository of repositories) {
                const current = repositorySummary.get(repository) ?? {
                    repository,
                    count: 0,
                    durationMs: 0
                }
                current.count += 1
                current.durationMs += elapsed
                repositorySummary.set(repository, current)
            }
        }
        sequence += 1
        spans.push(Object.freeze({
            sequence,
            metrics: [...metrics],
            ...stableMetadata({ ...metadata, transition }),
            startedAt: spanStartedAt,
            completedAt,
            durationMs: elapsed,
            canonicalLedgerBytesRead: canonicalBytes,
            actorContextBytesPrepared: contextBytes
        }))
    }

    function measureSync(metrics, metadata, operation, options = {}) {
        if (finalized) fail('dispatcher-performance-finalized')
        if (!Array.isArray(metrics) || metrics.length === 0 ||
            typeof operation !== 'function') {
            fail('dispatcher-performance-span-invalid')
        }
        const spanStartedAt = now()
        let result
        let failure = null
        let canonicalBytes = options.ledgerRead === true &&
            typeof options.resolveCanonicalBytes !== 'function'
            ? ledgerBytes({ stateRoot, runId })
            : 0
        const contextBytes = options.context === undefined
            ? 0
            : byteLength(options.context)
        try {
            result = operation()
            return result
        } catch (error) {
            failure = error
            throw error
        } finally {
            const resolvedMetrics = typeof options.resolveMetrics === 'function'
                ? options.resolveMetrics({ result, error: failure })
                : metrics
            if (!Array.isArray(resolvedMetrics) ||
                resolvedMetrics.some((metric) => !METRIC_SET.has(metric))) {
                fail('dispatcher-performance-metric-invalid')
            }
            if (typeof options.resolveCanonicalBytes === 'function') {
                canonicalBytes = options.resolveCanonicalBytes({
                    result,
                    error: failure
                })
                if (!Number.isInteger(canonicalBytes) || canonicalBytes < 0) {
                    fail('dispatcher-performance-byte-measurement-failed')
                }
            }
            let resolvedMetadata = metadata
            if (typeof options.resolveMetadata === 'function') {
                try {
                    resolvedMetadata = options.resolveMetadata({
                        result,
                        error: failure
                    })
                } catch {
                    resolvedMetadata = metadata
                }
            }
            recordSpan({
                metrics: resolvedMetrics,
                metadata: resolvedMetadata,
                startedAt: spanStartedAt,
                completedAt: now(),
                canonicalBytes,
                contextBytes
            })
        }
    }

    async function measureAsync(metrics, metadata, operation, options = {}) {
        if (finalized) fail('dispatcher-performance-finalized')
        if (!Array.isArray(metrics) || metrics.length === 0 ||
            typeof operation !== 'function') {
            fail('dispatcher-performance-span-invalid')
        }
        const spanStartedAt = now()
        const canonicalBytes = options.ledgerRead === true
            ? ledgerBytes({ stateRoot, runId })
            : 0
        const contextBytes = options.context === undefined
            ? 0
            : byteLength(options.context)
        try {
            return await operation()
        } finally {
            recordSpan({
                metrics,
                metadata,
                startedAt: spanStartedAt,
                completedAt: now(),
                canonicalBytes,
                contextBytes
            })
        }
    }

    function setTransition(value) {
        if (!Number.isInteger(value) || value < 0) {
            fail('dispatcher-performance-transition-invalid')
        }
        transition = value
    }

    function recordSlotSnapshot({ reason, capacity, active, available }) {
        if (![capacity, active, available].every((value) =>
            Number.isInteger(value) && value >= 0) ||
            active + available !== capacity) {
            fail('dispatcher-performance-slot-snapshot-invalid')
        }
        slotCapacity = capacity
        sequence += 1
        slotSamples.push(Object.freeze({
            sequence,
            transition,
            reason: requireText(
                reason,
                'dispatcher-performance-slot-reason-required'
            ),
            timestamp: now(),
            capacity,
            active,
            available
        }))
    }

    function recordActorStart({
        dispatchId,
        actionDigest,
        actionType,
        nodeId,
        activeSlots
    }) {
        requireText(dispatchId, 'dispatcher-performance-dispatch-id-required')
        if (dispatches.has(dispatchId)) {
            fail('dispatcher-performance-dispatch-duplicate', { dispatchId })
        }
        const started = now()
        const record = {
            dispatchId,
            actionDigest: requireText(
                actionDigest,
                'dispatcher-performance-action-digest-required'
            ),
            actionType: requireText(
                actionType,
                'dispatcher-performance-action-type-required'
            ),
            nodeId: nodeId ?? null,
            startedAt: started,
            completedAt: null,
            admittedAt: null,
            actorWallDurationMs: null,
            completionToAdmissionMs: null
        }
        dispatches.set(dispatchId, record)
        const completionRecord = unrefilled.shift()
        if (completionRecord) {
            const refill = {
                sourceDispatchId: completionRecord.dispatchId,
                refillDispatchId: dispatchId,
                completedAt: completionRecord.completedAt,
                refilledAt: started,
                durationMs: duration(completionRecord.completedAt, started)
            }
            sequence += 1
            slotRefills.push(Object.freeze({ sequence, transition, ...refill }))
        }
        if (Number.isInteger(activeSlots) && slotCapacity > 0) {
            recordSlotSnapshot({
                reason: 'actor-started',
                capacity: slotCapacity,
                active: activeSlots,
                available: slotCapacity - activeSlots
            })
        }
    }

    function recordActorCompletion(dispatchId, status) {
        const record = dispatches.get(dispatchId)
        if (!record || record.completedAt) {
            fail('dispatcher-performance-completion-invalid', { dispatchId })
        }
        record.completedAt = now()
        record.status = status
        record.actorWallDurationMs = duration(
            record.startedAt,
            record.completedAt
        )
        unrefilled.push(record)
    }

    function recordActorAdmission(dispatchId, activeSlots) {
        const record = dispatches.get(dispatchId)
        if (!record || !record.completedAt || record.admittedAt) {
            fail('dispatcher-performance-admission-invalid', { dispatchId })
        }
        record.admittedAt = now()
        record.completionToAdmissionMs = duration(
            record.completedAt,
            record.admittedAt
        )
        if (Number.isInteger(activeSlots) && slotCapacity > 0) {
            recordSlotSnapshot({
                reason: 'actor-admitted',
                capacity: slotCapacity,
                active: activeSlots,
                available: slotCapacity - activeSlots
            })
        }
    }

    function recordPromptCacheObservation({
        actionDigest,
        actionType,
        nodeId = null,
        role,
        phase,
        cacheIdentity,
        providerMetadata = null
    } = {}) {
        if (finalized) fail('dispatcher-performance-finalized')
        requireText(actionDigest,
            'dispatcher-performance-action-digest-required')
        requireText(actionType,
            'dispatcher-performance-action-type-required')
        requireText(role, 'dispatcher-performance-role-required')
        requireText(phase, 'dispatcher-performance-phase-required')
        const identity = requireObject(
            cacheIdentity,
            'dispatcher-performance-prompt-cache-identity-required'
        )
        if (identity.schema !==
                'issue-orchestration.actor-prompt-cache-identity.v1' ||
            !HASH.test(identity.cacheIdentityDigest ?? '')) {
            fail('dispatcher-performance-prompt-cache-identity-invalid')
        }
        sequence += 1
        promptCacheObservations.push(Object.freeze({
            sequence,
            transition,
            observedAt: now(),
            actionDigest,
            actionType,
            nodeId,
            role,
            phase,
            cacheIdentityDigest: identity.cacheIdentityDigest,
            stablePrefixDigest: identity.stablePrefixDigest,
            suffixDigest: identity.suffixDigest,
            completePromptDigest: identity.completePromptDigest,
            providerMetadata: sanitizeProviderPromptCacheMetadata(
                providerMetadata
            )
        }))
    }

    function registerRecoveredDispatch({
        dispatchId,
        actionDigest,
        actionType,
        nodeId,
        activeSlots
    }) {
        if (dispatches.has(dispatchId)) return
        const observedAt = now()
        dispatches.set(dispatchId, {
            dispatchId,
            actionDigest,
            actionType,
            nodeId: nodeId ?? null,
            startedAt: observedAt,
            recovered: true,
            completedAt: null,
            admittedAt: null,
            actorWallDurationMs: null,
            completionToAdmissionMs: null
        })
        if (Number.isInteger(activeSlots) && slotCapacity > 0) {
            recordSlotSnapshot({
                reason: 'actor-recovered',
                capacity: slotCapacity,
                active: activeSlots,
                available: slotCapacity - activeSlots
            })
        }
    }

    function finalize({ status, transitions, failureCode = null } = {}) {
        if (finalized) fail('dispatcher-performance-finalized')
        finalized = true
        const completedAt = now()
        const actorDispatches = [...dispatches.values()]
            .sort((left, right) =>
                left.dispatchId.localeCompare(right.dispatchId))
            .map((value) => Object.freeze({ ...value }))
        const rootControlPlaneDurationMs = spans.reduce(
            (total, span) => total + span.durationMs,
            0
        )
        const actorWallDurationMs = actorDispatches.reduce(
            (total, dispatch) =>
                total + (dispatch.actorWallDurationMs ?? 0),
            0
        )
        const receipt = canonical({
            schema: SCHEMA,
            status: requireText(
                status,
                'dispatcher-performance-status-required'
            ),
            authority: {
                kind: 'diagnostic-only',
                grants: []
            },
            runId,
            startedAt,
            completedAt,
            totalWallDurationMs: duration(startedAt, completedAt),
            transitions,
            failureCode,
            operationSummary: summary,
            repositoryBaseObservations: [...repositorySummary.values()]
                .sort((left, right) =>
                    left.repository.localeCompare(right.repository)),
            bytes,
            wallTime: {
                rootControlPlaneObservedDurationMs:
                    rootControlPlaneDurationMs,
                actorObservedWallDurationMs: actorWallDurationMs
            },
            spans,
            actorDispatches,
            promptCacheObservations,
            slotSamples,
            slotRefills,
            idleSafeSlotDurationMs: slotRefills.reduce(
                (total, refill) => total + refill.durationMs,
                0
            )
        })
        receipt.receiptDigest = digest(receipt)
        return verifyDispatcherPerformanceReceipt(receipt)
    }

    return Object.freeze({
        measureSync,
        measureAsync,
        setTransition,
        recordSlotSnapshot,
        recordActorStart,
        recordActorCompletion,
        recordActorAdmission,
        registerRecoveredDispatch,
        recordPromptCacheObservation,
        repositoriesForAction,
        finalize
    })
}

export function verifyDispatcherPerformanceReceipt(value) {
    const receipt = requireObject(
        value,
        'dispatcher-performance-receipt-invalid'
    )
    if (receipt.schema !== SCHEMA ||
        receipt.authority?.kind !== 'diagnostic-only' ||
        !Array.isArray(receipt.authority?.grants) ||
        receipt.authority.grants.length !== 0 ||
        !HASH.test(receipt.receiptDigest ?? '')) {
        fail('dispatcher-performance-receipt-invalid')
    }
    const unsigned = structuredClone(receipt)
    delete unsigned.receiptDigest
    if (digest(unsigned) !== receipt.receiptDigest) {
        fail('dispatcher-performance-receipt-digest-mismatch')
    }
    for (const metric of METRICS) {
        const item = receipt.operationSummary?.[metric]
        if (!Number.isInteger(item?.count) || item.count < 0 ||
            !Number.isFinite(item?.durationMs) || item.durationMs < 0) {
            fail('dispatcher-performance-summary-invalid', { metric })
        }
    }
    if (!Array.isArray(receipt.spans) ||
        !Array.isArray(receipt.actorDispatches) ||
        !Array.isArray(receipt.promptCacheObservations) ||
        !Array.isArray(receipt.slotSamples) ||
        !Array.isArray(receipt.slotRefills) ||
        !Array.isArray(receipt.repositoryBaseObservations)) {
        fail('dispatcher-performance-receipt-invalid')
    }
    return Object.freeze(structuredClone(receipt))
}

function offset(origin, value) {
    if (value === null || value === undefined) return value
    return Date.parse(value) - origin
}

export function normalizeDispatcherPerformanceReceipt(value) {
    const receipt = verifyDispatcherPerformanceReceipt(value)
    const origin = Date.parse(receipt.startedAt)
    const normalized = structuredClone(receipt)
    delete normalized.receiptDigest
    normalized.startedAt = 0
    normalized.completedAt = offset(origin, receipt.completedAt)
    normalized.spans = receipt.spans.map((span) => ({
        ...span,
        startedAt: offset(origin, span.startedAt),
        completedAt: offset(origin, span.completedAt)
    }))
    normalized.actorDispatches = receipt.actorDispatches.map((dispatch) => ({
        ...dispatch,
        startedAt: offset(origin, dispatch.startedAt),
        completedAt: offset(origin, dispatch.completedAt),
        admittedAt: offset(origin, dispatch.admittedAt)
    }))
    normalized.promptCacheObservations =
        receipt.promptCacheObservations.map((observation) => ({
            ...observation,
            observedAt: offset(origin, observation.observedAt)
        }))
    normalized.slotSamples = receipt.slotSamples.map((sample) => ({
        ...sample,
        timestamp: offset(origin, sample.timestamp)
    }))
    normalized.slotRefills = receipt.slotRefills.map((refill) => ({
        ...refill,
        completedAt: offset(origin, refill.completedAt),
        refilledAt: offset(origin, refill.refilledAt)
    }))
    normalized.normalizedReceiptDigest = digest(normalized)
    return Object.freeze(canonical(normalized))
}

export const DISPATCHER_PERFORMANCE_RECEIPT_SCHEMA = SCHEMA
export const DISPATCHER_PERFORMANCE_METRICS = METRICS
