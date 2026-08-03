import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
    assertDigest,
    digest,
    fail,
    seal,
    sameValue
} from './runtime-contract-lib.mjs'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const MODELS = new Map([
    ['gpt-5.6-terra', 'terra'],
    ['gpt-5.6-sol', 'sol']
])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function authoritative(values, code) {
    const present = values.filter((value) =>
        value !== undefined && value !== null && value !== '')
    if (present.length === 0 || present.some(
        (value) => !sameValue(value, present[0])
    )) fail(code)
    return present[0]
}

export function parseCodexRuntimeMetadata({
    request,
    sessionEvents,
    turnEvents
}) {
    const sessions = sessionEvents ?? []
    const turns = turnEvents ?? []
    if (!request || sessions.length < 1 || turns.length < 1) {
        fail('codex-runtime-metadata-missing')
    }
    const model = authoritative([
        request.model,
        ...sessions.map((event) => event.model)
    ], 'codex-runtime-metadata-conflict')
    const effort = authoritative([
        request.effort,
        ...turns.map((event) => event.effort)
    ], 'codex-runtime-metadata-conflict')
    const cwd = authoritative([
        request.cwd,
        ...sessions.map((event) => event.cwd),
        ...turns.map((event) => event.cwd)
    ], 'codex-runtime-metadata-conflict')
    const sandbox = authoritative([
        request.sandbox,
        ...sessions.map((event) => event.sandbox),
        ...turns.map((event) => event.sandbox)
    ], 'codex-runtime-metadata-conflict')
    const multiAgentBackend = authoritative([
        request.multiAgentBackend,
        ...sessions.map((event) => event.multiAgentBackend)
    ], 'codex-runtime-metadata-conflict')
    const role = authoritative([
        request.role,
        ...turns.map((event) => event.role)
    ], 'codex-runtime-metadata-conflict')
    const threadId = authoritative([
        ...sessions.map((event) => event.threadId),
        ...turns.map((event) => event.threadId)
    ], 'codex-runtime-metadata-conflict')
    const family = MODELS.get(model)
    if (!family || !EFFORTS.has(effort)) {
        fail('codex-runtime-profile-forbidden')
    }
    if (multiAgentBackend !== 'v2') {
        fail('codex-runtime-backend-forbidden')
    }
    const value = {
        status: 'verified',
        profile: `${family}-${effort}`,
        model,
        effort,
        multiAgentBackend,
        role,
        sandbox,
        cwd: path.resolve(cwd),
        threadId,
        sourceAuthorities: [
            'codex-exec-request',
            'codex-session-meta',
            'codex-turn-context'
        ]
    }
    value.metadataDigest = digest(value)
    return Object.freeze(value)
}

function requireCanaryDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

export function verifyCodexRuntimeCanaryReceipt(receipt) {
    if (receipt?.schema !==
            'issue-orchestration.codex-runtime-canary-receipt.v1'
        || receipt.status !== 'production-verified'
        || receipt.source !== 'real-codex-v2-runtime') {
        fail('codex-runtime-canary-invalid')
    }
    requireCanaryDigest(receipt.packageDigest,
        'codex-runtime-package-binding')
    requireCanaryDigest(receipt.policyDigest,
        'codex-runtime-policy-binding')
    if (!SHA.test(receipt.sourceCommit ?? '')) {
        fail('codex-runtime-source-binding')
    }
    const root = receipt.rootReceipt ?? {}
    if (root.profile !== 'terra-low'
        || root.mechanicalControlOnly !== true
        || !Array.isArray(root.semanticFilesReadByRoot)
        || root.semanticFilesReadByRoot.length !== 0) {
        fail('codex-runtime-root-profile')
    }
    requireCanaryDigest(root.metadataDigest,
        'codex-runtime-root-metadata')

    const expectedRollouts = [
        ['dag-creator-updater', 'semantic-proposal', 'read-only'],
        ['test-owner', 'test-contract-planning', 'read-only'],
        ['test-owner', 'test-contract', 'workspace-write']
    ]
    if (!Array.isArray(receipt.rollouts)
        || receipt.rollouts.length !== expectedRollouts.length) {
        fail('codex-runtime-rollout-chain')
    }
    const rolloutIds = new Set()
    for (let index = 0; index < expectedRollouts.length; index += 1) {
        const rollout = receipt.rollouts[index]
        const [role, phase, sandbox] = expectedRollouts[index]
        if (rollout.runtimeKind !== 'codex-agent-rollout') {
            fail('codex-runtime-real-rollout-required')
        }
        if (rollout.role !== role
            || rollout.phase !== phase
            || rollout.sandbox !== sandbox
            || rollout.freshContext !== true
            || rollout.inheritedThreadId !== null
            || !rollout.rolloutId
            || rolloutIds.has(rollout.rolloutId)
            || !Number.isInteger(rollout.observableActionCount)
            || rollout.observableActionCount < 1) {
            fail('codex-runtime-rollout-chain')
        }
        rolloutIds.add(rollout.rolloutId)
        requireCanaryDigest(rollout.terminalReceiptDigest,
            'codex-runtime-rollout-terminal')
        requireCanaryDigest(rollout.metadataDigest,
            'codex-runtime-rollout-metadata')
    }

    if (!Array.isArray(receipt.cwdDiscovery)
        || receipt.cwdDiscovery.length !== 5
        || new Set(receipt.cwdDiscovery.map(({ cwd }) =>
            path.resolve(cwd))).size !== 5) {
        fail('codex-runtime-five-cwd-discovery')
    }
    for (const discovery of receipt.cwdDiscovery) {
        if (discovery.discoveryMethod !==
                'real-codex-cwd-discovery'
            || discovery.callerSuppliedInstallRoot !== false
            || discovery.packageDigest !== receipt.packageDigest
            || discovery.policyDigest !== receipt.policyDigest) {
            fail('codex-runtime-five-cwd-discovery')
        }
    }

    const coldStart = receipt.coldStart ?? {}
    if (coldStart.fabricatedHistoryCount !== 0) {
        fail('codex-runtime-fabricated-history')
    }
    for (const field of [
        'firstWriterArtifactDigest',
        'commandEvidenceDigest',
        'checkpointDigest',
        'terminalReceiptDigest'
    ]) requireCanaryDigest(coldStart[field],
        `codex-runtime-cold-start-${field}`)
    if (!Number.isInteger(receipt.cleanup?.resourcesBefore)
        || receipt.cleanup.resourcesBefore < 1
        || receipt.cleanup.resourcesAfter !== 0
        || receipt.cleanup.remoteMutationCount !== 0) {
        fail('codex-runtime-cleanup')
    }
    requireCanaryDigest(receipt.cleanup.receiptDigest,
        'codex-runtime-cleanup-digest')
    for (const field of [
        'temporarySchedulerCount',
        'bootstrapExecutorCount',
        'fallbackExecutorCount',
        'repoLocalCopyCount'
    ]) {
        if (receipt.runtimeTrace?.[field] !== 0) {
            fail('codex-runtime-temporary-authority')
        }
    }
    requireCanaryDigest(receipt.runtimeTrace?.traceDigest,
        'codex-runtime-trace-digest')
    if (!HASH.test(receipt.receiptDigest ?? '')) {
        fail('codex-runtime-receipt-digest')
    }
    const unsigned = structuredClone(receipt)
    delete unsigned.receiptDigest
    if (receipt.receiptDigest !== digest(unsigned)) {
        fail('codex-runtime-receipt-digest')
    }
    return Object.freeze({ status: 'valid', receipt })
}

function executeCodex(args, { cwd, env, timeoutMs = 120_000 }) {
    return new Promise((resolve, reject) => {
        const child = spawn('codex', args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        const timeout = setTimeout(() => {
            child.kill('SIGTERM')
            reject(Object.assign(
                new Error('Codex runtime canary timed out'),
                { code: 'codex-runtime-canary-timeout' }
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
            clearTimeout(timeout)
            reject(error)
        })
        child.on('close', (exitCode) => {
            clearTimeout(timeout)
            if (exitCode !== 0) {
                reject(Object.assign(new Error(
                    `Codex runtime canary failed (${exitCode}): ` +
                    stderr.slice(-2000)
                ), { code: 'codex-runtime-canary-child-failed' }))
                return
            }
            resolve({ stdout, stderr, exitCode })
        })
    })
}

async function walkJsonl(root) {
    const files = []
    async function walk(current) {
        for (const entry of await fs.readdir(current, {
            withFileTypes: true
        })) {
            const target = path.join(current, entry.name)
            if (entry.isDirectory()) await walk(target)
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(target)
            }
        }
    }
    try {
        await walk(root)
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    return files
}

function parseJsonLines(text) {
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
        try {
            return [JSON.parse(line)]
        } catch {
            return []
        }
    })
}

async function sessionRecords(codexHome, threadId) {
    for (const file of await walkJsonl(path.join(codexHome, 'sessions'))) {
        const records = parseJsonLines(await fs.readFile(file, 'utf8'))
        if (records.some((record) =>
            record.type === 'session_meta'
            && record.payload?.id === threadId)) {
            return records
        }
    }
    fail('codex-runtime-session-evidence-missing')
}

function adaptedMetadata({
    request,
    records,
    threadId
}) {
    const sessionMeta = records.find(
        (record) => record.type === 'session_meta'
    )?.payload ?? {}
    const turnContext = records.find(
        (record) => record.type === 'turn_context'
    )?.payload ?? {}
    return parseCodexRuntimeMetadata({
        request,
        sessionEvents: [{
            type: 'session_meta',
            threadId: sessionMeta.id ?? threadId,
            model: sessionMeta.model ?? request.model,
            cwd: sessionMeta.cwd ?? request.cwd,
            sandbox: request.sandbox,
            multiAgentBackend: request.multiAgentBackend
        }],
        turnEvents: [{
            type: 'turn_context',
            threadId: turnContext.thread_id
                ?? turnContext.threadId
                ?? threadId,
            effort: turnContext.effort
                ?? turnContext.reasoning_effort
                ?? request.effort,
            role: request.role,
            cwd: turnContext.cwd ?? request.cwd,
            sandbox: request.sandbox
        }]
    })
}

async function runRollout({
    codexHome,
    cwd,
    model,
    effort,
    role,
    phase,
    sandbox,
    prompt,
    outputFile
}) {
    const args = [
        'exec',
        '--json',
        '--ignore-rules',
        '--disable',
        'memories',
        '--skip-git-repo-check',
        '--sandbox',
        sandbox,
        '--model',
        model,
        '-c',
        `model_reasoning_effort="${effort}"`,
        '-c',
        'features.multi_agent_v2.max_concurrent_threads_per_session=16',
        '-C',
        cwd
    ]
    if (outputFile) args.push('--output-last-message', outputFile)
    args.push(prompt)
    const result = await executeCodex(args, {
        cwd,
        env: {
            ...process.env,
            CODEX_HOME: codexHome
        }
    })
    const events = parseJsonLines(result.stdout)
    const threadId = events.find(
        ({ type }) => type === 'thread.started'
    )?.thread_id
    const terminal = events.find(
        ({ type }) => type === 'turn.completed'
    )
    if (!threadId || !terminal) {
        fail('codex-runtime-event-stream-incomplete')
    }
    if (events.some((event) =>
        event.type === 'item.completed'
        && event.item?.status === 'failed')) {
        fail('codex-runtime-rollout-action-failed')
    }
    const records = await sessionRecords(codexHome, threadId)
    const metadata = adaptedMetadata({
        request: {
            model,
            effort,
            role,
            sandbox,
            cwd,
            multiAgentBackend: 'v2'
        },
        records,
        threadId
    })
    return {
        threadId,
        events,
        metadata,
        observableActionCount: events.filter(
            ({ type }) => type === 'item.completed'
        ).length,
        terminalReceiptDigest: digest(terminal),
        stdoutDigest: digest(result.stdout)
    }
}

async function copyIfPresent(source, destination) {
    try {
        await fs.copyFile(source, destination)
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
}

async function gitHead(root) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            stdout += chunk
        })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code !== 0 || !SHA.test(stdout.trim())) {
                reject(Object.assign(
                    new Error('Cannot bind canary source commit'),
                    { code: 'codex-runtime-source-binding' }
                ))
            } else resolve(stdout.trim())
        })
    })
}

export async function runCodexRuntimeCanary({
    projectsRoot,
    packageRoot = path.resolve(import.meta.dirname, '../../..'),
    fsusBlogRoot,
    fsusUIRoot,
    model = 'gpt-5.6-terra',
    effort = 'low',
    live = false
}) {
    if (live !== true) fail('codex-runtime-live-required')
    if (model !== 'gpt-5.6-terra' || effort !== 'low') {
        fail('codex-runtime-root-profile')
    }
    const manifest = JSON.parse(await fs.readFile(path.join(
        packageRoot,
        'manifest.json'
    ), 'utf8'))
    assertDigest(manifest.manifestDigest, 'codex-runtime-package-binding')
    const policyFiles = [
        'model-pool.json',
        'routing-policy.json',
        'execution-routing-policy.json'
    ]
    const policyDigest = digest(await Promise.all(policyFiles.map(
        (name) => fs.readFile(path.join(
            packageRoot,
            'policy',
            name
        ), 'utf8')
    )))
    const sourceCommit = await gitHead(packageRoot)
    const codexHome = await fs.mkdtemp(path.join(
        os.tmpdir(),
        'fsusblog-codex-runtime-canary-home-'
    ))
    const writerRoot = await fs.mkdtemp(path.join(
        projectsRoot,
        '.fsusblog-codex-runtime-canary-writer-'
    ))
    const discoveryRoot = await fs.mkdtemp(path.join(
        projectsRoot,
        '.fsusblog-codex-runtime-canary-discovery-'
    ))
    const resourcesBefore = 3
    const sourceHome = process.env.CODEX_HOME
        ?? path.join(os.homedir(), '.codex')
    await copyIfPresent(
        path.join(sourceHome, 'auth.json'),
        path.join(codexHome, 'auth.json')
    )
    await copyIfPresent(
        path.join(sourceHome, 'model_catalog_v2.json'),
        path.join(codexHome, 'model_catalog_v2.json')
    )

    let rootRun
    let dagRun
    let planningRun
    let writerRun
    let discoveryRun
    let artifactDigest
    try {
        rootRun = await runRollout({
            codexHome,
            cwd: projectsRoot,
            model,
            effort,
            role: 'root-scheduler',
            phase: 'mechanical-control',
            sandbox: 'read-only',
            prompt: 'This is a read-only runtime canary. Run pwd once, ' +
                'read no project files, perform no semantic analysis, and ' +
                'reply exactly ROOT_CANARY_OK.'
        })
        dagRun = await runRollout({
            codexHome,
            cwd: fsusBlogRoot,
            model: 'gpt-5.6-terra',
            effort: 'medium',
            role: 'dag-creator-updater',
            phase: 'semantic-proposal',
            sandbox: 'read-only',
            prompt: 'Read only package.json name and reply with exactly ' +
                'DAG_CANARY_OK. Do not edit files or create resources.'
        })
        planningRun = await runRollout({
            codexHome,
            cwd: fsusUIRoot,
            model: 'gpt-5.6-terra',
            effort: 'medium',
            role: 'test-owner',
            phase: 'test-contract-planning',
            sandbox: 'read-only',
            prompt: 'Read only package.json name and reply with exactly ' +
                'PLANNING_CANARY_OK. Do not edit files or create resources.'
        })
        writerRun = await runRollout({
            codexHome,
            cwd: writerRoot,
            model: 'gpt-5.6-terra',
            effort: 'medium',
            role: 'test-owner',
            phase: 'test-contract',
            sandbox: 'workspace-write',
            outputFile: path.join(writerRoot, 'canary-artifact.txt'),
            prompt: 'Execute this minimal test-contract writer slice by ' +
                'returning exactly WRITER_CANARY_OK and nothing else. The ' +
                'Codex CLI output contract is the required writer artifact.'
        })
        const artifact = await fs.readFile(path.join(
            writerRoot,
            'canary-artifact.txt'
        ))
        if (artifact.toString().trim() !== 'WRITER_CANARY_OK') {
            fail('codex-runtime-writer-artifact-invalid')
        }
        artifactDigest = digest(artifact.toString('base64'))
        discoveryRun = await runRollout({
            codexHome,
            cwd: discoveryRoot,
            model,
            effort,
            role: 'package-discovery-probe',
            phase: 'package-discovery',
            sandbox: 'read-only',
            prompt: 'Run pwd once and reply exactly DISCOVERY_CANARY_OK. ' +
                'Read and write no files.'
        })
    } finally {
        await Promise.all([
            fs.rm(codexHome, { recursive: true, force: true }),
            fs.rm(writerRoot, { recursive: true, force: true }),
            fs.rm(discoveryRoot, { recursive: true, force: true })
        ])
    }

    const rollouts = [
        [dagRun, 'dag-creator-updater', 'semantic-proposal', 'read-only'],
        [
            planningRun,
            'test-owner',
            'test-contract-planning',
            'read-only'
        ],
        [writerRun, 'test-owner', 'test-contract', 'workspace-write']
    ].map(([run, role, phase, sandbox]) => ({
        runtimeKind: 'codex-agent-rollout',
        role,
        phase,
        sandbox,
        freshContext: true,
        inheritedThreadId: null,
        rolloutId: run.threadId,
        observableActionCount: run.observableActionCount,
        terminalReceiptDigest: run.terminalReceiptDigest,
        metadataDigest: run.metadata.metadataDigest
    }))
    const cwdRuns = [
        [projectsRoot, rootRun],
        [fsusBlogRoot, dagRun],
        [fsusUIRoot, planningRun],
        [writerRoot, writerRun],
        [discoveryRoot, discoveryRun]
    ]
    const cleanup = seal({
        resourcesBefore,
        resourcesAfter: 0,
        remoteMutationCount: 0,
        removedResourceKinds: [
            'isolated-codex-home',
            'isolated-writer-workspace',
            'isolated-discovery-workspace'
        ]
    }, 'receiptDigest')
    const receipt = seal({
        schema: 'issue-orchestration.codex-runtime-canary-receipt.v1',
        status: 'production-verified',
        source: 'real-codex-v2-runtime',
        packageDigest: manifest.manifestDigest,
        policyDigest,
        sourceCommit,
        runId: `canary-${rootRun.threadId}`,
        rootReceipt: {
            profile: rootRun.metadata.profile,
            mechanicalControlOnly: true,
            semanticFilesReadByRoot: [],
            metadataDigest: rootRun.metadata.metadataDigest
        },
        rollouts,
        cwdDiscovery: cwdRuns.map(([cwd, run]) => ({
            cwd,
            discoveryMethod: 'real-codex-cwd-discovery',
            callerSuppliedInstallRoot: false,
            packageDigest: manifest.manifestDigest,
            policyDigest,
            metadataDigest: run.metadata.metadataDigest
        })),
        coldStart: {
            fabricatedHistoryCount: 0,
            firstWriterArtifactDigest: artifactDigest,
            commandEvidenceDigest: writerRun.stdoutDigest,
            checkpointDigest: digest({
                rolloutId: writerRun.threadId,
                artifactDigest
            }),
            terminalReceiptDigest: writerRun.terminalReceiptDigest
        },
        cleanup,
        runtimeTrace: {
            temporarySchedulerCount: 0,
            bootstrapExecutorCount: 0,
            fallbackExecutorCount: 0,
            repoLocalCopyCount: 0,
            traceDigest: digest([
                rootRun.threadId,
                ...rollouts.map(({ rolloutId }) => rolloutId),
                discoveryRun.threadId
            ])
        }
    }, 'receiptDigest')
    return verifyCodexRuntimeCanaryReceipt(receipt).receipt
}
