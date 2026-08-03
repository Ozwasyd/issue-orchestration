import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    compileRuntimePermissionEvidence,
    compileRuntimeTrustBinding,
    RUNTIME_TRUST_POLICY,
    validateRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const temporaryRoots = new Set()

test.after(() => {
    for (const temporaryRoot of temporaryRoots) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
})

function git(repository, ...args) {
    return execFileSync(
        'git',
        ['-C', repository, ...args],
        { encoding: 'utf8' }
    ).trim()
}

function temporaryRepository(remoteUrl) {
    const repositoryPath = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-runtime-trust-'
    ))
    temporaryRoots.add(repositoryPath)
    git(repositoryPath, 'init', '--quiet')
    if (remoteUrl !== null) {
        git(repositoryPath, 'remote', 'add', 'origin', remoteUrl)
    }
    return repositoryPath
}

const repositoryRoot = temporaryRepository(
    'https://github.com/ExampleOrg/RepositoryA.git'
)

function rootBinding(repositoryTargets = [{
    repository: 'ExampleOrg/RepositoryA',
    repositoryPath: repositoryRoot
}], startup = verifiedRuntimeStartup({})) {
    return compileRuntimeTrustBinding({
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
}

function schema(name) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', name),
        'utf8'
    ))
}

test('T04-01 validates the versioned policy, binding, and permission evidence schemas', () => {
    const startup = verifiedRuntimeStartup({})
    const binding = rootBinding(undefined, startup)
    const evidence = compileRuntimePermissionEvidence({
        binding,
        evidenceClass: 'route',
        repositoryTargets: [{
            repository: 'ExampleOrg/RepositoryA',
            repositoryPath: repositoryRoot
        }],
        startup
    })
    assert.deepEqual(validateJsonSchema(
        RUNTIME_TRUST_POLICY,
        schema('runtime-trust-policy.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        binding,
        schema('runtime-trust-binding.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        evidence,
        schema('runtime-permission-evidence.schema.json')
    ), [])
})

test('T04-02 accepts an observed unattended full-access root and records honest evidence', () => {
    const targets = [{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath: repositoryRoot
    }]
    const startup = verifiedRuntimeStartup({})
    const binding = rootBinding(targets, startup)
    assert.equal(validateRuntimeTrustBinding(binding, {
        expectedRole: 'root-scheduler',
        expectedExecutionClass: 'root-control',
        expectedRepositories: ['ExampleOrg/RepositoryA'],
        repositoryTargets: targets,
        startup
    }), binding)
    for (const evidenceClass of ['route', 'run', 'terminal']) {
        const evidence = compileRuntimePermissionEvidence({
            binding,
            evidenceClass,
            repositoryTargets: targets,
            startup
        })
        assert.equal(evidence.runtimeTrustMode,
            'trusted-owner-repositories')
        assert.equal(evidence.effectivePermissionProfile,
            'danger-full-access')
        assert.equal(evidence.permissionInheritance,
            'inherited-parent-profile')
        assert.equal(evidence.permissionGuarantee,
            'contract-and-postcondition')
        assert.equal(evidence.machineEnforcedRoleIsolation, false)
        assert.equal(evidence.mutationPostconditionRequired, true)
        assert.equal(Object.hasOwn(evidence, 'sandbox'), false)
        assert.equal(Object.hasOwn(evidence, 'childReadOnly'), false)
    }
})

test('T04-03 rejects read-only, unobserved, and non-V2 Codex root claims', () => {
    for (const overrides of [
        { effectivePermissionProfile: 'read-only' },
        { permissionProfileObserved: false },
        { multiAgentBackend: 'v1' }
    ]) {
        assert.throws(() => compileRuntimeTrustBinding({
            role: 'root-scheduler',
            executionClass: 'root-control',
            runtimeId: 'codex',
            multiAgentBackend: 'v2',
            approvalPolicy: 'never',
            effectivePermissionProfile: 'danger-full-access',
            permissionProfileObserved: true,
            repositoryTargets: [{
                repository: 'ExampleOrg/RepositoryA',
                repositoryPath: repositoryRoot
            }],
            ...overrides
        }), {
            code: overrides.multiAgentBackend
                ? 'runtime-trust-codex-v2-required'
                : 'runtime-trust-permission-profile-invalid'
        })
    }
})

test('T04-04 accepts caller-supplied repositories and rejects unresolved or mismatched identity', () => {
    const missingRemote = temporaryRepository(null)
    assert.throws(() => rootBinding([{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath: missingRemote
    }]), {
        code: 'runtime-trust-repository-identity-unresolved'
    })

    const callerSupplied = temporaryRepository(
        'https://github.com/ExampleOrg/caller-supplied.git'
    )
    const binding = rootBinding([{
        repository: 'ExampleOrg/caller-supplied',
        repositoryPath: callerSupplied
    }])
    assert.equal(binding.repositoryIdentities[0].repository,
        'ExampleOrg/caller-supplied')
    assert.throws(() => rootBinding([{
        repository: 'ExampleOrg/different',
        repositoryPath: callerSupplied
    }]), {
        code: 'runtime-trust-repository-identity-mismatch'
    })
})

test('T04-05 detects repository remote identity drift before continuation', () => {
    const repositoryPath = temporaryRepository(
        'https://github.com/ExampleOrg/RepositoryA.git'
    )
    const targets = [{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath
    }]
    const binding = rootBinding(targets)
    git(
        repositoryPath,
        'remote',
        'set-url',
        'origin',
        'https://github.com/ExampleOrg/RepositoryB.git'
    )
    assert.throws(() => validateRuntimeTrustBinding(binding, {
        repositoryTargets: targets
    }), {
        code: 'runtime-trust-repository-identity-mismatch'
    })
})

test('T04-06 rejects forged machine isolation and disabled future mode mapping', () => {
    const binding = structuredClone(rootBinding())
    binding.machineEnforcedRoleIsolation = true
    delete binding.bindingDigest
    binding.bindingDigest = digest(binding)
    assert.throws(() => validateRuntimeTrustBinding(binding), {
        code: 'runtime-trust-permission-profile-invalid'
    })
    assert.throws(() => compileRuntimeTrustBinding({
        mode: 'strict-machine-isolation',
        role: 'root-scheduler',
        executionClass: 'root-control',
        runtimeId: 'codex',
        multiAgentBackend: 'v2',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        repositoryTargets: [{
            repository: 'ExampleOrg/RepositoryA',
            repositoryPath: repositoryRoot
        }]
    }), {
        code: 'runtime-trust-mode-not-enabled'
    })
})

test('T04-07 full runtime access does not expand Root semantic authority', () => {
    assert.throws(() => compileRuntimeTrustBinding({
        role: 'root-scheduler',
        executionClass: 'leased-writer',
        runtimeId: 'codex',
        multiAgentBackend: 'v2',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        repositoryTargets: [{
            repository: 'ExampleOrg/RepositoryA',
            repositoryPath: repositoryRoot
        }]
    }), {
        code: 'runtime-trust-root-semantic-boundary'
    })
    assert.throws(() => compileRuntimeTrustBinding({
        role: 'code-implementer',
        executionClass: 'root-control',
        runtimeId: 'codex',
        multiAgentBackend: 'v2',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        repositoryTargets: [{
            repository: 'ExampleOrg/RepositoryA',
            repositoryPath: repositoryRoot
        }]
    }), {
        code: 'runtime-trust-root-semantic-boundary'
    })
})
