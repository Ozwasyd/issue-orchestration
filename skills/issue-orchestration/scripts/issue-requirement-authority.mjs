import {
    assertArray,
    assertDigest,
    assertText,
    digest,
    fail,
    sameValue,
    seal,
    uniqueSorted,
    unsignedDigest
} from './runtime-contract-lib.mjs'

const CLASSIFICATIONS = new Set([
    'acceptance',
    'constraint',
    'non-goal',
    'context',
    'authority-choice-required'
])

function validateSnapshot(snapshot) {
    if (!snapshot ||
        typeof snapshot.repository !== 'string' ||
        !/^[^/\s]+\/[^/\s]+$/u.test(snapshot.repository) ||
        !Number.isInteger(snapshot.issueNumber) ||
        snapshot.issueNumber < 1) {
        fail('requirement-snapshot-identity')
    }
    assertDigest(
        snapshot.selectorReceiptDigest,
        'requirement-selector-binding'
    )
    assertDigest(
        snapshot.remoteSnapshotDigest,
        'requirement-remote-binding'
    )
    const blocks = assertArray(
        snapshot.normativeBlocks,
        'requirement-source-coverage',
        { min: 1 }
    )
    const identities = new Set()
    for (const block of blocks) {
        assertText(block.sourceIdentity, 'requirement-source-identity')
        assertDigest(block.spanDigest, 'requirement-source-span')
        if (identities.has(block.sourceIdentity)) {
            fail('requirement-source-duplicate')
        }
        identities.add(block.sourceIdentity)
        if (!['body', 'comment', 'title'].includes(block.sourceKind)) {
            fail('requirement-source-kind')
        }
        if (block.sourceKind === 'comment' &&
            block.relevantToCorrectness !== true) {
            fail('requirement-comment-relevance')
        }
    }
    return blocks
}

function requirementId(snapshot, block) {
    return `REQ-${digest({
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        sourceIdentity: block.sourceIdentity,
        spanDigest: block.spanDigest
    }).slice(0, 24)}`
}

export function compileRequirementInventory({
    snapshot,
    proposal,
    rootDecision
}) {
    const blocks = validateSnapshot(snapshot)
    if (proposal?.schema !==
            'issue-orchestration.issue-requirement-inventory-proposal.v1' ||
        proposal.actorRole !== 'dag-creator-updater' ||
        proposal.rootAuthored !== false ||
        proposal.repository !== snapshot.repository ||
        proposal.issueNumber !== snapshot.issueNumber ||
        proposal.selectorReceiptDigest !==
            snapshot.selectorReceiptDigest ||
        proposal.remoteSnapshotDigest !==
            snapshot.remoteSnapshotDigest) {
        fail('requirement-proposal-drift')
    }
    if (rootDecision?.action !== 'accept' ||
        rootDecision.proposalDigest !== proposal.proposalDigest ||
        rootDecision.modified !== false) {
        fail('requirement-root-modification')
    }
    const classifications = assertArray(
        proposal.classifications,
        'requirement-source-coverage'
    )
    if (classifications.length !== blocks.length) {
        fail('requirement-source-coverage')
    }
    const bySource = new Map()
    for (const entry of classifications) {
        if (!CLASSIFICATIONS.has(entry.classification) ||
            bySource.has(entry.sourceIdentity)) {
            fail('requirement-source-coverage')
        }
        bySource.set(entry.sourceIdentity, entry)
    }
    const requirements = blocks.map((block) => {
        const entry = bySource.get(block.sourceIdentity)
        if (!entry) fail('requirement-source-coverage')
        if (entry.sourceSpanDigest !== block.spanDigest) {
            fail('requirement-proposal-drift')
        }
        if (entry.classification === 'authority-choice-required') {
            fail('requirement-authority-choice')
        }
        if (block.normative === true &&
            entry.classification === 'context' &&
            (typeof entry.contextReason !== 'string' ||
                !entry.contextReason)) {
            fail('requirement-normative-context')
        }
        if (typeof entry.ownerRepository !== 'string' ||
            !Array.isArray(entry.affectedStageClasses) ||
            entry.affectedStageClasses.length === 0) {
            fail('requirement-authority-binding')
        }
        return {
            requirementId: requirementId(snapshot, block),
            sourceIdentity: block.sourceIdentity,
            sourceKind: block.sourceKind,
            sourceSpanDigest: block.spanDigest,
            classification: entry.classification,
            ownerRepository: entry.ownerRepository,
            affectedStageClasses:
                uniqueSorted(entry.affectedStageClasses),
            aliases: uniqueSorted(entry.aliases ?? [])
        }
    }).sort((left, right) =>
        left.requirementId.localeCompare(right.requirementId))
    const sourceCoverageDigest = digest(requirements.map((item) => ({
        requirementId: item.requirementId,
        sourceIdentity: item.sourceIdentity,
        sourceSpanDigest: item.sourceSpanDigest,
        classification: item.classification
    })))
    if (proposal.proposalDigest !==
        unsignedDigest(proposal, 'proposalDigest')) {
        fail('requirement-proposal-drift')
    }
    return seal({
        schema:
            'issue-orchestration.issue-requirement-inventory.v1',
        status: 'verified',
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteSnapshotDigest: snapshot.remoteSnapshotDigest,
        proposalDigest: proposal.proposalDigest,
        requirements,
        sourceCoverageDigest
    }, 'inventoryDigest')
}

export function compileIssueAcceptanceContract({
    snapshot,
    inventory
}) {
    validateSnapshot(snapshot)
    if (inventory?.schema !==
            'issue-orchestration.issue-requirement-inventory.v1' ||
        inventory.status !== 'verified' ||
        inventory.repository !== snapshot.repository ||
        inventory.issueNumber !== snapshot.issueNumber ||
        inventory.selectorReceiptDigest !==
            snapshot.selectorReceiptDigest ||
        inventory.remoteSnapshotDigest !==
            snapshot.remoteSnapshotDigest ||
        inventory.inventoryDigest !==
            unsignedDigest(inventory, 'inventoryDigest')) {
        fail('acceptance-contract-inventory-binding')
    }
    const ids = (classification) => inventory.requirements
        .filter((item) => item.classification === classification)
        .map((item) => item.requirementId)
        .sort()
    return seal({
        schema: 'issue-orchestration.issue-acceptance-contract.v1',
        status: 'frozen',
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteSnapshotDigest: snapshot.remoteSnapshotDigest,
        inventoryDigest: inventory.inventoryDigest,
        executableAcceptanceIds: ids('acceptance'),
        constraintIds: ids('constraint'),
        nonGoalIds: ids('non-goal'),
        sourceBindings: inventory.requirements.map((item) => ({
            requirementId: item.requirementId,
            sourceIdentity: item.sourceIdentity,
            sourceSpanDigest: item.sourceSpanDigest,
            classification: item.classification
        }))
    }, 'contractDigest')
}

export function validateWorkPlanAcceptanceContract({
    acceptanceContract,
    workPlan
}) {
    if (acceptanceContract?.schema !==
            'issue-orchestration.issue-acceptance-contract.v1' ||
        acceptanceContract.status !== 'frozen' ||
        acceptanceContract.contractDigest !==
            unsignedDigest(acceptanceContract, 'contractDigest')) {
        fail('acceptance-contract-invalid')
    }
    for (const [field, expected] of [
        ['acceptanceItems',
            acceptanceContract.executableAcceptanceIds],
        ['constraintIds', acceptanceContract.constraintIds],
        ['nonGoalIds', acceptanceContract.nonGoalIds]
    ]) {
        if (!sameValue(
            uniqueSorted(workPlan?.[field] ?? []),
            uniqueSorted(expected)
        )) {
            fail('acceptance-contract-exactness')
        }
    }
    return Object.freeze({
        schema:
            'issue-orchestration.work-plan-acceptance-verification.v1',
        status: 'verified',
        acceptanceContractDigest:
            acceptanceContract.contractDigest,
        workPlanBoundaryDigest: digest({
            acceptanceItems: workPlan.acceptanceItems,
            constraintIds: workPlan.constraintIds,
            nonGoalIds: workPlan.nonGoalIds
        })
    })
}
