import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const implementationPath = path.join(
    root,
    'skills/issue-orchestration/scripts/dispatch-receipt.mjs'
)

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function seal(value, digestField) {
    const result = structuredClone(value)
    result[digestField] = digest(result)
    return result
}

function historicalEvidence() {
    const request = seal({
        schema: 'issue-orchestration.dispatch-request.v1',
        requestId: 'request-historical-1818',
        runId: 'run-historical-1818',
        nodeId: 'RepositoryA#1818',
        attemptId: 'attempt-historical-1818',
        epochId: 'epoch-historical-1818'
    }, 'requestDigest')
    const dispatchReceipt = seal({
        schema: 'issue-orchestration.dispatch-receipt.v1',
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        attemptId: request.attemptId,
        epochId: request.epochId,
        verificationStatus: 'verified'
    }, 'receiptDigest')
    const selfTestReceipt = seal({
        schema: 'issue-orchestration.implementer-self-test-receipt.v1',
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        attemptId: request.attemptId,
        epochId: request.epochId,
        verificationStatus: 'verified'
    }, 'receiptDigest')
    return { request, dispatchReceipt, selfTestReceipt }
}

async function runtime() {
    return import(`${pathToFileURL(implementationPath).href}?retirement=${Date.now()}`)
}

async function expectCode(operation, code) {
    await assert.rejects(
        async () => operation(),
        (error) => {
            assert.equal(error?.code, code, error?.stack ?? String(error))
            return true
        }
    )
}

test('active dispatch creation no longer falls back to request v1', async () => {
    const module = await runtime()
    const { request } = historicalEvidence()
    await expectCode(
        () => module.sealDispatchRequest(request),
        'dispatch-v1-historical-only'
    )
    await expectCode(
        () => module.sealDispatchRequest({}),
        'dispatch-request-v2-required'
    )
})

test('runtime verification cannot mint a dispatch receipt from request v1', async () => {
    const module = await runtime()
    const { request } = historicalEvidence()
    await expectCode(
        () => module.verifyRuntimeDispatch({
            request,
            machineObservations: [],
            rolloutRecords: []
        }),
        'dispatch-v1-historical-only'
    )
})

test('self-test sealing cannot mint a receipt from request v1', async () => {
    const module = await runtime()
    const { dispatchReceipt, request } = historicalEvidence()
    await expectCode(
        () => module.sealImplementerSelfTestReceipt({
            request,
            dispatchReceipt
        }),
        'dispatch-v1-historical-only'
    )
})

test('transition authority requires an explicit v2 transition contract', async () => {
    const module = await runtime()
    const { dispatchReceipt } = historicalEvidence()
    await expectCode(
        () => module.authorizeReceiptTransition({
            eventType: 'implementation.started',
            dispatchReceipt
        }),
        'transition-v2-required'
    )
    await expectCode(
        () => module.authorizeReceiptTransition({
            eventType: 'implementation.started',
            transitionSchema: 'issue-orchestration.transition.v2',
            dispatchReceipt
        }),
        'receipt-v1-historical-only'
    )
})

test('explicit historical audit preserves v1 integrity without authority', async () => {
    const module = await runtime()
    const audit = module.auditHistoricalDispatchEvidence(historicalEvidence())
    assert.equal(audit.schema, 'issue-orchestration.historical-dispatch-audit.v1')
    assert.equal(audit.mode, 'read-only-historical-audit')
    assert.equal(audit.integrityStatus, 'intact')
    assert.equal(audit.mutationAuthority, 'none')
    assert.equal(audit.canCreateDispatchRequest, false)
    assert.equal(audit.canCreateReceipt, false)
    assert.equal(audit.canAuthorizeTransition, false)
    assert.deepEqual(audit.findings, [])
    assert.equal(Object.isFrozen(audit), true)
    assert.equal(Object.isFrozen(audit.artifacts), true)
})

test('historical audit reports tampering instead of issuing replacement evidence', async () => {
    const module = await runtime()
    const evidence = historicalEvidence()
    evidence.dispatchReceipt.requestId = 'request-tampered'
    const audit = module.auditHistoricalDispatchEvidence(evidence)
    assert.equal(audit.integrityStatus, 'damaged')
    assert.ok(audit.findings.includes('dispatchReceipt-digest-invalid'))
    assert.ok(audit.findings.includes(
        'dispatch-receipt-request-binding-invalid'
    ))
    assert.equal(audit.canCreateReceipt, false)
})

test('historical audit does not accept v2 evidence as a legacy escape hatch', async () => {
    const module = await runtime()
    await expectCode(
        () => Promise.resolve(module.auditHistoricalDispatchEvidence({
            request: {
                schema: 'issue-orchestration.dispatch-request.v2'
            }
        })),
        'historical-dispatch-v1-required'
    )
})

test('retired v1 creators and schema inference are absent from the runtime source', () => {
    const source = fs.readFileSync(implementationPath, 'utf8')
    for (const retired of [
        'sealDispatchRequestV1',
        'verifyRuntimeDispatchV1',
        'verifyImplementerSelfTestV1',
        'authorizeReceiptTransitionV1',
        'isV2Transition'
    ]) {
        assert.equal(source.includes(retired), false, retired)
    }
})
