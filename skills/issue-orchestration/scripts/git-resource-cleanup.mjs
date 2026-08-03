import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
    HASH,
    assertArray,
    assertDigest,
    assertText,
    digest,
    fail,
    seal,
    sameValue,
    unsignedDigest,
    uniqueSorted
} from './runtime-contract-lib.mjs'

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/git-resource-cleanup-policy.json'
)

export const GIT_RESOURCE_CLEANUP_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const GIT_RESOURCE_CLEANUP_POLICY_DIGEST =
    digest(GIT_RESOURCE_CLEANUP_POLICY)

const SHA = /^[a-f0-9]{40}$/u
const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const STATE_SCHEMA =
    'issue-orchestration.git-resource-cleanup-state.v1'
const INVENTORY_SCHEMA =
    'issue-orchestration.git-resource-inventory.v1'

function now() {
    return new Date().toISOString()
}

function assertSha(value, code) {
    if (!SHA.test(value ?? '')) fail(code)
}

function assertBoolean(value, code) {
    if (typeof value !== 'boolean') fail(code)
}

function command(commandName, args, cwd, {
    input,
    encoding = 'utf8'
} = {}) {
    return spawnSync(commandName, args, {
        cwd,
        encoding,
        input,
        windowsHide: true
    })
}

function git(cwd, args, code, options = {}) {
    const result = command('git', args, cwd, options)
    if (result.status !== 0) {
        fail(code, code, {
            status: result.status,
            stderrDigest: digest(String(result.stderr ?? ''))
        })
    }
    return result
}

function gitText(cwd, args, code) {
    return git(cwd, args, code).stdout.trim()
}

function canonicalExistingDirectory(value, code) {
    assertText(value, code)
    const resolved = path.resolve(value)
    if (!fs.existsSync(resolved) ||
        !fs.statSync(resolved).isDirectory()) {
        fail(code)
    }
    return fs.realpathSync(resolved)
}

function assertExactPath(value, code) {
    assertText(value, code)
    if (!path.isAbsolute(value) ||
        value.includes('\0') ||
        /[*?[\]{}]/u.test(value)) {
        fail(code)
    }
    return path.resolve(value)
}

function assertExactRef(value, prefix, code) {
    assertText(value, code)
    if (!value.startsWith(`${prefix}/`) ||
        value.includes('..') ||
        /[*?[\]{}~^:\\\s]/u.test(value) ||
        value.endsWith('/') ||
        value.endsWith('.lock')) {
        fail(code)
    }
    const checked = command(
        'git',
        ['check-ref-format', value],
        process.cwd()
    )
    if (checked.status !== 0) fail(code)
    return value
}

function relativeGitPath(base, value) {
    return path.resolve(base, value)
}

function parseWorktrees(output) {
    const entries = []
    let current = null
    for (const line of output.split('\n')) {
        if (!line) continue
        const split = line.indexOf(' ')
        const key = split < 0 ? line : line.slice(0, split)
        const value = split < 0 ? '' : line.slice(split + 1)
        if (key === 'worktree') {
            if (current) entries.push(current)
            current = {
                path: path.resolve(value),
                head: null,
                branchRef: null,
                bare: false
            }
        } else if (current && key === 'HEAD') {
            current.head = value
        } else if (current && key === 'branch') {
            current.branchRef = value
        } else if (current && key === 'bare') {
            current.bare = true
        }
    }
    if (current) entries.push(current)
    return entries
}

function listWorktrees(repositoryPath) {
    return parseWorktrees(gitText(
        repositoryPath,
        ['worktree', 'list', '--porcelain'],
        'git-resource-worktree-observation-failed'
    ))
}

function listRefs(repositoryPath) {
    const output = gitText(repositoryPath, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
        GIT_RESOURCE_CLEANUP_POLICY.quarantineNamespace
    ], 'git-resource-ref-observation-failed')
    return output
        ? Object.fromEntries(output.split('\n').map((line) => {
                const split = line.lastIndexOf(' ')
                return [line.slice(0, split), line.slice(split + 1)]
            }))
        : {}
}

function readRef(repositoryPath, ref, {
    missingAllowed = false
} = {}) {
    const result = command(
        'git',
        ['show-ref', '--verify', '--hash', ref],
        repositoryPath
    )
    if (missingAllowed &&
        result.status !== 0 &&
        !result.stdout.trim()) {
        return null
    }
    if (result.status !== 0) fail('git-resource-ref-observation-failed')
    const value = result.stdout.trim()
    assertSha(value, 'git-resource-ref-observation-failed')
    return value
}

function statusBuffer(worktreePath) {
    return git(worktreePath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all'
    ], 'git-resource-status-observation-failed', {
        encoding: null
    }).stdout
}

function nulRecords(buffer) {
    return buffer.toString('utf8').split('\0').filter(Boolean)
}

function untrackedPaths(worktreePath, status) {
    return nulRecords(status)
        .filter((record) => record.startsWith('?? '))
        .map((record) => record.slice(3))
        .map((relative) => {
            const absolute = path.resolve(worktreePath, relative)
            if (!absolute.startsWith(`${worktreePath}${path.sep}`) ||
                !fs.existsSync(absolute)) {
                fail('git-resource-untracked-path-invalid')
            }
            return { relative, absolute }
        })
}

function fileEvidence(absolute, relative) {
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute)
        return {
            relative,
            kind: 'symlink',
            size: Buffer.byteLength(target),
            contentDigest: digest(target)
        }
    }
    if (!stat.isFile()) fail('git-resource-untracked-kind-unsupported')
    return {
        relative,
        kind: 'file',
        size: stat.size,
        contentDigest:
            digest(fs.readFileSync(absolute).toString('base64'))
    }
}

function processCwdObservation(worktreePath) {
    const processes = []
    let entries = []
    try {
        entries = fs.readdirSync('/proc', { withFileTypes: true })
    } catch {
        fail('git-resource-process-observer-unavailable')
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) {
            continue
        }
        const pid = Number(entry.name)
        let cwd = null
        try {
            cwd = fs.realpathSync(`/proc/${entry.name}/cwd`)
        } catch {
            // Open descriptors still prove resource use without cwd access.
        }
        const resourcePaths = []
        let descriptors = []
        try {
            descriptors = fs.readdirSync(
                `/proc/${entry.name}/fd`
            )
        } catch {
            // A racing or inaccessible process is still caught by cwd.
        }
        for (const descriptor of descriptors) {
            let target
            try {
                target = fs.readlinkSync(
                    `/proc/${entry.name}/fd/${descriptor}`
                ).replace(/ \(deleted\)$/u, '')
            } catch {
                continue
            }
            if (target === worktreePath ||
                target.startsWith(`${worktreePath}${path.sep}`)) {
                resourcePaths.push(target)
            }
        }
        if (cwd !== worktreePath &&
            (cwd === null ||
                !cwd.startsWith(
                    `${worktreePath}${path.sep}`
                )) &&
            resourcePaths.length === 0) continue
        let commandLine = ''
        try {
            commandLine = fs.readFileSync(
                `/proc/${entry.name}/cmdline`
            ).toString('utf8').replaceAll('\0', ' ').trim()
        } catch {
            // PID/cwd is authoritative even when cmdline races with exit.
        }
        processes.push({
            pid,
            cwd,
            resourcePaths: uniqueSorted(resourcePaths),
            commandDigest: digest(commandLine)
        })
    }
    return seal({
        schema:
            'issue-orchestration.git-resource-process-observation.v1',
        source: 'machine-proc-cwd-observer',
        worktreePath,
        activeProcesses:
            processes.sort((left, right) => left.pid - right.pid),
        observedAt: now()
    }, 'observationDigest')
}

export function observeGitResourceProcesses({
    worktreePath
} = {}) {
    const exact = assertExactPath(
        worktreePath,
        'git-resource-worktree-path-invalid'
    )
    return processCwdObservation(exact)
}

export function validateGitResourceCleanupProposal(
    proposal,
    state
) {
    if (proposal?.schema !==
            'issue-orchestration.git-resource-cleanup-proposal.v1' ||
        proposal.producerAuthority !== 'llm-advisor' ||
        proposal.lifecycleId !== state?.lifecycleId ||
        proposal.runId !== state?.runId ||
        proposal.attemptId !== state?.attemptId ||
        !GIT_RESOURCE_CLEANUP_POLICY.allowedActions
            .includes(proposal.action) ||
        proposal.executionAuthority !== false ||
        proposal.proposalDigest !==
            unsignedDigest(proposal, 'proposalDigest') ||
        [
            'command',
            'shell',
            'path',
            'ref',
            'delete',
            'release',
            'clean'
        ].some((field) => Object.hasOwn(proposal, field))) {
        fail('git-resource-llm-proposal-invalid')
    }
    return proposal
}

function validateAuthority(authority, state) {
    if (authority?.actorRole !== 'root-control' ||
        authority.runId !== state.runId ||
        authority.rootAuthorityEpoch !==
            state.rootAuthorityEpoch ||
        authority.actorInvocationId !==
            state.actorInvocationId ||
        authority.authorityDigest !==
            unsignedDigest(authority, 'authorityDigest')) {
        fail('git-resource-root-authority-invalid')
    }
    return authority
}

function validateState(state, expectedState) {
    if (state?.schema !== STATE_SCHEMA ||
        state.policyDigest !==
            GIT_RESOURCE_CLEANUP_POLICY_DIGEST ||
        state.stateDigest !==
            unsignedDigest(state, 'stateDigest') ||
        state.currentState !== expectedState ||
        !Array.isArray(state.transitions) ||
        state.transitions.at(-1)?.to !== expectedState) {
        fail('git-resource-state-invalid')
    }
    const states = GIT_RESOURCE_CLEANUP_POLICY.states
    for (let index = 0; index <
        state.transitions.length; index += 1) {
        const transition = state.transitions[index]
        const expectedFrom = index === 0
            ? null
            : state.transitions[index - 1].to
        if (transition.from !== expectedFrom ||
            !states.includes(transition.to) ||
            !HASH.test(transition.evidenceDigest ?? '')) {
            fail('git-resource-state-chain-invalid')
        }
        if (transition.from !== null &&
            !GIT_RESOURCE_CLEANUP_POLICY.transitions[
                transition.from
            ]?.includes(transition.to)) {
            fail('git-resource-state-chain-invalid')
        }
    }
    return state
}

function advance(state, nextState, evidence, bindings = {}) {
    const allowed =
        GIT_RESOURCE_CLEANUP_POLICY.transitions[state.currentState] ?? []
    if (!allowed.includes(nextState)) {
        fail('git-resource-transition-forbidden')
    }
    const next = {
        ...structuredClone(state),
        ...structuredClone(bindings),
        currentState: nextState,
        transitions: [
            ...state.transitions,
            {
                from: state.currentState,
                to: nextState,
                evidenceDigest: digest(evidence),
                transitionedAt: now()
            }
        ]
    }
    delete next.stateDigest
    return seal(next, 'stateDigest')
}

function assertRepositoryIdentity(state) {
    const repositoryPath = canonicalExistingDirectory(
        state.repositoryPath,
        'git-resource-repository-invalid'
    )
    if (repositoryPath !== state.repositoryPath ||
        gitText(repositoryPath, [
            'rev-parse',
            '--is-inside-work-tree'
        ], 'git-resource-repository-invalid') !== 'true') {
        fail('git-resource-repository-invalid')
    }
    return repositoryPath
}

export function createGitResourceCleanup({
    authority,
    repositoryId,
    repositoryPath,
    worktreePath,
    worktreeResourceId,
    branchResourceId,
    branchRef,
    defaultBranchRef,
    baseSha,
    candidateSha,
    deliveryEpoch,
    attemptId,
    stageRole,
    sliceId,
    leaseId,
    leasePath,
    slotId,
    resourceActorInvocationIds = [],
    remoteName = null,
    remoteRef = null,
    remoteExpectedSha = null
} = {}) {
    for (const [value, code] of [
        [repositoryId, 'git-resource-repository-id-required'],
        [worktreeResourceId, 'git-resource-id-required'],
        [branchResourceId, 'git-resource-id-required'],
        [deliveryEpoch, 'git-resource-delivery-epoch-required'],
        [attemptId, 'git-resource-attempt-required'],
        [stageRole, 'git-resource-stage-required'],
        [sliceId, 'git-resource-slice-required'],
        [leaseId, 'git-resource-lease-required'],
        [slotId, 'git-resource-slot-required']
    ]) {
        assertText(value, code)
    }
    assertText(
        authority?.runId,
        'git-resource-root-authority-invalid'
    )
    assertText(
        authority?.rootAuthorityEpoch,
        'git-resource-root-authority-invalid'
    )
    assertText(
        authority?.actorInvocationId,
        'git-resource-root-authority-invalid'
    )
    if (authority?.actorRole !== 'root-control' ||
        authority.authorityDigest !==
            unsignedDigest(authority, 'authorityDigest')) {
        fail('git-resource-root-authority-invalid')
    }
    assertSha(baseSha, 'git-resource-base-sha-invalid')
    assertSha(candidateSha, 'git-resource-candidate-sha-invalid')
    const repository = canonicalExistingDirectory(
        repositoryPath,
        'git-resource-repository-invalid'
    )
    const worktree = canonicalExistingDirectory(
        worktreePath,
        'git-resource-worktree-path-invalid'
    )
    const exactLeasePath = assertExactPath(
        leasePath,
        'git-resource-lease-path-invalid'
    )
    const branch = assertExactRef(
        branchRef,
        'refs/heads',
        'git-resource-branch-ref-invalid'
    )
    const defaultBranch = assertExactRef(
        defaultBranchRef,
        'refs/heads',
        'git-resource-default-ref-invalid'
    )
    if (branch === defaultBranch ||
        GIT_RESOURCE_CLEANUP_POLICY.forbidden.some((value) =>
            branch.includes(value)) ||
        repository === worktree ||
        listWorktrees(repository)[0]?.path === worktree) {
        fail('git-resource-protected-resource')
    }
    if (remoteRef !== null) {
        assertExactRef(
            remoteRef,
            GIT_RESOURCE_CLEANUP_POLICY
                .remoteStagingNamespace,
            'git-resource-remote-ref-invalid'
        )
        assertText(remoteName, 'git-resource-remote-name-required')
        assertSha(
            remoteExpectedSha,
            'git-resource-remote-sha-invalid'
        )
    } else if (remoteName !== null ||
        remoteExpectedSha !== null) {
        fail('git-resource-remote-binding-incomplete')
    }
    if (!Array.isArray(resourceActorInvocationIds) ||
        resourceActorInvocationIds.some((value) =>
            typeof value !== 'string' || !value)) {
        fail('git-resource-actor-identity-invalid')
    }
    return seal({
        schema: STATE_SCHEMA,
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: digest({
            runId: authority.runId,
            worktreeResourceId,
            branchResourceId,
            leaseId,
            deliveryEpoch
        }),
        currentState: 'active',
        runId: authority.runId,
        rootAuthorityEpoch: authority.rootAuthorityEpoch,
        actorInvocationId: authority.actorInvocationId,
        repositoryId,
        repositoryPath: repository,
        worktreePath: worktree,
        worktreeResourceId,
        branchResourceId,
        branchRef: branch,
        defaultBranchRef: defaultBranch,
        baseSha,
        candidateSha,
        deliveryEpoch,
        attemptId,
        stageRole,
        sliceId,
        leaseId,
        leasePath: exactLeasePath,
        slotId,
        resourceActorInvocationIds:
            uniqueSorted(resourceActorInvocationIds),
        remoteName,
        remoteRef,
        remoteExpectedSha,
        inventoryDigest: null,
        dispositionReceiptDigest: null,
        processObservationDigest: null,
        quarantineReceiptDigest: null,
        worktreeRemovalReceiptDigest: null,
        branchRetirementReceiptDigest: null,
        remoteCleanupReceiptDigest: null,
        leaseReleaseReceiptDigest: null,
        leaseReleased: false,
        slotReleased: false,
        transitions: [{
            from: null,
            to: 'active',
            evidenceDigest: digest({
                authorityDigest: authority.authorityDigest,
                repository,
                worktree,
                branch
            }),
            transitionedAt: now()
        }]
    }, 'stateDigest')
}

export function freezeGitResource({
    state,
    authority,
    dispatchBlocked,
    writerAuthorityRevoked,
    cleanupAuthorityPreserved
} = {}) {
    validateState(state, 'active')
    validateAuthority(authority, state)
    if (dispatchBlocked !== true ||
        writerAuthorityRevoked !== true ||
        cleanupAuthorityPreserved !== true) {
        fail('git-resource-freeze-evidence-required')
    }
    const receipt = seal({
        schema:
            'issue-orchestration.git-resource-freeze-receipt.v1',
        actorRole: 'root-control',
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        dispatchBlocked,
        writerAuthorityRevoked,
        cleanupAuthorityPreserved,
        authorityDigest: authority.authorityDigest,
        frozenAt: now()
    }, 'receiptDigest')
    return {
        receipt,
        state: advance(state, 'frozen', receipt)
    }
}

function inventorySnapshot(state) {
    const repositoryPath = assertRepositoryIdentity(state)
    const worktreePath = canonicalExistingDirectory(
        state.worktreePath,
        'git-resource-worktree-path-invalid'
    )
    if (worktreePath !== state.worktreePath) {
        fail('git-resource-worktree-path-drift')
    }
    const worktrees = listWorktrees(repositoryPath)
    const entry = worktrees.find((candidate) =>
        candidate.path === worktreePath)
    if (!entry ||
        entry === worktrees[0] ||
        entry.branchRef !== state.branchRef ||
        entry.head !== state.candidateSha) {
        fail('git-resource-worktree-identity-mismatch')
    }
    if (readRef(repositoryPath, state.branchRef) !==
            state.candidateSha ||
        gitText(worktreePath, ['rev-parse', 'HEAD'],
            'git-resource-head-observation-failed') !==
            state.candidateSha) {
        fail('git-resource-candidate-identity-mismatch')
    }
    const commonRaw = gitText(worktreePath, [
        'rev-parse',
        '--git-common-dir'
    ], 'git-resource-common-dir-observation-failed')
    const gitDirRaw = gitText(worktreePath, [
        'rev-parse',
        '--git-dir'
    ], 'git-resource-git-dir-observation-failed')
    const commonDir = fs.realpathSync(
        relativeGitPath(worktreePath, commonRaw)
    )
    const registryEntry = fs.realpathSync(
        relativeGitPath(worktreePath, gitDirRaw)
    )
    if (!registryEntry.startsWith(`${commonDir}${path.sep}worktrees${path.sep}`)) {
        fail('git-resource-registry-entry-invalid')
    }
    const stat = fs.statSync(worktreePath)
    const status = statusBuffer(worktreePath)
    const untracked = untrackedPaths(worktreePath, status)
    const unstagedPatch = git(worktreePath, [
        'diff',
        '--binary',
        'HEAD'
    ], 'git-resource-patch-observation-failed', {
        encoding: null
    }).stdout
    const stagedPatch = git(worktreePath, [
        'diff',
        '--cached',
        '--binary'
    ], 'git-resource-patch-observation-failed', {
        encoding: null
    }).stdout
    const indexManifest = git(worktreePath, [
        'ls-files',
        '-s',
        '-z'
    ], 'git-resource-index-observation-failed', {
        encoding: null
    }).stdout
    const defaultBranchSha = readRef(
        repositoryPath,
        state.defaultBranchRef
    )
    const primary = worktrees[0]
    const primaryStatus = statusBuffer(primary.path)
    const originResult = command(
        'git',
        ['remote', 'get-url', 'origin'],
        repositoryPath
    )
    return seal({
        schema: INVENTORY_SCHEMA,
        producerAuthority:
            'machine-git-resource-inventory',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        actorInvocationId: state.actorInvocationId,
        attemptId: state.attemptId,
        stageRole: state.stageRole,
        sliceId: state.sliceId,
        resourceActorInvocationIds:
            state.resourceActorInvocationIds,
        leaseId: state.leaseId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        repositoryId: state.repositoryId,
        repositoryPath,
        repositoryFilesystemIdentity: {
            dev: fs.statSync(repositoryPath).dev,
            inode: fs.statSync(repositoryPath).ino
        },
        repositoryIdentity: {
            objectFormat: gitText(
                repositoryPath,
                ['rev-parse', '--show-object-format'],
                'git-resource-repository-identity-failed'
            ),
            originUrl: originResult.status === 0
                ? originResult.stdout.trim()
                : null
        },
        worktreePath,
        worktreeFilesystemIdentity: {
            dev: stat.dev,
            inode: stat.ino
        },
        gitCommonDir: commonDir,
        worktreeRegistryEntry: registryEntry,
        branchRef: state.branchRef,
        headSha: state.candidateSha,
        indexTree: gitText(
            worktreePath,
            ['write-tree'],
            'git-resource-index-tree-observation-failed'
        ),
        trackedTree: gitText(
            worktreePath,
            ['rev-parse', 'HEAD^{tree}'],
            'git-resource-tracked-tree-observation-failed'
        ),
        statusDigest: digest(status.toString('base64')),
        dirty: status.length > 0,
        stagedPatchDigest:
            digest(stagedPatch.toString('base64')),
        unstagedPatchDigest:
            digest(unstagedPatch.toString('base64')),
        indexManifestDigest:
            digest(indexManifest.toString('base64')),
        untrackedManifest:
            untracked.map(({ absolute, relative }) =>
                fileEvidence(absolute, relative)),
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        candidateTree: gitText(
            repositoryPath,
            ['rev-parse', `${state.candidateSha}^{tree}`],
            'git-resource-candidate-tree-observation-failed'
        ),
        candidatePatchDigest: digest(
            git(repositoryPath, [
                'diff',
                '--binary',
                state.baseSha,
                state.candidateSha
            ], 'git-resource-candidate-patch-observation-failed', {
                encoding: null
            }).stdout.toString('base64')
        ),
        deliveryEpoch: state.deliveryEpoch,
        defaultBranchRef: state.defaultBranchRef,
        defaultBranchSha,
        repositoryHeadSha: primary.head,
        repositoryIndexTree: gitText(
            primary.path,
            ['write-tree'],
            'git-resource-primary-index-observation-failed'
        ),
        repositoryStatusDigest:
            digest(primaryStatus.toString('base64')),
        refs: listRefs(repositoryPath),
        processObservation:
            processCwdObservation(worktreePath),
        remoteRef: state.remoteRef,
        remoteExpectedSha: state.remoteExpectedSha,
        observedAt: now()
    }, 'inventoryDigest')
}

export function inventoryGitResource({
    state,
    authority
} = {}) {
    validateState(state, 'frozen')
    validateAuthority(authority, state)
    const inventory = inventorySnapshot(state)
    return {
        inventory,
        state: advance(state, 'inventoried', inventory, {
            inventoryDigest: inventory.inventoryDigest
        })
    }
}

function validateInventory(inventory, state) {
    if (inventory?.schema !== INVENTORY_SCHEMA ||
        inventory.inventoryDigest !==
            unsignedDigest(inventory, 'inventoryDigest') ||
        inventory.inventoryDigest !== state.inventoryDigest ||
        inventory.lifecycleId !== state.lifecycleId ||
        inventory.runId !== state.runId ||
        inventory.attemptId !== state.attemptId ||
        inventory.worktreeResourceId !==
            state.worktreeResourceId ||
        inventory.branchResourceId !==
            state.branchResourceId) {
        fail('git-resource-inventory-invalid')
    }
    return inventory
}

function criticalInventoryCurrent(state, inventory) {
    validateInventory(inventory, state)
    if (!fs.existsSync(state.worktreePath)) {
        fail('git-resource-inventory-drift')
    }
    const stat = fs.statSync(state.worktreePath)
    const status = statusBuffer(state.worktreePath)
    if (stat.dev !==
            inventory.worktreeFilesystemIdentity.dev ||
        stat.ino !==
            inventory.worktreeFilesystemIdentity.inode ||
        digest(status.toString('base64')) !==
            inventory.statusDigest ||
        readRef(state.repositoryPath, state.branchRef) !==
            state.candidateSha ||
        readRef(state.repositoryPath, state.defaultBranchRef) !==
            inventory.defaultBranchSha) {
        fail('git-resource-inventory-drift')
    }
}

function stablePatchId(repositoryPath, args) {
    const patch = git(
        repositoryPath,
        ['diff', '--binary', ...args],
        'git-resource-landing-map-diff-failed',
        { encoding: null }
    ).stdout
    const result = command(
        'git',
        ['patch-id', '--stable'],
        repositoryPath,
        { input: patch }
    )
    if (result.status !== 0) {
        fail('git-resource-landing-map-patch-id-failed')
    }
    const value = result.stdout.trim().split(/\s+/u)[0] ?? ''
    if (!SHA.test(value)) {
        return digest(patch.toString('base64')).slice(0, 40)
    }
    return value
}

export function compileCandidateLandingMapping({
    state,
    inventory,
    landingCommit
} = {}) {
    validateState(state, 'inventoried')
    validateInventory(inventory, state)
    assertSha(
        landingCommit,
        'git-resource-landing-commit-invalid'
    )
    if (readRef(state.repositoryPath, state.defaultBranchRef) !==
            landingCommit) {
        fail('git-resource-default-branch-drift')
    }
    const ancestry = command('git', [
        'merge-base',
        '--is-ancestor',
        state.candidateSha,
        landingCommit
    ], state.repositoryPath)
    let mappingType
    let candidatePatchId = null
    let landingPatchId = null
    if (ancestry.status === 0) {
        mappingType = 'merge-ancestry'
    } else if (ancestry.status === 1) {
        const parent = gitText(state.repositoryPath, [
            'rev-parse',
            `${landingCommit}^`
        ], 'git-resource-landing-parent-invalid')
        candidatePatchId = stablePatchId(
            state.repositoryPath,
            [state.baseSha, state.candidateSha]
        )
        landingPatchId = stablePatchId(
            state.repositoryPath,
            [parent, landingCommit]
        )
        if (candidatePatchId !== landingPatchId) {
            fail('git-resource-landing-map-content-mismatch')
        }
        mappingType = 'exact-patch'
    } else {
        fail('git-resource-landing-map-ancestry-failed')
    }
    return seal({
        schema:
            'issue-orchestration.candidate-to-landing-mapping.v1',
        producerAuthority:
            'machine-candidate-landing-mapper',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        leaseId: state.leaseId,
        deliveryEpoch: state.deliveryEpoch,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        candidateTree: inventory.candidateTree,
        defaultBranchRef: state.defaultBranchRef,
        landingCommit,
        mappingType,
        candidatePatchId,
        landingPatchId,
        observedAt: now()
    }, 'mappingDigest')
}

function validateLandingMapping(mapping, state, inventory) {
    if (mapping?.schema !==
            'issue-orchestration.candidate-to-landing-mapping.v1' ||
        mapping.mappingDigest !==
            unsignedDigest(mapping, 'mappingDigest') ||
        mapping.lifecycleId !== state.lifecycleId ||
        mapping.runId !== state.runId ||
        mapping.rootAuthorityEpoch !==
            state.rootAuthorityEpoch ||
        mapping.attemptId !== state.attemptId ||
        mapping.repositoryId !== state.repositoryId ||
        mapping.leaseId !== state.leaseId ||
        mapping.deliveryEpoch !== state.deliveryEpoch ||
        mapping.baseSha !== state.baseSha ||
        mapping.candidateSha !== state.candidateSha ||
        mapping.candidateTree !== inventory.candidateTree ||
        mapping.defaultBranchRef !== state.defaultBranchRef ||
        !['merge-ancestry', 'exact-patch']
            .includes(mapping.mappingType) ||
        readRef(state.repositoryPath, state.defaultBranchRef) !==
            mapping.landingCommit) {
        fail('git-resource-landing-map-invalid')
    }
    if (mapping.mappingType === 'exact-patch' &&
        mapping.candidatePatchId !== mapping.landingPatchId) {
        fail('git-resource-landing-map-invalid')
    }
    return mapping
}

export function compileCandidateSupersessionMapping({
    state,
    inventory,
    replacementCandidateSha,
    replacementAcceptanceReceiptDigest,
    replacementVerificationReceiptDigest
} = {}) {
    validateState(state, 'inventoried')
    validateInventory(inventory, state)
    assertSha(
        replacementCandidateSha,
        'git-resource-supersession-candidate-invalid'
    )
    assertDigest(
        replacementAcceptanceReceiptDigest,
        'git-resource-supersession-acceptance-required'
    )
    assertDigest(
        replacementVerificationReceiptDigest,
        'git-resource-supersession-verification-required'
    )
    if (replacementCandidateSha === state.candidateSha ||
        command('git', [
            'cat-file',
            '-e',
            `${replacementCandidateSha}^{commit}`
        ], state.repositoryPath).status !== 0 ||
        command('git', [
            'merge-base',
            '--is-ancestor',
            state.candidateSha,
            replacementCandidateSha
        ], state.repositoryPath).status !== 0) {
        fail('git-resource-supersession-unique-work-unproven')
    }
    return seal({
        schema:
            'issue-orchestration.candidate-supersession-mapping.v1',
        producerAuthority:
            'machine-candidate-supersession-mapper',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        leaseId: state.leaseId,
        deliveryEpoch: state.deliveryEpoch,
        oldCandidateSha: state.candidateSha,
        oldCandidateTree: inventory.candidateTree,
        replacementCandidateSha,
        replacementCandidateTree: gitText(
            state.repositoryPath,
            ['rev-parse', `${replacementCandidateSha}^{tree}`],
            'git-resource-supersession-candidate-invalid'
        ),
        mappingType: 'commit-ancestry',
        uniqueWorkPreserved: true,
        replacementAcceptanceReceiptDigest,
        replacementVerificationReceiptDigest,
        observedAt: now()
    }, 'mappingDigest')
}

function copyUntracked(worktreePath, quarantinePath, manifest) {
    const destinationRoot = path.join(
        quarantinePath,
        'untracked'
    )
    fs.mkdirSync(destinationRoot, { recursive: true })
    for (const entry of manifest) {
        const source = path.resolve(worktreePath, entry.relative)
        const destination = path.resolve(
            destinationRoot,
            entry.relative
        )
        if (!destination.startsWith(
            `${destinationRoot}${path.sep}`
        )) {
            fail('git-resource-quarantine-path-invalid')
        }
        fs.mkdirSync(path.dirname(destination), {
            recursive: true
        })
        if (entry.kind === 'symlink') {
            fs.symlinkSync(fs.readlinkSync(source), destination)
        } else {
            fs.copyFileSync(source, destination)
        }
    }
}

function quarantineRef(state, inventory) {
    const segments = [
        state.runId,
        state.attemptId,
        inventory.inventoryDigest.slice(0, 16)
    ].map((segment) => {
        if (!SAFE_REF_SEGMENT.test(segment)) {
            return digest(segment).slice(0, 16)
        }
        return segment
    })
    return `${GIT_RESOURCE_CLEANUP_POLICY
        .quarantineNamespace}/${segments.join('/')}`
}

function preserveQuarantine({
    state,
    inventory,
    quarantineRoot,
    reasonCodes
}) {
    const root = canonicalExistingDirectory(
        quarantineRoot,
        'git-resource-quarantine-root-invalid'
    )
    if (root === state.repositoryPath ||
        root.startsWith(`${state.repositoryPath}${path.sep}`) ||
        root === state.worktreePath ||
        root.startsWith(`${state.worktreePath}${path.sep}`)) {
        fail('git-resource-quarantine-root-invalid')
    }
    const destination = path.join(
        root,
        state.lifecycleId
    )
    if (fs.existsSync(destination)) {
        fail('git-resource-quarantine-replay')
    }
    fs.mkdirSync(destination, { recursive: false })
    const staged = git(state.worktreePath, [
        'diff',
        '--cached',
        '--binary'
    ], 'git-resource-quarantine-patch-failed', {
        encoding: null
    }).stdout
    const unstaged = git(state.worktreePath, [
        'diff',
        '--binary',
        'HEAD'
    ], 'git-resource-quarantine-patch-failed', {
        encoding: null
    }).stdout
    const index = git(state.worktreePath, [
        'ls-files',
        '-s',
        '-z'
    ], 'git-resource-quarantine-index-failed', {
        encoding: null
    }).stdout
    fs.writeFileSync(
        path.join(destination, 'staged.patch'),
        staged
    )
    fs.writeFileSync(
        path.join(destination, 'unstaged.patch'),
        unstaged
    )
    fs.writeFileSync(
        path.join(destination, 'index.manifest'),
        index
    )
    copyUntracked(
        state.worktreePath,
        destination,
        inventory.untrackedManifest
    )
    const ref = quarantineRef(state, inventory)
    git(state.repositoryPath, [
        'update-ref',
        ref,
        state.candidateSha
    ], 'git-resource-quarantine-ref-failed')
    if (readRef(state.repositoryPath, ref) !==
            state.candidateSha) {
        fail('git-resource-quarantine-ref-unverified')
    }
    const source = {
        statusDigest: inventory.statusDigest,
        stagedPatchDigest: inventory.stagedPatchDigest,
        unstagedPatchDigest: inventory.unstagedPatchDigest,
        indexManifestDigest: inventory.indexManifestDigest,
        untrackedManifest: inventory.untrackedManifest
    }
    const metadata = {
        schema:
            'issue-orchestration.git-quarantine-metadata.v1',
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        actorInvocationId: state.actorInvocationId,
        repositoryId: state.repositoryId,
        repositoryPath: state.repositoryPath,
        worktreePath: state.worktreePath,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        branchRef: state.branchRef,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        reasonCodes: uniqueSorted(reasonCodes),
        source
    }
    fs.writeFileSync(
        path.join(destination, 'metadata.json'),
        `${JSON.stringify(metadata, null, 2)}\n`
    )
    const receipt = seal({
        schema:
            'issue-orchestration.quarantine-preservation-receipt.v1',
        producerAuthority:
            'machine-git-resource-cleaner',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        worktreePath: state.worktreePath,
        branchRef: state.branchRef,
        quarantineRef: ref,
        quarantinePath: destination,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        inventoryDigest: inventory.inventoryDigest,
        reasonCodes: uniqueSorted(reasonCodes),
        sourceDigest: digest(source),
        metadataDigest: digest(metadata),
        stagedPatchDigest:
            digest(staged.toString('base64')),
        unstagedPatchDigest:
            digest(unstaged.toString('base64')),
        indexManifestDigest:
            digest(index.toString('base64')),
        untrackedManifestDigest:
            digest(inventory.untrackedManifest),
        preservedAt: now()
    }, 'receiptDigest')
    verifyQuarantineReceipt(receipt, state, inventory)
    return receipt
}

function verifyQuarantineReceipt(receipt, state, inventory) {
    if (receipt?.schema !==
            'issue-orchestration.quarantine-preservation-receipt.v1' ||
        receipt.producerAuthority !==
            'machine-git-resource-cleaner' ||
        receipt.receiptDigest !==
            unsignedDigest(receipt, 'receiptDigest') ||
        receipt.policyDigest !==
            GIT_RESOURCE_CLEANUP_POLICY_DIGEST ||
        receipt.lifecycleId !== state.lifecycleId ||
        receipt.runId !== state.runId ||
        receipt.rootAuthorityEpoch !==
            state.rootAuthorityEpoch ||
        receipt.attemptId !== state.attemptId ||
        receipt.repositoryId !== state.repositoryId ||
        receipt.worktreeResourceId !==
            state.worktreeResourceId ||
        receipt.branchResourceId !==
            state.branchResourceId ||
        receipt.worktreePath !== state.worktreePath ||
        receipt.inventoryDigest !== inventory.inventoryDigest ||
        receipt.candidateSha !== state.candidateSha ||
        receipt.leaseId !== state.leaseId ||
        readRef(state.repositoryPath, receipt.quarantineRef) !==
            state.candidateSha ||
        !fs.existsSync(receipt.quarantinePath)) {
        fail('git-resource-quarantine-receipt-invalid')
    }
    const files = [
        ['staged.patch', receipt.stagedPatchDigest],
        ['unstaged.patch', receipt.unstagedPatchDigest],
        ['index.manifest', receipt.indexManifestDigest]
    ]
    for (const [relative, expected] of files) {
        const file = path.join(receipt.quarantinePath, relative)
        if (!fs.existsSync(file) ||
            digest(fs.readFileSync(file).toString('base64')) !==
                expected) {
            fail('git-resource-quarantine-content-missing')
        }
    }
    const metadataFile = path.join(
        receipt.quarantinePath,
        'metadata.json'
    )
    let metadata
    try {
        metadata = JSON.parse(
            fs.readFileSync(metadataFile, 'utf8')
        )
    } catch {
        fail('git-resource-quarantine-content-missing')
    }
    if (digest(metadata) !== receipt.metadataDigest ||
        digest(metadata.source) !== receipt.sourceDigest ||
        metadata.lifecycleId !== state.lifecycleId ||
        metadata.candidateSha !== state.candidateSha) {
        fail('git-resource-quarantine-content-missing')
    }
    for (const entry of inventory.untrackedManifest) {
        const file = path.resolve(
            receipt.quarantinePath,
            'untracked',
            entry.relative
        )
        if (!fs.existsSync(file) ||
            fileEvidence(file, entry.relative).contentDigest !==
                entry.contentDigest) {
            fail('git-resource-quarantine-content-missing')
        }
    }
    return receipt
}

export function proveCandidateDisposition({
    state,
    authority,
    inventory,
    disposition,
    landingMapping = null,
    acceptanceReceiptDigest = null,
    verificationReceiptDigest = null,
    landingReceiptDigest = null,
    failureReceiptDigest = null,
    supersessionMapping = null,
    quarantineRoot = null,
    reasonCodes = []
} = {}) {
    validateState(state, 'inventoried')
    validateAuthority(authority, state)
    validateInventory(inventory, state)
    criticalInventoryCurrent(state, inventory)
    if (!GIT_RESOURCE_CLEANUP_POLICY
        .candidateDispositions.includes(disposition)) {
        fail('git-resource-disposition-invalid')
    }
    let quarantineReceipt = null
    if (disposition === 'landed') {
        for (const value of [
            acceptanceReceiptDigest,
            verificationReceiptDigest,
            landingReceiptDigest
        ]) {
            assertDigest(
                value,
                'git-resource-landed-evidence-required'
            )
        }
        validateLandingMapping(
            landingMapping,
            state,
            inventory
        )
    } else if (disposition === 'superseded') {
        if (supersessionMapping?.schema !==
                'issue-orchestration.candidate-supersession-mapping.v1' ||
            supersessionMapping.producerAuthority !==
                'machine-candidate-supersession-mapper' ||
            supersessionMapping.policyDigest !==
                GIT_RESOURCE_CLEANUP_POLICY_DIGEST ||
            supersessionMapping.mappingDigest !==
                unsignedDigest(
                    supersessionMapping,
                    'mappingDigest'
                ) ||
            supersessionMapping.lifecycleId !== state.lifecycleId ||
            supersessionMapping.runId !== state.runId ||
            supersessionMapping.rootAuthorityEpoch !==
                state.rootAuthorityEpoch ||
            supersessionMapping.attemptId !== state.attemptId ||
            supersessionMapping.repositoryId !==
                state.repositoryId ||
            supersessionMapping.leaseId !== state.leaseId ||
            supersessionMapping.deliveryEpoch !==
                state.deliveryEpoch ||
            supersessionMapping.oldCandidateSha !==
                state.candidateSha ||
            supersessionMapping.oldCandidateTree !==
                inventory.candidateTree ||
            supersessionMapping.mappingType !==
                'commit-ancestry' ||
            supersessionMapping.uniqueWorkPreserved !== true ||
            command('git', [
                'merge-base',
                '--is-ancestor',
                state.candidateSha,
                supersessionMapping.replacementCandidateSha
            ], state.repositoryPath).status !== 0) {
            fail('git-resource-supersession-proof-required')
        }
    } else if (disposition === 'discard-authorized') {
        assertDigest(
            failureReceiptDigest,
            'git-resource-discard-evidence-required'
        )
        if (inventory.dirty ||
            state.candidateSha !== state.baseSha ||
            inventory.candidateTree !== inventory.trackedTree) {
            fail('git-resource-discard-unique-work')
        }
    } else {
        assertArray(
            reasonCodes,
            'git-resource-quarantine-reason-required',
            { min: 1 }
        )
        quarantineReceipt = preserveQuarantine({
            state,
            inventory,
            quarantineRoot,
            reasonCodes
        })
    }
    const receipt = seal({
        schema:
            'issue-orchestration.candidate-disposition-receipt.v1',
        producerAuthority:
            'machine-candidate-disposition-verifier',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        leaseId: state.leaseId,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        disposition,
        inventoryDigest: inventory.inventoryDigest,
        landingMappingDigest:
            landingMapping?.mappingDigest ?? null,
        acceptanceReceiptDigest,
        verificationReceiptDigest,
        landingReceiptDigest,
        failureReceiptDigest,
        supersessionMappingDigest:
            supersessionMapping?.mappingDigest ?? null,
        quarantineReceiptDigest:
            quarantineReceipt?.receiptDigest ?? null,
        reasonCodes: uniqueSorted(reasonCodes),
        provenAt: now()
    }, 'receiptDigest')
    return {
        receipt,
        quarantineReceipt,
        state: advance(
            state,
            'candidate-disposition-proven',
            receipt,
            {
                disposition,
                dispositionReceiptDigest:
                    receipt.receiptDigest,
                landingMapping:
                    landingMapping ?? null,
                quarantineReceipt:
                    quarantineReceipt ?? null,
                quarantineReceiptDigest:
                    quarantineReceipt?.receiptDigest ?? null
            }
        )
    }
}

export function confirmGitResourceProcessesStopped({
    state,
    authority,
    actorShutdownReceipts = []
} = {}) {
    validateState(
        state,
        'candidate-disposition-proven'
    )
    validateAuthority(authority, state)
    if (!Array.isArray(actorShutdownReceipts)) {
        fail('git-resource-actor-shutdown-invalid')
    }
    if (actorShutdownReceipts.some((receipt) =>
            receipt?.producerAuthority !==
                'machine-actor-lifecycle-observer' ||
            receipt.runId !== state.runId ||
            receipt.attemptId !== state.attemptId ||
            !state.resourceActorInvocationIds.includes(
                receipt.actorInvocationId
            ) ||
            receipt.terminal !== true ||
            receipt.receiptDigest !==
                unsignedDigest(receipt, 'receiptDigest'))) {
        fail('git-resource-actor-shutdown-invalid')
    }
    if (!sameValue(
        uniqueSorted(actorShutdownReceipts.map(
            ({ actorInvocationId }) => actorInvocationId
        )),
        state.resourceActorInvocationIds
    )) {
        fail('git-resource-actor-shutdown-incomplete')
    }
    const observation =
        processCwdObservation(state.worktreePath)
    if (observation.activeProcesses.length > 0) {
        fail('git-resource-process-still-active')
    }
    const receipt = seal({
        schema:
            'issue-orchestration.git-resource-process-shutdown-receipt.v1',
        producerAuthority:
            'machine-git-resource-cleaner',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        stageRole: state.stageRole,
        sliceId: state.sliceId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        worktreePath: state.worktreePath,
        branchRef: state.branchRef,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        actorShutdownReceiptDigests:
            actorShutdownReceipts.map(
                (value) => value.receiptDigest
            ),
        processObservation: observation,
        observedAt: now()
    }, 'receiptDigest')
    return {
        receipt,
        state: advance(
            state,
            'actors-and-processes-stopped',
            receipt,
            {
                processObservationDigest:
                    observation.observationDigest
            }
        )
    }
}

function validatePhysicalPreState(state, inventory) {
    criticalInventoryCurrent(state, inventory)
    if (processCwdObservation(
        state.worktreePath
    ).activeProcesses.length > 0) {
        fail('git-resource-process-still-active')
    }
}

export function removeGitWorktree({
    state,
    authority,
    inventory
} = {}) {
    validateState(
        state,
        'actors-and-processes-stopped'
    )
    validateAuthority(authority, state)
    validatePhysicalPreState(state, inventory)
    const ordinary = command('git', [
        'worktree',
        'remove',
        state.worktreePath
    ], state.repositoryPath)
    let forced = false
    let forceAuthorization = null
    if (ordinary.status !== 0) {
        if (state.disposition !== 'quarantined' ||
            !state.quarantineReceipt) {
            fail('git-resource-worktree-remove-failed')
        }
        verifyQuarantineReceipt(
            state.quarantineReceipt,
            state,
            inventory
        )
        forceAuthorization = seal({
            schema:
                'issue-orchestration.worktree-force-removal-authorization.v1',
            producerAuthority:
                'machine-git-resource-cleaner',
            policyDigest:
                GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
            lifecycleId: state.lifecycleId,
            runId: state.runId,
            rootAuthorityEpoch: state.rootAuthorityEpoch,
            attemptId: state.attemptId,
            repositoryId: state.repositoryId,
            worktreeResourceId: state.worktreeResourceId,
            branchResourceId: state.branchResourceId,
            worktreePath: state.worktreePath,
            worktreeFilesystemIdentity:
                inventory.worktreeFilesystemIdentity,
            branchRef: state.branchRef,
            baseSha: state.baseSha,
            candidateSha: state.candidateSha,
            deliveryEpoch: state.deliveryEpoch,
            leaseId: state.leaseId,
            inventoryDigest: inventory.inventoryDigest,
            dispositionReceiptDigest:
                state.dispositionReceiptDigest,
            processObservationDigest:
                state.processObservationDigest,
            disposition: state.disposition,
            quarantineReceiptDigest:
                state.quarantineReceipt.receiptDigest,
            ordinaryFailureStatus: ordinary.status,
            ordinaryFailureDigest:
                digest(String(ordinary.stderr ?? '')),
            reason:
                'ordinary-git-aware-remove-rejected-preserved-dirty-state',
            authorizedAt: now()
        }, 'authorizationDigest')
        git(state.repositoryPath, [
            'worktree',
            'remove',
            '--force',
            state.worktreePath
        ], 'git-resource-forced-worktree-remove-failed')
        forced = true
    }
    git(state.repositoryPath, [
        'worktree',
        'prune'
    ], 'git-resource-worktree-prune-failed')
    const remaining = listWorktrees(state.repositoryPath)
    if (fs.existsSync(state.worktreePath) ||
        remaining.some(({ path: value }) =>
            value === state.worktreePath) ||
        fs.existsSync(inventory.worktreeRegistryEntry)) {
        fail('git-resource-worktree-postcheck-failed')
    }
    const receipt = seal({
        schema:
            'issue-orchestration.worktree-removal-receipt.v1',
        producerAuthority:
            'machine-git-resource-cleaner',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        worktreePath: state.worktreePath,
        worktreeFilesystemIdentity:
            inventory.worktreeFilesystemIdentity,
        worktreeRegistryEntry:
            inventory.worktreeRegistryEntry,
        branchRef: state.branchRef,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        disposition: state.disposition,
        inventoryDigest: inventory.inventoryDigest,
        dispositionReceiptDigest:
            state.dispositionReceiptDigest,
        processObservationDigest:
            state.processObservationDigest,
        commandClass: forced
            ? 'git-worktree-remove-force-and-prune'
            : 'git-worktree-remove-and-prune',
        forceAuthorizationDigest:
            forceAuthorization?.authorizationDigest ?? null,
        pathAbsent: true,
        registryEntryAbsent: true,
        gitMetadataPruned: true,
        removedAt: now()
    }, 'receiptDigest')
    return {
        receipt,
        forceAuthorization,
        state: advance(
            state,
            'worktree-removed',
            receipt,
            {
                worktreeRemovalReceiptDigest:
                    receipt.receiptDigest
            }
        )
    }
}

function assertNoBranchCheckout(state) {
    if (listWorktrees(state.repositoryPath).some(
        ({ branchRef }) => branchRef === state.branchRef
    )) {
        fail('git-resource-branch-still-checked-out')
    }
}

function expectedUnchangedRefs(state, inventory, after) {
    const excluded = new Set([
        state.branchRef,
        state.quarantineReceipt?.quarantineRef
    ].filter(Boolean))
    const beforeComparable = Object.fromEntries(
        Object.entries(inventory.refs)
            .filter(([ref]) => !excluded.has(ref))
    )
    const afterComparable = Object.fromEntries(
        Object.entries(after)
            .filter(([ref]) => !excluded.has(ref))
    )
    if (!sameValue(beforeComparable, afterComparable)) {
        fail('git-resource-unexpected-ref-change')
    }
}

export function retireGitLocalRef({
    state,
    authority,
    inventory
} = {}) {
    validateState(state, 'worktree-removed')
    validateAuthority(authority, state)
    validateInventory(inventory, state)
    assertNoBranchCheckout(state)
    if (readRef(state.repositoryPath, state.branchRef) !==
            state.candidateSha) {
        fail('git-resource-branch-sha-drift')
    }
    let commandClass
    let nextState
    if (state.disposition === 'landed') {
        validateLandingMapping(
            state.landingMapping,
            state,
            inventory
        )
        if (state.landingMapping.mappingType ===
                'merge-ancestry') {
            git(state.repositoryPath, [
                'branch',
                '-d',
                state.branchRef.slice('refs/heads/'.length)
            ], 'git-resource-safe-branch-delete-failed')
            commandClass = 'git-branch-safe-delete'
        } else {
            git(state.repositoryPath, [
                'branch',
                '-D',
                state.branchRef.slice('refs/heads/'.length)
            ], 'git-resource-mapped-branch-delete-failed')
            commandClass =
                'git-branch-force-delete-exact-mapping'
        }
        nextState = 'local-ref-retired'
    } else if (state.disposition === 'quarantined') {
        verifyQuarantineReceipt(
            state.quarantineReceipt,
            state,
            inventory
        )
        git(state.repositoryPath, [
            'update-ref',
            '-d',
            state.branchRef,
            state.candidateSha
        ], 'git-resource-quarantined-branch-retire-failed')
        commandClass =
            'git-update-ref-delete-after-quarantine'
        nextState = 'quarantined'
    } else if (state.disposition === 'discard-authorized' ||
        state.disposition === 'superseded') {
        git(state.repositoryPath, [
            'branch',
            '-D',
            state.branchRef.slice('refs/heads/'.length)
        ], 'git-resource-authorized-branch-delete-failed')
        commandClass =
            'git-branch-force-delete-disposition-authorized'
        nextState = 'local-ref-retired'
    } else {
        fail('git-resource-disposition-invalid')
    }
    if (readRef(state.repositoryPath, state.branchRef, {
        missingAllowed: true
    }) !== null) {
        fail('git-resource-branch-postcheck-failed')
    }
    const afterRefs = listRefs(state.repositoryPath)
    expectedUnchangedRefs(state, inventory, afterRefs)
    const receipt = seal({
        schema:
            'issue-orchestration.branch-retirement-receipt.v1',
        producerAuthority:
            'machine-git-resource-cleaner',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        branchRef: state.branchRef,
        expectedSha: state.candidateSha,
        baseSha: state.baseSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        defaultBranchRef: state.defaultBranchRef,
        defaultBranchSha: inventory.defaultBranchSha,
        disposition: state.disposition,
        inventoryDigest: inventory.inventoryDigest,
        dispositionReceiptDigest:
            state.dispositionReceiptDigest,
        worktreeRemovalReceiptDigest:
            state.worktreeRemovalReceiptDigest,
        landingMappingDigest:
            state.landingMapping?.mappingDigest ?? null,
        quarantineReceiptDigest:
            state.quarantineReceiptDigest,
        commandClass,
        branchAbsent: true,
        unexpectedRefChange: false,
        retiredAt: now()
    }, 'receiptDigest')
    return {
        receipt,
        state: advance(
            state,
            nextState,
            receipt,
            {
                branchRetirementReceiptDigest:
                    receipt.receiptDigest
            }
        )
    }
}

function remoteSnapshot(state) {
    const result = command('git', [
        'ls-remote',
        '--refs',
        state.remoteName,
        state.remoteRef
    ], state.repositoryPath)
    if (result.status !== 0) {
        fail('git-resource-remote-observation-failed')
    }
    const line = result.stdout.trim()
    return seal({
        schema:
            'issue-orchestration.git-remote-ref-snapshot.v1',
        producerAuthority:
            'machine-git-remote-observer',
        repositoryId: state.repositoryId,
        remoteName: state.remoteName,
        ref: state.remoteRef,
        sha: line ? line.split(/\s+/u)[0] : null,
        observedAt: now()
    }, 'snapshotDigest')
}

export function cleanupRemoteStagingRef({
    state,
    authority,
    remoteMutationAuthorization
} = {}) {
    if (!['local-ref-retired', 'quarantined']
        .includes(state?.currentState)) {
        fail('git-resource-remote-cleanup-state-invalid')
    }
    validateState(state, state.currentState)
    validateAuthority(authority, state)
    if (state.remoteRef === null) {
        fail('git-resource-remote-ref-not-configured')
    }
    if (remoteMutationAuthorization?.schema !==
            'issue-orchestration.git-remote-cleanup-authorization.v1' ||
        remoteMutationAuthorization.actorRole !== 'root-control' ||
        remoteMutationAuthorization.lifecycleId !==
            state.lifecycleId ||
        remoteMutationAuthorization.runId !== state.runId ||
        remoteMutationAuthorization.rootAuthorityEpoch !==
            state.rootAuthorityEpoch ||
        remoteMutationAuthorization.attemptId !== state.attemptId ||
        remoteMutationAuthorization.repositoryId !==
            state.repositoryId ||
        remoteMutationAuthorization.worktreeResourceId !==
            state.worktreeResourceId ||
        remoteMutationAuthorization.branchResourceId !==
            state.branchResourceId ||
        remoteMutationAuthorization.ref !== state.remoteRef ||
        remoteMutationAuthorization.expectedSha !==
            state.remoteExpectedSha ||
        remoteMutationAuthorization.baseSha !== state.baseSha ||
        remoteMutationAuthorization.candidateSha !==
            state.candidateSha ||
        remoteMutationAuthorization.deliveryEpoch !==
            state.deliveryEpoch ||
        remoteMutationAuthorization.leaseId !== state.leaseId ||
        remoteMutationAuthorization.authorizationDigest !==
            unsignedDigest(
                remoteMutationAuthorization,
                'authorizationDigest'
            )) {
        fail('git-resource-remote-authorization-invalid')
    }
    const before = remoteSnapshot(state)
    if (before.sha !== state.remoteExpectedSha) {
        fail('git-resource-remote-sha-drift')
    }
    git(state.repositoryPath, [
        'push',
        `--force-with-lease=${state.remoteRef}:` +
            state.remoteExpectedSha,
        state.remoteName,
        `:${state.remoteRef}`
    ], 'git-resource-remote-delete-failed')
    const after = remoteSnapshot(state)
    if (after.sha !== null) {
        fail('git-resource-remote-postcheck-failed')
    }
    return seal({
        schema:
            'issue-orchestration.remote-staging-ref-cleanup-receipt.v1',
        producerAuthority:
            'machine-git-resource-cleaner',
        actorRole: 'root-control',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        remoteName: state.remoteName,
        ref: state.remoteRef,
        expectedSha: state.remoteExpectedSha,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        authorizationDigest:
            remoteMutationAuthorization.authorizationDigest,
        beforeSnapshotDigest: before.snapshotDigest,
        afterSnapshotDigest: after.snapshotDigest,
        deleted: true,
        cleanedAt: now()
    }, 'receiptDigest')
}

export function authorizeRemoteStagingRefCleanup({
    state,
    authority
} = {}) {
    if (!['local-ref-retired', 'quarantined']
        .includes(state?.currentState)) {
        fail('git-resource-remote-cleanup-state-invalid')
    }
    validateState(state, state.currentState)
    validateAuthority(authority, state)
    if (state.remoteRef === null) {
        fail('git-resource-remote-ref-not-configured')
    }
    return seal({
        schema:
            'issue-orchestration.git-remote-cleanup-authorization.v1',
        actorRole: 'root-control',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        remoteName: state.remoteName,
        ref: state.remoteRef,
        expectedSha: state.remoteExpectedSha,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        action: 'delete-exact-remote-staging-ref',
        authorizedAt: now()
    }, 'authorizationDigest')
}

function verifyPhysicalRetirement(
    state,
    inventory,
    remoteCleanupReceipt
) {
    validateInventory(inventory, {
        ...state,
        inventoryDigest: inventory.inventoryDigest
    })
    if (fs.existsSync(state.worktreePath) ||
        listWorktrees(state.repositoryPath).some(
            ({ path: value, branchRef }) =>
                value === state.worktreePath ||
                branchRef === state.branchRef
        ) ||
        fs.existsSync(inventory.worktreeRegistryEntry) ||
        readRef(state.repositoryPath, state.branchRef, {
            missingAllowed: true
        }) !== null ||
        readRef(state.repositoryPath, state.defaultBranchRef) !==
            inventory.defaultBranchSha) {
        fail('git-resource-physical-retirement-incomplete')
    }
    const primary = listWorktrees(state.repositoryPath)[0]
    if (!primary ||
        primary.head !== inventory.repositoryHeadSha ||
        gitText(
            primary.path,
            ['write-tree'],
            'git-resource-primary-index-observation-failed'
        ) !== inventory.repositoryIndexTree ||
        digest(
            statusBuffer(primary.path).toString('base64')
        ) !== inventory.repositoryStatusDigest) {
        fail('git-resource-primary-worktree-drift')
    }
    const processes = processCwdObservation(state.worktreePath)
    if (processes.activeProcesses.length > 0) {
        fail('git-resource-process-still-active')
    }
    if (state.disposition === 'quarantined') {
        verifyQuarantineReceipt(
            state.quarantineReceipt,
            state,
            inventory
        )
    }
    if (state.remoteRef !== null) {
        if (remoteCleanupReceipt?.schema !==
                'issue-orchestration.remote-staging-ref-cleanup-receipt.v1' ||
            remoteCleanupReceipt.receiptDigest !==
                unsignedDigest(
                    remoteCleanupReceipt,
                    'receiptDigest'
                ) ||
            remoteCleanupReceipt.lifecycleId !==
                state.lifecycleId ||
            remoteCleanupReceipt.expectedSha !==
                state.remoteExpectedSha ||
            remoteSnapshot(state).sha !== null) {
            fail('git-resource-remote-cleanup-required')
        }
    } else if (remoteCleanupReceipt !== null) {
        fail('git-resource-remote-cleanup-unexpected')
    }
    return processes
}

export function releaseGitResourceLeaseAndSlot({
    state,
    authority,
    inventory,
    remoteCleanupReceipt = null,
    slotReleaseObservation
} = {}) {
    if (!['local-ref-retired', 'quarantined']
        .includes(state?.currentState)) {
        fail('git-resource-release-state-invalid')
    }
    validateState(state, state.currentState)
    validateAuthority(authority, state)
    const processObservation = verifyPhysicalRetirement(
        state,
        inventory,
        remoteCleanupReceipt
    )
    if (slotReleaseObservation?.schema !==
            'issue-orchestration.resource-slot-release-observation.v1' ||
        slotReleaseObservation.producerAuthority !==
            'machine-resource-slot-registry' ||
        slotReleaseObservation.runId !== state.runId ||
        slotReleaseObservation.attemptId !== state.attemptId ||
        slotReleaseObservation.resourceId !==
            state.worktreeResourceId ||
        slotReleaseObservation.slotId !== state.slotId ||
        slotReleaseObservation.releaseAuthorized !== true ||
        slotReleaseObservation.released !== false ||
        !Array.isArray(
            slotReleaseObservation.activeResourceReferences
        ) ||
        slotReleaseObservation.activeResourceReferences.length > 0 ||
        slotReleaseObservation.observationDigest !==
            unsignedDigest(
                slotReleaseObservation,
                'observationDigest'
            )) {
        fail('git-resource-slot-release-observation-invalid')
    }
    if (!fs.existsSync(state.leasePath)) {
        fail('git-resource-lease-identity-missing')
    }
    let lease
    try {
        lease = JSON.parse(
            fs.readFileSync(state.leasePath, 'utf8')
        )
    } catch {
        fail('git-resource-lease-identity-invalid')
    }
    if (lease.leaseId !== state.leaseId ||
        lease.runId !== state.runId ||
        lease.attemptId !== state.attemptId ||
        lease.resourceId !== state.worktreeResourceId ||
        lease.state !== 'active') {
        fail('git-resource-lease-identity-invalid')
    }
    fs.rmSync(state.leasePath, { force: false })
    if (fs.existsSync(state.leasePath)) {
        fail('git-resource-lease-release-failed')
    }
    const receipt = seal({
        schema:
            'issue-orchestration.git-resource-lease-release-receipt.v1',
        producerAuthority:
            'machine-git-resource-cleaner',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        stageRole: state.stageRole,
        sliceId: state.sliceId,
        repositoryId: state.repositoryId,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        leaseId: state.leaseId,
        slotId: state.slotId,
        physicalVerificationDigest: digest({
            worktreeAbsent: true,
            registryAbsent: true,
            branchAbsent: true,
            processObservationDigest:
                processObservation.observationDigest,
            quarantineReceiptDigest:
                state.quarantineReceiptDigest,
            remoteCleanupReceiptDigest:
                remoteCleanupReceipt?.receiptDigest ?? null
        }),
        slotReleaseObservationDigest:
            slotReleaseObservation.observationDigest,
        remoteCleanupReceiptDigest:
            remoteCleanupReceipt?.receiptDigest ?? null,
        leaseAbsent: true,
        slotReleased: true,
        releasedAt: now()
    }, 'receiptDigest')
    return {
        receipt,
        state: advance(
            state,
            'lease-and-slot-released',
            receipt,
            {
                remoteCleanupReceiptDigest:
                    remoteCleanupReceipt?.receiptDigest ?? null,
                leaseReleaseReceiptDigest:
                    receipt.receiptDigest,
                leaseReleased: true,
                slotReleased: true
            }
        )
    }
}

export function verifyGitResourceCleanup({
    state,
    inventory,
    remoteCleanupReceipt = null
} = {}) {
    validateState(state, 'lease-and-slot-released')
    if (state.leaseReleased !== true ||
        state.slotReleased !== true ||
        fs.existsSync(state.leasePath)) {
        fail('git-resource-release-not-observed')
    }
    const processObservation = verifyPhysicalRetirement(
        state,
        inventory,
        remoteCleanupReceipt
    )
    expectedUnchangedRefs(
        state,
        inventory,
        listRefs(state.repositoryPath)
    )
    const evidence = seal({
        schema:
            'issue-orchestration.git-resource-post-cleanup-observation.v1',
        producerAuthority: 'machine-resource-verifier',
        lifecycleId: state.lifecycleId,
        worktreePathAbsent: true,
        worktreeRegistryEntryAbsent: true,
        branchRefAbsent: true,
        quarantineRef:
            state.quarantineReceipt?.quarantineRef ?? null,
        quarantineVerified:
            state.disposition === 'quarantined'
                ? true
                : null,
        defaultBranchRef: state.defaultBranchRef,
        defaultBranchSha: inventory.defaultBranchSha,
        processObservation,
        leasePathAbsent: true,
        slotReleased: true,
        remoteRefAbsent:
            state.remoteRef === null ? null : true,
        unexpectedRefChange: false,
        observedAt: now()
    }, 'observationDigest')
    const finalState = advance(
        state,
        'post-cleanup-verified',
        evidence
    )
    const receipt = seal({
        schema:
            'issue-orchestration.git-resource-cleanup-verification.v1',
        actorRole: 'machine-resource-verifier',
        status: 'post-cleanup-verified',
        policyDigest: GIT_RESOURCE_CLEANUP_POLICY_DIGEST,
        lifecycleId: state.lifecycleId,
        runId: state.runId,
        rootAuthorityEpoch: state.rootAuthorityEpoch,
        attemptId: state.attemptId,
        stageRole: state.stageRole,
        sliceId: state.sliceId,
        resourceActorInvocationIds:
            state.resourceActorInvocationIds,
        repositoryId: state.repositoryId,
        repositoryPath: state.repositoryPath,
        defaultBranchRef: state.defaultBranchRef,
        defaultBranchSha: inventory.defaultBranchSha,
        worktreeResourceId: state.worktreeResourceId,
        branchResourceId: state.branchResourceId,
        worktreePath: state.worktreePath,
        branchRef: state.branchRef,
        leaseId: state.leaseId,
        leasePath: state.leasePath,
        slotId: state.slotId,
        baseSha: state.baseSha,
        candidateSha: state.candidateSha,
        deliveryEpoch: state.deliveryEpoch,
        disposition: state.disposition,
        deliveryClean:
            state.disposition !== 'quarantined',
        quarantineReceiptDigest:
            state.quarantineReceiptDigest,
        quarantineRef:
            state.quarantineReceipt?.quarantineRef ?? null,
        worktreeRemovalReceiptDigest:
            state.worktreeRemovalReceiptDigest,
        branchRetirementReceiptDigest:
            state.branchRetirementReceiptDigest,
        remoteCleanupReceiptDigest:
            state.remoteCleanupReceiptDigest,
        leaseReleaseReceiptDigest:
            state.leaseReleaseReceiptDigest,
        postCleanupObservationDigest:
            evidence.observationDigest,
        finalStateDigest: finalState.stateDigest,
        verifiedAt: now()
    }, 'receiptDigest')
    validateGitResourceCleanupVerification(receipt)
    return { state: finalState, receipt, observation: evidence }
}

export function reobserveGitResourceCleanupVerification(
    receipt,
    bindings = {}
) {
    validateGitResourceCleanupVerification(receipt, bindings)
    const repositoryPath = canonicalExistingDirectory(
        receipt.repositoryPath,
        'git-resource-cleanup-reobservation-failed'
    )
    if (repositoryPath !== receipt.repositoryPath ||
        fs.existsSync(receipt.worktreePath) ||
        listWorktrees(repositoryPath).some(
            ({ path: value, branchRef }) =>
                value === receipt.worktreePath ||
                branchRef === receipt.branchRef
        ) ||
        readRef(repositoryPath, receipt.branchRef, {
            missingAllowed: true
        }) !== null ||
        readRef(repositoryPath, receipt.defaultBranchRef) !==
            receipt.defaultBranchSha ||
        fs.existsSync(receipt.leasePath)) {
        fail('git-resource-cleanup-reobservation-failed')
    }
    if (receipt.disposition === 'quarantined' &&
        readRef(repositoryPath, receipt.quarantineRef) !==
            receipt.candidateSha) {
        fail('git-resource-cleanup-reobservation-failed')
    }
    const processes = processCwdObservation(
        receipt.worktreePath
    )
    if (processes.activeProcesses.length > 0) {
        fail('git-resource-cleanup-reobservation-failed')
    }
    return {
        receipt,
        processObservation: processes
    }
}

export function validateGitResourceCleanupVerification(
    receipt,
    {
        runId,
        attemptId,
        worktreeResourceId,
        branchResourceId,
        leaseId,
        requireCleanDelivery = false
    } = {}
) {
    if (receipt?.schema !==
            'issue-orchestration.git-resource-cleanup-verification.v1' ||
        receipt.actorRole !== 'machine-resource-verifier' ||
        receipt.status !== 'post-cleanup-verified' ||
        receipt.policyDigest !==
            GIT_RESOURCE_CLEANUP_POLICY_DIGEST ||
        receipt.receiptDigest !==
            unsignedDigest(receipt, 'receiptDigest') ||
        !HASH.test(receipt.finalStateDigest ?? '') ||
        !HASH.test(
            receipt.postCleanupObservationDigest ?? ''
        ) ||
        typeof receipt.defaultBranchRef !== 'string' ||
        !receipt.defaultBranchRef ||
        !SHA.test(receipt.defaultBranchSha ?? '') ||
        typeof receipt.leasePath !== 'string' ||
        !receipt.leasePath ||
        !GIT_RESOURCE_CLEANUP_POLICY
            .candidateDispositions
            .includes(receipt.disposition) ||
        receipt.deliveryClean !==
            (receipt.disposition !== 'quarantined') ||
        requireCleanDelivery && receipt.deliveryClean !== true) {
        fail('git-resource-cleanup-verification-invalid')
    }
    for (const [actual, expected] of [
        [receipt.runId, runId],
        [receipt.attemptId, attemptId],
        [receipt.worktreeResourceId, worktreeResourceId],
        [receipt.branchResourceId, branchResourceId],
        [receipt.leaseId, leaseId]
    ]) {
        if (expected !== undefined && actual !== expected) {
            fail('git-resource-cleanup-verification-binding-mismatch')
        }
    }
    return receipt
}

export function sealMachineReceipt(value, digestField) {
    return seal(value, digestField)
}
