import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    clearLifecycleActionSetCache,
    compileLifecycleRunActionSet,
    lifecycleActionSetCacheObservation,
    lifecycleActionSetCacheStats,
    createLifecycleRunLedger,
    projectLifecycleRun,
    readLifecycleRunLedger,
    recordLifecycleDispatchBatchStarted,
    recordLifecycleDispatchedActionResult
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    LIFECYCLE_ACTION_TYPES
} from '../../skills/issue-orchestration/scripts/lifecycle-transition-compiler.mjs'
import {
    executePreWriterLifecycleAction
} from '../../skills/issue-orchestration/scripts/lifecycle-prewriter-executor.mjs'
import {
    LIFECYCLE_PRODUCTION_DISPATCH_MAP,
    runLifecycleProductionDispatcher
} from '../../skills/issue-orchestration/scripts/lifecycle-production-dispatcher.mjs'
import {
    createDispatcherPerformanceCollector,
    normalizeDispatcherPerformanceReceipt,
    verifyDispatcherPerformanceReceipt
} from '../../skills/issue-orchestration/scripts/dispatcher-performance-telemetry.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const CREATED_AT = '2026-08-05T09:00:00.000Z'
const actorScript = fileURLToPath(new URL(
    './issue-orchestration/prewriter-stage-actor.mjs',
    import.meta.url
))

function git(args, cwd) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_DATE: CREATED_AT,
            GIT_COMMITTER_DATE: CREATED_AT
        }
    })
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout)
    }
    return result.stdout.trim()
}

function repositoryFixture(root) {
    const bare = path.join(root, 'Repo.git')
    const work = path.join(root, 'Repo-work')
    const repository = 'Fixture/Dispatcher'
    const remoteUrl = `https://github.com/${repository}.git`
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'dispatcher-test'], work)
    git(['config', 'user.email', 'dispatcher@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), '# Dispatcher\n')
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize'], work)
    git(['push', '-u', 'origin', 'main'], work)
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return { bare, work, repository, remoteUrl }
}

function issue(repository, number) {
    return {
        repository,
        number,
        state: 'OPEN',
        stateReason: null,
        updatedAt: CREATED_AT,
        title: `Dispatch issue ${number}`,
        body: [
            `Implement canonical dispatch issue ${number}.`,
            '',
            '- Preserve exact machine evidence.',
            '- Do not mint lifecycle authority.'
        ].join('\n'),
        comments: [],
        labels: ['orchestration'],
        milestone: null,
        dependsOn: []
    }
}

function selector(repository, numbers) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'dispatcher-selector-v1',
        type: 'explicit-issues',
        repositories: [repository],
        parameters: {
            issueIds: numbers.map((number) => `${repository}#${number}`),
            states: ['OPEN']
        },
        remoteQueryIdentity: 'dispatcher-test:explicit-issues'
    }
}

function classification(repository) {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: repository,
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('dispatcher-routing-evidence'),
        routingPolicyVersion: 'stage-model-pool.v4'
    }
}

function profileMetadata(profile) {
    if (profile.startsWith('sol-')) {
        return { model: 'gpt-5.6-sol', effort: profile.slice(4) }
    }
    return { model: 'gpt-5.6-terra', effort: profile.slice(6) }
}

function executionObservation({ fixture, stageRole, stagePhase, route, actorId }) {
    const metadata = profileMetadata(route.selectedProfile)
    const value = {
        schema: 'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId: `${actorId}:invocation`,
        actorSessionId: `${actorId}:session`,
        rootInvocationId: fixture.startup.attestation.runtimeInvocationId,
        requestedRole: stageRole,
        effectiveRole: stageRole,
        requestedPhase: stagePhase,
        effectivePhase: stagePhase,
        requestedProfile: route.selectedProfile,
        effectiveProfile: route.selectedProfile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        routeDecisionDigest: route.routeDecisionDigest,
        packageDigest: fixture.startup.observation.packageDigest,
        modelPoolPolicyDigest:
            fixture.startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            fixture.startup.observation.policyDigests.executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: CREATED_AT
    }
    value.observationDigest = digest(value)
    return value
}

function capabilityObservation({ route, actorId }) {
    const metadata = profileMetadata(route.selectedProfile)
    return seal({
        schema: 'issue-orchestration.runtime-capability-observation.v2',
        source: 'per-dispatch-runtime-identity-observer',
        observable: true,
        runtimeInvocationId: `${actorId}:invocation`,
        sessionOrThreadId: `${actorId}:session`,
        runtimeVersion: 'codex-cli-2026.08',
        requestedProfile: route.selectedProfile,
        effectiveProfile: route.selectedProfile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        multiAgentBackend: 'v2',
        rawEventDigest: digest(`${actorId}:event`),
        rawSessionDigest: digest(`${actorId}:session-raw`),
        rawTurnDigest: digest(`${actorId}:turn`),
        observedAt: CREATED_AT
    }, 'observationDigest')
}

function actorAdapter(fixture, nodeId) {
    let sequence = 0
    return {
        prepare({
            stageRole,
            stagePhase,
            routeDecision,
            actorContextEnvelope,
            actorPrompt,
            actorPromptStablePrefix,
            actorPromptVolatileSuffix,
            actorPromptCacheIdentity
        }) {
            if (actorContextEnvelope) {
                assert.equal(
                    actorContextEnvelope.schema,
                    'issue-orchestration.actor-context-envelope.v1'
                )
                assert.equal(actorContextEnvelope.role, stageRole)
                assert.equal(actorContextEnvelope.phase, stagePhase)
                assert.equal(actorContextEnvelope.identities.nodeId, nodeId)
                fixture.actorContextEnvelopes.push(
                    structuredClone(actorContextEnvelope)
                )
            }
            if (actorContextEnvelope) {
                assert.equal(typeof actorPrompt, 'string')
                assert.equal(
                    actorPromptStablePrefix.role,
                    stageRole
                )
                assert.equal(
                    actorPromptStablePrefix.phase,
                    stagePhase
                )
                assert.deepEqual(
                    actorPromptVolatileSuffix.actorContextEnvelope,
                    actorContextEnvelope
                )
                assert.equal(
                    actorPromptCacheIdentity.schema,
                    'issue-orchestration.actor-prompt-cache-identity.v1'
                )
                assert.equal(
                    actorPromptCacheIdentity.authority.kind,
                    'diagnostic-only'
                )
                fixture.actorPromptBundles.push({
                    prompt: actorPrompt,
                    stablePrefix: structuredClone(actorPromptStablePrefix),
                    volatileSuffix: structuredClone(actorPromptVolatileSuffix),
                    cacheIdentity: structuredClone(actorPromptCacheIdentity)
                })
            }
            sequence += 1
            const actorId = `${nodeId}:${stagePhase}:${sequence}`
            return {
                preparation: { actorId, stageRole, stagePhase },
                runtimeObservation: executionObservation({
                    fixture,
                    stageRole,
                    stagePhase,
                    route: routeDecision,
                    actorId
                }),
                runtimeCapabilityObservation: capabilityObservation({
                    route: routeDecision,
                    actorId
                }),
                promptCacheMetadata: {
                    provider: 'fixture-runtime',
                    supported: true,
                    hit: sequence > 1,
                    cachedInputTokens: sequence > 1 ? 64 : 0,
                    inputTokens: 128,
                    ignoredAuthority: 'not-recorded'
                }
            }
        },
        invoke({
            preparation,
            routeDecision,
            request,
            actorContextEnvelope,
            actorPrompt,
            actorPromptCacheIdentity
        }) {
            if (actorContextEnvelope) {
                assert.equal(actorContextEnvelope.envelopeDigest.length, 64)
                assert.equal(
                    actorContextEnvelope.role,
                    routeDecision.stageRole
                )
                assert.equal(
                    actorContextEnvelope.phase,
                    routeDecision.stagePhase
                )
                assert.equal(typeof actorPrompt, 'string')
                assert.equal(
                    actorPromptCacheIdentity.completePromptDigest.length,
                    64
                )
            }
            const result = spawnSync(process.execPath, [actorScript], {
                encoding: 'utf8',
                input: JSON.stringify({
                    actorId: preparation.actorId,
                    stagePhase: routeDecision.stagePhase,
                    routeDecision,
                    request
                })
            })
            if (result.status !== 0) {
                throw new Error(result.stderr || result.stdout)
            }
            return JSON.parse(result.stdout)
        }
    }
}

function fixture(numbers = [41, 42, 43]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-state-'))
    const repository = repositoryFixture(root)
    const startup = verifiedRuntimeStartup({
        invocationId: 'dispatcher-root-invocation',
        sessionId: 'dispatcher-root-session'
    })
    const runId = 'dispatcher-run'
    const authority = compileLifecycleRunGenesisAuthority({
        runId,
        startup,
        stateRoot,
        repositoryTargets: [{
            repository: repository.repository,
            repositoryPath: repository.work,
            defaultBranch: 'main'
        }],
        workspaces: [root],
        worktrees: [],
        slotCapacity: 2,
        createdAt: CREATED_AT
    })
    const binding = repositoryAuthorityFor(authority, repository.repository)
    const issues = numbers.map((number) => ({
        ...issue(repository.repository, number),
        baseSha: binding.observedDefaultBranchHead
    }))
    const selectorDefinition = selector(repository.repository, numbers)
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selectorDefinition,
        remoteIssues: issues,
        previousReceipt: null,
        resolvedAt: CREATED_AT
    })
    const policyDigest = digest('dispatcher-policy')
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest(numbers),
        semanticGraphInputDigest: digest(issues),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: binding.observedDefaultBranchHead,
            bindingDigest: binding.bindingDigest
        }],
        nodes: issues.map((remoteIssue) => {
            const id = `${repository.repository}#${remoteIssue.number}`
            return {
                id,
                memberId: id,
                repository: repository.repository,
                issueNumber: remoteIssue.number,
                owner: 'dag-creator-updater',
                dependencyKeys: [],
                conflictKeys: [],
                riskClass: 'bounded',
                uiClass: 'non-ui',
                acceptanceGroup: null,
                lifecycleState: 'none',
                selectorReceiptDigest: selectorReceipt.receiptDigest,
                remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
                repositoryBindingDigest: binding.bindingDigest,
                semanticFactsDigest: digest(remoteIssue),
                receipts: {}
            }
        })
    })
    const ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition,
        semanticGraph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        lifecycleAuthority: authority,
        startup,
        slotCapacity: 2
    })
    return {
        root,
        stateRoot,
        repository,
        startup,
        authority,
        selectorReceipt,
        issues,
        ledger,
        runId,
        actorContextEnvelopes: [],
        actorPromptBundles: []
    }
}

function semanticContextProvider(value) {
    const issueById = new Map(value.issues.map((remoteIssue) => [
        `${remoteIssue.repository}#${remoteIssue.number}`,
        remoteIssue
    ]))
    function contextFor(action, projection) {
        const nodeId = action.nodeId
        return {
            repositoryPath: value.repository.work,
            stateRootPath: value.stateRoot,
            skillDigest: digest('dispatcher-skill'),
            baselineDigest: digest('dispatcher-baseline'),
            routingClassification:
                classification(value.repository.repository),
            runtimeTrustBinding: value.authority.runtimeTrustBinding,
            repositoryTargets: value.authority.repositoryTargets,
            lifecycleAuthority: value.authority,
            node: projection.state.nodes[nodeId],
            inputs: {
                issue: issueById.get(nodeId),
                selectorReceipt: value.selectorReceipt
            },
            actorAdapter: actorAdapter(value, nodeId)
        }
    }
    function executeRecoveredDispatch(request) {
        const dispatch = request.dispatch
        return executePreWriterLifecycleAction({
            ...contextFor(dispatch.action, request.projection),
            ledger: request.ledger,
            actionSet: dispatch.actionSet,
            action: dispatch.action,
            startup: value.startup,
            createdAt: request.observedAt
        })
    }
    return {
        observeRemoteIssues(request) {
            const observation = {
                schema:
                    'issue-orchestration.lifecycle-remote-scope-observation.v1',
                producerAuthority: 'trusted-remote-observation-adapter',
                rootAuthored: false,
                selectorDigest: request.selectorDigest,
                remoteQueryIdentity: request.remoteQueryIdentity,
                repositories: [...request.repositories],
                issues: structuredClone(value.issues),
                observedAt: CREATED_AT
            }
            observation.observationDigest = digest(observation)
            return observation
        },
        async prepare(request) {
            assert.equal(request.owner, 'pre-writer')
            assert.equal(request.executionClass, 'actor')
            const nodeId = request.action.nodeId
            return {
                context: contextFor(request.action, request.projection),
                dispatch: {
                    attemptId:
                        `request-semantic-proposal:${request.action.bindings.nodeEpoch}`,
                    slotId: `slot:${nodeId}`,
                    runtimeBindingDigest: digest(`runtime:${nodeId}`),
                    leaseDigest: digest(`lease:${nodeId}`),
                    resourceDigest: digest(`resource:${nodeId}`)
                }
            }
        },
        executeRecoveredDispatch,
        async recoverActiveDispatch(request) {
            return {
                completion: Promise.resolve().then(() =>
                    executeRecoveredDispatch(request))
            }
        }
    }
}

function clock() {
    let sequence = 0
    return () => {
        sequence += 1
        return `2026-08-05T09:00:${String(sequence).padStart(2, '0')}.000Z`
    }
}

function performanceClock(start = '2026-08-05T10:00:00.000Z') {
    let value = Date.parse(start)
    return () => {
        value += 5
        return new Date(value).toISOString()
    }
}

function stateTree(root) {
    const entries = []
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, {
            withFileTypes: true
        }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                visit(absolute)
                continue
            }
            entries.push({
                path: path.relative(root, absolute),
                source: fs.readFileSync(absolute, 'utf8')
            })
        }
    }
    visit(root)
    return entries
}

test('production dispatcher map is exhaustive, immutable, and has no fallback', () => {
    assert.deepEqual(
        Object.keys(LIFECYCLE_PRODUCTION_DISPATCH_MAP).sort(),
        [...LIFECYCLE_ACTION_TYPES].sort()
    )
    assert.equal(Object.isFrozen(LIFECYCLE_PRODUCTION_DISPATCH_MAP), true)
    for (const entry of Object.values(LIFECYCLE_PRODUCTION_DISPATCH_MAP)) {
        assert.equal(Object.isFrozen(entry), true)
        assert.match(entry.owner, /^[a-z][a-z-]+$/u)
        assert.match(entry.executionClass, /^(actor|machine|root)$/u)
    }
    const source = fs.readFileSync(new URL(
        '../../skills/issue-orchestration/scripts/lifecycle-production-dispatcher.mjs',
        import.meta.url
    ), 'utf8')
    assert.doesNotMatch(source, /default\s*:/u)
    assert.doesNotMatch(source, /handlerSearch|legacyDispatcher|testOnlyExecutor/u)
    const skill = fs.readFileSync(new URL(
        '../../skills/issue-orchestration/SKILL.md',
        import.meta.url
    ), 'utf8')
    assert.match(skill, /runLifecycleProductionDispatcher/u)
    assert.doesNotMatch(skill, /Root 逐项机械执行/u)
    assert.doesNotMatch(skill, /Root 主循环固定为：执行 action set/u)
})

test('action-set cache key uses only the seven verified compiler digests', () => {
    const source = fs.readFileSync(new URL(
        '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs',
        import.meta.url
    ), 'utf8')
    const start = source.indexOf('function actionSetCacheIdentity')
    const end = source.indexOf('function actionSetCacheStatsRecord', start)
    assert.ok(start >= 0 && end > start)
    const keySource = source.slice(start, end)
    for (const field of [
        'selectorReceiptDigest',
        'remoteSnapshotReceiptDigest',
        'semanticGraphDigest',
        'aggregateProjectionDigest',
        'policyDigest',
        'runtimeCapabilityBindingDigest',
        'lifecycleAuthorityBindingDigest'
    ]) assert.match(keySource, new RegExp(field, 'u'))
    assert.doesNotMatch(
        keySource,
        /Date|timestamp|mtime|objectIdentity|actionCount|nodeSummary/u
    )
})

test('verified action-set cache compiles once and returns isolated byte-identical values', (t) => {
    const value = fixture()
    t.after(() => {
        clearLifecycleActionSetCache({
            stateRoot: value.stateRoot,
            runId: value.runId
        })
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const first = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    const second = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    assert.deepEqual(second, first)
    assert.deepEqual(lifecycleActionSetCacheObservation(first), {
        schema:
            'issue-orchestration.lifecycle-action-set-cache-observation.v1',
        status: 'compiled',
        keyDigest: lifecycleActionSetCacheObservation(first).keyDigest
    })
    assert.equal(
        lifecycleActionSetCacheObservation(second).status,
        'cache-hit'
    )
    assert.deepEqual(lifecycleActionSetCacheStats({
        stateRoot: value.stateRoot,
        runId: value.runId
    }), {
        compilerInvocations: 1,
        cacheHits: 1,
        cacheMisses: 1,
        forcedRecompilations: 0
    })
    assert.doesNotMatch(JSON.stringify(second), /cache/u)
    second.actions[0].type = 'idle'
    const third = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    assert.deepEqual(third, first)
})

test('performance telemetry counts only real action-set compiler invocations', (t) => {
    const value = fixture()
    t.after(() => {
        clearLifecycleActionSetCache({
            stateRoot: value.stateRoot,
            runId: value.runId
        })
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const collector = createDispatcherPerformanceCollector({
        runId: value.runId,
        stateRoot: value.stateRoot,
        clock: performanceClock()
    })
    const measuredCompile = () => {
        const before = lifecycleActionSetCacheStats({
            stateRoot: value.stateRoot,
            runId: value.runId
        })
        return collector.measureSync(
            ['actionSetCompilation'],
            { boundary: 'action-set-cache-proof' },
            () => compileLifecycleRunActionSet(value.ledger, {
                startup: value.startup
            }),
            {
                resolveMetrics() {
                    const after = lifecycleActionSetCacheStats({
                        stateRoot: value.stateRoot,
                        runId: value.runId
                    })
                    return after.compilerInvocations >
                        before.compilerInvocations
                        ? ['actionSetCompilation']
                        : []
                }
            }
        )
    }
    assert.deepEqual(measuredCompile(), measuredCompile())
    const receipt = collector.finalize({
        status: 'completed',
        transitions: 0
    })
    assert.deepEqual(receipt.operationSummary.actionSetCompilation, {
        count: 1,
        durationMs: 5
    })
})

test('forced recompilation is byte-identical and canonical append changes the cache key', (t) => {
    const value = fixture()
    t.after(() => {
        clearLifecycleActionSetCache({
            stateRoot: value.stateRoot,
            runId: value.runId
        })
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const first = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    const forced = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup,
        forceRecompile: true
    })
    assert.deepEqual(forced, first)
    assert.equal(
        lifecycleActionSetCacheObservation(forced).status,
        'forced-recompile'
    )
    const actorActions = first.actions.filter(({ type }) =>
        type === 'request-semantic-proposal')
    recordLifecycleDispatchBatchStarted({
        ledger: value.ledger,
        actionSet: first,
        dispatches: actorActions.map((action, index) => ({
            actionDigest: action.actionDigest,
            nodeId: action.nodeId,
            owner: 'dag-creator-updater',
            attemptId: `attempt-${index + 1}`,
            slotId: `slot-${index + 1}`,
            runtimeBindingDigest: digest(['runtime', index]),
            leaseDigest: digest(['lease', index]),
            resourceDigest: digest(['resource', index])
        })),
        createdAt: CREATED_AT,
        startup: value.startup
    })
    const afterAppend = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    assert.notEqual(
        lifecycleActionSetCacheObservation(afterAppend).keyDigest,
        lifecycleActionSetCacheObservation(first).keyDigest
    )
    assert.deepEqual(lifecycleActionSetCacheStats({
        stateRoot: value.stateRoot,
        runId: value.runId
    }), {
        compilerInvocations: 3,
        cacheHits: 1,
        cacheMisses: 3,
        forcedRecompilations: 1
    })
})

test('caller-edited action set cannot reuse a copied cache identity', (t) => {
    const value = fixture()
    t.after(() => {
        clearLifecycleActionSetCache({
            stateRoot: value.stateRoot,
            runId: value.runId
        })
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const actionSet = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    const edited = structuredClone(actionSet)
    edited.actions.reverse()
    edited.copiedCacheKeyDigest =
        lifecycleActionSetCacheObservation(actionSet).keyDigest
    assert.throws(
        () => recordLifecycleDispatchBatchStarted({
            ledger: value.ledger,
            actionSet: edited,
            dispatches: [],
            createdAt: CREATED_AT,
            startup: value.startup
        }),
        (error) => error?.code === 'lifecycle-action-set-stale'
    )
})

test('two actors start together and the free slot refills before the other settles', async (t) => {
    const value = fixture()
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const contextProvider = semanticContextProvider(value)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 3
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const events = projection.aggregateProjection.dispatchHistory
        .map(({ nodeId }) => `settle:${nodeId}`)
    const active = Object.values(
        projection.aggregateProjection.activeDispatches
    ).map(({ nodeId }) => `start:${nodeId}`).sort()
    const control = projection.aggregateProjection
    assert.equal(control.dispatchHistory.length, 2)
    assert.equal(Object.keys(control.activeDispatches).length, 1)
    assert.equal(control.slots.active.length, 1)
    assert.equal(events.length, 2)
    assert.equal(active.length, 1)

    const rawEvents = fs.readFileSync(
        path.join(
            value.stateRoot,
            'runs',
            ledger.runKey,
            'control-ledger.jsonl'
        ),
        'utf8'
    ).trim().split('\n').slice(1).map((line) => JSON.parse(line))
    const order = rawEvents
        .filter(({ eventType }) => [
            'dispatch.action-started',
            'dispatch.action-settled'
        ].includes(eventType))
        .map(({ eventType, payload }) =>
            `${eventType === 'dispatch.action-started' ? 'start' : 'settle'}:${payload.nodeId ?? control.dispatchHistory.find(({ dispatchId }) => dispatchId === payload.dispatchId)?.nodeId}`)
    assert.equal(order.length, 5)
    assert.match(order[0], /^start:/u)
    assert.match(order[1], /^start:/u)
    assert.match(order[2], /^settle:/u)
    assert.match(order[3], /^start:/u)
    assert.match(order[4], /^settle:/u)
    assert.notEqual(order[3].slice(6), order[4].slice(7))
    assert.ok(value.actorContextEnvelopes.length >= 2)
    assert.ok(value.actorContextEnvelopes.every((envelope) =>
        envelope.schema ===
            'issue-orchestration.actor-context-envelope.v1' &&
        envelope.authority.kind === 'actor-input-only' &&
        envelope.authority.grants.length === 0))
    assert.ok(value.actorPromptBundles.length >= 2)
    const semanticPrefixes = value.actorPromptBundles
        .filter(({ stablePrefix }) =>
            stablePrefix.phase === 'semantic-proposal')
        .map(({ cacheIdentity }) => cacheIdentity.stablePrefixDigest)
    assert.ok(semanticPrefixes.length >= 2)
    assert.equal(new Set(semanticPrefixes).size, 1)
})


test('active dispatches require machine recovery and stale attempts cannot settle', async (t) => {
    const value = fixture()
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const contextProvider = semanticContextProvider(value)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    let ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    let projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const active = Object.values(
        projection.aggregateProjection.activeDispatches
    )
    assert.equal(active.length, 2)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider: {
                prepare: contextProvider.prepare,
                observeRemoteIssues: contextProvider.observeRemoteIssues
            },
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-active-recovery-required'
    )
    assert.throws(
        () => recordLifecycleDispatchedActionResult({
            ledger,
            dispatchId: active[0].dispatchId,
            result: {
                actionDigest: active[0].actionDigest,
                attemptId: 'superseded-attempt',
                resultDigest: digest('superseded-result')
            },
            createdAt: CREATED_AT,
            startup: value.startup
        }),
        (error) => error?.code ===
            'lifecycle-dispatch-result-identity-mismatch'
    )
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    assert.equal(
        projection.aggregateProjection.dispatchHistory.length,
        1
    )
    assert.equal(
        Object.keys(projection.aggregateProjection.activeDispatches).length,
        1
    )
})

test('fresh remote scope drift is recorded before any actor preparation', async (t) => {
    const value = fixture()
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    let preparations = 0
    const changed = structuredClone(value.issues)
    changed[0].body += '\n- Newly observed requirement.'
    changed[0].updatedAt = '2026-08-05T09:10:00.000Z'
    const contextProvider = semanticContextProvider(value)
    contextProvider.prepare = async () => {
        preparations += 1
        throw new Error('actor preparation must not run before refresh')
    }
    contextProvider.observeRemoteIssues = (request) => {
        const observation = {
            schema:
                'issue-orchestration.lifecycle-remote-scope-observation.v1',
            producerAuthority: 'trusted-remote-observation-adapter',
            rootAuthored: false,
            selectorDigest: request.selectorDigest,
            remoteQueryIdentity: request.remoteQueryIdentity,
            repositories: [...request.repositories],
            issues: changed,
            observedAt: '2026-08-05T09:10:00.000Z'
        }
        observation.observationDigest = digest(observation)
        return observation
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    assert.equal(preparations, 0)
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const changedNode = projection.state.nodes[
        `${value.repository.repository}#41`
    ]
    assert.equal(changedNode.chainVersion, 2)
    assert.equal(
        Object.keys(projection.aggregateProjection.activeDispatches).length,
        0
    )
})

test('a default-branch change while an actor runs rejects the stale result', async (t) => {
    const value = fixture()
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const contextProvider = semanticContextProvider(value)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    fs.writeFileSync(
        path.join(value.repository.work, 'base-drift.txt'),
        'changed while actor was running\n'
    )
    git(['add', 'base-drift.txt'], value.repository.work)
    git(['commit', '-m', 'advance base while actor runs'],
        value.repository.work)
    git(['push', 'origin', 'main'], value.repository.work)
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-active-result-base-stale'
    )
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    assert.equal(projection.aggregateProjection.dispatchHistory.length, 0)
    assert.equal(
        Object.keys(projection.aggregateProjection.activeDispatches).length,
        2
    )
})


test('independent actors settling in reverse wall-clock order preserve the same next action set', async () => {
    async function runOrder(completionOrder) {
        const value = fixture([41, 42])
        try {
            const baseProvider = semanticContextProvider(value)
            await assert.rejects(
                runLifecycleProductionDispatcher({
                    ledger: value.ledger,
                    startup: value.startup,
                    contextProvider: baseProvider,
                    clock: clock(),
                    maxTransitions: 1
                }),
                (error) => error?.code ===
                    'dispatcher-transition-limit-exceeded'
            )
            let ledger = readLifecycleRunLedger({
                stateRoot: value.stateRoot,
                runId: value.runId,
                startup: value.startup
            })
            const delayedProvider = {
                prepare: baseProvider.prepare,
                observeRemoteIssues: baseProvider.observeRemoteIssues,
                async recoverActiveDispatch(request) {
                    const rank = completionOrder.indexOf(
                        request.dispatch.nodeId
                    )
                    assert.notEqual(rank, -1)
                    return {
                        completion: new Promise((resolve, reject) => {
                            setTimeout(() => {
                                try {
                                    resolve(baseProvider
                                        .executeRecoveredDispatch(request))
                                } catch (error) {
                                    reject(error)
                                }
                            }, rank * 50)
                        })
                    }
                }
            }
            await assert.rejects(
                runLifecycleProductionDispatcher({
                    ledger,
                    startup: value.startup,
                    contextProvider: delayedProvider,
                    clock: clock(),
                    maxTransitions: 2
                }),
                (error) => error?.code ===
                    'dispatcher-transition-limit-exceeded'
            )
            ledger = readLifecycleRunLedger({
                stateRoot: value.stateRoot,
                runId: value.runId,
                startup: value.startup
            })
            const projection = projectLifecycleRun(ledger, {
                startup: value.startup
            })
            const actionSet = compileLifecycleRunActionSet(ledger, {
                startup: value.startup
            })
            return {
                nodes: Object.fromEntries(
                    Object.entries(projection.state.nodes)
                        .sort(([left], [right]) =>
                            left.localeCompare(right))
                        .map(([nodeId, node]) => [nodeId, {
                            status: node.status,
                            chainVersion: node.chainVersion,
                            receiptKinds: Object.keys(node.receipts).sort()
                        }])
                ),
                nextActions: actionSet.actions.map((action) => ({
                    type: action.type,
                    nodeId: action.nodeId ?? null
                })).sort((left, right) =>
                    `${left.type}:${left.nodeId}`.localeCompare(
                        `${right.type}:${right.nodeId}`
                    )),
                settlementOrder:
                    projection.aggregateProjection.dispatchHistory
                        .map(({ nodeId }) => nodeId),
                activeDispatchCount: Object.keys(
                    projection.aggregateProjection.activeDispatches
                ).length
            }
        } finally {
            fs.rmSync(value.root, { recursive: true, force: true })
            fs.rmSync(value.stateRoot, { recursive: true, force: true })
        }
    }

    const first = 'Fixture/Dispatcher#41'
    const second = 'Fixture/Dispatcher#42'
    const forward = await runOrder([first, second])
    const reverse = await runOrder([second, first])

    assert.deepEqual(forward.nodes, reverse.nodes)
    assert.deepEqual(forward.nextActions, reverse.nextActions)
    assert.equal(forward.activeDispatchCount, 0)
    assert.equal(reverse.activeDispatchCount, 0)
    assert.deepEqual(forward.settlementOrder, [first, second])
    assert.deepEqual(reverse.settlementOrder, [second, first])
})

test('performance telemetry is deterministic after timestamp normalization', () => {
    function receipt(start) {
        const collector = createDispatcherPerformanceCollector({
            runId: 'performance-run',
            stateRoot: path.join(os.tmpdir(), 'performance-state'),
            clock: performanceClock(start)
        })
        collector.setTransition(2)
        collector.measureSync(
            ['remoteScopeObservation'],
            { boundary: 'scope' },
            () => 'unchanged'
        )
        collector.recordSlotSnapshot({
            reason: 'fixture',
            capacity: 2,
            active: 1,
            available: 1
        })
        return collector.finalize({
            status: 'failed',
            transitions: 2,
            failureCode: 'fixture-stop'
        })
    }
    const first = receipt('2026-08-05T10:00:00.000Z')
    const second = receipt('2026-08-06T12:30:00.000Z')
    assert.deepEqual(
        normalizeDispatcherPerformanceReceipt(first),
        normalizeDispatcherPerformanceReceipt(second)
    )
    assert.equal(verifyDispatcherPerformanceReceipt(first).receiptDigest,
        first.receiptDigest)
    const forged = structuredClone(first)
    forged.authority.grants.push('route-selection')
    forged.receiptDigest = digest((() => {
        const value = structuredClone(forged)
        delete value.receiptDigest
        return value
    })())
    assert.throws(
        () => verifyDispatcherPerformanceReceipt(forged),
        (error) => error?.code === 'dispatcher-performance-receipt-invalid'
    )
})

test('enabling performance telemetry leaves canonical state byte-identical', async (t) => {
    const value = fixture()
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-snapshot-'))
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
        fs.rmSync(snapshot, { recursive: true, force: true })
    })
    fs.cpSync(value.stateRoot, snapshot, {
        recursive: true,
        preserveTimestamps: true
    })
    function providerWithScopeChange() {
        const base = semanticContextProvider(value)
        return {
            ...base,
            observeRemoteIssues(request) {
                const observation = {
                    schema:
                        'issue-orchestration.lifecycle-remote-scope-observation.v1',
                    producerAuthority:
                        'trusted-remote-observation-adapter',
                    rootAuthored: false,
                    selectorDigest: request.selectorDigest,
                    remoteQueryIdentity: request.remoteQueryIdentity,
                    repositories: [...request.repositories],
                    issues: structuredClone(value.issues.slice(0, 2)),
                    observedAt: CREATED_AT
                }
                observation.observationDigest = digest(observation)
                return observation
            }
        }
    }

    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider: providerWithScopeChange(),
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    const withoutTelemetryTree = stateTree(value.stateRoot)

    fs.rmSync(value.stateRoot, { recursive: true, force: true })
    fs.mkdirSync(value.stateRoot, { recursive: true })
    fs.cpSync(snapshot, value.stateRoot, {
        recursive: true,
        preserveTimestamps: true
    })
    let receipt = null
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider: providerWithScopeChange(),
            clock: clock(),
            maxTransitions: 1,
            performanceTelemetry: {
                clock: performanceClock(),
                onReceipt(value) {
                    receipt = value
                }
            }
        }),
        (error) => {
            assert.equal(
                error?.code,
                'dispatcher-transition-limit-exceeded'
            )
            assert.equal(
                error.performanceReceipt?.receiptDigest,
                receipt?.receiptDigest
            )
            return true
        }
    )
    assert.deepEqual(stateTree(value.stateRoot), withoutTelemetryTree)
    assert.equal(receipt.status, 'failed')
    assert.equal(receipt.failureCode, 'dispatcher-transition-limit-exceeded')
    assert.equal(receipt.transitions, 1)
    assert.deepEqual(receipt.operationSummary, {
        canonicalReplay: { count: 2, durationMs: 10 },
        aggregateProjectionRebuild: { count: 2, durationMs: 10 },
        actionSetCompilation: { count: 0, durationMs: 0 },
        remoteScopeObservation: { count: 1, durationMs: 5 },
        repositoryBaseObservation: { count: 0, durationMs: 0 },
        contextPreparation: { count: 0, durationMs: 0 },
        machineActionExecution: { count: 0, durationMs: 0 },
        actorResultAdmission: { count: 0, durationMs: 0 }
    })
    assert.ok(receipt.bytes.canonicalLedgersRead > 0)
    assert.equal(receipt.bytes.actorContextPrepared, 0)
    assert.ok(receipt.wallTime.rootControlPlaneObservedDurationMs > 0)
    assert.equal(receipt.wallTime.actorObservedWallDurationMs, 0)
})

test('two-slot telemetry exposes dispatch, admission, and refill timing', async (t) => {
    const value = fixture()
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    let receipt = null
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider: semanticContextProvider(value),
            clock: clock(),
            maxTransitions: 3,
            performanceTelemetry: {
                clock: performanceClock(),
                onReceipt(value) {
                    receipt = value
                }
            }
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    assert.ok(receipt)
    assert.deepEqual(receipt.operationSummary, {
        canonicalReplay: { count: 5, durationMs: 25 },
        aggregateProjectionRebuild: { count: 5, durationMs: 25 },
        actionSetCompilation: { count: 3, durationMs: 15 },
        remoteScopeObservation: { count: 3, durationMs: 15 },
        repositoryBaseObservation: { count: 4, durationMs: 20 },
        contextPreparation: { count: 3, durationMs: 15 },
        machineActionExecution: { count: 0, durationMs: 0 },
        actorResultAdmission: { count: 2, durationMs: 10 }
    })
    assert.equal(receipt.actorDispatches.length, 3)
    assert.equal(receipt.promptCacheObservations.length, 3)
    assert.ok(receipt.promptCacheObservations.every((observation) =>
        observation.providerMetadata.provider === 'fixture-runtime' &&
        observation.providerMetadata.ignoredAuthority === undefined &&
        observation.cacheIdentityDigest.length === 64))
    assert.equal(
        receipt.actorDispatches.filter(({ admittedAt }) => admittedAt)
            .length,
        2
    )
    assert.equal(receipt.slotRefills.length, 1)
    assert.equal(receipt.slotRefills[0].durationMs, 125)
    assert.equal(receipt.idleSafeSlotDurationMs, 125)
    assert.equal(receipt.slotSamples.length, 9)
    assert.ok(receipt.slotSamples.some(({ capacity, active, available }) =>
        capacity === 2 && active === 2 && available === 0))
    assert.ok(receipt.slotSamples.some(({ capacity, active, available }) =>
        capacity === 2 && active === 1 && available === 1))
    assert.deepEqual(receipt.repositoryBaseObservations, [{
        repository: value.repository.repository,
        count: 4,
        durationMs: 20
    }])
    const sharedPreWave = receipt.spans.find((span) =>
        span.boundary === 'repository-base-pre-wave' &&
        span.actionDigests?.length === 2)
    assert.ok(sharedPreWave)
    assert.deepEqual(sharedPreWave.repositories, [
        value.repository.repository
    ])
    assert.ok(receipt.spans.some((span) =>
        span.boundary === 'repository-base-post-wave' &&
        span.dispatchIds?.length === 1))
    assert.equal(
        receipt.bytes.canonicalLedgersRead,
        receipt.spans.reduce(
            (total, span) => total + span.canonicalLedgerBytesRead,
            0
        )
    )
    assert.equal(
        receipt.bytes.actorContextPrepared,
        receipt.spans.reduce(
            (total, span) => total + span.actorContextBytesPrepared,
            0
        )
    )
    assert.ok(receipt.bytes.canonicalLedgersRead > 0)
    assert.ok(receipt.bytes.actorContextPrepared > 0)
    assert.ok(receipt.wallTime.actorObservedWallDurationMs > 0)
    assert.ok(receipt.wallTime.rootControlPlaneObservedDurationMs > 0)
    assert.equal(
        receipt.wallTime.actorObservedWallDurationMs,
        receipt.actorDispatches.reduce(
            (total, dispatch) =>
                total + (dispatch.actorWallDurationMs ?? 0),
            0
        )
    )
    assert.equal(
        receipt.wallTime.rootControlPlaneObservedDurationMs,
        receipt.spans.reduce(
            (total, span) => total + span.durationMs,
            0
        )
    )
})

test('dispatcher performance metrics are absent from authority inputs', () => {
    const forbidden = [
        'execution-route-compiler.mjs',
        'stage-profile-policy.mjs',
        'lifecycle-transition-compiler.mjs',
        'lifecycle-stage-admission.mjs',
        'lifecycle-terminalization-executor.mjs',
        'remote-mutation-authority.mjs'
    ]
    const scripts = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../skills/issue-orchestration/scripts'
    )
    for (const file of forbidden) {
        const source = fs.readFileSync(path.join(scripts, file), 'utf8')
        assert.doesNotMatch(
            source,
            /dispatcher-performance|performanceTelemetry|performanceReceipt|promptCacheMetadata|cacheIdentityDigest|stablePrefixDigest/u,
            file
        )
    }
    const dispatcher = fs.readFileSync(
        path.join(scripts, 'lifecycle-production-dispatcher.mjs'),
        'utf8'
    )
    assert.doesNotMatch(
        dispatcher,
        /(?:routeDecision|retry|terminal|mutation)[^\n]{0,120}(?:performanceTelemetry|performanceReceipt|promptCacheMetadata|cacheIdentityDigest)/u
    )
})
