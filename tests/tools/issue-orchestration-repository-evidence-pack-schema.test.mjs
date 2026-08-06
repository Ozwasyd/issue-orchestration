import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/repository-evidence-pack.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)
const sha = 'b'.repeat(40)

function pack() {
    return {
        schema: 'issue-orchestration.repository-evidence-pack.v1',
        status: 'compiled',
        authority: { kind: 'actor-input-only', grants: [] },
        role: 'code-implementer',
        phase: 'implementation',
        nodeId: 'Fixture/Repo#75',
        inputIdentity: {
            repository: 'Fixture/Repo',
            baseSha: sha,
            actionDigest: hash,
            sliceDigest: hash,
            instructionSetDigest: hash,
            requestDigest: hash
        },
        scopeMap: [],
        instructions: [],
        commands: [],
        testOwnership: [],
        gitEvidence: {
            status: 'not-a-git-worktree',
            observedHead: null,
            baseReachable: false,
            candidateSha: null,
            candidateReachable: false,
            pathStatus: [],
            diffStat: [],
            observationDigest: hash
        },
        sourceReferences: [],
        searches: [],
        failureEvidence: null,
        measurement: {
            packBytes: 1,
            sourceBytes: 0,
            filesObserved: 0,
            searchesExecuted: 0,
            commandsBound: 0
        },
        packDigest: hash
    }
}

test('repository evidence pack validates its versioned strict schema', () => {
    assert.deepEqual(validateJsonSchema(pack(), schema), [])
    const authority = pack()
    authority.authority.grants.push('candidate-green')
    assert.notDeepEqual(validateJsonSchema(authority, schema), [])
    const unknown = pack()
    unknown.routeDecision = {}
    assert.notDeepEqual(validateJsonSchema(unknown, schema), [])
})
