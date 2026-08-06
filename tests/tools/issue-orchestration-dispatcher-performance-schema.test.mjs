import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    createDispatcherPerformanceCollector
} from '../../skills/issue-orchestration/scripts/dispatcher-performance-telemetry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/dispatcher-performance-receipt.schema.json'
), 'utf8'))

function clock() {
    let current = Date.parse('2026-08-05T10:00:00.000Z')
    return () => new Date(current += 5).toISOString()
}

test('dispatcher performance receipt validates its versioned schema', () => {
    const collector = createDispatcherPerformanceCollector({
        runId: 'schema-fixture',
        stateRoot: path.join(os.tmpdir(), 'dispatcher-performance-schema'),
        clock: clock()
    })
    collector.measureSync(
        ['machineActionExecution'],
        { boundary: 'machine-fixture' },
        () => ({ status: 'verified' })
    )
    const receipt = collector.finalize({
        status: 'failed',
        transitions: 1,
        failureCode: 'schema-fixture-stop'
    })
    assert.deepEqual(validateJsonSchema(receipt, schema), [])
    assert.equal(
        receipt.operationSummary.machineActionExecution.count,
        1
    )
})

test('remote-scope spans expose transfer and selector-rebuild diagnostics only', () => {
    const collector = createDispatcherPerformanceCollector({
        runId: 'delta-scope-fixture',
        stateRoot: path.join(os.tmpdir(), 'dispatcher-performance-delta'),
        clock: clock()
    })
    collector.measureSync(
        ['remoteScopeObservation'],
        { boundary: 'remote-scope-observation' },
        () => ({ status: 'unchanged' }),
        {
            resolveMetadata: () => ({
                boundary: 'remote-scope-observation',
                protocol: 'delta-v1',
                observationStatus: 'unchanged',
                remoteFactsTransferred: 0,
                deltaMembers: 0,
                selectorRebuilt: false
            })
        }
    )
    const receipt = collector.finalize({
        status: 'failed',
        transitions: 0,
        failureCode: 'delta-scope-fixture-stop'
    })
    const [span] = receipt.spans
    assert.equal(span.protocol, 'delta-v1')
    assert.equal(span.observationStatus, 'unchanged')
    assert.equal(span.remoteFactsTransferred, 0)
    assert.equal(span.deltaMembers, 0)
    assert.equal(span.selectorRebuilt, false)
    assert.deepEqual(receipt.authority, {
        kind: 'diagnostic-only',
        grants: []
    })
    assert.deepEqual(validateJsonSchema(receipt, schema), [])
})

test('dispatcher performance module has no network or model-call surface', () => {
    const source = fs.readFileSync(path.join(
        root,
        'skills/issue-orchestration/scripts/' +
            'dispatcher-performance-telemetry.mjs'
    ), 'utf8')
    assert.doesNotMatch(
        source,
        /\bfetch\s*\(|https?:\/\/|spawn(?:Sync)?\s*\(|codex|model\s*:/u
    )
})
