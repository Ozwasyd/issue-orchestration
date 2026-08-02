import { createHash } from 'node:crypto'
// Shared issue-orchestration package runtime.
import fs from 'node:fs'
import path from 'node:path'
import { verifyCleanupReceipt } from './resource-lifecycle.mjs'
import { validateRouteReclassification } from './stage-profile-policy.mjs'

const GENESIS = '0'.repeat(64)
const EVENT_FIELDS = [
    'eventId', 'sequence', 'runId', 'nodeId', 'eventType', 'fromState',
    'toState', 'attemptId', 'actorRole', 'sourceDagDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'baseSha',
    'payloadDigest', 'evidenceRefs', 'createdAt', 'previousEventDigest',
    'eventDigest'
]

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

const rules = {
    'node.discovered': [['none', 'discovered']],
    'test-contract.started': [['discovered', 'test-contracting']],
    'test-contract.frozen': [['test-contracting', 'test-contract-frozen']],
    'test-contract.disputed': [['test-contracting', 'discovered']],
    'implementation.started': [
        ['test-contract-frozen', 'implementing-self-testing'],
        ['implementing-self-testing', 'implementing-self-testing']
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

function isV1Receipt(item) {
    return typeof item?.schema === 'string' && item.schema.endsWith('.v1')
}

function isV2Transition(event, context) {
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

function validateV2Special(event, node) {
    const payload = event.payload ?? {}
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
                entry.startsWith('tests/'))) {
            fail('candidate-tests-not-green')
        }
        const expectedRole = node.issueKind === 'ui-ux'
            ? 'ui-ux-implementer'
            : 'code-implementer'
        if (event.actorRole !== expectedRole ||
            selfTestReceipt.stageRole !== expectedRole) {
            fail('candidate-actor-authority')
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
    if (isV2Transition(event, context)) {
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
        receiptContractRequired: false
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

function validateSpecial(event, node, context) {
    if (isV2Transition(event, context)) {
        validateV2Special(event, node)
        if (event.eventType === 'implementation.started') {
            if (context.attemptIds.has(event.attemptId)) fail('attempt-id-duplicate')
            if (node.status === 'implementing-self-testing' || node.activeAttemptId !== null) {
                fail('implementation-attempt-active')
            }
        }
        if (event.eventType === 'implementation.candidate-green' &&
            (!node.activeAttemptId || event.attemptId !== node.activeAttemptId)) {
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
    if (type === 'implementation.started') {
        context.attemptIds.add(event.attemptId)
        node.activeAttemptId = event.attemptId
        node.implementationOwnerActorId = payload.actorId
        node.implementationEffort = payload.effort
    }
    if (type === 'implementation.candidate-green') node.candidateSha = payload.candidateSha
    if (type === 'independent-verification.rejected') node.reworkCount = payload.reworkCount
    if (['attempt.cancelled', 'attempt.expired', 'attempt.invocation-failed',
        'attempt.environment-failed'].includes(type)) context.terminalAttempts.add(event.attemptId)
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

export async function replayEventLedger(ledger) {
    if (!ledger?.header || !Array.isArray(ledger.events)) fail('ledger-schema')
    const projection = {
        schema: 'issue-orchestration.projection.v1',
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
        transitionSchema: ledger.header.transitionSchema ??
            (ledger.header.schema === 'issue-orchestration.ledger.v2'
                ? 'issue-orchestration.transition.v2'
                : null)
    }
    let expectedDigest = GENESIS
    let primaryNodeId = null
    for (let index = 0; index < ledger.events.length; index += 1) {
        const event = ledger.events[index]
        if (!event || EVENT_FIELDS.some((field) => !Object.hasOwn(event, field))) fail('event-schema')
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
        projection.lastSequence = event.sequence
        projection.lastEventDigest = event.eventDigest
        expectedDigest = event.eventDigest
    }
    projection.projectionDigest = digest(projection)
    return projection
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
    assertExternalPaths(options)
    if (writerRole !== 'root-scheduler') fail('ledger-writer-role')
    if (event.eventType === 'independent-verification.started' &&
        !event.payload?.receipt && !event.payload?.proposalReceipt) {
        fail('verified-receipt-required')
    }
    const ledger = readLedger(ledgerPath)
    ledger.events.push(event)
    const projection = await replayEventLedger(ledger)
    fs.appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { flush: true })
    atomicWrite(projectionPath, `${JSON.stringify(projection, null, 2)}\n`)
    return { projection }
}

export async function recoverEventLedger(options) {
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
