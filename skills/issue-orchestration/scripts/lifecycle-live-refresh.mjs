import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    compileLifecycleRunActionSet,
    lifecycleRunObservationContext,
    projectLifecycleRun,
    recordLifecycleBaseChange,
    recordLifecycleScopeRefresh
} from './lifecycle-run-loop.mjs'
import {
    resolveLifecycleSelector,
    repositoryAuthorityFor,
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'
import {
    normalizeRemoteIssueFact,
    remoteIssueFromFact,
    verifySelectorDefinition
} from './scope-selector.mjs'

const REMOTE_OBSERVATION_SCHEMA =
    'issue-orchestration.lifecycle-remote-scope-observation.v1'
const REMOTE_DELTA_REQUEST_SCHEMA =
    'issue-orchestration.lifecycle-remote-scope-delta-request.v1'
const REMOTE_DELTA_OBSERVATION_SCHEMA =
    'issue-orchestration.lifecycle-remote-scope-delta-observation.v1'
const BASE_OBSERVATION_SCHEMA =
    'issue-orchestration.lifecycle-repository-base-observation.v1'
const BASE_OBSERVATION_EPOCH_SCHEMA =
    'issue-orchestration.repository-base-observation-epoch.v1'
const SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const execFileAsync = promisify(execFile)

export class LifecycleLiveRefreshError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'LifecycleLiveRefreshError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new LifecycleLiveRefreshError(code, details)
}

function clone(value) {
    return structuredClone(value)
}

function unsignedDigest(value, field) {
    const copy = clone(value)
    delete copy[field]
    return digest(copy)
}

function requireRefreshActionSet(actionSet) {
    if (actionSet?.schema !==
            'issue-orchestration.lifecycle-action-set.v1' ||
        !Array.isArray(actionSet.actions) ||
        actionSet.actions.length !== 1 ||
        actionSet.actions[0]?.type !== 'refresh-scope') {
        fail('lifecycle-live-refresh-action-unsupported')
    }
    return actionSet
}


function exactKeys(value, expected, code) {
    const actual = Object.keys(value ?? {}).sort()
    const wanted = [...expected].sort()
    if (!sameValue(actual, wanted)) fail(code, { actual, expected: wanted })
}

function issueIdentity(issue) {
    return `${issue.repository}#${issue.number}`
}

function validateRemoteIssueFact(issue, repositories) {
    if (!issue || typeof issue !== 'object' ||
        Array.isArray(issue) ||
        !repositories.has(issue.repository) ||
        !Number.isInteger(issue.number) || issue.number <= 0 ||
        typeof issue.state !== 'string' ||
        typeof issue.updatedAt !== 'string' ||
        typeof issue.title !== 'string' ||
        typeof issue.body !== 'string') {
        fail('lifecycle-remote-issue-fact-invalid')
    }
    const identity = issueIdentity(issue)
    for (const forbidden of [
        'selectorReceipt', 'remoteSnapshotReceipt', 'actionSet',
        'ledger', 'projection', 'lifecycleAuthority'
    ]) {
        if (Object.hasOwn(issue, forbidden)) {
            fail('lifecycle-remote-observation-authority-forbidden', {
                identity,
                field: forbidden
            })
        }
    }
    normalizeRemoteIssueFact(issue)
    return identity
}

function requireObservationIdentity(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function commonDeltaObservationChecks(observation, request) {
    if (observation?.schema !== REMOTE_DELTA_OBSERVATION_SCHEMA ||
        observation.producerAuthority !==
            'trusted-remote-observation-adapter' ||
        observation.rootAuthored !== false ||
        observation.selectorDigest !== request.selectorDigest ||
        observation.remoteQueryIdentity !== request.remoteQueryIdentity ||
        observation.previousRemoteSnapshotDigest !==
            request.previousRemoteSnapshotDigest ||
        observation.previousObservationCursor !==
            request.previousObservationCursor ||
        observation.previousConditionalIdentity !==
            request.previousConditionalIdentity ||
        !sameValue(
            [...(observation.repositories ?? [])].sort(),
            request.repositories
        ) ||
        typeof observation.observedAt !== 'string' ||
        observation.observedAt.length === 0 ||
        observation.observationDigest !==
            unsignedDigest(observation, 'observationDigest')) {
        fail('lifecycle-remote-scope-delta-invalid')
    }
}

function validateRemoteDeltaObservation(observation, request) {
    commonDeltaObservationChecks(observation, request)
    const common = [
        'schema', 'producerAuthority', 'rootAuthored', 'status',
        'selectorDigest', 'remoteQueryIdentity', 'repositories',
        'previousRemoteSnapshotDigest', 'previousObservationCursor',
        'previousConditionalIdentity', 'observedAt', 'observationDigest'
    ]
    if (observation.status === 'unsupported') {
        exactKeys(
            observation,
            common,
            'lifecycle-remote-scope-delta-invalid'
        )
        return observation
    }
    if (observation.status === 'unchanged') {
        exactKeys(
            observation,
            [...common, 'observationCursor', 'conditionalIdentity'],
            'lifecycle-remote-scope-delta-invalid'
        )
        if (observation.observationCursor !==
                request.previousObservationCursor ||
            observation.conditionalIdentity !==
                request.previousConditionalIdentity) {
            fail('lifecycle-remote-scope-delta-unchanged-binding')
        }
        return observation
    }
    if (observation.status !== 'changed') {
        fail('lifecycle-remote-scope-delta-status-invalid')
    }
    exactKeys(
        observation,
        [
            ...common,
            'observationCursor', 'conditionalIdentity',
            'currentIssueIds', 'changedIssues', 'removedIssueIds'
        ],
        'lifecycle-remote-scope-delta-invalid'
    )
    requireObservationIdentity(
        observation.observationCursor,
        'lifecycle-remote-scope-delta-cursor-invalid'
    )
    if (observation.conditionalIdentity !== null) {
        requireObservationIdentity(
            observation.conditionalIdentity,
            'lifecycle-remote-scope-delta-conditional-invalid'
        )
    }
    if (!Array.isArray(observation.currentIssueIds) ||
        !Array.isArray(observation.changedIssues) ||
        !Array.isArray(observation.removedIssueIds)) {
        fail('lifecycle-remote-scope-delta-invalid')
    }
    const currentIssueIds = [...observation.currentIssueIds].sort()
    const removedIssueIds = [...observation.removedIssueIds].sort()
    if (new Set(currentIssueIds).size !== currentIssueIds.length ||
        new Set(removedIssueIds).size !== removedIssueIds.length ||
        !sameValue(currentIssueIds, observation.currentIssueIds) ||
        !sameValue(removedIssueIds, observation.removedIssueIds)) {
        fail('lifecycle-remote-scope-delta-identity-set-invalid')
    }
    const repositories = new Set(request.repositories)
    const changedIds = new Set()
    for (const issue of observation.changedIssues) {
        const identity = validateRemoteIssueFact(issue, repositories)
        if (changedIds.has(identity)) {
            fail('lifecycle-remote-issue-fact-duplicate', { identity })
        }
        changedIds.add(identity)
        if (!currentIssueIds.includes(identity)) {
            fail('lifecycle-remote-scope-delta-changed-outside-current', {
                identity
            })
        }
    }
    for (const identity of [...currentIssueIds, ...removedIssueIds]) {
        const split = identity.lastIndexOf('#')
        if (split <= 0 || !repositories.has(identity.slice(0, split)) ||
            !/^[1-9][0-9]*$/u.test(identity.slice(split + 1))) {
            fail('lifecycle-remote-scope-delta-identity-set-invalid')
        }
    }
    return observation
}

function reconstructDeltaIssues(previousReceipt, observation) {
    const previousFacts = previousReceipt?.remoteIssueFacts
    if (!previousFacts || typeof previousFacts !== 'object' ||
        Array.isArray(previousFacts)) {
        fail('lifecycle-remote-scope-delta-baseline-unavailable')
    }
    const previousIds = Object.keys(previousFacts).sort()
    const currentIds = [...observation.currentIssueIds]
    const currentSet = new Set(currentIds)
    const expectedRemoved = previousIds.filter((id) => !currentSet.has(id))
    if (!sameValue(expectedRemoved, observation.removedIssueIds)) {
        fail('lifecycle-remote-scope-delta-removal-mismatch')
    }
    const facts = new Map(Object.entries(previousFacts).map(([id, fact]) => [
        id,
        clone(fact)
    ]))
    for (const id of observation.removedIssueIds) facts.delete(id)
    for (const issue of observation.changedIssues) {
        facts.set(issueIdentity(issue), normalizeRemoteIssueFact(issue))
    }
    const missing = currentIds.filter((id) => !facts.has(id))
    if (missing.length > 0 || facts.size !== currentIds.length) {
        fail('lifecycle-remote-scope-delta-partial', { missing })
    }
    return currentIds.map((id) => remoteIssueFromFact(facts.get(id)))
}

function recordRefreshDiagnostics(target, values) {
    if (target === undefined || target === null) return
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        fail('lifecycle-remote-scope-diagnostics-invalid')
    }
    Object.assign(target, values)
}

function validateRemoteObservation(observation, request) {
    if (observation?.schema !== REMOTE_OBSERVATION_SCHEMA ||
        observation.producerAuthority !==
            'trusted-remote-observation-adapter' ||
        observation.rootAuthored !== false ||
        observation.selectorDigest !== request.selectorDigest ||
        observation.remoteQueryIdentity !==
            request.remoteQueryIdentity ||
        !sameValue(
            [...(observation.repositories ?? [])].sort(),
            request.repositories
        ) ||
        !Array.isArray(observation.issues) ||
        typeof observation.observedAt !== 'string' ||
        observation.observedAt.length === 0 ||
        observation.observationDigest !==
            unsignedDigest(observation, 'observationDigest')) {
        fail('lifecycle-remote-scope-observation-invalid')
    }
    if (observation.observationCursor !== undefined &&
        observation.observationCursor !== null) {
        requireObservationIdentity(
            observation.observationCursor,
            'lifecycle-remote-scope-observation-cursor-invalid'
        )
    }
    if (observation.conditionalIdentity !== undefined &&
        observation.conditionalIdentity !== null) {
        requireObservationIdentity(
            observation.conditionalIdentity,
            'lifecycle-remote-scope-observation-conditional-invalid'
        )
    }
    const repositories = new Set(request.repositories)
    const identities = new Set()
    for (const issue of observation.issues) {
        const identity = validateRemoteIssueFact(issue, repositories)
        if (identities.has(identity)) {
            fail('lifecycle-remote-issue-fact-duplicate', { identity })
        }
        identities.add(identity)
    }
    return observation
}

export function executeLifecycleScopeRefresh({
    ledger,
    actionSet,
    observeRemoteIssues,
    observeRemoteIssueDelta = null,
    diagnostics = null,
    createdAt,
    startup
} = {}) {
    if (actionSet !== undefined && actionSet !== null) {
        requireRefreshActionSet(actionSet)
    }
    if (typeof observeRemoteIssues !== 'function') {
        fail('lifecycle-remote-observer-required')
    }
    if (observeRemoteIssueDelta !== null &&
        typeof observeRemoteIssueDelta !== 'function') {
        fail('lifecycle-remote-delta-observer-invalid')
    }
    const context = lifecycleRunObservationContext(ledger, { startup })
    validateLifecycleRunAuthority(context.lifecycleAuthority, {
        startup,
        expectedRunId: context.runId,
        expectedStateRoot: context.stateRoot
    })
    const selector = verifySelectorDefinition(
        context.selectorDefinition,
        context.selectorReceipt
    )
    const commonRequest = {
        runId: context.runId,
        repositories: [...selector.repositories].sort(),
        selector: clone(selector),
        selectorDigest: context.selectorReceipt.selectorDigest,
        remoteQueryIdentity: selector.remoteQueryIdentity,
        previousSelectorReceiptDigest:
            context.selectorReceipt.receiptDigest,
        previousRemoteSnapshotDigest:
            context.selectorReceipt.remoteSnapshotDigest,
        lifecycleAuthorityBindingDigest:
            context.lifecycleAuthority.binding.bindingDigest
    }

    let remoteIssues
    let resolvedAt
    let remoteObservationCursor = null
    let remoteConditionalIdentity = null
    let mode = 'full'
    let fallbackReason = null
    let remoteFactsTransferred = 0
    let selectorRebuildCount = 0

    if (observeRemoteIssueDelta &&
        context.selectorReceipt.remoteObservationCursor !== null) {
        const deltaRequest = Object.freeze({
            schema: REMOTE_DELTA_REQUEST_SCHEMA,
            ...commonRequest,
            previousObservationCursor:
                context.selectorReceipt.remoteObservationCursor,
            previousConditionalIdentity:
                context.selectorReceipt.remoteConditionalIdentity
        })
        const delta = validateRemoteDeltaObservation(
            observeRemoteIssueDelta(deltaRequest),
            deltaRequest
        )
        if (delta.status === 'unchanged') {
            recordRefreshDiagnostics(diagnostics, {
                mode: 'unchanged',
                fallbackReason: null,
                remoteFactsTransferred: 0,
                selectorRebuildCount: 0
            })
            return ledger
        }
        if (delta.status === 'changed') {
            remoteIssues = reconstructDeltaIssues(
                context.selectorReceipt,
                delta
            )
            resolvedAt = delta.observedAt
            remoteObservationCursor = delta.observationCursor
            remoteConditionalIdentity = delta.conditionalIdentity
            mode = 'delta'
            remoteFactsTransferred = delta.changedIssues.length
        } else {
            fallbackReason = 'adapter-unsupported'
        }
    } else if (observeRemoteIssueDelta) {
        fallbackReason = 'baseline-cursor-unavailable'
    }

    if (!remoteIssues) {
        const request = Object.freeze({
            schema:
                'issue-orchestration.lifecycle-remote-scope-request.v1',
            ...commonRequest
        })
        const observation = validateRemoteObservation(
            observeRemoteIssues(request),
            request
        )
        remoteIssues = clone(observation.issues)
        resolvedAt = observation.observedAt
        remoteObservationCursor = observation.observationCursor ?? null
        remoteConditionalIdentity = observation.conditionalIdentity ?? null
        mode = fallbackReason ? 'full-fallback' : 'full'
        remoteFactsTransferred = observation.issues.length
    }

    selectorRebuildCount = 1
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: context.lifecycleAuthority,
        startup,
        selector,
        remoteIssues,
        previousReceipt: context.selectorReceipt,
        resolvedAt,
        remoteObservationCursor,
        remoteConditionalIdentity
    })
    recordRefreshDiagnostics(diagnostics, {
        mode,
        fallbackReason,
        remoteFactsTransferred,
        selectorRebuildCount
    })
    if (selectorReceipt.remoteSnapshotDigest ===
            context.selectorReceipt.remoteSnapshotDigest) {
        return ledger
    }
    const current = compileLifecycleRunActionSet(ledger, {
        observedSelectorReceipt: selectorReceipt,
        startup
    })
    if (current.actions.length !== 1 ||
        current.actions[0].type !== 'refresh-scope') {
        fail('lifecycle-live-refresh-action-not-required')
    }
    if (actionSet !== undefined && actionSet !== null &&
        !sameValue(current, actionSet)) {
        fail('lifecycle-live-refresh-action-stale')
    }
    return recordLifecycleScopeRefresh({
        ledger,
        actionSet: current,
        selectorReceipt,
        createdAt: createdAt ?? resolvedAt,
        startup
    })
}

function git(repositoryPath, args, code) {
    try {
        return execFileSync('git', ['-C', repositoryPath, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
    } catch {
        fail(code)
    }
}

function remoteDefaultBranch(repositoryPath) {
    const output = git(
        repositoryPath,
        ['ls-remote', '--symref', 'origin', 'HEAD'],
        'lifecycle-base-remote-observation-failed'
    )
    const branch = output.match(
        /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu
    )?.[1]
    const head = output.match(/^([a-f0-9]{40})\s+HEAD$/mu)?.[1]
    if (!branch || !head) {
        fail('lifecycle-base-remote-observation-invalid')
    }
    return { branch, head }
}

function observeRepository(binding) {
    const canonicalPath = path.resolve(
        git(binding.canonicalPath, ['rev-parse', '--show-toplevel'],
            'lifecycle-base-repository-unobservable')
    )
    const commonDir = path.resolve(
        binding.canonicalPath,
        git(binding.canonicalPath, ['rev-parse', '--git-common-dir'],
            'lifecycle-base-git-identity-unobservable')
    )
    const origin = git(
        binding.canonicalPath,
        ['config', '--get', 'remote.origin.url'],
        'lifecycle-base-origin-unobservable'
    )
    const remote = remoteDefaultBranch(binding.canonicalPath)
    const localHead = git(
        binding.canonicalPath,
        ['rev-parse', 'HEAD'],
        'lifecycle-base-local-head-unobservable'
    )
    const dirtyEntries = git(
        binding.canonicalPath,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        'lifecycle-base-dirty-state-unobservable'
    ).split('\n').filter(Boolean)
    const observation = {
        schema: BASE_OBSERVATION_SCHEMA,
        status: 'observed',
        producerAuthority: 'trusted-git-runtime-observer',
        rootAuthored: false,
        repository: binding.repository,
        canonicalPath,
        commonDir,
        origin,
        defaultBranch: remote.branch,
        localHead,
        remoteDefaultBranchHead: remote.head,
        dirtyEntries,
        repositoryBindingDigest: binding.bindingDigest
    }
    observation.observationDigest = digest(observation)
    return Object.freeze(observation)
}

async function gitObserved(repositoryPath, args, code) {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['-C', repositoryPath, ...args],
            {
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024
            }
        )
        return stdout.trim()
    } catch {
        fail(code)
    }
}

function parseRemoteDefaultBranch(output) {
    const branch = output.match(
        /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu
    )?.[1]
    const head = output.match(/^([a-f0-9]{40})\s+HEAD$/mu)?.[1]
    if (!branch || !head) {
        fail('lifecycle-base-remote-observation-invalid')
    }
    return { branch, head }
}

async function observeRepositoryForEpoch(binding) {
    const [
        topLevel,
        commonDirectory,
        origin,
        remoteOutput,
        localHead,
        dirtyOutput
    ] = await Promise.all([
        gitObserved(
            binding.canonicalPath,
            ['rev-parse', '--show-toplevel'],
            'lifecycle-base-repository-unobservable'
        ),
        gitObserved(
            binding.canonicalPath,
            ['rev-parse', '--git-common-dir'],
            'lifecycle-base-git-identity-unobservable'
        ),
        gitObserved(
            binding.canonicalPath,
            ['config', '--get', 'remote.origin.url'],
            'lifecycle-base-origin-unobservable'
        ),
        gitObserved(
            binding.canonicalPath,
            ['ls-remote', '--symref', 'origin', 'HEAD'],
            'lifecycle-base-remote-observation-failed'
        ),
        gitObserved(
            binding.canonicalPath,
            ['rev-parse', 'HEAD'],
            'lifecycle-base-local-head-unobservable'
        ),
        gitObserved(
            binding.canonicalPath,
            ['status', '--porcelain=v1', '--untracked-files=all'],
            'lifecycle-base-dirty-state-unobservable'
        )
    ])
    const remote = parseRemoteDefaultBranch(remoteOutput)
    const observation = {
        schema: BASE_OBSERVATION_SCHEMA,
        status: 'observed',
        producerAuthority: 'trusted-git-runtime-observer',
        rootAuthored: false,
        repository: binding.repository,
        canonicalPath: path.resolve(topLevel),
        commonDir: path.resolve(binding.canonicalPath, commonDirectory),
        origin,
        defaultBranch: remote.branch,
        localHead,
        remoteDefaultBranchHead: remote.head,
        dirtyEntries: dirtyOutput.split('\n').filter(Boolean),
        repositoryBindingDigest: binding.bindingDigest
    }
    observation.observationDigest = digest(observation)
    return Object.freeze(observation)
}

function actionRepositoryBindings(action) {
    const bindings = action?.bindings
    if (!bindings || typeof bindings !== 'object') {
        fail('lifecycle-base-action-bindings-invalid')
    }
    if (typeof bindings.repository === 'string' &&
        SHA.test(bindings.baseSha ?? '')) {
        return [{
            repository: bindings.repository,
            baseSha: bindings.baseSha
        }]
    }
    if (Array.isArray(bindings.memberBindings) &&
        bindings.memberBindings.length > 0) {
        return [...new Map(bindings.memberBindings.map((member) => {
            if (typeof member.repository !== 'string' ||
                !SHA.test(member.baseSha ?? '')) {
                fail('lifecycle-base-action-bindings-invalid')
            }
            return [member.repository, {
                repository: member.repository,
                baseSha: member.baseSha
            }]
        })).values()].sort((left, right) =>
            left.repository.localeCompare(right.repository))
    }
    fail('lifecycle-base-action-unsupported')
}

function epochPhase(value) {
    if (!['pre-dispatch', 'post-admission'].includes(value)) {
        fail('lifecycle-base-epoch-phase-invalid')
    }
    return value
}

function requireEpochTimestamp(value) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        fail('lifecycle-base-epoch-time-invalid')
    }
    return value
}

function preDispatchSubjects({ ledger, actionSet, actions, startup }) {
    const current = compileLifecycleRunActionSet(ledger, { startup })
    if (!sameValue(current, actionSet)) {
        fail('lifecycle-base-action-set-stale')
    }
    if (!Array.isArray(actions) || actions.length === 0) {
        fail('lifecycle-base-epoch-actions-required')
    }
    const currentByDigest = new Map(current.actions.map((action) => [
        action.actionDigest,
        action
    ]))
    const seen = new Set()
    return actions.map((candidate) => {
        const action = currentByDigest.get(candidate?.actionDigest)
        if (!action || !sameValue(action, candidate) ||
            ['refresh-scope', 'idle'].includes(action.type) ||
            seen.has(action.actionDigest)) {
            fail('lifecycle-base-epoch-action-invalid')
        }
        seen.add(action.actionDigest)
        return {
            action,
            dispatchId: null,
            actionSetDigest: current.actionSetDigest
        }
    }).sort((left, right) =>
        left.action.actionDigest.localeCompare(right.action.actionDigest))
}

function postAdmissionSubjects({ ledger, dispatches, startup }) {
    if (!Array.isArray(dispatches) || dispatches.length === 0) {
        fail('lifecycle-base-epoch-dispatches-required')
    }
    const projection = projectLifecycleRun(ledger, { startup })
    const active = projection.aggregateProjection.activeDispatches ?? {}
    const seen = new Set()
    return dispatches.map((candidate) => {
        const dispatch = active[candidate?.dispatchId]
        if (!dispatch || !sameValue(dispatch, candidate) ||
            seen.has(dispatch.dispatchId)) {
            fail('lifecycle-base-epoch-dispatch-invalid')
        }
        seen.add(dispatch.dispatchId)
        return {
            action: dispatch.action,
            dispatchId: dispatch.dispatchId,
            actionSetDigest: dispatch.actionSetDigest
        }
    }).sort((left, right) =>
        left.dispatchId.localeCompare(right.dispatchId))
}

function epochActionBindings(subjects) {
    return subjects.map(({ action, dispatchId, actionSetDigest }) => ({
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        dispatchId,
        actionSetDigest,
        actionBindingsDigest: digest(action.bindings),
        repositories: actionRepositoryBindings(action)
    }))
}

function expectedRepositories(actionBindings) {
    const expected = new Map()
    for (const action of actionBindings) {
        for (const repository of action.repositories) {
            const prior = expected.get(repository.repository)
            if (prior && prior.baseSha !== repository.baseSha) {
                fail('lifecycle-base-epoch-conflicting-base', {
                    repository: repository.repository,
                    expectedBaseShas: [prior.baseSha, repository.baseSha]
                        .sort()
                })
            }
            expected.set(repository.repository, repository)
        }
    }
    return [...expected.values()].sort((left, right) =>
        left.repository.localeCompare(right.repository))
}

function validateEpochRepositoryIdentity({
    binding,
    expected,
    observation,
    phase
}) {
    if (observation.canonicalPath !== path.resolve(binding.canonicalPath) ||
        observation.origin !== binding.remoteUrl ||
        observation.defaultBranch !== binding.defaultBranch ||
        observation.repositoryBindingDigest !== binding.bindingDigest) {
        fail(
            phase === 'post-admission'
                ? 'lifecycle-active-base-repository-identity-drift'
                : 'lifecycle-base-repository-identity-drift',
            { repository: expected.repository }
        )
    }
}

function epochId(value) {
    return digest({
        phase: value.phase,
        runId: value.runId,
        controlLedgerHeadDigest: value.controlLedgerHeadDigest,
        lifecycleAuthorityBindingDigest:
            value.lifecycleAuthorityBindingDigest,
        rootAuthorityEpoch: value.rootAuthorityEpoch,
        actionBindingSetDigest: value.actionBindingSetDigest,
        repositoryExpectationSetDigest:
            value.repositoryExpectationSetDigest
    })
}

function validateEpochReceiptShape(receipt) {
    if (receipt?.schema !== BASE_OBSERVATION_EPOCH_SCHEMA ||
        !['current', 'rebound', 'stale'].includes(receipt.status) ||
        receipt.producerAuthority !== 'trusted-git-runtime-observer' ||
        receipt.rootAuthored !== false ||
        typeof receipt.runId !== 'string' ||
        !HASH.test(receipt.controlLedgerHeadDigest ?? '') ||
        !HASH.test(receipt.lifecycleAuthorityBindingDigest ?? '') ||
        !HASH.test(receipt.startupAttestationDigest ?? '') ||
        typeof receipt.runtimeInvocationId !== 'string' ||
        typeof receipt.rootAuthorityEpoch !== 'string' ||
        !HASH.test(receipt.packageDigest ?? '') ||
        !HASH.test(receipt.policySetDigest ?? '') ||
        !HASH.test(receipt.actionBindingSetDigest ?? '') ||
        !HASH.test(receipt.repositoryExpectationSetDigest ?? '') ||
        !HASH.test(receipt.epochId ?? '') ||
        !Array.isArray(receipt.actionBindings) ||
        receipt.actionBindings.length === 0 ||
        !Array.isArray(receipt.repositories) ||
        receipt.repositories.length === 0 ||
        !Array.isArray(receipt.driftedRepositories) ||
        typeof receipt.reusable !== 'boolean' ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest') ||
        receipt.epochId !== epochId(receipt) ||
        receipt.actionBindingSetDigest !== digest(receipt.actionBindings) ||
        receipt.repositoryExpectationSetDigest !== digest(
            receipt.repositories.map(({ repository, expectedBaseSha,
                repositoryBindingDigest }) => ({
                repository,
                expectedBaseSha,
                repositoryBindingDigest
            }))
        )) {
        fail('lifecycle-base-epoch-receipt-invalid')
    }
    epochPhase(receipt.phase)
    requireEpochTimestamp(receipt.observedAt)
    return receipt
}

export function verifyLifecycleRepositoryBaseObservationEpoch({
    ledger,
    receipt,
    startup
} = {}) {
    validateEpochReceiptShape(receipt)
    const context = lifecycleRunObservationContext(ledger, { startup })
    const authority = context.lifecycleAuthority.binding
    if (receipt.runId !== context.runId ||
        receipt.controlLedgerHeadDigest !==
            context.controlLedgerHeadDigest ||
        receipt.lifecycleAuthorityBindingDigest !==
            authority.bindingDigest ||
        receipt.startupAttestationDigest !==
            authority.startupAttestationDigest ||
        receipt.runtimeInvocationId !== authority.runtimeInvocationId ||
        receipt.rootAuthorityEpoch !== authority.rootAuthorityEpoch ||
        receipt.packageDigest !== authority.packageDigest ||
        receipt.policySetDigest !== authority.policySetDigest) {
        fail('lifecycle-base-epoch-stale')
    }
    const seenActions = new Set()
    for (const action of receipt.actionBindings) {
        const identity = `${action.dispatchId ?? 'pre'}:${action.actionDigest}`
        if (!HASH.test(action?.actionDigest ?? '') ||
            typeof action.actionType !== 'string' ||
            action.actionType.length === 0 ||
            ![null, 'string'].includes(
                action.nodeId === null ? null : typeof action.nodeId
            ) ||
            !HASH.test(action.actionSetDigest ?? '') ||
            !HASH.test(action.actionBindingsDigest ?? '') ||
            !Array.isArray(action.repositories) ||
            action.repositories.length === 0 ||
            seenActions.has(identity) ||
            (receipt.phase === 'pre-dispatch' &&
                action.dispatchId !== null) ||
            (receipt.phase === 'post-admission' &&
                (typeof action.dispatchId !== 'string' ||
                    action.dispatchId.length === 0))) {
            fail('lifecycle-base-epoch-action-binding-invalid')
        }
        seenActions.add(identity)
        const repositoryNames = new Set()
        for (const expected of action.repositories) {
            if (typeof expected?.repository !== 'string' ||
                !SHA.test(expected.baseSha ?? '') ||
                repositoryNames.has(expected.repository)) {
                fail('lifecycle-base-epoch-action-binding-invalid')
            }
            repositoryNames.add(expected.repository)
        }
    }
    const expectedByAction = expectedRepositories(receipt.actionBindings)
    const expectationByRepository = new Map(expectedByAction.map(
        (entry) => [entry.repository, entry.baseSha]
    ))
    if (expectationByRepository.size !== receipt.repositories.length) {
        fail('lifecycle-base-epoch-repository-set-invalid')
    }
    const drifted = []
    const seenRepositories = new Set()
    for (const entry of receipt.repositories) {
        if (typeof entry?.repository !== 'string' ||
            !SHA.test(entry.expectedBaseSha ?? '') ||
            !HASH.test(entry.repositoryBindingDigest ?? '') ||
            seenRepositories.has(entry.repository) ||
            expectationByRepository.get(entry.repository) !==
                entry.expectedBaseSha ||
            entry.observation?.schema !== BASE_OBSERVATION_SCHEMA ||
            entry.observation.status !== 'observed' ||
            entry.observation.producerAuthority !==
                'trusted-git-runtime-observer' ||
            entry.observation.rootAuthored !== false ||
            entry.observation.repository !== entry.repository ||
            !Array.isArray(entry.observation.dirtyEntries) ||
            entry.observation?.observationDigest !==
                unsignedDigest(entry.observation, 'observationDigest')) {
            fail('lifecycle-base-epoch-repository-invalid')
        }
        seenRepositories.add(entry.repository)
        const binding = repositoryAuthorityFor(
            context.lifecycleAuthority,
            entry.repository
        )
        if (entry.repositoryBindingDigest !== binding.bindingDigest) {
            fail('lifecycle-base-epoch-repository-binding-stale', {
                repository: entry.repository
            })
        }
        validateEpochRepositoryIdentity({
            binding,
            expected: entry,
            observation: entry.observation,
            phase: receipt.phase
        })
        if (entry.observation.remoteDefaultBranchHead !==
                entry.expectedBaseSha) {
            drifted.push(entry.repository)
        }
    }
    if (!sameValue(drifted.sort(), [...receipt.driftedRepositories].sort()) ||
        receipt.reusable !== (receipt.status === 'current') ||
        (receipt.status === 'current') !== (drifted.length === 0) ||
        (receipt.phase === 'pre-dispatch' && drifted.length > 0 &&
            receipt.status !== 'rebound') ||
        (receipt.phase === 'post-admission' && drifted.length > 0 &&
            receipt.status !== 'stale')) {
        fail('lifecycle-base-epoch-status-invalid')
    }
    return receipt
}

export function consumeLifecycleRepositoryBaseObservationEpoch({
    ledger,
    receipt,
    action,
    dispatchId = null,
    startup
} = {}) {
    verifyLifecycleRepositoryBaseObservationEpoch({
        ledger,
        receipt,
        startup
    })
    if (receipt.status !== 'current') {
        fail('lifecycle-base-epoch-not-current')
    }
    const binding = receipt.actionBindings.find((candidate) =>
        candidate.actionDigest === action?.actionDigest &&
        candidate.dispatchId === dispatchId)
    if (!binding || binding.actionType !== action.type ||
        binding.nodeId !== (action.nodeId ?? null) ||
        binding.actionBindingsDigest !== digest(action.bindings) ||
        !sameValue(binding.repositories, actionRepositoryBindings(action))) {
        fail('lifecycle-base-epoch-action-binding-invalid')
    }
    return Object.freeze({
        schema: 'issue-orchestration.repository-base-epoch-consumption.v1',
        epochId: receipt.epochId,
        actionDigest: action.actionDigest,
        dispatchId,
        repositoryObservationDigests: binding.repositories.map(
            ({ repository }) => receipt.repositories.find(
                (entry) => entry.repository === repository
            ).observation.observationDigest
        )
    })
}

export async function observeLifecycleRepositoryBaseEpoch({
    ledger,
    actionSet,
    actions,
    dispatches,
    phase,
    observedAt,
    startup
} = {}) {
    const selectedPhase = epochPhase(phase)
    const subjects = selectedPhase === 'pre-dispatch'
        ? preDispatchSubjects({ ledger, actionSet, actions, startup })
        : postAdmissionSubjects({ ledger, dispatches, startup })
    const actionBindings = epochActionBindings(subjects)
    const repositories = expectedRepositories(actionBindings)
    const context = lifecycleRunObservationContext(ledger, { startup })
    const repositoryEntries = await Promise.all(repositories.map(
        async (expected) => {
            const binding = repositoryAuthorityFor(
                context.lifecycleAuthority,
                expected.repository
            )
            const observation = await observeRepositoryForEpoch(binding)
            validateEpochRepositoryIdentity({
                binding,
                expected,
                observation,
                phase: selectedPhase
            })
            return Object.freeze({
                repository: expected.repository,
                expectedBaseSha: expected.baseSha,
                repositoryBindingDigest: binding.bindingDigest,
                observation
            })
        }
    ))
    const driftedRepositories = repositoryEntries
        .filter(({ expectedBaseSha, observation }) =>
            observation.remoteDefaultBranchHead !== expectedBaseSha)
        .map(({ repository }) => repository)
        .sort()
    const status = driftedRepositories.length === 0
        ? 'current'
        : selectedPhase === 'pre-dispatch' ? 'rebound' : 'stale'
    const authority = context.lifecycleAuthority.binding
    const receipt = {
        schema: BASE_OBSERVATION_EPOCH_SCHEMA,
        status,
        phase: selectedPhase,
        producerAuthority: 'trusted-git-runtime-observer',
        rootAuthored: false,
        runId: context.runId,
        observedAt: requireEpochTimestamp(observedAt),
        controlLedgerHeadDigest: context.controlLedgerHeadDigest,
        lifecycleAuthorityBindingDigest: authority.bindingDigest,
        startupAttestationDigest: authority.startupAttestationDigest,
        runtimeInvocationId: authority.runtimeInvocationId,
        rootAuthorityEpoch: authority.rootAuthorityEpoch,
        packageDigest: authority.packageDigest,
        policySetDigest: authority.policySetDigest,
        actionBindings,
        actionBindingSetDigest: digest(actionBindings),
        repositories: repositoryEntries,
        repositoryExpectationSetDigest: digest(repositoryEntries.map(
            ({ repository, expectedBaseSha, repositoryBindingDigest }) => ({
                repository,
                expectedBaseSha,
                repositoryBindingDigest
            })
        )),
        driftedRepositories,
        reusable: status === 'current'
    }
    receipt.epochId = epochId(receipt)
    receipt.receiptDigest = digest(receipt)
    const verified = Object.freeze(validateEpochReceiptShape(receipt))
    if (status !== 'rebound') {
        return Object.freeze({ receipt: verified, ledger })
    }
    const repository = driftedRepositories[0]
    const current = repositoryEntries.find((entry) =>
        entry.repository === repository)
    return Object.freeze({
        receipt: verified,
        ledger: recordLifecycleBaseChange({
            ledger,
            repository,
            baseSha: current.observation.remoteDefaultBranchHead,
            createdAt: observedAt,
            startup
        })
    })
}

export function observeLifecycleRepositoryBaseBeforeAction({
    ledger,
    actionSet,
    actionDigest,
    createdAt,
    startup
} = {}) {
    const current = compileLifecycleRunActionSet(ledger, { startup })
    if (!sameValue(current, actionSet)) {
        fail('lifecycle-base-action-set-stale')
    }
    const action = actionSet.actions.find(
        (candidate) => candidate.actionDigest === actionDigest
    )
    if (!action || ['refresh-scope', 'idle'].includes(action.type)) {
        fail('lifecycle-base-action-unsupported')
    }
    const expectedRepositories = actionRepositoryBindings(action)
    const context = lifecycleRunObservationContext(ledger, { startup })
    const observations = []
    for (const expected of expectedRepositories) {
        const binding = repositoryAuthorityFor(
            context.lifecycleAuthority,
            expected.repository
        )
        const observation = observeRepository(binding)
        observations.push(observation)
        if (observation.canonicalPath !==
                path.resolve(binding.canonicalPath) ||
            observation.origin !== binding.remoteUrl ||
            observation.defaultBranch !== binding.defaultBranch ||
            observation.repositoryBindingDigest !==
                binding.bindingDigest) {
            fail('lifecycle-base-repository-identity-drift', {
                repository: expected.repository
            })
        }
        if (observation.remoteDefaultBranchHead !== expected.baseSha) {
            const next = recordLifecycleBaseChange({
                ledger,
                repository: expected.repository,
                baseSha: observation.remoteDefaultBranchHead,
                createdAt,
                startup
            })
            return Object.freeze({
                schema:
                    'issue-orchestration.lifecycle-base-refresh-result.v1',
                status: 'rebound',
                staleActionDigest: action.actionDigest,
                repository: expected.repository,
                priorBaseSha: expected.baseSha,
                currentBaseSha:
                    observation.remoteDefaultBranchHead,
                observations,
                ledger: next
            })
        }
    }
    const receipt = {
        schema: 'issue-orchestration.lifecycle-base-refresh-result.v1',
        status: 'current',
        actionDigest: action.actionDigest,
        observations
    }
    receipt.receiptDigest = digest(receipt)
    return Object.freeze(receipt)
}

export function observeLifecycleRepositoryBaseForActiveAction({
    ledger,
    action,
    startup
} = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action) ||
        typeof action.actionDigest !== 'string') {
        fail('lifecycle-active-base-action-invalid')
    }
    const expectedRepositories = actionRepositoryBindings(action)
    const context = lifecycleRunObservationContext(ledger, { startup })
    validateLifecycleRunAuthority(context.lifecycleAuthority, {
        startup,
        expectedRunId: context.runId,
        expectedStateRoot: context.stateRoot
    })
    const observations = []
    for (const expected of expectedRepositories) {
        const binding = repositoryAuthorityFor(
            context.lifecycleAuthority,
            expected.repository
        )
        const observation = observeRepository(binding)
        observations.push(observation)
        if (observation.canonicalPath !==
                path.resolve(binding.canonicalPath) ||
            observation.origin !== binding.remoteUrl ||
            observation.defaultBranch !== binding.defaultBranch ||
            observation.repositoryBindingDigest !==
                binding.bindingDigest) {
            fail('lifecycle-active-base-repository-identity-drift', {
                repository: expected.repository
            })
        }
        if (observation.remoteDefaultBranchHead !== expected.baseSha) {
            return Object.freeze({
                schema:
                    'issue-orchestration.lifecycle-active-base-observation.v1',
                status: 'stale',
                actionDigest: action.actionDigest,
                repository: expected.repository,
                expectedBaseSha: expected.baseSha,
                currentBaseSha:
                    observation.remoteDefaultBranchHead,
                observations
            })
        }
    }
    return Object.freeze({
        schema:
            'issue-orchestration.lifecycle-active-base-observation.v1',
        status: 'current',
        actionDigest: action.actionDigest,
        observations
    })
}

export function lifecycleLiveRefreshSchemas() {
    return Object.freeze({
        remoteObservation: REMOTE_OBSERVATION_SCHEMA,
        baseObservation: BASE_OBSERVATION_SCHEMA,
        baseObservationEpoch: BASE_OBSERVATION_EPOCH_SCHEMA
    })
}
