import { createHash } from 'node:crypto'
import { verifyCleanupReceipt } from './resource-lifecycle.mjs'
// Shared issue-orchestration package runtime.

export const QUIESCENCE_OBSERVATION_SCHEMA =
    'issue-orchestration.quiescence-observation.v1'
export const QUIESCENCE_INVENTORY_SCHEMA =
    'issue-orchestration.quiescence-inventory.v1'
export const QUIESCENCE_RECEIPT_SCHEMA =
    'issue-orchestration.quiescence-receipt.v1'
export const QUIESCENCE_GATE_RESULT_SCHEMA =
    'issue-orchestration.quiescence-gate-result.v1'

const HASH = /^[a-f0-9]{64}$/u
const TARGET = /^[^/#\s]+\/[^/#\s]+#[1-9][0-9]*$/u
const VERIFIER_FIELDS = Object.freeze([
    'actorRole',
    'actorId',
    'observationMethod',
    'mode',
    'readOnly',
    'machineIdentityDigest',
    'implementationDigest',
    'packageDigest',
    'independent',
    'rootScheduler'
])
const REQUIRED_SOURCE_SCHEMAS = Object.freeze({
    projection: 'issue-orchestration.semantic-runtime-projection.v1',
    receipts: 'issue-orchestration.terminal-receipt-set.v1',
    registries: 'issue-orchestration.final-registry-inventory.v1'
})
const REQUIRED_INVENTORIES = Object.freeze([
    'issues',
    'stages',
    'attempts',
    'groups',
    'actors',
    'workPlans',
    'slices',
    'checkpoints',
    'continuations',
    'outputMissingBreakers',
    'routes',
    'profileCapabilities',
    'git',
    'resources',
    'processes',
    'ports',
    'docker',
    'locks',
    'leases',
    'slots',
    'filesystem',
    'skills',
    'bootstrap',
    'landing',
    'sourceCandidates',
    'commitMappings',
    'humanDecisions',
    'humanRetentions',
    'dag',
    'telemetry'
])

const ZERO_SUMMARY_FIELDS = Object.freeze({
    issues: ['openCount'],
    stages: ['incompleteCount', 'digestMismatchCount', 'authorityViolationCount'],
    attempts: [
        'activeCount', 'expiredUnrecoveredCount', 'cleanupFailureCount',
        'retainedCount', 'missingTerminalCount'
    ],
    groups: [
        'activeSessionCount', 'activeWriteLeaseCount', 'activeMemberStageCount',
        'ownedResourceCount', 'retainedServiceCount',
        'unfinishedDeliveryWindowCount', 'undisposedCommitPrefixCount',
        'missingTerminalCleanupReceiptCount', 'missingMemberReceiptCount'
    ],
    actors: ['activeCount', 'pendingActionCount'],
    workPlans: ['activeCount', 'staleCount', 'retainedCount'],
    slices: [
        'activeCount', 'abandonedCount', 'retainedCount', 'writeLeaseCount',
        'partialPromotedCount', 'uncompiledWholeIssueDispatchCount'
    ],
    checkpoints: [
        'activeCount', 'ownerlessCount', 'staleCount', 'withoutNextActionCount',
        'identityMismatchCount', 'supersededStillReferencedCount'
    ],
    continuations: [
        'pendingCount', 'ownerlessCount', 'missingCursorCount',
        'missingResourceCount', 'retainedCount'
    ],
    outputMissingBreakers: [
        'unresolvedCount', 'illegalRetryCount', 'bypassCount'
    ],
    routes: [
        'activeCount', 'staleCount', 'routeWithoutVerifiedSliceCount',
        'unauthorizedOverrideCount', 'unverifiedEffectiveProfileCount',
        'illegalFailurePromotionCount'
    ],
    profileCapabilities: ['pendingMismatchCount', 'unverifiedCount'],
    git: [
        'orphanWorktreeCount', 'staleMetadataCount', 'dirtyCount',
        'registryMismatchCount', 'remoteIdentityMismatchCount',
        'unreachableCandidateCount', 'unretiredCandidateCount'
    ],
    resources: [
        'activeCount', 'retainedCount', 'unknownCount', 'missingTerminalCount',
        'quarantineCount', 'cleanupFailureCount', 'orphanCount'
    ],
    processes: [
        'activeOwnedCount', 'descendantCount', 'deletedCwdCount', 'watcherCount'
    ],
    ports: ['ownedListeningCount'],
    docker: ['containerCount', 'networkCount', 'unhandledVolumeCount'],
    locks: ['busyCount', 'staleCount'],
    leases: ['busyCount', 'staleCount'],
    slots: ['busyCount'],
    filesystem: [
        'unfinishedRootCount', 'scratchCount', 'ownerlessCount',
        'halfWrittenCount', 'repoLocalDuplicateSkillCount',
        'unapprovedRetentionCount'
    ],
    skills: ['duplicateCount', 'halfInstalledCount', 'activeRuntimeStateCount'],
    bootstrap: ['activeStateCount', 'lockCount', 'slotCount'],
    landing: [
        'activeLeaseCount', 'activeAttemptCount', 'activeSliceCount',
        'continuationPendingCount', 'multiMemberConflictSliceCount',
        'pendingReverificationCount', 'unresolvedConflictManifestCount',
        'sourceTipMutationViolationCount', 'forcePushAttemptCount',
        'cleanupReceiptMissingCount'
    ],
    sourceCandidates: [
        'activeCount', 'unretiredCount', 'retainedCount', 'unknownOwnerCount'
    ],
    commitMappings: ['incompleteCount'],
    humanDecisions: [
        'activeRequestCount', 'recordedButUnappliedCount',
        'invalidatedReplayCount', 'postDecisionResumePendingCount'
    ],
    humanRetentions: ['ownerlessCount', 'expiredCount', 'retainedCount'],
    dag: [
        'residentUpdaterCount', 'unauthorizedProposalCount',
        'unappliedManualPatchCount'
    ],
    telemetry: ['pendingEventCount']
})

const TRUE_SUMMARY_FIELDS = Object.freeze({
    skills: [
        'singleSharedArtifact', 'legacyRepoLocalAuthoritiesAbsent',
        'legacyAliasesAbsent', 'secondaryOrchestrationCopyAbsent',
        'designAuthoritiesUnique', 'roleSkillReceiptVerified',
        'digestConsistent', 'runtimeStateInInstallAbsent'
    ],
    dag: ['latestRemoteSnapshotBound'],
    telemetry: ['digestRecomputable']
})

const FALSE_SUMMARY_FIELDS = Object.freeze({
    bootstrap: ['fallbackDiscoverable']
})

const HASH_SUMMARY_FIELDS = Object.freeze({
    skills: ['installDigest', 'roleSkillReceiptDigest'],
    bootstrap: ['retirementReceiptDigest'],
    dag: ['remoteSnapshotDigest'],
    telemetry: ['finalSummaryDigest']
})

const EXACT_SUMMARY_FIELDS = Object.freeze({
    bootstrap: { disposition: 'retired' }
})

const TERMINAL_STATES = Object.freeze({
    issues: new Set(['closed', 'terminal']),
    stages: new Set(['complete', 'terminal']),
    attempts: new Set(['completed', 'failed', 'cancelled', 'superseded']),
    groups: new Set(['completed', 'failed', 'cancelled', 'superseded']),
    actors: new Set(['completed', 'failed', 'cancelled', 'retired']),
    workPlans: new Set(['completed', 'superseded']),
    slices: new Set([
        'completed-and-folded-into-stage',
        'failed-with-terminal-receipt',
        'superseded-by-authoritative-replan'
    ]),
    checkpoints: new Set(['completed', 'superseded']),
    continuations: new Set(['completed', 'cancelled', 'superseded']),
    outputMissingBreakers: new Set(['resolved', 'terminal-failure']),
    routes: new Set(['consumed', 'superseded', 'cancelled']),
    profileCapabilities: new Set(['matched', 'rerouted', 'terminal-failure']),
    git: new Set([
        'verified', 'baseline', 'removed', 'retired',
        'landed-and-retired', 'approved-audit-only'
    ]),
    resources: new Set(['baseline', 'released', 'removed']),
    processes: new Set(['baseline', 'absent-verified']),
    ports: new Set(['baseline', 'absent-verified']),
    docker: new Set(['baseline', 'absent-verified']),
    locks: new Set(['baseline', 'released', 'absent-verified']),
    leases: new Set(['baseline', 'released', 'absent-verified']),
    slots: new Set(['baseline', 'released', 'absent-verified']),
    filesystem: new Set(['baseline', 'approved-audit-only']),
    skills: new Set(['installed-and-verified', 'absent-and-verified']),
    bootstrap: new Set(['retired']),
    landing: new Set(['landed', 'cancelled-and-cleaned', 'superseded-and-cleaned']),
    sourceCandidates: new Set([
        'landed-and-source-retired',
        'already-applied-equivalent-and-retired',
        'explicitly-abandoned-by-authority'
    ]),
    commitMappings: new Set(['complete']),
    humanDecisions: new Set([
        'applied', 'invalidated-and-replaced', 'safe-no-decision-terminal'
    ]),
    humanRetentions: new Set(['released', 'cleaned']),
    dag: new Set(['terminal']),
    telemetry: new Set(['terminal'])
})

const IDENTIFIERS = Object.freeze({
    issues: ['target'],
    stages: ['target'],
    attempts: ['attemptId'],
    groups: ['groupId'],
    actors: ['actorId'],
    workPlans: ['workPlanId'],
    slices: ['sliceId'],
    checkpoints: ['checkpointId'],
    continuations: ['continuationId'],
    outputMissingBreakers: ['breakerId'],
    routes: ['routeId'],
    profileCapabilities: ['decisionId'],
    git: ['resourceId', 'repository'],
    resources: ['resourceId'],
    processes: ['resourceId', 'processGroupId'],
    ports: ['resourceId', 'port'],
    docker: ['resourceId', 'containerId'],
    locks: ['resourceId', 'lockId'],
    leases: ['resourceId', 'leaseId'],
    slots: ['resourceId', 'slotId'],
    filesystem: ['resourceId', 'path'],
    skills: ['skillId'],
    bootstrap: ['bootstrapId'],
    landing: ['landingAttemptId'],
    sourceCandidates: ['candidateId'],
    commitMappings: ['mappingId'],
    humanDecisions: ['requestId'],
    humanRetentions: ['retentionId'],
    dag: ['snapshotId'],
    telemetry: ['summaryId']
})

export class QuiescenceError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'QuiescenceError'
        this.code = code
    }
}

function fail(code) {
    throw new QuiescenceError(code)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

export function computeQuiescenceDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function unsignedDigest(value, field) {
    const unsigned = clone(value)
    delete unsigned[field]
    return computeQuiescenceDigest(unsigned)
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function isHash(value) {
    return HASH.test(value ?? '')
}

function isIsoTimestamp(value) {
    if (!isText(value)) return false
    const parsed = new Date(value)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function kebab(value) {
    return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0
}

function compareCanonical(left, right) {
    return compareText(
        JSON.stringify(canonical(left)),
        JSON.stringify(canonical(right))
    )
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
    return value
}

function addViolation(violations, code, category, subject = category) {
    violations.push({ code, category, subject: String(subject) })
}

function sortedViolations(violations) {
    const unique = new Map()
    for (const violation of violations) {
        unique.set(JSON.stringify(canonical(violation)), violation)
    }
    return [...unique.values()].sort((left, right) => compareText(
        `${left.category}\0${left.code}\0${left.subject}`,
        `${right.category}\0${right.code}\0${right.subject}`
    ))
}

function recordSubject(category, record) {
    for (const field of IDENTIFIERS[category] ?? []) {
        if (isText(record?.[field]) || Number.isSafeInteger(record?.[field])) {
            return String(record[field])
        }
    }
    return `record-${computeQuiescenceDigest(record ?? null).slice(0, 12)}`
}

function terminalState(record) {
    return record?.status ?? record?.terminalState ??
        record?.state ?? record?.disposition
}

function inspectSummary(category, summary, violations) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        addViolation(violations, 'inventory.summary-missing', category)
        return
    }
    for (const field of ZERO_SUMMARY_FIELDS[category] ?? []) {
        if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
            addViolation(
                violations,
                'inventory.summary-field-invalid',
                category,
                `${category}.${field}`
            )
        } else if (summary[field] !== 0) {
            addViolation(
                violations,
                `${category}.${kebab(field)}`,
                category,
                `${category}.${field}`
            )
        }
    }
    for (const field of TRUE_SUMMARY_FIELDS[category] ?? []) {
        if (summary[field] !== true) {
            addViolation(
                violations,
                `${category}.${kebab(field)}-not-proven`,
                category,
                `${category}.${field}`
            )
        }
    }
    for (const field of FALSE_SUMMARY_FIELDS[category] ?? []) {
        if (summary[field] !== false) {
            addViolation(
                violations,
                `${category}.${kebab(field)}-present`,
                category,
                `${category}.${field}`
            )
        }
    }
    for (const field of HASH_SUMMARY_FIELDS[category] ?? []) {
        if (!isHash(summary[field])) {
            addViolation(
                violations,
                `${category}.${kebab(field)}-invalid`,
                category,
                `${category}.${field}`
            )
        }
    }
    for (const [field, expected] of Object.entries(
        EXACT_SUMMARY_FIELDS[category] ?? {}
    )) {
        if (summary[field] !== expected) {
            addViolation(
                violations,
                `${category}.${kebab(field)}-not-terminal`,
                category,
                `${category}.${field}`
            )
        }
    }
}

function inspectCommonRecord(category, record, violations) {
    const subject = recordSubject(category, record)
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        addViolation(violations, 'inventory.record-invalid', category, subject)
        return subject
    }
    if (!(IDENTIFIERS[category] ?? []).some(
        (field) => isText(record[field]) || Number.isSafeInteger(record[field])
    )) {
        addViolation(
            violations,
            'inventory.record-identity-missing',
            category,
            subject
        )
    }
    for (const flag of ['active', 'pending', 'retained', 'unknown', 'stale']) {
        if (record[flag] === true) {
            addViolation(
                violations,
                `${category}.record-${flag}`,
                category,
                subject
            )
        }
    }
    if (record.ownerClass === 'unknown-owner') {
        addViolation(violations, `${category}.unknown-owner`, category, subject)
    }
    const state = terminalState(record)
    if (!isText(state)) {
        addViolation(violations, `${category}.terminal-state-missing`, category, subject)
    } else if (!TERMINAL_STATES[category]?.has(state)) {
        addViolation(violations, `${category}.terminal-state-invalid`, category, subject)
    }
    return subject
}

function requireHashField(category, record, field, violations, subject) {
    if (!isHash(record?.[field])) {
        addViolation(
            violations,
            `${category}.${kebab(field)}-missing`,
            category,
            subject
        )
        return false
    }
    return true
}

function requireTextField(category, record, field, violations, subject) {
    if (!isText(record?.[field])) {
        addViolation(
            violations,
            `${category}.${kebab(field)}-missing`,
            category,
            subject
        )
        return false
    }
    return true
}

function requireEmptyArray(category, record, field, violations, subject) {
    if (!Array.isArray(record?.[field])) {
        addViolation(
            violations,
            `${category}.${kebab(field)}-missing`,
            category,
            subject
        )
        return false
    }
    if (record[field].length !== 0) {
        addViolation(
            violations,
            `${category}.${kebab(field)}-not-empty`,
            category,
            subject
        )
        return false
    }
    return true
}

function inspectAttempt(record, outerBindings, violations) {
    const subject = inspectCommonRecord('attempts', record, violations)
    requireTextField('attempts', record, 'attemptId', violations, subject)
    requireTextField('attempts', record, 'issueTarget', violations, subject)
    requireTextField('attempts', record, 'epochId', violations, subject)
    requireHashField('attempts', record, 'terminalEventDigest', violations, subject)
    const receipt = record?.cleanupReceipt
    if (!receipt) {
        addViolation(
            violations,
            'attempts.cleanup-receipt-missing',
            'attempts',
            subject
        )
        return
    }
    try {
        verifyCleanupReceipt(receipt)
    } catch {
        addViolation(
            violations,
            'attempts.cleanup-receipt-invalid',
            'attempts',
            subject
        )
        return
    }
    if (receipt.runId !== record.runId
        || receipt.attemptId !== record.attemptId
        || receipt.epochId !== record.epochId) {
        addViolation(
            violations,
            'attempts.cleanup-receipt-binding-mismatch',
            'attempts',
            subject
        )
    }
    if (record.runId !== outerBindings.runId
        || receipt.runId !== outerBindings.runId
        || receipt.baselineDigest !== outerBindings.baselineDigest) {
        addViolation(
            violations,
            'attempts.outer-binding-mismatch',
            'attempts',
            subject
        )
    }
    if (record.cleanupReceiptDigest !== undefined
        && record.cleanupReceiptDigest !== receipt.receiptDigest) {
        addViolation(
            violations,
            'attempts.cleanup-receipt-reference-mismatch',
            'attempts',
            subject
        )
    }
    for (const [field, code] of [
        ['retainedResources', 'attempts.cleanup-retained-resources'],
        ['quarantinedResources', 'attempts.cleanup-quarantine'],
        ['failedResources', 'attempts.cleanup-failures']
    ]) {
        if (receipt[field]?.length > 0) {
            addViolation(violations, code, 'attempts', subject)
        }
    }
}

function inspectGroup(record, violations) {
    const subject = inspectCommonRecord('groups', record, violations)
    requireHashField(
        'groups',
        record,
        'terminalCleanupReceiptDigest',
        violations,
        subject
    )
    for (const field of [
        'activeMemberIds', 'activeWriteLeaseIds', 'ownedResourceIds',
        'retainedServiceIds', 'unfinishedDeliveryWindowIds',
        'undisposedCommitPrefixes'
    ]) requireEmptyArray('groups', record, field, violations, subject)
    if (!Array.isArray(record?.memberIds) || !Array.isArray(record?.memberReceiptIds)) {
        addViolation(violations, 'groups.member-receipts-missing', 'groups', subject)
    } else {
        const members = [...new Set(record.memberIds)].sort()
        const receipts = [...new Set(record.memberReceiptIds)].sort()
        if (JSON.stringify(members) !== JSON.stringify(receipts)) {
            addViolation(
                violations,
                'groups.member-receipts-incomplete',
                'groups',
                subject
            )
        }
    }
}

function inspectActor(record, violations) {
    const subject = inspectCommonRecord('actors', record, violations)
    requireTextField('actors', record, 'actorId', violations, subject)
    requireTextField('actors', record, 'actorRole', violations, subject)
    if (record?.pendingAction === true) {
        addViolation(violations, 'actors.pending-action', 'actors', subject)
    }
}

function inspectSlice(record, violations) {
    const subject = inspectCommonRecord('slices', record, violations)
    requireHashField('slices', record, 'terminalReceiptDigest', violations, subject)
    if (record?.writeLeaseId !== null) {
        addViolation(violations, 'slices.write-lease-present', 'slices', subject)
    }
    if (record?.partialPromoted === true) {
        addViolation(violations, 'slices.partial-promoted', 'slices', subject)
    }
    if (record?.supersededStillReferenced === true) {
        addViolation(violations, 'slices.superseded-still-referenced', 'slices', subject)
    }
}

function inspectCheckpoint(record, violations) {
    const subject = inspectCommonRecord('checkpoints', record, violations)
    requireTextField('checkpoints', record, 'ownerId', violations, subject)
    requireTextField('checkpoints', record, 'cursor', violations, subject)
    requireTextField('checkpoints', record, 'nextAction', violations, subject)
    requireHashField(
        'checkpoints',
        record,
        'checkpointDigest',
        violations,
        subject
    )
    if (record?.identityValid !== true) {
        addViolation(
            violations,
            'checkpoints.identity-not-verified',
            'checkpoints',
            subject
        )
    }
    if (record?.activeReference === true) {
        addViolation(
            violations,
            'checkpoints.active-reference',
            'checkpoints',
            subject
        )
    }
}

function inspectContinuation(record, violations) {
    const subject = inspectCommonRecord('continuations', record, violations)
    requireHashField(
        'continuations',
        record,
        'terminalReceiptDigest',
        violations,
        subject
    )
}

function inspectOutputMissingBreaker(record, violations) {
    const subject = inspectCommonRecord(
        'outputMissingBreakers',
        record,
        violations
    )
    requireHashField(
        'outputMissingBreakers',
        record,
        'failureReceiptDigest',
        violations,
        subject
    )
    requireHashField(
        'outputMissingBreakers',
        record,
        'breakerDispositionDigest',
        violations,
        subject
    )
    if (record?.open !== false) {
        addViolation(
            violations,
            'outputMissingBreakers.open',
            'outputMissingBreakers',
            subject
        )
    }
}

function inspectRoute(record, violations) {
    const subject = inspectCommonRecord('routes', record, violations)
    requireHashField('routes', record, 'decisionDigest', violations, subject)
    requireTextField('routes', record, 'sliceId', violations, subject)
    for (const [field, code] of [
        ['verifiedSlice', 'routes.slice-not-verified'],
        ['effectiveProfileVerified', 'routes.effective-profile-not-verified'],
        ['failurePromotionLegal', 'routes.illegal-failure-promotion']
    ]) {
        if (record?.[field] !== true) addViolation(violations, code, 'routes', subject)
    }
    if (record?.unauthorizedOverride === true) {
        addViolation(violations, 'routes.unauthorized-override', 'routes', subject)
    }
}

function inspectProfileCapability(record, violations) {
    const subject = inspectCommonRecord('profileCapabilities', record, violations)
    requireHashField(
        'profileCapabilities',
        record,
        'decisionDigest',
        violations,
        subject
    )
    for (const field of ['requestedMetadataObserved', 'effectiveMetadataObserved']) {
        if (record?.[field] !== true) {
            addViolation(
                violations,
                `profileCapabilities.${kebab(field)}-not-proven`,
                'profileCapabilities',
                subject
            )
        }
    }
}

function inspectFilesystemRecord(record, allowedArtifacts, violations) {
    const subject = inspectCommonRecord('filesystem', record, violations)
    requireHashField('filesystem', record, 'evidenceDigest', violations, subject)
    if (terminalState(record) === 'approved-audit-only'
        && !allowedArtifacts.has(record?.resourceId)) {
        addViolation(
            violations,
            'filesystem.retention-not-approved',
            'filesystem',
            subject
        )
    }
}

function inspectGitRecord(
    record,
    allowedArtifacts,
    outerBindings,
    violations
) {
    const subject = inspectCommonRecord('git', record, violations)
    requireHashField('git', record, 'evidenceDigest', violations, subject)
    if (terminalState(record) === 'approved-audit-only'
        && !allowedArtifacts.has(record?.resourceId)) {
        addViolation(
            violations,
            'git.retention-not-approved',
            'git',
            subject
        )
    }
    if (terminalState(record) === 'baseline'
        && record?.baselineDigest !== outerBindings.baselineDigest) {
        addViolation(violations, 'git.baseline-mismatch', 'git', subject)
    }
    for (const [field, expected, code] of [
        ['dirty', false, 'git.dirty'],
        ['registryConsistent', true, 'git.registry-mismatch'],
        ['remoteIdentityExact', true, 'git.remote-identity-mismatch']
    ]) {
        if (record?.[field] !== undefined && record[field] !== expected) {
            addViolation(violations, code, 'git', subject)
        }
    }
}

function inspectResource(record, outerBindings, violations) {
    const subject = inspectCommonRecord('resources', record, violations)
    if (terminalState(record) === 'baseline') {
        requireHashField(
            'resources',
            record,
            'evidenceDigest',
            violations,
            subject
        )
        if (record?.baselineDigest !== outerBindings.baselineDigest) {
            addViolation(
                violations,
                'resources.baseline-mismatch',
                'resources',
                subject
            )
        }
    } else {
        requireHashField(
            'resources',
            record,
            'terminalReceiptDigest',
            violations,
            subject
        )
    }
}

function inspectRuntimeRecord(category, record, violations) {
    const subject = inspectGenericEvidenceRecord(category, record, violations)
    const liveFlags = {
        processes: ['alive', 'descendantAlive', 'watcherAlive'],
        ports: ['bound', 'listening'],
        docker: ['present', 'running', 'stoppedButPresent'],
        locks: ['held', 'busy'],
        leases: ['held', 'busy'],
        slots: ['held', 'busy']
    }[category] ?? []
    if (liveFlags.some((field) => record?.[field] === true)) {
        addViolation(violations, `${category}.record-present`, category, subject)
    }
    return subject
}

function inspectSourceCandidate(record, violations) {
    const subject = inspectCommonRecord('sourceCandidates', record, violations)
    requireHashField(
        'sourceCandidates',
        record,
        'terminalReceiptDigest',
        violations,
        subject
    )
    if (terminalState(record) === 'explicitly-abandoned-by-authority') {
        requireHashField(
            'sourceCandidates',
            record,
            'authorityReceiptDigest',
            violations,
            subject
        )
    }
}

function inspectGenericEvidenceRecord(category, record, violations) {
    const subject = inspectCommonRecord(category, record, violations)
    const evidenceField = {
        workPlans: 'terminalReceiptDigest',
        git: 'evidenceDigest',
        resources: 'terminalReceiptDigest',
        processes: 'evidenceDigest',
        ports: 'evidenceDigest',
        docker: 'evidenceDigest',
        locks: 'evidenceDigest',
        leases: 'evidenceDigest',
        slots: 'evidenceDigest',
        skills: 'artifactDigest',
        bootstrap: 'retirementReceiptDigest',
        landing: 'terminalReceiptDigest',
        commitMappings: 'mappingDigest',
        humanDecisions: 'decisionReceiptDigest',
        humanRetentions: 'terminalReceiptDigest',
        dag: 'snapshotDigest',
        telemetry: 'summaryDigest'
    }[category]
    if (evidenceField) {
        requireHashField(category, record, evidenceField, violations, subject)
    }
    return subject
}

function inspectRecords(
    inventories,
    allowedArtifacts,
    outerBindings,
    violations
) {
    const inspectors = {
        attempts: (record, target) =>
            inspectAttempt(record, outerBindings, target),
        groups: inspectGroup,
        actors: inspectActor,
        slices: inspectSlice,
        checkpoints: inspectCheckpoint,
        continuations: inspectContinuation,
        outputMissingBreakers: inspectOutputMissingBreaker,
        routes: inspectRoute,
        profileCapabilities: inspectProfileCapability,
        git: (record, target) =>
            inspectGitRecord(
                record,
                allowedArtifacts,
                outerBindings,
                target
            ),
        resources: (record, target) =>
            inspectResource(record, outerBindings, target),
        processes: (record, target) =>
            inspectRuntimeRecord('processes', record, target),
        ports: (record, target) =>
            inspectRuntimeRecord('ports', record, target),
        docker: (record, target) =>
            inspectRuntimeRecord('docker', record, target),
        locks: (record, target) =>
            inspectRuntimeRecord('locks', record, target),
        leases: (record, target) =>
            inspectRuntimeRecord('leases', record, target),
        slots: (record, target) =>
            inspectRuntimeRecord('slots', record, target),
        filesystem: (record, target) =>
            inspectFilesystemRecord(record, allowedArtifacts, target),
        sourceCandidates: inspectSourceCandidate
    }
    for (const category of REQUIRED_INVENTORIES) {
        if (['issues', 'stages'].includes(category)) continue
        for (const record of inventories[category]?.records ?? []) {
            const inspector = inspectors[category]
                ?? ((entry, target) =>
                    inspectGenericEvidenceRecord(category, entry, target))
            inspector(record, violations)
        }
    }
}

function inspectAllowedRetention(value, verifiedAt, violations) {
    const artifacts = Array.isArray(value?.artifacts)
        ? clone(value.artifacts).sort(compareCanonical)
        : []
    if (value?.schema !== 'issue-orchestration.quiescence-allowed-retention.v1'
        || value?.verificationStatus !== 'verified'
        || !Array.isArray(value?.artifacts)) {
        addViolation(
            violations,
            'allowed-retention.invalid',
            'allowedRetention'
        )
    }
    const ids = new Set()
    for (const artifact of artifacts) {
        const subject = artifact?.artifactId
            ?? `artifact-${computeQuiescenceDigest(artifact ?? null).slice(0, 12)}`
        if (!isText(artifact?.artifactId)
            || ids.has(artifact.artifactId)
            || artifact.status !== 'approved-audit-only'
            || !isText(artifact.owner)
            || !isText(artifact.reason)
            || !isIsoTimestamp(artifact.expiresAt)
            || !isText(artifact.recoveryAction)
            || !isHash(artifact.verificationReceiptDigest)) {
            addViolation(
                violations,
                'allowed-retention.artifact-invalid',
                'allowedRetention',
                subject
            )
        }
        if (isIsoTimestamp(artifact?.expiresAt)
            && artifact.expiresAt <= verifiedAt) {
            addViolation(
                violations,
                'allowed-retention.artifact-expired',
                'allowedRetention',
                subject
            )
        }
        if (isText(artifact?.artifactId)) ids.add(artifact.artifactId)
    }
    return {
        artifacts,
        artifactIds: ids,
        digest: computeQuiescenceDigest(artifacts)
    }
}

function inspectBaseline(value, violations) {
    if (value?.schema !== 'issue-orchestration.resource-baseline-inventory.v1'
        || value?.verificationStatus !== 'verified'
        || !isHash(value?.baselineDigest)) {
        addViolation(violations, 'baseline.invalid', 'baseline')
    }
    return isHash(value?.baselineDigest)
        ? value.baselineDigest
        : computeQuiescenceDigest({ missing: 'baseline' })
}

function inspectSources(value, violations) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        addViolation(violations, 'sources.missing', 'sources')
        return {}
    }
    const sources = clone(value)
    const sourceIds = Object.keys(sources).sort()
    if (JSON.stringify(sourceIds)
        !== JSON.stringify(Object.keys(REQUIRED_SOURCE_SCHEMAS).sort())) {
        addViolation(violations, 'sources.exact-set-mismatch', 'sources')
    }
    for (const [sourceId, source] of Object.entries(sources)) {
        if (!isText(sourceId)
            || source?.schema !== REQUIRED_SOURCE_SCHEMAS[sourceId]
            || source?.verificationStatus !== 'verified'
            || !isHash(source?.digest)) {
            addViolation(violations, 'sources.unverified', 'sources', sourceId)
        }
    }
    return sources
}

function inspectInventories(value, sources, violations) {
    const inventories = {}
    const digests = {}
    for (const category of REQUIRED_INVENTORIES) {
        const inventory = value?.[category]
        if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
            addViolation(violations, 'inventory.missing', category)
            inventories[category] = { category, summary: null, records: [] }
            digests[category] = computeQuiescenceDigest({
                schema: QUIESCENCE_INVENTORY_SCHEMA,
                category,
                missing: true
            })
            continue
        }
        const snapshot = clone(inventory)
        if (Array.isArray(snapshot.sourceRefs)) {
            snapshot.sourceRefs = [...snapshot.sourceRefs].sort(compareText)
        }
        if (Array.isArray(snapshot.records)) {
            snapshot.records = [...snapshot.records].sort(compareCanonical)
        }
        inventories[category] = {
            ...snapshot,
            records: Array.isArray(snapshot.records) ? snapshot.records : []
        }
        if (snapshot.schema !== QUIESCENCE_INVENTORY_SCHEMA
            || snapshot.category !== category) {
            addViolation(violations, 'inventory.schema-invalid', category)
        }
        if (!Array.isArray(snapshot.records)) {
            addViolation(violations, 'inventory.records-invalid', category)
        } else {
            const subjects = new Set()
            for (const record of snapshot.records) {
                const subject = recordSubject(category, record)
                if (subjects.has(subject)) {
                    addViolation(
                        violations,
                        'inventory.record-duplicate',
                        category,
                        subject
                    )
                }
                subjects.add(subject)
            }
        }
        if (snapshot.availability !== 'available') {
            addViolation(violations, 'inventory.unavailable', category)
        }
        if (!Array.isArray(snapshot.sourceRefs) || snapshot.sourceRefs.length === 0) {
            addViolation(violations, 'inventory.source-missing', category)
        } else {
            for (const sourceId of snapshot.sourceRefs) {
                const source = sources[sourceId]
                if (!source
                    || source.verificationStatus !== 'verified'
                    || !isHash(source.digest)) {
                    addViolation(
                        violations,
                        'inventory.source-unverified',
                        category,
                        sourceId
                    )
                }
            }
        }
        inspectSummary(category, snapshot.summary, violations)
        const stateSnapshot = clone(snapshot)
        delete stateSnapshot.observedAt
        delete stateSnapshot.capturedAt
        delete stateSnapshot.durationMs
        digests[category] = computeQuiescenceDigest(stateSnapshot)
    }
    return { inventories, digests }
}

function inspectIssueAndStageEvidence({
    targetIssueSet,
    inventories,
    violations
}) {
    const issueByTarget = new Map()
    const stageByTarget = new Map()
    for (const issue of inventories.issues?.records ?? []) {
        const subject = inspectCommonRecord('issues', issue, violations)
        if (!TARGET.test(issue?.target ?? '')) {
            addViolation(violations, 'issues.target-invalid', 'issues', subject)
            continue
        }
        if (issueByTarget.has(issue.target)) {
            addViolation(violations, 'issues.target-duplicate', 'issues', issue.target)
        }
        issueByTarget.set(issue.target, issue)
        requireHashField(
            'issues',
            issue,
            'completionEvidenceDigest',
            violations,
            subject
        )
        requireHashField(
            'issues',
            issue,
            'remoteSnapshotDigest',
            violations,
            subject
        )
    }
    for (const stage of inventories.stages?.records ?? []) {
        const subject = inspectCommonRecord('stages', stage, violations)
        if (!TARGET.test(stage?.target ?? '')) {
            addViolation(violations, 'stages.target-invalid', 'stages', subject)
            continue
        }
        if (stageByTarget.has(stage.target)) {
            addViolation(violations, 'stages.target-duplicate', 'stages', stage.target)
        }
        stageByTarget.set(stage.target, stage)
    }

    const cleanupDigestsByTarget = new Map()
    for (const attempt of inventories.attempts?.records ?? []) {
        if (!isText(attempt?.issueTarget) || !isHash(attempt?.cleanupReceipt?.receiptDigest)) {
            continue
        }
        cleanupDigestsByTarget.set(
            attempt.issueTarget,
            new Set([
                ...(cleanupDigestsByTarget.get(attempt.issueTarget) ?? []),
                attempt.cleanupReceipt.receiptDigest
            ])
        )
    }

    const completedIssueEvidence = []
    for (const target of targetIssueSet) {
        const issue = issueByTarget.get(target)
        const stage = stageByTarget.get(target)
        const terminalDisposition = issue?.disposition === 'terminal'
        let complete = true
        if (!issue) {
            addViolation(violations, 'issues.target-missing', 'issues', target)
            complete = false
        } else if (terminalDisposition) {
            if (!['open', 'closed'].includes(issue.state)) {
                addViolation(
                    violations,
                    'issues.terminal-remote-state-invalid',
                    'issues',
                    target
                )
                complete = false
            }
            for (const field of [
                'terminalReceiptDigest',
                'recoveryFingerprintDigest',
                'retentionStateDigest'
            ]) {
                if (!requireHashField('issues', issue, field, violations, target)) {
                    complete = false
                }
            }
            if (!isText(issue.terminalCategory)) {
                addViolation(
                    violations,
                    'issues.terminal-category-missing',
                    'issues',
                    target
                )
                complete = false
            }
        } else if (issue.state !== 'closed') {
            addViolation(violations, 'issues.target-not-closed', 'issues', target)
            complete = false
        }
        if (!stage) {
            addViolation(violations, 'stages.target-missing', 'stages', target)
            complete = false
        } else if (terminalDisposition) {
            if (stage.status !== 'terminal') {
                addViolation(
                    violations,
                    'stages.terminal-status-invalid',
                    'stages',
                    target
                )
                complete = false
            }
            for (const field of [
                'terminalReceiptDigest',
                'recoveryFingerprintDigest',
                'retentionStateDigest',
                'roleSkillReceiptDigest'
            ]) {
                if (!requireHashField('stages', stage, field, violations, target)) {
                    complete = false
                }
            }
            for (const field of [
                'terminalReceiptDigest',
                'recoveryFingerprintDigest',
                'retentionStateDigest'
            ]) {
                if (issue?.[field] !== stage[field]) {
                    addViolation(
                        violations,
                        `stages.${kebab(field)}-mismatch`,
                        'stages',
                        target
                    )
                    complete = false
                }
            }
            if (issue?.terminalCategory !== stage.terminalCategory) {
                addViolation(
                    violations,
                    'stages.terminal-category-mismatch',
                    'stages',
                    target
                )
                complete = false
            }
            if (stage.authorityValid !== true || stage.digestsConsistent !== true) {
                addViolation(
                    violations,
                    'stages.authority-or-digest-invalid',
                    'stages',
                    target
                )
                complete = false
            }
            if (stage.roleSkillReceiptDigest
                !== inventories.skills?.summary?.roleSkillReceiptDigest) {
                addViolation(
                    violations,
                    'stages.role-skill-receipt-mismatch',
                    'stages',
                    target
                )
                complete = false
            }
        } else {
            const required = [
                'frozenTestContractDigest',
                'implementationCandidateDigest',
                'behaviorGreenReceiptDigest',
                'documentationGreenReceiptDigest',
                'remoteDeliveryEvidenceDigest',
                'resourceCleanupReceiptDigest',
                'candidateEpochDigest',
                'roleSkillReceiptDigest'
            ]
            for (const field of required) {
                if (!requireHashField('stages', stage, field, violations, target)) {
                    complete = false
                }
            }
            if (stage.authorityValid !== true || stage.digestsConsistent !== true) {
                addViolation(
                    violations,
                    'stages.authority-or-digest-invalid',
                    'stages',
                    target
                )
                complete = false
            }
            if (stage.roleSkillReceiptDigest
                !== inventories.skills?.summary?.roleSkillReceiptDigest) {
                addViolation(
                    violations,
                    'stages.role-skill-receipt-mismatch',
                    'stages',
                    target
                )
                complete = false
            }
            if (stage.uiNode === true) {
                for (const field of [
                    'uxAcceptedReceiptDigest',
                    'designSkillDigest'
                ]) {
                    if (!requireHashField(
                        'stages',
                        stage,
                        field,
                        violations,
                        target
                    )) complete = false
                }
            }
            const canonicalChain = [
                'canonicalDeliveryEffectDigest',
                'canonicalCleanupFinalizationDigest',
                'canonicalClosureEffectDigest'
            ].every((field) => isHash(stage[field]))
            if (!canonicalChain && !cleanupDigestsByTarget.get(target)
                ?.has(stage.resourceCleanupReceiptDigest)) {
                addViolation(
                    violations,
                    'stages.cleanup-receipt-mismatch',
                    'stages',
                    target
                )
                complete = false
            }
        }
        if (issue && (issue.state === 'closed' || terminalDisposition)) {
            if (issue.remoteSnapshotDigest
                !== inventories.dag?.summary?.remoteSnapshotDigest) {
                addViolation(
                    violations,
                    'issues.remote-snapshot-mismatch',
                    'issues',
                    target
                )
                complete = false
            }
            for (const attempt of inventories.attempts?.records ?? []) {
                if (attempt?.issueTarget === target
                    && (attempt.active === true
                        || !TERMINAL_STATES.attempts.has(terminalState(attempt)))) {
                    addViolation(
                        violations,
                        'attempts.closed-issue-still-active',
                        'attempts',
                        recordSubject('attempts', attempt)
                    )
                }
            }
            for (const actor of inventories.actors?.records ?? []) {
                if (actor?.issueTarget === target
                    && (actor.active === true
                        || !TERMINAL_STATES.actors.has(terminalState(actor)))) {
                    addViolation(
                        violations,
                        'actors.closed-issue-still-active',
                        'actors',
                        recordSubject('actors', actor)
                    )
                }
            }
        }
        if (complete && terminalDisposition) {
            const evidence = {
                target,
                disposition: 'terminal',
                terminalCategory: issue.terminalCategory,
                completionEvidenceDigest: issue.completionEvidenceDigest,
                remoteSnapshotDigest: issue.remoteSnapshotDigest,
                terminalReceiptDigest: issue.terminalReceiptDigest,
                recoveryFingerprintDigest: issue.recoveryFingerprintDigest,
                retentionStateDigest: issue.retentionStateDigest,
                roleSkillReceiptDigest: stage.roleSkillReceiptDigest,
                issueEvidenceDigest: computeQuiescenceDigest(issue),
                stageEvidenceDigest: computeQuiescenceDigest(stage)
            }
            evidence.evidenceDigest = computeQuiescenceDigest(evidence)
            completedIssueEvidence.push(evidence)
        } else if (complete) {
            const evidence = {
                target,
                disposition: 'closed',
                uiNode: stage.uiNode === true,
                completionEvidenceDigest: issue.completionEvidenceDigest,
                remoteSnapshotDigest: issue.remoteSnapshotDigest,
                frozenTestContractDigest: stage.frozenTestContractDigest,
                implementationCandidateDigest:
                    stage.implementationCandidateDigest,
                behaviorGreenReceiptDigest: stage.behaviorGreenReceiptDigest,
                uxAcceptedReceiptDigest:
                    stage.uiNode === true
                        ? stage.uxAcceptedReceiptDigest
                        : null,
                designSkillDigest:
                    stage.uiNode === true ? stage.designSkillDigest : null,
                documentationGreenReceiptDigest:
                    stage.documentationGreenReceiptDigest,
                remoteDeliveryEvidenceDigest:
                    stage.remoteDeliveryEvidenceDigest,
                resourceCleanupReceiptDigest:
                    stage.resourceCleanupReceiptDigest,
                candidateEpochDigest: stage.candidateEpochDigest,
                roleSkillReceiptDigest: stage.roleSkillReceiptDigest,
                canonicalDeliveryEffectDigest:
                    stage.canonicalDeliveryEffectDigest ?? null,
                canonicalCleanupFinalizationDigest:
                    stage.canonicalCleanupFinalizationDigest ?? null,
                canonicalClosureEffectDigest:
                    stage.canonicalClosureEffectDigest ?? null,
                issueEvidenceDigest: computeQuiescenceDigest(issue),
                stageEvidenceDigest: computeQuiescenceDigest(stage)
            }
            evidence.evidenceDigest = computeQuiescenceDigest(evidence)
            completedIssueEvidence.push(evidence)
        }
    }
    const targets = new Set(targetIssueSet)
    for (const target of issueByTarget.keys()) {
        if (!targets.has(target)) {
            addViolation(violations, 'issues.target-extra', 'issues', target)
        }
    }
    for (const target of stageByTarget.keys()) {
        if (!targets.has(target)) {
            addViolation(violations, 'stages.target-extra', 'stages', target)
        }
    }
    return completedIssueEvidence
}

function inspectVerifier(verifier, inventories, violations) {
    const fields = Object.keys(verifier ?? {}).sort()
    if (JSON.stringify(fields) !== JSON.stringify([...VERIFIER_FIELDS].sort())) {
        addViolation(violations, 'verifier.fields-invalid', 'verifier')
    }
    if (verifier?.actorRole !== 'independent-machine-inventory-verifier'
        || !isText(verifier?.actorId)
        || verifier?.observationMethod !== 'machine-inventory'
        || verifier?.mode !== 'observe-only'
        || verifier?.readOnly !== true
        || !isHash(verifier?.machineIdentityDigest)
        || !isHash(verifier?.implementationDigest)
        || !isHash(verifier?.packageDigest)
        || verifier?.independent !== true
        || verifier?.rootScheduler !== false) {
        addViolation(violations, 'verifier.not-independent', 'verifier')
    }
    if (inventories.actors?.records?.some(
        (actor) => actor?.actorId === verifier?.actorId
            || (actor?.actorRole === 'root-scheduler'
                && actor?.actorId === verifier?.actorId)
    )) {
        addViolation(
            violations,
            'verifier.run-actor-conflict',
            'verifier',
            verifier?.actorId ?? 'missing'
        )
    }
}

function projectedVerifier(verifier) {
    return Object.fromEntries(
        VERIFIER_FIELDS.map((field) => [field, verifier?.[field]])
    )
}

function dependencyReceiptDigests(sources) {
    return Object.fromEntries(
        Object.keys(sources).sort().map((sourceId) => [
            sourceId,
            sources[sourceId]?.digest ?? null
        ])
    )
}

function verifyExpectedBindings({
    observation,
    receipt,
    expectedBindings,
    now
}) {
    if (expectedBindings?.schema
            !== 'issue-orchestration.quiescence-expected-bindings.v1'
        || !isText(expectedBindings.runId)
        || !Array.isArray(expectedBindings.targetIssueSet)
        || !isHash(expectedBindings.baselineDigest)
        || !isHash(expectedBindings.allowedRetentionDigest)
        || !isHash(expectedBindings.gitInventoryDigest)
        || !isHash(expectedBindings.remoteLiveSnapshotDigest)
        || !isHash(expectedBindings.verifierIdentityDigest)
        || !isHash(expectedBindings.packageDigest)
        || !isHash(expectedBindings.currentObservationDigest)
        || !Number.isSafeInteger(expectedBindings.maxObservationAgeMs)
        || expectedBindings.maxObservationAgeMs < 0
        || !expectedBindings.dependencyReceiptDigests
        || typeof expectedBindings.dependencyReceiptDigests !== 'object'
        || Array.isArray(expectedBindings.dependencyReceiptDigests)
        || !isIsoTimestamp(now)) {
        fail('quiescence-expected-bindings')
    }
    const expectedTargets = [...expectedBindings.targetIssueSet].sort()
    const age = new Date(now).valueOf()
        - new Date(observation.verifiedAt).valueOf()
    const bindingsMatch =
        expectedBindings.runId === receipt.runId
        && JSON.stringify(expectedTargets)
            === JSON.stringify(receipt.targetIssueSet)
        && expectedBindings.baselineDigest === receipt.baselineDigest
        && expectedBindings.allowedRetentionDigest
            === receipt.allowedRetentionDigest
        && expectedBindings.gitInventoryDigest === receipt.gitInventoryDigest
        && expectedBindings.remoteLiveSnapshotDigest
            === receipt.remoteLiveSnapshotDigest
        && expectedBindings.verifierIdentityDigest
            === receipt.verifierIdentityDigest
        && expectedBindings.packageDigest === receipt.verifier.packageDigest
        && expectedBindings.currentObservationDigest
            === receipt.observationDigest
        && computeQuiescenceDigest(
            expectedBindings.dependencyReceiptDigests
        ) === computeQuiescenceDigest(receipt.dependencyReceiptDigests)
        && age >= 0
        && age <= expectedBindings.maxObservationAgeMs
    if (!bindingsMatch) fail('quiescence-receipt-binding-mismatch')
}

function requireObservationBindings(observation) {
    if (observation?.schema !== QUIESCENCE_OBSERVATION_SCHEMA) {
        fail('quiescence-observation-schema')
    }
    if (!isText(observation.runId)) fail('quiescence-run-id')
    if (!Array.isArray(observation.targetIssueSet)
        || observation.targetIssueSet.length === 0
        || observation.targetIssueSet.some((target) => !TARGET.test(target))
        || new Set(observation.targetIssueSet).size !== observation.targetIssueSet.length) {
        fail('quiescence-target-issue-set')
    }
    if (!isIsoTimestamp(observation.verifiedAt)) {
        fail('quiescence-verified-at')
    }
}

/**
 * Evaluate a previously captured inventory snapshot. This pure result is not a
 * completion authorization: callers must verify a quiescent receipt against
 * externally trusted current bindings. This function performs no resource,
 * process, Git, routing, landing, continuation, or decision actions.
 */
export function evaluateQuiescence(input) {
    const observation = clone(input)
    requireObservationBindings(observation)
    observation.targetIssueSet = [...observation.targetIssueSet].sort()

    const violations = []
    const baselineDigest = inspectBaseline(observation.baseline, violations)
    const allowed = inspectAllowedRetention(
        observation.allowedRetention,
        observation.verifiedAt,
        violations
    )
    const sources = inspectSources(observation.sources, violations)
    const { inventories, digests } = inspectInventories(
        observation.inventories,
        sources,
        violations
    )
    inspectRecords(
        inventories,
        allowed.artifactIds,
        {
            runId: observation.runId,
            baselineDigest
        },
        violations
    )
    inspectVerifier(observation.verifier, inventories, violations)
    const completedIssueEvidence = inspectIssueAndStageEvidence({
        targetIssueSet: observation.targetIssueSet,
        inventories,
        violations
    })
    observation.verifier = projectedVerifier(observation.verifier)
    observation.allowedRetention = {
        ...clone(observation.allowedRetention ?? {}),
        artifacts: allowed.artifacts
    }
    observation.sources = sources
    observation.inventories = inventories

    const finalViolations = sortedViolations(violations)
    const bootstrap = inventories.bootstrap?.summary ?? {}
    const quiescent = finalViolations.length === 0
    const receipt = {
        schema: quiescent
            ? QUIESCENCE_RECEIPT_SCHEMA
            : QUIESCENCE_GATE_RESULT_SCHEMA,
        canonicalizationVersion: 'issue-orchestration.canonical-json.v1',
        runId: observation.runId,
        targetIssueSet: observation.targetIssueSet,
        targetIssueSetDigest: computeQuiescenceDigest(
            observation.targetIssueSet
        ),
        verifier: clone(observation.verifier),
        verifierIdentityDigest: computeQuiescenceDigest(
            observation.verifier ?? null
        ),
        completedIssueEvidence,
        observationDigest: computeQuiescenceDigest(observation),
        sourceEvidenceDigest: computeQuiescenceDigest(sources),
        dependencyReceiptDigests: dependencyReceiptDigests(sources),
        baselineDigest,
        allowedRetentionDigest: allowed.digest,
        gitInventoryDigest: digests.git,
        remoteLiveSnapshotDigest:
            inventories.dag?.summary?.remoteSnapshotDigest
            ?? computeQuiescenceDigest({ missing: 'remoteLiveSnapshotDigest' }),
        attemptGroupInventoryDigest: computeQuiescenceDigest({
            attempts: digests.attempts,
            groups: digests.groups,
            actors: digests.actors
        }),
        sliceWorkPlanInventoryDigest: computeQuiescenceDigest({
            slices: digests.slices,
            workPlans: digests.workPlans
        }),
        checkpointContinuationInventoryDigest: computeQuiescenceDigest({
            checkpoints: digests.checkpoints,
            continuations: digests.continuations
        }),
        outputMissingBreakerInventoryDigest: digests.outputMissingBreakers,
        executionRouteInventoryDigest: digests.routes,
        profileCapabilityMismatchInventoryDigest: digests.profileCapabilities,
        processPortDockerInventoryDigests: {
            processTreeDigest: digests.processes,
            portInventoryDigest: digests.ports,
            dockerContainerInventoryDigest: computeQuiescenceDigest({
                domain: 'containers',
                inventoryDigest: digests.docker
            }),
            dockerNetworkInventoryDigest: computeQuiescenceDigest({
                domain: 'networks',
                inventoryDigest: digests.docker
            }),
            dockerVolumeDispositionDigest: computeQuiescenceDigest({
                domain: 'volumes',
                inventoryDigest: digests.docker
            })
        },
        lockLeaseSlotInventoryDigest: computeQuiescenceDigest({
            locks: digests.locks,
            leases: digests.leases,
            slots: digests.slots
        }),
        filesystemInventoryDigest: digests.filesystem,
        resourceInventoryDigest: digests.resources,
        skillInstallDigest: isHash(inventories.skills?.summary?.installDigest)
            ? inventories.skills.summary.installDigest
            : digests.skills,
        skillInventoryDigest: digests.skills,
        roleSkillReceiptDigest:
            inventories.skills?.summary?.roleSkillReceiptDigest
            ?? computeQuiescenceDigest({ missing: 'roleSkillReceiptDigest' }),
        designAuthorityInventoryDigest: computeQuiescenceDigest({
            designAuthoritiesUnique:
                inventories.skills?.summary?.designAuthoritiesUnique,
            secondaryOrchestrationCopyAbsent:
                inventories.skills?.summary?.secondaryOrchestrationCopyAbsent
        }),
        bootstrapDisposition: {
            status: bootstrap.disposition ?? 'unknown',
            fallbackEnabled: bootstrap.fallbackDiscoverable !== false,
            activeStateCount: bootstrap.activeStateCount ?? null,
            activeLockCount: bootstrap.lockCount ?? null,
            activeSlotCount: bootstrap.slotCount ?? null,
            retirementReceiptDigest: bootstrap.retirementReceiptDigest ?? null
        },
        landingInventoryDigest: digests.landing,
        sourceCandidateDispositionDigest: digests.sourceCandidates,
        commitMappingCompletenessDigest: digests.commitMappings,
        humanDecisionInventoryDigest: digests.humanDecisions,
        humanRetentionDigest: digests.humanRetentions,
        dagInventoryDigest: digests.dag,
        stageInventoryDigest: digests.stages,
        telemetryInventoryDigest: digests.telemetry,
        activeActorInventoryDigest: digests.actors,
        groupMemberReceiptCompletenessDigest: computeQuiescenceDigest({
            inventoryDigest: digests.groups,
            missingMemberReceiptCount:
                inventories.groups?.summary?.missingMemberReceiptCount
        }),
        retainedAuditArtifactsDigest: allowed.digest,
        inventoryStateDigest: computeQuiescenceDigest(digests),
        observedInventoryDigests: Object.fromEntries(
            REQUIRED_INVENTORIES.map((category) => [category, digests[category]])
        ),
        violations: finalViolations,
        status: quiescent ? 'quiescent' : 'not-quiescent',
        verifiedAt: observation.verifiedAt
    }
    if (quiescent) {
        receipt.receiptDigest = unsignedDigest(receipt, 'receiptDigest')
    } else {
        receipt.resultDigest = unsignedDigest(receipt, 'resultDigest')
    }
    return deepFreeze(receipt)
}

export function verifyQuiescenceReceipt({
    observation,
    receipt,
    expectedBindings,
    now
}) {
    if (receipt?.status !== 'quiescent') {
        fail('quiescence-receipt-not-quiescent')
    }
    if (receipt?.schema !== QUIESCENCE_RECEIPT_SCHEMA) {
        fail('quiescence-receipt-schema')
    }
    if (!isHash(receipt.receiptDigest)
        || receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest')) {
        fail('quiescence-receipt-digest')
    }
    if ((receipt.status === 'quiescent') !== (
        Array.isArray(receipt.violations) && receipt.violations.length === 0
    )) {
        fail('quiescence-receipt-status')
    }
    const expected = evaluateQuiescence(observation)
    if (computeQuiescenceDigest(receipt)
        !== computeQuiescenceDigest(expected)) {
        fail('quiescence-receipt-replay-mismatch')
    }
    verifyExpectedBindings({
        observation,
        receipt,
        expectedBindings,
        now
    })
    return deepFreeze({
        schema: 'issue-orchestration.quiescence-receipt-verification.v1',
        status: 'valid',
        receiptStatus: 'quiescent',
        completionAuthorized: true,
        receiptDigest: receipt.receiptDigest,
        observationDigest: receipt.observationDigest
    })
}
