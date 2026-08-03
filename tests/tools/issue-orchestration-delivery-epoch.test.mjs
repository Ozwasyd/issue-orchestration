import assert from 'node:assert/strict'
import test from 'node:test'
import * as deliveryEpoch from '../../skills/issue-orchestration/scripts/delivery-epoch.mjs'

const sha = (character) => character.repeat(40)
const digest = (character) => character.repeat(64)

function canonicalEpoch() {
    return {
        epochId: 'repositorya-master-epoch-7',
        repository: 'ExampleOrg/RepositoryA',
        defaultBranch: 'master',
        baseSha: sha('a'),
        repositoryFingerprint: digest('b'),
        startedAt: '2026-08-02T00:00:00.000Z',
        closedAt: null,
        activeAttemptIds: ['attempt-1821-test'],
        frozenConflictKeys: ['.'],
        deliveryGroupId: 'delivery-group-1821',
        resultingSha: null,
        previousEpochDigest: digest('c'),
        epochDigest: digest('d'),
        sealed: false,
        cutoverFrozen: false,
        disposition: null,
        stageReceipts: {}
    }
}

test('delivery epoch exposes only the six current contract functions', () => {
    assert.deepEqual(Object.keys(deliveryEpoch).sort(), [
        'assertStageReceipt',
        'bindStageReceipt',
        'createEpoch',
        'freezeCutover',
        'sealEpoch',
        'setDisposition'
    ])
})

test('delivery epoch refuses an epoch that omits canonical repository binding fields', () => {
    const incomplete = canonicalEpoch()
    delete incomplete.repositoryFingerprint

    assert.throws(
        () => deliveryEpoch.sealEpoch(incomplete),
        /canonical.*repositoryFingerprint|repositoryFingerprint.*required/ui
    )
})

test('delivery epoch refuses a second receipt for an already-bound stage', () => {
    const epoch = deliveryEpoch.bindStageReceipt(
        canonicalEpoch(),
        'behavior',
        { epochId: 'repositorya-master-epoch-7', baseSha: sha('a'), receiptDigest: digest('e') }
    )

    assert.throws(
        () => deliveryEpoch.bindStageReceipt(
            epoch,
            'behavior',
            { epochId: 'repositorya-master-epoch-7', baseSha: sha('a'), receiptDigest: digest('f') }
        ),
        /replay|already.*bound/ui
    )
})

test('delivery epoch refuses the generic reusable-unchanged disposition', () => {
    assert.throws(
        () => deliveryEpoch.setDisposition(
            deliveryEpoch.freezeCutover(canonicalEpoch()),
            'reusable-unchanged'
        ),
        /reusable-unchanged.*forbidden|invalid.*disposition/ui
    )
})
