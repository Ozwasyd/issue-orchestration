import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const agentRoot = path.join(root, 'agents')
const baseline = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/actor-instruction-baselines.json'
), 'utf8'))
const sections = [
    'Responsibility:',
    'Forbidden ownership:',
    'Envelope:',
    'Output:',
    'Stop:'
]
const roles = Object.freeze({
    'code-implementer': [
        'current non-UI implementation or landing-conflict slice',
        'test-contract-disputed'
    ],
    'dag-creator-updater': [
        'discovery and classification facts',
        'semantic proposal'
    ],
    'documentation-writer': [
        'current documentation slice',
        'genuine no-change result'
    ],
    'test-owner': [
        'plan the issue-specific test contract',
        'independently verify the frozen candidate',
        'test-contract-disputed'
    ],
    'ui-system-adjudicator': [
        'UI system-design dispute',
        'design authority'
    ],
    'ui-ux-implementer': [
        'current UI or landing-conflict slice',
        'ui-system-design-disputed'
    ],
    'ux-acceptance-verifier': [
        'interaction, render, and accessibility evidence',
        'implementer conversation'
    ]
})
const forbidden = [
    /stage-model-pool\.v/u,
    /\b(?:terra|sol|luna)-(?:low|medium|high|xhigh|max)\b/u,
    /gpt-5\./u,
    /executionClass/u,
    /\bwrite lease\b/iu,
    /mutation postcondition/iu,
    /stage-work-plan/u,
    /executable-slice/u,
    /compiled-dispatch-prompt/u,
    /firstRequiredAction/u,
    /firstReadTargets/u,
    /firstWritablePath/u,
    /explicitReadOnlyOutput/u,
    /stage-progress-checkpoint/u,
    /checkpoint-verification/u,
    /stage-continuation/u,
    /slice-terminal/u,
    /writer-stage-failure/u,
    /\breceipt\b/iu
]

function instructions(role) {
    const source = fs.readFileSync(path.join(agentRoot, `${role}.toml`), 'utf8')
    const match = source.match(/developer_instructions\s*=\s*"""\n([\s\S]*?)\n"""/u)
    assert.ok(match, `developer-instructions-missing:${role}`)
    return match[1]
}

function estimatedTokens(value) {
    return Math.ceil(Buffer.byteLength(value, 'utf8') / 4)
}

test('all seven actor instructions use the concise envelope contract', () => {
    assert.deepEqual(Object.keys(roles).sort(),
        fs.readdirSync(agentRoot)
            .filter((name) => name.endsWith('.toml'))
            .map((name) => name.slice(0, -5))
            .sort())
    for (const [role, required] of Object.entries(roles)) {
        const value = instructions(role)
        let previous = -1
        for (const section of sections) {
            assert.equal(value.split(section).length - 1, 1,
                `actor-instruction-section-count:${role}:${section}`)
            const current = value.indexOf(section)
            assert.ok(current > previous,
                `actor-instruction-section-order:${role}:${section}`)
            previous = current
        }
        assert.match(value,
            /issue-orchestration\.actor-context-envelope\.v1/u)
        assert.match(value, /outputInterface/u)
        assert.match(value, /failureVocabulary/u)
        for (const fragment of required) {
            assert.ok(value.includes(fragment),
                `actor-instruction-role-boundary:${role}:${fragment}`)
        }
        for (const pattern of forbidden) {
            assert.doesNotMatch(value, pattern,
                `actor-instruction-machine-policy-copy:${role}:${pattern}`)
        }
    }
})

test('every role has a material measured instruction reduction', () => {
    assert.equal(baseline.schema,
        'issue-orchestration.actor-instruction-baselines.v1')
    const measurements = {}
    for (const role of Object.keys(roles)) {
        const value = instructions(role)
        const bytes = Buffer.byteLength(value, 'utf8')
        const tokens = estimatedTokens(value)
        const prior = baseline.roles[role]
        assert.ok(bytes <= Math.floor(prior.instructionBytes * 0.82),
            `actor-instruction-byte-reduction:${role}:${bytes}`)
        assert.ok(tokens <= Math.floor(prior.estimatedTokens * 0.82),
            `actor-instruction-token-reduction:${role}:${tokens}`)
        measurements[role] = { bytes, estimatedTokens: tokens }
    }
    assert.equal(Object.keys(measurements).length, 7)
})

test('removed model prose remains enforced by deterministic production owners', () => {
    const owners = {
        route: [
            'skills/issue-orchestration/scripts/execution-route-compiler.mjs',
            /export function validateRouteBoundActor/u
        ],
        mutation: [
            'skills/issue-orchestration/scripts/stage-runtime-guard.mjs',
            /export function evaluateStageMutationPostcondition/u
        ],
        checkpoint: [
            'skills/issue-orchestration/scripts/writer-stage-progress.mjs',
            /export function validateWriterStageCheckpointEvidence/u
        ],
        continuation: [
            'skills/issue-orchestration/scripts/writer-stage-progress.mjs',
            /export function compileVerifiedWriterStageContinuation/u
        ],
        terminal: [
            'skills/issue-orchestration/scripts/writer-stage-progress.mjs',
            /export function evaluateSliceTerminalGate/u
        ],
        envelope: [
            'skills/issue-orchestration/scripts/actor-context-envelope.mjs',
            /export function validateActorContextEnvelope/u
        ]
    }
    for (const [owner, [relative, pattern]] of Object.entries(owners)) {
        const source = fs.readFileSync(path.join(root, relative), 'utf8')
        assert.match(source, pattern, `actor-instruction-owner-missing:${owner}`)
    }
})

test('model-visible Skill and stage prompt expose no broad compatibility path', () => {
    const skill = fs.readFileSync(path.join(
        root,
        'skills/issue-orchestration/SKILL.md'
    ), 'utf8')
    assert.match(skill, /actor context envelope/u)
    assert.match(skill, /不接收完整 issue、Root 手写任务或旧 broad-prompt 格式/u)
    const compiler = fs.readFileSync(path.join(
        root,
        'skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
    ), 'utf8')
    assert.match(compiler,
        /Consume the stage-specific actor context envelope/u)
    assert.match(compiler, /Return only the typed output interface/u)
    assert.doesNotMatch(compiler, /Stop with a machine-verifiable checkpoint/u)
    assert.doesNotMatch(compiler, /Before returning, verify filesystem paths/u)
})
