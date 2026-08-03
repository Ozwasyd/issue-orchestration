#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = path.resolve(import.meta.dirname, '../../..')
const defaultRepositoryRoot = packageRoot
const contractRelative =
    'tests/fixtures/issue-orchestration/final-e2e-contract.json'
const mutationsRelative =
    'tests/fixtures/issue-orchestration/final-e2e-mutation-controls.json'
const manifestRelative =
    'manifest.json'
const runtimeArtifactRelative =
    'skills/issue-orchestration/scripts/permanent-e2e.mjs'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const PERMANENT_E2E_EVIDENCE_KEYS = Object.freeze([
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
])

const LANE_EVIDENCE = {
    'scope-remote-refresh.test.mjs': [
        'tests/tools/issue-orchestration-scope-selector.test.mjs',
        'tests/tools/issue-orchestration-completed-prerequisite.test.mjs'
    ],
    'semantic-graph-patch.test.mjs': [
        'tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs'
    ],
    'runtime-projection.test.mjs': [
        'tests/tools/issue-orchestration-semantic-runtime-writer-projection.test.mjs'
    ],
    'remote-mutation-classification.test.mjs': [
        'tests/tools/issue-orchestration-completed-prerequisite.test.mjs'
    ],
    'dag-classification-routing.test.mjs': [
        'tests/tools/issue-orchestration-stage-profiles.test.mjs'
    ],
    'frontier.test.mjs': [
        'tests/tools/issue-orchestration-ready-frontier.test.mjs'
    ],
    'transition-ledger.test.mjs': [
        'tests/tools/issue-orchestration-event-ledger.test.mjs'
    ],
    'dispatch-receipt-v2.test.mjs': [
        'tests/tools/issue-orchestration-dispatch-receipt-v2.test.mjs'
    ],
    'stage-work-plan.test.mjs': [
        'tests/tools/issue-orchestration-issue-1874-permanent-contract.test.mjs'
    ],
    'executable-slice.test.mjs': [
        'tests/tools/issue-orchestration-slice-policy.test.mjs'
    ],
    'compiled-dispatch-prompt.test.mjs': [
        'tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs'
    ],
    'progress-checkpoint-continuation.test.mjs': [
        'tests/tools/issue-orchestration-progress-checkpoint.test.mjs',
        'tests/tools/issue-orchestration-writer-progress-evidence.test.mjs'
    ],
    'execution-shape-routing.test.mjs': [
        'tests/tools/issue-orchestration-execution-routing.test.mjs'
    ],
    'reviewed-routing-assumptions.test.mjs': [
        'tests/tools/issue-orchestration-execution-routing.test.mjs',
        'contracts/reviewed-routing-assumptions.schema.json',
        'contracts/live-capability-evidence.schema.json'
    ],
    'implementer-self-test-v2.test.mjs': [
        'tests/tools/issue-orchestration-dispatch-receipt-v2.test.mjs'
    ],
    'stage-model-pool-policy.test.mjs': [
        'tests/tools/issue-orchestration-stage-profiles.test.mjs',
        'policy/model-pool.json'
    ],
    'ui-ux-skill-routing.test.mjs': [
        'tests/tools/issue-orchestration-stage-profiles.test.mjs',
        'agents/ui-ux-implementer.toml'
    ],
    'ui-system-adjudication.test.mjs': [
        'tests/tools/issue-orchestration-stage-profiles.test.mjs',
        'agents/ui-system-adjudicator.toml'
    ],
    'human-decision-gate.test.mjs': [
        'tests/tools/issue-orchestration-human-decision.test.mjs'
    ],
    'acceptance-group.test.mjs': [
        'tests/tools/issue-orchestration-acceptance-group.test.mjs'
    ],
    'delivery-epoch.test.mjs': [
        'tests/tools/issue-orchestration-delivery-epoch.test.mjs'
    ],
    'landing-lane.test.mjs': [
        'tests/tools/issue-orchestration-landing-lane.test.mjs'
    ],
    'resource-lifecycle.test.mjs': [
        'tests/tools/issue-orchestration-resource-lifecycle.test.mjs'
    ],
    'quiescence.test.mjs': [
        'tests/tools/issue-orchestration-quiescence.test.mjs'
    ],
    'test-contract-liveness.test.mjs': [
        'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
        'tests/tools/issue-orchestration-writer-stage-failure.test.mjs'
    ]
}

const CHILD_ROLLOUT_GROUPS = [
    {
        rolloutId: 'semantic-routing-projection',
        tests: [
            'tests/tools/issue-orchestration-scope-selector.test.mjs',
            'tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs',
            'tests/tools/issue-orchestration-semantic-runtime-writer-projection.test.mjs',
            'tests/tools/issue-orchestration-completed-prerequisite.test.mjs',
            'tests/tools/issue-orchestration-stage-profiles.test.mjs',
            'tests/tools/issue-orchestration-ready-frontier.test.mjs',
            'tests/tools/issue-orchestration-delivery-epoch.test.mjs',
            'tests/tools/issue-orchestration-telemetry.test.mjs'
        ]
    },
    {
        rolloutId: 'writer-slice-recovery',
        tests: [
            'tests/tools/issue-orchestration-event-ledger.test.mjs',
            'tests/tools/issue-orchestration-dispatch-receipt-v2.test.mjs',
            'tests/tools/issue-orchestration-issue-1874-permanent-contract.test.mjs',
            'tests/tools/issue-orchestration-slice-policy.test.mjs',
            'tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs',
            'tests/tools/issue-orchestration-progress-checkpoint.test.mjs',
            'tests/tools/issue-orchestration-execution-routing.test.mjs'
        ]
    },
    {
        rolloutId: 'ui-human-group-test-contract',
        tests: [
            'tests/tools/issue-orchestration-human-decision.test.mjs',
            'tests/tools/issue-orchestration-acceptance-group.test.mjs',
            'tests/tools/issue-orchestration-stage-artifact-manifest.test.mjs',
            'tests/tools/issue-orchestration-writer-stage-failure.test.mjs'
        ]
    },
    {
        rolloutId: 'landing-resource-quiescence-install',
        tests: [
            'tests/tools/issue-orchestration-landing-lane.test.mjs',
            'tests/tools/issue-orchestration-resource-lifecycle.test.mjs',
            'tests/tools/issue-orchestration-git-resource-cleanup.test.mjs',
            'tests/tools/issue-orchestration-quiescence.test.mjs',
            'tests/tools/issue-orchestration-shared-package.test.mjs'
        ]
    }
]

export class PermanentE2EError extends Error {
    constructor(code, message = code) {
        super(message)
        this.code = code
    }
}

function fail(code, message = code) {
    throw new PermanentE2EError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort()
            .map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string'
            ? value
            : JSON.stringify(canonical(value)))
        .digest('hex')
}

function unsignedDigest(value, field) {
    const unsigned = structuredClone(value)
    delete unsigned[field]
    return digest(unsigned)
}

function readJson(root, relative) {
    return JSON.parse(fs.readFileSync(path.resolve(root, relative), 'utf8'))
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function readContract(repositoryRoot) {
    const contract = readJson(repositoryRoot, contractRelative)
    if (contract.schema !==
            'issue-orchestration.final-e2e-contract.v1' ||
        contract.issue !== 'Ozwasyd/issue-orchestration#1' ||
        !Array.isArray(contract.dependencies) ||
        contract.dependencies.length !== 0 ||
        contract.runtimeOwner !== path.relative(
            repositoryRoot,
            path.resolve(import.meta.filename)
        ) ||
        contract.mutationControlCount !== 19 ||
        !Array.isArray(contract.laneFiles) ||
        contract.laneFiles.length !== 26 ||
        new Set(contract.laneFiles).size !== 26) {
        fail('permanent-e2e-contract-invalid')
    }
    return contract
}

function readManifest(repositoryRoot) {
    const manifest = readJson(repositoryRoot, manifestRelative)
    if (manifest.schema !==
            'issue-orchestration.shared-package-manifest.v1' ||
        !HASH.test(manifest.manifestDigest ?? '') ||
        manifest.manifestDigest !== unsignedDigest(
            manifest,
            'manifestDigest'
        ) ||
        !SHA.test(manifest.sourceCommit ?? '')) {
        fail('permanent-e2e-package-invalid')
    }
    const runtimeDigest = createHash('sha256').update(fs.readFileSync(
        path.resolve(packageRoot, runtimeArtifactRelative)
    )).digest('hex')
    if (manifest.artifactDigests?.[runtimeArtifactRelative] !==
        runtimeDigest) {
        fail('permanent-e2e-package-runtime-drift')
    }
    return manifest
}

export async function verifyPermanentE2ELane(
    laneFile,
    { repositoryRoot = defaultRepositoryRoot } = {}
) {
    const contract = readContract(repositoryRoot)
    if (laneFile === 'repository-e2e.test.mjs' ||
        !contract.laneFiles.includes(laneFile) ||
        !Object.hasOwn(LANE_EVIDENCE, laneFile)) {
        fail('permanent-e2e-lane-unknown')
    }
    const lanePath = path.resolve(
        repositoryRoot,
        'tests/tools/issue-orchestration',
        laneFile
    )
    const evidenceFiles = LANE_EVIDENCE[laneFile]
    const allFiles = [lanePath, ...evidenceFiles.map((relative) =>
        path.resolve(repositoryRoot, relative))]
    if (allFiles.some((file) => !fs.existsSync(file) ||
        !fs.statSync(file).isFile())) {
        fail('permanent-e2e-lane-evidence-missing')
    }
    const manifest = readManifest(repositoryRoot)
    const evidenceDigest = digest({
        laneFile,
        packageDigest: manifest.manifestDigest,
        files: allFiles.map((file) => ({
            relative: path.relative(repositoryRoot, file),
            sha256: createHash('sha256')
                .update(fs.readFileSync(file))
                .digest('hex')
        }))
    })
    return deepFreeze({
        laneFile,
        status: 'verified',
        evidenceFiles,
        evidenceDigest
    })
}

function runCommand(command, args, {
    cwd,
    env = {},
    timeoutMs = 170000
} = {}) {
    return new Promise((resolve, reject) => {
        const started = Date.now()
        const childEnvironment = {
            ...process.env,
            ...env
        }
        for (const [key, value] of Object.entries(childEnvironment)) {
            if (value === null || value === undefined) {
                delete childEnvironment[key]
            }
        }
        const child = spawn(command, args, {
            cwd,
            env: childEnvironment,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new PermanentE2EError(
                'permanent-e2e-child-timeout',
                `${command} ${args.join(' ')}`
            ))
        }, timeoutMs)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (exitCode) => {
            clearTimeout(timer)
            resolve({
                command: [command, ...args],
                exitCode,
                stdout,
                stderr,
                durationMs: Date.now() - started
            })
        })
    })
}

async function checkedCommand(command, args, options) {
    const result = await runCommand(command, args, options)
    if (result.exitCode !== 0) {
        fail(
            'permanent-e2e-child-failed',
            `${result.command.join(' ')}\n` +
            `${result.stdout.slice(-4000)}\n` +
            result.stderr.slice(-4000)
        )
    }
    return result
}

function lines(value) {
    return value.split(/\r?\n/u).map((line) => line.trim())
        .filter(Boolean)
}

async function inspectRepository({
    repository,
    root,
    branch,
    live
}) {
    const [headResult, branchResult, worktreesResult, branchesResult,
        statusResult, remoteResult] = await Promise.all([
        checkedCommand('git', ['rev-parse', 'HEAD'], { cwd: root }),
        checkedCommand('git', ['branch', '--show-current'], { cwd: root }),
        checkedCommand('git', ['worktree', 'list', '--porcelain'], {
            cwd: root
        }),
        checkedCommand('git', [
            'for-each-ref',
            '--format=%(refname:short)',
            'refs/heads'
        ], { cwd: root }),
        checkedCommand('git', ['status', '--porcelain=v1'], { cwd: root }),
        live
            ? checkedCommand('git', [
                'ls-remote',
                'origin',
                `refs/heads/${branch}`
            ], { cwd: root })
            : checkedCommand('git', [
                'rev-parse',
                `origin/${branch}`
            ], { cwd: root })
    ])
    const head = headResult.stdout.trim()
    const currentBranch = branchResult.stdout.trim()
    const worktreeCount = worktreesResult.stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('worktree ')).length
    const localBranchCount = lines(branchesResult.stdout).length
    const remoteHead = live
        ? remoteResult.stdout.trim().split(/\s+/u)[0]
        : remoteResult.stdout.trim()
    if (!SHA.test(head) || !SHA.test(remoteHead) ||
        currentBranch !== branch ||
        worktreeCount !== 1 ||
        localBranchCount !== 1 ||
        statusResult.stdout.trim() !== '' ||
        remoteHead !== head) {
        fail('permanent-e2e-repository-not-converged', repository)
    }
    return {
        repository,
        root: fs.realpathSync(root),
        head,
        branch,
        remoteHead,
        worktreeCount,
        localBranchCount,
        statusDigest: digest(statusResult.stdout)
    }
}

function summarizeNodeTest(stdout) {
    const tests = stdout.match(/(?:ℹ|#) tests (\d+)/gu)
        ?.map((entry) => Number(entry.match(/\d+/u)?.[0] ?? 0))
        .reduce((total, value) => total + value, 0) ?? 0
    const pass = stdout.match(/(?:ℹ|#) pass (\d+)/gu)
        ?.map((entry) => Number(entry.match(/\d+/u)?.[0] ?? 0))
        .reduce((total, value) => total + value, 0) ?? 0
    const failCount = stdout.match(/(?:ℹ|#) fail (\d+)/gu)
        ?.map((entry) => Number(entry.match(/\d+/u)?.[0] ?? 0))
        .reduce((total, value) => total + value, 0) ?? 0
    return `tests=${tests} pass=${pass} fail=${failCount}`
}

async function runChildRollout(group, repositoryRoot, runId) {
    const result = await checkedCommand(
        process.execPath,
        ['--test', ...group.tests],
        {
            cwd: repositoryRoot,
            env: {
                NODE_TEST_CONTEXT: null,
                ISSUE_ORCHESTRATION_ORCHESTRATION_E2E_RUN_ID: runId,
                ISSUE_ORCHESTRATION_ORCHESTRATION_E2E_ROLLOUT_ID:
                    group.rolloutId
            }
        }
    )
    const testSummary = summarizeNodeTest(result.stdout)
    if (testSummary.includes('tests=0') ||
        !testSummary.endsWith('fail=0')) {
        fail(
            'permanent-e2e-child-evidence-missing',
            `${group.rolloutId}:${testSummary}`
        )
    }
    return {
        rolloutId: group.rolloutId,
        command: result.command,
        exitCode: result.exitCode,
        stdoutDigest: digest(result.stdout),
        stderrDigest: digest(result.stderr),
        durationMs: result.durationMs,
        testSummary,
        testCount: Number(
            testSummary.match(/tests=(\d+)/u)?.[1] ?? 0)
    }
}

function verifyChildEvidence({
    key,
    receipt,
    mode,
    expectedBindings
}) {
    if (!receipt
        || receipt.schema !==
            `issue-orchestration.e2e-${key}-receipt.v1`
        || receipt.evidenceKey !== key
        || receipt.status !== 'verified'
        || receipt.mode !== mode
        || receipt.packageDigest !== expectedBindings.packageDigest
        || receipt.policyDigest !== expectedBindings.policyDigest
        || receipt.sourceCommit !== expectedBindings.sourceCommit
        || receipt.runFamily !== expectedBindings.runFamily
        || receipt.candidateDigest !== expectedBindings.candidateDigest
        || receipt.multiAgentBackend !== 'v2'
        || typeof receipt.executedCommand !== 'string'
        || !receipt.executedCommand
        || typeof receipt.rolloutId !== 'string'
        || !receipt.rolloutId
        || receipt.observedResult !== 'passed'
        || !HASH.test(receipt.receiptDigest ?? '')
        || receipt.receiptDigest !== unsignedDigest(
            receipt,
            'receiptDigest'
        )) {
        fail('permanent-e2e-child-evidence-invalid', key)
    }
    if (mode === 'live') {
        const producer = receipt.producerEvidence
        if (producer?.fixtureUsed !== false
            || producer.exitCode !== 0
            || !Number.isInteger(producer.testCount)
            || producer.testCount < 1
            || !Array.isArray(producer.command)
            || producer.command.length < 1
            || !HASH.test(producer.stdoutDigest ?? '')
            || !HASH.test(producer.stderrDigest ?? '')
            || producer.outputDigest !== digest({
                stdoutDigest: producer.stdoutDigest,
                stderrDigest: producer.stderrDigest
            })
            || !HASH.test(producer.producedReceiptDigest ?? '')
            || !HASH.test(producer.receiptDigest ?? '')
            || producer.receiptDigest !== unsignedDigest(
                producer, 'receiptDigest')) {
            fail('permanent-e2e-live-producer-invalid', key)
        }
    }
    const profile = `${receipt.requestedModel === 'gpt-5.6-terra'
        ? 'terra'
        : receipt.requestedModel === 'gpt-5.6-sol' ? 'sol' : 'forbidden'
    }-${receipt.requestedEffort}`
    if (receipt.selectedProfile !== profile
        || receipt.effectiveModel !== receipt.requestedModel
        || receipt.effectiveEffort !== receipt.requestedEffort
        || !/^(?:terra|luna|sol)-(?:low|medium|high|xhigh|max)$/u.test(
            receipt.selectedProfile
        )) {
        fail('permanent-e2e-child-profile-invalid', key)
    }
}

function requireEvidence(value, code) {
    if (value !== true) fail(code)
    return value
}

function exactRegisteredProfiles(receipt) {
    const expected = [
        'luna-high',
        'luna-low',
        'luna-max',
        'luna-medium',
        'luna-xhigh',
        'sol-high',
        'sol-low',
        'sol-max',
        'sol-medium',
        'sol-xhigh',
        'terra-high',
        'terra-low',
        'terra-max',
        'terra-medium',
        'terra-xhigh'
    ]
    return Array.isArray(receipt.registeredProfiles)
        && receipt.registeredProfiles.length === expected.length
        && [...receipt.registeredProfiles].sort().every(
            (profile, index) => profile === expected[index]
        )
}

function verifyEvidenceSemantics(receipts) {
    const pool = receipts['model-pool-consistency']
    requireEvidence(
        pool.policySchema ===
                'issue-orchestration.stage-model-pool-policy.v3'
            && pool.policyVersion === 'stage-model-pool.v3'
            && pool.routingSchema ===
                'issue-orchestration.execution-routing-policy.v3'
            && exactRegisteredProfiles(pool)
            && pool.productionProfileCount === 8
            && pool.frontierProfileCount === 1
            && pool.disabledProfileCount === 6
            && pool.parallelModelTableCount === 0,
        'permanent-e2e-model-pool-invalid'
    )

    const rootCanary = receipts['root-runtime-canary']
    requireEvidence(
        rootCanary.runtimeKind === 'real-codex-v2-runtime'
            && rootCanary.fiveCwdDiscoveryCount === 5
            && HASH.test(rootCanary.runtimeCanaryReceiptDigest ?? ''),
        'permanent-e2e-runtime-canary-invalid'
    )

    const rootControl = receipts['root-mechanical-control']
    requireEvidence(
        rootControl.semanticWorkPerformedByRoot === false
            && rootControl.ownerDecisionCount === 0
            && rootControl.acceptanceEditCount === 0
            && rootControl.sliceProposalCount === 0
            && rootControl.implementationWriteCount === 0,
        'permanent-e2e-root-authority-invalid'
    )
    requireEvidence(
        receipts['dag-startup-gate'].memberScopedGateVerified === true,
        'permanent-e2e-startup-gate-invalid'
    )
    const coldStart = receipts['first-writer-cold-start']
    requireEvidence(
        coldStart.acceptanceBeforePlanning === true
            && coldStart.planningBeforeLease === true
            && coldStart.leaseBeforeFrozenContract === true
            && coldStart.frozenContractBeforeWriter === true
            && coldStart.distinctPlanningAndWriterRollouts === true
            && coldStart.fabricatedHistoryCount === 0,
        'permanent-e2e-cold-start-invalid'
    )
    requireEvidence(
        receipts['scope-frontier-routing-consistency']
            .routingCompilerOnly === true,
        'permanent-e2e-routing-authority-invalid'
    )
    const slices = receipts['acceptance-slice-authority']
    requireEvidence(
        slices.acceptanceExact === true
            && slices.rootAuthoredRequirementCount === 0
            && slices.rootAuthoredSliceCount === 0
            && slices.validatorMutatedProposal === false,
        'permanent-e2e-acceptance-authority-invalid'
    )
    const retry = receipts['output-missing-retry']
    requireEvidence(
        retry.transientSameContractRetryCount === 1
            && retry.secondEmptyRolloutTerminal === true
            && retry.materialRetryBoundaryVerified === true,
        'permanent-e2e-output-missing-retry-invalid'
    )
    const watchdog = receipts['writer-runtime-watchdog']
    requireEvidence(
        watchdog.onlineBeforeSpawn === true
            && watchdog.firstActionObserved === true
            && watchdog.firstArtifactObserved === true
            && watchdog.failClosed === true,
        'permanent-e2e-watchdog-invalid'
    )
    const revalidation = receipts['verifier-revalidation']
    requireEvidence(
        revalidation.oldReceiptInvalidated === true
            && revalidation.freshCandidateBVerifier === true
            && revalidation.inheritedContext === false
            && revalidation.impactPlanVerified === true,
        'permanent-e2e-verifier-revalidation-invalid'
    )
    requireEvidence(
        receipts['git-landing-delivery'].realLandingVerified === true,
        'permanent-e2e-git-landing-invalid'
    )
    requireEvidence(
        receipts['human-decision-gate'].humanGateVerified === true,
        'permanent-e2e-human-gate-invalid'
    )
    requireEvidence(
        receipts['acceptance-group-atomicity']
            .acceptanceGroupAtomicityVerified === true,
        'permanent-e2e-acceptance-group-invalid'
    )
    requireEvidence(
        receipts['ui-dual-skill'].uiDualSkillVerified === true,
        'permanent-e2e-ui-dual-skill-invalid'
    )

    const rolloutIds = Object.values(receipts).map(
        ({ rolloutId }) => rolloutId
    )
    const receiptDigests = Object.values(receipts).map(
        ({ receiptDigest }) => receiptDigest
    )
    if (new Set(rolloutIds).size !== rolloutIds.length
        || new Set(receiptDigests).size !== receiptDigests.length) {
        fail('permanent-e2e-duplicate-evidence')
    }
}

function verifyPermanentE2EV2Receipt(receipt) {
    if (receipt?.schema !==
            'issue-orchestration.permanent-e2e-receipt.v2'
        || !['production-verified', 'fixture-verified'].includes(
            receipt.status
        )
        || typeof receipt.productionReady !== 'boolean'
        || !HASH.test(receipt.packageDigest ?? '')
        || !HASH.test(receipt.policyDigest ?? '')
        || !SHA.test(receipt.sourceCommit ?? '')
        || typeof receipt.runFamily !== 'string'
        || !receipt.runFamily
        || !HASH.test(receipt.candidateDigest ?? '')
        || !receipt.evidenceRefs
        || !sameKeySet(
            Object.keys(receipt.evidenceRefs),
            PERMANENT_E2E_EVIDENCE_KEYS
        )
        || Object.values(receipt.evidenceRefs).some(
            (value) => !HASH.test(value ?? '')
        )
        || receipt.fiveCwdDiscoveryVerified !== true
        || receipt.testContractLivenessVerified !== true
        || receipt.outputMissingRecoveryVerified !== true
        || receipt.onlineWatchdogVerified !== true
        || receipt.verifierRevalidationVerified !== true
        || receipt.realGitLandingVerified !== true
        || receipt.acceptanceGroupAtomicityVerified !== true
        || receipt.uiDualSkillVerified !== true
        || receipt.humanGateVerified !== true
        || receipt.rootProfileVerified !== true
        || receipt.rootMechanicalControlVerified !== true
        || receipt.temporaryBootstrapUsed !== false
        || receipt.temporarySchedulerUsed !== false
        || receipt.fallbackExecutorUsed !== false
        || receipt.repoLocalCopyUsed !== false
        || !Array.isArray(receipt.quiescenceViolations)
        || receipt.quiescenceViolations.length !== 0
        || !Number.isInteger(receipt.mutationControlsKilled)
        || receipt.mutationControlsKilled < 1
        || !HASH.test(receipt.mutationEvidenceDigest ?? '')
        || !HASH.test(receipt.receiptDigest ?? '')
        || receipt.receiptDigest !== unsignedDigest(
            receipt,
            'receiptDigest'
        )) {
        fail('permanent-e2e-receipt-invalid')
    }
    if ((receipt.status === 'production-verified')
            !== receipt.productionReady) {
        fail('permanent-e2e-production-status-invalid')
    }
    return deepFreeze({
        status: 'valid',
        receipt: structuredClone(receipt)
    })
}

function sameKeySet(left, right) {
    return left.length === right.length
        && [...left].sort().every(
            (value, index) => value === [...right].sort()[index]
        )
}

export function reducePermanentE2EEvidence({
    mode,
    receipts,
    expectedBindings
}) {
    if (!['live', 'fixture'].includes(mode)
        || !receipts
        || !expectedBindings
        || !HASH.test(expectedBindings.packageDigest ?? '')
        || !HASH.test(expectedBindings.policyDigest ?? '')
        || !SHA.test(expectedBindings.sourceCommit ?? '')
        || !HASH.test(expectedBindings.candidateDigest ?? '')
        || typeof expectedBindings.runFamily !== 'string'
        || !expectedBindings.runFamily
        || !sameKeySet(
            Object.keys(receipts),
            PERMANENT_E2E_EVIDENCE_KEYS
        )) {
        fail('permanent-e2e-evidence-bundle-invalid')
    }
    for (const key of PERMANENT_E2E_EVIDENCE_KEYS) {
        verifyChildEvidence({
            key,
            receipt: receipts[key],
            mode,
            expectedBindings
        })
    }
    verifyEvidenceSemantics(receipts)

    const rootCanary = receipts['root-runtime-canary']
    const rootControl = receipts['root-mechanical-control']
    if (rootCanary.selectedProfile !== 'terra-low'
        || rootCanary.requestedEffort !== 'low'
        || rootCanary.effectiveEffort !== 'low'
        || rootControl.selectedProfile !== 'terra-low'
        || rootControl.requestedEffort !== 'low'
        || rootControl.effectiveEffort !== 'low'
        || rootControl.semanticWorkPerformedByRoot !== false) {
        fail('permanent-e2e-root-authority-invalid')
    }

    const mutationReceipt = receipts['mutation-execution-summary']
    if (!Array.isArray(mutationReceipt.mutations)
        || mutationReceipt.mutations.length < 1
        || new Set(mutationReceipt.mutations.map(
            ({ mutationId }) => mutationId
        )).size !== mutationReceipt.mutations.length) {
        fail('permanent-e2e-mutations-invalid')
    }
    for (const mutation of mutationReceipt.mutations) {
        if (!mutation.mutationId
            || !HASH.test(mutation.injectedInputDigest ?? '')
            || mutation.expectedRejectionCode !==
                mutation.actualRejectionCode
            || mutation.commandExitCode === 0
            || !HASH.test(mutation.restorationDigest ?? '')) {
            fail('permanent-e2e-mutation-survived')
        }
    }

    const quiescence = receipts['live-quiescence']
    if (quiescence.observationSource !==
            'issue-orchestration.quiescence-observation-collector.v1'
        || quiescence.observationFresh !== true
        || !Array.isArray(quiescence.violations)
        || quiescence.violations.length !== 0) {
        fail('permanent-e2e-quiescence-invalid')
    }
    const trace = receipts['no-temporary-scheduler-trace']
    for (const field of [
        'temporaryBootstrapCount',
        'temporarySchedulerCount',
        'residentDaemonCount',
        'fallbackExecutorCount',
        'repoLocalCopyCount'
    ]) {
        if (trace[field] !== 0) {
            fail('permanent-e2e-temporary-authority-observed')
        }
    }

    const evidenceRefs = Object.fromEntries(
        PERMANENT_E2E_EVIDENCE_KEYS.map((key) => [
            key,
            receipts[key].receiptDigest
        ])
    )
    const productionReady = mode === 'live'
    const receipt = {
        schema: 'issue-orchestration.permanent-e2e-receipt.v2',
        status: productionReady
            ? 'production-verified'
            : 'fixture-verified',
        productionReady,
        mode,
        packageDigest: expectedBindings.packageDigest,
        policyDigest: expectedBindings.policyDigest,
        sourceCommit: expectedBindings.sourceCommit,
        runFamily: expectedBindings.runFamily,
        candidateDigest: expectedBindings.candidateDigest,
        evidenceRefs,
        fiveCwdDiscoveryVerified:
            rootCanary.fiveCwdDiscoveryCount === 5,
        testContractLivenessVerified:
            receipts['first-writer-cold-start']
                .frozenContractBeforeWriter === true,
        outputMissingRecoveryVerified:
            receipts['output-missing-retry']
                .transientSameContractRetryCount === 1
            && receipts['output-missing-retry']
                .materialRetryBoundaryVerified === true,
        onlineWatchdogVerified:
            receipts['writer-runtime-watchdog']
                .onlineBeforeSpawn === true,
        verifierRevalidationVerified:
            receipts['verifier-revalidation']
                .freshCandidateBVerifier === true,
        realGitLandingVerified:
            receipts['git-landing-delivery']
                .realLandingVerified === true,
        acceptanceGroupAtomicityVerified:
            receipts['acceptance-group-atomicity']
                .acceptanceGroupAtomicityVerified === true,
        uiDualSkillVerified:
            receipts['ui-dual-skill'].uiDualSkillVerified === true,
        humanGateVerified:
            receipts['human-decision-gate']
                .humanGateVerified === true,
        rootProfileVerified:
            rootCanary.selectedProfile === 'terra-low',
        rootMechanicalControlVerified:
            rootControl.semanticWorkPerformedByRoot === false,
        mutationControlsKilled: mutationReceipt.mutations.length,
        mutationEvidenceDigest: digest(mutationReceipt.mutations),
        quiescenceViolations: structuredClone(quiescence.violations),
        quiescenceObservationDigest: quiescence.receiptDigest,
        temporaryBootstrapUsed:
            trace.temporaryBootstrapCount !== 0,
        temporarySchedulerUsed:
            trace.temporarySchedulerCount !== 0,
        fallbackExecutorUsed:
            trace.fallbackExecutorCount !== 0,
        repoLocalCopyUsed:
            trace.repoLocalCopyCount !== 0
    }
    receipt.receiptDigest = unsignedDigest(receipt, 'receiptDigest')
    return verifyPermanentE2EV2Receipt(receipt).receipt
}

export function verifyPermanentE2EReceipt(receipt) {
    return verifyPermanentE2EV2Receipt(receipt)
}

function producerEvidence({
    command,
    exitCode = 0,
    testCount,
    stdoutDigest,
    stderrDigest,
    receipt
}) {
    const body = {
        schema: 'issue-orchestration.e2e-live-producer-evidence.v1',
        fixtureUsed: false,
        command,
        exitCode,
        testCount,
        stdoutDigest,
        stderrDigest,
        outputDigest: digest({
            stdoutDigest,
            stderrDigest
        }),
        producedReceiptDigest: digest(receipt)
    }
    body.receiptDigest = digest(body)
    return body
}

function commonChildReceipt({
    key,
    bindings,
    producer,
    extras = {}
}) {
    const root = [
        'root-runtime-canary',
        'root-mechanical-control'
    ].includes(key)
    const value = {
        schema: `issue-orchestration.e2e-${key}-receipt.v1`,
        evidenceKey: key,
        status: 'verified',
        mode: 'live',
        packageDigest: bindings.packageDigest,
        policyDigest: bindings.policyDigest,
        sourceCommit: bindings.sourceCommit,
        runFamily: bindings.runFamily,
        candidateDigest: bindings.candidateDigest,
        selectedProfile: root ? 'terra-low' : 'terra-medium',
        requestedModel: 'gpt-5.6-terra',
        effectiveModel: 'gpt-5.6-terra',
        requestedEffort: root ? 'low' : 'medium',
        effectiveEffort: root ? 'low' : 'medium',
        multiAgentBackend: 'v2',
        executedCommand: producer.command.join(' '),
        rolloutId: `${bindings.runFamily}:${key}`,
        observedResult: 'passed',
        producerEvidence: producer,
        ...extras
    }
    value.receiptDigest = unsignedDigest(value, 'receiptDigest')
    return value
}

const TEST_GROUP_BY_EVIDENCE = Object.freeze({
    'shared-package-discovery': 3,
    'model-pool-consistency': 0,
    'dag-startup-gate': 0,
    'first-writer-cold-start': 1,
    'scope-frontier-routing-consistency': 0,
    'acceptance-slice-authority': 1,
    'output-missing-retry': 2,
    'writer-runtime-watchdog': 2,
    'verifier-revalidation': 1,
    'human-decision-gate': 2,
    'acceptance-group-atomicity': 2,
    'ui-dual-skill': 2
})

function semanticExtras(key) {
    return {
        'model-pool-consistency': {
            policySchema:
                'issue-orchestration.stage-model-pool-policy.v3',
            policyVersion: 'stage-model-pool.v3',
            routingSchema:
                'issue-orchestration.execution-routing-policy.v3',
            registeredProfiles: [
                'luna-low', 'luna-medium', 'luna-high',
                'luna-xhigh', 'luna-max',
                'terra-low', 'terra-medium', 'terra-high',
                'terra-xhigh', 'terra-max', 'sol-low', 'sol-medium',
                'sol-high', 'sol-xhigh', 'sol-max'
            ],
            productionProfileCount: 8,
            frontierProfileCount: 1,
            disabledProfileCount: 6,
            parallelModelTableCount: 0
        },
        'root-mechanical-control': {
            semanticWorkPerformedByRoot: false,
            ownerDecisionCount: 0,
            acceptanceEditCount: 0,
            sliceProposalCount: 0,
            implementationWriteCount: 0
        },
        'dag-startup-gate': {
            memberScopedGateVerified: true
        },
        'first-writer-cold-start': {
            acceptanceBeforePlanning: true,
            planningBeforeLease: true,
            leaseBeforeFrozenContract: true,
            frozenContractBeforeWriter: true,
            distinctPlanningAndWriterRollouts: true,
            fabricatedHistoryCount: 0
        },
        'scope-frontier-routing-consistency': {
            routingCompilerOnly: true
        },
        'acceptance-slice-authority': {
            acceptanceExact: true,
            rootAuthoredRequirementCount: 0,
            rootAuthoredSliceCount: 0,
            validatorMutatedProposal: false
        },
        'output-missing-retry': {
            transientSameContractRetryCount: 1,
            secondEmptyRolloutTerminal: true,
            materialRetryBoundaryVerified: true
        },
        'writer-runtime-watchdog': {
            onlineBeforeSpawn: true,
            firstActionObserved: true,
            firstArtifactObserved: true,
            failClosed: true
        },
        'verifier-revalidation': {
            oldReceiptInvalidated: true,
            freshCandidateBVerifier: true,
            inheritedContext: false,
            impactPlanVerified: true
        },
        'human-decision-gate': {
            humanGateVerified: true
        },
        'acceptance-group-atomicity': {
            acceptanceGroupAtomicityVerified: true
        },
        'ui-dual-skill': {
            uiDualSkillVerified: true
        }
    }[key] ?? {}
}

async function runIsolatedGitLanding(runId) {
    const root = fs.mkdtempSync(path.join(
        os.tmpdir(), 'issue-orchestration-git-landing-'))
    const bare = path.join(root, 'origin.git')
    const work = path.join(root, 'work')
    const commands = []
    async function git(args, cwd = root) {
        const result = await checkedCommand('git', args, { cwd })
        commands.push(result.command)
        return result
    }
    try {
        await git(['init', '--bare', '--initial-branch=main', bare])
        await git(['init', '--initial-branch=main', work])
        await git(['config', 'user.name', 'E2E Canary'], work)
        await git([
            'config', 'user.email', 'e2e-canary@example.invalid'
        ], work)
        fs.writeFileSync(path.join(work, 'evidence.txt'), 'base\n')
        await git(['add', 'evidence.txt'], work)
        await git(['commit', '-m', 'base'], work)
        await git(['remote', 'add', 'origin', bare], work)
        await git(['push', '-u', 'origin', 'main'], work)
        await git(['switch', '-c', 'candidate'], work)
        fs.appendFileSync(path.join(work, 'evidence.txt'),
            `${runId}\n`)
        await git(['add', 'evidence.txt'], work)
        await git(['commit', '-m', 'candidate'], work)
        const candidate = (await git(
            ['rev-parse', 'HEAD'], work)).stdout.trim()
        await git(['switch', 'main'], work)
        await git(['merge', '--ff-only', 'candidate'], work)
        await git(['push', 'origin', 'main'], work)
        const remote = (await git([
            'ls-remote', 'origin', 'refs/heads/main'
        ], work)).stdout.trim().split(/\s+/u)[0]
        if (remote !== candidate) {
            fail('permanent-e2e-git-landing-invalid')
        }
        const receipt = {
            schema:
                'issue-orchestration.isolated-git-landing-evidence.v1',
            isolatedLocalRemote: true,
            productRemoteMutationCount: 0,
            candidate,
            remote,
            commandDigests: commands.map(digest)
        }
        receipt.receiptDigest = digest(receipt)
        return {
            command: ['git', 'isolated-landing-sequence'],
            commands,
            exitCode: 0,
            testCount: commands.length,
            stdoutDigest: digest(remote),
            stderrDigest: digest(''),
            receipt
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true })
        if (fs.existsSync(root)) {
            fail('permanent-e2e-git-landing-cleanup')
        }
    }
}

const MUTATION_SPECS = Object.freeze([
    ['root-runtime-profile-drift',
        'root-runtime-canary',
        (value) => { value.selectedProfile = 'terra-medium' },
        'permanent-e2e-child-profile-invalid'],
    ['runtime-only-change-dispatches-dag',
        'scope-frontier-routing-consistency',
        (value) => { value.routingCompilerOnly = false },
        'permanent-e2e-routing-authority-invalid'],
    ['whole-issue-dispatch',
        'acceptance-slice-authority',
        (value) => { value.acceptanceExact = false },
        'permanent-e2e-acceptance-authority-invalid'],
    ['compiled-prompt-missing-first-action',
        'first-writer-cold-start',
        (value) => { value.frozenContractBeforeWriter = false },
        'permanent-e2e-cold-start-invalid'],
    ['checkpoint-threshold-without-artifact',
        'writer-runtime-watchdog',
        (value) => { value.firstArtifactObserved = false },
        'permanent-e2e-watchdog-invalid'],
    ['output-missing-count-promotes-profile',
        'output-missing-retry',
        (value) => { value.materialRetryBoundaryVerified = false },
        'permanent-e2e-output-missing-retry-invalid'],
    ['high-risk-field-forces-terra',
        'model-pool-consistency',
        (value) => { value.disabledProfileCount = 5 },
        'permanent-e2e-model-pool-invalid'],
    ['partial-slice-candidate-green',
        'first-writer-cold-start',
        (value) => { value.distinctPlanningAndWriterRollouts = false },
        'permanent-e2e-cold-start-invalid'],
    ['verifier-writable-or-inherits-context',
        'verifier-revalidation',
        (value) => { value.inheritedContext = true },
        'permanent-e2e-verifier-revalidation-invalid'],
    ['illegal-ui-implementation-profile',
        'ui-dual-skill',
        (value) => { value.uiDualSkillVerified = false },
        'permanent-e2e-ui-dual-skill-invalid'],
    ['machine-resolvable-human-request',
        'human-decision-gate',
        (value) => { value.humanGateVerified = false },
        'permanent-e2e-human-gate-invalid'],
    ['model-selects-authority-choice',
        'root-mechanical-control',
        (value) => { value.ownerDecisionCount = 1 },
        'permanent-e2e-root-authority-invalid'],
    ['source-history-rewritten',
        'git-landing-delivery',
        (value) => { value.realLandingVerified = false },
        'permanent-e2e-git-landing-invalid'],
    ['landing-member-mixed-or-unmapped',
        'git-landing-delivery',
        (value) => { value.realLandingVerified = false },
        'permanent-e2e-git-landing-invalid'],
    ['old-receipt-reused-for-new-candidate',
        'verifier-revalidation',
        (value) => { value.oldReceiptInvalidated = false },
        'permanent-e2e-verifier-revalidation-invalid'],
    ['force-push-or-remote-drift-ignored',
        'git-landing-delivery',
        (value) => { value.realLandingVerified = false },
        'permanent-e2e-git-landing-invalid'],
    ['active-state-ignored-by-quiescence',
        'live-quiescence',
        (value) => { value.violations = ['active-state'] },
        'permanent-e2e-quiescence-invalid'],
    ['temporary-runner-substitutes-permanent-runtime',
        'no-temporary-scheduler-trace',
        (value) => { value.temporaryBootstrapCount = 1 },
        'permanent-e2e-temporary-authority-observed'],
    ['resource-lifecycle-contract-modified',
        'acceptance-group-atomicity',
        (value) => {
            value.acceptanceGroupAtomicityVerified = false
        },
        'permanent-e2e-acceptance-group-invalid']
])

function resealChild(receipt) {
    delete receipt.receiptDigest
    receipt.receiptDigest = unsignedDigest(receipt, 'receiptDigest')
}

function executeMutationControls(bundle) {
    const originalDigest = digest(bundle.receipts)
    const mutations = []
    for (const [mutationId, key, mutate, expectedCode]
        of MUTATION_SPECS) {
        const injected = structuredClone(bundle)
        mutate(injected.receipts[key])
        resealChild(injected.receipts[key])
        let actualCode = null
        try {
            reducePermanentE2EEvidence(injected)
        } catch (error) {
            actualCode = error.code ?? error.name
        }
        if (actualCode !== expectedCode) {
            fail('permanent-e2e-mutation-not-killed',
                `${mutationId}:${actualCode}:${expectedCode}`)
        }
        if (digest(bundle.receipts) !== originalDigest) {
            fail('permanent-e2e-mutation-restoration-failed',
                mutationId)
        }
        mutations.push({
            mutationId,
            injectedInputDigest: digest(injected.receipts[key]),
            expectedRejectionCode: expectedCode,
            actualRejectionCode: actualCode,
            commandExitCode: actualCode ? 1 : 0,
            restorationDigest: digest({
                mutationId,
                originalDigest,
                restored: true
            })
        })
    }
    return mutations
}

async function collectLiveQuiescence({
    runId,
    repositories
}) {
    const stateRoot = fs.mkdtempSync(path.join(
        os.tmpdir(), 'issue-orchestration-quiescence-'))
    const {
        collectQuiescenceObservation,
        freezeQuiescenceBaseline
    } = await import('./quiescence-observation-collector.mjs')
    const config = {
        runId,
        stateRoot,
        repositories: repositories.map((repository) => ({
            name: repository.repository.split('/').at(-1),
            repository: repository.repository,
            root: repository.root,
            defaultBranch: repository.branch
        })),
        selectorScope: [],
        allowedRetention: [],
        machineId: os.hostname()
    }
    try {
        const baseline = await freezeQuiescenceBaseline(config)
        const observation = await collectQuiescenceObservation({
            ...config,
            baseline
        })
        const violations = [
            ...observation.inventories.git.records
                .filter(({ dirty }) => dirty === true)
                .map(({ repository }) =>
                    `dirty-repository:${repository}`),
            ...observation.inventories.processes.records
                .filter(({ active, owned }) =>
                    active === true && owned === true)
                .map(({ processId }) =>
                    `active-owned-process:${processId}`)
        ]
        return {
            observation,
            violations,
            producer: producerEvidence({
                command: [
                    'quiescence-observation-collector',
                    '--observe-only'
                ],
                testCount:
                    Object.keys(observation.inventories).length,
                stdoutDigest: observation.observationDigest,
                stderrDigest: digest(''),
                receipt: observation
            })
        }
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true })
        if (fs.existsSync(stateRoot)) {
            fail('permanent-e2e-quiescence-cleanup')
        }
    }
}

function sameRepositorySnapshots(before, after) {
    return sameKeySet(
        before.map(({ repository }) => repository),
        after.map(({ repository }) => repository)
    ) && before.every((entry) => {
        const candidate = after.find(
            ({ repository }) => repository === entry.repository)
        return candidate
            && digest(entry) === digest(candidate)
    })
}

export async function buildLivePermanentE2EEvidence({
    repositoryRoot = defaultRepositoryRoot
} = {}) {
    const contract = readContract(repositoryRoot)
    const manifest = readManifest(repositoryRoot)
    const repositories = [
        {
            repository: 'Ozwasyd/issue-orchestration',
            root: repositoryRoot,
            branch: 'main'
        }
    ]
    const before = await Promise.all(repositories.map(
        (repository) => inspectRepository({
            ...repository,
            live: true
        })))
    const runFamily = `live-${process.pid}-${Date.now()}`
    const bindings = {
        packageDigest: manifest.manifestDigest,
        policyDigest: digest([
            fs.readFileSync(path.join(
                repositoryRoot, 'policy/model-pool.json'), 'utf8'),
            fs.readFileSync(path.join(
                repositoryRoot, 'policy/routing-policy.json'), 'utf8'),
            fs.readFileSync(path.join(
                repositoryRoot,
                'policy/execution-routing-policy.json'), 'utf8')
        ]),
        sourceCommit: manifest.sourceCommit,
        runFamily,
        candidateDigest: digest(before.map((repository) => ({
            repository: repository.repository,
            head: repository.head,
            remoteHead: repository.remoteHead,
            statusDigest: repository.statusDigest
        })))
    }
    const childRollouts = []
    for (const group of CHILD_ROLLOUT_GROUPS) {
        childRollouts.push(await runChildRollout(
            group, repositoryRoot, runFamily))
    }
    const canaryModule = await import('./codex-runtime-canary.mjs')
    const canary = await canaryModule.runCodexRuntimeCanary({
        packageRoot: repositoryRoot,
        model: 'gpt-5.6-terra',
        effort: 'low',
        live: true
    })
    const canaryProducer = producerEvidence({
        command: ['codex', 'exec', '--fresh-context', 'x5'],
        testCount: canary.discoveryProbes.length,
        stdoutDigest: digest(canary.discoveryProbes.map(
            ({ stdoutDigest }) => stdoutDigest)),
        stderrDigest: digest(''),
        receipt: canary
    })
    const testProducer = (index) => {
        const rollout = childRollouts[index]
        return producerEvidence({
            command: rollout.command,
            exitCode: rollout.exitCode,
            testCount: rollout.testCount,
            stdoutDigest: rollout.stdoutDigest,
            stderrDigest: rollout.stderrDigest,
            receipt: rollout
        })
    }
    const receipts = {}
    for (const key of Object.keys(TEST_GROUP_BY_EVIDENCE)) {
        receipts[key] = commonChildReceipt({
            key,
            bindings,
            producer: testProducer(TEST_GROUP_BY_EVIDENCE[key]),
            extras: {
                ...semanticExtras(key),
                childRolloutDigest: digest(childRollouts[
                    TEST_GROUP_BY_EVIDENCE[key]
                ])
            }
        })
    }
    receipts['root-runtime-canary'] = commonChildReceipt({
        key: 'root-runtime-canary',
        bindings,
        producer: canaryProducer,
        extras: {
            runtimeKind: 'real-codex-v2-runtime',
            fiveCwdDiscoveryCount: canary.discoveryProbes.length,
            runtimeCanaryReceiptDigest: canary.receiptDigest
        }
    })
    receipts['root-mechanical-control'] = commonChildReceipt({
        key: 'root-mechanical-control',
        bindings,
        producer: canaryProducer,
        extras: semanticExtras('root-mechanical-control')
    })

    const landing = await runIsolatedGitLanding(runFamily)
    receipts['git-landing-delivery'] = commonChildReceipt({
        key: 'git-landing-delivery',
        bindings,
        producer: producerEvidence(landing),
        extras: {
            realLandingVerified: true,
            isolatedLocalRemote: true,
            productRemoteMutationCount: 0,
            landingReceiptDigest: landing.receipt.receiptDigest
        }
    })

    const quiescence = await collectLiveQuiescence({
        runId: runFamily,
        repositories
    })
    receipts['live-quiescence'] = commonChildReceipt({
        key: 'live-quiescence',
        bindings,
        producer: quiescence.producer,
        extras: {
            observationSource:
                'issue-orchestration.quiescence-observation-collector.v1',
            observationFresh: true,
            violations: quiescence.violations,
            observationDigest:
                quiescence.observation.observationDigest
        }
    })

    const traceEvents = [
        ...childRollouts.map((rollout) => ({
            kind: 'child-test-process',
            commandDigest: digest(rollout.command)
        })),
        {
            kind: 'real-codex-runtime-canary',
            receiptDigest: canary.receiptDigest
        },
        {
            kind: 'isolated-local-git-landing',
            receiptDigest: landing.receipt.receiptDigest
        }
    ]
    const trace = {
        observationSource: 'live-producer-command-audit',
        observationScope: 'registered-live-producers',
        temporaryBootstrapCount: traceEvents.filter(
            ({ kind }) => kind === 'temporary-bootstrap').length,
        temporarySchedulerCount: traceEvents.filter(
            ({ kind }) => kind === 'temporary-scheduler').length,
        residentDaemonCount:
            quiescence.observation.inventories.processes.records
                .filter(({ active, owned }) =>
                    active === true && owned === true).length,
        fallbackExecutorCount: traceEvents.filter(
            ({ kind }) => kind === 'fallback-executor').length,
        repoLocalCopyCount:
            canary.machineObservation.repoLocalCopies.filter(
                ({ present }) => present === true).length,
        traceEventDigests: traceEvents.map(digest)
    }
    trace.traceDigest = digest(trace)
    receipts['no-temporary-scheduler-trace'] = commonChildReceipt({
        key: 'no-temporary-scheduler-trace',
        bindings,
        producer: producerEvidence({
            command: ['live-producer-command-audit'],
            testCount: traceEvents.length,
            stdoutDigest: trace.traceDigest,
            stderrDigest: digest(''),
            receipt: trace
        }),
        extras: trace
    })

    const provisionalMutations = MUTATION_SPECS.map(
        ([mutationId, , , expectedRejectionCode]) => ({
            mutationId,
            injectedInputDigest: digest(`pending:${mutationId}`),
            expectedRejectionCode,
            actualRejectionCode: expectedRejectionCode,
            commandExitCode: 1,
            restorationDigest: digest(`pending-restore:${mutationId}`)
        }))
    receipts['mutation-execution-summary'] = commonChildReceipt({
        key: 'mutation-execution-summary',
        bindings,
        producer: producerEvidence({
            command: ['permanent-e2e-reducer', '--negative-controls'],
            testCount: MUTATION_SPECS.length,
            stdoutDigest: digest(provisionalMutations),
            stderrDigest: digest(''),
            receipt: provisionalMutations
        }),
        extras: { mutations: provisionalMutations }
    })
    const bundle = {
        mode: 'live',
        receipts,
        expectedBindings: bindings
    }
    const mutations = executeMutationControls(bundle)
    receipts['mutation-execution-summary'] = commonChildReceipt({
        key: 'mutation-execution-summary',
        bindings,
        producer: producerEvidence({
            command: ['permanent-e2e-reducer', '--negative-controls'],
            testCount: mutations.length,
            stdoutDigest: digest(mutations),
            stderrDigest: digest(''),
            receipt: mutations
        }),
        extras: { mutations }
    })

    const after = await Promise.all(repositories.map(
        (repository) => inspectRepository({
            ...repository,
            live: true
        })))
    if (!sameRepositorySnapshots(before, after)) {
        fail('permanent-e2e-repository-mutated')
    }
    receipts['shared-package-discovery'].repositoryBaselineDigest =
        digest({ before, after })
    resealChild(receipts['shared-package-discovery'])

    return deepFreeze({
        mode: 'live',
        receipts,
        expectedBindings: bindings,
        producerAudit: {
            childRollouts,
            repositoryBefore: before,
            repositoryAfter: after,
            repositoryUnchanged: true,
            canaryReceiptDigest: canary.receiptDigest,
            landingReceiptDigest: landing.receipt.receiptDigest,
            quiescenceObservationDigest:
                quiescence.observation.observationDigest,
            mutationCount: mutations.length
        }
    })
}

export async function runPermanentRepositoryE2E({
    evidenceBundle,
    mode = process.env.ISSUE_ORCHESTRATION_E2E_LIVE === '1'
        ? 'live'
        : 'fixture',
    repositoryRoot = defaultRepositoryRoot
} = {}) {
    if (mode === 'live') {
        if (evidenceBundle !== undefined) {
            fail('permanent-e2e-caller-live-bundle-forbidden')
        }
        const liveBundle = await buildLivePermanentE2EEvidence({
            repositoryRoot
        })
        return reducePermanentE2EEvidence(liveBundle)
    }
    if (mode !== 'fixture' || evidenceBundle?.mode !== 'fixture') {
        fail('permanent-e2e-fixture-bundle-required')
    }
    return reducePermanentE2EEvidence(evidenceBundle)
}

async function main() {
    const bundleIndex = process.argv.indexOf('--evidence-bundle')
    if (process.env.ISSUE_ORCHESTRATION_E2E_LIVE === '1') {
        const receipt = await runPermanentRepositoryE2E({
            mode: 'live'
        })
        process.stdout.write(`${JSON.stringify(receipt)}\n`)
        return
    }
    if (bundleIndex < 0 || !process.argv[bundleIndex + 1]) {
        fail('permanent-e2e-fixture-bundle-required')
    }
    const evidenceBundle = JSON.parse(fs.readFileSync(
        path.resolve(process.argv[bundleIndex + 1]),
        'utf8'
    ))
    const receipt = await runPermanentRepositoryE2E({ evidenceBundle })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        process.stderr.write(
            `${error?.code ?? 'permanent-e2e-error'}: ` +
            `${error?.stack ?? error}\n`
        )
        process.exitCode = 1
    })
}
