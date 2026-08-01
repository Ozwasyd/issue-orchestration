#!/usr/bin/env node
// Shared issue-orchestration package runtime.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
    STAGE_MODEL_POOL_POLICY,
    compileStageRoute,
    splitProfile
} from './stage-profile-policy.mjs'
import { verifyCleanupReceipt } from './resource-lifecycle.mjs'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REQUIRED_REQUEST_FIELDS = [
    'schema', 'requestId', 'runId', 'nodeId', 'attemptId', 'role', 'stageRole',
    'requestedByRole', 'promptDigest', 'sourceDagDigest', 'frontierDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'repository', 'baseSha',
    'candidateSha', 'candidateDigest', 'requestedModel', 'requestedEffort',
    'requestedSandbox', 'requestedForkTurns', 'requestedWorkingDirectory',
    'stageProfileDigest', 'testOwnerId', 'testContractDigest', 'epochId',
    'requiredSkills', 'designAuthorityDigests', 'uiImpact', 'behaviorReceiptDigest',
    'uxAcceptanceReceiptDigest', 'documentationReceiptDigest', 'allowedPathsDigest',
    'forbiddenPathsDigest', 'writePolicy', 'groupId', 'groupSessionDigest',
    'memberIssueId', 'memberStage', 'activeWriteLeaseId', 'groupWorktreeIdentity',
    'groupBranchIdentity', 'testOwnerContinuityIdentity',
    'implementerContinuityIdentity', 'freshVerificationRollout',
    'memberTestContractDigest', 'memberCandidateIdentity', 'createdAt'
]

const V2_REQUEST_FIELDS = [
    'schema', 'policyVersion', 'routingPolicyDigest', 'stageRole', 'stagePhase',
    'stageProfileId', 'allowedProfilesDigest', 'defaultProfileId',
    'routingAuthority', 'routingInputDigest', 'selectedProfileReason',
    'selectedProfileId', 'routingClassification', 'routeTransitionFrom',
    'routeTransitionReason', 'requestedByRole', 'requestId', 'runId', 'nodeId',
    'attemptId', 'promptDigest', 'sourceDagDigest', 'frontierDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'scopeIdentityDigest',
    'dependencyIdentityDigest', 'repository', 'baseSha', 'epochId',
    'requestedModel', 'requestedEffort', 'requestedMode', 'requestedSandbox',
    'requestedForkTurns', 'requestedWorkingDirectory', 'requiredSkills',
    'requiredSkillIds', 'requiredSkillDigests', 'designAuthorityDigests',
    'uiImpact', 'allowedPathsDigest', 'forbiddenPathsDigest', 'writePolicy',
    'readOnlyPolicy', 'candidateSha', 'candidateDigest', 'testOwnerId',
    'testContractDigest', 'behaviorReceiptDigest', 'uxAcceptanceReceiptDigest',
    'documentationReceiptDigest', 'groupId', 'groupSessionDigest',
    'memberIssueId', 'memberStage', 'activeWriteLeaseId',
    'groupWorktreeIdentity', 'groupBranchIdentity',
    'testOwnerContinuityIdentity', 'implementerContinuityIdentity',
    'freshVerificationRollout', 'memberTestContractDigest',
    'memberCandidateIdentity', 'createdAt'
]

const V2_WRITE_POLICIES = Object.freeze({
    'root-scheduler:scheduling': 'external-state-root-only',
    'dag-creator-updater:semantic-proposal': 'read-only',
    'test-owner:test-contract': 'test-owner-scoped-write-lease',
    'test-owner:behavior-verification': 'read-only',
    'code-implementer:implementation': 'stage-scoped-write-lease',
    'ui-ux-implementer:implementation': 'stage-scoped-write-lease',
    'ui-system-adjudicator:adjudication': 'read-only',
    'ux-acceptance-verifier:ux-acceptance': 'read-only',
    'documentation-writer:documentation': 'documentation-scoped-write-lease'
})

class ReceiptError extends Error {
    constructor(code, message = code) {
        super(message)
        this.code = code
    }
}

function fail(code) {
    throw new ReceiptError(code)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function unsignedDigest(value, digestField) {
    const unsigned = { ...value }
    delete unsigned[digestField]
    return digest(unsigned)
}

function containsSecret(value) {
    if (Array.isArray(value)) return value.some(containsSecret)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) =>
        /(?:secret|token|password|credential|api[-_]?key|authorization)/iu.test(key) ||
        containsSecret(child))
}

function unique(values) {
    return [...new Set(values)]
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

export function sealCleanupReceipt(receipt) {
    verifyCleanupReceipt(receipt)
    return deepFreeze(structuredClone(receipt))
}

function observationByKind(observations, kind) {
    return observations.find((item) => item?.kind === kind)
}

function trustworthyObservation(item) {
    const trustedSources = new Set([
        'runtime-rollout', 'machine-git-observation', 'runtime-skill-loader',
        'machine-lease-registry'
    ])
    return item && trustedSources.has(item.source) &&
        item.observationDigest === unsignedDigest(item, 'observationDigest')
}

function validateVersionedRoute(input) {
    const classification = input.routingClassification ?? input.classification
    if (!classification || !input.stagePhase) return false
    const route = compileStageRoute({
        ...classification,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        frontierException: input.frontierException,
        requiredSkillDigests: input.requiredSkills.map(({ digest: value }) => value),
        capabilityDigest: input.capabilityDigest
    })
    const requested = splitProfile(route.selectedProfile)
    const writePolicies = {
        'root-scheduler:scheduling': 'external-state-root-only',
        'dag-creator-updater:semantic-proposal': 'read-only',
        'test-owner:test-contract': 'test-owner-scoped-write-lease',
        'test-owner:behavior-verification': 'read-only',
        'code-implementer:implementation': 'stage-scoped-write-lease',
        'ui-ux-implementer:implementation': 'stage-scoped-write-lease',
        'ui-system-adjudicator:adjudication': 'read-only',
        'ux-acceptance-verifier:ux-acceptance': 'read-only',
        'documentation-writer:documentation': 'documentation-scoped-write-lease'
    }
    const actual = [
        input.requestedModel,
        input.requestedEffort,
        input.requestedSandbox,
        input.writePolicy
    ]
    const expected = [
        requested.model,
        requested.effort,
        route.sandbox,
        writePolicies[`${input.stageRole}:${input.stagePhase}`]
    ]
    if (actual.some((value, index) => value !== expected[index])) {
        fail(input.stageRole === 'root-scheduler'
            ? 'dispatch-root-profile-policy'
            : 'dispatch-stage-profile-policy')
    }
    return true
}

function validateV1RequestBoundary(input) {
    const expected = {
        'root-scheduler': [
            'gpt-5.6-sol', 'low', 'read-only', 'external-state-root-only'
        ],
        'dag-creator-updater': [
            'gpt-5.6-sol', 'max', 'read-only', 'read-only'
        ],
        'test-owner': [
            'gpt-5.6-sol', 'max', 'workspace-write',
            'test-owner-scoped-write-lease'
        ],
        'code-implementer': [
            'gpt-5.6-sol', 'low', 'workspace-write',
            'stage-scoped-write-lease'
        ],
        'ui-ux-implementer': [
            'gpt-5.6-sol', 'low', 'workspace-write',
            'stage-scoped-write-lease'
        ],
        'ux-acceptance-verifier': [
            'gpt-5.6-sol', 'max', 'read-only', 'read-only'
        ],
        'documentation-writer': [
            'gpt-5.6-sol', 'low', 'workspace-write',
            'documentation-scoped-write-lease'
        ]
    }[input.stageRole]
    const actual = [
        input.requestedModel,
        input.requestedEffort,
        input.requestedSandbox,
        input.writePolicy
    ]
    if (!expected || actual.some((value, index) => value !== expected[index])) {
        fail(input.stageRole === 'root-scheduler'
            ? 'dispatch-root-profile-policy'
            : 'dispatch-stage-profile-policy')
    }
}

async function sealDispatchRequestV1(input) {
    if (containsSecret(input)) fail('dispatch-secret-material')
    for (const field of REQUIRED_REQUEST_FIELDS) {
        if (!Object.hasOwn(input, field)) fail(
            field === 'groupId' ? 'dispatch-group-identity-missing' : 'dispatch-request-field-missing'
        )
    }
    if (input.schema !== 'issue-orchestration.dispatch-request.v1') {
        fail('dispatch-request-field-missing')
    }
    if (!SHA.test(input.baseSha ?? '')) fail('dispatch-request-base-sha')
    if (!validateVersionedRoute(input)) validateV1RequestBoundary(input)
    if (input.stageRole === 'ui-ux-implementer' && input.repository === 'Ozwasyd/FsusBlog') {
        const expectedSkills = ['fsusblog-design-conformance', 'fsusui-design-conformance']
        const actualSkills = input.requiredSkills.map(({ id }) => id)
        const skillDigests = input.requiredSkills.map(({ digest: value }) => value)
        if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills) ||
            JSON.stringify(input.designAuthorityDigests) !== JSON.stringify(skillDigests) ||
            skillDigests.some((value) => !HASH.test(value))) {
            fail('dispatch-ui-design-authority-policy')
        }
    }
    if (input.stageRole === 'dag-creator-updater' &&
        input.requestedByRole !== 'root-scheduler') fail('dispatch-stage-profile-policy')
    if (input.requestDigest && input.requestDigest !== unsignedDigest(input, 'requestDigest')) {
        fail('dispatch-request-digest')
    }
    const request = structuredClone(input)
    delete request.requestDigest
    request.requestDigest = digest(request)
    return deepFreeze(request)
}

function observeRuntime(request, rolloutRecords, machineObservations) {
    const session = rolloutRecords.find((item) => item?.type === 'session_meta')?.payload
    const contexts = rolloutRecords.filter((item) => item?.type === 'turn_context').map((item) => item.payload)
    const context = contexts[0] ?? {}
    const spawn = session?.source?.subagent?.thread_spawn ?? {}
    const dispatch = observationByKind(machineObservations, 'dispatch-context')
    const git = observationByKind(machineObservations, 'git-worktree-identity')
    const skill = observationByKind(machineObservations, 'skill-loader')
    const lease = observationByKind(machineObservations, 'group-member-lease')
    const sandbox = context.sandbox_policy?.type
    return {
        schema: 'issue-orchestration.runtime-observation.v1',
        threadId: session?.session_id,
        rolloutId: session?.id,
        startedAt: rolloutRecords[0]?.timestamp,
        effectiveModel: context.model,
        effectiveEffort: context.effort,
        effectiveRole: spawn.agent_role,
        effectiveSandbox: sandbox,
        effectiveForkTurns: spawn.fork_turns,
        effectiveWorkingDirectory: context.cwd,
        loadedSkills: skill?.loadedSkills,
        skillLoadProvenance: skill?.source,
        session,
        contexts,
        dispatch,
        git,
        skill,
        lease,
        provenanceTrusted: [dispatch, git, skill, lease].every(trustworthyObservation)
    }
}

function compareRuntime(request, observed, priorReceipts) {
    const reasons = []
    const missing = [
        ['threadId', 'runtime-thread-id-unobservable'],
        ['rolloutId', 'runtime-rollout-id-unobservable'],
        ['startedAt', 'runtime-started-at-unobservable'],
        ['effectiveModel', 'runtime-model-unobservable'],
        ['effectiveEffort', 'runtime-effort-unobservable'],
        ['effectiveRole', 'runtime-role-unobservable'],
        ['effectiveSandbox', 'runtime-sandbox-unobservable'],
        ['effectiveForkTurns', 'runtime-fork-unobservable'],
        ['effectiveWorkingDirectory', 'runtime-working-directory-unobservable']
    ]
    for (const [field, reason] of missing) if (!observed[field]) reasons.push(reason)
    if (!observed.skill) reasons.push('runtime-skill-load-unobservable')
    if (observed.effectiveModel && observed.effectiveModel !== request.requestedModel) {
        reasons.push('runtime-model-mismatch')
    }
    if (observed.effectiveEffort && observed.effectiveEffort !== request.requestedEffort) {
        reasons.push('runtime-effort-mismatch')
    }
    if (observed.effectiveRole && observed.effectiveRole !== request.stageRole) {
        reasons.push('runtime-role-mismatch')
    }
    if (observed.effectiveSandbox && observed.effectiveSandbox !== request.requestedSandbox) {
        reasons.push('runtime-sandbox-role-policy')
    }
    if (observed.effectiveForkTurns === 'all') reasons.push('runtime-full-history-fork')
    else if (observed.effectiveForkTurns &&
        observed.effectiveForkTurns !== request.requestedForkTurns) {
        reasons.push('runtime-fork-mismatch')
    }
    if (observed.effectiveWorkingDirectory &&
        observed.effectiveWorkingDirectory !== request.requestedWorkingDirectory) {
        reasons.push('runtime-working-directory-mismatch')
    }
    if (new Set(observed.contexts.map(({ effort }) => effort)).size > 1) {
        reasons.push('runtime-context-drift')
    }
    if (new Set(observed.contexts.map(({ sandbox_policy: policy }) => JSON.stringify(policy))).size > 1) {
        reasons.push('runtime-sandbox-drift')
    }
    const pairs = [
        [observed.dispatch?.promptDigest, request.promptDigest, 'runtime-prompt-digest-mismatch'],
        [observed.git?.baseSha, request.baseSha, 'runtime-base-sha-mismatch'],
        [observed.dispatch?.sourceDagDigest, request.sourceDagDigest, 'runtime-source-dag-digest-mismatch'],
        [observed.dispatch?.frontierDigest, request.frontierDigest, 'runtime-frontier-digest-mismatch'],
        [observed.dispatch?.stageProfileDigest, request.stageProfileDigest,
            'runtime-stage-profile-digest-mismatch'],
        [observed.dispatch?.testContractDigest, request.testContractDigest,
            'runtime-test-contract-digest-mismatch'],
        [observed.dispatch?.requestId, request.requestId, 'runtime-request-id-mismatch'],
        [observed.dispatch?.epochId, request.epochId, 'runtime-epoch-id-mismatch'],
        [observed.git?.candidateSha, request.candidateSha, 'runtime-candidate-identity-mismatch'],
        [observed.git?.candidateDigest, request.candidateDigest,
            'runtime-candidate-identity-mismatch']
    ]
    for (const [actual, expected, reason] of pairs) if (actual !== expected) reasons.push(reason)
    if (!observed.provenanceTrusted) reasons.push('runtime-provenance-request-copy')
    if (observed.skill?.source === 'agent-self-report') {
        reasons.push('runtime-skill-observation-untrusted')
    }
    if (request.stageRole === 'test-owner' && observed.contexts[0]?.sandbox_policy) {
        const expectedRoots = [
            `${request.requestedWorkingDirectory}/tests/tools`,
            `${request.requestedWorkingDirectory}/tests/fixtures/issue-orchestration`
        ]
        if (JSON.stringify(observed.contexts[0].sandbox_policy.writable_roots) !==
            JSON.stringify(expectedRoots)) reasons.push('runtime-test-owner-write-boundary')
    }
    if (observed.skill) {
        const loaded = new Map((observed.loadedSkills ?? []).map((item) => [item.id, item.digest]))
        for (const requirement of request.requiredSkills) {
            if (!loaded.has(requirement.id)) reasons.push('runtime-required-skill-missing')
            else if (loaded.get(requirement.id) !== requirement.digest) {
                reasons.push('runtime-skill-digest-mismatch')
            }
        }
    }
    if (priorReceipts.some((item) =>
        item.verificationStatus === 'verified' && item.threadId === observed.threadId &&
        item.requestId !== request.requestId)) reasons.push('runtime-thread-identity-reused')
    if (priorReceipts.some((item) =>
        item.verificationStatus === 'verified' && item.requestDigest === request.requestDigest &&
        item.attemptId !== request.attemptId)) reasons.push('dispatch-request-replay')
    const lease = observed.lease ?? {}
    if (request.groupId !== null) {
        const groupPairs = [
            [lease.groupId, request.groupId, 'runtime-group-id-mismatch'],
            [lease.groupSessionDigest, request.groupSessionDigest,
                'runtime-group-session-mismatch'],
            [lease.memberIssueId, request.memberIssueId, 'runtime-group-member-mismatch'],
            [lease.memberStage, request.memberStage, 'runtime-group-member-stage-mismatch'],
            [lease.memberTestContractDigest, request.memberTestContractDigest,
                'runtime-member-test-contract-mismatch'],
            [lease.activeWriteLeaseId, request.activeWriteLeaseId, 'runtime-write-lease-mismatch'],
            [observed.git?.worktreeIdentity, request.groupWorktreeIdentity,
                'runtime-group-worktree-mismatch'],
            [observed.git?.branchIdentity, request.groupBranchIdentity,
                'runtime-group-branch-mismatch'],
            [lease.memberCandidateIdentity, request.memberCandidateIdentity,
                'runtime-member-candidate-mismatch'],
            [lease.testOwnerContinuityIdentity, request.testOwnerContinuityIdentity,
                'runtime-test-owner-continuity-mismatch'],
            [lease.implementerContinuityIdentity, request.implementerContinuityIdentity,
                'runtime-implementer-continuity-mismatch']
        ]
        for (const [actual, expected, reason] of groupPairs) if (actual !== expected) reasons.push(reason)
        const owners = lease.activeLeaseOwners ?? []
        if (owners.filter((item) => item.leaseId === request.activeWriteLeaseId).length !== 1) {
            reasons.push('runtime-write-lease-conflict')
        }
    }
    if (request.freshVerificationRollout && lease.freshVerificationRollout !== true) {
        reasons.push('runtime-verification-not-fresh')
    }
    return unique(reasons)
}

async function verifyRuntimeDispatchV1(input) {
    if (containsSecret(input.extraMetadata) || containsSecret(input.machineObservations)) {
        return rejectedDispatch(input.request, null, ['dispatch-secret-material'])
    }
    const runtimeObservation = observeRuntime(
        input.request,
        input.rolloutRecords ?? [],
        input.machineObservations ?? []
    )
    const reasons = compareRuntime(input.request, runtimeObservation, input.priorReceipts ?? [])
    const runtimeMetadataDigest = digest(runtimeObservation)
    if (input.claimedRuntimeMetadataDigest &&
        input.claimedRuntimeMetadataDigest !== runtimeMetadataDigest) reasons.push('runtime-metadata-digest')
    if (input.replayReceiptDigest && (input.priorReceipts ?? []).some((item) =>
        item.receiptDigest === input.replayReceiptDigest && item.epochId !== input.request.epochId)) {
        reasons.push('dispatch-receipt-replay')
    }
    const capabilityReasons = reasons.filter((reason) =>
        reason.endsWith('-unobservable') || reason === 'runtime-provenance-request-copy')
    const verificationStatus = reasons.length === 0
        ? 'verified'
        : capabilityReasons.length === reasons.length ? 'capability-unverified' : 'rejected'
    const dispatchReceipt = {
        schema: 'issue-orchestration.dispatch-receipt.v1',
        requestId: input.request.requestId,
        requestDigest: input.request.requestDigest,
        attemptId: input.request.attemptId,
        epochId: input.request.epochId,
        threadId: runtimeObservation.threadId,
        rolloutId: runtimeObservation.rolloutId,
        runtimeMetadataDigest,
        verificationStatus,
        mismatchReasons: unique(reasons)
    }
    dispatchReceipt.receiptDigest = digest(dispatchReceipt)
    return { runtimeObservation, dispatchReceipt }
}

function rejectedDispatch(request, runtimeObservation, reasons) {
    return {
        runtimeObservation,
        dispatchReceipt: {
            schema: 'issue-orchestration.dispatch-receipt.v1',
            requestId: request.requestId,
            verificationStatus: 'rejected',
            mismatchReasons: reasons
        }
    }
}

async function verifyImplementerSelfTestV1({ request, dispatchReceipt, contract, execution }) {
    const reasons = []
    const expectedCommands = contract.visibleTestMatrix
    if (execution.commandResults?.length !== expectedCommands.length ||
        expectedCommands.some((item, index) =>
            JSON.stringify(execution.commandResults?.[index]?.command) !== JSON.stringify(item.command) ||
            execution.commandResults?.[index]?.id !== item.id ||
            execution.commandResults?.[index]?.exitStatus !== 0 ||
            !HASH.test(execution.commandResults?.[index]?.resultDigest ?? ''))) {
        reasons.push('self-test-visible-matrix-incomplete')
    }
    if (execution.visibleTestMatrixDigest !== contract.visibleTestMatrixDigest) {
        reasons.push('self-test-visible-matrix-incomplete')
    }
    if (execution.frozenTestTreeDigestBefore !== contract.frozenTestTree.digest ||
        execution.frozenTestTreeDigestAfter !== contract.frozenTestTree.digest ||
        execution.frozenTestTreeDigestBefore !== execution.frozenTestTreeDigestAfter) {
        reasons.push('self-test-frozen-tree-drift')
    }
    if (!execution.failureHistory?.some((item) =>
        execution.firstFailureRefs?.includes(item.ref) && item.outcome === 'failed')) {
        reasons.push('self-test-command-history-incomplete')
    }
    if (execution.commandResults?.some((item) => item.skipped)) reasons.push('self-test-command-skipped')
    if (!SHA.test(execution.candidateSha ?? '') || execution.candidateSha === '0'.repeat(40)) {
        reasons.push('self-test-candidate-mismatch')
    }
    if (execution.baseSha !== request.baseSha) reasons.push('self-test-base-mismatch')
    if (execution.requestDigest !== request.requestDigest) reasons.push('self-test-request-mismatch')
    if (execution.runId !== request.runId || execution.nodeId !== request.nodeId ||
        execution.attemptId !== request.attemptId || execution.stageRole !== request.stageRole ||
        execution.frozenTestContractDigest !== contract.testContractDigest) {
        reasons.push('self-test-request-mismatch')
    }
    if (execution.remainingFailures?.length) reasons.push('self-test-remaining-failures')
    if (Object.values(execution.lintTypecheckBuildResults ?? {}).includes('failed')) {
        reasons.push('self-test-quality-gate-failed')
    }
    if (execution.firstFailureRefs?.[0] !== execution.failureHistory?.[0]?.ref) {
        reasons.push('self-test-first-failure-lost')
    }
    if (execution.workingTreeStatusDigest !== execution.observedWorkingTreeStatusDigest) {
        reasons.push('self-test-working-tree-drift')
    }
    if (!HASH.test(execution.implementationDiffDigest ?? '')) {
        reasons.push('self-test-implementation-diff-missing')
    }
    if (execution.modifiedPaths?.some((item) => item.startsWith('tests/'))) {
        reasons.push('self-test-frozen-path-modified')
    }
    if (execution.verifierRole !== 'deterministic-machine') reasons.push('self-test-verifier-authority')
    if (dispatchReceipt.schema !== 'issue-orchestration.dispatch-receipt.v1' ||
        dispatchReceipt.verificationStatus !== 'verified' ||
        dispatchReceipt.requestId !== request.requestId ||
        dispatchReceipt.requestDigest !== request.requestDigest ||
        dispatchReceipt.attemptId !== request.attemptId ||
        dispatchReceipt.epochId !== request.epochId ||
        dispatchReceipt.receiptDigest !== unsignedDigest(dispatchReceipt, 'receiptDigest')) {
        reasons.push('verified-dispatch-receipt-required')
    }
    const receipt = {
        schema: 'issue-orchestration.implementer-self-test-receipt.v1',
        verificationStatus: reasons.length ? 'rejected' : 'verified',
        mismatchReasons: unique(reasons),
        requestDigest: request.requestDigest,
        requestId: request.requestId,
        attemptId: request.attemptId,
        epochId: request.epochId,
        candidateSha: execution.candidateSha,
        visibleTestMatrixDigest: execution.visibleTestMatrixDigest,
        frozenTestTreeDigestBefore: execution.frozenTestTreeDigestBefore,
        frozenTestTreeDigestAfter: execution.frozenTestTreeDigestAfter,
        implementationDiffDigest: execution.implementationDiffDigest,
        commandResults: structuredClone(execution.commandResults),
        firstFailureRefs: structuredClone(execution.firstFailureRefs),
        failureHistory: structuredClone(execution.failureHistory)
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

async function authorizeReceiptTransitionV1(input) {
    if (!input.dispatchReceipt ||
        input.dispatchReceipt.schema !== 'issue-orchestration.dispatch-receipt.v1' ||
        input.dispatchReceipt.verificationStatus !== 'verified') {
        fail('verified-dispatch-receipt-required')
    }
    if (input.eventType === 'implementation.candidate-green') {
        if (!input.selfTestReceipt) fail('verified-self-test-receipt-required')
        if (input.selfTestReceipt.schema !==
            'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-schema-stage-mismatch')
        }
        if (input.selfTestReceipt.verificationStatus !== 'verified') {
            fail('verified-self-test-receipt-required')
        }
        if (input.request && (
            input.selfTestReceipt.candidateSha !== input.candidateSha ||
            input.selfTestReceipt.requestDigest !== input.request.requestDigest ||
            input.selfTestReceipt.requestId !== input.request.requestId ||
            input.selfTestReceipt.attemptId !== input.request.attemptId ||
            input.selfTestReceipt.epochId !== input.request.epochId
        )) fail('self-test-candidate-mismatch')
    }
    if (input.eventType === 'independent-verification.passed') {
        const receipt = input.behaviorReceipt
        if (!receipt || receipt.schema !== 'issue-orchestration.behavior-receipt.v1' ||
            receipt.verificationStatus !== 'verified') {
            fail('independent-behavior-receipt-required')
        }
    }
    return true
}

function hasV2Schema(value, prefix) {
    return value?.schema === `issue-orchestration.${prefix}.v2`
}

function isV2Transition(input) {
    return input?.transitionSchema === 'issue-orchestration.transition.v2' ||
        [input?.request, input?.dispatchReceipt, input?.selfTestReceipt,
            input?.behaviorReceipt, input?.uxAcceptanceReceipt]
            .some((item) => typeof item?.schema === 'string' && item.schema.endsWith('.v2'))
}

function expectedRoutingPolicyDigest() {
    return digest(STAGE_MODEL_POOL_POLICY)
}

function expectedV2Route(input) {
    try {
        return compileStageRoute({
            ...input.routingClassification,
            stageRole: input.stageRole,
            stagePhase: input.stagePhase,
            requiredSkillDigests: input.requiredSkillDigests
        })
    } catch (error) {
        if (error?.code === 'routing-ui-adjudication-required') {
            fail('dispatch-ui-adjudication-required')
        }
        fail('dispatch-routing-selection-mismatch')
    }
}

function assertV2Hashes(input) {
    for (const field of [
        'routingPolicyDigest', 'allowedProfilesDigest', 'routingInputDigest',
        'promptDigest', 'sourceDagDigest', 'frontierDigest',
        'issueSnapshotFingerprint', 'repositoryFingerprint',
        'scopeIdentityDigest', 'dependencyIdentityDigest', 'candidateDigest',
        'testContractDigest', 'allowedPathsDigest', 'forbiddenPathsDigest',
        'memberCandidateIdentity'
    ]) {
        if (!HASH.test(input[field] ?? '')) fail('dispatch-request-field-missing')
    }
}

function assertV2SkillBinding(input) {
    if (!Array.isArray(input.requiredSkills) ||
        !Array.isArray(input.requiredSkillIds) ||
        !Array.isArray(input.requiredSkillDigests) ||
        !Array.isArray(input.designAuthorityDigests)) {
        fail('dispatch-request-field-missing')
    }
    const ids = input.requiredSkills.map(({ id }) => id)
    const digests = input.requiredSkills.map(({ digest: value }) => value)
    if (ids.some((id) => typeof id !== 'string' || !id) ||
        digests.some((value) => !HASH.test(value ?? '')) ||
        JSON.stringify(input.requiredSkillIds) !== JSON.stringify(ids) ||
        JSON.stringify(input.requiredSkillDigests) !== JSON.stringify(digests)) {
        fail('dispatch-required-skill-binding')
    }
    if (!['ui-ux-implementer', 'ux-acceptance-verifier'].includes(input.stageRole)) {
        return
    }
    const expectedIds = input.repository === 'Ozwasyd/FsusUI'
        ? ['fsusui-design-conformance']
        : ['fsusblog-design-conformance', 'fsusui-design-conformance']
    if (input.repository !== 'Ozwasyd/FsusBlog' && input.repository !== 'Ozwasyd/FsusUI') {
        fail('dispatch-ui-design-authority-policy')
    }
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds) ||
        JSON.stringify(input.designAuthorityDigests) !== JSON.stringify(digests)) {
        fail('dispatch-ui-design-authority-policy')
    }
}

function assertV2GroupBinding(input) {
    if (input.groupId === null) {
        for (const field of [
            'groupSessionDigest', 'activeWriteLeaseId', 'groupWorktreeIdentity',
            'groupBranchIdentity', 'testOwnerContinuityIdentity',
            'implementerContinuityIdentity'
        ]) {
            if (input[field] !== null) fail('dispatch-group-identity-mismatch')
        }
        if (input.memberIssueId !== input.nodeId ||
            input.memberStage !== input.stagePhase ||
            input.memberTestContractDigest !== input.testContractDigest) {
            fail('dispatch-group-identity-mismatch')
        }
        return
    }
    if (typeof input.groupId !== 'string' || !input.groupId ||
        input.previousMemberRoutingReceiptDigest !== undefined ||
        input.previousMemberProfileId !== undefined) {
        fail('dispatch-member-routing-inherited')
    }
    for (const field of [
        'groupSessionDigest', 'groupWorktreeIdentity', 'groupBranchIdentity',
        'testOwnerContinuityIdentity', 'implementerContinuityIdentity'
    ]) {
        if (!HASH.test(input[field] ?? '')) fail('dispatch-group-identity-mismatch')
    }
    if (typeof input.memberIssueId !== 'string' || !input.memberIssueId ||
        typeof input.memberStage !== 'string' || !input.memberStage ||
        input.memberTestContractDigest !== input.testContractDigest) {
        fail('dispatch-group-identity-mismatch')
    }
}

function validateV2DispatchRequest(input) {
    if (containsSecret(input)) fail('dispatch-secret-material')
    for (const field of V2_REQUEST_FIELDS) {
        if (!Object.hasOwn(input, field)) {
            fail(field === 'groupId'
                ? 'dispatch-group-identity-missing'
                : 'dispatch-request-field-missing')
        }
    }
    if (input.schema !== 'issue-orchestration.dispatch-request.v2' ||
        input.policyVersion !== 'stage-model-pool.v2' ||
        input.routingClassification?.routingPolicyVersion !== 'stage-model-pool.v2' ||
        !SHA.test(input.baseSha ?? '') || !SHA.test(input.candidateSha ?? '')) {
        fail('dispatch-request-field-missing')
    }
    assertV2Hashes(input)
    if (input.routingPolicyDigest !== expectedRoutingPolicyDigest()) {
        fail('dispatch-routing-policy-replay')
    }
    if (input.routingOverride !== undefined ||
        input.selectedByRole !== undefined ||
        input.routeSelectedBy !== undefined ||
        input.requestedByRole !== 'root-scheduler') {
        fail('dispatch-routing-authority')
    }
    if (input.routeTransitionFrom === 'ui-system-design-dispute' &&
        (!HASH.test(input.adjudicationReceiptDigest ?? '') ||
            input.routeTransitionReason !== 'ui-adjudication-complete')) {
        fail('dispatch-ui-adjudication-required')
    }
    assertV2GroupBinding(input)
    const route = expectedV2Route(input)
    const selected = splitProfile(route.selectedProfile)
    const expectedWritePolicy = V2_WRITE_POLICIES[
        `${input.stageRole}:${input.stagePhase}`
    ]
    const routeFieldsMatch = input.stageProfileId === route.selectedProfile &&
        input.selectedProfileId === route.selectedProfile &&
        input.selectedProfileReason === route.selectedProfileReason &&
        input.allowedProfilesDigest === digest(route.allowedProfiles) &&
        input.defaultProfileId === route.defaultProfile &&
        input.routingAuthority === route.routingAuthority &&
        input.routingInputDigest === route.routingInputDigest &&
        input.requestedModel === selected.model &&
        input.requestedEffort === selected.effort &&
        input.requestedSandbox === route.sandbox &&
        input.writePolicy === expectedWritePolicy &&
        input.readOnlyPolicy === (route.sandbox === 'read-only')
    if (!routeFieldsMatch) fail('dispatch-routing-selection-mismatch')
    assertV2SkillBinding(input)
    if (input.requestDigest !== undefined &&
        input.requestDigest !== unsignedDigest(input, 'requestDigest')) {
        fail('dispatch-request-digest')
    }
    return route
}

async function sealDispatchRequestV2(input) {
    validateV2DispatchRequest(input)
    const request = structuredClone(input)
    delete request.requestDigest
    request.requestDigest = digest(request)
    return deepFreeze(request)
}

function trustedV2Observation(item) {
    const trustedSources = new Set([
        'machine-dispatch-context', 'machine-git-observation',
        'runtime-skill-loader', 'runtime-capability-registry',
        'machine-lease-registry'
    ])
    return item && trustedSources.has(item.source) &&
        item.observationDigest === unsignedDigest(item, 'observationDigest')
}

function observeRuntimeV2(request, rolloutRecords, machineObservations) {
    const session = rolloutRecords.find((item) => item?.type === 'session_meta')?.payload
    const contexts = rolloutRecords.filter((item) => item?.type === 'turn_context')
        .map((item) => item.payload)
    const context = contexts[0] ?? {}
    const spawn = session?.source?.subagent?.thread_spawn ?? {}
    const dispatch = observationByKind(machineObservations, 'dispatch-context.v2')
    const git = observationByKind(machineObservations, 'git-worktree-identity')
    const skill = observationByKind(machineObservations, 'skill-loader')
    const capability = observationByKind(machineObservations, 'runtime-capability.v2')
    const lease = observationByKind(machineObservations, 'group-member-lease')
    return {
        schema: 'issue-orchestration.runtime-observation.v2',
        threadId: session?.session_id,
        rolloutId: session?.id,
        startedAt: rolloutRecords[0]?.timestamp,
        effectiveModel: context.model,
        effectiveEffort: context.effort,
        effectiveRole: spawn.agent_role,
        effectiveMode: context.mode,
        effectiveSandbox: context.sandbox_policy?.type,
        effectiveForkTurns: spawn.fork_turns,
        effectiveWorkingDirectory: context.cwd,
        effectiveProfileId: capability?.effectiveProfileId,
        routingInputDigest: dispatch?.routingInputDigest,
        loadedSkills: skill?.loadedSkills,
        session,
        contexts,
        dispatch,
        git,
        skill,
        capability,
        lease,
        provenanceTrusted: [dispatch, git, skill, capability, lease]
            .every(trustedV2Observation)
    }
}

function compareRuntimeV2(request, observed, priorReceipts) {
    const reasons = []
    const missing = [
        ['threadId', 'runtime-thread-id-unobservable'],
        ['rolloutId', 'runtime-rollout-id-unobservable'],
        ['startedAt', 'runtime-started-at-unobservable'],
        ['effectiveModel', 'runtime-model-unobservable'],
        ['effectiveEffort', 'runtime-effort-unobservable'],
        ['effectiveRole', 'runtime-role-unobservable'],
        ['effectiveMode', 'runtime-mode-unobservable'],
        ['effectiveSandbox', 'runtime-sandbox-unobservable'],
        ['effectiveForkTurns', 'runtime-fork-unobservable'],
        ['effectiveWorkingDirectory', 'runtime-working-directory-unobservable']
    ]
    for (const [field, reason] of missing) {
        if (!observed[field]) reasons.push(reason)
    }
    const actualPairs = [
        [observed.effectiveModel, request.requestedModel, 'runtime-model-mismatch'],
        [observed.effectiveEffort, request.requestedEffort, 'runtime-effort-mismatch'],
        [observed.effectiveRole, request.stageRole, 'runtime-role-mismatch'],
        [observed.effectiveMode, request.requestedMode, 'runtime-mode-mismatch'],
        [observed.effectiveSandbox, request.requestedSandbox, 'runtime-sandbox-role-policy'],
        [observed.effectiveForkTurns, request.requestedForkTurns, 'runtime-fork-mismatch'],
        [observed.effectiveWorkingDirectory, request.requestedWorkingDirectory,
            'runtime-working-directory-mismatch']
    ]
    for (const [actual, expected, reason] of actualPairs) {
        if (actual && actual !== expected) reasons.push(reason)
    }
    if (observed.effectiveForkTurns === 'all') reasons.push('runtime-full-history-fork')
    if (new Set(observed.contexts.map(({ model }) => model)).size > 1 ||
        new Set(observed.contexts.map(({ effort }) => effort)).size > 1 ||
        new Set(observed.contexts.map(({ mode }) => mode)).size > 1) {
        reasons.push('runtime-context-drift')
    }
    if (new Set(observed.contexts.map(({ sandbox_policy: policy }) =>
        JSON.stringify(policy))).size > 1) reasons.push('runtime-sandbox-drift')
    if (!observed.skill) reasons.push('runtime-skill-load-unobservable')
    const bindings = [
        [observed.dispatch?.requestId, request.requestId, 'runtime-request-id-mismatch'],
        [observed.dispatch?.promptDigest, request.promptDigest, 'runtime-prompt-digest-mismatch'],
        [observed.dispatch?.sourceDagDigest, request.sourceDagDigest,
            'runtime-source-dag-digest-mismatch'],
        [observed.dispatch?.frontierDigest, request.frontierDigest,
            'runtime-frontier-digest-mismatch'],
        [observed.dispatch?.issueSnapshotFingerprint, request.issueSnapshotFingerprint,
            'runtime-issue-snapshot-mismatch'],
        [observed.dispatch?.repositoryFingerprint, request.repositoryFingerprint,
            'runtime-repository-fingerprint-mismatch'],
        [observed.dispatch?.scopeIdentityDigest, request.scopeIdentityDigest,
            'runtime-scope-identity-mismatch'],
        [observed.dispatch?.dependencyIdentityDigest, request.dependencyIdentityDigest,
            'runtime-dependency-identity-mismatch'],
        [observed.dispatch?.policyVersion, request.policyVersion,
            'runtime-policy-version-mismatch'],
        [observed.dispatch?.routingPolicyDigest, request.routingPolicyDigest,
            'runtime-routing-policy-digest-mismatch'],
        [observed.dispatch?.routingInputDigest, request.routingInputDigest,
            'runtime-routing-input-digest-mismatch'],
        [observed.dispatch?.testContractDigest, request.testContractDigest,
            'runtime-test-contract-digest-mismatch'],
        [observed.dispatch?.epochId, request.epochId, 'runtime-epoch-id-mismatch'],
        [observed.git?.repository, request.repository, 'runtime-repository-mismatch'],
        [observed.git?.baseSha, request.baseSha, 'runtime-base-sha-mismatch'],
        [observed.git?.candidateSha, request.candidateSha,
            'runtime-candidate-identity-mismatch'],
        [observed.git?.candidateDigest, request.candidateDigest,
            'runtime-candidate-identity-mismatch'],
        [observed.git?.workingDirectory, request.requestedWorkingDirectory,
            'runtime-working-directory-mismatch']
    ]
    for (const [actual, expected, reason] of bindings) {
        if (actual !== expected) reasons.push(reason)
    }
    const capability = observed.capability
    if (!capability || capability.available !== true ||
        capability.requestedProfileId !== request.selectedProfileId ||
        capability.effectiveProfileId !== request.selectedProfileId) {
        reasons.push('runtime-capability-missing')
    }
    if (!observed.provenanceTrusted) reasons.push('runtime-provenance-request-copy')
    const loaded = new Map((observed.loadedSkills ?? []).map((item) => [item.id, item.digest]))
    for (const requirement of request.requiredSkills) {
        if (!loaded.has(requirement.id)) reasons.push('runtime-required-skill-missing')
        else if (loaded.get(requirement.id) !== requirement.digest) {
            reasons.push('runtime-skill-digest-mismatch')
        }
    }
    const lease = observed.lease ?? {}
    const leasePairs = [
        [lease.groupId, request.groupId, 'runtime-group-id-mismatch'],
        [lease.memberIssueId, request.memberIssueId, 'runtime-group-member-mismatch'],
        [lease.memberStage, request.memberStage, 'runtime-group-member-stage-mismatch'],
        [lease.freshVerificationRollout, request.freshVerificationRollout,
            'runtime-verification-not-fresh']
    ]
    for (const [actual, expected, reason] of leasePairs) {
        if (actual !== expected) reasons.push(reason)
    }
    if (request.groupId !== null) {
        const groupedPairs = [
            [lease.groupSessionDigest, request.groupSessionDigest,
                'runtime-group-session-mismatch'],
            [lease.activeWriteLeaseId, request.activeWriteLeaseId,
                'runtime-write-lease-mismatch'],
            [lease.memberTestContractDigest, request.memberTestContractDigest,
                'runtime-member-test-contract-mismatch'],
            [lease.memberCandidateIdentity, request.memberCandidateIdentity,
                'runtime-member-candidate-mismatch'],
            [lease.testOwnerContinuityIdentity, request.testOwnerContinuityIdentity,
                'runtime-test-owner-continuity-mismatch'],
            [lease.implementerContinuityIdentity, request.implementerContinuityIdentity,
                'runtime-implementer-continuity-mismatch']
        ]
        for (const [actual, expected, reason] of groupedPairs) {
            if (actual !== expected) reasons.push(reason)
        }
        if (request.readOnlyPolicy !== true &&
            (typeof request.activeWriteLeaseId !== 'string' ||
                !request.activeWriteLeaseId ||
                (lease.activeLeaseOwners ?? []).filter((item) =>
                    item.leaseId === request.activeWriteLeaseId).length !== 1)) {
            reasons.push('runtime-write-lease-conflict')
        }
    }
    if (request.stageRole === 'test-owner' &&
        request.stagePhase === 'test-contract' &&
        observed.contexts[0]?.sandbox_policy?.type === 'workspace-write') {
        const expectedRoots = [
            `${request.requestedWorkingDirectory}/tests/tools`,
            `${request.requestedWorkingDirectory}/tests/fixtures/issue-orchestration`
        ]
        if (JSON.stringify(observed.contexts[0].sandbox_policy.writable_roots) !==
            JSON.stringify(expectedRoots)) {
            reasons.push('runtime-test-owner-write-boundary')
        }
    }
    if (['test-owner:behavior-verification',
        'ui-system-adjudicator:adjudication',
        'ux-acceptance-verifier:ux-acceptance']
        .includes(`${request.stageRole}:${request.stagePhase}`) &&
        (request.freshVerificationRollout !== true ||
            observed.effectiveForkTurns === 'all')) {
        reasons.push('runtime-verification-not-fresh')
    }
    for (const item of priorReceipts) {
        if (item?.verificationStatus !== 'verified' ||
            (item.requestId !== request.requestId &&
                item.requestDigest !== request.requestDigest)) continue
        if (item.baseSha !== request.baseSha || item.candidateSha !== request.candidateSha ||
            item.epochId !== request.epochId ||
            item.routingPolicyDigest !== request.routingPolicyDigest) {
            reasons.push('dispatch-receipt-replay')
        }
    }
    return unique(reasons)
}

function sealDispatchReceiptV2(request, runtimeObservation, reasons) {
    const capabilityReasons = reasons.filter((reason) =>
        reason.endsWith('-unobservable') ||
        reason === 'runtime-provenance-request-copy' ||
        reason === 'runtime-skill-load-unobservable')
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        epochId: request.epochId,
        stageRole: request.stageRole,
        stagePhase: request.stagePhase,
        stageProfileId: request.stageProfileId,
        policyVersion: request.policyVersion,
        routingPolicyDigest: request.routingPolicyDigest,
        routingInputDigest: request.routingInputDigest,
        selectedProfileId: request.selectedProfileId,
        selectedProfileReason: request.selectedProfileReason,
        baseSha: request.baseSha,
        candidateSha: request.candidateSha,
        candidateDigest: request.candidateDigest,
        scopeIdentityDigest: request.scopeIdentityDigest,
        dependencyIdentityDigest: request.dependencyIdentityDigest,
        memberIssueId: request.memberIssueId,
        groupId: request.groupId,
        groupSessionDigest: request.groupSessionDigest,
        activeWriteLeaseId: request.activeWriteLeaseId,
        freshVerificationRollout: request.freshVerificationRollout,
        threadId: runtimeObservation.threadId,
        rolloutId: runtimeObservation.rolloutId,
        actualModel: runtimeObservation.effectiveModel,
        actualEffort: runtimeObservation.effectiveEffort,
        actualRole: runtimeObservation.effectiveRole,
        actualMode: runtimeObservation.effectiveMode,
        actualSandbox: runtimeObservation.effectiveSandbox,
        actualForkTurns: runtimeObservation.effectiveForkTurns,
        actualWorkingDirectory: runtimeObservation.effectiveWorkingDirectory,
        actualSkillIds: (runtimeObservation.loadedSkills ?? []).map(({ id }) => id),
        runtimeMetadataDigest: digest(runtimeObservation),
        verificationStatus: reasons.length === 0
            ? 'verified'
            : capabilityReasons.length === reasons.length
                ? 'capability-unverified'
                : 'rejected',
        mismatchReasons: unique(reasons)
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

async function verifyRuntimeDispatchV2(input) {
    if (containsSecret(input.extraMetadata) || containsSecret(input.machineObservations)) {
        return {
            runtimeObservation: null,
            dispatchReceipt: sealDispatchReceiptV2(input.request, {}, [
                'dispatch-secret-material'
            ])
        }
    }
    let requestReasons = []
    try {
        validateV2DispatchRequest(input.request)
    } catch (error) {
        requestReasons = [error.code ?? 'dispatch-request-invalid']
    }
    const runtimeObservation = observeRuntimeV2(
        input.request,
        input.rolloutRecords ?? [],
        input.machineObservations ?? []
    )
    const reasons = requestReasons.concat(compareRuntimeV2(
        input.request,
        runtimeObservation,
        input.priorReceipts ?? []
    ))
    if (input.claimedRuntimeMetadataDigest &&
        input.claimedRuntimeMetadataDigest !== digest(runtimeObservation)) {
        reasons.push('runtime-metadata-digest')
    }
    return {
        runtimeObservation,
        dispatchReceipt: sealDispatchReceiptV2(
            input.request,
            runtimeObservation,
            unique(reasons)
        )
    }
}

function observeRootStartup(rolloutRecords, machineObservations) {
    const session = rolloutRecords.find((item) => item?.type === 'session_meta')?.payload
    const context = rolloutRecords.find((item) => item?.type === 'turn_context')?.payload ?? {}
    const capability = observationByKind(machineObservations, 'root-runtime-capability.v2')
    return {
        schema: 'issue-orchestration.root-runtime-observation.v2',
        threadId: session?.session_id,
        rolloutId: session?.id,
        actualRole: context.role ?? session?.role,
        actualModel: context.model ?? session?.model,
        actualEffort: context.effort ?? session?.effort,
        actualMode: context.mode ?? session?.mode,
        actualWorkingDirectory: context.cwd,
        session,
        context,
        capability,
        capabilityTrusted: trustedV2Observation(capability)
    }
}

export async function verifyRootStartup(input) {
    const request = input?.request ?? {}
    const observation = observeRootStartup(
        input?.rolloutRecords ?? [],
        input?.machineObservations ?? []
    )
    const reasons = []
    const requestValid = request.schema === 'issue-orchestration.root-startup-request.v2' &&
        request.policyVersion === 'stage-model-pool.v2' &&
        request.stageRole === 'root-scheduler' &&
        request.stagePhase === 'scheduling' &&
        request.stageProfileId === 'luna-low' &&
        request.requestedModel === 'gpt-5.6-luna' &&
        request.requestedEffort === 'low' && request.requestedMode === 'normal' &&
        request.requestDigest === unsignedDigest(request, 'requestDigest')
    if (!requestValid) reasons.push('root-startup-request-invalid')
    const rootMetadata = [observation.session ?? {}, observation.context ?? {}]
    const rootActuals = [
        ['role', 'root-scheduler'],
        ['model', 'gpt-5.6-luna'],
        ['effort', 'low'],
        ['mode', 'normal']
    ]
    if (!observation.actualModel || !observation.actualEffort ||
        !observation.actualRole || !observation.actualMode ||
        !observation.threadId || !observation.rolloutId ||
        !observation.actualWorkingDirectory || !observation.capabilityTrusted) {
        reasons.push('root-startup-capability-unverified')
    }
    for (const [field, expected] of rootActuals) {
        if (rootMetadata.some((metadata) => !metadata[field])) {
            reasons.push('root-startup-capability-unverified')
        } else if (rootMetadata.some((metadata) => metadata[field] !== expected)) {
            reasons.push('root-startup-profile-mismatch')
        }
    }
    if (observation.actualModel && observation.actualModel !== 'gpt-5.6-luna' ||
        observation.actualEffort && observation.actualEffort !== 'low' ||
        observation.actualRole && observation.actualRole !== 'root-scheduler' ||
        observation.actualMode && observation.actualMode !== 'normal' ||
        observation.actualWorkingDirectory &&
            observation.actualWorkingDirectory !== request.requestedWorkingDirectory ||
        observation.capability && (observation.capability.available !== true ||
            observation.capability.stageProfileId !== 'luna-low')) {
        reasons.push('root-startup-profile-mismatch')
    }
    const receipt = {
        schema: 'issue-orchestration.root-startup-receipt.v2',
        requestDigest: request.requestDigest,
        runId: request.runId,
        stageRole: request.stageRole,
        stagePhase: request.stagePhase,
        stageProfileId: request.stageProfileId,
        policyVersion: request.policyVersion,
        routingPolicyDigest: request.routingPolicyDigest,
        routingInputDigest: request.routingInputDigest,
        baseSha: request.baseSha,
        repositoryFingerprint: request.repositoryFingerprint,
        threadId: observation.threadId,
        rolloutId: observation.rolloutId,
        actualRole: observation.actualRole,
        actualModel: observation.actualModel,
        actualEffort: observation.actualEffort,
        actualMode: observation.actualMode,
        actualWorkingDirectory: observation.actualWorkingDirectory,
        runtimeMetadataDigest: digest(observation),
        verificationStatus: reasons.length === 0
            ? 'verified'
            : reasons.every((reason) => reason === 'root-startup-capability-unverified')
                ? 'capability-unverified'
                : 'rejected',
        mismatchReasons: unique(reasons)
    }
    receipt.receiptDigest = digest(receipt)
    return { rootRuntimeObservation: observation, rootStartupReceipt: receipt }
}

function hasValidReceiptDigest(receipt) {
    return receipt?.receiptDigest === unsignedDigest(receipt, 'receiptDigest')
}

function selfTestV2Reasons({ request, dispatchReceipt, contract, execution, priorReceipts }) {
    const reasons = []
    if (dispatchReceipt?.schema === 'issue-orchestration.dispatch-receipt.v1') {
        reasons.push('receipt-v1-historical-only')
    } else if (!hasV2Schema(dispatchReceipt, 'dispatch-receipt') ||
        dispatchReceipt.verificationStatus !== 'verified' ||
        !hasValidReceiptDigest(dispatchReceipt) ||
        dispatchReceipt.requestId !== request.requestId ||
        dispatchReceipt.requestDigest !== request.requestDigest ||
        dispatchReceipt.attemptId !== request.attemptId ||
        dispatchReceipt.epochId !== request.epochId ||
        dispatchReceipt.baseSha !== request.baseSha ||
        dispatchReceipt.candidateSha !== request.candidateSha) {
        reasons.push('verified-dispatch-receipt-required')
    }
    const expectedCommands = contract.visibleTestMatrix ?? []
    if (!Array.isArray(execution.commandResults) ||
        execution.commandResults.length !== expectedCommands.length ||
        expectedCommands.some((item, index) => {
            const actual = execution.commandResults[index]
            return actual?.id !== item.id ||
                JSON.stringify(actual?.command) !== JSON.stringify(item.command) ||
                actual?.exitStatus !== 0 || actual?.skipped === true ||
                !HASH.test(actual?.resultDigest ?? '')
        })) reasons.push('self-test-visible-matrix-incomplete')
    if (execution.visibleTestMatrixDigest !== digest(expectedCommands)) {
        reasons.push('self-test-visible-matrix-incomplete')
    }
    if (execution.frozenTestContractDigest !== contract.testContractDigest ||
        execution.frozenTestTreeDigestBefore !== contract.frozenTestTree?.digest ||
        execution.frozenTestTreeDigestAfter !== contract.frozenTestTree?.digest ||
        execution.frozenTestTreeDigestBefore !== execution.frozenTestTreeDigestAfter) {
        reasons.push('self-test-frozen-tree-drift')
    }
    if (execution.runId !== request.runId || execution.nodeId !== request.nodeId ||
        execution.attemptId !== request.attemptId || execution.stageRole !== request.stageRole ||
        execution.stageProfileId !== request.stageProfileId ||
        execution.routingInputDigest !== request.routingInputDigest ||
        execution.requestDigest !== request.requestDigest ||
        execution.candidateSha !== request.candidateSha ||
        execution.baseSha !== request.baseSha) {
        reasons.push('self-test-request-mismatch')
    }
    if (!Array.isArray(execution.firstFailureRefs) || !execution.firstFailureRefs.length ||
        !execution.failureHistory?.some((item) =>
            execution.firstFailureRefs.includes(item.ref) && item.outcome === 'failed') ||
        execution.firstFailureRefs[0] !== execution.failureHistory?.[0]?.ref) {
        reasons.push('self-test-command-history-incomplete')
    }
    if (!Number.isInteger(execution.fixCycleCount) || execution.fixCycleCount < 1 ||
        !Array.isArray(execution.remainingFailures) || execution.remainingFailures.length) {
        reasons.push('self-test-remaining-failures')
    }
    if (Object.values(execution.lintTypecheckBuildResults ?? {}).includes('failed')) {
        reasons.push('self-test-quality-gate-failed')
    }
    if (!HASH.test(execution.implementationDiffDigest ?? '') ||
        !HASH.test(execution.workingTreeStatusDigest ?? '') ||
        execution.workingTreeStatusDigest !== execution.observedWorkingTreeStatusDigest) {
        reasons.push('self-test-working-tree-drift')
    }
    if (!Array.isArray(execution.modifiedPaths) || execution.modifiedPaths.some((path) =>
        !contract.allowedImplementationPaths?.includes(path))) {
        reasons.push('self-test-frozen-path-modified')
    }
    if (execution.verifierRole !== 'deterministic-machine') {
        reasons.push('self-test-verifier-authority')
    }
    for (const prior of priorReceipts ?? []) {
        if (prior?.verificationStatus === 'verified' &&
            prior.requestDigest === request.requestDigest &&
            (prior.candidateSha !== request.candidateSha ||
                prior.baseSha !== request.baseSha || prior.epochId !== request.epochId)) {
            reasons.push('self-test-receipt-replay')
        }
    }
    return unique(reasons)
}

async function verifyImplementerSelfTestV2({
    request, dispatchReceipt, contract, execution, priorReceipts = []
}) {
    const reasons = selfTestV2Reasons({
        request, dispatchReceipt, contract, execution, priorReceipts
    })
    const receipt = {
        schema: 'issue-orchestration.implementer-self-test-receipt.v2',
        runId: execution.runId,
        nodeId: execution.nodeId,
        attemptId: execution.attemptId,
        stageRole: execution.stageRole,
        stageProfileId: execution.stageProfileId,
        routingInputDigest: execution.routingInputDigest,
        requestDigest: execution.requestDigest,
        requestId: request.requestId,
        candidateSha: execution.candidateSha,
        baseSha: execution.baseSha,
        frozenTestContractDigest: execution.frozenTestContractDigest,
        frozenTestTreeDigestBefore: execution.frozenTestTreeDigestBefore,
        frozenTestTreeDigestAfter: execution.frozenTestTreeDigestAfter,
        implementationDiffDigest: execution.implementationDiffDigest,
        commands: (execution.commandResults ?? []).map(({ command }) => command),
        exitStatuses: (execution.commandResults ?? []).map(({ exitStatus }) => exitStatus),
        commandResults: structuredClone(execution.commandResults ?? []),
        visibleTestMatrixDigest: execution.visibleTestMatrixDigest,
        lintTypecheckBuildResults: structuredClone(execution.lintTypecheckBuildResults ?? {}),
        firstFailureRefs: structuredClone(execution.firstFailureRefs ?? []),
        fixCycleCount: execution.fixCycleCount,
        remainingFailures: structuredClone(execution.remainingFailures ?? []),
        workingTreeStatusDigest: execution.workingTreeStatusDigest,
        modifiedPaths: structuredClone(execution.modifiedPaths ?? []),
        verificationStatus: reasons.length ? 'rejected' : 'verified',
        mismatchReasons: reasons
    }
    receipt.receiptDigest = digest(receipt)
    return deepFreeze(receipt)
}

function assertVerifiedV2DispatchForTransition(input) {
    const receipt = input.dispatchReceipt
    if (receipt?.schema === 'issue-orchestration.dispatch-receipt.v1') {
        fail('receipt-v1-historical-only')
    }
    if (!hasV2Schema(receipt, 'dispatch-receipt') ||
        receipt.verificationStatus !== 'verified' || !hasValidReceiptDigest(receipt)) {
        fail('verified-dispatch-receipt-required')
    }
    return receipt
}

async function authorizeReceiptTransitionV2(input) {
    const dispatchReceipt = assertVerifiedV2DispatchForTransition(input)
    if (input.eventType === 'implementation.candidate-green') {
        const receipt = input.selfTestReceipt
        if (receipt?.schema === 'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-v1-historical-only')
        }
        if (!hasV2Schema(receipt, 'implementer-self-test-receipt')) {
            fail('receipt-schema-stage-mismatch')
        }
        if (receipt.verificationStatus !== 'verified' || !hasValidReceiptDigest(receipt)) {
            fail('verified-self-test-receipt-required')
        }
        if (input.candidateSha && receipt.candidateSha !== input.candidateSha ||
            receipt.candidateSha !== dispatchReceipt.candidateSha ||
            receipt.baseSha !== dispatchReceipt.baseSha ||
            receipt.requestDigest !== dispatchReceipt.requestDigest ||
            receipt.attemptId !== dispatchReceipt.attemptId) {
            fail('self-test-candidate-mismatch')
        }
    }
    if (input.eventType === 'independent-verification.passed') {
        const receipt = input.behaviorReceipt
        if (hasV2Schema(receipt, 'implementer-self-test-receipt') ||
            receipt?.schema === 'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-schema-stage-mismatch')
        }
        if (!hasV2Schema(receipt, 'behavior-receipt') ||
            receipt.verificationStatus !== 'verified' || !hasValidReceiptDigest(receipt)) {
            fail('independent-behavior-receipt-required')
        }
        if (receipt.freshVerificationRollout !== true || receipt.readOnly !== true ||
            receipt.stageRole !== 'test-owner') {
            fail('independent-verifier-freshness-required')
        }
        if (input.candidateSha && receipt.candidateSha !== input.candidateSha ||
            receipt.candidateSha !== dispatchReceipt.candidateSha) {
            fail('candidate-identity-mismatch')
        }
    }
    if (input.eventType === 'documentation.started') {
        const behavior = input.behaviorReceipt
        if (!hasV2Schema(behavior, 'behavior-receipt') ||
            behavior.verificationStatus !== 'verified') {
            fail('documentation-before-behavior-green')
        }
        if (input.uiImpact === true &&
            (!hasV2Schema(input.uxAcceptanceReceipt, 'ux-acceptance-receipt') ||
                input.uxAcceptanceReceipt?.verificationStatus !== 'verified')) {
            fail('documentation-before-ux-accepted')
        }
    }
    return true
}

export async function sealDispatchRequest(input) {
    return input?.schema === 'issue-orchestration.dispatch-request.v2'
        ? sealDispatchRequestV2(input)
        : sealDispatchRequestV1(input)
}

export async function verifyRuntimeDispatch(input) {
    return input?.request?.schema === 'issue-orchestration.dispatch-request.v2'
        ? verifyRuntimeDispatchV2(input)
        : verifyRuntimeDispatchV1(input)
}

export async function sealImplementerSelfTestReceipt(input) {
    return input?.request?.schema === 'issue-orchestration.dispatch-request.v2'
        ? verifyImplementerSelfTestV2(input)
        : verifyImplementerSelfTestV1(input)
}

export async function authorizeReceiptTransition(input) {
    return isV2Transition(input)
        ? authorizeReceiptTransitionV2(input)
        : authorizeReceiptTransitionV1(input)
}

async function runCli(argv) {
    if (argv[0] !== 'verify-runtime') fail('dispatch-cli-command')
    const options = {}
    for (let index = 1; index < argv.length; index += 2) {
        if (!argv[index]?.startsWith('--') || !argv[index + 1]) fail('dispatch-cli-arguments')
        options[argv[index].slice(2)] = argv[index + 1]
    }
    for (const field of ['request', 'rollout', 'machine-observations']) {
        if (!options[field]) fail('dispatch-cli-arguments')
    }
    const request = JSON.parse(fs.readFileSync(options.request, 'utf8'))
    const rolloutRecords = fs.readFileSync(options.rollout, 'utf8').split('\n')
        .filter(Boolean).map((line) => JSON.parse(line))
    const observations = JSON.parse(fs.readFileSync(options['machine-observations'], 'utf8'))
    const result = await verifyRuntimeDispatch({
        request: await sealDispatchRequest(request),
        rolloutRecords,
        machineObservations: observations.machineObservations ?? observations,
        priorReceipts: observations.priorReceipts ?? []
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.dispatchReceipt.verificationStatus !== 'verified') process.exitCode = 1
}

if (process.argv[1] && import.meta.url.split('?')[0] === pathToFileURL(process.argv[1]).href) {
    runCli(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`)
        process.exitCode = 1
    })
}
