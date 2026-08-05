#!/usr/bin/env node
// Shared issue-orchestration package runtime.

import {
    lstatSync,
    readFileSync,
    realpathSync,
    statSync
} from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { digest, seal } from './runtime-contract-lib.mjs'
import { validateRemoteStateSnapshot } from './remote-mutation-authority.mjs'

import {
    isWithinOrEqual,
    StateRootValidationError,
    validateStateRoot
} from './validate-state-root.mjs'

class DeliveryClosureError extends Error {
    constructor(code, message, details = {}) {
        super(message)
        this.name = 'DeliveryClosureError'
        this.code = code
        this.details = details
    }
}

function fail(code, message, details = {}) {
    throw new DeliveryClosureError(code, message, details)
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail('invalid-schema', `${label} must be a non-empty string.`)
    }
}

function requireUniqueStringArray(value, label) {
    if (
        !Array.isArray(value)
        || value.length === 0
        || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
        || new Set(value).size !== value.length
    ) {
        fail('invalid-schema', `${label} must be a non-empty array of unique strings.`)
    }
}

function arraysEqual(left, right) {
    return Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((entry, index) => entry === right[index])
}

function ensureStateFile(path, stateRoot) {
    const absolute = resolve(path)
    let canonical
    try {
        canonical = realpathSync.native(absolute)
    } catch (error) {
        fail('evidence-unreadable', `Delivery evidence cannot be resolved: ${absolute}.`, {
            error: error.message
        })
    }
    if (!isWithinOrEqual(canonical, stateRoot) || canonical === stateRoot) {
        fail('evidence-outside-state-root', 'Delivery evidence is outside the validated state root.', {
            path: canonical,
            stateRoot
        })
    }

    let cursor = stateRoot
    for (const component of relative(stateRoot, absolute).split(sep).filter(Boolean)) {
        cursor = resolve(cursor, component)
        if (lstatSync(cursor).isSymbolicLink()) {
            fail('evidence-symlink', `Delivery evidence traverses a symbolic link: ${cursor}.`)
        }
    }
    if (!statSync(canonical).isFile()) fail('evidence-not-file', 'Delivery evidence must be a regular file.')
    return canonical
}

function readEvidence(path) {
    let evidence
    try {
        evidence = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        fail('evidence-invalid', 'Delivery evidence is unreadable or invalid JSON.', {
            path,
            error: error.message
        })
    }
    if (evidence?.schema !== 'issue-orchestration.delivery-evidence.v1') {
        fail('evidence-schema', 'Delivery evidence schema is missing or unsupported.')
    }
    return evidence
}

function evaluate(evidence, stateRoot) {
    const blockers = []
    const candidate = evidence.candidate ?? {}
    if (candidate.committed !== true) blockers.push('candidate-not-committed')
    if (candidate.pushed !== true) blockers.push('candidate-not-pushed')
    if (candidate.remoteVerified !== true) blockers.push('remote-not-verified')
    requireString(candidate.sourceSha, 'candidate.sourceSha')
    requireString(candidate.remoteSha, 'candidate.remoteSha')
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(candidate.sourceSha)) {
        fail('invalid-schema', 'candidate.sourceSha must be a lowercase Git object id.')
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(candidate.remoteSha)) {
        fail('invalid-schema', 'candidate.remoteSha must be a lowercase Git object id.')
    }
    if (candidate.sourceSha !== candidate.remoteSha) blockers.push('candidate-sha-drift')

    const local = evidence.localEquivalent ?? {}
    if (!Array.isArray(local.requiredChecks) || local.requiredChecks.length === 0) {
        blockers.push('local-equivalent-missing')
    } else {
        const checkKeys = new Set()
        for (const check of local.requiredChecks) {
            requireString(check.command, 'localEquivalent.requiredChecks.command')
            requireString(check.environment, 'localEquivalent.requiredChecks.environment')
            requireString(check.evidence, 'localEquivalent.requiredChecks.evidence')
            const checkKey = `${check.command}\n${check.environment}`
            if (checkKeys.has(checkKey)) fail('invalid-schema', 'localEquivalent.requiredChecks contains a duplicate execution key.')
            checkKeys.add(checkKey)
            ensureStateFile(check.evidence, stateRoot)
            if (!Number.isInteger(check.exitCode)) {
                fail('invalid-schema', 'localEquivalent.requiredChecks.exitCode must be an integer.')
            }
            if (check.exitCode !== 0) blockers.push(`local-equivalent-failed:${check.command}`)
        }
    }
    if (local.semanticGap !== false) blockers.push('local-ci-semantic-gap')

    if (
        !Array.isArray(evidence.knownDefects)
        || evidence.knownDefects.some((defect) => typeof defect !== 'string' || defect.trim() === '')
    ) {
        fail('invalid-schema', 'knownDefects must be an array of non-empty strings.')
    }
    if (evidence.knownDefects.length > 0) blockers.push('known-defect')

    const ci = evidence.ci ?? {}
    if (!['passed', 'not_started', 'failed'].includes(ci.status)) {
        fail('ci-status', 'CI status must be passed, not_started, or failed.')
    }
    requireUniqueStringArray(ci.checks, 'ci.checks')
    if (typeof ci.exclusiveMandatoryGate !== 'boolean') {
        fail('invalid-schema', 'ci.exclusiveMandatoryGate must be a boolean.')
    }
    if (ci.status === 'failed') blockers.push('ci-actual-failure')
    if (ci.status === 'not_started') {
        requireString(ci.externalReason, 'ci.externalReason')
        if (ci.exclusiveMandatoryGate) blockers.push('ci-exclusive-gate-unavailable')
    }

    const comment = evidence.completionComment ?? {}
    if (comment.ciStatus !== ci.status) blockers.push('completion-comment-ci-status')
    if (!arraysEqual(comment.ciChecks, ci.checks)) {
        blockers.push('completion-comment-ci-checks')
    }
    const localCommands = local.requiredChecks?.map((check) => check.command) ?? []
    if (!arraysEqual(comment.localCommands, localCommands)) {
        blockers.push('completion-comment-local-commands')
    }
    if (ci.status === 'not_started' && comment.externalReason !== ci.externalReason) {
        blockers.push('completion-comment-external-reason')
    }
    if (comment.claimsCiPassed !== (ci.status === 'passed')) {
        blockers.push('completion-comment-ci-claim')
    }

    const closeAllowed = blockers.length === 0
    return {
        schema: 'issue-orchestration.delivery-closure-result.v1',
        closeAllowed,
        issueState: closeAllowed ? 'completed' : 'open',
        ciEvidence: ci.status === 'not_started' ? 'not_obtained' : ci.status,
        blockers
    }
}


export function evaluateMachineDeliveryClosure({
    cleanupReceipt,
    preRemoteSnapshot,
    postRemoteSnapshot,
    issueState,
    stateReason,
    evaluatedAt
} = {}) {
    if (!cleanupReceipt || typeof cleanupReceipt !== 'object' ||
        Array.isArray(cleanupReceipt)) {
        fail('cleanup-receipt-required',
            'A canonical cleanup receipt is required.')
    }
    const cleanupReceiptDigest = [
        'receiptDigest',
        'proposalDigest',
        'inventoryDigest',
        'contractDigest'
    ].map((field) => cleanupReceipt[field]).find((value) =>
        /^[a-f0-9]{64}$/u.test(value ?? ''))
    if (!cleanupReceiptDigest) {
        fail('cleanup-receipt-invalid',
            'The cleanup receipt has no canonical digest.')
    }
    try {
        validateRemoteStateSnapshot(preRemoteSnapshot)
        validateRemoteStateSnapshot(postRemoteSnapshot)
    } catch (error) {
        fail('remote-snapshot-invalid',
            'Remote issue closure snapshots are invalid.', {
                cause: error?.code ?? error?.message
            })
    }
    if (preRemoteSnapshot.repository !== postRemoteSnapshot.repository ||
        preRemoteSnapshot.issueId !== postRemoteSnapshot.issueId ||
        preRemoteSnapshot.defaultBranch !==
            postRemoteSnapshot.defaultBranch ||
        preRemoteSnapshot.defaultBranchSha !==
            postRemoteSnapshot.defaultBranchSha) {
        fail('remote-snapshot-identity-drift',
            'Remote issue identity or default branch drifted during closure.')
    }
    if (issueState !== 'CLOSED' || stateReason !== 'COMPLETED') {
        fail('remote-issue-not-closed-completed',
            'The remote issue is not closed with the completed reason.', {
                issueState,
                stateReason
            })
    }
    if (postRemoteSnapshot.issueStateDigest !== digest({
        issueState,
        stateReason
    })) {
        fail('remote-issue-state-digest-mismatch',
            'The post-close snapshot does not match the observed issue state.')
    }
    const result = {
        schema: 'issue-orchestration.delivery-closure-result.v1',
        producerAuthority: 'remote-issue-closure-validator',
        closeAllowed: true,
        issueState,
        stateReason,
        cleanupReceiptDigest,
        remotePreSnapshotDigest: preRemoteSnapshot.snapshotDigest,
        remotePostSnapshotDigest: postRemoteSnapshot.snapshotDigest,
        blockers: [],
        evaluatedAt
    }
    return seal(result, 'receiptDigest')
}

export function evaluateDeliveryClosure({
    stateRoot,
    inputPath,
    repositories,
    workspaces
}) {
    const root = validateStateRoot({
        candidate: stateRoot,
        repositories,
        workspaces
    })
    if (!root.candidate.exists) fail('state-root-missing', 'Validated state root must exist.')
    const evidencePath = ensureStateFile(inputPath, root.candidate.canonical)
    return evaluate(readEvidence(evidencePath), root.candidate.canonical)
}

function valuesFor(argv, name) {
    const values = []
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== name) continue
        if (!argv[index + 1]) fail('missing-option-value', `Missing value for ${name}.`)
        values.push(argv[index + 1])
        index += 1
    }
    return values
}

function valueFor(argv, name) {
    return valuesFor(argv, name)[0] ?? null
}

function runCli() {
    try {
        const argv = process.argv.slice(2)
        const result = evaluateDeliveryClosure({
            stateRoot: valueFor(argv, '--state-root'),
            inputPath: valueFor(argv, '--input'),
            repositories: valuesFor(argv, '--repository'),
            workspaces: valuesFor(argv, '--workspace')
        })
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
        const known = error instanceof DeliveryClosureError || error instanceof StateRootValidationError
        const payload = {
            schema: 'issue-orchestration.delivery-closure-result.v1',
            closeAllowed: false,
            issueState: 'open',
            code: known ? error.code : 'unexpected-error',
            reason: error.message,
            details: known ? error.details : {}
        }
        process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
        process.exitCode = 2
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
