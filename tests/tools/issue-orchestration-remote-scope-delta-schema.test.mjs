import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requestSchema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/remote-scope-delta-request.schema.json'
), 'utf8'))
const observationSchema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/remote-scope-delta-observation.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)

function request() {
    return {
        schema: 'issue-orchestration.lifecycle-remote-scope-delta-request.v1',
        runId: 'run-66',
        repositories: ['Fixture/Repo'],
        selector: {},
        selectorDigest: hash,
        remoteQueryIdentity: 'fixture-query',
        previousSelectorReceiptDigest: hash,
        previousRemoteSnapshotDigest: hash,
        lifecycleAuthorityBindingDigest: hash,
        previousObservationCursor: 'cursor-1',
        previousConditionalIdentity: 'etag-1'
    }
}

function common(status) {
    return {
        schema: 'issue-orchestration.lifecycle-remote-scope-delta-observation.v1',
        producerAuthority: 'trusted-remote-observation-adapter',
        rootAuthored: false,
        status,
        selectorDigest: hash,
        remoteQueryIdentity: 'fixture-query',
        repositories: ['Fixture/Repo'],
        previousRemoteSnapshotDigest: hash,
        previousObservationCursor: 'cursor-1',
        previousConditionalIdentity: 'etag-1',
        observedAt: '2026-08-06T00:00:00.000Z',
        observationDigest: hash
    }
}

test('remote scope delta request and all response variants validate strictly', () => {
    assert.deepEqual(validateJsonSchema(request(), requestSchema), [])
    assert.deepEqual(validateJsonSchema(common('unsupported'), observationSchema), [])
    assert.deepEqual(validateJsonSchema({
        ...common('unchanged'),
        observationCursor: 'cursor-1',
        conditionalIdentity: 'etag-1'
    }, observationSchema), [])
    assert.deepEqual(validateJsonSchema({
        ...common('changed'),
        observationCursor: 'cursor-2',
        conditionalIdentity: 'etag-2',
        currentIssueIds: ['Fixture/Repo#1'],
        changedIssues: [{
            repository: 'Fixture/Repo',
            number: 1,
            state: 'OPEN',
            stateReason: null,
            updatedAt: '2026-08-06T00:00:00.000Z',
            title: 'Issue 1',
            body: 'Body 1',
            comments: [],
            labels: [],
            milestone: null,
            dependsOn: [],
            trackedIssueIds: []
        }],
        removedIssueIds: []
    }, observationSchema), [])

    const unknown = common('unsupported')
    unknown.selectorReceipt = {}
    assert.notDeepEqual(validateJsonSchema(unknown, observationSchema), [])
    const partial = {
        ...common('changed'),
        observationCursor: 'cursor-2',
        conditionalIdentity: null,
        currentIssueIds: ['Fixture/Repo#2'],
        changedIssues: [{
            repository: 'Fixture/Repo',
            number: 2,
            state: 'OPEN',
            stateReason: null,
            updatedAt: '2026-08-06T00:00:00.000Z',
            title: 'Issue 2',
            body: 'Body 2',
            comments: [],
            milestone: null,
            dependsOn: [],
            trackedIssueIds: []
        }],
        removedIssueIds: []
    }
    assert.notDeepEqual(validateJsonSchema(partial, observationSchema), [])
})
