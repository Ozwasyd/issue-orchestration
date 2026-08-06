import path from 'node:path'

import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    createSemanticGraph,
    validateSemanticGraph
} from './semantic-runtime-projection.mjs'
import {
    compileLifecycleActionSet,
    compileLifecycleRemoteSnapshotReceipt,
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    verifySelectorDefinition,
    verifySelectorReceipt
} from './scope-selector.mjs'
import {
    appendControlEventAtomicSync,
    appendNodeEventAtomicSync,
    canonicalNodeStateLocation,
    canonicalRunStateLocation,
    canonicalControlLedgerFromRecovered,
    compileControlEvent,
    createControlLedger,
    persistAggregateRunState,
    readCanonicalControlLedger,
    readCanonicalNodeLedger,
    recoverAggregateRunState,
    replayControlLedger,
    stateDigest
} from './multi-node-state.mjs'
import {
    replayEventLedgerSync,
    sealNodeLedgerHeader
} from './event-ledger.mjs'
import {
    LifecycleStageAdmissionError,
    validateLifecycleStageResult
} from './lifecycle-stage-admission.mjs'
import {
    validateLifecycleActorStageFailure
} from './lifecycle-executor-failure-admission.mjs'
import {
    compileLifecycleRunTakeoverAuthority,
    lifecycleAuthorityBinding,
    rebindLifecycleSelectorAuthority,
    repositoryAuthorityFor,
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'

const HANDLE_SCHEMA = 'issue-orchestration.lifecycle-run-handle.v1'
const GENESIS_SCHEMA = 'issue-orchestration.lifecycle-run-genesis.v1'
const GENESIS = '0'.repeat(64)
const SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const AUTHORITY_CONTEXT = Symbol('lifecycle-authority-context')
const CONTROL_FACTS_CACHE = Symbol('lifecycle-control-facts-cache')
const ACTION_SET_CACHE_OBSERVATION = Symbol(
    'lifecycle-action-set-cache-observation'
)
const LIFECYCLE_ACTION_SET_CACHE = new Map()
const LIFECYCLE_ACTION_SET_CACHE_STATS = new Map()
const REPLAY_CACHE_AUTHORITY_DIGEST = Symbol(
    'lifecycle-replay-cache-authority-digest'
)
const DISPATCHABLE_ACTION_TYPES = new Set([
    'request-semantic-proposal',
    'request-test-contract-planning',
    'dispatch-test-contract-writer',
    'dispatch-implementation-writer',
    'dispatch-behavior-verifier',
    'request-ui-adjudication',
    'dispatch-ux-acceptance-verifier',
    'dispatch-documentation-writer'
])

export class LifecycleRunLoopError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecycleRunLoopError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new LifecycleRunLoopError(code, code, details)
}

function clone(value) {
    return structuredClone(value)
}

function unsignedDigest(value, field) {
    const copy = clone(value)
    delete copy[field]
    return digest(copy)
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

function requireDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
    return value
}

function requireSha(value, code) {
    if (!SHA.test(value ?? '')) fail(code)
    return value
}

function repositoryMap(graph) {
    return new Map(graph.repositories.map((repository) => [
        repository.repository,
        repository
    ]))
}

function validateGenesis(genesis) {
    requireObject(genesis, 'lifecycle-run-genesis-invalid')
    if (genesis.schema !== GENESIS_SCHEMA) {
        fail('lifecycle-run-genesis-schema')
    }
    requireText(genesis.runId, 'lifecycle-run-id-required')
    requireText(genesis.createdAt, 'lifecycle-run-created-at-required')
    if (!Number.isInteger(genesis.slotCapacity) ||
        genesis.slotCapacity < 1) {
        fail('lifecycle-run-slot-capacity-invalid')
    }
    try {
        verifySelectorReceipt(genesis.selectorReceipt)
        verifySelectorDefinition(
            genesis.selectorDefinition,
            genesis.selectorReceipt
        )
        validateSemanticGraph(genesis.semanticGraph)
    } catch (error) {
        fail('lifecycle-run-genesis-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const expectedRemote = compileLifecycleRemoteSnapshotReceipt(
        genesis.selectorReceipt
    )
    if (!sameValue(expectedRemote, genesis.remoteSnapshotReceipt)) {
        fail('lifecycle-run-genesis-remote-invalid')
    }
    if (genesis.semanticGraph.selectorReceiptDigest !==
            genesis.selectorReceipt.receiptDigest ||
        genesis.semanticGraph.remoteSnapshotDigest !==
            genesis.remoteSnapshotReceipt.receiptDigest) {
        fail('lifecycle-run-genesis-graph-stale')
    }
    if (genesis.installedPolicy?.schema !==
            'issue-orchestration.installed-route-policy.v1' ||
        genesis.installedPolicy.status !== 'verified' ||
        genesis.installedPolicy.policyDigest !==
            genesis.semanticGraph.policyDigest) {
        fail('lifecycle-run-policy-invalid')
    }
    const authority = genesis.lifecycleAuthority
    if (authority?.schema !==
            'issue-orchestration.lifecycle-run-authority.v1' ||
        authority.status !== 'verified' ||
        authority.runId !== genesis.runId ||
        authority.authorityKind !== 'genesis' ||
        authority.authorityDigest !==
            unsignedDigest(authority, 'authorityDigest')) {
        fail('lifecycle-run-authority-invalid')
    }
    try {
        lifecycleAuthorityBinding(authority)
    } catch (error) {
        fail('lifecycle-run-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (genesis.selectorReceipt.lifecycleAuthorityBindingDigest !==
            authority.binding.bindingDigest ||
        genesis.selectorReceipt.startupAttestationDigest !==
            authority.binding.startupAttestationDigest ||
        genesis.selectorReceipt.runtimeInvocationId !==
            authority.binding.runtimeInvocationId ||
        genesis.selectorReceipt.runtimeSessionId !==
            authority.binding.runtimeSessionId ||
        genesis.selectorReceipt.rootAuthorityEpoch !==
            authority.binding.rootAuthorityEpoch ||
        genesis.selectorReceipt.runtimeTrustBindingDigest !==
            authority.binding.runtimeTrustBindingDigest ||
        genesis.selectorReceipt.repositoryBindingSetDigest !==
            authority.binding.repositoryBindingSetDigest) {
        fail('lifecycle-run-selector-authority-stale')
    }
    if (genesis.runtimeCapabilityBinding?.schema !==
            'issue-orchestration.runtime-capability-binding.v1' ||
        genesis.runtimeCapabilityBinding.status !== 'verified' ||
        genesis.runtimeCapabilityBinding.bindingDigest !==
            authority.runtimeCapabilityBinding.bindingDigest ||
        genesis.runtimeCapabilityBinding.bindingDigest !==
            authority.binding.runtimeCapabilityBindingDigest) {
        fail('lifecycle-run-capability-invalid')
    }
    requireDigest(
        genesis.runtimeCapabilityBinding.bindingDigest,
        'lifecycle-run-capability-invalid'
    )
    for (const repository of genesis.semanticGraph.repositories) {
        let repositoryAuthority
        try {
            repositoryAuthority = repositoryAuthorityFor(
                authority,
                repository.repository
            )
        } catch (error) {
            fail('lifecycle-run-repository-authority-invalid', {
                cause: error?.code ?? error?.message
            })
        }
        if (repository.bindingDigest !==
                repositoryAuthority.bindingDigest) {
            fail('lifecycle-run-repository-authority-stale')
        }
    }
    requireDigest(
        genesis.genesisDigest,
        'lifecycle-run-genesis-digest-invalid'
    )
    if (unsignedDigest(genesis, 'genesisDigest') !==
            genesis.genesisDigest) {
        fail('lifecycle-run-genesis-digest-mismatch')
    }
    return genesis
}

function resolveAuthorityLocation(value) {
    const authority = value?.ledger ?? value
    requireObject(authority, 'lifecycle-run-handle-required')
    if (authority.schema !== HANDLE_SCHEMA) {
        if (authority.stateRoot && authority.runId) {
            return {
                stateRoot: path.resolve(authority.stateRoot),
                runId: requireText(
                    authority.runId,
                    'lifecycle-run-id-required'
                )
            }
        }
        fail('lifecycle-run-handle-invalid')
    }
    requireText(authority.stateRoot, 'lifecycle-run-state-root-required')
    requireText(authority.runId, 'lifecycle-run-id-required')
    requireDigest(authority.handleDigest, 'lifecycle-run-handle-digest')
    if (unsignedDigest(authority, 'handleDigest') !==
            authority.handleDigest) {
        fail('lifecycle-run-handle-digest-mismatch')
    }
    return {
        stateRoot: path.resolve(authority.stateRoot),
        runId: authority.runId
    }
}

function resolveAuthority(value, startup = null) {
    const candidate = value?.ledger ?? value
    const currentStartup = startup ?? candidate?.startup ?? null
    if (!currentStartup) {
        fail('lifecycle-run-current-startup-required')
    }
    if (candidate?.[AUTHORITY_CONTEXT] === true &&
        candidate.startup === currentStartup) {
        return candidate
    }
    const authority = {
        ...resolveAuthorityLocation(value),
        startup: currentStartup
    }
    Object.defineProperty(authority, AUTHORITY_CONTEXT, {
        value: true
    })
    Object.defineProperty(authority, REPLAY_CACHE_AUTHORITY_DIGEST, {
        value: digest({
            schema:
                'issue-orchestration.lifecycle-replay-cache-authority.v1',
            stateRoot: authority.stateRoot,
            runId: authority.runId,
            startup: currentStartup
        })
    })
    return authority
}

function clearControlFactsCache(authority) {
    delete authority[CONTROL_FACTS_CACHE]
}

function genesisFromControlLedger(controlLedger) {
    const event = controlLedger.events.find(
        ({ eventType, payload }) =>
            eventType === 'scope.refreshed' && payload?.runGenesis
    )
    if (!event) fail('lifecycle-run-genesis-unavailable')
    const genesis = validateGenesis(event.payload.runGenesis)
    if (genesis.runId !== controlLedger.header.runId) {
        fail('lifecycle-run-genesis-run-id-mismatch')
    }
    return genesis
}

function currentLifecycleAuthorityFromControlLedger(
    controlLedger,
    genesis,
    authority
) {
    const event = [...controlLedger.events].reverse().find(
        ({ eventType, payload }) =>
            eventType === 'runtime-authority.rebound' &&
            payload?.lifecycleAuthority
    )
    const current = event?.payload?.lifecycleAuthority ??
        genesis.lifecycleAuthority
    try {
        validateLifecycleRunAuthority(current, {
            startup: authority.startup,
            expectedRunId: authority.runId,
            expectedStateRoot: authority.stateRoot
        })
    } catch (error) {
        fail('lifecycle-run-current-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    return current
}

function currentSelectorFromControlLedger(controlLedger, genesis) {
    const event = [...controlLedger.events].reverse().find(
        ({ eventType, payload }) =>
            eventType === 'scope.refreshed' && payload?.selectorReceipt
    )
    const selector = verifySelectorReceipt(
        event?.payload?.selectorReceipt ?? genesis.selectorReceipt
    )
    return selector
}

function currentRemoteFromControlLedger(controlLedger, selector) {
    const event = [...controlLedger.events].reverse().find(
        ({ eventType, payload }) =>
            eventType === 'remote-snapshot.refreshed' &&
            payload?.remoteSnapshotReceipt
    )
    const expected = compileLifecycleRemoteSnapshotReceipt(selector)
    if (event && !sameValue(
        event.payload.remoteSnapshotReceipt,
        expected
    )) {
        fail('lifecycle-run-remote-snapshot-invalid')
    }
    return expected
}

function makeHandle({
    stateRoot,
    runId,
    recovered = null,
    startup = null
}) {
    const location = canonicalRunStateLocation({ stateRoot, runId })
    const state = recovered ?? recoverAggregateRunState({
        stateRoot: location.stateRoot,
        runId
    })
    const handle = {
        schema: HANDLE_SCHEMA,
        status: 'canonical',
        stateRoot: location.stateRoot,
        runId,
        runKey: location.runKey,
        controlLedgerHeadDigest:
            state.controlProjection.lastEventDigest,
        nodeIndexDigest: state.nodeIndex.nodeIndexDigest,
        aggregateProjectionDigest:
            state.projection.aggregateProjectionDigest,
        lifecycleAuthorityBindingDigest:
            state.controlProjection.lifecycleAuthorityBinding
                ?.bindingDigest ?? null
    }
    handle.handleDigest = digest(handle)
    return Object.freeze(handle)
}

function pushControlEvent(ledger, eventType, payload, createdAt) {
    ledger.events.push(compileControlEvent({
        ledger,
        eventType,
        payload,
        createdAt
    }))
}

function nodeRegistration({
    graphNode,
    nodeEpoch,
    repository,
    selectorReceipt,
    lifecycleAuthority
}) {
    const remoteMemberDigest = selectorReceipt.remoteFactDigests[
        graphNode.id
    ]
    requireDigest(
        remoteMemberDigest,
        'lifecycle-run-node-remote-member-missing'
    )
    return {
        nodeId: graphNode.id,
        memberId: graphNode.memberId,
        repository: graphNode.repository,
        issueNumber: graphNode.issueNumber,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteMemberDigest,
        nodeEpoch,
        baseSha: repository.baseSha,
        repositoryBindingDigest: repository.bindingDigest,
        issueSnapshotFingerprint: remoteMemberDigest,
        repositoryFingerprint: repository.bindingDigest,
        lifecycleAuthorityBinding:
            clone(lifecycleAuthority.binding),
        dependencyKeys: [...graphNode.dependencyKeys],
        acceptanceGroup: graphNode.acceptanceGroup,
        graphNode: clone(graphNode)
    }
}

function nodeLedgerForRegistration({
    registration,
    runId,
    stateRoot,
    createdAt,
    events = []
}) {
    return {
        header: sealNodeLedgerHeader({
            runId,
            ...registration,
            stateRootCanonical: path.resolve(stateRoot),
            createdAt
        }),
        events
    }
}

export function createLifecycleRunLedger({
    stateRoot,
    runId,
    createdAt,
    selectorReceipt,
    selectorDefinition,
    semanticGraph,
    installedPolicy,
    lifecycleAuthority,
    startup,
    slotCapacity
} = {}) {
    requireText(stateRoot, 'lifecycle-run-state-root-required')
    try {
        validateLifecycleRunAuthority(lifecycleAuthority, {
            startup,
            expectedKind: 'genesis',
            expectedRunId: runId,
            expectedStateRoot: stateRoot
        })
    } catch (error) {
        fail('lifecycle-run-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (slotCapacity !==
        lifecycleAuthority.runtimeCapabilityBinding.slotCapacity) {
        fail('lifecycle-run-slot-capacity-authority-mismatch')
    }
    verifySelectorReceipt(selectorReceipt)
    validateSemanticGraph(semanticGraph)
    const remoteSnapshotReceipt =
        compileLifecycleRemoteSnapshotReceipt(selectorReceipt)
    const genesis = {
        schema: GENESIS_SCHEMA,
        runId,
        createdAt,
        selectorReceipt: clone(selectorReceipt),
        selectorDefinition: clone(
            verifySelectorDefinition(
                selectorDefinition,
                selectorReceipt
            )
        ),
        remoteSnapshotReceipt,
        semanticGraph: clone(semanticGraph),
        installedPolicy: clone(installedPolicy),
        lifecycleAuthority: clone(lifecycleAuthority),
        runtimeCapabilityBinding:
            clone(lifecycleAuthority.runtimeCapabilityBinding),
        slotCapacity
    }
    genesis.genesisDigest = digest(genesis)
    validateGenesis(genesis)

    const controlLedger = createControlLedger({
        runId,
        createdAt,
        lifecycleAuthorityBinding:
            lifecycleAuthority.binding
    })
    pushControlEvent(controlLedger, 'scope.refreshed', {
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        selectorReceipt: clone(selectorReceipt),
        runGenesis: genesis
    }, createdAt)
    pushControlEvent(controlLedger, 'remote-snapshot.refreshed', {
        remoteSnapshotDigest: remoteSnapshotReceipt.receiptDigest,
        remoteSnapshotReceipt
    }, createdAt)

    const repositories = repositoryMap(semanticGraph)
    for (const repository of semanticGraph.repositories) {
        const bound = repositoryAuthorityFor(
            lifecycleAuthority,
            repository.repository
        )
        if (repository.bindingDigest !== bound.bindingDigest ||
            repository.baseSha !== bound.observedDefaultBranchHead) {
            fail('lifecycle-run-repository-genesis-stale', {
                repository: repository.repository
            })
        }
    }
    const nodeLedgers = []
    for (const graphNode of semanticGraph.nodes) {
        const repository = repositories.get(graphNode.repository)
        if (!repository) {
            fail('lifecycle-run-node-repository-missing', {
                nodeId: graphNode.id
            })
        }
        const registration = nodeRegistration({
            graphNode,
            nodeEpoch: 1,
            repository,
            selectorReceipt,
            lifecycleAuthority
        })
        pushControlEvent(
            controlLedger,
            'node.registered',
            registration,
            createdAt
        )
        nodeLedgers.push(nodeLedgerForRegistration({
            registration,
            runId,
            stateRoot,
            createdAt
        }))
    }
    pushControlEvent(controlLedger, 'slots.updated', {
        capacity: slotCapacity,
        activeNodeIds: []
    }, createdAt)

    const recovered = persistAggregateRunState({
        stateRoot,
        controlLedger,
        nodeLedgers
    })
    return makeHandle({ stateRoot, runId, recovered, startup })
}

function compileNodeEffect(node, admission, eventSequence) {
    const next = clone(node)
    const receipts = clone(admission.artifacts)
    if (admission.contractId === 'acceptance-contract') {
        receipts.documentationRequired =
            admission.artifacts.documentationRequirement.evidence.required
    }
    next.lifecycleState = admission.toState
    next.implementationAttempts +=
        admission.implementationAttemptDelta
    if (admission.contractId === 'delivery-completed') {
        next.deliveryCommit =
            admission.artifacts.remoteEffect.evidence.commits[next.id] ??
            null
    }
    if (admission.contractId === 'cleanup-and-closure') {
        next.closedAtSequence = eventSequence
    }
    next.receipts = {
        ...next.receipts,
        ...receipts
    }
    return { node: next, receipts }
}

function currentControlFacts(authority, replayOptions = {}) {
    const forceReplay = replayOptions.forceFullReplay === true ||
        replayOptions.explicitAudit === true ||
        replayOptions.corruptionSuspected === true
    if (!forceReplay && authority[CONTROL_FACTS_CACHE]) {
        return authority[CONTROL_FACTS_CACHE]
    }
    const recovered = recoverAggregateRunState({
        ...authority,
        cacheAuthorityDigest: authority[REPLAY_CACHE_AUTHORITY_DIGEST],
        forceFullReplay: replayOptions.forceFullReplay === true,
        explicitAudit: replayOptions.explicitAudit === true,
        corruptionSuspected: replayOptions.corruptionSuspected === true
    })
    const controlLedger = canonicalControlLedgerFromRecovered(recovered)
    const controlProjection = recovered.controlProjection
    const genesis = genesisFromControlLedger(controlLedger)
    const lifecycleAuthority =
        currentLifecycleAuthorityFromControlLedger(
            controlLedger,
            genesis,
            authority
        )
    if (controlProjection.lifecycleAuthorityBinding
            ?.bindingDigest !==
            lifecycleAuthority.binding.bindingDigest) {
        fail('lifecycle-run-control-authority-stale')
    }
    const selectorReceipt = currentSelectorFromControlLedger(
        controlLedger,
        genesis
    )
    const binding = lifecycleAuthority.binding
    if (selectorReceipt.lifecycleAuthorityBindingDigest !==
            binding.bindingDigest ||
        selectorReceipt.startupAttestationDigest !==
            binding.startupAttestationDigest ||
        selectorReceipt.runtimeInvocationId !==
            binding.runtimeInvocationId ||
        selectorReceipt.runtimeSessionId !==
            binding.runtimeSessionId ||
        selectorReceipt.rootAuthorityEpoch !==
            binding.rootAuthorityEpoch ||
        selectorReceipt.runtimeTrustBindingDigest !==
            binding.runtimeTrustBindingDigest ||
        selectorReceipt.repositoryBindingSetDigest !==
            binding.repositoryBindingSetDigest) {
        fail('lifecycle-run-selector-authority-stale')
    }
    const remoteSnapshotReceipt = currentRemoteFromControlLedger(
        controlLedger,
        selectorReceipt
    )
    if (controlProjection.selectorReceiptDigest !==
            selectorReceipt.receiptDigest ||
        controlProjection.remoteSnapshotDigest !==
            remoteSnapshotReceipt.receiptDigest) {
        fail('lifecycle-run-control-facts-stale')
    }
    const facts = Object.freeze({
        controlLedger,
        controlProjection,
        genesis,
        lifecycleAuthority,
        selectorReceipt,
        remoteSnapshotReceipt,
        recovered
    })
    Object.defineProperty(authority, CONTROL_FACTS_CACHE, {
        value: facts,
        configurable: true
    })
    return facts
}

function currentSemanticGraph({
    controlProjection,
    genesis,
    lifecycleAuthority,
    recovered,
    selectorReceipt,
    remoteSnapshotReceipt
}) {
    const templateById = new Map(
        genesis.semanticGraph.nodes.map((node) => [node.id, node])
    )
    const repositories = Object.values(
        controlProjection.repositoryBases
    ).sort((left, right) =>
        left.repository.localeCompare(right.repository))
        .map((repository) => {
            const bound = repositoryAuthorityFor(
                lifecycleAuthority,
                repository.repository
            )
            if (repository.repositoryBindingDigest !==
                    bound.bindingDigest) {
                fail('lifecycle-run-repository-authority-stale')
            }
            return {
                repository: repository.repository,
                baseSha: repository.baseSha,
                bindingDigest: bound.bindingDigest
            }
        })
    const repositoryBindings = new Map(repositories.map(
        (repository) => [repository.repository, repository.bindingDigest]
    ))
    const nodes = Object.entries(controlProjection.nodes)
        .filter(([, registration]) =>
            registration.status === 'active')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, registration]) => {
            const base = registration.graphNode ?? templateById.get(nodeId)
            if (!base) {
                fail('lifecycle-run-node-template-missing', { nodeId })
            }
            const aggregateNode = recovered.projection.nodes[nodeId]
            const nodeProjection =
                recovered.nodeProjections[nodeId]?.nodes?.[nodeId]
            return {
                ...clone(base),
                id: nodeId,
                memberId: nodeId,
                repository: registration.repository,
                issueNumber: registration.issueNumber,
                dependencyKeys: [...registration.dependencyKeys],
                acceptanceGroup: registration.acceptanceGroup,
                lifecycleState:
                    aggregateNode?.lifecycleState ?? 'quarantined',
                selectorReceiptDigest: selectorReceipt.receiptDigest,
                remoteSnapshotDigest:
                    remoteSnapshotReceipt.receiptDigest,
                repositoryBindingDigest:
                    repositoryBindings.get(registration.repository),
                semanticFactsDigest: digest({
                    original: base.semanticFactsDigest,
                    remoteMemberDigest:
                        registration.remoteMemberDigest,
                    nodeEpoch: registration.nodeEpoch
                }),
                receipts: clone(
                    nodeProjection?.lifecycleReceipts ?? {}
                )
            }
        })
    return createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: remoteSnapshotReceipt.receiptDigest,
        scopeDigest: genesis.semanticGraph.scopeDigest,
        semanticGraphInputDigest: digest({
            genesisDigest: genesis.genesisDigest,
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: remoteSnapshotReceipt.receiptDigest,
            repositoryBases: repositories,
            nodeEpochs: Object.fromEntries(nodes.map((node) => [
                node.id,
                controlProjection.nodes[node.id].nodeEpoch
            ]))
        }),
        policyDigest: genesis.semanticGraph.policyDigest,
        repositories,
        nodes
    })
}

function currentCompatibilityState({
    controlProjection,
    recovered,
    selectorReceipt,
    remoteSnapshotReceipt,
    semanticGraph
}) {
    const graphById = new Map(
        semanticGraph.nodes.map((node) => [node.id, node])
    )
    const nodes = Object.fromEntries(Object.entries(
        controlProjection.nodes
    ).map(([nodeId, registration]) => {
        const nodeProjection =
            recovered.nodeProjections[nodeId]?.nodes?.[nodeId]
        const graphNode = graphById.get(nodeId) ?? registration.graphNode
        return [nodeId, {
            id: nodeId,
            memberId: nodeId,
            repository: registration.repository,
            issueNumber: registration.issueNumber,
            owner: graphNode?.owner ?? null,
            dependencyKeys: [...registration.dependencyKeys],
            conflictKeys: [...(graphNode?.conflictKeys ?? [])],
            riskClass: graphNode?.riskClass ?? null,
            uiClass: graphNode?.uiClass ?? 'non-ui',
            acceptanceGroup: registration.acceptanceGroup,
            semanticFactsDigest: graphNode?.semanticFactsDigest ?? null,
            lifecycleState:
                recovered.projection.nodes[nodeId]?.lifecycleState ??
                'quarantined',
            receipts: clone(nodeProjection?.lifecycleReceipts ?? {}),
            chainVersion: registration.nodeEpoch,
            implementationAttempts:
                nodeProjection?.implementationAttempts ?? 0,
            pendingDeliveryEffect:
                controlProjection.pendingDeliveryEffects[
                    registration.acceptanceGroup ?? `node:${nodeId}`
                ] ?? null,
            deliveryCommit: nodeProjection?.deliveryCommit ?? null,
            closedAtSequence:
                nodeProjection?.closedAtSequence ?? null,
            activeAttemptId:
                nodeProjection?.activeAttemptId ?? null,
            reworkCount: nodeProjection?.reworkCount ?? 0,
            firstFailure: clone(nodeProjection?.firstFailure ?? null),
            terminalCandidate:
                clone(nodeProjection?.terminal ?? null),
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
            }
        }]
    }))
    return Object.freeze({
        runId: controlProjection.runId,
        lifecycleAuthorityBinding:
            clone(controlProjection.lifecycleAuthorityBinding),
        selectorReceipt: clone(selectorReceipt),
        remoteSnapshotReceipt: clone(remoteSnapshotReceipt),
        repositories: Object.fromEntries(Object.values(
            controlProjection.repositoryBases
        ).map((repository) => [
            repository.repository,
            {
                repository: repository.repository,
                baseSha: repository.baseSha,
                bindingDigest: repository.repositoryBindingDigest
            }
        ])),
        nodes,
        pendingDeliveryEffects:
            clone(controlProjection.pendingDeliveryEffects),
        deliveryEffects: clone(controlProjection.deliveryEffects),
        deliveryFreezes: clone(controlProjection.deliveryFreezes),
        cleanupFinalizations:
            clone(controlProjection.cleanupFinalizations),
        pendingClosureAuthorizations:
            clone(controlProjection.pendingClosureAuthorizations),
        pendingClosureEffects:
            clone(controlProjection.pendingClosureEffects),
        closureEffects: clone(controlProjection.closureEffects),
        lastControlSequence: controlProjection.lastSequence
    })
}

export function lifecycleRunObservationContext(
    value,
    { startup } = {}
) {
    const authority = resolveAuthority(value, startup)
    const facts = currentControlFacts(authority)
    return Object.freeze({
        runId: authority.runId,
        stateRoot: authority.stateRoot,
        selectorDefinition: clone(facts.genesis.selectorDefinition),
        selectorReceipt: clone(facts.selectorReceipt),
        remoteSnapshotReceipt: clone(facts.remoteSnapshotReceipt),
        controlLedgerHeadDigest:
            facts.controlProjection.lastEventDigest,
        controlProjectionDigest:
            facts.controlProjection.controlProjectionDigest,
        lifecycleAuthority: clone(facts.lifecycleAuthority),
        repositoryBases: clone(
            facts.controlProjection.repositoryBases
        ),
        nodes: clone(facts.controlProjection.nodes)
    })
}

export function replayLifecycleRunLedger(
    value,
    { startup } = {}
) {
    const authority = resolveAuthority(value, startup)
    const facts = currentControlFacts(authority)
    const recovered = facts.recovered
    const semanticGraph = currentSemanticGraph({
        ...facts,
        recovered
    })
    return currentCompatibilityState({
        ...facts,
        recovered,
        semanticGraph
    })
}

export function projectLifecycleRun(
    value,
    {
        startup,
        forceFullReplay = false,
        explicitAudit = false,
        corruptionSuspected = false
    } = {}
) {
    const authority = resolveAuthority(value, startup)
    const facts = currentControlFacts(authority, {
        forceFullReplay,
        explicitAudit,
        corruptionSuspected
    })
    const recovered = facts.recovered
    const semanticGraph = currentSemanticGraph({
        ...facts,
        recovered
    })
    const state = currentCompatibilityState({
        ...facts,
        recovered,
        semanticGraph
    })
    return Object.freeze({
        state,
        semanticGraph,
        aggregateProjection: recovered.projection,
        nodeIndex: recovered.nodeIndex
    })
}

function lifecycleCompilerInput(
    value,
    observedSelectorReceipt = null,
    startup = null,
    resolvedAuthority = null
) {
    const authority = resolvedAuthority ?? resolveAuthority(value, startup)
    const facts = currentControlFacts(authority)
    const recovered = facts.recovered
    const semanticGraph = currentSemanticGraph({
        ...facts,
        recovered
    })
    const selector = observedSelectorReceipt
        ? verifySelectorReceipt(observedSelectorReceipt)
        : facts.selectorReceipt
    const remote = compileLifecycleRemoteSnapshotReceipt(selector)
    return {
        schema:
            'issue-orchestration.lifecycle-compiler-input.v1',
        selectorReceipt: selector,
        remoteSnapshotReceipt: remote,
        semanticGraph,
        aggregateProjection: recovered.projection,
        installedPolicy: clone(facts.genesis.installedPolicy),
        runtimeCapabilityBinding:
            clone(facts.lifecycleAuthority.runtimeCapabilityBinding),
        lifecycleAuthority:
            clone(facts.lifecycleAuthority)
    }
}

function actionSetCacheLocator(authority) {
    return `${authority.stateRoot}\u0000${authority.runId}`
}

function actionSetCacheIdentity(input) {
    const identity = {
        schema: 'issue-orchestration.lifecycle-action-set-cache-key.v1',
        selectorReceiptDigest: input.selectorReceipt.receiptDigest,
        remoteSnapshotReceiptDigest:
            input.remoteSnapshotReceipt.receiptDigest,
        semanticGraphDigest: input.semanticGraph.semanticGraphDigest,
        aggregateProjectionDigest:
            input.aggregateProjection.aggregateProjectionDigest,
        policyDigest: input.installedPolicy.policyDigest,
        runtimeCapabilityBindingDigest:
            input.runtimeCapabilityBinding.bindingDigest,
        lifecycleAuthorityBindingDigest:
            input.lifecycleAuthority.binding.bindingDigest
    }
    return Object.freeze({
        identity: Object.freeze(identity),
        keyDigest: digest(identity)
    })
}

function actionSetCacheStatsRecord(authority) {
    const locator = actionSetCacheLocator(authority)
    if (!LIFECYCLE_ACTION_SET_CACHE_STATS.has(locator)) {
        LIFECYCLE_ACTION_SET_CACHE_STATS.set(locator, {
            compilerInvocations: 0,
            cacheHits: 0,
            cacheMisses: 0,
            forcedRecompilations: 0
        })
    }
    return LIFECYCLE_ACTION_SET_CACHE_STATS.get(locator)
}

function actionSetMatchesCacheIdentity(actionSet, identity) {
    return actionSet.semanticGraphDigest === identity.semanticGraphDigest &&
        actionSet.aggregateProjectionDigest ===
            identity.aggregateProjectionDigest &&
        actionSet.policyDigest === identity.policyDigest &&
        actionSet.runtimeCapabilityBindingDigest ===
            identity.runtimeCapabilityBindingDigest &&
        actionSet.lifecycleAuthorityBindingDigest ===
            identity.lifecycleAuthorityBindingDigest
}

function observedActionSet(actionSet, observation) {
    const result = clone(actionSet)
    Object.defineProperty(result, ACTION_SET_CACHE_OBSERVATION, {
        value: Object.freeze(clone(observation))
    })
    return Object.freeze(result)
}

export function lifecycleActionSetCacheObservation(value) {
    return value?.[ACTION_SET_CACHE_OBSERVATION]
        ? Object.freeze(clone(value[ACTION_SET_CACHE_OBSERVATION]))
        : null
}

export function lifecycleActionSetCacheStats({ stateRoot, runId } = {}) {
    if (!stateRoot || !runId) {
        return Object.freeze({
            compilerInvocations: 0,
            cacheHits: 0,
            cacheMisses: 0,
            forcedRecompilations: 0
        })
    }
    const locator = `${path.resolve(stateRoot)}\u0000${runId}`
    return Object.freeze(clone(
        LIFECYCLE_ACTION_SET_CACHE_STATS.get(locator) ?? {
            compilerInvocations: 0,
            cacheHits: 0,
            cacheMisses: 0,
            forcedRecompilations: 0
        }
    ))
}

export function clearLifecycleActionSetCache({ stateRoot, runId } = {}) {
    if (stateRoot === undefined && runId === undefined) {
        LIFECYCLE_ACTION_SET_CACHE.clear()
        LIFECYCLE_ACTION_SET_CACHE_STATS.clear()
        return
    }
    if (!stateRoot || !runId) {
        fail('lifecycle-action-set-cache-location-required')
    }
    const locator = `${path.resolve(stateRoot)}\u0000${runId}`
    LIFECYCLE_ACTION_SET_CACHE.delete(locator)
    LIFECYCLE_ACTION_SET_CACHE_STATS.delete(locator)
}

export function compileLifecycleRunActionSet(
    value,
    {
        observedSelectorReceipt = null,
        startup = null,
        forceRecompile = false
    } = {}
) {
    const authority = resolveAuthority(value, startup)
    const input = lifecycleCompilerInput(
        authority,
        observedSelectorReceipt,
        authority.startup,
        authority
    )
    const cacheKey = actionSetCacheIdentity(input)
    const locator = actionSetCacheLocator(authority)
    const stats = actionSetCacheStatsRecord(authority)
    const cached = LIFECYCLE_ACTION_SET_CACHE.get(locator)
    if (!forceRecompile &&
        cached?.keyDigest === cacheKey.keyDigest &&
        sameValue(cached.identity, cacheKey.identity)) {
        validateLifecycleActionSet(cached.actionSet)
        if (!actionSetMatchesCacheIdentity(
            cached.actionSet,
            cacheKey.identity
        )) {
            fail('lifecycle-action-set-cache-binding-mismatch')
        }
        stats.cacheHits += 1
        return observedActionSet(cached.actionSet, {
            schema:
                'issue-orchestration.lifecycle-action-set-cache-observation.v1',
            status: 'cache-hit',
            keyDigest: cacheKey.keyDigest
        })
    }
    stats.cacheMisses += 1
    if (forceRecompile) stats.forcedRecompilations += 1
    const actionSet = compileLifecycleActionSet(input)
    stats.compilerInvocations += 1
    validateLifecycleActionSet(actionSet)
    if (!actionSetMatchesCacheIdentity(actionSet, cacheKey.identity)) {
        fail('lifecycle-action-set-cache-binding-mismatch')
    }
    const stored = clone(actionSet)
    LIFECYCLE_ACTION_SET_CACHE.set(locator, Object.freeze({
        keyDigest: cacheKey.keyDigest,
        identity: cacheKey.identity,
        actionSet: stored
    }))
    return observedActionSet(stored, {
        schema:
            'issue-orchestration.lifecycle-action-set-cache-observation.v1',
        status: forceRecompile ? 'forced-recompile' : 'compiled',
        keyDigest: cacheKey.keyDigest
    })
}

function exactCurrentActionSet(value, actionSet) {
    const current = compileLifecycleRunActionSet(value, {
        startup: value.startup
    })
    if (!sameValue(current, actionSet)) {
        fail('lifecycle-action-set-stale')
    }
    return current
}

function receiptEvidence(receipts) {
    return Object.values(receipts).flatMap((receipt) => {
        if (!receipt || typeof receipt !== 'object') return []
        for (const field of [
            'receiptDigest', 'workPlanDigest', 'planDigest',
            'sliceDigest', 'promptDigest', 'routeDecisionDigest',
            'proposalDigest', 'inventoryDigest', 'contractDigest',
            'bindingDigest', 'snapshotDigest'
        ]) {
            if (HASH.test(receipt[field] ?? '')) {
                return [`receipt://${receipt[field]}`]
            }
        }
        return []
    })
}

function compileCanonicalNodeEvent({
    authority,
    actionSet,
    action,
    result,
    node,
    createdAt
}) {
    const controlFacts = currentControlFacts(authority)
    const registration = controlFacts.controlProjection.nodes[node.id]
    const ledger = readCanonicalNodeLedger({
        ...authority,
        nodeId: node.id,
        nodeEpoch: registration.nodeEpoch
    })
    const eventSequence = ledger.events.length + 1
    const admission = validateLifecycleStageResult({
        result,
        action,
        node
    })
    if (!admission.eventType || !admission.toState) {
        fail('lifecycle-stage-result-node-event-forbidden', {
            actionType: action.type,
            contractId: admission.contractId
        })
    }
    const effect = compileNodeEffect(
        node,
        admission,
        eventSequence
    )
    const eventType = admission.eventType
    const projected = projectLifecycleRun(authority, {
        startup: authority.startup
    })
    const payload = {
        schema: 'issue-orchestration.lifecycle-canonical-effect.v1',
        actionSetDigest: actionSet.actionSetDigest,
        action: clone(action),
        stageResult: clone(result),
        implementationAttempts:
            effect.node.implementationAttempts,
        deliveryCommit: effect.node.deliveryCommit,
        closedAtSequence: effect.node.closedAtSequence
    }
    if ([
        'test-contract-terminal-failure',
        'implementation-terminal-failure',
        'documentation-terminal-failure'
    ].includes(admission.contractId)) {
        const receipt = result.artifacts.executorFailure
            .evidence.failureReceipt
        payload.firstFailure = {
            classification: receipt.eventType,
            evidenceRef: receipt.receiptDigest,
            signature: receipt.semanticFailureDigest
        }
    }
    if (admission.contractId === 'behavior-rejection') {
        const rejection = result.artifacts
            .verificationRejection.evidence
        payload.firstFailure = clone(rejection.firstFailure)
        payload.reworkCount = rejection.reworkCount
    }
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `lifecycle:${digest({
            runId: authority.runId,
            nodeId: node.id,
            actionDigest: action.actionDigest,
            stageResultDigest: result.resultDigest,
            sequence: eventSequence
        })}`,
        sequence: eventSequence,
        runId: authority.runId,
        nodeId: node.id,
        eventType,
        fromState: node.lifecycleState,
        toState: effect.node.lifecycleState,
        attemptId: result.attemptId,
        actorRole: result.actorRole,
        lifecycleAuthorityBinding:
            clone(controlFacts.lifecycleAuthority.binding),
        sourceDagDigest: projected.semanticGraph.semanticGraphDigest,
        issueSnapshotFingerprint:
            registration.issueSnapshotFingerprint,
        repositoryFingerprint:
            registration.repositoryFingerprint,
        baseSha: registration.baseSha,
        payload,
        payloadDigest: stateDigest(payload),
        evidenceRefs: receiptEvidence(effect.receipts),
        createdAt,
        previousEventDigest:
            ledger.events.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = stateDigest(event)
    replayEventLedgerSync({
        header: ledger.header,
        events: [...ledger.events, event]
    })
    return { event, effect }
}

function appendCanonicalNodeResult(arguments_) {
    const compiled = compileCanonicalNodeEvent(arguments_)
    appendNodeEventAtomicSync({
        ...arguments_.authority,
        nodeId: arguments_.node.id,
        event: compiled.event,
        writerRole: 'root-scheduler'
    })
    clearControlFactsCache(arguments_.authority)
    return compiled.effect
}

function appendCanonicalControlEvent({
    authority,
    eventType,
    payload,
    createdAt
}) {
    const controlLedger = readCanonicalControlLedger(authority)
    const event = compileControlEvent({
        ledger: controlLedger,
        eventType,
        payload,
        createdAt,
        lifecycleAuthorityBinding:
            currentControlFacts(authority)
                .lifecycleAuthority.binding
    })
    appendControlEventAtomicSync({
        ...authority,
        event,
        writerRole: 'root-scheduler'
    })
    clearControlFactsCache(authority)
    return event
}

function activeDeliveryFreeze(state, groupId) {
    return Object.entries(state.deliveryFreezes ?? {})
        .find(([, freeze]) =>
            freeze?.active === true && freeze.groupId === groupId) ?? null
}

export function acquireLifecycleDeliveryFreeze({
    ledger,
    actionSet,
    action,
    effectId,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCurrentActionSet(authority, actionSet)
    if (action?.type !== 'deliver-acceptance-group') {
        fail('lifecycle-delivery-freeze-action-invalid')
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        fail('lifecycle-delivery-freeze-action-stale')
    }
    const groupId = requireText(
        action.acceptanceGroup,
        'lifecycle-delivery-group-invalid'
    )
    requireText(effectId, 'lifecycle-delivery-effect-id-invalid')
    const state = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    if (state.deliveryEffects[groupId]) {
        fail('lifecycle-delivery-already-completed')
    }
    const active = activeDeliveryFreeze(state, groupId)
    if (active) {
        if (active[1].effectId !== effectId) {
            fail('lifecycle-delivery-freeze-owner-mismatch')
        }
        return makeHandle(authority)
    }
    appendCanonicalControlEvent({
        authority,
        eventType: 'delivery.freeze-acquired',
        payload: {
            freezeId: groupId,
            groupId,
            effectId,
            actionDigest: action.actionDigest,
            actionSetDigest: actionSet.actionSetDigest,
            acquiredAt: createdAt
        },
        createdAt
    })
    return makeHandle(authority)
}

export function releaseLifecycleDeliveryFreeze({
    ledger,
    groupId,
    effectId,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    requireText(groupId, 'lifecycle-delivery-group-invalid')
    requireText(effectId, 'lifecycle-delivery-effect-id-invalid')
    const state = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    const active = activeDeliveryFreeze(state, groupId)
    if (!active || active[1].effectId !== effectId) {
        fail('lifecycle-delivery-freeze-owner-mismatch')
    }
    appendCanonicalControlEvent({
        authority,
        eventType: 'delivery.freeze-released',
        payload: {
            freezeId: active[0],
            groupId,
            effectId,
            releasedAt: createdAt
        },
        createdAt
    })
    return makeHandle(authority)
}


function exactCleanupAction(authority, actionSet, action) {
    exactCurrentActionSet(authority, actionSet)
    if (action?.type !== 'cleanup-node-resources') {
        fail('lifecycle-cleanup-action-invalid')
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        fail('lifecycle-cleanup-action-stale')
    }
    return action
}

function validateMachineState(value, digestField, code) {
    requireObject(value, code)
    const valueDigest = requireDigest(value[digestField], code)
    if (unsignedDigest(value, digestField) !== valueDigest) fail(code)
    return clone(value)
}

export function recordLifecycleCleanupFinalization({
    ledger,
    actionSet,
    action,
    cleanupState,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCleanupAction(authority, actionSet, action)
    const state = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    const node = state.nodes[action.nodeId]
    if (!node || node.lifecycleState !== 'cleaning' ||
        state.cleanupFinalizations[action.nodeId]) {
        fail('lifecycle-cleanup-finalization-state-invalid')
    }
    requireObject(cleanupState, 'lifecycle-cleanup-state-invalid')
    const receipt = validateMachineState(
        cleanupState.cleanupReceipt,
        'receiptDigest',
        'lifecycle-cleanup-receipt-invalid'
    )
    requireDigest(
        cleanupState.cleanupStateDigest,
        'lifecycle-cleanup-state-invalid'
    )
    if (cleanupState.cleanupStateDigest !==
        digest({ ...cleanupState, cleanupStateDigest: undefined })) {
        fail('lifecycle-cleanup-state-invalid')
    }
    appendCanonicalControlEvent({
        authority,
        eventType: 'cleanup.finalized',
        payload: {
            cleanupId: action.nodeId,
            nodeId: action.nodeId,
            actionDigest: action.actionDigest,
            actionSetDigest: actionSet.actionSetDigest,
            cleanupReceiptDigest: receipt.receiptDigest,
            cleanupArtifactsDigest: cleanupState.cleanupStateDigest,
            cleanupArtifacts: clone(cleanupState),
            finalizedAt: createdAt
        },
        createdAt
    })
    return makeHandle(authority)
}

export function recordLifecycleClosureAuthorization({
    ledger,
    actionSet,
    action,
    effectId,
    authorizationState,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCleanupAction(authority, actionSet, action)
    const state = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    const finalization = state.cleanupFinalizations[action.nodeId]
    if (!finalization ||
        state.pendingClosureAuthorizations[action.nodeId] ||
        state.pendingClosureEffects[action.nodeId] ||
        state.closureEffects[action.nodeId]) {
        fail('lifecycle-closure-authorization-state-invalid')
    }
    requireObject(
        authorizationState,
        'lifecycle-closure-authorization-invalid'
    )
    requireText(effectId, 'lifecycle-closure-effect-id-invalid')
    validateMachineState(
        authorizationState.deliveryControlReceipt,
        'receiptDigest',
        'lifecycle-closure-authorization-invalid'
    )
    validateMachineState(
        authorizationState.preRemoteSnapshot,
        'snapshotDigest',
        'lifecycle-closure-authorization-invalid'
    )
    requireDigest(
        authorizationState.expectedPostStateDigest,
        'lifecycle-closure-post-state-invalid'
    )
    if (authorizationState.effectId !== effectId ||
        authorizationState.cleanupReceiptDigest !==
            finalization.cleanupReceiptDigest) {
        fail('lifecycle-closure-authorization-stale')
    }
    appendCanonicalControlEvent({
        authority,
        eventType: 'closure.authorization-recorded',
        payload: {
            nodeId: action.nodeId,
            effectId,
            cleanupReceiptDigest: finalization.cleanupReceiptDigest,
            authorizationDigest: digest(authorizationState),
            authorizationState: clone(authorizationState),
            authorizedAt: createdAt
        },
        createdAt
    })
    return makeHandle(authority)
}

export function recordLifecycleClosureEffect({
    ledger,
    actionSet,
    action,
    effectId,
    effectState,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCleanupAction(authority, actionSet, action)
    const state = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    const authorization =
        state.pendingClosureAuthorizations[action.nodeId]
    if (!authorization || authorization.effectId !== effectId) {
        fail('lifecycle-closure-effect-authorization-missing')
    }
    requireObject(effectState, 'lifecycle-closure-effect-invalid')
    validateMachineState(
        effectState.postRemoteSnapshot,
        'snapshotDigest',
        'lifecycle-closure-effect-invalid'
    )
    validateMachineState(
        effectState.remoteMutationReceipt,
        'receiptDigest',
        'lifecycle-closure-effect-invalid'
    )
    validateMachineState(
        effectState.closureReceipt,
        'receiptDigest',
        'lifecycle-closure-effect-invalid'
    )
    if (effectState.effectId !== effectId ||
        effectState.cleanupReceiptDigest !==
            authorization.cleanupReceiptDigest ||
        effectState.closureReceipt.cleanupReceiptDigest !==
            authorization.cleanupReceiptDigest ||
        effectState.closureReceipt.remotePreSnapshotDigest !==
            authorization.authorizationState.preRemoteSnapshot
                .snapshotDigest ||
        effectState.closureReceipt.remotePostSnapshotDigest !==
            effectState.postRemoteSnapshot.snapshotDigest) {
        fail('lifecycle-closure-effect-stale')
    }
    appendCanonicalControlEvent({
        authority,
        eventType: 'closure.effect-recorded',
        payload: {
            nodeId: action.nodeId,
            effectId,
            cleanupReceiptDigest:
                authorization.cleanupReceiptDigest,
            effectDigest: digest(effectState),
            effectState: clone(effectState),
            observedAt: createdAt
        },
        createdAt
    })
    return makeHandle(authority)
}

function appendCleanupClosureResult({
    authority,
    actionSet,
    action,
    result,
    createdAt
}) {
    if (action?.type !== 'cleanup-node-resources' ||
        !actionSet.actions.some((candidate) =>
            candidate.actionDigest === action.actionDigest &&
            sameValue(candidate, action))) {
        fail('lifecycle-cleanup-action-stale')
    }
    const current = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    const node = current.nodes[action.nodeId]
    const admission = validateLifecycleStageResult({
        result,
        action,
        node
    })
    const finalization = current.cleanupFinalizations[action.nodeId]
    const pending = current.pendingClosureEffects[action.nodeId]
    if (!finalization || !pending) {
        fail('lifecycle-cleanup-closure-effect-unobserved')
    }
    const cleanupEvidence = admission.artifacts.cleanup.evidence
    const authorityEvidence =
        admission.artifacts.remoteCloseAuthority.evidence
    const preEvidence = admission.artifacts.remotePreSnapshot.evidence
    const postEvidence = admission.artifacts.remotePostSnapshot.evidence
    const closureEvidence = admission.artifacts.closure.evidence
    if (cleanupEvidence.machineCleanupReceiptDigest !==
            finalization.cleanupReceiptDigest ||
        authorityEvidence.deliveryControlReceiptDigest !==
            pending.authorizationState.deliveryControlReceipt
                .receiptDigest ||
        preEvidence.machineSnapshotDigest !==
            pending.authorizationState.preRemoteSnapshot.snapshotDigest ||
        postEvidence.machineSnapshotDigest !==
            pending.effectState.postRemoteSnapshot.snapshotDigest ||
        closureEvidence.machineClosureReceiptDigest !==
            pending.effectState.closureReceipt.receiptDigest ||
        closureEvidence.remoteMutationReceiptDigest !==
            pending.effectState.remoteMutationReceipt.receiptDigest) {
        fail('lifecycle-cleanup-closure-result-stale')
    }
    appendCanonicalNodeResult({
        authority,
        actionSet,
        action,
        result,
        node,
        createdAt
    })
    appendCanonicalControlEvent({
        authority,
        eventType: 'closure.effect-completed',
        payload: {
            nodeId: action.nodeId,
            effectId: pending.effectId,
            cleanupReceiptDigest: finalization.cleanupReceiptDigest,
            completedAt: createdAt
        },
        createdAt
    })
}

export function recordLifecycleCleanupClosureResult({
    ledger,
    actionSet,
    action,
    result,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCleanupAction(authority, actionSet, action)
    appendCleanupClosureResult({
        authority,
        actionSet,
        action,
        result,
        createdAt
    })
    return makeHandle(authority)
}

function exactTerminalAction(authority, actionSet, action) {
    exactCurrentActionSet(authority, actionSet)
    if (action?.type !== 'terminalize-node') {
        fail('lifecycle-terminal-action-invalid')
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        fail('lifecycle-terminal-action-stale')
    }
    return action
}

export function recordLifecycleTerminalizationResult({
    ledger,
    actionSet,
    action,
    result,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactTerminalAction(authority, actionSet, action)
    const current = replayLifecycleRunLedger(authority, {
        startup: authority.startup
    })
    const node = current.nodes[action.nodeId]
    if (!node || node.receipts?.terminal ||
        node.receipts?.recoveryFingerprint ||
        node.receipts?.retentionState) {
        fail('lifecycle-terminal-state-invalid')
    }
    const admission = validateLifecycleStageResult({
        result,
        action,
        node
    })
    if (admission.contractId !== 'terminalization') {
        fail('lifecycle-terminal-result-invalid')
    }
    const terminal = admission.artifacts.terminal.evidence
    const retention = admission.artifacts.retentionState.evidence
    const candidate = action.bindings.terminalCandidate
    if (candidate) {
        if (terminal.policyVersion !== candidate.policyVersion ||
            terminal.category !== candidate.category ||
            terminal.firstFailureDigest !==
                candidate.firstFailureDigest ||
            terminal.directEvidenceDigest !==
                candidate.directEvidenceDigest ||
            terminal.recoveryExhaustionDigest !==
                candidate.recoveryExhaustionDigest) {
            fail('lifecycle-terminal-result-stale')
        }
    } else {
        const firstFailure = action.bindings.firstFailure ??
            action.bindings.quarantine
        if (!firstFailure || terminal.firstFailureDigest !==
                digest(firstFailure)) {
            fail('lifecycle-terminal-result-stale')
        }
    }
    if (retention.retainedResources.some((resource) =>
        resource.ownerNodeId !== action.nodeId)) {
        fail('lifecycle-terminal-retention-owner-invalid')
    }
    appendCanonicalNodeResult({
        authority,
        actionSet,
        action,
        result,
        node,
        createdAt
    })
    return makeHandle(authority)
}

function exactIdleFinalizationAction(authority, actionSet, action) {
    exactCurrentActionSet(authority, actionSet)
    if (action?.type !== 'idle' ||
        actionSet?.quiescent !== true ||
        actionSet.actions?.length !== 1) {
        fail('lifecycle-finalization-action-invalid')
    }
    const current = actionSet.actions[0]
    if (!sameValue(current, action)) {
        fail('lifecycle-finalization-action-stale')
    }
    return action
}

export function recordLifecycleRunTerminalization({
    ledger,
    actionSet,
    action,
    terminalization,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactIdleFinalizationAction(authority, actionSet, action)
    const facts = currentControlFacts(authority)
    if (facts.controlProjection.terminal) {
        fail('lifecycle-finalization-already-terminal')
    }
    const payload = requireObject(
        terminalization,
        'lifecycle-finalization-payload-invalid'
    )
    if (payload.schema !==
            'issue-orchestration.run-terminalization.v1' ||
        payload.status !== 'quiescent' ||
        !Array.isArray(payload.violations) ||
        payload.violations.length !== 0) {
        fail('lifecycle-finalization-status-invalid')
    }
    if (payload.actionDigest !== action.actionDigest ||
        payload.actionSetDigest !== actionSet.actionSetDigest ||
        payload.aggregateProjectionDigest !==
            action.bindings.aggregateProjectionDigest ||
        payload.preTerminalControlEventDigest !==
            facts.controlProjection.lastEventDigest) {
        fail('lifecycle-finalization-binding-stale')
    }
    for (const field of [
        'receiptDigest',
        'observationDigest',
        'verifierIdentityDigest',
        'completedIssueEvidenceDigest'
    ]) requireDigest(
        payload[field],
        `lifecycle-finalization-${field}-invalid`
    )
    const receipt = requireObject(
        payload.quiescenceReceipt,
        'lifecycle-finalization-receipt-invalid'
    )
    if (receipt.receiptDigest !== payload.receiptDigest ||
        receipt.observationDigest !== payload.observationDigest ||
        receipt.status !== 'quiescent' ||
        !Array.isArray(receipt.violations) ||
        receipt.violations.length !== 0) {
        fail('lifecycle-finalization-receipt-stale')
    }
    appendCanonicalControlEvent({
        authority,
        eventType: 'run.terminalized',
        payload,
        createdAt
    })
    return makeHandle(authority)
}

export function recordLifecycleDispatchBatchStarted({
    ledger,
    actionSet,
    dispatches,
    failedActionDigests = [],
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCurrentActionSet(authority, actionSet)
    if (!Array.isArray(dispatches) || dispatches.length === 0) {
        fail('lifecycle-dispatch-batch-empty')
    }
    const actorActions = actionSet.actions.filter(({ type }) =>
        DISPATCHABLE_ACTION_TYPES.has(type))
    if (actorActions.length === 0) {
        fail('lifecycle-dispatch-batch-incomplete')
    }
    const actorActionByDigest = new Map(actorActions.map((action) => [
        action.actionDigest,
        action
    ]))
    if (!Array.isArray(failedActionDigests) ||
        new Set(failedActionDigests).size !== failedActionDigests.length) {
        fail('lifecycle-dispatch-preparation-failures-invalid')
    }
    for (const actionDigest of failedActionDigests) {
        requireDigest(
            actionDigest,
            'lifecycle-dispatch-preparation-failure-digest-invalid'
        )
        if (!actorActionByDigest.has(actionDigest)) {
            fail('lifecycle-dispatch-preparation-failure-unknown')
        }
    }
    const metadataByDigest = new Map()
    for (const metadata of dispatches) {
        requireObject(metadata, 'lifecycle-dispatch-metadata-invalid')
        const actionDigest = requireDigest(
            metadata.actionDigest,
            'lifecycle-dispatch-action-digest-invalid'
        )
        if (!actorActionByDigest.has(actionDigest)) {
            fail('lifecycle-dispatch-batch-unknown-action')
        }
        if (metadataByDigest.has(actionDigest)) {
            fail('lifecycle-dispatch-metadata-duplicate')
        }
        metadataByDigest.set(actionDigest, metadata)
    }
    const acceptedActionDigests = [...metadataByDigest.keys()]
    if (failedActionDigests.some((actionDigest) =>
        metadataByDigest.has(actionDigest))) {
        fail('lifecycle-dispatch-preparation-partition-overlap')
    }
    const expectedFailedActionDigests = actorActions
        .filter((action) => !metadataByDigest.has(action.actionDigest))
        .map(({ actionDigest }) => actionDigest)
        .sort()
    if (!sameValue(
        [...failedActionDigests].sort(),
        expectedFailedActionDigests
    ) || acceptedActionDigests.length + failedActionDigests.length !==
        actorActions.length) {
        fail('lifecycle-dispatch-preparation-partition-invalid')
    }
    const attemptIdentities = dispatches.map((metadata) =>
        `${metadata.nodeId}:${metadata.attemptId}`)
    if (new Set(attemptIdentities).size !== attemptIdentities.length) {
        fail('lifecycle-dispatch-attempt-duplicate')
    }
    for (const [field, code] of [
        ['slotId', 'lifecycle-dispatch-slot-duplicate'],
        ['runtimeBindingDigest', 'lifecycle-dispatch-runtime-duplicate'],
        ['leaseDigest', 'lifecycle-dispatch-lease-duplicate'],
        ['resourceDigest', 'lifecycle-dispatch-resource-duplicate']
    ]) {
        const values = dispatches.map((metadata) => metadata[field])
        if (new Set(values).size !== values.length) {
            fail(code)
        }
    }
    const receipts = actorActions
        .filter((action) => metadataByDigest.has(action.actionDigest))
        .map((action) => {
        const metadata = metadataByDigest.get(action.actionDigest)
        for (const [field, code] of [
            ['owner', 'lifecycle-dispatch-owner-invalid'],
            ['attemptId', 'lifecycle-dispatch-attempt-invalid'],
            ['slotId', 'lifecycle-dispatch-slot-invalid']
        ]) requireText(metadata[field], code)
        for (const [field, code] of [
            ['runtimeBindingDigest', 'lifecycle-dispatch-runtime-invalid'],
            ['leaseDigest', 'lifecycle-dispatch-lease-invalid'],
            ['resourceDigest', 'lifecycle-dispatch-resource-invalid']
        ]) requireDigest(metadata[field], code)
        if (metadata.nodeId !== action.nodeId) {
            fail('lifecycle-dispatch-node-mismatch')
        }
        const receipt = {
            schema: 'issue-orchestration.lifecycle-dispatch-start.v1',
            dispatchId: `dispatch:${digest({
                runId: authority.runId,
                actionDigest: action.actionDigest,
                attemptId: metadata.attemptId,
                slotId: metadata.slotId
            })}`,
            actionDigest: action.actionDigest,
            actionSetDigest: actionSet.actionSetDigest,
            actionBindingsDigest: digest(action.bindings),
            actionType: action.type,
            owner: metadata.owner,
            executionClass: 'actor',
            nodeId: action.nodeId,
            attemptId: metadata.attemptId,
            slotId: metadata.slotId,
            runtimeBindingDigest: metadata.runtimeBindingDigest,
            leaseDigest: metadata.leaseDigest,
            resourceDigest: metadata.resourceDigest,
            action: clone(action),
            actionSet: clone(actionSet),
            startedAt: createdAt
        }
        receipt.receiptDigest = digest(receipt)
        return Object.freeze(receipt)
    })
    const batch = {
        schema: 'issue-orchestration.lifecycle-dispatch-batch.v1',
        actionSetDigest: actionSet.actionSetDigest,
        actionDigests: receipts.map(({ actionDigest }) => actionDigest).sort(),
        dispatchIds: receipts.map(({ dispatchId }) => dispatchId).sort(),
        failedActionDigests: [...failedActionDigests].sort(),
        createdAt
    }
    batch.batchDigest = digest(batch)
    appendCanonicalControlEvent({
        authority,
        eventType: 'dispatch-batch.recorded',
        payload: batch,
        createdAt
    })
    for (const receipt of receipts) {
        appendCanonicalControlEvent({
            authority,
            eventType: 'dispatch.action-started',
            payload: receipt,
            createdAt
        })
    }
    return Object.freeze({
        ledger: makeHandle(authority),
        batch: Object.freeze(batch),
        dispatches: Object.freeze(receipts)
    })
}

function currentNodeForDispatchedResult(authority, action) {
    const facts = currentControlFacts(authority)
    const recovered = facts.recovered
    const registration = facts.controlProjection.nodes[action.nodeId]
    const entry = recovered.nodeIndex.nodes[action.nodeId]
    const nodeProjection = recovered.nodeProjections[action.nodeId]
    const node = currentCompatibilityState({
        ...facts,
        recovered,
        semanticGraph: currentSemanticGraph({
            ...facts,
            recovered
        })
    }).nodes[action.nodeId]
    if (!registration || entry?.status !== 'verified' || !nodeProjection ||
        !node) {
        fail('lifecycle-dispatch-node-unavailable')
    }
    const binding = facts.lifecycleAuthority.binding
    const expected = {
        runId: authority.runId,
        nodeId: registration.nodeId,
        memberId: registration.memberId,
        repository: registration.repository,
        issueNumber: registration.issueNumber,
        baseSha: registration.baseSha,
        nodeEpoch: registration.nodeEpoch,
        selectorReceiptDigest: facts.selectorReceipt.receiptDigest,
        remoteSnapshotDigest: facts.remoteSnapshotReceipt.receiptDigest,
        nodeProjectionDigest: entry.projectionDigest,
        priorLedgerHeadDigest: entry.ledgerHeadDigest,
        policyDigest: facts.genesis.installedPolicy.policyDigest,
        runtimeCapabilityBindingDigest:
            facts.lifecycleAuthority.runtimeCapabilityBinding.bindingDigest,
        lifecycleAuthorityBindingDigest: binding.bindingDigest,
        startupAttestationDigest: binding.startupAttestationDigest,
        runtimeInvocationId: binding.runtimeInvocationId,
        runtimeSessionId: binding.runtimeSessionId,
        rootAuthorityEpoch: binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest: binding.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest: binding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest: binding.repositoryBindingSetDigest,
        repositoryBindingDigest: registration.repositoryBindingDigest,
        packageDigest: binding.packageDigest,
        manifestDigest: binding.manifestDigest,
        policySetDigest: binding.policySetDigest
    }
    for (const [field, value] of Object.entries(expected)) {
        if (!sameValue(action.bindings[field], value)) {
            fail('lifecycle-dispatch-result-stale', { field })
        }
    }
    return { node, nodeProjection }
}

function existingDispatchedNodeEvent(authority, dispatch, result) {
    const ledger = readCanonicalNodeLedger({
        ...authority,
        nodeId: dispatch.nodeId,
        nodeEpoch: dispatch.action.bindings.nodeEpoch
    })
    return ledger.events.find((event) =>
        event.payload?.action?.actionDigest === dispatch.actionDigest &&
        event.payload?.stageResult?.resultDigest === result.resultDigest)
        ?? null
}

const EXPLICIT_DISPATCH_EXCLUSION_CODES = new Set([
    'dispatcher-active-result-base-stale',
    'dispatcher-actor-result-invalid'
])

const ISOLATABLE_DISPATCH_RESULT_CODES = new Set([
    'lifecycle-stage-result-invalid',
    'lifecycle-dispatch-result-digest-invalid',
    'lifecycle-dispatch-result-identity-mismatch',
    'lifecycle-dispatch-result-stale',
    'lifecycle-dispatch-node-unavailable'
])

function isolatableDispatchResultError(error) {
    return error instanceof LifecycleStageAdmissionError ||
        (error instanceof LifecycleRunLoopError &&
            ISOLATABLE_DISPATCH_RESULT_CODES.has(error.code))
}

function activeDispatch(authority, dispatchId) {
    return currentControlFacts(authority)
        .controlProjection.activeDispatches[dispatchId] ?? null
}

function appendDispatchSettlement({
    authority,
    dispatch,
    resultDigest,
    outcome,
    exclusionCode = null,
    failureFamily = null,
    createdAt
}) {
    const effectiveResultDigest = HASH.test(resultDigest ?? '')
        ? resultDigest
        : digest({
            dispatchId: dispatch.dispatchId,
            actionDigest: dispatch.actionDigest,
            outcome,
            exclusionCode
        })
    const settlement = {
        schema: 'issue-orchestration.lifecycle-dispatch-settlement.v1',
        dispatchId: dispatch.dispatchId,
        actionDigest: dispatch.actionDigest,
        resultDigest: effectiveResultDigest,
        outcome,
        ...(outcome === 'excluded' ? {
            exclusionCode: requireText(
                exclusionCode,
                'lifecycle-dispatch-exclusion-code-invalid'
            )
        } : outcome === 'failed' ? {
            failureFamily: requireText(
                failureFamily,
                'lifecycle-dispatch-failure-family-invalid'
            )
        } : {}),
        settledAt: createdAt
    }
    settlement.settlementDigest = digest(settlement)
    appendCanonicalControlEvent({
        authority,
        eventType: 'dispatch.action-settled',
        payload: settlement,
        createdAt
    })
    return Object.freeze(settlement)
}

function recordDispatchedActionResultWithAuthority({
    authority,
    dispatchId,
    result,
    createdAt,
    settlementOutcome = 'completed',
    failureFamily = null
}) {
    requireText(dispatchId, 'lifecycle-dispatch-id-invalid')
    requireObject(result, 'lifecycle-stage-result-invalid')
    requireDigest(
        result.resultDigest,
        'lifecycle-dispatch-result-digest-invalid'
    )
    const dispatch = activeDispatch(authority, dispatchId)
    if (!dispatch) fail('lifecycle-dispatch-not-active')
    if (dispatch.actionDigest !== result.actionDigest ||
        dispatch.attemptId !== result.attemptId) {
        fail('lifecycle-dispatch-result-identity-mismatch')
    }
    const action = dispatch.action
    const actionSet = dispatch.actionSet
    let effect = null
    const existing = existingDispatchedNodeEvent(
        authority,
        dispatch,
        result
    )
    if (existing && !sameValue(existing.payload.stageResult, result)) {
        fail('lifecycle-dispatch-result-replay-mismatch')
    }
    if (!existing) {
        const { node } = currentNodeForDispatchedResult(authority, action)
        validateLifecycleStageResult({ result, action, node })
        effect = appendCanonicalNodeResult({
            authority,
            actionSet,
            action,
            result,
            node,
            createdAt
        })
    }
    const settlement = appendDispatchSettlement({
        authority,
        dispatch,
        resultDigest: result.resultDigest,
        outcome: settlementOutcome,
        failureFamily,
        createdAt
    })
    return Object.freeze({
        dispatchId,
        effect,
        settlement,
        replayedExistingResult: existing !== null
    })
}

function excludeDispatchedActionWithAuthority({
    authority,
    dispatchId,
    exclusionCode,
    resultDigest = null,
    createdAt
}) {
    requireText(dispatchId, 'lifecycle-dispatch-id-invalid')
    const dispatch = activeDispatch(authority, dispatchId)
    if (!dispatch) fail('lifecycle-dispatch-not-active')
    const settlement = appendDispatchSettlement({
        authority,
        dispatch,
        resultDigest,
        outcome: 'excluded',
        exclusionCode,
        createdAt
    })
    return Object.freeze({
        dispatchId,
        exclusionCode,
        settlement
    })
}

export function recordLifecycleDispatchedActionResultBatch({
    ledger,
    entries,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    if (!Array.isArray(entries) || entries.length === 0) {
        fail('lifecycle-dispatch-result-batch-empty')
    }
    const normalized = entries.map((entry) => {
        requireObject(entry, 'lifecycle-dispatch-result-entry-invalid')
        const dispatchId = requireText(
            entry.dispatchId,
            'lifecycle-dispatch-id-invalid'
        )
        const modes = [
            entry.exclusionCode !== undefined,
            entry.stageFailure !== undefined,
            entry.result !== undefined
        ].filter(Boolean).length
        if (modes !== 1) {
            fail('lifecycle-dispatch-result-entry-mode-invalid')
        }
        if (entry.exclusionCode !== undefined) {
            const code = requireText(
                entry.exclusionCode,
                'lifecycle-dispatch-exclusion-code-invalid'
            )
            if (!EXPLICIT_DISPATCH_EXCLUSION_CODES.has(code)) {
                fail('lifecycle-dispatch-exclusion-code-invalid')
            }
            return {
                dispatchId,
                exclusionCode: code,
                resultDigest: entry.resultDigest ?? null
            }
        }
        if (entry.stageFailure !== undefined) {
            const dispatch = activeDispatch(authority, dispatchId)
            if (!dispatch) fail('lifecycle-dispatch-not-active')
            const admitted = validateLifecycleActorStageFailure(
                entry.stageFailure,
                { dispatch }
            )
            return {
                dispatchId,
                stageFailure: admitted.failure,
                failureFamily: admitted.family,
                result: admitted.result
            }
        }
        return { dispatchId, result: entry.result }
    }).sort((left, right) =>
        left.dispatchId.localeCompare(right.dispatchId))
    if (new Set(normalized.map(({ dispatchId }) => dispatchId)).size !==
        normalized.length) {
        fail('lifecycle-dispatch-result-batch-duplicate')
    }
    const admitted = []
    const failed = []
    const excluded = []
    for (const entry of normalized) {
        if (entry.exclusionCode !== undefined) {
            excluded.push(excludeDispatchedActionWithAuthority({
                authority,
                ...entry,
                createdAt
            }))
            continue
        }
        try {
            const recorded = recordDispatchedActionResultWithAuthority({
                authority,
                dispatchId: entry.dispatchId,
                result: entry.result,
                createdAt,
                settlementOutcome: entry.stageFailure
                    ? 'failed'
                    : 'completed',
                failureFamily: entry.failureFamily ?? null
            })
            if (entry.stageFailure) failed.push(recorded)
            else admitted.push(recorded)
        } catch (error) {
            if (!isolatableDispatchResultError(error)) throw error
            if (!activeDispatch(authority, entry.dispatchId)) {
                excluded.push(Object.freeze({
                    dispatchId: entry.dispatchId,
                    exclusionCode: error.code,
                    settlement: null
                }))
                continue
            }
            excluded.push(excludeDispatchedActionWithAuthority({
                authority,
                dispatchId: entry.dispatchId,
                exclusionCode: error.code,
                resultDigest: entry.result?.resultDigest ?? null,
                createdAt
            }))
        }
    }
    return Object.freeze({
        ledger: makeHandle(authority),
        admitted: Object.freeze(admitted),
        failed: Object.freeze(failed),
        excluded: Object.freeze(excluded)
    })
}

export function recordLifecycleDispatchedActionResult({
    ledger,
    dispatchId,
    result,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    const recorded = recordDispatchedActionResultWithAuthority({
        authority,
        dispatchId,
        result,
        createdAt
    })
    return Object.freeze({
        ledger: makeHandle(authority),
        effect: recorded.effect,
        replayedExistingResult: recorded.replayedExistingResult
    })
}

export function recordLifecycleCurrentActionResult({
    ledger,
    actionSet,
    actionDigest,
    result,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    exactCurrentActionSet(authority, actionSet)
    const action = actionSet.actions.find((candidate) =>
        candidate.actionDigest === actionDigest)
    if (!action) fail('lifecycle-current-action-missing')
    if (DISPATCHABLE_ACTION_TYPES.has(action.type) ||
        action.type !== 'compile-acceptance-contract') {
        fail('lifecycle-current-action-recorder-forbidden')
    }
    requireObject(result, 'lifecycle-stage-result-invalid')
    if (result.actionDigest !== action.actionDigest) {
        fail('lifecycle-current-action-result-mismatch')
    }
    const projected = projectLifecycleRun(authority, {
        startup: authority.startup
    })
    const node = projected.state.nodes[action.nodeId]
    if (!node) fail('lifecycle-current-action-node-missing')
    validateLifecycleStageResult({ result, action, node })
    const effect = appendCanonicalNodeResult({
        authority,
        actionSet,
        action,
        result,
        node,
        createdAt
    })
    return Object.freeze({
        ledger: makeHandle(authority),
        effect
    })
}

export function recordLifecycleActionResults({
    ledger,
    actionSet,
    stageResults,
    actorResults,
    createdAt,
    startup
} = {}) {
    if (actorResults !== undefined) {
        fail('lifecycle-generic-actor-results-forbidden')
    }
    const authority = resolveAuthority(ledger, startup)
    exactCurrentActionSet(authority, actionSet)
    if (actionSet.actions.some(({ type }) =>
        type === 'terminalize-node')) {
        fail('lifecycle-terminal-direct-recording-forbidden')
    }
    if (!Array.isArray(stageResults) ||
        stageResults.length !== actionSet.actions.length ||
        actionSet.actions.some(({ type }) => type === 'idle' ||
            type === 'refresh-scope')) {
        fail('lifecycle-stage-results-incomplete')
    }
    const byDigest = new Map()
    for (const result of stageResults) {
        requireObject(result, 'lifecycle-stage-result-invalid')
        const actionDigest = requireDigest(
            result.actionDigest,
            'lifecycle-stage-result-action-digest-invalid'
        )
        if (byDigest.has(actionDigest)) {
            fail('lifecycle-stage-result-duplicate')
        }
        byDigest.set(actionDigest, result)
    }

    for (const action of actionSet.actions) {
        const result = byDigest.get(action.actionDigest)
        if (action.type === 'deliver-acceptance-group') {
            const admission = validateLifecycleStageResult({
                result,
                action,
                node: null
            })
            const state = replayLifecycleRunLedger(authority, {
                startup: authority.startup
            })
            const groupId = requireText(
                action.acceptanceGroup,
                'lifecycle-delivery-group-invalid'
            )
            const effectId = requireText(
                admission.artifacts.remoteEffect.evidence.effectId,
                'lifecycle-delivery-effect-id-invalid'
            )
            const remoteEffectEvidence =
                admission.artifacts.remoteEffect.evidence
            const commits = clone(remoteEffectEvidence.commits)
            const observedEffect = {
                groupId,
                effectId,
                status: 'remote-effect-applied',
                commits,
                candidateMappingDigest:
                    remoteEffectEvidence.candidateMappingDigest ?? null,
                landingReceiptDigest:
                    remoteEffectEvidence.landingReceiptDigest ?? null,
                landingReceiptDigests: clone(
                    remoteEffectEvidence.landingReceiptDigests ?? {}
                ),
                repositoryEffects: clone(
                    remoteEffectEvidence.repositoryEffects ?? []
                ),
                remotePreStateDigest:
                    admission.artifacts.remotePreSnapshot
                        .evidence.remoteStateDigest,
                remotePostStateDigest:
                    admission.artifacts.remotePostSnapshot
                        .evidence.remoteStateDigest,
                remoteMutationReceiptDigest:
                    admission.artifacts.remoteMutationAuthority
                        .receiptDigest,
                deliveryControlReceiptDigest:
                    admission.artifacts.deliveryControl.receiptDigest
            }
            const pending = state.pendingDeliveryEffects[groupId]
            let freeze = activeDeliveryFreeze(state, groupId)
            if (admission.deliveryPhase === 'remote-effect-applied') {
                if (pending && !sameValue(pending, observedEffect)) {
                    fail('lifecycle-delivery-effect-conflict')
                }
                if (!freeze) {
                    appendCanonicalControlEvent({
                        authority,
                        eventType: 'delivery.freeze-acquired',
                        payload: {
                            freezeId: groupId,
                            groupId,
                            effectId,
                            actionDigest: action.actionDigest,
                            actionSetDigest: actionSet.actionSetDigest,
                            acquiredAt: createdAt
                        },
                        createdAt
                    })
                    freeze = [groupId, {
                        freezeId: groupId,
                        groupId,
                        effectId,
                        active: true
                    }]
                } else if (freeze[1].effectId !== effectId) {
                    fail('lifecycle-delivery-freeze-owner-mismatch')
                }
                if (!pending) {
                    appendCanonicalControlEvent({
                        authority,
                        eventType: 'delivery.effect-recorded',
                        payload: observedEffect,
                        createdAt
                    })
                }
                continue
            }
            if (admission.deliveryPhase !== 'completed') {
                fail('lifecycle-delivery-result-incomplete')
            }
            if (!pending || pending.effectId !== effectId) {
                fail('lifecycle-delivery-effect-unobserved')
            }
            const completionMatchesPending =
                sameValue(commits, pending.commits) &&
                remoteEffectEvidence.candidateMappingDigest ===
                    pending.candidateMappingDigest &&
                remoteEffectEvidence.landingReceiptDigest ===
                    pending.landingReceiptDigest &&
                sameValue(
                    remoteEffectEvidence.landingReceiptDigests ?? {},
                    pending.landingReceiptDigests ?? {}
                ) &&
                sameValue(
                    remoteEffectEvidence.repositoryEffects ?? [],
                    pending.repositoryEffects ?? []
                ) &&
                observedEffect.remotePreStateDigest ===
                    pending.remotePreStateDigest &&
                observedEffect.remotePostStateDigest ===
                    pending.remotePostStateDigest
            if (!completionMatchesPending) {
                fail('lifecycle-delivery-completion-effect-stale')
            }
            if (!freeze || freeze[1].effectId !== effectId) {
                fail('lifecycle-delivery-freeze-owner-mismatch')
            }
            for (const { nodeId } of action.bindings.memberBindings) {
                const current = replayLifecycleRunLedger(authority, {
                    startup: authority.startup
                })
                const node = current.nodes[nodeId]
                if (node.lifecycleState === 'cleaning') {
                    if (node.deliveryCommit !== commits[nodeId]) {
                        fail('lifecycle-delivery-member-commit-conflict')
                    }
                    continue
                }
                appendCanonicalNodeResult({
                    authority,
                    actionSet,
                    action,
                    result,
                    node,
                    createdAt
                })
            }
            appendCanonicalControlEvent({
                authority,
                eventType: 'delivery.effect-completed',
                payload: {
                    groupId,
                    effectId,
                    commits
                },
                createdAt
            })
            appendCanonicalControlEvent({
                authority,
                eventType: 'delivery.freeze-released',
                payload: {
                    freezeId: freeze[0],
                    groupId,
                    effectId,
                    releasedAt: createdAt
                },
                createdAt
            })
            continue
        }

        const current = replayLifecycleRunLedger(authority, {
            startup: authority.startup
        })
        const node = current.nodes[action.nodeId]
        const admission = validateLifecycleStageResult({
            result,
            action,
            node
        })
        if (action.type === 'cleanup-node-resources') {
            appendCleanupClosureResult({
                authority,
                actionSet,
                action,
                result,
                createdAt
            })
            continue
        }
        appendCanonicalNodeResult({
            authority,
            actionSet,
            action,
            result,
            node,
            createdAt
        })
    }
    return makeHandle(authority)
}

function currentNodeLedgers(authority, controlProjection) {
    return Object.entries(controlProjection.nodes)
        .filter(([, registration]) => registration.status === 'active')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, registration]) => readCanonicalNodeLedger({
            ...authority,
            nodeId,
            nodeEpoch: registration.nodeEpoch
        }))
}

function appendControlInMemory(
    ledger,
    eventType,
    payload,
    createdAt,
    lifecycleAuthorityBinding = null
) {
    ledger.events.push(compileControlEvent({
        ledger,
        eventType,
        payload,
        createdAt,
        lifecycleAuthorityBinding
    }))
    return ledger.events.at(-1)
}

function lifecycleNodeIdentity(nodeId) {
    const separator = nodeId.lastIndexOf('#')
    if (separator <= 0) {
        fail('lifecycle-scope-refresh-node-identity-invalid', { nodeId })
    }
    const repository = nodeId.slice(0, separator)
    const issueNumber = Number(nodeId.slice(separator + 1))
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        fail('lifecycle-scope-refresh-node-identity-invalid', { nodeId })
    }
    return { repository, issueNumber }
}

function refreshedGraphNode({
    nodeId,
    prior = null,
    selector,
    remote,
    repositoryBindingDigest
}) {
    const identity = lifecycleNodeIdentity(nodeId)
    const base = prior?.graphNode ?? prior ?? {}
    return {
        id: nodeId,
        memberId: nodeId,
        repository: identity.repository,
        issueNumber: identity.issueNumber,
        owner: base.owner ?? 'semantic-owner-unresolved',
        dependencyKeys: [...(base.dependencyKeys ?? [])],
        conflictKeys: [...(base.conflictKeys ?? [])],
        riskClass: base.riskClass ?? 'unclassified',
        uiClass: base.uiClass ?? 'unclassified',
        acceptanceGroup: base.acceptanceGroup ?? null,
        lifecycleState: 'none',
        selectorReceiptDigest: selector.receiptDigest,
        remoteSnapshotDigest: remote.receiptDigest,
        repositoryBindingDigest,
        semanticFactsDigest: digest({
            priorSemanticFactsDigest: base.semanticFactsDigest ?? null,
            remoteMemberDigest: selector.remoteFactDigests[nodeId],
            selectorReceiptDigest: selector.receiptDigest
        }),
        contractDigest: null,
        receipts: {}
    }
}

export function recordLifecycleScopeRefresh({
    ledger,
    actionSet,
    selectorReceipt,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    const current = compileLifecycleRunActionSet(authority, {
        observedSelectorReceipt: selectorReceipt,
        startup: authority.startup
    })
    if (!sameValue(current, actionSet) ||
        actionSet.actions.length !== 1 ||
        actionSet.actions[0].type !== 'refresh-scope') {
        fail('lifecycle-scope-refresh-action-required')
    }
    const facts = currentControlFacts(authority)
    const selector = verifySelectorReceipt(selectorReceipt)
    const binding = facts.lifecycleAuthority.binding
    if (selector.lifecycleAuthorityBindingDigest !==
            binding.bindingDigest ||
        selector.startupAttestationDigest !==
            binding.startupAttestationDigest ||
        selector.runtimeInvocationId !== binding.runtimeInvocationId ||
        selector.runtimeSessionId !== binding.runtimeSessionId ||
        selector.rootAuthorityEpoch !== binding.rootAuthorityEpoch ||
        selector.runtimeTrustBindingDigest !==
            binding.runtimeTrustBindingDigest ||
        selector.repositoryBindingSetDigest !==
            binding.repositoryBindingSetDigest ||
        selector.previousRemoteSnapshotDigest !==
            facts.selectorReceipt.remoteSnapshotDigest) {
        fail('lifecycle-scope-refresh-authority-stale')
    }

    const changeSet = selector.remoteChangeSet ?? {}
    const added = [...new Set(changeSet.added ?? [])].sort()
    const changed = [...new Set(changeSet.changed ?? [])].sort()
    const removed = [...new Set(changeSet.removed ?? [])].sort()
    const reopened = [...new Set(changeSet.reopened ?? [])].sort()
    const changedNodeIds = [...new Set([
        ...added,
        ...changed,
        ...removed,
        ...reopened
    ])].sort()
    if (changedNodeIds.length === 0) {
        fail('lifecycle-scope-refresh-without-change')
    }
    const selected = new Set(selector.resolvedIssueSet)
    const remote = compileLifecycleRemoteSnapshotReceipt(selector)
    const controlLedger = clone(facts.controlLedger)
    appendControlInMemory(controlLedger, 'scope.refreshed', {
        selectorReceiptDigest: selector.receiptDigest,
        selectorReceipt: selector,
        changedNodeIds,
        remoteChangeSet: clone(selector.remoteChangeSet)
    }, createdAt, binding)
    appendControlInMemory(controlLedger, 'remote-snapshot.refreshed', {
        remoteSnapshotDigest: remote.receiptDigest,
        remoteSnapshotReceipt: remote
    }, createdAt, binding)

    const changedSet = new Set([...changed, ...reopened])
    const removedSet = new Set(removed)
    const nodeLedgers = []
    const projected = projectLifecycleRun(authority, {
        startup: authority.startup
    })
    const graphById = new Map(projected.semanticGraph.nodes.map(
        (node) => [node.id, node]
    ))

    for (const [nodeId, registration] of Object.entries(
        facts.controlProjection.nodes
    ).sort(([left], [right]) => left.localeCompare(right))) {
        if (removedSet.has(nodeId)) {
            if (registration.status === 'active') {
                appendControlInMemory(controlLedger, 'node.removed', {
                    nodeId,
                    reason: 'left-selector-scope',
                    selectorReceiptDigest: selector.receiptDigest
                }, createdAt, binding)
            }
            continue
        }
        if (!selected.has(nodeId)) continue
        if (registration.status !== 'active') {
            const repository = facts.controlProjection.repositoryBases[
                registration.repository
            ]
            const graphNode = refreshedGraphNode({
                nodeId,
                prior: registration,
                selector,
                remote,
                repositoryBindingDigest:
                    repository.repositoryBindingDigest
            })
            const next = nodeRegistration({
                graphNode,
                nodeEpoch: registration.nodeEpoch + 1,
                repository: {
                    repository: repository.repository,
                    baseSha: repository.baseSha,
                    bindingDigest:
                        repository.repositoryBindingDigest
                },
                selectorReceipt: selector,
                lifecycleAuthority: facts.lifecycleAuthority
            })
            appendControlInMemory(
                controlLedger,
                'node.reopened',
                next,
                createdAt,
                binding
            )
            nodeLedgers.push(nodeLedgerForRegistration({
                registration: next,
                runId: authority.runId,
                stateRoot: authority.stateRoot,
                createdAt
            }))
            continue
        }
        if (!changedSet.has(nodeId)) {
            nodeLedgers.push(readCanonicalNodeLedger({
                ...authority,
                nodeId,
                nodeEpoch: registration.nodeEpoch
            }))
            continue
        }
        const repository = facts.controlProjection.repositoryBases[
            registration.repository
        ]
        const graphNode = refreshedGraphNode({
            nodeId,
            prior: graphById.get(nodeId) ?? registration,
            selector,
            remote,
            repositoryBindingDigest:
                repository.repositoryBindingDigest
        })
        const rebound = nodeRegistration({
            graphNode,
            nodeEpoch: registration.nodeEpoch + 1,
            repository: {
                repository: repository.repository,
                baseSha: repository.baseSha,
                bindingDigest: repository.repositoryBindingDigest
            },
            selectorReceipt: selector,
            lifecycleAuthority: facts.lifecycleAuthority
        })
        appendControlInMemory(
            controlLedger,
            'node.rebound',
            rebound,
            createdAt,
            binding
        )
        nodeLedgers.push(nodeLedgerForRegistration({
            registration: rebound,
            runId: authority.runId,
            stateRoot: authority.stateRoot,
            createdAt
        }))
    }

    for (const nodeId of added) {
        const prior = facts.controlProjection.nodes[nodeId]
        if (prior) continue
        const identity = lifecycleNodeIdentity(nodeId)
        const repository = facts.controlProjection.repositoryBases[
            identity.repository
        ]
        if (!repository) {
            fail('lifecycle-scope-refresh-repository-unbound', {
                nodeId,
                repository: identity.repository
            })
        }
        const graphNode = refreshedGraphNode({
            nodeId,
            selector,
            remote,
            repositoryBindingDigest:
                repository.repositoryBindingDigest
        })
        const registration = nodeRegistration({
            graphNode,
            nodeEpoch: 1,
            repository: {
                repository: repository.repository,
                baseSha: repository.baseSha,
                bindingDigest: repository.repositoryBindingDigest
            },
            selectorReceipt: selector,
            lifecycleAuthority: facts.lifecycleAuthority
        })
        appendControlInMemory(
            controlLedger,
            'node.registered',
            registration,
            createdAt,
            binding
        )
        nodeLedgers.push(nodeLedgerForRegistration({
            registration,
            runId: authority.runId,
            stateRoot: authority.stateRoot,
            createdAt
        }))
    }

    const recovered = persistAggregateRunState({
        stateRoot: authority.stateRoot,
        controlLedger,
        nodeLedgers
    })
    return makeHandle({ ...authority, recovered })
}

function baseCarryForwardEvent({
    authority,
    createdAt,
    graphDigest,
    priorRegistration,
    priorLedger,
    rebound,
    receipts
}) {
    const carried = Object.fromEntries(Object.entries(receipts).filter(
        ([key]) => [
            'semanticProposal',
            'semanticProposalValidation',
            'requirementInventory',
            'acceptanceContract',
            'nodeDiscovered',
            'documentationRequirement',
            'documentationRequired'
        ].includes(key)
    ))
    const payload = {
        schema: 'issue-orchestration.lifecycle-carry-forward.v1',
        priorNodeEpoch: priorRegistration.nodeEpoch,
        priorLedgerHeadDigest:
            priorLedger.events.at(-1)?.eventDigest ?? GENESIS,
        receipts: clone(carried),
        receiptsDigest: digest(carried)
    }
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `lifecycle:${digest({
            runId: authority.runId,
            nodeId: rebound.nodeId,
            nodeEpoch: rebound.nodeEpoch,
            priorLedgerHeadDigest: payload.priorLedgerHeadDigest
        })}`,
        sequence: 1,
        runId: authority.runId,
        nodeId: rebound.nodeId,
        eventType: 'lifecycle.base-rebound',
        fromState: 'none',
        toState: 'acceptance-frozen',
        attemptId: null,
        actorRole: 'root-scheduler',
        lifecycleAuthorityBinding:
            clone(currentControlFacts(authority)
                .lifecycleAuthority.binding),
        sourceDagDigest: graphDigest,
        issueSnapshotFingerprint:
            rebound.issueSnapshotFingerprint,
        repositoryFingerprint: rebound.repositoryFingerprint,
        baseSha: rebound.baseSha,
        payload,
        payloadDigest: stateDigest(payload),
        evidenceRefs: receiptEvidence(carried),
        createdAt,
        previousEventDigest: GENESIS
    }
    event.eventDigest = stateDigest(event)
    return event
}

export function recordLifecycleBaseChange({
    ledger,
    repository,
    baseSha,
    createdAt,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    requireText(repository, 'lifecycle-base-change-repository')
    requireSha(baseSha, 'lifecycle-base-change-sha-invalid')
    const projected = projectLifecycleRun(authority, {
        startup: authority.startup
    })
    const facts = currentControlFacts(authority)
    const current = facts.controlProjection.repositoryBases[repository]
    if (!current || current.baseSha === baseSha) {
        fail('lifecycle-base-change-invalid')
    }
    const eligible = Object.values(projected.state.nodes).some((node) =>
        node.repository === repository &&
        [
            'acceptance-frozen',
            'test-contract-planning',
            'test-contracting'
        ].includes(node.lifecycleState)
    )
    if (!eligible) fail('lifecycle-base-change-not-rebindable')

    const repositoryBindingDigest = repositoryAuthorityFor(
        facts.lifecycleAuthority,
        repository
    ).bindingDigest
    const binding = facts.lifecycleAuthority.binding
    const controlLedger = clone(facts.controlLedger)
    appendControlInMemory(controlLedger, 'repository.base-changed', {
        repository,
        baseSha,
        repositoryBindingDigest
    }, createdAt, binding)

    const graphById = new Map(projected.semanticGraph.nodes.map((node) => [
        node.id,
        node
    ]))
    const nodeLedgers = []
    for (const [nodeId, registration] of Object.entries(
        facts.controlProjection.nodes
    ).sort(([left], [right]) => left.localeCompare(right))) {
        if (registration.repository !== repository ||
            ['closed', 'terminal'].includes(
                projected.state.nodes[nodeId].lifecycleState
            )) {
            nodeLedgers.push(readCanonicalNodeLedger({
                ...authority,
                nodeId,
                nodeEpoch: registration.nodeEpoch
            }))
            continue
        }
        const priorLedger = readCanonicalNodeLedger({
            ...authority,
            nodeId,
            nodeEpoch: registration.nodeEpoch
        })
        const rebound = nodeRegistration({
            graphNode: graphById.get(nodeId),
            nodeEpoch: registration.nodeEpoch + 1,
            repository: {
                repository,
                baseSha,
                bindingDigest: repositoryBindingDigest
            },
            selectorReceipt: facts.selectorReceipt,
            lifecycleAuthority: facts.lifecycleAuthority
        })
        appendControlInMemory(
            controlLedger,
            'node.rebound',
            rebound,
            createdAt,
            binding
        )
        const event = baseCarryForwardEvent({
            authority,
            createdAt,
            graphDigest: projected.semanticGraph.semanticGraphDigest,
            priorRegistration: registration,
            priorLedger,
            rebound,
            receipts: projected.state.nodes[nodeId].receipts
        })
        const nextLedger = nodeLedgerForRegistration({
            registration: rebound,
            runId: authority.runId,
            stateRoot: authority.stateRoot,
            createdAt,
            events: [event]
        })
        replayEventLedgerSync(nextLedger)
        nodeLedgers.push(nextLedger)
    }
    const recovered = persistAggregateRunState({
        stateRoot: authority.stateRoot,
        controlLedger,
        nodeLedgers
    })
    return makeHandle({ ...authority, recovered })
}


export function recordLifecycleAuthorityTakeover({
    ledger,
    startup,
    createdAt
} = {}) {
    const location = resolveAuthorityLocation(ledger)
    if (!startup) fail('lifecycle-run-current-startup-required')
    const controlLedger = readCanonicalControlLedger(location)
    const controlProjection = replayControlLedger(controlLedger)
    const genesis = genesisFromControlLedger(controlLedger)
    const priorAuthorityEvent = [...controlLedger.events].reverse().find(
        ({ eventType, payload }) =>
            eventType === 'runtime-authority.rebound' &&
            payload?.lifecycleAuthority
    )
    const priorAuthority = priorAuthorityEvent?.payload
        ?.lifecycleAuthority ?? genesis.lifecycleAuthority
    try {
        lifecycleAuthorityBinding(priorAuthority)
    } catch (error) {
        fail('lifecycle-run-prior-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const authorization = startup?.takeoverContext?.authorization
    if (!authorization ||
        authorization.runId !== location.runId ||
        authorization.oldRootInvocationId !==
            priorAuthority.binding.runtimeInvocationId ||
        authorization.oldRootSessionId !==
            priorAuthority.binding.runtimeSessionId ||
        authorization.oldRootAuthorityEpoch !==
            priorAuthority.binding.rootAuthorityEpoch ||
        authorization.oldRootStartupAttestationDigest !==
            priorAuthority.binding.startupAttestationDigest) {
        fail('lifecycle-run-takeover-handoff-stale')
    }
    if (startup.attestation?.rootAuthorityEpoch ===
            priorAuthority.binding.rootAuthorityEpoch) {
        fail('lifecycle-run-takeover-epoch-not-advanced')
    }
    let nextAuthority
    try {
        nextAuthority = compileLifecycleRunTakeoverAuthority({
            runId: location.runId,
            startup,
            stateRoot: location.stateRoot,
            repositoryTargets: priorAuthority.repositoryTargets,
            workspaces: priorAuthority.workspaces,
            worktrees: priorAuthority.worktrees,
            slotCapacity:
                priorAuthority.runtimeCapabilityBinding.slotCapacity,
            createdAt
        })
    } catch (error) {
        fail('lifecycle-run-takeover-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const priorSelector = currentSelectorFromControlLedger(
        controlLedger,
        genesis
    )
    const selectorReceipt = rebindLifecycleSelectorAuthority({
        lifecycleAuthority: nextAuthority,
        startup,
        selectorReceipt: priorSelector
    })
    const remoteSnapshotReceipt =
        compileLifecycleRemoteSnapshotReceipt(selectorReceipt)
    const nextControlLedger = clone(controlLedger)
    const binding = nextAuthority.binding
    appendControlInMemory(
        nextControlLedger,
        'runtime-authority.rebound',
        {
            priorLifecycleAuthorityBindingDigest:
                priorAuthority.binding.bindingDigest,
            lifecycleAuthority: nextAuthority
        },
        createdAt,
        binding
    )
    appendControlInMemory(
        nextControlLedger,
        'scope.refreshed',
        {
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            selectorReceipt,
            authorityRebound: true
        },
        createdAt,
        binding
    )
    appendControlInMemory(
        nextControlLedger,
        'remote-snapshot.refreshed',
        {
            remoteSnapshotDigest: remoteSnapshotReceipt.receiptDigest,
            remoteSnapshotReceipt
        },
        createdAt,
        binding
    )
    for (const [repository, current] of Object.entries(
        controlProjection.repositoryBases
    ).sort(([left], [right]) => left.localeCompare(right))) {
        appendControlInMemory(
            nextControlLedger,
            'repository.base-changed',
            {
                repository,
                baseSha: current.baseSha,
                repositoryBindingDigest: repositoryAuthorityFor(
                    nextAuthority,
                    repository
                ).bindingDigest
            },
            createdAt,
            binding
        )
    }
    const nodeLedgers = currentNodeLedgers(
        location,
        controlProjection
    )
    const recovered = persistAggregateRunState({
        stateRoot: location.stateRoot,
        controlLedger: nextControlLedger,
        nodeLedgers
    })
    const currentAuthority = {
        ...location,
        startup
    }
    currentControlFacts(currentAuthority)
    return makeHandle({ ...currentAuthority, recovered })
}

export function persistLifecycleRunLedger({
    stateRoot,
    ledger,
    startup
} = {}) {
    const authority = resolveAuthority(ledger, startup)
    if (stateRoot && path.resolve(stateRoot) !== authority.stateRoot) {
        fail('lifecycle-run-state-root-mismatch')
    }
    currentControlFacts(authority)
    return makeHandle(authority)
}

export function readLifecycleRunLedger({
    stateRoot,
    runId,
    startup
} = {}) {
    const authority = {
        stateRoot: path.resolve(
            requireText(stateRoot, 'lifecycle-run-state-root-required')
        ),
        runId: requireText(runId, 'lifecycle-run-id-required'),
        startup
    }
    currentControlFacts(authority)
    return makeHandle(authority)
}

export function lifecycleCanonicalLocations(
    value,
    { startup } = {}
) {
    const authority = resolveAuthority(value, startup)
    const facts = currentControlFacts(authority)
    return Object.freeze({
        run: canonicalRunStateLocation(authority),
        nodes: Object.fromEntries(Object.entries(
            facts.controlProjection.nodes
        ).map(([nodeId, registration]) => [
            nodeId,
            canonicalNodeStateLocation({
                ...authority,
                nodeId,
                nodeEpoch: registration.nodeEpoch
            })
        ]))
    })
}
