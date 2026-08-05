import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    LIFECYCLE_STAGE_RESULT_SCHEMA,
    validateLifecycleStageResult
} from './lifecycle-stage-admission.mjs'

const SUPPORTED = Object.freeze({
    'dispatch-behavior-verifier': Object.freeze({
        contractId: 'behavior-verification',
        actorRole: 'test-owner',
        stagePhase: 'behavior-verification'
    }),
    'request-ui-adjudication': Object.freeze({
        contractId: 'ui-adjudication',
        actorRole: 'ui-system-adjudicator',
        stagePhase: 'adjudication'
    }),
    'dispatch-ux-acceptance-verifier': Object.freeze({
        contractId: 'ux-acceptance',
        actorRole: 'ux-acceptance-verifier',
        stagePhase: 'ux-acceptance'
    })
})
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

export class LifecycleObserveOnlyExecutorError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'LifecycleObserveOnlyExecutorError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecycleObserveOnlyExecutorError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) reject(code)
    return value
}

function hash(value, code) {
    if (!HASH.test(value ?? '')) reject(code)
    return value
}

function sha(value, code) {
    if (!SHA.test(value ?? '')) reject(code)
    return value
}

function clone(value) {
    return structuredClone(value)
}

function digestOf(value) {
    if (!value || typeof value !== 'object') return null
    for (const field of [
        'receiptDigest', 'proposalDigest', 'inventoryDigest',
        'contractDigest', 'workPlanDigest', 'sliceDigest',
        'promptDigest', 'routeDecisionDigest', 'bindingDigest',
        'snapshotDigest'
    ]) {
        if (HASH.test(value[field] ?? '')) return value[field]
    }
    return null
}

function stageFor(action) {
    const stage = SUPPORTED[action?.type]
    if (!stage) {
        reject('observe-only-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    return stage
}

function exactAction(action, actionSet) {
    object(action, 'observe-only-action-required')
    text(action.actionDigest, 'observe-only-action-digest-required')
    object(action.bindings, 'observe-only-action-bindings-required')
    stageFor(action)
    if (actionSet === null || actionSet === undefined) return action
    if (actionSet?.schema !== 'issue-orchestration.lifecycle-action-set.v1' ||
        !Array.isArray(actionSet.actions)) {
        reject('observe-only-action-set-invalid')
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        reject('observe-only-action-stale')
    }
    return action
}

function assertActorAdapter(adapter) {
    object(adapter, 'observe-only-actor-adapter-required')
    if (typeof adapter.prepare !== 'function' ||
        typeof adapter.invoke !== 'function') {
        reject('observe-only-actor-adapter-invalid')
    }
    return adapter
}

function assertRuntimeObserver(observer) {
    if (typeof observer !== 'function') {
        reject('observe-only-runtime-observer-required')
    }
    return observer
}

function assertSnapshotter(snapshotter) {
    if (typeof snapshotter !== 'function') {
        reject('observe-only-snapshotter-required')
    }
    return snapshotter
}

function assertMutationGuard(guard) {
    if (typeof guard !== 'function') {
        reject('observe-only-mutation-guard-required')
    }
    return guard
}

function assertRouteCompiler(compiler) {
    if (typeof compiler !== 'function') {
        reject('observe-only-route-compiler-required')
    }
    return compiler
}

function candidateReceipt(node) {
    const candidate = node?.receipts?.candidate
    if (!candidate?.evidence ||
        !SHA.test(candidate.evidence.candidateSha ?? '') ||
        !HASH.test(digestOf(candidate) ?? '') ||
        !/^[a-z0-9-]+$/u.test(
            candidate.evidence.writerInvocationId ?? ''
        )) {
        reject('observe-only-candidate-required')
    }
    return candidate
}

function acceptanceReceipt(node) {
    const acceptance = node?.receipts?.acceptanceContract
    if (!HASH.test(digestOf(acceptance) ?? '')) {
        reject('observe-only-acceptance-contract-required')
    }
    return acceptance
}

function uiAdjudicationReceipt(node) {
    const receipt = node?.receipts?.uiAdjudication
    if (!HASH.test(digestOf(receipt) ?? '')) {
        reject('observe-only-ui-adjudication-required')
    }
    return receipt
}

function validateRoute(route, stage, action) {
    object(route, 'observe-only-route-required')
    if (route.stageRole !== stage.actorRole ||
        route.stagePhase !== stage.stagePhase ||
        !HASH.test(route.routeDecisionDigest ?? '') ||
        route.actionDigest !== action.actionDigest ||
        route.observeOnly !== true) {
        reject('observe-only-route-invalid')
    }
    if (route.writeLeaseId !== null && route.writeLeaseId !== undefined) {
        reject('observe-only-route-write-authority')
    }
    return route
}

function validateRuntime(runtime, stage, action, node) {
    object(runtime, 'observe-only-runtime-required')
    if (runtime.stageRole !== stage.actorRole ||
        runtime.stagePhase !== stage.stagePhase ||
        runtime.executionClass !== 'observe-only' ||
        runtime.inheritedThreadId !== null ||
        runtime.freshInvocation !== true ||
        runtime.actorInvocationId ===
            node?.receipts?.candidate?.evidence?.writerInvocationId ||
        runtime.writerInvocationId ===
            node?.receipts?.candidate?.evidence?.writerInvocationId ||
        runtime.actionDigest !== action.actionDigest) {
        reject('observe-only-runtime-not-independent')
    }
    for (const field of [
        'actorInvocationId', 'actorSessionId', 'effectiveProfile',
        'effectiveModel', 'effectiveEffort', 'effectiveBackend',
        'effectivePermissionProfile'
    ]) text(runtime[field], 'observe-only-runtime-identity-required')
    hash(runtime.executionObservationDigest,
        'observe-only-runtime-observation-required')
    return runtime
}

function validateSnapshot(snapshot, kind, action, runtime) {
    object(snapshot, `observe-only-${kind}-snapshot-required`)
    if (snapshot.snapshotKind !== kind ||
        snapshot.actionDigest !== action.actionDigest ||
        snapshot.actorInvocationId !== runtime.actorInvocationId ||
        !HASH.test(snapshot.snapshotDigest ?? '')) {
        reject('observe-only-snapshot-invalid', { kind })
    }
    return snapshot
}

function validateMutation(postcondition, pre, post, action, runtime) {
    object(postcondition, 'observe-only-mutation-postcondition-required')
    if (postcondition.status !== 'verified' ||
        !Array.isArray(postcondition.violations) ||
        postcondition.violations.length !== 0 ||
        postcondition.preSnapshotDigest !== pre.snapshotDigest ||
        postcondition.postSnapshotDigest !== post.snapshotDigest ||
        postcondition.actorInvocationId !== runtime.actorInvocationId ||
        postcondition.actionDigest !== action.actionDigest ||
        !HASH.test(postcondition.observationDigest ?? '')) {
        reject('observe-only-mutation-detected')
    }
    return postcondition
}

function validateActorOutput(output, stage, action) {
    object(output, 'observe-only-actor-output-required')
    if (output.rootAuthored === true ||
        output.writerAuthored === true ||
        output.actorRole !== stage.actorRole ||
        output.stagePhase !== stage.stagePhase ||
        output.actionDigest !== action.actionDigest ||
        output.modifiedCandidate === true ||
        output.modifiedRepository === true ||
        output.modifiedAcceptance === true ||
        output.modifiedRouting === true) {
        reject('observe-only-actor-authority-invalid')
    }
    return output
}

function admissionBinding(action) {
    return {
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        bindings: clone(action.bindings)
    }
}

function sealArtifact({ action, contractId, kind, evidence }) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[contractId]
        ?.artifactSet?.[kind]
    if (!spec) reject('observe-only-artifact-contract-missing', { kind })
    const value = {
        schema: spec.schema,
        artifactKind: kind,
        status: 'verified',
        producerAuthority: spec.producerAuthority,
        validator: spec.validator,
        rootAuthored: false,
        actorAuthored: spec.actorAuthored,
        actionDigest: action.actionDigest,
        lifecycleBindingDigest: digest(admissionBinding(action)),
        evidence: clone(evidence),
        evidenceDigest: digest(evidence)
    }
    value[spec.digestField] = digest(value)
    return Object.freeze(value)
}

function sealResult({ action, stage, artifacts, attemptId }) {
    const result = {
        schema: LIFECYCLE_STAGE_RESULT_SCHEMA,
        producerAuthority: 'observe-only-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        actorRole: stage.actorRole,
        attemptId,
        artifacts: clone(artifacts),
        artifactsDigest: digest(artifacts)
    }
    result.resultDigest = digest(result)
    return Object.freeze(result)
}

function runtimeArtifactEvidence(runtime) {
    return {
        actorInvocationId: runtime.actorInvocationId,
        actorSessionId: runtime.actorSessionId,
        effectiveProfile: runtime.effectiveProfile,
        effectiveModel: runtime.effectiveModel,
        effectiveEffort: runtime.effectiveEffort,
        effectiveBackend: runtime.effectiveBackend,
        effectivePermissionProfile:
            runtime.effectivePermissionProfile,
        executionObservationDigest:
            runtime.executionObservationDigest
    }
}

function mutationArtifactEvidence(postcondition) {
    return {
        status: postcondition.status,
        violations: [...postcondition.violations],
        preSnapshotDigest: postcondition.preSnapshotDigest,
        postSnapshotDigest: postcondition.postSnapshotDigest,
        observationDigest: postcondition.observationDigest
    }
}

function buildBehaviorArtifacts({ action, node, runtime, mutation, output }) {
    const candidate = candidateReceipt(node)
    const evidence = object(output.behaviorEvidence,
        'observe-only-behavior-evidence-required')
    sha(evidence.candidateSha,
        'observe-only-behavior-candidate-required')
    if (evidence.candidateSha !== candidate.evidence.candidateSha ||
        evidence.verifierInvocationId !== runtime.actorInvocationId ||
        evidence.freshContext !== true ||
        evidence.independent !== true) {
        reject('observe-only-behavior-binding-invalid')
    }
    hash(evidence.commandEvidenceDigest,
        'observe-only-behavior-command-required')
    hash(evidence.frozenTestContractDigest,
        'observe-only-behavior-contract-required')
    const artifacts = {
        behavior: sealArtifact({
            action,
            contractId: 'behavior-verification',
            kind: 'behavior',
            evidence
        }),
        behaviorVerification: null,
        runtimeBinding: sealArtifact({
            action,
            contractId: 'behavior-verification',
            kind: 'runtimeBinding',
            evidence: runtimeArtifactEvidence(runtime)
        }),
        mutationPostcondition: sealArtifact({
            action,
            contractId: 'behavior-verification',
            kind: 'mutationPostcondition',
            evidence: mutationArtifactEvidence(mutation)
        })
    }
    artifacts.behaviorVerification = sealArtifact({
        action,
        contractId: 'behavior-verification',
        kind: 'behaviorVerification',
        evidence: {
            status: 'verified',
            behaviorReceiptDigest: artifacts.behavior.receiptDigest,
            candidateSha: evidence.candidateSha
        }
    })
    return artifacts
}

function buildUiArtifacts({ action, node, runtime, mutation, output }) {
    const candidate = candidateReceipt(node)
    const acceptance = acceptanceReceipt(node)
    const evidence = object(output.uiAdjudication,
        'observe-only-ui-adjudication-required')
    if (![
        'bounded-ui-contract-confirmed',
        'bounded-ui-contract-rejected',
        'human-decision-required'
    ].includes(evidence.adjudication)) {
        reject('observe-only-ui-adjudication-vocabulary')
    }
    if (evidence.candidateDigest !== digestOf(candidate) ||
        evidence.acceptanceContractDigest !== digestOf(acceptance) ||
        evidence.scopeEdited === true ||
        evidence.acceptanceEdited === true ||
        evidence.routingEdited === true) {
        reject('observe-only-ui-adjudication-binding-invalid')
    }
    return {
        uiAdjudication: sealArtifact({
            action,
            contractId: 'ui-adjudication',
            kind: 'uiAdjudication',
            evidence
        }),
        runtimeBinding: sealArtifact({
            action,
            contractId: 'ui-adjudication',
            kind: 'runtimeBinding',
            evidence: runtimeArtifactEvidence(runtime)
        }),
        mutationPostcondition: sealArtifact({
            action,
            contractId: 'ui-adjudication',
            kind: 'mutationPostcondition',
            evidence: mutationArtifactEvidence(mutation)
        })
    }
}

function buildUxArtifacts({ action, node, runtime, mutation, output }) {
    const candidate = candidateReceipt(node)
    const uiAdjudication = uiAdjudicationReceipt(node)
    const ux = object(output.uxAcceptance,
        'observe-only-ux-acceptance-required')
    const render = object(output.renderEvidence,
        'observe-only-ux-render-required')
    const interaction = object(output.interactionEvidence,
        'observe-only-ux-interaction-required')
    const accessibility = object(output.accessibilityEvidence,
        'observe-only-ux-accessibility-required')
    if (ux.candidateSha !== candidate.evidence.candidateSha ||
        ux.uiAdjudicationDigest !== digestOf(uiAdjudication) ||
        ux.status !== 'accepted') {
        reject('observe-only-ux-binding-invalid')
    }
    if (output.renderEvidence === 'observed' ||
        typeof output.renderEvidence === 'string') {
        reject('observe-only-ux-prose-render-claim')
    }
    hash(render.screenshotSetDigest,
        'observe-only-ux-screenshot-required')
    if (!Array.isArray(render.viewports) || render.viewports.length === 0) {
        reject('observe-only-ux-viewports-required')
    }
    hash(interaction.traceDigest,
        'observe-only-ux-trace-required')
    if (!Number.isInteger(interaction.assertionCount) ||
        interaction.assertionCount < 1) {
        reject('observe-only-ux-assertions-required')
    }
    hash(accessibility.auditDigest,
        'observe-only-ux-a11y-required')
    if (!Array.isArray(accessibility.violations) ||
        accessibility.violations.length !== 0) {
        reject('observe-only-ux-a11y-violations')
    }
    const artifacts = {
        uxAcceptance: null,
        renderEvidence: sealArtifact({
            action,
            contractId: 'ux-acceptance',
            kind: 'renderEvidence',
            evidence: render
        }),
        interactionEvidence: sealArtifact({
            action,
            contractId: 'ux-acceptance',
            kind: 'interactionEvidence',
            evidence: interaction
        }),
        accessibilityEvidence: sealArtifact({
            action,
            contractId: 'ux-acceptance',
            kind: 'accessibilityEvidence',
            evidence: accessibility
        }),
        runtimeBinding: sealArtifact({
            action,
            contractId: 'ux-acceptance',
            kind: 'runtimeBinding',
            evidence: runtimeArtifactEvidence(runtime)
        }),
        mutationPostcondition: sealArtifact({
            action,
            contractId: 'ux-acceptance',
            kind: 'mutationPostcondition',
            evidence: mutationArtifactEvidence(mutation)
        })
    }
    artifacts.uxAcceptance = sealArtifact({
        action,
        contractId: 'ux-acceptance',
        kind: 'uxAcceptance',
        evidence: {
            ...ux,
            renderEvidenceDigest:
                artifacts.renderEvidence.receiptDigest,
            interactionEvidenceDigest:
                artifacts.interactionEvidence.receiptDigest,
            accessibilityEvidenceDigest:
                artifacts.accessibilityEvidence.receiptDigest
        }
    })
    return artifacts
}

function boundedProjection({ action, stage, node, route }) {
    const candidate = candidateReceipt(node)
    const projection = {
        schema: 'issue-orchestration.observe-only-projection.v1',
        actionDigest: action.actionDigest,
        actionType: action.type,
        stageRole: stage.actorRole,
        stagePhase: stage.stagePhase,
        nodeId: action.nodeId ?? null,
        repository: action.bindings.repository ?? null,
        baseSha: action.bindings.baseSha ?? null,
        candidate: clone(candidate),
        routeDecisionDigest: route.routeDecisionDigest,
        fullIssueIncluded: false,
        fullDagIncluded: false,
        stateRootIncluded: false,
        rootAuthoredSummaryIncluded: false
    }
    if (action.type === 'request-ui-adjudication') {
        projection.acceptanceContract = clone(acceptanceReceipt(node))
    }
    if (action.type === 'dispatch-ux-acceptance-verifier') {
        projection.uiAdjudication = clone(uiAdjudicationReceipt(node))
    }
    projection.projectionDigest = digest(projection)
    return Object.freeze(projection)
}

export async function executeLifecycleObserveOnlyAction({
    action,
    actionSet = null,
    node,
    actorAdapter,
    compileRoute,
    observeRuntime,
    snapshot,
    evaluateMutation,
    observedAt = new Date(0).toISOString()
} = {}) {
    const stage = stageFor(action)
    exactAction(action, actionSet)
    const adapter = assertActorAdapter(actorAdapter)
    const routeCompiler = assertRouteCompiler(compileRoute)
    const runtimeObserver = assertRuntimeObserver(observeRuntime)
    const snapshotter = assertSnapshotter(snapshot)
    const mutationGuard = assertMutationGuard(evaluateMutation)
    candidateReceipt(node)

    const route = validateRoute(
        routeCompiler({ action: clone(action), node: clone(node), stage }),
        stage,
        action
    )
    const prepared = object(adapter.prepare({
        action: clone(action),
        node: clone(node),
        stage: clone(stage),
        routeDecision: clone(route),
        observedAt
    }), 'observe-only-preparation-invalid')
    if (prepared.writerConversationInherited === true ||
        prepared.writeLeaseAcquired === true ||
        prepared.candidateVisible !== true) {
        reject('observe-only-preparation-authority-invalid')
    }
    const runtime = validateRuntime(
        runtimeObserver({
            action: clone(action),
            node: clone(node),
            stage: clone(stage),
            routeDecision: clone(route),
            preparation: clone(prepared),
            observedAt
        }),
        stage,
        action,
        node
    )
    const pre = validateSnapshot(
        snapshot({
            action: clone(action),
            stage: clone(stage),
            runtime: clone(runtime),
            snapshotKind: 'pre',
            observedAt
        }),
        'pre',
        action,
        runtime
    )
    const projection = boundedProjection({ action, stage, node, route })
    const output = validateActorOutput(
        await adapter.invoke({
            action: clone(action),
            stage: clone(stage),
            routeDecision: clone(route),
            runtime: clone(runtime),
            projection: clone(projection),
            observedAt
        }),
        stage,
        action
    )
    const post = validateSnapshot(
        snapshot({
            action: clone(action),
            stage: clone(stage),
            runtime: clone(runtime),
            snapshotKind: 'post',
            observedAt
        }),
        'post',
        action,
        runtime
    )
    const mutation = validateMutation(
        mutationGuard({
            action: clone(action),
            stage: clone(stage),
            runtime: clone(runtime),
            preSnapshot: clone(pre),
            postSnapshot: clone(post),
            observedAt
        }),
        pre,
        post,
        action,
        runtime
    )
    const artifacts = action.type === 'dispatch-behavior-verifier'
        ? buildBehaviorArtifacts({ action, node, runtime, mutation, output })
        : action.type === 'request-ui-adjudication'
            ? buildUiArtifacts({ action, node, runtime, mutation, output })
            : buildUxArtifacts({ action, node, runtime, mutation, output })
    const result = sealResult({
        action,
        stage,
        artifacts,
        attemptId: prepared.attemptId ?? `${action.nodeId ?? 'node'}-${stage.stagePhase}`
    })
    const admission = validateLifecycleStageResult({
        result,
        action,
        node
    })
    return Object.freeze({
        result,
        admission,
        routeDecision: route,
        runtimeBinding: runtime,
        projection,
        preSnapshot: pre,
        postSnapshot: post,
        mutationPostcondition: mutation
    })
}

export const LIFECYCLE_OBSERVE_ONLY_SUPPORTED_ACTIONS = Object.freeze(
    Object.keys(SUPPORTED)
)
