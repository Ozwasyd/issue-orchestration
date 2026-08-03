import {
    assertDigest,
    assertText,
    fail,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    validateExecutionRouteDecision,
    validateRouteBoundActor
} from './execution-route-compiler.mjs'

function validateAcceptanceContract(value) {
    if (value?.schema !==
            'issue-orchestration.issue-acceptance-contract.v1' ||
        value.status !== 'frozen' ||
        value.contractDigest !==
            unsignedDigest(value, 'contractDigest')) {
        fail('test-planning-acceptance-contract')
    }
    return value
}

function validateRoute(value, phase) {
    try {
        return validateExecutionRouteDecision(value, {
            stageRole: 'test-owner',
            stagePhase: phase
        })
    } catch {
        fail('test-planning-route')
    }
}

export function compileTestContractPlanningRequest({
    nodeDiscoveredReceipt,
    acceptanceContract,
    routeDecision,
    attemptId
}) {
    const acceptance = validateAcceptanceContract(acceptanceContract)
    if (nodeDiscoveredReceipt?.schema !==
            'issue-orchestration.node-discovered-receipt.v1' ||
        nodeDiscoveredReceipt.repository !== acceptance.repository ||
        nodeDiscoveredReceipt.issueNumber !== acceptance.issueNumber) {
        fail('test-planning-node-discovered')
    }
    assertDigest(
        nodeDiscoveredReceipt.receiptDigest,
        'test-planning-node-discovered'
    )
    const route = validateRoute(
        routeDecision,
        'test-contract-planning'
    )
    assertText(attemptId, 'test-planning-attempt')
    return seal({
        schema:
            'issue-orchestration.test-contract-planning-request.v1',
        phase: 'test-contract-planning',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        freshContext: true,
        attemptId,
        repository: acceptance.repository,
        issueNumber: acceptance.issueNumber,
        nodeDiscoveredReceiptDigest:
            nodeDiscoveredReceipt.receiptDigest,
        acceptanceContractDigest: acceptance.contractDigest,
        routeDecisionDigest: route.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            route.runtimeExecutionBindingDigest,
        allowedInputs: [
            'immutable-acceptance-contract',
            'repository-facts',
            'current-tests',
            'current-docs',
            'necessary-runtime-probes'
        ],
        forbiddenWrites: ['tests', 'implementation', 'documentation', 'dag']
    }, 'requestDigest')
}

export function verifyTestContractPlanReceipt({
    receipt,
    request
}) {
    if (receipt?.schema !==
            'issue-orchestration.test-contract-plan-receipt.v1' ||
        receipt.status !== 'verified' ||
        receipt.rootAuthored !== false) {
        fail('test-planning-authority')
    }
    try {
        validateRouteBoundActor({
            actor: receipt,
            stageRole: 'test-owner',
            stagePhase: 'test-contract-planning',
            proposalOnly: true
        })
    } catch {
        fail('test-planning-authority')
    }
    if (receipt.attemptId !== request?.attemptId ||
        receipt.acceptanceContractDigest !==
            request.acceptanceContractDigest ||
        receipt.runtimeExecutionBindingDigest !==
            request.runtimeExecutionBindingDigest) {
        fail('test-planning-request-binding')
    }
    assertDigest(
        receipt.mutationPostconditionReceiptDigest,
        'test-planning-mutation-postcondition'
    )
    if (!Array.isArray(receipt.filesystemWrites) ||
        receipt.filesystemWrites.length !== 0) {
        fail('test-planning-protected-mutation')
    }
    for (const field of [
        'testPaths',
        'commands',
        'fixturePaths',
        'runtimeProbes',
        'stageBoundaries'
    ]) {
        if (!Array.isArray(receipt[field])) {
            fail('test-planning-output')
        }
    }
    assertDigest(
        receipt.sliceProposalDigest,
        'test-planning-slice-proposal'
    )
    if (receipt.receiptDigest !==
        unsignedDigest(receipt, 'receiptDigest')) {
        fail('test-planning-receipt-digest')
    }
    return Object.freeze(structuredClone(receipt))
}

export function compileTestContractWriterDispatch(input) {
    if (input?.preexistingFrozenContract) {
        fail('test-contract-cold-start-fabricated-history')
    }
    const acceptance = validateAcceptanceContract(
        input?.acceptanceContract
    )
    const planning = input?.planningReceipt
    if (planning?.schema !==
            'issue-orchestration.test-contract-plan-receipt.v1' ||
        planning.status !== 'verified' ||
        planning.acceptanceContractDigest !==
            acceptance.contractDigest ||
        planning.receiptDigest !==
            unsignedDigest(planning, 'receiptDigest')) {
        fail('test-contract-planning-receipt')
    }
    const route = validateRoute(
        input.routeDecision,
        'test-contract'
    )
    assertText(input.writerAttemptId, 'test-contract-writer-attempt')
    if (input.writerAttemptId === planning.attemptId) {
        fail('test-contract-attempt-separation')
    }
    if (input.resourceReceipt?.status !== 'acquired') {
        fail('test-contract-resource-acquisition')
    }
    assertText(
        input.resourceReceipt.leaseId,
        'test-contract-resource-acquisition'
    )
    assertDigest(
        input.resourceReceipt.receiptDigest,
        'test-contract-resource-acquisition'
    )
    for (const [field, code] of [
        ['compiledPlanDigest', 'test-contract-plan-required'],
        ['executableSliceDigest', 'test-contract-slice-required'],
        ['compiledPromptDigest', 'test-contract-prompt-required']
    ]) assertDigest(input[field], code)
    if (input.fullIssueBody !== undefined ||
        input.callerSuppliedAuthority !== undefined ||
        input.unboundTestOnly === true) {
        fail('test-contract-writer-input-boundary')
    }
    return seal({
        schema:
            'issue-orchestration.test-contract-writer-dispatch.v1',
        status: 'dispatch-authorized',
        phase: 'test-contract',
        executionClass: 'leased-writer',
        mutationContract: 'lease-and-slice-allowlist',
        writeScope: 'tests-only',
        planningAttemptId: planning.attemptId,
        writerAttemptId: input.writerAttemptId,
        acceptanceContractDigest: acceptance.contractDigest,
        planningReceiptDigest: planning.receiptDigest,
        routeDecisionDigest: route.routeDecisionDigest,
        runtimeExecutionBindingDigest:
            route.runtimeExecutionBindingDigest,
        resourceReceiptDigest:
            input.resourceReceipt.receiptDigest,
        leaseId: input.resourceReceipt.leaseId,
        compiledPlanDigest: input.compiledPlanDigest,
        executableSliceDigest: input.executableSliceDigest,
        compiledPromptDigest: input.compiledPromptDigest,
        fullIssueBodyIncluded: false
    }, 'dispatchDigest')
}

export function recoverTestContractColdStart({
    planningReceipt,
    frozenTestContract
}) {
    if (frozenTestContract?.status === 'frozen') {
        assertDigest(
            frozenTestContract.contractDigest,
            'test-contract-frozen-recovery'
        )
        return Object.freeze({
            action: 'resume-after-frozen-contract',
            frozenContractDigest:
                frozenTestContract.contractDigest
        })
    }
    if (planningReceipt?.status !== 'verified') {
        fail('test-contract-planning-recovery')
    }
    assertDigest(
        planningReceipt.receiptDigest,
        'test-contract-planning-recovery'
    )
    return Object.freeze({
        action: 'resume-writer-dispatch',
        planningReceiptDigest: planningReceipt.receiptDigest
    })
}
