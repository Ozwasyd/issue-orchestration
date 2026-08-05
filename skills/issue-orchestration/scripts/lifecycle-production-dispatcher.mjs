import {
    sameValue
} from './runtime-contract-lib.mjs'
import {
    LIFECYCLE_ACTION_TYPES,
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    compileLifecycleRunActionSet,
    projectLifecycleRun,
    recordLifecycleCurrentActionResult,
    recordLifecycleDispatchBatchStarted,
    recordLifecycleDispatchedActionResult
} from './lifecycle-run-loop.mjs'
import {
    executeLifecycleScopeRefresh,
    observeLifecycleRepositoryBaseBeforeAction,
    observeLifecycleRepositoryBaseForActiveAction
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
    createdAt
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
        createdAt
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
    createdAt
}) {
    const projection = projectLifecycleRun(ledger, { startup })
    const prepared = object(await contextProvider.prepare(Object.freeze({
        schema: 'issue-orchestration.dispatch-context-request.v1',
        owner: entry.owner,
        executionClass: entry.executionClass,
        action: structuredClone(action),
        actionSet: structuredClone(actionSet),
        ledger,
        projection,
        startup,
        createdAt
    })), 'dispatcher-context-preparation-invalid')
    return {
        context: canonicalContext({
            prepared,
            ledger,
            actionSet,
            action,
            startup,
            createdAt
        }),
        metadata: entry.executionClass === 'actor'
            ? actorMetadata({ prepared, entry, action })
            : null
    }
}

async function observeBases({ ledger, actionSet, action, startup, createdAt }) {
    const result = observeLifecycleRepositoryBaseBeforeAction({
        ledger,
        actionSet,
        actionDigest: action.actionDigest,
        startup,
        createdAt
    })
    if (result.status === 'rebound') {
        return { rebound: true, ledger: result.ledger }
    }
    if (result.status !== 'current') {
        fail('dispatcher-base-observation-invalid')
    }
    return { rebound: false, ledger }
}

function completion(promise, dispatchId, entry) {
    return Promise.resolve(promise).then(
        (output) => ({
            status: 'fulfilled',
            dispatchId,
            result: normalizeActorResult(entry, output)
        }),
        (error) => ({
            status: 'rejected',
            dispatchId,
            error
        })
    )
}

async function startActorWave({
    ledger,
    actionSet,
    actions,
    contextProvider,
    startup,
    clock,
    running
}) {
    let currentLedger = ledger
    for (const action of actions) {
        const observed = await observeBases({
            ledger: currentLedger,
            actionSet,
            action,
            startup,
            createdAt: timestamp(clock)
        })
        if (observed.rebound) {
            return { rebound: true, ledger: observed.ledger }
        }
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
            createdAt
        })
        prepared.push({ action, entry, ...value })
    }
    const started = recordLifecycleDispatchBatchStarted({
        ledger: currentLedger,
        actionSet,
        dispatches: prepared.map(({ metadata }) => metadata),
        createdAt,
        startup
    })
    currentLedger = started.ledger
    const receiptByAction = new Map(started.dispatches.map((receipt) => [
        receipt.actionDigest,
        receipt
    ]))
    for (const item of prepared) {
        const receipt = receiptByAction.get(item.action.actionDigest)
        const promise = completion(
            Promise.resolve().then(() => item.entry.execute(item.context)),
            receipt.dispatchId,
            item.entry
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
    running
}) {
    const projection = projectLifecycleRun(ledger, { startup })
    const active = Object.values(
        projection.aggregateProjection.activeDispatches ?? {}
    )
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
        running.set(dispatch.dispatchId, {
            dispatch,
            promise: completion(
                recovered.completion,
                dispatch.dispatchId,
                entry
            )
        })
    }
}

async function settleFirst({ running, ledger, startup, clock }) {
    const settled = await Promise.race(
        [...running.values()].map(({ promise }) => promise)
    )
    const active = running.get(settled.dispatchId)
    if (!active) fail('dispatcher-settlement-not-active')
    if (settled.status === 'rejected') {
        fail('dispatcher-executor-failed', {
            dispatchId: settled.dispatchId,
            cause: settled.error?.code ?? settled.error?.message ??
                'unknown-executor-failure'
        })
    }
    const baseObservation =
        observeLifecycleRepositoryBaseForActiveAction({
            ledger,
            action: active.dispatch.action,
            startup
        })
    if (baseObservation.status !== 'current') {
        fail('dispatcher-active-result-base-stale', {
            dispatchId: settled.dispatchId,
            repository: baseObservation.repository,
            expectedBaseSha: baseObservation.expectedBaseSha,
            currentBaseSha: baseObservation.currentBaseSha
        })
    }
    const recorded = recordLifecycleDispatchedActionResult({
        ledger,
        dispatchId: settled.dispatchId,
        result: settled.result,
        createdAt: timestamp(clock),
        startup
    })
    running.delete(settled.dispatchId)
    return recorded.ledger
}

async function executeImmediate({
    ledger,
    actionSet,
    action,
    contextProvider,
    startup,
    clock
}) {
    const entry = actionOwner(action)
    const createdAt = timestamp(clock)
    if (!['refresh-scope', 'idle'].includes(action.type)) {
        const observed = await observeBases({
            ledger,
            actionSet,
            action,
            startup,
            createdAt
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
        createdAt
    })
    const output = await entry.execute(prepared.context)
    if (entry.executionClass === 'machine') {
        return recordLifecycleCurrentActionResult({
            ledger,
            actionSet,
            actionDigest: action.actionDigest,
            result: normalizeActorResult(entry, output),
            createdAt,
            startup
        }).ledger
    }
    return normalizeLedger(entry, output)
}

export async function runLifecycleProductionDispatcher({
    ledger,
    startup,
    contextProvider: suppliedProvider,
    clock = () => new Date().toISOString(),
    maxTransitions = 10_000
} = {}) {
    let currentLedger = object(ledger, 'dispatcher-ledger-required')
    const contextProvider = provider(suppliedProvider)
    if (!Number.isInteger(maxTransitions) || maxTransitions < 1) {
        fail('dispatcher-transition-limit-invalid')
    }
    const running = new Map()
    await recoverRunning({
        ledger: currentLedger,
        contextProvider,
        startup,
        clock,
        running
    })
    let transitions = 0
    while (transitions < maxTransitions) {
        const projection = projectLifecycleRun(currentLedger, { startup })
        if (projection.aggregateProjection.terminal) {
            if (running.size > 0) {
                fail('dispatcher-terminal-with-active-dispatch')
            }
            return Object.freeze({
                status: 'terminalized',
                ledger: currentLedger,
                terminal: structuredClone(
                    projection.aggregateProjection.terminal
                ),
                transitions
            })
        }
        const beforeRefreshDigest =
            projection.aggregateProjection.aggregateProjectionDigest
        currentLedger = executeLifecycleScopeRefresh({
            ledger: currentLedger,
            observeRemoteIssues: contextProvider.observeRemoteIssues,
            createdAt: timestamp(clock),
            startup
        })
        const afterRefresh = projectLifecycleRun(currentLedger, { startup })
        if (afterRefresh.aggregateProjection.aggregateProjectionDigest !==
            beforeRefreshDigest) {
            transitions += 1
            continue
        }
        const actionSet = compileLifecycleRunActionSet(currentLedger, {
            startup
        })
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
                    running
                })
                currentLedger = started.ledger
                transitions += 1
                if (started.rebound) continue
            }
            currentLedger = await settleFirst({
                running,
                ledger: currentLedger,
                startup,
                clock
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
                clock
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
                clock
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
                running
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
}
