import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import {
    RUNTIME_STARTUP_POLICY,
    attestRuntimeStartup,
    authorizeRuntimeStartupActivity,
    compileRuntimeStartupObservation,
    requireRuntimeStartupBinding,
    verifyRuntimeStartupAttestation
} from '../../skills/issue-orchestration/scripts/runtime-startup-attestation.mjs'
import {
    runtimeStartupRecords,
    startupTestDigest,
    takeoverContext,
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)

function schema(file) {
    return JSON.parse(fs.readFileSync(
        path.join(root, 'contracts', file),
        'utf8'
    ))
}

test('startup policy, observation and attestation validate against permanent schemas', () => {
    const startup = verifiedRuntimeStartup({})
    const cases = [
        [
            RUNTIME_STARTUP_POLICY,
            'runtime-startup-policy.schema.json'
        ],
        [
            startup.observation,
            'runtime-startup-observation.schema.json'
        ],
        [
            startup.attestation,
            'runtime-startup-attestation.schema.json'
        ]
    ]
    for (const [value, file] of cases) {
        assert.deepEqual(
            validateJsonSchema(value, schema(file)),
            []
        )
    }
})

test('normal root startup verifies only trusted Terra low full-access actuals', () => {
    const startup = verifiedRuntimeStartup({})
    assert.equal(startup.attestation.status, 'verified')
    assert.equal(
        startup.attestation.orchestrationEnabled,
        true
    )
    assert.deepEqual(
        startup.attestation.reasonCodes,
        []
    )
    assert.equal(
        requireRuntimeStartupBinding({ startup }).rootProfile,
        'terra-low'
    )
})

test('root-authored or mismatched producer records are not runtime authority', () => {
    const records = runtimeStartupRecords({})
    records.runtimeRecord.producerAuthority = 'orchestrator-authored'
    assert.throws(
        () => compileRuntimeStartupObservation(records),
        { code: 'runtime-startup-producer-untrusted' }
    )
})

test('unobservable capacity and effective-profile mismatch reject startup', () => {
    const capacityRecords = runtimeStartupRecords({
        capacityStatus: 'unobservable'
    })
    const capacityObservation =
        compileRuntimeStartupObservation(capacityRecords)
    const capacityAttestation = attestRuntimeStartup({
        observation: capacityObservation,
        attestedAt: '2026-08-03T01:00:01.000Z'
    })
    assert.equal(capacityAttestation.status, 'rejected')
    assert.ok(capacityAttestation.reasonCodes.includes(
        'runtime-startup-capacity-unobservable'
    ))

    const profileRecords = runtimeStartupRecords({})
    profileRecords.runtimeRecord.effectiveEffort = 'medium'
    profileRecords.runtimeRecord.recordDigest =
        startupTestDigest({
            ...profileRecords.runtimeRecord,
            recordDigest: undefined
        })
    const profileObservation =
        compileRuntimeStartupObservation(profileRecords)
    const profileAttestation = attestRuntimeStartup({
        observation: profileObservation,
        attestedAt: '2026-08-03T01:00:01.000Z'
    })
    assert.equal(profileAttestation.status, 'rejected')
    assert.ok(profileAttestation.reasonCodes.includes(
        'runtime-startup-profile-mismatch'
    ))
})

test('stale observations and package-policy drift fail closed', () => {
    const records = runtimeStartupRecords({
        observedAt: '2026-08-03T00:00:00.000Z'
    })
    const observation = compileRuntimeStartupObservation(records)
    const attestation = attestRuntimeStartup({
        observation,
        attestedAt: '2026-08-03T01:00:01.000Z'
    })
    assert.equal(attestation.status, 'rejected')
    assert.ok(attestation.reasonCodes.includes(
        'runtime-startup-observation-stale'
    ))

    const drift = runtimeStartupRecords({})
    drift.launcherRecord.policyDigests.runtimeTrust =
        drift.launcherRecord.policyDigests.runtimeTrust.replace(/^./u, '0')
    drift.launcherRecord.recordDigest =
        startupTestDigest({
            ...drift.launcherRecord,
            recordDigest: undefined
        })
    assert.throws(
        () => compileRuntimeStartupObservation(drift),
        { code: 'runtime-startup-package-policy-drift' }
    )
})

test('normal Terra medium is rejected and takeover needs new-parent fencing evidence', () => {
    const normalMediumRecords = runtimeStartupRecords({
        profile: 'terra-medium',
        rootPhase: 'scheduling'
    })
    const normalMediumObservation =
        compileRuntimeStartupObservation(normalMediumRecords)
    const normalRejected = attestRuntimeStartup({
        observation: normalMediumObservation,
        attestedAt: '2026-08-03T01:00:01.000Z'
    })
    assert.ok(normalRejected.reasonCodes.includes(
        'runtime-startup-profile-mismatch'
    ))

    const records = runtimeStartupRecords({
        profile: 'terra-medium'
    })
    const observation = compileRuntimeStartupObservation(records)
    const missingTakeover = attestRuntimeStartup({
        observation,
        attestedAt: '2026-08-03T01:00:01.000Z'
    })
    assert.deepEqual(missingTakeover.reasonCodes, [
        'runtime-startup-takeover-unverified'
    ])

    const context = takeoverContext({})
    const verified = attestRuntimeStartup({
        observation,
        takeoverContext: context,
        attestedAt: '2026-08-03T01:00:01.000Z'
    })
    assert.equal(verified.status, 'verified')
    assert.equal(verified.selectedProfile, 'terra-medium')
    verifyRuntimeStartupAttestation({
        observation,
        attestation: verified,
        takeoverContext: context
    })
})

test('repository and orchestration actions are impossible before verified attestation', () => {
    for (const activity of RUNTIME_STARTUP_POLICY.protectedActivities) {
        assert.throws(
            () => authorizeRuntimeStartupActivity({ activity }),
            { code: 'runtime-startup-attestation-not-verified' }
        )
    }
    assert.deepEqual(
        authorizeRuntimeStartupActivity({
            activity: 'runtime-preflight'
        }),
        {
            activity: 'runtime-preflight',
            authorized: true,
            startupAttestationDigest: null,
            runtimeInvocationId: null
        }
    )
    const startup = verifiedRuntimeStartup({})
    const authorization = authorizeRuntimeStartupActivity({
        activity: 'scope-selection',
        startup
    })
    assert.equal(
        authorization.startupAttestationDigest,
        startup.attestation.attestationDigest
    )
})
