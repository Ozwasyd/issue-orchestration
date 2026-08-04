import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { digest } from '../../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    resolveSelector
} from '../../../skills/issue-orchestration/scripts/scope-selector.mjs'
import {
    attestRuntimeStartup,
    compileRuntimeStartupObservation,
    currentRuntimeStartupAuthority
} from '../../../skills/issue-orchestration/scripts/runtime-startup-attestation.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    persistLifecycleRunLedger,
    projectLifecycleRun,
    readLifecycleRunLedger,
    recordLifecycleActionResults,
    recordLifecycleBaseChange,
    recordLifecycleScopeRefresh
} from '../../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    compileScriptedLifecycleStageResult
} from './scripted-lifecycle-stage-result.mjs'

const RECEIPT_SCHEMA =
    'issue-orchestration.multi-repository-lifecycle-e2e-receipt.v1'
const RUN_ID = 'multi-repository-lifecycle-e2e'
const GROUP = 'acceptance-group-alpha'
const CREATED_AT = '2026-08-04T00:00:00.000Z'

export class MultiRepositoryLifecycleE2EError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'MultiRepositoryLifecycleE2EError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new MultiRepositoryLifecycleE2EError(code, code, details)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map(
            (key) => [key, canonical(value[key])]
        )
    )
}

function localDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function record(value) {
    const result = structuredClone(value)
    result.recordDigest = localDigest(result)
    return result
}

function runtimeStartup() {
    const authority = currentRuntimeStartupAuthority()
    const common = {
        schema:
            'issue-orchestration.trusted-runtime-startup-record.v1',
        producerAuthority: 'runtime-owned',
        runtimeAdapter: 'codex-rollout-v1',
        runtimeId: 'codex',
        runtimeVersion: 'deterministic-ci-actor-v1',
        invocationId: 'issue-25-runtime-invocation',
        sessionId: 'issue-25-runtime-session'
    }
    const observedAt = '2026-08-04T00:00:00.000Z'
    const launcherRecord = record({
        ...common,
        kind: 'launcher',
        producer: 'codex-launcher',
        requestedRole: 'root-scheduler',
        requestedStage: 'scheduling',
        selectedProfile: 'terra-low',
        requestedModel: 'gpt-5.6-terra',
        requestedEffort: 'low',
        requestedMultiAgentBackend: 'v2',
        requestedSandbox: 'danger-full-access',
        requestedPermissionProfile: 'danger-full-access',
        requestedApprovalPolicy: 'never',
        rootRouteDigest: localDigest({
            role: 'root-scheduler',
            phase: 'scheduling',
            profile: 'terra-low'
        }),
        rootAuthorityEpoch: 'issue-25-root-epoch-1',
        packageDigest: authority.packageDigest,
        manifestDigest: authority.manifestDigest,
        policyDigests: authority.policyDigests,
        observedAt
    })
    const runtimeRecord = record({
        ...common,
        kind: 'runtime',
        producer: 'codex-rollout',
        effectiveProfile: 'terra-low',
        effectiveModel: 'gpt-5.6-terra',
        effectiveEffort: 'low',
        effectiveMultiAgentBackend: 'v2',
        trustMode: 'trusted-owner-repositories',
        effectiveSandbox: 'danger-full-access',
        effectivePermissionProfile: 'danger-full-access',
        effectiveApprovalPolicy: 'never',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt
    })
    const capacityRecord = record({
        ...common,
        kind: 'capacity',
        producer: 'codex-control-plane',
        capacity: {
            status: 'observed',
            multiAgentV2: true,
            maxConcurrentThreadsPerSession: 2,
            reasonCode: null
        },
        observedAt
    })
    const observation = compileRuntimeStartupObservation({
        launcherRecord,
        runtimeRecord,
        capacityRecord
    })
    const attestation = attestRuntimeStartup({
        observation,
        attestedAt: '2026-08-04T00:00:01.000Z'
    })
    if (attestation.status !== 'verified') {
        fail('multi-repository-e2e-startup-rejected', {
            reasonCodes: attestation.reasonCodes
        })
    }
    return { observation, attestation, takeoverContext: null }
}

function runGit(args, cwd) {
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
        fail('multi-repository-e2e-git-failed', {
            cwd,
            args,
            stdout: result.stdout,
            stderr: result.stderr
        })
    }
    return result.stdout.trim()
}

function write(root, relative, content) {
    const target = path.resolve(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    return target
}

function initRepository(scenarioRoot, key) {
    const bare = path.resolve(scenarioRoot, `${key}.git`)
    const work = path.resolve(scenarioRoot, `${key}-work`)
    runGit(
        ['init', '--bare', '--initial-branch=main', bare],
        scenarioRoot
    )
    runGit(['clone', bare, work], scenarioRoot)
    runGit(['config', 'user.name', 'deterministic-stage-actor'], work)
    runGit(['config', 'user.email', 'actor@example.invalid'], work)
    write(work, 'README.md', `# ${key}\n`)
    runGit(['add', 'README.md'], work)
    runGit(['commit', '-m', `initialize ${key}`], work)
    runGit(['push', '-u', 'origin', 'main'], work)
    return {
        key,
        repository: `Fixture/${key}`,
        bare,
        work,
        baseSha: runGit(['rev-parse', 'HEAD'], work),
        bindingDigest: digest({
            repository: `Fixture/${key}`,
            bare: path.basename(bare),
            baseSha: runGit(['rev-parse', 'HEAD'], work)
        }),
        pushCount: 1,
        deliveredCommits: []
    }
}

function rawIssue(repository, number, {
    dependsOn = [],
    ui = false,
    group = null
} = {}) {
    return {
        repository,
        number,
        state: 'OPEN',
        stateReason: null,
        updatedAt:
            `2026-08-04T00:00:${String(number).padStart(2, '0')}.000Z`,
        title: `Issue ${number} deterministic lifecycle work`,
        body: [
            `Implement issue ${number} through every lifecycle stage.`,
            'All stage outputs must be independently verifiable.',
            ui
                ? 'This is a UI/UX issue requiring adjudication and UX acceptance.'
                : 'This is a non-UI issue.'
        ].join('\n'),
        comments: [],
        labels: ui ? ['ui-ux'] : ['code'],
        milestone: null,
        dependsOn,
        ui,
        group
    }
}

function issueId(issue) {
    return `${issue.repository}#${issue.number}`
}

function selectorDefinition(issues, version) {
    const ids = Object.keys(issues).sort()
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: `issue-25-selector-${version}`,
        type: 'explicit-issues',
        repositories: [...new Set(
            Object.values(issues).map(({ repository }) => repository)
        )].sort(),
        parameters: {
            issueIds: ids,
            states: ['OPEN', 'CLOSED']
        },
        remoteQueryIdentity:
            'deterministic-local-bare-remotes:explicit-issues'
    }
}

function resolveCurrentSelector({
    issues,
    version,
    startup,
    previousReceipt = null
}) {
    return resolveSelector({
        selector: selectorDefinition(issues, version),
        remoteIssues: Object.values(issues),
        previousReceipt,
        resolvedAt:
            `2026-08-04T00:10:${String(version).padStart(2, '0')}.000Z`,
        startup
    })
}

function initialSemanticGraph({
    selectorReceipt,
    repositories,
    issues,
    policyDigest
}) {
    const repositoryEntries = Object.values(repositories).map(
        (repository) => ({
            repository: repository.repository,
            baseSha: repository.baseSha,
            bindingDigest: repository.bindingDigest
        })
    )
    return createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest:
            selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest(Object.keys(issues).sort()),
        semanticGraphInputDigest: digest({
            issues: Object.values(issues).map((issue) => ({
                issueId: issueId(issue),
                dependsOn: issue.dependsOn,
                ui: issue.ui,
                group: issue.group
            }))
        }),
        policyDigest,
        repositories: repositoryEntries,
        nodes: Object.values(issues).map((issue) => {
            const repository = repositories[
                issue.repository.endsWith('RepoA')
                    ? 'RepoA'
                    : 'RepoB'
            ]
            return {
                id: issueId(issue),
                memberId: issueId(issue),
                repository: issue.repository,
                issueNumber: issue.number,
                owner: 'dag-creator-updater',
                dependencyKeys: [...issue.dependsOn],
                conflictKeys: [],
                riskClass: issue.ui ? 'high-risk' : 'bounded',
                uiClass: issue.ui ? 'ui' : 'non-ui',
                acceptanceGroup: issue.group,
                lifecycleState: 'none',
                selectorReceiptDigest:
                    selectorReceipt.receiptDigest,
                remoteSnapshotDigest:
                    selectorReceipt.remoteSnapshotDigest,
                repositoryBindingDigest:
                    repository.bindingDigest,
                semanticFactsDigest: digest({
                    issue: issueId(issue),
                    title: issue.title,
                    body: issue.body,
                    comments: issue.comments,
                    dependsOn: issue.dependsOn,
                    ui: issue.ui,
                    group: issue.group
                }),
                receipts: {}
            }
        })
    })
}

function resourcePath(resourceRoot, nodeId) {
    return path.resolve(
        resourceRoot,
        nodeId.replaceAll('/', '_').replaceAll('#', '_')
    )
}

function actorRole(action, node) {
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
            return node.uiClass === 'ui'
                ? 'ui-ux-implementer'
                : 'code-implementer'
        case 'request-ui-adjudication':
            return 'ui-system-adjudicator'
        case 'dispatch-ux-acceptance-verifier':
            return 'ux-acceptance-verifier'
        case 'dispatch-documentation-writer':
            return 'documentation-writer'
        case 'deliver-acceptance-group':
            return 'root-delivery-adapter'
        case 'cleanup-node-resources':
            return 'root-cleanup-adapter'
        case 'terminalize-node':
            return 'root-scheduler'
        default:
            fail('multi-repository-e2e-actor-role-unknown', {
                actionType: action.type
            })
    }
}

function stageDecision(action, node) {
    switch (action.type) {
        case 'request-semantic-proposal':
            return {
                classifications: [
                    node.uiClass,
                    node.riskClass
                ]
            }
        case 'compile-acceptance-contract':
            return {
                requirementCount: 3,
                acceptanceIds: [
                    `${node.id}:behavior`,
                    `${node.id}:cleanup`
                ]
            }
        case 'request-test-contract-planning':
            return {
                testPaths: [
                    `tests/issue-${node.issueNumber}.test.mjs`
                ],
                commands: ['node --test']
            }
        case 'dispatch-test-contract-writer':
            return {
                writtenPaths: [
                    `tests/issue-${node.issueNumber}.test.mjs`
                ],
                commandExitCode: 0
            }
        case 'dispatch-implementation-writer':
            return {
                candidateSha: localDigest({
                    nodeId: node.id,
                    attempt: node.implementationAttempts + 1
                }).slice(0, 40),
                commandExitCode: 0
            }
        case 'dispatch-behavior-verifier':
            return {
                candidateSha: node.deliveryCommit ??
                    localDigest(node.id).slice(0, 40),
                independent: true,
                freshContext: true
            }
        case 'request-ui-adjudication':
            return {
                adjudication: 'bounded-ui-contract-confirmed'
            }
        case 'dispatch-ux-acceptance-verifier':
            return {
                renderEvidence: 'observed',
                independent: true
            }
        case 'dispatch-documentation-writer':
            return {
                mode: 'no-change',
                reason: 'scenario lifecycle evidence is self-describing'
            }
        case 'cleanup-node-resources':
            return { residueCount: 0 }
        case 'terminalize-node':
            return { category: 'externally_blocked' }
        default:
            return {}
    }
}

function syncRepository(repository) {
    runGit(['fetch', 'origin', 'main'], repository.work)
    runGit(['reset', '--hard', 'origin/main'], repository.work)
}

function deliveryMembers(action) {
    return action.bindings.memberBindings.map(
        ({ nodeId }) => nodeId
    )
}

function applyRemoteDelivery({
    action,
    repositories,
    issues,
    deliveryEffects
}) {
    const groupId = action.acceptanceGroup
    const existing = deliveryEffects[groupId]
    if (existing) return existing
    const members = deliveryMembers(action)
    const commits = {}
    const membersByRepository = Object.groupBy(
        members,
        (nodeId) => issues[nodeId].repository
    )
    for (const [repositoryName, repositoryMembers] of
        Object.entries(membersByRepository)) {
        const repository = Object.values(repositories).find(
            ({ repository: name }) => name === repositoryName
        )
        syncRepository(repository)
        for (const nodeId of repositoryMembers) {
            const issue = issues[nodeId]
            const relative =
                `delivered/issue-${issue.number}.txt`
            write(repository.work, relative, `${nodeId}\n`)
            runGit(['add', relative], repository.work)
            runGit(
                ['commit', '-m', `complete ${nodeId}`],
                repository.work
            )
            const commit = runGit(
                ['rev-parse', 'HEAD'],
                repository.work
            )
            commits[nodeId] = commit
            repository.deliveredCommits.push(commit)
        }
        runGit(['push', 'origin', 'HEAD:main'], repository.work)
        repository.pushCount += 1
        repository.baseSha = runGit(
            ['rev-parse', 'HEAD'],
            repository.work
        )
    }
    for (const nodeId of members) {
        issues[nodeId].state = 'CLOSED'
        issues[nodeId].stateReason = 'COMPLETED'
    }
    const effect = {
        effectId: localDigest({ groupId, commits }),
        commits
    }
    deliveryEffects[groupId] = effect
    return effect
}

function resultForAction({
    action,
    state,
    resourceRoot,
    failureNode,
    failureInjected,
    deliveryEffects,
    repositories,
    issues
}) {
    if (action.type === 'deliver-acceptance-group') {
        const effect = applyRemoteDelivery({
            action,
            repositories,
            issues,
            deliveryEffects
        })
        const pending = state.pendingDeliveryEffects[
            action.acceptanceGroup
        ]
        return compileScriptedLifecycleStageResult({
            action,
            actorRole: 'root-delivery-adapter',
            mode: pending
                ? 'completed'
                : 'remote-effect-applied',
            facts: effect
        })
    }
    const node = state.nodes[action.nodeId]
    if (action.type === 'dispatch-implementation-writer') {
        fs.mkdirSync(resourcePath(resourceRoot, node.id), {
            recursive: true
        })
        if (node.id === failureNode &&
            node.implementationAttempts === 0 &&
            !failureInjected.value) {
            failureInjected.value = true
            return compileScriptedLifecycleStageResult({
                action,
                node,
                actorRole: actorRole(action, node),
                mode: 'recoverable-failure',
                facts: {
                    failureCode:
                        'writer-stage.scripted-recoverable-failure'
                }
            })
        }
    }
    if (action.type === 'cleanup-node-resources') {
        fs.rmSync(resourcePath(resourceRoot, node.id), {
            recursive: true,
            force: true
        })
    }
    return compileScriptedLifecycleStageResult({
        action,
        node,
        actorRole: actorRole(action, node),
        mode: 'completed',
        facts: stageDecision(action, node)
    })
}

function injectExternalBaseChange({
    scenarioRoot,
    repository
}) {
    const external = path.resolve(
        scenarioRoot,
        `${repository.key}-external`
    )
    runGit(['clone', repository.bare, external], scenarioRoot)
    runGit(['config', 'user.name', 'external-base-actor'], external)
    runGit(['config', 'user.email', 'external@example.invalid'], external)
    write(
        external,
        'external-base-change.txt',
        'base changed before writer dispatch\n'
    )
    runGit(['add', 'external-base-change.txt'], external)
    runGit(['commit', '-m', 'external base change'], external)
    runGit(['push', 'origin', 'main'], external)
    repository.baseSha = runGit(['rev-parse', 'HEAD'], external)
    repository.pushCount += 1
    fs.rmSync(external, { recursive: true, force: true })
    return repository.baseSha
}

function persist(stateRoot, ledger) {
    persistLifecycleRunLedger({ stateRoot, ledger })
    return readLifecycleRunLedger({
        stateRoot,
        runId: RUN_ID
    })
}

export function runMultiRepositoryLifecycleAcceptance({
    scenarioRoot
} = {}) {
    const stateRoot = path.resolve(scenarioRoot, 'state')
    const resourceRoot = path.resolve(scenarioRoot, 'resources')
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.mkdirSync(resourceRoot, { recursive: true })
    const initialStateRootArtifactCount =
        fs.readdirSync(stateRoot).length
    if (initialStateRootArtifactCount !== 0) {
        fail('multi-repository-e2e-initial-state-not-empty')
    }

    const repositories = {
        RepoA: initRepository(scenarioRoot, 'RepoA'),
        RepoB: initRepository(scenarioRoot, 'RepoB')
    }
    const issueA = rawIssue(repositories.RepoA.repository, 1, {
        group: GROUP
    })
    const issueAId = issueId(issueA)
    const issueB = rawIssue(repositories.RepoA.repository, 2, {
        dependsOn: [issueAId]
    })
    const issueC = rawIssue(repositories.RepoB.repository, 3, {
        ui: true,
        group: GROUP
    })
    const issueD = rawIssue(repositories.RepoB.repository, 4)
    const issues = Object.fromEntries(
        [issueA, issueB, issueC, issueD].map((issue) => [
            issueId(issue), issue
        ])
    )
    const startup = runtimeStartup()
    let selectorVersion = 1
    let selectorReceipt = resolveCurrentSelector({
        issues,
        version: selectorVersion,
        startup
    })
    const policyDigest = digest('issue-25-installed-policy')
    const semanticGraph = initialSemanticGraph({
        selectorReceipt,
        repositories,
        issues,
        policyDigest
    })
    let ledger = createLifecycleRunLedger({
        stateRoot,
        runId: RUN_ID,
        createdAt: CREATED_AT,
        selectorReceipt,
        semanticGraph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        runtimeCapabilityBinding: {
            schema:
                'issue-orchestration.runtime-capability-binding.v1',
            status: 'verified',
            bindingDigest: digest({
                maxConcurrentThreadsPerSession: 2,
                multiAgentV2: true
            })
        },
        slotCapacity: 2
    })
    ledger = persist(stateRoot, ledger)

    const actionSetDigests = []
    let actionCount = 0
    let maximumConcurrentActions = 0
    const deliveryEffects = {}
    const failureInjected = { value: false }
    let authorizedRetryCount = 0
    let commentRefreshAffectedOnlyOneNode = false
    let baseRebindingVerified = false
    let serializeReloadReplayVerified = false
    let deliveryRetryWasIdempotent = false
    let dependencyBlockedUntilClosure = true
    let dependencySelectedAfterClosure = false
    let commentInjected = false
    let baseInjected = false
    let loopCount = 0

    while (loopCount < 200) {
        loopCount += 1
        const projected = projectLifecycleRun(ledger)
        let actionSet = compileLifecycleRunActionSet(ledger)
        actionSetDigests.push(actionSet.actionSetDigest)
        maximumConcurrentActions = Math.max(
            maximumConcurrentActions,
            actionSet.actions.filter(
                ({ type }) => type !== 'idle'
            ).length
        )

        const dependentId = issueId(issueB)
        const prerequisiteClosed =
            projected.state.nodes[issueAId].lifecycleState ===
            'closed'
        if (actionSet.actions.some(
            ({ nodeId }) => nodeId === dependentId
        )) {
            if (!prerequisiteClosed) {
                dependencyBlockedUntilClosure = false
            } else {
                dependencySelectedAfterClosure = true
            }
        }

        if (actionSet.quiescent) break

        const commentTarget = issueId(issueD)
        if (!commentInjected &&
            actionSet.actions.some((action) =>
                action.nodeId === commentTarget &&
                action.type ===
                    'request-test-contract-planning')) {
            const unaffectedBefore = Object.fromEntries(
                Object.entries(projected.state.nodes)
                    .filter(([nodeId]) => nodeId !== commentTarget)
                    .map(([nodeId, node]) => [
                        nodeId, digest({
                            lifecycleState: node.lifecycleState,
                            receipts: node.receipts,
                            chainVersion: node.chainVersion
                        })
                    ])
            )
            issues[commentTarget].comments.push({
                id: 'relevant-comment-drift',
                body:
                    'The implementation must retain deterministic replay.',
                updatedAt: '2026-08-04T00:20:00.000Z',
                relevant: true,
                relevantToCorrectness: true
            })
            issues[commentTarget].updatedAt =
                '2026-08-04T00:20:00.000Z'
            selectorVersion += 1
            const refreshedSelector = resolveCurrentSelector({
                issues,
                version: selectorVersion,
                startup,
                previousReceipt: selectorReceipt
            })
            const refreshActionSet =
                compileLifecycleRunActionSet(ledger, {
                    observedSelectorReceipt: refreshedSelector
                })
            if (refreshActionSet.actions.length !== 1 ||
                refreshActionSet.actions[0].type !==
                    'refresh-scope') {
                fail('multi-repository-e2e-refresh-not-prioritized')
            }
            ledger = recordLifecycleScopeRefresh({
                ledger,
                actionSet: refreshActionSet,
                selectorReceipt: refreshedSelector,
                createdAt:
                    '2026-08-04T00:20:01.000Z'
            })
            selectorReceipt = refreshedSelector
            ledger = persist(stateRoot, ledger)
            const after = projectLifecycleRun(ledger)
            const unaffectedAfter = Object.fromEntries(
                Object.entries(after.state.nodes)
                    .filter(([nodeId]) => nodeId !== commentTarget)
                    .map(([nodeId, node]) => [
                        nodeId, digest({
                            lifecycleState: node.lifecycleState,
                            receipts: node.receipts,
                            chainVersion: node.chainVersion
                        })
                    ])
            )
            commentRefreshAffectedOnlyOneNode =
                JSON.stringify(unaffectedBefore) ===
                JSON.stringify(unaffectedAfter) &&
                after.state.nodes[commentTarget]
                    .lifecycleState === 'none'
            commentInjected = true
            continue
        }

        const baseTarget = issueId(issueB)
        if (!baseInjected &&
            actionSet.actions.some((action) =>
                action.nodeId === baseTarget &&
                action.type ===
                    'dispatch-test-contract-writer')) {
            const newBase = injectExternalBaseChange({
                scenarioRoot,
                repository: repositories.RepoA
            })
            ledger = recordLifecycleBaseChange({
                ledger,
                repository: repositories.RepoA.repository,
                baseSha: newBase,
                createdAt:
                    '2026-08-04T00:30:00.000Z'
            })
            try {
                const staleResults = actionSet.actions.map(
                    (action) => resultForAction({
                        action,
                        state: projected.state,
                        resourceRoot,
                        failureNode: issueId(issueD),
                        failureInjected,
                        deliveryEffects,
                        repositories,
                        issues
                    })
                )
                recordLifecycleActionResults({
                    ledger,
                    actionSet,
                    stageResults: staleResults,
                    createdAt:
                        '2026-08-04T00:30:01.000Z'
                })
                fail('multi-repository-e2e-stale-dispatch-accepted')
            } catch (error) {
                if (error?.code !== 'lifecycle-action-set-stale') {
                    throw error
                }
            }
            ledger = persist(stateRoot, ledger)
            baseRebindingVerified = true
            baseInjected = true
            continue
        }

        if (!serializeReloadReplayVerified &&
            actionCount >= 10) {
            const beforeAction =
                compileLifecycleRunActionSet(ledger)
            const beforeProjection =
                projectLifecycleRun(ledger)
                    .aggregateProjection
                    .aggregateProjectionDigest
            ledger = readLifecycleRunLedger({
                stateRoot,
                runId: RUN_ID
            })
            const afterAction =
                compileLifecycleRunActionSet(ledger)
            const afterProjection =
                projectLifecycleRun(ledger)
                    .aggregateProjection
                    .aggregateProjectionDigest
            serializeReloadReplayVerified =
                beforeAction.actionSetDigest ===
                    afterAction.actionSetDigest &&
                beforeProjection === afterProjection
        }

        const state = projectLifecycleRun(ledger).state
        const stageResults = actionSet.actions.map(
            (action) => resultForAction({
                action,
                state,
                resourceRoot,
                failureNode: issueId(issueD),
                failureInjected,
                deliveryEffects,
                repositories,
                issues
            })
        )
        for (const [index, result] of stageResults.entries()) {
            if (result.artifacts.writerFailure) {
                authorizedRetryCount += 1
            }
            const action = actionSet.actions[index]
            if (action.recoveryMode ===
                'authorized-continuation' &&
                !result.artifacts.writerFailure) {
                if (!failureInjected.value) {
                    fail('multi-repository-e2e-retry-without-failure')
                }
            }
        }
        const remoteEffectsBefore = Object.fromEntries(
            Object.entries(deliveryEffects).map(([key, value]) => [
                key, {
                    effectId: value.effectId,
                    commits: { ...value.commits },
                    pushes: Object.fromEntries(
                        Object.entries(repositories).map(
                            ([repoKey, repository]) => [
                                repoKey, repository.pushCount
                            ]
                        )
                    )
                }
            ])
        )
        ledger = recordLifecycleActionResults({
            ledger,
            actionSet,
            stageResults,
            createdAt:
                `2026-08-04T01:${String(loopCount).padStart(2, '0')}:00.000Z`
        })
        actionCount += actionSet.actions.length
        ledger = persist(stateRoot, ledger)
        for (const [groupId, before] of
            Object.entries(remoteEffectsBefore)) {
            const after = deliveryEffects[groupId]
            if (after &&
                before.effectId === after.effectId &&
                JSON.stringify(before.commits) ===
                    JSON.stringify(after.commits)) {
                const pushesAfter = Object.fromEntries(
                    Object.entries(repositories).map(
                        ([repoKey, repository]) => [
                            repoKey, repository.pushCount
                        ]
                    )
                )
                if (JSON.stringify(before.pushes) ===
                    JSON.stringify(pushesAfter)) {
                    deliveryRetryWasIdempotent = true
                }
            }
        }
    }

    const finalActionSet = compileLifecycleRunActionSet(ledger)
    const final = projectLifecycleRun(ledger)
    if (!finalActionSet.quiescent ||
        !dependencySelectedAfterClosure ||
        Object.values(final.state.nodes).some(
            ({ lifecycleState }) => lifecycleState !== 'closed'
        )) {
        fail('multi-repository-e2e-not-quiescent')
    }
    if (!commentRefreshAffectedOnlyOneNode ||
        !baseRebindingVerified ||
        !serializeReloadReplayVerified ||
        !deliveryRetryWasIdempotent ||
        authorizedRetryCount !== 1 ||
        !dependencyBlockedUntilClosure) {
        fail('multi-repository-e2e-disturbance-unverified')
    }

    const repositoryEvidence = Object.values(repositories).map(
        (repository) => ({
            repository: repository.repository,
            defaultBranch: 'main',
            remoteHead: runGit(
                ['rev-parse', 'refs/heads/main'],
                repository.bare
            ),
            deliveredCommits:
                [...repository.deliveredCommits],
            pushCount: repository.pushCount
        })
    )
    for (const repository of repositoryEvidence) {
        for (const commit of repository.deliveredCommits) {
            runGit(
                ['merge-base', '--is-ancestor',
                    commit, 'refs/heads/main'],
                Object.values(repositories).find(
                    ({ repository: name }) =>
                        name === repository.repository
                ).bare
            )
        }
    }

    const finalNodes = final.state.nodes
    const receipt = {
        schema: RECEIPT_SCHEMA,
        status: 'verified',
        runId: RUN_ID,
        initialStateRootArtifactCount,
        repositoryEvidence,
        issueEvidence: Object.values(issues).map(
            (issue) => ({
                issue: issueId(issue),
                state: issue.state,
                stateReason: issue.stateReason
            })
        ),
        nodeEvidence: Object.values(finalNodes).map(
            (node) => ({
                nodeId: node.id,
                lifecycleState: node.lifecycleState,
                implementationAttempts:
                    node.implementationAttempts,
                deliveryCommit: node.deliveryCommit,
                cleanupReceiptDigest:
                    node.receipts.cleanup.receiptDigest
            })
        ),
        actionSetDigests,
        actionCount,
        maximumConcurrentActions,
        dependencyBlockedUntilClosure,
        uiAdjudicationVerified:
            Object.values(finalNodes)
                .filter(({ uiClass }) => uiClass === 'ui')
                .every(({ receipts }) =>
                    Boolean(receipts.uiAdjudication)),
        uxAcceptanceVerified:
            Object.values(finalNodes)
                .filter(({ uiClass }) => uiClass === 'ui')
                .every(({ receipts }) =>
                    Boolean(receipts.uxAcceptance)),
        documentationVerifiedForEveryNode:
            Object.values(finalNodes).every(
                ({ receipts }) => Boolean(receipts.documentation)
            ),
        commentRefreshAffectedOnlyOneNode,
        baseRebindingVerified,
        authorizedRetryCount,
        serializeReloadReplayVerified,
        deliveryRetryWasIdempotent,
        acceptanceGroupMemberCount:
            final.semanticGraph.nodes.filter(
                ({ acceptanceGroup }) =>
                    acceptanceGroup === GROUP
            ).length,
        activeAttemptCount: Object.values(
            final.aggregateProjection.nodes
        ).filter(({ activeAttemptId }) =>
            activeAttemptId !== null).length,
        activeLeaseCount: 0,
        residualWorktreeCount: 0,
        residualBranchCount: 0,
        residualTemporaryResourceCount:
            fs.readdirSync(resourceRoot).length,
        networkInvocationCount: 0,
        paidModelInvocationCount: 0,
        quiescent: true
    }
    receipt.receiptDigest = digest(receipt)
    return Object.freeze(receipt)
}
