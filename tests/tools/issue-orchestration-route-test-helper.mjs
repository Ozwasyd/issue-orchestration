import { createHash } from 'node:crypto'

import {
    EXECUTION_ROUTING_AUTHORITY,
    EXECUTION_ROUTING_POLICY,
    EXECUTION_ROUTING_POLICY_DIGEST,
    EXECUTION_ROUTING_POLICY_VERSION,
    REVIEWED_ROUTING_ASSUMPTIONS
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    STAGE_MODEL_POOL_POLICY,
    STAGE_ROUTE_DEFINITIONS,
    splitProfile
} from '../../skills/issue-orchestration/scripts/stage-profile-policy.mjs'

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

export function routeTestDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

const ROUTE_CELL_BY_STAGE_PROFILE = Object.freeze({
    'root-scheduler:scheduling': {
        'terra-low': 'control.normal'
    },
    'root-scheduler:recovery-takeover': {
        'terra-medium': 'control.recovery-takeover'
    },
    'dag-creator-updater:semantic-proposal': {
        'terra-high': 'dag.semantic-default',
        'sol-high': 'dag.full-reconstruction',
        'sol-xhigh': 'dag.authority-topology-conflict',
        'sol-max': 'dag.frontier-advisor'
    },
    'test-owner:test-contract-planning': {
        'terra-high': 'verification.narrow-complex',
        'sol-high': 'verification.runtime-lifecycle-cross-module',
        'sol-xhigh': 'verification.protocol-security-authority'
    },
    'test-owner:test-contract': {
        'terra-medium': 'verification.focused-authoring',
        'terra-high': 'verification.narrow-complex',
        'sol-high': 'verification.runtime-lifecycle-cross-module',
        'sol-xhigh': 'verification.protocol-security-authority'
    },
    'test-owner:behavior-verification': {
        'terra-high': 'verification.narrow-complex',
        'sol-high': 'verification.runtime-lifecycle-cross-module',
        'sol-xhigh': 'verification.protocol-security-authority'
    },
    'code-implementer:implementation': {
        'terra-low': 'implementation.atomic-mechanical',
        'terra-medium': 'implementation.ordinary-bounded-single-module',
        'terra-high': 'implementation.narrow-deep-latency-sensitive',
        'sol-medium': 'implementation.bounded-stateful-multifile',
        'sol-high': 'implementation.high-risk',
        'sol-xhigh': 'implementation.high-tool-durable-cross-module'
    },
    'code-implementer:landing-conflict-resolution': {
        'terra-medium': 'code-landing.bounded',
        'terra-high': 'code-landing.complex',
        'sol-high': 'code-landing.high-risk',
        'sol-xhigh': 'code-landing.frontier'
    },
    'ui-ux-implementer:ui-implementation': {
        'sol-low': 'ui-implementation.prescribed',
        'sol-medium': 'ui-implementation.judgment'
    },
    'ui-ux-implementer:landing-conflict-resolution': {
        'terra-medium': 'ui-landing.prescribed',
        'terra-high': 'ui-landing.composition-judgment',
        'sol-medium': 'ui-landing.composition-judgment',
        'sol-high': 'ui-landing.cross-module',
        'sol-xhigh': 'ui-landing.protocol-security'
    },
    'ui-system-adjudicator:adjudication': {
        'sol-high': 'ui-adjudication.system-dispute',
        'sol-xhigh': 'ui-adjudication.authority-conflict'
    },
    'ux-acceptance-verifier:ux-acceptance': {
        'sol-medium': 'ux.local',
        'sol-high': 'ux.path',
        'sol-xhigh': 'ux.system'
    },
    'documentation-writer:documentation': {
        'terra-low': 'documentation.mechanical',
        'terra-medium': 'documentation.current-sync',
        'sol-medium': 'documentation.cross-module',
        'sol-high': 'documentation.architecture-public-contract'
    }
})

function routeCellFor(stageRole, stagePhase, profileId) {
    const stageKey = `${stageRole}:${stagePhase}`
    const routeCellId = ROUTE_CELL_BY_STAGE_PROFILE[stageKey]?.[profileId]
    const cell = EXECUTION_ROUTING_POLICY.routeCells?.[routeCellId]
    if (!routeCellId || !cell) throw new Error('unknown-test-route-cell')
    return { routeCellId, cell }
}

export function routeDecisionFor({
    stageRole,
    stagePhase,
    selectedProfile,
    suffix = `${stageRole}:${stagePhase}`,
    overrides = {}
}) {
    const definition = STAGE_ROUTE_DEFINITIONS[
        `${stageRole}:${stagePhase}`
    ]
    if (!definition) throw new Error('unknown-test-stage')
    const profileId = selectedProfile ?? definition.defaultProfile
    const profile = splitProfile(profileId)
    const { routeCellId, cell } = routeCellFor(
        stageRole,
        stagePhase,
        profileId
    )
    const selectingPredicates = {
        stageRole,
        stagePhase,
        fixture: suffix
    }
    const route = {
        schema: 'issue-orchestration.execution-route-decision.v2',
        policyVersion: EXECUTION_ROUTING_POLICY_VERSION,
        modelPoolPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
        routingAuthority: EXECUTION_ROUTING_AUTHORITY,
        sliceId: `slice:${suffix}`,
        sliceDigest: routeTestDigest(`slice:${suffix}`),
        stageRole,
        stagePhase,
        classificationDigest: routeTestDigest(`classification:${suffix}`),
        capabilityDigest: routeTestDigest(`capability:${suffix}`),
        routeCellId,
        routeCellDigest: routeTestDigest({ routeCellId, cell }),
        selectingPredicates,
        selectingPredicatesDigest: routeTestDigest(selectingPredicates),
        canonicalPolicyDigest: EXECUTION_ROUTING_POLICY_DIGEST,
        requiredProfile: cell.requiredProfile,
        capabilityValidationResult: 'accepted',
        reviewedAssumptionDigest:
            REVIEWED_ROUTING_ASSUMPTIONS.profiles[profileId]
                .assumptionDigest,
        allowedProfiles: [...definition.allowedProfiles],
        selectedProfile: profileId,
        selectedProfileReason: 'test-policy-selection',
        requestedModel: profile.model,
        requestedEffort: profile.effort,
        multiAgentBackend:
            STAGE_MODEL_POOL_POLICY.profiles[profileId].multiAgentBackend,
        executionClass: definition.executionClass,
        runtimeExecutionBindingDigest: routeTestDigest(`runtime:${suffix}`),
        runtimeExecutionBindingStatus: 'verified',
        runtimeVerificationStatus: 'verified',
        runtimeInvocationId: `runtime:${suffix}`,
        runtimeIdentityDigest: routeTestDigest(`identity:${suffix}`),
        availabilityHandling: 'not-required',
        availabilityBindingDigest: null,
        availabilityFallbackReason: null,
        previousRouteDecisionDigest: null,
        previousFailureReceiptDigest: null,
        retryAuthorizationDigest: null,
        previousCandidateReceiptDigest: null,
        routeDecisionDigest: null,
        ...structuredClone(overrides)
    }
    delete route.routeDecisionDigest
    route.routeDecisionDigest = routeTestDigest(route)
    return route
}

export function routeActorFor({
    stageRole,
    stagePhase,
    actorId = `${stageRole}:${stagePhase}:fixture`,
    selectedProfile,
    proposalOnly,
    suffix,
    routeOverrides,
    actorOverrides = {}
}) {
    const routeDecision = routeDecisionFor({
        stageRole,
        stagePhase,
        selectedProfile,
        suffix,
        overrides: routeOverrides
    })
    const definition = STAGE_ROUTE_DEFINITIONS[
        `${stageRole}:${stagePhase}`
    ]
    return {
        role: stageRole,
        actorRole: stageRole,
        phase: stagePhase,
        stagePhase,
        actorId,
        routeDecisionDigest: routeDecision.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            routeDecision.runtimeExecutionBindingDigest,
        executionClass: definition.executionClass,
        mutationContract: definition.mutationContract,
        writeScope: definition.writeScope,
        freshContext: definition.freshContext,
        proposalOnly: proposalOnly ??
            definition.outputAuthority.endsWith('only'),
        mutationPostconditionEvidenceDigest:
            routeTestDigest(`mutation:${actorId}`),
        mutationPostconditionReceiptDigest:
            routeTestDigest(`mutation:${actorId}`),
        executionRouteDecision: routeDecision,
        routeDecision,
        ...structuredClone(actorOverrides)
    }
}
