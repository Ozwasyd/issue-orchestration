import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    ROOT,
    'contracts/model-qualification-receipt.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)

function invocation() {
    return {
        schema: 'issue-orchestration.model-qualification-invocation.v1',
        ordinal: 0,
        profile: 'terra-low',
        scenarioId: 'atomic-mechanical',
        phaseIndex: 0,
        freshContext: false,
        requestedRuntime: {},
        effectiveRuntime: {},
        usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 2,
            totalTokens: 12
        },
        costUsd: 0.000018,
        elapsedMs: 10,
        tools: {},
        mutation: {},
        checkpoint: null,
        accepted: true,
        retryRecovery: { kind: 'none', recovered: null },
        exitCode: 0,
        eventDigest: hash,
        recordDigest: hash,
        invocationDigest: hash
    }
}

function receipt() {
    return {
        schema: 'issue-orchestration.model-qualification-receipt.v1',
        status: 'complete',
        diagnosticAuthority: 'none',
        automaticPolicyMutation: false,
        config: {
            profiles: ['terra-low'],
            scenarios: ['atomic-mechanical'],
            maxInvocations: 1,
            maxTokens: 100,
            budgetUsd: 1,
            seed: 'seed',
            configDigest: hash
        },
        bindings: {
            policyDigest: hash,
            catalogDigest: hash,
            pricingDigest: hash,
            planDigest: hash,
            protectedSourceDigest: hash
        },
        frozenInputs: { 'atomic-mechanical': hash },
        accounting: {
            invocationCount: 1,
            totalTokens: 12,
            totalCostUsd: 0.000018,
            pricingCurrency: 'USD'
        },
        invocations: [invocation()],
        scenarioResults: [{
            schema: 'issue-orchestration.model-qualification-scenario-result.v1',
            profile: 'terra-low',
            scenarioId: 'atomic-mechanical',
            frozenInputDigest: hash,
            phaseInvocationDigests: [hash],
            replacement: null,
            evaluation: { accepted: true },
            accepted: true,
            resultDigest: hash
        }],
        cleanup: {
            observationMethod: 'post-delete-lstat',
            temporaryRootDigest: hash,
            existsAfterDelete: false,
            resourcesAfter: 0,
            retainedFailureEvidence: false,
            cleanupDigest: hash
        },
        receiptDigest: hash
    }
}

test('complete model qualification receipt validates its strict schema', () => {
    assert.deepEqual(validateJsonSchema(receipt(), schema), [])
})

test('partial or policy-authoritative receipts are schema-invalid', () => {
    const partial = receipt()
    partial.status = 'partial'
    partial.automaticPolicyMutation = true
    assert.notDeepEqual(validateJsonSchema(partial, schema), [])
})
