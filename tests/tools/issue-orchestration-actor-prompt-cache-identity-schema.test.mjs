import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/actor-prompt-cache-identity.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)

function identity() {
    return {
        schema: 'issue-orchestration.actor-prompt-cache-identity.v1',
        status: 'compiled',
        authority: { kind: 'diagnostic-only', grants: [] },
        stablePrefixDigest: hash,
        suffixDigest: hash,
        completePromptDigest: hash,
        tokenizerIdentity: { name: 'fixture' },
        runtimeIdentity: null,
        cacheIdentityDigest: hash
    }
}

test('actor prompt cache identity validates its versioned schema', () => {
    assert.deepEqual(validateJsonSchema(identity(), schema), [])
    const mutation = identity()
    mutation.authority.grants.push('dispatch')
    assert.notDeepEqual(validateJsonSchema(mutation, schema), [])
})
