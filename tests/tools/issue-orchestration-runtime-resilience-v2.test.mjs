import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const packageRoot = path.join(
    root,
    '.'
)
const contract = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/issues-1877-1887-contract.json'
), 'utf8'))
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}
const digest = (value) => createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const importRuntime = (issue) => import(pathToFileURL(path.join(
    packageRoot,
    contract.issues[String(issue)].runtimeOwner
)).href)
const HASH = /^[a-f0-9]{64}$/u

function transientFixture() {
    const semanticIdentity = {
        planDigest: digest('plan'),
        sliceDigest: digest('slice'),
        promptDigest: digest('prompt'),
        routeDecisionDigest: digest('route'),
        candidateDigest: digest('candidate')
    }
    return {
        failureReceipt: {
            schema:
                'issue-orchestration.writer-stage-failure-receipt.v1',
            classification: 'writer-stage.output-missing',
            failureReceiptDigest: digest('first-failure'),
            firstFailureReceiptDigest: digest('first-failure'),
            semanticFailureIdentity: digest(semanticIdentity),
            semanticIdentity,
            selectedProfile: 'terra-medium',
            reworkCountDelta: 0,
            humanDecisionRequired: false,
            status: 'terminal'
        },
        runtimeObservation: {
            schema:
                'issue-orchestration.writer-runtime-observation.v2',
            source: 'trusted-codex-runtime-trace',
            dispatchAccepted: true,
            threadId: 'thread-empty-1',
            rolloutId: 'rollout-empty-1',
            requestId: 'request-empty-1',
            terminationClass: 'empty-assistant-turn',
            selectedProfile: 'terra-medium',
            requestedModel: 'gpt-5.6-terra',
            effectiveModel: 'gpt-5.6-terra',
            requestedEffort: 'medium',
            effectiveEffort: 'medium',
            multiAgentBackend: 'v2',
            role: 'code-implementer',
            sandbox: 'workspace-write',
            cwd: '/fixture/worktree',
            skillsDigest: digest('skills'),
            leaseDigest: digest('lease'),
            assistantContentEvents: [],
            toolCallEvents: [],
            commandEvents: [],
            filesystemWriteEvents: [],
            checkpointEvents: [],
            terminalArtifactEvents: [],
            observationDigest: digest('runtime-observation')
        },
        priorAuthorizations: [],
        newRolloutIdentity: {
            threadId: 'thread-empty-2',
            rolloutId: 'rollout-empty-2',
            requestId: 'request-empty-2'
        }
    }
}

test('R82-01 authorizes exactly one same-contract retry for a proven empty rollout', async () => {
    const {
        authorizeTransientEmptyRolloutRetry,
        classifyTransientEmptyRollout
    } = await importRuntime(1882)
    const input = transientFixture()
    assert.equal(
        classifyTransientEmptyRollout(input).classification,
        'writer-stage.transient-rollout-empty'
    )
    const receipt = authorizeTransientEmptyRolloutRetry(input)
    assert.equal(
        receipt.schema,
        'issue-orchestration.transient-rollout-retry-authorization.v1'
    )
    assert.equal(receipt.status, 'authorized')
    assert.equal(receipt.retryOrdinal, 1)
    assert.deepEqual(
        receipt.semanticIdentity,
        input.failureReceipt.semanticIdentity
    )
    assert.equal(receipt.firstFailurePreserved, true)
    assert.equal(receipt.reworkCountDelta, 0)
    assert.equal(receipt.humanDecisionRequired, false)
    assert.match(receipt.authorizationDigest, HASH)
})

test('R82-02 kills every transient-retry abuse class with stable codes', async () => {
    const { authorizeTransientEmptyRolloutRetry } =
        await importRuntime(1882)
    const mutations = [
        ['missing-runtime-rollout', (v) => {
            v.runtimeObservation.rolloutId = null
        }, 'transient-retry-runtime-identity'],
        ['tool-call-before-empty', (v) => {
            v.runtimeObservation.toolCallEvents.push({ id: 'tool-1' })
        }, 'transient-retry-not-empty'],
        ['third-same-contract-attempt', (v) => {
            v.priorAuthorizations.push({
                semanticFailureIdentity:
                    v.failureReceipt.semanticFailureIdentity,
                status: 'authorized'
            })
        }, 'transient-retry-budget-exhausted'],
        ['semantic-identity-change', (v) => {
            v.retrySemanticIdentity = {
                ...v.failureReceipt.semanticIdentity,
                promptDigest: digest('changed')
            }
        }, 'transient-retry-semantic-drift'],
        ['first-failure-overwritten', (v) => {
            v.failureReceipt.firstFailureReceiptDigest =
                digest('overwritten')
        }, 'transient-retry-first-failure'],
        ['profile-mismatch-as-transient', (v) => {
            v.runtimeObservation.effectiveEffort = 'high'
        }, 'transient-retry-runtime-mismatch'],
        ['elapsed-time-only', (v) => {
            v.runtimeObservation.terminationClass = 'elapsed-time'
        }, 'transient-retry-termination-class'],
        ['rework-or-human-side-effect', (v) => {
            v.failureReceipt.reworkCountDelta = 1
        }, 'transient-retry-side-effect']
    ]
    assert.deepEqual(
        mutations.map(([id]) => id),
        contract.issues['1882'].negativeControls
    )
    for (const [, mutate, code] of mutations) {
        const input = transientFixture()
        mutate(input)
        assert.throws(
            () => authorizeTransientEmptyRolloutRetry(input),
            { code }
        )
    }
})

function candidate(label, paths = ['src/a.mjs']) {
    const value = {
        sourceCommit: digest(`${label}-source`).slice(0, 40),
        candidateSha: digest(`${label}-candidate`).slice(0, 40),
        treeDigest: digest(`${label}-tree`),
        diffDigest: digest(`${label}-diff`),
        changedPaths: paths
    }
    value.candidateDigest = digest(value)
    return value
}

function blockerFixture() {
    const candidateA = candidate('a')
    const value = {
        schema: 'issue-orchestration.verifier-blocker-input.v2',
        candidate: candidateA,
        acceptanceContractDigest: digest('acceptance'),
        testContractDigest: digest('test-contract'),
        blockerPaths: ['src/a.mjs'],
        blockerRequirementIds: ['REQ-a'],
        blockerEvidenceDigests: [digest('failure')],
        minimumFixBoundary: ['src/a.mjs'],
        verifierRuntime: {
            rolloutId: 'verifier-a',
            freshContext: true,
            inheritedThreadId: null,
            sandbox: 'read-only',
            role: 'test-owner',
            phase: 'behavior-verification'
        }
    }
    return value
}

test('R83-01 recompiles impact and fresh behavior authority for candidate B', async () => {
    const {
        compileBehaviorReceiptV3,
        compileVerificationImpactPlan,
        compileVerifierBlockerReceipt,
        verifyBehaviorReceiptV3
    } = await importRuntime(1883)
    const blocker = compileVerifierBlockerReceipt(blockerFixture())
    const candidateB = candidate('b', ['src/a.mjs', 'src/shared.mjs'])
    const impact = compileVerificationImpactPlan({
        blockerReceipt: blocker,
        candidate: candidateB,
        dependencyImpact: {
            'src/a.mjs': ['src/a.test.mjs'],
            'src/shared.mjs': ['tests/global-invariants.test.mjs']
        },
        globalInvariantCommands: [
            'node --test tests/global-invariants.test.mjs'
        ],
        focusedCommands: ['node --test src/a.test.mjs'],
        highRiskBoundaries: []
    })
    assert.ok(impact.impactedPaths.includes('src/shared.mjs'))
    assert.ok(impact.commands.includes(
        'node --test tests/global-invariants.test.mjs'
    ))
    const behavior = compileBehaviorReceiptV3({
        candidate: candidateB,
        blockerReceipt: blocker,
        impactPlan: impact,
        verifierRuntime: {
            rolloutId: 'verifier-b',
            freshContext: true,
            inheritedThreadId: null,
            sandbox: 'read-only',
            role: 'test-owner',
            phase: 'behavior-verification'
        },
        commandEvidence: impact.commands.map((command) => ({
            command,
            exitCode: 0,
            evidenceDigest: digest(command)
        })),
        reusableEvidence: []
    })
    assert.equal(behavior.status, 'behavior-green')
    assert.equal(behavior.candidateDigest, candidateB.candidateDigest)
    assert.notEqual(
        behavior.verifierRolloutId,
        blocker.verifierRolloutId
    )
    assert.equal(verifyBehaviorReceiptV3({
        candidate: candidateB,
        receipt: behavior
    }).status, 'valid')
})

test('R83-02 rejects stale candidates, Root authority and unsafe delta evidence', async () => {
    const {
        compileBehaviorReceiptV3,
        compileVerificationImpactPlan,
        compileVerifierBlockerReceipt,
        verifyBehaviorReceiptV3
    } = await importRuntime(1883)
    const blocker = compileVerifierBlockerReceipt(blockerFixture())
    const candidateB = candidate('b')
    const impact = compileVerificationImpactPlan({
        blockerReceipt: blocker,
        candidate: candidateB,
        dependencyImpact: { 'src/a.mjs': ['src/a.test.mjs'] },
        globalInvariantCommands: ['node --test tests/global.test.mjs'],
        focusedCommands: ['node --test src/a.test.mjs'],
        highRiskBoundaries: []
    })
    const base = {
        candidate: candidateB,
        blockerReceipt: blocker,
        impactPlan: impact,
        verifierRuntime: {
            rolloutId: 'verifier-b',
            freshContext: true,
            inheritedThreadId: null,
            sandbox: 'read-only',
            role: 'test-owner',
            phase: 'behavior-verification'
        },
        commandEvidence: impact.commands.map((command) => ({
            command,
            exitCode: 0,
            evidenceDigest: digest(command)
        })),
        reusableEvidence: []
    }
    const behavior = compileBehaviorReceiptV3(base)
    assert.throws(() => verifyBehaviorReceiptV3({
        candidate: candidate('c'),
        receipt: behavior
    }), { code: 'behavior-candidate-binding' })
    assert.throws(() => compileBehaviorReceiptV3({
        ...base,
        verifierRuntime: {
            ...base.verifierRuntime,
            role: 'root-scheduler'
        }
    }), { code: 'behavior-verifier-authority' })
    assert.throws(() => compileBehaviorReceiptV3({
        ...base,
        verifierRuntime: {
            ...base.verifierRuntime,
            inheritedThreadId: 'implementer-thread'
        }
    }), { code: 'behavior-verifier-fresh-context' })
    assert.throws(() => compileVerificationImpactPlan({
        blockerReceipt: blocker,
        candidate: candidateB,
        dependencyImpact: { 'src/a.mjs': ['src/a.test.mjs'] },
        globalInvariantCommands: [],
        focusedCommands: ['node --test src/a.test.mjs'],
        highRiskBoundaries: []
    }), { code: 'verification-impact-global-invariants' })
})

function watchdogFixture(overrides = {}) {
    const cancellations = []
    const persisted = []
    return {
        input: {
            binding: {
                requestId: 'request-1',
                threadId: 'thread-1',
                rolloutId: 'rollout-1',
                attemptId: 'attempt-1',
                planDigest: digest('plan'),
                sliceDigest: digest('slice'),
                routeDecisionDigest: digest('route'),
                leaseDigest: digest('lease'),
                selectedProfile: 'terra-medium',
                firstRequiredAction: 'write:src/a.mjs',
                requiredCommands: ['node --test tests/a.test.mjs']
            },
            budgets: {
                maxReadOnlyOperationsBeforeCheckpoint: 2,
                maxNoArtifactToolCalls: 3,
                maxNoArtifactActiveMs: 1000,
                postCommandEvidenceMs: 200
            },
            runtimeCapabilities: {
                incrementalTrace: true,
                cancellation: true
            },
            cancel: (reason) => cancellations.push(reason),
            persist: (receipt) => persisted.push(receipt),
            startedAtMs: 0,
            ...overrides
        },
        cancellations,
        persisted
    }
}

test('R87-01 enforces first action and first artifact from incremental trace', async () => {
    const { createWriterRuntimeWatchdog } = await importRuntime(1887)
    const fixture = watchdogFixture()
    const watchdog = createWriterRuntimeWatchdog(fixture.input)
    assert.equal(watchdog.state, 'watching-first-action')
    watchdog.observe({
        type: 'runtime-initialized',
        trusted: true,
        atMs: 1
    })
    watchdog.observe({
        type: 'filesystem-write',
        trusted: true,
        action: 'write:src/a.mjs',
        path: 'src/a.mjs',
        evidenceDigest: digest('write'),
        atMs: 10
    })
    assert.equal(watchdog.state, 'productive')
    watchdog.observe({
        type: 'terminal-receipt',
        trusted: true,
        status: 'completed',
        receiptDigest: digest('terminal'),
        atMs: 20
    })
    const receipt = watchdog.receipt()
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.firstActionVerified, true)
    assert.equal(receipt.firstArtifactVerified, true)
    assert.equal(fixture.cancellations.length, 0)
    assert.match(receipt.receiptDigest, HASH)
})

test('R87-02 threshold breach cancels online before later stage work', async () => {
    const { createWriterRuntimeWatchdog } = await importRuntime(1887)
    const fixture = watchdogFixture()
    const watchdog = createWriterRuntimeWatchdog(fixture.input)
    watchdog.observe({
        type: 'tool-call',
        trusted: true,
        operation: 'read:unrelated-a',
        readOnly: true,
        atMs: 10
    })
    watchdog.observe({
        type: 'tool-call',
        trusted: true,
        operation: 'read:unrelated-b',
        readOnly: true,
        atMs: 20
    })
    watchdog.observe({
        type: 'tool-call',
        trusted: true,
        operation: 'read:unrelated-c',
        readOnly: true,
        atMs: 30
    })
    assert.equal(watchdog.state, 'terminal-failure-observed')
    assert.deepEqual(fixture.cancellations, ['read-budget-exceeded'])
    assert.throws(() => watchdog.observe({
        type: 'filesystem-write',
        trusted: true,
        action: 'write:src/a.mjs',
        path: 'src/a.mjs',
        atMs: 40
    }), { code: 'watchdog-terminal' })
})

test('R87-03 required command heartbeat is progress; sleep and repeats are not', async () => {
    const { createWriterRuntimeWatchdog } = await importRuntime(1887)
    const commandFixture = watchdogFixture()
    const commandWatchdog =
        createWriterRuntimeWatchdog(commandFixture.input)
    commandWatchdog.observe({
        type: 'filesystem-write',
        trusted: true,
        action: 'write:src/a.mjs',
        path: 'src/a.mjs',
        evidenceDigest: digest('write'),
        atMs: 10
    })
    commandWatchdog.observe({
        type: 'command-start',
        trusted: true,
        command: 'node --test tests/a.test.mjs',
        processId: 41,
        atMs: 20
    })
    commandWatchdog.observe({
        type: 'command-heartbeat',
        trusted: true,
        processId: 41,
        processAlive: true,
        leaseDigest: digest('lease'),
        atMs: 5000
    })
    assert.equal(commandWatchdog.state, 'productive')

    const sleepFixture = watchdogFixture()
    const sleepWatchdog = createWriterRuntimeWatchdog(sleepFixture.input)
    sleepWatchdog.observe({
        type: 'tool-call',
        trusted: true,
        operation: 'sleep',
        readOnly: true,
        atMs: 10
    })
    sleepWatchdog.observe({
        type: 'tool-call',
        trusted: true,
        operation: 'git status',
        readOnly: true,
        atMs: 20
    })
    sleepWatchdog.observe({
        type: 'tool-call',
        trusted: true,
        operation: 'git status',
        readOnly: true,
        atMs: 30
    })
    assert.equal(sleepWatchdog.state, 'terminal-failure-observed')
})

test('R87-04 checkpoint, crash and unavailable cancellation all fail closed', async () => {
    const { createWriterRuntimeWatchdog } = await importRuntime(1887)
    assert.throws(() => createWriterRuntimeWatchdog(
        watchdogFixture({
            runtimeCapabilities: {
                incrementalTrace: false,
                cancellation: true
            }
        }).input
    ), { code: 'watchdog-capability-unavailable' })

    const checkpointFixture = watchdogFixture()
    const checkpointWatchdog =
        createWriterRuntimeWatchdog(checkpointFixture.input)
    checkpointWatchdog.observe({
        type: 'filesystem-write',
        trusted: true,
        action: 'write:src/a.mjs',
        path: 'src/a.mjs',
        evidenceDigest: digest('write'),
        atMs: 10
    })
    checkpointWatchdog.observe({
        type: 'checkpoint-receipt',
        trusted: true,
        valid: true,
        checkpointDigest: digest('checkpoint'),
        continuationDigest: digest('continuation'),
        resourcesReleased: true,
        atMs: 20
    })
    assert.equal(checkpointWatchdog.state, 'checkpoint-received')
    assert.equal(checkpointWatchdog.receipt().status, 'checkpoint-received')

    const crashFixture = watchdogFixture()
    const crashWatchdog = createWriterRuntimeWatchdog(crashFixture.input)
    crashWatchdog.failClosed(new Error('watchdog crashed'))
    assert.equal(crashWatchdog.state, 'terminal-failure-observed')
    assert.deepEqual(crashFixture.cancellations, ['watchdog-failure'])
})
