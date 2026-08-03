import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'

import {
    compileExecutableSlice
} from '../../skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'

function dispatchDigest(value) {
    const canonical = (item) => {
        if (Array.isArray(item)) {
            return item.map(canonical).sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right)))
        }
        if (!item || typeof item !== 'object') return item
        return Object.fromEntries(Object.keys(item).sort()
            .map((key) => [key, canonical(item[key])]))
    }
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function compileBound(fixture, {
    phase = 'implementation',
    role = 'code-implementer',
    suffix = phase,
    sliceCount = 1
} = {}) {
    return compileWriterStageTestArtifacts({
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: `ExampleOrg/RepositoryA#1874:${suffix}`,
        stageRole: role,
        stagePhase: phase,
        baseSha: fixture.baseSha,
        epochId: `epoch-1874-${suffix}-1`,
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: ['src/**'],
        requiredFiles: fixture.filePaths.slice(0, sliceCount),
        requiredCommands: fixture.filePaths.slice(0, sliceCount)
            .map((filePath) => `node --check ${filePath}`),
        sliceCount
    })
}

test('startup-fixed source, registry, and lease authority seals all writer phases', (t) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/writer-authority.mjs']
    })
    t.after(() => fixture.dispose())
    for (const [phase, role] of [
        ['test-contract', 'test-owner'],
        ['implementation', 'code-implementer'],
        ['ui-implementation', 'ui-ux-implementer'],
        ['documentation', 'documentation-writer'],
        ['landing-conflict-resolution', 'code-implementer']
    ]) {
        const artifacts = compileBound(fixture, {
            phase,
            role,
            suffix: phase
        })
        assert.equal(
            artifacts.stageWorkPlan.contractBindingStatus,
            'verified'
        )
        assert.match(
            artifacts.stageWorkPlan.resourceRegistryIdentityDigest,
            /^[a-f0-9]{64}$/u
        )
        assert.match(
            artifacts.stageWorkPlan.sourceEventDigest,
            /^[a-f0-9]{64}$/u
        )
    }
})

test('canonical frozen contract rejects coordinated plan and planner resealing', (t) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/writer-authority-reseal.mjs']
    })
    t.after(() => fixture.dispose())
    const artifacts = compileBound(fixture, { suffix: 'reseal' })
    const plan = structuredClone(artifacts.stageWorkPlan)
    plan.frozenStageContractReceiptDigest = 'f'.repeat(64)
    plan.plannerReceipt.frozenStageContractReceiptDigest =
        plan.frozenStageContractReceiptDigest
    delete plan.plannerReceipt.receiptDigest
    plan.plannerReceipt.receiptDigest =
        writerTestDigest(plan.plannerReceipt)
    plan.plannerReceiptDigest = plan.plannerReceipt.receiptDigest
    delete plan.planDigest
    plan.planDigest = writerTestDigest(plan)
    assert.throws(
        () => compileExecutableSlice({
            plan,
            sliceId: plan.orderedSlices[0].sliceId
        }),
        {
            code: 'stage-work-plan-frozen-authority'
        }
    )
})

test('checkpoint-time plan replay rejects a released canonical writer lease', (t) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/writer-authority-lease.mjs']
    })
    t.after(() => fixture.dispose())
    const artifacts = compileBound(fixture, { suffix: 'lease' })
    const leasePath =
        artifacts.writerAuthority.location.writerLeasePath
    const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'))
    lease.state = 'released'
    delete lease.leaseDigest
    lease.leaseDigest = dispatchDigest(lease)
    fs.writeFileSync(leasePath, `${JSON.stringify(lease)}\n`)
    fs.chmodSync(leasePath, 0o600)
    assert.throws(
        () => compileExecutableSlice({
            plan: artifacts.stageWorkPlan,
            sliceId: artifacts.executableSlice.sliceId
        }),
        {
            code: 'writer-resource-lease-invalid'
        }
    )
})

test('live full-ledger replay rejects later predecessor invalidation', (t) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['src/writer-authority-source.mjs']
    })
    t.after(() => fixture.dispose())
    const artifacts = compileBound(fixture, { suffix: 'source' })
    const ledgerPath =
        artifacts.writerAuthority.location.sourceLedgerPath
    const entries = fs.readFileSync(ledgerPath, 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const prior = entries.at(-1)
    const payload = {}
    const event = {
        schema: 'issue-orchestration.event.v2',
        eventId: 'source-invalidation-1',
        sequence: prior.sequence + 1,
        runId: prior.runId,
        nodeId: prior.nodeId,
        eventType: 'issue.reopened',
        fromState: prior.toState,
        toState: 'discovered',
        attemptId: null,
        actorRole: 'root-scheduler',
        sourceDagDigest: prior.sourceDagDigest,
        issueSnapshotFingerprint:
            prior.issueSnapshotFingerprint,
        repositoryFingerprint: prior.repositoryFingerprint,
        baseSha: prior.baseSha,
        payload,
        payloadDigest: writerTestDigest(payload),
        evidenceRefs: ['evidence://issue.reopened'],
        createdAt: new Date(
            Date.parse(prior.createdAt) + 1_000
        ).toISOString(),
        previousEventDigest: prior.eventDigest
    }
    event.eventDigest = writerTestDigest(event)
    fs.appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`)
    assert.throws(
        () => compileExecutableSlice({
            plan: artifacts.stageWorkPlan,
            sliceId: artifacts.executableSlice.sliceId
        }),
        {
            code: 'frozen-stage-source-event'
        }
    )
})

test('canonical helper emits an ordered two-slice authority plan', (t) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/writer-authority-slice-1.mjs',
            'src/writer-authority-slice-2.mjs'
        ]
    })
    t.after(() => fixture.dispose())
    const artifacts = compileBound(fixture, {
        suffix: 'multi-slice',
        sliceCount: 2
    })
    assert.equal(artifacts.executableSlices.length, 2)
    assert.equal(artifacts.compiledPrompts.length, 2)
    assert.deepEqual(
        artifacts.executableSlices[1].prerequisiteSliceIds,
        [artifacts.executableSlices[0].sliceId]
    )
})
