import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// Shared issue-orchestration package runtime.

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const EPOCH = /^epoch-[A-Za-z0-9][A-Za-z0-9._-]*-[0-9]+$/u
const RESOURCE_TYPES = new Set([
    'worktree', 'branch', 'process-group', 'port', 'container', 'network',
    'volume', 'temporary-directory', 'lock', 'lease'
])

export class ResourceLifecycleError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'ResourceLifecycleError'
        this.code = code
    }
}

function fail(code, message) {
    throw new ResourceLifecycleError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function unique(values) {
    return [...new Set(values ?? [])]
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function command(commandName, args, cwd) {
    return spawnSync(commandName, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true
    })
}

function commandOutput(commandName, args, cwd) {
    const result = command(commandName, args, cwd)
    return result.status === 0 ? result.stdout.trim() : null
}

function resolvedRoot(root) {
    if (!isText(root)) fail('resource-inventory-root')
    const resolved = path.resolve(root)
    if (!fs.existsSync(resolved)) fail('resource-inventory-root')
    return fs.realpathSync(resolved)
}

function parseWorktreeInventory(output) {
    const worktrees = []
    let current = null
    for (const line of output.split('\n')) {
        if (!line) continue
        const separator = line.indexOf(' ')
        const key = separator < 0 ? line : line.slice(0, separator)
        const value = separator < 0 ? '' : line.slice(separator + 1)
        if (key === 'worktree') {
            if (current) worktrees.push(current)
            current = { path: path.resolve(value), branch: null, head: null }
        } else if (current && key === 'branch') {
            current.branch = value.replace(/^refs\/heads\//u, '')
        } else if (current && key === 'HEAD') {
            current.head = value
        }
    }
    if (current) worktrees.push(current)
    return worktrees
}

function observeRepositoryRoot(repositoryRoot) {
    const root = resolvedRoot(repositoryRoot)
    if (commandOutput('git', ['rev-parse', '--is-inside-work-tree'], root) !== 'true') {
        fail('resource-inventory-repository')
    }
    const worktreeOutput = commandOutput('git', ['worktree', 'list', '--porcelain'], root)
    const branchOutput = commandOutput('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], root)
    if (worktreeOutput === null || branchOutput === null) fail('resource-inventory-repository')
    return {
        repositoryRoot: root,
        worktrees: parseWorktreeInventory(worktreeOutput),
        branches: branchOutput ? branchOutput.split('\n').filter(Boolean).sort() : []
    }
}

function observeTemporaryRoot(temporaryRoot) {
    const root = resolvedRoot(temporaryRoot)
    const entries = fs.readdirSync(root, { withFileTypes: true })
        .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other'
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    return { temporaryRoot: root, entries }
}

function observeDocker(mode) {
    if (mode !== 'observe-only' && mode !== 'cleanup') {
        fail('docker-observation-mode')
    }
    const version = command('docker', ['version', '--format', '{{.Server.Version}}'])
    if (version.status !== 0) {
        return { availability: 'unavailable', mode, resources: [] }
    }
    const result = command('docker', [
        'ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Status}}\t{{.Names}}\t{{.Labels}}'
    ])
    if (result.status !== 0) return { availability: 'unavailable', mode, resources: [] }
    const resources = result.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [containerId, status, name, labels = ''] = line.split('\t')
        return { containerId, status, name, labels }
    })
    return { availability: 'available', mode, resources }
}

function unsignedDigest(value, digestField) {
    const unsigned = clone(value)
    delete unsigned[digestField]
    return digest(unsigned)
}

function validateRegistry(registry) {
    if (registry?.schema !== 'issue-orchestration.resource-registry.v1') {
        fail('resource-registry-schema')
    }
    if (!Array.isArray(registry.resources)) fail('resource-registry-schema')
    const ownerFields = ['runId', 'issueId', 'stageAttemptId', 'stageRole', 'issueWorktreeId']
    if (ownerFields.some((field) => !isText(registry[field]))) {
        fail('resource-registry-owner-binding')
    }
    if (!EPOCH.test(registry.epochId ?? '')) fail('resource-registry-epoch-binding')
    if (!HASH.test(registry.allowedPathsDigest ?? '') || !HASH.test(registry.testContractDigest ?? '')) {
        fail('resource-registry-contract-binding')
    }
    if (registry.baseSha !== undefined && !SHA.test(registry.baseSha)) {
        fail('resource-registry-identity')
    }
    if (registry.writeLease !== undefined && (!isText(registry.writeLease?.id)
        || registry.writeLease.ownerAttemptId !== registry.stageAttemptId
        || registry.writeLease.mode !== 'write'
        || !['active', 'revoked', 'released'].includes(registry.writeLease.state))) {
        fail('resource-registry-owner-binding')
    }
    const ids = registry.resources.map(({ resourceId }) => resourceId)
    if (ids.some((id) => typeof id !== 'string' || id.length === 0)
        || new Set(ids).size !== ids.length) {
        fail('resource-registry-identity')
    }
    for (const resource of registry.resources) {
        if (!RESOURCE_TYPES.has(resource.resourceType) || !isText(resource.ownerClass)
            || resource.ownerRunId !== registry.runId
            || resource.ownerAttemptId !== registry.stageAttemptId) {
            fail('resource-registry-owner-binding')
        }
        if (!isText(resource.state ?? 'active')) fail('resource-registry-identity')
    }
}

export function createResourceRegistry(input) {
    const registry = clone(input)
    validateRegistry(registry)
    registry.selfTestCycles ??= []
    registry.firstFailureRefs ??= []
    return registry
}

export async function captureBaselineInventory({
    repositoryRoots = [],
    temporaryRoots = [],
    dockerMode = 'observe-only'
} = {}) {
    if (!Array.isArray(repositoryRoots) || !Array.isArray(temporaryRoots)) {
        fail('resource-inventory-roots')
    }
    const repositories = unique(repositoryRoots.map(resolvedRoot)).map(observeRepositoryRoot)
    const temporary = unique(temporaryRoots.map(resolvedRoot)).map(observeTemporaryRoot)
    const baseline = {
        schema: 'issue-orchestration.resource-baseline-inventory.v1',
        capturedAt: new Date().toISOString(),
        repositories,
        temporaryRoots: temporary,
        docker: observeDocker(dockerMode)
    }
    baseline.baselineDigest = unsignedDigest(baseline, 'baselineDigest')
    return baseline
}

function baselineRepository(baseline, root) {
    return baseline.repositories?.find(({ repositoryRoot }) => repositoryRoot === root) ?? null
}

function baselineTemporaryRoot(baseline, root) {
    return baseline.temporaryRoots?.find(({ temporaryRoot }) => temporaryRoot === root) ?? null
}

function registeredResourceForWorktree(registry, worktree) {
    return registry.resources.find((resource) => resource.resourceType === 'worktree'
        && path.resolve(resource.identityEvidence?.path ?? '') === path.resolve(worktree.path))
}

function registeredResourceForBranch(registry, repositoryRoot, branch) {
    return registry.resources.find((resource) => resource.resourceType === 'branch'
        && resource.identityEvidence?.repositoryRoot
        && path.resolve(resource.identityEvidence.repositoryRoot) === repositoryRoot
        && resource.identityEvidence?.name === branch)
}

function registeredResourceForTemporaryEntry(registry, root, name) {
    const entryPath = path.join(root, name)
    return registry.resources.find((resource) => resource.resourceType === 'temporary-directory'
        && path.resolve(resource.identityEvidence?.path ?? '') === entryPath)
}

export async function observeResourceInventory({
    registry,
    baseline,
    repositoryRoots,
    temporaryRoots,
    dockerMode = 'observe-only'
} = {}) {
    const boundRegistry = createResourceRegistry(registry)
    if (baseline?.schema !== 'issue-orchestration.resource-baseline-inventory.v1'
        || !HASH.test(baseline.baselineDigest ?? '')
        || baseline.baselineDigest !== unsignedDigest(baseline, 'baselineDigest')) {
        fail('resource-baseline-binding')
    }
    const current = await captureBaselineInventory({
        repositoryRoots: repositoryRoots ?? baseline.repositories.map(({ repositoryRoot }) => repositoryRoot),
        temporaryRoots: temporaryRoots ?? baseline.temporaryRoots.map(({ temporaryRoot }) => temporaryRoot),
        dockerMode
    })
    const unknownResources = []
    for (const repository of current.repositories) {
        const before = baselineRepository(baseline, repository.repositoryRoot)
        if (!before) {
            unknownResources.push({ resourceType: 'repository', repositoryRoot: repository.repositoryRoot })
            continue
        }
        const baselineWorktrees = new Set(before.worktrees.map(({ path: entry }) => path.resolve(entry)))
        for (const worktree of repository.worktrees) {
            if (!baselineWorktrees.has(path.resolve(worktree.path))
                && !registeredResourceForWorktree(boundRegistry, worktree)) {
                unknownResources.push({ resourceType: 'worktree', path: worktree.path, repositoryRoot: repository.repositoryRoot })
            }
        }
        const baselineBranches = new Set(before.branches)
        for (const branch of repository.branches) {
            if (!baselineBranches.has(branch)
                && !registeredResourceForBranch(boundRegistry, repository.repositoryRoot, branch)) {
                unknownResources.push({ resourceType: 'branch', name: branch, repositoryRoot: repository.repositoryRoot })
            }
        }
    }
    for (const temporaryRoot of current.temporaryRoots) {
        const before = baselineTemporaryRoot(baseline, temporaryRoot.temporaryRoot)
        if (!before) {
            unknownResources.push({ resourceType: 'temporary-root', path: temporaryRoot.temporaryRoot })
            continue
        }
        const baselineEntries = new Set(before.entries.map(({ name }) => name))
        for (const entry of temporaryRoot.entries) {
            if (!baselineEntries.has(entry.name)
                && !registeredResourceForTemporaryEntry(boundRegistry, temporaryRoot.temporaryRoot, entry.name)) {
                unknownResources.push({
                    resourceType: entry.type === 'directory' ? 'temporary-directory' : 'temporary-entry',
                    path: path.join(temporaryRoot.temporaryRoot, entry.name)
                })
            }
        }
    }
    return {
        schema: 'issue-orchestration.resource-inventory-observation.v1',
        status: unknownResources.length > 0 ? 'owner-conflict' : 'observed',
        registryIdentity: digest({
            runId: boundRegistry.runId,
            attemptId: boundRegistry.stageAttemptId,
            epochId: boundRegistry.epochId
        }),
        baselineDigest: baseline.baselineDigest,
        inventory: current,
        unknownResources,
        observedAt: new Date().toISOString()
    }
}

function resourceIdentity(resource) {
    return resource.identityEvidence ?? {}
}

function resourceAction(resource, action, details = {}) {
    return {
        resourceId: resource.resourceId,
        resourceType: resource.resourceType,
        action,
        ...details
    }
}

function findRepositoryForResource(resource, baseline, registry) {
    const identity = resourceIdentity(resource)
    if (isText(identity.repositoryRoot)) return path.resolve(identity.repositoryRoot)
    if (resource.resourceType === 'worktree') {
        const branch = registry.resources.find((candidate) =>
            candidate.resourceType === 'branch'
            && candidate.identityEvidence?.name === identity.branch)
        if (branch?.identityEvidence?.repositoryRoot) {
            return path.resolve(branch.identityEvidence.repositoryRoot)
        }
    }
    if (baseline.repositories?.length === 1) return baseline.repositories[0].repositoryRoot
    return null
}

function isOwnedTemporaryPath(baseline, candidatePath) {
    const target = path.resolve(candidatePath)
    return baseline.temporaryRoots?.some(({ temporaryRoot }) => {
        const root = path.resolve(temporaryRoot)
        return target.startsWith(`${root}${path.sep}`)
    }) ?? false
}

function worktreeIsDirty(worktreePath) {
    if (!fs.existsSync(worktreePath)) return false
    const result = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], worktreePath)
    if (result.status !== 0) fail('resource-worktree-observation')
    return Boolean(result.stdout.trim())
}

function currentProcessGroupId() {
    const output = commandOutput('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    const value = Number.parseInt(output ?? '', 10)
    return Number.isInteger(value) && value > 0 ? value : null
}

function processGroupMembers(processGroupId) {
    if (!Number.isInteger(processGroupId) || processGroupId <= 0) return []
    const output = commandOutput('ps', ['-eo', 'pid=,pgid='])
    if (output === null) return []
    return output.split('\n').map((line) => line.trim().split(/\s+/u))
        .filter(([pid, group]) => Number.parseInt(group, 10) === processGroupId)
        .map(([pid]) => Number.parseInt(pid, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function wait(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function terminateProcessGroup(processGroupId) {
    if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
        return { status: 'absent', descendants: [] }
    }
    if (processGroupId === currentProcessGroupId()) fail('resource-process-group-self-target')
    let descendants = processGroupMembers(processGroupId)
    if (descendants.length === 0) return { status: 'absent', descendants }
    try {
        process.kill(-processGroupId, 'SIGTERM')
    } catch (error) {
        if (error?.code !== 'ESRCH') fail('resource-process-group-signal')
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(25)
        descendants = processGroupMembers(processGroupId)
        if (descendants.length === 0) return { status: 'terminated', descendants }
    }
    try {
        process.kill(-processGroupId, 'SIGKILL')
    } catch (error) {
        if (error?.code !== 'ESRCH') fail('resource-process-group-signal')
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(25)
        descendants = processGroupMembers(processGroupId)
        if (descendants.length === 0) return { status: 'killed', descendants }
    }
    return { status: 'still-live', descendants }
}

async function portIsAvailable(port) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false
    return await new Promise((resolvePromise) => {
        const server = net.createServer()
        server.once('error', () => resolvePromise(false))
        server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)))
    })
}

function observeLockRelease(lockPath) {
    const result = command('flock', ['-n', '-x', lockPath, 'true'])
    return {
        exitStatus: result.status,
        signal: result.signal ?? null,
        errorCode: result.error?.code ?? null,
        released: result.status === 0
    }
}

function observeLockIdentity(lockPath) {
    const parentPath = path.dirname(lockPath)
    if (!fs.existsSync(parentPath) || !fs.existsSync(lockPath)) return null
    let stat
    try {
        stat = fs.statSync(lockPath)
    } catch {
        return null
    }
    return {
        path: lockPath,
        dev: stat.dev,
        inode: stat.ino,
        parentPath
    }
}

function lockParentIsCleanupTarget(registry, lockObservation, isCleanupTarget) {
    return registry.resources.some((resource) => resource.resourceType === 'temporary-directory'
        && isCleanupTarget(resource)
        && isText(resource.identityEvidence?.path)
        && path.resolve(resource.identityEvidence.path) === lockObservation.parentPath)
}

function observeFinalLockFilesystem(lockObservation, registry, isCleanupTarget) {
    const parentExpectedAbsent = lockParentIsCleanupTarget(registry, lockObservation, isCleanupTarget)
    return {
        lockPath: lockObservation.path,
        lockPathExists: fs.existsSync(lockObservation.path),
        parentPath: lockObservation.parentPath,
        parentPathExists: fs.existsSync(lockObservation.parentPath),
        parentExpectedAbsent,
        observedAt: new Date().toISOString()
    }
}

function markResource(next, resourceId, state) {
    const resource = next.resources.find((item) => item.resourceId === resourceId)
    if (resource) resource.state = state
}

function cleanupReceipt({
    registry,
    baseline,
    ownedResourceDigest,
    cleanupActions,
    lockReleaseObservations = [],
    finalFilesystemObservations = [],
    retainedResources,
    quarantinedResources,
    failedResources,
    status,
    postInventory
}) {
    const receipt = {
        schema: 'issue-orchestration.resource-cleanup-receipt.v1',
        actorRole: 'machine-resource-verifier',
        runId: registry.runId,
        attemptId: registry.stageAttemptId,
        epochId: registry.epochId,
        baselineDigest: baseline.baselineDigest,
        ownedResourceDigest,
        cleanupActions,
        lockReleaseObservations,
        finalFilesystemObservations,
        retainedResources,
        quarantinedResources,
        failedResources,
        postInventory,
        postCleanupInventoryDigest: digest(postInventory),
        status,
        verifiedAt: new Date().toISOString()
    }
    receipt.receiptDigest = unsignedDigest(receipt, 'receiptDigest')
    return receipt
}

function activeOwnedResources(registry, isTarget = () => true) {
    return registry.resources.filter((resource) => resource.ownerClass !== 'externally-owned'
        && isTarget(resource)
        && resource.state !== 'removed-clean').map((resource) => ({
        resourceId: resource.resourceId,
        resourceType: resource.resourceType,
        ownerClass: resource.ownerClass,
        state: resource.state
    }))
}

function failResource(resource, reason, failedResources) {
    failedResources.push({
        resourceId: resource.resourceId,
        resourceType: resource.resourceType,
        reason
    })
}

function cleanWorktree(resource, baseline, registry, cleanupActions, failedResources) {
    const identity = resourceIdentity(resource)
    if (!isText(identity.path)) {
        failResource(resource, 'worktree-path-missing', failedResources)
        return
    }
    const worktreePath = path.resolve(identity.path)
    if (!fs.existsSync(worktreePath)) {
        cleanupActions.push(resourceAction(resource, 'already-absent'))
        return
    }
    if (worktreeIsDirty(worktreePath)) {
        failResource(resource, 'dirty-worktree', failedResources)
        return
    }
    const repositoryRoot = findRepositoryForResource(resource, baseline, registry)
    if (!repositoryRoot || !baselineRepository(baseline, repositoryRoot)) {
        failResource(resource, 'worktree-repository-unbound', failedResources)
        return
    }
    if (path.resolve(repositoryRoot) === worktreePath) {
        failResource(resource, 'repository-worktree-retained', failedResources)
        return
    }
    const observed = observeRepositoryRoot(repositoryRoot)
    if (!observed.worktrees.some(({ path: candidate }) => path.resolve(candidate) === worktreePath)) {
        failResource(resource, 'worktree-observation-missing', failedResources)
        return
    }
    const removal = command('git', ['worktree', 'remove', worktreePath], repositoryRoot)
    if (removal.status !== 0) {
        failResource(resource, 'git-worktree-remove-failed', failedResources)
        return
    }
    const prune = command('git', ['worktree', 'prune'], repositoryRoot)
    if (prune.status !== 0 || fs.existsSync(worktreePath)) {
        failResource(resource, 'git-worktree-prune-failed', failedResources)
        return
    }
    cleanupActions.push(resourceAction(resource, 'git-worktree-remove-and-prune', { repositoryRoot }))
}

function cleanBranch(resource, baseline, cleanupActions, failedResources) {
    const identity = resourceIdentity(resource)
    if (!isText(identity.name) || !isText(identity.repositoryRoot)) {
        failResource(resource, 'branch-identity-missing', failedResources)
        return
    }
    const repositoryRoot = path.resolve(identity.repositoryRoot)
    if (!baselineRepository(baseline, repositoryRoot)) {
        failResource(resource, 'branch-repository-unbound', failedResources)
        return
    }
    const primaryWorktree = baselineRepository(baseline, repositoryRoot)?.worktrees.find(
        ({ path: worktreePath }) => path.resolve(worktreePath) === repositoryRoot
    )
    if (primaryWorktree?.branch === identity.name) {
        failResource(resource, 'primary-branch-retained', failedResources)
        return
    }
    const exists = command('git', ['show-ref', '--verify', '--quiet', `refs/heads/${identity.name}`], repositoryRoot)
    if (exists.status === 1) {
        cleanupActions.push(resourceAction(resource, 'already-absent'))
        return
    }
    if (exists.status !== 0) {
        failResource(resource, 'branch-observation-failed', failedResources)
        return
    }
    const deletion = command('git', ['branch', '-d', identity.name], repositoryRoot)
    const after = command('git', ['show-ref', '--verify', '--quiet', `refs/heads/${identity.name}`], repositoryRoot)
    if (deletion.status !== 0 || after.status !== 1) {
        failResource(resource, 'branch-delete-failed', failedResources)
        return
    }
    cleanupActions.push(resourceAction(resource, 'git-branch-delete', { repositoryRoot }))
}

async function cleanProcessGroup(resource, cleanupActions, failedResources) {
    const identity = resourceIdentity(resource)
    const processGroupId = Number(identity.processGroupId ?? identity.leaderPid)
    const result = await terminateProcessGroup(processGroupId)
    if (result.status === 'still-live') {
        failResource(resource, 'process-group-still-live', failedResources)
        return
    }
    cleanupActions.push(resourceAction(resource, 'term-kill-verify-descendants', {
        processGroupId,
        result: result.status
    }))
}

async function cleanPort(resource, cleanupActions, failedResources) {
    const port = Number(resourceIdentity(resource).port)
    if (!await portIsAvailable(port)) {
        failResource(resource, 'port-still-held', failedResources)
        return
    }
    cleanupActions.push(resourceAction(resource, 'port-reusable-observed', { port }))
}

async function cleanLock(resource, cleanupActions, failedResources, lockReleaseObservations) {
    const identity = resourceIdentity(resource)
    const holderPid = Number(identity.holderPid)
    let ownerExitStatus = 'not-recorded'
    let ownerAbsent = false
    if (Number.isInteger(holderPid) && holderPid > 0) {
        const result = await terminateProcessGroup(holderPid)
        ownerExitStatus = result.status
        if (result.status === 'still-live') {
            failResource(resource, 'lock-holder-still-live', failedResources)
            return
        }
        ownerAbsent = result.descendants.length === 0
    }
    if (!isText(identity.path)) {
        failResource(resource, 'lock-path-missing', failedResources)
        return
    }
    const lockPath = path.resolve(identity.path)
    const originalLock = observeLockIdentity(lockPath)
    const lockObservation = {
        resourceId: resource.resourceId,
        resourceType: resource.resourceType,
        path: lockPath,
        dev: originalLock?.dev ?? null,
        inode: originalLock?.inode ?? null,
        parentPath: path.dirname(lockPath),
        lockPathExistsBeforeRelease: originalLock !== null,
        parentPathExistsBeforeRelease: originalLock !== null,
        ownerPid: Number.isInteger(holderPid) && holderPid > 0 ? holderPid : null,
        ownerExitStatus,
        ownerAbsent,
        exitStatus: null,
        probeReleased: false,
        finalFilesystemObservation: null
    }
    lockReleaseObservations.push(lockObservation)
    if (!originalLock) {
        failResource(resource, 'lock-identity-missing', failedResources)
        return
    }
    const release = observeLockRelease(lockPath)
    lockObservation.exitStatus = release.exitStatus
    lockObservation.probeReleased = release.released
    // A successful exclusive reacquire is the machine observation that an
    // otherwise-unrecorded lock owner is absent at the original lock identity.
    if (!lockObservation.ownerAbsent && release.released) lockObservation.ownerAbsent = true
    if (!release.released || !lockObservation.ownerAbsent) {
        failResource(resource, 'lock-still-held', failedResources)
        return
    }
    if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: false })
    if (fs.existsSync(lockPath)) {
        failResource(resource, 'lock-remove-failed', failedResources)
        return
    }
    cleanupActions.push(resourceAction(resource, 'release-and-reacquire-observation'))
}

function cleanLease(resource, cleanupActions, failedResources) {
    const identity = resourceIdentity(resource)
    if (!isText(identity.path) || identity.ownerAttemptId !== resource.ownerAttemptId) {
        failResource(resource, 'lease-owner-mismatch', failedResources)
        return
    }
    const leasePath = path.resolve(identity.path)
    if (fs.existsSync(leasePath)) {
        let payload
        try {
            payload = JSON.parse(fs.readFileSync(leasePath, 'utf8'))
        } catch {
            failResource(resource, 'lease-observation-failed', failedResources)
            return
        }
        if (payload.ownerAttemptId !== resource.ownerAttemptId) {
            failResource(resource, 'lease-owner-mismatch', failedResources)
            return
        }
        fs.rmSync(leasePath, { force: false })
    }
    cleanupActions.push(resourceAction(resource, 'lease-released-after-observation'))
}

function cleanTemporaryDirectory(resource, baseline, cleanupActions, failedResources) {
    const identity = resourceIdentity(resource)
    if (!isText(identity.path)) {
        failResource(resource, 'temporary-path-missing', failedResources)
        return
    }
    const temporaryPath = path.resolve(identity.path)
    if (!isOwnedTemporaryPath(baseline, temporaryPath)) {
        failResource(resource, 'external-temporary-root-retained', failedResources)
        return
    }
    if (!fs.existsSync(temporaryPath)) {
        cleanupActions.push(resourceAction(resource, 'already-absent'))
        return
    }
    if (fs.lstatSync(temporaryPath).isSymbolicLink()) {
        failResource(resource, 'temporary-path-symlink', failedResources)
        return
    }
    fs.rmSync(temporaryPath, { recursive: true, force: false, maxRetries: 3 })
    if (fs.existsSync(temporaryPath)) {
        failResource(resource, 'temporary-remove-failed', failedResources)
        return
    }
    cleanupActions.push(resourceAction(resource, 'remove-owned-only'))
}

export async function cleanupAttemptResources({
    registry,
    baseline,
    actorRole,
    groupCleanup = false,
    groupSessionDigest
} = {}) {
    if (actorRole !== 'machine-resource-verifier') fail('machine-resource-verifier-required')
    const next = createResourceRegistry(registry)
    if (baseline?.schema !== 'issue-orchestration.resource-baseline-inventory.v1'
        || !HASH.test(baseline.baselineDigest ?? '')
        || baseline.baselineDigest !== unsignedDigest(baseline, 'baselineDigest')) {
        fail('resource-baseline-binding')
    }
    const groupResources = next.resources.filter((resource) => resource.ownerClass === 'group-owned')
    if (groupCleanup && groupSessionDigest !== next.groupSessionDigest) {
        fail('group-session-binding-mismatch')
    }
    const isCleanupTarget = (resource) => resource.ownerClass === 'attempt-owned'
        || resource.ownerClass === 'member-stage'
        || (groupCleanup && resource.ownerClass === 'group-owned')
    const retainedGroupResources = groupCleanup ? [] : groupResources.map((resource) => ({
        resourceId: resource.resourceId,
        resourceType: resource.resourceType,
        reason: 'group-resource-retained-until-bound-group-cleanup'
    }))
    const ownedResourceDigest = digest(next.resources)
    const observation = await observeResourceInventory({ registry: next, baseline })
    if (observation.status === 'owner-conflict') {
        const failedResources = observation.unknownResources.map((resource) => ({
            ...resource,
            reason: 'unowned-post-baseline-resource'
        }))
        const receipt = cleanupReceipt({
            registry: next,
            baseline,
            ownedResourceDigest,
            cleanupActions: [],
            retainedResources: retainedGroupResources,
            quarantinedResources: [],
            failedResources,
            status: 'cleanup-failed',
            postInventory: activeOwnedResources(next, isCleanupTarget)
        })
        return { registry: next, receipt, observation }
    }
    const dirtyResources = next.resources.filter((resource) => resource.resourceType === 'worktree'
        && isCleanupTarget(resource)
        && isText(resource.identityEvidence?.path)
        && fs.existsSync(resource.identityEvidence.path)
        && worktreeIsDirty(resource.identityEvidence.path))
    if (dirtyResources.length > 0) {
        for (const resource of dirtyResources) markResource(next, resource.resourceId, 'quarantined-dirty')
        next.phase = 'quarantined-dirty'
        next.deliveryAuthorized = false
        next.slotHeld = true
        const quarantinedResources = dirtyResources.map((resource) => ({
            resourceId: resource.resourceId,
            resourceType: resource.resourceType,
            reason: 'dirty-worktree'
        }))
        const receipt = cleanupReceipt({
            registry: next,
            baseline,
            ownedResourceDigest,
            cleanupActions: [],
            retainedResources: retainedGroupResources,
            quarantinedResources,
            failedResources: [],
            status: 'quarantined',
            postInventory: activeOwnedResources(next, isCleanupTarget)
        })
        return { registry: next, receipt, observation }
    }

    const cleanupActions = []
    const lockReleaseObservations = []
    const failedResources = []
    const orderedTypes = [
        'worktree', 'branch', 'process-group', 'port', 'lock', 'lease', 'temporary-directory'
    ]
    for (const resourceType of orderedTypes) {
        for (const resource of next.resources.filter((item) => item.resourceType === resourceType
            && isCleanupTarget(item))) {
            const failuresBefore = failedResources.length
            if (resourceType === 'worktree') cleanWorktree(resource, baseline, next, cleanupActions, failedResources)
            else if (resourceType === 'branch') cleanBranch(resource, baseline, cleanupActions, failedResources)
            else if (resourceType === 'process-group') {
                await cleanProcessGroup(resource, cleanupActions, failedResources)
            } else if (resourceType === 'port') await cleanPort(resource, cleanupActions, failedResources)
            else if (resourceType === 'lock') {
                await cleanLock(resource, cleanupActions, failedResources, lockReleaseObservations)
            }
            else if (resourceType === 'lease') cleanLease(resource, cleanupActions, failedResources)
            else if (resourceType === 'temporary-directory') {
                cleanTemporaryDirectory(resource, baseline, cleanupActions, failedResources)
            }
            if (failuresBefore === failedResources.length) markResource(next, resource.resourceId, 'removed-clean')
            else markResource(next, resource.resourceId, 'cleanup-failed')
        }
    }
    for (const resource of next.resources.filter((item) => ['container', 'network', 'volume'].includes(item.resourceType)
        && isCleanupTarget(item))) {
        failResource(resource, 'docker-cleanup-not-available', failedResources)
        markResource(next, resource.resourceId, 'cleanup-failed')
    }
    const finalFilesystemObservations = lockReleaseObservations.map((lockObservation) => {
        const finalFilesystemObservation = observeFinalLockFilesystem(lockObservation, next, isCleanupTarget)
        lockObservation.finalFilesystemObservation = finalFilesystemObservation
        return finalFilesystemObservation
    })
    const postInventory = activeOwnedResources(next, isCleanupTarget)
    const status = failedResources.length === 0 && postInventory.length === 0
        ? 'resources-clean'
        : 'cleanup-failed'
    const receipt = cleanupReceipt({
        registry: next,
        baseline,
        ownedResourceDigest,
        cleanupActions,
        lockReleaseObservations,
        finalFilesystemObservations,
        retainedResources: retainedGroupResources,
        quarantinedResources: [],
        failedResources,
        status,
        postInventory
    })
    if (status === 'resources-clean') {
        verifyCleanupReceipt(receipt)
        if (next.writeLease) next.writeLease.state = 'released'
        next.slotHeld = false
        next.phase = 'cleaned'
    } else {
        next.deliveryAuthorized = false
    }
    return { registry: next, receipt, observation }
}

function applySelfTestFailure(next, event) {
    if ((event.newAttemptId && event.newAttemptId !== next.stageAttemptId)
        || (event.newWorktreeId && event.newWorktreeId !== next.issueWorktreeId)) {
        fail('internal-red-attempt-rebuild-forbidden')
    }
    if (!event.failureRef) fail('self-test-failure-evidence')
    next.selfTestCycles ??= []
    next.selfTestCycles.push({
        cycle: next.selfTestCycles.length + 1,
        outcome: 'failed',
        failureRef: event.failureRef,
        attemptId: next.stageAttemptId,
        worktreeId: next.issueWorktreeId
    })
    next.firstFailureRefs ??= []
    if (next.firstFailureRefs.length === 0) {
        next.firstFailureRefs.push(event.failureRef)
    }
}

function applyCandidateGreen(next, event) {
    if (!SHA.test(event.candidateSha ?? '')) fail('candidate-identity-missing')
    if (next.writeLease?.state !== 'active') fail('candidate-writer-missing')
    next.writeLease.state = 'revoked'
    next.readLease = {
        role: 'independent-verifier',
        mode: 'read-only',
        candidateSha: event.candidateSha
    }
    next.phase = 'independent-verifying'
    next.candidateSha = event.candidateSha
}

function applyVerificationRejection(next, event) {
    if (next.phase !== 'independent-verifying'
        || next.readLease?.candidateSha !== event.candidateSha
        || !event.nextWriteLeaseId) {
        fail('verification-rejection-identity')
    }
    next.readLease = null
    next.writeLease = {
        id: event.nextWriteLeaseId,
        ownerAttemptId: next.stageAttemptId,
        mode: 'write',
        state: 'active'
    }
    next.phase = 'implementing-self-testing'
}

function applyServiceReplacement(next, event) {
    const resource = next.resources.find(
        ({ resourceId }) => resourceId === event.resourceId
    )
    if (!resource || resource.ownerRunId !== next.runId
        || resource.ownerAttemptId !== next.stageAttemptId) {
        fail('retained-service-owner-missing')
    }
    resource.descendants = unique(event.descendants)
    resource.ports = unique(event.ports)
    resource.state = 'active'
}

function applyMemberCleanup(next, event) {
    for (const resource of next.resources) {
        if (resource.ownerClass === 'group-owned') {
            resource.state = 'retained'
        } else if (resource.memberId === event.memberId) {
            resource.state = 'removed-clean'
        }
    }
}

function applyGroupCleanup(next, event) {
    if (!Array.isArray(event.postInventory)) {
        fail('cleanup-post-inventory-required')
    }
    const remaining = new Set(event.postInventory.map(
        (entry) => typeof entry === 'string' ? entry : entry.resourceId
    ))
    for (const resource of next.resources) {
        if (resource.ownerClass === 'externally-owned') continue
        resource.state = remaining.has(resource.resourceId)
            ? 'cleanup-failed'
            : 'removed-clean'
    }
}

function requireLifecycleBinding(next, event) {
    if (!HASH.test(event.ledgerEventDigest ?? '')) {
        fail('resource-ledger-binding-required')
    }
    if (!HASH.test(event.dispatchReceiptDigest ?? '')) {
        fail('resource-dispatch-binding-required')
    }
    if (event.epochId !== next.epochId) fail('resource-epoch-mismatch')
}

function applyVerifiedCleanup(next, event) {
    if (!event.cleanupReceipt) fail('cleanup-receipt-required')
    requireLifecycleBinding(next, event)
    verifyCleanupReceipt(event.cleanupReceipt)
    if (event.cleanupReceipt.runId !== next.runId
        || event.cleanupReceipt.attemptId !== next.stageAttemptId
        || event.cleanupReceipt.epochId !== next.epochId) {
        fail('cleanup-receipt-binding-required')
    }
    next.cleanupReceiptDigest = event.cleanupReceipt.receiptDigest
    next.slotHeld = false
    if (next.writeLease) next.writeLease.state = 'released'
    next.phase = 'cleaned'
}

export function applyResourceEvent(registry, event) {
    const next = createResourceRegistry(registry)
    if (!event?.type) fail('resource-event-schema')
    if (event.type === 'self-test.failed') {
        applySelfTestFailure(next, event)
        requireLifecycleBinding(next, event)
    } else if (event.type === 'cleanup.started') {
        if (next.phase === 'implementing-self-testing') {
            fail('internal-red-cleanup-forbidden')
        }
        next.phase = 'cleaning'
    } else if (event.type === 'candidate-green') {
        requireLifecycleBinding(next, event)
        applyCandidateGreen(next, event)
    } else if (event.type === 'independent-verification.rejected') {
        applyVerificationRejection(next, event)
    } else if (event.type === 'self-test.service-replaced') {
        applyServiceReplacement(next, event)
    } else if (event.type === 'stage-cleanup.completed') {
        if (!HASH.test(event.receiptDigest ?? '')) {
            fail('cleanup-receipt-digest')
        }
        next.cleanupReceiptDigest = event.receiptDigest
    } else if (event.type === 'attempt.terminal-requested') {
        if (!event.cleanupReceipt) fail('cleanup-receipt-required')
        applyVerifiedCleanup(next, event)
        next.phase = event.terminalStatus ?? 'terminal'
    } else if (event.type === 'slot.release-requested') {
        if (!event.cleanupReceipt) fail('cleanup-receipt-required')
        applyVerifiedCleanup(next, event)
    } else if (event.type === 'resource.observed-unowned') {
        fail('resource-unowned-observation')
    } else if (event.type === 'process.leader-exited') {
        if ((event.descendants ?? []).length > 0 || (event.ports ?? []).length > 0) {
            fail('process-descendant-still-live')
        }
        const resource = next.resources.find((item) => item.resourceId === event.resourceId)
        if (!resource) fail('resource-registry-identity')
        resource.state = 'leader-exited-unverified'
    } else if (event.type === 'docker.container-stopped') {
        fail('docker-resource-still-present')
    } else if (event.type === 'retry.started') {
        if (!isText(event.stageAttemptId) || !isText(event.issueWorktreeId)
            || event.previousOwnerAttemptId !== next.stageAttemptId
            || event.stageAttemptId === next.stageAttemptId
            || event.issueWorktreeId === next.issueWorktreeId) {
            fail('retry-owner-reuse-forbidden')
        }
        next.retryRequested = {
            stageAttemptId: event.stageAttemptId,
            issueWorktreeId: event.issueWorktreeId,
            previousOwnerAttemptId: event.previousOwnerAttemptId
        }
    } else if (event.type === 'worktree.cleanup-requested') {
        if (event.dirty) {
            next.phase = 'quarantined-dirty'
            next.slotHeld = true
            next.deliveryAuthorized = false
        }
    } else if (event.type === 'member-cleanup.completed') {
        if (event.groupSessionDigest !== next.groupSessionDigest) {
            fail('group-session-binding-mismatch')
        }
        applyMemberCleanup(next, event)
    } else if (event.type === 'group-cleanup.completed') {
        if (event.groupSessionDigest !== next.groupSessionDigest) {
            fail('group-session-binding-mismatch')
        }
        applyGroupCleanup(next, event)
    } else {
        fail('resource-event-unsupported')
    }
    return next
}

function verifyLockReleaseObservation(observation) {
    if (observation?.resourceType !== 'lock'
        || !isText(observation.resourceId)
        || !isText(observation.path)
        || !isText(observation.parentPath)
        || !Number.isInteger(observation.dev)
        || !Number.isInteger(observation.inode)
        || observation.dev < 0
        || observation.inode < 0
        || observation.lockPathExistsBeforeRelease !== true
        || observation.parentPathExistsBeforeRelease !== true
        || observation.ownerAbsent !== true
        || !isText(observation.ownerExitStatus)
        || observation.exitStatus !== 0
        || observation.probeReleased !== true) {
        fail('cleanup-lock-release-observation-required')
    }
    const final = observation.finalFilesystemObservation
    if (!final
        || final.lockPath !== observation.path
        || final.parentPath !== observation.parentPath
        || final.lockPathExists !== false
        || typeof final.parentExpectedAbsent !== 'boolean'
        || typeof final.parentPathExists !== 'boolean'
        || !isText(final.observedAt)
        || (final.parentExpectedAbsent && final.parentPathExists !== false)) {
        fail('cleanup-lock-final-filesystem-observation-required')
    }
}

export function verifyCleanupReceipt(receipt) {
    if (receipt?.actorRole !== 'machine-resource-verifier') {
        fail('machine-resource-verifier-required')
    }
    if (receipt.schema !== 'issue-orchestration.resource-cleanup-receipt.v1'
        || receipt.status !== 'resources-clean') {
        fail('cleanup-receipt-schema')
    }
    if (!Array.isArray(receipt.postInventory)) {
        fail('cleanup-post-inventory-required')
    }
    if (receipt.postInventory.length > 0) fail('cleanup-post-inventory-not-empty')
    const requiredBindings = [
        'runId', 'attemptId', 'epochId', 'baselineDigest', 'ownedResourceDigest',
        'cleanupActions', 'lockReleaseObservations', 'finalFilesystemObservations',
        'retainedResources', 'quarantinedResources', 'failedResources',
        'postCleanupInventoryDigest', 'verifiedAt', 'receiptDigest'
    ]
    if (requiredBindings.some((field) => receipt[field] === undefined)
        || !isText(receipt.runId) || !isText(receipt.attemptId)
        || !EPOCH.test(receipt.epochId ?? '')
        || !HASH.test(receipt.baselineDigest ?? '')
        || !HASH.test(receipt.ownedResourceDigest ?? '')
        || !HASH.test(receipt.postCleanupInventoryDigest ?? '')
        || !Array.isArray(receipt.cleanupActions)
        || !Array.isArray(receipt.lockReleaseObservations)
        || !Array.isArray(receipt.finalFilesystemObservations)
        || !Array.isArray(receipt.retainedResources)
        || !Array.isArray(receipt.quarantinedResources)
        || !Array.isArray(receipt.failedResources)) {
        fail('cleanup-receipt-binding-required')
    }
    const lockActions = receipt.cleanupActions.filter(({ resourceType }) => resourceType === 'lock')
    if (lockActions.some(({ action }) => action !== 'release-and-reacquire-observation')
        || lockActions.length !== receipt.lockReleaseObservations.length
        || receipt.finalFilesystemObservations.length !== receipt.lockReleaseObservations.length) {
        fail('cleanup-lock-release-observation-required')
    }
    for (let index = 0; index < receipt.lockReleaseObservations.length; index += 1) {
        const lockObservation = receipt.lockReleaseObservations[index]
        verifyLockReleaseObservation(lockObservation)
        if (!lockActions.some(({ resourceId }) => resourceId === lockObservation.resourceId)
            || digest(receipt.finalFilesystemObservations[index])
                !== digest(lockObservation.finalFilesystemObservation)) {
            fail('cleanup-lock-final-filesystem-observation-required')
        }
    }
    if (receipt.postCleanupInventoryDigest !== digest(receipt.postInventory)) {
        fail('cleanup-post-inventory-digest')
    }
    if (receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest')) {
        fail('cleanup-receipt-digest')
    }
    return true
}

export function recoverResourceRegistry({ baseline = [], observed = [] }) {
    const baselineById = new Map(baseline.map(
        (resource) => [resource.resourceId, resource]
    ))
    const failedResources = []
    const retainedResources = []
    for (const resource of observed) {
        if (resource.ownerClass === 'externally-owned') {
            retainedResources.push(clone(resource))
        } else if (resource.state === 'quarantined-dirty') {
            failedResources.push({ ...clone(resource), reason: 'dirty-candidate-retained' })
        } else if (!baselineById.has(resource.resourceId)
            || resource.ownerClass === 'unknown-owner') {
            failedResources.push({ ...clone(resource), reason: 'unknown-owner' })
        }
    }
    for (const resource of baseline) {
        if (resource.ownerClass === 'externally-owned'
            && !retainedResources.some(
                ({ resourceId }) => resourceId === resource.resourceId
            )) {
            failedResources.push({
                ...clone(resource),
                reason: 'external-resource-missing'
            })
        }
    }
    return {
        schema: 'issue-orchestration.resource-recovery.v1',
        status: failedResources.length > 0 ? 'cleanup-failed' : 'resources-clean',
        failedResources,
        retainedResources
    }
}
