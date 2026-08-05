import {
    digest,
    sameValue
} from './runtime-contract-lib.mjs'
import {
    validateLifecycleActionSet
} from './lifecycle-transition-compiler.mjs'
import {
    compileLifecycleRunActionSet,
    lifecycleRunObservationContext,
    projectLifecycleRun,
    recordLifecycleTerminalizationResult,
    replayLifecycleRunLedger
} from './lifecycle-run-loop.mjs'
import {
    repositoryAuthorityFor,
    validateLifecycleRunAuthority
} from './lifecycle-genesis-authority.mjs'
import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    LIFECYCLE_STAGE_RESULT_SCHEMA,
    validateLifecycleStageResult
} from './lifecycle-stage-admission.mjs'
import {
    TERMINAL_POLICY_VERSION,
    compileTerminalRecoveryFingerprint,
    validateTerminalEvidenceSet,
    validateTerminalRecoveryDomains,
    validateTerminalRecoveryExhaustion
} from './terminal-policy.mjs'

const SUPPORTED_ACTION = 'terminalize-node'
const CONTRACT = 'terminalization'
const HASH = /^[a-f0-9]{64}$/u


export class LifecycleTerminalizationExecutorError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'LifecycleTerminalizationExecutorError'
        this.code = code
        this.details = details
    }
}

function reject(code, details = {}) {
    throw new LifecycleTerminalizationExecutorError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) reject(code)
    return value
}

function hash(value, code) {
    if (!HASH.test(value ?? '')) reject(code)
    return value
}

function clone(value) {
    return structuredClone(value)
}

function unsignedDigest(value, field) {
    const copy = clone(value)
    delete copy[field]
    return digest(copy)
}

function exactAction(action, actionSet) {
    if (action?.type !== SUPPORTED_ACTION) {
        reject('terminal-action-unsupported', {
            actionType: action?.type ?? null
        })
    }
    try {
        validateLifecycleActionSet(actionSet)
    } catch (error) {
        reject('terminal-action-set-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        reject('terminal-action-stale')
    }
    return action
}

function actionForNode(actionSet, nodeId) {
    const action = actionSet.actions.find((candidate) =>
        candidate.type === SUPPORTED_ACTION &&
        candidate.nodeId === nodeId)
    if (!action) reject('terminal-action-not-current')
    return action
}

function validateObserver(observer) {
    object(observer, 'terminal-observer-required')
    for (const method of [
        'observeTerminalEvidence',
        'observeRecoveryFacts',
        'observeRetentionInventory'
    ]) {
        if (typeof observer[method] !== 'function') {
            reject('terminal-observer-invalid', { method })
        }
    }
    return observer
}

function validateContextAuthority(context, action) {
    const observation = lifecycleRunObservationContext(
        context.ledger,
        { startup: context.startup }
    )
    let authority
    try {
        authority = validateLifecycleRunAuthority(
            observation.lifecycleAuthority,
            {
                startup: context.startup,
                expectedRunId: action.bindings.runId,
                expectedStateRoot: context.stateRootPath
            }
        )
    } catch (error) {
        reject('terminal-lifecycle-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const binding = authority.binding
    const expected = {
        lifecycleAuthorityBindingDigest: binding.bindingDigest,
        startupAttestationDigest: binding.startupAttestationDigest,
        runtimeInvocationId: binding.runtimeInvocationId,
        runtimeSessionId: binding.runtimeSessionId,
        rootAuthorityEpoch: binding.rootAuthorityEpoch,
        runtimeTrustBindingDigest: binding.runtimeTrustBindingDigest,
        repositoryIdentitySetDigest: binding.repositoryIdentitySetDigest,
        repositoryBindingSetDigest: binding.repositoryBindingSetDigest,
        packageDigest: binding.packageDigest,
        manifestDigest: binding.manifestDigest,
        policySetDigest: binding.policySetDigest,
        runtimeCapabilityBindingDigest:
            binding.runtimeCapabilityBindingDigest
    }
    for (const [field, value] of Object.entries(expected)) {
        if (action.bindings[field] !== value) {
            reject('terminal-action-authority-stale', { field })
        }
    }
    if (context.runtimeTrustBinding?.bindingDigest !==
            authority.runtimeTrustBinding.bindingDigest ||
        !sameValue(context.repositoryTargets, authority.repositoryTargets)) {
        reject('terminal-runtime-authority-stale')
    }
    let repositoryAuthority
    try {
        repositoryAuthority = repositoryAuthorityFor(
            authority,
            action.bindings.repository
        )
    } catch (error) {
        reject('terminal-repository-authority-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (repositoryAuthority.bindingDigest !==
            action.bindings.repositoryBindingDigest) {
        reject('terminal-repository-authority-stale')
    }
    return authority
}

function validateNode(action, ledger, startup) {
    const replay = replayLifecycleRunLedger(ledger, { startup })
    const node = replay.nodes[action.nodeId]
    if (!node || node.receipts?.terminal ||
        node.receipts?.recoveryFingerprint ||
        node.receipts?.retentionState) {
        reject('terminal-node-state-invalid')
    }
    if (node.activeAttemptId ||
        node.recoveryState?.expectedNextSliceId ||
        node.recoveryState?.expectedNextSliceDigest ||
        node.recoveryState?.latestContinuationReceiptDigest ||
        node.recoveryState?.writerStageRetryAuthorizationDigest) {
        reject('terminal-recovery-path-available')
    }
    if ([
        'human-decision-required',
        'human-decision-recorded',
        'cleaning',
        'delivering'
    ].includes(node.lifecycleState)) {
        reject('terminal-node-recoverable-state')
    }
    const candidate = action.bindings.terminalCandidate
    const firstFailure = action.bindings.firstFailure ??
        action.bindings.quarantine
    if (!firstFailure || typeof firstFailure !== 'object') {
        reject('terminal-first-failure-required')
    }
    const firstFailureDigest = digest(firstFailure)
    if (candidate) {
        if (candidate.firstFailureDigest !== firstFailureDigest) {
            reject('terminal-first-failure-stale')
        }
        try {
            validateTerminalEvidenceSet({
                policyVersion: candidate.policyVersion,
                category: candidate.category,
                directEvidence: candidate.directEvidence
            })
            validateTerminalRecoveryExhaustion(
                candidate.recoveryExhaustion
            )
        } catch (error) {
            reject('terminal-candidate-invalid', {
                cause: error?.code ?? error?.message
            })
        }
    }
    return { replay, node, candidate, firstFailureDigest }
}

function validateSealedObservation(value, {
    schema,
    producerAuthority,
    digestField,
    code,
    action
}) {
    object(value, code)
    if (value.schema !== schema ||
        value.producerAuthority !== producerAuthority ||
        value.status !== 'verified' ||
        value.rootAuthored === true ||
        value.callerAuthored === true ||
        value.actionDigest !== action.actionDigest ||
        value.nodeId !== action.nodeId ||
        value[digestField] !== unsignedDigest(value, digestField)) {
        reject(code)
    }
    return value
}

function validateTerminalObservation(
    observation,
    action,
    candidate,
    firstFailureDigest
) {
    validateSealedObservation(observation, {
        schema:
            'issue-orchestration.terminal-evidence-observation.v1',
        producerAuthority: 'machine-terminal-evidence-observer',
        digestField: 'observationDigest',
        code: 'terminal-evidence-observation-invalid',
        action
    })
    let evidence
    let recovery
    try {
        evidence = validateTerminalEvidenceSet({
            policyVersion: observation.policyVersion,
            category: observation.category,
            directEvidence: observation.directEvidence
        })
        recovery = validateTerminalRecoveryExhaustion(
            observation.recoveryExhaustion
        )
    } catch (error) {
        reject('terminal-evidence-observation-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    if (observation.policyVersion !== TERMINAL_POLICY_VERSION ||
        observation.firstFailureDigest !== firstFailureDigest ||
        observation.directEvidenceDigest !==
            evidence.directEvidenceDigest ||
        observation.recoveryExhaustionDigest !==
            recovery.recoveryExhaustionDigest) {
        reject('terminal-evidence-observation-stale')
    }
    if (candidate) {
        if (observation.category !== candidate.category ||
            observation.policyVersion !== candidate.policyVersion ||
            observation.directEvidenceDigest !==
                candidate.directEvidenceDigest ||
            observation.recoveryExhaustionDigest !==
                candidate.recoveryExhaustionDigest) {
            reject('terminal-evidence-observation-stale')
        }
    }
    return { observation, evidence, recovery }
}

function validateRecoveryObservation(observation, action) {
    validateSealedObservation(observation, {
        schema:
            'issue-orchestration.terminal-recovery-observation.v1',
        producerAuthority: 'machine-terminal-recovery-observer',
        digestField: 'observationDigest',
        code: 'terminal-recovery-observation-invalid',
        action
    })
    try {
        validateTerminalRecoveryDomains(observation.domainDigests)
    } catch (error) {
        reject('terminal-recovery-domains-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    return observation
}

function validateRetentionObservation(observation, action) {
    validateSealedObservation(observation, {
        schema:
            'issue-orchestration.terminal-retention-observation.v1',
        producerAuthority: 'machine-terminal-retention-observer',
        digestField: 'observationDigest',
        code: 'terminal-retention-observation-invalid',
        action
    })
    if (!Array.isArray(observation.retainedResources)) {
        reject('terminal-retention-resources-invalid')
    }
    const resources = observation.retainedResources.map((resource) => {
        object(resource, 'terminal-retention-resource-invalid')
        text(resource.resourceType,
            'terminal-retention-resource-type-invalid')
        text(resource.resourceId,
            'terminal-retention-resource-id-invalid')
        if (resource.ownerNodeId !== action.nodeId) {
            reject('terminal-retention-resource-owner-invalid')
        }
        text(resource.status,
            'terminal-retention-resource-status-invalid')
        hash(resource.resourceDigest,
            'terminal-retention-resource-digest-invalid')
        return clone(resource)
    }).sort((left, right) =>
        `${left.resourceType}:${left.resourceId}`.localeCompare(
            `${right.resourceType}:${right.resourceId}`
        ))
    if (new Set(resources.map((resource) =>
        `${resource.resourceType}:${resource.resourceId}`
    )).size !== resources.length ||
        observation.inventoryDigest !== digest(resources)) {
        reject('terminal-retention-inventory-invalid')
    }
    return { observation, resources }
}

function sealArtifact({ action, kind, evidence }) {
    const spec = LIFECYCLE_STAGE_ADMISSION_MAP[CONTRACT]
        ?.artifactSet?.[kind]
    if (!spec) reject('terminal-artifact-contract-missing', { kind })
    const value = {
        schema: spec.schema,
        artifactKind: kind,
        status: 'verified',
        producerAuthority: spec.producerAuthority,
        validator: spec.validator,
        rootAuthored: false,
        actorAuthored: spec.actorAuthored,
        actionDigest: action.actionDigest,
        lifecycleBindingDigest: digest({
            actionDigest: action.actionDigest,
            actionType: action.type,
            nodeId: action.nodeId,
            bindings: clone(action.bindings)
        }),
        evidence: clone(evidence),
        evidenceDigest: digest(evidence)
    }
    value[spec.digestField] = digest(value)
    return Object.freeze(value)
}

function sealResult(action, artifacts) {
    const result = {
        schema: LIFECYCLE_STAGE_RESULT_SCHEMA,
        producerAuthority: 'terminalization-lifecycle-executor',
        rootAuthored: false,
        callerAuthored: false,
        actionDigest: action.actionDigest,
        actionType: action.type,
        nodeId: action.nodeId,
        actorRole: 'root-scheduler',
        attemptId: null,
        artifacts: clone(artifacts),
        artifactsDigest: digest(artifacts)
    }
    result.resultDigest = digest(result)
    return Object.freeze(result)
}

function compileObservableFingerprint({
    action,
    terminal,
    recovery,
    retention
}) {
    try {
        return compileTerminalRecoveryFingerprint({
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
            category: terminal.observation.category,
            firstFailureDigest:
                terminal.observation.firstFailureDigest,
            directEvidenceDigest:
                terminal.evidence.directEvidenceDigest,
            recoveryExhaustionDigest:
                terminal.recovery.recoveryExhaustionDigest,
            domainDigests: clone(recovery.domainDigests),
            retentionInventoryDigest:
                retention.observation.inventoryDigest
        })
    } catch (error) {
        reject('terminal-recovery-fingerprint-invalid', {
            cause: error?.code ?? error?.message
        })
    }
}


export const lifecycleTerminalizationActionTypes =
    Object.freeze([SUPPORTED_ACTION])

export async function executeLifecycleTerminalizationAction({
    ledger,
    actionSet,
    action,
    observer,
    createdAt,
    startup,
    stateRootPath,
    runtimeTrustBinding,
    repositoryTargets
} = {}) {
    exactAction(action, actionSet)
    validateObserver(observer)
    const context = {
        ledger,
        actionSet,
        action,
        observer,
        createdAt,
        startup,
        stateRootPath,
        runtimeTrustBinding,
        repositoryTargets
    }
    validateContextAuthority(context, action)
    const currentActionSet = compileLifecycleRunActionSet(ledger, {
        startup
    })
    if (!sameValue(currentActionSet, actionSet)) {
        reject('terminal-action-set-stale')
    }
    const currentAction = actionForNode(
        currentActionSet,
        action.nodeId
    )
    if (!sameValue(currentAction, action)) {
        reject('terminal-action-stale')
    }
    const { node, candidate, firstFailureDigest } = validateNode(
        action,
        ledger,
        startup
    )
    const projection = projectLifecycleRun(ledger, { startup })
    const terminalObserved = validateTerminalObservation(
        await observer.observeTerminalEvidence({
            action: clone(action),
            node: clone(node),
            projection: clone(projection)
        }),
        action,
        candidate,
        firstFailureDigest
    )
    const recoveryObserved = validateRecoveryObservation(
        await observer.observeRecoveryFacts({
            action: clone(action),
            node: clone(node),
            projection: clone(projection),
            terminalObservation:
                clone(terminalObserved.observation)
        }),
        action
    )
    const retentionObserved = validateRetentionObservation(
        await observer.observeRetentionInventory({
            action: clone(action),
            node: clone(node),
            projection: clone(projection),
            terminalObservation:
                clone(terminalObserved.observation),
            recoveryObservation:
                clone(recoveryObserved)
        }),
        action
    )
    const observableFingerprint = compileObservableFingerprint({
        action,
        terminal: terminalObserved,
        recovery: recoveryObserved,
        retention: retentionObserved
    })
    if (candidate?.recoveryFingerprint !== undefined &&
        candidate.recoveryFingerprint !== observableFingerprint) {
        reject('terminal-recovery-fingerprint-stale')
    }
    const terminal = sealArtifact({
        action,
        kind: 'terminal',
        evidence: {
            policyVersion: TERMINAL_POLICY_VERSION,
            category: terminalObserved.observation.category,
            firstFailureDigest,
            directEvidence:
                terminalObserved.evidence.directEvidence,
            directEvidenceDigest:
                terminalObserved.evidence.directEvidenceDigest,
            directEvidenceDigests:
                terminalObserved.evidence.directEvidence.map(
                    ({ evidenceDigest }) => evidenceDigest
                ),
            recoveryExhaustion:
                terminalObserved.recovery.recoveryExhaustion,
            recoveryExhaustionDigest:
                terminalObserved.recovery.recoveryExhaustionDigest,
            terminalObservationDigest:
                terminalObserved.observation.observationDigest,
            recoveryObservationDigest:
                recoveryObserved.observationDigest,
            retentionInventoryDigest:
                retentionObserved.observation.inventoryDigest,
            priorLedgerHeadDigest:
                action.bindings.priorLedgerHeadDigest,
            nodeProjectionDigest:
                action.bindings.nodeProjectionDigest
        }
    })
    const retentionState = sealArtifact({
        action,
        kind: 'retentionState',
        evidence: {
            inventoryDigest:
                retentionObserved.observation.inventoryDigest,
            retainedResources: retentionObserved.resources,
            retentionObservationDigest:
                retentionObserved.observation.observationDigest,
            terminalReceiptDigest: terminal.receiptDigest
        }
    })
    const recoveryFingerprint = sealArtifact({
        action,
        kind: 'recoveryFingerprint',
        evidence: {
            observableFingerprint,
            terminalReceiptDigest: terminal.receiptDigest,
            recoveryObservationDigest:
                recoveryObserved.observationDigest,
            retentionInventoryDigest:
                retentionObserved.observation.inventoryDigest,
            domainDigests: clone(recoveryObserved.domainDigests)
        }
    })
    const artifacts = {
        terminal,
        recoveryFingerprint,
        retentionState
    }
    const result = sealResult(action, artifacts)
    try {
        validateLifecycleStageResult({ result, action, node })
    } catch (error) {
        reject('terminal-result-invalid', {
            cause: error?.code ?? error?.message
        })
    }
    const recorded = recordLifecycleTerminalizationResult({
        ledger,
        actionSet,
        action,
        result,
        createdAt,
        startup
    })
    return Object.freeze({
        ledger: recorded,
        action: clone(action),
        result,
        observableFingerprint
    })
}
