import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import fs from 'node:fs'
import path from 'node:path'
import { verifyCleanupReceipt } from './resource-lifecycle.mjs'
import { validateRouteReclassification } from './stage-profile-policy.mjs'
import {
    compileDispatchPrompt,
    compileExecutableSlice,
    compileSealedContinuation,
    validateCompiledDispatchPrompt,
    validateSealedCompiledDispatchPrompt,
    validateSealedExecutableSlice,
    validateSealedStageWorkPlan,
    writerStageAuthorityLocation
} from './executable-slice-compiler.mjs'
import {
    authorizeWriterStageRetry,
    evaluateSliceTerminalGate,
    evaluateWriterStageObservation,
    validateSealedWriterStageCheckpointEvidence,
    validateSealedWriterStageRetryAuthorization,
    verifyWriterStageCheckpointLiveEvidence,
    writerStageSliceMaterialDigest
} from './writer-stage-progress.mjs'

const GENESIS = '0'.repeat(64)
const EVENT_FIELDS = [
    'eventId', 'sequence', 'runId', 'nodeId', 'eventType', 'fromState',
    'toState', 'attemptId', 'actorRole', 'sourceDagDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'baseSha',
    'payloadDigest', 'evidenceRefs', 'createdAt', 'previousEventDigest',
    'eventDigest'
]
const ACTIVE_WRITER_ROLES_BY_PHASE = Object.freeze({
    'test-contract': Object.freeze(['test-owner']),
    implementation: Object.freeze(['code-implementer']),
    'ui-implementation': Object.freeze(['ui-ux-implementer']),
    documentation: Object.freeze(['documentation-writer']),
    'landing-conflict-resolution': Object.freeze([
        'code-implementer',
        'ui-ux-implementer'
    ])
})

function fail(code, message = code, details = {}) {
    const error = new Error(message)
    error.code = code
    Object.assign(error, details)
    throw error
}

function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string' ? value : JSON.stringify(normalize(value)))
        .digest('hex')
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

const rules = {
    'node.discovered': [['none', 'discovered']],
    'test-contract.started': [['discovered', 'test-contracting']],
    'test-contract.frozen': [['test-contracting', 'test-contract-frozen']],
    'test-contract.disputed': [['test-contracting', 'discovered']],
    'implementation.started': [
        ['test-contract-frozen', 'implementing-self-testing'],
        ['implementing-self-testing', 'implementing-self-testing'],
        ['delivery-ready', 'delivering']
    ],
    'implementation.candidate-green': [
        ['implementing-self-testing', 'candidate-green'],
        ['test-contract-frozen', 'candidate-green']
    ],
    'implementation.contract-disputed': [['implementing-self-testing', 'test-contract-frozen']],
    'implementation.external-blocked': [['implementing-self-testing', 'terminal']],
    'implementation.resource-failed': [['implementing-self-testing', 'test-contract-frozen']],
    'decision-analysis.started': [
        ['test-contract-frozen', 'decision-analyzing'],
        ['implementing-self-testing', 'decision-analyzing']
    ],
    'decision-analysis.completed': [['decision-analyzing', 'decision-analysis-completed']],
    'human-decision.required': [['decision-analysis-completed', 'human-decision-required']],
    'human-decision.recorded': [['human-decision-required', 'human-decision-recorded']],
    'human-decision.invalidated': [
        ['human-decision-required', 'decision-analysis-completed'],
        ['human-decision-recorded', 'decision-analysis-completed']
    ],
    'contract.rebased': [['human-decision-recorded', 'test-contract-frozen']],
    'node.resumed': [['human-decision-recorded', 'discovered']],
    'independent-verification.started': [['candidate-green', 'independent-verifying']],
    'independent-verification.rejected': [['independent-verifying', 'implementing-self-testing']],
    'independent-verification.passed': [
        ['independent-verifying', 'behavior-green'],
        ['candidate-green', 'behavior-green']
    ],
    'ux-acceptance.started': [['behavior-green', 'ux-acceptance']],
    'ux-acceptance.rejected': [['ux-acceptance', 'implementing-self-testing']],
    'ux-acceptance.accepted': [['ux-acceptance', 'ux-accepted']],
    'documentation.started': [
        ['behavior-green', 'documenting'], ['ux-accepted', 'documenting'],
        ['candidate-green', 'documenting'], ['implementing-self-testing', 'implementing-self-testing']
    ],
    'documentation.failed': [['documenting', 'behavior-green']],
    'documentation.passed': [
        ['documenting', 'documentation-green'],
        ['implementing-self-testing', 'implementing-self-testing']
    ],
    'delivery.ready-computed': [['documentation-green', 'delivery-ready']],
    'delivery.started': [
        ['delivery-ready', 'delivering'], ['behavior-green', 'delivering']
    ],
    'delivery.failed': [['delivering', 'delivery-ready']],
    'delivery.completed': [['delivering', 'delivering'], ['closed', 'closed']],
    'cleanup.started': [['delivering', 'cleaning']],
    'cleanup.quarantined': [['cleaning', 'cleaning']],
    'cleanup.failed': [['cleaning', 'cleaning']],
    'cleanup.completed': [
        ['cleaning', 'cleaning'], ['implementing-self-testing', 'implementing-self-testing']
    ],
    'issue.closed': [['cleaning', 'closed']],
    'issue.reopened': [['closed', 'discovered']],
    'node.terminal-entered': [['*', 'terminal']],
    'node.terminal-recovered': [['terminal', '*']],
    'attempt.cancelled': [['implementing-self-testing', 'test-contract-frozen']],
    'attempt.expired': [['implementing-self-testing', 'test-contract-frozen']],
    'attempt.invocation-failed': [['implementing-self-testing', 'test-contract-frozen']],
    'attempt.environment-failed': [['implementing-self-testing', 'test-contract-frozen']],
    'writer-stage.checkpoint-recorded': [['*', '*']],
    'writer-stage.continuation-recorded': [['*', '*']],
    'writer-stage.invocation-failed': [['*', 'terminal']],
    'writer-stage.environment-failed': [['*', 'terminal']],
    'writer-stage.runtime-capability-missing': [['*', 'terminal']],
    'writer-stage.first-action-not-executed': [['*', 'terminal']],
    'writer-stage.output-missing': [['*', 'terminal']],
    'writer-stage.checkpoint-missing': [['*', 'terminal']],
    'writer-stage.receipt-rejected': [['*', 'terminal']],
    'writer-stage.retry-authorized': [
        ['terminal', 'discovered'],
        ['terminal', 'test-contract-frozen'],
        ['terminal', 'behavior-green'],
        ['terminal', 'ux-accepted'],
        ['terminal', 'delivery-ready']
    ],
    'writer-stage.slice-completed': [
        ['test-contracting', 'test-contracting'],
        ['implementing-self-testing', 'implementing-self-testing'],
        ['documenting', 'documenting'],
        ['delivering', 'delivering']
    ],
    'writer-stage.completed': [
        ['test-contracting', 'test-contracting'],
        ['implementing-self-testing', 'implementing-self-testing'],
        ['documenting', 'documenting'],
        ['delivering', 'delivering']
    ],
    'ledger.correction-recorded': [['*', '*']],
    'dag.proposal-accepted': [['*', '*']],
    'dag.proposal-rejected': [['*', '*']],
    'route.reclassified': [['*', '*']],
    'group.session.proposed': [['none', 'proposed']],
    'group.session.created': [['proposed', 'created']],
    'group.session.activated': [['created', 'active'], ['active', 'active']],
    'group.member.test-contract-frozen': [['test-contracting', 'test-contract-frozen']],
    'group.member.write-lease-granted': [['no-lease', 'lease-granted']],
    'group.member.candidate-created': [['implementing-self-testing', 'candidate-green']],
    'group.member.behavior-green': [['independent-verifying', 'behavior-green']],
    'group.member.committed': [
        ['behavior-green', 'committed'], ['candidate-green', 'committed']
    ],
    'group.member.delivery-completed': [['committed', 'delivery-completed']],
    'group.member.write-lease-revoked': [['lease-granted', 'lease-revoked']],
    'group.session.cleaning': [['active', 'cleaning']],
    'group.session.cleaned': [['cleaning', 'cleaned']],
    'group.session.cancelled': [['*', 'cancelled']],
    'group.session.failed': [['*', 'failed']],
    'group.session.completed': [['cleaned', 'completed']]
}

export const transitionTable = Object.freeze(Object.fromEntries(
    Object.entries(rules).map(([key, transitions]) => [key, Object.freeze({ transitions })])
))

function permitted(rule, from, to) {
    return rule.transitions.some(([allowedFrom, allowedTo]) =>
        (allowedFrom === '*' || allowedFrom === from) &&
        (allowedTo === '*' || allowedTo === to))
}

function receipt(event) {
    return event.payload?.receipt
}

function receiptDigestValid(item) {
    if (!item || typeof item.receiptDigest !== 'string') return false
    const unsigned = { ...item }
    delete unsigned.receiptDigest
    return item.receiptDigest === digest(unsigned)
}

function sameValue(left, right) {
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function activeWriterRoleAllowed(stagePhase, stageRole) {
    return ACTIVE_WRITER_ROLES_BY_PHASE[stagePhase]?.includes(stageRole) ===
        true
}

function sealedAuthorityAnchorFromLedger(plan, context) {
    if (!plan ||
        !Array.isArray(context.verifiedEvents) ||
        !context.ledgerHeader) {
        fail('sealed-writer-authority-anchor')
    }
    for (let length = 0;
        length <= context.verifiedEvents.length;
        length += 1) {
        const events = context.verifiedEvents.slice(0, length)
        if (digest({
            header: context.ledgerHeader,
            events
        }) !== plan.sourceLedgerDigest) {
            continue
        }
        if (!events.some(({ eventDigest }) =>
            eventDigest === plan.sourceEventDigest)) {
            fail('sealed-writer-authority-anchor')
        }
        return {
            expectedSourceEventDigest:
                plan.sourceEventDigest,
            expectedSourceLedgerDigest:
                plan.sourceLedgerDigest
        }
    }
    fail('sealed-writer-authority-anchor')
}

function validateWriterArtifactBinding({
    checkpoint = undefined,
    checkpointMustBeRecorded = false,
    context,
    event,
    node,
    payload
}) {
    const plan = payload.stageWorkPlan
    const slice = payload.currentSlice ?? payload.executableSlice
    const compiledPrompt = payload.compiledPrompt
    let expectedSlice
    let compiledPromptErrors
    const sealedAuthority = sealedAuthorityAnchorFromLedger(
        plan,
        context
    )
    if (context.liveAppendEventId === event.eventId) {
        try {
            expectedSlice = compileExecutableSlice({
                plan,
                sliceId: slice?.sliceId
            })
            compiledPromptErrors = validateCompiledDispatchPrompt({
                plan,
                slice,
                compiled: compiledPrompt
            })
        } catch {
            fail('writer-stage-active-binding-rejected')
        }
    } else {
        const planErrors = validateSealedStageWorkPlan(
            plan,
            sealedAuthority
        )
        const sliceErrors = validateSealedExecutableSlice({
            plan,
            slice,
            authority: sealedAuthority
        })
        compiledPromptErrors =
            validateSealedCompiledDispatchPrompt({
                plan,
                slice,
                compiled: compiledPrompt,
                authority: sealedAuthority
            })
        if (planErrors.length || sliceErrors.length ||
            compiledPromptErrors.length) {
            fail('writer-stage-active-binding-rejected')
        }
        expectedSlice = slice
    }
    if (!sameValue(expectedSlice, slice) ||
        compiledPromptErrors.length > 0 ||
        !activeWriterRoleAllowed(plan.stagePhase, plan.stageRole) ||
        plan.runId !== event.runId ||
        plan.node !== event.nodeId ||
        plan.baseSha !== event.baseSha ||
        slice.planDigest !== plan.planDigest ||
        slice.stageRole !== plan.stageRole ||
        slice.stagePhase !== plan.stagePhase ||
        compiledPrompt.planDigest !== plan.planDigest ||
        compiledPrompt.sliceDigest !== slice.sliceDigest ||
        compiledPrompt.stageRole !== plan.stageRole ||
        compiledPrompt.stagePhase !== plan.stagePhase ||
        event.actorRole !== plan.stageRole ||
        (plan.stageAttemptId !== null &&
            plan.stageAttemptId !== event.attemptId)) {
        fail('writer-stage-active-binding-rejected')
    }
    if (node && ![
        'test-contract.started',
        'implementation.started',
        'documentation.started'
    ].includes(event.eventType)) {
        if (node.activeAttemptId !== event.attemptId ||
            node.activePlanDigest !== plan.planDigest ||
            node.activeSliceId !== slice.sliceId ||
            node.activeSliceDigest !== slice.sliceDigest ||
            node.activeCompiledPromptDigest !==
                compiledPrompt.promptDigest ||
            node.activeStageRole !== plan.stageRole ||
            node.activeStagePhase !== plan.stagePhase) {
            fail('writer-stage-active-binding-rejected')
        }
        if (checkpointMustBeRecorded &&
            (checkpoint?.checkpointDigest ?? null) !==
                node.latestCheckpointDigest) {
            fail('writer-stage-current-checkpoint-mismatch')
        }
    }
    return { compiledPrompt, plan, slice }
}

function validateCanonicalWriterCheckpoint({
    checkpoint,
    compiledPrompt,
    context,
    event,
    node,
    plan,
    slice,
    verificationReceipt
}) {
    const currentIndex = plan.orderedSlices.findIndex(
        ({ sliceId }) => sliceId === slice.sliceId
    )
    const acceptedPrefix = currentIndex < 0
        ? []
        : node.completedSlicePrefix.slice(0, currentIndex)
    const acceptedPriorChangedPaths = [
        ...new Set(acceptedPrefix.flatMap(
            ({ changedPaths = [] }) => changedPaths
        ))
    ].sort()
    const compiledPromptDigest =
        compiledPrompt?.promptDigest ??
        verificationReceipt?.compiledPromptDigest
    const checkpointOrdinal =
        event.eventType ===
            'writer-stage.checkpoint-recorded'
            ? node.latestCheckpointOrdinal + 1
            : verificationReceipt?.checkpointOrdinal
    const previousCheckpointDigest =
        event.eventType ===
            'writer-stage.checkpoint-recorded'
            ? node.latestCheckpointDigest
            : verificationReceipt?.previousCheckpointDigest
    const previousCheckpointVerificationReceiptDigest =
        event.eventType ===
            'writer-stage.checkpoint-recorded'
            ? node.latestCheckpointVerificationReceiptDigest
            : verificationReceipt
                ?.previousCheckpointVerificationReceiptDigest
    const previousMachineTracePrefixDigest =
        event.eventType ===
            'writer-stage.checkpoint-recorded'
            ? node.latestCheckpointTracePrefixDigest
            : verificationReceipt
                ?.previousMachineTracePrefixDigest
    const previousMachineTracePrefixByteLength =
        event.eventType ===
            'writer-stage.checkpoint-recorded'
            ? node.latestMachineTracePrefixByteLength
            : verificationReceipt
                ?.previousMachineTracePrefixByteLength
    const previousMachineTraceSnapshot =
        previousCheckpointVerificationReceiptDigest
            ? context.checkpointEvidenceByVerificationDigest
                .get(
                    previousCheckpointVerificationReceiptDigest
                )?.machineTraceSnapshot ?? null
            : null
    const options = {
        plan,
        slice,
        checkpoint,
        compiledPrompt,
        compiledPromptDigest,
        routeDigest: plan.routingInputDigest,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest: digest(acceptedPrefix),
        checkpointOrdinal,
        previousCheckpointDigest,
        previousCheckpointVerificationReceiptDigest,
        previousMachineTracePrefixDigest,
        previousMachineTracePrefixByteLength,
        previousMachineTraceSnapshot,
        sealedAuthority:
            sealedAuthorityAnchorFromLedger(plan, context)
    }
    let errors = []
    try {
        if (context.liveAppendEventId === event.eventId) {
            verifyWriterStageCheckpointLiveEvidence({
                ...options,
                verificationReceipt
            })
        } else {
            errors = validateSealedWriterStageCheckpointEvidence({
                ...options,
                verificationReceipt
            })
        }
    } catch {
        errors = [
            'canonical writer-stage checkpoint verification failed'
        ]
    }
    if (!Array.isArray(errors) || errors.length > 0) {
        fail(
            'writer-stage-checkpoint-verification-receipt-rejected'
        )
    }
    if (event.eventType !==
            'writer-stage.checkpoint-recorded' &&
        (node.latestCheckpointVerificationReceiptDigest !==
            verificationReceipt.receiptDigest ||
        node.latestCheckpointTracePrefixDigest !==
            verificationReceipt.machineTracePrefixDigest)) {
        fail(
            'writer-stage-checkpoint-verification-receipt-rejected'
        )
    }
}

function terminalGateArguments({
    context,
    node,
    payload
}) {
    const plan = payload.stageWorkPlan
    const currentSlice = payload.currentSlice
    const currentIndex = plan.orderedSlices.findIndex(
        ({ sliceId }) => sliceId === currentSlice.sliceId
    )
    const prefix = currentIndex < 0
        ? []
        : node.completedSlicePrefix.slice(0, currentIndex)
    const acceptedPriorChangedPaths = [
        ...new Set(prefix.flatMap(
            ({ changedPaths = [] }) => changedPaths
        ))
    ].sort()
    const verificationReceipt =
        payload.checkpointVerificationReceipt
    const previousMachineTraceSnapshot =
        verificationReceipt
            ?.previousCheckpointVerificationReceiptDigest
            ? context.checkpointEvidenceByVerificationDigest
                .get(
                    verificationReceipt
                        .previousCheckpointVerificationReceiptDigest
                )?.machineTraceSnapshot ?? null
            : null
    return {
        carryForwardPrefix:
            node.writerStageCarryForwardPrefix,
        plan,
        currentSlice,
        currentCheckpoint: payload.currentCheckpoint,
        compiledPrompt: payload.compiledPrompt,
        checkpointVerificationReceipt:
            verificationReceipt,
        sealedAuthority:
            sealedAuthorityAnchorFromLedger(plan, context),
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest: digest(prefix),
        previousMachineTraceSnapshot,
        terminalReceipts: payload.sliceTerminalReceipts,
        nextSlice: payload.nextSlice ?? null
    }
}

function slicePrefixEntry({
    attemptId,
    checkpoint,
    plan,
    slice,
    terminal,
    verificationReceipt
}) {
    return {
        planDigest: plan.planDigest,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        sliceMaterialDigest:
            writerStageSliceMaterialDigest(slice),
        checkpointDigest: checkpoint.checkpointDigest,
        checkpointVerificationReceiptDigest:
            verificationReceipt.receiptDigest,
        tracePrefixDigest:
            verificationReceipt.machineTracePrefixDigest,
        changedPaths: [...terminal.changedPaths].sort(),
        terminalReceiptDigest: terminal.receiptDigest,
        terminalChainDigest: terminal.terminalChainDigest,
        sliceOrdinal: terminal.sliceOrdinal,
        planSliceCount: terminal.planSliceCount,
        priorTerminalReceiptDigests:
            [...terminal.priorTerminalReceiptDigests],
        completedSlicePrefixDigest:
            terminal.completedSlicePrefixDigest,
        acceptedPriorChangedPathsDigest:
            terminal.acceptedPriorChangedPathsDigest,
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        stageAttemptId: attemptId
    }
}

function completedPrefixEntryMatchesActivePlan({
    attemptId,
    entry,
    index,
    node,
    plan
}) {
    const mapping =
        node.writerStageCarryForwardPrefix?.entries?.[index]
    if (mapping) {
        return mapping.order === index + 1 &&
            mapping.sliceId === entry.sliceId &&
            mapping.previousPlanDigest === entry.planDigest &&
            mapping.previousStageAttemptId ===
                entry.stageAttemptId &&
            mapping.previousSliceDigest === entry.sliceDigest &&
            mapping.previousSliceMaterialDigest ===
                entry.sliceMaterialDigest &&
            mapping.previousCheckpointDigest ===
                entry.checkpointDigest &&
            mapping.previousCheckpointVerificationReceiptDigest ===
                entry.checkpointVerificationReceiptDigest &&
            mapping.previousTracePrefixDigest ===
                entry.tracePrefixDigest &&
            mapping.previousTerminalReceiptDigest ===
                entry.terminalReceiptDigest &&
            mapping.previousTerminalChainDigest ===
                entry.terminalChainDigest &&
            mapping.previousSliceOrdinal ===
                entry.sliceOrdinal &&
            mapping.previousPlanSliceCount ===
                entry.planSliceCount &&
            sameValue(
                mapping.previousPriorTerminalReceiptDigests,
                entry.priorTerminalReceiptDigests
            ) &&
            mapping.previousCompletedSlicePrefixDigest ===
                entry.completedSlicePrefixDigest &&
            mapping.previousAcceptedPriorChangedPathsDigest ===
                entry.acceptedPriorChangedPathsDigest &&
            sameValue(mapping.changedPaths, entry.changedPaths) &&
            mapping.currentPlanDigest === plan.planDigest &&
            mapping.currentStageAttemptId === attemptId &&
            mapping.unchangedSliceMaterialDigest ===
                entry.sliceMaterialDigest &&
            plan.orderedSlices[index]?.sliceId ===
                entry.sliceId
    }
    return entry.planDigest === plan.planDigest &&
        entry.stageAttemptId === attemptId &&
        plan.orderedSlices[index]?.sliceId === entry.sliceId
}

function terminalReceiptMatchesPrefixEntry(receipt, entry) {
    return receipt?.sliceId === entry.sliceId &&
        receipt.sliceDigest === entry.sliceDigest &&
        receipt.checkpointDigest === entry.checkpointDigest &&
        receipt.checkpointVerificationReceiptDigest ===
            entry.checkpointVerificationReceiptDigest &&
        sameValue(
            [...(receipt.changedPaths ?? [])].sort(),
            entry.changedPaths
        ) &&
        receipt.receiptDigest === entry.terminalReceiptDigest &&
        receipt.terminalChainDigest === entry.terminalChainDigest &&
        receipt.sliceOrdinal === entry.sliceOrdinal &&
        receipt.planSliceCount === entry.planSliceCount &&
        sameValue(
            receipt.priorTerminalReceiptDigests,
            entry.priorTerminalReceiptDigests
        ) &&
        receipt.completedSlicePrefixDigest ===
            entry.completedSlicePrefixDigest &&
        receipt.acceptedPriorChangedPathsDigest ===
            entry.acceptedPriorChangedPathsDigest
}

function validateLedgerOwnedSlicePrefix({
    event,
    node,
    payload,
    terminal
}) {
    if (!terminal || typeof terminal !== 'object' ||
        !Array.isArray(terminal.changedPaths)) {
        fail('writer-stage-terminal-receipt-rejected')
    }
    const receipts = payload.sliceTerminalReceipts
    const prefix = node.completedSlicePrefix
    const plan = payload.stageWorkPlan
    if (!Array.isArray(receipts) ||
        receipts.length !== prefix.length + 1 ||
        plan.orderedSlices?.length < receipts.length ||
        plan.orderedSlices?.[prefix.length]?.sliceId !==
            payload.currentSlice?.sliceId) {
        fail('writer-stage-ledger-prefix-mismatch')
    }
    for (const [index, entry] of prefix.entries()) {
        const receipt = receipts[index]
        if (!completedPrefixEntryMatchesActivePlan({
            attemptId: event.attemptId,
            entry,
            index,
            node,
            plan
        }) ||
            entry.stageRole !== plan.stageRole ||
            entry.stagePhase !== plan.stagePhase ||
            !terminalReceiptMatchesPrefixEntry(
                receipt,
                entry
            )) {
            fail('writer-stage-ledger-prefix-mismatch')
        }
    }
    const expectedCurrent = slicePrefixEntry({
        attemptId: event.attemptId,
        checkpoint: payload.currentCheckpoint,
        plan,
        slice: payload.currentSlice,
        terminal,
        verificationReceipt:
            payload.checkpointVerificationReceipt
    })
    const currentReceipt = receipts.at(-1)
    if (!sameValue(currentReceipt, terminal) ||
        terminal.sliceId !== expectedCurrent.sliceId ||
        terminal.sliceDigest !== expectedCurrent.sliceDigest ||
        terminal.checkpointDigest !==
            expectedCurrent.checkpointDigest ||
        payload.checkpointVerificationReceipt?.receiptDigest !==
            expectedCurrent.checkpointVerificationReceiptDigest ||
        payload.checkpointVerificationReceipt
            ?.machineTracePrefixDigest !==
            expectedCurrent.tracePrefixDigest) {
        fail('writer-stage-ledger-prefix-mismatch')
    }
    return expectedCurrent
}

function validateAtomicNextSlice({
    event,
    node,
    payload,
    nextSlice
}) {
    const plan = payload.stageWorkPlan
    let expectedSlice
    let expectedPrompt
    try {
        expectedSlice = compileExecutableSlice({
            plan,
            sliceId: nextSlice?.sliceId
        })
        expectedPrompt = compileDispatchPrompt({
            plan,
            slice: expectedSlice
        })
    } catch {
        fail('writer-stage-next-slice-rejected')
    }
    const nextPrompt = payload.nextCompiledPrompt
    const nextDispatch = payload.nextDispatchReceipt
    if (!sameValue(expectedSlice, nextSlice) ||
        !sameValue(expectedPrompt, nextPrompt) ||
        plan.orderedSlices?.[
            node.completedSlicePrefix.length + 1
        ]?.sliceId !== nextSlice.sliceId ||
        nextDispatch?.schema !==
            'issue-orchestration.dispatch-receipt.v2' ||
        nextDispatch.verificationStatus !== 'verified' ||
        !receiptDigestValid(nextDispatch) ||
        nextDispatch.runId !== plan.runId ||
        nextDispatch.nodeId !== plan.node ||
        nextDispatch.attemptId !== event.attemptId ||
        nextDispatch.epochId !== plan.epochId ||
        nextDispatch.baseSha !== plan.baseSha ||
        nextDispatch.planDigest !== plan.planDigest ||
        nextDispatch.sliceDigest !== nextSlice.sliceDigest ||
        nextDispatch.compiledPromptDigest !== nextPrompt.promptDigest ||
        nextDispatch.stageRole !== plan.stageRole ||
        nextDispatch.stagePhase !== plan.stagePhase ||
        event.actorRole !== plan.stageRole ||
        nextSlice.stageAttemptId !== plan.stageAttemptId ||
        plan.stageAttemptId !== event.attemptId) {
        fail('writer-stage-next-slice-dispatch-rejected')
    }
    return { nextPrompt }
}

function validateCompletedSlicePrefix(node, payload) {
    const prefix = node.completedSlicePrefix
    const receipts = payload.sliceTerminalReceipts
    const plan = payload.stageWorkPlan
    if (!Array.isArray(receipts) ||
        receipts.length !== prefix.length ||
        prefix.length !== plan?.orderedSlices?.length) {
        fail('writer-stage-ledger-prefix-mismatch')
    }
    for (const [index, entry] of prefix.entries()) {
        const receipt = receipts[index]
        if (!completedPrefixEntryMatchesActivePlan({
            attemptId: node.completedWriterStageAttemptId,
            entry,
            index,
            node,
            plan
        }) ||
            !terminalReceiptMatchesPrefixEntry(
                receipt,
                entry
            )) {
            fail('writer-stage-ledger-prefix-mismatch')
        }
    }
}

function firstOrAuthorizedRetrySlice(node, plan, slice, compiledPrompt) {
    if (node.expectedNextSliceDigest) {
        if (node.expectedNextPlanDigest !== plan.planDigest ||
            node.expectedNextSliceId !== slice.sliceId ||
            node.expectedNextSliceDigest !== slice.sliceDigest ||
            node.expectedNextCompiledPromptDigest !==
                compiledPrompt.promptDigest ||
            plan.orderedSlices?.[
                node.completedSlicePrefix.length
            ]?.sliceId !== slice.sliceId) {
            fail('writer-stage-next-slice-mismatch')
        }
        return
    }
    const first = plan.orderedSlices?.[0]
    if (!first ||
        first.sliceId !== slice.sliceId ||
        slice.order !== 1 ||
        slice.prerequisiteSliceIds?.length !== 0) {
        fail('writer-stage-first-slice-required')
    }
}

function validateWriterDispatchBinding(
    event,
    node,
    payload,
    dispatchReceipt,
    context
) {
    const binding = validateWriterArtifactBinding({
        context,
        event,
        node,
        payload
    })
    const { compiledPrompt, plan, slice } = binding
    if (dispatchReceipt.runId !== plan.runId ||
        dispatchReceipt.nodeId !== plan.node ||
        dispatchReceipt.attemptId !== event.attemptId ||
        dispatchReceipt.epochId !== plan.epochId ||
        dispatchReceipt.baseSha !== plan.baseSha ||
        dispatchReceipt.planDigest !== plan.planDigest ||
        dispatchReceipt.sliceDigest !== slice.sliceDigest ||
        dispatchReceipt.compiledPromptDigest !==
            compiledPrompt.promptDigest ||
        dispatchReceipt.stageRole !== plan.stageRole ||
        dispatchReceipt.stagePhase !== plan.stagePhase ||
        event.actorRole !== plan.stageRole ||
        typeof payload.actorId !== 'string' ||
        !payload.actorId.trim()) {
        fail('dispatch-receipt-replay')
    }
    firstOrAuthorizedRetrySlice(
        node,
        plan,
        slice,
        compiledPrompt
    )
    return binding
}

function isV1Receipt(item) {
    return typeof item?.schema === 'string' && item.schema.endsWith('.v1')
}

function historicalEventUsesV2Semantics(event, context) {
    const payload = event.payload ?? {}
    if (context.transitionSchema === 'issue-orchestration.transition.v2' ||
        event.schema === 'issue-orchestration.event.v2' ||
        payload.transitionSchema === 'issue-orchestration.transition.v2') {
        return true
    }
    return [payload.dispatchReceipt, payload.selfTestReceipt, payload.behaviorReceipt,
        payload.uxAcceptanceReceipt, payload.receipt]
        .some((item) => typeof item?.schema === 'string' && item.schema.endsWith('.v2'))
}

function usesV2Semantics(event, context) {
    return context.mode === 'active-v2' ||
        historicalEventUsesV2Semantics(event, context)
}

function requireV2Receipt(item, schema, missingCode) {
    if (isV1Receipt(item)) fail('receipt-v1-historical-only')
    if (item?.schema !== schema) fail('receipt-schema-stage-mismatch')
    if (item.verificationStatus !== 'verified' || !receiptDigestValid(item)) {
        fail(missingCode)
    }
    return item
}

function transitionReceipt(event, field) {
    return event.payload?.[field] ?? receipt(event)
}

function validateV2Special(event, node, context) {
    const payload = event.payload ?? {}
    if (event.eventType === 'test-contract.started' ||
        event.eventType === 'documentation.started') {
        const dispatchReceipt = payload.dispatchReceipt
        requireV2Receipt(
            dispatchReceipt,
            'issue-orchestration.dispatch-receipt.v2',
            'verified-dispatch-receipt-required'
        )
        const expectedRole = event.eventType === 'test-contract.started'
            ? 'test-owner'
            : 'documentation-writer'
        const expectedPhase = event.eventType === 'test-contract.started'
            ? 'test-contract'
            : 'documentation'
        if (dispatchReceipt.attemptId !== event.attemptId ||
            dispatchReceipt.baseSha !== event.baseSha ||
            dispatchReceipt.nodeId !== event.nodeId ||
            dispatchReceipt.stageRole !== expectedRole ||
            dispatchReceipt.stagePhase !== expectedPhase ||
            event.actorRole !== expectedRole ||
            !dispatchReceipt.planDigest ||
            !dispatchReceipt.sliceDigest ||
            !dispatchReceipt.compiledPromptDigest) {
            fail('dispatch-receipt-replay')
        }
        validateWriterDispatchBinding(
            event,
            node,
            payload,
            dispatchReceipt,
            context
        )
        if (node.expectedNextSliceDigest &&
            dispatchReceipt.sliceDigest !== node.expectedNextSliceDigest) {
            fail('writer-stage-next-slice-mismatch')
        }
    }
    if (event.eventType === 'implementation.started') {
        const dispatchReceipt = payload.dispatchReceipt
        requireV2Receipt(
            dispatchReceipt,
            'issue-orchestration.dispatch-receipt.v2',
            'verified-dispatch-receipt-required'
        )
        if (dispatchReceipt.attemptId !== event.attemptId ||
            dispatchReceipt.baseSha !== event.baseSha ||
            dispatchReceipt.nodeId !== event.nodeId ||
            event.actorRole !== dispatchReceipt.stageRole) {
            fail('dispatch-receipt-replay')
        }
        validateWriterDispatchBinding(
            event,
            node,
            payload,
            dispatchReceipt,
            context
        )
        const landing =
            dispatchReceipt.stagePhase ===
                'landing-conflict-resolution'
        if (landing
            ? event.fromState !== 'delivery-ready' ||
                event.toState !== 'delivering'
            : !['implementation', 'ui-implementation'].includes(
                dispatchReceipt.stagePhase
            ) ||
                !['test-contract-frozen',
                    'implementing-self-testing']
                    .includes(event.fromState) ||
                event.toState !== 'implementing-self-testing') {
            fail('writer-stage-phase-start-state')
        }
        if (node.expectedNextSliceDigest &&
            dispatchReceipt.sliceDigest !== node.expectedNextSliceDigest) {
            fail('writer-stage-next-slice-mismatch')
        }
    }
    if (event.eventType === 'implementation.candidate-green') {
        const selfTestReceipt = transitionReceipt(event, 'selfTestReceipt')
        requireV2Receipt(
            selfTestReceipt,
            'issue-orchestration.implementer-self-test-receipt.v2',
            'verified-self-test-receipt-required'
        )
        if (selfTestReceipt.candidateSha !== payload.candidateSha ||
            selfTestReceipt.baseSha !== event.baseSha ||
            selfTestReceipt.attemptId !== event.attemptId ||
            selfTestReceipt.remainingFailures?.length ||
            selfTestReceipt.frozenTestTreeDigestBefore !==
                selfTestReceipt.frozenTestTreeDigestAfter ||
            (selfTestReceipt.modifiedPaths ?? []).some((entry) =>
                entry.startsWith('tests/')) ||
            !['implementation', 'ui-implementation'].includes(
                node.activeStagePhase
            ) ||
            selfTestReceipt.stagePhase !== node.activeStagePhase ||
            selfTestReceipt.planDigest !== node.activePlanDigest ||
            selfTestReceipt.sliceDigest !== node.activeSliceDigest) {
            fail('candidate-tests-not-green')
        }
        const [expectedRole] =
            ACTIVE_WRITER_ROLES_BY_PHASE[node.activeStagePhase] ?? []
        if (event.actorRole !== expectedRole ||
            node.activeStageRole !== expectedRole ||
            selfTestReceipt.stageRole !== expectedRole) {
            fail('candidate-actor-authority')
        }
        if (node.activeSliceDigest) {
            let gate
            try {
                gate = evaluateSliceTerminalGate(
                    terminalGateArguments({
                        context,
                        node,
                        payload
                    })
                )
            } catch {
                fail('writer-stage-terminal-gate-required')
            }
            validateCanonicalWriterCheckpoint({
                checkpoint: payload.currentCheckpoint,
                compiledPrompt: payload.compiledPrompt,
                context,
                event,
                node,
                plan: payload.stageWorkPlan,
                slice: payload.currentSlice,
                verificationReceipt:
                    payload.checkpointVerificationReceipt
            })
            validateCompletedSlicePrefix(node, payload)
            if (gate.nextState !== 'candidate-green' ||
                gate.candidateEligible !== true ||
                payload.stageWorkPlan?.planDigest !==
                    node.activePlanDigest ||
                payload.currentSlice?.sliceDigest !==
                    node.activeSliceDigest ||
                node.writerStageTerminalReceiptDigest !==
                    gate.terminalReceipt.receiptDigest) {
                fail('writer-stage-terminal-gate-required')
            }
        }
    }
    if (event.eventType === 'independent-verification.passed') {
        const behaviorReceipt = transitionReceipt(event, 'behaviorReceipt')
        requireV2Receipt(
            behaviorReceipt,
            'issue-orchestration.behavior-receipt.v2',
            'independent-behavior-receipt-required'
        )
        if (behaviorReceipt.stageRole !== 'test-owner' ||
            behaviorReceipt.readOnly !== true ||
            behaviorReceipt.freshVerificationRollout !== true ||
            event.actorRole !== 'test-owner') {
            fail('independent-verifier-freshness-required')
        }
        if (behaviorReceipt.candidateSha !== payload.candidateSha ||
            behaviorReceipt.candidateSha !== node.candidateSha) {
            fail('candidate-identity-mismatch')
        }
    }
    if (event.eventType === 'ux-acceptance.accepted') {
        const uxReceipt = transitionReceipt(event, 'uxAcceptanceReceipt')
        requireV2Receipt(
            uxReceipt,
            'issue-orchestration.ux-acceptance-receipt.v2',
            'independent-ux-receipt-required'
        )
        if (uxReceipt.readOnly !== true || uxReceipt.freshVerificationRollout !== true) {
            fail('independent-verifier-freshness-required')
        }
        if (event.actorRole !== 'ux-acceptance-verifier') fail('event-actor-authority')
    }
    if (event.eventType === 'documentation.started') {
        const behaviorReceipt = payload.behaviorReceipt
        requireV2Receipt(
            behaviorReceipt,
            'issue-orchestration.behavior-receipt.v2',
            'documentation-before-behavior-green'
        )
        if (node.issueKind === 'ui-ux') {
            requireV2Receipt(
                payload.uxAcceptanceReceipt,
                'issue-orchestration.ux-acceptance-receipt.v2',
                'documentation-before-ux-accepted'
            )
        }
    }
    if (event.eventType === 'writer-stage.checkpoint-recorded') {
        const checkpoint = payload.checkpoint
        const binding = validateWriterArtifactBinding({
            checkpoint,
            context,
            event,
            node,
            payload
        })
        validateCanonicalWriterCheckpoint({
            checkpoint,
            compiledPrompt: binding.compiledPrompt,
            context,
            event,
            node,
            plan: binding.plan,
            slice: binding.slice,
            verificationReceipt:
                payload.checkpointVerificationReceipt
        })
        if (event.fromState !== event.toState) {
            fail('writer-stage-checkpoint-transition')
        }
    }
    if (event.eventType === 'writer-stage.continuation-recorded') {
        const continuation = payload.continuationReceipt
        const binding = validateWriterArtifactBinding({
            checkpoint: payload.checkpoint,
            checkpointMustBeRecorded: true,
            context,
            event,
            node,
            payload
        })
        validateCanonicalWriterCheckpoint({
            checkpoint: payload.checkpoint,
            compiledPrompt: binding.compiledPrompt,
            context,
            event,
            node,
            plan: binding.plan,
            slice: binding.slice,
            verificationReceipt:
                payload.checkpointVerificationReceipt
        })
        let expectedContinuation
        try {
            const verificationReceipt =
                payload.checkpointVerificationReceipt
            expectedContinuation = compileSealedContinuation({
                plan: binding.plan,
                slice: binding.slice,
                compiledPrompt: binding.compiledPrompt,
                checkpoint: payload.checkpoint,
                checkpointVerificationReceiptDigest:
                    verificationReceipt.receiptDigest,
                checkpointOrdinal:
                    verificationReceipt.checkpointOrdinal,
                previousCheckpointDigest:
                    verificationReceipt.previousCheckpointDigest,
                previousCheckpointVerificationReceiptDigest:
                    verificationReceipt
                        .previousCheckpointVerificationReceiptDigest,
                previousMachineTracePrefixDigest:
                    verificationReceipt
                        .previousMachineTracePrefixDigest,
                previousMachineTracePrefixByteLength:
                    verificationReceipt
                        .previousMachineTracePrefixByteLength,
                machineTracePrefixDigest:
                    verificationReceipt.machineTracePrefixDigest,
                machineTracePrefixByteLength:
                    verificationReceipt.machineTracePrefixByteLength,
                completedSlicePrefixDigest:
                    verificationReceipt.completedSlicePrefixDigest,
                acceptedPriorChangedPathsDigest:
                    verificationReceipt
                        .acceptedPriorChangedPathsDigest,
                authority: sealedAuthorityAnchorFromLedger(
                    binding.plan,
                    context
                )
            })
        } catch {
            fail('writer-stage-continuation-rejected')
        }
        if (continuation?.schema !==
            'issue-orchestration.stage-continuation-receipt.v1' ||
            continuation.sliceDigest !== node.activeSliceDigest ||
            continuation.sliceId !== node.activeSliceId ||
            continuation.checkpointDigest !== node.latestCheckpointDigest ||
            continuation.restartInvestigation !== false ||
            !receiptDigestValid(continuation) ||
            expectedContinuation.receiptDigest !==
                continuation.receiptDigest) {
            fail('writer-stage-continuation-rejected')
        }
        if (event.fromState !== event.toState) {
            fail('writer-stage-continuation-transition')
        }
    }
    if ((event.eventType.startsWith('writer-stage.') &&
        event.eventType.endsWith('-failed')) ||
        ['writer-stage.runtime-capability-missing',
            'writer-stage.first-action-not-executed',
            'writer-stage.output-missing',
            'writer-stage.checkpoint-missing',
            'writer-stage.receipt-rejected'].includes(event.eventType)) {
        const failure = payload.failureReceipt ?? payload.receipt
        const observation = payload.writerStageObservation
        if (failure?.authorityStatus !== 'active-writer' ||
            observation?.stageRole === 'landing-owner') {
            fail('writer-stage-active-authority-required')
        }
        if (!Object.hasOwn(payload, 'currentCheckpoint') ||
            !Object.hasOwn(observation ?? {}, 'checkpoint')) {
            fail('writer-stage-current-checkpoint-mismatch')
        }
        const binding = validateWriterArtifactBinding({
            checkpoint: payload.currentCheckpoint,
            checkpointMustBeRecorded: true,
            context,
            event,
            node,
            payload
        })
        let evaluatedFailure
        try {
            evaluatedFailure = evaluateWriterStageObservation(
                observation
            )
        } catch {
            fail('writer-stage-failure-observation-rejected')
        }
        if (failure?.schema !==
            'issue-orchestration.writer-stage-failure-receipt.v1' ||
            failure.status !== 'terminal' ||
            failure.eventType !== event.eventType ||
            failure.runId !== binding.plan.runId ||
            failure.repository !== binding.plan.repository ||
            failure.issue !== binding.plan.issue ||
            failure.node !== binding.plan.node ||
            failure.baseSha !== binding.plan.baseSha ||
            failure.epochId !== binding.plan.epochId ||
            failure.worktreeIdentity !==
                binding.plan.worktreeIdentity ||
            failure.planDigest !== binding.plan.planDigest ||
            failure.sliceDigest !== node.activeSliceDigest ||
            failure.sliceId !== node.activeSliceId ||
            failure.compiledPromptDigest !==
                binding.compiledPrompt.promptDigest ||
            failure.routeDigest !==
                binding.plan.routingInputDigest ||
            failure.stageRole !== binding.plan.stageRole ||
            failure.stagePhase !== binding.plan.stagePhase ||
            failure.attemptId !== event.attemptId ||
            failure.agentId !== node.activeWriterAgentId ||
            observation.runId !== binding.plan.runId ||
            observation.repository !== binding.plan.repository ||
            observation.issue !== binding.plan.issue ||
            observation.node !== binding.plan.node ||
            observation.baseSha !== binding.plan.baseSha ||
            observation.epochId !== binding.plan.epochId ||
            observation.worktreeIdentity !==
                binding.plan.worktreeIdentity ||
            observation.planDigest !== binding.plan.planDigest ||
            observation.sliceId !== binding.slice.sliceId ||
            observation.sliceDigest !== binding.slice.sliceDigest ||
            observation.compiledPromptDigest !==
                binding.compiledPrompt.promptDigest ||
            observation.routeDigest !==
                binding.plan.routingInputDigest ||
            observation.stageRole !== binding.plan.stageRole ||
            observation.stagePhase !== binding.plan.stagePhase ||
            observation.attemptId !== event.attemptId ||
            observation.agentId !== node.activeWriterAgentId ||
            !sameValue(observation.checkpoint ?? null,
                payload.currentCheckpoint ?? null) ||
            failure.breakerOpen !== true ||
            !receiptDigestValid(failure) ||
            payload.countsAsImplementationRework === true ||
            payload.reworkCountDelta > 0 ||
            payload.triggersHumanDecision === true ||
            event.toState === 'human-decision-required' ||
            evaluatedFailure.status !== 'failed' ||
            evaluatedFailure.eventType !== event.eventType ||
            evaluatedFailure.failureReceipt.receiptDigest !==
                failure.receiptDigest) {
            fail('writer-stage-failure-receipt-rejected')
        }
    }
    if (event.eventType === 'writer-stage.retry-authorized') {
        const authorization = payload.retryAuthorization
        if (!sameValue(
            payload.proposedRetry?.completedSlicePrefix ?? [],
            node.completedSlicePrefix
        )) {
            fail('writer-stage-retry-prefix-forgery')
        }
        let expectedAuthorization
        const sealedAuthority =
            sealedAuthorityAnchorFromLedger(
                payload.proposedRetry?.stageWorkPlan,
                context
            )
        if (context.liveAppendEventId === event.eventId) {
            try {
                expectedAuthorization = authorizeWriterStageRetry({
                    priorFailure: payload.priorFailureReceipt,
                    proposed: payload.proposedRetry,
                    revisions: payload.revisions,
                    sourceFailureEvent: payload.sourceFailureEvent,
                    resourceCleanupReceipt:
                        payload.resourceCleanupReceipt
                })
            } catch {
                fail('writer-stage-retry-authorization-rejected')
            }
        } else {
            const retryErrors =
                validateSealedWriterStageRetryAuthorization({
                    authorization,
                    completedSlicePrefix:
                        node.completedSlicePrefix,
                    priorFailure:
                        payload.priorFailureReceipt,
                    proposed: payload.proposedRetry,
                    resourceCleanupReceipt:
                        payload.resourceCleanupReceipt,
                    revisions: payload.revisions,
                    sealedAuthority,
                    sourceFailureEvent:
                        payload.sourceFailureEvent
                })
            if (retryErrors.length) {
                fail('writer-stage-retry-authorization-rejected')
            }
            expectedAuthorization = authorization
        }
        let sourceFailureEvent
        try {
            sourceFailureEvent = context.eventsById.get(
                authorization?.sourceFailureEventId
            )
            verifyCleanupReceipt(payload.resourceCleanupReceipt)
        } catch {
            fail('writer-stage-retry-resource-disposition')
        }
        if (authorization?.schema !==
            'issue-orchestration.writer-stage-retry-authorization.v1' ||
            authorization.verificationStatus !== 'verified' ||
            event.actorRole !== 'root-scheduler' ||
            event.attemptId !== null ||
            !sourceFailureEvent ||
            sourceFailureEvent.eventDigest !==
                authorization.sourceFailureEventDigest ||
            !sameValue(
                sourceFailureEvent,
                payload.sourceFailureEvent
            ) ||
            payload.priorFailureReceipt?.authorityStatus !==
                'active-writer' ||
            payload.priorFailureReceipt?.planDigest !==
                node.activePlanDigest ||
            payload.priorFailureReceipt?.sliceDigest !==
                node.activeSliceDigest ||
            payload.priorFailureReceipt?.compiledPromptDigest !==
                node.activeCompiledPromptDigest ||
            payload.priorFailureReceipt?.stageRole !==
                node.activeStageRole ||
            payload.priorFailureReceipt?.stagePhase !==
                node.activeStagePhase ||
            payload.priorFailureReceipt?.agentId !==
                node.activeWriterAgentId ||
            authorization.priorFailureReceiptDigest !==
                node.writerStageFailureReceiptDigest ||
            authorization.semanticFailureDigest !==
                node.writerStageSemanticFailureDigest ||
            authorization.nextPlanDigest !==
                payload.proposedRetry?.stageWorkPlan?.planDigest ||
            authorization.nextSliceId !==
                payload.proposedRetry?.executableSlice?.sliceId ||
            authorization.nextSliceDigest !==
                payload.proposedRetry?.executableSlice?.sliceDigest ||
            authorization.nextCompiledPromptDigest !==
                payload.proposedRetry?.compiledPrompt?.promptDigest ||
            authorization.resourceCleanupReceiptDigest !==
                payload.resourceCleanupReceipt?.receiptDigest ||
            authorization.carryForwardPrefixDigest !==
                authorization.carryForwardPrefix?.receiptDigest ||
            !receiptDigestValid(
                authorization.carryForwardPrefix
            ) ||
            authorization.carryForwardPrefix
                ?.previousPrefixDigest !==
                digest(node.completedSlicePrefix) ||
            authorization.carryForwardPrefix
                ?.currentPlanDigest !==
                payload.proposedRetry?.stageWorkPlan?.planDigest ||
            authorization.carryForwardPrefix
                ?.currentStageAttemptId !==
                payload.proposedRetry?.stageWorkPlan
                    ?.stageAttemptId ||
            authorization.carryForwardPrefix?.entries?.length !==
                node.completedSlicePrefix.length ||
            payload.resourceCleanupReceipt?.runId !==
                payload.priorFailureReceipt?.runId ||
            payload.resourceCleanupReceipt?.attemptId !==
                payload.priorFailureReceipt?.attemptId ||
            payload.resourceCleanupReceipt?.epochId !==
                payload.priorFailureReceipt?.epochId ||
            authorization.authorized !== true ||
            authorization.breakerOpen !== false ||
            !receiptDigestValid(authorization) ||
            expectedAuthorization.authorized !== true ||
            expectedAuthorization.receiptDigest !==
                authorization.receiptDigest) {
            fail('writer-stage-retry-authorization-rejected')
        }
        const expectedResumeState = payload.priorFailureReceipt.stagePhase ===
            'test-contract'
            ? 'discovered'
            : payload.priorFailureReceipt.stagePhase === 'documentation'
                ? node.issueKind === 'ui-ux'
                    ? 'ux-accepted'
                    : 'behavior-green'
            : payload.priorFailureReceipt.stagePhase ===
                    'landing-conflict-resolution'
                ? 'delivery-ready'
                : 'test-contract-frozen'
        if (event.toState !== expectedResumeState) {
            fail('writer-stage-retry-resume-state')
        }
    }
    if (event.eventType === 'writer-stage.completed') {
        const terminal = payload.terminalReceipt
        let gate
        try {
            gate = evaluateSliceTerminalGate(
                terminalGateArguments({
                    context,
                    node,
                    payload
                })
            )
        } catch {
            fail('writer-stage-terminal-gate-required')
        }
        const binding = validateWriterArtifactBinding({
            checkpoint: payload.currentCheckpoint,
            checkpointMustBeRecorded: true,
            context,
            event,
            node,
            payload
        })
        if (payload.currentCheckpoint) {
            validateCanonicalWriterCheckpoint({
                checkpoint: payload.currentCheckpoint,
                compiledPrompt: binding.compiledPrompt,
                context,
                event,
                node,
                plan: binding.plan,
                slice: binding.slice,
                verificationReceipt:
                    payload.checkpointVerificationReceipt
            })
        }
        validateLedgerOwnedSlicePrefix({
            event,
            node,
            payload,
            terminal
        })
        if (terminal?.schema !==
            'issue-orchestration.slice-terminal-receipt.v1' ||
            terminal.sliceDigest !== node.activeSliceDigest ||
            terminal.sliceId !== node.activeSliceId ||
            terminal.outcome !== 'completed' ||
            terminal.stageComplete !== true ||
            terminal.candidateEligible !== true ||
            !receiptDigestValid(terminal) ||
            payload.sliceTerminalReceipts.length !==
                payload.stageWorkPlan.orderedSlices.length ||
            gate.nextState !== 'candidate-green' ||
            gate.terminalReceipt.receiptDigest !== terminal.receiptDigest ||
            event.fromState !== event.toState) {
            fail('writer-stage-terminal-receipt-rejected')
        }
    }
    if (event.eventType === 'writer-stage.slice-completed') {
        const terminal = payload.terminalReceipt
        const nextSlice = payload.nextSlice
        let gate
        try {
            gate = evaluateSliceTerminalGate(
                terminalGateArguments({
                    context,
                    node,
                    payload
                })
            )
        } catch {
            fail('writer-stage-next-slice-rejected')
        }
        const binding = validateWriterArtifactBinding({
            checkpoint: payload.currentCheckpoint,
            checkpointMustBeRecorded: true,
            context,
            event,
            node,
            payload
        })
        validateCanonicalWriterCheckpoint({
            checkpoint: payload.currentCheckpoint,
            compiledPrompt: binding.compiledPrompt,
            context,
            event,
            node,
            plan: binding.plan,
            slice: binding.slice,
            verificationReceipt:
                payload.checkpointVerificationReceipt
        })
        validateLedgerOwnedSlicePrefix({
            event,
            node,
            payload,
            terminal
        })
        validateAtomicNextSlice({
            event,
            node,
            payload,
            nextSlice
        })
        if (terminal?.schema !==
            'issue-orchestration.slice-terminal-receipt.v1' ||
            terminal.sliceDigest !== node.activeSliceDigest ||
            terminal.sliceId !== node.activeSliceId ||
            terminal.outcome !== 'completed' ||
            terminal.stageComplete !== false ||
            terminal.candidateEligible !== false ||
            !receiptDigestValid(terminal) ||
            nextSlice?.schema !==
                'issue-orchestration.executable-slice.v1' ||
            terminal.nextSliceId !== nextSlice.sliceId ||
            !/^[a-f0-9]{64}$/u.test(nextSlice.sliceDigest ?? '') ||
            nextSlice.planDigest !== node.activePlanDigest ||
            !nextSlice.prerequisiteSliceIds?.includes(node.activeSliceId) ||
            gate.nextState !== 'next-slice' ||
            gate.terminalReceipt.receiptDigest !== terminal.receiptDigest ||
            gate.nextSlice.sliceDigest !== nextSlice.sliceDigest ||
            event.fromState !== event.toState) {
            fail('writer-stage-next-slice-rejected')
        }
    }
    if (['test-contract.frozen', 'documentation.passed']
        .includes(event.eventType) && node.activeSliceDigest) {
        let gate
        try {
            gate = evaluateSliceTerminalGate(
                terminalGateArguments({
                    context,
                    node,
                    payload
                })
            )
        } catch {
            fail('writer-stage-terminal-gate-required')
        }
        validateCanonicalWriterCheckpoint({
            checkpoint: payload.currentCheckpoint,
            compiledPrompt: payload.compiledPrompt,
            context,
            event,
            node,
            plan: payload.stageWorkPlan,
            slice: payload.currentSlice,
            verificationReceipt:
                payload.checkpointVerificationReceipt
        })
        validateCompletedSlicePrefix(node, payload)
        if (gate.nextState !== 'candidate-green' ||
            gate.candidateEligible !== true ||
            node.writerStageTerminalReceiptDigest !==
                gate.terminalReceipt.receiptDigest) {
            fail('writer-stage-terminal-gate-required')
        }
    }
}

function validateV2Receipt(event) {
    if (event.eventType !== 'implementation.candidate-green') return
    const item = transitionReceipt(event, 'selfTestReceipt')
    if (item?.verificationStatus !== 'verified' ||
        !Array.isArray(item.commandResults) ||
        item.commandResults.some((entry) => entry.exitStatus !== 0 || entry.skipped) ||
        !Array.isArray(item.remainingFailures) || item.remainingFailures.length) {
        fail('candidate-tests-not-green')
    }
}

function validateReceipt(event, node, context) {
    if (usesV2Semantics(event, context)) {
        validateV2Receipt(event)
        return
    }
    const item = receipt(event)
    if (event.eventType === 'implementation.candidate-green') {
        if (!event.payload?.candidateSha || !item?.candidateSha) fail('candidate-identity-missing')
        if (item.status !== 'passed') fail('candidate-tests-not-green')
        if (item.visibleMatrixComplete !== true) fail('candidate-visible-matrix-incomplete')
        if ((item.modifiedPaths ?? []).some((entry) => entry.startsWith('tests/'))) {
            fail('frozen-test-contract-modified')
        }
        if (!Array.isArray(item.selfTestCycles) || item.selfTestCycles.length === 0 ||
            item.selfTestCycles.at(-1)?.outcome !== 'passed') {
            fail('candidate-tests-not-green')
        }
        if (typeof item.receiptDigest !== 'string') fail('verified-receipt-required')
        const unsigned = { ...item }
        delete unsigned.receiptDigest
        if (item.receiptDigest !== digest(unsigned)) fail('verified-receipt-digest')
    }
    if (event.eventType === 'independent-verification.passed') {
        if (event.actorRole !== 'test-owner') fail('event-actor-authority')
        if (item?.actorId === node.implementationOwnerActorId) fail('independent-verifier-required')
        if (item?.fresh !== true) fail('independent-verification-not-fresh')
        if (item?.candidateSha !== node.candidateSha || event.payload?.candidateSha !== node.candidateSha) {
            fail('candidate-identity-mismatch')
        }
    }
    if (event.eventType === 'cleanup.completed'
        && event.payload?.cleanupReceipt) {
        verifyCleanupReceipt(event.payload.cleanupReceipt)
    }
}

function initialNode() {
    return {
        status: 'none',
        activeAttemptId: null,
        reworkCount: 0,
        terminal: null,
        firstFailure: null,
        evidenceRefs: [],
        timestamps: {},
        deliveryAuthorized: false,
        semanticDagRecomputeRequired: false,
        issueKind: null,
        implementationOwnerActorId: null,
        implementationEffort: null,
        candidateSha: null,
        deliveryCompleted: false,
        cleanupCompleted: false,
        receiptContractRequired: false,
        activePlanDigest: null,
        activeSliceId: null,
        activeSliceDigest: null,
        activeCompiledPromptDigest: null,
        activeStageRole: null,
        activeStagePhase: null,
        activeWriterAgentId: null,
        completedWriterStageAttemptId: null,
        latestCheckpointDigest: null,
        latestContinuationReceiptDigest: null,
        latestCheckpointVerificationReceiptDigest: null,
        latestCheckpointTracePrefixDigest: null,
        latestCheckpointOrdinal: 0,
        latestMachineTracePrefixByteLength: null,
        writerStageFailureReceiptDigest: null,
        writerStageSemanticFailureDigest: null,
        writerStageRetryAuthorizationDigest: null,
        writerStageCarryForwardPrefix: null,
        writerStageTerminalReceiptDigest: null,
        completedSlicePrefix: [],
        expectedNextSliceId: null,
        expectedNextSliceDigest: null,
        expectedNextPlanDigest: null,
        expectedNextCompiledPromptDigest: null
    }
}

function firstFailure(node, event) {
    const supplied = event.payload?.firstFailure
    if (!supplied) return
    if (node.firstFailure && JSON.stringify(node.firstFailure) !== JSON.stringify(supplied)) {
        fail('first-failure-mismatch')
    }
    node.firstFailure ??= supplied
}

function resetWriterAttemptProjection(node, {
    preserveRetryLineage,
    preserveSlicePrefix
}) {
    node.terminal = null
    node.completedWriterStageAttemptId = null
    node.latestCheckpointDigest = null
    node.latestContinuationReceiptDigest = null
    node.latestCheckpointVerificationReceiptDigest = null
    node.latestCheckpointTracePrefixDigest = null
    node.latestCheckpointOrdinal = 0
    node.latestMachineTracePrefixByteLength = null
    node.writerStageFailureReceiptDigest = null
    node.writerStageSemanticFailureDigest = null
    node.writerStageTerminalReceiptDigest = null
    if (!preserveRetryLineage) {
        node.writerStageRetryAuthorizationDigest = null
        node.writerStageCarryForwardPrefix = null
    }
    if (!preserveSlicePrefix) node.completedSlicePrefix = []
    node.expectedNextSliceId = null
    node.expectedNextSliceDigest = null
    node.expectedNextPlanDigest = null
    node.expectedNextCompiledPromptDigest = null
}

function validateSpecial(event, node, context) {
    if (event.eventType.startsWith('writer-stage.') &&
        !usesV2Semantics(event, context)) {
        fail('receipt-v1-historical-only')
    }
    if (usesV2Semantics(event, context)) {
        validateV2Special(event, node, context)
        if (event.eventType === 'implementation.started') {
            if (context.attemptIds.has(event.attemptId)) fail('attempt-id-duplicate')
            if (node.status === 'implementing-self-testing' || node.activeAttemptId !== null) {
                fail('implementation-attempt-active')
            }
        }
        if (['test-contract.started', 'documentation.started']
            .includes(event.eventType)) {
            if (context.attemptIds.has(event.attemptId)) {
                fail('attempt-id-duplicate')
            }
            if (node.activeAttemptId !== null) {
                fail('implementation-attempt-active')
            }
        }
        if (event.eventType === 'implementation.candidate-green' &&
            event.attemptId !== (
                node.activeAttemptId ??
                node.completedWriterStageAttemptId
            )) {
            fail('candidate-attempt-mismatch')
        }
        if (event.eventType === 'independent-verification.passed' &&
            event.fromState === 'candidate-green') fail('transition-not-allowed')
        return
    }
    const { eventType: type, payload = {} } = event
    if (type === 'implementation.started') {
        const dispatchReceipt = payload.dispatchReceipt
        const unsignedDispatchReceipt = { ...dispatchReceipt }
        delete unsignedDispatchReceipt.receiptDigest
        if (node.receiptContractRequired && (
            dispatchReceipt?.schema !== 'issue-orchestration.dispatch-receipt.v1' ||
            dispatchReceipt?.verificationStatus !== 'verified' ||
            typeof dispatchReceipt?.receiptDigest !== 'string' ||
            dispatchReceipt.receiptDigest !== digest(unsignedDispatchReceipt)
        )) fail('verified-dispatch-receipt-required')
        if (context.attemptIds.has(event.attemptId)) fail('attempt-id-duplicate')
        if (node.status === 'implementing-self-testing' || node.activeAttemptId !== null) {
            fail('implementation-attempt-active')
        }
    }
    if (type === 'implementation.candidate-green') {
        if (node.receiptContractRequired &&
            receipt(event)?.schema !==
                'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-schema-stage-mismatch')
        }
        if (context.terminalAttempts.has(event.attemptId)) fail('attempt-terminal-conflict')
        if (!node.activeAttemptId || event.attemptId !== node.activeAttemptId) {
            fail('candidate-attempt-mismatch')
        }
        const expectedRole = node.issueKind === 'ui-ux' ? 'ui-ux-implementer' : 'code-implementer'
        if (event.actorRole !== expectedRole ||
            event.payload?.actorId !== node.implementationOwnerActorId ||
            receipt(event)?.actorId !== node.implementationOwnerActorId ||
            receipt(event)?.actorRole !== expectedRole) {
            fail('candidate-actor-authority')
        }
    }
    if (type === 'independent-verification.passed' && event.fromState === 'candidate-green') {
        fail('transition-not-allowed')
    }
    if (type === 'independent-verification.rejected') {
        if (payload.continuationAttemptId !== node.activeAttemptId) fail('attempt-continuation-invalid')
        if (payload.reworkCount !== node.reworkCount + 1) fail('rework-count-mismatch')
    }
    if (type === 'ux-acceptance.accepted' && (payload.modifiedPaths ?? []).length) {
        fail('ux-verifier-write-boundary')
    }
    if (type === 'ux-acceptance.rejected') {
        if (payload.implementationOwnerActorId !== node.implementationOwnerActorId) {
            fail('implementation-owner-mismatch')
        }
        if (payload.implementationEffort !== node.implementationEffort) fail('implementer-runtime-identity')
    }
    if (type === 'documentation.started') {
        if (node.issueKind === 'ui-ux' && node.status !== 'ux-accepted') {
            fail('documentation-before-ux-accepted')
        }
        if (node.issueKind !== 'ui-ux' && node.status !== 'behavior-green') {
            fail('documentation-before-behavior-green')
        }
    }
    if (type === 'delivery.started' && node.status !== 'delivery-ready') {
        if (node.issueKind === 'ui-ux' && node.status === 'behavior-green') fail('delivery-before-ux-accepted')
        fail('delivery-before-documentation-green')
    }
    if (type === 'issue.closed') {
        if (!node.deliveryCompleted) fail('delivery-not-completed')
        if (!node.cleanupCompleted) fail('cleanup-not-completed')
    }
    if (type === 'cleanup.failed' && payload.leaseReleased) fail('cleanup-lease-still-owned')
    if (type === 'ledger.correction-recorded') {
        const target = context.eventsById.get(payload.targetEventId)
        if (!target || target.eventDigest !== payload.targetEventDigest) fail('correction-target-missing')
    }
    if (type === 'node.terminal-entered') {
        if (!['externally_blocked', 'resource_failed', 'contract_disputed'].includes(payload.category)) {
            fail('terminal-category')
        }
        if (!Array.isArray(payload.directEvidence) || payload.directEvidence.length === 0) {
            fail('terminal-evidence')
        }
    }
    if (type === 'node.terminal-recovered' &&
        payload.recoveryFingerprint === payload.previousRecoveryFingerprint) {
        fail('terminal-recovery-unchanged')
    }
    if (type === 'dag.proposal-accepted') {
        if (event.actorRole !== 'dag-updater') fail('dag-proposal-authority')
        if (payload.trigger !== 'remote-live-snapshot-digest-changed' ||
            payload.currentRemoteSnapshotDigest === payload.previousRemoteSnapshotDigest) {
            fail('dag-proposal-trigger')
        }
    }
    if (type === 'route.reclassified') {
        validateRouteReclassification(payload.reclassification ?? payload)
    }
    if (['delivery.completed', 'cleanup.completed', 'group.member.committed'].includes(type)) {
        const key = payload.sideEffectKey ?? payload.deliveryId ?? payload.cleanupId ?? payload.commitSha
        if (key && context.sideEffects.has(`${type}:${key}`)) fail('side-effect-duplicate')
    }
}

function reduceNode(node, event, context) {
    validateSpecial(event, node, context)
    validateReceipt(event, node, context)
    firstFailure(node, event)
    const { eventType: type, payload = {} } = event
    if (type === 'node.discovered') node.issueKind = payload.issueKind
    if (type === 'test-contract.frozen') node.receiptContractRequired = true
    if (type === 'test-contract.started' ||
        type === 'documentation.started') {
        const dispatch = payload.dispatchReceipt
        if (dispatch?.schema === 'issue-orchestration.dispatch-receipt.v2') {
            const retryResume = node.expectedNextSliceDigest !== null
            context.attemptIds.add(event.attemptId)
            resetWriterAttemptProjection(node, {
                preserveRetryLineage: retryResume,
                preserveSlicePrefix: retryResume
            })
            node.activeAttemptId = event.attemptId
            node.activePlanDigest = dispatch.planDigest
            node.activeSliceId = payload.executableSlice?.sliceId ??
                dispatch.sliceId
            node.activeSliceDigest = dispatch.sliceDigest
            node.activeCompiledPromptDigest =
                dispatch.compiledPromptDigest
            node.activeStageRole = dispatch.stageRole
            node.activeStagePhase = dispatch.stagePhase
            node.activeWriterAgentId = payload.actorId
        }
    }
    if (type === 'implementation.started') {
        const retryResume = node.expectedNextSliceDigest !== null
        context.attemptIds.add(event.attemptId)
        resetWriterAttemptProjection(node, {
            preserveRetryLineage: retryResume,
            preserveSlicePrefix: retryResume
        })
        node.activeAttemptId = event.attemptId
        node.implementationOwnerActorId = payload.actorId
        node.implementationEffort = payload.effort
        const dispatch = payload.dispatchReceipt
        node.activePlanDigest = dispatch?.planDigest ?? null
        node.activeSliceId = payload.executableSlice?.sliceId ??
            dispatch?.sliceId ?? null
        node.activeSliceDigest = dispatch?.sliceDigest ?? null
        node.activeCompiledPromptDigest =
            dispatch?.compiledPromptDigest ?? null
        node.activeStageRole = dispatch?.stageRole ?? null
        node.activeStagePhase = dispatch?.stagePhase ?? null
        node.activeWriterAgentId = payload.actorId ?? null
    }
    if (type === 'implementation.candidate-green') node.candidateSha = payload.candidateSha
    if (type === 'test-contract.frozen' ||
        type === 'documentation.passed') {
        node.activeAttemptId = null
    }
    if (type === 'independent-verification.rejected') node.reworkCount = payload.reworkCount
    if (['attempt.cancelled', 'attempt.expired', 'attempt.invocation-failed',
        'attempt.environment-failed'].includes(type)) context.terminalAttempts.add(event.attemptId)
    if (type === 'writer-stage.checkpoint-recorded') {
        node.latestCheckpointDigest = payload.checkpoint.checkpointDigest
        node.latestCheckpointVerificationReceiptDigest =
            payload.checkpointVerificationReceipt.receiptDigest
        node.latestCheckpointTracePrefixDigest =
            payload.checkpointVerificationReceipt
                .machineTracePrefixDigest
        node.latestCheckpointOrdinal =
            payload.checkpointVerificationReceipt
                .checkpointOrdinal
        node.latestMachineTracePrefixByteLength =
            payload.checkpointVerificationReceipt
                .machineTracePrefixByteLength
        context.checkpointEvidenceByVerificationDigest.set(
            payload.checkpointVerificationReceipt.receiptDigest,
            {
                checkpointDigest:
                    payload.checkpoint.checkpointDigest,
                machineTraceSnapshot:
                    structuredClone(
                        payload.checkpoint.evidence
                            .machineRuntimeTrace
                            .traceSnapshot
                    )
            }
        )
    }
    if (type === 'writer-stage.continuation-recorded') {
        node.latestContinuationReceiptDigest =
            payload.continuationReceipt.receiptDigest
    }
    if (type.startsWith('writer-stage.') &&
        ['writer-stage.invocation-failed', 'writer-stage.environment-failed',
            'writer-stage.runtime-capability-missing',
            'writer-stage.first-action-not-executed',
            'writer-stage.output-missing',
            'writer-stage.checkpoint-missing',
            'writer-stage.receipt-rejected'].includes(type)) {
        const failure = payload.failureReceipt ?? payload.receipt
        node.writerStageFailureReceiptDigest = failure.receiptDigest
        node.writerStageSemanticFailureDigest =
            failure.semanticFailureDigest ?? null
        node.activeAttemptId = null
        node.terminal = {
            category: 'writer_stage_failure',
            directEvidence: [failure.receiptDigest],
            recoveryFingerprint: failure.semanticFailureDigest
        }
    }
    if (type === 'writer-stage.retry-authorized') {
        node.terminal = null
        node.activeAttemptId = null
        node.writerStageRetryAuthorizationDigest =
            payload.retryAuthorization.receiptDigest
        node.writerStageCarryForwardPrefix =
            structuredClone(
                payload.retryAuthorization
                    .carryForwardPrefix
            )
        node.expectedNextSliceDigest =
            payload.retryAuthorization.nextSliceDigest
        node.expectedNextSliceId =
            payload.retryAuthorization.nextSliceId
        node.expectedNextPlanDigest =
            payload.retryAuthorization.nextPlanDigest
        node.expectedNextCompiledPromptDigest =
            payload.retryAuthorization.nextCompiledPromptDigest
    }
    if (type === 'writer-stage.completed') {
        node.completedSlicePrefix.push(slicePrefixEntry({
            attemptId: event.attemptId,
            checkpoint: payload.currentCheckpoint,
            plan: payload.stageWorkPlan,
            slice: payload.currentSlice,
            terminal: payload.terminalReceipt,
            verificationReceipt:
                payload.checkpointVerificationReceipt
        }))
        node.activeAttemptId = null
        node.completedWriterStageAttemptId = event.attemptId
        node.writerStageTerminalReceiptDigest =
            payload.terminalReceipt.receiptDigest
        node.expectedNextSliceId = null
        node.expectedNextSliceDigest = null
        node.expectedNextPlanDigest = null
        node.expectedNextCompiledPromptDigest = null
    }
    if (type === 'writer-stage.slice-completed') {
        node.completedSlicePrefix.push(slicePrefixEntry({
            attemptId: event.attemptId,
            checkpoint: payload.currentCheckpoint,
            plan: payload.stageWorkPlan,
            slice: payload.currentSlice,
            terminal: payload.terminalReceipt,
            verificationReceipt:
                payload.checkpointVerificationReceipt
        }))
        node.writerStageTerminalReceiptDigest =
            payload.terminalReceipt.receiptDigest
        node.activeSliceId = payload.nextSlice.sliceId
        node.activeSliceDigest = payload.nextSlice.sliceDigest
        node.activeCompiledPromptDigest =
            payload.nextCompiledPrompt.promptDigest
        node.latestCheckpointDigest = null
        node.latestContinuationReceiptDigest = null
        node.latestCheckpointVerificationReceiptDigest = null
        node.latestCheckpointTracePrefixDigest = null
        node.latestCheckpointOrdinal = 0
        node.latestMachineTracePrefixByteLength = null
        node.expectedNextSliceId = payload.nextSlice.sliceId
        node.expectedNextSliceDigest = payload.nextSlice.sliceDigest
        node.expectedNextPlanDigest =
            payload.stageWorkPlan.planDigest
        node.expectedNextCompiledPromptDigest =
            payload.nextCompiledPrompt.promptDigest
    }
    if (type === 'delivery.completed') node.deliveryCompleted = true
    if (type === 'cleanup.completed') node.cleanupCompleted = true
    if (type === 'node.terminal-entered' || type === 'implementation.external-blocked') {
        node.terminal = {
            category: payload.category ?? 'externally_blocked',
            directEvidence: payload.directEvidence ?? event.evidenceRefs,
            recoveryFingerprint: payload.recoveryFingerprint
        }
    }
    if (type === 'node.terminal-recovered') node.terminal = null
    if (type === 'issue.reopened') {
        node.deliveryAuthorized = false
        node.semanticDagRecomputeRequired = true
        node.deliveryCompleted = false
        node.cleanupCompleted = false
    }
    if (type === 'delivery.ready-computed') node.deliveryAuthorized = true
    node.status = event.toState
    node.evidenceRefs = [...new Set([...node.evidenceRefs, ...(event.evidenceRefs ?? [])])]
    node.timestamps[event.eventType] = event.createdAt
}

function groupMember(group, memberId) {
    group.members[memberId] ??= {
        status: 'none', leaseId: null, candidateSha: null,
        behaviorGreen: false, committed: false, deliveryCompleted: false
    }
    return group.members[memberId]
}

function reduceGroup(projection, event, context) {
    const payload = event.payload ?? {}
    const groupId = payload.groupId
    projection.groups[groupId] ??= { status: 'none', members: {}, activeMembers: [] }
    const group = projection.groups[groupId]
    if (event.eventType.startsWith('group.session.')) {
        if (event.eventType === 'group.session.activated' && context.activatedGroups.has(groupId)) {
            fail('group-active-member-duplicate')
        }
        if (!permitted(transitionTable[event.eventType], group.status, event.toState)) {
            fail('group-transition-not-allowed')
        }
        group.status = event.toState
        if (event.eventType === 'group.session.activated') context.activatedGroups.add(groupId)
        return
    }
    const member = groupMember(group, payload.memberId)
    if (event.eventType === 'group.member.write-lease-granted') {
        const owner = context.leaseOwners.get(payload.leaseId)
        if (owner && owner !== payload.memberId) fail('group-lease-conflict')
        context.leaseOwners.set(payload.leaseId, payload.memberId)
        context.leases.set(payload.leaseId, payload.memberId)
        member.leaseId = payload.leaseId
        return
    }
    if (event.eventType === 'group.member.write-lease-revoked') {
        context.leases.delete(payload.leaseId)
        member.leaseId = null
        return
    }
    const required = {
        'group.member.test-contract-frozen': null,
        'group.member.candidate-created': null,
        'group.member.behavior-green': 'candidate-green',
        'group.member.committed': 'behavior-green',
        'group.member.delivery-completed': 'committed'
    }
    const expected = required[event.eventType]
    if (expected && member.status !== expected) fail('group-member-stage-order')
    if (event.eventType === 'group.member.committed' && member.status !== 'behavior-green') {
        fail('group-member-stage-order')
    }
    member.status = event.toState
    if (event.eventType === 'group.member.candidate-created') member.candidateSha = payload.candidateSha
    if (event.eventType === 'group.member.behavior-green') member.behaviorGreen = true
    if (event.eventType === 'group.member.committed') member.committed = true
    if (event.eventType === 'group.member.delivery-completed') member.deliveryCompleted = true
}

function replayLedger(
    ledger,
    mode,
    { liveAppendEventId = null } = {}
) {
    if (!ledger?.header || !Array.isArray(ledger.events)) fail('ledger-schema')
    if (mode === 'active-v2') {
        if (ledger.header.schema === 'issue-orchestration.ledger.v1') {
            fail('ledger-v1-historical-only')
        }
        if (ledger.header.schema !== 'issue-orchestration.ledger.v2' ||
            ledger.header.transitionSchema !==
                'issue-orchestration.transition.v2') {
            fail('ledger-v2-required')
        }
    } else if (ledger.header.schema !== 'issue-orchestration.ledger.v1') {
        fail('historical-ledger-v1-required')
    }
    const projection = {
        schema: mode === 'active-v2'
            ? 'issue-orchestration.projection.v2'
            : 'issue-orchestration.projection.v1',
        runId: ledger.header.runId,
        nodes: {},
        groups: {},
        corrections: [],
        dagProposals: [],
        routeReclassifications: [],
        lastSequence: 0,
        lastEventDigest: GENESIS
    }
    const context = {
        attemptIds: new Set(), terminalAttempts: new Set(), sideEffects: new Set(),
        eventsById: new Map(), leases: new Map(), leaseOwners: new Map(),
        activatedGroups: new Set(),
        checkpointEvidenceByVerificationDigest: new Map(),
        ledgerHeader: structuredClone(ledger.header),
        liveAppendEventId,
        mode,
        verifiedEvents: [],
        transitionSchema: mode === 'active-v2'
            ? 'issue-orchestration.transition.v2'
            : ledger.header.transitionSchema ?? null
    }
    let expectedDigest = GENESIS
    let primaryNodeId = null
    for (let index = 0; index < ledger.events.length; index += 1) {
        const event = ledger.events[index]
        if (!event || EVENT_FIELDS.some((field) => !Object.hasOwn(event, field))) fail('event-schema')
        if (mode === 'active-v2' &&
            event.schema !== 'issue-orchestration.event.v2') {
            fail('event-v2-required')
        }
        if (event.sequence !== index + 1) fail('ledger-sequence')
        if (context.eventsById.has(event.eventId)) fail('event-id-duplicate')
        if (event.runId !== ledger.header.runId) fail('event-run-id')
        if (event.baseSha !== ledger.header.baseSha) fail('event-base-sha')
        if (!event.eventType.startsWith('group.')) {
            primaryNodeId ??= event.nodeId
            if (event.nodeId !== primaryNodeId) fail('event-node-identity')
        }
        if (event.previousEventDigest !== expectedDigest) fail('ledger-hash-chain')
        if (event.payloadDigest !== digest(event.payload)) {
            if (index < ledger.events.length - 2) fail('ledger-hash-chain')
            fail('event-payload-digest')
        }
        const unsealed = { ...event }
        delete unsealed.eventDigest
        if (event.eventDigest !== digest(unsealed)) fail('event-digest')
        const rule = transitionTable[event.eventType]
        if (!rule) fail('event-type-unsupported')
        if (event.eventType.startsWith('group.')) {
            reduceGroup(projection, event, context)
        } else {
            const node = projection.nodes[event.nodeId] ??= initialNode()
            if (node.firstFailure && event.payload?.firstFailure &&
                JSON.stringify(node.firstFailure) !== JSON.stringify(event.payload.firstFailure)) {
                fail('first-failure-mismatch')
            }
            if (!permitted(rule, event.fromState, event.toState) || node.status !== event.fromState) {
                fail('transition-not-allowed')
            }
            reduceNode(node, event, context)
        }
        if (event.eventType === 'ledger.correction-recorded') projection.corrections.push(event.payload)
        if (event.eventType.startsWith('dag.proposal-')) projection.dagProposals.push(event.payload)
        if (event.eventType === 'route.reclassified') {
            projection.routeReclassifications.push(
                event.payload.reclassification ?? event.payload
            )
        }
        const sideEffectKey = event.payload?.sideEffectKey ?? event.payload?.deliveryId ??
            event.payload?.cleanupId ?? event.payload?.commitSha
        if (sideEffectKey && ['delivery.completed', 'cleanup.completed', 'group.member.committed'].includes(event.eventType)) {
            context.sideEffects.add(`${event.eventType}:${sideEffectKey}`)
        }
        context.eventsById.set(event.eventId, event)
        context.verifiedEvents.push(event)
        projection.lastSequence = event.sequence
        projection.lastEventDigest = event.eventDigest
        expectedDigest = event.eventDigest
    }
    projection.projectionDigest = digest(projection)
    return projection
}

export async function replayEventLedger(ledger) {
    return replayEventLedgerSync(ledger)
}

export function replayEventLedgerSync(ledger) {
    return replayLedger(ledger, 'active-v2')
}

export async function auditHistoricalEventLedger(ledger) {
    const projection = await replayLedger(ledger, 'historical-audit')
    return deepFreeze({
        schema: 'issue-orchestration.historical-ledger-audit.v1',
        mode: 'read-only-historical-audit',
        mutationAuthority: 'none',
        canAppend: false,
        canRecoverProjection: false,
        projection
    })
}

function assertExternalPaths({ ledgerPath, projectionPath, protectedRoots = [], stateRoot }) {
    const root = fs.realpathSync(stateRoot)
    for (const protectedRoot of protectedRoots) {
        const protectedReal = fs.realpathSync(protectedRoot)
        if (root === protectedReal || root.startsWith(`${protectedReal}${path.sep}`) ||
            protectedReal.startsWith(`${root}${path.sep}`)) fail('state-root-protected-overlap')
    }
    for (const file of [ledgerPath, projectionPath]) {
        const relative = path.relative(root, path.resolve(file))
        if (relative.startsWith('..') || path.isAbsolute(relative)) fail('state-root-protected-overlap')
        let current = root
        for (const part of relative.split(path.sep).slice(0, -1)) {
            current = path.join(current, part)
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('ledger-path-symlink')
        }
    }
}

export function canonicalEventLedgerLocation({
    nodeId,
    runId,
    stageAttemptId = 'event-ledger-authority'
} = {}) {
    const writerLocation = writerStageAuthorityLocation({
        runId,
        node: nodeId,
        stageAttemptId
    })
    const runRoot = path.dirname(writerLocation.sourceLedgerPath)
    return Object.freeze({
        stateRoot: path.dirname(path.dirname(runRoot)),
        ledgerPath: writerLocation.sourceLedgerPath,
        projectionPath: path.join(
            runRoot,
            'event-ledger-projection.json'
        ),
        runtimeStateRootDigest:
            writerLocation.runtimeStateRootDigest
    })
}

function assertCanonicalEventLedgerPaths(options, event = null) {
    const runId = event?.runId ?? options.runId
    const nodeId = event?.nodeId ?? options.nodeId
    const stageAttemptId = options.stageAttemptId ??
        event?.attemptId ??
        'event-ledger-authority'
    let expected
    try {
        expected = canonicalEventLedgerLocation({
            nodeId,
            runId,
            stageAttemptId
        })
    } catch {
        fail('event-ledger-authority-unavailable')
    }
    const actualStateRoot = fs.realpathSync(options.stateRoot)
    const expectedStateRoot = fs.realpathSync(expected.stateRoot)
    if (path.resolve(options.ledgerPath) !==
            path.resolve(expected.ledgerPath) ||
        path.resolve(options.projectionPath) !==
            path.resolve(expected.projectionPath) ||
        actualStateRoot !== expectedStateRoot) {
        fail('event-ledger-authority-path-mismatch')
    }
    return expected
}

function readLedger(ledgerPath) {
    const source = fs.readFileSync(ledgerPath, 'utf8')
    const lines = source.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const entries = []
    for (let index = 0; index < lines.length; index += 1) {
        try {
            entries.push(JSON.parse(lines[index]))
        } catch {
            fail('ledger-tail-corrupt', 'ledger tail is corrupt', {
                lastValidSequence: Math.max(0, entries.length - 1),
                dispatchEnabled: false
            })
        }
    }
    return { header: entries[0], events: entries.slice(1) }
}

function atomicWrite(file, source) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, source, { mode: 0o600 })
    const descriptor = fs.openSync(temporary, 'r')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    fs.renameSync(temporary, file)
}

export async function appendEventAtomic(options) {
    const { event, ledgerPath, projectionPath, writerRole } = options
    assertCanonicalEventLedgerPaths(options, event)
    assertExternalPaths(options)
    if (writerRole !== 'root-scheduler') fail('ledger-writer-role')
    if (event.eventType === 'independent-verification.started' &&
        !event.payload?.receipt && !event.payload?.proposalReceipt) {
        fail('verified-receipt-required')
    }
    const ledger = readLedger(ledgerPath)
    ledger.events.push(event)
    const projection = replayLedger(
        ledger,
        'active-v2',
        { liveAppendEventId: event.eventId }
    )
    fs.appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { flush: true })
    atomicWrite(projectionPath, `${JSON.stringify(projection, null, 2)}\n`)
    return { projection }
}

export async function recoverEventLedger(options) {
    assertCanonicalEventLedgerPaths(options)
    assertExternalPaths(options)
    const { ledgerPath, projectionPath } = options
    if (!fs.existsSync(ledgerPath)) {
        return { recoveryAction: 'ledger-absent', projection: null, repeatedSideEffects: [] }
    }
    const ledger = readLedger(ledgerPath)
    const projection = await replayEventLedger(ledger)
    let current = null
    if (fs.existsSync(projectionPath)) {
        try { current = JSON.parse(fs.readFileSync(projectionPath, 'utf8')) } catch { current = null }
    }
    let recoveryAction = 'replay-ledger-forward'
    if (current?.lastSequence > projection.lastSequence) recoveryAction = 'discard-projection-and-rebuild'
    else if (current?.projectionDigest === projection.projectionDigest) recoveryAction = 'projection-already-current'
    atomicWrite(projectionPath, `${JSON.stringify(projection, null, 2)}\n`)
    return { recoveryAction, projection, repeatedSideEffects: [] }
}

export async function validateDagProjection({ dag, projection }) {
    if (projection?.schema === 'issue-orchestration.projection.v1') {
        fail('projection-v1-historical-only')
    }
    if (projection?.schema !== 'issue-orchestration.projection.v2') {
        fail('projection-v2-required')
    }
    if (dag.runId !== projection.runId || dag.projectionDigest !== projection.projectionDigest) {
        fail('dag-projection-mismatch')
    }
    const expected = Object.entries(projection.nodes).map(([id, node]) => ({
        id,
        status: node.status,
        activeAttemptId: node.activeAttemptId ?? null,
        reworkCount: node.reworkCount,
        terminal: node.terminal ?? null,
        evidenceRefs: node.evidenceRefs,
        timestamps: node.timestamps
    }))
    if (JSON.stringify(dag.nodes) !== JSON.stringify(expected)) fail('dag-projection-mismatch')
    return true
}
