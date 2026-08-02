import { createHash } from 'node:crypto'

import {
    validateCompiledDispatchPrompt
} from './executable-slice-compiler.mjs'
import {
    compileExecutionRoute
} from './execution-route-compiler.mjs'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u
const LANDING_SLICE_KINDS = new Set([
    'transplant-one-member-commit',
    'resolve-one-member-one-conflict-cluster',
    'rebind-one-member-evidence-class',
    'run-one-member-reverification-class',
    'finalize-one-source-retirement-disposition'
])
const HUMAN_AUTHORITY_REASONS = new Set([
    'multiple-legal-outcomes',
    'authority-missing',
    'irreversible-authority-choice'
])
const SOURCE_RETIREMENT_DISPOSITIONS = new Set([
    'source-retained',
    'source-retired'
])
const WORKTREE_DISPOSITIONS = new Set([
    'unaffected-other-repository',
    'source-retained',
    'clean-transplant-required',
    'already-applied-equivalent',
    'dirty-uncollected',
    'conflicted-invalid',
    'human-decision-pending',
    'transplanted-reverify-required',
    'landing-slice-continuation-pending',
    'landing-ready',
    'landed',
    'source-retired'
])

export class LandingLaneError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'LandingLaneError'
        this.code = code
    }
}

function fail(code, message = code) {
    throw new LandingLaneError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
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

function clone(value) {
    return structuredClone(value)
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function seal(value, digestField) {
    const body = clone(value)
    delete body[digestField]
    body[digestField] = digest(body)
    return deepFreeze(body)
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function isHash(value) {
    return HASH.test(value ?? '')
}

function isSha(value) {
    return SHA.test(value ?? '')
}

function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function verifySeal(value, digestField, code) {
    if (!isHash(value?.[digestField])) fail(code)
    const body = clone(value)
    const actual = body[digestField]
    delete body[digestField]
    if (digest(body) !== actual) fail(code)
}

function requireLane(lane) {
    if (lane?.schema !==
            'issue-orchestration.repository-landing-lane.v1') {
        fail('repository-landing-lane-invalid')
    }
    verifySeal(lane, 'laneDigest', 'repository-landing-lane-invalid')
    return lane
}

function attemptProjection(attempt) {
    const projection = clone(attempt)
    delete projection.eventLog
    delete projection.attemptDigest
    return projection
}

function eventBody(event) {
    const body = clone(event)
    delete body.eventDigest
    return body
}

function verifyEventLog(attempt) {
    let previousEventDigest = null
    for (const [index, event] of (attempt.eventLog ?? []).entries()) {
        if (event?.schema !== 'issue-orchestration.landing-event.v1' ||
            event.sequence !== index + 1 ||
            event.attemptId !== attempt.attemptId ||
            event.previousEventDigest !== previousEventDigest ||
            event.payloadDigest !== digest(event.payload) ||
            event.eventDigest !== digest(eventBody(event))) {
            fail('landing-attempt-event-log-invalid')
        }
        previousEventDigest = event.eventDigest
    }
    if (attempt.eventLog.length === 0 ||
        attempt.eventLog.at(-1).resultingProjectionDigest !==
            digest(attemptProjection(attempt))) {
        fail('landing-attempt-projection-invalid')
    }
}

function requireAttempt(attempt) {
    if (attempt?.schema !== 'issue-orchestration.landing-attempt.v1') {
        fail('landing-attempt-invalid')
    }
    verifySeal(attempt, 'attemptDigest', 'landing-attempt-invalid')
    verifyEventLog(attempt)
    return attempt
}

function appendAttemptEvent(attempt, eventType, payload, changes) {
    if (attempt !== null) requireAttempt(attempt)
    const previousProjection = attempt === null
        ? {}
        : attemptProjection(attempt)
    const nextProjection = {
        ...previousProjection,
        ...clone(changes)
    }
    const previousEvents = attempt?.eventLog ?? []
    const body = {
        schema: 'issue-orchestration.landing-event.v1',
        sequence: previousEvents.length + 1,
        attemptId: nextProjection.attemptId,
        eventType,
        payload: clone(payload),
        payloadDigest: digest(payload),
        previousEventDigest:
            previousEvents.at(-1)?.eventDigest ?? null,
        resultingProjectionDigest: digest(nextProjection)
    }
    const event = {
        ...body,
        eventDigest: digest(body)
    }
    return seal({
        ...nextProjection,
        eventLog: [...clone(previousEvents), event]
    }, 'attemptDigest')
}

function orderedMembers(handoff) {
    const mappingEntries = Object.entries(handoff.memberMapping ?? {})
    const byCommit = new Map(mappingEntries.map(([issueId, member]) => [
        member?.commitSha,
        issueId
    ]))
    const members = (handoff.orderedGreenCommitPrefix ?? [])
        .map((commitSha) => byCommit.get(commitSha))
    if (members.some((member) => !isText(member)) ||
        new Set(members).size !== members.length ||
        members.length !== mappingEntries.length) {
        fail('landing-source-member-mapping-invalid')
    }
    return members
}

function validateHandoff(handoff) {
    if (handoff?.schema !== 'issue-orchestration.landing-handoff.v1' ||
        handoff.disposition !== 'landing-handoff-required' ||
        !REPOSITORY.test(handoff.repository ?? '') ||
        !isText(handoff.sourceEpoch) ||
        !isSha(handoff.sourceBase) ||
        !isText(handoff.sourceWorktree) ||
        !isText(handoff.sourceBranch) ||
        !isSha(handoff.immutableSourceTip) ||
        !Array.isArray(handoff.orderedGreenCommitPrefix) ||
        handoff.orderedGreenCommitPrefix.length === 0 ||
        handoff.orderedGreenCommitPrefix.some((commit) => !isSha(commit)) ||
        !Array.isArray(handoff.requiredReverificationClasses) ||
        handoff.requiredReverificationClasses.some((item) => !isText(item)) ||
        !isHash(handoff.resourceRetentionReceiptDigest)) {
        fail('landing-handoff-invalid')
    }
    if (!Array.isArray(handoff.sourceHistoryOperations) ||
        handoff.sourceHistoryOperations.length !== 0) {
        fail('landing-source-history-mutated')
    }
    if ((handoff.dirtyInventory?.length ?? 0) !== 0 ||
        (handoff.untrackedInventory?.length ?? 0) !== 0) {
        fail('landing-source-dirty-uncollected')
    }
    if (handoff.orderedGreenCommitPrefix.at(-1) !==
        handoff.immutableSourceTip) {
        fail('landing-source-tip-prefix-mismatch')
    }
    const members = orderedMembers(handoff)
    for (const issueId of members) {
        const member = handoff.memberMapping[issueId]
        if (!isSha(member?.candidateSha) ||
            !isSha(member?.commitSha) ||
            !isHash(member?.testContractDigest) ||
            !member.receiptDigests ||
            Object.values(member.receiptDigests)
                .some((value) => !isHash(value))) {
            fail('landing-source-member-mapping-invalid')
        }
    }
    return members
}

function expectedSourceCommit(attempt, memberIssueId) {
    return attempt.sourceMemberCommitShas[memberIssueId]
}

function memberIndex(attempt, memberIssueId) {
    return attempt.sourceMemberOrder.indexOf(memberIssueId)
}

function requireMember(attempt, memberIssueId) {
    requireAttempt(attempt)
    if (!isText(memberIssueId) ||
        !Object.hasOwn(attempt.sourceMemberCommitShas, memberIssueId)) {
        fail('landing-slice-single-member-required')
    }
    return attempt.sourceMemberMapping[memberIssueId]
}

function expectedLandingParent(attempt) {
    return attempt.currentLandingTip
}

function memberRequiredEvidenceComplete(attempt, memberIssueId) {
    return attempt.requiredReverificationClasses.every((evidenceClass) =>
        attempt.reverificationReceipts[memberIssueId]?.[evidenceClass]
            ?.status === 'verified'
    )
}

function allMembersLandingReady(attempt) {
    return attempt.sourceMemberOrder.every((memberIssueId) =>
        isSha(attempt.oldToNewCommitShaMap[
            attempt.sourceMemberCommitShas[memberIssueId]
        ]) &&
        attempt.memberDisposition[memberIssueId] === 'landing-ready' &&
        memberRequiredEvidenceComplete(attempt, memberIssueId)
    )
}

export function createRepositoryLandingLane({
    repository,
    defaultBranch
} = {}) {
    if (!REPOSITORY.test(repository ?? '') || !isText(defaultBranch)) {
        fail('repository-landing-lane-invalid')
    }
    return seal({
        schema: 'issue-orchestration.repository-landing-lane.v1',
        repository,
        defaultBranch,
        state: 'landing-idle',
        activeLease: null,
        attemptIds: []
    }, 'laneDigest')
}

export function acquireRepositoryLandingLease(lane, {
    attemptId,
    landingLeaseId,
    ownerIdentity,
    acquiredAt
} = {}) {
    requireLane(lane)
    if (lane.activeLease !== null || lane.state !== 'landing-idle') {
        fail('repository-landing-lease-active')
    }
    if (!isText(attemptId) || !isText(landingLeaseId) ||
        !isText(ownerIdentity) || Number.isNaN(Date.parse(acquiredAt))) {
        fail('repository-landing-lease-invalid')
    }
    return seal({
        ...clone(lane),
        state: 'landing-active',
        activeLease: {
            attemptId,
            landingLeaseId,
            ownerIdentity,
            acquiredAt
        },
        attemptIds: [...lane.attemptIds, attemptId]
    }, 'laneDigest')
}

export function releaseRepositoryLandingLease(lane, {
    attemptId,
    landingLeaseId,
    landingReceiptDigest,
    releasedAt
} = {}) {
    requireLane(lane)
    if (lane.activeLease?.attemptId !== attemptId ||
        lane.activeLease?.landingLeaseId !== landingLeaseId) {
        fail('repository-landing-lease-mismatch')
    }
    if (!isHash(landingReceiptDigest) ||
        Number.isNaN(Date.parse(releasedAt))) {
        fail('repository-landing-release-receipt-required')
    }
    return seal({
        ...clone(lane),
        state: 'landing-idle',
        activeLease: null,
        lastRelease: {
            attemptId,
            landingLeaseId,
            landingReceiptDigest,
            releasedAt
        }
    }, 'laneDigest')
}

export function createLandingAttempt({
    lane,
    handoff,
    attemptId,
    latestRemoteHead,
    targetEpochId,
    landingLeaseId,
    landingWorktreeIdentity,
    landingBranch,
    resourceRegistryIdentity
} = {}) {
    requireLane(lane)
    const sourceMemberOrder = validateHandoff(handoff)
    if (lane.repository !== handoff.repository ||
        lane.activeLease?.attemptId !== attemptId ||
        lane.activeLease?.landingLeaseId !== landingLeaseId ||
        !isSha(latestRemoteHead) ||
        !isText(targetEpochId) ||
        !isText(landingWorktreeIdentity) ||
        !isText(landingBranch) ||
        !isText(resourceRegistryIdentity)) {
        fail('landing-attempt-binding-invalid')
    }
    const sourceMemberCommitShas = Object.fromEntries(
        sourceMemberOrder.map((issueId) => [
            issueId,
            handoff.memberMapping[issueId].commitSha
        ])
    )
    const memberDisposition = Object.fromEntries(
        sourceMemberOrder.map((issueId) => [
            issueId,
            'clean-transplant-required'
        ])
    )
    const projection = {
        schema: 'issue-orchestration.landing-attempt.v1',
        attemptId,
        repository: handoff.repository,
        defaultBranch: lane.defaultBranch,
        sourceEpochId: handoff.sourceEpoch,
        sourceBaseSha: handoff.sourceBase,
        sourceWorktreeIdentity: handoff.sourceWorktree,
        sourceBranch: handoff.sourceBranch,
        immutableSourceTip: handoff.immutableSourceTip,
        sourceMemberOrder,
        sourceMemberCommitShas,
        sourceMemberMapping: clone(handoff.memberMapping),
        sourceHistoryOperations: [],
        latestRemoteHead,
        currentLandingTip: latestRemoteHead,
        targetEpochId,
        landingLeaseId,
        landingWorktreeIdentity,
        landingBranch,
        resourceRegistryIdentity,
        resourceRetentionReceiptDigest:
            handoff.resourceRetentionReceiptDigest,
        requiredReverificationClasses:
            [...new Set(handoff.requiredReverificationClasses)],
        transplantOperations: [],
        oldToNewCommitShaMap: {},
        sourcePatchIds: {},
        landedPatchIds: {},
        sourceTreeDigests: {},
        landedTreeDigests: {},
        conflictManifest: [],
        memberDisposition,
        evidenceDisposition: {},
        reverificationPlan: {},
        reverificationReceipts: {},
        humanDecisionRequestDigest: null,
        activeLandingSlice: null,
        landingCheckpoint: null,
        landingContinuationReceiptDigest: null,
        state: 'landing-transplanting'
    }
    return appendAttemptEvent(null, 'landing-attempt.created', {
        sourceEpochId: handoff.sourceEpoch,
        sourceBaseSha: handoff.sourceBase,
        latestRemoteHead,
        targetEpochId
    }, projection)
}

export function bindLandingSlice(attempt, input = {}) {
    requireAttempt(attempt)
    const member = requireMember(attempt, input.memberIssueId)
    if (attempt.activeLandingSlice !== null) {
        fail('landing-slice-already-active')
    }
    if (expectedSourceCommit(attempt, input.memberIssueId) !==
        input.sourceCommit) {
        fail('landing-slice-source-commit-mismatch')
    }
    if (!LANDING_SLICE_KINDS.has(input.sliceKind)) {
        fail('landing-slice-kind-invalid')
    }
    const conflictKind =
        input.sliceKind === 'resolve-one-member-one-conflict-cluster'
    if (conflictKind !== isText(input.conflictClusterId)) {
        fail('landing-slice-single-conflict-cluster-required')
    }
    const plan = input.stageWorkPlan
    const slice = input.executableSlice
    if (plan?.schema !== 'issue-orchestration.stage-work-plan.v1' ||
        slice?.schema !== 'issue-orchestration.executable-slice.v1' ||
        plan.baseSha !== attempt.latestRemoteHead ||
        plan.epochId !== attempt.targetEpochId ||
        plan.worktreeIdentity !== attempt.landingWorktreeIdentity ||
        plan.stagePhase !== 'landing-conflict-resolution' ||
        !['code-implementer', 'ui-ux-implementer']
            .includes(plan.stageRole) ||
        slice.planDigest !== plan.planDigest ||
        slice.stagePhase !== plan.stagePhase ||
        slice.stageRole !== plan.stageRole ||
        !/\bgit\b/iu.test(slice.firstRequiredAction ?? '') ||
        !isText(slice.firstWritablePath) ||
        !Array.isArray(slice.explicitNonGoals) ||
        slice.explicitNonGoals.length === 0) {
        fail('landing-slice-1874-binding-invalid')
    }
    const promptErrors = validateCompiledDispatchPrompt({
        plan,
        slice,
        compiled: input.compiledPrompt
    })
    if (promptErrors.length > 0) {
        fail('landing-slice-compiled-prompt-invalid')
    }
    let route
    try {
        if (input.routeInput?.stageWorkPlan?.planDigest !==
                plan.planDigest ||
            input.routeInput?.executableSlice?.sliceDigest !==
                slice.sliceDigest) {
            fail('landing-slice-route-binding-invalid')
        }
        route = compileExecutionRoute(input.routeInput)
    } catch (error) {
        if (error instanceof LandingLaneError) throw error
        fail('landing-slice-route-binding-invalid')
    }
    const decision = route.executionRouteDecision
    if (decision.sliceDigest !== slice.sliceDigest ||
        decision.stagePhase !== 'landing-conflict-resolution' ||
        decision.runtimeVerificationStatus !== 'verified') {
        fail('landing-slice-route-binding-invalid')
    }
    const index = memberIndex(attempt, input.memberIssueId)
    if (index > 0) {
        const previous = attempt.sourceMemberOrder[index - 1]
        if (attempt.memberDisposition[previous] !== 'landing-ready') {
            fail('landing-previous-member-not-green')
        }
    }
    if (attempt.memberDisposition[input.memberIssueId] ===
        'human-decision-pending') {
        fail('landing-member-human-decision-pending')
    }
    const activeLandingSlice = {
        sliceKind: input.sliceKind,
        memberIssueId: input.memberIssueId,
        sourceCommit: input.sourceCommit,
        conflictClusterId: input.conflictClusterId ?? null,
        landingWorkPlanDigest: plan.planDigest,
        activeLandingSliceId: slice.sliceId,
        landingSliceDigest: slice.sliceDigest,
        compiledLandingPromptDigest: input.compiledPrompt.promptDigest,
        landingWorkShape:
            route.executionShapeClassification.dominantWorkShape,
        capabilityRequirementDigest:
            route.stageCapabilityRequirement.capabilityDigest,
        executionRouteDecisionDigest: decision.routeDecisionDigest,
        selectedProfile: decision.selectedProfile,
        firstRequiredAction: slice.firstRequiredAction,
        firstWritableLandingPath: slice.firstWritablePath,
        allowedPaths: clone(slice.allowedPaths),
        requiredCommands: clone(slice.requiredCommands),
        explicitNonGoals: clone(slice.explicitNonGoals),
        landingCheckpointDigest: null,
        landingContinuationReceiptDigest: null
    }
    return appendAttemptEvent(attempt, 'landing-slice.bound', {
        memberIssueId: input.memberIssueId,
        sourceCommit: input.sourceCommit,
        sliceKind: input.sliceKind,
        sliceDigest: slice.sliceDigest,
        routeDecisionDigest: decision.routeDecisionDigest
    }, {
        activeLandingSlice,
        landingCheckpoint: null,
        landingContinuationReceiptDigest: null,
        state: 'landing-transplanting'
    })
}

export function recordLandingCheckpoint(attempt, input = {}) {
    requireAttempt(attempt)
    const active = attempt.activeLandingSlice
    if (!active ||
        active.memberIssueId !== input.memberIssueId ||
        active.sourceCommit !== input.sourceCommit ||
        active.conflictClusterId !== (input.conflictClusterId ?? null) ||
        input.status !== 'partial' ||
        !Array.isArray(input.completedTransplantOperations) ||
        !input.verifiedMappings ||
        !isHash(input.landingStatusDigest) ||
        !Array.isArray(input.commandStatuses) ||
        input.commandStatuses.length === 0 ||
        input.commandStatuses.some((item) =>
            !isText(item?.command) ||
            !Number.isInteger(item?.exitCode) ||
            !isHash(item?.outputDigest)) ||
        !Array.isArray(input.remainingOperations) ||
        input.remainingOperations.length === 0 ||
        !isText(input.nextRequiredAction) ||
        !isHash(input.resourceOwnershipDigest) ||
        !isHash(input.checkpointDigest)) {
        fail('landing-checkpoint-invalid')
    }
    const checkpoint = {
        schema: 'issue-orchestration.landing-checkpoint.v1',
        landingAttemptId: attempt.attemptId,
        sourceEpochId: attempt.sourceEpochId,
        sourceBaseSha: attempt.sourceBaseSha,
        targetEpochId: attempt.targetEpochId,
        latestRemoteHead: attempt.latestRemoteHead,
        activeMemberIssueId: input.memberIssueId,
        activeSourceCommit: input.sourceCommit,
        conflictClusterId: input.conflictClusterId ?? null,
        completedTransplantOperations:
            clone(input.completedTransplantOperations),
        verifiedMappings: clone(input.verifiedMappings),
        landingStatusDigest: input.landingStatusDigest,
        commandStatuses: clone(input.commandStatuses),
        remainingOperations: clone(input.remainingOperations),
        nextRequiredAction: input.nextRequiredAction,
        resourceOwnershipDigest: input.resourceOwnershipDigest,
        landingWorkPlanDigest: active.landingWorkPlanDigest,
        landingSliceDigest: active.landingSliceDigest,
        compiledLandingPromptDigest:
            active.compiledLandingPromptDigest,
        executionRouteDecisionDigest:
            active.executionRouteDecisionDigest,
        checkpointDigest: input.checkpointDigest
    }
    return appendAttemptEvent(attempt, 'landing-checkpoint.recorded', {
        memberIssueId: input.memberIssueId,
        checkpointDigest: input.checkpointDigest,
        nextRequiredAction: input.nextRequiredAction
    }, {
        activeLandingSlice: {
            ...clone(active),
            landingCheckpointDigest: input.checkpointDigest
        },
        landingCheckpoint: checkpoint,
        state: 'landing-slice-continuation-pending'
    })
}

export function resumeLandingSlice(attempt, input = {}) {
    requireAttempt(attempt)
    const checkpoint = attempt.landingCheckpoint
    const active = attempt.activeLandingSlice
    if (attempt.state !== 'landing-slice-continuation-pending' ||
        !checkpoint || !active ||
        input.checkpointDigest !== checkpoint.checkpointDigest ||
        input.memberIssueId !== checkpoint.activeMemberIssueId ||
        input.sourceCommit !== checkpoint.activeSourceCommit ||
        (input.conflictClusterId ?? null) !==
            checkpoint.conflictClusterId) {
        fail('landing-continuation-checkpoint-mismatch')
    }
    if (input.restartSourceInventory !== false ||
        input.nextRequiredAction !== checkpoint.nextRequiredAction ||
        /(?:re-?read|restart|from scratch|complete source inventory)/iu
            .test(input.nextRequiredAction)) {
        fail('landing-continuation-restart-forbidden')
    }
    const continuation = seal({
        schema: 'issue-orchestration.landing-continuation-receipt.v1',
        landingAttemptId: attempt.attemptId,
        memberIssueId: input.memberIssueId,
        sourceCommit: input.sourceCommit,
        conflictClusterId: input.conflictClusterId ?? null,
        landingSliceDigest: active.landingSliceDigest,
        checkpointDigest: input.checkpointDigest,
        nextRequiredAction: input.nextRequiredAction,
        restartSourceInventory: false
    }, 'receiptDigest')
    return appendAttemptEvent(attempt, 'landing-slice.resumed', {
        memberIssueId: input.memberIssueId,
        checkpointDigest: input.checkpointDigest,
        continuationReceiptDigest: continuation.receiptDigest
    }, {
        activeLandingSlice: {
            ...clone(active),
            landingContinuationReceiptDigest:
                continuation.receiptDigest
        },
        landingContinuationReceiptDigest: continuation.receiptDigest,
        state: 'landing-transplanting'
    })
}

export function recordCommitTransplant(attempt, input = {}) {
    requireAttempt(attempt)
    const member = requireMember(attempt, input.memberIssueId)
    const active = attempt.activeLandingSlice
    if (!active ||
        active.memberIssueId !== input.memberIssueId ||
        active.sourceCommit !== input.sourceCommit) {
        fail('landing-transplant-active-slice-required')
    }
    if (!Array.isArray(input.issueIds) ||
        input.issueIds.length !== 1 ||
        input.issueIds[0] !== input.memberIssueId) {
        fail('landing-transplant-member-atomicity')
    }
    const conflictManifest = input.conflictManifest
    const alreadyApplied =
        input.equivalenceDisposition === 'already-applied-equivalent'
    if (Array.isArray(conflictManifest) &&
        conflictManifest.some((conflict) =>
            ['ours', 'theirs', 'automatic', 'union']
                .includes(conflict?.resolutionStrategy))) {
        fail('landing-conflict-automatic-choice-forbidden')
    }
    if (!isSha(input.sourceCommit) ||
        input.sourceCommit !== member.commitSha ||
        !isSha(input.newCommitSha) ||
        (!alreadyApplied && input.newCommitSha === input.sourceCommit) ||
        (!alreadyApplied &&
            input.parentSha !== expectedLandingParent(attempt)) ||
        (alreadyApplied && !isSha(input.parentSha)) ||
        !isHash(input.sourcePatchId) ||
        !isHash(input.landedPatchId) ||
        !isHash(input.sourceTreeDigest) ||
        !isHash(input.landedTreeDigest) ||
        !Array.isArray(input.changedPaths) ||
        input.changedPaths.length === 0 ||
        input.changedPaths.some((changedPath) =>
            !active.allowedPaths.includes(changedPath)) ||
        !Array.isArray(conflictManifest) ||
        !isSha(input.candidateSha) ||
        input.candidateSha !== input.newCommitSha ||
        !isHash(input.terminalReceiptDigest)) {
        fail('landing-transplant-evidence-invalid')
    }
    if (Object.hasOwn(attempt.oldToNewCommitShaMap, input.sourceCommit)) {
        fail('landing-transplant-source-replayed')
    }
    const expectedIndex = attempt.transplantOperations.length
    if (memberIndex(attempt, input.memberIssueId) !== expectedIndex) {
        fail('landing-transplant-member-order')
    }
    if (conflictManifest.length === 0) {
        if (active.sliceKind !== 'transplant-one-member-commit' ||
            input.sourcePatchId !== input.landedPatchId ||
            ![
                'patch-and-tree-equivalent',
                'already-applied-equivalent'
            ].includes(input.equivalenceDisposition) ||
            (alreadyApplied &&
                !isHash(input.alreadyAppliedEvidenceDigest))) {
            fail('landing-transplant-equivalence-invalid')
        }
    } else {
        if (active.sliceKind !==
                'resolve-one-member-one-conflict-cluster' ||
            conflictManifest.some((conflict) =>
                conflict.conflictClusterId !== active.conflictClusterId ||
                conflict.status !== 'resolved' ||
                conflict.resolutionAuthority !==
                    'frozen-contract-unique' ||
                !isHash(conflict.differenceEvidenceDigest))) {
            fail('landing-conflict-resolution-slice-required')
        }
    }
    const receipt = seal({
        schema: 'issue-orchestration.commit-transplant-receipt.v1',
        repository: attempt.repository,
        landingAttemptId: attempt.attemptId,
        memberIssueId: input.memberIssueId,
        sourceCommit: input.sourceCommit,
        newCommitSha: input.newCommitSha,
        parentSha: input.parentSha,
        sourcePatchId: input.sourcePatchId,
        landedPatchId: input.landedPatchId,
        sourceTreeDigest: input.sourceTreeDigest,
        landedTreeDigest: input.landedTreeDigest,
        changedPaths: clone(input.changedPaths),
        conflictManifest: clone(conflictManifest),
        equivalenceDisposition: input.equivalenceDisposition,
        alreadyAppliedEvidenceDigest:
            input.alreadyAppliedEvidenceDigest ?? null,
        candidateSha: input.candidateSha,
        terminalReceiptDigest: input.terminalReceiptDigest,
        landingWorkPlanDigest: active.landingWorkPlanDigest,
        landingSliceDigest: active.landingSliceDigest,
        compiledLandingPromptDigest:
            active.compiledLandingPromptDigest,
        landingWorkShape: active.landingWorkShape,
        capabilityRequirementDigest:
            active.capabilityRequirementDigest,
        executionRouteDecisionDigest:
            active.executionRouteDecisionDigest,
        landingCheckpointDigest:
            active.landingCheckpointDigest,
        landingContinuationReceiptDigest:
            active.landingContinuationReceiptDigest
    }, 'receiptDigest')
    const oldToNewCommitShaMap = {
        ...clone(attempt.oldToNewCommitShaMap),
        [input.sourceCommit]: input.newCommitSha
    }
    const memberDisposition = {
        ...clone(attempt.memberDisposition),
        [input.memberIssueId]: 'transplanted-reverify-required'
    }
    return appendAttemptEvent(attempt, 'landing-commit.transplanted', {
        memberIssueId: input.memberIssueId,
        sourceCommit: input.sourceCommit,
        newCommitSha: input.newCommitSha,
        receiptDigest: receipt.receiptDigest
    }, {
        transplantOperations: [
            ...clone(attempt.transplantOperations),
            receipt
        ],
        oldToNewCommitShaMap,
        sourcePatchIds: {
            ...clone(attempt.sourcePatchIds),
            [input.sourceCommit]: input.sourcePatchId
        },
        landedPatchIds: {
            ...clone(attempt.landedPatchIds),
            [input.newCommitSha]: input.landedPatchId
        },
        sourceTreeDigests: {
            ...clone(attempt.sourceTreeDigests),
            [input.sourceCommit]: input.sourceTreeDigest
        },
        landedTreeDigests: {
            ...clone(attempt.landedTreeDigests),
            [input.newCommitSha]: input.landedTreeDigest
        },
        conflictManifest: [
            ...clone(attempt.conflictManifest),
            ...clone(conflictManifest)
        ],
        memberDisposition,
        currentLandingTip: alreadyApplied
            ? attempt.currentLandingTip
            : input.newCommitSha,
        activeLandingSlice: null,
        landingCheckpoint: null,
        landingContinuationReceiptDigest: null,
        state: 'landing-reverifying'
    })
}

export function recordEvidenceRebinding(attempt, input = {}) {
    requireAttempt(attempt)
    const member = requireMember(attempt, input.memberIssueId)
    if (!isSha(attempt.oldToNewCommitShaMap[member.commitSha])) {
        fail('landing-evidence-member-not-transplanted')
    }
    if (!isText(input.evidenceClass) ||
        member.receiptDigests[input.evidenceClass] !==
            input.sourceReceiptDigest ||
        !['reverify-required', 'source-independent-rebound']
            .includes(input.disposition) ||
        !isHash(input.verifierReceiptDigest)) {
        fail('landing-evidence-rebinding-invalid')
    }
    if (input.disposition === 'source-independent-rebound' &&
        input.sourceIndependent !== true) {
        fail('landing-evidence-source-independence-unverified')
    }
    const receipt = seal({
        schema: 'issue-orchestration.evidence-rebinding-receipt.v1',
        repository: attempt.repository,
        landingAttemptId: attempt.attemptId,
        memberIssueId: input.memberIssueId,
        evidenceClass: input.evidenceClass,
        sourceReceiptDigest: input.sourceReceiptDigest,
        disposition: input.disposition,
        sourceIndependent: input.sourceIndependent === true,
        sourceBaseSha: attempt.sourceBaseSha,
        targetBaseSha: attempt.latestRemoteHead,
        newCandidateSha:
            attempt.oldToNewCommitShaMap[member.commitSha],
        verifierReceiptDigest: input.verifierReceiptDigest
    }, 'receiptDigest')
    return appendAttemptEvent(attempt, 'landing-evidence.rebound', {
        memberIssueId: input.memberIssueId,
        evidenceClass: input.evidenceClass,
        disposition: input.disposition,
        receiptDigest: receipt.receiptDigest
    }, {
        evidenceDisposition: {
            ...clone(attempt.evidenceDisposition),
            [input.memberIssueId]: {
                ...clone(
                    attempt.evidenceDisposition[input.memberIssueId] ?? {}
                ),
                [input.evidenceClass]: receipt
            }
        },
        reverificationPlan: {
            ...clone(attempt.reverificationPlan),
            [input.memberIssueId]: [
                ...new Set([
                    ...(attempt.reverificationPlan[
                        input.memberIssueId
                    ] ?? []),
                    ...(input.disposition === 'reverify-required'
                        ? [input.evidenceClass]
                        : [])
                ])
            ]
        }
    })
}

export function recordReverificationReceipt(attempt, input = {}) {
    requireAttempt(attempt)
    const member = requireMember(attempt, input.memberIssueId)
    const disposition =
        attempt.evidenceDisposition[input.memberIssueId]?.[
            input.evidenceClass
        ]
    const receipt = input.receipt
    const candidateSha =
        attempt.oldToNewCommitShaMap[member.commitSha]
    if (disposition?.disposition !== 'reverify-required' ||
        disposition.sourceReceiptDigest !== input.sourceReceiptDigest ||
        receipt?.schema !==
            'issue-orchestration.member-reverification-receipt.v1' ||
        receipt.repository !== attempt.repository ||
        receipt.memberIssueId !== input.memberIssueId ||
        receipt.baseSha !== attempt.latestRemoteHead ||
        receipt.candidateSha !== candidateSha ||
        receipt.status !== 'verified' ||
        !isHash(receipt.receiptDigest)) {
        fail('landing-reverification-receipt-invalid')
    }
    if (receipt.receiptDigest === input.sourceReceiptDigest) {
        fail('landing-reverification-source-receipt-replayed')
    }
    const reverificationReceipts = {
        ...clone(attempt.reverificationReceipts),
        [input.memberIssueId]: {
            ...clone(
                attempt.reverificationReceipts[input.memberIssueId] ?? {}
            ),
            [input.evidenceClass]: clone(receipt)
        }
    }
    const projected = {
        ...clone(attempt),
        reverificationReceipts
    }
    const ready = memberRequiredEvidenceComplete(
        projected,
        input.memberIssueId
    )
    const memberDisposition = {
        ...clone(attempt.memberDisposition),
        [input.memberIssueId]: ready
            ? 'landing-ready'
            : 'transplanted-reverify-required'
    }
    return appendAttemptEvent(attempt, 'landing-evidence.reverified', {
        memberIssueId: input.memberIssueId,
        evidenceClass: input.evidenceClass,
        receiptDigest: receipt.receiptDigest
    }, {
        reverificationReceipts,
        memberDisposition,
        state: ready ? 'landing-transplanting' : 'landing-reverifying'
    })
}

export function markLandingHumanDecisionPending(attempt, input = {}) {
    requireAttempt(attempt)
    requireMember(attempt, input.memberIssueId)
    const active = attempt.activeLandingSlice
    const request = input.request
    if (!active ||
        active.sliceKind !==
            'resolve-one-member-one-conflict-cluster' ||
        active.memberIssueId !== input.memberIssueId ||
        active.sourceCommit !== input.sourceCommit ||
        active.conflictClusterId !== input.conflictClusterId ||
        !HUMAN_AUTHORITY_REASONS.has(input.reason)) {
        fail('landing-human-decision-not-authority-choice')
    }
    if (request?.schema !==
            'issue-orchestration.human-decision-request.v1' ||
        request.verificationStatus !== 'verified' ||
        request.memberIssueId !== input.memberIssueId ||
        !isHash(request.requestDigest)) {
        fail('landing-human-decision-request-unverified')
    }
    return appendAttemptEvent(attempt, 'landing-human-decision.pending', {
        memberIssueId: input.memberIssueId,
        conflictClusterId: input.conflictClusterId,
        reason: input.reason,
        requestDigest: request.requestDigest
    }, {
        memberDisposition: {
            ...clone(attempt.memberDisposition),
            [input.memberIssueId]: 'human-decision-pending'
        },
        humanDecisionRequestDigest: request.requestDigest,
        activeLandingSlice: null,
        state: 'human-decision-pending'
    })
}

export function observeLandingRemoteDrift(attempt, {
    observedRemoteHead,
    observedAt
} = {}) {
    requireAttempt(attempt)
    if (!isSha(observedRemoteHead) ||
        observedRemoteHead === attempt.latestRemoteHead ||
        Number.isNaN(Date.parse(observedAt))) {
        fail('landing-remote-drift-observation-invalid')
    }
    const drifted = appendAttemptEvent(
        attempt,
        'landing-remote.drifted',
        {
            previousRemoteHead: attempt.latestRemoteHead,
            observedRemoteHead,
            observedAt
        },
        {
            activeLandingSlice: null,
            landingCheckpoint: null,
            state: 'remote-drifted'
        }
    )
    return deepFreeze({
        schema: 'issue-orchestration.landing-drift-disposition.v1',
        disposition: 'rebuild-landing-attempt',
        previousLandingAttemptId: attempt.attemptId,
        observedRemoteHead,
        preservedSource: {
            sourceEpochId: attempt.sourceEpochId,
            sourceBaseSha: attempt.sourceBaseSha,
            sourceWorktreeIdentity: attempt.sourceWorktreeIdentity,
            sourceBranch: attempt.sourceBranch,
            immutableSourceTip: attempt.immutableSourceTip,
            sourceMemberOrder: clone(attempt.sourceMemberOrder),
            sourceMemberCommitShas:
                clone(attempt.sourceMemberCommitShas)
        },
        sourceHistoryOperations: [],
        attempt: drifted
    })
}

export function createWorktreeDisposition(input = {}) {
    if (!REPOSITORY.test(input.repository ?? '') ||
        !isText(input.worktreeIdentity) ||
        !WORKTREE_DISPOSITIONS.has(input.disposition) ||
        !isHash(input.evidenceDigest)) {
        fail('worktree-disposition-invalid')
    }
    return seal({
        schema: 'issue-orchestration.worktree-disposition.v1',
        repository: input.repository,
        worktreeIdentity: input.worktreeIdentity,
        memberIssueId: input.memberIssueId ?? null,
        evidenceClass: input.evidenceClass ?? null,
        disposition: input.disposition,
        evidenceDigest: input.evidenceDigest
    }, 'receiptDigest')
}

export function finalizeLanding(attempt, input = {}) {
    requireAttempt(attempt)
    if (attempt.activeLandingSlice !== null ||
        attempt.state === 'human-decision-pending' ||
        attempt.state === 'remote-drifted' ||
        !allMembersLandingReady(attempt)) {
        fail('landing-attempt-not-ready')
    }
    const orderedLandedCommits = attempt.sourceMemberOrder.map(
        (memberIssueId) => attempt.oldToNewCommitShaMap[
            attempt.sourceMemberCommitShas[memberIssueId]
        ]
    )
    if (input.remoteHeadObservedBeforePush !== attempt.latestRemoteHead ||
        input.resultingRemoteSha !== attempt.currentLandingTip ||
        input.pushMode !== 'fast-forward' ||
        input.fastForwardVerified !== true ||
        !SOURCE_RETIREMENT_DISPOSITIONS.has(
            input.sourceRetirementDisposition
        ) ||
        !isHash(input.cleanupReceiptDigest)) {
        fail('landing-fast-forward-proof-invalid')
    }
    const landedAttempt = appendAttemptEvent(
        attempt,
        'landing-attempt.landed',
        {
            remoteHeadObservedBeforePush:
                input.remoteHeadObservedBeforePush,
            resultingRemoteSha: input.resultingRemoteSha,
            sourceRetirementDisposition:
                input.sourceRetirementDisposition,
            cleanupReceiptDigest: input.cleanupReceiptDigest
        },
        {
            memberDisposition: Object.fromEntries(
                attempt.sourceMemberOrder.map((issueId) => [
                    issueId,
                    'landed'
                ])
            ),
            state: 'landed'
        }
    )
    return seal({
        schema: 'issue-orchestration.landing-receipt.v1',
        repository: attempt.repository,
        defaultBranch: attempt.defaultBranch,
        landingAttemptId: attempt.attemptId,
        sourceEpochId: attempt.sourceEpochId,
        sourceBaseSha: attempt.sourceBaseSha,
        immutableSourceTip: attempt.immutableSourceTip,
        targetEpochId: attempt.targetEpochId,
        remoteHeadObservedBeforePush:
            input.remoteHeadObservedBeforePush,
        resultingRemoteSha: input.resultingRemoteSha,
        pushMode: input.pushMode,
        fastForwardVerified: true,
        orderedSourceCommits:
            clone(attempt.sourceMemberOrder.map((issueId) =>
                attempt.sourceMemberCommitShas[issueId])),
        orderedLandedCommits,
        oldToNewCommitShaMap:
            clone(attempt.oldToNewCommitShaMap),
        memberDisposition:
            clone(landedAttempt.memberDisposition),
        sourceRetirementDisposition:
            input.sourceRetirementDisposition,
        cleanupReceiptDigest: input.cleanupReceiptDigest,
        sourceHistoryOperations: [],
        attempt: landedAttempt
    }, 'receiptDigest')
}

export function replayLandingAttempt(attempt) {
    requireAttempt(attempt)
    return deepFreeze(clone(attempt))
}
