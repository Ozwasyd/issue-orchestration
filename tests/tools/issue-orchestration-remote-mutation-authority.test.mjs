import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    REMOTE_MUTATION_POLICY,
    authorizeRemoteMutation,
    compileDeliveryControlReceipt,
    observeRemoteMutation,
    sealRemoteStateSnapshot
} from '../../skills/issue-orchestration/scripts/remote-mutation-authority.mjs'
import {
    compileRuntimeExecutionBinding
} from '../../skills/issue-orchestration/scripts/runtime-execution-binding.mjs'
import {
    compileRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const temporaryRoots = new Set()

test.after(() => {
    for (const target of temporaryRoots) {
        fs.rmSync(target, { force: true, recursive: true })
    }
})

function schema(name) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', name),
        'utf8'
    ))
}

function runtimeFixture() {
    const repositoryPath = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-remote-authority-'
    ))
    temporaryRoots.add(repositoryPath)
    execFileSync('git', ['init', '--quiet', repositoryPath])
    execFileSync('git', [
        '-C',
        repositoryPath,
        'remote',
        'add',
        'origin',
        'https://github.com/Ozwasyd/FsusBlog.git'
    ])
    const startup = verifiedRuntimeStartup({})
    const repositoryTargets = [{
        repository: 'Ozwasyd/FsusBlog',
        repositoryPath
    }]
    const runtimeTrustBinding = compileRuntimeTrustBinding({
        role: 'root-scheduler',
        executionClass: 'root-control',
        runtimeId: 'codex',
        multiAgentBackend: 'v2',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        repositoryTargets,
        startup
    })
    const rootControlLeaseDigest = digest('root-control-lease')
    const selectedProfile = 'terra-low'
    const routeDecisionDigest = digest('root-route')
    const observation = {
        schema:
            'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId:
            startup.attestation.runtimeInvocationId,
        actorSessionId: startup.attestation.runtimeSessionId,
        rootInvocationId:
            startup.attestation.runtimeInvocationId,
        requestedRole: 'root-scheduler',
        effectiveRole: 'root-scheduler',
        requestedPhase: 'scheduling',
        effectivePhase: 'scheduling',
        requestedProfile: selectedProfile,
        effectiveProfile: selectedProfile,
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: 'low',
        effectiveEffort: 'low',
        routeDecisionDigest,
        packageDigest:
            startup.observation.packageDigest,
        modelPoolPolicyDigest:
            startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            startup.observation.policyDigests.executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-03T03:00:00.000Z'
    }
    observation.observationDigest = digest(observation)
    const runtimeExecutionBinding =
        compileRuntimeExecutionBinding({
            stageRole: 'root-scheduler',
            stagePhase: 'scheduling',
            selectedProfile,
            routeDecisionDigest,
            runtimeObservation: observation,
            startup,
            runtimeTrustBinding,
            repositoryTargets,
            writeLeaseDigest: rootControlLeaseDigest
        })
    return {
        startup,
        repositoryTargets,
        runtimeTrustBinding,
        runtimeExecutionBinding,
        rootControlLeaseDigest
    }
}

function remoteSnapshot({
    issueState = 'open',
    sha = 'a'.repeat(40),
    observedAt = '2026-08-03T03:00:00.000Z'
} = {}) {
    return sealRemoteStateSnapshot({
        producerAuthority: 'trusted-remote-observer',
        repository: 'Ozwasyd/FsusBlog',
        issueId: 'Ozwasyd/FsusBlog#1900',
        defaultBranch: 'master',
        defaultBranchSha: sha,
        issueStateDigest: digest(issueState),
        observedAt
    })
}

function authorization(fixture, pre, overrides = {}) {
    const mutation = overrides.mutation ?? {
        action: 'completion-comment',
        evidence: {
            terminalEvidenceDigest: digest('terminal'),
            expectedIssueStateDigest: pre.issueStateDigest,
            commentBodyDigest: digest('completion-comment')
        }
    }
    return compileDeliveryControlReceipt({
        runId: 'run-remote-1',
        deliveryEpoch: 'delivery-epoch-1',
        ...fixture,
        repository: 'Ozwasyd/FsusBlog',
        issueId: 'Ozwasyd/FsusBlog#1900',
        candidateSha: 'b'.repeat(40),
        defaultBranchSha: pre.defaultBranchSha,
        terminalEvidenceDigest: digest('terminal'),
        mutation,
        expectedPostStateDigest:
            overrides.expectedPostStateDigest ??
            digest('comment-added-state'),
        preRemoteSnapshot: pre,
        issuedAt: '2026-08-03T03:00:01.000Z',
        expiresAt: '2026-08-03T03:05:01.000Z',
        ...overrides
    })
}

test('remote actor policy and receipt chain validate for one root mutation', () => {
    const fixture = runtimeFixture()
    const pre = remoteSnapshot()
    const receipt = authorization(fixture, pre)
    const permission = authorizeRemoteMutation({
        deliveryControlReceipt: receipt,
        runtimeExecutionBinding:
            fixture.runtimeExecutionBinding,
        currentRemoteSnapshot: pre,
        now: '2026-08-03T03:00:02.000Z'
    })
    assert.equal(permission.status, 'authorized')
    const post = remoteSnapshot({
        issueState: 'comment-added-state',
        observedAt: '2026-08-03T03:00:03.000Z'
    })
    const mutationReceipt = observeRemoteMutation({
        actorExecutionClass: 'root-control',
        actorInvocationId:
            fixture.startup.attestation.runtimeInvocationId,
        mutation: receipt.mutation,
        preRemoteSnapshot: pre,
        postRemoteSnapshot: post,
        observedPostStateDigest: digest('comment-added-state'),
        deliveryControlReceipt: receipt,
        observedAt: '2026-08-03T03:00:03.000Z'
    })
    assert.equal(mutationReceipt.status, 'verified')
    assert.equal(mutationReceipt.disposition, 'accept')
    assert.deepEqual(validateJsonSchema(
        REMOTE_MUTATION_POLICY,
        schema('remote-mutation-policy.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        pre,
        schema('remote-state-snapshot.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        receipt,
        schema('delivery-control-receipt.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        mutationReceipt,
        schema('remote-mutation-receipt.schema.json')
    ), [])
})

test('observe-only and leased-writer remote mutations are run-fatal', () => {
    const pre = remoteSnapshot()
    const post = remoteSnapshot({
        issueState: 'mutated',
        observedAt: '2026-08-03T03:01:00.000Z'
    })
    for (const actorExecutionClass of [
        'observe-only',
        'leased-writer'
    ]) {
        const receipt = observeRemoteMutation({
            actorExecutionClass,
            actorInvocationId: `${actorExecutionClass}-actor`,
            mutation: {
                action: 'state-transition',
                evidence: {}
            },
            preRemoteSnapshot: pre,
            postRemoteSnapshot: post,
            observedPostStateDigest: digest('mutated'),
            observedAt: '2026-08-03T03:01:00.000Z'
        })
        assert.equal(receipt.status, 'rejected')
        assert.equal(receipt.disposition, 'run-fatal')
        assert.deepEqual(
            receipt.violationCodes,
            ['child-actor-remote-mutation']
        )
    }
})

test('stale, consumed and remote-drifted authorization cannot execute', () => {
    const fixture = runtimeFixture()
    const pre = remoteSnapshot()
    const receipt = authorization(fixture, pre)
    for (const input of [
        {
            currentRemoteSnapshot: pre,
            now: '2026-08-03T03:05:02.000Z',
            consumedKeys: []
        },
        {
            currentRemoteSnapshot: pre,
            now: '2026-08-03T03:00:02.000Z',
            consumedKeys: [receipt.consumptionKey]
        },
        {
            currentRemoteSnapshot: remoteSnapshot({
                issueState: 'drifted'
            }),
            now: '2026-08-03T03:00:02.000Z',
            consumedKeys: []
        }
    ]) {
        assert.throws(() => authorizeRemoteMutation({
            deliveryControlReceipt: receipt,
            runtimeExecutionBinding:
                fixture.runtimeExecutionBinding,
            ...input
        }), {
            code:
                'remote-mutation-authorization-invalid-or-stale'
        })
    }
})

test('root cannot improvise action evidence or a different post-state', () => {
    const fixture = runtimeFixture()
    const pre = remoteSnapshot()
    assert.throws(() => authorization(fixture, pre, {
        mutation: {
            action: 'completion-comment',
            evidence: {
                terminalEvidenceDigest: digest('terminal'),
                expectedIssueStateDigest: pre.issueStateDigest,
                commentBodyDigest: digest('body'),
                improvisedLabelDigest: digest('extra')
            }
        }
    }), { code: 'remote-mutation-evidence-incomplete' })

    const control = authorization(fixture, pre)
    const post = remoteSnapshot({
        issueState: 'different-post-state'
    })
    const observed = observeRemoteMutation({
        actorExecutionClass: 'root-control',
        actorInvocationId:
            fixture.startup.attestation.runtimeInvocationId,
        mutation: control.mutation,
        preRemoteSnapshot: pre,
        postRemoteSnapshot: post,
        observedPostStateDigest: digest('different-post-state'),
        deliveryControlReceipt: control,
        observedAt: '2026-08-03T03:02:00.000Z'
    })
    assert.equal(observed.status, 'rejected')
    assert.ok(observed.violationCodes.includes(
        'remote-mutation-poststate-mismatch'
    ))
})
