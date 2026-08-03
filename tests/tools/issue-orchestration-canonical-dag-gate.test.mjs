import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
    validateDagStartupGate
} from '../../skills/issue-orchestration/scripts/check-dag-gate.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    LIFECYCLE_STATE_DEFINITIONS
} from '../../skills/issue-orchestration/scripts/lifecycle-state-machine.mjs'
import {
    compileRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    createTrustedRepositoryFixture
} from './issue-orchestration-trusted-repository-test-helper.mjs'

const startup = verifiedRuntimeStartup({})
const policyDigest = startup.observation.policyDigests.modelPool
const repositoryPath = createTrustedRepositoryFixture()
const selectorReceiptDigest = digest('selector')
const remoteSnapshotDigest = digest('remote')
const repositoryBindingDigest = digest('repository-binding')
const semanticFactsDigest = digest('semantic-facts')
const HASH = /^[a-f0-9]{64}$/u

const digestFields = {
    planningRoute: 'routeDecisionDigest',
    slicePlanProposal: 'proposalDigest',
    workPlan: 'workPlanDigest',
    executableSlice: 'sliceDigest',
    routeDecision: 'routeDecisionDigest',
    compiledPrompt: 'promptDigest',
    uiAdjudicationRoute: 'routeDecisionDigest',
    uxAcceptanceRoute: 'routeDecisionDigest',
    documentationRoute: 'routeDecisionDigest'
}
const agentReceipts = new Set([
    'planningRoute', 'planningAttempt', 'testContractPlan',
    'slicePlanProposal', 'routeDecision', 'writerDispatch',
    'activeAttempt', 'writerCheckpoint', 'writerFailure',
    'retryAuthorization', 'implementationTerminal', 'behavior',
    'uiAdjudicationRoute', 'uiAdjudication', 'uxAcceptanceRoute',
    'uxAcceptance', 'documentationRoute', 'documentation',
    'deliveryAttempt'
])

function receipt(key, memberId, predecessors) {
    const digestField = digestFields[key] ?? 'receiptDigest'
    const value = {
        schema: `issue-orchestration.${key}.v1`,
        memberId,
        selectorReceiptDigest,
        remoteSnapshotDigest,
        repositoryBindingDigest,
        predecessorReceiptDigests: [...predecessors].sort()
    }
    if (agentReceipts.has(key)) {
        value.actorRole = key.includes('documentation')
            ? 'documentation-writer'
            : key.includes('ux')
                ? 'ux-acceptance-verifier'
                : key.includes('uiAdjudication')
                    ? 'ui-system-adjudicator'
                    : key === 'behavior'
                        ? 'test-owner'
                        : key.startsWith('planning') ||
                            key === 'testContractPlan' ||
                            key === 'slicePlanProposal'
                            ? 'test-owner'
                            : 'code-implementer'
        value.runtimeExecutionBindingDigest = digest(`${key}:runtime`)
        value.mutationPostconditionEvidenceDigest = digest(`${key}:mutation`)
        if (digestField !== 'routeDecisionDigest') {
            value.routeDecisionDigest = digest(`${key}:route`)
        }
    } else {
        value.compilerAuthority = `deterministic-${key}-compiler`
    }
    value[digestField] = digest(value)
    return value
}

function receiptsFor(state, memberId) {
    const result = {}
    const digests = []
    for (const key of LIFECYCLE_STATE_DEFINITIONS[state].allowedReceipts) {
        if (!LIFECYCLE_STATE_DEFINITIONS[state].requiredReceipts.includes(key)) {
            continue
        }
        const value = receipt(key, memberId, digests)
        result[key] = value
        digests.push(value[digestFields[key] ?? 'receiptDigest'])
    }
    return result
}

function graphNode(memberId, issueNumber, state = 'discovered') {
    return {
        id: memberId,
        memberId,
        repository: 'ExampleOrg/RepositoryA',
        issueNumber,
        owner: 'team-a',
        dependencyKeys: [],
        conflictKeys: [],
        riskClass: 'ordinary',
        uiClass: 'non-ui',
        acceptanceGroup: null,
        lifecycleState: state,
        selectorReceiptDigest,
        remoteSnapshotDigest,
        repositoryBindingDigest,
        semanticFactsDigest: digest(`${semanticFactsDigest}:${issueNumber}`),
        receipts: receiptsFor(state, memberId)
    }
}

function request(states = ['discovered', 'discovered']) {
    const nodes = states.map((state, index) => graphNode(
        `ExampleOrg/RepositoryA#${20 + index}`,
        20 + index,
        state
    ))
    const dag = createSemanticGraph({
        selectorReceiptDigest,
        remoteSnapshotDigest,
        scopeDigest: digest('scope'),
        semanticGraphInputDigest: digest('graph-input'),
        policyDigest,
        repositories: [{
            repository: 'ExampleOrg/RepositoryA',
            baseSha: 'a'.repeat(40),
            bindingDigest: repositoryBindingDigest
        }],
        nodes
    })
    const repositoryTargets = [{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath
    }]
    return {
        schema: 'issue-orchestration.dag-startup-gate-request.v2',
        authoritySource: 'permanent-shared-package',
        selectorReceipt: {
            schema: 'issue-orchestration.scope-selector-receipt.v1',
            receiptDigest: selectorReceiptDigest,
            remoteSnapshotDigest,
            startupAttestationDigest: startup.attestation.attestationDigest,
            runtimeInvocationId: startup.attestation.runtimeInvocationId
        },
        dag,
        startup,
        repositoryTargets,
        runtimeTrustBinding: compileRuntimeTrustBinding({
            role: 'root-scheduler',
            executionClass: 'root-control',
            runtimeId: 'codex',
            multiAgentBackend: 'v2',
            approvalPolicy: 'never',
            effectivePermissionProfile: 'danger-full-access',
            permissionProfileObserved: true,
            repositoryTargets,
            startup
        })
    }
}

function resealGraph(value) {
    const unsigned = structuredClone(value.dag)
    delete unsigned.semanticGraphDigest
    value.dag.semanticGraphDigest = digest(unsigned)
}

test('two fresh discovered issues pass without future receipts', () => {
    const value = request()
    const result = validateDagStartupGate(value)
    assert.equal(result.status, 'verified')
    assert.equal(result.memberCount, 2)
    assert.match(result.receiptDigest, HASH)
    assert.deepEqual(value.dag.nodes.map((node) => node.receipts), [{}, {}])
})

test('canonical gate rejects stale graph and member bindings', () => {
    const mutations = [
        (value) => { value.dag.selectorReceiptDigest = digest('stale') },
        (value) => { value.dag.remoteSnapshotDigest = digest('stale') },
        (value) => { value.dag.nodes[0].selectorReceiptDigest = digest('stale') },
        (value) => { value.dag.nodes[0].remoteSnapshotDigest = digest('stale') },
        (value) => { value.dag.nodes[0].repositoryBindingDigest = digest('stale') },
        (value) => { value.dag.nodes[0].semanticFactsDigest = null }
    ]
    for (const mutate of mutations) {
        const value = request()
        mutate(value)
        resealGraph(value)
        assert.throws(() => validateDagStartupGate(value))
    }
})

test('table-driven lifecycle matrix rejects missing and premature receipts', () => {
    const states = [
        'discovered', 'acceptance-frozen', 'test-contract-planning',
        'test-contract-frozen', 'implementing', 'candidate-green',
        'behavior-green', 'delivery-ready', 'delivering', 'cleaning', 'closed'
    ]
    for (const state of states) {
        const value = request([state])
        assert.doesNotThrow(() => validateDagStartupGate(value), state)
        const definition = LIFECYCLE_STATE_DEFINITIONS[state]
        if (definition.requiredReceipts.length > 0) {
            const missing = request([state])
            delete missing.dag.nodes[0].receipts[
                definition.requiredReceipts.at(-1)
            ]
            resealGraph(missing)
            assert.throws(
                () => validateDagStartupGate(missing),
                { code: 'dag-gate-required-receipt-missing' },
                `${state}: missing`
            )
        }
        const nextReceipt = Object.keys(digestFields)
            .concat(['candidate', 'behavior', 'delivery'])
            .find((key) => !definition.allowedReceipts.includes(key))
        if (nextReceipt) {
            const premature = request([state])
            premature.dag.nodes[0].receipts[nextReceipt] = receipt(
                nextReceipt,
                premature.dag.nodes[0].memberId,
                []
            )
            resealGraph(premature)
            assert.throws(
                () => validateDagStartupGate(premature),
                { code: 'dag-gate-premature-receipt' },
                `${state}: premature`
            )
        }
    }
})

test('placeholder candidate and behavior receipts fail closed', () => {
    for (const [state, key] of [
        ['candidate-green', 'candidate'],
        ['behavior-green', 'behavior']
    ]) {
        const value = request([state])
        value.dag.nodes[0].receipts[key] = {
            memberId: value.dag.nodes[0].memberId,
            receiptDigest: 'f'.repeat(64)
        }
        resealGraph(value)
        assert.throws(
            () => validateDagStartupGate(value),
            { code: 'dag-gate-receipt-schema' }
        )
    }
})

test('legacy graph authorities share one migration error', () => {
    for (const mutate of [
        (value) => { value.dag.schema = 'issue-orchestration.dag.v2' },
        (value) => { value.dag.schema = 'issue-orchestration.semantic-graph.v1' },
        (value) => { value.dag.testContractDigest = digest('legacy') },
        (value) => { value.dag.stageReceipts = {} }
    ]) {
        const value = request()
        mutate(value)
        assert.throws(
            () => validateDagStartupGate(value),
            { code: 'dag-gate-canonical-migration-required' }
        )
    }
})

test('CLI emits the same canonical receipt as the library API', () => {
    const value = request()
    const expected = `${JSON.stringify(validateDagStartupGate(value))}\n`
    const result = spawnSync(process.execPath, [
        'skills/issue-orchestration/scripts/check-dag-gate.mjs'
    ], {
        cwd: new URL('../..', import.meta.url),
        input: JSON.stringify(value),
        encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected)
})
