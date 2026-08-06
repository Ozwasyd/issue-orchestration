import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    appendControlEventAtomicSync,
    appendNodeEventAtomicSync,
    canonicalRunStateLocation,
    clearVerifiedReplayProjectionCache,
    compileControlEvent,
    createControlLedger,
    persistAggregateRunState,
    recoverAggregateRunState,
    stateDigest,
    verifiedReplayProjectionCacheObservation,
    verifiedReplayProjectionCacheStats
} from '../../skills/issue-orchestration/scripts/multi-node-state.mjs'
import {
    sealNodeLedgerHeader
} from '../../skills/issue-orchestration/scripts/event-ledger.mjs'

const runId = 'run-verified-replay-cache-001'
const createdAt = '2026-08-06T00:00:00.000Z'
const GENESIS = '0'.repeat(64)
const sourceDagDigest = stateDigest('cache-dag')
const issueSnapshotFingerprint = stateDigest('cache-issue')
const repositoryFingerprint = stateDigest('cache-repository')

function identity(nodeId, issueNumber) {
    return {
        nodeId,
        memberId: nodeId,
        repository: 'ExampleOrg/RepositoryA',
        issueNumber,
        selectorReceiptDigest: stateDigest({ nodeId, selector: true }),
        remoteMemberDigest: stateDigest({ nodeId, remote: true }),
        nodeEpoch: 1,
        baseSha: 'a'.repeat(40),
        dependencyKeys: [],
        acceptanceGroup: null
    }
}

function discoveryEvent(value, sequence = 1) {
    const nodeDiscoveredReceipt = {
        schema: 'issue-orchestration.node-discovered-receipt.v1',
        status: 'verified',
        producerAuthority: 'deterministic-cold-start-compiler',
        rootAuthored: false,
        runId,
        nodeId: value.nodeId,
        memberId: value.nodeId,
        repository: value.repository,
        issueNumber: value.issueNumber,
        baseSha: value.baseSha,
        nodeEpoch: value.nodeEpoch,
        selectorReceiptDigest: value.selectorReceiptDigest,
        remoteSnapshotDigest: stateDigest({ nodeId: value.nodeId, snapshot: true }),
        remoteMemberDigest: value.remoteMemberDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        semanticProposalDigest: stateDigest({ nodeId: value.nodeId, proposal: true }),
        semanticRouteDecisionDigest: stateDigest({ nodeId: value.nodeId, route: true }),
        semanticFactsDigest: stateDigest({ nodeId: value.nodeId, facts: true }),
        requirementInventoryDigest: stateDigest({ nodeId: value.nodeId, inventory: true }),
        sourceCoverageDigest: stateDigest({ nodeId: value.nodeId, coverage: true }),
        acceptanceContractDigest: stateDigest({ nodeId: value.nodeId, acceptance: true })
    }
    nodeDiscoveredReceipt.receiptDigest = stateDigest(nodeDiscoveredReceipt)
    const payload = {
        issueKind: 'code',
        nodeDiscoveredReceipt,
        nodeDiscoveredReceiptDigest: nodeDiscoveredReceipt.receiptDigest
    }
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `cache-discovery-${value.nodeId}-${sequence}`,
        sequence,
        runId,
        nodeId: value.nodeId,
        eventType: 'node.discovered',
        fromState: 'none',
        toState: 'discovered',
        attemptId: null,
        actorRole: 'dag-creator-updater',
        sourceDagDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        baseSha: value.baseSha,
        payload,
        payloadDigest: stateDigest(payload),
        evidenceRefs: [`evidence://${value.nodeId}/discovery`],
        createdAt,
        previousEventDigest: GENESIS
    }
    event.eventDigest = stateDigest(event)
    return event
}

function nodeLedger(value, stateRoot, discovered = true) {
    return {
        header: sealNodeLedgerHeader({
            runId,
            ...value,
            stateRootCanonical: path.resolve(stateRoot),
            issueSnapshotFingerprint,
            repositoryFingerprint,
            createdAt
        }),
        events: discovered ? [discoveryEvent(value)] : []
    }
}

function controlLedger(values) {
    const ledger = createControlLedger({ runId, createdAt })
    const add = (eventType, payload, seconds) => {
        ledger.events.push(compileControlEvent({
            ledger,
            eventType,
            payload,
            createdAt: new Date(Date.parse(createdAt) + seconds * 1_000)
                .toISOString()
        }))
    }
    add('scope.refreshed', {
        selectorReceiptDigest: stateDigest('cache-selector')
    }, 0)
    add('remote-snapshot.refreshed', {
        remoteSnapshotDigest: stateDigest('cache-remote')
    }, 1)
    values.forEach((value, index) => add(
        'node.registered',
        value,
        index + 2
    ))
    add('slots.updated', { capacity: 2, activeNodeIds: [] }, values.length + 2)
    return ledger
}

function fixture({ discovered = true } = {}) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-replay-'))
    const left = identity('RepositoryA#20', 20)
    const right = identity('RepositoryA#21', 21)
    persistAggregateRunState({
        stateRoot,
        controlLedger: controlLedger([left, right]),
        nodeLedgers: [
            nodeLedger(left, stateRoot, discovered),
            nodeLedger(right, stateRoot, discovered)
        ]
    })
    clearVerifiedReplayProjectionCache({ stateRoot, runId })
    return { stateRoot, left, right }
}

function delta(after, before, field) {
    return after[field] - before[field]
}

test('unchanged immutable heads perform one full replay and then reuse byte-identical verified state', () => {
    const { stateRoot } = fixture()
    const first = recoverAggregateRunState({ stateRoot, runId })
    const second = recoverAggregateRunState({ stateRoot, runId })
    assert.deepEqual(second, first)
    assert.equal(
        verifiedReplayProjectionCacheObservation(first).status,
        'full-replay'
    )
    assert.equal(
        verifiedReplayProjectionCacheObservation(second).status,
        'cache-hit'
    )
    const stats = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(stats.fullReplays, 1)
    assert.equal(stats.cacheHits, 1)
    assert.equal(stats.controlLedgerReplays, 1)
    assert.equal(stats.nodeLedgerReplays, 2)
    assert.equal(stats.aggregateProjectionRebuilds, 1)
})

test('one node append replays only that node and rebuilds the aggregate from verified siblings', () => {
    const { stateRoot, left, right } = fixture({ discovered: false })
    recoverAggregateRunState({ stateRoot, runId })
    const before = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    appendNodeEventAtomicSync({
        stateRoot,
        runId,
        nodeId: left.nodeId,
        event: discoveryEvent(left),
        writerRole: 'root-scheduler'
    })
    const after = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(delta(after, before, 'controlLedgerReplays'), 0)
    assert.equal(delta(after, before, 'nodeLedgerReplays'), 1)
    assert.equal(delta(after, before, 'aggregateProjectionRebuilds'), 1)
    const recovered = recoverAggregateRunState({ stateRoot, runId })
    assert.equal(recovered.projection.nodes[left.nodeId].lifecycleState, 'discovered')
    assert.equal(recovered.projection.nodes[right.nodeId].lifecycleState, 'none')
    assert.equal(
        verifiedReplayProjectionCacheObservation(recovered).status,
        'cache-hit'
    )
})

test('one control append replays control only and preserves verified node projections', () => {
    const { stateRoot } = fixture()
    recoverAggregateRunState({ stateRoot, runId })
    const location = canonicalRunStateLocation({ stateRoot, runId })
    const ledger = JSON.parse('null') ?? null
    void ledger
    const control = (() => {
        const source = fs.readFileSync(location.controlLedgerPath, 'utf8')
            .trim().split('\n').map((line) => JSON.parse(line))
        return { header: source[0], events: source.slice(1) }
    })()
    const event = compileControlEvent({
        ledger: control,
        eventType: 'slots.updated',
        payload: { capacity: 3, activeNodeIds: [] },
        createdAt: '2026-08-06T00:02:00.000Z'
    })
    const before = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    appendControlEventAtomicSync({
        stateRoot,
        runId,
        event,
        writerRole: 'root-scheduler'
    })
    const after = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(delta(after, before, 'controlLedgerReplays'), 1)
    assert.equal(delta(after, before, 'nodeLedgerReplays'), 0)
    assert.equal(delta(after, before, 'aggregateProjectionRebuilds'), 1)
    assert.equal(
        recoverAggregateRunState({ stateRoot, runId })
            .projection.slots.capacity,
        3
    )
})

test('process restart, authority drift, explicit audit, and corruption suspicion require full replay', () => {
    const { stateRoot } = fixture()
    const authorityA = stateDigest('authority-a')
    recoverAggregateRunState({
        stateRoot,
        runId,
        cacheAuthorityDigest: authorityA
    })
    recoverAggregateRunState({
        stateRoot,
        runId,
        cacheAuthorityDigest: authorityA
    })
    const beforeAuthority = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    const authorityB = recoverAggregateRunState({
        stateRoot,
        runId,
        cacheAuthorityDigest: stateDigest('authority-b')
    })
    assert.equal(
        verifiedReplayProjectionCacheObservation(authorityB).status,
        'full-replay'
    )
    let stats = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(delta(stats, beforeAuthority, 'fullReplays'), 1)

    const beforeAudit = stats
    recoverAggregateRunState({
        stateRoot,
        runId,
        cacheAuthorityDigest: stateDigest('authority-b'),
        explicitAudit: true
    })
    stats = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(delta(stats, beforeAudit, 'fullReplays'), 1)

    const beforeSuspicion = stats
    recoverAggregateRunState({
        stateRoot,
        runId,
        cacheAuthorityDigest: stateDigest('authority-b'),
        corruptionSuspected: true
    })
    stats = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(delta(stats, beforeSuspicion, 'fullReplays'), 1)

    clearVerifiedReplayProjectionCache({ stateRoot, runId })
    const restarted = recoverAggregateRunState({ stateRoot, runId })
    assert.equal(
        verifiedReplayProjectionCacheObservation(restarted).status,
        'full-replay'
    )
})

test('caller-edited index or projection cannot produce a cache hit', () => {
    const { stateRoot, left } = fixture()
    const initial = recoverAggregateRunState({ stateRoot, runId })
    recoverAggregateRunState({ stateRoot, runId })
    const run = canonicalRunStateLocation({ stateRoot, runId })
    const forged = JSON.parse(fs.readFileSync(run.nodeIndexPath, 'utf8'))
    forged.nodes[left.nodeId].ledgerPath = '../../caller-edited.jsonl'
    delete forged.nodeIndexDigest
    forged.nodeIndexDigest = stateDigest(forged)
    fs.writeFileSync(run.nodeIndexPath, `${JSON.stringify(forged, null, 2)}\n`)
    const before = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    const recovered = recoverAggregateRunState({ stateRoot, runId })
    const after = verifiedReplayProjectionCacheStats({ stateRoot, runId })
    assert.equal(delta(after, before, 'fullReplays'), 1)
    assert.notEqual(
        recovered.nodeIndex.nodes[left.nodeId].ledgerPath,
        '../../caller-edited.jsonl'
    )
    assert.deepEqual(recovered.projection, initial.projection)
    assert.notEqual(
        verifiedReplayProjectionCacheObservation(recovered).status,
        'cache-hit'
    )
})

test('cached and forced-full-replay paths produce byte-identical projections', () => {
    const { stateRoot } = fixture()
    const cached = recoverAggregateRunState({ stateRoot, runId })
    recoverAggregateRunState({ stateRoot, runId })
    const forced = recoverAggregateRunState({
        stateRoot,
        runId,
        forceFullReplay: true
    })
    assert.deepEqual(forced.controlProjection, cached.controlProjection)
    assert.deepEqual(forced.nodeIndex, cached.nodeIndex)
    assert.deepEqual(forced.nodeProjections, cached.nodeProjections)
    assert.deepEqual(forced.projection, cached.projection)
})

test('cache authority is immutable-head derived, in-process only, and absent from lifecycle authority inputs', () => {
    const multiNodeSource = fs.readFileSync(
        new URL('../../skills/issue-orchestration/scripts/multi-node-state.mjs', import.meta.url),
        'utf8'
    )
    const runLoopSource = fs.readFileSync(
        new URL('../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs', import.meta.url),
        'utf8'
    )
    const finalizerSource = fs.readFileSync(
        new URL('../../skills/issue-orchestration/scripts/lifecycle-quiescence-finalizer.mjs', import.meta.url),
        'utf8'
    )
    for (const required of [
        'stateRoot: path.resolve(stateRoot)',
        'controlLedgerHeadDigest: controlIdentity.headDigest',
        'nodeIndexDigest: result.nodeIndex.nodeIndexDigest',
        'nodeLedgerHeads:',
        'startupPolicyBindingDigest:',
        'installedPolicyDigest:',
        'runtimeTrustBindingDigest:'
    ]) assert.match(multiNodeSource, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    assert.doesNotMatch(
        multiNodeSource,
        /mtimeMs|ctimeMs|birthtimeMs|Date\.now\(\)|callerProjection|projectionJson/u
    )
    assert.doesNotMatch(
        multiNodeSource,
        /verified-replay-cache\.(json|jsonl|db)|cache-ledger|cache-projection/u
    )
    assert.doesNotMatch(
        runLoopSource,
        /replayCache.*(?:route|retry|terminal|mutation)|(?:route|retry|terminal|mutation).*replayCache/iu
    )
    assert.match(finalizerSource, /explicitAudit:\s*true/u)
})
