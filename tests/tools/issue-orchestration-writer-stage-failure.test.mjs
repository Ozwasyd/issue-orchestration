import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimePath = path.join(
    root,
    'skills/issue-orchestration/scripts/writer-stage-progress.mjs'
)
const runtimeRelativePath = path.relative(root, runtimePath)
const sliceId = 'repositorya-1874-test-contract-slice-3-writer-stage-failure'
const sliceDigest =
    '21ca8bcb2334327226d5064452b5d7a64a73f6bd0978820e63bf6cbfaad52487'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function git(...args) {
    return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8'
    }).trim()
}

async function runtime() {
    assert.equal(
        fs.existsSync(runtimePath),
        true,
        `missing #1874 formal writer-stage failure implementation: ${runtimeRelativePath}`
    )
    return import(
        `${pathToFileURL(runtimePath).href}?writer-stage-failure=${Date.now()}-${Math.random()}`
    )
}

const identity = {
    runId: 'run-1874-writer-stage-failure-contract',
    repository: 'ExampleOrg/RepositoryA',
    issue: 1874,
    node: 'ExampleOrg/RepositoryA#1874',
    baseSha: git('rev-parse', 'HEAD'),
    epochId: 'epoch-1874-writer-stage-failure-001',
    worktreeIdentity: fs.realpathSync(root),
    sliceId,
    sliceDigest,
    planDigest: '1'.repeat(64),
    compiledPromptDigest: '2'.repeat(64),
    routeDigest: '3'.repeat(64)
}

const stageCases = [
    {
        name: 'implementation without diff, command or checkpoint fails dynamically',
        stagePhase: 'implementation',
        stageRole: 'code-implementer',
        missingRequiredOutputs: ['diff', 'commands', 'checkpoint']
    },
    {
        name: 'UI implementation without diff, render evidence or checkpoint fails dynamically',
        stagePhase: 'ui-implementation',
        stageRole: 'ui-ux-implementer',
        missingRequiredOutputs: ['diff', 'render-evidence', 'checkpoint']
    },
    {
        name: 'documentation without diff, no-change evidence or checkpoint fails dynamically',
        stagePhase: 'documentation',
        stageRole: 'documentation-writer',
        missingRequiredOutputs: [
            'diff',
            'verified-no-change-evidence',
            'checkpoint'
        ]
    },
    {
        name: 'landing conflict resolution without mapping, diff or checkpoint fails dynamically',
        stagePhase: 'landing-conflict-resolution',
        stageRole: 'landing-owner',
        missingRequiredOutputs: ['conflict-mapping', 'diff', 'checkpoint']
    }
]

function outputMissingObservation(stageCase, overrides = {}) {
    return {
        schema: 'issue-orchestration.writer-stage-observation.v1',
        ...identity,
        stagePhase: stageCase.stagePhase,
        stageRole: stageCase.stageRole,
        attemptId: 'attempt-1874-writer-stage-failure-001',
        agentId: 'agent-1874-writer-stage-failure-001',
        firstRequiredActionExecuted: true,
        requiredArtifactManifest: {
            requiredOutputs: stageCase.missingRequiredOutputs
        },
        filesystemObservation: {
            createdFiles: [],
            modifiedFiles: [],
            treeDigest: digest([])
        },
        gitObservation: {
            changedPaths: [],
            diffDigest: digest([]),
            unauthorizedPaths: []
        },
        commandObservation: {
            commands: [],
            statuses: [],
            evidenceDigests: []
        },
        renderEvidence: null,
        verifiedNoChangeEvidence: null,
        conflictMapping: null,
        checkpoint: null,
        terminalReceipt: null,
        priorFailureReceipt: null,
        ...overrides
    }
}

async function evaluateOutputMissing(stageCase = stageCases[0], overrides = {}) {
    const module = await runtime()
    return module.evaluateWriterStageObservation(
        outputMissingObservation(stageCase, overrides)
    )
}

function assertOutputMissing(result, stageCase) {
    assert.equal(result.status, 'failed')
    assert.equal(result.eventType, 'writer-stage.output-missing')
    assert.equal(result.terminalTransition, true)
    assert.equal(result.breakerOpen, true)
    assert.deepEqual(
        [...result.missingRequiredOutputs].sort(),
        [...stageCase.missingRequiredOutputs].sort()
    )
}

function priorFailureReceipt() {
    const receipt = {
        schema: 'issue-orchestration.writer-stage-failure-receipt.v1',
        ...identity,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        attemptId: 'attempt-1874-writer-stage-failure-001',
        agentId: 'agent-1874-writer-stage-failure-001',
        eventType: 'writer-stage.output-missing',
        breakerOpen: true,
        evidenceDigest: digest({
            changedPaths: [],
            commands: [],
            checkpoint: null
        })
    }
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

async function authorizeRetry({ proposed = {}, revisions = [] } = {}) {
    const module = await runtime()
    return module.authorizeWriterStageRetry({
        priorFailure: priorFailureReceipt(),
        proposed: {
            ...identity,
            attemptId: 'attempt-1874-writer-stage-failure-001',
            agentId: 'agent-1874-writer-stage-failure-001',
            compiledPromptText:
                'Implement the focused writer-stage output-missing contract.',
            ...proposed
        },
        revisions
    })
}

test('formal writer-stage failure implementation exists before contract assertions run', async () => {
    const module = await runtime()

    assert.equal(typeof module.evaluateWriterStageObservation, 'function')
    assert.equal(typeof module.authorizeWriterStageRetry, 'function')
})

for (const stageCase of stageCases) {
    test(stageCase.name, async () => {
        const result = await evaluateOutputMissing(stageCase)

        assertOutputMissing(result, stageCase)
        assert.equal(result.failureReceipt.stagePhase, stageCase.stagePhase)
        assert.equal(result.failureReceipt.sliceId, sliceId)
        assert.equal(result.failureReceipt.sliceDigest, sliceDigest)
    })
}

test('output-missing does not count as implementation rework dynamically', async () => {
    const result = await evaluateOutputMissing()

    assert.equal(result.countsAsImplementationRework, false)
    assert.equal(result.reworkCountDelta, 0)
})

test('output-missing does not trigger a human gate dynamically', async () => {
    const result = await evaluateOutputMissing()

    assert.equal(result.triggersHumanDecision, false)
    assert.notEqual(result.nextState, 'human-decision-required')
})

for (const mutation of [
    {
        name: 'changing attemptId does not reset the breaker dynamically',
        proposed: { attemptId: 'attempt-1874-writer-stage-failure-002' }
    },
    {
        name: 'changing agent does not reset the breaker dynamically',
        proposed: { agentId: 'agent-1874-writer-stage-failure-002' }
    },
    {
        name: 'changing prompt wording does not reset the breaker dynamically',
        proposed: {
            compiledPromptText:
                'Please implement only the writer stage missing output contract.'
        }
    },
    {
        name: 'changing worktree path does not reset the breaker dynamically',
        proposed: { worktreeIdentity: '/worktrees/issue-1874-replacement' }
    },
    {
        name: 'changing sliceId does not reset the breaker dynamically',
        proposed: { sliceId: 'repositorya-1874-identity-only-retry' }
    }
]) {
    test(mutation.name, async () => {
        const result = await authorizeRetry({ proposed: mutation.proposed })

        assert.equal(result.authorized, false)
        assert.equal(result.breakerOpen, true)
        assert.match(
            result.reason,
            /material|substantive|revision evidence|unchanged failure/iu
        )
    })
}

test('a legal retry requires substantive revision evidence dynamically', async () => {
    for (const revisions of [
        [],
        [{
            kind: 'slice-revision',
            previousDigest: sliceDigest,
            currentDigest: sliceDigest,
            evidenceDigest: '4'.repeat(64)
        }],
        [{
            kind: 'prompt-wording-only',
            evidenceDigest: '5'.repeat(64)
        }],
        [{
            kind: 'slice-revision',
            previousDigest: sliceDigest,
            currentDigest: '6'.repeat(64)
        }]
    ]) {
        const rejected = await authorizeRetry({ revisions })
        assert.equal(rejected.authorized, false)
        assert.equal(rejected.breakerOpen, true)
    }

    const evidence = {
        kind: 'slice-revision',
        previousDigest: sliceDigest,
        currentDigest: '6'.repeat(64),
        changedRequirementIds: ['W03-output-missing-terminal'],
        evidenceDigest: digest({
            changedRequirementIds: ['W03-output-missing-terminal'],
            previousDigest: sliceDigest,
            currentDigest: '6'.repeat(64)
        })
    }
    const authorized = await authorizeRetry({ revisions: [evidence] })

    assert.equal(authorized.authorized, true)
    assert.equal(authorized.breakerOpen, false)
    assert.equal(
        authorized.schema,
        'issue-orchestration.writer-stage-retry-authorization.v1'
    )
    assert.equal(authorized.revisionEvidenceDigest, evidence.evidenceDigest)
})

test('output-missing emits a machine terminal receipt bound to sliceDigest dynamically', async () => {
    const result = await evaluateOutputMissing()
    const receipt = result.failureReceipt
    const unsigned = { ...receipt }
    delete unsigned.receiptDigest

    assert.equal(
        receipt.schema,
        'issue-orchestration.writer-stage-failure-receipt.v1'
    )
    assert.equal(receipt.status, 'terminal')
    assert.equal(receipt.eventType, 'writer-stage.output-missing')
    assert.equal(receipt.sliceId, sliceId)
    assert.equal(receipt.sliceDigest, sliceDigest)
    assert.match(receipt.evidenceDigest, /^[a-f0-9]{64}$/u)
    assert.equal(receipt.receiptDigest, digest(unsigned))
})
