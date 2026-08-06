import {
    canonical,
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    validateActorContextEnvelope
} from './actor-context-envelope.mjs'

const BUNDLE_SCHEMA = 'issue-orchestration.actor-prompt-bundle.v1'
const PREFIX_SCHEMA = 'issue-orchestration.actor-prompt-stable-prefix.v1'
const SUFFIX_SCHEMA = 'issue-orchestration.actor-prompt-volatile-suffix.v1'
const IDENTITY_SCHEMA = 'issue-orchestration.actor-prompt-cache-identity.v1'
const HASH = /^[a-f0-9]{64}$/u

const ROLE_INSTRUCTIONS = Object.freeze({
    'code-implementer': `Responsibility: Implement and self-test only the current non-UI implementation or landing-conflict slice.\nForbidden ownership: Do not change acceptance, semantic graph, independent verification, documentation, delivery, cleanup, or paths outside the envelope.\nEnvelope: Use only issue-orchestration.actor-context-envelope.v1; read its stageContext, repositoryEvidencePack, instructions, and allowlisted sources through the supplied resolver.\nOutput: Return exactly the schema and required fields named by outputInterface; do not mint machine authority.\nStop: Use failureVocabulary when input is missing or disputed, and use test-contract-disputed when the acceptance boundary is incomplete.`,
    'dag-creator-updater': `Responsibility: Propose selector-bound discovery and classification facts.\nForbidden ownership: Do not write files or own acceptance, implementation, readiness, delivery, or runtime state.\nEnvelope: Use only issue-orchestration.actor-context-envelope.v1 and its allowlisted evidence.\nOutput: Return exactly the semantic proposal named by outputInterface; do not mint machine authority.\nStop: Use failureVocabulary when evidence is missing, contradictory, or out of scope.`,
    'documentation-writer': `Responsibility: Update only the current documentation slice and report a genuine no-change result when no edit is required.\nForbidden ownership: Do not change product code, invent protocol or security semantics, alter verification, deliver, clean up, or write outside the envelope.\nEnvelope: Use only issue-orchestration.actor-context-envelope.v1; read its stageContext, repositoryEvidencePack, instructions, and allowlisted sources through the supplied resolver.\nOutput: Return exactly the schema and required fields named by outputInterface; do not fabricate a diff or machine authority.\nStop: Use failureVocabulary when the slice, evidence, or instruction boundary is incomplete or disputed.`,
    'test-owner': `Responsibility: Follow the envelope phase: plan the issue-specific test contract, author its scoped tests and probes, or independently verify the frozen candidate.\nForbidden ownership: Do not author semantic classification, implementation, delivery, or cleanup; never replace member evidence with group evidence or inherit the implementer conversation.\nEnvelope: Use only issue-orchestration.actor-context-envelope.v1; read its stageContext, repositoryEvidencePack, instructions, and allowlisted sources through the supplied resolver.\nOutput: Return exactly the phase-specific schema and required fields named by outputInterface; do not mint machine authority.\nStop: Use failureVocabulary for missing or disputed input, and use test-contract-disputed when owner, acceptance, design, test, or evidence boundaries are incomplete.`,
    'ui-system-adjudicator': `Responsibility: Resolve a bounded UI system-design dispute and freeze scope and design authority.\nForbidden ownership: Do not implement, edit, redesign, or choose routing.\nEnvelope: Use only issue-orchestration.actor-context-envelope.v1 and its allowlisted evidence.\nOutput: Return exactly the adjudication named by outputInterface.\nStop: Use failureVocabulary when bounded evidence cannot resolve the dispute.`,
    'ui-ux-implementer': `Responsibility: Implement and self-test only the current UI or landing-conflict slice under the supplied design authority.\nForbidden ownership: Do not redesign the product, change acceptance, claim independent UX acceptance, deliver, clean up, or write outside the envelope.\nEnvelope: Use only issue-orchestration.actor-context-envelope.v1; read its stageContext, repositoryEvidencePack, instructions, and allowlisted sources through the supplied resolver.\nOutput: Return exactly the schema and required fields named by outputInterface, including requested render evidence; do not mint machine authority.\nStop: Use failureVocabulary for incomplete input and use ui-system-design-disputed when the frozen design authority is unresolved.`,
    'ux-acceptance-verifier': `Responsibility: Judge the frozen UI with interaction, render, and accessibility evidence.\nForbidden ownership: Never edit or inherit the implementer conversation.\nEnvelope: Only issue-orchestration.actor-context-envelope.v1 is input.\nOutput: Return outputInterface exactly.\nStop: Use failureVocabulary for missing or disputed evidence.`
})

const VOLATILE_PREFIX_FIELDS = Object.freeze([
    'runId', 'memberId', 'repository', 'issueNumber', 'baseSha', 'nodeId',
    'actionDigest', 'actionSetDigest', 'route', 'slice', 'candidate',
    'checkpoint', 'lease', 'runtimeInvocationId', 'runtimeSessionId'
])

export class ActorPromptCacheIdentityError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'ActorPromptCacheIdentityError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new ActorPromptCacheIdentityError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
    return value
}

function clone(value) {
    return structuredClone(value)
}

function exactKeys(value, expected, code) {
    const actual = Object.keys(object(value, code)).sort()
    const canonicalExpected = [...expected].sort()
    if (!sameValue(actual, canonicalExpected)) {
        fail(code, { actual, expected: canonicalExpected })
    }
}

function verifyAuthority(value, kind, code) {
    exactKeys(value, ['kind', 'grants'], code)
    if (value.kind !== kind || !Array.isArray(value.grants) ||
        value.grants.length !== 0) {
        fail(code)
    }
}

function nullableIdentity(value, code) {
    if (value === undefined || value === null) return null
    if (typeof value === 'string') {
        if (value.length === 0) fail(code)
        return value
    }
    object(value, code)
    return canonical(clone(value))
}

function bytes(value) {
    return Buffer.byteLength(typeof value === 'string'
        ? value
        : JSON.stringify(value))
}

function orderedPromptDigest(stablePrefix, volatileSuffix) {
    return digest({
        schema: 'issue-orchestration.actor-prompt-ordered-sections.v1',
        sections: [stablePrefix, volatileSuffix]
    })
}

function immutableDigests(envelope, roleInstruction) {
    const identities = envelope.identities
    for (const field of ['packageDigest', 'manifestDigest', 'policyDigest']) {
        if (!HASH.test(identities[field] ?? '')) {
            fail('actor-prompt-immutable-digest-required', { field })
        }
    }
    return canonical({
        packageDigest: identities.packageDigest,
        manifestDigest: identities.manifestDigest,
        policyDigest: identities.policyDigest,
        policySetDigest: HASH.test(identities.policySetDigest ?? '')
            ? identities.policySetDigest
            : null,
        agentInstructionDigest: digest(roleInstruction)
    })
}

function compileStablePrefix(envelope) {
    const roleInstruction = ROLE_INSTRUCTIONS[envelope.role]
    if (!roleInstruction) fail('actor-prompt-role-unsupported', {
        role: envelope.role
    })
    return canonical({
        schema: PREFIX_SCHEMA,
        role: envelope.role,
        phase: envelope.phase,
        roleInstruction,
        envelopeInterfaceVersion: envelope.schema,
        outputInterface: clone(envelope.outputInterface),
        immutableDigests: immutableDigests(envelope, roleInstruction)
    })
}

function compileRouteIdentity(routeDecision, envelope) {
    const route = object(
        routeDecision,
        'actor-prompt-route-decision-required'
    )
    for (const field of ['routeDecisionDigest', 'routeCellDigest']) {
        if (!HASH.test(route[field] ?? '')) {
            fail('actor-prompt-route-digest-required', { field })
        }
    }
    for (const field of ['routeCellId', 'selectedProfile']) {
        if (typeof route[field] !== 'string' || route[field].length === 0) {
            fail('actor-prompt-route-field-required', { field })
        }
    }
    if (route.stageRole !== envelope.role ||
        route.stagePhase !== envelope.phase) {
        fail('actor-prompt-route-stage-mismatch')
    }
    return canonical({
        schema: 'issue-orchestration.actor-prompt-route-identity.v1',
        stageRole: route.stageRole,
        stagePhase: route.stagePhase,
        routeCellId: route.routeCellId,
        routeCellDigest: route.routeCellDigest,
        selectedProfile: route.selectedProfile,
        routeDecisionDigest: route.routeDecisionDigest
    })
}

function compileVolatileSuffix(envelope, routeDecision) {
    return canonical({
        schema: SUFFIX_SCHEMA,
        routeIdentity: compileRouteIdentity(routeDecision, envelope),
        actorContextEnvelope: clone(envelope)
    })
}

function compileIdentity({
    stablePrefix,
    volatileSuffix,
    tokenizerIdentity,
    runtimeIdentity
}) {
    const identity = {
        schema: IDENTITY_SCHEMA,
        status: 'compiled',
        authority: {
            kind: 'diagnostic-only',
            grants: []
        },
        stablePrefixDigest: digest(stablePrefix),
        suffixDigest: digest(volatileSuffix),
        completePromptDigest: orderedPromptDigest(
            stablePrefix,
            volatileSuffix
        ),
        tokenizerIdentity: nullableIdentity(
            tokenizerIdentity,
            'actor-prompt-tokenizer-identity-invalid'
        ),
        runtimeIdentity: nullableIdentity(
            runtimeIdentity,
            'actor-prompt-runtime-identity-invalid'
        )
    }
    identity.cacheIdentityDigest = digest(identity)
    return canonical(identity)
}

function assertNoVolatilePrefixField(value, location = '$') {
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            assertNoVolatilePrefixField(entry, `${location}[${index}]`))
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
        if (VOLATILE_PREFIX_FIELDS.includes(key)) {
            fail('actor-prompt-volatile-field-in-stable-prefix', {
                field: key,
                location
            })
        }
        assertNoVolatilePrefixField(entry, `${location}.${key}`)
    }
}

export function compileActorPromptBundle({
    actorContextEnvelope,
    routeDecision,
    tokenizerIdentity = null,
    runtimeIdentity = null
} = {}) {
    const envelope = validateActorContextEnvelope(actorContextEnvelope)
    const stablePrefix = compileStablePrefix(envelope)
    assertNoVolatilePrefixField(stablePrefix)
    const volatileSuffix = compileVolatileSuffix(envelope, routeDecision)
    const cacheIdentity = compileIdentity({
        stablePrefix,
        volatileSuffix,
        tokenizerIdentity,
        runtimeIdentity
    })
    const completePrompt = JSON.stringify(canonical({
        stablePrefix,
        volatileSuffix
    }))
    const bundle = {
        schema: BUNDLE_SCHEMA,
        status: 'compiled',
        authority: {
            kind: 'actor-input-only',
            grants: []
        },
        stablePrefix,
        volatileSuffix,
        completePrompt,
        cacheIdentity,
        tokenAccounting: {
            stablePrefixBytes: bytes(stablePrefix),
            volatileSuffixBytes: bytes(volatileSuffix),
            completePromptBytes: bytes(completePrompt),
            stablePrefixEstimatedTokens: Math.ceil(bytes(stablePrefix) / 4),
            volatileSuffixEstimatedTokens: Math.ceil(bytes(volatileSuffix) / 4)
        }
    }
    bundle.bundleDigest = digest(bundle)
    return validateActorPromptBundle(bundle)
}

function verifyCacheIdentity(identity, stablePrefix, volatileSuffix) {
    exactKeys(identity, [
        'schema', 'status', 'authority', 'stablePrefixDigest',
        'suffixDigest', 'completePromptDigest', 'tokenizerIdentity',
        'runtimeIdentity', 'cacheIdentityDigest'
    ], 'actor-prompt-cache-identity-fields-invalid')
    verifyAuthority(
        identity.authority,
        'diagnostic-only',
        'actor-prompt-cache-identity-authority-invalid'
    )
    if (identity.schema !== IDENTITY_SCHEMA ||
        identity.status !== 'compiled' ||
        identity.stablePrefixDigest !== digest(stablePrefix) ||
        identity.suffixDigest !== digest(volatileSuffix) ||
        identity.completePromptDigest !== orderedPromptDigest(
            stablePrefix,
            volatileSuffix
        ) ||
        !HASH.test(identity.cacheIdentityDigest ?? '')) {
        fail('actor-prompt-cache-identity-invalid')
    }
    const unsigned = clone(identity)
    delete unsigned.cacheIdentityDigest
    if (digest(unsigned) !== identity.cacheIdentityDigest) {
        fail('actor-prompt-cache-identity-digest-mismatch')
    }
}

export function validateActorPromptBundle(value) {
    const bundle = object(value, 'actor-prompt-bundle-required')
    exactKeys(bundle, [
        'schema', 'status', 'authority', 'stablePrefix', 'volatileSuffix',
        'completePrompt', 'cacheIdentity', 'tokenAccounting', 'bundleDigest'
    ], 'actor-prompt-bundle-fields-invalid')
    verifyAuthority(
        bundle.authority,
        'actor-input-only',
        'actor-prompt-bundle-authority-invalid'
    )
    exactKeys(bundle.stablePrefix, [
        'schema', 'role', 'phase', 'roleInstruction',
        'envelopeInterfaceVersion', 'outputInterface', 'immutableDigests'
    ], 'actor-prompt-stable-prefix-fields-invalid')
    exactKeys(bundle.stablePrefix.immutableDigests, [
        'packageDigest', 'manifestDigest', 'policyDigest',
        'policySetDigest', 'agentInstructionDigest'
    ], 'actor-prompt-immutable-digest-fields-invalid')
    exactKeys(bundle.volatileSuffix, [
        'schema', 'routeIdentity', 'actorContextEnvelope'
    ], 'actor-prompt-volatile-suffix-fields-invalid')
    exactKeys(bundle.volatileSuffix.routeIdentity, [
        'schema', 'stageRole', 'stagePhase', 'routeCellId',
        'routeCellDigest', 'selectedProfile', 'routeDecisionDigest'
    ], 'actor-prompt-route-identity-fields-invalid')
    exactKeys(bundle.tokenAccounting, [
        'stablePrefixBytes', 'volatileSuffixBytes', 'completePromptBytes',
        'stablePrefixEstimatedTokens', 'volatileSuffixEstimatedTokens'
    ], 'actor-prompt-token-accounting-fields-invalid')
    if (bundle.schema !== BUNDLE_SCHEMA ||
        bundle.status !== 'compiled' ||
        bundle.stablePrefix?.schema !== PREFIX_SCHEMA ||
        bundle.volatileSuffix?.schema !== SUFFIX_SCHEMA ||
        !HASH.test(bundle.bundleDigest ?? '')) {
        fail('actor-prompt-bundle-invalid')
    }
    const envelope = validateActorContextEnvelope(
        bundle.volatileSuffix.actorContextEnvelope
    )
    const routeIdentity = bundle.volatileSuffix.routeIdentity
    if (routeIdentity.schema !==
            'issue-orchestration.actor-prompt-route-identity.v1' ||
        routeIdentity.stageRole !== envelope.role ||
        routeIdentity.stagePhase !== envelope.phase ||
        !HASH.test(routeIdentity.routeCellDigest ?? '') ||
        !HASH.test(routeIdentity.routeDecisionDigest ?? '') ||
        typeof routeIdentity.routeCellId !== 'string' ||
        routeIdentity.routeCellId.length === 0 ||
        typeof routeIdentity.selectedProfile !== 'string' ||
        routeIdentity.selectedProfile.length === 0) {
        fail('actor-prompt-route-identity-invalid')
    }
    if (bundle.stablePrefix.role !== envelope.role ||
        bundle.stablePrefix.phase !== envelope.phase ||
        bundle.stablePrefix.envelopeInterfaceVersion !== envelope.schema ||
        !sameValue(
            bundle.stablePrefix.outputInterface,
            envelope.outputInterface
        ) ||
        bundle.stablePrefix.roleInstruction !== ROLE_INSTRUCTIONS[envelope.role]) {
        fail('actor-prompt-prefix-envelope-mismatch')
    }
    assertNoVolatilePrefixField(bundle.stablePrefix)
    verifyCacheIdentity(
        bundle.cacheIdentity,
        bundle.stablePrefix,
        bundle.volatileSuffix
    )
    const expectedPrompt = JSON.stringify(canonical({
        stablePrefix: bundle.stablePrefix,
        volatileSuffix: bundle.volatileSuffix
    }))
    if (bundle.completePrompt !== expectedPrompt) {
        fail('actor-prompt-complete-prompt-mismatch')
    }
    const expectedAccounting = {
        stablePrefixBytes: bytes(bundle.stablePrefix),
        volatileSuffixBytes: bytes(bundle.volatileSuffix),
        completePromptBytes: bytes(bundle.completePrompt),
        stablePrefixEstimatedTokens:
            Math.ceil(bytes(bundle.stablePrefix) / 4),
        volatileSuffixEstimatedTokens:
            Math.ceil(bytes(bundle.volatileSuffix) / 4)
    }
    if (!sameValue(bundle.tokenAccounting, expectedAccounting)) {
        fail('actor-prompt-token-accounting-mismatch')
    }
    const unsigned = clone(bundle)
    delete unsigned.bundleDigest
    if (digest(unsigned) !== bundle.bundleDigest) {
        fail('actor-prompt-bundle-digest-mismatch')
    }
    return Object.freeze(clone(bundle))
}

export function validateActorPromptBundleBinding(bundle, {
    actorContextEnvelope,
    routeDecision,
    role,
    phase,
    actionDigest
} = {}) {
    const value = validateActorPromptBundle(bundle)
    const envelope = validateActorContextEnvelope(actorContextEnvelope)
    const expectedRouteIdentity = compileRouteIdentity(
        routeDecision,
        envelope
    )
    if (!sameValue(value.volatileSuffix.actorContextEnvelope, envelope) ||
        !sameValue(value.volatileSuffix.routeIdentity, expectedRouteIdentity) ||
        value.stablePrefix.role !== role ||
        value.stablePrefix.phase !== phase ||
        envelope.identities.actionDigest !== actionDigest) {
        fail('actor-prompt-bundle-binding-mismatch')
    }
    return value
}

export function sanitizeProviderPromptCacheMetadata(value) {
    if (value === undefined || value === null) return null
    const metadata = object(value, 'actor-prompt-provider-metadata-invalid')
    const result = {}
    for (const field of ['provider', 'cacheKey', 'status']) {
        if (metadata[field] !== undefined) {
            if (typeof metadata[field] !== 'string' ||
                metadata[field].length === 0) {
                fail('actor-prompt-provider-metadata-invalid', { field })
            }
            result[field] = metadata[field]
        }
    }
    for (const field of ['supported', 'hit']) {
        if (metadata[field] !== undefined) {
            if (typeof metadata[field] !== 'boolean') {
                fail('actor-prompt-provider-metadata-invalid', { field })
            }
            result[field] = metadata[field]
        }
    }
    for (const field of [
        'cachedInputTokens', 'uncachedInputTokens', 'inputTokens'
    ]) {
        if (metadata[field] !== undefined) {
            if (!Number.isInteger(metadata[field]) || metadata[field] < 0) {
                fail('actor-prompt-provider-metadata-invalid', { field })
            }
            result[field] = metadata[field]
        }
    }
    return Object.freeze(canonical(result))
}

export const ACTOR_PROMPT_CACHE_IDENTITY_SCHEMA = IDENTITY_SCHEMA
export const ACTOR_PROMPT_BUNDLE_SCHEMA = BUNDLE_SCHEMA
export const ACTOR_PROMPT_ROLE_INSTRUCTIONS = ROLE_INSTRUCTIONS
