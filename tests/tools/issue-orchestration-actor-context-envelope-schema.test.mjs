import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/actor-context-envelope.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)
const sha = 'b'.repeat(40)

function envelope() {
    return {
        schema: 'issue-orchestration.actor-context-envelope.v1',
        status: 'compiled',
        authority: { kind: 'actor-input-only', grants: [] },
        role: 'code-implementer',
        phase: 'implementation',
        actionType: 'dispatch-implementation-writer',
        identities: {
            actionDigest: hash,
            actionSetDigest: hash,
            nodeId: 'Fixture/Repo#73',
            runId: 'run-73',
            repository: 'Fixture/Repo',
            issueNumber: 73,
            baseSha: sha,
            selectorReceiptDigest: hash,
            remoteSnapshotDigest: hash,
            semanticGraphDigest: hash,
            aggregateProjectionDigest: hash,
            policyDigest: hash,
            runtimeCapabilityBindingDigest: hash,
            lifecycleAuthorityBindingDigest: hash,
            startupAttestationDigest: hash
        },
        acceptanceItemIds: ['AC-1'],
        stageContext: { kind: 'writer' },
        instructions: { status: 'none-applicable', entries: [] },
        repositoryEvidencePack: null,
        sources: { inline: [], progressive: [], totalSourceBytes: 0 },
        outputInterface: {
            schema: 'issue-orchestration.implementation-writer-output.v1',
            requiredFields: ['checkpoint'],
            failureVocabulary: ['actor-input-incomplete']
        },
        measurement: {
            envelopeBytes: 10,
            estimatedTokens: 3,
            inlineSourceBytes: 0,
            progressiveSourceBytes: 0,
            instructionBytes: 0,
            evidencePackBytes: 0
        },
        envelopeDigest: hash
    }
}

test('actor context envelope validates its versioned schema', () => {
    assert.deepEqual(validateJsonSchema(envelope(), schema), [])
    const authority = envelope()
    authority.authority.grants.push('mutation')
    assert.notDeepEqual(validateJsonSchema(authority, schema), [])
})
