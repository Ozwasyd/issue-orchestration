import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    lifecycleStageContractForAction,
    validateLifecycleStageResult
} from '../../skills/issue-orchestration/scripts/lifecycle-stage-admission.mjs'
import {
    recordLifecycleActionResults
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    digest,
    unsignedDigest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    evaluateWriterStageObservation
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    compileScriptedLifecycleStageResult
} from './issue-orchestration/scripted-lifecycle-stage-result.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const HASH = digest('fixture')
const SHA = HASH.slice(0, 40)

function clone(value) {
    return structuredClone(value)
}

function node({
    id = 'Fixture/Repo#1',
    uiClass = 'non-ui',
    receipts = {},
    implementationAttempts = 0
} = {}) {
    return {
        id,
        memberId: id,
        repository: id.split('#')[0],
        issueNumber: Number(id.split('#')[1]),
        uiClass,
        riskClass: 'normal',
        lifecycleState: 'none',
        receipts: clone(receipts),
        implementationAttempts,
        deliveryCommit: null,
        closedAtSequence: null
    }
}

function memberBindings(target) {
    const firstFailure = {
        classification: 'externally_blocked',
        evidenceRef: 'evidence://fixture-terminal',
        signature: 'fixture-terminal-signature'
    }
    return {
        runId: 'fixture-run',
        nodeId: target.id,
        memberId: target.id,
        repository: target.repository,
        issueNumber: target.issueNumber,
        baseSha: SHA,
        nodeEpoch: 1,
        selectorReceiptDigest: HASH,
        remoteSnapshotDigest: HASH,
        semanticGraphDigest: HASH,
        aggregateProjectionDigest: HASH,
        nodeProjectionDigest: HASH,
        priorLedgerHeadDigest: HASH,
        policyDigest: HASH,
        policySetDigest: HASH,
        runtimeCapabilityBindingDigest: HASH,
        lifecycleAuthorityBindingDigest: HASH,
        startupAttestationDigest: HASH,
        runtimeInvocationId: 'fixture-runtime-invocation',
        runtimeSessionId: 'fixture-runtime-session',
        rootAuthorityEpoch: 1,
        runtimeTrustBindingDigest: HASH,
        repositoryIdentitySetDigest: HASH,
        repositoryBindingSetDigest: HASH,
        repositoryBindingDigest: HASH,
        packageDigest: HASH,
        manifestDigest: HASH,
        firstFailure,
        recoveryState: {
            expectedNextSliceId: null,
            expectedNextSliceDigest: null,
            latestContinuationReceiptDigest: null,
            writerStageRetryAuthorizationDigest: null,
            reworkCount: 0
        },
        quarantine: null,
        terminalCandidate: null,
        receiptDigests: {}
    }
}

function action(type, target, {
    acceptanceGroup = null,
    lifecycleState = 'none',
    memberNodes = null
} = {}) {
    const bindings = type === 'deliver-acceptance-group'
        ? {
            runId: 'fixture-run',
            selectorReceiptDigest: HASH,
            remoteSnapshotDigest: HASH,
            semanticGraphDigest: HASH,
            aggregateProjectionDigest: HASH,
            policyDigest: HASH,
            runtimeCapabilityBindingDigest: HASH,
            memberBindings: (memberNodes ?? [target]).map(memberBindings)
        }
        : memberBindings(target)
    const value = {
        schema: 'issue-orchestration.lifecycle-action.v1',
        type,
        nodeId: type === 'deliver-acceptance-group'
            ? null
            : target.id,
        acceptanceGroup,
        lifecycleState,
        recoveryMode: 'none',
        bindings
    }
    value.actionDigest = digest(value)
    return value
}

function mergeResult(target, result) {
    target.receipts = {
        ...target.receipts,
        ...clone(result.artifacts)
    }
    if (result.actionType === 'compile-acceptance-contract') {
        target.receipts.documentationRequired =
            result.artifacts.documentationRequirement.evidence.required
    }
    if (result.artifacts.implementationTerminal ||
        result.artifacts.writerFailure) {
        target.implementationAttempts += 1
    }
    return target
}

function terminalFailureEvidence({
    action: currentAction,
    target,
    actorRole,
    attemptId
}) {
    const stagePhase = {
        'dispatch-test-contract-writer': 'test-contract',
        'dispatch-implementation-writer': target.uiClass === 'ui'
            ? 'ui-implementation'
            : 'implementation',
        'dispatch-documentation-writer': 'documentation'
    }[currentAction.type]
    const planDigest = digest({
        actionDigest: currentAction.actionDigest,
        stagePhase,
        kind: 'terminal-plan'
    })
    const sliceDigest = digest({
        actionDigest: currentAction.actionDigest,
        stagePhase,
        kind: 'terminal-slice'
    })
    const promptDigest = digest({
        actionDigest: currentAction.actionDigest,
        stagePhase,
        kind: 'terminal-prompt'
    })
    const routeDigest = digest({
        actionDigest: currentAction.actionDigest,
        stagePhase,
        kind: 'terminal-route'
    })
    const observation = {
        schema: 'issue-orchestration.writer-stage-observation.v1',
        runId: currentAction.bindings.runId,
        repository: currentAction.bindings.repository,
        issue: currentAction.bindings.issueNumber,
        node: currentAction.nodeId,
        baseSha: currentAction.bindings.baseSha,
        epochId: String(currentAction.bindings.nodeEpoch),
        worktreeIdentity: `fixture-worktree:${currentAction.nodeId}`,
        sliceId: 'slice-1',
        sliceDigest,
        planDigest,
        compiledPromptDigest: promptDigest,
        routeDigest,
        stageRole: actorRole,
        stagePhase,
        attemptId,
        agentId: `${attemptId}:actor`,
        firstRequiredActionExecuted: false,
        plan: null,
        currentSlice: null,
        checkpoint: null,
        sliceTerminalReceipts: [],
        invocationObservation: { started: false },
        environmentObservation: null,
        runtimeCapabilityObservation: null,
        filesystemObservation: null,
        gitObservation: null,
        commandObservation: null,
        renderEvidence: null,
        verifiedNoChangeEvidence: null,
        conflictMapping: null,
        terminalReceipt: null,
        priorFailureReceipt: null
    }
    const evaluated = evaluateWriterStageObservation(observation)
    return {
        family: 'writer-stage-failure',
        eventType: evaluated.eventType,
        actorId: observation.agentId,
        stageWorkPlan: {
            stageRole: actorRole,
            stagePhase,
            planDigest
        },
        currentSlice: { sliceDigest },
        compiledPrompt: { promptDigest },
        currentCheckpoint: null,
        writerStageObservation: observation,
        failureReceipt: evaluated.failureReceipt,
        runtimeObservationDigest: digest({
            invocationObservation: observation.invocationObservation,
            environmentObservation: null,
            runtimeCapabilityObservation: null
        }),
        watchdogReceiptDigest: null
    }
}

function result({
    type,
    target,
    actorRole,
    mode = 'completed',
    facts = {},
    acceptanceGroup = null,
    memberNodes = null
}) {
    const currentAction = action(type, target, {
        acceptanceGroup,
        memberNodes
    })
    const scriptedFacts = clone(facts)
    if (mode === 'terminal-failure' &&
        !scriptedFacts.executorFailureEvidence) {
        const attemptId = scriptedFacts.attemptId ?? `${type}:${currentAction.nodeId}:attempt:${
            (target?.implementationAttempts ?? 0) + 1}`
        scriptedFacts.attemptId = attemptId
        scriptedFacts.executorFailureEvidence = terminalFailureEvidence({
            action: currentAction,
            target,
            actorRole,
            attemptId
        })
    }
    return {
        action: currentAction,
        result: compileScriptedLifecycleStageResult({
            action: currentAction,
            node: type === 'deliver-acceptance-group'
                ? null
                : target,
            actorRole,
            mode,
            facts: scriptedFacts
        })
    }
}

function resealArtifact(stageResult, artifactKind, mutate) {
    const next = clone(stageResult)
    const contract = lifecycleStageContractForAction({
        actionType: next.actionType,
        artifactKeys: Object.keys(next.artifacts)
    })
    const artifact = next.artifacts[artifactKind]
    mutate(artifact)
    artifact.evidenceDigest = digest(artifact.evidence)
    const field = contract.artifactSet[artifactKind].digestField
    artifact[field] = unsignedDigest(artifact, field)
    next.artifactsDigest = digest(next.artifacts)
    next.resultDigest = unsignedDigest(next, 'resultDigest')
    return next
}

function accepted(pair, target = null) {
    return validateLifecycleStageResult({
        result: pair.result,
        action: pair.action,
        node: target
    })
}

function acceptedContractFixtures() {
    const main = node()
    const ui = node({ id: 'Fixture/Repo#2', uiClass: 'ui' })
    const fixtures = []
    const add = (pair, target = null, { merge = false } = {}) => {
        const admission = accepted(pair, target)
        fixtures.push({
            pair,
            target: target ? clone(target) : null,
            contractId: admission.contractId
        })
        if (merge && target) mergeResult(target, pair.result)
    }

    let pair = result({
        type: 'request-semantic-proposal',
        target: main,
        actorRole: 'dag-creator-updater'
    })
    add(pair, main, { merge: true })

    pair = result({
        type: 'compile-acceptance-contract',
        target: main,
        actorRole: 'acceptance-contract-compiler'
    })
    add(pair, main, { merge: true })

    pair = result({
        type: 'request-test-contract-planning',
        target: main,
        actorRole: 'test-owner'
    })
    add(pair, main, { merge: true })

    const testContractFailureNode = clone(main)
    pair = result({
        type: 'dispatch-test-contract-writer',
        target: testContractFailureNode,
        actorRole: 'test-owner',
        mode: 'terminal-failure'
    })
    add(pair, testContractFailureNode)

    pair = result({
        type: 'dispatch-test-contract-writer',
        target: main,
        actorRole: 'test-owner'
    })
    add(pair, main, { merge: true })

    const implementationFailureNode = clone(main)
    pair = result({
        type: 'dispatch-implementation-writer',
        target: implementationFailureNode,
        actorRole: 'code-implementer',
        mode: 'terminal-failure'
    })
    add(pair, implementationFailureNode)

    pair = result({
        type: 'dispatch-implementation-writer',
        target: main,
        actorRole: 'code-implementer',
        mode: 'recoverable-failure'
    })
    add(pair, main)

    pair = result({
        type: 'dispatch-implementation-writer',
        target: main,
        actorRole: 'code-implementer'
    })
    add(pair, main, { merge: true })

    const behaviorRejectionNode = clone(main)
    pair = result({
        type: 'dispatch-behavior-verifier',
        target: behaviorRejectionNode,
        actorRole: 'test-owner',
        mode: 'rejected'
    })
    add(pair, behaviorRejectionNode)

    pair = result({
        type: 'dispatch-behavior-verifier',
        target: main,
        actorRole: 'test-owner'
    })
    add(pair, main, { merge: true })

    const documentationFailureNode = clone(main)
    pair = result({
        type: 'dispatch-documentation-writer',
        target: documentationFailureNode,
        actorRole: 'documentation-writer',
        mode: 'terminal-failure'
    })
    add(pair, documentationFailureNode)

    pair = result({
        type: 'dispatch-documentation-writer',
        target: main,
        actorRole: 'documentation-writer',
        facts: { mode: 'no-change' }
    })
    add(pair, main, { merge: true })

    ui.receipts = clone(main.receipts)
    pair = result({
        type: 'request-ui-adjudication',
        target: ui,
        actorRole: 'ui-system-adjudicator'
    })
    add(pair, ui, { merge: true })

    pair = result({
        type: 'dispatch-ux-acceptance-verifier',
        target: ui,
        actorRole: 'ux-acceptance-verifier'
    })
    add(pair, ui, { merge: true })

    pair = result({
        type: 'dispatch-documentation-writer',
        target: ui,
        actorRole: 'documentation-writer',
        facts: { mode: 'changed' }
    })
    add(pair, ui, { merge: true })

    const effect = {
        effectId: 'fixture-effect',
        commits: {
            [main.id]: SHA,
            [ui.id]: digest('ui-commit').slice(0, 40)
        }
    }
    pair = result({
        type: 'deliver-acceptance-group',
        target: main,
        actorRole: 'root-delivery-adapter',
        mode: 'remote-effect-applied',
        facts: effect,
        acceptanceGroup: 'fixture-group',
        memberNodes: [main, ui]
    })
    add(pair)

    pair = result({
        type: 'deliver-acceptance-group',
        target: main,
        actorRole: 'root-delivery-adapter',
        mode: 'completed',
        facts: effect,
        acceptanceGroup: 'fixture-group',
        memberNodes: [main, ui]
    })
    add(pair)
    mergeResult(main, pair.result)

    pair = result({
        type: 'cleanup-node-resources',
        target: main,
        actorRole: 'root-cleanup-adapter'
    })
    add(pair, main)

    const terminalNode = node({ id: 'Fixture/Repo#3' })
    pair = result({
        type: 'terminalize-node',
        target: terminalNode,
        actorRole: 'root-scheduler'
    })
    add(pair, terminalNode)

    return fixtures
}

test('admission map is exhaustive and binds every artifact to one validator', () => {
    const actionTypes = [...new Set(Object.values(
        LIFECYCLE_STAGE_ADMISSION_MAP
    ).map(({ actionType }) => actionType))].sort()
    assert.deepEqual(actionTypes, [
        'cleanup-node-resources',
        'compile-acceptance-contract',
        'deliver-acceptance-group',
        'dispatch-behavior-verifier',
        'dispatch-documentation-writer',
        'dispatch-implementation-writer',
        'dispatch-test-contract-writer',
        'dispatch-ux-acceptance-verifier',
        'request-semantic-proposal',
        'request-test-contract-planning',
        'request-ui-adjudication',
        'terminalize-node'
    ])
    const productionSource = fs.readdirSync(path.resolve(
        root,
        'skills/issue-orchestration/scripts'
    )).filter((name) => name.endsWith('.mjs')).map((name) =>
        fs.readFileSync(path.resolve(
            root,
            'skills/issue-orchestration/scripts',
            name
        ), 'utf8')).join('\n')
    for (const [contractId, contract] of Object.entries(
        LIFECYCLE_STAGE_ADMISSION_MAP
    )) {
        assert.ok(contract.executorAuthority)
        assert.ok(contract.actorRoles.length > 0)
        assert.ok(Object.keys(contract.artifactSet).length > 0)
        for (const [artifactKind, artifact] of Object.entries(
            contract.artifactSet
        )) {
            assert.ok(artifact.schema, `${contractId}:${artifactKind}`)
            assert.ok(artifact.validator, `${contractId}:${artifactKind}`)
            const escapedValidator = artifact.validator.replace(
                /[.*+?^${}()|[\]\\]/gu,
                '\\$&'
            )
            assert.match(
                productionSource,
                new RegExp(
                    `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${escapedValidator}\\b|export\\s*\\{[^}]*\\b${escapedValidator}\\b`,
                    'su'
                ),
                `${contractId}:${artifactKind}:${artifact.validator}`
            )
            assert.ok(
                artifact.producerAuthority,
                `${contractId}:${artifactKind}`
            )
            assert.ok(artifact.digestField)
        }
    }
})

test('every action contract accepts one exact stage-specific artifact set', () => {
    const fixtures = acceptedContractFixtures()
    assert.equal(fixtures.length, 19)
    assert.deepEqual(
        [...new Set(fixtures.map(({ contractId }) => contractId))].sort(),
        Object.keys(LIFECYCLE_STAGE_ADMISSION_MAP).sort()
    )
})

test('resealing a modified artifact fails for every action contract', () => {
    const changedHash = digest('forged-artifact-value')
    const changedSha = changedHash.slice(0, 40)
    const mutations = {
        'semantic-proposal': ['semanticProposalValidation', (artifact) => {
            artifact.evidence.proposalDigest = changedHash
        }],
        'acceptance-contract': ['acceptanceContract', (artifact) => {
            artifact.evidence.requirementInventoryDigest = changedHash
        }],
        'test-contract-planning': ['compiledPrompt', (artifact) => {
            artifact.evidence.routeDecisionDigest = changedHash
        }],
        'test-contract-writer': ['testContractWriter', (artifact) => {
            artifact.evidence.checkpointVerificationDigest = changedHash
        }],
        'test-contract-terminal-failure': ['executorFailure', (artifact) => {
            artifact.evidence.runtimeObservationDigest = changedHash
        }],
        'implementation-terminal-failure': ['executorFailure', (artifact) => {
            artifact.evidence.runtimeObservationDigest = changedHash
        }],
        'documentation-terminal-failure': ['executorFailure', (artifact) => {
            artifact.evidence.runtimeObservationDigest = changedHash
        }],
        'implementation-retry': ['retryAuthorization', (artifact) => {
            artifact.evidence.writerFailureDigest = changedHash
        }],
        'implementation-candidate': ['candidate', (artifact) => {
            artifact.evidence.candidateSha = changedSha
        }],
        'behavior-rejection': ['verificationRejection', (artifact) => {
            artifact.evidence.candidateSha = changedSha
        }],
        'behavior-verification': ['behaviorVerification', (artifact) => {
            artifact.evidence.behaviorReceiptDigest = changedHash
        }],
        'documentation-no-change': ['documentationNoChange', (artifact) => {
            artifact.evidence.documentationReceiptDigest = changedHash
        }],
        'ui-adjudication': ['uiAdjudication', (artifact) => {
            artifact.evidence.candidateDigest = changedHash
        }],
        'ux-acceptance': ['uxAcceptance', (artifact) => {
            artifact.evidence.renderEvidenceDigest = changedHash
        }],
        'documentation-change': ['documentation', (artifact) => {
            artifact.evidence.mode = 'no-change'
        }],
        'delivery-remote-effect': ['remoteMutationAuthority', (artifact) => {
            artifact.evidence.deliveryControlReceiptDigest = changedHash
        }],
        'delivery-completed': ['delivery', (artifact) => {
            artifact.evidence.remoteEffectDigest = changedHash
        }],
        'cleanup-and-closure': ['closure', (artifact) => {
            artifact.evidence.cleanupReceiptDigest = changedHash
        }],
        terminalization: ['recoveryFingerprint', (artifact) => {
            artifact.evidence.terminalReceiptDigest = changedHash
        }]
    }
    const fixtures = acceptedContractFixtures()
    assert.deepEqual(
        Object.keys(mutations).sort(),
        Object.keys(LIFECYCLE_STAGE_ADMISSION_MAP).sort()
    )
    for (const { pair, target, contractId } of fixtures) {
        const [artifactKind, mutate] = mutations[contractId]
        const forged = resealArtifact(pair.result, artifactKind, mutate)
        assert.throws(
            () => validateLifecycleStageResult({
                result: forged,
                action: pair.action,
                node: target
            }),
            ({ code }) => typeof code === 'string' &&
                code.startsWith('lifecycle-'),
            contractId
        )
    }
})

test('generic actor results are rejected before ledger authority is read', () => {
    assert.throws(
        () => recordLifecycleActionResults({
            ledger: null,
            actionSet: null,
            actorResults: [{
                schema: 'issue-orchestration.lifecycle-actor-result.v1',
                outcome: 'completed',
                decision: { independent: true }
            }]
        }),
        ({ code }) => code ===
            'lifecycle-generic-actor-results-forbidden'
    )
})

test('implementers cannot author behavior authority', () => {
    const target = node()
    const implementation = result({
        type: 'dispatch-implementation-writer',
        target,
        actorRole: 'code-implementer'
    })
    mergeResult(target, implementation.result)
    const behavior = result({
        type: 'dispatch-behavior-verifier',
        target,
        actorRole: 'test-owner'
    })
    const forged = clone(behavior.result)
    forged.actorRole = 'code-implementer'
    forged.resultDigest = unsignedDigest(forged, 'resultDigest')
    assert.throws(
        () => validateLifecycleStageResult({
            result: forged,
            action: behavior.action,
            node: target
        }),
        ({ code }) => code === 'lifecycle-stage-artifact-set-invalid'
    )
})

test('boolean freshness and prose render claims are not verification evidence', () => {
    const target = node({ uiClass: 'ui' })
    const implementation = result({
        type: 'dispatch-implementation-writer',
        target,
        actorRole: 'ui-ux-implementer'
    })
    mergeResult(target, implementation.result)

    const behaviorAction = action(
        'dispatch-behavior-verifier',
        target
    )
    const fakeBehavior = {
        schema: 'issue-orchestration.lifecycle-stage-result.v1',
        producerAuthority: 'observe-only-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: behaviorAction.actionDigest,
        actionType: behaviorAction.type,
        nodeId: target.id,
        actorRole: 'test-owner',
        attemptId: 'fake-attempt',
        artifacts: {
            behavior: {
                independent: true,
                freshContext: true
            }
        }
    }
    fakeBehavior.artifactsDigest = digest(fakeBehavior.artifacts)
    fakeBehavior.resultDigest = digest(fakeBehavior)
    assert.throws(
        () => validateLifecycleStageResult({
            result: fakeBehavior,
            action: behaviorAction,
            node: target
        }),
        ({ code }) => code === 'lifecycle-stage-artifact-set-invalid'
    )

    const uiPair = result({
        type: 'request-ui-adjudication',
        target,
        actorRole: 'ui-system-adjudicator'
    })
    mergeResult(target, uiPair.result)
    const uxPair = result({
        type: 'dispatch-ux-acceptance-verifier',
        target,
        actorRole: 'ux-acceptance-verifier'
    })
    const proseOnly = resealArtifact(
        uxPair.result,
        'renderEvidence',
        (artifact) => {
            artifact.evidence = { renderEvidence: 'observed' }
        }
    )
    assert.throws(
        () => validateLifecycleStageResult({
            result: proseOnly,
            action: uxPair.action,
            node: target
        }),
        ({ code }) => code ===
            'lifecycle-ux-screenshot-evidence-required'
    )
})

test('zero-count cleanup and delivery without remote snapshots fail closed', () => {
    const target = node()
    const cleanupAction = action('cleanup-node-resources', target)
    const fakeCleanup = {
        schema: 'issue-orchestration.lifecycle-stage-result.v1',
        producerAuthority: 'cleanup-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: cleanupAction.actionDigest,
        actionType: cleanupAction.type,
        nodeId: target.id,
        actorRole: 'root-cleanup-adapter',
        attemptId: null,
        artifacts: { cleanup: { residueCount: 0 } }
    }
    fakeCleanup.artifactsDigest = digest(fakeCleanup.artifacts)
    fakeCleanup.resultDigest = digest(fakeCleanup)
    assert.throws(
        () => validateLifecycleStageResult({
            result: fakeCleanup,
            action: cleanupAction,
            node: target
        }),
        ({ code }) => code === 'lifecycle-stage-artifact-set-invalid'
    )

    const delivery = result({
        type: 'deliver-acceptance-group',
        target,
        actorRole: 'root-delivery-adapter',
        mode: 'completed',
        facts: {
            effectId: 'effect',
            commits: { [target.id]: SHA }
        },
        acceptanceGroup: 'group'
    })
    const missingSnapshot = clone(delivery.result)
    delete missingSnapshot.artifacts.remotePostSnapshot
    missingSnapshot.artifactsDigest = digest(missingSnapshot.artifacts)
    missingSnapshot.resultDigest = unsignedDigest(
        missingSnapshot,
        'resultDigest'
    )
    assert.throws(
        () => validateLifecycleStageResult({
            result: missingSnapshot,
            action: delivery.action
        }),
        ({ code }) => code === 'lifecycle-stage-artifact-set-invalid'
    )
})

test('production lifecycle sources contain no generic result compiler or test helper import', () => {
    const productionFiles = [
        'skills/issue-orchestration/scripts/lifecycle-run-loop.mjs',
        'skills/issue-orchestration/scripts/event-ledger.mjs',
        'skills/issue-orchestration/scripts/lifecycle-stage-admission.mjs'
    ]
    const source = productionFiles.map((relative) =>
        fs.readFileSync(path.resolve(root, relative), 'utf8')).join('\n')
    assert.doesNotMatch(source, /compileLifecycleActorResult/u)
    assert.doesNotMatch(
        source,
        /tests\/tools\/issue-orchestration\/scripted-lifecycle-stage-result/u
    )
    const runLoop = fs.readFileSync(path.resolve(
        root,
        'skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
    ), 'utf8')
    assert.doesNotMatch(runLoop, /decisionDigest|result\.decision|result\.outcome/u)
})
