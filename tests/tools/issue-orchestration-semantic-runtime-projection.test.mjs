import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..')
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const implementationPath = path.join(
    root,
    'skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
)
const cases = readJson('semantic-runtime-projection-cases.json')
const acceptance = readJson('semantic-runtime-projection-acceptance-map.json')
const expectedInitialFailures =
    readJson('semantic-runtime-projection-expected-initial-failures.json')
const controls =
    readJson('semantic-runtime-projection-mutation-controls.json').controls
const probes = readJson('semantic-runtime-projection-runtime-probes.json').probes
const contract = readJson('semantic-runtime-projection-test-contract.json')

const REQUIRED_EXPORTS = [
    'applySemanticGraphPatch',
    'classifyRemoteMutations',
    'computeDigestLayers',
    'createSemanticGraph',
    'loadSemanticRuntimeState',
    'persistSemanticRuntimeState',
    'projectRuntime',
    'sealDagUpdateDecisionReceipt',
    'sealExpectedRemoteMutations',
    'sealSemanticGraphPatch',
    'summarizeDagUpdateTelemetry',
    'validateFullSemanticGraphProposal',
    'validateRuntimeProjection',
    'validateSemanticGraphPatch',
    'verifyDagUpdateDecisionReceipt'
]
const DECISION_FIELDS = [
    'dagUpdateMode',
    'remoteMutationClassification',
    'expectedRemoteMutationDigest',
    'expectedRemoteMutationMatched',
    'scopeDigestBefore',
    'scopeDigestAfter',
    'semanticGraphInputDigestBefore',
    'semanticGraphInputDigestAfter',
    'semanticGraphDigestBefore',
    'semanticGraphDigestAfter',
    'runtimeProjectionDigestBefore',
    'runtimeProjectionDigestAfter',
    'baseSemanticGraphDigest',
    'graphPatchDigest',
    'graphPatchOperationCount',
    'dagUpdaterDispatchRequestId',
    'dagUpdaterDispatchReceiptDigest',
    'fullProposalReason',
    'projectorVersion',
    'projectorDigest',
    'receiptDigest'
]
const ALLOWED_PATCH_OPERATIONS = [
    'add-node',
    'remove-node',
    'add-edge',
    'remove-edge',
    'change-owner',
    'change-conflict-key',
    'change-risk-class',
    'change-ui-class',
    'change-acceptance-group'
]

let runtimePromise

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function unsignedDigest(value, field) {
    const unsigned = structuredClone(value)
    delete unsigned[field]
    return digest(unsigned)
}

function clone(value) {
    return structuredClone(value)
}

function reseal(value, field) {
    const result = clone(value)
    delete result[field]
    result[field] = digest(result)
    return result
}

function assertSha(value, label) {
    assert.match(value, /^[a-f0-9]{64}$/u, `${label} must be a SHA-256 digest`)
}

async function runtime() {
    if (!fs.existsSync(implementationPath)) {
        assert.fail(`semantic-runtime-module-missing: ${implementationPath}`)
    }
    runtimePromise ??= import(
        `${pathToFileURL(implementationPath).href}?contract=${Date.now()}-${Math.random()}`
    )
    const loaded = await runtimePromise
    for (const name of REQUIRED_EXPORTS) {
        assert.equal(typeof loaded[name], 'function',
            `semantic-runtime-export-missing:${name}`)
    }
    return loaded
}

async function assertDenied(operation, expectedCode) {
    await assert.rejects(async () => operation(), (error) => {
        assert.equal(error?.code, expectedCode)
        return true
    })
}

function graphAuthor(overrides = {}) {
    return {
        actorRole: 'dag-creator-updater',
        actorId: 'dag-updater-1833',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        runtimeExecutionBindingDigest:
            digest('dag-updater-runtime-binding'),
        mutationPostconditionReceiptDigest:
            digest('dag-updater-postcondition'),
        freshContext: true,
        acceptedWithoutModification: true,
        ...overrides
    }
}

async function baseline() {
    const loaded = await runtime()
    const semanticGraph = loaded.createSemanticGraph({
        ...clone(cases.semanticGraphInput),
        scopeDigest: digest({ scope: 'repositorya-control-plane' }),
        semanticGraphInputDigest: digest({ semantic: cases.semanticGraphInput })
    })
    const expectedRemoteMutations = loaded.sealExpectedRemoteMutations(
        clone(cases.expectedRemoteMutations)
    )
    const beforeProjection = loaded.projectRuntime({
        semanticGraph,
        ledger: clone(cases.ledgerBefore),
        runtime: clone(cases.remoteBefore.runtime)
    })
    const afterProjection = loaded.projectRuntime({
        semanticGraph,
        ledger: clone(cases.ledgerAfterCompletion),
        runtime: clone(cases.remoteAfterExpectedDelivery.runtime)
    })
    const deliveryClassification = loaded.classifyRemoteMutations({
        selector: clone(cases.selector),
        before: clone(cases.remoteBefore),
        after: clone(cases.remoteAfterExpectedDelivery),
        expectedRemoteMutations,
        semanticGraph,
        runtimeProjectionBefore: beforeProjection,
        runtimeProjectionAfter: afterProjection
    })
    return {
        loaded,
        semanticGraph,
        expectedRemoteMutations,
        beforeProjection,
        afterProjection,
        deliveryClassification
    }
}

function projectionDecisionInput(state, overrides = {}) {
    const classification = state.deliveryClassification
    return {
        dagUpdateMode: 'projection-only',
        remoteMutationClassification: classification.remoteMutationClassification,
        expectedRemoteMutationDigest:
            state.expectedRemoteMutations.expectedRemoteMutationDigest,
        expectedRemoteMutationMatched: true,
        scopeDigestBefore: classification.scopeDigestBefore,
        scopeDigestAfter: classification.scopeDigestAfter,
        semanticGraphInputDigestBefore:
            classification.semanticGraphInputDigestBefore,
        semanticGraphInputDigestAfter:
            classification.semanticGraphInputDigestAfter,
        semanticGraphDigestBefore: state.semanticGraph.semanticGraphDigest,
        semanticGraphDigestAfter: state.semanticGraph.semanticGraphDigest,
        runtimeProjectionDigestBefore:
            state.beforeProjection.runtimeProjectionDigest,
        runtimeProjectionDigestAfter:
            state.afterProjection.runtimeProjectionDigest,
        baseSemanticGraphDigest: state.semanticGraph.semanticGraphDigest,
        graphPatchDigest: null,
        graphPatchOperationCount: 0,
        dagUpdaterDispatchRequestId: null,
        dagUpdaterDispatchReceiptDigest: null,
        fullProposalReason: null,
        projectorVersion: state.afterProjection.projectorVersion,
        projectorDigest: state.afterProjection.projectorDigest,
        ...overrides
    }
}

async function semanticPatch(state) {
    const operations = [{
        type: 'change-owner',
        nodeId: 'ExampleOrg/RepositoryA#1833',
        from: 'orchestration',
        to: 'orchestration-v2'
    }, {
        type: 'add-edge',
        from: 'ExampleOrg/RepositoryA#1829',
        to: 'ExampleOrg/RepositoryA#1833'
    }, {
        type: 'change-acceptance-group',
        nodeId: 'ExampleOrg/RepositoryA#1833',
        from: null,
        to: 'control-plane-cutover'
    }]
    return state.loaded.sealSemanticGraphPatch({
        baseSemanticGraph: state.semanticGraph,
        operations,
        evidenceDigests: [
            'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
        ],
        authoredBy: graphAuthor()
    })
}

test('frozen #1833 contract assets bind the live issue, Sol/xhigh owner and one test tree', () => {
    assert.equal(contract.schema,
        'issue-orchestration.semantic-runtime-projection-test-contract.v1')
    assert.equal(contract.issueId, 'ExampleOrg/RepositoryA#1833')
    assert.equal(contract.baseSha, '788737a0ad22003544b2d439df995e1097de0ee2')
    assert.equal(contract.testOwnerId,
        'test-owner-repositorya-1833-788737a0-sol-xhigh')
    assert.deepEqual(contract.actualProfile, {
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        role: 'test-owner',
        phase: 'test-contract'
    })
    assert.equal(contract.status, 'frozen-red')
    assert.equal(cases.schema,
        'issue-orchestration.semantic-runtime-projection-cases.v1')
    assert.equal(acceptance.schema,
        'issue-orchestration.semantic-runtime-projection-acceptance-map.v1')
    assert.equal(expectedInitialFailures.expectedStatus, 'red')
    assert.deepEqual(probes.map(({ id }) => id),
        Array.from({ length: 10 }, (_, index) => `RP${String(index + 1).padStart(2, '0')}`))

    const controlIds = controls.map(({ id }) => id)
    assert.equal(new Set(controlIds).size, controlIds.length)
    const mappedControls = new Set(
        acceptance.acceptance.flatMap(({ mutations }) => mutations)
    )
    assert.deepEqual([...mappedControls].sort(), [...controlIds].sort())

    const expectedHashedPaths = contract.allowedTestPaths.filter((relative) =>
        relative !==
        'tests/fixtures/issue-orchestration/semantic-runtime-projection-test-contract.json'
    )
    assert.deepEqual(Object.keys(contract.fileHashes), expectedHashedPaths)
    for (const relative of expectedHashedPaths) {
        assert.equal(
            digest(fs.readFileSync(path.join(root, relative))),
            contract.fileHashes[relative],
            `${relative} drifted after freeze`
        )
    }
    assert.equal(digest(contract.fileHashes), contract.frozenTreeDigest)
    assert.equal(unsignedDigest(contract, 'testContractDigest'),
        contract.testContractDigest)
})

test('P01 semanticGraph/runtimeProjection schemas, validators, digests and persistence are separate', async () => {
    const state = await baseline()
    assert.equal(state.semanticGraph.schema, 'issue-orchestration.semantic-graph.v1')
    assert.equal(state.afterProjection.schema,
        'issue-orchestration.runtime-projection.v1')
    assertSha(state.semanticGraph.semanticGraphDigest, 'semanticGraphDigest')
    assertSha(state.afterProjection.runtimeProjectionDigest,
        'runtimeProjectionDigest')
    assert.notEqual(state.semanticGraph.semanticGraphDigest,
        state.afterProjection.runtimeProjectionDigest)
    assert.doesNotThrow(() => state.loaded.validateRuntimeProjection({
        semanticGraph: state.semanticGraph,
        ledger: clone(cases.ledgerAfterCompletion),
        runtime: clone(cases.remoteAfterExpectedDelivery.runtime),
        projection: state.afterProjection
    }))

    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repositorya-1833-state-'))
    try {
        const persisted = state.loaded.persistSemanticRuntimeState({
            stateRoot,
            semanticGraph: state.semanticGraph,
            runtimeProjection: state.afterProjection
        })
        assert.notEqual(persisted.semanticGraphPath, persisted.runtimeProjectionPath)
        assert.equal(path.dirname(persisted.semanticGraphPath), stateRoot)
        assert.equal(path.dirname(persisted.runtimeProjectionPath), stateRoot)
        const loaded = state.loaded.loadSemanticRuntimeState({ stateRoot })
        assert.deepEqual(loaded.semanticGraph, state.semanticGraph)
        assert.deepEqual(loaded.runtimeProjection, state.afterProjection)
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true })
    }
})

test('P02 scope, semantic input and runtime projection digests own disjoint facts', async () => {
    const state = await baseline()
    const first = state.loaded.computeDigestLayers({
        selector: clone(cases.selector),
        snapshot: clone(cases.remoteBefore),
        semanticGraph: state.semanticGraph,
        runtimeProjection: state.beforeProjection
    })
    const reordered = clone(cases.remoteBefore)
    reordered.issues.reverse()
    reordered.issues.forEach((issue) => {
        issue.labels.reverse()
        issue.semanticFacts.dependencies.reverse()
        issue.semanticFacts.conflictKeys.reverse()
    })
    const replay = state.loaded.computeDigestLayers({
        selector: clone(cases.selector),
        snapshot: reordered,
        semanticGraph: state.semanticGraph,
        runtimeProjection: state.beforeProjection
    })
    assert.deepEqual(replay, first)
    for (const name of [
        'scopeDigest',
        'semanticGraphInputDigest',
        'runtimeProjectionDigest'
    ]) assertSha(first[name], name)
    assert.equal(new Set(Object.values(first)).size, 3)

    const expectedDelivery = state.deliveryClassification
    assert.notEqual(expectedDelivery.scopeDigestBefore,
        expectedDelivery.scopeDigestAfter)
    assert.equal(expectedDelivery.semanticGraphInputDigestBefore,
        expectedDelivery.semanticGraphInputDigestAfter)
    assert.notEqual(expectedDelivery.runtimeProjectionDigestBefore,
        expectedDelivery.runtimeProjectionDigestAfter)
})

test('P03 registered delivery mutations reconcile before classification', async () => {
    const state = await baseline()
    const decision = state.deliveryClassification
    assert.equal(decision.dagUpdateMode, 'projection-only')
    assert.equal(decision.expectedRemoteMutationMatched, true)
    assert.equal(decision.expectedRemoteMutationDigest,
        state.expectedRemoteMutations.expectedRemoteMutationDigest)
    assert.deepEqual(decision.unmatchedExpectedMutations, [])
    assert.deepEqual(decision.unexpectedRemoteMutations, [])
    assert.match(decision.remoteMutationClassification,
        /matched-expected.*projection-only/iu)
    assert.equal(decision.dagUpdaterDispatchCount, 0)
})

test('P04 completion plus close leaves semantic digest stable and unlocks the successor', async () => {
    const state = await baseline()
    assert.equal(state.beforeProjection.completed.includes(
        'ExampleOrg/RepositoryA#1819'), false)
    assert.equal(state.afterProjection.completed.includes(
        'ExampleOrg/RepositoryA#1819'), true)
    assert.equal(state.afterProjection.readyFrontier.includes(
        'ExampleOrg/RepositoryA#1833'), true)
    assert.equal(state.deliveryClassification.semanticGraphDigestBefore,
        state.deliveryClassification.semanticGraphDigestAfter)
    const receipt = state.loaded.sealDagUpdateDecisionReceipt(
        projectionDecisionInput(state)
    )
    assert.equal(receipt.dagUpdateMode, 'projection-only')
    assert.equal(receipt.dagUpdaterDispatchRequestId, null)
    assert.equal(receipt.dagUpdaterDispatchReceiptDigest, null)
    assert.doesNotThrow(() => state.loaded.verifyDagUpdateDecisionReceipt(
        receipt,
        {
            expectedRemoteMutationDigest:
                state.expectedRemoteMutations.expectedRemoteMutationDigest
        }
    ))
})

test('P05 slot, lease, epoch, ready, candidate and cleanup are projection-only', async () => {
    const state = await baseline()
    const runtimeOnlyAfter = clone(cases.remoteBefore)
    runtimeOnlyAfter.runtime = {
        ...runtimeOnlyAfter.runtime,
        availableSlots: 0,
        leases: [{
            leaseId: 'lease-1833',
            issueId: 'ExampleOrg/RepositoryA#1833'
        }],
        epochId: 'epoch-1',
        candidateCommits: {
            'ExampleOrg/RepositoryA#1819': '1111111111111111111111111111111111111111'
        },
        cleanup: {
            'ExampleOrg/RepositoryA#1819': 'resources-clean'
        }
    }
    const afterProjection = state.loaded.projectRuntime({
        semanticGraph: state.semanticGraph,
        ledger: clone(cases.ledgerBefore),
        runtime: runtimeOnlyAfter.runtime
    })
    const decision = state.loaded.classifyRemoteMutations({
        selector: clone(cases.selector),
        before: clone(cases.remoteBefore),
        after: runtimeOnlyAfter,
        expectedRemoteMutations:
            state.loaded.sealExpectedRemoteMutations({
                schema: 'issue-orchestration.expected-remote-mutations.v1',
                runId: 'runtime-only',
                entries: []
            }),
        semanticGraph: state.semanticGraph,
        runtimeProjectionBefore: state.beforeProjection,
        runtimeProjectionAfter: afterProjection
    })
    assert.equal(decision.dagUpdateMode, 'projection-only')
    assert.equal(decision.dagUpdaterDispatchCount, 0)
    assert.equal(decision.semanticGraphInputDigestBefore,
        decision.semanticGraphInputDigestAfter)
    assert.notEqual(decision.runtimeProjectionDigestBefore,
        decision.runtimeProjectionDigestAfter)
})

test('P06 unexpected dependency/owner/contract/group change dispatches one patch updater', async () => {
    const state = await baseline()
    const decision = state.loaded.classifyRemoteMutations({
        selector: clone(cases.selector),
        before: clone(cases.remoteBefore),
        after: clone(cases.remoteAfterUnexpectedSemanticChange),
        expectedRemoteMutations:
            state.loaded.sealExpectedRemoteMutations({
                schema: 'issue-orchestration.expected-remote-mutations.v1',
                runId: 'semantic-change',
                entries: []
            }),
        semanticGraph: state.semanticGraph,
        runtimeProjectionBefore: state.beforeProjection,
        runtimeProjectionAfter: state.beforeProjection
    })
    assert.equal(decision.dagUpdateMode, 'semantic-patch')
    assert.notEqual(decision.semanticGraphInputDigestBefore,
        decision.semanticGraphInputDigestAfter)
    assert.equal(decision.requiredDagUpdaterDispatchCount, 1)
    assert.deepEqual(decision.allowedProposalKinds, ['minimal-patch'])
})

test('P07 patch validator accepts only recomputable minimal updater output', async () => {
    const state = await baseline()
    const patch = await semanticPatch(state)
    assert.equal(patch.schema, 'issue-orchestration.semantic-graph-patch.v1')
    assert.equal(patch.baseSemanticGraphDigest,
        state.semanticGraph.semanticGraphDigest)
    assert.ok(patch.operations.length > 0)
    assert.ok(patch.operations.every(({ type }) =>
        ALLOWED_PATCH_OPERATIONS.includes(type)))
    assert.equal(Object.hasOwn(patch, 'semanticGraph'), false)
    assert.equal(Object.hasOwn(patch, 'fullGraph'), false)
    assert.doesNotThrow(() => state.loaded.validateSemanticGraphPatch({
        baseSemanticGraph: state.semanticGraph,
        patch
    }))
    const next = state.loaded.applySemanticGraphPatch({
        baseSemanticGraph: state.semanticGraph,
        patch,
        actor: {
            actorRole: 'root-scheduler',
            acceptedWithoutModification: true,
            acceptedPatchDigest: patch.graphPatchDigest
        }
    })
    assert.equal(next.semanticGraphDigest, patch.resultSemanticGraphDigest)
    assert.equal(next.nodes.find(({ id }) =>
        id === 'ExampleOrg/RepositoryA#1833').owner, 'orchestration-v2')
})

test('P08 full proposal validator admits only initial create and evidenced recovery', async () => {
    const state = await baseline()
    const proposal = (mode, reason, evidenceDigests) => reseal({
        schema: 'issue-orchestration.semantic-graph-proposal.v1',
        mode,
        reason,
        semanticGraph: state.semanticGraph,
        evidenceDigests,
        authoredBy: graphAuthor()
    }, 'proposalDigest')
    assert.doesNotThrow(() => state.loaded.validateFullSemanticGraphProposal({
        proposal: proposal('full-create', 'initial-create', []),
        context: { initialGraphMissing: true }
    }))
    assert.doesNotThrow(() => state.loaded.validateFullSemanticGraphProposal({
        proposal: proposal('full-recovery', 'graph-corruption-recovery', [
            'f'.repeat(64)
        ]),
        context: {
            graphCorruptionReceiptDigest: 'f'.repeat(64)
        }
    }))
    assert.doesNotThrow(() => state.loaded.validateFullSemanticGraphProposal({
        proposal: proposal('full-recovery', 'scope-replacement', [
            'e'.repeat(64)
        ]),
        context: {
            explicitScopeReplacementReceiptDigest: 'e'.repeat(64)
        }
    }))
})

test('P09 projector is deterministic, read-only and owns execution projection only', async () => {
    const state = await baseline()
    const graphBefore = clone(state.semanticGraph)
    const ledger = clone(cases.ledgerAfterCompletion)
    const ledgerBefore = clone(ledger)
    const runtimeFacts = clone(cases.remoteAfterExpectedDelivery.runtime)
    const runtimeBefore = clone(runtimeFacts)
    const replay = state.loaded.projectRuntime({
        semanticGraph: state.semanticGraph,
        ledger,
        runtime: runtimeFacts
    })
    assert.deepEqual(replay, state.afterProjection)
    assert.deepEqual(state.semanticGraph, graphBefore)
    assert.deepEqual(ledger, ledgerBefore)
    assert.deepEqual(runtimeFacts, runtimeBefore)
    assert.ok(Array.isArray(replay.criticalPath))
    assert.equal(typeof replay.downstreamBlockedCount, 'object')
    assert.equal(typeof replay.conflictProjection, 'object')
    assert.equal(typeof replay.slotLeaseOccupancy, 'object')
    assert.deepEqual(replay.nextExecutableFrontier, replay.readyFrontier)
    for (const forbidden of [
        'operations',
        'graphPatch',
        'semanticGraph',
        'semanticGraphPatch'
    ]) assert.equal(Object.hasOwn(replay, forbidden), false)
})

test('P10 #1832 decision receipt fields and mode-specific nullability are complete', async () => {
    const state = await baseline()
    const projectionReceipt = state.loaded.sealDagUpdateDecisionReceipt(
        projectionDecisionInput(state)
    )
    assert.equal(projectionReceipt.schema,
        'issue-orchestration.dag-update-decision-receipt.v1')
    for (const field of DECISION_FIELDS) {
        assert.equal(Object.hasOwn(projectionReceipt, field), true,
            `missing #1832 field ${field}`)
    }
    assert.equal(projectionReceipt.graphPatchDigest, null)
    assert.equal(projectionReceipt.graphPatchOperationCount, 0)
    assert.equal(projectionReceipt.fullProposalReason, null)
    assertSha(projectionReceipt.receiptDigest, 'receiptDigest')

    const patch = await semanticPatch(state)
    const semanticReceipt = state.loaded.sealDagUpdateDecisionReceipt(
        projectionDecisionInput(state, {
            dagUpdateMode: 'semantic-patch',
            remoteMutationClassification: 'unexpected-semantic-change',
            expectedRemoteMutationMatched: false,
            semanticGraphInputDigestAfter: '9'.repeat(64),
            semanticGraphDigestAfter: patch.resultSemanticGraphDigest,
            runtimeProjectionDigestAfter:
                state.beforeProjection.runtimeProjectionDigest,
            graphPatchDigest: patch.graphPatchDigest,
            graphPatchOperationCount: patch.operations.length,
            dagUpdaterDispatchRequestId: 'dispatch-request-1833-1',
            dagUpdaterDispatchReceiptDigest: '8'.repeat(64)
        })
    )
    assert.equal(semanticReceipt.dagUpdateMode, 'semantic-patch')
    assert.equal(semanticReceipt.graphPatchOperationCount, patch.operations.length)
    assert.ok(semanticReceipt.dagUpdaterDispatchRequestId)
    assertSha(semanticReceipt.dagUpdaterDispatchReceiptDigest,
        'dagUpdaterDispatchReceiptDigest')
})

test('P11 #1826 telemetry is decision-derived and false positives stay zero', async () => {
    const state = await baseline()
    const receipts = [
        state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state)
        ),
        state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                dagUpdateMode: 'none',
                remoteMutationClassification: 'no-change',
                expectedRemoteMutationMatched: true,
                scopeDigestAfter:
                    state.deliveryClassification.scopeDigestBefore,
                runtimeProjectionDigestAfter:
                    state.beforeProjection.runtimeProjectionDigest
            })
        )
    ]
    const telemetry = state.loaded.summarizeDagUpdateTelemetry(receipts)
    assert.deepEqual(telemetry, {
        projectionOnlyCount: 1,
        semanticPatchCount: 0,
        fullCreateCount: 0,
        fullRecoveryCount: 0,
        falsePositiveDagDispatchCount: 0,
        graphPatchOperationCount: 0
    })
})

test('P12 acceptance-group expected delivery window remains projection-only', async () => {
    const state = await baseline()
    const decision = state.loaded.sealDagUpdateDecisionReceipt(
        projectionDecisionInput(state, {
            remoteMutationClassification:
                'acceptance-group-matched-expected-delivery-mutations'
        })
    )
    assert.equal(decision.dagUpdateMode, 'projection-only')
    assert.equal(decision.expectedRemoteMutationMatched, true)
    assert.equal(decision.dagUpdaterDispatchRequestId, null)
    assert.equal(decision.dagUpdaterDispatchReceiptDigest, null)
})

test('P13 local failures and execution events never request semantic work', async () => {
    const state = await baseline()
    for (const eventType of [
        'test.failure',
        'implementation.fix-cycle',
        'independent-verification.rejected',
        'slot.changed',
        'lease.changed',
        'epoch.changed',
        'cleanup.completed',
        'telemetry.recorded',
        'agent.suggestion'
    ]) {
        const receipt = state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                remoteMutationClassification: `runtime-event:${eventType}`
            })
        )
        assert.equal(receipt.dagUpdateMode, 'projection-only')
        assert.equal(receipt.dagUpdaterDispatchRequestId, null)
    }
})

const negativeControls = {
    'N01-completion-close-dispatches-updater': async (state, code) =>
        assertDenied(() => state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                dagUpdaterDispatchRequestId: 'dispatch-request-false-positive',
                dagUpdaterDispatchReceiptDigest: '1'.repeat(64)
            })
        ), code),
    'N02-runtime-digest-treated-as-semantic': async (state, code) =>
        assertDenied(() => state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                dagUpdateMode: 'semantic-patch',
                remoteMutationClassification: 'runtime-projection-only',
                expectedRemoteMutationMatched: false,
                graphPatchDigest: '2'.repeat(64),
                graphPatchOperationCount: 1,
                dagUpdaterDispatchRequestId: 'dispatch-request-invalid',
                dagUpdaterDispatchReceiptDigest: '3'.repeat(64)
            })
        ), code),
    'N03-ordinary-semantic-update-returns-full': async (state, code) =>
        assertDenied(() => state.loaded.validateFullSemanticGraphProposal({
            proposal: reseal({
                schema: 'issue-orchestration.semantic-graph-proposal.v1',
                mode: 'full-recovery',
                reason: 'ordinary-semantic-update',
                semanticGraph: state.semanticGraph,
                evidenceDigests: ['4'.repeat(64)],
                authoredBy: graphAuthor()
            }, 'proposalDigest'),
            context: {}
        }), code),
    'N04-root-skips-expected-mutation-reconciliation': async (state, code) =>
        assertDenied(() => state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                expectedRemoteMutationMatched: null
            })
        ), code),
    'N05-projector-modifies-semantic-edge': async (state, code) => {
        const projection = clone(state.afterProjection)
        projection.semanticEdges = [{
            from: 'ExampleOrg/RepositoryA#1833',
            to: 'ExampleOrg/RepositoryA#1819'
        }]
        projection.runtimeProjectionDigest =
            unsignedDigest(projection, 'runtimeProjectionDigest')
        return assertDenied(() => state.loaded.validateRuntimeProjection({
            semanticGraph: state.semanticGraph,
            ledger: clone(cases.ledgerAfterCompletion),
            runtime: clone(cases.remoteAfterExpectedDelivery.runtime),
            projection
        }), code)
    },
    'N06-local-failure-dispatches-updater': async (state, code) =>
        assertDenied(() => state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                remoteMutationClassification: 'runtime-event:test.failure',
                dagUpdaterDispatchRequestId: 'dispatch-request-local-red',
                dagUpdaterDispatchReceiptDigest: '5'.repeat(64)
            })
        ), code),
    'N07-patch-base-digest-mismatch': async (state, code) => {
        const patch = clone(await semanticPatch(state))
        patch.baseSemanticGraphDigest = '6'.repeat(64)
        patch.graphPatchDigest = unsignedDigest(patch, 'graphPatchDigest')
        return assertDenied(() => state.loaded.validateSemanticGraphPatch({
            baseSemanticGraph: state.semanticGraph,
            patch
        }), code)
    },
    'N08-scope-replacement-without-reason': async (state, code) =>
        assertDenied(() => state.loaded.validateFullSemanticGraphProposal({
            proposal: reseal({
                schema: 'issue-orchestration.semantic-graph-proposal.v1',
                mode: 'full-recovery',
                reason: null,
                semanticGraph: state.semanticGraph,
                evidenceDigests: ['7'.repeat(64)],
                authoredBy: graphAuthor()
            }, 'proposalDigest'),
            context: {
                explicitScopeReplacementReceiptDigest: '7'.repeat(64)
            }
        }), code),
    'N09-root-authored-patch': async (state, code) =>
        assertDenied(() => state.loaded.sealSemanticGraphPatch({
            baseSemanticGraph: state.semanticGraph,
            operations: [{
                type: 'change-owner',
                nodeId: 'ExampleOrg/RepositoryA#1833',
                from: 'orchestration',
                to: 'root-authored'
            }],
            evidenceDigests: ['8'.repeat(64)],
            authoredBy: graphAuthor({ actorRole: 'root-scheduler' })
        }), code),
    'N10-ordinary-patch-embeds-full-graph': async (state, code) => {
        const patch = clone(await semanticPatch(state))
        patch.fullGraph = clone(state.semanticGraph)
        patch.graphPatchDigest = unsignedDigest(patch, 'graphPatchDigest')
        return assertDenied(() => state.loaded.validateSemanticGraphPatch({
            baseSemanticGraph: state.semanticGraph,
            patch
        }), code)
    },
    'N11-patch-operation-not-allowed': async (state, code) =>
        assertDenied(() => state.loaded.sealSemanticGraphPatch({
            baseSemanticGraph: state.semanticGraph,
            operations: [{
                type: 'mark-ready',
                nodeId: 'ExampleOrg/RepositoryA#1833'
            }],
            evidenceDigests: ['9'.repeat(64)],
            authoredBy: graphAuthor()
        }), code),
    'N12-patch-result-digest-mismatch': async (state, code) => {
        const patch = clone(await semanticPatch(state))
        patch.resultSemanticGraphDigest = 'a'.repeat(64)
        patch.graphPatchDigest = unsignedDigest(patch, 'graphPatchDigest')
        return assertDenied(() => state.loaded.validateSemanticGraphPatch({
            baseSemanticGraph: state.semanticGraph,
            patch
        }), code)
    },
    'N13-graph-corruption-full-without-evidence': async (state, code) =>
        assertDenied(() => state.loaded.validateFullSemanticGraphProposal({
            proposal: reseal({
                schema: 'issue-orchestration.semantic-graph-proposal.v1',
                mode: 'full-recovery',
                reason: 'graph-corruption-recovery',
                semanticGraph: state.semanticGraph,
                evidenceDigests: [],
                authoredBy: graphAuthor()
            }, 'proposalDigest'),
            context: {}
        }), code),
    'N14-semantic-patch-without-exactly-one-dispatch': async (state, code) =>
        assertDenied(() => state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state, {
                dagUpdateMode: 'semantic-patch',
                remoteMutationClassification: 'unexpected-semantic-change',
                expectedRemoteMutationMatched: false,
                semanticGraphInputDigestAfter: 'b'.repeat(64),
                semanticGraphDigestAfter: 'c'.repeat(64),
                graphPatchDigest: 'd'.repeat(64),
                graphPatchOperationCount: 1,
                dagUpdaterDispatchRequestId: null,
                dagUpdaterDispatchReceiptDigest: null
            })
        ), code),
    'N15-false-positive-dag-dispatch-count-nonzero': async (state, code) => {
        const receipt = reseal({
            ...state.loaded.sealDagUpdateDecisionReceipt(
                projectionDecisionInput(state)
            ),
            dagUpdaterDispatchRequestId: 'forged-request',
            dagUpdaterDispatchReceiptDigest: 'e'.repeat(64)
        }, 'receiptDigest')
        return assertDenied(() =>
            state.loaded.summarizeDagUpdateTelemetry([receipt]), code)
    },
    'N16-expected-mutation-digest-mismatch': async (state, code) => {
        const receipt = state.loaded.sealDagUpdateDecisionReceipt(
            projectionDecisionInput(state)
        )
        return assertDenied(() => state.loaded.verifyDagUpdateDecisionReceipt(
            receipt,
            { expectedRemoteMutationDigest: 'f'.repeat(64) }
        ), code)
    },
    'N17-runtime-projection-embeds-graph-patch': async (state, code) => {
        const projection = clone(state.afterProjection)
        projection.graphPatch = {
            operations: []
        }
        projection.runtimeProjectionDigest =
            unsignedDigest(projection, 'runtimeProjectionDigest')
        return assertDenied(() => state.loaded.validateRuntimeProjection({
            semanticGraph: state.semanticGraph,
            ledger: clone(cases.ledgerAfterCompletion),
            runtime: clone(cases.remoteAfterExpectedDelivery.runtime),
            projection
        }), code)
    },
    'N18-three-layer-digest-alias': async (state, code) =>
        assertDenied(() => state.loaded.computeDigestLayers({
            selector: clone(cases.selector),
            snapshot: clone(cases.remoteBefore),
            semanticGraph: {
                ...state.semanticGraph,
                semanticGraphInputDigest: state.semanticGraph.scopeDigest
            },
            runtimeProjection: {
                ...state.beforeProjection,
                runtimeProjectionDigest: state.semanticGraph.scopeDigest
            }
        }), code),
    'N19-dag-decision-receipt-field-omitted': async (state, code) => {
        const input = projectionDecisionInput(state)
        delete input.projectorDigest
        return assertDenied(() =>
            state.loaded.sealDagUpdateDecisionReceipt(input), code)
    }
}

for (const control of controls) {
    test(control.id, async () => {
        const operation = negativeControls[control.id]
        assert.equal(typeof operation, 'function',
            `missing executable mutation control ${control.id}`)
        const state = await baseline()
        await operation(state, control.expectedCode)
    })
}
