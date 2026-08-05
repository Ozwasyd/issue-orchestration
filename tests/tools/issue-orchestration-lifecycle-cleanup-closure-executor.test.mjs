import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    executeLifecycleCleanupClosureAction,
    LifecycleCleanupClosureExecutorError,
    lifecycleCleanupClosureActionTypes
} from '../../skills/issue-orchestration/scripts/lifecycle-cleanup-closure-executor.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    projectLifecycleRun,
    recordLifecycleActionResults
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    captureBaselineInventory
} from '../../skills/issue-orchestration/scripts/resource-lifecycle.mjs'
import {
    sealMachineReceipt
} from '../../skills/issue-orchestration/scripts/git-resource-cleanup.mjs'
import {
    sealRemoteStateSnapshot
} from '../../skills/issue-orchestration/scripts/remote-mutation-authority.mjs'
import {
    compileRuntimeExecutionBinding
} from '../../skills/issue-orchestration/scripts/runtime-execution-binding.mjs'
import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    compileScriptedLifecycleStageResult
} from './issue-orchestration/scripted-lifecycle-stage-result.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const CREATED_AT = '2026-08-05T01:00:00.000Z'
let sequence = 0

function git(args, cwd) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_DATE: CREATED_AT,
            GIT_COMMITTER_DATE: CREATED_AT
        }
    })
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout)
    }
    return result.stdout.trim()
}


function branchExists(repositoryPath, branchRef) {
    return spawnSync('git', [
        '-C', repositoryPath, 'show-ref', '--verify', '--quiet', branchRef
    ]).status === 0
}

function initRepository(root) {
    const bare = path.join(root, 'RepoA.git')
    const work = path.join(root, 'RepoA-work')
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'cleanup-executor-test'], work)
    git(['config', 'user.email', 'cleanup@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), '# RepoA\n')
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize RepoA'], work)
    git(['push', '-u', 'origin', 'main'], work)
    const repository = 'Fixture/RepoA'
    const remoteUrl = `https://github.com/${repository}.git`
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return {
        repository,
        bare,
        work,
        baseSha: git(['rev-parse', 'HEAD'], work)
    }
}

function selector(issue) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'cleanup-selector-v1',
        type: 'explicit-issues',
        repositories: [issue.repository],
        parameters: {
            issueIds: [`${issue.repository}#${issue.number}`],
            states: ['OPEN']
        },
        remoteQueryIdentity: 'cleanup-executor-test:explicit-issue'
    }
}

function actorRole(action) {
    switch (action.type) {
        case 'request-semantic-proposal':
            return 'dag-creator-updater'
        case 'compile-acceptance-contract':
            return 'acceptance-contract-compiler'
        case 'request-test-contract-planning':
        case 'dispatch-test-contract-writer':
        case 'dispatch-behavior-verifier':
            return 'test-owner'
        case 'dispatch-implementation-writer':
            return 'code-implementer'
        case 'dispatch-documentation-writer':
            return 'documentation-writer'
        default:
            throw new Error(`unexpected setup action: ${action.type}`)
    }
}

function rootRuntimeBinding({ startup, authority, rootControlLeaseDigest }) {
    const selectedProfile = 'terra-low'
    const routeDecisionDigest = digest('cleanup-root-route')
    const observation = seal({
        schema: 'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId: startup.attestation.runtimeInvocationId,
        actorSessionId: startup.attestation.runtimeSessionId,
        rootInvocationId: startup.attestation.runtimeInvocationId,
        requestedRole: 'root-scheduler',
        effectiveRole: 'root-scheduler',
        requestedPhase: 'scheduling',
        effectivePhase: 'scheduling',
        requestedProfile: selectedProfile,
        effectiveProfile: selectedProfile,
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: 'low',
        effectiveEffort: 'low',
        routeDecisionDigest,
        packageDigest: startup.observation.packageDigest,
        modelPoolPolicyDigest:
            startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            startup.observation.policyDigests.executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-05T01:20:00.000Z'
    }, 'observationDigest')
    return compileRuntimeExecutionBinding({
        stageRole: 'root-scheduler',
        stagePhase: 'scheduling',
        selectedProfile,
        routeDecisionDigest,
        runtimeObservation: observation,
        startup,
        runtimeTrustBinding: authority.runtimeTrustBinding,
        repositoryTargets: authority.repositoryTargets,
        writeLeaseDigest: rootControlLeaseDigest
    })
}

async function fixture({ dirty = false } = {}) {
    sequence += 1
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-state-'))
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-temp-root-'))
    const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-worktree-root-'))
    const quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-quarantine-'))
    const repository = initRepository(root)
    const issue = {
        repository: repository.repository,
        number: 1,
        state: 'OPEN',
        stateReason: null,
        updatedAt: '2026-08-05T01:00:01.000Z',
        title: 'Clean delivered issue',
        body: 'Clean canonical resources and close this issue.',
        comments: [],
        labels: ['code'],
        milestone: null,
        dependsOn: [],
        ui: false,
        group: 'cleanup-group'
    }
    const startup = verifiedRuntimeStartup({
        invocationId: `cleanup-root-${sequence}`,
        sessionId: `cleanup-session-${sequence}`,
        observedAt: '2026-08-05T01:00:00.000Z',
        attestedAt: '2026-08-05T01:00:01.000Z'
    })
    const runId = `cleanup-run-${sequence}`
    const baseline = await captureBaselineInventory({
        repositoryRoots: [repository.work],
        temporaryRoots: [temporaryRoot]
    })
    const candidateBranch = 'candidate/cleanup-1'
    const candidateWorktree = path.join(worktreeParent, 'candidate-cleanup-1')
    git([
        'worktree', 'add', '-b', candidateBranch,
        candidateWorktree, 'main'
    ], repository.work)
    git(['config', 'user.name', 'cleanup-executor-test'], candidateWorktree)
    git(['config', 'user.email', 'cleanup@example.invalid'], candidateWorktree)
    fs.mkdirSync(path.join(candidateWorktree, 'src'), { recursive: true })
    fs.writeFileSync(
        path.join(candidateWorktree, 'src', 'candidate.mjs'),
        'export const candidate = true\n'
    )
    git(['add', 'src/candidate.mjs'], candidateWorktree)
    git(['commit', '-m', 'candidate cleanup implementation'], candidateWorktree)
    const candidateSha = git(['rev-parse', 'HEAD'], candidateWorktree)
    if (dirty) {
        fs.writeFileSync(
            path.join(candidateWorktree, 'recover-me.txt'),
            'unique untracked work\n'
        )
    }
    const authority = compileLifecycleRunGenesisAuthority({
        runId,
        startup,
        stateRoot,
        repositoryTargets: [{
            repository: repository.repository,
            repositoryPath: repository.work,
            defaultBranch: 'main'
        }],
        workspaces: [root],
        worktrees: [],
        slotCapacity: 2,
        createdAt: CREATED_AT
    })
    const binding = repositoryAuthorityFor(authority, repository.repository)
    repository.bindingDigest = binding.bindingDigest
    repository.baseSha = binding.observedDefaultBranchHead
    const attemptId = `cleanup-attempt-${sequence}`
    const worktreeResourceId = `cleanup-worktree-${sequence}`
    const branchResourceId = `cleanup-branch-${sequence}`
    const leaseId = `cleanup-lease-${sequence}`
    const slotId = `cleanup-slot-${sequence}`
    const temporaryDirectory = path.join(temporaryRoot, `attempt-${sequence}`)
    fs.mkdirSync(temporaryDirectory)
    const leasePath = path.join(temporaryDirectory, 'lease.json')
    fs.writeFileSync(leasePath, JSON.stringify({
        leaseId,
        runId,
        attemptId,
        resourceId: worktreeResourceId,
        state: 'active'
    }))
    const issueId = `${issue.repository}#${issue.number}`
    const selectorDefinition = selector(issue)
    const remoteIssues = [{
        ...issue,
        baseSha: repository.baseSha
    }]
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selectorDefinition,
        remoteIssues,
        previousReceipt: null,
        resolvedAt: '2026-08-05T01:01:00.000Z'
    })
    const policyDigest = digest('cleanup-policy')
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest([issueId]),
        semanticGraphInputDigest: digest(remoteIssues),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: repository.baseSha,
            bindingDigest: repository.bindingDigest
        }],
        nodes: [{
            id: issueId,
            memberId: issueId,
            repository: repository.repository,
            issueNumber: issue.number,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: 'bounded',
            uiClass: 'non-ui',
            acceptanceGroup: issue.group,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: repository.bindingDigest,
            semanticFactsDigest: digest(issue),
            receipts: {}
        }]
    })
    let ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition,
        semanticGraph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        lifecycleAuthority: authority,
        startup,
        slotCapacity: 2
    })
    git(['merge', '--ff-only', candidateBranch], repository.work)
    git(['push', 'origin', 'main'], repository.work)
    let step = 2
    while (true) {
        const actionSet = compileLifecycleRunActionSet(ledger, { startup })
        if (actionSet.actions.every(({ type }) =>
            type === 'deliver-acceptance-group')) {
            break
        }
        const state = projectLifecycleRun(ledger, { startup }).state
        const results = actionSet.actions.map((action) => {
            const node = state.nodes[action.nodeId]
            const facts = action.type === 'compile-acceptance-contract'
                ? { documentationRequired: true }
                : action.type === 'dispatch-documentation-writer'
                    ? { mode: 'no-change' }
                    : action.type === 'dispatch-implementation-writer'
                        ? { candidateSha }
                        : {}
            return compileScriptedLifecycleStageResult({
                action,
                node,
                actorRole: actorRole(action),
                mode: 'completed',
                facts
            })
        })
        ledger = recordLifecycleActionResults({
            ledger,
            actionSet,
            stageResults: results,
            startup,
            createdAt: `2026-08-05T01:${String(step).padStart(2, '0')}:00.000Z`
        })
        step += 1
        assert.ok(step < 30, 'fixture did not reach delivery')
    }
    const deliveryFacts = {
        effectId: `delivery-effect-${sequence}`,
        commits: { [issueId]: candidateSha },
        candidateMappingDigest: digest({ issueId, candidateSha }),
        landingReceiptDigest: digest({ issueId, candidateSha, kind: 'landing' }),
        landingReceiptDigests: {
            [repository.repository]: digest({
                repository: repository.repository,
                candidateSha,
                kind: 'landing'
            })
        },
        repositoryEffects: [{
            repository: repository.repository,
            resultingRemoteSha: candidateSha
        }],
        remotePreStateDigest: digest('delivery-pre'),
        remotePostStateDigest: digest('delivery-post')
    }
    let actionSet = compileLifecycleRunActionSet(ledger, { startup })
    let action = actionSet.actions[0]
    let state = projectLifecycleRun(ledger, { startup }).state
    let result = compileScriptedLifecycleStageResult({
        action,
        node: null,
        actorRole: 'root-delivery-adapter',
        mode: 'remote-effect-applied',
        facts: deliveryFacts
    })
    ledger = recordLifecycleActionResults({
        ledger,
        actionSet,
        stageResults: [result],
        startup,
        createdAt: '2026-08-05T01:25:00.000Z'
    })
    actionSet = compileLifecycleRunActionSet(ledger, { startup })
    action = actionSet.actions[0]
    state = projectLifecycleRun(ledger, { startup }).state
    result = compileScriptedLifecycleStageResult({
        action,
        node: null,
        actorRole: 'root-delivery-adapter',
        mode: 'completed',
        facts: deliveryFacts
    })
    ledger = recordLifecycleActionResults({
        ledger,
        actionSet,
        stageResults: [result],
        startup,
        createdAt: '2026-08-05T01:26:00.000Z'
    })
    assert.equal(
        projectLifecycleRun(ledger, { startup }).state.nodes[issueId]
            .lifecycleState,
        'cleaning'
    )
    const rootControlLeaseDigest = digest('cleanup-root-control-lease')
    const runtimeExecutionBinding = rootRuntimeBinding({
        startup,
        authority,
        rootControlLeaseDigest
    })
    const resourceRegistry = {
        schema: 'issue-orchestration.resource-registry.v1',
        runId,
        issueId,
        stageAttemptId: attemptId,
        stageRole: 'code-implementer',
        issueWorktreeId: worktreeResourceId,
        baseSha: repository.baseSha,
        epochId: `epoch-cleanup-${sequence}`,
        allowedPathsDigest: digest(['src/candidate.mjs']),
        testContractDigest: digest(`test-contract-${sequence}`),
        slotHeld: true,
        writeLease: {
            id: leaseId,
            ownerAttemptId: attemptId,
            mode: 'write',
            state: 'active'
        },
        resources: [
            {
                resourceId: worktreeResourceId,
                resourceType: 'worktree',
                ownerClass: 'attempt-owned',
                ownerRunId: runId,
                ownerAttemptId: attemptId,
                state: 'active',
                cleanupPolicy: 'git-worktree-remove-and-prune',
                identityEvidence: {
                    path: candidateWorktree,
                    branch: candidateBranch,
                    baseSha: repository.baseSha
                }
            },
            {
                resourceId: branchResourceId,
                resourceType: 'branch',
                ownerClass: 'attempt-owned',
                ownerRunId: runId,
                ownerAttemptId: attemptId,
                state: 'active',
                cleanupPolicy: 'delete-after-worktree-removed',
                identityEvidence: {
                    name: candidateBranch,
                    repositoryRoot: repository.work
                }
            },
            {
                resourceId: `cleanup-lease-resource-${sequence}`,
                resourceType: 'lease',
                ownerClass: 'attempt-owned',
                ownerRunId: runId,
                ownerAttemptId: attemptId,
                state: 'active',
                cleanupPolicy: 'release-after-verified-cleanup',
                identityEvidence: {
                    path: leasePath,
                    ownerAttemptId: attemptId
                }
            },
            {
                resourceId: `cleanup-temp-${sequence}`,
                resourceType: 'temporary-directory',
                ownerClass: 'attempt-owned',
                ownerRunId: runId,
                ownerAttemptId: attemptId,
                state: 'active',
                cleanupPolicy: 'remove-owned-only',
                identityEvidence: { path: temporaryDirectory }
            }
        ]
    }
    const slotReleaseObservation = sealMachineReceipt({
        schema: 'issue-orchestration.resource-slot-release-observation.v1',
        producerAuthority: 'machine-resource-slot-registry',
        runId,
        attemptId,
        resourceId: worktreeResourceId,
        slotId,
        releaseAuthorized: true,
        released: false,
        activeResourceReferences: [],
        observedAt: '2026-08-05T01:31:00.000Z'
    }, 'observationDigest')
    let issueState = 'OPEN'
    let stateReason = null
    let closeCount = 0
    const adapter = {
        calls: [],
        async prepareCleanup() {
            this.calls.push('prepare')
            return {
                baseline,
                resourceRegistry,
                gitResources: [{
                    repository: repository.repository,
                    repositoryPath: repository.work,
                    worktreePath: candidateWorktree,
                    worktreeResourceId,
                    branchResourceId,
                    branchRef: `refs/heads/${candidateBranch}`,
                    defaultBranchRef: 'refs/heads/main',
                    baseSha: repository.baseSha,
                    candidateSha,
                    landingCommit: candidateSha,
                    deliveryEpoch: `epoch-cleanup-${sequence}`,
                    runId,
                    attemptId,
                    stageRole: 'code-implementer',
                    sliceId: `slice-cleanup-${sequence}`,
                    leaseId,
                    leasePath,
                    slotId,
                    slotReleaseObservation,
                    resourceActorInvocationIds: [],
                    quarantineRoot
                }]
            }
        },
        async stopBoundActors() {
            this.calls.push('stop')
            return { actorShutdownReceipts: [] }
        },
        async observeIssue({ phase }) {
            this.calls.push(`observe:${phase}`)
            return {
                snapshot: sealRemoteStateSnapshot({
                    producerAuthority: 'trusted-remote-observer',
                    repository: repository.repository,
                    issueId,
                    defaultBranch: 'main',
                    defaultBranchSha: git(['rev-parse', 'main'], repository.work),
                    issueStateDigest: digest({ issueState, stateReason }),
                    observedAt: phase === 'post-mutation' ||
                        phase === 'reobserve-post-mutation'
                        ? '2026-08-05T01:32:02.000Z'
                        : '2026-08-05T01:32:00.000Z'
                }),
                issueState,
                stateReason
            }
        },
        async applyRemoteMutation({ mutation }) {
            this.calls.push('apply-close')
            assert.equal(mutation.action, 'state-transition')
            closeCount += 1
            issueState = 'CLOSED'
            stateReason = 'COMPLETED'
        }
    }
    return {
        root,
        stateRoot,
        temporaryRoot,
        worktreeParent,
        quarantineRoot,
        repository,
        issueId,
        startup,
        authority,
        rootControlLeaseDigest,
        runtimeExecutionBinding,
        candidateSha,
        candidateBranch,
        candidateWorktree,
        leasePath,
        temporaryDirectory,
        adapter,
        get ledger() { return ledger },
        set ledger(value) { ledger = value },
        get closeCount() { return closeCount },
        setRemoteState(nextState, nextReason) {
            issueState = nextState
            stateReason = nextReason
        },
        context(overrides = {}) {
            const currentActionSet = compileLifecycleRunActionSet(ledger, {
                startup
            })
            return {
                ledger,
                actionSet: currentActionSet,
                action: currentActionSet.actions[0],
                createdAt: '2026-08-05T01:30:00.000Z',
                timestamps: {
                    issuedAt: '2026-08-05T01:30:00.000Z',
                    observedAt: '2026-08-05T01:32:00.000Z',
                    expiresAt: '2026-08-05T01:34:00.000Z'
                },
                startup,
                stateRootPath: stateRoot,
                runtimeTrustBinding: authority.runtimeTrustBinding,
                repositoryTargets: authority.repositoryTargets,
                runtimeExecutionBinding,
                rootControlLeaseDigest,
                cleanupAdapter: adapter,
                ...overrides
            }
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
            fs.rmSync(temporaryRoot, { recursive: true, force: true })
            fs.rmSync(worktreeParent, { recursive: true, force: true })
            fs.rmSync(quarantineRoot, { recursive: true, force: true })
        }
    }
}

test('cleanup executor owns the canonical git/resource/closure chain', async () => {
    const f = await fixture()
    try {
        const completed = await executeLifecycleCleanupClosureAction(
            f.context()
        )
        f.ledger = completed.ledger
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        const node = projection.state.nodes[f.issueId]
        assert.equal(node.lifecycleState, 'closed')
        assert.equal(node.deliveryCommit, f.candidateSha)
        assert.equal(f.closeCount, 1)
        assert.equal(fs.existsSync(f.candidateWorktree), false)
        assert.equal(fs.existsSync(f.leasePath), false)
        assert.equal(fs.existsSync(f.temporaryDirectory), false)
        assert.equal(
            branchExists(
                f.repository.work,
                `refs/heads/${f.candidateBranch}`
            ),
            false
        )
        assert.ok(
            projection.aggregateProjection.cleanupFinalizations[f.issueId]
        )
        assert.ok(projection.aggregateProjection.closureEffects[f.issueId])
        assert.equal(
            projection.aggregateProjection.pendingClosureEffects[f.issueId],
            undefined
        )
        assert.equal(
            git(['rev-parse', 'main'], f.repository.work),
            f.candidateSha
        )
    } finally {
        f.cleanup()
    }
})

test('remote close success is recovered without a duplicate mutation', async () => {
    const f = await fixture()
    try {
        let interrupted
        try {
            await executeLifecycleCleanupClosureAction(f.context({
                interruptAfterRemoteEffect: true
            }))
            assert.fail('expected interruption')
        } catch (error) {
            assert.ok(error instanceof LifecycleCleanupClosureExecutorError)
            assert.equal(error.code, 'cleanup-interrupted-after-remote-effect')
            interrupted = error
        }
        f.ledger = interrupted.details.ledger
        assert.equal(f.closeCount, 1)
        const pending = projectLifecycleRun(f.ledger, {
            startup: f.startup
        }).aggregateProjection.pendingClosureEffects[f.issueId]
        assert.ok(pending)
        const completed = await executeLifecycleCleanupClosureAction(
            f.context()
        )
        f.ledger = completed.ledger
        assert.equal(f.closeCount, 1)
        assert.equal(
            projectLifecycleRun(f.ledger, { startup: f.startup })
                .state.nodes[f.issueId].lifecycleState,
            'closed'
        )
    } finally {
        f.cleanup()
    }
})

test('dirty unique work is quarantined and prevents remote closure', async () => {
    const f = await fixture({ dirty: true })
    try {
        await assert.rejects(
            executeLifecycleCleanupClosureAction(f.context()),
            (error) => error instanceof LifecycleCleanupClosureExecutorError &&
                error.code === 'cleanup-recoverable-work-quarantined'
        )
        assert.equal(f.closeCount, 0)
        assert.equal(
            projectLifecycleRun(f.ledger, { startup: f.startup })
                .state.nodes[f.issueId].lifecycleState,
            'cleaning'
        )
    } finally {
        f.cleanup()
    }
})

test('unsupported actions are rejected before adapter side effects', async () => {
    const f = await fixture()
    try {
        const context = f.context()
        context.action = {
            ...context.action,
            type: 'terminalize-node'
        }
        await assert.rejects(
            executeLifecycleCleanupClosureAction(context),
            (error) => error instanceof LifecycleCleanupClosureExecutorError &&
                error.code === 'cleanup-action-unsupported'
        )
        assert.deepEqual(f.adapter.calls, [])
        assert.equal(f.closeCount, 0)
    } finally {
        f.cleanup()
    }
})

test('cleanup action type export is exhaustive and immutable', () => {
    assert.deepEqual([...lifecycleCleanupClosureActionTypes], [
        'cleanup-node-resources'
    ])
    assert.equal(Object.isFrozen(lifecycleCleanupClosureActionTypes), true)
})
