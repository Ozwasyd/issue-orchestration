import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
    assertArray,
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal
} from './runtime-contract-lib.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/runtime-trust-policy.json'
)

export const RUNTIME_TRUST_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const RUNTIME_TRUST_POLICY_DIGEST = digest(RUNTIME_TRUST_POLICY)

const EXECUTION_CLASSES = new Set([
    'root-control',
    'observe-only',
    'leased-writer'
])
const EVIDENCE_CLASSES = new Set(['route', 'run', 'terminal'])

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

function canonicalRepositoryFromRemote(remoteUrl) {
    const value = remoteUrl.trim()
    const patterns = [
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu,
        /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/iu,
        /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu
    ]
    for (const pattern of patterns) {
        const match = value.match(pattern)
        if (match) return `${match[1]}/${match[2]}`
    }
    fail('runtime-trust-repository-identity-unresolved')
}

export function resolveTrustedRepositoryIdentity({
    repository,
    repositoryPath
} = {}) {
    assertText(repository, 'runtime-trust-repository-identity-unresolved')
    assertText(
        repositoryPath,
        'runtime-trust-repository-identity-unresolved'
    )
    let canonicalPath
    try {
        canonicalPath = fs.realpathSync(repositoryPath)
    } catch {
        fail('runtime-trust-repository-identity-unresolved')
    }
    const insideWorktree = git(
        canonicalPath,
        ['rev-parse', '--is-inside-work-tree'],
        'runtime-trust-repository-identity-unresolved'
    )
    if (insideWorktree !== 'true') {
        fail('runtime-trust-repository-identity-unresolved')
    }
    const remoteUrl = git(
        canonicalPath,
        ['config', '--get', 'remote.origin.url'],
        'runtime-trust-repository-identity-unresolved'
    )
    const resolvedRepository = canonicalRepositoryFromRemote(remoteUrl)
    if (resolvedRepository.toLowerCase() !== repository.toLowerCase()) {
        fail('runtime-trust-repository-identity-mismatch')
    }
    return Object.freeze({
        repository: resolvedRepository,
        canonicalPath,
        remoteUrl,
        remoteIdentityDigest: digest({
            repository: resolvedRepository.toLowerCase(),
            canonicalPath,
            remoteUrl
        })
    })
}

function validatePolicy() {
    const trusted =
        RUNTIME_TRUST_POLICY.modes?.['trusted-owner-repositories']
    const strict =
        RUNTIME_TRUST_POLICY.modes?.['strict-machine-isolation']
    if (RUNTIME_TRUST_POLICY.schema !==
            'issue-orchestration.runtime-trust-policy.v2' ||
        RUNTIME_TRUST_POLICY.defaultMode !==
            'trusted-owner-repositories' ||
        trusted?.mode !== 'trusted-owner-repositories' ||
        trusted.enabled !== true ||
        trusted.rootPermissionProfile !== 'danger-full-access' ||
        trusted.approvalPolicy !== 'never' ||
        trusted.childPermissionInheritance !==
            'inherited-parent-profile' ||
        trusted.machineEnforcedRoleIsolation !== false ||
        trusted.semanticRoleIsolation !==
            'execution-class-and-receipt' ||
        trusted.mutationPostconditionRequired !== true ||
        trusted.permissionGuarantee !==
            'contract-and-postcondition' ||
        trusted.repositoryAdmission !==
            'caller-supplied-operator-owned-remote-identity' ||
        strict?.mode !== 'strict-machine-isolation' ||
        strict.enabled !== false ||
        strict.machineEnforcedRoleIsolation !== true ||
        strict.repositoryAdmission !==
            'caller-supplied-operator-owned-remote-identity') {
        fail('runtime-trust-policy-invalid')
    }
}

function modePolicy(mode) {
    validatePolicy()
    const selected = RUNTIME_TRUST_POLICY.modes?.[mode]
    if (!selected) fail('runtime-trust-mode-unknown')
    if (selected.enabled !== true) fail('runtime-trust-mode-not-enabled')
    return selected
}

function validateSemanticIdentity({ role, executionClass }) {
    assertText(role, 'runtime-trust-role-invalid')
    if (!EXECUTION_CLASSES.has(executionClass)) {
        fail('runtime-trust-execution-class-invalid')
    }
    if ((role === 'root-scheduler') !==
            (executionClass === 'root-control')) {
        fail('runtime-trust-root-semantic-boundary')
    }
}

export function compileRuntimeTrustBinding({
    mode = RUNTIME_TRUST_POLICY.defaultMode,
    role,
    executionClass,
    runtimeId = 'codex',
    multiAgentBackend,
    approvalPolicy,
    effectivePermissionProfile,
    permissionProfileObserved,
    repositoryTargets,
    startup
} = {}) {
    const selected = modePolicy(mode)
    validateSemanticIdentity({ role, executionClass })
    if (approvalPolicy !== selected.approvalPolicy ||
        effectivePermissionProfile !==
            selected.rootPermissionProfile ||
        permissionProfileObserved !== true) {
        fail('runtime-trust-permission-profile-invalid')
    }
    if (runtimeId === 'codex' && multiAgentBackend !== 'v2') {
        fail('runtime-trust-codex-v2-required')
    }
    const startupBinding = requireRuntimeStartupBinding({ startup })
    if (startup?.attestation?.runtimeId !== runtimeId ||
        startup?.observation?.effectiveMultiAgentBackend !==
            multiAgentBackend ||
        startup?.observation?.effectivePermissionProfile !==
            effectivePermissionProfile ||
        startup?.observation?.effectiveApprovalPolicy !==
            approvalPolicy) {
        fail('runtime-trust-startup-binding-mismatch')
    }
    assertText(multiAgentBackend, 'runtime-trust-backend-unobserved')
    const targets = assertArray(
        repositoryTargets,
        'runtime-trust-repository-identity-unresolved',
        { min: 1 }
    )
    const identities = targets.map((target) =>
        resolveTrustedRepositoryIdentity(target))
        .sort((left, right) =>
            left.repository.localeCompare(right.repository))
    if (new Set(identities.map(({ repository }) =>
        repository.toLowerCase())).size !== identities.length) {
        fail('runtime-trust-repository-duplicate')
    }
    return seal({
        schema: 'issue-orchestration.runtime-trust-binding.v1',
        policyDigest: RUNTIME_TRUST_POLICY_DIGEST,
        mode,
        role,
        executionClass,
        runtimeId,
        multiAgentBackend,
        approvalPolicy,
        effectivePermissionProfile,
        permissionProfileObserved: true,
        childPermissionInheritance:
            selected.childPermissionInheritance,
        machineEnforcedRoleIsolation:
            selected.machineEnforcedRoleIsolation,
        semanticRoleIsolation: selected.semanticRoleIsolation,
        mutationPostconditionRequired:
            selected.mutationPostconditionRequired,
        permissionGuarantee: selected.permissionGuarantee,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeInvocationId:
            startupBinding.runtimeInvocationId,
        runtimeSessionId:
            startupBinding.runtimeSessionId,
        repositoryIdentities: identities,
        repositoryIdentitySetDigest: digest(identities)
    }, 'bindingDigest')
}

export function validateRuntimeTrustBinding(value, {
    expectedRole,
    expectedExecutionClass,
    expectedRepositories,
    repositoryTargets,
    startup
} = {}) {
    const selected = modePolicy(value?.mode)
    if (value?.schema !==
            'issue-orchestration.runtime-trust-binding.v1' ||
        value.policyDigest !== RUNTIME_TRUST_POLICY_DIGEST) {
        fail('runtime-trust-binding-invalid')
    }
    assertDigest(value.bindingDigest, 'runtime-trust-binding-invalid')
    const unsigned = structuredClone(value)
    delete unsigned.bindingDigest
    if (value.bindingDigest !== digest(unsigned)) {
        fail('runtime-trust-binding-invalid')
    }
    validateSemanticIdentity(value)
    if (expectedRole !== undefined && value.role !== expectedRole) {
        fail('runtime-trust-role-invalid')
    }
    if (expectedExecutionClass !== undefined &&
        value.executionClass !== expectedExecutionClass) {
        fail('runtime-trust-execution-class-invalid')
    }
    if (value.approvalPolicy !== selected.approvalPolicy ||
        value.effectivePermissionProfile !==
            selected.rootPermissionProfile ||
        value.permissionProfileObserved !== true ||
        value.childPermissionInheritance !==
            selected.childPermissionInheritance ||
        value.machineEnforcedRoleIsolation !==
            selected.machineEnforcedRoleIsolation ||
        value.semanticRoleIsolation !==
            selected.semanticRoleIsolation ||
        value.mutationPostconditionRequired !== true ||
        value.permissionGuarantee !==
            selected.permissionGuarantee ||
        (value.runtimeId === 'codex' &&
            value.multiAgentBackend !== 'v2')) {
        fail('runtime-trust-permission-profile-invalid')
    }
    assertDigest(
        value.startupAttestationDigest,
        'runtime-trust-startup-binding-mismatch'
    )
    assertText(
        value.runtimeInvocationId,
        'runtime-trust-startup-binding-mismatch'
    )
    assertText(
        value.runtimeSessionId,
        'runtime-trust-startup-binding-mismatch'
    )
    if (startup !== undefined) {
        const startupBinding =
            requireRuntimeStartupBinding({ startup })
        if (value.startupAttestationDigest !==
                startupBinding.startupAttestationDigest ||
            value.runtimeInvocationId !==
                startupBinding.runtimeInvocationId ||
            value.runtimeSessionId !==
                startupBinding.runtimeSessionId) {
            fail('runtime-trust-startup-binding-mismatch')
        }
    }
    const identities = assertArray(
        value.repositoryIdentities,
        'runtime-trust-repository-identity-unresolved',
        { min: 1 }
    )
    if (value.repositoryIdentitySetDigest !== digest(identities) ||
        new Set(identities.map(({ repository }) =>
            repository.toLowerCase())).size !== identities.length) {
        fail('runtime-trust-repository-identity-mismatch')
    }
    for (const identity of identities) {
        if (typeof identity.repository !== 'string' ||
            !/^[^/\s]+\/[^/\s]+$/u.test(identity.repository) ||
            identity.remoteIdentityDigest !== digest({
                repository: identity.repository.toLowerCase(),
                canonicalPath: identity.canonicalPath,
                remoteUrl: identity.remoteUrl
            })) {
            fail('runtime-trust-repository-identity-mismatch')
        }
    }
    if (expectedRepositories !== undefined) {
        const expected = [...new Set(expectedRepositories)].sort()
        const actual = identities.map(({ repository }) =>
            repository).sort()
        if (!sameValue(actual, expected)) {
            fail('runtime-trust-repository-scope-mismatch')
        }
    }
    if (repositoryTargets !== undefined) {
        const current = assertArray(
            repositoryTargets,
            'runtime-trust-repository-identity-unresolved',
            { min: 1 }
        ).map((target) =>
            resolveTrustedRepositoryIdentity(target))
            .sort((left, right) =>
                left.repository.localeCompare(right.repository))
        if (!sameValue(current, identities)) {
            fail('runtime-trust-repository-identity-drift')
        }
    }
    return value
}

export function compileRuntimePermissionEvidence({
    binding,
    evidenceClass,
    repositoryTargets,
    startup
} = {}) {
    if (!EVIDENCE_CLASSES.has(evidenceClass)) {
        fail('runtime-permission-evidence-class-invalid')
    }
    validateRuntimeTrustBinding(binding, {
        repositoryTargets,
        startup
    })
    return seal({
        schema: 'issue-orchestration.runtime-permission-evidence.v1',
        evidenceClass,
        runtimeTrustBindingDigest: binding.bindingDigest,
        startupAttestationDigest:
            binding.startupAttestationDigest,
        runtimeInvocationId:
            binding.runtimeInvocationId,
        runtimeTrustMode: binding.mode,
        role: binding.role,
        executionClass: binding.executionClass,
        effectivePermissionProfile:
            binding.effectivePermissionProfile,
        permissionInheritance:
            binding.childPermissionInheritance,
        permissionGuarantee: binding.permissionGuarantee,
        machineEnforcedRoleIsolation:
            binding.machineEnforcedRoleIsolation,
        semanticRoleIsolation: binding.semanticRoleIsolation,
        mutationPostconditionRequired:
            binding.mutationPostconditionRequired,
        repositoryIdentitySetDigest:
            binding.repositoryIdentitySetDigest
    }, 'evidenceDigest')
}
