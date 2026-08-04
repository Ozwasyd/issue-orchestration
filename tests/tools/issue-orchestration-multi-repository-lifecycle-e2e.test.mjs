import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    validateJsonSchema
} from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    runMultiRepositoryLifecycleAcceptance
} from './issue-orchestration/multi-repository-lifecycle-e2e.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const schema = JSON.parse(fs.readFileSync(path.resolve(
    root,
    'tests/fixtures/issue-orchestration/multi-repository-lifecycle-e2e-receipt.schema.json'
), 'utf8'))
const runtimeSource = fs.readFileSync(path.resolve(
    root,
    'tests/tools/issue-orchestration/multi-repository-lifecycle-e2e.mjs'
), 'utf8')

test('multi-repository lifecycle E2E advances four raw issues to canonical quiescence', {
    timeout: 180000
}, () => {
    const scenarioRoot = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-issue-25-'
    ))
    let stateRoot = null
    try {
        const receipt = runMultiRepositoryLifecycleAcceptance({
            scenarioRoot
        })
        stateRoot = receipt.stateRoot
        assert.equal(receipt.status, 'verified')
        assert.match(receipt.lifecycleAuthorityBindingDigest, /^[a-f0-9]{64}$/u)
        assert.equal(receipt.initialStateRootArtifactCount, 0)
        assert.equal(receipt.repositoryEvidence.length, 2)
        assert.equal(receipt.issueEvidence.length, 4)
        assert.equal(receipt.nodeEvidence.length, 4)
        assert.ok(receipt.maximumConcurrentActions >= 2)
        assert.equal(receipt.dependencyBlockedUntilClosure, true)
        assert.equal(receipt.uiAdjudicationVerified, true)
        assert.equal(receipt.uxAcceptanceVerified, true)
        assert.equal(receipt.documentationVerifiedForEveryNode, true)
        assert.equal(receipt.commentRefreshAffectedOnlyOneNode, true)
        assert.equal(receipt.baseRebindingVerified, true)
        assert.equal(receipt.authorizedRetryCount, 1)
        assert.equal(receipt.serializeReloadReplayVerified, true)
        assert.equal(receipt.deliveryRetryWasIdempotent, true)
        assert.ok(receipt.acceptanceGroupMemberCount > 1)
        assert.equal(receipt.activeAttemptCount, 0)
        assert.equal(receipt.activeLeaseCount, 0)
        assert.equal(receipt.residualWorktreeCount, 0)
        assert.equal(receipt.residualBranchCount, 0)
        assert.equal(receipt.residualTemporaryResourceCount, 0)
        assert.equal(receipt.networkInvocationCount, 0)
        assert.equal(receipt.paidModelInvocationCount, 0)
        assert.equal(receipt.quiescent, true)
        assert.deepEqual(validateJsonSchema(receipt, schema), [])
        assert.equal(
            receipt.nodeEvidence.filter(
                ({ implementationAttempts }) =>
                    implementationAttempts === 2
            ).length,
            1
        )
        for (const repository of receipt.repositoryEvidence) {
            assert.equal(repository.defaultBranch, 'main')
            assert.ok(repository.deliveredCommits.length >= 2)
            assert.equal(
                new Set(repository.deliveredCommits).size,
                repository.deliveredCommits.length
            )
        }
        const stateFiles = fs.readdirSync(
            stateRoot,
            { recursive: true, withFileTypes: true }
        ).filter((entry) => entry.isFile())
            .map((entry) => entry.name)
        assert.ok(stateFiles.includes('control-ledger.jsonl'))
        assert.ok(stateFiles.includes('node-index.json'))
        assert.ok(stateFiles.includes('aggregate-runtime-projection.json'))
        assert.ok(stateFiles.includes('event-ledger.jsonl'))
        assert.ok(stateFiles.includes('projection.json'))
        assert.doesNotMatch(
            stateFiles.join('\n'),
            /lifecycle-run-ledger\.json/u
        )
        assert.deepEqual(
            [...new Set(stateFiles)].sort(),
            [
                'aggregate-runtime-projection.json',
                'control-ledger.jsonl',
                'control-projection.json',
                'event-ledger.jsonl',
                'node-index.json',
                'projection.json'
            ]
        )
    } finally {
        if (stateRoot) {
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
        fs.rmSync(scenarioRoot, { recursive: true, force: true })
    }
})

test('issue 25 harness uses production APIs and contains no fixture authority', () => {
    assert.match(runtimeSource, /compileLifecycleRunGenesisAuthority/u)
    assert.match(runtimeSource, /resolveLifecycleSelector/u)
    assert.match(runtimeSource, /repositoryAuthorityFor/u)
    assert.match(runtimeSource, /createSemanticGraph/u)
    assert.match(runtimeSource, /createLifecycleRunLedger/u)
    assert.match(runtimeSource, /compileLifecycleRunActionSet/u)
    assert.match(runtimeSource, /recordLifecycleActionResults/u)
    assert.match(runtimeSource, /compileScriptedLifecycleStageResult/u)
    assert.match(runtimeSource, /stageResults/u)
    assert.match(runtimeSource, /recordLifecycleScopeRefresh/u)
    assert.match(runtimeSource, /recordLifecycleBaseChange/u)
    assert.match(runtimeSource, /projectLifecycleRun/u)
    assert.doesNotMatch(
        runtimeSource,
        /tests\/fixtures|test-helper|fixture-only-constructor/iu
    )
    assert.doesNotMatch(
        runtimeSource,
        /sealReceipt|buildAggregateProjection|compileSelector\s*\(|scope-selector-receipt\.v1/iu
    )
    assert.doesNotMatch(
        runtimeSource,
        /compileLifecycleActorResult|lifecycle-actor-result\.v1|actorResults\s*:/iu
    )
    assert.doesNotMatch(
        runtimeSource,
        /curl\b|fetch\(|openai\b/iu
    )
    assert.doesNotMatch(
        runtimeSource,
        /setInterval|setTimeout|daemon|polling service/iu
    )
})
