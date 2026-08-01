import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import fs from 'node:fs'
import path from 'node:path'

const REMOTE_MUTATION_POLICY = Object.freeze(JSON.parse(fs.readFileSync(
    path.resolve(
        import.meta.dirname,
        '../../../policy/remote-mutation-policy.json'
    ),
    'utf8'
)))
if (REMOTE_MUTATION_POLICY.schema
        !== 'issue-orchestration.remote-mutation-policy.v1'
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

const SEMANTIC_GRAPH_SCHEMA = 'issue-orchestration.semantic-graph.v1'
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
    inputs: ['immutable-runtime-ledger.v1', 'semantic-graph.v1', 'runtime-facts.v1'],
    outputs: [
        'completed',
        'ready-and-blocked',
        'critical-path',
        'conflicts',
        'slots-and-leases',
        'next-executable-frontier'
    ]
})

const SHA256 = /^[a-f0-9]{64}$/u
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

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
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

function normalizeNode(node) {
    requireObject(node, 'semantic-graph-node-invalid')
    requireString(node.id, 'semantic-graph-node-id-invalid')
    requireString(node.owner, 'semantic-graph-node-owner-invalid')
    requireString(node.riskClass, 'semantic-graph-node-risk-class-invalid')
    requireString(node.uiClass, 'semantic-graph-node-ui-class-invalid')
    requireSha(node.contractDigest, 'semantic-graph-node-contract-digest-invalid')
    if (node.acceptanceGroup !== null
        && typeof node.acceptanceGroup !== 'string') {
        fail('semantic-graph-node-acceptance-group-invalid')
    }
    return {
        id: node.id,
        owner: node.owner,
        dependencyKeys: uniqueSorted(node.dependencyKeys),
        conflictKeys: uniqueSorted(node.conflictKeys),
        riskClass: node.riskClass,
        uiClass: node.uiClass,
        acceptanceGroup: node.acceptanceGroup ?? null,
        contractDigest: node.contractDigest
    }
}

function semanticGraphUnsigned({ scopeDigest, semanticGraphInputDigest, nodes }) {
    return {
        schema: SEMANTIC_GRAPH_SCHEMA,
        scopeDigest,
        semanticGraphInputDigest,
        nodes: nodes.map(normalizeNode).sort((left, right) =>
            left.id.localeCompare(right.id)
        )
    }
}

function validateSemanticGraph(graph) {
    requireObject(graph, 'semantic-graph-invalid')
    if (graph.schema !== SEMANTIC_GRAPH_SCHEMA) {
        fail('semantic-graph-schema-invalid')
    }
    for (const field of [
        'active',
        'availableSlots',
        'blocked',
        'candidateCommits',
        'cleanup',
        'completed',
        'deliveryCommits',
        'epochId',
        'leases',
        'readyFrontier',
        'runtimeProjectionDigest'
    ]) {
        if (Object.hasOwn(graph, field)) {
            fail('semantic-graph-runtime-field-forbidden')
        }
    }
    requireSha(graph.scopeDigest, 'semantic-graph-scope-digest-invalid')
    requireSha(
        graph.semanticGraphInputDigest,
        'semantic-graph-input-digest-invalid'
    )
    requireSha(graph.semanticGraphDigest, 'semantic-graph-digest-invalid')
    if (!Array.isArray(graph.nodes)) fail('semantic-graph-nodes-invalid')
    const unsigned = semanticGraphUnsigned(graph)
    const ids = unsigned.nodes.map(({ id }) => id)
    if (new Set(ids).size !== ids.length) fail('semantic-graph-node-duplicate')
    if (digest(unsigned) !== graph.semanticGraphDigest) {
        fail('semantic-graph-digest-mismatch')
    }
    if (!sameValue(unsigned.nodes, graph.nodes)) {
        fail('semantic-graph-not-canonical')
    }
    return graph
}

export function createSemanticGraph({
    nodes,
    scopeDigest,
    semanticGraphInputDigest
}) {
    requireSha(scopeDigest, 'semantic-graph-scope-digest-invalid')
    requireSha(
        semanticGraphInputDigest,
        'semantic-graph-input-digest-invalid'
    )
    if (!Array.isArray(nodes)) fail('semantic-graph-nodes-invalid')
    const graph = semanticGraphUnsigned({
        nodes,
        scopeDigest,
        semanticGraphInputDigest
    })
    const ids = graph.nodes.map(({ id }) => id)
    if (new Set(ids).size !== ids.length) fail('semantic-graph-node-duplicate')
    graph.semanticGraphDigest = digest(graph)
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

export function projectRuntime({ semanticGraph, ledger, runtime }) {
    validateSemanticGraph(semanticGraph)
    requireObject(ledger, 'runtime-projector-ledger-invalid')
    if (ledger.schema !== 'issue-orchestration.immutable-runtime-ledger.v1') {
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
        candidateCommits: canonical(runtime.candidateCommits ?? {}),
        deliveryCommits: canonical(runtime.deliveryCommits ?? {}),
        cleanup: canonical(runtime.cleanup ?? {})
    }
    projection.runtimeProjectionDigest = digest(projection)
    return projection
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
    if (author.actorRole !== 'dag-creator-updater'
        || typeof author.actorId !== 'string'
        || author.sandboxMode !== 'read-only'
        || author.freshContext !== true
        || author.acceptedWithoutModification !== true) {
        fail('graph-patch-authority')
    }
}

function mutableGraph(graph) {
    return {
        scopeDigest: graph.scopeDigest,
        semanticGraphInputDigest: graph.semanticGraphInputDigest,
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
                mutable.nodes.push(normalizeNode(operation.node))
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
