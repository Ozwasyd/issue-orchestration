import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createResourceRegistry } from './resource-lifecycle.mjs'
import { validateStateRoot } from './validate-state-root.mjs'

const HASH = /^[a-f0-9]{64}$/u
const GIT_DIGEST = /^[a-f0-9]{40,64}$/u
const SHA = /^[a-f0-9]{40}$/u
const WRITER_PHASES = new Set([
    'test-contract',
    'implementation',
    'ui-implementation',
    'documentation',
    'landing-conflict-resolution'
])
const WRITER_ROLES_BY_PHASE = Object.freeze({
    'test-contract': new Set(['test-owner']),
    'implementation': new Set(['code-implementer']),
    'ui-implementation': new Set(['ui-ux-implementer']),
    'documentation': new Set(['documentation-writer']),
    'landing-conflict-resolution': new Set([
        'code-implementer',
        'ui-ux-implementer'
    ])
})
const WHOLE_ISSUE = /(?:depends on:|(?:complete|implement|address|satisfy) (?:the )?(?:complete|entire|full|whole) issue|(?:all|every) (?:the )?(?:acceptance|requirement)|start to finish|end[ -]to[ -]end|re-?read (?:the )?(?:complete|entire|full|whole) issue)/iu
const RESTART_INVESTIGATION = /(?:restart|re-?investigat|from (?:the )?(?:beginning|issue|scratch)|re-?read (?:the )?(?:issue|requirements?|acceptance)|all (?:requirements?|acceptance))/iu
const POLICY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const SLICE_DEFINITION_FIELDS = Object.freeze([
    'sliceId',
    'order',
    'prerequisiteSliceIds',
    'singleObjective',
    'firstRequiredAction',
    'firstReadTargets',
    'firstWritablePath',
    'explicitReadOnlyOutput',
    'allowedPaths',
    'forbiddenPaths',
    'requiredCreatedOrModifiedFiles',
    'requiredCommands',
    'requiredEvidence',
    'expectedFailureOrProgressSignal',
    'explicitNonGoals',
    'maxChangedFiles',
    'maxOwnedModules',
    'maxReadOnlyOperationsBeforeCheckpoint',
    'maxNoArtifactToolCalls',
    'maxNoArtifactActiveDurationClass',
    'safeCheckpointKind',
    'acceptanceItemIds',
    'completionPredicate',
    'continuationPredicate'
])
const SLICE_POLICY_FIELDS = Object.freeze([
    'schema',
    'maxSliceCount',
    'maxAcceptanceItemsPerSlice',
    'maxFirstReadTargetsPerSlice',
    'maxAllowedPathsPerSlice',
    'maxRequiredFilesPerSlice',
    'maxRequiredCommandsPerSlice',
    'maxRequiredEvidencePerSlice',
    'maxExplicitNonGoalsPerSlice',
    'maxChangedFilesPerSlice',
    'maxOwnedModulesPerSlice',
    'maxReadOnlyOperationsBeforeCheckpointPerSlice',
    'maxNoArtifactToolCallsPerSlice',
    'allowedNoArtifactActiveDurationClasses',
    'allowedSafeCheckpointKinds',
    'orderedSliceBlueprints'
])
const BOUND_STAGE_WORK_PLAN_INPUT_FIELDS = Object.freeze([
    'schema',
    'runId',
    'repository',
    'issue',
    'node',
    'stageRole',
    'stagePhase',
    'baseSha',
    'epochId',
    'worktreeIdentity',
    'semanticContractDigest',
    'testContractDigest',
    'authorityDigest',
    'skillDigest',
    'baselineDigest',
    'routingInputDigest',
    'stageObjective',
    'acceptanceItems',
    'orderedSlices',
    'sliceDependencyGraph',
    'stageAllowedPaths',
    'stageForbiddenPaths',
    'stageRequiredCommands',
    'stageTerminalArtifacts',
    'frozenStageContract'
])
const FROZEN_STAGE_CONTRACT_INPUT_FIELDS = Object.freeze([
    'schema',
    'runId',
    'repository',
    'issue',
    'node',
    'stageRole',
    'stagePhase',
    'baseSha',
    'epochId',
    'worktreeIdentity',
    'testContractDigest',
    'skillDigest',
    'baselineDigest',
    'routingInputDigest',
    'stageObjective',
    'acceptanceItems',
    'stageAllowedPaths',
    'stageForbiddenPaths',
    'stageRequiredCommands',
    'stageTerminalArtifacts',
    'stageAttemptId',
    'deterministicSlicePolicy',
    'authoredByRole',
    'rootAuthored'
])
const PERMANENT_SLICE_POLICY_LIMITS = Object.freeze({
    maxSliceCount: 16,
    maxAcceptanceItemsPerSlice: 8,
    maxFirstReadTargetsPerSlice: 32,
    maxAllowedPathsPerSlice: 32,
    maxRequiredFilesPerSlice: 32,
    maxRequiredCommandsPerSlice: 16,
    maxRequiredEvidencePerSlice: 32,
    maxExplicitNonGoalsPerSlice: 16,
    maxChangedFilesPerSlice: 32,
    maxOwnedModulesPerSlice: 16,
    maxReadOnlyOperationsBeforeCheckpointPerSlice: 64,
    maxNoArtifactToolCallsPerSlice: 32
})
const ALLOWED_NO_ARTIFACT_DURATION_CLASSES = new Set([
    'short',
    'medium'
])
const ALLOWED_SAFE_CHECKPOINT_KINDS = new Set([
    'stage-progress',
    'slice-terminal',
    'documentation-no-change',
    'ui-render-evidence',
    'landing-conflict-resolution'
])
const SAFE_CHECKPOINT_KINDS_BY_PHASE = Object.freeze({
    'test-contract': new Set([
        'stage-progress',
        'slice-terminal'
    ]),
    implementation: new Set([
        'stage-progress',
        'slice-terminal'
    ]),
    'ui-implementation': new Set([
        'stage-progress',
        'slice-terminal',
        'ui-render-evidence'
    ]),
    documentation: new Set([
        'stage-progress',
        'slice-terminal',
        'documentation-no-change'
    ]),
    'landing-conflict-resolution': new Set([
        'stage-progress',
        'slice-terminal',
        'landing-conflict-resolution'
    ])
})
const RESOURCE_LEASE_KIND = 'writer-stage-resource'
const RESOURCE_LEASE_RECOVERY_RULE = 'terminal-receipt-required'
const RESOURCE_LEASE_CLOCK_SKEW_MS = 60_000
const RESOURCE_LEASE_MAX_LIFETIME_MS = 4 * 60 * 60 * 1_000
const RESOURCE_LEASE_MAX_ACQUISITION_AGE_MS = 15 * 60 * 1_000
const RESOURCE_REGISTRY_MAX_OBSERVATION_AGE_MS = 4 * 60 * 60 * 1_000
const LEDGER_GENESIS_DIGEST = '0'.repeat(64)
const FROZEN_SOURCE_EVENT_FIELDS = Object.freeze([
    'schema', 'eventId', 'sequence', 'runId', 'nodeId', 'eventType', 'fromState',
    'toState', 'attemptId', 'actorRole', 'sourceDagDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'baseSha',
    'payload', 'payloadDigest', 'evidenceRefs', 'createdAt',
    'previousEventDigest', 'eventDigest'
])
const FROZEN_STAGE_CONTRACT_FIELDS = Object.freeze([
    'schema',
    'status',
    'runId',
    'repository',
    'issue',
    'node',
    'stageRole',
    'stagePhase',
    'baseSha',
    'epochId',
    'worktreeIdentity',
    'testContractDigest',
    'skillDigest',
    'baselineDigest',
    'routingInputDigest',
    'stageObjective',
    'acceptanceItems',
    'stageAllowedPaths',
    'stageForbiddenPaths',
    'stageRequiredCommands',
    'stageTerminalArtifacts',
    'stageAttemptId',
    'deterministicSlicePolicy',
    'authoredByRole',
    'rootAuthored',
    'slicePolicyDigest',
    'semanticContractDigest',
    'authorityDigest',
    'sourceEvent',
    'sourceEventDigest',
    'sourceLedgerDigest',
    'sourceLedgerObservedAt',
    'sourceDispatchReceiptDigest',
    'activeWriteLeaseId',
    'resourceLeaseReceiptDigest',
    'runtimeStateRootDigest',
    'runtimeAuthorityIdentityDigest',
    'resourceRegistryIdentityDigest',
    'resourceRegistrySnapshotDigest',
    'resourceRegistryObservedAt',
    'resourceLease',
    'receiptDigest'
])
const STAGE_WORK_PLAN_FIELDS = Object.freeze([
    'schema',
    'status',
    'runId',
    'repository',
    'issue',
    'node',
    'stageRole',
    'stagePhase',
    'baseSha',
    'epochId',
    'worktreeIdentity',
    'semanticContractDigest',
    'testContractDigest',
    'authorityDigest',
    'skillDigest',
    'baselineDigest',
    'routingInputDigest',
    'contractBindingStatus',
    'frozenStageContract',
    'frozenStageContractReceiptDigest',
    'activeWriteLeaseId',
    'resourceLeaseReceiptDigest',
    'stageAttemptId',
    'runtimeStateRootDigest',
    'runtimeAuthorityIdentityDigest',
    'resourceRegistryIdentityDigest',
    'resourceRegistrySnapshotDigest',
    'resourceRegistryObservedAt',
    'sourceEventDigest',
    'sourceLedgerDigest',
    'sourceLedgerObservedAt',
    'sourceDispatchReceiptDigest',
    'plannerBindingStatus',
    'deterministicSlicePolicy',
    'slicePolicyDigest',
    'plannerReceipt',
    'plannerReceiptDigest',
    'stageObjective',
    'acceptanceItems',
    'orderedSlices',
    'sliceDependencyGraph',
    'stageAllowedPaths',
    'stageForbiddenPaths',
    'stageRequiredCommands',
    'stageTerminalArtifacts',
    'planDigest'
])
let activeAuthorityRuntime = null

export class ExecutableSliceError extends Error {
    constructor(code, message = code) {
        super(message)
        this.code = code
    }
}

function fail(code, message) {
    throw new ExecutableSliceError(code, message)
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

// Dispatch leases are sealed by dispatch-batch-selector using set-like
// canonicalization for arrays. Keep this deliberately narrow: ordered arrays in
// work plans and checkpoints continue to use the compiler's canonical digest.
function dispatchLeaseDigest(value) {
    const canonicalLease = (item) => {
        if (Array.isArray(item)) {
            return item.map(canonicalLease).sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right)))
        }
        if (!item || typeof item !== 'object') return item
        return Object.fromEntries(
            Object.keys(item).sort()
                .map((key) => [key, canonicalLease(item[key])])
        )
    }
    return createHash('sha256')
        .update(JSON.stringify(canonicalLease(value)))
        .digest('hex')
}

function observeCommand(command, worktreeRoot) {
    const result = spawnSync('/bin/sh', ['-lc', command], {
        cwd: worktreeRoot,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024
    })
    if (result.error || !Number.isInteger(result.status)) {
        return {
            reproducible: false,
            exitStatus: null,
            outputDigest: null
        }
    }
    return {
        reproducible: true,
        exitStatus: result.status,
        outputDigest: digest({
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? ''
        })
    }
}

function seal(value, digestField) {
    const sealed = structuredClone(value)
    delete sealed[digestField]
    sealed[digestField] = digest(sealed)
    return Object.freeze(sealed)
}

function unsignedDigest(value, digestField) {
    const unsigned = structuredClone(value)
    delete unsigned[digestField]
    return digest(unsigned)
}

function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function nonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        fail(`${label}-missing`, `${label} is required`)
    }
    return value
}

function singleObjective(value, label) {
    nonEmptyString(value, label)
    if (value.length > 500 || /[\r\n]/u.test(value) || WHOLE_ISSUE.test(value)) {
        fail(
            `${label}-whole-issue`,
            `${label} must be one bounded objective, not an issue body or full acceptance scope`
        )
    }
    return value
}

function stringList(value, label, { allowEmpty = false } = {}) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
        value.some((item) => typeof item !== 'string' || !item.trim()) ||
        new Set(value).size !== value.length) {
        fail(`${label}-missing`, `${label} is required and must contain unique strings`)
    }
    return value
}

function positiveInteger(value, label) {
    if (!Number.isInteger(value) || value <= 0) {
        fail(`${label}-invalid`, `${label} must be a positive integer`)
    }
    return value
}

function validPath(value, label) {
    nonEmptyString(value, label)
    if (value.length > 512 ||
        /[\u0000-\u001f\u007f\\]/u.test(value) ||
        /[*?[{\]}]/u.test(value.replace(/\/\*\*$/u, ''))) {
        fail(
            `${label}-invalid`,
            `${label} must use one bounded repository path or a trailing /** scope`
        )
    }
    const normalized = path.posix.normalize(value)
    if (path.posix.isAbsolute(normalized) || normalized === '..' ||
        normalized === '.' ||
        normalized.startsWith('../') || normalized.includes('/../')) {
        fail(`${label}-invalid`, `${label} must stay inside the repository`)
    }
    return normalized.replace(/^\.\//u, '')
}

function pathList(value, label, options) {
    return stringList(value, label, options).map((item) => validPath(item, label))
}

function concretePath(value, label) {
    const normalized = validPath(value, label)
    if (normalized.endsWith('/**') ||
        /[*?[{\]}]/u.test(normalized)) {
        fail(
            `${label}-invalid`,
            `${label} must be one concrete repository path`
        )
    }
    return normalized
}

function concretePathList(value, label, options) {
    return stringList(value, label, options)
        .map((item) => concretePath(item, label))
}

function pathScopeContains(parent, child) {
    if (parent === child) return true
    if (!parent.endsWith('/**')) return false
    const root = parent.slice(0, -3)
    return child === root || child.startsWith(`${root}/`)
}

function exactObjectFields(value, expectedFields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('\n') !==
            [...expectedFields].sort().join('\n')) {
        fail(
            `${label}-shape`,
            `${label} must contain exactly the deterministic contract fields`
        )
    }
}

function boundedPolicyInteger(policy, field) {
    positiveInteger(policy[field], `deterministicSlicePolicy.${field}`)
    if (policy[field] > PERMANENT_SLICE_POLICY_LIMITS[field]) {
        fail(
            'deterministic-slice-policy-capacity',
            `${field} exceeds the permanent executable-slice limit`
        )
    }
    return policy[field]
}

function boundedSingleLine(value, label, maximum = 500) {
    nonEmptyString(value, label)
    if (value.length > maximum || /[\r\n]/u.test(value)) {
        fail(
            `${label}-unbounded`,
            `${label} must be one bounded deterministic value`
        )
    }
    return value
}

function boundedStringList(value, label, maximum, options) {
    const values = stringList(value, label, options)
    if (values.length > maximum) {
        fail(`${label}-capacity`, `${label} exceeds its frozen slice-policy limit`)
    }
    return values
}

function validateSlicePolicyBlueprint(slice, policy, context, index) {
    exactObjectFields(
        slice,
        SLICE_DEFINITION_FIELDS,
        'deterministicSlicePolicy.orderedSliceBlueprint'
    )
    if (!POLICY_IDENTIFIER.test(slice.sliceId ?? '')) {
        fail(
            'deterministic-slice-policy-slice-id',
            'sliceId must be a bounded stable identifier'
        )
    }
    positiveInteger(slice.order, 'slice.order')
    if (slice.order !== index + 1) {
        fail(
            'deterministic-slice-policy-order',
            'slice policy order must be contiguous and deterministic'
        )
    }
    const prerequisiteSliceIds = boundedStringList(
        slice.prerequisiteSliceIds,
        'prerequisiteSliceIds',
        policy.maxSliceCount,
        { allowEmpty: true }
    )
    if (prerequisiteSliceIds.some((item) => !POLICY_IDENTIFIER.test(item))) {
        fail(
            'deterministic-slice-policy-dependency',
            'slice dependencies must be stable slice identifiers'
        )
    }
    singleObjective(slice.singleObjective, 'single objective')
    boundedSingleLine(
        slice.firstRequiredAction,
        'firstRequiredAction',
        2_048
    )
    const firstReadTargets = concretePathList(
        boundedStringList(
            slice.firstReadTargets,
            'firstReadTargets',
            policy.maxFirstReadTargetsPerSlice
        ),
        'firstReadTargets'
    )
    const firstWritablePath = slice.firstWritablePath === null
        ? null
        : concretePath(
            slice.firstWritablePath,
            'firstWritablePath'
        )
    const explicitReadOnlyOutput = slice.explicitReadOnlyOutput === null
        ? null
        : boundedSingleLine(
            slice.explicitReadOnlyOutput,
            'explicitReadOnlyOutput'
        )
    if (Boolean(firstWritablePath) === Boolean(explicitReadOnlyOutput)) {
        fail(
            'deterministic-slice-policy-output',
            'slice policy must choose exactly one writable path or read-only output'
        )
    }
    const allowedPaths = pathList(
        boundedStringList(
            slice.allowedPaths,
            'allowedPaths',
            policy.maxAllowedPathsPerSlice,
            { allowEmpty: Boolean(explicitReadOnlyOutput) }
        ),
        'allowedPaths',
        { allowEmpty: Boolean(explicitReadOnlyOutput) }
    )
    const forbiddenPaths = pathList(
        boundedStringList(
            slice.forbiddenPaths,
            'forbiddenPaths',
            policy.maxAllowedPathsPerSlice,
            { allowEmpty: true }
        ),
        'forbiddenPaths',
        { allowEmpty: true }
    )
    if (allowedPaths.some((item) =>
        !context.stageAllowedPaths.some((stagePath) =>
            pathScopeContains(stagePath, item))) ||
        allowedPaths.some((item) =>
            context.stageForbiddenPaths.some((stagePath) =>
                pathScopeContains(stagePath, item))) ||
        context.stageForbiddenPaths.some((stagePath) =>
            !forbiddenPaths.some((item) =>
                pathScopeContains(item, stagePath)))) {
        fail(
            'deterministic-slice-policy-path',
            'slice policy cannot broaden or remove the frozen stage path boundary'
        )
    }
    if (firstReadTargets.some((target) =>
        !allowedPaths.some((scope) =>
            pathScopeContains(scope, target)) ||
        forbiddenPaths.some((scope) =>
            pathScopeContains(scope, target)))) {
        fail(
            'deterministic-slice-policy-first-read',
            'first read targets must stay inside the writable slice scope'
        )
    }
    const requiredCreatedOrModifiedFiles = concretePathList(
        boundedStringList(
            slice.requiredCreatedOrModifiedFiles,
            'requiredCreatedOrModifiedFiles',
            policy.maxRequiredFilesPerSlice,
            { allowEmpty: Boolean(explicitReadOnlyOutput) }
        ),
        'requiredCreatedOrModifiedFiles',
        { allowEmpty: Boolean(explicitReadOnlyOutput) }
    )
    if (firstWritablePath &&
        (!allowedPaths.some((item) =>
            pathScopeContains(item, firstWritablePath)) ||
            forbiddenPaths.some((item) =>
                pathScopeContains(item, firstWritablePath)))) {
        fail(
            'deterministic-slice-policy-first-action-path',
            'first writable path must stay inside the frozen slice boundary'
        )
    }
    if (firstWritablePath &&
        !requiredCreatedOrModifiedFiles.includes(firstWritablePath)) {
        fail(
            'deterministic-slice-policy-first-action-path',
            'first writable path must be an exact required file'
        )
    }
    if (requiredCreatedOrModifiedFiles.some((filePath) =>
        !allowedPaths.some((item) => pathScopeContains(item, filePath)) ||
        forbiddenPaths.some((item) =>
            pathScopeContains(item, filePath)))) {
        fail(
            'deterministic-slice-policy-required-file',
            'required files must stay inside the frozen slice boundary'
        )
    }
    const requiredCommands = boundedStringList(
        slice.requiredCommands,
        'requiredCommands',
        policy.maxRequiredCommandsPerSlice
    )
    if (requiredCommands.some((command) =>
        command.length > 2_048 || /[\r\n]/u.test(command))) {
        fail(
            'deterministic-slice-policy-command',
            'required commands must be bounded single-line commands'
        )
    }
    if (requiredCommands.some((command) =>
        !context.stageRequiredCommands.includes(command))) {
        fail(
            'deterministic-slice-policy-command',
            'slice commands must come from the frozen stage command contract'
        )
    }
    const requiredEvidence = boundedStringList(
        slice.requiredEvidence,
        'requiredEvidence',
        policy.maxRequiredEvidencePerSlice
    )
    if (requiredEvidence.some((item) => !POLICY_IDENTIFIER.test(item))) {
        fail(
            'deterministic-slice-policy-evidence',
            'required evidence must use stable machine evidence identifiers'
        )
    }
    const explicitNonGoals = boundedStringList(
        slice.explicitNonGoals,
        'explicitNonGoals',
        policy.maxExplicitNonGoalsPerSlice
    )
    if (explicitNonGoals.some((item) =>
        item.length > 500 || /[\r\n]/u.test(item))) {
        fail(
            'deterministic-slice-policy-non-goal',
            'explicit non-goals must be bounded single-line values'
        )
    }
    boundedSingleLine(
        slice.expectedFailureOrProgressSignal,
        'expectedFailureOrProgressSignal'
    )
    for (const [field, policyField] of [
        ['maxChangedFiles', 'maxChangedFilesPerSlice'],
        ['maxOwnedModules', 'maxOwnedModulesPerSlice'],
        [
            'maxReadOnlyOperationsBeforeCheckpoint',
            'maxReadOnlyOperationsBeforeCheckpointPerSlice'
        ],
        ['maxNoArtifactToolCalls', 'maxNoArtifactToolCallsPerSlice']
    ]) {
        positiveInteger(slice[field], field)
        if (slice[field] > policy[policyField]) {
            fail(
                'deterministic-slice-policy-capacity',
                `${field} exceeds its frozen slice-policy limit`
            )
        }
    }
    if (requiredCreatedOrModifiedFiles.length > slice.maxChangedFiles) {
        fail(
            'deterministic-slice-policy-changed-files',
            'required files exceed maxChangedFiles'
        )
    }
    if (allowedPaths.length > slice.maxOwnedModules) {
        fail(
            'deterministic-slice-policy-owned-modules',
            'owned path scopes exceed maxOwnedModules'
        )
    }
    if (firstReadTargets.length >
        slice.maxReadOnlyOperationsBeforeCheckpoint) {
        fail(
            'deterministic-slice-policy-read-capacity',
            'first read targets exceed the pre-checkpoint read budget'
        )
    }
    if (!policy.allowedNoArtifactActiveDurationClasses.includes(
        slice.maxNoArtifactActiveDurationClass
    )) {
        fail(
            'deterministic-slice-policy-duration',
            'no-artifact duration class is outside the frozen policy'
        )
    }
    if (!policy.allowedSafeCheckpointKinds.includes(slice.safeCheckpointKind)) {
        fail(
            'deterministic-slice-policy-checkpoint',
            'safe checkpoint kind is outside the frozen policy'
        )
    }
    if (!SAFE_CHECKPOINT_KINDS_BY_PHASE[
        context.stagePhase
    ]?.has(slice.safeCheckpointKind)) {
        fail(
            'deterministic-slice-policy-checkpoint-phase',
            'safe checkpoint kind is not authorized for the writer phase'
        )
    }
    const acceptanceItemIds = boundedStringList(
        slice.acceptanceItemIds,
        'acceptanceItemIds',
        policy.maxAcceptanceItemsPerSlice
    )
    if (acceptanceItemIds.some((item) =>
        !context.acceptanceItems.includes(item))) {
        fail(
            'deterministic-slice-policy-acceptance',
            'slice policy references acceptance outside the frozen contract'
        )
    }
    const expectedCompletionPredicate =
        `required-files-commands-evidence-complete:${slice.sliceId}`
    const expectedContinuationPredicate =
        `sealed-checkpoint-cursor-resume:${slice.sliceId}`
    if (slice.completionPredicate !== expectedCompletionPredicate ||
        slice.continuationPredicate !== expectedContinuationPredicate) {
        fail(
            'deterministic-slice-policy-predicate',
            'slice predicates must use the deterministic machine gate identities'
        )
    }
    if (!requiredCommands.includes(slice.firstRequiredAction) &&
        (!firstWritablePath ||
            slice.firstRequiredAction !== `write:${firstWritablePath}`)) {
        fail(
            'deterministic-slice-policy-first-action',
            'first action must be an exact required command or write:<firstWritablePath>'
        )
    }
    return {
        ...structuredClone(slice),
        prerequisiteSliceIds,
        firstReadTargets,
        firstWritablePath,
        explicitReadOnlyOutput,
        allowedPaths,
        forbiddenPaths,
        requiredCreatedOrModifiedFiles,
        requiredCommands,
        requiredEvidence,
        explicitNonGoals,
        acceptanceItemIds
    }
}

function validateDeterministicSlicePolicy(policy, context) {
    exactObjectFields(
        policy,
        SLICE_POLICY_FIELDS,
        'deterministicSlicePolicy'
    )
    if (policy.schema !==
            'issue-orchestration.deterministic-slice-policy.v1') {
        fail(
            'deterministic-slice-policy-schema',
            'frozen stage contract requires deterministic slice policy v1'
        )
    }
    for (const field of Object.keys(PERMANENT_SLICE_POLICY_LIMITS)) {
        boundedPolicyInteger(policy, field)
    }
    const durationClasses = stringList(
        policy.allowedNoArtifactActiveDurationClasses,
        'allowedNoArtifactActiveDurationClasses'
    )
    if (durationClasses.some((item) =>
        !ALLOWED_NO_ARTIFACT_DURATION_CLASSES.has(item))) {
        fail(
            'deterministic-slice-policy-duration',
            'slice policy contains an unsupported duration class'
        )
    }
    const checkpointKinds = stringList(
        policy.allowedSafeCheckpointKinds,
        'allowedSafeCheckpointKinds'
    )
    if (checkpointKinds.some((item) =>
        !ALLOWED_SAFE_CHECKPOINT_KINDS.has(item))) {
        fail(
            'deterministic-slice-policy-checkpoint',
            'slice policy contains an unsupported checkpoint kind'
        )
    }
    if (!Array.isArray(policy.orderedSliceBlueprints) ||
        policy.orderedSliceBlueprints.length === 0 ||
        policy.orderedSliceBlueprints.length > policy.maxSliceCount) {
        fail(
            'deterministic-slice-policy-count',
            'ordered slice blueprints must fit the frozen slice-count limit'
        )
    }
    const normalizedBlueprints = policy.orderedSliceBlueprints.map(
        (slice, index) => validateSlicePolicyBlueprint(
            slice,
            {
                ...policy,
                allowedNoArtifactActiveDurationClasses: durationClasses,
                allowedSafeCheckpointKinds: checkpointKinds
            },
            context,
            index
        )
    )
    const sliceIds = normalizedBlueprints.map(({ sliceId }) => sliceId)
    if (new Set(sliceIds).size !== sliceIds.length) {
        fail(
            'deterministic-slice-policy-slice-id',
            'slice policy requires unique slice identifiers'
        )
    }
    for (const [index, slice] of normalizedBlueprints.entries()) {
        if (slice.prerequisiteSliceIds.some((item) =>
            !sliceIds.slice(0, index).includes(item))) {
            fail(
                'deterministic-slice-policy-dependency',
                'slice dependencies must reference earlier policy slices'
            )
        }
        if (index > 0 &&
            !slice.prerequisiteSliceIds.includes(sliceIds[index - 1])) {
            fail(
                'deterministic-slice-policy-dependency',
                'each ordered slice must depend on its immediate predecessor'
            )
        }
    }
    for (const acceptanceItem of context.acceptanceItems) {
        const owners = normalizedBlueprints.filter((slice) =>
            slice.acceptanceItemIds.includes(acceptanceItem))
        if (owners.length !== 1) {
            fail(
                'deterministic-slice-policy-acceptance-owner',
                'every frozen acceptance item requires exactly one slice owner'
            )
        }
    }
    for (const command of context.stageRequiredCommands) {
        const owners = normalizedBlueprints.filter((slice) =>
            slice.requiredCommands.includes(command))
        if (owners.length !== 1) {
            fail(
                'deterministic-slice-policy-command-owner',
                'every frozen stage command requires exactly one slice owner'
            )
        }
    }
    return {
        ...structuredClone(policy),
        allowedNoArtifactActiveDurationClasses: durationClasses,
        allowedSafeCheckpointKinds: checkpointKinds,
        orderedSliceBlueprints: normalizedBlueprints
    }
}

function createVerifiedPlannerReceipt({
    contractBinding,
    orderedSlices,
    sliceDependencyGraph
}) {
    if (contractBinding.contractBindingStatus !== 'verified') return null
    const ownership = orderedSlices.map((slice) => ({
        sliceId: slice.sliceId,
        acceptanceItemIds: slice.acceptanceItemIds,
        allowedPaths: slice.allowedPaths,
        requiredCreatedOrModifiedFiles:
            slice.requiredCreatedOrModifiedFiles,
        requiredCommands: slice.requiredCommands,
        requiredEvidence: slice.requiredEvidence
    }))
    const actionAndPredicate = orderedSlices.map((slice) => ({
        sliceId: slice.sliceId,
        firstRequiredAction: slice.firstRequiredAction,
        completionPredicate: slice.completionPredicate,
        continuationPredicate: slice.continuationPredicate,
        capacity: {
            maxChangedFiles: slice.maxChangedFiles,
            maxOwnedModules: slice.maxOwnedModules,
            maxReadOnlyOperationsBeforeCheckpoint:
                slice.maxReadOnlyOperationsBeforeCheckpoint,
            maxNoArtifactToolCalls: slice.maxNoArtifactToolCalls,
            maxNoArtifactActiveDurationClass:
                slice.maxNoArtifactActiveDurationClass,
            safeCheckpointKind: slice.safeCheckpointKind
        }
    }))
    return seal({
        schema: 'issue-orchestration.verified-slice-planner-receipt.v1',
        status: 'verified',
        compiler: 'deterministic-slice-policy.v1',
        rootAuthored: false,
        frozenStageContractReceiptDigest:
            contractBinding.frozenStageContractReceiptDigest,
        slicePolicyDigest: contractBinding.slicePolicyDigest,
        sliceCount: orderedSlices.length,
        orderedSliceIds: orderedSlices.map(({ sliceId }) => sliceId),
        orderedSlicesDigest: digest(orderedSlices),
        dependencyGraphDigest: digest(sliceDependencyGraph),
        ownershipDigest: digest(ownership),
        actionAndPredicateDigest: digest(actionAndPredicate)
    }, 'receiptDigest')
}

function verifyPlannerBinding(plan) {
    if (plan.contractBindingStatus === 'unbound-test-only') {
        if (plan.plannerBindingStatus !== 'unbound-test-only' ||
            plan.frozenStageContract !== null ||
            plan.deterministicSlicePolicy !== null ||
            plan.slicePolicyDigest !== null ||
            plan.plannerReceipt !== null ||
            plan.plannerReceiptDigest !== null) {
            fail(
                'stage-work-plan-planner-binding',
                'unbound test plans cannot claim a verified planner receipt'
            )
        }
        return
    }
    if (plan.contractBindingStatus !== 'verified' ||
        plan.plannerBindingStatus !== 'verified') {
        fail(
            'stage-work-plan-planner-binding',
            'writer plans require a verified deterministic planner receipt'
        )
    }
    const policy = validateDeterministicSlicePolicy(
        plan.deterministicSlicePolicy,
        {
            stagePhase: plan.stagePhase,
            acceptanceItems: plan.acceptanceItems,
            stageAllowedPaths: plan.stageAllowedPaths,
            stageForbiddenPaths: plan.stageForbiddenPaths,
            stageRequiredCommands: plan.stageRequiredCommands
        }
    )
    if (digest(policy) !== plan.slicePolicyDigest ||
        !sameValue(plan.orderedSlices, policy.orderedSliceBlueprints)) {
        fail(
            'stage-work-plan-slice-policy',
            'writer plan does not match its frozen deterministic slice policy'
        )
    }
    const expected = createVerifiedPlannerReceipt({
        contractBinding: plan,
        orderedSlices: plan.orderedSlices,
        sliceDependencyGraph: plan.sliceDependencyGraph
    })
    if (!sameValue(expected, plan.plannerReceipt) ||
        expected.receiptDigest !== plan.plannerReceiptDigest) {
        fail(
            'stage-work-plan-planner-receipt',
            'verified planner receipt is missing or does not match the plan'
        )
    }
}

function statusChangedPaths(worktreeStatus) {
    if (typeof worktreeStatus !== 'string' || !worktreeStatus.trim()) return []
    const decode = (candidate) => {
        if (candidate.startsWith('"') && candidate.endsWith('"')) {
            try {
                return JSON.parse(candidate)
            } catch {
                return candidate
            }
        }
        return candidate
    }
    return worktreeStatus.split('\n').flatMap((line) => {
        const raw = line.slice(3)
        return raw.includes(' -> ')
            ? raw.split(' -> ').map(decode)
            : [decode(raw)]
    }).filter(Boolean)
}

function assertIdentity(input, label) {
    for (const field of [
        'runId', 'repository', 'node', 'stageRole', 'stagePhase', 'epochId',
        'worktreeIdentity'
    ]) {
        nonEmptyString(input[field], `${label}.${field}`)
    }
    if (!Number.isInteger(input.issue) && typeof input.issue !== 'string') {
        fail(`${label}.issue-missing`, `${label}.issue is required`)
    }
    if (!WRITER_PHASES.has(input.stagePhase)) {
        fail(`${label}.stagePhase-invalid`, `${label}.stagePhase is not a writer phase`)
    }
    if (!WRITER_ROLES_BY_PHASE[input.stagePhase]?.has(input.stageRole)) {
        fail(
            `${label}.stageRole-invalid`,
            `${label}.stageRole is not authorized for ${input.stagePhase}`
        )
    }
    if (!SHA.test(input.baseSha ?? '')) {
        fail(`${label}.baseSha-invalid`, `${label}.baseSha must be a Git SHA`)
    }
}

function assertHashes(input, fields, label) {
    for (const field of fields) {
        if (!HASH.test(input[field] ?? '')) {
            fail(`${label}.${field}-invalid`, `${label}.${field} must be a sha256 digest`)
        }
    }
}

function normalizeSliceDefinition(slice, plan) {
    if (!slice || typeof slice !== 'object') {
        fail('executable-slice-missing', 'executable slice definition is required')
    }
    nonEmptyString(slice.sliceId, 'sliceId')
    positiveInteger(slice.order, 'slice.order')
    stringList(slice.prerequisiteSliceIds, 'prerequisiteSliceIds', { allowEmpty: true })
    singleObjective(slice.singleObjective, 'single objective')
    nonEmptyString(slice.firstRequiredAction, 'firstRequiredAction')
    const firstReadTargets = concretePathList(
        slice.firstReadTargets,
        'firstReadTargets'
    )
    const readOnly = typeof slice.explicitReadOnlyOutput === 'string' &&
        slice.explicitReadOnlyOutput.trim().length > 0
    const firstWritablePath = typeof slice.firstWritablePath === 'string' &&
        slice.firstWritablePath.trim().length > 0
        ? concretePath(slice.firstWritablePath, 'firstWritablePath')
        : null
    if (Boolean(firstWritablePath) === readOnly) {
        fail(
            'slice-output-boundary',
            'firstWritablePath or explicit read-only output is required, exclusively'
        )
    }
    const allowedPaths = pathList(
        slice.allowedPaths,
        'allowedPaths',
        { allowEmpty: readOnly }
    )
    const forbiddenPaths = pathList(
        slice.forbiddenPaths,
        'forbiddenPaths',
        { allowEmpty: true }
    )
    if (allowedPaths.some((item) =>
        !plan.stageAllowedPaths.some((stagePath) =>
            pathScopeContains(stagePath, item))) ||
        allowedPaths.some((item) =>
            plan.stageForbiddenPaths.some((stagePath) =>
                pathScopeContains(stagePath, item))) ||
        plan.stageForbiddenPaths.some((stagePath) =>
            !forbiddenPaths.some((item) =>
                pathScopeContains(item, stagePath)))) {
        fail(
            'slice-stage-path-boundary',
            'executable slice cannot broaden or remove the stage path boundary'
        )
    }
    const requiredFiles = concretePathList(
        slice.requiredCreatedOrModifiedFiles ?? slice.requiredFiles,
        'requiredCreatedOrModifiedFiles',
        { allowEmpty: readOnly }
    )
    if (firstWritablePath && !requiredFiles.includes(firstWritablePath)) {
        fail(
            'first-writable-path-boundary',
            'first writable path must be an exact required file'
        )
    }
    if (firstWritablePath &&
        (!allowedPaths.some((item) =>
            pathScopeContains(item, firstWritablePath)) ||
            forbiddenPaths.some((item) =>
                pathScopeContains(item, firstWritablePath)))) {
        fail(
            'first-writable-path-boundary',
            'first writable path is outside the executable slice boundary'
        )
    }
    for (const requiredFile of requiredFiles) {
        if (!allowedPaths.some((item) =>
            pathScopeContains(item, requiredFile)) ||
            forbiddenPaths.some((item) =>
                pathScopeContains(item, requiredFile))) {
            fail(
                'required-file-boundary',
                'required files must stay inside allowedPaths and outside forbiddenPaths'
            )
        }
    }
    const requiredCommands = stringList(slice.requiredCommands, 'requiredCommands')
    let firstAction
    if (requiredCommands.includes(slice.firstRequiredAction)) {
        firstAction = {
            kind: 'command',
            command: slice.firstRequiredAction,
            path: null
        }
    } else if (firstWritablePath &&
        slice.firstRequiredAction === `write:${firstWritablePath}`) {
        firstAction = {
            kind: 'filesystem-write',
            command: null,
            path: firstWritablePath
        }
    } else if (plan.contractBindingStatus === 'verified') {
        fail(
            'first-required-action-unverifiable',
            'a bound writer firstRequiredAction must be an exact required command or write:<firstWritablePath>'
        )
    } else {
        firstAction = {
            kind: 'unbound-test-only',
            command: null,
            path: firstWritablePath
        }
    }
    const requiredEvidence = stringList(slice.requiredEvidence, 'requiredEvidence')
    const explicitNonGoals = stringList(slice.explicitNonGoals, 'explicitNonGoals')
    nonEmptyString(
        slice.expectedFailureOrProgressSignal,
        'expectedFailureOrProgressSignal'
    )
    for (const field of [
        'maxChangedFiles', 'maxOwnedModules',
        'maxReadOnlyOperationsBeforeCheckpoint', 'maxNoArtifactToolCalls'
    ]) {
        positiveInteger(slice[field], field)
    }
    nonEmptyString(
        slice.maxNoArtifactActiveDurationClass,
        'maxNoArtifactActiveDurationClass'
    )
    nonEmptyString(slice.safeCheckpointKind, 'safeCheckpointKind')
    const acceptanceItemIds = stringList(
        slice.acceptanceItemIds,
        'acceptanceItemIds'
    )
    if (acceptanceItemIds.some((item) => !plan.acceptanceItems.includes(item))) {
        fail(
            'acceptance-item-owner',
            'executable slice references an acceptance item outside the stage contract'
        )
    }
    nonEmptyString(slice.completionPredicate, 'completionPredicate')
    nonEmptyString(slice.continuationPredicate, 'continuationPredicate')
    return {
        schema: 'issue-orchestration.executable-slice.v1',
        runId: plan.runId,
        repository: plan.repository,
        issue: plan.issue,
        node: plan.node,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        semanticContractDigest: plan.semanticContractDigest,
        testContractDigest: plan.testContractDigest,
        authorityDigest: plan.authorityDigest,
        skillDigest: plan.skillDigest,
        baselineDigest: plan.baselineDigest,
        routingInputDigest: plan.routingInputDigest,
        contractBindingStatus: plan.contractBindingStatus,
        frozenStageContractReceiptDigest:
            plan.frozenStageContractReceiptDigest,
        plannerBindingStatus: plan.plannerBindingStatus,
        slicePolicyDigest: plan.slicePolicyDigest,
        plannerReceiptDigest: plan.plannerReceiptDigest,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        resourceLeaseReceiptDigest: plan.resourceLeaseReceiptDigest,
        stageAttemptId: plan.stageAttemptId,
        runtimeStateRootDigest: plan.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            plan.runtimeAuthorityIdentityDigest,
        resourceRegistryIdentityDigest:
            plan.resourceRegistryIdentityDigest,
        resourceRegistrySnapshotDigest:
            plan.resourceRegistrySnapshotDigest,
        resourceRegistryObservedAt:
            plan.resourceRegistryObservedAt,
        sourceEventDigest: plan.sourceEventDigest,
        sourceLedgerDigest: plan.sourceLedgerDigest,
        sourceLedgerObservedAt: plan.sourceLedgerObservedAt,
        sourceDispatchReceiptDigest:
            plan.sourceDispatchReceiptDigest,
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        order: slice.order,
        prerequisiteSliceIds: [...slice.prerequisiteSliceIds],
        singleObjective: slice.singleObjective,
        firstRequiredAction: slice.firstRequiredAction,
        firstAction,
        firstReadTargets,
        firstWritablePath,
        explicitReadOnlyOutput: readOnly ? slice.explicitReadOnlyOutput : null,
        allowedPaths,
        forbiddenPaths,
        requiredCreatedOrModifiedFiles: requiredFiles,
        requiredFiles,
        requiredCommands,
        requiredEvidence,
        expectedFailureOrProgressSignal: slice.expectedFailureOrProgressSignal,
        explicitNonGoals,
        maxChangedFiles: slice.maxChangedFiles,
        maxOwnedModules: slice.maxOwnedModules,
        maxReadOnlyOperationsBeforeCheckpoint:
            slice.maxReadOnlyOperationsBeforeCheckpoint,
        maxNoArtifactToolCalls: slice.maxNoArtifactToolCalls,
        maxNoArtifactActiveDurationClass:
            slice.maxNoArtifactActiveDurationClass,
        safeCheckpointKind: slice.safeCheckpointKind,
        acceptanceItemIds,
        completionPredicate: slice.completionPredicate,
        continuationPredicate: slice.continuationPredicate
    }
}

function verifyPlanDigest(plan) {
    if (plan?.schema !== 'issue-orchestration.stage-work-plan.v1' ||
        plan.status !== 'verified' ||
        !HASH.test(plan.planDigest ?? '') ||
        unsignedDigest(plan, 'planDigest') !== plan.planDigest) {
        fail('stage-work-plan-invalid', 'verified stage work plan digest is invalid')
    }
    verifyPlannerBinding(plan)
    validateActiveWriterResourceAuthority(plan)
    validateActiveWriterSourceAuthority(plan)
    verifyCanonicalFrozenContractBinding(plan)
}

function verifySealedFrozenStageContract(plan) {
    const contract = plan?.frozenStageContract
    exactObjectFields(
        contract,
        FROZEN_STAGE_CONTRACT_FIELDS,
        'sealedFrozenStageContract'
    )
    if (contract.schema !==
            'issue-orchestration.frozen-stage-contract.v1' ||
        contract.status !== 'verified' ||
        contract.authoredByRole !== 'test-owner' ||
        contract.rootAuthored !== false ||
        !HASH.test(contract.receiptDigest ?? '') ||
        unsignedDigest(contract, 'receiptDigest') !==
            contract.receiptDigest ||
        contract.receiptDigest !==
            plan.frozenStageContractReceiptDigest) {
        fail(
            'sealed-frozen-stage-contract-invalid',
            'sealed replay requires the exact verified frozen contract'
        )
    }
    assertIdentity(contract, 'sealed-frozen-stage-contract')
    assertHashes(contract, [
        'testContractDigest',
        'skillDigest',
        'baselineDigest',
        'routingInputDigest',
        'slicePolicyDigest',
        'semanticContractDigest',
        'authorityDigest',
        'sourceEventDigest',
        'sourceLedgerDigest',
        'resourceLeaseReceiptDigest',
        'runtimeStateRootDigest',
        'runtimeAuthorityIdentityDigest',
        'resourceRegistryIdentityDigest',
        'resourceRegistrySnapshotDigest'
    ], 'sealed-frozen-stage-contract')
    for (const field of [
        'sourceLedgerObservedAt',
        'resourceRegistryObservedAt'
    ]) {
        parseAuthorityTimestamp(
            contract[field],
            `sealed frozen contract ${field}`
        )
    }
    const policy = validateDeterministicSlicePolicy(
        contract.deterministicSlicePolicy,
        {
            stagePhase: contract.stagePhase,
            acceptanceItems: contract.acceptanceItems,
            stageAllowedPaths: contract.stageAllowedPaths,
            stageForbiddenPaths: contract.stageForbiddenPaths,
            stageRequiredCommands: contract.stageRequiredCommands
        }
    )
    const slicePolicyDigest = digest(policy)
    if (contract.slicePolicyDigest !== slicePolicyDigest) {
        fail(
            'sealed-frozen-stage-contract-policy',
            'sealed frozen contract policy digest is invalid'
        )
    }

    const sourceEvent = contract.sourceEvent
    exactObjectFields(
        sourceEvent,
        FROZEN_SOURCE_EVENT_FIELDS,
        'sealedFrozenStageContract.sourceEvent'
    )
    parseAuthorityTimestamp(
        sourceEvent.createdAt,
        'sealed frozen contract source event createdAt'
    )
    if (sourceEvent.schema !== 'issue-orchestration.event.v2' ||
        !Number.isInteger(sourceEvent.sequence) ||
        sourceEvent.sequence <= 0 ||
        sourceEvent.runId !== contract.runId ||
        sourceEvent.nodeId !== contract.node ||
        sourceEvent.baseSha !== contract.baseSha ||
        !HASH.test(sourceEvent.previousEventDigest ?? '') ||
        !HASH.test(sourceEvent.sourceDagDigest ?? '') ||
        !HASH.test(sourceEvent.issueSnapshotFingerprint ?? '') ||
        !HASH.test(sourceEvent.repositoryFingerprint ?? '') ||
        !Array.isArray(sourceEvent.evidenceRefs) ||
        sourceEvent.evidenceRefs.length === 0 ||
        sourceEvent.evidenceRefs.some((item) =>
            typeof item !== 'string' || !item) ||
        sourceEvent.payloadDigest !== digest(sourceEvent.payload) ||
        sourceEvent.eventDigest !==
            unsignedDigest(sourceEvent, 'eventDigest') ||
        sourceEvent.eventDigest !== contract.sourceEventDigest) {
        fail(
            'sealed-frozen-stage-contract-source',
            'sealed source event identity or digest is invalid'
        )
    }
    const specification = sourceEventSpecification(contract)
    const sourceTypeIndex = specification.eventTypes.indexOf(
        sourceEvent.eventType
    )
    if (sourceTypeIndex < 0 ||
        sourceEvent.actorRole !==
            specification.actorRoles[sourceTypeIndex]) {
        fail(
            'sealed-frozen-stage-contract-source',
            'sealed source event is not the phase predecessor'
        )
    }
    const expectedStageContract = {
        schema: 'issue-orchestration.writer-stage-source-contract.v1',
        runId: contract.runId,
        repository: contract.repository,
        issue: contract.issue,
        node: contract.node,
        baseSha: contract.baseSha,
        epochId: contract.epochId,
        stageRole: contract.stageRole,
        stagePhase: contract.stagePhase,
        stageObjective: contract.stageObjective,
        testContractDigest: contract.testContractDigest,
        skillDigest: contract.skillDigest,
        baselineDigest: contract.baselineDigest,
        routingInputDigest: contract.routingInputDigest,
        acceptanceItems: structuredClone(contract.acceptanceItems),
        stageAllowedPaths: structuredClone(contract.stageAllowedPaths),
        stageForbiddenPaths:
            structuredClone(contract.stageForbiddenPaths),
        stageRequiredCommands:
            structuredClone(contract.stageRequiredCommands),
        stageTerminalArtifacts:
            structuredClone(contract.stageTerminalArtifacts),
        slicePolicyDigest,
        rootAuthored: false
    }
    if (!sameValue(
        sourceEvent.payload?.writerStageContract,
        expectedStageContract
    )) {
        fail(
            'sealed-frozen-stage-contract-source',
            'sealed source event does not bind the frozen stage contract'
        )
    }
    const sourceReceipt = validateFrozenSourceReceipt(
        sourceEvent.payload?.sourceReceipt,
        contract,
        {
            actorRole: specification.actorRoles[sourceTypeIndex],
            schema: specification.receiptSchemas[sourceTypeIndex]
        }
    )
    if (sourceEvent.payload?.sourceReceiptDigest !==
            sourceReceipt.receiptDigest) {
        fail(
            'sealed-frozen-stage-contract-source',
            'sealed source receipt digest is invalid'
        )
    }
    const sourceDispatchReceiptDigest =
        HASH.test(sourceReceipt.dispatchReceiptDigest ?? '')
            ? sourceReceipt.dispatchReceiptDigest
            : null
    if (contract.sourceDispatchReceiptDigest !==
            sourceDispatchReceiptDigest) {
        fail(
            'sealed-frozen-stage-contract-source',
            'sealed source dispatch binding is invalid'
        )
    }

    const lease = contract.resourceLease
    exactObjectFields(
        lease,
        [
            'schema',
            'leaseId',
            'kind',
            'keys',
            'ownerId',
            'attemptId',
            'stageTaskId',
            'acquiredAt',
            'expiresAt',
            'recoveryRule',
            'state',
            'leaseDigest'
        ],
        'sealedFrozenStageContract.resourceLease'
    )
    const acquiredAt = parseAuthorityTimestamp(
        lease.acquiredAt,
        'sealed writer lease acquiredAt'
    )
    const expiresAt = parseAuthorityTimestamp(
        lease.expiresAt,
        'sealed writer lease expiresAt'
    )
    const unsignedLease = structuredClone(lease)
    delete unsignedLease.leaseDigest
    if (lease.schema !== 'issue-orchestration.dispatch-lease.v1' ||
        lease.kind !== RESOURCE_LEASE_KIND ||
        lease.recoveryRule !== RESOURCE_LEASE_RECOVERY_RULE ||
        lease.state !== 'active' ||
        lease.ownerId !== contract.stageRole ||
        lease.attemptId !== contract.stageAttemptId ||
        lease.stageTaskId !==
            contract.deterministicSlicePolicy
                .orderedSliceBlueprints[0]?.sliceId ||
        lease.leaseId !== contract.activeWriteLeaseId ||
        lease.leaseDigest !==
            contract.resourceLeaseReceiptDigest ||
        lease.leaseDigest !== dispatchLeaseDigest(unsignedLease) ||
        !Array.isArray(lease.keys) ||
        lease.keys.length === 0 ||
        lease.keys.some((item) =>
            typeof item !== 'string' || !item) ||
        new Set(lease.keys).size !== lease.keys.length ||
        expiresAt <= acquiredAt) {
        fail(
            'sealed-frozen-stage-contract-resource',
            'sealed writer resource lease identity or digest is invalid'
        )
    }

    const expectedSemanticContractDigest = digest({
        runId: contract.runId,
        repository: contract.repository,
        issue: contract.issue,
        node: contract.node,
        stageRole: contract.stageRole,
        stagePhase: contract.stagePhase,
        stageObjective: contract.stageObjective,
        acceptanceItems: contract.acceptanceItems,
        stageAllowedPaths: contract.stageAllowedPaths,
        stageForbiddenPaths: contract.stageForbiddenPaths,
        stageRequiredCommands: contract.stageRequiredCommands,
        stageTerminalArtifacts: contract.stageTerminalArtifacts,
        testContractDigest: contract.testContractDigest,
        slicePolicyDigest
    })
    const expectedAuthorityDigest = digest({
        stageRole: contract.stageRole,
        stagePhase: contract.stagePhase,
        baseSha: contract.baseSha,
        epochId: contract.epochId,
        worktreeIdentity: contract.worktreeIdentity,
        activeWriteLeaseId: contract.activeWriteLeaseId,
        resourceLeaseReceiptDigest:
            contract.resourceLeaseReceiptDigest,
        runtimeStateRootDigest: contract.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            contract.runtimeAuthorityIdentityDigest,
        resourceRegistryIdentityDigest:
            contract.resourceRegistryIdentityDigest,
        resourceRegistrySnapshotDigest:
            contract.resourceRegistrySnapshotDigest,
        sourceEventDigest: contract.sourceEventDigest,
        sourceLedgerDigest: contract.sourceLedgerDigest,
        sourceDispatchReceiptDigest:
            contract.sourceDispatchReceiptDigest
    })
    if (contract.semanticContractDigest !==
            expectedSemanticContractDigest ||
        contract.authorityDigest !== expectedAuthorityDigest) {
        fail(
            'sealed-frozen-stage-contract-digest',
            'sealed semantic or authority digest is invalid'
        )
    }
    const exactPlanFields = [
        'runId',
        'repository',
        'issue',
        'node',
        'stageRole',
        'stagePhase',
        'baseSha',
        'epochId',
        'worktreeIdentity',
        'semanticContractDigest',
        'testContractDigest',
        'authorityDigest',
        'skillDigest',
        'baselineDigest',
        'routingInputDigest',
        'stageObjective',
        'acceptanceItems',
        'stageAllowedPaths',
        'stageForbiddenPaths',
        'stageRequiredCommands',
        'stageTerminalArtifacts',
        'activeWriteLeaseId',
        'resourceLeaseReceiptDigest',
        'stageAttemptId',
        'deterministicSlicePolicy',
        'slicePolicyDigest',
        'runtimeStateRootDigest',
        'runtimeAuthorityIdentityDigest',
        'resourceRegistryIdentityDigest',
        'resourceRegistrySnapshotDigest',
        'resourceRegistryObservedAt',
        'sourceEventDigest',
        'sourceLedgerDigest',
        'sourceLedgerObservedAt',
        'sourceDispatchReceiptDigest'
    ]
    if (plan.contractBindingStatus !== 'verified' ||
        plan.plannerBindingStatus !== 'verified' ||
        exactPlanFields.some((field) =>
            !sameValue(plan[field], contract[field]))) {
        fail(
            'sealed-stage-work-plan-frozen-binding',
            'sealed plan differs from its embedded frozen contract'
        )
    }
    return contract
}

function verifySealedStageWorkPlan(plan, authority) {
    exactObjectFields(
        plan,
        STAGE_WORK_PLAN_FIELDS,
        'sealedStageWorkPlan'
    )
    if (plan?.schema !== 'issue-orchestration.stage-work-plan.v1' ||
        plan.status !== 'verified' ||
        plan.contractBindingStatus !== 'verified' ||
        plan.plannerBindingStatus !== 'verified' ||
        !HASH.test(plan.planDigest ?? '') ||
        unsignedDigest(plan, 'planDigest') !== plan.planDigest) {
        fail(
            'sealed-stage-work-plan-invalid',
            'sealed replay requires a verified stage work plan digest'
        )
    }
    assertIdentity(plan, 'sealed-stage-work-plan')
    assertHashes(plan, [
        'semanticContractDigest',
        'testContractDigest',
        'authorityDigest',
        'skillDigest',
        'baselineDigest',
        'routingInputDigest',
        'frozenStageContractReceiptDigest',
        'slicePolicyDigest',
        'plannerReceiptDigest'
    ], 'sealed-stage-work-plan')
    exactObjectFields(
        authority,
        [
            'expectedSourceEventDigest',
            'expectedSourceLedgerDigest'
        ],
        'sealedWriterAuthorityAnchor'
    )
    if (!HASH.test(authority.expectedSourceEventDigest ?? '') ||
        !HASH.test(authority.expectedSourceLedgerDigest ?? '') ||
        authority.expectedSourceEventDigest !==
            plan.sourceEventDigest ||
        authority.expectedSourceLedgerDigest !==
            plan.sourceLedgerDigest) {
        fail(
            'sealed-writer-authority-anchor',
            'sealed replay requires the canonical predecessor event and ledger prefix'
        )
    }
    verifyPlannerBinding(plan)
    verifySealedFrozenStageContract(plan)
    for (const definition of plan.orderedSlices) {
        normalizeSliceDefinition(definition, plan)
    }
    const coveredAcceptance = new Set(
        plan.orderedSlices.flatMap(
            ({ acceptanceItemIds }) => acceptanceItemIds
        )
    )
    if (plan.acceptanceItems.some((item) =>
        !coveredAcceptance.has(item)) ||
        plan.stageRequiredCommands.some((command) =>
            !plan.orderedSlices.some((slice) =>
                slice.requiredCommands.includes(command)))) {
        fail(
            'sealed-stage-work-plan-coverage',
            'sealed plan acceptance or command coverage is incomplete'
        )
    }
    return plan
}

function sealedValidationErrors(operation) {
    try {
        operation()
        return []
    } catch (error) {
        return [
            `${error?.code ?? 'sealed-validation-error'}:`
                + `${error?.message ?? String(error)}`
        ]
    }
}

export function validateSealedStageWorkPlan(plan, authority) {
    return sealedValidationErrors(() =>
        verifySealedStageWorkPlan(plan, authority))
}

function verifyCanonicalFrozenContractBinding(plan) {
    if (plan.contractBindingStatus === 'unbound-test-only') return
    const contract = readCanonicalFrozenStageContract(plan).contract
    if (contract?.schema !==
            'issue-orchestration.frozen-stage-contract.v1' ||
        contract.status !== 'verified' ||
        contract.receiptDigest !==
            plan.frozenStageContractReceiptDigest ||
        unsignedDigest(contract, 'receiptDigest') !==
            contract.receiptDigest ||
        !sameValue(plan.frozenStageContract, contract)) {
        fail(
            'stage-work-plan-frozen-authority',
            'writer plan has no valid canonical frozen contract authority'
        )
    }
    const exactFields = [
        'runId',
        'repository',
        'issue',
        'node',
        'stageRole',
        'stagePhase',
        'baseSha',
        'epochId',
        'worktreeIdentity',
        'semanticContractDigest',
        'testContractDigest',
        'authorityDigest',
        'skillDigest',
        'baselineDigest',
        'routingInputDigest',
        'stageObjective',
        'acceptanceItems',
        'stageAllowedPaths',
        'stageForbiddenPaths',
        'stageRequiredCommands',
        'stageTerminalArtifacts',
        'contractBindingStatus',
        'activeWriteLeaseId',
        'resourceLeaseReceiptDigest',
        'stageAttemptId',
        'deterministicSlicePolicy',
        'slicePolicyDigest',
        'runtimeStateRootDigest',
        'runtimeAuthorityIdentityDigest',
        'resourceRegistryIdentityDigest',
        'resourceRegistrySnapshotDigest',
        'resourceRegistryObservedAt',
        'sourceEventDigest',
        'sourceLedgerDigest',
        'sourceLedgerObservedAt',
        'sourceDispatchReceiptDigest'
    ]
    if (exactFields.some((field) => {
        const contractValue = field === 'contractBindingStatus'
            ? contract.status
            : contract[field]
        return !sameValue(plan[field], contractValue)
    })) {
        fail(
            'stage-work-plan-frozen-authority',
            'writer plan identity, routing, scope, policy, or authority differs from its canonical frozen contract'
        )
    }
}

function parseAuthorityTimestamp(value, label) {
    const parsed = Date.parse(value)
    if (typeof value !== 'string' ||
        !Number.isFinite(parsed) ||
        new Date(parsed).toISOString() !== value) {
        fail(
            'writer-resource-authority-stale',
            `${label} must be a canonical UTC timestamp`
        )
    }
    return parsed
}

function authorityWorktreeResource(registry, worktreeIdentity) {
    const worktreeRoot = fs.realpathSync(worktreeIdentity)
    const matches = registry.resources.filter((resource) =>
        resource.resourceType === 'worktree' &&
        resource.resourceId === registry.issueWorktreeId &&
        ['active', 'retained'].includes(resource.state) &&
        typeof resource.identityEvidence?.path === 'string' &&
        fs.existsSync(resource.identityEvidence.path) &&
        fs.realpathSync(resource.identityEvidence.path) === worktreeRoot)
    if (matches.length !== 1) {
        fail(
            'writer-resource-registry-worktree',
            'resource registry must own exactly one observable stage worktree'
        )
    }
    return matches[0]
}

export function writerResourceRegistryIdentityDigest({
    registry,
    worktreeIdentity
} = {}) {
    let canonicalRegistry
    try {
        canonicalRegistry = createResourceRegistry(registry)
    } catch (error) {
        fail(
            'writer-resource-registry-invalid',
            `resource registry is invalid: ${error.code ?? error.message}`
        )
    }
    const worktree = authorityWorktreeResource(
        canonicalRegistry,
        worktreeIdentity
    )
    return digest({
        schema: canonicalRegistry.schema,
        runId: canonicalRegistry.runId,
        issueId: canonicalRegistry.issueId,
        stageAttemptId: canonicalRegistry.stageAttemptId,
        stageTaskId: canonicalRegistry.stageTaskId,
        stageRole: canonicalRegistry.stageRole,
        issueWorktreeId: canonicalRegistry.issueWorktreeId,
        baseSha: canonicalRegistry.baseSha,
        epochId: canonicalRegistry.epochId,
        allowedPathsDigest: canonicalRegistry.allowedPathsDigest,
        testContractDigest: canonicalRegistry.testContractDigest,
        writeLease: canonicalRegistry.writeLease
            ? {
                id: canonicalRegistry.writeLease.id,
                ownerAttemptId:
                    canonicalRegistry.writeLease.ownerAttemptId,
                mode: canonicalRegistry.writeLease.mode
            }
            : null,
        worktree: {
            resourceId: worktree.resourceId,
            ownerClass: worktree.ownerClass,
            ownerRunId: worktree.ownerRunId,
            ownerAttemptId: worktree.ownerAttemptId,
            path: fs.realpathSync(worktree.identityEvidence.path),
            baseSha: worktree.identityEvidence.baseSha ?? null
        }
    })
}

function startupStringArray(value, label) {
    let parsed
    try {
        parsed = JSON.parse(value)
    } catch {
        fail(
            'writer-authority-runtime-unavailable',
            `${label} must be startup-fixed JSON`
        )
    }
    if (!Array.isArray(parsed) || parsed.length === 0 ||
        parsed.some((item) => typeof item !== 'string' || !item)) {
        fail(
            'writer-authority-runtime-unavailable',
            `${label} must contain startup-fixed absolute paths`
        )
    }
    return parsed
}

function activeWriterAuthorityRuntime() {
    if (activeAuthorityRuntime) return activeAuthorityRuntime
    const configured = {
        stateRoot:
            process.env.FSUS_ISSUE_ORCHESTRATION_STATE_ROOT ?? null,
        repositories:
            process.env.FSUS_ISSUE_ORCHESTRATION_REPOSITORIES ?? null,
        workspaces:
            process.env.FSUS_ISSUE_ORCHESTRATION_WORKSPACES ?? null
    }
    if (!configured.stateRoot ||
        !configured.repositories ||
        !configured.workspaces) {
        fail(
            'writer-authority-runtime-unavailable',
            'active writer authority must be fixed when the process starts'
        )
    }
    const repositories = startupStringArray(
        configured.repositories,
        'FSUS_ISSUE_ORCHESTRATION_REPOSITORIES'
    )
    const workspaces = startupStringArray(
        configured.workspaces,
        'FSUS_ISSUE_ORCHESTRATION_WORKSPACES'
    )
    let validation
    try {
        validation = validateStateRoot({
            candidate: configured.stateRoot,
            repositories,
            workspaces
        })
    } catch (error) {
        fail(
            'writer-authority-runtime-unavailable',
            `startup state root is invalid: ${error.code ?? error.message}`
        )
    }
    if (validation.valid !== true ||
        validation.candidate.exists !== true) {
        fail(
            'writer-authority-runtime-unavailable',
            'startup state root must already exist and validate'
        )
    }
    const root = fs.realpathSync(validation.candidate.canonical)
    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        (rootStat.mode & 0o077) !== 0 ||
        typeof process.getuid === 'function' &&
            rootStat.uid !== process.getuid()) {
        fail(
            'writer-authority-runtime-unavailable',
            'startup state root must be an owner-only canonical directory'
        )
    }
    activeAuthorityRuntime = Object.freeze({
        root,
        validationDigest: digest(validation)
    })
    return activeAuthorityRuntime
}

export function writerStageAuthorityLocation({
    runId,
    node,
    stageAttemptId
} = {}) {
    nonEmptyString(runId, 'writer-authority.runId')
    nonEmptyString(node, 'writer-authority.node')
    nonEmptyString(stageAttemptId, 'writer-authority.stageAttemptId')
    const runtime = activeWriterAuthorityRuntime()
    const runKey = digest({ runId })
    const attemptKey = digest({ runId, node, stageAttemptId })
    const runRoot = path.join(runtime.root, 'runs', runKey)
    const attemptRoot = path.join(
        runRoot,
        'writer-attempts',
        attemptKey
    )
    return Object.freeze({
        runtimeStateRootDigest: runtime.validationDigest,
        sourceLedgerPath: path.join(runRoot, 'event-ledger.jsonl'),
        frozenStageContractPath:
            path.join(attemptRoot, 'frozen-stage-contract.json'),
        resourceRegistryPath:
            path.join(attemptRoot, 'resource-registry.json'),
        writerLeasePath: path.join(attemptRoot, 'writer-lease.json')
    })
}

function assertCanonicalAuthorityFile(filePath, runtimeRoot) {
    const relative = path.relative(runtimeRoot, filePath)
    if (!relative || relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !fs.existsSync(filePath)) {
        fail(
            'writer-authority-file-missing',
            'canonical active authority file is missing'
        )
    }
    let cursor = runtimeRoot
    for (const component of relative.split(path.sep)) {
        cursor = path.join(cursor, component)
        const item = fs.lstatSync(cursor)
        if (item.isSymbolicLink()) {
            fail(
                'writer-authority-file-symlink',
                'active authority path cannot contain symbolic links'
            )
        }
    }
    const item = fs.lstatSync(filePath)
    if (!item.isFile() ||
        (item.mode & 0o077) !== 0 ||
        typeof process.getuid === 'function' &&
            item.uid !== process.getuid()) {
        fail(
            'writer-authority-file-permissions',
            'active authority file must be an owner-only regular file'
        )
    }
    const now = Date.now()
    if (item.mtimeMs > now + RESOURCE_LEASE_CLOCK_SKEW_MS ||
        now - item.mtimeMs >
            RESOURCE_REGISTRY_MAX_OBSERVATION_AGE_MS) {
        fail(
            'writer-authority-file-stale',
            'active authority file observation is stale'
        )
    }
    return {
        realPath: fs.realpathSync(filePath),
        observedAt: new Date(item.mtimeMs).toISOString()
    }
}

function readCanonicalAuthorityJson(filePath, runtimeRoot) {
    const observation = assertCanonicalAuthorityFile(
        filePath,
        runtimeRoot
    )
    try {
        return {
            ...observation,
            value: JSON.parse(
                fs.readFileSync(observation.realPath, 'utf8')
            )
        }
    } catch {
        fail(
            'writer-authority-file-invalid',
            'active authority file is not valid JSON'
        )
    }
}

function persistCanonicalFrozenStageContract(contract) {
    const runtime = activeWriterAuthorityRuntime()
    const location = writerStageAuthorityLocation(contract)
    const contractPath = location.frozenStageContractPath
    fs.mkdirSync(path.dirname(contractPath), {
        mode: 0o700,
        recursive: true
    })
    fs.chmodSync(path.dirname(contractPath), 0o700)
    const serialized = `${JSON.stringify(contract)}\n`
    try {
        fs.writeFileSync(contractPath, serialized, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        })
        fs.chmodSync(contractPath, 0o600)
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existing = readCanonicalAuthorityJson(
            contractPath,
            runtime.root
        ).value
        if (!sameValue(existing, contract)) {
            fail(
                'frozen-stage-contract-authority-conflict',
                'canonical frozen stage authority already exists with different content'
            )
        }
    }
    return contract
}

function readCanonicalFrozenStageContract(expected) {
    const runtime = activeWriterAuthorityRuntime()
    const location = writerStageAuthorityLocation(expected)
    const observation = readCanonicalAuthorityJson(
        location.frozenStageContractPath,
        runtime.root
    )
    return {
        ...observation,
        contract: observation.value
    }
}

function readActiveSourceLedger(location) {
    const runtime = activeWriterAuthorityRuntime()
    const observation = assertCanonicalAuthorityFile(
        location.sourceLedgerPath,
        runtime.root
    )
    const lines = fs.readFileSync(observation.realPath, 'utf8')
        .split('\n')
        .filter(Boolean)
    if (lines.length < 2) {
        fail(
            'frozen-stage-source-ledger',
            'active source ledger is incomplete'
        )
    }
    let entries
    try {
        entries = lines.map((line) => JSON.parse(line))
    } catch {
        fail(
            'frozen-stage-source-ledger',
            'active source ledger tail is corrupt'
        )
    }
    return {
        ledger: {
            header: entries[0],
            events: entries.slice(1)
        },
        observedAt: observation.observedAt
    }
}

function readResourceRegistryAuthority(expected) {
    const runtime = activeWriterAuthorityRuntime()
    const location = writerStageAuthorityLocation(expected)
    const registryObservation = readCanonicalAuthorityJson(
        location.resourceRegistryPath,
        runtime.root
    )
    const leaseObservation = readCanonicalAuthorityJson(
        location.writerLeasePath,
        runtime.root
    )
    let registry
    try {
        registry = createResourceRegistry(registryObservation.value)
    } catch (error) {
        fail(
            'writer-resource-registry-invalid',
            `resource registry is invalid: ${error.code ?? error.message}`
        )
    }
    return {
        location,
        observedAt: registryObservation.observedAt,
        registry,
        lease: leaseObservation.value,
        snapshotDigest: digest(registry)
    }
}

function validateWriterResourceLease({
    lease,
    registry,
    registryIdentityDigest,
    stageRole,
    worktreeIdentity,
    requireFreshAcquisition = false
}) {
    const required = [
        'leaseId', 'kind', 'ownerId', 'attemptId', 'stageTaskId',
        'acquiredAt', 'expiresAt', 'recoveryRule', 'state'
    ]
    const acquiredAt = parseAuthorityTimestamp(
        lease?.acquiredAt,
        'resource lease acquiredAt'
    )
    const expiresAt = parseAuthorityTimestamp(
        lease?.expiresAt,
        'resource lease expiresAt'
    )
    const now = Date.now()
    if (lease?.schema !== 'issue-orchestration.dispatch-lease.v1' ||
        required.some((field) =>
            typeof lease[field] !== 'string' || !lease[field]) ||
        lease.kind !== RESOURCE_LEASE_KIND ||
        lease.recoveryRule !== RESOURCE_LEASE_RECOVERY_RULE ||
        lease.state !== 'active' ||
        lease.ownerId !== stageRole ||
        lease.attemptId !== registry.stageAttemptId ||
        lease.stageTaskId !== registry.stageTaskId ||
        registry.writeLease?.id !== lease.leaseId ||
        registry.writeLease?.ownerAttemptId !== lease.attemptId ||
        registry.writeLease?.mode !== 'write' ||
        registry.writeLease?.state !== 'active' ||
        !Array.isArray(lease.keys) ||
        lease.keys.length !== 2 ||
        new Set(lease.keys).size !== lease.keys.length ||
        !lease.keys.includes(`worktree:${worktreeIdentity}`) ||
        !lease.keys.includes(
            `resource-registry:${registryIdentityDigest}`
        ) ||
        acquiredAt > now + RESOURCE_LEASE_CLOCK_SKEW_MS ||
        expiresAt <= now ||
        expiresAt <= acquiredAt ||
        expiresAt - acquiredAt > RESOURCE_LEASE_MAX_LIFETIME_MS ||
        requireFreshAcquisition &&
            now - acquiredAt > RESOURCE_LEASE_MAX_ACQUISITION_AGE_MS ||
        !HASH.test(lease.leaseDigest ?? '') ||
        dispatchLeaseDigest(Object.fromEntries(
            Object.entries(lease).filter(([field]) =>
                field !== 'leaseDigest')
        )) !== lease.leaseDigest) {
        fail(
            'writer-resource-lease-invalid',
            'writer stage requires a fresh canonical active lease bound to its registry, role, attempt, and worktree'
        )
    }
    return structuredClone(lease)
}

function validateWriterResourceAuthority({
    expected,
    requireFreshAcquisition = false
}) {
    const observation = readResourceRegistryAuthority(expected)
    const { registry, lease } = observation
    const expectedAllowedPathsDigest = digest(expected.stageAllowedPaths)
    if (registry.runId !== expected.runId ||
        registry.issueId !== expected.node ||
        registry.stageAttemptId !== expected.stageAttemptId ||
        registry.stageRole !== expected.stageRole ||
        registry.baseSha !== expected.baseSha ||
        registry.epochId !== expected.epochId ||
        registry.allowedPathsDigest !== expectedAllowedPathsDigest ||
        registry.testContractDigest !== expected.testContractDigest ||
        registry.slotHeld !== true ||
        typeof registry.stageTaskId !== 'string' ||
        !registry.stageTaskId) {
        fail(
            'writer-resource-registry-mismatch',
            'resource registry does not match the frozen stage identity and contract'
        )
    }
    const worktree = authorityWorktreeResource(
        registry,
        expected.worktreeIdentity
    )
    if (worktree.ownerRunId !== expected.runId ||
        worktree.ownerAttemptId !== registry.stageAttemptId ||
        worktree.identityEvidence?.baseSha !== expected.baseSha) {
        fail(
            'writer-resource-registry-owner',
            'resource registry worktree owner, attempt, or base identity is invalid'
        )
    }
    let observedHead
    let observedRoot
    try {
        observedHead = execFileSync(
            'git',
            ['rev-parse', 'HEAD'],
            {
                cwd: expected.worktreeIdentity,
                encoding: 'utf8'
            }
        ).trim()
        observedRoot = fs.realpathSync(execFileSync(
            'git',
            ['rev-parse', '--show-toplevel'],
            {
                cwd: expected.worktreeIdentity,
                encoding: 'utf8'
            }
        ).trim())
    } catch {
        fail(
            'writer-resource-registry-worktree',
            'registered writer worktree is not an observable Git worktree'
        )
    }
    if (observedHead !== expected.baseSha ||
        observedRoot !== fs.realpathSync(expected.worktreeIdentity)) {
        fail(
            'writer-resource-registry-worktree',
            'registered writer worktree does not match its live Git base'
        )
    }
    const identityDigest = writerResourceRegistryIdentityDigest({
        registry,
        worktreeIdentity: expected.worktreeIdentity
    })
    const canonicalLease = validateWriterResourceLease({
        lease,
        registry,
        registryIdentityDigest: identityDigest,
        stageRole: expected.stageRole,
        worktreeIdentity: expected.worktreeIdentity,
        requireFreshAcquisition
    })
    return {
        ...observation,
        identityDigest,
        lease: canonicalLease,
        runtimeAuthorityIdentityDigest: digest({
            runtimeStateRootDigest:
                observation.location.runtimeStateRootDigest,
            runId: expected.runId,
            node: expected.node,
            stageAttemptId: expected.stageAttemptId,
            registryIdentityDigest: identityDigest,
            resourceLeaseReceiptDigest: canonicalLease.leaseDigest
        })
    }
}

export function validateActiveWriterResourceAuthority(plan) {
    if (plan?.contractBindingStatus === 'unbound-test-only') return true
    if (plan?.contractBindingStatus !== 'verified') {
        fail(
            'writer-resource-authority-unbound',
            'active writer plan requires frozen resource authority'
        )
    }
    const authority = validateWriterResourceAuthority({
        expected: plan
    })
    if (plan.stageAttemptId !== authority.lease.attemptId ||
        plan.activeWriteLeaseId !== authority.lease.leaseId ||
        plan.resourceLeaseReceiptDigest !==
            authority.lease.leaseDigest ||
        plan.runtimeStateRootDigest !==
            authority.location.runtimeStateRootDigest ||
        plan.runtimeAuthorityIdentityDigest !==
            authority.runtimeAuthorityIdentityDigest ||
        plan.resourceRegistryIdentityDigest !==
            authority.identityDigest) {
        fail(
            'writer-resource-authority-replay',
            'active writer registry or lease no longer matches the sealed plan'
        )
    }
    return true
}

export function validateActiveWriterSourceAuthority(plan) {
    if (plan?.contractBindingStatus === 'unbound-test-only') return true
    if (plan?.contractBindingStatus !== 'verified' ||
        !HASH.test(plan.slicePolicyDigest ?? '') ||
        !HASH.test(plan.sourceEventDigest ?? '')) {
        fail(
            'writer-source-authority-unbound',
            'active writer plan requires frozen predecessor authority'
        )
    }
    const sourceAuthority = validateFrozenStageSourceLedger(
        plan,
        plan.slicePolicyDigest,
        plan.sourceEventDigest
    )
    const location = writerStageAuthorityLocation(plan)
    if (plan.runtimeStateRootDigest !==
            location.runtimeStateRootDigest ||
        plan.sourceEventDigest !== sourceAuthority.sourceEventDigest ||
        plan.sourceDispatchReceiptDigest !==
            sourceAuthority.sourceDispatchReceiptDigest) {
        fail(
            'writer-source-authority-replay',
            'active writer predecessor authority no longer matches the sealed plan'
        )
    }
    return true
}

export function readActiveWriterAuthorityLedger(plan) {
    if (plan?.contractBindingStatus !== 'verified' ||
        !HASH.test(plan.slicePolicyDigest ?? '') ||
        !HASH.test(plan.sourceEventDigest ?? '')) {
        fail(
            'writer-source-authority-unbound',
            'only a verified active writer plan may read its authority ledger'
        )
    }
    const sourceAuthority = validateFrozenStageSourceLedger(
        plan,
        plan.slicePolicyDigest,
        plan.sourceEventDigest
    )
    return Object.freeze({
        header: structuredClone(sourceAuthority.ledger.header),
        events: Object.freeze(structuredClone(
            sourceAuthority.ledger.events
        )),
        observedAt: sourceAuthority.sourceLedgerObservedAt,
        headEventDigest:
            sourceAuthority.ledger.events.at(-1)?.eventDigest ??
            LEDGER_GENESIS_DIGEST
    })
}

function validateSourceDispatchReceipt(receipt, input, attemptId) {
    if (receipt?.schema !== 'issue-orchestration.dispatch-receipt.v2' ||
        receipt.verificationStatus !== 'verified' ||
        receipt.runId !== input.runId ||
        receipt.nodeId !== input.node ||
        receipt.attemptId !== attemptId ||
        receipt.baseSha !== input.baseSha ||
        receipt.epochId !== input.epochId ||
        receipt.stageRole !== 'test-owner' ||
        receipt.stagePhase !== 'test-contract' ||
        receipt.testContractDigest !== input.testContractDigest ||
        !Array.isArray(receipt.mismatchReasons) ||
        receipt.mismatchReasons.length !== 0 ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        unsignedDigest(receipt, 'receiptDigest') !==
            receipt.receiptDigest) {
        fail(
            'frozen-stage-source-dispatch',
            'frozen stage source requires a verified test-owner dispatch receipt'
        )
    }
    return receipt
}

function validateFrozenSourceReceipt(
    receipt,
    input,
    {
        actorRole,
        schema
    }
) {
    if (receipt?.schema !== schema ||
        receipt.verificationStatus !== 'verified' ||
        receipt.actorRole !== actorRole ||
        receipt.runId !== input.runId ||
        receipt.nodeId !== input.node ||
        receipt.baseSha !== input.baseSha ||
        receipt.epochId !== input.epochId ||
        receipt.testContractDigest !== input.testContractDigest ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        unsignedDigest(receipt, 'receiptDigest') !==
            receipt.receiptDigest) {
        fail(
            'frozen-stage-source-receipt',
            'writer stage source receipt is invalid or belongs to another stage identity'
        )
    }
    return receipt
}

function sourceEventSpecification(input) {
    if (input.stagePhase === 'test-contract' &&
        input.stageRole === 'test-owner') {
        return {
            eventTypes: ['node.discovered'],
            actorRoles: ['dag-updater'],
            receiptSchemas: [
                'issue-orchestration.dag-scope-receipt.v1'
            ],
            invalidatingEvents: [
                'issue.reopened',
                'node.resumed'
            ]
        }
    }
    if (['implementation', 'ui-implementation'].includes(
        input.stagePhase
    )) {
        return {
            eventTypes: ['test-contract.frozen'],
            actorRoles: ['test-owner'],
            receiptSchemas: [
                'issue-orchestration.test-contract-freeze-receipt.v1'
            ],
            invalidatingEvents: [
                'test-contract.disputed',
                'contract.rebased',
                'issue.reopened'
            ]
        }
    }
    if (input.stagePhase === 'documentation') {
        return {
            eventTypes: [
                'ux-acceptance.accepted',
                'independent-verification.passed'
            ],
            actorRoles: [
                'ux-acceptance-verifier',
                'test-owner'
            ],
            receiptSchemas: [
                'issue-orchestration.ux-source-receipt.v1',
                'issue-orchestration.behavior-source-receipt.v1'
            ],
            invalidatingEvents: [
                'ux-acceptance.rejected',
                'independent-verification.rejected',
                'issue.reopened'
            ]
        }
    }
    if (input.stagePhase === 'landing-conflict-resolution') {
        return {
            eventTypes: ['delivery.failed'],
            actorRoles: ['root-scheduler'],
            receiptSchemas: [
                'issue-orchestration.landing-conflict-source-receipt.v1'
            ],
            invalidatingEvents: [
                'delivery.completed',
                'issue.reopened'
            ]
        }
    }
    fail(
        'frozen-stage-source-phase',
        'writer stage has no permanent predecessor authority'
    )
}

function validateFrozenStageSourceLedger(
    input,
    slicePolicyDigest,
    expectedSourceEventDigest = null
) {
    const location = writerStageAuthorityLocation(input)
    const sourceObservation = readActiveSourceLedger(location)
    const { ledger } = sourceObservation
    if (ledger?.header?.schema !== 'issue-orchestration.ledger.v2' ||
        ledger.header.transitionSchema !==
            'issue-orchestration.transition.v2' ||
        ledger.header.runId !== input.runId ||
        ledger.header.baseSha !== input.baseSha ||
        !Array.isArray(ledger.events) ||
        ledger.events.length === 0) {
        fail(
            'frozen-stage-source-ledger',
            'frozen stage source requires the complete active ledger'
        )
    }
    let previousDigest = LEDGER_GENESIS_DIGEST
    let previousCreatedAt = -Infinity
    let previousState = 'none'
    for (const [index, event] of ledger.events.entries()) {
        exactObjectFields(
            event,
            FROZEN_SOURCE_EVENT_FIELDS,
            'frozenStageContract.sourceLedger.event'
        )
        const createdAt = parseAuthorityTimestamp(
            event.createdAt,
            'frozen stage source event createdAt'
        )
        if (event.schema !== 'issue-orchestration.event.v2' ||
            event.sequence !== index + 1 ||
            event.runId !== input.runId ||
            event.nodeId !== input.node ||
            event.baseSha !== input.baseSha ||
            event.previousEventDigest !== previousDigest ||
            event.fromState !== previousState ||
            createdAt < previousCreatedAt ||
            !HASH.test(event.sourceDagDigest ?? '') ||
            !HASH.test(event.issueSnapshotFingerprint ?? '') ||
            !HASH.test(event.repositoryFingerprint ?? '') ||
            !Array.isArray(event.evidenceRefs) ||
            event.evidenceRefs.length === 0 ||
            event.evidenceRefs.some((item) =>
                typeof item !== 'string' || !item) ||
            event.payloadDigest !== digest(event.payload) ||
            event.eventDigest !== unsignedDigest(event, 'eventDigest')) {
            fail(
                'frozen-stage-source-ledger',
                'frozen stage source ledger identity or digest chain is invalid'
            )
        }
        previousDigest = event.eventDigest
        previousCreatedAt = createdAt
        previousState = event.toState
    }
    const specification = sourceEventSpecification(input)
    let sourceIndex = -1
    for (let index = ledger.events.length - 1; index >= 0; index -= 1) {
        if (specification.eventTypes.includes(
            ledger.events[index].eventType
        )) {
            sourceIndex = index
            break
        }
    }
    if (sourceIndex < 0) {
        fail(
            'frozen-stage-source-event',
            'active ledger does not contain the required predecessor event'
        )
    }
    const sourceEvent = ledger.events[sourceIndex]
    const sourceTypeIndex = specification.eventTypes.indexOf(
        sourceEvent.eventType
    )
    if (sourceEvent.actorRole !==
            specification.actorRoles[sourceTypeIndex] ||
        ledger.events.slice(sourceIndex + 1).some((event) =>
            specification.invalidatingEvents.includes(event.eventType))) {
        fail(
            'frozen-stage-source-event',
            'writer stage predecessor authority is invalidated or has the wrong role'
        )
    }
    const expectedStageContract = {
        schema: 'issue-orchestration.writer-stage-source-contract.v1',
        runId: input.runId,
        repository: input.repository,
        issue: input.issue,
        node: input.node,
        baseSha: input.baseSha,
        epochId: input.epochId,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        stageObjective: input.stageObjective,
        testContractDigest: input.testContractDigest,
        skillDigest: input.skillDigest,
        baselineDigest: input.baselineDigest,
        routingInputDigest: input.routingInputDigest,
        acceptanceItems: structuredClone(input.acceptanceItems),
        stageAllowedPaths: structuredClone(input.stageAllowedPaths),
        stageForbiddenPaths: structuredClone(input.stageForbiddenPaths),
        stageRequiredCommands:
            structuredClone(input.stageRequiredCommands),
        stageTerminalArtifacts:
            structuredClone(input.stageTerminalArtifacts),
        slicePolicyDigest,
        rootAuthored: false
    }
    if (!sameValue(
        sourceEvent.payload?.writerStageContract,
        expectedStageContract
    )) {
        fail(
            'frozen-stage-source-contract',
            'predecessor event does not bind the exact writer stage contract'
        )
    }
    const sourceReceipt = validateFrozenSourceReceipt(
        sourceEvent.payload?.sourceReceipt,
        input,
        {
            actorRole: specification.actorRoles[sourceTypeIndex],
            schema: specification.receiptSchemas[sourceTypeIndex]
        }
    )
    if (sourceEvent.payload?.sourceReceiptDigest !==
            sourceReceipt.receiptDigest ||
        expectedSourceEventDigest !== null &&
            sourceEvent.eventDigest !== expectedSourceEventDigest) {
        fail(
            'frozen-stage-source-receipt',
            'predecessor event does not bind its verified source receipt'
        )
    }
    let sourceDispatchReceiptDigest = null
    if (sourceEvent.eventType === 'test-contract.frozen') {
        const started = ledger.events.slice(0, sourceIndex)
            .findLast((event) =>
                event.eventType === 'test-contract.started')
        if (!started ||
            sourceReceipt.dispatchReceiptDigest !==
                started.payload?.dispatchReceipt?.receiptDigest) {
            fail(
                'frozen-stage-source-dispatch',
                'test-contract freeze does not reference its test-owner dispatch'
            )
        }
        sourceDispatchReceiptDigest = validateSourceDispatchReceipt(
            started.payload.dispatchReceipt,
            input,
            started.attemptId
        ).receiptDigest
    } else if (HASH.test(sourceReceipt.dispatchReceiptDigest ?? '')) {
        sourceDispatchReceiptDigest =
            sourceReceipt.dispatchReceiptDigest
    }
    return {
        ledger: structuredClone(ledger),
        sourceEvent: structuredClone(sourceEvent),
        sourceLedgerDigest: digest(ledger),
        sourceLedgerObservedAt: sourceObservation.observedAt,
        sourceEventDigest: sourceEvent.eventDigest,
        sourceDispatchReceiptDigest
    }
}

function frozenContractBinding(input) {
    const contract = input.frozenStageContract
    if (!contract) {
        return {
            contractBindingStatus: 'unbound-test-only',
            plannerBindingStatus: 'unbound-test-only',
            frozenStageContract: null,
            frozenStageContractReceiptDigest: null,
            activeWriteLeaseId: null,
            resourceLeaseReceiptDigest: null,
            stageAttemptId: null,
            deterministicSlicePolicy: null,
            slicePolicyDigest: null,
            plannerReceipt: null,
            plannerReceiptDigest: null,
            runtimeStateRootDigest: null,
            runtimeAuthorityIdentityDigest: null,
            resourceRegistryIdentityDigest: null,
            resourceRegistrySnapshotDigest: null,
            resourceRegistryObservedAt: null,
            sourceEventDigest: null,
            sourceLedgerDigest: null,
            sourceLedgerObservedAt: null,
            sourceDispatchReceiptDigest: null
        }
    }
    if (contract.schema !== 'issue-orchestration.frozen-stage-contract.v1' ||
        contract.status !== 'verified' ||
        contract.authoredByRole !== 'test-owner' ||
        contract.rootAuthored !== false ||
        !HASH.test(contract.receiptDigest ?? '') ||
        unsignedDigest(contract, 'receiptDigest') !== contract.receiptDigest) {
        fail(
            'frozen-stage-contract-invalid',
            'a verified test-owner frozen stage contract and resource lease are required'
        )
    }
    const canonicalContract =
        readCanonicalFrozenStageContract(contract).contract
    if (!sameValue(canonicalContract, contract)) {
        fail(
            'frozen-stage-contract-authority-replay',
            'stage work plan must consume the exact startup-fixed frozen contract'
        )
    }
    const deterministicSlicePolicy = validateDeterministicSlicePolicy(
        contract.deterministicSlicePolicy,
        {
            stagePhase: contract.stagePhase,
            acceptanceItems: contract.acceptanceItems,
            stageAllowedPaths: contract.stageAllowedPaths,
            stageForbiddenPaths: contract.stageForbiddenPaths,
            stageRequiredCommands: contract.stageRequiredCommands
        }
    )
    const slicePolicyDigest = digest(deterministicSlicePolicy)
    if (contract.slicePolicyDigest !== slicePolicyDigest) {
        fail(
            'frozen-stage-contract-slice-policy',
            'frozen stage contract slice policy digest is invalid'
        )
    }
    const sourceAuthority = validateFrozenStageSourceLedger(
        contract,
        slicePolicyDigest,
        contract.sourceEventDigest
    )
    const resourceAuthority = validateWriterResourceAuthority({
        expected: {
            ...input,
            stageAttemptId: contract.stageAttemptId
        }
    })
    const { lease } = resourceAuthority
    if (contract.activeWriteLeaseId !== lease.leaseId ||
        contract.resourceLeaseReceiptDigest !== lease.leaseDigest ||
        contract.stageAttemptId !== lease.attemptId ||
        contract.runtimeStateRootDigest !==
            resourceAuthority.location.runtimeStateRootDigest ||
        contract.runtimeAuthorityIdentityDigest !==
            resourceAuthority.runtimeAuthorityIdentityDigest ||
        contract.resourceRegistryIdentityDigest !==
            resourceAuthority.identityDigest ||
        contract.sourceLedgerDigest !==
            sourceAuthority.sourceLedgerDigest ||
        contract.sourceDispatchReceiptDigest !==
            sourceAuthority.sourceDispatchReceiptDigest) {
        fail(
            'frozen-stage-contract-resource',
            'frozen stage contract does not match its live registry, lease, and source authority'
        )
    }
    const exactFields = [
        'runId', 'repository', 'issue', 'node', 'stageRole', 'stagePhase',
        'baseSha', 'epochId', 'worktreeIdentity', 'testContractDigest',
        'skillDigest', 'baselineDigest', 'routingInputDigest', 'stageObjective',
        'acceptanceItems', 'stageAllowedPaths', 'stageForbiddenPaths',
        'stageRequiredCommands', 'stageTerminalArtifacts'
    ]
    if (exactFields.some((field) =>
        !sameValue(contract[field], input[field]))) {
        fail(
            'frozen-stage-contract-mismatch',
            'work plan input cannot change frozen owner, acceptance, scope, command, or identity'
        )
    }
    const expectedSemanticContractDigest = digest({
        runId: contract.runId,
        repository: contract.repository,
        issue: contract.issue,
        node: contract.node,
        stageRole: contract.stageRole,
        stagePhase: contract.stagePhase,
        stageObjective: contract.stageObjective,
        acceptanceItems: contract.acceptanceItems,
        stageAllowedPaths: contract.stageAllowedPaths,
        stageForbiddenPaths: contract.stageForbiddenPaths,
        stageRequiredCommands: contract.stageRequiredCommands,
        stageTerminalArtifacts: contract.stageTerminalArtifacts,
        testContractDigest: contract.testContractDigest,
        slicePolicyDigest
    })
    const expectedAuthorityDigest = digest({
        stageRole: contract.stageRole,
        stagePhase: contract.stagePhase,
        baseSha: contract.baseSha,
        epochId: contract.epochId,
        worktreeIdentity: contract.worktreeIdentity,
        activeWriteLeaseId: contract.activeWriteLeaseId,
        resourceLeaseReceiptDigest: contract.resourceLeaseReceiptDigest,
        runtimeStateRootDigest: contract.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            contract.runtimeAuthorityIdentityDigest,
        resourceRegistryIdentityDigest:
            contract.resourceRegistryIdentityDigest,
        resourceRegistrySnapshotDigest:
            contract.resourceRegistrySnapshotDigest,
        sourceEventDigest: sourceAuthority.sourceEventDigest,
        sourceLedgerDigest: sourceAuthority.sourceLedgerDigest,
        sourceDispatchReceiptDigest:
            sourceAuthority.sourceDispatchReceiptDigest
    })
    if (contract.semanticContractDigest !==
            expectedSemanticContractDigest ||
        input.semanticContractDigest !== expectedSemanticContractDigest ||
        contract.authorityDigest !== expectedAuthorityDigest ||
        input.authorityDigest !== expectedAuthorityDigest) {
        fail(
            'frozen-stage-contract-digest',
            'frozen semantic and resource authority digests must be reproducible'
        )
    }
    return {
        contractBindingStatus: 'verified',
        plannerBindingStatus: 'verified',
        frozenStageContract: structuredClone(contract),
        frozenStageContractReceiptDigest: contract.receiptDigest,
        activeWriteLeaseId: contract.activeWriteLeaseId,
        resourceLeaseReceiptDigest: contract.resourceLeaseReceiptDigest,
        stageAttemptId: contract.stageAttemptId,
        deterministicSlicePolicy,
        slicePolicyDigest,
        runtimeStateRootDigest: contract.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            contract.runtimeAuthorityIdentityDigest,
        resourceRegistryIdentityDigest:
            contract.resourceRegistryIdentityDigest,
        resourceRegistrySnapshotDigest:
            contract.resourceRegistrySnapshotDigest,
        resourceRegistryObservedAt: contract.resourceRegistryObservedAt,
        sourceEventDigest: contract.sourceEventDigest,
        sourceLedgerDigest: contract.sourceLedgerDigest,
        sourceLedgerObservedAt: contract.sourceLedgerObservedAt,
        sourceDispatchReceiptDigest:
            contract.sourceDispatchReceiptDigest
    }
}

export function sealFrozenStageContract(input) {
    if (input?.schema !==
            'issue-orchestration.frozen-stage-contract-input.v1' ||
        input.authoredByRole !== 'test-owner' ||
        input.rootAuthored !== false) {
        fail(
            'frozen-stage-contract-input',
            'frozen stage contract input requires test-owner event and resource authority'
        )
    }
    assertIdentity(input, 'frozen-stage-contract')
    nonEmptyString(input.stageAttemptId, 'frozen-stage-contract.stageAttemptId')
    for (const forbiddenField of [
        'sourceLedger',
        'sourceEvent',
        'sourceEventDigest',
        'resourceRegistryAuthorityPath',
        'resourceRegistry',
        'resourceLease'
    ]) {
        if (Object.hasOwn(input, forbiddenField)) {
            fail(
                'frozen-stage-contract-authority-override',
                'active frozen contract cannot accept caller-supplied authority objects or paths'
            )
        }
    }
    exactObjectFields(
        input,
        FROZEN_STAGE_CONTRACT_INPUT_FIELDS,
        'frozenStageContractInput'
    )
    for (const field of [
        'testContractDigest', 'skillDigest', 'baselineDigest',
        'routingInputDigest'
    ]) {
        if (!HASH.test(input[field] ?? '')) {
            fail(
                'frozen-stage-contract-input',
                `frozen-stage-contract.${field} must be a sha256 digest`
            )
        }
    }
    singleObjective(input.stageObjective, 'stageObjective')
    const acceptanceItems = stringList(
        input.acceptanceItems,
        'acceptanceItems'
    )
    const stageAllowedPaths = pathList(
        input.stageAllowedPaths,
        'stageAllowedPaths'
    )
    const stageForbiddenPaths = pathList(
        input.stageForbiddenPaths,
        'stageForbiddenPaths',
        { allowEmpty: true }
    )
    const stageRequiredCommands = stringList(
        input.stageRequiredCommands,
        'stageRequiredCommands'
    )
    const stageTerminalArtifacts = stringList(
        input.stageTerminalArtifacts,
        'stageTerminalArtifacts'
    )
    const normalizedInput = {
        ...input,
        acceptanceItems,
        stageAllowedPaths,
        stageForbiddenPaths,
        stageRequiredCommands,
        stageTerminalArtifacts
    }
    const deterministicSlicePolicy = validateDeterministicSlicePolicy(
        input.deterministicSlicePolicy,
        {
            stagePhase: input.stagePhase,
            acceptanceItems,
            stageAllowedPaths,
            stageForbiddenPaths,
            stageRequiredCommands
        }
    )
    const slicePolicyDigest = digest(deterministicSlicePolicy)
    const sourceAuthority = validateFrozenStageSourceLedger(
        normalizedInput,
        slicePolicyDigest
    )
    const resourceAuthority = validateWriterResourceAuthority({
        expected: normalizedInput,
        requireFreshAcquisition: true
    })
    const resourceLease = resourceAuthority.lease
    const semanticContractDigest = digest({
        runId: input.runId,
        repository: input.repository,
        issue: input.issue,
        node: input.node,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        stageObjective: input.stageObjective,
        acceptanceItems,
        stageAllowedPaths,
        stageForbiddenPaths,
        stageRequiredCommands,
        stageTerminalArtifacts,
        testContractDigest: input.testContractDigest,
        slicePolicyDigest
    })
    const authorityDigest = digest({
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        baseSha: input.baseSha,
        epochId: input.epochId,
        worktreeIdentity: input.worktreeIdentity,
        activeWriteLeaseId: resourceLease.leaseId,
        resourceLeaseReceiptDigest: resourceLease.leaseDigest,
        runtimeStateRootDigest:
            resourceAuthority.location.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            resourceAuthority.runtimeAuthorityIdentityDigest,
        resourceRegistryIdentityDigest:
            resourceAuthority.identityDigest,
        resourceRegistrySnapshotDigest:
            resourceAuthority.snapshotDigest,
        sourceEventDigest: sourceAuthority.sourceEventDigest,
        sourceLedgerDigest: sourceAuthority.sourceLedgerDigest,
        sourceDispatchReceiptDigest:
            sourceAuthority.sourceDispatchReceiptDigest
    })
    const contract = seal({
        ...structuredClone(input),
        schema: 'issue-orchestration.frozen-stage-contract.v1',
        status: 'verified',
        acceptanceItems,
        stageAllowedPaths,
        stageForbiddenPaths,
        stageRequiredCommands,
        stageTerminalArtifacts,
        deterministicSlicePolicy,
        slicePolicyDigest,
        semanticContractDigest,
        authorityDigest,
        sourceEvent: sourceAuthority.sourceEvent,
        sourceEventDigest: sourceAuthority.sourceEventDigest,
        sourceLedgerDigest: sourceAuthority.sourceLedgerDigest,
        sourceLedgerObservedAt: sourceAuthority.sourceLedgerObservedAt,
        sourceDispatchReceiptDigest:
            sourceAuthority.sourceDispatchReceiptDigest,
        stageAttemptId: resourceLease.attemptId,
        activeWriteLeaseId: resourceLease.leaseId,
        resourceLeaseReceiptDigest: resourceLease.leaseDigest,
        runtimeStateRootDigest:
            resourceAuthority.location.runtimeStateRootDigest,
        runtimeAuthorityIdentityDigest:
            resourceAuthority.runtimeAuthorityIdentityDigest,
        resourceRegistryIdentityDigest:
            resourceAuthority.identityDigest,
        resourceRegistrySnapshotDigest:
            resourceAuthority.snapshotDigest,
        resourceRegistryObservedAt: resourceAuthority.observedAt,
        resourceLease
    }, 'receiptDigest')
    return persistCanonicalFrozenStageContract(contract)
}

export function compileStageWorkPlan(input) {
    if (input?.schema !== 'issue-orchestration.stage-work-plan-input.v1') {
        fail('stage-work-plan-input-schema', 'stage work plan input schema is required')
    }
    assertIdentity(input, 'stage-work-plan')
    assertHashes(input, [
        'semanticContractDigest', 'testContractDigest', 'authorityDigest',
        'skillDigest', 'baselineDigest', 'routingInputDigest'
    ], 'stage-work-plan')
    singleObjective(input.stageObjective, 'stageObjective')
    const acceptanceItems = stringList(input.acceptanceItems, 'acceptanceItems')
    if (!Array.isArray(input.orderedSlices) || input.orderedSlices.length === 0) {
        fail('ordered-slices-missing', 'orderedSlices are required')
    }
    if (!input.sliceDependencyGraph ||
        typeof input.sliceDependencyGraph !== 'object' ||
        Array.isArray(input.sliceDependencyGraph)) {
        fail('slice-dependency-graph-missing', 'sliceDependencyGraph is required')
    }
    const stageAllowedPaths = pathList(
        input.stageAllowedPaths,
        'stageAllowedPaths'
    )
    const stageForbiddenPaths = pathList(
        input.stageForbiddenPaths,
        'stageForbiddenPaths',
        { allowEmpty: true }
    )
    const stageRequiredCommands = stringList(
        input.stageRequiredCommands,
        'stageRequiredCommands'
    )
    const stageTerminalArtifacts = stringList(
        input.stageTerminalArtifacts,
        'stageTerminalArtifacts'
    )
    const contractBinding = frozenContractBinding(input)
    if (contractBinding.contractBindingStatus === 'verified') {
        exactObjectFields(
            input,
            BOUND_STAGE_WORK_PLAN_INPUT_FIELDS,
            'boundStageWorkPlanInput'
        )
    }
    const deterministicSlicePolicy =
        contractBinding.contractBindingStatus === 'verified'
            ? contractBinding.deterministicSlicePolicy
            : null
    const slicePolicyDigest =
        contractBinding.contractBindingStatus === 'verified'
            ? contractBinding.slicePolicyDigest
            : null
    if (contractBinding.contractBindingStatus === 'verified' &&
        (!deterministicSlicePolicy ||
            digest(deterministicSlicePolicy) !== slicePolicyDigest ||
            !sameValue(
                input.orderedSlices,
                deterministicSlicePolicy.orderedSliceBlueprints
            ))) {
        fail(
            'stage-work-plan-slice-policy',
            'caller slices must exactly match the frozen deterministic slice policy'
        )
    }
    const sliceIds = input.orderedSlices.map(({ sliceId }) => sliceId)
    if (sliceIds.some((item) => typeof item !== 'string' || !item) ||
        new Set(sliceIds).size !== sliceIds.length ||
        input.orderedSlices.some((slice, index) => slice.order !== index + 1) ||
        Object.keys(input.sliceDependencyGraph).sort().join('\n') !==
            [...sliceIds].sort().join('\n')) {
        fail('ordered-slices-invalid', 'orderedSlices and dependency graph must agree')
    }
    for (const slice of input.orderedSlices) {
        const expectedDependencies = input.sliceDependencyGraph[slice.sliceId]
        if (!Array.isArray(expectedDependencies) ||
            JSON.stringify(expectedDependencies) !==
                JSON.stringify(slice.prerequisiteSliceIds) ||
            expectedDependencies.some((item) => !sliceIds.includes(item))) {
            fail('slice-dependency-invalid', 'slice dependency graph is invalid')
        }
        if (expectedDependencies.some((item) =>
            sliceIds.indexOf(item) >= sliceIds.indexOf(slice.sliceId))) {
            fail(
                'slice-dependency-order',
                'slice dependencies must reference an earlier ordered slice'
            )
        }
    }
    if (deterministicSlicePolicy) {
        const expectedDependencyGraph = Object.fromEntries(
            deterministicSlicePolicy.orderedSliceBlueprints.map((slice) => [
                slice.sliceId,
                [...slice.prerequisiteSliceIds]
            ])
        )
        if (!sameValue(input.sliceDependencyGraph, expectedDependencyGraph)) {
            fail(
                'stage-work-plan-slice-policy-dependency',
                'caller dependency graph must exactly match the frozen slice policy'
            )
        }
    }
    const plannerReceipt = createVerifiedPlannerReceipt({
        contractBinding: {
            ...contractBinding,
            slicePolicyDigest
        },
        orderedSlices: input.orderedSlices,
        sliceDependencyGraph: input.sliceDependencyGraph
    })
    const plannerBinding = plannerReceipt
        ? {
            plannerBindingStatus: 'verified',
            deterministicSlicePolicy:
                structuredClone(deterministicSlicePolicy),
            slicePolicyDigest,
            plannerReceipt,
            plannerReceiptDigest: plannerReceipt.receiptDigest
        }
        : {
            plannerBindingStatus: 'unbound-test-only',
            deterministicSlicePolicy: null,
            slicePolicyDigest: null,
            plannerReceipt: null,
            plannerReceiptDigest: null
        }
    const body = {
        schema: 'issue-orchestration.stage-work-plan.v1',
        status: 'verified',
        runId: input.runId,
        repository: input.repository,
        issue: input.issue,
        node: input.node,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        baseSha: input.baseSha,
        epochId: input.epochId,
        worktreeIdentity: input.worktreeIdentity,
        semanticContractDigest: input.semanticContractDigest,
        testContractDigest: input.testContractDigest,
        authorityDigest: input.authorityDigest,
        skillDigest: input.skillDigest,
        baselineDigest: input.baselineDigest,
        routingInputDigest: input.routingInputDigest,
        ...contractBinding,
        ...plannerBinding,
        stageObjective: input.stageObjective,
        acceptanceItems,
        orderedSlices: structuredClone(input.orderedSlices),
        sliceDependencyGraph: structuredClone(input.sliceDependencyGraph),
        stageAllowedPaths,
        stageForbiddenPaths,
        stageRequiredCommands,
        stageTerminalArtifacts
    }
    const plan = seal(body, 'planDigest')
    for (const slice of plan.orderedSlices) {
        normalizeSliceDefinition(slice, plan)
    }
    const coveredAcceptance = new Set(
        plan.orderedSlices.flatMap(({ acceptanceItemIds }) => acceptanceItemIds)
    )
    if (acceptanceItems.some((item) => !coveredAcceptance.has(item))) {
        fail('acceptance-coverage-missing', 'every acceptance item needs a slice owner')
    }
    if (stageRequiredCommands.some((command) =>
        !plan.orderedSlices.some((slice) => slice.requiredCommands.includes(command)))) {
        fail('stage-command-coverage-missing', 'stage required command lacks a slice owner')
    }
    return plan
}

export function compileExecutableSlice({ plan, sliceId } = {}) {
    verifyPlanDigest(plan)
    nonEmptyString(sliceId, 'sliceId')
    const source = plan.orderedSlices.find((slice) => slice.sliceId === sliceId)
    if (!source) fail('slice-not-in-plan', 'executable slice is not in the verified plan')
    return seal(normalizeSliceDefinition(source, plan), 'sliceDigest')
}

function verifySliceBinding(plan, slice) {
    verifyPlanDigest(plan)
    singleObjective(slice?.singleObjective, 'single objective')
    nonEmptyString(slice.firstRequiredAction, 'firstRequiredAction')
    const hasWritablePath = typeof slice.firstWritablePath === 'string' &&
        slice.firstWritablePath.trim().length > 0
    const hasReadOnlyOutput = typeof slice.explicitReadOnlyOutput === 'string' &&
        slice.explicitReadOnlyOutput.trim().length > 0
    if (hasWritablePath === hasReadOnlyOutput) {
        fail(
            'slice-output-boundary',
            'firstWritablePath or explicit read-only output is required, exclusively'
        )
    }
    stringList(
        slice.requiredCreatedOrModifiedFiles ?? slice.requiredFiles,
        'requiredFiles',
        { allowEmpty: hasReadOnlyOutput }
    )
    stringList(slice.requiredCommands, 'requiredCommands')
    stringList(slice.explicitNonGoals, 'explicitNonGoals')
    if (slice?.schema !== 'issue-orchestration.executable-slice.v1' ||
        !HASH.test(slice.sliceDigest ?? '')) {
        fail('executable-slice-invalid', 'verified executable slice is required')
    }
    const expected = compileExecutableSlice({ plan, sliceId: slice.sliceId })
    if (expected.sliceDigest !== slice.sliceDigest ||
        JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(slice))) {
        fail(
            'executable-slice-plan-mismatch',
            'executable slice does not match its verified plan or single objective'
        )
    }
    return expected
}

function renderPrompt(slice) {
    return [
        `Single objective: ${slice.singleObjective}`,
        `First required action: ${slice.firstRequiredAction}`,
        'First read targets:',
        ...slice.firstReadTargets.map((item) => `- ${item}`),
        slice.firstWritablePath
            ? `First writable path: ${slice.firstWritablePath}`
            : `Explicit read-only output: ${slice.explicitReadOnlyOutput}`,
        'Required files:',
        ...(slice.requiredFiles.length
            ? slice.requiredFiles.map((item) => `- ${item}`)
            : ['- none (verified read-only slice)']),
        'Required commands:',
        ...slice.requiredCommands.map((item) => `- ${item}`),
        'Required evidence:',
        ...slice.requiredEvidence.map((item) => `- ${item}`),
        'Explicit non-goals:',
        ...slice.explicitNonGoals.map((item) => `- ${item}`),
        `Completion predicate: ${slice.completionPredicate}`,
        `Continuation predicate: ${slice.continuationPredicate}`,
        'Stop with a machine-verifiable checkpoint or terminal receipt.',
        'Before returning, verify filesystem paths, Git diff/tree identity, commands, and evidence.'
    ].join('\n')
}

export function compileDispatchPrompt({ plan, slice } = {}) {
    const verifiedSlice = verifySliceBinding(plan, slice)
    const compiled = {
        schema: 'issue-orchestration.compiled-dispatch-prompt.v1',
        planDigest: plan.planDigest,
        sliceId: verifiedSlice.sliceId,
        sliceDigest: verifiedSlice.sliceDigest,
        slicePolicyDigest: verifiedSlice.slicePolicyDigest,
        plannerReceiptDigest: verifiedSlice.plannerReceiptDigest,
        stageRole: verifiedSlice.stageRole,
        stagePhase: verifiedSlice.stagePhase,
        prompt: renderPrompt(verifiedSlice)
    }
    return seal(compiled, 'promptDigest')
}

export function validateCompiledDispatchPrompt({ plan, slice, compiled } = {}) {
    const errors = []
    try {
        const expected = compileDispatchPrompt({ plan, slice })
        if (compiled?.schema !== expected.schema) errors.push('compiled prompt schema mismatch')
        if (compiled?.promptDigest !== expected.promptDigest) {
            errors.push('compiled prompt digest mismatch; root-authored edits are forbidden')
        }
        if (compiled?.prompt !== expected.prompt) {
            errors.push('compiled prompt is not deterministic')
        }
        if (JSON.stringify(canonical(compiled)) !==
            JSON.stringify(canonical(expected))) {
            errors.push(
                'compiled prompt contains fields or instructions outside the verified compiler output'
            )
        }
        for (const field of [
            'planDigest',
            'sliceId',
            'sliceDigest',
            'slicePolicyDigest',
            'plannerReceiptDigest',
            'stageRole',
            'stagePhase'
        ]) {
            if (compiled?.[field] !== expected[field]) {
                errors.push(`compiled prompt ${field} mismatch`)
            }
        }
    } catch (error) {
        errors.push(error.message)
    }
    return errors
}

function expectedSealedExecutableSlice({
    plan,
    sliceId,
    authority
}) {
    verifySealedStageWorkPlan(plan, authority)
    nonEmptyString(sliceId, 'sealedSlice.sliceId')
    const source = plan.orderedSlices.find(
        (definition) => definition.sliceId === sliceId
    )
    if (!source) {
        fail(
            'sealed-executable-slice-not-in-plan',
            'sealed executable slice is not in its stage plan'
        )
    }
    return seal(
        normalizeSliceDefinition(source, plan),
        'sliceDigest'
    )
}

export function compileSealedExecutableSlice({
    plan,
    sliceId,
    authority
} = {}) {
    return expectedSealedExecutableSlice({
        plan,
        sliceId,
        authority
    })
}

export function validateSealedExecutableSlice({
    plan,
    slice,
    authority
} = {}) {
    return sealedValidationErrors(() => {
        const expected = expectedSealedExecutableSlice({
            plan,
            sliceId: slice?.sliceId,
            authority
        })
        if (!sameValue(slice, expected)) {
            fail(
                'sealed-executable-slice-mismatch',
                'sealed executable slice differs from deterministic plan output'
            )
        }
    })
}

export function compileSealedDispatchPrompt({
    plan,
    slice,
    sliceId = slice?.sliceId,
    authority
} = {}) {
    const expectedSlice = expectedSealedExecutableSlice({
        plan,
        sliceId,
        authority
    })
    if (slice !== undefined && !sameValue(slice, expectedSlice)) {
        fail(
            'sealed-executable-slice-mismatch',
            'sealed prompt slice differs from deterministic plan output'
        )
    }
    return seal({
        schema: 'issue-orchestration.compiled-dispatch-prompt.v1',
        planDigest: plan.planDigest,
        sliceId: expectedSlice.sliceId,
        sliceDigest: expectedSlice.sliceDigest,
        slicePolicyDigest: expectedSlice.slicePolicyDigest,
        plannerReceiptDigest:
            expectedSlice.plannerReceiptDigest,
        stageRole: expectedSlice.stageRole,
        stagePhase: expectedSlice.stagePhase,
        prompt: renderPrompt(expectedSlice)
    }, 'promptDigest')
}

export function validateSealedCompiledDispatchPrompt({
    plan,
    slice,
    compiled,
    authority
} = {}) {
    return sealedValidationErrors(() => {
        const expected = compileSealedDispatchPrompt({
            plan,
            slice,
            authority
        })
        if (!sameValue(compiled, expected)) {
            fail(
                'sealed-compiled-prompt-mismatch',
                'sealed compiled prompt differs from deterministic compiler output'
            )
        }
    })
}

const CHECKPOINT_FIELDS = Object.freeze([
    'schema',
    'runId',
    'node',
    'baseSha',
    'epochId',
    'worktreeIdentity',
    'sliceId',
    'sliceDigest',
    'status',
    'verificationStatus',
    'candidateState',
    'cursor',
    'nextRequiredAction',
    'evidence',
    'evidenceDigest',
    'treeDigest',
    'diffDigest',
    'commandEvidenceDigest',
    'checkpointDigest'
])
const CHECKPOINT_EVIDENCE_FIELDS = Object.freeze([
    'requiredFiles',
    'commands',
    'git',
    'satisfiedEvidenceIds',
    'typedEvidenceReceipts',
    'machineRuntimeTrace',
    'runtimeProgressObservation',
    'evidenceDigest'
])

function checkpointErrors({
    plan,
    slice,
    checkpoint,
    acceptedPriorChangedPaths = []
}) {
    const errors = []
    if (checkpoint?.schema !== 'issue-orchestration.stage-progress-checkpoint.v1') {
        errors.push('checkpoint schema mismatch')
        return errors
    }
    const expectedVerificationStatus =
        plan?.contractBindingStatus === 'verified'
            ? 'verified'
            : 'unbound-test-only'
    if (checkpoint.verificationStatus !== expectedVerificationStatus) {
        errors.push('checkpoint verificationStatus mismatch')
    }
    const unexpectedCheckpointFields = Object.keys(checkpoint)
        .filter((field) => !CHECKPOINT_FIELDS.includes(field))
    if (unexpectedCheckpointFields.length) {
        errors.push(
            `checkpoint contains unexpected fields: ${
                unexpectedCheckpointFields.join(', ')}`
        )
    }
    if (Array.isArray(plan?.orderedSlices)) {
        try {
            verifySliceBinding(plan, slice)
        } catch (error) {
            errors.push(`checkpoint executable slice is invalid: ${error.message}`)
        }
    }
    const contractSlice = slice
    let normalizedAcceptedPriorChangedPaths = []
    try {
        normalizedAcceptedPriorChangedPaths = concretePathList(
            acceptedPriorChangedPaths,
            'acceptedPriorChangedPaths',
            { allowEmpty: true }
        )
        const currentSliceIndex = plan?.orderedSlices?.findIndex(
            ({ sliceId }) => sliceId === slice?.sliceId
        ) ?? -1
        const priorSlices = currentSliceIndex > 0
            ? plan.orderedSlices.slice(0, currentSliceIndex)
            : []
        const currentRequiredPaths = new Set(
            slice?.requiredCreatedOrModifiedFiles ??
            slice?.requiredFiles ?? []
        )
        if (normalizedAcceptedPriorChangedPaths.some((filePath) =>
            !priorSlices.some((definition) =>
                (definition.allowedPaths ?? []).some((allowedPath) =>
                    pathScopeContains(allowedPath, filePath)) &&
                !(definition.forbiddenPaths ?? []).some((forbiddenPath) =>
                    pathScopeContains(forbiddenPath, filePath))) ||
            currentRequiredPaths.has(filePath))) {
            errors.push(
                'accepted prior changed paths are outside an earlier-slice boundary'
            )
        }
    } catch (error) {
        errors.push(
            `accepted prior changed paths are invalid: ${error.message}`
        )
    }
    const identityPairs = [
        ['runId', plan?.runId],
        ['node', plan?.node],
        ['baseSha', plan?.baseSha],
        ['epochId', plan?.epochId],
        ['worktreeIdentity', plan?.worktreeIdentity],
        ['sliceId', slice?.sliceId],
        ['sliceDigest', slice?.sliceDigest]
    ]
    for (const [field, expected] of identityPairs) {
        if (checkpoint[field] !== expected) errors.push(`checkpoint ${field} identity mismatch`)
    }
    if (!['partial', 'complete'].includes(checkpoint.status)) {
        errors.push('checkpoint status must be partial or complete')
    }
    const expectedCandidateState = checkpoint.status === 'complete'
        ? 'slice-complete'
        : 'in-progress'
    if (checkpoint.candidateState !== expectedCandidateState) {
        errors.push(
            'checkpoint candidateState must be derived from partial/complete status; only the terminal gate can authorize green'
        )
    }
    if (!checkpoint.cursor || typeof checkpoint.cursor !== 'object' ||
        !Number.isInteger(checkpoint.cursor.completedActionCount) ||
        checkpoint.cursor.completedActionCount < 0 ||
        !Number.isInteger(checkpoint.cursor.nextActionIndex) ||
        checkpoint.cursor.nextActionIndex < 0 ||
        typeof checkpoint.cursor.lastCompletedAction !== 'string' ||
        !checkpoint.cursor.lastCompletedAction) {
        errors.push('checkpoint cursor is invalid')
    }
    if (checkpoint.status === 'partial' &&
        (typeof checkpoint.nextRequiredAction !== 'string' ||
            !checkpoint.nextRequiredAction.trim() ||
            RESTART_INVESTIGATION.test(checkpoint.nextRequiredAction))) {
        errors.push('nextRequiredAction is required for a partial checkpoint')
    }
    if (checkpoint.status === 'complete' &&
        checkpoint.nextRequiredAction !== null) {
        errors.push('complete checkpoint cannot retain a nextRequiredAction')
    }
    const evidence = checkpoint.evidence
    let currentChangedPaths = []
    if (!evidence || typeof evidence !== 'object') {
        errors.push('machine evidence required; natural language narrative is not evidence')
    } else {
        const unexpectedEvidenceFields = Object.keys(evidence)
            .filter((field) =>
                !CHECKPOINT_EVIDENCE_FIELDS.includes(field))
        if (unexpectedEvidenceFields.length) {
            errors.push(
                `checkpoint evidence contains unexpected fields: ${
                    unexpectedEvidenceFields.join(', ')}`
            )
        }
        if (expectedVerificationStatus === 'verified' &&
            !Array.isArray(evidence.satisfiedEvidenceIds)) {
            errors.push(
                'verified checkpoint evidence satisfiedEvidenceIds are required'
            )
        }
        let worktreeRoot = null
        if (typeof plan?.worktreeIdentity !== 'string' ||
            !fs.existsSync(plan.worktreeIdentity)) {
            errors.push('machine filesystem worktree identity is not observable')
        } else {
            try {
                worktreeRoot = fs.realpathSync(plan.worktreeIdentity)
            } catch {
                errors.push('machine filesystem worktree identity is not reproducible')
            }
        }
        if (!Array.isArray(evidence.commands) ||
            evidence.commands.length === 0 ||
            evidence.commands.some((entry) =>
                typeof entry?.command !== 'string' ||
                !entry.command.trim() ||
                !Number.isInteger(entry?.exitStatus) ||
                !HASH.test(entry?.outputDigest ?? ''))) {
            errors.push('machine command evidence required')
        } else if (worktreeRoot) {
            for (const entry of evidence.commands) {
                const observed = observeCommand(entry.command, worktreeRoot)
                if (!observed.reproducible ||
                    observed.exitStatus !== entry.exitStatus ||
                    observed.outputDigest !== entry.outputDigest) {
                    errors.push(
                        'machine command evidence does not match an independently rerun command'
                    )
                    break
                }
            }
        }
        const readOnlyCheckpoint =
            typeof contractSlice?.explicitReadOnlyOutput === 'string' &&
            contractSlice.explicitReadOnlyOutput.trim().length > 0 &&
            (contractSlice.requiredCreatedOrModifiedFiles ??
                contractSlice.requiredFiles ?? []).length === 0
        if (!Array.isArray(evidence.requiredFiles) ||
            (!readOnlyCheckpoint && evidence.requiredFiles.length === 0) ||
            evidence.requiredFiles.some((entry) =>
                typeof entry?.path !== 'string' ||
                typeof entry?.realPath !== 'string' ||
                !path.isAbsolute(entry.realPath) ||
                !GIT_DIGEST.test(entry.gitObjectDigest ?? '') ||
                !fs.existsSync(entry.realPath))) {
            errors.push('machine filesystem evidence required')
        } else if (worktreeRoot) {
            for (const entry of evidence.requiredFiles) {
                try {
                    const expectedPath = fs.realpathSync(
                        path.resolve(worktreeRoot, entry.path)
                    )
                    if (expectedPath !== entry.realPath ||
                        expectedPath !== worktreeRoot &&
                            !expectedPath.startsWith(`${worktreeRoot}${path.sep}`)) {
                        errors.push('machine filesystem evidence escaped its worktree')
                        break
                    }
                    const observedObject = execFileSync(
                        'git',
                        ['hash-object', entry.path],
                        { cwd: worktreeRoot, encoding: 'utf8' }
                    ).trim()
                    if (observedObject !== entry.gitObjectDigest) {
                        errors.push('machine filesystem Git object digest mismatch')
                        break
                    }
                } catch {
                    errors.push('machine filesystem evidence is not reproducible')
                    break
                }
            }
        }
        if (!GIT_DIGEST.test(evidence.git?.headSha ?? '') ||
            typeof evidence.git?.worktreeStatus !== 'string') {
            errors.push('machine Git evidence required')
        } else if (worktreeRoot) {
            try {
                const observedHead = execFileSync(
                    'git',
                    ['rev-parse', 'HEAD'],
                    {
                        cwd: fs.realpathSync(plan.worktreeIdentity),
                        encoding: 'utf8'
                    }
                ).trim()
                const observedStatus = execFileSync(
                    'git',
                    Array.isArray(slice?.allowedPaths)
                        ? [
                            'status',
                            '--short',
                            '--untracked-files=all'
                        ]
                        : [
                            'status',
                            '--short',
                            '--',
                            ...(evidence.requiredFiles ?? [])
                                .map(({ path: filePath }) => filePath)
                        ],
                    {
                        cwd: worktreeRoot,
                        encoding: 'utf8'
                    }
                ).replace(/\r?\n$/u, '')
                if (observedHead !== evidence.git.headSha ||
                    observedHead !== plan.baseSha) {
                    errors.push('machine Git base/head identity mismatch')
                }
                if (observedStatus !== evidence.git.worktreeStatus) {
                    errors.push(
                        'machine Git worktree status does not match independent observation'
                    )
                }
                if (Array.isArray(contractSlice?.allowedPaths)) {
                    const changedPaths = statusChangedPaths(observedStatus)
                    const acceptedPriorPathSet = new Set(
                        normalizedAcceptedPriorChangedPaths
                    )
                    currentChangedPaths = changedPaths.filter(
                        (filePath) =>
                            !acceptedPriorPathSet.has(filePath)
                    )
                    const evidencedPaths = new Set(
                        (evidence.requiredFiles ?? [])
                            .map(({ path: filePath }) => filePath)
                    )
                    if (normalizedAcceptedPriorChangedPaths.some(
                        (filePath) => !changedPaths.includes(filePath)
                    )) {
                        errors.push(
                            'accepted prior changed path is absent from the machine Git observation'
                        )
                    }
                    if (currentChangedPaths.some((filePath) =>
                        !contractSlice.allowedPaths.some((allowedPath) =>
                            pathScopeContains(allowedPath, filePath))) ||
                        currentChangedPaths.some((filePath) =>
                            (contractSlice.forbiddenPaths ?? [])
                                .some((forbiddenPath) =>
                                pathScopeContains(forbiddenPath, filePath)))) {
                        errors.push(
                            'machine Git observation contains an unauthorized changed path'
                        )
                    }
                    if (currentChangedPaths.some((filePath) =>
                        !evidencedPaths.has(filePath))) {
                        errors.push(
                            'machine Git changed path lacks filesystem evidence'
                        )
                    }
                    if (Number.isInteger(contractSlice.maxChangedFiles) &&
                        currentChangedPaths.length >
                            contractSlice.maxChangedFiles) {
                        errors.push(
                            'machine Git changed path count exceeds the executable slice capacity'
                        )
                    }
                }
            } catch {
                errors.push('machine Git evidence is not reproducible')
            }
        }
        if (!HASH.test(evidence.evidenceDigest ?? '') ||
            evidence.evidenceDigest !== unsignedDigest(
                evidence,
                'evidenceDigest'
            )) {
            errors.push('machine evidence digest mismatch')
        }
        if (checkpoint.evidenceDigest !== evidence.evidenceDigest) {
            errors.push('checkpoint evidenceDigest mismatch')
        }
        const expectedTreeDigest = digest(
            [...(evidence.requiredFiles ?? [])]
                .map(({ path: filePath, realPath, gitObjectDigest }) => ({
                    path: filePath,
                    realPath,
                    gitObjectDigest
                }))
                .sort((left, right) => left.path.localeCompare(right.path))
        )
        const expectedDiffDigest = digest({
            baseSha: plan?.baseSha,
            headSha: evidence.git?.headSha,
            worktreeStatus: evidence.git?.worktreeStatus,
            treeDigest: expectedTreeDigest
        })
        const expectedCommandEvidenceDigest = digest(
            evidence.commands ?? []
        )
        if (checkpoint.treeDigest !== expectedTreeDigest ||
            checkpoint.diffDigest !== expectedDiffDigest ||
            checkpoint.commandEvidenceDigest !==
                expectedCommandEvidenceDigest) {
            errors.push('checkpoint filesystem/Git/command digest mismatch')
        }
        if (checkpoint.status === 'complete') {
            const observedFiles = new Set(
                evidence.requiredFiles?.map(({ path: filePath }) => filePath)
            )
            const commands = new Map(
                evidence.commands?.map((entry) => [entry.command, entry])
            )
            const satisfiedEvidenceIds = new Set(
                evidence.satisfiedEvidenceIds ?? []
            )
            const requiredFiles =
                contractSlice.requiredCreatedOrModifiedFiles ??
                contractSlice.requiredFiles ?? []
            if (requiredFiles.some((filePath) =>
                !observedFiles.has(filePath))) {
                errors.push('complete checkpoint required files are missing')
            }
            if (!readOnlyCheckpoint &&
                requiredFiles.some((filePath) =>
                    !currentChangedPaths.includes(filePath))) {
                errors.push(
                    'complete checkpoint required writable files are absent from the current slice Git delta'
                )
            }
            if ((contractSlice.requiredCommands ?? []).some((command) =>
                commands.get(command)?.exitStatus !== 0)) {
                errors.push('complete checkpoint required commands are missing or failed')
            }
            if ((contractSlice.requiredEvidence ?? []).some((evidenceId) =>
                !satisfiedEvidenceIds.has(evidenceId))) {
                errors.push('complete checkpoint required evidence is missing')
            }
        }
    }
    if (!HASH.test(checkpoint.checkpointDigest ?? '') ||
        unsignedDigest(checkpoint, 'checkpointDigest') !==
            checkpoint.checkpointDigest) {
        errors.push('checkpoint digest mismatch')
    }
    return errors
}

export function sealProgressCheckpoint({
    plan,
    slice,
    checkpoint,
    acceptedPriorChangedPaths = []
} = {}) {
    if (!plan || !slice || !checkpoint) {
        fail('checkpoint-input-missing', 'plan, slice and checkpoint are required')
    }
    const candidateState = checkpoint.status === 'complete'
        ? 'slice-complete'
        : 'in-progress'
    if (checkpoint.candidateState !== undefined &&
        checkpoint.candidateState !== candidateState) {
        fail(
            'checkpoint-candidate-state-invalid',
            'checkpoint candidateState must match its partial/complete status'
        )
    }
    const body = {
        ...structuredClone(checkpoint),
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        candidateState,
        verificationStatus:
            plan.contractBindingStatus === 'verified'
                ? 'verified'
                : 'unbound-test-only'
    }
    body.treeDigest = digest(
        [...(body.evidence?.requiredFiles ?? [])]
            .map(({ path: filePath, realPath, gitObjectDigest }) => ({
                path: filePath,
                realPath,
                gitObjectDigest
            }))
            .sort((left, right) => left.path.localeCompare(right.path))
    )
    body.diffDigest = digest({
        baseSha: plan?.baseSha,
        headSha: body.evidence?.git?.headSha,
        worktreeStatus: body.evidence?.git?.worktreeStatus,
        treeDigest: body.treeDigest
    })
    body.commandEvidenceDigest = digest(body.evidence?.commands ?? [])
    const candidate = seal(body, 'checkpointDigest')
    const errors = checkpointErrors({
        plan,
        slice,
        checkpoint: candidate,
        acceptedPriorChangedPaths
    })
    if (errors.length) fail('checkpoint-invalid', errors.join('; '))
    return candidate
}

export function validateProgressCheckpoint({
    plan,
    slice,
    checkpoint,
    acceptedPriorChangedPaths = []
} = {}) {
    return checkpointErrors({
        plan,
        slice,
        checkpoint,
        acceptedPriorChangedPaths
    })
}

function validateSealedCheckpointEnvelope({
    plan,
    slice,
    checkpoint
}) {
    const errors = []
    if (checkpoint?.schema !==
        'issue-orchestration.stage-progress-checkpoint.v1') {
        errors.push('sealed checkpoint schema mismatch')
        return errors
    }
    if (checkpoint.verificationStatus !== 'verified') {
        errors.push('sealed checkpoint verificationStatus mismatch')
    }
    for (const [field, expected] of [
        ['runId', plan?.runId],
        ['node', plan?.node],
        ['baseSha', plan?.baseSha],
        ['epochId', plan?.epochId],
        ['worktreeIdentity', plan?.worktreeIdentity],
        ['sliceId', slice?.sliceId],
        ['sliceDigest', slice?.sliceDigest]
    ]) {
        if (checkpoint[field] !== expected) {
            errors.push(`sealed checkpoint ${field} identity mismatch`)
        }
    }
    if (!['partial', 'complete'].includes(checkpoint.status)) {
        errors.push('sealed checkpoint status must be partial or complete')
    }
    if (!checkpoint.cursor || typeof checkpoint.cursor !== 'object' ||
        !Number.isInteger(checkpoint.cursor.completedActionCount) ||
        checkpoint.cursor.completedActionCount < 0 ||
        !Number.isInteger(checkpoint.cursor.nextActionIndex) ||
        checkpoint.cursor.nextActionIndex < 0 ||
        typeof checkpoint.cursor.lastCompletedAction !== 'string' ||
        !checkpoint.cursor.lastCompletedAction) {
        errors.push('sealed checkpoint cursor is invalid')
    }
    if (checkpoint.status === 'partial' &&
        (typeof checkpoint.nextRequiredAction !== 'string' ||
            !checkpoint.nextRequiredAction.trim() ||
            RESTART_INVESTIGATION.test(checkpoint.nextRequiredAction))) {
        errors.push(
            'sealed checkpoint nextRequiredAction is invalid'
        )
    }
    if (checkpoint.status === 'complete' &&
        checkpoint.nextRequiredAction !== null) {
        errors.push(
            'sealed complete checkpoint cannot retain a nextRequiredAction'
        )
    }
    if (!checkpoint.evidence || typeof checkpoint.evidence !== 'object' ||
        !HASH.test(checkpoint.evidence.evidenceDigest ?? '') ||
        checkpoint.evidence.evidenceDigest !== unsignedDigest(
            checkpoint.evidence,
            'evidenceDigest'
        ) ||
        checkpoint.evidenceDigest !==
            checkpoint.evidence.evidenceDigest) {
        errors.push('sealed checkpoint evidence digest mismatch')
    }
    if (!HASH.test(checkpoint.treeDigest ?? '') ||
        checkpoint.treeDigest !== digest(
            [...(checkpoint.evidence?.requiredFiles ?? [])]
                .map(({
                    path: filePath,
                    realPath,
                    gitObjectDigest
                }) => ({
                    path: filePath,
                    realPath,
                    gitObjectDigest
                }))
                .sort((left, right) =>
                    left.path.localeCompare(right.path))
        )) {
        errors.push('sealed checkpoint tree digest mismatch')
    }
    if (!HASH.test(checkpoint.diffDigest ?? '') ||
        checkpoint.diffDigest !== digest({
            baseSha: plan?.baseSha,
            headSha: checkpoint.evidence?.git?.headSha,
            worktreeStatus:
                checkpoint.evidence?.git?.worktreeStatus,
            treeDigest: checkpoint.treeDigest
        })) {
        errors.push('sealed checkpoint diff digest mismatch')
    }
    if (!HASH.test(checkpoint.commandEvidenceDigest ?? '') ||
        checkpoint.commandEvidenceDigest !== digest(
            checkpoint.evidence?.commands ?? []
        )) {
        errors.push(
            'sealed checkpoint command evidence digest mismatch'
        )
    }
    if (!HASH.test(checkpoint.checkpointDigest ?? '') ||
        checkpoint.checkpointDigest !== unsignedDigest(
            checkpoint,
            'checkpointDigest'
        )) {
        errors.push('sealed checkpoint digest mismatch')
    }
    return errors
}

function sealContinuationReceipt({
    plan,
    slice,
    checkpoint,
    checkpointVerificationReceiptDigest,
    checkpointOrdinal,
    previousCheckpointDigest,
    previousCheckpointVerificationReceiptDigest,
    previousMachineTracePrefixDigest,
    previousMachineTracePrefixByteLength,
    machineTracePrefixDigest,
    machineTracePrefixByteLength,
    completedSlicePrefixDigest,
    acceptedPriorChangedPathsDigest,
    requestedResume
}) {
    if (!HASH.test(checkpointVerificationReceiptDigest ?? '')) {
        fail(
            'continuation-verification-receipt-missing',
            'checkpointVerificationReceiptDigest is required'
        )
    }
    if (!Number.isInteger(checkpointOrdinal) ||
        checkpointOrdinal < 1 ||
        !HASH.test(machineTracePrefixDigest ?? '') ||
        !Number.isInteger(machineTracePrefixByteLength) ||
        machineTracePrefixByteLength <= 0 ||
        !HASH.test(completedSlicePrefixDigest ?? '') ||
        !HASH.test(acceptedPriorChangedPathsDigest ?? '')) {
        fail(
            'continuation-checkpoint-chain-invalid',
            'continuation checkpoint ordinal, trace prefix, completed-slice prefix and accepted-path bindings are required'
        )
    }
    if (checkpointOrdinal === 1 &&
        [previousCheckpointDigest,
            previousCheckpointVerificationReceiptDigest,
            previousMachineTracePrefixDigest,
            previousMachineTracePrefixByteLength]
            .some((value) => value !== null) ||
        checkpointOrdinal > 1 &&
        (!HASH.test(previousCheckpointDigest ?? '') ||
            !HASH.test(
                previousCheckpointVerificationReceiptDigest ?? ''
            ) ||
            !HASH.test(previousMachineTracePrefixDigest ?? '') ||
            !Number.isInteger(
                previousMachineTracePrefixByteLength
            ) ||
            previousMachineTracePrefixByteLength <= 0 ||
            previousMachineTracePrefixByteLength >=
                machineTracePrefixByteLength)) {
        fail(
            'continuation-checkpoint-chain-invalid',
            'continuation prior checkpoint and immutable trace prefix chain are inconsistent'
        )
    }
    if (checkpoint.status !== 'partial') {
        fail(
            'continuation-terminal',
            'terminal checkpoint does not need continuation'
        )
    }
    if (requestedResume &&
        (requestedResume.mode !== 'checkpoint-cursor' ||
            Object.keys(requestedResume).some(
                (field) => field !== 'mode'))) {
        fail(
            'continuation-restart-forbidden',
            'continuation cannot restart or reinvestigate the whole issue; resume its cursor'
        )
    }
    return seal({
        schema: 'issue-orchestration.stage-continuation-receipt.v1',
        runId: plan.runId,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        checkpointDigest: checkpoint.checkpointDigest,
        checkpointVerificationReceiptDigest,
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength,
        machineTracePrefixDigest,
        machineTracePrefixByteLength,
        completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest,
        resumeCursor: structuredClone(checkpoint.cursor),
        nextRequiredAction: checkpoint.nextRequiredAction,
        restartInvestigation: false
    }, 'receiptDigest')
}

export function compileContinuation({
    plan,
    slice,
    checkpoint,
    checkpointVerificationReceiptDigest,
    checkpointOrdinal,
    previousCheckpointDigest = null,
    previousCheckpointVerificationReceiptDigest = null,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    machineTracePrefixDigest,
    machineTracePrefixByteLength,
    completedSlicePrefixDigest,
    acceptedPriorChangedPathsDigest,
    requestedResume,
    acceptedPriorChangedPaths = []
} = {}) {
    const errors = checkpointErrors({
        plan,
        slice,
        checkpoint,
        acceptedPriorChangedPaths
    })
    if (errors.length) {
        fail('continuation-checkpoint-invalid', `checkpoint identity/digest invalid: ${errors.join('; ')}`)
    }
    const expectedAcceptedPriorChangedPathsDigest = digest(
        [...acceptedPriorChangedPaths].sort()
    )
    if (plan.contractBindingStatus !== 'verified') {
        const unboundTracePrefix = {
            schema:
                'issue-orchestration.unbound-test-only-trace-prefix.v1',
            checkpointDigest: checkpoint.checkpointDigest,
            evidenceDigest: checkpoint.evidenceDigest
        }
        checkpointVerificationReceiptDigest ??= digest({
            schema:
                'issue-orchestration.unbound-test-only-checkpoint-verification.v1',
            checkpointDigest: checkpoint.checkpointDigest
        })
        checkpointOrdinal ??= 1
        previousCheckpointDigest ??= null
        previousCheckpointVerificationReceiptDigest ??= null
        previousMachineTracePrefixDigest ??= null
        previousMachineTracePrefixByteLength ??= null
        machineTracePrefixDigest ??= digest(unboundTracePrefix)
        machineTracePrefixByteLength ??= Buffer.byteLength(
            JSON.stringify(canonical(unboundTracePrefix))
        )
        completedSlicePrefixDigest ??= digest([])
        acceptedPriorChangedPathsDigest ??=
            expectedAcceptedPriorChangedPathsDigest
    }
    if (acceptedPriorChangedPathsDigest !==
        expectedAcceptedPriorChangedPathsDigest) {
        fail(
            'continuation-accepted-prior-paths-invalid',
            'continuation acceptedPriorChangedPathsDigest differs from the validated prior-slice boundary'
        )
    }
    return sealContinuationReceipt({
        plan,
        slice,
        checkpoint,
        checkpointVerificationReceiptDigest,
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength,
        machineTracePrefixDigest,
        machineTracePrefixByteLength,
        completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest,
        requestedResume
    })
}

export function compileSealedContinuation({
    plan,
    slice,
    compiledPrompt,
    checkpoint,
    checkpointVerificationReceiptDigest,
    checkpointOrdinal,
    previousCheckpointDigest = null,
    previousCheckpointVerificationReceiptDigest = null,
    previousMachineTracePrefixDigest = null,
    previousMachineTracePrefixByteLength = null,
    machineTracePrefixDigest,
    machineTracePrefixByteLength,
    completedSlicePrefixDigest,
    acceptedPriorChangedPathsDigest,
    authority,
    requestedResume
} = {}) {
    const errors = [
        ...validateSealedStageWorkPlan(plan, authority),
        ...validateSealedExecutableSlice({
            plan,
            slice,
            authority
        }),
        ...validateSealedCompiledDispatchPrompt({
            plan,
            slice,
            compiled: compiledPrompt,
            authority
        }),
        ...validateSealedCheckpointEnvelope({
            plan,
            slice,
            checkpoint
        })
    ]
    if (errors.length) {
        fail(
            'sealed-continuation-invalid',
            `sealed continuation authority is invalid: ${
                [...new Set(errors)].join('; ')
            }`
        )
    }
    return sealContinuationReceipt({
        plan,
        slice,
        checkpoint,
        checkpointVerificationReceiptDigest,
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength,
        machineTracePrefixDigest,
        machineTracePrefixByteLength,
        completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest,
        requestedResume
    })
}
