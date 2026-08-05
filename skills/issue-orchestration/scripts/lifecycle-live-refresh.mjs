import { execFileSync } from 'node:child_process'
import path from 'node:path'

import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    compileLifecycleRunActionSet,
    lifecycleRunObservationContext,
    recordLifecycleBaseChange,
    recordLifecycleScopeRefresh
} from './lifecycle-run-loop.mjs'
import {
    resolveLifecycleSelector,
    repositoryAuthorityFor,
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'
import {
    verifySelectorDefinition
} from './scope-selector.mjs'

const REMOTE_OBSERVATION_SCHEMA =
    'issue-orchestration.lifecycle-remote-scope-observation.v1'
const BASE_OBSERVATION_SCHEMA =
    'issue-orchestration.lifecycle-repository-base-observation.v1'
const SHA = /^[a-f0-9]{40}$/u

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
    const repositories = new Set(request.repositories)
    const identities = new Set()
    for (const issue of observation.issues) {
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
        const identity = `${issue.repository}#${issue.number}`
        if (identities.has(identity)) {
            fail('lifecycle-remote-issue-fact-duplicate', { identity })
        }
        identities.add(identity)
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
    }
    return observation
}

export function executeLifecycleScopeRefresh({
    ledger,
    actionSet,
    observeRemoteIssues,
    createdAt,
    startup
} = {}) {
    if (actionSet !== undefined && actionSet !== null) {
        requireRefreshActionSet(actionSet)
    }
    if (typeof observeRemoteIssues !== 'function') {
        fail('lifecycle-remote-observer-required')
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
    const request = Object.freeze({
        schema:
            'issue-orchestration.lifecycle-remote-scope-request.v1',
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
    })
    const observation = validateRemoteObservation(
        observeRemoteIssues(request),
        request
    )
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: context.lifecycleAuthority,
        startup,
        selector,
        remoteIssues: clone(observation.issues),
        previousReceipt: context.selectorReceipt,
        resolvedAt: observation.observedAt
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
        createdAt: createdAt ?? observation.observedAt,
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
        baseObservation: BASE_OBSERVATION_SCHEMA
    })
}
