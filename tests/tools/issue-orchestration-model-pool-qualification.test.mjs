import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    compileModelQualificationPlan,
    parseModelQualificationConfig,
    runModelPoolQualification,
    observeModelQualificationTools,
    verifyModelQualificationReceipt
} from '../../skills/issue-orchestration/scripts/model-pool-qualification.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')

async function fixtureEnv({
    profiles = 'terra-low',
    scenarios = 'atomic-mechanical',
    maxInvocations = '30',
    maxTokens = '500000',
    budgetUsd = '100'
} = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qualification-test-'))
    const pricing = path.join(root, 'pricing.json')
    const output = path.join(root, 'receipt.json')
    await fs.writeFile(pricing, JSON.stringify({
        schema: 'issue-orchestration.model-qualification-pricing.v1',
        currency: 'USD',
        effectiveAt: '2026-08-06T00:00:00.000Z',
        source: 'offline deterministic test fixture',
        profiles: {
            'terra-low': {
                inputUsdPerMillion: 1,
                cachedInputUsdPerMillion: 0.1,
                outputUsdPerMillion: 4
            },
            'terra-medium': {
                inputUsdPerMillion: 2,
                cachedInputUsdPerMillion: 0.2,
                outputUsdPerMillion: 8
            }
        }
    }))
    return {
        root,
        output,
        env: {
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_LIVE: '1',
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_PROFILES: profiles,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_SCENARIOS: scenarios,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_MAX_INVOCATIONS:
                maxInvocations,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_MAX_TOKENS: maxTokens,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_BUDGET_USD: budgetUsd,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_PRICING_FILE: pricing,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_OUTPUT: output
        }
    }
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

async function fakeRuntimeHome(tempRoot) {
    const target = path.join(tempRoot, 'fake-codex-home')
    await fs.mkdir(target, { recursive: true })
    return { target, sourceDigest: sha256('fake'), copied: [] }
}

async function fakeCodex({ request }) {
    const cwd = request.cwd
    const write = async (relative, content) => {
        const target = path.join(cwd, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content)
    }
    switch (request.scenarioId) {
        case 'atomic-mechanical':
            await write('src/constants.mjs',
                'export const RETRY_LIMIT = 4\n')
            break
        case 'bounded-single-module':
            await write('src/dedupe.mjs', [
                'export function dedupe(values) {',
                '    return [...new Set(values)]',
                '}',
                ''
            ].join('\n'))
            break
        case 'stateful-multi-file-checkpoint':
            if (request.phaseIndex === 0) {
                await write('src/parse.mjs', [
                    "export function parsePair(text) {",
                    "    return text.split('=').map((value) => value.trim())",
                    '}',
                    ''
                ].join('\n'))
                await write('.qualification/checkpoint.json', JSON.stringify({
                    schema: 'qualification-checkpoint.v1',
                    completed: ['parse'],
                    next: 'format'
                }))
            } else {
                await write('src/format.mjs', [
                    'export function formatPair(pair) {',
                    "    return pair.join('=')",
                    '}',
                    ''
                ].join('\n'))
                await write('.qualification/checkpoint.json', JSON.stringify({
                    schema: 'qualification-checkpoint.v1',
                    completed: ['parse', 'format'],
                    next: null
                }))
            }
            break
        case 'runtime-probe-recovery':
            await write('.qualification/transient-seen', 'seen\n')
            await write('.qualification/transient-recovered', 'recovered\n')
            await write('src/value.mjs', 'export const value = 7\n')
            break
        case 'fresh-verification-after-replacement':
            if (request.phaseIndex === 0) {
                await write('src/candidate.mjs',
                    "export function candidate() { return 'candidate-a' }\n")
            } else {
                const candidate = await fs.readFile(
                    path.join(cwd, 'src/candidate.mjs')
                )
                await write('.qualification/verification.json', JSON.stringify({
                    schema: 'qualification-verification.v1',
                    accepted: true,
                    candidateDigest: sha256(candidate)
                }))
            }
            break
        case 'prescribed-ui-judgment':
            await write('ui/card.css', [
                '.card { padding: 16px; border-radius: 12px; }',
                'button { min-height: 40px; color: #2563EB; }',
                ''
            ].join('\n'))
            await write('.qualification/ux-assessment.json', JSON.stringify({
                schema: 'qualification-ux-assessment.v1',
                accepted: true,
                evidence: [
                    'paddingPx', 'radiusPx',
                    'buttonMinHeightPx', 'accent'
                ]
            }))
            break
        case 'long-context-checkpoint-reload': {
            const evidence = await fs.readFile(
                path.join(cwd, 'evidence/context.txt')
            )
            const checkpoint = {
                schema: 'qualification-checkpoint.v1',
                completed: ['evidence-read'],
                next: request.phaseIndex === 0 ? 'implement' : null,
                key: 'omega-1199',
                checksum: sha256(evidence)
            }
            await write('.qualification/checkpoint.json',
                JSON.stringify(checkpoint))
            if (request.phaseIndex === 1) {
                await write('src/answer.mjs', [
                    'export const answer = {',
                    "    key: 'omega-1199',",
                    `    checksum: '${checkpoint.checksum}'`,
                    '}',
                    ''
                ].join('\n'))
            }
            break
        }
        default:
            throw new Error(`unknown scenario ${request.scenarioId}`)
    }
    return {
        exitCode: 0,
        elapsedMs: 12,
        runtime: {
            model: request.model,
            effort: request.effort,
            cwd: request.cwd,
            sandbox: 'workspace-write',
            multiAgentBackend: 'v2',
            threadId: `thread-${request.profile}-${request.scenarioId}-${request.phaseIndex}`
        },
        usage: {
            inputTokens: 80,
            cachedInputTokens: 20,
            outputTokens: 20,
            totalTokens: 100
        },
        tools: {
            count: 2,
            names: ['exec'],
            callDigests: [sha256('one'), sha256('two')]
        },
        eventDigest: sha256('events'),
        recordDigest: sha256('records')
    }
}

test('qualification is impossible without every explicit operator control',
    async () => {
        const fixture = await fixtureEnv()
        const names = Object.keys(fixture.env)
        for (const name of names) {
            const env = { ...fixture.env }
            delete env[name]
            assert.throws(() => parseModelQualificationConfig(env), {
                name: 'RuntimeContractError'
            })
        }
        assert.throws(() => parseModelQualificationConfig({
            ...fixture.env,
            CI: 'true'
        }), { code: 'model-qualification-ci-forbidden' })
        await fs.rm(fixture.root, { recursive: true, force: true })
    })

test('profile and scenario allowlists are exact and production-only',
    async () => {
        const fixture = await fixtureEnv()
        assert.throws(() => parseModelQualificationConfig({
            ...fixture.env,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_PROFILES: 'sol-max'
        }), { code: 'model-qualification-profile-forbidden' })
        assert.throws(() => parseModelQualificationConfig({
            ...fixture.env,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_SCENARIOS: 'unknown'
        }), { code: 'model-qualification-scenario-forbidden' })
        assert.throws(() => parseModelQualificationConfig({
            ...fixture.env,
            ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_PROFILES:
                'terra-low, terra-medium'
        }), { code: 'model-qualification-profile-allowlist-invalid' })
        await fs.rm(fixture.root, { recursive: true, force: true })
    })

test('plan reserves every real invocation before the first paid call',
    async () => {
        const fixture = await fixtureEnv({
            profiles: 'terra-low,terra-medium',
            scenarios:
                'atomic-mechanical,stateful-multi-file-checkpoint'
        })
        const loaded = parseModelQualificationConfig(fixture.env)
        const plan = compileModelQualificationPlan(loaded)
        assert.equal(plan.reservedInvocations, 6)
        assert.equal(plan.invocations.filter(({ scenarioId }) =>
            scenarioId === 'atomic-mechanical').length, 2)
        assert.equal(plan.invocations.filter(({ scenarioId }) =>
            scenarioId === 'stateful-multi-file-checkpoint').length, 4)
        assert.throws(() => compileModelQualificationPlan({
            ...loaded,
            config: { ...loaded.config, maxInvocations: 5 }
        }), { code: 'model-qualification-plan-exceeds-cap' })
        await fs.rm(fixture.root, { recursive: true, force: true })
    })

test('offline fake matrix proves frozen inputs, checkpoints, replacement, accounting and cleanup',
    async () => {
        const scenarios = [
            'atomic-mechanical',
            'bounded-single-module',
            'stateful-multi-file-checkpoint',
            'runtime-probe-recovery',
            'fresh-verification-after-replacement',
            'prescribed-ui-judgment',
            'long-context-checkpoint-reload'
        ].join(',')
        const fixture = await fixtureEnv({
            profiles: 'terra-low,terra-medium',
            scenarios
        })
        const policyBefore = fsSync.readFileSync(
            path.join(ROOT, 'policy/model-pool.json'), 'utf8'
        )
        const receipt = await runModelPoolQualification({
            env: fixture.env,
            invokeCodex: fakeCodex,
            prepareRuntimeHome: fakeRuntimeHome
        })
        assert.equal(receipt.status, 'complete')
        assert.equal(receipt.invocations.length, 20)
        assert.equal(receipt.scenarioResults.length, 14)
        assert.equal(receipt.accounting.totalTokens, 2000)
        assert.equal(receipt.automaticPolicyMutation, false)
        assert.equal(receipt.cleanup.existsAfterDelete, false)
        assert.equal(receipt.cleanup.resourcesAfter, 0)
        assert.deepEqual(verifyModelQualificationReceipt(receipt), {
            status: 'valid', receipt
        })
        assert.equal(fsSync.readFileSync(
            path.join(ROOT, 'policy/model-pool.json'), 'utf8'
        ), policyBefore)
        assert.deepEqual(JSON.parse(await fs.readFile(
            fixture.output, 'utf8'
        )), receipt)
        for (const scenarioId of scenarios.split(',')) {
            assert.equal(new Set(receipt.scenarioResults
                .filter((result) => result.scenarioId === scenarioId)
                .map((result) => result.frozenInputDigest)).size, 1)
        }
        const replacement = receipt.scenarioResults.find(({ scenarioId }) =>
            scenarioId === 'fresh-verification-after-replacement')
        assert.equal(replacement.replacement.kind,
            'runner-owned-candidate-replacement')
        assert.equal(receipt.invocations.some(({ freshContext }) =>
            freshContext === true), true)
        await fs.rm(fixture.root, { recursive: true, force: true })
    })

test('missing accounting fails closed, emits no complete receipt, and preserves evidence',
    async () => {
        const fixture = await fixtureEnv()
        await assert.rejects(runModelPoolQualification({
            env: fixture.env,
            prepareRuntimeHome: fakeRuntimeHome,
            invokeCodex: async ({ request }) => {
                await fs.writeFile(
                    path.join(request.cwd, 'src/constants.mjs'),
                    'export const RETRY_LIMIT = 4\n'
                )
                return {
                    elapsedMs: 1,
                    runtime: { model: request.model },
                    tools: { count: 0, names: [], callDigests: [] }
                }
            }
        }), { code: 'model-qualification-invocation-evidence-missing' })
        await assert.rejects(fs.stat(fixture.output), { code: 'ENOENT' })
        const failure = JSON.parse(await fs.readFile(
            `${fixture.output}.failed.json`, 'utf8'
        ))
        assert.equal(failure.status, 'failed')
        assert.equal(failure.completeReceiptEmitted, false)
        assert.equal(typeof failure.evidenceRoot, 'string')
        await fs.rm(failure.evidenceRoot, { recursive: true, force: true })
        await fs.rm(fixture.root, { recursive: true, force: true })
    })

test('registered tool evidence rejects remote, network, package and background commands', () => {
    const record = (input) => ({
        type: 'response_item',
        payload: {
            type: 'custom_tool_call',
            name: 'exec',
            input
        }
    })
    assert.throws(() => observeModelQualificationTools([
        record('{"cmd":"curl https://example.invalid"}')
    ]), { code: 'model-qualification-forbidden-tool-call' })
    assert.throws(() => observeModelQualificationTools([
        record('{"cmd":"git push origin main"}')
    ]), { code: 'model-qualification-forbidden-tool-call' })
    assert.equal(observeModelQualificationTools([
        record('{"cmd":"node --test tests/value.test.mjs"}')
    ]).count, 1)
})

test('observed usage beyond the reserved per-invocation budget fails closed',
    async () => {
        const fixture = await fixtureEnv()
        await assert.rejects(runModelPoolQualification({
            env: fixture.env,
            prepareRuntimeHome: fakeRuntimeHome,
            invokeCodex: async (input) => {
                const result = await fakeCodex(input)
                return {
                    ...result,
                    usage: {
                        inputTokens: 3000,
                        cachedInputTokens: 0,
                        outputTokens: 1,
                        totalTokens: 3001
                    }
                }
            }
        }), { code: 'model-qualification-observed-cap-exceeded' })
        const failure = JSON.parse(await fs.readFile(
            `${fixture.output}.failed.json`, 'utf8'
        ))
        await fs.rm(failure.evidenceRoot, { recursive: true, force: true })
        await fs.rm(fixture.root, { recursive: true, force: true })
    })

test('normal command invocation fails before Codex without the live controls', () => {
    const result = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts/model-pool-qualification.mjs')
    ], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
            !name.startsWith('ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_') &&
            name !== 'CI' && name !== 'GITHUB_ACTIONS'))
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr,
        /model-qualification-live-opt-in-required/u)
})
