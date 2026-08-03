import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import fs from 'node:fs'
import path from 'node:path'
import {
    compileContinuation,
    compileDispatchPrompt,
    compileExecutableSlice,
    validateSealedCompiledDispatchPrompt,
    validateSealedExecutableSlice,
    validateSealedStageWorkPlan
} from './executable-slice-compiler.mjs'
import {
    replayEventLedgerSync
} from './event-ledger.mjs'
import {
    evaluateSliceTerminalGate,
    validateSealedWriterStageCheckpointEvidence
} from './writer-stage-progress.mjs'
import {
    validateRouteBoundActor
} from './execution-route-compiler.mjs'

const REMOTE_MUTATION_POLICY = Object.freeze(JSON.parse(fs.readFileSync(
    path.resolve(
        import.meta.dirname,
        '../../../policy/remote-mutation-policy.json'
    ),
    'utf8'
)))
if (REMOTE_MUTATION_POLICY.schema
        !== 'issue-orchestration.remote-mutation-policy.v2'
    || REMOTE_MUTATION_POLICY.projectionOnlyUpdaterDispatchAllowed
        !== false) {
    throw new Error('remote-mutation-policy-source-invalid')
}
const EXPECTED_MUTATION_TYPES = new Set(
    REMOTE_MUTATION_POLICY.expectedMutationTypes
)
const SEMANTIC_MUTATION_TYPES = new Set(
    REMOTE_MUTATION_POLICY.semanticMutationTypes
)

const SEMANTIC_GRAPH_SCHEMA = 'issue-orchestration.semantic-graph.v2'
const RUNTIME_PROJECTION_SCHEMA = 'issue-orchestration.runtime-projection.v1'
const EXPECTED_MUTATIONS_SCHEMA =
    'issue-orchestration.expected-remote-mutations.v1'
const GRAPH_PATCH_SCHEMA = 'issue-orchestration.semantic-graph-patch.v1'
const FULL_PROPOSAL_SCHEMA = 'issue-orchestration.semantic-graph-proposal.v1'
const DECISION_RECEIPT_SCHEMA =
    'issue-orchestration.dag-update-decision-receipt.v1'
const PROJECTOR_VERSION = 'issue-orchestration.runtime-projector.v1'
const PROJECTOR_DIGEST = digest({
    projectorVersion: PROJECTOR_VERSION,
    inputs: [
        'immutable-runtime-ledger.v1-non-writer-historical',
        'ledger.v2-canonical-active-writer-replay',
        'semantic-graph.v2',
        'runtime-facts.v1'
    ],
    outputs: [
        'completed',
        'ready-and-blocked',
        'critical-path',
        'conflicts',
        'slots-and-leases',
        'next-executable-frontier',
        'writer-stage-artifacts-and-breakers',
        'writer-checkpoint-fork-and-terminal-chain-digests'
    ]
})

const SHA256 = /^[a-f0-9]{64}$/u
const GIT_SHA = /^[a-f0-9]{40}$/u
const ALLOWED_PATCH_OPERATIONS = new Set([
    'add-node',
    'remove-node',
    'add-edge',
    'remove-edge',
    'change-owner',
    'change-conflict-key',
    'change-risk-class',
    'change-ui-class',
    'change-acceptance-group'
])
const DECISION_FIELDS = [
    'dagUpdateMode',
    'remoteMutationClassification',
    'expectedRemoteMutationDigest',
    'expectedRemoteMutationMatched',
    'scopeDigestBefore',
    'scopeDigestAfter',
    'semanticGraphInputDigestBefore',
    'semanticGraphInputDigestAfter',
    'semanticGraphDigestBefore',
    'semanticGraphDigestAfter',
    'runtimeProjectionDigestBefore',
    'runtimeProjectionDigestAfter',
    'baseSemanticGraphDigest',
    'graphPatchDigest',
    'graphPatchOperationCount',
    'dagUpdaterDispatchRequestId',
    'dagUpdaterDispatchReceiptDigest',
    'fullProposalReason',
    'projectorVersion',
    'projectorDigest'
]
const GRAPH_OWNED_PROJECTION_FIELDS = new Set([
    'edges',
    'nodes',
    'operations',
    'semanticEdges',
    'semanticNodes'
])
const SEMANTIC_PAYLOAD_PROJECTION_FIELDS = new Set([
    'fullGraph',
    'graphPatch',
    'semanticGraph',
    'semanticGraphPatch'
])

function fail(code, message = code, details = {}) {
    const error = new Error(message)
    error.code = code
    Object.assign(error, details)
    throw error
}

function clone(value) {
    return structuredClone(value)
}

function canonical(value, semanticKey = null) {
    if (Array.isArray(value)) {
        const normalized = value.map((item) => canonical(item))
        if ([
            'completedSlicePrefix',
            'completedSliceReceiptDigests',
            'priorTerminalReceiptDigests'
        ].includes(semanticKey)) {
            return normalized
        }
        return normalized.sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key], key)]))
}

function orderedCanonical(value) {
    if (Array.isArray(value)) return value.map(orderedCanonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, orderedCanonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function orderedDigest(value) {
    return createHash('sha256')
        .update(
            Buffer.isBuffer(value)
                ? value
                : JSON.stringify(orderedCanonical(value))
        )
        .digest('hex')
}

function unsignedDigest(value, field) {
    const unsigned = clone(value)
    delete unsigned[field]
    return digest(unsigned)
}

function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function sameOrderedValue(left, right) {
    return JSON.stringify(orderedCanonical(left)) ===
        JSON.stringify(orderedCanonical(right))
}

function requireObject(value, code, message = code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code, message)
    }
}

function requireString(value, code, message = code) {
    if (typeof value !== 'string' || value.length === 0) fail(code, message)
}

function requireSha(value, code, message = code) {
    if (typeof value !== 'string' || !SHA256.test(value)) fail(code, message)
}

function uniqueSorted(values = []) {
    if (!Array.isArray(values)) fail('semantic-graph-field-invalid')
    return [...new Set(values)].sort()
}

function normalizeRepository(repository) {
    requireObject(repository, 'semantic-graph-repository-invalid')
    requireString(
        repository.repository,
        'semantic-graph-repository-identity-invalid'
    )
    if (!GIT_SHA.test(repository.baseSha ?? '')) {
        fail('semantic-graph-repository-base-invalid')
    }
    requireSha(
        repository.bindingDigest,
        'semantic-graph-repository-binding-invalid'
    )
    return {
        repository: repository.repository,
        baseSha: repository.baseSha,
        bindingDigest: repository.bindingDigest
    }
}

function normalizeNode(node) {
    requireObject(node, 'semantic-graph-node-invalid')
    const id = node.id ?? node.memberId
    const memberId = node.memberId ?? node.id
    requireString(id, 'semantic-graph-node-id-invalid')
    requireString(memberId, 'semantic-graph-node-member-id-invalid')
    if (id !== memberId) fail('semantic-graph-node-identity-mismatch')
    requireString(node.repository, 'semantic-graph-node-repository-invalid')
    if (!Number.isInteger(node.issueNumber) || node.issueNumber <= 0) {
        fail('semantic-graph-node-issue-number-invalid')
    }
    requireString(node.owner, 'semantic-graph-node-owner-invalid')
    requireString(node.riskClass, 'semantic-graph-node-risk-class-invalid')
    requireString(node.uiClass, 'semantic-graph-node-ui-class-invalid')
    if (node.acceptanceGroup !== null
        && typeof node.acceptanceGroup !== 'string') {
        fail('semantic-graph-node-acceptance-group-invalid')
    }
    requireString(
        node.lifecycleState,
        'semantic-graph-node-lifecycle-state-invalid'
    )
    for (const [field, code] of [
        ['selectorReceiptDigest', 'semantic-graph-node-selector-invalid'],
        ['remoteSnapshotDigest', 'semantic-graph-node-remote-invalid'],
        ['repositoryBindingDigest', 'semantic-graph-node-repository-binding-invalid'],
        ['semanticFactsDigest', 'semantic-graph-node-facts-invalid']
    ]) requireSha(node[field], code)
    requireObject(node.receipts, 'semantic-graph-node-receipts-invalid')
    return {
        id,
        memberId,
        repository: node.repository,
        issueNumber: node.issueNumber,
        owner: node.owner,
        dependencyKeys: uniqueSorted(node.dependencyKeys),
        conflictKeys: uniqueSorted(node.conflictKeys),
        riskClass: node.riskClass,
        uiClass: node.uiClass,
        acceptanceGroup: node.acceptanceGroup ?? null,
        lifecycleState: node.lifecycleState,
        selectorReceiptDigest: node.selectorReceiptDigest,
        remoteSnapshotDigest: node.remoteSnapshotDigest,
        repositoryBindingDigest: node.repositoryBindingDigest,
        semanticFactsDigest: node.semanticFactsDigest,
        contractDigest: node.contractDigest ?? null,
        receipts: orderedCanonical(node.receipts)
    }
}

function semanticGraphUnsigned({
    selectorReceiptDigest,
    remoteSnapshotDigest,
    scopeDigest,
    semanticGraphInputDigest,
    policyDigest,
    repositories,
    nodes
}) {
    return {
        schema: SEMANTIC_GRAPH_SCHEMA,
        selectorReceiptDigest,
        remoteSnapshotDigest,
        scopeDigest,
        semanticGraphInputDigest,
        policyDigest,
        repositories: repositories.map(normalizeRepository).sort(
            (left, right) => left.repository.localeCompare(right.repository)
        ),
        nodes: nodes.map(normalizeNode).sort((left, right) =>
            left.id.localeCompare(right.id)
        )
    }
}

export function validateSemanticGraph(graph) {
    requireObject(graph, 'semantic-graph-invalid')
    if (graph.schema !== SEMANTIC_GRAPH_SCHEMA) {
        fail(
            'semantic-graph-canonical-migration-required',
            'Only issue-orchestration.semantic-graph.v2 is writable.'
        )
    }
    for (const field of [
        'active', 'availableSlots', 'blocked', 'candidateCommits',
        'cleanup', 'completed', 'deliveryCommits', 'epochId', 'leases',
        'readyFrontier', 'runtimeProjectionDigest', 'testContractDigest',
        'stageReceipts'
    ]) {
        if (Object.hasOwn(graph, field)) {
            fail('semantic-graph-runtime-field-forbidden')
        }
    }
    for (const [field, code] of [
        ['selectorReceiptDigest', 'semantic-graph-selector-invalid'],
        ['remoteSnapshotDigest', 'semantic-graph-remote-invalid'],
        ['scopeDigest', 'semantic-graph-scope-digest-invalid'],
        ['semanticGraphInputDigest', 'semantic-graph-input-digest-invalid'],
        ['policyDigest', 'semantic-graph-policy-digest-invalid'],
        ['semanticGraphDigest', 'semantic-graph-digest-invalid']
    ]) requireSha(graph[field], code)
    if (!Array.isArray(graph.repositories) || graph.repositories.length === 0) {
        fail('semantic-graph-repositories-invalid')
    }
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
        fail('semantic-graph-nodes-invalid')
    }
    const unsigned = semanticGraphUnsigned(graph)
    const ids = unsigned.nodes.map(({ id }) => id)
    if (new Set(ids).size !== ids.length) fail('semantic-graph-node-duplicate')
    const repositoryNames = new Set(
        unsigned.repositories.map(({ repository }) => repository)
    )
    for (const node of unsigned.nodes) {
        if (!repositoryNames.has(node.repository)) {
            fail('semantic-graph-node-repository-unbound')
        }
        const repository = unsigned.repositories.find(
            (entry) => entry.repository === node.repository
        )
        if (node.repositoryBindingDigest !== repository.bindingDigest) {
            fail('semantic-graph-node-repository-binding-stale')
        }
        if (node.selectorReceiptDigest !== graph.selectorReceiptDigest) {
            fail('semantic-graph-node-selector-stale')
        }
        if (node.remoteSnapshotDigest !== graph.remoteSnapshotDigest) {
            fail('semantic-graph-node-remote-stale')
        }
    }
    if (digest(unsigned) !== graph.semanticGraphDigest) {
        fail('semantic-graph-digest-mismatch')
    }
    const comparable = clone(graph)
    delete comparable.semanticGraphDigest
    if (!sameOrderedValue(unsigned, comparable)) {
        fail('semantic-graph-not-canonical')
    }
    return graph
}

export function createSemanticGraph({
    selectorReceiptDigest,
    remoteSnapshotDigest,
    scopeDigest,
    semanticGraphInputDigest,
    policyDigest,
    repositories,
    nodes
}) {
    for (const [value, code] of [
        [selectorReceiptDigest, 'semantic-graph-selector-invalid'],
        [remoteSnapshotDigest, 'semantic-graph-remote-invalid'],
        [scopeDigest, 'semantic-graph-scope-digest-invalid'],
        [semanticGraphInputDigest, 'semantic-graph-input-digest-invalid'],
        [policyDigest, 'semantic-graph-policy-digest-invalid']
    ]) requireSha(value, code)
    if (!Array.isArray(repositories) || repositories.length === 0) {
        fail('semantic-graph-repositories-invalid')
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
        fail('semantic-graph-nodes-invalid')
    }
    const graph = semanticGraphUnsigned({
        selectorReceiptDigest,
        remoteSnapshotDigest,
        scopeDigest,
        semanticGraphInputDigest,
        policyDigest,
        repositories,
        nodes
    })
    graph.semanticGraphDigest = digest(graph)
    validateSemanticGraph(graph)
    return graph
}

function semanticSnapshotFacts(snapshot) {
    return (snapshot?.issues ?? []).map((issue) => ({
        issueId: issue.issueId,
        semanticFacts: {
            dependencies: uniqueSorted(issue.semanticFacts?.dependencies),
            owner: issue.semanticFacts?.owner ?? null,
            conflictKeys: uniqueSorted(issue.semanticFacts?.conflictKeys),
            contractDigest: issue.semanticFacts?.contractDigest ?? null,
            acceptanceGroup: issue.semanticFacts?.acceptanceGroup ?? null
        }
    })).sort((left, right) => left.issueId.localeCompare(right.issueId))
}

function scopeSnapshotFacts(selector, snapshot) {
    return {
        selector: {
            schema: selector?.schema,
            selectorVersion: selector?.selectorVersion,
            type: selector?.type,
            repositories: uniqueSorted(selector?.repositories),
            statePolicy: selector?.statePolicy ?? null,
            parameters: selector?.parameters ?? null,
            selectorRelevantLabels:
                uniqueSorted(selector?.selectorRelevantLabels),
            remoteQueryIdentity: selector?.remoteQueryIdentity
        },
        issues: (snapshot?.issues ?? []).map((issue) => ({
            issueId: issue.issueId,
            repository: issue.repository,
            number: issue.number,
            state: issue.state,
            stateReason: issue.stateReason ?? null,
            labels: uniqueSorted(issue.labels),
            milestone: issue.milestone ?? null,
            confirmedDefectAdmission: issue.confirmedDefectAdmission ?? null,
            comments: (issue.comments ?? []).map((comment) => ({
                id: comment.id,
                kind: comment.kind ?? null,
                bodyDigest: comment.bodyDigest ?? null
            }))
        })).sort((left, right) => left.issueId.localeCompare(right.issueId))
    }
}

export function computeDigestLayers({
    selector,
    snapshot,
    semanticGraph,
    runtimeProjection
}) {
    requireObject(selector, 'digest-layer-selector-invalid')
    requireObject(snapshot, 'digest-layer-snapshot-invalid')
    requireObject(semanticGraph, 'digest-layer-semantic-graph-invalid')
    requireObject(runtimeProjection, 'digest-layer-runtime-projection-invalid')

    const declaredDigests = [
        semanticGraph.scopeDigest,
        semanticGraph.semanticGraphInputDigest,
        runtimeProjection.runtimeProjectionDigest
    ]
    if (declaredDigests.every((value) => typeof value === 'string')
        && new Set(declaredDigests).size !== declaredDigests.length) {
        fail('digest-layer-alias-forbidden')
    }

    const layers = {
        scopeDigest: digest(scopeSnapshotFacts(selector, snapshot)),
        semanticGraphInputDigest: digest(semanticSnapshotFacts(snapshot)),
        runtimeProjectionDigest: runtimeProjection.runtimeProjectionDigest
    }
    for (const value of Object.values(layers)) {
        requireSha(value, 'digest-layer-value-invalid')
    }
    if (new Set(Object.values(layers)).size !== 3) {
        fail('digest-layer-alias-forbidden')
    }
    return layers
}

function ledgerCompleted(ledger) {
    const completed = new Set()
    for (const event of ledger?.events ?? []) {
        if (event.eventType === 'delivery.completed'
            || event.eventType === 'issue.closed'
            || event.eventType === 'group.member.delivery-completed') {
            const id = event.issueId ?? event.nodeId
            if (id) completed.add(id)
        }
        if (event.eventType === 'issue.reopened') {
            const id = event.issueId ?? event.nodeId
            if (id) completed.delete(id)
        }
    }
    return completed
}

function longestPathFrom(nodeId, nodesById, completed, visiting = new Set()) {
    if (visiting.has(nodeId)) return [nodeId]
    const node = nodesById.get(nodeId)
    if (!node) return []
    const nextVisiting = new Set(visiting).add(nodeId)
    const dependants = [...nodesById.values()]
        .filter((candidate) =>
            !completed.has(candidate.id)
            && candidate.dependencyKeys.includes(nodeId)
        )
        .sort((left, right) => left.id.localeCompare(right.id))
    let tail = []
    for (const dependant of dependants) {
        const candidate = longestPathFrom(
            dependant.id,
            nodesById,
            completed,
            nextVisiting
        )
        if (candidate.length > tail.length
            || (candidate.length === tail.length
                && JSON.stringify(candidate) < JSON.stringify(tail))) {
            tail = candidate
        }
    }
    return [nodeId, ...tail]
}

function criticalPath(nodes, completed) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]))
    const candidates = nodes.filter(({ id }) => !completed.has(id))
    let longest = []
    for (const node of candidates) {
        const candidate = longestPathFrom(node.id, nodesById, completed)
        if (candidate.length > longest.length
            || (candidate.length === longest.length
                && JSON.stringify(candidate) < JSON.stringify(longest))) {
            longest = candidate
        }
    }
    return longest
}

function downstreamBlockedCounts(nodes, completed) {
    const dependants = new Map(nodes.map(({ id }) => [id, []]))
    for (const node of nodes) {
        for (const dependency of node.dependencyKeys) {
            if (dependants.has(dependency)) {
                dependants.get(dependency).push(node.id)
            }
        }
    }
    const count = (root) => {
        const visited = new Set()
        const pending = [...(dependants.get(root) ?? [])]
        while (pending.length > 0) {
            const id = pending.pop()
            if (visited.has(id) || completed.has(id)) continue
            visited.add(id)
            pending.push(...(dependants.get(id) ?? []))
        }
        return visited.size
    }
    return Object.fromEntries(nodes.map(({ id }) => [id, count(id)]))
}

function conflictProjection(nodes, active, leased) {
    const membersByKey = {}
    const occupiedByKey = {}
    const occupied = new Set([...active, ...leased])
    for (const node of nodes) {
        for (const key of node.conflictKeys) {
            membersByKey[key] ??= []
            membersByKey[key].push(node.id)
            if (occupied.has(node.id)) {
                occupiedByKey[key] ??= []
                occupiedByKey[key].push(node.id)
            }
        }
    }
    for (const values of Object.values(membersByKey)) values.sort()
    for (const values of Object.values(occupiedByKey)) values.sort()
    return {
        membersByKey,
        occupiedByKey
    }
}

function hasOccupiedConflict(node, conflictState, occupiedIds) {
    return node.conflictKeys.some((key) =>
        (conflictState.occupiedByKey[key] ?? [])
            .some((id) => id !== node.id && occupiedIds.has(id))
    )
}

const WRITER_START_PHASES = Object.freeze({
    'test-contract.started': new Set(['test-contract']),
    'documentation.started': new Set(['documentation']),
    'implementation.started': new Set([
        'implementation',
        'ui-implementation',
        'landing-conflict-resolution'
    ])
})
const WRITER_PHASE_ROLES = Object.freeze({
    'test-contract': new Set(['test-owner']),
    implementation: new Set(['code-implementer']),
    'ui-implementation': new Set(['ui-ux-implementer']),
    documentation: new Set(['documentation-writer']),
    'landing-conflict-resolution': new Set([
        'code-implementer',
        'ui-ux-implementer'
    ])
})
const WRITER_SOURCE_PREDECESSORS = Object.freeze({
    'test-contract': Object.freeze({
        'node.discovered': 'dag-creator-updater'
    }),
    implementation: Object.freeze({
        'test-contract.frozen': 'test-owner'
    }),
    'ui-implementation': Object.freeze({
        'test-contract.frozen': 'test-owner'
    }),
    documentation: Object.freeze({
        'ux-acceptance.accepted': 'ux-acceptance-verifier',
        'independent-verification.passed': 'test-owner'
    }),
    'landing-conflict-resolution': Object.freeze({
        'delivery.failed': 'root-scheduler'
    })
})
const WRITER_FAILURE_EVENTS = new Set([
    'writer-stage.invocation-failed',
    'writer-stage.environment-failed',
    'writer-stage.runtime-capability-missing',
    'writer-stage.first-action-not-executed',
    'writer-stage.output-missing',
    'writer-stage.checkpoint-missing',
    'writer-stage.receipt-rejected'
])
const WRITER_STAGE_PROJECTION_FIELDS = Object.freeze([
    'baseSha',
    'breakerOpen',
    'acceptedPriorChangedPathsDigest',
    'checkpointDigest',
    'checkpointOrdinal',
    'checkpointVerificationReceiptDigest',
    'compiledPromptDigest',
    'completedSlicePrefix',
    'completedSlicePrefixDigest',
    'completedSliceReceiptDigests',
    'continuationReceiptDigest',
    'epochId',
    'expectedNextSliceDigest',
    'expectedNextSliceId',
    'failureReceiptDigest',
    'issue',
    'machineTracePrefixByteLength',
    'machineTracePrefixDigest',
    'machineTraceSnapshotDigest',
    'node',
    'operationsDigest',
    'planDigest',
    'previousCheckpointDigest',
    'previousCheckpointVerificationReceiptDigest',
    'previousMachineTracePrefixByteLength',
    'previousMachineTracePrefixDigest',
    'repository',
    'retryAuthorizationDigest',
    'runId',
    'runtimeProgressObservationDigest',
    'semanticFailureDigest',
    'sliceDigest',
    'sliceId',
    'stageAttemptId',
    'stagePhase',
    'stageRole',
    'status',
    'terminalChainDigest',
    'terminalReceiptDigest',
    'worktreeIdentity'
])
const WRITER_STAGE_STATUSES = new Set([
    'active',
    'checkpointed',
    'continuing',
    'terminal-failure',
    'retry-authorized',
    'next-slice',
    'completed'
])
const CHECKPOINT_DIGEST_PROJECTION_FIELDS = Object.freeze([
    'acceptedPriorChangedPathsDigest',
    'checkpointVerificationReceiptDigest',
    'completedSlicePrefixDigest',
    'machineTracePrefixDigest',
    'machineTraceSnapshotDigest',
    'operationsDigest',
    'previousCheckpointDigest',
    'previousCheckpointVerificationReceiptDigest',
    'previousMachineTracePrefixDigest',
    'runtimeProgressObservationDigest'
])
const CHECKPOINT_NUMBER_PROJECTION_FIELDS = Object.freeze([
    'checkpointOrdinal',
    'machineTracePrefixByteLength',
    'previousMachineTracePrefixByteLength'
])
const COMPLETED_SLICE_PROJECTION_FIELDS = Object.freeze([
    ...CHECKPOINT_DIGEST_PROJECTION_FIELDS,
    ...CHECKPOINT_NUMBER_PROJECTION_FIELDS,
    'checkpointDigest',
    'changedPaths',
    'planDigest',
    'planSliceCount',
    'priorTerminalReceiptDigests',
    'sliceDigest',
    'sliceId',
    'sliceOrdinal',
    'stageAttemptId',
    'stagePhase',
    'stageRole',
    'terminalChainDigest',
    'terminalReceiptDigest'
])

function activeWriterLedgerRequested(ledger) {
    return Array.isArray(ledger?.events) &&
        ledger.events.some((event) =>
            typeof event?.eventType === 'string' &&
            (event.eventType.startsWith('writer-stage.') ||
                Object.hasOwn(event.payload ?? {}, 'stageWorkPlan')))
}

function replayCanonicalWriterLedger(ledger) {
    if (!activeWriterLedgerRequested(ledger)) return null
    if (ledger?.header?.schema !== 'issue-orchestration.ledger.v2' ||
        ledger.header.transitionSchema !==
            'issue-orchestration.transition.v2') {
        fail('runtime-projector-active-writer-ledger-v2-required')
    }
    try {
        return replayEventLedgerSync(ledger)
    } catch (error) {
        fail(
            'runtime-projector-active-writer-ledger-replay-invalid',
            'runtime-projector-active-writer-ledger-replay-invalid',
            {
                ledgerErrorCode: error?.code ?? null
            }
        )
    }
}

function writerStartArtifacts(event) {
    const allowedPhases = WRITER_START_PHASES[event.eventType]
    if (!allowedPhases) return null
    const payload = event.payload ?? {}
    if (!Object.hasOwn(payload, 'stageWorkPlan')) return null
    const plan = payload.stageWorkPlan
    const slice = payload.currentSlice
    const compiledPrompt = payload.compiledPrompt
    const dispatchReceipt = payload.dispatchReceipt
    let expectedSlice
    let expectedPrompt
    try {
        expectedSlice = compileExecutableSlice({
            plan,
            sliceId: slice?.sliceId
        })
        expectedPrompt = compileDispatchPrompt({
            plan,
            slice: expectedSlice
        })
    } catch {
        fail('runtime-projector-writer-start-binding-invalid')
    }
    if (!allowedPhases.has(plan.stagePhase) ||
        !WRITER_PHASE_ROLES[plan.stagePhase]?.has(plan.stageRole) ||
        plan.node !== event.nodeId ||
        !sameOrderedValue(slice, expectedSlice) ||
        !sameOrderedValue(payload.executableSlice, expectedSlice) ||
        !sameOrderedValue(compiledPrompt, expectedPrompt) ||
        plan.stageAttemptId !== event.attemptId ||
        dispatchReceipt?.schema !==
            'issue-orchestration.dispatch-receipt.v2' ||
        dispatchReceipt.verificationStatus !== 'verified' ||
        !sealedDigestValid(dispatchReceipt, 'receiptDigest') ||
        dispatchReceipt.attemptId !== event.attemptId ||
        dispatchReceipt.stageRole !== plan.stageRole ||
        dispatchReceipt.stagePhase !== plan.stagePhase ||
        dispatchReceipt?.planDigest !== plan.planDigest ||
        dispatchReceipt?.sliceId !== expectedSlice.sliceId ||
        dispatchReceipt?.sliceDigest !== expectedSlice.sliceDigest ||
        dispatchReceipt?.compiledPromptDigest !==
            expectedPrompt.promptDigest) {
        fail('runtime-projector-writer-start-binding-invalid')
    }
    for (const field of ['stagePhase', 'stageRole']) {
        if (Object.hasOwn(dispatchReceipt, field) &&
            dispatchReceipt[field] !== plan[field]) {
            fail('runtime-projector-writer-start-binding-invalid')
        }
    }
    return {
        plan,
        slice: expectedSlice,
        compiledPrompt: expectedPrompt
    }
}

function sealedWriterAuthority(ledger, eventIndex, plan) {
    const allowedPredecessors =
        WRITER_SOURCE_PREDECESSORS[plan.stagePhase] ?? {}
    for (let length = 1; length <= eventIndex; length += 1) {
        const sourceEvents = ledger.events.slice(0, length)
        const sourceEvent = sourceEvents.findLast((candidate) =>
            allowedPredecessors[candidate.eventType] ===
                candidate.actorRole)
        if (!sourceEvent) continue
        const sourceLedgerDigest = orderedDigest({
            header: ledger.header,
            events: sourceEvents
        })
        if (sourceLedgerDigest === plan.sourceLedgerDigest &&
            sourceEvent.eventDigest === plan.sourceEventDigest) {
            return {
                expectedSourceEventDigest: sourceEvent.eventDigest,
                expectedSourceLedgerDigest: sourceLedgerDigest
            }
        }
    }
    fail('runtime-projector-writer-start-binding-invalid')
}

function writerStageMatchesPlan(stage, plan) {
    return stage.runId === plan?.runId &&
        stage.repository === plan.repository &&
        stage.issue === plan.issue &&
        stage.node === plan.node &&
        stage.baseSha === plan.baseSha &&
        stage.epochId === plan.epochId &&
        stage.worktreeIdentity === plan.worktreeIdentity &&
        stage.stageAttemptId === plan.stageAttemptId &&
        stage.stageRole === plan.stageRole &&
        stage.stagePhase === plan.stagePhase &&
        stage.planDigest === plan.planDigest
}

function activeWriterArtifacts(stage, payload, code) {
    const plan = payload.stageWorkPlan
    const slice = payload.currentSlice
    let expectedSlice
    let expectedPrompt
    try {
        expectedSlice = compileExecutableSlice({
            plan,
            sliceId: slice?.sliceId
        })
        expectedPrompt = compileDispatchPrompt({
            plan,
            slice: expectedSlice
        })
    } catch {
        fail(code)
    }
    if (!writerStageMatchesPlan(stage, plan) ||
        !sameOrderedValue(slice, expectedSlice) ||
        !sameOrderedValue(payload.compiledPrompt, expectedPrompt) ||
        stage.sliceId !== expectedSlice.sliceId ||
        stage.sliceDigest !== expectedSlice.sliceDigest ||
        stage.compiledPromptDigest !== expectedPrompt.promptDigest) {
        fail(code)
    }
    return {
        compiledPrompt: expectedPrompt,
        plan,
        slice: expectedSlice
    }
}

function sealedDigestValid(value, field) {
    if (!value || !SHA256.test(value[field] ?? '')) return false
    const unsigned = clone(value)
    delete unsigned[field]
    return orderedDigest(unsigned) === value[field]
}

function nextCheckpointLineage(stage) {
    const prior = stage._lastCheckpointLineage
    return {
        checkpointOrdinal: prior
            ? prior.checkpointOrdinal + 1
            : 1,
        previousCheckpointDigest:
            prior?.checkpointDigest ?? null,
        previousCheckpointVerificationReceiptDigest:
            prior?.checkpointVerificationReceiptDigest ?? null,
        previousMachineTracePrefixDigest:
            prior?.machineTracePrefixDigest ?? null,
        previousMachineTracePrefixByteLength:
            prior?.machineTracePrefixByteLength ?? null,
        previousMachineTraceSnapshot:
            prior?.machineTraceSnapshot ?? null
    }
}

function checkpointProjection(receipt) {
    return {
        acceptedPriorChangedPathsDigest:
            receipt.acceptedPriorChangedPathsDigest,
        checkpointOrdinal: receipt.checkpointOrdinal,
        checkpointVerificationReceiptDigest: receipt.receiptDigest,
        completedSlicePrefixDigest:
            receipt.completedSlicePrefixDigest,
        machineTracePrefixByteLength:
            receipt.machineTracePrefixByteLength,
        machineTracePrefixDigest:
            receipt.machineTracePrefixDigest,
        machineTraceSnapshotDigest:
            receipt.machineTraceSnapshotDigest,
        operationsDigest: receipt.operationsDigest,
        previousCheckpointDigest:
            receipt.previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest:
            receipt.previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixByteLength:
            receipt.previousMachineTracePrefixByteLength,
        previousMachineTracePrefixDigest:
            receipt.previousMachineTracePrefixDigest,
        runtimeProgressObservationDigest:
            receipt.runtimeProgressObservationDigest
    }
}

function checkpointProjectionValid(projection) {
    if (!Number.isInteger(projection.checkpointOrdinal) ||
        projection.checkpointOrdinal < 1 ||
        !Number.isInteger(projection.machineTracePrefixByteLength) ||
        projection.machineTracePrefixByteLength <= 0) {
        return false
    }
    const requiredDigests = CHECKPOINT_DIGEST_PROJECTION_FIELDS.filter(
        (field) => !field.startsWith('previous')
    )
    if (requiredDigests.some((field) =>
        !SHA256.test(projection[field] ?? ''))) {
        return false
    }
    if (projection.checkpointOrdinal === 1) {
        return projection.previousCheckpointDigest === null &&
            projection.previousCheckpointVerificationReceiptDigest ===
                null &&
            projection.previousMachineTracePrefixDigest === null &&
            projection.previousMachineTracePrefixByteLength === null
    }
    return SHA256.test(projection.previousCheckpointDigest ?? '') &&
        SHA256.test(
            projection.previousCheckpointVerificationReceiptDigest ?? ''
        ) &&
        SHA256.test(
            projection.previousMachineTracePrefixDigest ?? ''
        ) &&
        Number.isInteger(
            projection.previousMachineTracePrefixByteLength
        ) &&
        projection.previousMachineTracePrefixByteLength > 0
}

function clearActiveCheckpointProjection(
    stage,
    { resetLineage = false } = {}
) {
    stage.checkpointDigest = null
    for (const field of CHECKPOINT_DIGEST_PROJECTION_FIELDS) {
        stage[field] = null
    }
    for (const field of CHECKPOINT_NUMBER_PROJECTION_FIELDS) {
        stage[field] = null
    }
    stage._activeCheckpointLineage = null
    if (resetLineage) stage._lastCheckpointLineage = null
}

function projectedCheckpointValid(
    stage,
    plan,
    slice,
    checkpoint,
    verificationReceipt,
    checkpointLineage
) {
    let sealedEvidenceErrors
    try {
        const compiledPrompt = compileDispatchPrompt({ plan, slice })
        const sliceOrdinal = plan.orderedSlices.findIndex(
            ({ sliceId }) => sliceId === slice.sliceId
        )
        if (sliceOrdinal < 0) return false
        const acceptedPrefix =
            stage._canonicalCompletedSlicePrefix.slice(0, sliceOrdinal)
        const acceptedPriorChangedPaths = [
            ...new Set(acceptedPrefix.flatMap(
                ({ changedPaths = [] }) => changedPaths
            ))
        ].sort()
        sealedEvidenceErrors =
            validateSealedWriterStageCheckpointEvidence({
                plan,
                slice,
                checkpoint,
                compiledPrompt,
                compiledPromptDigest: compiledPrompt.promptDigest,
                routeDigest: plan.routingInputDigest,
                sealedAuthority: stage._sealedAuthority,
                acceptedPriorChangedPaths,
                completedSlicePrefixDigest: orderedDigest(acceptedPrefix),
                ...checkpointLineage,
                verificationReceipt
            })
    } catch {
        return false
    }
    if (checkpoint?.schema !==
        'issue-orchestration.stage-progress-checkpoint.v1' ||
        !Array.isArray(sealedEvidenceErrors) ||
        sealedEvidenceErrors.length > 0 ||
        !['partial', 'complete'].includes(checkpoint.status) ||
        checkpoint.runId !== plan.runId ||
        checkpoint.node !== plan.node ||
        checkpoint.baseSha !== plan.baseSha ||
        checkpoint.epochId !== plan.epochId ||
        checkpoint.worktreeIdentity !== plan.worktreeIdentity ||
        checkpoint.sliceId !== slice.sliceId ||
        checkpoint.sliceDigest !== slice.sliceDigest ||
        checkpoint.verificationStatus !== 'verified' ||
        !sealedDigestValid(checkpoint, 'checkpointDigest') ||
        !sealedDigestValid(checkpoint.evidence, 'evidenceDigest') ||
        checkpoint.evidenceDigest !== checkpoint.evidence.evidenceDigest ||
        !Array.isArray(checkpoint.evidence.typedEvidenceReceipts) ||
        checkpoint.evidence.typedEvidenceReceipts.length === 0 ||
        checkpoint.evidence.typedEvidenceReceipts.some((receipt) =>
            receipt?.schema !==
                'issue-orchestration.writer-stage-evidence-receipt.v1' ||
            !sealedDigestValid(receipt, 'receiptDigest')) ||
        checkpoint.evidence.machineRuntimeTrace?.schema !==
            'issue-orchestration.machine-writer-runtime-trace-handle.v1' ||
        checkpoint.evidence.machineRuntimeTrace.verificationStatus !==
            'verified' ||
        !sealedDigestValid(
            checkpoint.evidence.machineRuntimeTrace,
            'receiptDigest'
        ) ||
        checkpoint.evidence.runtimeProgressObservation?.schema !==
            'issue-orchestration.writer-stage-runtime-progress-observation.v1' ||
        !sealedDigestValid(
            checkpoint.evidence.runtimeProgressObservation,
            'observationDigest'
        ) ||
        !checkpoint.cursor ||
        !Number.isInteger(checkpoint.cursor.completedActionCount) ||
        !Number.isInteger(checkpoint.cursor.nextActionIndex) ||
        typeof checkpoint.cursor.lastCompletedAction !== 'string') {
        return false
    }
    if (checkpoint.status === 'partial') {
        return typeof checkpoint.nextRequiredAction === 'string' &&
            checkpoint.nextRequiredAction.length > 0 &&
            checkpoint.candidateState !== 'candidate-green'
    }
    return checkpoint.nextRequiredAction === null
}

function projectWriterCheckpoint(stage, payload) {
    const { plan, slice } = activeWriterArtifacts(
        stage,
        payload,
        'runtime-projector-writer-checkpoint-binding-invalid'
    )
    const checkpointLineage = nextCheckpointLineage(stage)
    if (!projectedCheckpointValid(
        stage,
        plan,
        slice,
        payload.checkpoint,
        payload.checkpointVerificationReceipt,
        checkpointLineage
    )) {
        fail('runtime-projector-writer-checkpoint-binding-invalid')
    }
    const receipt = payload.checkpointVerificationReceipt
    const safeProjection = checkpointProjection(receipt)
    if (!checkpointProjectionValid(safeProjection)) {
        fail('runtime-projector-writer-checkpoint-binding-invalid')
    }
    Object.assign(stage, safeProjection)
    stage.checkpointDigest = payload.checkpoint.checkpointDigest
    const lineage = {
        ...safeProjection,
        checkpointDigest: payload.checkpoint.checkpointDigest,
        machineTraceSnapshot:
            payload.checkpoint.evidence.machineRuntimeTrace.traceSnapshot,
        validationOptions: checkpointLineage
    }
    stage._activeCheckpointLineage = lineage
    stage._lastCheckpointLineage = lineage
    stage.status = 'checkpointed'
}

function projectWriterContinuation(stage, payload) {
    const { plan, slice } = activeWriterArtifacts(
        stage,
        payload,
        'runtime-projector-writer-continuation-binding-invalid'
    )
    const checkpoint = payload.checkpoint
    if (!projectedCheckpointValid(
        stage,
        plan,
        slice,
        checkpoint,
        payload.checkpointVerificationReceipt,
        stage._activeCheckpointLineage?.validationOptions
    ) ||
        checkpoint.status !== 'partial' ||
        payload.checkpointVerificationReceipt?.receiptDigest !==
            stage.checkpointVerificationReceiptDigest) {
        fail('runtime-projector-writer-continuation-binding-invalid')
    }
    const sliceOrdinal = plan.orderedSlices.findIndex(
        ({ sliceId }) => sliceId === slice.sliceId
    )
    const acceptedPrefix =
        stage._canonicalCompletedSlicePrefix.slice(0, sliceOrdinal)
    const acceptedPriorChangedPaths = [
        ...new Set(acceptedPrefix.flatMap(
            ({ changedPaths = [] }) => changedPaths
        ))
    ].sort()
    let expected
    try {
        expected = compileContinuation({
            plan,
            slice,
            checkpoint,
            checkpointVerificationReceiptDigest:
                stage.checkpointVerificationReceiptDigest,
            checkpointOrdinal: stage.checkpointOrdinal,
            previousCheckpointDigest:
                stage.previousCheckpointDigest,
            previousCheckpointVerificationReceiptDigest:
                stage.previousCheckpointVerificationReceiptDigest,
            previousMachineTracePrefixDigest:
                stage.previousMachineTracePrefixDigest,
            previousMachineTracePrefixByteLength:
                stage.previousMachineTracePrefixByteLength,
            machineTracePrefixDigest:
                stage.machineTracePrefixDigest,
            machineTracePrefixByteLength:
                stage.machineTracePrefixByteLength,
            completedSlicePrefixDigest:
                stage.completedSlicePrefixDigest,
            acceptedPriorChangedPathsDigest:
                stage.acceptedPriorChangedPathsDigest,
            acceptedPriorChangedPaths
        })
    } catch {
        fail('runtime-projector-writer-continuation-binding-invalid')
    }
    if (payload.checkpoint?.checkpointDigest !== stage.checkpointDigest ||
        !sameOrderedValue(payload.continuationReceipt, expected)) {
        fail('runtime-projector-writer-continuation-binding-invalid')
    }
    stage.continuationReceiptDigest = expected.receiptDigest
    stage.status = 'continuing'
}

function projectWriterFailure(stage, event) {
    const payload = event.payload ?? {}
    const observation = payload.writerStageObservation
    const failureReceipt = payload.failureReceipt ?? payload.receipt
    if (observation?.runId !== stage.runId ||
        observation.repository !== stage.repository ||
        observation.issue !== stage.issue ||
        observation.node !== stage.node ||
        observation.baseSha !== stage.baseSha ||
        observation.epochId !== stage.epochId ||
        observation.worktreeIdentity !== stage.worktreeIdentity ||
        observation.stageRole !== stage.stageRole ||
        observation.stagePhase !== stage.stagePhase ||
        observation.planDigest !== stage.planDigest ||
        observation.sliceId !== stage.sliceId ||
        observation.sliceDigest !== stage.sliceDigest ||
        observation.compiledPromptDigest !== stage.compiledPromptDigest ||
        observation.attemptId !== stage.stageAttemptId ||
        failureReceipt?.schema !==
            'issue-orchestration.writer-stage-failure-receipt.v1' ||
        failureReceipt.status !== 'terminal' ||
        failureReceipt.eventType !== event.eventType ||
        failureReceipt.runId !== stage.runId ||
        failureReceipt.repository !== stage.repository ||
        failureReceipt.issue !== stage.issue ||
        failureReceipt.node !== stage.node ||
        failureReceipt.baseSha !== stage.baseSha ||
        failureReceipt.epochId !== stage.epochId ||
        failureReceipt.worktreeIdentity !== stage.worktreeIdentity ||
        failureReceipt.planDigest !== stage.planDigest ||
        failureReceipt.sliceId !== stage.sliceId ||
        failureReceipt.sliceDigest !== stage.sliceDigest ||
        failureReceipt.compiledPromptDigest !==
            stage.compiledPromptDigest ||
        failureReceipt.stageRole !== stage.stageRole ||
        failureReceipt.stagePhase !== stage.stagePhase ||
        failureReceipt.attemptId !== stage.stageAttemptId ||
        failureReceipt.breakerOpen !== true ||
        !SHA256.test(failureReceipt.semanticFailureDigest ?? '') ||
        !sealedDigestValid(failureReceipt, 'receiptDigest')) {
        fail('runtime-projector-writer-failure-binding-invalid')
    }
    stage.failureReceiptDigest = failureReceipt.receiptDigest
    stage.semanticFailureDigest = failureReceipt.semanticFailureDigest
    stage.breakerOpen = true
    stage.status = 'terminal-failure'
}

function projectWriterRetry(stage, payload) {
    const expected = payload.retryAuthorization
    if (payload.priorFailureReceipt?.receiptDigest !==
            stage.failureReceiptDigest ||
        payload.priorFailureReceipt?.semanticFailureDigest !==
            stage.semanticFailureDigest ||
        expected?.schema !==
            'issue-orchestration.writer-stage-retry-authorization.v1' ||
        expected.verificationStatus !== 'verified' ||
        expected.authorized !== true ||
        expected.breakerOpen !== false ||
        expected.priorFailureReceiptDigest !==
            stage.failureReceiptDigest ||
        expected.semanticFailureDigest !== stage.semanticFailureDigest ||
        expected.sourceFailureEventId !==
            payload.sourceFailureEvent?.eventId ||
        expected.sourceFailureEventDigest !==
            payload.sourceFailureEvent?.eventDigest ||
        expected.resourceCleanupReceiptDigest !==
            payload.resourceCleanupReceipt?.receiptDigest ||
        !sealedDigestValid(expected, 'receiptDigest')) {
        fail('runtime-projector-writer-retry-binding-invalid')
    }
    stage.retryAuthorizationDigest = expected.receiptDigest
    stage.expectedNextSliceId = expected.nextSliceId
    stage.expectedNextSliceDigest = expected.nextSliceDigest
    stage._expectedNextPlanDigest = expected.nextPlanDigest
    stage._expectedNextCompiledPromptDigest =
        expected.nextCompiledPromptDigest
    stage._carryForwardPrefix = expected.carryForwardPrefix ?? null
    stage.breakerOpen = false
    stage.status = 'retry-authorized'
}

function terminalChainDigestFor(receipt) {
    return orderedDigest({
        planDigest: receipt.planDigest,
        sliceId: receipt.sliceId,
        sliceDigest: receipt.sliceDigest,
        sliceOrdinal: receipt.sliceOrdinal,
        planSliceCount: receipt.planSliceCount,
        checkpointDigest: receipt.checkpointDigest,
        checkpointVerificationReceiptDigest:
            receipt.checkpointVerificationReceiptDigest,
        completedSlicePrefixDigest:
            receipt.completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest:
            receipt.acceptedPriorChangedPathsDigest,
        priorTerminalReceiptDigests:
            receipt.priorTerminalReceiptDigests
    })
}

function completedSliceProjectionEntry({
    event,
    plan,
    slice,
    checkpointProjection: safeCheckpoint,
    terminalReceipt
}) {
    return {
        acceptedPriorChangedPathsDigest:
            terminalReceipt.acceptedPriorChangedPathsDigest,
        checkpointDigest: terminalReceipt.checkpointDigest,
        checkpointOrdinal: safeCheckpoint.checkpointOrdinal,
        checkpointVerificationReceiptDigest:
            terminalReceipt.checkpointVerificationReceiptDigest,
        changedPaths: [...terminalReceipt.changedPaths].sort(),
        completedSlicePrefixDigest:
            terminalReceipt.completedSlicePrefixDigest,
        machineTracePrefixByteLength:
            safeCheckpoint.machineTracePrefixByteLength,
        machineTracePrefixDigest:
            safeCheckpoint.machineTracePrefixDigest,
        machineTraceSnapshotDigest:
            safeCheckpoint.machineTraceSnapshotDigest,
        operationsDigest: safeCheckpoint.operationsDigest,
        planDigest: plan.planDigest,
        planSliceCount: terminalReceipt.planSliceCount,
        previousCheckpointDigest:
            safeCheckpoint.previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest:
            safeCheckpoint.previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixByteLength:
            safeCheckpoint.previousMachineTracePrefixByteLength,
        previousMachineTracePrefixDigest:
            safeCheckpoint.previousMachineTracePrefixDigest,
        priorTerminalReceiptDigests: [
            ...terminalReceipt.priorTerminalReceiptDigests
        ],
        runtimeProgressObservationDigest:
            safeCheckpoint.runtimeProgressObservationDigest,
        sliceDigest: slice.sliceDigest,
        sliceId: slice.sliceId,
        sliceOrdinal: terminalReceipt.sliceOrdinal,
        stageAttemptId: event.attemptId,
        stagePhase: plan.stagePhase,
        stageRole: plan.stageRole,
        terminalChainDigest: terminalReceipt.terminalChainDigest,
        terminalReceiptDigest: terminalReceipt.receiptDigest
    }
}

function replayWriterTerminalGate({
    stage,
    plan,
    currentSlice,
    currentCheckpoint,
    compiledPrompt,
    checkpointVerificationReceipt,
    terminalReceipts,
    nextSlice
}) {
    const sliceOrdinal = plan.orderedSlices.findIndex(
        ({ sliceId }) => sliceId === currentSlice.sliceId
    )
    const acceptedPrefix =
        stage._canonicalCompletedSlicePrefix.slice(0, sliceOrdinal)
    const acceptedPriorChangedPaths = [
        ...new Set(acceptedPrefix.flatMap(
            ({ changedPaths = [] }) => changedPaths
        ))
    ].sort()
    if (!projectedCheckpointValid(
        stage,
        plan,
        currentSlice,
        currentCheckpoint,
        checkpointVerificationReceipt,
        stage._activeCheckpointLineage?.validationOptions
    ) || currentCheckpoint.status !== 'complete') {
        fail('runtime-projector-writer-terminal-binding-invalid')
    }
    try {
        return evaluateSliceTerminalGate({
            carryForwardPrefix: stage._carryForwardPrefix,
            plan,
            currentSlice,
            currentCheckpoint,
            compiledPrompt,
            checkpointVerificationReceipt,
            sealedAuthority: stage._sealedAuthority,
            acceptedPriorChangedPaths,
            completedSlicePrefixDigest:
                orderedDigest(acceptedPrefix),
            previousMachineTraceSnapshot:
                stage._activeCheckpointLineage
                    ?.validationOptions
                    ?.previousMachineTraceSnapshot ?? null,
            terminalReceipts,
            nextSlice
        })
    } catch (error) {
        let expectedSliceDigest = null
        let observedSliceDigest = null
        try {
            expectedSliceDigest = orderedDigest(
                compileExecutableSlice({
                    plan,
                    sliceId: currentSlice?.sliceId
                })
            )
            observedSliceDigest = orderedDigest(currentSlice)
        } catch {
            // Preserve the terminal gate's original fail-closed error.
        }
        fail(
            'runtime-projector-writer-terminal-binding-invalid',
            'runtime-projector-writer-terminal-binding-invalid',
            {
                terminalGateError:
                    typeof error?.message === 'string'
                        ? error.message
                        : null,
                expectedSliceDigest,
                observedSliceDigest
            }
        )
    }
}

function projectWriterTerminal(stage, event) {
    const payload = event.payload ?? {}
    const { compiledPrompt, plan, slice } = activeWriterArtifacts(
        stage,
        payload,
        'runtime-projector-writer-terminal-binding-invalid'
    )
    if (payload.currentCheckpoint?.checkpointDigest !==
            stage.checkpointDigest ||
        payload.checkpointVerificationReceipt?.receiptDigest !==
            stage.checkpointVerificationReceiptDigest) {
        fail('runtime-projector-writer-terminal-binding-invalid')
    }
    const gate = replayWriterTerminalGate({
        stage,
        plan,
        currentSlice: payload.currentSlice,
        currentCheckpoint: payload.currentCheckpoint,
        compiledPrompt,
        checkpointVerificationReceipt:
            payload.checkpointVerificationReceipt,
        terminalReceipts: payload.sliceTerminalReceipts,
        nextSlice: payload.nextSlice ?? null
    })
    const receiptDigests = payload.sliceTerminalReceipts
        .map(({ receiptDigest }) => receiptDigest)
    const completedPrefix = receiptDigests.slice(0, -1)
    const terminal = gate.terminalReceipt
    if (gate.eventType !== event.eventType ||
        !sameOrderedValue(payload.terminalReceipt, terminal) ||
        !sameOrderedValue(
            completedPrefix,
            stage.completedSliceReceiptDigests
        ) ||
        terminal.sliceOrdinal !== completedPrefix.length + 1 ||
        terminal.planSliceCount !== plan.orderedSlices.length ||
        !sameOrderedValue(
            terminal.priorTerminalReceiptDigests,
            completedPrefix
        ) ||
        terminal.checkpointVerificationReceiptDigest !==
            stage.checkpointVerificationReceiptDigest ||
        terminal.completedSlicePrefixDigest !==
            stage.completedSlicePrefixDigest ||
        terminal.acceptedPriorChangedPathsDigest !==
            stage.acceptedPriorChangedPathsDigest ||
        terminal.terminalChainDigest !==
            terminalChainDigestFor(terminal)) {
        fail('runtime-projector-writer-terminal-binding-invalid')
    }
    let nextPrompt = null
    if (event.eventType === 'writer-stage.slice-completed') {
        try {
            nextPrompt = compileDispatchPrompt({
                plan,
                slice: gate.nextSlice
            })
        } catch {
            fail('runtime-projector-writer-terminal-binding-invalid')
        }
        const nextDispatch = payload.nextDispatchReceipt
        if (!sameOrderedValue(payload.nextSlice, gate.nextSlice) ||
            !sameOrderedValue(payload.nextCompiledPrompt, nextPrompt) ||
            nextDispatch?.schema !==
                'issue-orchestration.dispatch-receipt.v2' ||
            nextDispatch.verificationStatus !== 'verified' ||
            !sealedDigestValid(nextDispatch, 'receiptDigest') ||
            nextDispatch.runId !== plan.runId ||
            nextDispatch.nodeId !== plan.node ||
            nextDispatch.attemptId !== event.attemptId ||
            nextDispatch.planDigest !== plan.planDigest ||
            nextDispatch.sliceId !== gate.nextSlice.sliceId ||
            nextDispatch.sliceDigest !== gate.nextSlice.sliceDigest ||
            nextDispatch.compiledPromptDigest !== nextPrompt.promptDigest ||
            nextDispatch.stageRole !== plan.stageRole ||
            nextDispatch.stagePhase !== plan.stagePhase ||
            gate.nextState !== 'next-slice' ||
            gate.stageComplete !== false) {
            fail('runtime-projector-writer-terminal-binding-invalid')
        }
    }
    if (event.eventType === 'writer-stage.completed' &&
        (gate.nextState !== 'candidate-green' ||
            gate.stageComplete !== true ||
            gate.nextSlice !== null)) {
        fail('runtime-projector-writer-terminal-binding-invalid')
    }
    const safeCheckpoint = checkpointProjection(
        payload.checkpointVerificationReceipt
    )
    stage.completedSlicePrefix.push(completedSliceProjectionEntry({
        event,
        plan,
        slice,
        checkpointProjection: safeCheckpoint,
        terminalReceipt: terminal
    }))
    stage.completedSliceReceiptDigests = receiptDigests
    stage.terminalChainDigest = terminal.terminalChainDigest
    stage.terminalReceiptDigest = terminal.receiptDigest
    stage.expectedNextSliceId = gate.nextSlice?.sliceId ?? null
    stage.expectedNextSliceDigest = gate.nextSlice?.sliceDigest ?? null
    stage._expectedNextPlanDigest = gate.nextSlice
        ? plan.planDigest
        : null
    stage._expectedNextCompiledPromptDigest = nextPrompt?.promptDigest ?? null
    if (gate.nextSlice) {
        stage.sliceId = gate.nextSlice.sliceId
        stage.sliceDigest = gate.nextSlice.sliceDigest
        stage.compiledPromptDigest = nextPrompt.promptDigest
        clearActiveCheckpointProjection(stage, { resetLineage: true })
        stage.continuationReceiptDigest = null
    }
    stage.breakerOpen = false
    stage.status = gate.nextState === 'next-slice'
        ? 'next-slice'
        : 'completed'
}

function validateCanonicalWriterProjection(stages, ledgerProjection) {
    if (!ledgerProjection) {
        if (Object.keys(stages).length > 0) {
            fail('runtime-projector-active-writer-ledger-v2-required')
        }
        return
    }
    if (ledgerProjection.schema !== 'issue-orchestration.projection.v2') {
        fail('runtime-projector-writer-ledger-projection-mismatch')
    }
    for (const [nodeId, stage] of Object.entries(stages)) {
        const node = ledgerProjection.nodes?.[nodeId]
        const prefix = node?.completedSlicePrefix
        if (!node || !Array.isArray(prefix)) {
            fail('runtime-projector-writer-ledger-projection-mismatch')
        }
        const receiptDigests = prefix.map((entry) =>
            entry?.terminalReceiptDigest)
        if (!sameOrderedValue(
            receiptDigests,
            stage.completedSliceReceiptDigests
        ) ||
            prefix.length !== stage.completedSlicePrefix.length ||
            prefix.some((entry, index) => {
                const projected = stage.completedSlicePrefix[index]
                return !projected ||
                !SHA256.test(entry?.planDigest ?? '') ||
                entry?.stageRole !== stage.stageRole ||
                entry?.stagePhase !== stage.stagePhase ||
                typeof entry?.stageAttemptId !== 'string' ||
                !entry.stageAttemptId ||
                !SHA256.test(entry?.sliceDigest ?? '') ||
                !SHA256.test(entry?.checkpointDigest ?? '') ||
                !SHA256.test(
                    entry?.checkpointVerificationReceiptDigest ?? ''
                ) ||
                !SHA256.test(entry?.tracePrefixDigest ?? '') ||
                !Array.isArray(entry?.changedPaths) ||
                entry.changedPaths.some((filePath) =>
                    typeof filePath !== 'string' || !filePath) ||
                !SHA256.test(entry?.terminalReceiptDigest ?? '') ||
                projected.planDigest !== entry.planDigest ||
                projected.sliceId !== entry.sliceId ||
                projected.sliceDigest !== entry.sliceDigest ||
                projected.checkpointDigest !== entry.checkpointDigest ||
                projected.checkpointVerificationReceiptDigest !==
                    entry.checkpointVerificationReceiptDigest ||
                projected.machineTracePrefixDigest !==
                    entry.tracePrefixDigest ||
                !sameOrderedValue(
                    projected.changedPaths,
                    entry.changedPaths
                ) ||
                projected.terminalReceiptDigest !==
                    entry.terminalReceiptDigest ||
                projected.stageRole !== entry.stageRole ||
                projected.stagePhase !== entry.stagePhase ||
                projected.stageAttemptId !== entry.stageAttemptId
            }) ||
            node.activePlanDigest !== stage.planDigest ||
            node.activeSliceId !== stage.sliceId ||
            node.activeSliceDigest !== stage.sliceDigest ||
            node.activeCompiledPromptDigest !==
                stage.compiledPromptDigest ||
            node.activeStageRole !== stage.stageRole ||
            node.activeStagePhase !== stage.stagePhase ||
            (node.latestCheckpointDigest ?? null) !==
                stage.checkpointDigest ||
            (node.latestCheckpointVerificationReceiptDigest ?? null) !==
                stage.checkpointVerificationReceiptDigest ||
            (node.latestCheckpointTracePrefixDigest ?? null) !==
                stage.machineTracePrefixDigest ||
            (node.writerStageTerminalReceiptDigest ?? null) !==
                stage.terminalReceiptDigest ||
            (node.writerStageFailureReceiptDigest ?? null) !==
                stage.failureReceiptDigest ||
            (node.writerStageSemanticFailureDigest ?? null) !==
                stage.semanticFailureDigest ||
            (node.writerStageRetryAuthorizationDigest ?? null) !==
                stage.retryAuthorizationDigest ||
            (node.expectedNextSliceId ?? null) !==
                stage.expectedNextSliceId ||
            (node.expectedNextSliceDigest ?? null) !==
                stage.expectedNextSliceDigest ||
            (node.expectedNextPlanDigest ?? null) !==
                stage._expectedNextPlanDigest ||
            (node.expectedNextCompiledPromptDigest ?? null) !==
                stage._expectedNextCompiledPromptDigest) {
            fail('runtime-projector-writer-ledger-projection-mismatch')
        }
        if (stage.status === 'completed' &&
            node.completedWriterStageAttemptId !==
                stage.stageAttemptId ||
            stage.status !== 'completed' &&
                node.completedWriterStageAttemptId !== null ||
            node.activeAttemptId !== null &&
                node.activeAttemptId !== stage.stageAttemptId) {
            fail('runtime-projector-writer-ledger-projection-mismatch')
        }
    }
}

function projectWriterStages(ledger, canonicalLedgerProjection) {
    const stages = {}
    for (const [eventIndex, event] of ledger.events.entries()) {
        const nodeId = event.nodeId
        if (!nodeId) {
            if (WRITER_START_PHASES[event.eventType] ||
                typeof event.eventType === 'string' &&
                    event.eventType.startsWith('writer-stage.')) {
                fail('runtime-projector-writer-node-binding-invalid')
            }
            continue
        }
        const start = writerStartArtifacts(event)
        if (start) {
            const { plan, slice, compiledPrompt } = start
            const prior = stages[nodeId]
            const sealedAuthority =
                sealedWriterAuthority(ledger, eventIndex, plan)
            if (validateSealedStageWorkPlan(
                plan,
                sealedAuthority
            ).length ||
                validateSealedExecutableSlice({
                    plan,
                    slice,
                    authority: sealedAuthority
                }).length ||
                validateSealedCompiledDispatchPrompt({
                    plan,
                    slice,
                    compiled: compiledPrompt,
                    authority: sealedAuthority
                }).length) {
                fail('runtime-projector-writer-start-binding-invalid')
            }
            const firstSlice = compileExecutableSlice({
                plan,
                sliceId: plan.orderedSlices[0]?.sliceId
            })
            if (!prior && firstSlice.sliceDigest !== slice.sliceDigest) {
                fail('runtime-projector-writer-first-slice-binding-invalid')
            }
            const authorizedResume = prior &&
                prior.expectedNextSliceDigest === slice.sliceDigest &&
                prior.expectedNextSliceId === slice.sliceId &&
                prior._expectedNextPlanDigest === plan.planDigest &&
                prior._expectedNextCompiledPromptDigest ===
                    compiledPrompt.promptDigest
            const completedPhaseTransition = prior &&
                prior.status === 'completed' &&
                prior.planDigest !== plan.planDigest &&
                prior.stagePhase !== plan.stagePhase
            if (prior &&
                !authorizedResume &&
                !completedPhaseTransition) {
                fail('runtime-projector-writer-next-slice-binding-invalid')
            }
            const canonicalCompletedSlicePrefix =
                canonicalLedgerProjection?.nodes?.[nodeId]
                    ?.completedSlicePrefix
            if (!Array.isArray(canonicalCompletedSlicePrefix)) {
                fail('runtime-projector-writer-ledger-projection-mismatch')
            }
            stages[nodeId] = {
                runId: plan.runId,
                repository: plan.repository,
                issue: plan.issue,
                node: plan.node,
                baseSha: plan.baseSha,
                epochId: plan.epochId,
                worktreeIdentity: plan.worktreeIdentity,
                stageAttemptId: plan.stageAttemptId,
                stageRole: plan.stageRole,
                stagePhase: plan.stagePhase,
                acceptedPriorChangedPathsDigest: null,
                checkpointOrdinal: null,
                checkpointVerificationReceiptDigest: null,
                completedSlicePrefix: authorizedResume
                    ? clone(prior.completedSlicePrefix ?? [])
                    : [],
                completedSlicePrefixDigest: null,
                completedSliceReceiptDigests: authorizedResume
                    ? [...(prior.completedSliceReceiptDigests ?? [])]
                    : [],
                planDigest: plan.planDigest,
                sliceId: slice.sliceId,
                sliceDigest: slice.sliceDigest,
                compiledPromptDigest: compiledPrompt.promptDigest,
                checkpointDigest: null,
                machineTracePrefixByteLength: null,
                machineTracePrefixDigest: null,
                machineTraceSnapshotDigest: null,
                operationsDigest: null,
                previousCheckpointDigest: null,
                previousCheckpointVerificationReceiptDigest: null,
                previousMachineTracePrefixByteLength: null,
                previousMachineTracePrefixDigest: null,
                runtimeProgressObservationDigest: null,
                continuationReceiptDigest: null,
                terminalReceiptDigest: null,
                terminalChainDigest: null,
                failureReceiptDigest: null,
                semanticFailureDigest: null,
                retryAuthorizationDigest: authorizedResume
                    ? prior.retryAuthorizationDigest ?? null
                    : null,
                expectedNextSliceId: null,
                expectedNextSliceDigest: null,
                _expectedNextPlanDigest: null,
                _expectedNextCompiledPromptDigest: null,
                _canonicalCompletedSlicePrefix:
                    canonicalCompletedSlicePrefix,
                _sealedAuthority: sealedAuthority,
                _activeCheckpointLineage: null,
                _lastCheckpointLineage: null,
                _carryForwardPrefix: authorizedResume
                    ? prior._carryForwardPrefix
                    : null,
                breakerOpen: false,
                status: 'active'
            }
            continue
        }
        const stage = stages[nodeId]
        if (!stage) {
            if (typeof event.eventType === 'string' &&
                event.eventType.startsWith('writer-stage.')) {
                fail('runtime-projector-writer-stage-missing')
            }
            continue
        }
        const payload = event.payload ?? {}
        if (event.eventType === 'writer-stage.checkpoint-recorded') {
            projectWriterCheckpoint(stage, payload)
        } else if (event.eventType ===
            'writer-stage.continuation-recorded') {
            projectWriterContinuation(stage, payload)
        } else if (WRITER_FAILURE_EVENTS.has(event.eventType)) {
            projectWriterFailure(stage, event)
        } else if (event.eventType === 'writer-stage.retry-authorized') {
            projectWriterRetry(stage, payload)
        } else if (event.eventType === 'writer-stage.slice-completed' ||
            event.eventType === 'writer-stage.completed') {
            projectWriterTerminal(stage, event)
        }
    }
    validateCanonicalWriterProjection(stages, canonicalLedgerProjection)
    for (const stage of Object.values(stages)) {
        delete stage._expectedNextPlanDigest
        delete stage._expectedNextCompiledPromptDigest
        delete stage._canonicalCompletedSlicePrefix
        delete stage._sealedAuthority
        delete stage._activeCheckpointLineage
        delete stage._lastCheckpointLineage
        delete stage._carryForwardPrefix
    }
    return canonical(stages)
}

function projectCandidateCommits(
    runtimeCandidateCommits,
    writerStages,
    canonicalLedgerProjection
) {
    const candidates = clone(runtimeCandidateCommits ?? {})
    if (!canonicalLedgerProjection) return canonical(candidates)
    for (const nodeId of Object.keys(writerStages)) {
        const candidateSha =
            canonicalLedgerProjection.nodes?.[nodeId]?.candidateSha ?? null
        if (candidateSha === null) {
            if (Object.hasOwn(candidates, nodeId)) {
                fail('runtime-projector-writer-candidate-premature')
            }
            continue
        }
        if (!GIT_SHA.test(candidateSha) ||
            Object.hasOwn(candidates, nodeId) &&
                candidates[nodeId] !== candidateSha) {
            fail('runtime-projector-writer-candidate-binding-invalid')
        }
        candidates[nodeId] = candidateSha
    }
    return canonical(candidates)
}

export function projectRuntime({ semanticGraph, ledger, runtime }) {
    validateSemanticGraph(semanticGraph)
    requireObject(ledger, 'runtime-projector-ledger-invalid')
    const canonicalWriterLedger = replayCanonicalWriterLedger(ledger)
    if (!canonicalWriterLedger &&
        ledger.schema !==
            'issue-orchestration.immutable-runtime-ledger.v1') {
        fail('runtime-projector-ledger-schema-invalid')
    }
    if (!Array.isArray(ledger.events)) fail('runtime-projector-events-invalid')
    requireObject(runtime, 'runtime-projector-facts-invalid')

    const nodes = semanticGraph.nodes
    const nodeIds = new Set(nodes.map(({ id }) => id))
    const completed = new Set([
        ...(runtime.completed ?? []),
        ...ledgerCompleted(ledger)
    ].filter((id) => nodeIds.has(id)))
    const leases = clone(runtime.leases ?? []).sort((left, right) =>
        JSON.stringify(canonical(left)).localeCompare(
            JSON.stringify(canonical(right))
        )
    )
    const leased = new Set(leases.map(({ issueId, nodeId }) => issueId ?? nodeId))
    const active = uniqueSorted(runtime.active)
        .filter((id) => nodeIds.has(id) && !completed.has(id))
    const occupiedIds = new Set([...active, ...leased])
    const conflicts = conflictProjection(nodes, active, leased)
    const prerequisiteReady = nodes.filter((node) =>
        !completed.has(node.id)
        && !active.includes(node.id)
        && !leased.has(node.id)
        && node.dependencyKeys.every((dependency) => completed.has(dependency))
    )
    const readyFrontier = prerequisiteReady
        .filter((node) => !hasOccupiedConflict(node, conflicts, occupiedIds))
        .map(({ id }) => id)
        .sort()
    const blocked = nodes.filter((node) =>
        !completed.has(node.id)
        && !active.includes(node.id)
        && !readyFrontier.includes(node.id)
    ).map(({ id }) => id).sort()
    const availableSlots = Number.isInteger(runtime.availableSlots)
        && runtime.availableSlots >= 0
        ? runtime.availableSlots
        : 0
    const nextExecutableFrontier =
        readyFrontier.slice(0, Math.max(0, availableSlots))
    const writerStages =
        projectWriterStages(ledger, canonicalWriterLedger)

    const projection = {
        schema: RUNTIME_PROJECTION_SCHEMA,
        semanticGraphDigest: semanticGraph.semanticGraphDigest,
        projectorVersion: PROJECTOR_VERSION,
        projectorDigest: PROJECTOR_DIGEST,
        ledgerDigest: digest(ledger),
        completed: [...completed].sort(),
        active,
        blocked,
        readyFrontier,
        nextExecutableFrontier,
        criticalPath: criticalPath(nodes, completed),
        downstreamBlockedCount: downstreamBlockedCounts(nodes, completed),
        conflictProjection: conflicts,
        slotLeaseOccupancy: {
            availableSlots,
            leaseCount: leases.length,
            occupiedIssueIds: [...occupiedIds].sort(),
            leases
        },
        epochId: runtime.epochId ?? null,
        candidateCommits: projectCandidateCommits(
            runtime.candidateCommits,
            writerStages,
            canonicalWriterLedger
        ),
        deliveryCommits: canonical(runtime.deliveryCommits ?? {}),
        cleanup: canonical(runtime.cleanup ?? {}),
        writerStages
    }
    validateWriterStageProjection(projection.writerStages)
    projection.runtimeProjectionDigest = digest(projection)
    return projection
}

function completedSliceProjectionValid(stage) {
    if (!Array.isArray(stage.completedSlicePrefix) ||
        stage.completedSlicePrefix.length !==
            stage.completedSliceReceiptDigests.length) {
        return false
    }
    const priorTerminalReceiptDigests = []
    for (const [index, entry] of
        stage.completedSlicePrefix.entries()) {
        if (!entry || typeof entry !== 'object' ||
            Array.isArray(entry) ||
            !sameOrderedValue(
                Object.keys(entry).sort(),
                [...COMPLETED_SLICE_PROJECTION_FIELDS].sort()
            ) ||
            !checkpointProjectionValid(entry) ||
            !SHA256.test(entry.checkpointDigest ?? '') ||
            !SHA256.test(entry.planDigest ?? '') ||
            !SHA256.test(entry.sliceDigest ?? '') ||
            !SHA256.test(entry.terminalChainDigest ?? '') ||
            !SHA256.test(entry.terminalReceiptDigest ?? '') ||
            entry.sliceOrdinal !== index + 1 ||
            !Number.isInteger(entry.planSliceCount) ||
            entry.planSliceCount < entry.sliceOrdinal ||
            !sameOrderedValue(
                entry.priorTerminalReceiptDigests,
                priorTerminalReceiptDigests
            ) ||
            entry.terminalChainDigest !==
                terminalChainDigestFor(entry) ||
            entry.terminalReceiptDigest !==
                stage.completedSliceReceiptDigests[index] ||
            !WRITER_PHASE_ROLES[entry.stagePhase]?.has(
                entry.stageRole
            ) ||
            entry.stagePhase !== stage.stagePhase ||
            entry.stageRole !== stage.stageRole ||
            typeof entry.stageAttemptId !== 'string' ||
            !entry.stageAttemptId ||
            typeof entry.sliceId !== 'string' ||
            !entry.sliceId ||
            !Array.isArray(entry.changedPaths) ||
            entry.changedPaths.some((filePath) =>
                typeof filePath !== 'string' || !filePath) ||
            new Set(entry.changedPaths).size !==
                entry.changedPaths.length ||
            !sameOrderedValue(
                entry.changedPaths,
                [...entry.changedPaths].sort()
            )) {
            return false
        }
        priorTerminalReceiptDigests.push(
            entry.terminalReceiptDigest
        )
    }
    return true
}

function validateWriterStageProjection(writerStages) {
    requireObject(
        writerStages,
        'runtime-projection-writer-stages-invalid'
    )
    for (const [nodeId, stage] of Object.entries(writerStages)) {
        requireObject(stage, 'runtime-projection-writer-stage-invalid')
        if (!sameOrderedValue(
            Object.keys(stage).sort(),
            [...WRITER_STAGE_PROJECTION_FIELDS].sort()
        ) ||
            stage.node !== nodeId ||
            !GIT_SHA.test(stage.baseSha ?? '') ||
            !WRITER_PHASE_ROLES[stage.stagePhase]?.has(stage.stageRole) ||
            !WRITER_STAGE_STATUSES.has(stage.status) ||
            typeof stage.breakerOpen !== 'boolean' ||
            !Array.isArray(stage.completedSliceReceiptDigests) ||
            stage.completedSliceReceiptDigests.some((value) =>
                !SHA256.test(value)) ||
            new Set(stage.completedSliceReceiptDigests).size !==
                stage.completedSliceReceiptDigests.length ||
            !completedSliceProjectionValid(stage) ||
            !Number.isInteger(stage.issue) &&
                (typeof stage.issue !== 'string' || !stage.issue) ||
            ![
                'runId',
                'repository',
                'node',
                'epochId',
                'worktreeIdentity',
                'stageAttemptId',
                'sliceId'
            ].every((field) =>
                typeof stage[field] === 'string' && stage[field].length > 0) ||
            ![
                'planDigest',
                'sliceDigest',
                'compiledPromptDigest'
            ].every((field) => SHA256.test(stage[field] ?? '')) ||
            ![
                'acceptedPriorChangedPathsDigest',
                'checkpointDigest',
                'checkpointVerificationReceiptDigest',
                'completedSlicePrefixDigest',
                'machineTracePrefixDigest',
                'machineTraceSnapshotDigest',
                'operationsDigest',
                'previousCheckpointDigest',
                'previousCheckpointVerificationReceiptDigest',
                'previousMachineTracePrefixDigest',
                'runtimeProgressObservationDigest',
                'continuationReceiptDigest',
                'terminalChainDigest',
                'terminalReceiptDigest',
                'failureReceiptDigest',
                'semanticFailureDigest',
                'retryAuthorizationDigest',
                'expectedNextSliceDigest'
            ].every((field) =>
                stage[field] === null ||
                SHA256.test(stage[field] ?? '')) ||
            CHECKPOINT_NUMBER_PROJECTION_FIELDS.some((field) =>
                stage[field] !== null &&
                (!Number.isInteger(stage[field]) ||
                    stage[field] < 1)) ||
            stage.expectedNextSliceId !== null &&
                (typeof stage.expectedNextSliceId !== 'string' ||
                    !stage.expectedNextSliceId)) {
            fail('runtime-projection-writer-stage-invalid')
        }
        const hasActiveCheckpoint = stage.checkpointDigest !== null
        if (hasActiveCheckpoint !==
                (stage.checkpointVerificationReceiptDigest !== null) ||
            hasActiveCheckpoint &&
                !checkpointProjectionValid(stage) ||
            !hasActiveCheckpoint &&
                (CHECKPOINT_DIGEST_PROJECTION_FIELDS.some((field) =>
                    stage[field] !== null) ||
                CHECKPOINT_NUMBER_PROJECTION_FIELDS.some((field) =>
                    stage[field] !== null)) ||
            stage.completedSlicePrefix.length === 0 &&
                (stage.terminalReceiptDigest !== null ||
                    stage.terminalChainDigest !== null) ||
            stage.completedSlicePrefix.length > 0 &&
                ((stage.terminalReceiptDigest === null) !==
                    (stage.terminalChainDigest === null) ||
                stage.terminalReceiptDigest !== null &&
                    (stage.terminalReceiptDigest !==
                        stage.completedSlicePrefix.at(-1)
                            .terminalReceiptDigest ||
                    stage.terminalChainDigest !==
                        stage.completedSlicePrefix.at(-1)
                            .terminalChainDigest))) {
            fail('runtime-projection-writer-stage-checkpoint-invalid')
        }
        if (stage.status === 'terminal-failure' &&
            (stage.breakerOpen !== true ||
                !stage.failureReceiptDigest ||
                !stage.semanticFailureDigest) ||
            stage.status === 'retry-authorized' &&
                (stage.breakerOpen !== false ||
                    !stage.retryAuthorizationDigest ||
                    !stage.expectedNextSliceDigest) ||
            stage.status === 'next-slice' &&
                (!stage.terminalReceiptDigest ||
                    !stage.terminalChainDigest ||
                    !stage.expectedNextSliceId ||
                    !stage.expectedNextSliceDigest ||
                    stage.completedSliceReceiptDigests.length === 0) ||
            stage.status === 'completed' &&
                (stage.breakerOpen !== false ||
                    !stage.terminalReceiptDigest ||
                    !stage.terminalChainDigest ||
                    stage.expectedNextSliceId !== null ||
                    stage.expectedNextSliceDigest !== null ||
                    stage.completedSliceReceiptDigests.length === 0)) {
            fail('runtime-projection-writer-stage-state-invalid')
        }
    }
}

function validateProjectionShape(projection) {
    requireObject(projection, 'runtime-projection-invalid')
    for (const field of Object.keys(projection)) {
        if (GRAPH_OWNED_PROJECTION_FIELDS.has(field)) {
            fail('projector-semantic-write-forbidden')
        }
        if (SEMANTIC_PAYLOAD_PROJECTION_FIELDS.has(field)) {
            fail('runtime-projection-semantic-field-forbidden')
        }
    }
    if (projection.schema !== RUNTIME_PROJECTION_SCHEMA) {
        fail('runtime-projection-schema-invalid')
    }
    requireSha(
        projection.runtimeProjectionDigest,
        'runtime-projection-digest-invalid'
    )
    if (unsignedDigest(projection, 'runtimeProjectionDigest')
        !== projection.runtimeProjectionDigest) {
        fail('runtime-projection-digest-mismatch')
    }
    requireSha(
        projection.semanticGraphDigest,
        'runtime-projection-semantic-digest-invalid'
    )
    if (projection.projectorVersion !== PROJECTOR_VERSION
        || projection.projectorDigest !== PROJECTOR_DIGEST) {
        fail('runtime-projector-identity-mismatch')
    }
    validateWriterStageProjection(projection.writerStages)
}

export function validateRuntimeProjection({
    semanticGraph,
    ledger,
    runtime,
    projection
}) {
    validateSemanticGraph(semanticGraph)
    validateProjectionShape(projection)
    if (projection.semanticGraphDigest !== semanticGraph.semanticGraphDigest) {
        fail('runtime-projection-semantic-digest-mismatch')
    }
    const expected = projectRuntime({ semanticGraph, ledger, runtime })
    if (!sameValue(expected, projection)) {
        fail('runtime-projection-replay-mismatch')
    }
    return projection
}

function atomicWriteJson(targetPath, value) {
    const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
    })
    fs.renameSync(temporaryPath, targetPath)
}

export function persistSemanticRuntimeState({
    stateRoot,
    semanticGraph,
    runtimeProjection
}) {
    requireString(stateRoot, 'semantic-runtime-state-root-invalid')
    validateSemanticGraph(semanticGraph)
    validateProjectionShape(runtimeProjection)
    if (runtimeProjection.semanticGraphDigest
        !== semanticGraph.semanticGraphDigest) {
        fail('runtime-projection-semantic-digest-mismatch')
    }
    fs.mkdirSync(stateRoot, { recursive: true })
    const semanticGraphPath = path.join(stateRoot, 'semantic-graph.json')
    const runtimeProjectionPath =
        path.join(stateRoot, 'runtime-projection.json')
    atomicWriteJson(semanticGraphPath, semanticGraph)
    atomicWriteJson(runtimeProjectionPath, runtimeProjection)
    return { semanticGraphPath, runtimeProjectionPath }
}

export function loadSemanticRuntimeState({ stateRoot }) {
    requireString(stateRoot, 'semantic-runtime-state-root-invalid')
    const semanticGraph = JSON.parse(fs.readFileSync(
        path.join(stateRoot, 'semantic-graph.json'),
        'utf8'
    ))
    const runtimeProjection = JSON.parse(fs.readFileSync(
        path.join(stateRoot, 'runtime-projection.json'),
        'utf8'
    ))
    validateSemanticGraph(semanticGraph)
    validateProjectionShape(runtimeProjection)
    if (runtimeProjection.semanticGraphDigest
        !== semanticGraph.semanticGraphDigest) {
        fail('runtime-projection-semantic-digest-mismatch')
    }
    return { semanticGraph, runtimeProjection }
}

function normalizeExpectedMutation(entry) {
    requireObject(entry, 'expected-remote-mutation-invalid')
    requireString(entry.type, 'expected-remote-mutation-type-invalid')
    requireString(entry.issueId, 'expected-remote-mutation-issue-id-invalid')
    if (!EXPECTED_MUTATION_TYPES.has(entry.type)) {
        fail('expected-remote-mutation-type-forbidden')
    }
    switch (entry.type) {
        case 'completion-comment':
            requireSha(
                entry.commentDigest,
                'expected-remote-mutation-comment-digest-invalid'
            )
            return {
                type: entry.type,
                issueId: entry.issueId,
                commentDigest: entry.commentDigest
            }
        case 'state-transition':
        case 'state-reason':
            return {
                type: entry.type,
                issueId: entry.issueId,
                from: entry.from ?? null,
                to: entry.to ?? null
            }
        case 'label-change':
            return {
                type: entry.type,
                issueId: entry.issueId,
                added: uniqueSorted(entry.added),
                removed: uniqueSorted(entry.removed)
            }
        default:
            fail('expected-remote-mutation-type-forbidden')
    }
}

export function sealExpectedRemoteMutations(registry) {
    requireObject(registry, 'expected-remote-mutations-invalid')
    if (registry.schema !== EXPECTED_MUTATIONS_SCHEMA) {
        fail('expected-remote-mutations-schema-invalid')
    }
    requireString(registry.runId, 'expected-remote-mutations-run-id-invalid')
    if (!Array.isArray(registry.entries)) {
        fail('expected-remote-mutations-entries-invalid')
    }
    const sealed = {
        schema: EXPECTED_MUTATIONS_SCHEMA,
        runId: registry.runId,
        entries: registry.entries.map(normalizeExpectedMutation)
    }
    const identities = sealed.entries.map(digest)
    if (new Set(identities).size !== identities.length) {
        fail('expected-remote-mutation-duplicate')
    }
    sealed.expectedRemoteMutationDigest = digest(sealed)
    return sealed
}

function validateExpectedRemoteMutations(registry) {
    requireObject(registry, 'expected-remote-mutations-invalid')
    requireSha(
        registry.expectedRemoteMutationDigest,
        'expected-remote-mutation-digest-invalid'
    )
    const resealed = sealExpectedRemoteMutations(registry)
    if (resealed.expectedRemoteMutationDigest
        !== registry.expectedRemoteMutationDigest) {
        fail('expected-remote-mutation-digest-mismatch')
    }
    return resealed
}

function issueMap(snapshot) {
    return new Map((snapshot?.issues ?? []).map((issue) =>
        [issue.issueId, issue]
    ))
}

function remoteMutations(before, after) {
    const beforeById = issueMap(before)
    const afterById = issueMap(after)
    const mutations = []
    const ids = new Set([...beforeById.keys(), ...afterById.keys()])
    for (const issueId of [...ids].sort()) {
        const left = beforeById.get(issueId)
        const right = afterById.get(issueId)
        if (!left) {
            mutations.push({ type: 'issue-added', issueId })
            continue
        }
        if (!right) {
            mutations.push({ type: 'issue-removed', issueId })
            continue
        }
        if (left.state !== right.state) {
            mutations.push({
                type: 'state-transition',
                issueId,
                from: left.state,
                to: right.state
            })
        }
        if ((left.stateReason ?? null) !== (right.stateReason ?? null)) {
            mutations.push({
                type: 'state-reason',
                issueId,
                from: left.stateReason ?? null,
                to: right.stateReason ?? null
            })
        }
        const beforeLabels = new Set(left.labels ?? [])
        const afterLabels = new Set(right.labels ?? [])
        const added = [...afterLabels].filter((label) => !beforeLabels.has(label))
            .sort()
        const removed = [...beforeLabels]
            .filter((label) => !afterLabels.has(label)).sort()
        if (added.length > 0 || removed.length > 0) {
            mutations.push({ type: 'label-change', issueId, added, removed })
        }
        const beforeComments = new Set(
            (left.comments ?? []).map(({ id }) => id)
        )
        for (const comment of right.comments ?? []) {
            if (beforeComments.has(comment.id)) continue
            if (comment.kind === 'delivery' && SHA256.test(comment.bodyDigest)) {
                mutations.push({
                    type: 'completion-comment',
                    issueId,
                    commentDigest: comment.bodyDigest
                })
            } else {
                mutations.push({
                    type: 'comment-added',
                    issueId,
                    commentId: comment.id,
                    commentDigest: comment.bodyDigest ?? null
                })
            }
        }
        for (const [field, type] of [
            ['title', 'title-change'],
            ['body', 'body-change'],
            ['milestone', 'milestone-change'],
            ['confirmedDefectAdmission', 'admission-change'],
            ['semanticFacts', 'semantic-facts-change']
        ]) {
            if (!sameValue(left[field] ?? null, right[field] ?? null)) {
                mutations.push({
                    type,
                    issueId,
                    beforeDigest: digest(left[field] ?? null),
                    afterDigest: digest(right[field] ?? null)
                })
            }
        }
    }
    return mutations
}

function reconcileExpectedMutations(observed, registry) {
    const expectedByDigest = new Map(
        registry.entries.map((entry) => [digest(entry), entry])
    )
    const observedByDigest = new Map(
        observed.map((entry) => [digest(entry), entry])
    )
    return {
        unmatchedExpectedMutations: [...expectedByDigest.entries()]
            .filter(([identity]) => !observedByDigest.has(identity))
            .map(([, entry]) => entry),
        unexpectedRemoteMutations: [...observedByDigest.entries()]
            .filter(([identity]) => !expectedByDigest.has(identity))
            .map(([, entry]) => entry)
    }
}

export function classifyRemoteMutations({
    selector,
    before,
    after,
    expectedRemoteMutations,
    semanticGraph,
    runtimeProjectionBefore,
    runtimeProjectionAfter
}) {
    validateSemanticGraph(semanticGraph)
    validateProjectionShape(runtimeProjectionBefore)
    validateProjectionShape(runtimeProjectionAfter)
    const registry = validateExpectedRemoteMutations(expectedRemoteMutations)
    const beforeLayers = computeDigestLayers({
        selector,
        snapshot: before,
        semanticGraph,
        runtimeProjection: runtimeProjectionBefore
    })
    const afterLayers = computeDigestLayers({
        selector,
        snapshot: after,
        semanticGraph,
        runtimeProjection: runtimeProjectionAfter
    })
    const observed = remoteMutations(before, after)
    const reconciliation = reconcileExpectedMutations(observed, registry)
    const expectedRemoteMutationMatched =
        reconciliation.unmatchedExpectedMutations.length === 0
        && reconciliation.unexpectedRemoteMutations.length === 0
    const semanticChanged = beforeLayers.semanticGraphInputDigest
        !== afterLayers.semanticGraphInputDigest
        || observed.some(({ type }) => SEMANTIC_MUTATION_TYPES.has(type))
    const scopeChanged = beforeLayers.scopeDigest !== afterLayers.scopeDigest
    const runtimeChanged = beforeLayers.runtimeProjectionDigest
        !== afterLayers.runtimeProjectionDigest

    let dagUpdateMode = 'none'
    let remoteMutationClassification = 'no-change'
    if (semanticChanged) {
        dagUpdateMode = 'semantic-patch'
        remoteMutationClassification = 'unexpected-semantic-change'
    } else if (scopeChanged || runtimeChanged || observed.length > 0) {
        dagUpdateMode = 'projection-only'
        remoteMutationClassification = expectedRemoteMutationMatched
            && registry.entries.length > 0
            ? 'matched-expected-remote-mutations:projection-only'
            : 'runtime-projection-only'
    }
    return {
        dagUpdateMode,
        remoteMutationClassification,
        expectedRemoteMutationDigest: registry.expectedRemoteMutationDigest,
        expectedRemoteMutationMatched,
        ...reconciliation,
        scopeDigestBefore: beforeLayers.scopeDigest,
        scopeDigestAfter: afterLayers.scopeDigest,
        semanticGraphInputDigestBefore:
            beforeLayers.semanticGraphInputDigest,
        semanticGraphInputDigestAfter:
            afterLayers.semanticGraphInputDigest,
        semanticGraphDigestBefore: semanticGraph.semanticGraphDigest,
        semanticGraphDigestAfter: semanticGraph.semanticGraphDigest,
        runtimeProjectionDigestBefore:
            beforeLayers.runtimeProjectionDigest,
        runtimeProjectionDigestAfter:
            afterLayers.runtimeProjectionDigest,
        dagUpdaterDispatchCount: 0,
        requiredDagUpdaterDispatchCount:
            dagUpdateMode === 'semantic-patch' ? 1 : 0,
        allowedProposalKinds: dagUpdateMode === 'semantic-patch'
            ? ['minimal-patch']
            : []
    }
}

function validateGraphAuthor(author) {
    requireObject(author, 'graph-patch-authority')
    try {
        validateRouteBoundActor({
            actor: author,
            stageRole: 'dag-creator-updater',
            stagePhase: 'semantic-proposal',
            proposalOnly: true
        })
    } catch {
        fail('graph-patch-authority')
    }
    if (author.acceptedWithoutModification !== true) {
        fail('graph-patch-authority')
    }
}

function mutableGraph(graph) {
    return {
        selectorReceiptDigest: graph.selectorReceiptDigest,
        remoteSnapshotDigest: graph.remoteSnapshotDigest,
        scopeDigest: graph.scopeDigest,
        semanticGraphInputDigest: graph.semanticGraphInputDigest,
        policyDigest: graph.policyDigest,
        repositories: graph.repositories.map((repository) => clone(repository)),
        nodes: graph.nodes.map((node) => clone(node))
    }
}

function nodeFor(nodes, nodeId) {
    const node = nodes.find(({ id }) => id === nodeId)
    if (!node) fail('graph-patch-node-not-found')
    return node
}

function assertFrom(current, operation) {
    if (Object.hasOwn(operation, 'from')
        && !sameValue(current, operation.from)) {
        fail('graph-patch-operation-precondition-mismatch')
    }
}

function applyPatchOperations(baseSemanticGraph, operations) {
    const mutable = mutableGraph(baseSemanticGraph)
    for (const operation of operations) {
        requireObject(operation, 'graph-patch-operation-invalid')
        if (!ALLOWED_PATCH_OPERATIONS.has(operation.type)) {
            fail('graph-patch-operation-forbidden')
        }
        switch (operation.type) {
            case 'add-node':
                if (!operation.node) fail('graph-patch-operation-invalid')
                if (mutable.nodes.some(({ id }) => id === operation.node.id)) {
                    fail('graph-patch-node-exists')
                }
                const repository = operation.node.repository ??
                    operation.node.id?.split('#')[0]
                const repositoryBinding = mutable.repositories.find(
                    (entry) => entry.repository === repository
                )
                mutable.nodes.push(normalizeNode({
                    ...operation.node,
                    memberId: operation.node.memberId ?? operation.node.id,
                    repository,
                    issueNumber: operation.node.issueNumber ?? Number(
                        operation.node.id?.match(/#(\d+)/u)?.[1]
                    ),
                    lifecycleState:
                        operation.node.lifecycleState ?? 'discovered',
                    selectorReceiptDigest:
                        operation.node.selectorReceiptDigest ??
                        mutable.selectorReceiptDigest,
                    remoteSnapshotDigest:
                        operation.node.remoteSnapshotDigest ??
                        mutable.remoteSnapshotDigest,
                    repositoryBindingDigest:
                        operation.node.repositoryBindingDigest ??
                        repositoryBinding?.bindingDigest,
                    semanticFactsDigest:
                        operation.node.semanticFactsDigest ??
                        digest(operation.node),
                    receipts: operation.node.receipts ?? {}
                }))
                break
            case 'remove-node': {
                const index = mutable.nodes.findIndex(
                    ({ id }) => id === operation.nodeId
                )
                if (index < 0) fail('graph-patch-node-not-found')
                mutable.nodes.splice(index, 1)
                for (const node of mutable.nodes) {
                    node.dependencyKeys = node.dependencyKeys
                        .filter((id) => id !== operation.nodeId)
                }
                break
            }
            case 'add-edge': {
                requireString(operation.from, 'graph-patch-operation-invalid')
                const target = nodeFor(mutable.nodes, operation.to)
                if (target.dependencyKeys.includes(operation.from)) {
                    fail('graph-patch-edge-exists')
                }
                target.dependencyKeys.push(operation.from)
                target.dependencyKeys.sort()
                break
            }
            case 'remove-edge': {
                const target = nodeFor(mutable.nodes, operation.to)
                if (!target.dependencyKeys.includes(operation.from)) {
                    fail('graph-patch-edge-not-found')
                }
                target.dependencyKeys = target.dependencyKeys
                    .filter((id) => id !== operation.from)
                break
            }
            case 'change-owner': {
                const node = nodeFor(mutable.nodes, operation.nodeId)
                assertFrom(node.owner, operation)
                requireString(operation.to, 'graph-patch-operation-invalid')
                node.owner = operation.to
                break
            }
            case 'change-conflict-key': {
                const node = nodeFor(mutable.nodes, operation.nodeId)
                if (!node.conflictKeys.includes(operation.from)) {
                    fail('graph-patch-operation-precondition-mismatch')
                }
                requireString(operation.to, 'graph-patch-operation-invalid')
                node.conflictKeys = uniqueSorted([
                    ...node.conflictKeys.filter((key) => key !== operation.from),
                    operation.to
                ])
                break
            }
            case 'change-risk-class': {
                const node = nodeFor(mutable.nodes, operation.nodeId)
                assertFrom(node.riskClass, operation)
                requireString(operation.to, 'graph-patch-operation-invalid')
                node.riskClass = operation.to
                break
            }
            case 'change-ui-class': {
                const node = nodeFor(mutable.nodes, operation.nodeId)
                assertFrom(node.uiClass, operation)
                requireString(operation.to, 'graph-patch-operation-invalid')
                node.uiClass = operation.to
                break
            }
            case 'change-acceptance-group': {
                const node = nodeFor(mutable.nodes, operation.nodeId)
                assertFrom(node.acceptanceGroup, operation)
                if (operation.to !== null
                    && typeof operation.to !== 'string') {
                    fail('graph-patch-operation-invalid')
                }
                node.acceptanceGroup = operation.to
                break
            }
        }
    }
    return createSemanticGraph(mutable)
}

export function sealSemanticGraphPatch({
    baseSemanticGraph,
    operations,
    evidenceDigests,
    authoredBy
}) {
    validateSemanticGraph(baseSemanticGraph)
    validateGraphAuthor(authoredBy)
    if (!Array.isArray(operations) || operations.length === 0) {
        fail('graph-patch-operations-required')
    }
    if (!Array.isArray(evidenceDigests) || evidenceDigests.length === 0) {
        fail('graph-patch-evidence-required')
    }
    for (const evidenceDigest of evidenceDigests) {
        requireSha(evidenceDigest, 'graph-patch-evidence-digest-invalid')
    }
    const result = applyPatchOperations(baseSemanticGraph, operations)
    const patch = {
        schema: GRAPH_PATCH_SCHEMA,
        baseSemanticGraphDigest: baseSemanticGraph.semanticGraphDigest,
        operations: clone(operations),
        evidenceDigests: uniqueSorted(evidenceDigests),
        authoredBy: clone(authoredBy),
        resultSemanticGraphDigest: result.semanticGraphDigest
    }
    patch.graphPatchDigest = digest(patch)
    return patch
}

export function validateSemanticGraphPatch({ baseSemanticGraph, patch }) {
    validateSemanticGraph(baseSemanticGraph)
    requireObject(patch, 'graph-patch-invalid')
    if (patch.schema !== GRAPH_PATCH_SCHEMA) fail('graph-patch-schema-invalid')
    if (Object.hasOwn(patch, 'semanticGraph')
        || Object.hasOwn(patch, 'fullGraph')) {
        fail('graph-patch-full-graph-forbidden')
    }
    if (patch.baseSemanticGraphDigest
        !== baseSemanticGraph.semanticGraphDigest) {
        fail('graph-patch-base-digest-mismatch')
    }
    validateGraphAuthor(patch.authoredBy)
    if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
        fail('graph-patch-operations-required')
    }
    if (!Array.isArray(patch.evidenceDigests)
        || patch.evidenceDigests.length === 0) {
        fail('graph-patch-evidence-required')
    }
    for (const evidenceDigest of patch.evidenceDigests) {
        requireSha(evidenceDigest, 'graph-patch-evidence-digest-invalid')
    }
    requireSha(patch.graphPatchDigest, 'graph-patch-digest-invalid')
    if (unsignedDigest(patch, 'graphPatchDigest')
        !== patch.graphPatchDigest) {
        fail('graph-patch-digest-mismatch')
    }
    const result = applyPatchOperations(baseSemanticGraph, patch.operations)
    if (result.semanticGraphDigest !== patch.resultSemanticGraphDigest) {
        fail('graph-patch-result-digest-mismatch')
    }
    return patch
}

export function applySemanticGraphPatch({
    baseSemanticGraph,
    patch,
    actor
}) {
    validateSemanticGraphPatch({ baseSemanticGraph, patch })
    if (actor?.actorRole !== 'root-scheduler'
        || actor.acceptedWithoutModification !== true
        || actor.acceptedPatchDigest !== patch.graphPatchDigest) {
        fail('graph-patch-root-acceptance-required')
    }
    return applyPatchOperations(baseSemanticGraph, patch.operations)
}

export function validateFullSemanticGraphProposal({ proposal, context = {} }) {
    requireObject(proposal, 'full-proposal-invalid')
    if (proposal.schema !== FULL_PROPOSAL_SCHEMA) {
        fail('full-proposal-schema-invalid')
    }
    validateGraphAuthor(proposal.authoredBy)
    validateSemanticGraph(proposal.semanticGraph)
    requireSha(proposal.proposalDigest, 'full-proposal-digest-invalid')
    if (unsignedDigest(proposal, 'proposalDigest') !== proposal.proposalDigest) {
        fail('full-proposal-digest-mismatch')
    }
    if (!Array.isArray(proposal.evidenceDigests)) {
        fail('full-proposal-evidence-invalid')
    }
    for (const evidenceDigest of proposal.evidenceDigests) {
        requireSha(evidenceDigest, 'full-proposal-evidence-digest-invalid')
    }
    if (proposal.reason == null || proposal.reason === '') {
        fail('full-proposal-reason-required')
    }
    if (proposal.mode === 'full-create'
        && proposal.reason === 'initial-create'
        && context.initialGraphMissing === true) {
        return proposal
    }
    if (proposal.mode !== 'full-recovery') {
        fail('full-proposal-reason-forbidden')
    }
    if (proposal.reason === 'graph-corruption-recovery') {
        const receipt = context.graphCorruptionReceiptDigest
        if (!SHA256.test(receipt ?? '')
            || !proposal.evidenceDigests.includes(receipt)) {
            fail('full-proposal-recovery-evidence-required')
        }
        return proposal
    }
    if (proposal.reason === 'scope-replacement') {
        const receipt = context.explicitScopeReplacementReceiptDigest
        if (!SHA256.test(receipt ?? '')
            || !proposal.evidenceDigests.includes(receipt)) {
            fail('full-proposal-recovery-evidence-required')
        }
        return proposal
    }
    fail('full-proposal-reason-forbidden')
}

function requireDecisionFields(receipt) {
    for (const field of DECISION_FIELDS) {
        if (!Object.hasOwn(receipt, field)) {
            fail('dag-update-decision-field-required', `missing ${field}`, {
                field
            })
        }
    }
}

function validateDecisionDigests(receipt) {
    for (const field of [
        'expectedRemoteMutationDigest',
        'scopeDigestBefore',
        'scopeDigestAfter',
        'semanticGraphInputDigestBefore',
        'semanticGraphInputDigestAfter',
        'semanticGraphDigestBefore',
        'semanticGraphDigestAfter',
        'runtimeProjectionDigestBefore',
        'runtimeProjectionDigestAfter',
        'baseSemanticGraphDigest',
        'projectorDigest'
    ]) requireSha(receipt[field], 'dag-update-decision-digest-invalid', field)
    if (receipt.graphPatchDigest !== null) {
        requireSha(
            receipt.graphPatchDigest,
            'dag-update-decision-digest-invalid',
            'graphPatchDigest'
        )
    }
    if (receipt.dagUpdaterDispatchReceiptDigest !== null) {
        requireSha(
            receipt.dagUpdaterDispatchReceiptDigest,
            'dag-update-decision-digest-invalid',
            'dagUpdaterDispatchReceiptDigest'
        )
    }
}

function dispatchPresent(receipt) {
    return receipt.dagUpdaterDispatchRequestId !== null
        || receipt.dagUpdaterDispatchReceiptDigest !== null
}

function validateDecisionMode(receipt) {
    if (typeof receipt.expectedRemoteMutationMatched !== 'boolean') {
        fail('expected-remote-mutation-reconciliation-required')
    }
    if (!Number.isInteger(receipt.graphPatchOperationCount)
        || receipt.graphPatchOperationCount < 0) {
        fail('dag-update-decision-patch-count-invalid')
    }
    requireString(
        receipt.remoteMutationClassification,
        'dag-update-decision-classification-invalid'
    )
    requireString(
        receipt.projectorVersion,
        'dag-update-decision-projector-version-invalid'
    )
    if (receipt.dagUpdateMode === 'semantic-patch'
        && /runtime|matched-expected|no-change/iu.test(
            receipt.remoteMutationClassification
        )) {
        fail('remote-mutation-classification-mismatch')
    }
    switch (receipt.dagUpdateMode) {
        case 'none':
        case 'projection-only':
            if (dispatchPresent(receipt)) {
                fail('projection-only-updater-dispatch-forbidden')
            }
            if (receipt.graphPatchDigest !== null
                || receipt.graphPatchOperationCount !== 0
                || receipt.fullProposalReason !== null) {
                fail('dag-update-decision-mode-fields-invalid')
            }
            return
        case 'semantic-patch':
            if (!receipt.dagUpdaterDispatchRequestId
                || !SHA256.test(
                    receipt.dagUpdaterDispatchReceiptDigest ?? ''
                )) {
                fail('semantic-patch-updater-dispatch-required')
            }
            if (!SHA256.test(receipt.graphPatchDigest ?? '')
                || receipt.graphPatchOperationCount < 1) {
                fail('semantic-patch-identity-required')
            }
            if (receipt.fullProposalReason !== null) {
                fail('dag-update-decision-mode-fields-invalid')
            }
            return
        case 'full-create':
        case 'full-recovery':
            if (!receipt.dagUpdaterDispatchRequestId
                || !SHA256.test(
                    receipt.dagUpdaterDispatchReceiptDigest ?? ''
                )) {
                fail('full-proposal-updater-dispatch-required')
            }
            if (receipt.graphPatchDigest !== null
                || receipt.graphPatchOperationCount !== 0
                || typeof receipt.fullProposalReason !== 'string'
                || receipt.fullProposalReason.length === 0) {
                fail('dag-update-decision-mode-fields-invalid')
            }
            return
        default:
            fail('dag-update-decision-mode-invalid')
    }
}

function decisionBody(input) {
    requireObject(input, 'dag-update-decision-invalid')
    requireDecisionFields(input)
    return Object.fromEntries([
        ['schema', DECISION_RECEIPT_SCHEMA],
        ...DECISION_FIELDS.map((field) => [field, clone(input[field])])
    ])
}

export function sealDagUpdateDecisionReceipt(input) {
    const receipt = decisionBody(input)
    validateDecisionDigests(receipt)
    validateDecisionMode(receipt)
    receipt.receiptDigest = digest(receipt)
    return receipt
}

export function verifyDagUpdateDecisionReceipt(
    receipt,
    { expectedRemoteMutationDigest } = {}
) {
    requireObject(receipt, 'dag-update-decision-invalid')
    if (receipt.schema !== DECISION_RECEIPT_SCHEMA) {
        fail('dag-update-decision-schema-invalid')
    }
    requireDecisionFields(receipt)
    requireSha(receipt.receiptDigest, 'dag-update-decision-receipt-digest-invalid')
    if (unsignedDigest(receipt, 'receiptDigest') !== receipt.receiptDigest) {
        fail('dag-update-decision-receipt-digest-mismatch')
    }
    if (expectedRemoteMutationDigest !== undefined
        && receipt.expectedRemoteMutationDigest
        !== expectedRemoteMutationDigest) {
        fail('expected-remote-mutation-digest-mismatch')
    }
    validateDecisionDigests(receipt)
    validateDecisionMode(receipt)
    return receipt
}

export function summarizeDagUpdateTelemetry(receipts) {
    if (!Array.isArray(receipts)) fail('dag-update-telemetry-receipts-invalid')
    const summary = {
        projectionOnlyCount: 0,
        semanticPatchCount: 0,
        fullCreateCount: 0,
        fullRecoveryCount: 0,
        falsePositiveDagDispatchCount: 0,
        graphPatchOperationCount: 0
    }
    for (const receipt of receipts) {
        if ((receipt?.dagUpdateMode === 'none'
            || receipt?.dagUpdateMode === 'projection-only')
            && dispatchPresent(receipt)) {
            fail('false-positive-dag-dispatch')
        }
        verifyDagUpdateDecisionReceipt(receipt)
        switch (receipt.dagUpdateMode) {
            case 'projection-only':
                summary.projectionOnlyCount += 1
                break
            case 'semantic-patch':
                summary.semanticPatchCount += 1
                summary.graphPatchOperationCount +=
                    receipt.graphPatchOperationCount
                break
            case 'full-create':
                summary.fullCreateCount += 1
                break
            case 'full-recovery':
                summary.fullRecoveryCount += 1
                break
        }
    }
    return summary
}
