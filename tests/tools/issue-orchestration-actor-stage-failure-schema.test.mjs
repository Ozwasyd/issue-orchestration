import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/actor-stage-failure.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)

function failure() {
    return {
        schema: 'issue-orchestration.actor-stage-failure.v1',
        status: 'validated',
        authority: {
            kind: 'node-local-stage-result-only',
            grants: []
        },
        failureFamily: 'writer-retry-authorized',
        actionDigest: hash,
        actionType: 'dispatch-implementation-writer',
        nodeId: 'Fixture/Repo#72',
        attemptId: 'attempt-72',
        result: {
            schema: 'issue-orchestration.lifecycle-stage-result.v1',
            producerAuthority: 'writer-lifecycle-executor',
            rootAuthored: false,
            callerAuthored: false,
            actionDigest: hash,
            actionType: 'dispatch-implementation-writer',
            nodeId: 'Fixture/Repo#72',
            actorRole: 'code-implementer',
            attemptId: 'attempt-72',
            artifacts: { retryAuthorization: {} },
            artifactsDigest: hash,
            resultDigest: hash
        },
        resultDigest: hash,
        failureDigest: hash
    }
}

test('actor stage failure validates its strict versioned schema', () => {
    assert.deepEqual(validateJsonSchema(failure(), schema), [])
    const mutation = failure()
    mutation.message = 'retry this please'
    assert.notDeepEqual(validateJsonSchema(mutation, schema), [])
    const authority = failure()
    authority.authority.grants.push('retry')
    assert.notDeepEqual(validateJsonSchema(authority, schema), [])
})
