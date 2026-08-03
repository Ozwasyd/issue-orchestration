#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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
        'tests/tools/issue-orchestration-completed-prerequisite-live.test.mjs'
    ],
    'semantic-graph-patch.test.mjs': [
        'tests/tools/issue-orchestration-semantic-runtime-projection.test.mjs'
    ],
    'runtime-projection.test.mjs': [
        'tests/tools/issue-orchestration-semantic-runtime-writer-projection.test.mjs'
    ],
    'remote-mutation-classification.test.mjs': [
        'tests/tools/issue-orchestration-completed-prerequisite-live.test.mjs'
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
    'profile-capability-matrix.test.mjs': [
        'tests/tools/issue-orchestration-execution-routing.test.mjs',
        'contracts/profile-capability-matrix.schema.json'
    ],
    'implementer-self-test-v2.test.mjs': [
        'tests/tools/issue-orchestration-dispatch-receipt-v2.test.mjs'
    ],
    'stage-model-pool-policy.test.mjs': [
        'tests/tools/issue-orchestration-stage-profiles.test.mjs',
        'policy/model-pool.json'
    ],
    'ui-ux-skill-routing.test.mjs': [
        'tests/tools/issue-orchestration-blog-ui.test.mjs',
        '../FsusBlog/.agents/skills/fsusblog-design-conformance/contracts/blog-ui-stage-policy.json'
    ],
    'ui-system-adjudication.test.mjs': [
        'tests/tools/issue-orchestration-blog-ui.test.mjs',
        '../FsusBlog/.agents/skills/fsusblog-design-conformance/contracts/ui-system-adjudication-receipt.schema.json'
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
            'tests/tools/issue-orchestration-completed-prerequisite-live.test.mjs',
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
            'tests/tools/issue-orchestration-blog-ui.test.mjs',
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
        contract.issue !== 'Ozwasyd/FsusBlog#1824' ||
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
    if (laneFile === 'cross-repo-e2e.test.mjs' ||
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

async function liveIssueSnapshot(repository) {
    const response = await checkedCommand('gh', [
        'api',
        `repos/Ozwasyd/${repository}/issues?state=all&per_page=100`
    ])
    return JSON.parse(response.stdout)
}

async function dependencyStates({
    contract,
    live
}) {
    let liveByTarget = new Map()
    if (live) {
        const [blogIssues, uiIssues] = await Promise.all([
            liveIssueSnapshot('FsusBlog'),
            liveIssueSnapshot('FsusUI')
        ])
        liveByTarget = new Map([
            ...blogIssues.map((issue) => [
                `Ozwasyd/FsusBlog#${issue.number}`,
                issue.state.toUpperCase()
            ]),
            ...uiIssues.map((issue) => [
                `Ozwasyd/FsusUI#${issue.number}`,
                issue.state.toUpperCase()
            ])
        ])
    }
    return contract.dependencies.map((target) => {
        const state = live ? liveByTarget.get(target) : 'CLOSED'
        if (state !== 'CLOSED') {
            fail('permanent-e2e-dependency-open', target)
        }
        return {
            target,
            state,
            evidenceDigest: digest({
                target,
                state,
                source: live ? 'github-live' : 'contract-fixture'
            })
        }
    })
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
                FSUSBLOG_ORCHESTRATION_E2E_RUN_ID: runId,
                FSUSBLOG_ORCHESTRATION_E2E_ROLLOUT_ID:
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
        testSummary
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
    const profile = `${receipt.requestedModel === 'gpt-5.6-terra'
        ? 'terra'
        : receipt.requestedModel === 'gpt-5.6-sol' ? 'sol' : 'forbidden'
    }-${receipt.requestedEffort}`
    if (receipt.selectedProfile !== profile
        || receipt.effectiveModel !== receipt.requestedModel
        || receipt.effectiveEffort !== receipt.requestedEffort
        || !/^(?:terra|sol)-(?:low|medium|high|xhigh|max)$/u.test(
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
                'issue-orchestration.execution-routing-policy.v2'
            && exactRegisteredProfiles(pool)
            && pool.forbiddenProfileCount === 0
            && pool.parallelModelTableCount === 0,
        'permanent-e2e-model-pool-invalid'
    )

    const rootCanary = receipts['root-runtime-canary']
    requireEvidence(
        rootCanary.runtimeKind === 'real-codex-v2-runtime'
            && rootCanary.fiveCwdDiscoveryCount === 5
            && rootCanary.coldStartWriterArtifactObserved === true
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

export async function runPermanentCrossRepoE2E({
    evidenceBundle
} = {}) {
    return reducePermanentE2EEvidence(evidenceBundle)
}

async function main() {
    const bundleIndex = process.argv.indexOf('--evidence-bundle')
    if (bundleIndex < 0 || !process.argv[bundleIndex + 1]) {
        fail('permanent-e2e-evidence-bundle-required')
    }
    const evidenceBundle = JSON.parse(fs.readFileSync(
        path.resolve(process.argv[bundleIndex + 1]),
        'utf8'
    ))
    const receipt = await runPermanentCrossRepoE2E({ evidenceBundle })
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
