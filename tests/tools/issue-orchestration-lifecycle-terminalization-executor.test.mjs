import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    validateJsonSchema
} from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    executeLifecycleTerminalizationAction,
    LifecycleTerminalizationExecutorError,
    lifecycleTerminalizationActionTypes
} from '../../skills/issue-orchestration/scripts/lifecycle-terminalization-executor.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    projectLifecycleRun,
    recordLifecycleActionResults
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
let sequence = 0

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
    const retainedPath = path.join(root, `retained-${sequence}.lock`)
    fs.writeFileSync(retainedPath, 'retained terminal resource\n')
    const retainedResources = [{
        resourceType: 'lock',
        resourceId: `terminal-lock-${sequence}`,
        ownerNodeId: issueId,
        status: 'retained-terminal-evidence',
        path: retainedPath,
        resourceDigest: digest({
            resourceType: 'lock',
            resourceId: `terminal-lock-${sequence}`,
            ownerNodeId: issueId,
            status: 'retained-terminal-evidence',
            path: retainedPath
        })
    }]
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

function appendTerminalRecovery(f, {
    previousRecoveryFingerprint,
    recoveryFingerprint
}) {
    const nodeLedger = readCanonicalNodeLedger({
        stateRoot: f.stateRoot,
        runId: f.runId,
        nodeId: f.issueId,
        nodeEpoch: 1
    })
    const projection = projectLifecycleRun(f.ledger, {
        startup: f.startup
    })
    const payload = {
        previousRecoveryFingerprint,
        recoveryFingerprint
    }
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `terminal-recovery-${sequence}-${nodeLedger.events.length + 1}`,
        sequence: nodeLedger.events.length + 1,
        runId: f.runId,
        nodeId: f.issueId,
        eventType: 'node.terminal-recovered',
        fromState: 'terminal',
        toState: 'none',
        attemptId: null,
        actorRole: 'root-scheduler',
        lifecycleAuthorityBinding:
            structuredClone(f.authority.binding),
        sourceDagDigest:
            projection.semanticGraph.semanticGraphDigest,
        issueSnapshotFingerprint:
            nodeLedger.header.issueSnapshotFingerprint,
        repositoryFingerprint:
            nodeLedger.header.repositoryFingerprint,
        baseSha: nodeLedger.header.baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs: [recoveryFingerprint],
        createdAt: '2026-08-05T02:04:00.000Z',
        previousEventDigest:
            nodeLedger.events.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = digest(event)
    return appendNodeEventAtomicSync({
        stateRoot: f.stateRoot,
        runId: f.runId,
        nodeId: f.issueId,
        event,
        writerRole: 'root-scheduler'
    })
}

for (const category of TERMINAL_CATEGORIES) {
    test(`terminal executor admits exact ${category} evidence`, async () => {
        const f = await fixture({ category })
        try {
            const completed = await executeLifecycleTerminalizationAction(
                f.context()
            )
            f.ledger = completed.ledger
            assert.equal(
                completed.observableFingerprint,
                f.observableFingerprint
            )
            assert.deepEqual(f.calls, [
                'terminal', 'recovery', 'retention'
            ])
            assert.equal(fs.existsSync(f.retainedPath), true)
            const projection = projectLifecycleRun(f.ledger, {
                startup: f.startup
            })
            const node = projection.state.nodes[f.issueId]
            assert.equal(node.lifecycleState, 'terminal')
            assert.equal(node.receipts.terminal.evidence.category, category)
            assert.equal(
                node.receipts.recoveryFingerprint.evidence
                    .observableFingerprint,
                f.observableFingerprint
            )
            assert.deepEqual(
                node.receipts.retentionState.evidence.retainedResources,
                f.retainedResources
            )
            assert.equal(
                compileLifecycleRunActionSet(f.ledger, {
                    startup: f.startup
                }).actions[0].type,
                'idle'
            )
        } finally {
            f.cleanup()
        }
    })
}

test('stale observable recovery fingerprint fails before append', async () => {
    const f = await fixture({
        candidateFingerprint: digest('stale-terminal-fingerprint')
    })
    try {
        await assert.rejects(
            executeLifecycleTerminalizationAction(f.context()),
            (error) =>
                error instanceof LifecycleTerminalizationExecutorError &&
                error.code === 'terminal-recovery-fingerprint-stale'
        )
        assert.equal(
            projectLifecycleRun(f.ledger, { startup: f.startup })
                .state.nodes[f.issueId].receipts.terminal,
            undefined
        )
        assert.equal(fs.existsSync(f.retainedPath), true)
    } finally {
        f.cleanup()
    }
})

test('recoverable and human-pending observations cannot terminalize', async () => {
    for (const [pathName, state] of [
        ['retry', 'available'],
        ['humanDecision', 'pending']
    ]) {
        const f = await fixture()
        try {
            const original = f.observer.observeTerminalEvidence
            f.observer.observeTerminalEvidence = async (input) => {
                const observed = await original(input)
                const recovery = {
                    ...observed.recoveryExhaustion,
                    [pathName]: state
                }
                return sealObservation({
                    ...observed,
                    recoveryExhaustion: recovery,
                    recoveryExhaustionDigest: digest(recovery),
                    observationDigest: undefined
                })
            }
            await assert.rejects(
                executeLifecycleTerminalizationAction(f.context()),
                (error) =>
                    error instanceof
                        LifecycleTerminalizationExecutorError &&
                    error.code ===
                        'terminal-evidence-observation-invalid'
            )
        } finally {
            f.cleanup()
        }
    }
})

test('root-authored evidence and unsupported actions fail before effects', async () => {
    const f = await fixture()
    try {
        const context = f.context()
        context.action = { ...context.action, type: 'idle' }
        await assert.rejects(
            executeLifecycleTerminalizationAction(context),
            (error) =>
                error instanceof LifecycleTerminalizationExecutorError &&
                error.code === 'terminal-action-unsupported'
        )
        assert.deepEqual(f.calls, [])

        const original = f.observer.observeTerminalEvidence
        f.observer.observeTerminalEvidence = async (input) => {
            const observed = await original(input)
            return sealObservation({
                ...observed,
                rootAuthored: true,
                observationDigest: undefined
            })
        }
        await assert.rejects(
            executeLifecycleTerminalizationAction(f.context()),
            (error) =>
                error instanceof LifecycleTerminalizationExecutorError &&
                error.code === 'terminal-evidence-observation-invalid'
        )
        assert.equal(fs.existsSync(f.retainedPath), true)
    } finally {
        f.cleanup()
    }
})

test('terminal recovery requires the current receipt fingerprint and supersedes the receipt chain', async () => {
    const f = await fixture()
    try {
        const completed = await executeLifecycleTerminalizationAction(
            f.context()
        )
        f.ledger = completed.ledger
        assert.throws(
            () => appendTerminalRecovery(f, {
                previousRecoveryFingerprint:
                    digest('wrong-previous-terminal-fingerprint'),
                recoveryFingerprint:
                    digest('changed-terminal-fingerprint')
            }),
            (error) =>
                error?.code === 'terminal-recovery-fingerprint-stale'
        )
        assert.throws(
            () => appendTerminalRecovery(f, {
                previousRecoveryFingerprint: f.observableFingerprint,
                recoveryFingerprint: f.observableFingerprint
            }),
            (error) => error?.code === 'terminal-recovery-unchanged'
        )
        const changed = digest('changed-terminal-fingerprint')
        appendTerminalRecovery(f, {
            previousRecoveryFingerprint: f.observableFingerprint,
            recoveryFingerprint: changed
        })
        const projection = projectLifecycleRun(f.ledger, {
            startup: f.startup
        })
        const node = projection.state.nodes[f.issueId]
        assert.equal(node.lifecycleState, 'none')
        assert.equal(node.receipts.terminal, undefined)
        assert.equal(node.receipts.recoveryFingerprint, undefined)
        assert.equal(node.receipts.retentionState, undefined)
        assert.equal(
            compileLifecycleRunActionSet(f.ledger, {
                startup: f.startup
            }).actions[0].type,
            'request-semantic-proposal'
        )
        assert.equal(fs.existsSync(f.retainedPath), true)
    } finally {
        f.cleanup()
    }
})

test('generic batch recording cannot bypass the terminal executor', async () => {
    const f = await fixture()
    try {
        const context = f.context()
        assert.throws(
            () => recordLifecycleActionResults({
                ledger: context.ledger,
                actionSet: context.actionSet,
                stageResults: [],
                createdAt: context.createdAt,
                startup: context.startup
            }),
            (error) =>
                error?.code ===
                    'lifecycle-terminal-direct-recording-forbidden'
        )
        assert.deepEqual(f.calls, [])
        assert.equal(fs.existsSync(f.retainedPath), true)
    } finally {
        f.cleanup()
    }
})

test('a second terminalization result is rejected', async () => {
    const f = await fixture()
    try {
        const context = f.context()
        const completed = await executeLifecycleTerminalizationAction(
            context
        )
        f.ledger = completed.ledger
        await assert.rejects(
            executeLifecycleTerminalizationAction(context),
            (error) =>
                error instanceof LifecycleTerminalizationExecutorError &&
                ['terminal-action-set-stale', 'terminal-node-state-invalid']
                    .includes(error.code)
        )
        assert.equal(fs.existsSync(f.retainedPath), true)
    } finally {
        f.cleanup()
    }
})

test('terminal action type export is exhaustive and immutable', () => {
    assert.deepEqual([...lifecycleTerminalizationActionTypes], [
        'terminalize-node'
    ])
    assert.equal(Object.isFrozen(lifecycleTerminalizationActionTypes), true)
})


test('terminal policy is one immutable versioned machine source', () => {
    const policy = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'policy/terminal-policy.json'),
        'utf8'
    ))
    const schema = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'contracts/terminal-policy.schema.json'),
        'utf8'
    ))
    assert.deepEqual(validateJsonSchema(policy, schema), [])
    assert.deepEqual(TERMINAL_POLICY, policy)
    assert.equal(TERMINAL_POLICY_DIGEST, digest(policy))
    assert.equal(Object.isFrozen(TERMINAL_POLICY), true)
    assert.equal(
        Object.isFrozen(
            TERMINAL_POLICY.categories.impossible.requiredEvidenceKinds
        ),
        true
    )
    assert.deepEqual(Object.keys(policy.categories).sort(), [
        'externally_blocked', 'impossible', 'not_applicable'
    ])
})

test('recovery fingerprints ignore narration but change with observable facts', async () => {
    const f = await fixture()
    try {
        const input = {
            runId: f.runId,
            nodeId: f.issueId,
            repository: f.repository.repository,
            issueNumber: 1,
            baseSha: f.repository.baseSha,
            nodeEpoch: 1,
            selectorReceiptDigest:
                f.context().action.bindings.selectorReceiptDigest,
            remoteSnapshotDigest:
                f.context().action.bindings.remoteSnapshotDigest,
            policyDigest: f.context().action.bindings.policyDigest,
            policySetDigest:
                f.context().action.bindings.policySetDigest,
            runtimeTrustBindingDigest:
                f.context().action.bindings.runtimeTrustBindingDigest,
            repositoryBindingDigest:
                f.repository.bindingDigest,
            category: f.category,
            firstFailureDigest: digest(f.firstFailure),
            directEvidenceDigest:
                f.context().action.bindings.terminalCandidate
                    .directEvidenceDigest,
            recoveryExhaustionDigest:
                f.context().action.bindings.terminalCandidate
                    .recoveryExhaustionDigest,
            domainDigests: f.domainDigests,
            retentionInventoryDigest:
                digest(f.retainedResources)
        }
        const first = compileTerminalRecoveryFingerprint({
            ...input,
            narration: 'first explanation',
            actorId: 'actor-a',
            attemptId: 'attempt-a',
            observedAt: '2026-08-05T02:00:00.000Z'
        })
        const sameFacts = compileTerminalRecoveryFingerprint({
            ...input,
            narration: 'different words',
            actorId: 'actor-b',
            attemptId: 'attempt-b',
            observedAt: '2026-08-06T02:00:00.000Z'
        })
        assert.equal(first, sameFacts)
        assert.notEqual(
            first,
            compileTerminalRecoveryFingerprint({
                ...input,
                domainDigests: {
                    ...input.domainDigests,
                    remote: digest('changed-remote-fact')
                }
            })
        )
    } finally {
        f.cleanup()
    }
})

test('terminal executor exposes no cleanup, landing, or remote mutation adapter', () => {
    const source = fs.readFileSync(path.join(
        repositoryRoot,
        'skills/issue-orchestration/scripts/lifecycle-terminalization-executor.mjs'
    ), 'utf8')
    for (const forbidden of [
        'git-resource-cleanup.mjs',
        'resource-lifecycle.mjs',
        'repository-landing-lane.mjs',
        'remote-mutation-authority.mjs',
        'applyRemoteMutation',
        'closeIssue',
        'releaseLease',
        'removeWorktree'
    ]) {
        assert.equal(source.includes(forbidden), false, forbidden)
    }
})
