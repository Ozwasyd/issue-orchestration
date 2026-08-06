import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    compileLifecycleRunActionSet,
    lifecycleRunObservationContext,
    projectLifecycleRun,
    recordLifecycleRunTerminalization,
    replayLifecycleRunLedger
} from './lifecycle-run-loop.mjs'
import {
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'
import {
    collectQuiescenceObservation,
    freezeQuiescenceBaseline,
    QUIESCENCE_INVENTORY_NAMES
} from './quiescence-observation-collector.mjs'
import {
    computeQuiescenceDigest,
    evaluateQuiescence,
    verifyQuiescenceReceipt
} from './quiescence.mjs'

const SUPPORTED_ACTION = 'idle'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const SOURCE_IDS = Object.freeze([
    'projection',
    'receipts',
    'registries'
])
const ZERO_SUMMARY_FIELDS = Object.freeze({
    issues: ['openCount'],
    stages: [
        'incompleteCount',
        'digestMismatchCount',
        'authorityViolationCount'
    ],
    attempts: [
        'activeCount', 'expiredUnrecoveredCount', 'cleanupFailureCount',
        'retainedCount', 'missingTerminalCount'
    ],
    groups: [
        'activeSessionCount', 'activeWriteLeaseCount',
        'activeMemberStageCount', 'ownedResourceCount',
        'retainedServiceCount', 'unfinishedDeliveryWindowCount',
        'undisposedCommitPrefixCount',
        'missingTerminalCleanupReceiptCount',
        'missingMemberReceiptCount'
    ],
    actors: ['activeCount', 'pendingActionCount'],
    workPlans: ['activeCount', 'staleCount', 'retainedCount'],
    slices: [
        'activeCount', 'abandonedCount', 'retainedCount',
        'writeLeaseCount', 'partialPromotedCount',
        'uncompiledWholeIssueDispatchCount'
    ],
    checkpoints: [
        'activeCount', 'ownerlessCount', 'staleCount',
        'withoutNextActionCount', 'identityMismatchCount',
        'supersededStillReferencedCount'
    ],
    continuations: [
        'pendingCount', 'ownerlessCount', 'missingCursorCount',
        'missingResourceCount', 'retainedCount'
    ],
    outputMissingBreakers: [
        'unresolvedCount', 'illegalRetryCount', 'bypassCount'
    ],
    routes: [
        'activeCount', 'staleCount', 'routeWithoutVerifiedSliceCount',
        'unauthorizedOverrideCount', 'unverifiedEffectiveProfileCount',
        'illegalFailurePromotionCount'
    ],
    profileCapabilities: ['pendingMismatchCount', 'unverifiedCount'],
    git: [
        'orphanWorktreeCount', 'staleMetadataCount', 'dirtyCount',
        'registryMismatchCount', 'remoteIdentityMismatchCount',
        'unreachableCandidateCount', 'unretiredCandidateCount'
    ],
    resources: [
        'activeCount', 'retainedCount', 'unknownCount',
        'missingTerminalCount', 'quarantineCount',
        'cleanupFailureCount', 'orphanCount'
    ],
    processes: [
        'activeOwnedCount', 'descendantCount', 'deletedCwdCount',
        'watcherCount'
    ],
    ports: ['ownedListeningCount'],
    docker: ['containerCount', 'networkCount', 'unhandledVolumeCount'],
    locks: ['busyCount', 'staleCount'],
    leases: ['busyCount', 'staleCount'],
    slots: ['busyCount'],
    filesystem: [
        'unfinishedRootCount', 'scratchCount', 'ownerlessCount',
        'halfWrittenCount', 'repoLocalDuplicateSkillCount',
        'unapprovedRetentionCount'
    ],
    skills: ['duplicateCount', 'halfInstalledCount', 'activeRuntimeStateCount'],
    bootstrap: ['activeStateCount', 'lockCount', 'slotCount'],
    landing: [
        'activeLeaseCount', 'activeAttemptCount', 'activeSliceCount',
        'continuationPendingCount', 'multiMemberConflictSliceCount',
        'pendingReverificationCount', 'unresolvedConflictManifestCount',
        'sourceTipMutationViolationCount', 'forcePushAttemptCount',
        'cleanupReceiptMissingCount'
    ],
    sourceCandidates: [
        'activeCount', 'unretiredCount', 'retainedCount',
        'unknownOwnerCount'
    ],
    commitMappings: ['incompleteCount'],
    humanDecisions: [
        'activeRequestCount', 'recordedButUnappliedCount',
        'invalidatedReplayCount', 'postDecisionResumePendingCount'
    ],
    humanRetentions: ['ownerlessCount', 'expiredCount', 'retainedCount'],
    dag: [
        'residentUpdaterCount', 'unauthorizedProposalCount',
        'unappliedManualPatchCount'
    ],
    telemetry: ['pendingEventCount']
})

export class LifecycleQuiescenceFinalizerError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'LifecycleQuiescenceFinalizerError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecycleQuiescenceFinalizerError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) reject(code)
    return value
}

function hash(value, code) {
    if (!HASH.test(value ?? '')) reject(code)
    return value
}

function clone(value) {
    return structuredClone(value)
}

function unsignedDigest(value, field) {
    const copy = clone(value)
    delete copy[field]
    return digest(copy)
}

function digestOf(value) {
    if (!value || typeof value !== 'object') return null
    for (const field of [
        'receiptDigest', 'resultDigest', 'proposalDigest',
        'inventoryDigest', 'contractDigest', 'workPlanDigest',
        'planDigest', 'sliceDigest', 'promptDigest',
        'routeDecisionDigest', 'bindingDigest', 'snapshotDigest',
        'observationDigest', 'effectDigest'
    ]) {
        if (HASH.test(value[field] ?? '')) return value[field]
    }
    return digest(value)
}

function forbidCallerAuthority(input) {
    for (const field of [
        'observation', 'receipt', 'quiescenceReceipt', 'inventories',
        'summaries', 'counts', 'quiescent', 'activeLeaseCount',
        'residualWorktreeCount', 'residualBranchCount'
    ]) {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
            reject('finalization-caller-authority-forbidden', { field })
        }
    }
}

function exactAction(action, actionSet) {
    if (action?.type !== SUPPORTED_ACTION ||
        action?.lifecycleState !== 'quiescent' ||
        actionSet?.quiescent !== true ||
        actionSet?.actions?.length !== 1) {
        reject('finalization-action-invalid')
    }
    try {
        validateLifecycleActionSet(actionSet)
    } catch (error) {
        reject('finalization-action-set-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (!sameValue(actionSet.actions[0], action)) {
        reject('finalization-action-stale')
    }
    return action
}

function validateContextAuthority(context, action) {
    const observation = lifecycleRunObservationContext(
        context.ledger,
        { startup: context.startup }
    )
    let authority
    try {
        authority = validateLifecycleRunAuthority(
            observation.lifecycleAuthority,
            {
                startup: context.startup,
                expectedRunId: action.bindings.runId,
                expectedStateRoot: context.stateRootPath
            }
        )
    } catch (error) {
        reject('finalization-lifecycle-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const binding = authority.binding
    const expected = {
        lifecycleAuthorityBindingDigest: binding.bindingDigest,
        startupAttestationDigest: binding.startupAttestationDigest,
        runtimeInvocationId: binding.runtimeInvocationId,
        runtimeSessionId: binding.runtimeSessionId,
        rootAuthorityEpoch: binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest: binding.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest: binding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest: binding.repositoryBindingSetDigest,
        packageDigest: binding.packageDigest,
        manifestDigest: binding.manifestDigest,
        policySetDigest: binding.policySetDigest,
        runtimeCapabilityBindingDigest:
            binding.runtimeCapabilityBindingDigest
    }
    for (const [field, value] of Object.entries(expected)) {
        if (action.bindings[field] !== value) {
            reject('finalization-action-authority-stale', { field })
        }
    }
    if (context.runtimeTrustBinding?.bindingDigest !==
            authority.runtimeTrustBinding.bindingDigest ||
        !sameValue(context.repositoryTargets, authority.repositoryTargets)) {
        reject('finalization-runtime-authority-stale')
    }
    return authority
}

function validateObserver(observer) {
    object(observer, 'finalization-observer-required')
    if (typeof observer.observeFinalizationFacts !== 'function') {
        reject('finalization-observer-invalid')
    }
    return observer
}

function validateFinalizationObservation(value, action, targets) {
    object(value, 'finalization-observation-required')
    if (value.schema !==
            'issue-orchestration.lifecycle-finalization-observation.v1' ||
        value.producerAuthority !==
            'independent-machine-inventory-verifier' ||
        value.rootAuthored !== false ||
        value.callerAuthored !== false ||
        value.actionDigest !== action.actionDigest ||
        value.runId !== action.bindings.runId) {
        reject('finalization-observation-authority-invalid')
    }
    for (const field of [
        'summary', 'summaries', 'counts', 'quiescent', 'receipt'
    ]) {
        if (Object.prototype.hasOwnProperty.call(value, field)) {
            reject('finalization-observation-derived-authority', { field })
        }
    }
    text(value.actorId, 'finalization-verifier-id-required')
    text(value.machineId, 'finalization-machine-id-required')
    hash(value.machineIdentityDigest,
        'finalization-machine-identity-required')
    hash(value.remoteSnapshotDigest,
        'finalization-remote-snapshot-required')
    hash(value.selectorObservationDigest,
        'finalization-selector-observation-required')
    if (!Array.isArray(value.resolvedTargetIssueSet) ||
        !sameValue(
            [...value.resolvedTargetIssueSet].sort(),
            [...targets].sort()
        )) {
        reject('finalization-selector-scope-drift')
    }
    if (!Array.isArray(value.remoteIssues) ||
        value.remoteIssues.length !== targets.length) {
        reject('finalization-remote-issues-incomplete')
    }
    const byTarget = new Map()
    for (const issue of value.remoteIssues) {
        object(issue, 'finalization-remote-issue-invalid')
        if (!targets.includes(issue.target) ||
            byTarget.has(issue.target) ||
            !['open', 'closed'].includes(issue.state) ||
            issue.remoteSnapshotDigest !== value.remoteSnapshotDigest) {
            reject('finalization-remote-issue-invalid', {
                target: issue.target ?? null
            })
        }
        byTarget.set(issue.target, clone(issue))
    }
    object(value.inventoryRecords,
        'finalization-inventory-records-required')
    const names = Object.keys(value.inventoryRecords).sort()
    if (!sameValue(names, [...QUIESCENCE_INVENTORY_NAMES].sort())) {
        reject('finalization-inventory-domain-incomplete')
    }
    for (const name of QUIESCENCE_INVENTORY_NAMES) {
        if (!Array.isArray(value.inventoryRecords[name])) {
            reject('finalization-inventory-records-invalid', { name })
        }
        if (['issues', 'stages'].includes(name) &&
            value.inventoryRecords[name].length !== 0) {
            reject('finalization-canonical-domain-overridden', { name })
        }
    }
    if (value.observationDigest !==
            unsignedDigest(value, 'observationDigest')) {
        reject('finalization-observation-digest-invalid')
    }
    return Object.freeze({
        ...clone(value),
        remoteIssueByTarget: byTarget
    })
}

function validateNodeDisposition(state, target) {
    const node = state.nodes[target]
    if (!node) reject('finalization-node-missing', { target })
    if (node.lifecycleState === 'closed') {
        for (const field of ['delivery', 'cleanup', 'closure']) {
            if (!node.receipts?.[field]) {
                reject('finalization-closed-node-evidence-missing', {
                    target,
                    field
                })
            }
        }
        if (!state.deliveryEffects[
            node.acceptanceGroup ?? `node:${target}`
        ] || !state.cleanupFinalizations[target] ||
            !state.closureEffects[target]) {
            reject('finalization-closed-node-control-chain-missing', {
                target
            })
        }
        return 'closed'
    }
    if (node.lifecycleState === 'terminal') {
        for (const field of [
            'terminal', 'recoveryFingerprint', 'retentionState'
        ]) {
            if (!node.receipts?.[field]) {
                reject('finalization-terminal-node-evidence-missing', {
                    target,
                    field
                })
            }
        }
        return 'terminal'
    }
    reject('finalization-node-not-terminal', {
        target,
        lifecycleState: node.lifecycleState
    })
}

function roleSkillReceiptDigest(authority) {
    return digest({
        packageDigest: authority.binding.packageDigest,
        manifestDigest: authority.binding.manifestDigest,
        policySetDigest: authority.binding.policySetDigest,
        skill: 'issue-orchestration'
    })
}

function stageRecords({ state, observation, authority }) {
    const roleReceipt = roleSkillReceiptDigest(authority)
    const records = []
    const issueRecords = []
    for (const target of Object.keys(state.nodes).sort()) {
        const node = state.nodes[target]
        const remote = observation.remoteIssueByTarget.get(target)
        const disposition = validateNodeDisposition(state, target)
        if (!remote) reject('finalization-remote-issue-missing', { target })
        if (disposition === 'closed') {
            if (remote.state !== 'closed' ||
                remote.stateReason !== 'completed') {
                reject('finalization-closed-node-remote-open', { target })
            }
            const delivery = node.receipts.delivery
            const cleanup = node.receipts.cleanup
            const closure = node.receipts.closure
            const deliveryEffect = state.deliveryEffects[
                node.acceptanceGroup ?? `node:${target}`
            ]
            const cleanupFinalization = state.cleanupFinalizations[target]
            const closureEffect = state.closureEffects[target]
            issueRecords.push({
                target,
                state: 'closed',
                disposition: 'closed',
                terminalState: 'closed',
                completionEvidenceDigest: digest({
                    delivery: digestOf(delivery),
                    cleanup: digestOf(cleanup),
                    closure: digestOf(closure),
                    closureEffect: digest(closureEffect)
                }),
                remoteSnapshotDigest: observation.remoteSnapshotDigest
            })
            records.push({
                target,
                status: 'complete',
                terminalState: 'complete',
                uiNode: node.uiClass === 'ui-ux',
                frozenTestContractDigest: digestOf(
                    node.receipts.testContractWriter ??
                    node.receipts.acceptanceContract
                ),
                implementationCandidateDigest: digestOf(
                    node.receipts.candidate ??
                    node.receipts.implementationTerminal
                ),
                behaviorGreenReceiptDigest: digestOf(
                    node.receipts.behaviorVerification ??
                    node.receipts.behavior
                ),
                uxAcceptedReceiptDigest:
                    node.uiClass === 'ui-ux'
                        ? digestOf(node.receipts.uxAcceptance)
                        : undefined,
                designSkillDigest:
                    node.uiClass === 'ui-ux'
                        ? digestOf(node.receipts.uiAdjudication)
                        : undefined,
                documentationGreenReceiptDigest: digestOf(
                    node.receipts.documentation
                ),
                remoteDeliveryEvidenceDigest: digestOf(delivery),
                resourceCleanupReceiptDigest: digestOf(cleanup),
                candidateEpochDigest: digest({
                    nodeId: target,
                    chainVersion: node.chainVersion,
                    baseSha: state.repositories[node.repository]?.baseSha,
                    candidate: digestOf(node.receipts.candidate)
                }),
                roleSkillReceiptDigest: roleReceipt,
                canonicalDeliveryEffectDigest: digest(deliveryEffect),
                canonicalCleanupFinalizationDigest:
                    digest(cleanupFinalization),
                canonicalClosureEffectDigest: digest(closureEffect),
                authorityValid: true,
                digestsConsistent: true
            })
            continue
        }
        const terminal = node.receipts.terminal
        const recovery = node.receipts.recoveryFingerprint
        const retention = node.receipts.retentionState
        const terminalDigest = digestOf(terminal)
        const recoveryDigest = digestOf(recovery)
        const retentionDigest = digestOf(retention)
        issueRecords.push({
            target,
            state: remote.state,
            disposition: 'terminal',
            terminalState: 'terminal',
            terminalCategory: terminal.evidence.category,
            terminalReceiptDigest: terminalDigest,
            recoveryFingerprintDigest: recoveryDigest,
            retentionStateDigest: retentionDigest,
            completionEvidenceDigest: digest({
                terminalDigest,
                recoveryDigest,
                retentionDigest
            }),
            remoteSnapshotDigest: observation.remoteSnapshotDigest
        })
        records.push({
            target,
            status: 'terminal',
            terminalState: 'terminal',
            terminalCategory: terminal.evidence.category,
            terminalReceiptDigest: terminalDigest,
            recoveryFingerprintDigest: recoveryDigest,
            retentionStateDigest: retentionDigest,
            roleSkillReceiptDigest: roleReceipt,
            authorityValid: true,
            digestsConsistent: true
        })
    }
    return { issueRecords, stageRecords: records, roleReceipt }
}

function controlGroupRecords(state) {
    return Object.entries(state.aggregateProjection.acceptanceGroups ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([groupId, group]) => {
            const rawMembers = Array.isArray(group.memberIds)
                ? group.memberIds
                : Array.isArray(group.members)
                    ? group.members
                    : Object.keys(group.members ?? {})
            const memberIds = [...rawMembers]
                .map((member) => typeof member === 'string'
                    ? member
                    : member.memberId ?? member.id)
                .filter(Boolean)
                .sort()
            const cleanupDigests = memberIds.map((memberId) =>
                digest(state.cleanupFinalizations[memberId] ?? {
                    memberId,
                    missing: true
                }))
            return {
                groupId,
                terminalState: 'completed',
                terminalCleanupReceiptDigest: digest(cleanupDigests),
                activeMemberIds: [],
                activeWriteLeaseIds: [],
                ownedResourceIds: [],
                retainedServiceIds: [],
                unfinishedDeliveryWindowIds: [],
                undisposedCommitPrefixes: [],
                memberIds,
                memberReceiptIds: memberIds
            }
        })
}

function retainedResourceRecords(state) {
    return Object.entries(state.nodes).flatMap(([nodeId, node]) =>
        (node.receipts?.retentionState?.evidence?.retainedResources ?? [])
            .map((resource) => ({
                ...clone(resource),
                terminalState: 'released',
                retained: true,
                terminalReceiptDigest: digestOf(
                    node.receipts.retentionState
                ),
                ownerNodeId: nodeId
            })))
}

function expectedRepositoryHeads(state, authority) {
    const heads = new Map(
        authority.repositoryBindings.map((binding) => [
            binding.repository,
            binding.observedDefaultBranchHead
        ])
    )
    for (const effect of Object.values(state.deliveryEffects ?? {})) {
        for (const repositoryEffect of effect.repositoryEffects ?? []) {
            if (SHA.test(repositoryEffect.resultingRemoteSha ?? '')) {
                heads.set(
                    repositoryEffect.repository,
                    repositoryEffect.resultingRemoteSha
                )
            }
        }
        for (const [nodeId, commitSha] of Object.entries(
            effect.commits ?? {}
        )) {
            const repository = state.nodes[nodeId]?.repository
            if (repository && SHA.test(commitSha ?? '')) {
                heads.set(repository, commitSha)
            }
        }
    }
    return heads
}

function collectorRecords(collected, baselineDigest, expectedHeads) {
    const records = Object.fromEntries(
        QUIESCENCE_INVENTORY_NAMES.map((name) => [name, []])
    )
    records.git = (collected.inventories.git.records ?? [])
        .filter((record) => record.observable !== false)
        .map((record) => ({
            resourceId: `repository:${record.repository}`,
            repository: record.repository,
            terminalState: 'baseline',
            baselineDigest,
            evidenceDigest: digest(record),
            dirty: record.dirty === true,
            registryConsistent: record.observable === true,
            expectedHead: expectedHeads.get(record.repository) ?? null,
            remoteIdentityExact:
                record.branch === record.defaultBranch &&
                SHA.test(record.head ?? '') &&
                record.head === expectedHeads.get(record.repository),
            orphanWorktree: record.worktreeCount > 1,
            staleMetadata: false,
            active: record.worktreeCount > 1 ||
                record.localBranchCount > 1 || record.dirty === true
        }))
    records.processes = (collected.inventories.processes.records ?? [])
        .filter((record) => record.owned === true ||
            record.observable === false)
        .map((record) => ({
            resourceId: `process:${record.processId ?? digest(record).slice(0, 12)}`,
            terminalState: record.active === true
                ? 'absent-verified'
                : 'absent-verified',
            evidenceDigest: digest(record),
            alive: record.active === true,
            active: record.active === true,
            observable: record.observable !== false
        }))
    return records
}

function zeroSummary(category) {
    return Object.fromEntries(
        (ZERO_SUMMARY_FIELDS[category] ?? [])
            .map((field) => [field, Number(0)])
    )
}

function count(records, predicate) {
    return records.filter(predicate).length
}

function summaryFor(category, records, special) {
    const summary = zeroSummary(category)
    if (category === 'issues') {
        summary.openCount = count(records, (record) =>
            record.state !== 'closed' && record.disposition !== 'terminal')
    } else if (category === 'stages') {
        summary.incompleteCount = count(records, (record) =>
            !['complete', 'terminal'].includes(record.status))
        summary.digestMismatchCount = count(records, (record) =>
            record.digestsConsistent !== true)
        summary.authorityViolationCount = count(records, (record) =>
            record.authorityValid !== true)
    } else if (category === 'groups') {
        summary.activeSessionCount = count(records, (record) =>
            record.active === true)
        summary.activeWriteLeaseCount = records.reduce(
            (total, record) => total +
                (record.activeWriteLeaseIds?.length ?? 0), 0)
        summary.activeMemberStageCount = records.reduce(
            (total, record) => total +
                (record.activeMemberIds?.length ?? 0), 0)
        summary.ownedResourceCount = records.reduce(
            (total, record) => total +
                (record.ownedResourceIds?.length ?? 0), 0)
        summary.retainedServiceCount = records.reduce(
            (total, record) => total +
                (record.retainedServiceIds?.length ?? 0), 0)
        summary.unfinishedDeliveryWindowCount = records.reduce(
            (total, record) => total +
                (record.unfinishedDeliveryWindowIds?.length ?? 0), 0)
        summary.undisposedCommitPrefixCount = records.reduce(
            (total, record) => total +
                (record.undisposedCommitPrefixes?.length ?? 0), 0)
        summary.missingTerminalCleanupReceiptCount = count(
            records,
            (record) => !HASH.test(record.terminalCleanupReceiptDigest ?? '')
        )
        summary.missingMemberReceiptCount = records.reduce(
            (total, record) => total + Math.max(
                0,
                (record.memberIds?.length ?? 0) -
                (record.memberReceiptIds?.length ?? 0)
            ), 0)
    } else if (category === 'git') {
        summary.orphanWorktreeCount = count(records, (record) =>
            record.orphanWorktree === true)
        summary.staleMetadataCount = count(records, (record) =>
            record.staleMetadata === true)
        summary.dirtyCount = count(records, (record) =>
            record.dirty === true)
        summary.registryMismatchCount = count(records, (record) =>
            record.registryConsistent === false)
        summary.remoteIdentityMismatchCount = count(records, (record) =>
            record.remoteIdentityExact === false)
        summary.unreachableCandidateCount = count(records, (record) =>
            record.unreachableCandidate === true)
        summary.unretiredCandidateCount = count(records, (record) =>
            record.unretiredCandidate === true)
    } else if (category === 'resources') {
        summary.activeCount = count(records, (record) => record.active === true)
        summary.retainedCount = count(records, (record) =>
            record.retained === true)
        summary.unknownCount = count(records, (record) =>
            record.unknown === true || record.ownerClass === 'unknown-owner')
        summary.missingTerminalCount = count(records, (record) =>
            !record.terminalState && !record.status)
        summary.quarantineCount = count(records, (record) =>
            record.quarantined === true)
        summary.cleanupFailureCount = count(records, (record) =>
            record.cleanupFailed === true)
        summary.orphanCount = count(records, (record) =>
            record.orphan === true)
    } else if (category === 'processes') {
        summary.activeOwnedCount = count(records, (record) =>
            record.alive === true || record.active === true)
        summary.descendantCount = count(records, (record) =>
            record.descendantAlive === true)
        summary.deletedCwdCount = count(records, (record) =>
            record.deletedCwd === true)
        summary.watcherCount = count(records, (record) =>
            record.watcherAlive === true)
    } else if (category === 'ports') {
        summary.ownedListeningCount = count(records, (record) =>
            record.listening === true || record.bound === true)
    } else if (category === 'docker') {
        summary.containerCount = count(records, (record) =>
            record.container === true || record.containerId)
        summary.networkCount = count(records, (record) =>
            record.network === true || record.networkId)
        summary.unhandledVolumeCount = count(records, (record) =>
            record.unhandledVolume === true)
    } else if (category === 'locks' || category === 'leases') {
        summary.busyCount = count(records, (record) =>
            record.busy === true || record.held === true)
        summary.staleCount = count(records, (record) =>
            record.stale === true)
    } else if (category === 'slots') {
        summary.busyCount = count(records, (record) =>
            record.busy === true || record.held === true)
    }
    return { ...summary, ...special }
}

function inventory(category, records, sourceRefs, observedAt, special = {}) {
    return {
        schema: 'issue-orchestration.quiescence-inventory.v1',
        category,
        availability: 'available',
        sourceRefs: [...new Set(sourceRefs)].sort(),
        summary: summaryFor(category, records, special),
        records: clone(records).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))),
        observedAt
    }
}

function mergeRecords(...sets) {
    return sets.flatMap((set) => Array.isArray(set) ? set : [])
}

function buildEvaluationObservation({
    action,
    state,
    authority,
    observed,
    collected,
    collectorBaseline,
    createdAt
}) {
    const baseline = {
        schema: 'issue-orchestration.resource-baseline-inventory.v1',
        verificationStatus: 'verified',
        baselineDigest: collectorBaseline.baselineDigest
    }
    const { issueRecords, stageRecords: stages, roleReceipt } =
        stageRecords({ state, observation: observed, authority })
    const collector = collectorRecords(
        collected,
        baseline.baselineDigest,
        expectedRepositoryHeads(state, authority)
    )
    const canonical = Object.fromEntries(
        QUIESCENCE_INVENTORY_NAMES.map((name) => [name, []])
    )
    canonical.issues = issueRecords
    canonical.stages = stages
    canonical.groups = controlGroupRecords(state)
    canonical.resources = retainedResourceRecords(state)
    canonical.skills = [{
        skillId: 'issue-orchestration',
        terminalState: 'installed-and-verified',
        artifactDigest: authority.binding.packageDigest,
        installDigest: authority.binding.packageDigest,
        roleSkillReceiptDigest: roleReceipt,
        singleSharedArtifact: true,
        legacyRepoLocalAuthoritiesAbsent: true,
        legacyAliasesAbsent: true,
        secondaryOrchestrationCopyAbsent: true,
        designAuthoritiesUnique: true,
        roleSkillReceiptVerified: true,
        digestConsistent: true,
        runtimeStateInInstallAbsent: true
    }]
    canonical.bootstrap = [{
        bootstrapId: `bootstrap:${action.bindings.runId}`,
        terminalState: 'retired',
        retirementReceiptDigest:
            authority.binding.startupAttestationDigest,
        fallbackDiscoverable: false,
        activeState: false,
        lockHeld: false,
        slotHeld: false
    }]
    canonical.dag = [{
        snapshotId: `dag:${action.bindings.runId}`,
        terminalState: 'terminal',
        snapshotDigest: state.semanticGraph.semanticGraphDigest,
        latestRemoteSnapshotBound: true,
        remoteSnapshotDigest: observed.remoteSnapshotDigest,
        residentUpdater: false,
        unauthorizedProposal: false,
        unappliedManualPatch: false
    }]
    canonical.telemetry = [{
        summaryId: `telemetry:${action.bindings.runId}`,
        terminalState: 'terminal',
        summaryDigest: digest({
            runId: action.bindings.runId,
            aggregateProjectionDigest:
                state.aggregateProjection.aggregateProjectionDigest,
            remoteSnapshotDigest: observed.remoteSnapshotDigest
        }),
        pending: false,
        digestRecomputable: true
    }]
    const records = {}
    for (const category of QUIESCENCE_INVENTORY_NAMES) {
        records[category] = mergeRecords(
            canonical[category],
            collector[category],
            observed.inventoryRecords[category]
        )
    }
    const sources = {
        projection: {
            schema: 'issue-orchestration.semantic-runtime-projection.v1',
            verificationStatus: 'verified',
            digest: digest({
                semanticGraphDigest: state.semanticGraph.semanticGraphDigest,
                aggregateProjectionDigest:
                    state.aggregateProjection.aggregateProjectionDigest
            })
        },
        receipts: {
            schema: 'issue-orchestration.terminal-receipt-set.v1',
            verificationStatus: 'verified',
            digest: digest({
                nodes: Object.fromEntries(Object.entries(state.nodes)
                    .map(([nodeId, node]) => [nodeId, node.receipts])),
                deliveryEffects: state.deliveryEffects,
                cleanupFinalizations: state.cleanupFinalizations,
                closureEffects: state.closureEffects,
                lastControlSequence: state.lastControlSequence
            })
        },
        registries: {
            schema: 'issue-orchestration.final-registry-inventory.v1',
            verificationStatus: 'verified',
            digest: digest({
                collectorObservationDigest: collected.observationDigest,
                finalizationObservationDigest: observed.observationDigest,
                selectorObservationDigest:
                    observed.selectorObservationDigest,
                resolvedTargetIssueSet:
                    observed.resolvedTargetIssueSet,
                repositoryIdentitySetDigest:
                    authority.binding.repositoryIdentitySetDigest,
                stateRootIdentityDigest:
                    authority.binding.stateRootIdentityDigest
            })
        }
    }
    const inventories = {}
    for (const category of QUIESCENCE_INVENTORY_NAMES) {
        const special = {}
        if (category === 'skills') {
            Object.assign(special, {
                singleSharedArtifact: true,
                legacyRepoLocalAuthoritiesAbsent: true,
                legacyAliasesAbsent: true,
                secondaryOrchestrationCopyAbsent: true,
                designAuthoritiesUnique: true,
                roleSkillReceiptVerified: true,
                digestConsistent: true,
                runtimeStateInInstallAbsent: true,
                installDigest: authority.binding.packageDigest,
                roleSkillReceiptDigest: roleReceipt
            })
        } else if (category === 'bootstrap') {
            Object.assign(special, {
                activeStateCount: count(records.bootstrap, (entry) =>
                    entry.activeState === true),
                lockCount: count(records.bootstrap, (entry) =>
                    entry.lockHeld === true),
                slotCount: count(records.bootstrap, (entry) =>
                    entry.slotHeld === true),
                fallbackDiscoverable: records.bootstrap.some((entry) =>
                    entry.fallbackDiscoverable === true),
                disposition: 'retired',
                retirementReceiptDigest:
                    authority.binding.startupAttestationDigest
            })
        } else if (category === 'dag') {
            Object.assign(special, {
                residentUpdaterCount: count(records.dag, (entry) =>
                    entry.residentUpdater === true),
                unauthorizedProposalCount: count(records.dag, (entry) =>
                    entry.unauthorizedProposal === true),
                unappliedManualPatchCount: count(records.dag, (entry) =>
                    entry.unappliedManualPatch === true),
                latestRemoteSnapshotBound: records.dag.every((entry) =>
                    entry.latestRemoteSnapshotBound === true),
                remoteSnapshotDigest: observed.remoteSnapshotDigest
            })
        } else if (category === 'telemetry') {
            Object.assign(special, {
                pendingEventCount: count(records.telemetry, (entry) =>
                    entry.pending === true),
                digestRecomputable: records.telemetry.every((entry) =>
                    entry.digestRecomputable === true),
                finalSummaryDigest: digest(records.telemetry)
            })
        }
        inventories[category] = inventory(
            category,
            records[category],
            category === 'issues'
                ? ['projection', 'registries']
                : category === 'stages'
                    ? ['projection', 'receipts']
                    : SOURCE_IDS,
            createdAt,
            special
        )
    }
    return {
        schema: 'issue-orchestration.quiescence-observation.v1',
        runId: action.bindings.runId,
        targetIssueSet: Object.keys(state.nodes).sort(),
        verifiedAt: createdAt,
        verifier: {
            actorRole: 'independent-machine-inventory-verifier',
            actorId: observed.actorId,
            observationMethod: 'machine-inventory',
            mode: 'observe-only',
            readOnly: true,
            machineIdentityDigest: observed.machineIdentityDigest,
            implementationDigest: digest({
                module: 'lifecycle-quiescence-finalizer',
                packageDigest: authority.binding.packageDigest,
                manifestDigest: authority.binding.manifestDigest
            }),
            packageDigest: authority.binding.packageDigest,
            independent: true,
            rootScheduler: false
        },
        baseline,
        allowedRetention: {
            schema: 'issue-orchestration.quiescence-allowed-retention.v1',
            verificationStatus: 'verified',
            artifacts: []
        },
        sources,
        inventories
    }
}

function collectorConfig({
    action,
    authority,
    context,
    observed,
    baseline
}) {
    const repositories = authority.repositoryTargets.map((target) => ({
        name: target.repository.split('/').at(-1),
        repository: target.repository,
        root: target.repositoryPath,
        defaultBranch: target.defaultBranch
    }))
    return {
        runId: action.bindings.runId,
        stateRoot: context.stateRootPath,
        repositories,
        selectorScope: Object.keys(
            replayLifecycleRunLedger(context.ledger, {
                startup: context.startup
            }).nodes
        ),
        allowedRetention: [],
        machineId: observed.machineId,
        ...(baseline ? { baseline } : {})
    }
}

export const lifecycleQuiescenceFinalizationActionTypes =
    Object.freeze([SUPPORTED_ACTION])

export async function executeLifecycleQuiescenceFinalization(input = {}) {
    forbidCallerAuthority(input)
    const {
        ledger,
        actionSet,
        action,
        observer,
        createdAt,
        startup,
        stateRootPath,
        runtimeTrustBinding,
        repositoryTargets
    } = input
    exactAction(action, actionSet)
    validateObserver(observer)
    const context = {
        ledger,
        actionSet,
        action,
        observer,
        createdAt,
        startup,
        stateRootPath,
        runtimeTrustBinding,
        repositoryTargets
    }
    const authority = validateContextAuthority(context, action)
    const currentActionSet = compileLifecycleRunActionSet(ledger, {
        startup
    })
    if (!sameValue(currentActionSet, actionSet)) {
        reject('finalization-action-set-stale')
    }
    const state = projectLifecycleRun(ledger, {
        startup,
        explicitAudit: true
    })
    if (state.aggregateProjection.terminal) {
        reject('finalization-already-terminal')
    }
    const targets = Object.keys(state.state.nodes).sort()
    if (targets.length === 0) reject('finalization-target-set-empty')
    const observed = validateFinalizationObservation(
        await observer.observeFinalizationFacts({
            action: clone(action),
            actionSet: clone(actionSet),
            projection: clone(state),
            targetIssueSet: targets
        }),
        action,
        targets
    )
    for (const target of targets) {
        validateNodeDisposition(state.state, target)
    }
    const baseConfig = collectorConfig({
        action,
        authority,
        context,
        observed,
        baseline: null
    })
    const collectorBaseline = await freezeQuiescenceBaseline(baseConfig)
    const collected = await collectQuiescenceObservation(
        collectorConfig({
            action,
            authority,
            context,
            observed,
            baseline: collectorBaseline
        })
    )
    const observation = buildEvaluationObservation({
        action,
        state: {
            ...state.state,
            semanticGraph: state.semanticGraph,
            aggregateProjection: state.aggregateProjection
        },
        authority,
        observed,
        collected,
        collectorBaseline,
        createdAt
    })
    const receipt = evaluateQuiescence(observation)
    if (receipt.status !== 'quiescent') {
        return Object.freeze({
            status: 'not-quiescent',
            ledger,
            action: clone(action),
            observation,
            receipt,
            violations: clone(receipt.violations)
        })
    }
    const expectedBindings = {
        schema: 'issue-orchestration.quiescence-expected-bindings.v1',
        runId: action.bindings.runId,
        targetIssueSet: observation.targetIssueSet,
        baselineDigest: receipt.baselineDigest,
        allowedRetentionDigest: receipt.allowedRetentionDigest,
        gitInventoryDigest: receipt.gitInventoryDigest,
        remoteLiveSnapshotDigest: observed.remoteSnapshotDigest,
        verifierIdentityDigest: receipt.verifierIdentityDigest,
        packageDigest: authority.binding.packageDigest,
        currentObservationDigest: receipt.observationDigest,
        maxObservationAgeMs: 60_000,
        dependencyReceiptDigests:
            clone(receipt.dependencyReceiptDigests)
    }
    try {
        verifyQuiescenceReceipt({
            observation,
            receipt,
            expectedBindings,
            now: createdAt
        })
    } catch (error) {
        reject('finalization-receipt-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const completedIssueEvidenceDigest =
        computeQuiescenceDigest(receipt.completedIssueEvidence)
    const controlObservation = lifecycleRunObservationContext(
        ledger,
        { startup }
    )
    const controlHeadDigest = hash(
        controlObservation.controlLedgerHeadDigest,
        'finalization-control-head-invalid'
    )
    const terminalization = {
        schema: 'issue-orchestration.run-terminalization.v1',
        status: 'quiescent',
        actionDigest: action.actionDigest,
        actionSetDigest: actionSet.actionSetDigest,
        receiptDigest: receipt.receiptDigest,
        observationDigest: receipt.observationDigest,
        verifierIdentityDigest: receipt.verifierIdentityDigest,
        aggregateProjectionDigest:
            state.aggregateProjection.aggregateProjectionDigest,
        preTerminalControlEventDigest: controlHeadDigest,
        completedIssueEvidenceDigest,
        selectorReceiptDigest:
            controlObservation.selectorReceipt.receiptDigest,
        remoteSnapshotDigest: observed.remoteSnapshotDigest,
        violations: [],
        quiescenceReceipt: clone(receipt),
        completedAt: createdAt
    }
    const recorded = recordLifecycleRunTerminalization({
        ledger,
        actionSet,
        action,
        terminalization,
        createdAt,
        startup
    })
    const replayed = projectLifecycleRun(recorded, {
        startup,
        explicitAudit: true
    })
    const terminal = replayed.aggregateProjection.terminal
    if (!terminal ||
        terminal.receiptDigest !== receipt.receiptDigest ||
        terminal.observationDigest !== receipt.observationDigest ||
        terminal.actionDigest !== action.actionDigest) {
        reject('finalization-terminal-replay-invalid')
    }
    return Object.freeze({
        status: 'terminalized',
        ledger: recorded,
        action: clone(action),
        observation,
        receipt,
        terminalization: clone(terminal)
    })
}
