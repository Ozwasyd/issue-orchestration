import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    executeLifecycleTerminalizationAction,
    LifecycleTerminalizationExecutorError,
    lifecycleTerminalizationActionTypes
} from '../../skills/issue-orchestration/scripts/lifecycle-terminalization-executor.mjs'
import {
    executeLifecycleQuiescenceFinalization,
    LifecycleQuiescenceFinalizerError
} from '../../skills/issue-orchestration/scripts/lifecycle-quiescence-finalizer.mjs'
import {
    QUIESCENCE_INVENTORY_NAMES
} from '../../skills/issue-orchestration/scripts/quiescence-observation-collector.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    projectLifecycleRun
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    compileLifecycleRemoteSnapshotReceipt
} from '../../skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs'
import {
    appendNodeEventAtomicSync,
    readCanonicalNodeLedger
} from '../../skills/issue-orchestration/scripts/multi-node-state.mjs'
import {
    compileTerminalRecoveryFingerprint,
    terminalCategorySpec,
    TERMINAL_CATEGORIES,
    TERMINAL_POLICY,
    TERMINAL_POLICY_DIGEST,
    TERMINAL_POLICY_VERSION,
    validateTerminalEvidenceSet,
    validateTerminalRecoveryExhaustion
} from '../../skills/issue-orchestration/scripts/terminal-policy.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const CREATED_AT = '2026-08-05T02:00:00.000Z'
const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const GENESIS = '0'.repeat(64)
let sequence = 1000

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

function initRepository(root) {
    const bare = path.join(root, 'RepoA.git')
    const work = path.join(root, 'RepoA-work')
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'terminal-executor-test'], work)
    git(['config', 'user.email', 'terminal@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), '# RepoA\n')
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize RepoA'], work)
    git(['push', '-u', 'origin', 'main'], work)
    const repository = 'Fixture/RepoA'
    const remoteUrl = `https://github.com/${repository}.git`
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return {
        repository,
        bare,
        work,
        baseSha: git(['rev-parse', 'HEAD'], work)
    }
}

function selector(issue) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'terminal-selector-v1',
        type: 'explicit-issues',
        repositories: [issue.repository],
        parameters: {
            issueIds: [`${issue.repository}#${issue.number}`],
            states: ['OPEN']
        },
        remoteQueryIdentity: 'terminal-executor-test:explicit-issue'
    }
}

function directEvidence(category) {
    return [...terminalCategorySpec(category).requiredEvidenceKinds]
        .map((kind) => ({
            kind,
            evidenceDigest: digest(`${category}:${kind}`)
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind))
}

function recoveryExhaustion() {
    return {
        advisor: 'inapplicable',
        continuation: 'inapplicable',
        deterministicHandlers: 'exhausted',
        humanDecision: 'inapplicable',
        revalidation: 'exhausted',
        retry: 'exhausted'
    }
}

function sealObservation(value, digestField = 'observationDigest') {
    const result = structuredClone(value)
    result[digestField] = digest(result)
    return Object.freeze(result)
}

async function fixture({
    category = 'externally_blocked',
    candidateFingerprint = null
} = {}) {
    sequence += 1
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-state-'))
    const repository = initRepository(root)
    const issue = {
        repository: repository.repository,
        number: 1,
        state: 'OPEN',
        stateReason: null,
        updatedAt: '2026-08-05T02:00:01.000Z',
        title: 'Terminal fixture issue',
        body: 'Exercise typed terminal evidence.',
        comments: [],
        labels: ['code'],
        milestone: null,
        dependsOn: [],
        ui: false,
        group: null
    }
    const issueId = `${issue.repository}#${issue.number}`
    const startup = verifiedRuntimeStartup({
        invocationId: `terminal-root-${sequence}`,
        sessionId: `terminal-session-${sequence}`,
        observedAt: CREATED_AT,
        attestedAt: '2026-08-05T02:00:01.000Z'
    })
    const runId = `terminal-run-${sequence}`
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
    const repositoryAuthority = repositoryAuthorityFor(
        authority,
        repository.repository
    )
    repository.bindingDigest = repositoryAuthority.bindingDigest
    repository.baseSha = repositoryAuthority.observedDefaultBranchHead
    const selectorDefinition = selector(issue)
    const remoteIssues = [{ ...issue, baseSha: repository.baseSha }]
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selectorDefinition,
        remoteIssues,
        previousReceipt: null,
        resolvedAt: '2026-08-05T02:01:00.000Z'
    })
    const remoteSnapshotReceipt =
        compileLifecycleRemoteSnapshotReceipt(selectorReceipt)
    const policyDigest = digest('terminal-routing-policy')
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest([issueId]),
        semanticGraphInputDigest: digest(remoteIssues),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: repository.baseSha,
            bindingDigest: repository.bindingDigest
        }],
        nodes: [{
            id: issueId,
            memberId: issueId,
            repository: repository.repository,
            issueNumber: issue.number,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: 'bounded',
            uiClass: 'non-ui',
            acceptanceGroup: null,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: repository.bindingDigest,
            semanticFactsDigest: digest(issue),
            receipts: {}
        }]
    })
    let ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition,
        semanticGraph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        lifecycleAuthority: authority,
        startup,
        slotCapacity: 2
    })
    const retainedPath = null
    const retainedResources = []
    const inventoryDigest = digest(retainedResources)
    const domainDigests = {
        dependency: digest('terminal-domain-dependency'),
        evidence: digest(`${category}:terminal-domain-evidence`),
        humanDecision: digest('terminal-domain-human-decision'),
        remote: digest('terminal-domain-remote'),
        repository: digest('terminal-domain-repository'),
        runtime: digest('terminal-domain-runtime')
    }
    const firstFailure = {
        classification: category,
        evidenceRef: `evidence://${category}`,
        signature: `${category}-signature`
    }
    const evidence = validateTerminalEvidenceSet({
        policyVersion: TERMINAL_POLICY_VERSION,
        category,
        directEvidence: directEvidence(category)
    })
    const recovery = validateTerminalRecoveryExhaustion(
        recoveryExhaustion()
    )
    const observableFingerprint = compileTerminalRecoveryFingerprint({
        runId,
        nodeId: issueId,
        repository: repository.repository,
        issueNumber: issue.number,
        baseSha: repository.baseSha,
        nodeEpoch: 1,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: remoteSnapshotReceipt.receiptDigest,
        policyDigest,
        policySetDigest: authority.binding.policySetDigest,
        runtimeTrustBindingDigest:
            authority.binding.runtimeTrustBindingDigest,
        repositoryBindingDigest: repository.bindingDigest,
        category,
        firstFailureDigest: digest(firstFailure),
        directEvidenceDigest: evidence.directEvidenceDigest,
        recoveryExhaustionDigest: recovery.recoveryExhaustionDigest,
        domainDigests,
        retentionInventoryDigest: inventoryDigest
    })
    const payload = {
        policyVersion: TERMINAL_POLICY_VERSION,
        category,
        firstFailure,
        firstFailureDigest: digest(firstFailure),
        directEvidence: evidence.directEvidence,
        directEvidenceDigest: evidence.directEvidenceDigest,
        recoveryExhaustion: recovery.recoveryExhaustion,
        recoveryExhaustionDigest: recovery.recoveryExhaustionDigest,
        recoveryFingerprint:
            candidateFingerprint ?? observableFingerprint
    }
    const nodeLedger = readCanonicalNodeLedger({
        stateRoot,
        runId,
        nodeId: issueId,
        nodeEpoch: 1
    })
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `terminal-candidate-${sequence}`,
        sequence: nodeLedger.events.length + 1,
        runId,
        nodeId: issueId,
        eventType: 'node.terminal-entered',
        fromState: 'none',
        toState: 'terminal',
        attemptId: null,
        actorRole: 'root-scheduler',
        lifecycleAuthorityBinding: structuredClone(authority.binding),
        sourceDagDigest: semanticGraph.semanticGraphDigest,
        issueSnapshotFingerprint:
            nodeLedger.header.issueSnapshotFingerprint,
        repositoryFingerprint:
            nodeLedger.header.repositoryFingerprint,
        baseSha: nodeLedger.header.baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs: evidence.directEvidence.map(
            ({ evidenceDigest }) => evidenceDigest
        ),
        createdAt: '2026-08-05T02:02:00.000Z',
        previousEventDigest:
            nodeLedger.events.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = digest(event)
    appendNodeEventAtomicSync({
        stateRoot,
        runId,
        nodeId: issueId,
        event,
        writerRole: 'root-scheduler'
    })
    ledger = Object.freeze({ ...ledger })
    const calls = []
    const observer = {
        calls,
        async observeTerminalEvidence({ action }) {
            calls.push('terminal')
            return sealObservation({
                schema:
                    'issue-orchestration.terminal-evidence-observation.v1',
                producerAuthority:
                    'machine-terminal-evidence-observer',
                status: 'verified',
                rootAuthored: false,
                callerAuthored: false,
                actionDigest: action.actionDigest,
                nodeId: action.nodeId,
                policyVersion: TERMINAL_POLICY_VERSION,
                category,
                firstFailureDigest: digest(firstFailure),
                directEvidence: evidence.directEvidence,
                directEvidenceDigest: evidence.directEvidenceDigest,
                recoveryExhaustion: recovery.recoveryExhaustion,
                recoveryExhaustionDigest:
                    recovery.recoveryExhaustionDigest
            })
        },
        async observeRecoveryFacts({ action }) {
            calls.push('recovery')
            return sealObservation({
                schema:
                    'issue-orchestration.terminal-recovery-observation.v1',
                producerAuthority:
                    'machine-terminal-recovery-observer',
                status: 'verified',
                rootAuthored: false,
                callerAuthored: false,
                actionDigest: action.actionDigest,
                nodeId: action.nodeId,
                domainDigests
            })
        },
        async observeRetentionInventory({ action }) {
            calls.push('retention')
            return sealObservation({
                schema:
                    'issue-orchestration.terminal-retention-observation.v1',
                producerAuthority:
                    'machine-terminal-retention-observer',
                status: 'verified',
                rootAuthored: false,
                callerAuthored: false,
                actionDigest: action.actionDigest,
                nodeId: action.nodeId,
                retainedResources,
                inventoryDigest
            })
        }
    }
    return {
        authority,
        category,
        calls,
        domainDigests,
        firstFailure,
        issueId,
        ledger,
        observableFingerprint,
        observer,
        repository,
        retainedPath,
        retainedResources,
        root,
        runId,
        startup,
        stateRoot,
        context(overrides = {}) {
            const actionSet = compileLifecycleRunActionSet(ledger, {
                startup
            })
            return {
                ledger,
                actionSet,
                action: actionSet.actions[0],
                observer,
                createdAt: '2026-08-05T02:03:00.000Z',
                startup,
                stateRootPath: stateRoot,
                runtimeTrustBinding: authority.runtimeTrustBinding,
                repositoryTargets: authority.repositoryTargets,
                ...overrides
            }
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}


function emptyInventoryRecords() {
    return Object.fromEntries(
        QUIESCENCE_INVENTORY_NAMES.map((name) => [name, []])
    )
}

function finalizationObserver(f, overrides = {}) {
    const calls = []
    const remoteSnapshotDigest = digest({
        runId: f.runId,
        target: f.issueId,
        remote: 'finalization'
    })
    return {
        calls,
        async observeFinalizationFacts({ action, targetIssueSet }) {
            calls.push('observe')
            const value = {
                schema:
                    'issue-orchestration.lifecycle-finalization-observation.v1',
                producerAuthority:
                    'independent-machine-inventory-verifier',
                rootAuthored: false,
                callerAuthored: false,
                actionDigest: action.actionDigest,
                runId: action.bindings.runId,
                actorId: 'quiescence-verifier-1',
                machineId: 'fixture-machine-1',
                machineIdentityDigest: digest('fixture-machine-1'),
                remoteSnapshotDigest,
                resolvedTargetIssueSet: [...targetIssueSet].sort(),
                selectorObservationDigest: digest({
                    targetIssueSet: [...targetIssueSet].sort(),
                    remoteSnapshotDigest
                }),
                remoteIssues: targetIssueSet.map((target) => ({
                    target,
                    state: 'open',
                    stateReason: null,
                    remoteSnapshotDigest
                })),
                inventoryRecords: emptyInventoryRecords(),
                ...structuredClone(overrides)
            }
            value.observationDigest = digest(value)
            return Object.freeze(value)
        }
    }
}

async function terminalFixture() {
    const f = await fixture({ category: 'externally_blocked' })
    const completed = await executeLifecycleTerminalizationAction(f.context())
    f.ledger = completed.ledger
    const actionSet = compileLifecycleRunActionSet(f.ledger, {
        startup: f.startup
    })
    assert.equal(actionSet.actions.length, 1)
    assert.equal(actionSet.actions[0].type, 'idle')
    assert.equal(actionSet.quiescent, true)
    return f
}

function finalizationContext(f, observer, overrides = {}) {
    const actionSet = compileLifecycleRunActionSet(f.ledger, {
        startup: f.startup
    })
    return {
        ledger: f.ledger,
        actionSet,
        action: actionSet.actions[0],
        observer,
        createdAt: '2026-08-05T02:05:00.000Z',
        startup: f.startup,
        stateRootPath: f.stateRoot,
        runtimeTrustBinding: f.authority.runtimeTrustBinding,
        repositoryTargets: f.authority.repositoryTargets,
        ...overrides
    }
}

test('fresh machine observation terminalizes one typed terminal node exactly once', async () => {
    const f = await terminalFixture()
    try {
        const observer = finalizationObserver(f)
        const completed = await executeLifecycleQuiescenceFinalization(
            finalizationContext(f, observer)
        )
        f.ledger = completed.ledger
        assert.equal(completed.status, 'terminalized', JSON.stringify(completed.violations ?? completed.receipt?.violations, null, 2))
        assert.deepEqual(completed.receipt.violations, [])
        assert.deepEqual(observer.calls, ['observe'])
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        assert.equal(
            projection.aggregateProjection.terminal.receiptDigest,
            completed.receipt.receiptDigest
        )
        assert.equal(
            projection.aggregateProjection.terminal.observationDigest,
            completed.receipt.observationDigest
        )
        await assert.rejects(
            executeLifecycleQuiescenceFinalization(
                finalizationContext(f, observer)
            ),
            (error) =>
                error instanceof LifecycleQuiescenceFinalizerError &&
                error.code === 'finalization-already-terminal'
        )
    } finally {
        f.cleanup()
    }
})

test('caller summaries, counts, booleans, and receipts are never final authority', async () => {
    const f = await terminalFixture()
    try {
        for (const [field, value] of [
            ['quiescent', true],
            ['activeLeaseCount', 0],
            ['counts', {}],
            ['receipt', { status: 'quiescent' }]
        ]) {
            const observer = finalizationObserver(f)
            await assert.rejects(
                executeLifecycleQuiescenceFinalization(
                    finalizationContext(f, observer, { [field]: value })
                ),
                (error) =>
                    error instanceof LifecycleQuiescenceFinalizerError &&
                    error.code ===
                        'finalization-caller-authority-forbidden'
            )
            assert.deepEqual(observer.calls, [])
        }
    } finally {
        f.cleanup()
    }
})

test('non-idle and stale actions fail before machine observation', async () => {
    const f = await terminalFixture()
    try {
        const observer = finalizationObserver(f)
        const context = finalizationContext(f, observer)
        context.action = { ...context.action, type: 'terminalize-node' }
        await assert.rejects(
            executeLifecycleQuiescenceFinalization(context),
            (error) =>
                error instanceof LifecycleQuiescenceFinalizerError &&
                error.code === 'finalization-action-invalid'
        )
        assert.deepEqual(observer.calls, [])
    } finally {
        f.cleanup()
    }
})

test('one raw active resource prevents terminalization with stable violations', async () => {
    const f = await terminalFixture()
    try {
        const inventoryRecords = emptyInventoryRecords()
        inventoryRecords.resources.push({
            resourceId: 'residual-resource-1',
            ownerNodeId: f.issueId,
            terminalState: 'released',
            terminalReceiptDigest: digest('residual-resource-terminal'),
            active: true
        })
        const observer = finalizationObserver(f, { inventoryRecords })
        const result = await executeLifecycleQuiescenceFinalization(
            finalizationContext(f, observer)
        )
        assert.equal(result.status, 'not-quiescent')
        assert.equal(
            result.violations.some(({ code }) =>
                code === 'resources.summary-active' ||
                code === 'resources.record-active'),
            true,
            JSON.stringify(result.violations, null, 2)
        )
        assert.equal(
            projectLifecycleRun(f.ledger, { startup: f.startup })
                .aggregateProjection.terminal,
            null
        )
    } finally {
        f.cleanup()
    }
})

test('observer cannot replace canonical issue or stage evidence', async () => {
    const f = await terminalFixture()
    try {
        const inventoryRecords = emptyInventoryRecords()
        inventoryRecords.issues.push({ target: f.issueId, state: 'closed' })
        const observer = finalizationObserver(f, { inventoryRecords })
        await assert.rejects(
            executeLifecycleQuiescenceFinalization(
                finalizationContext(f, observer)
            ),
            (error) =>
                error instanceof LifecycleQuiescenceFinalizerError &&
                error.code === 'finalization-canonical-domain-overridden'
        )
    } finally {
        f.cleanup()
    }
})

test('fresh selector resolution must match the canonical target set', async () => {
    const f = await terminalFixture()
    try {
        const observer = finalizationObserver(f, {
            resolvedTargetIssueSet: [`${f.issueId}-unexpected`]
        })
        await assert.rejects(
            executeLifecycleQuiescenceFinalization(
                finalizationContext(f, observer)
            ),
            (error) =>
                error instanceof LifecycleQuiescenceFinalizerError &&
                error.code === 'finalization-selector-scope-drift'
        )
    } finally {
        f.cleanup()
    }
})

test('a repository head outside the verified delivery or genesis baseline blocks finalization', async () => {
    const f = await terminalFixture()
    try {
        fs.writeFileSync(
            path.join(f.repository.work, 'unexpected-head.txt'),
            'repository drift\n'
        )
        git(['add', 'unexpected-head.txt'], f.repository.work)
        git(['commit', '-m', 'unexpected repository drift'], f.repository.work)
        const result = await executeLifecycleQuiescenceFinalization(
            finalizationContext(f, finalizationObserver(f))
        )
        assert.equal(result.status, 'not-quiescent')
        assert.equal(
            result.violations.some(({ code }) =>
                code === 'git.remote-identity-mismatch' ||
                code === 'git.summary-remote-identity-mismatch'),
            true,
            JSON.stringify(result.violations, null, 2)
        )
    } finally {
        f.cleanup()
    }
})
