import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
    digest,
    fail,
    seal,
    sameValue
} from './runtime-contract-lib.mjs'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const DISCOVERY_MARKER = 'ISSUE_ORCHESTRATION_DISCOVERY_OK_V1'
const METADATA_SCHEMA =
    'issue-orchestration.codex-runtime-metadata-evidence.v2'
const RECEIPT_SCHEMA =
    'issue-orchestration.codex-runtime-canary-receipt.v2'
const MODELS = new Map([
    ['gpt-5.6-terra', 'terra'],
    ['gpt-5.6-sol', 'sol']
])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function payload(event) {
    return event?.payload ?? event ?? {}
}

function observed(values, field) {
    const present = values
        .filter((value) => value !== undefined
            && value !== null && value !== '')
        .map((value) => typeof value === 'string'
            ? value
            : value?.type ?? value)
    if (present.length === 0) {
        fail('codex-runtime-observation-missing', field, { field })
    }
    if (present.some((value) => !sameValue(value, present[0]))) {
        fail('codex-runtime-observation-conflict', field, {
            field,
            values: present
        })
    }
    return present[0]
}

function normalizeBackend(value) {
    if (value === 2 || value === '2') return 'v2'
    return value
}

export function parseCodexRuntimeMetadata({
    request,
    sessionEvents,
    turnEvents,
    orchestrationLabels = {}
}) {
    const sessions = (sessionEvents ?? []).map(payload)
    const turns = (turnEvents ?? []).map(payload)
    if (!request || sessions.length < 1 || turns.length < 1) {
        fail('codex-runtime-observation-missing')
    }

    const runtimeObservation = {
        model: observed(turns.map((event) => event.model), 'model'),
        effort: observed(turns.map((event) =>
            event.effort ?? event.reasoning_effort), 'effort'),
        cwd: path.resolve(observed([
            ...sessions.map((event) => event.cwd),
            ...turns.map((event) => event.cwd)
        ], 'cwd')),
        sandbox: observed(turns.map((event) =>
            event.sandbox_policy ?? event.sandbox), 'sandbox'),
        multiAgentBackend: normalizeBackend(observed(turns.map((event) =>
            event.multi_agent_version
            ?? event.multiAgentBackend), 'multiAgentBackend')),
        threadId: observed(sessions.map((event) =>
            event.id ?? event.threadId), 'threadId')
    }
    const invocationRequest = {
        model: request.model,
        effort: request.effort,
        cwd: path.resolve(request.cwd),
        sandbox: request.sandbox,
        multiAgentBackend: normalizeBackend(request.multiAgentBackend)
    }
    const comparison = Object.fromEntries(
        Object.keys(invocationRequest).map((field) => [
            field,
            sameValue(invocationRequest[field], runtimeObservation[field])
        ])
    )
    if (Object.values(comparison).some((matches) => matches !== true)) {
        fail('codex-runtime-request-mismatch',
            'The requested runtime differs from observed turn metadata.',
            { invocationRequest, runtimeObservation, comparison })
    }
    const family = MODELS.get(runtimeObservation.model)
    if (!family || !EFFORTS.has(runtimeObservation.effort)) {
        fail('codex-runtime-profile-forbidden')
    }
    if (runtimeObservation.multiAgentBackend !== 'v2') {
        fail('codex-runtime-backend-forbidden')
    }
    const rawEvidence = {
        sessionRecordDigests: sessionEvents.map(digest),
        turnRecordDigests: turnEvents.map(digest)
    }
    const value = {
        schema: METADATA_SCHEMA,
        status: 'verified',
        profile:
            `${family}-${runtimeObservation.effort}`,
        invocationRequest,
        orchestrationLabels: {
            requestedRole:
                orchestrationLabels.requestedRole ?? null,
            requestedPhase:
                orchestrationLabels.requestedPhase ?? null,
            actionBoundary:
                orchestrationLabels.actionBoundary ?? null
        },
        runtimeObservation,
        comparison,
        rawEvidence,
        rawEvidenceDigest: digest(rawEvidence)
    }
    value.metadataDigest = digest(value)
    return Object.freeze(value)
}

function findJsonObject(text, start) {
    const open = text.indexOf('{', start)
    if (open < 0) return null
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = open; index < text.length; index += 1) {
        const character = text[index]
        if (quoted) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') quoted = false
            continue
        }
        if (character === '"') quoted = true
        else if (character === '{') depth += 1
        else if (character === '}') {
            depth -= 1
            if (depth === 0) return text.slice(open, index + 1)
        }
    }
    return null
}

function commandFromToolInput(input) {
    if (typeof input !== 'string') return null
    const marker = input.indexOf('exec_command(')
    if (marker < 0) return null
    const object = findJsonObject(input, marker)
    if (!object) return null
    try {
        return JSON.parse(object).cmd ?? null
    } catch {
        return null
    }
}

function recordToolCalls(records) {
    return records.flatMap((record) => {
        if (record.type !== 'response_item') return []
        const item = payload(record)
        if (item.type !== 'custom_tool_call') return []
        return [{
            name: item.name,
            callId: item.call_id ?? item.callId ?? null,
            input: item.input ?? ''
        }]
    })
}

export function observeCodexActions({
    records,
    installRoot,
    skillFile,
    markerFile
}) {
    const resolvedInstall = path.resolve(installRoot)
    const allowedFiles = [skillFile, markerFile].map(
        (file) => path.resolve(file)
    )
    const toolCalls = recordToolCalls(records)
    const commands = []
    const forbidden = []
    for (const call of toolCalls) {
        if (call.name !== 'exec') {
            forbidden.push({
                reason: 'non-exec-tool-call',
                callDigest: digest(call)
            })
            continue
        }
        const command = commandFromToolInput(call.input)
        if (!command) {
            forbidden.push({
                reason: 'unparseable-exec-command',
                callDigest: digest(call)
            })
            continue
        }
        commands.push(command)
        if (/\b(package\.json|git|gh|curl|wget|rm|mv|cp|tee|touch|mkdir)\b/u
            .test(command)) {
            forbidden.push({
                reason: 'forbidden-command-or-semantic-file',
                commandDigest: digest(command)
            })
        }
        const absolutePaths = command.match(/\/[^\s"'`;|)]+/gu) ?? []
        const mentionsAllowedFile = allowedFiles.some((file) =>
            command.includes(file))
        if (!mentionsAllowedFile || absolutePaths.some((candidate) => {
            const resolved = path.resolve(candidate)
            return !resolved.startsWith(`${resolvedInstall}${path.sep}`)
                || !allowedFiles.includes(resolved)
        })) {
            forbidden.push({
                reason: 'read-outside-installed-canary-files',
                commandDigest: digest(command)
            })
        }
    }
    const catalogObserved = records.some((record) => {
        const item = payload(record)
        const serialized = JSON.stringify(item)
        return record.type === 'response_item'
            && item.type === 'message'
            && ['developer', 'system'].includes(item.role)
            && serialized.includes(resolvedInstall)
            && serialized.includes('issue-orchestration')
    })
    const skillReadObserved = commands.some((command) =>
        command.includes(path.resolve(skillFile)))
    const markerReadObserved = commands.some((command) =>
        command.includes(path.resolve(markerFile)))
    const markerOutputObserved = records.some((record) => {
        const item = payload(record)
        return record.type === 'response_item'
            && item.type === 'message'
            && item.role === 'assistant'
            && JSON.stringify(item.content)
                .includes(DISCOVERY_MARKER)
    })
    if (!catalogObserved || !skillReadObserved
        || !markerReadObserved || !markerOutputObserved) {
        fail('codex-skill-discovery-unobserved', undefined, {
            catalogObserved,
            skillReadObserved,
            markerReadObserved,
            markerOutputObserved
        })
    }
    if (forbidden.length > 0) {
        fail('codex-runtime-action-forbidden', undefined, { forbidden })
    }
    const value = {
        observationScope: 'registered-codex-tool-calls',
        catalogObserved,
        skillReadObserved,
        markerReadObserved,
        markerOutputObserved,
        commands: commands.map((command) => ({
            commandDigest: digest(command)
        })),
        toolCallRecordDigests: toolCalls.map(digest),
        forbidden,
        unobservableClaims: [
            'filesystem-reads-outside-registered-codex-tool-calls',
            'remote-side-effects-outside-registered-codex-tool-calls'
        ]
    }
    value.observationDigest = digest(value)
    return Object.freeze(value)
}

export function verifyCleanupObservation(observation) {
    if (observation?.observationMethod !== 'post-delete-lstat'
        || !Array.isArray(observation.resources)
        || observation.resources.length < 1
        || observation.resources.some((resource) =>
            resource.existsAfterDelete !== false
            || typeof resource.pathDigest !== 'string')
        || observation.resourcesAfter !== 0) {
        fail('codex-runtime-cleanup')
    }
    const expected = digest({
        observationMethod: observation.observationMethod,
        resources: observation.resources,
        resourcesAfter: observation.resourcesAfter
    })
    if (observation.receiptDigest !== expected) {
        fail('codex-runtime-cleanup-digest')
    }
    return Object.freeze(observation)
}

function requireDigest(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

export function verifyCodexRuntimeCanaryReceipt(receipt) {
    if (receipt?.schema !== RECEIPT_SCHEMA
        || receipt.status !== 'production-verified'
        || receipt.source !== 'real-codex-v2-runtime') {
        fail('codex-runtime-canary-invalid')
    }
    for (const [value, code] of [
        [receipt.packageDigest, 'codex-runtime-package-binding'],
        [receipt.sourceTreeDigest, 'codex-runtime-package-binding'],
        [receipt.skillDigest, 'codex-runtime-package-binding'],
        [receipt.policyDigest, 'codex-runtime-policy-binding'],
        [receipt.installation?.installDigest,
            'codex-runtime-install-binding'],
        [receipt.runtimeTrace?.traceDigest,
            'codex-runtime-trace-digest']
    ]) requireDigest(value, code)
    if (!SHA.test(receipt.sourceCommit ?? '')) {
        fail('codex-runtime-source-binding')
    }
    const installation = receipt.installation ?? {}
    if (installation.installMethod !==
            'isolated-codex-home-standard-skill-path'
        || installation.manifestDigest !== receipt.packageDigest
        || installation.sourceTreeDigest !== receipt.sourceTreeDigest
        || !Array.isArray(installation.fileBindings)
        || installation.fileBindings.length < 2
        || installation.fileBindings.some((binding) =>
            typeof binding.sourceRelative !== 'string'
            || !binding.sourceRelative.startsWith(
                'skills/issue-orchestration/')
            || !HASH.test(binding.installedDigest ?? ''))) {
        fail('codex-runtime-install-binding')
    }
    const installationUnsigned = structuredClone(installation)
    delete installationUnsigned.installDigest
    if (installation.installDigest !== digest(installationUnsigned)) {
        fail('codex-runtime-install-binding')
    }
    const probes = receipt.discoveryProbes
    if (!Array.isArray(probes) || probes.length !== 5
        || new Set(probes.map(({ cwd }) =>
            path.resolve(cwd))).size !== 5
        || new Set(probes.map(({ threadId }) =>
            threadId)).size !== 5) {
        fail('codex-runtime-five-cwd-discovery')
    }
    for (const probe of probes) {
        if (probe.schema !==
                'issue-orchestration.codex-skill-discovery-probe.v1'
            || probe.discoveryMethod !==
                'codex-runtime-catalog-and-tool-read'
            || probe.freshContext !== true
            || probe.inheritedThreadId !== null
            || probe.callerSuppliedPathInPrompt !== false
            || probe.installRootDigest
                !== receipt.installation.installRootDigest
            || probe.packageDigest !== receipt.packageDigest
            || probe.skillDigest !== receipt.skillDigest
            || probe.sourceCommit !== receipt.sourceCommit
            || probe.runtimeMetadata?.schema !== METADATA_SCHEMA
            || probe.runtimeMetadata?.status !== 'verified'
            || probe.runtimeMetadata?.orchestrationLabels
                ?.requestedRole !== 'package-discovery-probe'
            || probe.runtimeMetadata?.rawEvidenceDigest !== digest(
                probe.runtimeMetadata?.rawEvidence)
            || probe.actionObservation?.catalogObserved !== true
            || probe.actionObservation?.skillReadObserved !== true
            || probe.actionObservation?.markerReadObserved !== true
            || probe.actionObservation
                ?.markerOutputObserved !== true
            || probe.actionObservation?.observationScope !==
                'registered-codex-tool-calls'
            || probe.actionObservation?.commands?.length < 1
            || probe.actionObservation
                ?.toolCallRecordDigests?.length < 1
            || probe.actionObservation?.forbidden?.length !== 0) {
            fail('codex-runtime-five-cwd-discovery')
        }
        const metadataUnsigned = structuredClone(
            probe.runtimeMetadata)
        delete metadataUnsigned.metadataDigest
        if (probe.runtimeMetadata.metadataDigest
                !== digest(metadataUnsigned)) {
            fail('codex-runtime-rollout-metadata')
        }
        const actionUnsigned = structuredClone(
            probe.actionObservation)
        delete actionUnsigned.observationDigest
        if (probe.actionObservation.observationDigest
                !== digest(actionUnsigned)) {
            fail('codex-runtime-action-observation-digest')
        }
        requireDigest(probe.probeDigest,
            'codex-runtime-discovery-digest')
        const probeUnsigned = structuredClone(probe)
        delete probeUnsigned.probeDigest
        if (probe.probeDigest !== digest(probeUnsigned)) {
            fail('codex-runtime-discovery-digest')
        }
    }
    if (receipt.machineObservation?.repoLocalCopies
            ?.some(({ present }) => present !== false)
        || receipt.machineObservation
            ?.observationMethod !== 'post-run-lstat') {
        fail('codex-runtime-repo-local-copy')
    }
    if (receipt.machineObservation.observationDigest !== digest(
        receipt.machineObservation.repoLocalCopies)) {
        fail('codex-runtime-machine-observation-digest')
    }
    verifyCleanupObservation(receipt.cleanup)
    if (receipt.runtimeTrace?.observationScope
            !== 'registered-codex-tool-calls'
        || receipt.runtimeTrace.mutatingToolCallCount !== 0
        || receipt.runtimeTrace.unobservableClaims?.length < 1) {
        fail('codex-runtime-trace-invalid')
    }
    const traceUnsigned = structuredClone(receipt.runtimeTrace)
    delete traceUnsigned.traceDigest
    if (receipt.runtimeTrace.traceDigest !== digest(traceUnsigned)) {
        fail('codex-runtime-trace-digest')
    }
    requireDigest(receipt.receiptDigest,
        'codex-runtime-receipt-digest')
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
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (error) => {
            clearTimeout(timeout)
            reject(error)
        })
        child.on('close', (exitCode) => {
            clearTimeout(timeout)
            if (exitCode !== 0) {
                reject(Object.assign(new Error(
                    `Codex runtime canary failed (${exitCode}): `
                    + stderr.slice(-2000)
                ), { code: 'codex-runtime-canary-child-failed' }))
            } else resolve({ stdout, stderr, exitCode })
        })
    })
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

async function runDiscoveryProbe({
    codexHome,
    cwd,
    installRoot,
    skillFile,
    markerFile,
    packageDigest,
    skillDigest,
    sourceCommit,
    model,
    effort
}) {
    const request = {
        model,
        effort,
        cwd,
        sandbox: 'danger-full-access',
        multiAgentBackend: 'v2'
    }
    const prompt = [
        'ISSUE_ORCHESTRATION_DISCOVERY_CANARY.',
        'Use the issue-orchestration Skill installed in this session Codex',
        'home, follow its discovery-canary instructions, and return only',
        `${DISCOVERY_MARKER}.`
    ].join(' ')
    const result = await executeCodex([
        'exec',
        '--json',
        '--ignore-rules',
        '--disable',
        'memories',
        '--skip-git-repo-check',
        '--sandbox',
        request.sandbox,
        '--model',
        model,
        '-c',
        `model_reasoning_effort="${effort}"`,
        '-c',
        'features.multi_agent_v2.max_concurrent_threads_per_session=16',
        '-C',
        cwd,
        prompt
    ], {
        cwd,
        env: { ...process.env, CODEX_HOME: codexHome }
    })
    const events = parseJsonLines(result.stdout)
    const threadId = events.find(
        ({ type }) => type === 'thread.started'
    )?.thread_id
    if (!threadId || !events.some(
        ({ type }) => type === 'turn.completed')) {
        fail('codex-runtime-event-stream-incomplete')
    }
    const records = await sessionRecords(codexHome, threadId)
    const sessionEvents = records.filter(
        ({ type }) => type === 'session_meta')
    const turnEvents = records.filter(
        ({ type }) => type === 'turn_context')
    const runtimeMetadata = parseCodexRuntimeMetadata({
        request,
        sessionEvents,
        turnEvents,
        orchestrationLabels: {
            requestedRole: 'package-discovery-probe',
            requestedPhase: 'installed-skill-discovery',
            actionBoundary: 'installed-skill-and-canary-marker-read'
        }
    })
    const actionObservation = observeCodexActions({
        records,
        installRoot,
        skillFile,
        markerFile
    })
    if (!JSON.stringify(events).includes(DISCOVERY_MARKER)) {
        fail('codex-skill-discovery-marker-missing')
    }
    return seal({
        schema:
            'issue-orchestration.codex-skill-discovery-probe.v1',
        discoveryMethod: 'codex-runtime-catalog-and-tool-read',
        cwd: path.resolve(cwd),
        threadId,
        freshContext: true,
        inheritedThreadId: null,
        callerSuppliedPathInPrompt: false,
        installRootDigest: digest(path.resolve(installRoot)),
        packageDigest,
        skillDigest,
        sourceCommit,
        runtimeMetadata,
        actionObservation,
        terminalEventDigest: digest(events.find(
            ({ type }) => type === 'turn.completed')),
        stdoutDigest: digest(result.stdout)
    }, 'probeDigest')
}

async function copyIfPresent(source, destination) {
    try {
        await fs.copyFile(source, destination)
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
}

async function installSkill({ packageRoot, codexHome, manifest }) {
    const source = path.join(
        packageRoot, 'skills', 'issue-orchestration')
    const target = path.join(
        codexHome, 'skills', 'issue-orchestration')
    await fs.cp(source, target, {
        recursive: true,
        errorOnExist: true,
        force: false
    })
    const installedFiles = []
    async function walk(current) {
        for (const entry of await fs.readdir(current, {
            withFileTypes: true
        })) {
            const child = path.join(current, entry.name)
            if (entry.isDirectory()) await walk(child)
            else installedFiles.push(child)
        }
    }
    await walk(target)
    const bindings = installedFiles.map((file) => {
        const withinSkill = path.relative(target, file)
            .split(path.sep).join('/')
        const sourceRelative =
            `skills/issue-orchestration/${withinSkill}`
        const bytes = fsSync.readFileSync(file)
        const actualDigest = createHash('sha256')
            .update(bytes).digest('hex')
        const sourceBytes = fsSync.readFileSync(
            path.join(packageRoot, sourceRelative))
        const sourceDigest = createHash('sha256')
            .update(sourceBytes).digest('hex')
        if (actualDigest !== sourceDigest
            || sourceDigest
                !== manifest.artifactDigests[sourceRelative]) {
            fail('codex-runtime-install-drift', sourceRelative)
        }
        return { sourceRelative, installedDigest: actualDigest }
    }).sort((left, right) =>
        left.sourceRelative.localeCompare(right.sourceRelative))
    const value = {
        installMethod: 'isolated-codex-home-standard-skill-path',
        installRootDigest: digest(path.resolve(target)),
        fileBindings: bindings,
        manifestDigest: manifest.manifestDigest,
        sourceTreeDigest: manifest.sourceTreeDigest
    }
    value.installDigest = digest(value)
    return Object.freeze({
        ...value,
        installRoot: target
    })
}

async function exists(target) {
    try {
        await fs.lstat(target)
        return true
    } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
    }
}

export async function verifyManifestSourceCommit(root, sourceCommit) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', [
            'diff',
            '--quiet',
            sourceCommit,
            '--',
            'agents',
            'contracts',
            'graph',
            'policy',
            'scripts',
            'skills'
        ], {
            cwd: root,
            stdio: ['ignore', 'ignore', 'pipe']
        })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code !== 0) {
                reject(Object.assign(
                    new Error(
                        'Manifest source commit does not match artifacts'),
                    { code: 'codex-runtime-source-binding' }
                ))
            } else resolve(sourceCommit)
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
    const packageLib = await import(path.join(
        packageRoot, 'scripts', 'package-lib.mjs'))
    const manifest = packageLib.readManifest(packageRoot)
    const sourceCommit = await verifyManifestSourceCommit(
        packageRoot, manifest.sourceCommit)
    const policyFiles = [
        'model-pool.json',
        'routing-policy.json',
        'execution-routing-policy.json'
    ]
    const policyDigest = digest(await Promise.all(policyFiles.map(
        (name) => fs.readFile(path.join(
            packageRoot, 'policy', name), 'utf8')
    )))
    const codexHome = await fs.mkdtemp(path.join(
        os.tmpdir(), 'issue-orchestration-codex-home-'))
    const writerRoot = await fs.mkdtemp(path.join(
        os.tmpdir(), 'issue-orchestration-writer-cwd-'))
    const discoveryRoot = await fs.mkdtemp(path.join(
        os.tmpdir(), 'issue-orchestration-discovery-cwd-'))
    const resources = [codexHome, writerRoot, discoveryRoot]
    const sourceHome = process.env.CODEX_HOME
        ?? path.join(os.homedir(), '.codex')
    let installation
    let discoveryProbes
    try {
        await copyIfPresent(
            path.join(sourceHome, 'auth.json'),
            path.join(codexHome, 'auth.json'))
        await copyIfPresent(
            path.join(sourceHome, 'model_catalog_v2.json'),
            path.join(codexHome, 'model_catalog_v2.json'))
        installation = await installSkill({
            packageRoot, codexHome, manifest
        })
        const skillFile = path.join(
            installation.installRoot, 'SKILL.md')
        const markerFile = path.join(
            installation.installRoot,
            'references',
            'runtime-discovery-canary.md')
        const cwds = [
            projectsRoot,
            fsusBlogRoot,
            fsusUIRoot,
            writerRoot,
            discoveryRoot
        ]
        discoveryProbes = []
        for (const cwd of cwds) {
            discoveryProbes.push(await runDiscoveryProbe({
                codexHome,
                cwd,
                installRoot: installation.installRoot,
                skillFile,
                markerFile,
                packageDigest: manifest.manifestDigest,
                skillDigest: manifest.skillDigest,
                sourceCommit,
                model,
                effort
            }))
        }
    } finally {
        await Promise.all(resources.map((target) =>
            fs.rm(target, { recursive: true, force: true })))
    }
    const cleanupResources = await Promise.all(resources.map(
        async (target) => ({
            kind: target === codexHome
                ? 'isolated-codex-home'
                : 'isolated-cwd',
            pathDigest: digest(path.resolve(target)),
            existsAfterDelete: await exists(target)
        })))
    const cleanupBody = {
        observationMethod: 'post-delete-lstat',
        resources: cleanupResources,
        resourcesAfter: cleanupResources.filter(
            ({ existsAfterDelete }) => existsAfterDelete).length
    }
    const cleanup = verifyCleanupObservation({
        ...cleanupBody,
        receiptDigest: digest(cleanupBody)
    })
    const repoLocalPaths = [
        path.join(fsusBlogRoot,
            '.agents/skills/issue-orchestration'),
        path.join(fsusBlogRoot,
            '.codex/skills/issue-orchestration'),
        path.join(fsusUIRoot,
            '.agents/skills/issue-orchestration'),
        path.join(fsusUIRoot,
            '.codex/skills/issue-orchestration')
    ]
    const repoLocalCopies = await Promise.all(
        repoLocalPaths.map(async (candidate) => ({
            pathDigest: digest(path.resolve(candidate)),
            present: await exists(candidate)
        })))
    const allCalls = discoveryProbes.flatMap(
        ({ actionObservation }) => actionObservation.commands)
    const runtimeTrace = {
        observationScope: 'registered-codex-tool-calls',
        mutatingToolCallCount: 0,
        observedCommandDigests: allCalls.map(
            ({ commandDigest }) => commandDigest),
        unobservableClaims: [
            'remote-side-effects-outside-registered-codex-tool-calls'
        ]
    }
    runtimeTrace.traceDigest = digest(runtimeTrace)
    const receipt = seal({
        schema: RECEIPT_SCHEMA,
        status: 'production-verified',
        source: 'real-codex-v2-runtime',
        packageDigest: manifest.manifestDigest,
        sourceTreeDigest: manifest.sourceTreeDigest,
        skillDigest: manifest.skillDigest,
        policyDigest,
        sourceCommit,
        runId: `canary-${discoveryProbes[0].threadId}`,
        installation: {
            installMethod: installation.installMethod,
            installRootDigest: installation.installRootDigest,
            fileBindings: installation.fileBindings,
            manifestDigest: installation.manifestDigest,
            sourceTreeDigest: installation.sourceTreeDigest,
            installDigest: installation.installDigest
        },
        discoveryProbes,
        machineObservation: {
            observationMethod: 'post-run-lstat',
            repoLocalCopies,
            observationDigest: digest(repoLocalCopies)
        },
        cleanup,
        runtimeTrace
    }, 'receiptDigest')
    return verifyCodexRuntimeCanaryReceipt(receipt).receipt
}
