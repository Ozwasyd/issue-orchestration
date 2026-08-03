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
const {
    compileExecutionRoute,
    compileExecutionReroute,
    verifyProfileCapabilityMatrix
} = await import(
    '../../skills/'
    + 'issue-orchestration/scripts/execution-route-compiler.mjs'
)

const packageRoot = path.join(
    root,
    '.'
)
const contract = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/issue-1875-routing-test-contract.json'
), 'utf8'))
const matrix = JSON.parse(fs.readFileSync(path.join(
    packageRoot,
    'policy/profile-capability-matrix.json'
), 'utf8'))
const observations = JSON.parse(fs.readFileSync(path.join(
    packageRoot,
    'policy/profile-capability-observations.json'
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
    const cacheKey = `${stageRole}:${stagePhase}`
    if (artifactCache.has(cacheKey)) return artifactCache.get(cacheKey)
    const fixture = createWriterStageGitFixture({
        filePaths: [...fixturePaths]
    })
    fixtures.add(fixture)
    const requiredFiles = fixture.filePaths.slice(0, 1)
    const compiled = compileWriterStageTestArtifacts({
        repository: stageRole === 'ui-ux-implementer'
            ? 'Ozwasyd/FsusBlog-ui-routing'
            : 'Ozwasyd/FsusBlog',
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
            maxOwnedModules: 3,
            ...overrides
        }]
    })
    artifactCache.set(cacheKey, compiled)
    return compiled
}

function classification(overrides = {}) {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: 'Ozwasyd/FsusBlog',
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
    return compileExecutionRoute({
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

test('C01 freezes the permanent #1875 contract and four public schemas', () => {
    assert.equal(contract.issue, 'Ozwasyd/FsusBlog#1875')
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

test('C02 recomputes the sole capability matrix from machine observations', () => {
    const verified = verifyProfileCapabilityMatrix({
        matrix,
        observations
    })
    assert.equal(verified.schema,
        'issue-orchestration.profile-capability-matrix.v2')
    assert.equal(verified.evidenceAuthority,
        'recomputed-codex-v2-runtime-observations')
    assert.equal(verified.modelSelfReportAccepted, false)
    for (const field of contract.requiredEvidenceFields) {
        assert.ok(observations.observations.every((item) =>
            Object.hasOwn(item, field)), field)
    }
})

test('C03 requires a verified #1874 executable slice and rejects whole issues', () => {
    assert.throws(
        () => compileExecutionRoute({
            routingClassification: classification(),
            executionMetrics: metrics()
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

test('C04 routes atomic and bounded slices to the minimum capable Terra profile', () => {
    const bounded = route({
        files: 2,
        classificationOverrides: { engineeringRiskClass: 'high-risk' }
    })
    assert.equal(
        bounded.executionShapeClassification.dominantWorkShape,
        'bounded-multifile'
    )
    assert.equal(bounded.executionRouteDecision.selectedProfile, 'terra-medium')
    assert.notEqual(bounded.executionRouteDecision.selectedProfile, 'terra-max')
})

test('C05 selects the minimum capable Terra profiles for runtime and deep tools', () => {
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
    assert.equal(runtime.executionRouteDecision.selectedProfile, 'terra-max')

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
    assert.equal(deep.executionRouteDecision.selectedProfile, 'terra-xhigh')
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
    assert.equal(compiled.executionRouteDecision.selectedProfile, 'sol-high')
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

test('C11 output-missing reroute needs mismatch, prior failure and retry authority', () => {
    const prior = route()
    const revisedArtifacts = artifacts()
    const revised = () => compileExecutionReroute({
        previousDecision: prior.executionRouteDecision,
        revisedRouteInput: {
            stageWorkPlan: revisedArtifacts.stageWorkPlan,
            executableSlice: revisedArtifacts.executableSlice,
            routingClassification: classification(),
            executionMetrics: metrics({
                toolInteractionDepth: 12,
                contextBreadth: 'broad',
                checkpointSupportRequired: 'resumable'
            })
        },
        failureReceipt: {
            failureClass: 'writer-stage.output-missing'
        }
    })
    assert.throws(revised, {
        code: 'execution-reroute-profile-mismatch-required'
    })
})

test('C12 valid mismatch reroute changes candidate identity and binds authority', () => {
    const prior = route()
    const failureReceipt = {
        schema: 'issue-orchestration.writer-stage-failure-receipt.v1',
        failureClass: 'profile-capability-mismatch',
        previousRouteDecisionDigest:
            prior.executionRouteDecision.routeDecisionDigest,
        candidateReceiptDigest: hash('old-candidate'),
        receiptDigest: hash('failure-receipt')
    }
    const retryAuthorization = {
        schema: 'issue-orchestration.writer-stage-retry-authorization.v1',
        failureReceiptDigest: failureReceipt.receiptDigest,
        breakerResetReceiptDigest: hash('breaker-reset'),
        authorizationDigest: hash('retry-authorization')
    }
    const revisedArtifacts = artifacts()
    const next = compileExecutionReroute({
        previousDecision: prior.executionRouteDecision,
        revisedRouteInput: {
            stageWorkPlan: revisedArtifacts.stageWorkPlan,
            executableSlice: revisedArtifacts.executableSlice,
            routingClassification: classification(),
            executionMetrics: metrics({
                toolInteractionDepth: 12,
                commandLoopCount: 4,
                contextBreadth: 'broad',
                statefulContinuationRequired: true,
                checkpointSupportRequired: 'resumable'
            }),
            machineClassificationEvidence: {
                schema:
                    'issue-orchestration.execution-shape-observation.v1',
                source: 'machine-slice-and-runtime-observer',
                observedAt: '2026-08-02T00:01:00+08:00',
                evidenceDigest: hash('revised-shape')
            },
            runtimeCapabilityObservation: {
                schema:
                    'issue-orchestration.runtime-capability-observation.v1',
                source: 'runtime-capability-registry',
                requestedModel: 'gpt-5.6-terra',
                effectiveModel: 'gpt-5.6-terra',
                requestedEffort: 'xhigh',
                effectiveEffort: 'xhigh',
                multiAgentBackend: 'v2',
                observable: true,
                observationDigest: hash('runtime-capability')
            }
        },
        failureReceipt,
        retryAuthorization,
        previousCandidateReceiptDigest:
            failureReceipt.candidateReceiptDigest,
        nextCandidateReceiptDigest: hash('new-candidate')
    })
    assert.equal(next.executionRouteDecision.selectedProfile, 'terra-xhigh')
    assert.equal(
        next.executionRouteDecision.previousFailureReceiptDigest,
        failureReceipt.receiptDigest
    )
    assert.equal(
        next.executionRouteDecision.retryAuthorizationDigest,
        retryAuthorization.authorizationDigest
    )
})
