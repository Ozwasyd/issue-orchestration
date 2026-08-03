import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'

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
            payload: {
                id: 'thread-root-1',
                cwd
            }
        }],
        turnEvents: [{
            type: 'turn_context',
            payload: {
                model,
                effort,
                cwd,
                sandbox_policy: {
                    type: 'read-only'
                },
                multi_agent_version: 'v2'
            }
        }],
        orchestrationLabels: {
            requestedRole: role,
            requestedPhase: 'mechanical-control',
            actionBoundary: 'installed-skill-read'
        }
    }
}

test('L84-01 separates request, labels and runtime observations', async () => {
    const { parseCodexRuntimeMetadata } = await importRuntime(1884)
    const result = parseCodexRuntimeMetadata(metadataEvents())
    assert.equal(result.status, 'verified')
    assert.equal(result.profile, 'terra-low')
    assert.equal(
        result.invocationRequest.model,
        'gpt-5.6-terra'
    )
    assert.equal(
        result.runtimeObservation.model,
        'gpt-5.6-terra'
    )
    assert.equal(
        result.runtimeObservation.effort,
        'low'
    )
    assert.equal(
        result.runtimeObservation.multiAgentBackend,
        'v2'
    )
    assert.equal(
        result.orchestrationLabels.requestedRole,
        'root-scheduler'
    )
    assert.equal(
        Object.hasOwn(result.runtimeObservation, 'role'),
        false
    )
    assert.ok(Object.values(result.comparison).every(Boolean))
    assert.match(result.rawEvidenceDigest, HASH)
    assert.match(result.metadataDigest, HASH)
})

test('L84-02 observed identity never falls back to requests or labels', async () => {
    const { parseCodexRuntimeMetadata } = await importRuntime(1884)
    const missingModel = metadataEvents()
    delete missingModel.turnEvents[0].payload.model
    assert.throws(
        () => parseCodexRuntimeMetadata(missingModel),
        { code: 'codex-runtime-observation-missing' }
    )
    const mismatch = metadataEvents()
    mismatch.turnEvents[0].payload.effort = 'medium'
    assert.throws(
        () => parseCodexRuntimeMetadata(mismatch),
        { code: 'codex-runtime-request-mismatch' }
    )
    const conflictingObserved = metadataEvents()
    conflictingObserved.turnEvents.push(structuredClone(
        conflictingObserved.turnEvents[0]))
    conflictingObserved.turnEvents[1].payload.cwd = '/wrong'
    assert.throws(
        () => parseCodexRuntimeMetadata(conflictingObserved),
        { code: 'codex-runtime-observation-conflict' }
    )
    const forbidden = metadataEvents({ model: 'gpt-5.6-luna' })
    assert.throws(
        () => parseCodexRuntimeMetadata(forbidden),
        { code: 'codex-runtime-profile-forbidden' }
    )
})

function canaryReceipt() {
    const installRootDigest = digest('/isolated/codex/skills')
    const discoveryProbes = Array.from({ length: 5 }, (_, index) => {
        const cwd = path.join('/probe', String(index))
        const rawEvidence = {
            sessionRecordDigests: [digest(`session-${index}`)],
            turnRecordDigests: [digest(`turn-${index}`)]
        }
        const runtimeMetadata = {
            schema:
                'issue-orchestration.codex-runtime-metadata-evidence.v2',
            status: 'verified',
            profile: 'terra-low',
            invocationRequest: {
                model: 'gpt-5.6-terra',
                effort: 'low',
                cwd,
                sandbox: 'danger-full-access',
                multiAgentBackend: 'v2'
            },
            orchestrationLabels: {
                requestedRole: 'package-discovery-probe',
                requestedPhase: 'installed-skill-discovery',
                actionBoundary:
                    'installed-skill-and-canary-marker-read'
            },
            runtimeObservation: {
                model: 'gpt-5.6-terra',
                effort: 'low',
                cwd,
                sandbox: 'danger-full-access',
                multiAgentBackend: 'v2',
                threadId: `thread-${index}`
            },
            comparison: {
                model: true,
                effort: true,
                cwd: true,
                sandbox: true,
                multiAgentBackend: true
            },
            rawEvidence,
            rawEvidenceDigest: digest(rawEvidence)
        }
        runtimeMetadata.metadataDigest = digest(runtimeMetadata)
        const actionObservation = {
            observationScope: 'registered-codex-tool-calls',
            catalogObserved: true,
            skillReadObserved: true,
            markerReadObserved: true,
            markerOutputObserved: true,
            commands: [{
                commandDigest: digest(`command-${index}`)
            }],
            toolCallRecordDigests: [
                digest(`tool-call-${index}`)
            ],
            forbidden: [],
            unobservableClaims: ['outside-tool-calls']
        }
        actionObservation.observationDigest =
            digest(actionObservation)
        const probe = {
            schema:
                'issue-orchestration.codex-skill-discovery-probe.v1',
            discoveryMethod:
                'codex-runtime-catalog-and-tool-read',
            cwd,
            threadId: `thread-${index}`,
            freshContext: true,
            inheritedThreadId: null,
            callerSuppliedPathInPrompt: false,
            installRootDigest,
            packageDigest: digest('package'),
            skillDigest: digest('skill'),
            sourceCommit: digest('source').slice(0, 40),
            runtimeMetadata,
            actionObservation,
            terminalEventDigest: digest(`terminal-${index}`),
            stdoutDigest: digest(`stdout-${index}`)
        }
        probe.probeDigest = digest(probe)
        return probe
    })
    const cleanupBody = {
        observationMethod: 'post-delete-lstat',
        resources: [{
            kind: 'isolated-codex-home',
            pathDigest: digest('/isolated/codex'),
            existsAfterDelete: false
        }],
        resourcesAfter: 0
    }
    const cleanup = {
        ...cleanupBody,
        receiptDigest: digest(cleanupBody)
    }
    const installation = {
        installMethod:
            'isolated-codex-home-standard-skill-path',
        installRootDigest,
        fileBindings: [
            {
                sourceRelative:
                    'skills/issue-orchestration/SKILL.md',
                installedDigest: digest('skill-file')
            },
            {
                sourceRelative:
                    'skills/issue-orchestration/references/'
                    + 'runtime-discovery-canary.md',
                installedDigest: digest('marker-file')
            }
        ],
        manifestDigest: digest('package'),
        sourceTreeDigest: digest('tree')
    }
    installation.installDigest = digest(installation)
    const repoLocalCopies = Array.from(
        { length: 4 },
        (_, index) => ({
            pathDigest: digest(`repo-copy-${index}`),
            present: false
        }))
    const runtimeTrace = {
        observationScope: 'registered-codex-tool-calls',
        mutatingToolCallCount: 0,
        observedCommandDigests: [digest('command')],
        unobservableClaims: ['remote-side-effects']
    }
    runtimeTrace.traceDigest = digest(runtimeTrace)
    const value = {
        schema: 'issue-orchestration.codex-runtime-canary-receipt.v2',
        status: 'production-verified',
        source: 'real-codex-v2-runtime',
        packageDigest: digest('package'),
        sourceTreeDigest: digest('tree'),
        skillDigest: digest('skill'),
        policyDigest: digest('policy-v3'),
        sourceCommit: digest('source').slice(0, 40),
        runId: 'canary-run-1',
        installation,
        discoveryProbes,
        machineObservation: {
            observationMethod: 'post-run-lstat',
            repoLocalCopies,
            observationDigest: digest(repoLocalCopies)
        },
        cleanup,
        runtimeTrace
    }
    value.receiptDigest = digest(value)
    return value
}

test('L84-03 action, cleanup and receipt claims fail closed', async () => {
    const {
        observeCodexActions,
        verifyManifestSourceCommit,
        verifyCleanupObservation,
        verifyCodexRuntimeCanaryReceipt
    } = await importRuntime(1884)
    const installRoot = '/tmp/codex/skills/issue-orchestration'
    const skillFile = `${installRoot}/SKILL.md`
    const markerFile =
        `${installRoot}/references/runtime-discovery-canary.md`
    const records = [
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'developer',
                content: `issue-orchestration ${installRoot}`
            }
        },
        ...[skillFile, markerFile].map((file, index) => ({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name: 'exec',
                call_id: `call-${index}`,
                input: 'const r = await tools.exec_command('
                    + JSON.stringify({ cmd: `sed -n '1,80p' ${file}` })
                    + '); text(r.output);'
            }
        })),
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{
                    type: 'output_text',
                    text: 'ISSUE_ORCHESTRATION_DISCOVERY_OK_V1'
                }]
            }
        }
    ]
    const actions = observeCodexActions({
        records, installRoot, skillFile, markerFile
    })
    assert.equal(actions.skillReadObserved, true)
    const semanticRead = structuredClone(records)
    semanticRead.splice(3, 0, {
        type: 'response_item',
        payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call-semantic',
            input: 'const r = await tools.exec_command('
                + JSON.stringify({
                    cmd: 'sed -n 1,20p /repo/package.json'
                })
                + '); text(r.output);'
        }
    })
    assert.throws(
        () => observeCodexActions({
            records: semanticRead,
            installRoot,
            skillFile,
            markerFile
        }),
        { code: 'codex-runtime-action-forbidden' }
    )
    const value = canaryReceipt()
    assert.equal(
        verifyCodexRuntimeCanaryReceipt(value).status,
        'valid'
    )
    const receiptSchema = JSON.parse(fs.readFileSync(path.join(
        root,
        'contracts/codex-runtime-canary-receipt.schema.json'
    ), 'utf8'))
    assert.deepEqual(
        validateJsonSchema(value, receiptSchema),
        []
    )
    const localCopy = structuredClone(value)
    localCopy.machineObservation.repoLocalCopies[0].present = true
    assert.throws(
        () => verifyCodexRuntimeCanaryReceipt(localCopy),
        { code: 'codex-runtime-repo-local-copy' }
    )
    const cleanupLie = structuredClone(value.cleanup)
    cleanupLie.resources[0].existsAfterDelete = true
    assert.throws(
        () => verifyCleanupObservation(cleanupLie),
        { code: 'codex-runtime-cleanup' }
    )

    const gitRoot = fs.mkdtempSync(path.join(
        os.tmpdir(), 'codex-canary-source-binding-'))
    tempRoots.push(gitRoot)
    fs.mkdirSync(path.join(gitRoot, 'skills'))
    fs.writeFileSync(path.join(gitRoot, 'skills', 'artifact.txt'), 'v1')
    for (const args of [
        ['init', '--initial-branch=main'],
        ['config', 'user.name', 'Canary Test'],
        ['config', 'user.email', 'canary@example.invalid'],
        ['add', 'skills/artifact.txt'],
        ['commit', '-m', 'source']
    ]) {
        assert.equal(spawnSync('git', args, {
            cwd: gitRoot,
            encoding: 'utf8'
        }).status, 0)
    }
    const sourceCommit = spawnSync(
        'git', ['rev-parse', 'HEAD'], {
            cwd: gitRoot,
            encoding: 'utf8'
        }).stdout.trim()
    await verifyManifestSourceCommit(gitRoot, sourceCommit)
    fs.writeFileSync(path.join(
        gitRoot, 'skills', 'artifact.txt'), 'tampered')
    await assert.rejects(
        verifyManifestSourceCommit(gitRoot, sourceCommit),
        { code: 'codex-runtime-source-binding' }
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
    assert.equal(receipt.discoveryProbes.length, 5)
    assert.ok(receipt.discoveryProbes.every(
        ({ runtimeMetadata }) =>
            runtimeMetadata.profile === 'terra-low'
    ))
    assert.ok(receipt.discoveryProbes.every(
        ({ callerSuppliedPathInPrompt }) =>
            callerSuppliedPathInPrompt === false
    ))
    assert.equal(receipt.cleanup.resourcesAfter, 0)
    assert.equal(receipt.runtimeTrace.mutatingToolCallCount, 0)
    const schema = JSON.parse(fs.readFileSync(path.join(
        root,
        'contracts/codex-runtime-canary-receipt.schema.json'
    ), 'utf8'))
    assert.deepEqual(validateJsonSchema(receipt, schema), [])
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
        blogHead: fs.readFileSync(
            path.join(root, '.git', 'HEAD'), 'utf8'),
        stateEntries: fs.readdirSync(runtimeStateRoot)
    }
    const observation = await collectQuiescenceObservation({
        ...config,
        baseline
    })
    const after = {
        blogHead: fs.readFileSync(
            path.join(root, '.git', 'HEAD'), 'utf8'),
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
    if (mode === 'live') {
        const producer = {
            schema:
                'issue-orchestration.e2e-live-producer-evidence.v1',
            fixtureUsed: false,
            command: ['node', '--test', key],
            exitCode: 0,
            testCount: 1,
            stdoutDigest: digest(`stdout:${key}`),
            stderrDigest: digest(''),
            producedReceiptDigest: digest(`produced:${key}`)
        }
        producer.outputDigest = digest({
            stdoutDigest: producer.stdoutDigest,
            stderrDigest: producer.stderrDigest
        })
        producer.receiptDigest = digest(producer)
        common.producerEvidence = producer
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
            'issue-orchestration.execution-routing-policy.v3'
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
