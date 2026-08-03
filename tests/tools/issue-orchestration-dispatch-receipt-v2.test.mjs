import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
    compileWriterStageTestArtifacts
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    runtimeStartupRecords,
    startupTestDigest,
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    compileRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    RUNTIME_EXECUTION_BINDING_POLICY_DIGEST
} from '../../skills/issue-orchestration/scripts/runtime-execution-binding.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const runtimePath = path.join(
    root,
    'skills/issue-orchestration/scripts/dispatch-receipt.mjs'
)
const policyPath = path.join(
    root,
    'skills/issue-orchestration/scripts/stage-profile-policy.mjs'
)
const executionPolicyPath = path.join(
    root,
    'skills/issue-orchestration/scripts/execution-route-compiler.mjs'
)
const stagePermissionsPolicyPath = path.join(
    root,
    'policy/stage-permissions.json'
)
const contract = readJson('dispatch-receipt-v2-test-contract.json')
const acceptance = readJson('dispatch-receipt-v2-acceptance-map.json')
const controls = readJson('dispatch-receipt-v2-mutation-controls.json').controls
const probes = readJson('dispatch-receipt-v2-runtime-probes.json').probes

const baseSha = '788737a0ad22003544b2d439df995e1097de0ee2'
const repository = 'ExampleOrg/RepositoryA'
const issueId = `${repository}#1832`
const worktree = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'issue-orchestration-dispatch-v2-'
))
execFileSync('git', [
    'clone',
    '--quiet',
    '--shared',
    '--no-checkout',
    root,
    worktree
])
execFileSync('git', ['checkout', '--quiet', '--detach', baseSha], {
    cwd: worktree
})
execFileSync('git', [
    'remote',
    'set-url',
    'origin',
    'https://github.com/ExampleOrg/RepositoryA.git'
], { cwd: worktree })
after(() => fs.rmSync(worktree, { force: true, recursive: true }))
const hash = (character) => character.repeat(64)
let writerRequestSequence = 0

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

const stagePermissionsPolicyDigest = digest(
    JSON.parse(fs.readFileSync(stagePermissionsPolicyPath, 'utf8'))
)

function clone(value) {
    return structuredClone(value)
}

function sealedObservation(value) {
    const observation = clone(value)
    observation.observationDigest = digest(observation)
    return observation
}

function runtimeAuthorityFixture() {
    const startup = verifiedRuntimeStartup({
        invocationId: 'invocation-1832-root',
        sessionId: 'session-1832-root'
    })
    const repositoryTargets = [{
        repository,
        repositoryPath: worktree
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

async function runtime() {
    return import(`${pathToFileURL(runtimePath).href}?v2=${Date.now()}-${Math.random()}`)
}

async function policy() {
    return import(`${pathToFileURL(policyPath).href}?v2=${Date.now()}-${Math.random()}`)
}

async function executionPolicy() {
    return import(
        `${pathToFileURL(executionPolicyPath).href}?v2=${Date.now()}-${Math.random()}`
    )
}

async function frozenRoute(changes = {}) {
    const module = await policy()
    const classification = {
        domain: 'orchestration-core',
        effectiveOwnerRepository: repository,
        engineeringRiskClass: 'high-risk',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'runtime',
        modelRoutingEvidenceDigest: hash('a'),
        routingPolicyVersion: 'stage-model-pool.v3',
        ...changes.classification
    }
    const stageRole = changes.stageRole ?? 'code-implementer'
    const stagePhase = changes.stagePhase ?? (
        stageRole === 'ui-ux-implementer'
            ? 'ui-implementation'
            : 'implementation'
    )
    const route = module.compileStageRoute({
        ...classification,
        stageRole,
        stagePhase,
        requiredSkillDigests: changes.requiredSkillDigests ?? []
    })
    return { classification, route, stageRole, stagePhase, module }
}

async function requestInput(overrides = {}) {
    writerRequestSequence += 1
    const invocationId = String(writerRequestSequence).padStart(3, '0')
    const runId = `run-1832-${invocationId}`
    const stageAttemptId =
        overrides.attemptId ?? `attempt-1832-${invocationId}`
    const requestId = `request-1832-${invocationId}`
    const routeInput = await frozenRoute({
        classification: overrides.routingClassification,
        stageRole: overrides.stageRole,
        stagePhase: overrides.stagePhase,
        requiredSkillDigests: (overrides.requiredSkills ?? [])
            .map(({ digest: value }) => value)
    })
    const allowedImplementationPaths = routeInput.stageRole ===
        'ui-ux-implementer'
        ? ['src/components/issue-1832.tsx']
        : contract.allowedImplementationPaths
    const sliceCount = overrides.sliceCount ?? 1
    const requiredFiles =
        allowedImplementationPaths.slice(0, sliceCount)
    const artifacts = compileWriterStageTestArtifacts({
        repository,
        issue: 1832,
        node: issueId,
        stageRole: routeInput.stageRole,
        stagePhase: routeInput.stagePhase,
        baseSha,
        runId,
        epochId: 'epoch-1832-001',
        worktreeIdentity: worktree,
        allowedPaths: allowedImplementationPaths,
        requiredFiles,
        requiredCommands: requiredFiles.map((file) =>
            `node --check ${file}`),
        sliceCount,
        testContractDigest: contract.testContractDigest,
        routingInputDigest: routeInput.route.routingInputDigest,
        stageAttemptId
    })
    const executionModule = await executionPolicy()
    const executionMetrics = {
        expectedChangedFileCount: 1,
        ownedModuleCount: 1,
        commandLoopCount: routeInput.stageRole ===
            'ui-ux-implementer' ? 1 : 3,
        runtimeProbeDepth: routeInput.stageRole ===
            'ui-ux-implementer' ? 0 : 4,
        toolInteractionDepth: routeInput.stageRole ===
            'ui-ux-implementer' ? 2 : 7,
        contextBreadth: 'moderate',
        statefulContinuationRequired: false,
        checkpointSupportRequired: routeInput.stageRole ===
            'ui-ux-implementer' ? 'simple' : 'resumable',
        firstActionDeterministic: true,
        wholeIssueScope: false,
        ...overrides.executionMetrics
    }
    const machineClassificationEvidence = {
        schema: 'issue-orchestration.execution-shape-observation.v1',
        source: 'machine-slice-and-runtime-observer',
        observedAt: '2026-08-01T12:59:59.000Z',
        evidenceDigest: digest({
            requestId,
            executionMetrics
        }),
        ...overrides.machineClassificationEvidence
    }
    const executionRoute = executionModule.compileExecutionRoute({
        stageWorkPlan: artifacts.stageWorkPlan,
        executableSlice: artifacts.executableSlice,
        routingClassification: routeInput.classification,
        executionMetrics,
        machineClassificationEvidence,
        machinePartitionEvidence:
            overrides.machinePartitionEvidence ?? undefined,
        machineFrontierEvidence:
            overrides.machineFrontierEvidence ?? undefined,
        frontierException: overrides.frontierException === true
    })
    const executionDecision =
        executionRoute.executionRouteDecision
    const selected = routeInput.module.splitProfile(
        executionDecision.selectedProfile
    )
    const authority = runtimeAuthorityFixture()
    const writerSequenceBinding = {
        schema: 'issue-orchestration.writer-slice-sequence-binding.v1',
        source: 'initial-stage-plan',
        projectionStatus: null,
        planDigest: artifacts.planDigest,
        stageAttemptId,
        stageRole: routeInput.stageRole,
        stagePhase: routeInput.stagePhase,
        sliceIndex: 0,
        expectedNextSliceId: artifacts.executableSlice.sliceId,
        expectedNextSliceDigest: artifacts.sliceDigest,
        prerequisiteSliceIds: [],
        completedSliceReceiptDigests: [],
        writerStageProjectionDigest: null
    }
    return {
        schema: 'issue-orchestration.dispatch-request.v2',
        policyVersion: 'stage-model-pool.v3',
        routingPolicyDigest: digest(routeInput.module.STAGE_MODEL_POOL_POLICY),
        stagePermissionsPolicyDigest,
        stageRole: routeInput.stageRole,
        stagePhase: routeInput.stagePhase,
        stageProfileId: executionDecision.selectedProfile,
        allowedProfilesDigest:
            digest(executionDecision.allowedProfiles),
        defaultProfileId: routeInput.route.defaultProfile,
        routingAuthority: executionDecision.routingAuthority,
        routingInputDigest: routeInput.route.routingInputDigest,
        selectedProfileReason:
            executionDecision.selectedProfileReason,
        selectedProfileId: executionDecision.selectedProfile,
        routingClassification: routeInput.classification,
        executionRoutingPolicyDigest:
            executionModule.EXECUTION_ROUTING_POLICY_DIGEST,
        executionMetrics,
        machineClassificationEvidence,
        machinePartitionEvidence:
            overrides.machinePartitionEvidence ?? null,
        machineFrontierEvidence:
            overrides.machineFrontierEvidence ?? null,
        executionShapeClassification:
            executionRoute.executionShapeClassification,
        stageCapabilityRequirement:
            executionRoute.stageCapabilityRequirement,
        executionRouteDecision: executionDecision,
        executionShapeClassificationDigest:
            executionRoute.executionShapeClassification
                .classificationDigest,
        stageCapabilityRequirementDigest:
            executionRoute.stageCapabilityRequirement.capabilityDigest,
        executionRouteDecisionDigest:
            executionDecision.routeDecisionDigest,
        executionClass: routeInput.route.executionClass,
        mutationContract: routeInput.route.mutationContract,
        requiredPostconditionEvidenceClass:
            routeInput.route.requiredPostconditionEvidenceClass,
        mutationPostconditionRequired: true,
        runtimeExecutionBindingPolicyDigest:
            RUNTIME_EXECUTION_BINDING_POLICY_DIGEST,
        startupAttestationDigest:
            authority.startup.attestation.attestationDigest,
        runtimeInvocationId:
            authority.startup.attestation.runtimeInvocationId,
        runtimeTrustBindingDigest:
            authority.runtimeTrustBinding.bindingDigest,
        routeTransitionFrom: null,
        routeTransitionReason: 'initial-classification',
        requestedByRole: 'root-scheduler',
        requestId,
        runId,
        nodeId: issueId,
        attemptId: stageAttemptId,
        promptDigest: artifacts.promptDigest,
        sourceDagDigest: hash('c'),
        frontierDigest: hash('d'),
        issueSnapshotFingerprint: hash('e'),
        repositoryFingerprint: hash('f'),
        scopeIdentityDigest: hash('1'),
        dependencyIdentityDigest: digest(contract.dependencyBindings),
        repository,
        baseSha,
        epochId: 'epoch-1832-001',
        requestedModel: selected.model,
        requestedEffort: selected.effort,
        requestedMultiAgentBackend: 'v2',
        requestedMode: 'normal',
        requestedForkTurns: '3',
        requestedWorkingDirectory: worktree,
        requiredSkills: overrides.requiredSkills ?? [],
        requiredSkillIds: (overrides.requiredSkills ?? []).map(({ id }) => id),
        requiredSkillDigests: (overrides.requiredSkills ?? [])
            .map(({ digest: value }) => value),
        designAuthorityDigests: [],
        uiImpact: false,
        allowedPathsDigest: artifacts.allowedPathsDigest,
        forbiddenPathsDigest: artifacts.forbiddenPathsDigest,
        semanticWriteScope: routeInput.route.writeScope,
        observeOnlyPolicy:
            routeInput.route.executionClass === 'observe-only',
        candidateSha: baseSha,
        candidateDigest: hash('4'),
        testOwnerId: contract.testOwnerId,
        testContractDigest: contract.testContractDigest,
        behaviorReceiptDigest: null,
        uxAcceptanceReceiptDigest: null,
        documentationReceiptDigest: null,
        groupId: null,
        groupSessionDigest: null,
        memberIssueId: issueId,
        memberStage: routeInput.stagePhase,
        activeWriteLeaseId:
            artifacts.stageWorkPlan.activeWriteLeaseId,
        groupWorktreeIdentity: null,
        groupBranchIdentity: null,
        testOwnerContinuityIdentity: null,
        implementerContinuityIdentity: null,
        freshVerificationRollout: false,
        memberTestContractDigest: contract.testContractDigest,
        memberCandidateIdentity: hash('5'),
        createdAt: '2026-08-01T13:00:00+08:00',
        writerSequenceBinding,
        writerSequenceBindingDigest: digest(writerSequenceBinding),
        ...artifacts,
        ...Object.fromEntries(
            Object.entries(overrides)
                .filter(([key]) => key !== 'sliceCount')
        ),
        routingClassification: {
            ...routeInput.classification,
            ...overrides.routingClassification
        }
    }
}

async function bindExecutionRoute(input) {
    const executionModule = await executionPolicy()
    const bundle = executionModule.compileExecutionRoute({
        stageWorkPlan: input.stageWorkPlan,
        executableSlice: input.executableSlice,
        routingClassification: input.routingClassification,
        executionMetrics: input.executionMetrics,
        machineClassificationEvidence:
            input.machineClassificationEvidence,
        machinePartitionEvidence:
            input.machinePartitionEvidence ?? undefined,
        machineFrontierEvidence:
            input.machineFrontierEvidence ?? undefined,
        frontierException: input.frontierException === true
    })
    const decision = bundle.executionRouteDecision
    const profileModule = await policy()
    const selected = profileModule.splitProfile(
        decision.selectedProfile
    )
    input.executionShapeClassification =
        bundle.executionShapeClassification
    input.stageCapabilityRequirement =
        bundle.stageCapabilityRequirement
    input.executionRouteDecision = decision
    input.executionShapeClassificationDigest =
        bundle.executionShapeClassification.classificationDigest
    input.stageCapabilityRequirementDigest =
        bundle.stageCapabilityRequirement.capabilityDigest
    input.executionRouteDecisionDigest =
        decision.routeDecisionDigest
    input.stageProfileId = decision.selectedProfile
    input.selectedProfileId = decision.selectedProfile
    input.selectedProfileReason = decision.selectedProfileReason
    input.allowedProfilesDigest = digest(decision.allowedProfiles)
    input.routingAuthority = decision.routingAuthority
    input.requestedModel = selected.model
    input.requestedEffort = selected.effort
    input.requestedMultiAgentBackend = 'v2'
    input.executionClass = decision.executionClass
    return input
}

function dispatchEvidence(request) {
    const authority = runtimeAuthorityFixture()
    const machineObservations = [
        sealedObservation({
            kind: 'dispatch-context.v2',
            source: 'machine-dispatch-context',
            requestId: request.requestId,
            promptDigest: request.promptDigest,
            sourceDagDigest: request.sourceDagDigest,
            frontierDigest: request.frontierDigest,
            issueSnapshotFingerprint: request.issueSnapshotFingerprint,
            repositoryFingerprint: request.repositoryFingerprint,
            scopeIdentityDigest: request.scopeIdentityDigest,
            dependencyIdentityDigest: request.dependencyIdentityDigest,
            policyVersion: request.policyVersion,
            routingPolicyDigest: request.routingPolicyDigest,
            stagePermissionsPolicyDigest:
                request.stagePermissionsPolicyDigest,
            routingInputDigest: request.routingInputDigest,
            executionRouteDecisionDigest:
                request.executionRouteDecisionDigest,
            planDigest: request.planDigest,
            sliceDigest: request.sliceDigest,
            compiledPromptDigest: request.compiledPromptDigest,
            writerSequenceBindingDigest:
                request.writerSequenceBindingDigest,
            testContractDigest: request.testContractDigest,
            epochId: request.epochId
        }),
        sealedObservation({
            kind: 'git-worktree-identity',
            source: 'machine-git-observation',
            repository,
            baseSha: request.baseSha,
            candidateSha: request.candidateSha,
            candidateDigest: request.candidateDigest,
            workingDirectory: worktree
        }),
        sealedObservation({
            kind: 'skill-loader',
            source: 'runtime-skill-loader',
            loadedSkills: request.requiredSkills
        }),
        sealedObservation({
            kind: 'runtime-capability.v2',
            source: 'runtime-capability-registry',
            requestedProfileId: request.selectedProfileId,
            effectiveProfileId: request.selectedProfileId,
            requestedModel: request.requestedModel,
            effectiveModel: request.requestedModel,
            requestedEffort: request.requestedEffort,
            effectiveEffort: request.requestedEffort,
            multiAgentBackend: 'v2',
            available: true
        }),
        sealedObservation({
            kind: 'writer-stage-lease',
            source: 'machine-lease-registry',
            groupId: null,
            memberIssueId: issueId,
            memberStage: request.memberStage,
            freshVerificationRollout: request.freshVerificationRollout,
            leaseId: request.stageWorkPlan.activeWriteLeaseId,
            leaseDigest:
                request.stageWorkPlan.resourceLeaseReceiptDigest,
            attemptId: request.attemptId,
            ownerId: request.stageRole,
            worktreeIdentity: request.requestedWorkingDirectory,
            state: 'active',
            activeLeaseOwners: [{
                leaseId: request.stageWorkPlan.activeWriteLeaseId,
                attemptId: request.attemptId,
                ownerId: request.stageRole,
                worktreeIdentity: request.requestedWorkingDirectory
            }]
        })
    ]
    const rolloutRecords = [
        {
            timestamp: '2026-08-01T13:00:01+08:00',
            type: 'session_meta',
            payload: {
                id: 'rollout-1832-implementer',
                session_id: 'thread-1832-implementer',
                source: {
                    subagent: {
                        thread_spawn: {
                            agent_role: request.stageRole,
                            fork_turns: request.requestedForkTurns
                        }
                    }
                }
            }
        },
        {
            timestamp: '2026-08-01T13:00:01+08:00',
            type: 'turn_context',
            payload: {
                cwd: request.requestedWorkingDirectory,
                model: request.requestedModel,
                effort: request.requestedEffort,
                multiAgentBackend: 'v2',
                mode: request.requestedMode,
                permission_profile: 'danger-full-access'
            }
        }
    ]
    const runtimeExecutionObservation = sealedObservation({
        schema:
            'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId: 'rollout-1832-implementer',
        actorSessionId: 'thread-1832-implementer',
        rootInvocationId:
            authority.startup.attestation.runtimeInvocationId,
        requestedRole: request.stageRole,
        effectiveRole: request.stageRole,
        requestedPhase: request.stagePhase,
        effectivePhase: request.stagePhase,
        requestedProfile: request.selectedProfileId,
        effectiveProfile: request.selectedProfileId,
        requestedModel: request.requestedModel,
        effectiveModel: request.requestedModel,
        requestedEffort: request.requestedEffort,
        effectiveEffort: request.requestedEffort,
        routeDecisionDigest:
            request.executionRouteDecisionDigest,
        packageDigest:
            authority.startup.observation.packageDigest,
        modelPoolPolicyDigest:
            authority.startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            authority.startup.observation.policyDigests
                .executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-01T13:00:01+08:00'
    })
    return {
        machineObservations,
        rolloutRecords,
        runtimeExecutionObservation,
        ...authority
    }
}

async function verifiedDispatch() {
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    const result = await module.verifyRuntimeDispatch({
        request,
        ...dispatchEvidence(request),
        priorReceipts: []
    })
    assert.equal(result.dispatchReceipt.verificationStatus, 'verified')
    assert.equal(
        result.dispatchReceipt.schema,
        'issue-orchestration.dispatch-receipt.v2'
    )
    return { module, request, ...result }
}

function rootStartupInput() {
    return {
        ...runtimeStartupRecords({
            invocationId: 'invocation-1832-root',
            sessionId: 'session-1832-root',
            observedAt: '2026-08-03T01:00:00.000Z'
        }),
        attestedAt: '2026-08-03T01:00:01.000Z'
    }
}

function selfTestExecution(request) {
    const commandResults = contract.visibleTestMatrix.map((entry, index) => ({
        id: entry.id,
        command: entry.command,
        exitStatus: 0,
        skipped: false,
        resultDigest: digest(`${entry.id}:${index}`)
    }))
    return {
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        stageRole: request.stageRole,
        stageProfileId: request.stageProfileId,
        routingInputDigest: request.routingInputDigest,
        requestDigest: request.requestDigest,
        candidateSha: request.candidateSha,
        baseSha: request.baseSha,
        frozenTestContractDigest: contract.testContractDigest,
        frozenTestTreeDigestBefore: contract.frozenTestTree.digest,
        frozenTestTreeDigestAfter: contract.frozenTestTree.digest,
        implementationDiffDigest: hash('8'),
        commandResults,
        visibleTestMatrixDigest: digest(contract.visibleTestMatrix),
        lintTypecheckBuildResults: {
            lint: 'passed',
            typecheck: 'passed',
            build: 'not-applicable-no-build-artifact'
        },
        firstFailureRefs: ['evidence://1832/v2-schema-missing'],
        fixCycleCount: 1,
        failureHistory: [
            { ref: 'evidence://1832/v2-schema-missing', outcome: 'failed' },
            { ref: 'evidence://1832/candidate-green', outcome: 'passed' }
        ],
        remainingFailures: [],
        workingTreeStatusDigest: hash('9'),
        observedWorkingTreeStatusDigest: hash('9'),
        modifiedPaths: [
            'skills/issue-orchestration/scripts/dispatch-receipt.mjs',
            'skills/issue-orchestration/scripts/event-ledger.mjs'
        ],
        verifierRole: 'deterministic-machine'
    }
}

function verifiedV2DispatchReceipt(request = {}) {
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId: request.requestId ?? 'request-1832-001',
        requestDigest: request.requestDigest ?? hash('a'),
        attemptId: request.attemptId ?? 'attempt-1832-001',
        epochId: request.epochId ?? 'epoch-1832-001',
        baseSha: request.baseSha ?? baseSha,
        candidateSha: request.candidateSha ?? baseSha,
        policyVersion: 'stage-model-pool.v3',
        routingPolicyDigest: request.routingPolicyDigest ?? hash('6'),
        routingInputDigest: request.routingInputDigest ?? hash('7'),
        verificationStatus: 'verified',
        mismatchReasons: []
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

function behaviorReceipt({ fresh = true, selfTest = false } = {}) {
    const receipt = {
        schema: selfTest
            ? 'issue-orchestration.implementer-self-test-receipt.v2'
            : 'issue-orchestration.behavior-receipt.v2',
        stageRole: selfTest ? 'code-implementer' : 'test-owner',
        stagePhase: selfTest ? 'self-test' : 'behavior-verification',
        candidateSha: baseSha,
        freshVerificationRollout: selfTest ? false : fresh,
        readOnly: !selfTest,
        verificationStatus: 'verified'
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

async function assertThrownCode(action, expectedCode, id) {
    await assert.rejects(
        action,
        (error) => error?.code === expectedCode,
        id
    )
}

function assertRejectedReason(result, expectedCode, id) {
    const receipt = result.runtimeStartupAttestation ??
        result.dispatchReceipt ?? result
    assert.notEqual(
        receipt.status ?? receipt.verificationStatus,
        'verified',
        id
    )
    assert.ok(
        (receipt.reasonCodes ?? receipt.mismatchReasons)
            ?.includes(expectedCode),
        id
    )
}

test('P00 frozen test assets bind the live issue, dependencies and exact base', () => {
    assert.equal(contract.status, 'frozen-red')
    assert.equal(contract.issueId, issueId)
    assert.equal(contract.baseSha, baseSha)
    assert.equal(contract.testOwnerId, 'test-owner-repositorya-1832-788737a0')
    assert.equal(contract.groupId, null)
    assert.equal(contract.pipeline, 'ordinary-serial')
    assert.equal(contract.ciPolicy, 'out-of-scope-no-ci')
    assert.deepEqual(
        contract.dependencyBindings.map(({ issue, deliveredCommit }) =>
            [issue, deliveredCommit]),
        [
            ['ExampleOrg/RepositoryA#1817', '9c02ed22bdd578d07d6e4ca8c1c4c9bc161bbc18'],
            ['ExampleOrg/RepositoryA#1818', 'c8cb56dce27769a3cc3663cc0e39cc0a75716fed'],
            ['ExampleOrg/RepositoryA#1819', 'aff9260d358171d7765e542e56bf18635b328583']
        ]
    )
    assert.deepEqual(
        acceptance.acceptance.flatMap(({ mutations }) => mutations)
            .filter((value, index, values) => values.indexOf(value) === index)
            .sort(),
        controls.map(({ id }) => id).sort()
    )
    assert.deepEqual(probes.map(({ mutation }) => mutation),
        controls.map(({ id }) => id))
    for (const [relative, expected] of Object.entries(contract.fileHashes)) {
        assert.equal(digest(fs.readFileSync(path.join(root, relative))), expected)
    }
    const unsigned = clone(contract)
    delete unsigned.testContractDigest
    assert.equal(digest(unsigned), contract.testContractDigest)
})

test('P01 dispatch-request.v2 seals every route and serial identity field', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    assert.equal(request.schema, 'issue-orchestration.dispatch-request.v2')
    assert.equal(request.groupId, null)
    assert.equal(request.memberIssueId, issueId)
    assert.equal(request.stageProfileId, 'sol-high')
    assert.equal(
        request.selectedProfileReason,
        'runtime-probe-heavy-minimum-capability-fit'
    )
    assert.equal(
        request.stagePermissionsPolicyDigest,
        module.STAGE_PERMISSIONS_POLICY_DIGEST
    )
    assert.equal(request.executionClass, 'leased-writer')
    assert.equal(request.semanticWriteScope, 'implementation-only')
    assert.equal(request.observeOnlyPolicy, false)
    assert.equal(request.planDigest, request.stageWorkPlan.planDigest)
    assert.equal(request.sliceDigest, request.executableSlice.sliceDigest)
    assert.equal(request.stageWorkPlan.contractBindingStatus, 'verified')
    assert.equal(request.executableSlice.contractBindingStatus, 'verified')
    assert.equal(request.plannerBindingStatus, 'verified')
    assert.equal(
        request.plannerBindingStatus,
        request.stageWorkPlan.plannerBindingStatus
    )
    assert.equal(
        request.plannerBindingStatus,
        request.executableSlice.plannerBindingStatus
    )
    assert.equal(
        request.slicePolicyDigest,
        request.compiledPrompt.slicePolicyDigest
    )
    assert.equal(
        request.plannerReceiptDigest,
        request.compiledPrompt.plannerReceiptDigest
    )
    assert.match(
        request.stageWorkPlan.frozenStageContractReceiptDigest,
        /^[a-f0-9]{64}$/u
    )
    assert.match(
        request.stageWorkPlan.resourceLeaseReceiptDigest,
        /^[a-f0-9]{64}$/u
    )
    assert.equal(
        request.compiledPromptDigest,
        request.compiledPrompt.promptDigest
    )
    assert.equal(request.requestDigest, digest({ ...request, requestDigest: undefined }))
    assert.equal(Object.isFrozen(request), true)
})

test('P01C dispatch rejects stage-permissions policy drift before sealing', async () => {
    const module = await runtime()
    const drifted = await requestInput({
        stagePermissionsPolicyDigest: hash('0')
    })
    await assertThrownCode(
        () => module.sealDispatchRequest(drifted),
        'dispatch-stage-permissions-policy-replay',
        'stage-permissions policy digest drift'
    )
})

test('P01B UI and landing dispatch use only the permanent writer phases and roles', async () => {
    const module = await runtime()
    const uiSkills = [
        { id: 'repositorya-design-conformance', digest: hash('a') },
        { id: 'repositoryb-design-conformance', digest: hash('b') }
    ]
    const cases = [
        {
            stageRole: 'code-implementer',
            stagePhase: 'landing-conflict-resolution'
        },
        {
            stageRole: 'ui-ux-implementer',
            stagePhase: 'ui-implementation',
            routingClassification: {
                domain: 'ui-ux',
                engineeringRiskClass: 'bounded',
                uiDecisionClass: 'prescribed',
                verificationClass: 'ux-local'
            },
            requiredSkills: uiSkills,
            designAuthorityDigests: uiSkills.map(({ digest: value }) => value),
            uiImpact: true
        },
        {
            stageRole: 'ui-ux-implementer',
            stagePhase: 'landing-conflict-resolution',
            routingClassification: {
                domain: 'ui-ux',
                engineeringRiskClass: 'bounded',
                uiDecisionClass: 'prescribed',
                verificationClass: 'ux-local'
            },
            requiredSkills: uiSkills,
            designAuthorityDigests: uiSkills.map(({ digest: value }) => value),
            uiImpact: true
        }
    ]
    for (const expected of cases) {
        const request = await module.sealDispatchRequest(
            await requestInput(expected)
        )
        assert.equal(request.stageRole, expected.stageRole)
        assert.equal(request.stagePhase, expected.stagePhase)
        assert.equal(request.stageWorkPlan.stageRole, expected.stageRole)
        assert.equal(request.stageWorkPlan.stagePhase, expected.stagePhase)
    }
    await assertThrownCode(
        () => requestInput({
            stageRole: 'ui-ux-implementer',
            stagePhase: 'implementation',
            routingClassification: {
                domain: 'ui-ux',
                engineeringRiskClass: 'bounded',
                uiDecisionClass: 'prescribed',
                verificationClass: 'ux-local'
            },
            requiredSkills: uiSkills
        }),
        'routing-stage-role-phase',
        'legacy UI writer phase'
    )
    await assertThrownCode(
        () => requestInput({
            stageRole: 'landing-owner',
            stagePhase: 'landing-conflict-resolution'
        }),
        'routing-stage-role-phase',
        'landing-owner'
    )
})

test('P01A writer dispatch requires the complete compiled artifact chain', async () => {
    const module = await runtime()
    for (const field of [
        'planDigest',
        'sliceDigest',
        'compiledPromptDigest',
        'plannerBindingStatus',
        'slicePolicyDigest',
        'plannerReceiptDigest',
        'stageWorkPlan',
        'executableSlice',
        'compiledPrompt'
    ]) {
        const input = await requestInput()
        delete input[field]
        await assertThrownCode(
            () => module.sealDispatchRequest(input),
            'dispatch-executable-slice-binding',
            field
        )
    }
    for (const [owner, field] of [
        ['stageWorkPlan', 'frozenStageContractReceiptDigest'],
        ['stageWorkPlan', 'resourceLeaseReceiptDigest'],
        ['stageWorkPlan', 'plannerBindingStatus'],
        ['stageWorkPlan', 'slicePolicyDigest'],
        ['stageWorkPlan', 'plannerReceiptDigest'],
        ['executableSlice', 'frozenStageContractReceiptDigest'],
        ['executableSlice', 'resourceLeaseReceiptDigest'],
        ['executableSlice', 'plannerBindingStatus'],
        ['executableSlice', 'slicePolicyDigest'],
        ['executableSlice', 'plannerReceiptDigest'],
        ['compiledPrompt', 'slicePolicyDigest'],
        ['compiledPrompt', 'plannerReceiptDigest']
    ]) {
        const input = clone(await requestInput())
        delete input[owner][field]
        await assertThrownCode(
            () => module.sealDispatchRequest(input),
            'dispatch-executable-slice-binding',
            `${owner}.${field}`
        )
    }
    const unbound = clone(await requestInput())
    unbound.plannerBindingStatus = 'unbound-test-only'
    unbound.stageWorkPlan.plannerBindingStatus = 'unbound-test-only'
    unbound.executableSlice.plannerBindingStatus = 'unbound-test-only'
    await assertThrownCode(
        () => module.sealDispatchRequest(unbound),
        'dispatch-executable-slice-binding',
        'unbound-test-only planner'
    )
})

test('P01D writer dispatch accepts only the projection-owned slice order', async () => {
    const module = await runtime()
    for (const field of [
        'writerSequenceBinding',
        'writerSequenceBindingDigest'
    ]) {
        const missing = await requestInput()
        delete missing[field]
        await assertThrownCode(
            () => module.sealDispatchRequest(missing),
            'dispatch-executable-slice-binding',
            field
        )
    }

    const request = clone(await requestInput({ sliceCount: 2 }))
    const secondSlice = request.executableSlices[1]
    const secondPrompt = request.compiledPrompts[1]
    request.executableSlice = secondSlice
    request.sliceDigest = secondSlice.sliceDigest
    request.compiledPrompt = secondPrompt
    request.compiledPromptDigest = secondPrompt.promptDigest
    request.promptDigest = secondPrompt.promptDigest
    await bindExecutionRoute(request)

    const wrongOrder = clone(request)
    wrongOrder.writerSequenceBinding = {
        ...wrongOrder.writerSequenceBinding,
        sliceIndex: 1,
        expectedNextSliceId: secondSlice.sliceId,
        expectedNextSliceDigest: secondSlice.sliceDigest,
        prerequisiteSliceIds: [...secondSlice.prerequisiteSliceIds]
    }
    wrongOrder.writerSequenceBindingDigest = digest(
        wrongOrder.writerSequenceBinding
    )
    await assertThrownCode(
        () => module.sealDispatchRequest(wrongOrder),
        'dispatch-executable-slice-binding',
        'second slice cannot claim initial dispatch'
    )

    const projected = clone(request)
    projected.writerSequenceBinding = {
        schema: 'issue-orchestration.writer-slice-sequence-binding.v1',
        source: 'semantic-runtime-projection',
        projectionStatus: 'next-slice',
        planDigest: request.planDigest,
        stageAttemptId: request.stageWorkPlan.stageAttemptId,
        stageRole: request.stageRole,
        stagePhase: request.stagePhase,
        sliceIndex: 1,
        expectedNextSliceId: secondSlice.sliceId,
        expectedNextSliceDigest: secondSlice.sliceDigest,
        prerequisiteSliceIds: [...secondSlice.prerequisiteSliceIds],
        completedSliceReceiptDigests: [hash('8')],
        writerStageProjectionDigest: hash('9')
    }
    projected.writerSequenceBindingDigest = digest(
        projected.writerSequenceBinding
    )
    const sealed = await module.sealDispatchRequest(projected)
    assert.equal(sealed.sliceDigest, secondSlice.sliceDigest)
    assert.equal(
        sealed.writerSequenceBinding.projectionStatus,
        'next-slice'
    )

    const forgedExpectedNext = clone(projected)
    forgedExpectedNext.writerSequenceBinding.expectedNextSliceDigest =
        hash('0')
    forgedExpectedNext.writerSequenceBindingDigest = digest(
        forgedExpectedNext.writerSequenceBinding
    )
    await assertThrownCode(
        () => module.sealDispatchRequest(forgedExpectedNext),
        'dispatch-executable-slice-binding',
        'forged expectedNextSliceDigest'
    )
})

test('P02 dispatch-receipt.v2 binds independently observed actual metadata', async () => {
    const { request, runtimeObservation, dispatchReceipt } = await verifiedDispatch()
    assert.equal(runtimeObservation.effectiveModel, request.requestedModel)
    assert.equal(runtimeObservation.effectiveEffort, request.requestedEffort)
    assert.equal(runtimeObservation.effectiveRole, request.stageRole)
    assert.equal(runtimeObservation.effectiveMode, 'normal')
    assert.equal(runtimeObservation.routingInputDigest, request.routingInputDigest)
    assert.equal(dispatchReceipt.runtimeMetadataDigest, digest(runtimeObservation))
    assert.equal(dispatchReceipt.scopeIdentityDigest, request.scopeIdentityDigest)
    assert.equal(dispatchReceipt.dependencyIdentityDigest,
        request.dependencyIdentityDigest)
})

test('P03 root startup proves Terra/low/V2/normal actuals', async () => {
    const module = await runtime()
    const verifyRootStartup = module.verifyRootStartup
    assert.equal(typeof verifyRootStartup, 'function')
    const result = await verifyRootStartup(rootStartupInput())
    assert.deepEqual(result.runtimeStartupAttestation, {
        ...result.runtimeStartupAttestation,
        schema:
            'issue-orchestration.runtime-startup-attestation.v1',
        rootPhase: 'scheduling',
        effectiveModel: 'gpt-5.6-terra',
        effectiveEffort: 'low',
        effectiveMultiAgentBackend: 'v2',
        status: 'verified',
        reasonCodes: []
    })
    assert.equal(
        result.runtimeStartupAttestation.attestationDigest,
        digest({
            ...result.runtimeStartupAttestation,
            attestationDigest: undefined
        })
    )
})

test('P04 unobservable actual metadata cannot be marked verified', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    const evidence = dispatchEvidence(request)
    delete evidence.rolloutRecords[1].payload.model
    delete evidence.rolloutRecords[1].payload.effort
    const result = await module.verifyRuntimeDispatch({
        request,
        ...evidence,
        priorReceipts: []
    })
    assert.equal(result.dispatchReceipt.verificationStatus, 'capability-unverified')
    assert.ok(result.dispatchReceipt.mismatchReasons.includes(
        'runtime-model-unobservable'))
    assert.ok(result.dispatchReceipt.mismatchReasons.includes(
        'runtime-effort-unobservable'))
})

test('P05 deterministic routing is recomputed and receipt-bound', async () => {
    const { module: policyModule, route } = await frozenRoute()
    assert.equal(route.selectedProfile, 'sol-high')
    assert.equal(route.selectedProfileReason, 'engineering-risk-high-risk')
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    const { dispatchReceipt } = await module.verifyRuntimeDispatch({
        request,
        ...dispatchEvidence(request),
        priorReceipts: []
    })
    assert.equal(dispatchReceipt.policyVersion, policyModule.ROUTING_POLICY_VERSION)
    assert.equal(dispatchReceipt.routingInputDigest, route.routingInputDigest)
    assert.equal(dispatchReceipt.selectedProfileId, route.selectedProfile)
})

test('P06 ordinary serial receipt binds exact scope and dependency identity', async () => {
    const { request, dispatchReceipt } = await verifiedDispatch()
    assert.equal(request.groupId, null)
    for (const field of [
        'groupSessionDigest', 'groupWorktreeIdentity', 'groupBranchIdentity',
        'testOwnerContinuityIdentity',
        'implementerContinuityIdentity'
    ]) assert.equal(request[field], null, field)
    assert.equal(
        request.activeWriteLeaseId,
        request.stageWorkPlan.activeWriteLeaseId
    )
    assert.equal(dispatchReceipt.memberIssueId, issueId)
    assert.equal(dispatchReceipt.scopeIdentityDigest, request.scopeIdentityDigest)
    assert.equal(dispatchReceipt.dependencyIdentityDigest,
        digest(contract.dependencyBindings))
})

test('P07 implementer-self-test-receipt.v2 binds route and frozen evidence', async () => {
    const { module, request, dispatchReceipt } = await verifiedDispatch()
    const receipt = await module.sealImplementerSelfTestReceipt({
        request,
        dispatchReceipt,
        contract,
        execution: selfTestExecution(request),
        priorReceipts: []
    })
    assert.equal(
        receipt.schema,
        'issue-orchestration.implementer-self-test-receipt.v2'
    )
    assert.equal(receipt.verificationStatus, 'verified')
    assert.equal(receipt.stageProfileId, request.stageProfileId)
    assert.equal(receipt.routingInputDigest, request.routingInputDigest)
    assert.equal(receipt.baseSha, request.baseSha)
    assert.equal(receipt.frozenTestContractDigest, contract.testContractDigest)
    assert.equal(receipt.fixCycleCount, 1)
    assert.deepEqual(receipt.remainingFailures, [])
})

test('P08 v1 receipts are readable history but cannot authorize v2 transitions', async () => {
    const module = await runtime()
    const historical = JSON.parse(JSON.stringify({
        schema: 'issue-orchestration.dispatch-receipt.v1',
        verificationStatus: 'verified'
    }))
    await assertThrownCode(
        () => module.authorizeReceiptTransition({
            eventType: 'implementation.started',
            transitionSchema: 'issue-orchestration.transition.v2',
            dispatchReceipt: historical
        }),
        'receipt-v1-historical-only',
        'P08'
    )
})

test('P09 behavior-green requires the fresh read-only verifier v2 receipt', async () => {
    const module = await runtime()
    await module.authorizeReceiptTransition({
        eventType: 'independent-verification.passed',
        transitionSchema: 'issue-orchestration.transition.v2',
        candidateSha: baseSha,
        dispatchReceipt: verifiedV2DispatchReceipt(),
        behaviorReceipt: behaviorReceipt()
    })
})

async function runControl(control) {
    const module = await runtime()
    if (control.id === 'N01-root-actual-sol-low') {
        const input = rootStartupInput()
        input.runtimeRecord.effectiveModel = 'gpt-5.6-sol'
        input.runtimeRecord.recordDigest = startupTestDigest({
            ...input.runtimeRecord,
            recordDigest: undefined
        })
        assertRejectedReason(await module.verifyRootStartup(input),
            'runtime-startup-profile-mismatch', control.id)
        return
    }
    if (control.id === 'N08-root-runtime-metadata-unobservable') {
        const input = rootStartupInput()
        delete input.runtimeRecord.effectiveModel
        delete input.runtimeRecord.effectiveEffort
        input.runtimeRecord.recordDigest = startupTestDigest({
            ...input.runtimeRecord,
            recordDigest: undefined
        })
        assertRejectedReason(await module.verifyRootStartup(input),
            'runtime-startup-profile-mismatch', control.id)
        return
    }
    if (control.id === 'N10-behavior-verifier-not-fresh') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'independent-verification.passed',
                transitionSchema: 'issue-orchestration.transition.v2',
                candidateSha: baseSha,
                dispatchReceipt: verifiedV2DispatchReceipt(),
                behaviorReceipt: behaviorReceipt({ fresh: false })
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N11-self-test-signs-behavior-green') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'independent-verification.passed',
                transitionSchema: 'issue-orchestration.transition.v2',
                candidateSha: baseSha,
                dispatchReceipt: verifiedV2DispatchReceipt(),
                behaviorReceipt: behaviorReceipt({ selfTest: true })
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N13-v1-dispatch-transition-authority') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'implementation.started',
                transitionSchema: 'issue-orchestration.transition.v2',
                dispatchReceipt: {
                    schema: 'issue-orchestration.dispatch-receipt.v1',
                    verificationStatus: 'verified'
                }
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N14-v1-self-test-transition-authority') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'implementation.candidate-green',
                transitionSchema: 'issue-orchestration.transition.v2',
                candidateSha: baseSha,
                dispatchReceipt: verifiedV2DispatchReceipt(),
                selfTestReceipt: {
                    schema: 'issue-orchestration.implementer-self-test-receipt.v1',
                    verificationStatus: 'verified'
                }
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N22-frozen-test-tree-drift') {
        const { request, dispatchReceipt } = await verifiedDispatch()
        const execution = selfTestExecution(request)
        execution.frozenTestTreeDigestAfter = hash('0')
        const result = await module.sealImplementerSelfTestReceipt({
            request,
            dispatchReceipt,
            contract,
            execution,
            priorReceipts: []
        })
        assertRejectedReason(result, control.expectedCode, control.id)
        return
    }
    let input
    if (['N04-ui-prescribed-forbidden-family',
        'N05-ui-implementer-sol-high',
        'N06-ui-dispute-bypasses-adjudicator'].includes(control.id)) {
        input = await requestInput({
            stageRole: 'ui-ux-implementer',
            routingClassification: {
                domain: 'ui-ux',
                engineeringRiskClass: 'bounded',
                uiDecisionClass: control.id === 'N06-ui-dispute-bypasses-adjudicator'
                    ? 'layout-judgment'
                    : 'prescribed',
                verificationClass: 'ux-local'
            },
            requiredSkills: [
                { id: 'repositorya-design-conformance', digest: hash('a') },
                { id: 'repositoryb-design-conformance', digest: hash('b') }
            ],
            uiImpact: true
        })
    } else if (control.id === 'N21-runtime-skill-digest-drift') {
        input = await requestInput({
            requiredSkills: [
                { id: 'issue-orchestration', digest: hash('a') }
            ]
        })
    } else input = await requestInput()
    if (control.id === 'N02-bounded-terra-without-reclassification') {
        input.routingClassification.engineeringRiskClass = 'bounded'
        input.executionMetrics = {
            ...input.executionMetrics,
            commandLoopCount: 1,
            runtimeProbeDepth: 0,
            toolInteractionDepth: 2,
            checkpointSupportRequired: 'simple'
        }
    }
    if (control.id === 'N03-high-risk-luna') {
        input.stageProfileId = 'luna-max'
        input.selectedProfileId = 'luna-max'
        input.requestedModel = 'gpt-5.6-luna'
    }
    if (control.id === 'N04-ui-prescribed-forbidden-family') {
        input.stageProfileId = 'luna-max'
        input.selectedProfileId = 'luna-max'
        input.requestedModel = 'gpt-5.6-luna'
        input.requestedEffort = 'max'
    }
    if (control.id === 'N05-ui-implementer-sol-high') {
        input.stageProfileId = 'sol-high'
        input.selectedProfileId = 'sol-high'
        input.requestedModel = 'gpt-5.6-sol'
        input.requestedEffort = 'high'
    }
    if (control.id === 'N06-ui-dispute-bypasses-adjudicator') {
        input.routingClassification.uiDecisionClass = 'system-design-dispute'
        input.adjudicationReceiptDigest = null
    }
    if (control.id === 'N07-root-balance-model-substitution') {
        input.routingOverride = {
            selectedByRole: 'root-scheduler',
            reason: 'balance'
        }
    }
    if (control.id === 'N09-group-member-inherits-previous-route') {
        input.groupId = 'group-1832-negative'
        input.groupSessionDigest = hash('a')
        input.groupWorktreeIdentity = hash('b')
        input.groupBranchIdentity = hash('c')
        input.testOwnerContinuityIdentity = hash('d')
        input.implementerContinuityIdentity = hash('e')
        input.previousMemberRoutingReceiptDigest = input.routingInputDigest
    }
    if (control.id === 'N12-old-policy-digest-replay') {
        input.routingPolicyDigest = hash('0')
    }
    if (control.id === 'N16-root-direct-profile-selection') {
        input.selectedByRole = 'root-scheduler'
    }
    if (control.id === 'N19-non-group-id-omitted') delete input.groupId
    if (['N02-bounded-terra-without-reclassification',
        'N03-high-risk-luna',
        'N04-ui-prescribed-forbidden-family',
        'N05-ui-implementer-sol-high',
        'N06-ui-dispute-bypasses-adjudicator',
        'N07-root-balance-model-substitution',
        'N09-group-member-inherits-previous-route',
        'N12-old-policy-digest-replay',
        'N16-root-direct-profile-selection',
        'N19-non-group-id-omitted'].includes(control.id)) {
        await assertThrownCode(
            () => module.sealDispatchRequest(input),
            control.expectedCode,
            control.id
        )
        return
    }
    const request = await module.sealDispatchRequest(input)
    const evidence = dispatchEvidence(request)
    if (control.id === 'N15-unavailable-profile-silent-fallback') {
        evidence.machineObservations[3].available = false
        evidence.machineObservations[3].effectiveProfileId = 'sol-high'
        evidence.machineObservations[3].observationDigest =
            digest({ ...evidence.machineObservations[3], observationDigest: undefined })
    }
    if (control.id === 'N17-scope-identity-drift') {
        evidence.machineObservations[0].scopeIdentityDigest = hash('0')
        evidence.machineObservations[0].observationDigest =
            digest({ ...evidence.machineObservations[0], observationDigest: undefined })
    }
    if (control.id === 'N18-dependency-identity-drift') {
        evidence.machineObservations[0].dependencyIdentityDigest = hash('0')
        evidence.machineObservations[0].observationDigest =
            digest({ ...evidence.machineObservations[0], observationDigest: undefined })
    }
    if (control.id === 'N20-receipt-replay-new-base-candidate') {
        const replay = {
            ...verifiedV2DispatchReceipt(request),
            baseSha: '0'.repeat(40),
            candidateSha: '1'.repeat(40)
        }
        replay.receiptDigest = digest({
            ...replay,
            receiptDigest: undefined
        })
        evidence.priorReceipts = [replay]
    }
    if (control.id === 'N21-runtime-skill-digest-drift') {
        evidence.machineObservations[2].loadedSkills = [
            { id: 'issue-orchestration', digest: hash('b') }
        ]
        evidence.machineObservations[2].observationDigest =
            digest({ ...evidence.machineObservations[2], observationDigest: undefined })
    }
    const result = await module.verifyRuntimeDispatch({
        request,
        ...evidence,
        priorReceipts: evidence.priorReceipts ?? []
    })
    assertRejectedReason(result, control.expectedCode, control.id)
}

for (const control of controls) {
    test(`${control.id} ${control.requirement}`, async () => {
        await runControl(control)
    })
}
