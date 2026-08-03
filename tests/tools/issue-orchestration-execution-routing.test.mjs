import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeStateRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'issue-orchestration-routing-state-'
))
process.env.FSUS_ISSUE_ORCHESTRATION_STATE_ROOT = runtimeStateRoot

const {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    writerTestDigest
} = await import('./issue-orchestration-writer-stage-test-helper.mjs')
const routingRuntime = await import(
    '../../skills/'
    + 'issue-orchestration/scripts/execution-route-compiler.mjs'
)
const {
    compileProfileAvailabilityBinding,
    compileCanonicalRoute,
    verifyInstalledProductionPolicy,
    verifyReviewedRoutingAssumptions,
    verifyLiveCapabilityEvidence,
    EXECUTION_ROUTING_POLICY_DIGEST
} = routingRuntime

const packageRoot = path.join(
    root,
    '.'
)
const contract = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/issue-1875-routing-test-contract.json'
), 'utf8'))
const assumptions = JSON.parse(fs.readFileSync(path.join(
    packageRoot,
    'policy/reviewed-routing-assumptions.json'
), 'utf8'))
const fixturePaths = Object.freeze([
    'src/routing/atomic.mjs',
    'src/routing/second.mjs',
    'src/routing/third.mjs'
])
const fixtures = new Set()
const artifactCache = new Map()
after(() => {
    for (const fixture of fixtures) fixture.dispose()
    fs.rmSync(runtimeStateRoot, { force: true, recursive: true })
})

const hash = (value) => writerTestDigest(value)

function artifacts({
    stageRole = 'code-implementer',
    stagePhase = 'implementation',
    files = 1,
    overrides = {}
} = {}) {
    const cacheKey =
        `${stageRole}:${stagePhase}:${files}:${JSON.stringify(overrides)}`
    if (artifactCache.has(cacheKey)) return artifactCache.get(cacheKey)
    const selectedFixturePaths = fixturePaths.slice(0, files)
    const fixture = createWriterStageGitFixture({
        filePaths: [...selectedFixturePaths]
    })
    fixtures.add(fixture)
    const requiredFiles = fixture.filePaths.slice(0, 1)
    const compiled = compileWriterStageTestArtifacts({
        repository: stageRole === 'ui-ux-implementer'
            ? 'ExampleOrg/RepositoryA-ui-routing'
            : 'ExampleOrg/RepositoryA',
        issue: 1875,
        stageRole,
        stagePhase,
        baseSha: fixture.baseSha,
        epochId: `epoch-1875-${stageRole}-${stagePhase}-1`,
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [...fixture.filePaths],
        requiredFiles,
        requiredCommands: requiredFiles.map((file) =>
            `node --check ${file}`),
        sliceOverrides: [{
            maxOwnedModules: Math.max(1, files),
            ...overrides
        }]
    })
    artifactCache.set(cacheKey, compiled)
    return compiled
}

function classification(overrides = {}) {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: hash('routing-classification'),
        routingPolicyVersion: 'stage-model-pool.v3',
        ...overrides
    }
}

function metrics(overrides = {}) {
    return {
        expectedChangedFileCount: 1,
        ownedModuleCount: 1,
        commandLoopCount: 1,
        runtimeProbeDepth: 0,
        toolInteractionDepth: 2,
        contextBreadth: 'narrow',
        statefulContinuationRequired: false,
        checkpointSupportRequired: 'simple',
        firstActionDeterministic: true,
        wholeIssueScope: false,
        ...overrides
    }
}

function route({
    stageRole = 'code-implementer',
    stagePhase = 'implementation',
    files = 1,
    classificationOverrides = {},
    metricOverrides = {},
    routeOverrides = {},
    sliceOverrides = {}
} = {}) {
    const compiled = artifacts({
        stageRole,
        stagePhase,
        files,
        overrides: sliceOverrides
    })
    return compileCanonicalRoute({
        stageWorkPlan: compiled.stageWorkPlan,
        executableSlice: compiled.executableSlice,
        routingClassification: classification(classificationOverrides),
        executionMetrics: metrics({
            expectedChangedFileCount: 1,
            ownedModuleCount: files,
            ...metricOverrides
        }),
        machineClassificationEvidence: {
            schema: 'issue-orchestration.execution-shape-observation.v1',
            source: 'machine-slice-and-runtime-observer',
            observedAt: '2026-08-02T00:00:00+08:00',
            evidenceDigest: hash({
                files,
                metricOverrides
            })
        },
        ...routeOverrides
    })
}

function stageRoute({
    stageRole,
    stagePhase,
    classificationOverrides = {},
    routeOverrides = {}
}) {
    return compileCanonicalRoute({
        ...classification(classificationOverrides),
        stageRole,
        stagePhase,
        ...routeOverrides
    })
}

const authorizedProfiles = [
    'terra-low',
    'terra-medium',
    'terra-high',
    'luna-max',
    'sol-low',
    'sol-medium',
    'sol-high',
    'sol-xhigh',
    'sol-max'
]

function availabilityBinding({
    lunaAvailable = true,
    lunaReason = lunaAvailable ? null : 'runtime-unavailable'
} = {}) {
    return compileProfileAvailabilityBinding({
        packageDigest: hash('package'),
        runtimeInvocationId: 'runtime-invocation-routing-test',
        observedAt: '2026-08-03T08:30:00.000Z',
        catalogObservation: {
            schema:
                'issue-orchestration.runtime-profile-catalog-observation.v1',
            source: 'trusted-runtime-catalog-observer',
            paidInvocationCount: 0,
            profiles: authorizedProfiles.map((profileId) => ({
                profileId,
                available: profileId === 'luna-max'
                    ? lunaAvailable
                    : true,
                reason: profileId === 'luna-max'
                    ? lunaReason
                    : null
            }))
        }
    })
}

test('C01 freezes the permanent #1875 contract and four public schemas', () => {
    assert.equal(
        contract.issue,
        'Ozwasyd/issue-orchestration#18+#19'
    )
    for (const identity of contract.schemas) {
        const file = path.join(
            packageRoot,
            'contracts',
            contract.schemaFiles[identity]
        )
        const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
        assert.equal(schema.title, identity)
        assert.equal(schema.properties.schema.const, identity)
    }
})

test('C02 verifies reviewed assumptions without runtime-observation authority', () => {
    const verified = verifyReviewedRoutingAssumptions(assumptions)
    assert.equal(verified.schema,
        'issue-orchestration.reviewed-routing-assumptions.v1')
    assert.equal(verified.authority,
        'checked-in-reviewed-routing-assumptions')
    assert.equal(verified.runtimeObservationClaim, false)
    assert.equal(verified.selectorAuthority, false)
    assert.equal(verified.exactRouteValidationOnly, true)
})

test('C03 requires a verified #1874 executable slice and rejects whole issues', () => {
    assert.throws(
        () => compileCanonicalRoute({
            ...classification(),
            stageRole: 'code-implementer',
            stagePhase: 'implementation'
        }),
        { code: 'execution-route-verified-slice-required' }
    )
    assert.throws(
        () => route({
            metricOverrides: { wholeIssueScope: true }
        }),
        { code: 'execution-route-whole-issue-forbidden' }
    )
})

test('C04 high-risk single-file and bounded work cannot be shape-downgraded', () => {
    const highRiskSingleFile = route({
        classificationOverrides: {
            engineeringRiskClass: 'high-risk'
        }
    })
    assert.equal(
        highRiskSingleFile.executionRouteDecision.selectedProfile,
        'sol-high'
    )
    assert.equal(
        highRiskSingleFile.executionRouteDecision.routeCellId,
        'implementation.high-risk'
    )
    const bounded = route({
        files: 2,
        metricOverrides: {
            statefulContinuationRequired: true,
            checkpointSupportRequired: 'resumable'
        }
    })
    assert.equal(
        bounded.executionShapeClassification.dominantWorkShape,
        'bounded-multifile'
    )
    assert.equal(bounded.executionRouteDecision.selectedProfile, 'sol-medium')
    assert.equal(
        bounded.executionRouteDecision.routeCellId,
        'implementation.bounded-stateful-multifile'
    )
    assert.notEqual(bounded.executionRouteDecision.selectedProfile, 'terra-max')
})

test('C05 routes runtime and deep-tool work only to the enabled Sol roster', () => {
    const runtime = route({
        classificationOverrides: {
            engineeringRiskClass: 'high-risk',
            verificationClass: 'runtime'
        },
        metricOverrides: {
            runtimeProbeDepth: 4,
            toolInteractionDepth: 7,
            commandLoopCount: 3,
            contextBreadth: 'moderate',
            checkpointSupportRequired: 'resumable'
        }
    })
    assert.equal(
        runtime.executionShapeClassification.dominantWorkShape,
        'runtime-probe-heavy'
    )
    assert.equal(runtime.executionRouteDecision.selectedProfile, 'sol-high')

    const deep = route({
        files: 3,
        classificationOverrides: {
            engineeringRiskClass: 'high-risk',
            verificationClass: 'runtime'
        },
        metricOverrides: {
            runtimeProbeDepth: 4,
            toolInteractionDepth: 12,
            commandLoopCount: 4,
            contextBreadth: 'broad',
            statefulContinuationRequired: true,
            checkpointSupportRequired: 'resumable'
        }
    })
    assert.equal(deep.executionRouteDecision.selectedProfile, 'sol-xhigh')
})

test('C06 requires machine partition proof for long-horizon Sol/xhigh', () => {
    const longMetrics = {
        toolInteractionDepth: 16,
        commandLoopCount: 6,
        runtimeProbeDepth: 5,
        contextBreadth: 'very-broad',
        statefulContinuationRequired: true,
        checkpointSupportRequired: 'durable',
        unsplittableReason: 'all remaining writes share one atomic protocol'
    }
    assert.throws(
        () => route({ files: 3, metricOverrides: longMetrics }),
        { code: 'execution-route-unsplittable-evidence-required' }
    )
    const compiled = route({
        files: 3,
        metricOverrides: longMetrics,
        routeOverrides: {
            machinePartitionEvidence: {
                schema: 'issue-orchestration.slice-partition-evidence.v1',
                source: 'machine-slice-partition-analyzer',
                safePartitionCount: 1,
                dependencyCutCount: 0,
                evidenceDigest: hash('unsplittable')
            }
        }
    })
    assert.equal(
        compiled.executionShapeClassification.dominantWorkShape,
        'long-horizon-cross-module'
    )
    assert.equal(compiled.executionRouteDecision.selectedProfile, 'sol-xhigh')
})

test('C07 keeps Sol/max frontier-only and never uses it as fallback', () => {
    assert.throws(
        () => route({
            files: 3,
            metricOverrides: {
                toolInteractionDepth: 20,
                commandLoopCount: 8,
                runtimeProbeDepth: 6,
                contextBreadth: 'very-broad',
                statefulContinuationRequired: true,
                checkpointSupportRequired: 'durable',
                unsplittableReason: 'frontier protocol is indivisible'
            },
            routeOverrides: {
                requestedProfile: 'sol-max',
                machinePartitionEvidence: {
                    schema:
                        'issue-orchestration.slice-partition-evidence.v1',
                    source: 'machine-slice-partition-analyzer',
                    safePartitionCount: 1,
                    dependencyCutCount: 0,
                    evidenceDigest: hash('frontier-partition')
                }
            }
        }),
        { code: 'execution-route-root-profile-selection-forbidden' }
    )
})

test('C08 preserves UI low/medium implementation ownership', () => {
    const prescribed = route({
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation',
        classificationOverrides: {
            domain: 'ui-ux',
            uiDecisionClass: 'prescribed',
            verificationClass: 'ux-local'
        }
    })
    assert.equal(
        prescribed.executionRouteDecision.selectedProfile,
        'sol-low'
    )
    const layout = route({
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation',
        files: 2,
        classificationOverrides: {
            domain: 'ui-ux',
            uiDecisionClass: 'layout-judgment',
            verificationClass: 'ux-path'
        },
        metricOverrides: {
            toolInteractionDepth: 5,
            contextBreadth: 'moderate'
        }
    })
    assert.equal(layout.executionRouteDecision.selectedProfile, 'sol-medium')
    assert.throws(
        () => route({
            stageRole: 'ui-ux-implementer',
            stagePhase: 'ui-implementation',
            classificationOverrides: {
                domain: 'ui-ux',
                uiDecisionClass: 'interaction-judgment',
                verificationClass: 'ux-system'
            },
            metricOverrides: {
                toolInteractionDepth: 12,
                contextBreadth: 'broad',
                statefulContinuationRequired: true,
                checkpointSupportRequired: 'durable'
            }
        }),
        { code: 'execution-route-ui-reslice-or-adjudicate' }
    )
})

test('C09 rejects cost, balance, tokens, human choice and silent fallback', () => {
    for (const forbidden of [
        ['failureCount', 2],
        ['telemetryCost', 1],
        ['balance', 100],
        ['tokenCount', 4000],
        ['humanPreference', 'sol-xhigh'],
        ['requestedProfile', 'sol-high']
    ]) {
        assert.throws(
            () => route({
                routeOverrides: { [forbidden[0]]: forbidden[1] }
            }),
            {
                code: forbidden[0] === 'requestedProfile'
                    ? 'execution-route-root-profile-selection-forbidden'
                    : 'execution-route-forbidden-input'
            }
        )
    }
})

test('C10 requested/effective runtime metadata is part of route verification', () => {
    assert.throws(
        () => route({
            routeOverrides: {
                runtimeCapabilityObservation: {
                    requestedProfile: 'luna-max',
                    effectiveProfile: null
                }
            }
        }),
        { code: 'execution-route-runtime-unobservable' }
    )
})

test('C11-C12 failure and rework expose no profile-advance API', () => {
    assert.equal(
        Object.hasOwn(routingRuntime, 'compileExecutionReroute'),
        false
    )
    const routeDecision = route().executionRouteDecision
    assert.equal(routeDecision.previousRouteDecisionDigest, null)
    assert.equal(routeDecision.previousFailureReceiptDigest, null)
    assert.equal(routeDecision.retryAuthorizationDigest, null)
})

test('C13 Luna/max requires the complete fresh narrow-context contract', () => {
    const strictMetrics = {
        costSensitivity: 'cost-sensitive-deep',
        freshContext: true,
        contextBreadth: 'narrow',
        statefulContinuationRequired: false,
        checkpointSupportRequired: 'simple',
        ownedModuleCount: 1,
        commandLoopCount: 2,
        toolInteractionDepth: 4,
        runtimeProbeDepth: 1,
        firstActionDeterministic: true,
        compiledContextTokens: 32768,
        exactTokenizerAvailable: true,
        selfContainedPrompt: true,
        bulkCrossScopeContext: false
    }
    const selected = route({
        files: 1,
        sliceOverrides: { maxOwnedModules: 1 },
        metricOverrides: strictMetrics,
        routeOverrides: {
            runtimeAvailabilityBinding: availabilityBinding()
        }
    })
    assert.equal(
        selected.executionShapeClassification.dominantWorkShape,
        'luna-fresh-narrow-deep'
    )
    assert.equal(
        selected.executionRouteDecision.selectedProfile,
        'luna-max'
    )
    const mutations = [
        { freshContext: false },
        { contextBreadth: 'broad' },
        { statefulContinuationRequired: true },
        { checkpointSupportRequired: 'resumable' },
        { ownedModuleCount: 2 },
        { commandLoopCount: 3 },
        { toolInteractionDepth: 5 },
        { runtimeProbeDepth: 2 },
        { compiledContextTokens: 32769 },
        { exactTokenizerAvailable: false },
        { selfContainedPrompt: false },
        { bulkCrossScopeContext: true }
    ]
    for (const mutation of mutations) {
        assert.throws(() => route({
            files: mutation.ownedModuleCount === 2 ? 2 : 1,
            sliceOverrides: {
                maxOwnedModules:
                    mutation.ownedModuleCount === 2 ? 2 : 1
            },
            metricOverrides: {
                ...strictMetrics,
                ...mutation
            },
            routeOverrides: {
                runtimeAvailabilityBinding: availabilityBinding()
            }
        }), { code: 'execution-route-luna-contract' })
    }
})

test('C14 Luna has only the trusted pre-dispatch terra-high fallback', () => {
    const metricOverrides = {
        costSensitivity: 'cost-sensitive-deep',
        freshContext: true,
        compiledContextTokens: 20000,
        exactTokenizerAvailable: true,
        selfContainedPrompt: true,
        bulkCrossScopeContext: false
    }
    assert.throws(() => route({
        sliceOverrides: { maxOwnedModules: 1 },
        metricOverrides
    }), {
        code: 'execution-route-availability-binding-invalid'
    })
    const fallback = route({
        sliceOverrides: { maxOwnedModules: 1 },
        metricOverrides,
        routeOverrides: {
            runtimeAvailabilityBinding: availabilityBinding({
                lunaAvailable: false,
                lunaReason: 'runtime-unsupported'
            })
        }
    })
    assert.equal(
        fallback.executionRouteDecision.selectedProfile,
        'terra-high'
    )
    assert.equal(
        fallback.executionRouteDecision.availabilityFallbackReason,
        'runtime-unsupported'
    )
    const forged = structuredClone(availabilityBinding())
    forged.profiles['luna-max'] = {
        available: false,
        reason: 'task-failed'
    }
    assert.throws(() => route({
        sliceOverrides: { maxOwnedModules: 1 },
        metricOverrides,
        routeOverrides: { runtimeAvailabilityBinding: forged }
    }), {
        code: 'execution-route-availability-binding-invalid'
    })
})

test('C15 installation binds availability and reachability with zero paid rollouts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(
        packageRoot,
        'manifest.json'
    ), 'utf8'))
    const binding = compileProfileAvailabilityBinding({
        packageDigest: manifest.manifestDigest,
        runtimeInvocationId: 'runtime-install-observation',
        observedAt: '2026-08-03T08:31:00.000Z',
        catalogObservation: {
            schema:
                'issue-orchestration.runtime-profile-catalog-observation.v1',
            source: 'trusted-runtime-catalog-observer',
            paidInvocationCount: 0,
            profiles: authorizedProfiles.map((profileId) => ({
                profileId,
                available: true,
                reason: null
            }))
        }
    })
    const receipt = verifyInstalledProductionPolicy({
        manifest,
        availabilityBinding: binding
    })
    assert.equal(receipt.status, 'verified')
    assert.equal(receipt.paidModelInvocationCount, 0)
    assert.equal(receipt.comparativeQualificationPerformed, false)
    assert.ok(Object.values(receipt.routeReachability).every(Boolean))
})

test('C16 latency-sensitive code has an executable terra-high route cell', () => {
    const compiled = route({
        classificationOverrides: {
            engineeringRiskClass: 'complex'
        },
        metricOverrides: {
            costSensitivity: 'latency-sensitive',
            toolInteractionDepth: 4,
            contextBreadth: 'narrow'
        }
    })
    assert.equal(
        compiled.executionRouteDecision.routeCellId,
        'implementation.narrow-deep-latency-sensitive'
    )
    assert.equal(
        compiled.executionRouteDecision.selectedProfile,
        'terra-high'
    )
})

test('C17 verification routes security and runtime before generic observe-only shape', () => {
    const security = stageRoute({
        stageRole: 'test-owner',
        stagePhase: 'behavior-verification',
        classificationOverrides: {
            verificationClass: 'security',
            engineeringRiskClass: 'complex'
        }
    })
    assert.equal(
        security.executionRouteDecision.selectedProfile,
        'sol-xhigh'
    )
    assert.equal(
        security.executionRouteDecision.routeCellId,
        'verification.protocol-security-authority'
    )
    const runtime = stageRoute({
        stageRole: 'test-owner',
        stagePhase: 'behavior-verification',
        classificationOverrides: {
            verificationClass: 'runtime',
            engineeringRiskClass: 'complex'
        }
    })
    assert.equal(
        runtime.executionRouteDecision.selectedProfile,
        'sol-high'
    )
    assert.equal(
        runtime.executionRouteDecision.routeCellId,
        'verification.runtime-lifecycle-cross-module'
    )
})

test('C18 UX and DAG stage semantics share the canonical compiler', () => {
    const uxExpected = {
        'ux-local': 'sol-medium',
        'ux-path': 'sol-high',
        'ux-system': 'sol-xhigh'
    }
    for (const [verificationClass, expected] of
        Object.entries(uxExpected)) {
        const compiled = stageRoute({
            stageRole: 'ux-acceptance-verifier',
            stagePhase: 'ux-acceptance',
            classificationOverrides: {
                domain: 'ui-ux',
                uiDecisionClass: 'layout-judgment',
                verificationClass
            }
        })
        assert.equal(
            compiled.executionRouteDecision.selectedProfile,
            expected
        )
    }
    const reconstruction = stageRoute({
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        routeOverrides: {
            dagUpdateClass: 'full-reconstruction'
        }
    })
    assert.equal(
        reconstruction.executionRouteDecision.selectedProfile,
        'sol-high'
    )
    const conflict = stageRoute({
        stageRole: 'dag-creator-updater',
        stagePhase: 'semantic-proposal',
        classificationOverrides: {
            contractState: 'authority-conflict'
        }
    })
    assert.equal(
        conflict.executionRouteDecision.selectedProfile,
        'sol-xhigh'
    )
})

test('C19 route receipts bind one exact cell, all predicates and no search result', () => {
    const decision = route().executionRouteDecision
    assert.equal(decision.routingAuthority,
        'canonical-route-cell-compiler')
    assert.equal(decision.policyVersion,
        'execution-capability-routing.v4')
    assert.match(decision.routeCellId, /^implementation\./u)
    assert.match(decision.routeCellDigest, /^[a-f0-9]{64}$/u)
    assert.match(
        decision.selectingPredicatesDigest,
        /^[a-f0-9]{64}$/u
    )
    assert.equal(
        decision.canonicalPolicyDigest,
        EXECUTION_ROUTING_POLICY_DIGEST
    )
    assert.equal(decision.requiredProfile, decision.selectedProfile)
    assert.equal(decision.capabilityValidationResult, 'accepted')
    assert.deepEqual(decision.allowedProfiles, [
        decision.requiredProfile
    ])
})

test('C20 there is one exported production selector and no global ladder', () => {
    assert.equal(
        Object.hasOwn(routingRuntime, 'compileCanonicalRoute'),
        true
    )
    for (const legacy of [
        'compileExecutionRoute',
        'compileExecutionReroute',
        'compileStageRoute'
    ]) {
        assert.equal(Object.hasOwn(routingRuntime, legacy), false)
    }
    const compilerSource = fs.readFileSync(path.join(
        packageRoot,
        'skills/issue-orchestration/scripts/execution-route-compiler.mjs'
    ), 'utf8')
    const stageSource = fs.readFileSync(path.join(
        packageRoot,
        'skills/issue-orchestration/scripts/stage-profile-policy.mjs'
    ), 'utf8')
    assert.doesNotMatch(compilerSource, /selectionPriority/u)
    assert.doesNotMatch(compilerSource, /profileSatisfies/u)
    assert.doesNotMatch(
        stageSource,
        /export function compileStageRoute/u
    )
})

test('C21 legacy unbound observations and hand-edited scores fail closed', () => {
    const legacy = structuredClone(assumptions)
    legacy.authority = 'codex-v2-runtime-metadata-observer'
    assert.throws(
        () => verifyReviewedRoutingAssumptions(legacy),
        { code: 'execution-route-reviewed-assumptions-invalid' }
    )
    const numeric = structuredClone(assumptions)
    numeric.profiles['terra-low'].planningDepth = 5
    assert.throws(
        () => verifyReviewedRoutingAssumptions(numeric),
        { code: 'execution-route-reviewed-assumption-mismatch' }
    )
})

test('C22 live capability evidence is invocation and raw-evidence bound', () => {
    const raw = {
        schema:
            'issue-orchestration.live-capability-evidence.v1',
        authority:
            'invocation-bound-live-capability-evidence',
        runtimeInvocationId: 'invocation-18-19',
        sessionOrThreadId: 'thread-18-19',
        requestedProfile: 'sol-high',
        effectiveProfile: 'sol-high',
        requestedModel: 'gpt-5.6-sol',
        effectiveModel: 'gpt-5.6-sol',
        requestedEffort: 'high',
        effectiveEffort: 'high',
        multiAgentBackend: 'v2',
        runtimeVersion: 'codex-v2-test',
        fixtureOrTaskIdentity: 'issues-18-19-route-fixture',
        sourceCommit: 'a'.repeat(40),
        packageDigest: hash('package-18-19'),
        policyDigest: EXECUTION_ROUTING_POLICY_DIGEST,
        rawEventDigest: hash('events'),
        rawSessionDigest: hash('session'),
        rawTurnDigest: hash('turn'),
        executedCommandDigest: hash('commands'),
        toolTraceDigest: hash('tools'),
        observedAt: '2026-08-03T20:30:00+08:00',
        perFieldDerivation: {}
    }
    const derivedFields = [
        'runtimeInvocationId',
        'sessionOrThreadId',
        'requestedProfile',
        'effectiveProfile',
        'requestedModel',
        'effectiveModel',
        'requestedEffort',
        'effectiveEffort',
        'multiAgentBackend',
        'runtimeVersion',
        'fixtureOrTaskIdentity',
        'sourceCommit',
        'packageDigest',
        'policyDigest',
        'rawEventDigest',
        'rawSessionDigest',
        'rawTurnDigest',
        'executedCommandDigest',
        'toolTraceDigest',
        'observedAt'
    ]
    raw.perFieldDerivation = Object.fromEntries(
        derivedFields.map((field) => [field, {
            derivation:
                `deterministic derivation of ${field} from raw evidence`,
            sourceEvidenceDigests: [hash('events')],
            valueDigest: hash(raw[field])
        }])
    )
    const evidence = {
        ...raw,
        receiptDigest: hash(raw)
    }
    assert.equal(
        verifyLiveCapabilityEvidence(evidence),
        evidence
    )
    for (const field of contract.requiredLiveEvidenceFields) {
        assert.equal(Object.hasOwn(evidence, field), true, field)
    }
    const replay = structuredClone(evidence)
    replay.runtimeInvocationId = 'other-invocation'
    assert.throws(
        () => verifyLiveCapabilityEvidence(replay),
        { code: 'execution-route-live-capability-receipt-invalid' }
    )
    const partial = structuredClone(evidence)
    delete partial.perFieldDerivation.requestedModel
    const unsignedPartial = structuredClone(partial)
    delete unsignedPartial.receiptDigest
    partial.receiptDigest = hash(unsignedPartial)
    assert.throws(
        () => verifyLiveCapabilityEvidence(partial),
        { code: 'execution-route-live-capability-evidence-invalid' }
    )
})
