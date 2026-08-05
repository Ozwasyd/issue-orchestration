import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    compileCanonicalRoute,
    EXECUTION_ROUTING_POLICY_DIGEST
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    compileStageRoutingIdentity,
    splitProfile,
    STAGE_MODEL_POOL_POLICY
} from '../../skills/issue-orchestration/scripts/stage-profile-policy.mjs'
import {
    STAGE_PERMISSIONS_POLICY_DIGEST
} from '../../skills/issue-orchestration/scripts/dispatch-receipt.mjs'
import {
    RUNTIME_EXECUTION_BINDING_POLICY_DIGEST
} from '../../skills/issue-orchestration/scripts/runtime-execution-binding.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

const actorScript = fileURLToPath(new URL(
    './issue-orchestration/writer-stage-actor.mjs',
    import.meta.url
))

export function writerExecutionMetrics(overrides = {}) {
    return {
        expectedChangedFileCount: 1,
        ownedModuleCount: 1,
        commandLoopCount: 1,
        runtimeProbeDepth: 1,
        toolInteractionDepth: 2,
        contextBreadth: 'narrow',
        statefulContinuationRequired: false,
        checkpointSupportRequired: 'simple',
        firstActionDeterministic: true,
        wholeIssueScope: false,
        ...overrides
    }
}

export function writerMachineClassificationEvidence({
    action,
    executionMetrics
}) {
    return {
        schema: 'issue-orchestration.execution-shape-observation.v1',
        source: 'machine-slice-and-runtime-observer',
        observedAt: '2026-08-04T01:00:00.000Z',
        evidenceDigest: digest({
            actionDigest: action.actionDigest,
            executionMetrics
        })
    }
}

export function writerStageRouteIdentity({
    classification,
    stageRole,
    stagePhase
}) {
    return compileStageRoutingIdentity({
        ...classification,
        stageRole,
        stagePhase,
        requiredSkillDigests: []
    })
}

export function compileWriterDispatchRequest({
    action,
    authority,
    classification,
    executionMetrics,
    machineClassificationEvidence,
    pendingRouteDecision,
    startup,
    runtimeTrustBinding,
    repositoryPath
}) {
    const bundle = compileCanonicalRoute({
        stageWorkPlan: authority.stageWorkPlan,
        executableSlice: authority.executableSlice,
        routingClassification: classification,
        executionMetrics,
        machineClassificationEvidence,
        documentationClass: classification.documentationClass ?? null
    })
    if (bundle.executionRouteDecision.routeDecisionDigest !==
            pendingRouteDecision.routeDecisionDigest) {
        throw new Error('writer dispatch route drift')
    }
    const route = writerStageRouteIdentity({
        classification,
        stageRole: authority.stageWorkPlan.stageRole,
        stagePhase: authority.stageWorkPlan.stagePhase
    })
    const selected = splitProfile(pendingRouteDecision.selectedProfile)
    const plan = authority.stageWorkPlan
    const slice = authority.executableSlice
    const prompt = authority.compiledPrompt
    const sequence = {
        schema: 'issue-orchestration.writer-slice-sequence-binding.v1',
        source: 'initial-stage-plan',
        projectionStatus: null,
        planDigest: plan.planDigest,
        stageAttemptId: plan.stageAttemptId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        sliceIndex: 0,
        expectedNextSliceId: slice.sliceId,
        expectedNextSliceDigest: slice.sliceDigest,
        prerequisiteSliceIds: [...slice.prerequisiteSliceIds],
        completedSliceReceiptDigests: [],
        writerStageProjectionDigest: null
    }
    return {
        schema: 'issue-orchestration.dispatch-request.v2',
        policyVersion: 'stage-model-pool.v4',
        routingPolicyDigest: digest(STAGE_MODEL_POOL_POLICY),
        stagePermissionsPolicyDigest: STAGE_PERMISSIONS_POLICY_DIGEST,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        stageProfileId: pendingRouteDecision.selectedProfile,
        allowedProfilesDigest: digest(pendingRouteDecision.allowedProfiles),
        defaultProfileId: route.defaultProfile,
        routingAuthority: pendingRouteDecision.routingAuthority,
        routingInputDigest: plan.routingInputDigest,
        selectedProfileReason:
            pendingRouteDecision.selectedProfileReason,
        selectedProfileId: pendingRouteDecision.selectedProfile,
        routingClassification: structuredClone(classification),
        documentationClass: classification.documentationClass ?? null,
        routeTransitionFrom: null,
        routeTransitionReason: 'initial-classification',
        requestedByRole: 'root-scheduler',
        requestId: `request:${plan.stageAttemptId}`,
        runId: plan.runId,
        nodeId: plan.node,
        executionRoutingPolicyDigest: EXECUTION_ROUTING_POLICY_DIGEST,
        executionMetrics: structuredClone(executionMetrics),
        machineClassificationEvidence:
            structuredClone(machineClassificationEvidence),
        machinePartitionEvidence: null,
        machineFrontierEvidence: null,
        executionShapeClassification:
            bundle.executionShapeClassification,
        stageCapabilityRequirement:
            bundle.stageCapabilityRequirement,
        executionRouteDecision: bundle.executionRouteDecision,
        executionShapeClassificationDigest:
            bundle.executionShapeClassification.classificationDigest,
        stageCapabilityRequirementDigest:
            bundle.stageCapabilityRequirement.capabilityDigest,
        executionRouteDecisionDigest:
            bundle.executionRouteDecision.routeDecisionDigest,
        attemptId: plan.stageAttemptId,
        promptDigest: prompt.promptDigest,
        sourceDagDigest:
            action.bindings.semanticGraphDigest ?? digest('writer-dag'),
        frontierDigest: digest({
            actionDigest: action.actionDigest,
            stage: plan.stagePhase
        }),
        issueSnapshotFingerprint: digest({
            nodeId: action.nodeId,
            remoteMemberDigest: action.bindings.remoteMemberDigest
        }),
        repositoryFingerprint: action.bindings.repositoryBindingDigest,
        scopeIdentityDigest: action.bindings.selectorReceiptDigest,
        dependencyIdentityDigest: digest(plan.acceptanceItems),
        repository: plan.repository,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        requestedModel: selected.model,
        requestedEffort: selected.effort,
        requestedMultiAgentBackend: 'v2',
        requestedMode: 'normal',
        executionClass: route.executionClass,
        runtimeExecutionBindingPolicyDigest:
            RUNTIME_EXECUTION_BINDING_POLICY_DIGEST,
        startupAttestationDigest:
            startup.attestation.attestationDigest,
        runtimeInvocationId:
            startup.attestation.runtimeInvocationId,
        runtimeTrustBindingDigest: runtimeTrustBinding.bindingDigest,
        mutationContract: route.mutationContract,
        requiredPostconditionEvidenceClass:
            route.requiredPostconditionEvidenceClass,
        mutationPostconditionRequired: true,
        requestedForkTurns: '3',
        requestedWorkingDirectory: plan.worktreeIdentity,
        requiredSkills: [],
        requiredSkillIds: [],
        requiredSkillDigests: [],
        designAuthorityDigests: [],
        uiImpact: false,
        allowedPathsDigest: digest(slice.allowedPaths),
        forbiddenPathsDigest: digest(slice.forbiddenPaths),
        semanticWriteScope: route.writeScope,
        observeOnlyPolicy: false,
        candidateSha: plan.baseSha,
        candidateDigest: digest({ baseSha: plan.baseSha }),
        testOwnerId: 'test-owner:writer-executor',
        testContractDigest: plan.testContractDigest,
        behaviorReceiptDigest: null,
        uxAcceptanceReceiptDigest: null,
        documentationReceiptDigest: null,
        groupId: null,
        groupSessionDigest: null,
        memberIssueId: plan.node,
        memberStage: plan.stagePhase,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        groupWorktreeIdentity: null,
        groupBranchIdentity: null,
        testOwnerContinuityIdentity: null,
        implementerContinuityIdentity: null,
        freshVerificationRollout: false,
        memberTestContractDigest: plan.testContractDigest,
        memberCandidateIdentity: digest({
            node: plan.node,
            stageAttemptId: plan.stageAttemptId
        }),
        createdAt: '2026-08-04T01:00:01.000Z',
        writerSequenceBinding: sequence,
        writerSequenceBindingDigest: digest(sequence),
        stageWorkPlan: plan,
        executableSlice: slice,
        compiledPrompt: prompt,
        planDigest: plan.planDigest,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: prompt.promptDigest,
        slicePolicyDigest: plan.slicePolicyDigest,
        plannerReceiptDigest: plan.plannerReceiptDigest,
        plannerBindingStatus: plan.plannerBindingStatus
    }
}

function sealedObservation(value) {
    return seal(value, 'observationDigest')
}

export function writerDispatchEvidence({
    request,
    runtimeExecutionObservation
}) {
    const machineObservations = [
        sealedObservation({
            kind: 'dispatch-context.v2',
            source: 'machine-dispatch-context',
            requestId: request.requestId,
            promptDigest: request.promptDigest,
            sourceDagDigest: request.sourceDagDigest,
            frontierDigest: request.frontierDigest,
            issueSnapshotFingerprint:
                request.issueSnapshotFingerprint,
            repositoryFingerprint: request.repositoryFingerprint,
            scopeIdentityDigest: request.scopeIdentityDigest,
            dependencyIdentityDigest:
                request.dependencyIdentityDigest,
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
            repository: request.repository,
            baseSha: request.baseSha,
            candidateSha: request.candidateSha,
            candidateDigest: request.candidateDigest,
            workingDirectory: request.requestedWorkingDirectory
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
            memberIssueId: request.memberIssueId,
            memberStage: request.memberStage,
            freshVerificationRollout:
                request.freshVerificationRollout,
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
            timestamp: '2026-08-04T01:00:02.000Z',
            type: 'session_meta',
            payload: {
                id: runtimeExecutionObservation.actorInvocationId,
                session_id: runtimeExecutionObservation.actorSessionId,
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
            timestamp: '2026-08-04T01:00:02.000Z',
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
    return { machineObservations, rolloutRecords }
}

export function createWriterActorAdapter({
    current,
    fixture,
    runtimeObservation,
    runtimeCapabilityObservation,
    extraWritePath = null,
    acceptedPriorChangedPaths = [],
    watchdogMode = 'normal'
}) {
    let invoked = false
    let watchdogSeenBeforeSpawn = false
    return {
        get invoked() { return invoked },
        get watchdogSeenBeforeSpawn() {
            return watchdogSeenBeforeSpawn
        },
        prepare() {
            return {
                preparation: { actorId: 'writer-actor' },
                runtimeObservation,
                runtimeCapabilityObservation,
                requestId: 'writer-request',
                threadId: runtimeObservation.actorSessionId,
                rolloutId: runtimeObservation.actorInvocationId,
                startedAtMs: 1_000
            }
        },
        invoke({ request, watchdog }) {
            watchdogSeenBeforeSpawn = Boolean(watchdog?.observe)
            if (!watchdogSeenBeforeSpawn) {
                throw new Error('watchdog was not online before spawn')
            }
            invoked = true
            watchdog.observe({
                type: 'runtime-initialized',
                trusted: true,
                atMs: 1_001
            })
            const relativePath =
                request.executableSlice
                    .requiredCreatedOrModifiedFiles[0]
            const child = spawnSync(process.execPath, [actorScript], {
                encoding: 'utf8',
                input: JSON.stringify({
                    repositoryPath:
                        request.requestedWorkingDirectory,
                    relativePath,
                    content: "export const issue38Writer = 'green'\n"
                })
            })
            if (child.status !== 0) {
                throw new Error(child.stderr || child.stdout)
            }
            if (extraWritePath) {
                const extra = spawnSync(process.execPath, [actorScript], {
                    encoding: 'utf8',
                    input: JSON.stringify({
                        repositoryPath:
                            request.requestedWorkingDirectory,
                        relativePath: extraWritePath,
                        content: "export const forbiddenIssue38 = true\n"
                    })
                })
                if (extra.status !== 0) {
                    throw new Error(extra.stderr || extra.stdout)
                }
            }
            watchdog.observe({
                type: 'filesystem-write',
                trusted: true,
                atMs: 1_002,
                action: watchdogMode === 'first-action-mismatch'
                    ? `${request.executableSlice.firstRequiredAction}:wrong`
                    : request.executableSlice.firstRequiredAction,
                path: relativePath,
                evidenceDigest: digest(child.stdout)
            })
            if (watchdogMode === 'normal') {
                for (const [index, command] of
                    request.executableSlice.requiredCommands.entries()) {
                    watchdog.observe({
                        type: 'command-start',
                        trusted: true,
                        atMs: 1_003 + index * 2,
                        command,
                        processId: 10_000 + index
                    })
                    watchdog.observe({
                        type: 'command-heartbeat',
                        trusted: true,
                        atMs: 1_004 + index * 2,
                        processId: 10_000 + index,
                        processAlive: true,
                        leaseDigest:
                            request.stageWorkPlan.resourceLeaseReceiptDigest
                    })
                }
            }
            const progress = buildVerifiedWriterProgressCheckpoint({
                current,
                artifacts: {
                    stageWorkPlan: request.stageWorkPlan,
                    executableSlice: request.executableSlice,
                    compiledPrompt: request.compiledPrompt
                },
                routeDigest: request.executionRouteDecisionDigest,
                status: 'complete',
                acceptedPriorChangedPaths
            })
            if (watchdogMode === 'normal') {
                watchdog.observe({
                    type: 'terminal-receipt',
                    trusted: true,
                    atMs: 1_020,
                    status: 'completed',
                    receiptDigest:
                        progress.checkpointVerificationReceipt.receiptDigest
                })
            }
            const evidence = writerDispatchEvidence({
                request,
                runtimeExecutionObservation: runtimeObservation
            })
            return {
                outcome: 'completed',
                changedPaths: [relativePath],
                commandEvidenceDigests:
                    progress.checkpoint.evidence.commands.map(
                        ({ outputDigest }) => outputDigest
                    ),
                checkpointVerificationInput: {
                    checkpoint: progress.checkpoint,
                    verificationReceipt:
                        progress.checkpointVerificationReceipt,
                    verifiedAt:
                        progress.checkpointVerificationReceipt.verifiedAt,
                    acceptedPriorChangedPaths:
                        progress.acceptedPriorChangedPaths,
                    completedSlicePrefixDigest:
                        progress.completedSlicePrefixDigest,
                    checkpointOrdinal: 1
                },
                priorTerminalReceipts: [],
                runtimeExecutionObservation: runtimeObservation,
                mutationOutput: {
                    status: 'completed',
                    changedPaths: [relativePath]
                },
                attributionStatus: 'verified',
                ...evidence
            }
        }
    }
}
