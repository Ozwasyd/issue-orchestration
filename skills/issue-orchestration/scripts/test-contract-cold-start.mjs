import fs from 'node:fs'
import path from 'node:path'

import {
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    remoteIssueFactDigest,
    verifySelectorReceipt
} from './scope-selector.mjs'
import {
    compileRequirementInventory,
    compileIssueAcceptanceContract
} from './issue-requirement-authority.mjs'
import {
    compileDeterministicSlicePolicy,
    compileSlicePlanValidation,
    verifySlicePlanValidation
} from './slice-plan-validator.mjs'
import {
    compileCanonicalRoute,
    validateExecutionRouteDecision,
    validateRouteBoundActor
} from './execution-route-compiler.mjs'
import {
    compileRuntimeExecutionBinding
} from './runtime-execution-binding.mjs'
import {
    compileDispatchPrompt,
    compileExecutableSlice,
    compileStageWorkPlan,
    persistWriterResourceAuthority,
    sealFrozenStageContract
} from './executable-slice-compiler.mjs'
import {
    canonicalNodeStateLocation,
    compileControlEvent,
    createControlLedger,
    persistAggregateRunState,
    readCanonicalControlLedger,
    readCanonicalNodeLedger
} from './multi-node-state.mjs'
import {
    replayEventLedgerSync,
    sealNodeLedgerHeader
} from './event-ledger.mjs'

const HASH = /^[a-f0-9]{64}$/u
const GIT_SHA = /^[a-f0-9]{40}$/u
const GENESIS = '0'.repeat(64)

function validateAcceptanceContract(value) {
    if (value?.schema !==
            'issue-orchestration.issue-acceptance-contract.v1' ||
        value.status !== 'frozen' ||
        value.contractDigest !==
            unsignedDigest(value, 'contractDigest')) {
        fail('test-planning-acceptance-contract')
    }
    return value
}

function validateRoute(value, phase) {
    try {
        return validateExecutionRouteDecision(value, {
            stageRole: 'test-owner',
            stagePhase: phase
        })
    } catch {
        fail('test-planning-route')
    }
}

function normalizedComment(comment) {
    const id = comment?.id ?? comment?.databaseId
    assertText(String(id ?? ''), 'cold-start-comment-id')
    assertText(comment?.body, 'cold-start-comment-body')
    return {
        id: String(id),
        body: comment.body,
        updatedAt: comment.updatedAt ?? null,
        relevantToCorrectness: true
    }
}

function sourceBlock({
    sourceIdentity,
    sourceKind,
    text,
    relevantToCorrectness = null
}) {
    assertText(text, 'cold-start-source-text')
    const body = {
        sourceIdentity,
        sourceKind,
        normative: true,
        spanDigest: digest({ sourceIdentity, sourceKind, text })
    }
    if (sourceKind === 'comment') {
        body.relevantToCorrectness = relevantToCorrectness === true
    }
    return body
}

export function compileColdStartIssueSnapshot({
    issue,
    selectorReceipt
} = {}) {
    const selector = verifySelectorReceipt(selectorReceipt)
    if (!issue || typeof issue !== 'object' ||
        !/^[^/\s]+\/[^/\s]+$/u.test(issue.repository ?? '') ||
        !Number.isInteger(issue.number) || issue.number < 1 ||
        issue.state !== 'OPEN' ||
        !GIT_SHA.test(issue.baseSha ?? '')) {
        fail('cold-start-issue-snapshot-invalid')
    }
    const identity = `${issue.repository}#${issue.number}`
    if (!selector.resolvedIssueSet.includes(identity) ||
        !HASH.test(selector.remoteFactDigests?.[identity] ?? '') ||
        selector.remoteFactDigests[identity] !==
            remoteIssueFactDigest(issue)) {
        fail('cold-start-selector-member-stale')
    }
    const relevantComments = (issue.comments ?? [])
        .filter((comment) =>
            comment?.relevant === true ||
            comment?.relevantToCorrectness === true)
        .map(normalizedComment)
        .sort((left, right) => left.id.localeCompare(right.id))
    const normativeBlocks = [
        sourceBlock({
            sourceIdentity: `${identity}:title`,
            sourceKind: 'title',
            text: issue.title
        }),
        sourceBlock({
            sourceIdentity: `${identity}:body`,
            sourceKind: 'body',
            text: issue.body
        }),
        ...relevantComments.map((comment) => sourceBlock({
            sourceIdentity: `${identity}:comment:${comment.id}`,
            sourceKind: 'comment',
            text: comment.body,
            relevantToCorrectness: true
        }))
    ]
    const snapshot = {
        schema: 'issue-orchestration.cold-start-issue-snapshot.v1',
        repository: issue.repository,
        issueNumber: issue.number,
        issueIdentity: identity,
        state: issue.state,
        baseSha: issue.baseSha,
        title: issue.title,
        bodyDigest: digest(issue.body),
        relevantCommentsDigest: digest(relevantComments),
        selectorReceiptDigest: selector.receiptDigest,
        selectorDigest: selector.selectorDigest,
        remoteSnapshotDigest: selector.remoteSnapshotDigest,
        remoteMemberDigest: selector.remoteFactDigests[identity],
        normativeBlocks,
        sourceCoverageDigest: digest(normativeBlocks.map((block) => ({
            sourceIdentity: block.sourceIdentity,
            sourceKind: block.sourceKind,
            spanDigest: block.spanDigest
        }))),
        issueSnapshotFingerprint: digest({
            identity,
            state: issue.state,
            title: issue.title,
            body: issue.body,
            comments: relevantComments,
            labels: [...(issue.labels ?? [])].sort(),
            dependencies: [...(issue.dependsOn ?? [])].sort(),
            baseSha: issue.baseSha
        }),
        repositoryFingerprint: digest({
            repository: issue.repository,
            baseSha: issue.baseSha
        })
    }
    snapshot.snapshotDigest = digest(snapshot)
    return Object.freeze(snapshot)
}

function validateColdStartSnapshot(snapshot) {
    if (snapshot?.schema !==
            'issue-orchestration.cold-start-issue-snapshot.v1' ||
        snapshot.snapshotDigest !== digest(
            Object.fromEntries(Object.entries(snapshot).filter(
                ([key]) => key !== 'snapshotDigest'))
        ) ||
        !Array.isArray(snapshot.normativeBlocks) ||
        snapshot.normativeBlocks.length < 2 ||
        !HASH.test(snapshot.sourceCoverageDigest ?? '') ||
        !HASH.test(snapshot.issueSnapshotFingerprint ?? '') ||
        !HASH.test(snapshot.repositoryFingerprint ?? '') ||
        !GIT_SHA.test(snapshot.baseSha ?? '')) {
        fail('cold-start-issue-snapshot-invalid')
    }
    return snapshot
}

export function compileNodeDiscoveredReceipt({
    runId,
    nodeId,
    nodeEpoch = 1,
    snapshot,
    semanticProposal,
    inventory,
    acceptanceContract
} = {}) {
    assertText(runId, 'node-discovered-run-id')
    assertText(nodeId, 'node-discovered-node-id')
    if (!Number.isInteger(nodeEpoch) || nodeEpoch < 1) {
        fail('node-discovered-epoch')
    }
    const source = validateColdStartSnapshot(snapshot)
    const acceptance = validateAcceptanceContract(acceptanceContract)
    if (semanticProposal?.schema !==
            'issue-orchestration.issue-requirement-inventory-proposal.v1' ||
        semanticProposal.rootAuthored !== false ||
        semanticProposal.repository !== source.repository ||
        semanticProposal.issueNumber !== source.issueNumber ||
        semanticProposal.proposalDigest !==
            unsignedDigest(semanticProposal, 'proposalDigest') ||
        inventory?.schema !==
            'issue-orchestration.issue-requirement-inventory.v1' ||
        inventory.inventoryDigest !==
            unsignedDigest(inventory, 'inventoryDigest') ||
        acceptance.inventoryDigest !== inventory.inventoryDigest ||
        acceptance.selectorReceiptDigest !==
            source.selectorReceiptDigest ||
        acceptance.remoteSnapshotDigest !==
            source.remoteSnapshotDigest ||
        !sameValue(
            inventory.requirements.map((item) => ({
                sourceIdentity: item.sourceIdentity,
                sourceSpanDigest: item.sourceSpanDigest
            })).sort((left, right) =>
                left.sourceIdentity.localeCompare(right.sourceIdentity)),
            source.normativeBlocks.map((block) => ({
                sourceIdentity: block.sourceIdentity,
                sourceSpanDigest: block.spanDigest
            })).sort((left, right) =>
                left.sourceIdentity.localeCompare(right.sourceIdentity))
        )) {
        fail('node-discovered-chain-binding')
    }
    return seal({
        schema: 'issue-orchestration.node-discovered-receipt.v1',
        status: 'verified',
        producerAuthority: 'deterministic-cold-start-compiler',
        rootAuthored: false,
        runId,
        nodeId,
        memberId: nodeId,
        repository: source.repository,
        issueNumber: source.issueNumber,
        baseSha: source.baseSha,
        nodeEpoch,
        selectorReceiptDigest: source.selectorReceiptDigest,
        remoteSnapshotDigest: source.remoteSnapshotDigest,
        remoteMemberDigest: source.remoteMemberDigest,
        issueSnapshotFingerprint:
            source.issueSnapshotFingerprint,
        repositoryFingerprint: source.repositoryFingerprint,
        semanticProposalDigest: semanticProposal.proposalDigest,
        semanticRouteDecisionDigest:
            (semanticProposal.actorRuntime?.routeDecision ??
                semanticProposal.actorRuntime?.executionRouteDecision)
                ?.routeDecisionDigest ??
            semanticProposal.actorRuntime?.routeDecisionDigest,
        semanticFactsDigest: digest({
            repository: source.repository,
            issueNumber: source.issueNumber,
            remoteMemberDigest: source.remoteMemberDigest,
            classifications: semanticProposal.classifications
        }),
        requirementInventoryDigest: inventory.inventoryDigest,
        sourceCoverageDigest: inventory.sourceCoverageDigest,
        acceptanceContractDigest: acceptance.contractDigest
    }, 'receiptDigest')
}

export function verifyNodeDiscoveredReceipt(receipt, expected = {}) {
    if (receipt?.schema !==
            'issue-orchestration.node-discovered-receipt.v1' ||
        receipt.status !== 'verified' ||
        receipt.producerAuthority !==
            'deterministic-cold-start-compiler' ||
        receipt.rootAuthored !== false ||
        receipt.receiptDigest !==
            unsignedDigest(receipt, 'receiptDigest')) {
        fail('node-discovered-receipt-invalid')
    }
    for (const [field, value] of Object.entries(expected)) {
        if (value !== undefined && !sameValue(receipt[field], value)) {
            fail('node-discovered-receipt-stale')
        }
    }
    return Object.freeze(structuredClone(receipt))
}

export function compileTestContractPlanningRequest({
    nodeDiscoveredReceipt,
    acceptanceContract,
    routeDecision,
    attemptId
}) {
    const acceptance = validateAcceptanceContract(acceptanceContract)
    const discovered = verifyNodeDiscoveredReceipt(
        nodeDiscoveredReceipt,
        {
            repository: acceptance.repository,
            issueNumber: acceptance.issueNumber,
            acceptanceContractDigest: acceptance.contractDigest
        }
    )
    const route = validateRoute(
        routeDecision,
        'test-contract-planning'
    )
    assertText(attemptId, 'test-planning-attempt')
    return seal({
        schema:
            'issue-orchestration.test-contract-planning-request.v1',
        phase: 'test-contract-planning',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        freshContext: true,
        attemptId,
        repository: acceptance.repository,
        issueNumber: acceptance.issueNumber,
        nodeDiscoveredReceiptDigest: discovered.receiptDigest,
        acceptanceContractDigest: acceptance.contractDigest,
        routeDecisionDigest: route.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            route.runtimeExecutionBindingDigest,
        allowedInputs: [
            'immutable-acceptance-contract',
            'repository-facts',
            'current-tests',
            'current-docs',
            'necessary-runtime-probes'
        ],
        forbiddenWrites: ['tests', 'implementation', 'documentation', 'dag']
    }, 'requestDigest')
}

export function verifyTestContractPlanReceipt({
    receipt,
    request
}) {
    if (receipt?.schema !==
            'issue-orchestration.test-contract-plan-receipt.v1' ||
        receipt.status !== 'verified' ||
        receipt.rootAuthored !== false) {
        fail('test-planning-authority')
    }
    try {
        validateRouteBoundActor({
            actor: receipt,
            stageRole: 'test-owner',
            stagePhase: 'test-contract-planning',
            proposalOnly: true
        })
    } catch {
        fail('test-planning-authority')
    }
    if (receipt.attemptId !== request?.attemptId ||
        receipt.acceptanceContractDigest !==
            request.acceptanceContractDigest ||
        receipt.runtimeExecutionBindingDigest !==
            request.runtimeExecutionBindingDigest ||
        receipt.routeDecisionDigest !== request.routeDecisionDigest ||
        receipt.nodeDiscoveredReceiptDigest !==
            request.nodeDiscoveredReceiptDigest ||
        receipt.requestDigest !== request.requestDigest) {
        fail('test-planning-request-binding')
    }
    assertDigest(
        receipt.mutationPostconditionReceiptDigest,
        'test-planning-mutation-postcondition'
    )
    if (!Array.isArray(receipt.filesystemWrites) ||
        receipt.filesystemWrites.length !== 0) {
        fail('test-planning-protected-mutation')
    }
    for (const field of [
        'testPaths',
        'commands',
        'fixturePaths',
        'runtimeProbes',
        'stageBoundaries'
    ]) {
        if (!Array.isArray(receipt[field])) {
            fail('test-planning-output')
        }
    }
    assertDigest(
        receipt.sliceProposalDigest,
        'test-planning-slice-proposal'
    )
    if (receipt.receiptDigest !==
        unsignedDigest(receipt, 'receiptDigest')) {
        fail('test-planning-receipt-digest')
    }
    return Object.freeze(structuredClone(receipt))
}

function validatePlanningInvestigation({
    receipt,
    request,
    snapshot,
    planningReceipt
}) {
    if (receipt?.schema !==
            'issue-orchestration.test-planning-investigation-receipt.v1' ||
        receipt.status !== 'verified' ||
        receipt.actorRole !== 'test-owner' ||
        receipt.phase !== 'test-contract-planning' ||
        receipt.rootAuthored !== false ||
        receipt.attemptId !== request.attemptId ||
        receipt.requestDigest !== request.requestDigest ||
        receipt.sourceFingerprint !==
            snapshot.issueSnapshotFingerprint ||
        receipt.acceptanceContractDigest !==
            request.acceptanceContractDigest ||
        receipt.routeDecisionDigest !== request.routeDecisionDigest ||
        receipt.runtimeExecutionBindingDigest !==
            request.runtimeExecutionBindingDigest ||
        receipt.mutationPostconditionReceiptDigest !==
            planningReceipt.mutationPostconditionReceiptDigest ||
        receipt.receiptDigest !==
            unsignedDigest(receipt, 'receiptDigest')) {
        fail('test-planning-investigation-binding')
    }
    return receipt
}

function validatePlanningSliceProposal({
    proposal,
    request,
    planningReceipt
}) {
    if (proposal?.schema !==
            'issue-orchestration.slice-plan-proposal.v1' ||
        proposal.proposalAuthoredBy !==
            'test-owner:test-contract-planning' ||
        proposal.rootAuthored !== false ||
        proposal.acceptanceContractDigest !==
            request.acceptanceContractDigest ||
        proposal.stageRole !== 'test-owner' ||
        proposal.stagePhase !== 'test-contract' ||
        proposal.planningAttemptId !== request.attemptId ||
        proposal.routeDecisionDigest !== request.routeDecisionDigest ||
        proposal.runtimeExecutionBindingDigest !==
            request.runtimeExecutionBindingDigest ||
        proposal.mutationPostconditionReceiptDigest !==
            planningReceipt.mutationPostconditionReceiptDigest ||
        proposal.proposalDigest !==
            unsignedDigest(proposal, 'proposalDigest')) {
        fail('test-planning-slice-proposal-binding')
    }
    try {
        validateRouteBoundActor({
            actor: proposal.actorRuntime,
            stageRole: 'test-owner',
            stagePhase: 'test-contract-planning',
            proposalOnly: true
        })
    } catch {
        fail('test-planning-slice-proposal-binding')
    }
    return proposal
}

export function compileTestContractPlanningBundle({
    request,
    snapshot,
    planningReceipt,
    investigationReceipt,
    sliceProposal
}) {
    const source = validateColdStartSnapshot(snapshot)
    const receipt = verifyTestContractPlanReceipt({
        receipt: planningReceipt,
        request
    })
    const investigation = validatePlanningInvestigation({
        receipt: investigationReceipt,
        request,
        snapshot: source,
        planningReceipt: receipt
    })
    const proposal = validatePlanningSliceProposal({
        proposal: sliceProposal,
        request,
        planningReceipt: receipt
    })
    if (receipt.sliceProposalDigest !== proposal.proposalDigest) {
        fail('test-planning-slice-proposal-binding')
    }
    return seal({
        schema:
            'issue-orchestration.test-contract-planning-bundle.v1',
        status: 'verified',
        attemptId: request.attemptId,
        requestDigest: request.requestDigest,
        nodeDiscoveredReceiptDigest:
            request.nodeDiscoveredReceiptDigest,
        acceptanceContractDigest:
            request.acceptanceContractDigest,
        routeDecisionDigest: request.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            request.runtimeExecutionBindingDigest,
        mutationPostconditionReceiptDigest:
            receipt.mutationPostconditionReceiptDigest,
        planningReceipt: receipt,
        planningReceiptDigest: receipt.receiptDigest,
        investigationReceipt:
            structuredClone(investigation),
        investigationReceiptDigest:
            investigation.receiptDigest,
        sliceProposal: structuredClone(proposal),
        sliceProposalDigest: proposal.proposalDigest,
        protectedFilesystemWrites: []
    }, 'bundleDigest')
}

export function verifyTestContractPlanningBundle({
    bundle,
    request,
    snapshot
}) {
    const expected = compileTestContractPlanningBundle({
        request,
        snapshot,
        planningReceipt: bundle?.planningReceipt,
        investigationReceipt: bundle?.investigationReceipt,
        sliceProposal: bundle?.sliceProposal
    })
    if (!sameValue(expected, bundle)) {
        fail('test-planning-bundle-stale')
    }
    return Object.freeze(structuredClone(bundle))
}

function compileNodeEvent({
    ledger,
    eventType,
    fromState,
    toState,
    attemptId,
    actorRole,
    sourceDagDigest,
    issueSnapshotFingerprint,
    repositoryFingerprint,
    baseSha,
    payload,
    evidenceRefs,
    createdAt
}) {
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: `${eventType}:${ledger.events.length + 1}`,
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        nodeId: ledger.header.nodeId,
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        baseSha,
        payload: structuredClone(payload),
        payloadDigest: digest(payload),
        evidenceRefs: [...evidenceRefs],
        createdAt,
        previousEventDigest:
            ledger.events.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = digest(event)
    return Object.freeze(event)
}

function discoveryState({
    stateRoot,
    runId,
    nodeId,
    nodeEpoch,
    snapshot,
    nodeDiscoveredReceipt,
    issueKind,
    sourceDagDigest,
    createdAt,
    dependencyKeys = [],
    acceptanceGroup = null
}) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    fs.chmodSync(stateRoot, 0o700)
    const existingLocation = canonicalNodeStateLocation({
        stateRoot,
        runId,
        nodeId
    })
    if (fs.existsSync(existingLocation.ledgerPath)) {
        const ledger = readCanonicalNodeLedger({
            stateRoot,
            runId,
            nodeId
        })
        const controlLedger = readCanonicalControlLedger({
            stateRoot,
            runId
        })
        const projection = replayEventLedgerSync(ledger)
        const discovered = ledger.events[0]
        if (ledger.header.nodeEpoch !== nodeEpoch ||
            ledger.header.repository !== snapshot.repository ||
            ledger.header.issueNumber !== snapshot.issueNumber ||
            ledger.header.baseSha !== snapshot.baseSha ||
            ledger.header.selectorReceiptDigest !==
                snapshot.selectorReceiptDigest ||
            ledger.header.remoteMemberDigest !==
                snapshot.remoteMemberDigest ||
            discovered?.eventType !== 'node.discovered' ||
            discovered.payload?.nodeDiscoveredReceiptDigest !==
                nodeDiscoveredReceipt.receiptDigest ||
            !sameValue(
                discovered.payload?.nodeDiscoveredReceipt,
                nodeDiscoveredReceipt
            ) ||
            projection.nodeId !== nodeId) {
            fail('cold-start-discovery-state-conflict')
        }
        return { controlLedger, ledger }
    }
    const header = sealNodeLedgerHeader({
        runId,
        nodeId,
        memberId: nodeId,
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteMemberDigest: snapshot.remoteMemberDigest,
        nodeEpoch,
        stateRootCanonical: path.resolve(stateRoot),
        baseSha: snapshot.baseSha,
        issueSnapshotFingerprint:
            snapshot.issueSnapshotFingerprint,
        repositoryFingerprint: snapshot.repositoryFingerprint,
        createdAt
    })
    const ledger = { header, events: [] }
    ledger.events.push(compileNodeEvent({
        ledger,
        eventType: 'node.discovered',
        fromState: 'none',
        toState: 'discovered',
        attemptId: null,
        actorRole: 'dag-creator-updater',
        sourceDagDigest,
        issueSnapshotFingerprint:
            snapshot.issueSnapshotFingerprint,
        repositoryFingerprint: snapshot.repositoryFingerprint,
        baseSha: snapshot.baseSha,
        payload: {
            issueKind,
            nodeDiscoveredReceipt,
            nodeDiscoveredReceiptDigest:
                nodeDiscoveredReceipt.receiptDigest,
            sourceReceiptDigest:
                nodeDiscoveredReceipt.receiptDigest
        },
        evidenceRefs: [
            nodeDiscoveredReceipt.receiptDigest,
            nodeDiscoveredReceipt.acceptanceContractDigest
        ],
        createdAt
    }))
    replayEventLedgerSync(ledger)
    const controlLedger = createControlLedger({ runId, createdAt })
    controlLedger.events.push(compileControlEvent({
        ledger: controlLedger,
        eventType: 'scope.refreshed',
        payload: {
            selectorReceiptDigest:
                snapshot.selectorReceiptDigest
        },
        createdAt
    }))
    controlLedger.events.push(compileControlEvent({
        ledger: controlLedger,
        eventType: 'remote-snapshot.refreshed',
        payload: {
            remoteSnapshotDigest:
                snapshot.remoteSnapshotDigest
        },
        createdAt
    }))
    controlLedger.events.push(compileControlEvent({
        ledger: controlLedger,
        eventType: 'node.registered',
        payload: {
            nodeId,
            memberId: nodeId,
            repository: snapshot.repository,
            issueNumber: snapshot.issueNumber,
            selectorReceiptDigest:
                snapshot.selectorReceiptDigest,
            remoteMemberDigest: snapshot.remoteMemberDigest,
            nodeEpoch,
            baseSha: snapshot.baseSha,
            dependencyKeys,
            acceptanceGroup
        },
        createdAt
    }))
    persistAggregateRunState({
        stateRoot,
        controlLedger,
        nodeLedgers: [ledger]
    })
    return { controlLedger, ledger }
}

function stageDataFromBundle({
    acceptanceContract,
    bundle,
    validationReceipt
}) {
    const proposal = bundle.sliceProposal
    const deterministicSlicePolicy =
        compileDeterministicSlicePolicy({
            acceptanceContract,
            proposal,
            validationReceipt
        })
    return {
        proposal,
        deterministicSlicePolicy,
        orderedSlices:
            deterministicSlicePolicy.orderedSliceBlueprints,
        sliceDependencyGraph: Object.fromEntries(
            deterministicSlicePolicy.orderedSliceBlueprints.map(
                (slice) => [
                    slice.sliceId,
                    [...slice.prerequisiteSliceIds]
                ]
            )
        ),
        stageObjective: proposal.objective,
        stageAllowedPaths: [...proposal.allowedPaths],
        stageForbiddenPaths: [...proposal.forbiddenPaths],
        stageRequiredCommands: [...proposal.requiredCommands],
        stageTerminalArtifacts: [
            'test-contract-plan',
            'test-contract-files',
            'test-contract-command-evidence'
        ]
    }
}

function compileWriterArtifacts({
    input,
    snapshot,
    acceptanceContract,
    bundle,
    nodeDiscoveredReceipt,
    discovery,
    validationReceipt,
    stageData
}) {
    const writerAttemptId = input.writerAttemptId
    assertText(writerAttemptId, 'test-contract-writer-attempt')
    if (writerAttemptId === bundle.attemptId) {
        fail('test-contract-attempt-separation')
    }
    const testContractDigest = digest({
        schema: 'issue-orchestration.planned-test-contract.v1',
        acceptanceContractDigest:
            acceptanceContract.contractDigest,
        planningBundleDigest: bundle.bundleDigest,
        deterministicSlicePolicy:
            stageData.deterministicSlicePolicy
    })
    const writerResource = input.writerResource
    if (!writerResource) {
        return {
            next: 'acquire-test-contract-writer-resource',
            testContractDigest,
            resourceRequest: Object.freeze({
                schema:
                    'issue-orchestration.writer-resource-request.v1',
                runId: input.runId,
                nodeId: input.nodeId,
                writerAttemptId,
                stageRole: 'test-owner',
                stagePhase: 'test-contract',
                repository: snapshot.repository,
                baseSha: snapshot.baseSha,
                epochId: `epoch-node-${input.nodeEpoch ?? 1}`,
                allowedPaths:
                    [...stageData.stageAllowedPaths],
                testContractDigest,
                firstSliceId:
                    stageData.orderedSlices[0].sliceId
            })
        }
    }
    const resourceReceipt = persistWriterResourceAuthority({
        runId: input.runId,
        node: input.nodeId,
        stageAttemptId: writerAttemptId,
        stageRole: 'test-owner',
        baseSha: snapshot.baseSha,
        epochId: `epoch-node-${input.nodeEpoch ?? 1}`,
        worktreeIdentity: writerResource.worktreeIdentity,
        stageAllowedPaths: stageData.stageAllowedPaths,
        testContractDigest,
        resourceRegistry: writerResource.resourceRegistry,
        resourceLease: writerResource.resourceLease
    })
    const frozenStageContract = sealFrozenStageContract({
        schema: 'issue-orchestration.frozen-stage-contract-input.v1',
        runId: input.runId,
        repository: snapshot.repository,
        issue: snapshot.issueIdentity,
        node: input.nodeId,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        baseSha: snapshot.baseSha,
        epochId: `epoch-node-${input.nodeEpoch ?? 1}`,
        worktreeIdentity: writerResource.worktreeIdentity,
        testContractDigest,
        skillDigest: input.skillDigest,
        baselineDigest: input.baselineDigest,
        routingInputDigest: bundle.bundleDigest,
        stageObjective: stageData.stageObjective,
        acceptanceItems:
            acceptanceContract.executableAcceptanceIds,
        stageAllowedPaths: stageData.stageAllowedPaths,
        stageForbiddenPaths: stageData.stageForbiddenPaths,
        stageRequiredCommands: stageData.stageRequiredCommands,
        stageTerminalArtifacts:
            stageData.stageTerminalArtifacts,
        stageAttemptId: writerAttemptId,
        deterministicSlicePolicy:
            stageData.deterministicSlicePolicy,
        authoredByRole: 'test-owner',
        rootAuthored: false
    })
    const stageWorkPlan = compileStageWorkPlan({
        schema: 'issue-orchestration.stage-work-plan-input.v1',
        runId: input.runId,
        repository: snapshot.repository,
        issue: snapshot.issueIdentity,
        node: input.nodeId,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        baseSha: snapshot.baseSha,
        epochId: `epoch-node-${input.nodeEpoch ?? 1}`,
        worktreeIdentity: writerResource.worktreeIdentity,
        semanticContractDigest:
            frozenStageContract.semanticContractDigest,
        testContractDigest,
        authorityDigest: frozenStageContract.authorityDigest,
        skillDigest: input.skillDigest,
        baselineDigest: input.baselineDigest,
        routingInputDigest: bundle.bundleDigest,
        stageObjective: stageData.stageObjective,
        acceptanceItems:
            acceptanceContract.executableAcceptanceIds,
        orderedSlices: stageData.orderedSlices,
        sliceDependencyGraph:
            stageData.sliceDependencyGraph,
        stageAllowedPaths: stageData.stageAllowedPaths,
        stageForbiddenPaths: stageData.stageForbiddenPaths,
        stageRequiredCommands: stageData.stageRequiredCommands,
        stageTerminalArtifacts:
            stageData.stageTerminalArtifacts,
        frozenStageContract
    })
    const executableSlice = compileExecutableSlice({
        plan: stageWorkPlan,
        sliceId: stageData.orderedSlices[0].sliceId
    })
    const compiledPrompt = compileDispatchPrompt({
        plan: stageWorkPlan,
        slice: executableSlice
    })
    const routeBase = {
        stageWorkPlan,
        executableSlice,
        routingClassification:
            input.writerRoute?.routingClassification,
        executionMetrics: input.writerRoute?.executionMetrics,
        machineClassificationEvidence:
            input.writerRoute?.machineClassificationEvidence,
        runtimeAvailabilityBinding:
            input.writerRoute?.runtimeAvailabilityBinding
    }
    const pendingRouteBundle = compileCanonicalRoute(routeBase)
    const pendingRouteDecision =
        pendingRouteBundle.executionRouteDecision
    if (!input.writerRuntime) {
        return {
            next: 'bind-test-contract-writer-runtime',
            testContractDigest,
            resourceReceipt,
            frozenStageContract,
            stageWorkPlan,
            executableSlice,
            compiledPrompt,
            pendingRouteBundle,
            runtimeBindingRequest: Object.freeze({
                schema:
                    'issue-orchestration.writer-runtime-binding-request.v1',
                stageRole: 'test-owner',
                stagePhase: 'test-contract',
                selectedProfile:
                    pendingRouteDecision.selectedProfile,
                routeDecisionDigest:
                    pendingRouteDecision.routeDecisionDigest,
                writeLeaseDigest:
                    writerResource.resourceLease.leaseDigest
            })
        }
    }
    const runtimeExecutionBinding =
        compileRuntimeExecutionBinding({
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            selectedProfile:
                pendingRouteDecision.selectedProfile,
            routeDecisionDigest:
                pendingRouteDecision.routeDecisionDigest,
            runtimeObservation:
                input.writerRuntime.executionObservation,
            startup: input.writerRuntime.startup,
            runtimeTrustBinding:
                input.writerRuntime.runtimeTrustBinding,
            repositoryTargets:
                input.writerRuntime.repositoryTargets,
            writeLeaseDigest:
                writerResource.resourceLease.leaseDigest
        })
    const finalRouteBundle = compileCanonicalRoute({
        ...routeBase,
        startup: input.writerRuntime.startup,
        runtimeTrustBinding:
            input.writerRuntime.runtimeTrustBinding,
        repositoryTargets:
            input.writerRuntime.repositoryTargets,
        runtimeExecutionBinding,
        runtimeCapabilityObservation:
            input.writerRuntime.capabilityObservation
    })
    const routeDecision = finalRouteBundle.executionRouteDecision
    const dispatch = compileTestContractWriterDispatch({
        acceptanceContract,
        planningReceipt: bundle.planningReceipt,
        routeDecision,
        writerAttemptId,
        resourceReceipt,
        compiledPlanDigest: stageWorkPlan.planDigest,
        executableSliceDigest: executableSlice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        planningBundleDigest: bundle.bundleDigest,
        frozenStageContractReceiptDigest:
            frozenStageContract.receiptDigest
    })
    const stageEvent = compileNodeEvent({
        ledger: discovery.ledger,
        eventType: 'stage.contract-frozen',
        fromState: 'discovered',
        toState: 'discovered',
        attemptId: writerAttemptId,
        actorRole: 'root-scheduler',
        sourceDagDigest: input.sourceDagDigest,
        issueSnapshotFingerprint:
            snapshot.issueSnapshotFingerprint,
        repositoryFingerprint: snapshot.repositoryFingerprint,
        baseSha: snapshot.baseSha,
        payload: {
            planningBundleDigest: bundle.bundleDigest,
            frozenStageContract,
            frozenStageContractReceiptDigest:
                frozenStageContract.receiptDigest,
            stageWorkPlan,
            stageWorkPlanDigest: stageWorkPlan.planDigest,
            executableSlice,
            executableSliceDigest: executableSlice.sliceDigest,
            compiledPrompt,
            compiledPromptDigest: compiledPrompt.promptDigest,
            routeDecision,
            routeDecisionDigest: routeDecision.routeDecisionDigest,
            resourceReceipt,
            resourceReceiptDigest: resourceReceipt.receiptDigest,
            dispatchDigest: dispatch.dispatchDigest
        },
        evidenceRefs: [
            bundle.bundleDigest,
            frozenStageContract.receiptDigest,
            stageWorkPlan.planDigest,
            executableSlice.sliceDigest,
            compiledPrompt.promptDigest,
            routeDecision.routeDecisionDigest,
            resourceReceipt.receiptDigest,
            dispatch.dispatchDigest
        ],
        createdAt: input.stageFrozenAt
    })
    discovery.ledger.events.push(stageEvent)
    const projection = replayEventLedgerSync(discovery.ledger)
    persistAggregateRunState({
        stateRoot: input.stateRoot,
        controlLedger: discovery.controlLedger,
        nodeLedgers: [discovery.ledger]
    })
    return {
        next: 'dispatch-authorized',
        testContractDigest,
        resourceReceipt,
        frozenStageContract,
        stageWorkPlan,
        executableSlice,
        compiledPrompt,
        pendingRouteBundle,
        runtimeExecutionBinding,
        finalRouteBundle,
        routeDecision,
        dispatch,
        stageContractFrozenEvent: stageEvent,
        nodeProjection: projection
    }
}

export function compileTestContractWriterDispatch(input) {
    if (input?.preexistingFrozenContract) {
        fail('test-contract-cold-start-fabricated-history')
    }
    const acceptance = validateAcceptanceContract(
        input?.acceptanceContract
    )
    const planning = input?.planningReceipt
    if (planning?.schema !==
            'issue-orchestration.test-contract-plan-receipt.v1' ||
        planning.status !== 'verified' ||
        planning.acceptanceContractDigest !==
            acceptance.contractDigest ||
        planning.receiptDigest !==
            unsignedDigest(planning, 'receiptDigest')) {
        fail('test-contract-planning-receipt')
    }
    const route = validateRoute(
        input.routeDecision,
        'test-contract'
    )
    assertText(input.writerAttemptId, 'test-contract-writer-attempt')
    if (input.writerAttemptId === planning.attemptId) {
        fail('test-contract-attempt-separation')
    }
    if (input.resourceReceipt?.schema !==
            'issue-orchestration.writer-resource-acquisition-receipt.v1' ||
        input.resourceReceipt.status !== 'acquired') {
        fail('test-contract-resource-acquisition')
    }
    assertText(
        input.resourceReceipt.leaseId,
        'test-contract-resource-acquisition'
    )
    assertDigest(
        input.resourceReceipt.receiptDigest,
        'test-contract-resource-acquisition'
    )
    for (const [field, code] of [
        ['compiledPlanDigest', 'test-contract-plan-required'],
        ['executableSliceDigest', 'test-contract-slice-required'],
        ['compiledPromptDigest', 'test-contract-prompt-required'],
        ['planningBundleDigest', 'test-contract-planning-bundle-required'],
        [
            'frozenStageContractReceiptDigest',
            'test-contract-stage-contract-required'
        ]
    ]) assertDigest(input[field], code)
    if (input.fullIssueBody !== undefined ||
        input.callerSuppliedAuthority !== undefined ||
        input.unboundTestOnly === true) {
        fail('test-contract-writer-input-boundary')
    }
    return seal({
        schema:
            'issue-orchestration.test-contract-writer-dispatch.v1',
        status: 'dispatch-authorized',
        phase: 'test-contract',
        executionClass: 'leased-writer',
        mutationContract: 'lease-and-slice-allowlist',
        writeScope: 'tests-only',
        planningAttemptId: planning.attemptId,
        writerAttemptId: input.writerAttemptId,
        acceptanceContractDigest: acceptance.contractDigest,
        planningReceiptDigest: planning.receiptDigest,
        planningBundleDigest: input.planningBundleDigest,
        frozenStageContractReceiptDigest:
            input.frozenStageContractReceiptDigest,
        routeDecisionDigest: route.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            route.runtimeExecutionBindingDigest,
        resourceReceiptDigest:
            input.resourceReceipt.receiptDigest,
        leaseId: input.resourceReceipt.leaseId,
        compiledPlanDigest: input.compiledPlanDigest,
        executableSliceDigest: input.executableSliceDigest,
        compiledPromptDigest: input.compiledPromptDigest,
        fullIssueBodyIncluded: false,
        callerSuppliedAuthorityIncluded: false,
        preexistingFrozenHistoryIncluded: false
    }, 'dispatchDigest')
}

function semanticInvocation(snapshot, input) {
    return Object.freeze({
        schema:
            'issue-orchestration.cold-start-next-invocation.v1',
        status: 'next-required-invocation',
        action: 'request-semantic-proposal',
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteSnapshotDigest: snapshot.remoteSnapshotDigest,
        issueSnapshotDigest: snapshot.snapshotDigest,
        normativeBlocks: structuredClone(snapshot.normativeBlocks),
        rootMayModifyProposal: false,
        rootMayAuthorClassifications: false,
        requestedAt: input.requestedAt
    })
}

function blocker(error, input) {
    return seal({
        schema:
            'issue-orchestration.test-contract-cold-start-blocker.v1',
        status: 'blocked',
        runId: input?.runId ?? null,
        nodeId: input?.nodeId ?? null,
        code: error?.code ?? 'test-contract-cold-start-error',
        message: error?.message ?? String(error),
        recoverable: [
            'cold-start-selector-member-stale',
            'test-planning-bundle-stale',
            'test-planning-request-binding',
            'test-planning-investigation-binding',
            'test-planning-slice-proposal-binding',
            'writer-resource-registry-mismatch',
            'execution-route-runtime-profile-mismatch'
        ].includes(error?.code)
    }, 'blockerDigest')
}

function advanceTestContractColdStartOrThrow(input = {}) {
    for (const field of [
        'runId',
        'nodeId',
        'stateRoot',
        'sourceDagDigest',
        'skillDigest',
        'baselineDigest',
        'requestedAt',
        'stageFrozenAt'
    ]) assertText(input[field], `cold-start-${field}`)
    assertDigest(input.sourceDagDigest, 'cold-start-source-dag')
    assertDigest(input.skillDigest, 'cold-start-skill')
    assertDigest(input.baselineDigest, 'cold-start-baseline')
    const snapshot = compileColdStartIssueSnapshot({
        issue: input.issue,
        selectorReceipt: input.selectorReceipt
    })
    if (input.preexistingFrozenContract !== undefined ||
        input.fullIssueBody !== undefined ||
        input.callerSuppliedAuthority !== undefined) {
        fail('test-contract-cold-start-forbidden-input')
    }
    if (!input.semanticProposal) {
        return Object.freeze({
            schema:
                'issue-orchestration.test-contract-cold-start-result.v1',
            status: 'next-required-invocation',
            snapshot,
            nextInvocation: semanticInvocation(snapshot, input)
        })
    }
    const inventory = compileRequirementInventory({
        snapshot,
        proposal: input.semanticProposal,
        rootDecision: input.semanticRootDecision
    })
    const acceptanceContract = compileIssueAcceptanceContract({
        snapshot,
        inventory
    })
    const nodeDiscoveredReceipt = compileNodeDiscoveredReceipt({
        runId: input.runId,
        nodeId: input.nodeId,
        nodeEpoch: input.nodeEpoch ?? 1,
        snapshot,
        semanticProposal: input.semanticProposal,
        inventory,
        acceptanceContract
    })
    const discovery = discoveryState({
        stateRoot: input.stateRoot,
        runId: input.runId,
        nodeId: input.nodeId,
        nodeEpoch: input.nodeEpoch ?? 1,
        snapshot,
        nodeDiscoveredReceipt,
        issueKind: input.issueKind ?? 'code',
        sourceDagDigest: input.sourceDagDigest,
        createdAt: input.requestedAt,
        dependencyKeys: input.dependencyKeys ?? [],
        acceptanceGroup: input.acceptanceGroup ?? null
    })
    if (!input.planningRouteDecision || !input.planningAttemptId) {
        fail('test-planning-route-required')
    }
    const planningRequest = compileTestContractPlanningRequest({
        nodeDiscoveredReceipt,
        acceptanceContract,
        routeDecision: input.planningRouteDecision,
        attemptId: input.planningAttemptId
    })
    if (!input.planningBundle) {
        return Object.freeze({
            schema:
                'issue-orchestration.test-contract-cold-start-result.v1',
            status: 'next-required-invocation',
            snapshot,
            inventory,
            acceptanceContract,
            nodeDiscoveredReceipt,
            nextInvocation: {
                schema:
                    'issue-orchestration.cold-start-next-invocation.v1',
                status: 'next-required-invocation',
                action: 'request-test-contract-planning',
                stageRole: 'test-owner',
                stagePhase: 'test-contract-planning',
                planningRequest
            }
        })
    }
    const bundle = verifyTestContractPlanningBundle({
        bundle: input.planningBundle,
        request: planningRequest,
        snapshot
    })
    const validationReceipt = compileSlicePlanValidation({
        acceptanceContract,
        proposal: bundle.sliceProposal
    })
    verifySlicePlanValidation({
        acceptanceContract,
        proposal: bundle.sliceProposal,
        receipt: validationReceipt
    })
    const writer = compileWriterArtifacts({
        input,
        snapshot,
        acceptanceContract,
        bundle,
        nodeDiscoveredReceipt,
        discovery,
        validationReceipt,
        stageData: stageDataFromBundle({
            acceptanceContract,
            bundle,
            validationReceipt
        })
    })
    if (writer.next !== 'dispatch-authorized') {
        return Object.freeze({
            schema:
                'issue-orchestration.test-contract-cold-start-result.v1',
            status: 'next-required-invocation',
            snapshot,
            inventory,
            acceptanceContract,
            nodeDiscoveredReceipt,
            planningRequest,
            planningBundle: bundle,
            slicePlanValidationReceipt: validationReceipt,
            nextInvocation: Object.freeze({
                schema:
                    'issue-orchestration.cold-start-next-invocation.v1',
                status: 'next-required-invocation',
                action: writer.next,
                ...writer
            })
        })
    }
    return Object.freeze({
        schema:
            'issue-orchestration.test-contract-cold-start-result.v1',
        status: 'dispatch-authorized',
        snapshot,
        inventory,
        acceptanceContract,
        nodeDiscoveredReceipt,
        planningRequest,
        planningBundle: bundle,
        slicePlanValidationReceipt: validationReceipt,
        ...writer
    })
}

export function advanceTestContractColdStart(input = {}) {
    try {
        return advanceTestContractColdStartOrThrow(input)
    } catch (error) {
        return blocker(error, input)
    }
}

export function recoverTestContractColdStart({
    planningReceipt,
    frozenTestContract
}) {
    if (frozenTestContract?.status === 'frozen') {
        assertDigest(
            frozenTestContract.contractDigest,
            'test-contract-frozen-recovery'
        )
        return Object.freeze({
            action: 'resume-after-frozen-contract',
            frozenContractDigest:
                frozenTestContract.contractDigest
        })
    }
    if (planningReceipt?.status !== 'verified') {
        fail('test-contract-planning-recovery')
    }
    assertDigest(
        planningReceipt.receiptDigest,
        'test-contract-planning-recovery'
    )
    return Object.freeze({
        action: 'resume-writer-dispatch',
        planningReceiptDigest: planningReceipt.receiptDigest
    })
}
