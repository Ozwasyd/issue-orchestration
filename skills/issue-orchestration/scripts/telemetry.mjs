import { createHash } from 'node:crypto'

export const NOT_OBSERVED = 'not-observed'

export const TELEMETRY_SCHEMAS = Object.freeze({
    event: 'issue-orchestration.telemetry-event.v2',
    run: 'issue-orchestration.run-summary.v2',
    modelPool: 'issue-orchestration.model-pool-summary.v1',
    acceptanceGroup: 'issue-orchestration.acceptance-group-summary.v1',
    dagUpdate: 'issue-orchestration.dag-update-summary.v1',
    landing: 'issue-orchestration.landing-summary.v1',
    humanDecision: 'issue-orchestration.human-decision-summary.v1',
    sliceExecution: 'issue-orchestration.slice-execution-summary.v1',
    executionShape: 'issue-orchestration.execution-shape-summary.v1',
    checkpointContinuation:
        'issue-orchestration.checkpoint-continuation-summary.v1'
})

const SOURCE_SCHEMA = 'issue-orchestration.telemetry-source-projection.v1'
const DERIVATION_VERSION = 'issue-orchestration.telemetry-derivation.v2'
const SHA256 = /^[a-f0-9]{64}$/u
const SOURCE_SCHEMA_PATTERN = /^issue-orchestration\.[a-z0-9.-]+\.v[1-9][0-9]*$/u
const OUTPUT_SCHEMAS = new Set(Object.values(TELEMETRY_SCHEMAS))

const SOURCE_AUTHORITIES = new Set([
    'event-ledger',
    'dispatch-receipt',
    'dispatch-batch',
    'delivery-epoch',
    'resource-lifecycle',
    'acceptance-group',
    'dag-update-decision',
    'landing',
    'human-decision',
    'stage-work-plan',
    'execution-route'
])

const COMMON_FIELDS = [
    'runId', 'nodeId', 'attemptId', 'role', 'stagePhase', 'timestamp',
    'eventType', 'repository', 'epochId', 'baseSha', 'domain',
    'engineeringRiskClass', 'uiDecisionClass', 'contractState',
    'verificationClass', 'workPlanDigest', 'sliceId', 'sliceDigest',
    'compiledPromptDigest', 'workShape', 'dominantWorkShape',
    'capabilityRequirementDigest', 'routingPolicyVersion',
    'routingInputDigest', 'executionRouteDecisionDigest', 'selectedProfile',
    'requestedModel', 'requestedEffort', 'requestedSandbox',
    'effectiveModel', 'effectiveEffort', 'effectiveSandbox',
    'runtimeMetadataDigest', 'candidateDigest', 'contractDigest',
    'skillDigest', 'baselineDigest', 'contextDigest', 'failureClass',
    'reworkClass', 'outputMissingCause'
]

const TIME_FIELDS = [
    'timestamp', 'queuedAt', 'startedAt', 'completedAt', 'firstArtifactAt',
    'firstWriteAt', 'continuationStartedAt', 'continuationRecoveredAt'
]

const STATE_DIGEST_FIELDS = [
    'gitStateDigest', 'attemptStateDigest', 'sliceStateDigest',
    'checkpointStateDigest', 'breakerStateDigest', 'routeStateDigest',
    'profileStateDigest', 'processStateDigest', 'dockerStateDigest',
    'lockStateDigest', 'filesystemStateDigest', 'installStateDigest',
    'landingStateDigest', 'humanDecisionStateDigest'
]

const DIGEST_FIELDS = new Set([
    'workPlanDigest', 'sliceDigest', 'compiledPromptDigest',
    'capabilityRequirementDigest', 'routingInputDigest',
    'executionRouteDecisionDigest', 'runtimeMetadataDigest',
    'candidateDigest', 'contractDigest', 'skillDigest', 'baselineDigest',
    'contextDigest', 'scopeDigest', 'semanticGraphDigest',
    'runtimeProjectionDigest', 'nodeSemanticDigest', 'objectiveDigest',
    'failingObligationDigest', 'machineFailureSignatureDigest',
    'breakerLineageDigest', 'semanticFailureIdentity',
    'memberWorkPlanDigest', 'sourceTipDigest', ...STATE_DIGEST_FIELDS
])

const DURATION_FIELDS = [
    'wallDuration', 'activeDuration', 'queueDuration',
    'firstArtifactLatency', 'firstWriteLatency',
    'continuationRecoveryLatency', 'resourceRetentionDuration',
    'sourceRetentionDuration', 'sourceRetirementLatency', 'cleanupLatency',
    'slotLeaseWithheldDuration', 'humanWaitDuration',
    'requestQueueDuration', 'candidateGreenLatency',
    'repositoryLandingQueueDuration', 'memberWaitDuration',
    'memberActiveDuration', 'memberWallDuration', 'groupTotalWallDuration',
    'avoidableIdleDuration'
]

const COUNT_FIELDS = [
    'readOnlyOperationsBeforeArtifact', 'noArtifactToolCalls',
    'checkpointCount', 'continuationCount', 'sliceCount',
    'completedSliceCount', 'activeSliceCount', 'sliceChangedFileBudget',
    'actualChangedFiles', 'ownedModuleBudget', 'actualOwnedModules',
    'implementerInternalTestRuns', 'implementerFixCycles',
    'sliceEditTestCycles', 'independentVerificationRuns',
    'independentVerificationRejects', 'postVerificationFixCycles',
    'rootRoundTripsAvoided', 'dagUpdatesAvoidedFromLocalFailures',
    'humanRequestsAvoidedFromOrdinaryFailures', 'landingAttemptCount',
    'sourceCommitCount', 'mappedCommitCount', 'unmappedCommitCount',
    'landingSliceCount', 'multiMemberConflictSliceCount',
    'crossMemberMixedCommitCount',
    'checkpointedConflictResolutionCount',
    'continuationRecoveredConflictCount', 'cleanTransplantCount',
    'alreadyAppliedEquivalentCount', 'contractUniqueConflictCount',
    'humanEscalatedConflictCount', 'conflictedInvalidCount',
    'remoteHeadMovedDuringLandingCount', 'landingRetryCount',
    'fastForwardPushCount', 'forcePushAttemptCount',
    'humanDecisionRequestCount', 'optionCount', 'decisionRecordedCount',
    'decisionInvalidatedCount', 'contextReplayRejectedCount',
    'contractRebaseCount', 'postDecisionCandidateCount',
    'postDecisionVerificationCount', 'coldStarts', 'contextIndexReuse',
    'worktreeReuse', 'installReuse', 'cacheReuse', 'serviceReuse',
    'freshVerifierCount', 'writeLeaseContention',
    'orderedGreenPrefixLength', 'landingHandoffCount',
    'humanPendingCount', 'epochCutoverCount',
    'resourceQuarantinedCount', 'unaffectedOtherRepositoryCount',
    'graphPatchOperationCount', 'attemptOrdinal'
]

const DECIMAL_FIELDS = [
    'slotUtilization', 'observableCost'
]

const SIGNAL_FIELDS = [
    'effectiveMetadataObserved', 'firstArtifactProduced',
    'firstWriteProduced', 'firstPassSliceTerminal', 'candidateGreen',
    'independentRejected', 'uxRejected', 'routeReclassified',
    'capabilityMissing', 'profileCapabilityMismatch', 'silentFallback',
    'singleObjectivePresent', 'firstRequiredActionPresent',
    'firstRequiredActionExecuted', 'firstWritablePathPresent',
    'requiredArtifactManifestPresent', 'explicitNonGoalsPresent',
    'promptCompiledDeterministically', 'rootPromptMutationDetected',
    'checkpointRequired', 'checkpointProduced', 'checkpointVerified',
    'continuationRequired', 'continuationRecovered',
    'continuationRestartedFromBeginning',
    'partialCheckpointPromotedToStageGreen',
    'uncompiledWholeIssueDispatch', 'missingFirstRequiredAction',
    'missingFirstWritablePath',
    'checkpointThresholdExceededWithoutEvidence',
    'sliceIdUsedToBypassBreaker', 'frozenTestTreeMutationDetected',
    'sourceTipMutationDetected', 'oldReceiptReplayDetected',
    'landingWithoutFreshRemoteHead', 'machineInvestigationComplete',
    'uniqueResolutionAvailable', 'recommendationPresent',
    'ordinaryFailureHumanRequestViolation',
    'machineResolvableHumanRequestViolation',
    'missingRequiredHumanRequestViolation', 'unauthorizedHumanRequest',
    'humanDecisionDirectGreenViolation',
    'humanPreferenceRoutingViolation',
    'sliceOrCapabilityHumanRequestViolation',
    'dagUpdaterDispatched', 'baseDriftDetected',
    'resourceContractModified', 'cleanupOverwroteFirstFailure',
    'runtimeEventTriggeredDagUpdater', 'outputMissingMechanicalUpgrade',
    'highRiskSingleFieldForcedTerra', 'groupSummaryMaskedMember',
    'authorityConflictModelDecided',
    'routingUsedFailureCount', 'routingUsedReworkCount',
    'routingUsedBalanceOrSubscription', 'routingUsedTelemetryCost',
    'routingUsedHumanPreference'
]

const ATTRIBUTE_FIELDS = [
    'groupId', 'memberIssueId', 'memberProfile', 'memberStatus',
    'nodeStatus', 'sliceTerminalReceiptStatus', 'resourceState',
    'dagUpdateMode', 'requestTriggerClass', 'requestingAuthorityRole',
    'requestingAuthorityProfile', 'requiredHumanAuthority',
    'safeNoDecisionDisposition', 'postDecisionRerouteProfile',
    'fallbackToSingleIssueReason', 'landingCleanupState',
    'sourceCommitId', 'mappedCommitId', 'reverificationClass',
    'checkpointStatus', 'continuationStatus', 'breakerStatus',
    'routeOutcome'
]

const SAFE_TEXT_FIELDS = new Set([
    ...COMMON_FIELDS.filter((field) => !DIGEST_FIELDS.has(field)),
    ...ATTRIBUTE_FIELDS
])
const ALLOWED_FACT_FIELDS = new Set([
    ...COMMON_FIELDS, ...TIME_FIELDS, ...STATE_DIGEST_FIELDS,
    ...DIGEST_FIELDS, ...DURATION_FIELDS, ...COUNT_FIELDS, ...DECIMAL_FIELDS,
    ...SIGNAL_FIELDS, ...ATTRIBUTE_FIELDS
])

const ENUMS = new Map([
    ['workShape', new Set([
        'atomic-edit', 'bounded-multifile', 'iterative-debug',
        'runtime-probe-heavy', 'context-heavy', 'high-tool-depth',
        'long-horizon-cross-module', 'read-only-adjudication'
    ])],
    ['dominantWorkShape', new Set([
        'atomic-edit', 'bounded-multifile', 'iterative-debug',
        'runtime-probe-heavy', 'context-heavy', 'high-tool-depth',
        'long-horizon-cross-module', 'read-only-adjudication'
    ])],
    ['outputMissingCause', new Set([
        'slice-not-executable', 'compiled-prompt-incomplete',
        'runtime-invocation-failed', 'runtime-capability-missing',
        'sandbox-or-permission-mismatch', 'cwd-or-worktree-mismatch',
        'agent-first-action-not-executed', 'profile-capability-mismatch',
        'unknown-insufficient-evidence'
    ])],
    ['resourceState', new Set([
        'resources-clean', 'candidate-retained', 'quarantined-dirty',
        'cleanup-failed', 'orphan-recovered'
    ])],
    ['dagUpdateMode', new Set([
        'none', 'projection-only', 'semantic-patch', 'full-create',
        'full-recovery'
    ])]
])

const HARD_SIGNAL_CODES = new Map([
    ['uncompiledWholeIssueDispatch', 'telemetry-uncompiled-whole-issue'],
    ['missingFirstRequiredAction', 'telemetry-missing-first-required-action'],
    ['missingFirstWritablePath', 'telemetry-missing-first-writable-path'],
    ['rootPromptMutationDetected', 'telemetry-root-prompt-mutation'],
    ['checkpointThresholdExceededWithoutEvidence',
        'telemetry-checkpoint-threshold-without-evidence'],
    ['continuationRestartedFromBeginning',
        'telemetry-continuation-restarted'],
    ['partialCheckpointPromotedToStageGreen',
        'telemetry-partial-checkpoint-promoted'],
    ['sliceIdUsedToBypassBreaker', 'telemetry-slice-breaker-bypass'],
    ['sourceTipMutationDetected', 'telemetry-source-tip-mutated'],
    ['oldReceiptReplayDetected', 'telemetry-old-receipt-replay'],
    ['landingWithoutFreshRemoteHead',
        'telemetry-landing-without-fresh-remote'],
    ['ordinaryFailureHumanRequestViolation',
        'telemetry-ordinary-failure-human-request'],
    ['machineResolvableHumanRequestViolation',
        'telemetry-machine-resolvable-human-request'],
    ['missingRequiredHumanRequestViolation',
        'telemetry-required-human-request-missing'],
    ['unauthorizedHumanRequest', 'telemetry-unauthorized-human-request'],
    ['humanDecisionDirectGreenViolation',
        'telemetry-human-decision-direct-green'],
    ['humanPreferenceRoutingViolation',
        'telemetry-human-preference-routing'],
    ['sliceOrCapabilityHumanRequestViolation',
        'telemetry-slice-capability-human-request'],
    ['resourceContractModified', 'telemetry-resource-contract-modified'],
    ['cleanupOverwroteFirstFailure',
        'telemetry-cleanup-overwrote-first-failure'],
    ['runtimeEventTriggeredDagUpdater',
        'telemetry-runtime-event-dag-updater'],
    ['outputMissingMechanicalUpgrade',
        'telemetry-output-missing-mechanical-upgrade'],
    ['highRiskSingleFieldForcedTerra',
        'telemetry-high-risk-single-field-terra'],
    ['groupSummaryMaskedMember', 'telemetry-group-member-masked'],
    ['authorityConflictModelDecided',
        'telemetry-authority-conflict-model-decided'],
    ['routingUsedFailureCount', 'telemetry-failure-count-routing'],
    ['routingUsedReworkCount', 'telemetry-rework-count-routing'],
    ['routingUsedBalanceOrSubscription',
        'telemetry-balance-subscription-routing'],
    ['routingUsedTelemetryCost', 'telemetry-cost-routing'],
    ['routingUsedHumanPreference', 'telemetry-human-preference-routing']
])

function fail(code, field = null, sourceDigest = null) {
    const error = new Error(code)
    error.code = code
    if (field !== null) error.field = field
    if (sourceDigest !== null) error.sourceDigest = sourceDigest
    throw error
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function compareText(left, right) {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

export function canonicalTelemetryDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function without(value, field) {
    const copy = structuredClone(value)
    delete copy[field]
    return copy
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function isSafeText(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 256
        && !/[\u0000-\u001f\u007f]/u.test(value)
}

function requireDigest(value, field, sourceDigest = null) {
    if (!SHA256.test(value ?? '')) fail('telemetry-digest-invalid', field,
        sourceDigest)
}

function normalizeTimestamp(value, field, sourceDigest) {
    if (value === undefined) return undefined
    if (typeof value !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
            .test(value)
        || !Number.isFinite(Date.parse(value))) {
        fail('telemetry-timestamp-invalid', field, sourceDigest)
    }
    return new Date(value).toISOString()
}

function normalizeNumber(value, field, sourceDigest, { integer = false } = {}) {
    if (value === undefined) return undefined
    if (!Number.isFinite(value) || value < 0
        || (integer && (!Number.isSafeInteger(value)))) {
        fail(integer ? 'telemetry-count-invalid' : 'telemetry-number-invalid',
            field, sourceDigest)
    }
    return value
}

function deriveDuration(facts, outputField, startField, endField, sourceDigest) {
    const explicit = facts[outputField]
    const start = facts[startField]
    const end = facts[endField]
    if (start === undefined || end === undefined) return explicit
    const derived = Date.parse(end) - Date.parse(start)
    if (!Number.isSafeInteger(derived) || derived < 0) {
        fail('telemetry-duration-order-invalid', outputField, sourceDigest)
    }
    if (explicit !== undefined && explicit !== derived) {
        fail('telemetry-duration-mismatch', outputField, sourceDigest)
    }
    return derived
}

function normalizeFacts(input, sourceAuthority, sourceDigest) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('telemetry-facts-invalid', 'facts', sourceDigest)
    }
    for (const field of Object.keys(input)) {
        if (!ALLOWED_FACT_FIELDS.has(field)) {
            fail('telemetry-private-or-unknown-field', field, sourceDigest)
        }
    }
    const facts = structuredClone(input)
    for (const field of TIME_FIELDS) {
        const normalized = normalizeTimestamp(facts[field], field, sourceDigest)
        if (normalized === undefined) delete facts[field]
        else facts[field] = normalized
    }
    for (const field of DIGEST_FIELDS) {
        if (facts[field] !== undefined) {
            requireDigest(facts[field], field, sourceDigest)
        }
    }
    for (const field of DURATION_FIELDS) {
        const normalized = normalizeNumber(facts[field], field, sourceDigest, {
            integer: true
        })
        if (normalized === undefined) delete facts[field]
        else facts[field] = normalized
    }
    for (const field of COUNT_FIELDS) {
        const normalized = normalizeNumber(facts[field], field, sourceDigest, {
            integer: true
        })
        if (normalized === undefined) delete facts[field]
        else facts[field] = normalized
    }
    for (const field of DECIMAL_FIELDS) {
        const normalized = normalizeNumber(facts[field], field, sourceDigest)
        if (normalized === undefined) delete facts[field]
        else facts[field] = normalized
    }
    if (facts.slotUtilization !== undefined && facts.slotUtilization > 1) {
        fail('telemetry-slot-utilization-invalid', 'slotUtilization',
            sourceDigest)
    }
    for (const field of SIGNAL_FIELDS) {
        if (facts[field] !== undefined && typeof facts[field] !== 'boolean') {
            fail('telemetry-signal-invalid', field, sourceDigest)
        }
    }
    for (const field of SAFE_TEXT_FIELDS) {
        if (facts[field] === undefined) continue
        if (!isSafeText(facts[field])) {
            fail('telemetry-text-invalid', field, sourceDigest)
        }
        const allowed = ENUMS.get(field)
        if (allowed && !allowed.has(facts[field])) {
            fail('telemetry-enum-invalid', field, sourceDigest)
        }
    }
    if (facts.repository !== undefined
        && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(facts.repository)) {
        fail('telemetry-repository-invalid', 'repository', sourceDigest)
    }
    if (facts.baseSha !== undefined
        && !/^[a-f0-9]{40}$/u.test(facts.baseSha)) {
        fail('telemetry-base-sha-invalid', 'baseSha', sourceDigest)
    }

    facts.wallDuration = deriveDuration(
        facts, 'wallDuration', 'startedAt', 'completedAt', sourceDigest
    )
    facts.queueDuration = deriveDuration(
        facts, 'queueDuration', 'queuedAt', 'startedAt', sourceDigest
    )
    facts.firstArtifactLatency = deriveDuration(
        facts, 'firstArtifactLatency', 'startedAt', 'firstArtifactAt',
        sourceDigest
    )
    facts.firstWriteLatency = deriveDuration(
        facts, 'firstWriteLatency', 'startedAt', 'firstWriteAt', sourceDigest
    )
    facts.continuationRecoveryLatency = deriveDuration(
        facts, 'continuationRecoveryLatency', 'continuationStartedAt',
        'continuationRecoveredAt', sourceDigest
    )
    for (const field of DURATION_FIELDS) {
        if (facts[field] === undefined) delete facts[field]
    }

    const effectiveFields = [
        'effectiveModel', 'effectiveEffort', 'effectiveSandbox'
    ]
    if (effectiveFields.some((field) => facts[field] !== undefined)) {
        if (facts.effectiveMetadataObserved !== true) {
            fail('telemetry-effective-metadata-unverified',
                'effectiveMetadataObserved', sourceDigest)
        }
        requireDigest(facts.runtimeMetadataDigest, 'runtimeMetadataDigest',
            sourceDigest)
        if (!['dispatch-receipt', 'execution-route', 'event-ledger']
            .includes(sourceAuthority)) {
            fail('telemetry-effective-metadata-authority',
                'effectiveModel', sourceDigest)
        }
    }
    if (facts.resourceState !== undefined
        && sourceAuthority !== 'resource-lifecycle') {
        fail('telemetry-resource-authority', 'resourceState', sourceDigest)
    }
    return canonical(facts)
}

export function sealVerifiedTelemetrySourceProjection(input) {
    if (!input || typeof input !== 'object') {
        fail('telemetry-source-invalid')
    }
    const {
        sourceKind, sourceAuthority, sourceSchema, sourceDigest,
        verificationEvidenceDigest, facts
    } = input
    if (!['event', 'receipt'].includes(sourceKind)) {
        fail('telemetry-source-kind-invalid')
    }
    if (!SOURCE_AUTHORITIES.has(sourceAuthority)) {
        fail('telemetry-source-authority-invalid')
    }
    if (!SOURCE_SCHEMA_PATTERN.test(sourceSchema ?? '')
        || OUTPUT_SCHEMAS.has(sourceSchema)
        || sourceSchema === SOURCE_SCHEMA) {
        fail('telemetry-source-schema-invalid')
    }
    requireDigest(sourceDigest, 'sourceDigest')
    requireDigest(verificationEvidenceDigest, 'verificationEvidenceDigest',
        sourceDigest)
    const normalizedFacts = normalizeFacts(
        facts, sourceAuthority, sourceDigest
    )
    const source = {
        schema: SOURCE_SCHEMA,
        sourceKind,
        sourceAuthority,
        sourceSchema,
        sourceDigest,
        integrityStatus: 'verified',
        verificationEvidenceDigest,
        facts: normalizedFacts,
        factsDigest: canonicalTelemetryDigest(normalizedFacts)
    }
    source.sourceProjectionDigest = canonicalTelemetryDigest(source)
    return deepFreeze(source)
}

export function validateTelemetrySourceProjection(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        fail('telemetry-source-invalid')
    }
    const required = [
        'schema', 'sourceKind', 'sourceAuthority', 'sourceSchema',
        'sourceDigest', 'integrityStatus', 'verificationEvidenceDigest',
        'facts', 'factsDigest', 'sourceProjectionDigest'
    ]
    if (Object.keys(source).length !== required.length
        || required.some((field) => !Object.hasOwn(source, field))) {
        fail('telemetry-source-shape-invalid', null, source.sourceDigest)
    }
    if (source.schema !== SOURCE_SCHEMA
        || source.integrityStatus !== 'verified') {
        fail('telemetry-source-not-verified', null, source.sourceDigest)
    }
    if (!['event', 'receipt'].includes(source.sourceKind)
        || !SOURCE_AUTHORITIES.has(source.sourceAuthority)
        || !SOURCE_SCHEMA_PATTERN.test(source.sourceSchema ?? '')
        || OUTPUT_SCHEMAS.has(source.sourceSchema)
        || source.sourceSchema === SOURCE_SCHEMA) {
        fail('telemetry-source-schema-invalid', null, source.sourceDigest)
    }
    requireDigest(source.sourceDigest, 'sourceDigest', source.sourceDigest)
    requireDigest(source.verificationEvidenceDigest,
        'verificationEvidenceDigest', source.sourceDigest)
    const normalizedFacts = normalizeFacts(
        source.facts, source.sourceAuthority, source.sourceDigest
    )
    if (source.factsDigest !== canonicalTelemetryDigest(normalizedFacts)) {
        fail('telemetry-facts-digest-mismatch', 'factsDigest',
            source.sourceDigest)
    }
    if (source.sourceProjectionDigest
        !== canonicalTelemetryDigest(without(source, 'sourceProjectionDigest'))) {
        fail('telemetry-source-projection-digest-mismatch',
            'sourceProjectionDigest', source.sourceDigest)
    }
    return source
}

function observed(value) {
    return value === undefined ? NOT_OBSERVED : value
}

function semanticFailureIdentity(facts) {
    const failurePresent = facts.failureClass !== undefined
        || facts.outputMissingCause !== undefined
        || facts.reworkClass !== undefined
    if (!failurePresent) {
        if (facts.semanticFailureIdentity !== undefined) {
            fail('telemetry-semantic-failure-identity-without-failure',
                'semanticFailureIdentity')
        }
        return NOT_OBSERVED
    }
    const required = [
        'repository', 'nodeSemanticDigest', 'stagePhase', 'objectiveDigest',
        'contractDigest', 'failingObligationDigest',
        'machineFailureSignatureDigest', 'capabilityRequirementDigest'
    ]
    if (required.some((field) => facts[field] === undefined)) {
        return NOT_OBSERVED
    }
    const identity = canonicalTelemetryDigest({
        repository: facts.repository,
        nodeSemanticDigest: facts.nodeSemanticDigest,
        stagePhase: facts.stagePhase,
        objectiveDigest: facts.objectiveDigest,
        contractDigest: facts.contractDigest,
        failingObligationDigest: facts.failingObligationDigest,
        machineFailureSignatureDigest: facts.machineFailureSignatureDigest,
        failureClass: facts.failureClass ?? NOT_OBSERVED,
        outputMissingCause: facts.outputMissingCause ?? NOT_OBSERVED,
        capabilityRequirementDigest: facts.capabilityRequirementDigest
    })
    if (facts.semanticFailureIdentity !== undefined
        && facts.semanticFailureIdentity !== identity) {
        fail('telemetry-semantic-failure-identity-mismatch',
            'semanticFailureIdentity')
    }
    return identity
}

function deriveTelemetryEvent(source) {
    const facts = source.facts
    const event = {
        schema: TELEMETRY_SCHEMAS.event,
        derivationVersion: DERIVATION_VERSION,
        telemetryEventId: canonicalTelemetryDigest({
            derivationVersion: DERIVATION_VERSION,
            sourceDigest: source.sourceDigest,
            factsDigest: source.factsDigest
        }),
        sourceKind: source.sourceKind,
        sourceAuthority: source.sourceAuthority,
        sourceSchema: source.sourceSchema,
        sourceEventDigest: source.sourceKind === 'event'
            ? source.sourceDigest : NOT_OBSERVED,
        sourceReceiptDigest: source.sourceKind === 'receipt'
            ? source.sourceDigest : NOT_OBSERVED,
        sourceVerificationDigest: source.verificationEvidenceDigest,
        ...Object.fromEntries(COMMON_FIELDS.map((field) => [
            field, observed(facts[field])
        ])),
        semanticFailureIdentity: semanticFailureIdentity(facts),
        stateDigests: Object.fromEntries(STATE_DIGEST_FIELDS.map((field) => [
            field, observed(facts[field])
        ])),
        measurements: Object.fromEntries([
            ...DURATION_FIELDS, ...COUNT_FIELDS, ...DECIMAL_FIELDS
        ].map((field) => [field, observed(facts[field])])),
        signals: Object.fromEntries(SIGNAL_FIELDS.map((field) => [
            field, observed(facts[field])
        ])),
        attributes: Object.fromEntries(ATTRIBUTE_FIELDS.map((field) => [
            field, observed(facts[field])
        ]))
    }
    event.telemetryEventDigest = canonicalTelemetryDigest(event)
    return event
}

function stableUniqueSources(sources) {
    if (!Array.isArray(sources)) fail('telemetry-sources-invalid')
    const byDigest = new Map()
    for (const source of sources) {
        validateTelemetrySourceProjection(source)
        const previous = byDigest.get(source.sourceDigest)
        if (previous
            && previous.sourceProjectionDigest !== source.sourceProjectionDigest) {
            fail('telemetry-source-digest-conflict', null, source.sourceDigest)
        }
        byDigest.set(source.sourceDigest, source)
    }
    return [...byDigest.values()]
        .sort((left, right) => compareText(
            left.sourceDigest, right.sourceDigest
        ))
}

function measurement(event, field) {
    const value = event.measurements[field]
    return typeof value === 'number' ? value : undefined
}

function signal(event, field) {
    const value = event.signals[field]
    return typeof value === 'boolean' ? value : undefined
}

function attribute(event, field) {
    const value = event.attributes[field]
    return value === NOT_OBSERVED ? undefined : value
}

function topLevel(event, field) {
    const value = event[field]
    return value === NOT_OBSERVED ? undefined : value
}

function distribution(values) {
    const observedValues = values
        .filter((value) => typeof value === 'number' && Number.isFinite(value))
        .toSorted((left, right) => left - right)
    if (observedValues.length === 0) {
        return {
            observedCount: 0,
            notObservedCount: values.length,
            median: NOT_OBSERVED,
            p95: NOT_OBSERVED
        }
    }
    const middle = Math.floor(observedValues.length / 2)
    const median = observedValues.length % 2 === 0
        ? (observedValues[middle - 1] + observedValues[middle]) / 2
        : observedValues[middle]
    const p95Index = Math.max(
        0, Math.ceil(observedValues.length * 0.95) - 1
    )
    return {
        observedCount: observedValues.length,
        notObservedCount: values.length - observedValues.length,
        median,
        p95: observedValues[p95Index]
    }
}

function rate(values) {
    const observedValues = values.filter((value) => typeof value === 'boolean')
    if (observedValues.length === 0) {
        return {
            numerator: NOT_OBSERVED,
            denominator: 0,
            rate: NOT_OBSERVED,
            notObservedCount: values.length
        }
    }
    const numerator = observedValues.filter(Boolean).length
    return {
        numerator,
        denominator: observedValues.length,
        rate: numerator / observedValues.length,
        notObservedCount: values.length - observedValues.length
    }
}

function countBy(values) {
    const counts = new Map()
    for (const value of values) {
        if (value === undefined || value === NOT_OBSERVED) continue
        counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return Object.fromEntries([...counts.entries()]
        .sort(([left], [right]) => compareText(left, right)))
}

function sumMeasurements(events, field) {
    const values = events.map((event) => measurement(event, field))
        .filter((value) => value !== undefined)
    return values.length === 0
        ? NOT_OBSERVED
        : values.reduce((sum, value) => sum + value, 0)
}

function uniqueCount(events, field) {
    const values = events.map((event) => topLevel(event, field))
        .filter((value) => value !== undefined)
    return new Set(values).size
}

function sourceEnvelope(schema, events, body) {
    const sourceDigests = events.map((event) =>
        event.sourceEventDigest !== NOT_OBSERVED
            ? event.sourceEventDigest
            : event.sourceReceiptDigest
    ).toSorted(compareText)
    const timestamps = events.map((event) => topLevel(event, 'timestamp'))
        .filter(Boolean).toSorted(compareText)
    const summary = {
        schema,
        derivationVersion: DERIVATION_VERSION,
        sourceCount: sourceDigests.length,
        sourceDigests,
        sourceSetDigest: canonicalTelemetryDigest(sourceDigests),
        observedFrom: timestamps[0] ?? NOT_OBSERVED,
        observedUntil: timestamps.at(-1) ?? NOT_OBSERVED,
        ...body
    }
    summary.summaryDigest = canonicalTelemetryDigest(summary)
    return summary
}

function groupEvents(events, dimensions) {
    const groups = new Map()
    for (const event of events) {
        const dimension = Object.fromEntries(dimensions.map((field) => [
            field, topLevel(event, field) ?? attribute(event, field)
                ?? NOT_OBSERVED
        ]))
        const key = JSON.stringify(canonical(dimension))
        const group = groups.get(key) ?? { dimension, events: [] }
        group.events.push(event)
        groups.set(key, group)
    }
    return [...groups.values()].sort((left, right) =>
        compareText(
            JSON.stringify(canonical(left.dimension)),
            JSON.stringify(canonical(right.dimension))
        ))
}

function performanceCell(group) {
    const events = group.events
    return {
        ...group.dimension,
        attemptCount: uniqueCount(events, 'attemptId'),
        sliceCount: uniqueCount(events, 'sliceDigest'),
        firstArtifactRate: rate(events.map((event) =>
            signal(event, 'firstArtifactProduced'))),
        firstWriteRate: rate(events.map((event) =>
            signal(event, 'firstWriteProduced'))),
        firstPassSliceTerminalRate: rate(events.map((event) =>
            signal(event, 'firstPassSliceTerminal'))),
        candidateGreenRate: rate(events.map((event) =>
            signal(event, 'candidateGreen'))),
        independentRejectCount: events.filter((event) =>
            signal(event, 'independentRejected') === true).length,
        uxRejectCount: events.filter((event) =>
            signal(event, 'uxRejected') === true).length,
        routeReclassificationCount: events.filter((event) =>
            signal(event, 'routeReclassified') === true).length,
        queueDuration: distribution(events.map((event) =>
            measurement(event, 'queueDuration'))),
        activeDuration: distribution(events.map((event) =>
            measurement(event, 'activeDuration'))),
        wallDuration: distribution(events.map((event) =>
            measurement(event, 'wallDuration'))),
        firstArtifactLatency: distribution(events.map((event) =>
            measurement(event, 'firstArtifactLatency'))),
        checkpointCount: sumMeasurements(events, 'checkpointCount'),
        continuationSuccessRate: rate(events.map((event) => {
            if (signal(event, 'continuationRequired') !== true) return undefined
            return signal(event, 'continuationRecovered') === true
        })),
        capabilityMissingCount: events.filter((event) =>
            signal(event, 'capabilityMissing') === true).length,
        profileCapabilityMismatchCount: events.filter((event) =>
            signal(event, 'profileCapabilityMismatch') === true).length,
        silentFallbackCount: events.filter((event) =>
            signal(event, 'silentFallback') === true).length,
        observableCost: sumMeasurements(events, 'observableCost')
    }
}

function modelPoolSummary(events) {
    const candidates = events.filter((event) =>
        topLevel(event, 'role') !== undefined
        || topLevel(event, 'selectedProfile') !== undefined
        || topLevel(event, 'workShape') !== undefined)
    const dimensions = [
        'role', 'selectedProfile', 'engineeringRiskClass', 'uiDecisionClass',
        'workShape'
    ]
    const cells = groupEvents(candidates, dimensions).map(performanceCell)
    return sourceEnvelope(TELEMETRY_SCHEMAS.modelPool, candidates, { cells })
}

function executionShapeSummary(events) {
    const candidates = events.filter((event) =>
        topLevel(event, 'workShape') !== undefined)
    const cells = groupEvents(candidates, [
        'workShape', 'selectedProfile', 'role'
    ]).map(performanceCell)
    return sourceEnvelope(
        TELEMETRY_SCHEMAS.executionShape, candidates, { cells }
    )
}

function acceptanceGroupSummary(events) {
    const candidates = events.filter((event) =>
        attribute(event, 'groupId') !== undefined)
    const groups = groupEvents(candidates, ['groupId']).map((group) => {
        const members = groupEvents(group.events, [
            'memberIssueId', 'memberProfile'
        ]).map((member) => ({
            ...member.dimension,
            attemptCount: uniqueCount(member.events, 'attemptId'),
            sliceCount: uniqueCount(member.events, 'sliceDigest'),
            workShapeCounts: countBy(member.events.map((event) =>
                topLevel(event, 'workShape'))),
            statusCounts: countBy(member.events.map((event) =>
                attribute(event, 'memberStatus'))),
            waitDuration: distribution(member.events.map((event) =>
                measurement(event, 'memberWaitDuration'))),
            activeDuration: distribution(member.events.map((event) =>
                measurement(event, 'memberActiveDuration'))),
            wallDuration: distribution(member.events.map((event) =>
                measurement(event, 'memberWallDuration'))),
            firstArtifactLatency: distribution(member.events.map((event) =>
                measurement(event, 'firstArtifactLatency'))),
            checkpointCount: sumMeasurements(member.events, 'checkpointCount'),
            continuationCount:
                sumMeasurements(member.events, 'continuationCount'),
            humanPendingCount:
                sumMeasurements(member.events, 'humanPendingCount')
        }))
        return {
            ...group.dimension,
            members,
            groupTotalWallDuration: distribution(group.events.map((event) =>
                measurement(event, 'groupTotalWallDuration'))),
            coldStarts: sumMeasurements(group.events, 'coldStarts'),
            contextIndexReuse: sumMeasurements(
                group.events, 'contextIndexReuse'
            ),
            worktreeReuse: sumMeasurements(group.events, 'worktreeReuse'),
            installReuse: sumMeasurements(group.events, 'installReuse'),
            cacheReuse: sumMeasurements(group.events, 'cacheReuse'),
            serviceReuse: sumMeasurements(group.events, 'serviceReuse'),
            freshVerifierCount:
                sumMeasurements(group.events, 'freshVerifierCount'),
            writeLeaseContention:
                sumMeasurements(group.events, 'writeLeaseContention'),
            orderedGreenPrefixLength:
                sumMeasurements(group.events, 'orderedGreenPrefixLength'),
            landingHandoffCount:
                sumMeasurements(group.events, 'landingHandoffCount'),
            humanPendingCount:
                sumMeasurements(group.events, 'humanPendingCount'),
            fallbackReasons: countBy(group.events.map((event) =>
                attribute(event, 'fallbackToSingleIssueReason')))
        }
    })
    return sourceEnvelope(
        TELEMETRY_SCHEMAS.acceptanceGroup, candidates, { groups }
    )
}

function dagUpdateSummary(events) {
    const candidates = events.filter((event) =>
        event.sourceAuthority === 'dag-update-decision'
        || attribute(event, 'dagUpdateMode') !== undefined)
    return sourceEnvelope(TELEMETRY_SCHEMAS.dagUpdate, candidates, {
        modeCounts: countBy(candidates.map((event) =>
            attribute(event, 'dagUpdateMode'))),
        graphPatchOperationCount:
            sumMeasurements(candidates, 'graphPatchOperationCount'),
        falsePositiveDagDispatchCount: 0
    })
}

function landingSummary(events) {
    const candidates = events.filter((event) =>
        ['landing', 'delivery-epoch'].includes(event.sourceAuthority))
    const countNames = [
        'landingAttemptCount', 'sourceCommitCount', 'mappedCommitCount',
        'unmappedCommitCount', 'landingSliceCount',
        'multiMemberConflictSliceCount', 'crossMemberMixedCommitCount',
        'checkpointedConflictResolutionCount',
        'continuationRecoveredConflictCount', 'cleanTransplantCount',
        'alreadyAppliedEquivalentCount', 'contractUniqueConflictCount',
        'humanEscalatedConflictCount', 'conflictedInvalidCount',
        'remoteHeadMovedDuringLandingCount', 'landingRetryCount',
        'fastForwardPushCount', 'forcePushAttemptCount'
    ]
    const commitMappings = candidates.map((event) => ({
        sourceCommitId:
            attribute(event, 'sourceCommitId') ?? NOT_OBSERVED,
        mappedCommitId:
            attribute(event, 'mappedCommitId') ?? NOT_OBSERVED,
        sliceId: topLevel(event, 'sliceId') ?? NOT_OBSERVED,
        sliceDigest: topLevel(event, 'sliceDigest') ?? NOT_OBSERVED,
        reverificationClass:
            attribute(event, 'reverificationClass') ?? NOT_OBSERVED,
        sourceReceiptDigest: event.sourceReceiptDigest
    })).filter(({ sourceCommitId, mappedCommitId }) =>
        sourceCommitId !== NOT_OBSERVED || mappedCommitId !== NOT_OBSERVED
    ).toSorted((left, right) => compareText(
        JSON.stringify(canonical(left)),
        JSON.stringify(canonical(right))
    ))
    return sourceEnvelope(TELEMETRY_SCHEMAS.landing, candidates, {
        counts: Object.fromEntries(countNames.map((field) => [
            field, sumMeasurements(candidates, field)
        ])),
        commitMappings,
        repositoryLandingQueueDuration: distribution(candidates.map((event) =>
            measurement(event, 'repositoryLandingQueueDuration'))),
        sourceRetentionDuration: distribution(candidates.map((event) =>
            measurement(event, 'sourceRetentionDuration'))),
        sourceRetirementLatency: distribution(candidates.map((event) =>
            measurement(event, 'sourceRetirementLatency'))),
        reverificationClassCounts: countBy(candidates.map((event) =>
            attribute(event, 'reverificationClass'))),
        cleanupStateCounts: countBy(candidates.map((event) =>
            attribute(event, 'landingCleanupState'))),
        hardViolationCounts: {
            sourceTipMutationDetected: 0,
            unmappedCommitCount: 0,
            crossMemberMixedCommitCount: 0,
            multiMemberConflictSliceCount: 0,
            oldReceiptReplayDetected: 0,
            forcePushAttemptCount: 0,
            landingWithoutFreshRemoteHead: 0
        }
    })
}

function humanDecisionSummary(events) {
    const candidates = events.filter((event) =>
        event.sourceAuthority === 'human-decision')
    const countNames = [
        'humanDecisionRequestCount', 'decisionRecordedCount',
        'decisionInvalidatedCount', 'contextReplayRejectedCount',
        'contractRebaseCount', 'postDecisionCandidateCount',
        'postDecisionVerificationCount'
    ]
    return sourceEnvelope(TELEMETRY_SCHEMAS.humanDecision, candidates, {
        counts: Object.fromEntries(countNames.map((field) => [
            field, sumMeasurements(candidates, field)
        ])),
        triggerClassCounts: countBy(candidates.map((event) =>
            attribute(event, 'requestTriggerClass'))),
        requestingRoleCounts: countBy(candidates.map((event) =>
            attribute(event, 'requestingAuthorityRole'))),
        requiredAuthorityCounts: countBy(candidates.map((event) =>
            attribute(event, 'requiredHumanAuthority'))),
        postDecisionRerouteProfileCounts: countBy(candidates.map((event) =>
            attribute(event, 'postDecisionRerouteProfile'))),
        requestQueueDuration: distribution(candidates.map((event) =>
            measurement(event, 'requestQueueDuration'))),
        humanWaitDuration: distribution(candidates.map((event) =>
            measurement(event, 'humanWaitDuration'))),
        resourceRetentionDuration: distribution(candidates.map((event) =>
            measurement(event, 'resourceRetentionDuration'))),
        hardViolationCounts: {
            ordinaryFailureHumanRequestViolationCount: 0,
            machineResolvableHumanRequestViolationCount: 0,
            missingRequiredHumanRequestViolationCount: 0,
            unauthorizedHumanRequestCount: 0,
            humanDecisionDirectGreenViolationCount: 0,
            humanPreferenceRoutingViolationCount: 0,
            sliceOrCapabilityHumanRequestViolationCount: 0
        }
    })
}

function sliceExecutionSummary(events) {
    const candidates = events.filter((event) =>
        event.sourceAuthority === 'stage-work-plan'
        || topLevel(event, 'workPlanDigest') !== undefined
        || topLevel(event, 'sliceDigest') !== undefined)
    const signalNames = [
        'singleObjectivePresent', 'firstRequiredActionPresent',
        'firstRequiredActionExecuted', 'firstWritablePathPresent',
        'requiredArtifactManifestPresent', 'explicitNonGoalsPresent',
        'promptCompiledDeterministically', 'firstArtifactProduced',
        'firstWriteProduced', 'checkpointRequired', 'checkpointProduced',
        'checkpointVerified', 'continuationRequired',
        'continuationRecovered'
    ]
    return sourceEnvelope(TELEMETRY_SCHEMAS.sliceExecution, candidates, {
        workPlanCount: uniqueCount(candidates, 'workPlanDigest'),
        sliceCount: uniqueCount(candidates, 'sliceDigest'),
        signalRates: Object.fromEntries(signalNames.map((field) => [
            field, rate(candidates.map((event) => signal(event, field)))
        ])),
        changedFileBudget: distribution(candidates.map((event) =>
            measurement(event, 'sliceChangedFileBudget'))),
        actualChangedFiles: distribution(candidates.map((event) =>
            measurement(event, 'actualChangedFiles'))),
        ownedModuleBudget: distribution(candidates.map((event) =>
            measurement(event, 'ownedModuleBudget'))),
        actualOwnedModules: distribution(candidates.map((event) =>
            measurement(event, 'actualOwnedModules'))),
        firstArtifactLatency: distribution(candidates.map((event) =>
            measurement(event, 'firstArtifactLatency'))),
        firstWriteLatency: distribution(candidates.map((event) =>
            measurement(event, 'firstWriteLatency'))),
        outputMissingCauseCounts: countBy(candidates.map((event) =>
            topLevel(event, 'outputMissingCause'))),
        hardViolationCounts: {
            uncompiledWholeIssueDispatch: 0,
            missingFirstRequiredAction: 0,
            missingFirstWritablePath: 0,
            rootPromptMutationDetected: 0,
            checkpointThresholdExceededWithoutEvidence: 0,
            continuationRestartedFromBeginning: 0,
            partialCheckpointPromotedToStageGreen: 0,
            sliceIdUsedToBypassBreaker: 0
        }
    })
}

function checkpointContinuationSummary(events) {
    const candidates = events.filter((event) =>
        signal(event, 'checkpointRequired') !== undefined
        || signal(event, 'continuationRequired') !== undefined
        || measurement(event, 'checkpointCount') !== undefined
        || measurement(event, 'continuationCount') !== undefined)
    return sourceEnvelope(
        TELEMETRY_SCHEMAS.checkpointContinuation,
        candidates,
        {
            checkpointCount: sumMeasurements(candidates, 'checkpointCount'),
            continuationCount:
                sumMeasurements(candidates, 'continuationCount'),
            checkpointProducedRate: rate(candidates.map((event) => {
                if (signal(event, 'checkpointRequired') !== true) {
                    return undefined
                }
                return signal(event, 'checkpointProduced') === true
            })),
            checkpointVerifiedRate: rate(candidates.map((event) => {
                if (signal(event, 'checkpointProduced') !== true) {
                    return undefined
                }
                return signal(event, 'checkpointVerified') === true
            })),
            continuationRecoveryRate: rate(candidates.map((event) => {
                if (signal(event, 'continuationRequired') !== true) {
                    return undefined
                }
                return signal(event, 'continuationRecovered') === true
            })),
            continuationRecoveryLatency: distribution(candidates.map(
                (event) => measurement(event, 'continuationRecoveryLatency')
            )),
            continuationRestartedFromBeginningCount: 0,
            partialCheckpointPromotedToStageGreenCount: 0
        }
    )
}

function latestStateDigests(events) {
    const ordered = events.toSorted((left, right) => {
        const leftObserved = left.timestamp !== NOT_OBSERVED
        const rightObserved = right.timestamp !== NOT_OBSERVED
        if (leftObserved !== rightObserved) return leftObserved ? 1 : -1
        const timeComparison = compareText(
            String(left.timestamp), String(right.timestamp)
        )
        if (timeComparison !== 0) return timeComparison
        return compareText(
            left.telemetryEventDigest, right.telemetryEventDigest
        )
    })
    return Object.fromEntries(STATE_DIGEST_FIELDS.map((field) => {
        const value = ordered.map((event) => event.stateDigests[field])
            .filter((candidate) => candidate !== NOT_OBSERVED).at(-1)
        return [field, value ?? NOT_OBSERVED]
    }))
}

function failureGroups(events) {
    const failures = events.filter((event) =>
        event.failureClass !== NOT_OBSERVED
        || event.outputMissingCause !== NOT_OBSERVED
        || event.reworkClass !== NOT_OBSERVED)
    const groups = new Map()
    let insufficientIdentityCount = 0
    for (const event of failures) {
        if (event.semanticFailureIdentity === NOT_OBSERVED) {
            insufficientIdentityCount += 1
            continue
        }
        const current = groups.get(event.semanticFailureIdentity) ?? []
        current.push(event)
        groups.set(event.semanticFailureIdentity, current)
    }
    const semanticFailures = [...groups.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([identity, occurrences]) => ({
            semanticFailureIdentity: identity,
            occurrenceCount: occurrences.length,
            distinctAttemptCount: new Set(occurrences.map((event) =>
                event.attemptId).filter((value) =>
                value !== NOT_OBSERVED)).size,
            distinctSliceCount: new Set(occurrences.map((event) =>
                event.sliceId).filter((value) =>
                value !== NOT_OBSERVED)).size,
            sourceDigests: occurrences.map((event) =>
                event.sourceEventDigest !== NOT_OBSERVED
                    ? event.sourceEventDigest
                    : event.sourceReceiptDigest
            ).toSorted(compareText)
        }))
    return {
        semanticFailures,
        uniqueFailureCount: semanticFailures.length,
        duplicateOccurrenceCount: semanticFailures.reduce(
            (sum, failure) => sum + Math.max(0, failure.occurrenceCount - 1),
            0
        ),
        insufficientIdentityCount
    }
}

function runSummary(events, componentSummaries) {
    const statusCounts = countBy(events.map((event) =>
        attribute(event, 'nodeStatus')))
    const resourceEvents = events.filter((event) =>
        event.sourceAuthority === 'resource-lifecycle')
    return sourceEnvelope(TELEMETRY_SCHEMAS.run, events, {
        runIds: [...new Set(events.map((event) => event.runId)
            .filter((value) => value !== NOT_OBSERVED))].toSorted(compareText),
        nodeStatusCounts: statusCounts,
        completedCount: statusCounts.completed ?? statusCounts.closed ?? 0,
        terminalCount: statusCounts.terminal ?? 0,
        blockedCount: statusCounts.blocked ?? 0,
        activeCount: statusCounts.active ?? 0,
        attemptCount: uniqueCount(events, 'attemptId'),
        failureClassCounts: countBy(events.map((event) =>
            topLevel(event, 'failureClass'))),
        reworkClassCounts: countBy(events.map((event) =>
            topLevel(event, 'reworkClass'))),
        outputMissingCauseCounts: countBy(events.map((event) =>
            topLevel(event, 'outputMissingCause'))),
        resourceStateCounts: countBy(resourceEvents.map((event) =>
            attribute(event, 'resourceState'))),
        wallDuration: distribution(events.map((event) =>
            measurement(event, 'wallDuration'))),
        queueDuration: distribution(events.map((event) =>
            measurement(event, 'queueDuration'))),
        activeDuration: distribution(events.map((event) =>
            measurement(event, 'activeDuration'))),
        slotUtilization: distribution(events.map((event) =>
            measurement(event, 'slotUtilization'))),
        avoidableIdleDuration: distribution(events.map((event) =>
            measurement(event, 'avoidableIdleDuration'))),
        stateDigests: latestStateDigests(events),
        failures: failureGroups(events),
        componentSummaryDigests: Object.fromEntries(
            Object.entries(componentSummaries).map(([name, summary]) => [
                name, summary.summaryDigest
            ]).sort(([left], [right]) => compareText(left, right))
        ),
        falsePositiveDagDispatchCount:
            componentSummaries.dagUpdate.falsePositiveDagDispatchCount
    })
}

function enforceHardViolations(events) {
    for (const event of events) {
        for (const [field, code] of HARD_SIGNAL_CODES) {
            if (signal(event, field) === true) fail(
                code, field,
                event.sourceEventDigest !== NOT_OBSERVED
                    ? event.sourceEventDigest : event.sourceReceiptDigest
            )
        }
        const mode = attribute(event, 'dagUpdateMode')
        if (signal(event, 'dagUpdaterDispatched') === true
            && event.sourceAuthority !== 'dag-update-decision') {
            fail(
                'telemetry-runtime-event-dag-updater',
                'dagUpdaterDispatched',
                event.sourceEventDigest !== NOT_OBSERVED
                    ? event.sourceEventDigest : event.sourceReceiptDigest
            )
        }
        if (['none', 'projection-only'].includes(mode)
            && signal(event, 'dagUpdaterDispatched') === true) {
            fail('telemetry-false-positive-dag-dispatch', 'dagUpdateMode')
        }
        for (const field of [
            'unmappedCommitCount', 'crossMemberMixedCommitCount',
            'multiMemberConflictSliceCount', 'forcePushAttemptCount'
        ]) {
            if ((measurement(event, field) ?? 0) > 0) {
                fail(`telemetry-${field.replaceAll(
                    /[A-Z]/gu, (match) => `-${match.toLowerCase()}`
                )}`, field)
            }
        }
    }
}

export function compileTelemetryBundle(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((field) => field !== 'sources')) {
        fail('telemetry-compiler-input-invalid')
    }
    const { sources } = input
    const verifiedSources = stableUniqueSources(sources)
    const events = verifiedSources.map(deriveTelemetryEvent)
        .sort((left, right) => compareText(
            left.telemetryEventDigest, right.telemetryEventDigest
        ))
    enforceHardViolations(events)
    const componentSummaries = {
        modelPool: modelPoolSummary(events),
        acceptanceGroup: acceptanceGroupSummary(events),
        dagUpdate: dagUpdateSummary(events),
        landing: landingSummary(events),
        humanDecision: humanDecisionSummary(events),
        sliceExecution: sliceExecutionSummary(events),
        executionShape: executionShapeSummary(events),
        checkpointContinuation: checkpointContinuationSummary(events)
    }
    const bundle = {
        events,
        runSummary: runSummary(events, componentSummaries),
        modelPoolSummary: componentSummaries.modelPool,
        acceptanceGroupSummary: componentSummaries.acceptanceGroup,
        dagUpdateSummary: componentSummaries.dagUpdate,
        landingSummary: componentSummaries.landing,
        humanDecisionSummary: componentSummaries.humanDecision,
        sliceExecutionSummary: componentSummaries.sliceExecution,
        executionShapeSummary: componentSummaries.executionShape,
        checkpointContinuationSummary:
            componentSummaries.checkpointContinuation
    }
    return deepFreeze(bundle)
}

export function validateTelemetryDocument(document) {
    if (!document || typeof document !== 'object'
        || !OUTPUT_SCHEMAS.has(document.schema)) {
        fail('telemetry-document-schema-invalid')
    }
    if (document.schema === TELEMETRY_SCHEMAS.event) {
        if (document.telemetryEventDigest
            !== canonicalTelemetryDigest(without(
                document, 'telemetryEventDigest'
            ))) {
            fail('telemetry-event-digest-mismatch')
        }
        return document
    }
    if (document.summaryDigest
        !== canonicalTelemetryDigest(without(document, 'summaryDigest'))) {
        fail('telemetry-summary-digest-mismatch')
    }
    return document
}
