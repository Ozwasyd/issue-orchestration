import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    writerStageBindingForKind
} from './issue-orchestration-writer-stage-test-helper.mjs'

const root = resolve(import.meta.dirname, '../..')
const implementationPath = resolve(
    root,
    'skills/issue-orchestration/scripts/dispatch-batch-selector.mjs'
)
const gatePath = resolve(
    root,
    'skills/issue-orchestration/scripts/check-dag-gate.mjs'
)
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const cases = readJson('dispatch-batch-cases.json')
const acceptanceMap = readJson('dispatch-batch-acceptance-map.json')
const mutationControls = readJson(
    'dispatch-batch-mutation-controls.json'
).controls
const runtimeProbes = readJson('dispatch-batch-runtime-probes.json')

const requiredExports = [
    'validateDispatchInput',
    'selectDispatchBatch',
    'validateDispatchBatch',
    'validateDispatchFrontierBinding',
    'acquireDispatchLease',
    'releaseDispatchLease',
    'recoverExpiredDispatchLease',
    'validateAcceptanceGroupProposal'
]
const frontierDispatchFields = [
    'frontierProjection',
    'frontierRuntime',
    'selectorReceipt',
    'dispatchFrontier',
    'dispatchRankingPolicy',
    'dispatchBatch'
]

let implementationPromise
let gatePromise
const writerGitFixtures = new Map()

after(() => {
    for (const fixture of writerGitFixtures.values()) fixture.dispose()
})

function readJson(name) {
    return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
}

function clone(value) {
    return structuredClone(value)
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value
            .map(canonical)
            .sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right))
            )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function orderedCanonical(value) {
    if (Array.isArray(value)) return value.map(orderedCanonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort()
            .map((key) => [key, orderedCanonical(value[key])])
    )
}

function orderedDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(orderedCanonical(value)))
        .digest('hex')
}

function initialWriterSequence(artifacts) {
    if (!artifacts.stageWorkPlan || !artifacts.executableSlice) return {}
    const plan = artifacts.stageWorkPlan
    const slice = artifacts.executableSlice
    const binding = {
        schema: 'issue-orchestration.writer-slice-sequence-binding.v1',
        source: 'initial-stage-plan',
        projectionStatus: null,
        planDigest: plan.planDigest,
        stageAttemptId: plan.stageAttemptId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        sliceIndex: 0,
        expectedNextSliceId: slice.sliceId,
        expectedNextSliceDigest: slice.sliceDigest,
        prerequisiteSliceIds: [],
        completedSliceReceiptDigests: [],
        writerStageProjectionDigest: null
    }
    return {
        writerSequenceBinding: binding,
        writerSequenceBindingDigest: orderedDigest(binding)
    }
}

async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1820 dispatch batch selector: ${implementationPath}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing exported function ${name}`)
    }
    return loaded
}

async function gateImplementation() {
    gatePromise ??= import(pathToFileURL(gatePath).href)
    const loaded = await gatePromise
    assert.equal(
        typeof loaded.validateDispatchProjectionPresence,
        'function',
        'check-dag-gate must export the executable dispatch projection presence validator'
    )
    return loaded
}

function conflictEvidence(keys) {
    return Object.fromEntries(keys.map((key) => [
        key,
        {
            sourceType: 'investigated-owner-write-surface',
            evidenceDigest: digest({ key, source: 'contract-fixture' })
        }
    ]))
}

function resourceEvidence(keys) {
    return Object.fromEntries(keys.map((key) => [
        key,
        {
            sourceType: 'explicit-runtime-requirement',
            evidenceDigest: digest({ key, source: 'contract-fixture' })
        }
    ]))
}

function writerGitFixtureFor(identity, filePaths) {
    const key = JSON.stringify([identity, filePaths])
    if (!writerGitFixtures.has(key)) {
        writerGitFixtures.set(
            key,
            createWriterStageGitFixture({ filePaths })
        )
    }
    return writerGitFixtures.get(key)
}

function stageTask(number, overrides = {}) {
    const issueId = overrides.issueId ?? `Ozwasyd/FsusBlog#${number}`
    const stageKind = overrides.stageKind ?? 'test-contract'
    const conflictKeys = overrides.conflictKeys ?? []
    const exclusiveResourceKeys = overrides.exclusiveResourceKeys ?? []
    const writePaths = overrides.writePaths
        ?? [`tests/contracts/issue-${number}.test.mjs`]
    const writerBinding = writerStageBindingForKind(
        stageKind,
        overrides.stageRole
    )
    const writerFixture = writerBinding && writePaths.length > 0
        ? overrides.writerGitFixture ?? writerGitFixtureFor(
            overrides.issueWorktreeId ?? `worktree-${number}`,
            writePaths
        )
        : null
    const writerArtifacts = overrides.writerArtifacts ??
        (writerBinding && writePaths.length > 0
            ? compileWriterStageTestArtifacts({
            repository: overrides.repository ?? 'Ozwasyd/FsusBlog',
            issue: overrides.issueNumber ?? number,
            node: issueId,
            stageRole: writerBinding.stageRole,
            stagePhase: writerBinding.stagePhase,
            baseSha: writerFixture.baseSha,
            runId: `run-dispatch-batch-${number}-${stageKind}`,
            epochId: overrides.epochId ?? 'epoch-1820-1',
            worktreeIdentity: writerFixture.worktreeIdentity,
            allowedPaths: writePaths,
            requiredFiles: [writePaths[0]],
            requiredCommands: [`node --check ${writePaths[0]}`],
            ...(stageKind === 'landing-conflict-resolution' &&
                overrides.landingConflictResolution
                ? {
                    requiredEvidence: [
                        'landing-conflict-source:' +
                            overrides.landingConflictResolution
                                .conflictSourceDigest,
                        'delivery-failure-receipt:' +
                            overrides.landingConflictResolution
                                .deliveryFailureReceiptDigest,
                        'landing-conflict-mapping:' +
                            overrides.landingConflictResolution
                                .conflictMappingDigest
                    ]
                }
                : {})
            })
            : {})
    const writerSequence = initialWriterSequence(writerArtifacts)
    const {
        issueWorktreeId: requestedWorktreeIdentity,
        writerGitFixture: requestedWriterFixture,
        writerArtifacts: requestedWriterArtifacts,
        ...publicOverrides
    } = overrides
    const task = {
        taskId: overrides.taskId ?? `${issueId}@${stageKind}`,
        issueId,
        issueNumber: overrides.issueNumber ?? number,
        repository: overrides.repository ?? 'Ozwasyd/FsusBlog',
        stageKind,
        stageRole: overrides.stageRole ?? 'test-owner',
        issueWorktreeId: writerFixture?.worktreeIdentity ??
            requestedWorktreeIdentity ?? `worktree-${number}`,
        writeScopeDigest: overrides.writeScopeDigest ?? digest(writePaths),
        writePaths,
        requiredReceiptDigests: overrides.requiredReceiptDigests ?? [],
        requiredSkillDigests: overrides.requiredSkillDigests ?? [],
        readOnly: overrides.readOnly ?? false,
        candidateSha: overrides.candidateSha ?? null,
        candidateFrozen: overrides.candidateFrozen ?? true,
        epochId: overrides.epochId ?? 'epoch-1820-1',
        priorityClass: overrides.priorityClass ?? 'P1',
        securityCritical: overrides.securityCritical ?? false,
        criticalPathLength: overrides.criticalPathLength ?? 1,
        downstreamBlockedCount: overrides.downstreamBlockedCount ?? 0,
        starvationAge: overrides.starvationAge ?? 0,
        conflictKeys,
        conflictKeyEvidence: overrides.conflictKeyEvidence
            ?? conflictEvidence(conflictKeys),
        exclusiveResourceKeys,
        resourceKeyEvidence: overrides.resourceKeyEvidence
            ?? resourceEvidence(exclusiveResourceKeys),
        validationClass: overrides.validationClass ?? 'focused-unit',
        estimatedLongTask: overrides.estimatedLongTask ?? false,
        acceptanceGroup: overrides.acceptanceGroup ?? `issue-${number}`,
        acceptanceGroupCompletionValue:
            overrides.acceptanceGroupCompletionValue ?? 0,
        stagePrerequisitesSatisfied:
            overrides.stagePrerequisitesSatisfied ?? true,
        dependencyStatus: overrides.dependencyStatus ?? 'satisfied',
        active: overrides.active ?? true,
        rootOnly: overrides.rootOnly ?? false,
        ...writerArtifacts,
        ...writerSequence
    }
    return { ...task, ...publicOverrides }
}

function sameWorktreeWriterTasks(number, identity) {
    const testPath = `tests/contracts/issue-${number}.test.mjs`
    const implementationPath = `src/issue-${number}.mjs`
    const writerGitFixture = writerGitFixtureFor(identity, [
        testPath,
        implementationPath
    ])
    return [
        stageTask(number, {
            issueWorktreeId: identity,
            writerGitFixture,
            writePaths: [testPath]
        }),
        stageTask(number, {
            taskId:
                `Ozwasyd/FsusBlog#${number}@code-implementation`,
            stageKind: 'code-implementation',
            stageRole: 'code-implementer',
            issueWorktreeId: identity,
            writerGitFixture,
            writePaths: [implementationPath]
        })
    ]
}

function twoSliceStageTask(number, sliceIndex, {
    sequenceSource = sliceIndex === 0
        ? 'initial-stage-plan'
        : 'semantic-runtime-projection'
} = {}) {
    const issueId = `Ozwasyd/FsusBlog#${number}`
    const writePaths = [
        `tests/contracts/issue-${number}-slice-1.test.mjs`,
        `tests/contracts/issue-${number}-slice-2.test.mjs`
    ]
    const writerFixture = writerGitFixtureFor(
        `worktree-${number}-two-slice`,
        writePaths
    )
    const artifacts = compileWriterStageTestArtifacts({
        repository: 'Ozwasyd/FsusBlog',
        issue: number,
        node: issueId,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        baseSha: writerFixture.baseSha,
        epochId: 'epoch-1820-two-slice-1',
        worktreeIdentity: writerFixture.worktreeIdentity,
        allowedPaths: writePaths,
        requiredFiles: writePaths,
        requiredCommands: writePaths.map((file) =>
            `node --check ${file}`),
        sliceCount: 2
    })
    const slice = artifacts.executableSlices[sliceIndex]
    const compiledPrompt = artifacts.compiledPrompts[sliceIndex]
    const initial = sliceIndex === 0
    const writerSequenceBinding = {
        schema: 'issue-orchestration.writer-slice-sequence-binding.v1',
        source: sequenceSource,
        projectionStatus: initial ? null : 'next-slice',
        planDigest: artifacts.planDigest,
        stageAttemptId: artifacts.stageWorkPlan.stageAttemptId,
        stageRole: artifacts.stageWorkPlan.stageRole,
        stagePhase: artifacts.stageWorkPlan.stagePhase,
        sliceIndex,
        expectedNextSliceId: slice.sliceId,
        expectedNextSliceDigest: slice.sliceDigest,
        prerequisiteSliceIds: [...slice.prerequisiteSliceIds],
        completedSliceReceiptDigests: initial ? [] : ['8'.repeat(64)],
        writerStageProjectionDigest: initial ? null : '9'.repeat(64)
    }
    return stageTask(number, {
        writePaths,
        writerGitFixture: writerFixture,
        writerArtifacts: artifacts,
        epochId: artifacts.stageWorkPlan.epochId,
        executableSlice: slice,
        sliceDigest: slice.sliceDigest,
        compiledPrompt,
        compiledPromptDigest: compiledPrompt.promptDigest,
        promptDigest: compiledPrompt.promptDigest,
        writerSequenceBinding,
        writerSequenceBindingDigest:
            orderedDigest(writerSequenceBinding)
    })
}

function landingConflictStageTask(number, overrides = {}) {
    const issueId =
        overrides.issueId ?? `Ozwasyd/FsusBlog#${number}`
    const epochId = overrides.epochId ?? 'epoch-1820-1'
    const issueWorktreeId =
        overrides.issueWorktreeId ?? `worktree-${number}`
    const stageRole = overrides.stageRole ?? 'code-implementer'
    const writePaths = overrides.writePaths ??
        [`src/landing-conflict-${number}.mjs`]
    const writerFixture = writerGitFixtureFor(
        overrides.issueWorktreeId ?? `worktree-${number}`,
        writePaths
    )
    const conflict = {
        schema: 'issue-orchestration.landing-conflict-resolution.v1',
        status: 'active',
        node: issueId,
        baseSha: writerFixture.baseSha,
        epochId,
        worktreeIdentity: writerFixture.worktreeIdentity,
        memberWriterRole: stageRole,
        conflictSource: 'delivery-failure-receipt',
        conflictSourceDigest: digest({
            issueId,
            source: 'machine-observed-landing-conflict'
        }),
        deliveryFailureReceiptDigest: digest({
            issueId,
            eventType: 'delivery.failed',
            failure: 'merge-conflict'
        }),
        conflictMappingDigest: digest({
            issueId,
            writePaths,
            mapping: 'ours-theirs-base'
        }),
        conflictPaths: [...writePaths]
    }
    conflict.resolutionDigest = digest(conflict)
    return stageTask(number, {
        ...overrides,
        issueId,
        epochId,
        issueWorktreeId,
        writerGitFixture: writerFixture,
        writePaths,
        stageKind: 'landing-conflict-resolution',
        stageRole,
        landingConflictResolution: conflict,
        landingConflictResolutionDigest: conflict.resolutionDigest
    })
}

function dispatchFrontier(tasks, semanticDependencies = []) {
    const body = {
        schema: 'issue-orchestration.dispatch-frontier.v1',
        selectorVersion: cases.selectorVersion,
        stageTasks: tasks,
        semanticDependencies
    }
    return {
        ...body,
        frontierDigest: digest(body)
    }
}

const readyStageByKind = new Map([
    ['test-contract', 'test-contract-ready'],
    ['code-implementation', 'implementation-ready'],
    ['ui-ux-implementation', 'implementation-ready'],
    ['landing-conflict-resolution',
        'landing-conflict-resolution-ready'],
    ['behavior-verification', 'behavior-verification-ready'],
    ['ux-acceptance', 'ux-acceptance-ready'],
    ['documentation', 'documentation-ready'],
    ['delivery', 'delivery-ready'],
    ['cleanup', 'cleanup-ready']
])

function frontierBindingFixture(tasks) {
    return {
        frontier: dispatchFrontier(clone(tasks)),
        verifiedProjection: {
            schema: 'issue-orchestration.frontier-projection.v1',
            frontierDigest: '8'.repeat(64),
            readyFrontier: tasks.map((task) => ({
                issueId: task.issueId,
                stage: readyStageByKind.get(task.stageKind)
            })),
            executionProjection: tasks.map((task) => ({
                issueId: task.issueId,
                stage: readyStageByKind.get(task.stageKind),
                planDigest: task.planDigest,
                sliceDigest: task.sliceDigest,
                compiledPromptDigest: task.compiledPromptDigest,
                writerSequenceBinding:
                    clone(task.writerSequenceBinding),
                writerSequenceBindingDigest:
                    task.writerSequenceBindingDigest,
                landingConflictResolutionDigest:
                    task.landingConflictResolutionDigest ?? null,
                candidateCapabilityReceiptDigest: digest({
                    issueId: task.issueId,
                    stageKind: task.stageKind
                })
            }))
        },
        dag: {
            nodes: tasks.map((task) => ({
                id: task.issueId,
                priorityClass: task.priorityClass,
                criticalPathLength: task.criticalPathLength,
                downstreamBlockedCount: task.downstreamBlockedCount,
                starvationAge: task.starvationAge,
                acceptanceGroup: task.acceptanceGroup,
                acceptanceGroupCompletionValue:
                    task.acceptanceGroupCompletionValue,
                conflictKeys: clone(task.conflictKeys),
                conflictKeyEvidence: clone(task.conflictKeyEvidence),
                exclusiveResourceKeys: clone(task.exclusiveResourceKeys),
                resourceKeyEvidence: clone(task.resourceKeyEvidence),
                validationClass: task.validationClass,
                estimatedLongTask: task.estimatedLongTask,
                stageRole: task.stageRole,
                issueWorktreeId: task.issueWorktreeId,
                writeScopeDigest: task.writeScopeDigest,
                requiredReceiptDigests: clone(task.requiredReceiptDigests),
                requiredSkillDigests: clone(task.requiredSkillDigests),
                readOnly: task.readOnly,
                candidateSha: task.candidateSha,
                candidateFrozen: task.candidateFrozen,
                epochId: task.epochId,
                ...(writerStageBindingForKind(
                    task.stageKind,
                    task.stageRole
                )
                    ? {
                        planDigest: task.planDigest,
                        sliceDigest: task.sliceDigest,
                        compiledPromptDigest: task.compiledPromptDigest,
                        stageWorkPlan: clone(task.stageWorkPlan),
                        executableSlice: clone(task.executableSlice),
                        compiledPrompt: clone(task.compiledPrompt),
                        ...(task.stageKind ===
                            'landing-conflict-resolution'
                            ? {
                                landingConflictResolution:
                                    clone(task.landingConflictResolution),
                                landingConflictResolutionDigest:
                                    task.landingConflictResolutionDigest
                            }
                            : {})
                    }
                    : {})
            }))
        }
    }
}

function leaseRecord({
    attemptId = 'attempt-active-1',
    expiresAt = '2026-08-01T04:00:00.000Z',
    keys = ['resource:browser:native-ime'],
    kind = 'resource',
    leaseId = 'lease-active-1',
    ownerId = 'test-owner-active-1',
    stageTaskId = 'Ozwasyd/FsusUI#268@behavior-verification',
    state = 'active'
} = {}) {
    const body = {
        schema: 'issue-orchestration.dispatch-lease.v1',
        leaseId,
        kind,
        keys,
        ownerId,
        attemptId,
        stageTaskId,
        acquiredAt: '2026-08-01T03:00:00.000Z',
        expiresAt,
        recoveryRule: 'verify-owner-terminal-then-record-recovery-evidence',
        state
    }
    return {
        ...body,
        leaseDigest: digest(body)
    }
}

function groupProposal(overrides = {}) {
    const body = {
        schema: 'issue-orchestration.acceptance-group-proposal.v1',
        proposalId: 'group-proposal-1',
        repository: 'Ozwasyd/FsusBlog',
        memberIssueIds: [
            'Ozwasyd/FsusBlog#9401',
            'Ozwasyd/FsusBlog#9402'
        ],
        memberOrder: [
            'Ozwasyd/FsusBlog#9401',
            'Ozwasyd/FsusBlog#9402'
        ],
        sharedPaths: ['tests/contracts/shared.test.mjs'],
        sharedConflictKeys: ['write:FsusBlog:shared-contract-tests'],
        sharedBuildOrRuntimeResources: ['resource:node:test-runner'],
        estimatedColdStartSavings: {
            unit: 'seconds',
            value: 45,
            evidenceDigest: '1'.repeat(64)
        },
        lostParallelismEstimate: {
            unit: 'slots',
            value: 0,
            evidenceDigest: '2'.repeat(64)
        },
        atomicCommitFeasibility: {
            feasible: true,
            independentMemberCommits: true,
            evidenceDigest: '3'.repeat(64)
        },
        sameEpochEvidence: {
            epochId: 'epoch-1820-1',
            evidenceDigest: '4'.repeat(64)
        },
        fallbackReason: 'qualification-failure-dispatches-per-issue',
        activeMemberIssueId: 'Ozwasyd/FsusBlog#9401',
        ...overrides
    }
    delete body.proposalDigest
    return {
        ...body,
        proposalDigest: orderedProposalDigest(body)
    }
}

function orderedProposalDigest(proposal) {
    const normalized = canonical(proposal)
    normalized.memberOrder = proposal.memberOrder.map(canonical)
    return createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex')
}

async function select({
    tasks,
    availableSlots = 15,
    activeLeases = [],
    semanticDependencies = [],
    groupProposals = [],
    computedAt = cases.computedAt
}) {
    const { selectDispatchBatch } = await implementation()
    return selectDispatchBatch({
        frontier: dispatchFrontier(clone(tasks), clone(semanticDependencies)),
        rankingPolicy: clone(cases.rankingPolicy),
        activeLeases: clone(activeLeases),
        availableSlots,
        groupProposals: clone(groupProposals),
        computedAt
    })
}

async function validateBatch({
    tasks,
    recordedBatch,
    availableSlots = 15,
    activeLeases = [],
    semanticDependencies = [],
    groupProposals = []
}) {
    const { validateDispatchBatch } = await implementation()
    return validateDispatchBatch({
        frontier: dispatchFrontier(clone(tasks), clone(semanticDependencies)),
        rankingPolicy: clone(cases.rankingPolicy),
        activeLeases: clone(activeLeases),
        availableSlots,
        groupProposals: clone(groupProposals),
        recordedBatch: clone(recordedBatch)
    })
}

async function validateInput({
    tasks,
    activeLeases = [],
    semanticDependencies = [],
    groupProposals = []
}) {
    const { validateDispatchInput } = await implementation()
    return validateDispatchInput({
        frontier: dispatchFrontier(clone(tasks), clone(semanticDependencies)),
        rankingPolicy: clone(cases.rankingPolicy),
        activeLeases: clone(activeLeases),
        groupProposals: clone(groupProposals)
    })
}

async function validateBinding(fixture) {
    const { validateDispatchFrontierBinding } = await implementation()
    return validateDispatchFrontierBinding(clone(fixture))
}

async function expectDenied(operation, expectedCode) {
    try {
        const result = await operation()
        assert.equal(result?.valid, false, `expected denial ${expectedCode}`)
        assert.equal(result.code, expectedCode)
        return result
    } catch (error) {
        assert.equal(error?.code, expectedCode, error?.stack ?? String(error))
        return error
    }
}

function selectedIds(batch) {
    return batch.selected.map((entry) =>
        typeof entry === 'string' ? entry : entry.taskId
    )
}

function deferredIds(batch) {
    return batch.deferred.map((entry) =>
        typeof entry === 'string' ? entry : entry.taskId
    )
}

function assertBatchShape(batch, tasks, availableSlots) {
    assert.equal(batch.schema, 'issue-orchestration.dispatch-batch.v1')
    assert.equal(batch.selectorVersion, cases.selectorVersion)
    assert.match(batch.batchDigest, /^[a-f0-9]{64}$/u)
    assert.ok(Array.isArray(batch.selected))
    assert.ok(Array.isArray(batch.deferred))
    assert.ok(batch.selected.length <= availableSlots)
    const selected = selectedIds(batch)
    const deferred = deferredIds(batch)
    assert.equal(new Set([...selected, ...deferred]).size, tasks.length)
    assert.deepEqual(
        [...selected, ...deferred].toSorted(),
        tasks.map(({ taskId }) => taskId).toSorted()
    )
    for (const taskId of selected) {
        const reason = batch.selectionReasons[taskId]
        assert.equal(typeof reason?.code, 'string')
        assert.deepEqual(
            Object.keys(reason.rankComponents).toSorted(),
            [
                'acceptanceGroupCompletionValue',
                'criticalPathLength',
                'downstreamBlockedCount',
                'priorityClass',
                'stableNodeIdentity',
                'starvationAge',
                'validationClass',
                'estimatedLongTask'
            ].toSorted()
        )
    }
    for (const taskId of deferred) {
        const reason = batch.deferReasons[taskId]
        assert.ok(cases.structuredDeferReasonCodes.includes(reason?.code))
        assert.ok(Array.isArray(reason.selectionBlockedBy))
    }
}

function independentTasks(count, start = 9200) {
    return Array.from({ length: count }, (_, index) =>
        stageTask(start + index, {
            criticalPathLength: 1,
            downstreamBlockedCount: 0,
            starvationAge: 0
        })
    )
}

test('contract fixtures cover every acceptance and mutation identity', () => {
    assert.equal(cases.contractRevision, 1)
    assert.equal(cases.baseSha, '0c363486d0b7f08fc0a078aba3655d86420dceab')
    assert.deepEqual(cases.previousDeliveryEpoch, {
        baseSha: 'c8cb56dce27769a3cc3663cc0e39cc0a75716fed',
        testTreeDigest: '800ec1cb9fcfc640a5b019190e90df7e7b367128d2e143ee9800371d0b97a37e',
        testContractDigest: '374a4fb2ccbcc4ef642fb4d0a2dffde9d9667997949db4b41244e306c130dcfd',
        candidateDigest: '54d401ed44ca536cc6178ea96e067a551e6ccedd27fd63be694a56b4601eb4ca',
        green: {
            tests: 92,
            passed: 92,
            failed: 0,
            exitCode: 0
        }
    })
    assert.equal(
        cases.previousRevision.testContractDigest,
        '588acfb637ac0f319344bf63e9134f895fd5a85a08cf323713d297caad6084a8'
    )
    assert.deepEqual(cases.previousRevision.red, {
        tests: 64,
        passed: 4,
        failed: 60,
        exitCode: 1,
        failureClass: 'dispatch-batch-selector-missing'
    })
    assert.deepEqual(cases.receiptIdentityPolicy, {
        schema: 'issue-orchestration.receipt-identity-policy.v1',
        canonicalEncoding: 'utf8-json-recursive-object-key-sort-array-order-preserved',
        hashAlgorithm: 'sha256-lowercase-hex',
        testTreeDigestInput: 'path-sorted testFiles[{path,sha256,gitMode}]',
        testContractDigestOmittedFields: [
            'testContractDigest',
            'candidateDigest'
        ],
        candidateDigestInput: '{baseSha,testContractDigest,path-sorted implementationFiles[{path,sha256,gitMode}]}',
        implementationFiles: [
            {
                path: 'skills/issue-orchestration/scripts/check-dag-gate.mjs',
                sha256: '7ca98a2349e9f3eb6014cf61faeb5867b6adcde0a28a2046215104c71209a84d',
                gitMode: '100644'
            },
            {
                path: 'skills/issue-orchestration/scripts/dispatch-batch-selector.mjs',
                sha256: '36c4d3607b87e11f9fcd796377a3ff6e93f1b471befcf14241d8dbede9d48f42',
                gitMode: '100644'
            }
        ]
    })
    assert.equal(new Set(mutationControls.map(({ id }) => id)).size, mutationControls.length)
    const mappedMutations = new Set(
        acceptanceMap.acceptance.flatMap(({ mutations }) => mutations)
    )
    assert.deepEqual(
        [...mappedMutations].toSorted(),
        mutationControls.map(({ id }) => id).toSorted()
    )
    assert.equal(cases.stageKinds.includes('test-contract'), true)
    assert.equal(cases.stageKinds.includes('delivery'), true)
    assert.equal(cases.selectableStageRoles.includes('dag-creator-updater'), false)
})

test('FsusUI 267-279 dependency sample is exact and owner-surface evidence is explicit', () => {
    const sample = cases.fsusUiSample
    assert.equal(sample.issues.length, 13)
    assert.deepEqual(
        sample.issues.map(({ issueId }) => issueId),
        Array.from(
            { length: 13 },
            (_, index) => `Ozwasyd/FsusUI#${267 + index}`
        )
    )
    assert.deepEqual(
        sample.issues.find(({ issueId }) => issueId.endsWith('#279')).dependsOn,
        [
            'Ozwasyd/FsusUI#268',
            'Ozwasyd/FsusUI#270',
            'Ozwasyd/FsusUI#275'
        ]
    )
    assert.deepEqual(
        sample.issues.filter(({ dependsOn }) => dependsOn.length === 0)
            .map(({ issueId }) => issueId),
        ['Ozwasyd/FsusUI#267', 'Ozwasyd/FsusUI#268', 'Ozwasyd/FsusUI#272']
    )
    assert.ok(sample.issues.every(({ ownerSurfaces }) => ownerSurfaces.length > 0))
})

test('runtime probes and resource observation are frozen', () => {
    assert.equal(runtimeProbes.probes.length, 5)
    assert.equal(
        runtimeProbes.probes.find(({ id }) => id === 'RP-FSUSBLOG-BASE')
            .headSha,
        cases.baseSha
    )
    assert.deepEqual(runtimeProbes.resourceObservation, {
        ports: [],
        containers: [],
        networks: [],
        locks: [],
        persistentProcesses: [],
        temporaryRoots: []
    })
})

test('[P01] all six frontier/dispatch fields cannot disappear as one bypass', async () => {
    const { validateDispatchProjectionPresence } = await gateImplementation()
    const complete = Object.fromEntries(
        frontierDispatchFields.map((field) => [field, { field }])
    )
    assert.equal(
        validateDispatchProjectionPresence(complete).valid,
        true
    )
    for (const field of frontierDispatchFields) {
        const missingOne = clone(complete)
        delete missingOne[field]
        await expectDenied(
            () => validateDispatchProjectionPresence(missingOne),
            'dispatch-projection-incomplete'
        )
    }
    await expectDenied(
        () => validateDispatchProjectionPresence({}),
        'dispatch-projection-required'
    )
})

test('[P02] writer tasks require the complete compiler-owned executable slice chain', async () => {
    const task = stageTask(9299)
    assert.equal((await validateInput({ tasks: [task] })).valid, true)
    for (const field of [
        'planDigest',
        'sliceDigest',
        'compiledPromptDigest',
        'stageWorkPlan',
        'executableSlice',
        'compiledPrompt'
    ]) {
        const mutated = clone(task)
        delete mutated[field]
        await expectDenied(
            () => validateInput({ tasks: [mutated] }),
            'stage-task-executable-slice'
        )
    }
})

test('[P02A] writer tasks select a two-slice stage only in projection order', async () => {
    const first = twoSliceStageTask(9291, 0)
    assert.equal(
        (await validateInput({ tasks: [first] })).valid,
        true
    )

    const wrongOrder = twoSliceStageTask(9290, 1, {
        sequenceSource: 'initial-stage-plan'
    })
    await expectDenied(
        () => validateInput({ tasks: [wrongOrder] }),
        'stage-task-writer-sequence'
    )

    const second = twoSliceStageTask(9289, 1)
    assert.equal(
        (await validateInput({ tasks: [second] })).valid,
        true
    )
    const fixture = frontierBindingFixture([second])
    assert.equal((await validateBinding(fixture)).valid, true)

    const forgedProjection = frontierBindingFixture([second])
    forgedProjection.verifiedProjection.executionProjection[0]
        .writerSequenceBinding.expectedNextSliceDigest = '0'.repeat(64)
    forgedProjection.verifiedProjection.executionProjection[0]
        .writerSequenceBindingDigest = orderedDigest(
            forgedProjection.verifiedProjection.executionProjection[0]
                .writerSequenceBinding
        )
    await expectDenied(
        () => validateBinding(forgedProjection),
        'dispatch-frontier-binding'
    )

    const unbound = clone(first)
    unbound.stageWorkPlan.plannerBindingStatus =
        'unbound-test-only'
    unbound.executableSlice.plannerBindingStatus =
        'unbound-test-only'
    await expectDenied(
        () => validateInput({ tasks: [unbound] }),
        'stage-task-executable-slice'
    )
})

test('[P03] landing conflict tasks reuse only code or UI writers and bind the verified frontier', async () => {
    const tasks = [
        landingConflictStageTask(9297),
        landingConflictStageTask(9298, {
            stageRole: 'ui-ux-implementer'
        })
    ]
    assert.equal((await validateInput({ tasks })).valid, true)
    assert.equal(
        (await validateBinding(frontierBindingFixture(tasks))).valid,
        true
    )
    const batch = await select({ tasks, availableSlots: 2 })
    assert.deepEqual(
        batch.selected.map(({ taskId }) => taskId).toSorted(),
        tasks.map(({ taskId }) => taskId).toSorted()
    )
    assert.ok(tasks.every(({ stageRole }) =>
        ['code-implementer', 'ui-ux-implementer'].includes(stageRole)))
})

test('[P04] landing evidence is complete, identity-bound, and has no ordinary implementation fallback', async () => {
    const requiredFields = [
        'conflictSourceDigest',
        'deliveryFailureReceiptDigest',
        'conflictMappingDigest',
        'node',
        'baseSha',
        'epochId',
        'worktreeIdentity',
        'memberWriterRole',
        'resolutionDigest'
    ]
    for (const field of requiredFields) {
        const task = landingConflictStageTask(9296)
        delete task.landingConflictResolution[field]
        await expectDenied(
            () => validateInput({ tasks: [task] }),
            'stage-task-landing-conflict-binding'
        )
    }

    const owner = landingConflictStageTask(9295, {
        stageRole: 'landing-owner'
    })
    await expectDenied(
        () => validateInput({ tasks: [owner] }),
        'stage-role-not-selectable'
    )

    const fallback = landingConflictStageTask(9294)
    const ordinary = stageTask(9294, {
        stageKind: 'code-implementation',
        stageRole: 'code-implementer',
        issueWorktreeId: fallback.issueWorktreeId,
        writePaths: fallback.writePaths
    })
    for (const field of [
        'stageWorkPlan',
        'executableSlice',
        'compiledPrompt',
        'planDigest',
        'sliceDigest',
        'compiledPromptDigest',
        'writerSequenceBinding',
        'writerSequenceBindingDigest'
    ]) {
        fallback[field] = clone(ordinary[field])
    }
    await expectDenied(
        () => validateInput({ tasks: [fallback] }),
        'stage-task-landing-conflict-binding'
    )
})

test('[P05] landing task cannot detach from the verified execution projection', async () => {
    const task = landingConflictStageTask(9293)
    const fixture = frontierBindingFixture([task])
    delete fixture.verifiedProjection.executionProjection[0]
        .landingConflictResolutionDigest
    await expectDenied(
        () => validateBinding(fixture),
        'dispatch-frontier-binding'
    )

    const nodeDrift = frontierBindingFixture([task])
    nodeDrift.dag.nodes[0].landingConflictResolutionDigest =
        'f'.repeat(64)
    await expectDenied(
        () => validateBinding(nodeDrift),
        'dispatch-frontier-binding'
    )
})

test('[P06] landing permissions exist only for the bound code and UI writers', () => {
    const policy = JSON.parse(readFileSync(resolve(
        root,
        'policy/stage-permissions.json'
    ), 'utf8'))
    const landingEntries = Object.entries(policy.stages)
        .filter(([key]) =>
            key.endsWith(':landing-conflict-resolution'))
    assert.deepEqual(
        landingEntries.map(([key]) => key).toSorted(),
        [
            'code-implementer:landing-conflict-resolution',
            'ui-ux-implementer:landing-conflict-resolution'
        ]
    )
    for (const [, permission] of landingEntries) {
        assert.deepEqual(permission, {
            sandbox: 'workspace-write',
            writeScope: 'implementation-only',
            freshContext: false
        })
    }
    assert.equal(
        Object.hasOwn(
            policy.stages,
            'landing-owner:landing-conflict-resolution'
        ),
        false
    )
})

test('[B01] selector emits deterministic exact batch and auditable rank components', async () => {
    const tasks = [
        stageTask(9301, { priorityClass: 'P1', downstreamBlockedCount: 1 }),
        stageTask(9302, { priorityClass: 'P0', criticalPathLength: 2 }),
        stageTask(9303, { priorityClass: 'P2', starvationAge: 500 })
    ]
    const first = await select({ tasks, availableSlots: 2 })
    const replay = await select({
        tasks: clone(tasks).reverse(),
        availableSlots: 2,
        computedAt: cases.laterComputedAt
    })
    assertBatchShape(first, tasks, 2)
    assert.deepEqual(replay.selected, first.selected)
    assert.deepEqual(replay.deferred, first.deferred)
    assert.equal(replay.batchDigest, first.batchDigest)
})

test('[B02] downstream unlock and critical path outrank issue number and array order', async () => {
    const highUnlock = stageTask(9999, {
        downstreamBlockedCount: 8,
        criticalPathLength: 6
    })
    const lowNumber = stageTask(1, {
        downstreamBlockedCount: 0,
        criticalPathLength: 1
    })
    const batch = await select({
        tasks: [lowNumber, highUnlock],
        availableSlots: 1
    })
    assert.deepEqual(selectedIds(batch), [highUnlock.taskId])
})

test('[B03] strict P0 priority beats P2 issue number, starvation, and group value', async () => {
    const p0 = stageTask(9998, {
        priorityClass: 'P0',
        securityCritical: true
    })
    const p2 = stageTask(2, {
        priorityClass: 'P2',
        starvationAge: 100000,
        acceptanceGroupCompletionValue: 100000
    })
    const batch = await select({ tasks: [p2, p0], availableSlots: 1 })
    assert.deepEqual(selectedIds(batch), [p0.taskId])
})

test('[B04] starvation eventually advances an eligible same-priority task', async () => {
    const starved = stageTask(9310, {
        starvationAge: 1000,
        criticalPathLength: 1
    })
    const newUnlock = stageTask(9311, {
        starvationAge: 0,
        criticalPathLength: 5,
        downstreamBlockedCount: 2
    })
    const batch = await select({
        tasks: [newUnlock, starved],
        availableSlots: 1
    })
    assert.deepEqual(selectedIds(batch), [starved.taskId])
})

test('[B05] twenty independent safe stage tasks exactly fill fifteen slots', async () => {
    const tasks = independentTasks(20)
    const batch = await select({ tasks, availableSlots: 15 })
    assertBatchShape(batch, tasks, 15)
    assert.equal(batch.selected.length, 15)
    assert.equal(batch.deferred.length, 5)
})

test('[B06] only N safe tasks means selected equals N without illegal fill', async () => {
    const conflictKey = 'write:FsusBlog:orchestration-core'
    const writerA = stageTask(9320, {
        priorityClass: 'P0',
        conflictKeys: [conflictKey]
    })
    const writerB = stageTask(9321, {
        conflictKeys: [conflictKey]
    })
    const independent = stageTask(9322)
    const batch = await select({
        tasks: [writerA, writerB, independent],
        availableSlots: 15
    })
    assert.equal(batch.selected.length, 2)
    assert.equal(batch.deferred.length, 1)
    assert.equal(
        batch.deferReasons[writerB.taskId].code,
        'write-conflict'
    )
})

test('[C01] writers sharing an explicit conflict key never run together', async () => {
    const key = 'write:FsusBlog:dispatch-selector'
    const tasks = [
        stageTask(9330, { conflictKeys: [key] }),
        stageTask(9331, { conflictKeys: [key] })
    ]
    const batch = await select({ tasks, availableSlots: 2 })
    assert.equal(batch.selected.length, 1)
    assert.equal(batch.deferred.length, 1)
    assert.deepEqual(
        batch.deferReasons[deferredIds(batch)[0]].selectionBlockedBy,
        selectedIds(batch)
    )
})

test('[C02] same issue worktree test and implementation writers cannot fill two slots', async () => {
    const [testWriter, codeWriter] = sameWorktreeWriterTasks(
        9340,
        'worktree-same-issue'
    )
    const batch = await select({
        tasks: [testWriter, codeWriter],
        availableSlots: 2
    })
    assert.equal(batch.selected.length, 1)
    assert.equal(
        batch.deferReasons[deferredIds(batch)[0]].code,
        'worktree-write-conflict'
    )
})

test('[C03] releasing conflict requires no semantic dependency graph change', async () => {
    const key = 'write:FsusBlog:shared-owner'
    const first = stageTask(9350, { priorityClass: 'P0', conflictKeys: [key] })
    const second = stageTask(9351, { conflictKeys: [key] })
    const roundOne = await select({
        tasks: [first, second],
        availableSlots: 2
    })
    assert.deepEqual(deferredIds(roundOne), [second.taskId])
    const roundTwo = await select({
        tasks: [second],
        availableSlots: 2,
        semanticDependencies: []
    })
    assert.deepEqual(selectedIds(roundTwo), [second.taskId])
})

test('[C04] path-prefix-only conflict provenance and fake dependencies fail closed', async () => {
    const key = 'write:FsusBlog:path-prefix-only'
    const task = stageTask(9352, {
        conflictKeys: [key],
        conflictKeyEvidence: {
            [key]: {
                sourceType: 'filename-prefix',
                evidenceDigest: digest(key)
            }
        }
    })
    await expectDenied(
        () => validateInput({ tasks: [task] }),
        'conflict-key-evidence'
    )
    await expectDenied(
        () => validateInput({
            tasks: [stageTask(9353), stageTask(9354)],
            semanticDependencies: [{
                from: 'Ozwasyd/FsusBlog#9353',
                to: 'Ozwasyd/FsusBlog#9354',
                reason: 'serialize shared writer',
                serializationOnly: true,
                evidenceDigest: 'a'.repeat(64)
            }]
        }),
        'semantic-conflict-conflation'
    )
})

const bindingFactMutations = [
    {
        id: 'conflict-keys-removed',
        mutate(task) {
            task.conflictKeys = []
        }
    },
    {
        id: 'conflict-evidence-removed',
        mutate(task) {
            task.conflictKeyEvidence = {}
        }
    },
    {
        id: 'resource-keys-removed',
        mutate(task) {
            task.exclusiveResourceKeys = []
        }
    },
    {
        id: 'resource-evidence-removed',
        mutate(task) {
            task.resourceKeyEvidence = {}
        }
    },
    {
        id: 'candidate-sha-drift',
        target: 1,
        mutate(task) {
            task.candidateSha = 'f'.repeat(40)
        }
    },
    {
        id: 'candidate-frozen-drift',
        target: 1,
        mutate(task) {
            task.candidateFrozen = false
        }
    }
]

for (const mutation of bindingFactMutations) {
    test(`[C05] #1816 binding rejects ${mutation.id}`, async () => {
        const conflictKey = 'write:FsusBlog:frontier-bound-owner'
        const resourceKey = 'resource:docker:frontier-bound'
        const tasks = [
            stageTask(9355, {
                conflictKeys: [conflictKey],
                exclusiveResourceKeys: [resourceKey]
            }),
            stageTask(9356, {
                stageKind: 'behavior-verification',
                stageRole: 'test-owner',
                readOnly: true,
                writePaths: [],
                writeScopeDigest: digest([]),
                candidateSha: 'e'.repeat(40),
                conflictKeys: [],
                exclusiveResourceKeys: []
            })
        ]
        const fixture = frontierBindingFixture(tasks)
        mutation.mutate(
            fixture.frontier.stageTasks[mutation.target ?? 0]
        )
        fixture.frontier = dispatchFrontier(
            fixture.frontier.stageTasks,
            fixture.frontier.semanticDependencies
        )
        await expectDenied(
            () => validateBinding(fixture),
            'dispatch-frontier-binding'
        )
    })
}

test('[C06] removing one shared conflict fact cannot make both writers selectable', async () => {
    const conflictKey = 'write:FsusBlog:shared-bound-owner'
    const tasks = [
        stageTask(9357, {
            priorityClass: 'P0',
            conflictKeys: [conflictKey]
        }),
        stageTask(9358, {
            conflictKeys: [conflictKey]
        })
    ]
    const fixture = frontierBindingFixture(tasks)
    fixture.frontier.stageTasks[1].conflictKeys = []
    fixture.frontier.stageTasks[1].conflictKeyEvidence = {}
    fixture.frontier = dispatchFrontier(fixture.frontier.stageTasks)
    await expectDenied(
        () => validateBinding(fixture),
        'dispatch-frontier-binding'
    )
})

test('[L01] a running long browser task blocks only its own explicit resource key', async () => {
    const browserTask = stageTask(9360, {
        exclusiveResourceKeys: ['resource:browser:native-ime'],
        estimatedLongTask: true
    })
    const safeTasks = independentTasks(10, 9361)
    const lease = leaseRecord()
    const batch = await select({
        tasks: [browserTask, ...safeTasks],
        availableSlots: 14,
        activeLeases: [lease]
    })
    assert.equal(batch.selected.length, 10)
    assert.deepEqual(
        selectedIds(batch).toSorted(),
        safeTasks.map(({ taskId }) => taskId).toSorted()
    )
    assert.equal(
        batch.deferReasons[browserTask.taskId].code,
        'resource-lease-held'
    )
})

test('[L02] resource lease cannot be bypassed to fill a spare slot', async () => {
    const task = stageTask(9370, {
        exclusiveResourceKeys: ['resource:browser:native-ime']
    })
    const batch = await select({
        tasks: [task],
        availableSlots: 15,
        activeLeases: [leaseRecord()]
    })
    assert.deepEqual(batch.selected, [])
    assert.deepEqual(deferredIds(batch), [task.taskId])
})

test('[L03] lease acquisition binds owner, attempt, time, recovery, keys, and digest', async () => {
    const { acquireDispatchLease } = await implementation()
    const result = acquireDispatchLease({
        activeLeases: [],
        request: {
            leaseId: 'lease-new-1',
            kind: 'write',
            keys: ['write:FsusBlog:dispatch-selector'],
            ownerId: 'test-owner-1820',
            attemptId: 'attempt-1820-1',
            stageTaskId: 'Ozwasyd/FsusBlog#1820@test-contract',
            acquiredAt: cases.computedAt,
            expiresAt: '2026-08-01T04:00:00.000Z',
            recoveryRule: 'verify-owner-terminal-then-record-recovery-evidence'
        }
    })
    const lease = result.lease ?? result
    assert.equal(lease.ownerId, 'test-owner-1820')
    assert.equal(lease.attemptId, 'attempt-1820-1')
    assert.match(lease.leaseDigest, /^[a-f0-9]{64}$/u)
    await expectDenied(
        () => acquireDispatchLease({
            activeLeases: [lease],
            request: {
                ...lease,
                leaseId: 'lease-new-2',
                attemptId: 'attempt-1820-2',
                leaseDigest: undefined
            }
        }),
        'lease-conflict-held'
    )
})

test('[L04] only matching attempt releases a lease', async () => {
    const { releaseDispatchLease } = await implementation()
    const lease = leaseRecord({ kind: 'write', keys: ['write:FsusBlog:core'] })
    await expectDenied(
        () => releaseDispatchLease({
            lease,
            attemptId: 'attempt-wrong',
            releasedAt: cases.laterComputedAt
        }),
        'lease-attempt-mismatch'
    )
    const released = releaseDispatchLease({
        lease,
        attemptId: lease.attemptId,
        releasedAt: cases.laterComputedAt
    })
    assert.equal((released.lease ?? released).state, 'released')
})

test('[L05] expiry requires recovery evidence before another attempt acquires', async () => {
    const {
        acquireDispatchLease,
        recoverExpiredDispatchLease
    } = await implementation()
    const expired = leaseRecord({
        expiresAt: '2026-08-01T02:59:00.000Z',
        kind: 'write',
        keys: ['write:FsusBlog:core']
    })
    await expectDenied(
        () => acquireDispatchLease({
            activeLeases: [expired],
            request: {
                leaseId: 'lease-after-expiry',
                kind: 'write',
                keys: expired.keys,
                ownerId: 'owner-2',
                attemptId: 'attempt-2',
                stageTaskId: 'Ozwasyd/FsusBlog#9999@test-contract',
                acquiredAt: cases.computedAt,
                expiresAt: '2026-08-01T05:00:00.000Z',
                recoveryRule: expired.recoveryRule
            }
        }),
        'lease-recovery-required'
    )
    const recovered = recoverExpiredDispatchLease({
        lease: expired,
        recoveredAt: cases.computedAt,
        recoveryEvidence: {
            ownerAttemptTerminal: true,
            ownerProcessAbsent: true,
            checkedAt: cases.computedAt,
            evidenceDigest: 'b'.repeat(64)
        }
    })
    assert.equal((recovered.lease ?? recovered).state, 'recovered')
})

test('[L06] root-only delivery blocks only matching repository or keys', async () => {
    const delivery = stageTask(9380, {
        stageKind: 'delivery',
        stageRole: 'root-scheduler',
        rootOnly: true,
        conflictKeys: ['repository:Ozwasyd/FsusBlog:delivery']
    })
    const blogWriter = stageTask(9381, {
        conflictKeys: ['repository:Ozwasyd/FsusBlog:delivery']
    })
    const uiWriter = stageTask(3381, {
        issueId: 'Ozwasyd/FsusUI#3381',
        repository: 'Ozwasyd/FsusUI'
    })
    const batch = await select({
        tasks: [delivery, blogWriter, uiWriter],
        availableSlots: 3
    })
    assert.equal(selectedIds(batch).includes(delivery.taskId), true)
    assert.equal(selectedIds(batch).includes(uiWriter.taskId), true)
    assert.equal(selectedIds(batch).includes(blogWriter.taskId), false)
})

test('[S01] DAG agents and unmet stages are not selectable backlog', async () => {
    const dagAgent = stageTask(9390, {
        stageKind: 'dag-update',
        stageRole: 'dag-creator-updater',
        readOnly: true,
        writePaths: []
    })
    const unmet = stageTask(9391, {
        stageKind: 'documentation',
        stageRole: 'documentation-writer',
        stagePrerequisitesSatisfied: false,
        dependencyStatus: 'unsatisfied'
    })
    await expectDenied(
        () => validateInput({ tasks: [dagAgent] }),
        'stage-role-not-selectable'
    )
    await expectDenied(
        () => validateInput({ tasks: [unmet] }),
        'stage-prerequisite-unsatisfied'
    )
})

test('[S02] ordinary code role cannot own UI paths and verifiers cannot write', async () => {
    const wrongUiRole = stageTask(3392, {
        issueId: 'Ozwasyd/FsusUI#3392',
        repository: 'Ozwasyd/FsusUI',
        stageKind: 'ui-ux-implementation',
        stageRole: 'code-implementer',
        writePaths: ['vue/packages/components/markdown-editor/src/markdown-editor.vue']
    })
    const verifierWriter = stageTask(9393, {
        stageKind: 'behavior-verification',
        stageRole: 'test-owner',
        readOnly: true,
        writePaths: ['tests/forbidden-write.test.mjs'],
        conflictKeys: ['write:FsusBlog:forbidden'],
        candidateSha: 'c'.repeat(40)
    })
    await expectDenied(
        () => validateInput({ tasks: [wrongUiRole] }),
        'stage-role-write-scope'
    )
    await expectDenied(
        () => validateInput({ tasks: [verifierWriter] }),
        'read-only-write-lease'
    )
})

test('[S03] read-only verifier runs beside writer only for a frozen candidate', async () => {
    const writer = stageTask(9394)
    const verifier = stageTask(9395, {
        stageKind: 'behavior-verification',
        stageRole: 'test-owner',
        readOnly: true,
        writePaths: [],
        writeScopeDigest: digest([]),
        candidateSha: 'd'.repeat(40),
        candidateFrozen: true
    })
    const batch = await select({
        tasks: [writer, verifier],
        availableSlots: 2
    })
    assert.equal(batch.selected.length, 2)
    verifier.candidateFrozen = false
    await expectDenied(
        () => validateInput({ tasks: [writer, verifier] }),
        'candidate-not-frozen'
    )
})

test('[S04] starvation cannot cross an unmet dependency or receipt', async () => {
    const blocked = stageTask(9396, {
        starvationAge: 100000,
        dependencyStatus: 'unsatisfied',
        stagePrerequisitesSatisfied: false
    })
    await expectDenied(
        () => validateInput({ tasks: [blocked] }),
        'stage-prerequisite-unsatisfied'
    )
})

test('[G01] complete high-conflict same-epoch group proposal is machine-valid', async () => {
    const { validateAcceptanceGroupProposal } = await implementation()
    const result = validateAcceptanceGroupProposal({
        proposal: groupProposal(),
        stageTasks: [
            stageTask(9401, {
                issueId: 'Ozwasyd/FsusBlog#9401',
                conflictKeys: ['write:FsusBlog:shared-contract-tests']
            }),
            stageTask(9402, {
                issueId: 'Ozwasyd/FsusBlog#9402',
                conflictKeys: ['write:FsusBlog:shared-contract-tests']
            })
        ]
    })
    assert.equal(result.valid, true)
})

test('[G02] unrelated grouping and hidden dependency fall back per issue', async () => {
    const { validateAcceptanceGroupProposal } = await implementation()
    const tasks = [stageTask(9401), stageTask(9402)]
    await expectDenied(
        () => validateAcceptanceGroupProposal({
            proposal: groupProposal({
                sharedPaths: [],
                sharedConflictKeys: [],
                sharedBuildOrRuntimeResources: []
            }),
            stageTasks: tasks
        }),
        'group-proposal-ineligible'
    )
    await expectDenied(
        () => validateAcceptanceGroupProposal({
            proposal: groupProposal({
                memberOrder: [
                    'Ozwasyd/FsusBlog#9402',
                    'Ozwasyd/FsusBlog#9401'
                ],
                hiddenDependency: {
                    from: 'Ozwasyd/FsusBlog#9401',
                    to: 'Ozwasyd/FsusBlog#9402'
                }
            }),
            stageTasks: tasks
        }),
        'group-proposal-ineligible'
    )
})

test('[G03] group session without active member cannot occupy a slot', async () => {
    const { validateAcceptanceGroupProposal } = await implementation()
    await expectDenied(
        () => validateAcceptanceGroupProposal({
            proposal: groupProposal({ activeMemberIssueId: null }),
            stageTasks: [stageTask(9401), stageTask(9402)]
        }),
        'group-proposal-no-active-member'
    )
})

test('[G04] group proposal cannot starve an independent higher-priority task', async () => {
    const high = stageTask(9410, { priorityClass: 'P0' })
    const groupedA = stageTask(9401, {
        issueId: 'Ozwasyd/FsusBlog#9401',
        conflictKeys: ['write:FsusBlog:shared-contract-tests']
    })
    const groupedB = stageTask(9402, {
        issueId: 'Ozwasyd/FsusBlog#9402',
        conflictKeys: ['write:FsusBlog:shared-contract-tests']
    })
    const batch = await select({
        tasks: [groupedA, groupedB, high],
        availableSlots: 2,
        groupProposals: [groupProposal()]
    })
    assert.equal(selectedIds(batch).includes(high.taskId), true)
    assert.equal(batch.selected.length, 2)
})

const invalidGroupEvidence = [
    {
        id: 'cold-start-negative',
        overrides: {
            estimatedColdStartSavings: {
                unit: 'seconds',
                value: -1,
                evidenceDigest: '1'.repeat(64)
            }
        }
    },
    {
        id: 'cold-start-unit-bogus',
        overrides: {
            estimatedColdStartSavings: {
                unit: 'minutes',
                value: 45,
                evidenceDigest: '1'.repeat(64)
            }
        }
    },
    {
        id: 'lost-parallelism-negative',
        overrides: {
            lostParallelismEstimate: {
                unit: 'slots',
                value: -1,
                evidenceDigest: '2'.repeat(64)
            }
        }
    },
    {
        id: 'lost-parallelism-out-of-range',
        overrides: {
            lostParallelismEstimate: {
                unit: 'slots',
                value: 2,
                evidenceDigest: '2'.repeat(64)
            }
        }
    },
    {
        id: 'lost-parallelism-unit-bogus',
        overrides: {
            lostParallelismEstimate: {
                unit: 'agents',
                value: 0,
                evidenceDigest: '2'.repeat(64)
            }
        }
    }
]

for (const invalid of invalidGroupEvidence) {
    test(`[G05] group eligibility rejects ${invalid.id}`, async () => {
        const { validateAcceptanceGroupProposal } = await implementation()
        await expectDenied(
            () => validateAcceptanceGroupProposal({
                proposal: groupProposal(invalid.overrides),
                stageTasks: [stageTask(9401), stageTask(9402)]
            }),
            'group-proposal-evidence'
        )
    })
}

test('[G06] memberOrder is canonical and order-sensitive even when digest is unchanged', async () => {
    const { validateAcceptanceGroupProposal } = await implementation()
    const tasks = [stageTask(9401), stageTask(9402)]
    const proposal = groupProposal()
    const reversed = clone(proposal)
    reversed.memberOrder.reverse()
    const reversedBody = clone(reversed)
    delete reversedBody.proposalDigest
    assert.notEqual(
        orderedProposalDigest(reversedBody),
        proposal.proposalDigest
    )
    reversed.proposalDigest = proposal.proposalDigest
    await expectDenied(
        () => validateAcceptanceGroupProposal({
            proposal: reversed,
            stageTasks: tasks
        }),
        'group-member-order'
    )

    const bogus = groupProposal({
        memberOrder: [
            'Ozwasyd/FsusBlog#9401',
            'Ozwasyd/FsusBlog#9999'
        ]
    })
    await expectDenied(
        () => validateAcceptanceGroupProposal({
            proposal: bogus,
            stageTasks: tasks
        }),
        'group-member-order'
    )
})

test('[F01] FsusUI 267-279 sample yields its exact explainable safe batch', async () => {
    const sample = cases.fsusUiSample
    const tasks = [
        stageTask(267, {
            issueId: 'Ozwasyd/FsusUI#267',
            repository: sample.repository,
            priorityClass: 'P0',
            conflictKeys: [
                'write:FsusUI:markdown-editor-contract-tests',
                'worktree:FsusUI:issue-267:write'
            ],
            issueWorktreeId: 'FsusUI-267'
        }),
        stageTask(268, {
            issueId: 'Ozwasyd/FsusUI#268',
            repository: sample.repository,
            stageKind: 'behavior-verification',
            stageRole: 'test-owner',
            priorityClass: 'P0',
            criticalPathLength: 4,
            downstreamBlockedCount: 10,
            readOnly: true,
            writePaths: [],
            writeScopeDigest: digest([]),
            candidateSha: sample.baseSha,
            candidateFrozen: true,
            conflictKeys: [],
            exclusiveResourceKeys: ['resource:browser:native-ime'],
            validationClass: 'native-ime-browser',
            estimatedLongTask: true
        }),
        stageTask(272, {
            issueId: 'Ozwasyd/FsusUI#272',
            repository: sample.repository,
            priorityClass: 'P1',
            conflictKeys: [
                'write:FsusUI:markdown-editor-contract-tests',
                'worktree:FsusUI:issue-272:write'
            ],
            issueWorktreeId: 'FsusUI-272'
        })
    ]
    const batch = await select({ tasks, availableSlots: 15 })
    assert.deepEqual(
        selectedIds(batch).map((taskId) => taskId.split('@')[0]).toSorted(),
        sample.expectedSelectedIssueIds.toSorted()
    )
    assert.deepEqual(
        deferredIds(batch).map((taskId) => taskId.split('@')[0]).toSorted(),
        sample.expectedDeferredIssueIds.toSorted()
    )
    assert.equal(
        batch.deferReasons['Ozwasyd/FsusUI#272@test-contract'].code,
        'write-conflict'
    )
})

test('[F02] blocked FsusUI dependents never enter the safe-selectable backlog', async () => {
    const sample = cases.fsusUiSample
    const readyIds = sample.readyStageTasks.map(({ issueId }) => issueId)
    assert.equal(
        sample.blockedIssueIds.some((issueId) => readyIds.includes(issueId)),
        false
    )
    for (const issueId of sample.blockedIssueIds) {
        assert.ok(
            sample.issues.find((issue) => issue.issueId === issueId)
                .dependsOn.length > 0
        )
    }
})

test('[V01] validator rejects a non-maximal batch and slot overflow', async () => {
    const tasks = independentTasks(3, 9420)
    const batch = await select({ tasks, availableSlots: 3 })
    const omitted = clone(batch)
    omitted.deferred.push(omitted.selected.pop())
    const omittedId = deferredIds(omitted).at(-1)
    delete omitted.selectionReasons[omittedId]
    omitted.deferReasons[omittedId] = {
        code: 'ranked-beyond-slot-limit',
        selectionBlockedBy: []
    }
    await expectDenied(
        () => validateBatch({
            tasks,
            availableSlots: 3,
            recordedBatch: omitted
        }),
        'batch-not-maximal'
    )
    const overflow = clone(batch)
    overflow.selected.push({ taskId: 'unknown@task' })
    await expectDenied(
        () => validateBatch({
            tasks,
            availableSlots: 3,
            recordedBatch: overflow
        }),
        'batch-slots-exceeded'
    )
})

test('[V02] validator rejects free text, forged digest, and root reordering', async () => {
    const tasks = independentTasks(3, 9430)
    const batch = await select({ tasks, availableSlots: 2 })
    const freeText = clone(batch)
    freeText.deferReasons[deferredIds(freeText)[0]] = 'wait for later'
    await expectDenied(
        () => validateBatch({
            tasks,
            availableSlots: 2,
            recordedBatch: freeText
        }),
        'batch-defer-reason-schema'
    )
    const forged = clone(batch)
    forged.batchDigest = 'f'.repeat(64)
    await expectDenied(
        () => validateBatch({
            tasks,
            availableSlots: 2,
            recordedBatch: forged
        }),
        'batch-digest-mismatch'
    )
    const reordered = clone(batch)
    reordered.selected.reverse()
    await expectDenied(
        () => validateBatch({
            tasks,
            availableSlots: 2,
            recordedBatch: reordered
        }),
        'batch-selection-mismatch'
    )
})

async function executeMutation(control) {
    if (control.surface === 'presence') {
        const { validateDispatchProjectionPresence } =
            await gateImplementation()
        return validateDispatchProjectionPresence({})
    }

    if (control.surface === 'binding') {
        const conflictKey = 'write:FsusBlog:mutation-bound-owner'
        const resourceKey = 'resource:docker:mutation-bound'
        const tasks = [
            stageTask(9550, {
                conflictKeys: [conflictKey],
                exclusiveResourceKeys: [resourceKey]
            }),
            stageTask(9551, {
                stageKind: 'behavior-verification',
                stageRole: 'test-owner',
                readOnly: true,
                writePaths: [],
                writeScopeDigest: digest([]),
                candidateSha: 'e'.repeat(40),
                conflictKeys: [],
                exclusiveResourceKeys: []
            })
        ]
        const fixture = frontierBindingFixture(tasks)
        const mutation = bindingFactMutations.find(
            ({ id }) => control.id === `frontier-binding-${id}`
        )
        assert.ok(mutation, `missing binding mutation ${control.id}`)
        mutation.mutate(
            fixture.frontier.stageTasks[mutation.target ?? 0]
        )
        fixture.frontier = dispatchFrontier(
            fixture.frontier.stageTasks,
            fixture.frontier.semanticDependencies
        )
        return validateBinding(fixture)
    }

    if (control.surface === 'input') {
        let tasks = [stageTask(9500)]
        let semanticDependencies = []
        if (control.id === 'false-dependency-for-conflict') {
            tasks = [stageTask(9500), stageTask(9501)]
            semanticDependencies = [{
                from: tasks[0].issueId,
                to: tasks[1].issueId,
                serializationOnly: true,
                reason: 'shared write path',
                evidenceDigest: '1'.repeat(64)
            }]
        } else if (control.id === 'unmet-stage-selected'
            || control.id === 'starvation-crosses-blocker') {
            tasks[0].stagePrerequisitesSatisfied = false
            tasks[0].dependencyStatus = 'unsatisfied'
            tasks[0].starvationAge = 100000
        } else if (control.id === 'dag-agent-selected') {
            tasks[0].stageKind = 'dag-update'
            tasks[0].stageRole = 'dag-creator-updater'
            tasks[0].readOnly = true
            tasks[0].writePaths = []
        } else if (control.id === 'code-role-writes-ui') {
            tasks[0] = stageTask(3500, {
                issueId: 'Ozwasyd/FsusUI#3500',
                repository: 'Ozwasyd/FsusUI',
                stageKind: 'ui-ux-implementation',
                stageRole: 'code-implementer',
                writePaths: ['vue/packages/components/markdown-editor/src/markdown-editor.vue']
            })
        } else if (control.id === 'verifier-takes-write-lease') {
            tasks[0] = stageTask(9500, {
                stageKind: 'behavior-verification',
                stageRole: 'test-owner',
                readOnly: true,
                candidateSha: 'a'.repeat(40),
                conflictKeys: ['write:FsusBlog:forbidden']
            })
        } else if (control.id === 'unstable-candidate-read') {
            tasks[0] = stageTask(9500, {
                stageKind: 'behavior-verification',
                stageRole: 'test-owner',
                readOnly: true,
                writePaths: [],
                writeScopeDigest: digest([]),
                candidateSha: 'a'.repeat(40),
                candidateFrozen: false
            })
        } else if (control.id === 'docs-before-ux') {
            tasks[0] = stageTask(3501, {
                issueId: 'Ozwasyd/FsusUI#3501',
                repository: 'Ozwasyd/FsusUI',
                stageKind: 'documentation',
                stageRole: 'documentation-writer',
                stagePrerequisitesSatisfied: false,
                dependencyStatus: 'unsatisfied',
                requiredReceiptDigests: ['behavior-green-without-ux']
            })
        } else if (control.id === 'conflict-key-path-prefix-only') {
            const key = 'write:FsusBlog:path-prefix'
            tasks[0].conflictKeys = [key]
            tasks[0].conflictKeyEvidence = {
                [key]: {
                    sourceType: 'filename-prefix',
                    evidenceDigest: digest(key)
                }
            }
        }
        return validateInput({ tasks, semanticDependencies })
    }

    if (control.surface === 'lease') {
        const {
            acquireDispatchLease,
            releaseDispatchLease
        } = await implementation()
        let lease = leaseRecord({
            expiresAt: control.id === 'expired-lease-stolen-without-recovery'
                ? '2026-08-01T02:00:00.000Z'
                : '2026-08-01T04:00:00.000Z'
        })
        if (control.id === 'lease-attempt-release-mismatch') {
            return releaseDispatchLease({
                lease,
                attemptId: 'wrong-attempt',
                releasedAt: cases.laterComputedAt
            })
        }
        if (control.id === 'expired-lease-stolen-without-recovery') {
            return acquireDispatchLease({
                activeLeases: [lease],
                request: {
                    leaseId: 'stolen-lease',
                    kind: lease.kind,
                    keys: lease.keys,
                    ownerId: 'new-owner',
                    attemptId: 'new-attempt',
                    stageTaskId: 'Ozwasyd/FsusBlog#9999@test-contract',
                    acquiredAt: cases.computedAt,
                    expiresAt: '2026-08-01T05:00:00.000Z',
                    recoveryRule: lease.recoveryRule
                }
            })
        }
        if (control.id === 'lease-digest-tampered') {
            lease.keys = ['resource:docker:changed']
            return validateInput({ tasks: [stageTask(9500)], activeLeases: [lease] })
        }
        delete lease.ownerId
        delete lease.leaseDigest
        lease.leaseDigest = digest(Object.fromEntries(
            Object.entries(lease).filter(([key]) => key !== 'leaseDigest')
        ))
        return validateInput({ tasks: [stageTask(9500)], activeLeases: [lease] })
    }

    if (control.surface === 'group') {
        const { validateAcceptanceGroupProposal } = await implementation()
        const tasks = [stageTask(9401), stageTask(9402)]
        let proposal
        if (control.id === 'group-unrelated-members') {
            proposal = groupProposal({
                sharedPaths: [],
                sharedConflictKeys: [],
                sharedBuildOrRuntimeResources: []
            })
        } else if (control.id === 'group-hidden-dependency') {
            proposal = groupProposal({
                hiddenDependency: {
                    from: 'Ozwasyd/FsusBlog#9401',
                    to: 'Ozwasyd/FsusBlog#9402'
                }
            })
        } else if (control.id.startsWith('group-evidence-')) {
            const evidence = invalidGroupEvidence.find(
                ({ id }) => control.id === `group-evidence-${id}`
            )
            assert.ok(evidence, `missing group evidence mutation ${control.id}`)
            proposal = groupProposal(evidence.overrides)
        } else if (control.id === 'group-member-order-reversed') {
            proposal = groupProposal()
            proposal.memberOrder.reverse()
        } else if (control.id === 'group-member-order-bogus') {
            proposal = groupProposal({
                memberOrder: [
                    'Ozwasyd/FsusBlog#9401',
                    'Ozwasyd/FsusBlog#9999'
                ]
            })
        } else {
            proposal = groupProposal({ activeMemberIssueId: null })
        }
        return validateAcceptanceGroupProposal({ proposal, stageTasks: tasks })
    }

    let tasks = independentTasks(3, 9600)
    let availableSlots = 2
    let activeLeases = []
    if (control.id === 'twenty-safe-selects-eight') {
        tasks = independentTasks(20, 9600)
        availableSlots = 15
    } else if (control.id === 'safe-node-omitted'
        || control.id === 'long-task-freezes-unrelated'
        || control.id === 'group-starves-ready-node') {
        availableSlots = 3
    } else if (control.id === 'conflict-writers-co-selected') {
        const key = 'write:FsusBlog:shared'
        tasks = [
            stageTask(9600, { conflictKeys: [key] }),
            stageTask(9601, { conflictKeys: [key] })
        ]
        availableSlots = 2
    } else if (control.id === 'same-worktree-writers-co-selected') {
        tasks = sameWorktreeWriterTasks(9690, 'same-worktree')
        availableSlots = 2
    } else if (control.id === 'resource-lease-bypassed') {
        tasks = [stageTask(9600, {
            exclusiveResourceKeys: ['resource:browser:native-ime']
        })]
        activeLeases = [leaseRecord()]
        availableSlots = 1
    } else if (control.id === 'acceptance-group-overrides-p0'
        || control.id === 'issue-number-priority-inversion') {
        tasks = [
            stageTask(9999, { priorityClass: 'P0' }),
            stageTask(1, {
                priorityClass: 'P2',
                acceptanceGroupCompletionValue: 100000,
                starvationAge: 100000
            })
        ]
        availableSlots = 1
    } else if (control.id === 'lower-unlock-ranked-first') {
        tasks = [
            stageTask(9600, { downstreamBlockedCount: 10 }),
            stageTask(9601, { downstreamBlockedCount: 0 })
        ]
        availableSlots = 1
    } else if (control.id === 'starvation-ignored') {
        tasks = [
            stageTask(9600, { starvationAge: 1000 }),
            stageTask(9601, { starvationAge: 0 })
        ]
        availableSlots = 1
    }

    const batch = await select({ tasks, availableSlots, activeLeases })
    const mutated = clone(batch)
    if ([
        'lower-unlock-ranked-first',
        'issue-number-priority-inversion',
        'starvation-ignored',
        'acceptance-group-overrides-p0',
        'input-order-controls-selection',
        'root-reorders-batch'
    ].includes(control.id)) {
        if (mutated.deferred.length > 0) {
            const selected = mutated.selected[0]
            mutated.selected[0] = mutated.deferred[0]
            mutated.deferred[0] = selected
        } else {
            mutated.selected.reverse()
        }
    } else if ([
        'twenty-safe-selects-eight',
        'safe-node-omitted',
        'long-task-freezes-unrelated',
        'group-starves-ready-node'
    ].includes(control.id)) {
        while (mutated.selected.length > (
            control.id === 'twenty-safe-selects-eight' ? 8 : 2
        )) {
            mutated.deferred.push(mutated.selected.pop())
        }
    } else if (control.id === 'slots-exceeded') {
        mutated.selected.push({ taskId: 'illegal-extra@task' })
    } else if (control.id === 'conflict-writers-co-selected'
        || control.id === 'same-worktree-writers-co-selected'
        || control.id === 'resource-lease-bypassed') {
        mutated.selected = tasks.map(({ taskId }) => ({ taskId }))
        mutated.deferred = []
    } else if (control.id === 'free-text-defer-reason') {
        mutated.deferReasons[deferredIds(mutated)[0]] = 'wait'
    } else if (control.id === 'batch-digest-forged') {
        mutated.batchDigest = 'f'.repeat(64)
    }
    return validateBatch({
        tasks,
        recordedBatch: mutated,
        availableSlots,
        activeLeases
    })
}

for (const control of mutationControls) {
    test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async () => {
        await expectDenied(
            () => executeMutation(control),
            control.expectedCode
        )
    })
}

test('check-dag-gate is the unique runtime consumer of the batch validator', async () => {
    await implementation()
    const source = readFileSync(gatePath, 'utf8')
    assert.match(source, /dispatch-batch-selector\.mjs/u)
    assert.match(source, /validateDispatchProjectionPresence/u)
    assert.match(source, /validateDispatchBatch/u)
})
