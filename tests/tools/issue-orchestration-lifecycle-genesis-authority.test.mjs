import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digest } from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector,
    validateLifecycleRunAuthority
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    attestRuntimeStartup,
    compileRuntimeStartupObservation
} from '../../skills/issue-orchestration/scripts/runtime-startup-attestation.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    lifecycleCanonicalLocations,
    projectLifecycleRun,
    readLifecycleRunLedger,
    recordLifecycleActionResults,
    recordLifecycleAuthorityTakeover
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    runtimeStartupRecords,
    takeoverContext,
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
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout)
    }
    return result.stdout.trim()
}

function initRepository(root, name = 'Repo') {
    const bare = path.join(root, `${name}.git`)
    const work = path.join(root, `${name}-work`)
    const repository = `Fixture/${name}`
    const remoteUrl = `https://github.com/${repository}.git`
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'authority-test'], work)
    git(['config', 'user.email', 'authority@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`)
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize'], work)
    git(['push', '-u', 'origin', 'main'], work)
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return { bare, work, repository, remoteUrl }
}

function rawIssue(repository) {
    return {
        repository,
        number: 1,
        state: 'OPEN',
        stateReason: null,
        updatedAt: CREATED_AT,
        title: 'Bind lifecycle authority',
        body: 'Exercise startup attestation and runtime trust.',
        comments: [],
        labels: ['orchestration'],
        milestone: null,
        dependsOn: []
    }
}

function selectorDefinition(repository) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'authority-test-selector-v1',
        type: 'explicit-issues',
        repositories: [repository],
        parameters: {
            issueIds: [`${repository}#1`],
            states: ['OPEN']
        },
        remoteQueryIdentity: 'authority-test:explicit-issues'
    }
}

function makeFixture({
    runId = 'run-authority-test',
    startup = verifiedRuntimeStartup(),
    createRun = true
} = {}) {
    const root = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-authority-test-'
    ))
    const stateRoot = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-authority-state-'
    ))
    const repository = initRepository(root)
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
    const issue = rawIssue(repository.repository)
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selectorDefinition(repository.repository),
        remoteIssues: [issue],
        previousReceipt: null,
        resolvedAt: CREATED_AT
    })
    const repositoryBinding = repositoryAuthorityFor(
        authority,
        repository.repository
    )
    const policyDigest = digest('authority-test-policy')
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest([`${repository.repository}#1`]),
        semanticGraphInputDigest: digest(issue),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: repositoryBinding.observedDefaultBranchHead,
            bindingDigest: repositoryBinding.bindingDigest
        }],
        nodes: [{
            id: `${repository.repository}#1`,
            memberId: `${repository.repository}#1`,
            repository: repository.repository,
            issueNumber: 1,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: 'bounded',
            uiClass: 'non-ui',
            acceptanceGroup: null,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: repositoryBinding.bindingDigest,
            semanticFactsDigest: digest(issue),
            receipts: {}
        }]
    })
    const installedPolicy = {
        schema: 'issue-orchestration.installed-route-policy.v1',
        status: 'verified',
        policyDigest
    }
    const ledger = createRun
        ? createLifecycleRunLedger({
            stateRoot,
            runId,
            createdAt: CREATED_AT,
            selectorReceipt,
            semanticGraph,
            installedPolicy,
            lifecycleAuthority: authority,
            startup,
            slotCapacity: 2
        })
        : null
    return {
        root,
        stateRoot,
        repository,
        authority,
        selectorReceipt,
        semanticGraph,
        installedPolicy,
        startup,
        ledger,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}

function readJsonLines(file) {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line))
}

test('run creation fails before writing without startup, trust, and state-root authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-no-run-'))
    try {
        assert.throws(
            () => createLifecycleRunLedger({ stateRoot: root }),
            ({ code }) => code === 'lifecycle-run-authority-invalid'
        )
        assert.deepEqual(fs.readdirSync(root), [])
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('genesis binds control, node, selector, aggregate, and every action to one authority', () => {
    const fixture = makeFixture()
    try {
        const locations = lifecycleCanonicalLocations(fixture.ledger, {
            startup: fixture.startup
        })
        const control = readJsonLines(locations.run.controlLedgerPath)
        const node = readJsonLines(
            Object.values(locations.nodes)[0].ledgerPath
        )
        assert.equal(
            control[0].lifecycleAuthorityBinding.bindingDigest,
            fixture.authority.binding.bindingDigest
        )
        assert.equal(
            node[0].lifecycleAuthorityBinding.bindingDigest,
            fixture.authority.binding.bindingDigest
        )
        const projected = projectLifecycleRun(fixture.ledger, {
            startup: fixture.startup
        })
        assert.equal(
            projected.aggregateProjection.lifecycleAuthorityBinding
                .bindingDigest,
            fixture.authority.binding.bindingDigest
        )
        const actionSet = compileLifecycleRunActionSet(fixture.ledger, {
            startup: fixture.startup
        })
        assert.equal(
            actionSet.lifecycleAuthorityBindingDigest,
            fixture.authority.binding.bindingDigest
        )
        for (const action of actionSet.actions) {
            for (const field of [
                'lifecycleAuthorityBindingDigest',
                'startupAttestationDigest',
                'runtimeInvocationId',
                'runtimeSessionId',
                'rootAuthorityEpoch',
                'runtimeTrustBindingDigest',
                'repositoryBindingSetDigest',
                'packageDigest',
                'manifestDigest',
                'policySetDigest'
            ]) {
                assert.equal(action.bindings[field], actionSet[field])
            }
        }
    } finally {
        fixture.cleanup()
    }
})

test('serialize and reload accepts unchanged authority and fences a different invocation', () => {
    const fixture = makeFixture()
    try {
        const reloaded = readLifecycleRunLedger({
            stateRoot: fixture.stateRoot,
            runId: fixture.authority.runId,
            startup: fixture.startup
        })
        assert.equal(
            compileLifecycleRunActionSet(reloaded, {
                startup: fixture.startup
            }).lifecycleAuthorityBindingDigest,
            fixture.authority.binding.bindingDigest
        )
        const otherStartup = verifiedRuntimeStartup({
            invocationId: 'different-root-invocation',
            sessionId: 'different-root-session'
        })
        assert.throws(
            () => readLifecycleRunLedger({
                stateRoot: fixture.stateRoot,
                runId: fixture.authority.runId,
                startup: otherStartup
            }),
            ({ code, details }) =>
                code === 'lifecycle-run-current-authority-invalid' &&
                details.cause === 'lifecycle-authority-drift'
        )
    } finally {
        fixture.cleanup()
    }
})

test('repository origin and default-branch drift fail before the next action', () => {
    const fixture = makeFixture()
    try {
        git([
            'remote', 'set-url', 'origin',
            'https://github.com/Fixture/Other.git'
        ], fixture.repository.work)
        assert.throws(
            () => compileLifecycleRunActionSet(fixture.ledger, {
                startup: fixture.startup
            }),
            ({ code }) => code === 'lifecycle-run-current-authority-invalid'
        )
        git([
            'remote', 'set-url', 'origin',
            fixture.repository.remoteUrl
        ], fixture.repository.work)
        git(['branch', 'other'], fixture.repository.work)
        git(['push', 'origin', 'other'], fixture.repository.work)
        git(['symbolic-ref', 'HEAD', 'refs/heads/other'], fixture.repository.bare)
        assert.throws(
            () => validateLifecycleRunAuthority(fixture.authority, {
                startup: fixture.startup,
                expectedRunId: fixture.authority.runId,
                expectedStateRoot: fixture.stateRoot
            }),
            ({ code }) => code === 'lifecycle-authority-default-branch-drift'
        )
    } finally {
        fixture.cleanup()
    }
})

test('state root inside a repository is rejected without creating lifecycle state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-bad-root-'))
    try {
        const repository = initRepository(root)
        const badStateRoot = path.join(repository.work, '.state')
        const startup = verifiedRuntimeStartup()
        assert.throws(
            () => compileLifecycleRunGenesisAuthority({
                runId: 'run-invalid-state-root',
                startup,
                stateRoot: badStateRoot,
                repositoryTargets: [{
                    repository: repository.repository,
                    repositoryPath: repository.work,
                    defaultBranch: 'main'
                }],
                workspaces: [root],
                slotCapacity: 1,
                createdAt: CREATED_AT
            }),
            ({ code }) => code === 'path-overlap'
        )
        assert.equal(fs.existsSync(path.join(badStateRoot, 'runs')), false)
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('terra-medium cannot create normal genesis and a supervisor takeover fences old actions', () => {
    const runId = 'run-test-takeover'
    const oldStartup = verifiedRuntimeStartup({
        invocationId: 'invocation-test-old-root',
        sessionId: 'session-test-old-root'
    })
    const fixture = makeFixture({ runId, startup: oldStartup })
    try {
        const oldActionSet = compileLifecycleRunActionSet(
            fixture.ledger,
            { startup: oldStartup }
        )
        const newInvocationId = 'invocation-test-new-root'
        const context = takeoverContext({
            runId,
            oldInvocationId:
                oldStartup.attestation.runtimeInvocationId,
            oldRootSessionId:
                oldStartup.attestation.runtimeSessionId,
            oldRootAuthorityEpoch:
                oldStartup.attestation.rootAuthorityEpoch,
            oldRootStartupAttestationDigest:
                oldStartup.attestation.attestationDigest,
            newInvocationId,
            expiresAt: '2026-08-04T00:10:00.000Z'
        })
        const records = runtimeStartupRecords({
            profile: 'terra-medium',
            invocationId: newInvocationId,
            sessionId: 'session-test-new-root',
            observedAt: '2026-08-04T00:00:00.000Z'
        })
        const observation = compileRuntimeStartupObservation(records)
        const attestation = attestRuntimeStartup({
            observation,
            takeoverContext: context,
            attestedAt: '2026-08-04T00:01:00.000Z'
        })
        assert.equal(
            attestation.status,
            'verified',
            JSON.stringify(attestation.reasonCodes)
        )
        const takeoverStartup = {
            observation,
            attestation,
            takeoverContext: context
        }
        assert.throws(
            () => compileLifecycleRunGenesisAuthority({
                runId,
                startup: takeoverStartup,
                stateRoot: fixture.stateRoot,
                repositoryTargets: fixture.authority.repositoryTargets,
                workspaces: fixture.authority.workspaces,
                slotCapacity: 2,
                createdAt: CREATED_AT
            }),
            ({ code }) => code === 'lifecycle-authority-kind-invalid'
        )
        const takenOver = recordLifecycleAuthorityTakeover({
            ledger: fixture.ledger,
            startup: takeoverStartup,
            createdAt: '2026-08-04T00:01:01.000Z'
        })
        const nextActionSet = compileLifecycleRunActionSet(takenOver, {
            startup: takeoverStartup
        })
        assert.notEqual(
            nextActionSet.lifecycleAuthorityBindingDigest,
            oldActionSet.lifecycleAuthorityBindingDigest
        )
        assert.equal(
            nextActionSet.rootAuthorityEpoch,
            takeoverStartup.attestation.rootAuthorityEpoch
        )
        assert.throws(
            () => compileLifecycleRunActionSet(takenOver, {
                startup: oldStartup
            }),
            ({ code }) => code === 'lifecycle-run-current-authority-invalid'
        )
        assert.throws(
            () => recordLifecycleActionResults({
                ledger: takenOver,
                actionSet: oldActionSet,
                stageResults: [],
                startup: takeoverStartup,
                createdAt: '2026-08-04T00:01:02.000Z'
            }),
            ({ code }) => code === 'lifecycle-action-set-stale'
        )
        const locations = lifecycleCanonicalLocations(takenOver, {
            startup: takeoverStartup
        })
        const control = readJsonLines(locations.run.controlLedgerPath)
        const reboundEvents = control.filter(
            ({ eventType }) =>
                eventType === 'runtime-authority.rebound'
        )
        assert.equal(reboundEvents.length, 1)
        assert.equal(
            reboundEvents[0].payload
                .priorLifecycleAuthorityBindingDigest,
            oldActionSet.lifecycleAuthorityBindingDigest
        )
    } finally {
        fixture.cleanup()
    }
})
