import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.

import {
    authorizeRuntimeStartupActivity
} from './runtime-startup-attestation.mjs'

const RECEIPT_SCHEMA = 'issue-orchestration.selector-receipt.v1'

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonical(value[key])])
        )
    }
    return value
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function issueId(issue) {
    return `${issue.repository}#${issue.number}`
}

function remoteFact(issue) {
    return {
        identity: issueId(issue),
        state: issue.state,
        stateReason: issue.stateReason ?? null,
        updatedAt: issue.updatedAt,
        title: issue.title,
        body: issue.body,
        relevantComments: (issue.comments ?? [])
            .filter(({ relevant }) => relevant)
            .map(({ id, body, updatedAt }) => ({ id, body, updatedAt })),
        labels: issue.labels ?? [],
        milestone: issue.milestone
            ? { number: issue.milestone.number, title: issue.milestone.title }
            : null
    }
}

function selectedIds(selector, issuesById) {
    const repositories = new Set(selector.repositories)
    const candidates = [...issuesById.values()].filter((issue) =>
        repositories.has(issue.repository)
    )
    const states = new Set(selector.parameters.states ?? [])

    switch (selector.type) {
        case 'explicit-issues':
            return new Set(selector.parameters.issueIds)
        case 'repository-open-issues':
            return new Set(candidates.filter(({ state }) => states.has(state)).map(issueId))
        case 'label-query': {
            const labels = new Set(selector.parameters.labels)
            return new Set(candidates.filter((issue) => {
                const matches = selector.parameters.match === 'any'
                    ? issue.labels.some((label) => labels.has(label))
                    : [...labels].every((label) => issue.labels.includes(label))
                return states.has(issue.state) && matches
            }).map(issueId))
        }
        case 'milestone-query':
            return new Set(candidates.filter((issue) =>
                states.has(issue.state)
                && issue.milestone?.number === selector.parameters.milestoneNumber
            ).map(issueId))
        case 'dependency-closure': {
            const selected = new Set()
            const pending = [...selector.parameters.rootIssueIds]
            while (pending.length > 0) {
                const id = pending.pop()
                if (selected.has(id)) continue
                selected.add(id)
                for (const dependency of issuesById.get(id)?.dependsOn ?? []) {
                    if (!selected.has(dependency)) pending.push(dependency)
                }
            }
            return selected
        }
        case 'parent-tracking-issue': {
            const parentId = selector.parameters.parentIssueId
            const selected = new Set(issuesById.get(parentId)?.trackedIssueIds ?? [])
            if (selector.parameters.includeParent) selected.add(parentId)
            return selected
        }
        default:
            throw Object.assign(new Error(`invalid selector type: ${selector.type}`), {
                code: 'invalid-selector-type'
            })
    }
}

export function resolveSelector({
    selector,
    remoteIssues,
    previousReceipt = null,
    resolvedAt,
    startup
}) {
    const startupAuthorization = authorizeRuntimeStartupActivity({
        activity: 'scope-selection',
        startup
    })
    if (selector?.schema !== 'issue-orchestration.scope-selector.v1') {
        throw Object.assign(new Error('invalid selector schema'), {
            code: 'invalid-selector-schema'
        })
    }

    const parametersDigest = digest(selector.parameters)
    const selectorDigest = digest({
        ...selector,
        repositories: [...selector.repositories].sort(),
        parameters: canonical(selector.parameters)
    })
    if (previousReceipt
        && previousReceipt.selectorVersion === selector.selectorVersion
        && previousReceipt.selectorDigest !== selectorDigest) {
        throw Object.assign(
            new Error('selector version cannot be reused for changed parameters'),
            { code: 'selector-version-parameters-mismatch' }
        )
    }
    if (previousReceipt &&
        (previousReceipt.startupAttestationDigest !==
                startupAuthorization.startupAttestationDigest ||
            previousReceipt.runtimeInvocationId !==
                startupAuthorization.runtimeInvocationId)) {
        throw Object.assign(
            new Error(
                'selector receipt belongs to another runtime invocation'
            ),
            { code: 'selector-startup-binding-drift' }
        )
    }

    const issuesById = new Map(remoteIssues.map((issue) => [issueId(issue), issue]))
    const selected = selectedIds(selector, issuesById)
    const resolvedIssueSet = [...selected].filter((id) => issuesById.has(id)).sort()
    const exclusionReasons = Object.fromEntries(
        [...issuesById.keys()]
            .filter((id) => !selected.has(id))
            .sort()
            .map((id) => [id, 'excluded-by-versioned-selector'])
    )
    const remoteFactDigests = Object.fromEntries(resolvedIssueSet.map((id) => [
        id,
        digest(remoteFact(issuesById.get(id)))
    ]))
    const remoteSnapshotDigest = digest({
        selectorDigest,
        resolvedIssueSet,
        remoteFactDigests
    })

    const previousSet = new Set(previousReceipt?.resolvedIssueSet ?? [])
    const currentSet = new Set(resolvedIssueSet)
    const added = resolvedIssueSet.filter((id) => !previousSet.has(id))
    const removed = [...previousSet].filter((id) => !currentSet.has(id)).sort()
    const changed = resolvedIssueSet.filter((id) =>
        previousSet.has(id)
        && previousReceipt.remoteFactDigests?.[id] !== remoteFactDigests[id]
    )
    const closed = changed.filter((id) =>
        issuesById.get(id)?.state === 'CLOSED'
        && previousReceipt.issueStates?.[id] !== 'CLOSED'
    )
    const reopened = changed.filter((id) =>
        issuesById.get(id)?.state === 'OPEN'
        && previousReceipt.issueStates?.[id] === 'CLOSED'
    )
    const issueHistory = { ...(previousReceipt?.issueHistory ?? {}) }
    for (const id of removed) {
        issueHistory[id] = {
            disposition: 'left-selector-scope',
            previousRemoteSnapshotDigest: previousReceipt.remoteSnapshotDigest
        }
    }

    const receipt = {
        schema: RECEIPT_SCHEMA,
        startupAttestationDigest:
            startupAuthorization.startupAttestationDigest,
        runtimeInvocationId:
            startupAuthorization.runtimeInvocationId,
        runtimeSessionId:
            startupAuthorization.runtimeSessionId,
        selectorVersion: selector.selectorVersion,
        type: selector.type,
        parametersDigest,
        selectorDigest,
        resolvedIssueSet,
        exclusionReasons,
        remoteQueryIdentity: selector.remoteQueryIdentity,
        previousRemoteSnapshotDigest: previousReceipt?.remoteSnapshotDigest ?? null,
        remoteSnapshotDigest,
        remoteFactDigests,
        remoteChangeSet: { added, changed, closed, removed, reopened },
        issueHistory,
        issueStates: Object.fromEntries(resolvedIssueSet.map((id) => [
            id,
            issuesById.get(id).state
        ])),
        resolvedAt
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

function denied(code, reason, base) {
    return { ...base, launchAuthorized: false, code, reason }
}

function verifiedRoute(value, stageRole, stagePhase) {
    return value?.schema ===
            'issue-orchestration.execution-route-decision.v2' &&
        value.policyVersion === 'execution-capability-routing.v3' &&
        value.modelPoolPolicyVersion === 'stage-model-pool.v3' &&
        value.routingAuthority ===
            'deterministic-execution-capability-compiler' &&
        value.stageRole === stageRole &&
        value.stagePhase === stagePhase &&
        /^[a-f0-9]{64}$/u.test(value.routeDecisionDigest ?? '') &&
        value.runtimeVerificationStatus === 'verified'
}

function authorizeLaunch(request, expectedAction, base) {
    const checks = [
        [request?.explicit === true, 'explicit launch required'],
        [request?.requester?.role === 'root-scheduler', 'root requester required'],
        [verifiedRoute(
            request?.requester?.routeDecision,
            'root-scheduler',
            'scheduling'
        ), 'root route decision mismatch'],
        [
            request?.agent?.role === 'dag-creator-updater',
            'agent role mismatch'
        ],
        [request?.agent?.action === expectedAction, 'agent action mismatch'],
        [verifiedRoute(
            request?.agent?.routeDecision,
            'dag-creator-updater',
            'semantic-proposal'
        ), 'agent route decision mismatch'],
        [
            request?.agent?.executionClass === 'observe-only',
            'agent execution class mismatch'
        ],
        [request?.agent?.freshContext === true, 'fresh context required'],
        [request?.agent?.resident === false, 'resident agent forbidden']
    ]
    for (const [valid, reason] of checks) {
        if (!valid) return denied('dag-launch-denied', reason, base)
    }
    return {
        ...base,
        launchAuthorized: true,
        agentRole: 'dag-creator-updater',
        agentAction: expectedAction,
        oneShot: true
    }
}

export function evaluateDagUpdate({
    previousRemoteSnapshotDigest,
    currentReceipt,
    executionEvents = [],
    launchRequest
}) {
    const initial = previousRemoteSnapshotDigest == null
    const changed = !initial
        && previousRemoteSnapshotDigest !== currentReceipt.remoteSnapshotDigest
    const base = {
        semanticAction: initial ? 'create' : changed ? 'update' : 'none',
        dagCreationRequired: initial,
        dagUpdateRequired: changed,
        launchRequired: initial || changed,
        launchAuthorized: false,
        executionLedgerEvents: executionEvents
    }
    if (!initial && !changed) return base
    if (!launchRequest) {
        return denied('dag-launch-required', 'explicit root launch required', base)
    }
    return authorizeLaunch(
        launchRequest,
        initial ? 'dag-creator' : 'dag-updater',
        base
    )
}

export function validateDagProposalAcceptance({ proposal, acceptance }) {
    const checks = [
        [acceptance?.acceptedBy === 'root-scheduler', 'proposal accepter mismatch'],
        [acceptance?.acceptedWithoutModification === true, 'proposal modification forbidden'],
        [acceptance?.proposalDigest === proposal?.proposalDigest, 'proposal digest mismatch'],
        [
            acceptance?.selectorReceiptDigest === proposal?.selectorReceiptDigest,
            'selector receipt mismatch'
        ],
        [
            acceptance?.remoteSnapshotDigest === proposal?.remoteSnapshotDigest,
            'snapshot digest mismatch'
        ],
        [
            JSON.stringify(acceptance?.resolvedIssueSet) === JSON.stringify(proposal?.resolvedIssueSet),
            'issue set mismatch'
        ]
    ]
    for (const [valid, reason] of checks) {
        if (!valid) return { valid: false, accepted: false, code: 'proposal-mismatch', reason }
    }
    return { valid: true, accepted: true }
}

export function validateDeliveryWindow(window) {
    const fail = (reason) => ({
        valid: false,
        code: 'delivery-window-invalid',
        reason
    })
    if (!window?.grouped) return fail('grouped delivery window required')
    if (!window.preWindowRemoteSnapshotDigest) return fail('pre-window snapshot required')
    if (!window.postWindowReceipt?.remoteSnapshotDigest) {
        return fail('post-window receipt required')
    }
    if (window.memberRefreshes?.length !== 0) return fail('member refresh forbidden')
    if (window.refreshes?.length !== 1) return fail('exactly one post-window refresh required')
    const refresh = window.refreshes[0]
    if (refresh.stage !== 'post-window'
        || refresh.source !== 'live-remote'
        || refresh.observedAfterSideEffects !== true) {
        return fail('post-window live remote refresh required')
    }
    if (refresh.remoteSnapshotDigest !== window.postWindowReceipt.remoteSnapshotDigest) {
        return fail('post-window snapshot digest mismatch')
    }
    if (window.interrupted) {
        if (!window.recovery?.liveSnapshotRefreshedAfterRecovery) {
            return fail('interrupted window recovery refresh required')
        }
        const completed = window.sideEffects
            .filter(({ status }) => status === 'completed')
            .map(({ issueId, action }) => `${issueId}:${action}`)
        const recorded = new Set(
            (window.recovery.recordedCompletedSideEffects ?? [])
                .map(({ issueId, action }) => `${issueId}:${action}`)
        )
        if (completed.some((effect) => !recorded.has(effect))) {
            return fail('completed side effects must be recorded for recovery')
        }
    }
    return {
        valid: true,
        refreshCount: window.refreshes.length,
        memberRefreshCount: window.memberRefreshes.length,
        dagUpdateRequired:
            window.preWindowRemoteSnapshotDigest !== refresh.remoteSnapshotDigest,
        maximumDagUpdaterLaunches: 1,
        interruptedRecoveryVerified: window.interrupted ? true : undefined
    }
}
