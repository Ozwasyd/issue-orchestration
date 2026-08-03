// Shared lifecycle contract for startup validation and action compilation.

export const LIFECYCLE_SCHEMA = 'issue-orchestration.lifecycle-state-machine.v1'

const definitions = {
    discovered: {
        requiredReceipts: [],
        allowedReceipts: [],
        next: ['acceptance-frozen']
    },
    'acceptance-frozen': {
        requiredReceipts: ['requirementInventory', 'acceptanceContract'],
        allowedReceipts: ['requirementInventory', 'acceptanceContract'],
        next: ['test-contract-planning']
    },
    'test-contract-planning': {
        requiredReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt'
        ],
        next: ['test-contract-frozen']
    },
    'test-contract-frozen': {
        requiredReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt', 'testContractPlan',
            'slicePlanProposal', 'slicePlanValidation', 'workPlan',
            'executableSlice', 'routeDecision', 'compiledPrompt',
            'resourceAcquisition'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt', 'testContractPlan',
            'slicePlanProposal', 'slicePlanValidation', 'workPlan',
            'executableSlice', 'routeDecision', 'compiledPrompt',
            'resourceAcquisition'
        ],
        next: ['implementing']
    },
    implementing: {
        requiredReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt', 'testContractPlan',
            'slicePlanProposal', 'slicePlanValidation', 'workPlan',
            'executableSlice', 'routeDecision', 'compiledPrompt',
            'resourceAcquisition', 'writerDispatch', 'activeAttempt',
            'writeLease'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt', 'testContractPlan',
            'slicePlanProposal', 'slicePlanValidation', 'workPlan',
            'executableSlice', 'routeDecision', 'compiledPrompt',
            'resourceAcquisition', 'writerDispatch', 'activeAttempt',
            'writeLease', 'writerCheckpoint', 'writerFailure',
            'retryAuthorization'
        ],
        next: ['candidate-green', 'terminal']
    },
    'candidate-green': {
        requiredReceipts: [
            'requirementInventory', 'acceptanceContract',
            'testContractPlan', 'workPlan', 'executableSlice',
            'routeDecision', 'implementationTerminal', 'candidate'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt', 'testContractPlan',
            'slicePlanProposal', 'slicePlanValidation', 'workPlan',
            'executableSlice', 'routeDecision', 'compiledPrompt',
            'resourceAcquisition', 'writerDispatch', 'activeAttempt',
            'writeLease', 'writerCheckpoint', 'writerFailure',
            'retryAuthorization', 'implementationTerminal', 'candidate'
        ],
        next: ['behavior-green', 'terminal']
    },
    'behavior-green': {
        requiredReceipts: [
            'requirementInventory', 'acceptanceContract',
            'implementationTerminal', 'candidate', 'behavior'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract',
            'planningRoute', 'planningAttempt', 'testContractPlan',
            'slicePlanProposal', 'slicePlanValidation', 'workPlan',
            'executableSlice', 'routeDecision', 'compiledPrompt',
            'resourceAcquisition', 'writerDispatch', 'activeAttempt',
            'writeLease', 'writerCheckpoint', 'writerFailure',
            'retryAuthorization', 'implementationTerminal', 'candidate',
            'behavior'
        ],
        next: [
            'ui-adjudicating', 'documenting', 'delivery-ready', 'terminal'
        ]
    },
    'ui-adjudicating': {
        requiredReceipts: ['candidate', 'behavior', 'uiAdjudicationRoute'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudicationRoute'
        ],
        next: ['ux-acceptance', 'terminal']
    },
    'ux-acceptance': {
        requiredReceipts: [
            'candidate', 'behavior', 'uiAdjudication', 'uxAcceptanceRoute'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudicationRoute', 'uiAdjudication',
            'uxAcceptanceRoute'
        ],
        next: ['ux-accepted', 'terminal']
    },
    'ux-accepted': {
        requiredReceipts: [
            'candidate', 'behavior', 'uiAdjudication', 'uxAcceptance'
        ],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudicationRoute', 'uiAdjudication',
            'uxAcceptanceRoute', 'uxAcceptance'
        ],
        next: ['documenting', 'delivery-ready', 'terminal']
    },
    documenting: {
        requiredReceipts: ['candidate', 'behavior', 'documentationRoute'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance',
            'documentationRoute'
        ],
        next: ['documentation-green', 'terminal']
    },
    'documentation-green': {
        requiredReceipts: ['candidate', 'behavior', 'documentation'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance',
            'documentationRoute', 'documentation'
        ],
        next: ['delivery-ready', 'terminal']
    },
    'delivery-ready': {
        requiredReceipts: ['candidate', 'behavior'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance', 'documentation'
        ],
        next: ['delivering', 'terminal']
    },
    delivering: {
        requiredReceipts: ['candidate', 'behavior', 'deliveryAttempt'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance', 'documentation',
            'deliveryAttempt', 'delivery'
        ],
        next: ['cleaning', 'terminal']
    },
    cleaning: {
        requiredReceipts: ['delivery', 'cleanupAuthorization'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance', 'documentation',
            'deliveryAttempt', 'delivery', 'cleanupAuthorization', 'cleanup'
        ],
        next: ['closed', 'terminal']
    },
    closed: {
        requiredReceipts: ['delivery', 'cleanup', 'closure'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance', 'documentation',
            'deliveryAttempt', 'delivery', 'cleanupAuthorization', 'cleanup',
            'closure'
        ],
        next: []
    },
    terminal: {
        requiredReceipts: ['terminal'],
        allowedReceipts: [
            'requirementInventory', 'acceptanceContract', 'candidate',
            'behavior', 'uiAdjudication', 'uxAcceptance', 'documentation',
            'deliveryAttempt', 'delivery', 'cleanupAuthorization', 'cleanup',
            'terminal'
        ],
        next: []
    }
}

export const LIFECYCLE_STATE_DEFINITIONS = Object.freeze(
    Object.fromEntries(Object.entries(definitions).map(([state, definition]) => [
        state,
        Object.freeze({
            requiredReceipts: Object.freeze([...definition.requiredReceipts]),
            allowedReceipts: Object.freeze([...definition.allowedReceipts]),
            next: Object.freeze([...definition.next])
        })
    ]))
)

export const LIFECYCLE_STATES = Object.freeze(
    Object.keys(LIFECYCLE_STATE_DEFINITIONS)
)

export function lifecycleDefinition(state) {
    return LIFECYCLE_STATE_DEFINITIONS[state] ?? null
}

export function assertLifecycleTransition(fromState, toState) {
    const definition = lifecycleDefinition(fromState)
    if (!definition || !definition.next.includes(toState)) {
        const error = new Error('lifecycle-transition-forbidden')
        error.code = 'lifecycle-transition-forbidden'
        throw error
    }
    return { valid: true, fromState, toState }
}
