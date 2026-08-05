import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    executeLifecycleDeliveryAction,
    LifecycleDeliveryExecutorError,
    lifecycleDeliveryActionTypes
} from '../../skills/issue-orchestration/scripts/lifecycle-delivery-executor.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    projectLifecycleRun,
    recordLifecycleActionResults,
    replayLifecycleRunLedger
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
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
    compileCanonicalRoute
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    compileScriptedLifecycleStageResult
} from './issue-orchestration/scripted-lifecycle-stage-result.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    compileWriterStageTestArtifacts
} from './issue-orchestration-writer-stage-test-helper.mjs'

const CREATED_AT = '2026-08-05T00:00:00.000Z'
let fixtureSequence = 0

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

function initRepository(root, key) {
    const bare = path.join(root, `${key}.git`)
    const work = path.join(root, `${key}-work`)
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'delivery-executor-test'], work)
    git(['config', 'user.email', 'delivery@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), `# ${key}\n`)
    git(['add', 'README.md'], work)
    git(['commit', '-m', `initialize ${key}`], work)
    git(['push', '-u', 'origin', 'main'], work)
    const repository = `Fixture/${key}`
    const remoteUrl = `https://github.com/${repository}.git`
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return {
        key,
        repository,
        bare,
        work,
        baseSha: git(['rev-parse', 'HEAD'], work)
    }
}

function issue(repository, number, { ui = false } = {}) {
    return {
        repository,
        number,
        state: 'OPEN',
        stateReason: null,
        updatedAt: `2026-08-05T00:00:${String(number).padStart(2, '0')}.000Z`,
        title: `Deliver issue ${number}`,
        body: ui
            ? 'Deliver this UI issue with fresh UX acceptance.'
            : 'Deliver this code issue with fresh behavior evidence.',
        comments: [],
        labels: ui ? ['ui-ux'] : ['code'],
        milestone: null,
        dependsOn: [],
        ui,
        group: 'delivery-group'
    }
}

function selector(issues) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'delivery-selector-v1',
        type: 'explicit-issues',
        repositories: [...new Set(issues.map(({ repository }) => repository))]
            .sort(),
        parameters: {
            issueIds: issues.map((value) =>
                `${value.repository}#${value.number}`).sort(),
            states: ['OPEN']
        },
        remoteQueryIdentity: 'delivery-executor-test:explicit-issues'
    }
}

function actorRole(action, node) {
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
            return node.uiClass === 'ui'
                ? 'ui-ux-implementer'
                : 'code-implementer'
        case 'request-ui-adjudication':
            return 'ui-system-adjudicator'
        case 'dispatch-ux-acceptance-verifier':
            return 'ux-acceptance-verifier'
        case 'dispatch-documentation-writer':
            return 'documentation-writer'
        default:
            throw new Error(`unexpected fixture action: ${action.type}`)
    }
}

function stageFacts(action, node) {
    if (action.type === 'compile-acceptance-contract') {
        return { documentationRequired: true }
    }
    if (action.type === 'dispatch-documentation-writer') {
        return { mode: 'no-change' }
    }
    if (action.type === 'dispatch-implementation-writer') {
        return {
            candidateSha: digest({ nodeId: node.id }).slice(0, 40)
        }
    }
    return {}
}

function rootRuntimeBinding({ startup, authority, rootControlLeaseDigest }) {
    const selectedProfile = 'terra-low'
    const routeDecisionDigest = digest('delivery-root-route')
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
        observedAt: '2026-08-05T00:20:00.000Z'
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

function fixture({ topology = [['RepoA', false], ['RepoA', false]] } = {}) {
    fixtureSequence += 1
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-state-'))
    const repositories = Object.fromEntries(
        [...new Set(topology.map(([key]) => key))]
            .map((key) => [key, initRepository(root, key)])
    )
    const issues = topology.map(([key, ui], index) =>
        issue(repositories[key].repository, index + 1, { ui }))
    const startup = verifiedRuntimeStartup({
        invocationId: `delivery-root-${fixtureSequence}`,
        sessionId: `delivery-session-${fixtureSequence}`,
        observedAt: '2026-08-05T00:00:00.000Z',
        attestedAt: '2026-08-05T00:00:01.000Z'
    })
    const runId = `delivery-run-${fixtureSequence}`
    const authority = compileLifecycleRunGenesisAuthority({
        runId,
        startup,
        stateRoot,
        repositoryTargets: Object.values(repositories).map((repository) => ({
            repository: repository.repository,
            repositoryPath: repository.work,
            defaultBranch: 'main'
        })),
        workspaces: [root],
        worktrees: [],
        slotCapacity: 4,
        createdAt: CREATED_AT
    })
    for (const repository of Object.values(repositories)) {
        const binding = repositoryAuthorityFor(
            authority,
            repository.repository
        )
        repository.bindingDigest = binding.bindingDigest
        repository.baseSha = binding.observedDefaultBranchHead
    }
    const selectorDefinition = selector(issues)
    const remoteIssues = issues.map((value) => ({
        ...value,
        baseSha: Object.values(repositories).find((repository) =>
            repository.repository === value.repository).baseSha
    }))
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selectorDefinition,
        remoteIssues,
        previousReceipt: null,
        resolvedAt: '2026-08-05T00:01:00.000Z'
    })
    const policyDigest = digest('delivery-policy')
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest(remoteIssues.map((value) =>
            `${value.repository}#${value.number}`).sort()),
        semanticGraphInputDigest: digest(remoteIssues),
        policyDigest,
        repositories: Object.values(repositories).map((repository) => ({
            repository: repository.repository,
            baseSha: repository.baseSha,
            bindingDigest: repository.bindingDigest
        })),
        nodes: remoteIssues.map((value) => ({
            id: `${value.repository}#${value.number}`,
            memberId: `${value.repository}#${value.number}`,
            repository: value.repository,
            issueNumber: value.number,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: value.ui ? 'high-risk' : 'bounded',
            uiClass: value.ui ? 'ui' : 'non-ui',
            acceptanceGroup: value.group,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: Object.values(repositories)
                .find((repository) =>
                    repository.repository === value.repository)
                .bindingDigest,
            semanticFactsDigest: digest(value),
            receipts: {}
        }))
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
        slotCapacity: 4
    })
    let sequence = 2
    while (true) {
        const actionSet = compileLifecycleRunActionSet(ledger, { startup })
        if (actionSet.actions.every(({ type }) =>
            type === 'deliver-acceptance-group')) {
            break
        }
        const state = projectLifecycleRun(ledger, { startup }).state
        const results = actionSet.actions.map((action) => {
            const node = state.nodes[action.nodeId]
            return compileScriptedLifecycleStageResult({
                action,
                node,
                actorRole: actorRole(action, node),
                mode: 'completed',
                facts: stageFacts(action, node)
            })
        })
        ledger = recordLifecycleActionResults({
            ledger,
            actionSet,
            stageResults: results,
            startup,
            createdAt: `2026-08-05T00:${String(sequence).padStart(2, '0')}:00.000Z`
        })
        sequence += 1
        assert.ok(sequence < 30, 'fixture did not reach delivery')
    }
    const rootControlLeaseDigest = digest('delivery-root-control-lease')
    const runtimeExecutionBinding = rootRuntimeBinding({
        startup,
        authority,
        rootControlLeaseDigest
    })
    return {
        root,
        stateRoot,
        repositories,
        issues,
        startup,
        authority,
        rootControlLeaseDigest,
        runtimeExecutionBinding,
        get ledger() { return ledger },
        set ledger(value) { ledger = value },
        actionSet() {
            return compileLifecycleRunActionSet(ledger, { startup })
        },
        context(adapter, overrides = {}) {
            const actionSet = this.actionSet()
            return {
                ledger,
                actionSet,
                action: actionSet.actions[0],
                createdAt: '2026-08-05T00:30:00.000Z',
                timestamps: {
                    issuedAt: '2026-08-05T00:30:00.000Z',
                    observedAt: '2026-08-05T00:30:02.000Z',
                    expiresAt: '2026-08-05T00:34:00.000Z'
                },
                startup,
                stateRootPath: stateRoot,
                runtimeTrustBinding: authority.runtimeTrustBinding,
                repositoryTargets: authority.repositoryTargets,
                runtimeExecutionBinding,
                rootControlLeaseDigest,
                deliveryAdapter: adapter,
                ...overrides
            }
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}

function deliveryAdapter(f) {
    const calls = []
    const remoteHeads = Object.fromEntries(
        Object.values(f.repositories).map((repository) => [
            repository.repository,
            repository.baseSha
        ])
    )
    const plans = new Map()
    const issueStateDigest = digest('OPEN')
    function routeInput({ artifacts, repository, index }) {
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
                modelRoutingEvidenceDigest: digest({ repository, index }),
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
                wholeIssueScope: false
            },
            machineClassificationEvidence: {
                schema: 'issue-orchestration.execution-shape-observation.v1',
                source: 'machine-slice-and-runtime-observer',
                observedAt: '2026-08-05T00:20:00.000Z',
                evidenceDigest: digest({ repository, index, kind: 'shape' })
            }
        }
        const initial = compileCanonicalRoute(base)
        const selected = initial.executionRouteDecision.selectedProfile
        const [family, effort] = selected.split('-')
        const capability = seal({
            schema: 'issue-orchestration.runtime-capability-observation.v2',
            source: 'per-dispatch-runtime-identity-observer',
            observable: true,
            runtimeInvocationId: `landing-runtime-${repository}-${index}`,
            sessionOrThreadId: `landing-session-${repository}-${index}`,
            runtimeVersion: 'codex-v2-test',
            requestedProfile: selected,
            effectiveProfile: selected,
            requestedModel: `gpt-5.6-${family}`,
            effectiveModel: `gpt-5.6-${family}`,
            requestedEffort: effort,
            effectiveEffort: effort,
            multiAgentBackend: 'v2',
            rawEventDigest: digest({ repository, index, kind: 'event' }),
            rawSessionDigest: digest({ repository, index, kind: 'session' }),
            rawTurnDigest: digest({ repository, index, kind: 'turn' }),
            observedAt: '2026-08-05T00:20:01.000Z'
        }, 'observationDigest')
        return { ...base, runtimeCapabilityObservation: capability }
    }
    const adapter = {
        calls,
        remoteHeads,
        async observeRepository(input) {
            calls.push(`observe:${input.phase}:${input.repository}`)
            return sealRemoteStateSnapshot({
                producerAuthority: 'trusted-remote-observer',
                repository: input.repository,
                issueId: input.representativeIssueId,
                defaultBranch: 'main',
                defaultBranchSha: remoteHeads[input.repository],
                issueStateDigest,
                observedAt: input.phase === 'pre-mutation'
                    ? '2026-08-05T00:30:00.000Z'
                    : '2026-08-05T00:30:02.000Z'
            })
        },
        async prepareLanding(input) {
            calls.push(`prepare:${input.repository}`)
            const sourceCommits = input.members.map(({ candidateSha }) =>
                candidateSha)
            const memberMapping = Object.fromEntries(input.members.map(
                (member) => [member.issueId, {
                    candidateSha: member.candidateSha,
                    commitSha: member.candidateSha,
                    testContractDigest: member.testContractDigest,
                    receiptDigests: Object.fromEntries(
                        Object.entries(member.evidenceDigests)
                            .filter(([key]) => key !== 'candidate')
                    )
                }]
            ))
            const allUi = input.members.every(({ uiClass }) =>
                uiClass === 'ui')
            const requiredReverificationClasses = [
                'behavior',
                'documentation',
                ...(allUi ? ['uxAcceptance'] : [])
            ]
            const repositoryFixture = Object.values(f.repositories)
                .find(({ repository }) => repository === input.repository)
            const paths = input.members.map((member) =>
                `src/delivered-${member.issueNumber}.mjs`)
            const repositoryKey = input.repository.replaceAll('/', '-')
            const artifacts = compileWriterStageTestArtifacts({
                repository: input.repository,
                issue: input.members[0].issueNumber,
                stageRole: 'code-implementer',
                stagePhase: 'landing-conflict-resolution',
                baseSha: repositoryFixture.baseSha,
                epochId: `epoch-target-${repositoryKey}-1`,
                worktreeIdentity: repositoryFixture.work,
                allowedPaths: paths,
                requiredFiles: paths,
                requiredCommands: sourceCommits.map((sha) =>
                    `git show --stat ${sha}`),
                requiredEvidence: [
                    'old-to-new-sha-map',
                    'patch-and-tree-equivalence'
                ],
                sliceCount: input.members.length,
                sliceId: `landing-${repositoryKey}-0`,
                sliceOverrides: input.members.map((member, index) => ({
                    singleObjective: `Transplant ${member.issueId}`,
                    firstRequiredAction:
                        `git show --stat ${member.candidateSha}`,
                    firstReadTargets: [paths[index]],
                    firstWritablePath: paths[index],
                    requiredEvidence: [
                        'old-to-new-sha-map',
                        'patch-and-tree-equivalence'
                    ],
                    explicitNonGoals: [
                        'modify the immutable source worktree',
                        'transplant another member'
                    ]
                }))
            })
            const plan = {
                attemptId: `landing-attempt-${repositoryKey}`,
                landingLeaseId: `landing-lease-${repositoryKey}`,
                acquiredAt: '2026-08-05T00:30:00.000Z',
                targetEpochId: `epoch-target-${repositoryKey}-1`,
                landingWorktreeIdentity: repositoryFixture.work,
                landingBranch: `landing/${input.groupId}`,
                resourceRegistryIdentity:
                    `landing-registry-${repositoryKey}`,
                sourceRetirementDisposition: 'source-retained',
                cleanupReceiptDigest:
                    digest({ input: input.repository, kind: 'cleanup' }),
                handoff: {
                    schema: 'issue-orchestration.landing-handoff.v1',
                    disposition: 'landing-handoff-required',
                    groupId: input.groupId,
                    repository: input.repository,
                    sourceEpoch: `epoch-source-${repositoryKey}-1`,
                    sourceBase: input.members[0].baseSha,
                    sourceWorktree: repositoryFixture.work,
                    sourceBranch: `candidate/${input.groupId}`,
                    immutableSourceTip: sourceCommits.at(-1),
                    orderedGreenCommitPrefix: sourceCommits,
                    memberMapping,
                    dirtyInventory: [],
                    untrackedInventory: [],
                    requiredReverificationClasses,
                    resourceRetentionReceiptDigest:
                        digest({ input: input.repository, kind: 'retention' }),
                    sourceHistoryOperations: []
                },
                artifacts,
                paths,
                members: input.members
            }
            plans.set(input.repository, plan)
            return plan
        },
        async prepareLandingSlice(input) {
            calls.push(`slice:${input.member.issueId}`)
            const plan = plans.get(input.repository)
            const index = plan.members.findIndex(({ issueId }) =>
                issueId === input.member.issueId)
            return {
                sliceKind: 'transplant-one-member-commit',
                conflictClusterId: null,
                stageWorkPlan: plan.artifacts.stageWorkPlan,
                executableSlice: plan.artifacts.executableSlices[index],
                compiledPrompt: plan.artifacts.compiledPrompts[index],
                routeInput: routeInput({
                    artifacts: plan.artifacts,
                    repository: input.repository,
                    index
                })
            }
        },
        async transplantMember(input) {
            calls.push(`transplant:${input.member.issueId}`)
            const plan = plans.get(input.repository)
            const index = plan.members.findIndex(({ issueId }) =>
                issueId === input.member.issueId)
            const newCommitSha = digest({
                repository: input.repository,
                issueId: input.member.issueId,
                parentSha: input.attempt.currentLandingTip
            }).slice(0, 40)
            return {
                newCommitSha,
                parentSha: input.attempt.currentLandingTip,
                sourcePatchId: digest({ input: input.member.issueId, kind: 'patch' }),
                landedPatchId: digest({ input: input.member.issueId, kind: 'patch' }),
                sourceTreeDigest: digest({ input: input.member.issueId, kind: 'source-tree' }),
                landedTreeDigest: digest({ input: input.member.issueId, kind: 'landed-tree' }),
                changedPaths: [plan.paths[index]],
                conflictManifest: [],
                equivalenceDisposition: 'patch-and-tree-equivalent',
                candidateSha: newCommitSha,
                terminalReceiptDigest:
                    digest({ input: input.member.issueId, kind: 'terminal' })
            }
        },
        async reverifyMember(input) {
            calls.push(`reverify:${input.member.issueId}:${input.evidenceClass}`)
            return {
                disposition: 'reverify-required',
                sourceIndependent: false,
                verifierReceiptDigest: digest({
                    input: input.member.issueId,
                    evidenceClass: input.evidenceClass,
                    kind: 'binding'
                }),
                receipt: {
                    schema:
                        'issue-orchestration.member-reverification-receipt.v1',
                    repository: input.repository,
                    memberIssueId: input.member.issueId,
                    baseSha: input.baseSha,
                    candidateSha: input.candidateSha,
                    status: 'verified',
                    receiptDigest: digest({
                        input: input.member.issueId,
                        evidenceClass: input.evidenceClass,
                        candidateSha: input.candidateSha
                    })
                }
            }
        },
        async applyRemoteMutation(input) {
            calls.push(`apply:${input.repository}`)
            assert.equal(input.permission.status, 'authorized')
            remoteHeads[input.repository] =
                input.landingReceipt.resultingRemoteSha
        }
    }
    return adapter
}

test('delivery executor exposes only the canonical delivery action', () => {
    assert.deepEqual(lifecycleDeliveryActionTypes, [
        'deliver-acceptance-group'
    ])
})

test('unsupported action is rejected before freeze, landing, or remote observation', async () => {
    const f = fixture({ topology: [['RepoA', false]] })
    try {
        const adapter = deliveryAdapter(f)
        const context = f.context(adapter)
        await assert.rejects(
            executeLifecycleDeliveryAction({
                ...context,
                action: {
                    ...context.action,
                    type: 'cleanup-node-resources'
                }
            }),
            (error) => error.code === 'delivery-action-unsupported'
        )
        assert.deepEqual(adapter.calls, [])
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        assert.equal(
            projection.aggregateProjection
                .deliveryFreezes['delivery-group'],
            undefined
        )
    } finally {
        f.cleanup()
    }
})

test('one repository acquires one lane and delivers every exact member', async () => {
    const f = fixture()
    try {
        const adapter = deliveryAdapter(f)
        const action = f.actionSet().actions[0]
        const sourceCandidates = Object.fromEntries(
            action.bindings.memberBindings.map((member) => [
                member.nodeId,
                projectLifecycleRun(f.ledger, { startup: f.startup })
                    .state.nodes[member.nodeId]
                    .receipts.candidate.evidence.candidateSha
            ])
        )
        const completed = await executeLifecycleDeliveryAction(
            f.context(adapter)
        )
        f.ledger = completed.ledger
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('prepare:')).length,
            1
        )
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('apply:')).length,
            1
        )
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        const { aggregateProjection, state } = projection
        assert.equal(
            aggregateProjection.deliveryEffects['delivery-group'].status,
            'completed'
        )
        assert.equal(
            aggregateProjection.pendingDeliveryEffects['delivery-group'],
            undefined
        )
        assert.equal(
            aggregateProjection.deliveryFreezes['delivery-group'].active,
            false
        )
        assert.equal(
            Object.keys(aggregateProjection.cleanupFinalizations).length,
            0
        )
        assert.equal(aggregateProjection.terminal, null)
        for (const [nodeId, sourceCandidate] of
            Object.entries(sourceCandidates)) {
            assert.equal(state.nodes[nodeId].lifecycleState, 'cleaning')
            assert.equal(
                projectLifecycleRun(f.ledger, { startup: f.startup })
                    .state.nodes[nodeId]
                    .receipts.candidate.evidence.candidateSha,
                sourceCandidate
            )
        }
    } finally {
        f.cleanup()
    }
})

test('two-repository remote success recovers by observation without duplicate mutation', async () => {
    const f = fixture({
        topology: [['RepoA', false], ['RepoB', true]]
    })
    try {
        const adapter = deliveryAdapter(f)
        const originalContext = f.context(adapter)
        let interrupted
        try {
            await executeLifecycleDeliveryAction({
                ...originalContext,
                interruptAfterRemoteEffect: true
            })
            assert.fail('expected interruption')
        } catch (error) {
            assert.ok(error instanceof LifecycleDeliveryExecutorError)
            assert.equal(error.code, 'delivery-interrupted-after-remote-effect')
            interrupted = error
        }
        f.ledger = interrupted.details.ledger
        assert.deepEqual(
            Object.keys(interrupted.details.landingLaneReleaseDigests).sort(),
            ['Fixture/RepoA', 'Fixture/RepoB']
        )
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('apply:')).length,
            2
        )
        let projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        assert.equal(
            projection.aggregateProjection
                .pendingDeliveryEffects['delivery-group'].status,
            'remote-effect-applied'
        )
        assert.equal(
            projection.aggregateProjection
                .deliveryFreezes['delivery-group'].active,
            true
        )
        const prepareCount = adapter.calls.filter((call) =>
            call.startsWith('prepare:')).length
        const completed = await executeLifecycleDeliveryAction(
            f.context(adapter)
        )
        f.ledger = completed.ledger
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('apply:')).length,
            2
        )
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('prepare:')).length,
            prepareCount
        )
        assert.equal(
            adapter.calls.filter((call) =>
                call.startsWith('observe:reobserve-post-mutation:')).length,
            2
        )
        projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        assert.equal(
            projection.aggregateProjection
                .deliveryEffects['delivery-group'].status,
            'completed'
        )
        assert.equal(
            projection.aggregateProjection
                .deliveryFreezes['delivery-group'].active,
            false
        )
        await assert.rejects(
            executeLifecycleDeliveryAction({
                ...originalContext,
                ledger: f.ledger
            }),
            (error) => error.code === 'delivery-effect-already-completed'
        )
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('apply:')).length,
            2
        )
    } finally {
        f.cleanup()
    }
})

test('expired remote authority fails before mutation and releases the owned freeze', async () => {
    const f = fixture({ topology: [['RepoA', false]] })
    try {
        const adapter = deliveryAdapter(f)
        await assert.rejects(
            executeLifecycleDeliveryAction(f.context(adapter, {
                timestamps: {
                    issuedAt: '2026-08-05T00:30:00.000Z',
                    observedAt: '2026-08-05T00:30:00.000Z',
                    expiresAt: '2026-08-05T00:30:00.000Z'
                }
            })),
            (error) => error.code === 'delivery-execution-failed' &&
                error.details.cause === 'delivery-control-expiry-invalid' &&
                error.details.remoteMutationAttempted === false
        )
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('apply:')).length,
            0
        )
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        assert.equal(
            projection.aggregateProjection
                .deliveryFreezes['delivery-group'].active,
            false
        )
    } finally {
        f.cleanup()
    }
})

test('stale remote head fails before mutation and releases only the owned freeze', async () => {
    const f = fixture({ topology: [['RepoA', false]] })
    try {
        const adapter = deliveryAdapter(f)
        adapter.remoteHeads[Object.values(f.repositories)[0].repository] =
            'f'.repeat(40)
        await assert.rejects(
            executeLifecycleDeliveryAction(f.context(adapter)),
            (error) => error.code === 'delivery-remote-snapshot-stale'
        )
        assert.equal(
            adapter.calls.filter((call) => call.startsWith('apply:')).length,
            0
        )
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        assert.equal(
            projection.aggregateProjection
                .deliveryFreezes['delivery-group'].active,
            false
        )
        assert.equal(
            projection.aggregateProjection
                .pendingDeliveryEffects['delivery-group'],
            undefined
        )
    } finally {
        f.cleanup()
    }
})
