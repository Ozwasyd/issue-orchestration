import {
    assertArray,
    assertDigest,
    assertText,
    fail,
    sameValue,
    seal,
    uniqueSorted,
    unsignedDigest
} from './runtime-contract-lib.mjs'

function validateCandidate(value, code = 'behavior-candidate') {
    if (!value ||
        value.candidateDigest !==
            unsignedDigest(value, 'candidateDigest') ||
        !/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? '') ||
        !/^[a-f0-9]{40}$/u.test(value.candidateSha ?? '') ||
        !Array.isArray(value.changedPaths)) {
        fail(code)
    }
    for (const field of ['treeDigest', 'diffDigest']) {
        assertDigest(value[field], code)
    }
    return value
}

function validateVerifier(value, code) {
    if (value?.role !== 'test-owner' ||
        value.phase !== 'behavior-verification' ||
        value.sandbox !== 'read-only') {
        fail('behavior-verifier-authority')
    }
    if (value.freshContext !== true ||
        value.inheritedThreadId !== null) {
        fail('behavior-verifier-fresh-context')
    }
    assertText(value.rolloutId, code)
    return value
}

export function compileVerifierBlockerReceipt(input) {
    if (input?.schema !==
        'issue-orchestration.verifier-blocker-input.v2') {
        fail('verifier-blocker-input')
    }
    const candidate = validateCandidate(input.candidate)
    const verifier = validateVerifier(
        input.verifierRuntime,
        'verifier-blocker-runtime'
    )
    for (const field of [
        'acceptanceContractDigest',
        'testContractDigest'
    ]) assertDigest(input[field], 'verifier-blocker-binding')
    for (const field of [
        'blockerPaths',
        'blockerRequirementIds',
        'blockerEvidenceDigests',
        'minimumFixBoundary'
    ]) assertArray(input[field], 'verifier-blocker-evidence', {
        min: 1
    })
    if (input.blockerEvidenceDigests.some((value) =>
        !/^[a-f0-9]{64}$/u.test(value))) {
        fail('verifier-blocker-evidence')
    }
    return seal({
        schema:
            'issue-orchestration.verifier-blocker-receipt.v2',
        status: 'rejected',
        candidate: structuredClone(candidate),
        candidateDigest: candidate.candidateDigest,
        acceptanceContractDigest:
            input.acceptanceContractDigest,
        testContractDigest: input.testContractDigest,
        blockerPaths: uniqueSorted(input.blockerPaths),
        blockerRequirementIds:
            uniqueSorted(input.blockerRequirementIds),
        blockerEvidenceDigests:
            uniqueSorted(input.blockerEvidenceDigests),
        minimumFixBoundary:
            uniqueSorted(input.minimumFixBoundary),
        verifierRolloutId: verifier.rolloutId
    }, 'receiptDigest')
}

export function compileVerificationImpactPlan({
    blockerReceipt,
    candidate,
    dependencyImpact,
    globalInvariantCommands,
    focusedCommands,
    highRiskBoundaries,
    fullContractCommands = []
}) {
    if (blockerReceipt?.schema !==
            'issue-orchestration.verifier-blocker-receipt.v2' ||
        blockerReceipt.status !== 'rejected' ||
        blockerReceipt.receiptDigest !==
            unsignedDigest(blockerReceipt, 'receiptDigest')) {
        fail('verification-impact-blocker')
    }
    const next = validateCandidate(candidate)
    if (next.candidateDigest ===
        blockerReceipt.candidateDigest) {
        fail('verification-impact-new-candidate')
    }
    const globals = assertArray(
        globalInvariantCommands,
        'verification-impact-global-invariants',
        { min: 1 }
    )
    const focused = assertArray(
        focusedCommands,
        'verification-impact-focused-commands',
        { min: 1 }
    )
    const risks = assertArray(
        highRiskBoundaries,
        'verification-impact-high-risk'
    )
    if (!dependencyImpact ||
        typeof dependencyImpact !== 'object' ||
        Array.isArray(dependencyImpact)) {
        fail('verification-impact-dependencies')
    }
    const impacted = new Set([
        ...blockerReceipt.blockerPaths,
        ...next.changedPaths
    ])
    for (const path of next.changedPaths) {
        const dependents = dependencyImpact[path]
        if (!Array.isArray(dependents)) {
            fail('verification-impact-dependencies')
        }
        for (const dependent of dependents) impacted.add(dependent)
    }
    const fullVerificationRequired = risks.length > 0
    if (fullVerificationRequired && fullContractCommands.length === 0) {
        fail('verification-impact-full-contract')
    }
    return seal({
        schema:
            'issue-orchestration.verification-impact-plan.v1',
        blockerReceiptDigest: blockerReceipt.receiptDigest,
        candidateDigest: next.candidateDigest,
        impactedPaths: [...impacted].sort(),
        blockerRequirementIds:
            [...blockerReceipt.blockerRequirementIds],
        globalInvariantCommands: uniqueSorted(globals),
        commands: uniqueSorted([
            ...focused,
            ...globals,
            ...fullContractCommands
        ]),
        highRiskBoundaries: uniqueSorted(risks),
        fullVerificationRequired
    }, 'planDigest')
}

export function compileBehaviorReceiptV3({
    candidate,
    blockerReceipt,
    impactPlan,
    verifierRuntime,
    commandEvidence,
    reusableEvidence
}) {
    const next = validateCandidate(candidate)
    if (blockerReceipt?.receiptDigest !==
            impactPlan?.blockerReceiptDigest ||
        impactPlan.candidateDigest !== next.candidateDigest ||
        impactPlan.planDigest !==
            unsignedDigest(impactPlan, 'planDigest')) {
        fail('behavior-impact-binding')
    }
    const verifier = validateVerifier(
        verifierRuntime,
        'behavior-verifier-runtime'
    )
    if (verifier.rolloutId ===
        blockerReceipt.verifierRolloutId) {
        fail('behavior-verifier-fresh-context')
    }
    const evidence = assertArray(
        commandEvidence,
        'behavior-command-evidence',
        { min: 1 }
    )
    if (!sameValue(
        uniqueSorted(evidence.map(({ command }) => command)),
        uniqueSorted(impactPlan.commands)
    ) ||
        evidence.some((item) =>
            item.exitCode !== 0 ||
            !/^[a-f0-9]{64}$/u.test(
                item.evidenceDigest ?? ''
            ))) {
        fail('behavior-command-evidence')
    }
    const reusable = assertArray(
        reusableEvidence,
        'behavior-reusable-evidence'
    )
    if (reusable.some((item) =>
        item.fingerprintCurrent !== true ||
        item.applicabilityCurrent !== true ||
        !/^[a-f0-9]{64}$/u.test(
            item.evidenceDigest ?? ''
        ))) {
        fail('behavior-reusable-evidence-stale')
    }
    return seal({
        schema: 'issue-orchestration.behavior-receipt.v3',
        status: 'behavior-green',
        candidate: structuredClone(next),
        candidateDigest: next.candidateDigest,
        blockerReceiptDigest: blockerReceipt.receiptDigest,
        impactPlanDigest: impactPlan.planDigest,
        verifierRolloutId: verifier.rolloutId,
        freshContext: true,
        sandbox: 'read-only',
        commandEvidence: structuredClone(evidence),
        reusableEvidence: structuredClone(reusable)
    }, 'receiptDigest')
}

export function verifyBehaviorReceiptV3({
    candidate,
    receipt
}) {
    const expectedCandidate = validateCandidate(candidate)
    if (receipt?.schema !==
            'issue-orchestration.behavior-receipt.v3' ||
        receipt.status !== 'behavior-green' ||
        receipt.candidateDigest !==
            expectedCandidate.candidateDigest ||
        !sameValue(receipt.candidate, expectedCandidate) ||
        receipt.receiptDigest !==
            unsignedDigest(receipt, 'receiptDigest')) {
        fail('behavior-candidate-binding')
    }
    return Object.freeze({
        schema:
            'issue-orchestration.behavior-receipt-verification.v3',
        status: 'valid',
        candidateDigest: receipt.candidateDigest,
        receiptDigest: receipt.receiptDigest
    })
}
