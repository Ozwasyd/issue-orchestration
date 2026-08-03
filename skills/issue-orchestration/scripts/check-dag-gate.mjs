#!/usr/bin/env node
// Canonical stage-aware DAG startup gate.

import fs from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    digest,
    seal
} from './runtime-contract-lib.mjs'
import {
    lifecycleDefinition
} from './lifecycle-state-machine.mjs'
import {
    validateSemanticGraph
} from './semantic-runtime-projection.mjs'
import {
    validateReadyFrontier
} from './frontier-compiler.mjs'
import {
    validateInvestigationProjection
} from './investigation-compiler.mjs'
import {
    compileRuntimePermissionEvidence,
    validateRuntimeTrustBinding
} from './runtime-trust-policy.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'
import {
    validateExecutionRouteDecision,
    validateRouteBoundActor
} from './execution-route-compiler.mjs'

const HASH = /^[a-f0-9]{64}$/u
const CANONICAL_ROLES = new Set([
    'root-scheduler',
    'dag-creator-updater',
    'test-owner',
    'code-implementer',
    'ui-ux-implementer',
    'ui-system-adjudicator',
    'ux-acceptance-verifier',
    'documentation-writer'
])

const DIRECT_ROUTE_RECEIPTS = new Set([
    'planningRoute', 'routeDecision', 'uiAdjudicationRoute',
    'uxAcceptanceRoute', 'documentationRoute'
])

function routeAuthorityFor(key, node) {
    if (['planningRoute', 'planningAttempt', 'testContractPlan',
        'slicePlanProposal'].includes(key)) {
        return ['test-owner', 'test-contract-planning', true]
    }
    if (['routeDecision', 'writerDispatch', 'activeAttempt',
        'writerCheckpoint', 'writerFailure', 'retryAuthorization'].includes(key)) {
        return ['test-owner', 'test-contract', false]
    }
    if (key === 'implementationTerminal') {
        return node.uiClass === 'non-ui'
            ? ['code-implementer', 'implementation', false]
            : ['ui-ux-implementer', 'ui-implementation', false]
    }
    if (key === 'behavior') {
        return ['test-owner', 'behavior-verification', true]
    }
    if (['uiAdjudicationRoute', 'uiAdjudication'].includes(key)) {
        return ['ui-system-adjudicator', 'adjudication', true]
    }
    if (['uxAcceptanceRoute', 'uxAcceptance'].includes(key)) {
        return ['ux-acceptance-verifier', 'ux-acceptance', true]
    }
    if (['documentationRoute', 'documentation'].includes(key)) {
        return ['documentation-writer', 'documentation', false]
    }
    if (key === 'deliveryAttempt') {
        return ['root-scheduler', 'scheduling', false]
    }
    return null
}

const AGENT_RECEIPTS = new Set([
    'planningRoute', 'planningAttempt', 'testContractPlan',
    'slicePlanProposal', 'routeDecision', 'writerDispatch',
    'activeAttempt', 'writerCheckpoint', 'writerFailure',
    'retryAuthorization', 'implementationTerminal', 'behavior',
    'uiAdjudicationRoute', 'uiAdjudication', 'uxAcceptanceRoute',
    'uxAcceptance', 'documentationRoute', 'documentation',
    'deliveryAttempt'
])

const DIGEST_FIELD_BY_RECEIPT = Object.freeze({
    requirementInventory: 'receiptDigest',
    acceptanceContract: 'receiptDigest',
    planningRoute: 'routeDecisionDigest',
    planningAttempt: 'receiptDigest',
    testContractPlan: 'receiptDigest',
    slicePlanProposal: 'proposalDigest',
    slicePlanValidation: 'receiptDigest',
    workPlan: 'workPlanDigest',
    executableSlice: 'sliceDigest',
    routeDecision: 'routeDecisionDigest',
    compiledPrompt: 'promptDigest',
    resourceAcquisition: 'receiptDigest',
    writerDispatch: 'receiptDigest',
    activeAttempt: 'receiptDigest',
    writeLease: 'receiptDigest',
    writerCheckpoint: 'receiptDigest',
    writerFailure: 'receiptDigest',
    retryAuthorization: 'receiptDigest',
    implementationTerminal: 'receiptDigest',
    candidate: 'receiptDigest',
    behavior: 'receiptDigest',
    uiAdjudicationRoute: 'routeDecisionDigest',
    uiAdjudication: 'receiptDigest',
    uxAcceptanceRoute: 'routeDecisionDigest',
    uxAcceptance: 'receiptDigest',
    documentationRoute: 'routeDecisionDigest',
    documentation: 'receiptDigest',
    deliveryAttempt: 'receiptDigest',
    delivery: 'receiptDigest',
    cleanupAuthorization: 'receiptDigest',
    cleanup: 'receiptDigest',
    closure: 'receiptDigest',
    terminal: 'receiptDigest'
})

const DISPATCH_PROJECTION_FIELDS = [
    'frontierProjection', 'frontierRuntime', 'selectorReceipt',
    'dispatchFrontier', 'dispatchRankingPolicy', 'dispatchBatch'
]

export class DagGateError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'DagGateError'
        this.code = code
        this.details = details
    }
}

function fail(code, message = code, details = {}) {
    throw new DagGateError(code, message, details)
}

function assertDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function unsigned(value, field) {
    const copy = structuredClone(value)
    delete copy[field]
    return copy
}

export function validateDispatchProjectionPresence(dag) {
    const present = DISPATCH_PROJECTION_FIELDS.filter(
        (field) => dag?.[field] !== undefined
    )
    if (present.length === 0) {
        fail(
            'dispatch-projection-required',
            'The verified frontier and dispatch projection are required.'
        )
    }
    if (present.length !== DISPATCH_PROJECTION_FIELDS.length) {
        fail(
            'dispatch-projection-incomplete',
            'Ready frontier and dispatch projection must be present as one fail-closed unit.'
        )
    }
    return { valid: true }
}


function validateLayeredReadyFrontier(request) {
    const fields = [
        'dispatchDag',
        'frontierProjection',
        'frontierRuntime',
        'investigationProjection'
    ]
    const present = fields.filter((field) => request?.[field] !== undefined)
    if (present.length === 0) return
    if (present.length !== fields.length) {
        fail(
            'frontier-projection-incomplete',
            'Layered ready-frontier inputs must be supplied as one unit.'
        )
    }
    try {
        validateInvestigationProjection({
            selectorReceipt: request.selectorReceipt,
            dagProposal: request.dispatchDag,
            runtimeState: request.frontierRuntime,
            recordedProjection: request.investigationProjection
        })
    } catch {
        fail(
            'investigation-projection-invalid',
            'Investigation projection is not canonical for the dispatch DAG.'
        )
    }
    const validation = validateReadyFrontier({
        dag: request.dispatchDag,
        runtimeState: request.frontierRuntime,
        selectorReceipt: request.selectorReceipt,
        investigationProjection: request.investigationProjection,
        recordedProjection: request.frontierProjection
    })
    if (!validation.valid) {
        fail(
            validation.code,
            'Ready frontier does not match independently compiled eligibility.'
        )
    }
}

function validateRootRuntime(request, repositories) {
    let startupBinding
    try {
        startupBinding = requireRuntimeStartupBinding({
            startup: request.startup
        })
    } catch {
        fail('dag-gate-startup-attestation')
    }
    if (request.selectorReceipt.startupAttestationDigest !==
            startupBinding.startupAttestationDigest ||
        request.selectorReceipt.runtimeInvocationId !==
            startupBinding.runtimeInvocationId) {
        fail('dag-gate-selector-startup-binding')
    }
    const repositoryTargets = request.repositoryTargets ?? []
    try {
        validateRuntimeTrustBinding(request.runtimeTrustBinding, {
            expectedRole: 'root-scheduler',
            expectedExecutionClass: 'root-control',
            expectedRepositories: repositories,
            repositoryTargets,
            startup: request.startup
        })
    } catch {
        fail('dag-gate-root-runtime-trust')
    }
    const permissionEvidence = compileRuntimePermissionEvidence({
        binding: request.runtimeTrustBinding,
        evidenceClass: 'run',
        repositoryTargets,
        startup: request.startup
    })
    return { startupBinding, permissionEvidence }
}

function receiptDigestFor(key, receipt) {
    const digestField = DIGEST_FIELD_BY_RECEIPT[key]
    if (!digestField) fail('dag-gate-receipt-kind-unknown', key)
    const value = receipt?.[digestField]
    assertDigest(value, 'dag-gate-receipt-digest')
    if (digest(unsigned(receipt, digestField)) !== value) {
        fail('dag-gate-receipt-digest-mismatch', key)
    }
    return value
}

function validateReceiptEnvelope({
    key,
    receipt,
    node,
    graph,
    usedDigests
}) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        fail('dag-gate-receipt-invalid', key)
    }
    if (typeof receipt.schema !== 'string' ||
        !receipt.schema.startsWith('issue-orchestration.')) {
        fail('dag-gate-receipt-schema', key)
    }
    if (receipt.memberId !== node.memberId ||
        receipt.selectorReceiptDigest !== graph.selectorReceiptDigest ||
        receipt.remoteSnapshotDigest !== graph.remoteSnapshotDigest ||
        receipt.repositoryBindingDigest !== node.repositoryBindingDigest) {
        fail('dag-gate-receipt-binding', key)
    }
    if (!Array.isArray(receipt.predecessorReceiptDigests) ||
        receipt.predecessorReceiptDigests.some((value) => !HASH.test(value))) {
        fail('dag-gate-receipt-predecessors', key)
    }
    const value = receiptDigestFor(key, receipt)
    if (usedDigests.has(value)) fail('dag-gate-receipt-reused', key)
    usedDigests.add(value)

    if (AGENT_RECEIPTS.has(key)) {
        const authority = routeAuthorityFor(key, node)
        if (!authority) fail('dag-gate-receipt-actor-binding', key)
        const [stageRole, stagePhase, proposalOnly] = authority
        try {
            if (DIRECT_ROUTE_RECEIPTS.has(key)) {
                validateExecutionRouteDecision(receipt, {
                    stageRole,
                    stagePhase
                })
            } else {
                validateRouteBoundActor({
                    actor: receipt,
                    routeDecision: receipt.executionRouteDecision ??
                        receipt.routeDecision,
                    stageRole,
                    stagePhase,
                    proposalOnly
                })
            }
        } catch (error) {
            fail(error?.code ?? 'dag-gate-receipt-actor-binding', key)
        }
        if (!DIRECT_ROUTE_RECEIPTS.has(key) &&
            !CANONICAL_ROLES.has(receipt.actorRole ?? receipt.role)) {
            fail('dag-gate-receipt-actor-binding', key)
        }
    } else if (typeof receipt.compilerAuthority !== 'string' ||
        receipt.compilerAuthority.length === 0) {
        fail('dag-gate-receipt-compiler-binding', key)
    }
    return value
}

function validateNode(node, graph, usedDigests) {
    const definition = lifecycleDefinition(node.lifecycleState)
    if (!definition) fail('dag-gate-lifecycle-state')
    if (node.selectorReceiptDigest !== graph.selectorReceiptDigest ||
        node.remoteSnapshotDigest !== graph.remoteSnapshotDigest) {
        fail('dag-gate-member-snapshot-binding')
    }
    assertDigest(node.semanticFactsDigest, 'dag-gate-semantic-facts')

    const keys = Object.keys(node.receipts).sort()
    const allowed = new Set(definition.allowedReceipts)
    for (const key of keys) {
        if (!allowed.has(key)) {
            fail('dag-gate-premature-receipt', key, {
                lifecycleState: node.lifecycleState
            })
        }
    }
    for (const key of definition.requiredReceipts) {
        if (!Object.hasOwn(node.receipts, key)) {
            fail('dag-gate-required-receipt-missing', key, {
                lifecycleState: node.lifecycleState
            })
        }
    }

    const validated = new Map()
    for (const key of definition.allowedReceipts) {
        if (!Object.hasOwn(node.receipts, key)) continue
        const receipt = node.receipts[key]
        const value = validateReceiptEnvelope({
            key,
            receipt,
            node,
            graph,
            usedDigests
        })
        const expectedPredecessors = [...validated.values()].sort()
        if (JSON.stringify(
            [...receipt.predecessorReceiptDigests].sort()
        ) !== JSON.stringify(expectedPredecessors)) {
            fail('dag-gate-receipt-predecessor-binding', key)
        }
        validated.set(key, value)
    }

    const projection = canonical({
        schema: 'issue-orchestration.node-member-runtime-projection.v2',
        memberId: node.memberId,
        repository: node.repository,
        issueNumber: node.issueNumber,
        lifecycleState: node.lifecycleState,
        selectorReceiptDigest: node.selectorReceiptDigest,
        remoteSnapshotDigest: node.remoteSnapshotDigest,
        repositoryBindingDigest: node.repositoryBindingDigest,
        semanticFactsDigest: node.semanticFactsDigest,
        receiptDigests: [...validated.values()]
    })
    return digest(projection)
}

export function validateDagStartupGate(request) {
    if (request?.legacyFallbackEnabled === true ||
        request?.rootRuntime !== undefined ||
        request?.dag?.testContractDigest !== undefined ||
        request?.dag?.stageReceipts !== undefined ||
        request?.dag?.schema === 'issue-orchestration.dag.v2' ||
        request?.dag?.schema === 'issue-orchestration.semantic-graph.v1') {
        fail(
            'dag-gate-canonical-migration-required',
            'Migrate to semantic-graph.v2 and per-member stage receipts.'
        )
    }
    if (request?.schema !==
            'issue-orchestration.dag-startup-gate-request.v2' ||
        request?.authoritySource !== 'permanent-shared-package' ||
        request?.selectorReceipt?.schema !==
            'issue-orchestration.scope-selector-receipt.v1') {
        fail('dag-gate-request')
    }
    assertDigest(
        request.selectorReceipt.receiptDigest,
        'dag-gate-selector-receipt'
    )
    assertDigest(
        request.selectorReceipt.remoteSnapshotDigest,
        'dag-gate-selector-remote'
    )
    try {
        validateSemanticGraph(request.dag)
    } catch (error) {
        fail(error.code ?? 'dag-gate-semantic-graph', error.message)
    }
    if (request.dag.selectorReceiptDigest !==
            request.selectorReceipt.receiptDigest ||
        request.dag.remoteSnapshotDigest !==
            request.selectorReceipt.remoteSnapshotDigest) {
        fail('dag-gate-selector-graph-binding')
    }
    if (request.startup?.observation?.policyDigests?.modelPool !==
        request.dag.policyDigest) {
        fail('dag-gate-policy-binding')
    }

    const repositories = request.dag.repositories.map(
        ({ repository }) => repository
    )
    const { startupBinding, permissionEvidence } = validateRootRuntime(
        request,
        repositories
    )
    const memberIds = new Set()
    const usedDigests = new Set()
    const memberProjectionDigests = []
    for (const node of request.dag.nodes) {
        if (memberIds.has(node.memberId)) fail('dag-gate-member-identity')
        memberIds.add(node.memberId)
        memberProjectionDigests.push(validateNode(
            node,
            request.dag,
            usedDigests
        ))
    }

    return seal({
        schema: 'issue-orchestration.dag-startup-gate-receipt.v2',
        status: 'verified',
        selectorReceiptDigest: request.selectorReceipt.receiptDigest,
        remoteSnapshotDigest: request.selectorReceipt.remoteSnapshotDigest,
        policyDigest: request.dag.policyDigest,
        rootProfile: startupBinding.rootProfile,
        startupAttestationDigest: startupBinding.startupAttestationDigest,
        runtimeInvocationId: startupBinding.runtimeInvocationId,
        runtimeSessionId: startupBinding.runtimeSessionId,
        runtimeTrustMode: permissionEvidence.runtimeTrustMode,
        runtimeTrustBindingDigest:
            permissionEvidence.runtimeTrustBindingDigest,
        runtimePermissionEvidenceDigest: permissionEvidence.evidenceDigest,
        effectivePermissionProfile:
            permissionEvidence.effectivePermissionProfile,
        permissionInheritance: permissionEvidence.permissionInheritance,
        machineEnforcedRoleIsolation:
            permissionEvidence.machineEnforcedRoleIsolation,
        mutationPostconditionRequired:
            permissionEvidence.mutationPostconditionRequired,
        memberCount: memberProjectionDigests.length,
        memberProjectionDigests,
        legacyGlobalReceiptAuthority: false
    }, 'receiptDigest')
}

function readRequest(argv) {
    if (argv.length > 1) fail('dag-gate-cli-usage')
    const source = argv.length === 1
        ? fs.readFileSync(resolve(argv[0]), 'utf8')
        : fs.readFileSync(0, 'utf8')
    return JSON.parse(source)
}

function runCli() {
    try {
        const receipt = validateDagStartupGate(readRequest(
            process.argv.slice(2)
        ))
        process.stdout.write(`${JSON.stringify(receipt)}\n`)
    } catch (error) {
        process.stderr.write(`${JSON.stringify({
            code: error.code ?? 'dag-gate-unexpected',
            message: error.message
        })}\n`)
        process.exitCode = 1
    }
}

if (process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli()
}
