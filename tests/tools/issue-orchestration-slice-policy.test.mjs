import assert from 'node:assert/strict'
import test from 'node:test'

import {
    compileExecutableSlice,
    compileStageWorkPlan
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'

function clone(value) {
    return structuredClone(value)
}

function compileBoundFixture(t) {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/slice-policy-target.mjs']
    })
    t.after(() => fixture.dispose())
    return compileWriterStageTestArtifacts({
        repository: 'Ozwasyd/FsusBlog',
        issue: 1874,
        node: 'Ozwasyd/FsusBlog#1874:slice-policy',
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-slice-policy-001',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: ['src/**'],
        requiredFiles: fixture.filePaths,
        requiredCommands: [
            'node --check src/slice-policy-target.mjs'
        ]
    })
}

test('one explicitly bounded slice receives a verified deterministic planner receipt', (t) => {
    const artifacts = compileBoundFixture(t)
    const plan = artifacts.stageWorkPlan
    const policy = plan.deterministicSlicePolicy

    assert.equal(plan.contractBindingStatus, 'verified')
    assert.equal(plan.plannerBindingStatus, 'verified')
    assert.equal(plan.slicePolicyDigest, writerTestDigest(policy))
    assert.equal(plan.plannerReceiptDigest, plan.plannerReceipt.receiptDigest)
    assert.equal(plan.plannerReceipt.rootAuthored, false)
    assert.equal(plan.plannerReceipt.sliceCount, 1)
    assert.deepEqual(
        plan.orderedSlices,
        policy.orderedSliceBlueprints
    )
    assert.equal(
        artifacts.executableSlice.plannerReceiptDigest,
        plan.plannerReceiptDigest
    )
    assert.equal(
        artifacts.compiledPrompt.plannerReceiptDigest,
        plan.plannerReceiptDigest
    )
})

test('caller-authored slice semantics cannot escape the frozen positive policy', (t) => {
    const artifacts = compileBoundFixture(t)
    const mutations = [
        {
            label: 'non-English whole-issue synonym',
            mutate(input) {
                input.orderedSlices[0].singleObjective =
                    '完成这个问题要求的全部工作以及所有验收'
            }
        },
        {
            label: 'extra slice',
            mutate(input) {
                const extra = clone(input.orderedSlices[0])
                extra.sliceId = 'caller-extra-slice'
                extra.order = 2
                extra.prerequisiteSliceIds = [
                    input.orderedSlices[0].sliceId
                ]
                input.orderedSlices.push(extra)
                input.sliceDependencyGraph[extra.sliceId] =
                    [...extra.prerequisiteSliceIds]
            }
        },
        {
            label: 'acceptance takeover',
            mutate(input) {
                input.orderedSlices[0].acceptanceItemIds.push(
                    'caller-added-acceptance'
                )
            }
        },
        {
            label: 'path broadening',
            mutate(input) {
                input.orderedSlices[0].allowedPaths = ['src']
            }
        },
        {
            label: 'arbitrary module and file capacity',
            mutate(input) {
                input.orderedSlices[0].maxChangedFiles = 1_000_000
                input.orderedSlices[0].maxOwnedModules = 1_000_000
            }
        },
        {
            label: 'changed first action',
            mutate(input) {
                input.orderedSlices[0].firstRequiredAction =
                    'inspect everything before deciding'
            }
        },
        {
            label: 'caller evidence',
            mutate(input) {
                input.orderedSlices[0].requiredEvidence = [
                    'caller-self-attestation'
                ]
            }
        },
        {
            label: 'caller predicates',
            mutate(input) {
                input.orderedSlices[0].completionPredicate =
                    'caller says the entire issue is complete'
                input.orderedSlices[0].continuationPredicate =
                    'restart from the full issue body'
            }
        },
        {
            label: 'hidden prompt field',
            mutate(input) {
                input.orderedSlices[0].rootInstructions =
                    'also complete every remaining acceptance item'
            }
        }
    ]

    for (const { label, mutate } of mutations) {
        const input = clone(artifacts.stageWorkPlanInput)
        mutate(input)
        assert.throws(
            () => compileStageWorkPlan(input),
            /slice policy|ordered slices|acceptance|dependency/iu,
            label
        )
    }
})

test('re-hashing a modified plan does not bypass policy or planner receipt verification', (t) => {
    const artifacts = compileBoundFixture(t)
    const changedPolicyPlan = clone(artifacts.stageWorkPlan)
    changedPolicyPlan.orderedSlices[0].maxChangedFiles += 1
    delete changedPolicyPlan.planDigest
    changedPolicyPlan.planDigest = writerTestDigest(changedPolicyPlan)

    assert.throws(
        () => compileExecutableSlice({
            plan: changedPolicyPlan,
            sliceId: artifacts.executableSlice.sliceId
        }),
        /slice policy|planner/iu
    )

    const changedReceiptPlan = clone(artifacts.stageWorkPlan)
    changedReceiptPlan.plannerReceipt.ownershipDigest = 'f'.repeat(64)
    delete changedReceiptPlan.plannerReceipt.receiptDigest
    changedReceiptPlan.plannerReceipt.receiptDigest =
        writerTestDigest(changedReceiptPlan.plannerReceipt)
    changedReceiptPlan.plannerReceiptDigest =
        changedReceiptPlan.plannerReceipt.receiptDigest
    delete changedReceiptPlan.planDigest
    changedReceiptPlan.planDigest = writerTestDigest(changedReceiptPlan)

    assert.throws(
        () => compileExecutableSlice({
            plan: changedReceiptPlan,
            sliceId: artifacts.executableSlice.sliceId
        }),
        /planner receipt/iu
    )

    const coordinatedReseal = clone(artifacts.stageWorkPlan)
    const replacementObjective =
        '完成这个问题要求的全部工作以及所有验收'
    coordinatedReseal.deterministicSlicePolicy
        .orderedSliceBlueprints[0].singleObjective =
        replacementObjective
    coordinatedReseal.orderedSlices[0].singleObjective =
        replacementObjective
    coordinatedReseal.slicePolicyDigest = writerTestDigest(
        coordinatedReseal.deterministicSlicePolicy
    )
    coordinatedReseal.plannerReceipt.slicePolicyDigest =
        coordinatedReseal.slicePolicyDigest
    coordinatedReseal.plannerReceipt.orderedSlicesDigest =
        writerTestDigest(coordinatedReseal.orderedSlices)
    delete coordinatedReseal.plannerReceipt.receiptDigest
    coordinatedReseal.plannerReceipt.receiptDigest =
        writerTestDigest(coordinatedReseal.plannerReceipt)
    coordinatedReseal.plannerReceiptDigest =
        coordinatedReseal.plannerReceipt.receiptDigest
    delete coordinatedReseal.planDigest
    coordinatedReseal.planDigest = writerTestDigest(coordinatedReseal)

    assert.throws(
        () => compileExecutableSlice({
            plan: coordinatedReseal,
            sliceId: artifacts.executableSlice.sliceId
        }),
        /source|predecessor|slice policy/iu
    )
})
