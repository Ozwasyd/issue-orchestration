import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    actorContextEnvelopeActionTypes,
    compileActorContextEnvelope,
    resolveActorContextReference,
    validateActorContextEnvelope,
    validateActorContextEnvelopeBinding
} from '../../skills/issue-orchestration/scripts/actor-context-envelope.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
const hash = (value) => digest(value)
const sha = 'b'.repeat(40)

const TOP = Object.freeze({
    selectorReceiptDigest: hash('selector'),
    remoteSnapshotDigest: hash('remote'),
    semanticGraphDigest: hash('graph'),
    aggregateProjectionDigest: hash('aggregate'),
    policyDigest: hash('policy'),
    runtimeCapabilityBindingDigest: hash('capability'),
    lifecycleAuthorityBindingDigest: hash('authority'),
    startupAttestationDigest: hash('startup')
})

function actionBundle(type, { ui = false } = {}) {
    const nodeId = 'Fixture/Repo#73'
    const bindings = {
        runId: 'actor-context-run',
        memberId: nodeId,
        repository: 'Fixture/Repo',
        issueNumber: 73,
        baseSha: sha,
        nodeEpoch: 4,
        nodeProjectionDigest: hash('node-projection'),
        priorLedgerHeadDigest: hash('ledger-head'),
        runtimeInvocationId: 'runtime-invocation',
        runtimeSessionId: 'runtime-session',
        rootAuthorityEpoch: 'root-authority-epoch',
        runtimeTrustBindingDigest: hash('trust'),
        repositoryIdentitySetDigest: hash('repository-identities'),
        repositoryBindingSetDigest: hash('repository-bindings'),
        repositoryBindingDigest: hash('repository-binding'),
        packageDigest: hash('package'),
        manifestDigest: hash('manifest'),
        policySetDigest: hash('policy-set'),
        ...TOP
    }
    const action = {
        schema: 'issue-orchestration.lifecycle-action.v1',
        type,
        executionClass: 'actor',
        nodeId,
        bindings
    }
    action.actionDigest = digest(action)
    const actionSet = {
        schema: 'issue-orchestration.lifecycle-action-set.v1',
        runId: bindings.runId,
        ...TOP,
        runtimeInvocationId: bindings.runtimeInvocationId,
        runtimeSessionId: bindings.runtimeSessionId,
        rootAuthorityEpoch: bindings.rootAuthorityEpoch,
        runtimeTrustBindingDigest: bindings.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest: bindings.repositoryIdentitySetDigest,
        repositoryBindingSetDigest: bindings.repositoryBindingSetDigest,
        packageDigest: bindings.packageDigest,
        manifestDigest: bindings.manifestDigest,
        policySetDigest: bindings.policySetDigest,
        availableSlots: 2,
        quiescent: false,
        actions: [action]
    }
    actionSet.actionSetDigest = digest(actionSet)
    const acceptance = {
        acceptanceItems: [
            { id: 'AC-1', statement: 'The exact behavior is verified.' },
            { id: 'AC-2', statement: 'No unrelated state changes.' }
        ]
    }
    const plan = {
        stageRole: ui ? 'ui-ux-implementer' : 'code-implementer',
        stagePhase: ui ? 'ui-implementation' : 'implementation',
        acceptanceItems: ['AC-1', 'AC-2'],
        orderedSlices: ['slice-1']
    }
    const slice = {
        sliceId: 'slice-1',
        acceptanceItemIds: ['AC-1'],
        firstRequiredAction: 'inspect src/current.mjs',
        requiredFiles: ['src/current.mjs', 'tests/current.test.mjs'],
        allowedPaths: ['src/current.mjs', 'tests/current.test.mjs'],
        requiredCommands: ['node --test tests/current.test.mjs']
    }
    const prompt = {
        promptId: 'prompt-1',
        firstRequiredAction: slice.firstRequiredAction,
        requiredFiles: [...slice.requiredFiles],
        requiredCommands: [...slice.requiredCommands]
    }
    const candidate = {
        candidateSha: sha,
        writerInvocationId: 'writer-invocation',
        frozen: true
    }
    const node = {
        id: nodeId,
        memberId: nodeId,
        repository: bindings.repository,
        issueNumber: bindings.issueNumber,
        owner: 'dag-creator-updater',
        uiClass: ui ? 'ui' : 'non-ui',
        lifecycleState: 'implementing',
        semanticFactsDigest: hash('semantic-facts'),
        firstFailure: {
            category: 'required-command-red',
            failureId: 'failure-1'
        },
        recoveryState: {
            checkpointCursor: 'command-2'
        },
        receipts: {
            acceptanceContract: {
                receiptDigest: hash('acceptance-receipt'),
                evidence: { acceptanceContract: acceptance }
            },
            workPlan: {
                workPlanDigest: hash('work-plan'),
                evidence: { plan }
            },
            executableSlice: {
                sliceDigest: hash('slice'),
                evidence: { slice }
            },
            compiledPrompt: {
                promptDigest: hash('prompt'),
                evidence: { prompt }
            },
            candidate: {
                receiptDigest: hash('candidate-receipt'),
                evidence: { candidate }
            },
            uiAdjudication: {
                receiptDigest: hash('ui-adjudication-receipt'),
                evidence: {
                    uiAdjudication: {
                        adjudication: 'bounded-ui-contract-confirmed',
                        candidateSha: sha
                    }
                }
            },
            continuation: {
                receiptDigest: hash('continuation')
            }
        }
    }
    return {
        action,
        actionSet,
        projection: {
            state: { nodes: { [nodeId]: node } },
            semanticGraph: { forbidden: 'must-not-enter-envelope' },
            aggregateProjection: { forbidden: 'must-not-enter-envelope' }
        },
        node,
        plan,
        slice,
        prompt
    }
}

function repository(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-context-'))
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'AGENTS.md'),
        'Only modify the exact allowlisted paths.\n')
    fs.writeFileSync(path.join(directory, 'src', 'AGENTS.override.md'),
        'Run the required test command before returning.\n')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

function preparedContext(bundle) {
    return {
        inputs: {
            issue: {
                repository: 'Fixture/Repo',
                number: 73,
                title: 'Compile a bounded actor context',
                body: 'Normative issue text. '.repeat(220),
                comments: [{ body: 'Relevant clarification.' }],
                labels: ['P1'],
                state: 'OPEN',
                updatedAt: '2026-08-06T00:00:00.000Z'
            },
            selectorReceipt: { receiptDigest: TOP.selectorReceiptDigest },
            attemptId: 'planning-attempt-1'
        },
        node: bundle.node,
        repositoryPath: '/must/not/be/copied',
        stateRootPath: '/must/not/be/copied',
        lifecycleAuthority: { forbidden: true }
    }
}

function compile(type, options = {}, t) {
    const bundle = actionBundle(type, options)
    const repositoryPath = repository(t)
    return {
        bundle,
        repositoryPath,
        envelope: compileActorContextEnvelope({
            action: bundle.action,
            actionSet: bundle.actionSet,
            projection: bundle.projection,
            preparedContext: preparedContext(bundle),
            repositoryPath
        })
    }
}

const expectations = {
    'request-semantic-proposal': ['dag-creator-updater', 'semantic-proposal'],
    'request-test-contract-planning': ['test-owner', 'test-contract-planning'],
    'dispatch-test-contract-writer': ['test-owner', 'test-contract'],
    'dispatch-implementation-writer': ['code-implementer', 'implementation'],
    'dispatch-behavior-verifier': ['test-owner', 'behavior-verification'],
    'request-ui-adjudication': ['ui-system-adjudicator', 'adjudication'],
    'dispatch-ux-acceptance-verifier': ['ux-acceptance-verifier', 'ux-acceptance'],
    'dispatch-documentation-writer': ['documentation-writer', 'documentation']
}

test('every actor action compiles one explicit bounded envelope', (t) => {
    assert.deepEqual(actorContextEnvelopeActionTypes,
        Object.keys(expectations).sort())
    for (const type of actorContextEnvelopeActionTypes) {
        const { bundle, envelope } = compile(type, {}, t)
        const [role, phase] = expectations[type]
        assert.equal(envelope.role, role)
        assert.equal(envelope.phase, phase)
        assert.equal(envelope.actionType, type)
        assert.equal(envelope.identities.actionDigest,
            bundle.action.actionDigest)
        assert.equal(envelope.identities.actionSetDigest,
            bundle.actionSet.actionSetDigest)
        assert.deepEqual(envelope.authority, {
            kind: 'actor-input-only',
            grants: []
        })
        assert.equal(validateActorContextEnvelope(envelope).envelopeDigest,
            envelope.envelopeDigest)
        assert.equal(
            validateActorContextEnvelopeBinding(envelope, {
                action: bundle.action,
                role,
                phase
            }).envelopeDigest,
            envelope.envelopeDigest
        )
    }
})

test('writer envelope contains the current slice but no whole-run authority', (t) => {
    const { bundle, envelope } = compile(
        'dispatch-implementation-writer',
        { ui: true },
        t
    )
    assert.equal(envelope.role, 'ui-ux-implementer')
    assert.equal(envelope.phase, 'ui-implementation')
    assert.deepEqual(envelope.stageContext.stageWorkPlan, bundle.plan)
    assert.deepEqual(envelope.stageContext.executableSlice, bundle.slice)
    assert.deepEqual(envelope.stageContext.compiledPrompt, bundle.prompt)
    assert.deepEqual(envelope.acceptanceItemIds, ['AC-1', 'AC-2'])
    assert.deepEqual(envelope.stageContext.writeAllowlist,
        ['src/current.mjs', 'tests/current.test.mjs'])
    assert.equal(envelope.instructions.status, 'resolved')
    assert.deepEqual(envelope.instructions.entries.map(({ path: item }) => item),
        ['AGENTS.md', 'src/AGENTS.override.md'])
    const serialized = JSON.stringify(envelope)
    for (const forbidden of [
        '"ledger"',
        '"actionSet"',
        '"semanticGraph"',
        '"aggregateProjection"',
        'stateRootPath',
        '"lifecycleAuthority":',
        'writerConversation',
        'futureStageHistory'
    ]) assert.equal(serialized.includes(forbidden), false, forbidden)
})

test('verifier envelopes expose candidate evidence without writer history', (t) => {
    for (const type of [
        'dispatch-behavior-verifier',
        'dispatch-ux-acceptance-verifier'
    ]) {
        const { envelope } = compile(type, {}, t)
        assert.equal(envelope.stageContext.candidate.candidateSha, sha)
        assert.equal(
            envelope.stageContext.acceptanceContract.acceptanceItems.length,
            2
        )
        if (type === 'dispatch-ux-acceptance-verifier') {
            assert.equal(
                envelope.stageContext.uiAdjudication.adjudication,
                'bounded-ui-contract-confirmed'
            )
        }
        assert.equal(JSON.stringify(envelope).includes('rolloutRecords'), false)
    }
})

test('large source blocks become stage-scoped content-addressed references', (t) => {
    const bundle = actionBundle('request-semantic-proposal')
    const sourceBlocks = [{
        sourceId: 'large-normative-source',
        kind: 'normative-source',
        path: 'docs/requirements.md',
        text: 'Normative source line. '.repeat(300),
        allowedRoles: ['dag-creator-updater'],
        allowedPhases: ['semantic-proposal'],
        nodeId: bundle.action.nodeId
    }]
    const envelope = compileActorContextEnvelope({
        action: bundle.action,
        actionSet: bundle.actionSet,
        projection: bundle.projection,
        preparedContext: preparedContext(bundle),
        actorContext: { sourceBlocks },
        repositoryPath: repository(t)
    })
    const reference = envelope.sources.progressive.find(({ sourceId }) =>
        sourceId === 'large-normative-source')
    assert.ok(reference)
    assert.equal('text' in reference, false)
    const resolved = resolveActorContextReference({
        envelope,
        referenceId: reference.referenceId,
        role: envelope.role,
        phase: envelope.phase,
        nodeId: bundle.action.nodeId,
        path: reference.path,
        digest: reference.digest,
        sourceBlocks
    })
    assert.equal(resolved.text, sourceBlocks[0].text)
    for (const mutation of [
        { role: 'test-owner' },
        { phase: 'implementation' },
        { nodeId: 'Fixture/Repo#999' },
        { path: 'docs/other.md' },
        { digest: hash('wrong') }
    ]) {
        assert.throws(() => resolveActorContextReference({
            envelope,
            referenceId: reference.referenceId,
            role: envelope.role,
            phase: envelope.phase,
            nodeId: bundle.action.nodeId,
            path: reference.path,
            digest: reference.digest,
            sourceBlocks,
            ...mutation
        }), (error) => error?.code ===
            'actor-context-progressive-reference-rejected')
    }
})

test('forbidden broad, secret, and writer issue sources fail closed', (t) => {
    const bundle = actionBundle('dispatch-implementation-writer')
    for (const source of [
        {
            kind: 'complete-ledger',
            path: 'ledger.jsonl',
            text: '{}'
        },
        {
            kind: 'raw-complete-issue',
            path: 'issue://Fixture/Repo#73',
            text: 'full issue'
        },
        {
            kind: 'source-excerpt',
            path: 'src/key.txt',
            text: 'api_key=do-not-copy-this-secret-value'
        }
    ]) {
        assert.throws(() => compileActorContextEnvelope({
            action: bundle.action,
            actionSet: bundle.actionSet,
            projection: bundle.projection,
            preparedContext: preparedContext(bundle),
            actorContext: { sourceBlocks: [source] },
            repositoryPath: repository(t)
        }), (error) => [
            'actor-context-source-kind-forbidden',
            'actor-context-source-size-or-secret-invalid'
        ].includes(error?.code))
    }
})

test('the envelope is smaller than broad context and rejects tampering', (t) => {
    const { bundle, envelope } = compile(
        'dispatch-test-contract-writer',
        {},
        t
    )
    const broad = {
        ledger: { events: Array.from({ length: 200 }, (_, index) => ({ index })) },
        actionSet: bundle.actionSet,
        projection: bundle.projection,
        completeIssueHistory: 'history '.repeat(5000),
        rootSummary: 'summary '.repeat(1000)
    }
    assert.ok(envelope.measurement.envelopeBytes <
        Buffer.byteLength(JSON.stringify(broad), 'utf8'))
    const tampered = structuredClone(envelope)
    tampered.stageContext.lifecycleState = 'forged'
    assert.throws(() => validateActorContextEnvelope(tampered),
        (error) => error?.code === 'actor-context-envelope-digest-mismatch')
    const selfSigned = structuredClone(envelope)
    selfSigned.stageContext.completeRepositoryDump = 'forged authority'
    delete selfSigned.envelopeDigest
    selfSigned.envelopeDigest = digest(selfSigned)
    assert.throws(() => validateActorContextEnvelope(selfSigned),
        (error) => error?.code === 'actor-context-stage-fields-invalid')
})
