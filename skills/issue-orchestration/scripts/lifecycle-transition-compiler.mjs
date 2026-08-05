// Pure deterministic compiler from verified orchestration state to next actions.

import { digest } from './runtime-contract-lib.mjs'
import { verifySelectorReceipt } from './scope-selector.mjs'
import { validateSemanticGraph } from './semantic-runtime-projection.mjs'
import {
    validateExecutionRouteDecision
} from './execution-route-compiler.mjs'
import {
    lifecycleActionRule,
    lifecycleDefinition
} from './lifecycle-state-machine.mjs'
import {
    selectWorkConservingCandidates
} from './frontier-compiler.mjs'
import {
    repositoryAuthorityFor,
    validateLifecycleAuthorityBinding
} from './lifecycle-genesis-authority.mjs'

const HASH = /^[a-f0-9]{64}$/u

export const LIFECYCLE_ACTION_SET_SCHEMA =
    'issue-orchestration.lifecycle-action-set.v1'

export const LIFECYCLE_ACTION_TYPES = Object.freeze([
    'refresh-scope',
    'request-semantic-proposal',
    'compile-acceptance-contract',
    'request-test-contract-planning',
    'dispatch-test-contract-writer',
    'dispatch-implementation-writer',
    'dispatch-behavior-verifier',
    'request-ui-adjudication',
    'dispatch-ux-acceptance-verifier',
    'dispatch-documentation-writer',
    'deliver-acceptance-group',
    'cleanup-node-resources',
    'terminalize-node',
    'idle'
])

const ACTION_SET_INPUT_FIELDS = new Set([
    'schema', 'selectorReceipt', 'remoteSnapshotReceipt', 'semanticGraph',
    'aggregateProjection', 'installedPolicy', 'runtimeCapabilityBinding',
    'lifecycleAuthority'
])

const FORBIDDEN_CALLER_FIELDS = [
    'stageState', 'stageSummary', 'summary', 'instructions', 'prompt',
    'semanticScope', 'testScope', 'implementationScope', 'writerPrompt',
    'candidateState', 'deliveryState'
]

const SLOT_ACTIONS = new Set([
    'request-semantic-proposal',
    'request-test-contract-planning',
    'dispatch-test-contract-writer',
    'dispatch-implementation-writer',
    'dispatch-behavior-verifier',
    'request-ui-adjudication',
    'dispatch-ux-acceptance-verifier',
    'dispatch-documentation-writer'
])

const DIGEST_FIELDS = Object.freeze([
    'receiptDigest', 'routeDecisionDigest', 'proposalDigest',
    'workPlanDigest', 'planDigest', 'sliceDigest', 'promptDigest',
    'inventoryDigest', 'contractDigest', 'bundleDigest', 'bindingDigest',
    'snapshotDigest', 'projectionDigest', 'eventDigest'
])

export class LifecycleTransitionError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecycleTransitionError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new LifecycleTransitionError(code, code, details)
}

function requireObject(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function requireDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
    return value
}

function unsignedDigest(value, field) {
    const copy = structuredClone(value)
    delete copy[field]
    return digest(copy)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(
        (key) => [key, canonical(value[key])]
    ))
}

function receiptDigest(receipt) {
    if (!receipt || typeof receipt !== 'object') return null
    for (const field of DIGEST_FIELDS) {
        if (HASH.test(receipt[field] ?? '')) return receipt[field]
    }
    return null
}

function receiptDigestMap(receipts = {}) {
    return Object.fromEntries(Object.entries(receipts)
        .map(([key, receipt]) => [key, receiptDigest(receipt)])
        .filter(([, value]) => value !== null)
        .sort(([left], [right]) => left.localeCompare(right)))
}

function validatePresentRoutes(receipts = {}) {
    for (const [key, receipt] of Object.entries(receipts)) {
        if (key !== 'routeDecision' && !key.endsWith('Route')) continue
        try {
            validateExecutionRouteDecision(receipt, {
                requireRuntimeBinding: true
            })
        } catch (error) {
            fail('lifecycle-route-invalid', {
                receiptKey: key,
                cause: error?.code ?? error?.message
            })
        }
    }
}

function validateInputs(input) {
    requireObject(input, 'lifecycle-input-invalid')
    for (const key of Object.keys(input)) {
        if (!ACTION_SET_INPUT_FIELDS.has(key)) {
            fail('lifecycle-caller-state-forbidden', { field: key })
        }
    }
    for (const field of FORBIDDEN_CALLER_FIELDS) {
        if (Object.hasOwn(input, field)) {
            fail('lifecycle-caller-state-forbidden', { field })
        }
    }
    if (input.schema !== 'issue-orchestration.lifecycle-compiler-input.v1') {
        fail('lifecycle-input-schema-invalid')
    }
    const selector = requireObject(
        input.selectorReceipt,
        'lifecycle-selector-invalid'
    )
    const remote = requireObject(
        input.remoteSnapshotReceipt,
        'lifecycle-remote-invalid'
    )
    const aggregate = requireObject(
        input.aggregateProjection,
        'lifecycle-aggregate-invalid'
    )
    const policy = requireObject(
        input.installedPolicy,
        'lifecycle-policy-invalid'
    )
    const capability = requireObject(
        input.runtimeCapabilityBinding,
        'lifecycle-capability-invalid'
    )
    const authority = requireObject(
        input.lifecycleAuthority,
        'lifecycle-authority-invalid'
    )
    try {
        verifySelectorReceipt(selector)
    } catch (error) {
        fail('lifecycle-selector-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    requireDigest(selector.receiptDigest, 'lifecycle-selector-digest-invalid')
    requireDigest(
        selector.remoteSnapshotDigest,
        'lifecycle-selector-remote-invalid'
    )
    if (remote.schema !== 'issue-orchestration.remote-snapshot-receipt.v1' ||
        remote.status !== 'verified') {
        fail('lifecycle-remote-invalid')
    }
    requireDigest(remote.receiptDigest, 'lifecycle-remote-digest-invalid')
    if (aggregate.schema !==
            'issue-orchestration.aggregate-runtime-projection.v1') {
        fail('lifecycle-aggregate-schema-invalid')
    }
    requireDigest(
        aggregate.aggregateProjectionDigest,
        'lifecycle-aggregate-digest-invalid'
    )
    if (unsignedDigest(aggregate, 'aggregateProjectionDigest') !==
            aggregate.aggregateProjectionDigest) {
        fail('lifecycle-aggregate-digest-mismatch')
    }
    validateSemanticGraph(input.semanticGraph)
    if (policy.schema !== 'issue-orchestration.installed-route-policy.v1' ||
        policy.status !== 'verified') {
        fail('lifecycle-policy-invalid')
    }
    requireDigest(policy.policyDigest, 'lifecycle-policy-digest-invalid')
    if (policy.policyDigest !== input.semanticGraph.policyDigest) {
        fail('lifecycle-policy-binding-stale')
    }
    if (capability.schema !==
            'issue-orchestration.runtime-capability-binding.v1' ||
        capability.status !== 'verified') {
        fail('lifecycle-capability-invalid')
    }
    requireDigest(
        capability.bindingDigest,
        'lifecycle-capability-digest-invalid'
    )
    if (authority.schema !==
            'issue-orchestration.lifecycle-run-authority.v1' ||
        authority.status !== 'verified' ||
        authority.producerAuthority !==
            'machine-lifecycle-genesis-authority' ||
        authority.authorityDigest !==
            unsignedDigest(authority, 'authorityDigest')) {
        fail('lifecycle-authority-invalid')
    }
    try {
        validateLifecycleAuthorityBinding(authority.binding)
    } catch (error) {
        fail('lifecycle-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (authority.runId !== aggregate.runId ||
        authority.binding.runId !== aggregate.runId ||
        aggregate.lifecycleAuthorityBinding?.bindingDigest !==
            authority.binding.bindingDigest ||
        authority.runtimeCapabilityBinding.bindingDigest !==
            capability.bindingDigest ||
        authority.binding.runtimeCapabilityBindingDigest !==
            capability.bindingDigest ||
        selector.lifecycleAuthorityBindingDigest !==
            authority.binding.bindingDigest ||
        selector.startupAttestationDigest !==
            authority.binding.startupAttestationDigest ||
        selector.runtimeInvocationId !==
            authority.binding.runtimeInvocationId ||
        selector.runtimeSessionId !==
            authority.binding.runtimeSessionId ||
        selector.rootAuthorityEpoch !==
            authority.binding.rootAuthorityEpoch ||
        selector.runtimeTrustBindingDigest !==
            authority.binding.runtimeTrustBindingDigest ||
        selector.repositoryBindingSetDigest !==
            authority.binding.repositoryBindingSetDigest) {
        fail('lifecycle-authority-binding-stale')
    }
    for (const repository of input.semanticGraph.repositories) {
        let repositoryAuthority
        try {
            repositoryAuthority = repositoryAuthorityFor(
                authority,
                repository.repository
            )
        } catch (error) {
            fail('lifecycle-authority-repository-invalid', {
                cause: error?.code ?? error?.message
            })
        }
        if (repository.bindingDigest !==
                repositoryAuthority.bindingDigest) {
            fail('lifecycle-authority-repository-binding-stale')
        }
    }
    return {
        selector,
        remote,
        aggregate,
        policy,
        capability,
        authority
    }
}

function stateAction(node, graphNode) {
    const receipts = graphNode.receipts ?? {}
    const state = node.lifecycleState
    if (node.quarantine || node.status === 'quarantined' ||
        state === 'quarantined') {
        return 'terminalize-node'
    }
    if (receipts.terminal) return 'terminalize-node'
    if (receipts.writerFailure && receipts.retryAuthorization) {
        if (['test-contracting', 'test-contract-planning'].includes(state)) {
            return 'dispatch-test-contract-writer'
        }
        if (['implementing', 'implementing-self-testing'].includes(state)) {
            return 'dispatch-implementation-writer'
        }
    }
    let action = lifecycleActionRule(state)
    if (state === 'test-contract-planning' &&
        receipts.testContractPlan && receipts.workPlan &&
        receipts.executableSlice && receipts.routeDecision &&
        receipts.compiledPrompt && receipts.resourceAcquisition) {
        action = 'dispatch-test-contract-writer'
    }
    if (state === 'behavior-green') {
        if (graphNode.uiClass !== 'non-ui' && !receipts.uiAdjudication) {
            return 'request-ui-adjudication'
        }
        if (graphNode.uiClass !== 'non-ui' && !receipts.uxAcceptance) {
            return 'dispatch-ux-acceptance-verifier'
        }
        if (receipts.documentationRequired === true &&
            !receipts.documentation) {
            return 'dispatch-documentation-writer'
        }
        return 'deliver-acceptance-group'
    }
    if (state === 'ux-accepted') {
        return receipts.documentationRequired === true &&
            !receipts.documentation
            ? 'dispatch-documentation-writer'
            : 'deliver-acceptance-group'
    }
    return action
}

function actionBindings({
    actionType,
    aggregate,
    authority,
    capability,
    graph,
    graphNode,
    node,
    policy
}) {
    const receipts = graphNode.receipts ?? {}
    validatePresentRoutes(receipts)
    const digests = receiptDigestMap(receipts)
    const bindings = {
        runId: aggregate.runId,
        nodeId: node.nodeId ?? graphNode.memberId,
        memberId: graphNode.memberId,
        repository: graphNode.repository,
        issueNumber: graphNode.issueNumber,
        baseSha: node.baseSha,
        nodeEpoch: node.nodeEpoch,
        selectorReceiptDigest: graph.selectorReceiptDigest,
        remoteSnapshotDigest: graph.remoteSnapshotDigest,
        semanticGraphDigest: graph.semanticGraphDigest,
        aggregateProjectionDigest: aggregate.aggregateProjectionDigest,
        nodeProjectionDigest: node.nodeProjectionDigest,
        priorLedgerHeadDigest: node.ledgerHeadDigest,
        policyDigest: policy.policyDigest,
        runtimeCapabilityBindingDigest: capability.bindingDigest,
        lifecycleAuthorityBindingDigest:
            authority.binding.bindingDigest,
        startupAttestationDigest:
            authority.binding.startupAttestationDigest,
        runtimeInvocationId:
            authority.binding.runtimeInvocationId,
        runtimeSessionId:
            authority.binding.runtimeSessionId,
        rootAuthorityEpoch:
            authority.binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest:
            authority.binding.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest:
            authority.binding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest:
            authority.binding.repositoryBindingSetDigest,
        repositoryBindingDigest:
            graphNode.repositoryBindingDigest,
        packageDigest: authority.binding.packageDigest,
        manifestDigest: authority.binding.manifestDigest,
        policySetDigest: authority.binding.policySetDigest,
        receiptDigests: digests
    }
    for (const [field, code] of [
        ['baseSha', 'lifecycle-node-base-missing'],
        ['selectorReceiptDigest', 'lifecycle-selector-binding-missing'],
        ['remoteSnapshotDigest', 'lifecycle-remote-binding-missing'],
        ['semanticGraphDigest', 'lifecycle-graph-binding-missing'],
        ['aggregateProjectionDigest', 'lifecycle-aggregate-binding-missing'],
        ['nodeProjectionDigest', 'lifecycle-node-projection-binding-missing'],
        ['priorLedgerHeadDigest', 'lifecycle-ledger-head-binding-missing'],
        ['policyDigest', 'lifecycle-policy-binding-missing'],
        ['runtimeCapabilityBindingDigest', 'lifecycle-capability-binding-missing'],
        ['lifecycleAuthorityBindingDigest', 'lifecycle-authority-binding-missing'],
        ['startupAttestationDigest', 'lifecycle-startup-binding-missing'],
        ['runtimeTrustBindingDigest', 'lifecycle-trust-binding-missing'],
        ['repositoryIdentitySetDigest', 'lifecycle-repository-identity-binding-missing'],
        ['repositoryBindingSetDigest', 'lifecycle-repository-set-binding-missing'],
        ['repositoryBindingDigest', 'lifecycle-repository-binding-missing'],
        ['packageDigest', 'lifecycle-package-binding-missing'],
        ['manifestDigest', 'lifecycle-manifest-binding-missing'],
        ['policySetDigest', 'lifecycle-policy-set-binding-missing']
    ]) {
        const value = bindings[field]
        const valid = field === 'baseSha'
            ? /^[a-f0-9]{40}$/u.test(value ?? '')
            : HASH.test(value ?? '')
        if (!valid) fail(code, { nodeId: bindings.nodeId, actionType })
    }
    if (!Number.isInteger(bindings.issueNumber) ||
        !Number.isInteger(bindings.nodeEpoch) || bindings.nodeEpoch < 1) {
        fail('lifecycle-node-identity-invalid', { nodeId: bindings.nodeId })
    }
    for (const field of [
        'runtimeInvocationId',
        'runtimeSessionId',
        'rootAuthorityEpoch'
    ]) {
        if (typeof bindings[field] !== 'string' ||
            bindings[field].length === 0) {
            fail('lifecycle-authority-binding-missing', {
                nodeId: bindings.nodeId,
                field
            })
        }
    }
    return bindings
}

function makeAction(context) {
    const bindings = actionBindings(context)
    const action = {
        schema: 'issue-orchestration.lifecycle-action.v1',
        type: context.actionType,
        nodeId: bindings.nodeId,
        acceptanceGroup: context.graphNode.acceptanceGroup ?? null,
        lifecycleState: context.node.lifecycleState,
        recoveryMode:
            context.graphNode.receipts?.writerFailure &&
            context.graphNode.receipts?.retryAuthorization
                ? 'authorized-continuation'
                : 'none',
        bindings
    }
    action.actionDigest = digest(action)
    return action
}

function activeGroupFreeze(aggregate, groupId) {
    return Object.entries(aggregate.deliveryFreezes ?? {})
        .find(([, freeze]) =>
            freeze?.active === true && freeze.groupId === groupId) ?? null
}

function groupReady(groupId, members, aggregate, graphById) {
    if (aggregate.deliveryEffects?.[groupId]) return false
    const pending = aggregate.pendingDeliveryEffects?.[groupId] ?? null
    return members.length > 0 && members.every((nodeId) => {
        const node = aggregate.nodes[nodeId]
        const graphNode = graphById.get(nodeId)
        if (!node || !graphNode || node.quarantine) return false
        if (node.blockedBy?.length) return false
        if (pending && node.lifecycleState === 'cleaning') {
            return node.deliveryCommit === pending.commits?.[nodeId]
        }
        const action = stateAction(node, graphNode)
        return action === 'deliver-acceptance-group' ||
            node.lifecycleState === 'closed'
    })
}

function makeGroupAction({
    aggregate,
    authority,
    capability,
    graph,
    graphById,
    groupId,
    members,
    policy
}) {
    const activeFreeze = activeGroupFreeze(aggregate, groupId)
    const pendingEffect = aggregate.pendingDeliveryEffects?.[groupId] ?? null
    const nodes = members.map((nodeId) => {
        const node = aggregate.nodes[nodeId]
        const graphNode = graphById.get(nodeId)
        return actionBindings({
            actionType: 'deliver-acceptance-group',
            aggregate,
            authority,
            capability,
            graph,
            graphNode,
            node,
            policy
        })
    })
    const action = {
        schema: 'issue-orchestration.lifecycle-action.v1',
        type: 'deliver-acceptance-group',
        nodeId: null,
        acceptanceGroup: groupId,
        lifecycleState: 'group-ready',
        recoveryMode: pendingEffect
            ? 'remote-effect-reobservation'
            : activeFreeze
                ? 'delivery-freeze-reentry'
                : 'none',
        bindings: {
            runId: aggregate.runId,
            selectorReceiptDigest: graph.selectorReceiptDigest,
            remoteSnapshotDigest: graph.remoteSnapshotDigest,
            semanticGraphDigest: graph.semanticGraphDigest,
            aggregateProjectionDigest: aggregate.aggregateProjectionDigest,
            policyDigest: policy.policyDigest,
            runtimeCapabilityBindingDigest: capability.bindingDigest,
            lifecycleAuthorityBindingDigest:
                authority.binding.bindingDigest,
            startupAttestationDigest:
                authority.binding.startupAttestationDigest,
            runtimeInvocationId:
                authority.binding.runtimeInvocationId,
            runtimeSessionId:
                authority.binding.runtimeSessionId,
            rootAuthorityEpoch:
                authority.binding.rootAuthorityEpoch,
            runtimeTrustBindingDigest:
                authority.binding.runtimeTrustBindingDigest,
            repositoryIdentitySetDigest:
                authority.binding.repositoryIdentitySetDigest,
            repositoryBindingSetDigest:
                authority.binding.repositoryBindingSetDigest,
            packageDigest: authority.binding.packageDigest,
            manifestDigest: authority.binding.manifestDigest,
            policySetDigest: authority.binding.policySetDigest,
            activeDeliveryFreeze: activeFreeze
                ? structuredClone(activeFreeze[1])
                : null,
            pendingDeliveryEffect: pendingEffect
                ? structuredClone(pendingEffect)
                : null,
            memberBindings: nodes
        }
    }
    action.actionDigest = digest(action)
    return action
}

export function compileLifecycleRemoteSnapshotReceipt(selectorReceipt) {
    let selector
    try {
        selector = verifySelectorReceipt(selectorReceipt)
    } catch (error) {
        fail('lifecycle-selector-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    requireDigest(
        selector.receiptDigest,
        'lifecycle-selector-digest-invalid'
    )
    requireDigest(
        selector.remoteSnapshotDigest,
        'lifecycle-selector-remote-invalid'
    )
    return Object.freeze({
        schema: 'issue-orchestration.remote-snapshot-receipt.v1',
        status: 'verified',
        selectorReceiptDigest: selector.receiptDigest,
        receiptDigest: selector.remoteSnapshotDigest
    })
}

export function compileLifecycleActionSet(input = {}) {
    const {
        selector, remote, aggregate, policy, capability, authority
    } = validateInputs(input)
    const graph = input.semanticGraph
    if (selector.receiptDigest !== graph.selectorReceiptDigest ||
        remote.receiptDigest !== graph.remoteSnapshotDigest ||
        selector.remoteSnapshotDigest !== remote.receiptDigest) {
        const action = {
            schema: 'issue-orchestration.lifecycle-action.v1',
            type: 'refresh-scope',
            nodeId: null,
            acceptanceGroup: null,
            lifecycleState: 'stale-scope',
            recoveryMode: 'none',
            bindings: {
                runId: aggregate.runId,
                observedSelectorReceiptDigest: selector.receiptDigest,
                observedRemoteSnapshotDigest: remote.receiptDigest,
                semanticGraphSelectorReceiptDigest:
                    graph.selectorReceiptDigest,
                semanticGraphRemoteSnapshotDigest:
                    graph.remoteSnapshotDigest,
                aggregateProjectionDigest:
                    aggregate.aggregateProjectionDigest,
                policyDigest: policy.policyDigest,
                runtimeCapabilityBindingDigest: capability.bindingDigest,
                lifecycleAuthorityBindingDigest:
                    authority.binding.bindingDigest,
                startupAttestationDigest:
                    authority.binding.startupAttestationDigest,
                runtimeInvocationId:
                    authority.binding.runtimeInvocationId,
                runtimeSessionId:
                    authority.binding.runtimeSessionId,
                rootAuthorityEpoch:
                    authority.binding.rootAuthorityEpoch,
                runtimeTrustBindingDigest:
                    authority.binding.runtimeTrustBindingDigest,
                repositoryIdentitySetDigest:
                    authority.binding.repositoryIdentitySetDigest,
                repositoryBindingSetDigest:
                    authority.binding.repositoryBindingSetDigest,
                packageDigest: authority.binding.packageDigest,
                manifestDigest: authority.binding.manifestDigest,
                policySetDigest: authority.binding.policySetDigest
            }
        }
        action.actionDigest = digest(action)
        return sealActionSet({
            aggregate,
            authority,
            capability,
            graph,
            policy,
            actions: [action],
            availableSlots: 0
        })
    }
    const graphById = new Map(graph.nodes.map((node) => [
        node.memberId,
        node
    ]))
    const capacity = aggregate.slots?.capacity ?? 0
    const active = aggregate.slots?.active ?? []
    if (!Number.isInteger(capacity) || capacity < 0 ||
        !Array.isArray(active)) {
        fail('lifecycle-slots-invalid')
    }
    const initialAvailableSlots = Math.max(0, capacity - active.length)
    let availableSlots = initialAvailableSlots
    const activeNodeIds = new Set(active)
    const immediateActions = []
    const slotCandidates = []
    const groupActions = []
    const deliveredGroups = new Set()
    for (const [nodeId, node] of Object.entries(aggregate.nodes)
        .sort(([left], [right]) => left.localeCompare(right))) {
        const graphNode = graphById.get(nodeId)
        if (!graphNode) fail('lifecycle-node-graph-binding-missing', { nodeId })
        if (node.blockedBy?.length || aggregate.deliveryFreezes?.[nodeId]) {
            continue
        }
        const actionType = stateAction(node, graphNode)
        if (!actionType) continue
        if (actionType === 'deliver-acceptance-group') {
            const groupId = graphNode.acceptanceGroup ?? `node:${nodeId}`
            if (deliveredGroups.has(groupId)) continue
            const members = aggregate.acceptanceGroups?.[groupId] ?? [nodeId]
            if (!groupReady(groupId, members, aggregate, graphById)) continue
            groupActions.push(makeGroupAction({
                aggregate, authority, capability, graph, graphById,
                groupId, members, policy
            }))
            deliveredGroups.add(groupId)
            continue
        }
        const action = makeAction({
            actionType,
            aggregate,
            authority,
            capability,
            graph,
            graphNode,
            node,
            policy
        })
        if (SLOT_ACTIONS.has(actionType)) {
            if (node.activeAttemptId || activeNodeIds.has(nodeId) ||
                node.dispatchable === false) {
                continue
            }
            slotCandidates.push({
                issueId: nodeId,
                stage: actionType,
                action
            })
        } else {
            immediateActions.push(action)
        }
    }
    let actions
    if (groupActions.length > 0) {
        actions = [groupActions.sort((left, right) =>
            left.acceptanceGroup.localeCompare(right.acceptanceGroup))[0]]
        availableSlots = 0
    } else {
        const selected = selectWorkConservingCandidates({
            candidates: slotCandidates,
            availableSlots: initialAvailableSlots
        })
        availableSlots = initialAvailableSlots - selected.length
        actions = [
            ...immediateActions,
            ...selected.map(({ action }) => action)
        ].sort((left, right) =>
            `${left.nodeId ?? ''}@${left.type}`.localeCompare(
                `${right.nodeId ?? ''}@${right.type}`
            )
        )
    }
    if (actions.length === 0) {
        const idle = {
            schema: 'issue-orchestration.lifecycle-action.v1',
            type: 'idle',
            nodeId: null,
            acceptanceGroup: null,
            lifecycleState: 'quiescent',
            recoveryMode: 'none',
            bindings: {
                runId: aggregate.runId,
                semanticGraphDigest: graph.semanticGraphDigest,
                aggregateProjectionDigest:
                    aggregate.aggregateProjectionDigest,
                policyDigest: policy.policyDigest,
                runtimeCapabilityBindingDigest: capability.bindingDigest,
                lifecycleAuthorityBindingDigest:
                    authority.binding.bindingDigest,
                startupAttestationDigest:
                    authority.binding.startupAttestationDigest,
                runtimeInvocationId:
                    authority.binding.runtimeInvocationId,
                runtimeSessionId:
                    authority.binding.runtimeSessionId,
                rootAuthorityEpoch:
                    authority.binding.rootAuthorityEpoch,
                runtimeTrustBindingDigest:
                    authority.binding.runtimeTrustBindingDigest,
                repositoryIdentitySetDigest:
                    authority.binding.repositoryIdentitySetDigest,
                repositoryBindingSetDigest:
                    authority.binding.repositoryBindingSetDigest,
                packageDigest: authority.binding.packageDigest,
                manifestDigest: authority.binding.manifestDigest,
                policySetDigest: authority.binding.policySetDigest
            }
        }
        idle.actionDigest = digest(idle)
        actions.push(idle)
    }
    return sealActionSet({
        aggregate,
        authority,
        capability,
        graph,
        policy,
        actions,
        availableSlots
    })
}

function sealActionSet({
    aggregate,
    authority,
    capability,
    graph,
    policy,
    actions,
    availableSlots
}) {
    const actionSet = canonical({
        schema: LIFECYCLE_ACTION_SET_SCHEMA,
        runId: aggregate.runId,
        selectorReceiptDigest: graph.selectorReceiptDigest,
        remoteSnapshotDigest: graph.remoteSnapshotDigest,
        semanticGraphDigest: graph.semanticGraphDigest,
        aggregateProjectionDigest: aggregate.aggregateProjectionDigest,
        policyDigest: policy.policyDigest,
        runtimeCapabilityBindingDigest: capability.bindingDigest,
        lifecycleAuthorityBindingDigest:
            authority.binding.bindingDigest,
        startupAttestationDigest:
            authority.binding.startupAttestationDigest,
        runtimeInvocationId:
            authority.binding.runtimeInvocationId,
        runtimeSessionId:
            authority.binding.runtimeSessionId,
        rootAuthorityEpoch:
            authority.binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest:
            authority.binding.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest:
            authority.binding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest:
            authority.binding.repositoryBindingSetDigest,
        packageDigest: authority.binding.packageDigest,
        manifestDigest: authority.binding.manifestDigest,
        policySetDigest: authority.binding.policySetDigest,
        availableSlots,
        quiescent: actions.length === 1 && actions[0].type === 'idle',
        actions
    })
    actionSet.actionSetDigest = digest(actionSet)
    return Object.freeze(actionSet)
}

function requireString(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function validateTopBinding(bindings, actionSet, field, code) {
    requireDigest(bindings[field], code)
    if (bindings[field] !== actionSet[field]) fail(code)
}

function validateAuthorityActionBindings(bindings, actionSet) {
    for (const [field, code] of [
        ['lifecycleAuthorityBindingDigest', 'lifecycle-action-authority-binding-invalid'],
        ['startupAttestationDigest', 'lifecycle-action-startup-binding-invalid'],
        ['runtimeTrustBindingDigest', 'lifecycle-action-trust-binding-invalid'],
        ['repositoryIdentitySetDigest', 'lifecycle-action-repository-identity-invalid'],
        ['repositoryBindingSetDigest', 'lifecycle-action-repository-set-invalid'],
        ['packageDigest', 'lifecycle-action-package-binding-invalid'],
        ['manifestDigest', 'lifecycle-action-manifest-binding-invalid'],
        ['policySetDigest', 'lifecycle-action-policy-set-binding-invalid']
    ]) validateTopBinding(bindings, actionSet, field, code)
    for (const field of [
        'runtimeInvocationId',
        'runtimeSessionId',
        'rootAuthorityEpoch'
    ]) {
        requireString(bindings[field], 'lifecycle-action-authority-identity-invalid')
        if (bindings[field] !== actionSet[field]) {
            fail('lifecycle-action-authority-identity-invalid')
        }
    }
}

function validateNodeActionBindings(action, actionSet, bindings) {
    requireString(bindings.runId, 'lifecycle-action-run-id-invalid')
    requireString(bindings.nodeId, 'lifecycle-action-node-id-invalid')
    requireString(bindings.memberId, 'lifecycle-action-member-id-invalid')
    requireString(bindings.repository, 'lifecycle-action-repository-invalid')
    if (bindings.runId !== actionSet.runId ||
        bindings.nodeId !== action.nodeId ||
        !Number.isInteger(bindings.issueNumber) ||
        bindings.issueNumber < 1 ||
        !Number.isInteger(bindings.nodeEpoch) ||
        bindings.nodeEpoch < 1 ||
        !/^[a-f0-9]{40}$/u.test(bindings.baseSha ?? '')) {
        fail('lifecycle-action-node-identity-invalid')
    }
    for (const [field, code] of [
        ['selectorReceiptDigest', 'lifecycle-action-selector-binding-invalid'],
        ['remoteSnapshotDigest', 'lifecycle-action-remote-binding-invalid'],
        ['semanticGraphDigest', 'lifecycle-action-graph-binding-invalid'],
        ['aggregateProjectionDigest', 'lifecycle-action-aggregate-binding-invalid'],
        ['policyDigest', 'lifecycle-action-policy-binding-invalid'],
        ['runtimeCapabilityBindingDigest', 'lifecycle-action-capability-binding-invalid']
    ]) validateTopBinding(bindings, actionSet, field, code)
    validateAuthorityActionBindings(bindings, actionSet)
    requireDigest(
        bindings.repositoryBindingDigest,
        'lifecycle-action-repository-binding-invalid'
    )
    requireDigest(
        bindings.nodeProjectionDigest,
        'lifecycle-action-node-projection-invalid'
    )
    requireDigest(
        bindings.priorLedgerHeadDigest,
        'lifecycle-action-ledger-head-invalid'
    )
    requireObject(
        bindings.receiptDigests,
        'lifecycle-action-receipt-digests-invalid'
    )
    for (const value of Object.values(bindings.receiptDigests)) {
        requireDigest(value, 'lifecycle-action-receipt-digests-invalid')
    }
}

function validateActionBindings(action, actionSet) {
    const bindings = requireObject(
        action.bindings,
        'lifecycle-action-bindings-invalid'
    )
    if (action.type === 'refresh-scope') {
        if (action.nodeId !== null || actionSet.actions.length !== 1) {
            fail('lifecycle-refresh-action-invalid')
        }
        requireString(bindings.runId, 'lifecycle-action-run-id-invalid')
        if (bindings.runId !== actionSet.runId) {
            fail('lifecycle-action-run-id-invalid')
        }
        for (const field of [
            'observedSelectorReceiptDigest',
            'observedRemoteSnapshotDigest',
            'semanticGraphSelectorReceiptDigest',
            'semanticGraphRemoteSnapshotDigest'
        ]) requireDigest(bindings[field], 'lifecycle-refresh-binding-invalid')
        for (const [field, code] of [
            ['aggregateProjectionDigest', 'lifecycle-action-aggregate-binding-invalid'],
            ['policyDigest', 'lifecycle-action-policy-binding-invalid'],
            ['runtimeCapabilityBindingDigest', 'lifecycle-action-capability-binding-invalid']
        ]) validateTopBinding(bindings, actionSet, field, code)
        validateAuthorityActionBindings(bindings, actionSet)
        return
    }
    if (action.type === 'idle') {
        if (action.nodeId !== null || actionSet.actions.length !== 1) {
            fail('lifecycle-idle-action-invalid')
        }
        requireString(bindings.runId, 'lifecycle-action-run-id-invalid')
        if (bindings.runId !== actionSet.runId) {
            fail('lifecycle-action-run-id-invalid')
        }
        for (const [field, code] of [
            ['semanticGraphDigest', 'lifecycle-action-graph-binding-invalid'],
            ['aggregateProjectionDigest', 'lifecycle-action-aggregate-binding-invalid'],
            ['policyDigest', 'lifecycle-action-policy-binding-invalid'],
            ['runtimeCapabilityBindingDigest', 'lifecycle-action-capability-binding-invalid']
        ]) validateTopBinding(bindings, actionSet, field, code)
        validateAuthorityActionBindings(bindings, actionSet)
        return
    }
    if (action.type === 'deliver-acceptance-group') {
        if (action.nodeId !== null || actionSet.actions.length !== 1 ||
            typeof action.acceptanceGroup !== 'string' ||
            action.acceptanceGroup.length === 0) {
            fail('lifecycle-group-action-invalid')
        }
        requireString(bindings.runId, 'lifecycle-action-run-id-invalid')
        if (bindings.runId !== actionSet.runId) {
            fail('lifecycle-action-run-id-invalid')
        }
        for (const [field, code] of [
            ['selectorReceiptDigest', 'lifecycle-action-selector-binding-invalid'],
            ['remoteSnapshotDigest', 'lifecycle-action-remote-binding-invalid'],
            ['semanticGraphDigest', 'lifecycle-action-graph-binding-invalid'],
            ['aggregateProjectionDigest', 'lifecycle-action-aggregate-binding-invalid'],
            ['policyDigest', 'lifecycle-action-policy-binding-invalid'],
            ['runtimeCapabilityBindingDigest', 'lifecycle-action-capability-binding-invalid']
        ]) validateTopBinding(bindings, actionSet, field, code)
        validateAuthorityActionBindings(bindings, actionSet)
        if (!Array.isArray(bindings.memberBindings) ||
            bindings.memberBindings.length === 0) {
            fail('lifecycle-group-members-invalid')
        }
        for (const memberBindings of bindings.memberBindings) {
            validateNodeActionBindings(
                { nodeId: memberBindings.nodeId },
                actionSet,
                memberBindings
            )
        }
        return
    }
    if (typeof action.nodeId !== 'string' || action.nodeId.length === 0) {
        fail('lifecycle-action-node-id-invalid')
    }
    validateNodeActionBindings(action, actionSet, bindings)
}

export function validateLifecycleActionSet(actionSet) {
    requireObject(actionSet, 'lifecycle-action-set-invalid')
    if (actionSet.schema !== LIFECYCLE_ACTION_SET_SCHEMA ||
        typeof actionSet.runId !== 'string' || actionSet.runId.length === 0 ||
        !Array.isArray(actionSet.actions) ||
        actionSet.actions.length === 0 ||
        !Number.isInteger(actionSet.availableSlots) ||
        actionSet.availableSlots < 0 ||
        typeof actionSet.quiescent !== 'boolean') {
        fail('lifecycle-action-set-invalid')
    }
    for (const action of actionSet.actions) {
        if (action?.schema !== 'issue-orchestration.lifecycle-action.v1' ||
            !LIFECYCLE_ACTION_TYPES.includes(action.type) ||
            !HASH.test(action.actionDigest ?? '') ||
            unsignedDigest(action, 'actionDigest') !== action.actionDigest) {
            fail('lifecycle-action-invalid')
        }
        validateActionBindings(action, actionSet)
    }
    const identities = actionSet.actions.map((action) =>
        `${action.type}:${action.nodeId ?? action.acceptanceGroup ?? 'run'}`
    )
    if (new Set(identities).size !== identities.length) {
        fail('lifecycle-action-duplicate')
    }
    for (const field of [
        'selectorReceiptDigest', 'remoteSnapshotDigest',
        'semanticGraphDigest', 'aggregateProjectionDigest', 'policyDigest',
        'runtimeCapabilityBindingDigest',
        'lifecycleAuthorityBindingDigest',
        'startupAttestationDigest',
        'runtimeTrustBindingDigest',
        'repositoryIdentitySetDigest',
        'repositoryBindingSetDigest',
        'packageDigest',
        'manifestDigest',
        'policySetDigest',
        'actionSetDigest'
    ]) requireDigest(actionSet[field], 'lifecycle-action-set-digest-invalid')
    for (const field of [
        'runtimeInvocationId',
        'runtimeSessionId',
        'rootAuthorityEpoch'
    ]) requireString(
        actionSet[field],
        'lifecycle-action-set-authority-identity-invalid'
    )
    if (unsignedDigest(actionSet, 'actionSetDigest') !==
        actionSet.actionSetDigest) {
        fail('lifecycle-action-set-digest-mismatch')
    }
    if (actionSet.quiescent !==
        (actionSet.actions.length === 1 &&
        actionSet.actions[0].type === 'idle')) {
        fail('lifecycle-quiescence-invalid')
    }
    return actionSet
}

export function lifecycleActionForState(state) {
    const definition = lifecycleDefinition(state)
    if (!definition && lifecycleActionRule(state) === null) return null
    return lifecycleActionRule(state)
}
