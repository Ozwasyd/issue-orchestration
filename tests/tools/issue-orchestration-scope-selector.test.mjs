import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    routeActorFor
} from './issue-orchestration-route-test-helper.mjs'

const root = resolve(import.meta.dirname, '../..')
const fixturePath = resolve(
    root,
    'tests/fixtures/issue-orchestration/scope-selector-cases.json'
)
const implementationPath = resolve(
    root,
    'skills/issue-orchestration/scripts/scope-selector.mjs'
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const requiredExports = [
    'resolveSelector',
    'evaluateDagUpdate',
    'validateDagProposalAcceptance',
    'validateDeliveryWindow'
]
const runtimeStartup = verifiedRuntimeStartup({})

let implementationPromise

function clone(value) {
    return structuredClone(value)
}

function idOf(issue) {
    return `${issue.repository}#${issue.number}`
}

function sorted(values) {
    return [...values].sort()
}

async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1825 runtime contract: ${implementationPath}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing exported function ${name}`)
    }
    return loaded
}

async function resolveFixture(
    selectorName,
    {
        remoteIssues = fixture.remoteIssues,
        previousReceipt = null,
        selector = fixture.selectors[selectorName],
        resolvedAt = fixture.resolvedAt
    } = {}
) {
    const { resolveSelector } = await implementation()
    return resolveSelector({
        selector: clone(selector),
        remoteIssues: clone(remoteIssues),
        previousReceipt: previousReceipt ? clone(previousReceipt) : null,
        resolvedAt,
        startup: runtimeStartup
    })
}

function assertDigest(value, label) {
    assert.match(value, /^[a-f0-9]{64}$/u, `${label} must be a lowercase SHA-256`)
}

function assertReceiptShape(receipt, selector, previousReceipt = null) {
    assert.equal(receipt.schema, 'issue-orchestration.selector-receipt.v1')
    assert.equal(
        receipt.startupAttestationDigest,
        runtimeStartup.attestation.attestationDigest
    )
    assert.equal(
        receipt.runtimeInvocationId,
        runtimeStartup.attestation.runtimeInvocationId
    )
    assert.equal(receipt.selectorVersion, selector.selectorVersion)
    assert.equal(receipt.type, selector.type)
    assert.equal(receipt.remoteQueryIdentity, selector.remoteQueryIdentity)
    assert.equal(receipt.resolvedAt, fixture.resolvedAt)
    assert.equal(
        receipt.previousRemoteSnapshotDigest,
        previousReceipt?.remoteSnapshotDigest ?? null
    )
    assert.ok(Array.isArray(receipt.resolvedIssueSet))
    assert.deepEqual(receipt.resolvedIssueSet, sorted(receipt.resolvedIssueSet))
    assert.equal(typeof receipt.exclusionReasons, 'object')
    assert.ok(receipt.exclusionReasons && !Array.isArray(receipt.exclusionReasons))
    assert.equal(typeof receipt.remoteFactDigests, 'object')
    assert.ok(receipt.remoteFactDigests && !Array.isArray(receipt.remoteFactDigests))
    assert.deepEqual(Object.keys(receipt.remoteChangeSet).sort(), [
        'added',
        'changed',
        'closed',
        'removed',
        'reopened'
    ])
    for (const values of Object.values(receipt.remoteChangeSet)) {
        assert.ok(Array.isArray(values))
        assert.deepEqual(values, sorted(values))
    }
    assert.equal(typeof receipt.issueHistory, 'object')
    assert.ok(receipt.issueHistory && !Array.isArray(receipt.issueHistory))
    assertDigest(receipt.parametersDigest, 'parametersDigest')
    assertDigest(receipt.selectorDigest, 'selectorDigest')
    assertDigest(receipt.remoteSnapshotDigest, 'remoteSnapshotDigest')
    assertDigest(receipt.receiptDigest, 'receiptDigest')
}

async function expectDenied(operation, messagePattern = /denied|invalid|required|mismatch|forbidden/iu) {
    try {
        const result = await operation()
        const denied = result?.valid === false
            || result?.accepted === false
            || result?.launchAuthorized === false
        assert.equal(denied, true, 'operation unexpectedly succeeded')
        assert.equal(typeof result.code, 'string', 'denial must expose a stable code')
        assert.match(`${result.code} ${result.reason ?? ''}`, messagePattern)
        return result
    } catch (error) {
        assert.equal(typeof error?.code, 'string', 'denial error must expose a stable code')
        assert.match(`${error.code} ${error.message}`, messagePattern)
        return error
    }
}

function launchRequest(action) {
    return {
        explicit: true,
        requester: routeActorFor({
            stageRole: 'root-scheduler',
            stagePhase: 'scheduling',
            proposalOnly: false,
            actorId: 'root-scheduler:scope-selector'
        }),
        agent: {
            ...routeActorFor({
                stageRole: 'dag-creator-updater',
                stagePhase: 'semantic-proposal',
                proposalOnly: true,
                actorId: 'dag-creator-updater:scope-selector'
            }),
            action,
            resident: false
        }
    }
}


test('fixture freezes all six versioned selector forms and their expansion policies', () => {
    assert.equal(fixture.schema, 'issue-orchestration.scope-selector-test-cases.v1')
    assert.deepEqual(
        Object.values(fixture.selectors).map(({ type }) => type).sort(),
        [
            'dependency-closure',
            'explicit-issues',
            'label-query',
            'milestone-query',
            'parent-tracking-issue',
            'repository-open-issues'
        ]
    )
    for (const selector of Object.values(fixture.selectors)) {
        assert.equal(selector.schema, 'issue-orchestration.scope-selector.v1')
        assert.ok(selector.selectorVersion)
        assert.ok(selector.repositories.length > 0)
        assert.deepEqual(Object.keys(selector.statePolicy).sort(), ['closed', 'open', 'reopen'])
        assert.ok(selector.dependencyClosure)
        assert.ok(selector.implicitExpansion)
        assert.ok(selector.parameters)
        assert.ok(selector.remoteQueryIdentity)
    }
})

test('[A01][M01] every selector produces one complete canonical receipt and exact issue set', async (t) => {
    for (const selectorName of Object.keys(fixture.selectors)) {
        await t.test(selectorName, async () => {
            const receipt = await resolveFixture(selectorName)
            assertReceiptShape(receipt, fixture.selectors[selectorName])
            assert.deepEqual(
                receipt.resolvedIssueSet,
                fixture.expectedIssueSets[selectorName]
            )
            assert.deepEqual(
                receipt.remoteChangeSet.added,
                fixture.expectedIssueSets[selectorName]
            )
            assert.deepEqual(receipt.remoteChangeSet.removed, [])
            assert.deepEqual(receipt.remoteChangeSet.changed, [])
        })
    }
})

test('[A02][N06] explicit scope never absorbs same-label, similar-title, or cross-repository issues', async () => {
    const receipt = await resolveFixture('explicitIssues')
    assert.deepEqual(receipt.resolvedIssueSet, ['ExampleOrg/RepositoryA#101'])
    for (const excluded of [
        'ExampleOrg/RepositoryA#102',
        'ExampleOrg/RepositoryA#103',
        'ExampleOrg/RepositoryA#105',
        'ExampleOrg/RepositoryB#201'
    ]) {
        assert.equal(typeof receipt.exclusionReasons[excluded], 'string', excluded)
        assert.ok(receipt.exclusionReasons[excluded].length > 0, excluded)
    }
})

test('[A03][M02] canonical replay ignores remote ordering but preserves all content digests', async () => {
    const first = await resolveFixture('repositoryOpenIssues')
    const reorderedIssues = clone(fixture.remoteIssues)
        .reverse()
        .map((issue) => ({
            ...issue,
            labels: [...issue.labels].reverse(),
            comments: [...issue.comments].reverse(),
            dependsOn: [...issue.dependsOn].reverse(),
            related: [...issue.related].reverse(),
            mentioned: [...issue.mentioned].reverse(),
            trackedIssueIds: [...issue.trackedIssueIds].reverse()
        }))
    const selector = clone(fixture.selectors.repositoryOpenIssues)
    selector.repositories.reverse()
    selector.parameters.states.reverse()
    const replay = await resolveFixture('repositoryOpenIssues', {
        remoteIssues: reorderedIssues,
        selector
    })

    assert.deepEqual(replay.resolvedIssueSet, first.resolvedIssueSet)
    assert.deepEqual(replay.remoteChangeSet, first.remoteChangeSet)
    assert.equal(replay.parametersDigest, first.parametersDigest)
    assert.equal(replay.selectorDigest, first.selectorDigest)
    assert.equal(replay.remoteSnapshotDigest, first.remoteSnapshotDigest)
    assert.equal(replay.receiptDigest, first.receiptDigest)
})

test('[A04][M03] only enumerated live remote facts participate in the snapshot digest', async (t) => {
    const original = await resolveFixture('explicitIssues')
    const mutations = [
        ['state', (issue) => { issue.state = 'CLOSED' }],
        ['stateReason', (issue) => { issue.stateReason = 'COMPLETED' }],
        ['updatedAt', (issue) => { issue.updatedAt = '2026-07-31T11:00:00.000Z' }],
        ['title', (issue) => { issue.title += ' changed' }],
        ['body', (issue) => { issue.body += ' changed' }],
        ['relevant comment', (issue) => { issue.comments[0].body += ' changed' }],
        ['labels', (issue) => { issue.labels.push('priority:high') }],
        ['milestone', (issue) => { issue.milestone.title += ' changed' }]
    ]

    for (const [name, mutate] of mutations) {
        await t.test(name, async () => {
            const issues = clone(fixture.remoteIssues)
            mutate(issues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101'))
            const changed = await resolveFixture('explicitIssues', {
                remoteIssues: issues,
                previousReceipt: original
            })
            assert.notEqual(changed.remoteSnapshotDigest, original.remoteSnapshotDigest)
            assert.deepEqual(changed.remoteChangeSet.changed, ['ExampleOrg/RepositoryA#101'])
        })
    }

    await t.test('non-relevant comments and local-only metadata are excluded', async () => {
        const issues = clone(fixture.remoteIssues)
        const target = issues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101')
        target.comments[1].body += ' changed'
        target.localExecutionState = {
            testFailed: true,
            slot: 2,
            worktree: '/tmp/noise'
        }
        const unchanged = await resolveFixture('explicitIssues', {
            remoteIssues: issues,
            previousReceipt: original
        })
        assert.equal(unchanged.remoteSnapshotDigest, original.remoteSnapshotDigest)
        assert.deepEqual(unchanged.remoteChangeSet.changed, [])
    })
})

test('[A05][N07][M04] a selector version cannot be reused for changed canonical parameters', async () => {
    const previous = await resolveFixture('explicitIssues')
    const forged = clone(fixture.selectors.explicitIssues)
    forged.parameters.issueIds.push('ExampleOrg/RepositoryA#103')

    await expectDenied(
        () => resolveFixture('explicitIssues', {
            previousReceipt: previous,
            selector: forged
        }),
        /selector.*version|version.*selector|parameters/iu
    )

    forged.selectorVersion = 'explicit-2026-08-01.v2'
    const versioned = await resolveFixture('explicitIssues', {
        previousReceipt: previous,
        selector: forged
    })
    assert.deepEqual(versioned.resolvedIssueSet, [
        'ExampleOrg/RepositoryA#101',
        'ExampleOrg/RepositoryA#103'
    ])
    assert.notEqual(versioned.selectorDigest, previous.selectorDigest)
    assert.notEqual(versioned.remoteSnapshotDigest, previous.remoteSnapshotDigest)
})

test('[A06][M05] dynamic selectors add matches and retain departed-node disposition/history', async () => {
    const previous = await resolveFixture('labelQuery')
    const currentIssues = clone(fixture.remoteIssues)
    const departed = currentIssues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#105')
    departed.labels = departed.labels.filter((label) => label !== 'scope:selector')
    departed.updatedAt = '2026-07-31T12:00:00.000Z'
    const added = currentIssues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#106')
    added.labels.push('scope:selector')
    added.updatedAt = '2026-07-31T12:01:00.000Z'

    const current = await resolveFixture('labelQuery', {
        remoteIssues: currentIssues,
        previousReceipt: previous
    })
    assert.deepEqual(current.remoteChangeSet.added, ['ExampleOrg/RepositoryA#106'])
    assert.deepEqual(current.remoteChangeSet.removed, ['ExampleOrg/RepositoryA#105'])
    assert.equal(
        current.issueHistory['ExampleOrg/RepositoryA#105']?.disposition,
        'left-selector-scope'
    )
    assert.equal(
        current.issueHistory['ExampleOrg/RepositoryA#105']?.previousRemoteSnapshotDigest,
        previous.remoteSnapshotDigest
    )
})

test('[A07][N09][N10][M06] dependency closure follows only declared dependsOn edges', async () => {
    const receipt = await resolveFixture('dependencyClosure')
    assert.deepEqual(receipt.resolvedIssueSet, [
        'ExampleOrg/RepositoryA#101',
        'ExampleOrg/RepositoryA#102',
        'ExampleOrg/RepositoryA#104'
    ])
    assert.equal(receipt.resolvedIssueSet.includes('ExampleOrg/RepositoryA#103'), false)
    assert.equal(receipt.resolvedIssueSet.includes('ExampleOrg/RepositoryA#105'), false)
})

test('[A08][M07] initial DAG creation consumes Root and DAG route decisions', async () => {
    const { evaluateDagUpdate } = await implementation()
    const currentReceipt = await resolveFixture('explicitIssues')
    const result = await evaluateDagUpdate({
        previousRemoteSnapshotDigest: null,
        currentReceipt,
        executionEvents: [],
        launchRequest: launchRequest('semantic-create')
    })
    assert.equal(result.semanticAction, 'create')
    assert.equal(result.dagCreationRequired, true)
    assert.equal(result.dagUpdateRequired, false)
    assert.equal(result.launchAuthorized, true)
    assert.equal(result.agentRole, 'dag-creator-updater')
    assert.equal(result.agentAction, 'semantic-create')
    assert.equal(result.oneShot, true)
})

test('[A09][N04][M08] a changed remote body requires one routed updater launch', async () => {
    const { evaluateDagUpdate } = await implementation()
    const previous = await resolveFixture('explicitIssues')
    const issues = clone(fixture.remoteIssues)
    issues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101').body += ' changed'
    const current = await resolveFixture('explicitIssues', {
        remoteIssues: issues,
        previousReceipt: previous
    })

    const missingLaunch = await evaluateDagUpdate({
        previousRemoteSnapshotDigest: previous.remoteSnapshotDigest,
        currentReceipt: current,
        executionEvents: [],
        launchRequest: null
    })
    assert.equal(missingLaunch.semanticAction, 'update')
    assert.equal(missingLaunch.dagUpdateRequired, true)
    assert.equal(missingLaunch.launchRequired, true)
    assert.equal(missingLaunch.launchAuthorized, false)
    assert.equal(typeof missingLaunch.code, 'string')

    const launched = await evaluateDagUpdate({
        previousRemoteSnapshotDigest: previous.remoteSnapshotDigest,
        currentReceipt: current,
        executionEvents: [],
        launchRequest: launchRequest('semantic-update')
    })
    assert.equal(launched.semanticAction, 'update')
    assert.equal(launched.dagUpdateRequired, true)
    assert.equal(launched.launchAuthorized, true)
    assert.equal(launched.agentRole, 'dag-creator-updater')
    assert.equal(launched.agentAction, 'semantic-update')
    assert.equal(launched.oneShot, true)
})

test('[A10][N01-N03][M09] execution noise is ledger-only and cannot trigger a semantic update', async () => {
    const { evaluateDagUpdate } = await implementation()
    const receipt = await resolveFixture('explicitIssues')
    const executionEvents = [
        { type: 'test-failed', issueId: 'ExampleOrg/RepositoryA#101' },
        { type: 'rework-requested', issueId: 'ExampleOrg/RepositoryA#101' },
        { type: 'agent-blocker', issueId: 'ExampleOrg/RepositoryA#101' },
        { type: 'delivery-epoch-changed', epoch: 2 },
        { type: 'slot-changed', slot: 2 },
        { type: 'lease-changed', lease: 'write-tests-only' },
        { type: 'worktree-changed', path: '/tmp/worktree' },
        { type: 'resource-changed', resource: 'container' },
        { type: 'cleanup-completed', resource: 'worktree' }
    ]
    const result = await evaluateDagUpdate({
        previousRemoteSnapshotDigest: receipt.remoteSnapshotDigest,
        currentReceipt: receipt,
        executionEvents,
        launchRequest: null
    })

    assert.equal(result.semanticAction, 'none')
    assert.equal(result.dagUpdateRequired, false)
    assert.equal(result.launchAuthorized, false)
    assert.deepEqual(
        result.executionLedgerEvents.map(({ type }) => type),
        executionEvents.map(({ type }) => type)
    )
})

test('[A11][N05][M10] subagent discoveries remain possible-remote-contract-impact ledger events', async () => {
    const { evaluateDagUpdate } = await implementation()
    const receipt = await resolveFixture('explicitIssues')
    const report = {
        type: 'possible-remote-contract-impact',
        reporterRole: 'implementer',
        issueId: 'ExampleOrg/RepositoryA#999',
        evidence: 'direct local source observation'
    }
    const result = await evaluateDagUpdate({
        previousRemoteSnapshotDigest: receipt.remoteSnapshotDigest,
        currentReceipt: receipt,
        executionEvents: [report],
        launchRequest: null
    })
    assert.equal(result.semanticAction, 'none')
    assert.equal(result.dagUpdateRequired, false)
    assert.deepEqual(result.executionLedgerEvents, [report])

    const changedIssues = clone(fixture.remoteIssues)
    changedIssues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101').body += ' remote change'
    const changedReceipt = await resolveFixture('explicitIssues', {
        remoteIssues: changedIssues,
        previousReceipt: receipt
    })
    const subagentRequest = launchRequest('semantic-update')
    subagentRequest.requester.role = 'implementer'
    await expectDenied(
        () => evaluateDagUpdate({
            previousRemoteSnapshotDigest: receipt.remoteSnapshotDigest,
            currentReceipt: changedReceipt,
            executionEvents: [report],
            launchRequest: subagentRequest
        }),
        /root|requester|launch/iu
    )
})

test('[A12][N02][N05][M11] all non-root, non-Sol/max, writable, inherited, or resident DAG agents are rejected', async (t) => {
    const { evaluateDagUpdate } = await implementation()
    const previous = await resolveFixture('explicitIssues')
    const selector = clone(fixture.selectors.explicitIssues)
    selector.selectorVersion = 'explicit-2026-08-01.v2'
    selector.parameters.issueIds.push('ExampleOrg/RepositoryA#103')
    const current = await resolveFixture('explicitIssues', {
        previousReceipt: previous,
        selector
    })
    const mutants = [
        ['implicit request', (request) => { request.explicit = false }],
        ['non-root requester', (request) => { request.requester.role = 'reviewer' }],
        ['wrong root route', (request) => {
            request.requester.routeDecision.stageRole =
                'dag-creator-updater'
        }],
        ['wrong agent role', (request) => { request.agent.role = 'issue-implementer' }],
        ['wrong agent action', (request) => {
            request.agent.action = 'unexpected-action'
        }],
        ['wrong agent route', (request) => {
            request.agent.routeDecision.stagePhase = 'implementation'
        }],
        ['writer execution class', (request) => {
            request.agent.executionClass = 'leased-writer'
        }],
        ['inherited context', (request) => { request.agent.freshContext = false }],
        ['resident updater', (request) => { request.agent.resident = true }]
    ]

    for (const [name, mutate] of mutants) {
        await t.test(name, async () => {
            const request = launchRequest('semantic-update')
            mutate(request)
            await expectDenied(
                () => evaluateDagUpdate({
                    previousRemoteSnapshotDigest: previous.remoteSnapshotDigest,
                    currentReceipt: current,
                    executionEvents: [],
                    launchRequest: request
                }),
                /root|model|effort|role|sandbox|fresh|resident|explicit|launch/iu
            )
        })
    }
})

test('[A13][N07][M12] root accepts a DAG proposal byte-for-byte and cannot override selector, issue set, or digest', async () => {
    const { validateDagProposalAcceptance } = await implementation()
    const receipt = await resolveFixture('explicitIssues')
    const proposal = {
        proposalDigest: 'a'.repeat(64),
        selectorReceiptDigest: receipt.receiptDigest,
        remoteSnapshotDigest: receipt.remoteSnapshotDigest,
        resolvedIssueSet: receipt.resolvedIssueSet,
        generatedBy: 'dag-updater'
    }
    const accepted = await validateDagProposalAcceptance({
        proposal,
        acceptance: {
            acceptedBy: 'root-scheduler',
            acceptedWithoutModification: true,
            proposalDigest: proposal.proposalDigest,
            selectorReceiptDigest: proposal.selectorReceiptDigest,
            remoteSnapshotDigest: proposal.remoteSnapshotDigest,
            resolvedIssueSet: proposal.resolvedIssueSet
        }
    })
    assert.equal(accepted.valid, true)
    assert.equal(accepted.accepted, true)

    for (const mutate of [
        (acceptance) => { acceptance.acceptedWithoutModification = false },
        (acceptance) => { acceptance.proposalDigest = 'b'.repeat(64) },
        (acceptance) => { acceptance.selectorReceiptDigest = 'c'.repeat(64) },
        (acceptance) => { acceptance.remoteSnapshotDigest = 'd'.repeat(64) },
        (acceptance) => { acceptance.resolvedIssueSet.push('ExampleOrg/RepositoryA#103') }
    ]) {
        const acceptance = {
            acceptedBy: 'root-scheduler',
            acceptedWithoutModification: true,
            proposalDigest: proposal.proposalDigest,
            selectorReceiptDigest: proposal.selectorReceiptDigest,
            remoteSnapshotDigest: proposal.remoteSnapshotDigest,
            resolvedIssueSet: [...proposal.resolvedIssueSet]
        }
        mutate(acceptance)
        await expectDenied(
            () => validateDagProposalAcceptance({ proposal, acceptance }),
            /proposal|selector|snapshot|issue.*set|modification|mismatch/iu
        )
    }
})

test('[A14][M13] acceptance-group delivery performs one real post-window refresh and at most one update', async () => {
    const { validateDeliveryWindow } = await implementation()
    const previous = await resolveFixture('explicitIssues')
    const issues = clone(fixture.remoteIssues)
    issues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101').state = 'CLOSED'
    issues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101').stateReason = 'COMPLETED'
    issues.find((issue) => idOf(issue) === 'ExampleOrg/RepositoryA#101').updatedAt =
        '2026-07-31T13:00:00.000Z'
    const postWindowReceipt = await resolveFixture('explicitIssues', {
        remoteIssues: issues,
        previousReceipt: previous
    })
    const result = await validateDeliveryWindow({
        grouped: true,
        preWindowRemoteSnapshotDigest: previous.remoteSnapshotDigest,
        postWindowReceipt,
        sideEffects: [
            { issueId: 'ExampleOrg/RepositoryA#101', action: 'comment', status: 'completed' },
            { issueId: 'ExampleOrg/RepositoryA#101', action: 'close', status: 'completed' }
        ],
        refreshes: [
            {
                stage: 'post-window',
                source: 'live-remote',
                observedAfterSideEffects: true,
                remoteSnapshotDigest: postWindowReceipt.remoteSnapshotDigest
            }
        ],
        memberRefreshes: [],
        interrupted: false
    })
    assert.equal(result.valid, true)
    assert.equal(result.refreshCount, 1)
    assert.equal(result.memberRefreshCount, 0)
    assert.equal(result.dagUpdateRequired, true)
    assert.equal(result.maximumDagUpdaterLaunches, 1)
})

test('[A15][M14] grouped delivery rejects inferred, skipped, or per-member snapshots and recovers interrupted windows', async () => {
    const { validateDeliveryWindow } = await implementation()
    const previous = await resolveFixture('explicitIssues')
    const selector = clone(fixture.selectors.explicitIssues)
    selector.selectorVersion = 'explicit-2026-08-01.v2'
    selector.parameters.issueIds.push('ExampleOrg/RepositoryA#103')
    const current = await resolveFixture('explicitIssues', {
        previousReceipt: previous,
        selector
    })
    const baseWindow = {
        grouped: true,
        preWindowRemoteSnapshotDigest: previous.remoteSnapshotDigest,
        postWindowReceipt: current,
        sideEffects: [
            { issueId: 'ExampleOrg/RepositoryA#101', action: 'close', status: 'completed' }
        ],
        refreshes: [
            {
                stage: 'post-window',
                source: 'live-remote',
                observedAfterSideEffects: true,
                remoteSnapshotDigest: current.remoteSnapshotDigest
            }
        ],
        memberRefreshes: [],
        interrupted: false
    }

    const invalidWindows = [
        (window) => { delete window.preWindowRemoteSnapshotDigest },
        (window) => { window.refreshes = [] },
        (window) => { window.refreshes[0].source = 'locally-inferred' },
        (window) => { window.refreshes[0].observedAfterSideEffects = false },
        (window) => { window.memberRefreshes.push({ issueId: 'ExampleOrg/RepositoryA#101' }) },
        (window) => { window.refreshes.push(clone(window.refreshes[0])) },
        (window) => { window.refreshes[0].remoteSnapshotDigest = previous.remoteSnapshotDigest }
    ]
    for (const mutate of invalidWindows) {
        const window = clone(baseWindow)
        mutate(window)
        await expectDenied(
            () => validateDeliveryWindow(window),
            /window|snapshot|refresh|live|member|digest|pre|post/iu
        )
    }

    const recovered = await validateDeliveryWindow({
        ...clone(baseWindow),
        interrupted: true,
        sideEffects: [
            { issueId: 'ExampleOrg/RepositoryA#101', action: 'comment', status: 'completed' },
            { issueId: 'ExampleOrg/RepositoryA#101', action: 'close', status: 'failed' }
        ],
        recovery: {
            recordedCompletedSideEffects: [
                { issueId: 'ExampleOrg/RepositoryA#101', action: 'comment' }
            ],
            liveSnapshotRefreshedAfterRecovery: true
        }
    })
    assert.equal(recovered.valid, true)
    assert.equal(recovered.interruptedRecoveryVerified, true)
})
