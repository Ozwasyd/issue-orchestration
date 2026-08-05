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
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    projectLifecycleRun,
    readLifecycleRunLedger,
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
        routingPolicyVersion: 'stage-model-pool.v3'
    }
}

function profileMetadata(profile) {
    if (profile.startsWith('sol-')) {
        return { model: 'gpt-5.6-sol', effort: profile.slice(4) }
    }
    if (profile.startsWith('luna-')) {
        return { model: 'gpt-5.6-luna', effort: profile.slice(5) }
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
        prepare({ stageRole, stagePhase, routeDecision }) {
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
                })
            }
        },
        invoke({ preparation, routeDecision, request }) {
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
        runId
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
