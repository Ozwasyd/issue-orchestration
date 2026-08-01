import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

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

function validateRegistry(registry) {
    if (registry?.schema !== 'issue-orchestration.resource-registry.v1') {
        fail('resource-registry-schema')
    }
    if (!Array.isArray(registry.resources)) fail('resource-registry-schema')
    const ids = registry.resources.map(({ resourceId }) => resourceId)
    if (ids.some((id) => typeof id !== 'string' || id.length === 0)
        || new Set(ids).size !== ids.length) {
        fail('resource-registry-identity')
    }
}

export function createResourceRegistry(input) {
    const registry = clone(input)
    validateRegistry(registry)
    registry.selfTestCycles ??= []
    registry.firstFailureRefs ??= []
    return registry
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

export function applyResourceEvent(registry, event) {
    const next = createResourceRegistry(registry)
    if (!event?.type) fail('resource-event-schema')
    if (event.type === 'self-test.failed') {
        applySelfTestFailure(next, event)
    } else if (event.type === 'cleanup.started') {
        if (next.phase === 'implementing-self-testing') {
            fail('internal-red-cleanup-forbidden')
        }
        next.phase = 'cleaning'
    } else if (event.type === 'candidate-green') {
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
    } else if (event.type === 'worktree.cleanup-requested') {
        if (event.dirty) {
            next.phase = 'quarantined-dirty'
            next.slotHeld = true
            next.deliveryAuthorized = false
        }
    } else if (event.type === 'member-cleanup.completed') {
        applyMemberCleanup(next, event)
    } else if (event.type === 'group-cleanup.completed') {
        applyGroupCleanup(next, event)
    } else {
        fail('resource-event-unsupported')
    }
    return next
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
    if (receipt.receiptDigest) {
        const unsigned = { ...receipt }
        delete unsigned.receiptDigest
        if (receipt.receiptDigest !== digest(unsigned)) {
            fail('cleanup-receipt-digest')
        }
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
