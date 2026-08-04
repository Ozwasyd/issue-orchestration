import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    digest,
    seal
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'
import {
    createSemanticGraph
} from '../../skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
import {
    compileLifecycleRunGenesisAuthority,
    repositoryAuthorityFor,
    resolveLifecycleSelector
} from '../../skills/issue-orchestration/scripts/lifecycle-genesis-authority.mjs'
import {
    compileLifecycleRunActionSet,
    createLifecycleRunLedger,
    projectLifecycleRun,
    recordLifecycleActionResults
} from '../../skills/issue-orchestration/scripts/lifecycle-run-loop.mjs'
import {
    executePreWriterLifecycleAction,
    preWriterLifecycleActionTypes
} from '../../skills/issue-orchestration/scripts/lifecycle-prewriter-executor.mjs'
import {
    validateLifecycleStageResult
} from '../../skills/issue-orchestration/scripts/lifecycle-stage-admission.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const CREATED_AT = '2026-08-04T00:00:00.000Z'
const actorScript = fileURLToPath(new URL(
    './issue-orchestration/prewriter-stage-actor.mjs',
    import.meta.url
))

function git(args, cwd) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_DATE: CREATED_AT,
            GIT_COMMITTER_DATE: CREATED_AT
        }
    })
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout)
    }
    return result.stdout.trim()
}

function initRepository(root) {
    const bare = path.join(root, 'Repo.git')
    const work = path.join(root, 'Repo-work')
    const repository = 'Fixture/Repo'
    const remoteUrl = `https://github.com/${repository}.git`
    git(['init', '--bare', '--initial-branch=main', bare], root)
    git(['clone', bare, work], root)
    git(['config', 'user.name', 'prewriter-test'], work)
    git(['config', 'user.email', 'prewriter@example.invalid'], work)
    fs.writeFileSync(path.join(work, 'README.md'), '# Repo\n')
    git(['add', 'README.md'], work)
    git(['commit', '-m', 'initialize'], work)
    git(['push', '-u', 'origin', 'main'], work)
    git(['config', `url.${bare}.insteadOf`, remoteUrl], work)
    git(['remote', 'set-url', 'origin', remoteUrl], work)
    return { bare, work, repository, remoteUrl }
}

function issue(repository) {
    return {
        repository,
        number: 37,
        state: 'OPEN',
        stateReason: null,
        updatedAt: CREATED_AT,
        title: 'Execute pre-writer stages',
        body: [
            'Implement a real semantic and test planning boundary.',
            '',
            '- Semantic output must be independently validated.',
            '- Planning must not acquire a writer lease.'
        ].join('\n'),
        comments: [{
            id: 'comment-1',
            body: 'The planning rollout must use fresh context.',
            updatedAt: CREATED_AT,
            relevant: true,
            relevantToCorrectness: true
        }],
        labels: ['orchestration'],
        milestone: null,
        dependsOn: []
    }
}

function selector(repository) {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: 'prewriter-selector-v1',
        type: 'explicit-issues',
        repositories: [repository],
        parameters: {
            issueIds: [`${repository}#37`],
            states: ['OPEN']
        },
        remoteQueryIdentity: 'prewriter-test:explicit-issues'
    }
}

function classification(repository) {
    return {
        domain: 'orchestration-core',
        effectiveOwnerRepository: repository,
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'focused',
        modelRoutingEvidenceDigest: digest('prewriter-routing-evidence'),
        routingPolicyVersion: 'stage-model-pool.v3'
    }
}

function profileMetadata(profile) {
    if (profile.startsWith('sol-')) {
        return { model: 'gpt-5.6-sol', effort: profile.slice(4) }
    }
    if (profile.startsWith('luna-')) {
        return { model: 'gpt-5.6-luna', effort: profile.slice(5) }
    }
    return { model: 'gpt-5.6-terra', effort: profile.slice(6) }
}

function executionObservation({ fixture, stageRole, stagePhase, route, actorId }) {
    const metadata = profileMetadata(route.selectedProfile)
    const value = {
        schema: 'issue-orchestration.runtime-execution-observation.v1',
        producerAuthority: 'runtime-owned',
        producer: 'codex-rollout',
        runtimeId: 'codex',
        runtimeVersion: 'codex-cli-2026.08',
        actorInvocationId: `${actorId}:invocation`,
        actorSessionId: `${actorId}:session`,
        rootInvocationId: fixture.startup.attestation.runtimeInvocationId,
        requestedRole: stageRole,
        effectiveRole: stageRole,
        requestedPhase: stagePhase,
        effectivePhase: stagePhase,
        requestedProfile: route.selectedProfile,
        effectiveProfile: route.selectedProfile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        routeDecisionDigest: route.routeDecisionDigest,
        packageDigest: fixture.startup.observation.packageDigest,
        modelPoolPolicyDigest:
            fixture.startup.observation.policyDigests.modelPool,
        executionRoutingPolicyDigest:
            fixture.startup.observation.policyDigests.executionRouting,
        effectiveMultiAgentBackend: 'v2',
        effectivePermissionProfile: 'danger-full-access',
        permissionInheritance: 'inherited-parent-profile',
        permissionGuarantee: 'contract-and-postcondition',
        observedAt: '2026-08-04T00:01:00.000Z'
    }
    value.observationDigest = digest(value)
    return value
}

function capabilityObservation({ route, actorId }) {
    const metadata = profileMetadata(route.selectedProfile)
    return seal({
        schema: 'issue-orchestration.runtime-capability-observation.v2',
        source: 'per-dispatch-runtime-identity-observer',
        observable: true,
        runtimeInvocationId: `${actorId}:invocation`,
        sessionOrThreadId: `${actorId}:session`,
        runtimeVersion: 'codex-cli-2026.08',
        requestedProfile: route.selectedProfile,
        effectiveProfile: route.selectedProfile,
        requestedModel: metadata.model,
        effectiveModel: metadata.model,
        requestedEffort: metadata.effort,
        effectiveEffort: metadata.effort,
        multiAgentBackend: 'v2',
        rawEventDigest: digest(`${actorId}:event`),
        rawSessionDigest: digest(`${actorId}:session-raw`),
        rawTurnDigest: digest(`${actorId}:turn`),
        observedAt: '2026-08-04T00:01:00.000Z'
    }, 'observationDigest')
}

function childActorAdapter(fixture, {
    transform = (value) => value,
    afterInvoke = () => {}
} = {}) {
    let sequence = 0
    const invocations = []
    return {
        invocations,
        prepare({ stageRole, stagePhase, routeDecision }) {
            sequence += 1
            const actorId = `${stagePhase}-${sequence}`
            invocations.push({ actorId, stageRole, stagePhase })
            return {
                preparation: { actorId, stageRole, stagePhase },
                runtimeObservation: executionObservation({
                    fixture,
                    stageRole,
                    stagePhase,
                    route: routeDecision,
                    actorId
                }),
                runtimeCapabilityObservation: capabilityObservation({
                    route: routeDecision,
                    actorId
                })
            }
        },
        invoke({ preparation, routeDecision, request }) {
            const result = spawnSync(process.execPath, [actorScript], {
                encoding: 'utf8',
                input: JSON.stringify({
                    actorId: preparation.actorId,
                    stagePhase: routeDecision.stagePhase,
                    routeDecision,
                    request
                })
            })
            if (result.status !== 0) {
                throw new Error(result.stderr || result.stdout)
            }
            const output = transform(JSON.parse(result.stdout), {
                preparation,
                routeDecision,
                request
            })
            afterInvoke({ preparation, routeDecision, request, output })
            return output
        }
    }
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prewriter-root-'))
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prewriter-state-'))
    const repository = initRepository(root)
    const startup = verifiedRuntimeStartup({
        invocationId: 'prewriter-root-invocation',
        sessionId: 'prewriter-root-session'
    })
    const runId = 'prewriter-run'
    const authority = compileLifecycleRunGenesisAuthority({
        runId,
        startup,
        stateRoot,
        repositoryTargets: [{
            repository: repository.repository,
            repositoryPath: repository.work,
            defaultBranch: 'main'
        }],
        workspaces: [root],
        worktrees: [],
        slotCapacity: 1,
        createdAt: CREATED_AT
    })
    const repositoryBinding = repositoryAuthorityFor(
        authority,
        repository.repository
    )
    const remoteIssue = {
        ...issue(repository.repository),
        baseSha: repositoryBinding.observedDefaultBranchHead
    }
    const selectorReceipt = resolveLifecycleSelector({
        lifecycleAuthority: authority,
        startup,
        selector: selector(repository.repository),
        remoteIssues: [remoteIssue],
        previousReceipt: null,
        resolvedAt: CREATED_AT
    })
    const policyDigest = digest('prewriter-policy')
    const nodeId = `${repository.repository}#37`
    const semanticGraph = createSemanticGraph({
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        scopeDigest: digest([nodeId]),
        semanticGraphInputDigest: digest(remoteIssue),
        policyDigest,
        repositories: [{
            repository: repository.repository,
            baseSha: repositoryBinding.observedDefaultBranchHead,
            bindingDigest: repositoryBinding.bindingDigest
        }],
        nodes: [{
            id: nodeId,
            memberId: nodeId,
            repository: repository.repository,
            issueNumber: 37,
            owner: 'dag-creator-updater',
            dependencyKeys: [],
            conflictKeys: [],
            riskClass: 'bounded',
            uiClass: 'non-ui',
            acceptanceGroup: null,
            lifecycleState: 'none',
            selectorReceiptDigest: selectorReceipt.receiptDigest,
            remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
            repositoryBindingDigest: repositoryBinding.bindingDigest,
            semanticFactsDigest: digest(remoteIssue),
            receipts: {}
        }]
    })
    let ledger = createLifecycleRunLedger({
        stateRoot,
        runId,
        createdAt: CREATED_AT,
        selectorReceipt,
        selectorDefinition: selector(repository.repository),
        semanticGraph,
        installedPolicy: {
            schema: 'issue-orchestration.installed-route-policy.v1',
            status: 'verified',
            policyDigest
        },
        lifecycleAuthority: authority,
        startup,
        slotCapacity: 1
    })
    const common = {
        repositoryPath: repository.work,
        stateRootPath: stateRoot,
        skillDigest: digest('prewriter-skill'),
        baselineDigest: digest('prewriter-baseline'),
        routingClassification: classification(repository.repository),
        startup,
        runtimeTrustBinding: authority.runtimeTrustBinding,
        repositoryTargets: authority.repositoryTargets,
        lifecycleAuthority: authority
    }
    return {
        root,
        stateRoot,
        repository,
        startup,
        authority,
        selectorReceipt,
        remoteIssue,
        nodeId,
        common,
        get ledger() { return ledger },
        set ledger(value) { ledger = value },
        actionSet() {
            return compileLifecycleRunActionSet(ledger, { startup })
        },
        node() {
            return projectLifecycleRun(ledger, { startup }).state.nodes[nodeId]
        },
        record(actionSet, result, createdAt) {
            ledger = recordLifecycleActionResults({
                ledger,
                actionSet,
                stageResults: [result],
                startup,
                createdAt
            })
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true })
            fs.rmSync(stateRoot, { recursive: true, force: true })
        }
    }
}

function runAction(f, adapter, inputs = {}) {
    const actionSet = f.actionSet()
    assert.equal(actionSet.actions.length, 1)
    const action = actionSet.actions[0]
    const result = executePreWriterLifecycleAction({
        ...f.common,
        actionSet,
        action,
        node: f.node(),
        actorAdapter: adapter,
        inputs
    })
    validateLifecycleStageResult({ result, action, node: f.node() })
    return { actionSet, action, result }
}

function resealArtifact(artifact, digestField) {
    artifact.evidenceDigest = digest(artifact.evidence)
    delete artifact[digestField]
    artifact[digestField] = digest(artifact)
    return artifact[digestField]
}

function resealStageResult(result) {
    result.artifactsDigest = digest(result.artifacts)
    delete result.resultDigest
    result.resultDigest = digest(result)
    return result
}

test('one production executor advances semantic, deterministic acceptance, and fresh planning boundaries', () => {
    const f = fixture()
    const adapter = childActorAdapter(f)
    try {
        assert.deepEqual(preWriterLifecycleActionTypes, [
            'compile-acceptance-contract',
            'request-semantic-proposal',
            'request-test-contract-planning'
        ])
        const repositoryStatus = git(['status', '--porcelain=v1'], f.repository.work)

        const semantic = runAction(f, adapter, {
            issue: f.remoteIssue,
            selectorReceipt: f.selectorReceipt
        })
        assert.equal(semantic.action.type, 'request-semantic-proposal')
        assert.equal(adapter.invocations.length, 1)
        f.record(
            semantic.actionSet,
            semantic.result,
            '2026-08-04T00:02:00.000Z'
        )

        const acceptanceActionSet = f.actionSet()
        const acceptanceAction = acceptanceActionSet.actions[0]
        assert.equal(acceptanceAction.type, 'compile-acceptance-contract')
        const acceptanceContext = {
            ...f.common,
            actionSet: acceptanceActionSet,
            action: acceptanceAction,
            node: f.node(),
            actorAdapter: adapter,
            inputs: {}
        }
        const acceptanceA = executePreWriterLifecycleAction(acceptanceContext)
        const acceptanceB = executePreWriterLifecycleAction(acceptanceContext)
        assert.deepEqual(acceptanceA, acceptanceB)
        assert.equal(adapter.invocations.length, 1)
        f.record(
            acceptanceActionSet,
            acceptanceA,
            '2026-08-04T00:03:00.000Z'
        )

        const planning = runAction(f, adapter, {
            attemptId: 'prewriter-planning-attempt-1'
        })
        assert.equal(planning.action.type, 'request-test-contract-planning')
        assert.equal(adapter.invocations.length, 2)
        assert.notEqual(
            planning.result.artifacts.runtimeBinding.evidence.actorInvocationId,
            semantic.result.artifacts.runtimeBinding.evidence.actorInvocationId
        )
        const workPlan = planning.result.artifacts.workPlan.evidence.plan
        assert.equal(workPlan.contractBindingStatus, 'pre-writer-verified')
        assert.equal(workPlan.activeWriteLeaseId, null)
        assert.equal(workPlan.frozenStageContract, null)
        assert.equal(
            planning.result.artifacts.resourceAcquisition.evidence
                .writeLeaseAcquired,
            false
        )
        assert.equal(
            Object.hasOwn(
                planning.result.artifacts.resourceAcquisition.evidence
                    .registry,
                'writeLease'
            ),
            false
        )
        assert.ok(
            planning.result.artifacts.resourceAcquisition.evidence.registry
                .resources.every(({ state }) => state === 'removed-clean')
        )
        const prompt = planning.result.artifacts.compiledPrompt.evidence.prompt
        assert.equal(JSON.stringify(prompt).includes(f.stateRoot), false)
        assert.equal(JSON.stringify(prompt).includes(f.remoteIssue.body), false)
        assert.equal(
            planning.result.artifacts.compiledPrompt.evidence
                .fullIssueIncluded,
            false
        )
        assert.equal(
            planning.result.artifacts.compiledPrompt.evidence
                .fullDagIncluded,
            false
        )
        assert.equal(
            planning.result.artifacts.compiledPrompt.evidence
                .stateRootIncluded,
            false
        )
        assert.equal(
            Object.hasOwn(planning.result.artifacts, 'dispatchReceipt'),
            false
        )
        f.record(
            planning.actionSet,
            planning.result,
            '2026-08-04T00:04:00.000Z'
        )
        assert.equal(f.node().lifecycleState, 'test-contracting')
        assert.equal(git(['status', '--porcelain=v1'], f.repository.work), repositoryStatus)
    } finally {
        f.cleanup()
    }
})

test('unsupported actions fail before actor preparation and before protected state changes', () => {
    const f = fixture()
    const adapter = childActorAdapter(f)
    try {
        const actionSet = f.actionSet()
        const action = structuredClone(actionSet.actions[0])
        action.type = 'dispatch-test-contract-writer'
        const before = fs.readdirSync(f.stateRoot).sort()
        assert.throws(
            () => executePreWriterLifecycleAction({
                ...f.common,
                actionSet,
                action,
                node: f.node(),
                actorAdapter: adapter,
                inputs: {}
            }),
            ({ code }) => code === 'prewriter-action-unsupported'
        )
        assert.equal(adapter.invocations.length, 0)
        assert.deepEqual(fs.readdirSync(f.stateRoot).sort(), before)
    } finally {
        f.cleanup()
    }
})

test('root-authored semantic output and stale action authority fail closed', () => {
    const f = fixture()
    const rootAdapter = childActorAdapter(f, {
        transform(value) {
            value.semanticProposal.rootAuthored = true
            delete value.semanticProposal.proposalDigest
            value.semanticProposal.proposalDigest = digest(value.semanticProposal)
            return value
        }
    })
    try {
        const actionSet = f.actionSet()
        const action = actionSet.actions[0]
        assert.throws(
            () => executePreWriterLifecycleAction({
                ...f.common,
                actionSet,
                action,
                node: f.node(),
                actorAdapter: rootAdapter,
                inputs: {
                    issue: f.remoteIssue,
                    selectorReceipt: f.selectorReceipt
                }
            }),
            ({ code }) => code === 'prewriter-semantic-proposal-invalid'
        )

        const stale = structuredClone(action)
        stale.bindings.runtimeInvocationId = 'stale-root'
        stale.actionDigest = digest({ ...stale, actionDigest: undefined })
        assert.throws(
            () => executePreWriterLifecycleAction({
                ...f.common,
                actionSet,
                action: stale,
                node: f.node(),
                actorAdapter: rootAdapter,
                inputs: {
                    issue: f.remoteIssue,
                    selectorReceipt: f.selectorReceipt
                }
            }),
            ({ code }) => code === 'prewriter-action-stale'
        )
    } finally {
        f.cleanup()
    }
})


test('observe-only mutation in repository or state root rejects the complete actor result', () => {
    for (const target of ['repository', 'state-root']) {
        const f = fixture()
        const adapter = childActorAdapter(f, {
            afterInvoke() {
                const destination = target === 'repository'
                    ? path.join(f.repository.work, 'forbidden.txt')
                    : path.join(f.stateRoot, 'forbidden.txt')
                fs.writeFileSync(destination, 'forbidden mutation\n')
            }
        })
        try {
            const actionSet = f.actionSet()
            assert.throws(
                () => executePreWriterLifecycleAction({
                    ...f.common,
                    actionSet,
                    action: actionSet.actions[0],
                    node: f.node(),
                    actorAdapter: adapter,
                    inputs: {
                        issue: f.remoteIssue,
                        selectorReceipt: f.selectorReceipt
                    }
                }),
                ({ code }) => code ===
                    'stage-mutation-postcondition-receipt-invalid'
            )
        } finally {
            f.cleanup()
        }
    }
})

test('caller-edited semantic history cannot authorize deterministic acceptance', () => {
    const f = fixture()
    const adapter = childActorAdapter(f)
    try {
        const semantic = runAction(f, adapter, {
            issue: f.remoteIssue,
            selectorReceipt: f.selectorReceipt
        })
        f.record(semantic.actionSet, semantic.result, '2026-08-04T00:02:00.000Z')
        const actionSet = f.actionSet()
        const node = structuredClone(f.node())
        const receipt = node.receipts.semanticProposal
        receipt.evidence.proposal.classifications.pop()
        delete receipt.evidence.proposal.proposalDigest
        receipt.evidence.proposal.proposalDigest =
            digest(receipt.evidence.proposal)
        receipt.evidenceDigest = digest(receipt.evidence)
        delete receipt.proposalDigest
        receipt.proposalDigest = digest(receipt)
        assert.throws(
            () => executePreWriterLifecycleAction({
                ...f.common,
                actionSet,
                action: actionSet.actions[0],
                node,
                actorAdapter: adapter,
                inputs: {}
            }),
            ({ code }) => code === 'prewriter-node-stale'
        )
        assert.equal(adapter.invocations.length, 1)
    } finally {
        f.cleanup()
    }
})

test('resealed extra requirement cannot bypass deterministic acceptance', () => {
    const f = fixture()
    const adapter = childActorAdapter(f)
    try {
        const semantic = runAction(f, adapter, {
            issue: f.remoteIssue,
            selectorReceipt: f.selectorReceipt
        })
        f.record(semantic.actionSet, semantic.result, '2026-08-04T00:02:00.000Z')
        const actionSet = f.actionSet()
        const action = actionSet.actions[0]
        const accepted = executePreWriterLifecycleAction({
            ...f.common,
            actionSet,
            action,
            node: f.node(),
            actorAdapter: adapter,
            inputs: {}
        })
        const tampered = structuredClone(accepted)
        const inventoryArtifact = tampered.artifacts.requirementInventory
        const inventory = inventoryArtifact.evidence.inventory
        const fake = {
            ...structuredClone(inventory.requirements[0]),
            requirementId: `REQ-${digest('caller-added-requirement').slice(0, 24)}`,
            sourceIdentity: `${inventory.repository}#37:caller-added`,
            sourceSpanDigest: digest('caller-added-span'),
            classification: 'acceptance'
        }
        inventory.requirements.push(fake)
        inventory.requirements.sort((left, right) =>
            left.requirementId.localeCompare(right.requirementId))
        inventory.sourceCoverageDigest = digest(
            inventory.requirements.map((item) => ({
                requirementId: item.requirementId,
                sourceIdentity: item.sourceIdentity,
                sourceSpanDigest: item.sourceSpanDigest,
                classification: item.classification
            }))
        )
        delete inventory.inventoryDigest
        inventory.inventoryDigest = digest(inventory)
        inventoryArtifact.evidence.requirementIds =
            inventory.requirements.map(({ requirementId }) => requirementId)
        inventoryArtifact.evidence.sourceCoverageDigest =
            inventory.sourceCoverageDigest
        const inventoryArtifactDigest = resealArtifact(
            inventoryArtifact,
            'inventoryDigest'
        )

        const contractArtifact = tampered.artifacts.acceptanceContract
        const contract = contractArtifact.evidence.acceptanceContract
        contract.inventoryDigest = inventory.inventoryDigest
        contract.executableAcceptanceIds = [
            ...contract.executableAcceptanceIds,
            fake.requirementId
        ].sort()
        contract.sourceBindings.push({
            requirementId: fake.requirementId,
            sourceIdentity: fake.sourceIdentity,
            sourceSpanDigest: fake.sourceSpanDigest,
            classification: fake.classification
        })
        contract.sourceBindings.sort((left, right) =>
            left.requirementId.localeCompare(right.requirementId))
        delete contract.contractDigest
        contract.contractDigest = digest(contract)
        contractArtifact.evidence.acceptanceIds =
            [...contract.executableAcceptanceIds]
        contractArtifact.evidence.requirementInventoryDigest =
            inventoryArtifactDigest
        contractArtifact.evidence.sourceCoverageDigest =
            inventory.sourceCoverageDigest
        const contractArtifactDigest = resealArtifact(
            contractArtifact,
            'contractDigest'
        )

        const discoveredArtifact = tampered.artifacts.nodeDiscovered
        const discovered = discoveredArtifact.evidence.receipt
        discovered.requirementInventoryDigest = inventory.inventoryDigest
        discovered.sourceCoverageDigest = inventory.sourceCoverageDigest
        discovered.acceptanceContractDigest = contract.contractDigest
        delete discovered.receiptDigest
        discovered.receiptDigest = digest(discovered)
        discoveredArtifact.evidence.requirementInventoryDigest =
            inventoryArtifactDigest
        discoveredArtifact.evidence.acceptanceContractDigest =
            contractArtifactDigest
        resealArtifact(discoveredArtifact, 'receiptDigest')

        const documentationArtifact =
            tampered.artifacts.documentationRequirement
        const documentation = documentationArtifact.evidence.receipt
        documentation.acceptanceContractDigest = contract.contractDigest
        delete documentation.receiptDigest
        documentation.receiptDigest = digest(documentation)
        documentationArtifact.evidence.acceptanceContractDigest =
            contractArtifactDigest
        resealArtifact(documentationArtifact, 'receiptDigest')
        resealStageResult(tampered)

        assert.throws(
            () => validateLifecycleStageResult({
                result: tampered,
                action,
                node: f.node()
            }),
            ({ code }) => code ===
                'lifecycle-requirement-inventory-payload-mismatch'
        )
    } finally {
        f.cleanup()
    }
})

test('planning rejects wrong owner, base, source, or repository evidence even after resealing', () => {
    const mutations = [
        (value) => { value.dispatchInvestigation.confirmedOwner = 'Other/Repo' },
        (value) => { value.dispatchInvestigation.baseSha = 'f'.repeat(40) },
        (value) => { value.dispatchInvestigation.sourceFingerprint = digest('stale') },
        (value) => { value.dispatchInvestigation.repositoryEvidence.commands = ['false'] }
    ]
    for (const mutate of mutations) {
        const f = fixture()
        const semanticAdapter = childActorAdapter(f)
        try {
            const semantic = runAction(f, semanticAdapter, {
                issue: f.remoteIssue,
                selectorReceipt: f.selectorReceipt
            })
            f.record(semantic.actionSet, semantic.result, '2026-08-04T00:02:00.000Z')
            const acceptance = runAction(f, semanticAdapter)
            f.record(acceptance.actionSet, acceptance.result, '2026-08-04T00:03:00.000Z')
            const adapter = childActorAdapter(f, {
                transform(value) {
                    mutate(value)
                    const investigation = value.dispatchInvestigation
                    investigation.repositoryEvidenceDigest =
                        digest(investigation.repositoryEvidence)
                    delete investigation.receiptDigest
                    investigation.receiptDigest = digest(investigation)
                    return value
                }
            })
            const actionSet = f.actionSet()
            assert.throws(
                () => executePreWriterLifecycleAction({
                    ...f.common,
                    actionSet,
                    action: actionSet.actions[0],
                    node: f.node(),
                    actorAdapter: adapter,
                    inputs: { attemptId: 'tampered-planning' }
                }),
                ({ code }) => code ===
                    'prewriter-dispatch-investigation-invalid'
            )
        } finally {
            f.cleanup()
        }
    }
})

test('planning runtime must be distinct from the accepted semantic runtime', () => {
    const f = fixture()
    const semanticAdapter = childActorAdapter(f)
    try {
        const semantic = runAction(f, semanticAdapter, {
            issue: f.remoteIssue,
            selectorReceipt: f.selectorReceipt
        })
        const semanticInvocation =
            semantic.result.artifacts.runtimeBinding.evidence.actorInvocationId
        const semanticSession =
            semantic.result.artifacts.runtimeBinding.evidence.actorSessionId
        f.record(semantic.actionSet, semantic.result, '2026-08-04T00:02:00.000Z')
        const acceptance = runAction(f, semanticAdapter)
        f.record(acceptance.actionSet, acceptance.result, '2026-08-04T00:03:00.000Z')
        const actionSet = f.actionSet()
        const base = childActorAdapter(f)
        const adapter = {
            invocations: base.invocations,
            prepare(args) {
                const prepared = structuredClone(base.prepare(args))
                prepared.runtimeObservation.actorInvocationId = semanticInvocation
                prepared.runtimeObservation.actorSessionId = semanticSession
                delete prepared.runtimeObservation.observationDigest
                prepared.runtimeObservation.observationDigest =
                    digest(prepared.runtimeObservation)
                prepared.runtimeCapabilityObservation.runtimeInvocationId =
                    semanticInvocation
                prepared.runtimeCapabilityObservation.sessionOrThreadId =
                    semanticSession
                delete prepared.runtimeCapabilityObservation.observationDigest
                prepared.runtimeCapabilityObservation.observationDigest =
                    digest(prepared.runtimeCapabilityObservation)
                return prepared
            },
            invoke: base.invoke
        }
        assert.throws(
            () => executePreWriterLifecycleAction({
                ...f.common,
                actionSet,
                action: actionSet.actions[0],
                node: f.node(),
                actorAdapter: adapter,
                inputs: { attemptId: 'reused-runtime' }
            }),
            ({ code }) => code === 'prewriter-planning-runtime-not-fresh'
        )
    } finally {
        f.cleanup()
    }
})
