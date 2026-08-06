import {
    digest,
    sameValue,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    LIFECYCLE_STAGE_ADMISSION_MAP,
    LIFECYCLE_STAGE_RESULT_SCHEMA
} from './lifecycle-stage-admission.mjs'

export const ACTOR_STAGE_FAILURE_SCHEMA =
    'issue-orchestration.actor-stage-failure.v1'

const HASH = /^[a-f0-9]{64}$/u

const ALLOWED_CONTRACTS = Object.freeze({
    'writer-retry-authorized': Object.freeze({
        'dispatch-implementation-writer': Object.freeze([
            'implementation-retry'
        ])
    }),
    'writer-terminal-failure': Object.freeze({
        'dispatch-test-contract-writer': Object.freeze([
            'test-contract-terminal-failure'
        ]),
        'dispatch-implementation-writer': Object.freeze([
            'implementation-terminal-failure'
        ]),
        'dispatch-documentation-writer': Object.freeze([
            'documentation-terminal-failure'
        ])
    }),
    'verifier-rejection': Object.freeze({
        'dispatch-behavior-verifier': Object.freeze([
            'behavior-rejection'
        ])
    })
})

export class LifecycleExecutorFailureAdmissionError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'LifecycleExecutorFailureAdmissionError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new LifecycleExecutorFailureAdmissionError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function exactKeys(value, expected, code) {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    if (!sameValue(actual, wanted)) fail(code, { actual, expected: wanted })
}

function contractIdForResult(result) {
    const keys = Object.keys(result.artifacts ?? {}).sort()
    const matches = Object.entries(LIFECYCLE_STAGE_ADMISSION_MAP)
        .filter(([, contract]) =>
            contract.actionType === result.actionType &&
            contract.executorAuthority === result.producerAuthority &&
            contract.actorRoles.includes(result.actorRole) &&
            sameValue(Object.keys(contract.artifactSet).sort(), keys))
        .map(([id]) => id)
    if (matches.length !== 1) {
        fail('executor-failure-stage-contract-invalid', {
            actionType: result.actionType,
            artifactKeys: keys,
            matches
        })
    }
    return matches[0]
}

function validateResultEnvelope(result) {
    object(result, 'executor-failure-stage-result-invalid')
    exactKeys(result, [
        'schema', 'producerAuthority', 'rootAuthored', 'callerAuthored',
        'actionDigest', 'actionType', 'nodeId', 'actorRole', 'attemptId',
        'artifacts', 'artifactsDigest', 'resultDigest'
    ], 'executor-failure-stage-result-fields-invalid')
    if (result.schema !== LIFECYCLE_STAGE_RESULT_SCHEMA ||
        result.rootAuthored !== false || result.callerAuthored !== false ||
        !HASH.test(result.actionDigest ?? '') ||
        !HASH.test(result.artifactsDigest ?? '') ||
        !HASH.test(result.resultDigest ?? '') ||
        result.artifactsDigest !== digest(result.artifacts) ||
        result.resultDigest !== unsignedDigest(result, 'resultDigest')) {
        fail('executor-failure-stage-result-invalid')
    }
    return result
}

export function validateLifecycleActorStageFailure(value, {
    dispatch = null
} = {}) {
    object(value, 'executor-failure-envelope-invalid')
    exactKeys(value, [
        'schema', 'status', 'authority', 'failureFamily', 'actionDigest',
        'actionType', 'nodeId', 'attemptId', 'result', 'resultDigest',
        'failureDigest'
    ], 'executor-failure-envelope-fields-invalid')
    if (value.schema !== ACTOR_STAGE_FAILURE_SCHEMA ||
        value.status !== 'validated') {
        fail('executor-failure-envelope-invalid')
    }
    exactKeys(object(value.authority,
        'executor-failure-authority-invalid'), ['kind', 'grants'],
    'executor-failure-authority-fields-invalid')
    if (value.authority.kind !== 'node-local-stage-result-only' ||
        !Array.isArray(value.authority.grants) ||
        value.authority.grants.length !== 0) {
        fail('executor-failure-authority-invalid')
    }
    const family = text(value.failureFamily,
        'executor-failure-family-invalid')
    const familyMap = ALLOWED_CONTRACTS[family]
    if (!familyMap) fail('executor-failure-family-invalid')
    const result = validateResultEnvelope(value.result)
    if (value.actionDigest !== result.actionDigest ||
        value.actionType !== result.actionType ||
        value.nodeId !== result.nodeId ||
        value.attemptId !== result.attemptId ||
        value.resultDigest !== result.resultDigest ||
        value.failureDigest !== unsignedDigest(value, 'failureDigest')) {
        fail('executor-failure-envelope-binding-invalid')
    }
    const contractId = contractIdForResult(result)
    const allowed = familyMap[result.actionType] ?? []
    if (!allowed.includes(contractId)) {
        fail('executor-failure-stage-contract-forbidden', {
            family,
            actionType: result.actionType,
            contractId
        })
    }
    if (dispatch) {
        if (dispatch.actionDigest !== value.actionDigest ||
            dispatch.action?.type !== value.actionType ||
            dispatch.nodeId !== value.nodeId ||
            dispatch.attemptId !== value.attemptId) {
            fail('executor-failure-dispatch-binding-stale')
        }
    }
    return Object.freeze({
        failure: structuredClone(value),
        result: structuredClone(result),
        family,
        contractId
    })
}

export function compileLifecycleActorStageFailure({
    failureFamily,
    result
} = {}) {
    validateResultEnvelope(result)
    const value = {
        schema: ACTOR_STAGE_FAILURE_SCHEMA,
        status: 'validated',
        authority: {
            kind: 'node-local-stage-result-only',
            grants: []
        },
        failureFamily,
        actionDigest: result.actionDigest,
        actionType: result.actionType,
        nodeId: result.nodeId,
        attemptId: result.attemptId,
        result: structuredClone(result),
        resultDigest: result.resultDigest
    }
    value.failureDigest = digest(value)
    validateLifecycleActorStageFailure(value)
    return Object.freeze(value)
}

export class LifecycleActorStageFailureError extends Error {
    constructor(stageFailure) {
        super('actor-stage-failure')
        this.name = 'LifecycleActorStageFailureError'
        this.code = 'actor-stage-failure'
        this.stageFailure = validateLifecycleActorStageFailure(
            stageFailure
        ).failure
    }
}

export function lifecycleActorStageFailureError(input) {
    return new LifecycleActorStageFailureError(
        input?.schema === ACTOR_STAGE_FAILURE_SCHEMA
            ? input
            : compileLifecycleActorStageFailure(input)
    )
}

export function classifyRejectedExecutorFailure(error, dispatch) {
    const candidate = error?.stageFailure ??
        error?.details?.stageFailure ??
        (error?.schema === ACTOR_STAGE_FAILURE_SCHEMA ? error : null)
    if (!candidate) return null
    return validateLifecycleActorStageFailure(candidate, { dispatch })
}

export const LIFECYCLE_EXECUTOR_FAILURE_ADMISSION_MAP = ALLOWED_CONTRACTS
