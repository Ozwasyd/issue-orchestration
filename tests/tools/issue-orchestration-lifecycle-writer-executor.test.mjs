import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import rawTest from 'node:test'
const writerExecutorShardTests = Object.freeze({
    main: ['writer executor rejects unsupported lifecycle actions before adapters run', 'real writer child runs only after lease, freeze, route, watchdog, and clean snapshots', 'implementation writer freezes a new candidate only after the guarded delta is green', 'out-of-slice writer mutation is rejected after independent observation', 'writer lease and frozen contract cannot be caller-asserted', 'watchdog first-action mismatch fails before writer evidence can pass', 'candidate adapter cannot substitute the base commit or forged digests', 'writer executor has no canonical ledger append authority', 'writer executor documentation and retry shards pass in isolated processes'],
    documentation: ['documentation verified no-change uses inspection binding without writer spawn or lease', 'documentation no-change rejects fake writer spawn or lease authority', 'documentation no-change rejects root-authored runtime observation', 'documentation no-change rejects state-root mutation during inspection'],
    retry: ['implementation retry requires typed revision and cleanup authority', 'implementation retry rejects missing cleanup and revision authority', 'documentation writer uses the same guarded lease and checkpoint chain']
})
const writerExecutorShard =
    process.env.ISSUE38_WRITER_EXECUTOR_SHARD ?? 'main'
const selectedWriterExecutorTests = new Set(
    writerExecutorShardTests[writerExecutorShard] ?? []
)
const lastSelectedWriterExecutorTest =
    writerExecutorShardTests[writerExecutorShard]?.at(-1) ?? null
const test = (name, fn) => rawTest(name, {
    concurrency: false,
    skip: selectedWriterExecutorTests.has(name)
        ? false
        : 'covered by another writer executor shard'
}, async (context) => {
    const result = await fn(context)
    if (writerExecutorShard !== 'main' &&
        name === lastSelectedWriterExecutorTest &&
        (process.exitCode === undefined || process.exitCode === 0)) {
        process.exit(0)
    }
    return result
})
import { fileURLToPath } from 'node:url'

import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
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
    executePreWriterLifecycleAction
} from '../../skills/issue-orchestration/scripts/lifecycle-prewriter-executor.mjs'
import {
    executeWriterLifecycleAction,
    writerLifecycleActionTypes
} from '../../skills/issue-orchestration/scripts/lifecycle-writer-executor.mjs'
import {
    validateLifecycleStageResult
} from '../../skills/issue-orchestration/scripts/lifecycle-stage-admission.mjs'
import {
    compileCanonicalRoute
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    compileWriterStageTestArtifacts
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    authorizeWriterStageRetry,
    evaluateWriterStageObservation,
    sealWriterStageRetryRevisionEvidence
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    compileScriptedLifecycleStageResult
} from './issue-orchestration/scripted-lifecycle-stage-result.mjs'
import {
    compileWriterDispatchRequest,
    createWriterActorAdapter,
    writerDispatchEvidence,
    writerExecutionMetrics,
    writerMachineClassificationEvidence,
    writerStageRouteIdentity
} from './issue-orchestration-writer-executor-test-helper.mjs'

const CREATED_AT = '2026-08-04T00:00:00.000Z'
let fixtureSequence = 0
const prewriterActorScript = fileURLToPath(new URL(
    './issue-orchestration/prewriter-stage-actor.mjs',
    import.meta.url
))

function git(args, cwd) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 10_000,
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

function initRepository(root) {
    const bare = path.join(root, 'Repo.git')
    const work = path.join(root, 'Repo-work')
    const repository = 'Fixture/WriterRepo'
    const remoteUrl = `https://github.com/${repository}.git`
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'writer-executor-test'], work)
    git(['config', 'user.email', 'writer@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), '# Writer Repo\n')
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize'], work)
    git(['push', '-u', 'origin', 'main'], work)
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return { bare, work, repository, remoteUrl }
}

function issue(repository) {
    return {
        repository,
        number: 38,
        state: 'OPEN',
        stateReason: null,
        updatedAt: CREATED_AT,
        title: 'Execute writer lifecycle actions',
        body: [
            'Implement a real writer execution boundary.',
            '',
            '- A watchdog must exist before writer spawn.',
            '- Mutations must remain inside the executable slice.'
        ].join('\n'),
        comments: [{
            id: 'comment-38',
            body: 'The writer must return checkpoint evidence.',
            updatedAt: CREATED_AT,
            relevant: true,
            relevantToCorrectness: true
        }],
        labels: ['orchestration'],
        milestone: null,
        dependsOn: []
    }
}

function selector(repository) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'writer-selector-v1',
        type: 'explicit-issues',
        repositories: [repository],
        parameters: {
            issueIds: [`${repository}#38`],
            states: ['OPEN']
        },
        remoteQueryIdentity: 'writer-test:explicit-issues'
    }
}

function classification(repository) {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: repository,
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('writer-routing-evidence'),
        routingPolicyVersion: 'stage-model-pool.v3'
    }
}

function profileMetadata(profile) {
    if (profile.startsWith('sol-')) {
        return { model: 'gpt-5.6-sol', effort: profile.slice(4) }
    }
    if (profile.startsWith('luna-')) {
        return { model: 'gpt-5.6-luna', effort: profile.slice(5) }
    }
    return { model: 'gpt-5.6-terra', effort: profile.slice(6) }
}

function executionObservation({ fixture, stageRole, stagePhase, route, actorId }) {
    const metadata = profileMetadata(route.selectedProfile)
    return seal({
        schema: 'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId: `${actorId}:invocation`,
        actorSessionId: `${actorId}:session`,
        rootInvocationId: fixture.startup.attestation.runtimeInvocationId,
        requestedRole: stageRole,
        effectiveRole: stageRole,
        requestedPhase: stagePhase,
        effectivePhase: stagePhase,
        requestedProfile: route.selectedProfile,
        effectiveProfile: route.selectedProfile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        routeDecisionDigest: route.routeDecisionDigest,
        packageDigest: fixture.startup.observation.packageDigest,
        modelPoolPolicyDigest:
            fixture.startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            fixture.startup.observation.policyDigests.executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-04T01:00:00.000Z'
    }, 'observationDigest')
}

function capabilityObservation({ route, actorId }) {
    const metadata = profileMetadata(route.selectedProfile)
    return seal({
        schema: 'issue-orchestration.runtime-capability-observation.v2',
        source: 'per-dispatch-runtime-identity-observer',
        observable: true,
        runtimeInvocationId: `${actorId}:invocation`,
        sessionOrThreadId: `${actorId}:session`,
        runtimeVersion: 'codex-cli-2026.08',
        requestedProfile: route.selectedProfile,
        effectiveProfile: route.selectedProfile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        multiAgentBackend: 'v2',
        rawEventDigest: digest(`${actorId}:event`),
        rawSessionDigest: digest(`${actorId}:session-raw`),
        rawTurnDigest: digest(`${actorId}:turn`),
        observedAt: '2026-08-04T01:00:00.000Z'
    }, 'observationDigest')
}

function prewriterActorAdapter(fixture) {
    let sequence = 0
    return {
        prepare({ stageRole, stagePhase, routeDecision }) {
            sequence += 1
            const actorId = `${stagePhase}-${sequence}`
            return {
                preparation: { actorId, stageRole, stagePhase },
                runtimeObservation: executionObservation({
                    fixture,
                    stageRole,
                    stagePhase,
                    route: routeDecision,
                    actorId
                }),
                runtimeCapabilityObservation: capabilityObservation({
                    route: routeDecision,
                    actorId
                })
            }
        },
        invoke({ preparation, routeDecision, request }) {
            const result = spawnSync(process.execPath, [prewriterActorScript], {
                encoding: 'utf8',
                input: JSON.stringify({
                    actorId: preparation.actorId,
                    stagePhase: routeDecision.stagePhase,
                    routeDecision,
                    request
                })
            })
            if (result.status !== 0) {
                throw new Error(result.stderr || result.stdout)
            }
            return JSON.parse(result.stdout)
        }
    }
}

function fixture() {
    fixtureSequence += 1
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-state-'))
    const repository = initRepository(root)
    const startup = verifiedRuntimeStartup({
        invocationId: 'writer-root-invocation',
        sessionId: 'writer-root-session'
    })
    const runId = `writer-run-${fixtureSequence}`
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
        slotCapacity: 1,
        createdAt: CREATED_AT
    })
    const repositoryBinding = repositoryAuthorityFor(
        authority,
        repository.repository
    )
    const remoteIssue = {
        ...issue(repository.repository),
        baseSha: repositoryBinding.observedDefaultBranchHead
    }
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selector(repository.repository),
        remoteIssues: [remoteIssue],
        previousReceipt: null,
        resolvedAt: CREATED_AT
    })
    const policyDigest = digest('writer-policy')
    const nodeId = `${repository.repository}#38`
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest([nodeId]),
        semanticGraphInputDigest: digest(remoteIssue),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: repositoryBinding.observedDefaultBranchHead,
            bindingDigest: repositoryBinding.bindingDigest
        }],
        nodes: [{
            id: nodeId,
            memberId: nodeId,
            repository: repository.repository,
            issueNumber: 38,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: 'bounded',
            uiClass: 'non-ui',
            acceptanceGroup: null,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: repositoryBinding.bindingDigest,
            semanticFactsDigest: digest(remoteIssue),
            receipts: {}
        }]
    })
    let ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition: selector(repository.repository),
        semanticGraph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        lifecycleAuthority: authority,
        startup,
        slotCapacity: 1
    })
    const common = {
        repositoryPath: repository.work,
        stateRootPath: stateRoot,
        skillDigest: digest('writer-skill'),
        baselineDigest: digest('writer-baseline'),
        routingClassification: classification(repository.repository),
        startup,
        runtimeTrustBinding: authority.runtimeTrustBinding,
        repositoryTargets: authority.repositoryTargets,
        lifecycleAuthority: authority
    }
    return {
        root,
        stateRoot,
        repository,
        startup,
        authority,
        selectorReceipt,
        remoteIssue,
        nodeId,
        common,
        get ledger() { return ledger },
        actionSet() {
            return compileLifecycleRunActionSet(ledger, { startup })
        },
        node() {
            return projectLifecycleRun(ledger, { startup }).state.nodes[nodeId]
        },
        record(actionSet, result, createdAt) {
            ledger = recordLifecycleActionResults({
                ledger,
                actionSet,
                stageResults: [result],
                startup,
                createdAt
            })
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}

function advanceToWriter(f) {
    const adapter = prewriterActorAdapter(f)
    const inputsByType = {
        'request-semantic-proposal': {
            issue: f.remoteIssue,
            selectorReceipt: f.selectorReceipt
        },
        'compile-acceptance-contract': {},
        'request-test-contract-planning': {
            attemptId: 'writer-planning-attempt'
        }
    }
    for (const [index, expected] of [
        'request-semantic-proposal',
        'compile-acceptance-contract',
        'request-test-contract-planning'
    ].entries()) {
        const actionSet = f.actionSet()
        const action = actionSet.actions[0]
        assert.equal(action.type, expected)
        const result = executePreWriterLifecycleAction({
            ...f.common,
            actionSet,
            action,
            node: f.node(),
            actorAdapter: adapter,
            inputs: inputsByType[expected]
        })
        f.record(
            actionSet,
            result,
            `2026-08-04T00:0${index + 2}:00.000Z`
        )
    }
    const actionSet = f.actionSet()
    assert.equal(actionSet.actions[0].type, 'dispatch-test-contract-writer')
    return { actionSet, action: actionSet.actions[0], node: f.node() }
}

function createStageWorktree(f, name, baseSha) {
    const location = path.join(f.root, name)
    git(['clone', '--no-checkout', f.repository.bare, location], f.root)
    git(['checkout', '--detach', baseSha], location)
    git(['config', 'user.name', 'writer-stage-test'], location)
    git(['config', 'user.email', 'writer-stage@example.invalid'], location)
    return location
}

function writerAuthorityFixture(f, action, {
    stageRole = 'test-owner',
    stagePhase = 'test-contract',
    relativePath = 'tests/generated-issue38.mjs',
    stageAttemptId = 'writer-stage-attempt-1',
    routingClassification = f.common.routingClassification
} = {}) {
    const stageRoute = writerStageRouteIdentity({
        classification: routingClassification,
        stageRole,
        stagePhase
    })
    const worktreeIdentity = createStageWorktree(
        f,
        `worktree-${stageAttemptId}`,
        action.bindings.baseSha
    )
    const artifacts = compileWriterStageTestArtifacts({
        repository: f.repository.repository,
        issue: 38,
        node: f.nodeId,
        stageRole,
        stagePhase,
        baseSha: action.bindings.baseSha,
        epochId: `epoch-prewriter-${action.bindings.nodeEpoch}`,
        worktreeIdentity,
        allowedPaths: [relativePath],
        requiredFiles: [relativePath],
        requiredCommands: [`node --check ${relativePath}`],
        runId: action.bindings.runId,
        testContractDigest: digest('writer-test-contract'),
        routingInputDigest: stageRoute.routingInputDigest,
        stageAttemptId
    })
    const resourceReceipt = seal({
        schema:
            'issue-orchestration.writer-resource-acquisition-receipt.v1',
        status: 'acquired',
        stageAttemptId: artifacts.stageWorkPlan.stageAttemptId,
        leaseId: artifacts.stageWorkPlan.activeWriteLeaseId,
        resourceRegistryDigest: digest(
            artifacts.writerAuthority.resourceRegistry
        ),
        acquiredAt: '2026-08-04T01:00:00.000Z'
    }, 'receiptDigest')
    const authority = {
        producerAuthority: 'canonical-writer-authority',
        rootAuthored: false,
        writeLeaseAcquiredBeforeSpawn: true,
        stageContractFrozenBeforeSpawn: true,
        attemptId: artifacts.stageWorkPlan.stageAttemptId,
        stageWorkPlan: artifacts.stageWorkPlan,
        executableSlice: artifacts.executableSlice,
        compiledPrompt: artifacts.compiledPrompt,
        sealedAuthority: {
            expectedSourceEventDigest:
                artifacts.stageWorkPlan.sourceEventDigest,
            expectedSourceLedgerDigest:
                artifacts.stageWorkPlan.sourceLedgerDigest
        },
        resourceRegistry:
            artifacts.writerAuthority.resourceRegistry,
        resourceReceipt
    }
    return {
        artifacts,
        authority,
        relativePath,
        worktreeIdentity
    }
}

function runtimeForWriter(f, authority, routingClassification = f.common.routingClassification) {
    const executionMetrics = writerExecutionMetrics()
    const machineClassificationEvidence =
        writerMachineClassificationEvidence({
            action: f.actionSet().actions[0],
            executionMetrics
        })
    const bundle = compileCanonicalRoute({
        stageWorkPlan: authority.stageWorkPlan,
        executableSlice: authority.executableSlice,
        routingClassification,
        executionMetrics,
        machineClassificationEvidence,
        documentationClass:
            routingClassification.documentationClass ?? null
    })
    const actorId = 'test-contract-writer'
    return {
        executionMetrics,
        machineClassificationEvidence,
        runtimeObservation: executionObservation({
            fixture: f,
            stageRole: authority.stageWorkPlan.stageRole,
            stagePhase: authority.stageWorkPlan.stagePhase,
            route: bundle.executionRouteDecision,
            actorId
        }),
        runtimeCapabilityObservation: capabilityObservation({
            route: bundle.executionRouteDecision,
            actorId
        })
    }
}

function writerContext(current, f, {
    extraWritePath = null,
    watchdogMode = 'normal'
} = {}) {
    const { actionSet, action, node } = advanceToWriter(f)
    const writer = writerAuthorityFixture(f, action)
    const runtime = runtimeForWriter(f, writer.authority)
    const actorAdapter = createWriterActorAdapter({
        current,
        fixture: f,
        runtimeObservation: runtime.runtimeObservation,
        runtimeCapabilityObservation:
            runtime.runtimeCapabilityObservation,
        extraWritePath,
        watchdogMode
    })
    const writerAuthorityAdapter = {
        acquireAndFreeze() {
            return structuredClone(writer.authority)
        },
        compileDispatchRequest({ routeDecision }) {
            return compileWriterDispatchRequest({
                action,
                authority: writer.authority,
                classification: f.common.routingClassification,
                executionMetrics: runtime.executionMetrics,
                machineClassificationEvidence:
                    runtime.machineClassificationEvidence,
                pendingRouteDecision: routeDecision,
                startup: f.startup,
                runtimeTrustBinding:
                    f.authority.runtimeTrustBinding,
                repositoryPath: f.repository.work
            })
        }
    }
    return {
        actionSet,
        action,
        node,
        actorAdapter,
        relativePath: writer.relativePath,
        worktreeIdentity: writer.worktreeIdentity,
        context: {
            ...f.common,
            actionSet,
            action,
            node,
            actorAdapter,
            writerAuthorityAdapter,
            executionMetrics: runtime.executionMetrics,
            machineClassificationEvidence:
                runtime.machineClassificationEvidence
        }
    }
}


async function recordTestWriter(current, f) {
    const run = writerContext(current, f)
    const result = await executeWriterLifecycleAction(run.context)
    f.record(
        run.actionSet,
        result,
        '2026-08-04T00:05:00.000Z'
    )
    return { ...run, result }
}

function candidateAdapter() {
    return {
        freeze({ repositoryPath, baseSha, changedPaths }) {
            execFileSync('git', ['add', '--', ...changedPaths], {
                cwd: repositoryPath
            })
            const candidateTree = git(['write-tree'], repositoryPath)
            const candidateSha = execFileSync(
                'git',
                ['commit-tree', candidateTree, '-p', baseSha],
                {
                    cwd: repositoryPath,
                    encoding: 'utf8',
                    input: 'freeze issue 38 candidate\n',
                    env: {
                        ...process.env,
                        GIT_AUTHOR_NAME: 'writer-executor-test',
                        GIT_AUTHOR_EMAIL: 'writer@example.invalid',
                        GIT_COMMITTER_NAME: 'writer-executor-test',
                        GIT_COMMITTER_EMAIL: 'writer@example.invalid',
                        GIT_AUTHOR_DATE: '2026-08-04T01:10:00.000Z',
                        GIT_COMMITTER_DATE: '2026-08-04T01:10:00.000Z'
                    }
                }
            ).trim()
            assert.notEqual(candidateSha, baseSha)
            assert.equal(git(['rev-parse', 'HEAD'], repositoryPath), baseSha)
            const candidateTreeDigest = digest(candidateTree)
            const diff = git(
                ['diff', '--binary', `${baseSha}..${candidateSha}`],
                repositoryPath
            )
            return {
                candidateSha,
                candidateTreeDigest,
                candidateDiffDigest: digest(diff),
                changedPaths: [...changedPaths]
            }
        }
    }
}

async function implementationContext(current, f) {
    await recordTestWriter(current, f)
    const actionSet = f.actionSet()
    const action = actionSet.actions[0]
    assert.equal(action.type, 'dispatch-implementation-writer')
    const node = f.node()
    const writer = writerAuthorityFixture(f, action, {
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        relativePath: 'src/generated-issue38.mjs',
        stageAttemptId: 'implementation-stage-attempt-1'
    })
    const runtime = runtimeForWriter(f, writer.authority)
    const actorAdapter = createWriterActorAdapter({
        current,
        fixture: f,
        runtimeObservation: runtime.runtimeObservation,
        runtimeCapabilityObservation:
            runtime.runtimeCapabilityObservation,
    })
    const writerAuthorityAdapter = {
        acquireAndFreeze() {
            return structuredClone(writer.authority)
        },
        compileDispatchRequest({ routeDecision }) {
            return compileWriterDispatchRequest({
                action,
                authority: writer.authority,
                classification: f.common.routingClassification,
                executionMetrics: runtime.executionMetrics,
                machineClassificationEvidence:
                    runtime.machineClassificationEvidence,
                pendingRouteDecision: routeDecision,
                startup: f.startup,
                runtimeTrustBinding:
                    f.authority.runtimeTrustBinding,
                repositoryPath: f.repository.work
            })
        }
    }
    return {
        actionSet,
        action,
        node,
        actorAdapter,
        authority: writer.authority,
        artifacts: writer.artifacts,
        runtime,
        relativePath: writer.relativePath,
        worktreeIdentity: writer.worktreeIdentity,
        context: {
            ...f.common,
            actionSet,
            action,
            node,
            actorAdapter,
            writerAuthorityAdapter,
            candidateAdapter: candidateAdapter(),
            executionMetrics: runtime.executionMetrics,
            machineClassificationEvidence:
                runtime.machineClassificationEvidence
        }
    }
}


async function documentationContext(current, f) {
    const implementation = await implementationContext(current, f)
    const implementationResult = await executeWriterLifecycleAction(
        implementation.context
    )
    f.record(
        implementation.actionSet,
        implementationResult,
        '2026-08-04T00:06:00.000Z'
    )
    const behaviorActionSet = f.actionSet()
    const behaviorAction = behaviorActionSet.actions[0]
    assert.equal(behaviorAction.type, 'dispatch-behavior-verifier')
    const behaviorResult = compileScriptedLifecycleStageResult({
        action: behaviorAction,
        node: f.node(),
        actorRole: 'test-owner',
        facts: { attemptId: 'writer-behavior-attempt-1' }
    })
    f.record(
        behaviorActionSet,
        behaviorResult,
        '2026-08-04T00:07:00.000Z'
    )
    const actionSet = f.actionSet()
    const action = actionSet.actions[0]
    assert.equal(action.type, 'dispatch-documentation-writer')
    const node = f.node()
    const documentationClassification = {
        ...f.common.routingClassification,
        domain: 'documentation',
        documentationClass: 'cross-module'
    }
    const writer = writerAuthorityFixture(f, action, {
        stageRole: 'documentation-writer',
        stagePhase: 'documentation',
        relativePath: 'docs/generated-issue38.mjs',
        stageAttemptId: 'documentation-stage-attempt-1',
        routingClassification: documentationClassification
    })
    const runtime = runtimeForWriter(
        f,
        writer.authority,
        documentationClassification
    )
    const actorAdapter = createWriterActorAdapter({
        current,
        fixture: f,
        runtimeObservation: runtime.runtimeObservation,
        runtimeCapabilityObservation:
            runtime.runtimeCapabilityObservation
    })
    const writerAuthorityAdapter = {
        acquireAndFreeze() {
            return structuredClone(writer.authority)
        },
        compileDispatchRequest({ routeDecision }) {
            return compileWriterDispatchRequest({
                action,
                authority: writer.authority,
                classification: documentationClassification,
                executionMetrics: runtime.executionMetrics,
                machineClassificationEvidence:
                    runtime.machineClassificationEvidence,
                pendingRouteDecision: routeDecision,
                startup: f.startup,
                runtimeTrustBinding:
                    f.authority.runtimeTrustBinding,
                repositoryPath: f.repository.work
            })
        }
    }
    return {
        actionSet,
        action,
        node,
        actorAdapter,
        relativePath: writer.relativePath,
        worktreeIdentity: writer.worktreeIdentity,
        context: {
            ...f.common,
            routingClassification: documentationClassification,
            documentationClass: 'cross-module',
            actionSet,
            action,
            node,
            actorAdapter,
            writerAuthorityAdapter,
            executionMetrics: runtime.executionMetrics,
            machineClassificationEvidence:
                runtime.machineClassificationEvidence
        }
    }
}


async function advanceToDocumentation(current, f) {
    const implementation = await implementationContext(current, f)
    const implementationResult = await executeWriterLifecycleAction(
        implementation.context
    )
    f.record(
        implementation.actionSet,
        implementationResult,
        '2026-08-04T00:06:00.000Z'
    )
    const behaviorActionSet = f.actionSet()
    const behaviorAction = behaviorActionSet.actions[0]
    assert.equal(behaviorAction.type, 'dispatch-behavior-verifier')
    const behaviorResult = compileScriptedLifecycleStageResult({
        action: behaviorAction,
        node: f.node(),
        actorRole: 'test-owner',
        facts: { attemptId: 'behavior-verifier-attempt-1' }
    })
    f.record(
        behaviorActionSet,
        behaviorResult,
        '2026-08-04T00:07:00.000Z'
    )
    const actionSet = f.actionSet()
    const action = actionSet.actions[0]
    assert.equal(action.type, 'dispatch-documentation-writer')
    return { actionSet, action, node: f.node() }
}

function documentationInspectionAdapter(f, action, {
    writerSpawned = false,
    writeLeaseAcquired = false,
    mutateStateRoot = false
} = {}) {
    const trust = f.authority.runtimeTrustBinding
    return {
        prepare() {
            return {
                attemptId: 'documentation-inspection-attempt-1',
                runtimeInspectionObservation: seal({
                    schema:
                        'issue-orchestration.runtime-inspection-observation.v1',
                    producerAuthority: 'runtime-owned',
                    runtimeId: 'codex',
                    runtimeVersion: 'codex-cli-2026.08',
                    actorInvocationId:
                        'documentation-inspection-invocation-1',
                    actorSessionId:
                        'documentation-inspection-session-1',
                    rootInvocationId:
                        f.startup.attestation.runtimeInvocationId,
                    inspectionKind: 'documentation-no-change',
                    effectiveMultiAgentBackend: 'v2',
                    effectivePermissionProfile:
                        trust.effectivePermissionProfile,
                    permissionInheritance:
                        trust.childPermissionInheritance,
                    permissionGuarantee: trust.permissionGuarantee,
                    observedAt: '2026-08-04T01:20:00.000Z'
                }, 'observationDigest')
            }
        },
        inspect({
            acceptanceContractDigest,
            repositoryPath,
            stateRootPath
        }) {
            if (mutateStateRoot) {
                fs.writeFileSync(
                    path.join(stateRootPath, 'forbidden-inspection-write'),
                    'mutation\n'
                )
            }
            const relative = 'README.md'
            const realPath = fs.realpathSync(
                path.join(repositoryPath, relative)
            )
            const inspectedFiles = [{
                path: relative,
                realPath,
                contentDigest: digest(fs.readFileSync(realPath)),
                gitObjectDigest: git(
                    ['hash-object', '--', relative],
                    repositoryPath
                )
            }]
            const repositoryInspectionDigest = digest({
                acceptanceContractDigest,
                headSha: git(['rev-parse', 'HEAD'], repositoryPath),
                worktreeStatus: git([
                    'status', '--porcelain=v1', '--untracked-files=all'
                ], repositoryPath),
                inspectedFiles
            })
            return {
                mode: 'no-change',
                writerSpawned,
                writeLeaseAcquired,
                acceptanceContractDigest,
                inspectedFiles,
                repositoryInspectionDigest,
                attributionStatus: 'verified'
            }
        }
    }
}


function retryActorAdapter(current, f, run) {
    const base = run.actorAdapter
    const currentPlan = run.authority.stageWorkPlan
    const currentSlice = run.authority.executableSlice
    const currentPrompt = run.authority.compiledPrompt
    return {
        get invoked() { return base.invoked },
        get watchdogSeenBeforeSpawn() {
            return base.watchdogSeenBeforeSpawn
        },
        prepare(input) {
            return base.prepare(input)
        },
        invoke(input) {
            const completed = base.invoke(input)
            const checkpoint =
                completed.checkpointVerificationInput.checkpoint
            const observation = {
                schema: 'issue-orchestration.writer-stage-observation.v1',
                runId: currentPlan.runId,
                repository: currentPlan.repository,
                issue: currentPlan.issue,
                node: currentPlan.node,
                baseSha: currentPlan.baseSha,
                epochId: currentPlan.epochId,
                worktreeIdentity: currentPlan.worktreeIdentity,
                sliceId: currentSlice.sliceId,
                sliceDigest: currentSlice.sliceDigest,
                planDigest: currentPlan.planDigest,
                compiledPromptDigest: currentPrompt.promptDigest,
                routeDigest: input.routeDecision.routeDecisionDigest,
                stageRole: currentPlan.stageRole,
                stagePhase: currentPlan.stagePhase,
                attemptId: currentPlan.stageAttemptId,
                agentId: input.runtimeExecutionBinding.actorInvocationId,
                firstRequiredActionExecuted: true,
                plan: currentPlan,
                currentSlice,
                checkpoint,
                sliceTerminalReceipts: [],
                invocationObservation: { started: true },
                environmentObservation: { ready: true },
                runtimeCapabilityObservation: {
                    available: true,
                    effectiveMetadataObserved: true,
                    observationDigest: digest('prior-runtime-capability')
                },
                filesystemObservation: {
                    createdFiles: [...completed.changedPaths],
                    modifiedFiles: [],
                    treeDigest: digest(completed.changedPaths)
                },
                gitObservation: {
                    changedPaths: [...completed.changedPaths],
                    diffDigest: digest(completed.changedPaths),
                    unauthorizedPaths: []
                },
                commandObservation: {
                    commands: [...currentSlice.requiredCommands],
                    statuses: currentSlice.requiredCommands.map(() => 0),
                    evidenceDigests:
                        [...completed.commandEvidenceDigests]
                },
                renderEvidence: null,
                verifiedNoChangeEvidence: null,
                conflictMapping: null,
                terminalReceipt: null,
                priorFailureReceipt: null
            }
            const failure = evaluateWriterStageObservation(observation)
            assert.equal(failure.status, 'failed')
            assert.equal(failure.failureReceipt.authorityStatus,
                'active-writer')
            const payload = {
                failureReceipt: failure.failureReceipt,
                stageWorkPlan: currentPlan,
                currentSlice,
                compiledPrompt: currentPrompt,
                writerStageObservation: observation
            }
            const sourceFailureEvent = seal({
                schema: 'issue-orchestration.event.v2',
                eventId: 'writer-retry-source-event',
                sequence: 1,
                previousEventDigest: '0'.repeat(64),
                eventType: failure.eventType,
                runId: currentPlan.runId,
                nodeId: currentPlan.node,
                baseSha: currentPlan.baseSha,
                attemptId: currentPlan.stageAttemptId,
                actorRole: currentPlan.stageRole,
                payload,
                payloadDigest: digest(payload)
            }, 'eventDigest')
            const fresh = writerAuthorityFixture(f, run.action, {
                stageRole: currentPlan.stageRole,
                stagePhase: currentPlan.stagePhase,
                relativePath: run.relativePath,
                stageAttemptId: 'implementation-stage-attempt-2'
            })
            const freshPlan = fresh.authority.stageWorkPlan
            const freshSlice = fresh.authority.executableSlice
            const freshPrompt = fresh.authority.compiledPrompt
            const authorityReceipt = seal({
                schema: 'issue-orchestration.dispatch-receipt.v2',
                verificationStatus: 'verified',
                runId: freshPlan.runId,
                nodeId: freshPlan.node,
                baseSha: freshPlan.baseSha,
                epochId: freshPlan.epochId,
                stageRole: freshPlan.stageRole,
                stagePhase: freshPlan.stagePhase,
                planDigest: freshPlan.planDigest,
                sliceDigest: freshSlice.sliceDigest,
                compiledPromptDigest: freshPrompt.promptDigest,
                runtimeMetadataDigest: digest({
                    runtime: 'requalified',
                    prior: observation.runtimeCapabilityObservation
                }),
                rolloutId: 'writer-retry-rollout-2',
                threadId: 'writer-retry-thread-2',
                actualModel: 'gpt-5.6-sol',
                actualEffort: 'medium',
                actualRole: freshPlan.stageRole,
                actualMode: 'normal',
                actualSandbox: 'danger-full-access',
                actualForkTurns: '3',
                actualWorkingDirectory: freshPlan.worktreeIdentity
            }, 'receiptDigest')
            const proposedRetry = {
                stageWorkPlan: freshPlan,
                executableSlice: freshSlice,
                compiledPrompt: freshPrompt,
                completedSlicePrefix: [],
                authorityReceipt
            }
            const changedRequirementId =
                currentSlice.requiredEvidence[0]
            const revision = sealWriterStageRetryRevisionEvidence({
                priorFailure: failure.failureReceipt,
                sourceFailureEvent,
                proposed: proposedRetry,
                revisionKind: 'runtime-revision',
                changedRequirementIds: [changedRequirementId],
                authorityReceipt
            })
            const resourceCleanupReceipt = seal({
                schema:
                    'issue-orchestration.resource-cleanup-receipt.v1',
                actorRole: 'machine-resource-verifier',
                status: 'resources-clean',
                runId: currentPlan.runId,
                attemptId: currentPlan.stageAttemptId,
                epochId: currentPlan.epochId,
                postInventory: [],
                failedResources: [],
                quarantinedResources: [],
                retainedResources: []
            }, 'receiptDigest')
            const authorization = authorizeWriterStageRetry({
                priorFailure: failure.failureReceipt,
                proposed: proposedRetry,
                revisions: [revision],
                sourceFailureEvent,
                resourceCleanupReceipt
            })
            if (authorization.authorized !== true) {
                throw new Error(authorization.reason)
            }
            return {
                ...completed,
                outcome: 'recoverable-failure',
                writerObservation: observation,
                proposedRetry,
                revisions: [revision],
                sourceFailureEvent,
                resourceCleanupReceipt,
                completedSlicePrefix: [],
                proposedRetrySealedAuthority:
                    fresh.authority.sealedAuthority,
                mutationOutput: {
                    status: 'recoverable-failure',
                    changedPaths: [...completed.changedPaths]
                },
                ...writerDispatchEvidence({
                    request: input.request,
                    runtimeExecutionObservation:
                        run.runtime.runtimeObservation
                })
            }
        }
    }
}

test('writer executor rejects unsupported lifecycle actions before adapters run', async () => {
    assert.deepEqual(writerLifecycleActionTypes, [
        'dispatch-documentation-writer',
        'dispatch-implementation-writer',
        'dispatch-test-contract-writer'
    ])
    let invoked = false
    await assert.rejects(
        () => executeWriterLifecycleAction({
            action: { type: 'dispatch-behavior-verifier' },
            actionSet: { actions: [] },
            actorAdapter: {
                prepare() { invoked = true },
                invoke() { invoked = true }
            }
        }),
        (error) => error?.code === 'writer-action-unsupported'
    )
    assert.equal(invoked, false)
})

test('real writer child runs only after lease, freeze, route, watchdog, and clean snapshots', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = writerContext(current, f)
    const result = await executeWriterLifecycleAction(run.context)
    validateLifecycleStageResult({
        result,
        action: run.action,
        node: run.node
    })
    assert.equal(run.actorAdapter.invoked, true)
    assert.equal(run.actorAdapter.watchdogSeenBeforeSpawn, true)
    assert.ok(fs.existsSync(path.join(run.worktreeIdentity, run.relativePath)))
    assert.equal(
        result.artifacts.mutationPostcondition.evidence
            .receipt.executionClass,
        'leased-writer'
    )
    assert.deepEqual(
        result.artifacts.mutationPostcondition.evidence
            .receipt.changedPaths,
        [run.relativePath]
    )
    assert.equal(
        result.artifacts.testContractWriter.evidence.changedPaths[0],
        run.relativePath
    )
})


test('implementation writer freezes a new candidate only after the guarded delta is green', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await implementationContext(current, f)
    const result = await executeWriterLifecycleAction(run.context)
    validateLifecycleStageResult({
        result,
        action: run.action,
        node: run.node
    })
    assert.equal(run.actorAdapter.watchdogSeenBeforeSpawn, true)
    assert.match(
        result.artifacts.candidate.evidence.candidateSha,
        /^[a-f0-9]{40}$/u
    )
    assert.notEqual(
        result.artifacts.candidate.evidence.candidateSha,
        run.action.bindings.baseSha
    )
    assert.equal(
        git(['rev-parse', 'HEAD'], f.repository.work),
        run.action.bindings.baseSha
    )
    assert.equal(
        result.artifacts.candidate.evidence.writerInvocationId,
        result.artifacts.dispatchReceipt.evidence.actorInvocationId
    )
    assert.deepEqual(
        result.artifacts.implementationTerminal.evidence.changedPaths,
        [run.relativePath]
    )
})

test('out-of-slice writer mutation is rejected after independent observation', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = writerContext(current, f, {
        extraWritePath: 'src/forbidden-issue38.mjs'
    })
    await assert.rejects(
        () => executeWriterLifecycleAction(run.context),
        (error) => error?.code ===
            'writer-actor-execution-invalid' ||
            error?.code ===
            'writer-checkpoint-live-evidence-invalid' ||
            error?.code === 'writer-mutation-postcondition-not-clean' ||
            /unauthorized changed path|changed path count/iu.test(
                error?.message ?? ''
            )
    )
    assert.equal(run.actorAdapter.invoked, true)
})


test('writer lease and frozen contract cannot be caller-asserted', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = writerContext(current, f)
    let invoked = false
    run.context.actorAdapter = {
        prepare() { invoked = true },
        invoke() { invoked = true }
    }
    const original = run.context.writerAuthorityAdapter
    run.context.writerAuthorityAdapter = {
        ...original,
        acquireAndFreeze() {
            const authority = original.acquireAndFreeze()
            authority.writeLeaseAcquiredBeforeSpawn = false
            return authority
        }
    }
    await assert.rejects(
        () => executeWriterLifecycleAction(run.context),
        (error) => error?.code === 'writer-authority-order-invalid'
    )
    assert.equal(invoked, false)
})

test('watchdog first-action mismatch fails before writer evidence can pass', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = writerContext(current, f, {
        watchdogMode: 'first-action-mismatch'
    })
    await assert.rejects(
        () => executeWriterLifecycleAction(run.context),
        (error) => error?.code === 'writer-watchdog-not-green'
    )
    assert.equal(run.actorAdapter.invoked, true)
})

test('candidate adapter cannot substitute the base commit or forged digests', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await implementationContext(current, f)
    run.context.candidateAdapter = {
        freeze({ baseSha, changedPaths }) {
            return {
                candidateSha: baseSha,
                candidateTreeDigest: digest('forged-tree'),
                candidateDiffDigest: digest('forged-diff'),
                changedPaths: [...changedPaths]
            }
        }
    }
    await assert.rejects(
        () => executeWriterLifecycleAction(run.context),
        (error) => [
            'writer-candidate-not-new',
            'writer-candidate-diff-missing',
            'writer-candidate-freeze-mismatch'
        ].includes(error?.code)
    )
})


test('documentation verified no-change uses inspection binding without writer spawn or lease', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await advanceToDocumentation(current, f)
    const result = await executeWriterLifecycleAction({
        ...f.common,
        ...run,
        documentationMode: 'no-change',
        documentationInspectionAdapter:
            documentationInspectionAdapter(f, run.action)
    })
    validateLifecycleStageResult({
        result,
        action: run.action,
        node: run.node
    })
    assert.equal(result.artifacts.runtimeBinding.evidence.executionClass,
        'observe-only')
    assert.equal(result.artifacts.runtimeBinding.evidence.writerSpawned,
        false)
    assert.equal(result.artifacts.runtimeBinding.evidence.writeLeaseAcquired,
        false)
    assert.equal(result.artifacts.documentation.evidence.mode, 'no-change')
    assert.equal(
        result.artifacts.mutationPostcondition.evidence.receipt.executionClass,
        'observe-only'
    )
})

test('documentation no-change rejects fake writer spawn or lease authority', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await advanceToDocumentation(current, f)
    await assert.rejects(
        () => executeWriterLifecycleAction({
            ...f.common,
            ...run,
            documentationMode: 'no-change',
            documentationInspectionAdapter:
                documentationInspectionAdapter(f, run.action, {
                    writerSpawned: true,
                    writeLeaseAcquired: true
                })
        }),
        (error) => error?.code ===
            'writer-documentation-no-change-authority-exceeded'
    )
})

test('documentation no-change rejects root-authored runtime observation', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await advanceToDocumentation(current, f)
    const trusted = documentationInspectionAdapter(f, run.action)
    const adapter = {
        prepare(input) {
            const prepared = trusted.prepare(input)
            const observation = {
                ...prepared.runtimeInspectionObservation,
                producerAuthority: 'root-scheduler'
            }
            delete observation.observationDigest
            return {
                ...prepared,
                runtimeInspectionObservation:
                    seal(observation, 'observationDigest')
            }
        },
        inspect(input) {
            return trusted.inspect(input)
        }
    }
    await assert.rejects(
        () => executeWriterLifecycleAction({
            ...f.common,
            ...run,
            documentationMode: 'no-change',
            documentationInspectionAdapter: adapter
        }),
        (error) => error?.code ===
            'writer-documentation-inspection-runtime-invalid'
    )
})

test('documentation no-change rejects state-root mutation during inspection', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await advanceToDocumentation(current, f)
    await assert.rejects(
        () => executeWriterLifecycleAction({
            ...f.common,
            ...run,
            documentationMode: 'no-change',
            documentationInspectionAdapter:
                documentationInspectionAdapter(f, run.action, {
                    mutateStateRoot: true
                })
        }),
        (error) => error?.code ===
            'writer-documentation-no-change-mutation'
    )
})

test('writer executor has no canonical ledger append authority', () => {
    const source = fs.readFileSync(
        fileURLToPath(new URL(
            '../../skills/issue-orchestration/scripts/lifecycle-writer-executor.mjs',
            import.meta.url
        )),
        'utf8'
    )
    assert.doesNotMatch(source,
        /recordLifecycleActionResults|appendNodeEvent|appendControlEvent|writeFileSync/u)
})




test('writer executor documentation and retry shards pass in isolated processes', () => {
    const currentFile = fileURLToPath(import.meta.url)
    for (const shard of ['documentation', 'retry']) {
        try {
            execFileSync(process.execPath, [
                '--test',
                '--test-concurrency=1',
                currentFile
            ], {
                encoding: 'utf8',
                timeout: 120_000,
                env: {
                    ...process.env,
                    ISSUE38_WRITER_EXECUTOR_SHARD: shard
                },
                stdio: ['ignore', 'pipe', 'pipe']
            })
        } catch (error) {
            throw new Error([
                `writer executor ${shard} shard failed`,
                error.stdout ?? '',
                error.stderr ?? ''
            ].join('\n'))
        }
    }
})

test('implementation retry requires typed revision and cleanup authority', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await implementationContext(current, f)
    run.actorAdapter = retryActorAdapter(current, f, run)
    run.context.actorAdapter = run.actorAdapter
    const result = await executeWriterLifecycleAction(run.context)
    assert.equal(result.actionType, 'dispatch-implementation-writer')
    assert.equal(
        result.artifacts.writerFailure.evidence.recoverable,
        true
    )
    assert.equal(
        result.artifacts.retryAuthorization.evidence.status,
        'authorized'
    )
    assert.equal(run.actorAdapter.watchdogSeenBeforeSpawn, true)
    validateLifecycleStageResult({
        result,
        action: run.action,
        node: run.node
    })
})

test('implementation retry rejects missing cleanup and revision authority', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await implementationContext(current, f)
    const valid = retryActorAdapter(current, f, run)
    run.actorAdapter = {
        get invoked() { return valid.invoked },
        get watchdogSeenBeforeSpawn() {
            return valid.watchdogSeenBeforeSpawn
        },
        prepare(input) {
            return valid.prepare(input)
        },
        invoke(input) {
            const output = valid.invoke(input)
            delete output.revisions
            delete output.resourceCleanupReceipt
            return output
        }
    }
    run.context.actorAdapter = run.actorAdapter
    await assert.rejects(
        () => executeWriterLifecycleAction(run.context),
        (error) => error?.code === 'writer-retry-not-authorized'
    )
})

test('documentation writer uses the same guarded lease and checkpoint chain', async (current) => {
    const f = fixture()
    current.after(() => f.cleanup())
    const run = await documentationContext(current, f)
    const result = await executeWriterLifecycleAction(run.context)
    assert.equal(result.actionType, 'dispatch-documentation-writer')
    assert.equal(result.actorRole, 'documentation-writer')
    assert.equal(result.artifacts.documentation.evidence.mode, 'changed')
    assert.deepEqual(
        result.artifacts.documentation.evidence.changedPaths,
        [run.relativePath]
    )
    assert.equal(
        result.artifacts.mutationPostcondition.evidence.violations.length,
        0
    )
    assert.equal(run.actorAdapter.watchdogSeenBeforeSpawn, true)
    assert.equal(
        fs.existsSync(path.join(run.worktreeIdentity, run.relativePath)),
        true
    )
    validateLifecycleStageResult({
        result,
        action: run.action,
        node: run.node
    })
})
