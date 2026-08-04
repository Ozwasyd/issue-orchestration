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
    readLifecycleRunLedger
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    executeLifecycleScopeRefresh,
    observeLifecycleRepositoryBaseBeforeAction
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

function makeFixture({ type = 'repository-open-issues', issues } = {}) {
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
        resolvedAt: CREATED_AT
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
