import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    acquireLifecycleDeliveryFreeze,
    compileLifecycleRunActionSet,
    lifecycleRunObservationContext,
    projectLifecycleRun,
    recordLifecycleActionResults,
    releaseLifecycleDeliveryFreeze,
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
    acquireRepositoryLandingLease,
    bindLandingSlice,
    createLandingAttempt,
    createRepositoryLandingLane,
    finalizeLanding,
    recordCommitTransplant,
    recordEvidenceRebinding,
    recordReverificationReceipt,
    releaseRepositoryLandingLease
} from './repository-landing-lane.mjs'
import {
    authorizeRemoteMutation,
    compileDeliveryControlReceipt,
    observeRemoteMutation,
    validateRemoteStateSnapshot
} from './remote-mutation-authority.mjs'

const SUPPORTED_ACTION = 'deliver-acceptance-group'
const CONTRACT_REMOTE = 'delivery-remote-effect'
const CONTRACT_COMPLETE = 'delivery-completed'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

export class LifecycleDeliveryExecutorError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecycleDeliveryExecutorError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecycleDeliveryExecutorError(code, code, details)
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

function exactAction(action, actionSet) {
    if (action?.type !== SUPPORTED_ACTION) {
        reject('delivery-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    try {
        validateLifecycleActionSet(actionSet)
    } catch (error) {
        reject('delivery-action-set-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        reject('delivery-action-stale')
    }
    return action
}

function actionForGroup(actionSet, groupId) {
    const action = actionSet.actions.find((candidate) =>
        candidate.type === SUPPORTED_ACTION &&
        candidate.acceptanceGroup === groupId)
    if (!action) reject('delivery-action-not-current')
    return action
}

function validateAdapter(adapter) {
    object(adapter, 'delivery-adapter-required')
    for (const method of [
        'observeRepository',
        'prepareLanding',
        'prepareLandingSlice',
        'transplantMember',
        'reverifyMember',
        'applyRemoteMutation'
    ]) {
        if (typeof adapter[method] !== 'function') {
            reject('delivery-adapter-invalid', { method })
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
        reject('delivery-lifecycle-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const binding = authority.binding
    const expectedTop = {
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
    for (const [field, value] of Object.entries(expectedTop)) {
        if (action.bindings[field] !== value) {
            reject('delivery-action-authority-stale', { field })
        }
    }
    if (context.runtimeTrustBinding?.bindingDigest !==
            authority.runtimeTrustBinding.bindingDigest ||
        !sameValue(context.repositoryTargets, authority.repositoryTargets)) {
        reject('delivery-runtime-authority-stale')
    }
    for (const member of action.bindings.memberBindings) {
        let repositoryAuthority
        try {
            repositoryAuthority = repositoryAuthorityFor(
                authority,
                member.repository
            )
        } catch (error) {
            reject('delivery-repository-authority-invalid', {
                repository: member.repository,
                cause: error?.code ?? error?.message
            })
        }
        if (member.repositoryBindingDigest !==
                repositoryAuthority.bindingDigest ||
            member.baseSha !==
                repositoryAuthority.observedDefaultBranchHead) {
            reject('delivery-repository-authority-stale', {
                repository: member.repository
            })
        }
    }
    return authority
}

function receiptDigestMap(receipts, keys) {
    return Object.fromEntries(keys.map((key) => {
        const value = receipts[key]
        const valueDigest = digestOf(value)
        if (!HASH.test(valueDigest ?? '')) {
            reject('delivery-member-evidence-incomplete', { key })
        }
        return [key, valueDigest]
    }))
}

function validateMemberEvidenceChain(node, graphNode) {
    const receipts = node.receipts ?? {}
    const candidate = receipts.candidate
    const candidateSha = candidate?.evidence?.candidateSha
    sha(candidateSha, 'delivery-member-candidate-required')
    const candidateDigest = hash(
        digestOf(candidate),
        'delivery-member-candidate-receipt-required'
    )
    const acceptanceContractDigest = hash(
        digestOf(receipts.acceptanceContract),
        'delivery-member-acceptance-contract-required'
    )
    const testContractDigest = hash(
        digestOf(receipts.testContractWriter),
        'delivery-member-test-contract-required'
    )
    const behaviorDigest = hash(
        digestOf(receipts.behavior),
        'delivery-member-behavior-required'
    )
    const behaviorVerificationDigest = hash(
        digestOf(receipts.behaviorVerification),
        'delivery-member-behavior-verification-required'
    )
    if (receipts.behavior.evidence?.candidateSha !== candidateSha ||
        receipts.behaviorVerification.evidence?.candidateSha !==
            candidateSha ||
        receipts.behaviorVerification.evidence?.behaviorReceiptDigest !==
            behaviorDigest) {
        reject('delivery-member-behavior-chain-stale')
    }
    const requiredEvidence = [
        'acceptanceContract',
        'testContractWriter',
        'candidate',
        'behavior',
        'behaviorVerification'
    ]
    if (graphNode.uiClass === 'ui') {
        requiredEvidence.push(
            'uiAdjudication',
            'renderEvidence',
            'interactionEvidence',
            'accessibilityEvidence',
            'uxAcceptance'
        )
        const uiAdjudicationDigest = hash(
            digestOf(receipts.uiAdjudication),
            'delivery-member-ui-adjudication-required'
        )
        const renderEvidenceDigest = hash(
            digestOf(receipts.renderEvidence),
            'delivery-member-render-evidence-required'
        )
        const interactionEvidenceDigest = hash(
            digestOf(receipts.interactionEvidence),
            'delivery-member-interaction-evidence-required'
        )
        const accessibilityEvidenceDigest = hash(
            digestOf(receipts.accessibilityEvidence),
            'delivery-member-accessibility-evidence-required'
        )
        const uxAcceptance = receipts.uxAcceptance
        hash(
            digestOf(uxAcceptance),
            'delivery-member-ux-acceptance-required'
        )
        if (receipts.uiAdjudication.evidence?.candidateDigest !==
                candidateDigest ||
            receipts.uiAdjudication.evidence?.acceptanceContractDigest !==
                acceptanceContractDigest ||
            uxAcceptance.evidence?.candidateSha !== candidateSha ||
            uxAcceptance.evidence?.uiAdjudicationDigest !==
                uiAdjudicationDigest ||
            uxAcceptance.evidence?.renderEvidenceDigest !==
                renderEvidenceDigest ||
            uxAcceptance.evidence?.interactionEvidenceDigest !==
                interactionEvidenceDigest ||
            uxAcceptance.evidence?.accessibilityEvidenceDigest !==
                accessibilityEvidenceDigest ||
            uxAcceptance.evidence?.status !== 'accepted') {
            reject('delivery-member-ux-chain-stale')
        }
    }
    if (receipts.documentationRequired === true) {
        requiredEvidence.push('documentation')
        const documentationDigest = hash(
            digestOf(receipts.documentation),
            'delivery-member-documentation-required'
        )
        if (receipts.documentation.evidence?.mode === 'no-change') {
            requiredEvidence.push('documentationNoChange')
            if (receipts.documentationNoChange?.evidence
                ?.documentationReceiptDigest !== documentationDigest ||
                receipts.documentationNoChange?.evidence?.status !==
                    'verified') {
                reject('delivery-member-documentation-chain-stale')
            }
        }
    }
    return {
        candidateSha,
        testContractDigest,
        evidenceDigests: receiptDigestMap(receipts, requiredEvidence)
    }
}

function validateMembers({ action, projection }) {
    const groupId = text(
        action.acceptanceGroup,
        'delivery-group-required'
    )
    const boundMembers = action.bindings.memberBindings
    if (!Array.isArray(boundMembers) || boundMembers.length === 0) {
        reject('delivery-member-bindings-required')
    }
    const projectedMembers = projection.aggregateProjection
        .acceptanceGroups?.[groupId] ?? boundMembers.map(({ nodeId }) => nodeId)
    const boundIds = boundMembers.map(({ nodeId }) => nodeId)
    if (!sameValue([...projectedMembers], boundIds)) {
        reject('delivery-group-membership-stale')
    }
    const graphById = new Map(projection.semanticGraph.nodes.map((node) => [
        node.memberId,
        node
    ]))
    const pending = projection.aggregateProjection
        .pendingDeliveryEffects?.[groupId] ?? null
    return boundMembers.map((binding) => {
        const node = projection.state.nodes[binding.nodeId]
        const aggregateNode = projection.aggregateProjection
            .nodes[binding.nodeId]
        const graphNode = graphById.get(binding.nodeId)
        if (!node || !aggregateNode || !graphNode ||
            aggregateNode.blockedBy?.length ||
            aggregateNode.quarantine ||
            aggregateNode.activeAttemptId ||
            (![
                'behavior-green',
                'ux-accepted',
                'documentation-green',
                'delivery-ready',
                'delivering'
            ].includes(node.lifecycleState) &&
                !(pending && node.lifecycleState === 'cleaning' &&
                    node.deliveryCommit === pending.commits?.[
                        binding.nodeId
                    ]))) {
            reject('delivery-member-not-ready', {
                nodeId: binding.nodeId,
                lifecycleState: node?.lifecycleState ?? null
            })
        }
        if (binding.priorLedgerHeadDigest !==
                aggregateNode.ledgerHeadDigest ||
            binding.nodeProjectionDigest !==
                aggregateNode.nodeProjectionDigest ||
            binding.nodeEpoch !== aggregateNode.nodeEpoch ||
            binding.baseSha !== aggregateNode.baseSha) {
            reject('delivery-member-binding-stale', {
                nodeId: binding.nodeId
            })
        }
        const {
            candidateSha,
            testContractDigest,
            evidenceDigests
        } = validateMemberEvidenceChain(node, graphNode)
        return Object.freeze({
            nodeId: binding.nodeId,
            memberId: binding.memberId,
            repository: binding.repository,
            issueNumber: binding.issueNumber,
            issueId: `${binding.repository}#${binding.issueNumber}`,
            baseSha: binding.baseSha,
            nodeEpoch: binding.nodeEpoch,
            candidateSha,
            testContractDigest,
            uiClass: graphNode.uiClass,
            documentationRequired:
                node.receipts?.documentationRequired === true,
            evidenceDigests,
            evidenceSetDigest: digest(evidenceDigests)
        })
    })
}

function groupByRepository(members) {
    const groups = new Map()
    for (const member of members) {
        const list = groups.get(member.repository) ?? []
        list.push(member)
        groups.set(member.repository, list)
    }
    return [...groups.entries()].sort(([left], [right]) =>
        left.localeCompare(right)).map(([repository, repositoryMembers]) => ({
        repository,
        members: repositoryMembers
    }))
}

function validateRemoteSnapshot(snapshot, {
    repository,
    representativeIssueId,
    expectedHead = null,
    expectedIssueStateDigest = null
}) {
    try {
        validateRemoteStateSnapshot(snapshot)
    } catch (error) {
        reject('delivery-remote-snapshot-invalid', {
            repository,
            cause: error?.code ?? error?.message
        })
    }
    if (snapshot.repository !== repository ||
        snapshot.issueId !== representativeIssueId ||
        (expectedHead !== null &&
            snapshot.defaultBranchSha !== expectedHead) ||
        (expectedIssueStateDigest !== null &&
            snapshot.issueStateDigest !== expectedIssueStateDigest)) {
        reject('delivery-remote-snapshot-stale', { repository })
    }
    return snapshot
}

async function observeRepositories({
    adapter,
    repositories,
    phase,
    expectedEffects = null,
    action,
    groupId
}) {
    const snapshots = []
    for (const entry of repositories) {
        const expected = expectedEffects?.find((effect) =>
            effect.repository === entry.repository) ?? null
        const representativeIssueId = expected?.issueId ??
            entry.members[0].issueId
        const snapshot = await adapter.observeRepository({
            phase,
            action: clone(action),
            groupId,
            repository: entry.repository,
            members: clone(entry.members),
            representativeIssueId,
            expectedDefaultBranchSha:
                expected?.resultingRemoteSha ?? entry.members[0].baseSha,
            expectedIssueStateDigest:
                expected?.issueStateDigest ?? null
        })
        snapshots.push(validateRemoteSnapshot(snapshot, {
            repository: entry.repository,
            representativeIssueId,
            expectedHead: expected?.resultingRemoteSha ??
                entry.members[0].baseSha,
            expectedIssueStateDigest:
                expected?.issueStateDigest ?? null
        }))
    }
    return snapshots
}

function validateLandingHandoff(plan, repositoryEntry, groupId) {
    const handoff = plan?.handoff
    object(plan, 'delivery-landing-plan-invalid')
    object(handoff, 'delivery-landing-handoff-required')
    if (handoff.repository !== repositoryEntry.repository ||
        handoff.groupId !== groupId) {
        reject('delivery-landing-handoff-stale', {
            repository: repositoryEntry.repository
        })
    }
    const expectedMembers = repositoryEntry.members
        .map(({ issueId }) => issueId).sort()
    const actualMembers = Object.keys(handoff.memberMapping ?? {}).sort()
    if (!sameValue(actualMembers, expectedMembers)) {
        reject('delivery-landing-member-mapping-stale', {
            repository: repositoryEntry.repository
        })
    }
    const expectedSourceCommits = repositoryEntry.members.map(
        ({ candidateSha }) => candidateSha
    )
    if (handoff.sourceBase !== repositoryEntry.members[0].baseSha ||
        !sameValue(
            handoff.orderedGreenCommitPrefix,
            expectedSourceCommits
        ) ||
        handoff.immutableSourceTip !== expectedSourceCommits.at(-1) ||
        !handoff.requiredReverificationClasses.includes('behavior')) {
        reject('delivery-landing-source-identity-stale', {
            repository: repositoryEntry.repository
        })
    }
    for (const member of repositoryEntry.members) {
        const mapping = handoff.memberMapping[member.issueId]
        if (mapping?.candidateSha !== member.candidateSha ||
            mapping?.commitSha !== member.candidateSha ||
            mapping?.testContractDigest !== member.testContractDigest) {
            reject('delivery-landing-candidate-mapping-stale', {
                nodeId: member.nodeId
            })
        }
        const expectedEvidence = Object.fromEntries(
            Object.entries(member.evidenceDigests)
                .filter(([key]) => key !== 'candidate')
        )
        const mappedEvidence = mapping.receiptDigests ?? {}
        if (!sameValue(mappedEvidence, expectedEvidence)) {
            reject('delivery-landing-evidence-mapping-stale', {
                nodeId: member.nodeId
            })
        }
    }
    return plan
}

async function executeRepositoryLanding({
    adapter,
    action,
    groupId,
    repositoryEntry,
    preSnapshot,
    effectId
}) {
    const plan = validateLandingHandoff(
        await adapter.prepareLanding({
            action: clone(action),
            groupId,
            effectId,
            repository: repositoryEntry.repository,
            members: clone(repositoryEntry.members),
            preRemoteSnapshot: clone(preSnapshot)
        }),
        repositoryEntry,
        groupId
    )
    let lane = createRepositoryLandingLane({
        repository: repositoryEntry.repository,
        defaultBranch: preSnapshot.defaultBranch
    })
    lane = acquireRepositoryLandingLease(lane, {
        attemptId: text(plan.attemptId,
            'delivery-landing-attempt-id-required'),
        landingLeaseId: text(plan.landingLeaseId,
            'delivery-landing-lease-id-required'),
        ownerIdentity: effectId,
        acquiredAt: text(plan.acquiredAt,
            'delivery-landing-acquired-at-required')
    })
    let attempt = createLandingAttempt({
        lane,
        handoff: plan.handoff,
        attemptId: plan.attemptId,
        latestRemoteHead: preSnapshot.defaultBranchSha,
        targetEpochId: text(plan.targetEpochId,
            'delivery-landing-target-epoch-required'),
        landingLeaseId: plan.landingLeaseId,
        landingWorktreeIdentity: text(
            plan.landingWorktreeIdentity,
            'delivery-landing-worktree-required'
        ),
        landingBranch: text(
            plan.landingBranch,
            'delivery-landing-branch-required'
        ),
        resourceRegistryIdentity: text(
            plan.resourceRegistryIdentity,
            'delivery-landing-resource-registry-required'
        )
    })
    const byIssueId = new Map(repositoryEntry.members.map((member) => [
        member.issueId,
        member
    ]))
    for (const memberIssueId of attempt.sourceMemberOrder) {
        const member = byIssueId.get(memberIssueId)
        if (!member) reject('delivery-landing-member-order-stale')
        const slice = await adapter.prepareLandingSlice({
            action: clone(action),
            effectId,
            groupId,
            repository: repositoryEntry.repository,
            member: clone(member),
            attempt: clone(attempt)
        })
        attempt = bindLandingSlice(attempt, {
            ...slice,
            memberIssueId,
            sourceCommit:
                attempt.sourceMemberCommitShas[memberIssueId]
        })
        const transplant = await adapter.transplantMember({
            action: clone(action),
            effectId,
            groupId,
            repository: repositoryEntry.repository,
            member: clone(member),
            attempt: clone(attempt)
        })
        attempt = recordCommitTransplant(attempt, {
            ...transplant,
            memberIssueId,
            sourceCommit:
                attempt.sourceMemberCommitShas[memberIssueId],
            issueIds: [memberIssueId]
        })
        for (const evidenceClass of
            attempt.requiredReverificationClasses) {
            const sourceReceiptDigest = attempt.sourceMemberMapping[
                memberIssueId
            ].receiptDigests[evidenceClass]
            if (!sourceReceiptDigest) {
                reject('delivery-landing-required-evidence-unmapped', {
                    memberIssueId,
                    evidenceClass
                })
            }
            const verification = await adapter.reverifyMember({
                action: clone(action),
                effectId,
                groupId,
                repository: repositoryEntry.repository,
                member: clone(member),
                evidenceClass,
                sourceReceiptDigest,
                candidateSha: attempt.oldToNewCommitShaMap[
                    attempt.sourceMemberCommitShas[memberIssueId]
                ],
                baseSha: attempt.latestRemoteHead,
                attempt: clone(attempt)
            })
            attempt = recordEvidenceRebinding(attempt, {
                memberIssueId,
                evidenceClass,
                sourceReceiptDigest,
                disposition: verification.disposition ??
                    'reverify-required',
                sourceIndependent:
                    verification.sourceIndependent === true,
                verifierReceiptDigest: hash(
                    verification.verifierReceiptDigest,
                    'delivery-landing-rebinding-receipt-required'
                )
            })
            if ((verification.disposition ??
                    'reverify-required') === 'reverify-required') {
                attempt = recordReverificationReceipt(attempt, {
                    memberIssueId,
                    evidenceClass,
                    sourceReceiptDigest,
                    receipt: verification.receipt
                })
            }
        }
    }
    const landingReceipt = finalizeLanding(attempt, {
        remoteHeadObservedBeforePush: preSnapshot.defaultBranchSha,
        resultingRemoteSha: attempt.currentLandingTip,
        pushMode: 'fast-forward',
        fastForwardVerified: true,
        sourceRetirementDisposition: text(
            plan.sourceRetirementDisposition,
            'delivery-source-retirement-disposition-required'
        ),
        cleanupReceiptDigest: hash(
            plan.cleanupReceiptDigest,
            'delivery-landing-cleanup-receipt-required'
        )
    })
    return {
        plan,
        lane,
        landingReceipt,
        memberCommits: Object.fromEntries(
            repositoryEntry.members.map((member) => [
                member.nodeId,
                landingReceipt.oldToNewCommitShaMap[
                    landingReceipt.attempt.sourceMemberCommitShas[
                        member.issueId
                    ]
                ]
            ])
        )
    }
}

function expectedPostStateDigest({ snapshot, resultingRemoteSha }) {
    return digest({
        repository: snapshot.repository,
        issueId: snapshot.issueId,
        defaultBranch: snapshot.defaultBranch,
        defaultBranchSha: resultingRemoteSha,
        issueStateDigest: snapshot.issueStateDigest
    })
}

async function applyRepositoryEffects({
    adapter,
    context,
    authority,
    action,
    groupId,
    effectId,
    repositories,
    preSnapshots,
    landings,
    mutationPlanDigest,
    issuedAt,
    expiresAt,
    observedAt,
    onMutationAttempt
}) {
    const effects = []
    for (let index = 0; index < repositories.length; index += 1) {
        const repositoryEntry = repositories[index]
        const preSnapshot = preSnapshots[index]
        const landing = landings[index]
        const terminalEvidenceDigest = digest({
            groupId,
            mutationPlanDigest,
            members: repositoryEntry.members.map((member) => ({
                nodeId: member.nodeId,
                evidenceSetDigest: member.evidenceSetDigest
            }))
        })
        const mutation = {
            action: 'default-branch-push',
            evidence: {
                landingReceiptDigest:
                    landing.landingReceipt.receiptDigest,
                terminalEvidenceDigest,
                expectedDefaultBranchSha:
                    landing.landingReceipt.resultingRemoteSha
            }
        }
        const postStateDigest = expectedPostStateDigest({
            snapshot: preSnapshot,
            resultingRemoteSha:
                landing.landingReceipt.resultingRemoteSha
        })
        const controlReceipt = compileDeliveryControlReceipt({
            runId: action.bindings.runId,
            deliveryEpoch: effectId,
            rootControlLeaseDigest: context.rootControlLeaseDigest,
            runtimeExecutionBinding: context.runtimeExecutionBinding,
            startup: context.startup,
            runtimeTrustBinding: context.runtimeTrustBinding,
            repositoryTargets: context.repositoryTargets,
            repository: repositoryEntry.repository,
            issueId: preSnapshot.issueId,
            candidateSha: landing.landingReceipt.resultingRemoteSha,
            defaultBranchSha: preSnapshot.defaultBranchSha,
            terminalEvidenceDigest,
            acceptanceGroupDigest: digest({
                groupId,
                members: repositories.flatMap(({ members }) =>
                    members.map(({ nodeId }) => nodeId))
            }),
            mutation,
            expectedPostStateDigest: postStateDigest,
            preRemoteSnapshot: preSnapshot,
            issuedAt,
            expiresAt
        })
        const permission = authorizeRemoteMutation({
            deliveryControlReceipt: controlReceipt,
            runtimeExecutionBinding: context.runtimeExecutionBinding,
            currentRemoteSnapshot: preSnapshot,
            now: issuedAt,
            consumedKeys: []
        })
        onMutationAttempt()
        await adapter.applyRemoteMutation({
            action: clone(action),
            groupId,
            effectId,
            repository: repositoryEntry.repository,
            members: clone(repositoryEntry.members),
            mutationPlanDigest,
            permission: clone(permission),
            deliveryControlReceipt: clone(controlReceipt),
            landingReceipt: clone(landing.landingReceipt)
        })
        const postSnapshot = validateRemoteSnapshot(
            await adapter.observeRepository({
                phase: 'post-mutation',
                action: clone(action),
                groupId,
                effectId,
                repository: repositoryEntry.repository,
                members: clone(repositoryEntry.members),
                representativeIssueId: preSnapshot.issueId,
                expectedDefaultBranchSha:
                    landing.landingReceipt.resultingRemoteSha,
                expectedIssueStateDigest:
                    preSnapshot.issueStateDigest
            }),
            {
                repository: repositoryEntry.repository,
                representativeIssueId: preSnapshot.issueId,
                expectedHead:
                    landing.landingReceipt.resultingRemoteSha,
                expectedIssueStateDigest:
                    preSnapshot.issueStateDigest
            }
        )
        const mutationReceipt = observeRemoteMutation({
            actorExecutionClass: 'root-control',
            actorInvocationId:
                authority.binding.runtimeInvocationId,
            mutation,
            preRemoteSnapshot: preSnapshot,
            postRemoteSnapshot: postSnapshot,
            observedPostStateDigest: postStateDigest,
            deliveryControlReceipt: controlReceipt,
            observedAt
        })
        if (mutationReceipt.status !== 'verified' ||
            mutationReceipt.violationCodes.length !== 0) {
            reject('delivery-remote-mutation-not-verified', {
                repository: repositoryEntry.repository,
                violationCodes: mutationReceipt.violationCodes
            })
        }
        effects.push({
            repository: repositoryEntry.repository,
            issueId: preSnapshot.issueId,
            defaultBranch: preSnapshot.defaultBranch,
            issueStateDigest: preSnapshot.issueStateDigest,
            preRemoteSnapshotDigest: preSnapshot.snapshotDigest,
            postRemoteSnapshotDigest: postSnapshot.snapshotDigest,
            resultingRemoteSha:
                landing.landingReceipt.resultingRemoteSha,
            landingReceiptDigest:
                landing.landingReceipt.receiptDigest,
            deliveryControlReceiptDigest: controlReceipt.receiptDigest,
            remoteMutationReceiptDigest: mutationReceipt.receiptDigest,
            consumptionKey: controlReceipt.consumptionKey
        })
    }
    return effects
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

function artifactDigest(artifacts, contractId, kind) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[contractId]
        .artifactSet[kind]
    return artifacts[kind][spec.digestField]
}

function buildStageResult({
    action,
    contractId,
    effectId,
    commits,
    candidateMappingDigest,
    landingReceiptDigests,
    repositoryEffects,
    remotePreStateDigest,
    remotePostStateDigest
}) {
    const artifacts = {}
    const put = (kind, evidence) => {
        artifacts[kind] = sealArtifact({
            action,
            contractId,
            kind,
            evidence
        })
        return artifacts[kind]
    }
    const d = (kind) => artifactDigest(artifacts, contractId, kind)
    put('remotePreSnapshot', {
        remoteStateDigest: remotePreStateDigest,
        snapshotKind: 'pre-mutation',
        repositorySnapshotDigests: Object.fromEntries(
            repositoryEffects.map((effect) => [
                effect.repository,
                effect.preRemoteSnapshotDigest
            ])
        )
    })
    put('remotePostSnapshot', {
        remoteStateDigest: remotePostStateDigest,
        snapshotKind: 'post-mutation',
        repositorySnapshotDigests: Object.fromEntries(
            repositoryEffects.map((effect) => [
                effect.repository,
                effect.postRemoteSnapshotDigest
            ])
        )
    })
    put('deliveryControl', {
        effectId,
        preRemoteSnapshotDigest: d('remotePreSnapshot'),
        expectedPostStateDigest: remotePostStateDigest,
        status: 'authorized',
        repositoryControlReceiptDigests: Object.fromEntries(
            repositoryEffects.map((effect) => [
                effect.repository,
                effect.deliveryControlReceiptDigest
            ])
        )
    })
    put('remoteMutationAuthority', {
        effectId,
        deliveryControlReceiptDigest: d('deliveryControl'),
        preRemoteSnapshotDigest: d('remotePreSnapshot'),
        postRemoteSnapshotDigest: d('remotePostSnapshot'),
        status: 'verified',
        repositoryMutationReceiptDigests: Object.fromEntries(
            repositoryEffects.map((effect) => [
                effect.repository,
                effect.remoteMutationReceiptDigest
            ])
        )
    })
    const landingReceiptDigest = digest(landingReceiptDigests)
    put('remoteEffect', {
        effectId,
        commits: clone(commits),
        preRemoteSnapshotDigest: d('remotePreSnapshot'),
        postRemoteSnapshotDigest: d('remotePostSnapshot'),
        candidateMappingDigest,
        landingReceiptDigest,
        landingReceiptDigests: clone(landingReceiptDigests),
        repositoryEffects: clone(repositoryEffects)
    })
    if (contractId === CONTRACT_COMPLETE) {
        put('deliveryAttempt', {
            effectId,
            candidateMappingDigest,
            landingReceiptDigest,
            landingReceiptDigests: clone(landingReceiptDigests)
        })
        put('delivery', {
            effectId,
            remoteEffectDigest: d('remoteEffect'),
            status: 'completed',
            repositoryEffectsDigest: digest(repositoryEffects)
        })
    }
    const result = {
        schema: LIFECYCLE_STAGE_RESULT_SCHEMA,
        producerAuthority: 'delivery-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: null,
        actorRole: 'root-delivery-adapter',
        attemptId: null,
        artifacts,
        artifactsDigest: digest(artifacts)
    }
    result.resultDigest = digest(result)
    validateLifecycleStageResult({ result, action, node: null })
    return Object.freeze(result)
}

function effectState({ members, landings, repositoryEffects }) {
    const commits = Object.assign({}, ...landings.map(
        ({ memberCommits }) => memberCommits
    ))
    const candidateMappingDigest = digest(members.map((member) => ({
        nodeId: member.nodeId,
        sourceCandidateSha: member.candidateSha,
        landedCommitSha: commits[member.nodeId]
    })))
    const landingReceiptDigests = Object.fromEntries(
        landings.map(({ landingReceipt }) => [
            landingReceipt.repository,
            landingReceipt.receiptDigest
        ])
    )
    return {
        commits,
        candidateMappingDigest,
        landingReceiptDigests,
        repositoryEffects,
        remotePreStateDigest: digest(repositoryEffects.map((effect) => ({
            repository: effect.repository,
            snapshotDigest: effect.preRemoteSnapshotDigest
        }))),
        remotePostStateDigest: digest(repositoryEffects.map((effect) => ({
            repository: effect.repository,
            snapshotDigest: effect.postRemoteSnapshotDigest
        })))
    }
}

function pendingEffectState(pending) {
    object(pending, 'delivery-pending-effect-invalid')
    text(pending.effectId, 'delivery-pending-effect-invalid')
    object(pending.commits, 'delivery-pending-effect-invalid')
    hash(
        pending.candidateMappingDigest,
        'delivery-pending-candidate-mapping-invalid'
    )
    object(
        pending.landingReceiptDigests,
        'delivery-pending-landing-receipts-invalid'
    )
    if (!Array.isArray(pending.repositoryEffects) ||
        pending.repositoryEffects.length === 0) {
        reject('delivery-pending-repository-effects-invalid')
    }
    hash(
        pending.remotePreStateDigest,
        'delivery-pending-prestate-invalid'
    )
    hash(
        pending.remotePostStateDigest,
        'delivery-pending-poststate-invalid'
    )
    return {
        commits: clone(pending.commits),
        candidateMappingDigest: pending.candidateMappingDigest,
        landingReceiptDigests:
            clone(pending.landingReceiptDigests),
        repositoryEffects: clone(pending.repositoryEffects),
        remotePreStateDigest: pending.remotePreStateDigest,
        remotePostStateDigest: pending.remotePostStateDigest
    }
}

function effectIdFor(action, members) {
    const existing = action.bindings.pendingDeliveryEffect?.effectId ??
        action.bindings.activeDeliveryFreeze?.effectId ?? null
    if (existing) return existing
    return `delivery:${digest({
        runId: action.bindings.runId,
        groupId: action.acceptanceGroup,
        members: members.map((member) => ({
            nodeId: member.nodeId,
            baseSha: member.baseSha,
            candidateSha: member.candidateSha,
            evidenceSetDigest: member.evidenceSetDigest
        })),
        actionDigest: action.actionDigest
    })}`
}

function timestampSet(context) {
    const issuedAt = text(
        context.timestamps?.issuedAt ?? context.createdAt,
        'delivery-issued-at-required'
    )
    const observedAt = text(
        context.timestamps?.observedAt ?? issuedAt,
        'delivery-observed-at-required'
    )
    const expiresAt = context.timestamps?.expiresAt ??
        new Date(Date.parse(issuedAt) + 240_000).toISOString()
    if (!Number.isFinite(Date.parse(issuedAt)) ||
        !Number.isFinite(Date.parse(observedAt)) ||
        !Number.isFinite(Date.parse(expiresAt))) {
        reject('delivery-timestamp-invalid')
    }
    return { issuedAt, observedAt, expiresAt }
}

async function completePendingEffect({
    context,
    adapter,
    action,
    actionSet,
    pending,
    createdAt
}) {
    const state = pendingEffectState(pending)
    const repositories = state.repositoryEffects.map((effect) => ({
        repository: effect.repository,
        members: action.bindings.memberBindings
            .filter((member) => member.repository === effect.repository)
            .map((member) => ({
                nodeId: member.nodeId,
                issueId: `${member.repository}#${member.issueNumber}`,
                baseSha: member.baseSha
            }))
    }))
    await observeRepositories({
        adapter,
        repositories,
        phase: 'reobserve-post-mutation',
        expectedEffects: state.repositoryEffects,
        action,
        groupId: action.acceptanceGroup
    })
    const completed = buildStageResult({
        action,
        contractId: CONTRACT_COMPLETE,
        effectId: pending.effectId,
        ...state
    })
    const ledger = recordLifecycleActionResults({
        ledger: context.ledger,
        actionSet,
        stageResults: [completed],
        createdAt,
        startup: context.startup
    })
    return { ledger, result: completed, state }
}

export async function executeLifecycleDeliveryAction(context = {}) {
    const adapter = validateAdapter(context.deliveryAdapter)
    let action = exactAction(context.action, context.actionSet)
    let actionSet = context.actionSet
    const authority = validateContextAuthority(context, action)
    let projection = projectLifecycleRun(
        context.ledger,
        { startup: context.startup }
    )
    const groupId = action.acceptanceGroup
    if (projection.aggregateProjection.deliveryEffects[groupId]) {
        reject('delivery-effect-already-completed')
    }
    const initialMembers = validateMembers({ action, projection })
    const effectId = effectIdFor(action, initialMembers)
    const timestamps = timestampSet(context)
    const createdAt = text(
        context.createdAt,
        'delivery-created-at-required'
    )
    let ledger = context.ledger
    let acquiredHere = false
    let remoteMutationAttempted = false
    const activeFreeze = Object.values(
        projection.aggregateProjection.deliveryFreezes ?? {}
    ).find((freeze) =>
        freeze?.active === true && freeze.groupId === groupId)
    if (!activeFreeze) {
        ledger = acquireLifecycleDeliveryFreeze({
            ledger,
            actionSet,
            action,
            effectId,
            createdAt,
            startup: context.startup
        })
        acquiredHere = true
        context = { ...context, ledger }
    } else if (activeFreeze.effectId !== effectId) {
        reject('delivery-freeze-owned-by-another-effect')
    }
    try {
        actionSet = compileLifecycleRunActionSet(ledger, {
            startup: context.startup
        })
        action = actionForGroup(actionSet, groupId)
        projection = projectLifecycleRun(ledger, {
            startup: context.startup
        })
        const members = validateMembers({ action, projection })
        const pending = projection.aggregateProjection
            .pendingDeliveryEffects?.[groupId] ?? null
        if (pending) {
            return completePendingEffect({
                context: { ...context, ledger },
                adapter,
                action,
                actionSet,
                pending,
                createdAt
            })
        }
        const repositories = groupByRepository(members)
        const preSnapshots = await observeRepositories({
            adapter,
            repositories,
            phase: 'pre-mutation',
            action,
            groupId
        })
        const landings = []
        for (let index = 0; index < repositories.length; index += 1) {
            landings.push(await executeRepositoryLanding({
                adapter,
                action,
                groupId,
                repositoryEntry: repositories[index],
                preSnapshot: preSnapshots[index],
                effectId
            }))
        }
        const mutationPlanDigest = digest(landings.map((landing) => ({
            repository: landing.landingReceipt.repository,
            preRemoteHead:
                landing.landingReceipt.remoteHeadObservedBeforePush,
            resultingRemoteSha:
                landing.landingReceipt.resultingRemoteSha,
            landingReceiptDigest:
                landing.landingReceipt.receiptDigest
        })))
        const repositoryEffects = await applyRepositoryEffects({
            adapter,
            context: { ...context, ledger },
            authority,
            action,
            groupId,
            effectId,
            repositories,
            preSnapshots,
            landings,
            mutationPlanDigest,
            ...timestamps,
            onMutationAttempt() {
                remoteMutationAttempted = true
            }
        })
        const state = effectState({
            members,
            landings,
            repositoryEffects
        })
        const observed = buildStageResult({
            action,
            contractId: CONTRACT_REMOTE,
            effectId,
            ...state
        })
        ledger = recordLifecycleActionResults({
            ledger,
            actionSet,
            stageResults: [observed],
            createdAt,
            startup: context.startup
        })
        const landingLaneReleases = landings.map((landing) =>
            releaseRepositoryLandingLease(landing.lane, {
                attemptId: landing.plan.attemptId,
                landingLeaseId: landing.plan.landingLeaseId,
                landingReceiptDigest:
                    landing.landingReceipt.receiptDigest,
                releasedAt: createdAt
            })
        )
        if (context.interruptAfterRemoteEffect === true) {
            reject('delivery-interrupted-after-remote-effect', {
                ledger,
                effectId,
                resultDigest: observed.resultDigest,
                landingLaneReleaseDigests: Object.fromEntries(
                    landingLaneReleases.map((lane) => [
                        lane.repository,
                        lane.laneDigest
                    ])
                )
            })
        }
        actionSet = compileLifecycleRunActionSet(ledger, {
            startup: context.startup
        })
        action = actionForGroup(actionSet, groupId)
        const pendingState = projectLifecycleRun(ledger, {
            startup: context.startup
        }).aggregateProjection.pendingDeliveryEffects[groupId]
        const completed = await completePendingEffect({
            context: { ...context, ledger },
            adapter,
            action,
            actionSet,
            pending: pendingState,
            createdAt
        })
        return {
            ledger: completed.ledger,
            remoteEffectResult: observed,
            result: completed.result,
            effectId,
            repositoryEffects: clone(repositoryEffects),
            landingLaneReleases: clone(landingLaneReleases)
        }
    } catch (error) {
        if (acquiredHere && !remoteMutationAttempted &&
            error?.code !== 'delivery-interrupted-after-remote-effect') {
            try {
                ledger = releaseLifecycleDeliveryFreeze({
                    ledger,
                    groupId,
                    effectId,
                    createdAt,
                    startup: context.startup
                })
            } catch {
                // Preserve the original failure. A failed release remains
                // visible in the canonical control ledger on replay.
            }
        }
        if (error instanceof LifecycleDeliveryExecutorError) throw error
        reject('delivery-execution-failed', {
            cause: error?.code ?? error?.name ?? 'unknown-error',
            causeMessage: error?.message ?? null,
            effectId,
            remoteMutationAttempted
        })
    }
}

export const lifecycleDeliveryActionTypes = Object.freeze([
    SUPPORTED_ACTION
])
