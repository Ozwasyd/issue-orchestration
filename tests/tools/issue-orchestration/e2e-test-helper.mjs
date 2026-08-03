import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
    validateJsonSchema
} from '../../../tools/test-matrix/schema-validator/validate.mjs'

const root = resolve(import.meta.dirname, '../../..')
const contract = JSON.parse(readFileSync(resolve(
    root,
    'tests/fixtures/issue-orchestration/final-e2e-contract.json'
), 'utf8'))
const runtimePath = resolve(root, contract.runtimeOwner)

let runtimePromise
async function runtime() {
    assert.equal(existsSync(runtimePath), true, contract.runtimeOwner)
    runtimePromise ??= import(pathToFileURL(runtimePath).href)
    return runtimePromise
}

const evidenceKeys = [
    'shared-package-discovery',
    'model-pool-consistency',
    'root-runtime-canary',
    'root-mechanical-control',
    'dag-startup-gate',
    'first-writer-cold-start',
    'scope-frontier-routing-consistency',
    'acceptance-slice-authority',
    'output-missing-retry',
    'writer-runtime-watchdog',
    'verifier-revalidation',
    'git-landing-delivery',
    'mutation-execution-summary',
    'live-quiescence',
    'no-temporary-scheduler-trace',
    'human-decision-gate',
    'acceptance-group-atomicity',
    'ui-dual-skill'
]

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function fixtureChildReceipt(key) {
    const root = [
        'root-runtime-canary',
        'root-mechanical-control'
    ].includes(key)
    const value = {
        schema: `issue-orchestration.e2e-${key}-receipt.v1`,
        evidenceKey: key,
        status: 'verified',
        mode: 'fixture',
        packageDigest: digest('fixture-package'),
        policyDigest: digest('fixture-policy-v3'),
        sourceCommit: digest('fixture-source').slice(0, 40),
        runFamily: 'fixture-run-family',
        candidateDigest: digest('fixture-candidate'),
        selectedProfile: root ? 'terra-low' : 'terra-medium',
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: root ? 'low' : 'medium',
        effectiveEffort: root ? 'low' : 'medium',
        multiAgentBackend: 'v2',
        executedCommand: `fixture:${key}`,
        rolloutId: `fixture-rollout:${key}`,
        observedResult: 'passed'
    }
    Object.assign(value, {
        ...(key === 'model-pool-consistency' && {
            policySchema:
                'issue-orchestration.stage-model-pool-policy.v3',
            policyVersion: 'stage-model-pool.v3',
            routingSchema:
                'issue-orchestration.execution-routing-policy.v2',
            registeredProfiles: [
                'terra-low', 'terra-medium', 'terra-high',
                'terra-xhigh', 'terra-max', 'sol-low', 'sol-medium',
                'sol-high', 'sol-xhigh', 'sol-max'
            ],
            forbiddenProfileCount: 0,
            parallelModelTableCount: 0
        }),
        ...(key === 'root-runtime-canary' && {
            runtimeKind: 'real-codex-v2-runtime',
            fiveCwdDiscoveryCount: 5,
            coldStartWriterArtifactObserved: true,
            runtimeCanaryReceiptDigest: digest('fixture-canary')
        }),
        ...(key === 'root-mechanical-control' && {
            semanticWorkPerformedByRoot: false,
            ownerDecisionCount: 0,
            acceptanceEditCount: 0,
            sliceProposalCount: 0,
            implementationWriteCount: 0
        }),
        ...(key === 'dag-startup-gate' && {
            memberScopedGateVerified: true
        }),
        ...(key === 'first-writer-cold-start' && {
            acceptanceBeforePlanning: true,
            planningBeforeLease: true,
            leaseBeforeFrozenContract: true,
            frozenContractBeforeWriter: true,
            distinctPlanningAndWriterRollouts: true,
            fabricatedHistoryCount: 0
        }),
        ...(key === 'scope-frontier-routing-consistency' && {
            routingCompilerOnly: true
        }),
        ...(key === 'acceptance-slice-authority' && {
            acceptanceExact: true,
            rootAuthoredRequirementCount: 0,
            rootAuthoredSliceCount: 0,
            validatorMutatedProposal: false
        }),
        ...(key === 'output-missing-retry' && {
            transientSameContractRetryCount: 1,
            secondEmptyRolloutTerminal: true,
            materialRetryBoundaryVerified: true
        }),
        ...(key === 'writer-runtime-watchdog' && {
            onlineBeforeSpawn: true,
            firstActionObserved: true,
            firstArtifactObserved: true,
            failClosed: true
        }),
        ...(key === 'verifier-revalidation' && {
            oldReceiptInvalidated: true,
            freshCandidateBVerifier: true,
            inheritedContext: false,
            impactPlanVerified: true
        }),
        ...(key === 'git-landing-delivery' && {
            realLandingVerified: true
        }),
        ...(key === 'live-quiescence' && {
            observationSource:
                'issue-orchestration.quiescence-observation-collector.v1',
            observationFresh: true,
            violations: []
        }),
        ...(key === 'no-temporary-scheduler-trace' && {
            temporaryBootstrapCount: 0,
            temporarySchedulerCount: 0,
            residentDaemonCount: 0,
            fallbackExecutorCount: 0,
            repoLocalCopyCount: 0
        }),
        ...(key === 'human-decision-gate' && {
            humanGateVerified: true
        }),
        ...(key === 'acceptance-group-atomicity' && {
            acceptanceGroupAtomicityVerified: true
        }),
        ...(key === 'ui-dual-skill' && {
            uiDualSkillVerified: true
        })
    })
    if (key === 'mutation-execution-summary') {
        value.mutations = Array.from({ length: 14 }, (_, index) => ({
            mutationId: `fixture-mutation-${index + 1}`,
            injectedInputDigest: digest(`input-${index}`),
            expectedRejectionCode: `reject-${index}`,
            actualRejectionCode: `reject-${index}`,
            commandExitCode: 1,
            restorationDigest: digest(`restore-${index}`)
        }))
    }
    value.receiptDigest = digest(value)
    return value
}

function fixtureEvidenceBundle() {
    return {
        mode: 'fixture',
        receipts: Object.fromEntries(evidenceKeys.map((key) => [
            key,
            fixtureChildReceipt(key)
        ])),
        expectedBindings: {
            packageDigest: digest('fixture-package'),
            policyDigest: digest('fixture-policy-v3'),
            sourceCommit: digest('fixture-source').slice(0, 40),
            runFamily: 'fixture-run-family',
            candidateDigest: digest('fixture-candidate')
        }
    }
}

export async function assertPermanentLane(laneFile) {
    assert.ok(contract.laneFiles.includes(laneFile), laneFile)
    const loaded = await runtime()
    const result = await loaded.verifyPermanentE2ELane(laneFile)
    assert.equal(result.status, 'verified')
    assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/u)
}

export async function assertPermanentCrossRepoE2E() {
    const loaded = await runtime()
    const live = process.env.FSUSBLOG_E2E_LIVE === '1'
    const result = await loaded.runPermanentCrossRepoE2E(live
        ? {
            mode: 'live',
            repositoryRoot: root
        }
        : {
            mode: 'fixture',
            evidenceBundle: fixtureEvidenceBundle()
        })
    assert.equal(result.status, live
        ? 'production-verified'
        : 'fixture-verified')
    assert.equal(result.productionReady, live)
    assert.equal(result.temporaryBootstrapUsed, false)
    assert.equal(result.temporarySchedulerUsed, false)
    assert.deepEqual(result.quiescenceViolations, [])
    assert.equal(result.mutationControlsKilled, live ? 19 : 14)
    assert.match(result.receiptDigest, /^[a-f0-9]{64}$/u)
    const schema = JSON.parse(readFileSync(resolve(
        root,
        contract.receiptSchema
    ), 'utf8'))
    assert.deepEqual(validateJsonSchema(result, schema), [])
}
