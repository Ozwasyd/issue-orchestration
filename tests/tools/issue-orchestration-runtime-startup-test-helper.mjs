import { createHash } from 'node:crypto'

import {
    attestRuntimeStartup,
    compileRuntimeStartupObservation,
    currentRuntimeStartupAuthority
} from '../../skills/issue-orchestration/scripts/runtime-startup-attestation.mjs'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

export function startupTestDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function record(value) {
    const result = structuredClone(value)
    result.recordDigest = startupTestDigest(result)
    return result
}

export function runtimeStartupRecords({
    profile = 'terra-low',
    rootPhase = profile === 'terra-medium'
        ? 'recovery-takeover'
        : 'scheduling',
    runtimeAdapter = 'codex-rollout-v1',
    runtimeId = 'codex',
    runtimeVersion = 'codex-cli-2026.08',
    invocationId = 'invocation-test-001',
    sessionId = 'session-test-001',
    observedAt = '2026-08-03T01:00:00.000Z',
    capacityStatus = 'observed',
    authority = currentRuntimeStartupAuthority()
} = {}) {
    const effort = profile === 'terra-medium' ? 'medium' : 'low'
    const rootAuthorityEpoch = rootPhase === 'recovery-takeover'
        ? 'root-authority-epoch-2'
        : 'root-authority-epoch-1'
    const common = {
        schema:
            'issue-orchestration.trusted-runtime-startup-record.v1',
        producerAuthority: 'runtime-owned',
        runtimeAdapter,
        runtimeId,
        runtimeVersion,
        invocationId,
        sessionId
    }
    const launcherRecord = record({
        ...common,
        kind: 'launcher',
        producer: 'codex-launcher',
        requestedRole: 'root-scheduler',
        requestedStage: rootPhase,
        selectedProfile: profile,
        requestedModel: 'gpt-5.6-terra',
        requestedEffort: effort,
        requestedMultiAgentBackend: 'v2',
        requestedSandbox: 'danger-full-access',
        requestedPermissionProfile: 'danger-full-access',
        requestedApprovalPolicy: 'never',
        rootRouteDigest: startupTestDigest({
            role: 'root-scheduler',
            phase: rootPhase,
            profile
        }),
        rootAuthorityEpoch,
        packageDigest: authority.packageDigest,
        manifestDigest: authority.manifestDigest,
        policyDigests: authority.policyDigests,
        observedAt
    })
    const runtimeRecord = record({
        ...common,
        kind: 'runtime',
        producer: 'codex-rollout',
        effectiveProfile: profile,
        effectiveModel: 'gpt-5.6-terra',
        effectiveEffort: effort,
        effectiveMultiAgentBackend: 'v2',
        trustMode: 'trusted-owner-repositories',
        effectiveSandbox: 'danger-full-access',
        effectivePermissionProfile: 'danger-full-access',
        effectiveApprovalPolicy: 'never',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt
    })
    const capacityRecord = record({
        ...common,
        kind: 'capacity',
        producer: 'codex-control-plane',
        capacity: capacityStatus === 'observed'
            ? {
                status: 'observed',
                multiAgentV2: true,
                maxConcurrentThreadsPerSession: 16,
                reasonCode: null
            }
            : {
                status: 'unobservable',
                multiAgentV2: null,
                maxConcurrentThreadsPerSession: null,
                reasonCode: 'runtime-capacity-unobservable'
            },
        observedAt
    })
    return {
        launcherRecord,
        runtimeRecord,
        capacityRecord
    }
}

export function takeoverContext({
    runId = 'run-test-takeover',
    oldInvocationId = 'invocation-test-old-root',
    oldRootSessionId = 'session-test-old-root',
    oldRootAuthorityEpoch = 'root-authority-epoch-1',
    oldRootStartupAttestationDigest =
        startupTestDigest('old-startup'),
    newInvocationId = 'invocation-test-001',
    rootAuthorityEpoch = 'root-authority-epoch-2',
    expiresAt = '2026-08-03T01:10:00.000Z'
} = {}) {
    const authority = currentRuntimeStartupAuthority()
    const oldRootControlLeaseDigest =
        startupTestDigest('old-root-control-lease')
    const activeActorInventoryDigest =
        startupTestDigest('active-actor-inventory')
    const activeResourceInventoryDigest =
        startupTestDigest('active-resource-inventory')
    const activeInventoryDigest =
        startupTestDigest('active-inventory')
    const inventoryDispositionDigest =
        startupTestDigest('inventory-disposition')
    const fencingCoverage = [
        'state-root-ledger-dag-lock-lease',
        'actor-spawn-cancel',
        'resource-worktree-lifecycle',
        'landing-delivery-remote-mutation',
        'continuation-terminal-signing'
    ]
    const fencingReceipt = {
        schema: 'issue-orchestration.root-fencing-receipt.v1',
        producerAuthority:
            'deterministic-external-root-supervisor',
        policyDigest: authority.policyDigests.rootTakeover,
        status: 'fenced',
        runId,
        takeoverAuthorizationDigest: null,
        oldRootInvocationId: oldInvocationId,
        oldRootSessionId,
        oldRootControlLeaseDigest,
        oldRootLeaseStatus: 'revoked',
        oldRootProcessDisposition: 'machine-fenced',
        oldRootControlAuthorityRevoked: true,
        fencingCoverage,
        activeActorInventoryDigest,
        activeResourceInventoryDigest,
        inventoryDispositionDigest,
        uniqueRootLeaseAvailable: true,
        newRootAuthorityEpoch: rootAuthorityEpoch,
        fencedAt: '2026-08-03T01:00:00.000Z',
        receiptDigest: null
    }
    const authorization = {
        schema:
            'issue-orchestration.root-takeover-authorization.v1',
        producerAuthority: 'machine-takeover-policy',
        policyDigest: authority.policyDigests.rootTakeover,
        status: 'authorized',
        runId,
        oldRootInvocationId: oldInvocationId,
        oldRootSessionId,
        oldRootAuthorityEpoch,
        oldRootControlLeaseDigest,
        oldRootStartupAttestationDigest,
        expectedNewRootPhase: 'recovery-takeover',
        expectedNewRootProfile: 'terra-medium',
        expectedNewInvocationClass: 'parent-invocation',
        expectedNewInvocationId: newInvocationId,
        newRootAuthorityEpoch: rootAuthorityEpoch,
        reasonCode: 'root-startup-runtime-identity-drift',
        directEvidenceDigest: startupTestDigest('direct-evidence'),
        eligibilityReceiptDigest:
            startupTestDigest('eligibility-receipt'),
        advisorRequestDigest: null,
        advisorProposalDigest: null,
        recoveryPlanDigest: null,
        deterministicRecoveryDisposition:
            'not-applicable-root-unavailable',
        packageDigest: authority.packageDigest,
        policySetDigest:
            startupTestDigest(authority.policyDigests),
        stateRootDigest: startupTestDigest('state-root'),
        checkpointIdentityDigest:
            startupTestDigest('checkpoint-identity'),
        repositoryStateDigest:
            startupTestDigest('repository-state'),
        baseSha: 'a'.repeat(40),
        deliveryEpoch: 'delivery-epoch-test',
        remoteSnapshotDigest:
            startupTestDigest('remote-snapshot'),
        activeInventoryDigest,
        requiredDispositionDigest:
            startupTestDigest('required-disposition'),
        fencingRequirementsDigest:
            startupTestDigest(fencingCoverage),
        attemptOrdinal: 1,
        issuedAt: '2026-08-03T00:59:00.000Z',
        expiresAt,
        authorizationDigest: null
    }
    delete authorization.authorizationDigest
    authorization.authorizationDigest =
        startupTestDigest(authorization)
    fencingReceipt.takeoverAuthorizationDigest =
        authorization.authorizationDigest
    delete fencingReceipt.receiptDigest
    fencingReceipt.receiptDigest =
        startupTestDigest(fencingReceipt)
    const handoff = {
        schema: 'issue-orchestration.root-recovery-handoff.v1',
        producerAuthority:
            'deterministic-external-root-supervisor',
        policyDigest: authority.policyDigests.rootTakeover,
        runId,
        takeoverAuthorizationDigest:
            authorization.authorizationDigest,
        fencingReceiptDigest: fencingReceipt.receiptDigest,
        oldRootInvocationId: oldInvocationId,
        expectedNewInvocationId: newInvocationId,
        oldRootAuthorityEpoch,
        newRootAuthorityEpoch: rootAuthorityEpoch,
        stateRootDigest: authorization.stateRootDigest,
        ledgerDigest: startupTestDigest('ledger'),
        dagDigest: startupTestDigest('dag'),
        checkpointDigest: startupTestDigest('checkpoint'),
        rootCursorDigest: startupTestDigest('root-cursor'),
        activeInventoryDigest,
        evidenceSetDigest: startupTestDigest('evidence-set'),
        repositoryStateDigest:
            authorization.repositoryStateDigest,
        remoteSnapshotDigest:
            authorization.remoteSnapshotDigest,
        advisorRecoveryChainDigest: null,
        requiredRevalidationGates: [
            'startup',
            'package-policy',
            'state-root',
            'repository-remote',
            'resource-inventory',
            'dag',
            'continuation',
            'delivery',
            'quiescence'
        ],
        freeFormConversationIncluded: false,
        handoffDigest: null
    }
    delete handoff.handoffDigest
    handoff.handoffDigest = startupTestDigest(handoff)
    return { authorization, handoff, fencingReceipt }
}

export function verifiedRuntimeStartup({
    profile = 'terra-low',
    invocationId = 'invocation-test-001',
    sessionId = 'session-test-001',
    observedAt = '2026-08-03T01:00:00.000Z',
    attestedAt = '2026-08-03T01:00:01.000Z'
} = {}) {
    const records = runtimeStartupRecords({
        profile,
        invocationId,
        sessionId,
        observedAt
    })
    const observation = compileRuntimeStartupObservation(records)
    const context = profile === 'terra-medium'
        ? takeoverContext({ newInvocationId: invocationId })
        : null
    const attestation = attestRuntimeStartup({
        observation,
        takeoverContext: context,
        attestedAt
    })
    return {
        observation,
        attestation,
        takeoverContext: context
    }
}
