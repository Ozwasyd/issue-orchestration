import fs from 'node:fs'
import path from 'node:path'

import {
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'

const AUTHORITY_ROOT = path.resolve(import.meta.dirname, '../../..')
const POLICY_PATH = path.join(
    AUTHORITY_ROOT,
    'policy/runtime-startup-policy.json'
)
const MANIFEST_PATHS = [
    path.join(AUTHORITY_ROOT, 'manifest.json'),
    path.join(
        AUTHORITY_ROOT,
        'issue-orchestration-manifest.json'
    )
]
const RECORD_SCHEMA =
    'issue-orchestration.trusted-runtime-startup-record.v1'
const TAKEOVER_AUTHORIZATION_SCHEMA =
    'issue-orchestration.root-takeover-authorization.v1'
const TAKEOVER_HANDOFF_SCHEMA =
    'issue-orchestration.root-recovery-handoff.v1'
const ROOT_FENCING_SCHEMA =
    'issue-orchestration.root-fencing-receipt.v1'

function readJson(file, code) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        fail(code)
    }
}

function readManifest() {
    const manifestPath = MANIFEST_PATHS.find((candidate) =>
        fs.existsSync(candidate))
    if (!manifestPath) fail('runtime-startup-manifest-unavailable')
    const manifest = readJson(
        manifestPath,
        'runtime-startup-manifest-unavailable'
    )
    if (manifest?.schema !==
            'issue-orchestration.shared-package-manifest.v1') {
        fail('runtime-startup-manifest-invalid')
    }
    assertDigest(
        manifest.manifestDigest,
        'runtime-startup-manifest-invalid'
    )
    assertDigest(
        manifest.sourceTreeDigest,
        'runtime-startup-manifest-invalid'
    )
    return manifest
}

export const RUNTIME_STARTUP_POLICY = Object.freeze(
    readJson(POLICY_PATH, 'runtime-startup-policy-unavailable')
)
export const RUNTIME_STARTUP_POLICY_DIGEST =
    digest(RUNTIME_STARTUP_POLICY)

function policyDigest(file) {
    return digest(readJson(
        path.join(AUTHORITY_ROOT, 'policy', file),
        'runtime-startup-policy-authority-unavailable'
    ))
}

export function currentRuntimeStartupAuthority() {
    const manifest = readManifest()
    return Object.freeze({
        packageDigest: manifest.sourceTreeDigest,
        manifestDigest: manifest.manifestDigest,
        policyDigests: {
            modelPool: policyDigest('model-pool.json'),
            routing: policyDigest('routing-policy.json'),
            executionRouting:
                policyDigest('execution-routing-policy.json'),
            stagePermissions:
                policyDigest('stage-permissions.json'),
            runtimeTrust:
                policyDigest('runtime-trust-policy.json'),
            runtimeStartup: RUNTIME_STARTUP_POLICY_DIGEST,
            runtimeExecutionBinding:
                policyDigest('runtime-execution-binding-policy.json'),
            stageMutationGuard:
                policyDigest('stage-mutation-guard-policy.json'),
            remoteMutation:
                policyDigest('remote-mutation-policy.json'),
            rootTakeover:
                policyDigest('root-takeover-policy.json'),
            controlPlaneAdvisor:
                policyDigest('control-plane-advisor-policy.json')
        }
    })
}

function validatePolicy() {
    const policy = RUNTIME_STARTUP_POLICY
    const normal = policy.rootPhases?.scheduling
    const recovery =
        policy.rootPhases?.['recovery-takeover']
    if (policy.schema !==
            'issue-orchestration.runtime-startup-policy.v1' ||
        policy.version !== 'runtime-startup-attestation.v1' ||
        !Number.isInteger(policy.maxObservationAgeMs) ||
        policy.maxObservationAgeMs < 1000 ||
        normal?.profileId !== 'terra-low' ||
        normal.phase !== 'scheduling' ||
        normal.model !== 'gpt-5.6-terra' ||
        normal.effort !== 'low' ||
        normal.multiAgentBackend !== 'v2' ||
        normal.takeoverEvidenceRequired !== false ||
        recovery?.profileId !== 'terra-medium' ||
        recovery.phase !== 'recovery-takeover' ||
        recovery.model !== 'gpt-5.6-terra' ||
        recovery.effort !== 'medium' ||
        recovery.multiAgentBackend !== 'v2' ||
        recovery.takeoverEvidenceRequired !== true ||
        !Array.isArray(policy.allowedBeforeVerifiedAttestation) ||
        !Array.isArray(policy.protectedActivities)) {
        fail('runtime-startup-policy-invalid')
    }
}

function validateRecord(record, {
    kind,
    producer,
    runtimeAdapter,
    invocationId,
    sessionId
}) {
    if (record?.schema !== RECORD_SCHEMA ||
        record.kind !== kind ||
        record.producerAuthority !== 'runtime-owned' ||
        record.producer !== producer ||
        record.runtimeAdapter !== runtimeAdapter ||
        record.invocationId !== invocationId ||
        record.sessionId !== sessionId ||
        record.recordDigest !==
            unsignedDigest(record, 'recordDigest')) {
        fail('runtime-startup-producer-untrusted')
    }
}

function assertRuntimeIdentity(record) {
    for (const field of [
        'runtimeAdapter',
        'runtimeId',
        'runtimeVersion',
        'invocationId',
        'sessionId'
    ]) {
        assertText(
            record?.[field],
            'runtime-startup-runtime-identity-unobservable'
        )
    }
}

export function compileRuntimeStartupObservation({
    launcherRecord,
    runtimeRecord,
    capacityRecord
} = {}) {
    validatePolicy()
    assertRuntimeIdentity(launcherRecord)
    const adapter = RUNTIME_STARTUP_POLICY.trustedRuntimeAdapters[
        launcherRecord.runtimeAdapter
    ]
    if (!adapter ||
        launcherRecord.runtimeId !== adapter.runtimeId) {
        fail('runtime-startup-adapter-untrusted')
    }
    const shared = {
        runtimeAdapter: launcherRecord.runtimeAdapter,
        invocationId: launcherRecord.invocationId,
        sessionId: launcherRecord.sessionId
    }
    validateRecord(launcherRecord, {
        ...shared,
        kind: 'launcher',
        producer: adapter.launcherProducer
    })
    validateRecord(runtimeRecord, {
        ...shared,
        kind: 'runtime',
        producer: adapter.runtimeProducer
    })
    validateRecord(capacityRecord, {
        ...shared,
        kind: 'capacity',
        producer: adapter.capacityProducer
    })
    if (runtimeRecord.runtimeId !== launcherRecord.runtimeId ||
        runtimeRecord.runtimeVersion !==
            launcherRecord.runtimeVersion ||
        capacityRecord.runtimeId !== launcherRecord.runtimeId ||
        capacityRecord.runtimeVersion !==
            launcherRecord.runtimeVersion) {
        fail('runtime-startup-runtime-identity-drift')
    }
    const authority = currentRuntimeStartupAuthority()
    const observation = {
        schema:
            'issue-orchestration.runtime-startup-observation.v1',
        runtimeAdapter: launcherRecord.runtimeAdapter,
        runtimeId: launcherRecord.runtimeId,
        runtimeVersion: launcherRecord.runtimeVersion,
        invocationId: launcherRecord.invocationId,
        sessionId: launcherRecord.sessionId,
        requestedRole: launcherRecord.requestedRole,
        requestedStage: launcherRecord.requestedStage,
        selectedProfile: launcherRecord.selectedProfile,
        effectiveProfile: runtimeRecord.effectiveProfile,
        requestedModel: launcherRecord.requestedModel,
        effectiveModel: runtimeRecord.effectiveModel,
        requestedEffort: launcherRecord.requestedEffort,
        effectiveEffort: runtimeRecord.effectiveEffort,
        requestedMultiAgentBackend:
            launcherRecord.requestedMultiAgentBackend,
        effectiveMultiAgentBackend:
            runtimeRecord.effectiveMultiAgentBackend,
        trustMode: runtimeRecord.trustMode,
        requestedSandbox:
            launcherRecord.requestedSandbox,
        effectiveSandbox:
            runtimeRecord.effectiveSandbox,
        requestedPermissionProfile:
            launcherRecord.requestedPermissionProfile,
        effectivePermissionProfile:
            runtimeRecord.effectivePermissionProfile,
        requestedApprovalPolicy:
            launcherRecord.requestedApprovalPolicy,
        effectiveApprovalPolicy:
            runtimeRecord.effectiveApprovalPolicy,
        permissionInheritance:
            runtimeRecord.permissionInheritance,
        permissionGuarantee:
            runtimeRecord.permissionGuarantee,
        rootRouteDigest:
            launcherRecord.rootRouteDigest,
        rootAuthorityEpoch:
            launcherRecord.rootAuthorityEpoch,
        capacity: structuredClone(capacityRecord.capacity),
        observedAt: runtimeRecord.observedAt,
        producerAuthority: 'runtime-owned',
        producers: {
            launcher: launcherRecord.producer,
            runtime: runtimeRecord.producer,
            capacity: capacityRecord.producer
        },
        packageDigest: launcherRecord.packageDigest,
        manifestDigest: launcherRecord.manifestDigest,
        policyDigests:
            structuredClone(launcherRecord.policyDigests),
        sourceRecordDigests: [
            launcherRecord.recordDigest,
            runtimeRecord.recordDigest,
            capacityRecord.recordDigest
        ],
        observationDigest: null
    }
    if (!sameValue({
        packageDigest: observation.packageDigest,
        manifestDigest: observation.manifestDigest,
        policyDigests: observation.policyDigests
    }, authority)) {
        fail('runtime-startup-package-policy-drift')
    }
    delete observation.observationDigest
    return seal(observation, 'observationDigest')
}

function validDate(value) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : null
}

function validateTakeoverContext(context, observation, at) {
    const authorization = context?.authorization
    const handoff = context?.handoff
    const fencing = context?.fencingReceipt
    if (authorization?.schema !==
            TAKEOVER_AUTHORIZATION_SCHEMA ||
        authorization.producerAuthority !==
            'machine-takeover-policy' ||
        authorization.status !== 'authorized' ||
        authorization.expectedNewRootPhase !==
            'recovery-takeover' ||
        authorization.expectedNewInvocationId !==
            observation.invocationId ||
        authorization.oldRootInvocationId ===
            observation.invocationId ||
        authorization.newRootAuthorityEpoch !==
            observation.rootAuthorityEpoch ||
        authorization.expectedNewRootProfile !==
            observation.selectedProfile ||
        authorization.expectedNewInvocationClass !==
            'parent-invocation' ||
        authorization.packageDigest !==
            observation.packageDigest ||
        authorization.policySetDigest !==
            digest(observation.policyDigests) ||
        authorization.policyDigest !==
            observation.policyDigests.rootTakeover ||
        authorization.attemptOrdinal !== 1 ||
        authorization.authorizationDigest !==
            unsignedDigest(
                authorization,
                'authorizationDigest'
            )) {
        return false
    }
    if (handoff?.schema !== TAKEOVER_HANDOFF_SCHEMA ||
        handoff.producerAuthority !==
            'deterministic-external-root-supervisor' ||
        handoff.policyDigest !==
            observation.policyDigests.rootTakeover ||
        handoff.runId !== authorization.runId ||
        handoff.takeoverAuthorizationDigest !==
            authorization.authorizationDigest ||
        handoff.oldRootInvocationId !==
            authorization.oldRootInvocationId ||
        handoff.expectedNewInvocationId !==
            observation.invocationId ||
        handoff.newRootAuthorityEpoch !==
            observation.rootAuthorityEpoch ||
        handoff.fencingReceiptDigest !==
            fencing?.receiptDigest ||
        handoff.freeFormConversationIncluded !== false ||
        handoff.handoffDigest !==
            unsignedDigest(handoff, 'handoffDigest')) {
        return false
    }
    if (fencing?.schema !== ROOT_FENCING_SCHEMA ||
        fencing.producerAuthority !==
            'deterministic-external-root-supervisor' ||
        fencing.policyDigest !==
            observation.policyDigests.rootTakeover ||
        fencing.status !== 'fenced' ||
        fencing.runId !== authorization.runId ||
        fencing.takeoverAuthorizationDigest !==
            authorization.authorizationDigest ||
        fencing.oldRootInvocationId !==
            authorization.oldRootInvocationId ||
        fencing.newRootAuthorityEpoch !==
            observation.rootAuthorityEpoch ||
        fencing.oldRootControlAuthorityRevoked !== true ||
        fencing.oldRootLeaseStatus !== 'revoked' ||
        fencing.uniqueRootLeaseAvailable !== true ||
        fencing.receiptDigest !==
            unsignedDigest(fencing, 'receiptDigest')) {
        return false
    }
    const expiresAt = validDate(authorization.expiresAt)
    return expiresAt !== null && expiresAt >= at
}

function evaluateObservation({
    observation,
    takeoverContext,
    attestedAt,
    preflightReasonCodes = []
}) {
    validatePolicy()
    const reasons = []
    const authority = currentRuntimeStartupAuthority()
    const root = RUNTIME_STARTUP_POLICY.requiredRootRuntime
    const profile = RUNTIME_STARTUP_POLICY.rootPhases[
        observation?.requestedStage
    ]
    const observedTime = validDate(observation?.observedAt)
    const attestedTime = validDate(attestedAt)

    if (observation?.schema !==
            'issue-orchestration.runtime-startup-observation.v1' ||
        observation?.observationDigest !==
            unsignedDigest(observation ?? {}, 'observationDigest')) {
        reasons.push('runtime-startup-observation-invalid')
    }
    if (observation?.producerAuthority !== 'runtime-owned') {
        reasons.push('runtime-startup-producer-untrusted')
    }
    if (!RUNTIME_STARTUP_POLICY.trustedRuntimeAdapters[
        observation?.runtimeAdapter
    ]) {
        reasons.push('runtime-startup-adapter-untrusted')
    }
    const adapter = RUNTIME_STARTUP_POLICY.trustedRuntimeAdapters[
        observation?.runtimeAdapter
    ]
    if (!adapter ||
        observation?.producerAuthority !== 'runtime-owned' ||
        observation?.producers?.launcher !==
            adapter.launcherProducer ||
        observation?.producers?.runtime !==
            adapter.runtimeProducer ||
        observation?.producers?.capacity !==
            adapter.capacityProducer ||
        !Array.isArray(observation?.sourceRecordDigests) ||
        observation.sourceRecordDigests.length !== 3 ||
        new Set(observation.sourceRecordDigests).size !== 3 ||
        observation.sourceRecordDigests.some((value) =>
            !/^[a-f0-9]{64}$/u.test(value))) {
        reasons.push('runtime-startup-producer-untrusted')
    }
    if (!observation?.invocationId || !observation?.sessionId) {
        reasons.push('runtime-startup-runtime-identity-unobservable')
    }
    if (observation?.requestedRole !== root.role ||
        !profile) {
        reasons.push('runtime-startup-root-role-mismatch')
    }
    if (!['terra-low', 'terra-medium'].includes(
        observation?.selectedProfile
    ) ||
        observation?.selectedProfile !== profile?.profileId ||
        observation?.effectiveProfile !== profile?.profileId ||
        observation?.requestedModel !== profile?.model ||
        observation?.effectiveModel !== profile?.model ||
        observation?.requestedEffort !== profile?.effort ||
        observation?.effectiveEffort !== profile?.effort ||
        observation?.requestedMultiAgentBackend !==
            profile?.multiAgentBackend ||
        observation?.effectiveMultiAgentBackend !==
            profile?.multiAgentBackend) {
        reasons.push('runtime-startup-profile-mismatch')
    }
    if (observation?.trustMode !== root.trustMode ||
        observation?.requestedSandbox !== root.effectiveSandbox ||
        observation?.effectiveSandbox !== root.effectiveSandbox ||
        observation?.requestedPermissionProfile !==
            root.effectivePermissionProfile ||
        observation?.effectivePermissionProfile !==
            root.effectivePermissionProfile ||
        observation?.requestedApprovalPolicy !==
            root.approvalPolicy ||
        observation?.effectiveApprovalPolicy !==
            root.approvalPolicy ||
        observation?.permissionInheritance !==
            root.permissionInheritance ||
        observation?.permissionGuarantee !==
            root.permissionGuarantee) {
        reasons.push('runtime-startup-permission-mismatch')
    }
    if (!/^[a-f0-9]{64}$/u.test(
        observation?.rootRouteDigest ?? ''
    ) ||
        typeof observation?.rootAuthorityEpoch !== 'string' ||
        !observation.rootAuthorityEpoch) {
        reasons.push('runtime-startup-root-authority-unobservable')
    }
    if (observation?.capacity?.status !== 'observed' ||
        observation.capacity.multiAgentV2 !== true ||
        !Number.isInteger(
            observation.capacity.maxConcurrentThreadsPerSession
        ) ||
        observation.capacity.maxConcurrentThreadsPerSession < 1) {
        reasons.push('runtime-startup-capacity-unobservable')
    }
    if (attestedTime === null || observedTime === null ||
        observedTime > attestedTime ||
        attestedTime - observedTime >
            RUNTIME_STARTUP_POLICY.maxObservationAgeMs) {
        reasons.push('runtime-startup-observation-stale')
    }
    if (!sameValue({
        packageDigest: observation?.packageDigest,
        manifestDigest: observation?.manifestDigest,
        policyDigests: observation?.policyDigests
    }, authority)) {
        reasons.push('runtime-startup-package-policy-drift')
    }
    if (observation?.requestedStage === 'recovery-takeover' &&
        !validateTakeoverContext(
            takeoverContext,
            observation,
            attestedTime ?? Number.POSITIVE_INFINITY
        )) {
        reasons.push('runtime-startup-takeover-unverified')
    }
    return [...new Set([
        ...reasons,
        ...preflightReasonCodes
    ])].sort()
}

export function attestRuntimeStartup({
    observation,
    takeoverContext = null,
    attestedAt,
    preflightReasonCodes = []
} = {}) {
    const reasonCodes = evaluateObservation({
        observation,
        takeoverContext,
        attestedAt,
        preflightReasonCodes
    })
    return seal({
        schema:
            'issue-orchestration.runtime-startup-attestation.v1',
        policyVersion: RUNTIME_STARTUP_POLICY.version,
        status: reasonCodes.length === 0
            ? 'verified'
            : 'rejected',
        reasonCodes,
        orchestrationEnabled: reasonCodes.length === 0,
        runtimeInvocationId: observation?.invocationId ?? 'unobservable',
        runtimeSessionId: observation?.sessionId ?? 'unobservable',
        runtimeId: observation?.runtimeId ?? 'codex',
        runtimeVersion:
            observation?.runtimeVersion ?? 'unobservable',
        rootPhase:
            observation?.requestedStage ?? 'scheduling',
        selectedProfile:
            observation?.selectedProfile ?? 'terra-low',
        effectiveProfile:
            observation?.effectiveProfile ?? 'terra-low',
        effectiveModel:
            observation?.effectiveModel ?? 'unobservable',
        effectiveEffort:
            observation?.effectiveEffort ?? 'unobservable',
        effectiveMultiAgentBackend:
            observation?.effectiveMultiAgentBackend ??
            'unobservable',
        trustMode:
            observation?.trustMode ??
            'trusted-owner-repositories',
        effectiveSandbox:
            observation?.effectiveSandbox ?? 'unobservable',
        effectivePermissionProfile:
            observation?.effectivePermissionProfile ??
            'unobservable',
        effectiveApprovalPolicy:
            observation?.effectiveApprovalPolicy ??
            'unobservable',
        permissionInheritance:
            observation?.permissionInheritance ??
            'unobservable',
        permissionGuarantee:
            observation?.permissionGuarantee ??
            'unobservable',
        capacityDigest:
            digest(observation?.capacity ?? 'unobservable'),
        rootRouteDigest:
            observation?.rootRouteDigest ??
            digest('unobservable:root-route'),
        rootAuthorityEpoch:
            observation?.rootAuthorityEpoch ?? 'unobservable',
        observationDigest:
            observation?.observationDigest ?? digest('unobservable'),
        packageDigest:
            observation?.packageDigest ?? digest('unobservable'),
        manifestDigest:
            observation?.manifestDigest ?? digest('unobservable'),
        policyDigests:
            structuredClone(observation?.policyDigests ?? {
                modelPool: digest('unobservable:model-pool'),
                routing: digest('unobservable:routing'),
                executionRouting:
                    digest('unobservable:execution-routing'),
                stagePermissions:
                    digest('unobservable:stage-permissions'),
                runtimeTrust: digest('unobservable:runtime-trust'),
                runtimeStartup:
                    digest('unobservable:runtime-startup'),
                runtimeExecutionBinding:
                    digest('unobservable:runtime-execution-binding'),
                stageMutationGuard:
                    digest('unobservable:stage-mutation-guard'),
                remoteMutation:
                    digest('unobservable:remote-mutation'),
                rootTakeover:
                    digest('unobservable:root-takeover'),
                controlPlaneAdvisor:
                    digest('unobservable:control-plane-advisor')
            }),
        recoveryAuthorizationDigest:
            takeoverContext?.authorization
                ?.authorizationDigest ?? null,
        takeoverHandoffDigest:
            takeoverContext?.handoff?.handoffDigest ?? null,
        oldRootFencingReceiptDigest:
            takeoverContext?.fencingReceipt
                ?.receiptDigest ?? null,
        attestedAt
    }, 'attestationDigest')
}

export function verifyRuntimeStartupAttestation({
    observation,
    attestation,
    takeoverContext = null,
    expectedInvocationId,
    expectedSessionId
} = {}) {
    if (attestation?.schema !==
            'issue-orchestration.runtime-startup-attestation.v1' ||
        attestation.attestationDigest !==
            unsignedDigest(attestation ?? {}, 'attestationDigest') ||
        attestation.status !== 'verified' ||
        attestation.orchestrationEnabled !== true) {
        fail('runtime-startup-attestation-not-verified')
    }
    const recomputed = attestRuntimeStartup({
        observation,
        takeoverContext,
        attestedAt: attestation.attestedAt
    })
    if (!sameValue(recomputed, attestation)) {
        fail('runtime-startup-attestation-drift')
    }
    if (expectedInvocationId !== undefined &&
        attestation.runtimeInvocationId !== expectedInvocationId) {
        fail('runtime-startup-invocation-mismatch')
    }
    if (expectedSessionId !== undefined &&
        attestation.runtimeSessionId !== expectedSessionId) {
        fail('runtime-startup-session-mismatch')
    }
    return attestation
}

export function requireRuntimeStartupBinding({
    startup,
    expectedInvocationId,
    expectedSessionId
} = {}) {
    const attestation = verifyRuntimeStartupAttestation({
        observation: startup?.observation,
        attestation: startup?.attestation,
        takeoverContext:
            startup?.takeoverContext ?? null,
        expectedInvocationId,
        expectedSessionId
    })
    return Object.freeze({
        startupAttestationDigest:
            attestation.attestationDigest,
        runtimeInvocationId:
            attestation.runtimeInvocationId,
        runtimeSessionId:
            attestation.runtimeSessionId,
        rootProfile: attestation.selectedProfile,
        rootPhase: attestation.rootPhase,
        rootAuthorityEpoch:
            attestation.rootAuthorityEpoch,
        recoveryAuthorizationDigest:
            attestation.recoveryAuthorizationDigest,
        takeoverHandoffDigest:
            attestation.takeoverHandoffDigest,
        oldRootFencingReceiptDigest:
            attestation.oldRootFencingReceiptDigest
    })
}

export function authorizeRuntimeStartupActivity({
    activity,
    startup = null
} = {}) {
    assertText(activity, 'runtime-startup-activity-invalid')
    const preflight = new Set(
        RUNTIME_STARTUP_POLICY.allowedBeforeVerifiedAttestation
    )
    const protectedActivities = new Set(
        RUNTIME_STARTUP_POLICY.protectedActivities
    )
    if (!preflight.has(activity) &&
        !protectedActivities.has(activity)) {
        fail('runtime-startup-activity-invalid')
    }
    if (preflight.has(activity)) {
        return Object.freeze({
            activity,
            authorized: true,
            startupAttestationDigest: null,
            runtimeInvocationId: null
        })
    }
    const binding = requireRuntimeStartupBinding({ startup })
    return Object.freeze({
        activity,
        authorized: true,
        ...binding
    })
}
