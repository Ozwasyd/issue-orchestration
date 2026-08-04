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
import { verifySelectorReceipt } from './scope-selector.mjs'
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

const HANDLE_SCHEMA = 'issue-orchestration.lifecycle-run-handle.v1'
const GENESIS_SCHEMA = 'issue-orchestration.lifecycle-run-genesis.v1'
const ACTOR_RESULT_SCHEMA =
    'issue-orchestration.lifecycle-actor-result.v1'
const GENESIS = '0'.repeat(64)
const SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u

const EXPECTED_ACTOR_ROLE = Object.freeze({
    'request-semantic-proposal': 'dag-creator-updater',
    'compile-acceptance-contract': 'acceptance-contract-compiler',
    'request-test-contract-planning': 'test-owner',
    'dispatch-test-contract-writer': 'test-owner',
    'dispatch-behavior-verifier': 'test-owner',
    'request-ui-adjudication': 'ui-system-adjudicator',
    'dispatch-ux-acceptance-verifier': 'ux-acceptance-verifier',
    'dispatch-documentation-writer': 'documentation-writer',
    'deliver-acceptance-group': 'root-delivery-adapter',
    'cleanup-node-resources': 'root-cleanup-adapter',
    'terminalize-node': 'root-scheduler'
})

const ALLOWED_OUTCOMES = Object.freeze({
    'request-semantic-proposal': ['completed'],
    'compile-acceptance-contract': ['completed'],
    'request-test-contract-planning': ['completed'],
    'dispatch-test-contract-writer': ['completed'],
    'dispatch-implementation-writer': [
        'completed', 'recoverable-failure'
    ],
    'dispatch-behavior-verifier': ['completed'],
    'request-ui-adjudication': ['completed'],
    'dispatch-ux-acceptance-verifier': ['completed'],
    'dispatch-documentation-writer': ['completed'],
    'deliver-acceptance-group': [
        'remote-effect-applied', 'completed'
    ],
    'cleanup-node-resources': ['completed'],
    'terminalize-node': ['completed']
})

const EVENT_TYPE_BY_ACTION = Object.freeze({
    'request-semantic-proposal':
        'lifecycle.semantic-proposal-recorded',
    'compile-acceptance-contract':
        'lifecycle.acceptance-contract-recorded',
    'request-test-contract-planning':
        'lifecycle.test-contract-planning-recorded',
    'dispatch-test-contract-writer':
        'lifecycle.test-contract-writer-recorded',
    'dispatch-behavior-verifier':
        'lifecycle.behavior-recorded',
    'request-ui-adjudication':
        'lifecycle.ui-adjudication-recorded',
    'dispatch-ux-acceptance-verifier':
        'lifecycle.ux-acceptance-recorded',
    'dispatch-documentation-writer':
        'lifecycle.documentation-recorded',
    'deliver-acceptance-group':
        'lifecycle.delivery-recorded',
    'cleanup-node-resources':
        'lifecycle.cleanup-recorded',
    'terminalize-node':
        'lifecycle.terminal-recorded'
})

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
    if (genesis.runtimeCapabilityBinding?.schema !==
            'issue-orchestration.runtime-capability-binding.v1' ||
        genesis.runtimeCapabilityBinding.status !== 'verified') {
        fail('lifecycle-run-capability-invalid')
    }
    requireDigest(
        genesis.runtimeCapabilityBinding.bindingDigest,
        'lifecycle-run-capability-invalid'
    )
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

function resolveAuthority(value) {
    const authority = value?.ledger ?? value
    requireObject(authority, 'lifecycle-run-handle-required')
    if (authority.schema !== HANDLE_SCHEMA) {
        if (authority.stateRoot && authority.runId) {
            return {
                stateRoot: path.resolve(authority.stateRoot),
                runId: authority.runId
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

function makeHandle({ stateRoot, runId, recovered = null }) {
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
            state.projection.aggregateProjectionDigest
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
    selectorReceipt
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
    semanticGraph,
    installedPolicy,
    runtimeCapabilityBinding,
    slotCapacity
} = {}) {
    requireText(stateRoot, 'lifecycle-run-state-root-required')
    verifySelectorReceipt(selectorReceipt)
    validateSemanticGraph(semanticGraph)
    const remoteSnapshotReceipt =
        compileLifecycleRemoteSnapshotReceipt(selectorReceipt)
    const genesis = {
        schema: GENESIS_SCHEMA,
        runId,
        createdAt,
        selectorReceipt: clone(selectorReceipt),
        remoteSnapshotReceipt,
        semanticGraph: clone(semanticGraph),
        installedPolicy: clone(installedPolicy),
        runtimeCapabilityBinding: clone(runtimeCapabilityBinding),
        slotCapacity
    }
    genesis.genesisDigest = digest(genesis)
    validateGenesis(genesis)

    const controlLedger = createControlLedger({ runId, createdAt })
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
            selectorReceipt
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
    return makeHandle({ stateRoot, runId, recovered })
}

function validateActorResult(result, action, node) {
    requireObject(result, 'lifecycle-actor-result-invalid')
    if (result.schema !== ACTOR_RESULT_SCHEMA ||
        result.producerAuthority !==
            'deterministic-scripted-stage-actor' ||
        result.rootAuthored !== false ||
        result.actionDigest !== action.actionDigest ||
        result.actionType !== action.type ||
        result.nodeId !== (action.nodeId ?? null) ||
        result.resultDigest !==
            unsignedDigest(result, 'resultDigest')) {
        fail('lifecycle-actor-result-invalid')
    }
    const expectedRole = action.type ===
        'dispatch-implementation-writer'
        ? node?.uiClass === 'ui'
            ? 'ui-ux-implementer'
            : 'code-implementer'
        : EXPECTED_ACTOR_ROLE[action.type]
    if (result.actorRole !== expectedRole ||
        !ALLOWED_OUTCOMES[action.type]?.includes(
            result.outcome
        )) {
        fail('lifecycle-actor-result-authority')
    }
    requireObject(
        result.decision,
        'lifecycle-actor-decision-invalid'
    )
    if (result.decisionDigest !== digest(result.decision)) {
        fail('lifecycle-actor-decision-digest')
    }
    const source = JSON.stringify(result.decision)
    if (/(?:receipt|projection|ledger|stageState)/iu.test(source)) {
        fail('lifecycle-actor-machine-authority-forbidden')
    }
    return result
}

export function compileLifecycleActorResult({
    action,
    actorRole,
    outcome = 'completed',
    decision = {}
} = {}) {
    requireObject(action, 'lifecycle-action-required')
    requireText(actorRole, 'lifecycle-actor-role-required')
    requireObject(decision, 'lifecycle-actor-decision-invalid')
    const result = {
        schema: ACTOR_RESULT_SCHEMA,
        producerAuthority:
            'deterministic-scripted-stage-actor',
        rootAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        actorRole,
        outcome,
        decision: clone(decision),
        decisionDigest: digest(decision)
    }
    result.resultDigest = digest(result)
    return Object.freeze(result)
}

function sealMachineReceipt({
    kind,
    node,
    action,
    eventSequence,
    decision = {}
}) {
    const receipt = {
        schema:
            'issue-orchestration.lifecycle-machine-receipt.v1',
        receiptKind: kind,
        status: 'verified',
        producerAuthority:
            'deterministic-lifecycle-run-loop',
        rootAuthored: false,
        runId: action.bindings.runId,
        nodeId: node.id,
        repository: node.repository,
        issueNumber: node.issueNumber,
        nodeEpoch: node.chainVersion,
        actionDigest: action.actionDigest,
        eventSequence,
        decisionDigest: digest(decision)
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

function sealedArtifact(schema, digestField, value) {
    const artifact = {
        schema,
        producerAuthority:
            'deterministic-lifecycle-run-loop',
        rootAuthored: false,
        ...value
    }
    artifact[digestField] = digest(artifact)
    return artifact
}

function compileNodeEffect(node, action, result, eventSequence) {
    const next = clone(node)
    const receipts = {}
    const machine = (kind, decision = result.decision) =>
        sealMachineReceipt({
            kind,
            node: next,
            action,
            eventSequence,
            decision
        })
    switch (action.type) {
        case 'request-semantic-proposal':
            receipts.semanticProposal = machine('semantic-proposal')
            next.lifecycleState = 'discovered'
            break
        case 'compile-acceptance-contract':
            receipts.requirementInventory =
                machine('requirement-inventory')
            receipts.acceptanceContract =
                machine('acceptance-contract')
            receipts.documentationRequired = true
            next.lifecycleState = 'acceptance-frozen'
            break
        case 'request-test-contract-planning': {
            const common = {
                nodeId: next.id,
                chainVersion: next.chainVersion,
                baseSha: action.bindings.baseSha,
                actionDigest: action.actionDigest,
                decisionDigest: result.decisionDigest
            }
            receipts.planningAttempt =
                machine('test-contract-planning-attempt')
            receipts.testContractPlan = machine('test-contract-plan')
            receipts.workPlan = sealedArtifact(
                'issue-orchestration.stage-work-plan.v1',
                'workPlanDigest',
                common
            )
            receipts.executableSlice = sealedArtifact(
                'issue-orchestration.executable-slice.v1',
                'sliceDigest',
                common
            )
            receipts.compiledPrompt = sealedArtifact(
                'issue-orchestration.compiled-dispatch-prompt.v1',
                'promptDigest',
                common
            )
            receipts.resourceAcquisition =
                machine('writer-resource-acquisition')
            receipts.routeBinding = machine('stage-route-binding')
            next.lifecycleState = 'test-contracting'
            break
        }
        case 'dispatch-test-contract-writer':
            receipts.testContractWriter =
                machine('test-contract-writer-terminal')
            next.lifecycleState = 'test-contract-frozen'
            break
        case 'dispatch-implementation-writer':
            next.implementationAttempts += 1
            if (result.outcome === 'recoverable-failure') {
                receipts.writerFailure = machine('writer-stage-failure')
                receipts.retryAuthorization =
                    machine('writer-stage-retry-authorization')
                next.lifecycleState = 'implementing-self-testing'
            } else {
                receipts.implementationTerminal =
                    machine('implementation-terminal')
                receipts.candidate = machine('candidate')
                next.lifecycleState = 'candidate-green'
            }
            break
        case 'dispatch-behavior-verifier':
            receipts.behavior = machine('behavior-verification')
            next.lifecycleState = 'behavior-green'
            break
        case 'request-ui-adjudication':
            receipts.uiAdjudication = machine('ui-adjudication')
            next.lifecycleState = 'behavior-green'
            break
        case 'dispatch-ux-acceptance-verifier':
            receipts.uxAcceptance = machine('ux-acceptance')
            next.lifecycleState = 'ux-accepted'
            break
        case 'dispatch-documentation-writer':
            receipts.documentation = machine('documentation-terminal')
            next.lifecycleState = 'documentation-green'
            break
        case 'deliver-acceptance-group':
            if (result.outcome !== 'completed') {
                fail('lifecycle-delivery-result-incomplete')
            }
            receipts.deliveryAttempt = machine('delivery-attempt')
            receipts.delivery = machine('delivery-completion')
            next.deliveryCommit =
                result.decision.commits?.[next.id] ?? null
            next.lifecycleState = 'cleaning'
            break
        case 'cleanup-node-resources':
            receipts.cleanupAuthorization =
                machine('cleanup-authorization')
            receipts.cleanup = machine('resource-cleanup')
            receipts.closure = machine('issue-closure')
            next.lifecycleState = 'closed'
            next.closedAtSequence = eventSequence
            break
        case 'terminalize-node':
            receipts.terminal = machine('terminal')
            next.lifecycleState = 'terminal'
            break
        default:
            fail('lifecycle-run-action-unsupported', {
                actionType: action.type
            })
    }
    next.receipts = {
        ...next.receipts,
        ...receipts
    }
    return { node: next, receipts }
}

function currentControlFacts(authority) {
    const controlLedger = readCanonicalControlLedger(authority)
    const controlProjection = replayControlLedger(controlLedger)
    const genesis = genesisFromControlLedger(controlLedger)
    const selectorReceipt = currentSelectorFromControlLedger(
        controlLedger,
        genesis
    )
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
    return {
        controlLedger,
        controlProjection,
        genesis,
        selectorReceipt,
        remoteSnapshotReceipt
    }
}

function currentSemanticGraph({
    controlProjection,
    genesis,
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
        .map((repository) => ({
            repository: repository.repository,
            baseSha: repository.baseSha,
            bindingDigest: repository.repositoryBindingDigest
        }))
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

export function replayLifecycleRunLedger(value) {
    const authority = resolveAuthority(value)
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

export function projectLifecycleRun(value) {
    const authority = resolveAuthority(value)
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

function lifecycleCompilerInput(value, observedSelectorReceipt = null) {
    const authority = resolveAuthority(value)
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
            clone(facts.genesis.runtimeCapabilityBinding)
    }
}

export function compileLifecycleRunActionSet(
    value,
    { observedSelectorReceipt = null } = {}
) {
    const actionSet = compileLifecycleActionSet(
        lifecycleCompilerInput(value, observedSelectorReceipt)
    )
    validateLifecycleActionSet(actionSet)
    return actionSet
}

function exactCurrentActionSet(value, actionSet) {
    const current = compileLifecycleRunActionSet(value)
    if (!sameValue(current, actionSet)) {
        fail('lifecycle-action-set-stale')
    }
    return current
}

function eventTypeForResult(action, result) {
    if (action.type === 'dispatch-implementation-writer') {
        return result.outcome === 'recoverable-failure'
            ? 'lifecycle.implementation-retry-recorded'
            : 'lifecycle.implementation-candidate-recorded'
    }
    return EVENT_TYPE_BY_ACTION[action.type] ?? null
}

function receiptEvidence(receipts) {
    return Object.values(receipts).flatMap((receipt) => {
        if (!receipt || typeof receipt !== 'object') return []
        for (const field of [
            'receiptDigest', 'workPlanDigest', 'planDigest',
            'sliceDigest', 'promptDigest', 'routeDecisionDigest'
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
    const effect = compileNodeEffect(
        node,
        action,
        result,
        eventSequence
    )
    const eventType = eventTypeForResult(action, result)
    if (!eventType) {
        fail('lifecycle-run-action-unsupported', {
            actionType: action.type
        })
    }
    const projected = projectLifecycleRun(authority)
    const payload = {
        schema: 'issue-orchestration.lifecycle-canonical-effect.v1',
        actionSetDigest: actionSet.actionSetDigest,
        action: clone(action),
        actorResult: clone(result),
        machineReceipts: clone(effect.receipts),
        machineReceiptsDigest: digest(effect.receipts),
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
            actorResultDigest: result.resultDigest,
            sequence: eventSequence
        })}`,
        sequence: eventSequence,
        runId: authority.runId,
        nodeId: node.id,
        eventType,
        fromState: node.lifecycleState,
        toState: effect.node.lifecycleState,
        attemptId: result.decision.attemptId ?? null,
        actorRole: result.actorRole,
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
        createdAt
    })
    appendControlEventAtomicSync({
        ...authority,
        event,
        writerRole: 'root-scheduler'
    })
    return event
}

export function recordLifecycleActionResults({
    ledger,
    actionSet,
    actorResults,
    createdAt
} = {}) {
    const authority = resolveAuthority(ledger)
    exactCurrentActionSet(authority, actionSet)
    if (!Array.isArray(actorResults) ||
        actorResults.length !== actionSet.actions.length ||
        actionSet.actions.some(({ type }) => type === 'idle' ||
            type === 'refresh-scope')) {
        fail('lifecycle-action-results-incomplete')
    }
    const byDigest = new Map(actorResults.map((result) => [
        result.actionDigest,
        result
    ]))
    if (byDigest.size !== actorResults.length) {
        fail('lifecycle-action-result-duplicate')
    }

    for (const action of actionSet.actions) {
        const result = byDigest.get(action.actionDigest)
        if (action.type === 'deliver-acceptance-group') {
            validateActorResult(result, action, null)
            const state = replayLifecycleRunLedger(authority)
            const groupId = requireText(
                action.acceptanceGroup,
                'lifecycle-delivery-group-invalid'
            )
            const effectId = requireText(
                result.decision.effectId,
                'lifecycle-delivery-effect-id-invalid'
            )
            const pending = state.pendingDeliveryEffects[groupId]
            if (result.outcome === 'remote-effect-applied') {
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
                            commits: clone(result.decision.commits ?? {})
                        },
                        createdAt
                    })
                }
                continue
            }
            if (!pending || pending.effectId !== effectId) {
                fail('lifecycle-delivery-effect-unobserved')
            }
            for (const { nodeId } of action.bindings.memberBindings) {
                const current = replayLifecycleRunLedger(authority)
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
                    commits: clone(result.decision.commits ?? {})
                },
                createdAt
            })
            continue
        }

        const current = replayLifecycleRunLedger(authority)
        const node = current.nodes[action.nodeId]
        validateActorResult(result, action, node)
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

function appendControlInMemory(ledger, eventType, payload, createdAt) {
    pushControlEvent(ledger, eventType, payload, createdAt)
    return ledger.events.at(-1)
}

export function recordLifecycleScopeRefresh({
    ledger,
    actionSet,
    selectorReceipt,
    createdAt
} = {}) {
    const authority = resolveAuthority(ledger)
    const current = compileLifecycleRunActionSet(authority, {
        observedSelectorReceipt: selectorReceipt
    })
    if (!sameValue(current, actionSet) ||
        actionSet.actions.length !== 1 ||
        actionSet.actions[0].type !== 'refresh-scope') {
        fail('lifecycle-scope-refresh-action-required')
    }
    const facts = currentControlFacts(authority)
    const selector = verifySelectorReceipt(selectorReceipt)
    const changedNodeIds = selector.resolvedIssueSet.filter(
        (nodeId) =>
            facts.selectorReceipt.remoteFactDigests[nodeId] !==
            selector.remoteFactDigests[nodeId]
    )
    if (changedNodeIds.length === 0) {
        fail('lifecycle-scope-refresh-without-change')
    }
    const added = selector.resolvedIssueSet.filter(
        (nodeId) => !facts.controlProjection.nodes[nodeId]
    )
    if (added.length > 0) {
        fail('lifecycle-scope-refresh-new-node-unsupported', {
            nodeIds: added
        })
    }
    const remote = compileLifecycleRemoteSnapshotReceipt(selector)
    const controlLedger = clone(facts.controlLedger)
    appendControlInMemory(controlLedger, 'scope.refreshed', {
        selectorReceiptDigest: selector.receiptDigest,
        selectorReceipt: selector,
        changedNodeIds
    }, createdAt)
    appendControlInMemory(controlLedger, 'remote-snapshot.refreshed', {
        remoteSnapshotDigest: remote.receiptDigest,
        remoteSnapshotReceipt: remote
    }, createdAt)

    const changed = new Set(changedNodeIds)
    const nodeLedgers = []
    const graph = projectLifecycleRun(authority).semanticGraph
    const graphById = new Map(graph.nodes.map((node) => [node.id, node]))
    for (const [nodeId, registration] of Object.entries(
        facts.controlProjection.nodes
    ).sort(([left], [right]) => left.localeCompare(right))) {
        if (!changed.has(nodeId)) {
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
        const rebound = nodeRegistration({
            graphNode: graphById.get(nodeId),
            nodeEpoch: registration.nodeEpoch + 1,
            repository: {
                repository: repository.repository,
                baseSha: repository.baseSha,
                bindingDigest: repository.repositoryBindingDigest
            },
            selectorReceipt: selector
        })
        appendControlInMemory(
            controlLedger,
            'node.rebound',
            rebound,
            createdAt
        )
        nodeLedgers.push(nodeLedgerForRegistration({
            registration: rebound,
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
            'requirementInventory',
            'acceptanceContract',
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
    createdAt
} = {}) {
    const authority = resolveAuthority(ledger)
    requireText(repository, 'lifecycle-base-change-repository')
    requireSha(baseSha, 'lifecycle-base-change-sha-invalid')
    const projected = projectLifecycleRun(authority)
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

    const repositoryBindingDigest = digest({
        repository,
        baseSha,
        priorBindingDigest: current.repositoryBindingDigest
    })
    const controlLedger = clone(facts.controlLedger)
    appendControlInMemory(controlLedger, 'repository.base-changed', {
        repository,
        baseSha,
        repositoryBindingDigest
    }, createdAt)

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
            selectorReceipt: facts.selectorReceipt
        })
        appendControlInMemory(
            controlLedger,
            'node.rebound',
            rebound,
            createdAt
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

export function persistLifecycleRunLedger({
    stateRoot,
    ledger
} = {}) {
    const authority = resolveAuthority(ledger)
    if (stateRoot && path.resolve(stateRoot) !== authority.stateRoot) {
        fail('lifecycle-run-state-root-mismatch')
    }
    return makeHandle(authority)
}

export function readLifecycleRunLedger({
    stateRoot,
    runId
} = {}) {
    const authority = {
        stateRoot: path.resolve(
            requireText(stateRoot, 'lifecycle-run-state-root-required')
        ),
        runId: requireText(runId, 'lifecycle-run-id-required')
    }
    return makeHandle(authority)
}

export function lifecycleCanonicalLocations(value) {
    const authority = resolveAuthority(value)
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
