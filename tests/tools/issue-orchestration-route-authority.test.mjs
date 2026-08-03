import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    validateExecutionRouteDecision,
    validateRouteBoundActor
} from '../../skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
    STAGE_ROUTE_DEFINITIONS
} from '../../skills/issue-orchestration/scripts/stage-profile-policy.mjs'
import {
    routeActorFor,
    routeDecisionFor,
    routeTestDigest
} from './issue-orchestration-route-test-helper.mjs'

const root = path.resolve(import.meta.dirname, '../..')

function reseal(value) {
    const copy = structuredClone(value)
    delete copy.routeDecisionDigest
    copy.routeDecisionDigest = routeTestDigest(copy)
    return copy
}

function expectCode(operation, code) {
    assert.throws(operation, (error) => error?.code === code)
}

test('canonical route authority accepts policy profiles used by downstream writers', () => {
    const stages = [
        'test-owner:test-contract-planning',
        'code-implementer:implementation'
    ]
    for (const stageKey of stages) {
        const definition = STAGE_ROUTE_DEFINITIONS[stageKey]
        const [stageRole, stagePhase] = stageKey.split(':')
        for (const selectedProfile of definition.allowedProfiles) {
            const actor = routeActorFor({
                stageRole,
                stagePhase,
                selectedProfile,
                proposalOnly:
                    definition.outputAuthority.endsWith('only'),
                suffix: `${stageKey}:${selectedProfile}`
            })
            assert.equal(validateRouteBoundActor({ actor }), actor)
        }
    }
})

test('root, semantic, planning, implementation, and Luna routes are accepted', () => {
    const cases = [
        ['root-scheduler', 'scheduling', 'terra-low'],
        ['dag-creator-updater', 'semantic-proposal', 'terra-high'],
        ['test-owner', 'test-contract-planning', 'luna-max'],
        ['code-implementer', 'implementation', 'luna-max']
    ]
    for (const [stageRole, stagePhase, selectedProfile] of cases) {
        assert.doesNotThrow(() => validateRouteBoundActor({
            actor: routeActorFor({
                stageRole,
                stagePhase,
                selectedProfile,
                proposalOnly: STAGE_ROUTE_DEFINITIONS[
                    `${stageRole}:${stagePhase}`
                ].outputAuthority.endsWith('only')
            })
        }))
    }
})

test('obsolete role aliases and non-policy profiles fail closed', () => {
    for (const role of ['dag-creator', 'dag-updater']) {
        const actor = routeActorFor({
            stageRole: 'dag-creator-updater',
            stagePhase: 'semantic-proposal',
            proposalOnly: true
        })
        actor.role = role
        actor.actorRole = role
        expectCode(
            () => validateRouteBoundActor({ actor }),
            'execution-route-decision-stage'
        )
    }
    const decision = routeDecisionFor({
        stageRole: 'code-implementer',
        stagePhase: 'implementation'
    })
    decision.selectedProfile = 'sol-low'
    decision.requestedModel = 'gpt-5.6-sol'
    decision.requestedEffort = 'low'
    expectCode(
        () => validateExecutionRouteDecision(reseal(decision)),
        'execution-route-decision-profile'
    )
})

test('route and actor binding mutations are rejected', () => {
    const base = routeActorFor({
        stageRole: 'test-owner',
        stagePhase: 'test-contract-planning',
        proposalOnly: true
    })
    const routeMutations = [
        ['role', (route) => { route.stageRole = 'code-implementer' }],
        ['phase', (route) => { route.stagePhase = 'test-contract' }],
        ['policy', (route) => { route.canonicalPolicyDigest = 'f'.repeat(64) }],
        ['cell', (route) => { route.routeCellDigest = 'e'.repeat(64) }],
        ['execution', (route) => { route.executionClass = 'leased-writer' }],
        ['capability', (route) => { route.capabilityValidationResult = 'rejected' }],
        ['runtime', (route) => { route.runtimeExecutionBindingDigest = null }],
        ['metadata', (route) => { route.requestedEffort = 'low' }]
    ]
    for (const [name, mutate] of routeMutations) {
        const actor = structuredClone(base)
        mutate(actor.routeDecision)
        actor.executionRouteDecision = actor.routeDecision
        actor.routeDecision = reseal(actor.routeDecision)
        actor.executionRouteDecision = actor.routeDecision
        actor.routeDecisionDigest = actor.routeDecision.routeDecisionDigest
        if (name === 'runtime') {
            actor.runtimeExecutionBindingDigest = null
        }
        assert.throws(
            () => validateRouteBoundActor({ actor }),
            undefined,
            name
        )
    }
    for (const [field, value] of [
        ['mutationContract', 'lease-and-slice-allowlist'],
        ['writeScope', 'implementation-only'],
        ['freshContext', false],
        ['proposalOnly', false],
        ['routeDecisionDigest', 'd'.repeat(64)]
    ]) {
        const actor = structuredClone(base)
        actor[field] = value
        assert.throws(
            () => validateRouteBoundActor({
                actor,
                proposalOnly: true
            }),
            undefined,
            field
        )
    }
})

test('downstream acceptance follows a changed installed policy fixture', () => {
    const temp = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-route-policy-'
    ))
    try {
        fs.cpSync(root, temp, {
            recursive: true,
            filter(source) {
                const relative = path.relative(root, source)
                return relative !== '.git' &&
                    !relative.split(path.sep).includes('node_modules')
            }
        })
        const policyPath = path.join(temp, 'policy/model-pool.json')
        const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
        policy.stages['test-owner:test-contract-planning']
            .allowedProfiles.push('terra-medium')
        fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`)
        const script = path.join(temp, 'route-policy-probe.mjs')
        fs.writeFileSync(script, `
import { createHash } from 'node:crypto'
import {
  EXECUTION_ROUTING_AUTHORITY,
  EXECUTION_ROUTING_POLICY,
  EXECUTION_ROUTING_POLICY_DIGEST,
  EXECUTION_ROUTING_POLICY_VERSION,
  REVIEWED_ROUTING_ASSUMPTIONS,
  validateExecutionRouteDecision
} from './skills/issue-orchestration/scripts/execution-route-compiler.mjs'
import {
  STAGE_MODEL_POOL_POLICY,
  STAGE_ROUTE_DEFINITIONS,
  splitProfile
} from './skills/issue-orchestration/scripts/stage-profile-policy.mjs'
const canonical = (v) => Array.isArray(v) ? v.map(canonical) :
  !v || typeof v !== 'object' ? v : Object.fromEntries(
    Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
const digest = (v) => createHash('sha256')
  .update(JSON.stringify(canonical(v))).digest('hex')
const stageRole = 'test-owner'
const stagePhase = 'test-contract-planning'
const selectedProfile = 'terra-medium'
const routeCellId = 'verification.focused-authoring'
const cell = EXECUTION_ROUTING_POLICY.routeCells[routeCellId]
const predicates = { stageRole, stagePhase, fixture: 'changed-policy' }
const profile = splitProfile(selectedProfile)
const route = {
  schema: 'issue-orchestration.execution-route-decision.v2',
  policyVersion: EXECUTION_ROUTING_POLICY_VERSION,
  modelPoolPolicyVersion: STAGE_MODEL_POOL_POLICY.version,
  routingAuthority: EXECUTION_ROUTING_AUTHORITY,
  sliceId: 'slice:changed-policy', sliceDigest: digest('slice'),
  stageRole, stagePhase, classificationDigest: digest('classification'),
  capabilityDigest: digest('capability'), routeCellId,
  routeCellDigest: digest({ routeCellId, cell }),
  selectingPredicates: predicates,
  selectingPredicatesDigest: digest(predicates),
  canonicalPolicyDigest: EXECUTION_ROUTING_POLICY_DIGEST,
  requiredProfile: selectedProfile,
  capabilityValidationResult: 'accepted',
  reviewedAssumptionDigest:
    REVIEWED_ROUTING_ASSUMPTIONS.profiles[selectedProfile].assumptionDigest,
  allowedProfiles: [...STAGE_ROUTE_DEFINITIONS[
    stageRole + ':' + stagePhase].allowedProfiles],
  selectedProfile, selectedProfileReason: 'changed-policy-fixture',
  requestedModel: profile.model, requestedEffort: profile.effort,
  multiAgentBackend:
    STAGE_MODEL_POOL_POLICY.profiles[selectedProfile].multiAgentBackend,
  executionClass: 'observe-only',
  runtimeExecutionBindingDigest: digest('runtime'),
  runtimeExecutionBindingStatus: 'verified',
  runtimeVerificationStatus: 'verified',
  runtimeInvocationId: 'runtime:changed-policy',
  runtimeIdentityDigest: digest('identity'),
  availabilityHandling: 'not-required', availabilityBindingDigest: null,
  availabilityFallbackReason: null, previousRouteDecisionDigest: null,
  previousFailureReceiptDigest: null, retryAuthorizationDigest: null,
  previousCandidateReceiptDigest: null
}
route.routeDecisionDigest = digest(route)
validateExecutionRouteDecision(route)
console.log('accepted')
`)
        const output = execFileSync(process.execPath, [script], {
            encoding: 'utf8'
        }).trim()
        assert.equal(output, 'accepted')
    } finally {
        fs.rmSync(temp, { recursive: true, force: true })
    }
})

test('production downstream validators contain no stale actor authority', () => {
    const scriptsRoot = path.join(
        root,
        'skills/issue-orchestration/scripts'
    )
    const allowedAuthorities = new Set([
        'stage-profile-policy.mjs',
        'execution-route-compiler.mjs',
        'codex-runtime-canary.mjs',
        'permanent-e2e.mjs'
    ])
    const validators = fs.readdirSync(scriptsRoot)
        .filter((name) => name.endsWith('.mjs'))
        .filter((name) => !allowedAuthorities.has(name))
    for (const name of validators) {
        const source = fs.readFileSync(
            path.join(scriptsRoot, name),
            'utf8'
        )
        assert.doesNotMatch(
            source,
            /['"]dag-(?:creator|updater)['"]/u,
            name
        )
        assert.doesNotMatch(
            source,
            /gpt-5\.6-(?:sol|terra|luna)/u,
            name
        )
        assert.doesNotMatch(
            source,
            /['"](?:terra|sol|luna)-(?:low|medium|high|max|xhigh)['"]/u,
            name
        )
    }
})
