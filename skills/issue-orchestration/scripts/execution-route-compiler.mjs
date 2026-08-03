import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
    STAGE_MODEL_POOL_POLICY,
    STAGE_ROUTE_DEFINITIONS,
    compileStageRoutingIdentity,
    splitProfile,
    validateRoutingClassification,
    verifyRuntimeProfileMetadata
} from './stage-profile-policy.mjs'
import {
    compileExecutableSlice
} from './executable-slice-compiler.mjs'
import {
    validateRuntimeExecutionBinding
} from './runtime-execution-binding.mjs'

const HASH = /^[a-f0-9]{64}$/u
const POLICY_ROOT = path.resolve(import.meta.dirname, '../../../policy')

function readPolicy(name) {
    return JSON.parse(fs.readFileSync(path.join(POLICY_ROOT, name), 'utf8'))
}

const ROUTING_POLICY = readPolicy('execution-routing-policy.json')
const REVIEWED_ASSUMPTIONS =
    readPolicy('reviewed-routing-assumptions.json')

export const EXECUTION_ROUTING_POLICY_VERSION = ROUTING_POLICY.version
export const EXECUTION_ROUTING_AUTHORITY = ROUTING_POLICY.routingAuthority
export const EXECUTION_ROUTING_POLICY_DIGEST = digest({
    policy: ROUTING_POLICY,
    reviewedRoutingAssumptionsDigest:
        digest(REVIEWED_ASSUMPTIONS)
})
export const EXECUTION_ROUTING_POLICY = Object.freeze(
    structuredClone(ROUTING_POLICY)
)
export const REVIEWED_ROUTING_ASSUMPTIONS = Object.freeze(
    structuredClone(REVIEWED_ASSUMPTIONS)
)

export class ExecutionRouteError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'ExecutionRouteError'
        this.code = code
    }
}

function fail(code, message = code) {
    throw new ExecutionRouteError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function sameValue(left, right) {
    return JSON.stringify(canonical(left)) ===
        JSON.stringify(canonical(right))
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function seal(value, digestField) {
    const sealed = structuredClone(value)
    sealed[digestField] = digest(sealed)
    return Object.freeze(sealed)
}

function assertDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

export function compileProfileAvailabilityBinding({
    packageDigest,
    runtimeInvocationId,
    observedAt,
    catalogObservation
} = {}) {
    if (!HASH.test(packageDigest ?? '') ||
        typeof runtimeInvocationId !== 'string' ||
        !runtimeInvocationId ||
        typeof observedAt !== 'string' ||
        !observedAt ||
        catalogObservation?.schema !==
            'issue-orchestration.runtime-profile-catalog-observation.v1' ||
        catalogObservation.source !==
            'trusted-runtime-catalog-observer' ||
        catalogObservation.paidInvocationCount !== 0 ||
        !Array.isArray(catalogObservation.profiles)) {
        fail('execution-route-availability-observation-invalid')
    }
    const observed = new Map()
    for (const profile of catalogObservation.profiles) {
        if (typeof profile?.profileId !== 'string' ||
            observed.has(profile.profileId) ||
            typeof profile.available !== 'boolean' ||
            profile.available && profile.reason !== null ||
            !profile.available &&
                !['runtime-unsupported', 'runtime-unavailable']
                    .includes(profile.reason)) {
            fail('execution-route-availability-observation-invalid')
        }
        observed.set(profile.profileId, profile)
    }
    const authorized = [
        ...STAGE_MODEL_POOL_POLICY.productionRoster,
        ...STAGE_MODEL_POOL_POLICY.frontierOnlyProfiles
    ]
    if (authorized.some((profile) => !observed.has(profile))) {
        fail('execution-route-availability-observation-incomplete')
    }
    const profiles = Object.fromEntries(authorized.map((profile) => [
        profile,
        {
            available: observed.get(profile).available,
            reason: observed.get(profile).reason
        }
    ]))
    return seal({
        schema:
            'issue-orchestration.profile-availability-binding.v1',
        source: 'trusted-runtime-catalog-observer',
        phase: 'pre-dispatch',
        runtimeInvocationId,
        packageDigest,
        policyDigest: EXECUTION_ROUTING_POLICY_DIGEST,
        observedAt,
        profiles
    }, 'bindingDigest')
}

export function verifyInstalledProductionPolicy({
    manifest,
    availabilityBinding
} = {}) {
    if (manifest?.schema !==
            'issue-orchestration.shared-package-manifest.v1' ||
        !HASH.test(manifest.manifestDigest ?? '') ||
        availabilityBinding?.packageDigest !== manifest.manifestDigest) {
        fail('execution-route-install-package-binding')
    }
    validateAvailabilityBinding(availabilityBinding)
    const disabled =
        new Set(STAGE_MODEL_POOL_POLICY.disabledProfiles)
    const routeCells = Object.entries(ROUTING_POLICY.routeCells ?? {})
    const ordinaryOutcomes = routeCells
        .filter(([, cell]) => cell.advisorOnly !== true)
        .map(([, cell]) => cell.requiredProfile)
    if (ordinaryOutcomes.some((profile) =>
        disabled.has(profile) || profile === 'sol-max') ||
        Object.values(STAGE_ROUTE_DEFINITIONS).some((stage) =>
            stage.allowedProfiles.some((profile) =>
                disabled.has(profile))) ||
        Object.entries(STAGE_ROUTE_DEFINITIONS).some(([key, stage]) =>
            stage.allowedProfiles.includes('sol-max') &&
            key !== 'dag-creator-updater:semantic-proposal')) {
        fail('execution-route-install-authority-invalid')
    }
    const reachability = Object.fromEntries(routeCells.map(
        ([routeCellId, cell]) => [
            routeCellId,
            availabilityBinding.profiles[cell.requiredProfile]?.available ===
                true ||
            cell.requiredProfile === 'luna-max' &&
                availabilityBinding.profiles['terra-high']?.available === true
        ]))
    if (Object.values(reachability).some((reachable) =>
        reachable !== true)) {
        fail('execution-route-install-route-unreachable')
    }
    return seal({
        schema:
            'issue-orchestration.production-policy-installation-receipt.v1',
        status: 'verified',
        manifestDigest: manifest.manifestDigest,
        modelPoolPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
        policyDigest: EXECUTION_ROUTING_POLICY_DIGEST,
        availabilityBindingDigest:
            availabilityBinding.bindingDigest,
        paidModelInvocationCount: 0,
        comparativeQualificationPerformed: false,
        routeReachability: reachability,
        disabledProfiles:
            [...STAGE_MODEL_POOL_POLICY.disabledProfiles],
        frontierOnlyProfiles:
            [...STAGE_MODEL_POOL_POLICY.frontierOnlyProfiles]
    }, 'receiptDigest')
}

function assumptionBody(value) {
    const body = structuredClone(value)
    delete body.assumptionDigest
    return body
}

export function verifyReviewedRoutingAssumptions(
    assumptions = REVIEWED_ASSUMPTIONS
) {
    if (ROUTING_POLICY.schema !==
            'issue-orchestration.execution-routing-policy.v4' ||
        ROUTING_POLICY.version !==
            'execution-capability-routing.v4' ||
        ROUTING_POLICY.routingAuthority !==
            'canonical-route-cell-compiler' ||
        ROUTING_POLICY.selectionMode !==
            'exact-route-cell-no-profile-search' ||
        ROUTING_POLICY.capabilityValidationMode !==
            'accept-required-profile-or-fail-closed' ||
        ROUTING_POLICY.legacyReceiptPolicy !== 'reject' ||
        ROUTING_POLICY.failureReroutePolicy !==
            'profile-advance-forbidden' ||
        assumptions?.schema !==
            'issue-orchestration.reviewed-routing-assumptions.v1' ||
        assumptions.policyVersion !== ROUTING_POLICY.version ||
        assumptions.modelPoolPolicyVersion !==
            STAGE_MODEL_POOL_POLICY.version ||
        assumptions.authority !==
            'checked-in-reviewed-routing-assumptions' ||
        assumptions.evidenceClass !==
            'maintained-policy-not-runtime-observation' ||
        assumptions.runtimeObservationClaim !== false ||
        assumptions.selectorAuthority !== false ||
        assumptions.exactRouteValidationOnly !== true ||
        assumptions.catalogAvailabilitySemantics !==
            'availability-only-not-reasoning-capability' ||
        assumptions.installationPaidModelInvocationCount !== 0) {
        fail('execution-route-reviewed-assumptions-invalid')
    }
    const legacyLabels = [
        'machine-runtime-observation',
        'codex-v2-runtime-metadata-observer',
        'recomputed-codex-v2-runtime-observations'
    ]
    const serialized = JSON.stringify(assumptions)
    if (legacyLabels.some((label) => serialized.includes(label))) {
        fail('execution-route-legacy-observation-authority')
    }
    const modelProfiles = Object.keys(
        STAGE_MODEL_POOL_POLICY.profiles
    ).sort()
    const assumptionProfiles = Object.keys(
        assumptions.profiles ?? {}
    ).sort()
    if (!sameValue(modelProfiles, assumptionProfiles)) {
        fail('execution-route-reviewed-assumption-coverage')
    }
    for (const profileId of modelProfiles) {
        const profile = STAGE_MODEL_POOL_POLICY.profiles[profileId]
        const assumption = assumptions.profiles[profileId]
        if (assumption.model !== profile.model ||
            assumption.effort !== profile.effort ||
            assumption.multiAgentBackend !==
                profile.multiAgentBackend ||
            assumption.policyStatus !== profile.productionStatus ||
            assumption.routeValidation !==
                'exact-required-profile-only' ||
            assumption.assumptionDigest !==
                digest(assumptionBody(assumption)) ||
            profile.reviewedAssumptionDigest !==
                assumption.assumptionDigest) {
            fail('execution-route-reviewed-assumption-mismatch')
        }
    }
    for (const [routeCellId, cell] of Object.entries(
        ROUTING_POLICY.routeCells ?? {}
    )) {
        const assumption = assumptions.profiles[cell.requiredProfile]
        if (!assumption ||
            assumption.policyStatus === 'disabled' ||
            cell.advisorOnly === true &&
                cell.requiredProfile !== 'sol-max' ||
            cell.advisorOnly !== true &&
                cell.requiredProfile === 'sol-max') {
            fail(
                'execution-route-cell-assumption-invalid',
                routeCellId
            )
        }
    }
    return assumptions
}

export function verifyLiveCapabilityEvidence(value) {
    const requiredStrings = [
        'runtimeInvocationId',
        'sessionOrThreadId',
        'requestedProfile',
        'effectiveProfile',
        'requestedModel',
        'effectiveModel',
        'requestedEffort',
        'effectiveEffort',
        'multiAgentBackend',
        'runtimeVersion',
        'fixtureOrTaskIdentity',
        'observedAt'
    ]
    const requiredDigests = [
        'packageDigest',
        'policyDigest',
        'rawEventDigest',
        'rawSessionDigest',
        'rawTurnDigest',
        'executedCommandDigest',
        'toolTraceDigest'
    ]
    const derivedFields = [
        ...requiredStrings,
        'sourceCommit',
        ...requiredDigests
    ]
    if (value?.schema !==
            'issue-orchestration.live-capability-evidence.v1' ||
        value.authority !==
            'invocation-bound-live-capability-evidence' ||
        requiredStrings.some((field) =>
            typeof value[field] !== 'string' || !value[field]) ||
        requiredDigests.some((field) =>
            !HASH.test(value[field] ?? '')) ||
        !/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? '') ||
        value.policyDigest !== EXECUTION_ROUTING_POLICY_DIGEST ||
        !value.perFieldDerivation ||
        typeof value.perFieldDerivation !== 'object' ||
        Array.isArray(value.perFieldDerivation) ||
        !sameValue(
            Object.keys(value.perFieldDerivation).sort(),
            [...derivedFields].sort()
        )) {
        fail('execution-route-live-capability-evidence-invalid')
    }
    for (const derivation of Object.values(value.perFieldDerivation)) {
        if (typeof derivation?.derivation !== 'string' ||
            !derivation.derivation ||
            !HASH.test(derivation.valueDigest ?? '') ||
            !Array.isArray(derivation.sourceEvidenceDigests) ||
            derivation.sourceEvidenceDigests.length === 0 ||
            derivation.sourceEvidenceDigests.some((entry) =>
                !HASH.test(entry))) {
            fail('execution-route-live-capability-derivation-invalid')
        }
    }
    const unsigned = structuredClone(value)
    delete unsigned.receiptDigest
    if (value.receiptDigest !== digest(unsigned)) {
        fail('execution-route-live-capability-receipt-invalid')
    }
    return value
}

verifyReviewedRoutingAssumptions()

function assertNoForbiddenInputs(input) {
    for (const field of ROUTING_POLICY.forbiddenInputs) {
        if (Object.hasOwn(input ?? {}, field)) {
            fail(
                field === 'requestedProfile' ||
                    field === 'selectedProfile' ||
                    field === 'profileOverride'
                    ? 'execution-route-root-profile-selection-forbidden'
                    : 'execution-route-forbidden-input'
            )
        }
    }
}

function verifiedSlice(input) {
    const plan = input?.stageWorkPlan
    const slice = input?.executableSlice
    if (plan?.schema !== 'issue-orchestration.stage-work-plan.v1' ||
        slice?.schema !== 'issue-orchestration.executable-slice.v1' ||
        !HASH.test(slice.sliceDigest ?? '') ||
        !HASH.test(plan.planDigest ?? '')) {
        fail('execution-route-verified-slice-required')
    }
    let expected
    try {
        expected = compileExecutableSlice({
            plan,
            sliceId: slice.sliceId
        })
    } catch {
        fail('execution-route-verified-slice-required')
    }
    if (!sameValue(expected, slice) ||
        slice.planDigest !== plan.planDigest ||
        slice.stageRole !== plan.stageRole ||
        slice.stagePhase !== plan.stagePhase) {
        fail('execution-route-verified-slice-required')
    }
    return slice
}

const INTEGER_METRICS = Object.freeze([
    'expectedChangedFileCount',
    'ownedModuleCount',
    'commandLoopCount',
    'runtimeProbeDepth',
    'toolInteractionDepth'
])

function validatedMetrics(input, slice) {
    const supplied = input?.executionMetrics
    const metrics = supplied && typeof supplied === 'object'
        ? {
                costSensitivity: 'neutral',
                freshContext: false,
                compiledContextTokens: null,
                exactTokenizerAvailable: false,
                selfContainedPrompt: false,
                bulkCrossScopeContext: false,
                ...supplied
            }
        : supplied
    if (!metrics || typeof metrics !== 'object' ||
        INTEGER_METRICS.some((field) =>
            !Number.isInteger(metrics[field]) || metrics[field] < 0) ||
        !ROUTING_POLICY.contextBreadthOrder.includes(metrics.contextBreadth) ||
        typeof metrics.statefulContinuationRequired !== 'boolean' ||
        !['simple', 'resumable', 'durable']
            .includes(metrics.checkpointSupportRequired) ||
        typeof metrics.firstActionDeterministic !== 'boolean' ||
        typeof metrics.wholeIssueScope !== 'boolean' ||
        !['neutral', 'latency-sensitive', 'cost-sensitive-deep']
            .includes(metrics.costSensitivity) ||
        typeof metrics.freshContext !== 'boolean' ||
        metrics.compiledContextTokens !== null &&
            (!Number.isInteger(metrics.compiledContextTokens) ||
                metrics.compiledContextTokens < 0) ||
        typeof metrics.exactTokenizerAvailable !== 'boolean' ||
        typeof metrics.selfContainedPrompt !== 'boolean' ||
        typeof metrics.bulkCrossScopeContext !== 'boolean') {
        fail('execution-route-shape-metrics-invalid')
    }
    if (metrics.wholeIssueScope === true) {
        fail('execution-route-whole-issue-forbidden')
    }
    if (!metrics.firstActionDeterministic ||
        typeof slice.firstRequiredAction !== 'string' ||
        !slice.firstRequiredAction ||
        (!slice.firstWritablePath && !slice.explicitReadOnlyOutput)) {
        fail('execution-route-first-action-not-deterministic')
    }
    if (metrics.expectedChangedFileCount > slice.maxChangedFiles ||
        metrics.ownedModuleCount > slice.maxOwnedModules) {
        fail('execution-route-shape-exceeds-slice')
    }
    return metrics
}

function lunaContractSatisfied(metrics, slice, stageDefinition) {
    const contract = STAGE_MODEL_POOL_POLICY.lunaMaxContract
    return stageDefinition.allowedProfiles.includes('luna-max') &&
        metrics.freshContext === contract.freshContext &&
        metrics.contextBreadth === contract.contextBreadth &&
        metrics.statefulContinuationRequired ===
            contract.statefulContinuationRequired &&
        metrics.checkpointSupportRequired ===
            contract.checkpointSupportRequired &&
        metrics.ownedModuleCount <= contract.maxOwnedModuleCount &&
        metrics.commandLoopCount <= contract.maxCommandLoopCount &&
        metrics.toolInteractionDepth <=
            contract.maxToolInteractionDepth &&
        metrics.runtimeProbeDepth <= contract.maxRuntimeProbeDepth &&
        metrics.firstActionDeterministic ===
            contract.firstActionDeterministic &&
        Number.isInteger(metrics.compiledContextTokens) &&
        metrics.compiledContextTokens <=
            contract.maxCompiledContextTokens &&
        metrics.exactTokenizerAvailable ===
            contract.exactTokenizerRequired &&
        metrics.selfContainedPrompt ===
            contract.selfContainedPromptRequired &&
        metrics.bulkCrossScopeContext === false &&
        slice.maxOwnedModules <= contract.maxOwnedModuleCount
}

function shapeCandidates(metrics, slice, stageDefinition) {
    const shapes = []
    if (metrics.costSensitivity === 'cost-sensitive-deep') {
        if (!lunaContractSatisfied(metrics, slice, stageDefinition)) {
            fail('execution-route-luna-contract')
        }
        shapes.push('luna-fresh-narrow-deep')
    }
    const longHorizon =
        metrics.toolInteractionDepth >= 16 ||
        (metrics.contextBreadth === 'very-broad' &&
            metrics.statefulContinuationRequired &&
            metrics.toolInteractionDepth >= 12)
    if (longHorizon) shapes.push('long-horizon-cross-module')
    if (metrics.toolInteractionDepth >= 10) {
        shapes.push('high-tool-depth')
    }
    if (metrics.contextBreadth === 'broad' ||
        metrics.contextBreadth === 'very-broad') {
        shapes.push('context-heavy')
    }
    if (metrics.runtimeProbeDepth >= 4) {
        shapes.push('runtime-probe-heavy')
    }
    if (metrics.commandLoopCount >= 3) {
        shapes.push('iterative-debug')
    }
    if (metrics.expectedChangedFileCount > 1 ||
        metrics.ownedModuleCount > 1) {
        shapes.push('bounded-multifile')
    }
    if (shapes.length === 0 &&
        (stageDefinition.writeScope === 'none' ||
            slice.explicitReadOnlyOutput)) {
        shapes.push('focused-observe-only')
    }
    shapes.push('atomic-edit')
    return [...new Set(shapes)]
}

function validateUnsplittable(input, metrics, dominantShape) {
    if (dominantShape !== 'long-horizon-cross-module') return null
    const evidence = input.machinePartitionEvidence
    if (typeof metrics.unsplittableReason !== 'string' ||
        !metrics.unsplittableReason.trim() ||
        evidence?.schema !==
            'issue-orchestration.slice-partition-evidence.v1' ||
        evidence.source !== 'machine-slice-partition-analyzer' ||
        evidence.safePartitionCount !== 1 ||
        evidence.dependencyCutCount !== 0 ||
        !HASH.test(evidence.evidenceDigest ?? '')) {
        fail('execution-route-unsplittable-evidence-required')
    }
    return evidence.evidenceDigest
}

function compileShape(input, slice, classification, stageDefinition) {
    const metrics = validatedMetrics(input, slice)
    const evidence = input.machineClassificationEvidence
    if (evidence?.schema !==
            'issue-orchestration.execution-shape-observation.v1' ||
        evidence.source !== 'machine-slice-and-runtime-observer' ||
        typeof evidence.observedAt !== 'string' ||
        !evidence.observedAt ||
        !HASH.test(evidence.evidenceDigest ?? '')) {
        fail('execution-route-classification-evidence-required')
    }
    const shapes = shapeCandidates(metrics, slice, stageDefinition)
    const dominantWorkShape = shapes[0]
    const partitionEvidenceDigest =
        validateUnsplittable(input, metrics, dominantWorkShape)
    const evidenceDigest = digest({
        evidence,
        metrics,
        partitionEvidenceDigest,
        sliceDigest: slice.sliceDigest,
        planDigest: slice.planDigest
    })
    return seal({
        schema:
            'issue-orchestration.execution-shape-classification.v1',
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        stageRole: slice.stageRole,
        stagePhase: slice.stagePhase,
        domain: classification.domain,
        engineeringRiskClass: classification.engineeringRiskClass,
        uiDecisionClass: classification.uiDecisionClass,
        verificationClass: classification.verificationClass,
        dominantWorkShape,
        secondaryShapes: shapes.slice(1),
        expectedChangedFileCount: metrics.expectedChangedFileCount,
        ownedModuleCount: metrics.ownedModuleCount,
        commandLoopCount: metrics.commandLoopCount,
        runtimeProbeDepth: metrics.runtimeProbeDepth,
        toolInteractionDepth: metrics.toolInteractionDepth,
        contextBreadth: metrics.contextBreadth,
        statefulContinuationRequired:
            metrics.statefulContinuationRequired,
        checkpointSupportRequired:
            metrics.checkpointSupportRequired,
        firstActionDeterministic: metrics.firstActionDeterministic,
        costSensitivity: metrics.costSensitivity,
        freshContext: metrics.freshContext,
        compiledContextTokens: metrics.compiledContextTokens,
        exactTokenizerAvailable: metrics.exactTokenizerAvailable,
        selfContainedPrompt: metrics.selfContainedPrompt,
        bulkCrossScopeContext: metrics.bulkCrossScopeContext,
        unsplittableReason:
            dominantWorkShape === 'long-horizon-cross-module'
                ? metrics.unsplittableReason
                : null,
        classificationEvidenceDigest: evidenceDigest
    }, 'classificationDigest')
}

function routeCell(routeCellId, selectingPredicates) {
    const cell = ROUTING_POLICY.routeCells?.[routeCellId]
    if (!cell || typeof cell.requiredProfile !== 'string') {
        fail('execution-route-cell-missing', routeCellId)
    }
    return Object.freeze({
        routeCellId,
        routeCellDigest: digest({ routeCellId, cell }),
        requiredProfile: cell.requiredProfile,
        advisorOnly: cell.advisorOnly === true,
        selectingPredicates: Object.freeze(
            structuredClone(selectingPredicates)
        ),
        selectingPredicatesDigest: digest(selectingPredicates)
    })
}

function canonicalRouteCell({
    input,
    shape,
    classification
}) {
    const stageKey = `${shape.stageRole}:${shape.stagePhase}`
    const predicates = {
        stageRole: shape.stageRole,
        stagePhase: shape.stagePhase,
        domain: classification.domain,
        engineeringRiskClass:
            classification.engineeringRiskClass,
        verificationClass: classification.verificationClass,
        uiDecisionClass: classification.uiDecisionClass,
        contractState: classification.contractState,
        dominantWorkShape: shape.dominantWorkShape,
        contextBreadth: shape.contextBreadth,
        continuationRequired:
            shape.statefulContinuationRequired,
        checkpointSupportRequired:
            shape.checkpointSupportRequired,
        toolInteractionDepth: shape.toolInteractionDepth,
        runtimeProbeDepth: shape.runtimeProbeDepth,
        ownedModuleCount: shape.ownedModuleCount,
        expectedChangedFileCount:
            shape.expectedChangedFileCount,
        costSensitivity: shape.costSensitivity,
        dagUpdateClass: input.dagUpdateClass ?? null,
        documentationClass: input.documentationClass ?? null,
        controlPlaneAnomalyClass:
            input.controlPlaneAnomalyClass ?? null,
        frontierException: input.frontierException === true
    }
    const cell = (id) => routeCell(id, predicates)

    if (stageKey === 'root-scheduler:scheduling') {
        if (input.controlPlaneAnomalyClass === 'unknown-complex') {
            if (input.machineAdvisorEvidence?.source !==
                    'machine-control-anomaly-classifier' ||
                !HASH.test(
                    input.machineAdvisorEvidence?.evidenceDigest ?? ''
                )) {
                fail('execution-route-control-advisor-evidence')
            }
            return cell('control.unknown-complex-advisor')
        }
        if (input.controlPlaneRecovery === true ||
            input.recoveryClassification ||
            input.recoveryReceiptDigest ||
            input.takeoverAuthorizationDigest ||
            input.recoveryHandoffDigest ||
            input.oldRootFencingReceiptDigest ||
            input.newParentInvocation !== undefined) {
            fail('routing-root-in-session-upgrade-forbidden')
        }
        return cell('control.normal')
    }
    if (stageKey === 'root-scheduler:recovery-takeover') {
        if (input.controlPlaneRecovery === true ||
            input.newParentInvocation !== true ||
            !HASH.test(input.takeoverAuthorizationDigest ?? '') ||
            !HASH.test(input.recoveryHandoffDigest ?? '') ||
            !HASH.test(input.oldRootFencingReceiptDigest ?? '')) {
            fail('routing-root-takeover-authority-required')
        }
        return cell('control.recovery-takeover')
    }
    if (stageKey === 'dag-creator-updater:semantic-proposal') {
        if (input.frontierException === true) {
            if (classification.engineeringRiskClass !== 'frontier' ||
                input.machineFrontierEvidence?.source !==
                    'machine-frontier-exception-verifier' ||
                !HASH.test(
                    input.machineFrontierEvidence?.evidenceDigest ?? ''
                ) ||
                input.frontierExceptionReceipt?.schema !==
                    'issue-orchestration.frontier-exception-receipt.v1' ||
                input.frontierExceptionReceipt.sliceMinimal !== true ||
                input.frontierExceptionReceipt
                    .solXhighCapabilityInsufficient !== true ||
                !HASH.test(
                    input.frontierExceptionReceipt.evidenceDigest ?? ''
                )) {
                fail('execution-route-frontier-exception-invalid')
            }
            return cell('dag.frontier-advisor')
        }
        if (classification.contractState === 'authority-conflict' ||
            classification.contractState === 'owner-unresolved' ||
            classification.engineeringRiskClass === 'frontier') {
            return cell('dag.authority-topology-conflict')
        }
        return input.dagUpdateClass === 'full-reconstruction'
            ? cell('dag.full-reconstruction')
            : cell('dag.semantic-default')
    }
    if (stageKey === 'code-implementer:landing-conflict-resolution') {
        return cell(`code-landing.${classification.engineeringRiskClass}`)
    }
    if (stageKey === 'code-implementer:implementation') {
        if (classification.domain === 'ui-ux') {
            fail('routing-ui-owner')
        }
        const crossModule = shape.ownedModuleCount > 1 ||
            ['broad', 'very-broad'].includes(shape.contextBreadth)
        const durable = shape.statefulContinuationRequired ||
            shape.checkpointSupportRequired === 'durable'
        const highTool = [
            'high-tool-depth',
            'long-horizon-cross-module'
        ].includes(shape.dominantWorkShape)
        if ((classification.engineeringRiskClass === 'frontier' ||
            highTool && durable && crossModule)) {
            return cell(
                'implementation.high-tool-durable-cross-module'
            )
        }
        if (classification.engineeringRiskClass === 'high-risk') {
            return cell('implementation.high-risk')
        }
        if ([
            'iterative-debug',
            'runtime-probe-heavy',
            'context-heavy'
        ].includes(shape.dominantWorkShape)) {
            return cell('implementation.iterative-runtime-broad')
        }
        if (shape.dominantWorkShape ===
                'luna-fresh-narrow-deep') {
            return cell('implementation.narrow-deep-cost-sensitive')
        }
        if (shape.costSensitivity === 'latency-sensitive' &&
            shape.contextBreadth === 'narrow' &&
            (classification.engineeringRiskClass === 'complex' ||
                shape.toolInteractionDepth >= 4 ||
                shape.commandLoopCount >= 2)) {
            return cell('implementation.narrow-deep-latency-sensitive')
        }
        if (shape.statefulContinuationRequired ||
            shape.ownedModuleCount > 1 ||
            shape.expectedChangedFileCount > 1) {
            return cell('implementation.bounded-stateful-multifile')
        }
        if (shape.dominantWorkShape === 'atomic-edit' &&
            shape.expectedChangedFileCount <= 1 &&
            shape.ownedModuleCount <= 1) {
            return cell('implementation.atomic-mechanical')
        }
        return cell('implementation.ordinary-bounded-single-module')
    }
    if (stageKey.startsWith('test-owner:')) {
        if (['protocol', 'security'].includes(
            classification.verificationClass
        ) || classification.contractState === 'authority-conflict') {
            return cell('verification.protocol-security-authority')
        }
        if (classification.verificationClass === 'runtime' ||
            classification.verificationClass === 'cross-module' ||
            ['high-risk', 'frontier'].includes(
                classification.engineeringRiskClass
            ) ||
            [
                'runtime-probe-heavy',
                'context-heavy',
                'high-tool-depth',
                'long-horizon-cross-module'
            ].includes(shape.dominantWorkShape)) {
            return cell('verification.runtime-lifecycle-cross-module')
        }
        if (shape.dominantWorkShape ===
                'luna-fresh-narrow-deep') {
            return cell('verification.narrow-deep-cost-sensitive')
        }
        if (stageKey !== 'test-owner:test-contract' ||
            classification.engineeringRiskClass === 'complex' ||
            shape.toolInteractionDepth >= 4 ||
            shape.commandLoopCount >= 2) {
            return cell('verification.narrow-complex')
        }
        return cell('verification.focused-authoring')
    }
    if (stageKey === 'ui-ux-implementer:ui-implementation') {
        if (classification.domain !== 'ui-ux') {
            fail('routing-ui-domain')
        }
        if (classification.uiDecisionClass ===
                'system-design-dispute' ||
            [
                'context-heavy',
                'high-tool-depth',
                'long-horizon-cross-module'
            ].includes(shape.dominantWorkShape)) {
            fail('execution-route-ui-reslice-or-adjudicate')
        }
        if (['prescribed', 'bounded-composition'].includes(
            classification.uiDecisionClass
        )) return cell('ui-implementation.prescribed')
        if (['layout-judgment', 'interaction-judgment'].includes(
            classification.uiDecisionClass
        )) return cell('ui-implementation.judgment')
        fail('routing-ui-classification')
    }
    if (stageKey ===
            'ui-ux-implementer:landing-conflict-resolution') {
        if (['protocol', 'security'].includes(
            classification.verificationClass
        ) || classification.contractState === 'authority-conflict') {
            return cell('ui-landing.protocol-security')
        }
        if (classification.verificationClass === 'cross-module' ||
            ['context-heavy', 'high-tool-depth',
                'long-horizon-cross-module']
                .includes(shape.dominantWorkShape)) {
            return cell('ui-landing.cross-module')
        }
        return classification.uiDecisionClass === 'prescribed'
            ? cell('ui-landing.prescribed')
            : cell('ui-landing.composition-judgment')
    }
    if (stageKey === 'ui-system-adjudicator:adjudication') {
        if (classification.domain !== 'ui-ux' ||
            classification.uiDecisionClass !==
                'system-design-dispute') {
            fail('routing-ui-adjudication-not-required')
        }
        return classification.contractState === 'authority-conflict'
            ? cell('ui-adjudication.authority-conflict')
            : cell('ui-adjudication.system-dispute')
    }
    if (stageKey === 'ux-acceptance-verifier:ux-acceptance') {
        if (classification.domain !== 'ui-ux') {
            fail('routing-ui-domain')
        }
        const id = {
            'ux-local': 'ux.local',
            'ux-path': 'ux.path',
            'ux-system': 'ux.system'
        }[classification.verificationClass]
        if (!id) fail('routing-ux-verification-class')
        return cell(id)
    }
    if (stageKey === 'documentation-writer:documentation') {
        if (classification.domain !== 'documentation') {
            fail('routing-documentation-domain')
        }
        return cell({
            'mechanical-no-change': 'documentation.mechanical',
            'cross-module': 'documentation.cross-module',
            'architecture-public-contract':
                'documentation.architecture-public-contract'
        }[input.documentationClass] ??
            'documentation.current-sync')
    }
    fail('execution-route-cell-unmatched')
}

function compileCapabilityRequirement(
    shape,
    stageDefinition,
    selectedRouteCell
) {
    const continuationMode =
        shape.checkpointSupportRequired === 'durable'
            ? 'durable-continuation'
            : shape.statefulContinuationRequired ||
                shape.checkpointSupportRequired === 'resumable'
                ? 'checkpoint-resume'
                : 'none'
    return seal({
        schema:
            'issue-orchestration.stage-capability-requirement.v2',
        sliceId: shape.sliceId,
        sliceDigest: shape.sliceDigest,
        classificationDigest: shape.classificationDigest,
        routeCellId: selectedRouteCell.routeCellId,
        routeCellDigest: selectedRouteCell.routeCellDigest,
        requiredProfile: selectedRouteCell.requiredProfile,
        reviewedAssumptionDigest:
            REVIEWED_ASSUMPTIONS.profiles[
                selectedRouteCell.requiredProfile
            ]?.assumptionDigest ?? null,
        validationMode: 'exact-required-profile-only',
        requiredFreshContext: stageDefinition.freshContext,
        allowedContinuationMode: continuationMode
    }, 'capabilityDigest')
}

function validateExactRouteProfile({
    input,
    selectedRouteCell,
    requirement,
    stageDefinition
}) {
    const requiredProfile = selectedRouteCell.requiredProfile
    const assumption = REVIEWED_ASSUMPTIONS.profiles[requiredProfile]
    if (!stageDefinition.allowedProfiles.includes(requiredProfile) &&
            selectedRouteCell.advisorOnly !== true ||
        !assumption ||
        assumption.policyStatus === 'disabled' ||
        assumption.routeValidation !==
            'exact-required-profile-only' ||
        requirement.reviewedAssumptionDigest !==
            assumption.assumptionDigest) {
        fail('execution-route-required-profile-rejected')
    }
    if (requiredProfile === 'sol-max' &&
        selectedRouteCell.advisorOnly !== true) {
        fail('execution-route-frontier-exception-invalid')
    }
    if (requiredProfile === 'luna-max') {
        return resolveLunaAvailability({
            input,
            requiredProfile,
            stageDefinition,
            selectedProfileReason:
                `${selectedRouteCell.routeCellId}-strict-contract`
        })
    }
    return {
        allowedProfiles: [requiredProfile],
        requiredProfile,
        selectedProfile: requiredProfile,
        selectedProfileReason:
            `${selectedRouteCell.routeCellId}-exact-route-cell`,
        capabilityValidationResult: 'accepted',
        reviewedAssumptionDigest: assumption.assumptionDigest,
        availabilityHandling: 'not-required'
    }
}

function validateAvailabilityBinding(binding) {
    if (binding?.schema !==
            'issue-orchestration.profile-availability-binding.v1' ||
        binding.source !== 'trusted-runtime-catalog-observer' ||
        binding.phase !== 'pre-dispatch' ||
        typeof binding.runtimeInvocationId !== 'string' ||
        !binding.runtimeInvocationId ||
        !HASH.test(binding.packageDigest ?? '') ||
        binding.policyDigest !== EXECUTION_ROUTING_POLICY_DIGEST ||
        typeof binding.observedAt !== 'string' ||
        !binding.observedAt ||
        binding.bindingDigest !== digest(
            Object.fromEntries(Object.entries(binding)
                .filter(([field]) => field !== 'bindingDigest'))
        )) {
        fail('execution-route-availability-binding-invalid')
    }
    const luna = binding.profiles?.['luna-max']
    if (!luna || typeof luna.available !== 'boolean' ||
        luna.available && luna.reason !== null ||
        !luna.available &&
            !ROUTING_POLICY.lunaAvailabilityFallback.allowedReasons
                .includes(luna.reason)) {
        fail('execution-route-luna-availability-unproven')
    }
    return binding
}

function resolveLunaAvailability({
    input,
    requiredProfile,
    stageDefinition,
    selectedProfileReason
}) {
    const binding = validateAvailabilityBinding(
        input.runtimeAvailabilityBinding
    )
    const luna = binding.profiles['luna-max']
    if (luna.available) {
        return {
            allowedProfiles: ['luna-max'],
            requiredProfile,
            selectedProfile: 'luna-max',
            selectedProfileReason,
            capabilityValidationResult: 'accepted',
            reviewedAssumptionDigest:
                REVIEWED_ASSUMPTIONS.profiles['luna-max']
                    .assumptionDigest,
            availabilityHandling: 'primary-available',
            availabilityBindingDigest: binding.bindingDigest,
            availabilityFallbackReason: null
        }
    }
    if (!stageDefinition.allowedProfiles.includes('terra-high')) {
        fail('execution-route-luna-fallback-unreachable')
    }
    return {
        allowedProfiles: ['luna-max', 'terra-high'],
        requiredProfile,
        selectedProfile: 'terra-high',
        selectedProfileReason: 'luna-pre-dispatch-unavailable-fixed-fallback',
        capabilityValidationResult: 'accepted',
        reviewedAssumptionDigest:
            REVIEWED_ASSUMPTIONS.profiles['luna-max']
                .assumptionDigest,
        availabilityHandling: 'fixed-fallback',
        availabilityBindingDigest: binding.bindingDigest,
        availabilityFallbackReason: luna.reason
    }
}

function validateRuntimeObservation(observation, selectedProfile) {
    if (observation === undefined) {
        return {
            status: 'pending-observation',
            runtimeInvocationId: null,
            runtimeIdentityDigest: null
        }
    }
    const unsigned = structuredClone(observation)
    delete unsigned.observationDigest
    if (observation?.schema !==
            'issue-orchestration.runtime-capability-observation.v2' ||
        observation.source !==
            'per-dispatch-runtime-identity-observer' ||
        observation.observable !== true ||
        typeof observation.runtimeInvocationId !== 'string' ||
        !observation.runtimeInvocationId ||
        typeof observation.sessionOrThreadId !== 'string' ||
        !observation.sessionOrThreadId ||
        typeof observation.runtimeVersion !== 'string' ||
        !observation.runtimeVersion ||
        typeof observation.observedAt !== 'string' ||
        !observation.observedAt ||
        observation.requestedProfile !== selectedProfile ||
        observation.effectiveProfile !== selectedProfile ||
        !HASH.test(observation.rawEventDigest ?? '') ||
        !HASH.test(observation.rawSessionDigest ?? '') ||
        !HASH.test(observation.rawTurnDigest ?? '') ||
        observation.observationDigest !== digest(unsigned)) {
        fail('execution-route-runtime-unobservable')
    }
    try {
        verifyRuntimeProfileMetadata({
            selectedProfile,
            requestedModel: observation.requestedModel,
            effectiveModel: observation.effectiveModel,
            requestedEffort: observation.requestedEffort,
            effectiveEffort: observation.effectiveEffort,
            multiAgentBackend: observation.multiAgentBackend
        })
    } catch {
        fail('execution-route-runtime-profile-mismatch')
    }
    return {
        status: 'verified',
        runtimeInvocationId: observation.runtimeInvocationId,
        runtimeIdentityDigest: observation.observationDigest
    }
}

function compileDecision({
    input,
    shape,
    requirement,
    stageDefinition,
    selectedRouteCell
}) {
    const selected = validateExactRouteProfile({
        input,
        selectedRouteCell,
        requirement,
        stageDefinition
    })
    const runtimeIdentity = validateRuntimeObservation(
        input.runtimeCapabilityObservation,
        selected.selectedProfile
    )
    const runtime = splitProfile(selected.selectedProfile)
    if (input.runtimeExecutionBinding !== undefined) {
        validateRuntimeExecutionBinding(
            input.runtimeExecutionBinding,
            {
                stageRole: shape.stageRole,
                stagePhase: shape.stagePhase,
                selectedProfile: selected.selectedProfile,
                routeDecisionDigest:
                    input.runtimeExecutionBinding
                        .routeDecisionDigest,
                startup: input.startup,
                runtimeTrustBinding:
                    input.runtimeTrustBinding,
                repositoryTargets:
                    input.repositoryTargets
            }
        )
    }
    return seal({
        schema: 'issue-orchestration.execution-route-decision.v2',
        policyVersion: ROUTING_POLICY.version,
        modelPoolPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
        routingAuthority: ROUTING_POLICY.routingAuthority,
        sliceId: shape.sliceId,
        sliceDigest: shape.sliceDigest,
        stageRole: shape.stageRole,
        stagePhase: shape.stagePhase,
        classificationDigest: shape.classificationDigest,
        capabilityDigest: requirement.capabilityDigest,
        routeCellId: selectedRouteCell.routeCellId,
        routeCellDigest: selectedRouteCell.routeCellDigest,
        selectingPredicates:
            selectedRouteCell.selectingPredicates,
        selectingPredicatesDigest:
            selectedRouteCell.selectingPredicatesDigest,
        canonicalPolicyDigest:
            EXECUTION_ROUTING_POLICY_DIGEST,
        requiredProfile: selected.requiredProfile,
        capabilityValidationResult:
            selected.capabilityValidationResult,
        reviewedAssumptionDigest:
            selected.reviewedAssumptionDigest,
        allowedProfiles: selected.allowedProfiles,
        selectedProfile: selected.selectedProfile,
        selectedProfileReason: selected.selectedProfileReason,
        requestedModel: runtime.model,
        requestedEffort: runtime.effort,
        multiAgentBackend:
            STAGE_MODEL_POOL_POLICY.profiles[
                selected.selectedProfile
            ].multiAgentBackend,
        executionClass: stageDefinition.executionClass,
        runtimeExecutionBindingDigest:
            input.runtimeExecutionBinding?.bindingDigest ?? null,
        runtimeExecutionBindingStatus:
            input.runtimeExecutionBinding === undefined
                ? 'pending-observation'
                : 'verified',
        runtimeVerificationStatus: runtimeIdentity.status,
        runtimeInvocationId:
            runtimeIdentity.runtimeInvocationId,
        runtimeIdentityDigest:
            runtimeIdentity.runtimeIdentityDigest,
        availabilityHandling:
            selected.availabilityHandling,
        availabilityBindingDigest:
            selected.availabilityBindingDigest ?? null,
        availabilityFallbackReason:
            selected.availabilityFallbackReason ?? null,
        previousRouteDecisionDigest: null,
        previousFailureReceiptDigest: null,
        retryAuthorizationDigest: null,
        previousCandidateReceiptDigest: null
    }, 'routeDecisionDigest')
}

function compileStageOnlyShape(input, classification, stageDefinition) {
    const stageRole = input.stageRole
    const stagePhase = input.stagePhase
    const stageSubject = {
        stageRole,
        stagePhase,
        classification,
        dagUpdateClass: input.dagUpdateClass ?? null,
        documentationClass: input.documentationClass ?? null,
        controlPlaneAnomalyClass:
            input.controlPlaneAnomalyClass ?? null,
        frontierException: input.frontierException === true,
        modelRoutingEvidenceDigest:
            classification.modelRoutingEvidenceDigest
    }
    const sliceDigest = digest(stageSubject)
    const metrics = {
        expectedChangedFileCount: 0,
        ownedModuleCount: 0,
        commandLoopCount: 0,
        runtimeProbeDepth:
            classification.verificationClass === 'runtime' ? 4 : 0,
        toolInteractionDepth:
            input.dagUpdateClass === 'full-reconstruction' ? 8 : 1,
        contextBreadth:
            classification.verificationClass === 'cross-module'
                ? 'broad'
                : 'narrow',
        statefulContinuationRequired: false,
        checkpointSupportRequired: 'simple',
        firstActionDeterministic: true,
        costSensitivity: input.costSensitivity ?? 'neutral',
        freshContext: stageDefinition.freshContext,
        compiledContextTokens: null,
        exactTokenizerAvailable: false,
        selfContainedPrompt: false,
        bulkCrossScopeContext: false
    }
    const shapes = []
    if (metrics.runtimeProbeDepth >= 4) {
        shapes.push('runtime-probe-heavy')
    }
    if (metrics.contextBreadth === 'broad') {
        shapes.push('context-heavy')
    }
    if (stageDefinition.writeScope === 'none') {
        shapes.push('focused-observe-only')
    }
    shapes.push('atomic-edit')
    const dominantWorkShape = shapes[0]
    return seal({
        schema:
            'issue-orchestration.execution-shape-classification.v1',
        sliceId: `stage-only:${stageRole}:${stagePhase}`,
        sliceDigest,
        stageRole,
        stagePhase,
        domain: classification.domain,
        engineeringRiskClass:
            classification.engineeringRiskClass,
        uiDecisionClass: classification.uiDecisionClass,
        verificationClass: classification.verificationClass,
        dominantWorkShape,
        secondaryShapes: [...new Set(shapes)].slice(1),
        ...metrics,
        unsplittableReason: null,
        classificationEvidenceDigest: digest(stageSubject)
    }, 'classificationDigest')
}

export function compileCanonicalRoute(input = {}) {
    assertNoForbiddenInputs(input)
    let classification
    try {
        classification = validateRoutingClassification(
            input.routingClassification ?? input
        )
    } catch {
        fail('execution-route-routing-classification-invalid')
    }
    const hasSlice = input.stageWorkPlan !== undefined ||
        input.executableSlice !== undefined
    const slice = hasSlice ? verifiedSlice(input) : null
    const stageRole = slice?.stageRole ?? input.stageRole
    const stagePhase = slice?.stagePhase ?? input.stagePhase
    if (slice && (slice.stageRole !== input.stageWorkPlan.stageRole ||
        slice.stagePhase !== input.stageWorkPlan.stagePhase)) {
        fail('execution-route-stage-binding')
    }
    const stageKey = `${stageRole}:${stagePhase}`
    const stageDefinition = STAGE_ROUTE_DEFINITIONS[stageKey]
    if (!stageDefinition) fail('execution-route-stage-binding')
    if (!slice && stageDefinition.executionClass === 'leased-writer') {
        fail('execution-route-verified-slice-required')
    }
    if (!slice) {
        compileStageRoutingIdentity({
            ...classification,
            stageRole,
            stagePhase,
            requiredSkillDigests:
                input.requiredSkillDigests ?? []
        })
    }
    const executionShapeClassification = slice
        ? compileShape(
            input,
            slice,
            classification,
            stageDefinition
        )
        : compileStageOnlyShape(
            input,
            classification,
            stageDefinition
        )
    const selectedRouteCell = canonicalRouteCell({
        input,
        shape: executionShapeClassification,
        classification
    })
    const stageCapabilityRequirement = compileCapabilityRequirement(
        executionShapeClassification,
        stageDefinition,
        selectedRouteCell
    )
    const executionRouteDecision = compileDecision({
        input,
        shape: executionShapeClassification,
        requirement: stageCapabilityRequirement,
        stageDefinition,
        selectedRouteCell
    })
    return Object.freeze({
        schema: 'issue-orchestration.execution-route-bundle.v1',
        executionShapeClassification,
        stageCapabilityRequirement,
        executionRouteDecision
    })
}
