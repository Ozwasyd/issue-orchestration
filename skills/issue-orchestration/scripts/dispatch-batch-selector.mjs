import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import { STAGE_ROUTE_DEFINITIONS } from './stage-profile-policy.mjs'

export class DispatchBatchError extends Error {
    constructor(code, message, details = {}) {
        super(message)
        this.name = 'DispatchBatchError'
        this.code = code
        this.details = details
    }
}

const SELECTABLE_ROLES = new Set([
    ...Object.keys(STAGE_ROUTE_DEFINITIONS)
        .map((key) => key.split(':', 1)[0])
        .filter((role) =>
            role !== 'dag-creator-updater')
])
const EVIDENCE_TYPES = new Set([
    'investigated-owner-write-surface', 'explicit-runtime-requirement',
    'stage-write-lease'
])
const DEFER_CODES = new Set([
    'ranked-beyond-slot-limit', 'write-conflict', 'worktree-write-conflict',
    'resource-lease-held', 'active-stage-task', 'candidate-not-frozen',
    'stage-prerequisite-unsatisfied', 'stage-role-not-selectable',
    'group-proposal-ineligible'
])
const SHA256 = /^[a-f0-9]{64}$/u
const SHA1 = /^[a-f0-9]{40}$/u
const PRIORITIES = new Set(['P0', 'P1', 'P2'])
const STAGE_ROLES = new Map([
    ['test-contract', new Set(['test-owner'])],
    ['code-implementation', new Set(['code-implementer'])],
    ['ui-ux-implementation', new Set(['ui-ux-implementer'])],
    ['ui-system-adjudication', new Set(['ui-system-adjudicator'])],
    ['behavior-verification', new Set(['test-owner'])],
    ['ux-acceptance', new Set(['ux-acceptance-verifier'])],
    ['documentation', new Set(['documentation-writer'])],
    ['delivery', new Set(['root-scheduler'])]
])
const POLICY = {
    schema: 'issue-orchestration.dispatch-ranking-policy.v1',
    selectorVersion: 'critical-unlock-conflict.v1',
    priorityOrder: ['P0', 'P1', 'P2'],
    withinPriorityWeights: {
        downstreamBlockedCount: 1000,
        criticalPathLength: 100,
        starvationAge: 10,
        acceptanceGroupCompletionValue: 5,
        validationPlacement: 1
    },
    priorityIsStrict: true,
    stableTieBreak: 'taskId:ascending',
    longTaskPolicy: 'occupies-only-own-slot-and-explicit-resource-keys'
}

function fail(code, message, details = {}) {
    throw new DispatchBatchError(code, message, details)
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical).sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function bodyWithout(value, field) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))
}

function proposalDigest(proposal) {
    const normalized = canonical(proposal)
    normalized.memberOrder = proposal.memberOrder.map(canonical)
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function requireText(value, code, label) {
    if (typeof value !== 'string' || !value) fail(code, `${label} is required.`)
}

function validateLease(lease) {
    const fields = [
        'leaseId', 'kind', 'ownerId', 'attemptId', 'stageTaskId',
        'acquiredAt', 'expiresAt', 'recoveryRule', 'state'
    ]
    if (lease?.schema !== 'issue-orchestration.dispatch-lease.v1'
        || fields.some((field) => typeof lease[field] !== 'string' || !lease[field])
        || !Array.isArray(lease.keys) || lease.keys.length === 0) {
        fail('lease-schema', 'Dispatch lease is incomplete.')
    }
    if (lease.leaseDigest !== digest(bodyWithout(lease, 'leaseDigest'))) {
        fail('lease-digest-mismatch', 'Dispatch lease digest does not match its body.')
    }
    return lease
}

function validatePolicy(policy, selectorVersion) {
    if (selectorVersion !== POLICY.selectorVersion
        || JSON.stringify(canonical(policy)) !== JSON.stringify(canonical(POLICY))) {
        fail('ranking-policy-schema', 'Dispatch ranking policy is invalid.')
    }
}

function validateTask(task) {
    requireText(task?.taskId, 'stage-task-schema', 'stage task id')
    requireText(task.issueId, 'stage-task-schema', 'stage issue id')
    if (task.stageKind === 'ui-ux-implementation' && task.stageRole !== 'ui-ux-implementer') {
        fail('stage-role-write-scope', 'UI implementation requires the UI/UX implementation role.')
    }
    if (!SELECTABLE_ROLES.has(task.stageRole) || !STAGE_ROLES.get(task.stageKind)?.has(task.stageRole)) {
        fail('stage-role-not-selectable', `Stage role is not selectable: ${task.stageRole}.`)
    }
    const match = /^(.+)#([1-9]\d*)$/u.exec(task.issueId)
    if (!match || task.repository !== match[1]
        || task.issueNumber !== Number(match[2])
        || task.taskId !== `${task.issueId}@${task.stageKind}`
        || !PRIORITIES.has(task.priorityClass)
        || typeof task.issueWorktreeId !== 'string' || !task.issueWorktreeId
        || !SHA256.test(task.writeScopeDigest ?? '')
        || !SHA256.test(task.epochId?.length ? digest(task.epochId) : '')
        || !Array.isArray(task.requiredReceiptDigests)
        || !Array.isArray(task.requiredSkillDigests)
        || !Array.isArray(task.writePaths)
        || !Array.isArray(task.conflictKeys)
        || !Array.isArray(task.exclusiveResourceKeys)
        || (task.candidateSha !== null && typeof task.candidateSha !== 'string')
        || !['number'].every((kind) => [
            task.criticalPathLength, task.downstreamBlockedCount,
            task.starvationAge, task.acceptanceGroupCompletionValue
        ].every((value) => typeof value === kind && Number.isFinite(value) && value >= 0))) {
        fail('stage-task-schema', `${task.taskId} has invalid stage or candidate identity.`)
    }
    if (task.readOnly && !SHA1.test(task.candidateSha ?? '')) {
        fail('stage-task-schema', `${task.taskId} requires a frozen candidate SHA.`)
    }
    if (!task.readOnly && task.candidateSha !== null) {
        fail('stage-task-schema', `${task.taskId} has an unexpected candidate SHA.`)
    }
    if (task.stagePrerequisitesSatisfied !== true || task.dependencyStatus !== 'satisfied') {
        fail('stage-prerequisite-unsatisfied', `${task.taskId} has unmet prerequisites.`)
    }
    if (task.active !== true) fail('active-stage-task', `${task.taskId} is not active.`)
    if (!task.candidateFrozen) fail('candidate-not-frozen', `${task.taskId} candidate is not frozen.`)
    const writePaths = Array.isArray(task.writePaths) ? task.writePaths : []
    const conflictKeys = Array.isArray(task.conflictKeys) ? task.conflictKeys : []
    if (task.readOnly && (writePaths.length > 0 || conflictKeys.length > 0)) {
        fail('read-only-write-lease', `${task.taskId} is read-only but requests writes.`)
    }
    for (const key of conflictKeys) {
        const evidence = task.conflictKeyEvidence?.[key]
        if (!evidence || !EVIDENCE_TYPES.has(evidence.sourceType)
            || !SHA256.test(evidence.evidenceDigest ?? '')) {
            fail('conflict-key-evidence', `Conflict key ${key} lacks owner-surface evidence.`)
        }
    }
    for (const key of task.exclusiveResourceKeys ?? []) {
        const evidence = task.resourceKeyEvidence?.[key]
        if (!evidence || evidence.sourceType !== 'explicit-runtime-requirement'
            || !SHA256.test(evidence.evidenceDigest ?? '')) {
            fail('resource-key-evidence', `Resource key ${key} lacks explicit evidence.`)
        }
    }
}

export function validateAcceptanceGroupProposal({ proposal, stageTasks }) {
    if (proposal?.schema !== 'issue-orchestration.acceptance-group-proposal.v1') {
        fail('group-proposal-ineligible', 'Acceptance group proposal is invalid.')
    }
    if (!proposal.activeMemberIssueId) {
        fail('group-proposal-no-active-member', 'Acceptance group has no active member.')
    }
    const members = new Set(proposal.memberIssueIds ?? [])
    const taskMembers = new Set(stageTasks.map(({ issueId }) => issueId))
    const memberOrder = proposal.memberOrder ?? []
    const epochIds = new Set(stageTasks
        .filter(({ issueId }) => members.has(issueId))
        .map(({ epochId }) => epochId))
    const evidenceObjects = [
        proposal.estimatedColdStartSavings,
        proposal.lostParallelismEstimate,
        proposal.atomicCommitFeasibility,
        proposal.sameEpochEvidence
    ]
    const hasSharedSurface = (proposal.sharedPaths?.length ?? 0) > 0
        || (proposal.sharedConflictKeys?.length ?? 0) > 0
        || (proposal.sharedBuildOrRuntimeResources?.length ?? 0) > 0
    if (!hasSharedSurface || proposal.hiddenDependency || members.size < 2
        || [...members].some((member) => !taskMembers.has(member))
        || !members.has(proposal.activeMemberIssueId)
        || proposal.atomicCommitFeasibility?.feasible !== true
        || proposal.atomicCommitFeasibility?.independentMemberCommits !== true
        || epochIds.size !== 1
        || proposal.sameEpochEvidence?.epochId !== [...epochIds][0]
        || typeof proposal.fallbackReason !== 'string' || !proposal.fallbackReason) {
        fail('group-proposal-ineligible', 'Acceptance group is not independently eligible.')
    }
    const coldStart = proposal.estimatedColdStartSavings
    const lostParallelism = proposal.lostParallelismEstimate
    if (coldStart?.unit !== 'seconds'
        || !Number.isFinite(coldStart?.value) || coldStart.value < 0
        || lostParallelism?.unit !== 'slots'
        || !Number.isFinite(lostParallelism?.value)
        || lostParallelism.value < 0 || lostParallelism.value > 1
        || evidenceObjects.some((evidence) => !SHA256.test(evidence?.evidenceDigest ?? ''))) {
        fail('group-proposal-evidence', 'Acceptance group qualification evidence is invalid.')
    }
    const canonicalMembers = [...members].sort()
    if (proposal.memberIssueIds?.length !== members.size
        || memberOrder.length !== members.size || new Set(memberOrder).size !== members.size
        || memberOrder.some((member) => !members.has(member))
        || JSON.stringify(memberOrder) !== JSON.stringify(canonicalMembers)) {
        fail('group-member-order', 'Acceptance group member order is not canonical.')
    }
    if (proposal.proposalDigest !== proposalDigest(bodyWithout(proposal, 'proposalDigest'))) {
        fail('group-member-order', 'Acceptance group ordered digest does not match.')
    }
    return { valid: true, proposalDigest: proposal.proposalDigest }
}

export function validateDispatchInput({
    frontier, rankingPolicy, activeLeases = [], groupProposals = []
}) {
    if (frontier?.schema !== 'issue-orchestration.dispatch-frontier.v1'
        || !Array.isArray(frontier.stageTasks)
        || frontier.frontierDigest !== digest(bodyWithout(frontier, 'frontierDigest'))) {
        fail('dispatch-frontier-digest', 'Dispatch frontier is invalid.')
    }
    validatePolicy(rankingPolicy, frontier.selectorVersion)
    const ids = new Set()
    for (const task of frontier.stageTasks) {
        validateTask(task)
        if (ids.has(task.taskId)) fail('stage-task-duplicate', `Duplicate ${task.taskId}.`)
        ids.add(task.taskId)
    }
    for (const dependency of frontier.semanticDependencies ?? []) {
        if (dependency.serializationOnly === true) {
            fail('semantic-conflict-conflation', 'Write serialization is not a semantic dependency.')
        }
    }
    const leaseIds = new Set()
    const activeOwners = new Set()
    const activeKeys = new Set()
    for (const lease of activeLeases) {
        validateLease(lease)
        if (leaseIds.has(lease.leaseId)) fail('lease-schema', 'Dispatch lease id is duplicated.')
        leaseIds.add(lease.leaseId)
        if (lease.state !== 'active') continue
        const ownership = lease.ownerId
        if (activeOwners.has(ownership)) fail('lease-schema', 'Active lease ownership is duplicated.')
        activeOwners.add(ownership)
        for (const key of lease.keys) {
            if (activeKeys.has(key)) fail('lease-conflict-held', `Active lease key is duplicated: ${key}.`)
            activeKeys.add(key)
        }
    }
    for (const proposal of groupProposals) {
        validateAcceptanceGroupProposal({ proposal, stageTasks: frontier.stageTasks })
    }
    return { valid: true, frontierDigest: frontier.frontierDigest }
}

const READY_STAGE = new Map([
    ['test-contract', 'test-contract-ready'],
    ['code-implementation', 'implementation-ready'],
    ['ui-ux-implementation', 'implementation-ready'],
    ['behavior-verification', 'behavior-verification-ready'],
    ['ux-acceptance', 'ux-acceptance-ready'],
    ['documentation', 'documentation-ready'],
    ['delivery', 'delivery-ready'],
    ['cleanup', 'cleanup-ready']
])

export function validateDispatchFrontierBinding({
    frontier, verifiedProjection, dag
}) {
    if (verifiedProjection?.schema !== 'issue-orchestration.frontier-projection.v1'
        || !SHA256.test(verifiedProjection.frontierDigest ?? '')
        || !Array.isArray(verifiedProjection.readyFrontier)) {
        fail('dispatch-frontier-binding', 'Verified ready frontier is missing.')
    }
    const actual = frontier.stageTasks.map((task) => ({
        issueId: task.issueId,
        stage: READY_STAGE.get(task.stageKind)
    })).sort((left, right) =>
        `${left.issueId}@${left.stage}`.localeCompare(`${right.issueId}@${right.stage}`))
    const expected = [...verifiedProjection.readyFrontier].sort((left, right) =>
        `${left.issueId}@${left.stage}`.localeCompare(`${right.issueId}@${right.stage}`))
    if (actual.some(({ stage }) => !stage)
        || JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail('dispatch-frontier-binding', 'Dispatch tasks do not exactly cover the verified ready frontier.')
    }
    const nodes = new Map((dag?.nodes ?? []).map((node) => [node.id, node]))
    const boundFields = [
        'priorityClass', 'criticalPathLength', 'downstreamBlockedCount',
        'starvationAge', 'acceptanceGroup', 'acceptanceGroupCompletionValue',
        'conflictKeys', 'conflictKeyEvidence', 'exclusiveResourceKeys',
        'resourceKeyEvidence', 'validationClass', 'estimatedLongTask',
        'stageRole', 'issueWorktreeId', 'writeScopeDigest',
        'requiredReceiptDigests', 'requiredSkillDigests', 'readOnly',
        'candidateSha', 'candidateFrozen', 'epochId'
    ]
    for (const task of frontier.stageTasks) {
        const node = nodes.get(task.issueId)
        if (!node) fail('dispatch-frontier-binding', `Dispatch task ${task.taskId} has no DAG node.`)
        for (const field of boundFields) {
            if (node[field] === undefined
                || JSON.stringify(canonical(task[field]))
                    !== JSON.stringify(canonical(node[field]))) {
                fail('dispatch-frontier-binding', `${task.taskId}.${field} differs from the verified DAG node.`)
            }
        }
    }
    return {
        valid: true,
        verifiedFrontierDigest: verifiedProjection.frontierDigest
    }
}

function rankComponents(task) {
    return {
        priorityClass: task.priorityClass,
        starvationAge: task.starvationAge,
        downstreamBlockedCount: task.downstreamBlockedCount,
        criticalPathLength: task.criticalPathLength,
        acceptanceGroupCompletionValue: task.acceptanceGroupCompletionValue,
        validationClass: task.validationClass,
        estimatedLongTask: task.estimatedLongTask,
        stableNodeIdentity: task.taskId
    }
}

function compareTasks(policy, left, right) {
    const priority = policy.priorityOrder.indexOf(left.priorityClass)
        - policy.priorityOrder.indexOf(right.priorityClass)
    if (priority) return priority
    // A sufficiently old ready task must make progress within its priority.
    const starvation = (right.starvationAge ?? 0) - (left.starvationAge ?? 0)
    if (Math.max(left.starvationAge ?? 0, right.starvationAge ?? 0) >= 1000 && starvation) {
        return starvation
    }
    for (const field of [
        'downstreamBlockedCount', 'criticalPathLength',
        'acceptanceGroupCompletionValue', 'starvationAge'
    ]) {
        const difference = (right[field] ?? 0) - (left[field] ?? 0)
        if (difference) return difference
    }
    return left.taskId.localeCompare(right.taskId)
}

function overlap(left = [], right = []) {
    const rightSet = new Set(right)
    return left.filter((entry) => rightSet.has(entry))
}

function conflictWithSelected(task, selected) {
    for (const other of selected) {
        const shared = overlap(task.conflictKeys, other.conflictKeys)
        if (shared.length) return { code: 'write-conflict', blockers: [other.taskId], keys: shared }
        if (!task.readOnly && !other.readOnly
            && task.issueWorktreeId === other.issueWorktreeId) {
            return { code: 'worktree-write-conflict', blockers: [other.taskId], keys: [task.issueWorktreeId] }
        }
        const resources = overlap(task.exclusiveResourceKeys, other.exclusiveResourceKeys)
        if (resources.length) return { code: 'resource-lease-held', blockers: [other.taskId], keys: resources }
    }
    return null
}

function leaseConflict(task, leases) {
    for (const lease of leases) {
        if (lease.state !== 'active') continue
        let keys = overlap(
            [...(task.conflictKeys ?? []), ...(task.exclusiveResourceKeys ?? [])],
            lease.keys
        )
        if (!task.readOnly && keys.length === 0) {
            const [, repositoryName = task.repository, issueNumber = task.issueNumber]
                = /^.+\/([^/]+)#([1-9]\d*)$/u.exec(task.issueId) ?? []
            const derivedWorktreeKey =
                `worktree:${repositoryName}:issue-${issueNumber}:write`
            const normalizedWorktree = task.issueWorktreeId
                .toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
            keys = lease.keys.filter((key) =>
                key === derivedWorktreeKey
                || (key.startsWith('worktree:')
                    && key.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
                        .includes(normalizedWorktree)))
        }
        if (keys.length) return { code: 'resource-lease-held', blockers: [lease.stageTaskId], keys }
    }
    return null
}

function createBatch(input) {
    const {
        frontier, rankingPolicy, activeLeases = [], availableSlots, computedAt
    } = input
    validateDispatchInput(input)
    if (!Number.isInteger(availableSlots) || availableSlots < 0) {
        fail('available-slots-schema', 'Available slots must be a non-negative integer.')
    }
    const ranked = [...frontier.stageTasks].sort((a, b) => compareTasks(rankingPolicy, a, b))
    const selectedTasks = []
    const deferredTasks = []
    const selectionReasons = {}
    const deferReasons = {}
    for (const task of ranked) {
        const blocked = leaseConflict(task, activeLeases)
            ?? conflictWithSelected(task, selectedTasks)
        if (!blocked && selectedTasks.length < availableSlots) {
            selectedTasks.push(task)
            selectionReasons[task.taskId] = {
                code: 'ranked-safe-selected',
                rankComponents: rankComponents(task)
            }
        } else {
            deferredTasks.push(task)
            deferReasons[task.taskId] = blocked ?? {
                code: 'ranked-beyond-slot-limit',
                blockers: selectedTasks.map(({ taskId }) => taskId),
                keys: []
            }
            deferReasons[task.taskId] = {
                code: deferReasons[task.taskId].code,
                selectionBlockedBy: deferReasons[task.taskId].blockers,
                conflictKeys: deferReasons[task.taskId].keys
            }
        }
    }
    const body = {
        schema: 'issue-orchestration.dispatch-batch.v1',
        selectorVersion: frontier.selectorVersion,
        frontierDigest: frontier.frontierDigest,
        selected: selectedTasks.map(({ taskId }) => ({ taskId })),
        deferred: deferredTasks.map(({ taskId }) => ({ taskId })),
        selectionReasons,
        deferReasons
    }
    return { ...body, batchDigest: digest(body), computedAt }
}

export function selectDispatchBatch(input) {
    return createBatch(input)
}

export function validateDispatchBatch(input) {
    const { recordedBatch, availableSlots } = input
    if ((recordedBatch?.selected?.length ?? 0) > availableSlots) {
        fail('batch-slots-exceeded', 'Recorded batch exceeds available slots.')
    }
    for (const reason of Object.values(recordedBatch?.deferReasons ?? {})) {
        if (!reason || typeof reason !== 'object' || !DEFER_CODES.has(reason.code)
            || !Array.isArray(reason.selectionBlockedBy)) {
            fail('batch-defer-reason-schema', 'Recorded defer reason is not structured.')
        }
    }
    const expected = createBatch({ ...input, computedAt: recordedBatch.computedAt })
    const selected = (recordedBatch.selected ?? []).map(({ taskId }) => taskId)
    const expectedSelected = expected.selected.map(({ taskId }) => taskId)
    const taskById = new Map(input.frontier.stageTasks.map((task) => [task.taskId, task]))
    for (let index = 0; index < selected.length; index += 1) {
        const task = taskById.get(selected[index])
        if (!task) continue
        const prior = selected.slice(0, index).map((id) => taskById.get(id)).filter(Boolean)
        const conflict = conflictWithSelected(task, prior)
        if (conflict?.code === 'write-conflict') fail('batch-write-conflict', 'Recorded batch co-selects conflicting writers.')
        if (conflict?.code === 'worktree-write-conflict') fail('batch-worktree-write-conflict', 'Recorded batch co-selects worktree writers.')
        if (leaseConflict(task, input.activeLeases ?? [])) fail('batch-resource-conflict', 'Recorded batch bypasses a resource lease.')
    }
    if (selected.length < expectedSelected.length) {
        fail('batch-not-maximal', 'Recorded batch leaves a safe slot idle.')
    }
    if (JSON.stringify(selected) !== JSON.stringify(expectedSelected)
        || JSON.stringify((recordedBatch.deferred ?? []).map(({ taskId }) => taskId))
            !== JSON.stringify(expected.deferred.map(({ taskId }) => taskId))) {
        fail('batch-selection-mismatch', 'Recorded selection does not match deterministic ranking.')
    }
    const comparableRecorded = bodyWithout(bodyWithout(recordedBatch, 'batchDigest'), 'computedAt')
    const comparableExpected = bodyWithout(bodyWithout(expected, 'batchDigest'), 'computedAt')
    if (JSON.stringify(canonical(comparableRecorded))
        !== JSON.stringify(canonical(comparableExpected))) {
        fail('batch-selection-mismatch', 'Recorded ranking explanations are not machine-derived.')
    }
    const recordedBody = bodyWithout(bodyWithout(recordedBatch ?? {}, 'batchDigest'), 'computedAt')
    if (recordedBatch?.batchDigest !== digest(recordedBody)) {
        fail('batch-digest-mismatch', 'Recorded batch digest does not match its body.')
    }
    return { valid: true, batchDigest: recordedBatch.batchDigest }
}

export function acquireDispatchLease({ activeLeases = [], request }) {
    for (const lease of activeLeases) {
        validateLease(lease)
        if (lease.state !== 'active' || overlap(lease.keys, request.keys).length === 0) continue
        if (Date.parse(lease.expiresAt) <= Date.parse(request.acquiredAt)) {
            fail('lease-recovery-required', 'Expired lease must be recovered before reuse.')
        }
        fail('lease-conflict-held', 'A matching dispatch lease is already active.')
    }
    const body = {
        schema: 'issue-orchestration.dispatch-lease.v1',
        leaseId: request.leaseId,
        kind: request.kind,
        keys: request.keys,
        ownerId: request.ownerId,
        attemptId: request.attemptId,
        stageTaskId: request.stageTaskId,
        acquiredAt: request.acquiredAt,
        expiresAt: request.expiresAt,
        recoveryRule: request.recoveryRule,
        state: 'active'
    }
    const lease = { ...body, leaseDigest: digest(body) }
    validateLease(lease)
    return { lease }
}

export function releaseDispatchLease({ lease, attemptId, releasedAt }) {
    validateLease(lease)
    if (lease.attemptId !== attemptId) {
        fail('lease-attempt-mismatch', 'Only the owning attempt may release a lease.')
    }
    const body = { ...bodyWithout(lease, 'leaseDigest'), state: 'released', releasedAt }
    return { lease: { ...body, leaseDigest: digest(body) } }
}

export function recoverExpiredDispatchLease({ lease, recoveredAt, recoveryEvidence }) {
    validateLease(lease)
    if (Date.parse(lease.expiresAt) > Date.parse(recoveredAt)
        || recoveryEvidence?.ownerAttemptTerminal !== true
        || recoveryEvidence?.ownerProcessAbsent !== true
        || !SHA256.test(recoveryEvidence?.evidenceDigest ?? '')) {
        fail('lease-recovery-evidence', 'Lease recovery evidence is incomplete.')
    }
    const body = {
        ...bodyWithout(lease, 'leaseDigest'),
        state: 'recovered',
        recoveredAt,
        recoveryEvidence
    }
    return { lease: { ...body, leaseDigest: digest(body) } }
}
