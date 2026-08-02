import {
    assertArray,
    assertDigest,
    assertText,
    digest,
    fail,
    seal
} from './runtime-contract-lib.mjs'

const TERMINAL_STATES = new Set([
    'completed',
    'checkpoint-received',
    'terminal-failure-observed'
])

function validateInput(input) {
    if (!input?.runtimeCapabilities?.incrementalTrace
        || !input?.runtimeCapabilities?.cancellation
        || typeof input.cancel !== 'function'
        || typeof input.persist !== 'function') {
        fail('watchdog-capability-unavailable')
    }

    const binding = input.binding ?? {}
    for (const field of [
        'requestId',
        'threadId',
        'rolloutId',
        'attemptId',
        'selectedProfile',
        'firstRequiredAction'
    ]) assertText(binding[field], `watchdog-binding-${field}`)
    for (const field of [
        'planDigest',
        'sliceDigest',
        'routeDecisionDigest',
        'leaseDigest'
    ]) assertDigest(binding[field], `watchdog-binding-${field}`)
    assertArray(binding.requiredCommands, 'watchdog-required-commands')
    if (!binding.selectedProfile.startsWith('terra-')
        && !binding.selectedProfile.startsWith('sol-')) {
        fail('watchdog-profile-forbidden')
    }

    const budgets = input.budgets ?? {}
    for (const field of [
        'maxReadOnlyOperationsBeforeCheckpoint',
        'maxNoArtifactToolCalls',
        'maxNoArtifactActiveMs',
        'postCommandEvidenceMs'
    ]) {
        if (!Number.isFinite(budgets[field]) || budgets[field] < 0) {
            fail(`watchdog-budget-${field}`)
        }
    }
}

export function createWriterRuntimeWatchdog(input) {
    validateInput(input)
    const binding = structuredClone(input.binding)
    const budgets = structuredClone(input.budgets)
    const trace = []
    const activeCommands = new Map()
    let state = 'watching-first-action'
    let firstActionVerified = false
    let firstArtifactVerified = false
    let readOnlyOperations = 0
    let noArtifactToolCalls = 0
    let cancellationReason = null
    let terminalStatus = null
    let persisted = false

    function currentReceipt() {
        return seal({
            schema: 'issue-orchestration.writer-runtime-watchdog-receipt.v1',
            status: terminalStatus
                ?? (state === 'checkpoint-received'
                    ? 'checkpoint-received'
                    : state === 'completed' ? 'completed' : 'terminal-failure'),
            requestId: binding.requestId,
            threadId: binding.threadId,
            rolloutId: binding.rolloutId,
            attemptId: binding.attemptId,
            planDigest: binding.planDigest,
            sliceDigest: binding.sliceDigest,
            routeDecisionDigest: binding.routeDecisionDigest,
            leaseDigest: binding.leaseDigest,
            selectedProfile: binding.selectedProfile,
            firstRequiredAction: binding.firstRequiredAction,
            requiredCommands: binding.requiredCommands,
            firstActionVerified,
            firstArtifactVerified,
            state,
            traceDigest: digest(trace),
            traceLength: trace.length,
            cancellationReason
        }, 'receiptDigest')
    }

    function persistOnce() {
        if (persisted) return
        persisted = true
        input.persist(currentReceipt())
    }

    function cancel(reason) {
        if (TERMINAL_STATES.has(state)) return
        cancellationReason = reason
        terminalStatus = 'terminal-failure'
        state = 'terminal-failure-observed'
        input.cancel(reason)
        persistOnce()
    }

    function record(event) {
        const copy = structuredClone(event)
        trace.push(copy)
    }

    function enforceOnlineBudgets(event) {
        if (firstArtifactVerified) return
        if (event.type === 'tool-call') {
            noArtifactToolCalls += 1
            if (event.readOnly) readOnlyOperations += 1
        }
        if (readOnlyOperations
            > budgets.maxReadOnlyOperationsBeforeCheckpoint) {
            cancel('read-budget-exceeded')
            return
        }
        if (noArtifactToolCalls >= budgets.maxNoArtifactToolCalls) {
            cancel('artifact-budget-exceeded')
            return
        }
        if (event.atMs - input.startedAtMs
            > budgets.maxNoArtifactActiveMs) {
            cancel('artifact-time-budget-exceeded')
        }
    }

    const watchdog = {
        get state() {
            return state
        },

        observe(event) {
            if (TERMINAL_STATES.has(state)) fail('watchdog-terminal')
            if (!event?.trusted) {
                cancel('untrusted-runtime-event')
                fail('watchdog-untrusted-event')
            }
            if (!Number.isFinite(event.atMs)
                || event.atMs < input.startedAtMs) {
                cancel('invalid-event-time')
                fail('watchdog-event-time')
            }

            record(event)
            enforceOnlineBudgets(event)
            if (TERMINAL_STATES.has(state)) return currentReceipt()

            if (event.type === 'runtime-initialized') return currentReceipt()

            if (event.type === 'filesystem-write') {
                if (!firstActionVerified
                    && event.action !== binding.firstRequiredAction) {
                    cancel('first-action-mismatch')
                    return currentReceipt()
                }
                assertText(event.path, 'watchdog-artifact-path')
                assertDigest(event.evidenceDigest, 'watchdog-artifact-evidence')
                firstActionVerified = true
                firstArtifactVerified = true
                state = 'productive'
                return currentReceipt()
            }

            if (event.type === 'command-start') {
                if (!binding.requiredCommands.includes(event.command)) {
                    cancel('unexpected-command')
                    return currentReceipt()
                }
                if (!Number.isInteger(event.processId) || event.processId < 1) {
                    cancel('invalid-command-process')
                    return currentReceipt()
                }
                activeCommands.set(event.processId, {
                    command: event.command,
                    lastHeartbeatAtMs: event.atMs
                })
                return currentReceipt()
            }

            if (event.type === 'command-heartbeat') {
                const command = activeCommands.get(event.processId)
                if (!command
                    || event.processAlive !== true
                    || event.leaseDigest !== binding.leaseDigest) {
                    cancel('invalid-command-heartbeat')
                    return currentReceipt()
                }
                command.lastHeartbeatAtMs = event.atMs
                state = firstArtifactVerified ? 'productive' : state
                return currentReceipt()
            }

            if (event.type === 'checkpoint-receipt') {
                if (!firstArtifactVerified
                    || event.valid !== true
                    || event.resourcesReleased !== true) {
                    cancel('invalid-checkpoint')
                    return currentReceipt()
                }
                assertDigest(event.checkpointDigest,
                    'watchdog-checkpoint-digest')
                assertDigest(event.continuationDigest,
                    'watchdog-continuation-digest')
                state = 'checkpoint-received'
                terminalStatus = 'checkpoint-received'
                persistOnce()
                return currentReceipt()
            }

            if (event.type === 'terminal-receipt') {
                if (event.status !== 'completed'
                    || !firstActionVerified
                    || !firstArtifactVerified) {
                    cancel('invalid-terminal-receipt')
                    return currentReceipt()
                }
                assertDigest(event.receiptDigest,
                    'watchdog-terminal-receipt-digest')
                state = 'completed'
                terminalStatus = 'completed'
                persistOnce()
                return currentReceipt()
            }

            return currentReceipt()
        },

        receipt() {
            return currentReceipt()
        },

        failClosed(error) {
            if (TERMINAL_STATES.has(state)) return currentReceipt()
            record({
                type: 'watchdog-error',
                trusted: true,
                name: error?.name ?? 'Error',
                message: error?.message ?? 'watchdog failure'
            })
            cancel('watchdog-failure')
            return currentReceipt()
        }
    }
    return watchdog
}
