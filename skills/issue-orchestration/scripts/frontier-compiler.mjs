import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import {
    compileExecutableSlice,
    validateCompiledDispatchPrompt
} from './executable-slice-compiler.mjs'

const REASON_ORDER = [
    'dependency-unsatisfied',
    'investigation-incomplete',
    'owner-unresolved',
    'base-drift',
    'scope-drift',
    'active-attempt',
    'terminal-unchanged',
    'executable-slice-missing',
    'runtime-capability-missing',
    'delivery-frozen',
    'exclusive-lease-held',
    'remote-facts-stale'
]

const STAGES = [
    ['testContract', 'test-contract-ready'],
    ['implementation', 'implementation-ready'],
    ['behavior', 'behavior-verification-ready'],
    ['uxAcceptance', 'ux-acceptance-ready'],
    ['documentation', 'documentation-ready'],
    ['delivery', 'delivery-ready'],
    ['cleanup', 'cleanup-ready']
]
const WRITER_READY_STAGES = new Set([
    'test-contract-ready',
    'implementation-ready',
    'documentation-ready',
    'landing-conflict-resolution-ready'
])

class FrontierError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'FrontierError'
        this.code = code
    }
}

function fail(code, message) {
    throw new FrontierError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value
            .map(canonical)
            .sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right))
            )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function orderedCanonical(value) {
    if (Array.isArray(value)) return value.map(orderedCanonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort()
            .map((key) => [key, orderedCanonical(value[key])])
    )
}

function orderedDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(orderedCanonical(value)))
        .digest('hex')
}

function evidence(identity, value) {
    return value === undefined
        ? { identity }
        : { identity, digest: digest(value) }
}

function landingConflictFor(runtimeState, issueId) {
    const records = runtimeState.landingConflictResolutions
    if (!records || typeof records !== 'object' || Array.isArray(records) ||
        !Object.prototype.hasOwnProperty.call(records, issueId)) {
        return null
    }
    return records[issueId]
}

function stageFor(node, state, runtimeState) {
    if (landingConflictFor(runtimeState, node.id) !== null) {
        return 'landing-conflict-resolution-ready'
    }
    const stages = node.surface === 'ui-ux'
        ? STAGES
        : STAGES.filter(([, stage]) => stage !== 'ux-acceptance-ready')
    for (const [receipt, stage] of stages) {
        if (state.receipts?.[receipt]?.status !== 'passed') return stage
    }
    return null
}

function expectedCandidate(node, stage, landingConflict = null) {
    if (stage === 'test-contract-ready') {
        return {
            role: 'test-owner',
            phase: 'test-contract',
            mode: 'write-tests-only',
            allowedPaths: node.allowedTestPaths,
            routeRequired: true,
            stageModelPoolPolicyVersion: 'stage-model-pool.v3'
        }
    }
    if (stage === 'implementation-ready') {
        return {
            role: node.surface === 'ui-ux'
                ? 'ui-ux-implementer'
                : 'code-implementer',
            phase: node.surface === 'ui-ux'
                ? 'ui-implementation'
                : 'implementation',
            mode: 'write-implementation-only',
            allowedPaths: node.allowedImplementationPaths,
            designAuthorityRequired: node.surface === 'ui-ux',
            routeRequired: true,
            stageModelPoolPolicyVersion: 'stage-model-pool.v3'
        }
    }
    if (stage === 'landing-conflict-resolution-ready') {
        const role = landingConflict?.memberWriterRole
        return {
            role,
            phase: 'landing-conflict-resolution',
            mode: 'write-implementation-only',
            allowedPaths: node.allowedImplementationPaths,
            designAuthorityRequired: role === 'ui-ux-implementer',
            routeRequired: true,
            stageModelPoolPolicyVersion: 'stage-model-pool.v3'
        }
    }
    if (stage === 'behavior-verification-ready') {
        return {
            role: 'test-owner',
            phase: 'behavior-verification',
            mode: 'read-execute-only',
            allowedPaths: [],
            routeRequired: true,
            stageModelPoolPolicyVersion: 'stage-model-pool.v3'
        }
    }
    if (stage === 'ux-acceptance-ready') {
        return {
            role: 'ux-acceptance-verifier',
            phase: 'ux-acceptance',
            mode: 'read-only',
            allowedPaths: [],
            designAuthorityRequired: true,
            routeRequired: true,
            stageModelPoolPolicyVersion: 'stage-model-pool.v3'
        }
    }
    if (stage === 'documentation-ready') {
        return {
            role: 'documentation-writer',
            phase: 'documentation',
            mode: 'write-docs-only',
            allowedPaths: [`docs/frontier-${node.issueNumber}.md`],
            routeRequired: true,
            stageModelPoolPolicyVersion: 'stage-model-pool.v3'
        }
    }
    return {
        role: 'root-scheduler',
        phase: 'scheduling',
        mode: 'root-only',
        allowedPaths: [],
        routeRequired: true,
        stageModelPoolPolicyVersion: 'stage-model-pool.v3'
    }
}

function candidateFor(runtimeState, issueId, stage) {
    return runtimeState.candidates?.find(
        (candidate) => candidate.issueId === issueId && candidate.stage === stage
    )
}

function writerStageProjectionFor(runtimeState, issueId) {
    const projection = runtimeState.writerStageProjection
    if (!projection || typeof projection !== 'object' ||
        Array.isArray(projection)) return null
    return Object.prototype.hasOwnProperty.call(projection, issueId)
        ? projection[issueId]
        : null
}

function writerSequenceBinding({
    candidate,
    runtimeState,
    stage
}) {
    if (!WRITER_READY_STAGES.has(stage)) return null
    const plan = candidate?.stageWorkPlan
    const slice = candidate?.executableSlice
    if (!plan || !slice ||
        plan.contractBindingStatus !== 'verified' ||
        plan.plannerBindingStatus !== 'verified' ||
        slice.contractBindingStatus !== 'verified' ||
        slice.plannerBindingStatus !== 'verified' ||
        !/^[a-f0-9]{64}$/u.test(plan.planDigest ?? '') ||
        !/^[a-f0-9]{64}$/u.test(slice.sliceDigest ?? '') ||
        typeof plan.stageAttemptId !== 'string' ||
        !plan.stageAttemptId ||
        !Array.isArray(plan.orderedSlices) ||
        !Array.isArray(slice.prerequisiteSliceIds)) {
        return null
    }
    const sliceIndex = plan.orderedSlices.findIndex(
        ({ sliceId }) => sliceId === slice.sliceId
    )
    if (sliceIndex < 0 ||
        JSON.stringify(slice.prerequisiteSliceIds) !== JSON.stringify(
            plan.sliceDependencyGraph?.[slice.sliceId]
        )) {
        return null
    }
    const projection = writerStageProjectionFor(
        runtimeState,
        plan.node
    )
    const samePlan = projection?.planDigest === plan.planDigest
    if (!samePlan) {
        const priorStageComplete = projection !== null &&
            projection?.status === 'completed' &&
            projection.stagePhase !== plan.stagePhase
        if (projection !== null && !priorStageComplete ||
            sliceIndex !== 0 ||
            slice.prerequisiteSliceIds.length !== 0) {
            return null
        }
        const binding = {
            schema:
                'issue-orchestration.writer-slice-sequence-binding.v1',
            source: 'initial-stage-plan',
            projectionStatus: null,
            planDigest: plan.planDigest,
            stageAttemptId: plan.stageAttemptId,
            stageRole: plan.stageRole,
            stagePhase: plan.stagePhase,
            sliceIndex,
            expectedNextSliceId: slice.sliceId,
            expectedNextSliceDigest: slice.sliceDigest,
            prerequisiteSliceIds: [],
            completedSliceReceiptDigests: [],
            writerStageProjectionDigest: projection === null
                ? null
                : orderedDigest(projection)
        }
        return {
            binding,
            bindingDigest: orderedDigest(binding)
        }
    }
    if (!projection || !['next-slice', 'retry-authorized'].includes(
        projection.status
    ) ||
        projection.node !== plan.node ||
        projection.runId !== plan.runId ||
        projection.repository !== plan.repository ||
        projection.issue !== plan.issue ||
        projection.baseSha !== plan.baseSha ||
        projection.epochId !== plan.epochId ||
        projection.worktreeIdentity !== plan.worktreeIdentity ||
        projection.stageRole !== plan.stageRole ||
        projection.stagePhase !== plan.stagePhase ||
        projection.stageAttemptId !== plan.stageAttemptId ||
        projection.expectedNextSliceId !== slice.sliceId ||
        projection.expectedNextSliceDigest !== slice.sliceDigest ||
        !Array.isArray(projection.completedSliceReceiptDigests) ||
        projection.completedSliceReceiptDigests.length !== sliceIndex ||
        projection.completedSliceReceiptDigests.some((value) =>
            !/^[a-f0-9]{64}$/u.test(value))) {
        return null
    }
    const binding = {
        schema: 'issue-orchestration.writer-slice-sequence-binding.v1',
        source: 'semantic-runtime-projection',
        projectionStatus: projection.status,
        planDigest: plan.planDigest,
        stageAttemptId: plan.stageAttemptId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        sliceIndex,
        expectedNextSliceId: slice.sliceId,
        expectedNextSliceDigest: slice.sliceDigest,
        prerequisiteSliceIds: [...slice.prerequisiteSliceIds],
        completedSliceReceiptDigests:
            [...projection.completedSliceReceiptDigests],
        writerStageProjectionDigest: orderedDigest(projection)
    }
    return {
        binding,
        bindingDigest: orderedDigest(binding)
    }
}

function candidateValid(node, candidate, stage, landingConflict = null) {
    if (!candidate) return false
    const expected = expectedCandidate(node, stage, landingConflict)
    for (const field of ['role', 'model', 'effort', 'mode']) {
        if (expected[field] !== undefined &&
            candidate[field] !== expected[field]) return false
    }
    if (JSON.stringify(canonical(candidate.allowedPaths ?? []))
        !== JSON.stringify(canonical(expected.allowedPaths ?? []))) return false
    if (expected.designAuthorityRequired) {
        if (!/^[a-f0-9]{64}$/u.test(candidate.designSkillDigest ?? '')) return false
        if (!Array.isArray(candidate.designAuthorityDigests)
            || candidate.designAuthorityDigests.length === 0
            || candidate.designAuthorityDigests.some(
                (value) => !/^[a-f0-9]{64}$/u.test(value)
            )) return false
    }
    return /^[a-f0-9]{64}$/u.test(candidate.capabilityReceiptDigest ?? '')
}

function pathAllowed(candidate, allowedPaths = []) {
    return allowedPaths.some((pattern) => {
        if (pattern.endsWith('/**')) {
            const root = pattern.slice(0, -3)
            return candidate === root ||
                candidate.startsWith(`${root}/`)
        }
        return candidate === pattern ||
            candidate.startsWith(`${pattern.replace(/\/$/u, '')}/`)
    })
}

function landingConflictBindingValid(node, candidate, conflict) {
    if (!conflict || typeof conflict !== 'object' ||
        conflict.schema !==
            'issue-orchestration.landing-conflict-resolution.v1' ||
        conflict.status !== 'active' ||
        conflict.node !== node.id ||
        conflict.baseSha !== node.baseSha ||
        conflict.conflictSource !== 'delivery-failure-receipt' ||
        !/^[a-f0-9]{64}$/u.test(conflict.conflictSourceDigest ?? '') ||
        !/^[a-f0-9]{64}$/u.test(
            conflict.deliveryFailureReceiptDigest ?? ''
        ) ||
        !/^[a-f0-9]{64}$/u.test(conflict.conflictMappingDigest ?? '') ||
        typeof conflict.epochId !== 'string' || !conflict.epochId ||
        typeof conflict.worktreeIdentity !== 'string' ||
        !conflict.worktreeIdentity ||
        !Array.isArray(conflict.conflictPaths) ||
        conflict.conflictPaths.length === 0 ||
        conflict.conflictPaths.some((entry) =>
            typeof entry !== 'string' || !entry ||
            entry.startsWith('/') ||
            /(^|\/)\.\.(\/|$)/u.test(entry) ||
            entry.includes('\\')) ||
        new Set(conflict.conflictPaths).size !==
            conflict.conflictPaths.length ||
        !['code-implementer', 'ui-ux-implementer'].includes(
            conflict.memberWriterRole
        ) ||
        conflict.memberWriterRole !== (node.surface === 'ui-ux'
            ? 'ui-ux-implementer'
            : 'code-implementer') ||
        conflict.resolutionDigest !== digest(
            without(conflict, 'resolutionDigest')
        )) {
        return false
    }
    const plan = candidate?.stageWorkPlan
    const slice = candidate?.executableSlice
    const requiredEvidence = new Set(slice?.requiredEvidence ?? [])
    return candidate?.landingConflictResolutionDigest ===
            conflict.resolutionDigest &&
        plan?.stageRole === conflict.memberWriterRole &&
        plan?.epochId === conflict.epochId &&
        plan?.worktreeIdentity === conflict.worktreeIdentity &&
        conflict.conflictPaths.every((entry) =>
            (slice?.firstReadTargets ?? []).includes(entry) &&
            pathAllowed(entry, slice?.allowedPaths)) &&
        requiredEvidence.has(
            `landing-conflict-source:${conflict.conflictSourceDigest}`
        ) &&
        requiredEvidence.has(
            `delivery-failure-receipt:${conflict.deliveryFailureReceiptDigest}`
        ) &&
        requiredEvidence.has(
            `landing-conflict-mapping:${conflict.conflictMappingDigest}`
        )
}

function writerSliceBindingValid(
    node,
    candidate,
    stage,
    landingConflict = null,
    runtimeState = {}
) {
    if (!WRITER_READY_STAGES.has(stage)) return true
    if (!candidate ||
        !/^[a-f0-9]{64}$/u.test(candidate.planDigest ?? '') ||
        !/^[a-f0-9]{64}$/u.test(candidate.sliceDigest ?? '') ||
        !/^[a-f0-9]{64}$/u.test(candidate.compiledPromptDigest ?? '')) {
        return false
    }
    const plan = candidate.stageWorkPlan
    const slice = candidate.executableSlice
    const compiled = candidate.compiledPrompt
    try {
        const expected = compileExecutableSlice({
            plan,
            sliceId: slice?.sliceId
        })
        const expectedPhase = stage === 'test-contract-ready'
            ? 'test-contract'
            : stage === 'documentation-ready'
                ? 'documentation'
                : stage === 'landing-conflict-resolution-ready'
                    ? 'landing-conflict-resolution'
                : node.surface === 'ui-ux'
                    ? 'ui-implementation'
                    : 'implementation'
        return candidate.planDigest === plan.planDigest &&
            candidate.sliceDigest === expected.sliceDigest &&
            slice?.sliceDigest === expected.sliceDigest &&
            candidate.compiledPromptDigest === compiled?.promptDigest &&
            plan.contractBindingStatus === 'verified' &&
            plan.plannerBindingStatus === 'verified' &&
            slice.contractBindingStatus === 'verified' &&
            slice.plannerBindingStatus === 'verified' &&
            plan.node === node.id &&
            plan.repository === node.repository &&
            plan.baseSha === node.baseSha &&
            plan.stagePhase === expectedPhase &&
            (stage !== 'landing-conflict-resolution-ready' ||
                landingConflictBindingValid(
                    node,
                    candidate,
                    landingConflict
                )) &&
            writerSequenceBinding({
                candidate,
                runtimeState,
                stage
            }) !== null &&
            validateCompiledDispatchPrompt({
                plan,
                slice: expected,
                compiled
            }).length === 0
    } catch {
        return false
    }
}

function dependencySatisfied(dependency) {
    return dependency.remoteState === 'CLOSED'
        && dependency.stateReason === 'completed'
        && /^[a-f0-9]{64}$/u.test(dependency.evidenceDigest ?? '')
        && /^[a-f0-9]{40}$/u.test(dependency.deliveredCommit ?? '')
}

function without(record, ...keys) {
    return Object.fromEntries(
        Object.entries(record ?? {}).filter(([key]) => !keys.includes(key))
    )
}

function validateLayerDigest(record) {
    return record?.digest === digest(without(record, 'digest'))
}

function validateSemanticActor(record) {
    const actor = record?.authoredBy
    return actor?.role === 'dag-creator-updater'
        && typeof actor.actorId === 'string'
        && actor.actorId.length > 0
        && actor.model === 'gpt-5.6-sol'
        && actor.effort === 'max'
        && actor.sandboxMode === 'read-only'
        && actor.freshContext === true
        && actor.proposalOnly === true
}

function validateTestOwnerActor(record) {
    const actor = record?.authoredBy
    return actor?.role === 'test-owner'
        && typeof actor.actorId === 'string'
        && actor.actorId.length > 0
        && actor.model === 'gpt-5.6-sol'
        && actor.effort === 'max'
        && actor.mode === 'write-tests-only'
        && record.testOwnerId === actor.actorId
}

function validateInvestigationProjection({
    dag,
    runtimeState,
    selectorReceipt,
    investigationProjection
}) {
    if ((dag.nodes ?? []).some((node) =>
        Object.prototype.hasOwnProperty.call(node, 'investigation')
    )) {
        fail('legacy-investigation-schema-forbidden', 'Legacy investigation authority is forbidden.')
    }
    if (!investigationProjection?.validation
        || investigationProjection.validation.status !== 'passed') {
        fail('investigation-projection-unvalidated', 'Investigation projection is unvalidated.')
    }
    if (investigationProjection.schema !== 'issue-orchestration.investigation-projection.v1') {
        fail('investigation-projection-schema', 'Investigation projection schema is unsupported.')
    }
    const validation = investigationProjection.validation
    if (validation.schema !== 'issue-orchestration.investigation-validation-receipt.v1'
        || validation.validator?.role !== 'layered-investigation-validator'
        || validation.validator?.model !== 'machine'
        || validation.validator?.mode !== 'read-only') {
        fail('investigation-validation-authority', 'Investigation validation authority is invalid.')
    }
    const projectionNodes = investigationProjection.nodes ?? []
    if (new Set(projectionNodes.map(({ issueId }) => issueId)).size
        !== projectionNodes.length) {
        fail('investigation-projection-member-duplicate', 'Projection repeats a member.')
    }
    const expectedTestOwnerCandidates = projectionNodes
        .filter(({ phase }) => phase === 'candidate-ready')
        .map(({ issueId }) => ({ issueId, stage: 'test-contract-ready' }))
    const expectedImplementationReady = projectionNodes
        .filter(({ phase }) => phase === 'dispatch-investigated')
        .map(({ issueId }) => ({ issueId, stage: 'implementation-ready' }))
    if (JSON.stringify(canonical(investigationProjection.testOwnerCandidates))
            !== JSON.stringify(canonical(expectedTestOwnerCandidates))
        || JSON.stringify(canonical(investigationProjection.implementationReady))
            !== JSON.stringify(canonical(expectedImplementationReady))) {
        fail(
            'investigation-projection-derived-list-mismatch',
            'Projection derived candidate lists do not match member phases.'
        )
    }
    const projectionBody = without(investigationProjection, 'validation', 'projectionDigest')
    if (investigationProjection.projectionDigest !== digest(projectionBody)
        || investigationProjection.inputDigest !== digest({
            selectorReceiptDigest: investigationProjection.selectorReceiptDigest,
            remoteSnapshotDigest: investigationProjection.remoteSnapshotDigest,
            nodes: investigationProjection.nodes
        })) {
        fail('investigation-projection-digest-mismatch', 'Investigation projection digest mismatch.')
    }
    if (validation.receiptDigest !== digest(without(validation, 'receiptDigest'))
        || validation.projectionDigest !== investigationProjection.projectionDigest
        || validation.projectionInputDigest !== investigationProjection.inputDigest) {
        fail('investigation-projection-digest-mismatch', 'Validation receipt binding mismatch.')
    }
    if (investigationProjection.selectorReceiptDigest !== selectorReceipt.receiptDigest
        || validation.selectorReceiptDigest !== selectorReceipt.receiptDigest
        || investigationProjection.remoteSnapshotDigest !== selectorReceipt.remoteSnapshotDigest
        || validation.remoteSnapshotDigest !== selectorReceipt.remoteSnapshotDigest) {
        fail('selector-receipt-mismatch', 'Investigation projection is selector-stale.')
    }
    const freshness = validation.freshness
    if (freshness?.status !== 'current'
        || freshness.selectorReceiptDigest !== selectorReceipt.receiptDigest
        || freshness.remoteSnapshotDigest !== selectorReceipt.remoteSnapshotDigest) {
        fail('investigation-projection-stale', 'Investigation projection is not current.')
    }

    const projectedById = new Map(
        (investigationProjection.nodes ?? []).map((entry) => [entry.issueId, entry])
    )
    if (projectedById.size !== (dag.nodes ?? []).length) {
        fail('investigation-projection-digest-mismatch', 'Projection node coverage is incomplete.')
    }
    for (const node of dag.nodes ?? []) {
        const discovery = node.discoveryFacts
        const classification = node.classificationFacts
        const dispatch = node.dispatchInvestigation
        if (discovery?.schema !== 'issue-orchestration.discovery-facts.v1'
            || classification?.schema !== 'issue-orchestration.classification-facts.v1'
            || (dispatch && dispatch.schema !== 'issue-orchestration.dispatch-investigation.v1')) {
            fail('investigation-layer-schema', `Layer schema mismatch for ${node.id}.`)
        }
        if (discovery.status !== 'complete'
            || classification.status !== 'complete'
            || (dispatch && dispatch.status !== 'complete')) {
            fail('investigation-layer-status', `Layer status mismatch for ${node.id}.`)
        }
        if (!validateLayerDigest(discovery) || !validateLayerDigest(classification)
            || (dispatch && !validateLayerDigest(dispatch))) {
            fail('investigation-layer-digest-mismatch', `Layer digest mismatch for ${node.id}.`)
        }
        if (!validateSemanticActor(discovery)
            || !validateSemanticActor(classification)
            || discovery.authoredBy.actorId.startsWith('root-scheduler')
            || classification.authoredBy.actorId.startsWith('root-scheduler')
            || discovery.authoredBy.actorId !== classification.authoredBy.actorId
            || (dispatch && (
                !validateTestOwnerActor(dispatch)
                || dispatch.testOwnerId
                    !== runtimeState.nodeStates?.[node.id]?.receipts?.testContract?.testOwnerId
            ))) {
            fail('investigation-layer-authority', `Invalid layered authority for ${node.id}.`)
        }
        const expectedDiscoveryInputDigest = digest({
            selectorDigest: selectorReceipt.selectorDigest,
            issueId: node.id,
            memberRemoteFactDigest: selectorReceipt.remoteFactDigests?.[node.id]
        })
        if (discovery.inputDigest !== expectedDiscoveryInputDigest) {
            fail(
                'investigation-layer-input-digest-mismatch',
                `Discovery input digest mismatch for ${node.id}.`
            )
        }
        if (classification.discoveryFactsDigest !== discovery.digest
            || (dispatch && dispatch.classificationFactsDigest !== classification.digest)) {
            fail('investigation-layer-digest-mismatch', `Layer chain mismatch for ${node.id}.`)
        }
        if (discovery.selectorReceiptDigest !== selectorReceipt.receiptDigest
            || (dispatch && dispatch.selectorReceiptDigest !== selectorReceipt.receiptDigest)) {
            fail('selector-receipt-mismatch', `Selector binding mismatch for ${node.id}.`)
        }
        const remoteDigest = selectorReceipt.remoteFactDigests?.[node.id]
        if (discovery.memberRemoteFactDigest !== remoteDigest
            || freshness.memberRemoteFactDigests?.[node.id] !== remoteDigest
            || (dispatch && dispatch.memberRemoteFactDigest !== remoteDigest)) {
            fail('issue-facts-stale', `Issue facts are stale for ${node.id}.`)
        }
        if (dispatch && dispatch.baseSha !== node.baseSha) {
            fail('base-drift', `Dispatch investigation base drift for ${node.id}.`)
        }
        const phase = dispatch?.status === 'complete'
            ? 'dispatch-investigated'
            : classification.candidateReady
                ? 'candidate-ready'
                : 'dependency-classified'
        const expected = {
            issueId: node.id,
            phase,
            discoveryFactsDigest: discovery.digest,
            classificationFactsDigest: classification.digest,
            dispatchInvestigationDigest: dispatch?.digest ?? null,
            selectorReceiptDigest: discovery.selectorReceiptDigest,
            memberRemoteFactDigest: discovery.memberRemoteFactDigest,
            baseSha: dispatch?.baseSha ?? node.baseSha,
            blockedSince: classification.blockedSince ?? dispatch?.blockedSince ?? null,
            blockerOwner: classification.blockerOwner ?? dispatch?.blockerOwner ?? null
        }
        if (JSON.stringify(canonical(projectedById.get(node.id)))
            !== JSON.stringify(canonical(expected))) {
            fail('investigation-projection-digest-mismatch', `Projection binding mismatch for ${node.id}.`)
        }
    }
}

export function computeNodeEligibility({
    node,
    dag,
    runtimeState,
    selectorReceipt,
    investigationProjection
}) {
    const state = runtimeState.nodeStates?.[node.id] ?? { receipts: {}, terminal: null }
    const stage = stageFor(node, state, runtimeState)
    if (!stage) return { issueId: node.id, stage: null, ready: false, reasons: [] }

    const reasons = []
    const activeDependencies = node.activeDependencies ?? []
    const invalidTombstones = (node.satisfiedDependencies ?? [])
        .filter((dependency) => !dependencySatisfied(dependency))
    if (activeDependencies.length > 0 || invalidTombstones.length > 0) {
        reasons.push({
            code: 'dependency-unsatisfied',
            evidence: evidence(
                [...activeDependencies, ...invalidTombstones.map(({ issue }) => issue)]
                    .sort().join(','),
                { activeDependencies, invalidTombstones }
            )
        })
    }
    const investigationPhase = investigationProjection?.nodes?.find(
        ({ issueId }) => issueId === node.id
    )?.phase
    const investigationComplete = stage === 'test-contract-ready'
        ? investigationPhase === 'candidate-ready'
            || investigationPhase === 'dispatch-investigated'
        : investigationPhase === 'dispatch-investigated'
    if (!investigationComplete) {
        reasons.push({
            code: 'investigation-incomplete',
            evidence: evidence(
                node.id,
                { phase: investigationPhase ?? null, requiredStage: stage }
            )
        })
    }
    if (!node.ownerRepository) {
        reasons.push({
            code: 'owner-unresolved',
            evidence: evidence(node.id, { ownerRepository: null })
        })
    }
    const liveBase = runtimeState.repositoryBases?.[node.repository]
    if (liveBase !== node.baseSha) {
        reasons.push({
            code: 'base-drift',
            evidence: evidence(node.repository, { recorded: node.baseSha, live: liveBase })
        })
    }
    if (node.selectorReceiptDigest !== selectorReceipt.receiptDigest
        || node.remoteFactDigest !== selectorReceipt.remoteFactDigests?.[node.id]) {
        reasons.push({
            code: 'scope-drift',
            evidence: evidence(node.id, {
                nodeSelectorReceiptDigest: node.selectorReceiptDigest,
                selectorReceiptDigest: selectorReceipt.receiptDigest,
                nodeRemoteFactDigest: node.remoteFactDigest,
                remoteFactDigest: selectorReceipt.remoteFactDigests?.[node.id]
            })
        })
    }
    const attempts = (runtimeState.activeAttempts ?? []).filter(
        (attempt) => attempt.issueId === node.id && attempt.stage === stage
    )
    if (attempts.length > 0) {
        reasons.push({
            code: 'active-attempt',
            evidence: evidence(attempts[0].attemptId, attempts)
        })
    }
    const terminal = state.terminal
    if (terminal
        && terminal.recoveryFingerprint === terminal.observedRecoveryFingerprint) {
        reasons.push({
            code: 'terminal-unchanged',
            evidence: evidence(terminal.recoveryFingerprint, terminal)
        })
    }
    const candidate = candidateFor(runtimeState, node.id, stage)
    const landingConflict = landingConflictFor(runtimeState, node.id)
    if (!writerSliceBindingValid(
        node,
        candidate,
        stage,
        landingConflict,
        runtimeState
    )) {
        reasons.push({
            code: 'executable-slice-missing',
            evidence: evidence(`${node.id}@${stage}`, {
                planDigest: candidate?.planDigest ?? null,
                sliceDigest: candidate?.sliceDigest ?? null,
                compiledPromptDigest:
                    candidate?.compiledPromptDigest ?? null
            })
        })
    }
    if (!candidateValid(node, candidate, stage, landingConflict)) {
        reasons.push({
            code: 'runtime-capability-missing',
            evidence: evidence(`${node.id}@${stage}`, {
                candidate,
                expected: expectedCandidate(node, stage, landingConflict)
            })
        })
    }
    const freezes = (runtimeState.deliveryFreezes ?? []).filter(
        (freeze) => freeze.issueIds?.includes(node.id)
    )
    if (freezes.length > 0) {
        reasons.push({
            code: 'delivery-frozen',
            evidence: evidence(freezes[0].freezeId, freezes)
        })
    }
    const leases = (runtimeState.exclusiveLeases ?? []).filter(
        (lease) => lease.issueId === node.id
    )
    if (leases.length > 0) {
        reasons.push({
            code: 'exclusive-lease-held',
            evidence: evidence(leases[0].leaseId, leases)
        })
    }
    if (runtimeState.remoteFacts?.fresh !== true) {
        reasons.push({
            code: 'remote-facts-stale',
            evidence: evidence(
                runtimeState.remoteFacts?.selectorReceiptDigest ?? node.id,
                runtimeState.remoteFacts ?? null
            )
        })
    }
    reasons.sort(
        (left, right) => REASON_ORDER.indexOf(left.code) - REASON_ORDER.indexOf(right.code)
    )
    return { issueId: node.id, stage, ready: reasons.length === 0, reasons }
}

function eligibilityInputs({ dag, runtimeState, selectorReceipt, investigationProjection }) {
    return {
        selectorReceipt,
        investigationProjection,
        dag: {
            schema: dag.schema,
            selectorReceiptDigest: dag.selectorReceiptDigest,
            remoteSnapshotDigest: dag.remoteSnapshotDigest,
            nodes: (dag.nodes ?? []).map((node) => {
                const { narration, status, ...semantic } = node
                return semantic
            })
        },
        runtimeState
    }
}

export function compileReadyFrontier({
    dag,
    runtimeState,
    selectorReceipt,
    investigationProjection,
    computedAt = new Date().toISOString()
}) {
    const selected = [...(selectorReceipt.resolvedIssueSet ?? [])].sort()
    const nodes = [...(dag.nodes ?? [])].sort((left, right) => left.id.localeCompare(right.id))
    if (JSON.stringify(selected) !== JSON.stringify(nodes.map(({ id }) => id).sort())) {
        fail('frontier-scope-incomplete', 'DAG nodes do not exactly cover the selector receipt.')
    }
    validateInvestigationProjection({
        dag,
        runtimeState,
        selectorReceipt,
        investigationProjection
    })
    const outcomes = nodes.map((node) =>
        computeNodeEligibility({
            node,
            dag,
            runtimeState,
            selectorReceipt,
            investigationProjection
        })
    )
    const readyFrontier = outcomes
        .filter(({ ready }) => ready)
        .map(({ issueId, stage }) => ({ issueId, stage }))
        .sort((left, right) =>
            `${left.issueId}@${left.stage}`.localeCompare(`${right.issueId}@${right.stage}`)
        )
    const notReadyReasons = Object.fromEntries(
        outcomes
            .filter(({ reasons }) => reasons.length > 0)
            .map(({ issueId, reasons }) => [issueId, reasons])
    )
    const executionProjection = readyFrontier.map(({ issueId, stage }) => {
        const candidate = candidateFor(runtimeState, issueId, stage)
        const sequence = writerSequenceBinding({
            candidate,
            runtimeState,
            stage
        })
        return {
            issueId,
            stage,
            candidateCapabilityReceiptDigest:
                candidate?.capabilityReceiptDigest,
            planDigest: candidate?.planDigest ?? null,
            sliceDigest: candidate?.sliceDigest ?? null,
            compiledPromptDigest:
                candidate?.compiledPromptDigest ?? null,
            writerSequenceBinding: sequence?.binding ?? null,
            writerSequenceBindingDigest:
                sequence?.bindingDigest ?? null,
            landingConflictResolutionDigest:
                stage === 'landing-conflict-resolution-ready'
                    ? landingConflictFor(runtimeState, issueId)
                        ?.resolutionDigest ?? null
                    : null
        }
    })
    const eligibilityInputDigest = digest(
        eligibilityInputs({ dag, runtimeState, selectorReceipt, investigationProjection })
    )
    const frontierDigest = digest({
        eligibilityInputDigest,
        readyFrontier,
        notReadyReasons,
        executionProjection
    })
    return {
        schema: 'issue-orchestration.frontier-projection.v1',
        computedAt,
        eligibilityInputDigest,
        frontierDigest,
        readyFrontier,
        notReadyReasons,
        executionProjection
    }
}

export function validateReadyFrontier({
    dag,
    runtimeState,
    selectorReceipt,
    investigationProjection,
    recordedProjection
}) {
    const expected = compileReadyFrontier({
        dag,
        runtimeState,
        selectorReceipt,
        investigationProjection
    })
    if (recordedProjection?.eligibilityInputDigest !== expected.eligibilityInputDigest) {
        return { valid: false, code: 'frontier-input-digest-mismatch' }
    }
    if (recordedProjection?.frontierDigest !== expected.frontierDigest) {
        const projectionMatches = JSON.stringify(canonical({
            readyFrontier: recordedProjection?.readyFrontier,
            notReadyReasons: recordedProjection?.notReadyReasons,
            executionProjection: recordedProjection?.executionProjection
        })) === JSON.stringify(canonical({
            readyFrontier: expected.readyFrontier,
            notReadyReasons: expected.notReadyReasons,
            executionProjection: expected.executionProjection
        }))
        return {
            valid: false,
            code: projectionMatches
                ? 'frontier-digest-mismatch'
                : 'frontier-projection-mismatch'
        }
    }
    const projectionMatches = JSON.stringify(canonical({
        readyFrontier: recordedProjection.readyFrontier,
        notReadyReasons: recordedProjection.notReadyReasons,
        executionProjection: recordedProjection.executionProjection
    })) === JSON.stringify(canonical({
        readyFrontier: expected.readyFrontier,
        notReadyReasons: expected.notReadyReasons,
        executionProjection: expected.executionProjection
    }))
    return projectionMatches
        ? { valid: true }
        : { valid: false, code: 'frontier-projection-mismatch' }
}

export function selectDispatchCandidates({ projection, runtimeState }) {
    if (runtimeState.rootOnlyDeliveryAction) {
        return {
            dispatchCandidates: [],
            noDispatchReason: {
                code: 'root-only-delivery-action',
                evidence: evidence(runtimeState.rootOnlyDeliveryAction.actionId)
            }
        }
    }
    const availableSlots = Math.max(0, runtimeState.availableSlots ?? 0)
    return {
        dispatchCandidates: projection.readyFrontier.slice(0, availableSlots),
        noDispatchReason: null
    }
}

export function validateDispatchCandidates({
    projection,
    runtimeState,
    groupProposals,
    recordedCandidateSet
}) {
    const expected = selectDispatchCandidates({ projection, runtimeState, groupProposals })
    const actual = recordedCandidateSet?.dispatchCandidates
    if (!Array.isArray(actual)) {
        return { valid: false, code: 'dispatch-candidate-mismatch' }
    }
    if (expected.dispatchCandidates.length > 0 && actual.length === 0) {
        return { valid: false, code: 'dispatch-work-conservation' }
    }
    if (actual.length < expected.dispatchCandidates.length) {
        return { valid: false, code: 'dispatch-maximality' }
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected.dispatchCandidates)
        || JSON.stringify(recordedCandidateSet.noDispatchReason)
            !== JSON.stringify(expected.noDispatchReason)) {
        return { valid: false, code: 'dispatch-candidate-mismatch' }
    }
    return { valid: true }
}
