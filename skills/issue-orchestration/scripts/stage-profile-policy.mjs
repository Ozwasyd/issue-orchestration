import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// Shared issue-orchestration package runtime.

const HASH = /^[a-f0-9]{64}$/u

function loadPolicy(name) {
    const file = path.resolve(import.meta.dirname, '../../../policy', name)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const MODEL_POOL = loadPolicy('model-pool.json')
const ROUTING_POLICY = loadPolicy('routing-policy.json')
const STAGE_PERMISSIONS = loadPolicy('stage-permissions.json')

if (MODEL_POOL.schema
        !== 'issue-orchestration.stage-model-pool-policy.v2'
    || ROUTING_POLICY.schema !== 'issue-orchestration.routing-policy.v2'
    || STAGE_PERMISSIONS.schema
        !== 'issue-orchestration.stage-permissions.v1'
    || MODEL_POOL.version !== ROUTING_POLICY.version) {
    throw new Error('routing-policy-source-invalid')
}

export const ROUTING_POLICY_VERSION = MODEL_POOL.version

export const REQUIRED_ROUTING_FIELDS = Object.freeze(
    [...ROUTING_POLICY.requiredClassificationFields]
)

export const ROUTING_ENUMS = Object.freeze(Object.fromEntries(
    Object.entries(ROUTING_POLICY.classificationEnums)
        .map(([field, values]) => [field, Object.freeze([...values])])
))

export const REQUIRED_STAGE_PROFILE_FIELDS = Object.freeze([
    'stageProfilePolicyVersion',
    'stageRole',
    'stagePhase',
    'allowedProfiles',
    'defaultProfile',
    'routingAuthority',
    'routingInputDigest',
    'selectedProfile',
    'selectedProfileReason',
    'sandbox',
    'writeScope',
    'requiredSkillDigests',
    'capabilityDigest'
])

const STAGES = Object.freeze(Object.fromEntries(
    Object.entries(MODEL_POOL.stages).map(([key, modelStage]) => {
        const permission = STAGE_PERMISSIONS.stages[key]
        if (!permission) throw new Error(`stage-permission-missing:${key}`)
        for (const profile of modelStage.allowedProfiles) {
            if (!MODEL_POOL.profiles[profile]) {
                throw new Error(`stage-profile-missing:${profile}`)
            }
        }
        return [key, Object.freeze({
            allowedProfiles: Object.freeze([...modelStage.allowedProfiles]),
            defaultProfile: modelStage.defaultProfile,
            sandbox: permission.sandbox,
            writeScope: permission.writeScope,
            freshContext: permission.freshContext
        })]
    })
))

export const STAGE_ROUTE_DEFINITIONS = STAGES

export const STAGE_MODEL_POOL_POLICY = Object.freeze({
    schema: MODEL_POOL.schema,
    version: ROUTING_POLICY_VERSION,
    routingAuthority: MODEL_POOL.routingAuthority,
    requiredRoutingFields: REQUIRED_ROUTING_FIELDS,
    requiredStageProfileFields: REQUIRED_STAGE_PROFILE_FIELDS,
    profiles: Object.freeze(structuredClone(MODEL_POOL.profiles)),
    stages: STAGES,
    cleanup: Object.freeze(structuredClone(MODEL_POOL.cleanup)),
    forbiddenRoutingInputs: Object.freeze([...ROUTING_POLICY.forbiddenInputs])
})

export class StageProfileError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'StageProfileError'
        this.code = code
    }
}

function fail(code, message) {
    throw new StageProfileError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function sameValues(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
}

function routeKey(stageRole, stagePhase) {
    return `${stageRole}:${stagePhase}`
}

export function stageDefinitionsForRole(stageRole) {
    return Object.fromEntries(Object.entries(STAGES)
        .filter(([key]) => key.startsWith(`${stageRole}:`)))
}

export function splitProfile(profileId) {
    const profile = MODEL_POOL.profiles[profileId]
    if (!profile) fail('routing-profile-id')
    return Object.freeze({
        profileId,
        model: profile.model,
        effort: profile.effort
    })
}

function assertHash(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

function assertNoLegacyAuthority(value) {
    if (value?.node?.model || value?.node?.effort
        || value?.implementationProfile || value?.reviewProfile) {
        fail('routing-legacy-authority')
    }
}

export function validateRoutingClassification(value) {
    if (!value || typeof value !== 'object') fail('routing-classification')
    for (const field of REQUIRED_ROUTING_FIELDS) {
        if (!Object.hasOwn(value, field)) {
            fail('routing-classification-field', `Missing ${field}.`)
        }
    }
    for (const [field, allowed] of Object.entries(ROUTING_ENUMS)) {
        if (!allowed.includes(value[field])) {
            fail('routing-classification-enum', `Invalid ${field}.`)
        }
    }
    if (typeof value.effectiveOwnerRepository !== 'string'
        || !/^[^/\s]+\/[^/\s]+$/u.test(value.effectiveOwnerRepository)) {
        fail('routing-owner-repository')
    }
    assertHash(value.modelRoutingEvidenceDigest, 'routing-evidence-digest')
    if (value.routingPolicyVersion !== ROUTING_POLICY_VERSION) {
        fail('routing-policy-version')
    }
    return value
}

function selectDagProfile(input) {
    const selector = ROUTING_POLICY.selectors[
        'dag-creator-updater:semantic-proposal'
    ]
    if (input.engineeringRiskClass === 'frontier'
        && input.frontierException === true) {
        return [selector.frontierException, 'dag-frontier-exception']
    }
    if (input.contractState === 'authority-conflict'
        || input.contractState === 'owner-unresolved'
        || input.engineeringRiskClass === 'frontier') {
        return [
            selector.authorityOrTopologyConflict,
            'dag-authority-or-topology-conflict'
        ]
    }
    return [selector.default, 'dag-semantic-proposal-default']
}

function selectTestOwnerProfile(input, key) {
    const selector = ROUTING_POLICY.selectors[key]
    if (['protocol', 'security'].includes(input.verificationClass)
        || input.contractState === 'authority-conflict') {
        return [
            selector.protocolSecurityOrAuthority,
            'verification-protocol-security-or-authority'
        ]
    }
    if (input.verificationClass === 'runtime'
        || input.engineeringRiskClass === 'high-risk'
        || input.engineeringRiskClass === 'frontier') {
        return [
            selector.runtimeOrLifecycle,
            'verification-runtime-or-lifecycle-risk'
        ]
    }
    return [selector.focused, 'verification-focused-or-cross-module']
}

function selectCodeProfile(input) {
    const selected = ROUTING_POLICY.selectors[
        'code-implementer:implementation'
    ][input.engineeringRiskClass]
    return selected
        ? [selected, `engineering-risk-${input.engineeringRiskClass}`]
        : undefined
}

function selectUiProfile(input) {
    if (input.domain !== 'ui-ux') fail('routing-ui-domain')
    if (input.uiDecisionClass === 'system-design-dispute') {
        fail('routing-ui-adjudication-required')
    }
    const selected = ROUTING_POLICY.selectors[
        'ui-ux-implementer:implementation'
    ][input.uiDecisionClass]
    if (selected) return [selected, `ui-${input.uiDecisionClass}`]
    fail('routing-ui-classification')
}

function selectAdjudicatorProfile(input) {
    if (input.domain !== 'ui-ux'
        || input.uiDecisionClass !== 'system-design-dispute') {
        fail('routing-ui-adjudication-not-required')
    }
    const selector = ROUTING_POLICY.selectors[
        'ui-system-adjudicator:adjudication'
    ]
    if (input.contractState === 'authority-conflict') {
        return [selector['authority-conflict'], 'ui-system-authority-conflict']
    }
    return [
        selector['system-design-dispute'],
        'ui-system-design-dispute'
    ]
}

function selectUxProfile(input) {
    if (input.domain !== 'ui-ux') fail('routing-ui-domain')
    const selected = ROUTING_POLICY.selectors[
        'ux-acceptance-verifier:ux-acceptance'
    ][input.verificationClass]
    const route = selected
        ? [selected, input.verificationClass]
        : undefined
    if (!route) fail('routing-ux-verification-class')
    return route
}

function selectDocumentationProfile(input) {
    if (input.domain !== 'documentation') fail('routing-documentation-domain')
    const selector = ROUTING_POLICY.selectors[
        'documentation-writer:documentation'
    ]
    return input.engineeringRiskClass === 'bounded'
        ? [selector.bounded, 'documentation-current-sync']
        : [selector.complex, 'documentation-complex-authority-migration']
}

function selectProfile(input, key) {
    if (key === 'root-scheduler:scheduling') {
        return [STAGES[key].defaultProfile, 'root-scheduler-policy']
    }
    if (key === 'dag-creator-updater:semantic-proposal') {
        return selectDagProfile(input)
    }
    if (key === 'test-owner:test-contract'
        || key === 'test-owner:behavior-verification') {
        return selectTestOwnerProfile(input, key)
    }
    if (key === 'code-implementer:implementation') {
        if (input.domain === 'ui-ux') fail('routing-ui-owner')
        return selectCodeProfile(input)
    }
    if (key === 'ui-ux-implementer:implementation') {
        return selectUiProfile(input)
    }
    if (key === 'ui-system-adjudicator:adjudication') {
        return selectAdjudicatorProfile(input)
    }
    if (key === 'ux-acceptance-verifier:ux-acceptance') {
        return selectUxProfile(input)
    }
    if (key === 'documentation-writer:documentation') {
        return selectDocumentationProfile(input)
    }
    fail('routing-stage-role-phase')
}

export function compileStageRoute(input) {
    assertNoLegacyAuthority(input)
    validateRoutingClassification(input)
    const key = routeKey(input.stageRole, input.stagePhase)
    const definition = STAGES[key]
    if (!definition) fail('routing-stage-role-phase')
    const [selectedProfile, selectedProfileReason] = selectProfile(input, key)
    const routingInput = {
        classification: Object.fromEntries(REQUIRED_ROUTING_FIELDS
            .map((field) => [field, input[field]])),
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        frontierException: input.frontierException === true
    }
    const requiredSkillDigests = Array.isArray(input.requiredSkillDigests)
        ? [...input.requiredSkillDigests]
        : []
    const capabilityDigest = HASH.test(input.capabilityDigest ?? '')
        ? input.capabilityDigest
        : digest({
                policyVersion: ROUTING_POLICY_VERSION,
                selectedProfile,
                allowedProfiles: definition.allowedProfiles
            })
    return Object.freeze({
        stageProfilePolicyVersion: ROUTING_POLICY_VERSION,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        allowedProfiles: [...definition.allowedProfiles],
        defaultProfile: definition.defaultProfile,
        routingAuthority: STAGE_MODEL_POOL_POLICY.routingAuthority,
        routingInputDigest: digest(routingInput),
        selectedProfile,
        selectedProfileReason,
        sandbox: definition.sandbox,
        writeScope: definition.writeScope,
        requiredSkillDigests,
        capabilityDigest
    })
}

function validateFreshContext(value, definition) {
    if (!definition.freshContext) return
    if (value.freshContext !== true
        || value.forkTurns === 'all'
        || value.inheritedThreadId) {
        fail('routing-verifier-fresh-context')
    }
}

function validateRuntimeCapability(value) {
    const capability = value.runtimeCapability
    if (!capability) return
    if (capability.available !== true
        || capability.requestedProfile !== value.selectedProfile
        || capability.effectiveProfile !== value.selectedProfile) {
        fail('runtime-capability-missing')
    }
}

function validateCandidate(value) {
    if (!value.candidate) return
    if (value.candidate.status !== 'candidate-green') {
        fail('routing-candidate-status')
    }
    if (value.candidate.frozenTestTreeDigestBefore
        !== value.candidate.frozenTestTreeDigestAfter
        || (value.candidate.modifiedPaths ?? []).some((path) =>
            path.startsWith('tests/'))) {
        fail('routing-frozen-test-tree')
    }
    if (value.action === 'sign-behavior-green'
        || value.action === 'sign-ux-accepted') {
        fail('routing-independent-verification-authority')
    }
}

export function validateStageAssignment(value) {
    assertNoLegacyAuthority(value)
    if (value?.schema !== 'issue-orchestration.stage-assignment.v2') {
        fail('routing-assignment-schema')
    }
    for (const field of REQUIRED_STAGE_PROFILE_FIELDS) {
        if (!Object.hasOwn(value, field)) fail('routing-stage-profile-field')
    }
    validateRoutingClassification(value.classification)
    const key = routeKey(value.stageRole, value.stagePhase)
    const definition = STAGES[key]
    if (!definition) fail('routing-stage-role-phase')
    if (value.stageProfilePolicyVersion !== ROUTING_POLICY_VERSION) {
        fail('routing-policy-version')
    }
    if (value.routingAuthority !== STAGE_MODEL_POOL_POLICY.routingAuthority) {
        fail('routing-authority')
    }
    if (value.stageRole === 'ui-ux-implementer'
        && !definition.allowedProfiles.includes(value.selectedProfile)) {
        fail('routing-profile-forbidden')
    }
    validateFreshContext(value, definition)
    const expected = compileStageRoute({
        ...value.classification,
        stageRole: value.stageRole,
        stagePhase: value.stagePhase,
        frontierException: value.frontierException,
        requiredSkillDigests: value.requiredSkillDigests,
        capabilityDigest: value.capabilityDigest
    })
    if (value.stageRole === 'root-scheduler'
        && value.selectedProfile !== expected.selectedProfile) {
        fail('routing-profile-forbidden')
    }
    if (!sameValues(value.allowedProfiles, expected.allowedProfiles)
        || value.defaultProfile !== expected.defaultProfile
        || value.selectedProfile !== expected.selectedProfile
        || value.selectedProfileReason !== expected.selectedProfileReason) {
        fail('routing-selected-profile')
    }
    if (value.sandbox !== expected.sandbox
        || value.writeScope !== expected.writeScope) {
        fail('routing-permission')
    }
    assertHash(value.routingInputDigest, 'routing-input-digest')
    assertHash(value.capabilityDigest, 'routing-capability-digest')
    if (!Array.isArray(value.requiredSkillDigests)
        || value.requiredSkillDigests.some((entry) => !HASH.test(entry))) {
        fail('routing-skill-digest')
    }
    validateRuntimeCapability(value)
    validateCandidate(value)
    return value
}

const ALLOWED_RECLASSIFICATION_BLOCKERS = Object.freeze(new Set([
    'test-contract-disputed',
    'runtime-lifecycle-evidence',
    'protocol-security-evidence',
    'authority-conflict',
    'ui-system-design-dispute',
    'verification-scope-change'
]))

export function validateRouteReclassification(value) {
    if (value?.schema !== 'issue-orchestration.route-reclassification.v1'
        || value.policyVersion !== ROUTING_POLICY_VERSION) {
        fail('routing-reclassification-schema')
    }
    if (value.blockerClass === 'implementer-internal-red'
        || value.sourcePhase === 'self-test'
        || value.opensNewAttempt === true
        || value.triggersSemanticDagUpdate === true) {
        fail('routing-internal-cycle-authority')
    }
    if (!ALLOWED_RECLASSIFICATION_BLOCKERS.has(value.blockerClass)
        || !['test-owner', 'ux-acceptance-verifier', 'ui-system-adjudicator']
            .includes(value.sourceRole)
        || ['balance', 'telemetry', 'human-preference', 'rework-count']
            .includes(value.routingAuthority)) {
        fail('routing-reclassification-authority')
    }
    assertHash(value.blockerReceiptDigest, 'routing-blocker-receipt-digest')
    for (const field of [
        'previousProfile',
        'newRiskOrVerificationClass',
        'newProfile'
    ]) {
        if (typeof value[field] !== 'string' || !value[field]) {
            fail('routing-reclassification-field')
        }
    }
    return value
}

export function validateContinuity({ previous, next }) {
    if (!previous || !next
        || typeof previous.memberIssueId !== 'string'
        || typeof next.memberIssueId !== 'string'
        || !HASH.test(previous.memberRoutingReceiptDigest ?? '')
        || !HASH.test(next.memberRoutingReceiptDigest ?? '')) {
        fail('routing-member-independence')
    }
    if (previous.memberIssueId !== next.memberIssueId
        && (previous.memberRoutingReceiptDigest === next.memberRoutingReceiptDigest
            || previous.routingInputDigest === next.routingInputDigest
            || previous.requestId === next.requestId
            || previous.candidate?.attemptId === next.candidate?.attemptId)) {
        fail('routing-member-independence')
    }
    if (next.stagePhase === 'behavior-verification'
        || next.stagePhase === 'ux-acceptance'
        || next.stagePhase === 'adjudication') {
        const definition = STAGES[routeKey(next.stageRole, next.stagePhase)]
        validateFreshContext(next, definition ?? { freshContext: true })
    }
    return next
}
