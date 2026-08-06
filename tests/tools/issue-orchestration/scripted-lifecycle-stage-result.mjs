import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    LIFECYCLE_STAGE_RESULT_SCHEMA
} from '../../../skills/issue-orchestration/scripts/lifecycle-stage-admission.mjs'
import {
    digest,
    unsignedDigest
} from '../../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    compileTerminalRecoveryFingerprint,
    terminalCategorySpec,
    TERMINAL_POLICY_VERSION,
    validateTerminalEvidenceSet,
    validateTerminalRecoveryExhaustion
} from '../../../skills/issue-orchestration/scripts/terminal-policy.mjs'

function clone(value) {
    return structuredClone(value)
}

function contractId(action, mode, facts) {
    switch (action.type) {
        case 'request-semantic-proposal':
            return 'semantic-proposal'
        case 'compile-acceptance-contract':
            return 'acceptance-contract'
        case 'request-test-contract-planning':
            return 'test-contract-planning'
        case 'dispatch-test-contract-writer':
            return mode === 'terminal-failure'
                ? 'test-contract-terminal-failure'
                : 'test-contract-writer'
        case 'dispatch-implementation-writer':
            if (mode === 'terminal-failure') {
                return 'implementation-terminal-failure'
            }
            return mode === 'recoverable-failure'
                ? 'implementation-retry'
                : 'implementation-candidate'
        case 'dispatch-behavior-verifier':
            return mode === 'rejected'
                ? 'behavior-rejection'
                : 'behavior-verification'
        case 'request-ui-adjudication':
            return 'ui-adjudication'
        case 'dispatch-ux-acceptance-verifier':
            return 'ux-acceptance'
        case 'dispatch-documentation-writer':
            if (mode === 'terminal-failure') {
                return 'documentation-terminal-failure'
            }
            return facts.mode === 'changed'
                ? 'documentation-change'
                : 'documentation-no-change'
        case 'deliver-acceptance-group':
            return mode === 'remote-effect-applied'
                ? 'delivery-remote-effect'
                : 'delivery-completed'
        case 'cleanup-node-resources':
            return 'cleanup-and-closure'
        case 'terminalize-node':
            return 'terminalization'
        default:
            throw new Error(`unsupported scripted action: ${action.type}`)
    }
}

function binding(action) {
    return {
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        bindings: clone(action.bindings)
    }
}

function sealArtifact({ action, kind, spec, evidence }) {
    const value = {
        schema: spec.schema,
        artifactKind: kind,
        status: 'verified',
        producerAuthority: spec.producerAuthority,
        validator: spec.validator,
        rootAuthored: false,
        actorAuthored: spec.actorAuthored,
        actionDigest: action.actionDigest,
        lifecycleBindingDigest: digest(binding(action)),
        evidence: clone(evidence),
        evidenceDigest: digest(evidence)
    }
    value[spec.digestField] = digest(value)
    return value
}

function artifactDigest(value, spec) {
    return value[spec.digestField]
}

function priorDigest(node, key) {
    const value = node?.receipts?.[key]
    if (!value || typeof value !== 'object') return null
    for (const field of [
        'receiptDigest', 'proposalDigest', 'inventoryDigest',
        'contractDigest', 'workPlanDigest', 'sliceDigest',
        'promptDigest', 'routeDecisionDigest', 'bindingDigest',
        'snapshotDigest'
    ]) {
        if (typeof value[field] === 'string') return value[field]
    }
    return null
}

function candidateSha(action, node, facts) {
    return facts.candidateSha ?? digest({
        actionDigest: action.actionDigest,
        nodeId: node?.id,
        attempt: (node?.implementationAttempts ?? 0) + 1
    }).slice(0, 40)
}

function buildArtifacts({ action, node, facts, id, attemptId }) {
    const contract = LIFECYCLE_STAGE_ADMISSION_MAP[id]
    const artifacts = {}
    const h = (label) => digest({
        actionDigest: action.actionDigest,
        contractId: id,
        label,
        facts
    })
    const put = (key, evidence) => {
        artifacts[key] = sealArtifact({
            action,
            kind: key,
            spec: contract.artifactSet[key],
            evidence
        })
        return artifacts[key]
    }
    const d = (key) => artifactDigest(
        artifacts[key],
        contract.artifactSet[key]
    )
    const actorInvocationId = `${attemptId ?? id}:actor`
    const runtime = () => put('runtimeBinding', {
        actorInvocationId,
        actorSessionId: `${attemptId ?? id}:session`,
        effectiveProfile: 'terra-low',
        effectiveModel: 'terra',
        effectiveEffort: 'low',
        effectiveBackend: 'v2',
        effectivePermissionProfile: 'observe-or-stage-bounded',
        executionObservationDigest: h('runtime-observation')
    })
    const runtimeInspection = () => put('runtimeBinding', {
        actorInvocationId,
        actorSessionId: `${attemptId ?? id}:session`,
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        effectiveBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        executionObservationDigest: h('runtime-inspection-observation'),
        repositoryInspectionDigest: h('documentation-repository-inspection'),
        inspectionKind: 'documentation-no-change',
        executionClass: 'observe-only',
        writerSpawned: false,
        writeLeaseAcquired: false
    })
    const mutation = () => put('mutationPostcondition', {
        status: 'verified',
        violations: [],
        preSnapshotDigest: h('pre-snapshot'),
        postSnapshotDigest: h('post-snapshot'),
        observationDigest: h('mutation-observation')
    })
    const dispatch = () => put('dispatchReceipt', {
        actorInvocationId,
        routeDecisionDigest:
            priorDigest(node, 'routeBinding') ?? h('route'),
        compiledPromptDigest:
            priorDigest(node, 'compiledPrompt') ?? h('prompt'),
        runtimeExecutionBindingDigest: d('runtimeBinding')
    })
    const watchdog = () => put('watchdog', {
        watchdogId: `${attemptId}:watchdog`,
        startedBeforeSpawn: true,
        online: true,
        policyDigest: h('watchdog-policy')
    })
    const checkpoint = () => put('checkpointVerification', {
        checkpointDigest: h('checkpoint'),
        commandEvidenceDigest: h('checkpoint-command'),
        liveEvidenceVerified: true
    })
    const sliceTerminal = () => put('sliceTerminal', {
        sliceId: facts.sliceId ?? 'slice-1',
        sliceDigest:
            priorDigest(node, 'executableSlice') ?? h('slice'),
        checkpointDigest:
            artifacts.checkpointVerification.evidence.checkpointDigest,
        status: 'verified'
    })

    switch (id) {
        case 'semantic-proposal': {
            runtime()
            const sourceFingerprint = h('semantic-source')
            put('semanticProposal', {
                classifications: facts.classifications ?? [
                    node?.uiClass ?? 'non-ui',
                    node?.riskClass ?? 'normal'
                ],
                sourceFingerprint,
                runtimeExecutionBindingDigest: d('runtimeBinding')
            })
            put('semanticProposalValidation', {
                proposalDigest: d('semanticProposal'),
                sourceFingerprint,
                status: 'verified'
            })
            mutation()
            break
        }
        case 'acceptance-contract': {
            const requirementIds = facts.requirementIds ?? [
                `${node.id}:requirement:behavior`,
                `${node.id}:requirement:cleanup`,
                `${node.id}:requirement:closure`
            ]
            const sourceCoverageDigest = h('source-coverage')
            put('requirementInventory', {
                requirementIds,
                sourceCoverageDigest,
                semanticProposalDigest:
                    priorDigest(node, 'semanticProposal')
            })
            put('acceptanceContract', {
                acceptanceIds: facts.acceptanceIds ?? [
                    `${node.id}:acceptance:behavior`,
                    `${node.id}:acceptance:cleanup`
                ],
                requirementInventoryDigest: d('requirementInventory'),
                sourceCoverageDigest
            })
            put('nodeDiscovered', {
                semanticProposalDigest:
                    priorDigest(node, 'semanticProposal'),
                requirementInventoryDigest: d('requirementInventory'),
                acceptanceContractDigest: d('acceptanceContract')
            })
            put('documentationRequirement', {
                required: facts.documentationRequired ?? true,
                acceptanceContractDigest: d('acceptanceContract')
            })
            break
        }
        case 'test-contract-planning': {
            runtime()
            mutation()
            put('planningAttempt', {
                attemptId,
                testPaths: facts.testPaths ?? [
                    `tests/issue-${node.issueNumber}.test.mjs`
                ],
                commands: facts.commands ?? ['node --test'],
                mutationPostconditionReceiptDigest:
                    d('mutationPostcondition')
            })
            put('dispatchInvestigation', {
                planningAttemptDigest: d('planningAttempt'),
                repositoryEvidenceDigest: h('repository-evidence')
            })
            put('slicePlan', {
                sliceIds: facts.sliceIds ?? ['slice-1'],
                planningAttemptDigest: d('planningAttempt')
            })
            put('slicePlanValidation', {
                slicePlanProposalDigest: d('slicePlan'),
                status: 'verified',
                violations: []
            })
            put('workPlan', {
                acceptanceContractDigest:
                    priorDigest(node, 'acceptanceContract'),
                slicePlanValidationDigest: d('slicePlanValidation'),
                currentSliceId: 'slice-1'
            })
            put('executableSlice', {
                workPlanDigest: d('workPlan'),
                sliceId: 'slice-1',
                allowedPaths: facts.testPaths ?? [
                    `tests/issue-${node.issueNumber}.test.mjs`
                ]
            })
            put('routeBinding', {
                selectedProfile: 'terra-low',
                stageRole: 'test-owner',
                stagePhase: 'test-contract-planning',
                policyDigest: action.bindings.policyDigest
            })
            put('compiledPrompt', {
                workPlanDigest: d('workPlan'),
                executableSliceDigest: d('executableSlice'),
                routeDecisionDigest: d('routeBinding'),
                promptContentDigest: h('bounded-prompt'),
                fullIssueIncluded: false,
                fullDagIncluded: false,
                stateRootIncluded: false
            })
            put('resourceAcquisition', {
                resourceId: `${node.id}:test-contract-resource`,
                resourceIdentityDigest: h('resource-identity'),
                leaseDigest: h('resource-lease')
            })
            break
        }
        case 'test-contract-writer': {
            runtime()
            dispatch()
            watchdog()
            checkpoint()
            sliceTerminal()
            put('testContractWriter', {
                testDeltaDigest: h('test-delta'),
                commandEvidenceDigest:
                    artifacts.checkpointVerification.evidence
                        .commandEvidenceDigest,
                checkpointVerificationDigest: d('checkpointVerification'),
                changedPaths: facts.writtenPaths ?? [
                    `tests/issue-${node.issueNumber}.test.mjs`
                ]
            })
            mutation()
            break
        }
        case 'implementation-candidate': {
            runtime()
            dispatch()
            watchdog()
            checkpoint()
            sliceTerminal()
            const commandEvidenceDigest = h('implementation-command')
            const observedCandidateSha = candidateSha(action, node, facts)
            const candidateTreeDigest = h('candidate-tree')
            const candidateDiffDigest = h('candidate-diff')
            put('implementationTerminal', {
                candidateSha: observedCandidateSha,
                candidateTreeDigest,
                candidateDiffDigest,
                gitDeltaDigest: h('implementation-delta'),
                commandEvidenceDigest,
                checkpointVerificationDigest: d('checkpointVerification'),
                changedPaths: facts.changedPaths ?? [
                    `src/issue-${node.issueNumber}.mjs`
                ]
            })
            put('candidate', {
                candidateSha: observedCandidateSha,
                candidateTreeDigest,
                candidateDiffDigest,
                commandEvidenceDigest,
                checkpointVerificationDigest: d('checkpointVerification'),
                writerInvocationId: actorInvocationId
            })
            mutation()
            break
        }
        case 'implementation-retry': {
            runtime()
            dispatch()
            watchdog()
            checkpoint()
            const firstFailureDigest = facts.firstFailureDigest ??
                h('first-failure')
            put('writerFailure', {
                failureCode: facts.failureCode ??
                    'writer-stage.scripted-recoverable-failure',
                firstFailureDigest,
                traceDigest: h('failure-trace'),
                recoverable: true
            })
            put('retryAuthorization', {
                writerFailureDigest: d('writerFailure'),
                firstFailureDigest,
                revisionEvidenceDigest: h('revision-evidence'),
                status: 'authorized'
            })
            mutation()
            break
        }
        case 'test-contract-terminal-failure':
        case 'implementation-terminal-failure':
        case 'documentation-terminal-failure': {
            mutation()
            if (!facts.executorFailureEvidence) {
                throw new Error('scripted executor failure evidence required')
            }
            put('executorFailure', {
                ...clone(facts.executorFailureEvidence),
                cleanMutationPostconditionDigest:
                    d('mutationPostcondition')
            })
            break
        }
        case 'behavior-rejection': {
            runtime()
            mutation()
            const candidate = node.receipts.candidate
            const writerInvocationId =
                candidate.evidence.writerInvocationId
            put('verificationRejection', {
                candidateSha: candidate.evidence.candidateSha,
                continuationAttemptId: attemptId,
                firstFailure: facts.firstFailure ?? {
                    classification: 'behavior-verification-rejected',
                    evidenceRef: `receipt://${h('behavior-rejection')}`,
                    signature: h('behavior-rejection-signature')
                },
                implementationOwnerActorId: writerInvocationId,
                reworkCount: (node.reworkCount ??
                    node.recoveryState?.reworkCount ?? 0) + 1,
                impactEvidenceDigest: h('behavior-impact'),
                verifierInvocationId: actorInvocationId,
                freshContext: true,
                independent: true
            })
            break
        }
        case 'behavior-verification': {
            runtime()
            const candidate = node.receipts.candidate
            put('behavior', {
                candidateSha: candidate.evidence.candidateSha,
                commandEvidenceDigest: h('behavior-command'),
                frozenTestContractDigest:
                    priorDigest(node, 'testContractWriter'),
                verifierInvocationId: actorInvocationId,
                freshContext: true,
                independent: true
            })
            put('behaviorVerification', {
                behaviorReceiptDigest: d('behavior'),
                candidateSha: candidate.evidence.candidateSha,
                status: 'verified'
            })
            mutation()
            break
        }
        case 'ui-adjudication': {
            runtime()
            put('uiAdjudication', {
                adjudication: facts.adjudication ??
                    'bounded-ui-contract-confirmed',
                candidateDigest: priorDigest(node, 'candidate'),
                acceptanceContractDigest:
                    priorDigest(node, 'acceptanceContract'),
                scopeEdited: false,
                acceptanceEdited: false,
                routingEdited: false
            })
            mutation()
            break
        }
        case 'ux-acceptance': {
            runtime()
            put('renderEvidence', {
                screenshotSetDigest: h('screenshots'),
                viewports: facts.viewports ?? ['desktop', 'mobile']
            })
            put('interactionEvidence', {
                traceDigest: h('interaction-trace'),
                assertionCount: facts.assertionCount ?? 3
            })
            put('accessibilityEvidence', {
                auditDigest: h('accessibility-audit'),
                violations: []
            })
            put('uxAcceptance', {
                candidateSha:
                    node.receipts.candidate.evidence.candidateSha,
                uiAdjudicationDigest:
                    priorDigest(node, 'uiAdjudication'),
                renderEvidenceDigest: d('renderEvidence'),
                interactionEvidenceDigest: d('interactionEvidence'),
                accessibilityEvidenceDigest: d('accessibilityEvidence'),
                status: 'accepted'
            })
            mutation()
            break
        }
        case 'documentation-change': {
            runtime()
            dispatch()
            watchdog()
            checkpoint()
            sliceTerminal()
            put('documentation', {
                mode: 'changed',
                changedPaths: facts.changedPaths ?? ['README.md'],
                documentationDeltaDigest: h('documentation-delta'),
                commandEvidenceDigest: h('documentation-command')
            })
            mutation()
            break
        }
        case 'documentation-no-change': {
            runtimeInspection()
            put('documentation', {
                mode: 'no-change',
                acceptanceContractDigest:
                    priorDigest(node, 'acceptanceContract'),
                repositoryInspectionDigest:
                    h('documentation-repository-inspection')
            })
            put('documentationNoChange', {
                documentationReceiptDigest: d('documentation'),
                status: 'verified'
            })
            mutation()
            break
        }
        case 'delivery-remote-effect':
        case 'delivery-completed': {
            const effectId = facts.effectId
            const commits = clone(facts.commits)
            const candidateMappingDigest =
                facts.candidateMappingDigest ?? h('candidate-mapping')
            const landingReceiptDigest =
                facts.landingReceiptDigest ?? h('landing-receipt')
            const landingReceiptDigests = clone(
                facts.landingReceiptDigests ?? {}
            )
            const repositoryEffects = clone(
                facts.repositoryEffects ?? []
            )
            put('remotePreSnapshot', {
                remoteStateDigest:
                    facts.remotePreStateDigest ?? h('delivery-pre-state'),
                snapshotKind: 'pre-mutation'
            })
            put('remotePostSnapshot', {
                remoteStateDigest:
                    facts.remotePostStateDigest ?? h('delivery-post-state'),
                snapshotKind: 'post-mutation'
            })
            put('deliveryControl', {
                effectId,
                preRemoteSnapshotDigest: d('remotePreSnapshot'),
                expectedPostStateDigest:
                    artifacts.remotePostSnapshot.evidence.remoteStateDigest,
                status: 'authorized'
            })
            put('remoteMutationAuthority', {
                effectId,
                deliveryControlReceiptDigest: d('deliveryControl'),
                preRemoteSnapshotDigest: d('remotePreSnapshot'),
                postRemoteSnapshotDigest: d('remotePostSnapshot'),
                status: 'verified'
            })
            put('remoteEffect', {
                effectId,
                commits,
                preRemoteSnapshotDigest: d('remotePreSnapshot'),
                postRemoteSnapshotDigest: d('remotePostSnapshot'),
                candidateMappingDigest,
                landingReceiptDigest,
                landingReceiptDigests,
                repositoryEffects
            })
            if (id === 'delivery-completed') {
                put('deliveryAttempt', {
                    effectId,
                    candidateMappingDigest,
                    landingReceiptDigest,
                    landingReceiptDigests
                })
                put('delivery', {
                    effectId,
                    remoteEffectDigest: d('remoteEffect'),
                    status: 'completed'
                })
            }
            break
        }
        case 'cleanup-and-closure': {
            put('remotePreSnapshot', {
                remoteStateDigest: h('closure-pre-state'),
                snapshotKind: 'pre-mutation'
            })
            put('remotePostSnapshot', {
                remoteStateDigest: h('closure-post-state'),
                snapshotKind: 'post-mutation'
            })
            put('cleanupAuthorization', {
                deliveryReceiptDigest: priorDigest(node, 'delivery'),
                resourceInventoryDigest: h('resource-inventory')
            })
            put('gitCleanupVerification', {
                postCleanupObservationDigest:
                    h('git-post-cleanup-observation'),
                candidateDispositionDigest: h('candidate-disposition'),
                status: 'verified',
                violations: []
            })
            put('resourceCleanup', {
                inventoryDigest: h('resource-cleanup-inventory'),
                status: 'verified',
                residualOwnedResources: []
            })
            put('cleanup', {
                gitCleanupVerificationDigest:
                    d('gitCleanupVerification'),
                resourceCleanupReceiptDigest: d('resourceCleanup'),
                status: 'verified'
            })
            put('remoteCloseAuthority', {
                cleanupReceiptDigest: d('cleanup'),
                expectedPostStateDigest:
                    artifacts.remotePostSnapshot.evidence.remoteStateDigest,
                status: 'authorized'
            })
            put('closure', {
                cleanupReceiptDigest: d('cleanup'),
                remotePreSnapshotDigest: d('remotePreSnapshot'),
                remotePostSnapshotDigest: d('remotePostSnapshot'),
                issueState: 'CLOSED',
                stateReason: 'COMPLETED'
            })
            break
        }
        case 'terminalization': {
            const category = facts.category ?? 'externally_blocked'
            const directEvidence = [
                ...terminalCategorySpec(category).requiredEvidenceKinds
            ].map((kind) => ({
                kind,
                evidenceDigest: h(`terminal-${category}-${kind}`)
            })).sort((left, right) =>
                left.kind.localeCompare(right.kind))
            const recoveryExhaustion = facts.recoveryExhaustion ?? {
                advisor: 'inapplicable',
                continuation: 'inapplicable',
                deterministicHandlers: 'exhausted',
                humanDecision: 'inapplicable',
                revalidation: 'exhausted',
                retry: 'exhausted'
            }
            const evidence = validateTerminalEvidenceSet({
                policyVersion: TERMINAL_POLICY_VERSION,
                category,
                directEvidence
            })
            const recovery = validateTerminalRecoveryExhaustion(
                recoveryExhaustion
            )
            const firstFailure = action.bindings.firstFailure ??
                action.bindings.quarantine
            if (!firstFailure) {
                throw new Error('scripted terminal first failure required')
            }
            const retainedResources = [
                ...(facts.retainedResources ?? [])
            ].sort((left, right) =>
                `${left.resourceType}:${left.resourceId}`.localeCompare(
                    `${right.resourceType}:${right.resourceId}`
                ))
            const retentionInventoryDigest = digest(retainedResources)
            const domainDigests = facts.domainDigests ?? {
                dependency: h('terminal-domain-dependency'),
                evidence: h('terminal-domain-evidence'),
                humanDecision: h('terminal-domain-human'),
                remote: h('terminal-domain-remote'),
                repository: h('terminal-domain-repository'),
                runtime: h('terminal-domain-runtime')
            }
            const observableFingerprint =
                compileTerminalRecoveryFingerprint({
                    runId: action.bindings.runId,
                    nodeId: action.nodeId,
                    repository: action.bindings.repository,
                    issueNumber: action.bindings.issueNumber,
                    baseSha: action.bindings.baseSha,
                    nodeEpoch: action.bindings.nodeEpoch,
                    selectorReceiptDigest:
                        action.bindings.selectorReceiptDigest,
                    remoteSnapshotDigest:
                        action.bindings.remoteSnapshotDigest,
                    policyDigest: action.bindings.policyDigest,
                    policySetDigest: action.bindings.policySetDigest,
                    runtimeTrustBindingDigest:
                        action.bindings.runtimeTrustBindingDigest,
                    repositoryBindingDigest:
                        action.bindings.repositoryBindingDigest,
                    category,
                    firstFailureDigest: digest(firstFailure),
                    directEvidenceDigest:
                        evidence.directEvidenceDigest,
                    recoveryExhaustionDigest:
                        recovery.recoveryExhaustionDigest,
                    domainDigests,
                    retentionInventoryDigest
                })
            put('terminal', {
                policyVersion: TERMINAL_POLICY_VERSION,
                category,
                firstFailureDigest: digest(firstFailure),
                directEvidence: evidence.directEvidence,
                directEvidenceDigest: evidence.directEvidenceDigest,
                directEvidenceDigests: evidence.directEvidence.map(
                    ({ evidenceDigest }) => evidenceDigest
                ),
                recoveryExhaustion: recovery.recoveryExhaustion,
                recoveryExhaustionDigest:
                    recovery.recoveryExhaustionDigest,
                terminalObservationDigest:
                    h('terminal-observation'),
                recoveryObservationDigest:
                    h('terminal-recovery-observation'),
                retentionInventoryDigest,
                priorLedgerHeadDigest:
                    action.bindings.priorLedgerHeadDigest,
                nodeProjectionDigest:
                    action.bindings.nodeProjectionDigest
            })
            put('recoveryFingerprint', {
                observableFingerprint,
                terminalReceiptDigest: d('terminal'),
                recoveryObservationDigest:
                    h('terminal-recovery-observation'),
                retentionInventoryDigest,
                domainDigests
            })
            put('retentionState', {
                inventoryDigest: retentionInventoryDigest,
                retainedResources,
                retentionObservationDigest:
                    h('terminal-retention-observation'),
                terminalReceiptDigest: d('terminal')
            })
            break
        }
        default:
            throw new Error(`unsupported scripted contract: ${id}`)
    }

    const expected = Object.keys(contract.artifactSet).sort()
    const actual = Object.keys(artifacts).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error(
            `scripted artifact set mismatch for ${id}: ${actual}`
        )
    }
    return artifacts
}

export function compileScriptedLifecycleStageResult({
    action,
    node = null,
    actorRole,
    mode = 'completed',
    facts = {}
} = {}) {
    const id = contractId(action, mode, facts)
    const contract = LIFECYCLE_STAGE_ADMISSION_MAP[id]
    const attemptId = [
        'acceptance-contract',
        'delivery-remote-effect',
        'delivery-completed',
        'cleanup-and-closure',
        'terminalization'
    ].includes(id)
        ? null
        : facts.attemptId ?? `${action.type}:${
            action.nodeId ?? action.acceptanceGroup}:attempt:${
            (node?.implementationAttempts ?? 0) + 1}`
    const artifacts = buildArtifacts({
        action,
        node,
        facts,
        id,
        attemptId
    })
    const result = {
        schema: LIFECYCLE_STAGE_RESULT_SCHEMA,
        producerAuthority: contract.executorAuthority,
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId ?? null,
        actorRole,
        attemptId,
        artifacts,
        artifactsDigest: digest(artifacts)
    }
    result.resultDigest = digest(result)
    return Object.freeze(result)
}

export function resealScriptedLifecycleStageResult(result) {
    const next = clone(result)
    next.artifactsDigest = digest(next.artifacts)
    next.resultDigest = unsignedDigest(next, 'resultDigest')
    return next
}
