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
    validateLifecycleStageResult
} from './lifecycle-stage-admission.mjs'
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

function currentControlFacts(authority) {
    if (authority[CONTROL_FACTS_CACHE]) {
        return authority[CONTROL_FACTS_CACHE]
    }
    const controlLedger = readCanonicalControlLedger(authority)
    const controlProjection = replayControlLedger(controlLedger)
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
        remoteSnapshotReceipt
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
                nodeProjection?.closedAtSequence ?? null
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
        cleanupFinalizations:
            clone(controlProjection.cleanupFinalizations),
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
    const recovered = recoverAggregateRunState(authority)
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
    { startup } = {}
) {
    const authority = resolveAuthority(value, startup)
    const facts = currentControlFacts(authority)
    const recovered = recoverAggregateRunState(authority)
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
    startup = null
) {
    const authority = resolveAuthority(value, startup)
    const facts = currentControlFacts(authority)
    const recovered = recoverAggregateRunState(authority)
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

export function compileLifecycleRunActionSet(
    value,
    { observedSelectorReceipt = null, startup = null } = {}
) {
    const actionSet = compileLifecycleActionSet(
        lifecycleCompilerInput(
            value,
            observedSelectorReceipt,
            startup
        )
    )
    validateLifecycleActionSet(actionSet)
    return actionSet
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
            const commits = clone(
                admission.artifacts.remoteEffect.evidence.commits
            )
            const pending = state.pendingDeliveryEffects[groupId]
            if (admission.deliveryPhase === 'remote-effect-applied') {
                if (pending && pending.effectId !== effectId) {
                    fail('lifecycle-delivery-effect-conflict')
                }
                if (!pending) {
                    appendCanonicalControlEvent({
                        authority,
                        eventType: 'delivery.effect-recorded',
                        payload: {
                            groupId,
                            effectId,
                            status: 'remote-effect-applied',
                            commits
                        },
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
            for (const { nodeId } of action.bindings.memberBindings) {
                const current = replayLifecycleRunLedger(authority, {
                startup: authority.startup
            })
                const node = current.nodes[nodeId]
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
            continue
        }

        const current = replayLifecycleRunLedger(authority, {
            startup: authority.startup
        })
        const node = current.nodes[action.nodeId]
        validateLifecycleStageResult({ result, action, node })
        const effect = appendCanonicalNodeResult({
            authority,
            actionSet,
            action,
            result,
            node,
            createdAt
        })
        if (action.type === 'cleanup-node-resources') {
            appendCanonicalControlEvent({
                authority,
                eventType: 'cleanup.finalized',
                payload: {
                    cleanupId: action.nodeId,
                    nodeId: action.nodeId,
                    cleanupReceiptDigest:
                        effect.receipts.cleanup.receiptDigest
                },
                createdAt
            })
        }
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
