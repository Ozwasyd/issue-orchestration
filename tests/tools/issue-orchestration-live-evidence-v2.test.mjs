import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const projectsRoot = path.dirname(root)
const fsusBlogRoot = path.join(projectsRoot, 'FsusBlog')
const fsusUIRoot = path.join(projectsRoot, 'FsusUI')
const packageRoot = path.join(
    root,
    '.'
)
const contract = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/issues-1877-1887-contract.json'
), 'utf8'))
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}
const digest = (value) => createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const importRuntime = (issue) => import(pathToFileURL(path.join(
    packageRoot,
    contract.issues[String(issue)].runtimeOwner
)).href)
const HASH = /^[a-f0-9]{64}$/u
const tempRoots = []
after(() => {
    for (const target of tempRoots) {
        fs.rmSync(target, { recursive: true, force: true })
    }
})

function metadataEvents({
    model = 'gpt-5.6-terra',
    effort = 'low',
    cwd = projectsRoot,
    role = 'root-scheduler'
} = {}) {
    return {
        request: {
            model,
            effort,
            role,
            sandbox: 'read-only',
            cwd,
            multiAgentBackend: 'v2'
        },
        sessionEvents: [{
            type: 'session_meta',
            threadId: 'thread-root-1',
            model,
            cwd,
            sandbox: 'read-only',
            multiAgentBackend: 'v2'
        }],
        turnEvents: [{
            type: 'turn_context',
            threadId: 'thread-root-1',
            effort,
            role,
            cwd,
            sandbox: 'read-only'
        }]
    }
}

test('L84-01 merges real Codex metadata by source authority', async () => {
    const { parseCodexRuntimeMetadata } = await importRuntime(1884)
    const result = parseCodexRuntimeMetadata(metadataEvents())
    assert.equal(result.status, 'verified')
    assert.equal(result.profile, 'terra-low')
    assert.equal(result.model, 'gpt-5.6-terra')
    assert.equal(result.effort, 'low')
    assert.equal(result.multiAgentBackend, 'v2')
    assert.equal(result.role, 'root-scheduler')
    assert.match(result.metadataDigest, HASH)
})

test('L84-02 runtime metadata conflicts and forbidden profiles fail closed', async () => {
    const { parseCodexRuntimeMetadata } = await importRuntime(1884)
    const conflict = metadataEvents()
    conflict.turnEvents[0].cwd = '/wrong'
    assert.throws(
        () => parseCodexRuntimeMetadata(conflict),
        { code: 'codex-runtime-metadata-conflict' }
    )
    for (const [model, effort] of [
        ['gpt-5.6-luna', 'low'],
        ['gpt-5.6-sol', 'ultra'],
        ['gpt-5.6-terra', 'ultra']
    ]) {
        assert.throws(
            () => parseCodexRuntimeMetadata(
                metadataEvents({ model, effort })
            ),
            { code: 'codex-runtime-profile-forbidden' }
        )
    }
})

test('L84-03 a production canary receipt proves the continuous real chain', async () => {
    const { verifyCodexRuntimeCanaryReceipt } = await importRuntime(1884)
    const value = {
        schema: 'issue-orchestration.codex-runtime-canary-receipt.v1',
        status: 'production-verified',
        source: 'real-codex-v2-runtime',
        packageDigest: digest('package'),
        policyDigest: digest('policy-v3'),
        sourceCommit: digest('source').slice(0, 40),
        runId: 'canary-run-1',
        rootReceipt: {
            profile: 'terra-low',
            mechanicalControlOnly: true,
            semanticFilesReadByRoot: [],
            metadataDigest: digest('root-metadata')
        },
        rollouts: [
            ['dag-creator-updater', 'semantic-proposal', 'read-only'],
            ['test-owner', 'test-contract-planning', 'read-only'],
            ['test-owner', 'test-contract', 'workspace-write']
        ].map(([role, phase, sandbox], index) => ({
            runtimeKind: 'codex-agent-rollout',
            role,
            phase,
            sandbox,
            freshContext: true,
            inheritedThreadId: null,
            rolloutId: `rollout-${index}`,
            observableActionCount: 1,
            terminalReceiptDigest: digest(`terminal-${index}`),
            metadataDigest: digest(`metadata-${index}`)
        })),
        cwdDiscovery: [
            projectsRoot,
            root,
            fsusUIRoot,
            path.join(projectsRoot, 'FsusBlog-worktree-fixture'),
            path.join(projectsRoot, 'FsusUI-worktree-fixture')
        ].map((cwd) => ({
            cwd,
            discoveryMethod: 'real-codex-cwd-discovery',
            callerSuppliedInstallRoot: false,
            packageDigest: digest('package'),
            policyDigest: digest('policy-v3')
        })),
        coldStart: {
            fabricatedHistoryCount: 0,
            firstWriterArtifactDigest: digest('artifact'),
            commandEvidenceDigest: digest('command'),
            checkpointDigest: digest('checkpoint'),
            terminalReceiptDigest: digest('writer-terminal')
        },
        cleanup: {
            resourcesBefore: 4,
            resourcesAfter: 0,
            remoteMutationCount: 0,
            receiptDigest: digest('cleanup')
        },
        runtimeTrace: {
            temporarySchedulerCount: 0,
            bootstrapExecutorCount: 0,
            fallbackExecutorCount: 0,
            repoLocalCopyCount: 0,
            traceDigest: digest('trace')
        }
    }
    value.receiptDigest = digest(value)
    assert.equal(
        verifyCodexRuntimeCanaryReceipt(value).status,
        'valid'
    )
    const fake = structuredClone(value)
    fake.rollouts[0].runtimeKind = 'node-child-process'
    assert.throws(
        () => verifyCodexRuntimeCanaryReceipt(fake),
        { code: 'codex-runtime-real-rollout-required' }
    )
})

test('L84-04 live Codex V2 canary runs only under explicit acceptance mode', {
    skip: process.env.FSUSBLOG_CODEX_RUNTIME_CANARY !== '1'
}, async () => {
    const { runCodexRuntimeCanary } = await importRuntime(1884)
    const receipt = await runCodexRuntimeCanary({
        projectsRoot,
        packageRoot,
        fsusBlogRoot,
        fsusUIRoot,
        model: 'gpt-5.6-terra',
        effort: 'low',
        live: true
    })
    assert.equal(receipt.status, 'production-verified')
    assert.equal(receipt.rootReceipt.profile, 'terra-low')
    assert.ok(receipt.rollouts.every(
        ({ runtimeKind }) => runtimeKind === 'codex-agent-rollout'
    ))
    assert.ok(receipt.cwdDiscovery.every(
        ({ callerSuppliedInstallRoot }) =>
            callerSuppliedInstallRoot === false
    ))
    assert.equal(receipt.cleanup.resourcesAfter, 0)
    assert.equal(receipt.cleanup.remoteMutationCount, 0)
})

function stateRoot() {
    const target = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-live-collector-'
    ))
    tempRoots.push(target)
    return target
}

test('L85-01 collector inventories the real machine without reading a clean fixture', async () => {
    const {
        collectQuiescenceObservation,
        freezeQuiescenceBaseline
    } = await importRuntime(1885)
    const runtimeStateRoot = stateRoot()
    const config = {
        runId: 'collector-run-1',
        stateRoot: runtimeStateRoot,
        repositories: [
            {
                name: 'FsusBlog',
                repository: 'Ozwasyd/FsusBlog',
                root,
                defaultBranch: 'master'
            },
            {
                name: 'FsusUI',
                repository: 'Ozwasyd/FsusUI',
                root: fsusUIRoot,
                defaultBranch: 'main'
            }
        ],
        selectorScope: ['Ozwasyd/FsusBlog#1885'],
        allowedRetention: [],
        machineId: os.hostname()
    }
    const baseline = await freezeQuiescenceBaseline(config)
    const before = {
        blogStatus: fs.statSync(path.join(root, '.git')).mtimeMs,
        stateEntries: fs.readdirSync(runtimeStateRoot)
    }
    const observation = await collectQuiescenceObservation({
        ...config,
        baseline
    })
    const after = {
        blogStatus: fs.statSync(path.join(root, '.git')).mtimeMs,
        stateEntries: fs.readdirSync(runtimeStateRoot)
    }
    assert.equal(
        observation.schema,
        'issue-orchestration.quiescence-observation.v1'
    )
    assert.equal(
        observation.collector.schema,
        'issue-orchestration.quiescence-observation-collector.v1'
    )
    assert.equal(observation.collector.staticFixtureUsed, false)
    assert.deepEqual(after, before)
    assert.ok(Object.keys(observation.inventories).length >= 30)
    for (const inventory of Object.values(observation.inventories)) {
        assert.match(inventory.sourceDigest, HASH)
        assert.ok(Array.isArray(inventory.records))
        assert.equal(typeof inventory.collectionMethod, 'string')
        assert.equal(typeof inventory.collectedAt, 'string')
        assert.equal(inventory.machineId, os.hostname())
    }
})

test('L85-02 summaries are recomputed and incomplete collection fails closed', async () => {
    const {
        collectQuiescenceObservation,
        verifyCollectedObservation
    } = await importRuntime(1885)
    const runtimeStateRoot = stateRoot()
    const observation = await collectQuiescenceObservation({
        runId: 'collector-run-2',
        stateRoot: runtimeStateRoot,
        repositories: [{
            name: 'FsusBlog',
            repository: 'Ozwasyd/FsusBlog',
            root,
            defaultBranch: 'master'
        }],
        selectorScope: [],
        baseline: {
            schema: 'issue-orchestration.quiescence-baseline.v1',
            runId: 'collector-run-2',
            resourceDigest: digest([]),
            frozenAt: new Date().toISOString(),
            baselineDigest: digest('baseline')
        },
        allowedRetention: [],
        machineId: os.hostname()
    })
    const tampered = structuredClone(observation)
    tampered.inventories.processes.summary.activeCount = 0
    tampered.inventories.processes.records.push({
        active: true,
        processId: 999999
    })
    assert.throws(
        () => verifyCollectedObservation(tampered),
        { code: 'collector-summary-not-recomputable' }
    )
    const unobservable = structuredClone(observation)
    unobservable.inventories.docker.observable = false
    assert.throws(
        () => verifyCollectedObservation(unobservable),
        { code: 'collector-inventory-unobservable' }
    )
})

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

function childReceipt(key, mode = 'live') {
    const common = {
        schema: `issue-orchestration.e2e-${key}-receipt.v1`,
        evidenceKey: key,
        status: 'verified',
        mode,
        packageDigest: digest('package'),
        policyDigest: digest('policy-v3'),
        sourceCommit: digest('source').slice(0, 40),
        runFamily: 'run-family-1',
        candidateDigest: digest('candidate'),
        selectedProfile: key === 'root-runtime-canary' ||
            key === 'root-mechanical-control'
            ? 'terra-low'
            : 'terra-medium',
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: key === 'root-runtime-canary' ||
            key === 'root-mechanical-control'
            ? 'low'
            : 'medium',
        effectiveEffort: key === 'root-runtime-canary' ||
            key === 'root-mechanical-control'
            ? 'low'
            : 'medium',
        multiAgentBackend: 'v2',
        executedCommand: `verify:${key}`,
        rolloutId: `rollout:${key}`,
        observedResult: 'passed'
    }
    if (key === 'mutation-execution-summary') {
        common.mutations = contract.issues['1886'].negativeControls.map(
            (id) => ({
                mutationId: id,
                injectedInputDigest: digest(`input:${id}`),
                expectedRejectionCode: `reject:${id}`,
                actualRejectionCode: `reject:${id}`,
                commandExitCode: 1,
                restorationDigest: digest(`restore:${id}`)
            })
        )
    }
    if (key === 'model-pool-consistency') {
        common.policySchema =
            'issue-orchestration.stage-model-pool-policy.v3'
        common.policyVersion = 'stage-model-pool.v3'
        common.routingSchema =
            'issue-orchestration.execution-routing-policy.v2'
        common.registeredProfiles = [
            'terra-low',
            'terra-medium',
            'terra-high',
            'terra-xhigh',
            'terra-max',
            'sol-low',
            'sol-medium',
            'sol-high',
            'sol-xhigh',
            'sol-max'
        ]
        common.forbiddenProfileCount = 0
        common.parallelModelTableCount = 0
    }
    if (key === 'root-runtime-canary') {
        common.runtimeKind = 'real-codex-v2-runtime'
        common.fiveCwdDiscoveryCount = 5
        common.coldStartWriterArtifactObserved = true
        common.runtimeCanaryReceiptDigest = digest('runtime-canary')
    }
    if (key === 'live-quiescence') {
        common.observationSource =
            'issue-orchestration.quiescence-observation-collector.v1'
        common.violations = []
        common.observationFresh = true
    }
    if (key === 'no-temporary-scheduler-trace') {
        common.temporaryBootstrapCount = 0
        common.temporarySchedulerCount = 0
        common.residentDaemonCount = 0
        common.fallbackExecutorCount = 0
        common.repoLocalCopyCount = 0
    }
    if (key === 'root-mechanical-control') {
        common.semanticWorkPerformedByRoot = false
        common.ownerDecisionCount = 0
        common.acceptanceEditCount = 0
        common.sliceProposalCount = 0
        common.implementationWriteCount = 0
    }
    if (key === 'dag-startup-gate') {
        common.memberScopedGateVerified = true
    }
    if (key === 'first-writer-cold-start') {
        common.acceptanceBeforePlanning = true
        common.planningBeforeLease = true
        common.leaseBeforeFrozenContract = true
        common.frozenContractBeforeWriter = true
        common.distinctPlanningAndWriterRollouts = true
        common.fabricatedHistoryCount = 0
    }
    if (key === 'scope-frontier-routing-consistency') {
        common.routingCompilerOnly = true
    }
    if (key === 'acceptance-slice-authority') {
        common.acceptanceExact = true
        common.rootAuthoredRequirementCount = 0
        common.rootAuthoredSliceCount = 0
        common.validatorMutatedProposal = false
    }
    if (key === 'output-missing-retry') {
        common.transientSameContractRetryCount = 1
        common.secondEmptyRolloutTerminal = true
        common.materialRetryBoundaryVerified = true
    }
    if (key === 'writer-runtime-watchdog') {
        common.onlineBeforeSpawn = true
        common.firstActionObserved = true
        common.firstArtifactObserved = true
        common.failClosed = true
    }
    if (key === 'verifier-revalidation') {
        common.oldReceiptInvalidated = true
        common.freshCandidateBVerifier = true
        common.inheritedContext = false
        common.impactPlanVerified = true
    }
    if (key === 'git-landing-delivery') {
        common.realLandingVerified = true
    }
    if (key === 'human-decision-gate') {
        common.humanGateVerified = true
    }
    if (key === 'acceptance-group-atomicity') {
        common.acceptanceGroupAtomicityVerified = true
    }
    if (key === 'ui-dual-skill') {
        common.uiDualSkillVerified = true
    }
    common.receiptDigest = digest(common)
    return common
}

function evidenceBundle(mode = 'live') {
    return {
        mode,
        receipts: Object.fromEntries(evidenceKeys.map((key) => [
            key,
            childReceipt(key, mode)
        ])),
        expectedBindings: {
            packageDigest: digest('package'),
            policyDigest: digest('policy-v3'),
            sourceCommit: digest('source').slice(0, 40),
            runFamily: 'run-family-1',
            candidateDigest: digest('candidate')
        }
    }
}

test('L86-01 final E2E derives every claim from bound child receipts', async () => {
    const {
        reducePermanentE2EEvidence,
        verifyPermanentE2EReceipt
    } = await importRuntime(1886)
    const receipt = reducePermanentE2EEvidence(evidenceBundle())
    assert.equal(receipt.status, 'production-verified')
    assert.deepEqual(
        Object.keys(receipt.evidenceRefs).sort(),
        evidenceKeys.sort()
    )
    assert.equal(receipt.fiveCwdDiscoveryVerified, true)
    assert.equal(receipt.testContractLivenessVerified, true)
    assert.equal(receipt.outputMissingRecoveryVerified, true)
    assert.equal(receipt.onlineWatchdogVerified, true)
    assert.equal(receipt.temporaryBootstrapUsed, false)
    assert.equal(receipt.temporarySchedulerUsed, false)
    assert.deepEqual(receipt.quiescenceViolations, [])
    assert.equal(
        receipt.mutationControlsKilled,
        contract.issues['1886'].negativeControls.length
    )
    assert.equal(
        verifyPermanentE2EReceipt(receipt).status,
        'valid'
    )
})

test('L86-02 fixture mode cannot sign production readiness', async () => {
    const { reducePermanentE2EEvidence } = await importRuntime(1886)
    const receipt = reducePermanentE2EEvidence(
        evidenceBundle('fixture')
    )
    assert.equal(receipt.status, 'fixture-verified')
    assert.equal(receipt.productionReady, false)
})

test('L86-03 missing, stale, synthetic or unevaluated evidence fails closed', async () => {
    const { reducePermanentE2EEvidence } = await importRuntime(1886)
    const mutations = [
        (v) => { delete v.receipts['writer-runtime-watchdog'] },
        (v) => {
            v.receipts['root-runtime-canary'].policyDigest =
                digest('old-policy')
        },
        (v) => {
            v.receipts['root-runtime-canary'].selectedProfile =
                'terra-medium'
        },
        (v) => {
            v.receipts['live-quiescence'].observationSource =
                'static-quiescent-fixture'
        },
        (v) => {
            v.receipts['mutation-execution-summary'].mutations[0]
                .actualRejectionCode = 'accepted'
        },
        (v) => {
            v.receipts['no-temporary-scheduler-trace']
                .temporarySchedulerCount = 1
        },
        (v) => {
            v.receipts['git-landing-delivery'].status = 'not-executed'
        }
    ]
    for (const mutate of mutations) {
        const value = evidenceBundle()
        mutate(value)
        assert.throws(() => reducePermanentE2EEvidence(value))
    }
})
