import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
    compileRuntimeTrustBinding
} from '../../skills/issue-orchestration/scripts/runtime-trust-policy.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'
import {
    createTrustedRepositoryFixture
} from './issue-orchestration-trusted-repository-test-helper.mjs'

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
)
const packageRoot = path.join(
    root,
    '.'
)
const scriptsRoot = path.join(
    packageRoot,
    'skills/issue-orchestration/scripts'
)
const repositoryRoot = createTrustedRepositoryFixture()
const contract = JSON.parse(fs.readFileSync(path.join(
    root,
    'tests/fixtures/issue-orchestration/issues-1877-1887-contract.json'
), 'utf8'))
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}
const digest = (value) => createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const HASH = /^[a-f0-9]{64}$/u
const clone = structuredClone
const runtimeStartup = verifiedRuntimeStartup({})
const modelPoolPolicyDigest =
    runtimeStartup.observation.policyDigests.modelPool
const importRuntime = (issue) => import(pathToFileURL(path.join(
    packageRoot,
    contract.issues[String(issue)].runtimeOwner
)).href)

test('A00 freezes every #1877-#1887 runtime owner, schema and mutation set', () => {
    assert.equal(
        contract.schema,
        'issue-orchestration.fixed-scope-test-contract.v1'
    )
    assert.deepEqual(
        Object.keys(contract.issues).map(Number),
        [1877, 1878, 1879, 1880, 1881, 1882, 1883, 1884, 1885, 1886, 1887]
    )
    for (const [issue, entry] of Object.entries(contract.issues)) {
        assert.ok(entry.negativeControls.length >= 8, issue)
        assert.equal(
            new Set(entry.negativeControls).size,
            entry.negativeControls.length,
            issue
        )
        assert.equal(
            fs.existsSync(path.join(packageRoot, entry.runtimeOwner)),
            true,
            `${issue} runtime owner`
        )
        for (const schemaFile of entry.schemas) {
            const schema = JSON.parse(fs.readFileSync(path.join(
                packageRoot,
                'contracts',
                schemaFile
            ), 'utf8'))
            assert.match(schema.title, /^issue-orchestration\./u)
            assert.equal(schema.properties.schema.const, schema.title)
        }
    }
})

function runtimeMetadata(profile = 'terra-low') {
    const [family, effort] = profile.split('-')
    return {
        selectedProfile: profile,
        requestedModel: `gpt-5.6-${family}`,
        effectiveModel: `gpt-5.6-${family}`,
        requestedEffort: effort,
        effectiveEffort: effort,
        multiAgentBackend: 'v2',
        role: profile.startsWith('terra-')
            ? 'root-scheduler'
            : 'code-implementer',
        approvalPolicy: 'never',
        effectivePermissionProfile: 'danger-full-access',
        permissionProfileObserved: true,
        cwd: '/fixture',
        observable: true,
        observationDigest: digest({ profile })
    }
}

function rootRuntimeTrust(startup = runtimeStartup) {
    const repositoryTargets = [{
        repository: 'ExampleOrg/RepositoryA',
        repositoryPath: repositoryRoot
    }]
    return {
        repositoryTargets,
        runtimeTrustBinding: compileRuntimeTrustBinding({
            role: 'root-scheduler',
            executionClass: 'root-control',
            runtimeId: 'codex',
            multiAgentBackend: 'v2',
            approvalPolicy: 'never',
            effectivePermissionProfile: 'danger-full-access',
            permissionProfileObserved: true,
            repositoryTargets,
            startup
        })
    }
}

function route({
    role = 'code-implementer',
    phase = 'implementation',
    profile = 'terra-medium',
    sliceDigest = digest('slice'),
    authority = 'canonical-route-cell-compiler'
} = {}) {
    const [family, effort] = profile.split('-')
    const executionClass = role === 'root-scheduler'
        ? 'root-control'
        : [
                'dag-creator-updater',
                'ui-system-adjudicator',
                'ux-acceptance-verifier'
            ].includes(role) ||
            role === 'test-owner' &&
                phase !== 'test-contract'
            ? 'observe-only'
            : 'leased-writer'
    const routeCellId = {
        'root-scheduler:scheduling': 'control.normal',
        'dag-creator-updater:semantic-proposal': 'dag.semantic-default',
        'test-owner:test-contract-planning':
            'verification.narrow-complex',
        'test-owner:test-contract': 'verification.focused-authoring',
        'code-implementer:implementation':
            'implementation.ordinary-bounded-single-module'
    }[`${role}:${phase}`] ?? 'implementation.ordinary-bounded-single-module'
    const value = {
        schema: 'issue-orchestration.execution-route-decision.v2',
        policyVersion: 'execution-capability-routing.v4',
        modelPoolPolicyVersion: 'stage-model-pool.v3',
        modelPoolPolicyDigest,
        routingAuthority: authority,
        stageRole: role,
        stagePhase: phase,
        sliceDigest,
        routeCellId,
        canonicalPolicyDigest: digest('canonical-policy-v4'),
        requiredProfile: profile,
        capabilityValidationResult: 'accepted',
        availabilityHandling: 'exact-required-profile',
        selectedProfile: profile,
        requestedModel: `gpt-5.6-${family}`,
        requestedEffort: effort,
        multiAgentBackend: 'v2',
        executionClass,
        mutationContract: {
            'root-control': 'control-plane-and-delivery-gated',
            'observe-only': 'no-protected-mutation',
            'leased-writer': 'lease-and-slice-allowlist'
        }[executionClass],
        runtimeExecutionBindingDigest:
            digest('runtime-execution-binding'),
        runtimeExecutionBindingStatus: 'verified',
        runtimeVerificationStatus: 'verified'
    }
    value.routeDecisionDigest = digest(value)
    return value
}

function gateFixture() {
    const members = ['ExampleOrg/RepositoryA#1877', 'ExampleOrg/RepositoryA#1878']
        .map((memberId, index) => {
            const sliceDigest = digest(`slice-${index}`)
            const selectedRoute = route({ sliceDigest })
            const receipt = (kind) => ({
                schema: `issue-orchestration.${kind}-receipt.v3`,
                memberId,
                candidateDigest: digest(`candidate-${index}`),
                receiptDigest: digest(`${kind}-${index}`)
            })
            return {
                memberId,
                repository: 'ExampleOrg/RepositoryA',
                issueNumber: 1877 + index,
                stageState: 'active',
                stageRole: 'code-implementer',
                stagePhase: 'implementation',
                acceptanceContractDigest: digest(`acceptance-${index}`),
                testContractDigest: digest(`test-${index}`),
                planDigest: digest(`plan-${index}`),
                sliceDigest,
                promptDigest: digest(`prompt-${index}`),
                routeDecision: selectedRoute,
                runtimeMetadata: {
                    ...runtimeMetadata('terra-medium'),
                    role: 'code-implementer',
                    sandbox: 'workspace-write'
                },
                receipts: {
                    candidate: receipt('candidate'),
                    behavior: receipt('behavior')
                },
                resourceOwnership: {
                    groupSessionId: `group-${index}`,
                    slotId: `slot-${index}`,
                    resourceRegistryDigest: digest(`resources-${index}`),
                    writeLease: {
                        leaseId: `lease-${index}`,
                        ownerMemberId: memberId,
                        active: true,
                        leaseDigest: digest(`lease-${index}`)
                    }
                },
                disposition: 'active'
            }
        })
    const value = {
        schema: 'issue-orchestration.dag-startup-gate-request.v2',
        selectorReceipt: {
            schema: 'issue-orchestration.scope-selector-receipt.v1',
            remoteSnapshotDigest: digest('remote'),
            receiptDigest: digest('selector'),
            startupAttestationDigest:
                runtimeStartup.attestation.attestationDigest,
            runtimeInvocationId:
                runtimeStartup.attestation.runtimeInvocationId
        },
        dag: {
            schema: 'issue-orchestration.semantic-graph.v2',
            policyDigest: modelPoolPolicyDigest,
            nodes: members
        },
        startup: runtimeStartup,
        ...rootRuntimeTrust(),
        legacyFallbackEnabled: false,
        authoritySource: 'permanent-shared-package'
    }
    return value
}

test('A77-01 validates two independent member projections without a global chain', async () => {
    const { validateDagStartupGateV2 } = await importRuntime(1877)
    const receipt = validateDagStartupGateV2(gateFixture())
    assert.equal(receipt.status, 'verified')
    assert.equal(receipt.memberCount, 2)
    assert.equal(receipt.rootProfile, 'terra-low')
    assert.equal(receipt.legacyGlobalReceiptAuthority, false)
    assert.match(receipt.receiptDigest, HASH)
})

test('A77-02 rejects all frozen startup-gate mutation classes', async () => {
    const { validateDagStartupGateV2 } = await importRuntime(1877)
    const mutations = [
        ['cross-member-behavior-receipt', (v) => {
            v.dag.nodes[1].receipts.behavior =
                clone(v.dag.nodes[0].receipts.behavior)
        }, 'dag-gate-member-receipt-binding'],
        ['group-summary-for-member', (v) => {
            delete v.dag.nodes[0].receipts.behavior
            v.dag.nodes[0].groupSummary = { status: 'green' }
        }, 'dag-gate-member-receipt-missing'],
        ['legacy-global-stage-receipts', (v) => {
            v.dag.stageReceipts = { behavior: {} }
        }, 'dag-gate-legacy-authority'],
        ['node-model-effort-authority', (v) => {
            v.dag.nodes[0].model = 'gpt-5.6-sol'
        }, 'dag-gate-legacy-authority'],
        ['rework-profile-promotion', (v) => {
            v.dag.nodes[0].reworkCount = 3
        }, 'dag-gate-legacy-authority'],
        ['stale-route-identity', (v) => {
            v.dag.nodes[0].routeDecision.sliceDigest = digest('stale')
        }, 'dag-gate-route-binding'],
        ['writer-without-unique-lease', (v) => {
            v.dag.nodes[0].resourceOwnership.writeLease = null
        }, 'dag-gate-writer-lease'],
        ['invalid-completed-tombstone', (v) => {
            v.dag.nodes[0].stageState = 'completed'
            v.dag.nodes[0].completedTombstone = {
                stateReason: 'not-planned',
                commitAncestryVerified: false
            }
        }, 'dag-gate-completed-tombstone'],
        ['forbidden-profile-or-backend', (v) => {
            v.dag.nodes[0].routeDecision.selectedProfile = 'sol-ultra'
            v.dag.nodes[0].routeDecision.requiredProfile = 'sol-ultra'
        }, 'dag-gate-profile'],
        ['medium-root-without-recovery', (v) => {
            v.rootRuntime = {
                controlPlaneRecovery: true,
                metadata: runtimeMetadata('terra-medium')
            }
        }, 'dag-gate-legacy-root-runtime'],
        ['temporary-scheduler-authority', (v) => {
            v.dag.nodes[0].routeDecision.routingAuthority =
                'temporary-scheduler'
        }, 'dag-gate-route-authority'],
        ['legacy-gate-fallback', (v) => {
            v.legacyFallbackEnabled = true
        }, 'dag-gate-legacy-fallback']
    ]
    assert.deepEqual(
        mutations.map(([id]) => id),
        contract.issues['1877'].negativeControls
    )
    for (const [, mutate, code] of mutations) {
        const value = gateFixture()
        mutate(value)
        assert.throws(() => validateDagStartupGateV2(value), { code })
    }
})

function requirementSnapshot() {
    return {
        repository: 'ExampleOrg/RepositoryA',
        issueNumber: 1878,
        selectorReceiptDigest: digest('selector'),
        remoteSnapshotDigest: digest('remote'),
        updatedAt: '2026-08-02T00:00:00Z',
        normativeBlocks: [
            {
                sourceIdentity: 'body:acceptance:1',
                sourceKind: 'body',
                spanDigest: digest('body-a1'),
                normative: true
            },
            {
                sourceIdentity: 'body:constraint:1',
                sourceKind: 'body',
                spanDigest: digest('body-c1'),
                normative: true
            },
            {
                sourceIdentity: 'body:non-goal:1',
                sourceKind: 'body',
                spanDigest: digest('body-ng1'),
                normative: true
            },
            {
                sourceIdentity: 'comment:41:acceptance:1',
                sourceKind: 'comment',
                commentId: 41,
                relevantToCorrectness: true,
                spanDigest: digest('comment-a1'),
                normative: true
            }
        ],
        discussionBlocks: [{
            sourceIdentity: 'comment:42:discussion:1',
            commentId: 42,
            relevantToCorrectness: false,
            spanDigest: digest('discussion')
        }]
    }
}

function requirementProposal(snapshot = requirementSnapshot()) {
    const classifications = [
        ['body:acceptance:1', 'acceptance'],
        ['body:constraint:1', 'constraint'],
        ['body:non-goal:1', 'non-goal'],
        ['comment:41:acceptance:1', 'acceptance']
    ].map(([sourceIdentity, classification]) => ({
        sourceIdentity,
        sourceSpanDigest: snapshot.normativeBlocks.find(
            (block) => block.sourceIdentity === sourceIdentity
        ).spanDigest,
        classification,
        ownerRepository: 'ExampleOrg/RepositoryA',
        affectedStageClasses: ['test-contract', 'implementation']
    }))
    const value = {
        schema:
            'issue-orchestration.issue-requirement-inventory-proposal.v1',
        actorRole: 'dag-creator-updater',
        rootAuthored: false,
        repository: snapshot.repository,
        issueNumber: snapshot.issueNumber,
        selectorReceiptDigest: snapshot.selectorReceiptDigest,
        remoteSnapshotDigest: snapshot.remoteSnapshotDigest,
        classifications
    }
    value.proposalDigest = digest(value)
    return value
}

test('A78-01 compiles an exact, source-bound immutable acceptance contract', async () => {
    const {
        compileIssueAcceptanceContract,
        compileRequirementInventory,
        validateWorkPlanAcceptanceContract
    } = await importRuntime(1878)
    const snapshot = requirementSnapshot()
    const proposal = requirementProposal(snapshot)
    const inventory = compileRequirementInventory({
        snapshot,
        proposal,
        rootDecision: {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        }
    })
    assert.equal(inventory.status, 'verified')
    assert.equal(inventory.requirements.length, 4)
    assert.equal(new Set(inventory.requirements.map(
        ({ requirementId }) => requirementId
    )).size, 4)
    const acceptance = compileIssueAcceptanceContract({ snapshot, inventory })
    assert.equal(acceptance.status, 'frozen')
    assert.equal(acceptance.executableAcceptanceIds.length, 2)
    assert.equal(acceptance.constraintIds.length, 1)
    assert.equal(acceptance.nonGoalIds.length, 1)
    assert.equal(validateWorkPlanAcceptanceContract({
        acceptanceContract: acceptance,
        workPlan: {
            acceptanceItems: [...acceptance.executableAcceptanceIds],
            constraintIds: [...acceptance.constraintIds],
            nonGoalIds: [...acceptance.nonGoalIds]
        }
    }).status, 'verified')
})

test('A78-02 fails closed on omitted, duplicated, drifted or modified authority', async () => {
    const { compileRequirementInventory } = await importRuntime(1878)
    const cases = [
        ['missing-normative-block', ({ proposal }) => {
            proposal.classifications.pop()
        }, 'requirement-source-coverage'],
        ['normative-context-without-reason', ({ proposal }) => {
            proposal.classifications[0].classification = 'context'
        }, 'requirement-normative-context'],
        ['root-modified-proposal', ({ rootDecision }) => {
            rootDecision.modified = true
        }, 'requirement-root-modification'],
        ['relevant-comment-drift', ({ snapshot }) => {
            snapshot.normativeBlocks[3].spanDigest = digest('edited')
        }, 'requirement-proposal-drift'],
        ['implicit-authority-choice', ({ proposal }) => {
            proposal.classifications[0].classification =
                'authority-choice-required'
        }, 'requirement-authority-choice']
    ]
    for (const [, mutate, code] of cases) {
        const snapshot = requirementSnapshot()
        const proposal = requirementProposal(snapshot)
        const rootDecision = {
            action: 'accept',
            proposalDigest: proposal.proposalDigest,
            modified: false
        }
        mutate({ snapshot, proposal, rootDecision })
        assert.throws(
            () => compileRequirementInventory({
                snapshot,
                proposal,
                rootDecision
            }),
            { code }
        )
    }
})

test('A78-03 requires exact work-plan acceptance and ignores discussion-only drift', async () => {
    const {
        compileIssueAcceptanceContract,
        compileRequirementInventory,
        validateWorkPlanAcceptanceContract
    } = await importRuntime(1878)
    const compile = (snapshot) => {
        const proposal = requirementProposal(snapshot)
        const inventory = compileRequirementInventory({
            snapshot,
            proposal,
            rootDecision: {
                action: 'accept',
                proposalDigest: proposal.proposalDigest,
                modified: false
            }
        })
        return compileIssueAcceptanceContract({ snapshot, inventory })
    }
    const first = compile(requirementSnapshot())
    const changed = requirementSnapshot()
    changed.discussionBlocks[0].spanDigest = digest('new discussion')
    const second = compile(changed)
    assert.equal(first.contractDigest, second.contractDigest)
    for (const acceptanceItems of [
        first.executableAcceptanceIds.slice(1),
        [...first.executableAcceptanceIds, 'unbound']
    ]) {
        assert.throws(() => validateWorkPlanAcceptanceContract({
            acceptanceContract: first,
            workPlan: {
                acceptanceItems,
                constraintIds: first.constraintIds,
                nonGoalIds: first.nonGoalIds
            }
        }), { code: 'acceptance-contract-exactness' })
    }
})

function acceptanceContract() {
    const value = {
        schema: 'issue-orchestration.issue-acceptance-contract.v1',
        repository: 'ExampleOrg/RepositoryA',
        issueNumber: 1879,
        selectorReceiptDigest: digest('selector'),
        remoteSnapshotDigest: digest('remote'),
        executableAcceptanceIds: ['REQ-a', 'REQ-b'],
        constraintIds: ['REQ-c'],
        nonGoalIds: ['REQ-ng'],
        status: 'frozen'
    }
    value.contractDigest = digest(value)
    return value
}

function planningReceipt() {
    const value = {
        schema: 'issue-orchestration.test-contract-plan-receipt.v1',
        status: 'verified',
        actorRole: 'test-owner',
        phase: 'test-contract-planning',
        rootAuthored: false,
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        freshContext: true,
        attemptId: 'planning-attempt-1',
        acceptanceContractDigest: acceptanceContract().contractDigest,
        runtimeExecutionBindingDigest:
            digest('runtime-execution-binding'),
        mutationPostconditionReceiptDigest:
            digest('planning-postcondition'),
        ownerRepository: 'ExampleOrg/RepositoryA',
        testPaths: ['tests/tools/issue-1879.test.mjs'],
        commands: ['node --test tests/tools/issue-1879.test.mjs'],
        fixturePaths: [],
        runtimeProbes: [],
        stageBoundaries: ['tests-only'],
        sliceProposalDigest: digest('slice-proposal'),
        filesystemWrites: [],
        disputedAuthority: null
    }
    value.receiptDigest = digest(value)
    return value
}

test('A79-01 advances a new issue through distinct planning and writer attempts', async () => {
    const {
        compileTestContractPlanningRequest,
        compileTestContractWriterDispatch,
        verifyTestContractPlanReceipt
    } = await importRuntime(1879)
    const acceptance = acceptanceContract()
    const request = compileTestContractPlanningRequest({
        nodeDiscoveredReceipt: {
            schema: 'issue-orchestration.node-discovered-receipt.v1',
            repository: acceptance.repository,
            issueNumber: acceptance.issueNumber,
            receiptDigest: digest('discovered')
        },
        acceptanceContract: acceptance,
        routeDecision: route({
            role: 'test-owner',
            phase: 'test-contract-planning',
            profile: 'terra-high'
        }),
        attemptId: 'planning-attempt-1'
    })
    assert.equal(request.phase, 'test-contract-planning')
    assert.equal(request.executionClass, 'observe-only')
    const plan = verifyTestContractPlanReceipt({
        receipt: planningReceipt(),
        request
    })
    const dispatch = compileTestContractWriterDispatch({
        acceptanceContract: acceptance,
        planningReceipt: plan,
        routeDecision: route({
            role: 'test-owner',
            phase: 'test-contract',
            profile: 'terra-medium'
        }),
        writerAttemptId: 'writer-attempt-1',
        resourceReceipt: {
            status: 'acquired',
            leaseId: 'lease-1',
            receiptDigest: digest('resource')
        },
        compiledPlanDigest: digest('compiled-plan'),
        executableSliceDigest: digest('slice'),
        compiledPromptDigest: digest('prompt')
    })
    assert.equal(dispatch.status, 'dispatch-authorized')
    assert.notEqual(dispatch.planningAttemptId, dispatch.writerAttemptId)
    assert.equal(dispatch.executionClass, 'leased-writer')
})

test('A79-02 rejects fabricated history, Root authority and cold-start loops', async () => {
    const {
        compileTestContractPlanningRequest,
        compileTestContractWriterDispatch,
        verifyTestContractPlanReceipt
    } = await importRuntime(1879)
    assert.throws(() => compileTestContractPlanningRequest({
        acceptanceContract: acceptanceContract(),
        routeDecision: route({
            role: 'test-owner',
            phase: 'test-contract-planning',
            profile: 'terra-high'
        }),
        attemptId: 'planning'
    }), { code: 'test-planning-node-discovered' })
    const receipt = planningReceipt()
    receipt.rootAuthored = true
    assert.throws(() => verifyTestContractPlanReceipt({
        receipt,
        request: {
            acceptanceContractDigest:
                acceptanceContract().contractDigest,
            attemptId: 'planning-attempt-1',
            runtimeExecutionBindingDigest:
                digest('runtime-execution-binding')
        }
    }), { code: 'test-planning-authority' })
    assert.throws(() => compileTestContractWriterDispatch({
        acceptanceContract: acceptanceContract(),
        planningReceipt: planningReceipt(),
        preexistingFrozenContract: { fabricated: true }
    }), { code: 'test-contract-cold-start-fabricated-history' })
})

test('A79-03 recovery reuses durable planning and skips planning for frozen contracts', async () => {
    const { recoverTestContractColdStart } = await importRuntime(1879)
    const plan = planningReceipt()
    assert.deepEqual(recoverTestContractColdStart({
        planningReceipt: plan,
        frozenTestContract: null
    }), {
        action: 'resume-writer-dispatch',
        planningReceiptDigest: plan.receiptDigest
    })
    assert.deepEqual(recoverTestContractColdStart({
        planningReceipt: plan,
        frozenTestContract: {
            status: 'frozen',
            contractDigest: digest('frozen')
        }
    }), {
        action: 'resume-after-frozen-contract',
        frozenContractDigest: digest('frozen')
    })
})

function sliceProposal() {
    const acceptance = acceptanceContract()
    const value = {
        schema: 'issue-orchestration.slice-plan-proposal.v1',
        proposalAuthoredBy: 'test-owner:test-contract-planning',
        rootAuthored: false,
        acceptanceContractDigest: acceptance.contractDigest,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        objective: 'Implement bounded runtime authority',
        allowedPaths: ['src/a.mjs', 'src/b.mjs'],
        forbiddenPaths: ['tests/'],
        requiredCommands: ['node --check src/a.mjs'],
        requiredEvidence: ['command:node-check'],
        orderedSlices: [
            {
                sliceId: 'slice-a',
                objective: 'Implement the first bounded module',
                acceptanceIds: ['REQ-a'],
                allowedPaths: ['src/a.mjs'],
                requiredCommands: ['node --check src/a.mjs'],
                requiredEvidence: ['command:node-check'],
                firstRequiredAction: 'write:src/a.mjs',
                maxChangedFiles: 1,
                maxOwnedModules: 1
            },
            {
                sliceId: 'slice-b',
                objective: 'Integrate the second bounded module',
                acceptanceIds: ['REQ-b'],
                allowedPaths: ['src/b.mjs'],
                requiredCommands: [],
                requiredEvidence: [],
                firstRequiredAction: 'write:src/b.mjs',
                maxChangedFiles: 1,
                maxOwnedModules: 1
            }
        ],
        sliceDependencyGraph: {
            'slice-a': [],
            'slice-b': ['slice-a']
        },
        actorRuntime: {
            role: 'test-owner',
            phase: 'test-contract-planning',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation',
            routeDecisionDigest: digest('planning-route'),
            runtimeExecutionBindingDigest:
                digest('planning-runtime-binding'),
            mutationPostconditionReceiptDigest:
                digest('planning-postcondition')
        }
    }
    value.proposalDigest = digest(value)
    return { acceptance, proposal: value }
}

test('A80-01 validates semantic proposals without claiming machine authorship', async () => {
    const {
        compileSlicePlanValidation,
        verifySlicePlanValidation
    } = await importRuntime(1880)
    const { acceptance, proposal } = sliceProposal()
    const receipt = compileSlicePlanValidation({
        acceptanceContract: acceptance,
        proposal
    })
    assert.equal(
        receipt.proposalAuthoredBy,
        'test-owner:test-contract-planning'
    )
    assert.equal(receipt.validatedBy, 'deterministic-slice-validator.v2')
    assert.equal(receipt.generatedByValidator, false)
    assert.equal(receipt.acceptanceOwnerMap['REQ-a'], 'slice-a')
    assert.equal(receipt.acceptanceOwnerMap['REQ-b'], 'slice-b')
    assert.equal(verifySlicePlanValidation({
        acceptanceContract: acceptance,
        proposal,
        receipt
    }).status, 'verified')
})

test('A80-02 rejects omitted, duplicate, whole-issue and mutable proposals', async () => {
    const { compileSlicePlanValidation } = await importRuntime(1880)
    const cases = [
        [(v) => v.proposal.orderedSlices[1].acceptanceIds = [],
            'slice-proposal-acceptance-exactness'],
        [(v) => v.proposal.orderedSlices[1].acceptanceIds = ['REQ-a'],
            'slice-proposal-acceptance-owner'],
        [(v) => v.proposal.rootAuthored = true,
            'slice-proposal-authority'],
        [(v) => v.proposal.orderedSlices[0].firstRequiredAction =
            'inspect repository', 'slice-proposal-first-action'],
        [(v) => v.proposal.orderedSlices[0].acceptanceIds = ['REQ-a', 'REQ-b'],
            'slice-proposal-whole-issue']
    ]
    for (const [mutate, code] of cases) {
        const value = sliceProposal()
        mutate(value)
        assert.throws(
            () => compileSlicePlanValidation({
                acceptanceContract: value.acceptance,
                proposal: value.proposal
            }),
            { code }
        )
    }
})

function dispatchProjection() {
    const value = {
        schema:
            'issue-orchestration.dispatch-investigation-projection.v1',
        repository: 'ExampleOrg/RepositoryA',
        issueNumber: 1881,
        sourceFingerprint: digest('source-fingerprint'),
        semanticReceiptDigest: digest('semantic'),
        acceptanceContractDigest: digest('acceptance'),
        testPlanningReceiptDigest: digest('planning'),
        sliceValidationReceiptDigest: digest('slice-validation'),
        uiAdjudicationReceiptDigest: null,
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        allowedPaths: ['src/a.mjs'],
        requiredCommands: ['node --check src/a.mjs'],
        acceptanceIds: ['REQ-a'],
        selectedSliceId: 'slice-a',
        selectedSliceDigest: digest('slice-a'),
        compiledPromptDigest: digest('prompt'),
        nextActions: [{
            action: 'dispatch-ready-slice',
            sliceId: 'slice-a',
            sliceDigest: digest('slice-a')
        }],
        fullIssueBodyIncluded: false,
        fullDagIncluded: false,
        stateRootIncluded: false
    }
    value.projectionDigest = digest(value)
    return value
}

test('A81-01 limits terra-low Root to recomputable mechanical actions', async () => {
    const {
        compileRootControlAction,
        validateDispatchInvestigationProjection
    } = await importRuntime(1881)
    const projection = dispatchProjection()
    validateDispatchInvestigationProjection(projection)
    const receipt = compileRootControlAction({
        projection,
        startup: runtimeStartup,
        ...rootRuntimeTrust(),
        requestedAction: {
            action: 'dispatch-ready-slice',
            sliceId: 'slice-a',
            sliceDigest: digest('slice-a')
        }
    })
    assert.equal(receipt.status, 'authorized')
    assert.equal(receipt.rootProfile, 'terra-low')
    assert.equal(receipt.semanticWorkPerformedByRoot, false)
    assert.equal(receipt.action, 'dispatch-ready-slice')
})

test('A81-02 rejects Root-authored semantics, expanded context and profile leakage', async () => {
    const {
        compileRootControlAction,
        validateDispatchInvestigationProjection
    } = await importRuntime(1881)
    for (const mutate of [
        (v) => { v.fullIssueBodyIncluded = true },
        (v) => { v.fullDagIncluded = true },
        (v) => { v.stateRootIncluded = true },
        (v) => { v.ownerSelection = 'ExampleOrg/RepositoryA' },
        (v) => { v.rootAuthoredSlice = true }
    ]) {
        const value = dispatchProjection()
        mutate(value)
        assert.throws(
            () => validateDispatchInvestigationProjection(value),
            { code: 'root-projection-authority-boundary' }
        )
    }
    const projection = dispatchProjection()
    const takeoverStartup = verifiedRuntimeStartup({
        profile: 'terra-medium',
        invocationId: 'invocation-test-takeover'
    })
    assert.throws(() => compileRootControlAction({
        projection,
        startup: takeoverStartup,
        ...rootRuntimeTrust(takeoverStartup),
        requestedAction: projection.nextActions[0]
    }), { code: 'root-control-profile' })

    const directProductEdit = dispatchProjection()
    directProductEdit.nextActions[0].action = 'author-implementation'
    delete directProductEdit.projectionDigest
    directProductEdit.projectionDigest = digest(directProductEdit)
    assert.throws(() => compileRootControlAction({
        projection: directProductEdit,
        startup: runtimeStartup,
        ...rootRuntimeTrust(),
        requestedAction: directProductEdit.nextActions[0]
    }), { code: 'root-control-action' })
})

test('A81-03 source fingerprints cache authority evidence without a reviewer layer', async () => {
    const {
        createInvestigationCache,
        resolveInvestigationCache
    } = await importRuntime(1881)
    const projection = dispatchProjection()
    const cache = createInvestigationCache({
        sourceFingerprint: projection.sourceFingerprint,
        semanticReceiptDigest: projection.semanticReceiptDigest,
        testPlanningReceiptDigest: projection.testPlanningReceiptDigest
    })
    assert.equal(resolveInvestigationCache({
        cache,
        sourceFingerprint: projection.sourceFingerprint
    }).action, 'reuse-authority-evidence')
    assert.equal(resolveInvestigationCache({
        cache,
        sourceFingerprint: digest('changed')
    }).action, 'authority-reinvestigation-required')
    assert.equal(cache.reviewerRequired, false)
})
