import {
    HASH,
    digest,
    sameValue,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    compileIssueAcceptanceContract,
    compileRequirementInventory
} from './issue-requirement-authority.mjs'
import {
    TERMINAL_POLICY_VERSION,
    compileTerminalRecoveryFingerprint,
    validateTerminalEvidenceSet,
    validateTerminalRecoveryDomains,
    validateTerminalRecoveryExhaustion
} from './terminal-policy.mjs'
import {
    evaluateWriterStageObservation
} from './writer-stage-progress.mjs'

export const LIFECYCLE_STAGE_RESULT_SCHEMA =
    'issue-orchestration.lifecycle-stage-result.v1'

const SHA = /^[a-f0-9]{40}$/u

export class LifecycleStageAdmissionError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'LifecycleStageAdmissionError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new LifecycleStageAdmissionError(code, code, details)
}

function clone(value) {
    return structuredClone(value)
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
    return value
}

function artifact({
    schema,
    digestField = 'receiptDigest',
    producerAuthority,
    actorAuthored = false,
    validator,
    evidence = () => {}
}) {
    return Object.freeze({
        schema,
        digestField,
        producerAuthority,
        actorAuthored,
        validator,
        evidence
    })
}

function evidenceObject(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function hash(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
    return value
}

function sha(value, code) {
    if (!SHA.test(value ?? '')) fail(code)
    return value
}

function integer(value, code, { min = 0 } = {}) {
    if (!Number.isInteger(value) || value < min) fail(code)
    return value
}

function boolean(value, code) {
    if (typeof value !== 'boolean') fail(code)
    return value
}

function exactKeys(value, expected, code) {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    if (!sameValue(actual, wanted)) {
        fail(code, { actual, expected: wanted })
    }
}

function noForbiddenAuthority(value, code) {
    const source = JSON.stringify(value)
    if (/"decision"\s*:|lifecycle-actor-result\.v1/iu.test(source)) {
        fail(code)
    }
}

function commonEvidence(value, kind) {
    evidenceObject(value, `lifecycle-artifact-${kind}-evidence`)
}

const COMMON = Object.freeze({
    runtimeBinding: artifact({
        schema: 'issue-orchestration.runtime-execution-binding.v1',
        digestField: 'bindingDigest',
        producerAuthority: 'runtime-execution-binding-validator',
        validator: 'validateRuntimeExecutionBinding',
        evidence: (value) => {
            commonEvidence(value, 'runtime-binding')
            text(value.actorInvocationId,
                'lifecycle-runtime-actor-invocation-required')
            text(value.actorSessionId,
                'lifecycle-runtime-actor-session-required')
            text(value.effectiveProfile,
                'lifecycle-runtime-profile-required')
            text(value.effectiveModel,
                'lifecycle-runtime-model-required')
            text(value.effectiveEffort,
                'lifecycle-runtime-effort-required')
            text(value.effectiveBackend,
                'lifecycle-runtime-backend-required')
            text(value.effectivePermissionProfile,
                'lifecycle-runtime-permission-required')
            hash(value.executionObservationDigest,
                'lifecycle-runtime-observation-required')
        }
    }),
    mutationPostcondition: artifact({
        schema:
            'issue-orchestration.stage-mutation-postcondition-receipt.v1',
        producerAuthority: 'stage-runtime-guard',
        validator: 'validateStageMutationPostconditionReceipt',
        evidence: (value) => {
            commonEvidence(value, 'mutation-postcondition')
            if (value.status !== 'verified' ||
                !Array.isArray(value.violations) ||
                value.violations.length !== 0) {
                fail('lifecycle-mutation-postcondition-not-clean')
            }
            hash(value.preSnapshotDigest,
                'lifecycle-mutation-pre-snapshot-required')
            hash(value.postSnapshotDigest,
                'lifecycle-mutation-post-snapshot-required')
            hash(value.observationDigest,
                'lifecycle-mutation-observation-required')
        }
    }),
    dispatchReceipt: artifact({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        producerAuthority: 'runtime-dispatch-verifier',
        validator: 'verifyRuntimeDispatch',
        evidence: (value) => {
            commonEvidence(value, 'dispatch')
            text(value.actorInvocationId,
                'lifecycle-dispatch-invocation-required')
            hash(value.routeDecisionDigest,
                'lifecycle-dispatch-route-required')
            hash(value.compiledPromptDigest,
                'lifecycle-dispatch-prompt-required')
            hash(value.runtimeExecutionBindingDigest,
                'lifecycle-dispatch-runtime-binding-required')
        }
    }),
    watchdog: artifact({
        schema:
            'issue-orchestration.machine-writer-runtime-trace-handle.v1',
        producerAuthority: 'writer-runtime-watchdog',
        validator: 'createWriterRuntimeWatchdog',
        evidence: (value) => {
            commonEvidence(value, 'watchdog')
            text(value.watchdogId,
                'lifecycle-watchdog-id-required')
            if (value.startedBeforeSpawn !== true ||
                value.online !== true) {
                fail('lifecycle-watchdog-not-online-before-spawn')
            }
            hash(value.policyDigest,
                'lifecycle-watchdog-policy-required')
        }
    }),
    checkpointVerification: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'writer-checkpoint-verifier',
        validator: 'verifyWriterStageCheckpointLiveEvidence',
        evidence: (value) => {
            commonEvidence(value, 'checkpoint-verification')
            hash(value.checkpointDigest,
                'lifecycle-checkpoint-digest-required')
            hash(value.commandEvidenceDigest,
                'lifecycle-checkpoint-command-evidence-required')
            if (value.liveEvidenceVerified !== true) {
                fail('lifecycle-checkpoint-live-evidence-required')
            }
        }
    }),
    sliceTerminal: artifact({
        schema: 'issue-orchestration.slice-terminal-receipt.v1',
        producerAuthority: 'writer-stage-terminal-gate',
        validator: 'evaluateSliceTerminalGate',
        evidence: (value) => {
            commonEvidence(value, 'slice-terminal')
            text(value.sliceId,
                'lifecycle-slice-terminal-id-required')
            hash(value.sliceDigest,
                'lifecycle-slice-terminal-digest-required')
            hash(value.checkpointDigest,
                'lifecycle-slice-terminal-checkpoint-required')
            if (value.status !== 'verified') {
                fail('lifecycle-slice-terminal-not-verified')
            }
        }
    })
})

const SEMANTIC_ARTIFACTS = Object.freeze({
    semanticProposal: artifact({
        schema: 'issue-orchestration.semantic-graph-proposal.v1',
        digestField: 'proposalDigest',
        producerAuthority: 'dag-creator-updater',
        actorAuthored: true,
        validator: 'validateFullSemanticGraphProposal',
        evidence: (value) => {
            commonEvidence(value, 'semantic-proposal')
            if (!Array.isArray(value.classifications) ||
                value.classifications.length === 0 ||
                value.classifications.some((item) =>
                    typeof item !== 'string' || item.length === 0)) {
                fail('lifecycle-semantic-classifications-required')
            }
            hash(value.sourceFingerprint,
                'lifecycle-semantic-source-fingerprint-required')
            hash(value.runtimeExecutionBindingDigest,
                'lifecycle-semantic-runtime-binding-required')
        }
    }),
    semanticProposalValidation: artifact({
        schema:
            'issue-orchestration.investigation-validation-receipt.v1',
        producerAuthority: 'semantic-investigation-validator',
        validator: 'validateInvestigationProjection',
        evidence: (value) => {
            commonEvidence(value, 'semantic-validation')
            hash(value.proposalDigest,
                'lifecycle-semantic-validation-proposal-required')
            hash(value.sourceFingerprint,
                'lifecycle-semantic-validation-source-required')
            if (value.status !== 'verified') {
                fail('lifecycle-semantic-validation-not-verified')
            }
        }
    }),
    runtimeBinding: COMMON.runtimeBinding,
    mutationPostcondition: COMMON.mutationPostcondition
})

const ACCEPTANCE_ARTIFACTS = Object.freeze({
    requirementInventory: artifact({
        schema:
            'issue-orchestration.issue-requirement-inventory.v1',
        digestField: 'inventoryDigest',
        producerAuthority: 'deterministic-requirement-compiler',
        validator: 'compileRequirementInventory',
        evidence: (value) => {
            commonEvidence(value, 'requirement-inventory')
            if (!Array.isArray(value.requirementIds) ||
                value.requirementIds.length === 0 ||
                new Set(value.requirementIds).size !==
                    value.requirementIds.length) {
                fail('lifecycle-requirement-inventory-incomplete')
            }
            hash(value.sourceCoverageDigest,
                'lifecycle-requirement-source-coverage-required')
            hash(value.semanticProposalDigest,
                'lifecycle-requirement-semantic-proposal-required')
        }
    }),
    acceptanceContract: artifact({
        schema: 'issue-orchestration.issue-acceptance-contract.v1',
        digestField: 'contractDigest',
        producerAuthority: 'deterministic-acceptance-compiler',
        validator: 'compileIssueAcceptanceContract',
        evidence: (value) => {
            commonEvidence(value, 'acceptance-contract')
            if (!Array.isArray(value.acceptanceIds) ||
                value.acceptanceIds.length === 0 ||
                new Set(value.acceptanceIds).size !==
                    value.acceptanceIds.length) {
                fail('lifecycle-acceptance-contract-incomplete')
            }
            hash(value.requirementInventoryDigest,
                'lifecycle-acceptance-inventory-required')
            hash(value.sourceCoverageDigest,
                'lifecycle-acceptance-source-coverage-required')
        }
    }),
    nodeDiscovered: artifact({
        schema: 'issue-orchestration.node-discovered-receipt.v1',
        producerAuthority: 'deterministic-cold-start-compiler',
        validator: 'verifyNodeDiscoveredReceipt',
        evidence: (value) => {
            commonEvidence(value, 'node-discovered')
            hash(value.semanticProposalDigest,
                'lifecycle-discovered-semantic-required')
            hash(value.requirementInventoryDigest,
                'lifecycle-discovered-inventory-required')
            hash(value.acceptanceContractDigest,
                'lifecycle-discovered-acceptance-required')
        }
    }),
    documentationRequirement: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'deterministic-acceptance-compiler',
        validator: 'validateWorkPlanAcceptanceContract',
        evidence: (value) => {
            commonEvidence(value, 'documentation-requirement')
            boolean(value.required,
                'lifecycle-documentation-required-boolean')
            hash(value.acceptanceContractDigest,
                'lifecycle-documentation-acceptance-required')
        }
    })
})

const PLANNING_ARTIFACTS = Object.freeze({
    planningAttempt: artifact({
        schema:
            'issue-orchestration.test-contract-plan-receipt.v1',
        producerAuthority: 'test-owner',
        actorAuthored: true,
        validator: 'verifyTestContractPlanReceipt',
        evidence: (value) => {
            commonEvidence(value, 'planning-attempt')
            text(value.attemptId,
                'lifecycle-planning-attempt-id-required')
            if (!Array.isArray(value.testPaths) ||
                value.testPaths.length === 0 ||
                !Array.isArray(value.commands) ||
                value.commands.length === 0) {
                fail('lifecycle-planning-test-contract-required')
            }
            hash(value.mutationPostconditionReceiptDigest,
                'lifecycle-planning-mutation-required')
        }
    }),
    dispatchInvestigation: artifact({
        schema:
            'issue-orchestration.dispatch-investigation.v1',
        producerAuthority: 'test-owner',
        actorAuthored: true,
        validator: 'validateDispatchInvestigationProjection',
        evidence: (value) => {
            commonEvidence(value, 'dispatch-investigation')
            hash(value.planningAttemptDigest,
                'lifecycle-dispatch-investigation-attempt-required')
            hash(value.repositoryEvidenceDigest,
                'lifecycle-dispatch-investigation-repository-required')
        }
    }),
    slicePlan: artifact({
        schema: 'issue-orchestration.slice-plan-proposal.v1',
        digestField: 'proposalDigest',
        producerAuthority: 'test-owner',
        actorAuthored: true,
        validator: 'compileSlicePlanValidation',
        evidence: (value) => {
            commonEvidence(value, 'slice-plan')
            if (!Array.isArray(value.sliceIds) ||
                value.sliceIds.length === 0 ||
                new Set(value.sliceIds).size !== value.sliceIds.length) {
                fail('lifecycle-slice-plan-required')
            }
            hash(value.planningAttemptDigest,
                'lifecycle-slice-plan-attempt-required')
        }
    }),
    slicePlanValidation: artifact({
        schema:
            'issue-orchestration.slice-plan-validation-verification.v1',
        producerAuthority: 'deterministic-slice-plan-validator',
        validator: 'verifySlicePlanValidation',
        evidence: (value) => {
            commonEvidence(value, 'slice-plan-validation')
            hash(value.slicePlanProposalDigest,
                'lifecycle-slice-plan-validation-proposal-required')
            if (value.status !== 'verified' ||
                !Array.isArray(value.violations) ||
                value.violations.length !== 0) {
                fail('lifecycle-slice-plan-validation-failed')
            }
        }
    }),
    workPlan: artifact({
        schema: 'issue-orchestration.stage-work-plan.v1',
        digestField: 'workPlanDigest',
        producerAuthority: 'stage-work-plan-compiler',
        validator: 'validatePreWriterStageWorkPlan',
        evidence: (value) => {
            commonEvidence(value, 'work-plan')
            hash(value.acceptanceContractDigest,
                'lifecycle-work-plan-acceptance-required')
            hash(value.slicePlanValidationDigest,
                'lifecycle-work-plan-slice-validation-required')
            text(value.currentSliceId,
                'lifecycle-work-plan-current-slice-required')
        }
    }),
    executableSlice: artifact({
        schema: 'issue-orchestration.executable-slice.v1',
        digestField: 'sliceDigest',
        producerAuthority: 'executable-slice-compiler',
        validator: 'validatePreWriterExecutableSlice',
        evidence: (value) => {
            commonEvidence(value, 'executable-slice')
            hash(value.workPlanDigest,
                'lifecycle-executable-slice-plan-required')
            text(value.sliceId,
                'lifecycle-executable-slice-id-required')
            if (!Array.isArray(value.allowedPaths) ||
                value.allowedPaths.length === 0) {
                fail('lifecycle-executable-slice-allowlist-required')
            }
        }
    }),
    routeBinding: artifact({
        schema:
            'issue-orchestration.execution-route-decision.v2',
        digestField: 'routeDecisionDigest',
        producerAuthority: 'canonical-route-cell-compiler',
        validator: 'validateExecutionRouteDecision',
        evidence: (value) => {
            commonEvidence(value, 'route-decision')
            text(value.selectedProfile,
                'lifecycle-route-profile-required')
            text(value.stageRole,
                'lifecycle-route-role-required')
            text(value.stagePhase,
                'lifecycle-route-phase-required')
            hash(value.policyDigest,
                'lifecycle-route-policy-required')
        }
    }),
    compiledPrompt: artifact({
        schema:
            'issue-orchestration.compiled-dispatch-prompt.v1',
        digestField: 'promptDigest',
        producerAuthority: 'compiled-dispatch-prompt-validator',
        validator: 'validatePreWriterCompiledDispatchPrompt',
        evidence: (value) => {
            commonEvidence(value, 'compiled-prompt')
            hash(value.workPlanDigest,
                'lifecycle-prompt-plan-required')
            hash(value.executableSliceDigest,
                'lifecycle-prompt-slice-required')
            hash(value.routeDecisionDigest,
                'lifecycle-prompt-route-required')
            hash(value.promptContentDigest,
                'lifecycle-prompt-content-required')
            if (value.fullIssueIncluded === true ||
                value.fullDagIncluded === true ||
                value.stateRootIncluded === true) {
                fail('lifecycle-prompt-authority-leak')
            }
        }
    }),
    resourceAcquisition: artifact({
        schema: 'issue-orchestration.resource-registry.v1',
        producerAuthority: 'resource-lifecycle-registry',
        validator: 'createResourceRegistry',
        evidence: (value) => {
            commonEvidence(value, 'resource-acquisition')
            text(value.resourceId,
                'lifecycle-resource-id-required')
            hash(value.resourceIdentityDigest,
                'lifecycle-resource-identity-required')
            hash(value.leaseDigest,
                'lifecycle-resource-lease-required')
            if ((value.writeLeaseAcquired !== undefined &&
                    value.writeLeaseAcquired !== false) ||
                value.registry?.writeLease !== undefined) {
                fail('lifecycle-prewriter-write-lease-forbidden')
            }
        }
    }),
    runtimeBinding: COMMON.runtimeBinding,
    mutationPostcondition: COMMON.mutationPostcondition
})

const TEST_WRITER_ARTIFACTS = Object.freeze({
    dispatchReceipt: COMMON.dispatchReceipt,
    runtimeBinding: COMMON.runtimeBinding,
    watchdog: COMMON.watchdog,
    checkpointVerification: COMMON.checkpointVerification,
    sliceTerminal: COMMON.sliceTerminal,
    testContractWriter: artifact({
        schema:
            'issue-orchestration.test-contract-freeze-receipt.v1',
        producerAuthority: 'test-contract-freeze-validator',
        validator: 'authorizeReceiptTransition',
        evidence: (value) => {
            commonEvidence(value, 'test-contract-writer')
            hash(value.testDeltaDigest,
                'lifecycle-test-contract-delta-required')
            hash(value.commandEvidenceDigest,
                'lifecycle-test-contract-command-required')
            hash(value.checkpointVerificationDigest,
                'lifecycle-test-contract-checkpoint-required')
            if (!Array.isArray(value.changedPaths) ||
                value.changedPaths.length === 0 ||
                value.changedPaths.some((item) =>
                    typeof item !== 'string' ||
                    !item.startsWith('tests/'))) {
                fail('lifecycle-test-contract-paths-invalid')
            }
        }
    }),
    mutationPostcondition: COMMON.mutationPostcondition
})

const IMPLEMENTATION_SUCCESS_ARTIFACTS = Object.freeze({
    dispatchReceipt: COMMON.dispatchReceipt,
    runtimeBinding: COMMON.runtimeBinding,
    watchdog: COMMON.watchdog,
    checkpointVerification: COMMON.checkpointVerification,
    sliceTerminal: COMMON.sliceTerminal,
    implementationTerminal: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'implementation-terminal-validator',
        validator: 'authorizeReceiptTransition',
        evidence: (value) => {
            commonEvidence(value, 'implementation-terminal')
            sha(value.candidateSha,
                'lifecycle-implementation-candidate-required')
            hash(value.candidateTreeDigest,
                'lifecycle-implementation-tree-required')
            hash(value.candidateDiffDigest,
                'lifecycle-implementation-diff-required')
            hash(value.gitDeltaDigest,
                'lifecycle-implementation-delta-required')
            hash(value.commandEvidenceDigest,
                'lifecycle-implementation-command-required')
            hash(value.checkpointVerificationDigest,
                'lifecycle-implementation-checkpoint-required')
            if (!Array.isArray(value.changedPaths) ||
                value.changedPaths.length === 0) {
                fail('lifecycle-implementation-paths-required')
            }
        }
    }),
    candidate: artifact({
        schema: 'issue-orchestration.candidate-identity.v1',
        producerAuthority: 'candidate-identity-validator',
        validator: 'authorizeReceiptTransition',
        evidence: (value) => {
            commonEvidence(value, 'candidate')
            sha(value.candidateSha,
                'lifecycle-candidate-sha-required')
            hash(value.candidateTreeDigest,
                'lifecycle-candidate-tree-required')
            hash(value.candidateDiffDigest,
                'lifecycle-candidate-diff-required')
            hash(value.commandEvidenceDigest,
                'lifecycle-candidate-command-evidence-required')
            hash(value.checkpointVerificationDigest,
                'lifecycle-candidate-checkpoint-required')
            text(value.writerInvocationId,
                'lifecycle-candidate-writer-required')
        }
    }),
    mutationPostcondition: COMMON.mutationPostcondition
})

const IMPLEMENTATION_FAILURE_ARTIFACTS = Object.freeze({
    dispatchReceipt: COMMON.dispatchReceipt,
    runtimeBinding: COMMON.runtimeBinding,
    watchdog: COMMON.watchdog,
    checkpointVerification: COMMON.checkpointVerification,
    writerFailure: artifact({
        schema:
            'issue-orchestration.writer-stage-failure-receipt.v1',
        producerAuthority: 'writer-stage-observation-validator',
        validator: 'evaluateWriterStageObservation',
        evidence: (value) => {
            commonEvidence(value, 'writer-failure')
            text(value.failureCode,
                'lifecycle-writer-failure-code-required')
            hash(value.firstFailureDigest,
                'lifecycle-first-failure-required')
            hash(value.traceDigest,
                'lifecycle-writer-failure-trace-required')
            if (value.recoverable !== true) {
                fail('lifecycle-writer-failure-not-recoverable')
            }
        }
    }),
    retryAuthorization: artifact({
        schema:
            'issue-orchestration.writer-stage-retry-authorization.v1',
        producerAuthority: 'writer-stage-retry-authority',
        validator: 'validateSealedWriterStageRetryAuthorization',
        evidence: (value) => {
            commonEvidence(value, 'retry-authorization')
            hash(value.writerFailureDigest,
                'lifecycle-retry-failure-required')
            hash(value.firstFailureDigest,
                'lifecycle-retry-first-failure-required')
            hash(value.revisionEvidenceDigest,
                'lifecycle-retry-revision-required')
            if (value.status !== 'authorized') {
                fail('lifecycle-retry-not-authorized')
            }
        }
    }),
    mutationPostcondition: COMMON.mutationPostcondition
})


const WRITER_FAILURE_EVENT_TYPES = new Set([
    'writer-stage.invocation-failed',
    'writer-stage.environment-failed',
    'writer-stage.runtime-capability-missing',
    'writer-stage.first-action-not-executed',
    'writer-stage.output-missing',
    'writer-stage.checkpoint-missing',
    'writer-stage.receipt-rejected'
])

function nullableHash(value, code) {
    if (value === null) return null
    return hash(value, code)
}

const WRITER_TERMINAL_FAILURE_ARTIFACTS = Object.freeze({
    executorFailure: artifact({
        schema:
            'issue-orchestration.actor-stage-failure-evidence.v1',
        producerAuthority: 'executor-failure-admission',
        validator: 'evaluateWriterStageObservation',
        evidence: (value) => {
            exactKeys(value, [
                'family', 'eventType', 'actorId', 'stageWorkPlan',
                'currentSlice', 'compiledPrompt', 'currentCheckpoint',
                'writerStageObservation', 'failureReceipt',
                'runtimeObservationDigest', 'watchdogReceiptDigest',
                'cleanMutationPostconditionDigest'
            ], 'lifecycle-writer-terminal-failure-fields-invalid')
            if (value.family !== 'writer-stage-failure' ||
                !WRITER_FAILURE_EVENT_TYPES.has(value.eventType)) {
                fail('lifecycle-writer-terminal-failure-family-invalid')
            }
            text(value.actorId,
                'lifecycle-writer-terminal-failure-actor-invalid')
            evidenceObject(value.stageWorkPlan,
                'lifecycle-writer-terminal-failure-plan-invalid')
            evidenceObject(value.currentSlice,
                'lifecycle-writer-terminal-failure-slice-invalid')
            evidenceObject(value.compiledPrompt,
                'lifecycle-writer-terminal-failure-prompt-invalid')
            if (value.currentCheckpoint !== null) {
                evidenceObject(value.currentCheckpoint,
                    'lifecycle-writer-terminal-failure-checkpoint-invalid')
            }
            const observation = evidenceObject(
                value.writerStageObservation,
                'lifecycle-writer-terminal-failure-observation-invalid'
            )
            const failureReceipt = evidenceObject(
                value.failureReceipt,
                'lifecycle-writer-terminal-failure-receipt-invalid'
            )
            let evaluated
            try {
                evaluated = evaluateWriterStageObservation(observation)
            } catch (error) {
                fail('lifecycle-writer-terminal-failure-observation-invalid', {
                    cause: error?.message
                })
            }
            if (evaluated.status !== 'failed' ||
                evaluated.eventType !== value.eventType ||
                !sameValue(evaluated.failureReceipt, failureReceipt) ||
                failureReceipt.status !== 'terminal' ||
                failureReceipt.authorityStatus !== 'active-writer' ||
                failureReceipt.breakerOpen !== true ||
                !sameValue(observation.checkpoint ?? null,
                    value.currentCheckpoint ?? null)) {
                fail('lifecycle-writer-terminal-failure-receipt-invalid')
            }
            hash(value.runtimeObservationDigest,
                'lifecycle-writer-terminal-failure-runtime-invalid')
            nullableHash(value.watchdogReceiptDigest,
                'lifecycle-writer-terminal-failure-watchdog-invalid')
            hash(value.cleanMutationPostconditionDigest,
                'lifecycle-writer-terminal-failure-mutation-invalid')
        }
    }),
    mutationPostcondition: COMMON.mutationPostcondition
})

const BEHAVIOR_REJECTION_ARTIFACTS = Object.freeze({
    verificationRejection: artifact({
        schema:
            'issue-orchestration.independent-verification-rejection.v1',
        producerAuthority: 'behavior-rejection-validator',
        validator: 'validateIndependentVerificationRejection',
        evidence: (value) => {
            exactKeys(value, [
                'candidateSha', 'continuationAttemptId', 'firstFailure',
                'implementationOwnerActorId', 'reworkCount',
                'impactEvidenceDigest', 'verifierInvocationId',
                'freshContext', 'independent'
            ], 'lifecycle-behavior-rejection-fields-invalid')
            sha(value.candidateSha,
                'lifecycle-behavior-rejection-candidate-invalid')
            text(value.continuationAttemptId,
                'lifecycle-behavior-rejection-attempt-invalid')
            const firstFailure = evidenceObject(
                value.firstFailure,
                'lifecycle-behavior-rejection-first-failure-invalid'
            )
            exactKeys(firstFailure, [
                'classification', 'evidenceRef', 'signature'
            ], 'lifecycle-behavior-rejection-first-failure-fields-invalid')
            text(firstFailure.classification,
                'lifecycle-behavior-rejection-classification-invalid')
            text(firstFailure.evidenceRef,
                'lifecycle-behavior-rejection-evidence-ref-invalid')
            text(firstFailure.signature,
                'lifecycle-behavior-rejection-signature-invalid')
            text(value.implementationOwnerActorId,
                'lifecycle-behavior-rejection-owner-invalid')
            integer(value.reworkCount,
                'lifecycle-behavior-rejection-rework-invalid', { min: 1 })
            hash(value.impactEvidenceDigest,
                'lifecycle-behavior-rejection-impact-invalid')
            text(value.verifierInvocationId,
                'lifecycle-behavior-rejection-verifier-invalid')
            if (value.freshContext !== true || value.independent !== true) {
                fail('lifecycle-behavior-rejection-independent-invalid')
            }
        }
    }),
    runtimeBinding: COMMON.runtimeBinding,
    mutationPostcondition: COMMON.mutationPostcondition
})

const BEHAVIOR_ARTIFACTS = Object.freeze({
    behavior: artifact({
        schema: 'issue-orchestration.behavior-receipt.v3',
        producerAuthority: 'behavior-receipt-compiler',
        validator: 'verifyBehaviorReceiptV3',
        evidence: (value) => {
            commonEvidence(value, 'behavior')
            sha(value.candidateSha,
                'lifecycle-behavior-candidate-required')
            hash(value.commandEvidenceDigest,
                'lifecycle-behavior-command-required')
            hash(value.frozenTestContractDigest,
                'lifecycle-behavior-test-contract-required')
            text(value.verifierInvocationId,
                'lifecycle-behavior-verifier-required')
            if (value.freshContext !== true ||
                value.independent !== true) {
                fail('lifecycle-behavior-independent-evidence-required')
            }
        }
    }),
    behaviorVerification: artifact({
        schema:
            'issue-orchestration.behavior-receipt-verification.v3',
        producerAuthority: 'behavior-receipt-verifier',
        validator: 'verifyBehaviorReceiptV3',
        evidence: (value) => {
            commonEvidence(value, 'behavior-verification')
            hash(value.behaviorReceiptDigest,
                'lifecycle-behavior-verification-receipt-required')
            sha(value.candidateSha,
                'lifecycle-behavior-verification-candidate-required')
            if (value.status !== 'verified') {
                fail('lifecycle-behavior-verification-not-verified')
            }
        }
    }),
    runtimeBinding: COMMON.runtimeBinding,
    mutationPostcondition: COMMON.mutationPostcondition
})

const UI_ADJUDICATION_ARTIFACTS = Object.freeze({
    uiAdjudication: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'ui-system-adjudication-validator',
        validator: 'validateDagProposalAcceptance',
        evidence: (value) => {
            commonEvidence(value, 'ui-adjudication')
            if (![
                'bounded-ui-contract-confirmed',
                'bounded-ui-contract-rejected',
                'human-decision-required'
            ].includes(value.adjudication)) {
                fail('lifecycle-ui-adjudication-vocabulary')
            }
            hash(value.candidateDigest,
                'lifecycle-ui-adjudication-candidate-required')
            hash(value.acceptanceContractDigest,
                'lifecycle-ui-adjudication-acceptance-required')
            if (value.scopeEdited === true ||
                value.acceptanceEdited === true ||
                value.routingEdited === true) {
                fail('lifecycle-ui-adjudication-authority-exceeded')
            }
        }
    }),
    runtimeBinding: COMMON.runtimeBinding,
    mutationPostcondition: COMMON.mutationPostcondition
})

const UX_ARTIFACTS = Object.freeze({
    uxAcceptance: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'ux-acceptance-validator',
        validator: 'acceptStageResult',
        evidence: (value) => {
            commonEvidence(value, 'ux-acceptance')
            sha(value.candidateSha,
                'lifecycle-ux-candidate-required')
            hash(value.uiAdjudicationDigest,
                'lifecycle-ux-adjudication-required')
            hash(value.renderEvidenceDigest,
                'lifecycle-ux-render-required')
            hash(value.interactionEvidenceDigest,
                'lifecycle-ux-interaction-required')
            hash(value.accessibilityEvidenceDigest,
                'lifecycle-ux-accessibility-required')
            if (value.status !== 'accepted') {
                fail('lifecycle-ux-not-accepted')
            }
        }
    }),
    renderEvidence: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'ux-render-observer',
        validator: 'acceptStageResult',
        evidence: (value) => {
            commonEvidence(value, 'ux-render')
            hash(value.screenshotSetDigest,
                'lifecycle-ux-screenshot-evidence-required')
            if (!Array.isArray(value.viewports) ||
                value.viewports.length === 0) {
                fail('lifecycle-ux-viewports-required')
            }
        }
    }),
    interactionEvidence: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'ux-interaction-observer',
        validator: 'acceptStageResult',
        evidence: (value) => {
            commonEvidence(value, 'ux-interaction')
            hash(value.traceDigest,
                'lifecycle-ux-interaction-trace-required')
            integer(value.assertionCount,
                'lifecycle-ux-interaction-assertions-required',
                { min: 1 })
        }
    }),
    accessibilityEvidence: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'ux-accessibility-observer',
        validator: 'acceptStageResult',
        evidence: (value) => {
            commonEvidence(value, 'ux-accessibility')
            hash(value.auditDigest,
                'lifecycle-ux-accessibility-audit-required')
            if (!Array.isArray(value.violations) ||
                value.violations.length !== 0) {
                fail('lifecycle-ux-accessibility-violations')
            }
        }
    }),
    runtimeBinding: COMMON.runtimeBinding,
    mutationPostcondition: COMMON.mutationPostcondition
})

const DOCUMENTATION_CHANGE_ARTIFACTS = Object.freeze({
    dispatchReceipt: COMMON.dispatchReceipt,
    runtimeBinding: COMMON.runtimeBinding,
    watchdog: COMMON.watchdog,
    checkpointVerification: COMMON.checkpointVerification,
    sliceTerminal: COMMON.sliceTerminal,
    documentation: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'documentation-terminal-validator',
        validator: 'authorizeReceiptTransition',
        evidence: (value) => {
            commonEvidence(value, 'documentation')
            if (value.mode !== 'changed' ||
                !Array.isArray(value.changedPaths) ||
                value.changedPaths.length === 0) {
                fail('lifecycle-documentation-change-evidence-required')
            }
            hash(value.documentationDeltaDigest,
                'lifecycle-documentation-delta-required')
            hash(value.commandEvidenceDigest,
                'lifecycle-documentation-command-required')
        }
    }),
    mutationPostcondition: COMMON.mutationPostcondition
})

const DOCUMENTATION_INSPECTION_RUNTIME = artifact({
    schema:
        'issue-orchestration.runtime-inspection-binding.v1',
    digestField: 'bindingDigest',
    producerAuthority: 'runtime-inspection-binding-validator',
    validator: 'validateRuntimeInspectionBinding',
    evidence: (value) => {
        commonEvidence(value, 'runtime-inspection-binding')
        text(value.actorInvocationId,
            'lifecycle-runtime-inspection-invocation-required')
        text(value.actorSessionId,
            'lifecycle-runtime-inspection-session-required')
        text(value.runtimeId,
            'lifecycle-runtime-inspection-runtime-required')
        text(value.runtimeVersion,
            'lifecycle-runtime-inspection-version-required')
        text(value.effectiveBackend,
            'lifecycle-runtime-inspection-backend-required')
        text(value.effectivePermissionProfile,
            'lifecycle-runtime-inspection-permission-required')
        hash(value.executionObservationDigest,
            'lifecycle-runtime-inspection-observation-required')
        hash(value.repositoryInspectionDigest,
            'lifecycle-runtime-inspection-repository-required')
        if (value.inspectionKind !== 'documentation-no-change' ||
            value.executionClass !== 'observe-only' ||
            value.writerSpawned !== false ||
            value.writeLeaseAcquired !== false) {
            fail('lifecycle-runtime-inspection-authority-exceeded')
        }
    }
})

const DOCUMENTATION_NO_CHANGE_ARTIFACTS = Object.freeze({
    runtimeBinding: DOCUMENTATION_INSPECTION_RUNTIME,
    documentation: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'documentation-terminal-validator',
        validator: 'authorizeReceiptTransition',
        evidence: (value) => {
            commonEvidence(value, 'documentation')
            if (value.mode !== 'no-change') {
                fail('lifecycle-documentation-no-change-mode-required')
            }
            hash(value.acceptanceContractDigest,
                'lifecycle-documentation-no-change-acceptance-required')
            hash(value.repositoryInspectionDigest,
                'lifecycle-documentation-no-change-inspection-required')
        }
    }),
    documentationNoChange: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'documentation-no-change-verifier',
        validator: 'authorizeReceiptTransition',
        evidence: (value) => {
            commonEvidence(value, 'documentation-no-change')
            hash(value.documentationReceiptDigest,
                'lifecycle-documentation-no-change-receipt-required')
            if (value.status !== 'verified') {
                fail('lifecycle-documentation-no-change-not-verified')
            }
        }
    }),
    mutationPostcondition: COMMON.mutationPostcondition
})

const DELIVERY_COMMON = Object.freeze({
    deliveryControl: artifact({
        schema:
            'issue-orchestration.delivery-control-receipt.v1',
        producerAuthority: 'remote-mutation-authority',
        validator: 'compileDeliveryControlReceipt',
        evidence: (value) => {
            commonEvidence(value, 'delivery-control')
            text(value.effectId,
                'lifecycle-delivery-effect-id-required')
            hash(value.preRemoteSnapshotDigest,
                'lifecycle-delivery-pre-snapshot-required')
            hash(value.expectedPostStateDigest,
                'lifecycle-delivery-expected-post-state-required')
            if (value.status !== 'authorized') {
                fail('lifecycle-delivery-control-not-authorized')
            }
        }
    }),
    remoteMutationAuthority: artifact({
        schema:
            'issue-orchestration.remote-mutation-receipt.v1',
        producerAuthority: 'remote-mutation-authority',
        validator: 'observeRemoteMutation',
        evidence: (value) => {
            commonEvidence(value, 'remote-mutation')
            text(value.effectId,
                'lifecycle-remote-mutation-effect-required')
            hash(value.deliveryControlReceiptDigest,
                'lifecycle-remote-mutation-control-required')
            hash(value.preRemoteSnapshotDigest,
                'lifecycle-remote-mutation-pre-required')
            hash(value.postRemoteSnapshotDigest,
                'lifecycle-remote-mutation-post-required')
            if (value.status !== 'verified') {
                fail('lifecycle-remote-mutation-not-verified')
            }
        }
    }),
    remotePreSnapshot: artifact({
        schema: 'issue-orchestration.remote-state-snapshot.v1',
        digestField: 'snapshotDigest',
        producerAuthority: 'trusted-remote-observer',
        validator: 'validateRemoteStateSnapshot',
        evidence: (value) => {
            commonEvidence(value, 'remote-pre-snapshot')
            hash(value.remoteStateDigest,
                'lifecycle-remote-pre-state-required')
            if (value.snapshotKind !== 'pre-mutation') {
                fail('lifecycle-remote-pre-snapshot-kind')
            }
        }
    }),
    remotePostSnapshot: artifact({
        schema: 'issue-orchestration.remote-state-snapshot.v1',
        digestField: 'snapshotDigest',
        producerAuthority: 'trusted-remote-observer',
        validator: 'validateRemoteStateSnapshot',
        evidence: (value) => {
            commonEvidence(value, 'remote-post-snapshot')
            hash(value.remoteStateDigest,
                'lifecycle-remote-post-state-required')
            if (value.snapshotKind !== 'post-mutation') {
                fail('lifecycle-remote-post-snapshot-kind')
            }
        }
    }),
    remoteEffect: artifact({
        schema: 'issue-orchestration.delivery-evidence.v1',
        producerAuthority: 'delivery-effect-observer',
        validator: 'observeRemoteMutation',
        evidence: (value) => {
            commonEvidence(value, 'remote-effect')
            text(value.effectId,
                'lifecycle-remote-effect-id-required')
            if (!value.commits || typeof value.commits !== 'object' ||
                Array.isArray(value.commits) ||
                Object.keys(value.commits).length === 0 ||
                Object.values(value.commits).some((item) =>
                    !SHA.test(item ?? ''))) {
                fail('lifecycle-remote-effect-commits-required')
            }
            hash(value.preRemoteSnapshotDigest,
                'lifecycle-remote-effect-pre-required')
            hash(value.postRemoteSnapshotDigest,
                'lifecycle-remote-effect-post-required')
        }
    })
})

const DELIVERY_OBSERVED_ARTIFACTS = DELIVERY_COMMON
const DELIVERY_COMPLETED_ARTIFACTS = Object.freeze({
    ...DELIVERY_COMMON,
    deliveryAttempt: artifact({
        schema: 'issue-orchestration.delivery-evidence.v1',
        producerAuthority: 'repository-landing-lane-validator',
        validator: 'finalizeLanding',
        evidence: (value) => {
            commonEvidence(value, 'delivery-attempt')
            text(value.effectId,
                'lifecycle-delivery-attempt-effect-required')
            hash(value.candidateMappingDigest,
                'lifecycle-delivery-candidate-mapping-required')
            hash(value.landingReceiptDigest,
                'lifecycle-delivery-landing-receipt-required')
        }
    }),
    delivery: artifact({
        schema: 'issue-orchestration.delivery-evidence.v1',
        producerAuthority: 'delivery-completion-validator',
        validator: 'evaluateDeliveryClosure',
        evidence: (value) => {
            commonEvidence(value, 'delivery-completion')
            text(value.effectId,
                'lifecycle-delivery-completion-effect-required')
            hash(value.remoteEffectDigest,
                'lifecycle-delivery-completion-effect-digest-required')
            if (value.status !== 'completed') {
                fail('lifecycle-delivery-not-completed')
            }
        }
    })
})

const CLEANUP_ARTIFACTS = Object.freeze({
    cleanupAuthorization: artifact({
        schema:
            'issue-orchestration.git-resource-cleanup-proposal.v1',
        producerAuthority: 'git-resource-cleanup-authority',
        validator: 'validateGitResourceCleanupProposal',
        evidence: (value) => {
            commonEvidence(value, 'cleanup-authorization')
            hash(value.deliveryReceiptDigest,
                'lifecycle-cleanup-delivery-required')
            hash(value.resourceInventoryDigest,
                'lifecycle-cleanup-inventory-required')
        }
    }),
    gitCleanupVerification: artifact({
        schema:
            'issue-orchestration.git-resource-cleanup-verification.v1',
        producerAuthority: 'git-resource-cleanup-authority',
        validator: 'validateGitResourceCleanupVerification',
        evidence: (value) => {
            commonEvidence(value, 'git-cleanup-verification')
            hash(value.postCleanupObservationDigest,
                'lifecycle-git-cleanup-observation-required')
            hash(value.candidateDispositionDigest,
                'lifecycle-git-cleanup-disposition-required')
            if (value.status !== 'verified' ||
                !Array.isArray(value.violations) ||
                value.violations.length !== 0) {
                fail('lifecycle-git-cleanup-not-verified')
            }
        }
    }),
    resourceCleanup: artifact({
        schema:
            'issue-orchestration.resource-cleanup-receipt.v1',
        producerAuthority: 'resource-lifecycle-cleanup',
        validator: 'verifyCleanupReceipt',
        evidence: (value) => {
            commonEvidence(value, 'resource-cleanup')
            hash(value.inventoryDigest,
                'lifecycle-resource-cleanup-inventory-required')
            if (value.status !== 'verified' ||
                !Array.isArray(value.residualOwnedResources) ||
                value.residualOwnedResources.length !== 0) {
                fail('lifecycle-resource-cleanup-residue')
            }
        }
    }),
    remoteCloseAuthority: artifact({
        schema:
            'issue-orchestration.delivery-control-receipt.v1',
        producerAuthority: 'remote-mutation-authority',
        validator: 'compileDeliveryControlReceipt',
        evidence: (value) => {
            commonEvidence(value, 'remote-close-authority')
            hash(value.cleanupReceiptDigest,
                'lifecycle-close-cleanup-required')
            hash(value.expectedPostStateDigest,
                'lifecycle-close-post-state-required')
            if (value.status !== 'authorized') {
                fail('lifecycle-close-authority-not-authorized')
            }
        }
    }),
    remotePreSnapshot: DELIVERY_COMMON.remotePreSnapshot,
    remotePostSnapshot: DELIVERY_COMMON.remotePostSnapshot,
    cleanup: artifact({
        schema:
            'issue-orchestration.git-resource-cleanup-verification.v1',
        producerAuthority: 'cleanup-finalization-validator',
        validator: 'validateGitResourceCleanupVerification',
        evidence: (value) => {
            commonEvidence(value, 'cleanup')
            hash(value.gitCleanupVerificationDigest,
                'lifecycle-cleanup-git-verification-required')
            hash(value.resourceCleanupReceiptDigest,
                'lifecycle-cleanup-resource-verification-required')
            if (value.status !== 'verified') {
                fail('lifecycle-cleanup-not-verified')
            }
        }
    }),
    closure: artifact({
        schema:
            'issue-orchestration.delivery-closure-result.v1',
        producerAuthority: 'remote-issue-closure-validator',
        validator: 'evaluateDeliveryClosure',
        evidence: (value) => {
            commonEvidence(value, 'closure')
            hash(value.cleanupReceiptDigest,
                'lifecycle-closure-cleanup-required')
            hash(value.remotePreSnapshotDigest,
                'lifecycle-closure-pre-snapshot-required')
            hash(value.remotePostSnapshotDigest,
                'lifecycle-closure-post-snapshot-required')
            if (value.issueState !== 'CLOSED' ||
                value.stateReason !== 'COMPLETED') {
                fail('lifecycle-closure-remote-state-invalid')
            }
        }
    })
})

const TERMINAL_ARTIFACTS = Object.freeze({
    terminal: artifact({
        schema: 'issue-orchestration.terminal-receipt-set.v1',
        producerAuthority: 'terminal-evidence-validator',
        validator: 'evaluateQuiescence',
        evidence: (value) => {
            commonEvidence(value, 'terminal')
            if (value.policyVersion !== TERMINAL_POLICY_VERSION) {
                fail('lifecycle-terminal-policy-version-invalid')
            }
            hash(value.firstFailureDigest,
                'lifecycle-terminal-first-failure-required')
            let validatedEvidence
            let validatedRecovery
            try {
                validatedEvidence = validateTerminalEvidenceSet({
                    policyVersion: value.policyVersion,
                    category: value.category,
                    directEvidence: value.directEvidence
                })
                validatedRecovery = validateTerminalRecoveryExhaustion(
                    value.recoveryExhaustion
                )
            } catch (error) {
                fail('lifecycle-terminal-evidence-invalid', {
                    cause: error?.code ?? error?.message
                })
            }
            if (value.directEvidenceDigest !==
                    validatedEvidence.directEvidenceDigest ||
                value.recoveryExhaustionDigest !==
                    validatedRecovery.recoveryExhaustionDigest ||
                !Array.isArray(value.directEvidenceDigests) ||
                JSON.stringify(value.directEvidenceDigests) !==
                    JSON.stringify(validatedEvidence.directEvidence.map(
                        ({ evidenceDigest }) => evidenceDigest
                    ))) {
                fail('lifecycle-terminal-direct-evidence-required')
            }
            hash(value.terminalObservationDigest,
                'lifecycle-terminal-observation-required')
            hash(value.recoveryObservationDigest,
                'lifecycle-terminal-recovery-observation-required')
            hash(value.retentionInventoryDigest,
                'lifecycle-terminal-retention-inventory-required')
            hash(value.priorLedgerHeadDigest,
                'lifecycle-terminal-ledger-head-required')
            hash(value.nodeProjectionDigest,
                'lifecycle-terminal-node-projection-required')
        }
    }),
    recoveryFingerprint: artifact({
        schema: 'issue-orchestration.completion-evidence.v1',
        producerAuthority: 'terminal-recovery-fingerprint-compiler',
        validator: 'computeQuiescenceDigest',
        evidence: (value) => {
            commonEvidence(value, 'recovery-fingerprint')
            hash(value.observableFingerprint,
                'lifecycle-terminal-recovery-fingerprint-required')
            hash(value.terminalReceiptDigest,
                'lifecycle-terminal-receipt-required')
            hash(value.recoveryObservationDigest,
                'lifecycle-terminal-recovery-observation-required')
            hash(value.retentionInventoryDigest,
                'lifecycle-terminal-recovery-retention-required')
            try {
                validateTerminalRecoveryDomains(value.domainDigests)
            } catch (error) {
                fail('lifecycle-terminal-recovery-domains-required', {
                    cause: error?.code ?? error?.message
                })
            }
        }
    }),
    retentionState: artifact({
        schema:
            'issue-orchestration.quiescence-allowed-retention.v1',
        producerAuthority: 'terminal-retention-validator',
        validator: 'evaluateQuiescence',
        evidence: (value) => {
            commonEvidence(value, 'retention-state')
            hash(value.inventoryDigest,
                'lifecycle-terminal-retention-inventory-required')
            if (!Array.isArray(value.retainedResources) ||
                value.retainedResources.some((resource) =>
                    !resource || typeof resource !== 'object' ||
                    Array.isArray(resource) ||
                    typeof resource.resourceType !== 'string' ||
                    resource.resourceType.length === 0 ||
                    typeof resource.resourceId !== 'string' ||
                    resource.resourceId.length === 0 ||
                    typeof resource.ownerNodeId !== 'string' ||
                    resource.ownerNodeId.length === 0 ||
                    typeof resource.status !== 'string' ||
                    resource.status.length === 0 ||
                    !HASH.test(resource.resourceDigest ?? ''))) {
                fail('lifecycle-terminal-retained-resources-required')
            }
            const resources = [...value.retainedResources].sort(
                (left, right) =>
                    `${left.resourceType}:${left.resourceId}`.localeCompare(
                        `${right.resourceType}:${right.resourceId}`
                    )
            )
            if (new Set(resources.map((resource) =>
                `${resource.resourceType}:${resource.resourceId}`
            )).size !== resources.length ||
                value.inventoryDigest !== digest(resources)) {
                fail('lifecycle-terminal-retention-inventory-invalid')
            }
            hash(value.retentionObservationDigest,
                'lifecycle-terminal-retention-observation-required')
            hash(value.terminalReceiptDigest,
                'lifecycle-terminal-retention-receipt-required')
        }
    })
})

function contract({
    id,
    actionType,
    executorAuthority,
    actorRoles,
    eventType,
    toState,
    artifacts,
    attempt = 'required',
    implementationAttemptDelta = 0,
    deliveryPhase = null
}) {
    return deepFreeze({
        id,
        actionType,
        executorAuthority,
        actorRoles,
        eventType,
        toState,
        artifacts,
        attempt,
        implementationAttemptDelta,
        deliveryPhase
    })
}

const CONTRACTS = Object.freeze([
    contract({
        id: 'semantic-proposal',
        actionType: 'request-semantic-proposal',
        executorAuthority: 'pre-writer-lifecycle-executor',
        actorRoles: ['dag-creator-updater'],
        eventType: 'lifecycle.semantic-proposal-recorded',
        toState: 'discovered',
        artifacts: SEMANTIC_ARTIFACTS
    }),
    contract({
        id: 'acceptance-contract',
        actionType: 'compile-acceptance-contract',
        executorAuthority: 'pre-writer-lifecycle-executor',
        actorRoles: ['acceptance-contract-compiler'],
        eventType: 'lifecycle.acceptance-contract-recorded',
        toState: 'acceptance-frozen',
        artifacts: ACCEPTANCE_ARTIFACTS,
        attempt: 'forbidden'
    }),
    contract({
        id: 'test-contract-planning',
        actionType: 'request-test-contract-planning',
        executorAuthority: 'pre-writer-lifecycle-executor',
        actorRoles: ['test-owner'],
        eventType: 'lifecycle.test-contract-planning-recorded',
        toState: 'test-contracting',
        artifacts: PLANNING_ARTIFACTS
    }),
    contract({
        id: 'test-contract-writer',
        actionType: 'dispatch-test-contract-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['test-owner'],
        eventType: 'lifecycle.test-contract-writer-recorded',
        toState: 'test-contract-frozen',
        artifacts: TEST_WRITER_ARTIFACTS
    }),
    contract({
        id: 'implementation-candidate',
        actionType: 'dispatch-implementation-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['code-implementer', 'ui-ux-implementer'],
        eventType: 'lifecycle.implementation-candidate-recorded',
        toState: 'candidate-green',
        artifacts: IMPLEMENTATION_SUCCESS_ARTIFACTS,
        implementationAttemptDelta: 1
    }),
    contract({
        id: 'implementation-retry',
        actionType: 'dispatch-implementation-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['code-implementer', 'ui-ux-implementer'],
        eventType: 'lifecycle.implementation-retry-recorded',
        toState: 'implementing-self-testing',
        artifacts: IMPLEMENTATION_FAILURE_ARTIFACTS,
        implementationAttemptDelta: 1
    }),
    contract({
        id: 'test-contract-terminal-failure',
        actionType: 'dispatch-test-contract-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['test-owner'],
        eventType: 'lifecycle.writer-stage-failure-recorded',
        toState: 'terminal',
        artifacts: WRITER_TERMINAL_FAILURE_ARTIFACTS
    }),
    contract({
        id: 'implementation-terminal-failure',
        actionType: 'dispatch-implementation-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['code-implementer', 'ui-ux-implementer'],
        eventType: 'lifecycle.writer-stage-failure-recorded',
        toState: 'terminal',
        artifacts: WRITER_TERMINAL_FAILURE_ARTIFACTS,
        implementationAttemptDelta: 1
    }),
    contract({
        id: 'documentation-terminal-failure',
        actionType: 'dispatch-documentation-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['documentation-writer'],
        eventType: 'lifecycle.writer-stage-failure-recorded',
        toState: 'terminal',
        artifacts: WRITER_TERMINAL_FAILURE_ARTIFACTS
    }),
    contract({
        id: 'behavior-rejection',
        actionType: 'dispatch-behavior-verifier',
        executorAuthority: 'observe-only-lifecycle-executor',
        actorRoles: ['test-owner'],
        eventType: 'lifecycle.behavior-rejection-recorded',
        toState: 'implementing-self-testing',
        artifacts: BEHAVIOR_REJECTION_ARTIFACTS
    }),
    contract({
        id: 'behavior-verification',
        actionType: 'dispatch-behavior-verifier',
        executorAuthority: 'observe-only-lifecycle-executor',
        actorRoles: ['test-owner'],
        eventType: 'lifecycle.behavior-recorded',
        toState: 'behavior-green',
        artifacts: BEHAVIOR_ARTIFACTS
    }),
    contract({
        id: 'ui-adjudication',
        actionType: 'request-ui-adjudication',
        executorAuthority: 'observe-only-lifecycle-executor',
        actorRoles: ['ui-system-adjudicator'],
        eventType: 'lifecycle.ui-adjudication-recorded',
        toState: 'behavior-green',
        artifacts: UI_ADJUDICATION_ARTIFACTS
    }),
    contract({
        id: 'ux-acceptance',
        actionType: 'dispatch-ux-acceptance-verifier',
        executorAuthority: 'observe-only-lifecycle-executor',
        actorRoles: ['ux-acceptance-verifier'],
        eventType: 'lifecycle.ux-acceptance-recorded',
        toState: 'ux-accepted',
        artifacts: UX_ARTIFACTS
    }),
    contract({
        id: 'documentation-change',
        actionType: 'dispatch-documentation-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['documentation-writer'],
        eventType: 'lifecycle.documentation-recorded',
        toState: 'documentation-green',
        artifacts: DOCUMENTATION_CHANGE_ARTIFACTS
    }),
    contract({
        id: 'documentation-no-change',
        actionType: 'dispatch-documentation-writer',
        executorAuthority: 'writer-lifecycle-executor',
        actorRoles: ['documentation-writer'],
        eventType: 'lifecycle.documentation-recorded',
        toState: 'documentation-green',
        artifacts: DOCUMENTATION_NO_CHANGE_ARTIFACTS
    }),
    contract({
        id: 'delivery-remote-effect',
        actionType: 'deliver-acceptance-group',
        executorAuthority: 'delivery-lifecycle-executor',
        actorRoles: ['root-delivery-adapter'],
        eventType: null,
        toState: null,
        artifacts: DELIVERY_OBSERVED_ARTIFACTS,
        attempt: 'forbidden',
        deliveryPhase: 'remote-effect-applied'
    }),
    contract({
        id: 'delivery-completed',
        actionType: 'deliver-acceptance-group',
        executorAuthority: 'delivery-lifecycle-executor',
        actorRoles: ['root-delivery-adapter'],
        eventType: 'lifecycle.delivery-recorded',
        toState: 'cleaning',
        artifacts: DELIVERY_COMPLETED_ARTIFACTS,
        attempt: 'forbidden',
        deliveryPhase: 'completed'
    }),
    contract({
        id: 'cleanup-and-closure',
        actionType: 'cleanup-node-resources',
        executorAuthority: 'cleanup-lifecycle-executor',
        actorRoles: ['root-cleanup-adapter'],
        eventType: 'lifecycle.cleanup-recorded',
        toState: 'closed',
        artifacts: CLEANUP_ARTIFACTS,
        attempt: 'forbidden'
    }),
    contract({
        id: 'terminalization',
        actionType: 'terminalize-node',
        executorAuthority: 'terminalization-lifecycle-executor',
        actorRoles: ['root-scheduler'],
        eventType: 'lifecycle.terminal-recorded',
        toState: 'terminal',
        artifacts: TERMINAL_ARTIFACTS,
        attempt: 'forbidden'
    })
])

export const LIFECYCLE_STAGE_ADMISSION_MAP = deepFreeze(
    Object.fromEntries(CONTRACTS.map((item) => [item.id, {
        actionType: item.actionType,
        executorAuthority: item.executorAuthority,
        actorRoles: item.actorRoles,
        eventType: item.eventType,
        artifactSet: Object.fromEntries(Object.entries(item.artifacts)
            .map(([key, spec]) => [key, {
                schema: spec.schema,
                digestField: spec.digestField,
                producerAuthority: spec.producerAuthority,
                actorAuthored: spec.actorAuthored,
                validator: spec.validator
            }]))
    }]))
)

function expectedImplementationRole(node) {
    if (!node || typeof node.uiClass !== 'string') return null
    return node.uiClass === 'ui'
        ? 'ui-ux-implementer'
        : 'code-implementer'
}

function validateResultEnvelope(result, action) {
    evidenceObject(result, 'lifecycle-stage-result-invalid')
    exactKeys(result, [
        'schema', 'producerAuthority', 'rootAuthored',
        'callerAuthored', 'actionDigest', 'actionType', 'nodeId',
        'actorRole', 'attemptId', 'artifacts', 'artifactsDigest',
        'resultDigest'
    ], 'lifecycle-stage-result-fields-invalid')
    if (result.schema !== LIFECYCLE_STAGE_RESULT_SCHEMA ||
        result.rootAuthored !== false ||
        result.callerAuthored !== false ||
        result.actionDigest !== action?.actionDigest ||
        result.actionType !== action?.type ||
        result.nodeId !== (action?.nodeId ?? null) ||
        result.resultDigest !== unsignedDigest(result, 'resultDigest')) {
        fail('lifecycle-stage-result-invalid')
    }
    evidenceObject(result.artifacts, 'lifecycle-stage-artifacts-invalid')
    if (result.artifactsDigest !== digest(result.artifacts)) {
        fail('lifecycle-stage-artifacts-digest-mismatch')
    }
    noForbiddenAuthority(result, 'lifecycle-generic-result-forbidden')
}

function contractForResult(result, action) {
    const keys = Object.keys(result.artifacts).sort()
    const candidates = CONTRACTS.filter((item) =>
        item.actionType === action.type &&
        item.executorAuthority === result.producerAuthority &&
        item.actorRoles.includes(result.actorRole) &&
        sameValue(Object.keys(item.artifacts).sort(), keys))
    if (candidates.length !== 1) {
        fail('lifecycle-stage-artifact-set-invalid', {
            actionType: action.type,
            artifactKeys: keys,
            candidateCount: candidates.length
        })
    }
    return candidates[0]
}

function artifactBinding(action) {
    return Object.freeze({
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        bindings: clone(action.bindings)
    })
}

function validateArtifact(value, key, spec, action) {
    evidenceObject(value, 'lifecycle-stage-artifact-invalid')
    exactKeys(value, [
        'schema', 'artifactKind', 'status', 'producerAuthority',
        'validator', 'rootAuthored', 'actorAuthored',
        'actionDigest', 'lifecycleBindingDigest',
        'evidence', 'evidenceDigest',
        spec.digestField
    ], 'lifecycle-stage-artifact-fields-invalid')
    if (value.schema !== spec.schema ||
        value.artifactKind !== key ||
        value.status !== 'verified' ||
        value.producerAuthority !== spec.producerAuthority ||
        value.validator !== spec.validator ||
        value.rootAuthored !== false ||
        value.actorAuthored !== spec.actorAuthored ||
        value.actionDigest !== action.actionDigest ||
        value.lifecycleBindingDigest !== digest(artifactBinding(action)) ||
        value.evidenceDigest !== digest(value.evidence) ||
        value[spec.digestField] !== unsignedDigest(
            value,
            spec.digestField
        )) {
        fail('lifecycle-stage-artifact-invalid', { artifactKind: key })
    }
    noForbiddenAuthority(
        value,
        'lifecycle-stage-artifact-generic-authority-forbidden'
    )
    spec.evidence(value.evidence)
    return value
}

function digestOf(value, field = null) {
    if (!value || typeof value !== 'object') return null
    if (field) return value[field]
    for (const candidate of [
        'receiptDigest', 'proposalDigest', 'inventoryDigest',
        'contractDigest', 'workPlanDigest', 'sliceDigest',
        'promptDigest', 'routeDecisionDigest', 'bindingDigest',
        'snapshotDigest'
    ]) {
        if (HASH.test(value[candidate] ?? '')) return value[candidate]
    }
    return null
}

function validateCrossArtifactBindings(contract_, artifacts, node, action) {
    const d = (key) => digestOf(
        artifacts[key],
        contract_.artifacts[key]?.digestField
    )
    switch (contract_.id) {
        case 'semantic-proposal':
            if (artifacts.semanticProposalValidation.evidence
                .proposalDigest !== d('semanticProposal') ||
                artifacts.semanticProposalValidation.evidence
                    .sourceFingerprint !==
                artifacts.semanticProposal.evidence.sourceFingerprint ||
                artifacts.semanticProposal.evidence
                    .runtimeExecutionBindingDigest !== d('runtimeBinding')) {
                fail('lifecycle-semantic-artifact-chain-stale')
            }
            break
        case 'acceptance-contract':
            if (artifacts.acceptanceContract.evidence
                .requirementInventoryDigest !== d('requirementInventory') ||
                artifacts.acceptanceContract.evidence
                    .sourceCoverageDigest !==
                artifacts.requirementInventory.evidence.sourceCoverageDigest ||
                artifacts.nodeDiscovered.evidence.semanticProposalDigest !==
                    node?.receipts?.semanticProposal?.proposalDigest ||
                artifacts.nodeDiscovered.evidence
                    .requirementInventoryDigest !== d('requirementInventory') ||
                artifacts.nodeDiscovered.evidence
                    .acceptanceContractDigest !== d('acceptanceContract') ||
                artifacts.documentationRequirement.evidence
                    .acceptanceContractDigest !== d('acceptanceContract')) {
                fail('lifecycle-acceptance-artifact-chain-stale')
            }
            break
        case 'test-contract-planning':
            if (artifacts.planningAttempt.evidence
                .mutationPostconditionReceiptDigest !==
                    d('mutationPostcondition') ||
                artifacts.dispatchInvestigation.evidence
                    .planningAttemptDigest !== d('planningAttempt') ||
                artifacts.slicePlan.evidence.planningAttemptDigest !==
                    d('planningAttempt') ||
                artifacts.slicePlanValidation.evidence
                    .slicePlanProposalDigest !== d('slicePlan') ||
                artifacts.workPlan.evidence.slicePlanValidationDigest !==
                    d('slicePlanValidation') ||
                artifacts.executableSlice.evidence.workPlanDigest !==
                    d('workPlan') ||
                artifacts.compiledPrompt.evidence.workPlanDigest !==
                    d('workPlan') ||
                artifacts.compiledPrompt.evidence.executableSliceDigest !==
                    d('executableSlice') ||
                artifacts.compiledPrompt.evidence.routeDecisionDigest !==
                    d('routeBinding')) {
                fail('lifecycle-planning-artifact-chain-stale')
            }
            break
        case 'test-contract-writer':
            if (artifacts.testContractWriter.evidence
                .checkpointVerificationDigest !==
                    d('checkpointVerification') ||
                artifacts.sliceTerminal.evidence.checkpointDigest !==
                    artifacts.checkpointVerification.evidence
                        .checkpointDigest ||
                artifacts.dispatchReceipt.evidence
                    .runtimeExecutionBindingDigest !== d('runtimeBinding')) {
                fail('lifecycle-test-writer-artifact-chain-stale')
            }
            break
        case 'implementation-candidate':
            if (artifacts.implementationTerminal.evidence
                .checkpointVerificationDigest !==
                    d('checkpointVerification') ||
                artifacts.candidate.evidence.checkpointVerificationDigest !==
                    d('checkpointVerification') ||
                artifacts.candidate.evidence.candidateSha !==
                    artifacts.implementationTerminal.evidence.candidateSha ||
                artifacts.candidate.evidence.candidateTreeDigest !==
                    artifacts.implementationTerminal.evidence
                        .candidateTreeDigest ||
                artifacts.candidate.evidence.candidateDiffDigest !==
                    artifacts.implementationTerminal.evidence
                        .candidateDiffDigest ||
                artifacts.candidate.evidence.commandEvidenceDigest !==
                    artifacts.implementationTerminal.evidence
                        .commandEvidenceDigest ||
                artifacts.dispatchReceipt.evidence
                    .actorInvocationId !==
                    artifacts.candidate.evidence.writerInvocationId ||
                artifacts.dispatchReceipt.evidence
                    .runtimeExecutionBindingDigest !== d('runtimeBinding')) {
                fail('lifecycle-candidate-artifact-chain-stale')
            }
            break
        case 'implementation-retry':
            if (artifacts.retryAuthorization.evidence
                .writerFailureDigest !== d('writerFailure') ||
                artifacts.retryAuthorization.evidence.firstFailureDigest !==
                    artifacts.writerFailure.evidence.firstFailureDigest ||
                artifacts.dispatchReceipt.evidence
                    .runtimeExecutionBindingDigest !== d('runtimeBinding')) {
                fail('lifecycle-retry-artifact-chain-stale')
            }
            break
        case 'test-contract-terminal-failure':
        case 'implementation-terminal-failure':
        case 'documentation-terminal-failure': {
            const failure = artifacts.executorFailure.evidence
            const receipt = failure.failureReceipt
            const observation = failure.writerStageObservation
            if (failure.cleanMutationPostconditionDigest !==
                    d('mutationPostcondition') ||
                receipt.runId !== action.bindings.runId ||
                receipt.repository !== action.bindings.repository ||
                receipt.issue !== action.bindings.issueNumber ||
                receipt.node !== action.nodeId ||
                receipt.baseSha !== action.bindings.baseSha ||
                receipt.stageRole !== failure.stageWorkPlan.stageRole ||
                receipt.stagePhase !== failure.stageWorkPlan.stagePhase ||
                receipt.planDigest !== failure.stageWorkPlan.planDigest ||
                receipt.sliceDigest !== failure.currentSlice.sliceDigest ||
                receipt.compiledPromptDigest !==
                    failure.compiledPrompt.promptDigest ||
                observation.agentId !== failure.actorId ||
                observation.routeDigest !== receipt.routeDigest ||
                failure.runtimeObservationDigest !== digest({
                    invocationObservation:
                        observation.invocationObservation ?? null,
                    environmentObservation:
                        observation.environmentObservation ?? null,
                    runtimeCapabilityObservation:
                        observation.runtimeCapabilityObservation ?? null
                }) ||
                (node?.activeAttemptId &&
                    node.activeAttemptId !== receipt.attemptId) ||
                (node?.activePlanDigest &&
                    node.activePlanDigest !== receipt.planDigest) ||
                (node?.activeSliceDigest &&
                    node.activeSliceDigest !== receipt.sliceDigest) ||
                (node?.activeCompiledPromptDigest &&
                    node.activeCompiledPromptDigest !==
                        receipt.compiledPromptDigest)) {
                fail('lifecycle-writer-terminal-failure-binding-stale')
            }
            break
        }
        case 'behavior-rejection': {
            const rejection = artifacts.verificationRejection.evidence
            const candidate = node?.receipts?.candidate
            if (!candidate ||
                rejection.candidateSha !==
                    candidate.evidence?.candidateSha ||
                rejection.implementationOwnerActorId !==
                    candidate.evidence?.writerInvocationId ||
                rejection.verifierInvocationId ===
                    candidate.evidence?.writerInvocationId ||
                rejection.reworkCount !==
                    (node?.reworkCount ?? 0) + 1 ||
                artifacts.runtimeBinding.evidence.actorInvocationId !==
                    rejection.verifierInvocationId) {
                fail('lifecycle-behavior-rejection-binding-stale')
            }
            break
        }
        case 'behavior-verification': {
            const candidate = node?.receipts?.candidate
            if (!candidate ||
                artifacts.behavior.evidence.candidateSha !==
                    candidate.evidence?.candidateSha ||
                artifacts.behaviorVerification.evidence
                    .behaviorReceiptDigest !== d('behavior') ||
                artifacts.behaviorVerification.evidence.candidateSha !==
                    artifacts.behavior.evidence.candidateSha ||
                artifacts.behavior.evidence.verifierInvocationId ===
                    candidate.evidence?.writerInvocationId) {
                fail('lifecycle-behavior-artifact-chain-stale')
            }
            break
        }
        case 'ui-adjudication':
            if (artifacts.uiAdjudication.evidence.candidateDigest !==
                    digestOf(node?.receipts?.candidate) ||
                artifacts.uiAdjudication.evidence
                    .acceptanceContractDigest !==
                    digestOf(node?.receipts?.acceptanceContract)) {
                fail('lifecycle-ui-artifact-chain-stale')
            }
            break
        case 'ux-acceptance':
            if (artifacts.uxAcceptance.evidence.candidateSha !==
                    node?.receipts?.candidate?.evidence?.candidateSha ||
                artifacts.uxAcceptance.evidence.uiAdjudicationDigest !==
                    digestOf(node?.receipts?.uiAdjudication) ||
                artifacts.uxAcceptance.evidence.renderEvidenceDigest !==
                    d('renderEvidence') ||
                artifacts.uxAcceptance.evidence.interactionEvidenceDigest !==
                    d('interactionEvidence') ||
                artifacts.uxAcceptance.evidence
                    .accessibilityEvidenceDigest !==
                    d('accessibilityEvidence')) {
                fail('lifecycle-ux-artifact-chain-stale')
            }
            break
        case 'documentation-no-change':
            if (artifacts.documentationNoChange.evidence
                .documentationReceiptDigest !== d('documentation')) {
                fail('lifecycle-documentation-artifact-chain-stale')
            }
            break
        case 'delivery-remote-effect':
        case 'delivery-completed': {
            const effectId = artifacts.remoteEffect.evidence.effectId
            if (artifacts.deliveryControl.evidence.effectId !== effectId ||
                artifacts.remoteMutationAuthority.evidence.effectId !==
                    effectId ||
                artifacts.remoteMutationAuthority.evidence
                    .deliveryControlReceiptDigest !== d('deliveryControl') ||
                artifacts.remoteMutationAuthority.evidence
                    .preRemoteSnapshotDigest !== d('remotePreSnapshot') ||
                artifacts.remoteMutationAuthority.evidence
                    .postRemoteSnapshotDigest !== d('remotePostSnapshot') ||
                artifacts.remoteEffect.evidence.preRemoteSnapshotDigest !==
                    d('remotePreSnapshot') ||
                artifacts.remoteEffect.evidence.postRemoteSnapshotDigest !==
                    d('remotePostSnapshot')) {
                fail('lifecycle-delivery-artifact-chain-stale')
            }
            if (contract_.id === 'delivery-completed' &&
                (artifacts.deliveryAttempt.evidence.effectId !== effectId ||
                artifacts.delivery.evidence.effectId !== effectId ||
                artifacts.delivery.evidence.remoteEffectDigest !==
                    d('remoteEffect'))) {
                fail('lifecycle-delivery-completion-chain-stale')
            }
            break
        }
        case 'cleanup-and-closure':
            if (artifacts.cleanup.evidence.gitCleanupVerificationDigest !==
                    d('gitCleanupVerification') ||
                artifacts.cleanup.evidence.resourceCleanupReceiptDigest !==
                    d('resourceCleanup') ||
                artifacts.remoteCloseAuthority.evidence
                    .cleanupReceiptDigest !== d('cleanup') ||
                artifacts.closure.evidence.cleanupReceiptDigest !==
                    d('cleanup') ||
                artifacts.closure.evidence.remotePreSnapshotDigest !==
                    d('remotePreSnapshot') ||
                artifacts.closure.evidence.remotePostSnapshotDigest !==
                    d('remotePostSnapshot')) {
                fail('lifecycle-cleanup-artifact-chain-stale')
            }
            break
        case 'terminalization': {
            const terminal = artifacts.terminal.evidence
            const recovery = artifacts.recoveryFingerprint.evidence
            const retention = artifacts.retentionState.evidence
            const firstFailure = action.bindings.firstFailure ??
                action.bindings.quarantine
            if (recovery.terminalReceiptDigest !== d('terminal') ||
                retention.terminalReceiptDigest !== d('terminal') ||
                recovery.retentionInventoryDigest !==
                    retention.inventoryDigest ||
                terminal.priorLedgerHeadDigest !==
                    action.bindings.priorLedgerHeadDigest ||
                terminal.nodeProjectionDigest !==
                    action.bindings.nodeProjectionDigest ||
                !firstFailure ||
                terminal.firstFailureDigest !== digest(firstFailure) ||
                retention.retainedResources.some((resource) =>
                    resource.ownerNodeId !== action.nodeId)) {
                fail('lifecycle-terminal-artifact-chain-stale')
            }
            let expectedFingerprint
            try {
                expectedFingerprint = compileTerminalRecoveryFingerprint({
                    runId: action.bindings.runId,
                    nodeId: action.nodeId,
                    repository: action.bindings.repository,
                    issueNumber: action.bindings.issueNumber,
                    baseSha: action.bindings.baseSha,
                    nodeEpoch: action.bindings.nodeEpoch,
                    selectorReceiptDigest:
                        action.bindings.selectorReceiptDigest,
                    remoteSnapshotDigest:
                        action.bindings.remoteSnapshotDigest,
                    policyDigest: action.bindings.policyDigest,
                    policySetDigest: action.bindings.policySetDigest,
                    runtimeTrustBindingDigest:
                        action.bindings.runtimeTrustBindingDigest,
                    repositoryBindingDigest:
                        action.bindings.repositoryBindingDigest,
                    category: terminal.category,
                    firstFailureDigest: terminal.firstFailureDigest,
                    directEvidenceDigest:
                        terminal.directEvidenceDigest,
                    recoveryExhaustionDigest:
                        terminal.recoveryExhaustionDigest,
                    domainDigests: recovery.domainDigests,
                    retentionInventoryDigest:
                        retention.inventoryDigest
                })
            } catch (error) {
                fail('lifecycle-terminal-fingerprint-input-invalid', {
                    cause: error?.code ?? error?.message
                })
            }
            if (recovery.observableFingerprint !== expectedFingerprint) {
                fail('lifecycle-terminal-recovery-fingerprint-stale')
            }
            const candidate = action.bindings.terminalCandidate
            if (candidate &&
                (candidate.policyVersion !== terminal.policyVersion ||
                    candidate.category !== terminal.category ||
                    candidate.firstFailureDigest !==
                        terminal.firstFailureDigest ||
                    candidate.directEvidenceDigest !==
                        terminal.directEvidenceDigest ||
                    candidate.recoveryExhaustionDigest !==
                        terminal.recoveryExhaustionDigest ||
                    candidate.recoveryFingerprint !==
                        recovery.observableFingerprint)) {
                fail('lifecycle-terminal-candidate-stale')
            }
            break
        }
        default:
            break
    }
}


function validateSealedPayload(value, {
    schema,
    digestField,
    code,
    status = null
}) {
    evidenceObject(value, code)
    if (value.schema !== schema ||
        (status !== null && value.status !== status) ||
        value[digestField] !== unsignedDigest(value, digestField)) {
        fail(code)
    }
    return value
}

function expectedRequirementInventory(snapshot, proposal) {
    validateSealedPayload(snapshot, {
        schema: 'issue-orchestration.cold-start-issue-snapshot.v1',
        digestField: 'snapshotDigest',
        code: 'lifecycle-semantic-snapshot-invalid'
    })
    try {
        return compileRequirementInventory({
            snapshot,
            proposal,
            rootDecision: {
                action: 'accept',
                proposalDigest: proposal?.proposalDigest,
                modified: false
            }
        })
    } catch (error) {
        fail('lifecycle-semantic-proposal-payload-invalid', {
            cause: error?.code ?? error?.message
        })
    }
}

function expectedAcceptanceContract(snapshot, inventory) {
    try {
        return compileIssueAcceptanceContract({ snapshot, inventory })
    } catch (error) {
        fail('lifecycle-acceptance-contract-payload-invalid', {
            cause: error?.code ?? error?.message
        })
    }
}

function validateSemanticPayloads(artifacts) {
    const evidence = artifacts.semanticProposal.evidence
    const proposalPresent = Object.hasOwn(evidence, 'proposal')
    const snapshotPresent = Object.hasOwn(evidence, 'snapshot')
    if (!proposalPresent && !snapshotPresent) return
    if (!proposalPresent || !snapshotPresent) {
        fail('lifecycle-semantic-payload-incomplete')
    }
    const proposal = evidence.proposal
    const snapshot = evidence.snapshot
    const inventory = expectedRequirementInventory(snapshot, proposal)
    const classifications = proposal.classifications.map((entry) =>
        `${entry.sourceIdentity}:${entry.classification}`)
    if (!sameValue(evidence.classifications, classifications) ||
        evidence.sourceFingerprint !== snapshot.issueSnapshotFingerprint ||
        artifacts.semanticProposalValidation.evidence
            .validationInventoryDigest !== inventory.inventoryDigest) {
        fail('lifecycle-semantic-payload-mismatch')
    }
}

function validateAcceptancePayloads(artifacts, node, action) {
    const nestedFields = [
        Object.hasOwn(artifacts.requirementInventory.evidence, 'inventory'),
        Object.hasOwn(
            artifacts.acceptanceContract.evidence,
            'acceptanceContract'
        ),
        Object.hasOwn(artifacts.nodeDiscovered.evidence, 'receipt'),
        Object.hasOwn(
            artifacts.documentationRequirement.evidence,
            'receipt'
        )
    ]
    if (nestedFields.every((present) => !present)) return
    if (nestedFields.some((present) => !present)) {
        fail('lifecycle-acceptance-payload-incomplete')
    }
    const semantic = node?.receipts?.semanticProposal?.evidence
    const snapshot = semantic?.snapshot
    const proposal = semantic?.proposal
    if (!snapshot || !proposal) {
        fail('lifecycle-acceptance-semantic-history-invalid')
    }
    const expectedInventory = expectedRequirementInventory(snapshot, proposal)
    const inventoryEvidence = artifacts.requirementInventory.evidence
    const inventory = inventoryEvidence.inventory
    if (!sameValue(inventory, expectedInventory) ||
        !sameValue(
            inventoryEvidence.requirementIds,
            expectedInventory.requirements.map(({ requirementId }) =>
                requirementId)
        ) ||
        inventoryEvidence.sourceCoverageDigest !==
            expectedInventory.sourceCoverageDigest) {
        fail('lifecycle-requirement-inventory-payload-mismatch')
    }
    const expectedContract = expectedAcceptanceContract(
        snapshot,
        expectedInventory
    )
    const contractEvidence = artifacts.acceptanceContract.evidence
    const contractPayload = contractEvidence.acceptanceContract
    if (!sameValue(contractPayload, expectedContract) ||
        !sameValue(
            contractEvidence.acceptanceIds,
            expectedContract.executableAcceptanceIds
        ) ||
        contractEvidence.sourceCoverageDigest !==
            expectedInventory.sourceCoverageDigest) {
        fail('lifecycle-acceptance-contract-payload-mismatch')
    }
    const discovered = validateSealedPayload(
        artifacts.nodeDiscovered.evidence.receipt,
        {
            schema: 'issue-orchestration.node-discovered-receipt.v1',
            digestField: 'receiptDigest',
            code: 'lifecycle-node-discovered-payload-invalid',
            status: 'verified'
        }
    )
    if (discovered.runId !== action.bindings.runId ||
        discovered.nodeId !== action.nodeId ||
        discovered.repository !== action.bindings.repository ||
        discovered.issueNumber !== action.bindings.issueNumber ||
        discovered.semanticProposalDigest !== proposal.proposalDigest ||
        discovered.requirementInventoryDigest !==
            expectedInventory.inventoryDigest ||
        discovered.acceptanceContractDigest !==
            expectedContract.contractDigest) {
        fail('lifecycle-node-discovered-payload-invalid')
    }
    const documentation = validateSealedPayload(
        artifacts.documentationRequirement.evidence.receipt,
        {
            schema: 'issue-orchestration.completion-evidence.v1',
            digestField: 'receiptDigest',
            code: 'lifecycle-documentation-requirement-payload-invalid',
            status: 'verified'
        }
    )
    const required = expectedContract.executableAcceptanceIds.length > 0 ||
        expectedContract.constraintIds.length > 0
    if (documentation.required !== required ||
        artifacts.documentationRequirement.evidence.required !== required ||
        documentation.acceptanceContractDigest !==
            expectedContract.contractDigest) {
        fail('lifecycle-documentation-requirement-payload-invalid')
    }
}

function validatePlanningPayloads(artifacts) {
    const nestedFields = [
        [artifacts.planningAttempt, 'receipt'],
        [artifacts.dispatchInvestigation, 'receipt'],
        [artifacts.slicePlan, 'proposal'],
        [artifacts.slicePlanValidation, 'receipt'],
        [artifacts.workPlan, 'plan'],
        [artifacts.executableSlice, 'slice'],
        [artifacts.routeBinding, 'routeDecision'],
        [artifacts.compiledPrompt, 'prompt'],
        [artifacts.resourceAcquisition, 'registry']
    ].map(([artifact, field]) =>
        Object.hasOwn(artifact.evidence, field))
    if (nestedFields.every((present) => !present)) return
    if (nestedFields.some((present) => !present)) {
        fail('lifecycle-planning-payload-incomplete')
    }
    const planning = validateSealedPayload(
        artifacts.planningAttempt.evidence.receipt,
        {
            schema: 'issue-orchestration.test-contract-plan-receipt.v1',
            digestField: 'receiptDigest',
            code: 'lifecycle-planning-receipt-payload-invalid',
            status: 'verified'
        }
    )
    if (!sameValue(
        artifacts.planningAttempt.evidence.testPaths,
        planning.testPaths
    ) || !sameValue(
        artifacts.planningAttempt.evidence.commands,
        planning.commands
    )) {
        fail('lifecycle-planning-receipt-payload-invalid')
    }
    const investigation = validateSealedPayload(
        artifacts.dispatchInvestigation.evidence.receipt,
        {
            schema: 'issue-orchestration.dispatch-investigation.v1',
            digestField: 'receiptDigest',
            code: 'lifecycle-dispatch-investigation-payload-invalid',
            status: 'complete'
        }
    )
    if (investigation.repositoryEvidenceDigest !==
            artifacts.dispatchInvestigation.evidence
                .repositoryEvidenceDigest) {
        fail('lifecycle-dispatch-investigation-payload-invalid')
    }
    const proposal = validateSealedPayload(
        artifacts.slicePlan.evidence.proposal,
        {
            schema: 'issue-orchestration.slice-plan-proposal.v1',
            digestField: 'proposalDigest',
            code: 'lifecycle-slice-plan-payload-invalid'
        }
    )
    if (!sameValue(
        artifacts.slicePlan.evidence.sliceIds,
        proposal.orderedSlices.map(({ sliceId }) => sliceId)
    )) {
        fail('lifecycle-slice-plan-payload-invalid')
    }
    const validation = validateSealedPayload(
        artifacts.slicePlanValidation.evidence.receipt,
        {
            schema:
                'issue-orchestration.slice-plan-validation-receipt.v1',
            digestField: 'validationDigest',
            code: 'lifecycle-slice-plan-validation-payload-invalid',
            status: 'verified'
        }
    )
    if (validation.proposalDigest !== proposal.proposalDigest) {
        fail('lifecycle-slice-plan-validation-payload-invalid')
    }
    const plan = validateSealedPayload(
        artifacts.workPlan.evidence.plan,
        {
            schema: 'issue-orchestration.stage-work-plan.v1',
            digestField: 'planDigest',
            code: 'lifecycle-work-plan-payload-invalid',
            status: 'verified'
        }
    )
    if (plan.contractBindingStatus !== 'pre-writer-verified' ||
        plan.activeWriteLeaseId !== null ||
        plan.resourceLeaseReceiptDigest !== null ||
        plan.frozenStageContract !== null ||
        artifacts.workPlan.evidence.currentSliceId !==
            plan.orderedSlices?.[0]?.sliceId) {
        fail('lifecycle-work-plan-payload-invalid')
    }
    const slice = validateSealedPayload(
        artifacts.executableSlice.evidence.slice,
        {
            schema: 'issue-orchestration.executable-slice.v1',
            digestField: 'sliceDigest',
            code: 'lifecycle-executable-slice-payload-invalid'
        }
    )
    if (slice.planDigest !== plan.planDigest ||
        slice.sliceId !== artifacts.executableSlice.evidence.sliceId ||
        !sameValue(slice.allowedPaths,
            artifacts.executableSlice.evidence.allowedPaths)) {
        fail('lifecycle-executable-slice-payload-invalid')
    }
    const route = validateSealedPayload(
        artifacts.routeBinding.evidence.routeDecision,
        {
            schema: 'issue-orchestration.execution-route-decision.v2',
            digestField: 'routeDecisionDigest',
            code: 'lifecycle-route-binding-payload-invalid'
        }
    )
    if (route.selectedProfile !==
            artifacts.routeBinding.evidence.selectedProfile ||
        route.stageRole !== artifacts.routeBinding.evidence.stageRole ||
        route.stagePhase !== artifacts.routeBinding.evidence.stagePhase) {
        fail('lifecycle-route-binding-payload-invalid')
    }
    const prompt = validateSealedPayload(
        artifacts.compiledPrompt.evidence.prompt,
        {
            schema:
                'issue-orchestration.compiled-dispatch-prompt.v1',
            digestField: 'promptDigest',
            code: 'lifecycle-compiled-prompt-payload-invalid'
        }
    )
    if (prompt.planDigest !== plan.planDigest ||
        prompt.sliceDigest !== slice.sliceDigest ||
        artifacts.compiledPrompt.evidence.promptContentDigest !==
            digest(prompt.prompt)) {
        fail('lifecycle-compiled-prompt-payload-invalid')
    }
    const registry = artifacts.resourceAcquisition.evidence.registry
    evidenceObject(registry, 'lifecycle-resource-registry-payload-invalid')
    if (registry.schema !== 'issue-orchestration.resource-registry.v1' ||
        registry.writeLease !== undefined ||
        artifacts.resourceAcquisition.evidence.writeLeaseAcquired !== false) {
        fail('lifecycle-resource-registry-payload-invalid')
    }
}

function validatePreWriterPayloads(contract_, artifacts, node, action) {
    switch (contract_.id) {
        case 'semantic-proposal':
            validateSemanticPayloads(artifacts)
            break
        case 'acceptance-contract':
            validateAcceptancePayloads(artifacts, node, action)
            break
        case 'test-contract-planning':
            validatePlanningPayloads(artifacts)
            break
        default:
            break
    }
}

function validateAttempt(result, contract_) {
    if (contract_.attempt === 'required') {
        text(result.attemptId, 'lifecycle-stage-attempt-required')
    } else if (result.attemptId !== null) {
        fail('lifecycle-stage-attempt-forbidden')
    }
}

function validateActorRole(result, contract_, node) {
    if (!contract_.actorRoles.includes(result.actorRole)) {
        fail('lifecycle-stage-actor-role-invalid')
    }
    const implementationRole = expectedImplementationRole(node)
    if (contract_.actionType === 'dispatch-implementation-writer' &&
        implementationRole && result.actorRole !== implementationRole) {
        fail('lifecycle-stage-implementation-role-invalid')
    }
}

export function validateLifecycleStageResult({
    result,
    action,
    node = null
} = {}) {
    validateResultEnvelope(result, action)
    const contract_ = contractForResult(result, action)
    validateAttempt(result, contract_)
    validateActorRole(result, contract_, node)
    if ([
        'test-contract-terminal-failure',
        'implementation-terminal-failure',
        'documentation-terminal-failure'
    ].includes(contract_.id)) {
        const failure = result.artifacts.executorFailure?.evidence
        if (failure?.failureReceipt?.attemptId !== result.attemptId ||
            failure?.failureReceipt?.stageRole !== result.actorRole ||
            failure?.writerStageObservation?.attemptId !==
                result.attemptId ||
            failure?.writerStageObservation?.stageRole !==
                result.actorRole) {
            fail('lifecycle-writer-terminal-failure-result-stale')
        }
    }
    if (contract_.id === 'behavior-rejection' &&
        result.artifacts.verificationRejection?.evidence
            ?.continuationAttemptId !== result.attemptId) {
        fail('lifecycle-behavior-rejection-result-stale')
    }
    exactKeys(
        result.artifacts,
        Object.keys(contract_.artifacts),
        'lifecycle-stage-artifact-set-invalid'
    )
    for (const [key, spec] of Object.entries(contract_.artifacts)) {
        validateArtifact(result.artifacts[key], key, spec, action)
    }
    validateCrossArtifactBindings(contract_, result.artifacts, node, action)
    validatePreWriterPayloads(
        contract_, result.artifacts, node, action
    )
    return deepFreeze({
        result: clone(result),
        contractId: contract_.id,
        eventType: contract_.eventType,
        toState: contract_.toState,
        implementationAttemptDelta:
            contract_.implementationAttemptDelta,
        deliveryPhase: contract_.deliveryPhase,
        artifacts: clone(result.artifacts)
    })
}

export function lifecycleStageContractForAction({
    actionType,
    artifactKeys
} = {}) {
    const keys = [...(artifactKeys ?? [])].sort()
    const matches = CONTRACTS.filter((item) =>
        item.actionType === actionType &&
        sameValue(Object.keys(item.artifacts).sort(), keys))
    if (matches.length !== 1) {
        fail('lifecycle-stage-contract-not-unique', {
            actionType,
            artifactKeys: keys
        })
    }
    return clone(LIFECYCLE_STAGE_ADMISSION_MAP[matches[0].id])
}
