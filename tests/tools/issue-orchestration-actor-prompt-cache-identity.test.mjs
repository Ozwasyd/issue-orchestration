import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    compileActorContextEnvelope
} from '../../skills/issue-orchestration/scripts/actor-context-envelope.mjs'
import {
    ACTOR_PROMPT_ROLE_INSTRUCTIONS,
    compileActorPromptBundle,
    sanitizeProviderPromptCacheMetadata,
    validateActorPromptBundle
} from '../../skills/issue-orchestration/scripts/actor-prompt-cache-identity.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'

const hash = (value) => digest(value)
const sha = 'b'.repeat(40)

function routeDecision(seed = 'route') {
    return {
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        routeCellId: `implementation:${seed}`,
        routeCellDigest: hash(`route-cell:${seed}`),
        selectedProfile: 'terra-medium',
        routeDecisionDigest: hash(`route-decision:${seed}`)
    }
}

function repository(t, instruction = 'Only modify allowlisted paths.\n') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-'))
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), instruction)
    fs.writeFileSync(path.join(directory, 'src', 'current.mjs'),
        'export const targetSymbol = 1\n')
    fs.writeFileSync(path.join(directory, 'tests', 'current.test.mjs'),
        "import { targetSymbol } from '../src/current.mjs'\n")
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

function writerEnvelope(t, {
    nodeId = 'Fixture/Repo#76',
    issueNumber = 76,
    policySeed = 'policy',
    packageSeed = 'package',
    instruction = 'Only modify allowlisted paths.\n',
    candidateSeed = 'candidate',
    sliceAction = 'inspect src/current.mjs',
    checkpointCursor = 'command-2'
} = {}) {
    const top = {
        selectorReceiptDigest: hash('selector'),
        remoteSnapshotDigest: hash('remote'),
        semanticGraphDigest: hash('graph'),
        aggregateProjectionDigest: hash('aggregate'),
        policyDigest: hash(policySeed),
        runtimeCapabilityBindingDigest: hash('capability'),
        lifecycleAuthorityBindingDigest: hash('authority'),
        startupAttestationDigest: hash('startup')
    }
    const bindings = {
        runId: 'prompt-cache-run',
        memberId: nodeId,
        repository: 'Fixture/Repo',
        issueNumber,
        baseSha: sha,
        nodeEpoch: 4,
        nodeProjectionDigest: hash(`node:${nodeId}`),
        priorLedgerHeadDigest: hash('ledger-head'),
        runtimeInvocationId: 'runtime-invocation',
        runtimeSessionId: 'runtime-session',
        rootAuthorityEpoch: 'root-authority-epoch',
        runtimeTrustBindingDigest: hash('trust'),
        repositoryIdentitySetDigest: hash('repository-identities'),
        repositoryBindingSetDigest: hash('repository-bindings'),
        repositoryBindingDigest: hash('repository-binding'),
        packageDigest: hash(packageSeed),
        manifestDigest: hash(`manifest:${packageSeed}`),
        policySetDigest: hash(`policy-set:${policySeed}`),
        ...top
    }
    const action = {
        schema: 'issue-orchestration.lifecycle-action.v1',
        type: 'dispatch-implementation-writer',
        executionClass: 'actor',
        nodeId,
        bindings
    }
    action.actionDigest = digest(action)
    const actionSet = {
        schema: 'issue-orchestration.lifecycle-action-set.v1',
        runId: bindings.runId,
        ...top,
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
        acceptanceItems: [{ id: 'AC-1', statement: 'Verified.' }]
    }
    const plan = {
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        acceptanceItems: ['AC-1'],
        orderedSlices: ['slice-1']
    }
    const slice = {
        sliceId: 'slice-1',
        acceptanceItemIds: ['AC-1'],
        firstRequiredAction: sliceAction,
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
    const node = {
        id: nodeId,
        memberId: nodeId,
        repository: bindings.repository,
        issueNumber,
        owner: 'dag-creator-updater',
        uiClass: 'non-ui',
        lifecycleState: 'implementing',
        firstFailure: {
            category: 'required-command-red',
            failureId: 'failure-1'
        },
        recoveryState: { checkpointCursor },
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
                sliceDigest: hash(`slice:${sliceAction}`),
                evidence: { slice }
            },
            compiledPrompt: {
                promptDigest: hash(`prompt:${sliceAction}`),
                evidence: { prompt }
            },
            candidate: {
                receiptDigest: hash(candidateSeed),
                evidence: {
                    candidate: {
                        candidateSha: sha,
                        writerInvocationId: candidateSeed,
                        frozen: true
                    }
                }
            },
            continuation: { receiptDigest: hash('continuation') }
        }
    }
    const repositoryPath = repository(t, instruction)
    const envelope = compileActorContextEnvelope({
        action,
        actionSet,
        projection: { state: { nodes: { [nodeId]: node } } },
        preparedContext: {
            inputs: {
                issue: {
                    repository: bindings.repository,
                    number: issueNumber,
                    title: 'Prompt cache fixture',
                    body: 'Bounded normative input.',
                    comments: [],
                    labels: ['P1'],
                    state: 'OPEN',
                    updatedAt: '2026-08-06T00:00:00.000Z'
                },
                attemptId: 'attempt-1'
            },
            node
        },
        repositoryPath
    })
    return { envelope, action }
}

function roleInstructionFromFile(role) {
    const file = path.join('agents', `${role}.toml`)
    const source = fs.readFileSync(file, 'utf8')
    const match = source.match(/developer_instructions = """\n([\s\S]*?)\n"""/u)
    assert.ok(match, file)
    return match[1]
}

test('stable role contracts are exactly the thinned agent instructions', () => {
    for (const [role, instruction] of Object.entries(
        ACTOR_PROMPT_ROLE_INSTRUCTIONS
    )) {
        assert.equal(instruction, roleInstructionFromFile(role), role)
    }
})

test('same role phase package and policy reuse one stable prefix', (t) => {
    const first = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t).envelope,
        routeDecision: routeDecision()
    })
    const second = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t, {
            nodeId: 'Fixture/Repo#77',
            issueNumber: 77,
            instruction: 'Different repository instruction.\n',
            candidateSeed: 'candidate-b',
            sliceAction: 'inspect tests/current.test.mjs'
        }).envelope,
        routeDecision: routeDecision()
    })
    assert.equal(
        first.cacheIdentity.stablePrefixDigest,
        second.cacheIdentity.stablePrefixDigest
    )
    assert.notEqual(
        first.cacheIdentity.suffixDigest,
        second.cacheIdentity.suffixDigest
    )
    assert.notEqual(
        first.cacheIdentity.completePromptDigest,
        second.cacheIdentity.completePromptDigest
    )
    const keys = new Set()
    const collectKeys = (value) => {
        if (Array.isArray(value)) return value.forEach(collectKeys)
        if (!value || typeof value !== 'object') return
        for (const [key, entry] of Object.entries(value)) {
            keys.add(key)
            collectKeys(entry)
        }
    }
    collectKeys(first.stablePrefix)
    for (const forbidden of [
        'runId', 'nodeId', 'issueNumber', 'baseSha', 'actionDigest',
        'candidate', 'checkpoint', 'executableSlice', 'repositoryEvidencePack'
    ]) assert.equal(keys.has(forbidden), false, forbidden)

})

test('volatile authority changes only the suffix identity', (t) => {
    const baselineEnvelope = writerEnvelope(t).envelope
    const baseline = compileActorPromptBundle({
        actorContextEnvelope: baselineEnvelope,
        routeDecision: routeDecision()
    })
    const cases = [
        {
            envelope: writerEnvelope(t, {
                nodeId: 'Fixture/Repo#79', issueNumber: 79
            }).envelope,
            route: routeDecision()
        },
        {
            envelope: writerEnvelope(t, {
                instruction: 'Use a different bounded instruction.\n'
            }).envelope,
            route: routeDecision()
        },
        {
            envelope: writerEnvelope(t, {
                sliceAction: 'inspect tests/current.test.mjs'
            }).envelope,
            route: routeDecision()
        },
        {
            envelope: writerEnvelope(t, {
                checkpointCursor: 'command-3'
            }).envelope,
            route: routeDecision()
        },
        { envelope: baselineEnvelope, route: routeDecision('route-next') }
    ]
    for (const { envelope, route } of cases) {
        const changed = compileActorPromptBundle({
            actorContextEnvelope: envelope,
            routeDecision: route
        })
        assert.equal(
            changed.cacheIdentity.stablePrefixDigest,
            baseline.cacheIdentity.stablePrefixDigest
        )
        assert.notEqual(
            changed.cacheIdentity.suffixDigest,
            baseline.cacheIdentity.suffixDigest
        )
    }
})

test('package or policy drift changes the stable prefix identity', (t) => {
    const baseline = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t).envelope,
        routeDecision: routeDecision()
    })
    for (const options of [
        { packageSeed: 'package-next' },
        { policySeed: 'policy-next' }
    ]) {
        const changed = compileActorPromptBundle({
            actorContextEnvelope: writerEnvelope(t, options).envelope,
            routeDecision: routeDecision()
        })
        assert.notEqual(
            baseline.cacheIdentity.stablePrefixDigest,
            changed.cacheIdentity.stablePrefixDigest
        )
    }
})

test('complete prompt digest binds stable prefix before volatile suffix', (t) => {
    const bundle = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t).envelope,
        routeDecision: routeDecision(),
        tokenizerIdentity: { name: 'fixture-tokenizer', revision: '1' },
        runtimeIdentity: 'fixture-runtime'
    })
    assert.equal(validateActorPromptBundle(bundle).bundleDigest,
        bundle.bundleDigest)
    const reversed = structuredClone(bundle)
    reversed.completePrompt = JSON.stringify({
        volatileSuffix: reversed.volatileSuffix,
        stablePrefix: reversed.stablePrefix
    })
    delete reversed.bundleDigest
    reversed.bundleDigest = digest(reversed)
    assert.throws(() => validateActorPromptBundle(reversed), {
        code: 'actor-prompt-complete-prompt-mismatch'
    })
})

test('provider cache metadata is bounded diagnostic data only', () => {
    assert.deepEqual(sanitizeProviderPromptCacheMetadata({
        provider: 'fixture',
        supported: true,
        hit: true,
        cachedInputTokens: 120,
        ignoredAuthority: 'must-not-survive'
    }), {
        cachedInputTokens: 120,
        hit: true,
        provider: 'fixture',
        supported: true
    })
    assert.throws(() => sanitizeProviderPromptCacheMetadata({ hit: 'yes' }), {
        code: 'actor-prompt-provider-metadata-invalid'
    })
})

test('stable token accounting is reusable while suffix accounting changes', (t) => {
    const first = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t).envelope,
        routeDecision: routeDecision()
    })
    const second = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t, {
            nodeId: 'Fixture/Repo#78',
            issueNumber: 78,
            sliceAction: 'inspect a different bounded path'
        }).envelope,
        routeDecision: routeDecision()
    })
    assert.equal(
        first.tokenAccounting.stablePrefixBytes,
        second.tokenAccounting.stablePrefixBytes
    )
    assert.equal(
        first.tokenAccounting.stablePrefixEstimatedTokens,
        second.tokenAccounting.stablePrefixEstimatedTokens
    )
    assert.notEqual(
        first.tokenAccounting.volatileSuffixBytes,
        second.tokenAccounting.volatileSuffixBytes
    )
})


test('unknown prefix and accounting fields cannot be re-signed', (t) => {
    const baseline = compileActorPromptBundle({
        actorContextEnvelope: writerEnvelope(t).envelope,
        routeDecision: routeDecision()
    })
    for (const mutate of [
        (value) => { value.stablePrefix.currentCandidate = 'forbidden' },
        (value) => { value.tokenAccounting.fakeTokens = 1 },
        (value) => { value.cacheIdentity.providerAuthority = 'forbidden' }
    ]) {
        const changed = structuredClone(baseline)
        mutate(changed)
        changed.cacheIdentity.stablePrefixDigest = digest(changed.stablePrefix)
        changed.cacheIdentity.suffixDigest = digest(changed.volatileSuffix)
        changed.cacheIdentity.completePromptDigest = digest({
            schema: 'issue-orchestration.actor-prompt-ordered-sections.v1',
            sections: [changed.stablePrefix, changed.volatileSuffix]
        })
        const unsignedIdentity = structuredClone(changed.cacheIdentity)
        delete unsignedIdentity.cacheIdentityDigest
        changed.cacheIdentity.cacheIdentityDigest = digest(unsignedIdentity)
        changed.completePrompt = JSON.stringify({
            stablePrefix: changed.stablePrefix,
            volatileSuffix: changed.volatileSuffix
        })
        const unsigned = structuredClone(changed)
        delete unsigned.bundleDigest
        changed.bundleDigest = digest(unsigned)
        assert.throws(
            () => validateActorPromptBundle(changed),
            (error) => /fields-invalid/u.test(error?.code ?? '')
        )
    }
})
