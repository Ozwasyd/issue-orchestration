import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { digest } from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import { routeDecisionFor } from './issue-orchestration-route-test-helper.mjs'
import {
    compileLifecycleActionSet,
    lifecycleActionForState,
    validateLifecycleActionSet
} from '../../skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs'


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const sha = (label) => digest({ label })
const baseSha = 'a'.repeat(40)
const policyDigest = sha('policy')
const selectorDigest = sha('selector')
const remoteDigest = sha('remote')
const graphInputDigest = sha('graph-input')
const scopeDigest = sha('scope')
const repository = 'ExampleOrg/RepositoryA'
const repositoryBindingDigest = sha('repository-binding')
const startupAttestationDigest = sha('startup-attestation')
const runtimeTrustBindingDigest = sha('runtime-trust-binding')
const repositoryIdentitySetDigest = sha('repository-identity-set')
const repositoryBindingSetDigest = sha('repository-binding-set')
const capabilityDigest = sha('capability')
const authorityBinding = (() => {
    const value = {
        schema: 'issue-orchestration.lifecycle-authority-binding.v1',
        authorityKind: 'genesis',
        runId: 'run-lifecycle-1',
        startupObservationDigest: sha('startup-observation'),
        startupAttestationDigest,
        runtimeInvocationId: 'lifecycle-test-invocation',
        runtimeSessionId: 'lifecycle-test-session',
        rootRole: 'root-scheduler',
        rootPhase: 'scheduling',
        rootProfile: 'terra-low',
        effectiveModel: 'gpt-5.6-terra',
        effectiveEffort: 'low',
        effectiveMultiAgentBackend: 'v2',
        effectiveApprovalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        rootAuthorityEpoch: 'root-authority-epoch-1',
        recoveryAuthorizationDigest: null,
        takeoverHandoffDigest: null,
        oldRootFencingReceiptDigest: null,
        packageDigest: sha('package'),
        manifestDigest: sha('manifest'),
        policySetDigest: sha('policy-set'),
        runtimeTrustBindingDigest,
        runtimeTrustMode: 'trusted-owner-repositories',
        repositoryIdentitySetDigest,
        repositoryBindingSetDigest,
        stateRootIdentityDigest: sha('state-root'),
        runtimeCapabilityBindingDigest: capabilityDigest
    }
    value.bindingDigest = digest(value)
    return Object.freeze(value)
})()
const lifecycleAuthority = (() => {
    const value = {
        schema: 'issue-orchestration.lifecycle-run-authority.v1',
        status: 'verified',
        producerAuthority: 'machine-lifecycle-genesis-authority',
        authorityKind: 'genesis',
        runId: 'run-lifecycle-1',
        createdAt: '2026-08-04T00:00:00.000Z',
        repositoryTargets: [],
        workspaces: [],
        worktrees: [],
        runtimeTrustBinding: {},
        repositoryBindings: [{
            repository,
            bindingDigest: repositoryBindingDigest
        }],
        stateRootIdentity: {},
        runtimeCapabilityBinding: {
            schema: 'issue-orchestration.runtime-capability-binding.v1',
            status: 'verified',
            bindingDigest: capabilityDigest
        },
        binding: authorityBinding
    }
    value.authorityDigest = digest(value)
    return Object.freeze(value)
})()
const canonicalSelectorReceipt = (() => {
    const receipt = {
        schema: 'issue-orchestration.selector-receipt.v1',
        startupAttestationDigest,
        runtimeInvocationId: authorityBinding.runtimeInvocationId,
        runtimeSessionId: authorityBinding.runtimeSessionId,
        rootAuthorityEpoch: authorityBinding.rootAuthorityEpoch,
        lifecycleAuthorityBindingDigest: authorityBinding.bindingDigest,
        runtimeTrustBindingDigest,
        repositoryBindingSetDigest,
        selectorVersion: 'lifecycle-test-selector-v1',
        type: 'explicit-issues',
        parametersDigest: sha('selector-parameters'),
        selectorDigest,
        resolvedIssueSet: [],
        exclusionReasons: {},
        remoteQueryIdentity: 'lifecycle-test:explicit-issues',
        previousRemoteSnapshotDigest: null,
        remoteSnapshotDigest: remoteDigest,
        remoteFactDigests: {},
        remoteChangeSet: {
            added: [], changed: [], closed: [], removed: [], reopened: []
        },
        issueHistory: {},
        issueStates: {},
        resolvedAt: '2026-08-04T00:00:00.000Z'
    }
    receipt.receiptDigest = digest(receipt)
    return Object.freeze(receipt)
})()
const selectorReceiptDigest = canonicalSelectorReceipt.receiptDigest

function sealReceipt(name, fields = {}) {
    const receipt = {
        schema: `issue-orchestration.${name}.v1`,
        status: 'verified',
        ...fields
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

function graphNode({
    id,
    state = 'discovered',
    uiClass = 'non-ui',
    acceptanceGroup = null,
    receipts = {},
    dependencyKeys = []
}) {
    return {
        id,
        memberId: id,
        repository,
        issueNumber: Number(id.split('#').at(-1)),
        owner: 'dag-creator-updater',
        dependencyKeys,
        conflictKeys: [],
        riskClass: 'bounded',
        uiClass,
        acceptanceGroup,
        lifecycleState: state,
        selectorReceiptDigest,
        remoteSnapshotDigest: remoteDigest,
        repositoryBindingDigest,
        semanticFactsDigest: sha(`facts:${id}`),
        receipts
    }
}

function semanticGraph(nodes) {
    return createSemanticGraph({
        selectorReceiptDigest,
        remoteSnapshotDigest: remoteDigest,
        scopeDigest,
        semanticGraphInputDigest: graphInputDigest,
        policyDigest,
        repositories: [{
            repository,
            baseSha,
            bindingDigest: repositoryBindingDigest
        }],
        nodes
    })
}

function aggregateNode(node, overrides = {}) {
    return {
        nodeId: node.memberId,
        memberId: node.memberId,
        repository: node.repository,
        issueNumber: node.issueNumber,
        selectorReceiptDigest,
        remoteMemberDigest: sha(`remote-member:${node.memberId}`),
        nodeEpoch: 1,
        baseSha,
        dependencyKeys: node.dependencyKeys,
        acceptanceGroup: node.acceptanceGroup,
        status: 'active',
        ledgerHeadDigest: sha(`ledger:${node.memberId}`),
        nodeProjectionDigest: sha(`projection:${node.memberId}`),
        lifecycleState: node.lifecycleState,
        activeAttemptId: null,
        candidateGreen: false,
        deliveryComplete: node.lifecycleState === 'closed',
        dispatchable: true,
        blockedBy: [],
        quarantine: null,
        ...overrides
    }
}

function aggregateProjection(nodes, {
    capacity = 4,
    active = [],
    acceptanceGroups = {},
    deliveryEffects = {},
    deliveryFreezes = {}
} = {}) {
    const projection = {
        schema: 'issue-orchestration.aggregate-runtime-projection.v1',
        runId: 'run-lifecycle-1',
        lifecycleAuthorityBinding: structuredClone(authorityBinding),
        controlProjectionDigest: sha('control-projection'),
        nodeIndexDigest: sha('node-index'),
        nodes: Object.fromEntries(nodes.map((node) => [
            node.memberId,
            aggregateNode(node)
        ])),
        acceptanceGroups,
        slots: { capacity, active },
        deliveryFreezes,
        pendingDeliveryEffects: {},
        deliveryEffects,
        cleanupFinalizations: {},
        terminal: null
    }
    projection.aggregateProjectionDigest = digest(projection)
    return projection
}

function input(nodes, options = {}) {
    const graph = semanticGraph(nodes)
    return {
        schema: 'issue-orchestration.lifecycle-compiler-input.v1',
        selectorReceipt: structuredClone(canonicalSelectorReceipt),
        remoteSnapshotReceipt: {
            schema: 'issue-orchestration.remote-snapshot-receipt.v1',
            status: 'verified',
            selectorReceiptDigest,
            receiptDigest: remoteDigest
        },
        semanticGraph: graph,
        aggregateProjection: aggregateProjection(nodes, options),
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        runtimeCapabilityBinding:
            structuredClone(lifecycleAuthority.runtimeCapabilityBinding),
        lifecycleAuthority: structuredClone(lifecycleAuthority)
    }
}

function compile(nodes, options) {
    return compileLifecycleActionSet(input(nodes, options))
}

function withAggregateMutation(request, mutation) {
    mutation(request.aggregateProjection)
    const copy = { ...request.aggregateProjection }
    delete copy.aggregateProjectionDigest
    request.aggregateProjection.aggregateProjectionDigest = digest(copy)
    return request
}

const stateCases = [
    ['none', 'request-semantic-proposal'],
    ['discovered', 'compile-acceptance-contract'],
    ['acceptance-frozen', 'request-test-contract-planning'],
    ['test-contract-planning', 'request-test-contract-planning'],
    ['test-contracting', 'dispatch-test-contract-writer'],
    ['test-contract-frozen', 'dispatch-implementation-writer'],
    ['implementing', 'dispatch-implementation-writer'],
    ['implementing-self-testing', 'dispatch-implementation-writer'],
    ['candidate-green', 'dispatch-behavior-verifier'],
    ['independent-verifying', 'dispatch-behavior-verifier'],
    ['ui-adjudicating', 'request-ui-adjudication'],
    ['ux-acceptance', 'dispatch-ux-acceptance-verifier'],
    ['documenting', 'dispatch-documentation-writer'],
    ['cleaning', 'cleanup-node-resources'],
    ['terminal', 'terminalize-node'],
    ['quarantined', 'terminalize-node']
]

test('table-driven lifecycle states emit only their canonical action', () => {
    for (const [state, expected] of stateCases) {
        const node = graphNode({ id: 'RepositoryA#20', state })
        const result = compile([node])
        assert.equal(result.actions[0].type, expected, state)
        assert.equal(lifecycleActionForState(state), expected, state)
        validateLifecycleActionSet(result)
    }
})

test('raw terminal failure binds first failure without minting a category', () => {
    const node = graphNode({
        id: 'RepositoryA#20',
        state: 'terminal'
    })
    const request = input([node])
    const firstFailure = {
        classification: 'writer-stage.output-missing',
        evidenceRef: sha('writer-failure-receipt'),
        signature: sha('writer-failure-signature')
    }
    request.aggregateProjection.nodes[node.memberId].firstFailure =
        firstFailure
    request.aggregateProjection.nodes[node.memberId].terminalCandidate =
        null
    const unsigned = { ...request.aggregateProjection }
    delete unsigned.aggregateProjectionDigest
    request.aggregateProjection.aggregateProjectionDigest = digest(unsigned)
    const result = compileLifecycleActionSet(request)
    assert.equal(result.actions[0].type, 'terminalize-node')
    assert.deepEqual(result.actions[0].bindings.firstFailure, firstFailure)
    assert.equal(result.actions[0].bindings.terminalCandidate, null)
})

test('same verified input is byte-for-byte deterministic across reload', () => {
    const nodes = [
        graphNode({ id: 'RepositoryA#20', state: 'none' }),
        graphNode({ id: 'RepositoryA#21', state: 'discovered' })
    ]
    const request = input(nodes, { capacity: 2 })
    const first = compileLifecycleActionSet(request)
    const second = compileLifecycleActionSet(
        JSON.parse(JSON.stringify(request))
    )
    assert.equal(JSON.stringify(first), JSON.stringify(second))
    assert.equal(first.actions.length, 2)
    assert.deepEqual(
        first.actions.map(({ type }) => type),
        ['request-semantic-proposal', 'compile-acceptance-contract']
    )
})

test('planning receipts advance to exact test-contract writer dispatch', () => {
    const receipts = {
        testContractPlan: sealReceipt('test-contract-plan-receipt'),
        workPlan: {
            schema: 'issue-orchestration.stage-work-plan.v1',
            workPlanDigest: sha('work-plan')
        },
        executableSlice: {
            schema: 'issue-orchestration.executable-slice.v1',
            sliceDigest: sha('slice')
        },
        routeDecision: routeDecisionFor({
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            suffix: 'lifecycle-test-contract'
        }),
        compiledPrompt: {
            schema: 'issue-orchestration.compiled-dispatch-prompt.v1',
            promptDigest: sha('prompt')
        },
        resourceAcquisition: sealReceipt('writer-resource-acquisition-receipt')
    }
    const node = graphNode({
        id: 'RepositoryA#20',
        state: 'test-contract-planning',
        receipts
    })
    const action = compile([node]).actions[0]
    assert.equal(action.type, 'dispatch-test-contract-writer')
    assert.equal(
        action.bindings.receiptDigests.routeDecision,
        receipts.routeDecision.routeDecisionDigest
    )
    assert.match(action.bindings.priorLedgerHeadDigest, /^[a-f0-9]{64}$/u)
})

test('stages continue through implementation, verification, docs, delivery and cleanup', () => {
    const cases = [
        ['test-contract-frozen', 'dispatch-implementation-writer'],
        ['candidate-green', 'dispatch-behavior-verifier'],
        ['behavior-green', 'deliver-acceptance-group'],
        ['documenting', 'dispatch-documentation-writer'],
        ['delivery-ready', 'deliver-acceptance-group'],
        ['cleaning', 'cleanup-node-resources']
    ]
    for (const [state, expected] of cases) {
        const node = graphNode({ id: 'RepositoryA#20', state })
        const groups = state === 'behavior-green' || state === 'delivery-ready'
            ? { 'node:RepositoryA#20': ['RepositoryA#20'] }
            : {}
        assert.equal(
            compile([node], { acceptanceGroups: groups }).actions[0].type,
            expected,
            state
        )
    }
})

test('UI and documentation requirements cannot be skipped', () => {
    const ui = graphNode({
        id: 'RepositoryA#20',
        state: 'behavior-green',
        uiClass: 'ui'
    })
    assert.equal(compile([ui]).actions[0].type, 'request-ui-adjudication')
    ui.receipts.uiAdjudication = sealReceipt('ui-adjudication-receipt')
    assert.equal(
        compile([ui]).actions[0].type,
        'dispatch-ux-acceptance-verifier'
    )
    ui.receipts.uxAcceptance = sealReceipt('ux-acceptance-receipt')
    ui.receipts.documentationRequired = true
    assert.equal(
        compile([ui]).actions[0].type,
        'dispatch-documentation-writer'
    )
})

test('two slots select two independent nodes and active attempts suppress duplicates', () => {
    const nodes = [
        graphNode({ id: 'RepositoryA#20', state: 'candidate-green' }),
        graphNode({ id: 'RepositoryA#21', state: 'candidate-green' })
    ]
    const result = compile(nodes, { capacity: 2 })
    assert.equal(result.actions.length, 2)
    const request = input(nodes, { capacity: 2 })
    withAggregateMutation(request, (aggregate) => {
        aggregate.nodes['RepositoryA#20'].activeAttemptId = 'attempt-active'
    })
    const suppressed = compileLifecycleActionSet(request)
    assert.equal(suppressed.actions.length, 1)
    assert.equal(suppressed.actions[0].nodeId, 'RepositoryA#21')
})

test('dependent nodes remain blocked until the verified aggregate projection unblocks them', () => {
    const first = graphNode({ id: 'RepositoryA#20', state: 'closed' })
    const second = graphNode({
        id: 'RepositoryA#21',
        state: 'candidate-green',
        dependencyKeys: ['RepositoryA#20']
    })
    const request = input([first, second], { capacity: 2 })
    withAggregateMutation(request, (aggregate) => {
        aggregate.nodes['RepositoryA#21'].blockedBy = ['RepositoryA#20']
    })
    assert.equal(compileLifecycleActionSet(request).actions[0].type, 'idle')
    withAggregateMutation(request, (aggregate) => {
        aggregate.nodes['RepositoryA#21'].blockedBy = []
    })
    assert.equal(
        compileLifecycleActionSet(request).actions[0].type,
        'dispatch-behavior-verifier'
    )
})

test('acceptance group delivery is complete, once-only and group-scoped', () => {
    const nodes = [
        graphNode({
            id: 'RepositoryA#20',
            state: 'delivery-ready',
            acceptanceGroup: 'group-a'
        }),
        graphNode({
            id: 'RepositoryA#21',
            state: 'delivery-ready',
            acceptanceGroup: 'group-a'
        })
    ]
    const options = {
        acceptanceGroups: {
            'group-a': ['RepositoryA#20', 'RepositoryA#21']
        }
    }
    const result = compile(nodes, options)
    assert.equal(result.actions.length, 1)
    assert.equal(result.actions[0].type, 'deliver-acceptance-group')
    assert.equal(result.actions[0].bindings.memberBindings.length, 2)
    const partial = input(nodes, options)
    withAggregateMutation(partial, (aggregate) => {
        aggregate.nodes['RepositoryA#21'].lifecycleState = 'candidate-green'
    })
    assert.equal(
        compileLifecycleActionSet(partial).actions.some(
            ({ type }) => type === 'deliver-acceptance-group'
        ),
        false
    )
    const delivered = input(nodes, {
        ...options,
        deliveryEffects: { 'group-a': { status: 'completed' } }
    })
    assert.equal(compileLifecycleActionSet(delivered).actions[0].type, 'idle')
})

test('scope drift precedes every stale action', () => {
    const node = graphNode({ id: 'RepositoryA#20', state: 'candidate-green' })
    const request = input([node])
    request.remoteSnapshotReceipt.receiptDigest = sha('remote-drift')
    const result = compileLifecycleActionSet(request)
    assert.equal(result.actions.length, 1)
    assert.equal(result.actions[0].type, 'refresh-scope')
})

test('recoverable failures select only typed authorized continuation', () => {
    const node = graphNode({
        id: 'RepositoryA#20',
        state: 'implementing-self-testing',
        receipts: {
            writerFailure: sealReceipt('writer-stage-failure-receipt'),
            retryAuthorization: sealReceipt('writer-stage-retry-authorization')
        }
    })
    const action = compile([node]).actions[0]
    assert.equal(action.type, 'dispatch-implementation-writer')
    assert.equal(action.recoveryMode, 'authorized-continuation')
})

test('a modified canonical route prevents dispatch with typed evidence', () => {
    const routeDecision = routeDecisionFor({
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        suffix: 'lifecycle-invalid-route'
    })
    routeDecision.runtimeExecutionBindingStatus = 'missing'
    const node = graphNode({
        id: 'RepositoryA#20',
        state: 'test-contract-planning',
        receipts: {
            testContractPlan: sealReceipt('test-contract-plan-receipt'),
            workPlan: {
                schema: 'issue-orchestration.stage-work-plan.v1',
                workPlanDigest: sha('invalid-route-work-plan')
            },
            executableSlice: {
                schema: 'issue-orchestration.executable-slice.v1',
                sliceDigest: sha('invalid-route-slice')
            },
            routeDecision,
            compiledPrompt: {
                schema: 'issue-orchestration.compiled-dispatch-prompt.v1',
                promptDigest: sha('invalid-route-prompt')
            },
            resourceAcquisition:
                sealReceipt('writer-resource-acquisition-receipt')
        }
    })
    assert.throws(
        () => compile([node]),
        ({ code }) => code === 'lifecycle-route-invalid'
    )
})

test('unverified projections and caller-authored stage state fail closed', () => {
    const node = graphNode({ id: 'RepositoryA#20', state: 'discovered' })
    const stale = input([node])
    stale.aggregateProjection.nodes['RepositoryA#20'].baseSha = 'b'.repeat(40)
    assert.throws(
        () => compileLifecycleActionSet(stale),
        ({ code }) => code === 'lifecycle-aggregate-digest-mismatch'
    )
    const caller = input([node])
    caller.stageState = { 'RepositoryA#20': 'closed' }
    assert.throws(
        () => compileLifecycleActionSet(caller),
        ({ code }) => code === 'lifecycle-caller-state-forbidden'
    )
})


test('root Skill cannot bypass the lifecycle compiler or hand-author actions', () => {
    const skill = fs.readFileSync(
        path.join(root, 'skills/issue-orchestration/SKILL.md'),
        'utf8'
    )
    const reference = fs.readFileSync(
        path.join(
            root,
            'skills/issue-orchestration/references/dag-and-scheduling.md'
        ),
        'utf8'
    )
    assert.match(skill, /compileLifecycleActionSet/u)
    assert.match(skill, /Root 不得手选 stage、手写 action/u)
    assert.match(skill, /直到它返回 canonical quiescent `idle`/u)
    assert.match(reference, /lifecycle-action-set\.v1/u)
    assert.match(reference, /纯函数/u)
    assert.doesNotMatch(skill, /手工选择下一 stage/u)
})

test('lifecycle compiler remains a pure authority with no runtime side effects', () => {
    const source = fs.readFileSync(
        path.join(
            root,
            'skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs'
        ),
        'utf8'
    )
    for (const forbidden of [
        "node:child_process",
        "node:fs",
        "node:net",
        "node:http",
        "node:https",
        "github.com",
        "api.github.com",
        "codex",
        "setInterval(",
        "setTimeout("
    ]) {
        assert.equal(source.includes(forbidden), false, forbidden)
    }
})

test('verified dispatchability, active slots and quarantine suppress illegal work', () => {
    const nodes = [
        graphNode({ id: 'RepositoryA#20', state: 'candidate-green' }),
        graphNode({ id: 'RepositoryA#21', state: 'candidate-green' })
    ]
    const active = compile(nodes, {
        capacity: 2,
        active: ['RepositoryA#20']
    })
    assert.deepEqual(active.actions.map(({ nodeId }) => nodeId), [
        'RepositoryA#21'
    ])

    const undispatchable = input([nodes[0]])
    withAggregateMutation(undispatchable, (aggregate) => {
        aggregate.nodes['RepositoryA#20'].dispatchable = false
    })
    assert.equal(
        compileLifecycleActionSet(undispatchable).actions[0].type,
        'idle'
    )

    const quarantined = input([nodes[0]])
    withAggregateMutation(quarantined, (aggregate) => {
        aggregate.nodes['RepositoryA#20'].status = 'quarantined'
        aggregate.nodes['RepositoryA#20'].dispatchable = false
        aggregate.nodes['RepositoryA#20'].quarantine = {
            errorCode: 'node-ledger-replay-invalid'
        }
    })
    assert.equal(
        compileLifecycleActionSet(quarantined).actions[0].type,
        'terminalize-node'
    )
})

test('run-level group delivery is serialized ahead of unrelated dispatch', () => {
    const nodes = [
        graphNode({
            id: 'RepositoryA#20',
            state: 'delivery-ready',
            acceptanceGroup: 'group-a'
        }),
        graphNode({ id: 'RepositoryA#21', state: 'candidate-green' })
    ]
    const result = compile(nodes, {
        capacity: 2,
        acceptanceGroups: { 'group-a': ['RepositoryA#20'] }
    })
    assert.equal(result.actions.length, 1)
    assert.equal(result.actions[0].type, 'deliver-acceptance-group')
})

test('re-signed actions with missing immutable bindings fail validation', () => {
    const node = graphNode({ id: 'RepositoryA#20', state: 'candidate-green' })
    const forged = JSON.parse(JSON.stringify(compile([node])))
    delete forged.actions[0].bindings.priorLedgerHeadDigest
    delete forged.actions[0].actionDigest
    forged.actions[0].actionDigest = digest(forged.actions[0])
    delete forged.actionSetDigest
    forged.actionSetDigest = digest(forged)
    assert.throws(
        () => validateLifecycleActionSet(forged),
        ({ code }) => code === 'lifecycle-action-ledger-head-invalid'
    )
})
