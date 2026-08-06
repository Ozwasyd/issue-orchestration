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
    recordLifecycleCurrentActionResult,
    recordLifecycleCurrentMachineActionResultBatch,
    recordLifecycleDispatchedActionResult,
    recordLifecycleDispatchedActionResultBatch
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
    clearVerifiedReplayProjectionCache
} from '../../skills/issue-orchestration/scripts/multi-node-state.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    compileScriptedLifecycleStageResult
} from './issue-orchestration/scripted-lifecycle-stage-result.mjs'
import {
    compileLifecycleActorStageFailure,
    lifecycleActorStageFailureError,
    validateLifecycleActorStageFailure
} from '../../skills/issue-orchestration/scripts/lifecycle-executor-failure-admission.mjs'

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

function fixture(numbers = [41, 42, 43], { slotCapacity = 2 } = {}) {
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
        slotCapacity,
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
        slotCapacity
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
            const nodeId = request.action.nodeId
            if (request.executionClass === 'machine') {
                assert.equal(
                    request.action.type,
                    'compile-acceptance-contract'
                )
                return {
                    context: contextFor(
                        request.action,
                        request.projection
                    )
                }
            }
            assert.equal(request.executionClass, 'actor')
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

async function recoveredResult(value, contextProvider, ledger, dispatch) {
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    return contextProvider.executeRecoveredDispatch({
        dispatch,
        projection,
        ledger,
        observedAt: CREATED_AT
    })
}

function activeDispatches(value, ledger) {
    return Object.values(projectLifecycleRun(ledger, {
        startup: value.startup
    }).aggregateProjection.activeDispatches).sort((left, right) =>
        left.dispatchId.localeCompare(right.dispatchId))
}

function clearDerivedCaches(value) {
    clearLifecycleActionSetCache({
        stateRoot: value.stateRoot,
        runId: value.runId
    })
    clearVerifiedReplayProjectionCache({
        stateRoot: value.stateRoot,
        runId: value.runId
    })
}

function actorRoleForAction(action, node) {
    switch (action.type) {
        case 'request-semantic-proposal':
            return 'dag-creator-updater'
        case 'compile-acceptance-contract':
            return 'acceptance-contract-compiler'
        case 'request-test-contract-planning':
        case 'dispatch-test-contract-writer':
        case 'dispatch-behavior-verifier':
            return 'test-owner'
        case 'dispatch-implementation-writer':
            return node.uiClass === 'ui-ux'
                ? 'ui-ux-implementer'
                : 'code-implementer'
        default:
            throw new Error(`unsupported scripted progression: ${action.type}`)
    }
}

function recordScriptedAction(value, ledger, action, {
    mode = 'completed',
    facts = {}
} = {}) {
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const actionSet = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    if (action.type === 'compile-acceptance-contract') {
        const node = projection.state.nodes[action.nodeId]
        const result = compileScriptedLifecycleStageResult({
            action,
            node,
            actorRole: actorRoleForAction(action, node),
            mode,
            facts
        })
        return recordLifecycleCurrentActionResult({
            ledger,
            actionSet,
            actionDigest: action.actionDigest,
            result,
            createdAt: CREATED_AT,
            startup: value.startup
        }).ledger
    }
    const actorActions = actionSet.actions.filter((candidate) =>
        LIFECYCLE_PRODUCTION_DISPATCH_MAP[candidate.type]
            ?.executionClass === 'actor')
    const results = actorActions.map((candidate) => {
        const node = projection.state.nodes[candidate.nodeId]
        return compileScriptedLifecycleStageResult({
            action: candidate,
            node,
            actorRole: actorRoleForAction(candidate, node),
            mode: candidate.actionDigest === action.actionDigest
                ? mode
                : 'completed',
            facts: candidate.actionDigest === action.actionDigest
                ? facts
                : {}
        })
    })
    const started = recordLifecycleDispatchBatchStarted({
        ledger,
        actionSet,
        dispatches: actorActions.map((candidate, index) => ({
            actionDigest: candidate.actionDigest,
            nodeId: candidate.nodeId,
            owner: LIFECYCLE_PRODUCTION_DISPATCH_MAP[
                candidate.type
            ].owner,
            attemptId: results[index].attemptId,
            slotId: `slot:${candidate.nodeId}`,
            runtimeBindingDigest:
                digest(`runtime:${results[index].attemptId}`),
            leaseDigest: digest(`lease:${results[index].attemptId}`),
            resourceDigest:
                digest(`resource:${results[index].attemptId}`)
        })),
        createdAt: CREATED_AT,
        startup: value.startup
    })
    const dispatchByAction = new Map(started.dispatches.map(
        (dispatch) => [dispatch.actionDigest, dispatch]
    ))
    return recordLifecycleDispatchedActionResultBatch({
        ledger: started.ledger,
        entries: results.map((result) => ({
            dispatchId: dispatchByAction.get(
                result.actionDigest
            ).dispatchId,
            result
        })),
        createdAt: CREATED_AT,
        startup: value.startup
    }).ledger
}

function advanceNodeToState(value, initialLedger, nodeId, targetState) {
    let ledger = initialLedger
    for (let step = 0; step < 12; step += 1) {
        const projection = projectLifecycleRun(ledger, {
            startup: value.startup
        })
        if (projection.state.nodes[nodeId].lifecycleState === targetState) {
            return ledger
        }
        const actionSet = compileLifecycleRunActionSet(ledger, {
            startup: value.startup
        })
        const action = actionSet.actions.find((candidate) =>
            candidate.nodeId === nodeId)
        if (!action) {
            throw new Error(`no action for ${nodeId} before ${targetState}`)
        }
        ledger = recordScriptedAction(value, ledger, action)
    }
    throw new Error(`failed to reach ${targetState} for ${nodeId}`)
}

function advanceNodesToState(
    value,
    initialLedger,
    nodeIds,
    targetState
) {
    let ledger = initialLedger
    for (let step = 0; step < 20; step += 1) {
        const projection = projectLifecycleRun(ledger, {
            startup: value.startup
        })
        if (nodeIds.every((nodeId) =>
            projection.state.nodes[nodeId].lifecycleState ===
                targetState)) {
            return ledger
        }
        const actionSet = compileLifecycleRunActionSet(ledger, {
            startup: value.startup
        })
        const machine = actionSet.actions.find((action) =>
            action.type === 'compile-acceptance-contract' &&
            nodeIds.includes(action.nodeId))
        const action = machine ?? actionSet.actions.find((candidate) =>
            nodeIds.includes(candidate.nodeId))
        if (!action) {
            throw new Error(
                `no synchronized action before ${targetState}`
            )
        }
        ledger = recordScriptedAction(value, ledger, action)
    }
    throw new Error(`failed to synchronize ${targetState}`)
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

async function advanceToMachineActions(value) {
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider: semanticContextProvider(value),
            clock: clock(),
            maxTransitions: 2
        }),
        (error) => error?.code ===
            'dispatcher-transition-limit-exceeded'
    )
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const actionSet = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    assert.ok(actionSet.actions.length > 0)
    assert.equal(actionSet.actions.every(({ type }) =>
        type === 'compile-acceptance-contract'), true)
    return { ledger, actionSet }
}

function scriptedMachineResults(value, ledger, actionSet) {
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    return actionSet.actions.map((action) =>
        compileScriptedLifecycleStageResult({
            action,
            node: projection.state.nodes[action.nodeId],
            actorRole: 'acceptance-contract-compiler'
        }))
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

test('ready queue is process-local and production uses canonical batch admission', () => {
    const dispatcher = fs.readFileSync(new URL(
        '../../skills/issue-orchestration/scripts/lifecycle-production-dispatcher.mjs',
        import.meta.url
    ), 'utf8')
    const state = fs.readFileSync(new URL(
        '../../skills/issue-orchestration/scripts/multi-node-state.mjs',
        import.meta.url
    ), 'utf8')
    assert.doesNotMatch(dispatcher, /Promise\.race/u)
    assert.match(dispatcher, /createSettlementQueue/u)
    assert.match(dispatcher, /waitAndDrain/u)
    assert.match(dispatcher, /recordLifecycleDispatchedActionResultBatch/u)
    assert.match(dispatcher, /executeMachineBatch/u)
    assert.match(dispatcher, /BATCHABLE_MACHINE_ACTION_TYPES/u)
    const runLoop = fs.readFileSync(new URL(
        '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs',
        import.meta.url
    ), 'utf8')
    assert.match(
        runLoop,
        /recordLifecycleCurrentMachineActionResultBatch/u
    )
    assert.doesNotMatch(state, /settlementQueue|readyResultQueue/u)
})


test('four independent machine actions execute in one canonical batch', async (t) => {
    const value = fixture([101, 102, 103, 104], { slotCapacity: 4 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const ready = await advanceToMachineActions(value)
    let receipt = null
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: ready.ledger,
            startup: value.startup,
            contextProvider: semanticContextProvider(value),
            clock: clock(),
            maxTransitions: 1,
            deterministicMachineWorkerLimit: 2,
            performanceTelemetry: {
                clock: performanceClock(),
                onReceipt(value_) { receipt = value_ }
            }
        }),
        (error) => error?.code ===
            'dispatcher-transition-limit-exceeded'
    )
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    assert.equal(Object.values(projection.state.nodes).every((node) =>
        node.receipts.acceptanceContract?.status === 'verified'), true)
    const next = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    assert.equal(next.actions.every(({ type }) =>
        type === 'request-test-contract-planning'), true)
    assert.equal(receipt.operationSummary.machineActionExecution.count, 1)
    assert.equal(receipt.operationSummary.contextPreparation.count, 1)
    assert.equal(receipt.transitions, 1)
})

test('machine preparation uses the observed bounded worker pool', async (t) => {
    const value = fixture([123, 124, 125, 126], { slotCapacity: 4 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const { ledger } = await advanceToMachineActions(value)
    const base = semanticContextProvider(value)
    let active = 0
    let maximumActive = 0
    let entered = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const timer = setTimeout(release, 250)
    t.after(() => clearTimeout(timer))
    const contextProvider = {
        ...base,
        async prepare(request) {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            entered += 1
            if (entered === 2) release()
            await gate
            const prepared = await base.prepare(request)
            active -= 1
            return prepared
        }
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1,
            deterministicMachineWorkerLimit: 2
        }),
        (error) => error?.code ===
            'dispatcher-transition-limit-exceeded'
    )
    assert.equal(maximumActive, 2)
    assert.equal(entered, 4)
})

test('machine batch recorder sorts outputs and isolates one malformed result', async (t) => {
    const value = fixture([105, 106, 107, 108], { slotCapacity: 4 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const { ledger, actionSet } = await advanceToMachineActions(value)
    const results = scriptedMachineResults(value, ledger, actionSet)
    const malformedDigest = actionSet.actions[1].actionDigest
    const entries = actionSet.actions.map((action, index) => ({
        actionDigest: action.actionDigest,
        result: index === 1 ? {
            ...results[index],
            resultDigest: digest('malformed-machine-result')
        } : results[index]
    })).reverse()
    const recorded = recordLifecycleCurrentMachineActionResultBatch({
        ledger,
        actionSet,
        entries,
        createdAt: CREATED_AT,
        startup: value.startup
    })
    assert.deepEqual(recorded.admitted.map(({ actionDigest }) =>
        actionDigest), actionSet.actions
        .map(({ actionDigest }) => actionDigest)
        .filter((actionDigest) => actionDigest !== malformedDigest)
        .sort())
    assert.deepEqual(recorded.excluded.map(({ actionDigest }) =>
        actionDigest), [malformedDigest])
    const projection = projectLifecycleRun(recorded.ledger, {
        startup: value.startup
    })
    assert.equal(projection.state.nodes[
        actionSet.actions[1].nodeId
    ].receipts.acceptanceContract, undefined)
    assert.equal(Object.values(projection.state.nodes).filter((node) =>
        node.receipts.acceptanceContract?.status === 'verified').length, 3)
})

test('machine batch does not consume actor slots or mutate repositories', async (t) => {
    const value = fixture([109, 110, 111, 112], { slotCapacity: 4 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const { ledger } = await advanceToMachineActions(value)
    const beforeStatus = git(['status', '--porcelain=v1'], value.repository.work)
    const beforeHead = git(['rev-parse', 'HEAD'], value.repository.work)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider: semanticContextProvider(value),
            clock: clock(),
            maxTransitions: 1,
            deterministicMachineWorkerLimit: 2
        }),
        (error) => error?.code ===
            'dispatcher-transition-limit-exceeded'
    )
    const current = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(current, {
        startup: value.startup
    }).aggregateProjection
    assert.deepEqual(projection.slots.active, [])
    assert.equal(git(['status', '--porcelain=v1'], value.repository.work),
        beforeStatus)
    assert.equal(git(['rev-parse', 'HEAD'], value.repository.work),
        beforeHead)
})

test('one machine execution failure preserves unrelated valid node progress', async (t) => {
    const value = fixture([115, 116, 117, 118], { slotCapacity: 4 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const { ledger, actionSet } = await advanceToMachineActions(value)
    const failedNodeId = actionSet.actions[1].nodeId
    const base = semanticContextProvider(value)
    const contextProvider = {
        ...base,
        async prepare(request) {
            const prepared = await base.prepare(request)
            if (request.action.nodeId !== failedNodeId) return prepared
            return {
                context: {
                    ...prepared.context,
                    node: null
                }
            }
        }
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1,
            deterministicMachineWorkerLimit: 4
        }),
        (error) => error?.code ===
            'dispatcher-machine-result-invalid' &&
            error.details.admittedActionDigests.length === 3 &&
            error.details.excluded.length === 1
    )
    const current = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(current, {
        startup: value.startup
    })
    assert.equal(Object.values(projection.state.nodes).filter((node) =>
        node.receipts.acceptanceContract?.status === 'verified').length, 3)
    assert.equal(
        projection.state.nodes[failedNodeId]
            .receipts.acceptanceContract,
        undefined
    )
})

test('machine batch and one-at-a-time reference converge to the same projection', async (t) => {
    const value = fixture([119, 120, 121, 122], { slotCapacity: 4 })
    const backup = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'dispatcher-machine-reference-'
    ))
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
        fs.rmSync(backup, { recursive: true, force: true })
    })
    const { ledger, actionSet } = await advanceToMachineActions(value)
    fs.cpSync(value.stateRoot, path.join(backup, 'state'), {
        recursive: true
    })
    const batchResults = scriptedMachineResults(value, ledger, actionSet)
    const batch = recordLifecycleCurrentMachineActionResultBatch({
        ledger,
        actionSet,
        entries: actionSet.actions.map((action, index) => ({
            actionDigest: action.actionDigest,
            result: batchResults[index]
        })).reverse(),
        createdAt: CREATED_AT,
        startup: value.startup
    })
    const batchProjection = projectLifecycleRun(batch.ledger, {
        startup: value.startup
    })
    const batchNext = compileLifecycleRunActionSet(batch.ledger, {
        startup: value.startup
    })
    fs.rmSync(value.stateRoot, { recursive: true, force: true })
    fs.cpSync(path.join(backup, 'state'), value.stateRoot, {
        recursive: true
    })
    clearDerivedCaches(value)
    let serialLedger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    for (let index = 0; index < actionSet.actions.length; index += 1) {
        const currentSet = compileLifecycleRunActionSet(serialLedger, {
            startup: value.startup
        })
        const action = currentSet.actions.find(({ type }) =>
            type === 'compile-acceptance-contract')
        assert.ok(action)
        const projection = projectLifecycleRun(serialLedger, {
            startup: value.startup
        })
        const result = compileScriptedLifecycleStageResult({
            action,
            node: projection.state.nodes[action.nodeId],
            actorRole: 'acceptance-contract-compiler'
        })
        serialLedger = recordLifecycleCurrentActionResult({
            ledger: serialLedger,
            actionSet: currentSet,
            actionDigest: action.actionDigest,
            result,
            createdAt: CREATED_AT,
            startup: value.startup
        }).ledger
    }
    const serialProjection = projectLifecycleRun(serialLedger, {
        startup: value.startup
    })
    const serialNext = compileLifecycleRunActionSet(serialLedger, {
        startup: value.startup
    })
    function stableProjection(projection) {
        return Object.fromEntries(Object.entries(projection.state.nodes)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([nodeId, node]) => [nodeId, {
                lifecycleState: node.lifecycleState,
                status: node.status,
                chainVersion: node.chainVersion,
                receiptKinds: Object.keys(node.receipts).sort()
            }]))
    }
    assert.deepEqual(
        stableProjection(batchProjection),
        stableProjection(serialProjection)
    )
    assert.deepEqual(
        batchNext.actions.map(({ type, nodeId }) => ({ type, nodeId })),
        serialNext.actions.map(({ type, nodeId }) => ({ type, nodeId }))
    )
})

test('machine worker limit cannot exceed observed local capacity', async (t) => {
    const value = fixture([113, 114], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const { ledger } = await advanceToMachineActions(value)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider: semanticContextProvider(value),
            clock: clock(),
            maxTransitions: 1,
            deterministicMachineWorkerLimit: 17
        }),
        (error) => error?.code ===
            'dispatcher-machine-worker-limit-invalid'
    )
    const current = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    assert.deepEqual(
        compileLifecycleRunActionSet(current, {
            startup: value.startup
        }).actions.map(({ type }) => type),
        ['compile-acceptance-contract', 'compile-acceptance-contract']
    )
})

function pendingActorPreparation(prepared, events, nodeId) {
    const adapter = prepared.context.actorAdapter
    return {
        ...prepared,
        context: {
            ...prepared.context,
            actorAdapter: {
                ...adapter,
                prepare(input) {
                    events.push(`actor-start:${nodeId}`)
                    return adapter.prepare(input)
                },
                invoke() {
                    return new Promise(() => {})
                }
            }
        }
    }
}

async function expectStartOnly(value, contextProvider) {
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code ===
            'dispatcher-transition-limit-exceeded'
    )
    return readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
}

test('compatible actor preparations share one projection and overlap before any actor starts', async (t) => {
    const value = fixture([81, 82], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const base = semanticContextProvider(value)
    const projectionRefs = []
    const events = []
    let active = 0
    let maximumActive = 0
    let entered = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const timer = setTimeout(release, 250)
    t.after(() => clearTimeout(timer))
    const contextProvider = {
        ...base,
        async prepare(request) {
            projectionRefs.push(request.projection)
            assert.equal(
                request.repositoryBaseEpoch.schema,
                'issue-orchestration.dispatch-preparation-base-binding.v1'
            )
            active += 1
            maximumActive = Math.max(maximumActive, active)
            entered += 1
            if (entered === 2) release()
            await gate
            const prepared = await base.prepare(request)
            events.push(`prepared:${request.action.nodeId}`)
            active -= 1
            return pendingActorPreparation(
                prepared,
                events,
                request.action.nodeId
            )
        }
    }
    const ledger = await expectStartOnly(value, contextProvider)
    assert.equal(maximumActive, 2)
    assert.equal(projectionRefs.length, 2)
    assert.equal(projectionRefs[0], projectionRefs[1])
    const firstActor = events.findIndex((entry) =>
        entry.startsWith('actor-start:'))
    assert.ok(firstActor >= 2, events)
    assert.equal(activeDispatches(value, ledger).length, 2)
})

test('prepareBatch receives bounded per-action projections and runs once', async (t) => {
    const value = fixture([83, 84], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const base = semanticContextProvider(value)
    const events = []
    let batchCalls = 0
    let singleCalls = 0
    const contextProvider = {
        ...base,
        async prepare() {
            singleCalls += 1
            throw new Error('single prepare must not run')
        },
        async prepareBatch(request) {
            batchCalls += 1
            assert.deepEqual(Object.keys(request).sort(), [
                'actionSetDigest',
                'actions',
                'aggregateProjectionDigest',
                'createdAt',
                'repositoryBaseEpoch',
                'schema',
                'semanticGraphDigest',
                'startup'
            ])
            assert.equal(request.actions.length, 2)
            assert.equal(
                request.repositoryBaseEpoch.schema,
                'issue-orchestration.repository-base-observation-epoch.v1'
            )
            const ledger = readLifecycleRunLedger({
                stateRoot: value.stateRoot,
                runId: value.runId,
                startup: value.startup
            })
            const projection = projectLifecycleRun(ledger, {
                startup: value.startup
            })
            const preparations = []
            for (const item of request.actions) {
                assert.deepEqual(Object.keys(item.projection).sort(), [
                    'aggregateProjectionDigest',
                    'node',
                    'nodeId',
                    'schema',
                    'semanticGraphDigest'
                ])
                assert.equal(item.projection.nodeId, item.action.nodeId)
                assert.equal(item.projection.node.id, item.action.nodeId)
                const prepared = await base.prepare({
                    owner: item.owner,
                    executionClass: item.executionClass,
                    action: item.action,
                    projection
                })
                preparations.push({
                    actionDigest: item.actionDigest,
                    status: 'prepared',
                    prepared: pendingActorPreparation(
                        prepared,
                        events,
                        item.action.nodeId
                    )
                })
            }
            return {
                schema:
                    'issue-orchestration.dispatch-context-batch-result.v1',
                preparations
            }
        }
    }
    const ledger = await expectStartOnly(value, contextProvider)
    assert.equal(batchCalls, 1)
    assert.equal(singleCalls, 0)
    assert.equal(activeDispatches(value, ledger).length, 2)
    assert.equal(events.filter((entry) =>
        entry.startsWith('actor-start:')).length, 2)
})

test('invalid preparation identities fail before dispatch append or actor spawn', async (t) => {
    const cases = [
        ['slotId', 'dispatcher-preparation-slot-duplicate'],
        ['runtimeBindingDigest',
            'dispatcher-preparation-runtime-binding-duplicate'],
        ['leaseDigest', 'dispatcher-preparation-lease-duplicate'],
        ['resourceDigest', 'dispatcher-preparation-resource-duplicate']
    ]
    for (const [field, code] of cases) {
        await t.test(field, async (t) => {
            const value = fixture([85, 86], { slotCapacity: 2 })
            t.after(() => {
                fs.rmSync(value.root, { recursive: true, force: true })
                fs.rmSync(value.stateRoot, { recursive: true, force: true })
            })
            const base = semanticContextProvider(value)
            let actorStarts = 0
            const contextProvider = {
                ...base,
                async prepareBatch(request) {
                    const ledger = readLifecycleRunLedger({
                        stateRoot: value.stateRoot,
                        runId: value.runId,
                        startup: value.startup
                    })
                    const projection = projectLifecycleRun(ledger, {
                        startup: value.startup
                    })
                    const preparations = []
                    for (const item of request.actions) {
                        const prepared = await base.prepare({
                            owner: item.owner,
                            executionClass: item.executionClass,
                            action: item.action,
                            projection
                        })
                        const adapter = prepared.context.actorAdapter
                        prepared.context.actorAdapter = {
                            ...adapter,
                            prepare(input) {
                                actorStarts += 1
                                return adapter.prepare(input)
                            }
                        }
                        preparations.push({
                            actionDigest: item.actionDigest,
                            status: 'prepared',
                            prepared
                        })
                    }
                    preparations[1].prepared.dispatch[field] =
                        preparations[0].prepared.dispatch[field]
                    return {
                        schema:
                            'issue-orchestration.dispatch-context-batch-result.v1',
                        preparations
                    }
                }
            }
            await assert.rejects(
                runLifecycleProductionDispatcher({
                    ledger: value.ledger,
                    startup: value.startup,
                    contextProvider,
                    clock: clock(),
                    maxTransitions: 1
                }),
                (error) => error?.code === code
            )
            const ledger = readLifecycleRunLedger({
                stateRoot: value.stateRoot,
                runId: value.runId,
                startup: value.startup
            })
            assert.equal(activeDispatches(value, ledger).length, 0)
            assert.equal(actorStarts, 0)
        })
    }
})

test('one failed preparation excludes only that action and starts valid peers', async (t) => {
    const value = fixture([87, 88], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const base = semanticContextProvider(value)
    const events = []
    const failedNodeId = `${value.repository.repository}#87`
    const contextProvider = {
        ...base,
        async prepare(request) {
            if (request.action.nodeId === failedNodeId) {
                throw new Error('action-local preparation failed')
            }
            return pendingActorPreparation(
                await base.prepare(request),
                events,
                request.action.nodeId
            )
        }
    }
    const ledger = await expectStartOnly(value, contextProvider)
    const active = activeDispatches(value, ledger)
    assert.equal(active.length, 1)
    assert.equal(active[0].nodeId,
        `${value.repository.repository}#88`)
    assert.deepEqual(events.filter((entry) =>
        entry.startsWith('actor-start:')), [
        `actor-start:${value.repository.repository}#88`
    ])
})

test('dispatch batch recorder rejects silent preparation omissions', (t) => {
    const value = fixture([93, 94], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const actionSet = compileLifecycleRunActionSet(value.ledger, {
        startup: value.startup
    })
    const actions = actionSet.actions.filter(({ type }) =>
        type === 'request-semantic-proposal')
    const metadata = {
        actionDigest: actions[0].actionDigest,
        nodeId: actions[0].nodeId,
        owner: 'pre-writer',
        attemptId: 'partition-attempt',
        slotId: 'partition-slot',
        runtimeBindingDigest: digest('partition-runtime'),
        leaseDigest: digest('partition-lease'),
        resourceDigest: digest('partition-resource')
    }
    assert.throws(
        () => recordLifecycleDispatchBatchStarted({
            ledger: value.ledger,
            actionSet,
            dispatches: [metadata],
            createdAt: CREATED_AT,
            startup: value.startup
        }),
        (error) => error?.code ===
            'lifecycle-dispatch-preparation-partition-invalid'
    )
    const recorded = recordLifecycleDispatchBatchStarted({
        ledger: value.ledger,
        actionSet,
        dispatches: [metadata],
        failedActionDigests: [actions[1].actionDigest],
        createdAt: CREATED_AT,
        startup: value.startup
    })
    assert.deepEqual(recorded.batch.failedActionDigests, [
        actions[1].actionDigest
    ])
    assert.equal(recorded.dispatches.length, 1)
})

test('prepareBatch cannot reorder action outputs or start any actor', async (t) => {
    const value = fixture([89, 90], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const base = semanticContextProvider(value)
    let actorStarts = 0
    const contextProvider = {
        ...base,
        async prepareBatch(request) {
            const ledger = readLifecycleRunLedger({
                stateRoot: value.stateRoot,
                runId: value.runId,
                startup: value.startup
            })
            const projection = projectLifecycleRun(ledger, {
                startup: value.startup
            })
            const prepared = await Promise.all(request.actions.map(
                async (item) => {
                    const value = await base.prepare({
                        owner: item.owner,
                        executionClass: item.executionClass,
                        action: item.action,
                        projection
                    })
                    const adapter = value.context.actorAdapter
                    value.context.actorAdapter = {
                        ...adapter,
                        prepare(input) {
                            actorStarts += 1
                            return adapter.prepare(input)
                        }
                    }
                    return value
                }))
            return {
                schema:
                    'issue-orchestration.dispatch-context-batch-result.v1',
                preparations: [
                    {
                        actionDigest: request.actions[1].actionDigest,
                        status: 'prepared',
                        prepared: prepared[1]
                    },
                    {
                        actionDigest: request.actions[0].actionDigest,
                        status: 'prepared',
                        prepared: prepared[0]
                    }
                ]
            }
        }
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code ===
            'dispatcher-batch-preparation-order-invalid'
    )
    assert.equal(actorStarts, 0)
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    assert.equal(activeDispatches(value, ledger).length, 0)
})


test('batch and concurrent-single preparation append byte-identical start evidence', async (t) => {
    const value = fixture([91, 92], { slotCapacity: 2 })
    const snapshot = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'dispatcher-preparation-snapshot-'
    ))
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
        fs.rmSync(snapshot, { recursive: true, force: true })
    })
    fs.cpSync(value.stateRoot, snapshot, { recursive: true })

    const fallbackBase = semanticContextProvider(value)
    const fallbackProvider = {
        ...fallbackBase,
        async prepare(request) {
            return pendingActorPreparation(
                await fallbackBase.prepare(request),
                [],
                request.action.nodeId
            )
        }
    }
    await expectStartOnly(value, fallbackProvider)
    const fallbackTree = stateTree(value.stateRoot)
    const fallbackProjection = projectLifecycleRun(
        readLifecycleRunLedger({
            stateRoot: value.stateRoot,
            runId: value.runId,
            startup: value.startup
        }),
        { startup: value.startup }
    ).aggregateProjection

    fs.rmSync(value.stateRoot, { recursive: true, force: true })
    fs.cpSync(snapshot, value.stateRoot, { recursive: true })
    clearDerivedCaches(value)

    const batchBase = semanticContextProvider(value)
    const batchProvider = {
        ...batchBase,
        async prepareBatch(request) {
            const ledger = readLifecycleRunLedger({
                stateRoot: value.stateRoot,
                runId: value.runId,
                startup: value.startup
            })
            const projection = projectLifecycleRun(ledger, {
                startup: value.startup
            })
            return {
                schema:
                    'issue-orchestration.dispatch-context-batch-result.v1',
                preparations: await Promise.all(request.actions.map(
                    async (item) => ({
                        actionDigest: item.actionDigest,
                        status: 'prepared',
                        prepared: pendingActorPreparation(
                            await batchBase.prepare({
                                owner: item.owner,
                                executionClass: item.executionClass,
                                action: item.action,
                                projection
                            }),
                            [],
                            item.action.nodeId
                        )
                    })))
            }
        }
    }
    await expectStartOnly(value, batchProvider)
    const batchTree = stateTree(value.stateRoot)
    const batchProjection = projectLifecycleRun(
        readLifecycleRunLedger({
            stateRoot: value.stateRoot,
            runId: value.runId,
            startup: value.startup
        }),
        { startup: value.startup }
    ).aggregateProjection

    assert.deepEqual(batchTree, fallbackTree)
    assert.deepEqual(
        batchProjection.activeDispatches,
        fallbackProjection.activeDispatches
    )
    assert.deepEqual(batchProjection.slots, fallbackProjection.slots)
})


test('typed actor-stage failures require an exact validated stage result', (t) => {
    const value = fixture([51], { slotCapacity: 1 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const nodeId = `${value.repository.repository}#51`
    const ledger = advanceNodeToState(
        value,
        value.ledger,
        nodeId,
        'test-contract-frozen'
    )
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const actionSet = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    const action = actionSet.actions.find(({ nodeId: id }) => id === nodeId)
    const attemptId = `${nodeId}:typed-retry`
    const result = compileScriptedLifecycleStageResult({
        action,
        node: projection.state.nodes[nodeId],
        actorRole: 'code-implementer',
        mode: 'recoverable-failure',
        facts: { attemptId }
    })
    const failure = compileLifecycleActorStageFailure({
        failureFamily: 'writer-retry-authorized',
        result
    })
    const dispatch = {
        actionDigest: action.actionDigest,
        action,
        nodeId,
        attemptId
    }
    const validated = validateLifecycleActorStageFailure(
        failure,
        { dispatch }
    )
    assert.equal(validated.contractId, 'implementation-retry')
    assert.equal(validated.family, 'writer-retry-authorized')

    const reSigned = structuredClone(failure)
    reSigned.message = 'looks recoverable'
    reSigned.failureDigest = digest(reSigned)
    assert.throws(
        () => validateLifecycleActorStageFailure(reSigned, { dispatch }),
        (error) => error?.code ===
            'executor-failure-envelope-fields-invalid'
    )
    assert.throws(
        () => compileLifecycleActorStageFailure({
            failureFamily: 'verifier-rejection',
            result
        }),
        (error) => error?.code ===
            'executor-failure-stage-contract-forbidden'
    )
})

test('typed writer failure frees only its dispatch while an unrelated actor remains active', async (t) => {
    const value = fixture([61, 62], { slotCapacity: 2 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const nodeIds = [61, 62].map((number) =>
        `${value.repository.repository}#${number}`)
    let ledger = advanceNodesToState(
        value,
        value.ledger,
        nodeIds,
        'test-contract-frozen'
    )
    const actionSet = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    const actions = nodeIds.map((nodeId) =>
        actionSet.actions.find((action) => action.nodeId === nodeId))
    assert.ok(actions.every(Boolean))
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const attempts = Object.fromEntries(actions.map((action) => [
        action.nodeId,
        `${action.nodeId}:implementation-attempt`
    ]))
    const failedResult = compileScriptedLifecycleStageResult({
        action: actions[0],
        node: projection.state.nodes[actions[0].nodeId],
        actorRole: 'code-implementer',
        mode: 'recoverable-failure',
        facts: { attemptId: attempts[actions[0].nodeId] }
    })
    const stageFailure = compileLifecycleActorStageFailure({
        failureFamily: 'writer-retry-authorized',
        result: failedResult
    })
    const started = recordLifecycleDispatchBatchStarted({
        ledger,
        actionSet,
        dispatches: actions.map((action, index) => ({
            actionDigest: action.actionDigest,
            nodeId: action.nodeId,
            owner: 'writer',
            attemptId: attempts[action.nodeId],
            slotId: `slot:${index + 1}`,
            runtimeBindingDigest: digest(`runtime:${action.nodeId}`),
            leaseDigest: digest(`lease:${action.nodeId}`),
            resourceDigest: digest(`resource:${action.nodeId}`)
        })),
        createdAt: CREATED_AT,
        startup: value.startup
    })
    const failedDispatchId = started.dispatches.find(
        ({ nodeId }) => nodeId === actions[0].nodeId
    ).dispatchId
    const longDispatchId = started.dispatches.find(
        ({ nodeId }) => nodeId === actions[1].nodeId
    ).dispatchId
    const baseProvider = semanticContextProvider(value)
    const never = new Promise(() => {})
    const contextProvider = {
        ...baseProvider,
        async recoverActiveDispatch({ dispatch }) {
            return {
                completion: dispatch.dispatchId === failedDispatchId
                    ? Promise.reject(
                        lifecycleActorStageFailureError(stageFailure)
                    )
                    : never
            }
        }
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: started.ledger,
            startup: value.startup,
            contextProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code ===
            'dispatcher-transition-limit-exceeded'
    )
    ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const after = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    assert.deepEqual(
        Object.keys(after.aggregateProjection.activeDispatches),
        [longDispatchId]
    )
    const failedHistory = after.aggregateProjection.dispatchHistory.find(
        ({ dispatchId }) => dispatchId === failedDispatchId
    )
    assert.equal(failedHistory.outcome, 'failed')
    assert.equal(
        failedHistory.failureFamily,
        'writer-retry-authorized'
    )
    assert.equal(
        after.state.nodes[actions[0].nodeId].lifecycleState,
        'implementing-self-testing'
    )
    assert.ok(
        after.state.nodes[actions[0].nodeId]
            .receipts.retryAuthorization
    )
    const next = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    assert.ok(next.actions.some((action) =>
        action.nodeId === actions[0].nodeId &&
        action.type === 'dispatch-implementation-writer'))
    assert.ok(!next.actions.some((action) =>
        action.nodeId === actions[1].nodeId))
})

test('typed verifier rejection follows the canonical rework path', (t) => {
    const value = fixture([71], { slotCapacity: 1 })
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const nodeId = `${value.repository.repository}#71`
    let ledger = advanceNodeToState(
        value,
        value.ledger,
        nodeId,
        'candidate-green'
    )
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    const actionSet = compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    })
    const action = actionSet.actions.find(({ nodeId: id }) => id === nodeId)
    const attemptId = `${nodeId}:behavior-rejection`
    const result = compileScriptedLifecycleStageResult({
        action,
        node: projection.state.nodes[nodeId],
        actorRole: 'test-owner',
        mode: 'rejected',
        facts: { attemptId }
    })
    const failure = compileLifecycleActorStageFailure({
        failureFamily: 'verifier-rejection',
        result
    })
    const started = recordLifecycleDispatchBatchStarted({
        ledger,
        actionSet,
        dispatches: [{
            actionDigest: action.actionDigest,
            nodeId: action.nodeId,
            owner: 'observe-only',
            attemptId,
            slotId: 'slot:1',
            runtimeBindingDigest: digest(`runtime:${nodeId}`),
            leaseDigest: digest(`lease:${nodeId}`),
            resourceDigest: digest(`resource:${nodeId}`)
        }],
        createdAt: CREATED_AT,
        startup: value.startup
    })
    const recorded = recordLifecycleDispatchedActionResultBatch({
        ledger: started.ledger,
        entries: [{
            dispatchId: started.dispatches[0].dispatchId,
            stageFailure: failure
        }],
        createdAt: CREATED_AT,
        startup: value.startup
    })
    assert.equal(recorded.failed.length, 1)
    const after = projectLifecycleRun(recorded.ledger, {
        startup: value.startup
    })
    assert.equal(after.state.nodes[nodeId].lifecycleState,
        'implementing-self-testing')
    assert.equal(after.state.nodes[nodeId].reworkCount, 1)
    assert.equal(
        after.state.nodes[nodeId].firstFailure.classification,
        'behavior-verification-rejected'
    )
    assert.equal(
        after.aggregateProjection.dispatchHistory.find(
            ({ dispatchId }) =>
                dispatchId === started.dispatches[0].dispatchId
        ).outcome,
        'failed'
    )
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

test('two ready actors settle in one stable batch before recompilation', async (t) => {
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
            maxTransitions: 2
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
    const control = projection.aggregateProjection
    assert.equal(control.dispatchHistory.length, 2)
    assert.equal(Object.keys(control.activeDispatches).length, 0)
    assert.equal(control.slots.active.length, 0)
    assert.deepEqual(
        control.dispatchHistory.map(({ dispatchId }) => dispatchId),
        control.dispatchHistory.map(({ dispatchId }) => dispatchId).sort()
    )

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
        .map(({ eventType, payload }) => ({
            eventType,
            dispatchId: payload.dispatchId
        }))
    assert.equal(order.length, 4)
    assert.deepEqual(
        order.slice(0, 2).map(({ eventType }) => eventType),
        ['dispatch.action-started', 'dispatch.action-started']
    )
    assert.deepEqual(
        order.slice(2).map(({ eventType }) => eventType),
        ['dispatch.action-settled', 'dispatch.action-settled']
    )
    assert.deepEqual(
        order.slice(2).map(({ dispatchId }) => dispatchId),
        order.slice(2).map(({ dispatchId }) => dispatchId).sort()
    )
    assert.ok(value.actorContextEnvelopes.length >= 2)
    assert.ok(value.actorContextEnvelopes.every((envelope) =>
        envelope.schema ===
            'issue-orchestration.actor-context-envelope.v1' &&
        envelope.authority.kind === 'actor-input-only' &&
        envelope.authority.grants.length === 0))
    const semanticPrefixes = value.actorPromptBundles
        .filter(({ stablePrefix }) =>
            stablePrefix.phase === 'semantic-proposal')
        .map(({ cacheIdentity }) => cacheIdentity.stablePrefixDigest)
    assert.equal(semanticPrefixes.length, 2)
    assert.equal(new Set(semanticPrefixes).size, 1)
})


test('three already-ready actors drain through one admission operation', async (t) => {
    const value = fixture([41, 42, 43], { slotCapacity: 3 })
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
            maxTransitions: 2,
            performanceTelemetry: {
                clock: performanceClock(),
                onReceipt(value) {
                    receipt = value
                }
            }
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
    assert.equal(projection.aggregateProjection.dispatchHistory.length, 3)
    assert.equal(
        Object.keys(projection.aggregateProjection.activeDispatches).length,
        0
    )
    assert.equal(receipt.operationSummary.actorResultAdmission.count, 1)
    assert.equal(receipt.operationSummary.actionSetCompilation.count, 2)
    assert.ok(receipt.spans.some((span) =>
        span.boundary === 'actor-result-batch-admission' &&
        span.dispatchIds?.length === 3))
    assert.ok(receipt.spans.some((span) =>
        span.boundary === 'repository-base-post-wave' &&
        span.dispatchIds?.length === 3))
})

test('one ready actor is admitted without waiting for an unfinished peer', async (t) => {
    const value = fixture([41, 42])
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const baseProvider = semanticContextProvider(value)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider: baseProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const [ready, unfinished] = activeDispatches(value, ledger)
    const recoveryProvider = {
        prepare: baseProvider.prepare,
        observeRemoteIssues: baseProvider.observeRemoteIssues,
        async recoverActiveDispatch(request) {
            if (request.dispatch.dispatchId === unfinished.dispatchId) {
                return { completion: new Promise(() => {}) }
            }
            return {
                completion: Promise.resolve().then(() =>
                    baseProvider.executeRecoveredDispatch(request))
            }
        }
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider: recoveryProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    const after = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(after, {
        startup: value.startup
    }).aggregateProjection
    assert.deepEqual(
        projection.dispatchHistory.map(({ dispatchId }) => dispatchId),
        [ready.dispatchId]
    )
    assert.deepEqual(
        Object.keys(projection.activeDispatches),
        [unfinished.dispatchId]
    )
})

test('a rejected actor does not block an unrelated valid admission', async (t) => {
    const value = fixture([41, 42])
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
    })
    const baseProvider = semanticContextProvider(value)
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger: value.ledger,
            startup: value.startup,
            contextProvider: baseProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const [rejected, valid] = activeDispatches(value, ledger)
    const recoveryProvider = {
        prepare: baseProvider.prepare,
        observeRemoteIssues: baseProvider.observeRemoteIssues,
        async recoverActiveDispatch(request) {
            if (request.dispatch.dispatchId === rejected.dispatchId) {
                const error = new Error('fixture actor rejection')
                error.code = 'fixture-actor-rejection'
                return { completion: Promise.reject(error) }
            }
            return {
                completion: Promise.resolve().then(() =>
                    baseProvider.executeRecoveredDispatch(request))
            }
        }
    }
    await assert.rejects(
        runLifecycleProductionDispatcher({
            ledger,
            startup: value.startup,
            contextProvider: recoveryProvider,
            clock: clock(),
            maxTransitions: 1
        }),
        (error) => {
            assert.equal(error?.code, 'dispatcher-executor-failed')
            assert.deepEqual(error.details.admittedDispatchIds, [
                valid.dispatchId
            ])
            return true
        }
    )
    const after = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const projection = projectLifecycleRun(after, {
        startup: value.startup
    }).aggregateProjection
    assert.deepEqual(
        projection.dispatchHistory.map(({ dispatchId }) => dispatchId),
        [valid.dispatchId]
    )
    assert.deepEqual(
        Object.keys(projection.activeDispatches),
        [rejected.dispatchId]
    )
})

test('batch recorder sorts results and isolates one malformed result', async (t) => {
    const value = fixture([41, 42])
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
    const ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    const [first, second] = activeDispatches(value, ledger)
    const valid = await recoveredResult(
        value,
        contextProvider,
        ledger,
        first
    )
    const malformed = structuredClone(await recoveredResult(
        value,
        contextProvider,
        ledger,
        second
    ))
    delete malformed.artifacts[Object.keys(malformed.artifacts)[0]]
    delete malformed.resultDigest
    malformed.resultDigest = digest(malformed)
    assert.throws(
        () => recordLifecycleDispatchedActionResultBatch({
            ledger,
            entries: [{
                dispatchId: first.dispatchId,
                exclusionCode: 'caller-authored-exclusion'
            }],
            createdAt: CREATED_AT,
            startup: value.startup
        }),
        (error) => error?.code ===
            'lifecycle-dispatch-exclusion-code-invalid'
    )
    const recorded = recordLifecycleDispatchedActionResultBatch({
        ledger,
        entries: [
            { dispatchId: second.dispatchId, result: malformed },
            { dispatchId: first.dispatchId, result: valid }
        ],
        createdAt: CREATED_AT,
        startup: value.startup
    })
    assert.deepEqual(
        recorded.admitted.map(({ dispatchId }) => dispatchId),
        [first.dispatchId]
    )
    assert.deepEqual(
        recorded.excluded.map(({ dispatchId }) => dispatchId),
        [second.dispatchId]
    )
    const projection = projectLifecycleRun(recorded.ledger, {
        startup: value.startup
    })
    assert.deepEqual(
        projection.aggregateProjection.dispatchHistory.map(
            ({ dispatchId }) => dispatchId
        ),
        [first.dispatchId, second.dispatchId]
    )
    assert.equal(
        projection.aggregateProjection.dispatchHistory[1].outcome,
        'excluded'
    )
    assert.ok(Object.keys(
        projection.state.nodes[first.nodeId].receipts
    ).length > 0)
    assert.equal(Object.keys(
        projection.state.nodes[second.nodeId].receipts
    ).length, 0)
})

test('batch and sorted single-result admission produce byte-identical state', async (t) => {
    const value = fixture([41, 42])
    const snapshot = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'dispatcher-ready-batch-snapshot-'
    ))
    t.after(() => {
        fs.rmSync(value.root, { recursive: true, force: true })
        fs.rmSync(value.stateRoot, { recursive: true, force: true })
        fs.rmSync(snapshot, { recursive: true, force: true })
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
    const dispatches = activeDispatches(value, ledger)
    const results = new Map()
    for (const dispatch of dispatches) {
        results.set(dispatch.dispatchId, await recoveredResult(
            value,
            contextProvider,
            ledger,
            dispatch
        ))
    }
    fs.cpSync(value.stateRoot, snapshot, { recursive: true })
    const batch = recordLifecycleDispatchedActionResultBatch({
        ledger,
        entries: [...dispatches].reverse().map((dispatch) => ({
            dispatchId: dispatch.dispatchId,
            result: results.get(dispatch.dispatchId)
        })),
        createdAt: CREATED_AT,
        startup: value.startup
    })
    const batchTree = stateTree(value.stateRoot)
    const batchActions = compileLifecycleRunActionSet(batch.ledger, {
        startup: value.startup
    })

    fs.rmSync(value.stateRoot, { recursive: true, force: true })
    fs.cpSync(snapshot, value.stateRoot, { recursive: true })
    clearDerivedCaches(value)
    ledger = readLifecycleRunLedger({
        stateRoot: value.stateRoot,
        runId: value.runId,
        startup: value.startup
    })
    for (const dispatch of dispatches) {
        ledger = recordLifecycleDispatchedActionResult({
            ledger,
            dispatchId: dispatch.dispatchId,
            result: results.get(dispatch.dispatchId),
            createdAt: CREATED_AT,
            startup: value.startup
        }).ledger
    }
    assert.deepEqual(stateTree(value.stateRoot), batchTree)
    assert.deepEqual(compileLifecycleRunActionSet(ledger, {
        startup: value.startup
    }), batchActions)
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
        2
    )
    assert.equal(
        Object.keys(projection.aggregateProjection.activeDispatches).length,
        0
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

test('a default-branch change excludes stale actor results without node mutation', async (t) => {
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
        (error) => error?.code === 'dispatcher-transition-limit-exceeded'
    )
    const projection = projectLifecycleRun(ledger, {
        startup: value.startup
    })
    assert.equal(projection.aggregateProjection.dispatchHistory.length, 2)
    assert.ok(projection.aggregateProjection.dispatchHistory.every(
        ({ outcome, exclusionCode }) =>
            outcome === 'excluded' &&
            exclusionCode === 'dispatcher-active-result-base-stale'
    ))
    assert.equal(
        Object.keys(projection.aggregateProjection.activeDispatches).length,
        0
    )
    assert.ok(Object.values(projection.state.nodes).every((node) =>
        Object.keys(node.receipts).length === 0))
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
            maxTransitions: 2,
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
        canonicalReplay: { count: 3, durationMs: 15 },
        aggregateProjectionRebuild: { count: 3, durationMs: 15 },
        actionSetCompilation: { count: 2, durationMs: 10 },
        remoteScopeObservation: { count: 2, durationMs: 10 },
        repositoryBaseObservation: { count: 2, durationMs: 10 },
        contextPreparation: { count: 1, durationMs: 5 },
        machineActionExecution: { count: 0, durationMs: 0 },
        actorResultAdmission: { count: 1, durationMs: 5 }
    })
    assert.equal(receipt.actorDispatches.length, 2)
    assert.equal(receipt.promptCacheObservations.length, 2)
    assert.ok(receipt.promptCacheObservations.every((observation) =>
        observation.providerMetadata.provider === 'fixture-runtime' &&
        observation.providerMetadata.ignoredAuthority === undefined &&
        observation.cacheIdentityDigest.length === 64))
    assert.equal(
        receipt.actorDispatches.filter(({ admittedAt }) => admittedAt)
            .length,
        2
    )
    assert.equal(receipt.slotRefills.length, 0)
    assert.equal(receipt.idleSafeSlotDurationMs, 0)
    assert.equal(receipt.slotSamples.length, 7)
    assert.ok(receipt.slotSamples.some(({ capacity, active, available }) =>
        capacity === 2 && active === 2 && available === 0))
    assert.ok(receipt.slotSamples.some(({ capacity, active, available }) =>
        capacity === 2 && active === 1 && available === 1))
    assert.deepEqual(receipt.repositoryBaseObservations, [{
        repository: value.repository.repository,
        count: 2,
        durationMs: 10
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
        span.dispatchIds?.length === 2))
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
            /dispatcher-performance|performanceTelemetry|performanceReceipt|promptCacheMetadata|cacheIdentityDigest|stablePrefixDigest|remoteFactsTransferred|deltaMembers|selectorRebuilt|observationStatus/u,
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
