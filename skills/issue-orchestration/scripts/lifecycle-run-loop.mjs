import fs from 'node:fs'
import path from 'node:path'

import { digest } from './runtime-contract-lib.mjs'
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

const LEDGER_SCHEMA = 'issue-orchestration.lifecycle-run-ledger.v1'
const ACTOR_RESULT_SCHEMA =
    'issue-orchestration.lifecycle-actor-result.v1'
const NODE_EVENT_SCHEMA =
    'issue-orchestration.lifecycle-node-event.v1'
const CONTROL_EVENT_SCHEMA =
    'issue-orchestration.lifecycle-control-event.v1'
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

function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
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

function atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, content, { mode: 0o600 })
    fs.renameSync(temporary, file)
}

function ledgerLocation(stateRoot, runId) {
    requireText(stateRoot, 'lifecycle-run-state-root-required')
    requireText(runId, 'lifecycle-run-id-required')
    return path.resolve(
        stateRoot,
        'runs',
        digest({ runId }),
        'lifecycle-run-ledger.json'
    )
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

function validateHeader(header) {
    requireObject(header, 'lifecycle-run-header-invalid')
    if (header.schema !==
            'issue-orchestration.lifecycle-run-header.v1') {
        fail('lifecycle-run-header-schema')
    }
    requireText(header.runId, 'lifecycle-run-id-required')
    requireText(header.createdAt, 'lifecycle-run-created-at-required')
    if (!Number.isInteger(header.slotCapacity) ||
        header.slotCapacity < 1) {
        fail('lifecycle-run-slot-capacity-invalid')
    }
    try {
        verifySelectorReceipt(header.selectorReceipt)
        validateSemanticGraph(header.semanticGraph)
    } catch (error) {
        fail('lifecycle-run-header-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const expectedRemote =
        compileLifecycleRemoteSnapshotReceipt(
            header.selectorReceipt
        )
    if (!sameValue(expectedRemote, header.remoteSnapshotReceipt)) {
        fail('lifecycle-run-header-remote-invalid')
    }
    if (header.semanticGraph.selectorReceiptDigest !==
            header.selectorReceipt.receiptDigest ||
        header.semanticGraph.remoteSnapshotDigest !==
            header.remoteSnapshotReceipt.receiptDigest) {
        fail('lifecycle-run-header-graph-stale')
    }
    if (header.installedPolicy?.schema !==
            'issue-orchestration.installed-route-policy.v1' ||
        header.installedPolicy.status !== 'verified' ||
        header.installedPolicy.policyDigest !==
            header.semanticGraph.policyDigest) {
        fail('lifecycle-run-policy-invalid')
    }
    if (header.runtimeCapabilityBinding?.schema !==
            'issue-orchestration.runtime-capability-binding.v1' ||
        header.runtimeCapabilityBinding.status !== 'verified') {
        fail('lifecycle-run-capability-invalid')
    }
    requireDigest(
        header.runtimeCapabilityBinding.bindingDigest,
        'lifecycle-run-capability-invalid'
    )
    requireDigest(header.headerDigest, 'lifecycle-run-header-digest')
    if (unsignedDigest(header, 'headerDigest') !==
            header.headerDigest) {
        fail('lifecycle-run-header-digest-mismatch')
    }
    return header
}

function sealLedger(ledger) {
    const next = clone(ledger)
    delete next.ledgerDigest
    next.ledgerDigest = digest(next)
    return Object.freeze(next)
}

function validateLedgerEnvelope(ledger) {
    requireObject(ledger, 'lifecycle-run-ledger-invalid')
    if (ledger.schema !== LEDGER_SCHEMA) {
        fail('lifecycle-run-ledger-schema')
    }
    validateHeader(ledger.header)
    requireObject(
        ledger.nodeLedgers,
        'lifecycle-run-node-ledgers-invalid'
    )
    if (!Array.isArray(ledger.controlEvents)) {
        fail('lifecycle-run-control-events-invalid')
    }
    requireDigest(ledger.ledgerDigest, 'lifecycle-run-ledger-digest')
    if (unsignedDigest(ledger, 'ledgerDigest') !==
            ledger.ledgerDigest) {
        fail('lifecycle-run-ledger-digest-mismatch')
    }
    return ledger
}

function initialNode(graphNode) {
    if (graphNode.lifecycleState !== 'none' ||
        Object.keys(graphNode.receipts).length !== 0) {
        fail('lifecycle-run-future-history-forbidden', {
            nodeId: graphNode.id
        })
    }
    return {
        id: graphNode.id,
        memberId: graphNode.memberId,
        repository: graphNode.repository,
        issueNumber: graphNode.issueNumber,
        owner: graphNode.owner,
        dependencyKeys: [...graphNode.dependencyKeys],
        conflictKeys: [...graphNode.conflictKeys],
        riskClass: graphNode.riskClass,
        uiClass: graphNode.uiClass,
        acceptanceGroup: graphNode.acceptanceGroup,
        semanticFactsDigest: graphNode.semanticFactsDigest,
        lifecycleState: 'none',
        receipts: {},
        chainVersion: 1,
        implementationAttempts: 0,
        pendingDeliveryEffect: null,
        deliveryCommit: null,
        closedAtSequence: null
    }
}

export function createLifecycleRunLedger({
    runId,
    createdAt,
    selectorReceipt,
    semanticGraph,
    installedPolicy,
    runtimeCapabilityBinding,
    slotCapacity
} = {}) {
    verifySelectorReceipt(selectorReceipt)
    validateSemanticGraph(semanticGraph)
    const remoteSnapshotReceipt =
        compileLifecycleRemoteSnapshotReceipt(selectorReceipt)
    const header = {
        schema: 'issue-orchestration.lifecycle-run-header.v1',
        runId,
        createdAt,
        selectorReceipt: clone(selectorReceipt),
        remoteSnapshotReceipt,
        semanticGraph: clone(semanticGraph),
        installedPolicy: clone(installedPolicy),
        runtimeCapabilityBinding:
            clone(runtimeCapabilityBinding),
        slotCapacity
    }
    header.headerDigest = digest(header)
    validateHeader(header)
    const nodeLedgers = Object.fromEntries(
        semanticGraph.nodes.map((node) => [
            node.id,
            {
                schema:
                    'issue-orchestration.lifecycle-node-ledger.v1',
                nodeId: node.id,
                events: [],
                headDigest: GENESIS
            }
        ])
    )
    return sealLedger({
        schema: LEDGER_SCHEMA,
        header,
        nodeLedgers,
        controlEvents: []
    })
}

function verifyEventEnvelope(event, expectedSchema, previousDigest) {
    requireObject(event, 'lifecycle-run-event-invalid')
    if (event.schema !== expectedSchema ||
        !Number.isInteger(event.globalSequence) ||
        event.globalSequence < 1 ||
        !Number.isInteger(event.sequence) ||
        event.sequence < 1 ||
        event.previousEventDigest !== previousDigest ||
        event.eventDigest !==
            unsignedDigest(event, 'eventDigest')) {
        fail('lifecycle-run-event-invalid')
    }
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
            receipts.semanticProposal =
                machine('semantic-proposal')
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
            receipts.testContractPlan =
                machine('test-contract-plan')
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
            receipts.routeBinding =
                machine('stage-route-binding')
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
                receipts.writerFailure =
                    machine('writer-stage-failure')
                receipts.retryAuthorization =
                    machine('writer-stage-retry-authorization')
                next.lifecycleState =
                    'implementing-self-testing'
            } else {
                receipts.implementationTerminal =
                    machine('implementation-terminal')
                receipts.candidate =
                    machine('candidate')
                next.lifecycleState = 'candidate-green'
            }
            break
        case 'dispatch-behavior-verifier':
            receipts.behavior =
                machine('behavior-verification')
            next.lifecycleState = 'behavior-green'
            break
        case 'request-ui-adjudication':
            receipts.uiAdjudication =
                machine('ui-adjudication')
            next.lifecycleState = 'behavior-green'
            break
        case 'dispatch-ux-acceptance-verifier':
            receipts.uxAcceptance =
                machine('ux-acceptance')
            next.lifecycleState = 'ux-accepted'
            break
        case 'dispatch-documentation-writer':
            receipts.documentation =
                machine('documentation-terminal')
            next.lifecycleState = 'documentation-green'
            break
        case 'deliver-acceptance-group':
            if (result.outcome !== 'completed') {
                fail('lifecycle-delivery-result-incomplete')
            }
            receipts.deliveryAttempt =
                machine('delivery-attempt')
            receipts.delivery =
                machine('delivery-completion')
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

function nodeEvent({
    ledger,
    nodeId,
    actionSet,
    action,
    actorResult,
    effect,
    globalSequence,
    createdAt
}) {
    const nodeLedger = ledger.nodeLedgers[nodeId]
    const event = {
        schema: NODE_EVENT_SCHEMA,
        sequence: nodeLedger.events.length + 1,
        globalSequence,
        nodeId,
        actionSetDigest: actionSet.actionSetDigest,
        action: clone(action),
        actorResult: clone(actorResult),
        fromState: effect.fromState,
        toState: effect.node.lifecycleState,
        machineReceipts: clone(effect.receipts),
        createdAt,
        previousEventDigest: nodeLedger.headDigest
    }
    event.eventDigest = digest(event)
    return event
}

function controlEvent({
    ledger,
    eventType,
    payload,
    globalSequence,
    createdAt
}) {
    const event = {
        schema: CONTROL_EVENT_SCHEMA,
        sequence: ledger.controlEvents.length + 1,
        globalSequence,
        eventType,
        payload: clone(payload),
        payloadDigest: digest(payload),
        createdAt,
        previousEventDigest:
            ledger.controlEvents.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = digest(event)
    return event
}

function eventList(ledger) {
    return [
        ...ledger.controlEvents,
        ...Object.values(ledger.nodeLedgers)
            .flatMap(({ events }) => events)
    ].sort((left, right) =>
        left.globalSequence - right.globalSequence
    )
}

function clearAllRuntimeReceipts(node) {
    node.receipts = {}
    node.lifecycleState = 'none'
    node.chainVersion += 1
    node.implementationAttempts = 0
    node.pendingDeliveryEffect = null
    node.deliveryCommit = null
    node.closedAtSequence = null
}

function clearPlanningReceipts(node) {
    const preserved = Object.fromEntries(
        Object.entries(node.receipts).filter(([key]) =>
            [
                'semanticProposal',
                'requirementInventory',
                'acceptanceContract',
                'documentationRequired'
            ].includes(key)
        )
    )
    node.receipts = preserved
    node.lifecycleState = 'acceptance-frozen'
    node.chainVersion += 1
    node.implementationAttempts = 0
    node.pendingDeliveryEffect = null
    node.deliveryCommit = null
}

function applyControlEvent(state, event) {
    if (event.eventType === 'scope.refreshed') {
        const selector =
            verifySelectorReceipt(event.payload.selectorReceipt)
        const remote =
            compileLifecycleRemoteSnapshotReceipt(selector)
        if (!sameValue(remote, event.payload.remoteSnapshotReceipt)) {
            fail('lifecycle-scope-refresh-remote-invalid')
        }
        state.selectorReceipt = clone(selector)
        state.remoteSnapshotReceipt = clone(remote)
        for (const nodeId of event.payload.changedNodeIds) {
            const node = state.nodes[nodeId]
            if (!node) fail('lifecycle-scope-refresh-node-missing')
            clearAllRuntimeReceipts(node)
        }
        return
    }
    if (event.eventType === 'repository.base-changed') {
        const repository = state.repositories[
            event.payload.repository
        ]
        if (!repository) {
            fail('lifecycle-base-change-repository-missing')
        }
        requireSha(
            event.payload.baseSha,
            'lifecycle-base-change-sha-invalid'
        )
        repository.baseSha = event.payload.baseSha
        repository.bindingDigest = digest({
            repository: repository.repository,
            baseSha: repository.baseSha,
            priorBindingDigest: repository.bindingDigest
        })
        for (const node of Object.values(state.nodes)) {
            if (node.repository === repository.repository &&
                !['closed', 'terminal'].includes(
                    node.lifecycleState
                )) {
                clearPlanningReceipts(node)
            }
        }
        return
    }
    if (event.eventType === 'delivery.remote-effect-applied') {
        const { groupId, effectId } = event.payload
        if (state.pendingDeliveryEffects[groupId] &&
            state.pendingDeliveryEffects[groupId].effectId !==
                effectId) {
            fail('lifecycle-delivery-effect-conflict')
        }
        state.pendingDeliveryEffects[groupId] =
            clone(event.payload)
        return
    }
    if (event.eventType === 'delivery.completed') {
        const { groupId, effectId } = event.payload
        const pending = state.pendingDeliveryEffects[groupId]
        if (!pending || pending.effectId !== effectId) {
            fail('lifecycle-delivery-effect-unobserved')
        }
        if (state.deliveryEffects[groupId]) {
            fail('lifecycle-delivery-effect-duplicate')
        }
        state.deliveryEffects[groupId] = clone(event.payload)
        delete state.pendingDeliveryEffects[groupId]
        return
    }
    if (event.eventType === 'cleanup.finalized') {
        const { nodeId } = event.payload
        if (state.cleanupFinalizations[nodeId]) {
            fail('lifecycle-cleanup-finalization-duplicate')
        }
        state.cleanupFinalizations[nodeId] =
            clone(event.payload)
        return
    }
    fail('lifecycle-control-event-unsupported')
}

function applyNodeEvent(state, event) {
    const node = state.nodes[event.nodeId]
    if (!node) fail('lifecycle-node-event-node-missing')
    validateActorResult(
        event.actorResult,
        event.action,
        node
    )
    const expected = compileNodeEffect(
        node,
        event.action,
        event.actorResult,
        event.globalSequence
    )
    if (event.fromState !== node.lifecycleState ||
        event.toState !== expected.node.lifecycleState ||
        !sameValue(
            event.machineReceipts,
            expected.receipts
        )) {
        fail('lifecycle-node-event-transition-invalid')
    }
    state.nodes[event.nodeId] = expected.node
}

export function replayLifecycleRunLedger(ledger) {
    validateLedgerEnvelope(ledger)
    const header = ledger.header
    const state = {
        runId: header.runId,
        selectorReceipt: clone(header.selectorReceipt),
        remoteSnapshotReceipt:
            clone(header.remoteSnapshotReceipt),
        repositories: Object.fromEntries(
            header.semanticGraph.repositories.map((repository) => [
                repository.repository,
                clone(repository)
            ])
        ),
        nodes: Object.fromEntries(
            header.semanticGraph.nodes.map((node) => [
                node.id,
                initialNode(node)
            ])
        ),
        pendingDeliveryEffects: {},
        deliveryEffects: {},
        cleanupFinalizations: {},
        lastGlobalSequence: 0
    }
    let expectedGlobal = 1
    const nodeHeads = Object.fromEntries(
        Object.keys(ledger.nodeLedgers).map((nodeId) => [
            nodeId, GENESIS
        ])
    )
    let controlHead = GENESIS
    const nodeSequences = Object.fromEntries(
        Object.keys(ledger.nodeLedgers).map((nodeId) => [
            nodeId, 0
        ])
    )
    let controlSequence = 0
    for (const event of eventList(ledger)) {
        if (event.globalSequence !== expectedGlobal) {
            fail('lifecycle-run-global-sequence')
        }
        if (event.schema === NODE_EVENT_SCHEMA) {
            const expectedNodeSequence =
                nodeSequences[event.nodeId] + 1
            verifyEventEnvelope(
                event,
                NODE_EVENT_SCHEMA,
                nodeHeads[event.nodeId]
            )
            if (event.sequence !== expectedNodeSequence) {
                fail('lifecycle-node-event-sequence')
            }
            applyNodeEvent(state, event)
            nodeSequences[event.nodeId] = event.sequence
            nodeHeads[event.nodeId] = event.eventDigest
        } else if (event.schema === CONTROL_EVENT_SCHEMA) {
            verifyEventEnvelope(
                event,
                CONTROL_EVENT_SCHEMA,
                controlHead
            )
            if (event.sequence !== controlSequence + 1 ||
                event.payloadDigest !== digest(event.payload)) {
                fail('lifecycle-control-event-sequence')
            }
            applyControlEvent(state, event)
            controlSequence = event.sequence
            controlHead = event.eventDigest
        } else {
            fail('lifecycle-run-event-schema')
        }
        state.lastGlobalSequence = event.globalSequence
        expectedGlobal += 1
    }
    for (const [nodeId, nodeLedger] of Object.entries(
        ledger.nodeLedgers
    )) {
        if (nodeLedger.headDigest !== nodeHeads[nodeId] ||
            nodeLedger.events.length !== nodeSequences[nodeId]) {
            fail('lifecycle-node-ledger-head-mismatch')
        }
    }
    return Object.freeze(state)
}

function currentSemanticGraph(ledger, state) {
    const template = ledger.header.semanticGraph
    const repositories = Object.values(state.repositories)
    const repositoryByName = new Map(
        repositories.map((repository) => [
            repository.repository,
            repository
        ])
    )
    const nodes = template.nodes.map((base) => {
        const runtime = state.nodes[base.id]
        const repository = repositoryByName.get(
            base.repository
        )
        return {
            ...base,
            lifecycleState: runtime.lifecycleState,
            selectorReceiptDigest:
                state.selectorReceipt.receiptDigest,
            remoteSnapshotDigest:
                state.remoteSnapshotReceipt.receiptDigest,
            repositoryBindingDigest:
                repository.bindingDigest,
            semanticFactsDigest: digest({
                original: base.semanticFactsDigest,
                remoteMemberDigest:
                    state.selectorReceipt
                        .remoteFactDigests[base.id],
                chainVersion: runtime.chainVersion
            }),
            receipts: clone(runtime.receipts)
        }
    })
    return createSemanticGraph({
        selectorReceiptDigest:
            state.selectorReceipt.receiptDigest,
        remoteSnapshotDigest:
            state.remoteSnapshotReceipt.receiptDigest,
        scopeDigest: template.scopeDigest,
        semanticGraphInputDigest: digest({
            original: template.semanticGraphInputDigest,
            selectorReceiptDigest:
                state.selectorReceipt.receiptDigest,
            remoteSnapshotDigest:
                state.remoteSnapshotReceipt.receiptDigest,
            repositories: repositories.map((repository) => ({
                repository: repository.repository,
                baseSha: repository.baseSha,
                bindingDigest: repository.bindingDigest
            })),
            chainVersions: Object.fromEntries(
                Object.values(state.nodes).map((node) => [
                    node.id, node.chainVersion
                ])
            )
        }),
        policyDigest: template.policyDigest,
        repositories,
        nodes
    })
}

function currentAggregateProjection(ledger, state) {
    const graph = currentSemanticGraph(ledger, state)
    const graphById = new Map(
        graph.nodes.map((node) => [node.id, node])
    )
    const acceptanceGroups = {}
    for (const node of graph.nodes) {
        if (!node.acceptanceGroup) continue
        acceptanceGroups[node.acceptanceGroup] ??= []
        acceptanceGroups[node.acceptanceGroup].push(node.id)
    }
    for (const members of Object.values(acceptanceGroups)) {
        members.sort()
    }
    const nodes = Object.fromEntries(
        Object.values(state.nodes).map((node) => {
            const blockedBy = node.dependencyKeys.filter(
                (dependency) =>
                    state.nodes[dependency]?.lifecycleState !==
                    'closed'
            )
            const nodeLedger = ledger.nodeLedgers[node.id]
            const repository =
                state.repositories[node.repository]
            const projection = {
                nodeId: node.id,
                memberId: node.id,
                repository: node.repository,
                issueNumber: node.issueNumber,
                selectorReceiptDigest:
                    state.selectorReceipt.receiptDigest,
                remoteMemberDigest:
                    state.selectorReceipt.remoteFactDigests[
                        node.id
                    ],
                nodeEpoch: node.chainVersion,
                baseSha: repository.baseSha,
                dependencyKeys: [...node.dependencyKeys],
                acceptanceGroup: node.acceptanceGroup,
                status: node.lifecycleState === 'closed'
                    ? 'closed'
                    : 'active',
                ledgerHeadDigest: nodeLedger.headDigest,
                nodeProjectionDigest: digest({
                    node,
                    graphNode: graphById.get(node.id),
                    blockedBy,
                    ledgerHeadDigest: nodeLedger.headDigest
                }),
                lifecycleState: node.lifecycleState,
                activeAttemptId: null,
                candidateGreen: [
                    'candidate-green',
                    'behavior-green',
                    'ux-accepted',
                    'documentation-green',
                    'delivery-ready',
                    'cleaning',
                    'closed'
                ].includes(node.lifecycleState),
                deliveryComplete: [
                    'cleaning', 'closed'
                ].includes(node.lifecycleState),
                dispatchable: blockedBy.length === 0,
                blockedBy,
                quarantine: null
            }
            return [node.id, projection]
        })
    )
    const projection = {
        schema:
            'issue-orchestration.aggregate-runtime-projection.v1',
        runId: state.runId,
        controlProjectionDigest: digest({
            controlEvents: ledger.controlEvents,
            deliveryEffects: state.deliveryEffects,
            cleanupFinalizations:
                state.cleanupFinalizations
        }),
        nodeIndexDigest: digest(
            Object.fromEntries(
                Object.entries(ledger.nodeLedgers).map(
                    ([nodeId, nodeLedger]) => [
                        nodeId, nodeLedger.headDigest
                    ]
                )
            )
        ),
        nodes,
        acceptanceGroups,
        slots: {
            capacity: ledger.header.slotCapacity,
            active: []
        },
        deliveryFreezes: {},
        deliveryEffects: clone(state.deliveryEffects),
        cleanupFinalizations:
            clone(state.cleanupFinalizations),
        terminal: null
    }
    projection.aggregateProjectionDigest = digest(projection)
    return { graph, projection }
}

export function projectLifecycleRun(ledger) {
    const state = replayLifecycleRunLedger(ledger)
    const { graph, projection } =
        currentAggregateProjection(ledger, state)
    return Object.freeze({
        state,
        semanticGraph: graph,
        aggregateProjection: projection
    })
}

function lifecycleCompilerInput(
    ledger,
    observedSelectorReceipt = null
) {
    const projected = projectLifecycleRun(ledger)
    const selector = observedSelectorReceipt
        ? verifySelectorReceipt(observedSelectorReceipt)
        : projected.state.selectorReceipt
    const remote =
        compileLifecycleRemoteSnapshotReceipt(selector)
    return {
        schema:
            'issue-orchestration.lifecycle-compiler-input.v1',
        selectorReceipt: selector,
        remoteSnapshotReceipt: remote,
        semanticGraph: projected.semanticGraph,
        aggregateProjection:
            projected.aggregateProjection,
        installedPolicy: clone(
            ledger.header.installedPolicy
        ),
        runtimeCapabilityBinding: clone(
            ledger.header.runtimeCapabilityBinding
        )
    }
}

export function compileLifecycleRunActionSet(
    ledger,
    { observedSelectorReceipt = null } = {}
) {
    validateLedgerEnvelope(ledger)
    const actionSet = compileLifecycleActionSet(
        lifecycleCompilerInput(
            ledger,
            observedSelectorReceipt
        )
    )
    validateLifecycleActionSet(actionSet)
    return actionSet
}

function nextGlobalSequence(ledger) {
    return eventList(ledger).length + 1
}

function appendNodeEvent(ledger, nodeId, event) {
    ledger.nodeLedgers[nodeId].events.push(event)
    ledger.nodeLedgers[nodeId].headDigest =
        event.eventDigest
    ledger.ledgerDigest = unsignedDigest(ledger, 'ledgerDigest')
}

function appendControlEvent(ledger, event) {
    ledger.controlEvents.push(event)
    ledger.ledgerDigest = unsignedDigest(ledger, 'ledgerDigest')
}

function exactCurrentActionSet(ledger, actionSet) {
    const current = compileLifecycleRunActionSet(ledger)
    if (!sameValue(current, actionSet)) {
        fail('lifecycle-action-set-stale')
    }
    return current
}

export function recordLifecycleActionResults({
    ledger,
    actionSet,
    actorResults,
    createdAt
} = {}) {
    validateLedgerEnvelope(ledger)
    exactCurrentActionSet(ledger, actionSet)
    if (!Array.isArray(actorResults) ||
        actorResults.length !== actionSet.actions.length ||
        actionSet.actions.some(({ type }) => type === 'idle' ||
            type === 'refresh-scope')) {
        fail('lifecycle-action-results-incomplete')
    }
    const next = clone(ledger)
    const before = replayLifecycleRunLedger(next)
    const byDigest = new Map(
        actorResults.map((result) => [
            result.actionDigest, result
        ])
    )
    if (byDigest.size !== actorResults.length) {
        fail('lifecycle-action-result-duplicate')
    }
    for (const action of actionSet.actions) {
        const result = byDigest.get(action.actionDigest)
        const node = action.nodeId
            ? before.nodes[action.nodeId]
            : null
        validateActorResult(result, action, node)
        let globalSequence = nextGlobalSequence(next)
        if (action.type === 'deliver-acceptance-group') {
            const groupId = action.acceptanceGroup
            requireText(groupId, 'lifecycle-delivery-group-invalid')
            const effectId =
                requireText(
                    result.decision.effectId,
                    'lifecycle-delivery-effect-id-invalid'
                )
            const existing =
                before.pendingDeliveryEffects[groupId]
            if (result.outcome === 'remote-effect-applied') {
                if (existing && existing.effectId !== effectId) {
                    fail('lifecycle-delivery-effect-conflict')
                }
                appendControlEvent(next, controlEvent({
                    ledger: next,
                    eventType:
                        'delivery.remote-effect-applied',
                    payload: {
                        groupId,
                        effectId,
                        commits:
                            clone(result.decision.commits ?? {})
                    },
                    globalSequence,
                    createdAt
                }))
                continue
            }
            if (!existing || existing.effectId !== effectId) {
                fail('lifecycle-delivery-effect-unobserved')
            }
            const members =
                action.bindings.memberBindings.map(
                    ({ nodeId }) => nodeId
                )
            for (const nodeId of members) {
                const runtimeNode =
                    replayLifecycleRunLedger(next).nodes[nodeId]
                const effect = compileNodeEffect(
                    runtimeNode,
                    action,
                    result,
                    globalSequence
                )
                const event = nodeEvent({
                    ledger: next,
                    nodeId,
                    actionSet,
                    action,
                    actorResult: result,
                    effect: {
                        ...effect,
                        fromState: runtimeNode.lifecycleState
                    },
                    globalSequence,
                    createdAt
                })
                appendNodeEvent(next, nodeId, event)
                globalSequence += 1
            }
            appendControlEvent(next, controlEvent({
                ledger: next,
                eventType: 'delivery.completed',
                payload: {
                    groupId,
                    effectId,
                    commits:
                        clone(result.decision.commits ?? {})
                },
                globalSequence,
                createdAt
            }))
            continue
        }
        const currentNode =
            replayLifecycleRunLedger(next).nodes[action.nodeId]
        const effect = compileNodeEffect(
            currentNode,
            action,
            result,
            globalSequence
        )
        const event = nodeEvent({
            ledger: next,
            nodeId: action.nodeId,
            actionSet,
            action,
            actorResult: result,
            effect: {
                ...effect,
                fromState: currentNode.lifecycleState
            },
            globalSequence,
            createdAt
        })
        appendNodeEvent(next, action.nodeId, event)
        if (action.type === 'cleanup-node-resources') {
            appendControlEvent(next, controlEvent({
                ledger: next,
                eventType: 'cleanup.finalized',
                payload: {
                    nodeId: action.nodeId,
                    cleanupReceiptDigest:
                        effect.receipts.cleanup
                            .receiptDigest
                },
                globalSequence: globalSequence + 1,
                createdAt
            }))
        }
    }
    return sealLedger(next)
}

export function recordLifecycleScopeRefresh({
    ledger,
    actionSet,
    selectorReceipt,
    createdAt
} = {}) {
    validateLedgerEnvelope(ledger)
    const current = compileLifecycleRunActionSet(ledger, {
        observedSelectorReceipt: selectorReceipt
    })
    if (!sameValue(current, actionSet) ||
        actionSet.actions.length !== 1 ||
        actionSet.actions[0].type !== 'refresh-scope') {
        fail('lifecycle-scope-refresh-action-required')
    }
    const state = replayLifecycleRunLedger(ledger)
    const selector = verifySelectorReceipt(selectorReceipt)
    const changedNodeIds = selector.resolvedIssueSet.filter(
        (nodeId) =>
            state.selectorReceipt.remoteFactDigests[nodeId] !==
            selector.remoteFactDigests[nodeId]
    )
    if (changedNodeIds.length === 0) {
        fail('lifecycle-scope-refresh-without-change')
    }
    const remote =
        compileLifecycleRemoteSnapshotReceipt(selector)
    const next = clone(ledger)
    appendControlEvent(next, controlEvent({
        ledger: next,
        eventType: 'scope.refreshed',
        payload: {
            selectorReceipt: selector,
            remoteSnapshotReceipt: remote,
            changedNodeIds
        },
        globalSequence: nextGlobalSequence(next),
        createdAt
    }))
    return sealLedger(next)
}

export function recordLifecycleBaseChange({
    ledger,
    repository,
    baseSha,
    createdAt
} = {}) {
    validateLedgerEnvelope(ledger)
    requireText(repository, 'lifecycle-base-change-repository')
    requireSha(baseSha, 'lifecycle-base-change-sha-invalid')
    const state = replayLifecycleRunLedger(ledger)
    const current = state.repositories[repository]
    if (!current || current.baseSha === baseSha) {
        fail('lifecycle-base-change-invalid')
    }
    const eligible = Object.values(state.nodes).some((node) =>
        node.repository === repository &&
        [
            'acceptance-frozen',
            'test-contract-planning',
            'test-contracting'
        ].includes(node.lifecycleState)
    )
    if (!eligible) fail('lifecycle-base-change-not-rebindable')
    const next = clone(ledger)
    appendControlEvent(next, controlEvent({
        ledger: next,
        eventType: 'repository.base-changed',
        payload: { repository, baseSha },
        globalSequence: nextGlobalSequence(next),
        createdAt
    }))
    return sealLedger(next)
}

export function persistLifecycleRunLedger({
    stateRoot,
    ledger
} = {}) {
    validateLedgerEnvelope(ledger)
    const file = ledgerLocation(
        stateRoot,
        ledger.header.runId
    )
    atomicWrite(
        file,
        `${JSON.stringify(ledger, null, 2)}\n`
    )
    return Object.freeze({
        stateRoot: path.resolve(stateRoot),
        runId: ledger.header.runId,
        ledgerPath: file,
        ledgerDigest: ledger.ledgerDigest
    })
}

export function readLifecycleRunLedger({
    stateRoot,
    runId
} = {}) {
    const file = ledgerLocation(stateRoot, runId)
    let ledger
    try {
        ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        fail('lifecycle-run-ledger-unavailable')
    }
    validateLedgerEnvelope(ledger)
    replayLifecycleRunLedger(ledger)
    return Object.freeze(ledger)
}
