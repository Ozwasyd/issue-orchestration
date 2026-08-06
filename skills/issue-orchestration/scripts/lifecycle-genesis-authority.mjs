import { execFileSync } from 'node:child_process'
import path from 'node:path'

import {
    assertArray,
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'
import {
    compileRuntimeTrustBinding,
    validateRuntimeTrustBinding
} from './runtime-trust-policy.mjs'
import {
    resolveSelector,
    verifySelectorReceipt
} from './scope-selector.mjs'
import { validateStateRoot } from './validate-state-root.mjs'

const AUTHORITY_SCHEMA =
    'issue-orchestration.lifecycle-run-authority.v1'
const BINDING_SCHEMA =
    'issue-orchestration.lifecycle-authority-binding.v1'
const CAPABILITY_SCHEMA =
    'issue-orchestration.runtime-capability-binding.v1'
const STATE_ROOT_SCHEMA =
    'issue-orchestration.lifecycle-state-root-identity.v1'
const REPOSITORY_SCHEMA =
    'issue-orchestration.lifecycle-repository-binding.v1'
const REMOTE_CONTINUATION_SCHEMA =
    'issue-orchestration.lifecycle-remote-observation-continuation.v1'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

function clone(value) {
    return structuredClone(value)
}

function git(repositoryPath, args, code) {
    try {
        return execFileSync(
            'git',
            ['-C', repositoryPath, ...args],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            }
        ).trim()
    } catch {
        fail(code)
    }
}

function normalizeTargets(repositoryTargets) {
    return assertArray(
        repositoryTargets,
        'lifecycle-authority-repository-targets-invalid',
        { min: 1 }
    ).map((target) => {
        assertText(
            target?.repository,
            'lifecycle-authority-repository-target-invalid'
        )
        assertText(
            target?.repositoryPath,
            'lifecycle-authority-repository-target-invalid'
        )
        assertText(
            target?.defaultBranch,
            'lifecycle-authority-default-branch-invalid'
        )
        return Object.freeze({
            repository: target.repository,
            repositoryPath: path.resolve(target.repositoryPath),
            defaultBranch: target.defaultBranch
        })
    }).sort((left, right) =>
        left.repository.localeCompare(right.repository))
}

function remoteDefaultBranchObservation(repositoryPath) {
    const result = git(
        repositoryPath,
        ['ls-remote', '--symref', 'origin', 'HEAD'],
        'lifecycle-authority-default-branch-unobservable'
    )
    const lines = result.split('\n')
    const symbolic = lines.find((value) =>
        value.startsWith('ref: refs/heads/'))
    const match = symbolic?.match(/^ref: refs\/heads\/(.+)\s+HEAD$/u)
    const headLine = lines.find((value) =>
        /^[a-f0-9]{40}\s+HEAD$/u.test(value))
    const sha = headLine?.split(/\s+/u)[0]
    if (!match || !SHA.test(sha ?? '')) {
        fail('lifecycle-authority-default-branch-unobservable')
    }
    return Object.freeze({
        defaultBranch: match[1],
        head: sha
    })
}

function remoteBranchHead(repositoryPath, expectedDefaultBranch) {
    const observation = remoteDefaultBranchObservation(repositoryPath)
    if (observation.defaultBranch !== expectedDefaultBranch) {
        fail('lifecycle-authority-default-branch-drift')
    }
    return observation.head
}

function compileRepositoryBindings({
    repositoryTargets,
    runtimeTrustBinding
}) {
    const identityByRepository = new Map(
        runtimeTrustBinding.repositoryIdentities.map((identity) => [
            identity.repository.toLowerCase(),
            identity
        ])
    )
    return repositoryTargets.map((target) => {
        const identity = identityByRepository.get(
            target.repository.toLowerCase()
        )
        if (!identity ||
            path.resolve(identity.canonicalPath) !==
                path.resolve(target.repositoryPath)) {
            fail('lifecycle-authority-repository-identity-mismatch')
        }
        const observation = remoteDefaultBranchObservation(
            identity.canonicalPath
        )
        if (observation.defaultBranch !== target.defaultBranch) {
            fail('lifecycle-authority-default-branch-drift')
        }
        const observedDefaultBranchHead = observation.head
        const binding = seal({
            schema: REPOSITORY_SCHEMA,
            repository: identity.repository,
            canonicalPath: identity.canonicalPath,
            remoteUrl: identity.remoteUrl,
            remoteIdentityDigest: identity.remoteIdentityDigest,
            defaultBranch: target.defaultBranch,
            runtimeTrustBindingDigest:
                runtimeTrustBinding.bindingDigest
        }, 'bindingDigest')
        return Object.freeze({
            ...binding,
            observedDefaultBranchHead
        })
    })
}

function stateRootIdentity({
    stateRoot,
    repositoryTargets,
    workspaces,
    worktrees
}) {
    const validation = validateStateRoot({
        candidate: stateRoot,
        repositories: repositoryTargets.map(
            ({ repositoryPath }) => repositoryPath
        ),
        workspaces,
        worktrees
    })
    if (validation?.schema !==
            'issue-orchestration.state-root-validation.v1' ||
        validation.valid !== true) {
        fail('lifecycle-authority-state-root-invalid')
    }
    return seal({
        schema: STATE_ROOT_SCHEMA,
        status: 'verified',
        canonicalPath: validation.candidate.canonical,
        filesystem: clone(validation.candidate.filesystem),
        protectedRootsDigest: digest(
            validation.protectedRoots.map((entry) => ({
                kind: entry.kind,
                canonical: entry.canonical,
                identity: entry.identity,
                filesystem: entry.filesystem
            }))
        )
    }, 'identityDigest')
}

function runtimeCapabilityBinding({ startup, slotCapacity }) {
    const startupBinding = requireRuntimeStartupBinding({ startup })
    const capacity = startup?.observation?.capacity
    if (capacity?.status !== 'observed' ||
        capacity.multiAgentV2 !== true ||
        !Number.isInteger(capacity.maxConcurrentThreadsPerSession) ||
        capacity.maxConcurrentThreadsPerSession < 1) {
        fail('lifecycle-authority-capacity-unobservable')
    }
    if (!Number.isInteger(slotCapacity) || slotCapacity < 1 ||
        slotCapacity > capacity.maxConcurrentThreadsPerSession) {
        fail('lifecycle-authority-slot-capacity-invalid')
    }
    return seal({
        schema: CAPABILITY_SCHEMA,
        status: 'verified',
        producerAuthority: 'runtime-startup-attestation',
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeInvocationId:
            startupBinding.runtimeInvocationId,
        runtimeSessionId:
            startupBinding.runtimeSessionId,
        rootAuthorityEpoch:
            startupBinding.rootAuthorityEpoch,
        runtimeId: startup.attestation.runtimeId,
        effectiveMultiAgentBackend:
            startup.attestation.effectiveMultiAgentBackend,
        multiAgentV2: capacity.multiAgentV2,
        maxConcurrentThreadsPerSession:
            capacity.maxConcurrentThreadsPerSession,
        slotCapacity,
        capacityDigest: startup.attestation.capacityDigest
    }, 'bindingDigest')
}

function expectedAuthorityKind(startup) {
    const binding = requireRuntimeStartupBinding({ startup })
    if (binding.rootPhase === 'scheduling' &&
        startup?.takeoverContext == null) {
        return 'genesis'
    }
    if (binding.rootPhase === 'recovery-takeover' &&
        startup?.takeoverContext) {
        return 'takeover'
    }
    fail('lifecycle-authority-root-phase-invalid')
}

function compileAuthority({
    authorityKind,
    runId,
    startup,
    stateRoot,
    repositoryTargets,
    workspaces,
    worktrees = [],
    slotCapacity,
    createdAt
}) {
    assertText(runId, 'lifecycle-authority-run-id-invalid')
    assertText(createdAt, 'lifecycle-authority-created-at-invalid')
    const startupBinding = requireRuntimeStartupBinding({ startup })
    const expectedKind = expectedAuthorityKind(startup)
    if (authorityKind !== expectedKind) {
        fail('lifecycle-authority-kind-invalid')
    }
    if (authorityKind === 'takeover' &&
        startup.takeoverContext.authorization.runId !== runId) {
        fail('lifecycle-authority-takeover-run-mismatch')
    }
    const targets = normalizeTargets(repositoryTargets)
    const workspacePaths = assertArray(
        workspaces,
        'lifecycle-authority-workspaces-invalid',
        { min: 1 }
    ).map((value) => path.resolve(value)).sort()
    const worktreePaths = assertArray(
        worktrees,
        'lifecycle-authority-worktrees-invalid'
    ).map((value) => path.resolve(value)).sort()
    const runtimeTrustBinding = compileRuntimeTrustBinding({
        mode: startup.attestation.trustMode,
        role: 'root-scheduler',
        executionClass: 'root-control',
        runtimeId: startup.attestation.runtimeId,
        multiAgentBackend:
            startup.attestation.effectiveMultiAgentBackend,
        approvalPolicy:
            startup.attestation.effectiveApprovalPolicy,
        effectivePermissionProfile:
            startup.attestation.effectivePermissionProfile,
        permissionProfileObserved: true,
        repositoryTargets: targets,
        startup
    })
    validateRuntimeTrustBinding(runtimeTrustBinding, {
        expectedRole: 'root-scheduler',
        expectedExecutionClass: 'root-control',
        expectedRepositories: targets.map(
            ({ repository }) => repository
        ),
        repositoryTargets: targets,
        startup
    })
    const repositoryBindings = compileRepositoryBindings({
        repositoryTargets: targets,
        runtimeTrustBinding
    })
    const stateRootReceipt = stateRootIdentity({
        stateRoot,
        repositoryTargets: targets,
        workspaces: workspacePaths,
        worktrees: worktreePaths
    })
    const capability = runtimeCapabilityBinding({
        startup,
        slotCapacity
    })
    const policySetDigest = digest(
        startup.attestation.policyDigests
    )
    const staticRepositoryBindings = repositoryBindings.map(
        ({ observedDefaultBranchHead, ...binding }) => binding
    )
    const binding = seal({
        schema: BINDING_SCHEMA,
        authorityKind,
        runId,
        startupObservationDigest:
            startup.attestation.observationDigest,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeInvocationId:
            startupBinding.runtimeInvocationId,
        runtimeSessionId:
            startupBinding.runtimeSessionId,
        rootRole: 'root-scheduler',
        rootPhase: startupBinding.rootPhase,
        rootProfile: startupBinding.rootProfile,
        effectiveModel: startup.attestation.effectiveModel,
        effectiveEffort: startup.attestation.effectiveEffort,
        effectiveMultiAgentBackend:
            startup.attestation.effectiveMultiAgentBackend,
        effectiveApprovalPolicy:
            startup.attestation.effectiveApprovalPolicy,
        effectivePermissionProfile:
            startup.attestation.effectivePermissionProfile,
        permissionInheritance:
            startup.attestation.permissionInheritance,
        permissionGuarantee:
            startup.attestation.permissionGuarantee,
        rootAuthorityEpoch:
            startupBinding.rootAuthorityEpoch,
        recoveryAuthorizationDigest:
            startupBinding.recoveryAuthorizationDigest,
        takeoverHandoffDigest:
            startupBinding.takeoverHandoffDigest,
        oldRootFencingReceiptDigest:
            startupBinding.oldRootFencingReceiptDigest,
        packageDigest: startup.attestation.packageDigest,
        manifestDigest: startup.attestation.manifestDigest,
        policySetDigest,
        runtimeTrustBindingDigest:
            runtimeTrustBinding.bindingDigest,
        runtimeTrustMode: runtimeTrustBinding.mode,
        repositoryIdentitySetDigest:
            runtimeTrustBinding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest:
            digest(staticRepositoryBindings),
        stateRootIdentityDigest: stateRootReceipt.identityDigest,
        runtimeCapabilityBindingDigest:
            capability.bindingDigest
    }, 'bindingDigest')
    return seal({
        schema: AUTHORITY_SCHEMA,
        status: 'verified',
        producerAuthority: 'machine-lifecycle-genesis-authority',
        authorityKind,
        runId,
        createdAt,
        repositoryTargets: targets,
        workspaces: workspacePaths,
        worktrees: worktreePaths,
        runtimeTrustBinding,
        repositoryBindings,
        stateRootIdentity: stateRootReceipt,
        runtimeCapabilityBinding: capability,
        binding
    }, 'authorityDigest')
}

export function compileLifecycleRunGenesisAuthority(input = {}) {
    return compileAuthority({
        ...input,
        authorityKind: 'genesis'
    })
}

export function compileLifecycleRunTakeoverAuthority(input = {}) {
    return compileAuthority({
        ...input,
        authorityKind: 'takeover'
    })
}

export function validateLifecycleRunAuthority(
    value,
    { startup, expectedKind, expectedRunId, expectedStateRoot } = {}
) {
    if (value?.schema !== AUTHORITY_SCHEMA ||
        value.status !== 'verified' ||
        value.producerAuthority !==
            'machine-lifecycle-genesis-authority' ||
        !HASH.test(value.authorityDigest ?? '') ||
        value.authorityDigest !==
            unsignedDigest(value, 'authorityDigest')) {
        fail('lifecycle-authority-invalid')
    }
    if (expectedKind !== undefined &&
        value.authorityKind !== expectedKind) {
        fail('lifecycle-authority-kind-invalid')
    }
    if (expectedRunId !== undefined && value.runId !== expectedRunId) {
        fail('lifecycle-authority-run-id-invalid')
    }
    if (expectedStateRoot !== undefined &&
        path.resolve(value.stateRootIdentity.canonicalPath) !==
            path.resolve(expectedStateRoot)) {
        fail('lifecycle-authority-state-root-mismatch')
    }
    const recomputed = compileAuthority({
        authorityKind: value.authorityKind,
        runId: value.runId,
        startup,
        stateRoot: value.stateRootIdentity.canonicalPath,
        repositoryTargets: value.repositoryTargets,
        workspaces: value.workspaces,
        worktrees: value.worktrees,
        slotCapacity:
            value.runtimeCapabilityBinding.slotCapacity,
        createdAt: value.createdAt
    })
    const stable = (authority) => {
        const result = structuredClone(authority)
        result.repositoryBindings = result.repositoryBindings.map(
            ({ observedDefaultBranchHead, ...binding }) => binding
        )
        // validateStateRoot above re-proves disjointness against the current
        // repository/worktree inventory. That inventory is intentionally
        // mutable across dispatch, landing, and cleanup, so it must not make
        // the otherwise identical lifecycle authority drift merely because a
        // canonical worktree was added or retired.
        delete result.stateRootIdentity.protectedRootsDigest
        delete result.stateRootIdentity.identityDigest
        delete result.binding.stateRootIdentityDigest
        delete result.binding.bindingDigest
        delete result.authorityDigest
        return result
    }
    if (!sameValue(stable(recomputed), stable(value))) {
        fail('lifecycle-authority-drift')
    }
    return value
}

export function validateLifecycleAuthorityBinding(value) {
    if (value?.schema !== BINDING_SCHEMA ||
        !HASH.test(value.bindingDigest ?? '') ||
        value.bindingDigest !== unsignedDigest(value, 'bindingDigest')) {
        fail('lifecycle-authority-binding-invalid')
    }
    for (const field of [
        'startupObservationDigest',
        'startupAttestationDigest',
        'packageDigest',
        'manifestDigest',
        'policySetDigest',
        'runtimeTrustBindingDigest',
        'repositoryIdentitySetDigest',
        'repositoryBindingSetDigest',
        'stateRootIdentityDigest',
        'runtimeCapabilityBindingDigest'
    ]) assertDigest(value[field], 'lifecycle-authority-binding-invalid')
    for (const field of [
        'runId', 'runtimeInvocationId', 'runtimeSessionId',
        'rootRole', 'rootPhase', 'rootProfile', 'rootAuthorityEpoch'
    ]) assertText(value[field], 'lifecycle-authority-binding-invalid')
    return value
}


function bindSelectorToRemoteObservation(receipt, continuation) {
    if (continuation === undefined || continuation === null) return receipt
    if (continuation?.schema !== REMOTE_CONTINUATION_SCHEMA ||
        continuation.status !== 'verified' ||
        continuation.producerAuthority !==
            'trusted-remote-observation-adapter' ||
        continuation.rootAuthored !== false ||
        continuation.selectorDigest !== receipt.selectorDigest ||
        continuation.remoteQueryIdentity !==
            receipt.remoteQueryIdentity ||
        continuation.remoteSnapshotDigest !==
            receipt.remoteSnapshotDigest ||
        continuation.remoteObservationSnapshotDigest !==
            receipt.remoteObservationSnapshotDigest ||
        typeof continuation.observedAt !== 'string' ||
        continuation.observedAt.length === 0 ||
        !([continuation.observationCursor,
            continuation.conditionalIdentity].some((value) =>
            typeof value === 'string' && value.length > 0))) {
        fail('lifecycle-remote-observation-continuation-invalid')
    }
    for (const field of ['observationCursor', 'conditionalIdentity']) {
        const value = continuation[field]
        if (value !== null && value !== undefined &&
            (typeof value !== 'string' || value.length === 0)) {
            fail('lifecycle-remote-observation-continuation-invalid')
        }
    }
    const bound = {
        ...clone(receipt),
        remoteObservationContinuation: clone(continuation)
    }
    delete bound.receiptDigest
    bound.receiptDigest = digest(bound)
    return verifySelectorReceipt(bound)
}

function bindSelectorToAuthority(receipt, lifecycleAuthority) {
    const bound = {
        ...clone(receipt),
        lifecycleAuthorityBindingDigest:
            lifecycleAuthority.binding.bindingDigest,
        startupAttestationDigest:
            lifecycleAuthority.binding.startupAttestationDigest,
        runtimeInvocationId:
            lifecycleAuthority.binding.runtimeInvocationId,
        runtimeSessionId:
            lifecycleAuthority.binding.runtimeSessionId,
        rootAuthorityEpoch:
            lifecycleAuthority.binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest:
            lifecycleAuthority.binding.runtimeTrustBindingDigest,
        repositoryBindingSetDigest:
            lifecycleAuthority.binding.repositoryBindingSetDigest
    }
    delete bound.receiptDigest
    bound.receiptDigest = digest(bound)
    return Object.freeze(bound)
}

export function resolveLifecycleSelector({
    lifecycleAuthority,
    startup,
    remoteObservationContinuation = null,
    ...selectorInput
} = {}) {
    validateLifecycleRunAuthority(lifecycleAuthority, { startup })
    const receipt = resolveSelector({
        ...selectorInput,
        startup
    })
    const observed = bindSelectorToRemoteObservation(
        receipt,
        remoteObservationContinuation
    )
    return bindSelectorToAuthority(observed, lifecycleAuthority)
}

export function bindLifecycleSelectorRemoteObservation({
    lifecycleAuthority,
    startup,
    selectorReceipt,
    remoteObservationContinuation
} = {}) {
    validateLifecycleRunAuthority(lifecycleAuthority, { startup })
    const receipt = resolveSelectorReceiptForRebind(selectorReceipt)
    const observed = bindSelectorToRemoteObservation(
        receipt,
        remoteObservationContinuation
    )
    return bindSelectorToAuthority(observed, lifecycleAuthority)
}

export function rebindLifecycleSelectorAuthority({
    lifecycleAuthority,
    startup,
    selectorReceipt
} = {}) {
    validateLifecycleRunAuthority(lifecycleAuthority, { startup })
    const receipt = resolveSelectorReceiptForRebind(selectorReceipt)
    return bindSelectorToAuthority(receipt, lifecycleAuthority)
}

function resolveSelectorReceiptForRebind(selectorReceipt) {
    if (!selectorReceipt || typeof selectorReceipt !== 'object' ||
        Array.isArray(selectorReceipt)) {
        fail('lifecycle-authority-selector-invalid')
    }
    const copy = clone(selectorReceipt)
    delete copy.lifecycleAuthorityBindingDigest
    delete copy.startupAttestationDigest
    delete copy.runtimeInvocationId
    delete copy.runtimeSessionId
    delete copy.rootAuthorityEpoch
    delete copy.runtimeTrustBindingDigest
    delete copy.repositoryBindingSetDigest
    delete copy.receiptDigest
    copy.receiptDigest = digest(copy)
    try {
        return resolveSelectorReceiptVerification(copy)
    } catch {
        fail('lifecycle-authority-selector-invalid')
    }
}

function resolveSelectorReceiptVerification(receipt) {
    return verifySelectorReceipt(receipt)
}

export function repositoryAuthorityFor(
    lifecycleAuthority,
    repository
) {
    validateLifecycleAuthorityBinding(lifecycleAuthority?.binding)
    const binding = lifecycleAuthority.repositoryBindings.find(
        (entry) => entry.repository.toLowerCase() ===
            repository.toLowerCase()
    )
    if (!binding) fail('lifecycle-authority-repository-unbound')
    return binding
}

export function currentRepositoryHeads(lifecycleAuthority) {
    return Object.fromEntries(
        lifecycleAuthority.repositoryBindings.map((binding) => [
            binding.repository,
            remoteBranchHead(
                binding.canonicalPath,
                binding.defaultBranch
            )
        ])
    )
}

export function lifecycleAuthorityBinding(value) {
    return validateLifecycleAuthorityBinding(value?.binding)
}

export function lifecycleAuthoritySchemas() {
    return Object.freeze({
        authority: AUTHORITY_SCHEMA,
        binding: BINDING_SCHEMA,
        capability: CAPABILITY_SCHEMA,
        stateRoot: STATE_ROOT_SCHEMA,
        repository: REPOSITORY_SCHEMA
    })
}
