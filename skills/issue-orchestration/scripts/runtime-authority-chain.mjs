import {
    assertDigest,
    digest,
    fail,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'
import {
    requireRuntimeStartupBinding
} from './runtime-startup-attestation.mjs'
import {
    validateRuntimeTrustBinding
} from './runtime-trust-policy.mjs'

const AUTHORITATIVE_ACTIVITIES = new Set([
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
])

export function bindRuntimeActivityAuthority({
    activity,
    startup,
    runtimeTrustBinding,
    repositoryTargets,
    sourceReceiptDigest,
    authorityEvidenceDigests = []
} = {}) {
    if (!AUTHORITATIVE_ACTIVITIES.has(activity)) {
        fail('runtime-activity-authority-unknown')
    }
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    validateRuntimeTrustBinding(runtimeTrustBinding, {
        expectedRole: 'root-scheduler',
        expectedExecutionClass: 'root-control',
        repositoryTargets,
        startup
    })
    assertDigest(
        sourceReceiptDigest,
        'runtime-activity-source-receipt-required'
    )
    if (!Array.isArray(authorityEvidenceDigests) ||
        authorityEvidenceDigests.some((value) =>
            !/^[a-f0-9]{64}$/u.test(value))) {
        fail('runtime-activity-authority-evidence-invalid')
    }
    return seal({
        schema:
            'issue-orchestration.runtime-activity-authority-receipt.v1',
        producerAuthority: 'machine-runtime-authority-chain',
        status: 'authorized',
        activity,
        startupAttestationDigest:
            startupBinding.startupAttestationDigest,
        runtimeInvocationId:
            startupBinding.runtimeInvocationId,
        runtimeSessionId: startupBinding.runtimeSessionId,
        rootPhase: startupBinding.rootPhase,
        rootProfile: startupBinding.rootProfile,
        rootAuthorityEpoch:
            startupBinding.rootAuthorityEpoch,
        runtimeTrustBindingDigest:
            runtimeTrustBinding.bindingDigest,
        sourceReceiptDigest,
        authorityEvidenceDigest: digest(
            [...authorityEvidenceDigests].sort()
        )
    }, 'receiptDigest')
}

export function validateRuntimeActivityAuthority(
    value,
    {
        activity,
        startup,
        runtimeTrustBinding,
        repositoryTargets,
        sourceReceiptDigest
    } = {}
) {
    if (value?.schema !==
            'issue-orchestration.runtime-activity-authority-receipt.v1' ||
        value.producerAuthority !==
            'machine-runtime-authority-chain' ||
        value.status !== 'authorized' ||
        value.activity !== activity ||
        value.sourceReceiptDigest !== sourceReceiptDigest ||
        value.receiptDigest !==
            unsignedDigest(value, 'receiptDigest')) {
        fail('runtime-activity-authority-invalid')
    }
    const startupBinding =
        requireRuntimeStartupBinding({ startup })
    validateRuntimeTrustBinding(runtimeTrustBinding, {
        expectedRole: 'root-scheduler',
        expectedExecutionClass: 'root-control',
        repositoryTargets,
        startup
    })
    if (value.startupAttestationDigest !==
            startupBinding.startupAttestationDigest ||
        value.runtimeInvocationId !==
            startupBinding.runtimeInvocationId ||
        value.runtimeSessionId !==
            startupBinding.runtimeSessionId ||
        value.rootPhase !== startupBinding.rootPhase ||
        value.rootProfile !== startupBinding.rootProfile ||
        value.rootAuthorityEpoch !==
            startupBinding.rootAuthorityEpoch ||
        value.runtimeTrustBindingDigest !==
            runtimeTrustBinding.bindingDigest) {
        fail('runtime-activity-authority-drift')
    }
    return value
}
