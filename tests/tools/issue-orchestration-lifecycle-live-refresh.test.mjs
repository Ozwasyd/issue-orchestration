import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digest } from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import { createSemanticGraph } from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
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
    executeLifecycleScopeRefresh,
    observeLifecycleRepositoryBaseBeforeAction,
    observeLifecycleRepositoryBaseEpoch,
    verifyLifecycleRepositoryBaseObservationEpoch
} from '../../skills/issue-orchestration/scripts/lifecycle-live-refresh.mjs'
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
    remoteObservationCursor = null,
    remoteConditionalIdentity = null
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
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: definition,
        remoteIssues: rawIssues,
        previousReceipt: null,
        resolvedAt: CREATED_AT,
        remoteObservationCursor,
        remoteConditionalIdentity
    })
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

function observation(
    request,
    issues,
    observedAt,
    mutate = null,
    { observationCursor = null, conditionalIdentity = null } = {}
) {
    const value = {
        schema: 'issue-orchestration.lifecycle-remote-scope-observation.v1',
        producerAuthority: 'trusted-remote-observation-adapter',
        rootAuthored: false,
        selectorDigest: request.selectorDigest,
        remoteQueryIdentity: request.remoteQueryIdentity,
        repositories: request.repositories,
        issues: structuredClone(issues),
        observedAt,
        ...(observationCursor ? { observationCursor } : {}),
        ...(conditionalIdentity ? { conditionalIdentity } : {})
    }
    mutate?.(value)
    value.observationDigest = digest(value)
    return value
}

function deltaObservation(request, status, overrides = {}) {
    const common = {
        schema:
            'issue-orchestration.lifecycle-remote-scope-delta-observation.v1',
        producerAuthority: 'trusted-remote-observation-adapter',
        rootAuthored: false,
        status,
        selectorDigest: request.selectorDigest,
        remoteQueryIdentity: request.remoteQueryIdentity,
        repositories: [...request.repositories],
        previousRemoteSnapshotDigest:
            request.previousRemoteSnapshotDigest,
        previousObservationCursor:
            request.previousObservationCursor,
        previousConditionalIdentity:
            request.previousConditionalIdentity,
        observedAt: '2026-08-04T00:10:00.000Z',
        ...overrides
    }
    common.observationDigest = digest(common)
    return common
}

function selectorSemantics(receipt) {
    return {
        resolvedIssueSet: receipt.resolvedIssueSet,
        exclusionReasons: receipt.exclusionReasons,
        remoteSnapshotDigest: receipt.remoteSnapshotDigest,
        remoteFactDigests: receipt.remoteFactDigests,
        remoteChangeSet: receipt.remoteChangeSet,
        issueHistory: receipt.issueHistory,
        issueStates: receipt.issueStates,
        remoteIssueFacts: receipt.remoteIssueFacts,
        remoteObservationCursor: receipt.remoteObservationCursor,
        remoteConditionalIdentity: receipt.remoteConditionalIdentity
    }
}

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


test('authoritative delta unchanged reuses the verified selector without an event', () => {
    const fixture = makeFixture({
        remoteObservationCursor: 'cursor-1',
        remoteConditionalIdentity: 'etag-1'
    })
    try {
        const before = lifecycleRunObservationContext(fixture.ledger, {
            startup: fixture.startup
        })
        const diagnostics = {}
        let deltaCalls = 0
        let fullCalls = 0
        const result = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssueDelta(request) {
                deltaCalls += 1
                assert.equal(request.schema,
                    'issue-orchestration.lifecycle-remote-scope-delta-request.v1')
                assert.equal(request.previousObservationCursor, 'cursor-1')
                assert.equal(request.previousConditionalIdentity, 'etag-1')
                return deltaObservation(request, 'unchanged', {
                    observationCursor: 'cursor-1',
                    conditionalIdentity: 'etag-1'
                })
            },
            observeRemoteIssues() {
                fullCalls += 1
                throw new Error('full observer must not run')
            },
            diagnostics,
            startup: fixture.startup
        })
        const after = lifecycleRunObservationContext(result, {
            startup: fixture.startup
        })
        assert.equal(result, fixture.ledger)
        assert.equal(deltaCalls, 1)
        assert.equal(fullCalls, 0)
        assert.equal(after.controlLedgerHeadDigest,
            before.controlLedgerHeadDigest)
        assert.deepEqual(after.selectorReceipt, before.selectorReceipt)
        assert.deepEqual(diagnostics, {
            mode: 'unchanged',
            fallbackReason: null,
            remoteFactsTransferred: 0,
            selectorRebuildCount: 0
        })
    } finally {
        fixture.cleanup()
    }
})

test('changed delta resolves byte-identically to the canonical full selector', () => {
    const initial = [
        issue('Fixture/Repo', 1),
        issue('Fixture/Repo', 2)
    ]
    const fixture = makeFixture({
        issues: initial,
        remoteObservationCursor: 'cursor-1',
        remoteConditionalIdentity: 'etag-1'
    })
    try {
        const current = [
            issue('Fixture/Repo', 1, {
                body: 'Changed requirement',
                updatedAt: '2026-08-04T00:10:00.000Z'
            }),
            issue('Fixture/Repo', 2),
            issue('Fixture/Repo', 3)
        ]
        const expected = resolveLifecycleSelector({
            lifecycleAuthority: fixture.authority,
            startup: fixture.startup,
            selector: fixture.definition,
            remoteIssues: current,
            previousReceipt: lifecycleRunObservationContext(
                fixture.ledger,
                { startup: fixture.startup }
            ).selectorReceipt,
            resolvedAt: '2026-08-04T00:10:00.000Z',
            remoteObservationCursor: 'cursor-2',
            remoteConditionalIdentity: 'etag-2'
        })
        const diagnostics = {}
        const result = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssueDelta: (request) => deltaObservation(
                request,
                'changed',
                {
                    observationCursor: 'cursor-2',
                    conditionalIdentity: 'etag-2',
                    currentIssueIds: [
                        'Fixture/Repo#1',
                        'Fixture/Repo#2',
                        'Fixture/Repo#3'
                    ],
                    changedIssues: [current[0], current[2]],
                    removedIssueIds: []
                }
            ),
            observeRemoteIssues() {
                throw new Error('full observer must not run')
            },
            diagnostics,
            startup: fixture.startup
        })
        const actual = lifecycleRunObservationContext(result, {
            startup: fixture.startup
        }).selectorReceipt
        assert.deepEqual(selectorSemantics(actual),
            selectorSemantics(expected))
        assert.deepEqual(diagnostics, {
            mode: 'delta',
            fallbackReason: null,
            remoteFactsTransferred: 2,
            selectorRebuildCount: 1
        })
    } finally {
        fixture.cleanup()
    }
})

test('delta and full observation agree for every authoritative member field', async (t) => {
    const mutations = [
        ['title', (entry) => { entry.title = 'Changed title' }],
        ['body', (entry) => { entry.body = 'Changed body' }],
        ['relevant comment', (entry) => {
            entry.comments = [{
                id: 'comment-1',
                body: 'Changed relevant comment',
                updatedAt: '2026-08-04T00:11:00.000Z',
                relevant: true
            }]
        }],
        ['label', (entry) => { entry.labels.push('priority:high') }],
        ['milestone', (entry) => {
            entry.milestone = { number: 9, title: 'Milestone 9' }
        }],
        ['state', (entry) => {
            entry.state = 'CLOSED'
            entry.stateReason = 'COMPLETED'
        }],
        ['dependency', (entry) => {
            entry.dependsOn = ['Fixture/Repo#2']
        }]
    ]
    for (const [name, mutate] of mutations) {
        await t.test(name, () => {
            const fixture = makeFixture({
                issues: [
                    issue('Fixture/Repo', 1),
                    issue('Fixture/Repo', 2)
                ],
                remoteObservationCursor: 'cursor-1',
                remoteConditionalIdentity: 'etag-1'
            })
            try {
                const current = [
                    issue('Fixture/Repo', 1, {
                        updatedAt: '2026-08-04T00:11:00.000Z'
                    }),
                    issue('Fixture/Repo', 2)
                ]
                mutate(current[0])
                const previous = lifecycleRunObservationContext(
                    fixture.ledger,
                    { startup: fixture.startup }
                ).selectorReceipt
                const expected = resolveLifecycleSelector({
                    lifecycleAuthority: fixture.authority,
                    startup: fixture.startup,
                    selector: fixture.definition,
                    remoteIssues: current,
                    previousReceipt: previous,
                    resolvedAt: '2026-08-04T00:11:00.000Z',
                    remoteObservationCursor: 'cursor-2',
                    remoteConditionalIdentity: 'etag-2'
                })
                const result = executeLifecycleScopeRefresh({
                    ledger: fixture.ledger,
                    observeRemoteIssueDelta: (request) => deltaObservation(
                        request,
                        'changed',
                        {
                            observationCursor: 'cursor-2',
                            conditionalIdentity: 'etag-2',
                            currentIssueIds: [
                                'Fixture/Repo#1',
                                'Fixture/Repo#2'
                            ],
                            changedIssues: [current[0]],
                            removedIssueIds: []
                        }
                    ),
                    observeRemoteIssues() {
                        throw new Error('full observer must not run')
                    },
                    startup: fixture.startup
                })
                const actual = lifecycleRunObservationContext(result, {
                    startup: fixture.startup
                }).selectorReceipt
                assert.deepEqual(selectorSemantics(actual),
                    selectorSemantics(expected))
            } finally {
                fixture.cleanup()
            }
        })
    }
})

test('delta additions departures and reopens remain visible', () => {
    const fixture = makeFixture({
        issues: [issue('Fixture/Repo', 1), issue('Fixture/Repo', 2)],
        remoteObservationCursor: 'cursor-1',
        remoteConditionalIdentity: 'etag-1'
    })
    try {
        const closed = issue('Fixture/Repo', 1, {
            state: 'CLOSED',
            updatedAt: '2026-08-04T00:12:00.000Z'
        })
        const added = issue('Fixture/Repo', 3)
        const removed = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssueDelta: (request) => deltaObservation(
                request,
                'changed',
                {
                    observationCursor: 'cursor-2',
                    conditionalIdentity: 'etag-2',
                    currentIssueIds: [
                        'Fixture/Repo#1',
                        'Fixture/Repo#3'
                    ],
                    changedIssues: [closed, added],
                    removedIssueIds: ['Fixture/Repo#2']
                }
            ),
            observeRemoteIssues() {
                throw new Error('full observer must not run')
            },
            startup: fixture.startup
        })
        let context = lifecycleRunObservationContext(removed, {
            startup: fixture.startup
        })
        assert.deepEqual(context.selectorReceipt.remoteChangeSet, {
            added: ['Fixture/Repo#3'],
            changed: [],
            closed: [],
            removed: ['Fixture/Repo#1', 'Fixture/Repo#2'],
            reopened: []
        })
        assert.equal(context.nodes['Fixture/Repo#1'].status, 'removed')
        assert.equal(context.nodes['Fixture/Repo#2'].status, 'removed')
        assert.equal(context.nodes['Fixture/Repo#3'].status, 'active')

        const reopenedIssue = issue('Fixture/Repo', 1, {
            updatedAt: '2026-08-04T00:13:00.000Z'
        })
        const reopened = executeLifecycleScopeRefresh({
            ledger: removed,
            observeRemoteIssueDelta: (request) => deltaObservation(
                request,
                'changed',
                {
                    observedAt: '2026-08-04T00:13:00.000Z',
                    observationCursor: 'cursor-3',
                    conditionalIdentity: 'etag-3',
                    currentIssueIds: [
                        'Fixture/Repo#1',
                        'Fixture/Repo#3'
                    ],
                    changedIssues: [reopenedIssue],
                    removedIssueIds: []
                }
            ),
            observeRemoteIssues() {
                throw new Error('full observer must not run')
            },
            startup: fixture.startup
        })
        context = lifecycleRunObservationContext(reopened, {
            startup: fixture.startup
        })
        assert.deepEqual(context.selectorReceipt.remoteChangeSet.reopened,
            [])
        assert.deepEqual(context.selectorReceipt.remoteChangeSet.added,
            ['Fixture/Repo#1'])
        assert.equal(context.nodes['Fixture/Repo#1'].status, 'active')
        assert.equal(context.nodes['Fixture/Repo#1'].nodeEpoch, 2)
    } finally {
        fixture.cleanup()
    }
})

test('irrelevant delta facts remain snapshot-neutral', () => {
    const fixture = makeFixture({
        remoteObservationCursor: 'cursor-1',
        remoteConditionalIdentity: 'etag-1'
    })
    try {
        const before = lifecycleRunObservationContext(fixture.ledger, {
            startup: fixture.startup
        })
        const changed = issue('Fixture/Repo', 1, {
            comments: [{
                id: 'noise',
                body: 'irrelevant change',
                updatedAt: '2026-08-04T00:14:00.000Z',
                relevant: false
            }],
            localCacheKey: 'caller-only'
        })
        const diagnostics = {}
        const result = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssueDelta: (request) => deltaObservation(
                request,
                'changed',
                {
                    observedAt: '2026-08-04T00:14:00.000Z',
                    observationCursor: 'cursor-2',
                    conditionalIdentity: 'etag-2',
                    currentIssueIds: ['Fixture/Repo#1'],
                    changedIssues: [changed],
                    removedIssueIds: []
                }
            ),
            observeRemoteIssues() {
                throw new Error('full observer must not run')
            },
            diagnostics,
            startup: fixture.startup
        })
        const after = lifecycleRunObservationContext(result, {
            startup: fixture.startup
        })
        assert.equal(after.controlLedgerHeadDigest,
            before.controlLedgerHeadDigest)
        assert.equal(after.selectorReceipt.remoteSnapshotDigest,
            before.selectorReceipt.remoteSnapshotDigest)
        assert.deepEqual(diagnostics, {
            mode: 'delta',
            fallbackReason: null,
            remoteFactsTransferred: 1,
            selectorRebuildCount: 1
        })
    } finally {
        fixture.cleanup()
    }
})

test('unsupported delta adapters fall back to complete observation', () => {
    const fixture = makeFixture({
        remoteObservationCursor: 'cursor-1',
        remoteConditionalIdentity: 'etag-1'
    })
    try {
        const current = [issue('Fixture/Repo', 1, {
            body: 'Full fallback change',
            updatedAt: '2026-08-04T00:15:00.000Z'
        })]
        const diagnostics = {}
        let fullCalls = 0
        const result = executeLifecycleScopeRefresh({
            ledger: fixture.ledger,
            observeRemoteIssueDelta: (request) =>
                deltaObservation(request, 'unsupported'),
            observeRemoteIssues: (request) => {
                fullCalls += 1
                return observation(
                    request,
                    current,
                    '2026-08-04T00:15:00.000Z',
                    null,
                    {
                        observationCursor: 'cursor-2',
                        conditionalIdentity: 'etag-2'
                    }
                )
            },
            diagnostics,
            startup: fixture.startup
        })
        const receipt = lifecycleRunObservationContext(result, {
            startup: fixture.startup
        }).selectorReceipt
        assert.equal(fullCalls, 1)
        assert.equal(receipt.remoteObservationCursor, 'cursor-2')
        assert.equal(receipt.remoteConditionalIdentity, 'etag-2')
        assert.deepEqual(diagnostics, {
            mode: 'full-fallback',
            fallbackReason: 'adapter-unsupported',
            remoteFactsTransferred: 1,
            selectorRebuildCount: 1
        })
    } finally {
        fixture.cleanup()
    }
})

test('stale contradictory and partial deltas fail before selector authority', async (t) => {
    const cases = [
        ['stale cursor', (request) => deltaObservation(
            request,
            'unchanged',
            {
                previousObservationCursor: 'stale-cursor',
                observationCursor: 'stale-cursor',
                conditionalIdentity: 'etag-1'
            }
        )],
        ['wrong selector', (request) => deltaObservation(
            request,
            'unchanged',
            {
                selectorDigest: digest('wrong-selector'),
                observationCursor: 'cursor-1',
                conditionalIdentity: 'etag-1'
            }
        )],
        ['missing new member', (request) => deltaObservation(
            request,
            'changed',
            {
                observationCursor: 'cursor-2',
                conditionalIdentity: 'etag-2',
                currentIssueIds: ['Fixture/Repo#1', 'Fixture/Repo#2'],
                changedIssues: [],
                removedIssueIds: []
            }
        )],
        ['contradictory removal', (request) => deltaObservation(
            request,
            'changed',
            {
                observationCursor: 'cursor-2',
                conditionalIdentity: 'etag-2',
                currentIssueIds: ['Fixture/Repo#1'],
                changedIssues: [],
                removedIssueIds: ['Fixture/Repo#1']
            }
        )]
    ]
    for (const [name, response] of cases) {
        await t.test(name, () => {
            const fixture = makeFixture({
                remoteObservationCursor: 'cursor-1',
                remoteConditionalIdentity: 'etag-1'
            })
            try {
                let fullCalls = 0
                assert.throws(
                    () => executeLifecycleScopeRefresh({
                        ledger: fixture.ledger,
                        observeRemoteIssueDelta: response,
                        observeRemoteIssues() {
                            fullCalls += 1
                        },
                        startup: fixture.startup
                    }),
                    ({ code }) => typeof code === 'string' &&
                        code.startsWith('lifecycle-remote-scope-delta')
                )
                assert.equal(fullCalls, 0)
            } finally {
                fixture.cleanup()
            }
        })
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
