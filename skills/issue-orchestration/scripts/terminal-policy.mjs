import fs from 'node:fs'
import path from 'node:path'

import { digest } from './runtime-contract-lib.mjs'

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/terminal-policy.json'
)

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
    return value
}

export const TERMINAL_POLICY = deepFreeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const TERMINAL_POLICY_SCHEMA = TERMINAL_POLICY.schema
export const TERMINAL_POLICY_VERSION = TERMINAL_POLICY.version
export const TERMINAL_POLICY_DIGEST = digest(TERMINAL_POLICY)

const HASH = /^[a-f0-9]{64}$/u

function exactSet(actual, expected, code) {
    if (!Array.isArray(actual) ||
        JSON.stringify([...actual].sort()) !==
            JSON.stringify([...expected].sort()) ||
        new Set(actual).size !== actual.length) {
        throw new Error(code)
    }
}

if (TERMINAL_POLICY_SCHEMA !== 'issue-orchestration.terminal-policy.v1' ||
    TERMINAL_POLICY_VERSION !== 'terminal-policy-v1') {
    throw new Error('terminal-policy-identity-invalid')
}
exactSet(Object.keys(TERMINAL_POLICY.categories), [
    'impossible', 'externally_blocked', 'not_applicable'
], 'terminal-policy-category-set-invalid')
exactSet(TERMINAL_POLICY.recoveryDomains, [
    'dependency', 'evidence', 'humanDecision',
    'remote', 'repository', 'runtime'
], 'terminal-policy-domain-set-invalid')
exactSet(TERMINAL_POLICY.recoveryPaths, [
    'advisor', 'continuation', 'deterministicHandlers',
    'humanDecision', 'revalidation', 'retry'
], 'terminal-policy-recovery-path-set-invalid')
exactSet(TERMINAL_POLICY.recoveryTerminalStates, [
    'completed', 'exhausted', 'inapplicable'
], 'terminal-policy-recovery-state-set-invalid')
exactSet(TERMINAL_POLICY.humanDecisionTerminalStates, [
    'completed', 'inapplicable'
], 'terminal-policy-human-state-set-invalid')
for (const [category, spec] of
    Object.entries(TERMINAL_POLICY.categories)) {
    if (!spec || typeof spec !== 'object' ||
        !Array.isArray(spec.requiredEvidenceKinds) ||
        spec.requiredEvidenceKinds.length < 2 ||
        new Set(spec.requiredEvidenceKinds).size !==
            spec.requiredEvidenceKinds.length ||
        spec.requiredEvidenceKinds.some((kind) =>
            typeof kind !== 'string' || kind.length === 0)) {
        throw new Error(`terminal-policy-evidence-set-invalid:${category}`)
    }
}

const CATEGORY_SPECS = Object.freeze(TERMINAL_POLICY.categories)

export const TERMINAL_CATEGORIES = Object.freeze(
    Object.keys(CATEGORY_SPECS).sort()
)

export const TERMINAL_RECOVERY_DOMAINS = Object.freeze(
    [...TERMINAL_POLICY.recoveryDomains]
)

export const TERMINAL_RECOVERY_PATHS = Object.freeze(
    [...TERMINAL_POLICY.recoveryPaths]
)

const RECOVERY_TERMINAL_STATES = Object.freeze(
    [...TERMINAL_POLICY.recoveryTerminalStates]
)
const HUMAN_DECISION_TERMINAL_STATES = Object.freeze(
    [...TERMINAL_POLICY.humanDecisionTerminalStates]
)

export class TerminalPolicyError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'TerminalPolicyError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new TerminalPolicyError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function hash(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
    return value
}

function canonicalEvidence(value) {
    if (!Array.isArray(value)) {
        fail('terminal-direct-evidence-required')
    }
    const evidence = value.map((entry) => {
        object(entry, 'terminal-direct-evidence-invalid')
        if (typeof entry.kind !== 'string' || entry.kind.length === 0) {
            fail('terminal-evidence-kind-invalid')
        }
        return Object.freeze({
            kind: entry.kind,
            evidenceDigest: hash(
                entry.evidenceDigest,
                'terminal-evidence-digest-invalid'
            )
        })
    }).sort((left, right) => left.kind.localeCompare(right.kind))
    if (new Set(evidence.map(({ kind }) => kind)).size !== evidence.length) {
        fail('terminal-evidence-kind-duplicate')
    }
    return Object.freeze(evidence)
}

export function terminalCategorySpec(category) {
    const spec = CATEGORY_SPECS[category]
    if (!spec) fail('terminal-category-invalid', { category })
    return spec
}

export function validateTerminalEvidenceSet({
    policyVersion,
    category,
    directEvidence
} = {}) {
    if (policyVersion !== TERMINAL_POLICY_VERSION) {
        fail('terminal-policy-version-invalid')
    }
    const spec = terminalCategorySpec(category)
    const evidence = canonicalEvidence(directEvidence)
    const actual = evidence.map(({ kind }) => kind)
    const expected = [...spec.requiredEvidenceKinds].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail('terminal-evidence-set-mismatch', {
            category,
            expected,
            actual
        })
    }
    return Object.freeze({
        policyVersion,
        category,
        directEvidence: evidence,
        directEvidenceDigest: digest(evidence)
    })
}

export function validateTerminalRecoveryExhaustion(value) {
    object(value, 'terminal-recovery-exhaustion-required')
    const actualKeys = Object.keys(value).sort()
    if (JSON.stringify(actualKeys) !==
        JSON.stringify([...TERMINAL_RECOVERY_PATHS].sort())) {
        fail('terminal-recovery-path-set-invalid', { actualKeys })
    }
    const normalized = {}
    for (const key of TERMINAL_RECOVERY_PATHS) {
        const state = value[key]
        if (!RECOVERY_TERMINAL_STATES.includes(state)) {
            fail('terminal-recovery-path-not-exhausted', {
                path: key,
                state: state ?? null
            })
        }
        if (key === 'humanDecision' &&
            !HUMAN_DECISION_TERMINAL_STATES.includes(state)) {
            fail('terminal-human-decision-invalid', { state })
        }
        normalized[key] = state
    }
    return Object.freeze({
        recoveryExhaustion: Object.freeze(normalized),
        recoveryExhaustionDigest: digest(normalized)
    })
}

export function terminalEvidenceDigests(directEvidence) {
    return canonicalEvidence(directEvidence)
        .map(({ evidenceDigest }) => evidenceDigest)
}

export function validateTerminalRecoveryDomains(value) {
    object(value, 'terminal-recovery-domains-required')
    const keys = Object.keys(value).sort()
    if (JSON.stringify(keys) !==
        JSON.stringify([...TERMINAL_RECOVERY_DOMAINS].sort())) {
        fail('terminal-recovery-domain-set-invalid', { keys })
    }
    const normalized = {}
    for (const key of TERMINAL_RECOVERY_DOMAINS) {
        normalized[key] = hash(
            value[key],
            'terminal-recovery-domain-digest-invalid'
        )
    }
    return Object.freeze(normalized)
}

export function compileTerminalRecoveryFingerprint(input = {}) {
    object(input, 'terminal-recovery-fingerprint-input-required')
    const requiredText = [
        'runId', 'nodeId', 'repository', 'selectorReceiptDigest',
        'remoteSnapshotDigest', 'policyDigest', 'policySetDigest',
        'runtimeTrustBindingDigest', 'repositoryBindingDigest',
        'category', 'firstFailureDigest', 'directEvidenceDigest',
        'recoveryExhaustionDigest', 'retentionInventoryDigest'
    ]
    for (const field of requiredText) {
        if (typeof input[field] !== 'string' || input[field].length === 0) {
            fail('terminal-recovery-fingerprint-field-invalid', { field })
        }
    }
    if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1 ||
        !Number.isInteger(input.nodeEpoch) || input.nodeEpoch < 1) {
        fail('terminal-recovery-fingerprint-identity-invalid')
    }
    for (const field of [
        'selectorReceiptDigest', 'remoteSnapshotDigest', 'policyDigest',
        'policySetDigest', 'runtimeTrustBindingDigest',
        'repositoryBindingDigest',
        'firstFailureDigest', 'directEvidenceDigest',
        'recoveryExhaustionDigest', 'retentionInventoryDigest'
    ]) hash(input[field], 'terminal-recovery-fingerprint-digest-invalid')
    if (!/^[a-f0-9]{40}$/u.test(input.baseSha ?? '')) {
        fail('terminal-recovery-fingerprint-base-invalid')
    }
    terminalCategorySpec(input.category)
    const domainDigests = validateTerminalRecoveryDomains(
        input.domainDigests
    )
    return digest({
        schema:
            'issue-orchestration.terminal-recovery-fingerprint-input.v1',
        terminalPolicyVersion: TERMINAL_POLICY_VERSION,
        runId: input.runId,
        nodeId: input.nodeId,
        repository: input.repository,
        issueNumber: input.issueNumber,
        baseSha: input.baseSha,
        nodeEpoch: input.nodeEpoch,
        selectorReceiptDigest: input.selectorReceiptDigest,
        remoteSnapshotDigest: input.remoteSnapshotDigest,
        policyDigest: input.policyDigest,
        policySetDigest: input.policySetDigest,
        terminalPolicyDigest: TERMINAL_POLICY_DIGEST,
        runtimeTrustBindingDigest: input.runtimeTrustBindingDigest,
        repositoryBindingDigest: input.repositoryBindingDigest,
        category: input.category,
        firstFailureDigest: input.firstFailureDigest,
        directEvidenceDigest: input.directEvidenceDigest,
        recoveryExhaustionDigest: input.recoveryExhaustionDigest,
        domainDigests,
        retentionInventoryDigest: input.retentionInventoryDigest
    })
}
