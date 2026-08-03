import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const packageRoot = 'skills/issue-orchestration/scripts'
const implementationRelative = `${packageRoot}/resource-lifecycle.mjs`
const implementationPath = resolve(root, implementationRelative)
const legacyOwnerRoot = '.agents/skills/issue-orchestration'
const readJson = (name) => JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
const cases = readJson('resource-lifecycle-cases.json')
const acceptance = readJson('resource-lifecycle-acceptance-map.json')
const expected = readJson('resource-lifecycle-expected-initial-failures.json')
const runtime = readJson('resource-lifecycle-runtime-probes.json')
const mutations = readJson('resource-lifecycle-mutation-controls.json')
const contract = readJson('resource-lifecycle-test-contract.json')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
const digest = (value) => sha256(JSON.stringify(canonical(value)))
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

function command(commandName, args, cwd) {
    const result = spawnSync(commandName, args, { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0,
        `${commandName} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
    return result.stdout.trim()
}

function commandResult(commandName, args, cwd) {
    return spawnSync(commandName, args, { cwd, encoding: 'utf8' })
}

function waitForText(child, expectedText, timeoutMs = 5_000) {
    return new Promise((resolvePromise, reject) => {
        let output = ''
        const timeout = setTimeout(() => {
            reject(new Error(`child ${child.pid} did not emit ${expectedText}: ${output}`))
        }, timeoutMs)
        child.stdout.on('data', (chunk) => {
            output += chunk.toString()
            if (output.includes(expectedText)) {
                clearTimeout(timeout)
                resolvePromise()
            }
        })
        child.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
        })
        child.once('exit', (code, signal) => {
            if (!output.includes(expectedText)) {
                clearTimeout(timeout)
                reject(new Error(`child ${child.pid} exited before ready (${code ?? signal}): ${output}`))
            }
        })
    })
}

async function reservePort() {
    return await new Promise((resolvePromise, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            server.close((error) => error ? reject(error) : resolvePromise(port))
        })
    })
}

async function portIsAvailable(port) {
    return await new Promise((resolvePromise) => {
        const server = net.createServer()
        server.once('error', () => resolvePromise(false))
        server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)))
    })
}

async function startPortHolder(port) {
    const program = [
        "const net = require('node:net')",
        `const server = net.createServer().listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'))`,
        'setInterval(() => {}, 1_000)',
        "process.on('SIGTERM', () => server.close(() => process.exit(0)))"
    ].join(';')
    const child = spawn(process.execPath, ['-e', program], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForText(child, 'ready')
    return child
}

function hasFlock() {
    return commandResult('flock', ['--version']).status === 0
}

async function startLockHolder(lockPath) {
    const child = spawn('flock', ['-n', lockPath, 'sh', '-c', 'printf ready; sleep 120'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForText(child, 'ready')
    return child
}

function killProcessGroup(child) {
    if (!child?.pid) return
    try {
        process.kill(-child.pid, 'SIGTERM')
    } catch {
        try {
            process.kill(child.pid, 'SIGTERM')
        } catch {
            // The lifecycle under test already reaped it.
        }
    }
}

function createSandbox() {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'fsusblog-1828-resource-'))
    const repositoryRoot = join(sandboxRoot, 'repository')
    const temporaryParent = join(sandboxRoot, 'temporary')
    const worktreePath = join(sandboxRoot, 'attempt-worktree')
    const branchName = 'attempt-1828-branch'
    const temporaryDirectory = join(temporaryParent, 'attempt-owned')
    const lockPath = join(temporaryDirectory, 'attempt.lock')
    const leasePath = join(temporaryDirectory, 'attempt.lease.json')
    mkdirSync(repositoryRoot, { recursive: true })
    mkdirSync(temporaryParent, { recursive: true })
    command('git', ['init', '--initial-branch=master'], repositoryRoot)
    command('git', ['config', 'user.email', 'resource-test@example.invalid'], repositoryRoot)
    command('git', ['config', 'user.name', 'Resource lifecycle test'], repositoryRoot)
    writeFileSync(join(repositoryRoot, 'baseline.txt'), 'baseline\n')
    command('git', ['add', 'baseline.txt'], repositoryRoot)
    command('git', ['commit', '-m', 'baseline'], repositoryRoot)

    const sandbox = {
        sandboxRoot,
        repositoryRoot,
        temporaryParent,
        worktreePath,
        branchName,
        temporaryDirectory,
        lockPath,
        leasePath,
        port: null,
        portHolder: null,
        lockHolder: null,
        baseSha: command('git', ['rev-parse', 'HEAD'], repositoryRoot),
        async createOwnedResources({ dirty = false } = {}) {
            command('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], repositoryRoot)
            mkdirSync(temporaryDirectory, { recursive: true })
            writeFileSync(leasePath, JSON.stringify({
                leaseId: cases.identities.writeLeaseId,
                runId: cases.identities.runId,
                attemptId: cases.identities.attemptId,
                ownerAttemptId: cases.identities.attemptId,
                resourceId: 'worktree-1828-owned',
                state: 'active'
            }))
            this.port = await reservePort()
            this.portHolder = await startPortHolder(this.port)
            if (hasFlock()) this.lockHolder = await startLockHolder(lockPath)
            else writeFileSync(lockPath, 'flock-unavailable\n')
            if (dirty) writeFileSync(join(worktreePath, 'dirty.txt'), 'must quarantine\n')
        },
        destroy() {
            killProcessGroup(this.portHolder)
            killProcessGroup(this.lockHolder)
            if (existsSync(worktreePath)) {
                commandResult('git', ['worktree', 'remove', '--force', worktreePath], repositoryRoot)
            }
            commandResult('git', ['worktree', 'prune'], repositoryRoot)
            commandResult('git', ['branch', '-D', branchName], repositoryRoot)
            rmSync(sandboxRoot, { recursive: true, force: true })
        }
    }
    return sandbox
}

function registryFor(sandbox, overrides = {}) {
    const identity = cases.identities
    return {
        schema: 'issue-orchestration.resource-registry.v1',
        runId: identity.runId,
        issueId: contract.issueId,
        stageAttemptId: identity.attemptId,
        stageRole: 'code-implementer',
        issueWorktreeId: 'worktree-1828-owned',
        baseSha: sandbox.baseSha,
        epochId: identity.epochId,
        allowedPathsDigest: contract.allowedPathsDigest,
        testContractDigest: contract.contractDigest,
        slotHeld: true,
        writeLease: {
            id: identity.writeLeaseId,
            ownerAttemptId: identity.attemptId,
            mode: 'write',
            state: 'active'
        },
        resources: [
            {
                resourceId: 'worktree-1828-owned',
                resourceType: 'worktree',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'git-worktree-remove-and-prune',
                identityEvidence: { path: sandbox.worktreePath, branch: sandbox.branchName, baseSha: sandbox.baseSha }
            },
            {
                resourceId: 'branch-1828-owned',
                resourceType: 'branch',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'delete-after-worktree-removed',
                identityEvidence: { name: sandbox.branchName, repositoryRoot: sandbox.repositoryRoot }
            },
            {
                resourceId: 'process-group-1828-owned',
                resourceType: 'process-group',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'term-kill-verify-descendants',
                identityEvidence: { leaderPid: sandbox.portHolder?.pid, processGroupId: sandbox.portHolder?.pid }
            },
            {
                resourceId: 'port-1828-owned',
                resourceType: 'port',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'release-after-process-group',
                identityEvidence: { port: sandbox.port, processGroupId: sandbox.portHolder?.pid }
            },
            {
                resourceId: 'temporary-directory-1828-owned',
                resourceType: 'temporary-directory',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'remove-owned-only',
                identityEvidence: { path: sandbox.temporaryDirectory }
            },
            {
                resourceId: 'lock-1828-owned',
                resourceType: 'lock',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'release-and-reacquire-observation',
                identityEvidence: { path: sandbox.lockPath, holderPid: sandbox.lockHolder?.pid }
            },
            {
                resourceId: 'lease-1828-owned',
                resourceType: 'lease',
                ownerClass: 'attempt-owned',
                ownerRunId: identity.runId,
                ownerAttemptId: identity.attemptId,
                state: 'active',
                cleanupPolicy: 'release-after-verified-cleanup',
                identityEvidence: { path: sandbox.leasePath, ownerAttemptId: identity.attemptId }
            }
        ],
        ...overrides
    }
}

let implementationPromise
let gitCleanupPromise
async function implementation() {
    assert.equal(existsSync(implementationPath), true,
        `missing #1828 current resource lifecycle owner: ${implementationRelative}`)
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of cases.requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing export ${name}`)
    }
    return loaded
}

async function gitCleanup() {
    gitCleanupPromise ??= import(pathToFileURL(resolve(
        root,
        `${packageRoot}/git-resource-cleanup.mjs`
    )).href)
    return await gitCleanupPromise
}

async function retireSandboxGitResources(sandbox) {
    const loaded = await gitCleanup()
    const identity = cases.identities
    const authority = loaded.sealMachineReceipt({
        schema:
            'issue-orchestration.git-resource-root-authority.v1',
        actorRole: 'root-control',
        runId: identity.runId,
        rootAuthorityEpoch: 'root-epoch-1828-cleanup',
        actorInvocationId: 'root-invocation-1828-cleanup',
        issuedAt: '2026-08-03T08:30:00.000Z'
    }, 'authorityDigest')
    let state = loaded.createGitResourceCleanup({
        authority,
        repositoryId: 'fixture/resource-lifecycle',
        repositoryPath: sandbox.repositoryRoot,
        worktreePath: sandbox.worktreePath,
        worktreeResourceId: 'worktree-1828-owned',
        branchResourceId: 'branch-1828-owned',
        branchRef: `refs/heads/${sandbox.branchName}`,
        defaultBranchRef: 'refs/heads/master',
        baseSha: sandbox.baseSha,
        candidateSha: command(
            'git',
            ['rev-parse', 'HEAD'],
            sandbox.worktreePath
        ),
        deliveryEpoch: identity.epochId,
        attemptId: identity.attemptId,
        stageRole: 'code-implementer',
        sliceId: 'slice-1828-cleanup',
        leaseId: identity.writeLeaseId,
        leasePath: sandbox.leasePath,
        slotId: 'slot-1828-owned'
    })
    state = loaded.freezeGitResource({
        state,
        authority,
        dispatchBlocked: true,
        writerAuthorityRevoked: true,
        cleanupAuthorityPreserved: true
    }).state
    const inventoried = loaded.inventoryGitResource({
        state,
        authority
    })
    state = inventoried.state
    const disposition = inventoried.inventory.dirty
        ? loaded.proveCandidateDisposition({
                state,
                authority,
                inventory: inventoried.inventory,
                disposition: 'quarantined',
                quarantineRoot: sandbox.sandboxRoot,
                reasonCodes: ['dirty-worktree']
            })
        : loaded.proveCandidateDisposition({
                state,
                authority,
                inventory: inventoried.inventory,
                disposition: 'discard-authorized',
                failureReceiptDigest: 'f'.repeat(64)
            })
    state = loaded.confirmGitResourceProcessesStopped({
        state: disposition.state,
        authority
    }).state
    state = loaded.removeGitWorktree({
        state,
        authority,
        inventory: inventoried.inventory
    }).state
    state = loaded.retireGitLocalRef({
        state,
        authority,
        inventory: inventoried.inventory
    }).state
    const slotObservation = loaded.sealMachineReceipt({
        schema:
            'issue-orchestration.resource-slot-release-observation.v1',
        producerAuthority: 'machine-resource-slot-registry',
        runId: identity.runId,
        attemptId: identity.attemptId,
        resourceId: 'worktree-1828-owned',
        slotId: 'slot-1828-owned',
        releaseAuthorized: true,
        released: false,
        activeResourceReferences: [],
        observedAt: '2026-08-03T08:31:00.000Z'
    }, 'observationDigest')
    state = loaded.releaseGitResourceLeaseAndSlot({
        state,
        authority,
        inventory: inventoried.inventory,
        slotReleaseObservation: slotObservation
    }).state
    return loaded.verifyGitResourceCleanup({
        state,
        inventory: inventoried.inventory
    }).receipt
}

function assertErrorCode(operation, code) {
    assert.throws(operation, (error) => error?.code === code,
        `expected ResourceLifecycleError ${code}`)
}

test('frozen #1828 v3 contract is self-consistent and scoped to current package authority', () => {
    assert.equal(contract.schema, 'issue-orchestration.resource-lifecycle-test-contract.v3')
    assert.equal(contract.owner.id, 'test-owner-1828')
    assert.equal(contract.owner.profile, 'gpt-5.6-terra/max')
    assert.equal(contract.issueId, 'Ozwasyd/FsusBlog#1828')
    assert.equal(contract.base.sha, cases.baseSha)
    assert.equal(contract.status, 'frozen-red')
    assert.equal(contract.currentOwner.resourceLifecycle, implementationRelative)
    assert.deepEqual(contract.allowedPaths.test, contract.allowedTestPaths)
    assert.deepEqual(contract.allowedPaths.implementation, contract.allowedImplementationPaths)
    assert.deepEqual(Object.keys(contract.fileHashes).sort(), contract.allowedTestPaths
        .filter((path) => path !== 'tests/fixtures/issue-orchestration/resource-lifecycle-test-contract.json')
        .sort())
    for (const [relative, expectedHash] of Object.entries(contract.fileHashes)) {
        assert.equal(sha256(readFileSync(resolve(root, relative))), expectedHash, `${relative} drifted`)
    }
    assert.equal(digest(contract.fileHashes), contract.frozenTreeDigest)
    const unsigned = structuredClone(contract)
    delete unsigned.contractDigest
    assert.equal(digest(unsigned), contract.contractDigest)
    assert.equal(HASH.test(contract.contractDigest), true)
    assert.equal(HASH.test(contract.frozenTreeDigest), true)
    assert.equal(HASH.test(contract.allowedPathsDigest), true)
})

test('historical #1828 delivery is a tombstone, not current owner or acceptance authority', () => {
    assert.equal(existsSync(resolve(root, legacyOwnerRoot)), false)
    assert.equal(existsSync(implementationPath), true)
    assert.equal(runtime.historicalDelivery.commits.every((commit) => SHA.test(commit)), true)
    assert.equal(runtime.historicalDelivery.disposition, 'historical-input-only')
    assert.equal(runtime.oldBaseline.ownerPath, `${legacyOwnerRoot}/scripts/resource-lifecycle.mjs`)
    assert.equal(runtime.oldBaseline.firstFailure, 'legacy-owner-path-retired')
})

test('B02 current package exports baseline inventory, observation, and machine cleanup runtime owner', async () => {
    await implementation()
})

test('B03 registry rejects missing owner, stage, contract, and immutable resource identity fields', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const registry = registryFor(sandbox)
        assertErrorCode(() => loaded.createResourceRegistry({ ...registry, stageRole: null }), 'resource-registry-owner-binding')
        assertErrorCode(() => loaded.createResourceRegistry({ ...registry, epochId: 'old-epoch' }), 'resource-registry-epoch-binding')
        assertErrorCode(() => loaded.createResourceRegistry({
            ...registry,
            resources: [{ ...registry.resources[0], ownerAttemptId: null }]
        }), 'resource-registry-owner-binding')
    } finally {
        sandbox.destroy()
    }
})

test('B04 planned/bound inventory fails closed for an observed unowned resource', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        await sandbox.createOwnedResources()
        mkdirSync(join(sandbox.temporaryParent, 'unknown-after-baseline'))
        const observed = await loaded.observeResourceInventory({
            registry: registryFor(sandbox),
            baseline,
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        assert.equal(observed.status, 'owner-conflict')
        assert.ok(observed.unknownResources.some(({ resourceType }) => resourceType === 'temporary-directory'))
        assertErrorCode(() => loaded.applyResourceEvent(registryFor(sandbox), {
            type: 'resource.observed-unowned',
            resourceId: 'unknown-after-baseline'
        }), 'resource-unowned-observation')
    } finally {
        sandbox.destroy()
    }
})

test('B05 an attempt cannot become terminal or release slot/lease before a verified machine cleanup receipt', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const registry = registryFor(sandbox)
        assertErrorCode(() => loaded.applyResourceEvent(registry, {
            type: 'attempt.terminal-requested',
            terminalStatus: 'completed'
        }), 'cleanup-receipt-required')
        assertErrorCode(() => loaded.applyResourceEvent(registry, {
            type: 'slot.release-requested'
        }), 'cleanup-receipt-required')
        assertErrorCode(() => loaded.verifyCleanupReceipt({
            schema: 'issue-orchestration.resource-cleanup-receipt.v1',
            actorRole: 'machine-resource-verifier',
            status: 'resources-clean',
            postInventory: []
        }), 'cleanup-receipt-binding-required')
    } finally {
        sandbox.destroy()
    }
})

test('B06 ordinary internal red cycles retain the one attempt/worktree/slot/writer and first failure', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const registry = registryFor(sandbox)
        const first = loaded.applyResourceEvent(registry, {
            type: 'self-test.failed',
            failureRef: 'first-real-red',
            ledgerEventDigest: cases.identities.ledgerDigest,
            dispatchReceiptDigest: cases.identities.dispatchReceiptDigest,
            epochId: cases.identities.epochId
        })
        const second = loaded.applyResourceEvent(first, {
            type: 'self-test.failed',
            failureRef: 'later-red',
            ledgerEventDigest: cases.identities.ledgerDigest,
            dispatchReceiptDigest: cases.identities.dispatchReceiptDigest,
            epochId: cases.identities.epochId
        })
        assert.equal(second.stageAttemptId, cases.identities.attemptId)
        assert.equal(second.issueWorktreeId, 'worktree-1828-owned')
        assert.equal(second.slotHeld, true)
        assert.equal(second.writeLease.state, 'active')
        assert.deepEqual(second.firstFailureRefs, ['first-real-red'])
        assertErrorCode(() => loaded.applyResourceEvent(second, {
            type: 'self-test.failed',
            failureRef: 'rebuild',
            newAttemptId: 'attempt-1828-2',
            epochId: cases.identities.epochId
        }), 'internal-red-attempt-rebuild-forbidden')
    } finally {
        sandbox.destroy()
    }
})

test('B06A generic cleanup cannot bypass the Git-resource state machine or release its lease', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        await sandbox.createOwnedResources()
        const result = await loaded.cleanupAttemptResources({
            registry: registryFor(sandbox),
            baseline,
            actorRole: 'machine-resource-verifier'
        })
        assert.equal(result.receipt.status, 'cleanup-failed')
        assert.ok(result.receipt.failedResources.every(
            ({ reason }) =>
                reason === 'git-resource-state-machine-required'
        ))
        assert.deepEqual(result.receipt.cleanupActions, [])
        assert.equal(result.registry.slotHeld, true)
        assert.equal(result.registry.writeLease.state, 'active')
        assert.equal(existsSync(sandbox.leasePath), true)
        assert.equal(existsSync(sandbox.worktreePath), true)
        assert.equal(commandResult(
            'git',
            [
                'show-ref',
                '--verify',
                '--quiet',
                `refs/heads/${sandbox.branchName}`
            ],
            sandbox.repositoryRoot
        ).status, 0)
    } finally {
        sandbox.destroy()
    }
})

test('B07 real clean worktree/process/port/temp/lock/lease cleanup proves post-inventory and git prune', async (t) => {
    const loaded = await implementation()
    if (!hasFlock()) t.skip('flock is unavailable; lock probe is availability-gated')
    const sandbox = createSandbox()
    try {
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        await sandbox.createOwnedResources()
        assert.notEqual(commandResult('flock', ['-n', sandbox.lockPath, 'true']).status, 0)
        killProcessGroup(sandbox.lockHolder)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
        assert.equal(existsSync(sandbox.lockPath), true)
        assert.equal(commandResult('flock', ['-n', sandbox.lockPath, 'true']).status, 0)
        const gitCleanupVerification =
            await retireSandboxGitResources(sandbox)
        const result = await loaded.cleanupAttemptResources({
            registry: registryFor(sandbox),
            baseline,
            actorRole: 'machine-resource-verifier',
            gitCleanupVerifications: [gitCleanupVerification]
        })
        assert.equal(result.receipt.status, 'resources-clean')
        assert.equal(loaded.verifyCleanupReceipt(result.receipt), true)
        assert.equal(result.registry.slotHeld, false)
        assert.equal(result.registry.writeLease.state, 'released')
        assert.equal(existsSync(sandbox.worktreePath), false)
        assert.equal(command('git', ['worktree', 'list', '--porcelain'], sandbox.repositoryRoot)
            .includes(sandbox.worktreePath), false)
        assert.equal(commandResult('git', ['show-ref', '--verify', '--quiet', `refs/heads/${sandbox.branchName}`], sandbox.repositoryRoot).status, 1)
        assert.equal(await portIsAvailable(sandbox.port), true)
        assert.equal(existsSync(sandbox.temporaryDirectory), false)
        assert.equal(existsSync(sandbox.leasePath), false)
        assert.equal(existsSync(sandbox.lockPath), false)
    } finally {
        sandbox.destroy()
    }
})

test('B08 real dirty worktree is preserved, retired, and blocks clean delivery', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        await sandbox.createOwnedResources({ dirty: true })
        const gitCleanupVerification =
            await retireSandboxGitResources(sandbox)
        const result = await loaded.cleanupAttemptResources({
            registry: registryFor(sandbox),
            baseline,
            actorRole: 'machine-resource-verifier',
            gitCleanupVerifications: [gitCleanupVerification]
        })
        assert.equal(result.receipt.status, 'resources-clean')
        assert.equal(
            result.registry.phase,
            'cleaned-with-quarantine'
        )
        assert.equal(result.registry.slotHeld, false)
        assert.equal(result.registry.deliveryAuthorized, false)
        assert.equal(existsSync(sandbox.worktreePath), false)
        assert.equal(commandResult('git', ['show-ref', '--verify', '--quiet', `refs/heads/${sandbox.branchName}`], sandbox.repositoryRoot).status, 1)
        assert.equal(
            result.receipt.quarantinedResources.length,
            1
        )
    } finally {
        sandbox.destroy()
    }
})

test('B09 baseline/external branches and temporary roots are never removed by owned cleanup', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const externalBranch = 'attempt-1828-user-branch'
        const externalDirectory = join(sandbox.temporaryParent, 'external-before-baseline')
        mkdirSync(externalDirectory)
        writeFileSync(join(externalDirectory, 'keep.txt'), 'external\n')
        command('git', ['branch', externalBranch], sandbox.repositoryRoot)
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        await sandbox.createOwnedResources()
        const gitCleanupVerification =
            await retireSandboxGitResources(sandbox)
        const result = await loaded.cleanupAttemptResources({
            registry: registryFor(sandbox),
            baseline,
            actorRole: 'machine-resource-verifier',
            gitCleanupVerifications: [gitCleanupVerification]
        })
        assert.equal(result.receipt.status, 'resources-clean')
        assert.equal(existsSync(externalDirectory), true)
        assert.equal(existsSync(join(externalDirectory, 'keep.txt')), true)
        assert.equal(commandResult('git', ['show-ref', '--verify', '--quiet', `refs/heads/${externalBranch}`], sandbox.repositoryRoot).status, 0)
    } finally {
        sandbox.destroy()
    }
})

test('B10 leader exit, a held port, or deleting a lock path cannot forge cleanup completion', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        await sandbox.createOwnedResources()
        const registry = registryFor(sandbox)
        assertErrorCode(() => loaded.verifyCleanupReceipt({
            schema: 'issue-orchestration.resource-cleanup-receipt.v1',
            actorRole: 'machine-resource-verifier',
            runId: cases.identities.runId,
            attemptId: cases.identities.attemptId,
            epochId: cases.identities.epochId,
            baselineDigest: cases.identities.baselineDigest,
            ownedResourceDigest: cases.identities.ownedResourceDigest,
            cleanupActions: [{ action: 'delete-lock-file-only' }],
            retainedResources: [],
            quarantinedResources: [],
            failedResources: [],
            postInventory: [{ resourceId: 'port-1828-owned', resourceType: 'port' }],
            postCleanupInventoryDigest: cases.identities.postInventoryDigest,
            status: 'resources-clean',
            verifiedAt: '2026-08-01T00:00:00.000Z'
        }), 'cleanup-post-inventory-not-empty')
        assertErrorCode(() => loaded.applyResourceEvent(registry, {
            type: 'process.leader-exited',
            resourceId: 'process-group-1828-owned',
            descendants: [sandbox.portHolder.pid],
            ports: [sandbox.port]
        }), 'process-descendant-still-live')
    } finally {
        sandbox.destroy()
    }
})

test('B11 stopped Docker resources and stale Docker ownership remain cleanup failures, not clean receipts', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const registry = registryFor(sandbox, {
            resources: [
                ...registryFor(sandbox).resources,
                {
                    resourceId: 'container-1828-owned',
                    resourceType: 'container',
                    ownerClass: 'attempt-owned',
                    ownerRunId: cases.identities.runId,
                    ownerAttemptId: cases.identities.attemptId,
                    state: 'stopped',
                    cleanupPolicy: 'remove',
                    identityEvidence: { containerId: 'container-1828-owned', labels: { runId: cases.identities.runId, attemptId: cases.identities.attemptId } }
                }
            ]
        })
        assertErrorCode(() => loaded.applyResourceEvent(registry, {
            type: 'docker.container-stopped',
            resourceId: 'container-1828-owned'
        }), 'docker-resource-still-present')
    } finally {
        sandbox.destroy()
    }
})

test('B12 crash recovery never repeats deletion, loses dirty candidate, or releases another attempt lease', async () => {
    const loaded = await implementation()
    const recovery = loaded.recoverResourceRegistry(cases.crashRecovery)
    assert.equal(recovery.status, 'cleanup-failed')
    assert.ok(recovery.failedResources.some(({ reason }) => reason === 'unknown-owner'))
    assert.ok(recovery.failedResources.some(({ reason }) => reason === 'dirty-candidate-retained'))
    assert.ok(recovery.retainedResources.some(({ ownerClass }) => ownerClass === 'externally-owned'))
    assertErrorCode(() => loaded.applyResourceEvent(cases.retryRegistry, {
        type: 'retry.started',
        stageAttemptId: cases.identities.retryAttemptId,
        issueWorktreeId: cases.retryRegistry.issueWorktreeId,
        previousOwnerAttemptId: cases.identities.attemptId
    }), 'retry-owner-reuse-forbidden')
})

test('B13 ledger, verified dispatch receipt, and delivery epoch bind every cleanup/terminal transition', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        const registry = registryFor(sandbox)
        assertErrorCode(() => loaded.applyResourceEvent(registry, {
            type: 'candidate-green',
            candidateSha: 'a'.repeat(40)
        }), 'resource-ledger-binding-required')
        assertErrorCode(() => loaded.applyResourceEvent(registry, {
            type: 'candidate-green',
            candidateSha: 'a'.repeat(40),
            ledgerEventDigest: cases.identities.ledgerDigest,
            dispatchReceiptDigest: cases.identities.dispatchReceiptDigest,
            epochId: 'epoch-1828-stale'
        }), 'resource-epoch-mismatch')
    } finally {
        sandbox.destroy()
    }
})

test('B14 member cleanup retains group-owned worktree/service and group cleanup requires the group session binding', async () => {
    const loaded = await implementation()
    const registry = loaded.createResourceRegistry(cases.groupRegistry)
    const memberClean = loaded.applyResourceEvent(registry, {
        type: 'member-cleanup.completed',
        memberId: 'member-1',
        groupSessionDigest: cases.identities.groupSessionDigest
    })
    assert.equal(memberClean.resources.find(({ resourceId }) => resourceId === 'group-worktree')?.state, 'retained')
    assertErrorCode(() => loaded.applyResourceEvent(memberClean, {
        type: 'group-cleanup.completed',
        postInventory: [],
        groupSessionDigest: 'b'.repeat(64)
    }), 'group-session-binding-mismatch')
})

test('B15 two-repository/shared-workspace inventory leaves unrelated worktree metadata and external roots intact', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    const siblingRepository = join(sandbox.sandboxRoot, 'sibling-repository')
    try {
        mkdirSync(siblingRepository)
        command('git', ['init', '--initial-branch=main'], siblingRepository)
        command('git', ['config', 'user.email', 'resource-test@example.invalid'], siblingRepository)
        command('git', ['config', 'user.name', 'Resource lifecycle test'], siblingRepository)
        writeFileSync(join(siblingRepository, 'external.txt'), 'external repository\n')
        command('git', ['add', 'external.txt'], siblingRepository)
        command('git', ['commit', '-m', 'external baseline'], siblingRepository)
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot, siblingRepository],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        await sandbox.createOwnedResources()
        const gitCleanupVerification =
            await retireSandboxGitResources(sandbox)
        const result = await loaded.cleanupAttemptResources({
            registry: registryFor(sandbox),
            baseline,
            actorRole: 'machine-resource-verifier',
            gitCleanupVerifications: [gitCleanupVerification]
        })
        assert.equal(result.receipt.status, 'resources-clean')
        assert.equal(command('git', ['rev-parse', '--is-inside-work-tree'], siblingRepository), 'true')
        assert.equal(existsSync(join(siblingRepository, 'external.txt')), true)
    } finally {
        sandbox.destroy()
    }
})

test('B16 cleanup receipt has the complete machine-observed binding and a self-consistent digest', async () => {
    const loaded = await implementation()
    const sandbox = createSandbox()
    try {
        await sandbox.createOwnedResources()
        const baseline = await loaded.captureBaselineInventory({
            repositoryRoots: [sandbox.repositoryRoot],
            temporaryRoots: [sandbox.temporaryParent],
            dockerMode: 'observe-only'
        })
        const gitCleanupVerification =
            await retireSandboxGitResources(sandbox)
        const result = await loaded.cleanupAttemptResources({
            registry: registryFor(sandbox),
            baseline,
            actorRole: 'machine-resource-verifier',
            gitCleanupVerifications: [gitCleanupVerification]
        })
        for (const field of cases.cleanupReceiptRequiredFields) {
            assert.notEqual(result.receipt[field], undefined, `cleanup receipt missing ${field}`)
        }
        assert.equal(result.receipt.actorRole, 'machine-resource-verifier')
        assert.equal(result.receipt.epochId, cases.identities.epochId)
        assert.equal(HASH.test(result.receipt.receiptDigest), true)
        assert.equal(loaded.verifyCleanupReceipt(result.receipt), true)
    } finally {
        sandbox.destroy()
    }
})

test('frozen acceptance, mutation, runtime, and expected-red maps have no omissions or CI authority', () => {
    const ids = acceptance.acceptance.map(({ id }) => id)
    assert.deepEqual(ids, expected.expectedFailingAcceptance)
    assert.deepEqual(acceptance.acceptance.flatMap(({ mutations: ids }) => ids).sort(),
        mutations.controls.map(({ id }) => id).sort())
    assert.deepEqual([...new Set(acceptance.acceptance.flatMap(({ runtimeProbes: ids }) => ids))].sort(),
        runtime.probes.map(({ id }) => id).sort())
    assert.equal(expected.firstFailure.acceptanceId, 'B02')
    assert.equal(expected.firstFailure.diagnostic, 'missing export captureBaselineInventory')
    assert.equal(runtime.ciEvidence, 'out-of-scope')
    assert.equal(runtime.probes.every(({ evidenceClass }) => evidenceClass !== 'historical-receipt'), true)
})
