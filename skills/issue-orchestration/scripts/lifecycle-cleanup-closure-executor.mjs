import {
    digest,
    sameValue,
    seal
} from './runtime-contract-lib.mjs'
import {
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    compileLifecycleRunActionSet,
    lifecycleRunObservationContext,
    projectLifecycleRun,
    recordLifecycleCleanupClosureResult,
    recordLifecycleCleanupFinalization,
    recordLifecycleClosureAuthorization,
    recordLifecycleClosureEffect,
    replayLifecycleRunLedger
} from './lifecycle-run-loop.mjs'
import {
    repositoryAuthorityFor,
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'
import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    LIFECYCLE_STAGE_RESULT_SCHEMA,
    validateLifecycleStageResult
} from './lifecycle-stage-admission.mjs'
import {
    authorizeRemoteStagingRefCleanup,
    cleanupRemoteStagingRef,
    compileCandidateLandingMapping,
    confirmGitResourceProcessesStopped,
    createGitResourceCleanup,
    freezeGitResource,
    inventoryGitResource,
    proveCandidateDisposition,
    releaseGitResourceLeaseAndSlot,
    removeGitWorktree,
    retireGitLocalRef,
    sealMachineReceipt,
    validateGitResourceCleanupProposal,
    validateGitResourceCleanupVerification,
    verifyGitResourceCleanup
} from './git-resource-cleanup.mjs'
import {
    cleanupAttemptResources,
    createResourceRegistry,
    verifyCleanupReceipt
} from './resource-lifecycle.mjs'
import {
    authorizeRemoteMutation,
    compileDeliveryControlReceipt,
    observeRemoteMutation,
    validateRemoteStateSnapshot
} from './remote-mutation-authority.mjs'
import {
    evaluateMachineDeliveryClosure
} from './evaluate-delivery-closure.mjs'

const SUPPORTED_ACTION = 'cleanup-node-resources'
const CONTRACT = 'cleanup-and-closure'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

export class LifecycleCleanupClosureExecutorError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecycleCleanupClosureExecutorError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecycleCleanupClosureExecutorError(code, code, details)
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

function receiptDigest(value) {
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

function exactAction(action, actionSet) {
    if (action?.type !== SUPPORTED_ACTION) {
        reject('cleanup-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    try {
        validateLifecycleActionSet(actionSet)
    } catch (error) {
        reject('cleanup-action-set-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        reject('cleanup-action-stale')
    }
    return action
}

function actionForNode(actionSet, nodeId) {
    const action = actionSet.actions.find((candidate) =>
        candidate.type === SUPPORTED_ACTION && candidate.nodeId === nodeId)
    if (!action) reject('cleanup-action-not-current')
    return action
}

function validateAdapter(adapter) {
    object(adapter, 'cleanup-adapter-required')
    for (const method of [
        'prepareCleanup',
        'stopBoundActors',
        'observeIssue',
        'applyRemoteMutation'
    ]) {
        if (typeof adapter[method] !== 'function') {
            reject('cleanup-adapter-invalid', { method })
        }
    }
    return adapter
}

function validateContextAuthority(context, action) {
    const observation = lifecycleRunObservationContext(
        context.ledger,
        { startup: context.startup }
    )
    let authority
    try {
        authority = validateLifecycleRunAuthority(
            observation.lifecycleAuthority,
            {
                startup: context.startup,
                expectedRunId: action.bindings.runId,
                expectedStateRoot: context.stateRootPath
            }
        )
    } catch (error) {
        reject('cleanup-lifecycle-authority-invalid', {
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
            binding.runtimeCapabilityBindingDigest
    }
    for (const [field, value] of Object.entries(expected)) {
        if (action.bindings[field] !== value) {
            reject('cleanup-action-authority-stale', { field })
        }
    }
    if (context.runtimeTrustBinding?.bindingDigest !==
            authority.runtimeTrustBinding.bindingDigest ||
        !sameValue(context.repositoryTargets, authority.repositoryTargets)) {
        reject('cleanup-runtime-authority-stale')
    }
    let repositoryAuthority
    try {
        repositoryAuthority = repositoryAuthorityFor(
            authority,
            action.bindings.repository
        )
    } catch (error) {
        reject('cleanup-repository-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (repositoryAuthority.bindingDigest !==
            action.bindings.repositoryBindingDigest) {
        reject('cleanup-repository-authority-stale')
    }
    return { authority, repositoryAuthority }
}

function validateNode(action, ledger, startup) {
    const replay = replayLifecycleRunLedger(ledger, { startup })
    const node = replay.nodes[action.nodeId]
    if (!node || node.lifecycleState !== 'cleaning' ||
        node.closedAtSequence !== null) {
        reject('cleanup-node-state-invalid')
    }
    const deliveryReceiptDigest = hash(
        receiptDigest(node.receipts.delivery),
        'cleanup-delivery-receipt-required'
    )
    const landingReceiptDigest = hash(
        receiptDigest(node.receipts.deliveryAttempt),
        'cleanup-landing-receipt-required'
    )
    const acceptanceReceiptDigest = hash(
        receiptDigest(node.receipts.acceptanceContract),
        'cleanup-acceptance-receipt-required'
    )
    const verificationReceiptDigest = hash(
        receiptDigest(
            node.receipts.behaviorVerification ?? node.receipts.behavior
        ),
        'cleanup-verification-receipt-required'
    )
    const candidateSha = sha(
        node.receipts.candidate?.evidence?.candidateSha,
        'cleanup-candidate-sha-required'
    )
    const deliveryCommit = sha(
        node.deliveryCommit,
        'cleanup-delivered-commit-required'
    )
    if (action.bindings.receiptDigests.delivery !==
            deliveryReceiptDigest ||
        action.bindings.receiptDigests.deliveryAttempt !==
            landingReceiptDigest ||
        action.bindings.receiptDigests.candidate !==
            receiptDigest(node.receipts.candidate)) {
        reject('cleanup-delivery-binding-stale')
    }
    return {
        node,
        deliveryReceiptDigest,
        landingReceiptDigest,
        acceptanceReceiptDigest,
        verificationReceiptDigest,
        candidateSha,
        deliveryCommit
    }
}

function rootCleanupAuthority(authority, createdAt) {
    return sealMachineReceipt({
        schema: 'issue-orchestration.git-resource-root-authority.v1',
        actorRole: 'root-control',
        runId: authority.binding.runId,
        rootAuthorityEpoch: authority.binding.rootAuthorityEpoch,
        actorInvocationId: authority.binding.runtimeInvocationId,
        issuedAt: createdAt
    }, 'authorityDigest')
}

function validatePrepared(prepared, action, facts, repositoryAuthority) {
    object(prepared, 'cleanup-preparation-invalid')
    const registry = createResourceRegistry(prepared.resourceRegistry)
    object(prepared.baseline, 'cleanup-baseline-required')
    if (!Array.isArray(prepared.gitResources) ||
        prepared.gitResources.length === 0) {
        reject('cleanup-git-resources-required')
    }
    if (registry.runId !== action.bindings.runId ||
        registry.issueId !== action.nodeId ||
        registry.stageAttemptId !== prepared.gitResources[0].attemptId) {
        reject('cleanup-resource-registry-stale')
    }
    const resources = prepared.gitResources.map((value) => {
        object(value, 'cleanup-git-resource-invalid')
        if (value.repository !== action.bindings.repository ||
            value.repositoryPath !== repositoryAuthority.canonicalPath ||
            value.candidateSha !== facts.candidateSha ||
            value.landingCommit !== facts.deliveryCommit ||
            value.baseSha !== action.bindings.baseSha ||
            value.runId !== action.bindings.runId) {
            reject('cleanup-git-resource-stale')
        }
        return clone(value)
    })
    return {
        registry,
        baseline: clone(prepared.baseline),
        gitResources: resources
    }
}

function cleanupProposal(state, action, dirty) {
    const proposal = sealMachineReceipt({
        schema: 'issue-orchestration.git-resource-cleanup-proposal.v1',
        producerAuthority: 'llm-advisor',
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        attemptId: state.attemptId,
        action: dirty
            ? 'quarantine-unmapped-work'
            : 'recompute-candidate-landing-map',
        executionAuthority: false,
        actionDigest: action.actionDigest
    }, 'proposalDigest')
    validateGitResourceCleanupProposal(proposal, state)
    return proposal
}

async function executeGitCleanup({
    descriptor,
    action,
    facts,
    gitAuthority,
    adapter
}) {
    let state = createGitResourceCleanup({
        authority: gitAuthority,
        repositoryId: descriptor.repository,
        repositoryPath: descriptor.repositoryPath,
        worktreePath: descriptor.worktreePath,
        worktreeResourceId: descriptor.worktreeResourceId,
        branchResourceId: descriptor.branchResourceId,
        branchRef: descriptor.branchRef,
        defaultBranchRef: descriptor.defaultBranchRef,
        baseSha: descriptor.baseSha,
        candidateSha: descriptor.candidateSha,
        deliveryEpoch: descriptor.deliveryEpoch,
        attemptId: descriptor.attemptId,
        stageRole: descriptor.stageRole,
        sliceId: descriptor.sliceId,
        leaseId: descriptor.leaseId,
        leasePath: descriptor.leasePath,
        slotId: descriptor.slotId,
        resourceActorInvocationIds:
            descriptor.resourceActorInvocationIds ?? [],
        remoteName: descriptor.remoteName ?? null,
        remoteRef: descriptor.remoteRef ?? null,
        remoteExpectedSha: descriptor.remoteExpectedSha ?? null
    })
    state = freezeGitResource({
        state,
        authority: gitAuthority,
        dispatchBlocked: true,
        writerAuthorityRevoked: true,
        cleanupAuthorityPreserved: true
    }).state
    const inventoried = inventoryGitResource({
        state,
        authority: gitAuthority
    })
    state = inventoried.state
    const proposal = cleanupProposal(
        state,
        action,
        inventoried.inventory.dirty
    )
    let disposition
    let mapping = null
    if (inventoried.inventory.dirty) {
        disposition = proveCandidateDisposition({
            state,
            authority: gitAuthority,
            inventory: inventoried.inventory,
            disposition: 'quarantined',
            quarantineRoot: text(
                descriptor.quarantineRoot,
                'cleanup-quarantine-root-required'
            ),
            reasonCodes: ['dirty-or-unmapped-work']
        })
    } else {
        mapping = compileCandidateLandingMapping({
            state,
            inventory: inventoried.inventory,
            landingCommit: descriptor.landingCommit
        })
        disposition = proveCandidateDisposition({
            state,
            authority: gitAuthority,
            inventory: inventoried.inventory,
            disposition: 'landed',
            landingMapping: mapping,
            acceptanceReceiptDigest: facts.acceptanceReceiptDigest,
            verificationReceiptDigest: facts.verificationReceiptDigest,
            landingReceiptDigest: facts.landingReceiptDigest
        })
    }
    state = disposition.state
    const shutdown = object(await adapter.stopBoundActors({
        action: clone(action),
        descriptor: clone(descriptor),
        inventory: clone(inventoried.inventory),
        resourceActorInvocationIds:
            clone(descriptor.resourceActorInvocationIds ?? [])
    }), 'cleanup-actor-shutdown-invalid')
    state = confirmGitResourceProcessesStopped({
        state,
        authority: gitAuthority,
        actorShutdownReceipts:
            shutdown.actorShutdownReceipts ?? []
    }).state
    const removed = removeGitWorktree({
        state,
        authority: gitAuthority,
        inventory: inventoried.inventory
    })
    state = removed.state
    const retired = retireGitLocalRef({
        state,
        authority: gitAuthority,
        inventory: inventoried.inventory
    })
    state = retired.state
    let remoteCleanupReceipt = null
    if (descriptor.remoteRef) {
        const remoteAuthorization =
            authorizeRemoteStagingRefCleanup({
                state,
                authority: gitAuthority
            })
        remoteCleanupReceipt = cleanupRemoteStagingRef({
            state,
            authority: gitAuthority,
            remoteMutationAuthorization: remoteAuthorization
        })
    }
    const released = releaseGitResourceLeaseAndSlot({
        state,
        authority: gitAuthority,
        inventory: inventoried.inventory,
        remoteCleanupReceipt,
        slotReleaseObservation: descriptor.slotReleaseObservation
    })
    const verified = verifyGitResourceCleanup({
        state: released.state,
        inventory: inventoried.inventory,
        remoteCleanupReceipt
    })
    validateGitResourceCleanupVerification(verified.receipt, {
        runId: action.bindings.runId,
        attemptId: descriptor.attemptId,
        worktreeResourceId: descriptor.worktreeResourceId,
        branchResourceId: descriptor.branchResourceId,
        leaseId: descriptor.leaseId
    })
    return {
        proposal,
        inventory: inventoried.inventory,
        dispositionReceipt: disposition.receipt,
        landingMapping: mapping,
        verification: verified.receipt,
        observation: verified.observation
    }
}

function sealCleanupState({
    action,
    facts,
    gitResults,
    resourceCleanupReceipt,
    resourceObservation
}) {
    const cleanupReceipt = seal({
        schema: 'issue-orchestration.cleanup-finalization-receipt.v1',
        producerAuthority: 'cleanup-finalization-validator',
        status: 'verified',
        runId: action.bindings.runId,
        nodeId: action.nodeId,
        deliveryReceiptDigest: facts.deliveryReceiptDigest,
        deliveredCommit: facts.deliveryCommit,
        gitCleanupVerificationDigests: gitResults.map(({ verification }) =>
            verification.receiptDigest),
        candidateDispositionDigests: gitResults.map(
            ({ dispositionReceipt }) => dispositionReceipt.receiptDigest
        ),
        resourceCleanupReceiptDigest:
            resourceCleanupReceipt.receiptDigest,
        inventoryDigest: digest({
            gitInventories: gitResults.map(({ inventory }) =>
                inventory.inventoryDigest),
            resourceObservation:
                resourceObservation?.observationDigest ??
                resourceCleanupReceipt.postCleanupInventoryDigest
        }),
        residualOwnedResources: [],
        finalizedAt: resourceCleanupReceipt.verifiedAt
    }, 'receiptDigest')
    const state = {
        cleanupReceipt,
        proposals: gitResults.map(({ proposal }) => proposal),
        gitCleanupVerifications: gitResults.map(({ verification }) =>
            verification),
        candidateDispositionReceipts: gitResults.map(
            ({ dispositionReceipt }) => dispositionReceipt
        ),
        resourceCleanupReceipt
    }
    state.cleanupStateDigest = digest(state)
    return state
}

async function performCleanup({
    context,
    adapter,
    action,
    authority,
    repositoryAuthority,
    facts,
    createdAt
}) {
    const prepared = validatePrepared(
        await adapter.prepareCleanup({
            action: clone(action),
            node: clone(facts.node),
            deliveryCommit: facts.deliveryCommit,
            deliveryReceiptDigest: facts.deliveryReceiptDigest,
            repositoryPath: repositoryAuthority.canonicalPath,
            stateRootPath: context.stateRootPath
        }),
        action,
        facts,
        repositoryAuthority
    )
    const gitAuthority = rootCleanupAuthority(authority, createdAt)
    const gitResults = []
    for (const descriptor of prepared.gitResources) {
        gitResults.push(await executeGitCleanup({
            descriptor,
            action,
            facts,
            gitAuthority,
            adapter
        }))
    }
    const resourceCleanup = await cleanupAttemptResources({
        registry: prepared.registry,
        baseline: prepared.baseline,
        actorRole: 'machine-resource-verifier',
        gitCleanupVerifications: gitResults.map(({ verification }) =>
            verification)
    })
    try {
        verifyCleanupReceipt(resourceCleanup.receipt)
    } catch (error) {
        reject('cleanup-resource-verification-failed', {
            cause: error?.code ?? error?.message,
            failedResources: resourceCleanup.receipt?.failedResources ?? []
        })
    }
    if (gitResults.some(({ verification }) =>
        verification.deliveryClean !== true) ||
        resourceCleanup.receipt.quarantinedResources.length > 0) {
        reject('cleanup-recoverable-work-quarantined', {
            verificationDigests: gitResults.map(({ verification }) =>
                verification.receiptDigest)
        })
    }
    return sealCleanupState({
        action,
        facts,
        gitResults,
        resourceCleanupReceipt: resourceCleanup.receipt,
        resourceObservation: resourceCleanup.observation
    })
}

function issueObservation(value, phase, action) {
    object(value, 'cleanup-remote-observation-invalid')
    validateRemoteStateSnapshot(value.snapshot)
    if (value.snapshot.repository !== action.bindings.repository ||
        value.snapshot.issueId !== action.nodeId ||
        value.snapshot.issueStateDigest !== digest({
            issueState: value.issueState,
            stateReason: value.stateReason ?? null
        })) {
        reject('cleanup-remote-observation-stale', { phase })
    }
    return {
        snapshot: clone(value.snapshot),
        issueState: value.issueState,
        stateReason: value.stateReason ?? null
    }
}

function effectIdFor(action, cleanupReceiptDigest) {
    return `closure:${digest({
        runId: action.bindings.runId,
        nodeId: action.nodeId,
        cleanupReceiptDigest
    })}`
}

function timestampSet(context) {
    const issuedAt = text(
        context.timestamps?.issuedAt ?? context.createdAt,
        'cleanup-issued-at-required'
    )
    const observedAt = text(
        context.timestamps?.observedAt ?? issuedAt,
        'cleanup-observed-at-required'
    )
    const expiresAt = context.timestamps?.expiresAt ??
        new Date(Date.parse(issuedAt) + 240_000).toISOString()
    if (![issuedAt, observedAt, expiresAt].every((value) =>
        Number.isFinite(Date.parse(value)))) {
        reject('cleanup-timestamp-invalid')
    }
    return { issuedAt, observedAt, expiresAt }
}

function expectedPostStateDigest(action, cleanupReceiptDigest) {
    return digest({
        repository: action.bindings.repository,
        issueId: action.nodeId,
        issueState: 'CLOSED',
        stateReason: 'COMPLETED',
        cleanupReceiptDigest
    })
}

function compileClosureAuthorization({
    context,
    action,
    facts,
    cleanupState,
    pre,
    timestamps
}) {
    const cleanupReceiptDigest =
        cleanupState.cleanupReceipt.receiptDigest
    const expected = expectedPostStateDigest(
        action,
        cleanupReceiptDigest
    )
    const mutation = {
        action: 'state-transition',
        evidence: {
            terminalEvidenceDigest: cleanupReceiptDigest,
            expectedIssueStateDigest: expected,
            stateTransitionDigest: digest({
                fromState: pre.issueState,
                fromReason: pre.stateReason,
                toState: 'CLOSED',
                toReason: 'COMPLETED',
                issueId: action.nodeId
            })
        }
    }
    const control = compileDeliveryControlReceipt({
        runId: action.bindings.runId,
        deliveryEpoch: `cleanup-closure:${action.bindings.nodeEpoch}`,
        rootControlLeaseDigest: context.rootControlLeaseDigest,
        runtimeExecutionBinding: context.runtimeExecutionBinding,
        startup: context.startup,
        runtimeTrustBinding: context.runtimeTrustBinding,
        repositoryTargets: context.repositoryTargets,
        repository: action.bindings.repository,
        issueId: action.nodeId,
        candidateSha: facts.deliveryCommit,
        defaultBranchSha: pre.snapshot.defaultBranchSha,
        terminalEvidenceDigest: cleanupReceiptDigest,
        mutation,
        expectedPostStateDigest: expected,
        preRemoteSnapshot: pre.snapshot,
        issuedAt: timestamps.issuedAt,
        expiresAt: timestamps.expiresAt
    })
    return {
        effectId: effectIdFor(action, cleanupReceiptDigest),
        cleanupReceiptDigest,
        expectedPostStateDigest: expected,
        deliveryControlReceipt: control,
        preRemoteSnapshot: pre.snapshot,
        preIssueState: pre.issueState,
        preStateReason: pre.stateReason
    }
}

async function observeAndRecordClosureEffect({
    context,
    adapter,
    action,
    actionSet,
    authorization,
    timestamps,
    createdAt
}) {
    const current = issueObservation(await adapter.observeIssue({
        action: clone(action),
        phase: 'pre-or-recovery',
        expectedIssueState: authorization.preIssueState,
        expectedStateReason: authorization.preStateReason
    }), 'pre-or-recovery', action)
    let post
    if (current.issueState === 'CLOSED' &&
        current.stateReason === 'COMPLETED') {
        post = current
    } else {
        if (current.snapshot.snapshotDigest !==
                authorization.preRemoteSnapshot.snapshotDigest ||
            current.issueState !== authorization.preIssueState ||
            current.stateReason !== authorization.preStateReason) {
            reject('cleanup-close-authority-stale-before-mutation')
        }
        const authorized = authorizeRemoteMutation({
            deliveryControlReceipt:
                authorization.deliveryControlReceipt,
            runtimeExecutionBinding: context.runtimeExecutionBinding,
            currentRemoteSnapshot: current.snapshot,
            now: timestamps.observedAt,
            consumedKeys: []
        })
        await adapter.applyRemoteMutation({
            action: clone(action),
            mutation: clone(authorized.mutation),
            consumptionKey: authorized.consumptionKey,
            deliveryControlReceipt:
                clone(authorization.deliveryControlReceipt)
        })
        post = issueObservation(await adapter.observeIssue({
            action: clone(action),
            phase: 'post-mutation',
            expectedIssueState: 'CLOSED',
            expectedStateReason: 'COMPLETED'
        }), 'post-mutation', action)
    }
    if (post.issueState !== 'CLOSED' ||
        post.stateReason !== 'COMPLETED') {
        reject('cleanup-close-postcondition-failed')
    }
    const mutationReceipt = observeRemoteMutation({
        actorExecutionClass: 'root-control',
        actorInvocationId:
            context.runtimeExecutionBinding.actorInvocationId,
        mutation: authorization.deliveryControlReceipt.mutation,
        preRemoteSnapshot: authorization.preRemoteSnapshot,
        postRemoteSnapshot: post.snapshot,
        observedPostStateDigest: authorization.expectedPostStateDigest,
        deliveryControlReceipt:
            authorization.deliveryControlReceipt,
        observedAt: timestamps.observedAt
    })
    if (mutationReceipt.status !== 'verified' ||
        mutationReceipt.violationCodes.length !== 0) {
        reject('cleanup-close-mutation-not-verified', {
            violationCodes: mutationReceipt.violationCodes
        })
    }
    const cleanupState = action.bindings.cleanupFinalization
        ?.cleanupArtifacts
    const closureReceipt = evaluateMachineDeliveryClosure({
        cleanupReceipt: cleanupState.cleanupReceipt,
        preRemoteSnapshot: authorization.preRemoteSnapshot,
        postRemoteSnapshot: post.snapshot,
        issueState: post.issueState,
        stateReason: post.stateReason,
        evaluatedAt: timestamps.observedAt
    })
    const effectState = {
        effectId: authorization.effectId,
        cleanupReceiptDigest: authorization.cleanupReceiptDigest,
        postRemoteSnapshot: post.snapshot,
        remoteMutationReceipt: mutationReceipt,
        closureReceipt
    }
    const ledger = recordLifecycleClosureEffect({
        ledger: context.ledger,
        actionSet,
        action,
        effectId: authorization.effectId,
        effectState,
        createdAt,
        startup: context.startup
    })
    return { ledger, effectState }
}

function admissionBinding(action) {
    return {
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId,
        bindings: clone(action.bindings)
    }
}

function sealArtifact({ action, kind, evidence }) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[CONTRACT]
        .artifactSet[kind]
    const artifact = {
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
    artifact[spec.digestField] = digest(artifact)
    return artifact
}

function artifactDigest(artifacts, kind) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[CONTRACT]
        .artifactSet[kind]
    return artifacts[kind][spec.digestField]
}

function buildStageResult({ action, cleanupState, authorization, effect }) {
    const artifacts = {}
    const put = (kind, evidence) => {
        artifacts[kind] = sealArtifact({ action, kind, evidence })
    }
    const d = (kind) => artifactDigest(artifacts, kind)
    put('cleanupAuthorization', {
        deliveryReceiptDigest:
            cleanupState.cleanupReceipt.deliveryReceiptDigest,
        resourceInventoryDigest:
            cleanupState.cleanupReceipt.inventoryDigest,
        cleanupProposalDigests: cleanupState.proposals.map(({ proposalDigest }) =>
            proposalDigest)
    })
    put('gitCleanupVerification', {
        postCleanupObservationDigest: digest(
            cleanupState.gitCleanupVerifications.map((receipt) =>
                receipt.postCleanupObservationDigest)
        ),
        candidateDispositionDigest: digest(
            cleanupState.candidateDispositionReceipts.map((receipt) =>
                receipt.receiptDigest)
        ),
        status: 'verified',
        violations: [],
        verificationReceiptDigests:
            cleanupState.gitCleanupVerifications.map(({ receiptDigest }) =>
                receiptDigest)
    })
    put('resourceCleanup', {
        inventoryDigest:
            cleanupState.resourceCleanupReceipt
                .postCleanupInventoryDigest,
        status: 'verified',
        residualOwnedResources: [],
        resourceCleanupReceiptDigest:
            cleanupState.resourceCleanupReceipt.receiptDigest
    })
    put('cleanup', {
        gitCleanupVerificationDigest: d('gitCleanupVerification'),
        resourceCleanupReceiptDigest: d('resourceCleanup'),
        status: 'verified',
        machineCleanupReceiptDigest:
            cleanupState.cleanupReceipt.receiptDigest
    })
    put('remoteCloseAuthority', {
        cleanupReceiptDigest: d('cleanup'),
        expectedPostStateDigest:
            authorization.expectedPostStateDigest,
        status: 'authorized',
        deliveryControlReceiptDigest:
            authorization.deliveryControlReceipt.receiptDigest
    })
    put('remotePreSnapshot', {
        remoteStateDigest:
            authorization.preRemoteSnapshot.issueStateDigest,
        snapshotKind: 'pre-mutation',
        machineSnapshotDigest:
            authorization.preRemoteSnapshot.snapshotDigest
    })
    put('remotePostSnapshot', {
        remoteStateDigest: effect.postRemoteSnapshot.issueStateDigest,
        snapshotKind: 'post-mutation',
        machineSnapshotDigest:
            effect.postRemoteSnapshot.snapshotDigest
    })
    put('closure', {
        cleanupReceiptDigest: d('cleanup'),
        remotePreSnapshotDigest: d('remotePreSnapshot'),
        remotePostSnapshotDigest: d('remotePostSnapshot'),
        issueState: 'CLOSED',
        stateReason: 'COMPLETED',
        machineClosureReceiptDigest:
            effect.closureReceipt.receiptDigest,
        remoteMutationReceiptDigest:
            effect.remoteMutationReceipt.receiptDigest
    })
    const result = {
        schema: LIFECYCLE_STAGE_RESULT_SCHEMA,
        producerAuthority: 'cleanup-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId,
        actorRole: 'root-cleanup-adapter',
        attemptId: null,
        artifacts,
        artifactsDigest: digest(artifacts)
    }
    result.resultDigest = digest(result)
    validateLifecycleStageResult({ result, action, node: null })
    return Object.freeze(result)
}

async function completePendingEffect({
    context,
    adapter,
    action,
    actionSet,
    pending,
    createdAt
}) {
    const observed = issueObservation(await adapter.observeIssue({
        action: clone(action),
        phase: 'reobserve-post-mutation',
        expectedIssueState: 'CLOSED',
        expectedStateReason: 'COMPLETED'
    }), 'reobserve-post-mutation', action)
    if (observed.issueState !== 'CLOSED' ||
        observed.stateReason !== 'COMPLETED' ||
        observed.snapshot.snapshotDigest !==
            pending.effectState.postRemoteSnapshot.snapshotDigest) {
        reject('cleanup-close-effect-stale')
    }
    const result = buildStageResult({
        action,
        cleanupState: pending.authorizationState.cleanupState,
        authorization: pending.authorizationState,
        effect: pending.effectState
    })
    const ledger = recordLifecycleCleanupClosureResult({
        ledger: context.ledger,
        actionSet,
        action,
        result,
        createdAt,
        startup: context.startup
    })
    return { ledger, result }
}

export async function executeLifecycleCleanupClosureAction(context = {}) {
    let action = exactAction(context.action, context.actionSet)
    let actionSet = context.actionSet
    const adapter = validateAdapter(context.cleanupAdapter)
    const createdAt = text(
        context.createdAt,
        'cleanup-created-at-required'
    )
    const timestamps = timestampSet(context)
    const { authority, repositoryAuthority } =
        validateContextAuthority(context, action)
    let facts = validateNode(action, context.ledger, context.startup)
    let projection = projectLifecycleRun(context.ledger, {
        startup: context.startup
    }).aggregateProjection
    if (projection.closureEffects[action.nodeId]) {
        reject('cleanup-closure-already-completed')
    }
    const pendingEffect = projection.pendingClosureEffects[action.nodeId]
    if (pendingEffect) {
        return completePendingEffect({
            context,
            adapter,
            action,
            actionSet,
            pending: pendingEffect,
            createdAt
        })
    }
    let ledger = context.ledger
    let finalization = projection.cleanupFinalizations[action.nodeId]
    if (!finalization) {
        const cleanupState = await performCleanup({
            context,
            adapter,
            action,
            authority,
            repositoryAuthority,
            facts,
            createdAt
        })
        ledger = recordLifecycleCleanupFinalization({
            ledger,
            actionSet,
            action,
            cleanupState,
            createdAt,
            startup: context.startup
        })
        context = { ...context, ledger }
        actionSet = compileLifecycleRunActionSet(ledger, {
            startup: context.startup
        })
        action = actionForNode(actionSet, action.nodeId)
        facts = validateNode(action, ledger, context.startup)
        projection = projectLifecycleRun(ledger, {
            startup: context.startup
        }).aggregateProjection
        finalization = projection.cleanupFinalizations[action.nodeId]
        if (context.interruptAfterCleanup === true) {
            reject('cleanup-interrupted-after-finalization', {
                ledger,
                cleanupReceiptDigest:
                    finalization.cleanupReceiptDigest
            })
        }
    }
    let authorization =
        projection.pendingClosureAuthorizations[action.nodeId]
            ?.authorizationState ?? null
    if (!authorization) {
        const pre = issueObservation(await adapter.observeIssue({
            action: clone(action),
            phase: 'pre-close',
            expectedIssueState: 'OPEN',
            expectedStateReason: null
        }), 'pre-close', action)
        if (pre.issueState === 'CLOSED' &&
            pre.stateReason === 'COMPLETED') {
            reject('cleanup-close-observed-without-authorization')
        }
        authorization = compileClosureAuthorization({
            context,
            action,
            facts,
            cleanupState: finalization.cleanupArtifacts,
            pre,
            timestamps
        })
        authorization.cleanupState =
            clone(finalization.cleanupArtifacts)
        ledger = recordLifecycleClosureAuthorization({
            ledger,
            actionSet,
            action,
            effectId: authorization.effectId,
            authorizationState: authorization,
            createdAt,
            startup: context.startup
        })
        context = { ...context, ledger }
        actionSet = compileLifecycleRunActionSet(ledger, {
            startup: context.startup
        })
        action = actionForNode(actionSet, action.nodeId)
        if (context.interruptAfterAuthorization === true) {
            reject('cleanup-interrupted-after-authorization', {
                ledger,
                effectId: authorization.effectId
            })
        }
    }
    const effect = await observeAndRecordClosureEffect({
        context,
        adapter,
        action,
        actionSet,
        authorization,
        timestamps,
        createdAt
    })
    ledger = effect.ledger
    if (context.interruptAfterRemoteEffect === true) {
        reject('cleanup-interrupted-after-remote-effect', {
            ledger,
            effectId: authorization.effectId
        })
    }
    actionSet = compileLifecycleRunActionSet(ledger, {
        startup: context.startup
    })
    action = actionForNode(actionSet, action.nodeId)
    projection = projectLifecycleRun(ledger, {
        startup: context.startup
    }).aggregateProjection
    const pending = projection.pendingClosureEffects[action.nodeId]
    return completePendingEffect({
        context: { ...context, ledger },
        adapter,
        action,
        actionSet,
        pending,
        createdAt
    })
}

export const lifecycleCleanupClosureActionTypes = Object.freeze([
    SUPPORTED_ACTION
])
