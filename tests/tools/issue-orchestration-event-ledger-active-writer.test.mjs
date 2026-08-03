import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    evaluateWriterStageObservation
} from '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
import {
    appendEventAtomic,
    canonicalEventLedgerLocation,
    recoverEventLedger,
    replayEventLedger
} from '../../skills/issue-orchestration/scripts/event-ledger.mjs'
import {
    buildCanonicalWriterStageLedger,
    compileWriterStageTestArtifacts,
    createCanonicalWriterDispatchReceipt,
    createWriterStageGitFixture
} from './issue-orchestration-writer-stage-test-helper.mjs'

const GENESIS = '0'.repeat(64)
const SOURCE_DAG_DIGEST = '1'.repeat(64)
const ISSUE_SNAPSHOT_FINGERPRINT = '2'.repeat(64)
const REPOSITORY_FINGERPRINT = '3'.repeat(64)
const REPOSITORY = 'Ozwasyd/FsusBlog'
const ISSUE = 1874
const NODE = 'FsusBlog#1874'
const RUN_ID_PREFIX = 'run-1874-active-writer-authority'
const EPOCH_ID_PREFIX = 'epoch-1874-active-writer-authority'
const IMPLEMENTATION_ATTEMPT_ID_PREFIX =
    'attempt-1874-active-code-implementation'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string'
            ? value
            : JSON.stringify(canonical(value)))
        .digest('hex')
}

function sealReceipt(receipt) {
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

function appendEvent(ledger, {
    actorRole,
    attemptId = null,
    eventType,
    fromState,
    payload,
    toState
}) {
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId:
            `event-${String(ledger.events.length + 1).padStart(3, '0')}`,
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        nodeId: NODE,
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest: SOURCE_DAG_DIGEST,
        issueSnapshotFingerprint: ISSUE_SNAPSHOT_FINGERPRINT,
        repositoryFingerprint: REPOSITORY_FINGERPRINT,
        baseSha: ledger.header.baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs: [`evidence://${eventType}`],
        createdAt: new Date(
            Date.parse('2026-08-02T00:00:00.000Z') +
            ledger.events.length * 1000
        ).toISOString(),
        previousEventDigest:
            ledger.events.at(-1)?.eventDigest ?? GENESIS
    }
    event.eventDigest = digest(event)
    ledger.events.push(event)
    return event
}

function resealFrom(ledger, start) {
    for (let index = start; index < ledger.events.length; index += 1) {
        const event = ledger.events[index]
        event.sequence = index + 1
        event.previousEventDigest = index === 0
            ? GENESIS
            : ledger.events[index - 1].eventDigest
        event.payloadDigest = digest(event.payload)
        delete event.eventDigest
        event.eventDigest = digest(event)
    }
}

function missingOutputObservation(artifacts, attemptId) {
    const plan = artifacts.stageWorkPlan
    const slice = artifacts.executableSlice
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
        compiledPromptDigest: artifacts.compiledPrompt.promptDigest,
        routeDigest: plan.routingInputDigest,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        attemptId,
        agentId: 'code-implementer-1874',
        firstRequiredActionExecuted: true,
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

function stagePayload(artifacts, actorId) {
    return {
        transitionSchema: 'issue-orchestration.transition.v2',
        actorId,
        dispatchReceipt: createCanonicalWriterDispatchReceipt({
            artifacts,
            attemptId: artifacts.stageWorkPlan.stageAttemptId
        }),
        stageWorkPlan: artifacts.stageWorkPlan,
        currentSlice: artifacts.executableSlice,
        executableSlice: artifacts.executableSlice,
        compiledPrompt: artifacts.compiledPrompt
    }
}

async function buildActiveWriterFailureLedger(current, identityTag) {
    const runId = `${RUN_ID_PREFIX}-${identityTag}`
    const epochId = `${EPOCH_ID_PREFIX}-${identityTag}-1`
    const implementationAttemptId =
        `${IMPLEMENTATION_ATTEMPT_ID_PREFIX}-${identityTag}`
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'tests/active-writer-contract.mjs',
            'src/active-writer-implementation.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const implementationWorktree = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-active-writer-clone-'
    ))
    fs.rmSync(implementationWorktree, { recursive: true })
    execFileSync(
        'git',
        ['clone', '--quiet', fixture.worktreeIdentity, implementationWorktree]
    )
    current.after(() =>
        fs.rmSync(implementationWorktree, { force: true, recursive: true }))

    fs.writeFileSync(
        path.join(
            implementationWorktree,
            'src/active-writer-implementation.mjs'
        ),
        "export const activeWriterImplementation = 'changed'\n"
    )

    const canonical = await buildCanonicalWriterStageLedger({
        current,
        repository: REPOSITORY,
        issue: ISSUE,
        node: NODE,
        runId,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId,
        worktreeIdentity: fs.realpathSync(implementationWorktree),
        allowedPaths: ['src/active-writer-implementation.mjs'],
        requiredFiles: ['src/active-writer-implementation.mjs'],
        requiredCommands: [
            'node --check src/active-writer-implementation.mjs'
        ],
        sliceId: 'active-writer-code-implementation-slice',
        stageAttemptId: implementationAttemptId
    })
    const implementationArtifacts = canonical.artifacts
    const ledger = structuredClone(canonical.ledger)
    appendEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: implementationAttemptId,
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        payload: {
            ...stagePayload(
                implementationArtifacts,
                'code-implementer-1874'
            ),
            effort: 'low',
            model: 'gpt-5.6-sol'
        },
        toState: 'implementing-self-testing'
    })
    const observation = missingOutputObservation(
        implementationArtifacts,
        implementationAttemptId
    )
    const failure = evaluateWriterStageObservation(observation)
    const failureEvent = appendEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: implementationAttemptId,
        eventType: failure.eventType,
        fromState: 'implementing-self-testing',
        payload: {
            transitionSchema: 'issue-orchestration.transition.v2',
            stageWorkPlan:
                implementationArtifacts.stageWorkPlan,
            currentSlice:
                implementationArtifacts.executableSlice,
            compiledPrompt:
                implementationArtifacts.compiledPrompt,
            currentCheckpoint: null,
            writerStageObservation: observation,
            failureReceipt: failure.failureReceipt,
            countsAsImplementationRework: false,
            reworkCountDelta: 0,
            triggersHumanDecision: false
        },
        toState: 'terminal'
    })
    return {
        failure,
        failureEventIndex: ledger.events.indexOf(failureEvent),
        implementationArtifacts,
        ledger
    }
}

async function expectCode(operation, code) {
    await assert.rejects(operation, (error) => {
        assert.equal(error?.code, code, error?.stack ?? String(error))
        return true
    })
}

test('append and recovery continue the canonical source ledger and reject caller-selected paths', async (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['tests/event-ledger-authority-path.mjs']
    })
    current.after(() => fixture.dispose())
    const artifacts = compileWriterStageTestArtifacts({
        repository: REPOSITORY,
        issue: ISSUE,
        node: NODE,
        runId: `${RUN_ID_PREFIX}-authority-path`,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        baseSha: fixture.baseSha,
        epochId: `${EPOCH_ID_PREFIX}-authority-path-1`,
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: ['tests/event-ledger-authority-path.mjs'],
        requiredFiles: ['tests/event-ledger-authority-path.mjs'],
        requiredCommands: [
            'node --check tests/event-ledger-authority-path.mjs'
        ],
        sliceId: 'event-ledger-authority-path-slice',
        stageAttemptId: 'attempt-1874-event-ledger-authority-path'
    })
    const plan = artifacts.stageWorkPlan
    const location = canonicalEventLedgerLocation({
        runId: plan.runId,
        nodeId: plan.node,
        stageAttemptId: plan.stageAttemptId
    })
    const entries = fs.readFileSync(location.ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const sourceLedger = {
        header: entries[0],
        events: entries.slice(1)
    }
    const startEvent = appendEvent(sourceLedger, {
        actorRole: 'test-owner',
        attemptId: plan.stageAttemptId,
        eventType: 'test-contract.started',
        fromState: 'discovered',
        payload: stagePayload(artifacts, 'test-owner-authority-path'),
        toState: 'test-contracting'
    })
    const appended = await appendEventAtomic({
        event: startEvent,
        ledgerPath: location.ledgerPath,
        projectionPath: location.projectionPath,
        stateRoot: location.stateRoot,
        stageAttemptId: plan.stageAttemptId,
        writerRole: 'root-scheduler'
    })
    assert.equal(appended.projection.nodes[NODE].status, 'test-contracting')
    const recovered = await recoverEventLedger({
        runId: plan.runId,
        nodeId: plan.node,
        stageAttemptId: plan.stageAttemptId,
        ledgerPath: location.ledgerPath,
        projectionPath: location.projectionPath,
        stateRoot: location.stateRoot
    })
    assert.equal(
        recovered.projection.projectionDigest,
        appended.projection.projectionDigest
    )
    const callerLedgerPath = path.join(
        path.dirname(location.ledgerPath),
        'caller-selected-ledger.jsonl'
    )
    const callerProjectionPath = path.join(
        path.dirname(location.projectionPath),
        'caller-selected-projection.json'
    )
    await expectCode(
        () => appendEventAtomic({
            event: {
                runId: plan.runId,
                nodeId: plan.node,
                attemptId: plan.stageAttemptId
            },
            ledgerPath: callerLedgerPath,
            projectionPath: location.projectionPath,
            stateRoot: location.stateRoot,
            stageAttemptId: plan.stageAttemptId,
            writerRole: 'root-scheduler'
        }),
        'event-ledger-authority-path-mismatch'
    )
    await expectCode(
        () => recoverEventLedger({
            runId: plan.runId,
            nodeId: plan.node,
            stageAttemptId: plan.stageAttemptId,
            ledgerPath: location.ledgerPath,
            projectionPath: callerProjectionPath,
            stateRoot: location.stateRoot
        }),
        'event-ledger-authority-path-mismatch'
    )
})

test('active writer failure is bound to the active role, plan, prompt, slice, attempt, and checkpoint', async (current) => {
    const {
        failure,
        failureEventIndex,
        ledger
    } = await buildActiveWriterFailureLedger(current, 'binding')
    const projection = await replayEventLedger(structuredClone(ledger))
    assert.equal(projection.nodes[NODE].status, 'terminal')
    assert.equal(failure.failureReceipt.authorityStatus, 'active-writer')

    const mutations = [
        {
            name: 'actor role',
            mutate(event) {
                event.actorRole = 'ui-ux-implementer'
            },
            code: 'writer-stage-active-binding-rejected'
        },
        {
            name: 'plan',
            mutate(event) {
                event.payload.stageWorkPlan = structuredClone(
                    event.payload.stageWorkPlan
                )
                event.payload.stageWorkPlan.planDigest = 'a'.repeat(64)
            },
            code: 'writer-stage-active-binding-rejected'
        },
        {
            name: 'slice',
            mutate(event) {
                event.payload.currentSlice = structuredClone(
                    event.payload.currentSlice
                )
                event.payload.currentSlice.sliceDigest = 'b'.repeat(64)
            },
            code: 'writer-stage-active-binding-rejected'
        },
        {
            name: 'compiled prompt',
            mutate(event) {
                event.payload.compiledPrompt = structuredClone(
                    event.payload.compiledPrompt
                )
                event.payload.compiledPrompt.rootInstructions =
                    'replace the compiler-owned prompt'
            },
            code: 'writer-stage-active-binding-rejected'
        },
        {
            name: 'attempt',
            mutate(event) {
                event.attemptId = 'attempt-1874-wrong-writer'
            },
            code: 'writer-stage-active-binding-rejected'
        },
        {
            name: 'current checkpoint',
            mutate(event) {
                event.payload.currentCheckpoint = {
                    checkpointDigest: 'c'.repeat(64)
                }
                event.payload.writerStageObservation.checkpoint =
                    event.payload.currentCheckpoint
            },
            code: 'writer-stage-current-checkpoint-mismatch'
        }
    ]
    for (const mutation of mutations) {
        const changed = structuredClone(ledger)
        mutation.mutate(changed.events[failureEventIndex])
        resealFrom(changed, failureEventIndex)
        await expectCode(
            () => replayEventLedger(changed),
            mutation.code
        ).catch((error) => {
            error.message = `${mutation.name}: ${error.message}`
            throw error
        })
    }
})

test('historical landing-owner observation cannot open an active writer breaker', async (current) => {
    const {
        failureEventIndex,
        implementationArtifacts,
        ledger
    } = await buildActiveWriterFailureLedger(current, 'historical')
    const changed = structuredClone(ledger)
    const event = changed.events[failureEventIndex]
    const historicalObservation = {
        ...missingOutputObservation(
            implementationArtifacts,
            implementationArtifacts.stageWorkPlan.stageAttemptId
        ),
        stageRole: 'landing-owner',
        stagePhase: 'landing-conflict-resolution',
        agentId: 'historical-landing-owner-1874'
    }
    const historicalFailure =
        evaluateWriterStageObservation(historicalObservation)
    assert.equal(
        historicalFailure.failureReceipt.authorityStatus,
        'historical-observation-only'
    )
    event.payload.writerStageObservation = historicalObservation
    event.payload.failureReceipt = historicalFailure.failureReceipt
    resealFrom(changed, failureEventIndex)

    await expectCode(
        () => replayEventLedger(changed),
        'writer-stage-active-authority-required'
    )
})
