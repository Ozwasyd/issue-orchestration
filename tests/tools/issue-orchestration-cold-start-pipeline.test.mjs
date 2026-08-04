import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    advanceTestContractColdStart,
    compileTestContractPlanningBundle
} from '../../skills/issue-orchestration/scripts/test-contract-cold-start.mjs'
import {
    acquireDispatchLease
} from '../../skills/issue-orchestration/scripts/dispatch-batch-selector.mjs'
import {
    compileCanonicalRoute
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    compileRuntimeExecutionBinding
} from '../../skills/issue-orchestration/scripts/runtime-execution-binding.mjs'
import {
    compileRuntimeStartupObservation,
    attestRuntimeStartup,
    currentRuntimeStartupAuthority
} from '../../skills/issue-orchestration/scripts/runtime-startup-attestation.mjs'
import {
    compileRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    writerResourceRegistryIdentityDigest,
    writerStageAuthorityLocation
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    resolveSelector
} from '../../skills/issue-orchestration/scripts/scope-selector.mjs'
import {
    canonicalNodeStateLocation
} from '../../skills/issue-orchestration/scripts/multi-node-state.mjs'
import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const temporaryRoots = new Set()
let sharedFixture = null
let scenarioSequence = 0

test.after(() => {
    for (const target of temporaryRoots) {
        fs.rmSync(target, { recursive: true, force: true })
    }
})

function git(repository, ...args) {
    return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8'
    }).trim()
}

function schema(name) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', name),
        'utf8'
    ))
}

function fixture() {
    if (sharedFixture) return sharedFixture
    const parent = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-cold-start-'
    ))
    temporaryRoots.add(parent)
    const repositoryPath = path.join(parent, 'repository')
    const stateRoot = path.join(parent, 'state')
    fs.mkdirSync(repositoryPath)
    fs.mkdirSync(stateRoot, { mode: 0o700 })
    fs.chmodSync(stateRoot, 0o700)
    git(repositoryPath, 'init', '--quiet')
    git(repositoryPath, 'config', 'user.name', 'Cold Start Test')
    git(repositoryPath, 'config', 'user.email', 'cold-start@example.invalid')
    git(repositoryPath, 'remote', 'add', 'origin',
        'https://github.com/ExampleOrg/RepositoryA.git')
    fs.mkdirSync(path.join(repositoryPath, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(repositoryPath, 'README.md'), '# fixture\n')
    git(repositoryPath, 'add', '.')
    git(repositoryPath, 'commit', '--quiet', '-m', 'fixture')
    const baseSha = git(repositoryPath, 'rev-parse', 'HEAD')
    process.env.FSUS_ISSUE_ORCHESTRATION_STATE_ROOT = stateRoot
    process.env.FSUS_ISSUE_ORCHESTRATION_REPOSITORIES =
        JSON.stringify([repositoryPath])
    process.env.FSUS_ISSUE_ORCHESTRATION_WORKSPACES =
        JSON.stringify([repositoryPath])
    sharedFixture = { parent, repositoryPath, stateRoot, baseSha }
    return sharedFixture
}

function startupRecord(value) {
    return { ...value, recordDigest: digest(value) }
}

function runtimeStartup() {
    const authority = currentRuntimeStartupAuthority()
    const common = {
        schema: 'issue-orchestration.trusted-runtime-startup-record.v1',
        producerAuthority: 'runtime-owned',
        runtimeAdapter: 'codex-rollout-v1',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        invocationId: 'root-invocation-cold-start',
        sessionId: 'root-session-cold-start'
    }
    const launcherRecord = startupRecord({
        ...common,
        kind: 'launcher',
        producer: 'codex-launcher',
        requestedRole: 'root-scheduler',
        requestedStage: 'scheduling',
        selectedProfile: 'terra-low',
        requestedModel: 'gpt-5.6-terra',
        requestedEffort: 'low',
        requestedMultiAgentBackend: 'v2',
        requestedSandbox: 'danger-full-access',
        requestedPermissionProfile: 'danger-full-access',
        requestedApprovalPolicy: 'never',
        rootRouteDigest: digest('root-route'),
        rootAuthorityEpoch: 'root-authority-epoch-cold-start',
        packageDigest: authority.packageDigest,
        manifestDigest: authority.manifestDigest,
        policyDigests: authority.policyDigests,
        observedAt: '2026-08-04T02:00:00.000Z'
    })
    const runtimeRecord = startupRecord({
        ...common,
        kind: 'runtime',
        producer: 'codex-rollout',
        effectiveProfile: 'terra-low',
        effectiveModel: 'gpt-5.6-terra',
        effectiveEffort: 'low',
        effectiveMultiAgentBackend: 'v2',
        trustMode: 'trusted-owner-repositories',
        effectiveSandbox: 'danger-full-access',
        effectivePermissionProfile: 'danger-full-access',
        effectiveApprovalPolicy: 'never',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-04T02:00:00.000Z'
    })
    const capacityRecord = startupRecord({
        ...common,
        kind: 'capacity',
        producer: 'codex-control-plane',
        capacity: {
            status: 'observed',
            multiAgentV2: true,
            maxConcurrentThreadsPerSession: 16,
            reasonCode: null
        },
        observedAt: '2026-08-04T02:00:00.000Z'
    })
    const observation = compileRuntimeStartupObservation({
        launcherRecord,
        runtimeRecord,
        capacityRecord
    })
    const attestation = attestRuntimeStartup({
        observation,
        attestedAt: '2026-08-04T02:00:01.000Z'
    })
    return { observation, attestation, takeoverContext: null }
}

function runtimeContext(repositoryPath) {
    const startup = runtimeStartup()
    const repositoryTargets = [{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath
    }]
    const runtimeTrustBinding = compileRuntimeTrustBinding({
        role: 'root-scheduler',
        executionClass: 'root-control',
        runtimeId: 'codex',
        multiAgentBackend: 'v2',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        repositoryTargets,
        startup
    })
    return { startup, repositoryTargets, runtimeTrustBinding }
}

function classification() {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('cold-start-routing-evidence'),
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

function executionObservation({
    context,
    stageRole,
    stagePhase,
    profile,
    routeDecisionDigest,
    actorId
}) {
    const metadata = profileMetadata(profile)
    const value = {
        schema: 'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId: `${actorId}:invocation`,
        actorSessionId: `${actorId}:session`,
        rootInvocationId:
            context.startup.attestation.runtimeInvocationId,
        requestedRole: stageRole,
        effectiveRole: stageRole,
        requestedPhase: stagePhase,
        effectivePhase: stagePhase,
        requestedProfile: profile,
        effectiveProfile: profile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        routeDecisionDigest,
        packageDigest:
            context.startup.observation.packageDigest,
        modelPoolPolicyDigest:
            context.startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            context.startup.observation.policyDigests.executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-04T02:00:02.000Z'
    }
    value.observationDigest = digest(value)
    return value
}

function capabilityObservation({ profile, actorId }) {
    const metadata = profileMetadata(profile)
    return seal({
        schema: 'issue-orchestration.runtime-capability-observation.v2',
        source: 'per-dispatch-runtime-identity-observer',
        observable: true,
        runtimeInvocationId: `${actorId}:invocation`,
        sessionOrThreadId: `${actorId}:session`,
        runtimeVersion: 'codex-cli-2026.08',
        requestedProfile: profile,
        effectiveProfile: profile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        multiAgentBackend: 'v2',
        rawEventDigest: digest(`${actorId}:event`),
        rawSessionDigest: digest(`${actorId}:session-raw`),
        rawTurnDigest: digest(`${actorId}:turn`),
        observedAt: '2026-08-04T02:00:02.000Z'
    }, 'observationDigest')
}

function observedStageRoute({
    context,
    stageRole,
    stagePhase,
    actorId,
    stageWorkPlan,
    executableSlice,
    writeLeaseDigest = null
}) {
    const base = stageWorkPlan
        ? {
            stageWorkPlan,
            executableSlice,
            routingClassification: classification(),
            executionMetrics: {
                expectedChangedFileCount: 1,
                ownedModuleCount: 1,
                commandLoopCount: 1,
                runtimeProbeDepth: 0,
                toolInteractionDepth: 2,
                contextBreadth: 'narrow',
                statefulContinuationRequired: false,
                checkpointSupportRequired: 'simple',
                firstActionDeterministic: true,
                wholeIssueScope: false
            },
            machineClassificationEvidence: {
                schema: 'issue-orchestration.execution-shape-observation.v1',
                source: 'machine-slice-and-runtime-observer',
                observedAt: '2026-08-04T02:00:02.000Z',
                evidenceDigest: digest('writer-shape')
            }
        }
        : {
            ...classification(),
            stageRole,
            stagePhase
        }
    const pending = compileCanonicalRoute(base)
    const decision = pending.executionRouteDecision
    const observation = executionObservation({
        context,
        stageRole,
        stagePhase,
        profile: decision.selectedProfile,
        routeDecisionDigest: decision.routeDecisionDigest,
        actorId
    })
    const binding = compileRuntimeExecutionBinding({
        stageRole,
        stagePhase,
        selectedProfile: decision.selectedProfile,
        routeDecisionDigest: decision.routeDecisionDigest,
        runtimeObservation: observation,
        ...context,
        writeLeaseDigest
    })
    const final = compileCanonicalRoute({
        ...base,
        ...context,
        runtimeExecutionBinding: binding,
        runtimeCapabilityObservation: capabilityObservation({
            profile: decision.selectedProfile,
            actorId
        })
    })
    return final.executionRouteDecision
}

function routeActor({ routeDecision, actorId, proposalOnly }) {
    return {
        actorId,
        actorRole: routeDecision.stageRole,
        role: routeDecision.stageRole,
        stagePhase: routeDecision.stagePhase,
        phase: routeDecision.stagePhase,
        routeDecision,
        executionRouteDecision: routeDecision,
        routeDecisionDigest: routeDecision.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            routeDecision.runtimeExecutionBindingDigest,
        executionClass: routeDecision.executionClass,
        mutationContract:
            routeDecision.stagePhase === 'test-contract'
                ? 'lease-and-slice-allowlist'
                : 'no-protected-mutation',
        writeScope:
            routeDecision.stagePhase === 'test-contract'
                ? 'tests-only'
                : 'none',
        freshContext: true,
        proposalOnly,
        mutationPostconditionReceiptDigest:
            digest(`${actorId}:postcondition`)
    }
}

function remoteIssue(baseSha) {
    return {
        repository: 'ExampleOrg/RepositoryA',
        number: 22,
        state: 'OPEN',
        stateReason: null,
        updatedAt: '2026-08-04T01:59:00.000Z',
        title: 'Build deterministic cold start',
        body: 'The public API must reach the first test writer dispatch.',
        comments: [{
            id: 2201,
            body: 'A changed relevant comment must invalidate planning.',
            updatedAt: '2026-08-04T01:59:30.000Z',
            relevant: true
        }],
        labels: ['P0'],
        milestone: null,
        dependsOn: [],
        baseSha
    }
}

function baseInput({ fixture, context, selectorReceipt, issue }) {
    scenarioSequence += 1
    return {
        runId: `run-cold-start-22-${scenarioSequence}`,
        nodeId: 'ExampleOrg/RepositoryA#22',
        nodeEpoch: 1,
        stateRoot: fixture.stateRoot,
        issue,
        selectorReceipt,
        sourceDagDigest: digest('semantic-graph-v2'),
        skillDigest: digest('skill'),
        baselineDigest: digest('baseline'),
        requestedAt: '2026-08-04T02:01:00.000Z',
        stageFrozenAt: '2026-08-04T02:03:00.000Z',
        issueKind: 'code',
        planningAttemptId: 'planning-attempt-22',
        writerAttemptId: 'writer-attempt-22',
        writerRoute: {
            routingClassification: classification(),
            executionMetrics: {
                expectedChangedFileCount: 1,
                ownedModuleCount: 1,
                commandLoopCount: 1,
                runtimeProbeDepth: 0,
                toolInteractionDepth: 2,
                contextBreadth: 'narrow',
                statefulContinuationRequired: false,
                checkpointSupportRequired: 'simple',
                firstActionDeterministic: true,
                wholeIssueScope: false
            },
            machineClassificationEvidence: {
                schema: 'issue-orchestration.execution-shape-observation.v1',
                source: 'machine-slice-and-runtime-observer',
                observedAt: '2026-08-04T02:02:00.000Z',
                evidenceDigest: digest('cold-start-shape')
            }
        },
        context
    }
}

function semanticProposal({ snapshot, routeDecision }) {
    const classifications = snapshot.normativeBlocks.map((block) => ({
        sourceIdentity: block.sourceIdentity,
        sourceSpanDigest: block.spanDigest,
        classification:
            block.sourceKind === 'body'
                ? 'acceptance'
                : block.sourceKind === 'comment'
                    ? 'constraint'
                    : 'context',
        contextReason:
            block.sourceKind === 'title'
                ? 'Title names the bounded objective.'
                : null,
        ownerRepository: snapshot.repository,
        affectedStageClasses: ['test-contract'],
        aliases: []
    }))
    return seal({
        schema:
            'issue-orchestration.issue-requirement-inventory-proposal.v1',
        actorRole: 'dag-creator-updater',
        rootAuthored: false,
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteSnapshotDigest: snapshot.remoteSnapshotDigest,
        classifications,
        actorRuntime: routeActor({
            routeDecision,
            actorId: 'semantic-actor-22',
            proposalOnly: true
        })
    }, 'proposalDigest')
}

function planningOutputs({ request, snapshot, routeDecision, acceptance }) {
    const actor = routeActor({
        routeDecision,
        actorId: 'planning-actor-22',
        proposalOnly: true
    })
    const sliceProposal = seal({
        schema: 'issue-orchestration.slice-plan-proposal.v1',
        proposalAuthoredBy: 'test-owner:test-contract-planning',
        rootAuthored: false,
        acceptanceContractDigest: acceptance.contractDigest,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        objective: 'Write the frozen test contract for issue 22',
        allowedPaths: ['tests/cold-start-22.test.mjs'],
        forbiddenPaths: ['skills/', 'src/'],
        requiredCommands: [
            'node --test tests/cold-start-22.test.mjs'
        ],
        requiredEvidence: ['test-output'],
        orderedSlices: [{
            sliceId: 'test-contract-slice-1',
            objective: 'Create the deterministic cold-start test',
            acceptanceIds: [...acceptance.executableAcceptanceIds],
            allowedPaths: ['tests/cold-start-22.test.mjs'],
            firstRequiredAction:
                'write:tests/cold-start-22.test.mjs',
            firstReadTargets: ['tests/cold-start-22.test.mjs'],
            firstWritablePath: 'tests/cold-start-22.test.mjs',
            explicitReadOnlyOutput: null,
            requiredCreatedOrModifiedFiles: [
                'tests/cold-start-22.test.mjs'
            ],
            requiredCommands: [
                'node --test tests/cold-start-22.test.mjs'
            ],
            requiredEvidence: ['test-output'],
            explicitNonGoals: ['do-not-edit-production-code'],
            expectedFailureOrProgressSignal: 'test file exists',
            maxChangedFiles: 1,
            maxOwnedModules: 1,
            maxReadOnlyOperationsBeforeCheckpoint: 8,
            maxNoArtifactToolCalls: 4,
            maxNoArtifactActiveDurationClass: 'short',
            safeCheckpointKind: 'stage-progress'
        }],
        sliceDependencyGraph: {
            'test-contract-slice-1': []
        },
        planningAttemptId: request.attemptId,
        routeDecisionDigest: request.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            request.runtimeExecutionBindingDigest,
        mutationPostconditionReceiptDigest:
            actor.mutationPostconditionReceiptDigest,
        actorRuntime: actor
    }, 'proposalDigest')
    const planningReceipt = seal({
        schema: 'issue-orchestration.test-contract-plan-receipt.v1',
        status: 'verified',
        rootAuthored: false,
        attemptId: request.attemptId,
        acceptanceContractDigest: acceptance.contractDigest,
        nodeDiscoveredReceiptDigest:
            request.nodeDiscoveredReceiptDigest,
        requestDigest: request.requestDigest,
        routeDecisionDigest: request.routeDecisionDigest,
        ownerRepository: snapshot.repository,
        testPaths: ['tests/cold-start-22.test.mjs'],
        commands: ['node --test tests/cold-start-22.test.mjs'],
        fixturePaths: [],
        runtimeProbes: [],
        stageBoundaries: ['tests-only'],
        sliceProposalDigest: sliceProposal.proposalDigest,
        filesystemWrites: [],
        disputedAuthority: null,
        ...actor
    }, 'receiptDigest')
    const investigationReceipt = seal({
        schema:
            'issue-orchestration.test-planning-investigation-receipt.v1',
        status: 'verified',
        actorRole: 'test-owner',
        phase: 'test-contract-planning',
        rootAuthored: false,
        attemptId: request.attemptId,
        requestDigest: request.requestDigest,
        sourceFingerprint: snapshot.issueSnapshotFingerprint,
        acceptanceContractDigest: acceptance.contractDigest,
        routeDecisionDigest: request.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            request.runtimeExecutionBindingDigest,
        mutationPostconditionReceiptDigest:
            actor.mutationPostconditionReceiptDigest
    }, 'receiptDigest')
    return { planningReceipt, investigationReceipt, sliceProposal }
}

function writerResource({ request, fixture }) {
    const resourceRegistry = {
        schema: 'issue-orchestration.resource-registry.v1',
        runId: request.runId,
        issueId: request.nodeId,
        stageAttemptId: request.writerAttemptId,
        stageTaskId: request.resourceRequest.firstSliceId,
        stageRole: 'test-owner',
        issueWorktreeId: 'worktree-cold-start-22',
        baseSha: fixture.baseSha,
        epochId: request.resourceRequest.epochId,
        allowedPathsDigest: digest(request.resourceRequest.allowedPaths),
        testContractDigest: request.resourceRequest.testContractDigest,
        slotHeld: true,
        writeLease: {
            id: 'lease-cold-start-22',
            ownerAttemptId: request.writerAttemptId,
            mode: 'write',
            state: 'active'
        },
        resources: [{
            resourceId: 'worktree-cold-start-22',
            resourceType: 'worktree',
            ownerClass: 'attempt-owned',
            ownerRunId: request.runId,
            ownerAttemptId: request.writerAttemptId,
            state: 'active',
            identityEvidence: {
                path: fs.realpathSync(fixture.repositoryPath),
                baseSha: fixture.baseSha
            }
        }]
    }
    const registryIdentityDigest =
        writerResourceRegistryIdentityDigest({
            registry: resourceRegistry,
            worktreeIdentity: fixture.repositoryPath
        })
    const now = Date.now()
    const resourceLease = acquireDispatchLease({
        activeLeases: [],
        request: {
            leaseId: 'lease-cold-start-22',
            kind: 'writer-stage-resource',
            keys: [
                `worktree:${fs.realpathSync(fixture.repositoryPath)}`,
                `resource-registry:${registryIdentityDigest}`
            ],
            ownerId: 'test-owner',
            attemptId: request.writerAttemptId,
            stageTaskId: request.resourceRequest.firstSliceId,
            acquiredAt: new Date(now - 1_000).toISOString(),
            expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
            recoveryRule: 'terminal-receipt-required'
        }
    }).lease
    return {
        worktreeIdentity: fixture.repositoryPath,
        resourceRegistry,
        resourceLease
    }
}

test('cold-start public API reaches an authorized first writer dispatch from raw issue facts', async () => {
    const f = fixture()
    const context = runtimeContext(f.repositoryPath)
    const issue = remoteIssue(f.baseSha)
    const selectorReceipt = resolveSelector({
        selector: {
            schema: 'issue-orchestration.scope-selector.v1',
            selectorVersion: 1,
            type: 'explicit-issues',
            repositories: [issue.repository],
            parameters: {
                issueIds: [`${issue.repository}#${issue.number}`]
            },
            remoteQueryIdentity: 'cold-start-selector'
        },
        remoteIssues: [issue],
        resolvedAt: '2026-08-04T02:00:30.000Z',
        startup: context.startup
    })
    assert.deepEqual(fs.readdirSync(f.stateRoot), [])
    const base = baseInput({
        fixture: f,
        context,
        selectorReceipt,
        issue
    })
    const first = advanceTestContractColdStart(base)
    assert.equal(first.status, 'next-required-invocation')
    assert.equal(
        first.nextInvocation.action,
        'request-semantic-proposal'
    )
    const semanticRoute = observedStageRoute({
        context,
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        actorId: 'semantic-actor-22'
    })
    const proposal = semanticProposal({
        snapshot: first.snapshot,
        routeDecision: semanticRoute
    })
    const planningRoute = observedStageRoute({
        context,
        stageRole: 'test-owner',
        stagePhase: 'test-contract-planning',
        actorId: 'planning-actor-22'
    })
    const second = advanceTestContractColdStart({
        ...base,
        semanticProposal: proposal,
        semanticRootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        },
        planningRouteDecision: planningRoute
    })
    assert.notEqual(second.status, 'blocked', JSON.stringify(second))
    assert.equal(
        second.nextInvocation.action,
        'request-test-contract-planning'
    )
    const outputs = planningOutputs({
        request: second.nextInvocation.planningRequest,
        snapshot: second.snapshot,
        routeDecision: planningRoute,
        acceptance: second.acceptanceContract
    })
    const bundle = compileTestContractPlanningBundle({
        request: second.nextInvocation.planningRequest,
        snapshot: second.snapshot,
        ...outputs
    })
    const third = advanceTestContractColdStart({
        ...base,
        semanticProposal: proposal,
        semanticRootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        },
        planningRouteDecision: planningRoute,
        planningBundle: bundle
    })
    assert.equal(
        third.nextInvocation.action,
        'acquire-test-contract-writer-resource'
    )
    const resource = writerResource({
        request: {
            ...base,
            resourceRequest: third.nextInvocation.resourceRequest
        },
        fixture: f
    })
    const fourth = advanceTestContractColdStart({
        ...base,
        semanticProposal: proposal,
        semanticRootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        },
        planningRouteDecision: planningRoute,
        planningBundle: bundle,
        writerResource: resource
    })
    assert.notEqual(fourth.status, 'blocked', JSON.stringify(fourth))
    assert.equal(
        fourth.nextInvocation.action,
        'bind-test-contract-writer-runtime'
    )
    const pending = fourth.nextInvocation.pendingRouteBundle
        .executionRouteDecision
    const writerRuntime = {
        ...context,
        executionObservation: executionObservation({
            context,
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            profile: pending.selectedProfile,
            routeDecisionDigest: pending.routeDecisionDigest,
            actorId: 'writer-actor-22'
        }),
        capabilityObservation: capabilityObservation({
            profile: pending.selectedProfile,
            actorId: 'writer-actor-22'
        })
    }
    const final = advanceTestContractColdStart({
        ...base,
        semanticProposal: proposal,
        semanticRootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        },
        planningRouteDecision: planningRoute,
        planningBundle: bundle,
        writerResource: resource,
        writerRuntime
    })
    assert.notEqual(final.status, 'blocked', JSON.stringify(final))
    assert.equal(final.status, 'dispatch-authorized')
    assert.equal(final.dispatch.status, 'dispatch-authorized')
    assert.notEqual(
        final.dispatch.planningAttemptId,
        final.dispatch.writerAttemptId
    )
    assert.equal(final.dispatch.fullIssueBodyIncluded, false)
    assert.equal(final.dispatch.callerSuppliedAuthorityIncluded, false)
    assert.equal(final.dispatch.preexistingFrozenHistoryIncluded, false)
    assert.equal(final.nodeProjection.nodes[base.nodeId].status, 'discovered')
    assert.equal(
        final.nodeProjection.nodes[base.nodeId].frozenWriterPlanDigest,
        final.stageWorkPlan.planDigest
    )
    const canonicalNodeLocation = canonicalNodeStateLocation({
        stateRoot: f.stateRoot,
        runId: base.runId,
        nodeId: base.nodeId
    })
    const writerAuthorityLocation = writerStageAuthorityLocation({
        runId: base.runId,
        node: base.nodeId,
        stageAttemptId: base.writerAttemptId
    })
    assert.equal(
        writerAuthorityLocation.sourceLedgerPath,
        canonicalNodeLocation.ledgerPath
    )
    assert.equal(
        writerAuthorityLocation.sourceProjectionPath,
        canonicalNodeLocation.projectionPath
    )
    let validateJsonSchema = null
    try {
        ({ validateJsonSchema } = await import(
            '../../tools/test-matrix/schema-validator/validate.mjs'
        ))
    } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
    for (const [value, contract] of [
        [final.snapshot, 'cold-start-issue-snapshot.schema.json'],
        [final.nodeDiscoveredReceipt, 'node-discovered-receipt.schema.json'],
        [final.planningBundle, 'test-contract-planning-bundle.schema.json'],
        [final.resourceReceipt,
            'writer-resource-acquisition-receipt.schema.json'],
        [final.dispatch, 'test-contract-writer-dispatch.schema.json']
    ]) {
        if (validateJsonSchema) {
            assert.deepEqual(validateJsonSchema(value, schema(contract)), [])
        }
        assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    }
})

function selectorFor(issue, context) {
    return resolveSelector({
        selector: {
            schema: 'issue-orchestration.scope-selector.v1',
            selectorVersion: 1,
            type: 'explicit-issues',
            repositories: [issue.repository],
            parameters: {
                issueIds: [`${issue.repository}#${issue.number}`]
            },
            remoteQueryIdentity: 'cold-start-selector'
        },
        remoteIssues: [issue],
        resolvedAt: '2026-08-04T02:00:30.000Z',
        startup: context.startup
    })
}

function preparePlanningScenario() {
    const f = fixture()
    const context = runtimeContext(f.repositoryPath)
    const issue = remoteIssue(f.baseSha)
    const selectorReceipt = selectorFor(issue, context)
    const base = baseInput({
        fixture: f,
        context,
        selectorReceipt,
        issue
    })
    const first = advanceTestContractColdStart(base)
    assert.equal(first.status, 'next-required-invocation')
    const semanticRoute = observedStageRoute({
        context,
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        actorId: 'semantic-actor-22'
    })
    const proposal = semanticProposal({
        snapshot: first.snapshot,
        routeDecision: semanticRoute
    })
    const planningRoute = observedStageRoute({
        context,
        stageRole: 'test-owner',
        stagePhase: 'test-contract-planning',
        actorId: 'planning-actor-22'
    })
    const accepted = {
        ...base,
        semanticProposal: proposal,
        semanticRootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        },
        planningRouteDecision: planningRoute
    }
    const second = advanceTestContractColdStart(accepted)
    assert.equal(second.status, 'next-required-invocation')
    const outputs = planningOutputs({
        request: second.nextInvocation.planningRequest,
        snapshot: second.snapshot,
        routeDecision: planningRoute,
        acceptance: second.acceptanceContract
    })
    const bundle = compileTestContractPlanningBundle({
        request: second.nextInvocation.planningRequest,
        snapshot: second.snapshot,
        ...outputs
    })
    const third = advanceTestContractColdStart({
        ...accepted,
        planningBundle: bundle
    })
    assert.equal(third.status, 'next-required-invocation')
    return {
        f,
        context,
        issue,
        selectorReceipt,
        base,
        first,
        semanticRoute,
        proposal,
        planningRoute,
        accepted,
        second,
        outputs,
        bundle,
        third
    }
}

test('cold-start rejects stale issue facts and forbidden caller authority', async () => {
    const f = fixture()
    const context = runtimeContext(f.repositoryPath)
    const issue = remoteIssue(f.baseSha)
    const selectorReceipt = selectorFor(issue, context)
    const base = baseInput({ fixture: f, context, selectorReceipt, issue })
    const changedIssue = structuredClone(issue)
    changedIssue.comments[0].body = 'This relevant comment changed after selection.'
    changedIssue.comments[0].updatedAt = '2026-08-04T02:00:45.000Z'
    const stale = advanceTestContractColdStart({
        ...base,
        issue: changedIssue
    })
    assert.equal(stale.status, 'blocked')
    assert.equal(stale.code, 'cold-start-selector-member-stale')
    assert.deepEqual(JSON.parse(JSON.stringify(stale)), stale)
    try {
        const { validateJsonSchema } = await import(
            '../../tools/test-matrix/schema-validator/validate.mjs'
        )
        assert.deepEqual(validateJsonSchema(
            stale,
            schema('test-contract-cold-start-blocker.schema.json')
        ), [])
    } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
    for (const forbidden of [
        { preexistingFrozenContract: { fabricated: true } },
        { fullIssueBody: issue.body },
        { callerSuppliedAuthority: { actor: 'root' } }
    ]) {
        const result = advanceTestContractColdStart({
            ...base,
            ...forbidden
        })
        assert.equal(result.status, 'blocked')
        assert.equal(result.code, 'test-contract-cold-start-forbidden-input')
    }
})

test('cold-start rejects incomplete and authority-choice semantic coverage', () => {
    for (const mode of ['missing', 'authority-choice']) {
        const scenario = preparePlanningScenario()
        const proposal = structuredClone(scenario.proposal)
        delete proposal.proposalDigest
        if (mode === 'missing') {
            proposal.classifications.pop()
        } else {
            proposal.classifications[0].classification =
                'authority-choice-required'
        }
        proposal.proposalDigest = digest(proposal)
        const result = advanceTestContractColdStart({
            ...scenario.base,
            semanticProposal: proposal,
            semanticRootDecision: {
                action: 'accept',
                proposalDigest: proposal.proposalDigest,
                modified: false
            },
            planningRouteDecision: scenario.planningRoute
        })
        assert.equal(result.status, 'blocked')
        assert.equal(
            result.code,
            mode === 'missing'
                ? 'requirement-source-coverage'
                : 'requirement-authority-choice'
        )
    }
})

test('cold-start rejects stale planning bindings and attempt reuse', () => {
    const scenario = preparePlanningScenario()
    const staleBundle = structuredClone(scenario.bundle)
    staleBundle.planningReceipt.requestDigest = digest('stale-request')
    delete staleBundle.planningReceipt.receiptDigest
    staleBundle.planningReceipt.receiptDigest =
        digest(staleBundle.planningReceipt)
    delete staleBundle.bundleDigest
    staleBundle.bundleDigest = digest(staleBundle)
    const stale = advanceTestContractColdStart({
        ...scenario.accepted,
        planningBundle: staleBundle
    })
    assert.equal(stale.status, 'blocked')
    assert.equal(stale.code, 'test-planning-request-binding')

    const reused = advanceTestContractColdStart({
        ...scenario.accepted,
        writerAttemptId: scenario.base.planningAttemptId,
        planningBundle: scenario.bundle
    })
    assert.equal(reused.status, 'blocked')
    assert.equal(reused.code, 'test-contract-attempt-separation')
})

test('cold-start rejects stale base and invalid writer runtime route', () => {
    const staleBaseScenario = preparePlanningScenario()
    fs.writeFileSync(
        path.join(staleBaseScenario.f.repositoryPath, 'drift.txt'),
        'base drift\n'
    )
    git(staleBaseScenario.f.repositoryPath, 'add', '.')
    git(staleBaseScenario.f.repositoryPath, 'commit', '--quiet', '-m', 'drift')
    const resource = writerResource({
        request: {
            ...staleBaseScenario.base,
            resourceRequest:
                staleBaseScenario.third.nextInvocation.resourceRequest
        },
        fixture: staleBaseScenario.f
    })
    const staleBase = advanceTestContractColdStart({
        ...staleBaseScenario.accepted,
        planningBundle: staleBaseScenario.bundle,
        writerResource: resource
    })
    assert.equal(staleBase.status, 'blocked')
    assert.match(staleBase.code, /writer-resource|frozen-stage/u)
    staleBaseScenario.f.baseSha = git(
        staleBaseScenario.f.repositoryPath,
        'rev-parse',
        'HEAD'
    )

    const routeScenario = preparePlanningScenario()
    const validResource = writerResource({
        request: {
            ...routeScenario.base,
            resourceRequest: routeScenario.third.nextInvocation.resourceRequest
        },
        fixture: routeScenario.f
    })
    const fourth = advanceTestContractColdStart({
        ...routeScenario.accepted,
        planningBundle: routeScenario.bundle,
        writerResource: validResource
    })
    assert.notEqual(fourth.status, 'blocked', JSON.stringify(fourth))
    assert.equal(fourth.status, 'next-required-invocation')
    const pending = fourth.nextInvocation.pendingRouteBundle
        .executionRouteDecision
    const writerRuntime = {
        ...routeScenario.context,
        executionObservation: executionObservation({
            context: routeScenario.context,
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            profile: pending.selectedProfile,
            routeDecisionDigest: digest('wrong-route'),
            actorId: 'writer-actor-invalid-route'
        }),
        capabilityObservation: capabilityObservation({
            profile: pending.selectedProfile,
            actorId: 'writer-actor-invalid-route'
        })
    }
    const invalidRoute = advanceTestContractColdStart({
        ...routeScenario.accepted,
        planningBundle: routeScenario.bundle,
        writerResource: validResource,
        writerRuntime
    })
    assert.equal(invalidRoute.status, 'blocked')
    assert.match(invalidRoute.code, /runtime-execution|execution-route/u)
})
