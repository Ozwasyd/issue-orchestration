import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
    HASH,
    digest,
    fail,
    sameValue,
    seal,
    unsignedDigest
} from './runtime-contract-lib.mjs'

const CONFIG_SCHEMA = 'issue-orchestration.model-qualification-config.v1'
const PLAN_SCHEMA = 'issue-orchestration.model-qualification-plan.v1'
const RECEIPT_SCHEMA = 'issue-orchestration.model-qualification-receipt.v1'
const FAILURE_SCHEMA = 'issue-orchestration.model-qualification-failure.v1'
const PRICING_SCHEMA = 'issue-orchestration.model-qualification-pricing.v1'
const CATALOG_SCHEMA = 'issue-orchestration.model-qualification-scenarios.v1'
const LIVE_FLAG = 'ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_LIVE'
const PREFIX = 'ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_'
const DEFAULT_SEED = 'issue-orchestration-model-qualification-v1'
const FIXED_GIT_DATE = '2026-08-06T00:00:00.000Z'
const FORBIDDEN_TOOL_COMMAND = /(?:\bgh\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\brsync\b|\bgit\s+(?:push|fetch|pull|clone|remote)\b|\bnpm\s+(?:install|ci|publish)\b|\bpnpm\b|\byarn\b|\bpip\s+install\b|\bdocker\b|\bpodman\b|\bnohup\b|\bsetsid\b|(?:^|[;&|])\s*[^\n]*&\s*(?:$|[;]))/u
const REQUIRED_ENV = Object.freeze([
    'PROFILES',
    'SCENARIOS',
    'MAX_INVOCATIONS',
    'MAX_TOKENS',
    'BUDGET_USD',
    'PRICING_FILE',
    'OUTPUT'
])

const packageRoot = path.resolve(import.meta.dirname, '../../..')
const modelPoolPath = path.join(packageRoot, 'policy/model-pool.json')
const catalogPath = path.join(
    packageRoot,
    'policy/model-qualification-scenarios.json'
)

function readJson(file, code) {
    try {
        return JSON.parse(fsSync.readFileSync(file, 'utf8'))
    } catch (error) {
        fail(code, code, { file: path.resolve(file), cause: error.message })
    }
}

function positiveInteger(value, code) {
    if (!/^[1-9][0-9]*$/u.test(value ?? '')) fail(code)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) fail(code)
    return parsed
}

function positiveMoney(value, code) {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(value ?? '')) {
        fail(code)
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) fail(code)
    return parsed
}

function exactCsv(value, code) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.trim() !== value || /\s/u.test(value)) {
        fail(code)
    }
    const items = value.split(',')
    if (items.some((item) => item.length === 0) ||
        new Set(items).size !== items.length) {
        fail(code)
    }
    return items
}

function prospectiveRealPath(file) {
    const resolved = path.resolve(file)
    const suffix = []
    let current = resolved
    while (!fsSync.existsSync(current)) {
        suffix.unshift(path.basename(current))
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
    }
    const real = fsSync.realpathSync.native(current)
    return path.join(real, ...suffix)
}

function ensureOutsidePackage(file, code) {
    const resolved = prospectiveRealPath(file)
    const realPackageRoot = fsSync.realpathSync.native(packageRoot)
    if (resolved === realPackageRoot ||
        resolved.startsWith(`${realPackageRoot}${path.sep}`)) {
        fail(code, code, { path: resolved })
    }
    return resolved
}

function loadPolicy() {
    const policy = readJson(modelPoolPath, 'model-qualification-policy-invalid')
    if (policy?.schema !== 'issue-orchestration.stage-model-pool-policy.v4' ||
        !Array.isArray(policy.productionRoster) ||
        !policy.profiles || typeof policy.profiles !== 'object') {
        fail('model-qualification-policy-invalid')
    }
    return policy
}

function loadCatalog(file = catalogPath) {
    const catalog = readJson(file, 'model-qualification-catalog-invalid')
    if (catalog?.schema !== CATALOG_SCHEMA ||
        !catalog.scenarios || typeof catalog.scenarios !== 'object' ||
        Array.isArray(catalog.scenarios)) {
        fail('model-qualification-catalog-invalid')
    }
    for (const [scenarioId, scenario] of Object.entries(catalog.scenarios)) {
        if (!/^[a-z0-9-]+$/u.test(scenarioId) ||
            !Number.isSafeInteger(scenario.tokenReservation) ||
            scenario.tokenReservation <= 0 ||
            !Number.isSafeInteger(scenario.timeoutMs) ||
            scenario.timeoutMs <= 0 ||
            !Array.isArray(scenario.allowedWriteRoots) ||
            scenario.allowedWriteRoots.length < 1 ||
            !Array.isArray(scenario.phases) || scenario.phases.length < 1 ||
            scenario.phases.some((phase) =>
                typeof phase?.prompt !== 'string' || !phase.prompt)) {
            fail('model-qualification-catalog-invalid', undefined, {
                scenarioId
            })
        }
    }
    return catalog
}

function loadPricing(file, profiles) {
    const pricing = readJson(file, 'model-qualification-pricing-invalid')
    if (pricing?.schema !== PRICING_SCHEMA || pricing.currency !== 'USD' ||
        typeof pricing.effectiveAt !== 'string' || !pricing.effectiveAt ||
        typeof pricing.source !== 'string' || !pricing.source ||
        !pricing.profiles || typeof pricing.profiles !== 'object') {
        fail('model-qualification-pricing-invalid')
    }
    for (const profile of profiles) {
        const rates = pricing.profiles[profile]
        if (!rates || [
            rates.inputUsdPerMillion,
            rates.cachedInputUsdPerMillion,
            rates.outputUsdPerMillion
        ].some((rate) => typeof rate !== 'number' ||
            !Number.isFinite(rate) || rate < 0)) {
            fail('model-qualification-pricing-missing', undefined, {
                profile
            })
        }
    }
    return pricing
}

export function parseModelQualificationConfig(
    env = process.env,
    { root = packageRoot } = {}
) {
    if (env.CI || env.GITHUB_ACTIONS) {
        fail('model-qualification-ci-forbidden')
    }
    if (env[LIVE_FLAG] !== '1') {
        fail('model-qualification-live-opt-in-required')
    }
    for (const suffix of REQUIRED_ENV) {
        const name = `${PREFIX}${suffix}`
        if (!env[name]) fail('model-qualification-control-required', name, {
            name
        })
    }
    const policy = loadPolicy()
    const catalog = loadCatalog()
    const profiles = exactCsv(
        env[`${PREFIX}PROFILES`],
        'model-qualification-profile-allowlist-invalid'
    )
    const scenarios = exactCsv(
        env[`${PREFIX}SCENARIOS`],
        'model-qualification-scenario-allowlist-invalid'
    )
    const productionProfiles = new Set(policy.productionRoster)
    if (profiles.some((profile) => !productionProfiles.has(profile))) {
        fail('model-qualification-profile-forbidden')
    }
    if (scenarios.some((scenario) => !catalog.scenarios[scenario])) {
        fail('model-qualification-scenario-forbidden')
    }
    const output = ensureOutsidePackage(
        env[`${PREFIX}OUTPUT`],
        'model-qualification-output-inside-package'
    )
    const pricingFile = path.resolve(env[`${PREFIX}PRICING_FILE`])
    const pricing = loadPricing(pricingFile, profiles)
    const config = {
        schema: CONFIG_SCHEMA,
        live: true,
        profiles,
        scenarios,
        maxInvocations: positiveInteger(
            env[`${PREFIX}MAX_INVOCATIONS`],
            'model-qualification-invocation-cap-invalid'
        ),
        maxTokens: positiveInteger(
            env[`${PREFIX}MAX_TOKENS`],
            'model-qualification-token-cap-invalid'
        ),
        budgetUsd: positiveMoney(
            env[`${PREFIX}BUDGET_USD`],
            'model-qualification-budget-invalid'
        ),
        pricingFile,
        output,
        seed: env[`${PREFIX}SEED`] || DEFAULT_SEED,
        packageRoot: path.resolve(root),
        policyDigest: digest(policy),
        catalogDigest: digest(catalog),
        pricingDigest: digest(pricing)
    }
    config.configDigest = digest(config)
    return Object.freeze({ config, policy, catalog, pricing })
}

function maxRate(rates) {
    return Math.max(
        rates.inputUsdPerMillion,
        rates.cachedInputUsdPerMillion,
        rates.outputUsdPerMillion
    )
}

export function compileModelQualificationPlan({
    config,
    policy,
    catalog,
    pricing
}) {
    const invocations = []
    for (const scenarioId of config.scenarios) {
        const scenario = catalog.scenarios[scenarioId]
        for (const profile of config.profiles) {
            scenario.phases.forEach((phase, phaseIndex) => {
                invocations.push({
                    ordinal: invocations.length,
                    profile,
                    scenarioId,
                    phaseIndex,
                    freshContext: phase.freshContext === true,
                    tokenReservation: scenario.tokenReservation,
                    timeoutMs: scenario.timeoutMs,
                    model: policy.profiles[profile].model,
                    effort: policy.profiles[profile].effort,
                    multiAgentBackend:
                        policy.profiles[profile].multiAgentBackend
                })
            })
        }
    }
    const reservedTokens = invocations.reduce(
        (sum, item) => sum + item.tokenReservation,
        0
    )
    const reservedCostUsd = invocations.reduce((sum, item) =>
        sum + item.tokenReservation / 1_000_000 *
            maxRate(pricing.profiles[item.profile]), 0)
    if (invocations.length > config.maxInvocations ||
        reservedTokens > config.maxTokens ||
        reservedCostUsd > config.budgetUsd) {
        fail('model-qualification-plan-exceeds-cap', undefined, {
            requiredInvocations: invocations.length,
            reservedTokens,
            reservedCostUsd,
            caps: {
                maxInvocations: config.maxInvocations,
                maxTokens: config.maxTokens,
                budgetUsd: config.budgetUsd
            }
        })
    }
    const plan = {
        schema: PLAN_SCHEMA,
        seed: config.seed,
        profiles: config.profiles,
        scenarios: config.scenarios,
        invocations,
        reservedInvocations: invocations.length,
        reservedTokens,
        reservedCostUsd,
        policyDigest: config.policyDigest,
        catalogDigest: config.catalogDigest,
        pricingDigest: config.pricingDigest,
        configDigest: config.configDigest
    }
    plan.planDigest = digest(plan)
    return Object.freeze(plan)
}

function sha256Buffer(value) {
    return createHash('sha256').update(value).digest('hex')
}

async function filesUnder(root) {
    const files = []
    async function walk(current) {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name)
            const relative = path.relative(root, target).split(path.sep).join('/')
            if (relative === '.git' || relative.startsWith('.git/')) continue
            if (entry.isDirectory()) await walk(target)
            else if (entry.isFile()) files.push(relative)
        }
    }
    try {
        await walk(root)
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    return files.sort()
}

async function snapshotFiles(root) {
    return Object.fromEntries(await Promise.all((await filesUnder(root)).map(
        async (relative) => [
            relative,
            sha256Buffer(await fs.readFile(path.join(root, relative)))
        ]
    )))
}

async function writeInitialFiles(root, scenario) {
    for (const [relative, content] of Object.entries(
        scenario.initialFiles ?? {}
    )) {
        const target = path.join(root, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
    }
    if (scenario.generatedEvidenceLines) {
        const lines = Array.from(
            { length: scenario.generatedEvidenceLines },
            (_, index) => index === scenario.generatedEvidenceLines - 1
                ? `directive ${index}: key=omega-${index}`
                : `evidence ${String(index).padStart(4, '0')}: stable-context-line`
        )
        const target = path.join(root, 'evidence/context.txt')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, `${lines.join('\n')}\n`)
    }
}

async function executeLocal(command, args, { cwd, env = {}, allowFailure = false }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('close', (exitCode) => {
            const result = { exitCode, stdout, stderr }
            if (exitCode !== 0 && !allowFailure) {
                reject(Object.assign(new Error(stderr || stdout), {
                    code: 'model-qualification-local-command-failed',
                    result
                }))
            } else resolve(result)
        })
    })
}

async function initializeLocalRepository(root) {
    const env = {
        GIT_AUTHOR_NAME: 'qualification-fixture',
        GIT_AUTHOR_EMAIL: 'qualification@example.invalid',
        GIT_COMMITTER_NAME: 'qualification-fixture',
        GIT_COMMITTER_EMAIL: 'qualification@example.invalid',
        GIT_AUTHOR_DATE: FIXED_GIT_DATE,
        GIT_COMMITTER_DATE: FIXED_GIT_DATE
    }
    await executeLocal('git', ['init', '--initial-branch=main'], { cwd: root, env })
    await executeLocal('git', ['add', '.'], { cwd: root, env })
    await executeLocal('git', ['commit', '-m', 'frozen qualification fixture'], {
        cwd: root,
        env
    })
    const remotes = await executeLocal('git', ['remote'], { cwd: root })
    if (remotes.stdout.trim()) fail('model-qualification-remote-forbidden')
}

async function prepareFrozenScenario(templateRoot, scenarioId, scenario) {
    const root = path.join(templateRoot, scenarioId)
    await fs.mkdir(root, { recursive: true })
    await writeInitialFiles(root, scenario)
    const frozenFiles = await snapshotFiles(root)
    const frozenInputDigest = digest(frozenFiles)
    await initializeLocalRepository(root)
    return Object.freeze({ scenarioId, root, frozenFiles, frozenInputDigest })
}

function relativeAllowed(relative, roots) {
    return roots.some((root) => relative === root || relative.startsWith(`${root}/`))
}

function verifyMutationBoundary(before, after, allowedWriteRoots) {
    const changed = [...new Set([
        ...Object.keys(before),
        ...Object.keys(after)
    ])].filter((relative) => before[relative] !== after[relative]).sort()
    const forbidden = changed.filter((relative) =>
        !relativeAllowed(relative, allowedWriteRoots))
    if (forbidden.length > 0) {
        fail('model-qualification-mutation-escape', undefined, { forbidden })
    }
    return Object.freeze({ changed, boundaryDigest: digest({ changed }) })
}

function parseJsonLines(text) {
    return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
    })
}

async function walkJsonl(root) {
    const files = []
    async function walk(current) {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name)
            if (entry.isDirectory()) await walk(target)
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target)
        }
    }
    try { await walk(root) } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    return files.sort()
}

function payload(record) {
    return record?.payload ?? record ?? {}
}

async function recordsForThread(codexHome, threadId) {
    for (const file of await walkJsonl(path.join(codexHome, 'sessions'))) {
        const records = parseJsonLines(await fs.readFile(file, 'utf8'))
        if (records.some((record) => record.type === 'session_meta' &&
            payload(record).id === threadId)) return records
    }
    fail('model-qualification-runtime-records-missing', undefined, { threadId })
}

function latestUsage(events, records) {
    const candidates = [...events, ...records].map(payload).flatMap((item) => {
        const usage = item.usage ?? item.token_usage ?? item.tokens
        return usage && typeof usage === 'object' ? [usage] : []
    })
    const usage = candidates.at(-1)
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens
    const cachedInputTokens = usage?.cached_input_tokens ??
        usage?.cachedInputTokens ?? 0
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens
    const totalTokens = usage?.total_tokens ?? usage?.totalTokens ??
        (Number(inputTokens) + Number(outputTokens))
    if (![inputTokens, cachedInputTokens, outputTokens, totalTokens]
        .every((value) => Number.isSafeInteger(value) && value >= 0) ||
        totalTokens < inputTokens + outputTokens) {
        fail('model-qualification-token-accounting-missing')
    }
    return Object.freeze({
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens
    })
}

function observedRuntime(records, request) {
    const sessions = records.filter(({ type }) => type === 'session_meta').map(payload)
    const turns = records.filter(({ type }) => type === 'turn_context').map(payload)
    const latest = turns.at(-1)
    const threadId = sessions.at(-1)?.id
    const runtime = {
        model: latest?.model,
        effort: latest?.effort ?? latest?.reasoning_effort,
        cwd: latest?.cwd ?? sessions.at(-1)?.cwd,
        sandbox: latest?.sandbox_policy ?? latest?.sandbox,
        multiAgentBackend: String(
            latest?.multi_agent_version ?? latest?.multiAgentBackend ?? ''
        ).replace(/^2$/u, 'v2'),
        profile: request.profile,
        threadId
    }
    if (!threadId || runtime.model !== request.model ||
        runtime.effort !== request.effort ||
        path.resolve(runtime.cwd ?? '') !== path.resolve(request.cwd) ||
        runtime.multiAgentBackend !== 'v2' ||
        !JSON.stringify(runtime.sandbox ?? '').includes('workspace')) {
        fail('model-qualification-runtime-mismatch', undefined, {
            request,
            runtime
        })
    }
    return Object.freeze(runtime)
}

export function observeModelQualificationTools(records) {
    const calls = records.flatMap((record) => {
        if (record.type !== 'response_item') return []
        const item = payload(record)
        if (item.type !== 'custom_tool_call') return []
        return [{
            name: item.name,
            input: typeof item.input === 'string' ? item.input :
                JSON.stringify(item.input ?? null)
        }]
    })
    const forbidden = calls.filter((call) =>
        FORBIDDEN_TOOL_COMMAND.test(call.input))
    if (forbidden.length > 0) {
        fail('model-qualification-forbidden-tool-call', undefined, {
            calls: forbidden.map((call) => ({
                name: call.name,
                callDigest: digest(call)
            }))
        })
    }
    return Object.freeze({
        count: calls.length,
        names: [...new Set(calls.map(({ name }) => name))].sort(),
        callDigests: calls.map(digest)
    })
}

function calculateCost(usage, rates) {
    const uncachedInput = Math.max(0,
        usage.inputTokens - usage.cachedInputTokens)
    const cost = uncachedInput / 1_000_000 * rates.inputUsdPerMillion +
        usage.cachedInputTokens / 1_000_000 * rates.cachedInputUsdPerMillion +
        usage.outputTokens / 1_000_000 * rates.outputUsdPerMillion
    if (!Number.isFinite(cost) || cost < 0) {
        fail('model-qualification-cost-accounting-missing')
    }
    return Number(cost.toFixed(8))
}

async function copyCredentialIfPresent(sourceRoot, targetRoot, name) {
    const source = path.join(sourceRoot, name)
    try {
        const stat = await fs.stat(source)
        if (!stat.isFile()) return false
        await fs.copyFile(source, path.join(targetRoot, name))
        await fs.chmod(path.join(targetRoot, name), 0o600)
        return true
    } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
    }
}

async function prepareCodexHome(root) {
    const source = path.resolve(
        process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
    )
    const target = path.join(root, 'codex-home')
    await fs.mkdir(target, { recursive: true, mode: 0o700 })
    const copied = []
    for (const name of ['auth.json', 'credentials.json']) {
        if (await copyCredentialIfPresent(source, target, name)) copied.push(name)
    }
    if (copied.length === 0) {
        fail('model-qualification-codex-auth-missing')
    }
    return Object.freeze({ sourceDigest: digest(source), target, copied })
}

function codexArgs(request, prompt) {
    return [
        'exec', '--json', '--ignore-rules', '--disable', 'memories',
        '--skip-git-repo-check', '--sandbox', 'workspace-write',
        '--model', request.model,
        '-c', `model_reasoning_effort="${request.effort}"`,
        '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'features.multi_agent_v2.max_concurrent_threads_per_session=1',
        '-C', request.cwd, prompt
    ]
}

async function spawnCodex(args, { cwd, env, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const started = performance.now()
        const child = spawn('codex', args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
        }, timeoutMs)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (exitCode) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({
                exitCode,
                stdout,
                stderr,
                elapsedMs: Math.round(performance.now() - started)
            })
        })
    })
}

export async function invokeRealCodexQualification({
    request,
    prompt,
    codexHome,
    timeoutMs
}) {
    const processResult = await spawnCodex(codexArgs(request, prompt), {
        cwd: request.cwd,
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs
    })
    const events = parseJsonLines(processResult.stdout)
    const threadId = events.find(({ type }) => type === 'thread.started')
        ?.thread_id
    if (!threadId || !events.some(({ type }) => type === 'turn.completed')) {
        fail('model-qualification-event-stream-incomplete', undefined, {
            exitCode: processResult.exitCode,
            stderrDigest: digest(processResult.stderr)
        })
    }
    const records = await recordsForThread(codexHome, threadId)
    const runtime = observedRuntime(records, request)
    const usage = latestUsage(events, records)
    const tools = observeModelQualificationTools(records)
    return Object.freeze({
        exitCode: processResult.exitCode,
        elapsedMs: processResult.elapsedMs,
        runtime,
        usage,
        tools,
        eventDigest: digest(events),
        recordDigest: digest(records)
    })
}

function replaceTemplate(value, variables) {
    return Object.entries(variables).reduce(
        (result, [name, replacement]) =>
            result.replaceAll(`{{${name}}}`, replacement),
        value
    )
}

async function applyReplacement(root, scenario) {
    const replacements = scenario.replacementFiles ?? {}
    for (const [relative, content] of Object.entries(replacements)) {
        const target = path.join(root, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
    }
    return Object.freeze({
        kind: 'runner-owned-candidate-replacement',
        fileDigests: Object.fromEntries(await Promise.all(
            Object.keys(replacements).sort().map(async (relative) => [
                relative,
                sha256Buffer(await fs.readFile(path.join(root, relative)))
            ])
        ))
    })
}

async function readCheckpoint(root) {
    const file = path.join(root, '.qualification/checkpoint.json')
    try {
        const raw = await fs.readFile(file, 'utf8')
        const value = JSON.parse(raw)
        return Object.freeze({ value, digest: digest(value) })
    } catch (error) {
        fail('model-qualification-checkpoint-missing', undefined, {
            cause: error.message
        })
    }
}

async function evaluateScenario(root, evaluator) {
    if (evaluator.testCommand) {
        const [command, ...args] = evaluator.testCommand
        await executeLocal(command, args, { cwd: root })
    }
    for (const relative of evaluator.requiredPaths ?? []) {
        try {
            if (!(await fs.stat(path.join(root, relative))).isFile()) {
                fail('model-qualification-required-evidence-missing')
            }
        } catch {
            fail('model-qualification-required-evidence-missing', undefined, {
                relative
            })
        }
    }
    for (const [relative, fragments] of Object.entries(
        evaluator.requiredIncludes ?? {}
    )) {
        const text = await fs.readFile(path.join(root, relative), 'utf8')
        if (fragments.some((fragment) => !text.includes(fragment))) {
            fail('model-qualification-evaluator-rejected', undefined, {
                relative
            })
        }
    }
    for (const [relative, assertions] of Object.entries(
        evaluator.jsonAssertions ?? {}
    )) {
        const value = JSON.parse(await fs.readFile(
            path.join(root, relative), 'utf8'
        ))
        if (Object.entries(assertions).some(([key, expected]) =>
            !sameValue(value[key], expected))) {
            fail('model-qualification-evaluator-rejected', undefined, {
                relative
            })
        }
    }
    if (evaluator.checkpoint) {
        const checkpoint = (await readCheckpoint(root)).value
        if (Object.entries(evaluator.checkpoint).some(([key, expected]) =>
            !sameValue(checkpoint[key], expected))) {
            fail('model-qualification-evaluator-rejected', undefined, {
                evidence: 'checkpoint'
            })
        }
    }
    if (evaluator.verificationDigestPath) {
        const candidate = await fs.readFile(
            path.join(root, evaluator.verificationDigestPath)
        )
        const expected = sha256Buffer(candidate)
        const verification = JSON.parse(await fs.readFile(
            path.join(root, '.qualification/verification.json'), 'utf8'
        ))
        if (verification.schema !== 'qualification-verification.v1' ||
            verification.accepted !== true ||
            verification.candidateDigest !== expected) {
            fail('model-qualification-evaluator-rejected', undefined, {
                evidence: 'fresh-verification'
            })
        }
    }
    return Object.freeze({
        accepted: true,
        finalFileDigest: digest(await snapshotFiles(root))
    })
}

async function protectedSourceSnapshot(root) {
    const result = await executeLocal('git', ['ls-files', '-z'], { cwd: root })
    const tracked = result.stdout.split('\0').filter(Boolean).sort()
    return Object.fromEntries(await Promise.all(tracked.map(async (relative) => [
        relative,
        sha256Buffer(await fs.readFile(path.join(root, relative)))
    ])))
}

async function ensureOutputAbsent(output) {
    for (const file of [output, `${output}.failed.json`]) {
        try {
            await fs.stat(file)
            fail('model-qualification-output-exists', undefined, { file })
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
    }
}

async function ensureOutputParent(output) {
    await fs.mkdir(path.dirname(output), { recursive: true })
}

async function writeReceipt(file, value) {
    await ensureOutputParent(file)
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600
    })
}

function invocationCostBudget(state, reservation, profile, pricing, config) {
    if (state.invocations + 1 > config.maxInvocations ||
        state.tokens + reservation > config.maxTokens ||
        state.costUsd + reservation / 1_000_000 *
            maxRate(pricing.profiles[profile]) > config.budgetUsd) {
        fail('model-qualification-next-invocation-cap')
    }
}

export async function runModelPoolQualification({
    env = process.env,
    invokeCodex = invokeRealCodexQualification,
    prepareRuntimeHome = prepareCodexHome,
    retainFailureEvidence = true
} = {}) {
    const loaded = parseModelQualificationConfig(env)
    const { config, policy, catalog, pricing } = loaded
    const plan = compileModelQualificationPlan(loaded)
    await ensureOutputAbsent(config.output)
    const protectedBefore = await protectedSourceSnapshot(config.packageRoot)
    const tempRoot = await fs.mkdtemp(path.join(
        os.tmpdir(), 'issue-orchestration-model-qualification-'
    ))
    const templateRoot = path.join(tempRoot, 'templates')
    const runRoot = path.join(tempRoot, 'runs')
    await fs.mkdir(templateRoot, { recursive: true })
    await fs.mkdir(runRoot, { recursive: true })
    const codexHome = await prepareRuntimeHome(tempRoot)
    const frozen = {}
    const invocations = []
    const scenarioResults = []
    const state = { invocations: 0, tokens: 0, costUsd: 0 }
    try {
        for (const scenarioId of config.scenarios) {
            frozen[scenarioId] = await prepareFrozenScenario(
                templateRoot,
                scenarioId,
                catalog.scenarios[scenarioId]
            )
        }
        for (const scenarioId of config.scenarios) {
            const scenario = catalog.scenarios[scenarioId]
            for (const profile of config.profiles) {
                const runDir = path.join(runRoot, scenarioId, profile)
                await fs.mkdir(path.dirname(runDir), { recursive: true })
                await fs.cp(frozen[scenarioId].root, runDir, {
                    recursive: true,
                    filter: (source) => !source.includes(`${path.sep}.git`)
                })
                await initializeLocalRepository(runDir)
                const initialDigest = digest(await snapshotFiles(runDir))
                if (initialDigest !== frozen[scenarioId].frozenInputDigest) {
                    fail('model-qualification-frozen-input-drift')
                }
                const phaseReceipts = []
                let replacement = null
                for (let phaseIndex = 0;
                    phaseIndex < scenario.phases.length;
                    phaseIndex += 1) {
                    invocationCostBudget(
                        state,
                        scenario.tokenReservation,
                        profile,
                        pricing,
                        config
                    )
                    const phase = scenario.phases[phaseIndex]
                    const before = await snapshotFiles(runDir)
                    const variables = {}
                    if (scenario.evaluator?.verificationDigestPath) {
                        const candidate = await fs.readFile(path.join(
                            runDir,
                            scenario.evaluator.verificationDigestPath
                        ))
                        variables.CANDIDATE_DIGEST = sha256Buffer(candidate)
                    }
                    const request = {
                        model: policy.profiles[profile].model,
                        effort: policy.profiles[profile].effort,
                        multiAgentBackend: 'v2',
                        sandbox: 'workspace-write',
                        networkAccess: false,
                        cwd: runDir,
                        profile,
                        scenarioId,
                        phaseIndex,
                        seed: config.seed
                    }
                    const result = await invokeCodex({
                        request,
                        prompt: replaceTemplate(phase.prompt, variables),
                        codexHome: codexHome.target,
                        timeoutMs: scenario.timeoutMs
                    })
                    if (!result?.usage || !result?.runtime || !result?.tools ||
                        !Number.isSafeInteger(result.elapsedMs) ||
                        result.elapsedMs < 0) {
                        fail('model-qualification-invocation-evidence-missing')
                    }
                    const after = await snapshotFiles(runDir)
                    const mutation = verifyMutationBoundary(
                        before,
                        after,
                        scenario.allowedWriteRoots
                    )
                    const costUsd = calculateCost(
                        result.usage,
                        pricing.profiles[profile]
                    )
                    state.invocations += 1
                    state.tokens += result.usage.totalTokens
                    state.costUsd = Number((state.costUsd + costUsd).toFixed(8))
                    if (result.usage.totalTokens > scenario.tokenReservation ||
                        state.invocations > config.maxInvocations ||
                        state.tokens > config.maxTokens ||
                        state.costUsd > config.budgetUsd) {
                        fail('model-qualification-observed-cap-exceeded')
                    }
                    let checkpoint = null
                    if (scenario.checkpointAfterPhase === phaseIndex) {
                        checkpoint = await readCheckpoint(runDir)
                    }
                    const accepted = (result.exitCode ?? 0) === 0
                    const retryRecovery = scenarioId ===
                            'runtime-probe-recovery'
                        ? {
                            kind: 'injected-transient-command',
                            recovered: after['.qualification/transient-seen']
                                !== undefined &&
                                after['.qualification/transient-recovered']
                                !== undefined
                        }
                        : { kind: 'none', recovered: null }
                    if (phase.freshContext === true &&
                        invocations.some((invocation) =>
                            invocation.scenarioId === scenarioId &&
                            invocation.profile === profile &&
                            invocation.effectiveRuntime.threadId ===
                                result.runtime.threadId)) {
                        fail('model-qualification-fresh-context-reused')
                    }
                    const phaseReceipt = seal({
                        schema: 'issue-orchestration.model-qualification-invocation.v1',
                        ordinal: invocations.length,
                        profile,
                        scenarioId,
                        phaseIndex,
                        freshContext: phase.freshContext === true,
                        requestedRuntime: request,
                        effectiveRuntime: result.runtime,
                        usage: result.usage,
                        costUsd,
                        elapsedMs: result.elapsedMs,
                        tools: result.tools,
                        mutation,
                        checkpoint,
                        accepted,
                        retryRecovery,
                        exitCode: result.exitCode ?? 0,
                        eventDigest: result.eventDigest ?? null,
                        recordDigest: result.recordDigest ?? null
                    }, 'invocationDigest')
                    invocations.push(phaseReceipt)
                    phaseReceipts.push(phaseReceipt.invocationDigest)
                    if (!accepted || retryRecovery.recovered === false) {
                        fail('model-qualification-invocation-rejected')
                    }
                    if (scenario.replacementAfterPhase === phaseIndex) {
                        replacement = await applyReplacement(runDir, scenario)
                    }
                }
                const evaluation = await evaluateScenario(
                    runDir,
                    scenario.evaluator ?? {}
                )
                scenarioResults.push(seal({
                    schema: 'issue-orchestration.model-qualification-scenario-result.v1',
                    profile,
                    scenarioId,
                    frozenInputDigest: frozen[scenarioId].frozenInputDigest,
                    phaseInvocationDigests: phaseReceipts,
                    replacement,
                    evaluation,
                    accepted: true
                }, 'resultDigest'))
            }
        }
        const protectedAfter = await protectedSourceSnapshot(config.packageRoot)
        if (!sameValue(protectedBefore, protectedAfter)) {
            fail('model-qualification-source-mutation')
        }
        await fs.rm(tempRoot, { recursive: true, force: true })
        let existsAfterDelete = true
        try {
            await fs.lstat(tempRoot)
        } catch (error) {
            if (error.code === 'ENOENT') existsAfterDelete = false
            else throw error
        }
        if (existsAfterDelete) fail('model-qualification-cleanup-incomplete')
        const cleanup = seal({
            observationMethod: 'post-delete-lstat',
            temporaryRootDigest: digest(tempRoot),
            existsAfterDelete: false,
            resourcesAfter: 0,
            retainedFailureEvidence: false
        }, 'cleanupDigest')
        const receipt = seal({
            schema: RECEIPT_SCHEMA,
            status: 'complete',
            diagnosticAuthority: 'none',
            automaticPolicyMutation: false,
            config: {
                profiles: config.profiles,
                scenarios: config.scenarios,
                maxInvocations: config.maxInvocations,
                maxTokens: config.maxTokens,
                budgetUsd: config.budgetUsd,
                seed: config.seed,
                configDigest: config.configDigest
            },
            bindings: {
                policyDigest: config.policyDigest,
                catalogDigest: config.catalogDigest,
                pricingDigest: config.pricingDigest,
                planDigest: plan.planDigest,
                protectedSourceDigest: digest(protectedAfter)
            },
            frozenInputs: Object.fromEntries(Object.entries(frozen).map(
                ([scenarioId, value]) => [scenarioId, value.frozenInputDigest]
            )),
            accounting: {
                invocationCount: state.invocations,
                totalTokens: state.tokens,
                totalCostUsd: state.costUsd,
                pricingCurrency: 'USD'
            },
            invocations,
            scenarioResults,
            cleanup
        }, 'receiptDigest')
        await writeReceipt(config.output, receipt)
        return Object.freeze(receipt)
    } catch (error) {
        await fs.rm(codexHome.target, { recursive: true, force: true })
        const failure = seal({
            schema: FAILURE_SCHEMA,
            status: 'failed',
            completeReceiptEmitted: false,
            error: {
                name: error.name,
                code: error.code ?? 'model-qualification-unexpected',
                message: error.message
            },
            planDigest: plan.planDigest,
            completedInvocationDigests:
                invocations.map(({ invocationDigest }) => invocationDigest),
            accounting: {
                invocationCount: state.invocations,
                totalTokens: state.tokens,
                totalCostUsd: state.costUsd
            },
            evidenceRoot: retainFailureEvidence ? tempRoot : null
        }, 'failureDigest')
        if (!retainFailureEvidence) {
            await fs.rm(tempRoot, { recursive: true, force: true })
        }
        await writeReceipt(`${config.output}.failed.json`, failure)
        throw error
    }
}

export function verifyModelQualificationReceipt(receipt) {
    if (receipt?.schema !== RECEIPT_SCHEMA ||
        receipt.status !== 'complete' ||
        receipt.diagnosticAuthority !== 'none' ||
        receipt.automaticPolicyMutation !== false ||
        !Array.isArray(receipt.invocations) ||
        !Array.isArray(receipt.scenarioResults) ||
        receipt.invocations.length < 1 ||
        receipt.scenarioResults.length < 1 ||
        receipt.cleanup?.observationMethod !== 'post-delete-lstat' ||
        receipt.cleanup?.existsAfterDelete !== false ||
        receipt.cleanup?.resourcesAfter !== 0 ||
        receipt.cleanup?.retainedFailureEvidence !== false ||
        !HASH.test(receipt.cleanup?.cleanupDigest ?? '') ||
        receipt.cleanup.cleanupDigest !==
            unsignedDigest(receipt.cleanup, 'cleanupDigest') ||
        !HASH.test(receipt.receiptDigest ?? '') ||
        receipt.receiptDigest !== unsignedDigest(receipt, 'receiptDigest')) {
        fail('model-qualification-receipt-invalid')
    }
    if (receipt.accounting?.invocationCount !== receipt.invocations.length ||
        receipt.accounting.totalTokens !== receipt.invocations.reduce(
            (sum, invocation) => sum + invocation.usage.totalTokens, 0
        ) ||
        receipt.accounting.totalCostUsd !== Number(receipt.invocations.reduce(
            (sum, invocation) => sum + invocation.costUsd, 0
        ).toFixed(8)) ||
        receipt.invocations.some((invocation) =>
            invocation.schema !==
                'issue-orchestration.model-qualification-invocation.v1' ||
            !HASH.test(invocation.invocationDigest ?? '') ||
            invocation.invocationDigest !==
                unsignedDigest(invocation, 'invocationDigest'))) {
        fail('model-qualification-receipt-invalid')
    }
    return Object.freeze({ status: 'valid', receipt })
}

export async function main() {
    const receipt = await runModelPoolQualification()
    process.stdout.write(`${JSON.stringify({
        status: receipt.status,
        receiptDigest: receipt.receiptDigest,
        output: process.env[`${PREFIX}OUTPUT`]
    })}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            code: error.code ?? 'model-qualification-unexpected',
            message: error.message
        })}\n`)
        process.exitCode = 1
    })
}
