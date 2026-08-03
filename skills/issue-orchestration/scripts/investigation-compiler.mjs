import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(
    process.env.ISSUE_ORCHESTRATION_REPOSITORY_ROOT ?? process.cwd()
)

class InvestigationError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'InvestigationError'
        this.code = code
    }
}

function fail(code, message) {
    throw new InvestigationError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical).sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(
        (key) => [key, canonical(value[key])]
    ))
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function same(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function validDigest(value) {
    return /^[a-f0-9]{64}$/u.test(value ?? '')
}

function verifyRecord(record, schema, label) {
    if (!record || record.schema !== schema || record.status !== 'complete') {
        fail('invalid-investigation-layer', `${label} is incomplete.`)
    }
    const unsigned = { ...record }
    delete unsigned.digest
    if (record.digest !== digest(unsigned)) fail(
        'investigation-layer-digest-mismatch', `${label} digest is invalid.`
    )
}

function semanticActorValid(record) {
    const actor = record?.authoredBy
    return ['dag-creator', 'dag-updater'].includes(actor?.role)
        && actor.model === 'gpt-5.6-sol'
        && actor.effort === 'max'
        && actor.executionClass === 'observe-only'
        && actor.mutationContract === 'no-protected-mutation'
        && actor.freshContext === true
        && actor.proposalOnly === true
}

function validateDispatch(node, runtimeState) {
    const record = node.dispatchInvestigation
    if (!record) return
    if (record.schema !== 'issue-orchestration.dispatch-investigation.v1') {
        fail('legacy-investigation-schema-forbidden', 'Legacy investigation is forbidden.')
    }
    for (const group of ['nearestAgentsChain', 'codePaths', 'testPaths', 'currentDocs']) {
        if (!Array.isArray(record[group]) || record[group].length === 0) {
            fail('member-investigation-required', `${group} must contain member evidence.`)
        }
        for (const item of record[group]) {
            if (!item?.path || /(?:^|\/)(?:TODO|N\/A)(?:\/|$)/iu.test(item.path)) {
                fail('placeholder-path-forbidden', 'Placeholder paths are forbidden.')
            }
            if (!validDigest(item.digest)) {
                fail('member-investigation-required', `${group} lacks a digest.`)
            }
            if (!existsSync(resolve(repositoryRoot, item.path))) {
                fail('path-missing', `Evidence path does not exist: ${item.path}`)
            }
        }
    }
    if (record.runtimeProbes?.status === 'not-applicable'
        && !record.runtimeProbes.reasonCode?.trim()) {
        fail('invalid-not-applicable-reason', 'Not-applicable probes need a reason.')
    }
    if (record.status === 'blocked'
        && (!record.blockerOwner || !validDigest(record.blockerEvidenceDigest))) {
        fail('investigation-starvation-unowned', 'Blocked investigation needs an owner.')
    }
    if (record.confirmedOwner !== node.repository
        || !record.acceptanceMap?.every(({ issueId }) => issueId === node.id)
        || !validDigest(record.issueSpecificEvidenceDigest)) {
        fail('member-investigation-required', 'Dispatch evidence must be issue-specific.')
    }
    if (record.classificationFactsDigest !== node.classificationFacts.digest) {
        fail('member-investigation-required', 'Dispatch evidence belongs to another member.')
    }
    if (record.baseSha !== runtimeState.repositoryBases?.[node.repository]
        || record.deliveryEpoch !== runtimeState.deliveryEpoch) {
        fail('base-drift', 'Dispatch investigation is not bound to the live base.')
    }
    if (record.status === 'complete') verifyRecord(
        record, 'issue-orchestration.dispatch-investigation.v1', 'dispatchInvestigation'
    )
}

function priority(node) {
    const weights = {
        'long-wait': 0,
        'critical-path': 1,
        'high-priority': 2,
        'unlocks-ready-dependent': 3,
        'candidate-ready': 4
    }
    const reasons = [...new Set(node.classificationFacts.priorityReasons ?? [])].sort()
    return {
        rank: Math.min(...reasons.map((reason) => weights[reason] ?? 99)),
        reasons
    }
}

export function compileInvestigationProjection({
    selectorReceipt, dagProposal, runtimeState, computedAt
}) {
    if (!same(dagProposal.resolvedIssueSet, selectorReceipt.resolvedIssueSet)
        || dagProposal.selectorReceiptDigest !== selectorReceipt.receiptDigest
        || dagProposal.selectorDigest !== selectorReceipt.selectorDigest
        || dagProposal.remoteSnapshotDigest !== selectorReceipt.remoteSnapshotDigest) {
        fail('selector-receipt-mismatch', 'The DAG may not construct or rewrite scope.')
    }
    if (dagProposal.nodes.some((node) =>
        Object.prototype.hasOwnProperty.call(node, 'investigation'))) {
        fail('legacy-investigation-schema-forbidden', 'Layered investigation is required.')
    }
    const requested = runtimeState.requestedReinvestigationIssueIds ?? []
    if (requested.length === dagProposal.nodes.length && requested.length > 0) {
        fail('investigation-reuse-violated', 'Unchanged scope cannot be reinvestigated.')
    }
    const nodes = []
    const testOwnerCandidates = []
    const implementationReady = []
    const investigationQueue = []
    for (const node of dagProposal.nodes) {
        if (!semanticActorValid(node.discoveryFacts)) {
            fail('investigation-layer-authority', 'Discovery facts require a semantic DAG agent.')
        }
        verifyRecord(node.discoveryFacts,
            'issue-orchestration.discovery-facts.v1', 'discoveryFacts')
        if (node.classificationFacts && !semanticActorValid(node.classificationFacts)) {
            fail('investigation-layer-authority', 'Classification facts require a semantic DAG agent.')
        }
        if (node.classificationFacts) {
            verifyRecord(node.classificationFacts,
                'issue-orchestration.classification-facts.v1', 'classificationFacts')
        }
        validateDispatch(node, runtimeState)
        let phase = node.classificationFacts ? 'dependency-classified' : 'discovered'
        const reasons = []
        if (!node.classificationFacts) {
            reasons.push({ code: 'classification-incomplete' })
        }
        if (node.classificationFacts?.candidateReady) {
            phase = 'candidate-ready'
            testOwnerCandidates.push({ issueId: node.id, stage: 'test-contract-ready' })
        }
        if (node.dispatchInvestigation?.status === 'complete') {
            phase = 'dispatch-investigated'
            testOwnerCandidates.splice(
                testOwnerCandidates.findIndex(({ issueId }) => issueId === node.id), 1
            )
            implementationReady.push({ issueId: node.id, stage: 'implementation-ready' })
        }
        if (node.dispatchInvestigation?.status === 'blocked') {
            const waited = Date.parse(runtimeState.observedAt) -
                Date.parse(node.dispatchInvestigation.blockedSince)
            if (waited >= (runtimeState.starvationThresholdMs ?? Infinity)) {
                reasons.push({ code: 'investigation-starved' })
            }
        }
        const ranked = node.classificationFacts ? priority(node) : null
        if (node.classificationFacts?.candidateReady
            && node.dispatchInvestigation?.status !== 'complete') {
            investigationQueue.push({
                issueId: node.id,
                stage: 'dispatch-investigation',
                priorityReasons: ranked.reasons,
                priorityEvidenceDigest: digest({
                    issueId: node.id, priorityReasons: ranked.reasons
                }),
                rank: ranked.rank
            })
        }
        nodes.push({
            issueId: node.id,
            phase,
            reasons,
            blockerOwner: node.dispatchInvestigation?.blockerOwner ?? null,
            memberRemoteFactDigest: node.discoveryFacts.memberRemoteFactDigest
        })
    }
    investigationQueue.sort((a, b) => a.rank - b.rank
        || a.issueId.localeCompare(b.issueId))
    for (const entry of investigationQueue) delete entry.rank
    const projection = {
        schema: 'issue-orchestration.investigation-projection.v1',
        valid: true,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        nodes: nodes.sort((a, b) => a.issueId.localeCompare(b.issueId)),
        testOwnerCandidates: testOwnerCandidates.sort((a, b) =>
            a.issueId.localeCompare(b.issueId)),
        implementationReady: implementationReady.sort((a, b) =>
            a.issueId.localeCompare(b.issueId)),
        investigationQueue,
        computedAt
    }
    projection.inputDigest = digest({
        selectorReceiptDigest: projection.selectorReceiptDigest,
        nodes: dagProposal.nodes,
        runtimeState
    })
    projection.projectionDigest = digest(projection)
    return projection
}

export function validateInvestigationProjection(input) {
    const expected = compileInvestigationProjection({
        ...input,
        computedAt: input.recordedProjection.computedAt
    })
    if (JSON.stringify(expected) !== JSON.stringify(input.recordedProjection)) {
        fail('investigation-projection-mismatch', 'Projection is not canonical.')
    }
    return { valid: true }
}

export function evaluateInvestigationFreshness({
    selectorReceipt, dagProposal, runtimeState, previousProjection
}) {
    const byIssue = {}
    for (const node of dagProposal.nodes) {
        const old = previousProjection.nodes.find(({ issueId }) => issueId === node.id)
        const reasons = []
        const staleLayers = []
        const remoteDigest = selectorReceipt.remoteFactDigests?.[node.id]
        if (old?.memberRemoteFactDigest !== remoteDigest) {
            staleLayers.push('discoveryFacts', 'classificationFacts', 'dispatchInvestigation')
            reasons.push({ code: 'issue-facts-stale' })
        } else if (!old) {
            staleLayers.push('discoveryFacts', 'classificationFacts', 'dispatchInvestigation')
        } else if (node.dispatchInvestigation) {
            const dispatch = node.dispatchInvestigation
            if (dispatch.baseSha !== runtimeState.repositoryBases?.[node.repository]
                || dispatch.deliveryEpoch !== runtimeState.deliveryEpoch) {
                staleLayers.push('dispatchInvestigation')
                reasons.push({ code: 'base-drift' })
            } else {
                for (const item of dispatch.nearestAgentsChain ?? []) {
                    if (runtimeState.currentPathDigests?.[item.path] !== item.digest) {
                        staleLayers.push('dispatchInvestigation')
                        reasons.push({ code: 'instruction-drift' })
                        break
                    }
                }
                for (const item of dispatch.currentDocs ?? []) {
                    if (runtimeState.currentPathDigests?.[item.path] !== item.digest) {
                        if (!staleLayers.includes('dispatchInvestigation')) {
                            staleLayers.push('dispatchInvestigation')
                        }
                        reasons.push({ code: 'current-doc-drift' })
                        break
                    }
                }
                for (const item of dispatch.codePaths ?? []) {
                    if (runtimeState.currentPathDigests?.[item.path] !== item.digest) {
                        if (!staleLayers.includes('dispatchInvestigation')) {
                            staleLayers.push('dispatchInvestigation')
                        }
                        reasons.push({ code: 'owner-code-drift' })
                        break
                    }
                }
                for (const item of dispatch.testPaths ?? []) {
                    if (runtimeState.currentPathDigests?.[item.path] !== item.digest) {
                        if (!staleLayers.includes('dispatchInvestigation')) {
                            staleLayers.push('dispatchInvestigation')
                        }
                        reasons.push({ code: 'test-entry-drift' })
                        break
                    }
                }
            }
        }
        byIssue[node.id] = { staleLayers, reasons, reuse: staleLayers.length === 0 }
    }
    return { valid: true, byIssue }
}

export function authorizeInvestigationTransition({ transition, actor }) {
    if (transition.layer === 'dispatchInvestigation') {
        if (actor.role === 'dag-creator' || actor.role === 'dag-updater') {
            fail('dag-agent-dispatch-authority-forbidden', 'DAG agents own semantics only.')
        }
        if (actor.role !== 'test-owner') {
            fail('test-contract-disputed', 'Only the test owner can freeze dispatch evidence.')
        }
        if (actor.model !== 'gpt-5.6-sol' || actor.effort !== 'max'
            || actor.executionClass !== 'leased-writer'
            || actor.mutationContract !==
                'lease-and-slice-allowlist'
            || actor.writeScope !== 'tests-only') {
            fail('test-owner-runtime-identity', 'Test owner must run as Sol/max.')
        }
        return { valid: true }
    }
    if (transition.layer === 'discoveryFacts'
        || transition.layer === 'classificationFacts') {
        if (actor.role === 'test-owner') {
            fail('test-owner-semantic-authority-forbidden', 'Test owner cannot write semantics.')
        }
        if (!['dag-creator', 'dag-updater'].includes(actor.role)) {
            fail('investigation-transition-authority', 'Semantic transition is unauthorized.')
        }
        if (actor.model !== 'gpt-5.6-sol' || actor.effort !== 'max'
            || actor.executionClass !== 'observe-only'
            || actor.mutationContract !==
                'no-protected-mutation'
            || actor.freshContext !== true || actor.proposalOnly !== true) {
            fail('investigation-layer-authority', 'Semantic actor identity is invalid.')
        }
        return { valid: true }
    }
    fail('investigation-transition-authority', 'Transition is unauthorized.')
}

export function selectInvestigationActions({ projection, runtimeState }) {
    const slots = runtimeState.availableSlots ?? 0
    const dispatchCandidates = [
        ...(runtimeState.readyStageCandidates ?? []),
        ...projection.implementationReady
    ]
        .slice(0, slots)
    const remaining = Math.max(0, slots - dispatchCandidates.length)
    const investigationCandidates = projection.investigationQueue.slice(0, remaining)
    return {
        dispatchCandidates,
        investigationCandidates,
        availableSlotsAfterSelection:
            remaining - investigationCandidates.length
    }
}

export function validateInvestigationActions({
    projection, runtimeState, recordedActions
}) {
    const expected = selectInvestigationActions({ projection, runtimeState })
    if (!same(recordedActions.dispatchCandidates, expected.dispatchCandidates)) {
        fail('dispatch-work-conservation', 'Ready dispatch work cannot be suppressed.')
    }
    if (!same(recordedActions, expected)) {
        fail('investigation-actions-mismatch', 'Actions are not canonical.')
    }
    return { valid: true }
}

export function buildImplementationTask({
    selectorReceipt, node, dispatchInvestigation, runtimeState, implementer
}) {
    if (implementer.role !== 'code-implementer'
        || !dispatchInvestigation
        || dispatchInvestigation.status !== 'complete'
        || !dispatchInvestigation.promptInputs?.testCommands?.length
        || !dispatchInvestigation.promptInputs?.counterexamples?.length) {
        fail('test-contract-disputed', 'The test contract is incomplete.')
    }
    validateDispatch({ ...node, dispatchInvestigation }, runtimeState)
    const task = {
        schema: 'issue-orchestration.implementation-task.v1',
        issueId: node.id,
        baseSha: dispatchInvestigation.baseSha,
        worktree: dispatchInvestigation.worktree,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        memberRemoteFactDigest: dispatchInvestigation.memberRemoteFactDigest,
        testContractDigest: dispatchInvestigation.digest,
        confirmedOwner: dispatchInvestigation.confirmedOwner,
        allowedImplementationPaths: dispatchInvestigation.allowedImplementationPaths,
        forbiddenPaths: dispatchInvestigation.forbiddenPaths,
        codePaths: dispatchInvestigation.codePaths,
        testPaths: dispatchInvestigation.testPaths,
        currentDocs: dispatchInvestigation.currentDocs,
        implementationDecision: dispatchInvestigation.implementationDecision,
        acceptanceMap: dispatchInvestigation.acceptanceMap,
        testCommands: dispatchInvestigation.promptInputs.testCommands,
        counterexamples: dispatchInvestigation.promptInputs.counterexamples,
        runtimeProbes: dispatchInvestigation.runtimeProbes,
        mutationControls: dispatchInvestigation.mutationControls,
        failureClassification: dispatchInvestigation.promptInputs.failureClassification,
        stopConditions: dispatchInvestigation.promptInputs.stopConditions
        ,
        testOwnerId: dispatchInvestigation.testOwnerId,
        deliveryEpoch: dispatchInvestigation.deliveryEpoch,
        classificationFactsDigest: dispatchInvestigation.classificationFactsDigest,
        nearestAgentsChain: dispatchInvestigation.nearestAgentsChain,
        allowedTestPaths: dispatchInvestigation.allowedTestPaths,
        acceptanceGroup: dispatchInvestigation.acceptanceGroup,
        issueSpecificEvidenceDigest:
            dispatchInvestigation.issueSpecificEvidenceDigest
    }
    return { valid: true, task }
}
