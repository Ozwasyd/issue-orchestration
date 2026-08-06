import fs from 'node:fs'

import {
    digest,
    sameValue,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    compileCanonicalRoute,
    validateExecutionRouteDecision
} from './execution-route-compiler.mjs'
import {
    compileRuntimeExecutionBinding,
    validateRuntimeExecutionBinding
} from './runtime-execution-binding.mjs'
import {
    captureStageMutationSnapshot,
    evaluateStageMutationPostcondition,
    validateStageMutationPostconditionReceipt
} from './stage-runtime-guard.mjs'
import {
    compileColdStartIssueSnapshot,
    compileNodeDiscoveredReceipt,
    compileTestContractPlanningRequest,
    compileTestContractPlanningBundle,
    verifyTestContractPlanningBundle
} from './test-contract-cold-start.mjs'
import {
    compileRequirementInventory,
    compileIssueAcceptanceContract
} from './issue-requirement-authority.mjs'
import {
    compileSlicePlanValidation,
    verifySlicePlanValidation
} from './slice-plan-validator.mjs'
import {
    compilePreWriterStageWorkPlan,
    validatePreWriterStageWorkPlan,
    compileExecutableSlice,
    validatePreWriterExecutableSlice,
    compileDispatchPrompt,
    validatePreWriterCompiledDispatchPrompt
} from './executable-slice-compiler.mjs'
import {
    createResourceRegistry
} from './resource-lifecycle.mjs'
import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    LIFECYCLE_STAGE_RESULT_SCHEMA,
    validateLifecycleStageResult
} from './lifecycle-stage-admission.mjs'
import {
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    repositoryAuthorityFor,
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'
import {
    validateActorContextEnvelopeBinding
} from './actor-context-envelope.mjs'
import {
    compileActorPromptBundle,
    validateActorPromptBundleBinding,
    sanitizeProviderPromptCacheMetadata
} from './actor-prompt-cache-identity.mjs'

const SUPPORTED = new Set([
    'request-semantic-proposal',
    'compile-acceptance-contract',
    'request-test-contract-planning'
])
const HASH = /^[a-f0-9]{64}$/u
const RECEIPT_DIGEST_FIELDS = Object.freeze([
    'receiptDigest', 'proposalDigest', 'inventoryDigest',
    'contractDigest', 'workPlanDigest', 'planDigest',
    'sliceDigest', 'promptDigest', 'routeDecisionDigest',
    'bindingDigest', 'snapshotDigest', 'validationDigest',
    'bundleDigest'
])

export class LifecyclePreWriterExecutorError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecyclePreWriterExecutorError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecyclePreWriterExecutorError(code, code, details)
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

function exactAction({ action, actionSet }) {
    if (!SUPPORTED.has(action?.type)) {
        reject('prewriter-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    try {
        validateLifecycleActionSet(actionSet)
    } catch (error) {
        reject('prewriter-action-set-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        reject('prewriter-action-stale')
    }
    return action
}


function validateContextAuthority(context, action) {
    let authority
    let repositoryAuthority
    try {
        authority = validateLifecycleRunAuthority(
            context.lifecycleAuthority,
            {
                startup: context.startup,
                expectedRunId: action.bindings.runId,
                expectedStateRoot: context.stateRootPath
            }
        )
        repositoryAuthority = repositoryAuthorityFor(
            authority,
            action.bindings.repository
        )
    } catch (error) {
        reject('prewriter-lifecycle-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const binding = authority.binding
    const expected = {
        lifecycleAuthorityBindingDigest: binding.bindingDigest,
        startupAttestationDigest: binding.startupAttestationDigest,
        runtimeInvocationId: binding.runtimeInvocationId,
        runtimeSessionId: binding.runtimeSessionId,
        rootAuthorityEpoch: binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest: binding.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest: binding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest: binding.repositoryBindingSetDigest,
        packageDigest: binding.packageDigest,
        manifestDigest: binding.manifestDigest,
        policySetDigest: binding.policySetDigest,
        runtimeCapabilityBindingDigest:
            binding.runtimeCapabilityBindingDigest,
        repositoryBindingDigest: repositoryAuthority.bindingDigest
    }
    for (const [field, value] of Object.entries(expected)) {
        if (action.bindings[field] !== value) {
            reject('prewriter-action-authority-stale', { field })
        }
    }
    if (context.runtimeTrustBinding?.bindingDigest !==
            authority.runtimeTrustBinding.bindingDigest ||
        !sameValue(
            context.repositoryTargets,
            authority.repositoryTargets
        ) ||
        fs.realpathSync(context.repositoryPath) !==
            repositoryAuthority.canonicalPath ||
        action.bindings.baseSha !==
            repositoryAuthority.observedDefaultBranchHead) {
        reject('prewriter-runtime-authority-stale')
    }
    return authority
}

function admissionBinding(action) {
    return {
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        bindings: structuredClone(action.bindings)
    }
}

function sealArtifact({ action, contractId, kind, evidence }) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[contractId]
        ?.artifactSet?.[kind]
    if (!spec) reject('prewriter-artifact-contract-missing', { kind })
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
        evidence: structuredClone(evidence),
        evidenceDigest: digest(evidence)
    }
    value[spec.digestField] = digest(value)
    return Object.freeze(value)
}

function artifactDigest(contractId, artifacts, kind) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[contractId]
        .artifactSet[kind]
    return artifacts[kind][spec.digestField]
}

function sealResult({ action, actorRole, attemptId, artifacts }) {
    const result = {
        schema: LIFECYCLE_STAGE_RESULT_SCHEMA,
        producerAuthority: 'pre-writer-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        actorRole,
        attemptId,
        artifacts: structuredClone(artifacts),
        artifactsDigest: digest(artifacts)
    }
    result.resultDigest = digest(result)
    return Object.freeze(result)
}

function compileStageRoute({
    action,
    role,
    phase,
    routingClassification,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    actorAdapter,
    boundedProjection,
    actorContextEnvelope,
    actorContextProgressiveReader,
    actorPromptOptions,
    recordActorPromptCacheMetadata
}) {
    object(actorAdapter, 'prewriter-actor-adapter-required')
    if (typeof actorAdapter.prepare !== 'function' ||
        typeof actorAdapter.invoke !== 'function') {
        reject('prewriter-actor-adapter-invalid')
    }
    const envelope = actorContextEnvelope === undefined
        ? null
        : validateActorContextEnvelopeBinding(actorContextEnvelope, {
            action,
            role,
            phase
        })
    const pending = compileCanonicalRoute({
        ...routingClassification,
        stageRole: role,
        stagePhase: phase
    })
    const pendingDecision = pending.executionRouteDecision
    const promptBundle = envelope
        ? compileActorPromptBundle({
            actorContextEnvelope: envelope,
            routeDecision: pendingDecision,
            tokenizerIdentity: actorPromptOptions?.tokenizerIdentity ?? null,
            runtimeIdentity: actorPromptOptions?.runtimeIdentity ?? null
        })
        : null
    const prepared = object(actorAdapter.prepare({
        action: structuredClone(action),
        stageRole: role,
        stagePhase: phase,
        routeDecision: structuredClone(pendingDecision),
        boundedProjection: structuredClone(boundedProjection),
        ...(envelope ? { actorContextEnvelope: structuredClone(envelope) } : {}),
        ...(actorContextProgressiveReader ? {
            resolveActorContextReference: actorContextProgressiveReader
        } : {}),
        ...(promptBundle ? {
            actorPrompt: promptBundle.completePrompt,
            actorPromptStablePrefix: structuredClone(
                promptBundle.stablePrefix
            ),
            actorPromptVolatileSuffix: structuredClone(
                promptBundle.volatileSuffix
            ),
            actorPromptCacheIdentity: structuredClone(
                promptBundle.cacheIdentity
            )
        } : {})
    }), 'prewriter-actor-preparation-invalid')
    if (promptBundle && typeof recordActorPromptCacheMetadata === 'function') {
        recordActorPromptCacheMetadata({
            promptBundle,
            providerMetadata: sanitizeProviderPromptCacheMetadata(
                prepared.promptCacheMetadata ?? null
            )
        })
    }
    const runtimeBinding = compileRuntimeExecutionBinding({
        stageRole: role,
        stagePhase: phase,
        selectedProfile: pendingDecision.selectedProfile,
        routeDecisionDigest: pendingDecision.routeDecisionDigest,
        runtimeObservation: prepared.runtimeObservation,
        startup,
        runtimeTrustBinding,
        repositoryTargets
    })
    const finalBundle = compileCanonicalRoute({
        ...routingClassification,
        stageRole: role,
        stagePhase: phase,
        startup,
        runtimeTrustBinding,
        repositoryTargets,
        runtimeExecutionBinding: runtimeBinding,
        runtimeCapabilityObservation:
            prepared.runtimeCapabilityObservation
    })
    const routeDecision = finalBundle.executionRouteDecision
    validateExecutionRouteDecision(routeDecision, {
        stageRole: role,
        stagePhase: phase
    })
    validateRuntimeExecutionBinding(runtimeBinding, {
        stageRole: role,
        stagePhase: phase,
        selectedProfile: routeDecision.selectedProfile,
        routeDecisionDigest: pendingDecision.routeDecisionDigest,
        startup,
        runtimeTrustBinding,
        repositoryTargets
    })
    if (routeDecision.executionClass !== 'observe-only' ||
        runtimeBinding.executionClass !== 'observe-only' ||
        runtimeBinding.actorInvocationId ===
            startup.attestation.runtimeInvocationId ||
        runtimeBinding.actorSessionId ===
            startup.attestation.runtimeSessionId) {
        reject('prewriter-fresh-observe-only-runtime-required')
    }
    return {
        prepared, actorPromptBundle: promptBundle, runtimeBinding,
        pendingRouteDecision: pendingDecision, routeDecision
    }
}

function mutationIdentity({
    action,
    routeDecision,
    runtimeBinding,
    repositoryPath,
    stateRootPath,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    requestDigest,
    snapshotKind,
    capturedAt
}) {
    return {
        snapshotKind,
        capturedAt,
        runId: action.bindings.runId,
        actorInvocationId: runtimeBinding.actorInvocationId,
        actorSessionId: runtimeBinding.actorSessionId,
        attemptId: `${action.type}:${action.bindings.nodeEpoch}`,
        stageRole: routeDecision.stageRole,
        stagePhase: routeDecision.stagePhase,
        runtimeExecutionBinding: runtimeBinding,
        startup,
        runtimeTrustBinding,
        repositoryTargets,
        routeDecisionDigest: routeDecision.routeDecisionDigest,
        compiledPromptDigest: requestDigest,
        repository: action.bindings.repository,
        repositoryPath,
        stateRootPath,
        resourceIdentityDigest: action.bindings.repositoryBindingDigest,
        baseSha: action.bindings.baseSha,
        deliveryEpoch: `epoch-prewriter-${action.bindings.nodeEpoch}`,
        candidateIdentity: 'none',
        leaseDigest: null,
        sliceDigest: null,
        allowedPaths: [],
        remoteSnapshotDigest: action.bindings.remoteSnapshotDigest
    }
}

function invokeObservedActor({
    action,
    actorAdapter,
    prepared,
    routeDecision,
    runtimeBinding,
    request,
    repositoryPath,
    stateRootPath,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    outputClass = 'proposal',
    actorContextEnvelope = null,
    actorContextProgressiveReader = null,
    actorPromptBundle = null,
    pendingRouteDecision = null
}) {
    const requestDigest = digest(request)
    const promptBundle = actorPromptBundle
        ? validateActorPromptBundleBinding(actorPromptBundle, {
            actorContextEnvelope,
            routeDecision: pendingRouteDecision,
            role: routeDecision.stageRole,
            phase: routeDecision.stagePhase,
            actionDigest: action.actionDigest
        })
        : null
    const preSnapshot = captureStageMutationSnapshot(mutationIdentity({
        action,
        routeDecision,
        runtimeBinding,
        repositoryPath,
        stateRootPath,
        startup,
        runtimeTrustBinding,
        repositoryTargets,
        requestDigest,
        snapshotKind: 'pre-dispatch',
        capturedAt: new Date().toISOString()
    }))
    const payload = object(actorAdapter.invoke({
        preparation: prepared.preparation,
        action: structuredClone(action),
        routeDecision: structuredClone(routeDecision),
        runtimeExecutionBinding: structuredClone(runtimeBinding),
        request: structuredClone(request),
        ...(actorContextEnvelope ? {
            actorContextEnvelope: structuredClone(actorContextEnvelope)
        } : {}),
        ...(actorContextProgressiveReader ? {
            resolveActorContextReference: actorContextProgressiveReader
        } : {}),
        ...(promptBundle ? {
            actorPrompt: promptBundle.completePrompt,
            actorPromptCacheIdentity: structuredClone(
                promptBundle.cacheIdentity
            )
        } : {})
    }), 'prewriter-actor-output-invalid')
    const postSnapshot = captureStageMutationSnapshot(mutationIdentity({
        action,
        routeDecision,
        runtimeBinding,
        repositoryPath,
        stateRootPath,
        startup,
        runtimeTrustBinding,
        repositoryTargets,
        requestDigest,
        snapshotKind: 'post-execution',
        capturedAt: new Date().toISOString()
    }))
    const postcondition = evaluateStageMutationPostcondition({
        preSnapshot,
        postSnapshot,
        outputClass,
        output: payload,
        prohibitedReceiptEmitted: false,
        attributionStatus: 'verified'
    })
    validateStageMutationPostconditionReceipt(postcondition, {
        runtimeExecutionBindingDigest: runtimeBinding.bindingDigest,
        resultDigest: digest(payload)
    })
    return { payload, preSnapshot, postSnapshot, postcondition }
}

function runtimeArtifact(action, contractId, runtimeBinding) {
    return sealArtifact({
        action,
        contractId,
        kind: 'runtimeBinding',
        evidence: {
            actorInvocationId: runtimeBinding.actorInvocationId,
            actorSessionId: runtimeBinding.actorSessionId,
            effectiveProfile: runtimeBinding.selectedProfile,
            effectiveModel: runtimeBinding.effectiveModel,
            effectiveEffort: runtimeBinding.effectiveEffort,
            effectiveBackend:
                runtimeBinding.effectiveMultiAgentBackend,
            effectivePermissionProfile:
                runtimeBinding.effectivePermissionProfile,
            executionObservationDigest:
                runtimeBinding.runtimeObservationDigest,
            binding: structuredClone(runtimeBinding)
        }
    })
}

function mutationArtifact(action, contractId, postcondition) {
    return sealArtifact({
        action,
        contractId,
        kind: 'mutationPostcondition',
        evidence: {
            status: postcondition.status,
            violations: [...postcondition.violationCodes],
            preSnapshotDigest: postcondition.preSnapshotDigest,
            postSnapshotDigest: postcondition.postSnapshotDigest,
            observationDigest: digest(postcondition),
            receipt: structuredClone(postcondition)
        }
    })
}

function verifiedReceiptDigest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    for (const field of RECEIPT_DIGEST_FIELDS) {
        if (!HASH.test(value[field] ?? '')) continue
        if (unsignedDigest(value, field) !== value[field]) {
            reject('prewriter-node-receipt-invalid', { field })
        }
        return value[field]
    }
    reject('prewriter-node-receipt-digest-missing')
}

function nodeReceiptDigests(receipts = {}) {
    return Object.fromEntries(Object.entries(receipts)
        .filter(([, value]) => value && typeof value === 'object')
        .map(([key, value]) => [key, verifiedReceiptDigest(value)])
        .sort(([left], [right]) => left.localeCompare(right)))
}

function requireNode(action, node) {
    object(node, 'prewriter-node-required')
    if (node.id !== action.nodeId ||
        node.repository !== action.bindings.repository ||
        node.issueNumber !== action.bindings.issueNumber ||
        node.chainVersion !== action.bindings.nodeEpoch ||
        node.lifecycleState !== action.lifecycleState ||
        !sameValue(
            nodeReceiptDigests(node.receipts),
            action.bindings.receiptDigests
        )) {
        reject('prewriter-node-stale')
    }
    return node
}

function semanticAction(context) {
    const { action, node, inputs } = context
    requireNode(action, node)
    const snapshot = compileColdStartIssueSnapshot({
        issue: inputs.issue,
        selectorReceipt: inputs.selectorReceipt
    })
    const boundedProjection = {
        schema: 'issue-orchestration.semantic-proposal-request.v1',
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteSnapshotDigest: snapshot.remoteSnapshotDigest,
        sourceCoverageDigest: snapshot.sourceCoverageDigest,
        normativeBlocks: structuredClone(snapshot.normativeBlocks),
        fullDagIncluded: false,
        stateRootIncluded: false
    }
    const route = compileStageRoute({
        ...context,
        role: 'dag-creator-updater',
        phase: 'semantic-proposal',
        boundedProjection
    })
    const observed = invokeObservedActor({
        ...context,
        ...route,
        request: boundedProjection
    })
    const proposal = object(
        observed.payload.semanticProposal,
        'prewriter-semantic-proposal-required'
    )
    let validationInventory
    try {
        validationInventory = compileRequirementInventory({
            snapshot,
            proposal,
            rootDecision: {
                action: 'accept',
                proposalDigest: proposal.proposalDigest,
                modified: false
            }
        })
    } catch (error) {
        reject('prewriter-semantic-proposal-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const contractId = 'semantic-proposal'
    const artifacts = {}
    artifacts.runtimeBinding = runtimeArtifact(
        action,
        contractId,
        route.runtimeBinding
    )
    artifacts.semanticProposal = sealArtifact({
        action,
        contractId,
        kind: 'semanticProposal',
        evidence: {
            classifications: proposal.classifications.map((entry) =>
                `${entry.sourceIdentity}:${entry.classification}`),
            sourceFingerprint: snapshot.issueSnapshotFingerprint,
            runtimeExecutionBindingDigest:
                artifactDigest(contractId, artifacts, 'runtimeBinding'),
            proposal: structuredClone(proposal),
            snapshot: structuredClone(snapshot)
        }
    })
    artifacts.semanticProposalValidation = sealArtifact({
        action,
        contractId,
        kind: 'semanticProposalValidation',
        evidence: {
            proposalDigest: artifactDigest(
                contractId,
                artifacts,
                'semanticProposal'
            ),
            sourceFingerprint: snapshot.issueSnapshotFingerprint,
            status: 'verified',
            validationInventoryDigest:
                validationInventory.inventoryDigest
        }
    })
    artifacts.mutationPostcondition = mutationArtifact(
        action,
        contractId,
        observed.postcondition
    )
    const result = sealResult({
        action,
        actorRole: 'dag-creator-updater',
        attemptId: `${action.type}:${action.bindings.nodeEpoch}`,
        artifacts
    })
    validateLifecycleStageResult({ result, action, node })
    return result
}

function acceptanceAction(context) {
    const { action, node } = context
    requireNode(action, node)
    const semantic = node.receipts?.semanticProposal?.evidence
    const snapshot = semantic?.snapshot
    const proposal = semantic?.proposal
    if (!snapshot || !proposal) {
        reject('prewriter-semantic-history-required')
    }
    const inventory = compileRequirementInventory({
        snapshot,
        proposal,
        rootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        }
    })
    const acceptanceContract = compileIssueAcceptanceContract({
        snapshot,
        inventory
    })
    const nodeDiscovered = compileNodeDiscoveredReceipt({
        runId: action.bindings.runId,
        nodeId: action.nodeId,
        nodeEpoch: action.bindings.nodeEpoch,
        snapshot,
        semanticProposal: proposal,
        inventory,
        acceptanceContract
    })
    const required = acceptanceContract.executableAcceptanceIds.length > 0 ||
        acceptanceContract.constraintIds.length > 0
    const documentation = seal({
        schema: 'issue-orchestration.completion-evidence.v1',
        status: 'verified',
        producerAuthority: 'deterministic-acceptance-compiler',
        rootAuthored: false,
        acceptanceContractDigest: acceptanceContract.contractDigest,
        required
    }, 'receiptDigest')
    const contractId = 'acceptance-contract'
    const artifacts = {}
    artifacts.requirementInventory = sealArtifact({
        action,
        contractId,
        kind: 'requirementInventory',
        evidence: {
            requirementIds: inventory.requirements.map((item) =>
                item.requirementId),
            sourceCoverageDigest: inventory.sourceCoverageDigest,
            semanticProposalDigest:
                node.receipts.semanticProposal.proposalDigest,
            inventory: structuredClone(inventory)
        }
    })
    artifacts.acceptanceContract = sealArtifact({
        action,
        contractId,
        kind: 'acceptanceContract',
        evidence: {
            acceptanceIds: [
                ...acceptanceContract.executableAcceptanceIds
            ],
            requirementInventoryDigest: artifactDigest(
                contractId,
                artifacts,
                'requirementInventory'
            ),
            sourceCoverageDigest: inventory.sourceCoverageDigest,
            acceptanceContract: structuredClone(acceptanceContract)
        }
    })
    artifacts.nodeDiscovered = sealArtifact({
        action,
        contractId,
        kind: 'nodeDiscovered',
        evidence: {
            semanticProposalDigest:
                node.receipts.semanticProposal.proposalDigest,
            requirementInventoryDigest: artifactDigest(
                contractId,
                artifacts,
                'requirementInventory'
            ),
            acceptanceContractDigest: artifactDigest(
                contractId,
                artifacts,
                'acceptanceContract'
            ),
            receipt: structuredClone(nodeDiscovered)
        }
    })
    artifacts.documentationRequirement = sealArtifact({
        action,
        contractId,
        kind: 'documentationRequirement',
        evidence: {
            required,
            acceptanceContractDigest: artifactDigest(
                contractId,
                artifacts,
                'acceptanceContract'
            ),
            receipt: documentation
        }
    })
    const result = sealResult({
        action,
        actorRole: 'acceptance-contract-compiler',
        attemptId: null,
        artifacts
    })
    validateLifecycleStageResult({ result, action, node })
    return result
}

function planningResource({ action, attemptId, runtimeBinding, testContractDigest }) {
    const resourceId = `planning:${runtimeBinding.actorInvocationId}`
    const registry = createResourceRegistry({
        schema: 'issue-orchestration.resource-registry.v1',
        runId: action.bindings.runId,
        issueId: action.nodeId,
        stageAttemptId: attemptId,
        stageRole: 'test-owner',
        issueWorktreeId: `observe-only:${action.nodeId}`,
        baseSha: action.bindings.baseSha,
        epochId: `epoch-prewriter-${action.bindings.nodeEpoch}`,
        allowedPathsDigest: digest([]),
        testContractDigest,
        resources: [{
            resourceId,
            resourceType: 'process-group',
            ownerClass: 'observe-only-invocation',
            ownerRunId: action.bindings.runId,
            ownerAttemptId: attemptId,
            state: 'removed-clean'
        }]
    })
    return {
        registry,
        resourceId,
        resourceIdentityDigest: digest(registry),
        leaseDigest: digest({
            resourceId,
            attemptId,
            mode: 'observe-only-no-write-lease'
        })
    }
}

function planningAction(context) {
    const { action, node, inputs } = context
    requireNode(action, node)
    const acceptanceEvidence = node.receipts?.acceptanceContract?.evidence
    const discoveredEvidence = node.receipts?.nodeDiscovered?.evidence
    const acceptanceContract = acceptanceEvidence?.acceptanceContract
    const nodeDiscovered = discoveredEvidence?.receipt
    const snapshot = node.receipts?.semanticProposal?.evidence?.snapshot
    if (!acceptanceContract || !nodeDiscovered || !snapshot) {
        reject('prewriter-acceptance-history-required')
    }
    const attemptId = text(
        inputs.attemptId,
        'prewriter-planning-attempt-required'
    )
    const boundedProjection = {
        schema: 'issue-orchestration.test-contract-planning-projection.v1',
        repository: action.bindings.repository,
        issueNumber: action.bindings.issueNumber,
        nodeId: action.nodeId,
        baseSha: action.bindings.baseSha,
        nodeEpoch: action.bindings.nodeEpoch,
        acceptanceContract: structuredClone(acceptanceContract),
        sourceFingerprint: snapshot.issueSnapshotFingerprint,
        fullIssueBodyIncluded: false,
        fullDagIncluded: false,
        stateRootIncluded: false
    }
    const route = compileStageRoute({
        ...context,
        role: 'test-owner',
        phase: 'test-contract-planning',
        boundedProjection
    })
    const semanticRuntime = node.receipts?.runtimeBinding?.evidence
    if (semanticRuntime?.actorInvocationId ===
            route.runtimeBinding.actorInvocationId ||
        semanticRuntime?.actorSessionId ===
            route.runtimeBinding.actorSessionId) {
        reject('prewriter-planning-runtime-not-fresh')
    }
    const planningRequest = compileTestContractPlanningRequest({
        nodeDiscoveredReceipt: nodeDiscovered,
        acceptanceContract,
        routeDecision: route.routeDecision,
        attemptId
    })
    const observed = invokeObservedActor({
        ...context,
        ...route,
        request: {
            ...boundedProjection,
            planningRequest
        }
    })
    const planningReceipt = observed.payload.planningReceipt
    const investigationReceipt = observed.payload.investigationReceipt
    const sliceProposal = observed.payload.sliceProposal
    const dispatchInvestigation = object(
        observed.payload.dispatchInvestigation,
        'prewriter-dispatch-investigation-required'
    )
    if (dispatchInvestigation.schema !==
            'issue-orchestration.dispatch-investigation.v1' ||
        dispatchInvestigation.status !== 'complete' ||
        dispatchInvestigation.rootAuthored !== false ||
        dispatchInvestigation.actorRole !== 'test-owner' ||
        dispatchInvestigation.attemptId !== attemptId ||
        dispatchInvestigation.confirmedOwner !==
            action.bindings.repository ||
        dispatchInvestigation.baseSha !== action.bindings.baseSha ||
        dispatchInvestigation.sourceFingerprint !==
            snapshot.issueSnapshotFingerprint ||
        !dispatchInvestigation.repositoryEvidence ||
        typeof dispatchInvestigation.repositoryEvidence !== 'object' ||
        Array.isArray(dispatchInvestigation.repositoryEvidence) ||
        dispatchInvestigation.repositoryEvidence.repository !==
            action.bindings.repository ||
        !sameValue(
            dispatchInvestigation.repositoryEvidence.testPaths,
            planningReceipt?.testPaths
        ) ||
        !sameValue(
            dispatchInvestigation.repositoryEvidence.commands,
            planningReceipt?.commands
        ) ||
        dispatchInvestigation.repositoryEvidence.sourceFingerprint !==
            snapshot.issueSnapshotFingerprint ||
        dispatchInvestigation.repositoryEvidenceDigest !==
            digest(dispatchInvestigation.repositoryEvidence) ||
        dispatchInvestigation.receiptDigest !==
            unsignedDigest(dispatchInvestigation, 'receiptDigest')) {
        reject('prewriter-dispatch-investigation-invalid')
    }
    const bundle = compileTestContractPlanningBundle({
        request: planningRequest,
        snapshot,
        planningReceipt,
        investigationReceipt,
        sliceProposal
    })
    verifyTestContractPlanningBundle({
        bundle,
        request: planningRequest,
        snapshot
    })
    const validation = compileSlicePlanValidation({
        acceptanceContract,
        proposal: sliceProposal
    })
    verifySlicePlanValidation({
        acceptanceContract,
        proposal: sliceProposal,
        receipt: validation
    })
    const testContractDigest = digest({
        schema: 'issue-orchestration.planned-test-contract.v1',
        acceptanceContractDigest: acceptanceContract.contractDigest,
        planningBundleDigest: bundle.bundleDigest,
        slicePlanValidationDigest: validation.validationDigest
    })
    const plan = compilePreWriterStageWorkPlan({
        input: {
            schema: 'issue-orchestration.stage-work-plan-input.v1',
            runId: action.bindings.runId,
            repository: action.bindings.repository,
            issue: `${action.bindings.repository}#${action.bindings.issueNumber}`,
            node: action.nodeId,
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            baseSha: action.bindings.baseSha,
            epochId: `epoch-prewriter-${action.bindings.nodeEpoch}`,
            worktreeIdentity: fs.realpathSync(context.repositoryPath),
            semanticContractDigest: acceptanceContract.contractDigest,
            testContractDigest,
            authorityDigest:
                action.bindings.lifecycleAuthorityBindingDigest,
            skillDigest: context.skillDigest,
            baselineDigest: context.baselineDigest,
            routingInputDigest: bundle.bundleDigest
        },
        acceptanceContract,
        sliceProposal,
        slicePlanValidation: validation,
        planningBundleDigest: bundle.bundleDigest
    })
    validatePreWriterStageWorkPlan(plan)
    const executableSlice = compileExecutableSlice({
        plan,
        sliceId: plan.orderedSlices[0].sliceId
    })
    validatePreWriterExecutableSlice({ plan, slice: executableSlice })
    const compiledPrompt = compileDispatchPrompt({
        plan,
        slice: executableSlice
    })
    validatePreWriterCompiledDispatchPrompt({
        plan,
        slice: executableSlice,
        compiled: compiledPrompt
    })
    const resource = planningResource({
        action,
        attemptId,
        runtimeBinding: route.runtimeBinding,
        testContractDigest
    })
    const contractId = 'test-contract-planning'
    const artifacts = {}
    artifacts.runtimeBinding = runtimeArtifact(
        action,
        contractId,
        route.runtimeBinding
    )
    artifacts.mutationPostcondition = mutationArtifact(
        action,
        contractId,
        observed.postcondition
    )
    artifacts.planningAttempt = sealArtifact({
        action,
        contractId,
        kind: 'planningAttempt',
        evidence: {
            attemptId,
            testPaths: [...planningReceipt.testPaths],
            commands: [...planningReceipt.commands],
            mutationPostconditionReceiptDigest: artifactDigest(
                contractId,
                artifacts,
                'mutationPostcondition'
            ),
            receipt: structuredClone(planningReceipt),
            bundleDigest: bundle.bundleDigest
        }
    })
    artifacts.dispatchInvestigation = sealArtifact({
        action,
        contractId,
        kind: 'dispatchInvestigation',
        evidence: {
            planningAttemptDigest: artifactDigest(
                contractId,
                artifacts,
                'planningAttempt'
            ),
            repositoryEvidenceDigest:
                dispatchInvestigation.repositoryEvidenceDigest,
            receipt: structuredClone(dispatchInvestigation)
        }
    })
    artifacts.slicePlan = sealArtifact({
        action,
        contractId,
        kind: 'slicePlan',
        evidence: {
            sliceIds: sliceProposal.orderedSlices.map((slice) =>
                slice.sliceId),
            planningAttemptDigest: artifactDigest(
                contractId,
                artifacts,
                'planningAttempt'
            ),
            proposal: structuredClone(sliceProposal)
        }
    })
    artifacts.slicePlanValidation = sealArtifact({
        action,
        contractId,
        kind: 'slicePlanValidation',
        evidence: {
            slicePlanProposalDigest: artifactDigest(
                contractId,
                artifacts,
                'slicePlan'
            ),
            status: 'verified',
            violations: [],
            receipt: structuredClone(validation)
        }
    })
    artifacts.workPlan = sealArtifact({
        action,
        contractId,
        kind: 'workPlan',
        evidence: {
            acceptanceContractDigest: acceptanceContract.contractDigest,
            slicePlanValidationDigest: artifactDigest(
                contractId,
                artifacts,
                'slicePlanValidation'
            ),
            currentSliceId: executableSlice.sliceId,
            plan: structuredClone(plan)
        }
    })
    artifacts.executableSlice = sealArtifact({
        action,
        contractId,
        kind: 'executableSlice',
        evidence: {
            workPlanDigest: artifactDigest(
                contractId,
                artifacts,
                'workPlan'
            ),
            sliceId: executableSlice.sliceId,
            allowedPaths: [...executableSlice.allowedPaths],
            slice: structuredClone(executableSlice)
        }
    })
    artifacts.routeBinding = sealArtifact({
        action,
        contractId,
        kind: 'routeBinding',
        evidence: {
            selectedProfile: route.routeDecision.selectedProfile,
            stageRole: route.routeDecision.stageRole,
            stagePhase: route.routeDecision.stagePhase,
            policyDigest: action.bindings.policyDigest,
            routeDecision: structuredClone(route.routeDecision)
        }
    })
    artifacts.compiledPrompt = sealArtifact({
        action,
        contractId,
        kind: 'compiledPrompt',
        evidence: {
            workPlanDigest: artifactDigest(
                contractId,
                artifacts,
                'workPlan'
            ),
            executableSliceDigest: artifactDigest(
                contractId,
                artifacts,
                'executableSlice'
            ),
            routeDecisionDigest: artifactDigest(
                contractId,
                artifacts,
                'routeBinding'
            ),
            promptContentDigest: digest(compiledPrompt.prompt),
            fullIssueIncluded: false,
            fullDagIncluded: false,
            stateRootIncluded: false,
            prompt: structuredClone(compiledPrompt)
        }
    })
    artifacts.resourceAcquisition = sealArtifact({
        action,
        contractId,
        kind: 'resourceAcquisition',
        evidence: {
            resourceId: resource.resourceId,
            resourceIdentityDigest: resource.resourceIdentityDigest,
            leaseDigest: resource.leaseDigest,
            writeLeaseAcquired: false,
            registry: resource.registry
        }
    })
    const result = sealResult({
        action,
        actorRole: 'test-owner',
        attemptId,
        artifacts
    })
    validateLifecycleStageResult({ result, action, node })
    return result
}

export function executePreWriterLifecycleAction(context = {}) {
    const action = exactAction(context)
    for (const field of [
        'repositoryPath',
        'stateRootPath',
        'skillDigest',
        'baselineDigest'
    ]) text(context[field], `prewriter-${field}-required`)
    if (!fs.existsSync(context.repositoryPath) ||
        !fs.existsSync(context.stateRootPath)) {
        reject('prewriter-protected-root-missing')
    }
    object(context.routingClassification,
        'prewriter-routing-classification-required')
    object(context.startup, 'prewriter-startup-required')
    object(context.runtimeTrustBinding, 'prewriter-trust-required')
    if (!Array.isArray(context.repositoryTargets) ||
        context.repositoryTargets.length === 0) {
        reject('prewriter-repository-targets-required')
    }
    validateContextAuthority(context, action)
    switch (action.type) {
        case 'request-semantic-proposal':
            return semanticAction({ ...context, action })
        case 'compile-acceptance-contract':
            return acceptanceAction({ ...context, action })
        case 'request-test-contract-planning':
            return planningAction({ ...context, action })
        default:
            reject('prewriter-action-unsupported')
    }
}

export const preWriterLifecycleActionTypes = Object.freeze(
    [...SUPPORTED].sort()
)
