import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
    assertDigest,
    assertText,
    digest,
    fail,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    STAGE_ROUTE_DEFINITIONS
} from './stage-profile-policy.mjs'
import {
    validateRuntimeExecutionBinding,
    validateRuntimeInspectionBinding
} from './runtime-execution-binding.mjs'

const POLICY_PATH = path.resolve(
    import.meta.dirname,
    '../../../policy/stage-mutation-guard-policy.json'
)

export const STAGE_MUTATION_GUARD_POLICY = Object.freeze(
    JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
)
export const STAGE_MUTATION_GUARD_POLICY_DIGEST =
    digest(STAGE_MUTATION_GUARD_POLICY)

const SHA = /^[a-f0-9]{40}$/u

function git(repositoryPath, args, { buffer = false } = {}) {
    try {
        return execFileSync('git', [
            '-C',
            repositoryPath,
            ...args
        ], buffer ? { timeout: 10_000 } : {
            encoding: 'utf8',
            timeout: 10_000
        })
    } catch {
        fail('stage-mutation-git-observation-failed')
    }
}

function nulList(value) {
    return value.toString('utf8').split('\0').filter(Boolean)
}

function normalizeRelative(value) {
    assertText(value, 'stage-mutation-path-invalid')
    const normalized = value.replaceAll('\\', '/')
    if (path.posix.isAbsolute(normalized) ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.includes('/../') ||
        normalized === '.git' ||
        normalized.startsWith('.git/')) {
        fail('stage-mutation-path-invalid')
    }
    return normalized.replace(/^\.\//u, '')
}

function fileEntry(root, relative) {
    const normalized = normalizeRelative(relative)
    const target = path.resolve(root, normalized)
    const expectedRoot = `${path.resolve(root)}${path.sep}`
    if (!target.startsWith(expectedRoot)) {
        fail('stage-mutation-path-invalid')
    }
    let stat
    try {
        stat = fs.lstatSync(target)
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {
                path: normalized,
                kind: 'missing',
                digest: digest('missing')
            }
        }
        throw error
    }
    if (stat.isSymbolicLink()) {
        return {
            path: normalized,
            kind: 'symlink',
            digest: digest(fs.readlinkSync(target))
        }
    }
    if (!stat.isFile()) fail('stage-mutation-path-type-invalid')
    return {
        path: normalized,
        kind: 'file',
        digest: digest(fs.readFileSync(target))
    }
}

function treeEntries(root, relative = '') {
    const target = path.join(root, relative)
    const entries = fs.readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
    return entries.flatMap((entry) => {
        const child = relative
            ? `${relative}/${entry.name}`
            : entry.name
        if (entry.isDirectory()) return treeEntries(root, child)
        return [fileEntry(root, child)]
    })
}

function trackedEntries(repositoryPath) {
    return nulList(git(
        repositoryPath,
        ['ls-files', '-z'],
        { buffer: true }
    )).sort().map((relative) => fileEntry(repositoryPath, relative))
}

function untrackedEntries(repositoryPath) {
    return nulList(git(
        repositoryPath,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        { buffer: true }
    )).sort().map((relative) => fileEntry(repositoryPath, relative))
}

function statusEntries(repositoryPath) {
    const raw = nulList(git(
        repositoryPath,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { buffer: true }
    ))
    const paths = []
    for (let index = 0; index < raw.length; index += 1) {
        const record = raw[index]
        if (record.length < 4) continue
        paths.push(normalizeRelative(record.slice(3)))
        if (record[0] === 'R' || record[0] === 'C') {
            index += 1
            if (raw[index]) paths.push(normalizeRelative(raw[index]))
        }
    }
    return [...new Set(paths)].sort()
}

function validateSnapshot(value, kind = undefined) {
    if (value?.schema !==
            'issue-orchestration.stage-mutation-snapshot.v1' ||
        value.producerAuthority !==
            STAGE_MUTATION_GUARD_POLICY.producerAuthority ||
        value.policyDigest !== STAGE_MUTATION_GUARD_POLICY_DIGEST ||
        kind !== undefined && value.snapshotKind !== kind ||
        value.snapshotDigest !==
            unsignedDigest(value, 'snapshotDigest')) {
        fail('stage-mutation-snapshot-invalid')
    }
    return value
}

function validateIdentity(input, runtimeExecutionBinding) {
    const definition = STAGE_ROUTE_DEFINITIONS[
        `${input.stageRole}:${input.stagePhase}`
    ]
    if (!definition ||
        runtimeExecutionBinding.executionClass !==
            definition.executionClass ||
        runtimeExecutionBinding.actorInvocationId !==
            input.actorInvocationId ||
        runtimeExecutionBinding.actorSessionId !==
            input.actorSessionId) {
        fail('stage-mutation-actor-binding-mismatch')
    }
    for (const field of [
        'runId',
        'actorInvocationId',
        'actorSessionId',
        'attemptId',
        'stageRole',
        'stagePhase',
        'repository',
        'deliveryEpoch',
        'candidateIdentity'
    ]) assertText(input[field], 'stage-mutation-identity-incomplete')
    for (const field of [
        'routeDecisionDigest',
        'compiledPromptDigest',
        'resourceIdentityDigest',
        'remoteSnapshotDigest'
    ]) assertDigest(input[field], 'stage-mutation-identity-incomplete')
    if (!SHA.test(input.baseSha ?? '')) {
        fail('stage-mutation-base-invalid')
    }
    const allowedPaths = [...new Set(
        (input.allowedPaths ?? []).map(normalizeRelative)
    )].sort()
    if (definition.executionClass === 'leased-writer') {
        assertDigest(input.leaseDigest,
            'stage-mutation-writer-lease-required')
        assertDigest(input.sliceDigest,
            'stage-mutation-writer-slice-required')
        if (allowedPaths.length === 0) {
            fail('stage-mutation-writer-allowlist-required')
        }
    } else if (definition.executionClass === 'root-control') {
        assertDigest(
            input.leaseDigest,
            'stage-mutation-root-lease-required'
        )
        if (input.sliceDigest !== null ||
            allowedPaths.length !== 0) {
            fail('stage-mutation-root-writer-authority-forbidden')
        }
    } else if (input.leaseDigest !== null ||
        input.sliceDigest !== null ||
        allowedPaths.length !== 0) {
        fail('stage-mutation-nonwriter-authority-forbidden')
    }
    return { definition, allowedPaths }
}

export function captureStageMutationSnapshot(input = {}) {
    const {
        definition,
        allowedPaths
    } = validateIdentity(input, input.runtimeExecutionBinding)
    validateRuntimeExecutionBinding(
        input.runtimeExecutionBinding,
        {
            stageRole: input.stageRole,
            stagePhase: input.stagePhase,
            selectedProfile:
                input.runtimeExecutionBinding.selectedProfile,
            routeDecisionDigest:
                input.runtimeExecutionBinding.routeDecisionDigest,
            startup: input.startup,
            runtimeTrustBinding: input.runtimeTrustBinding,
            repositoryTargets: input.repositoryTargets
        }
    )
    const repositoryPath = fs.realpathSync(input.repositoryPath)
    const stateRootPath = fs.realpathSync(input.stateRootPath)
    const headSha = git(
        repositoryPath,
        ['rev-parse', '--verify', 'HEAD']
    ).trim()
    if (!SHA.test(headSha)) fail('stage-mutation-head-unobservable')
    const tracked = trackedEntries(repositoryPath)
    const untracked = untrackedEntries(repositoryPath)
    const status = statusEntries(repositoryPath)
    const indexSource = git(
        repositoryPath,
        ['ls-files', '--stage', '-z'],
        { buffer: true }
    )
    const refsSource = git(
        repositoryPath,
        ['for-each-ref', '--format=%(refname)%00%(objectname)%00']
    )
    return seal({
        schema: 'issue-orchestration.stage-mutation-snapshot.v1',
        producerAuthority:
            STAGE_MUTATION_GUARD_POLICY.producerAuthority,
        policyDigest: STAGE_MUTATION_GUARD_POLICY_DIGEST,
        snapshotKind: input.snapshotKind,
        capturedAt: input.capturedAt,
        runId: input.runId,
        actorInvocationId: input.actorInvocationId,
        actorSessionId: input.actorSessionId,
        attemptId: input.attemptId,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        executionClass: definition.executionClass,
        runtimeExecutionBindingDigest:
            input.runtimeExecutionBinding.bindingDigest,
        startupAttestationDigest:
            input.runtimeExecutionBinding.startupAttestationDigest,
        routeDecisionDigest: input.routeDecisionDigest,
        compiledPromptDigest: input.compiledPromptDigest,
        repository: input.repository,
        repositoryPathDigest: digest(repositoryPath),
        resourceIdentityDigest: input.resourceIdentityDigest,
        baseSha: input.baseSha,
        deliveryEpoch: input.deliveryEpoch,
        candidateIdentity: input.candidateIdentity,
        leaseDigest: input.leaseDigest,
        sliceDigest: input.sliceDigest,
        allowedPaths,
        allowedPathsDigest: digest(allowedPaths),
        headSha,
        refsDigest: digest(refsSource),
        indexDigest: digest(indexSource),
        trackedContentDigest: digest(tracked),
        trackedEntries: tracked,
        untrackedDigest: digest(untracked),
        untrackedEntries: untracked,
        gitStatusDigest: digest(status),
        gitStatusEntries: status,
        stateRootDigest: digest(treeEntries(stateRootPath)),
        remoteSnapshotDigest: input.remoteSnapshotDigest
    }, 'snapshotDigest')
}

function changedPaths(before, after) {
    const beforeEntries = new Map([
        ...before.trackedEntries,
        ...before.untrackedEntries
    ].map((entry) => [entry.path, entry]))
    const afterEntries = new Map([
        ...after.trackedEntries,
        ...after.untrackedEntries
    ].map((entry) => [entry.path, entry]))
    return [...new Set([
        ...beforeEntries.keys(),
        ...afterEntries.keys(),
        ...before.gitStatusEntries,
        ...after.gitStatusEntries
    ])].filter((relative) =>
        JSON.stringify(beforeEntries.get(relative) ?? null) !==
            JSON.stringify(afterEntries.get(relative) ?? null) ||
        before.gitStatusEntries.includes(relative) !==
            after.gitStatusEntries.includes(relative)
    ).sort()
}

function pathAllowed(relative, allowedPaths) {
    return allowedPaths.some((allowed) =>
        relative === allowed ||
        relative.startsWith(`${allowed.replace(/\/$/u, '')}/`)
    )
}


export function captureRuntimeInspectionSnapshot(input = {}) {
    validateRuntimeInspectionBinding(
        input.runtimeInspectionBinding,
        {
            inspectionKind: input.inspectionKind,
            startup: input.startup,
            runtimeTrustBinding: input.runtimeTrustBinding,
            repositoryTargets: input.repositoryTargets
        }
    )
    for (const field of [
        'runId', 'attemptId', 'repository', 'deliveryEpoch',
        'candidateIdentity', 'inspectionKind'
    ]) assertText(input[field], 'runtime-inspection-identity-incomplete')
    for (const field of [
        'routeDecisionDigest', 'compiledPromptDigest',
        'resourceIdentityDigest', 'remoteSnapshotDigest'
    ]) assertDigest(input[field], 'runtime-inspection-identity-incomplete')
    if (!SHA.test(input.baseSha ?? '')) {
        fail('runtime-inspection-base-invalid')
    }
    const binding = input.runtimeInspectionBinding
    const repositoryPath = fs.realpathSync(input.repositoryPath)
    const stateRootPath = fs.realpathSync(input.stateRootPath)
    const headSha = git(
        repositoryPath,
        ['rev-parse', '--verify', 'HEAD']
    ).trim()
    if (!SHA.test(headSha)) fail('runtime-inspection-head-unobservable')
    const tracked = trackedEntries(repositoryPath)
    const untracked = untrackedEntries(repositoryPath)
    const status = statusEntries(repositoryPath)
    const indexSource = git(
        repositoryPath,
        ['ls-files', '--stage', '-z'],
        { buffer: true }
    )
    const refsSource = git(
        repositoryPath,
        ['for-each-ref', '--format=%(refname)%00%(objectname)%00']
    )
    return seal({
        schema: 'issue-orchestration.stage-mutation-snapshot.v1',
        producerAuthority:
            STAGE_MUTATION_GUARD_POLICY.producerAuthority,
        policyDigest: STAGE_MUTATION_GUARD_POLICY_DIGEST,
        snapshotKind: input.snapshotKind,
        capturedAt: input.capturedAt,
        runId: input.runId,
        actorInvocationId: binding.actorInvocationId,
        actorSessionId: binding.actorSessionId,
        attemptId: input.attemptId,
        stageRole: 'documentation-no-change-verifier',
        stagePhase: input.inspectionKind,
        executionClass: 'observe-only',
        runtimeExecutionBindingDigest: binding.bindingDigest,
        startupAttestationDigest: binding.startupAttestationDigest,
        routeDecisionDigest: input.routeDecisionDigest,
        compiledPromptDigest: input.compiledPromptDigest,
        repository: input.repository,
        repositoryPathDigest: digest(repositoryPath),
        resourceIdentityDigest: input.resourceIdentityDigest,
        baseSha: input.baseSha,
        deliveryEpoch: input.deliveryEpoch,
        candidateIdentity: input.candidateIdentity,
        leaseDigest: null,
        sliceDigest: null,
        allowedPaths: [],
        allowedPathsDigest: digest([]),
        headSha,
        refsDigest: digest(refsSource),
        indexDigest: digest(indexSource),
        trackedContentDigest: digest(tracked),
        trackedEntries: tracked,
        untrackedDigest: digest(untracked),
        untrackedEntries: untracked,
        gitStatusDigest: digest(status),
        gitStatusEntries: status,
        stateRootDigest: digest(treeEntries(stateRootPath)),
        remoteSnapshotDigest: input.remoteSnapshotDigest
    }, 'snapshotDigest')
}

export function evaluateStageMutationPostcondition({
    preSnapshot,
    postSnapshot,
    outputClass,
    output,
    prohibitedReceiptEmitted = false,
    attributionStatus = 'verified'
} = {}) {
    validateSnapshot(preSnapshot, 'pre-dispatch')
    validateSnapshot(postSnapshot, 'post-execution')
    const immutableFields = [
        'runId',
        'actorInvocationId',
        'actorSessionId',
        'attemptId',
        'stageRole',
        'stagePhase',
        'executionClass',
        'runtimeExecutionBindingDigest',
        'startupAttestationDigest',
        'routeDecisionDigest',
        'compiledPromptDigest',
        'repository',
        'repositoryPathDigest',
        'resourceIdentityDigest',
        'baseSha',
        'deliveryEpoch',
        'candidateIdentity',
        'leaseDigest',
        'sliceDigest',
        'allowedPathsDigest'
    ]
    if (immutableFields.some((field) =>
        JSON.stringify(preSnapshot[field]) !==
            JSON.stringify(postSnapshot[field]))) {
        fail('stage-mutation-snapshot-replay-or-drift')
    }
    assertText(outputClass, 'stage-mutation-output-class-required')
    const rules = STAGE_MUTATION_GUARD_POLICY.executionClasses[
        preSnapshot.executionClass
    ]
    const changed = changedPaths(preSnapshot, postSnapshot)
    const stateRootChanged =
        preSnapshot.stateRootDigest !== postSnapshot.stateRootDigest
    const remoteSnapshotChanged =
        preSnapshot.remoteSnapshotDigest !==
            postSnapshot.remoteSnapshotDigest
    const violations = []
    if (attributionStatus !== 'verified') {
        violations.push('mutation-attribution-ambiguous')
    }
    if (!rules.allowedResultClasses.includes(outputClass)) {
        violations.push('stage-output-class-forbidden')
    }
    if (prohibitedReceiptEmitted) {
        violations.push('prohibited-authority-receipt-emitted')
    }
    if (preSnapshot.executionClass === 'observe-only') {
        if (changed.length > 0 ||
            preSnapshot.headSha !== postSnapshot.headSha ||
            preSnapshot.refsDigest !== postSnapshot.refsDigest ||
            preSnapshot.indexDigest !== postSnapshot.indexDigest) {
            violations.push('observe-only-repository-mutation')
        }
        if (stateRootChanged) {
            violations.push('observe-only-state-root-mutation')
        }
        if (remoteSnapshotChanged) {
            violations.push('observe-only-remote-mutation')
        }
    } else if (preSnapshot.executionClass === 'leased-writer') {
        if (changed.some((relative) =>
            !pathAllowed(relative, preSnapshot.allowedPaths))) {
            violations.push('writer-out-of-scope-mutation')
        }
        if (stateRootChanged) {
            violations.push('writer-control-state-mutation')
        }
        if (remoteSnapshotChanged) {
            violations.push('writer-remote-mutation')
        }
        if (preSnapshot.refsDigest !== postSnapshot.refsDigest &&
            postSnapshot.headSha !==
                postSnapshot.candidateIdentity) {
            violations.push('writer-ref-mutation-unbound')
        }
    }
    const uniqueViolations = [...new Set(violations)].sort()
    const status = uniqueViolations.length === 0
        ? 'verified'
        : 'rejected'
    const recoveryDisposition = status === 'verified'
        ? 'accept'
        : uniqueViolations.includes(
            'mutation-attribution-ambiguous'
        ) ||
            remoteSnapshotChanged &&
                preSnapshot.executionClass !== 'root-control'
            ? 'run-fatal'
            : rules.violationDisposition
    return seal({
        schema:
            'issue-orchestration.stage-mutation-postcondition-receipt.v1',
        producerAuthority:
            STAGE_MUTATION_GUARD_POLICY.producerAuthority,
        policyDigest: STAGE_MUTATION_GUARD_POLICY_DIGEST,
        status,
        runId: preSnapshot.runId,
        actorInvocationId: preSnapshot.actorInvocationId,
        actorSessionId: preSnapshot.actorSessionId,
        attemptId: preSnapshot.attemptId,
        stageRole: preSnapshot.stageRole,
        stagePhase: preSnapshot.stagePhase,
        executionClass: preSnapshot.executionClass,
        mutationContract: rules.mutationContract,
        runtimeExecutionBindingDigest:
            preSnapshot.runtimeExecutionBindingDigest,
        preSnapshotDigest: preSnapshot.snapshotDigest,
        postSnapshotDigest: postSnapshot.snapshotDigest,
        routeDecisionDigest: preSnapshot.routeDecisionDigest,
        compiledPromptDigest: preSnapshot.compiledPromptDigest,
        resourceIdentityDigest:
            preSnapshot.resourceIdentityDigest,
        baseSha: preSnapshot.baseSha,
        deliveryEpoch: preSnapshot.deliveryEpoch,
        candidateIdentity: preSnapshot.candidateIdentity,
        candidateDigest: digest({
            headSha: postSnapshot.headSha,
            indexDigest: postSnapshot.indexDigest,
            trackedContentDigest:
                postSnapshot.trackedContentDigest,
            untrackedDigest: postSnapshot.untrackedDigest
        }),
        leaseDigest: preSnapshot.leaseDigest,
        sliceDigest: preSnapshot.sliceDigest,
        allowedPathsDigest: preSnapshot.allowedPathsDigest,
        changedPaths: changed,
        changedPathsDigest: digest(changed),
        stateRootChanged,
        remoteSnapshotChanged,
        prohibitedReceiptEmitted,
        outputClass,
        outputDigest: digest(output),
        violationCodes: uniqueViolations,
        recoveryDisposition
    }, 'receiptDigest')
}

export function validateStageMutationPostconditionReceipt(value, {
    status = 'verified',
    runtimeExecutionBindingDigest,
    resultDigest
} = {}) {
    if (value?.schema !==
            'issue-orchestration.stage-mutation-postcondition-receipt.v1' ||
        value.producerAuthority !==
            STAGE_MUTATION_GUARD_POLICY.producerAuthority ||
        value.policyDigest !== STAGE_MUTATION_GUARD_POLICY_DIGEST ||
        value.status !== status ||
        value.receiptDigest !==
            unsignedDigest(value, 'receiptDigest') ||
        runtimeExecutionBindingDigest !== undefined &&
            value.runtimeExecutionBindingDigest !==
                runtimeExecutionBindingDigest ||
        resultDigest !== undefined &&
            value.outputDigest !== resultDigest) {
        fail('stage-mutation-postcondition-receipt-invalid')
    }
    return value
}

export function acceptStageResult({
    postconditionReceipt,
    resultClass,
    result
} = {}) {
    validateStageMutationPostconditionReceipt(
        postconditionReceipt
    )
    if (postconditionReceipt.outputClass !== resultClass ||
        postconditionReceipt.outputDigest !== digest(result)) {
        fail('stage-result-postcondition-binding-mismatch')
    }
    const executionClass =
        postconditionReceipt.executionClass
    return seal({
        schema:
            'issue-orchestration.stage-result-acceptance-receipt.v1',
        producerAuthority:
            STAGE_MUTATION_GUARD_POLICY.producerAuthority,
        status: 'accepted',
        runId: postconditionReceipt.runId,
        attemptId: postconditionReceipt.attemptId,
        stageRole: postconditionReceipt.stageRole,
        stagePhase: postconditionReceipt.stagePhase,
        executionClass,
        resultClass,
        resultDigest: digest(result),
        postconditionReceiptDigest:
            postconditionReceipt.receiptDigest,
        acceptedAsWriterEvidence:
            executionClass === 'leased-writer',
        acceptedAsIndependentEvidence:
            executionClass === 'observe-only'
    }, 'receiptDigest')
}
