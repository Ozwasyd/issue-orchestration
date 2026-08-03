import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    appendNodeEventAtomic,
    buildNodeIndex,
    canonicalNodeStateLocation,
    canonicalRunStateLocation,
    compileControlEvent,
    createControlLedger,
    persistAggregateRunState,
    projectAggregateRun,
    recoverAggregateRunState,
    replayControlLedger,
    stateDigest
} from '../../skills/issue-orchestration/scripts/multi-node-state.mjs'
import {
    replayEventLedgerSync,
    sealNodeLedgerHeader
} from '../../skills/issue-orchestration/scripts/event-ledger.mjs'

const runId = 'run-multi-node-001'
const createdAt = '2026-08-04T00:00:00.000Z'
const sourceDagDigest = stateDigest('dag')
const issueSnapshotFingerprint = stateDigest('issue')
const repositoryFingerprint = stateDigest('repository')

function nodeIdentity({
    nodeId,
    repository = 'ExampleOrg/RepositoryA',
    issueNumber,
    baseSha = 'a'.repeat(40),
    dependencyKeys = [],
    acceptanceGroup = null
}) {
    return {
        nodeId,
        memberId: nodeId,
        repository,
        issueNumber,
        selectorReceiptDigest: stateDigest({ nodeId, kind: 'selector' }),
        remoteMemberDigest: stateDigest({ nodeId, kind: 'remote-member' }),
        nodeEpoch: 1,
        baseSha,
        dependencyKeys,
        acceptanceGroup
    }
}

function makeNodeLedger(identity, stateRoot) {
    const header = sealNodeLedgerHeader({
        runId,
        ...identity,
        stateRootCanonical: path.resolve(stateRoot),
        issueSnapshotFingerprint,
        repositoryFingerprint,
        createdAt
    })
    const payload = { issueKind: 'code' }
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `discover-${identity.nodeId}`,
        sequence: 1,
        runId,
        nodeId: identity.nodeId,
        eventType: 'node.discovered',
        fromState: 'none',
        toState: 'discovered',
        attemptId: null,
        actorRole: 'dag-creator-updater',
        sourceDagDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        baseSha: identity.baseSha,
        payload,
        payloadDigest: stateDigest(payload),
        evidenceRefs: [`evidence://${identity.nodeId}/discovery`],
        createdAt,
        previousEventDigest: '0'.repeat(64)
    }
    event.eventDigest = stateDigest(event)
    return { header, events: [event] }
}

function addControl(ledger, eventType, payload, offset = 0) {
    const event = compileControlEvent({
        ledger,
        eventType,
        payload,
        createdAt: new Date(Date.parse(createdAt) + offset * 1_000)
            .toISOString()
    })
    ledger.events.push(event)
    return event
}

function makeControl(identities) {
    const ledger = createControlLedger({ runId, createdAt })
    addControl(ledger, 'scope.refreshed', {
        selectorReceiptDigest: stateDigest('selector-root')
    })
    addControl(ledger, 'remote-snapshot.refreshed', {
        remoteSnapshotDigest: stateDigest('remote-root')
    }, 1)
    identities.forEach((identity, index) => {
        addControl(ledger, 'node.registered', identity, index + 2)
    })
    addControl(ledger, 'slots.updated', {
        capacity: 2,
        activeNodeIds: []
    }, identities.length + 2)
    return ledger
}

function expectCode(operation, expected) {
    assert.throws(operation, (error) => {
        assert.equal(error?.code, expected, error?.stack ?? String(error))
        return true
    })
}

test('one run verifies two same-repository nodes and two repositories with independent bases', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-node-'))
    const identities = [
        nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 }),
        nodeIdentity({ nodeId: 'RepositoryA#21', issueNumber: 21 }),
        nodeIdentity({
            nodeId: 'RepositoryB#7',
            repository: 'ExampleOrg/RepositoryB',
            issueNumber: 7,
            baseSha: 'b'.repeat(40)
        })
    ]
    const ledgers = identities.map((identity) =>
        makeNodeLedger(identity, stateRoot))
    const result = projectAggregateRun({
        stateRoot,
        controlLedger: makeControl(identities),
        nodeLedgers: ledgers
    })
    assert.deepEqual(
        Object.values(result.nodeIndex.nodes).map(({ status }) => status),
        ['verified', 'verified', 'verified']
    )
    assert.equal(result.projection.nodes['RepositoryA#20'].lifecycleState, 'discovered')
    assert.equal(result.projection.nodes['RepositoryA#21'].dispatchable, true)
    assert.equal(result.projection.nodes['RepositoryB#7'].baseSha, 'b'.repeat(40))
    assert.notEqual(
        result.nodeIndex.nodes['RepositoryA#20'].nodeKey,
        result.nodeIndex.nodes['RepositoryA#21'].nodeKey
    )
})

test('node ledgers have independent paths, sequence numbers, heads, projections, and attempt roots', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-paths-'))
    const left = nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 })
    const right = nodeIdentity({ nodeId: 'RepositoryA#21', issueNumber: 21 })
    const leftLedger = makeNodeLedger(left, stateRoot)
    const rightLedger = makeNodeLedger(right, stateRoot)
    const leftProjection = replayEventLedgerSync(leftLedger)
    const rightProjection = replayEventLedgerSync(rightLedger)
    const leftLocation = canonicalNodeStateLocation({
        stateRoot, runId, nodeId: left.nodeId
    })
    const rightLocation = canonicalNodeStateLocation({
        stateRoot, runId, nodeId: right.nodeId
    })
    assert.notEqual(leftLocation.ledgerPath, rightLocation.ledgerPath)
    assert.notEqual(leftLocation.projectionPath, rightLocation.projectionPath)
    assert.equal(leftProjection.lastSequence, 1)
    assert.equal(rightProjection.lastSequence, 1)
    assert.notEqual(leftProjection.lastEventDigest, rightProjection.lastEventDigest)
    assert.notEqual(
        leftLocation.writerAttemptsRoot,
        rightLocation.writerAttemptsRoot
    )
})

test('cross-node append fails before any bytes are appended', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-node-'))
    const left = nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 })
    const right = nodeIdentity({ nodeId: 'RepositoryA#21', issueNumber: 21 })
    const leftLedger = makeNodeLedger(left, stateRoot)
    const rightLedger = makeNodeLedger(right, stateRoot)
    persistAggregateRunState({
        stateRoot,
        controlLedger: makeControl([left, right]),
        nodeLedgers: [leftLedger, rightLedger]
    })
    const location = canonicalNodeStateLocation({
        stateRoot, runId, nodeId: left.nodeId
    })
    const before = fs.readFileSync(location.ledgerPath)
    const foreign = structuredClone(rightLedger.events[0])
    foreign.sequence = 2
    await assert.rejects(
        appendNodeEventAtomic({
            stateRoot,
            runId,
            nodeId: left.nodeId,
            event: foreign,
            writerRole: 'root-scheduler'
        }),
        (error) => error?.code === 'event-node-identity'
    )
    assert.deepEqual(fs.readFileSync(location.ledgerPath), before)
})

test('run control ledger rejects node-local writer events before append', () => {
    const control = createControlLedger({ runId, createdAt })
    expectCode(
        () => compileControlEvent({
            ledger: control,
            eventType: 'implementation.started',
            payload: { nodeId: 'RepositoryA#20' },
            createdAt
        }),
        'control-ledger-node-local-event'
    )
    assert.equal(control.events.length, 0)
})

test('disk replay reconstructs byte-identical control, index, and aggregate projections', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'))
    const identities = [
        nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 }),
        nodeIdentity({ nodeId: 'RepositoryB#7', repository: 'ExampleOrg/RepositoryB', issueNumber: 7, baseSha: 'b'.repeat(40) })
    ]
    const initial = persistAggregateRunState({
        stateRoot,
        controlLedger: makeControl(identities),
        nodeLedgers: identities.map((identity) =>
            makeNodeLedger(identity, stateRoot))
    })
    const recovered = recoverAggregateRunState({ stateRoot, runId })
    assert.deepEqual(recovered.controlProjection, initial.controlProjection)
    assert.deepEqual(recovered.nodeIndex, initial.nodeIndex)
    assert.deepEqual(recovered.projection, initial.projection)
})

test('recovery ignores caller-edited index paths and derives canonical node locations', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'index-path-'))
    const identity = nodeIdentity({
        nodeId: 'RepositoryA#20',
        issueNumber: 20
    })
    const initial = persistAggregateRunState({
        stateRoot,
        controlLedger: makeControl([identity]),
        nodeLedgers: [makeNodeLedger(identity, stateRoot)]
    })
    const run = canonicalRunStateLocation({ stateRoot, runId })
    const stored = JSON.parse(fs.readFileSync(run.nodeIndexPath, 'utf8'))
    stored.nodes[identity.nodeId].ledgerPath = '../../outside-ledger.jsonl'
    delete stored.nodeIndexDigest
    stored.nodeIndexDigest = stateDigest(stored)
    fs.writeFileSync(run.nodeIndexPath, `${JSON.stringify(stored, null, 2)}\n`)
    const recovered = recoverAggregateRunState({ stateRoot, runId })
    assert.deepEqual(recovered.projection, initial.projection)
    assert.notEqual(
        recovered.nodeIndex.nodes[identity.nodeId].ledgerPath,
        '../../outside-ledger.jsonl'
    )
})

test('corrupt node quarantine is local and blocks only its dependents', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-'))
    const prerequisite = nodeIdentity({
        nodeId: 'RepositoryA#20', issueNumber: 20
    })
    const dependent = nodeIdentity({
        nodeId: 'RepositoryA#21', issueNumber: 21,
        dependencyKeys: [prerequisite.nodeId]
    })
    const independent = nodeIdentity({
        nodeId: 'RepositoryB#7', repository: 'ExampleOrg/RepositoryB',
        issueNumber: 7, baseSha: 'b'.repeat(40)
    })
    const identities = [prerequisite, dependent, independent]
    persistAggregateRunState({
        stateRoot,
        controlLedger: makeControl(identities),
        nodeLedgers: identities.map((identity) =>
            makeNodeLedger(identity, stateRoot))
    })
    const corrupt = canonicalNodeStateLocation({
        stateRoot, runId, nodeId: prerequisite.nodeId
    })
    fs.appendFileSync(corrupt.ledgerPath, '{not-json')
    const recovered = recoverAggregateRunState({ stateRoot, runId })
    assert.equal(
        recovered.projection.nodes[prerequisite.nodeId].lifecycleState,
        'quarantined'
    )
    assert.equal(recovered.projection.nodes[dependent.nodeId].dispatchable, false)
    assert.deepEqual(
        recovered.projection.nodes[dependent.nodeId].blockedBy,
        [prerequisite.nodeId]
    )
    assert.equal(recovered.projection.nodes[independent.nodeId].dispatchable, true)
})

test('run-level delivery and cleanup effects are exactly once', () => {
    const identity = nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 })
    const control = makeControl([identity])
    addControl(control, 'delivery.effect-recorded', {
        effectId: 'push-20',
        effectType: 'push',
        nodeId: identity.nodeId
    }, 10)
    const duplicate = compileControlEvent({
        ledger: control,
        eventType: 'delivery.effect-recorded',
        payload: {
            effectId: 'push-20',
            effectType: 'push',
            nodeId: identity.nodeId
        },
        createdAt: '2026-08-04T00:00:20.000Z'
    })
    control.events.push(duplicate)
    expectCode(() => replayControlLedger(control), 'control-run-effect-duplicate')
})

test('production layout has no run-wide ordinary ledger or primary-node replay invariant', () => {
    const stateRoot = '/tmp/issue-orchestration-state'
    const run = canonicalRunStateLocation({ stateRoot, runId })
    const node = canonicalNodeStateLocation({
        stateRoot, runId, nodeId: 'RepositoryA#20'
    })
    assert.equal(path.basename(run.controlLedgerPath), 'control-ledger.jsonl')
    assert.match(node.ledgerPath, /\/nodes\/[a-f0-9]{64}\/event-ledger\.jsonl$/u)
    assert.notEqual(node.ledgerPath, path.join(run.runRoot, 'event-ledger.jsonl'))
    const eventLedgerSource = fs.readFileSync(
        new URL('../../skills/issue-orchestration/scripts/event-ledger.mjs', import.meta.url),
        'utf8'
    )
    assert.doesNotMatch(eventLedgerSource, /primaryNodeId/u)
    const index = buildNodeIndex({
        stateRoot,
        controlProjection: replayControlLedger(makeControl([
            nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 })
        ])),
        nodeLedgers: [makeNodeLedger(
            nodeIdentity({ nodeId: 'RepositoryA#20', issueNumber: 20 }),
            stateRoot
        )]
    })
    assert.equal(index.schema, 'issue-orchestration.node-index.v1')
})
