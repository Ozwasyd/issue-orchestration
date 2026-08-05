import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const packageScripts =
    'skills/issue-orchestration/scripts'
const implementationRelative = `${packageScripts}/acceptance-group-session.mjs`
const implementationPath = resolve(root, implementationRelative)
const resourceLifecyclePath = resolve(root, `${packageScripts}/resource-lifecycle.mjs`)
const resourceLifecycleDigest =
    '099d5939984140770eec24521084ac956381a21bab28a2a1b6ecfe789f1febb2'

const repository = 'ExampleOrg/RepositoryA'
const baseSha = '2499db9517ec4e340bb475443c6ec2984203323c'
const epochId = 'repositorya-master-epoch-1831'
const groupId = 'acceptance-group-1831-runtime'
const issues = [`${repository}#1831-a`, `${repository}#1831-b`, `${repository}#1831-c`]
const sha = (character) => character.repeat(40)
const hash = (character) => character.repeat(64)

const requiredExports = [
    'acquireMemberWriteLease',
    'activateGroupMember',
    'bindMemberReceipt',
    'createAcceptanceGroupSession',
    'createLandingHandoff',
    'evaluateGroupEligibility',
    'freezeGroupSource',
    'markMemberHumanDecisionPending',
    'projectGroupStatus',
    'recordMemberCandidate',
    'recordMemberCommit',
    'releaseMemberWriteLease'
]

let implementationPromise

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function member(issueId, index, overrides = {}) {
    return {
        issueId,
        repository,
        epochId,
        conflictKeys: ['orchestration-runtime'],
        sharedSourceKeys: ['acceptance-group-session'],
        lowConflictParallelEligible: false,
        independentlyDeliverable: true,
        rollbackIndependent: true,
        classificationDigest: hash(String(index + 1)),
        routingInputDigest: hash(String(index + 4)),
        stageProfileIds: {
            testOwner: index === 0 ? 'sol-xhigh' : 'terra-max',
            implementer: index === 0 ? 'sol-high' : 'terra-max',
            behaviorVerifier: index === 0 ? 'terra-high' : 'sol-high',
            documentationWriter: index === 0 ? 'terra-high' : 'terra-high'
        },
        testContractDigest: hash(String(index + 7)),
        allowedPaths: [`tools/member-${index + 1}.mjs`],
        ...overrides
    }
}

function proposal(overrides = {}) {
    const members = issues.map((issueId, index) => member(issueId, index))
    const input = {
        schema: 'issue-orchestration.acceptance-group-proposal.v1',
        groupId,
        repository,
        baseEpoch: epochId,
        baseSha,
        memberIssueIds: [...issues],
        memberOrder: [...issues],
        sharedConflictKeys: ['orchestration-runtime'],
        groupWorktreeIdentity: 'worktree-1831-group',
        groupBranchIdentity: 'bootstrap-repair/1831-group',
        testOwnerIdentity: 'logical-test-owner-1831',
        implementerContinuityIdentity: 'implementer-index-1831',
        resourceRegistryIdentity: 'resource-registry-1828-group-1831',
        members,
        acceptedWithoutModification: true,
        ...overrides
    }
    input.groupDefinitionDigest = digest({
        repository: input.repository,
        baseEpoch: input.baseEpoch,
        baseSha: input.baseSha,
        memberIssueIds: input.memberIssueIds,
        memberOrder: input.memberOrder,
        sharedConflictKeys: input.sharedConflictKeys,
        members: input.members
    })
    return input
}

async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1831 acceptance-group runtime owner: ${implementationRelative}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing #1831 export ${name}`)
    }
    return loaded
}

function assertCode(operation, code) {
    assert.throws(operation, (error) => error?.code === code, `expected error ${code}`)
}

function activateAndLease(loaded, session, index) {
    const memberInput = proposal().members[index]
    const activated = loaded.activateGroupMember(session, {
        memberIssueId: memberInput.issueId,
        classificationDigest: memberInput.classificationDigest,
        routingInputDigest: memberInput.routingInputDigest,
        stageProfileIds: memberInput.stageProfileIds,
        testContractDigest: memberInput.testContractDigest
    })
    return loaded.acquireMemberWriteLease(activated, {
        memberIssueId: memberInput.issueId,
        leaseId: `write-lease-${index + 1}`,
        stageRole: 'code-implementer',
        ownerIdentity: `implementer-${index + 1}`
    })
}

function candidateInput(index) {
    return {
        memberIssueId: issues[index],
        candidateIdentity: {
            candidateSha: sha(['a', 'b', 'c'][index]),
            candidateDigest: hash(['a', 'b', 'c'][index]),
            implementerIdentity: `implementer-${index + 1}`
        },
        selfTestReceipt: {
            schema: 'issue-orchestration.member-self-test-receipt.v1',
            memberIssueId: issues[index],
            testContractDigest: proposal().members[index].testContractDigest,
            candidateSha: sha(['a', 'b', 'c'][index]),
            status: 'verified',
            receiptDigest: hash(['d', 'e', 'f'][index])
        }
    }
}

function receiptInput(index, receiptClass, overrides = {}) {
    return {
        memberIssueId: issues[index],
        receiptClass,
        receipt: {
            schema: `issue-orchestration.member-${receiptClass}-receipt.v1`,
            memberIssueId: issues[index],
            candidateSha: sha(['a', 'b', 'c'][index]),
            status: 'verified',
            receiptDigest: hash(receiptClass === 'behavior' ? '7' : '8'),
            ...overrides
        }
    }
}

function finishMember(loaded, session, index) {
    let current = activateAndLease(loaded, session, index)
    current = loaded.recordMemberCandidate(current, candidateInput(index))
    current = loaded.releaseMemberWriteLease(current, {
        memberIssueId: issues[index],
        leaseId: `write-lease-${index + 1}`,
        reason: 'implementation-complete'
    })
    current = loaded.bindMemberReceipt(current, receiptInput(index, 'behavior', {
        verifierIdentity: `fresh-behavior-verifier-${index + 1}`,
        implementerIdentity: `implementer-${index + 1}`,
        freshContext: true,
        rolloutId: `behavior-rollout-${index + 1}`
    }))
    current = loaded.bindMemberReceipt(current, receiptInput(index, 'documentation', {
        writerIdentity: `documentation-writer-${index + 1}`,
        independentlyAttributed: true
    }))
    return loaded.recordMemberCommit(current, {
        memberIssueId: issues[index],
        commit: {
            commitSha: sha(['d', 'e', 'f'][index]),
            parentSha: index === 0 ? baseSha : sha(['d', 'e'][index - 1]),
            issueIds: [issues[index]],
            candidateSha: sha(['a', 'b', 'c'][index]),
            changedPaths: [`tools/member-${index + 1}.mjs`],
            atomic: true,
            independentlyRevertible: true
        }
    })
}

function completedSession(loaded) {
    let session = loaded.createAcceptanceGroupSession(proposal())
    for (let index = 0; index < issues.length; index += 1) {
        session = finishMember(loaded, session, index)
    }
    return session
}

test('G01 package owns the runtime; only eligible frozen proposals group and all others fall back without weaker gates', async () => {
    const loaded = await implementation()
    const eligible = loaded.evaluateGroupEligibility(proposal())
    assert.equal(eligible.eligible, true)
    assert.equal(eligible.disposition, 'acceptance-group-session')
    assert.deepEqual(eligible.memberOrder, issues)

    for (const invalid of [
        proposal({
            members: proposal().members.map((value, index) =>
                index === 1 ? { ...value, repository: 'ExampleOrg/RepositoryB' } : value)
        }),
        proposal({
            members: proposal().members.map((value, index) =>
                index === 2 ? { ...value, lowConflictParallelEligible: true } : value)
        }),
        proposal({ acceptedWithoutModification: false })
    ]) {
        const fallback = loaded.evaluateGroupEligibility(invalid)
        assert.equal(fallback.eligible, false)
        assert.equal(fallback.disposition, 'ordinary-per-issue')
        assert.equal(fallback.gatePolicy, 'per-issue-unchanged')
    }
})

test('G02 session freezes independent member classification, routing, test-contract and receipt slots', async () => {
    const loaded = await implementation()
    const session = loaded.createAcceptanceGroupSession(proposal())
    assert.equal(session.schema, 'issue-orchestration.acceptance-group-session.v1')
    assert.equal(session.groupId, groupId)
    assert.equal(session.baseEpoch, epochId)
    assert.equal(session.baseSha, baseSha)
    assert.deepEqual(session.memberOrder, issues)
    assert.equal(session.activeMemberIssue, null)
    assert.equal(session.activeWriteLeaseId, null)

    const members = issues.map((issueId) => session.members[issueId])
    assert.equal(new Set(members.map((value) => value.classificationDigest)).size, 3)
    assert.equal(new Set(members.map((value) => value.routingInputDigest)).size, 3)
    assert.equal(new Set(members.map((value) => value.testContractDigest)).size, 3)
    assert.deepEqual(members.map((value) => value.candidateIdentity), [null, null, null])
    assert.deepEqual(members.map((value) => value.commitSha), [null, null, null])
    assert.ok(members.every((value) => Object.keys(value.receipts).length === 0))
    assert.notDeepEqual(members[0].stageProfileIds, members[1].stageProfileIds)
})

test('G03 exactly one member write lease exists and a red member prevents activation of the next member', async () => {
    const loaded = await implementation()
    const session = loaded.createAcceptanceGroupSession(proposal())
    const leased = activateAndLease(loaded, session, 0)
    assert.equal(leased.activeMemberIssue, issues[0])
    assert.equal(leased.activeWriteLeaseId, 'write-lease-1')

    assertCode(() => loaded.acquireMemberWriteLease(leased, {
        memberIssueId: issues[1],
        leaseId: 'write-lease-2',
        stageRole: 'documentation-writer',
        ownerIdentity: 'documentation-writer-2'
    }), 'acceptance-group-write-lease-active')

    const releasedRed = loaded.releaseMemberWriteLease(leased, {
        memberIssueId: issues[0],
        leaseId: 'write-lease-1',
        reason: 'implementation-incomplete'
    })
    assertCode(() => loaded.activateGroupMember(releasedRed, {
        memberIssueId: issues[1],
        classificationDigest: proposal().members[1].classificationDigest,
        routingInputDigest: proposal().members[1].routingInputDigest,
        stageProfileIds: proposal().members[1].stageProfileIds,
        testContractDigest: proposal().members[1].testContractDigest
    }), 'acceptance-group-current-member-not-green')
})

test('G04 candidate, self-test and behavior receipts stay member-bound and behavior verification is fresh', async () => {
    const loaded = await implementation()
    let session = activateAndLease(
        loaded,
        loaded.createAcceptanceGroupSession(proposal()),
        0
    )
    session = loaded.recordMemberCandidate(session, candidateInput(0))
    assert.equal(
        session.members[issues[0]].candidateIdentity.candidateSha,
        candidateInput(0).candidateIdentity.candidateSha
    )
    assert.equal(
        session.members[issues[0]].receipts.selfTest.receiptDigest,
        candidateInput(0).selfTestReceipt.receiptDigest
    )

    assertCode(() => loaded.bindMemberReceipt(session, receiptInput(1, 'behavior', {
        verifierIdentity: 'fresh-verifier-b',
        implementerIdentity: 'implementer-2',
        freshContext: true,
        rolloutId: 'behavior-rollout-b',
        memberIssueId: issues[0]
    })), 'acceptance-group-receipt-member-mismatch')

    session = loaded.releaseMemberWriteLease(session, {
        memberIssueId: issues[0],
        leaseId: 'write-lease-1',
        reason: 'implementation-complete'
    })
    assertCode(() => loaded.bindMemberReceipt(session, receiptInput(0, 'behavior', {
        verifierIdentity: 'implementer-1',
        implementerIdentity: 'implementer-1',
        freshContext: false,
        rolloutId: 'implementation-rollout-1'
    })), 'acceptance-group-verifier-not-fresh')

    const verified = loaded.bindMemberReceipt(session, receiptInput(0, 'behavior', {
        verifierIdentity: 'fresh-behavior-verifier-1',
        implementerIdentity: 'implementer-1',
        freshContext: true,
        rolloutId: 'behavior-rollout-1'
    }))
    assert.equal(verified.members[issues[0]].receipts.behavior.status, 'verified')
    assert.equal(verified.members[issues[1]].receipts.behavior, undefined)
})

test('G05 each green member has one independently revertible commit and no commit can cover two issues', async () => {
    const loaded = await implementation()
    let session = loaded.createAcceptanceGroupSession(proposal())
    session = finishMember(loaded, session, 0)
    assert.equal(session.members[issues[0]].commitSha, sha('d'))
    assert.equal(session.members[issues[0]].status, 'green-committed')

    let second = activateAndLease(loaded, session, 1)
    second = loaded.recordMemberCandidate(second, candidateInput(1))
    second = loaded.releaseMemberWriteLease(second, {
        memberIssueId: issues[1],
        leaseId: 'write-lease-2',
        reason: 'implementation-complete'
    })
    second = loaded.bindMemberReceipt(second, receiptInput(1, 'behavior', {
        verifierIdentity: 'fresh-behavior-verifier-2',
        implementerIdentity: 'implementer-2',
        freshContext: true,
        rolloutId: 'behavior-rollout-2'
    }))
    second = loaded.bindMemberReceipt(second, receiptInput(1, 'documentation', {
        writerIdentity: 'documentation-writer-2',
        independentlyAttributed: true
    }))
    assertCode(() => loaded.recordMemberCommit(second, {
        memberIssueId: issues[1],
        commit: {
            commitSha: sha('e'),
            parentSha: sha('d'),
            issueIds: [issues[0], issues[1]],
            candidateSha: sha('b'),
            changedPaths: ['tools/member-2.mjs'],
            atomic: false,
            independentlyRevertible: false
        }
    }), 'acceptance-group-commit-not-atomic')
})

test('G06 source tip is immutable and drift creates a complete #1834 landing handoff without source-history rewrites', async () => {
    const loaded = await implementation()
    const completed = completedSession(loaded)
    const frozen = loaded.freezeGroupSource(completed, {
        sourceEpoch: epochId,
        sourceBase: baseSha,
        sourceWorktree: '/worktrees/acceptance-group-1831',
        sourceBranch: 'bootstrap-repair/1831-group',
        immutableSourceTip: sha('f'),
        dirtyInventory: [],
        untrackedInventory: [],
        resourceRetentionReceiptDigest: hash('9')
    })
    assert.equal(frozen.immutableSourceTip, sha('f'))
    assert.deepEqual(frozen.orderedGreenCommitPrefix, [sha('d'), sha('e'), sha('f')])
    assertCode(() => loaded.freezeGroupSource(frozen, {
        sourceEpoch: epochId,
        sourceBase: baseSha,
        sourceWorktree: '/worktrees/acceptance-group-1831',
        sourceBranch: 'bootstrap-repair/1831-group',
        immutableSourceTip: sha('9'),
        dirtyInventory: [],
        untrackedInventory: [],
        resourceRetentionReceiptDigest: hash('9')
    }), 'acceptance-group-source-tip-immutable')

    const direct = loaded.createLandingHandoff(frozen, {
        remoteDefaultSha: baseSha,
        currentEpoch: epochId,
        requiredReverificationClasses: []
    })
    assert.equal(direct.disposition, 'fast-forward-delivery-window')

    const handoff = loaded.createLandingHandoff(frozen, {
        remoteDefaultSha: sha('9'),
        currentEpoch: 'repositorya-master-epoch-1834',
        requiredReverificationClasses: ['behavior', 'documentation']
    })
    assert.equal(handoff.schema, 'issue-orchestration.landing-handoff.v1')
    assert.equal(handoff.disposition, 'landing-handoff-required')
    assert.equal(handoff.immutableSourceTip, sha('f'))
    assert.deepEqual(handoff.orderedGreenCommitPrefix, [sha('d'), sha('e'), sha('f')])
    assert.deepEqual(Object.keys(handoff.memberMapping), issues)
    assert.equal(handoff.resourceRetentionReceiptDigest, hash('9'))
    assert.deepEqual(handoff.sourceHistoryOperations, [])
})

test('G07 a verified human-pending member remains visible and blocks conflicting successors instead of becoming group-green', async () => {
    const loaded = await implementation()
    let session = loaded.createAcceptanceGroupSession(proposal())
    session = finishMember(loaded, session, 0)

    assertCode(() => loaded.markMemberHumanDecisionPending(session, {
        memberIssueId: issues[1],
        request: {
            schema: 'issue-orchestration.human-decision-request.v1',
            verificationStatus: 'unverified',
            requestDigest: hash('a')
        },
        retainedResourceReceiptDigest: hash('b')
    }), 'acceptance-group-human-request-unverified')

    const pending = loaded.markMemberHumanDecisionPending(session, {
        memberIssueId: issues[1],
        request: {
            schema: 'issue-orchestration.human-decision-request.v1',
            verificationStatus: 'verified',
            memberIssueId: issues[1],
            requestDigest: hash('a')
        },
        retainedResourceReceiptDigest: hash('b')
    })
    const projection = loaded.projectGroupStatus(pending)
    assert.equal(pending.members[issues[1]].status, 'member-human-decision-pending')
    assert.equal(projection.status, 'member-human-decision-pending')
    assert.equal(projection.green, false)
    assert.deepEqual(projection.pendingHumanMembers, [issues[1]])
    assert.ok(projection.blockedMembers.includes(issues[2]))
})

test('G08 #1828 lifecycle carries the exact #5 authority migration', () => {
    assert.equal(existsSync(resourceLifecyclePath), true)
    assert.equal(digest(readFileSync(resourceLifecyclePath)), resourceLifecycleDigest)
})
