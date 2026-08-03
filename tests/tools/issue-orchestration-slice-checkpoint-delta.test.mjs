import assert from 'node:assert/strict'
import test from 'node:test'

import {
    sealProgressCheckpoint,
    validateProgressCheckpoint
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    observeWriterStageCheckpointEvidence
} from './issue-orchestration-writer-stage-test-helper.mjs'

const FILES = Object.freeze([
    'src/first-slice.mjs',
    'src/second-slice.mjs',
    'src/optional-prior.mjs'
])

function setup(current) {
    const fixture = createWriterStageGitFixture({
        filePaths: FILES
    })
    current.after(() => fixture.dispose())
    const artifacts = compileWriterStageTestArtifacts({
        repository: 'Ozwasyd/FsusBlog',
        issue: 1874,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-slice-checkpoint-delta-1',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: FILES,
        requiredFiles: FILES.slice(0, 2),
        sliceCount: 2,
        sliceId: 'fsusblog-1874-checkpoint-delta-slice-1'
    })
    return {
        artifacts,
        fixture,
        plan: artifacts.stageWorkPlan,
        slice: artifacts.executableSlices[1]
    }
}

function checkpointInput({
    plan,
    slice,
    evidence
}) {
    return {
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        runId: plan.runId,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        status: 'complete',
        candidateState: 'slice-complete',
        cursor: {
            kind: 'executable-slice-action',
            completedActionCount: 1,
            nextActionIndex: 2,
            lastCompletedAction: slice.requiredCommands.at(-1)
        },
        nextRequiredAction: null,
        evidence,
        evidenceDigest: evidence.evidenceDigest
    }
}

test('slice 2 checkpoint excludes a ledger-accepted slice 1 path from its Git delta', (current) => {
    const { fixture, plan, slice } = setup(current)
    fixture.activate([0, 1])
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice
    })
    const checkpoint = sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({ plan, slice, evidence }),
        acceptedPriorChangedPaths: [FILES[0]]
    })

    assert.deepEqual(validateProgressCheckpoint({
        plan,
        slice,
        checkpoint,
        acceptedPriorChangedPaths: [FILES[0]]
    }), [])
    assert.throws(() => sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({ plan, slice, evidence })
    }), /filesystem evidence|changed path count|slice capacity/iu)
})

test('slice checkpoint rejects a prior path outside every earlier slice boundary', (current) => {
    const { fixture, plan, slice } = setup(current)
    fixture.activate([0, 1])
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice
    })

    assert.throws(() => sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({ plan, slice, evidence }),
        acceptedPriorChangedPaths: ['src/not-authorized.mjs']
    }), /outside an earlier-slice boundary/iu)
})

test('complete slice checkpoint requires its writable file in the current delta', (current) => {
    const { fixture, plan, slice } = setup(current)
    fixture.activate([0, 2])
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice,
        requiredFiles: [FILES[1], FILES[2]]
    })

    assert.throws(() => sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({ plan, slice, evidence }),
        acceptedPriorChangedPaths: [FILES[0]]
    }), /required writable files are absent from the current slice Git delta/iu)
})

test('an optional path authorized by an earlier slice can be accepted from the ledger boundary', (current) => {
    const { fixture, plan, slice } = setup(current)
    fixture.activate([1, 2])
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice
    })
    const checkpoint = sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({ plan, slice, evidence }),
        acceptedPriorChangedPaths: [FILES[2]]
    })

    assert.deepEqual(validateProgressCheckpoint({
        plan,
        slice,
        checkpoint,
        acceptedPriorChangedPaths: [FILES[2]]
    }), [])
})
