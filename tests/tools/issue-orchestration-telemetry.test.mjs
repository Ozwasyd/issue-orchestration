import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    validateJsonSchema
} from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = resolve(import.meta.dirname, '../..')
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const packageScripts =
    'skills/issue-orchestration/scripts'
const implementationRelative = `${packageScripts}/telemetry.mjs`
const implementationPath = resolve(root, implementationRelative)
const contractRoot = resolve(
    root,
    'contracts'
)
const HASH = /^[a-f0-9]{64}$/u

const readJson = (name) =>
    JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'))
const digest = (value) => createHash('sha256')
    .update(String(value))
    .digest('hex')

const sourceSchemas = {
    'event-ledger': 'issue-orchestration.event.v2',
    'dispatch-receipt': 'issue-orchestration.dispatch-receipt.v2',
    'dispatch-batch': 'issue-orchestration.dispatch-batch-receipt.v1',
    'delivery-epoch': 'issue-orchestration.delivery-epoch-receipt.v1',
    'resource-lifecycle':
        'issue-orchestration.resource-cleanup-receipt.v1',
    'acceptance-group':
        'issue-orchestration.acceptance-group-session-receipt.v1',
    'dag-update-decision':
        'issue-orchestration.dag-update-decision-receipt.v1',
    landing: 'issue-orchestration.landing-receipt.v1',
    'human-decision': 'issue-orchestration.human-decision-receipt.v1',
    'stage-work-plan': 'issue-orchestration.slice-terminal-receipt.v1',
    'execution-route': 'issue-orchestration.execution-route-decision.v2'
}

const stateDigestFields = [
    'gitStateDigest',
    'attemptStateDigest',
    'sliceStateDigest',
    'checkpointStateDigest',
    'breakerStateDigest',
    'routeStateDigest',
    'profileStateDigest',
    'processStateDigest',
    'dockerStateDigest',
    'lockStateDigest',
    'filesystemStateDigest',
    'installStateDigest',
    'landingStateDigest',
    'humanDecisionStateDigest'
]

let implementationPromise
async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1826 telemetry owner: ${implementationRelative}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of [
        'canonicalTelemetryDigest',
        'compileTelemetryBundle',
        'sealVerifiedTelemetrySourceProjection',
        'validateTelemetryDocument',
        'validateTelemetrySourceProjection'
    ]) {
        assert.equal(typeof loaded[name], 'function', `missing export ${name}`)
    }
    assert.equal(loaded.NOT_OBSERVED, 'not-observed')
    return loaded
}

function baseFacts(overrides = {}) {
    return {
        runId: 'run-1826-1',
        nodeId: 'node-1826-1',
        attemptId: 'attempt-1826-1',
        role: 'implementer',
        stagePhase: 'implementation',
        timestamp: '2026-08-02T00:00:00.000Z',
        eventType: 'stage-observation',
        repository: 'ExampleOrg/RepositoryA',
        epochId: 'epoch-1826-1',
        baseSha: '1'.repeat(40),
        domain: 'tooling',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'not-applicable',
        contractState: 'verified',
        verificationClass: 'focused',
        workPlanDigest: digest('work-plan'),
        sliceId: 'slice-1826-1',
        sliceDigest: digest('slice-1'),
        compiledPromptDigest: digest('compiled-prompt-1'),
        workShape: 'bounded-multifile',
        dominantWorkShape: 'bounded-multifile',
        capabilityRequirementDigest: digest('capability'),
        routingPolicyVersion: 'routing-policy-v1',
        routingInputDigest: digest('routing-input'),
        executionRouteDecisionDigest: digest('route-decision'),
        selectedProfile: 'luna-bounded',
        requestedModel: 'gpt-5.6-luna',
        requestedEffort: 'high',
        requestedSandbox: 'workspace-write',
        candidateDigest: digest('candidate-1'),
        contractDigest: digest('contract-1'),
        skillDigest: digest('skill-1'),
        baselineDigest: digest('baseline-1'),
        contextDigest: digest('context-1'),
        ...overrides
    }
}

async function source(key, {
    authority = 'event-ledger',
    kind = authority === 'event-ledger' ? 'event' : 'receipt',
    facts = baseFacts()
} = {}) {
    const { sealVerifiedTelemetrySourceProjection } = await implementation()
    return sealVerifiedTelemetrySourceProjection({
        sourceKind: kind,
        sourceAuthority: authority,
        sourceSchema: sourceSchemas[authority],
        sourceDigest: digest(`source:${key}`),
        verificationEvidenceDigest: digest(`verification:${key}`),
        facts
    })
}

function assertCode(action, expectedCode) {
    assert.throws(action, (error) => {
        assert.equal(error?.code, expectedCode)
        assert.equal(error?.message, expectedCode)
        return true
    })
}

async function happySources() {
    return [
        await source('dispatch', {
            authority: 'dispatch-receipt',
            facts: baseFacts({
                effectiveMetadataObserved: true,
                effectiveModel: 'gpt-5.6-luna',
                effectiveEffort: 'high',
                effectiveSandbox: 'workspace-write',
                runtimeMetadataDigest: digest('runtime-metadata'),
                queuedAt: '2026-08-02T00:00:00.000Z',
                startedAt: '2026-08-02T00:00:00.010Z',
                completedAt: '2026-08-02T00:00:00.030Z',
                firstArtifactAt: '2026-08-02T00:00:00.015Z',
                firstWriteAt: '2026-08-02T00:00:00.020Z',
                firstArtifactProduced: true,
                firstWriteProduced: true,
                firstPassSliceTerminal: true,
                candidateGreen: true,
                nodeStatus: 'completed',
                observableCost: 2.5
            })
        }),
        await source('group-member-1', {
            authority: 'acceptance-group',
            facts: baseFacts({
                groupId: 'group-1826',
                memberIssueId: 'RepositoryA-1826',
                memberProfile: 'luna-bounded',
                memberStatus: 'green',
                memberWaitDuration: 2,
                memberActiveDuration: 20,
                memberWallDuration: 22,
                groupTotalWallDuration: 30,
                coldStarts: 1,
                freshVerifierCount: 1
            })
        }),
        await source('group-member-2', {
            authority: 'acceptance-group',
            facts: baseFacts({
                attemptId: 'attempt-1826-2',
                sliceId: 'slice-1826-2',
                sliceDigest: digest('slice-2'),
                groupId: 'group-1826',
                memberIssueId: 'RepositoryA-1827',
                memberProfile: 'terra-bounded',
                memberStatus: 'pending',
                humanPendingCount: 1
            })
        }),
        await source('dag', {
            authority: 'dag-update-decision',
            facts: baseFacts({
                dagUpdateMode: 'none',
                dagUpdaterDispatched: false,
                graphPatchOperationCount: 0
            })
        }),
        await source('landing', {
            authority: 'landing',
            facts: baseFacts({
                landingAttemptCount: 1,
                sourceCommitCount: 1,
                mappedCommitCount: 1,
                unmappedCommitCount: 0,
                sourceCommitId: '4'.repeat(40),
                mappedCommitId: '5'.repeat(40),
                forcePushAttemptCount: 0,
                fastForwardPushCount: 1,
                reverificationClass: 'fresh',
                landingCleanupState: 'resources-clean'
            })
        }),
        await source('human', {
            authority: 'human-decision',
            facts: baseFacts({
                humanDecisionRequestCount: 1,
                optionCount: 2,
                decisionRecordedCount: 1,
                requestTriggerClass: 'authority-only',
                requestingAuthorityRole: 'root-scheduler',
                requiredHumanAuthority: 'repository-owner',
                postDecisionRerouteProfile: 'terra-bounded'
            })
        }),
        await source('slice', {
            authority: 'stage-work-plan',
            facts: baseFacts({
                singleObjectivePresent: true,
                firstRequiredActionPresent: true,
                firstRequiredActionExecuted: true,
                firstWritablePathPresent: true,
                requiredArtifactManifestPresent: true,
                explicitNonGoalsPresent: true,
                promptCompiledDeterministically: true,
                checkpointRequired: true,
                checkpointProduced: true,
                checkpointVerified: true,
                continuationRequired: true,
                continuationRecovered: true,
                checkpointCount: 1,
                continuationCount: 1,
                continuationStartedAt: '2026-08-02T00:00:00.030Z',
                continuationRecoveredAt: '2026-08-02T00:00:00.035Z',
                sliceChangedFileBudget: 4,
                actualChangedFiles: 2,
                ownedModuleBudget: 2,
                actualOwnedModules: 1
            })
        }),
        await source('resource', {
            authority: 'resource-lifecycle',
            facts: baseFacts({
                resourceState: 'resources-clean',
                cleanupLatency: 4,
                resourceRetentionDuration: 10
            })
        })
    ]
}

test('#1826 fixtures pin all schemas, acceptance rows and mutation ids', async () => {
    const { TELEMETRY_SCHEMAS } = await implementation()
    const contract = readJson('telemetry-test-contract.json')
    const acceptance = readJson('telemetry-acceptance-map.json')
    const mutations = readJson('telemetry-mutation-controls.json')
    const expected = readJson('telemetry-expected-initial-failures.json')
    const probes = readJson('telemetry-runtime-probes.json')

    assert.deepEqual(contract.schemas, Object.values(TELEMETRY_SCHEMAS))
    assert.deepEqual(
        acceptance.acceptance.map(({ id }) => id),
        Array.from({ length: 14 }, (_, index) =>
            `A${String(index + 1).padStart(2, '0')}`)
    )
    assert.deepEqual(
        mutations.controls.map(({ id }) => id),
        expected.mutationIds
    )
    assert.deepEqual(
        probes.probes.map(({ id }) => id),
        Array.from({ length: 10 }, (_, index) =>
            `P${String(index + 1).padStart(2, '0')}`)
    )
})

test('#1826 emits and verifies all ten versioned telemetry documents', async () => {
    const {
        compileTelemetryBundle,
        TELEMETRY_SCHEMAS,
        validateTelemetryDocument
    } = await implementation()
    const bundle = compileTelemetryBundle({ sources: await happySources() })
    const summaries = Object.entries(bundle)
        .filter(([name]) => name !== 'events')
        .map(([, summary]) => summary)
    const schemas = new Set([
        ...bundle.events.map(({ schema }) => schema),
        ...summaries.map(({ schema }) => schema)
    ])

    assert.deepEqual(schemas, new Set(Object.values(TELEMETRY_SCHEMAS)))
    assert.equal(summaries.length, 9)
    for (const document of [...bundle.events, ...summaries]) {
        assert.equal(validateTelemetryDocument(document), document)
        const schemaName = document.schema.split('.').at(-2)
        const schema = JSON.parse(readFileSync(
            resolve(contractRoot, `${schemaName}.schema.json`),
            'utf8'
        ))
        assert.equal(schema.title, document.schema)
        assert.deepEqual(validateJsonSchema(document, schema), [])
        const documentDigest = document.telemetryEventDigest
            ?? document.summaryDigest
        assert.match(documentDigest, HASH)
    }
    assert.equal(bundle.dagUpdateSummary.falsePositiveDagDispatchCount, 0)
    assert.deepEqual(bundle.landingSummary.commitMappings, [{
        sourceCommitId: '4'.repeat(40),
        mappedCommitId: '5'.repeat(40),
        sliceId: 'slice-1826-1',
        sliceDigest: digest('slice-1'),
        reverificationClass: 'fresh',
        sourceReceiptDigest: digest('source:landing')
    }])
    assert.deepEqual(
        bundle.humanDecisionSummary.postDecisionRerouteProfileCounts,
        { 'terra-bounded': 1 }
    )
    assert.deepEqual(
        bundle.acceptanceGroupSummary.groups[0].members.map((member) => ({
            issue: member.memberIssueId,
            status: Object.keys(member.statusCounts)[0]
        })),
        [
            { issue: 'RepositoryA-1826', status: 'green' },
            { issue: 'RepositoryA-1827', status: 'pending' }
        ]
    )
    assert.deepEqual(bundle.runSummary.resourceStateCounts, {
        'resources-clean': 1
    })
})

test('#1826 canonical ordering is input invariant and duplicates are idempotent',
    async () => {
        const { compileTelemetryBundle } = await implementation()
        const left = await source('order-left')
        const right = await source('order-right', {
            facts: baseFacts({
                attemptId: 'attempt-1826-order-right',
                timestamp: '2026-08-02T00:00:01.000Z'
            })
        })

        assert.deepEqual(
            compileTelemetryBundle({ sources: [left, right] }),
            compileTelemetryBundle({ sources: [right, left, left] })
        )

        const conflict = await source('order-left', {
            facts: baseFacts({ nodeId: 'node-conflicting-projection' })
        })
        assertCode(
            () => compileTelemetryBundle({ sources: [left, conflict] }),
            'telemetry-source-digest-conflict'
        )
    })

test('#1826 rejects unverified, malformed and tampered source projections',
    async () => {
        const {
            TELEMETRY_SCHEMAS,
            sealVerifiedTelemetrySourceProjection,
            validateTelemetrySourceProjection
        } = await implementation()
        const sealed = await source('tamper')

        const tamperedFacts = structuredClone(sealed)
        tamperedFacts.facts.nodeId = 'tampered-node'
        assertCode(
            () => validateTelemetrySourceProjection(tamperedFacts),
            'telemetry-facts-digest-mismatch'
        )

        const unverified = structuredClone(sealed)
        unverified.integrityStatus = 'rejected'
        assertCode(
            () => validateTelemetrySourceProjection(unverified),
            'telemetry-source-not-verified'
        )

        const extraField = structuredClone(sealed)
        extraField.raw = 'not-allowlisted'
        assertCode(
            () => validateTelemetrySourceProjection(extraField),
            'telemetry-source-shape-invalid'
        )

        assertCode(() => sealVerifiedTelemetrySourceProjection({
            sourceKind: 'receipt',
            sourceAuthority: 'landing',
            sourceSchema: TELEMETRY_SCHEMAS.landing,
            sourceDigest: digest('output-as-source'),
            verificationEvidenceDigest: digest('output-as-source-proof'),
            facts: baseFacts()
        }), 'telemetry-source-schema-invalid')
    })

test('#1826 separates requested metadata from runtime-observed effective metadata',
    async () => {
        const {
            compileTelemetryBundle,
            NOT_OBSERVED,
            sealVerifiedTelemetrySourceProjection
        } = await implementation()
        const requestedOnly = await source('requested-only', {
            authority: 'dispatch-receipt'
        })
        const requestedEvent = compileTelemetryBundle({
            sources: [requestedOnly]
        }).events[0]
        assert.equal(requestedEvent.requestedModel, 'gpt-5.6-luna')
        assert.equal(requestedEvent.effectiveModel, NOT_OBSERVED)
        assert.equal(requestedEvent.effectiveEffort, NOT_OBSERVED)
        assert.equal(requestedEvent.effectiveSandbox, NOT_OBSERVED)

        assertCode(() => sealVerifiedTelemetrySourceProjection({
            sourceKind: 'receipt',
            sourceAuthority: 'dispatch-receipt',
            sourceSchema: sourceSchemas['dispatch-receipt'],
            sourceDigest: digest('copied-effective'),
            verificationEvidenceDigest: digest('copied-effective-proof'),
            facts: baseFacts({
                effectiveModel: 'gpt-5.6-luna',
                runtimeMetadataDigest: digest('unobserved-runtime')
            })
        }), 'telemetry-effective-metadata-unverified')

        const observedRuntime = await source('observed-runtime', {
            authority: 'execution-route',
            facts: baseFacts({
                effectiveMetadataObserved: true,
                effectiveModel: 'gpt-5.6-terra',
                effectiveEffort: 'xhigh',
                effectiveSandbox: 'workspace-write',
                runtimeMetadataDigest: digest('observed-runtime-proof'),
                routeOutcome: 'rejected'
            })
        })
        const observedEvent = compileTelemetryBundle({
            sources: [observedRuntime]
        }).events[0]
        assert.equal(observedEvent.effectiveModel, 'gpt-5.6-terra')
        assert.equal(observedEvent.attributes.routeOutcome, 'rejected')
    })

test('#1826 derives durations and deterministic median and nearest-rank p95',
    async () => {
        const { compileTelemetryBundle, NOT_OBSERVED } =
            await implementation()
        const start = Date.parse('2026-08-02T00:00:00.000Z')
        const sources = []
        for (let duration = 1; duration <= 20; duration += 1) {
            sources.push(await source(`duration-${duration}`, {
                authority: 'stage-work-plan',
                facts: baseFacts({
                    attemptId: `attempt-duration-${duration}`,
                    startedAt: new Date(start).toISOString(),
                    completedAt: new Date(start + duration).toISOString()
                })
            }))
        }
        const bundle = compileTelemetryBundle({ sources })
        assert.deepEqual(bundle.runSummary.wallDuration, {
            observedCount: 20,
            notObservedCount: 0,
            median: 10.5,
            p95: 19
        })
        assert.deepEqual(bundle.modelPoolSummary.cells[0].wallDuration, {
            observedCount: 20,
            notObservedCount: 0,
            median: 10.5,
            p95: 19
        })
        assert.equal(
            compileTelemetryBundle({ sources: [] })
                .runSummary.wallDuration.median,
            NOT_OBSERVED
        )
        assert.equal(
            compileTelemetryBundle({ sources: [] })
                .runSummary.wallDuration.p95,
            NOT_OBSERVED
        )
    })

test('#1826 rejects negative, fractional and mismatched durations', async () => {
    const { sealVerifiedTelemetrySourceProjection } = await implementation()
    const sealFacts = (key, facts) => sealVerifiedTelemetrySourceProjection({
        sourceKind: 'receipt',
        sourceAuthority: 'stage-work-plan',
        sourceSchema: sourceSchemas['stage-work-plan'],
        sourceDigest: digest(key),
        verificationEvidenceDigest: digest(`${key}-proof`),
        facts
    })
    assertCode(
        () => sealFacts('negative-duration', baseFacts({
            wallDuration: -1
        })),
        'telemetry-count-invalid'
    )
    assertCode(
        () => sealFacts('fractional-duration', baseFacts({
            wallDuration: 1.5
        })),
        'telemetry-count-invalid'
    )
    assertCode(
        () => sealFacts('mismatched-duration', baseFacts({
            startedAt: '2026-08-02T00:00:00.000Z',
            completedAt: '2026-08-02T00:00:00.010Z',
            wallDuration: 11
        })),
        'telemetry-duration-mismatch'
    )
    assertCode(
        () => sealFacts('reversed-duration', baseFacts({
            startedAt: '2026-08-02T00:00:00.010Z',
            completedAt: '2026-08-02T00:00:00.000Z'
        })),
        'telemetry-duration-order-invalid'
    )
})

test('#1826 projection allowlist rejects private content without echoing it',
    async () => {
        const { sealVerifiedTelemetrySourceProjection } =
            await implementation()
        for (const field of [
            'rawPrompt',
            'issueBody',
            'sourceDiff',
            'commandOutput',
            'humanFreeText',
            'secret',
            'personalEmail',
            'chainOfThought'
        ]) {
            const sensitive = `sensitive-${field}-must-not-leak`
            assert.throws(() => sealVerifiedTelemetrySourceProjection({
                sourceKind: 'event',
                sourceAuthority: 'event-ledger',
                sourceSchema: sourceSchemas['event-ledger'],
                sourceDigest: digest(`private:${field}`),
                verificationEvidenceDigest: digest(`private-proof:${field}`),
                facts: baseFacts({ [field]: sensitive })
            }), (error) => {
                assert.equal(
                    error?.code,
                    'telemetry-private-or-unknown-field'
                )
                assert.equal(error?.field, field)
                assert.equal(error?.message.includes(sensitive), false)
                return true
            })
        }
    })

test('#1826 semantic failure identity ignores retry and execution lineage',
    async () => {
        const { compileTelemetryBundle } = await implementation()
        const stableFailure = {
            failureClass: 'machine-test-failure',
            outputMissingCause: 'runtime-invocation-failed',
            nodeSemanticDigest: digest('semantic-node'),
            objectiveDigest: digest('semantic-objective'),
            failingObligationDigest: digest('failing-obligation'),
            machineFailureSignatureDigest: digest('machine-signature')
        }
        const first = await source('semantic-failure-1', {
            facts: baseFacts({
                ...stableFailure,
                attemptId: 'attempt-semantic-1',
                sliceId: 'slice-semantic-1',
                sliceDigest: digest('semantic-slice-1'),
                compiledPromptDigest: digest('semantic-prompt-1'),
                baseSha: '2'.repeat(40),
                epochId: 'semantic-epoch-1',
                selectedProfile: 'luna-bounded',
                candidateDigest: digest('semantic-candidate-1'),
                baselineDigest: digest('semantic-baseline-1')
            })
        })
        const second = await source('semantic-failure-2', {
            facts: baseFacts({
                ...stableFailure,
                attemptId: 'attempt-semantic-2',
                sliceId: 'slice-semantic-2',
                sliceDigest: digest('semantic-slice-2'),
                compiledPromptDigest: digest('semantic-prompt-2'),
                baseSha: '3'.repeat(40),
                epochId: 'semantic-epoch-2',
                selectedProfile: 'terra-bounded',
                candidateDigest: digest('semantic-candidate-2'),
                baselineDigest: digest('semantic-baseline-2')
            })
        })
        const insufficient = await source('semantic-failure-insufficient', {
            facts: baseFacts({
                failureClass: 'machine-test-failure',
                nodeSemanticDigest: digest('semantic-node'),
                objectiveDigest: digest('semantic-objective'),
                failingObligationDigest: digest('failing-obligation')
            })
        })
        const failures = compileTelemetryBundle({
            sources: [first, second, insufficient]
        }).runSummary.failures

        assert.equal(failures.uniqueFailureCount, 1)
        assert.equal(failures.duplicateOccurrenceCount, 1)
        assert.equal(failures.insufficientIdentityCount, 1)
        assert.deepEqual(failures.semanticFailures.map((failure) => ({
            occurrences: failure.occurrenceCount,
            attempts: failure.distinctAttemptCount,
            slices: failure.distinctSliceCount
        })), [{ occurrences: 2, attempts: 2, slices: 2 }])
    })

test('#1826 only accepts resource state from resource-lifecycle authority',
    async () => {
        const { compileTelemetryBundle, sealVerifiedTelemetrySourceProjection } =
            await implementation()
        assertCode(() => sealVerifiedTelemetrySourceProjection({
            sourceKind: 'receipt',
            sourceAuthority: 'landing',
            sourceSchema: sourceSchemas.landing,
            sourceDigest: digest('resource-wrong-authority'),
            verificationEvidenceDigest: digest('resource-wrong-proof'),
            facts: baseFacts({ resourceState: 'resources-clean' })
        }), 'telemetry-resource-authority')

        const authoritative = await source('resource-authoritative', {
            authority: 'resource-lifecycle',
            facts: baseFacts({ resourceState: 'quarantined-dirty' })
        })
        assert.deepEqual(
            compileTelemetryBundle({ sources: [authoritative] })
                .runSummary.resourceStateCounts,
            { 'quarantined-dirty': 1 }
        )
    })

test('#1826 run summary exports every final state digest', async () => {
    const { compileTelemetryBundle } = await implementation()
    const expected = Object.fromEntries(stateDigestFields.map((field) => [
        field, digest(`state:${field}`)
    ]))
    const stateSource = await source('state-digests', {
        facts: baseFacts({
            timestamp: '2026-08-02T00:00:10.000Z',
            ...expected
        })
    })
    assert.deepEqual(
        compileTelemetryBundle({ sources: [stateSource] })
            .runSummary.stateDigests,
        expected
    )
})

test('#1826 all mutation controls fail closed with their pinned code',
    async () => {
        const {
            compileTelemetryBundle,
            sealVerifiedTelemetrySourceProjection
        } = await implementation()
        const controls =
            readJson('telemetry-mutation-controls.json').controls
        for (const [index, control] of controls.entries()) {
            if (control.special === 'effective-unobserved') {
                assertCode(() => sealVerifiedTelemetrySourceProjection({
                    sourceKind: 'receipt',
                    sourceAuthority: 'dispatch-receipt',
                    sourceSchema: sourceSchemas['dispatch-receipt'],
                    sourceDigest: digest(`mutation-source:${control.id}`),
                    verificationEvidenceDigest:
                        digest(`mutation-proof:${control.id}`),
                    facts: baseFacts({
                        requestedModel: 'gpt-5.6-luna',
                        effectiveModel: 'gpt-5.6-luna',
                        runtimeMetadataDigest:
                            digest(`mutation-runtime:${control.id}`)
                    })
                }), control.expectedCode)
                continue
            }
            const mutatedSource = await source(`mutation-${index}`, {
                facts: baseFacts({ [control.field]: control.value })
            })
            assertCode(
                () => compileTelemetryBundle({ sources: [mutatedSource] }),
                control.expectedCode
            )
        }

        const runtimeDagDispatch = await source('runtime-dag-dispatch', {
            authority: 'landing',
            facts: baseFacts({ dagUpdaterDispatched: true })
        })
        assertCode(
            () => compileTelemetryBundle({ sources: [runtimeDagDispatch] }),
            'telemetry-runtime-event-dag-updater'
        )
    })

test('#1826 compiler is a frozen pure projection and rejects policy inputs',
    async () => {
        const { compileTelemetryBundle } = await implementation()
        const sources = [await source('pure-projection')]
        const before = structuredClone(sources)
        const bundle = compileTelemetryBundle({ sources })

        assert.deepEqual(sources, before)
        assert.equal(Object.isFrozen(bundle), true)
        assert.equal(Object.isFrozen(bundle.runSummary), true)
        assert.equal(Object.isFrozen(bundle.events[0].measurements), true)
        assertCode(
            () => compileTelemetryBundle({
                sources,
                policy: { selectedProfile: 'forbidden-mutation-input' }
            }),
            'telemetry-compiler-input-invalid'
        )
    })
