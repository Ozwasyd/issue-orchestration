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
    createLifecycleRunLedger
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    observeLifecycleRepositoryBaseEpoch
} from '../../skills/issue-orchestration/scripts/lifecycle-live-refresh.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const CREATED_AT = '2026-08-06T00:00:00.000Z'

function git(args, cwd) {
    const result = spawnSync('/usr/bin/git', args, {
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

function repositoryFixture(root, suffix) {
    const bare = path.join(root, `Repo${suffix}.git`)
    const work = path.join(root, `Repo${suffix}-work`)
    const repository = `Fixture/Repo${suffix}`
    const remoteUrl = `https://github.com/${repository}.git`
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'base-wave-test'], work)
    git(['config', 'user.email', 'base-wave@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), `# Repo ${suffix}\n`)
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize'], work)
    git(['push', '-u', 'origin', 'main'], work)
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return { bare, work, repository, remoteUrl }
}

function issue(repository, number) {
    return {
        repository,
        number,
        state: 'OPEN',
        stateReason: null,
        updatedAt: CREATED_AT,
        title: `Base wave ${repository}`,
        body: 'Observe this repository exactly once per wave.',
        comments: [],
        labels: ['orchestration'],
        milestone: null,
        dependsOn: []
    }
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'base-wave-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'base-wave-state-'))
    const repositories = [
        repositoryFixture(root, 'A'),
        repositoryFixture(root, 'B')
    ]
    const startup = verifiedRuntimeStartup({
        invocationId: 'base-wave-root-invocation',
        sessionId: 'base-wave-root-session'
    })
    const runId = 'base-wave-run'
    const authority = compileLifecycleRunGenesisAuthority({
        runId,
        startup,
        stateRoot,
        repositoryTargets: repositories.map((repository) => ({
            repository: repository.repository,
            repositoryPath: repository.work,
            defaultBranch: 'main'
        })),
        workspaces: [root],
        worktrees: [],
        slotCapacity: 2,
        createdAt: CREATED_AT
    })
    const rawIssues = repositories.map((repository, index) => {
        const binding = repositoryAuthorityFor(
            authority,
            repository.repository
        )
        return {
            ...issue(repository.repository, index + 1),
            baseSha: binding.observedDefaultBranchHead
        }
    })
    const selector = {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'base-wave-selector-v1',
        type: 'explicit-issues',
        repositories: repositories.map(({ repository }) => repository),
        parameters: {
            issueIds: rawIssues.map(({ repository, number }) =>
                `${repository}#${number}`),
            states: ['OPEN']
        },
        remoteQueryIdentity: 'base-wave:explicit-issues'
    }
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector,
        remoteIssues: rawIssues,
        previousReceipt: null,
        resolvedAt: CREATED_AT
    })
    const policyDigest = digest('base-wave-policy')
    const graph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest(selectorReceipt.resolvedIssueSet),
        semanticGraphInputDigest: digest(rawIssues),
        policyDigest,
        repositories: repositories.map((repository) => {
            const binding = repositoryAuthorityFor(
                authority,
                repository.repository
            )
            return {
                repository: repository.repository,
                baseSha: binding.observedDefaultBranchHead,
                bindingDigest: binding.bindingDigest
            }
        }),
        nodes: rawIssues.map((entry) => {
            const binding = repositoryAuthorityFor(
                authority,
                entry.repository
            )
            const id = `${entry.repository}#${entry.number}`
            return {
                id,
                memberId: id,
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
            }
        })
    })
    const ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition: selector,
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
        repositories,
        startup,
        ledger,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}

test('different repositories are observed once each and may overlap', async () => {
    const value = fixture()
    const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'base-wave-git-'))
    const logPath = path.join(wrapperRoot, 'observations.log')
    const wrapper = path.join(wrapperRoot, 'git')
    fs.writeFileSync(wrapper, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ " $* " == *" ls-remote "* ]]; then',
        '  printf "start:%s\\n" "$2" >> "$GIT_WAVE_LOG"',
        '  sleep 0.20',
        '  printf "end:%s\\n" "$2" >> "$GIT_WAVE_LOG"',
        'fi',
        'exec /usr/bin/git "$@"'
    ].join('\n'))
    fs.chmodSync(wrapper, 0o755)
    const priorPath = process.env.PATH
    const priorLog = process.env.GIT_WAVE_LOG
    try {
        process.env.PATH = `${wrapperRoot}:${priorPath}`
        process.env.GIT_WAVE_LOG = logPath
        const actionSet = compileLifecycleRunActionSet(value.ledger, {
            startup: value.startup
        })
        assert.equal(actionSet.actions.length, 2)
        const result = await observeLifecycleRepositoryBaseEpoch({
            ledger: value.ledger,
            actionSet,
            actions: actionSet.actions,
            phase: 'pre-dispatch',
            observedAt: CREATED_AT,
            startup: value.startup
        })
        assert.equal(result.receipt.status, 'current')
        assert.deepEqual(
            result.receipt.repositories.map(({ repository }) => repository),
            ['Fixture/RepoA', 'Fixture/RepoB']
        )
        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
        let active = 0
        let maximumActive = 0
        for (const line of lines) {
            if (line.startsWith('start:')) active += 1
            if (line.startsWith('end:')) active -= 1
            maximumActive = Math.max(maximumActive, active)
        }
        assert.ok(maximumActive >= 2, lines.join('\n'))
        const source = fs.readFileSync(new URL(
            '../../skills/issue-orchestration/scripts/lifecycle-live-refresh.mjs',
            import.meta.url
        ), 'utf8')
        assert.match(source, /Promise\.all\(repositories\.map/u)
    } finally {
        process.env.PATH = priorPath
        if (priorLog === undefined) delete process.env.GIT_WAVE_LOG
        else process.env.GIT_WAVE_LOG = priorLog
        fs.rmSync(wrapperRoot, { recursive: true, force: true })
        value.cleanup()
    }
})
