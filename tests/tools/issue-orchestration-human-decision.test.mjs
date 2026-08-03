import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const packageScripts = 'skills/issue-orchestration/scripts'
const implementationRelative = `${packageScripts}/human-decision.mjs`
const implementationPath = resolve(root, implementationRelative)
const ledgerPath = resolve(root, `${packageScripts}/event-ledger.mjs`)
const routingPolicyPath = resolve(root, 'policy/routing-policy.json')
const HASH = /^[a-f0-9]{64}$/u

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function assertError(operation, code) {
    assert.throws(operation, (error) => error?.code === code,
        `expected human-decision error ${code}`)
}

const context = Object.freeze({
    repository: 'ExampleOrg/RepositoryA',
    issue: 1835,
    node: 'ExampleOrg/RepositoryA#1835',
    attempt: 'attempt-1835-human-decision-1',
    acceptanceGroup: 'orchestration-governance',
    member: 'human-decision-gate',
    baseSha: '75c695611476edc25b25f54bdde5edcb64bf6f93',
    epochId: 'epoch-1835-1',
    candidateSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    issueSnapshotDigest: 'b'.repeat(64),
    authoritySourcesDigest: 'c'.repeat(64)
})

function requestInput(overrides = {}) {
    return {
        ...context,
        triggerClass: 'ui-authority-conflict',
        blockedDecision: 'Choose one of two compatible UI system directions.',
        machineInvestigation: {
            status: 'complete',
            digest: 'd'.repeat(64),
            classification: 'not-invocation-environment-or-test-failure'
        },
        adjudication: {
            status: 'complete',
            role: 'ui-system-adjudicator',
            profile: 'gpt-5.6-sol/xhigh',
            digest: 'e'.repeat(64),
            conclusion: 'two-legal-user-visible-options'
        },
        authoritativeSources: [{
            source: 'https://github.com/ExampleOrg/RepositoryA/issues/1835',
            digest: 'f'.repeat(64),
            authority: 'repository-maintainer'
        }],
        authorityConflict: [{
            source: 'design-system',
            conflict: 'two legal product directions remain'
        }],
        options: [{
            id: 'compact',
            summary: 'Keep the current compact system.',
            behavioralConsequences: ['Existing workflow remains compact.'],
            compatibilityConsequences: ['No public API change.'],
            securityOrDataConsequences: ['No new data boundary.'],
            workPreservationConsequences: ['Retain the current candidate.'],
            reversible: true
        }, {
            id: 'expanded',
            summary: 'Adopt the expanded system direction.',
            behavioralConsequences: ['The editor becomes user-visibly richer.'],
            compatibilityConsequences: ['Existing public API remains compatible.'],
            securityOrDataConsequences: ['No new data boundary.'],
            workPreservationConsequences: ['Retain candidate for rework.'],
            reversible: true
        }],
        recommendedOption: 'compact',
        recommendationEvidence: ['Current design-system authority has no unique answer.'],
        safeNoDecisionDisposition: 'freeze-semantic-progress-retain-resources',
        requiredHumanAuthority: 'product-owner',
        retainedResources: [{
            resourceId: 'worktree-1835',
            ownerAttemptId: context.attempt,
            ownerClass: 'attempt-owned',
            disposition: 'retained-pending-human-decision'
        }],
        ...overrides
    }
}

const requiredExports = [
    'evaluateHumanDecisionEligibility',
    'createHumanDecisionRequest',
    'validateHumanDecisionRequest',
    'recordHumanDecision',
    'validateHumanDecisionReceipt',
    'evaluateHumanDecisionContext',
    'validateHumanDecisionRetention',
    'resumeHumanDecision'
]

let implementationPromise
async function implementation() {
    assert.equal(existsSync(implementationPath), true,
        `missing #1835 current human-decision runtime owner: ${implementationRelative}`)
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing export ${name}`)
    }
    return loaded
}

test('H01 current package owns an executable human-decision runtime contract', async () => {
    await implementation()
})

test('H02 ordinary failures remain machine-owned; only completed authority conflicts are eligible', async () => {
    const loaded = await implementation()
    const ordinary = loaded.evaluateHumanDecisionEligibility({
        machineInvestigation: { status: 'complete' },
        adjudication: { status: 'complete', role: 'ui-system-adjudicator', profile: 'gpt-5.6-sol/high' },
        triggerClass: 'git-conflict',
        legalOptionCount: 1,
        missingConstraintAuthority: null
    })
    assert.equal(ordinary.eligible, false)
    assert.equal(ordinary.disposition, 'machine-continue')

    const eligible = loaded.evaluateHumanDecisionEligibility({
        machineInvestigation: { status: 'complete' },
        adjudication: {
            status: 'complete',
            role: 'ui-system-adjudicator',
            profile: 'gpt-5.6-sol/xhigh',
            finalReadOnly: true
        },
        triggerClass: 'ui-authority-conflict',
        legalOptionCount: 2,
        missingConstraintAuthority: 'product-owner',
        userVisibleOrIrreversibleDifference: true
    })
    assert.equal(eligible.eligible, true)
    assert.equal(eligible.requiredHumanAuthority, 'product-owner')

    assertError(() => loaded.evaluateHumanDecisionEligibility({
        machineInvestigation: { status: 'complete' },
        adjudication: { status: 'complete', role: 'root-scheduler', profile: 'gpt-5.6-luna/low' },
        triggerClass: 'authority-conflict',
        legalOptionCount: 2,
        missingConstraintAuthority: 'product-owner',
        userVisibleOrIrreversibleDifference: true
    }), 'human-decision-adjudicator-authority')
})

test('H03 request is single-decision, authority-bound, complete, and fails closed when required evidence is missing', async () => {
    const loaded = await implementation()
    const request = loaded.createHumanDecisionRequest(requestInput())
    assert.equal(request.schema, 'issue-orchestration.human-decision-request.v1')
    assert.equal(request.requestId.length > 0, true)
    assert.equal(request.options.length, 2)
    assert.equal(request.requiredHumanAuthority, 'product-owner')
    assert.equal(request.safeNoDecisionDisposition, 'freeze-semantic-progress-retain-resources')
    for (const field of [
        'machineInvestigationDigest', 'adjudicationDigest', 'contextDigest',
        'retainedResourceDigest', 'requestDigest'
    ]) assert.equal(HASH.test(request[field]), true, `missing digest ${field}`)
    assert.deepEqual(loaded.validateHumanDecisionRequest(request).status, 'valid')

    const missingAuthority = clone(requestInput({ requiredHumanAuthority: null }))
    assertError(() => loaded.createHumanDecisionRequest(missingAuthority), 'human-decision-required-authority')
    assertError(() => loaded.createHumanDecisionRequest(requestInput({
        options: [requestInput().options[0]]
    })), 'human-decision-not-ambiguous')
})

test('H04 receipt and retention bind context, invalidate stale decisions, and resume through normal routing only', async () => {
    const loaded = await implementation()
    const request = loaded.createHumanDecisionRequest(requestInput())
    const receipt = loaded.recordHumanDecision({
        request,
        humanAuthority: 'product-owner',
        authorityEvidence: [{ source: 'github-issue-comment', digest: '1'.repeat(64) }],
        decision: 'select-option',
        selectedOption: 'compact',
        additionalAuthoritativeFacts: ['Product owner selected compact direction.'],
        decidedAt: '2026-08-02T01:00:00.000Z'
    })
    assert.equal(receipt.schema, 'issue-orchestration.human-decision-receipt.v1')
    assert.equal(receipt.requestId, request.requestId)
    assert.equal(receipt.requestDigest, request.requestDigest)
    assert.equal(receipt.contextDigest, request.contextDigest)
    assert.equal(HASH.test(receipt.receiptDigest), true)
    assert.deepEqual(loaded.validateHumanDecisionReceipt({ request, receipt }).status, 'valid')
    assert.deepEqual(loaded.validateHumanDecisionRetention({ request }).status, 'retained')

    const current = loaded.evaluateHumanDecisionContext({ request, currentContext: context })
    assert.equal(current.valid, true)
    const drifted = loaded.evaluateHumanDecisionContext({
        request,
        currentContext: { ...context, baseSha: '9'.repeat(40) }
    })
    assert.equal(drifted.valid, false)
    assert.equal(drifted.disposition, 'human-decision-invalidated')
    assertError(() => loaded.resumeHumanDecision({
        request,
        receipt,
        currentContext: { ...context, baseSha: '9'.repeat(40) }
    }), 'human-decision-context-invalidated')

    const resumed = loaded.resumeHumanDecision({ request, receipt, currentContext: context })
    assert.equal(resumed.resumeMode, 'recompute-routing-and-reverify')
    assert.notEqual(resumed.nextStageProfile, 'sol-xhigh')
    assert.notEqual(resumed.nextState, 'behavior-green')
    assert.notEqual(resumed.nextState, 'closed')
})

test('H05 ledger and deterministic routing preserve the human gate boundaries', async () => {
    const { transitionTable } = await import(pathToFileURL(ledgerPath).href)
    for (const eventType of [
        'decision-analysis.started', 'decision-analysis.completed',
        'human-decision.required', 'human-decision.recorded',
        'human-decision.invalidated', 'contract.rebased', 'node.resumed'
    ]) assert.ok(transitionTable[eventType], `missing ledger event ${eventType}`)
    assert.deepEqual(transitionTable['human-decision.required'].transitions,
        [['decision-analysis-completed', 'human-decision-required']])
    assert.equal(transitionTable['human-decision.recorded'].transitions
        .some(([, to]) => ['behavior-green', 'closed', 'delivery-ready'].includes(to)), false)

    const routing = JSON.parse(readFileSync(routingPolicyPath, 'utf8'))
    assert.ok(routing.forbiddenInputs.includes('humanPreference'))
    assert.ok(routing.forbiddenInputs.includes('reworkCount'))
    assert.equal(digest(routing).length, 64)
})
