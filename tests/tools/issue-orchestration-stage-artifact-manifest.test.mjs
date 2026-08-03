import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'

const legacyUrl = new URL(
    '../../tools/issue-orchestration-stage-artifact-manifest.mjs',
    import.meta.url
)
const canonicalUrl = new URL(
    '../../skills/'
        + 'issue-orchestration/scripts/writer-stage-progress.mjs',
    import.meta.url
)
const repository = 'ExampleOrg/RepositoryA'
const issue = 1852
const node = `${repository}#${issue}`
const routeDigest = writerTestDigest({
    node,
    stageRole: 'test-owner',
    stagePhase: 'test-contract'
})
const authorityFixture = createWriterStageGitFixture({
    filePaths: [
        'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
    ]
})
after(() => authorityFixture.dispose())
const artifacts = compileWriterStageTestArtifacts({
    repository,
    issue,
    node,
    stageRole: 'test-owner',
    stagePhase: 'test-contract',
    baseSha: authorityFixture.baseSha,
    epochId: 'epoch-stage-artifact-1852',
    worktreeIdentity: authorityFixture.worktreeIdentity,
    allowedPaths: [
        'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
    ],
    requiredCommands: [
        'node --test '
            + 'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
    ]
})

async function loadContract() {
    return import(canonicalUrl.href)
}

function emptyObservation(overrides = {}) {
    return {
        schema: 'issue-orchestration.writer-stage-observation.v1',
        runId: artifacts.stageWorkPlan.runId,
        repository,
        issue,
        node,
        baseSha: artifacts.stageWorkPlan.baseSha,
        epochId: artifacts.stageWorkPlan.epochId,
        worktreeIdentity: artifacts.stageWorkPlan.worktreeIdentity,
        sliceId: artifacts.executableSlice.sliceId,
        sliceDigest: artifacts.sliceDigest,
        planDigest: artifacts.planDigest,
        compiledPromptDigest: artifacts.compiledPromptDigest,
        routeDigest,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        attemptId: 'attempt-stage-artifact-1',
        agentId: 'test-owner-stage-artifact-1',
        firstRequiredActionExecuted: true,
        invocationObservation: {
            started: true
        },
        environmentObservation: {
            ready: true
        },
        runtimeCapabilityObservation: {
            available: true,
            effectiveMetadataObserved: true
        },
        filesystemObservation: {
            createdFiles: [],
            modifiedFiles: [],
            treeDigest: writerTestDigest([])
        },
        gitObservation: {
            changedPaths: [],
            unauthorizedPaths: [],
            diffDigest: writerTestDigest([])
        },
        commandObservation: {
            commands: [],
            statuses: [],
            evidenceDigests: []
        },
        checkpoint: null,
        terminalReceipt: null,
        ...overrides
    }
}

function seal(value, digestField = 'receiptDigest') {
    const unsigned = structuredClone(value)
    delete unsigned[digestField]
    return {
        ...unsigned,
        [digestField]: writerTestDigest(unsigned)
    }
}

function fakePositiveObservation(overrides = {}) {
    const checkpoint = seal({
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        runId: artifacts.stageWorkPlan.runId,
        node,
        baseSha: artifacts.stageWorkPlan.baseSha,
        epochId: artifacts.stageWorkPlan.epochId,
        worktreeIdentity: artifacts.stageWorkPlan.worktreeIdentity,
        sliceId: artifacts.executableSlice.sliceId,
        sliceDigest: artifacts.executableSlice.sliceDigest,
        status: 'complete',
        cursor: {
            kind: 'executable-slice-action',
            completedActionCount: 2,
            nextActionIndex: 3,
            lastCompletedAction: artifacts.executableSlice.requiredCommands[0]
        },
        nextRequiredAction: null,
        evidence: {
            requiredFiles: [],
            commands: [],
            git: {
                headSha: artifacts.stageWorkPlan.baseSha,
                worktreeStatus:
                    ' M tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
            },
            satisfiedEvidenceIds: []
        },
        evidenceDigest: writerTestDigest('fabricated-evidence'),
        treeDigest: writerTestDigest('fabricated-tree'),
        diffDigest: writerTestDigest('fabricated-diff'),
        commandEvidenceDigest: writerTestDigest('fabricated-commands')
    }, 'checkpointDigest')
    const terminalReceipt = seal({
        schema: 'issue-orchestration.slice-terminal-receipt.v1',
        runId: artifacts.stageWorkPlan.runId,
        repository,
        issue,
        node,
        baseSha: artifacts.stageWorkPlan.baseSha,
        epochId: artifacts.stageWorkPlan.epochId,
        worktreeIdentity: artifacts.stageWorkPlan.worktreeIdentity,
        sliceId: artifacts.executableSlice.sliceId,
        sliceDigest: artifacts.executableSlice.sliceDigest,
        planDigest: artifacts.stageWorkPlan.planDigest,
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        checkpointDigest: checkpoint.checkpointDigest,
        outcome: 'completed',
        stageComplete: true,
        candidateEligible: true,
        evidenceDigest: checkpoint.evidenceDigest,
        changedPaths: [
            'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
        ],
        commandEvidenceDigests: [
            writerTestDigest('fabricated-command-output')
        ],
        nextSliceId: null
    })
    return emptyObservation({
        filesystemObservation: {
            createdFiles: [],
            modifiedFiles: [
                'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
            ],
            treeDigest: writerTestDigest('fabricated-tree')
        },
        gitObservation: {
            changedPaths: [
                'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs'
            ],
            unauthorizedPaths: [],
            diffDigest: writerTestDigest('fabricated-diff')
        },
        commandObservation: {
            commands: [...artifacts.executableSlice.requiredCommands],
            statuses: [0],
            evidenceDigests: [
                writerTestDigest('fabricated-command-output')
            ]
        },
        checkpoint,
        terminalReceipt,
        plan: artifacts.stageWorkPlan,
        currentSlice: artifacts.executableSlice,
        sliceTerminalReceipts: [terminalReceipt],
        ...overrides
    })
}

test('the canonical package is the only writer-stage authority', async () => {
    const contract = await loadContract()
    const canonical = await import(canonicalUrl.href)

    assert.equal(fs.existsSync(fileURLToPath(legacyUrl)), false)
    for (const name of [
        'evaluateWriterStageObservation',
        'authorizeWriterStageRetry',
        'sealSliceTerminalReceipt',
        'evaluateSliceTerminalGate'
    ]) {
        assert.equal(typeof contract[name], 'function', name)
        assert.equal(contract[name], canonical[name], name)
    }
})

test('missing machine output is terminal and opens the semantic breaker', async () => {
    const { evaluateWriterStageObservation } = await loadContract()
    const result = evaluateWriterStageObservation(emptyObservation())

    assert.equal(result.status, 'failed')
    assert.equal(result.eventType, 'writer-stage.output-missing')
    assert.equal(result.breakerOpen, true)
    assert.equal(result.countsAsImplementationRework, false)
    assert.equal(result.reworkCountDelta, 0)
    assert.equal(result.triggersHumanDecision, false)
    assert.equal(result.failureReceipt.status, 'terminal')
    assert.equal(
        result.failureReceipt.sliceDigest,
        artifacts.executableSlice.sliceDigest
    )
    assert.match(result.failureReceipt.semanticFailureDigest, /^[a-f0-9]{64}$/u)
    assert.match(result.failureReceipt.receiptDigest, /^[a-f0-9]{64}$/u)
})

test('an invocation failure is a terminal receipt, not an automatic retry', async () => {
    const { evaluateWriterStageObservation } = await loadContract()
    const result = evaluateWriterStageObservation(emptyObservation({
        invocationObservation: {
            started: false
        }
    }))

    assert.equal(result.status, 'failed')
    assert.equal(result.eventType, 'writer-stage.invocation-failed')
    assert.equal(result.breakerOpen, true)
    assert.equal(result.failureReceipt.breakerOpen, true)
})

test('identity shell changes cannot bypass cleanup authority or reset the breaker', async () => {
    const {
        authorizeWriterStageRetry,
        evaluateWriterStageObservation
    } = await loadContract()
    const first = evaluateWriterStageObservation(emptyObservation())
    const shellChanged = evaluateWriterStageObservation(emptyObservation({
        attemptId: 'attempt-stage-artifact-2',
        agentId: 'test-owner-stage-artifact-2',
        worktreeIdentity: '/worktrees/stage-artifact-1852-retried',
        promptWording: 'Different prose around the same failed slice.'
    }))

    assert.equal(
        shellChanged.failureReceipt.semanticFailureDigest,
        first.failureReceipt.semanticFailureDigest
    )
    const retry = authorizeWriterStageRetry({
        priorFailure: first.failureReceipt,
        proposed: shellChanged.failureReceipt,
        revisions: []
    })
    assert.deepEqual(retry, {
        authorized: false,
        breakerOpen: true,
        reason:
            'retry requires a verified #1828 clean resource disposition '
            + 'for the failed attempt'
    })
})

test('a self-sealed legacy slice revision cannot bypass active retry authority', async () => {
    const {
        authorizeWriterStageRetry,
        evaluateWriterStageObservation
    } = await loadContract()
    const failure = evaluateWriterStageObservation(emptyObservation())
    const currentDigest = writerTestDigest({
        previous: failure.failureReceipt.sliceDigest,
        change: 'add missing frozen artifact requirements'
    })
    const changedRequirementIds = [
        'stage-artifact-machine-evidence'
    ]
    const revision = {
        kind: 'slice-revision',
        previousDigest: failure.failureReceipt.sliceDigest,
        currentDigest,
        changedRequirementIds,
        evidenceDigest: writerTestDigest({
            changedRequirementIds,
            previousDigest: failure.failureReceipt.sliceDigest,
            currentDigest
        })
    }
    const authorization = authorizeWriterStageRetry({
        priorFailure: failure.failureReceipt,
        proposed: {
            sliceDigest: currentDigest
        },
        revisions: [revision]
    })

    assert.deepEqual(authorization, {
        authorized: false,
        breakerOpen: true,
        reason:
            'retry requires a verified #1828 clean resource disposition '
            + 'for the failed attempt'
    })
})

test('a self-hashed fake checkpoint and terminal receipt cannot manufacture completion', async () => {
    const { evaluateWriterStageObservation } = await loadContract()
    const result = evaluateWriterStageObservation(fakePositiveObservation())

    assert.deepEqual(result.missingRequiredOutputs, ['checkpoint'])
    assert.equal(result.status, 'failed')
    assert.equal(result.eventType, 'writer-stage.receipt-rejected')
    assert.equal(result.breakerOpen, true)
    assert.equal(result.nextState, 'terminal')
})

test('positive-looking artifacts do not mask first-action, environment, or runtime failure', async () => {
    const { evaluateWriterStageObservation } = await loadContract()
    const cases = [
        {
            eventType: 'writer-stage.first-action-not-executed',
            overrides: { firstRequiredActionExecuted: false }
        },
        {
            eventType: 'writer-stage.environment-failed',
            overrides: {
                environmentObservation: { ready: false }
            }
        },
        {
            eventType: 'writer-stage.runtime-capability-missing',
            overrides: {
                runtimeCapabilityObservation: {
                    available: false,
                    effectiveMetadataObserved: false
                }
            }
        }
    ]
    for (const contractCase of cases) {
        const observation = fakePositiveObservation()
        observation.checkpoint = null
        observation.terminalReceipt = null
        Object.assign(observation, contractCase.overrides)
        const result = evaluateWriterStageObservation(observation)
        assert.equal(result.status, 'failed')
        assert.equal(result.eventType, contractCase.eventType)
        assert.equal(result.breakerOpen, true)
    }
})

test('self-sealed prompt, runtime, and capability revisions cannot close the breaker', async () => {
    const {
        authorizeWriterStageRetry,
        evaluateWriterStageObservation
    } = await loadContract()
    const failure = evaluateWriterStageObservation(emptyObservation())
    const kinds = [
        'compiled-prompt-revision',
        'runtime-revision',
        'capability-revision'
    ]
    for (const kind of kinds) {
        const previousDigest = kind === 'compiled-prompt-revision'
            ? failure.failureReceipt.compiledPromptDigest
            : writerTestDigest({ kind, version: 'previous' })
        const currentDigest =
            writerTestDigest({ kind, version: 'current' })
        const changedRequirementIds = [`${kind}-self-sealed`]
        const currentSliceDigest = writerTestDigest({
            kind,
            slice: 'self-sealed'
        })
        const revision = {
            kind,
            previousDigest,
            currentDigest,
            changedRequirementIds,
            ...(kind === 'compiled-prompt-revision'
                ? { currentSliceDigest }
                : {})
        }
        revision.evidenceDigest = writerTestDigest({
            changedRequirementIds,
            previousDigest,
            currentDigest
        })
        const proposed = {
            sliceDigest: kind === 'compiled-prompt-revision'
                ? currentSliceDigest
                : artifacts.executableSlice.sliceDigest,
            compiledPromptDigest: currentDigest,
            runtimeMetadataDigest: currentDigest,
            runtimeRevisionReceiptDigest:
                writerTestDigest({ kind, receipt: 'runtime' }),
            capabilityDigest: currentDigest,
            capabilityRevisionReceiptDigest:
                writerTestDigest({ kind, receipt: 'capability' })
        }
        const authorization = authorizeWriterStageRetry({
            priorFailure: failure.failureReceipt,
            proposed,
            revisions: [revision]
        })
        assert.equal(authorization.authorized, false, kind)
        assert.equal(authorization.breakerOpen, true, kind)
        assert.match(
            authorization.reason,
            /verified #1828 clean resource disposition/iu
        )
    }
})
