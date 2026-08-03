import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import {
    validateJsonSchema
} from '../../tools/test-matrix/schema-validator/validate.mjs'

const runtimeStateRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'issue-orchestration-landing-lane-state-'
))
process.env.FSUS_ISSUE_ORCHESTRATION_STATE_ROOT = runtimeStateRoot

const {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    writerTestDigest
} = await import('./issue-orchestration-writer-stage-test-helper.mjs')
const {
    compileCanonicalRoute
} = await import(
    '../../skills/'
    + 'issue-orchestration/scripts/execution-route-compiler.mjs'
)
const landing = await import(
    '../../skills/'
    + 'issue-orchestration/scripts/repository-landing-lane.mjs'
)

const repository = 'ExampleOrg/RepositoryA'
const members = [`${repository}#1834-a`, `${repository}#1834-b`]
const sha = (character) => character.repeat(40)
const hash = (value) => writerTestDigest(value)
const fixture = createWriterStageGitFixture({
    filePaths: [
        'src/landing/member-a.mjs',
        'src/landing/member-b.mjs'
    ]
})

function assertSchema(name, value) {
    const schema = JSON.parse(fs.readFileSync(path.join(
        process.cwd(),
        'contracts',
        `${name}.schema.json`
    ), 'utf8'))
    assert.deepEqual(validateJsonSchema(value, schema), [])
}
const artifacts = compileWriterStageTestArtifacts({
    repository,
    issue: 1834,
    stageRole: 'code-implementer',
    stagePhase: 'landing-conflict-resolution',
    baseSha: fixture.baseSha,
    epochId: 'epoch-landing-target-1834',
    worktreeIdentity: fixture.worktreeIdentity,
    allowedPaths: [...fixture.filePaths],
    requiredFiles: [...fixture.filePaths],
    requiredCommands: [
        `git show --stat ${sha('a')}`,
        `git show --stat ${sha('b')}`
    ],
    requiredEvidence: [
        'old-to-new-sha-map',
        'patch-and-tree-equivalence'
    ],
    sliceCount: 2,
    sliceId: 'landing-member-a-transplant',
    sliceOverrides: [
        {
            singleObjective: 'Transplant one member A commit',
            firstRequiredAction: `git show --stat ${sha('a')}`,
            firstReadTargets: [fixture.filePaths[0]],
            firstWritablePath: fixture.filePaths[0],
            requiredEvidence: [
                'old-to-new-sha-map',
                'patch-and-tree-equivalence'
            ],
            explicitNonGoals: [
                'modify the immutable source worktree',
                'transplant another member',
                'resolve another conflict cluster'
            ]
        },
        {
            singleObjective: 'Transplant one member B commit',
            firstRequiredAction: `git show --stat ${sha('b')}`,
            firstReadTargets: [fixture.filePaths[1]],
            firstWritablePath: fixture.filePaths[1],
            requiredEvidence: [
                'old-to-new-sha-map',
                'patch-and-tree-equivalence'
            ],
            explicitNonGoals: [
                'modify the immutable source worktree',
                'transplant another member',
                'resolve another conflict cluster'
            ]
        }
    ]
})

after(() => {
    fixture.dispose()
    fs.rmSync(runtimeStateRoot, { force: true, recursive: true })
})

function handoff(overrides = {}) {
    return {
        schema: 'issue-orchestration.landing-handoff.v1',
        disposition: 'landing-handoff-required',
        groupId: 'group-1834-contract',
        repository,
        sourceEpoch: 'source-epoch-1831',
        sourceBase: sha('0'),
        sourceWorktree: '/worktrees/source-group-1831',
        sourceBranch: 'acceptance-group/1831',
        immutableSourceTip: sha('b'),
        orderedGreenCommitPrefix: [sha('a'), sha('b')],
        memberMapping: {
            [members[0]]: {
                candidateSha: sha('1'),
                commitSha: sha('a'),
                testContractDigest: hash('test-a'),
                receiptDigests: {
                    selfTest: hash('self-a'),
                    behavior: hash('behavior-a'),
                    documentation: hash('docs-a')
                }
            },
            [members[1]]: {
                candidateSha: sha('2'),
                commitSha: sha('b'),
                testContractDigest: hash('test-b'),
                receiptDigests: {
                    selfTest: hash('self-b'),
                    behavior: hash('behavior-b'),
                    documentation: hash('docs-b')
                }
            }
        },
        dirtyInventory: [],
        untrackedInventory: [],
        requiredReverificationClasses: ['behavior', 'documentation'],
        resourceRetentionReceiptDigest: hash('resource-retention'),
        sourceHistoryOperations: [],
        ...overrides
    }
}

function routeInput(index, metricOverrides = {}) {
    const executableSlice = artifacts.executableSlices[index]
    const base = {
        stageWorkPlan: artifacts.stageWorkPlan,
        executableSlice,
        routingClassification: {
            domain: 'orchestration-core',
            effectiveOwnerRepository: repository,
            engineeringRiskClass: 'bounded',
            uiDecisionClass: 'none',
            contractState: 'frozen',
            verificationClass: 'focused',
            modelRoutingEvidenceDigest: hash(`routing-${index}`),
            routingPolicyVersion: 'stage-model-pool.v3'
        },
        executionMetrics: {
            expectedChangedFileCount: 1,
            ownedModuleCount: 1,
            commandLoopCount: 1,
            runtimeProbeDepth: 0,
            toolInteractionDepth: 3,
            contextBreadth: 'narrow',
            statefulContinuationRequired: false,
            checkpointSupportRequired: 'resumable',
            firstActionDeterministic: true,
            wholeIssueScope: false,
            ...metricOverrides
        },
        machineClassificationEvidence: {
            schema: 'issue-orchestration.execution-shape-observation.v1',
            source: 'machine-slice-and-runtime-observer',
            observedAt: '2026-08-02T00:00:00+08:00',
            evidenceDigest: hash({ index, metricOverrides })
        }
    }
    const initial = compileCanonicalRoute(base)
    const selected =
        initial.executionRouteDecision.selectedProfile
    const [family, effort] = selected.split('-')
    const runtimeCapabilityObservation = {
        schema: 'issue-orchestration.runtime-capability-observation.v2',
        source: 'per-dispatch-runtime-identity-observer',
        observable: true,
        runtimeInvocationId: `landing-runtime-${index}`,
        sessionOrThreadId: `landing-thread-${index}`,
        runtimeVersion: 'codex-v2-test',
        requestedProfile: selected,
        effectiveProfile: selected,
        requestedModel: `gpt-5.6-${family}`,
        effectiveModel: `gpt-5.6-${family}`,
        requestedEffort: effort,
        effectiveEffort: effort,
        multiAgentBackend: 'v2',
        rawEventDigest: hash(`landing-events-${index}`),
        rawSessionDigest: hash(`landing-session-${index}`),
        rawTurnDigest: hash(`landing-turn-${index}`),
        observedAt: '2026-08-03T20:45:00+08:00'
    }
    runtimeCapabilityObservation.observationDigest =
        hash(runtimeCapabilityObservation)
    return { ...base, runtimeCapabilityObservation }
}

function laneAndAttempt(handoffOverrides = {}) {
    let lane = landing.createRepositoryLandingLane({
        repository,
        defaultBranch: 'master'
    })
    lane = landing.acquireRepositoryLandingLease(lane, {
        attemptId: 'landing-attempt-1834-1',
        landingLeaseId: 'landing-lease-1834-1',
        ownerIdentity: 'root-scheduler',
        acquiredAt: '2026-08-02T00:00:00.000Z'
    })
    const attempt = landing.createLandingAttempt({
        lane,
        handoff: handoff(handoffOverrides),
        attemptId: 'landing-attempt-1834-1',
        latestRemoteHead: fixture.baseSha,
        targetEpochId: 'epoch-landing-target-1834',
        landingLeaseId: 'landing-lease-1834-1',
        landingWorktreeIdentity: fixture.worktreeIdentity,
        landingBranch: 'landing/1834-1',
        resourceRegistryIdentity: 'resource-registry-1834'
    })
    return { lane, attempt }
}

function bindSlice(attempt, index, overrides = {}) {
    return landing.bindLandingSlice(attempt, {
        memberIssueId: members[index],
        sourceCommit: sha(index === 0 ? 'a' : 'b'),
        sliceKind: 'transplant-one-member-commit',
        conflictClusterId: null,
        stageWorkPlan: artifacts.stageWorkPlan,
        executableSlice: artifacts.executableSlices[index],
        compiledPrompt: artifacts.compiledPrompts[index],
        routeInput: routeInput(index),
        ...overrides
    })
}

function transplant(attempt, index, overrides = {}) {
    const newCommitSha = sha(index === 0 ? 'd' : 'e')
    return landing.recordCommitTransplant(attempt, {
        memberIssueId: members[index],
        sourceCommit: sha(index === 0 ? 'a' : 'b'),
        newCommitSha,
        parentSha: index === 0 ? fixture.baseSha : sha('d'),
        sourcePatchId: hash(`patch-${index}`),
        landedPatchId: hash(`patch-${index}`),
        sourceTreeDigest: hash(`source-tree-${index}`),
        landedTreeDigest: hash(`landed-tree-${index}`),
        changedPaths: [fixture.filePaths[index]],
        issueIds: [members[index]],
        conflictManifest: [],
        equivalenceDisposition: 'patch-and-tree-equivalent',
        candidateSha: newCommitSha,
        terminalReceiptDigest: hash(`terminal-${index}`),
        ...overrides
    })
}

function reverify(attempt, index) {
    let current = attempt
    const newCandidateSha = sha(index === 0 ? 'd' : 'e')
    for (const evidenceClass of ['behavior', 'documentation']) {
        const sourceReceiptDigest = handoff().memberMapping[
            members[index]
        ].receiptDigests[evidenceClass]
        current = landing.recordEvidenceRebinding(current, {
            memberIssueId: members[index],
            evidenceClass,
            disposition: 'reverify-required',
            sourceReceiptDigest,
            verifierReceiptDigest: hash(
                `rebinding-${index}-${evidenceClass}`
            )
        })
        current = landing.recordReverificationReceipt(current, {
            memberIssueId: members[index],
            evidenceClass,
            sourceReceiptDigest,
            receipt: {
                schema:
                    'issue-orchestration.member-reverification-receipt.v1',
                repository,
                memberIssueId: members[index],
                baseSha: fixture.baseSha,
                candidateSha: newCandidateSha,
                status: 'verified',
                receiptDigest: hash(
                    `reverified-${index}-${evidenceClass}`
                )
            }
        })
    }
    return current
}

test('L01 freezes six permanent landing schemas and the public runtime surface', () => {
    assert.deepEqual(Object.keys(landing).sort(), [
        'LandingLaneError',
        'acquireRepositoryLandingLease',
        'bindLandingSlice',
        'createLandingAttempt',
        'createRepositoryLandingLane',
        'createWorktreeDisposition',
        'finalizeLanding',
        'markLandingHumanDecisionPending',
        'observeLandingRemoteDrift',
        'recordCommitTransplant',
        'recordEvidenceRebinding',
        'recordLandingCheckpoint',
        'recordReverificationReceipt',
        'releaseRepositoryLandingLease',
        'replayLandingAttempt',
        'resumeLandingSlice'
    ])
    const contractRoot =
        'contracts'
    for (const identity of [
        'issue-orchestration.repository-landing-lane.v1',
        'issue-orchestration.worktree-disposition.v1',
        'issue-orchestration.commit-transplant-receipt.v1',
        'issue-orchestration.evidence-rebinding-receipt.v1',
        'issue-orchestration.landing-attempt.v1',
        'issue-orchestration.landing-receipt.v1'
    ]) {
        const file = path.join(
            process.cwd(),
            contractRoot,
            `${identity.split('.').at(-2)}.schema.json`
        )
        const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
        assert.equal(schema.title, identity)
        assert.equal(schema.properties.schema.const, identity)
    }
})

test('L02 one repository has one landing lease while another repository is independent', () => {
    const { lane } = laneAndAttempt()
    assert.throws(() => landing.acquireRepositoryLandingLease(lane, {
        attemptId: 'landing-attempt-1834-2',
        landingLeaseId: 'landing-lease-1834-2',
        ownerIdentity: 'root-scheduler',
        acquiredAt: '2026-08-02T00:01:00.000Z'
    }), { code: 'repository-landing-lease-active' })

    const uiLane = landing.acquireRepositoryLandingLease(
        landing.createRepositoryLandingLane({
            repository: 'ExampleOrg/RepositoryB',
            defaultBranch: 'main'
        }),
        {
            attemptId: 'landing-attempt-ui-280',
            landingLeaseId: 'landing-lease-ui-280',
            ownerIdentity: 'root-scheduler',
            acquiredAt: '2026-08-02T00:01:00.000Z'
        }
    )
    assert.equal(uiLane.state, 'landing-active')
})

test('L03 source identity is immutable and dirty or history-mutated handoffs fail closed', () => {
    assert.throws(
        () => laneAndAttempt({ sourceHistoryOperations: ['rebase'] }),
        { code: 'landing-source-history-mutated' }
    )
    assert.throws(
        () => laneAndAttempt({ dirtyInventory: ['M src/dirty.mjs'] }),
        { code: 'landing-source-dirty-uncollected' }
    )
    assert.throws(
        () => laneAndAttempt({ immutableSourceTip: sha('f') }),
        { code: 'landing-source-tip-prefix-mismatch' }
    )
})

test('L04 each writer slice binds one member, one source commit, #1874 prompt and #1875 route', () => {
    const { attempt } = laneAndAttempt()
    const active = bindSlice(attempt, 0)
    assert.equal(active.activeLandingSlice.memberIssueId, members[0])
    assert.equal(
        active.activeLandingSlice.compiledLandingPromptDigest,
        artifacts.compiledPrompts[0].promptDigest
    )
    assert.equal(
        active.activeLandingSlice.executionRouteDecisionDigest,
        compileCanonicalRoute(routeInput(0))
            .executionRouteDecision.routeDecisionDigest
    )
    assert.throws(() => bindSlice(attempt, 0, {
        memberIssueId: [members[0], members[1]]
    }), { code: 'landing-slice-single-member-required' })
    assert.throws(() => bindSlice(attempt, 0, {
        sourceCommit: sha('b')
    }), { code: 'landing-slice-source-commit-mismatch' })
    assert.throws(() => bindSlice(attempt, 0, {
        compiledPrompt: {
            ...artifacts.compiledPrompts[0],
            prompt: '处理全部冲突并交付'
        }
    }), { code: 'landing-slice-compiled-prompt-invalid' })
})

test('L05 partial checkpoint resumes the same cursor and cannot restart source inventory', () => {
    const { attempt } = laneAndAttempt()
    const active = bindSlice(attempt, 0)
    const checkpointed = landing.recordLandingCheckpoint(active, {
        memberIssueId: members[0],
        sourceCommit: sha('a'),
        conflictClusterId: null,
        status: 'partial',
        completedTransplantOperations: [],
        verifiedMappings: {},
        landingStatusDigest: hash('landing-status'),
        commandStatuses: [{
            command: `git show --stat ${sha('a')}`,
            exitCode: 0,
            outputDigest: hash('git-show-output')
        }],
        remainingOperations: ['cherry-pick source commit'],
        nextRequiredAction: `git cherry-pick ${sha('a')}`,
        resourceOwnershipDigest: hash('resource-owner'),
        checkpointDigest: hash('checkpoint-a')
    })
    assert.equal(
        checkpointed.state,
        'landing-slice-continuation-pending'
    )
    assert.throws(() => landing.resumeLandingSlice(checkpointed, {
        checkpointDigest: hash('checkpoint-a'),
        memberIssueId: members[0],
        sourceCommit: sha('a'),
        conflictClusterId: null,
        nextRequiredAction: 're-read the complete source inventory',
        restartSourceInventory: true
    }), { code: 'landing-continuation-restart-forbidden' })
    const resumed = landing.resumeLandingSlice(checkpointed, {
        checkpointDigest: hash('checkpoint-a'),
        memberIssueId: members[0],
        sourceCommit: sha('a'),
        conflictClusterId: null,
        nextRequiredAction: `git cherry-pick ${sha('a')}`,
        restartSourceInventory: false
    })
    assert.equal(resumed.state, 'landing-transplanting')
})

test('L06 transplant creates one old-to-new mapping and rejects squash, missing evidence and automatic conflict choice', () => {
    const { attempt } = laneAndAttempt()
    const active = bindSlice(attempt, 0)
    assert.throws(() => transplant(active, 0, {
        issueIds: members
    }), { code: 'landing-transplant-member-atomicity' })
    assert.throws(() => transplant(active, 0, {
        sourcePatchId: null
    }), { code: 'landing-transplant-evidence-invalid' })
    assert.throws(() => transplant(active, 0, {
        conflictManifest: [{
            conflictClusterId: 'cluster-a',
            paths: [fixture.filePaths[0]],
            status: 'resolved',
            resolutionStrategy: 'ours'
        }]
    }), { code: 'landing-conflict-automatic-choice-forbidden' })

    const transplanted = transplant(active, 0)
    assert.equal(transplanted.oldToNewCommitShaMap[sha('a')], sha('d'))
    assert.equal(
        transplanted.memberDisposition[members[0]],
        'transplanted-reverify-required'
    )

    const alreadyApplied = transplant(
        bindSlice(laneAndAttempt().attempt, 0),
        0,
        {
            newCommitSha: sha('a'),
            candidateSha: sha('a'),
            equivalenceDisposition: 'already-applied-equivalent',
            alreadyAppliedEvidenceDigest: hash('already-applied-a')
        }
    )
    assert.equal(alreadyApplied.oldToNewCommitShaMap[sha('a')], sha('a'))
    assert.equal(alreadyApplied.currentLandingTip, fixture.baseSha)
})

test('L07 new candidate cannot replay source receipts and every required class is reverified independently', () => {
    const { attempt } = laneAndAttempt()
    const transplanted = transplant(bindSlice(attempt, 0), 0)
    assert.throws(() => landing.recordReverificationReceipt(
        landing.recordEvidenceRebinding(transplanted, {
            memberIssueId: members[0],
            evidenceClass: 'behavior',
            disposition: 'reverify-required',
            sourceReceiptDigest: hash('behavior-a'),
            verifierReceiptDigest: hash('rebinding-behavior-a')
        }),
        {
            memberIssueId: members[0],
            evidenceClass: 'behavior',
            sourceReceiptDigest: hash('behavior-a'),
            receipt: {
                schema:
                    'issue-orchestration.member-reverification-receipt.v1',
                repository,
                memberIssueId: members[0],
                baseSha: fixture.baseSha,
                candidateSha: sha('d'),
                status: 'verified',
                receiptDigest: hash('behavior-a')
            }
        }
    ), { code: 'landing-reverification-source-receipt-replayed' })

    const verified = reverify(transplanted, 0)
    assert.deepEqual(
        Object.keys(verified.reverificationReceipts[members[0]]).sort(),
        ['behavior', 'documentation']
    )
})

test('L08 ordinary conflict cannot ask a human; multiple legal outcomes remain visible and block landing', () => {
    const contractUnique = transplant(
        bindSlice(laneAndAttempt().attempt, 0, {
            sliceKind: 'resolve-one-member-one-conflict-cluster',
            conflictClusterId: 'cluster-contract-unique'
        }),
        0,
        {
            landedPatchId: hash('contract-unique-landed-patch'),
            equivalenceDisposition: 'conflict-resolved-equivalent',
            conflictManifest: [{
                conflictClusterId: 'cluster-contract-unique',
                paths: [fixture.filePaths[0]],
                status: 'resolved',
                resolutionStrategy: 'contract-unique',
                resolutionAuthority: 'frozen-contract-unique',
                differenceEvidenceDigest:
                    hash('contract-unique-difference')
            }]
        }
    )
    assert.equal(contractUnique.conflictManifest.length, 1)
    assert.equal(
        contractUnique.memberDisposition[members[0]],
        'transplanted-reverify-required'
    )

    const { attempt } = laneAndAttempt()
    const active = bindSlice(attempt, 0, {
        sliceKind: 'resolve-one-member-one-conflict-cluster',
        conflictClusterId: 'cluster-a'
    })
    assert.throws(() => landing.markLandingHumanDecisionPending(active, {
        memberIssueId: members[0],
        sourceCommit: sha('a'),
        conflictClusterId: 'cluster-a',
        reason: 'ordinary-git-conflict',
        request: {
            schema: 'issue-orchestration.human-decision-request.v1',
            verificationStatus: 'verified',
            requestDigest: hash('human-request')
        }
    }), { code: 'landing-human-decision-not-authority-choice' })

    const pending = landing.markLandingHumanDecisionPending(active, {
        memberIssueId: members[0],
        sourceCommit: sha('a'),
        conflictClusterId: 'cluster-a',
        reason: 'multiple-legal-outcomes',
        request: {
            schema: 'issue-orchestration.human-decision-request.v1',
            verificationStatus: 'verified',
            memberIssueId: members[0],
            requestDigest: hash('human-request')
        }
    })
    assert.equal(pending.state, 'human-decision-pending')
    assert.equal(
        pending.memberDisposition[members[0]],
        'human-decision-pending'
    )
    assert.throws(() => landing.finalizeLanding(pending, {
        remoteHeadObservedBeforePush: fixture.baseSha,
        resultingRemoteSha: sha('e'),
        pushMode: 'fast-forward',
        fastForwardVerified: true,
        sourceRetirementDisposition: 'source-retained',
        cleanupReceiptDigest: hash('cleanup')
    }), { code: 'landing-attempt-not-ready' })
})

test('L09 remote drift rebuilds only landing state and preserves the immutable source', () => {
    const { attempt } = laneAndAttempt()
    const transplanted = transplant(bindSlice(attempt, 0), 0)
    const drift = landing.observeLandingRemoteDrift(transplanted, {
        observedRemoteHead: sha('9'),
        observedAt: '2026-08-02T00:02:00.000Z'
    })
    assert.equal(drift.disposition, 'rebuild-landing-attempt')
    assert.equal(
        drift.preservedSource.immutableSourceTip,
        sha('b')
    )
    assert.deepEqual(drift.sourceHistoryOperations, [])
    assert.equal(drift.attempt.state, 'remote-drifted')
})

test('L10 ordered green commits land by fast-forward, replay deterministically, then release the lane', () => {
    let { lane, attempt } = laneAndAttempt()
    attempt = reverify(transplant(bindSlice(attempt, 0), 0), 0)
    attempt = reverify(transplant(bindSlice(attempt, 1), 1), 1)
    const receipt = landing.finalizeLanding(attempt, {
        remoteHeadObservedBeforePush: fixture.baseSha,
        resultingRemoteSha: sha('e'),
        pushMode: 'fast-forward',
        fastForwardVerified: true,
        sourceRetirementDisposition: 'source-retired',
        cleanupReceiptDigest: hash('cleanup')
    })
    assert.equal(receipt.schema, 'issue-orchestration.landing-receipt.v1')
    assert.deepEqual(receipt.orderedLandedCommits, [sha('d'), sha('e')])
    assert.equal(receipt.sourceHistoryOperations.length, 0)
    assert.equal(
        landing.replayLandingAttempt(receipt.attempt).attemptDigest,
        receipt.attempt.attemptDigest
    )

    lane = landing.releaseRepositoryLandingLease(lane, {
        attemptId: attempt.attemptId,
        landingLeaseId: attempt.landingLeaseId,
        landingReceiptDigest: receipt.receiptDigest,
        releasedAt: '2026-08-02T00:03:00.000Z'
    })
    assert.equal(lane.state, 'landing-idle')
    assert.equal(lane.activeLease, null)
    const disposition = landing.createWorktreeDisposition({
        repository,
        worktreeIdentity: fixture.worktreeIdentity,
        memberIssueId: members[0],
        evidenceClass: 'source-retirement',
        disposition: 'source-retired',
        evidenceDigest: hash('source-retired')
    })
    assertSchema('repository-landing-lane', lane)
    assertSchema('worktree-disposition', disposition)
    assertSchema(
        'commit-transplant-receipt',
        receipt.attempt.transplantOperations[0]
    )
    assertSchema(
        'evidence-rebinding-receipt',
        receipt.attempt.evidenceDisposition[members[0]].behavior
    )
    assertSchema('landing-attempt', receipt.attempt)
    assertSchema('landing-receipt', receipt)
})
