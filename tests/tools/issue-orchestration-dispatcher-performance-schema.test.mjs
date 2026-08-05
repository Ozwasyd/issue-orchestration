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
