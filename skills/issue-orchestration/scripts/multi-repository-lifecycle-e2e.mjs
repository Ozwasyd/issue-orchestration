import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { digest } from './runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from './semantic-runtime-projection.mjs'
import {
    compileLifecycleActionSet,
    compileLifecycleRemoteSnapshotReceipt,
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    remoteIssueFactDigest,
    verifySelectorReceipt
} from './scope-selector.mjs'

const RECEIPT_SCHEMA =
    'issue-orchestration.multi-repository-lifecycle-e2e-receipt.v1'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const GROUP = 'acceptance-group-alpha'
const RUN_ID = 'multi-repository-lifecycle-e2e'
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

function selectorCanonical(value) {
    if (Array.isArray(value)) {
        return value.map(selectorCanonical).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(
        (key) => [key, selectorCanonical(value[key])]
    ))
}

function selectorDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(selectorCanonical(value)))
        .digest('hex')
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
    runGit(['init', '--bare', '--initial-branch=main', bare], scenarioRoot)
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
        updatedAt: CREATED_AT,
        title: ui
            ? `UI lifecycle issue ${number}`
            : `Lifecycle issue ${number}`,
        body: [
            `Implement issue ${number} through the complete verified lifecycle.`,
            'Tests, implementation, independent verification, documentation,',
            'delivery, cleanup, and completed closure are required.'
        ].join(' '),
        comments: [],
        labels: ui ? ['ui', 'acceptance'] : ['code', 'acceptance'],
        milestone: null,
        dependsOn,
        ui,
        group
    }
}

function nodeRecord(issue, repositoryKey) {
    const id = `${issue.repository}#${issue.number}`
    return {
        id,
        repositoryKey,
        issueNumber: issue.number,
        uiClass: issue.ui ? 'ui' : 'non-ui',
        acceptanceGroup: issue.group,
        dependencyKeys: [...issue.dependsOn],
        lifecycleState: 'none',
        chainVersion: 1,
        ledgerSequence: 0,
        receipts: {},
        implementationAttempts: 0,
        deliveryCommit: null,
        closedAtSequence: null
    }
}

function sealReceipt(kind, node, extra = {}) {
    const value = {
        schema: `issue-orchestration.${kind}.v1`,
        status: 'verified',
        producerAuthority: 'deterministic-scripted-stage-boundary',
        rootAuthored: false,
        nodeId: node.id,
        chainVersion: node.chainVersion,
        ...extra
    }
    value.receiptDigest = digest(value)
    return Object.freeze(value)
}

function compileSelector(runtime, previous = runtime.selectorReceipt ?? null) {
    const issues = Object.values(runtime.issues)
    const resolvedIssueSet = issues.map(
        (issue) => `${issue.repository}#${issue.number}`
    ).sort()
    const remoteFactDigests = Object.fromEntries(resolvedIssueSet.map((id) => [
        id,
        remoteIssueFactDigest(runtime.issues[id])
    ]))
    const selector = {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: `e2e-selector-${runtime.selectorVersion}`,
        type: 'explicit-issues',
        repositories: Object.values(runtime.repositories)
            .map(({ repository }) => repository).sort(),
        parameters: { issueIds: resolvedIssueSet },
        remoteQueryIdentity: 'local-bare-remotes:explicit-issues'
    }
    const selectorHash = selectorDigest({
        ...selector,
        repositories: [...selector.repositories].sort(),
        parameters: selectorCanonical(selector.parameters)
    })
    const remoteSnapshotDigest = selectorDigest({
        selectorDigest: selectorHash,
        resolvedIssueSet,
        remoteFactDigests
    })
    const previousSet = new Set(previous?.resolvedIssueSet ?? [])
    const changed = resolvedIssueSet.filter((id) =>
        previousSet.has(id) &&
        previous.remoteFactDigests?.[id] !== remoteFactDigests[id]
    )
    const added = resolvedIssueSet.filter((id) => !previousSet.has(id))
    const receipt = {
        schema: 'issue-orchestration.selector-receipt.v1',
        startupAttestationDigest: digest('e2e-startup-attestation'),
        runtimeInvocationId: 'e2e-runtime-invocation',
        runtimeSessionId: 'e2e-runtime-session',
        selectorVersion: selector.selectorVersion,
        type: selector.type,
        parametersDigest: selectorDigest(selector.parameters),
        selectorDigest: selectorHash,
        resolvedIssueSet,
        exclusionReasons: {},
        remoteQueryIdentity: selector.remoteQueryIdentity,
        previousRemoteSnapshotDigest:
            previous?.remoteSnapshotDigest ?? null,
        remoteSnapshotDigest,
        remoteFactDigests,
        remoteChangeSet: {
            added,
            changed,
            closed: changed.filter((id) =>
                runtime.issues[id].state === 'CLOSED'
            ),
            removed: [],
            reopened: []
        },
        issueHistory: {},
        issueStates: Object.fromEntries(resolvedIssueSet.map((id) => [
            id,
            runtime.issues[id].state
        ])),
        resolvedAt: `2026-08-04T00:00:${String(
            runtime.selectorVersion
        ).padStart(2, '0')}.000Z`
    }
    receipt.receiptDigest = selectorDigest(receipt)
    runtime.selectorReceipt = verifySelectorReceipt(receipt)
    runtime.remoteSnapshotReceipt =
        compileLifecycleRemoteSnapshotReceipt(runtime.selectorReceipt)
}

function initializeBindings(runtime) {
    runtime.graphBindings = {
        selectorReceiptDigest: runtime.selectorReceipt.receiptDigest,
        remoteSnapshotDigest:
            runtime.remoteSnapshotReceipt.receiptDigest,
        remoteFactDigests:
            structuredClone(runtime.selectorReceipt.remoteFactDigests)
    }
}

function repositoryBinding(runtime, repositoryKey) {
    const repository = runtime.repositories[repositoryKey]
    return {
        repository: repository.repository,
        baseSha: repository.baseSha,
        bindingDigest: digest({
            repository: repository.repository,
            bare: path.basename(repository.bare),
            baseSha: repository.baseSha
        })
    }
}

function graphNode(runtime, node) {
    const repository = runtime.repositories[node.repositoryKey]
    return {
        id: node.id,
        memberId: node.id,
        repository: repository.repository,
        issueNumber: node.issueNumber,
        owner: 'dag-creator-updater',
        dependencyKeys: [...node.dependencyKeys],
        conflictKeys: [],
        riskClass: node.uiClass === 'ui' ? 'high-risk' : 'bounded',
        uiClass: node.uiClass,
        acceptanceGroup: node.acceptanceGroup,
        lifecycleState: node.lifecycleState,
        selectorReceiptDigest:
            runtime.graphBindings.selectorReceiptDigest,
        remoteSnapshotDigest:
            runtime.graphBindings.remoteSnapshotDigest,
        repositoryBindingDigest:
            repositoryBinding(runtime, node.repositoryKey).bindingDigest,
        semanticFactsDigest: digest({
            issue: runtime.issues[node.id],
            chainVersion: node.chainVersion
        }),
        receipts: structuredClone(node.receipts)
    }
}

function buildSemanticGraph(runtime) {
    return createSemanticGraph({
        selectorReceiptDigest:
            runtime.graphBindings.selectorReceiptDigest,
        remoteSnapshotDigest:
            runtime.graphBindings.remoteSnapshotDigest,
        scopeDigest: digest({
            issueIds: Object.keys(runtime.nodes).sort()
        }),
        semanticGraphInputDigest: digest({
            remoteFactDigests:
                runtime.graphBindings.remoteFactDigests,
            chainVersions: Object.fromEntries(
                Object.values(runtime.nodes).map((node) => [
                    node.id,
                    node.chainVersion
                ])
            )
        }),
        policyDigest: runtime.policyDigest,
        repositories: Object.keys(runtime.repositories).sort().map(
            (key) => repositoryBinding(runtime, key)
        ),
        nodes: Object.values(runtime.nodes).map(
            (node) => graphNode(runtime, node)
        )
    })
}

function aggregateNode(runtime, node) {
    const blockedBy = node.dependencyKeys.filter(
        (id) => runtime.nodes[id]?.lifecycleState !== 'closed'
    )
    return {
        nodeId: node.id,
        memberId: node.id,
        repository: runtime.repositories[node.repositoryKey].repository,
        issueNumber: node.issueNumber,
        selectorReceiptDigest:
            runtime.graphBindings.selectorReceiptDigest,
        remoteMemberDigest:
            runtime.graphBindings.remoteFactDigests[node.id],
        nodeEpoch: node.chainVersion,
        baseSha: runtime.repositories[node.repositoryKey].baseSha,
        dependencyKeys: [...node.dependencyKeys],
        acceptanceGroup: node.acceptanceGroup,
        status: node.lifecycleState === 'closed' ? 'closed' : 'active',
        ledgerHeadDigest: digest({
            nodeId: node.id,
            sequence: node.ledgerSequence,
            receipts: node.receipts
        }),
        nodeProjectionDigest: digest({
            nodeId: node.id,
            lifecycleState: node.lifecycleState,
            blockedBy,
            chainVersion: node.chainVersion,
            receipts: node.receipts
        }),
        lifecycleState: node.lifecycleState,
        activeAttemptId: null,
        candidateGreen: [
            'candidate-green', 'independent-verifying',
            'behavior-green', 'ux-accepted', 'documenting',
            'delivery-ready', 'cleaning', 'closed'
        ].includes(node.lifecycleState),
        deliveryComplete: ['cleaning', 'closed'].includes(
            node.lifecycleState
        ),
        dispatchable: blockedBy.length === 0,
        blockedBy,
        quarantine: null
    }
}

function buildAggregateProjection(runtime) {
    const projection = {
        schema: 'issue-orchestration.aggregate-runtime-projection.v1',
        runId: RUN_ID,
        controlProjectionDigest: digest({
            actionCount: runtime.actionLog.length,
            deliveryEffects: runtime.deliveryEffects
        }),
        nodeIndexDigest: digest(
            Object.keys(runtime.nodes).sort()
        ),
        nodes: Object.fromEntries(Object.values(runtime.nodes).map(
            (node) => [node.id, aggregateNode(runtime, node)]
        )),
        acceptanceGroups: {
            [GROUP]: runtime.groupMembers[GROUP]
        },
        slots: { capacity: 2, active: [] },
        deliveryFreezes: {},
        deliveryEffects: structuredClone(runtime.deliveryEffects),
        cleanupFinalizations: structuredClone(
            runtime.cleanupFinalizations
        ),
        terminal: null
    }
    projection.aggregateProjectionDigest = digest(projection)
    return projection
}

function compilerInput(runtime) {
    return {
        schema: 'issue-orchestration.lifecycle-compiler-input.v1',
        selectorReceipt: runtime.selectorReceipt,
        remoteSnapshotReceipt: runtime.remoteSnapshotReceipt,
        semanticGraph: buildSemanticGraph(runtime),
        aggregateProjection: buildAggregateProjection(runtime),
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest: runtime.policyDigest
        },
        runtimeCapabilityBinding: {
            schema:
                'issue-orchestration.runtime-capability-binding.v1',
            status: 'verified',
            bindingDigest: runtime.capabilityDigest
        }
    }
}

function compile(runtime) {
    const input = compilerInput(runtime)
    const first = compileLifecycleActionSet(input)
    const second = compileLifecycleActionSet(
        JSON.parse(JSON.stringify(input))
    )
    if (JSON.stringify(first) !== JSON.stringify(second)) {
        fail('multi-repository-e2e-nondeterministic-action-set')
    }
    validateLifecycleActionSet(first)
    runtime.actionSetDigests.push(first.actionSetDigest)
    runtime.maximumConcurrentActions = Math.max(
        runtime.maximumConcurrentActions,
        first.actions.filter(({ type }) => type !== 'idle').length
    )
    return first
}

function incrementLedger(node) {
    node.ledgerSequence += 1
}

function recordSemantic(runtime, node) {
    node.receipts.semanticProposal = sealReceipt(
        'semantic-proposal-receipt',
        node,
        {
            sourceFactDigest:
                runtime.selectorReceipt.remoteFactDigests[node.id]
        }
    )
    node.lifecycleState = 'discovered'
    incrementLedger(node)
}

function recordAcceptance(runtime, node) {
    node.receipts.acceptanceContract = sealReceipt(
        'issue-acceptance-contract',
        node,
        {
            sourceFactDigest:
                runtime.selectorReceipt.remoteFactDigests[node.id],
            requirementInventoryDigest: digest({
                title: runtime.issues[node.id].title,
                body: runtime.issues[node.id].body,
                comments: runtime.issues[node.id].comments
            })
        }
    )
    node.receipts.documentationRequired = true
    node.lifecycleState = 'acceptance-frozen'
    incrementLedger(node)
}

function recordPlanning(runtime, node) {
    const common = {
        acceptanceContractDigest:
            node.receipts.acceptanceContract.receiptDigest,
        baseSha: runtime.repositories[node.repositoryKey].baseSha
    }
    node.receipts.testContractPlan = sealReceipt(
        'test-contract-plan-receipt',
        node,
        common
    )
    node.receipts.workPlan = {
        schema: 'issue-orchestration.stage-work-plan.v1',
        workPlanDigest: digest({
            nodeId: node.id,
            chainVersion: node.chainVersion,
            ...common
        })
    }
    node.receipts.executableSlice = {
        schema: 'issue-orchestration.executable-slice.v1',
        sliceDigest: digest({
            nodeId: node.id,
            stage: 'test-contract',
            ...common
        })
    }
    node.receipts.compiledPrompt = {
        schema:
            'issue-orchestration.compiled-dispatch-prompt.v1',
        promptDigest: digest({
            nodeId: node.id,
            firstRequiredAction: 'write failing contract tests',
            ...common
        })
    }
    node.receipts.resourceAcquisition = sealReceipt(
        'writer-resource-acquisition-receipt',
        node,
        {
            leaseId: `lease:${node.id}:${node.chainVersion}`,
            ...common
        }
    )
    node.receipts.routeBinding = sealReceipt(
        'stage-route-binding-receipt',
        node,
        {
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            ...common
        }
    )
    node.lifecycleState = 'test-contracting'
    incrementLedger(node)
    runtime.planningCount[node.id] =
        (runtime.planningCount[node.id] ?? 0) + 1
}

function clearDownstreamChain(node) {
    for (const key of [
        'acceptanceContract', 'testContractPlan', 'workPlan',
        'executableSlice', 'compiledPrompt', 'resourceAcquisition',
        'routeBinding', 'testContractWriter', 'implementation',
        'behaviorVerification', 'uiAdjudication', 'uxAcceptance',
        'documentation'
    ]) delete node.receipts[key]
    node.receipts.documentationRequired = true
}

function clearPlanningChain(node) {
    for (const key of [
        'testContractPlan', 'workPlan', 'executableSlice',
        'compiledPrompt', 'resourceAcquisition', 'routeBinding',
        'testContractWriter', 'implementation',
        'behaviorVerification', 'uiAdjudication', 'uxAcceptance',
        'documentation'
    ]) delete node.receipts[key]
    node.receipts.documentationRequired = true
}

function refreshScope(runtime) {
    const changed = Object.keys(
        runtime.selectorReceipt.remoteFactDigests
    ).filter((id) =>
        runtime.graphBindings.remoteFactDigests[id] !==
        runtime.selectorReceipt.remoteFactDigests[id]
    )
    if (changed.length === 0) {
        fail('multi-repository-e2e-refresh-without-drift')
    }
    runtime.refreshEvidence.push({
        changed: [...changed],
        unaffectedBefore: Object.fromEntries(
            Object.values(runtime.nodes)
                .filter(({ id }) => !changed.includes(id))
                .map((node) => [
                    node.id,
                    node.receipts.acceptanceContract?.receiptDigest ?? null
                ])
        )
    })
    for (const id of changed) {
        const node = runtime.nodes[id]
        node.chainVersion += 1
        clearDownstreamChain(node)
        node.lifecycleState = 'discovered'
        incrementLedger(node)
    }
    initializeBindings(runtime)
    const evidence = runtime.refreshEvidence.at(-1)
    evidence.unaffectedAfter = Object.fromEntries(
        Object.values(runtime.nodes)
            .filter(({ id }) => !changed.includes(id))
            .map((node) => [
                node.id,
                node.receipts.acceptanceContract?.receiptDigest ?? null
            ])
    )
    if (JSON.stringify(evidence.unaffectedBefore) !==
        JSON.stringify(evidence.unaffectedAfter)) {
        fail('multi-repository-e2e-refresh-overinvalidated')
    }
}

function recordTestContract(node) {
    node.receipts.testContractWriter = sealReceipt(
        'test-contract-writer-terminal-receipt',
        node,
        {
            testsWritten: true,
            testCommandObserved: true
        }
    )
    node.lifecycleState = 'test-contract-frozen'
    incrementLedger(node)
}

function resourcePath(runtime, node) {
    return path.resolve(runtime.resourceRoot,
        node.id.replaceAll('/', '_').replaceAll('#', '_'))
}

function recordImplementation(runtime, node, action) {
    node.implementationAttempts += 1
    fs.mkdirSync(resourcePath(runtime, node), { recursive: true })
    if (node.id === runtime.disturbances.writerFailureNode &&
        node.implementationAttempts === 1) {
        node.receipts.writerFailure = sealReceipt(
            'writer-stage-failure-receipt',
            node,
            {
                category: 'recoverable-scripted-failure',
                attempt: 1
            }
        )
        node.receipts.retryAuthorization = sealReceipt(
            'writer-stage-retry-authorization',
            node,
            {
                authorizedAttempt: 2,
                sameContract: true
            }
        )
        node.lifecycleState = 'implementing-self-testing'
        runtime.disturbances.writerFailureObserved = true
        incrementLedger(node)
        return
    }
    if (node.implementationAttempts > 1 &&
        action.recoveryMode !== 'authorized-continuation') {
        fail('multi-repository-e2e-unauthorized-retry')
    }
    node.receipts.implementation = sealReceipt(
        'implementation-terminal-receipt',
        node,
        {
            attempt: node.implementationAttempts,
            candidateDigest: digest({
                nodeId: node.id,
                chainVersion: node.chainVersion,
                attempt: node.implementationAttempts
            })
        }
    )
    node.lifecycleState = 'candidate-green'
    incrementLedger(node)
}

function recordBehavior(node) {
    node.receipts.behaviorVerification = sealReceipt(
        'behavior-verification-receipt',
        node,
        {
            independent: true,
            freshContext: true,
            candidateDigest:
                node.receipts.implementation.receiptDigest
        }
    )
    node.lifecycleState = 'behavior-green'
    incrementLedger(node)
}

function recordUiAdjudication(node) {
    node.receipts.uiAdjudication = sealReceipt(
        'ui-adjudication-receipt',
        node,
        { decision: 'bounded-ui-contract-confirmed' }
    )
    incrementLedger(node)
}

function recordUxAcceptance(node) {
    node.receipts.uxAcceptance = sealReceipt(
        'ux-acceptance-receipt',
        node,
        {
            independent: true,
            renderEvidenceObserved: true
        }
    )
    node.lifecycleState = 'behavior-green'
    incrementLedger(node)
}

function recordDocumentation(node) {
    node.receipts.documentation = sealReceipt(
        'documentation-terminal-receipt',
        node,
        {
            documentationVerified: true,
            noChangeReason: 'scenario issue documentation recorded'
        }
    )
    node.lifecycleState = 'delivery-ready'
    incrementLedger(node)
}

function syncRepositoryForDelivery(repository) {
    runGit(['fetch', 'origin', 'main'], repository.work)
    runGit(['reset', '--hard', 'origin/main'], repository.work)
}

function applyRemoteDelivery(runtime, groupId, members) {
    const existing = runtime.remoteDeliveryEffects[groupId]
    if (existing?.applied) return existing
    const grouped = Object.groupBy(members, (node) => node.repositoryKey)
    const commits = {}
    for (const [repositoryKey, repositoryMembers] of
        Object.entries(grouped)) {
        const repository = runtime.repositories[repositoryKey]
        syncRepositoryForDelivery(repository)
        for (const node of repositoryMembers) {
            const relative =
                `delivered/issue-${node.issueNumber}.txt`
            write(repository.work, relative,
                `${node.id}\n${node.receipts.documentation.receiptDigest}\n`)
            runGit(['add', relative], repository.work)
            runGit([
                'commit', '-m',
                `complete ${node.id}`
            ], repository.work)
            const commit = runGit(['rev-parse', 'HEAD'], repository.work)
            commits[node.id] = commit
            repository.deliveredCommits.push(commit)
        }
        runGit(['push', 'origin', 'HEAD:main'], repository.work)
        repository.pushCount += 1
        repository.baseSha =
            runGit(['rev-parse', 'HEAD'], repository.work)
    }
    for (const node of members) {
        const issue = runtime.issues[node.id]
        issue.state = 'CLOSED'
        issue.stateReason = 'COMPLETED'
        issue.updatedAt = `2026-08-04T01:00:${
            String(runtime.actionSequence).padStart(2, '0')
        }.000Z`
    }
    const effect = {
        applied: true,
        commits,
        pushCountAfter: Object.fromEntries(
            Object.entries(runtime.repositories).map(([key, value]) => [
                key, value.pushCount
            ])
        )
    }
    runtime.remoteDeliveryEffects[groupId] = effect
    return effect
}

function finalizeDelivery(runtime, groupId, members, remoteEffect) {
    if (runtime.deliveryEffects[groupId]) {
        fail('multi-repository-e2e-duplicate-local-delivery')
    }
    runtime.deliveryEffects[groupId] = {
        status: 'completed',
        remoteEffectDigest: digest(remoteEffect)
    }
    for (const node of members) {
        node.deliveryCommit = remoteEffect.commits[node.id]
        node.receipts.delivery = sealReceipt(
            'delivery-completion-receipt',
            node,
            {
                commit: node.deliveryCommit,
                groupId
            }
        )
        node.lifecycleState = 'cleaning'
        incrementLedger(node)
    }
}

function deliver(runtime, action) {
    const groupId = action.acceptanceGroup
    const memberIds = groupId === GROUP
        ? runtime.groupMembers[GROUP]
        : [groupId.replace(/^node:/u, '')]
    const members = memberIds.map((id) => runtime.nodes[id])
    const remoteEffect = applyRemoteDelivery(runtime, groupId, members)
    if (groupId === GROUP &&
        !runtime.disturbances.deliveryRetryInjected) {
        runtime.disturbances.deliveryRetryInjected = true
        runtime.disturbances.deliveryRemoteSucceededBeforeReceipt = true
        return
    }
    finalizeDelivery(runtime, groupId, members, remoteEffect)
}

function cleanup(runtime, node) {
    fs.rmSync(resourcePath(runtime, node), {
        recursive: true,
        force: true
    })
    node.receipts.cleanup = sealReceipt(
        'resource-cleanup-receipt',
        node,
        { residueCount: 0 }
    )
    node.lifecycleState = 'closed'
    node.closedAtSequence = runtime.actionSequence
    runtime.cleanupFinalizations[node.id] = {
        status: 'completed',
        receiptDigest: node.receipts.cleanup.receiptDigest
    }
    incrementLedger(node)
}

function externalBaseChange(runtime, node) {
    const repository = runtime.repositories[node.repositoryKey]
    const external = path.resolve(runtime.scenarioRoot,
        `${repository.key}-external`)
    runGit(['clone', repository.bare, external], runtime.scenarioRoot)
    runGit(['config', 'user.name', 'external-base-actor'], external)
    runGit(['config', 'user.email', 'external@example.invalid'], external)
    write(external, 'external-base-change.txt',
        'base changed before writer dispatch\n')
    runGit(['add', 'external-base-change.txt'], external)
    runGit(['commit', '-m', 'external base change'], external)
    runGit(['push', 'origin', 'main'], external)
    repository.baseSha = runGit(['rev-parse', 'HEAD'], external)
    repository.pushCount += 1
    fs.rmSync(external, { recursive: true, force: true })
    node.chainVersion += 1
    clearPlanningChain(node)
    node.lifecycleState = 'acceptance-frozen'
    runtime.disturbances.baseChangeInjected = true
    runtime.disturbances.staleWriterDispatchPrevented = true
    incrementLedger(node)
}

function injectPendingDisturbances(runtime) {
    const baseNode = runtime.nodes[runtime.disturbances.baseChangeNode]
    if (!runtime.disturbances.baseChangeInjected &&
        baseNode.lifecycleState === 'test-contracting') {
        externalBaseChange(runtime, baseNode)
    }
}

function maybeInjectCommentDrift(runtime, node) {
    if (runtime.disturbances.commentChangeInjected ||
        node.id !== runtime.disturbances.commentChangeNode ||
        runtime.planningCount[node.id] !== 1) {
        return
    }
    runtime.issues[node.id].comments.push({
        id: 'relevant-comment-drift',
        body: 'The implementation must retain deterministic replay.',
        updatedAt: '2026-08-04T00:10:00.000Z',
        relevant: true,
        relevantToCorrectness: true
    })
    runtime.issues[node.id].updatedAt =
        '2026-08-04T00:10:00.000Z'
    runtime.selectorVersion += 1
    compileSelector(runtime)
    runtime.disturbances.commentChangeInjected = true
}

function serializeReload(runtime) {
    const before = compile(runtime)
    const serialized = JSON.stringify(runtime)
    const snapshotPath = path.resolve(
        runtime.stateRoot, 'runtime-snapshot.json'
    )
    fs.writeFileSync(snapshotPath, serialized)
    const restored = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    fs.rmSync(snapshotPath)
    const after = compile(restored)
    if (before.actionSetDigest !== after.actionSetDigest ||
        JSON.stringify(before.actions) !== JSON.stringify(after.actions)) {
        fail('multi-repository-e2e-reload-diverged')
    }
    restored.disturbances.serializeReloadVerified = true
    restored.disturbances.reloadProjectionDigest =
        compilerInput(restored).aggregateProjection
            .aggregateProjectionDigest
    return restored
}

function executeAction(runtime, action) {
    runtime.actionSequence += 1
    runtime.actionLog.push({
        sequence: runtime.actionSequence,
        type: action.type,
        nodeId: action.nodeId,
        acceptanceGroup: action.acceptanceGroup,
        recoveryMode: action.recoveryMode
    })
    if (action.type === 'refresh-scope') {
        refreshScope(runtime)
        return runtime
    }
    if (action.type === 'deliver-acceptance-group') {
        deliver(runtime, action)
        return runtime
    }
    if (action.type === 'idle') return runtime
    const node = runtime.nodes[action.nodeId]
    if (!node) fail('multi-repository-e2e-action-node-missing')
    switch (action.type) {
        case 'request-semantic-proposal':
            recordSemantic(runtime, node)
            break
        case 'compile-acceptance-contract':
            recordAcceptance(runtime, node)
            break
        case 'request-test-contract-planning':
            recordPlanning(runtime, node)
            maybeInjectCommentDrift(runtime, node)
            break
        case 'dispatch-test-contract-writer':
            recordTestContract(node)
            break
        case 'dispatch-implementation-writer':
            recordImplementation(runtime, node, action)
            break
        case 'dispatch-behavior-verifier':
            recordBehavior(node)
            break
        case 'request-ui-adjudication':
            recordUiAdjudication(node)
            break
        case 'dispatch-ux-acceptance-verifier':
            recordUxAcceptance(node)
            break
        case 'dispatch-documentation-writer':
            recordDocumentation(node)
            break
        case 'cleanup-node-resources':
            cleanup(runtime, node)
            break
        default:
            fail('multi-repository-e2e-action-unsupported', {
                type: action.type
            })
    }
    return runtime
}

function initializeRuntime(scenarioRoot) {
    const stateRoot = path.resolve(scenarioRoot, 'state')
    const resourceRoot = path.resolve(scenarioRoot, 'resources')
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.mkdirSync(resourceRoot, { recursive: true })
    const initialGeneratedArtifacts =
        fs.readdirSync(stateRoot).length
    if (initialGeneratedArtifacts !== 0) {
        fail('multi-repository-e2e-initial-state-not-empty')
    }
    const repoA = initRepository(scenarioRoot, 'RepoA')
    const repoB = initRepository(scenarioRoot, 'RepoB')
    const issueA = rawIssue(repoA.repository, 1, {
        group: GROUP
    })
    const issueBId = `${repoA.repository}#2`
    const issueAId = `${repoA.repository}#1`
    const issueB = rawIssue(repoA.repository, 2, {
        dependsOn: [issueAId]
    })
    const issueC = rawIssue(repoB.repository, 3, {
        ui: true,
        group: GROUP
    })
    const issueD = rawIssue(repoB.repository, 4)
    const issues = Object.fromEntries(
        [issueA, issueB, issueC, issueD].map((issue) => [
            `${issue.repository}#${issue.number}`, issue
        ])
    )
    const runtime = {
        schema:
            'issue-orchestration.multi-repository-lifecycle-runtime.v1',
        scenarioRoot,
        stateRoot,
        resourceRoot,
        initialGeneratedArtifacts,
        repositories: { RepoA: repoA, RepoB: repoB },
        issues,
        nodes: Object.fromEntries([
            nodeRecord(issueA, 'RepoA'),
            nodeRecord(issueB, 'RepoA'),
            nodeRecord(issueC, 'RepoB'),
            nodeRecord(issueD, 'RepoB')
        ].map((node) => [node.id, node])),
        groupMembers: {
            [GROUP]: [
                `${repoA.repository}#1`,
                `${repoB.repository}#3`
            ]
        },
        selectorVersion: 1,
        selectorReceipt: null,
        remoteSnapshotReceipt: null,
        graphBindings: null,
        policyDigest: digest('e2e-installed-route-policy'),
        capabilityDigest:
            digest('e2e-runtime-capability-binding'),
        actionSequence: 0,
        actionLog: [],
        actionSetDigests: [],
        maximumConcurrentActions: 0,
        deliveryEffects: {},
        remoteDeliveryEffects: {},
        cleanupFinalizations: {},
        planningCount: {},
        refreshEvidence: [],
        disturbances: {
            commentChangeNode: `${repoB.repository}#4`,
            commentChangeInjected: false,
            baseChangeNode: issueBId,
            baseChangeInjected: false,
            staleWriterDispatchPrevented: false,
            writerFailureNode: `${repoB.repository}#4`,
            writerFailureObserved: false,
            serializeReloadVerified: false,
            deliveryRetryInjected: false,
            deliveryRemoteSucceededBeforeReceipt: false
        }
    }
    compileSelector(runtime)
    initializeBindings(runtime)
    return runtime
}

function verifyFinal(runtime) {
    const nodes = Object.values(runtime.nodes)
    if (nodes.some(({ lifecycleState }) => lifecycleState !== 'closed')) {
        fail('multi-repository-e2e-nodes-not-closed')
    }
    if (Object.values(runtime.issues).some((issue) =>
        issue.state !== 'CLOSED' || issue.stateReason !== 'COMPLETED')) {
        fail('multi-repository-e2e-remote-issues-not-completed')
    }
    const dependent = runtime.nodes[
        runtime.disturbances.baseChangeNode
    ]
    const prerequisite = runtime.nodes[dependent.dependencyKeys[0]]
    const firstDependentAction = runtime.actionLog.find(
        ({ nodeId }) => nodeId === dependent.id
    )
    if (!firstDependentAction ||
        firstDependentAction.sequence <= prerequisite.closedAtSequence) {
        fail('multi-repository-e2e-dependency-dispatch-early')
    }
    if (runtime.maximumConcurrentActions < 2) {
        fail('multi-repository-e2e-no-concurrent-ready-work')
    }
    if (runtime.planningCount[
        runtime.disturbances.commentChangeNode
    ] < 2 || runtime.refreshEvidence.length !== 1) {
        fail('multi-repository-e2e-comment-refresh-missing')
    }
    if (runtime.planningCount[
        runtime.disturbances.baseChangeNode
    ] < 2 || !runtime.disturbances.staleWriterDispatchPrevented) {
        fail('multi-repository-e2e-base-rebind-missing')
    }
    if (!runtime.disturbances.writerFailureObserved ||
        runtime.nodes[
            runtime.disturbances.writerFailureNode
        ].implementationAttempts !== 2) {
        fail('multi-repository-e2e-retry-evidence-missing')
    }
    for (const field of [
        'serializeReloadVerified',
        'deliveryRetryInjected',
        'deliveryRemoteSucceededBeforeReceipt'
    ]) {
        if (!runtime.disturbances[field]) {
            fail('multi-repository-e2e-disturbance-missing', { field })
        }
    }
    if (Object.keys(runtime.deliveryEffects).length !== 3) {
        fail('multi-repository-e2e-delivery-effects-invalid')
    }
    for (const repository of Object.values(runtime.repositories)) {
        const remoteHead = runGit([
            '--git-dir', repository.bare,
            'rev-parse', 'refs/heads/main'
        ], runtime.scenarioRoot)
        if (!SHA.test(remoteHead)) {
            fail('multi-repository-e2e-remote-head-invalid')
        }
        for (const commit of repository.deliveredCommits) {
            runGit([
                '--git-dir', repository.bare,
                'merge-base', '--is-ancestor',
                commit, 'refs/heads/main'
            ], runtime.scenarioRoot)
        }
        const refs = runGit([
            '--git-dir', repository.bare,
            'for-each-ref', '--format=%(refname)',
            'refs/heads'
        ], runtime.scenarioRoot).split(/\r?\n/u).filter(Boolean)
        if (JSON.stringify(refs) !==
            JSON.stringify(['refs/heads/main'])) {
            fail('multi-repository-e2e-residual-branches', {
                repository: repository.repository,
                refs
            })
        }
    }
    if (fs.readdirSync(runtime.resourceRoot).length !== 0) {
        fail('multi-repository-e2e-resource-residue')
    }
}

function finalizeReceipt(runtime) {
    verifyFinal(runtime)
    const repositoryEvidence = Object.values(runtime.repositories).map(
        (repository) => ({
            repository: repository.repository,
            defaultBranch: 'main',
            remoteHead: runGit([
                '--git-dir', repository.bare,
                'rev-parse', 'refs/heads/main'
            ], runtime.scenarioRoot),
            deliveredCommits: [...repository.deliveredCommits],
            pushCount: repository.pushCount
        })
    )
    for (const repository of Object.values(runtime.repositories)) {
        fs.rmSync(repository.work, { recursive: true, force: true })
    }
    fs.rmSync(runtime.stateRoot, { recursive: true, force: true })
    fs.rmSync(runtime.resourceRoot, { recursive: true, force: true })
    const receipt = {
        schema: RECEIPT_SCHEMA,
        status: 'verified',
        runId: RUN_ID,
        initialStateRootArtifactCount:
            runtime.initialGeneratedArtifacts,
        repositoryEvidence,
        issueEvidence: Object.values(runtime.issues).map((issue) => ({
            issue: `${issue.repository}#${issue.number}`,
            state: issue.state,
            stateReason: issue.stateReason
        })),
        nodeEvidence: Object.values(runtime.nodes).map((node) => ({
            nodeId: node.id,
            lifecycleState: node.lifecycleState,
            implementationAttempts: node.implementationAttempts,
            deliveryCommit: node.deliveryCommit,
            cleanupReceiptDigest:
                node.receipts.cleanup.receiptDigest
        })),
        actionSetDigests: [...runtime.actionSetDigests],
        actionCount: runtime.actionLog.length,
        maximumConcurrentActions:
            runtime.maximumConcurrentActions,
        dependencyBlockedUntilClosure: true,
        uiAdjudicationVerified:
            Boolean(runtime.nodes[`${runtime.repositories.RepoB.repository}#3`]
                .receipts.uiAdjudication),
        uxAcceptanceVerified:
            Boolean(runtime.nodes[`${runtime.repositories.RepoB.repository}#3`]
                .receipts.uxAcceptance),
        documentationVerifiedForEveryNode:
            Object.values(runtime.nodes).every(
                (node) => Boolean(node.receipts.documentation)
            ),
        commentRefreshAffectedOnlyOneNode:
            runtime.refreshEvidence[0].changed.length === 1,
        baseRebindingVerified:
            runtime.disturbances.staleWriterDispatchPrevented,
        authorizedRetryCount: 1,
        serializeReloadReplayVerified:
            runtime.disturbances.serializeReloadVerified,
        deliveryRetryWasIdempotent:
            runtime.disturbances.deliveryRetryInjected,
        acceptanceGroupMemberCount:
            runtime.groupMembers[GROUP].length,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        residualWorktreeCount: 0,
        residualBranchCount: 0,
        residualTemporaryResourceCount: 0,
        networkInvocationCount: 0,
        paidModelInvocationCount: 0,
        quiescent: true
    }
    receipt.receiptDigest = digest(receipt)
    return Object.freeze(receipt)
}

export function runMultiRepositoryLifecycleAcceptance({
    scenarioRoot = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-multi-repository-e2e-'
    ))
} = {}) {
    fs.mkdirSync(scenarioRoot, { recursive: true })
    let runtime = initializeRuntime(scenarioRoot)
    for (let iteration = 0; iteration < 160; iteration += 1) {
        injectPendingDisturbances(runtime)
        const actionSet = compile(runtime)
        if (actionSet.quiescent) {
            if (Object.values(runtime.nodes).every(
                ({ lifecycleState }) => lifecycleState === 'closed'
            )) {
                return finalizeReceipt(runtime)
            }
            fail('multi-repository-e2e-premature-idle')
        }
        for (const action of actionSet.actions) {
            runtime = executeAction(runtime, action)
        }
        if (runtime.disturbances.writerFailureObserved &&
            !runtime.disturbances.serializeReloadVerified) {
            runtime = serializeReload(runtime)
        }
    }
    fail('multi-repository-e2e-iteration-limit')
}
