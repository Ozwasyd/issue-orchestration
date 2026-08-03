import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
    authorizeWriterStageRetry,
    compileVerifiedWriterStageContinuation,
    evaluateWriterStageObservation,
    sealSliceTerminalReceipt,
    sealWriterStageRetryRevisionEvidence
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    buildCanonicalWriterStageLedger,
    compileWriterStageTestArtifacts,
    createCanonicalWriterDispatchReceipt,
    createWriterStageGitFixture,
    sealCanonicalWriterLedgerEvent
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const implementationPath = path.join(
    root,
    'skills/issue-orchestration/scripts/event-ledger.mjs'
)
const fixturesRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const acceptance = readJson('event-ledger-acceptance-map.json')
const controls = readJson('event-ledger-mutation-controls.json').controls
const runtimeProbes = readJson('event-ledger-runtime-probes.json').probes
const frozenContract = readJson('event-ledger-expected-initial-failures.json')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repositorya-event-ledger-contract-'))

const runId = 'run-1817-contract'
const nodeId = 'RepositoryA#1817'
const baseSha = frozenContract.baseSha
const candidateSha = '1'.repeat(40)
const issueSnapshotFingerprint = '2'.repeat(64)
const repositoryFingerprint = '3'.repeat(64)
const sourceDagDigest = '4'.repeat(64)
const testContractDigest = frozenContract.testContractDigest
const genesisDigest = '0'.repeat(64)
const implementationActorId = 'code-implementer-1817'
const testOwnerActorId = frozenContract.testOwnerId
const uxActorId = 'ux-verifier-1817'
const writerRunId = 'run-1874-event-ledger-writer-contract'
const writerNodeId = 'RepositoryA#1874'
const writerRepository = 'ExampleOrg/RepositoryA'
const writerIssue = 1874
const writerEpochId = 'epoch-1874-event-ledger-001'
const writerRouteDigest = digest('writer-route-1874')
const writerAttemptId = 'attempt-1874-writer-001'
const writerAgentId = 'code-implementer-1874'
let writerLedgerInvocation = 0

after(() => fs.rmSync(scratch, { force: true, recursive: true }))

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixturesRoot, name), 'utf8'))
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

function digest(value) {
    const source = typeof value === 'string'
        ? value
        : JSON.stringify(normalizeJson(value))
    return createHash('sha256').update(source).digest('hex')
}

function fileDigest(relativePath) {
    return createHash('sha256')
        .update(fs.readFileSync(path.join(root, relativePath)))
        .digest('hex')
}

function verifiedDispatchReceipt({
    actorRole = 'code-implementer',
    attemptId = 'attempt-1817-001',
    verificationStatus = 'verified'
} = {}) {
    const requestIdentity = {
        schema: 'issue-orchestration.dispatch-request.v1',
        requestId: `request-${attemptId}`,
        runId,
        nodeId,
        attemptId,
        stageRole: actorRole,
        baseSha,
        testOwnerId: testOwnerActorId,
        testContractDigest,
        epochId: 'epoch-1817-corrective-001'
    }
    const runtimeIdentity = {
        threadId: `thread-${attemptId}`,
        rolloutId: `rollout-${attemptId}`,
        effectiveRole: actorRole,
        effectiveModel: 'gpt-5.6-sol',
        effectiveEffort: 'low',
        effectiveSandbox: 'workspace-write',
        effectiveForkTurns: 'none'
    }
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v1',
        requestId: requestIdentity.requestId,
        requestDigest: digest(requestIdentity),
        attemptId,
        epochId: requestIdentity.epochId,
        threadId: runtimeIdentity.threadId,
        rolloutId: runtimeIdentity.rolloutId,
        runtimeMetadataDigest: digest(runtimeIdentity),
        verificationStatus,
        mismatchReasons: verificationStatus === 'verified'
            ? []
            : ['runtime-verification-rejected']
    }
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

function header(
    stateRootCanonical = path.join(scratch, 'state'),
    {
        headerBaseSha = baseSha,
        headerRunId = runId
    } = {}
) {
    return {
        schema: 'issue-orchestration.ledger.v1',
        runId: headerRunId,
        stateRootCanonical,
        baseSha: headerBaseSha,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        createdAt: '2026-08-01T00:00:00.000Z'
    }
}

function emptyLedger(options = {}) {
    return {
        header: header(path.join(scratch, 'state'), options),
        events: []
    }
}

function activeEmptyLedger(options = {}) {
    const legacy = emptyLedger(options)
    const unsigned = {
        schema: 'issue-orchestration.node-ledger.v1',
        transitionSchema: 'issue-orchestration.transition.v2',
        runId: legacy.header.runId,
        nodeId,
        memberId: nodeId,
        repository: 'ExampleOrg/RepositoryA',
        issueNumber: 1817,
        selectorReceiptDigest: digest('selector-receipt'),
        remoteMemberDigest: digest('remote-member'),
        nodeEpoch: 1,
        stateRootCanonical: legacy.header.stateRootCanonical,
        baseSha: legacy.header.baseSha,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        createdAt: legacy.header.createdAt
    }
    return {
        header: { ...unsigned, headerDigest: digest(unsigned) },
        events: []
    }
}

function activeDiscoveredLedger(options = {}) {
    const ledger = activeEmptyLedger(options)
    sealEvent(ledger, {
        actorRole: 'dag-creator-updater',
        eventType: 'node.discovered',
        fromState: 'none',
        payload: { issueKind: 'code' },
        toState: 'discovered'
    })
    return ledger
}

function activeFrozenLedger(options = {}) {
    const ledger = activeDiscoveredLedger(options)
    sealEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.started',
        fromState: 'discovered',
        payload: { actorId: testOwnerActorId },
        toState: 'test-contracting'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.frozen',
        fromState: 'test-contracting',
        payload: {
            actorId: testOwnerActorId,
            frozenFiles: [
                {
                    path: 'tests/tools/issue-orchestration-event-ledger.test.mjs',
                    sha256: '6'.repeat(64)
                }
            ],
            testContractDigest
        },
        toState: 'test-contract-frozen'
    })
    return ledger
}

function verifiedReceipt({
    actorId,
    actorRole,
    fresh = true,
    modifiedPaths = [],
    selfTestCycles = [],
    status = 'passed',
    visibleMatrixComplete = true
}) {
    const receipt = {
        schema: 'issue-orchestration.verified-candidate-receipt.v1',
        actorId,
        actorRole,
        candidateSha,
        testContractDigest,
        fresh,
        modifiedPaths,
        selfTestCycles,
        status,
        visibleMatrixComplete
    }
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

function implementerSelfTestReceipt({
    actorRole = 'code-implementer',
    schema = 'issue-orchestration.implementer-self-test-receipt.v1'
} = {}) {
    const selfTestCycles = [
        { cycle: 1, outcome: 'failed', signature: 'expected-red' },
        { cycle: 2, outcome: 'failed', signature: 'implementation-defect' },
        { cycle: 3, outcome: 'passed', signature: null }
    ]
    const receipt = {
        schema,
        verificationStatus: 'verified',
        runId,
        nodeId,
        attemptId: 'attempt-1817-001',
        stageRole: actorRole,
        actorId: implementationActorId,
        actorRole,
        candidateSha,
        baseSha,
        frozenTestContractDigest: testContractDigest,
        testContractDigest,
        frozenTestTreeDigestBefore: '6'.repeat(64),
        frozenTestTreeDigestAfter: '6'.repeat(64),
        implementationDiffDigest: '7'.repeat(64),
        commands: [
            ['node', '--test', 'tests/tools/issue-orchestration-event-ledger.test.mjs']
        ],
        exitStatuses: [0],
        visibleTestMatrixDigest: '8'.repeat(64),
        lintTypecheckBuildResults: {
            build: 'not-applicable-no-build-artifact',
            lint: 'passed',
            typecheck: 'passed'
        },
        firstFailureRefs: ['evidence://1817/expected-red'],
        fixCycleCount: 2,
        remainingFailures: [],
        workingTreeStatusDigest: '9'.repeat(64),
        modifiedPaths: [
            'skills/issue-orchestration/scripts/event-ledger.mjs'
        ],
        selfTestCycles,
        status: 'passed',
        visibleMatrixComplete: true
    }
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

function sealEvent(ledger, {
    actorRole = 'root-scheduler',
    attemptId = null,
    eventId = `event-${String(ledger.events.length + 1).padStart(3, '0')}`,
    eventType,
    evidenceRefs = [`evidence://${eventType}`],
    fromState,
    node = nodeId,
    payload = {},
    toState
}) {
    const event = {
        schema: ledger.header.schema === 'issue-orchestration.node-ledger.v1'
            ? 'issue-orchestration.event.v2'
            : 'issue-orchestration.event.v1',
        eventId,
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        nodeId: node,
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        baseSha: ledger.header.baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs,
        createdAt: new Date(Date.parse('2026-08-01T00:00:00.000Z') + ledger.events.length * 1000).toISOString(),
        previousEventDigest: ledger.events.at(-1)?.eventDigest ?? genesisDigest
    }
    event.eventDigest = digest(event)
    ledger.events.push(event)
    return event
}

function resealFrom(ledger, start = 0) {
    for (let index = start; index < ledger.events.length; index += 1) {
        const event = ledger.events[index]
        event.sequence = index + 1
        event.previousEventDigest = index === 0
            ? genesisDigest
            : ledger.events[index - 1].eventDigest
        event.payloadDigest = digest(event.payload)
        delete event.eventDigest
        event.eventDigest = digest(event)
    }
    return ledger
}

function clone(value) {
    return structuredClone(value)
}

function writerSliceDefinition({
    acceptanceItemId,
    command,
    file,
    order,
    prerequisiteSliceIds,
    revisionTag,
    sliceId
}) {
    return {
        sliceId,
        order,
        prerequisiteSliceIds,
        singleObjective:
            `Prove the focused writer ledger transition for ${sliceId}`,
        firstRequiredAction: command,
        firstReadTargets: [file],
        firstWritablePath: file,
        allowedPaths: [file],
        forbiddenPaths: [],
        requiredCreatedOrModifiedFiles: [file],
        requiredCommands: [command],
        requiredEvidence: [
            'filesystem-git-command-evidence'
        ],
        expectedFailureOrProgressSignal:
            'a sealed checkpoint, terminal receipt, or terminal failure receipt',
        explicitNonGoals: [
            'dispatch unrelated work',
            'replace machine evidence with prose',
            'change runtime policy'
        ],
        maxChangedFiles: 1,
        maxOwnedModules: 1,
        maxReadOnlyOperationsBeforeCheckpoint: 8,
        maxNoArtifactToolCalls: 6,
        maxNoArtifactActiveDurationClass: 'short',
        safeCheckpointKind: 'stage-progress',
        acceptanceItemIds: [acceptanceItemId],
        completionPredicate:
            'the required file and command have machine-verifiable evidence',
        continuationPredicate:
            'resume the sealed cursor for this exact executable slice'
    }
}

async function compileWriterLedgerArtifacts({
    current = null,
    fixture,
    revisionTag = null,
    runId: requestedRunId = null,
    sliceCount = 2,
    stageAttemptId: requestedStageAttemptId = null
} = {}) {
    if (!fixture) {
        throw new TypeError('an isolated writer-stage Git fixture is required')
    }
    writerLedgerInvocation += 1
    const invocationId =
        `${process.pid}-${writerLedgerInvocation}`
    const selectedPaths = fixture.filePaths.slice(0, sliceCount)
    const runId = requestedRunId ??
        `${writerRunId}-${invocationId}`
    const stageAttemptId = requestedStageAttemptId ??
        `${writerAttemptId}-${invocationId}`
    const canonical = await buildCanonicalWriterStageLedger({
        current,
        repository: writerRepository,
        issue: writerIssue,
        node: writerNodeId,
        runId,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: writerEpochId,
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: selectedPaths,
        requiredFiles: selectedPaths,
        requiredCommands: selectedPaths.map((filePath) =>
            `node --check ${filePath}`),
        requiredEvidence: ['filesystem-git-command-evidence'],
        sliceId: 'repositorya-1874-event-ledger-slice-1',
        sliceCount,
        testContractDigest: digest({
            issue: writerIssue,
            owner: 'writer-ledger-test-contract'
        }),
        routingInputDigest: writerRouteDigest,
        stageAttemptId
    })
    return {
        canonical,
        plan: canonical.artifacts.stageWorkPlan,
        prompts: [...canonical.artifacts.compiledPrompts],
        slices: [...canonical.artifacts.executableSlices]
    }
}

function writerStartedLedger({ artifacts, sliceIndex = 0 }) {
    const { plan, prompts, slices } = artifacts
    const ledger = clone(artifacts.canonical.ledger)
    const slice = slices[sliceIndex]
    const prompt = prompts[sliceIndex]
    sealWriterEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: plan.stageAttemptId,
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        payload: {
            actorId: writerAgentId,
            dispatchReceipt: createCanonicalWriterDispatchReceipt({
                artifacts: {
                    ...artifacts.canonical.artifacts,
                    executableSlice: slice,
                    compiledPrompt: prompt
                },
                attemptId: plan.stageAttemptId
            }),
            stageWorkPlan: plan,
            currentSlice: slice,
            executableSlice: slice,
            compiledPrompt: prompt,
            effort: 'low',
            model: 'gpt-5.6-sol',
            ownerContinuationId: 'implementation-owner-1874'
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

function sealWriterEvent(ledger, options) {
    const payload = {
        transitionSchema: 'issue-orchestration.transition.v2',
        ...options.payload
    }
    const plan = payload.stageWorkPlan
    const event = sealCanonicalWriterLedgerEvent({
        ledger,
        actorRole:
            options.actorRole ?? plan?.stageRole ?? 'code-implementer',
        attemptId: options.attemptId ??
            plan?.stageAttemptId ?? null,
        eventType: options.eventType,
        fromState: options.fromState,
        payload,
        toState: options.toState
    })
    ledger.events.push(event)
    return event
}

async function writerCheckpointContinuationLedger(current) {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/event-ledger-slice-1.mjs',
            'src/event-ledger-slice-2.mjs'
        ]
    })
    fixture.activate(0)
    const artifacts = await compileWriterLedgerArtifacts({
        current,
        fixture,
        sliceCount: 2
    })
    const { plan, prompts, slices } = artifacts
    const ledger = writerStartedLedger({ artifacts })
    const slice = slices[0]
    const progress = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: {
            ...artifacts.canonical.artifacts,
            executableSlice: slice,
            compiledPrompt: prompts[0]
        },
        routeDigest: plan.routingInputDigest,
        status: 'partial'
    })
    const checkpoint = progress.checkpoint
    sealWriterEvent(ledger, {
        eventType: 'writer-stage.checkpoint-recorded',
        fromState: 'implementing-self-testing',
        payload: {
            stageWorkPlan: plan,
            currentSlice: slice,
            compiledPrompt: prompts[0],
            checkpoint,
            checkpointVerificationReceipt:
                progress.checkpointVerificationReceipt
        },
        toState: 'implementing-self-testing'
    })
    const continuationReceipt =
        compileVerifiedWriterStageContinuation({
        plan,
        slice,
        checkpoint,
        compiledPrompt: prompts[0],
        compiledPromptDigest: prompts[0].promptDigest,
        routeDigest: progress.routeDigest,
        checkpointVerificationReceipt:
            progress.checkpointVerificationReceipt,
        sealedAuthority: artifacts.canonical.anchors
    })
    sealWriterEvent(ledger, {
        eventType: 'writer-stage.continuation-recorded',
        fromState: 'implementing-self-testing',
        payload: {
            stageWorkPlan: plan,
            currentSlice: slice,
            compiledPrompt: prompts[0],
            checkpoint,
            checkpointVerificationReceipt:
                progress.checkpointVerificationReceipt,
            continuationReceipt
        },
        toState: 'implementing-self-testing'
    })
    return {
        artifacts,
        checkpoint,
        continuationReceipt,
        fixture,
        ledger
    }
}

async function writerTerminalLedger({ current, sliceCount }) {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/event-ledger-terminal-slice-1.mjs',
            'src/event-ledger-terminal-slice-2.mjs'
        ]
    })
    fixture.activate(0)
    const artifacts = await compileWriterLedgerArtifacts({
        current,
        fixture,
        sliceCount
    })
    const { plan, prompts, slices } = artifacts
    const ledger = writerStartedLedger({ artifacts })
    const slice = slices[0]
    const progress = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: {
            ...artifacts.canonical.artifacts,
            executableSlice: slice,
            compiledPrompt: prompts[0]
        },
        routeDigest: plan.routingInputDigest,
        status: 'complete'
    })
    const checkpoint = progress.checkpoint
    sealWriterEvent(ledger, {
        eventType: 'writer-stage.checkpoint-recorded',
        fromState: 'implementing-self-testing',
        payload: {
            stageWorkPlan: plan,
            currentSlice: slice,
            compiledPrompt: prompts[0],
            checkpoint,
            checkpointVerificationReceipt:
                progress.checkpointVerificationReceipt
        },
        toState: 'implementing-self-testing'
    })
    const terminalReceipt = sealSliceTerminalReceipt({
        plan,
        slice,
        checkpoint,
        compiledPrompt: prompts[0],
        compiledPromptDigest: prompts[0].promptDigest,
        routeDigest: progress.routeDigest,
        checkpointVerificationReceipt:
            progress.checkpointVerificationReceipt,
        sealedAuthority: artifacts.canonical.anchors,
        completedSlicePrefixDigest:
            progress.completedSlicePrefixDigest,
        priorTerminalReceipts: [],
        changedPaths: [...slice.requiredFiles],
        commandEvidenceDigests:
            checkpoint.evidence.commands.map(({ outputDigest }) => outputDigest)
    })
    const nextSlice = sliceCount > 1 ? slices[1] : null
    const nextCompiledPrompt =
        nextSlice ? prompts[1] : null
    const nextDispatchReceipt = nextSlice
        ? createCanonicalWriterDispatchReceipt({
            artifacts: {
                ...artifacts.canonical.artifacts,
                executableSlice: nextSlice,
                compiledPrompt: nextCompiledPrompt
            },
            attemptId: plan.stageAttemptId
        })
        : null
    sealWriterEvent(ledger, {
        eventType: nextSlice
            ? 'writer-stage.slice-completed'
            : 'writer-stage.completed',
        fromState: 'implementing-self-testing',
        payload: {
            stageWorkPlan: plan,
            currentSlice: slice,
            currentCheckpoint: checkpoint,
            compiledPrompt: prompts[0],
            checkpointVerificationReceipt:
                progress.checkpointVerificationReceipt,
            completedSlicePrefixDigest:
                progress.completedSlicePrefixDigest,
            terminalReceipt,
            sliceTerminalReceipts: [terminalReceipt],
            ...(nextSlice
                ? {
                    nextSlice,
                    nextCompiledPrompt,
                    nextDispatchReceipt
                }
                : {})
        },
        toState: 'implementing-self-testing'
    })
    return {
        artifacts,
        checkpoint,
        fixture,
        ledger,
        nextSlice,
        terminalReceipt
    }
}

function writerOutputMissingObservation({ plan, prompt, slice }) {
    return {
        schema: 'issue-orchestration.writer-stage-observation.v1',
        runId: plan.runId,
        repository: plan.repository,
        issue: plan.issue,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        planDigest: plan.planDigest,
        compiledPromptDigest: prompt.promptDigest,
        routeDigest: plan.routingInputDigest,
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        attemptId: plan.stageAttemptId,
        agentId: writerAgentId,
        firstRequiredActionExecuted: true,
        requiredArtifactManifest: {
            requiredOutputs: ['diff', 'commands', 'checkpoint']
        },
        filesystemObservation: {
            createdFiles: [],
            modifiedFiles: [],
            treeDigest: digest([])
        },
        gitObservation: {
            changedPaths: [],
            diffDigest: digest([]),
            unauthorizedPaths: []
        },
        commandObservation: {
            commands: [],
            statuses: [],
            evidenceDigests: []
        },
        checkpoint: null,
        terminalReceipt: null
    }
}

function writerRuntimeRevisionReceipt(artifacts) {
    const plan = artifacts.plan
    const slice = artifacts.slices[0]
    const prompt = artifacts.prompts[0]
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v2',
        verificationStatus: 'verified',
        runId: plan.runId,
        nodeId: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        planDigest: plan.planDigest,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: prompt.promptDigest,
        runtimeMetadataDigest: digest({
            status: 'verified-runtime-capability'
        }),
        rolloutId: `rollout-${plan.stageAttemptId}`,
        threadId: `thread-${plan.stageAttemptId}`,
        actualModel: 'gpt-5.6-sol',
        actualEffort: 'ultra',
        actualRole: plan.stageRole,
        actualMode: 'work',
        actualSandbox: 'workspace-write',
        actualForkTurns: 'all',
        actualWorkingDirectory: plan.worktreeIdentity
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

function writerCleanupReceipt(failure) {
    const receipt = {
        schema: 'issue-orchestration.resource-cleanup-receipt.v1',
        actorRole: 'machine-resource-verifier',
        status: 'resources-clean',
        runId: failure.runId,
        attemptId: failure.attemptId,
        epochId: failure.epochId,
        baselineDigest: digest('writer-retry-cleanup-baseline'),
        ownedResourceDigest: digest('writer-retry-owned-resources'),
        cleanupActions: [],
        lockReleaseObservations: [],
        finalFilesystemObservations: [],
        retainedResources: [],
        quarantinedResources: [],
        failedResources: [],
        postInventory: [],
        postCleanupInventoryDigest: digest([]),
        verifiedAt: '2026-08-02T08:00:00.000Z'
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

async function writerFailureRetryLedger() {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/event-ledger-retry-slice-1.mjs',
            'src/event-ledger-retry-slice-2.mjs'
        ]
    })
    const initialArtifacts = await compileWriterLedgerArtifacts({
        fixture,
        sliceCount: 1
    })
    const artifacts = initialArtifacts
    const { plan, prompts, slices } = artifacts
    const ledger = writerStartedLedger({ artifacts })
    const observation = writerOutputMissingObservation({
        plan,
        prompt: prompts[0],
        slice: slices[0]
    })
    const failure = evaluateWriterStageObservation(observation)
    const failureEvent = sealWriterEvent(ledger, {
        eventType: failure.eventType,
        fromState: 'implementing-self-testing',
        payload: {
            stageWorkPlan: plan,
            currentSlice: slices[0],
            compiledPrompt: prompts[0],
            currentCheckpoint: observation.checkpoint,
            writerStageObservation: observation,
            failureReceipt: failure.failureReceipt,
            countsAsImplementationRework:
                failure.countsAsImplementationRework,
            reworkCountDelta: failure.reworkCountDelta,
            triggersHumanDecision: failure.triggersHumanDecision
        },
        toState: 'terminal'
    })
    const changedRequirementIds = [
        'repositorya-1874-event-ledger-slice-1-acceptance'
    ]
    const revised = compileWriterStageTestArtifacts({
        repository: writerRepository,
        issue: writerIssue,
        node: writerNodeId,
        runId: plan.runId,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: writerEpochId,
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [fixture.filePaths[0]],
        requiredFiles: [fixture.filePaths[0]],
        requiredCommands: [
            `node --check ${fixture.filePaths[0]}`
        ],
        requiredEvidence: ['filesystem-git-command-evidence'],
        sliceId: 'repositorya-1874-event-ledger-slice-1',
        sliceCount: 1,
        testContractDigest: plan.testContractDigest,
        routingInputDigest: writerRouteDigest,
        stageAttemptId: `${plan.stageAttemptId}-retry`
    })
    const revisedArtifacts = {
        canonical: { artifacts: revised },
        plan: revised.stageWorkPlan,
        prompts: [...revised.compiledPrompts],
        slices: [...revised.executableSlices]
    }
    const authorityReceipt =
        writerRuntimeRevisionReceipt(revisedArtifacts)
    const proposedRetry = {
        stageWorkPlan: revisedArtifacts.plan,
        executableSlice: revisedArtifacts.slices[0],
        compiledPrompt: revisedArtifacts.prompts[0],
        completedSlicePrefix: [],
        authorityReceipt
    }
    const revision = sealWriterStageRetryRevisionEvidence({
        priorFailure: failure.failureReceipt,
        sourceFailureEvent: failureEvent,
        proposed: proposedRetry,
        revisionKind: 'runtime-revision',
        changedRequirementIds,
        authorityReceipt
    })
    const resourceCleanupReceipt =
        writerCleanupReceipt(failure.failureReceipt)
    const retryAuthorization = authorizeWriterStageRetry({
        priorFailure: failure.failureReceipt,
        proposed: proposedRetry,
        revisions: [revision],
        sourceFailureEvent: failureEvent,
        resourceCleanupReceipt
    })
    sealWriterEvent(ledger, {
        actorRole: 'root-scheduler',
        attemptId: null,
        eventType: 'writer-stage.retry-authorized',
        fromState: 'terminal',
        payload: {
            priorFailureReceipt: failure.failureReceipt,
            proposedRetry,
            revisions: [revision],
            sourceFailureEvent: failureEvent,
            resourceCleanupReceipt,
            retryAuthorization
        },
        toState: 'test-contract-frozen'
    })
    return {
        artifacts: revisedArtifacts,
        failure,
        fixture,
        initialArtifacts,
        ledger,
        retryAuthorization
    }
}

function discoveredLedger({
    discoveryActorRole = 'dag-creator-updater',
    issueKind = 'code'
} = {}) {
    const ledger = emptyLedger()
    sealEvent(ledger, {
        actorRole: discoveryActorRole,
        eventType: 'node.discovered',
        fromState: 'none',
        payload: {
            issueKind,
            proposalReceipt: verifiedReceipt({
                actorId: 'dag-updater-1817',
                actorRole: 'dag-creator-updater'
            })
        },
        toState: 'discovered'
    })
    return ledger
}

function frozenLedger(options = {}) {
    const ledger = discoveredLedger(options)
    sealEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.started',
        fromState: 'discovered',
        payload: { actorId: testOwnerActorId },
        toState: 'test-contracting'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.frozen',
        fromState: 'test-contracting',
        payload: {
            actorId: testOwnerActorId,
            frozenFiles: [
                {
                    path: 'tests/tools/issue-orchestration-event-ledger.test.mjs',
                    sha256: '6'.repeat(64)
                }
            ],
            testContractDigest
        },
        toState: 'test-contract-frozen'
    })
    return ledger
}

function implementingLedger(options = {}) {
    const ledger = frozenLedger(options)
    const actorRole = options.issueKind === 'ui-ux'
        ? 'ui-ux-implementer'
        : 'code-implementer'
    sealEvent(ledger, {
        actorRole,
        attemptId: 'attempt-1817-001',
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        payload: {
            actorId: implementationActorId,
            dispatchReceipt: verifiedDispatchReceipt({ actorRole }),
            effort: 'low',
            model: 'gpt-5.6-sol',
            ownerContinuationId: 'implementation-owner-1817'
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

function candidateLedger(options = {}) {
    const ledger = implementingLedger(options)
    const actorRole = options.issueKind === 'ui-ux'
        ? 'ui-ux-implementer'
        : 'code-implementer'
    sealEvent(ledger, {
        actorRole,
        attemptId: 'attempt-1817-001',
        eventType: 'implementation.candidate-green',
        fromState: 'implementing-self-testing',
        payload: {
            actorId: implementationActorId,
            candidateSha,
            receipt: implementerSelfTestReceipt({ actorRole }),
            reworkCount: 0
        },
        toState: 'candidate-green'
    })
    return ledger
}

function behaviorGreenLedger(options = {}) {
    const ledger = candidateLedger(options)
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: {
            actorId: testOwnerActorId,
            candidateSha,
            independentOfActorId: implementationActorId
        },
        toState: 'independent-verifying'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.passed',
        fromState: 'independent-verifying',
        payload: {
            actorId: testOwnerActorId,
            candidateSha,
            receipt: verifiedReceipt({
                actorId: testOwnerActorId,
                actorRole: 'test-owner',
                fresh: true
            }),
            rerunTestIds: ['event-ledger-contract', 'event-ledger-mutations']
        },
        toState: 'behavior-green'
    })
    return ledger
}

function closedLedger({ issueKind = 'code' } = {}) {
    const ledger = behaviorGreenLedger({ issueKind })
    let documentFrom = 'behavior-green'
    if (issueKind === 'ui-ux') {
        sealEvent(ledger, {
            actorRole: 'ux-acceptance-verifier',
            attemptId: 'attempt-1817-001',
            eventType: 'ux-acceptance.started',
            fromState: 'behavior-green',
            payload: {
                actorId: uxActorId,
                candidateSha,
                modifiedPaths: []
            },
            toState: 'ux-acceptance'
        })
        sealEvent(ledger, {
            actorRole: 'ux-acceptance-verifier',
            attemptId: 'attempt-1817-001',
            eventType: 'ux-acceptance.accepted',
            fromState: 'ux-acceptance',
            payload: {
                actorId: uxActorId,
                candidateSha,
                modifiedPaths: [],
                receipt: verifiedReceipt({
                    actorId: uxActorId,
                    actorRole: 'ux-acceptance-verifier'
                })
            },
            toState: 'ux-accepted'
        })
        documentFrom = 'ux-accepted'
    }
    sealEvent(ledger, {
        actorRole: 'documentation-writer',
        eventType: 'documentation.started',
        fromState: documentFrom,
        payload: { actorId: 'documentation-writer-1817' },
        toState: 'documenting'
    })
    sealEvent(ledger, {
        actorRole: 'documentation-writer',
        eventType: 'documentation.passed',
        fromState: 'documenting',
        payload: {
            actorId: 'documentation-writer-1817',
            receipt: verifiedReceipt({
                actorId: 'documentation-writer-1817',
                actorRole: 'documentation-writer'
            })
        },
        toState: 'documentation-green'
    })
    sealEvent(ledger, {
        eventType: 'delivery.ready-computed',
        fromState: 'documentation-green',
        payload: { acceptanceComplete: true },
        toState: 'delivery-ready'
    })
    sealEvent(ledger, {
        eventType: 'delivery.started',
        fromState: 'delivery-ready',
        payload: { deliveryId: 'delivery-1817-001' },
        toState: 'delivering'
    })
    sealEvent(ledger, {
        eventType: 'delivery.completed',
        fromState: 'delivering',
        payload: {
            deliveryId: 'delivery-1817-001',
            remoteVerified: true,
            sideEffectKey: 'delivery-1817-001'
        },
        toState: 'delivering'
    })
    sealEvent(ledger, {
        actorRole: 'machine-cleanup-verifier',
        eventType: 'cleanup.started',
        fromState: 'delivering',
        payload: { cleanupId: 'cleanup-1817-001' },
        toState: 'cleaning'
    })
    sealEvent(ledger, {
        actorRole: 'machine-cleanup-verifier',
        eventType: 'cleanup.completed',
        fromState: 'cleaning',
        payload: {
            cleanupId: 'cleanup-1817-001',
            leaseReleased: true,
            sideEffectKey: 'cleanup-1817-001',
            slotReleased: true
        },
        toState: 'cleaning'
    })
    sealEvent(ledger, {
        eventType: 'issue.closed',
        fromState: 'cleaning',
        payload: {
            cleanupId: 'cleanup-1817-001',
            deliveryId: 'delivery-1817-001',
            remoteState: 'CLOSED'
        },
        toState: 'closed'
    })
    return ledger
}

let runtimePromise

async function runtime() {
    runtimePromise ??= import(pathToFileURL(implementationPath).href)
    return runtimePromise
}

async function replay(ledger) {
    const module = await runtime()
    if (ledger?.header?.schema === 'issue-orchestration.node-ledger.v1') {
        return module.replayEventLedger(clone(ledger))
    }
    const audit = await module.auditHistoricalEventLedger(clone(ledger))
    return audit.projection
}

async function expectCode(operation, expectedCode) {
    await assert.rejects(
        async () => operation(),
        (error) => {
            assert.equal(error?.code, expectedCode, error?.stack ?? String(error))
            return true
        }
    )
}

function nodeOf(projection, id = nodeId) {
    assert.equal(typeof projection.nodes, 'object')
    assert.ok(projection.nodes[id], `projection has no node ${id}`)
    return projection.nodes[id]
}

function dagFrom(projection) {
    return {
        schema: 'issue-orchestration.dag.v3',
        runId,
        projectionDigest: projection.projectionDigest,
        nodes: Object.entries(projection.nodes).map(([id, node]) => ({
            id,
            status: node.status,
            activeAttemptId: node.activeAttemptId ?? null,
            reworkCount: node.reworkCount,
            terminal: node.terminal ?? null,
            evidenceRefs: node.evidenceRefs,
            timestamps: node.timestamps
        }))
    }
}

const requiredEventTypes = [
    'node.discovered',
    'test-contract.started',
    'test-contract.frozen',
    'test-contract.disputed',
    'implementation.started',
    'implementation.candidate-green',
    'implementation.contract-disputed',
    'implementation.external-blocked',
    'implementation.resource-failed',
    'independent-verification.started',
    'independent-verification.rejected',
    'independent-verification.passed',
    'ux-acceptance.started',
    'ux-acceptance.rejected',
    'ux-acceptance.accepted',
    'documentation.started',
    'documentation.failed',
    'documentation.passed',
    'delivery.ready-computed',
    'delivery.started',
    'delivery.failed',
    'delivery.completed',
    'cleanup.started',
    'cleanup.quarantined',
    'cleanup.failed',
    'cleanup.completed',
    'issue.closed',
    'issue.reopened',
    'node.terminal-entered',
    'node.terminal-recovered',
    'attempt.cancelled',
    'attempt.expired',
    'attempt.invocation-failed',
    'attempt.environment-failed',
    'writer-stage.checkpoint-recorded',
    'writer-stage.continuation-recorded',
    'writer-stage.invocation-failed',
    'writer-stage.environment-failed',
    'writer-stage.runtime-capability-missing',
    'writer-stage.first-action-not-executed',
    'writer-stage.output-missing',
    'writer-stage.checkpoint-missing',
    'writer-stage.receipt-rejected',
    'writer-stage.retry-authorized',
    'writer-stage.slice-completed',
    'writer-stage.completed',
    'ledger.correction-recorded',
    'dag.proposal-accepted',
    'dag.proposal-rejected',
    'group.session.proposed',
    'group.session.created',
    'group.session.activated',
    'group.member.test-contract-frozen',
    'group.member.write-lease-granted',
    'group.member.candidate-created',
    'group.member.behavior-green',
    'group.member.committed',
    'group.member.delivery-completed',
    'group.member.write-lease-revoked',
    'group.session.cleaning',
    'group.session.cleaned',
    'group.session.cancelled',
    'group.session.failed',
    'group.session.completed'
]

test('contract fixtures are exact, internally linked, and bind the latest authority comment', () => {
    assert.equal(acceptance.authorityCommentId, 5148362773)
    assert.equal(frozenContract.authorityCommentId, 5148362773)
    assert.equal(frozenContract.issueId, 'ExampleOrg/RepositoryA#1817')
    assert.equal(frozenContract.baseSha, 'f99e6091165edc9dba7f2b1314568c3a07b69537')
    assert.equal(
        frozenContract.testOwnerId,
        'test-owner-repositorya-1817-corrective-f99e6091165e'
    )
    const expectedImplementationFiles = [
        {
            path: 'skills/issue-orchestration/scripts/event-ledger.mjs',
            sha256: 'e39883005546726a44f5bbb435a25cdac0c60b53f563b69e468e2fba138612ea',
            gitMode: '100644'
        }
    ]
    assert.deepEqual(
        frozenContract.allowedImplementationPaths,
        expectedImplementationFiles.map(({ path }) => path)
    )
    const expectedPaths = [
        'tests/tools/issue-orchestration-event-ledger.test.mjs',
        'tests/fixtures/issue-orchestration/event-ledger-acceptance-map.json',
        'tests/fixtures/issue-orchestration/event-ledger-mutation-controls.json',
        'tests/fixtures/issue-orchestration/event-ledger-runtime-probes.json',
        'tests/fixtures/issue-orchestration/event-ledger-expected-initial-failures.json'
    ]
    assert.deepEqual(frozenContract.allowedTestPaths, expectedPaths)
    assert.equal(
        frozenContract.acceptanceMap,
        'tests/fixtures/issue-orchestration/event-ledger-acceptance-map.json'
    )
    assert.equal(
        frozenContract.expectedInitialFailures,
        'tests/fixtures/issue-orchestration/event-ledger-expected-initial-failures.json'
    )
    assert.equal(
        frozenContract.runtimeProbes,
        'tests/fixtures/issue-orchestration/event-ledger-runtime-probes.json'
    )
    assert.equal(
        frozenContract.mutationControls,
        'tests/fixtures/issue-orchestration/event-ledger-mutation-controls.json'
    )
    const hashedPaths = expectedPaths.filter((entry) =>
        entry !== frozenContract.expectedInitialFailures)
    assert.deepEqual(Object.keys(frozenContract.fileHashes), hashedPaths)
    for (const relativePath of hashedPaths) {
        assert.equal(
            frozenContract.fileHashes[relativePath],
            fileDigest(relativePath),
            `${relativePath} drifted from the frozen corrective contract`
        )
    }
    const unsignedContract = clone(frozenContract)
    delete unsignedContract.testContractDigest
    delete unsignedContract.candidateIdentity
    assert.equal(
        frozenContract.testContractDigest,
        digest(unsignedContract),
        'corrective test contract digest mismatch'
    )
    assert.deepEqual(frozenContract.candidateIdentity, {
        schema: 'issue-orchestration.candidate-identity.v1',
        algorithm: 'sha256-canonical-json-v1',
        baseSha: frozenContract.baseSha,
        testContractDigest: frozenContract.testContractDigest,
        implementationFiles: expectedImplementationFiles,
        candidateDigest: digest({
            baseSha: frozenContract.baseSha,
            testContractDigest: frozenContract.testContractDigest,
            implementationFiles: expectedImplementationFiles
        })
    })
    assert.deepEqual(frozenContract.expectedBaseSummary, {
        fail: 4,
        pass: 85,
        skipped: 0,
        tests: 89
    })
    const controlIds = controls.map(({ id }) => id)
    assert.equal(new Set(controlIds).size, controlIds.length)
    const mapped = new Set(acceptance.acceptance.flatMap((entry) => entry.mutations))
    assert.deepEqual([...mapped].sort(), [...controlIds].sort())
    assert.deepEqual(runtimeProbes.map(({ id }) => id), ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'])
})

test('P01 the runtime exposes one executable transition table and no old review authority', async () => {
    const module = await runtime()
    for (const name of [
        'appendEventAtomic',
        'recoverEventLedger',
        'replayEventLedger',
        'validateDagProjection'
    ]) {
        assert.equal(typeof module[name], 'function', `${name} is not exported`)
    }
    assert.equal(typeof module.transitionTable, 'object')
    for (const eventType of requiredEventTypes) {
        assert.ok(module.transitionTable[eventType], `missing transition rule ${eventType}`)
    }
    for (const forbidden of [
        'dispatch.started',
        'implementation.completed',
        'review.started',
        'review.passed',
        'verification.started',
        'verification.passed'
    ]) {
        assert.equal(module.transitionTable[forbidden], undefined)
    }
})

test('P02 replay is deterministic and all mandatory event fields contribute to integrity', async () => {
    const ledger = frozenLedger()
    const first = await replay(ledger)
    const second = await replay(ledger)
    assert.deepEqual(second, first)
    assert.match(first.projectionDigest, /^[a-f0-9]{64}$/u)
    assert.equal(first.lastSequence, ledger.events.length)
    assert.equal(first.lastEventDigest, ledger.events.at(-1).eventDigest)
    assert.equal(nodeOf(first).status, 'test-contract-frozen')
    for (const event of ledger.events) {
        for (const field of [
            'eventId',
            'sequence',
            'runId',
            'nodeId',
            'eventType',
            'fromState',
            'toState',
            'attemptId',
            'actorRole',
            'sourceDagDigest',
            'issueSnapshotFingerprint',
            'repositoryFingerprint',
            'baseSha',
            'payloadDigest',
            'evidenceRefs',
            'createdAt',
            'previousEventDigest',
            'eventDigest'
        ]) {
            assert.ok(Object.hasOwn(event, field), `${event.eventId} lacks ${field}`)
        }
    }
})

test('P03 non-UI self-test cycles stay in one attempt before fresh independent verification', async () => {
    const ledger = closedLedger()
    const projection = await replay(ledger)
    assert.equal(nodeOf(projection).status, 'closed')
    assert.equal(nodeOf(projection).reworkCount, 0)
    assert.equal(
        ledger.events.filter(({ eventType }) => eventType === 'implementation.started').length,
        1
    )
    assert.equal(
        ledger.events.find(({ eventType }) => eventType === 'implementation.candidate-green')
            .payload.receipt.selfTestCycles.length,
        3
    )
    assert.equal(
        ledger.events.some(({ eventType }) => eventType.startsWith('review.')),
        false
    )
})

test('P04 UI/UX projection inserts independent UX acceptance before documentation', async () => {
    const ledger = closedLedger({ issueKind: 'ui-ux' })
    const eventTypes = ledger.events.map(({ eventType }) => eventType)
    assert.ok(eventTypes.indexOf('ux-acceptance.accepted') < eventTypes.indexOf('documentation.started'))
    assert.equal(nodeOf(await replay(ledger)).status, 'closed')
})

test('P05 verifier rejection preserves the first failure and increments rework exactly once', async () => {
    const ledger = candidateLedger()
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: {
            actorId: testOwnerActorId,
            candidateSha,
            independentOfActorId: implementationActorId
        },
        toState: 'independent-verifying'
    })
    const firstFailure = {
        classification: 'implementation',
        evidenceRef: 'evidence://independent-red-001',
        signature: 'assertion-drift'
    }
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.rejected',
        fromState: 'independent-verifying',
        payload: {
            candidateSha,
            continuationAttemptId: 'attempt-1817-001',
            firstFailure,
            implementationOwnerActorId: implementationActorId,
            reworkCount: 1
        },
        toState: 'implementing-self-testing'
    })
    const projection = await replay(ledger)
    assert.equal(nodeOf(projection).status, 'implementing-self-testing')
    assert.equal(nodeOf(projection).reworkCount, 1)
    assert.deepEqual(nodeOf(projection).firstFailure, firstFailure)
})

test('P06 failure categories are distinct and retain first-failure authority', async () => {
    for (const eventType of [
        'attempt.cancelled',
        'attempt.expired',
        'attempt.invocation-failed',
        'attempt.environment-failed',
        'implementation.contract-disputed',
        'implementation.external-blocked',
        'implementation.resource-failed'
    ]) {
        const ledger = implementingLedger()
        const firstFailure = {
            classification: eventType,
            evidenceRef: `evidence://${eventType}`,
            signature: `${eventType}-signature`
        }
        sealEvent(ledger, {
            actorRole: eventType === 'implementation.contract-disputed'
                ? 'code-implementer'
                : 'root-scheduler',
            attemptId: 'attempt-1817-001',
            eventType,
            fromState: 'implementing-self-testing',
            payload: {
                firstFailure,
                recoveryFingerprint: digest(eventType)
            },
            toState: eventType === 'implementation.external-blocked'
                ? 'terminal'
                : 'test-contract-frozen'
        })
        assert.deepEqual(nodeOf(await replay(ledger)).firstFailure, firstFailure)
    }
})

test('P07 correction is append-only and references an existing immutable event', async () => {
    const ledger = frozenLedger()
    const corrected = ledger.events[1]
    sealEvent(ledger, {
        eventType: 'ledger.correction-recorded',
        fromState: 'test-contract-frozen',
        payload: {
            correction: { field: 'payload.note', value: 'clarified' },
            targetEventDigest: corrected.eventDigest,
            targetEventId: corrected.eventId
        },
        toState: 'test-contract-frozen'
    })
    const projection = await replay(ledger)
    assert.equal(projection.corrections.length, 1)
    assert.equal(projection.corrections[0].targetEventId, corrected.eventId)
})

test('P08 terminal recovery requires a changed observable fingerprint', async () => {
    const ledger = frozenLedger()
    const oldFingerprint = digest('terminal-old')
    const newFingerprint = digest('terminal-new')
    sealEvent(ledger, {
        eventType: 'node.terminal-entered',
        fromState: 'test-contract-frozen',
        payload: {
            category: 'externally_blocked',
            directEvidence: ['evidence://permission-denied'],
            recoveryFingerprint: oldFingerprint
        },
        toState: 'terminal'
    })
    sealEvent(ledger, {
        eventType: 'node.terminal-recovered',
        fromState: 'terminal',
        payload: {
            previousRecoveryFingerprint: oldFingerprint,
            recoveryFingerprint: newFingerprint
        },
        toState: 'test-contract-frozen'
    })
    const node = nodeOf(await replay(ledger))
    assert.equal(node.status, 'test-contract-frozen')
    assert.equal(node.terminal, null)
})

test('P09 reopen invalidates closed authority and requires DAG/frontier recomputation', async () => {
    const ledger = closedLedger()
    sealEvent(ledger, {
        eventType: 'issue.reopened',
        fromState: 'closed',
        payload: {
            liveIssueFingerprint: digest('reopened'),
            remoteState: 'OPEN'
        },
        toState: 'discovered'
    })
    const node = nodeOf(await replay(ledger))
    assert.equal(node.status, 'discovered')
    assert.equal(node.deliveryAuthorized, false)
    assert.equal(node.semanticDagRecomputeRequired, true)
})

test('P10 semantic DAG proposal events require a changed remote live snapshot and DAG updater receipt', async () => {
    const ledger = frozenLedger()
    sealEvent(ledger, {
        actorRole: 'dag-creator-updater',
        eventType: 'dag.proposal-accepted',
        fromState: 'test-contract-frozen',
        payload: {
            currentRemoteSnapshotDigest: digest('remote-new'),
            previousRemoteSnapshotDigest: digest('remote-old'),
            proposalReceipt: verifiedReceipt({
                actorId: 'dag-updater-1817',
                actorRole: 'dag-creator-updater'
            }),
            trigger: 'remote-live-snapshot-digest-changed'
        },
        toState: 'test-contract-frozen'
    })
    assert.equal((await replay(ledger)).dagProposals.length, 1)
})

test('#1874 writer checkpoint and continuation replay bind one compiled executable slice', async (current) => {
    const {
        artifacts,
        checkpoint,
        continuationReceipt,
        fixture,
        ledger
    } = await writerCheckpointContinuationLedger(current)
    current.after(() => fixture.dispose())
    const projection = await replay(ledger)
    const writerNode = nodeOf(projection, writerNodeId)

    assert.equal(
        artifacts.plan.schema,
        'issue-orchestration.stage-work-plan.v1'
    )
    assert.equal(
        artifacts.slices[0].schema,
        'issue-orchestration.executable-slice.v1'
    )
    assert.equal(
        artifacts.prompts[0].schema,
        'issue-orchestration.compiled-dispatch-prompt.v1'
    )
    assert.equal(
        artifacts.slices[0].planDigest,
        artifacts.plan.planDigest
    )
    assert.equal(
        artifacts.prompts[0].sliceDigest,
        artifacts.slices[0].sliceDigest
    )
    assert.equal(writerNode.activePlanDigest, artifacts.plan.planDigest)
    assert.equal(writerNode.activeSliceDigest, artifacts.slices[0].sliceDigest)
    assert.equal(writerNode.latestCheckpointDigest, checkpoint.checkpointDigest)
    assert.equal(
        writerNode.latestContinuationReceiptDigest,
        continuationReceipt.receiptDigest
    )
    assert.equal(continuationReceipt.restartInvestigation, false)
    assert.deepEqual(continuationReceipt.resumeCursor, checkpoint.cursor)
})

test('#1874 writer slice terminal gate projects only the compiled next slice', async (current) => {
    const {
        artifacts,
        fixture,
        ledger,
        nextSlice,
        terminalReceipt
    } = await writerTerminalLedger({ current, sliceCount: 2 })
    current.after(() => fixture.dispose())
    const writerNode = nodeOf(await replay(ledger), writerNodeId)

    assert.equal(terminalReceipt.stageComplete, false)
    assert.equal(terminalReceipt.candidateEligible, false)
    assert.equal(terminalReceipt.nextSliceId, nextSlice.sliceId)
    assert.equal(nextSlice.planDigest, artifacts.plan.planDigest)
    assert.deepEqual(
        nextSlice.prerequisiteSliceIds,
        [artifacts.slices[0].sliceId]
    )
    assert.equal(writerNode.expectedNextSliceId, nextSlice.sliceId)
    assert.equal(writerNode.expectedNextSliceDigest, nextSlice.sliceDigest)
    assert.equal(
        writerNode.writerStageTerminalReceiptDigest,
        terminalReceipt.receiptDigest
    )
    assert.equal(
        writerNode.activeAttemptId,
        artifacts.plan.stageAttemptId
    )
})

test('#1874 writer terminal failure opens the breaker and substantive retry closes it', async (current) => {
    const {
        artifacts,
        failure,
        fixture,
        ledger,
        retryAuthorization
    } = await writerFailureRetryLedger()
    current.after(() => fixture.dispose())
    const failedLedger = clone(ledger)
    failedLedger.events.pop()
    const failedNode = nodeOf(await replay(failedLedger), writerNodeId)

    assert.equal(failure.status, 'failed')
    assert.equal(failure.eventType, 'writer-stage.output-missing')
    assert.equal(failure.breakerOpen, true)
    assert.equal(failure.countsAsImplementationRework, false)
    assert.equal(failure.reworkCountDelta, 0)
    assert.equal(failedNode.status, 'terminal')
    assert.equal(failedNode.terminal.category, 'writer_stage_failure')
    assert.equal(
        failedNode.writerStageFailureReceiptDigest,
        failure.failureReceipt.receiptDigest
    )

    const retriedNode = nodeOf(await replay(ledger), writerNodeId)
    assert.equal(retryAuthorization.authorized, true)
    assert.equal(retryAuthorization.breakerOpen, false)
    assert.equal(retriedNode.status, 'test-contract-frozen')
    assert.equal(retriedNode.terminal, null)
    assert.equal(
        retriedNode.expectedNextSliceDigest,
        artifacts.slices[0].sliceDigest
    )
    assert.equal(
        retriedNode.writerStageRetryAuthorizationDigest,
        retryAuthorization.receiptDigest
    )
})

test('#1874 writer stage completion requires the final compiled-slice terminal receipt', async (current) => {
    const {
        artifacts,
        fixture,
        ledger,
        terminalReceipt
    } = await writerTerminalLedger({ current, sliceCount: 1 })
    current.after(() => fixture.dispose())
    const writerNode = nodeOf(await replay(ledger), writerNodeId)

    assert.equal(terminalReceipt.stageComplete, true)
    assert.equal(terminalReceipt.candidateEligible, true)
    assert.equal(terminalReceipt.nextSliceId, null)
    assert.equal(
        terminalReceipt.compiledPromptDigest,
        artifacts.prompts[0].promptDigest
    )
    assert.equal(
        writerNode.writerStageTerminalReceiptDigest,
        terminalReceipt.receiptDigest
    )
    assert.equal(writerNode.expectedNextSliceId, null)
    assert.equal(writerNode.expectedNextSliceDigest, null)
})

test('#1874 replay fails closed when writer artifact objects or gate digests are missing', async (current) => {
    const cases = [
        {
            mutate(payload) {
                delete payload.stageWorkPlan
            },
            name: 'stage work plan object',
            expectedCode: 'writer-stage-terminal-gate-required'
        },
        {
            mutate(payload) {
                delete payload.currentSlice
            },
            name: 'executable slice object',
            expectedCode: 'writer-stage-terminal-gate-required'
        },
        {
            mutate(payload) {
                delete payload.terminalReceipt
            },
            name: 'terminal receipt object',
            expectedCode: 'writer-stage-terminal-receipt-rejected'
        },
        {
            mutate(payload) {
                delete payload.stageWorkPlan.planDigest
            },
            name: 'plan digest',
            expectedCode: 'writer-stage-terminal-gate-required'
        },
        {
            mutate(payload) {
                delete payload.currentSlice.sliceDigest
            },
            name: 'slice digest',
            expectedCode: 'writer-stage-terminal-gate-required'
        },
        {
            mutate(payload) {
                for (const receipt of [
                    payload.terminalReceipt,
                    ...payload.sliceTerminalReceipts
                ]) {
                    delete receipt.compiledPromptDigest
                    delete receipt.receiptDigest
                    receipt.receiptDigest = digest(receipt)
                }
            },
            name: 'compiled prompt digest',
            expectedCode: 'writer-stage-terminal-gate-required'
        }
    ]

    for (const contractCase of cases) {
        const result = await writerTerminalLedger({
            current,
            sliceCount: 1
        })
        current.after(() => result.fixture.dispose())
        const ledger = clone(result.ledger)
        const event = ledger.events.at(-1)
        event.payload = clone(event.payload)
        contractCase.mutate(event.payload)
        resealFrom(ledger, ledger.events.length - 1)
        await expectCode(
            () => replay(ledger),
            contractCase.expectedCode
        ).catch((error) => {
            error.message = `${contractCase.name}: ${error.message}`
            throw error
        })
    }
})

test('#1874 replay rejects terminal observations missing any compiled artifact digest', async (current) => {
    for (const field of [
        'planDigest',
        'sliceDigest',
        'compiledPromptDigest'
    ]) {
        const { fixture, ledger } =
            await writerFailureRetryLedger()
        current.after(() => fixture.dispose())
        ledger.events.pop()
        const event = ledger.events.at(-1)
        delete event.payload.writerStageObservation[field]
        resealFrom(ledger, ledger.events.length - 1)
        await expectCode(
            () => replay(ledger),
            'writer-stage-failure-observation-rejected'
        )
    }
})

function groupLedger() {
    const ledger = emptyLedger()
    const groupId = 'group-1817'
    const member = 'RepositoryA#1817'
    const events = [
        ['group.session.proposed', 'none', 'proposed', groupId, { groupId }],
        ['group.session.created', 'proposed', 'created', groupId, { groupId }],
        ['group.session.activated', 'created', 'active', groupId, { groupId }],
        ['group.member.test-contract-frozen', 'test-contracting', 'test-contract-frozen', member, { groupId, memberId: member }],
        ['group.member.write-lease-granted', 'no-lease', 'lease-granted', member, { groupId, leaseId: 'lease-1817', memberId: member }],
        ['group.member.candidate-created', 'implementing-self-testing', 'candidate-green', member, { candidateSha, groupId, memberId: member }],
        ['group.member.behavior-green', 'independent-verifying', 'behavior-green', member, { candidateSha, groupId, memberId: member }],
        ['group.member.committed', 'behavior-green', 'committed', member, { commitSha: candidateSha, groupId, memberId: member }],
        ['group.member.delivery-completed', 'committed', 'delivery-completed', member, { groupId, memberId: member }],
        ['group.member.write-lease-revoked', 'lease-granted', 'lease-revoked', member, { groupId, leaseId: 'lease-1817', memberId: member }],
        ['group.session.cleaning', 'active', 'cleaning', groupId, { groupId }],
        ['group.session.cleaned', 'cleaning', 'cleaned', groupId, { groupId }],
        ['group.session.completed', 'cleaned', 'completed', groupId, { groupId }]
    ]
    for (const [eventType, fromState, toState, node, payload] of events) {
        sealEvent(ledger, {
            eventType,
            fromState,
            node,
            payload,
            toState
        })
    }
    return ledger
}

test('G01 group session and each member are independently replayed', async () => {
    const projection = await replay(groupLedger())
    assert.equal(projection.groups['group-1817'].status, 'completed')
    assert.equal(projection.groups['group-1817'].members[nodeId].status, 'delivery-completed')
    assert.equal(projection.groups['group-1817'].members[nodeId].leaseId, null)
})

test('active replay requires explicit ledger, transition, and event v2 schemas', async () => {
    const module = await runtime()
    const ledger = activeDiscoveredLedger()
    const projection = await module.replayEventLedger(clone(ledger))
    assert.equal(projection.schema, 'issue-orchestration.node-projection.v1')
    assert.equal(nodeOf(projection).status, 'discovered')
    assert.equal(
        await module.validateDagProjection({
            dag: dagFrom(projection),
            projection
        }),
        true
    )

    const retiredRunWide = clone(ledger)
    retiredRunWide.header.schema = 'issue-orchestration.ledger.v2'
    await expectCode(
        () => module.replayEventLedger(retiredRunWide),
        'ledger-v2-run-wide-migration-required'
    )

    const missingTransition = clone(ledger)
    delete missingTransition.header.transitionSchema
    await expectCode(
        () => module.replayEventLedger(missingTransition),
        'node-ledger-v1-required'
    )

    const legacyEvent = clone(ledger)
    legacyEvent.events[0].schema = 'issue-orchestration.event.v1'
    resealFrom(legacyEvent)
    await expectCode(
        () => module.replayEventLedger(legacyEvent),
        'event-v2-required'
    )
})

test('v1 replay is explicit read-only audit with no mutation authority', async () => {
    const module = await runtime()
    const legacy = discoveredLedger()
    await expectCode(
        () => module.replayEventLedger(clone(legacy)),
        'node-ledger-v1-required'
    )
    const audit = await module.auditHistoricalEventLedger(clone(legacy))
    assert.equal(audit.schema, 'issue-orchestration.historical-ledger-audit.v1')
    assert.equal(audit.mode, 'read-only-historical-audit')
    assert.equal(audit.mutationAuthority, 'none')
    assert.equal(audit.canAppend, false)
    assert.equal(audit.canRecoverProjection, false)
    assert.equal(Object.isFrozen(audit), true)
    assert.equal(Object.isFrozen(audit.projection), true)
    assert.equal(nodeOf(audit.projection).status, 'discovered')
    await expectCode(
        () => module.validateDagProjection({
            dag: dagFrom(audit.projection),
            projection: audit.projection
        }),
        'projection-v1-historical-only'
    )
    await expectCode(
        () => module.auditHistoricalEventLedger(activeDiscoveredLedger()),
        'historical-ledger-v1-required'
    )
})

test('append and recovery reject v1 before writing ledger or projection', async () => {
    const module = await runtime()
    const legacy = discoveredLedger()
    const io = canonicalIo(module, legacy, 'retired-v1')
    const event = legacy.events.pop()
    writeLedger(io.ledgerPath, legacy)
    const before = fs.readFileSync(io.ledgerPath, 'utf8')
    await expectCode(
        () => module.appendEventAtomic({
            event,
            ...io,
            writerRole: 'root-scheduler'
        }),
        'node-ledger-v1-required'
    )
    assert.equal(fs.readFileSync(io.ledgerPath, 'utf8'), before)
    assert.equal(fs.existsSync(io.projectionPath), false)
    await expectCode(
        () => module.recoverEventLedger(io),
        'node-ledger-v1-required'
    )
    assert.equal(fs.existsSync(io.projectionPath), false)
})

test('mutation catalog is executable and exact-set equal', () => {
    assert.deepEqual(
        controls.map(({ id }) => id).sort(),
        Object.keys(mutations).sort()
    )
})

function invalidTransition(eventType, fromState, toState, options = {}) {
    const ledger = options.ledger ?? discoveredLedger(options)
    sealEvent(ledger, {
        actorRole: options.actorRole,
        attemptId: options.attemptId,
        eventType,
        fromState,
        payload: options.payload ?? {},
        toState
    })
    return ledger
}

async function replayMutation(ledger, code) {
    await expectCode(() => replay(ledger), code)
}

async function receiptMutation(mutator, code, options = {}) {
    const ledger = candidateLedger(options)
    const event = ledger.events.find(({ eventType }) => eventType === 'implementation.candidate-green')
    mutator(event.payload.receipt, event.payload, event)
    resealFrom(ledger, ledger.events.indexOf(event))
    await replayMutation(ledger, code)
}

async function verifierMutation(mutator, code) {
    const ledger = behaviorGreenLedger()
    const event = ledger.events.find(({ eventType }) => eventType === 'independent-verification.passed')
    mutator(event.payload.receipt, event.payload, event)
    resealFrom(ledger, ledger.events.indexOf(event))
    await replayMutation(ledger, code)
}

async function projectionMutation(mutator, code) {
    const module = await runtime()
    const projection = await module.replayEventLedger(
        activeDiscoveredLedger()
    )
    const dag = dagFrom(projection)
    mutator(dag, projection)
    await expectCode(
        () => module.validateDagProjection({ dag, projection }),
        code
    )
}

async function writerMutation(writerRole, code) {
    const module = await runtime()
    const ledger = frozenLedger()
    const io = canonicalIo(module, ledger, 'writer-role')
    writeLedger(io.ledgerPath, {
        ...ledger,
        events: ledger.events.slice(0, -1)
    })
    await expectCode(
        () => module.appendEventAtomic({
            event: clone(ledger.events.at(-1)),
            ...io,
            writerRole
        }),
        code
    )
}

function implementationStartLedger({
    discoveryActorRole = 'dag-creator-updater',
    dispatchReceipt
} = {}) {
    const ledger = frozenLedger({ discoveryActorRole })
    sealEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: 'attempt-1817-001',
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        payload: {
            actorId: implementationActorId,
            ...(dispatchReceipt ? { dispatchReceipt } : {}),
            effort: 'low',
            model: 'gpt-5.6-sol',
            ownerContinuationId: 'implementation-owner-1817'
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

function writeLedger(file, ledger) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
        file,
        `${[ledger.header, ...ledger.events].map((entry) => JSON.stringify(entry)).join('\n')}\n`
    )
}

let canonicalIoInvocation = 0

function canonicalIo(
    module,
    ledger,
    label,
    {
        node = nodeId,
        stageAttemptId = 'event-ledger-authority'
    } = {}
) {
    canonicalIoInvocation += 1
    const canonicalRunId =
        `${ledger.header.runId}-${label}-${process.pid}-${canonicalIoInvocation}`
    const location = module.canonicalEventLedgerLocation({
        runId: canonicalRunId,
        nodeId: node,
        stageAttemptId
    })
    ledger.header.runId = canonicalRunId
    if (ledger.header.schema === 'issue-orchestration.node-ledger.v1') {
        ledger.header.nodeId = node
        ledger.header.memberId = node
        ledger.header.stateRootCanonical = location.stateRoot
        const unsignedHeader = { ...ledger.header }
        delete unsignedHeader.headerDigest
        ledger.header.headerDigest = digest(unsignedHeader)
    }
    for (const event of ledger.events) {
        event.runId = canonicalRunId
        event.nodeId = node
    }
    resealFrom(ledger)
    fs.rmSync(location.ledgerPath, { force: true })
    fs.rmSync(location.projectionPath, { force: true })
    return {
        ledgerPath: location.ledgerPath,
        nodeId: node,
        projectionPath: location.projectionPath,
        protectedRoots: [],
        runId: canonicalRunId,
        stageAttemptId,
        stateRoot: location.stateRoot
    }
}

const mutations = {
    'event-field-missing': async (code) => {
        const ledger = frozenLedger()
        delete ledger.events[1].sourceDagDigest
        resealFrom(ledger, 1)
        await replayMutation(ledger, code)
    },
    'old-review-event': (code) => replayMutation(invalidTransition('review.passed', 'implementing-self-testing', 'behavior-green', { ledger: implementingLedger() }), code),
    'old-verification-event': (code) => replayMutation(invalidTransition('verification.passed', 'candidate-green', 'behavior-green', { ledger: candidateLedger() }), code),
    'old-direct-state-event': (code) => replayMutation(invalidTransition('node.status-updated', 'discovered', 'closed'), code),
    'discovered-to-delivery-ready': (code) => replayMutation(invalidTransition('delivery.ready-computed', 'discovered', 'delivery-ready'), code),
    'test-contracting-to-closed': (code) => replayMutation(invalidTransition('issue.closed', 'test-contracting', 'closed', { ledger: frozenLedger().events.slice(0, 2) && discoveredLedger() }), code),
    'implementing-to-closed': (code) => replayMutation(invalidTransition('issue.closed', 'implementing-self-testing', 'closed', { ledger: implementingLedger() }), code),
    'implementation-start-dispatch-missing': (code) =>
        replayMutation(implementationStartLedger(), code),
    'implementation-start-dispatch-nonverified': (code) =>
        replayMutation(implementationStartLedger({
            dispatchReceipt: verifiedDispatchReceipt({
                verificationStatus: 'rejected'
            })
        }), code),
    'implementation-start-discovery-actor-opt-out': async (code) => {
        for (const discoveryActorRole of [
            'root-scheduler',
            'dag-creator-updater',
            'legacy-bootstrap-agent'
        ]) {
            await replayMutation(implementationStartLedger({
                discoveryActorRole
            }), code)
        }
    },
    'duplicate-implementation-start': async (code) => {
        const ledger = implementingLedger()
        sealEvent(ledger, {
            actorRole: 'code-implementer',
            attemptId: 'attempt-1817-001',
            eventType: 'implementation.started',
            fromState: 'implementing-self-testing',
            payload: {
                actorId: implementationActorId,
                dispatchReceipt: verifiedDispatchReceipt()
            },
            toState: 'implementing-self-testing'
        })
        await replayMutation(ledger, code)
    },
    'self-test-red-candidate-green': (code) => receiptMutation((receipt) => { receipt.status = 'failed' }, code),
    'self-test-matrix-incomplete': (code) => receiptMutation((receipt) => { receipt.visibleMatrixComplete = false }, code),
    'self-test-candidate-identity-missing': (code) => receiptMutation((receipt, payload) => { delete receipt.candidateSha; delete payload.candidateSha }, code),
    'frozen-test-contract-modified': (code) => receiptMutation((receipt) => { receipt.modifiedPaths = ['tests/tools/issue-orchestration-event-ledger.test.mjs'] }, code),
    'obsolete-verified-candidate-receipt': async (code) => {
        const ledger = implementingLedger()
        sealEvent(ledger, {
            actorRole: 'code-implementer',
            attemptId: 'attempt-1817-001',
            eventType: 'implementation.candidate-green',
            fromState: 'implementing-self-testing',
            payload: {
                actorId: implementationActorId,
                candidateSha,
                receipt: verifiedReceipt({
                    actorId: implementationActorId,
                    actorRole: 'code-implementer',
                    selfTestCycles: [
                        { cycle: 1, outcome: 'passed', signature: null }
                    ]
                }),
                reworkCount: 0
            },
            toState: 'candidate-green'
        })
        await replayMutation(ledger, code)
    },
    'candidate-direct-to-behavior-green': (code) => replayMutation(invalidTransition('independent-verification.passed', 'candidate-green', 'behavior-green', { ledger: candidateLedger(), actorRole: 'test-owner', attemptId: 'attempt-1817-001' }), code),
    'implementer-verifies-own-candidate': (code) => verifierMutation((receipt, payload) => { receipt.actorId = implementationActorId; payload.actorId = implementationActorId }, code),
    'independent-verification-not-fresh': (code) => verifierMutation((receipt) => { receipt.fresh = false }, code),
    'independent-verification-candidate-drift': (code) => verifierMutation((receipt, payload) => { receipt.candidateSha = 'f'.repeat(40); payload.candidateSha = 'f'.repeat(40) }, code),
    'root-declares-behavior-green': async (code) => {
        const ledger = behaviorGreenLedger()
        const event = ledger.events.at(-1)
        event.actorRole = 'root-scheduler'
        resealFrom(ledger, ledger.events.length - 1)
        await replayMutation(ledger, code)
    },
    'rejection-loses-first-failure': (code) => failureOverwriteMutation('independent-verification.rejected', 'first-failure-mismatch', code),
    'rejection-resets-rework-count': async (code) => {
        const ledger = rejectedLedger()
        const event = ledger.events.at(-1)
        event.payload.reworkCount = 0
        resealFrom(ledger, ledger.events.length - 1)
        await replayMutation(ledger, code)
    },
    'rejection-unbound-continuation': async (code) => {
        const ledger = rejectedLedger()
        const event = ledger.events.at(-1)
        event.payload.continuationAttemptId = 'attempt-unrelated'
        resealFrom(ledger, ledger.events.length - 1)
        await replayMutation(ledger, code)
    },
    'ui-documentation-before-ux-accepted': (code) => replayMutation(invalidTransition('documentation.started', 'behavior-green', 'documenting', { ledger: behaviorGreenLedger({ issueKind: 'ui-ux' }), actorRole: 'documentation-writer' }), code),
    'ui-delivery-before-ux-accepted': (code) => replayMutation(invalidTransition('delivery.started', 'behavior-green', 'delivering', { ledger: behaviorGreenLedger({ issueKind: 'ui-ux' }) }), code),
    'ux-verifier-modifies-code': async (code) => {
        const ledger = closedLedger({ issueKind: 'ui-ux' })
        const event = ledger.events.find(({ eventType }) => eventType === 'ux-acceptance.accepted')
        event.payload.modifiedPaths = ['skills/issue-orchestration/scripts/event-ledger.mjs']
        resealFrom(ledger, ledger.events.indexOf(event))
        await replayMutation(ledger, code)
    },
    'ux-rejection-owner-drift': (code) => uxRejectionMutation((payload) => { payload.implementationOwnerActorId = 'different-owner' }, code),
    'ux-rejection-effort-drift': (code) => uxRejectionMutation((payload) => { payload.implementationEffort = 'max' }, code),
    'documentation-before-behavior-green': (code) => replayMutation(invalidTransition('documentation.started', 'candidate-green', 'documenting', { ledger: candidateLedger(), actorRole: 'documentation-writer' }), code),
    'documentation-overwrites-first-failure': (code) => failureOverwriteMutation('documentation.passed', 'first-failure-mismatch', code),
    'delivery-before-documentation-green': (code) => replayMutation(invalidTransition('delivery.started', 'behavior-green', 'delivering', { ledger: behaviorGreenLedger() }), code),
    'close-before-delivery-completed': (code) => closeMutation({ remove: 'delivery.completed' }, code),
    'close-before-cleanup-completed': (code) => closeMutation({ remove: 'cleanup.completed' }, code),
    'cleanup-failure-releases-lease': (code) => cleanupFailureMutation({ leaseReleased: true }, code),
    'cleanup-success-overwrites-first-failure': (code) => failureOverwriteMutation('cleanup.completed', 'first-failure-mismatch', code),
    'projection-status-edited': (code) => projectionMutation((dag) => { dag.nodes[0].status = 'closed' }, code),
    'projection-attempt-edited': (code) => projectionMutation((dag) => { dag.nodes[0].activeAttemptId = 'attempt-forged' }, code),
    'projection-rework-edited': (code) => projectionMutation((dag) => { dag.nodes[0].reworkCount += 1 }, code),
    'projection-evidence-edited': (code) => projectionMutation((dag) => { dag.nodes[0].evidenceRefs = ['evidence://forged'] }, code),
    'sequence-gap': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].sequence = 9
        await replayMutation(ledger, code)
    },
    'duplicate-event-id': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].eventId = ledger.events[0].eventId
        resealFrom(ledger, 1)
        await replayMutation(ledger, code)
    },
    'run-id-tampered': (code) => identityMutation('runId', 'run-other', code),
    'node-id-tampered': (code) => identityMutation('nodeId', 'RepositoryA#9999', code),
    'base-sha-tampered': (code) => identityMutation('baseSha', 'f'.repeat(40), code),
    'previous-event-digest-tampered': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].previousEventDigest = 'f'.repeat(64)
        await replayMutation(ledger, code)
    },
    'payload-digest-tampered': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].payloadDigest = 'f'.repeat(64)
        await replayMutation(ledger, code)
    },
    'event-digest-tampered': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].eventDigest = 'f'.repeat(64)
        await replayMutation(ledger, code)
    },
    'historical-event-deleted': async (code) => {
        const ledger = frozenLedger()
        ledger.events.splice(1, 1)
        await replayMutation(ledger, code)
    },
    'events-reordered': async (code) => {
        const ledger = frozenLedger()
        ;[ledger.events[0], ledger.events[1]] = [ledger.events[1], ledger.events[0]]
        await replayMutation(ledger, code)
    },
    'conflicting-attempt-terminal-events': async (code) => {
        const ledger = implementingLedger()
        sealEvent(ledger, {
            attemptId: 'attempt-1817-001',
            eventType: 'attempt.cancelled',
            fromState: 'implementing-self-testing',
            payload: { firstFailure: { classification: 'cancelled' } },
            toState: 'test-contract-frozen'
        })
        sealEvent(ledger, {
            actorRole: 'code-implementer',
            attemptId: 'attempt-1817-001',
            eventType: 'implementation.candidate-green',
            fromState: 'test-contract-frozen',
            payload: {
                actorId: implementationActorId,
                candidateSha,
                receipt: implementerSelfTestReceipt()
            },
            toState: 'candidate-green'
        })
        await replayMutation(ledger, code)
    },
    'historical-event-edited': async (code) => {
        const ledger = frozenLedger()
        ledger.events[0].payload.issueKind = 'ui-ux'
        await replayMutation(ledger, code)
    },
    'correction-target-missing': async (code) => {
        const ledger = frozenLedger()
        sealEvent(ledger, {
            eventType: 'ledger.correction-recorded',
            fromState: 'test-contract-frozen',
            payload: {
                targetEventDigest: 'f'.repeat(64),
                targetEventId: 'event-missing'
            },
            toState: 'test-contract-frozen'
        })
        await replayMutation(ledger, code)
    },
    'truncated-ledger-tail': (code) => truncatedTailMutation(code),
    'duplicate-side-effect-after-recovery': (code) => duplicateSideEffectMutation(code),
    'terminal-category-invalid': (code) => terminalMutation({ category: 'unknown' }, code),
    'terminal-evidence-missing': (code) => terminalMutation({ directEvidence: [] }, code),
    'terminal-recovery-fingerprint-unchanged': (code) => terminalRecoveryUnchanged(code),
    'reopen-retains-closed-projection': (code) => projectionMutation(
        (dag) => { dag.nodes[0].status = 'closed' },
        code
    ),
    'implementer-writes-ledger': (code) => writerMutation('code-implementer', code),
    'test-owner-writes-ledger': (code) => writerMutation('test-owner', code),
    'reviewer-writes-pass-event': (code) => writerMutation('issue-reviewer', code),
    'root-authors-pass-without-receipt': (code) => rootWithoutReceiptMutation(code),
    'ledger-inside-repository': (code) => protectedPathMutation('repository', code),
    'ledger-inside-workspace': (code) => protectedPathMutation('workspace', code),
    'ledger-path-symlink': (code) => symlinkMutation(code),
    'group-member-skips-verification': (code) => groupMutation('group.member.committed', 'candidate-green', 'committed', code),
    'group-member-inherits-green': (code) => groupInheritedGreenMutation(code),
    'group-event-out-of-order': (code) => groupMutation('group.session.activated', 'proposed', 'active', code),
    'group-duplicate-active-member': (code) => duplicateActiveMemberMutation(code),
    'group-lease-multiple-members': (code) => groupLeaseConflictMutation(code),
    'dag-proposal-local-stage-trigger': (code) => dagProposalMutation({ trigger: 'local-stage-event' }, code),
    'dag-proposal-root-authored': (code) => dagProposalMutation({}, code, 'root-scheduler')
}

function rejectedLedger() {
    const ledger = candidateLedger()
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: { actorId: testOwnerActorId, candidateSha, independentOfActorId: implementationActorId },
        toState: 'independent-verifying'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.rejected',
        fromState: 'independent-verifying',
        payload: {
            candidateSha,
            continuationAttemptId: 'attempt-1817-001',
            firstFailure: {
                classification: 'implementation',
                evidenceRef: 'evidence://first',
                signature: 'first'
            },
            implementationOwnerActorId: implementationActorId,
            reworkCount: 1
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

async function failureOverwriteMutation(eventType, _expected, code) {
    const ledger = rejectedLedger()
    sealEvent(ledger, {
        actorRole: eventType.startsWith('documentation.')
            ? 'documentation-writer'
            : 'machine-cleanup-verifier',
        eventType,
        fromState: 'implementing-self-testing',
        payload: {
            firstFailure: {
                classification: 'success',
                evidenceRef: 'evidence://replacement',
                signature: 'replacement'
            }
        },
        toState: 'implementing-self-testing'
    })
    await replayMutation(ledger, code)
}

async function uxRejectionMutation(mutator, code) {
    const ledger = behaviorGreenLedger({ issueKind: 'ui-ux' })
    sealEvent(ledger, {
        actorRole: 'ux-acceptance-verifier',
        attemptId: 'attempt-1817-001',
        eventType: 'ux-acceptance.started',
        fromState: 'behavior-green',
        payload: { actorId: uxActorId, candidateSha, modifiedPaths: [] },
        toState: 'ux-acceptance'
    })
    const payload = {
        implementationEffort: 'low',
        implementationOwnerActorId: implementationActorId,
        firstFailure: {
            classification: 'ux-rejected',
            evidenceRef: 'evidence://ux-red',
            signature: 'ux-red'
        }
    }
    mutator(payload)
    sealEvent(ledger, {
        actorRole: 'ux-acceptance-verifier',
        attemptId: 'attempt-1817-001',
        eventType: 'ux-acceptance.rejected',
        fromState: 'ux-acceptance',
        payload,
        toState: 'implementing-self-testing'
    })
    await replayMutation(ledger, code)
}

async function closeMutation({ remove }, code) {
    const ledger = closedLedger()
    const index = ledger.events.findIndex(({ eventType }) => eventType === remove)
    ledger.events.splice(index, 1)
    resealFrom(ledger, index)
    await replayMutation(ledger, code)
}

async function cleanupFailureMutation(payload, code) {
    const ledger = closedLedger()
    const start = ledger.events.findIndex(({ eventType }) => eventType === 'cleanup.started')
    ledger.events.splice(start + 1)
    sealEvent(ledger, {
        actorRole: 'machine-cleanup-verifier',
        eventType: 'cleanup.failed',
        fromState: 'cleaning',
        payload: {
            cleanupId: 'cleanup-1817-001',
            firstFailure: { classification: 'cleanup', signature: 'leak' },
            ...payload
        },
        toState: 'cleaning'
    })
    await replayMutation(ledger, code)
}

async function identityMutation(field, value, code) {
    const ledger = activeFrozenLedger()
    ledger.events[1][field] = value
    resealFrom(ledger, 1)
    await replayMutation(ledger, code)
}

async function terminalMutation(patch, code) {
    const ledger = frozenLedger()
    sealEvent(ledger, {
        eventType: 'node.terminal-entered',
        fromState: 'test-contract-frozen',
        payload: {
            category: 'externally_blocked',
            directEvidence: ['evidence://external'],
            recoveryFingerprint: digest('terminal'),
            ...patch
        },
        toState: 'terminal'
    })
    await replayMutation(ledger, code)
}

async function terminalRecoveryUnchanged(code) {
    const ledger = frozenLedger()
    const fingerprint = digest('same')
    sealEvent(ledger, {
        eventType: 'node.terminal-entered',
        fromState: 'test-contract-frozen',
        payload: {
            category: 'externally_blocked',
            directEvidence: ['evidence://external'],
            recoveryFingerprint: fingerprint
        },
        toState: 'terminal'
    })
    sealEvent(ledger, {
        eventType: 'node.terminal-recovered',
        fromState: 'terminal',
        payload: {
            previousRecoveryFingerprint: fingerprint,
            recoveryFingerprint: fingerprint
        },
        toState: 'test-contract-frozen'
    })
    await replayMutation(ledger, code)
}

function reopenedLedger() {
    const ledger = closedLedger()
    sealEvent(ledger, {
        eventType: 'issue.reopened',
        fromState: 'closed',
        payload: { liveIssueFingerprint: digest('reopened'), remoteState: 'OPEN' },
        toState: 'discovered'
    })
    return ledger
}

async function rootWithoutReceiptMutation(code) {
    const module = await runtime()
    const ledger = candidateLedger()
    const io = canonicalIo(module, ledger, 'root-no-receipt')
    const event = sealEvent(clone(ledger), {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: { actorId: testOwnerActorId, candidateSha },
        toState: 'independent-verifying'
    })
    delete event.payload.receipt
    event.payloadDigest = digest(event.payload)
    delete event.eventDigest
    event.eventDigest = digest(event)
    writeLedger(io.ledgerPath, ledger)
    await expectCode(
        () => module.appendEventAtomic({
            event,
            ...io,
            writerRole: 'root-scheduler'
        }),
        code
    )
}

async function protectedPathMutation(kind, code) {
    const module = await runtime()
    const ledger = activeDiscoveredLedger()
    const io = canonicalIo(module, ledger, kind)
    await expectCode(
        () => module.recoverEventLedger({
            ...io,
            protectedRoots: [io.stateRoot]
        }),
        code
    )
}

async function symlinkMutation(code) {
    const module = await runtime()
    const ledger = activeDiscoveredLedger()
    const io = canonicalIo(module, ledger, 'symlink')
    const target = fs.mkdtempSync(path.join(scratch, 'symlink-target-'))
    const runRoot = path.dirname(io.ledgerPath)
    fs.mkdirSync(path.dirname(runRoot), { recursive: true })
    fs.symlinkSync(target, runRoot)
    try {
        await expectCode(
            () => module.recoverEventLedger(io),
            code
        )
    } finally {
        fs.rmSync(runRoot, { force: true })
    }
}

async function truncatedTailMutation(code) {
    const module = await runtime()
    const ledger = frozenLedger()
    const io = canonicalIo(module, ledger, 'truncated')
    writeLedger(io.ledgerPath, ledger)
    fs.appendFileSync(
        io.ledgerPath,
        '{"schema":"issue-orchestration.event.v1"'
    )
    await expectCode(
        () => module.recoverEventLedger(io),
        code
    )
}

async function duplicateSideEffectMutation(code) {
    const ledger = closedLedger()
    const completed = clone(ledger.events.find(({ eventType }) => eventType === 'delivery.completed'))
    delete completed.eventDigest
    completed.eventId = 'event-duplicate-delivery'
    completed.sequence = ledger.events.length + 1
    completed.previousEventDigest = ledger.events.at(-1).eventDigest
    completed.fromState = 'closed'
    completed.toState = 'closed'
    completed.eventDigest = digest(completed)
    ledger.events.push(completed)
    await replayMutation(ledger, code)
}

async function groupMutation(eventType, fromState, toState, code) {
    const ledger = emptyLedger()
    sealEvent(ledger, {
        eventType: 'group.session.proposed',
        fromState: 'none',
        node: 'group-1817',
        payload: { groupId: 'group-1817' },
        toState: 'proposed'
    })
    sealEvent(ledger, {
        eventType,
        fromState,
        node: 'group-1817',
        payload: { groupId: 'group-1817', memberId: nodeId },
        toState
    })
    await replayMutation(ledger, code)
}

async function groupInheritedGreenMutation(code) {
    const ledger = groupLedger()
    const member = 'RepositoryA#1818'
    sealEvent(ledger, {
        eventType: 'group.member.committed',
        fromState: 'candidate-green',
        node: member,
        payload: { groupId: 'group-1817', memberId: member },
        toState: 'committed'
    })
    await replayMutation(ledger, code)
}

async function duplicateActiveMemberMutation(code) {
    const ledger = groupLedger()
    sealEvent(ledger, {
        eventType: 'group.session.activated',
        fromState: 'active',
        node: 'group-1817',
        payload: { activeMemberId: nodeId, groupId: 'group-1817' },
        toState: 'active'
    })
    await replayMutation(ledger, code)
}

async function groupLeaseConflictMutation(code) {
    const ledger = groupLedger()
    sealEvent(ledger, {
        eventType: 'group.member.write-lease-granted',
        fromState: 'no-lease',
        node: 'RepositoryA#1818',
        payload: {
            groupId: 'group-1817',
            leaseId: 'lease-1817',
            memberId: 'RepositoryA#1818'
        },
        toState: 'lease-granted'
    })
    await replayMutation(ledger, code)
}

async function dagProposalMutation(patch, code, actorRole = 'dag-creator-updater') {
    const ledger = frozenLedger()
    sealEvent(ledger, {
        actorRole,
        eventType: 'dag.proposal-accepted',
        fromState: 'test-contract-frozen',
        payload: {
            currentRemoteSnapshotDigest: digest('remote-new'),
            previousRemoteSnapshotDigest: digest('remote-old'),
            proposalReceipt: verifiedReceipt({
                actorId: 'dag-updater-1817',
                actorRole: 'dag-creator-updater'
            }),
            trigger: 'remote-live-snapshot-digest-changed',
            ...patch
        },
        toState: 'test-contract-frozen'
    })
    await replayMutation(ledger, code)
}

for (const control of controls) {
    test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async () => {
        await mutations[control.id](control.expectedCode)
    })
}

test('R01/R02/R04 durable recovery derives projection only from the ledger', async () => {
    const module = await runtime()
    const ledger = activeDiscoveredLedger()
    const io = canonicalIo(module, ledger, 'recovery')
    writeLedger(io.ledgerPath, ledger)

    const missing = await module.recoverEventLedger(io)
    assert.equal(missing.recoveryAction, 'replay-ledger-forward')
    assert.equal(nodeOf(missing.projection).status, 'discovered')

    const ahead = clone(missing.projection)
    ahead.lastSequence += 1
    ahead.nodes[nodeId].status = 'closed'
    fs.writeFileSync(
        io.projectionPath,
        `${JSON.stringify(ahead, null, 2)}\n`
    )
    const rebuilt = await module.recoverEventLedger(io)
    assert.equal(rebuilt.recoveryAction, 'discard-projection-and-rebuild')
    assert.equal(nodeOf(rebuilt.projection).status, 'discovered')

    const current = await module.recoverEventLedger(io)
    assert.equal(current.recoveryAction, 'projection-already-current')
    assert.deepEqual(current.repeatedSideEffects, [])
})

test('R03 corrupt tail reports the final valid sequence and keeps dispatch disabled', async () => {
    const module = await runtime()
    const ledger = activeDiscoveredLedger()
    const io = canonicalIo(module, ledger, 'tail')
    writeLedger(io.ledgerPath, ledger)
    fs.appendFileSync(
        io.ledgerPath,
        '{"schema":"issue-orchestration.event.v1"'
    )
    await assert.rejects(
        () => module.recoverEventLedger(io),
        (error) => {
            assert.equal(error.code, 'ledger-tail-corrupt')
            assert.equal(error.lastValidSequence, 1)
            assert.equal(error.dispatchEnabled, false)
            return true
        }
    )
})

test('R05/R06 append authority leaves protected repository and workspace inventories unchanged', async () => {
    const module = await runtime()
    const protectedRoots = [
        'target-repository',
        'launch-workspace',
        'linked-worktree'
    ]
        .map((name) => {
            const directory = path.join(scratch, name)
            fs.mkdirSync(directory)
            fs.writeFileSync(path.join(directory, 'tracked-sentinel'), `${name}\n`)
            return directory
        })
    const before = protectedRoots.map(treeDigest)
    const ledger = activeDiscoveredLedger()
    const io = canonicalIo(module, ledger, 'external-state')
    const last = ledger.events.pop()
    writeLedger(io.ledgerPath, ledger)
    await module.appendEventAtomic({
        event: last,
        ...io,
        protectedRoots,
        writerRole: 'root-scheduler'
    })
    assert.deepEqual(protectedRoots.map(treeDigest), before)
})

function treeDigest(directory) {
    const files = []
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name)
            const relative = path.relative(directory, absolute)
            if (entry.isDirectory()) visit(absolute)
            else files.push([relative, digest(fs.readFileSync(absolute))])
        }
    }
    visit(directory)
    return digest(files.sort((left, right) => left[0].localeCompare(right[0])))
}
