import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    bindRuntimeActivityAuthority,
    validateRuntimeActivityAuthority
} from '../../skills/issue-orchestration/scripts/runtime-authority-chain.mjs'
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

function fixture({
    invocationId = 'runtime-chain-root',
    sessionId = 'runtime-chain-session'
} = {}) {
    const repositoryPath = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-runtime-chain-'
    ))
    temporaryRoots.add(repositoryPath)
    execFileSync('git', ['init', '--quiet', repositoryPath])
    execFileSync('git', [
        '-C',
        repositoryPath,
        'remote',
        'add',
        'origin',
        'https://github.com/ExampleOrg/RepositoryA.git'
    ])
    const startup = verifiedRuntimeStartup({
        invocationId,
        sessionId
    })
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
    return {
        startup,
        repositoryTargets,
        runtimeTrustBinding
    }
}

test('every downstream authority path binds the same current startup identity', () => {
    const authority = fixture()
    const activities = [
        'repository-startup',
        'state-root-startup',
        'scope-selection',
        'dag-startup',
        'advisor-request',
        'actor-dispatch',
        'continuation',
        'recovery-plan',
        'root-handoff',
        'recovery-takeover',
        'landing',
        'delivery',
        'terminal',
        'cleanup',
        'quiescence'
    ]
    let example
    for (const activity of activities) {
        const sourceReceiptDigest = digest(`source:${activity}`)
        const receipt = bindRuntimeActivityAuthority({
            activity,
            ...authority,
            sourceReceiptDigest,
            authorityEvidenceDigests: [
                digest(`evidence:${activity}`)
            ]
        })
        assert.equal(
            receipt.startupAttestationDigest,
            authority.startup.attestation.attestationDigest
        )
        assert.equal(
            receipt.runtimeInvocationId,
            authority.startup.attestation.runtimeInvocationId
        )
        assert.equal(validateRuntimeActivityAuthority(receipt, {
            activity,
            ...authority,
            sourceReceiptDigest
        }), receipt)
        example = receipt
    }
    const schema = JSON.parse(fs.readFileSync(
        path.join(
            root,
            'contracts/runtime-activity-authority-receipt.schema.json'
        ),
        'utf8'
    ))
    assert.deepEqual(validateJsonSchema(example, schema), [])
})

test('fresh invocation, changed source, forged digest and legacy metadata fail closed', () => {
    const first = fixture()
    const sourceReceiptDigest = digest('source')
    const receipt = bindRuntimeActivityAuthority({
        activity: 'continuation',
        ...first,
        sourceReceiptDigest
    })
    const fresh = fixture({
        invocationId: 'fresh-root',
        sessionId: 'fresh-session'
    })
    assert.throws(() => validateRuntimeActivityAuthority(
        receipt,
        {
            activity: 'continuation',
            ...fresh,
            sourceReceiptDigest
        }
    ), { code: 'runtime-activity-authority-drift' })
    assert.throws(() => validateRuntimeActivityAuthority(
        receipt,
        {
            activity: 'continuation',
            ...first,
            sourceReceiptDigest: digest('different-source')
        }
    ), { code: 'runtime-activity-authority-invalid' })
    assert.throws(() => bindRuntimeActivityAuthority({
        activity: 'continuation',
        startup: {
            rootRuntime: {
                metadata: {
                    model: 'gpt-5.6-terra',
                    effort: 'low'
                }
            }
        },
        runtimeTrustBinding: first.runtimeTrustBinding,
        repositoryTargets: first.repositoryTargets,
        sourceReceiptDigest
    }), { code: 'runtime-startup-attestation-not-verified' })
})
