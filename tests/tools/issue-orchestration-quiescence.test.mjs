import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    validateJsonSchema
} from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = resolve(import.meta.dirname, '../..')
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const packageScripts =
    'skills/issue-orchestration/scripts'
const implementationRelative = `${packageScripts}/quiescence.mjs`
const implementationPath = resolve(root, implementationRelative)
const receiptSchemaPath = resolve(
    root,
    'contracts/quiescence-receipt.schema.json'
)
const readJson = (name) =>
    JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
const baseObservation = readJson('quiescence-observation-quiescent.json')
const mutationControls = readJson('quiescence-mutation-controls.json')
const HASH = /^[a-f0-9]{64}$/u

let implementationPromise
async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1829 canonical quiescence owner: ${implementationRelative}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of [
        'computeQuiescenceDigest',
        'evaluateQuiescence',
        'verifyQuiescenceReceipt'
    ]) {
        assert.equal(typeof loaded[name], 'function', `missing export ${name}`)
    }
    assert.equal(
        loaded.QUIESCENCE_RECEIPT_SCHEMA,
        'issue-orchestration.quiescence-receipt.v1'
    )
    return loaded
}

function clone(value) {
    return structuredClone(value)
}

async function cleanupReceipt({
    runId = baseObservation.runId,
    attemptId = 'attempt-1829-1',
    epochId = 'epoch-1829-1'
} = {}) {
    const { computeQuiescenceDigest } = await implementation()
    const receipt = {
        schema: 'issue-orchestration.resource-cleanup-receipt.v1',
        actorRole: 'machine-resource-verifier',
        status: 'resources-clean',
        runId,
        attemptId,
        epochId,
        baselineDigest: baseObservation.baseline.baselineDigest,
        ownedResourceDigest: '1414141414141414141414141414141414141414141414141414141414141414',
        cleanupActions: [],
        lockReleaseObservations: [],
        finalFilesystemObservations: [],
        retainedResources: [],
        quarantinedResources: [],
        failedResources: [],
        postInventory: [],
        postCleanupInventoryDigest: computeQuiescenceDigest([]),
        verifiedAt: baseObservation.verifiedAt
    }
    receipt.receiptDigest = computeQuiescenceDigest(receipt)
    return receipt
}

async function validObservation() {
    const observation = clone(baseObservation)
    const receipt = await cleanupReceipt()
    observation.inventories.attempts.records = [{
        attemptId: receipt.attemptId,
        issueTarget: 'Ozwasyd/FsusBlog#1829',
        runId: receipt.runId,
        epochId: receipt.epochId,
        status: 'completed',
        active: false,
        terminalEventDigest:
            '1515151515151515151515151515151515151515151515151515151515151515',
        cleanupReceiptDigest: receipt.receiptDigest,
        cleanupReceipt: receipt
    }]
    observation.inventories.stages.records[0].resourceCleanupReceiptDigest =
        receipt.receiptDigest
    return observation
}

function violationCodes(receipt) {
    return new Set(receipt.violations.map(({ code }) => code))
}

function expectedBindings(observation, receipt, overrides = {}) {
    return {
        schema: 'issue-orchestration.quiescence-expected-bindings.v1',
        runId: observation.runId,
        targetIssueSet: clone(observation.targetIssueSet),
        baselineDigest: receipt.baselineDigest,
        allowedRetentionDigest: receipt.allowedRetentionDigest,
        gitInventoryDigest: receipt.gitInventoryDigest,
        remoteLiveSnapshotDigest: receipt.remoteLiveSnapshotDigest,
        verifierIdentityDigest: receipt.verifierIdentityDigest,
        packageDigest: receipt.verifier.packageDigest,
        currentObservationDigest: receipt.observationDigest,
        dependencyReceiptDigests: clone(receipt.dependencyReceiptDigests),
        maxObservationAgeMs: 0,
        ...overrides
    }
}

function assertQuiescenceError(operation, code) {
    assert.throws(
        operation,
        (error) => error?.code === code,
        `expected quiescence error ${code}`
    )
}

function mutateObservation(observation, id) {
    const inventories = observation.inventories
    if (id === 'all-issues-closed-active-attempt') {
        inventories.attempts.records[0].active = true
        inventories.attempts.records[0].status = 'implementing'
    } else if (id === 'pseudo-terminal-attempt') {
        delete inventories.attempts.records[0].terminalEventDigest
    } else if (id === 'cleanup-receipt-binding-mismatch') {
        inventories.attempts.records[0].attemptId = 'attempt-1829-replayed'
    } else if (id === 'active-slice') {
        inventories.slices.summary.activeCount = 1
    } else if (id === 'pending-continuation') {
        inventories.continuations.summary.pendingCount = 1
    } else if (id === 'ownerless-checkpoint') {
        inventories.checkpoints.summary.ownerlessCount = 1
    } else if (id === 'open-output-missing-breaker') {
        inventories.outputMissingBreakers.summary.unresolvedCount = 1
    } else if (id === 'stale-route') {
        inventories.routes.summary.staleCount = 1
    } else if (id === 'capability-mismatch-pending') {
        inventories.profileCapabilities.summary.pendingMismatchCount = 1
    } else if (id === 'orphan-worktree') {
        inventories.git.summary.orphanWorktreeCount = 1
    } else if (id === 'retained-resource') {
        inventories.resources.summary.retainedCount = 1
    } else if (id === 'unknown-resource') {
        inventories.resources.summary.unknownCount = 1
    } else if (id === 'active-landing-lease') {
        inventories.landing.summary.activeLeaseCount = 1
    } else if (id === 'incomplete-commit-mapping') {
        inventories.commitMappings.summary.incompleteCount = 1
    } else if (id === 'unresolved-human-decision') {
        inventories.humanDecisions.summary.activeRequestCount = 1
    } else if (id === 'ownerless-human-retention') {
        inventories.humanRetentions.summary.ownerlessCount = 1
    } else if (id === 'owned-process-descendant') {
        inventories.processes.summary.descendantCount = 1
    } else if (id === 'stopped-container-not-removed') {
        inventories.docker.summary.containerCount = 1
    } else if (id === 'duplicate-repo-local-skill') {
        inventories.filesystem.summary.repoLocalDuplicateSkillCount = 1
    } else if (id === 'resident-dag-updater') {
        inventories.dag.summary.residentUpdaterCount = 1
    } else if (id === 'bootstrap-audit-only') {
        inventories.bootstrap.summary.disposition = 'audit-only'
    } else if (id === 'missing-inventory') {
        delete inventories.locks
    } else if (id === 'unavailable-inventory') {
        inventories.docker.availability = 'unavailable'
    } else if (id === 'root-self-sign') {
        observation.verifier.actorRole = 'root-scheduler'
        observation.verifier.rootScheduler = true
    } else {
        assert.fail(`unimplemented mutation fixture ${id}`)
    }
}

test('Q01 canonical package owns an executable observe-only quiescence contract', async () => {
    await implementation()
})

test('Q02 a complete verified inventory produces the recomputable v1 receipt', async () => {
    const loaded = await implementation()
    const observation = await validObservation()
    const receipt = loaded.evaluateQuiescence(observation)

    assert.equal(receipt.schema, 'issue-orchestration.quiescence-receipt.v1')
    assert.equal(receipt.status, 'quiescent')
    assert.deepEqual(receipt.violations, [])
    assert.deepEqual(receipt.targetIssueSet, ['Ozwasyd/FsusBlog#1829'])
    assert.equal(receipt.completedIssueEvidence.length, 1)
    assert.equal(receipt.bootstrapDisposition.status, 'retired')
    assert.equal(receipt.bootstrapDisposition.fallbackEnabled, false)

    for (const field of [
        'receiptDigest',
        'observationDigest',
        'sourceEvidenceDigest',
        'targetIssueSetDigest',
        'baselineDigest',
        'allowedRetentionDigest',
        'gitInventoryDigest',
        'attemptGroupInventoryDigest',
        'sliceWorkPlanInventoryDigest',
        'checkpointContinuationInventoryDigest',
        'outputMissingBreakerInventoryDigest',
        'executionRouteInventoryDigest',
        'profileCapabilityMismatchInventoryDigest',
        'lockLeaseSlotInventoryDigest',
        'filesystemInventoryDigest',
        'skillInstallDigest',
        'landingInventoryDigest',
        'sourceCandidateDispositionDigest',
        'commitMappingCompletenessDigest',
        'humanDecisionInventoryDigest',
        'humanRetentionDigest',
        'inventoryStateDigest'
    ]) assert.match(receipt[field], HASH, `invalid receipt digest ${field}`)

    assert.deepEqual(
        loaded.verifyQuiescenceReceipt({
            observation,
            receipt,
            expectedBindings: expectedBindings(observation, receipt),
            now: observation.verifiedAt
        }).status,
        'valid'
    )
    assert.deepEqual(
        loaded.evaluateQuiescence(clone(observation)),
        receipt,
        'fixed observation must replay to the identical receipt'
    )

    const receiptSchema = JSON.parse(readFileSync(receiptSchemaPath, 'utf8'))
    assert.equal(
        receiptSchema.title,
        'issue-orchestration.quiescence-receipt.v1'
    )
    assert.deepEqual(validateJsonSchema(receipt, receiptSchema), [])
    assert.deepEqual(
        [...receiptSchema.required].sort(),
        Object.keys(receipt).sort(),
        'runtime receipt and strict schema required fields must stay aligned'
    )
    assert.equal(receiptSchema.additionalProperties, false)
})

test('Q03 set enumeration is deterministic while ordered evidence remains bound', async () => {
    const loaded = await implementation()
    const first = await validObservation()
    first.inventories.actors.records = [{
        actorId: 'actor-b',
        actorRole: 'documentation-writer',
        status: 'completed',
        active: false
    }, {
        actorId: 'actor-a',
        actorRole: 'test-owner',
        status: 'completed',
        active: false
    }]
    const permuted = clone(first)
    permuted.inventories.actors.records.reverse()
    permuted.inventories.actors.sourceRefs.reverse()
    assert.deepEqual(
        loaded.evaluateQuiescence(first),
        loaded.evaluateQuiescence(permuted)
    )

    const freshObservation = clone(first)
    first.inventories.actors.observedAt = '2026-08-02T05:59:00.000Z'
    freshObservation.inventories.actors.observedAt =
        '2026-08-02T06:00:00.000Z'
    assert.equal(
        loaded.evaluateQuiescence(first).inventoryStateDigest,
        loaded.evaluateQuiescence(freshObservation).inventoryStateDigest,
        'sampling time is observation evidence, not machine state'
    )
    assert.notEqual(
        loaded.evaluateQuiescence(first).observationDigest,
        loaded.evaluateQuiescence(freshObservation).observationDigest,
        'fresh observations remain replay-bound'
    )

    first.inventories.checkpoints.records = [{
        checkpointId: 'checkpoint-1829-terminal',
        status: 'completed',
        active: false,
        ownerId: 'attempt-1829-1',
        cursor: 'terminal',
        nextAction: 'none-terminal',
        checkpointDigest:
            '1616161616161616161616161616161616161616161616161616161616161616',
        identityValid: true,
        activeReference: false,
        observedCommands: ['node --test first', 'node --test second']
    }]
    const reorderedEvidence = clone(first)
    reorderedEvidence.inventories.checkpoints.records[0]
        .observedCommands.reverse()
    assert.notEqual(
        loaded.evaluateQuiescence(first).checkpointContinuationInventoryDigest,
        loaded.evaluateQuiescence(reorderedEvidence)
            .checkpointContinuationInventoryDigest,
        'ordered command evidence must not be canonicalized as a set'
    )
})

test('Q04 every required residue mutation fails closed with a stable domain code', async () => {
    const loaded = await implementation()
    assert.equal(mutationControls.length, 24)
    for (const control of mutationControls) {
        const observation = await validObservation()
        mutateObservation(observation, control.id)
        const receipt = loaded.evaluateQuiescence(observation)
        assert.equal(receipt.status, 'not-quiescent', control.id)
        assert.equal(
            receipt.schema,
            'issue-orchestration.quiescence-gate-result.v1',
            control.id
        )
        assert.ok(
            violationCodes(receipt).has(control.expectedCode),
            `${control.id} expected ${control.expectedCode}; got ${
                [...violationCodes(receipt)].join(', ')
            }`
        )
    }

    const failedObservation = await validObservation()
    failedObservation.inventories.locks.summary.busyCount = 1
    const failedResult = loaded.evaluateQuiescence(failedObservation)
    assertQuiescenceError(
        () => loaded.verifyQuiescenceReceipt({
            observation: failedObservation,
            receipt: failedResult,
            expectedBindings: expectedBindings(
                failedObservation,
                failedResult
            ),
            now: failedObservation.verifiedAt
        }),
        'quiescence-receipt-not-quiescent'
    )
})

test('Q05 record evidence overrides false zero-count summaries', async () => {
    const loaded = await implementation()
    const cases = [
        {
            name: 'active',
            mutate: (record) => { record.active = true },
            code: 'resources.record-active'
        },
        {
            name: 'retained',
            mutate: (record) => { record.retained = true },
            code: 'resources.record-retained'
        },
        {
            name: 'unknown',
            mutate: (record) => { record.unknown = true },
            code: 'resources.record-unknown'
        },
        {
            name: 'missing terminal state',
            mutate: (record) => { delete record.status },
            code: 'resources.terminal-state-missing'
        }
    ]
    for (const item of cases) {
        const observation = await validObservation()
        const record = {
            resourceId: `resource-${item.name}`,
            status: 'released',
            terminalReceiptDigest:
                '1717171717171717171717171717171717171717171717171717171717171717'
        }
        item.mutate(record)
        observation.inventories.resources.records = [record]
        const receipt = loaded.evaluateQuiescence(observation)
        assert.equal(receipt.status, 'not-quiescent', item.name)
        assert.ok(violationCodes(receipt).has(item.code), item.name)
    }
})

test('Q06 terminal labels cannot hide missing terminal or cleanup evidence', async () => {
    const loaded = await implementation()
    const pseudoTerminal = await validObservation()
    delete pseudoTerminal.inventories.attempts.records[0].terminalEventDigest
    let receipt = loaded.evaluateQuiescence(pseudoTerminal)
    assert.ok(
        violationCodes(receipt).has('attempts.terminal-event-digest-missing')
    )

    const missingCleanup = await validObservation()
    delete missingCleanup.inventories.attempts.records[0].cleanupReceipt
    receipt = loaded.evaluateQuiescence(missingCleanup)
    assert.ok(violationCodes(receipt).has('attempts.cleanup-receipt-missing'))

    const mismatchedCleanup = await validObservation()
    mismatchedCleanup.inventories.attempts.records[0].attemptId =
        'attempt-1829-other'
    receipt = loaded.evaluateQuiescence(mismatchedCleanup)
    assert.ok(
        violationCodes(receipt)
            .has('attempts.cleanup-receipt-binding-mismatch')
    )

    const mismatchedBaseline = await validObservation()
    mismatchedBaseline.inventories.attempts.records[0]
        .cleanupReceipt.baselineDigest =
            '2323232323232323232323232323232323232323232323232323232323232323'
    delete mismatchedBaseline.inventories.attempts.records[0]
        .cleanupReceipt.receiptDigest
    mismatchedBaseline.inventories.attempts.records[0]
        .cleanupReceipt.receiptDigest = loaded.computeQuiescenceDigest(
            mismatchedBaseline.inventories.attempts.records[0].cleanupReceipt
        )
    receipt = loaded.evaluateQuiescence(mismatchedBaseline)
    assert.ok(violationCodes(receipt).has('attempts.outer-binding-mismatch'))
})

test('Q07 bootstrap audit-only, fallback, or active state is never terminal', async () => {
    const loaded = await implementation()
    const observation = await validObservation()
    observation.inventories.bootstrap.summary.disposition = 'audit-only'
    observation.inventories.bootstrap.summary.fallbackDiscoverable = true
    observation.inventories.bootstrap.summary.activeStateCount = 1
    observation.inventories.bootstrap.records = [{
        bootstrapId: 'bootstrap-1827',
        status: 'audit-only',
        retirementReceiptDigest:
            '1818181818181818181818181818181818181818181818181818181818181818'
    }]
    const receipt = loaded.evaluateQuiescence(observation)
    const codes = violationCodes(receipt)
    assert.equal(receipt.status, 'not-quiescent')
    assert.ok(codes.has('bootstrap.disposition-not-terminal'))
    assert.ok(codes.has('bootstrap.fallback-discoverable-present'))
    assert.ok(codes.has('bootstrap.active-state-count'))
    assert.ok(codes.has('bootstrap.terminal-state-invalid'))
})

test('Q08 stage completeness binds cleanup and UI authority receipts', async () => {
    const loaded = await implementation()
    const cleanupMismatch = await validObservation()
    cleanupMismatch.inventories.stages.records[0]
        .resourceCleanupReceiptDigest = '1919191919191919191919191919191919191919191919191919191919191919'
    let receipt = loaded.evaluateQuiescence(cleanupMismatch)
    assert.ok(violationCodes(receipt).has('stages.cleanup-receipt-mismatch'))

    const missingUiEvidence = await validObservation()
    missingUiEvidence.inventories.stages.records[0].uiNode = true
    receipt = loaded.evaluateQuiescence(missingUiEvidence)
    assert.ok(
        violationCodes(receipt).has('stages.ux-accepted-receipt-digest-missing')
    )
    assert.ok(
        violationCodes(receipt).has('stages.design-skill-digest-missing')
    )
})

test('Q09 a group cleanup digest cannot substitute for member completeness', async () => {
    const loaded = await implementation()
    const observation = await validObservation()
    observation.inventories.groups.records = [{
        groupId: 'group-orchestration',
        status: 'completed',
        active: false,
        terminalCleanupReceiptDigest:
            '2020202020202020202020202020202020202020202020202020202020202020',
        activeMemberIds: [],
        activeWriteLeaseIds: [],
        ownedResourceIds: [],
        retainedServiceIds: [],
        unfinishedDeliveryWindowIds: [],
        undisposedCommitPrefixes: [],
        memberIds: ['member-a', 'member-b'],
        memberReceiptIds: ['member-a']
    }]
    const receipt = loaded.evaluateQuiescence(observation)
    assert.ok(violationCodes(receipt).has('groups.member-receipts-incomplete'))
})

test('Q10 a receipt cannot replay across current inventory or scope changes', async () => {
    const loaded = await implementation()
    const observation = await validObservation()
    const receipt = loaded.evaluateQuiescence(observation)

    const sourceChanged = clone(observation)
    sourceChanged.sources.projection.digest =
        '2121212121212121212121212121212121212121212121212121212121212121'
    assertQuiescenceError(
        () => loaded.verifyQuiescenceReceipt({
            observation: sourceChanged,
            receipt,
            expectedBindings: expectedBindings(observation, receipt),
            now: observation.verifiedAt
        }),
        'quiescence-receipt-replay-mismatch'
    )

    const baselineChanged = clone(observation)
    baselineChanged.baseline.baselineDigest =
        '2222222222222222222222222222222222222222222222222222222222222222'
    assertQuiescenceError(
        () => loaded.verifyQuiescenceReceipt({
            observation: baselineChanged,
            receipt,
            expectedBindings: expectedBindings(observation, receipt),
            now: observation.verifiedAt
        }),
        'quiescence-receipt-replay-mismatch'
    )

    const tampered = clone(receipt)
    tampered.status = 'not-quiescent'
    assertQuiescenceError(
        () => loaded.verifyQuiescenceReceipt({
            observation,
            receipt: tampered,
            expectedBindings: expectedBindings(observation, receipt),
            now: observation.verifiedAt
        }),
        'quiescence-receipt-not-quiescent'
    )

    assertQuiescenceError(
        () => loaded.verifyQuiescenceReceipt({
            observation,
            receipt,
            expectedBindings: expectedBindings(observation, receipt, {
                maxObservationAgeMs: 1_000
            }),
            now: '2026-08-02T06:00:02.000Z'
        }),
        'quiescence-receipt-binding-mismatch'
    )
})

test('Q11 evaluation is pure and exposes no cleanup or mutation adapter', async () => {
    const loaded = await implementation()
    const observation = await validObservation()
    const before = clone(observation)
    loaded.evaluateQuiescence(observation)
    assert.deepEqual(observation, before)

    const source = readFileSync(implementationPath, 'utf8')
    for (const forbidden of [
        'cleanupAttemptResources',
        'spawnSync(',
        'execSync(',
        'writeFileSync(',
        'rmSync(',
        'unlinkSync(',
        'process.kill(',
        'worktree remove',
        'branch -D',
        'docker rm',
        'cherry-pick',
        'git push'
    ]) assert.equal(source.includes(forbidden), false, forbidden)

    for (const forbiddenExport of [
        'cleanup',
        'terminate',
        'resumeContinuation',
        'selectRoute',
        'landCandidate',
        'recordHumanDecision'
    ]) assert.equal(loaded[forbiddenExport], undefined, forbiddenExport)
})

test('Q12 raw records and modeled verifier/source sets cannot contradict zero summaries', async () => {
    const loaded = await implementation()
    const cases = [{
        name: 'unapproved retained Git worktree',
        mutate(observation) {
            observation.inventories.git.records = [{
                resourceId: 'rogue-retained-worktree',
                status: 'approved-audit-only',
                evidenceDigest: '2424242424242424242424242424242424242424242424242424242424242424'
            }]
        },
        code: 'git.retention-not-approved'
    }, {
        name: 'bound port hidden by zero summary',
        mutate(observation) {
            observation.inventories.ports.records = [{
                resourceId: 'port-8080',
                status: 'absent-verified',
                evidenceDigest: '2525252525252525252525252525252525252525252525252525252525252525',
                listening: true
            }]
        },
        code: 'ports.record-present'
    }, {
        name: 'container hidden by zero summary',
        mutate(observation) {
            observation.inventories.docker.records = [{
                resourceId: 'container-1829',
                status: 'absent-verified',
                evidenceDigest: '2626262626262626262626262626262626262626262626262626262626262626',
                running: true
            }]
        },
        code: 'docker.record-present'
    }, {
        name: 'unmodeled verifier authority',
        mutate(observation) {
            observation.verifier.unmodeledAuthority = true
        },
        code: 'verifier.fields-invalid'
    }, {
        name: 'fabricated source set',
        mutate(observation) {
            observation.sources = {
                fabricated: {
                    schema: 'caller.fabricated.v1',
                    verificationStatus: 'verified',
                    digest:
                        '2727272727272727272727272727272727272727272727272727272727272727'
                }
            }
            for (const inventory of Object.values(observation.inventories)) {
                inventory.sourceRefs = ['fabricated']
            }
        },
        code: 'sources.exact-set-mismatch'
    }]
    for (const item of cases) {
        const observation = await validObservation()
        item.mutate(observation)
        const result = loaded.evaluateQuiescence(observation)
        assert.equal(result.status, 'not-quiescent', item.name)
        assert.ok(violationCodes(result).has(item.code), item.name)
    }
})
