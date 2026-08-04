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
import {
    validateRouteBoundActor
} from './execution-route-compiler.mjs'

function validateAcceptance(value) {
    if (value?.schema !==
            'issue-orchestration.issue-acceptance-contract.v1' ||
        value.status !== 'frozen' ||
        value.contractDigest !==
            unsignedDigest(value, 'contractDigest')) {
        fail('slice-proposal-acceptance-contract')
    }
    return value
}

function pathAllowed(target, allowedPaths, forbiddenPaths) {
    const owned = allowedPaths.some((allowed) =>
        target === allowed ||
        target.startsWith(`${allowed.replace(/\/$/u, '')}/`))
    const forbidden = forbiddenPaths.some((entry) =>
        target === entry ||
        target.startsWith(entry))
    return owned && !forbidden
}

function validateDependencies(sliceIds, graph) {
    if (!graph || typeof graph !== 'object' ||
        Array.isArray(graph) ||
        !sameValue(Object.keys(graph).sort(), [...sliceIds].sort())) {
        fail('slice-proposal-dependency-graph')
    }
    const seen = new Set()
    for (const sliceId of sliceIds) {
        const dependencies = graph[sliceId]
        if (!Array.isArray(dependencies) ||
            dependencies.some((dependency) =>
                !seen.has(dependency)) ||
            new Set(dependencies).size !== dependencies.length) {
            fail('slice-proposal-dependency-cycle')
        }
        seen.add(sliceId)
    }
}

function ownedMap({
    slices,
    field,
    expected,
    missingCode,
    duplicateCode
}) {
    const result = {}
    for (const slice of slices) {
        for (const item of slice[field] ?? []) {
            if (Object.hasOwn(result, item)) fail(duplicateCode)
            result[item] = slice.sliceId
        }
    }
    if (!sameValue(
        Object.keys(result).sort(),
        uniqueSorted(expected)
    )) {
        fail(missingCode)
    }
    return result
}

export function compileSlicePlanValidation({
    acceptanceContract,
    proposal
}) {
    const acceptance = validateAcceptance(acceptanceContract)
    if (proposal?.schema !==
            'issue-orchestration.slice-plan-proposal.v1' ||
        proposal.proposalAuthoredBy !==
            'test-owner:test-contract-planning' ||
        proposal.rootAuthored !== false ||
        proposal.acceptanceContractDigest !==
            acceptance.contractDigest) {
        fail('slice-proposal-authority')
    }
    try {
        validateRouteBoundActor({
            actor: proposal.actorRuntime,
            stageRole: 'test-owner',
            stagePhase: 'test-contract-planning',
            proposalOnly: true
        })
    } catch (error) {
        fail(error?.code ?? 'slice-proposal-authority')
    }
    assertText(proposal.objective, 'slice-proposal-objective')
    const allowedPaths = assertArray(
        proposal.allowedPaths,
        'slice-proposal-paths',
        { min: 1 }
    )
    const forbiddenPaths = assertArray(
        proposal.forbiddenPaths,
        'slice-proposal-paths'
    )
    const slices = assertArray(
        proposal.orderedSlices,
        'slice-proposal-slices',
        { min: 1 }
    )
    const ids = slices.map(({ sliceId }) => sliceId)
    if (ids.some((id) => typeof id !== 'string' || !id) ||
        new Set(ids).size !== ids.length) {
        fail('slice-proposal-slice-identity')
    }
    validateDependencies(ids, proposal.sliceDependencyGraph)
    for (const slice of slices) {
        assertText(slice.objective, 'slice-proposal-objective')
        const ownedAcceptance = assertArray(
            slice.acceptanceIds,
            'slice-proposal-acceptance-exactness',
            { min: 1 }
        )
        if (acceptance.executableAcceptanceIds.length > 1 &&
            sameValue(
                uniqueSorted(ownedAcceptance),
                uniqueSorted(acceptance.executableAcceptanceIds)
            )) {
            fail('slice-proposal-whole-issue')
        }
        const slicePaths = assertArray(
            slice.allowedPaths,
            'slice-proposal-paths',
            { min: 1 }
        )
        if (slicePaths.some((target) =>
            !pathAllowed(target, allowedPaths, forbiddenPaths))) {
            fail('slice-proposal-path-boundary')
        }
        assertText(
            slice.firstRequiredAction,
            'slice-proposal-first-action'
        )
        const first = slice.firstRequiredAction
        const validFirst = first.startsWith('write:')
            ? slicePaths.includes(first.slice('write:'.length))
            : (slice.requiredCommands ?? []).includes(first)
        if (!validFirst) fail('slice-proposal-first-action')
        if (!Number.isInteger(slice.maxChangedFiles) ||
            slice.maxChangedFiles < 1 ||
            !Number.isInteger(slice.maxOwnedModules) ||
            slice.maxOwnedModules < 1) {
            fail('slice-proposal-capacity')
        }
    }
    const acceptanceOwnerMap = ownedMap({
        slices,
        field: 'acceptanceIds',
        expected: acceptance.executableAcceptanceIds,
        missingCode: 'slice-proposal-acceptance-exactness',
        duplicateCode: 'slice-proposal-acceptance-owner'
    })
    const commandOwnerMap = ownedMap({
        slices,
        field: 'requiredCommands',
        expected: proposal.requiredCommands,
        missingCode: 'slice-proposal-command-exactness',
        duplicateCode: 'slice-proposal-command-owner'
    })
    const evidenceOwnerMap = ownedMap({
        slices,
        field: 'requiredEvidence',
        expected: proposal.requiredEvidence,
        missingCode: 'slice-proposal-evidence-exactness',
        duplicateCode: 'slice-proposal-evidence-owner'
    })
    if (proposal.proposalDigest !==
        unsignedDigest(proposal, 'proposalDigest')) {
        fail('slice-proposal-digest')
    }
    return seal({
        schema:
            'issue-orchestration.slice-plan-validation-receipt.v1',
        status: 'verified',
        proposalDigest: proposal.proposalDigest,
        acceptanceContractDigest: acceptance.contractDigest,
        proposalAuthoredBy: proposal.proposalAuthoredBy,
        validatedBy: 'deterministic-slice-validator.v2',
        generatedByValidator: false,
        acceptanceOwnerMap,
        commandOwnerMap,
        evidenceOwnerMap,
        orderedSliceIds: ids
    }, 'validationDigest')
}

export function verifySlicePlanValidation({
    acceptanceContract,
    proposal,
    receipt
}) {
    const expected = compileSlicePlanValidation({
        acceptanceContract,
        proposal
    })
    if (!sameValue(expected, receipt) ||
        receipt?.proposalDigest !== proposal.proposalDigest) {
        fail('slice-plan-validation-stale')
    }
    return Object.freeze({
        schema:
            'issue-orchestration.slice-plan-validation-verification.v1',
        status: 'verified',
        validationDigest: receipt.validationDigest
    })
}

export function validatedSliceSequence({
    acceptanceContract,
    proposal,
    validationReceipt
}) {
    verifySlicePlanValidation({
        acceptanceContract,
        proposal,
        receipt: validationReceipt
    })
    return Object.freeze({
        schema:
            'issue-orchestration.validated-slice-sequence.v1',
        proposalDigest: proposal.proposalDigest,
        validationDigest: validationReceipt.validationDigest,
        orderedSlices: structuredClone(proposal.orderedSlices),
        sliceDependencyGraph:
            structuredClone(proposal.sliceDependencyGraph)
    })
}

export function compileDeterministicSlicePolicy({
    acceptanceContract,
    proposal,
    validationReceipt
}) {
    verifySlicePlanValidation({
        acceptanceContract,
        proposal,
        receipt: validationReceipt
    })
    const orderedSliceBlueprints = proposal.orderedSlices.map(
        (slice, index) => {
            const prerequisiteSliceIds =
                proposal.sliceDependencyGraph[slice.sliceId]
            const firstWritablePath =
                slice.firstWritablePath ??
                (slice.firstRequiredAction?.startsWith('write:')
                    ? slice.firstRequiredAction.slice('write:'.length)
                    : null)
            const explicitReadOnlyOutput =
                firstWritablePath === null
                    ? (slice.explicitReadOnlyOutput ??
                        `read-only-output:${slice.sliceId}`)
                    : null
            return {
                sliceId: slice.sliceId,
                order: index + 1,
                prerequisiteSliceIds,
                singleObjective: slice.objective,
                firstRequiredAction: slice.firstRequiredAction,
                firstReadTargets: [...(slice.firstReadTargets ??
                    slice.allowedPaths)],
                firstWritablePath,
                explicitReadOnlyOutput,
                allowedPaths: [...slice.allowedPaths],
                forbiddenPaths: [...proposal.forbiddenPaths],
                requiredCreatedOrModifiedFiles:
                    [...(slice.requiredCreatedOrModifiedFiles ??
                        (firstWritablePath ? [firstWritablePath] : []))],
                requiredCommands: [...(slice.requiredCommands ?? [])],
                requiredEvidence: [...(slice.requiredEvidence ?? [])],
                explicitNonGoals: [...(slice.explicitNonGoals ?? [])],
                expectedFailureOrProgressSignal:
                    slice.expectedFailureOrProgressSignal ??
                    `progress:${slice.sliceId}`,
                maxChangedFiles: slice.maxChangedFiles,
                maxOwnedModules: slice.maxOwnedModules,
                maxReadOnlyOperationsBeforeCheckpoint:
                    slice.maxReadOnlyOperationsBeforeCheckpoint ?? 16,
                maxNoArtifactToolCalls:
                    slice.maxNoArtifactToolCalls ?? 8,
                maxNoArtifactActiveDurationClass:
                    slice.maxNoArtifactActiveDurationClass ?? 'short',
                safeCheckpointKind:
                    slice.safeCheckpointKind ?? 'stage-progress',
                acceptanceItemIds: [...slice.acceptanceIds],
                completionPredicate:
                    `required-files-commands-evidence-complete:${slice.sliceId}`,
                continuationPredicate:
                    `sealed-checkpoint-cursor-resume:${slice.sliceId}`
            }
        }
    )
    return Object.freeze({
        schema:
            'issue-orchestration.deterministic-slice-policy.v1',
        maxSliceCount: 16,
        maxAcceptanceItemsPerSlice: 8,
        maxFirstReadTargetsPerSlice: 32,
        maxAllowedPathsPerSlice: 32,
        maxRequiredFilesPerSlice: 32,
        maxRequiredCommandsPerSlice: 16,
        maxRequiredEvidencePerSlice: 32,
        maxExplicitNonGoalsPerSlice: 16,
        maxChangedFilesPerSlice: 32,
        maxOwnedModulesPerSlice: 16,
        maxReadOnlyOperationsBeforeCheckpointPerSlice: 64,
        maxNoArtifactToolCallsPerSlice: 32,
        allowedNoArtifactActiveDurationClasses: ['short', 'medium'],
        allowedSafeCheckpointKinds: [
            'stage-progress',
            'slice-terminal'
        ],
        orderedSliceBlueprints
    })
}
