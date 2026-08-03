import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    acceptStageResult,
    captureStageMutationSnapshot,
    evaluateStageMutationPostcondition
} from '../../skills/issue-orchestration/scripts/stage-runtime-guard.mjs'
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

function git(repository, ...args) {
    return execFileSync(
        'git',
        ['-C', repository, ...args],
        { encoding: 'utf8' }
    ).trim()
}

function schema(name) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', name),
        'utf8'
    ))
}

function fixture({
    stageRole = 'dag-creator-updater',
    stagePhase = 'semantic-proposal'
} = {}) {
    const parent = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-stage-guard-'
    ))
    temporaryRoots.add(parent)
    const repositoryPath = path.join(parent, 'repository')
    const stateRootPath = path.join(parent, 'state')
    fs.mkdirSync(repositoryPath)
    fs.mkdirSync(stateRootPath)
    git(repositoryPath, 'init', '--quiet')
    git(repositoryPath, 'config', 'user.name',
        'Issue Orchestration Test')
    git(repositoryPath, 'config', 'user.email',
        'issue-orchestration@example.invalid')
    git(repositoryPath, 'remote', 'add', 'origin',
        'https://github.com/ExampleOrg/RepositoryA.git')
    fs.writeFileSync(path.join(repositoryPath, 'allowed.mjs'),
        'export const value = 1\n')
    fs.writeFileSync(path.join(repositoryPath, 'protected.mjs'),
        'export const protectedValue = 1\n')
    fs.writeFileSync(path.join(stateRootPath, 'state.json'),
        '{"state":"clean"}\n')
    git(repositoryPath, 'add', '.')
    git(repositoryPath, 'commit', '--quiet', '-m', 'fixture')
    const baseSha = git(repositoryPath, 'rev-parse', 'HEAD')
    const startup = verifiedRuntimeStartup({})
    const repositoryTargets = [{
        repository: 'ExampleOrg/RepositoryA',
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
    const writer = stageRole === 'code-implementer'
    const executionClass = writer
        ? 'leased-writer'
        : 'observe-only'
    const actorInvocationId = writer
        ? 'writer-invocation-1'
        : 'observer-invocation-1'
    const actorSessionId = writer
        ? 'writer-session-1'
        : 'observer-session-1'
    const selectedProfile = writer ? 'terra-low' : 'sol-max'
    const routeDecisionDigest = digest('route')
    const observation = {
        schema:
            'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId,
        actorSessionId,
        rootInvocationId:
            startup.attestation.runtimeInvocationId,
        requestedRole: stageRole,
        effectiveRole: stageRole,
        requestedPhase: stagePhase,
        effectivePhase: stagePhase,
        requestedProfile: selectedProfile,
        effectiveProfile: selectedProfile,
        requestedModel:
            writer ? 'gpt-5.6-terra' : 'gpt-5.6-sol',
        effectiveModel:
            writer ? 'gpt-5.6-terra' : 'gpt-5.6-sol',
        requestedEffort: writer ? 'low' : 'max',
        effectiveEffort: writer ? 'low' : 'max',
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
        observedAt: '2026-08-03T02:00:00.000Z'
    }
    observation.observationDigest = digest(observation)
    const leaseDigest = writer ? digest('writer-lease') : null
    const runtimeExecutionBinding =
        compileRuntimeExecutionBinding({
            stageRole,
            stagePhase,
            selectedProfile,
            routeDecisionDigest,
            runtimeObservation: observation,
            startup,
            runtimeTrustBinding,
            repositoryTargets,
            writeLeaseDigest: leaseDigest
        })
    const shared = {
        runId: 'run-stage-guard-1',
        actorInvocationId,
        actorSessionId,
        attemptId: writer
            ? 'writer-attempt-1'
            : 'observer-attempt-1',
        stageRole,
        stagePhase,
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath,
        stateRootPath,
        resourceIdentityDigest: digest(repositoryPath),
        baseSha,
        deliveryEpoch: 'epoch-stage-guard-1',
        candidateIdentity: baseSha,
        leaseDigest,
        sliceDigest: writer ? digest('writer-slice') : null,
        allowedPaths: writer ? ['allowed.mjs'] : [],
        routeDecisionDigest,
        compiledPromptDigest: digest('prompt'),
        remoteSnapshotDigest: digest('remote'),
        runtimeExecutionBinding,
        startup,
        runtimeTrustBinding,
        repositoryTargets
    }
    return {
        ...shared,
        executionClass
    }
}

function snapshot(input, snapshotKind, capturedAt) {
    return captureStageMutationSnapshot({
        ...input,
        snapshotKind,
        capturedAt
    })
}

test('guard schemas validate a clean observe-only postcondition chain', () => {
    const input = fixture()
    const pre = snapshot(
        input,
        'pre-dispatch',
        '2026-08-03T02:00:01.000Z'
    )
    const post = snapshot(
        input,
        'post-execution',
        '2026-08-03T02:00:02.000Z'
    )
    const output = { proposal: 'bounded' }
    const receipt = evaluateStageMutationPostcondition({
        preSnapshot: pre,
        postSnapshot: post,
        outputClass: 'proposal',
        output
    })
    const accepted = acceptStageResult({
        postconditionReceipt: receipt,
        resultClass: 'proposal',
        result: output
    })
    assert.equal(receipt.status, 'verified')
    assert.equal(accepted.acceptedAsWriterEvidence, false)
    assert.equal(accepted.acceptedAsIndependentEvidence, true)
    assert.deepEqual(validateJsonSchema(
        pre,
        schema('stage-mutation-snapshot.schema.json')
    ), [])
    assert.deepEqual(validateJsonSchema(
        receipt,
        schema(
            'stage-mutation-postcondition-receipt.schema.json'
        )
    ), [])
    assert.deepEqual(validateJsonSchema(
        accepted,
        schema('stage-result-acceptance-receipt.schema.json')
    ), [])
})

test('observe-only tracked, staged, committed and state mutations reject the result', () => {
    for (const mutation of [
        (input) => fs.writeFileSync(
            path.join(input.repositoryPath, 'protected.mjs'),
            'export const protectedValue = 2\n'
        ),
        (input) => {
            fs.writeFileSync(
                path.join(input.repositoryPath, 'protected.mjs'),
                'export const protectedValue = 3\n'
            )
            git(input.repositoryPath, 'add', 'protected.mjs')
        },
        (input) => {
            fs.writeFileSync(
                path.join(input.repositoryPath, 'protected.mjs'),
                'export const protectedValue = 4\n'
            )
            git(input.repositoryPath, 'add', 'protected.mjs')
            git(input.repositoryPath, 'commit', '--quiet',
                '-m', 'forbidden')
        },
        (input) => fs.writeFileSync(
            path.join(input.stateRootPath, 'state.json'),
            '{"state":"mutated"}\n'
        )
    ]) {
        const input = fixture()
        const pre = snapshot(
            input,
            'pre-dispatch',
            '2026-08-03T02:01:00.000Z'
        )
        mutation(input)
        const post = snapshot(
            input,
            'post-execution',
            '2026-08-03T02:01:01.000Z'
        )
        const receipt = evaluateStageMutationPostcondition({
            preSnapshot: pre,
            postSnapshot: post,
            outputClass: 'finding',
            output: { finding: 'valid-shape' }
        })
        assert.equal(receipt.status, 'rejected')
        assert.throws(() => acceptStageResult({
            postconditionReceipt: receipt,
            resultClass: 'finding',
            result: { finding: 'valid-shape' }
        }), {
            code: 'stage-mutation-postcondition-receipt-invalid'
        })
    }
})

test('leased writer accepts exactly the slice and rejects the whole mixed result', () => {
    const cleanInput = fixture({
        stageRole: 'code-implementer',
        stagePhase: 'implementation'
    })
    const cleanPre = snapshot(
        cleanInput,
        'pre-dispatch',
        '2026-08-03T02:02:00.000Z'
    )
    fs.writeFileSync(
        path.join(cleanInput.repositoryPath, 'allowed.mjs'),
        'export const value = 2\n'
    )
    const cleanPost = snapshot(
        cleanInput,
        'post-execution',
        '2026-08-03T02:02:01.000Z'
    )
    const cleanReceipt = evaluateStageMutationPostcondition({
        preSnapshot: cleanPre,
        postSnapshot: cleanPost,
        outputClass: 'implementation-candidate',
        output: { candidate: 'bounded' }
    })
    assert.equal(cleanReceipt.status, 'verified')
    assert.deepEqual(cleanReceipt.changedPaths, ['allowed.mjs'])

    const mixedInput = fixture({
        stageRole: 'code-implementer',
        stagePhase: 'implementation'
    })
    const mixedPre = snapshot(
        mixedInput,
        'pre-dispatch',
        '2026-08-03T02:03:00.000Z'
    )
    fs.writeFileSync(
        path.join(mixedInput.repositoryPath, 'allowed.mjs'),
        'export const value = 3\n'
    )
    fs.writeFileSync(
        path.join(mixedInput.repositoryPath, 'protected.mjs'),
        'export const protectedValue = 3\n'
    )
    const mixedPost = snapshot(
        mixedInput,
        'post-execution',
        '2026-08-03T02:03:01.000Z'
    )
    const mixedReceipt = evaluateStageMutationPostcondition({
        preSnapshot: mixedPre,
        postSnapshot: mixedPost,
        outputClass: 'implementation-candidate',
        output: { candidate: 'mixed' }
    })
    assert.equal(mixedReceipt.status, 'rejected')
    assert.ok(mixedReceipt.violationCodes.includes(
        'writer-out-of-scope-mutation'
    ))
})

test('remote drift and ambiguous attribution are run-fatal', () => {
    const input = fixture()
    const pre = snapshot(
        input,
        'pre-dispatch',
        '2026-08-03T02:04:00.000Z'
    )
    const post = snapshot({
        ...input,
        remoteSnapshotDigest: digest('changed-remote')
    }, 'post-execution', '2026-08-03T02:04:01.000Z')
    const receipt = evaluateStageMutationPostcondition({
        preSnapshot: pre,
        postSnapshot: post,
        outputClass: 'verification-evidence',
        output: { verified: true },
        attributionStatus: 'ambiguous'
    })
    assert.equal(receipt.status, 'rejected')
    assert.equal(receipt.recoveryDisposition, 'run-fatal')
    assert.ok(receipt.violationCodes.includes(
        'observe-only-remote-mutation'
    ))
    assert.ok(receipt.violationCodes.includes(
        'mutation-attribution-ambiguous'
    ))
})

test('snapshot replay across a different epoch fails closed', () => {
    const input = fixture()
    const pre = snapshot(
        input,
        'pre-dispatch',
        '2026-08-03T02:05:00.000Z'
    )
    const post = snapshot({
        ...input,
        deliveryEpoch: 'epoch-stage-guard-2'
    }, 'post-execution', '2026-08-03T02:05:01.000Z')
    assert.throws(() => evaluateStageMutationPostcondition({
        preSnapshot: pre,
        postSnapshot: post,
        outputClass: 'proposal',
        output: {}
    }), { code: 'stage-mutation-snapshot-replay-or-drift' })
})

test('writer identity can never satisfy independent evidence', () => {
    const input = fixture({
        stageRole: 'code-implementer',
        stagePhase: 'implementation'
    })
    const pre = snapshot(
        input,
        'pre-dispatch',
        '2026-08-03T02:06:00.000Z'
    )
    const post = snapshot(
        input,
        'post-execution',
        '2026-08-03T02:06:01.000Z'
    )
    const result = { candidate: 'unchanged-valid' }
    const receipt = evaluateStageMutationPostcondition({
        preSnapshot: pre,
        postSnapshot: post,
        outputClass: 'implementation-candidate',
        output: result
    })
    const accepted = acceptStageResult({
        postconditionReceipt: receipt,
        resultClass: 'implementation-candidate',
        result
    })
    assert.equal(accepted.acceptedAsWriterEvidence, true)
    assert.equal(accepted.acceptedAsIndependentEvidence, false)
})
