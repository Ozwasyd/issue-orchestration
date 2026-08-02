import { createHash } from 'node:crypto'

// Shared issue-orchestration package runtime.

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u

export class AcceptanceGroupError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'AcceptanceGroupError'
        this.code = code
    }
}

function fail(code) {
    throw new AcceptanceGroupError(code)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
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

function clone(value) {
    return structuredClone(value)
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function unique(values) {
    return new Set(values).size === values.length
}

function expectedDefinitionDigest(input) {
    return digest({
        repository: input.repository,
        baseEpoch: input.baseEpoch,
        baseSha: input.baseSha,
        memberIssueIds: input.memberIssueIds,
        memberOrder: input.memberOrder,
        sharedConflictKeys: input.sharedConflictKeys,
        members: input.members
    })
}

function fallback(reason) {
    return deepFreeze({
        eligible: false,
        disposition: 'ordinary-per-issue',
        gatePolicy: 'per-issue-unchanged',
        reason
    })
}

function proposalIsEligible(input) {
    if (input?.schema !== 'issue-orchestration.acceptance-group-proposal.v1'
        || !isText(input.groupId)
        || !REPOSITORY.test(input.repository ?? '')
        || !isText(input.baseEpoch)
        || !SHA.test(input.baseSha ?? '')
        || !isText(input.groupWorktreeIdentity)
        || !isText(input.groupBranchIdentity)
        || !isText(input.testOwnerIdentity)
        || !isText(input.implementerContinuityIdentity)
        || !isText(input.resourceRegistryIdentity)
        || input.acceptedWithoutModification !== true
        || !Array.isArray(input.memberIssueIds)
        || input.memberIssueIds.length < 2
        || !unique(input.memberIssueIds)
        || !Array.isArray(input.memberOrder)
        || JSON.stringify(input.memberOrder) !== JSON.stringify(input.memberIssueIds)
        || !Array.isArray(input.sharedConflictKeys)
        || input.sharedConflictKeys.length === 0
        || !unique(input.sharedConflictKeys)
        || !Array.isArray(input.members)
        || input.members.length !== input.memberIssueIds.length
        || input.groupDefinitionDigest !== expectedDefinitionDigest(input)) {
        return false
    }

    return input.members.every((member, index) =>
        member?.issueId === input.memberIssueIds[index]
        && member.repository === input.repository
        && member.epochId === input.baseEpoch
        && Array.isArray(member.conflictKeys)
        && member.conflictKeys.some((key) => input.sharedConflictKeys.includes(key))
        && Array.isArray(member.sharedSourceKeys)
        && member.sharedSourceKeys.length > 0
        && member.lowConflictParallelEligible === false
        && member.independentlyDeliverable === true
        && member.rollbackIndependent === true
        && HASH.test(member.classificationDigest ?? '')
        && HASH.test(member.routingInputDigest ?? '')
        && HASH.test(member.testContractDigest ?? '')
        && member.stageProfileIds
        && typeof member.stageProfileIds === 'object'
        && Object.keys(member.stageProfileIds).length > 0
        && Array.isArray(member.allowedPaths)
        && member.allowedPaths.length > 0
        && member.allowedPaths.every(isText)
    )
}

function requireSession(session) {
    if (session?.schema !== 'issue-orchestration.acceptance-group-session.v1') {
        fail('acceptance-group-session-invalid')
    }
}

function requireMember(session, memberIssueId) {
    requireSession(session)
    const member = session.members?.[memberIssueId]
    if (!member) fail('acceptance-group-member-unknown')
    return member
}

function memberIndex(session, memberIssueId) {
    return session.memberOrder.indexOf(memberIssueId)
}

function assertFrozenIdentity(member, input) {
    if (input.classificationDigest !== member.classificationDigest
        || input.routingInputDigest !== member.routingInputDigest
        || input.testContractDigest !== member.testContractDigest
        || digest(input.stageProfileIds) !== digest(member.stageProfileIds)) {
        fail('acceptance-group-member-identity-drift')
    }
}

function previousMemberIsGreen(session, index) {
    if (index === 0) return true
    return session.members[session.memberOrder[index - 1]].status === 'green-committed'
}

function receiptsAreGreen(member) {
    return member.receipts.selfTest?.status === 'verified'
        && member.receipts.behavior?.status === 'verified'
        && member.receipts.documentation?.status === 'verified'
}

export function evaluateGroupEligibility(input) {
    if (!proposalIsEligible(input)) return fallback('proposal-not-eligible')
    return deepFreeze({
        eligible: true,
        disposition: 'acceptance-group-session',
        gatePolicy: 'member-gates-frozen',
        groupId: input.groupId,
        memberOrder: clone(input.memberOrder)
    })
}

export function createAcceptanceGroupSession(input) {
    if (!proposalIsEligible(input)) fail('acceptance-group-proposal-ineligible')

    const members = Object.fromEntries(input.members.map((member) => [
        member.issueId,
        {
            issueId: member.issueId,
            repository: member.repository,
            epochId: member.epochId,
            conflictKeys: clone(member.conflictKeys),
            sharedSourceKeys: clone(member.sharedSourceKeys),
            classificationDigest: member.classificationDigest,
            routingInputDigest: member.routingInputDigest,
            stageProfileIds: clone(member.stageProfileIds),
            testContractDigest: member.testContractDigest,
            allowedPaths: clone(member.allowedPaths),
            candidateIdentity: null,
            commitSha: null,
            status: 'member-pending',
            receipts: {},
            writeLease: null,
            humanDecision: null
        }
    ]))

    return deepFreeze({
        schema: 'issue-orchestration.acceptance-group-session.v1',
        groupId: input.groupId,
        groupDefinitionDigest: input.groupDefinitionDigest,
        repository: input.repository,
        baseEpoch: input.baseEpoch,
        baseSha: input.baseSha,
        memberOrder: clone(input.memberOrder),
        sharedConflictKeys: clone(input.sharedConflictKeys),
        groupWorktreeIdentity: input.groupWorktreeIdentity,
        groupBranchIdentity: input.groupBranchIdentity,
        testOwnerIdentity: input.testOwnerIdentity,
        implementerContinuityIdentity: input.implementerContinuityIdentity,
        resourceRegistryIdentity: input.resourceRegistryIdentity,
        activeMemberIssue: null,
        activeWriteLeaseId: null,
        members,
        immutableSourceTip: null,
        orderedGreenCommitPrefix: [],
        frozenSource: null
    })
}

export function activateGroupMember(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    const index = memberIndex(session, input.memberIssueId)
    assertFrozenIdentity(member, input)

    if (session.activeWriteLeaseId !== null) {
        fail('acceptance-group-write-lease-active')
    }
    if (session.activeMemberIssue !== null
        && session.activeMemberIssue !== input.memberIssueId) {
        fail('acceptance-group-current-member-not-green')
    }
    if (!previousMemberIsGreen(session, index)) {
        fail('acceptance-group-current-member-not-green')
    }
    if (member.status === 'member-human-decision-pending'
        || member.status === 'green-committed') {
        fail('acceptance-group-member-not-activatable')
    }

    const next = clone(session)
    next.activeMemberIssue = input.memberIssueId
    next.members[input.memberIssueId].status = 'member-active'
    return deepFreeze(next)
}

export function acquireMemberWriteLease(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    if (session.activeWriteLeaseId !== null) {
        fail('acceptance-group-write-lease-active')
    }
    if (session.activeMemberIssue !== input.memberIssueId
        || member.status !== 'member-active') {
        fail('acceptance-group-member-not-active')
    }
    if (!isText(input.leaseId)
        || !isText(input.stageRole)
        || !isText(input.ownerIdentity)) {
        fail('acceptance-group-write-lease-invalid')
    }

    const next = clone(session)
    next.activeWriteLeaseId = input.leaseId
    next.members[input.memberIssueId].writeLease = {
        leaseId: input.leaseId,
        stageRole: input.stageRole,
        ownerIdentity: input.ownerIdentity
    }
    next.members[input.memberIssueId].status = 'member-writing'
    return deepFreeze(next)
}

export function recordMemberCandidate(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    const lease = member.writeLease
    const candidate = input?.candidateIdentity
    const receipt = input?.selfTestReceipt
    if (session.activeMemberIssue !== input.memberIssueId
        || session.activeWriteLeaseId !== lease?.leaseId) {
        fail('acceptance-group-write-lease-required')
    }
    if (!SHA.test(candidate?.candidateSha ?? '')
        || !HASH.test(candidate?.candidateDigest ?? '')
        || candidate.implementerIdentity !== lease.ownerIdentity) {
        fail('acceptance-group-candidate-identity')
    }
    if (receipt?.schema !== 'issue-orchestration.member-self-test-receipt.v1'
        || receipt.memberIssueId !== input.memberIssueId
        || receipt.testContractDigest !== member.testContractDigest
        || receipt.candidateSha !== candidate.candidateSha
        || receipt.status !== 'verified'
        || !HASH.test(receipt.receiptDigest ?? '')) {
        fail('acceptance-group-self-test-receipt-invalid')
    }

    const next = clone(session)
    next.members[input.memberIssueId].candidateIdentity = clone(candidate)
    next.members[input.memberIssueId].receipts.selfTest = clone(receipt)
    next.members[input.memberIssueId].status = 'member-candidate-verified'
    return deepFreeze(next)
}

export function releaseMemberWriteLease(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    if (session.activeMemberIssue !== input.memberIssueId
        || session.activeWriteLeaseId !== input.leaseId
        || member.writeLease?.leaseId !== input.leaseId) {
        fail('acceptance-group-write-lease-mismatch')
    }

    const next = clone(session)
    next.activeWriteLeaseId = null
    next.members[input.memberIssueId].writeLease = null
    if (input.reason === 'implementation-complete'
        && member.candidateIdentity
        && member.receipts.selfTest?.status === 'verified') {
        next.members[input.memberIssueId].status = 'member-awaiting-receipts'
    } else {
        next.members[input.memberIssueId].status = 'member-red'
    }
    return deepFreeze(next)
}

export function bindMemberReceipt(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    const receipt = input?.receipt
    if (receipt?.memberIssueId !== input.memberIssueId) {
        fail('acceptance-group-receipt-member-mismatch')
    }
    if (!member.candidateIdentity
        || receipt?.candidateSha !== member.candidateIdentity.candidateSha
        || receipt.status !== 'verified'
        || !HASH.test(receipt.receiptDigest ?? '')) {
        fail('acceptance-group-receipt-invalid')
    }
    if (!['behavior', 'documentation'].includes(input.receiptClass)
        || receipt.schema
            !== `issue-orchestration.member-${input.receiptClass}-receipt.v1`) {
        fail('acceptance-group-receipt-class')
    }
    if (member.receipts[input.receiptClass]) {
        fail('acceptance-group-receipt-already-bound')
    }
    if (input.receiptClass === 'behavior'
        && (receipt.freshContext !== true
            || !isText(receipt.rolloutId)
            || receipt.verifierIdentity === receipt.implementerIdentity
            || receipt.implementerIdentity
                !== member.candidateIdentity.implementerIdentity)) {
        fail('acceptance-group-verifier-not-fresh')
    }
    if (input.receiptClass === 'documentation'
        && (receipt.independentlyAttributed !== true
            || !isText(receipt.writerIdentity))) {
        fail('acceptance-group-documentation-receipt-invalid')
    }

    const next = clone(session)
    next.members[input.memberIssueId].receipts[input.receiptClass] = clone(receipt)
    return deepFreeze(next)
}

export function recordMemberCommit(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    const commit = input?.commit
    const index = memberIndex(session, input.memberIssueId)
    const expectedParent = index === 0
        ? session.baseSha
        : session.members[session.memberOrder[index - 1]].commitSha
    const changedPathsAllowed = Array.isArray(commit?.changedPaths)
        && commit.changedPaths.length > 0
        && commit.changedPaths.every((path) => member.allowedPaths.includes(path))

    if (!receiptsAreGreen(member)) {
        fail('acceptance-group-member-not-green')
    }
    if (!SHA.test(commit?.commitSha ?? '')
        || commit.parentSha !== expectedParent
        || !Array.isArray(commit.issueIds)
        || commit.issueIds.length !== 1
        || commit.issueIds[0] !== input.memberIssueId
        || commit.candidateSha !== member.candidateIdentity?.candidateSha
        || commit.atomic !== true
        || commit.independentlyRevertible !== true
        || !changedPathsAllowed) {
        fail('acceptance-group-commit-not-atomic')
    }

    const next = clone(session)
    next.members[input.memberIssueId].commitSha = commit.commitSha
    next.members[input.memberIssueId].commit = clone(commit)
    next.members[input.memberIssueId].status = 'green-committed'
    next.activeMemberIssue = null
    next.activeWriteLeaseId = null
    return deepFreeze(next)
}

export function freezeGroupSource(session, input) {
    requireSession(session)
    if (session.immutableSourceTip !== null) {
        fail('acceptance-group-source-tip-immutable')
    }
    const commits = session.memberOrder.map((issueId) =>
        session.members[issueId].commitSha
    )
    if (commits.some((commitSha) => !SHA.test(commitSha ?? ''))
        || session.memberOrder.some((issueId) =>
            session.members[issueId].status !== 'green-committed')
        || input?.sourceEpoch !== session.baseEpoch
        || input.sourceBase !== session.baseSha
        || !isText(input.sourceWorktree)
        || !isText(input.sourceBranch)
        || input.immutableSourceTip !== commits.at(-1)
        || !Array.isArray(input.dirtyInventory)
        || input.dirtyInventory.length !== 0
        || !Array.isArray(input.untrackedInventory)
        || input.untrackedInventory.length !== 0
        || !HASH.test(input.resourceRetentionReceiptDigest ?? '')) {
        fail('acceptance-group-source-not-freezable')
    }

    const next = clone(session)
    next.immutableSourceTip = input.immutableSourceTip
    next.orderedGreenCommitPrefix = commits
    next.frozenSource = clone(input)
    return deepFreeze(next)
}

export function createLandingHandoff(session, input) {
    requireSession(session)
    if (!SHA.test(session.immutableSourceTip ?? '')) {
        fail('acceptance-group-source-not-frozen')
    }
    if (input?.remoteDefaultSha === session.baseSha
        && input.currentEpoch === session.baseEpoch) {
        return deepFreeze({
            schema: 'issue-orchestration.landing-handoff.v1',
            disposition: 'fast-forward-delivery-window',
            immutableSourceTip: session.immutableSourceTip,
            orderedGreenCommitPrefix: clone(session.orderedGreenCommitPrefix)
        })
    }

    const memberMapping = Object.fromEntries(session.memberOrder.map((issueId) => {
        const member = session.members[issueId]
        return [issueId, {
            candidateSha: member.candidateIdentity.candidateSha,
            commitSha: member.commitSha,
            testContractDigest: member.testContractDigest,
            receiptDigests: Object.fromEntries(
                Object.entries(member.receipts)
                    .map(([receiptClass, receipt]) =>
                        [receiptClass, receipt.receiptDigest])
            )
        }]
    }))
    return deepFreeze({
        schema: 'issue-orchestration.landing-handoff.v1',
        disposition: 'landing-handoff-required',
        groupId: session.groupId,
        repository: session.repository,
        sourceEpoch: session.baseEpoch,
        sourceBase: session.baseSha,
        remoteDefaultSha: input?.remoteDefaultSha,
        currentEpoch: input?.currentEpoch,
        immutableSourceTip: session.immutableSourceTip,
        orderedGreenCommitPrefix: clone(session.orderedGreenCommitPrefix),
        sourceWorktree: session.frozenSource.sourceWorktree,
        sourceBranch: session.frozenSource.sourceBranch,
        dirtyInventory: clone(session.frozenSource.dirtyInventory),
        untrackedInventory: clone(session.frozenSource.untrackedInventory),
        memberMapping,
        requiredReverificationClasses:
            clone(input?.requiredReverificationClasses ?? []),
        resourceRetentionReceiptDigest:
            session.frozenSource.resourceRetentionReceiptDigest,
        sourceHistoryOperations: []
    })
}

export function markMemberHumanDecisionPending(session, input) {
    const member = requireMember(session, input?.memberIssueId)
    const request = input?.request
    if (request?.schema !== 'issue-orchestration.human-decision-request.v1'
        || request.verificationStatus !== 'verified'
        || request.memberIssueId !== input.memberIssueId
        || !HASH.test(request.requestDigest ?? '')
        || !HASH.test(input.retainedResourceReceiptDigest ?? '')) {
        fail('acceptance-group-human-request-unverified')
    }
    if (member.status === 'green-committed') {
        fail('acceptance-group-human-request-too-late')
    }

    const next = clone(session)
    next.members[input.memberIssueId].status = 'member-human-decision-pending'
    next.members[input.memberIssueId].humanDecision = {
        request: clone(request),
        retainedResourceReceiptDigest: input.retainedResourceReceiptDigest
    }
    if (next.activeMemberIssue === input.memberIssueId) {
        next.activeMemberIssue = null
        next.activeWriteLeaseId = null
        next.members[input.memberIssueId].writeLease = null
    }
    return deepFreeze(next)
}

export function projectGroupStatus(session) {
    requireSession(session)
    const pendingHumanMembers = session.memberOrder.filter((issueId) =>
        session.members[issueId].status === 'member-human-decision-pending'
    )
    const blocked = new Set()
    for (const pendingIssue of pendingHumanMembers) {
        const pendingIndex = memberIndex(session, pendingIssue)
        const pendingKeys = session.members[pendingIssue].conflictKeys
        for (const issueId of session.memberOrder.slice(pendingIndex + 1)) {
            if (session.members[issueId].conflictKeys
                .some((key) => pendingKeys.includes(key))) {
                blocked.add(issueId)
            }
        }
    }
    if (pendingHumanMembers.length > 0) {
        return deepFreeze({
            status: 'member-human-decision-pending',
            green: false,
            pendingHumanMembers,
            blockedMembers: [...blocked]
        })
    }

    const green = session.memberOrder.every((issueId) =>
        session.members[issueId].status === 'green-committed'
    )
    return deepFreeze({
        status: green ? 'group-green' : 'group-in-progress',
        green,
        pendingHumanMembers: [],
        blockedMembers: []
    })
}
