import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u
const CONTEXT_FIELDS = Object.freeze([
    'repository',
    'issue',
    'node',
    'attempt',
    'acceptanceGroup',
    'member',
    'baseSha',
    'epochId',
    'candidateSha',
    'issueSnapshotDigest',
    'authoritySourcesDigest'
])
const AUTHORITY_CONFLICT_TRIGGERS = new Set([
    'authority-conflict',
    'product-authority-conflict',
    'ui-authority-conflict'
])
const SAFE_NO_DECISION_DISPOSITION =
    'freeze-semantic-progress-retain-resources'

export class HumanDecisionError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'HumanDecisionError'
        this.code = code
    }
}

function fail(code, message) {
    throw new HumanDecisionError(code, message)
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

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function requireText(value, code) {
    if (!isText(value)) fail(code)
}

function requireHash(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

function unique(values) {
    return new Set(values).size === values.length
}

function without(value, ...keys) {
    return Object.fromEntries(
        Object.entries(value ?? {}).filter(([key]) => !keys.includes(key))
    )
}

function select(value, fields) {
    return Object.fromEntries(fields.map((field) => [field, value?.[field]]))
}

function contextFrom(value) {
    const context = select(value, CONTEXT_FIELDS)
    if (!REPOSITORY.test(context.repository ?? '')
        || !Number.isSafeInteger(context.issue)
        || context.issue <= 0
        || !isText(context.node)
        || !isText(context.attempt)
        || !isText(context.acceptanceGroup)
        || !isText(context.member)
        || !SHA.test(context.baseSha ?? '')
        || !isText(context.epochId)
        || !SHA.test(context.candidateSha ?? '')
        || !HASH.test(context.issueSnapshotDigest ?? '')
        || !HASH.test(context.authoritySourcesDigest ?? '')) {
        fail('human-decision-context')
    }
    return context
}

function validateMachineInvestigation(value) {
    if (value?.status !== 'complete') {
        fail('human-decision-machine-investigation-incomplete')
    }
    requireHash(value.digest, 'human-decision-machine-investigation-digest')
    requireText(value.classification, 'human-decision-machine-investigation')
}

function validateAdjudication(value) {
    if (value?.status !== 'complete') {
        fail('human-decision-adjudication-incomplete')
    }
    if (value.role !== 'ui-system-adjudicator'
        || value.profile !== 'gpt-5.6-sol/xhigh') {
        fail('human-decision-adjudicator-authority')
    }
    if (value.finalReadOnly !== true && !HASH.test(value.digest ?? '')) {
        fail('human-decision-adjudicator-authority')
    }
    if (value.digest !== undefined) {
        requireHash(value.digest, 'human-decision-adjudication-digest')
    }
}

function validateAuthoritySources(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
        fail('human-decision-authority-sources')
    }
    for (const source of sources) {
        requireText(source?.source, 'human-decision-authority-sources')
        requireHash(source?.digest, 'human-decision-authority-source-digest')
        requireText(source?.authority, 'human-decision-authority-sources')
    }
}

function validateAuthorityConflict(conflicts) {
    if (!Array.isArray(conflicts) || conflicts.length === 0) {
        fail('human-decision-authority-conflict')
    }
    for (const conflict of conflicts) {
        requireText(conflict?.source, 'human-decision-authority-conflict')
        requireText(conflict?.conflict, 'human-decision-authority-conflict')
    }
}

function validateConsequences(option, field) {
    if (!Array.isArray(option?.[field])
        || option[field].length === 0
        || option[field].some((entry) => !isText(entry))) {
        fail('human-decision-option-incomplete')
    }
}

function validateOptions(options) {
    if (!Array.isArray(options) || options.length < 2) {
        fail('human-decision-not-ambiguous')
    }
    const ids = options.map(({ id } = {}) => id)
    if (ids.some((id) => !isText(id)) || !unique(ids)) {
        fail('human-decision-option-identity')
    }
    for (const option of options) {
        requireText(option.summary, 'human-decision-option-incomplete')
        for (const field of [
            'behavioralConsequences',
            'compatibilityConsequences',
            'securityOrDataConsequences',
            'workPreservationConsequences'
        ]) validateConsequences(option, field)
        if (typeof option.reversible !== 'boolean') {
            fail('human-decision-option-incomplete')
        }
    }
}

function validateRetainedResources(request) {
    const resources = request?.retainedResources
    if (!Array.isArray(resources) || resources.length === 0) {
        fail('human-decision-retention')
    }
    const resourceIds = resources.map(({ resourceId } = {}) => resourceId)
    if (resourceIds.some((id) => !isText(id)) || !unique(resourceIds)) {
        fail('human-decision-retention')
    }
    for (const resource of resources) {
        if (resource.ownerAttemptId !== request.attempt
            || !isText(resource.ownerClass)
            || resource.disposition !== 'retained-pending-human-decision') {
            fail('human-decision-retention-owner')
        }
    }
    if (request.safeNoDecisionDisposition !== SAFE_NO_DECISION_DISPOSITION) {
        fail('human-decision-safe-disposition')
    }
    if (request.retainedResourceDigest !== digest(resources)) {
        fail('human-decision-retention-digest')
    }
}

function validateAuthorityEvidence(evidence) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
        fail('human-decision-authority-evidence')
    }
    for (const item of evidence) {
        requireText(item?.source, 'human-decision-authority-evidence')
        requireHash(item?.digest, 'human-decision-authority-evidence-digest')
    }
}

function decisionIsValid(request, receipt) {
    if (receipt.decision === 'select-option') {
        return isText(receipt.selectedOption)
            && request.options.some(({ id }) => id === receipt.selectedOption)
    }
    if (receipt.decision === 'no-decision') {
        return receipt.selectedOption === null
            && receipt.disposition === request.safeNoDecisionDisposition
    }
    return false
}

export function evaluateHumanDecisionEligibility(input) {
    if (!AUTHORITY_CONFLICT_TRIGGERS.has(input?.triggerClass)) {
        return Object.freeze({
            eligible: false,
            disposition: 'machine-continue',
            requiredHumanAuthority: null
        })
    }
    if (input.machineInvestigation?.status !== 'complete'
        || input.adjudication?.status !== 'complete'
        || !Number.isSafeInteger(input.legalOptionCount)
        || input.legalOptionCount < 2
        || !isText(input.missingConstraintAuthority)
        || input.userVisibleOrIrreversibleDifference !== true) {
        return Object.freeze({
            eligible: false,
            disposition: 'machine-continue',
            requiredHumanAuthority: null
        })
    }
    validateAdjudication(input.adjudication)
    return Object.freeze({
        eligible: true,
        disposition: 'human-decision-required',
        requiredHumanAuthority: input.missingConstraintAuthority
    })
}

export function createHumanDecisionRequest(input) {
    const context = contextFrom(input)
    requireText(input?.blockedDecision, 'human-decision-blocked-decision')
    requireText(input?.requiredHumanAuthority, 'human-decision-required-authority')
    validateMachineInvestigation(input.machineInvestigation)
    validateAdjudication(input.adjudication)
    validateAuthoritySources(input.authoritativeSources)
    validateAuthorityConflict(input.authorityConflict)
    validateOptions(input.options)
    if (!input.options.some(({ id }) => id === input.recommendedOption)) {
        fail('human-decision-recommended-option')
    }
    if (!Array.isArray(input.recommendationEvidence)
        || input.recommendationEvidence.length === 0
        || input.recommendationEvidence.some((entry) => !isText(entry))) {
        fail('human-decision-recommendation-evidence')
    }
    const eligibility = evaluateHumanDecisionEligibility({
        machineInvestigation: input.machineInvestigation,
        adjudication: input.adjudication,
        triggerClass: input.triggerClass,
        legalOptionCount: input.options.length,
        missingConstraintAuthority: input.requiredHumanAuthority,
        userVisibleOrIrreversibleDifference: true
    })
    if (!eligibility.eligible) fail('human-decision-ineligible')

    const contextDigest = digest(context)
    const request = {
        schema: 'issue-orchestration.human-decision-request.v1',
        requestId: `human-decision-${digest({
            contextDigest,
            blockedDecision: input.blockedDecision,
            triggerClass: input.triggerClass
        }).slice(0, 24)}`,
        ...context,
        triggerClass: input.triggerClass,
        blockedDecision: input.blockedDecision,
        machineInvestigation: clone(input.machineInvestigation),
        machineInvestigationDigest: input.machineInvestigation.digest,
        adjudication: clone(input.adjudication),
        adjudicationDigest: input.adjudication.digest,
        authoritativeSources: clone(input.authoritativeSources),
        authorityConflict: clone(input.authorityConflict),
        options: clone(input.options),
        recommendedOption: input.recommendedOption,
        recommendationEvidence: clone(input.recommendationEvidence),
        safeNoDecisionDisposition: input.safeNoDecisionDisposition,
        requiredHumanAuthority: input.requiredHumanAuthority,
        retainedResources: clone(input.retainedResources),
        contextDigest,
        retainedResourceDigest: digest(input.retainedResources)
    }
    validateRetainedResources(request)
    request.requestDigest = digest(request)
    return request
}

export function validateHumanDecisionRequest(request) {
    if (request?.schema !== 'issue-orchestration.human-decision-request.v1') {
        fail('human-decision-request-schema')
    }
    requireText(request.requestId, 'human-decision-request-identity')
    const context = contextFrom(request)
    if (request.contextDigest !== digest(context)) {
        fail('human-decision-context-digest')
    }
    validateMachineInvestigation(request.machineInvestigation)
    validateAdjudication(request.adjudication)
    if (request.machineInvestigationDigest !== request.machineInvestigation.digest) {
        fail('human-decision-machine-investigation-digest')
    }
    if (request.adjudicationDigest !== request.adjudication.digest) {
        fail('human-decision-adjudication-digest')
    }
    validateAuthoritySources(request.authoritativeSources)
    validateAuthorityConflict(request.authorityConflict)
    validateOptions(request.options)
    requireText(request.blockedDecision, 'human-decision-blocked-decision')
    requireText(request.requiredHumanAuthority, 'human-decision-required-authority')
    if (!request.options.some(({ id }) => id === request.recommendedOption)) {
        fail('human-decision-recommended-option')
    }
    if (!Array.isArray(request.recommendationEvidence)
        || request.recommendationEvidence.length === 0
        || request.recommendationEvidence.some((entry) => !isText(entry))) {
        fail('human-decision-recommendation-evidence')
    }
    const eligibility = evaluateHumanDecisionEligibility({
        machineInvestigation: request.machineInvestigation,
        adjudication: request.adjudication,
        triggerClass: request.triggerClass,
        legalOptionCount: request.options.length,
        missingConstraintAuthority: request.requiredHumanAuthority,
        userVisibleOrIrreversibleDifference: true
    })
    if (!eligibility.eligible) fail('human-decision-ineligible')
    validateRetainedResources(request)
    if (request.requestDigest !== digest(without(request, 'requestDigest'))) {
        fail('human-decision-request-digest')
    }
    return Object.freeze({
        status: 'valid',
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        contextDigest: request.contextDigest
    })
}

export function recordHumanDecision({
    request,
    humanAuthority,
    authorityEvidence,
    decision,
    selectedOption = null,
    additionalAuthoritativeFacts = [],
    decidedAt,
    disposition
} = {}) {
    validateHumanDecisionRequest(request)
    if (humanAuthority !== request.requiredHumanAuthority) {
        fail('human-decision-authority-mismatch')
    }
    validateAuthorityEvidence(authorityEvidence)
    if (!Array.isArray(additionalAuthoritativeFacts)
        || additionalAuthoritativeFacts.some((entry) => !isText(entry))) {
        fail('human-decision-additional-facts')
    }
    if (!isText(decidedAt)
        || !Number.isFinite(Date.parse(decidedAt))
        || new Date(decidedAt).toISOString() !== decidedAt) {
        fail('human-decision-decided-at')
    }
    const resolvedDisposition = decision === 'no-decision'
        ? disposition ?? request.safeNoDecisionDisposition
        : null
    const receipt = {
        schema: 'issue-orchestration.human-decision-receipt.v1',
        receiptId: `human-decision-receipt-${digest({
            requestDigest: request.requestDigest,
            authorityEvidence,
            decision,
            selectedOption,
            decidedAt
        }).slice(0, 24)}`,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        contextDigest: request.contextDigest,
        humanAuthority,
        authorityEvidence: clone(authorityEvidence),
        authorityEvidenceDigest: digest(authorityEvidence),
        decision,
        selectedOption,
        disposition: resolvedDisposition,
        additionalAuthoritativeFacts: clone(additionalAuthoritativeFacts),
        decidedAt
    }
    if (!decisionIsValid(request, receipt)) {
        fail('human-decision-selection')
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

export function validateHumanDecisionReceipt({ request, receipt } = {}) {
    validateHumanDecisionRequest(request)
    if (receipt?.schema !== 'issue-orchestration.human-decision-receipt.v1') {
        fail('human-decision-receipt-schema')
    }
    requireText(receipt.receiptId, 'human-decision-receipt-identity')
    if (receipt.requestId !== request.requestId
        || receipt.requestDigest !== request.requestDigest
        || receipt.contextDigest !== request.contextDigest) {
        fail('human-decision-receipt-binding')
    }
    if (receipt.humanAuthority !== request.requiredHumanAuthority) {
        fail('human-decision-authority-mismatch')
    }
    validateAuthorityEvidence(receipt.authorityEvidence)
    if (receipt.authorityEvidenceDigest !== digest(receipt.authorityEvidence)) {
        fail('human-decision-authority-evidence-digest')
    }
    if (!Array.isArray(receipt.additionalAuthoritativeFacts)
        || receipt.additionalAuthoritativeFacts.some((entry) => !isText(entry))) {
        fail('human-decision-additional-facts')
    }
    if (!isText(receipt.decidedAt)
        || !Number.isFinite(Date.parse(receipt.decidedAt))
        || new Date(receipt.decidedAt).toISOString() !== receipt.decidedAt) {
        fail('human-decision-decided-at')
    }
    if (!decisionIsValid(request, receipt)) {
        fail('human-decision-selection')
    }
    if (receipt.receiptDigest !== digest(without(receipt, 'receiptDigest'))) {
        fail('human-decision-receipt-digest')
    }
    return Object.freeze({
        status: 'valid',
        receiptId: receipt.receiptId,
        receiptDigest: receipt.receiptDigest
    })
}

export function evaluateHumanDecisionContext({ request, currentContext } = {}) {
    validateHumanDecisionRequest(request)
    let currentDigest = null
    try {
        currentDigest = digest(contextFrom(currentContext))
    } catch (error) {
        if (error?.code !== 'human-decision-context') throw error
    }
    if (currentDigest !== request.contextDigest) {
        return Object.freeze({
            valid: false,
            disposition: 'human-decision-invalidated',
            requestContextDigest: request.contextDigest,
            currentContextDigest: currentDigest
        })
    }
    return Object.freeze({
        valid: true,
        disposition: 'human-decision-current',
        contextDigest: currentDigest
    })
}

export function validateHumanDecisionRetention({ request } = {}) {
    validateHumanDecisionRequest(request)
    validateRetainedResources(request)
    return Object.freeze({
        status: 'retained',
        retainedResourceDigest: request.retainedResourceDigest,
        resourceIds: request.retainedResources.map(({ resourceId }) => resourceId)
    })
}

export function resumeHumanDecision({
    request,
    receipt,
    currentContext
} = {}) {
    validateHumanDecisionReceipt({ request, receipt })
    validateHumanDecisionRetention({ request })
    const context = evaluateHumanDecisionContext({ request, currentContext })
    if (!context.valid) fail('human-decision-context-invalidated')
    const resume = {
        schema: 'issue-orchestration.human-decision-resume.v1',
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        receiptDigest: receipt.receiptDigest,
        contextDigest: request.contextDigest,
        resumeMode: 'recompute-routing-and-reverify',
        nextState: 'routing-recompute-required',
        nextStageProfile: null,
        routeOverride: null,
        verificationBypass: false,
        deliveryBypass: false,
        contractRebaseRequired: true,
        selectedOption: receipt.selectedOption,
        additionalAuthoritativeFacts: clone(receipt.additionalAuthoritativeFacts),
        retainedResourceDigest: request.retainedResourceDigest
    }
    resume.resumeDigest = digest(resume)
    return resume
}
