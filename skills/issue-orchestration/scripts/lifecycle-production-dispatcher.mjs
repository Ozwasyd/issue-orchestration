import {
    sameValue
} from './runtime-contract-lib.mjs'
import {
    LIFECYCLE_ACTION_TYPES,
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    compileLifecycleRunActionSet,
    lifecycleActionSetCacheStats,
    projectLifecycleRun,
    recordLifecycleCurrentActionResult,
    recordLifecycleDispatchBatchStarted,
    recordLifecycleDispatchedActionResultBatch
} from './lifecycle-run-loop.mjs'
import {
    executeLifecycleScopeRefresh,
    observeLifecycleRepositoryBaseEpoch
} from './lifecycle-live-refresh.mjs'
import {
    executePreWriterLifecycleAction,
    preWriterLifecycleActionTypes
} from './lifecycle-prewriter-executor.mjs'
import {
    executeWriterLifecycleAction,
    writerLifecycleActionTypes
} from './lifecycle-writer-executor.mjs'
import {
    executeLifecycleObserveOnlyAction,
    LIFECYCLE_OBSERVE_ONLY_SUPPORTED_ACTIONS
} from './lifecycle-observe-only-executor.mjs'
import {
    executeLifecycleDeliveryAction,
    lifecycleDeliveryActionTypes
} from './lifecycle-delivery-executor.mjs'
import {
    executeLifecycleCleanupClosureAction,
    lifecycleCleanupClosureActionTypes
} from './lifecycle-cleanup-closure-executor.mjs'
import {
    executeLifecycleTerminalizationAction,
    lifecycleTerminalizationActionTypes
} from './lifecycle-terminalization-executor.mjs'
import {
    executeLifecycleQuiescenceFinalization,
    lifecycleQuiescenceFinalizationActionTypes
} from './lifecycle-quiescence-finalizer.mjs'
import {
    createDispatcherPerformanceCollector
} from './dispatcher-performance-telemetry.mjs'
import {
    verifiedReplayProjectionCacheStats
} from './multi-node-state.mjs'
import {
    compileActorContextBundle,
    createActorContextProgressiveReader
} from './actor-context-envelope.mjs'

const ACTOR_ACTION_TYPES = new Set([
    'request-semantic-proposal',
    'request-test-contract-planning',
    'dispatch-test-contract-writer',
    'dispatch-implementation-writer',
    'dispatch-behavior-verifier',
    'request-ui-adjudication',
    'dispatch-ux-acceptance-verifier',
    'dispatch-documentation-writer'
])
const ROOT_SERIAL_ACTION_TYPES = new Set([
    'refresh-scope',
    ...lifecycleDeliveryActionTypes,
    ...lifecycleCleanupClosureActionTypes,
    ...lifecycleTerminalizationActionTypes,
    ...lifecycleQuiescenceFinalizationActionTypes
])

export class LifecycleProductionDispatcherError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'LifecycleProductionDispatcherError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new LifecycleProductionDispatcherError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function timestamp(clock) {
    const value = clock()
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        fail('dispatcher-clock-invalid')
    }
    return value
}

function performanceConfiguration(value, ledger) {
    if (value === undefined || value === null || value === false) return null
    const configuration = value === true ? {} : object(
        value,
        'dispatcher-performance-configuration-invalid'
    )
    if (configuration.clock !== undefined &&
        typeof configuration.clock !== 'function') {
        fail('dispatcher-performance-clock-invalid')
    }
    if (configuration.onReceipt !== undefined &&
        typeof configuration.onReceipt !== 'function') {
        fail('dispatcher-performance-sink-invalid')
    }
    return Object.freeze({
        collector: createDispatcherPerformanceCollector({
            runId: ledger.runId,
            stateRoot: ledger.stateRoot,
            clock: configuration.clock
        }),
        onReceipt: configuration.onReceipt ?? null
    })
}

function replayStats(ledger) {
    return verifiedReplayProjectionCacheStats({
        stateRoot: ledger.stateRoot,
        runId: ledger.runId
    })
}

function replayMetricOptions(ledger, before, always = []) {
    return {
        resolveMetrics() {
            const after = replayStats(ledger)
            const metrics = [...always]
            if (after.controlLedgerReplays > before.controlLedgerReplays ||
                after.nodeLedgerReplays > before.nodeLedgerReplays) {
                metrics.push('canonicalReplay')
            }
            if (after.aggregateProjectionRebuilds >
                before.aggregateProjectionRebuilds) {
                metrics.push('aggregateProjectionRebuild')
            }
            return metrics
        },
        resolveCanonicalBytes() {
            const after = replayStats(ledger)
            return Math.max(
                0,
                after.canonicalLedgerBytesRead -
                    before.canonicalLedgerBytesRead
            )
        }
    }
}

function measuredProjection(telemetry, ledger, startup, boundary) {
    if (!telemetry) return projectLifecycleRun(ledger, { startup })
    const before = replayStats(ledger)
    return telemetry.measureSync(
        ['canonicalReplay', 'aggregateProjectionRebuild'],
        { boundary },
        () => projectLifecycleRun(ledger, { startup }),
        replayMetricOptions(ledger, before)
    )
}

function actionSetStats(ledger) {
    return lifecycleActionSetCacheStats({
        stateRoot: ledger.stateRoot,
        runId: ledger.runId
    })
}

function measuredActionSet(telemetry, ledger, startup, boundary) {
    if (!telemetry) return compileLifecycleRunActionSet(ledger, { startup })
    const beforeReplay = replayStats(ledger)
    const beforeActionSet = actionSetStats(ledger)
    const replayOptions = replayMetricOptions(ledger, beforeReplay)
    return telemetry.measureSync(
        [
            'canonicalReplay',
            'aggregateProjectionRebuild',
            'actionSetCompilation'
        ],
        { boundary },
        () => compileLifecycleRunActionSet(ledger, { startup }),
        {
            resolveMetrics() {
                const metrics = replayOptions.resolveMetrics()
                const afterActionSet = actionSetStats(ledger)
                if (afterActionSet.compilerInvocations >
                    beforeActionSet.compilerInvocations) {
                    metrics.push('actionSetCompilation')
                }
                return metrics
            },
            resolveCanonicalBytes: replayOptions.resolveCanonicalBytes
        }
    )
}

function direct(owner, executionClass, execute) {
    return Object.freeze({ owner, executionClass, execute })
}

const mapping = {
    'refresh-scope': direct(
        'scope-refresh',
        'root',
        executeLifecycleScopeRefresh
    ),
    'request-semantic-proposal': direct(
        'pre-writer',
        'actor',
        executePreWriterLifecycleAction
    ),
    'compile-acceptance-contract': direct(
        'pre-writer',
        'machine',
        executePreWriterLifecycleAction
    ),
    'request-test-contract-planning': direct(
        'pre-writer',
        'actor',
        executePreWriterLifecycleAction
    ),
    'dispatch-test-contract-writer': direct(
        'writer',
        'actor',
        executeWriterLifecycleAction
    ),
    'dispatch-implementation-writer': direct(
        'writer',
        'actor',
        executeWriterLifecycleAction
    ),
    'dispatch-behavior-verifier': direct(
        'observe-only',
        'actor',
        executeLifecycleObserveOnlyAction
    ),
    'request-ui-adjudication': direct(
        'observe-only',
        'actor',
        executeLifecycleObserveOnlyAction
    ),
    'dispatch-ux-acceptance-verifier': direct(
        'observe-only',
        'actor',
        executeLifecycleObserveOnlyAction
    ),
    'dispatch-documentation-writer': direct(
        'writer',
        'actor',
        executeWriterLifecycleAction
    ),
    'deliver-acceptance-group': direct(
        'delivery',
        'root',
        executeLifecycleDeliveryAction
    ),
    'cleanup-node-resources': direct(
        'cleanup-closure',
        'root',
        executeLifecycleCleanupClosureAction
    ),
    'terminalize-node': direct(
        'terminalization',
        'root',
        executeLifecycleTerminalizationAction
    ),
    idle: direct(
        'quiescence-finalization',
        'root',
        executeLifecycleQuiescenceFinalization
    )
}

function assertOwnerCoverage() {
    const expected = [...LIFECYCLE_ACTION_TYPES].sort()
    const actual = Object.keys(mapping).sort()
    if (!sameValue(expected, actual)) {
        fail('dispatcher-action-map-incomplete', { expected, actual })
    }
    const declared = new Set([
        ...preWriterLifecycleActionTypes,
        ...writerLifecycleActionTypes,
        ...LIFECYCLE_OBSERVE_ONLY_SUPPORTED_ACTIONS,
        ...lifecycleDeliveryActionTypes,
        ...lifecycleCleanupClosureActionTypes,
        ...lifecycleTerminalizationActionTypes,
        ...lifecycleQuiescenceFinalizationActionTypes,
        'refresh-scope'
    ])
    if (!sameValue([...declared].sort(), expected)) {
        fail('dispatcher-owner-declarations-incomplete')
    }
    for (const type of ACTOR_ACTION_TYPES) {
        if (mapping[type]?.executionClass !== 'actor') {
            fail('dispatcher-actor-classification-invalid', { type })
        }
    }
}
assertOwnerCoverage()

export const LIFECYCLE_PRODUCTION_DISPATCH_MAP = Object.freeze(
    Object.fromEntries(Object.entries(mapping).map(([type, value]) => [
        type,
        Object.freeze({
            owner: value.owner,
            executionClass: value.executionClass
        })
    ]))
)

function provider(value) {
    object(value, 'dispatcher-context-provider-required')
    if (typeof value.prepare !== 'function' ||
        typeof value.observeRemoteIssues !== 'function') {
        fail('dispatcher-context-provider-invalid')
    }
    return value
}

function actionOwner(action) {
    const entry = mapping[action?.type]
    if (!entry) {
        fail('dispatcher-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    return entry
}

function canonicalContext({
    prepared,
    ledger,
    actionSet,
    action,
    startup,
    createdAt,
    actorContextEnvelope,
    actorContextProgressiveReader,
    actorPromptOptions,
    recordActorPromptCacheMetadata
}) {
    const context = object(
        prepared.context,
        'dispatcher-owner-context-required'
    )
    return Object.freeze({
        ...context,
        ledger,
        actionSet,
        action,
        startup,
        createdAt,
        ...(actorContextEnvelope ? { actorContextEnvelope } : {}),
        ...(actorContextProgressiveReader ? {
            actorContextProgressiveReader
        } : {}),
        ...(actorPromptOptions ? { actorPromptOptions } : {}),
        ...(recordActorPromptCacheMetadata ? {
            recordActorPromptCacheMetadata
        } : {})
    })
}

function actorMetadata({ prepared, entry, action }) {
    const dispatch = object(
        prepared.dispatch,
        'dispatcher-dispatch-preparation-required'
    )
    return Object.freeze({
        actionDigest: action.actionDigest,
        nodeId: action.nodeId,
        owner: entry.owner,
        attemptId: text(
            dispatch.attemptId,
            'dispatcher-attempt-id-required'
        ),
        slotId: text(dispatch.slotId, 'dispatcher-slot-id-required'),
        runtimeBindingDigest: text(
            dispatch.runtimeBindingDigest,
            'dispatcher-runtime-binding-required'
        ),
        leaseDigest: text(
            dispatch.leaseDigest,
            'dispatcher-lease-required'
        ),
        resourceDigest: text(
            dispatch.resourceDigest,
            'dispatcher-resource-required'
        )
    })
}

function normalizeActorResult(entry, output) {
    const value = entry.owner === 'observe-only'
        ? output?.result
        : output
    return object(value, 'dispatcher-actor-result-invalid')
}

function normalizeLedger(entry, output) {
    if (entry.owner === 'scope-refresh') return output
    return output?.ledger ?? output
}

async function prepareAction({
    contextProvider,
    entry,
    action,
    actionSet,
    ledger,
    startup,
    createdAt,
    telemetry
}) {
    const projection = measuredProjection(
        telemetry,
        ledger,
        startup,
        'context-preparation-projection'
    )
    const request = Object.freeze({
        schema: 'issue-orchestration.dispatch-context-request.v1',
        owner: entry.owner,
        executionClass: entry.executionClass,
        action: structuredClone(action),
        actionSet: structuredClone(actionSet),
        ledger,
        projection,
        startup,
        createdAt
    })
    const prepare = () => contextProvider.prepare(request)
    const preparedValue = telemetry
        ? await telemetry.measureAsync(
            ['contextPreparation'],
            {
                boundary: 'context-provider-prepare',
                actionDigest: action.actionDigest,
                actionType: action.type,
                nodeId: action.nodeId
            },
            prepare,
            { context: request }
        )
        : await prepare()
    const prepared = object(
        preparedValue,
        'dispatcher-context-preparation-invalid'
    )
    const actorContextBundle = entry.executionClass === 'actor'
        ? compileActorContextBundle({
            action,
            actionSet,
            projection,
            preparedContext: prepared.context,
            actorContext: prepared.actorContext ?? {},
            repositoryPath: prepared.context?.repositoryPath ?? null
        })
        : null
    const actorContextEnvelope = actorContextBundle?.envelope ?? null
    const actorContextProgressiveReader = actorContextBundle
        ? createActorContextProgressiveReader(actorContextBundle)
        : null
    const actorPromptOptions = actorContextEnvelope
        ? Object.freeze({
            tokenizerIdentity:
                prepared.actorContext?.tokenizerIdentity ?? null,
            runtimeIdentity:
                prepared.actorContext?.runtimeIdentity ?? null
        })
        : null
    const recordActorPromptCacheMetadata = actorContextEnvelope && telemetry
        ? ({ promptBundle, providerMetadata }) =>
            telemetry.recordPromptCacheObservation({
                actionDigest: action.actionDigest,
                actionType: action.type,
                nodeId: action.nodeId ?? null,
                role: promptBundle.stablePrefix.role,
                phase: promptBundle.stablePrefix.phase,
                cacheIdentity: promptBundle.cacheIdentity,
                providerMetadata
            })
        : null
    return {
        context: canonicalContext({
            prepared,
            ledger,
            actionSet,
            action,
            startup,
            createdAt,
            actorContextEnvelope,
            actorContextProgressiveReader,
            actorPromptOptions,
            recordActorPromptCacheMetadata
        }),
        metadata: entry.executionClass === 'actor'
            ? actorMetadata({ prepared, entry, action })
            : null
    }
}

function observedRepositories(telemetry, actions) {
    if (!telemetry) return []
    return [...new Set(actions.flatMap((action) =>
        telemetry.repositoriesForAction(action)))].sort()
}

async function observeBaseEpoch({
    ledger,
    actionSet,
    actions = null,
    dispatches = null,
    phase,
    startup,
    observedAt,
    telemetry
}) {
    const epochActions = actions ?? dispatches.map(({ action }) => action)
    const observe = () => observeLifecycleRepositoryBaseEpoch({
        ledger,
        actionSet,
        actions,
        dispatches,
        phase,
        startup,
        observedAt
    })
    const metadata = {
        boundary: phase === 'pre-dispatch'
            ? 'repository-base-pre-wave'
            : 'repository-base-post-wave',
        actionDigests: epochActions.map(({ actionDigest }) =>
            actionDigest).sort(),
        dispatchIds: dispatches?.map(({ dispatchId }) =>
            dispatchId).sort() ?? [],
        repositories: observedRepositories(telemetry, epochActions)
    }
    const result = telemetry
        ? await telemetry.measureAsync(
            ['repositoryBaseObservation'],
            metadata,
            observe
        )
        : await observe()
    if (result.receipt.status === 'rebound') {
        return {
            rebound: true,
            stale: false,
            receipt: result.receipt,
            ledger: result.ledger
        }
    }
    if (!['current', 'stale'].includes(result.receipt.status)) {
        fail('dispatcher-base-observation-invalid')
    }
    return {
        rebound: false,
        stale: result.receipt.status === 'stale',
        receipt: result.receipt,
        ledger
    }
}

function createSettlementQueue() {
    const ready = []
    let waiter = null
    return Object.freeze({
        push(value) {
            ready.push(value)
            if (waiter) {
                const resolve = waiter
                waiter = null
                resolve()
            }
        },
        async waitAndDrain() {
            if (ready.length === 0) {
                await new Promise((resolve) => {
                    if (waiter) fail('dispatcher-settlement-waiter-duplicate')
                    waiter = resolve
                })
            }
            // Let every already-settled promise reaction publish its result.
            await Promise.resolve()
            return ready.splice(0)
        }
    })
}

function completion(
    promise,
    dispatchId,
    entry,
    settlementQueue,
    telemetry = null
) {
    return Promise.resolve(promise).then(
        (output) => {
            let settled
            try {
                settled = {
                    status: 'fulfilled',
                    dispatchId,
                    result: normalizeActorResult(entry, output)
                }
                telemetry?.recordActorCompletion(dispatchId, 'fulfilled')
            } catch (error) {
                settled = {
                    status: 'malformed',
                    dispatchId,
                    error
                }
                telemetry?.recordActorCompletion(dispatchId, 'malformed')
            }
            settlementQueue.push(settled)
            return settled
        },
        (error) => {
            const settled = {
                status: 'rejected',
                dispatchId,
                error
            }
            telemetry?.recordActorCompletion(dispatchId, 'rejected')
            settlementQueue.push(settled)
            return settled
        }
    )
}

async function startActorWave({
    ledger,
    actionSet,
    actions,
    contextProvider,
    startup,
    clock,
    running,
    settlementQueue,
    telemetry
}) {
    let currentLedger = ledger
    const observed = await observeBaseEpoch({
        ledger: currentLedger,
        actionSet,
        actions,
        phase: 'pre-dispatch',
        startup,
        observedAt: timestamp(clock),
        telemetry
    })
    if (observed.rebound) {
        return { rebound: true, ledger: observed.ledger }
    }
    const prepared = []
    const createdAt = timestamp(clock)
    for (const action of actions) {
        const entry = actionOwner(action)
        const value = await prepareAction({
            contextProvider,
            entry,
            action,
            actionSet,
            ledger: currentLedger,
            startup,
            createdAt,
            telemetry
        })
        prepared.push({ action, entry, ...value })
    }
    const recordStarted = () => recordLifecycleDispatchBatchStarted({
        ledger: currentLedger,
        actionSet,
        dispatches: prepared.map(({ metadata }) => metadata),
        createdAt,
        startup
    })
    const started = telemetry
        ? telemetry.measureSync(
            ['canonicalReplay', 'aggregateProjectionRebuild'],
            { boundary: 'dispatch-batch-start-admission' },
            recordStarted,
            { ledgerRead: true }
        )
        : recordStarted()
    currentLedger = started.ledger
    const receiptByAction = new Map(started.dispatches.map((receipt) => [
        receipt.actionDigest,
        receipt
    ]))
    for (const item of prepared) {
        const receipt = receiptByAction.get(item.action.actionDigest)
        telemetry?.recordActorStart({
            dispatchId: receipt.dispatchId,
            actionDigest: item.action.actionDigest,
            actionType: item.action.type,
            nodeId: item.action.nodeId,
            activeSlots: running.size + 1
        })
        const promise = completion(
            Promise.resolve().then(() => item.entry.execute(item.context)),
            receipt.dispatchId,
            item.entry,
            settlementQueue,
            telemetry
        )
        running.set(receipt.dispatchId, {
            dispatch: receipt,
            promise
        })
    }
    return { rebound: false, ledger: currentLedger }
}

async function recoverRunning({
    ledger,
    contextProvider,
    startup,
    clock,
    running,
    settlementQueue,
    telemetry
}) {
    const projection = measuredProjection(
        telemetry,
        ledger,
        startup,
        'recover-active-dispatches'
    )
    const active = Object.values(
        projection.aggregateProjection.activeDispatches ?? {}
    )
    const capacity = projection.aggregateProjection.slots?.capacity ?? 0
    telemetry?.recordSlotSnapshot({
        reason: 'recovery-observation',
        capacity,
        active: active.length,
        available: Math.max(0, capacity - active.length)
    })
    if (active.length === 0) return
    if (typeof contextProvider.recoverActiveDispatch !== 'function') {
        fail('dispatcher-active-recovery-required', {
            dispatchIds: active.map(({ dispatchId }) => dispatchId).sort()
        })
    }
    for (const dispatch of active) {
        const entry = actionOwner(dispatch.action)
        const recovered = object(
            await contextProvider.recoverActiveDispatch(Object.freeze({
                schema: 'issue-orchestration.dispatch-recovery-request.v1',
                dispatch: structuredClone(dispatch),
                ledger,
                projection,
                startup,
                observedAt: timestamp(clock)
            })),
            'dispatcher-active-recovery-invalid'
        )
        if (!recovered.completion ||
            typeof recovered.completion.then !== 'function') {
            fail('dispatcher-active-recovery-unobservable', {
                dispatchId: dispatch.dispatchId
            })
        }
        telemetry?.registerRecoveredDispatch({
            dispatchId: dispatch.dispatchId,
            actionDigest: dispatch.actionDigest,
            actionType: dispatch.action.type,
            nodeId: dispatch.nodeId,
            activeSlots: active.length
        })
        running.set(dispatch.dispatchId, {
            dispatch,
            promise: completion(
                recovered.completion,
                dispatch.dispatchId,
                entry,
                settlementQueue,
                telemetry
            )
        })
    }
}

async function settleReadyBatch({
    running,
    settlementQueue,
    ledger,
    startup,
    clock,
    telemetry
}) {
    const drained = await settlementQueue.waitAndDrain()
    const byDispatchId = new Map()
    for (const settled of drained) {
        if (running.has(settled.dispatchId)) {
            byDispatchId.set(settled.dispatchId, settled)
        }
    }
    const ready = [...byDispatchId.values()].sort((left, right) =>
        left.dispatchId.localeCompare(right.dispatchId))
    if (ready.length === 0) fail('dispatcher-settlement-not-active')

    const fulfilled = ready.filter(({ status }) => status === 'fulfilled')
    const malformed = ready.filter(({ status }) => status === 'malformed')
    const rejected = ready.filter(({ status }) => status === 'rejected')
    const entries = malformed.map((settled) => ({
        dispatchId: settled.dispatchId,
        exclusionCode: settled.error?.code ??
            'dispatcher-actor-result-malformed'
    }))

    if (fulfilled.length > 0) {
        const dispatches = fulfilled.map(({ dispatchId }) =>
            running.get(dispatchId).dispatch)
        const baseObservation = await observeBaseEpoch({
            ledger,
            dispatches,
            phase: 'post-admission',
            startup,
            observedAt: timestamp(clock),
            telemetry
        })
        const driftedRepositories = new Set(
            baseObservation.receipt.driftedRepositories ?? []
        )
        for (const settled of fulfilled) {
            const active = running.get(settled.dispatchId)
            const repository = active.dispatch.action.bindings.repository
            if (baseObservation.stale &&
                driftedRepositories.has(repository)) {
                entries.push({
                    dispatchId: settled.dispatchId,
                    exclusionCode: 'dispatcher-active-result-base-stale',
                    resultDigest: settled.result?.resultDigest ?? null
                })
            } else {
                entries.push({
                    dispatchId: settled.dispatchId,
                    result: settled.result
                })
            }
        }
    }

    let recorded = null
    if (entries.length > 0) {
        const recordBatch = () =>
            recordLifecycleDispatchedActionResultBatch({
                ledger,
                entries,
                createdAt: timestamp(clock),
                startup
            })
        recorded = telemetry
            ? telemetry.measureSync(
                [
                    'canonicalReplay',
                    'aggregateProjectionRebuild',
                    'actorResultAdmission'
                ],
                {
                    boundary: 'actor-result-batch-admission',
                    dispatchIds: entries.map(({ dispatchId }) =>
                        dispatchId).sort(),
                    readyCount: ready.length
                },
                recordBatch,
                { ledgerRead: true }
            )
            : recordBatch()
        for (const item of [
            ...recorded.admitted,
            ...recorded.excluded
        ]) {
            running.delete(item.dispatchId)
            telemetry?.recordActorAdmission(item.dispatchId, running.size)
        }
    }

    if (rejected.length > 0) {
        const first = rejected[0]
        fail('dispatcher-executor-failed', {
            dispatchId: first.dispatchId,
            cause: first.error?.code ?? first.error?.message ??
                'unknown-executor-failure',
            admittedDispatchIds: recorded?.admitted.map(
                ({ dispatchId }) => dispatchId
            ) ?? [],
            excludedDispatchIds: recorded?.excluded.map(
                ({ dispatchId }) => dispatchId
            ) ?? []
        })
    }
    return recorded?.ledger ?? ledger
}

async function executeImmediate({
    ledger,
    actionSet,
    action,
    contextProvider,
    startup,
    clock,
    telemetry
}) {
    const entry = actionOwner(action)
    const createdAt = timestamp(clock)
    if (!['refresh-scope', 'idle'].includes(action.type)) {
        const observed = await observeBaseEpoch({
            ledger,
            actionSet,
            actions: [action],
            phase: 'pre-dispatch',
            startup,
            observedAt: createdAt,
            telemetry
        })
        if (observed.rebound) return observed.ledger
    }
    const prepared = await prepareAction({
        contextProvider,
        entry,
        action,
        actionSet,
        ledger,
        startup,
        createdAt,
        telemetry
    })
    const execute = () => entry.execute(prepared.context)
    const output = entry.executionClass === 'machine' && telemetry
        ? await telemetry.measureAsync(
            ['machineActionExecution'],
            {
                boundary: 'machine-action-execution',
                actionDigest: action.actionDigest,
                actionType: action.type,
                nodeId: action.nodeId
            },
            execute
        )
        : await execute()
    if (entry.executionClass === 'machine') {
        const record = () => recordLifecycleCurrentActionResult({
            ledger,
            actionSet,
            actionDigest: action.actionDigest,
            result: normalizeActorResult(entry, output),
            createdAt,
            startup
        })
        const recorded = telemetry
            ? telemetry.measureSync(
                ['canonicalReplay', 'aggregateProjectionRebuild'],
                {
                    boundary: 'machine-result-admission',
                    actionDigest: action.actionDigest,
                    actionType: action.type,
                    nodeId: action.nodeId
                },
                record,
                { ledgerRead: true }
            )
            : record()
        return recorded.ledger
    }
    return normalizeLedger(entry, output)
}

export async function runLifecycleProductionDispatcher({
    ledger,
    startup,
    contextProvider: suppliedProvider,
    clock = () => new Date().toISOString(),
    maxTransitions = 10_000,
    performanceTelemetry = null
} = {}) {
    let currentLedger = object(ledger, 'dispatcher-ledger-required')
    const contextProvider = provider(suppliedProvider)
    if (!Number.isInteger(maxTransitions) || maxTransitions < 1) {
        fail('dispatcher-transition-limit-invalid')
    }
    const performance = performanceConfiguration(
        performanceTelemetry,
        currentLedger
    )
    const telemetry = performance?.collector ?? null
    let performanceReceipt = null
    let transitions = 0

    function finalizePerformance(status, failureCode = null) {
        if (!telemetry || performanceReceipt) return performanceReceipt
        performanceReceipt = telemetry.finalize({
            status,
            transitions,
            failureCode
        })
        if (performance?.onReceipt) {
            try {
                performance.onReceipt(structuredClone(performanceReceipt))
            } catch {
                // A diagnostic sink cannot change lifecycle authority or state.
            }
        }
        return performanceReceipt
    }

    const running = new Map()
    const settlementQueue = createSettlementQueue()
    try {
        await recoverRunning({
            ledger: currentLedger,
            contextProvider,
            startup,
            clock,
            running,
            settlementQueue,
            telemetry
        })
        while (transitions < maxTransitions) {
            telemetry?.setTransition(transitions)
            const projection = measuredProjection(
                telemetry,
                currentLedger,
                startup,
                'dispatcher-transition-projection'
            )
            const slots = projection.aggregateProjection.slots ?? {
                capacity: 0,
                active: []
            }
            telemetry?.recordSlotSnapshot({
                reason: 'transition-projection',
                capacity: slots.capacity,
                active: slots.active.length,
                available: Math.max(
                    0,
                    slots.capacity - slots.active.length
                )
            })
            if (projection.aggregateProjection.terminal) {
                if (running.size > 0) {
                    fail('dispatcher-terminal-with-active-dispatch')
                }
                const receipt = finalizePerformance('terminalized')
                return Object.freeze({
                    status: 'terminalized',
                    ledger: currentLedger,
                    terminal: structuredClone(
                        projection.aggregateProjection.terminal
                    ),
                    transitions,
                    ...(receipt ? { performanceReceipt: receipt } : {})
                })
            }
            const beforeRefreshDigest =
                projection.aggregateProjection.aggregateProjectionDigest
            const refresh = () => executeLifecycleScopeRefresh({
                ledger: currentLedger,
                observeRemoteIssues: contextProvider.observeRemoteIssues,
                createdAt: timestamp(clock),
                startup
            })
            currentLedger = telemetry
                ? telemetry.measureSync(
                    ['remoteScopeObservation'],
                    {
                        boundary: 'remote-scope-observation',
                        transition: transitions
                    },
                    refresh
                )
                : refresh()
            const afterRefresh = measuredProjection(
                telemetry,
                currentLedger,
                startup,
                'post-scope-refresh-projection'
            )
            if (afterRefresh.aggregateProjection.aggregateProjectionDigest !==
                beforeRefreshDigest) {
                transitions += 1
                continue
            }
            const actionSet = measuredActionSet(
                telemetry,
                currentLedger,
                startup,
                'dispatcher-action-set-compilation'
            )
            validateLifecycleActionSet(actionSet)
            const rootActions = actionSet.actions.filter(({ type }) =>
                ROOT_SERIAL_ACTION_TYPES.has(type))
            const actorActions = actionSet.actions.filter(({ type }) =>
                ACTOR_ACTION_TYPES.has(type))
            const machineActions = actionSet.actions.filter(({ type }) =>
                actionOwner({ type }).executionClass === 'machine')

            if (running.size > 0) {
                if (rootActions.length === 0 && actorActions.length > 0) {
                    const started = await startActorWave({
                        ledger: currentLedger,
                        actionSet,
                        actions: actorActions,
                        contextProvider,
                        startup,
                        clock,
                        running,
                        settlementQueue,
                        telemetry
                    })
                    currentLedger = started.ledger
                    transitions += 1
                    if (started.rebound) continue
                }
                currentLedger = await settleReadyBatch({
                    running,
                    settlementQueue,
                    ledger: currentLedger,
                    startup,
                    clock,
                    telemetry
                })
                transitions += 1
                continue
            }

            if (rootActions.length > 0) {
                const action = rootActions[0]
                currentLedger = await executeImmediate({
                    ledger: currentLedger,
                    actionSet,
                    action,
                    contextProvider,
                    startup,
                    clock,
                    telemetry
                })
                transitions += 1
                continue
            }
            if (machineActions.length > 0) {
                const action = machineActions[0]
                currentLedger = await executeImmediate({
                    ledger: currentLedger,
                    actionSet,
                    action,
                    contextProvider,
                    startup,
                    clock,
                    telemetry
                })
                transitions += 1
                continue
            }
            if (actorActions.length > 0) {
                const started = await startActorWave({
                    ledger: currentLedger,
                    actionSet,
                    actions: actorActions,
                    contextProvider,
                    startup,
                    clock,
                    running,
                    settlementQueue,
                    telemetry
                })
                currentLedger = started.ledger
                transitions += 1
                continue
            }
            fail('dispatcher-action-set-unexecutable', {
                actionTypes: actionSet.actions.map(({ type }) => type)
            })
        }
        fail('dispatcher-transition-limit-exceeded', {
            maxTransitions,
            activeDispatchIds: [...running.keys()].sort()
        })
    } catch (error) {
        const receipt = finalizePerformance(
            'failed',
            error?.code ?? error?.message ?? 'dispatcher-failed'
        )
        if (receipt && error && typeof error === 'object') {
            Object.defineProperty(error, 'performanceReceipt', {
                value: receipt,
                enumerable: false,
                configurable: true
            })
        }
        throw error
    }
}
