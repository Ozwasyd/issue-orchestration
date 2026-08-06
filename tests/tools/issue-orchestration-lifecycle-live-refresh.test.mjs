import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digest } from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import { createSemanticGraph } from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    bindLifecycleSelectorRemoteObservation,
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    lifecycleRunObservationContext,
    projectLifecycleRun,
    readLifecycleRunLedger,
    recordLifecycleDispatchBatchStarted
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    consumeLifecycleRepositoryBaseObservationEpoch,
    declareLifecycleRemoteScopeDeltaObserver,
    executeLifecycleScopeRefresh,
    observeLifecycleRepositoryBaseBeforeAction,
    observeLifecycleRepositoryBaseEpoch,
    verifyLifecycleRepositoryBaseObservationEpoch
} from '../../skills/issue-orchestration/scripts/lifecycle-live-refresh.mjs'
import {
    canonicalRemoteIssueFacts,
    remoteObservationSnapshotDigest
} from '../../skills/issue-orchestration/scripts/scope-selector.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const CREATED_AT = '2026-08-04T00:00:00.000Z'

function git(args, cwd) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_DATE: CREATED_AT,
            GIT_COMMITTER_DATE: CREATED_AT
        }
    })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
    return result.stdout.trim()
}

function initRepository(root) {
    const bare = path.join(root, 'Repo.git')
    const work = path.join(root, 'Repo-work')
    const repository = 'Fixture/Repo'
    const remoteUrl = `https://github.com/${repository}.git`
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'refresh-test'], work)
    git(['config', 'user.email', 'refresh@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), '# Repo\n')
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize'], work)
    git(['push', '-u', 'origin', 'main'], work)
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return { bare, work, repository, remoteUrl }
}

function issue(repository, number, overrides = {}) {
    return {
        repository,
        number,
        state: 'OPEN',
        stateReason: null,
        updatedAt: CREATED_AT,
        title: `Issue ${number}`,
        body: `Body ${number}`,
        comments: [],
        labels: ['orchestration'],
        milestone: null,
        dependsOn: [],
        trackedIssueIds: [],
        ...overrides
    }
}

function selectorDefinition(repository, type, issueIds = []) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: `refresh-${type}-v1`,
        type,
        repositories: [repository],
        parameters: type === 'explicit-issues'
            ? { issueIds, states: ['OPEN'] }
            : { states: ['OPEN'] },
        remoteQueryIdentity: `refresh-test:${type}`
    }
}

function makeFixture({
    type = 'repository-open-issues',
    issues,
    deltaContinuation = false
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-refresh-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-refresh-state-'))
    const repository = initRepository(root)
    const startup = verifiedRuntimeStartup()
    const runId = `run-${type}`
    const rawIssues = issues ?? [issue(repository.repository, 1)]
    const definition = selectorDefinition(
        repository.repository,
        type,
        rawIssues.filter(({ state }) => state === 'OPEN')
            .map(({ number }) => `${repository.repository}#${number}`)
    )
    const authority = compileLifecycleRunGenesisAuthority({
        runId,
        startup,
        stateRoot,
        repositoryTargets: [{
            repository: repository.repository,
            repositoryPath: repository.work,
            defaultBranch: 'main'
        }],
        workspaces: [root],
        worktrees: [],
        slotCapacity: 2,
        createdAt: CREATED_AT
    })
    let selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: definition,
        remoteIssues: rawIssues,
        previousReceipt: null,
        resolvedAt: CREATED_AT
    })
    if (deltaContinuation) {
        selectorReceipt = bindLifecycleSelectorRemoteObservation({
            lifecycleAuthority: authority,
            startup,
            selectorReceipt,
            remoteObservationContinuation: {
                schema:
                    'issue-orchestration.lifecycle-remote-observation-continuation.v1',
                status: 'verified',
                producerAuthority: 'trusted-remote-observation-adapter',
                rootAuthored: false,
                selectorDigest: selectorReceipt.selectorDigest,
                remoteQueryIdentity: selectorReceipt.remoteQueryIdentity,
                remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
                remoteObservationSnapshotDigest:
                    selectorReceipt.remoteObservationSnapshotDigest,
                observationCursor: 'cursor-0',
                conditionalIdentity: 'etag-0',
                observedAt: CREATED_AT
            }
        })
    }
    const binding = repositoryAuthorityFor(authority, repository.repository)
    const policyDigest = digest('live-refresh-policy')
    const selected = rawIssues.filter((entry) =>
        selectorReceipt.resolvedIssueSet.includes(
            `${entry.repository}#${entry.number}`
        ))
    const graph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest(selectorReceipt.resolvedIssueSet),
        semanticGraphInputDigest: digest(selected),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: binding.observedDefaultBranchHead,
            bindingDigest: binding.bindingDigest
        }],
        nodes: selected.map((entry) => ({
            id: `${entry.repository}#${entry.number}`,
            memberId: `${entry.repository}#${entry.number}`,
            repository: entry.repository,
            issueNumber: entry.number,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: 'bounded',
            uiClass: 'non-ui',
            acceptanceGroup: null,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: binding.bindingDigest,
            semanticFactsDigest: digest(entry),
            receipts: {}
        }))
    })
    const ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition: definition,
        semanticGraph: graph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        lifecycleAuthority: authority,
        startup,
        slotCapacity: 2
    })
    return {
        root,
        stateRoot,
        repository,
        startup,
        authority,
        definition,
        ledger,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}

function observation(request, issues, observedAt, mutate = null) {
    const value = {
        schema: 'issue-orchestration.lifecycle-remote-scope-observation.v1',
        producerAuthority: 'trusted-remote-observation-adapter',
        rootAuthored: false,
        selectorDigest: request.selectorDigest,
        remoteQueryIdentity: request.remoteQueryIdentity,
        repositories: request.repositories,
        issues: structuredClone(issues),
        observedAt
    }
    mutate?.(value)
    value.observationDigest = digest(value)
    return value
}

function completeIssue(value) {
    return {
        repository: value.repository,
        number: value.number,
        state: value.state,
        stateReason: value.stateReason ?? null,
        updatedAt: value.updatedAt,
        title: value.title,
        body: value.body,
        comments: structuredClone(value.comments ?? []),
        labels: [...(value.labels ?? [])],
        milestone: value.milestone ? { ...value.milestone } : null,
        dependsOn: [...(value.dependsOn ?? [])],
        trackedIssueIds: [...(value.trackedIssueIds ?? [])]
    }
}

function deltaObservation(request, {
    status,
    currentIssues,
    changes = null,
    observedAt = '2026-08-04T00:10:00.000Z',
    observationCursor = 'cursor-1',
    conditionalIdentity = 'etag-1',
    mutate = null
}) {
    const facts = currentIssues === null
        ? null
        : canonicalRemoteIssueFacts(currentIssues.map(completeIssue))
    const currentRemoteObservationSnapshotDigest = status === 'unchanged'
        ? request.previousRemoteObservationSnapshotDigest
        : remoteObservationSnapshotDigest({
            selectorDigest: request.selectorDigest,
            remoteIssueFacts: facts
        })
    const value = {
        schema:
            'issue-orchestration.lifecycle-remote-scope-delta-observation.v1',
        status,
        producerAuthority: 'trusted-remote-observation-adapter',
        rootAuthored: false,
        selectorDigest: request.selectorDigest,
        remoteQueryIdentity: request.remoteQueryIdentity,
        repositories: request.repositories,
        previousSelectorReceiptDigest:
            request.previousSelectorReceiptDigest,
        previousRemoteSnapshotDigest:
            request.previousRemoteSnapshotDigest,
        previousRemoteObservationSnapshotDigest:
            request.previousRemoteObservationSnapshotDigest,
        previousObservationCursor: request.previousObservationCursor,
        previousConditionalIdentity: request.previousConditionalIdentity,
        observationCursor,
        conditionalIdentity,
        currentRemoteObservationSnapshotDigest,
        observedAt
    }
    if (status === 'full') {
        value.issues = currentIssues.map(completeIssue)
    } else if (status === 'changed') {
        value.changes = structuredClone(changes)
    }
    mutate?.(value)
    value.observationDigest = digest(value)
    return value
}

test('authoritative delta unchanged reuses the verified selector receipt without append or rebuild', () => {
    const fixture = makeFixture({ deltaContinuation: true })
    try {
        const before = lifecycleRunObservationContext(fixture.ledger, {
            startup: fixture.startup
        })
        let diagnostics = null
        let calls = 0
        const observer = declareLifecycleRemoteScopeDeltaObserver((request) => {
            calls += 1
            assert.equal(
                request.schema,
                'issue-orchestration.lifecycle-remote-scope-request.v2'
            )
            assert.equal(request.fullObservationRequired, false)
            assert.equal(request.previousObservationCursor, 'cursor-0')
            assert.equal(request.previousConditionalIdentity, 'etag-0')
            assert.equal(
                request.previousRemoteObservationSnapshotDigest,
                before.selectorReceipt.remoteObservationSnapshotDigest
            )
            return deltaObservation(request, {
                status: 'unchanged',
                currentIssues: null,
                observationCursor: 'cursor-0',
                conditionalIdentity: 'etag-0'
            })
        })
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: observer,
            onObservation(value) {
                diagnostics = value
            },
            startup: fixture.startup
        })
        assert.strictEqual(next, fixture.ledger)
        assert.equal(calls, 1)
        const after = lifecycleRunObservationContext(next, {
            startup: fixture.startup
        })
        assert.deepEqual(after.selectorReceipt, before.selectorReceipt)
        assert.deepEqual(diagnostics, {
            protocol: 'delta-v1',
            observationStatus: 'unchanged',
            remoteFactsTransferred: 0,
            deltaMembers: 0,
            selectorRebuilt: false
        })
    } finally {
        fixture.cleanup()
    }
})

test('first delta-aware observation requires a complete snapshot and persists its continuation', () => {
    const fixture = makeFixture()
    try {
        const before = lifecycleRunObservationContext(fixture.ledger, {
            startup: fixture.startup
        })
        const currentIssues = [issue('Fixture/Repo', 1)]
        const observer = declareLifecycleRemoteScopeDeltaObserver((request) => {
            assert.equal(request.fullObservationRequired, true)
            assert.equal(request.previousObservationCursor, null)
            assert.equal(request.previousConditionalIdentity, null)
            return deltaObservation(request, {
                status: 'full',
                currentIssues,
                observedAt: '2026-08-04T00:10:15.000Z',
                observationCursor: 'cursor-1',
                conditionalIdentity: 'etag-1'
            })
        })
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: observer,
            startup: fixture.startup
        })
        const after = lifecycleRunObservationContext(next, {
            startup: fixture.startup
        })
        assert.equal(
            after.selectorReceipt.remoteSnapshotDigest,
            before.selectorReceipt.remoteSnapshotDigest
        )
        assert.deepEqual(after.nodes, before.nodes)
        assert.equal(
            after.selectorReceipt.remoteObservationContinuation
                .observationCursor,
            'cursor-1'
        )
        assert.notEqual(
            after.controlLedgerHeadDigest,
            before.controlLedgerHeadDigest
        )
    } finally {
        fixture.cleanup()
    }
})

test('delta changes outside selected scope advance observation authority without rebinding active nodes', () => {
    const fixture = makeFixture({
        deltaContinuation: true,
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2, { state: 'CLOSED' })
        ]
    })
    try {
        const before = lifecycleRunObservationContext(fixture.ledger, {
            startup: fixture.startup
        })
        const observedAt = '2026-08-04T00:10:30.000Z'
        const currentIssues = [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2, {
                state: 'CLOSED',
                title: 'Excluded issue changed',
                updatedAt: observedAt
            })
        ]
        const changedObserver = declareLifecycleRemoteScopeDeltaObserver(
            (request) => deltaObservation(request, {
                status: 'changed',
                currentIssues,
                changes: [{
                    kind: 'upsert',
                    issue: completeIssue(currentIssues[1])
                }],
                observedAt,
                observationCursor: 'cursor-1',
                conditionalIdentity: 'etag-1'
            })
        )
        const advanced = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: changedObserver,
            startup: fixture.startup
        })
        const after = lifecycleRunObservationContext(advanced, {
            startup: fixture.startup
        })
        assert.equal(
            after.selectorReceipt.remoteSnapshotDigest,
            before.selectorReceipt.remoteSnapshotDigest
        )
        assert.notEqual(
            after.selectorReceipt.remoteObservationSnapshotDigest,
            before.selectorReceipt.remoteObservationSnapshotDigest
        )
        assert.notEqual(
            after.selectorReceipt.receiptDigest,
            before.selectorReceipt.receiptDigest
        )
        assert.equal(
            after.selectorReceipt.remoteObservationContinuation
                .observationCursor,
            'cursor-1'
        )
        assert.deepEqual(after.nodes, before.nodes)
        assert.notEqual(
            after.controlLedgerHeadDigest,
            before.controlLedgerHeadDigest
        )

        const unchangedObserver = declareLifecycleRemoteScopeDeltaObserver(
            (request) => deltaObservation(request, {
                status: 'unchanged',
                currentIssues: null,
                observedAt: '2026-08-04T00:10:31.000Z',
                observationCursor: 'cursor-1',
                conditionalIdentity: 'etag-1'
            })
        )
        const unchanged = executeLifecycleScopeRefresh({
            ledger: advanced,
            observeRemoteIssues: unchangedObserver,
            startup: fixture.startup
        })
        assert.strictEqual(unchanged, advanced)
        assert.deepEqual(
            lifecycleRunObservationContext(unchanged, {
                startup: fixture.startup
            }).selectorReceipt,
            after.selectorReceipt
        )
    } finally {
        fixture.cleanup()
    }
})

test('changed-member delta and complete observation compile the same canonical selector receipt', () => {
    const fixture = makeFixture({
        deltaContinuation: true,
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2, { state: 'CLOSED' })
        ]
    })
    try {
        const previous = lifecycleRunObservationContext(fixture.ledger, {
            startup: fixture.startup
        }).selectorReceipt
        const observedAt = '2026-08-04T00:11:00.000Z'
        const currentIssues = [
            issue('Fixture/Repo', 1, {
                title: 'Changed title',
                body: 'Changed body',
                updatedAt: observedAt,
                comments: [{
                    id: 'relevant-1',
                    body: 'Changed acceptance',
                    updatedAt: observedAt,
                    relevant: true
                }],
                labels: ['orchestration', 'priority:p0'],
                milestone: { number: 7, title: 'Delta' },
                dependsOn: ['Fixture/Repo#3']
            }),
            issue('Fixture/Repo', 2, {
                state: 'OPEN',
                updatedAt: observedAt
            }),
            issue('Fixture/Repo', 3, {
                updatedAt: observedAt
            })
        ]
        let expected = resolveLifecycleSelector({
            lifecycleAuthority: fixture.authority,
            startup: fixture.startup,
            selector: fixture.definition,
            remoteIssues: currentIssues.map(completeIssue),
            previousReceipt: previous,
            resolvedAt: observedAt
        })
        expected = bindLifecycleSelectorRemoteObservation({
            lifecycleAuthority: fixture.authority,
            startup: fixture.startup,
            selectorReceipt: expected,
            remoteObservationContinuation: {
                schema:
                    'issue-orchestration.lifecycle-remote-observation-continuation.v1',
                status: 'verified',
                producerAuthority: 'trusted-remote-observation-adapter',
                rootAuthored: false,
                selectorDigest: expected.selectorDigest,
                remoteQueryIdentity: expected.remoteQueryIdentity,
                remoteSnapshotDigest: expected.remoteSnapshotDigest,
                remoteObservationSnapshotDigest:
                    expected.remoteObservationSnapshotDigest,
                observationCursor: 'cursor-1',
                conditionalIdentity: 'etag-1',
                observedAt
            }
        })
        const changes = currentIssues.map((entry) => ({
            kind: 'upsert',
            issue: completeIssue(entry)
        }))
        let diagnostics = null
        const observer = declareLifecycleRemoteScopeDeltaObserver((request) =>
            deltaObservation(request, {
                status: 'changed',
                currentIssues,
                changes,
                observedAt
            }))
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: observer,
            onObservation(value) {
                diagnostics = value
            },
            startup: fixture.startup
        })
        const context = lifecycleRunObservationContext(next, {
            startup: fixture.startup
        })
        assert.deepEqual(context.selectorReceipt, expected)
        assert.deepEqual(context.selectorReceipt.remoteChangeSet, {
            added: ['Fixture/Repo#2', 'Fixture/Repo#3'],
            changed: ['Fixture/Repo#1'],
            closed: [],
            removed: [],
            reopened: []
        })
        assert.deepEqual(Object.keys(context.nodes).sort(), [
            'Fixture/Repo#1',
            'Fixture/Repo#2',
            'Fixture/Repo#3'
        ])
        assert.deepEqual(diagnostics, {
            protocol: 'delta-v1',
            observationStatus: 'changed',
            remoteFactsTransferred: 3,
            deltaMembers: 3,
            selectorRebuilt: true
        })
    } finally {
        fixture.cleanup()
    }
})

test('delta application converges with complete canonical resolution for additions, changes, and departures', async (t) => {
    const scenarios = [
        {
            name: 'addition',
            initial: [issue('Fixture/Repo', 1)],
            current: [
                issue('Fixture/Repo', 1),
                issue('Fixture/Repo', 2, {
                    updatedAt: '2026-08-04T00:11:30.000Z'
                })
            ],
            changes(current) {
                return [{
                    kind: 'upsert',
                    issue: completeIssue(current[1])
                }]
            }
        },
        {
            name: 'selected member change',
            initial: [issue('Fixture/Repo', 1)],
            current: [issue('Fixture/Repo', 1, {
                body: 'Updated acceptance facts',
                updatedAt: '2026-08-04T00:11:30.000Z'
            })],
            changes(current) {
                return [{
                    kind: 'upsert',
                    issue: completeIssue(current[0])
                }]
            }
        },
        {
            name: 'dynamic departure',
            initial: [
                issue('Fixture/Repo', 1),
                issue('Fixture/Repo', 2)
            ],
            current: [
                issue('Fixture/Repo', 1),
                issue('Fixture/Repo', 2, {
                    state: 'CLOSED',
                    updatedAt: '2026-08-04T00:11:30.000Z'
                })
            ],
            changes(current) {
                return [{
                    kind: 'upsert',
                    issue: completeIssue(current[1])
                }]
            }
        }
    ]
    for (const scenario of scenarios) {
        await t.test(scenario.name, () => {
            const fixture = makeFixture({
                deltaContinuation: true,
                issues: scenario.initial
            })
            try {
                const previous = lifecycleRunObservationContext(
                    fixture.ledger,
                    { startup: fixture.startup }
                ).selectorReceipt
                const observedAt = '2026-08-04T00:11:30.000Z'
                let expected = resolveLifecycleSelector({
                    lifecycleAuthority: fixture.authority,
                    startup: fixture.startup,
                    selector: fixture.definition,
                    remoteIssues: scenario.current.map(completeIssue),
                    previousReceipt: previous,
                    resolvedAt: observedAt
                })
                expected = bindLifecycleSelectorRemoteObservation({
                    lifecycleAuthority: fixture.authority,
                    startup: fixture.startup,
                    selectorReceipt: expected,
                    remoteObservationContinuation: {
                        schema:
                            'issue-orchestration.lifecycle-remote-observation-continuation.v1',
                        status: 'verified',
                        producerAuthority:
                            'trusted-remote-observation-adapter',
                        rootAuthored: false,
                        selectorDigest: expected.selectorDigest,
                        remoteQueryIdentity:
                            expected.remoteQueryIdentity,
                        remoteSnapshotDigest:
                            expected.remoteSnapshotDigest,
                        remoteObservationSnapshotDigest:
                            expected.remoteObservationSnapshotDigest,
                        observationCursor: 'cursor-1',
                        conditionalIdentity: 'etag-1',
                        observedAt
                    }
                })
                const observer = declareLifecycleRemoteScopeDeltaObserver(
                    (request) => deltaObservation(request, {
                        status: 'changed',
                        currentIssues: scenario.current,
                        changes: scenario.changes(scenario.current),
                        observedAt
                    })
                )
                const next = executeLifecycleScopeRefresh({
                    ledger: fixture.ledger,
                    observeRemoteIssues: observer,
                    startup: fixture.startup
                })
                const actual = lifecycleRunObservationContext(next, {
                    startup: fixture.startup
                }).selectorReceipt
                assert.deepEqual(actual, expected)
            } finally {
                fixture.cleanup()
            }
        })
    }
})

test('delta removals, additions, and reopen facts remain visible to dynamic selectors', () => {
    const fixture = makeFixture({
        deltaContinuation: true,
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2)
        ]
    })
    try {
        const observedAt = '2026-08-04T00:12:00.000Z'
        const currentIssues = [
            issue('Fixture/Repo', 1, {
                state: 'CLOSED',
                updatedAt: observedAt
            }),
            issue('Fixture/Repo', 3, {
                updatedAt: observedAt
            })
        ]
        const observer = declareLifecycleRemoteScopeDeltaObserver((request) =>
            deltaObservation(request, {
                status: 'changed',
                currentIssues,
                changes: [
                    {
                        kind: 'upsert',
                        issue: completeIssue(currentIssues[0])
                    },
                    {
                        kind: 'remove',
                        repository: 'Fixture/Repo',
                        number: 2
                    },
                    {
                        kind: 'upsert',
                        issue: completeIssue(currentIssues[1])
                    }
                ],
                observedAt
            }))
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: observer,
            startup: fixture.startup
        })
        const receipt = lifecycleRunObservationContext(next, {
            startup: fixture.startup
        }).selectorReceipt
        assert.deepEqual(receipt.resolvedIssueSet, ['Fixture/Repo#3'])
        assert.deepEqual(receipt.remoteChangeSet.added, ['Fixture/Repo#3'])
        assert.deepEqual(receipt.remoteChangeSet.removed, [
            'Fixture/Repo#1',
            'Fixture/Repo#2'
        ])
    } finally {
        fixture.cleanup()
    }
})

test('invalid, partial, stale, and contradictory delta responses never become unchanged', async (t) => {
    const fixture = makeFixture({ deltaContinuation: true })
    try {
        const cases = [
            ['stale cursor', (value) => {
                value.previousObservationCursor = 'stale-cursor'
            }],
            ['wrong selector', (value) => {
                value.selectorDigest = digest('wrong-selector')
            }],
            ['wrong authority', (value) => {
                value.producerAuthority = 'caller-authored-cache'
            }],
            ['contradictory snapshot', (value) => {
                value.currentRemoteObservationSnapshotDigest =
                    digest('wrong-snapshot')
            }],
            ['missing field', (value) => {
                delete value.conditionalIdentity
            }]
        ]
        for (const [name, mutate] of cases) {
            await t.test(name, () => {
                const observer = declareLifecycleRemoteScopeDeltaObserver(
                    (request) => deltaObservation(request, {
                        status: 'unchanged',
                        currentIssues: null,
                        observationCursor: 'cursor-0',
                        conditionalIdentity: 'etag-0',
                        mutate
                    })
                )
                assert.throws(
                    () => executeLifecycleScopeRefresh({
                        ledger: fixture.ledger,
                        observeRemoteIssues: observer,
                        startup: fixture.startup
                    }),
                    ({ code }) => typeof code === 'string' &&
                        code.startsWith('lifecycle-remote-delta-')
                )
            })
        }
        await t.test('partial changed member', () => {
            const current = issue('Fixture/Repo', 1, {
                title: 'partial',
                updatedAt: '2026-08-04T00:13:00.000Z'
            })
            const observer = declareLifecycleRemoteScopeDeltaObserver(
                (request) => deltaObservation(request, {
                    status: 'changed',
                    currentIssues: [current],
                    changes: [{
                        kind: 'upsert',
                        issue: (() => {
                            const value = completeIssue(current)
                            delete value.labels
                            return value
                        })()
                    }]
                })
            )
            assert.throws(
                () => executeLifecycleScopeRefresh({
                    ledger: fixture.ledger,
                    observeRemoteIssues: observer,
                    startup: fixture.startup
                }),
                ({ code }) =>
                    code === 'lifecycle-remote-delta-issue-incomplete'
            )
        })
    } finally {
        fixture.cleanup()
    }
})

test('adapters without delta declaration preserve the complete v1 refresh path', () => {
    const fixture = makeFixture({ deltaContinuation: true })
    try {
        let requestSchema = null
        let diagnostics = null
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: (request) => {
                requestSchema = request.schema
                return observation(
                    request,
                    [issue('Fixture/Repo', 1)],
                    '2026-08-04T00:14:00.000Z'
                )
            },
            onObservation(value) {
                diagnostics = value
            },
            startup: fixture.startup
        })
        assert.strictEqual(next, fixture.ledger)
        assert.equal(
            requestSchema,
            'issue-orchestration.lifecycle-remote-scope-request.v1'
        )
        assert.deepEqual(diagnostics, {
            protocol: 'complete-v1',
            observationStatus: 'full',
            remoteFactsTransferred: 1,
            deltaMembers: 0,
            selectorRebuilt: true
        })
    } finally {
        fixture.cleanup()
    }
})

test('scope refresh admits raw remote facts, resets changed nodes, and registers additions', () => {
    const fixture = makeFixture({
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2, { state: 'CLOSED' })
        ]
    })
    try {
        const nextIssues = [
            issue('Fixture/Repo', 1, {
                body: 'Changed requirement',
                updatedAt: '2026-08-04T00:01:00.000Z'
            }),
            issue('Fixture/Repo', 2, {
                state: 'OPEN',
                updatedAt: '2026-08-04T00:01:00.000Z'
            })
        ]
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: (request) => observation(
                request,
                nextIssues,
                '2026-08-04T00:01:00.000Z'
            ),
            startup: fixture.startup
        })
        const context = lifecycleRunObservationContext(next, {
            startup: fixture.startup
        })
        assert.deepEqual(
            Object.keys(context.nodes).sort(),
            ['Fixture/Repo#1', 'Fixture/Repo#2']
        )
        assert.equal(context.nodes['Fixture/Repo#1'].nodeEpoch, 2)
        assert.equal(context.nodes['Fixture/Repo#2'].nodeEpoch, 1)
        const actionSet = compileLifecycleRunActionSet(next, {
            startup: fixture.startup
        })
        assert.deepEqual(
            actionSet.actions.map(({ type }) => type),
            ['request-semantic-proposal', 'request-semantic-proposal']
        )
        const reloaded = readLifecycleRunLedger({
            stateRoot: fixture.stateRoot,
            runId: context.runId,
            startup: fixture.startup
        })
        assert.deepEqual(
            compileLifecycleRunActionSet(reloaded, {
                startup: fixture.startup
            }),
            actionSet
        )
    } finally {
        fixture.cleanup()
    }
})

test('irrelevant comments and local-only metadata do not create a refresh action', () => {
    const fixture = makeFixture()
    try {
        const before = compileLifecycleRunActionSet(
            fixture.ledger,
            { startup: fixture.startup }
        )
        const unchanged = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: (request) => observation(
                request,
                [issue('Fixture/Repo', 1, {
                    comments: [{
                        id: 'noise',
                        body: 'changed but irrelevant',
                        updatedAt: CREATED_AT,
                        relevant: false
                    }],
                    localCacheKey: 'caller-only'
                })],
                '2026-08-04T00:02:00.000Z'
            ),
            startup: fixture.startup
        })
        assert.deepEqual(
            compileLifecycleRunActionSet(unchanged, {
                startup: fixture.startup
            }),
            before
        )
    } finally {
        fixture.cleanup()
    }
})

test('explicit issue scope cannot absorb adjacent issues returned by the observer', () => {
    const fixture = makeFixture({
        type: 'explicit-issues',
        issues: [issue('Fixture/Repo', 1)]
    })
    try {
        const next = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: (request) => observation(
                request,
                [
                    issue('Fixture/Repo', 1, {
                        body: 'Changed selected issue',
                        updatedAt: '2026-08-04T00:03:00.000Z'
                    }),
                    issue('Fixture/Repo', 2)
                ],
                '2026-08-04T00:03:00.000Z'
            ),
            startup: fixture.startup
        })
        const context = lifecycleRunObservationContext(next, {
            startup: fixture.startup
        })
        assert.deepEqual(Object.keys(context.nodes), ['Fixture/Repo#1'])
        assert.deepEqual(
            context.selectorReceipt.resolvedIssueSet,
            ['Fixture/Repo#1']
        )
    } finally {
        fixture.cleanup()
    }
})

test('dynamic selector departure and re-entry use removed and reopened node authority', () => {
    const fixture = makeFixture({
        issues: [issue('Fixture/Repo', 1), issue('Fixture/Repo', 2)]
    })
    try {
        const removed = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssues: (request) => observation(
                request,
                [
                    issue('Fixture/Repo', 1, {
                        state: 'CLOSED',
                        updatedAt: '2026-08-04T00:04:00.000Z'
                    }),
                    issue('Fixture/Repo', 2)
                ],
                '2026-08-04T00:04:00.000Z'
            ),
            startup: fixture.startup
        })
        let context = lifecycleRunObservationContext(removed, {
            startup: fixture.startup
        })
        assert.equal(context.nodes['Fixture/Repo#1'].status, 'removed')
        assert.equal(context.nodes['Fixture/Repo#2'].status, 'active')

        const reopened = executeLifecycleScopeRefresh({
            ledger: removed,
            observeRemoteIssues: (request) => observation(
                request,
                [
                    issue('Fixture/Repo', 1, {
                        updatedAt: '2026-08-04T00:05:00.000Z'
                    }),
                    issue('Fixture/Repo', 2)
                ],
                '2026-08-04T00:05:00.000Z'
            ),
            startup: fixture.startup
        })
        context = lifecycleRunObservationContext(reopened, {
            startup: fixture.startup
        })
        assert.equal(context.nodes['Fixture/Repo#1'].status, 'active')
        assert.equal(context.nodes['Fixture/Repo#1'].nodeEpoch, 2)
        assert.equal(
            projectLifecycleRun(reopened, { startup: fixture.startup })
                .state.nodes['Fixture/Repo#1'].lifecycleState,
            'none'
        )
    } finally {
        fixture.cleanup()
    }
})

test('unsupported scope action is rejected before the remote observer is called', () => {
    const fixture = makeFixture()
    try {
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        let calls = 0
        assert.throws(
            () => executeLifecycleScopeRefresh({
                ledger: fixture.ledger,
                actionSet,
                observeRemoteIssues() {
                    calls += 1
                },
                startup: fixture.startup
            }),
            ({ code }) =>
                code === 'lifecycle-live-refresh-action-unsupported'
        )
        assert.equal(calls, 0)
    } finally {
        fixture.cleanup()
    }
})

test('base observation validates the exact current action without changing state', () => {
    const fixture = makeFixture()
    try {
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        const result = observeLifecycleRepositoryBaseBeforeAction({
            ledger: fixture.ledger,
            actionSet,
            actionDigest: actionSet.actions[0].actionDigest,
            createdAt: CREATED_AT,
            startup: fixture.startup
        })
        assert.equal(result.status, 'current')
        assert.equal(result.actionDigest, actionSet.actions[0].actionDigest)
        assert.equal(result.observations.length, 1)
        assert.equal(
            result.observations[0].origin,
            fixture.repository.remoteUrl
        )
    } finally {
        fixture.cleanup()
    }
})

test('one pre-dispatch epoch is shared by every compatible action for one repository', async () => {
    const fixture = makeFixture({
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2)
        ]
    })
    try {
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        assert.equal(actionSet.actions.length, 2)
        const result = await observeLifecycleRepositoryBaseEpoch({
            ledger: fixture.ledger,
            actionSet,
            actions: actionSet.actions,
            phase: 'pre-dispatch',
            observedAt: CREATED_AT,
            startup: fixture.startup
        })
        assert.equal(result.receipt.status, 'current')
        assert.equal(result.receipt.reusable, true)
        assert.equal(result.receipt.repositories.length, 1)
        assert.equal(result.receipt.actionBindings.length, 2)
        const consumptions = actionSet.actions.map((action) =>
            consumeLifecycleRepositoryBaseObservationEpoch({
                ledger: fixture.ledger,
                receipt: result.receipt,
                action,
                startup: fixture.startup
            }))
        assert.equal(new Set(consumptions.map((entry) =>
            entry.repositoryObservationDigests[0])).size, 1)
    } finally {
        fixture.cleanup()
    }
})

test('an epoch is invalid after the control ledger head changes', async () => {
    const fixture = makeFixture({
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2)
        ]
    })
    try {
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        const result = await observeLifecycleRepositoryBaseEpoch({
            ledger: fixture.ledger,
            actionSet,
            actions: actionSet.actions,
            phase: 'pre-dispatch',
            observedAt: CREATED_AT,
            startup: fixture.startup
        })
        const started = recordLifecycleDispatchBatchStarted({
            ledger: fixture.ledger,
            actionSet,
            dispatches: actionSet.actions.map((action, index) => ({
                actionDigest: action.actionDigest,
                nodeId: action.nodeId,
                owner: 'pre-writer',
                attemptId: `attempt:${index}`,
                slotId: `slot:${index}`,
                runtimeBindingDigest: digest(`runtime:${index}`),
                leaseDigest: digest(`lease:${index}`),
                resourceDigest: digest(`resource:${index}`)
            })),
            createdAt: CREATED_AT,
            startup: fixture.startup
        })
        assert.throws(
            () => verifyLifecycleRepositoryBaseObservationEpoch({
                ledger: started.ledger,
                receipt: result.receipt,
                startup: fixture.startup
            }),
            ({ code }) => code === 'lifecycle-base-epoch-stale'
        )

        const post = await observeLifecycleRepositoryBaseEpoch({
            ledger: started.ledger,
            dispatches: started.dispatches,
            phase: 'post-admission',
            observedAt: '2026-08-04T00:00:01.000Z',
            startup: fixture.startup
        })
        assert.equal(post.receipt.status, 'current')
        assert.equal(post.receipt.repositories.length, 1)
        for (const dispatch of started.dispatches) {
            assert.equal(
                consumeLifecycleRepositoryBaseObservationEpoch({
                    ledger: started.ledger,
                    receipt: post.receipt,
                    action: dispatch.action,
                    dispatchId: dispatch.dispatchId,
                    startup: fixture.startup
                }).dispatchId,
                dispatch.dispatchId
            )
        }
    } finally {
        fixture.cleanup()
    }
})

test('an epoch cannot survive repository identity drift', async () => {
    const fixture = makeFixture()
    try {
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        const result = await observeLifecycleRepositoryBaseEpoch({
            ledger: fixture.ledger,
            actionSet,
            actions: actionSet.actions,
            phase: 'pre-dispatch',
            observedAt: CREATED_AT,
            startup: fixture.startup
        })
        git([
            'remote',
            'set-url',
            'origin',
            'https://github.com/Fixture/Other.git'
        ], fixture.repository.work)
        assert.throws(
            () => verifyLifecycleRepositoryBaseObservationEpoch({
                ledger: fixture.ledger,
                receipt: result.receipt,
                startup: fixture.startup
            }),
            ({ code }) => [
                'lifecycle-run-current-authority-invalid',
                'lifecycle-authority-drift'
            ].includes(code)
        )
    } finally {
        fixture.cleanup()
    }
})

test('one post-admission epoch rejects every dispatch bound to a stale remote head', async () => {
    const fixture = makeFixture({
        issues: [
            issue('Fixture/Repo', 1),
            issue('Fixture/Repo', 2)
        ]
    })
    try {
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        const started = recordLifecycleDispatchBatchStarted({
            ledger: fixture.ledger,
            actionSet,
            dispatches: actionSet.actions.map((action, index) => ({
                actionDigest: action.actionDigest,
                nodeId: action.nodeId,
                owner: 'pre-writer',
                attemptId: `attempt:${index}`,
                slotId: `slot:${index}`,
                runtimeBindingDigest: digest(`runtime:${index}`),
                leaseDigest: digest(`lease:${index}`),
                resourceDigest: digest(`resource:${index}`)
            })),
            createdAt: CREATED_AT,
            startup: fixture.startup
        })
        fs.writeFileSync(
            path.join(fixture.repository.work, 'remote-drift.txt'),
            'remote head changed\n'
        )
        git(['add', 'remote-drift.txt'], fixture.repository.work)
        git(['commit', '-m', 'advance remote'], fixture.repository.work)
        git(['push', 'origin', 'main'], fixture.repository.work)

        const post = await observeLifecycleRepositoryBaseEpoch({
            ledger: started.ledger,
            dispatches: started.dispatches,
            phase: 'post-admission',
            observedAt: '2026-08-04T00:00:02.000Z',
            startup: fixture.startup
        })
        assert.equal(post.receipt.status, 'stale')
        assert.equal(post.receipt.reusable, false)
        assert.deepEqual(post.receipt.driftedRepositories, [
            fixture.repository.repository
        ])
        assert.equal(post.receipt.repositories.length, 1)
        for (const dispatch of started.dispatches) {
            assert.throws(
                () => consumeLifecycleRepositoryBaseObservationEpoch({
                    ledger: started.ledger,
                    receipt: post.receipt,
                    action: dispatch.action,
                    dispatchId: dispatch.dispatchId,
                    startup: fixture.startup
                }),
                ({ code }) => code === 'lifecycle-base-epoch-not-current'
            )
        }
    } finally {
        fixture.cleanup()
    }
})

test('remote observer cannot smuggle caller-authored lifecycle authority', () => {
    const fixture = makeFixture()
    try {
        assert.throws(
            () => executeLifecycleScopeRefresh({
                ledger: fixture.ledger,
                observeRemoteIssues: (request) => observation(
                    request,
                    [issue('Fixture/Repo', 1, {
                        body: 'changed',
                        updatedAt: '2026-08-04T00:06:00.000Z',
                        selectorReceipt: { status: 'verified' }
                    })],
                    '2026-08-04T00:06:00.000Z'
                ),
                startup: fixture.startup
            }),
            ({ code }) =>
                code ===
                    'lifecycle-remote-observation-authority-forbidden'
        )
    } finally {
        fixture.cleanup()
    }
})
