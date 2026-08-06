import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = JSON.parse(fs.readFileSync(path.join(
    root,
    'contracts/repository-base-observation-epoch.schema.json'
), 'utf8'))
const hash = 'a'.repeat(64)
const sha = 'b'.repeat(40)

function receipt() {
    return {
        schema: 'issue-orchestration.repository-base-observation-epoch.v1',
        status: 'current',
        phase: 'pre-dispatch',
        producerAuthority: 'trusted-git-runtime-observer',
        rootAuthored: false,
        runId: 'schema-run',
        observedAt: '2026-08-06T00:00:00.000Z',
        controlLedgerHeadDigest: hash,
        lifecycleAuthorityBindingDigest: hash,
        startupAttestationDigest: hash,
        runtimeInvocationId: 'runtime-invocation',
        rootAuthorityEpoch: 'root-authority-epoch',
        packageDigest: hash,
        policySetDigest: hash,
        actionBindings: [{
            actionDigest: hash,
            actionType: 'request-semantic-proposal',
            nodeId: 'Fixture/Repo#1',
            dispatchId: null,
            actionSetDigest: hash,
            actionBindingsDigest: hash,
            repositories: [{
                repository: 'Fixture/Repo',
                baseSha: sha
            }]
        }],
        actionBindingSetDigest: hash,
        repositories: [{
            repository: 'Fixture/Repo',
            expectedBaseSha: sha,
            repositoryBindingDigest: hash,
            observation: {
                schema: 'issue-orchestration.lifecycle-repository-base-observation.v1',
                status: 'observed',
                producerAuthority: 'trusted-git-runtime-observer',
                rootAuthored: false,
                repository: 'Fixture/Repo',
                canonicalPath: '/tmp/repo',
                commonDir: '/tmp/repo/.git',
                origin: 'https://github.com/Fixture/Repo.git',
                defaultBranch: 'main',
                localHead: sha,
                remoteDefaultBranchHead: sha,
                dirtyEntries: [],
                repositoryBindingDigest: hash,
                observationDigest: hash
            }
        }],
        repositoryExpectationSetDigest: hash,
        driftedRepositories: [],
        reusable: true,
        epochId: hash,
        receiptDigest: hash
    }
}

test('repository base observation epoch validates its versioned schema', () => {
    assert.deepEqual(validateJsonSchema(receipt(), schema), [])
    const stale = receipt()
    stale.status = 'stale'
    stale.reusable = false
    stale.driftedRepositories = ['Fixture/Repo']
    assert.notDeepEqual(validateJsonSchema(stale, schema), [])
    stale.phase = 'post-admission'
    assert.deepEqual(validateJsonSchema(stale, schema), [])
})

test('repository base epoch grants no delivery, cleanup, or mutation authority', () => {
    const source = fs.readFileSync(path.join(
        root,
        'skills/issue-orchestration/scripts/lifecycle-live-refresh.mjs'
    ), 'utf8')
    assert.doesNotMatch(
        source,
        /deliveryControlReceipt|cleanupReceipt|closureReceipt|mutationAuthority/u
    )
    for (const forbidden of [
        'deliveryControlReceipt',
        'cleanupReceipt',
        'closureReceipt',
        'mutationAuthority',
        'routeDecision',
        'retryAuthorization',
        'terminalReceipt'
    ]) {
        assert.equal(JSON.stringify(schema).includes(forbidden), false)
    }
})
