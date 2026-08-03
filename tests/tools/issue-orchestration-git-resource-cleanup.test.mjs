import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    authorizeRemoteStagingRefCleanup,
    cleanupRemoteStagingRef,
    compileCandidateLandingMapping,
    compileCandidateSupersessionMapping,
    confirmGitResourceProcessesStopped,
    createGitResourceCleanup,
    freezeGitResource,
    inventoryGitResource,
    proveCandidateDisposition,
    releaseGitResourceLeaseAndSlot,
    removeGitWorktree,
    retireGitLocalRef,
    sealMachineReceipt,
    validateGitResourceCleanupProposal,
    validateGitResourceCleanupVerification,
    verifyGitResourceCleanup
} from '../../skills/issue-orchestration/scripts/git-resource-cleanup.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const temporaryRoots = new Set()

test.after(() => {
    for (const target of temporaryRoots) {
        fs.rmSync(target, { force: true, recursive: true })
    }
})

function run(command, args, cwd, {
    allowFailure = false
} = {}) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8'
    })
    if (!allowFailure) {
        assert.equal(
            result.status,
            0,
            `${command} ${args.join(' ')} failed:\n` +
                `${result.stdout}\n${result.stderr}`
        )
    }
    return result
}

function git(cwd, ...args) {
    return run('git', args, cwd).stdout.trim()
}

function readSchema(name) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', name),
        'utf8'
    ))
}

function authority({
    runId = 'run-git-cleanup-1'
} = {}) {
    return sealMachineReceipt({
        schema:
            'issue-orchestration.git-resource-root-authority.v1',
        actorRole: 'root-control',
        runId,
        rootAuthorityEpoch: 'root-epoch-git-cleanup-1',
        actorInvocationId: 'root-invocation-git-cleanup-1',
        issuedAt: '2026-08-03T08:30:00.000Z'
    }, 'authorityDigest')
}

function slotObservation(fixture) {
    return sealMachineReceipt({
        schema:
            'issue-orchestration.resource-slot-release-observation.v1',
        producerAuthority: 'machine-resource-slot-registry',
        runId: fixture.authority.runId,
        attemptId: fixture.attemptId,
        resourceId: fixture.worktreeResourceId,
        slotId: fixture.slotId,
        releaseAuthorized: true,
        released: false,
        activeResourceReferences: [],
        observedAt: '2026-08-03T08:31:00.000Z'
    }, 'observationDigest')
}

function createFixture({
    landing = 'merge',
    dirty = false,
    remote = false,
    resourceActorInvocationIds = [],
    branchName = 'cleanup/attempt-1'
} = {}) {
    const parent = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-git-cleanup-'
    ))
    temporaryRoots.add(parent)
    const repositoryPath = path.join(parent, 'repository')
    const worktreePath = path.join(parent, 'worktree')
    const quarantineRoot = path.join(parent, 'quarantine')
    const leasePath = path.join(parent, 'lease.json')
    const remotePath = path.join(parent, 'remote.git')
    fs.mkdirSync(repositoryPath)
    fs.mkdirSync(quarantineRoot)
    git(repositoryPath, 'init', '--initial-branch=main')
    git(repositoryPath, 'config', 'user.name',
        'Git cleanup test')
    git(repositoryPath, 'config', 'user.email',
        'git-cleanup@example.invalid')
    fs.writeFileSync(
        path.join(repositoryPath, 'baseline.txt'),
        'baseline\n'
    )
    git(repositoryPath, 'add', 'baseline.txt')
    git(repositoryPath, 'commit', '-m', 'baseline')
    const baseSha = git(repositoryPath, 'rev-parse', 'HEAD')
    git(
        repositoryPath,
        'worktree',
        'add',
        '-b',
        branchName,
        worktreePath,
        'HEAD'
    )
    if (landing !== 'discard' && !dirty) {
        fs.writeFileSync(
            path.join(worktreePath, 'candidate.txt'),
            `candidate ${landing}\n`
        )
        git(worktreePath, 'add', 'candidate.txt')
        git(worktreePath, 'commit', '-m', 'candidate')
    }
    const candidateSha = git(worktreePath, 'rev-parse', 'HEAD')
    if (landing === 'merge') {
        git(
            repositoryPath,
            'merge',
            '--no-ff',
            '-m',
            'merge candidate',
            branchName
        )
    } else if (landing === 'squash') {
        git(repositoryPath, 'merge', '--squash', branchName)
        git(repositoryPath, 'commit', '-m', 'squash candidate')
    }
    if (dirty) {
        fs.writeFileSync(
            path.join(worktreePath, 'baseline.txt'),
            'staged dirty\n'
        )
        git(worktreePath, 'add', 'baseline.txt')
        fs.appendFileSync(
            path.join(worktreePath, 'baseline.txt'),
            'unstaged dirty\n'
        )
        fs.writeFileSync(
            path.join(worktreePath, 'untracked.txt'),
            'recover me\n'
        )
    }
    const fixtureAuthority = authority()
    const attemptId = 'attempt-git-cleanup-1'
    const worktreeResourceId = 'worktree-git-cleanup-1'
    const branchResourceId = 'branch-git-cleanup-1'
    const leaseId = 'lease-git-cleanup-1'
    const slotId = 'slot-git-cleanup-1'
    fs.writeFileSync(leasePath, JSON.stringify({
        leaseId,
        runId: fixtureAuthority.runId,
        attemptId,
        resourceId: worktreeResourceId,
        state: 'active'
    }))
    let remoteRef = null
    if (remote) {
        git(parent, 'init', '--bare', remotePath)
        git(repositoryPath, 'remote', 'add', 'origin', remotePath)
        git(repositoryPath, 'push', 'origin', 'main')
        remoteRef =
            'refs/heads/issue-orchestration/staging/run-attempt-1'
        git(
            repositoryPath,
            'push',
            'origin',
            `${candidateSha}:${remoteRef}`
        )
    }
    const fixture = {
        parent,
        repositoryPath,
        worktreePath,
        quarantineRoot,
        leasePath,
        authority: fixtureAuthority,
        attemptId,
        worktreeResourceId,
        branchResourceId,
        leaseId,
        slotId,
        baseSha,
        candidateSha,
        branchRef: `refs/heads/${branchName}`,
        defaultBranchRef: 'refs/heads/main',
        remoteRef
    }
    fixture.state = createGitResourceCleanup({
        authority: fixture.authority,
        repositoryId: 'fixture/git-resource-cleanup',
        repositoryPath,
        worktreePath,
        worktreeResourceId,
        branchResourceId,
        branchRef: fixture.branchRef,
        defaultBranchRef: fixture.defaultBranchRef,
        baseSha,
        candidateSha,
        deliveryEpoch: 'delivery-epoch-git-cleanup-1',
        attemptId,
        stageRole: 'code-implementer',
        sliceId: 'slice-git-cleanup-1',
        leaseId,
        leasePath,
        slotId,
        resourceActorInvocationIds,
        remoteName: remote ? 'origin' : null,
        remoteRef,
        remoteExpectedSha: remote ? candidateSha : null
    })
    return fixture
}

function freezeAndInventory(fixture) {
    let { state } = fixture
    state = freezeGitResource({
        state,
        authority: fixture.authority,
        dispatchBlocked: true,
        writerAuthorityRevoked: true,
        cleanupAuthorityPreserved: true
    }).state
    const inventoried = inventoryGitResource({
        state,
        authority: fixture.authority
    })
    return inventoried
}

function landedEvidence() {
    return {
        acceptanceReceiptDigest: 'a'.repeat(64),
        verificationReceiptDigest: 'b'.repeat(64),
        landingReceiptDigest: 'c'.repeat(64)
    }
}

function disposition(fixture, state, inventory, kind) {
    if (kind === 'landed') {
        const landingMapping =
            compileCandidateLandingMapping({
                state,
                inventory,
                landingCommit: git(
                    fixture.repositoryPath,
                    'rev-parse',
                    'main'
                )
            })
        return proveCandidateDisposition({
            state,
            authority: fixture.authority,
            inventory,
            disposition: 'landed',
            landingMapping,
            ...landedEvidence()
        })
    }
    if (kind === 'discard-authorized') {
        return proveCandidateDisposition({
            state,
            authority: fixture.authority,
            inventory,
            disposition: kind,
            failureReceiptDigest: 'd'.repeat(64)
        })
    }
    return proveCandidateDisposition({
        state,
        authority: fixture.authority,
        inventory,
        disposition: 'quarantined',
        quarantineRoot: fixture.quarantineRoot,
        reasonCodes: ['dirty-or-unmapped-work']
    })
}

function stopRemoveRetire(
    fixture,
    state,
    inventory
) {
    state = confirmGitResourceProcessesStopped({
        state,
        authority: fixture.authority,
        actorShutdownReceipts: []
    }).state
    const removed = removeGitWorktree({
        state,
        authority: fixture.authority,
        inventory
    })
    state = removed.state
    const retired = retireGitLocalRef({
        state,
        authority: fixture.authority,
        inventory
    })
    return {
        state: retired.state,
        worktreeReceipt: removed.receipt,
        forceAuthorization: removed.forceAuthorization,
        branchReceipt: retired.receipt
    }
}

function releaseAndVerify(
    fixture,
    state,
    inventory,
    remoteCleanupReceipt = null
) {
    const released = releaseGitResourceLeaseAndSlot({
        state,
        authority: fixture.authority,
        inventory,
        remoteCleanupReceipt,
        slotReleaseObservation: slotObservation(fixture)
    })
    return verifyGitResourceCleanup({
        state: released.state,
        inventory,
        remoteCleanupReceipt
    })
}

function fullLifecycle(fixture, kind = 'landed') {
    const inventoried = freezeAndInventory(fixture)
    let { state } = disposition(
        fixture,
        inventoried.state,
        inventoried.inventory,
        kind
    )
    const retired = stopRemoveRetire(
        fixture,
        state,
        inventoried.inventory
    )
    const verified = releaseAndVerify(
        fixture,
        retired.state,
        inventoried.inventory
    )
    return {
        inventory: inventoried.inventory,
        ...retired,
        ...verified
    }
}

test('clean merge landing follows the exact state chain and safe branch deletion', () => {
    const fixture = createFixture({ landing: 'merge' })
    const result = fullLifecycle(fixture)
    assert.equal(result.receipt.deliveryClean, true)
    assert.equal(
        result.branchReceipt.commandClass,
        'git-branch-safe-delete'
    )
    assert.equal(
        result.worktreeReceipt.commandClass,
        'git-worktree-remove-and-prune'
    )
    assert.deepEqual(
        result.state.transitions.map(({ to }) => to),
        [
            'active',
            'frozen',
            'inventoried',
            'candidate-disposition-proven',
            'actors-and-processes-stopped',
            'worktree-removed',
            'local-ref-retired',
            'lease-and-slot-released',
            'post-cleanup-verified'
        ]
    )
    assert.equal(fs.existsSync(fixture.worktreePath), false)
    assert.equal(fs.existsSync(fixture.leasePath), false)
    assert.equal(
        validateGitResourceCleanupVerification(
            result.receipt,
            {
                runId: fixture.authority.runId,
                attemptId: fixture.attemptId,
                worktreeResourceId:
                    fixture.worktreeResourceId,
                branchResourceId:
                    fixture.branchResourceId,
                leaseId: fixture.leaseId,
                requireCleanDelivery: true
            }
        ),
        result.receipt
    )
})

test('squash landing requires exact patch mapping before force branch deletion', () => {
    const fixture = createFixture({ landing: 'squash' })
    const inventoried = freezeAndInventory(fixture)
    const mapping = compileCandidateLandingMapping({
        state: inventoried.state,
        inventory: inventoried.inventory,
        landingCommit: git(
            fixture.repositoryPath,
            'rev-parse',
            'main'
        )
    })
    assert.equal(mapping.mappingType, 'exact-patch')
    let state = proveCandidateDisposition({
        state: inventoried.state,
        authority: fixture.authority,
        inventory: inventoried.inventory,
        disposition: 'landed',
        landingMapping: mapping,
        ...landedEvidence()
    }).state
    const retired = stopRemoveRetire(
        fixture,
        state,
        inventoried.inventory
    )
    assert.equal(
        retired.branchReceipt.commandClass,
        'git-branch-force-delete-exact-mapping'
    )
    const verified = releaseAndVerify(
        fixture,
        retired.state,
        inventoried.inventory
    )
    assert.equal(verified.receipt.deliveryClean, true)
})

test('invalidated clean attempt can be discard-authorized without unique work', () => {
    const fixture = createFixture({ landing: 'discard' })
    const result = fullLifecycle(
        fixture,
        'discard-authorized'
    )
    assert.equal(result.receipt.disposition,
        'discard-authorized')
    assert.equal(
        result.branchReceipt.commandClass,
        'git-branch-force-delete-disposition-authorized'
    )
})

test('superseded candidate needs a newer accepted descendant that preserves all work', () => {
    const fixture = createFixture({ landing: 'none' })
    const inventoried = freezeAndInventory(fixture)
    const replacementCandidateSha = git(
        fixture.repositoryPath,
        'commit-tree',
        inventoried.inventory.candidateTree,
        '-p',
        fixture.candidateSha,
        '-m',
        'accepted replacement'
    )
    const mapping = compileCandidateSupersessionMapping({
        state: inventoried.state,
        inventory: inventoried.inventory,
        replacementCandidateSha,
        replacementAcceptanceReceiptDigest: '1'.repeat(64),
        replacementVerificationReceiptDigest: '2'.repeat(64)
    })
    assert.deepEqual(validateJsonSchema(
        mapping,
        readSchema(
            'candidate-supersession-mapping.schema.json'
        )
    ), [])
    const proven = proveCandidateDisposition({
        state: inventoried.state,
        authority: fixture.authority,
        inventory: inventoried.inventory,
        disposition: 'superseded',
        supersessionMapping: mapping
    })
    const retired = stopRemoveRetire(
        fixture,
        proven.state,
        inventoried.inventory
    )
    const verified = releaseAndVerify(
        fixture,
        retired.state,
        inventoried.inventory
    )
    assert.equal(verified.receipt.disposition, 'superseded')
})

test('dirty work is preserved under an exact quarantine ref and content manifest', () => {
    const fixture = createFixture({
        landing: 'none',
        dirty: true
    })
    const inventoried = freezeAndInventory(fixture)
    const proven = disposition(
        fixture,
        inventoried.state,
        inventoried.inventory,
        'quarantined'
    )
    assert.equal(
        proven.quarantineReceipt.untrackedManifestDigest,
        proven.quarantineReceipt.untrackedManifestDigest
    )
    const retired = stopRemoveRetire(
        fixture,
        proven.state,
        inventoried.inventory
    )
    assert.equal(
        retired.worktreeReceipt.commandClass,
        'git-worktree-remove-force-and-prune'
    )
    assert.ok(retired.forceAuthorization)
    assert.equal(
        git(
            fixture.repositoryPath,
            'show-ref',
            '--verify',
            '--hash',
            proven.quarantineReceipt.quarantineRef
        ),
        fixture.candidateSha
    )
    assert.equal(
        fs.readFileSync(path.join(
            proven.quarantineReceipt.quarantinePath,
            'untracked',
            'untracked.txt'
        ), 'utf8'),
        'recover me\n'
    )
    const verified = releaseAndVerify(
        fixture,
        retired.state,
        inventoried.inventory
    )
    assert.equal(verified.receipt.deliveryClean, false)
    assert.throws(() =>
        validateGitResourceCleanupVerification(
            verified.receipt,
            { requireCleanDelivery: true }
        ), {
        code: 'git-resource-cleanup-verification-invalid'
    })
})

test('active process, wrong owner, main worktree, wildcard ref and skipped transition fail closed', async () => {
    const fixture = createFixture({ landing: 'discard' })
    assert.throws(() => freezeGitResource({
        state: fixture.state,
        authority: authority({ runId: 'another-run' }),
        dispatchBlocked: true,
        writerAuthorityRevoked: true,
        cleanupAuthorityPreserved: true
    }), { code: 'git-resource-root-authority-invalid' })
    assert.throws(() => createGitResourceCleanup({
        authority: fixture.authority,
        repositoryId: 'fixture/git-resource-cleanup',
        repositoryPath: fixture.repositoryPath,
        worktreePath: fixture.repositoryPath,
        worktreeResourceId: 'main-worktree',
        branchResourceId: 'main-branch',
        branchRef: 'refs/heads/main',
        defaultBranchRef: 'refs/heads/main',
        baseSha: fixture.baseSha,
        candidateSha: fixture.baseSha,
        deliveryEpoch: 'epoch',
        attemptId: fixture.attemptId,
        stageRole: 'code-implementer',
        sliceId: 'slice',
        leaseId: fixture.leaseId,
        leasePath: fixture.leasePath,
        slotId: fixture.slotId
    }), { code: 'git-resource-protected-resource' })
    assert.throws(() => createGitResourceCleanup({
        authority: fixture.authority,
        repositoryId: 'fixture/git-resource-cleanup',
        repositoryPath: fixture.repositoryPath,
        worktreePath: fixture.worktreePath,
        worktreeResourceId: fixture.worktreeResourceId,
        branchResourceId: fixture.branchResourceId,
        branchRef: 'refs/heads/*',
        defaultBranchRef: 'refs/heads/main',
        baseSha: fixture.baseSha,
        candidateSha: fixture.baseSha,
        deliveryEpoch: 'epoch',
        attemptId: fixture.attemptId,
        stageRole: 'code-implementer',
        sliceId: 'slice',
        leaseId: fixture.leaseId,
        leasePath: fixture.leasePath,
        slotId: fixture.slotId
    }), { code: 'git-resource-branch-ref-invalid' })
    const inventoried = freezeAndInventory(fixture)
    assert.throws(() => releaseGitResourceLeaseAndSlot({
        state: inventoried.state,
        authority: fixture.authority,
        inventory: inventoried.inventory,
        slotReleaseObservation: slotObservation(fixture)
    }), { code: 'git-resource-release-state-invalid' })
    let state = disposition(
        fixture,
        inventoried.state,
        inventoried.inventory,
        'discard-authorized'
    ).state
    const child = spawn(
        process.execPath,
        [
            '-e',
            'process.stdout.write("ready\\n");' +
                'setInterval(() => {}, 1000)'
        ],
        {
            cwd: fixture.worktreePath,
            stdio: ['ignore', 'pipe', 'ignore']
        }
    )
    await once(child.stdout, 'data')
    try {
        assert.throws(() =>
            confirmGitResourceProcessesStopped({
                state,
                authority: fixture.authority
            }), { code: 'git-resource-process-still-active' })
    } finally {
        child.kill('SIGTERM')
        await new Promise((resolvePromise) =>
            child.once('exit', resolvePromise))
    }
    const openFileChild = spawn(
        process.execPath,
        [
            '-e',
            'globalThis.fd=' +
                'require("node:fs").openSync(process.argv[1], "r");' +
                'process.stdout.write("ready\\n");' +
                'setInterval(() => {}, 1000)',
            path.join(fixture.worktreePath, 'baseline.txt')
        ],
        {
            cwd: fixture.repositoryPath,
            stdio: ['ignore', 'pipe', 'ignore']
        }
    )
    await once(openFileChild.stdout, 'data')
    try {
        assert.throws(() =>
            confirmGitResourceProcessesStopped({
                state,
                authority: fixture.authority
            }), { code: 'git-resource-process-still-active' })
    } finally {
        openFileChild.kill('SIGTERM')
        await new Promise((resolvePromise) =>
            openFileChild.once('exit', resolvePromise))
    }
})

test('every bound actor needs a terminal machine receipt before Git removal', () => {
    const fixture = createFixture({
        landing: 'discard',
        resourceActorInvocationIds: ['writer-actor-1']
    })
    const inventoried = freezeAndInventory(fixture)
    const proven = disposition(
        fixture,
        inventoried.state,
        inventoried.inventory,
        'discard-authorized'
    )
    assert.throws(() => confirmGitResourceProcessesStopped({
        state: proven.state,
        authority: fixture.authority,
        actorShutdownReceipts: []
    }), { code: 'git-resource-actor-shutdown-incomplete' })
    const actorReceipt = sealMachineReceipt({
        schema:
            'issue-orchestration.actor-terminal-observation.v1',
        producerAuthority:
            'machine-actor-lifecycle-observer',
        runId: fixture.authority.runId,
        attemptId: fixture.attemptId,
        actorInvocationId: 'writer-actor-1',
        terminal: true,
        observedAt: '2026-08-03T08:31:00.000Z'
    }, 'receiptDigest')
    const stopped = confirmGitResourceProcessesStopped({
        state: proven.state,
        authority: fixture.authority,
        actorShutdownReceipts: [actorReceipt]
    })
    assert.equal(stopped.receipt.actorShutdownReceiptDigests[0],
        actorReceipt.receiptDigest)
})

test('LLM proposals stay inside the frozen vocabulary and never sign cleanliness', () => {
    const fixture = createFixture({ landing: 'discard' })
    const proposal = sealMachineReceipt({
        schema:
            'issue-orchestration.git-resource-cleanup-proposal.v1',
        producerAuthority: 'llm-advisor',
        lifecycleId: fixture.state.lifecycleId,
        runId: fixture.authority.runId,
        attemptId: fixture.attemptId,
        action: 'operator-required',
        reasonCodes: ['unknown-owner'],
        executionAuthority: false,
        proposedAt: '2026-08-03T08:32:00.000Z'
    }, 'proposalDigest')
    assert.equal(
        validateGitResourceCleanupProposal(
            proposal,
            fixture.state
        ),
        proposal
    )
    assert.deepEqual(validateJsonSchema(
        proposal,
        readSchema('git-resource-cleanup-proposal.schema.json')
    ), [])
    assert.throws(() => validateGitResourceCleanupProposal(
        sealMachineReceipt({
            ...proposal,
            action: 'rm-rf-worktree',
            shell: 'rm -rf *'
        }, 'proposalDigest'),
        fixture.state
    ), { code: 'git-resource-llm-proposal-invalid' })
    assert.throws(() =>
        validateGitResourceCleanupVerification({
            ...proposal,
            status: 'post-cleanup-verified'
        }), {
        code: 'git-resource-cleanup-verification-invalid'
    })
})

test('unlanded commit and matching narration cannot create landing authority', () => {
    const fixture = createFixture({ landing: 'none' })
    const inventoried = freezeAndInventory(fixture)
    assert.throws(() =>
        compileCandidateLandingMapping({
            state: inventoried.state,
            inventory: inventoried.inventory,
            landingCommit: git(
                fixture.repositoryPath,
                'rev-parse',
                'main'
            )
        }), {
        code: 'git-resource-landing-parent-invalid'
    })
    assert.throws(() => proveCandidateDisposition({
        state: inventoried.state,
        authority: fixture.authority,
        inventory: inventoried.inventory,
        disposition: 'landed',
        landingMapping: {
            narration:
                'same issue and commit message means landed'
        },
        ...landedEvidence()
    }), { code: 'git-resource-landing-map-invalid' })
})

test('direct path deletion, stale metadata and incomplete quarantine can never sign clean', () => {
    const direct = createFixture({ landing: 'discard' })
    const inventoried = freezeAndInventory(direct)
    let state = disposition(
        direct,
        inventoried.state,
        inventoried.inventory,
        'discard-authorized'
    ).state
    state = confirmGitResourceProcessesStopped({
        state,
        authority: direct.authority
    }).state
    fs.rmSync(direct.worktreePath, {
        force: true,
        recursive: true
    })
    assert.match(
        git(
            direct.repositoryPath,
            'worktree',
            'list',
            '--porcelain'
        ),
        /worktree/u
    )
    assert.throws(() => removeGitWorktree({
        state,
        authority: direct.authority,
        inventory: inventoried.inventory
    }), { code: 'git-resource-inventory-drift' })

    const dirty = createFixture({
        landing: 'none',
        dirty: true
    })
    const dirtyInventory = freezeAndInventory(dirty)
    const proven = disposition(
        dirty,
        dirtyInventory.state,
        dirtyInventory.inventory,
        'quarantined'
    )
    fs.rmSync(path.join(
        proven.quarantineReceipt.quarantinePath,
        'unstaged.patch'
    ))
    const stopped = confirmGitResourceProcessesStopped({
        state: proven.state,
        authority: dirty.authority
    }).state
    assert.throws(() => removeGitWorktree({
        state: stopped,
        authority: dirty.authority,
        inventory: dirtyInventory.inventory
    }), {
        code: 'git-resource-quarantine-content-missing'
    })
    assert.equal(fs.existsSync(dirty.worktreePath), true)
})

test('remote staging deletion is root-only, exact-ref and exact-SHA drift safe', () => {
    const fixture = createFixture({
        landing: 'merge',
        remote: true
    })
    const inventoried = freezeAndInventory(fixture)
    const proven = disposition(
        fixture,
        inventoried.state,
        inventoried.inventory,
        'landed'
    )
    const retired = stopRemoveRetire(
        fixture,
        proven.state,
        inventoried.inventory
    )
    const authorization =
        authorizeRemoteStagingRefCleanup({
            state: retired.state,
            authority: fixture.authority
        })
    git(
        fixture.repositoryPath,
        'push',
        '--force',
        'origin',
        `main:${fixture.remoteRef}`
    )
    assert.throws(() => cleanupRemoteStagingRef({
        state: retired.state,
        authority: fixture.authority,
        remoteMutationAuthorization: authorization
    }), { code: 'git-resource-remote-sha-drift' })
    git(
        fixture.repositoryPath,
        'push',
        '--force',
        'origin',
        `${fixture.candidateSha}:${fixture.remoteRef}`
    )
    const remoteReceipt = cleanupRemoteStagingRef({
        state: retired.state,
        authority: fixture.authority,
        remoteMutationAuthorization: authorization
    })
    assert.equal(remoteReceipt.deleted, true)
    const verified = releaseAndVerify(
        fixture,
        retired.state,
        inventoried.inventory,
        remoteReceipt
    )
    assert.equal(verified.receipt.remoteCleanupReceiptDigest,
        remoteReceipt.receiptDigest)
})

test('versioned contracts validate inventory, mapping and final verification receipts', () => {
    const fixture = createFixture({ landing: 'merge' })
    const inventoried = freezeAndInventory(fixture)
    const mapping = compileCandidateLandingMapping({
        state: inventoried.state,
        inventory: inventoried.inventory,
        landingCommit: git(
            fixture.repositoryPath,
            'rev-parse',
            'main'
        )
    })
    const result = fullLifecycle(
        createFixture({ landing: 'merge' })
    )
    assert.deepEqual(validateJsonSchema(
        inventoried.inventory,
        readSchema('git-resource-inventory.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        mapping,
        readSchema(
            'candidate-to-landing-mapping.schema.json'
        )
    ), [])
    assert.deepEqual(validateJsonSchema(
        result.receipt,
        readSchema(
            'git-resource-cleanup-verification.schema.json'
        )
    ), [])
    assert.deepEqual(validateJsonSchema(
        result.state,
        readSchema('git-resource-cleanup-state.schema.json')
    ), [])
})
