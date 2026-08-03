import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    validateJsonSchema
} from '../../tools/test-matrix/schema-validator/validate.mjs'

const root = resolve(import.meta.dirname, '../..')
const fsusBlogRoot = process.env.FSUSBLOG_ROOT
    ? resolve(process.env.FSUSBLOG_ROOT)
    : resolve(root, '../FsusBlog')
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const contract = JSON.parse(readFileSync(resolve(
    fixtureRoot,
    'blog-ui-orchestration-contract.json'
), 'utf8'))
const controls = JSON.parse(readFileSync(resolve(
    fixtureRoot,
    'blog-ui-orchestration-negative-controls.json'
), 'utf8'))
const runtimePath = resolve(fsusBlogRoot, contract.implementationOwner)
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')

let loadedRuntime
async function runtime() {
    assert.equal(
        existsSync(runtimePath),
        true,
        `missing #1830 runtime: ${contract.implementationOwner}`
    )
    loadedRuntime ??= await import(pathToFileURL(runtimePath).href)
    for (const name of [
        'authorizeBlogUiRecovery',
        'createValidBlogUiBundle',
        'evaluateBlogUiCheckpoint',
        'mutateBlogUiBundle',
        'runBlogUiSelfCheck',
        'sealBlogUiAdjudication',
        'validateBlogUiBundle'
    ]) {
        assert.equal(typeof loadedRuntime[name], 'function', name)
    }
    return loadedRuntime
}

async function thrownCode(action, code) {
    await assert.rejects(
        async () => action(),
        (error) => error?.code === code,
        code
    )
}

test('B01 freezes the permanent Blog UI policy and strict receipt schemas', () => {
    assert.equal(contract.issue, 'Ozwasyd/FsusBlog#1830')
    assert.equal(controls.length, 18)
    assert.equal(new Set(controls.map(({ id }) => id)).size, 18)
    for (const relative of [
        contract.requiredPolicy,
        ...contract.requiredSchemas
    ]) {
        assert.equal(existsSync(resolve(fsusBlogRoot, relative)), true, relative)
    }
    const policy = JSON.parse(readFileSync(
        resolve(fsusBlogRoot, contract.requiredPolicy),
        'utf8'
    ))
    assert.equal(policy.schema, 'fsusblog-design-conformance.ui-stage-policy.v1')
    assert.deepEqual(policy.implementation.allowedProfiles, [
        'sol-low',
        'sol-medium'
    ])
    assert.deepEqual(policy.requiredSkillIds, [
        'fsusblog-design-conformance',
        'fsusui-design-conformance'
    ])
    assert.equal(policy.adjudication.sandbox, 'read-only')
    assert.equal(policy.uxAcceptance.freshContext, true)
    assert.deepEqual(policy.writerLeaseOrder, [
        'test-owner',
        'ui-ux-implementer',
        'documentation-writer'
    ])
    for (const relative of contract.requiredSchemas) {
        const schema = JSON.parse(readFileSync(
            resolve(fsusBlogRoot, relative),
            'utf8'
        ))
        assert.equal(schema.additionalProperties, false, relative)
        assert.equal(typeof schema.$id, 'string', relative)
        assert.ok(schema.required.includes('schema'), relative)
        assert.ok(schema.required.includes('receiptDigest') ||
            schema.required.includes('baselineDigest'), relative)
    }
})

test('B02 validates dual-Skill, active baseline, slice, route and candidate bindings', async () => {
    const module = await runtime()
    const bundle = module.createValidBlogUiBundle()
    const sealed = module.validateBlogUiBundle(bundle)
    assert.equal(sealed.dispatch.actualProfile, 'sol-low')
    assert.deepEqual(
        sealed.dispatch.requiredSkills.map(({ id }) => id),
        ['fsusblog-design-conformance', 'fsusui-design-conformance']
    )
    assert.equal(
        sealed.dispatch.fsusUIBaselineDigest,
        sealed.classification.fsusUIBaseline.baselineDigest
    )
    assert.equal(sealed.dispatch.candidateSha, bundle.classification.candidateSha)
    assert.equal(Object.isFrozen(sealed), true)
    for (const [key, relative] of [
        ['baseline', contract.requiredSchemas[0]],
        ['classification', contract.requiredSchemas[1]],
        ['dispatch', contract.requiredSchemas[2]],
        ['adjudication', contract.requiredSchemas[3]],
        ['uxAcceptance', contract.requiredSchemas[4]]
    ]) {
        const schema = JSON.parse(readFileSync(
            resolve(fsusBlogRoot, relative),
            'utf8'
        ))
        const errors = validateJsonSchema(sealed[key], schema)
        assert.deepEqual(errors, [], `${key}: ${errors.join(', ')}`)
    }
})

test('B03 routes bounded UI to low, judgment UI to medium, and stops long or disputed work', async () => {
    const module = await runtime()
    for (const [uiDecisionClass, executionShape, expected] of [
        ['prescribed', 'atomic-edit', 'sol-low'],
        ['bounded-composition', 'bounded-multifile', 'sol-low'],
        ['layout-judgment', 'iterative-debug', 'sol-medium'],
        ['interaction-judgment', 'render-probe-heavy', 'sol-medium']
    ]) {
        const sealed = module.validateBlogUiBundle(
            module.createValidBlogUiBundle({
                uiDecisionClass,
                executionShape
            })
        )
        assert.equal(sealed.dispatch.actualProfile, expected)
    }
    await thrownCode(
        () => module.validateBlogUiBundle(module.createValidBlogUiBundle({
            executionShape: 'long-horizon-cross-module'
        })),
        'blog-ui-reslice-required'
    )
    await thrownCode(
        () => module.validateBlogUiBundle(module.createValidBlogUiBundle({
            uiDecisionClass: 'system-design-dispute'
        })),
        'blog-ui-adjudication-required'
    )
})

test('B04 adjudication is fresh/read-only and distinguishes unique resolution from a verified human gate', async () => {
    const module = await runtime()
    const unique = module.createValidBlogUiBundle({
        uiDecisionClass: 'system-design-dispute',
        includeDispatch: false
    }).adjudication
    assert.equal(
        module.sealBlogUiAdjudication(unique).allowedImplementationClass,
        'sol-medium'
    )
    const human = module.createValidBlogUiBundle({
        uiDecisionClass: 'system-design-dispute',
        includeDispatch: false,
        adjudicationAuthorityState: 'multiple-valid-product-directions'
    }).adjudication
    const sealed = module.sealBlogUiAdjudication(human)
    assert.equal(sealed.uniqueResolutionAvailable, false)
    assert.match(sealed.humanDecisionRequestDigest, /^[a-f0-9]{64}$/u)
    assert.equal(sealed.requiredReslice, true)
})

test('B05 UX acceptance is fresh/read-only, candidate-bound and independent', async () => {
    const module = await runtime()
    for (const [verificationClass, expected] of [
        ['ux-local', 'sol-medium'],
        ['ux-path', 'sol-high'],
        ['ux-system', 'sol-xhigh']
    ]) {
        const sealed = module.validateBlogUiBundle(
            module.createValidBlogUiBundle({ verificationClass })
        )
        assert.equal(sealed.uxAcceptance.actualProfile, expected)
        assert.notEqual(
            sealed.uxAcceptance.implementationRunIdentityDigest,
            sealed.uxAcceptance.verifierRunIdentityDigest
        )
        assert.equal(sealed.uxAcceptance.modifiedPaths.length, 0)
        assert.ok(sealed.uxAcceptance.renderedArtifacts.length > 0)
    }
})

test('B06 checkpoint continuation and output-missing recovery require machine evidence and material change', async () => {
    const module = await runtime()
    const bundle = module.createValidBlogUiBundle()
    const checkpoint = module.evaluateBlogUiCheckpoint(bundle.checkpoint)
    assert.equal(checkpoint.status, 'partial')
    assert.equal(checkpoint.candidateGreen, false)
    const recovery = module.authorizeBlogUiRecovery(bundle.recovery)
    assert.equal(recovery.authorized, true)
    assert.match(recovery.authorizationDigest, /^[a-f0-9]{64}$/u)
    await thrownCode(
        () => module.authorizeBlogUiRecovery({
            ...bundle.recovery,
            currentObservableFingerprint:
                bundle.recovery.previousObservableFingerprint,
            changedInputs: ['agent-id']
        }),
        'blog-ui-recovery-not-material'
    )
})

test('B07 kills all 18 issue negative controls with stable reason codes', async () => {
    const module = await runtime()
    for (const control of controls) {
        await thrownCode(
            () => module.validateBlogUiBundle(
                module.mutateBlogUiBundle(
                    module.createValidBlogUiBundle(),
                    control.id
                )
            ),
            control.expectedCode
        )
    }
})

test('B08 Blog authority text binds UI impact, dual Skills, human handoff, leases and rendered evidence', () => {
    const agents = readFileSync(resolve(fsusBlogRoot, 'AGENTS.md'), 'utf8')
    const skill = readFileSync(resolve(
        fsusBlogRoot,
        '.agents/skills/fsusblog-design-conformance/SKILL.md'
    ), 'utf8')
    for (const required of [
        'uiDecisionClass',
        'verificationClass',
        'fsusblog-design-conformance',
        'fsusui-design-conformance',
        'Sol/low',
        'Sol/medium',
        'human-decision',
        'rendered evidence'
    ]) {
        assert.ok(`${agents}\n${skill}`.includes(required), required)
    }
})

test('B09 preserves #1828 and exposes one permanent checker', async () => {
    const resource = readFileSync(resolve(
        root,
        'skills/issue-orchestration/scripts/resource-lifecycle.mjs'
    ))
    assert.equal(
        createHash('sha256').update(resource).digest('hex'),
        contract.frozenResourceLifecycleSha256
    )
    const module = await runtime()
    const result = module.runBlogUiSelfCheck()
    assert.deepEqual(result, {
        schemas: 5,
        negativeControls: 18,
        policyDigest: hash(JSON.stringify(JSON.parse(readFileSync(
            resolve(fsusBlogRoot, contract.requiredPolicy),
            'utf8'
        ))))
    })
})
