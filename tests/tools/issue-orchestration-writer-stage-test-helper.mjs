import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
    compileDispatchPrompt,
    compileExecutableSlice,
    compileStageWorkPlan,
    sealFrozenStageContract,
    writerResourceRegistryIdentityDigest,
    writerStageAuthorityLocation
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    acquireDispatchLease
} from '../../skills/issue-orchestration/scripts/dispatch-batch-selector.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const writerAuthorityStateRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'issue-orchestration-writer-authority-'
))
fs.chmodSync(writerAuthorityStateRoot, 0o700)
process.env.FSUS_ISSUE_ORCHESTRATION_STATE_ROOT ??=
    writerAuthorityStateRoot
process.env.FSUS_ISSUE_ORCHESTRATION_REPOSITORIES ??= JSON.stringify([
    repositoryRoot
])
process.env.FSUS_ISSUE_ORCHESTRATION_WORKSPACES ??=
    JSON.stringify([repositoryRoot])
process.once('exit', () => {
    fs.rmSync(writerAuthorityStateRoot, {
        force: true,
        recursive: true
    })
})

const STAGE_KIND_BINDINGS = Object.freeze({
    'test-contract': {
        stageRole: 'test-owner',
        stagePhase: 'test-contract'
    },
    'code-implementation': {
        stageRole: 'code-implementer',
        stagePhase: 'implementation'
    },
    'ui-ux-implementation': {
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation'
    },
    'landing-conflict-resolution': {
        authorizedStageRoles: [
            'code-implementer',
            'ui-ux-implementer'
        ],
        stagePhase: 'landing-conflict-resolution'
    },
    documentation: {
        stageRole: 'documentation-writer',
        stagePhase: 'documentation'
    }
})
let writerAuthorityInvocation = 0
let canonicalWriterLedgerInvocation = 0
const canonicalWriterSourcePreludes = new Map()

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

export function writerTestDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function sealTestReceipt(value) {
    return {
        ...value,
        receiptDigest: writerTestDigest(value)
    }
}

function sourceBindingForPhase(stagePhase) {
    if (stagePhase === 'test-contract') {
        return {
            actorRole: 'dag-creator-updater',
            eventType: 'node.discovered',
            receiptSchema:
                'issue-orchestration.node-discovered-receipt.v1'
        }
    }
    if (['implementation', 'ui-implementation'].includes(stagePhase)) {
        return {
            actorRole: 'test-owner',
            eventType: 'test-contract.frozen',
            receiptSchema:
                'issue-orchestration.test-contract-freeze-receipt.v1'
        }
    }
    if (stagePhase === 'documentation') {
        return {
            actorRole: 'test-owner',
            eventType: 'independent-verification.passed',
            receiptSchema:
                'issue-orchestration.behavior-source-receipt.v1'
        }
    }
    if (stagePhase === 'landing-conflict-resolution') {
        return {
            actorRole: 'root-scheduler',
            eventType: 'delivery.failed',
            receiptSchema:
                'issue-orchestration.landing-conflict-source-receipt.v1'
        }
    }
    throw new Error(`unsupported writer source phase: ${stagePhase}`)
}

function createTestOwnerDispatchReceipt({
    baseSha,
    epochId,
    node,
    runId,
    testContractDigest
}) {
    return sealTestReceipt({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        verificationStatus: 'verified',
        runId,
        nodeId: node,
        attemptId: `test-owner-${writerTestDigest({
            runId,
            node
        }).slice(0, 16)}`,
        baseSha,
        epochId,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        testContractDigest,
        mismatchReasons: []
    })
}

function createSourceReceipt({
    baseSha,
    epochId,
    node,
    runId,
    source,
    stageRole,
    testContractDigest,
    testOwnerDispatchReceipt,
    repository,
    issue,
    issueSnapshotFingerprint,
    repositoryFingerprint,
    selectorReceiptDigest,
    remoteMemberDigest
}) {
    if (source.eventType === 'node.discovered') {
        return sealTestReceipt({
            schema: source.receiptSchema,
            status: 'verified',
            producerAuthority: 'deterministic-cold-start-compiler',
            rootAuthored: false,
            runId,
            nodeId: node,
            memberId: node,
            repository,
            issueNumber: Number(String(issue).match(/(\d+)$/u)?.[1] ?? issue),
            baseSha,
            nodeEpoch: 1,
            selectorReceiptDigest,
            remoteSnapshotDigest: writerTestDigest({
                runId, node, kind: 'remote-snapshot'
            }),
            remoteMemberDigest,
            issueSnapshotFingerprint,
            repositoryFingerprint,
            semanticProposalDigest: writerTestDigest({
                runId, node, kind: 'semantic-proposal'
            }),
            semanticRouteDecisionDigest: writerTestDigest({
                runId, node, kind: 'semantic-route'
            }),
            semanticFactsDigest: writerTestDigest({
                runId, node, kind: 'semantic-facts'
            }),
            requirementInventoryDigest: writerTestDigest({
                runId, node, kind: 'requirement-inventory'
            }),
            sourceCoverageDigest: writerTestDigest({
                runId, node, kind: 'source-coverage'
            }),
            acceptanceContractDigest: writerTestDigest({
                runId, node, kind: 'acceptance-contract'
            })
        })
    }
    const receipt = {
        schema: source.receiptSchema,
        verificationStatus: 'verified',
        actorRole: source.actorRole,
        runId,
        nodeId: node,
        baseSha,
        epochId,
        testContractDigest
    }
    if (source.eventType === 'test-contract.frozen') {
        receipt.dispatchReceiptDigest =
            testOwnerDispatchReceipt.receiptDigest
    }
    if (source.eventType === 'delivery.failed') {
        receipt.deliveryFailureReceiptDigest = writerTestDigest({
            runId,
            node,
            eventType: 'delivery.failed'
        })
        receipt.conflictMappingDigest = writerTestDigest({
            runId,
            node,
            stageRole,
            owner: 'machine-conflict-mapping'
        })
        receipt.memberWriterRole = stageRole
        receipt.memberIssueId = node
    }
    return sealTestReceipt(receipt)
}

function sealLedgerEvent({
    actorRole,
    attemptId,
    baseSha,
    createdAt,
    eventId,
    eventType,
    fromState,
    node,
    payload,
    previousEventDigest,
    runId,
    sequence,
    sourceDagDigest,
    issueSnapshotFingerprint,
    repositoryFingerprint,
    toState
}) {
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId,
        sequence,
        runId,
        nodeId: node,
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        baseSha,
        payload,
        payloadDigest: writerTestDigest(payload),
        evidenceRefs: [`evidence://${eventType}`],
        createdAt,
        previousEventDigest
    }
    event.eventDigest = writerTestDigest(event)
    return event
}

function canonicalWriterPreludeKey({
    eventType,
    node,
    runId,
    stageAttemptId
}) {
    return writerTestDigest({
        eventType,
        node,
        runId,
        stageAttemptId
    })
}

function canonicalWriterLedgerPath(subject) {
    if (typeof subject === 'string' && subject) return subject
    const ledgerPath =
        subject?.ledgerPath ??
        subject?.sourceLedgerPath ??
        subject?.location?.sourceLedgerPath ??
        subject?.writerAuthority?.location?.sourceLedgerPath
    if (typeof ledgerPath !== 'string' || !ledgerPath) {
        throw new TypeError(
            'canonical writer ledger path or authority location is required'
        )
    }
    return ledgerPath
}

export function readCanonicalWriterLedger(subject) {
    const ledgerPath = canonicalWriterLedgerPath(subject)
    const entries = fs.readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    if (entries.length === 0) {
        throw new Error('canonical writer ledger is empty')
    }
    return {
        header: entries[0],
        events: entries.slice(1)
    }
}

function writeCanonicalWriterLedger(subject, ledger) {
    const ledgerPath = canonicalWriterLedgerPath(subject)
    fs.mkdirSync(path.dirname(ledgerPath), {
        mode: 0o700,
        recursive: true
    })
    fs.chmodSync(path.dirname(ledgerPath), 0o700)
    fs.writeFileSync(
        ledgerPath,
        `${[ledger.header, ...ledger.events]
            .map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        { mode: 0o600 }
    )
    fs.chmodSync(ledgerPath, 0o600)
}

export function sealCanonicalWriterLedgerEvent({
    ledger,
    actorRole,
    attemptId = null,
    eventType,
    fromState = ledger?.events?.at(-1)?.toState ?? 'none',
    payload = {},
    toState,
    createdAt = null,
    eventId = null,
    evidenceRefs = null
} = {}) {
    if (!ledger?.header || !Array.isArray(ledger.events) ||
        typeof actorRole !== 'string' || !actorRole ||
        typeof eventType !== 'string' || !eventType ||
        typeof fromState !== 'string' || !fromState ||
        typeof toState !== 'string' || !toState) {
        throw new TypeError(
            'ledger, actorRole, eventType, fromState, and toState are required'
        )
    }
    const previous = ledger.events.at(-1)
    const sequence = ledger.events.length + 1
    const node =
        previous?.nodeId ??
        ledger.header.nodeId ??
        payload?.stageWorkPlan?.node
    if (typeof node !== 'string' || !node) {
        throw new TypeError(
            'canonical writer ledger node identity is required'
        )
    }
    const timestamp = createdAt ?? new Date(
        previous
            ? Date.parse(previous.createdAt) + 1_000
            : Date.parse(ledger.header.createdAt) + 1_000
    ).toISOString()
    const event = sealLedgerEvent({
        actorRole,
        attemptId,
        baseSha: ledger.header.baseSha,
        createdAt: timestamp,
        eventId: eventId ??
            `canonical-writer-event-${String(sequence).padStart(3, '0')}`,
        eventType,
        fromState,
        node,
        payload,
        previousEventDigest:
            previous?.eventDigest ?? '0'.repeat(64),
        runId: ledger.header.runId,
        sequence,
        sourceDagDigest:
            previous?.sourceDagDigest ??
            writerTestDigest({
                runId: ledger.header.runId,
                node,
                owner: 'dag'
            }),
        issueSnapshotFingerprint:
            previous?.issueSnapshotFingerprint ??
            ledger.header.issueSnapshotFingerprint,
        repositoryFingerprint:
            previous?.repositoryFingerprint ??
            ledger.header.repositoryFingerprint,
        toState
    })
    if (evidenceRefs !== null) {
        event.evidenceRefs = [...evidenceRefs]
        delete event.eventDigest
        event.eventDigest = writerTestDigest(event)
    }
    return event
}

function sourceEventBlueprints(stagePhase) {
    const discovered = {
        actorRole: 'dag-creator-updater',
        attemptId: null,
        eventType: 'node.discovered',
        fromState: 'none',
        toState: 'discovered'
    }
    if (stagePhase === 'test-contract') return [discovered]
    const testStarted = {
        actorRole: 'test-owner',
        attemptId: 'test-owner-attempt',
        eventType: 'test-contract.started',
        fromState: 'discovered',
        toState: 'test-contracting'
    }
    const testFrozen = {
        actorRole: 'test-owner',
        attemptId: 'test-owner-attempt',
        eventType: 'test-contract.frozen',
        fromState: 'test-contracting',
        toState: 'test-contract-frozen'
    }
    if (['implementation', 'ui-implementation'].includes(stagePhase)) {
        return [discovered, testStarted, testFrozen]
    }
    const implementationStarted = {
        actorRole: 'code-implementer',
        attemptId: 'implementation-attempt',
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        toState: 'implementing-self-testing'
    }
    const candidateGreen = {
        actorRole: 'code-implementer',
        attemptId: 'implementation-attempt',
        eventType: 'implementation.candidate-green',
        fromState: 'implementing-self-testing',
        toState: 'candidate-green'
    }
    const verificationStarted = {
        actorRole: 'test-owner',
        attemptId: 'verification-attempt',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        toState: 'independent-verifying'
    }
    const behaviorGreen = {
        actorRole: 'test-owner',
        attemptId: 'verification-attempt',
        eventType: 'independent-verification.passed',
        fromState: 'independent-verifying',
        toState: 'behavior-green'
    }
    const behavior = [
        discovered,
        testStarted,
        testFrozen,
        implementationStarted,
        candidateGreen,
        verificationStarted,
        behaviorGreen
    ]
    if (stagePhase === 'documentation') return behavior
    return [
        ...behavior,
        {
            actorRole: 'documentation-writer',
            attemptId: 'documentation-attempt',
            eventType: 'documentation.started',
            fromState: 'behavior-green',
            toState: 'documenting'
        },
        {
            actorRole: 'documentation-writer',
            attemptId: 'documentation-attempt',
            eventType: 'documentation.passed',
            fromState: 'documenting',
            toState: 'documentation-green'
        },
        {
            actorRole: 'root-scheduler',
            attemptId: null,
            eventType: 'delivery.ready-computed',
            fromState: 'documentation-green',
            toState: 'delivery-ready'
        },
        {
            actorRole: 'root-scheduler',
            attemptId: null,
            eventType: 'delivery.started',
            fromState: 'delivery-ready',
            toState: 'delivering'
        },
        {
            actorRole: 'root-scheduler',
            attemptId: null,
            eventType: 'delivery.failed',
            fromState: 'delivering',
            toState: 'delivery-ready'
        }
    ]
}

function writeOwnerOnlyJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), {
        mode: 0o700,
        recursive: true
    })
    fs.chmodSync(path.dirname(filePath), 0o700)
    fs.writeFileSync(
        filePath,
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 }
    )
    fs.chmodSync(filePath, 0o600)
}

function createWriterAuthority({
    acceptanceItems,
    baseSha,
    baselineDigest,
    deterministicSlicePolicy,
    epochId,
    issue,
    node,
    repository,
    routingInputDigest,
    runId,
    sliceId,
    skillDigest,
    stageAllowedPaths,
    stageAttemptId,
    stageForbiddenPaths,
    stagePhase,
    stageRequiredCommands,
    stageRole,
    stageObjective,
    stageTerminalArtifacts,
    testContractDigest,
    worktreeIdentity
}) {
    const source = sourceBindingForPhase(stagePhase)
    const slicePolicyDigest = writerTestDigest(
        deterministicSlicePolicy
    )
    const stageSourceContract = {
        schema: 'issue-orchestration.writer-stage-source-contract.v1',
        runId,
        repository,
        issue,
        node,
        baseSha,
        epochId,
        stageRole,
        stagePhase,
        stageObjective,
        testContractDigest,
        skillDigest,
        baselineDigest,
        routingInputDigest,
        acceptanceItems: [...acceptanceItems],
        stageAllowedPaths: [...stageAllowedPaths],
        stageForbiddenPaths: [...stageForbiddenPaths],
        stageRequiredCommands: [...stageRequiredCommands],
        stageTerminalArtifacts: [...stageTerminalArtifacts],
        slicePolicyDigest,
        rootAuthored: false
    }
    const canonicalPrelude = canonicalWriterSourcePreludes.get(
        canonicalWriterPreludeKey({
            eventType: source.eventType,
            node,
            runId,
            stageAttemptId
        })
    ) ?? null
    const testOwnerDispatchReceipt =
        canonicalPrelude?.dispatchReceipt ??
        createTestOwnerDispatchReceipt({
            baseSha,
            epochId,
            node,
            runId,
            testContractDigest
        })
    const sourceDagDigest = writerTestDigest({
        runId,
        node,
        owner: 'dag'
    })
    const issueSnapshotFingerprint = writerTestDigest({
        runId,
        node,
        owner: 'issue-snapshot'
    })
    const repositoryFingerprint = writerTestDigest({
        runId,
        node,
        owner: 'repository'
    })
    const selectorReceiptDigest = writerTestDigest({
        runId, node, kind: 'selector'
    })
    const remoteMemberDigest = writerTestDigest({
        runId, node, kind: 'remote-member'
    })
    const sourceReceipt = createSourceReceipt({
        baseSha,
        epochId,
        node,
        runId,
        source,
        stageRole,
        testContractDigest,
        testOwnerDispatchReceipt,
        repository,
        issue,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        selectorReceiptDigest,
        remoteMemberDigest
    })
    const blueprints = sourceEventBlueprints(stagePhase)
    const location = writerStageAuthorityLocation({
        runId,
        node,
        stageAttemptId
    })
    let existingLedger = null
    if (fs.existsSync(location.sourceLedgerPath)) {
        const entries = fs.readFileSync(
            location.sourceLedgerPath,
            'utf8'
        ).split('\n').filter(Boolean).map((line) => JSON.parse(line))
        existingLedger = {
            header: entries[0],
            events: entries.slice(1)
        }
        if (existingLedger.header?.runId !== runId ||
            existingLedger.header?.baseSha !== baseSha ||
            existingLedger.events.some((event) =>
                event.nodeId !== node)) {
            throw new Error(
                'canonical writer source ledger identity collision'
            )
        }
    }
    const events = existingLedger
        ? structuredClone(existingLedger.events)
        : []
    let matchedBlueprints = 0
    for (const event of events) {
        if (event.eventType ===
            blueprints[matchedBlueprints]?.eventType) {
            matchedBlueprints += 1
        }
    }
    const firstCreatedAt = existingLedger
        ? Date.parse(events.at(-1).createdAt) + 1_000
        : Date.now() - blueprints.length * 1_000
    for (const [offset, blueprint] of blueprints
        .slice(matchedBlueprints).entries()) {
        const index = matchedBlueprints + offset
        const boundBlueprint = [
            'test-contract.started',
            'test-contract.frozen'
        ].includes(blueprint.eventType)
            ? {
                ...blueprint,
                attemptId:
                    blueprint.eventType === source.eventType &&
                        canonicalPrelude?.attemptId
                        ? canonicalPrelude.attemptId
                        : testOwnerDispatchReceipt.attemptId
            }
            : blueprint
        let payload = {}
        if (blueprint.eventType === 'test-contract.started') {
            payload = {
                actorId: 'test-owner',
                dispatchReceipt: testOwnerDispatchReceipt
            }
        }
        if (blueprint.eventType === source.eventType) {
            payload = blueprint.eventType === 'node.discovered'
                ? {
                    issueKind: 'code',
                    nodeDiscoveredReceipt: sourceReceipt,
                    nodeDiscoveredReceiptDigest:
                        sourceReceipt.receiptDigest,
                    sourceReceiptDigest: sourceReceipt.receiptDigest
                }
                : {
                    ...(canonicalPrelude?.payload ?? {}),
                    writerStageContract: stageSourceContract,
                    sourceReceipt,
                    sourceReceiptDigest: sourceReceipt.receiptDigest
                }
        }
        events.push(sealLedgerEvent({
            ...boundBlueprint,
            baseSha,
            createdAt:
                new Date(firstCreatedAt + offset * 1_000)
                    .toISOString(),
            eventId: `source-event-${events.length + 1}`,
            node,
            payload,
            previousEventDigest:
                events.at(-1)?.eventDigest ?? '0'.repeat(64),
            runId,
            sequence: events.length + 1,
            sourceDagDigest,
            issueSnapshotFingerprint,
            repositoryFingerprint
        }))
    }
    const nodeHeaderUnsigned = {
        schema: 'issue-orchestration.node-ledger.v1',
        transitionSchema: 'issue-orchestration.transition.v2',
        runId,
        nodeId: node,
        memberId: node,
        repository,
        issueNumber: Number(String(issue).match(/(\d+)$/u)?.[1] ?? issue),
        selectorReceiptDigest,
        remoteMemberDigest,
        nodeEpoch: 1,
        stateRootCanonical: path.dirname(path.dirname(location.runRoot)),
        baseSha,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        createdAt: new Date(firstCreatedAt - 1_000).toISOString()
    }
    const ledger = [existingLedger?.header ?? {
        ...nodeHeaderUnsigned,
        headerDigest: writerTestDigest(nodeHeaderUnsigned)
    }, ...events]
    fs.mkdirSync(path.dirname(location.sourceLedgerPath), {
        mode: 0o700,
        recursive: true
    })
    fs.chmodSync(path.dirname(location.sourceLedgerPath), 0o700)
    fs.writeFileSync(
        location.sourceLedgerPath,
        `${ledger.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        { mode: 0o600 }
    )
    fs.chmodSync(location.sourceLedgerPath, 0o600)
    const leaseId = `resource-${writerTestDigest({
        runId,
        node,
        stageAttemptId,
        sliceId
    }).slice(0, 24)}`
    const worktreeResourceId = `worktree-${writerTestDigest({
        runId,
        node,
        stageAttemptId
    }).slice(0, 16)}`
    const resourceRegistry = {
        schema: 'issue-orchestration.resource-registry.v1',
        runId,
        issueId: node,
        stageAttemptId,
        stageTaskId: sliceId,
        stageRole,
        issueWorktreeId: worktreeResourceId,
        baseSha,
        epochId,
        allowedPathsDigest: writerTestDigest(stageAllowedPaths),
        testContractDigest,
        slotHeld: true,
        writeLease: {
            id: leaseId,
            ownerAttemptId: stageAttemptId,
            mode: 'write',
            state: 'active'
        },
        resources: [{
            resourceId: worktreeResourceId,
            resourceType: 'worktree',
            ownerClass: 'attempt-owned',
            ownerRunId: runId,
            ownerAttemptId: stageAttemptId,
            state: 'active',
            identityEvidence: {
                path: fs.realpathSync(worktreeIdentity),
                baseSha
            }
        }]
    }
    const registryIdentityDigest =
        writerResourceRegistryIdentityDigest({
            registry: resourceRegistry,
            worktreeIdentity
        })
    const now = Date.now()
    const resourceLease = acquireDispatchLease({
        activeLeases: [],
        request: {
            leaseId,
            kind: 'writer-stage-resource',
            keys: [
                `worktree:${fs.realpathSync(worktreeIdentity)}`,
                `resource-registry:${registryIdentityDigest}`
            ],
            ownerId: stageRole,
            attemptId: stageAttemptId,
            stageTaskId: sliceId,
            acquiredAt: new Date(now - 1_000).toISOString(),
            expiresAt:
                new Date(now + 60 * 60 * 1_000).toISOString(),
            recoveryRule: 'terminal-receipt-required'
        }
    }).lease
    writeOwnerOnlyJson(
        location.resourceRegistryPath,
        resourceRegistry
    )
    writeOwnerOnlyJson(location.writerLeasePath, resourceLease)
    return {
        location,
        resourceLease,
        resourceRegistry,
        sourceEvent: events.at(-1)
    }
}

export function writerStageBindingForKind(stageKind, stageRole = null) {
    const binding = STAGE_KIND_BINDINGS[stageKind] ?? null
    if (!binding?.authorizedStageRoles) return binding
    return binding.authorizedStageRoles.includes(stageRole)
        ? {
            stageRole,
            stagePhase: binding.stagePhase
        }
        : null
}

export function compileWriterStageTestArtifacts({
    repository,
    issue,
    node = `${repository}#${issue}`,
    stageRole,
    stagePhase,
    baseSha,
    epochId,
    worktreeIdentity,
    allowedPaths,
    forbiddenPaths = [],
    requiredFiles = allowedPaths.slice(0, 1),
    requiredCommands,
    requiredEvidence = [
        'filesystem-git-command-evidence'
    ],
    sliceOverrides = [],
    sliceId = `${node.replaceAll(/[^a-zA-Z0-9]+/gu, '-')}-${stagePhase}-slice-1`,
    sliceCount = 1,
    runId = null,
    testContractDigest = writerTestDigest({
        node,
        stagePhase,
        owner: 'test-contract'
    }),
    routingInputDigest = writerTestDigest({
        node,
        stagePhase,
        owner: 'routing-input'
    }),
    stageAttemptId = null
}) {
    writerAuthorityInvocation += 1
    const authorityInvocationId =
        `${process.pid}-${writerAuthorityInvocation}`
    runId ??= `run-${sliceId}-${authorityInvocationId}`
    stageAttemptId ??=
        `attempt-${sliceId}-${authorityInvocationId}`
    if (!Number.isInteger(sliceCount) || sliceCount < 1 ||
        sliceCount > 16 || requiredFiles.length < sliceCount) {
        throw new RangeError(
            'sliceCount must be 1..16 and have one required file per slice'
        )
    }
    if (!Array.isArray(sliceOverrides) ||
        sliceOverrides.length > sliceCount ||
        sliceOverrides.some((override) =>
            override !== undefined &&
            override !== null &&
            (typeof override !== 'object' ||
                Array.isArray(override)))) {
        throw new TypeError(
            'sliceOverrides must be an index-aligned array of shallow object overrides'
        )
    }
    const skillDigest = writerTestDigest({
        node,
        owner: 'skill'
    })
    const baselineDigest = writerTestDigest({
        node,
        baseSha,
        owner: 'baseline'
    })
    const stageObjective =
        `Complete the focused ${stagePhase} writer slice for ${node}`
    const stageAllowedPaths = [...allowedPaths]
    const stageForbiddenPaths = [...forbiddenPaths]
    const stageTerminalArtifacts = [
        'issue-orchestration.slice-terminal-receipt.v1'
    ]
    const sliceIds = Array.from({ length: sliceCount }, (_, index) =>
        index === 0 ? sliceId : `${sliceId}-${index + 1}`)
    const acceptanceItems = sliceIds.map((id) => `${id}-acceptance`)
    const stageRequiredCommands = sliceIds.map((_, index) =>
        requiredCommands?.[index] ??
        `node --check ${requiredFiles[index]}`)
    const orderedSlices = sliceIds.map((id, index) => ({
        sliceId: id,
        order: index + 1,
        prerequisiteSliceIds:
            index === 0 ? [] : [sliceIds[index - 1]],
        singleObjective:
            `Produce focused ${stagePhase} artifact ${index + 1} for ${node}`,
        firstRequiredAction: stageRequiredCommands[index],
        firstReadTargets: [requiredFiles[index]],
        firstWritablePath: requiredFiles[index],
        explicitReadOnlyOutput: null,
        allowedPaths: [...allowedPaths],
        forbiddenPaths: [...forbiddenPaths],
        requiredCreatedOrModifiedFiles: [requiredFiles[index]],
        requiredCommands: [stageRequiredCommands[index]],
        requiredEvidence: [...requiredEvidence],
        expectedFailureOrProgressSignal:
            `${stagePhase} artifact or terminal failure receipt`,
        explicitNonGoals: [
            'dispatch the complete issue',
            'rewrite another stage contract',
            'replace machine evidence with prose'
        ],
        maxChangedFiles: 1,
        maxOwnedModules: Math.max(1, allowedPaths.length),
        maxReadOnlyOperationsBeforeCheckpoint: 8,
        maxNoArtifactToolCalls: 6,
        maxNoArtifactActiveDurationClass: 'short',
        safeCheckpointKind: 'stage-progress',
        acceptanceItemIds: [acceptanceItems[index]],
        completionPredicate:
            `required-files-commands-evidence-complete:${id}`,
        continuationPredicate:
            `sealed-checkpoint-cursor-resume:${id}`,
        ...structuredClone(sliceOverrides[index] ?? {})
    }))
    const deterministicSlicePolicy = {
        schema: 'issue-orchestration.deterministic-slice-policy.v1',
        maxSliceCount: sliceCount,
        maxAcceptanceItemsPerSlice: 1,
        maxFirstReadTargetsPerSlice: 1,
        maxAllowedPathsPerSlice: Math.max(1, allowedPaths.length),
        maxRequiredFilesPerSlice: 1,
        maxRequiredCommandsPerSlice: 1,
        maxRequiredEvidencePerSlice: Math.max(1, requiredEvidence.length),
        maxExplicitNonGoalsPerSlice: 3,
        maxChangedFilesPerSlice: 1,
        maxOwnedModulesPerSlice: Math.max(1, allowedPaths.length),
        maxReadOnlyOperationsBeforeCheckpointPerSlice: 8,
        maxNoArtifactToolCallsPerSlice: 6,
        allowedNoArtifactActiveDurationClasses: ['short'],
        allowedSafeCheckpointKinds: ['stage-progress'],
        orderedSliceBlueprints: structuredClone(orderedSlices)
    }
    const writerAuthority = createWriterAuthority({
        acceptanceItems,
        baseSha,
        baselineDigest,
        deterministicSlicePolicy,
        epochId,
        issue,
        node,
        repository,
        routingInputDigest,
        runId,
        sliceId,
        skillDigest,
        stageAllowedPaths,
        stageAttemptId,
        stageForbiddenPaths,
        stagePhase,
        stageRequiredCommands,
        stageRole,
        stageObjective,
        stageTerminalArtifacts,
        testContractDigest,
        worktreeIdentity
    })
    const frozenStageContract = sealFrozenStageContract({
        schema: 'issue-orchestration.frozen-stage-contract-input.v1',
        runId,
        repository,
        issue,
        node,
        stageRole,
        stagePhase,
        baseSha,
        epochId,
        worktreeIdentity,
        testContractDigest,
        skillDigest,
        baselineDigest,
        routingInputDigest,
        stageObjective,
        acceptanceItems,
        stageAllowedPaths,
        stageForbiddenPaths,
        stageRequiredCommands,
        stageTerminalArtifacts,
        stageAttemptId,
        deterministicSlicePolicy,
        authoredByRole: 'test-owner',
        rootAuthored: false
    })
    const planInput = {
        schema: 'issue-orchestration.stage-work-plan-input.v1',
        runId,
        repository,
        issue,
        node,
        stageRole,
        stagePhase,
        baseSha,
        epochId,
        worktreeIdentity,
        semanticContractDigest:
            frozenStageContract.semanticContractDigest,
        testContractDigest,
        authorityDigest: frozenStageContract.authorityDigest,
        skillDigest,
        baselineDigest,
        routingInputDigest,
        stageObjective,
        acceptanceItems,
        orderedSlices,
        sliceDependencyGraph: Object.fromEntries(
            orderedSlices.map((slice) => [
                slice.sliceId,
                [...slice.prerequisiteSliceIds]
            ])
        ),
        stageAllowedPaths,
        stageForbiddenPaths,
        stageRequiredCommands,
        stageTerminalArtifacts,
        frozenStageContract
    }
    const plan = compileStageWorkPlan(planInput)
    const executableSlices = orderedSlices.map(({ sliceId: id }) =>
        compileExecutableSlice({ plan, sliceId: id }))
    const compiledPrompts = executableSlices.map((slice) =>
        compileDispatchPrompt({ plan, slice }))
    const slice = executableSlices[0]
    const compiledPrompt = compiledPrompts[0]
    return Object.freeze({
        stageWorkPlan: plan,
        stageWorkPlanInput: planInput,
        frozenStageContract,
        deterministicSlicePolicy,
        writerAuthority,
        executableSlice: slice,
        executableSlices: Object.freeze(executableSlices),
        compiledPrompt,
        compiledPrompts: Object.freeze(compiledPrompts),
        planDigest: plan.planDigest,
        sliceDigest: slice.sliceDigest,
        plannerBindingStatus: plan.plannerBindingStatus,
        slicePolicyDigest: plan.slicePolicyDigest,
        plannerReceiptDigest: plan.plannerReceiptDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        promptDigest: compiledPrompt.promptDigest,
        allowedPathsDigest: writerTestDigest(slice.allowedPaths),
        forbiddenPathsDigest: writerTestDigest(slice.forbiddenPaths)
    })
}

export function createCanonicalWriterDispatchReceipt({
    artifacts,
    attemptId = artifacts?.stageWorkPlan?.stageAttemptId
} = {}) {
    const plan = artifacts?.stageWorkPlan
    const slice = artifacts?.executableSlice
    const compiledPrompt = artifacts?.compiledPrompt
    if (!plan || !slice || !compiledPrompt ||
        typeof attemptId !== 'string' || !attemptId) {
        throw new TypeError(
            'canonical writer artifacts and attemptId are required'
        )
    }
    return sealTestReceipt({
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId: `request-${attemptId}`,
        requestDigest: writerTestDigest({
            runId: plan.runId,
            node: plan.node,
            attemptId,
            planDigest: plan.planDigest,
            sliceDigest: slice.sliceDigest
        }),
        runId: plan.runId,
        nodeId: plan.node,
        attemptId,
        epochId: plan.epochId,
        stageRole: plan.stageRole,
        stagePhase: plan.stagePhase,
        policyVersion: 'stage-model-pool.v4',
        routingPolicyDigest: writerTestDigest({
            policyVersion: 'stage-model-pool.v4',
            stageRole: plan.stageRole,
            stagePhase: plan.stagePhase
        }),
        routingInputDigest: plan.routingInputDigest,
        baseSha: plan.baseSha,
        candidateSha: plan.baseSha,
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        testContractDigest: plan.testContractDigest,
        activeWriteLeaseId: plan.activeWriteLeaseId,
        resourceLeaseReceiptDigest:
            plan.resourceLeaseReceiptDigest,
        verificationStatus: 'verified',
        mismatchReasons: []
    })
}

function canonicalWriterChangedPaths(checkpoint) {
    return (checkpoint?.evidence?.git?.worktreeStatus ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .sort()
}

export async function buildCanonicalWriterStageLedger({
    current = null,
    ...requested
} = {}) {
    if (requested.stagePhase !== 'implementation' ||
        requested.stageRole !== 'code-implementer') {
        throw new Error(
            'canonical writer ledger currently supports the real test-contract to implementation chain'
        )
    }
    if (typeof requested.repository !== 'string' ||
        !requested.repository ||
        !Number.isInteger(requested.issue) ||
        typeof requested.baseSha !== 'string' ||
        !requested.baseSha ||
        typeof requested.epochId !== 'string' ||
        !requested.epochId ||
        typeof requested.worktreeIdentity !== 'string' ||
        !requested.worktreeIdentity ||
        !Array.isArray(requested.allowedPaths) ||
        requested.allowedPaths.length === 0) {
        throw new TypeError(
            'repository, issue, baseSha, epochId, worktreeIdentity, and allowedPaths are required'
        )
    }

    canonicalWriterLedgerInvocation += 1
    const invocationId =
        `${process.pid}-${canonicalWriterLedgerInvocation}`
    const node = requested.node ??
        `${requested.repository}#${requested.issue}`
    const targetSliceId = requested.sliceId ??
        `${node.replaceAll(/[^a-zA-Z0-9]+/gu, '-')}-implementation-slice-1`
    const runId = requested.runId ??
        `run-canonical-writer-${invocationId}`
    const stageAttemptId = requested.stageAttemptId ??
        `attempt-canonical-implementation-${invocationId}`
    const testAttemptId =
        `attempt-canonical-test-contract-${writerTestDigest({
            runId,
            node,
            stageAttemptId
        }).slice(0, 20)}`
    const testSliceId =
        `${targetSliceId}-test-contract-predecessor`
    const requiredFiles = requested.requiredFiles ??
        requested.allowedPaths.slice(0, 1)
    const predecessorFile = requiredFiles[0]
    const targetTestContractDigest =
        requested.testContractDigest ?? writerTestDigest({
            node,
            stagePhase: requested.stagePhase,
            owner: 'test-contract'
        })
    const predecessorContainer = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-canonical-predecessor-'
    ))
    const predecessorWorktree = path.join(
        predecessorContainer,
        'worktree'
    )
    let disposed = false
    const dispose = () => {
        if (disposed) return
        disposed = true
        fs.rmSync(predecessorContainer, {
            force: true,
            recursive: true
        })
    }
    current?.after(dispose)

    try {
        execFileSync(
            'git',
            [
                'clone',
                '--quiet',
                '--no-hardlinks',
                fs.realpathSync(requested.worktreeIdentity),
                predecessorWorktree
            ],
            { encoding: 'utf8' }
        )
        if (git(predecessorWorktree, 'rev-parse', 'HEAD') !==
            requested.baseSha) {
            throw new Error(
                'canonical predecessor clone does not match baseSha'
            )
        }
        const predecessorAbsolutePath = path.join(
            predecessorWorktree,
            predecessorFile
        )
        if (!fs.existsSync(predecessorAbsolutePath) ||
            !fs.lstatSync(predecessorAbsolutePath).isFile()) {
            throw new Error(
                `canonical predecessor required file is missing: ${predecessorFile}`
            )
        }
        fs.appendFileSync(
            predecessorAbsolutePath,
            '\n'
        )

        const testArtifacts = compileWriterStageTestArtifacts({
            repository: requested.repository,
            issue: requested.issue,
            node,
            runId,
            stageRole: 'test-owner',
            stagePhase: 'test-contract',
            baseSha: requested.baseSha,
            epochId: requested.epochId,
            worktreeIdentity:
                fs.realpathSync(predecessorWorktree),
            allowedPaths: [...requested.allowedPaths],
            forbiddenPaths: [
                ...(requested.forbiddenPaths ?? [])
            ],
            requiredFiles: [predecessorFile],
            requiredCommands: [
                requested.requiredCommands?.[0] ??
                `node --check ${predecessorFile}`
            ],
            requiredEvidence: [
                ...(requested.requiredEvidence ?? [
                    'filesystem-git-command-evidence'
                ])
            ],
            sliceId: testSliceId,
            sliceCount: 1,
            testContractDigest: targetTestContractDigest,
            routingInputDigest: writerTestDigest({
                runId,
                node,
                stagePhase: 'test-contract',
                owner: 'routing-input'
            }),
            stageAttemptId: testAttemptId
        })
        const {
            buildVerifiedWriterProgressCheckpoint
        } = await import(
            './issue-orchestration-writer-progress-test-helper.mjs'
        )
        const {
            sealSliceTerminalReceipt
        } = await import(
            '../../skills/issue-orchestration/scripts/writer-stage-progress.mjs'
        )
        const progress = buildVerifiedWriterProgressCheckpoint({
            current,
            artifacts: testArtifacts,
            routeDigest:
                testArtifacts.stageWorkPlan.routingInputDigest,
            status: 'complete'
        })
        const terminalReceipt = sealSliceTerminalReceipt({
            plan: testArtifacts.stageWorkPlan,
            slice: testArtifacts.executableSlice,
            checkpoint: progress.checkpoint,
            compiledPrompt: testArtifacts.compiledPrompt,
            compiledPromptDigest:
                testArtifacts.compiledPromptDigest,
            routeDigest: progress.routeDigest,
            checkpointVerificationReceipt:
                progress.checkpointVerificationReceipt,
            sealedAuthority: {
                expectedSourceEventDigest:
                    testArtifacts.stageWorkPlan
                        .sourceEventDigest,
                expectedSourceLedgerDigest:
                    testArtifacts.stageWorkPlan
                        .sourceLedgerDigest
            },
            changedPaths:
                canonicalWriterChangedPaths(progress.checkpoint),
            commandEvidenceDigests:
                progress.checkpoint.evidence.commands
                    .map(({ outputDigest }) => outputDigest)
        })
        const testDispatchReceipt =
            createCanonicalWriterDispatchReceipt({
                artifacts: testArtifacts,
                attemptId: testAttemptId
            })
        const testStagePayload = {
            transitionSchema:
                'issue-orchestration.transition.v2',
            actorId: 'canonical-test-owner',
            stageWorkPlan: testArtifacts.stageWorkPlan,
            currentSlice: testArtifacts.executableSlice,
            executableSlice: testArtifacts.executableSlice,
            compiledPrompt: testArtifacts.compiledPrompt
        }
        const ledger = readCanonicalWriterLedger(
            testArtifacts.writerAuthority.location
        )
        ledger.events.push(sealCanonicalWriterLedgerEvent({
            ledger,
            actorRole: 'test-owner',
            attemptId: testAttemptId,
            eventType: 'test-contract.started',
            fromState: 'discovered',
            toState: 'test-contracting',
            payload: {
                ...testStagePayload,
                dispatchReceipt: testDispatchReceipt
            }
        }))
        ledger.events.push(sealCanonicalWriterLedgerEvent({
            ledger,
            actorRole: 'test-owner',
            attemptId: testAttemptId,
            eventType: 'writer-stage.checkpoint-recorded',
            fromState: 'test-contracting',
            toState: 'test-contracting',
            payload: {
                ...testStagePayload,
                checkpoint: progress.checkpoint,
                checkpointVerificationReceipt:
                    progress.checkpointVerificationReceipt
            }
        }))
        const terminalGatePayload = {
            ...testStagePayload,
            currentCheckpoint: progress.checkpoint,
            checkpointVerificationReceipt:
                progress.checkpointVerificationReceipt,
            terminalReceipt,
            sliceTerminalReceipts: [terminalReceipt]
        }
        ledger.events.push(sealCanonicalWriterLedgerEvent({
            ledger,
            actorRole: 'test-owner',
            attemptId: testAttemptId,
            eventType: 'writer-stage.completed',
            fromState: 'test-contracting',
            toState: 'test-contracting',
            payload: terminalGatePayload
        }))
        writeCanonicalWriterLedger(
            testArtifacts.writerAuthority.location,
            ledger
        )

        const preludeKey = canonicalWriterPreludeKey({
            eventType: 'test-contract.frozen',
            node,
            runId,
            stageAttemptId
        })
        canonicalWriterSourcePreludes.set(preludeKey, {
            attemptId: testAttemptId,
            dispatchReceipt: testDispatchReceipt,
            payload: terminalGatePayload
        })
        let artifacts
        try {
            artifacts = compileWriterStageTestArtifacts({
                ...requested,
                node,
                runId,
                sliceId: targetSliceId,
                testContractDigest:
                    targetTestContractDigest,
                stageAttemptId
            })
        } finally {
            canonicalWriterSourcePreludes.delete(preludeKey)
        }
        const {
            canonicalEventLedgerLocation,
            replayEventLedgerSync
        } = await import(
            '../../skills/issue-orchestration/scripts/event-ledger.mjs'
        )
        const finalLedger = readCanonicalWriterLedger(
            artifacts.writerAuthority.location
        )
        const projection = replayEventLedgerSync(finalLedger)
        const location = canonicalEventLedgerLocation({
            runId,
            nodeId: node,
            stageAttemptId
        })
        writeOwnerOnlyJson(location.projectionPath, projection)
        const expectedSourceEventDigest =
            artifacts.stageWorkPlan.sourceEventDigest
        const expectedSourceLedgerDigest =
            artifacts.stageWorkPlan.sourceLedgerDigest
        return Object.freeze({
            artifacts,
            testArtifacts,
            testDispatchReceipt,
            testCheckpoint: progress.checkpoint,
            testCheckpointVerificationReceipt:
                progress.checkpointVerificationReceipt,
            testTerminalReceipt: terminalReceipt,
            ledger: finalLedger,
            ledgerPath: location.ledgerPath,
            projectionPath: location.projectionPath,
            projection,
            expectedSourceEventDigest,
            expectedSourceLedgerDigest,
            anchors: Object.freeze({
                expectedSourceEventDigest,
                expectedSourceLedgerDigest
            }),
            dispose
        })
    } catch (error) {
        dispose()
        throw error
    }
}

function git(cwd, ...args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8'
    }).trim()
}

export function createWriterStageGitFixture({ filePaths }) {
    if (!Array.isArray(filePaths) || filePaths.length === 0 ||
        filePaths.some((filePath) =>
            typeof filePath !== 'string' ||
            !filePath.trim() ||
            path.posix.isAbsolute(filePath) ||
            path.posix.normalize(filePath).startsWith('../')) ||
        new Set(filePaths).size !== filePaths.length) {
        throw new TypeError('unique repository-relative filePaths are required')
    }

    const worktreeIdentity = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-writer-stage-'
    ))
    const baselineSources = filePaths.map((filePath, index) =>
        `export const fixtureValue${index + 1} = 'baseline:${filePath}'\n`)
    const writeSource = (filePath, source) => {
        const absolutePath = path.join(worktreeIdentity, filePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        fs.writeFileSync(absolutePath, source)
    }

    try {
        execFileSync('git', ['init', '--quiet'], {
            cwd: worktreeIdentity,
            encoding: 'utf8'
        })
        execFileSync('git', ['config', 'user.email', 'writer-tests@example.invalid'], {
            cwd: worktreeIdentity,
            encoding: 'utf8'
        })
        execFileSync('git', ['config', 'user.name', 'Writer Stage Tests'], {
            cwd: worktreeIdentity,
            encoding: 'utf8'
        })
        for (const [index, filePath] of filePaths.entries()) {
            writeSource(filePath, baselineSources[index])
        }
        execFileSync('git', ['add', '--', ...filePaths], {
            cwd: worktreeIdentity,
            encoding: 'utf8'
        })
        execFileSync('git', ['commit', '--quiet', '-m', 'fixture baseline'], {
            cwd: worktreeIdentity,
            encoding: 'utf8'
        })
    } catch (error) {
        fs.rmSync(worktreeIdentity, { force: true, recursive: true })
        throw error
    }

    let disposed = false
    return Object.freeze({
        worktreeIdentity: fs.realpathSync(worktreeIdentity),
        baseSha: git(worktreeIdentity, 'rev-parse', 'HEAD'),
        filePaths: Object.freeze([...filePaths]),
        activate(indexes) {
            if (disposed) throw new Error('writer-stage Git fixture is disposed')
            const selected = Array.isArray(indexes) ? indexes : [indexes]
            if (selected.length === 0 ||
                selected.some((index) =>
                    !Number.isInteger(index) ||
                    index < 0 ||
                    index >= filePaths.length)) {
                throw new RangeError('valid fixture file indexes are required')
            }
            const selectedSet = new Set(selected)
            for (const [index, filePath] of filePaths.entries()) {
                writeSource(
                    filePath,
                    selectedSet.has(index)
                        ? `export const fixtureValue${index + 1} = `
                            + `'changed:${filePath}'\n`
                        : baselineSources[index]
                )
            }
        },
        dispose() {
            if (disposed) return
            disposed = true
            fs.rmSync(worktreeIdentity, { force: true, recursive: true })
        }
    })
}

export function observeWriterStageCheckpointEvidence({
    worktreeIdentity,
    slice,
    requiredFiles = slice.requiredCreatedOrModifiedFiles ??
        slice.requiredFiles,
    requiredCommands = slice.requiredCommands,
    satisfiedEvidenceIds = slice.requiredEvidence
}) {
    const worktreeRoot = fs.realpathSync(worktreeIdentity)
    const files = requiredFiles.map((filePath) => ({
        path: filePath,
        realPath: fs.realpathSync(path.join(worktreeRoot, filePath)),
        gitObjectDigest: git(worktreeRoot, 'hash-object', filePath)
    }))
    const commands = requiredCommands.map((command) => {
        const result = spawnSync('/bin/sh', ['-lc', command], {
            cwd: worktreeRoot,
            encoding: 'utf8',
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024
        })
        if (result.error || !Number.isInteger(result.status)) {
            throw result.error ??
                new Error(`command did not produce an exit status: ${command}`)
        }
        return {
            command,
            exitStatus: result.status,
            outputDigest: writerTestDigest({
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? ''
            })
        }
    })
    const evidence = {
        requiredFiles: files,
        commands,
        git: {
            headSha: git(worktreeRoot, 'rev-parse', 'HEAD'),
            worktreeStatus: execFileSync(
                'git',
                ['status', '--short', '--untracked-files=all'],
                {
                    cwd: worktreeRoot,
                    encoding: 'utf8'
                }
            ).replace(/(?:\r?\n)+$/u, '')
        },
        satisfiedEvidenceIds: [...satisfiedEvidenceIds]
    }
    return {
        ...evidence,
        evidenceDigest: writerTestDigest(evidence)
    }
}
