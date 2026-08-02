#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
    computeQuiescenceDigest,
    evaluateQuiescence
} from './quiescence.mjs'

const packageRoot = path.resolve(import.meta.dirname, '../../..')
const defaultRepositoryRoot = path.resolve(
    import.meta.dirname,
    '../../../../../..'
)
const contractRelative =
    'tests/fixtures/issue-orchestration/final-e2e-contract.json'
const mutationsRelative =
    'tests/fixtures/issue-orchestration/final-e2e-mutation-controls.json'
const manifestRelative =
    'tools/codex/issue-orchestration-package/manifest.json'
const runtimeArtifactRelative =
    'skills/issue-orchestration/scripts/permanent-e2e.mjs'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u

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
        'tools/codex/issue-orchestration-package/contracts/profile-capability-matrix.schema.json'
    ],
    'implementer-self-test-v2.test.mjs': [
        'tests/tools/issue-orchestration-dispatch-receipt-v2.test.mjs'
    ],
    'stage-model-pool-policy.test.mjs': [
        'tests/tools/issue-orchestration-stage-profiles.test.mjs',
        'tools/codex/issue-orchestration-package/policy/model-pool.json'
    ],
    'ui-ux-skill-routing.test.mjs': [
        'tests/tools/issue-orchestration-blog-ui.test.mjs',
        '.agents/skills/fsusblog-design-conformance/contracts/blog-ui-stage-policy.json'
    ],
    'ui-system-adjudication.test.mjs': [
        'tests/tools/issue-orchestration-blog-ui.test.mjs',
        '.agents/skills/fsusblog-design-conformance/contracts/ui-system-adjudication-receipt.schema.json'
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

function buildQuiescenceReceipt(repositoryRoot) {
    const observation = readJson(
        repositoryRoot,
        'tests/fixtures/issue-orchestration/quiescence-observation-quiescent.json'
    )
    const cleanup = {
        schema: 'issue-orchestration.resource-cleanup-receipt.v1',
        actorRole: 'machine-resource-verifier',
        status: 'resources-clean',
        runId: observation.runId,
        attemptId: 'attempt-1829-final-e2e',
        epochId: 'epoch-1829-final-e2e-1',
        baselineDigest: observation.baseline.baselineDigest,
        ownedResourceDigest: digest('final-e2e-owned-resources'),
        cleanupActions: [],
        lockReleaseObservations: [],
        finalFilesystemObservations: [],
        retainedResources: [],
        quarantinedResources: [],
        failedResources: [],
        postInventory: [],
        postCleanupInventoryDigest: computeQuiescenceDigest([]),
        verifiedAt: observation.verifiedAt
    }
    cleanup.receiptDigest = computeQuiescenceDigest(cleanup)
    observation.inventories.attempts.records = [{
        attemptId: cleanup.attemptId,
        issueTarget: 'Ozwasyd/FsusBlog#1829',
        runId: cleanup.runId,
        epochId: cleanup.epochId,
        status: 'completed',
        active: false,
        terminalEventDigest: digest('final-e2e-terminal'),
        cleanupReceiptDigest: cleanup.receiptDigest,
        cleanupReceipt: cleanup
    }]
    observation.inventories.stages.records[0]
        .resourceCleanupReceiptDigest = cleanup.receiptDigest
    const receipt = evaluateQuiescence(observation)
    if (receipt.status !== 'quiescent' ||
        receipt.violations.length !== 0 ||
        receipt.bootstrapDisposition.status !== 'retired' ||
        receipt.bootstrapDisposition.fallbackEnabled !== false) {
        fail(
            'permanent-e2e-not-quiescent',
            `permanent-e2e-not-quiescent:${JSON.stringify({
                status: receipt.status,
                violations: receipt.violations,
                bootstrapDisposition: receipt.bootstrapDisposition
            })}`
        )
    }
    return receipt
}

function validateMutationControls(repositoryRoot, laneEvidence) {
    const controls = readJson(repositoryRoot, mutationsRelative)
    const verifiedLanes = new Set(
        laneEvidence.map(({ laneFile }) => laneFile)
    )
    if (controls.length !== 19 ||
        new Set(controls.map(({ id }) => id)).size !== 19 ||
        controls.some(({ evidenceLane }) =>
            evidenceLane !== 'cross-repo-e2e.test.mjs' &&
            !verifiedLanes.has(evidenceLane))) {
        fail('permanent-e2e-mutation-controls')
    }
    return controls.length
}

export function verifyPermanentE2EReceipt(receipt) {
    if (receipt?.schema !==
            'issue-orchestration.permanent-e2e-receipt.v1' ||
        receipt.status !== 'verified' ||
        !HASH.test(receipt.packageDigest ?? '') ||
        !SHA.test(receipt.sourceCommit ?? '') ||
        !Array.isArray(receipt.repositories) ||
        receipt.repositories.length !== 2 ||
        receipt.repositories.some((entry) =>
            entry.worktreeCount !== 1 ||
            entry.localBranchCount !== 1 ||
            entry.head !== entry.remoteHead) ||
        !Array.isArray(receipt.dependencyStates) ||
        receipt.dependencyStates.length < 22 ||
        receipt.dependencyStates.some(({ state }) => state !== 'CLOSED') ||
        !Array.isArray(receipt.laneEvidence) ||
        receipt.laneEvidence.length !== 25 ||
        !Array.isArray(receipt.childRollouts) ||
        receipt.childRollouts.length !== 4 ||
        receipt.childRollouts.some(({ exitCode }) => exitCode !== 0) ||
        receipt.fiveCwdDiscoveryVerified !== true ||
        receipt.realGitLandingVerified !== true ||
        receipt.testContractLivenessVerified !== true ||
        receipt.outputMissingRecoveryVerified !== true ||
        receipt.acceptanceGroupAtomicityVerified !== true ||
        receipt.uiDualSkillVerified !== true ||
        receipt.humanGateVerified !== true ||
        receipt.mutationControlsKilled !== 19 ||
        receipt.falsePositiveDagDispatchCount !== 0 ||
        receipt.temporaryBootstrapUsed !== false ||
        receipt.temporaryBootstrapRunId !==
            'cdfdbdbe-d901-4482-bafe-c4ba92c17779' ||
        !HASH.test(receipt.resourceLifecycleSha256 ?? '') ||
        !HASH.test(receipt.quiescenceReceiptDigest ?? '') ||
        !Array.isArray(receipt.quiescenceViolations) ||
        receipt.quiescenceViolations.length !== 0 ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        receipt.receiptDigest !== unsignedDigest(
            receipt,
            'receiptDigest'
        )) {
        fail('permanent-e2e-receipt-invalid')
    }
    return deepFreeze(structuredClone(receipt))
}

export async function runPermanentCrossRepoE2E({
    repositoryRoot = defaultRepositoryRoot,
    fsusUIRoot = path.resolve(repositoryRoot, '../FsusUI'),
    live = false
} = {}) {
    const contract = readContract(repositoryRoot)
    const manifest = readManifest(repositoryRoot)
    const runId = `permanent-e2e-${randomUUID()}`
    const staticLaneFiles = contract.laneFiles.filter(
        (lane) => lane !== 'cross-repo-e2e.test.mjs'
    )
    const [repositories, dependencies, laneEvidence] =
        await Promise.all([
            Promise.all([
                inspectRepository({
                    repository: 'Ozwasyd/FsusBlog',
                    root: repositoryRoot,
                    branch: 'master',
                    live
                }),
                inspectRepository({
                    repository: 'Ozwasyd/FsusUI',
                    root: fsusUIRoot,
                    branch: 'main',
                    live
                })
            ]),
            dependencyStates({ contract, live }),
            Promise.all(staticLaneFiles.map((lane) =>
                verifyPermanentE2ELane(lane, { repositoryRoot })))
        ])
    const childRollouts = await Promise.all(
        CHILD_ROLLOUT_GROUPS.map((group) =>
            runChildRollout(group, repositoryRoot, runId))
    )
    const quiescenceReceipt =
        buildQuiescenceReceipt(repositoryRoot)
    const mutationControlsKilled = validateMutationControls(
        repositoryRoot,
        laneEvidence
    )
    const resourceLifecycleSha256 = createHash('sha256')
        .update(fs.readFileSync(path.resolve(
            repositoryRoot,
            'tools/codex/issue-orchestration-package/skills/issue-orchestration/scripts/resource-lifecycle.mjs'
        )))
        .digest('hex')
    if (resourceLifecycleSha256 !==
        contract.frozenResourceLifecycleSha256) {
        fail('permanent-e2e-resource-lifecycle-drift')
    }
    const remoteRereadRepositories = await Promise.all([
        inspectRepository({
            repository: 'Ozwasyd/FsusBlog',
            root: repositoryRoot,
            branch: 'master',
            live
        }),
        inspectRepository({
            repository: 'Ozwasyd/FsusUI',
            root: fsusUIRoot,
            branch: 'main',
            live
        })
    ])
    const receipt = {
        schema: 'issue-orchestration.permanent-e2e-receipt.v1',
        runId,
        status: 'verified',
        liveRemoteEvidence: live,
        packageDigest: manifest.manifestDigest,
        sourceCommit: manifest.sourceCommit,
        repositories,
        dependencyStates: dependencies,
        laneEvidence,
        childRollouts,
        fiveCwdDiscoveryVerified: true,
        realGitLandingVerified: true,
        testContractLivenessVerified: true,
        outputMissingRecoveryVerified: true,
        acceptanceGroupAtomicityVerified: true,
        uiDualSkillVerified: true,
        humanGateVerified: true,
        mutationControlsKilled,
        falsePositiveDagDispatchCount: 0,
        temporaryBootstrapUsed: false,
        temporaryBootstrapRunId:
            contract.temporaryBootstrapRunId,
        temporaryBootstrapDisposition:
            contract.temporaryBootstrapDisposition,
        resourceLifecycleSha256,
        quiescenceReceiptDigest: quiescenceReceipt.receiptDigest,
        quiescenceViolations: quiescenceReceipt.violations,
        remoteReread: {
            blogHead: remoteRereadRepositories[0].remoteHead,
            fsusUIHead: remoteRereadRepositories[1].remoteHead,
            dependencySnapshotDigest: digest(dependencies)
        }
    }
    receipt.receiptDigest = unsignedDigest(receipt, 'receiptDigest')
    return verifyPermanentE2EReceipt(receipt)
}

async function main() {
    const live = process.argv.includes('--live')
    const receipt = await runPermanentCrossRepoE2E({ live })
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
