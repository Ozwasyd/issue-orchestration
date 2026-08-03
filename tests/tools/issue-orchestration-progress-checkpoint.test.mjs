import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimePath = path.join(
    root,
    'skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
)
const runtimeRelativePath = path.relative(root, runtimePath)
const testRelativePath =
    'tests/tools/issue-orchestration-progress-checkpoint.test.mjs'
const testPath = path.join(root, testRelativePath)
const syntaxCommand = `node --check ${testRelativePath}`
const sliceId =
    'fsusblog-1874-test-contract-slice-2-checkpoint-continuation'
const sliceDigest =
    'c1afa3895f88d5e365ccf781a813c576729c0063b9fe449577c05701ab5be599'
const wholeIssueBody = [
    'Depends on: #1817, #1818, #1820, #1832, #1852',
    'Implement every executable slice, checkpoint, continuation and writer gate.',
    'Re-read the complete issue and investigate all requirements from the beginning.'
].join('\n')

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

function clone(value) {
    return structuredClone(value)
}

async function runtime() {
    assert.equal(
        fs.existsSync(runtimePath),
        true,
        `missing #1874 formal checkpoint/continuation runtime owner: ${runtimeRelativePath}`
    )
    return import(
        `${pathToFileURL(runtimePath).href}?progress-checkpoint=${Date.now()}-${Math.random()}`
    )
}

function git(...args) {
    return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8'
    }).trim()
}

function observeEvidence() {
    const syntax = spawnSync('node', ['--check', testRelativePath], {
        cwd: root,
        encoding: 'utf8'
    })
    const evidence = {
        requiredFiles: [
            {
                path: testRelativePath,
                realPath: fs.realpathSync(testPath),
                gitObjectDigest: git('hash-object', testRelativePath)
            }
        ],
        commands: [
            {
                command: syntaxCommand,
                exitStatus: syntax.status,
                outputDigest: digest({
                    stdout: syntax.stdout,
                    stderr: syntax.stderr
                })
            }
        ],
        git: {
            headSha: git('rev-parse', 'HEAD'),
            worktreeStatus: git('status', '--short', '--', testRelativePath)
        }
    }
    evidence.evidenceDigest = digest(evidence)
    return evidence
}

function plan() {
    return {
        schema: 'issue-orchestration.stage-work-plan.v1',
        status: 'verified',
        runId: 'run-1874-checkpoint-contract',
        repository: 'Ozwasyd/FsusBlog',
        issue: 1874,
        node: 'Ozwasyd/FsusBlog#1874',
        stageRole: 'test-contract-author',
        stagePhase: 'test-contract',
        baseSha: git('rev-parse', 'HEAD'),
        epochId: 'epoch-1874-checkpoint-001',
        worktreeIdentity: fs.realpathSync(root),
        planDigest: 'a'.repeat(64)
    }
}

function slice() {
    return {
        schema: 'issue-orchestration.executable-slice.v1',
        sliceId,
        sliceDigest,
        stagePhase: 'test-contract',
        singleObjective:
            'Establish focused progress checkpoint and continuation tests',
        requiredCreatedOrModifiedFiles: [testRelativePath],
        requiredCommands: [
            'node --test tests/tools/issue-orchestration-progress-checkpoint.test.mjs'
        ],
        completionPredicate:
            'focused test is red only because the formal implementation is missing',
        continuationPredicate:
            'verified checkpoint binds the same slice digest and resumes its cursor'
    }
}

function checkpointInput(overrides = {}) {
    const evidence = observeEvidence()
    return {
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        runId: plan().runId,
        node: plan().node,
        baseSha: plan().baseSha,
        epochId: plan().epochId,
        worktreeIdentity: plan().worktreeIdentity,
        sliceId,
        sliceDigest,
        status: 'partial',
        cursor: {
            kind: 'executable-slice-action',
            completedActionCount: 1,
            nextActionIndex: 2,
            lastCompletedAction: syntaxCommand
        },
        nextRequiredAction:
            'Run the focused node test and preserve its initial-red evidence',
        evidence,
        evidenceDigest: evidence.evidenceDigest,
        ...overrides
    }
}

async function sealedCheckpoint(overrides = {}) {
    const module = await runtime()
    const currentPlan = plan()
    const currentSlice = slice()
    const checkpoint = module.sealProgressCheckpoint({
        plan: currentPlan,
        slice: currentSlice,
        checkpoint: checkpointInput(overrides)
    })
    return { module, plan: currentPlan, slice: currentSlice, checkpoint }
}

test('formal checkpoint and continuation implementation exists before contract assertions run', async () => {
    const module = await runtime()

    assert.equal(typeof module.sealProgressCheckpoint, 'function')
    assert.equal(typeof module.validateProgressCheckpoint, 'function')
    assert.equal(typeof module.compileContinuation, 'function')
})

test('a real path, successful command status and Git digest produce a valid checkpoint dynamically', async () => {
    const evidence = observeEvidence()

    assert.equal(fs.existsSync(evidence.requiredFiles[0].realPath), true)
    assert.equal(evidence.commands[0].exitStatus, 0)
    assert.match(evidence.requiredFiles[0].gitObjectDigest, /^[a-f0-9]{40,64}$/u)
    assert.match(evidence.git.headSha, /^[a-f0-9]{40,64}$/u)
    assert.match(evidence.evidenceDigest, /^[a-f0-9]{64}$/u)

    const { module, plan: currentPlan, slice: currentSlice, checkpoint } =
        await sealedCheckpoint()
    assert.equal(checkpoint.sliceDigest, currentSlice.sliceDigest)
    assert.equal(checkpoint.evidenceDigest, evidence.evidenceDigest)
    assert.match(checkpoint.checkpointDigest, /^[a-f0-9]{64}$/u)
    assert.deepEqual(
        module.validateProgressCheckpoint({
            plan: currentPlan,
            slice: currentSlice,
            checkpoint
        }),
        []
    )
})

test('a natural-language plan cannot replace machine checkpoint evidence dynamically', async () => {
    const module = await runtime()
    const narrative = checkpointInput()
    delete narrative.evidence
    delete narrative.evidenceDigest
    narrative.plan =
        'I inspected the files and intend to continue after thinking about the issue.'

    assert.throws(
        () => module.sealProgressCheckpoint({
            plan: plan(),
            slice: slice(),
            checkpoint: narrative
        }),
        /natural language|narrative|machine evidence|evidence required/iu
    )
})

test('a checkpoint without nextRequiredAction is rejected dynamically', async () => {
    const module = await runtime()
    const missingNextAction = checkpointInput()
    delete missingNextAction.nextRequiredAction

    assert.throws(
        () => module.sealProgressCheckpoint({
            plan: plan(),
            slice: slice(),
            checkpoint: missingNextAction
        }),
        /next required action|nextRequiredAction|required/iu
    )
})

test('continuation binds the original slice identity and sealed checkpoint dynamically', async () => {
    const {
        module,
        plan: currentPlan,
        slice: originalSlice,
        checkpoint
    } = await sealedCheckpoint()
    const continuation = module.compileContinuation({
        plan: currentPlan,
        slice: originalSlice,
        checkpoint
    })

    assert.equal(
        continuation.schema,
        'issue-orchestration.stage-continuation-receipt.v1'
    )
    assert.equal(continuation.sliceId, originalSlice.sliceId)
    assert.equal(continuation.sliceDigest, originalSlice.sliceDigest)
    assert.equal(continuation.checkpointDigest, checkpoint.checkpointDigest)

    const reboundSlice = clone(originalSlice)
    reboundSlice.sliceId = 'fsusblog-1874-unrelated-slice'
    reboundSlice.sliceDigest = 'b'.repeat(64)
    assert.throws(
        () => module.compileContinuation({
            plan: currentPlan,
            slice: reboundSlice,
            checkpoint
        }),
        /slice|checkpoint|identity|digest/iu
    )
})

test('continuation resumes from the checkpoint cursor dynamically', async () => {
    const {
        module,
        plan: currentPlan,
        slice: originalSlice,
        checkpoint
    } = await sealedCheckpoint()
    const continuation = module.compileContinuation({
        plan: currentPlan,
        slice: originalSlice,
        checkpoint
    })

    assert.deepEqual(continuation.resumeCursor, checkpoint.cursor)
    assert.equal(
        continuation.nextRequiredAction,
        checkpoint.nextRequiredAction
    )
    assert.equal(continuation.restartInvestigation, false)
})

test('continuation rejects restarting investigation from the whole issue dynamically', async () => {
    const {
        module,
        plan: currentPlan,
        slice: originalSlice,
        checkpoint
    } = await sealedCheckpoint()

    assert.throws(
        () => module.compileContinuation({
            plan: currentPlan,
            slice: originalSlice,
            checkpoint,
            requestedResume: {
                mode: 'restart-from-issue-body',
                issueBody: wholeIssueBody
            }
        }),
        /whole issue|reinvestigation|restart|cursor/iu
    )
})

test('a partial checkpoint cannot declare candidate-green dynamically', async () => {
    const module = await runtime()

    assert.throws(
        () => module.sealProgressCheckpoint({
            plan: plan(),
            slice: slice(),
            checkpoint: checkpointInput({
                status: 'partial',
                candidateState: 'candidate-green'
            })
        }),
        /partial|candidate-green|terminal|completion/iu
    )
})
