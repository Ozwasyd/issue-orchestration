#!/usr/bin/env node
// Shared issue-orchestration package runtime.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    lstatSync,
    readFileSync,
    realpathSync,
    statSync
} from 'node:fs'
import {
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    isWithinOrEqual,
    StateRootValidationError,
    validateStateRoot
} from './validate-state-root.mjs'
import { validateReadyFrontier } from './frontier-compiler.mjs'
import { validateInvestigationProjection } from './investigation-compiler.mjs'
import {
    validateDispatchBatch,
    validateDispatchFrontierBinding
} from './dispatch-batch-selector.mjs'
import {
    assertDigest as assertContractDigest,
    digest as contractDigest,
    fail as contractFail,
    seal as contractSeal
} from './runtime-contract-lib.mjs'
import {
    STAGE_ROUTE_DEFINITIONS,
    verifyRuntimeProfileMetadata
} from './stage-profile-policy.mjs'
import {
    compileRuntimePermissionEvidence,
    validateRuntimeTrustBinding
} from './runtime-trust-policy.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'

class DagGateError extends Error {
    constructor(code, message, details = {}) {
        super(message)
        this.name = 'DagGateError'
        this.code = code
        this.details = details
    }
}

function fail(code, message, details = {}) {
    throw new DagGateError(code, message, details)
}

const DISPATCH_PROJECTION_FIELDS = [
    'frontierProjection', 'frontierRuntime', 'selectorReceipt',
    'dispatchFrontier', 'dispatchRankingPolicy', 'dispatchBatch'
]

export function validateDispatchProjectionPresence(dag) {
    const present = DISPATCH_PROJECTION_FIELDS.filter(
        (field) => dag?.[field] !== undefined
    )
    if (present.length === 0) {
        fail(
            'dispatch-projection-required',
            'The verified frontier and dispatch projection are required.'
        )
    }
    if (present.length !== DISPATCH_PROJECTION_FIELDS.length) {
        fail(
            'dispatch-projection-incomplete',
            'Ready frontier and dispatch projection must be present as one fail-closed unit.'
        )
    }
    return { valid: true }
}

const LEGACY_NODE_ROUTE_FIELDS = Object.freeze([
    'model',
    'effort',
    'difficultyBand',
    'reworkCount',
    'effortPromotionEvidence'
])

function validateV3Route({
    route,
    node,
    policyDigest
}) {
    if (route?.routingAuthority !==
            'deterministic-execution-capability-compiler') {
        contractFail('dag-gate-route-authority')
    }
    if (route?.schema !==
            'issue-orchestration.execution-route-decision.v2' ||
        route.policyVersion !== 'execution-capability-routing.v3' ||
        route.modelPoolPolicyVersion !== 'stage-model-pool.v3' ||
        route.modelPoolPolicyDigest !== policyDigest ||
        route.stageRole !== node.stageRole ||
        route.stagePhase !== node.stagePhase ||
        route.executionClass !==
            STAGE_ROUTE_DEFINITIONS[
                `${node.stageRole}:${node.stagePhase}`
            ]?.executionClass ||
        route.runtimeVerificationStatus !== 'verified') {
        contractFail('dag-gate-route-binding')
    }
    if (route.sliceDigest !== node.sliceDigest) {
        contractFail('dag-gate-route-binding')
    }
    const definition = STAGE_ROUTE_DEFINITIONS[
        `${node.stageRole}:${node.stagePhase}`
    ]
    if (!definition ||
        !definition.allowedProfiles.includes(route.selectedProfile) ||
        route.selectedProfile.includes('ultra') ||
        route.selectedProfile.startsWith('luna-')) {
        contractFail('dag-gate-profile')
    }
    try {
        verifyRuntimeProfileMetadata({
            selectedProfile: route.selectedProfile,
            requestedModel: node.runtimeMetadata?.requestedModel,
            effectiveModel: node.runtimeMetadata?.effectiveModel,
            requestedEffort: node.runtimeMetadata?.requestedEffort,
            effectiveEffort: node.runtimeMetadata?.effectiveEffort,
            multiAgentBackend:
                node.runtimeMetadata?.multiAgentBackend
        })
    } catch {
        contractFail('dag-gate-runtime-metadata')
    }
    assertContractDigest(
        route.routeDecisionDigest,
        'dag-gate-route-binding'
    )
}

function validateMemberReceipts(node, usedReceiptDigests) {
    for (const kind of ['candidate', 'behavior']) {
        const receipt = node.receipts?.[kind]
        if (!receipt) contractFail('dag-gate-member-receipt-missing')
        if (receipt.memberId !== node.memberId ||
            !/^[a-f0-9]{64}$/u.test(
                receipt.receiptDigest ?? ''
            ) ||
            usedReceiptDigests.has(receipt.receiptDigest)) {
            contractFail('dag-gate-member-receipt-binding')
        }
        usedReceiptDigests.add(receipt.receiptDigest)
    }
}

function validateMemberResource(node, usedLeaseIds) {
    if (node.stageState !== 'active') return
    const lease = node.resourceOwnership?.writeLease
    if (!lease ||
        lease.active !== true ||
        lease.ownerMemberId !== node.memberId ||
        typeof lease.leaseId !== 'string' ||
        !lease.leaseId ||
        usedLeaseIds.has(lease.leaseId) ||
        !/^[a-f0-9]{64}$/u.test(
            lease.leaseDigest ?? ''
        )) {
        contractFail('dag-gate-writer-lease')
    }
    usedLeaseIds.add(lease.leaseId)
}

function validateCompletedMember(node) {
    if (node.stageState !== 'completed') return
    const tombstone = node.completedTombstone
    if (tombstone?.stateReason !== 'completed' ||
        tombstone.commitAncestryVerified !== true ||
        !/^[a-f0-9]{64}$/u.test(
            tombstone.evidenceDigest ?? ''
        )) {
        contractFail('dag-gate-completed-tombstone')
    }
}

function projectMember(node, policyDigest) {
    for (const field of [
        'acceptanceContractDigest',
        'testContractDigest',
        'planDigest',
        'sliceDigest',
        'promptDigest'
    ]) assertContractDigest(node[field], 'dag-gate-member-binding')
    const projection = {
        schema:
            'issue-orchestration.node-member-runtime-projection.v1',
        memberId: node.memberId,
        repository: node.repository,
        issueNumber: node.issueNumber,
        stageState: node.stageState,
        stageRole: node.stageRole,
        stagePhase: node.stagePhase,
        acceptanceContractDigest:
            node.acceptanceContractDigest,
        testContractDigest: node.testContractDigest,
        planDigest: node.planDigest,
        sliceDigest: node.sliceDigest,
        promptDigest: node.promptDigest,
        policyDigest,
        routeDecision: structuredClone(node.routeDecision),
        runtimeMetadata: structuredClone(node.runtimeMetadata),
        receipts: structuredClone(node.receipts),
        resourceOwnership:
            structuredClone(node.resourceOwnership),
        disposition: node.disposition,
        completedTombstone:
            structuredClone(node.completedTombstone ?? null)
    }
    projection.projectionDigest = contractDigest(projection)
    return projection
}

function validateRootStartup({
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    policyDigest,
    repositories
}) {
    let startupBinding
    try {
        startupBinding = requireRuntimeStartupBinding({ startup })
    } catch {
        contractFail('dag-gate-startup-attestation')
    }
    if (startup?.observation?.policyDigests?.modelPool !==
        policyDigest) {
        contractFail('dag-gate-startup-policy-binding')
    }
    try {
        validateRuntimeTrustBinding(runtimeTrustBinding, {
            expectedRole: 'root-scheduler',
            expectedExecutionClass: 'root-control',
            expectedRepositories: repositories,
            repositoryTargets,
            startup
        })
    } catch {
        contractFail('dag-gate-root-runtime-trust')
    }
    return {
        rootProfile: startupBinding.rootProfile,
        startupBinding,
        runtimePermissionEvidence:
            compileRuntimePermissionEvidence({
                binding: runtimeTrustBinding,
                evidenceClass: 'run',
                repositoryTargets,
                startup
            })
    }
}

export function validateDagStartupGateV2(value) {
    if (value?.legacyFallbackEnabled === true) {
        contractFail('dag-gate-legacy-fallback')
    }
    if (value?.rootRuntime !== undefined) {
        contractFail('dag-gate-legacy-root-runtime')
    }
    if (value?.authoritySource !== 'permanent-shared-package') {
        contractFail('dag-gate-authority-source')
    }
    if (value?.schema !==
            'issue-orchestration.dag-startup-gate-request.v2' ||
        value.selectorReceipt?.schema !==
            'issue-orchestration.scope-selector-receipt.v1') {
        contractFail('dag-gate-request')
    }
    assertContractDigest(
        value.selectorReceipt.receiptDigest,
        'dag-gate-selector'
    )
    assertContractDigest(
        value.selectorReceipt.remoteSnapshotDigest,
        'dag-gate-selector'
    )
    let startupBinding
    try {
        startupBinding =
            requireRuntimeStartupBinding({
                startup: value.startup
            })
    } catch {
        contractFail('dag-gate-startup-attestation')
    }
    if (value.selectorReceipt.startupAttestationDigest !==
            startupBinding.startupAttestationDigest ||
        value.selectorReceipt.runtimeInvocationId !==
            startupBinding.runtimeInvocationId) {
        contractFail('dag-gate-selector-startup-binding')
    }
    if (value.dag?.schema !==
        'issue-orchestration.semantic-graph.v2') {
        contractFail('dag-gate-rebuild-required')
    }
    if (value.dag.testContractDigest !== undefined ||
        value.dag.stageReceipts !== undefined) {
        contractFail('dag-gate-legacy-authority')
    }
    assertContractDigest(
        value.dag.policyDigest,
        'dag-gate-policy'
    )
    const repositories = [...new Set(value.dag.nodes?.map(
        ({ repository }) => repository
    ) ?? [])].sort()
    const {
        rootProfile,
        startupBinding: validatedStartupBinding,
        runtimePermissionEvidence
    } = validateRootStartup({
        startup: value.startup,
        runtimeTrustBinding: value.runtimeTrustBinding,
        repositoryTargets: value.repositoryTargets,
        policyDigest: value.dag.policyDigest,
        repositories
    })
    if (!Array.isArray(value.dag.nodes) ||
        value.dag.nodes.length === 0) {
        contractFail('dag-gate-members')
    }
    const memberIds = new Set()
    const usedReceiptDigests = new Set()
    const usedLeaseIds = new Set()
    const projections = []
    for (const node of value.dag.nodes) {
        if (LEGACY_NODE_ROUTE_FIELDS.some((field) =>
            Object.hasOwn(node, field))) {
            contractFail('dag-gate-legacy-authority')
        }
        if (typeof node.memberId !== 'string' ||
            !node.memberId ||
            memberIds.has(node.memberId)) {
            contractFail('dag-gate-member-identity')
        }
        memberIds.add(node.memberId)
        validateV3Route({
            route: node.routeDecision,
            node,
            policyDigest: value.dag.policyDigest
        })
        validateMemberReceipts(node, usedReceiptDigests)
        validateMemberResource(node, usedLeaseIds)
        validateCompletedMember(node)
        projections.push(projectMember(
            node,
            value.dag.policyDigest
        ))
    }
    return contractSeal({
        schema:
            'issue-orchestration.dag-startup-gate-receipt.v2',
        status: 'verified',
        selectorReceiptDigest:
            value.selectorReceipt.receiptDigest,
        remoteSnapshotDigest:
            value.selectorReceipt.remoteSnapshotDigest,
        policyDigest: value.dag.policyDigest,
        rootProfile,
        startupAttestationDigest:
            validatedStartupBinding.startupAttestationDigest,
        runtimeInvocationId:
            validatedStartupBinding.runtimeInvocationId,
        runtimeSessionId:
            validatedStartupBinding.runtimeSessionId,
        runtimeTrustMode:
            runtimePermissionEvidence.runtimeTrustMode,
        runtimeTrustBindingDigest:
            runtimePermissionEvidence.runtimeTrustBindingDigest,
        runtimePermissionEvidenceDigest:
            runtimePermissionEvidence.evidenceDigest,
        effectivePermissionProfile:
            runtimePermissionEvidence.effectivePermissionProfile,
        permissionInheritance:
            runtimePermissionEvidence.permissionInheritance,
        machineEnforcedRoleIsolation:
            runtimePermissionEvidence.machineEnforcedRoleIsolation,
        mutationPostconditionRequired:
            runtimePermissionEvidence.mutationPostconditionRequired,
        memberCount: projections.length,
        memberProjectionDigests:
            projections.map(({ projectionDigest }) =>
                projectionDigest),
        legacyGlobalReceiptAuthority: false
    }, 'receiptDigest')
}

function tryLstat(target) {
    try {
        return lstatSync(target)
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
        throw error
    }
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function normalizeJson(value) {
    if (Array.isArray(value)) return value.map(normalizeJson)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, normalizeJson(value[key])])
    )
}

function fingerprint(value) {
    return sha256(JSON.stringify(normalizeJson(value)))
}

function readJson(path, label) {
    let source
    try {
        source = readFileSync(path, 'utf8')
    } catch (error) {
        fail(`${label}-unreadable`, `${label} cannot be read: ${path}.`, {
            path,
            error: error.message
        })
    }

    try {
        return JSON.parse(source)
    } catch (error) {
        fail(`${label}-invalid-json`, `${label} is not valid JSON: ${path}.`, {
            path,
            error: error.message
        })
    }
}

function runGit(repository, args) {
    try {
        return execFileSync(
            'git',
            ['-C', repository, ...args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim()
    } catch (error) {
        fail('repository-probe-failed', `Git probe failed for ${repository}.`, {
            repository,
            args,
            stderr: error.stderr?.toString().trim() ?? ''
        })
    }
}

function isAncestor(repository, commit, branch) {
    try {
        execFileSync(
            'git',
            ['-C', repository, 'merge-base', '--is-ancestor', commit, branch],
            { stdio: 'ignore' }
        )
        return true
    } catch {
        return false
    }
}

function ensureStateFile(path, stateRoot, label) {
    const absolute = resolve(path)
    let canonical
    try {
        canonical = realpathSync.native(absolute)
    } catch (error) {
        fail(`${label}-unreadable`, `${label} does not resolve to an existing state file: ${absolute}.`, {
            error: error.message
        })
    }

    if (!isWithinOrEqual(canonical, stateRoot) || canonical === stateRoot) {
        fail(`${label}-outside-state-root`, `${label} is outside the validated state root.`, {
            path: canonical,
            stateRoot
        })
    }

    const offset = relative(stateRoot, absolute)
    let cursor = stateRoot
    for (const component of offset.split(sep).filter(Boolean)) {
        cursor = resolve(cursor, component)
        if (lstatSync(cursor).isSymbolicLink()) {
            fail(`${label}-symlink`, `${label} traverses a symbolic link: ${cursor}.`, {
                path: absolute,
                symlink: cursor
            })
        }
    }

    if (!statSync(canonical).isFile()) {
        fail(`${label}-not-file`, `${label} is not a regular file: ${canonical}.`)
    }
    return canonical
}

function parseTimestamp(value, label) {
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) fail('invalid-timestamp', `${label} is not a valid timestamp.`, { value })
    return timestamp
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail('invalid-schema', `${label} must be a non-empty string.`)
    }
}

function requireStringArray(value, label) {
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
        fail('invalid-schema', `${label} must be a non-empty string array.`)
    }
}

function issueKey(issue) {
    return `${issue.repository}#${issue.number}`
}

function validateIssueSnapshot(snapshot, startupTime, repositoryNames) {
    if (snapshot?.schema !== 'issue-orchestration.issue-snapshot.v1') {
        fail('issue-snapshot-schema', 'Issue snapshot schema is missing or unsupported.')
    }
    if (!Array.isArray(snapshot.issues) || snapshot.issues.length === 0) {
        fail('issue-snapshot-scope', 'Issue snapshot must contain the complete selected scope.')
    }

    const refreshedAt = parseTimestamp(snapshot.refreshedAt, 'issue snapshot refreshedAt')
    if (refreshedAt < startupTime) {
        fail('issue-snapshot-stale', 'Issue snapshot predates the current startup gate.', {
            refreshedAt: snapshot.refreshedAt,
            startupTime: new Date(startupTime).toISOString()
        })
    }

    const keys = new Set()
    for (const issue of snapshot.issues) {
        requireString(issue.repository, 'issue.repository')
        if (!repositoryNames.has(issue.repository)) {
            fail('issue-snapshot-repository', `Issue snapshot references an unknown repository: ${issue.repository}.`)
        }
        if (!Number.isInteger(issue.number) || issue.number <= 0) {
            fail('issue-snapshot-number', 'Issue number must be a positive integer.')
        }
        if (issue.state !== 'OPEN') {
            fail('issue-snapshot-state', `Issue ${issueKey(issue)} is not currently open.`, {
                state: issue.state
            })
        }
        parseTimestamp(issue.updatedAt, `${issueKey(issue)} updatedAt`)
        if (!/^[a-f0-9]{64}$/u.test(issue.commentsFingerprint ?? '')) {
            fail('issue-snapshot-comments', `Issue ${issueKey(issue)} lacks a valid comments fingerprint.`)
        }
        const key = issueKey(issue)
        if (keys.has(key)) fail('issue-snapshot-duplicate', `Issue snapshot repeats ${key}.`)
        keys.add(key)
    }

    return {
        refreshedAt,
        fingerprint: fingerprint(
            [...snapshot.issues].sort((left, right) => issueKey(left).localeCompare(issueKey(right)))
        ),
        remoteSnapshotDigest: fingerprint({
            issues: [...snapshot.issues].sort((left, right) => issueKey(left).localeCompare(issueKey(right))),
            prerequisiteObservations: [...(snapshot.prerequisiteObservations ?? [])].sort(
                (left, right) => left.dependencyKey.localeCompare(right.dependencyKey)
            )
        }),
        keys
    }
}

function repositoryFacts(repositories, defaultBranches) {
    return repositories
        .map(({ name, path }) => {
            requireString(defaultBranches.get(name), `default branch for ${name}`)
            const canonical = realpathSync.native(resolve(path))
            const currentBranch = runGit(canonical, ['branch', '--show-current'])
            if (currentBranch !== defaultBranches.get(name)) {
                fail('default-branch-mismatch', `${name} is not on its declared default branch.`, {
                    declared: defaultBranches.get(name),
                    current: currentBranch
                })
            }
            const dirty = runGit(canonical, ['status', '--porcelain=v1', '--untracked-files=all'])
            return {
                name,
                path: canonical,
                remote: runGit(canonical, ['remote', 'get-url', 'origin']),
                defaultBranch: defaultBranches.get(name),
                headSha: runGit(canonical, ['rev-parse', 'HEAD']),
                dirtyFingerprint: sha256(dirty)
            }
        })
        .sort((left, right) => left.name.localeCompare(right.name))
}

function validateRepositories(dag, liveFacts) {
    if (!Array.isArray(dag.repositories) || dag.repositories.length !== liveFacts.length) {
        fail('repository-scope-mismatch', 'DAG repository scope does not match the current repositories.')
    }

    const dagByName = new Map(dag.repositories.map((repository) => [repository.name, repository]))
    for (const live of liveFacts) {
        const recorded = dagByName.get(live.name)
        if (!recorded) fail('repository-missing', `DAG is missing repository ${live.name}.`)
        for (const field of ['path', 'remote', 'defaultBranch', 'headSha', 'dirtyFingerprint']) {
            if (recorded[field] !== live[field]) {
                fail('repository-identity-mismatch', `DAG ${live.name}.${field} does not match current repository facts.`, {
                    field,
                    recorded: recorded[field],
                    current: live[field]
                })
            }
        }
        if (recorded.baseSha !== live.headSha) {
            fail('base-sha-mismatch', `DAG ${live.name}.baseSha does not match the startup HEAD.`, {
                recorded: recorded.baseSha,
                current: live.headSha
            })
        }
    }
}

function validateAcyclic(nodesById) {
    const visiting = new Set()
    const visited = new Set()

    function visit(id) {
        if (visiting.has(id)) fail('dependency-cycle', `DAG dependency cycle includes ${id}.`)
        if (visited.has(id)) return
        visiting.add(id)
        for (const dependency of nodesById.get(id).activeDependencies) visit(dependency)
        visiting.delete(id)
        visited.add(id)
    }

    for (const id of nodesById.keys()) visit(id)
}

function validateStageReceipts(dag) {
    if (!/^[a-f0-9]{64}$/u.test(dag.testContractDigest ?? '')) {
        fail('stage-receipt-test-contract', 'DAG lacks a valid frozen test contract digest.')
    }
    const receipts = dag.stageReceipts
    const names = ['proposal', 'testContract', 'dispatch', 'implementation', 'verification', 'behavior', 'documentation']
    if (!receipts || names.some((name) => !receipts[name])) {
        fail('stage-receipt-stage-role', 'DAG lacks the required stage receipt chain.')
    }
    const expectedRoles = {
        proposal: 'dag-updater',
        testContract: 'test-owner',
        dispatch: 'root-scheduler',
        implementation: 'code-implementer',
        verification: 'test-owner',
        behavior: 'test-owner',
        documentation: 'documentation-writer'
    }
    for (const name of names) {
        if (receipts[name].stageRole !== expectedRoles[name]) {
            if (name === 'proposal' && receipts[name].stageRole === 'root-scheduler') {
                fail('tombstone-authority-role', 'Root scheduler cannot author a tombstone proposal.')
            }
            fail('stage-receipt-stage-role', `${name} receipt has the wrong or missing stage role.`)
        }
    }
    const proposal = receipts.proposal
    if (proposal.spawnedByStageRole !== 'root-scheduler') {
        fail('dag-updater-caller-role', 'Only the root scheduler may spawn a DAG updater.')
    }
    if (!Array.isArray(proposal.directWrites) ||
        proposal.directWrites.length !== 0 ||
        proposal.executionClass !== 'observe-only' ||
        proposal.mutationContract !== 'no-protected-mutation' ||
        !/^[a-f0-9]{64}$/u.test(
            proposal.mutationPostconditionReceiptDigest ?? ''
        ) ||
        proposal.proposalOnly !== true) {
        fail('dag-updater-direct-write',
            'DAG updater must be observe-only, postcondition-verified, and proposal-only.')
    }
    if (proposal.trigger !== 'remote-live-snapshot-digest-changed') {
        fail('remote-snapshot-trigger-required', 'A tombstone update requires a changed remote snapshot digest.')
    }
    if (receipts.testContract.actorId === receipts.implementation.actorId) {
        fail('stage-role-write-conflict', 'Test owner and code implementer must be different actors.')
    }
    if (
        !Array.isArray(receipts.implementation.changedPaths)
        || receipts.implementation.changedPaths.some((path) => /(^|\/)(tests?|fixtures?)(\/|$)/u.test(path))
    ) {
        fail('frozen-test-contract-modified', 'Implementation receipt modifies a frozen test or fixture.')
    }
    for (const receipt of Object.values(receipts)) {
        if (receipt.candidateSha !== receipts.dispatch.candidateSha) {
            fail('stage-receipt-candidate-sha', 'Stage receipt candidate SHA does not match dispatch.')
        }
        if (receipt.remoteSnapshotDigest !== dag.remoteSnapshotDigest) {
            fail('stage-receipt-remote-snapshot', 'Stage receipt remote snapshot digest does not match the DAG.')
        }
        if (receipt.testContractDigest !== dag.testContractDigest) {
            fail('stage-receipt-test-contract', 'Stage receipt test contract digest does not match the DAG.')
        }
    }
    if (receipts.behavior.status !== 'passed' || receipts.documentation.behaviorReceiptDigest !== fingerprint(receipts.behavior)) {
        fail('documentation-before-behavior-green', 'Documentation requires a matching green behavior receipt.')
    }
    if (receipts.dispatch.model !== 'gpt-5.6-sol' || receipts.dispatch.effort !== 'low') {
        fail('root-scheduler-runtime-identity', 'Root scheduler runtime identity is invalid.')
    }
    if (proposal.model !== 'gpt-5.6-sol' || proposal.effort !== 'max' || proposal.freshContext !== true) {
        fail('dag-updater-runtime-identity', 'DAG updater runtime identity is invalid.')
    }
    if (receipts.testContract.model !== 'gpt-5.6-sol' || receipts.testContract.effort !== 'max') {
        fail('test-owner-runtime-identity', 'Test owner runtime identity is invalid.')
    }
    if (receipts.implementation.model !== 'gpt-5.6-sol' || receipts.implementation.effort !== 'low') {
        fail('implementer-runtime-identity', 'Code implementer runtime identity is invalid.')
    }
}

function validateNodesAndGroups(dag, snapshot, repositoryNames, liveFacts) {
    const observations = Array.isArray(snapshot.prerequisiteObservations)
        ? snapshot.prerequisiteObservations
        : []
    const observationsByKey = new Map()
    for (const observation of observations) {
        requireString(observation.dependencyKey, 'prerequisiteObservation.dependencyKey')
        if (observationsByKey.has(observation.dependencyKey)) {
            fail('tombstone-duplicate', `Remote observations repeat ${observation.dependencyKey}.`)
        }
        observationsByKey.set(observation.dependencyKey, observation)
    }
    const observationKeys = new Set(observationsByKey.keys())
    if (Array.isArray(dag.nodes) && dag.nodes.some((node) => observationKeys.has(node.id))) {
        fail('tombstone-active-node-forbidden', 'A closed prerequisite cannot be an active DAG node.')
    }
    if (!Array.isArray(dag.nodes) || dag.nodes.length !== snapshot.issues.length) {
        fail('node-scope-mismatch', 'DAG nodes do not exactly cover the current issue scope.')
    }

    const snapshotById = new Map(snapshot.issues.map((issue) => [issueKey(issue), issue]))
    const nodesById = new Map()
    const allowedStatuses = new Set([
        'discovered',
        'investigated',
        'ready',
        'implementing',
        'test-contracting',
        'test-contract-frozen',
        'implementing-self-testing',
        'candidate-green',
        'independent-verifying',
        'behavior-green',
        'ux-acceptance',
        'ux-accepted',
        'documenting',
        'documentation-green',
        'delivery-ready',
        'delivering',
        'cleaning',
        'closed',
        'terminal'
    ])
    const invalidStatusNodes = []

    for (const node of dag.nodes) {
        requireString(node.id, 'node.id')
        if (nodesById.has(node.id)) fail('node-duplicate', `DAG repeats node ${node.id}.`)
        const issue = snapshotById.get(node.id)
        if (!issue) fail('node-out-of-scope', `DAG node ${node.id} is absent from the current issue snapshot.`)
        if (node.repository !== issue.repository || node.issueNumber !== issue.number) {
            fail('node-identity-mismatch', `DAG node ${node.id} does not match its issue identity.`)
        }
        if (node.issueUpdatedAt !== issue.updatedAt || node.commentsFingerprint !== issue.commentsFingerprint) {
            fail('node-remote-mismatch', `DAG node ${node.id} is stale relative to current issue facts.`)
        }
        if (!allowedStatuses.has(node.status)) invalidStatusNodes.push(node)
        requireString(node.ownerRepository, `${node.id}.ownerRepository`)
        if (!repositoryNames.has(node.ownerRepository)) {
            fail('node-owner', `DAG node ${node.id} has unknown owner repository ${node.ownerRepository}.`)
        }
        requireString(node.acceptanceGroup, `${node.id}.acceptanceGroup`)
        if (!Array.isArray(node.dependencyKeys) || !Array.isArray(node.activeDependencies) || !Array.isArray(node.satisfiedDependencies)) {
            fail('node-dependencies', `${node.id} must declare dependencyKeys, activeDependencies, and satisfiedDependencies arrays.`)
        }
        if (node.status === 'terminal') {
            if (!['impossible', 'externally_blocked', 'not_applicable'].includes(node.terminalCategory)) {
                fail('terminal-category', `Terminal node ${node.id} lacks a valid category.`)
            }
            requireStringArray(node.terminalEvidence, `${node.id}.terminalEvidence`)
            requireString(node.recoveryFingerprint, `${node.id}.recoveryFingerprint`)
        }

        nodesById.set(node.id, node)
    }

    const factsByName = new Map(liveFacts.map((facts) => [facts.name, facts]))
    const dependencyResolutions = []
    const closedKeys = new Set()
    for (const node of nodesById.values()) {
        const dependencyKeys = new Set(node.dependencyKeys)
        if (dependencyKeys.size !== node.dependencyKeys.length) fail('dependency-unknown', `Node ${node.id} repeats a dependency key.`)
        const active = new Set(node.activeDependencies)
        const tombstoneKeys = new Set()
        for (const tombstone of node.satisfiedDependencies) {
            const key = tombstone.issue
            if (tombstoneKeys.has(key)) fail('tombstone-duplicate', `Node ${node.id} repeats tombstone ${key}.`)
            tombstoneKeys.add(key)
        }
        if ([...active].some((key) => tombstoneKeys.has(key))) {
            fail('dependency-classification-overlap', `Node ${node.id} classifies a dependency as both active and satisfied.`)
        }
        for (const dependency of node.activeDependencies) {
            if (!nodesById.has(dependency)) {
                fail('dependency-unknown', `Node ${node.id} has unknown active dependency ${dependency}.`)
            }
            if (dependency === node.id) fail('dependency-cycle', `Node ${node.id} depends on itself.`)
            dependencyResolutions.push({ node: node.id, dependency, code: 'dependency-active' })
        }
        for (const tombstone of node.satisfiedDependencies) {
            const key = tombstone.issue
            if (!dependencyKeys.has(key)) {
                fail('tombstone-identity-mismatch', `Tombstone ${key} does not match a declared dependency key.`)
            }
            const observation = observationsByKey.get(key)
            if (!observation) fail('dependency-unknown', `Node ${node.id} has an unobserved satisfied dependency ${key}.`)
            if (observation.remoteState !== 'CLOSED') fail('tombstone-remote-state-drift', `${key} is no longer closed.`)
            if (observation.disposition === 'duplicate') fail('tombstone-duplicate-disposition', `${key} is a duplicate without a valid substitute.`)
            if (observation.stateReason !== 'completed') fail('tombstone-state-reason', `${key} was not closed as completed.`)
            if (!observation.deliveredCommit) fail('tombstone-delivered-commit-missing', `${key} lacks a delivered commit.`)
            if (!observation.completionEvidence) fail('tombstone-completion-evidence-missing', `${key} lacks completion evidence.`)
            if (observation.evidenceDigest !== fingerprint(observation.completionEvidence)) {
                fail('tombstone-evidence-tampered', `${key} completion evidence has been tampered with.`)
            }
            if (tombstone.evidenceDigest !== observation.evidenceDigest) {
                fail('tombstone-evidence-digest-mismatch', `${key} evidence digest does not match the live observation.`)
            }
            if (key !== observation.dependencyKey) fail('tombstone-identity-mismatch', `${key} does not match its dependency key.`)
            if (tombstone.repository !== observation.repository) fail('tombstone-repository-mismatch', `${key} repository does not match.`)
            if (tombstone.issueNumber !== observation.issueNumber) fail('tombstone-issue-number-mismatch', `${key} issue number does not match.`)
            if (tombstone.issue !== `${tombstone.repository}#${tombstone.issueNumber}`) fail('tombstone-identity-mismatch', `${key} identity fields disagree.`)
            if (!/^[a-f0-9]{40}$/u.test(tombstone.deliveredCommit ?? '')) {
                fail('tombstone-delivered-commit-format', `${key} delivered commit must be a full SHA.`)
            }
            if (tombstone.deliveredCommit !== observation.deliveredCommit) fail('tombstone-identity-mismatch', `${key} delivered commit does not match.`)
            const repository = factsByName.get(tombstone.repository)
            if (!repository || tombstone.remoteDefaultBranch !== repository.defaultBranch || tombstone.remoteDefaultBranch !== observation.remoteDefaultBranch) {
                fail('tombstone-default-branch-mismatch', `${key} default branch does not match repository facts.`)
            }
            if (!isAncestor(repository.path, tombstone.deliveredCommit, repository.defaultBranch)) {
                fail('tombstone-delivered-commit-unreachable', `${key} delivered commit is not reachable from the default branch.`)
            }
            const closedAt = parseTimestamp(tombstone.closedAt, `${key}.closedAt`)
            if (closedAt > parseTimestamp(snapshot.refreshedAt, 'issue snapshot refreshedAt')) {
                fail('tombstone-closed-at-future', `${key} closedAt is later than the snapshot.`)
            }
            for (const field of ['remoteState', 'stateReason', 'closedAt', 'verifiedAt']) {
                if (tombstone[field] !== observation[field]) fail('tombstone-identity-mismatch', `${key}.${field} does not match the observation.`)
            }
            closedKeys.add(key)
            dependencyResolutions.push({ node: node.id, dependency: key, code: 'dependency-satisfied' })
        }
        for (const dependency of node.dependencyKeys) {
            if (!active.has(dependency) && !tombstoneKeys.has(dependency)) {
                if (observationsByKey.has(dependency)) fail('dependency-edge-deleted', `Node ${node.id} deleted dependency edge ${dependency}.`)
                fail('dependency-unknown', `Node ${node.id} has unknown dependency ${dependency}.`)
            }
        }
        for (const classified of [...active, ...tombstoneKeys]) {
            if (!dependencyKeys.has(classified)) fail('dependency-unknown', `Node ${node.id} classifies undeclared dependency ${classified}.`)
        }
        if (node.status === 'ready' || node.status === 'test-contract-frozen') {
            const incomplete = node.activeDependencies.filter((dependency) => nodesById.get(dependency).status !== 'closed')
            if (incomplete.length > 0) {
                fail('ready-dependency', `Ready node ${node.id} has incomplete dependencies.`, { incomplete })
            }
        }
    }
    if (invalidStatusNodes.length > 0) {
        const node = invalidStatusNodes[0]
        fail('node-status', `DAG node ${node.id} has invalid status ${node.status}.`)
    }
    validateAcyclic(nodesById)

    if (!Array.isArray(dag.readyFrontier)) fail('invalid-schema', 'DAG readyFrontier must be an array.')
    if (dag.readyFrontier.some((id) => closedKeys.has(id))) fail('tombstone-frontier-forbidden', 'A closed prerequisite cannot enter the ready frontier.')
    if (!Array.isArray(dag.activeAttempts)) fail('invalid-schema', 'DAG activeAttempts must be an array.')
    if (dag.activeAttempts.some((attempt) => closedKeys.has(attempt.issue))) fail('tombstone-attempt-forbidden', 'A closed prerequisite cannot have an active attempt.')

    if (!Array.isArray(dag.acceptanceGroups) || dag.acceptanceGroups.length === 0) {
        fail('acceptance-groups-missing', 'DAG acceptance groups are missing.')
    }
    const groupMembership = new Map()
    for (const group of dag.acceptanceGroups) {
        requireString(group.id, 'acceptanceGroup.id')
        if (groupMembership.has(group.id)) fail('acceptance-group-duplicate', `DAG repeats group ${group.id}.`)
        if (!Array.isArray(group.nodes) || group.nodes.length === 0) {
            fail('acceptance-group-empty', `Acceptance group ${group.id} is empty.`)
        }
        groupMembership.set(group.id, new Set(group.nodes))
    }
    for (const node of nodesById.values()) {
        const group = groupMembership.get(node.acceptanceGroup)
        if (!group || !group.has(node.id)) {
            fail('acceptance-group-mismatch', `Node ${node.id} is not present in its declared acceptance group.`)
        }
    }
    for (const [groupId, members] of groupMembership) {
        for (const member of members) {
            const node = nodesById.get(member)
            if (!node || node.acceptanceGroup !== groupId) {
                fail('acceptance-group-mismatch', `Acceptance group ${groupId} contains inconsistent node ${member}.`)
            }
        }
    }
    return { dependencyResolutions, closedPrerequisiteCount: closedKeys.size }
}

function validateRuntimePaths(dag, stateRoot) {
    const runtime = dag.runtimeFiles
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
        fail('runtime-files-missing', 'DAG runtimeFiles must declare the ledger, slots, locks, issue state, recovery fingerprints, and evidence paths.')
    }

    for (const field of ['ledger', 'slots', 'locks', 'issueState', 'recoveryFingerprints', 'evidence']) {
        requireString(runtime[field], `runtimeFiles.${field}`)
        if (isAbsolute(runtime[field])) {
            fail('runtime-path-absolute', `runtimeFiles.${field} must be relative to the validated state root.`)
        }
        const components = runtime[field].split(/[\\/]/u).filter((component) => component && component !== '.')
        if (components.includes('..')) {
            fail('runtime-path-escape', `runtimeFiles.${field} must not contain parent traversal.`, {
                value: runtime[field]
            })
        }
        const projected = resolve(stateRoot, runtime[field])
        if (!isWithinOrEqual(projected, stateRoot) || projected === stateRoot) {
            fail('runtime-path-escape', `runtimeFiles.${field} escapes the validated state root.`, {
                value: runtime[field],
                projected
            })
        }

        let cursor = stateRoot
        for (const component of components) {
            cursor = resolve(cursor, component)
            const stat = tryLstat(cursor)
            if (!stat) break
            if (stat.isSymbolicLink()) {
                fail('runtime-path-symlink', `runtimeFiles.${field} traverses a symbolic link.`, {
                    value: runtime[field],
                    symlink: cursor
                })
            }
        }
    }
}

export function checkDagGate({
    stateRoot,
    dagPath,
    issuesSnapshotPath,
    repositories,
    defaultBranches,
    workspaces,
    startupTime,
    factsOnly = false
}) {
    const rootValidation = validateStateRoot({
        candidate: stateRoot,
        repositories: repositories.map(({ path }) => path),
        workspaces
    })
    if (!rootValidation.candidate.exists) {
        fail('state-root-missing', 'Validated state root must exist before checking a DAG.')
    }

    const canonicalRoot = rootValidation.candidate.canonical
    const canonicalSnapshot = ensureStateFile(issuesSnapshotPath, canonicalRoot, 'issue-snapshot')
    const snapshot = readJson(canonicalSnapshot, 'issue-snapshot')

    const startup = parseTimestamp(startupTime, 'startup time')
    const repositoryNames = new Set(repositories.map(({ name }) => name))
    const snapshotValidation = validateIssueSnapshot(snapshot, startup, repositoryNames)
    const liveRepositories = repositoryFacts(repositories, defaultBranches)
    const repositoriesFingerprint = fingerprint(liveRepositories)

    if (factsOnly) {
        return {
            schema: 'issue-orchestration.dag-gate-result.v1',
            valid: true,
            dispatchEnabled: false,
            factsOnly: true,
            stateRoot: canonicalRoot,
            issuesSnapshot: canonicalSnapshot,
            issueSnapshotFingerprint: snapshotValidation.fingerprint,
            repositories: liveRepositories,
            repositoryFingerprint: repositoriesFingerprint
        }
    }

    const canonicalDag = ensureStateFile(dagPath, canonicalRoot, 'dag')
    const dag = readJson(canonicalDag, 'dag')
    if (dag?.investigationCompilerInput) {
        validateInvestigationProjection(dag.investigationCompilerInput)
    }
    const hasDispatchProjection = DISPATCH_PROJECTION_FIELDS.some(
        (field) => dag?.[field] !== undefined
    )
    if (hasDispatchProjection) {
        validateDispatchProjectionPresence(dag)
    }
    if (dag?.frontierProjection && dag?.frontierRuntime && dag?.selectorReceipt) {
        const frontierValidation = validateReadyFrontier({
            dag,
            runtimeState: dag.frontierRuntime,
            selectorReceipt: dag.selectorReceipt,
            investigationProjection: dag.investigationProjection,
            recordedProjection: dag.frontierProjection
        })
        if (!frontierValidation.valid) {
            fail(
                frontierValidation.code,
                'DAG ready frontier does not match independently compiled eligibility.'
            )
        }
    }
    if (hasDispatchProjection) {
        validateDispatchFrontierBinding({
            frontier: dag.dispatchFrontier,
            verifiedProjection: dag.frontierProjection,
            dag
        })
        validateDispatchBatch({
            frontier: dag.dispatchFrontier,
            rankingPolicy: dag.dispatchRankingPolicy,
            activeLeases: dag.dispatchLeases ?? [],
            availableSlots: Math.min(
                dag.subagentSlotsEffective,
                dag.frontierRuntime.availableSlots
            ),
            groupProposals: dag.acceptanceGroupProposals ?? [],
            recordedBatch: dag.dispatchBatch
        })
    }
    if (dag?.schema === 'issue-orchestration.dag.v1') {
        fail('dag-v1-rebuild-required', 'Legacy DAG v1 is diagnostic-only and must be rebuilt from remote facts.')
    }
    if (dag?.schema !== 'issue-orchestration.dag.v2') {
        fail('dag-schema', 'DAG schema is missing or unsupported.')
    }
    requireString(dag.runId, 'dag.runId')
    if (dag.subagentSlotsConfigured !== 15) {
        fail('subagent-slots-configured', 'DAG must configure exactly 15 subagent slots.')
    }
    if (
        !Number.isInteger(dag.subagentSlotsEffective)
        || dag.subagentSlotsEffective < 1
        || dag.subagentSlotsEffective > 15
    ) {
        fail('subagent-slots-effective', 'DAG effective subagent slots must be an integer from 1 through 15.')
    }
    requireString(dag.subagentCapacityEvidence, 'dag.subagentCapacityEvidence')
    if (dag.stateRootCanonical !== canonicalRoot) {
        fail('state-root-mismatch', 'DAG state root does not match the validated canonical state root.', {
            recorded: dag.stateRootCanonical,
            current: canonicalRoot
        })
    }

    validateRepositories(dag, liveRepositories)
    if (dag.remoteSnapshotDigest !== snapshotValidation.remoteSnapshotDigest) {
        fail('remote-snapshot-digest', 'DAG remote snapshot digest does not match current remote facts.')
    }
    validateStageReceipts(dag)
    const nodeValidation = validateNodesAndGroups(dag, snapshot, repositoryNames, liveRepositories)
    validateRuntimePaths(dag, canonicalRoot)

    const dagRefreshedAt = parseTimestamp(dag.refreshedAt, 'DAG refreshedAt')
    if (dagRefreshedAt < snapshotValidation.refreshedAt) {
        fail('dag-stale', 'DAG predates the current issue snapshot.')
    }
    if (dag.issueSnapshotFingerprint !== snapshotValidation.fingerprint) {
        fail('issue-scope-fingerprint', 'DAG issue scope fingerprint does not match current remote facts.')
    }
    if (dag.repositoryFingerprint !== repositoriesFingerprint) {
        fail('repository-fingerprint', 'DAG repository fingerprint does not match current repository facts.')
    }
    if (
        dag.consistency?.status !== 'passed'
        || dag.consistency.issueSnapshotFingerprint !== snapshotValidation.fingerprint
        || dag.consistency.repositoryFingerprint !== repositoriesFingerprint
    ) {
        fail('consistency-incomplete', 'DAG consistency evidence is absent or does not match current facts.')
    }
    parseTimestamp(dag.consistency.validatedAt, 'DAG consistency.validatedAt')

    return {
        schema: 'issue-orchestration.dag-gate-result.v1',
        valid: true,
        dispatchEnabled: true,
        stateRoot: canonicalRoot,
        dag: canonicalDag,
        issueSnapshotFingerprint: snapshotValidation.fingerprint,
        repositoryFingerprint: repositoriesFingerprint,
        nodeCount: dag.nodes.length,
        acceptanceGroupCount: dag.acceptanceGroups.length,
        closedPrerequisiteCount: nodeValidation.closedPrerequisiteCount,
        dependencyResolutions: nodeValidation.dependencyResolutions
    }
}

function valuesFor(argv, name) {
    const values = []
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== name) continue
        if (!argv[index + 1]) fail('missing-option-value', `Missing value for ${name}.`)
        values.push(argv[index + 1])
        index += 1
    }
    return values
}

function valueFor(argv, name) {
    return valuesFor(argv, name)[0] ?? null
}

function namedValues(argv, name) {
    return valuesFor(argv, name).map((value) => {
        const separatorIndex = value.indexOf('=')
        if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
            fail('invalid-option-value', `${name} values must use name=value.`)
        }
        return {
            name: value.slice(0, separatorIndex),
            value: value.slice(separatorIndex + 1)
        }
    })
}

function runCli() {
    try {
        const argv = process.argv.slice(2)
        const repositories = namedValues(argv, '--repository').map(({ name, value }) => ({
            name,
            path: value
        }))
        const defaultBranches = new Map(
            namedValues(argv, '--default-branch').map(({ name, value }) => [name, value])
        )
        const result = checkDagGate({
            stateRoot: valueFor(argv, '--state-root'),
            dagPath: valueFor(argv, '--dag'),
            issuesSnapshotPath: valueFor(argv, '--issues-snapshot'),
            repositories,
            defaultBranches,
            workspaces: valuesFor(argv, '--workspace'),
            startupTime: valueFor(argv, '--startup-time'),
            factsOnly: argv.includes('--facts-only')
        })
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
        const known = error instanceof DagGateError || error instanceof StateRootValidationError
        const payload = {
            schema: 'issue-orchestration.dag-gate-result.v1',
            valid: false,
            dispatchEnabled: false,
            code: known ? error.code : 'unexpected-error',
            reason: error.message,
            details: known ? error.details : {}
        }
        process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
        process.exitCode = 2
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
