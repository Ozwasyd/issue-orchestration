import test from 'node:test'
import assert from 'node:assert/strict'

import {
    executeLifecycleObserveOnlyAction,
    LifecycleObserveOnlyExecutorError,
    LIFECYCLE_OBSERVE_ONLY_SUPPORTED_ACTIONS
} from '../../skills/issue-orchestration/scripts/lifecycle-observe-only-executor.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    validateLifecycleStageResult
} from '../../skills/issue-orchestration/scripts/lifecycle-stage-admission.mjs'

const h = (label) => digest({ label })
const SHA = '1234567890abcdef1234567890abcdef12345678'
const CANDIDATE_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'

function candidateArtifact() {
    return {
        schema: 'issue-orchestration.candidate-identity.v1',
        artifactKind: 'candidate',
        receiptDigest: h('candidate-artifact'),
        evidence: {
            candidateSha: CANDIDATE_SHA,
            candidateTreeDigest: h('candidate-tree'),
            candidateDiffDigest: h('candidate-diff'),
            writerInvocationId: 'writer-invocation-1'
        }
    }
}

function acceptanceArtifact() {
    return {
        schema: 'issue-orchestration.issue-acceptance-contract.v1',
        contractDigest: h('acceptance-contract'),
        evidence: {
            acceptanceIds: ['A1']
        }
    }
}

function uiAdjudicationArtifact() {
    return {
        schema: 'issue-orchestration.completion-evidence.v1',
        receiptDigest: h('ui-adjudication-artifact'),
        evidence: {
            adjudication: 'bounded-ui-contract-confirmed'
        }
    }
}

function node({ ui = false } = {}) {
    return {
        nodeId: 'node-1',
        uiClass: ui ? 'ui' : 'code',
        receipts: {
            candidate: candidateArtifact(),
            acceptanceContract: acceptanceArtifact(),
            uiAdjudication: uiAdjudicationArtifact()
        }
    }
}

function action(type) {
    const value = {
        type,
        nodeId: 'node-1',
        bindings: {
            runId: 'run-1',
            repository: 'ExampleOrg/RepositoryA',
            baseSha: SHA,
            issueNumber: 1,
            epochId: 'epoch-1'
        }
    }
    value.actionDigest = digest(value)
    return value
}

function actionSet(actionValue) {
    return {
        schema: 'issue-orchestration.lifecycle-action-set.v1',
        actions: [structuredClone(actionValue)]
    }
}

function runtimeFor(actionValue, stage, extra = {}) {
    return {
        stageRole: stage.actorRole,
        stagePhase: stage.stagePhase,
        executionClass: 'observe-only',
        freshInvocation: true,
        inheritedThreadId: null,
        actorInvocationId: `${stage.actorRole}-invocation`,
        actorSessionId: `${stage.actorRole}-session`,
        effectiveProfile: 'terra-high',
        effectiveModel: 'gpt-5.6-terra',
        effectiveEffort: 'high',
        effectiveBackend: 'codex-v2',
        effectivePermissionProfile: 'read-only',
        executionObservationDigest: h(`${stage.stagePhase}-runtime`),
        actionDigest: actionValue.actionDigest,
        ...extra
    }
}

function harness({ output, runtimeExtra, mutate = false } = {}) {
    const calls = []
    return {
        calls,
        compileRoute({ action: actionValue, stage }) {
            calls.push('route')
            return {
                stageRole: stage.actorRole,
                stagePhase: stage.stagePhase,
                routeDecisionDigest: h(`${stage.stagePhase}-route`),
                actionDigest: actionValue.actionDigest,
                observeOnly: true,
                writeLeaseId: null
            }
        },
        actorAdapter: {
            prepare({ stage }) {
                calls.push('prepare')
                return {
                    attemptId: `attempt-${stage.stagePhase}`,
                    candidateVisible: true,
                    writerConversationInherited: false,
                    writeLeaseAcquired: false
                }
            },
            invoke({ projection }) {
                calls.push('invoke')
                assert.equal(projection.fullIssueIncluded, false)
                assert.equal(projection.fullDagIncluded, false)
                assert.equal(projection.stateRootIncluded, false)
                return structuredClone(output)
            }
        },
        observeRuntime({ action: actionValue, stage }) {
            calls.push('runtime')
            return runtimeFor(actionValue, stage, runtimeExtra)
        },
        snapshot({ action: actionValue, runtime, snapshotKind }) {
            calls.push(snapshotKind)
            return {
                snapshotKind,
                actionDigest: actionValue.actionDigest,
                actorInvocationId: runtime.actorInvocationId,
                snapshotDigest: h(`${snapshotKind}-${actionValue.actionDigest}`)
            }
        },
        evaluateMutation({ action: actionValue, runtime, preSnapshot, postSnapshot }) {
            calls.push('mutation')
            return {
                status: mutate ? 'failed' : 'verified',
                violations: mutate ? ['tracked-change'] : [],
                preSnapshotDigest: preSnapshot.snapshotDigest,
                postSnapshotDigest: postSnapshot.snapshotDigest,
                actorInvocationId: runtime.actorInvocationId,
                actionDigest: actionValue.actionDigest,
                observationDigest: h(`mutation-${actionValue.actionDigest}`)
            }
        }
    }
}

function behaviorOutput(actionValue) {
    return {
        actorRole: 'test-owner',
        stagePhase: 'behavior-verification',
        actionDigest: actionValue.actionDigest,
        rootAuthored: false,
        writerAuthored: false,
        behaviorEvidence: {
            candidateSha: CANDIDATE_SHA,
            commandEvidenceDigest: h('behavior-command'),
            frozenTestContractDigest: h('frozen-test-contract'),
            verifierInvocationId: 'test-owner-invocation',
            freshContext: true,
            independent: true
        }
    }
}

function uiOutput(actionValue, nodeValue) {
    return {
        actorRole: 'ui-system-adjudicator',
        stagePhase: 'adjudication',
        actionDigest: actionValue.actionDigest,
        rootAuthored: false,
        writerAuthored: false,
        uiAdjudication: {
            adjudication: 'bounded-ui-contract-confirmed',
            candidateDigest: nodeValue.receipts.candidate.receiptDigest,
            acceptanceContractDigest:
                nodeValue.receipts.acceptanceContract.contractDigest,
            scopeEdited: false,
            acceptanceEdited: false,
            routingEdited: false
        }
    }
}

function uxOutput(actionValue, nodeValue) {
    return {
        actorRole: 'ux-acceptance-verifier',
        stagePhase: 'ux-acceptance',
        actionDigest: actionValue.actionDigest,
        rootAuthored: false,
        writerAuthored: false,
        renderEvidence: {
            screenshotSetDigest: h('screenshots'),
            viewports: ['desktop', 'mobile']
        },
        interactionEvidence: {
            traceDigest: h('interactions'),
            assertionCount: 3
        },
        accessibilityEvidence: {
            auditDigest: h('a11y'),
            violations: []
        },
        uxAcceptance: {
            status: 'accepted',
            candidateSha: CANDIDATE_SHA,
            uiAdjudicationDigest:
                nodeValue.receipts.uiAdjudication.receiptDigest
        }
    }
}

async function execute(actionValue, nodeValue, output, overrides = {}) {
    const harn = harness({ output, ...overrides })
    const result = await executeLifecycleObserveOnlyAction({
        action: actionValue,
        actionSet: actionSet(actionValue),
        node: nodeValue,
        ...harn
    })
    return { ...result, calls: harn.calls }
}

function assertCode(fn, code) {
    assert.throws(fn, (error) =>
        error instanceof LifecycleObserveOnlyExecutorError &&
        error.code === code)
}

await test('observe-only executor exposes exactly the three independent actions', () => {
    assert.deepEqual([...LIFECYCLE_OBSERVE_ONLY_SUPPORTED_ACTIONS].sort(), [
        'dispatch-behavior-verifier',
        'dispatch-ux-acceptance-verifier',
        'request-ui-adjudication'
    ])
})

await test('unsupported action is rejected before any side effects', async () => {
    const actionValue = action('dispatch-implementation-writer')
    const harn = harness({ output: {} })
    await assert.rejects(
        executeLifecycleObserveOnlyAction({
            action: actionValue,
            actionSet: actionSet(actionValue),
            node: node(),
            ...harn
        }),
        (error) => error.code === 'observe-only-action-unsupported'
    )
    assert.deepEqual(harn.calls, [])
})

await test('fresh behavior verifier produces a stage-admissible result', async () => {
    const actionValue = action('dispatch-behavior-verifier')
    const nodeValue = node()
    const executed = await execute(
        actionValue,
        nodeValue,
        behaviorOutput(actionValue)
    )
    assert.deepEqual(executed.calls, [
        'route', 'prepare', 'runtime', 'pre', 'invoke', 'post', 'mutation'
    ])
    assert.equal(executed.admission.contractId, 'behavior-verification')
    assert.equal(executed.result.actorRole, 'test-owner')
    assert.equal(
        validateLifecycleStageResult({
            result: executed.result,
            action: actionValue,
            node: nodeValue
        }).contractId,
        'behavior-verification'
    )
})

await test('inherited verifier context is rejected even with valid output', async () => {
    const actionValue = action('dispatch-behavior-verifier')
    await assert.rejects(
        execute(
            actionValue,
            node(),
            behaviorOutput(actionValue),
            { runtimeExtra: { inheritedThreadId: 'writer-thread' } }
        ),
        (error) => error.code === 'observe-only-runtime-not-independent'
    )
})

await test('writer-authored behavior receipt is rejected', async () => {
    const actionValue = action('dispatch-behavior-verifier')
    const output = behaviorOutput(actionValue)
    output.writerAuthored = true
    await assert.rejects(
        execute(actionValue, node(), output),
        (error) => error.code === 'observe-only-actor-authority-invalid'
    )
})

await test('freshness flags alone cannot replace behavior command evidence', async () => {
    const actionValue = action('dispatch-behavior-verifier')
    const output = behaviorOutput(actionValue)
    delete output.behaviorEvidence.commandEvidenceDigest
    await assert.rejects(
        execute(actionValue, node(), output),
        (error) => error.code === 'observe-only-behavior-command-required'
    )
})

await test('candidate drift invalidates behavior verification', async () => {
    const actionValue = action('dispatch-behavior-verifier')
    const output = behaviorOutput(actionValue)
    output.behaviorEvidence.candidateSha = SHA
    await assert.rejects(
        execute(actionValue, node(), output),
        (error) => error.code === 'observe-only-behavior-binding-invalid'
    )
})

await test('protected mutation invalidates every observe-only result', async () => {
    const actionValue = action('dispatch-behavior-verifier')
    await assert.rejects(
        execute(
            actionValue,
            node(),
            behaviorOutput(actionValue),
            { mutate: true }
        ),
        (error) => error.code === 'observe-only-mutation-detected'
    )
})

await test('UI adjudication accepts only the frozen vocabulary and no edits', async () => {
    const actionValue = action('request-ui-adjudication')
    const nodeValue = node({ ui: true })
    const executed = await execute(
        actionValue,
        nodeValue,
        uiOutput(actionValue, nodeValue)
    )
    assert.equal(executed.admission.contractId, 'ui-adjudication')
    const bad = uiOutput(actionValue, nodeValue)
    bad.uiAdjudication.adjudication = 'looks-good-to-me'
    await assert.rejects(
        execute(actionValue, nodeValue, bad),
        (error) => error.code === 'observe-only-ui-adjudication-vocabulary'
    )
})

await test('UX acceptance requires render, interaction and accessibility evidence', async () => {
    const actionValue = action('dispatch-ux-acceptance-verifier')
    const nodeValue = node({ ui: true })
    const executed = await execute(
        actionValue,
        nodeValue,
        uxOutput(actionValue, nodeValue)
    )
    assert.equal(executed.admission.contractId, 'ux-acceptance')
    const bad = uxOutput(actionValue, nodeValue)
    bad.renderEvidence = 'observed'
    await assert.rejects(
        execute(actionValue, nodeValue, bad),
        (error) => error.code === 'observe-only-ux-render-required'
    )
})
