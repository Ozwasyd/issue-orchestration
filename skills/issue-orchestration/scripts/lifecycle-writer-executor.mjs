import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
    digest,
    sameValue,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    compileCanonicalRoute,
    validateExecutionRouteDecision
} from './execution-route-compiler.mjs'
import {
    compileRuntimeExecutionBinding,
    validateRuntimeExecutionBinding,
    compileRuntimeInspectionBinding,
    validateRuntimeInspectionBinding
} from './runtime-execution-binding.mjs'
import {
    sealDispatchRequest,
    verifyRuntimeDispatch
} from './dispatch-receipt.mjs'
import {
    captureStageMutationSnapshot,
    captureRuntimeInspectionSnapshot,
    evaluateStageMutationPostcondition,
    validateStageMutationPostconditionReceipt
} from './stage-runtime-guard.mjs'
import {
    createWriterRuntimeWatchdog
} from './writer-runtime-watchdog.mjs'
import {
    verifyWriterStageCheckpointLiveEvidence,
    sealSliceTerminalReceipt,
    evaluateSliceTerminalGate,
    evaluateWriterStageObservation,
    authorizeWriterStageRetry,
    validateSealedWriterStageRetryAuthorization
} from './writer-stage-progress.mjs'
import {
    validateSealedStageWorkPlan,
    validateSealedExecutableSlice,
    validateSealedCompiledDispatchPrompt,
    validateActiveWriterResourceAuthority,
    validateActiveWriterSourceAuthority
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

const SUPPORTED = new Set([
    'dispatch-test-contract-writer',
    'dispatch-implementation-writer',
    'dispatch-documentation-writer'
])
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

export class LifecycleWriterExecutorError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecycleWriterExecutorError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecycleWriterExecutorError(code, code, details)
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
        reject('writer-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    try {
        validateLifecycleActionSet(actionSet)
    } catch (error) {
        reject('writer-action-set-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        reject('writer-action-stale')
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
        reject('writer-lifecycle-authority-invalid', {
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
            reject('writer-action-authority-stale', { field })
        }
    }
    if (context.runtimeTrustBinding?.bindingDigest !==
            authority.runtimeTrustBinding.bindingDigest ||
        !sameValue(context.repositoryTargets, authority.repositoryTargets) ||
        fs.realpathSync(context.repositoryPath) !==
            repositoryAuthority.canonicalPath ||
        action.bindings.baseSha !==
            repositoryAuthority.observedDefaultBranchHead) {
        reject('writer-runtime-authority-stale')
    }
    return authority
}

function stageIdentity(action, node) {
    if (action.type === 'dispatch-test-contract-writer') {
        return {
            role: 'test-owner',
            phase: 'test-contract',
            successContract: 'test-contract-writer',
            outputClass: 'test-contract-candidate'
        }
    }
    if (action.type === 'dispatch-implementation-writer') {
        const ui = node?.uiClass === 'ui'
        return {
            role: ui ? 'ui-ux-implementer' : 'code-implementer',
            phase: ui ? 'ui-implementation' : 'implementation',
            successContract: 'implementation-candidate',
            failureContract: 'implementation-retry',
            outputClass: ui ? 'ui-candidate' : 'implementation-candidate'
        }
    }
    return {
        role: 'documentation-writer',
        phase: 'documentation',
        successContract: 'documentation-change',
        noChangeContract: 'documentation-no-change',
        outputClass: 'documentation-candidate'
    }
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
    if (!spec) reject('writer-artifact-contract-missing', { kind })
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
        producerAuthority: 'writer-lifecycle-executor',
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

function validateWriterAuthority({ action, node, stage, value }) {
    object(value, 'writer-authority-output-required')
    if (value.producerAuthority !== 'canonical-writer-authority' ||
        value.rootAuthored !== false ||
        value.writeLeaseAcquiredBeforeSpawn !== true ||
        value.stageContractFrozenBeforeSpawn !== true) {
        reject('writer-authority-order-invalid')
    }
    const plan = object(value.stageWorkPlan,
        'writer-stage-work-plan-required')
    const slice = object(value.executableSlice,
        'writer-executable-slice-required')
    const prompt = object(value.compiledPrompt,
        'writer-compiled-prompt-required')
    const sealedAuthority = object(value.sealedAuthority,
        'writer-sealed-authority-required')
    if (plan.runId !== action.bindings.runId ||
        plan.node !== action.nodeId ||
        plan.repository !== action.bindings.repository ||
        plan.baseSha !== action.bindings.baseSha ||
        plan.stageRole !== stage.role ||
        plan.stagePhase !== stage.phase ||
        plan.stageAttemptId !== value.attemptId ||
        slice.sliceId !== plan.orderedSlices[0]?.sliceId) {
        reject('writer-stage-authority-stale')
    }
    const errors = [
        ...validateSealedStageWorkPlan(plan, sealedAuthority),
        ...validateSealedExecutableSlice({
            plan,
            slice,
            authority: sealedAuthority
        }),
        ...validateSealedCompiledDispatchPrompt({
            plan,
            slice,
            compiled: prompt,
            authority: sealedAuthority
        })
    ]
    if (errors.length > 0) {
        reject('writer-stage-authority-invalid', { errors })
    }
    try {
        validateActiveWriterResourceAuthority(plan)
        validateActiveWriterSourceAuthority(plan)
    } catch (error) {
        reject('writer-stage-authority-not-active', {
            cause: error?.code ?? error?.message
        })
    }
    const registry = createResourceRegistry(value.resourceRegistry)
    if (registry.writeLease?.state !== 'active' ||
        registry.writeLease.ownerAttemptId !== value.attemptId ||
        plan.activeWriteLeaseId !== registry.writeLease.id ||
        !HASH.test(plan.resourceLeaseReceiptDigest ?? '')) {
        reject('writer-write-lease-invalid')
    }
    if (value.resourceReceipt?.schema !==
            'issue-orchestration.writer-resource-acquisition-receipt.v1' ||
        value.resourceReceipt.status !== 'acquired' ||
        value.resourceReceipt.stageAttemptId !== value.attemptId ||
        value.resourceReceipt.leaseId !== plan.activeWriteLeaseId ||
        value.resourceReceipt.receiptDigest !==
            unsignedDigest(value.resourceReceipt, 'receiptDigest')) {
        reject('writer-resource-receipt-invalid')
    }
    return {
        ...value,
        plan,
        slice,
        prompt,
        registry,
        sealedAuthority
    }
}

function compileWriterRoute(context, stage, authority) {
    object(context.actorAdapter, 'writer-actor-adapter-required')
    if (typeof context.actorAdapter.prepare !== 'function' ||
        typeof context.actorAdapter.invoke !== 'function') {
        reject('writer-actor-adapter-invalid')
    }
    const envelope = context.actorContextEnvelope === undefined
        ? null
        : validateActorContextEnvelopeBinding(
            context.actorContextEnvelope,
            {
                action: context.action,
                role: stage.role,
                phase: stage.phase
            }
        )
    const routeBase = {
        stageWorkPlan: authority.plan,
        executableSlice: authority.slice,
        routingClassification: context.routingClassification,
        executionMetrics: context.executionMetrics,
        machineClassificationEvidence:
            context.machineClassificationEvidence,
        runtimeAvailabilityBinding:
            context.runtimeAvailabilityBinding,
        documentationClass: context.documentationClass ?? null
    }
    const pending = compileCanonicalRoute(routeBase)
    const pendingDecision = pending.executionRouteDecision
    const prepared = object(context.actorAdapter.prepare({
        action: structuredClone(context.action),
        node: structuredClone(context.node),
        stageRole: stage.role,
        stagePhase: stage.phase,
        routeDecision: structuredClone(pendingDecision),
        stageWorkPlan: structuredClone(authority.plan),
        executableSlice: structuredClone(authority.slice),
        compiledPrompt: structuredClone(authority.prompt),
        writeLeaseDigest: authority.plan.resourceLeaseReceiptDigest,
        ...(envelope ? { actorContextEnvelope: structuredClone(envelope) } : {}),
        ...(context.actorContextProgressiveReader ? {
            resolveActorContextReference:
                context.actorContextProgressiveReader
        } : {})
    }), 'writer-actor-preparation-invalid')
    const runtimeBinding = compileRuntimeExecutionBinding({
        stageRole: stage.role,
        stagePhase: stage.phase,
        selectedProfile: pendingDecision.selectedProfile,
        routeDecisionDigest: pendingDecision.routeDecisionDigest,
        runtimeObservation: prepared.runtimeObservation,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets,
        writeLeaseDigest: authority.plan.resourceLeaseReceiptDigest
    })
    const finalBundle = compileCanonicalRoute({
        ...routeBase,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets,
        runtimeExecutionBinding: runtimeBinding,
        runtimeCapabilityObservation:
            prepared.runtimeCapabilityObservation
    })
    const routeDecision = finalBundle.executionRouteDecision
    validateExecutionRouteDecision(routeDecision, {
        stageRole: stage.role,
        stagePhase: stage.phase
    })
    validateRuntimeExecutionBinding(runtimeBinding, {
        stageRole: stage.role,
        stagePhase: stage.phase,
        selectedProfile: routeDecision.selectedProfile,
        routeDecisionDigest: pendingDecision.routeDecisionDigest,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets,
        writeLeaseDigest: authority.plan.resourceLeaseReceiptDigest
    })
    if (runtimeBinding.actorInvocationId ===
            context.startup.attestation.runtimeInvocationId ||
        runtimeBinding.actorSessionId ===
            context.startup.attestation.runtimeSessionId) {
        reject('writer-fresh-runtime-required')
    }
    return {
        prepared,
        runtimeBinding,
        pendingRouteBundle: pending,
        pendingRouteDecision: pendingDecision,
        routeDecision
    }
}

function mutationIdentity({
    context,
    authority,
    routeDecision,
    runtimeBinding,
    requestDigest,
    snapshotKind,
    capturedAt
}) {
    return {
        snapshotKind,
        capturedAt,
        runId: context.action.bindings.runId,
        actorInvocationId: runtimeBinding.actorInvocationId,
        actorSessionId: runtimeBinding.actorSessionId,
        attemptId: authority.attemptId,
        stageRole: authority.plan.stageRole,
        stagePhase: authority.plan.stagePhase,
        runtimeExecutionBinding: runtimeBinding,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets,
        routeDecisionDigest: routeDecision.routeDecisionDigest,
        compiledPromptDigest: requestDigest,
        repository: context.action.bindings.repository,
        repositoryPath: authority.plan.worktreeIdentity,
        stateRootPath: context.stateRootPath,
        resourceIdentityDigest:
            context.action.bindings.repositoryBindingDigest,
        baseSha: context.action.bindings.baseSha,
        deliveryEpoch: authority.plan.epochId,
        candidateIdentity: context.node?.receipts?.candidate?.evidence
            ?.candidateSha ?? 'none',
        leaseDigest: authority.plan.resourceLeaseReceiptDigest,
        sliceDigest: authority.slice.sliceDigest,
        allowedPaths: [...authority.slice.allowedPaths],
        remoteSnapshotDigest:
            context.action.bindings.remoteSnapshotDigest
    }
}

function watchdogBudgets(slice) {
    const duration = slice.maxNoArtifactActiveDurationClass
    const maxMs = duration === 'long'
        ? 15 * 60_000
        : duration === 'medium'
            ? 5 * 60_000
            : 60_000
    return {
        maxReadOnlyOperationsBeforeCheckpoint:
            slice.maxReadOnlyOperationsBeforeCheckpoint,
        maxNoArtifactToolCalls: slice.maxNoArtifactToolCalls,
        maxNoArtifactActiveMs: maxMs,
        postCommandEvidenceMs: 30_000
    }
}

function createWatchdog({ authority, routeDecision, prepared }) {
    const persisted = []
    const cancelled = []
    const watchdog = createWriterRuntimeWatchdog({
        runtimeCapabilities: {
            incrementalTrace: true,
            cancellation: true
        },
        startedAtMs: prepared.startedAtMs,
        binding: {
            requestId: prepared.requestId,
            threadId: prepared.threadId,
            rolloutId: prepared.rolloutId,
            attemptId: authority.attemptId,
            planDigest: authority.plan.planDigest,
            sliceDigest: authority.slice.sliceDigest,
            routeDecisionDigest: routeDecision.routeDecisionDigest,
            leaseDigest: authority.plan.resourceLeaseReceiptDigest,
            selectedProfile: routeDecision.selectedProfile,
            firstRequiredAction: authority.slice.firstRequiredAction,
            requiredCommands: [...authority.slice.requiredCommands]
        },
        budgets: watchdogBudgets(authority.slice),
        cancel: (reason) => cancelled.push(reason),
        persist: (receipt) => persisted.push(receipt)
    })
    return { watchdog, persisted, cancelled }
}

async function compileDispatch({ context, authority, route, requestInput }) {
    const request = await sealDispatchRequest(requestInput)
    if (request.planDigest !== authority.plan.planDigest ||
        request.sliceDigest !== authority.slice.sliceDigest ||
        request.compiledPromptDigest !== authority.prompt.promptDigest ||
        request.executionRouteDecisionDigest !==
            route.pendingRouteDecision.routeDecisionDigest ||
        request.attemptId !== authority.attemptId) {
        reject('writer-dispatch-request-stale')
    }
    return request
}

function writerOutputClass(stage) {
    if (stage.phase === 'test-contract') {
        return 'test-contract-candidate'
    }
    if (stage.phase === 'documentation') {
        return 'documentation-candidate'
    }
    return stage.phase === 'ui-implementation'
        ? 'ui-candidate'
        : 'implementation-candidate'
}

function mutationArtifact(action, contractId, receipt) {
    validateStageMutationPostconditionReceipt(receipt, {
        status: 'verified'
    })
    if (receipt.executionClass !== 'leased-writer' ||
        receipt.violationCodes.length !== 0) {
        reject('writer-mutation-postcondition-not-clean')
    }
    return sealArtifact({
        action,
        contractId,
        kind: 'mutationPostcondition',
        evidence: {
            status: 'verified',
            violations: [],
            preSnapshotDigest: receipt.preSnapshotDigest,
            postSnapshotDigest: receipt.postSnapshotDigest,
            observationDigest: digest(receipt),
            receipt: structuredClone(receipt)
        }
    })
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
            effectiveBackend: runtimeBinding.effectiveMultiAgentBackend,
            effectivePermissionProfile:
                runtimeBinding.effectivePermissionProfile,
            executionObservationDigest:
                runtimeBinding.runtimeObservationDigest,
            binding: structuredClone(runtimeBinding)
        }
    })
}

function dispatchArtifact(
    action,
    contractId,
    dispatchReceipt,
    runtimeBinding,
    runtimeDigest
) {
    return sealArtifact({
        action,
        contractId,
        kind: 'dispatchReceipt',
        evidence: {
            actorInvocationId: runtimeBinding.actorInvocationId,
            routeDecisionDigest:
                dispatchReceipt.executionRouteDecisionDigest ??
                dispatchReceipt.routeDecisionDigest,
            compiledPromptDigest: dispatchReceipt.compiledPromptDigest,
            runtimeExecutionBindingDigest: runtimeDigest,
            receipt: structuredClone(dispatchReceipt)
        }
    })
}

function watchdogArtifact(action, contractId, authority, route, watchdog) {
    const receipt = watchdog.receipt()
    if (!['completed', 'checkpoint-received'].includes(receipt.status) ||
        receipt.cancellationReason !== null ||
        receipt.firstActionVerified !== true ||
        receipt.firstArtifactVerified !== true) {
        reject('writer-watchdog-not-green', { receipt })
    }
    return sealArtifact({
        action,
        contractId,
        kind: 'watchdog',
        evidence: {
            watchdogId: `${authority.attemptId}:watchdog`,
            startedBeforeSpawn: true,
            online: true,
            policyDigest: digest({
                planDigest: authority.plan.planDigest,
                sliceDigest: authority.slice.sliceDigest,
                routeDecisionDigest: route.routeDecision.routeDecisionDigest,
                budgets: watchdogBudgets(authority.slice)
            }),
            receipt
        }
    })
}

function checkpointArtifacts({
    action,
    contractId,
    authority,
    route,
    actorOutput
}) {
    const input = object(actorOutput.checkpointVerificationInput,
        'writer-checkpoint-input-required')
    let receipt
    try {
        receipt = verifyWriterStageCheckpointLiveEvidence({
            ...input,
            plan: authority.plan,
            slice: authority.slice,
            compiledPrompt: authority.prompt,
            compiledPromptDigest: authority.prompt.promptDigest,
            routeDigest:
                route.pendingRouteDecision.routeDecisionDigest,
            sealedAuthority: authority.sealedAuthority
        })
    } catch (error) {
        reject('writer-checkpoint-live-evidence-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const checkpoint = input.checkpoint
    const commandEvidenceDigest = digest(
        checkpoint.evidence.commands.map(({ outputDigest }) => outputDigest)
    )
    const checkpointArtifact = sealArtifact({
        action,
        contractId,
        kind: 'checkpointVerification',
        evidence: {
            checkpointDigest: receipt.checkpointDigest,
            commandEvidenceDigest,
            liveEvidenceVerified: true,
            receipt
        }
    })
    return { checkpoint, checkpointArtifact, receipt, input }
}

function terminalArtifacts({
    action,
    contractId,
    authority,
    route,
    checkpoint,
    checkpointReceipt,
    checkpointInput,
    actorOutput
}) {
    const terminal = sealSliceTerminalReceipt({
        carryForwardPrefix: checkpointInput.carryForwardPrefix,
        plan: authority.plan,
        slice: authority.slice,
        checkpoint,
        compiledPrompt: authority.prompt,
        compiledPromptDigest: authority.prompt.promptDigest,
        routeDigest:
            route.pendingRouteDecision.routeDecisionDigest,
        checkpointVerificationReceipt: checkpointReceipt,
        sealedAuthority: authority.sealedAuthority,
        acceptedPriorChangedPaths:
            checkpointInput.acceptedPriorChangedPaths ?? [],
        completedSlicePrefixDigest:
            checkpointInput.completedSlicePrefixDigest ?? digest([]),
        previousMachineTraceSnapshot:
            checkpointInput.previousMachineTraceSnapshot,
        priorTerminalReceipts:
            actorOutput.priorTerminalReceipts ?? [],
        changedPaths: actorOutput.changedPaths,
        commandEvidenceDigests: actorOutput.commandEvidenceDigests
    })
    const gate = evaluateSliceTerminalGate({
        carryForwardPrefix: checkpointInput.carryForwardPrefix,
        plan: authority.plan,
        currentSlice: authority.slice,
        currentCheckpoint: checkpoint,
        compiledPrompt: authority.prompt,
        checkpointVerificationReceipt: checkpointReceipt,
        sealedAuthority: authority.sealedAuthority,
        acceptedPriorChangedPaths:
            checkpointInput.acceptedPriorChangedPaths ?? [],
        completedSlicePrefixDigest:
            checkpointInput.completedSlicePrefixDigest ?? digest([]),
        previousMachineTraceSnapshot:
            checkpointInput.previousMachineTraceSnapshot,
        terminalReceipts: [
            ...(actorOutput.priorTerminalReceipts ?? []),
            terminal
        ]
    })
    if (gate.status !== 'completed' ||
        !['candidate-green', 'next-slice'].includes(gate.nextState)) {
        reject('writer-slice-terminal-gate-invalid', { gate })
    }
    const artifact = sealArtifact({
        action,
        contractId,
        kind: 'sliceTerminal',
        evidence: {
            sliceId: terminal.sliceId,
            sliceDigest: terminal.sliceDigest,
            checkpointDigest: terminal.checkpointDigest,
            status: 'verified',
            receipt: terminal,
            gate
        }
    })
    return { terminal, gate, artifact }
}

function gitOutput(repositoryPath, args, code) {
    try {
        return execFileSync('git', ['-C', repositoryPath, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000
        }).trim()
    } catch {
        reject(code)
    }
}

function observeCandidate(repositoryPath, baseSha, claimedCandidateSha) {
    const candidateSha = text(
        claimedCandidateSha,
        'writer-candidate-sha-required'
    )
    if (!SHA.test(candidateSha) || candidateSha === baseSha) {
        reject('writer-candidate-not-new')
    }
    gitOutput(
        repositoryPath,
        ['cat-file', '-e', `${candidateSha}^{commit}`],
        'writer-candidate-commit-unobservable'
    )
    gitOutput(
        repositoryPath,
        ['merge-base', '--is-ancestor', baseSha, candidateSha],
        'writer-candidate-base-not-ancestor'
    )
    const candidateTree = gitOutput(
        repositoryPath,
        ['rev-parse', `${candidateSha}^{tree}`],
        'writer-candidate-tree-unobservable'
    )
    const stagedTree = gitOutput(
        repositoryPath,
        ['write-tree'],
        'writer-candidate-index-tree-unobservable'
    )
    if (candidateTree !== stagedTree) {
        reject('writer-candidate-index-tree-mismatch')
    }
    const diff = gitOutput(repositoryPath,
        ['diff', '--binary', `${baseSha}..${candidateSha}`],
        'writer-candidate-diff-unobservable')
    if (!diff) reject('writer-candidate-diff-missing')
    return {
        candidateSha,
        candidateTreeDigest: digest(candidateTree),
        candidateDiffDigest: digest(diff)
    }
}


async function freezeAndObserveCandidate({
    context,
    authority,
    actorOutput
}) {
    const adapter = object(
        context.candidateAdapter,
        'writer-candidate-adapter-required'
    )
    if (typeof adapter.freeze !== 'function') {
        reject('writer-candidate-adapter-invalid')
    }
    const frozen = object(await adapter.freeze({
        action: structuredClone(context.action),
        node: structuredClone(context.node),
        attemptId: authority.attemptId,
        repositoryPath: authority.plan.worktreeIdentity,
        baseSha: context.action.bindings.baseSha,
        allowedPaths: [...authority.slice.allowedPaths],
        changedPaths: [...actorOutput.changedPaths]
    }), 'writer-candidate-freeze-invalid')
    const observed = observeCandidate(
        authority.plan.worktreeIdentity,
        context.action.bindings.baseSha,
        frozen.candidateSha
    )
    if (frozen.candidateSha !== observed.candidateSha ||
        frozen.candidateTreeDigest !== observed.candidateTreeDigest ||
        frozen.candidateDiffDigest !== observed.candidateDiffDigest ||
        !sameValue(
            [...(frozen.changedPaths ?? [])].sort(),
            [...actorOutput.changedPaths].sort()
        )) {
        reject('writer-candidate-freeze-mismatch')
    }
    return observed
}

async function executeLeasedWriter(context, stage, authority) {
    const route = compileWriterRoute(context, stage, authority)
    const requestInput = object(
        context.writerAuthorityAdapter.compileDispatchRequest({
            action: structuredClone(context.action),
            node: structuredClone(context.node),
            authority: structuredClone(authority),
            routeDecision: structuredClone(
                route.pendingRouteDecision
            ),
            executionRouteBundle: structuredClone(
                route.pendingRouteBundle
            ),
            runtimeExecutionBinding: structuredClone(route.runtimeBinding),
            verifiedRouteDecision: structuredClone(route.routeDecision),
            preparation: route.prepared.preparation
        }),
        'writer-dispatch-request-input-required'
    )
    const request = await compileDispatch({
        context,
        authority,
        route,
        requestInput
    })
    const watchdogState = createWatchdog({
        authority,
        routeDecision: route.pendingRouteDecision,
        prepared: route.prepared
    })
    const preSnapshot = captureStageMutationSnapshot(mutationIdentity({
        context,
        authority,
        routeDecision: route.routeDecision,
        runtimeBinding: route.runtimeBinding,
        requestDigest: authority.prompt.promptDigest,
        snapshotKind: 'pre-dispatch',
        capturedAt: new Date().toISOString()
    }))
    let actorOutput
    try {
        actorOutput = object(await context.actorAdapter.invoke({
            preparation: route.prepared.preparation,
            action: structuredClone(context.action),
            request: structuredClone(request),
            routeDecision: structuredClone(route.routeDecision),
            runtimeExecutionBinding: structuredClone(route.runtimeBinding),
            watchdog: watchdogState.watchdog,
            ...(context.actorContextEnvelope ? {
                actorContextEnvelope: structuredClone(
                    context.actorContextEnvelope
                )
            } : {}),
            ...(context.actorContextProgressiveReader ? {
                resolveActorContextReference:
                    context.actorContextProgressiveReader
            } : {})
        }), 'writer-actor-output-invalid')
    } catch (error) {
        if (error instanceof LifecycleWriterExecutorError) throw error
        reject('writer-actor-execution-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const dispatch = await verifyRuntimeDispatch({
        request,
        rolloutRecords: actorOutput.rolloutRecords,
        machineObservations: actorOutput.machineObservations,
        priorReceipts: actorOutput.priorDispatchReceipts ?? [],
        runtimeExecutionObservation: route.prepared.runtimeObservation,
        runtimeExecutionBindingDigest:
            route.runtimeBinding.bindingDigest,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets
    })
    if (dispatch.dispatchReceipt?.verificationStatus !== 'verified' ||
        dispatch.runtimeExecutionBinding?.bindingDigest !==
            route.runtimeBinding.bindingDigest) {
        reject('writer-runtime-dispatch-not-verified', {
            mismatchReasons:
                dispatch.dispatchReceipt?.mismatchReasons ?? []
        })
    }
    const postSnapshot = captureStageMutationSnapshot(mutationIdentity({
        context,
        authority,
        routeDecision: route.routeDecision,
        runtimeBinding: route.runtimeBinding,
        requestDigest: authority.prompt.promptDigest,
        snapshotKind: 'post-execution',
        capturedAt: new Date().toISOString()
    }))
    const mutationOutput = actorOutput.mutationOutput ?? {
        outcome: actorOutput.outcome ?? 'completed',
        changedPaths: actorOutput.changedPaths ?? [],
        commandEvidenceDigests:
            actorOutput.commandEvidenceDigests ?? []
    }
    const postcondition = evaluateStageMutationPostcondition({
        preSnapshot,
        postSnapshot,
        outputClass: stage.outputClass,
        output: mutationOutput,
        prohibitedReceiptEmitted:
            actorOutput.prohibitedReceiptEmitted === true,
        attributionStatus:
            actorOutput.attributionStatus ?? 'verified'
    })
    validateStageMutationPostconditionReceipt(postcondition, {
        status: postcondition.status,
        runtimeExecutionBindingDigest:
            route.runtimeBinding.bindingDigest,
        resultDigest: digest(mutationOutput)
    })
    if (postcondition.executionClass !== 'leased-writer' ||
        postcondition.violationCodes.length !== 0) {
        reject('writer-mutation-postcondition-not-clean', {
            violations: postcondition.violationCodes
        })
    }
    const outcome = actorOutput.outcome ?? 'completed'
    const contractId = outcome === 'recoverable-failure'
        ? stage.failureContract
        : stage.successContract
    const artifacts = {}
    artifacts.runtimeBinding = runtimeArtifact(
        context.action,
        contractId,
        route.runtimeBinding
    )
    artifacts.dispatchReceipt = dispatchArtifact(
        context.action,
        contractId,
        dispatch.dispatchReceipt,
        route.runtimeBinding,
        artifactDigest(contractId, artifacts, 'runtimeBinding')
    )
    artifacts.watchdog = watchdogArtifact(
        context.action,
        contractId,
        authority,
        route,
        watchdogState.watchdog
    )
    const checkpoint = checkpointArtifacts({
        action: context.action,
        contractId,
        authority,
        route,
        actorOutput
    })
    artifacts.checkpointVerification = checkpoint.checkpointArtifact
    const commandEvidenceDigest = checkpoint.checkpointArtifact.evidence
        .commandEvidenceDigest
    if (outcome === 'recoverable-failure') {
        const failureEvaluation = evaluateWriterStageObservation(
            object(actorOutput.writerObservation,
                'writer-failure-observation-required')
        )
        const failure = object(
            failureEvaluation.failureReceipt,
            'writer-failure-receipt-required'
        )
        const retry = authorizeWriterStageRetry({
            priorFailure: failure,
            proposed: actorOutput.proposedRetry,
            revisions: actorOutput.revisions ?? [],
            sourceFailureEvent: actorOutput.sourceFailureEvent,
            resourceCleanupReceipt:
                actorOutput.resourceCleanupReceipt
        })
        if (retry.authorized !== true) {
            reject('writer-retry-not-authorized', {
                reason: retry.reason
            })
        }
        const retryErrors = validateSealedWriterStageRetryAuthorization({
            authorization: retry,
            completedSlicePrefix:
                actorOutput.completedSlicePrefix ?? [],
            priorFailure: failure,
            sourceFailureEvent: actorOutput.sourceFailureEvent,
            proposed: actorOutput.proposedRetry,
            resourceCleanupReceipt:
                actorOutput.resourceCleanupReceipt,
            revisions: actorOutput.revisions ?? [],
            sealedAuthority:
                actorOutput.proposedRetrySealedAuthority ??
                authority.sealedAuthority
        })
        if (retryErrors?.length) {
            reject('writer-retry-authorization-invalid', {
                errors: retryErrors
            })
        }
        artifacts.writerFailure = sealArtifact({
            action: context.action,
            contractId,
            kind: 'writerFailure',
            evidence: {
                failureCode: failure.eventType,
                firstFailureDigest: failure.semanticFailureDigest,
                traceDigest: failure.evidenceDigest,
                recoverable: true,
                receipt: failure
            }
        })
        artifacts.retryAuthorization = sealArtifact({
            action: context.action,
            contractId,
            kind: 'retryAuthorization',
            evidence: {
                writerFailureDigest: artifactDigest(
                    contractId,
                    artifacts,
                    'writerFailure'
                ),
                firstFailureDigest: failure.semanticFailureDigest,
                revisionEvidenceDigest:
                    retry.revisionEvidenceDigest ??
                    retry.revisionReceiptDigest,
                status: 'authorized',
                receipt: retry
            }
        })
    } else {
        const terminal = terminalArtifacts({
            action: context.action,
            contractId,
            authority,
            route,
            checkpoint: checkpoint.checkpoint,
            checkpointReceipt: checkpoint.receipt,
            checkpointInput: checkpoint.input,
            actorOutput
        })
        artifacts.sliceTerminal = terminal.artifact
        if (contractId === 'test-contract-writer') {
            artifacts.testContractWriter = sealArtifact({
                action: context.action,
                contractId,
                kind: 'testContractWriter',
                evidence: {
                    testDeltaDigest: digest({
                        changedPaths: actorOutput.changedPaths,
                        terminalReceiptDigest: terminal.terminal.receiptDigest
                    }),
                    commandEvidenceDigest,
                    checkpointVerificationDigest: artifactDigest(
                        contractId,
                        artifacts,
                        'checkpointVerification'
                    ),
                    changedPaths: [...actorOutput.changedPaths],
                    terminalReceipt: terminal.terminal
                }
            })
        } else if (contractId === 'implementation-candidate') {
            const candidate = await freezeAndObserveCandidate({
                context,
                authority,
                actorOutput
            })
            artifacts.implementationTerminal = sealArtifact({
                action: context.action,
                contractId,
                kind: 'implementationTerminal',
                evidence: {
                    ...candidate,
                    gitDeltaDigest: digest(actorOutput.changedPaths),
                    commandEvidenceDigest,
                    checkpointVerificationDigest: artifactDigest(
                        contractId,
                        artifacts,
                        'checkpointVerification'
                    ),
                    changedPaths: [...actorOutput.changedPaths],
                    terminalReceipt: terminal.terminal
                }
            })
            artifacts.candidate = sealArtifact({
                action: context.action,
                contractId,
                kind: 'candidate',
                evidence: {
                    ...candidate,
                    commandEvidenceDigest,
                    checkpointVerificationDigest: artifactDigest(
                        contractId,
                        artifacts,
                        'checkpointVerification'
                    ),
                    writerInvocationId:
                        route.runtimeBinding.actorInvocationId
                }
            })
        } else {
            artifacts.documentation = sealArtifact({
                action: context.action,
                contractId,
                kind: 'documentation',
                evidence: {
                    mode: 'changed',
                    changedPaths: [...actorOutput.changedPaths],
                    documentationDeltaDigest: digest({
                        changedPaths: actorOutput.changedPaths,
                        terminalReceiptDigest: terminal.terminal.receiptDigest
                    }),
                    commandEvidenceDigest,
                    terminalReceipt: terminal.terminal
                }
            })
        }
    }
    artifacts.mutationPostcondition = mutationArtifact(
        context.action,
        contractId,
        postcondition
    )
    const result = sealResult({
        action: context.action,
        actorRole: stage.role,
        attemptId: authority.attemptId,
        artifacts
    })
    validateLifecycleStageResult({
        result,
        action: context.action,
        node: context.node
    })
    return result
}

function documentationInspectionFile(repositoryPath, entry) {
    object(entry, 'writer-documentation-inspected-file-invalid')
    const relative = text(entry.path,
        'writer-documentation-inspected-file-path-required')
        .replaceAll('\\', '/')
    if (path.posix.isAbsolute(relative) ||
        relative === '..' || relative.startsWith('../') ||
        relative.includes('/../') ||
        relative === '.git' || relative.startsWith('.git/')) {
        reject('writer-documentation-inspected-file-path-invalid')
    }
    const root = fs.realpathSync(repositoryPath)
    const target = fs.realpathSync(path.resolve(root, relative))
    if (!target.startsWith(`${root}${path.sep}`) ||
        !fs.statSync(target).isFile()) {
        reject('writer-documentation-inspected-file-outside-repository')
    }
    const contentDigest = digest(fs.readFileSync(target))
    const gitObjectDigest = gitOutput(
        root,
        ['hash-object', '--', relative],
        'writer-documentation-inspected-file-git-object-unobservable'
    )
    if (entry.realPath !== target ||
        entry.contentDigest !== contentDigest ||
        entry.gitObjectDigest !== gitObjectDigest) {
        reject('writer-documentation-inspected-file-drift', { relative })
    }
    return {
        path: relative,
        realPath: target,
        contentDigest,
        gitObjectDigest
    }
}

function inspectionRuntimeArtifact(
    action,
    contractId,
    binding,
    repositoryInspectionDigest
) {
    return sealArtifact({
        action,
        contractId,
        kind: 'runtimeBinding',
        evidence: {
            actorInvocationId: binding.actorInvocationId,
            actorSessionId: binding.actorSessionId,
            runtimeId: binding.runtimeId,
            runtimeVersion: binding.runtimeVersion,
            effectiveBackend: binding.effectiveMultiAgentBackend,
            effectivePermissionProfile:
                binding.effectivePermissionProfile,
            executionObservationDigest:
                binding.runtimeObservationDigest,
            repositoryInspectionDigest,
            inspectionKind: binding.inspectionKind,
            executionClass: binding.executionClass,
            writerSpawned: false,
            writeLeaseAcquired: false,
            binding: structuredClone(binding)
        }
    })
}

async function executeDocumentationNoChange(context, stage) {
    const adapter = object(context.documentationInspectionAdapter,
        'writer-documentation-inspection-adapter-required')
    if (typeof adapter.prepare !== 'function' ||
        typeof adapter.inspect !== 'function') {
        reject('writer-documentation-inspection-adapter-invalid')
    }
    const prepared = object(await adapter.prepare({
        action: structuredClone(context.action),
        node: structuredClone(context.node),
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets,
        repositoryPath: context.repositoryPath,
        stateRootPath: context.stateRootPath
    }), 'writer-documentation-inspection-preparation-invalid')
    const attemptId = text(prepared.attemptId,
        'writer-documentation-inspection-attempt-required')
    let inspectionBinding
    try {
        inspectionBinding = compileRuntimeInspectionBinding({
            inspectionKind: 'documentation-no-change',
            runtimeObservation: prepared.runtimeInspectionObservation,
            startup: context.startup,
            runtimeTrustBinding: context.runtimeTrustBinding,
            repositoryTargets: context.repositoryTargets
        })
        validateRuntimeInspectionBinding(inspectionBinding, {
            inspectionKind: 'documentation-no-change',
            startup: context.startup,
            runtimeTrustBinding: context.runtimeTrustBinding,
            repositoryTargets: context.repositoryTargets
        })
    } catch (error) {
        reject('writer-documentation-inspection-runtime-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const acceptanceContractDigest = text(
        context.node?.receipts?.acceptanceContract?.contractDigest,
        'writer-documentation-acceptance-contract-required'
    )
    const routeDecisionDigest = digest({
        actionDigest: context.action.actionDigest,
        inspectionKind: 'documentation-no-change',
        inspectionBindingDigest: inspectionBinding.bindingDigest
    })
    const snapshotInput = {
        runId: context.action.bindings.runId,
        attemptId,
        inspectionKind: 'documentation-no-change',
        repository: context.action.bindings.repository,
        repositoryPath: context.repositoryPath,
        stateRootPath: context.stateRootPath,
        resourceIdentityDigest:
            context.action.bindings.repositoryBindingDigest,
        baseSha: context.action.bindings.baseSha,
        deliveryEpoch:
            `node-epoch:${context.action.bindings.nodeEpoch}`,
        candidateIdentity: context.action.bindings.baseSha,
        routeDecisionDigest,
        compiledPromptDigest: acceptanceContractDigest,
        remoteSnapshotDigest:
            context.action.bindings.remoteMemberDigest ??
            context.action.bindings.selectorReceiptDigest,
        runtimeInspectionBinding: inspectionBinding,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets
    }
    const preSnapshot = captureRuntimeInspectionSnapshot({
        ...snapshotInput,
        snapshotKind: 'pre-dispatch',
        capturedAt: new Date().toISOString()
    })
    let output
    try {
        output = object(await adapter.inspect({
            action: structuredClone(context.action),
            node: structuredClone(context.node),
            inspectionBinding: structuredClone(inspectionBinding),
            acceptanceContractDigest,
            repositoryPath: context.repositoryPath,
            stateRootPath: context.stateRootPath
        }), 'writer-documentation-inspection-invalid')
    } catch (error) {
        if (error instanceof LifecycleWriterExecutorError) throw error
        reject('writer-documentation-inspection-execution-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (output.mode !== 'no-change' ||
        output.writerSpawned !== false ||
        output.writeLeaseAcquired !== false ||
        output.acceptanceContractDigest !== acceptanceContractDigest ||
        !Array.isArray(output.inspectedFiles) ||
        output.inspectedFiles.length === 0) {
        reject('writer-documentation-no-change-authority-exceeded')
    }
    const headSha = gitOutput(
        context.repositoryPath,
        ['rev-parse', '--verify', 'HEAD'],
        'writer-documentation-head-unobservable'
    )
    const worktreeStatus = gitOutput(
        context.repositoryPath,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        'writer-documentation-status-unobservable'
    )
    if (headSha !== context.action.bindings.baseSha || worktreeStatus !== '') {
        reject('writer-documentation-no-change-worktree-not-clean')
    }
    const inspectedFiles = output.inspectedFiles
        .map((entry) => documentationInspectionFile(
            context.repositoryPath,
            entry
        ))
        .sort((left, right) => left.path.localeCompare(right.path))
    const repositoryInspectionDigest = digest({
        acceptanceContractDigest,
        headSha,
        worktreeStatus,
        inspectedFiles
    })
    if (output.repositoryInspectionDigest !==
            repositoryInspectionDigest) {
        reject('writer-documentation-inspection-digest-mismatch')
    }
    const postSnapshot = captureRuntimeInspectionSnapshot({
        ...snapshotInput,
        snapshotKind: 'post-execution',
        capturedAt: new Date().toISOString()
    })
    const inspectionOutput = {
        mode: 'no-change',
        acceptanceContractDigest,
        repositoryInspectionDigest,
        inspectedFiles
    }
    const postcondition = evaluateStageMutationPostcondition({
        preSnapshot,
        postSnapshot,
        outputClass: 'verification-evidence',
        output: inspectionOutput,
        prohibitedReceiptEmitted:
            output.prohibitedReceiptEmitted === true,
        attributionStatus: output.attributionStatus ?? 'verified'
    })
    validateStageMutationPostconditionReceipt(postcondition, {
        status: postcondition.status,
        runtimeExecutionBindingDigest: inspectionBinding.bindingDigest,
        resultDigest: digest(inspectionOutput)
    })
    if (postcondition.executionClass !== 'observe-only' ||
        postcondition.violationCodes.length !== 0) {
        reject('writer-documentation-no-change-mutation', {
            violations: postcondition.violationCodes
        })
    }
    const contractId = stage.noChangeContract
    const artifacts = {}
    artifacts.runtimeBinding = inspectionRuntimeArtifact(
        context.action,
        contractId,
        inspectionBinding,
        repositoryInspectionDigest
    )
    artifacts.documentation = sealArtifact({
        action: context.action,
        contractId,
        kind: 'documentation',
        evidence: {
            mode: 'no-change',
            acceptanceContractDigest,
            repositoryInspectionDigest,
            inspection: inspectionOutput
        }
    })
    artifacts.documentationNoChange = sealArtifact({
        action: context.action,
        contractId,
        kind: 'documentationNoChange',
        evidence: {
            documentationReceiptDigest: artifactDigest(
                contractId,
                artifacts,
                'documentation'
            ),
            status: 'verified',
            inspectionBindingDigest: inspectionBinding.bindingDigest
        }
    })
    artifacts.mutationPostcondition = sealArtifact({
        action: context.action,
        contractId,
        kind: 'mutationPostcondition',
        evidence: {
            status: 'verified',
            violations: [],
            preSnapshotDigest: postcondition.preSnapshotDigest,
            postSnapshotDigest: postcondition.postSnapshotDigest,
            observationDigest: digest(postcondition),
            receipt: postcondition
        }
    })
    const result = sealResult({
        action: context.action,
        actorRole: stage.role,
        attemptId,
        artifacts
    })
    validateLifecycleStageResult({
        result,
        action: context.action,
        node: context.node
    })
    return result
}

export async function executeWriterLifecycleAction(context = {}) {
    const action = exactAction(context)
    for (const field of ['repositoryPath', 'stateRootPath']) {
        text(context[field], `writer-${field}-required`)
    }
    object(context.node, 'writer-node-required')
    object(context.routingClassification,
        'writer-routing-classification-required')
    object(context.startup, 'writer-startup-required')
    object(context.runtimeTrustBinding, 'writer-trust-required')
    if (!Array.isArray(context.repositoryTargets) ||
        context.repositoryTargets.length === 0) {
        reject('writer-repository-targets-required')
    }
    validateContextAuthority(context, action)
    const stage = stageIdentity(action, context.node)
    if (action.type === 'dispatch-documentation-writer' &&
        context.documentationMode === 'no-change') {
        return executeDocumentationNoChange(context, stage)
    }
    object(context.writerAuthorityAdapter,
        'writer-authority-adapter-required')
    if (typeof context.writerAuthorityAdapter.acquireAndFreeze !==
            'function' ||
        typeof context.writerAuthorityAdapter.compileDispatchRequest !==
            'function') {
        reject('writer-authority-adapter-invalid')
    }
    const authority = validateWriterAuthority({
        action,
        node: context.node,
        stage,
        value: await context.writerAuthorityAdapter.acquireAndFreeze({
            action: structuredClone(action),
            node: structuredClone(context.node),
            stage: structuredClone(stage),
            repositoryPath: context.repositoryPath,
            stateRootPath: context.stateRootPath
        })
    })
    return executeLeasedWriter({ ...context, action }, stage, authority)
}

export const writerLifecycleActionTypes = Object.freeze(
    [...SUPPORTED].sort()
)
