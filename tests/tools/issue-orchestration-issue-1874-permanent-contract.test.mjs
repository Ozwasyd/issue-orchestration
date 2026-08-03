import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
    compileWriterStageTestArtifacts,
    createWriterStageGitFixture,
    observeWriterStageCheckpointEvidence,
    writerTestDigest
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    buildVerifiedWriterProgressCheckpoint
} from './issue-orchestration-writer-progress-test-helper.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = path.join(
    root,
    'tests/fixtures/issue-orchestration/issue-1874-permanent-test-contract.json'
)
const contract = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

const expectedSchemas = [
    'issue-orchestration.stage-work-plan.v1',
    'issue-orchestration.executable-slice.v1',
    'issue-orchestration.compiled-dispatch-prompt.v1',
    'issue-orchestration.stage-progress-checkpoint.v1',
    'issue-orchestration.stage-continuation-receipt.v1',
    'issue-orchestration.slice-terminal-receipt.v1',
    'issue-orchestration.writer-stage-failure-receipt.v1',
    'issue-orchestration.writer-stage-retry-authorization.v1'
]
const checkpointVerificationSchema =
    'issue-orchestration.writer-stage-checkpoint-verification-receipt.v1'
const checkpointVerificationSchemaFile =
    'contracts/writer-stage-checkpoint-verification-receipt.schema.json'

const expectedEvents = [
    'writer-stage.invocation-failed',
    'writer-stage.environment-failed',
    'writer-stage.runtime-capability-missing',
    'writer-stage.first-action-not-executed',
    'writer-stage.output-missing',
    'writer-stage.checkpoint-missing',
    'writer-stage.receipt-rejected',
    'writer-stage.retry-authorized'
]

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return sha256(JSON.stringify(canonical(value)))
}

function sealReceipt(value) {
    return {
        ...value,
        receiptDigest: digest(value)
    }
}

function terminalPlanInput({ fixture }) {
    const commands = fixture.filePaths.map((filePath) =>
        `node --check ${filePath}`)
    const slice = (
        sliceId,
        order,
        prerequisiteSliceIds,
        acceptanceItemId,
        filePath
    ) => ({
        sliceId,
        order,
        prerequisiteSliceIds,
        singleObjective: `Complete permanent terminal gate slice ${order}`,
        firstRequiredAction: commands[order - 1],
        firstReadTargets: [filePath],
        firstWritablePath: filePath,
        allowedPaths: [...fixture.filePaths],
        forbiddenPaths: [],
        requiredCreatedOrModifiedFiles: [filePath],
        requiredCommands: [commands[order - 1]],
        requiredEvidence: [
            `filesystem-git-command-evidence-${order}`
        ],
        expectedFailureOrProgressSignal: `slice ${order} terminal receipt`,
        explicitNonGoals: [
            'dispatch the whole issue',
            'promote a partial plan',
            'create a second authority'
        ],
        maxChangedFiles: fixture.filePaths.length,
        maxOwnedModules: fixture.filePaths.length,
        maxReadOnlyOperationsBeforeCheckpoint: 4,
        maxNoArtifactToolCalls: 3,
        maxNoArtifactActiveDurationClass: 'short',
        safeCheckpointKind: 'slice-terminal',
        acceptanceItemIds: [acceptanceItemId],
        completionPredicate: `slice ${order} is terminal-complete`,
        continuationPredicate: `slice ${order} resumes its sealed cursor`
    })
    const firstSliceId = 'slice-1874-terminal-gate-001'
    const finalSliceId = 'slice-1874-terminal-gate-002'
    return {
        schema: 'issue-orchestration.stage-work-plan-input.v1',
        runId: 'run-1874-terminal-gate-contract',
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: 'ExampleOrg/RepositoryA#1874',
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-terminal-gate-001',
        worktreeIdentity: fixture.worktreeIdentity,
        semanticContractDigest: 'a'.repeat(64),
        testContractDigest: 'b'.repeat(64),
        authorityDigest: 'c'.repeat(64),
        skillDigest: 'd'.repeat(64),
        baselineDigest: 'e'.repeat(64),
        routingInputDigest: 'f'.repeat(64),
        stageObjective: 'Prove ordered slice terminal gating',
        acceptanceItems: [
            'A-terminal-next-slice',
            'A-terminal-candidate-green'
        ],
        orderedSlices: [
            slice(
                firstSliceId,
                1,
                [],
                'A-terminal-next-slice',
                fixture.filePaths[0]
            ),
            slice(
                finalSliceId,
                2,
                [firstSliceId],
                'A-terminal-candidate-green',
                fixture.filePaths[1]
            )
        ],
        sliceDependencyGraph: {
            [firstSliceId]: [],
            [finalSliceId]: [firstSliceId]
        },
        stageAllowedPaths: [...fixture.filePaths],
        stageForbiddenPaths: [],
        stageRequiredCommands: commands,
        stageTerminalArtifacts: [
            'issue-orchestration.slice-terminal-receipt.v1'
        ]
    }
}

function documentationReadOnlyPlanInput({ fixture }) {
    const sliceId = 'slice-1874-documentation-no-change-001'
    const command = 'git diff --quiet'
    return {
        schema: 'issue-orchestration.stage-work-plan-input.v1',
        runId: 'run-1874-documentation-no-change',
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: 'ExampleOrg/RepositoryA#1874:documentation-no-change',
        stageRole: 'documentation-writer',
        stagePhase: 'documentation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-documentation-no-change-001',
        worktreeIdentity: fixture.worktreeIdentity,
        semanticContractDigest: '1'.repeat(64),
        testContractDigest: '2'.repeat(64),
        authorityDigest: '3'.repeat(64),
        skillDigest: '4'.repeat(64),
        baselineDigest: '5'.repeat(64),
        routingInputDigest: '6'.repeat(64),
        stageObjective:
            'Verify that the focused documentation slice needs no change',
        acceptanceItems: ['A-documentation-verified-no-change'],
        orderedSlices: [{
            sliceId,
            order: 1,
            prerequisiteSliceIds: [],
            singleObjective:
                'Seal machine evidence for a documentation no-change result',
            firstRequiredAction: command,
            firstReadTargets: [fixture.filePaths[0]],
            explicitReadOnlyOutput:
                'verified documentation no-change evidence',
            allowedPaths: [],
            forbiddenPaths: [],
            requiredCreatedOrModifiedFiles: [],
            requiredCommands: [command],
            requiredEvidence: ['verified-no-change-evidence'],
            expectedFailureOrProgressSignal:
                'a complete no-change checkpoint or terminal failure receipt',
            explicitNonGoals: [
                'manufacture a documentation diff',
                'write outside the documentation stage'
            ],
            maxChangedFiles: 1,
            maxOwnedModules: 1,
            maxReadOnlyOperationsBeforeCheckpoint: 4,
            maxNoArtifactToolCalls: 3,
            maxNoArtifactActiveDurationClass: 'short',
            safeCheckpointKind: 'documentation-no-change',
            acceptanceItemIds: ['A-documentation-verified-no-change'],
            completionPredicate:
                'the no-change command and evidence are machine verified',
            continuationPredicate:
                'resume the same documentation evidence cursor'
        }],
        sliceDependencyGraph: {
            [sliceId]: []
        },
        stageAllowedPaths: ['docs/**'],
        stageForbiddenPaths: [],
        stageRequiredCommands: [command],
        stageTerminalArtifacts: [
            'issue-orchestration.slice-terminal-receipt.v1'
        ]
    }
}

function checkpointInput({ plan, slice, evidence, status = 'complete' }) {
    return {
        schema: 'issue-orchestration.stage-progress-checkpoint.v1',
        runId: plan.runId,
        node: plan.node,
        baseSha: plan.baseSha,
        epochId: plan.epochId,
        worktreeIdentity: plan.worktreeIdentity,
        sliceId: slice.sliceId,
        sliceDigest: slice.sliceDigest,
        status,
        cursor: {
            kind: 'executable-slice-action',
            completedActionCount: status === 'complete' ? 2 : 1,
            nextActionIndex: status === 'complete' ? 3 : 2,
            lastCompletedAction: `sealed ${slice.sliceId}`
        },
        nextRequiredAction: status === 'complete'
            ? null
            : `continue ${slice.sliceId}`,
        evidence,
        evidenceDigest: evidence.evidenceDigest
    }
}

function resealReceipt(receipt, overrides) {
    const unsigned = {
        ...receipt,
        ...overrides
    }
    delete unsigned.receiptDigest
    return sealReceipt(unsigned)
}

function assertDeclaredSchemaProperties(value) {
    const relativePath = value.schema === checkpointVerificationSchema
        ? checkpointVerificationSchemaFile
        : contract.schemaFiles[value.schema]
    assert.equal(typeof relativePath, 'string', `unknown schema ${value.schema}`)
    const schema = JSON.parse(
        fs.readFileSync(path.join(root, relativePath), 'utf8')
    )
    for (const field of schema.required) {
        assert.equal(
            Object.hasOwn(value, field) && value[field] !== undefined,
            true,
            `${value.schema} missing ${field}`
        )
    }
    for (const field of Object.keys(value)) {
        assert.equal(
            Object.hasOwn(schema.properties, field),
            true,
            `${value.schema} undeclared ${field}`
        )
    }
}

test('the permanent contract names all eight schemas and one canonical owner per runtime surface', () => {
    assert.deepEqual(contract.requiredSchemas, expectedSchemas)
    assert.equal(new Set(contract.requiredSchemas).size, 8)
    assert.deepEqual(
        contract.canonicalRuntimeOwners,
        {
            sliceAndCheckpoint:
                'skills/issue-orchestration/scripts/executable-slice-compiler.mjs',
            writerProgress:
                'skills/issue-orchestration/scripts/writer-stage-progress.mjs'
        }
    )
    assert.doesNotMatch(
        JSON.stringify(contract.canonicalRuntimeOwners),
        /writer-stage-runtime|fallback/iu
    )
    assert.equal(
        fs.existsSync(path.join(
            root,
            'skills/issue-orchestration/scripts/writer-stage-runtime.mjs'
        )),
        false,
        'a second writer-stage runtime authority is forbidden'
    )
})

test('all eight permanent JSON schemas are discoverable and bind their exact identities', () => {
    assert.deepEqual(Object.keys(contract.schemaFiles), expectedSchemas)
    for (const [schemaIdentity, relativePath] of Object.entries(
        contract.schemaFiles
    )) {
        const schema = JSON.parse(
            fs.readFileSync(path.join(root, relativePath), 'utf8')
        )
        assert.equal(schema.title, schemaIdentity, relativePath)
        assert.equal(
            schema.properties?.schema?.const,
            schemaIdentity,
            relativePath
        )
        assert.ok(schema.required?.includes('schema'), relativePath)
        assert.equal(schema.additionalProperties, false, relativePath)
    }
})

test('independent checkpoint verification extends the frozen eight-schema contract', () => {
    assert.equal(contract.requiredSchemas.includes(checkpointVerificationSchema),
        false, 'the frozen requiredSchemas receipt must remain byte-stable')
    assert.equal(Object.hasOwn(
        contract.schemaFiles,
        checkpointVerificationSchema
    ), false, 'the frozen schemaFiles receipt must remain byte-stable')
    const schema = JSON.parse(fs.readFileSync(
        path.join(root, checkpointVerificationSchemaFile),
        'utf8'
    ))
    assert.equal(schema.title, checkpointVerificationSchema)
    assert.equal(
        schema.$id,
        'urn:issue-orchestration:writer-stage-checkpoint-verification-receipt:v1'
    )
    assert.equal(schema.properties?.schema?.const, checkpointVerificationSchema)
    assert.equal(schema.additionalProperties, false)
    for (const field of [
        'verificationStatus',
        'checkpointDigest',
        'checkpointOrdinal',
        'previousCheckpointDigest',
        'previousCheckpointVerificationReceiptDigest',
        'previousMachineTracePrefixDigest',
        'previousMachineTracePrefixByteLength',
        'planDigest',
        'sliceDigest',
        'compiledPromptDigest',
        'routeDigest',
        'stageAttemptId',
        'activeWriteLeaseId',
        'resourceRegistrySnapshotDigest',
        'resourceLeaseReceiptDigest',
        'typedEvidenceReceiptDigests',
        'machineTraceSnapshotDigest',
        'machineTracePrefixDigest',
        'machineTracePrefixByteLength',
        'runtimeProgressObservationDigest',
        'operationsDigest',
        'acceptedPriorChangedPathsDigest',
        'completedSlicePrefixDigest',
        'verifiedAt',
        'receiptDigest'
    ]) {
        assert.ok(schema.required.includes(field), field)
    }
})

test('the frozen test tree is byte-identical to the external audit receipt', () => {
    assert.match(contract.baseSha, /^[a-f0-9]{40}$/u)
    const digestLines = []
    for (const [relativePath, evidence] of Object.entries(
        contract.frozenAudit.files
    )) {
        const observed = sha256(fs.readFileSync(path.join(root, relativePath)))
        assert.equal(observed, evidence.sha256, relativePath)
        digestLines.push(`${relativePath}\t${observed}`)
    }

    const treeDigest = sha256(`${digestLines.sort().join('\n')}\n`)
    assert.equal(treeDigest, contract.frozenAudit.testTreeDigest)
    assert.equal(
        contract.frozenAudit.verifiedTestContractReceiptDigest,
        '2d42ae42ca67795845006d2563046f19afba81365a3bd4b474c8f9b69982731e'
    )
    assert.equal(
        contract.frozenAudit.freezeReceiptDigest,
        '48d164c8948e28184fb0cead66eb312337cb274cf446e0f55393dab9c617b494'
    )
    assert.deepEqual(
        Object.keys(contract.frozenAudit.sliceTerminalReceiptDigests),
        [
            'compiled-dispatch-prompt',
            'progress-checkpoint',
            'writer-stage-failure'
        ]
    )
    for (const receiptDigest of Object.values(
        contract.frozenAudit.sliceTerminalReceiptDigests
    )) {
        assert.match(receiptDigest, /^[a-f0-9]{64}$/u)
    }
    assert.equal(
        Object.values(contract.frozenAudit.files).reduce(
            (sum, { expectedInitialRed }) => sum + expectedInitialRed.fail,
            0
        ),
        30
    )
})

test('all writer phases, roles and terminal failure events remain explicit', () => {
    assert.deepEqual(
        contract.writerStages.map(({ stagePhase }) => stagePhase),
        [
            'test-contract',
            'implementation',
            'ui-implementation',
            'documentation',
            'landing-conflict-resolution'
        ]
    )
    assert.deepEqual(
        contract.writerStages.map(({ authorizedStageRoles }) =>
            authorizedStageRoles
        ),
        [
            ['test-owner'],
            ['code-implementer'],
            ['ui-ux-implementer'],
            ['documentation-writer'],
            ['code-implementer', 'ui-ux-implementer']
        ]
    )
    const landingStage = contract.writerStages.at(-1)
    assert.equal(
        landingStage.roleBinding,
        'member-writer-role-from-authorized-slice'
    )
    assert.equal(landingStage.frozenObservationRole, 'landing-owner')
    assert.equal(
        contract.writerStages
            .flatMap(({ authorizedStageRoles }) => authorizedStageRoles)
            .includes('landing-owner'),
        false,
        'the frozen observation label must not become an eighth dispatch role'
    )
    for (const stage of contract.writerStages) {
        assert.ok(stage.requiredOutputs.length >= 2, stage.stagePhase)
        assert.ok(stage.requiredOutputs.includes('checkpoint'), stage.stagePhase)
    }
    assert.deepEqual(contract.writerEvents, expectedEvents)
    assert.ok(
        contract.requiredBehavior.includes(
            'partial-checkpoint-is-not-candidate-green'
        )
    )
    assert.ok(
        contract.requiredBehavior.includes(
            'unchanged-failure-breaker-survives-identity-shell-changes'
        )
    )
    assert.ok(
        contract.requiredBehavior.includes(
            'retry-requires-substantive-revision-evidence'
        )
    )
})

test('the UI writer has one permanent phase and landing keeps the existing writer roles', async () => {
    const policyFiles = [
        'model-pool.json',
        'stage-permissions.json'
    ].map((name) => path.join(
        root,
        'policy',
        name
    ))
    for (const policyFile of policyFiles) {
        const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
        const routes = policy.stages ?? policy.selectors
        assert.equal(
            Object.hasOwn(routes, 'ui-ux-implementer:implementation'),
            false,
            `${path.basename(policyFile)} retained the legacy UI phase`
        )
        assert.equal(
            Object.hasOwn(routes, 'ui-ux-implementer:ui-implementation'),
            true,
            `${path.basename(policyFile)} lacks the permanent UI phase`
        )
        assert.equal(
            Object.keys(routes).some((key) => key.startsWith('landing-owner:')),
            false,
            `${path.basename(policyFile)} created an eighth landing role`
        )
        for (const landingRoute of [
            'code-implementer:landing-conflict-resolution',
            'ui-ux-implementer:landing-conflict-resolution'
        ]) {
            assert.equal(
                Object.hasOwn(routes, landingRoute),
                true,
                `${path.basename(policyFile)} lacks ${landingRoute}`
            )
        }
    }
    const routingPolicy = JSON.parse(fs.readFileSync(path.join(
        root,
        'policy/routing-policy.json'
    ), 'utf8'))
    assert.equal(routingPolicy.selectionAuthority, 'none')
    assert.equal(routingPolicy.canonicalRoutePolicyVersion,
        'execution-capability-routing.v4')

    const profileModule = await import(pathToFileURL(path.join(
        root,
        'skills/issue-orchestration/scripts/stage-profile-policy.mjs'
    )).href)
    const classification = {
        domain: 'ui-ux',
        effectiveOwnerRepository: 'ExampleOrg/RepositoryA',
        engineeringRiskClass: 'bounded',
        uiDecisionClass: 'prescribed',
        contractState: 'frozen',
        verificationClass: 'ux-local',
        modelRoutingEvidenceDigest: 'a'.repeat(64),
        routingPolicyVersion: 'stage-model-pool.v3'
    }
    const route = profileModule.compileStageRoutingIdentity({
        ...classification,
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation'
    })
    assert.equal(route.stagePhase, 'ui-implementation')
    assert.deepEqual(route.allowedProfiles, ['sol-low', 'sol-medium'])
    assert.throws(
        () => profileModule.compileStageRoutingIdentity({
            ...classification,
            stageRole: 'ui-ux-implementer',
            stagePhase: 'implementation'
        }),
        { code: 'routing-stage-role-phase' }
    )
    const uiLandingRoute = profileModule.compileStageRoutingIdentity({
        ...classification,
        stageRole: 'ui-ux-implementer',
        stagePhase: 'landing-conflict-resolution'
    })
    assert.deepEqual(uiLandingRoute.allowedProfiles, [
        'terra-medium',
        'terra-high',
        'sol-medium',
        'sol-high',
        'sol-xhigh'
    ])
    const codeLandingRoute = profileModule.compileStageRoutingIdentity({
        ...classification,
        domain: 'generic-code',
        uiDecisionClass: 'none',
        verificationClass: 'focused',
        stageRole: 'code-implementer',
        stagePhase: 'landing-conflict-resolution'
    })
    assert.deepEqual(
        codeLandingRoute.allowedProfiles,
        [
            'terra-medium',
            'terra-high',
            'sol-high',
            'sol-xhigh'
        ]
    )
    assert.throws(
        () => profileModule.compileStageRoutingIdentity({
            ...classification,
            stageRole: 'landing-owner',
            stagePhase: 'landing-conflict-resolution'
        }),
        { code: 'routing-stage-role-phase' }
    )

    const dispatchSource = fs.readFileSync(path.join(
        root,
        'skills/issue-orchestration/scripts',
        'dispatch-receipt.mjs'
    ), 'utf8')
    assert.doesNotMatch(
        dispatchSource,
        /ui-ux-implementer:implementation/u
    )
    const writerProgress = await import(pathToFileURL(path.join(
        root,
        contract.canonicalRuntimeOwners.writerProgress
    )).href)
    assert.equal(
        writerProgress.authorizedStageRoles.includes('landing-owner'),
        false,
        'the historical landing observation label is not an active writer role'
    )
})

test('checkpoint sealing independently rejects fabricated command and Git evidence', async (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/checkpoint-evidence-slice-1.mjs',
            'src/checkpoint-evidence-slice-2.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const compiler = await import(pathToFileURL(path.join(
        root,
        contract.canonicalRuntimeOwners.sliceAndCheckpoint
    )).href)
    const plan = compiler.compileStageWorkPlan(terminalPlanInput({ fixture }))
    const slice = compiler.compileExecutableSlice({
        plan,
        sliceId: plan.orderedSlices[0].sliceId
    })
    fixture.activate(0)
    const observed = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice
    })

    const fabricatedCommand = structuredClone(observed)
    fabricatedCommand.commands[0] = {
        command: 'false',
        exitStatus: 0,
        outputDigest: writerTestDigest({
            stdout: '',
            stderr: ''
        })
    }
    fabricatedCommand.evidenceDigest = writerTestDigest(
        Object.fromEntries(
            Object.entries(fabricatedCommand)
                .filter(([field]) => field !== 'evidenceDigest')
        )
    )
    assert.throws(
        () => compiler.sealProgressCheckpoint({
            plan,
            slice,
            checkpoint: checkpointInput({
                plan,
                slice,
                evidence: fabricatedCommand
            })
        }),
        {
            code: 'checkpoint-invalid',
            message:
                /command evidence does not match an independently rerun command/iu
        }
    )

    const fabricatedGit = structuredClone(observed)
    fabricatedGit.git.worktreeStatus = ' M fabricated-clean.mjs'
    fabricatedGit.evidenceDigest = writerTestDigest(
        Object.fromEntries(
            Object.entries(fabricatedGit)
                .filter(([field]) => field !== 'evidenceDigest')
        )
    )
    assert.throws(
        () => compiler.sealProgressCheckpoint({
            plan,
            slice,
            checkpoint: checkpointInput({
                plan,
                slice,
                evidence: fabricatedGit
            })
        }),
        {
            code: 'checkpoint-invalid',
            message: /Git worktree status does not match independent observation/iu
        }
    )
})

test('a documentation no-change slice seals a complete checkpoint without fabricated files', async (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: ['docs/existing-documentation.md']
    })
    current.after(() => fixture.dispose())
    const compiler = await import(pathToFileURL(path.join(
        root,
        contract.canonicalRuntimeOwners.sliceAndCheckpoint
    )).href)
    const plan = compiler.compileStageWorkPlan(
        documentationReadOnlyPlanInput({ fixture })
    )
    const slice = compiler.compileExecutableSlice({
        plan,
        sliceId: plan.orderedSlices[0].sliceId
    })
    const evidence = observeWriterStageCheckpointEvidence({
        worktreeIdentity: fixture.worktreeIdentity,
        slice,
        requiredFiles: []
    })
    const checkpoint = compiler.sealProgressCheckpoint({
        plan,
        slice,
        checkpoint: checkpointInput({ plan, slice, evidence })
    })

    assert.equal(slice.explicitReadOnlyOutput,
        'verified documentation no-change evidence')
    assert.deepEqual(slice.requiredFiles, [])
    assert.deepEqual(checkpoint.evidence.requiredFiles, [])
    assert.equal(checkpoint.status, 'complete')
    assert.match(checkpoint.checkpointDigest, /^[a-f0-9]{64}$/u)
})

test('a slice terminal receipt advances one slice and only the complete plan becomes candidate-green', async (current) => {
    const fixture = createWriterStageGitFixture({
        filePaths: [
            'src/terminal-gate-slice-1.mjs',
            'src/terminal-gate-slice-2.mjs'
        ]
    })
    current.after(() => fixture.dispose())
    const writerProgress = await import(pathToFileURL(path.join(
        root,
        contract.canonicalRuntimeOwners.writerProgress
    )).href)
    assert.equal(typeof writerProgress.evaluateSliceTerminalGate, 'function')

    const artifacts = compileWriterStageTestArtifacts({
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: 'ExampleOrg/RepositoryA#1874:permanent-terminal-gate',
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: fixture.baseSha,
        epochId: 'epoch-1874-permanent-terminal-gate-001',
        worktreeIdentity: fixture.worktreeIdentity,
        allowedPaths: [...fixture.filePaths],
        requiredFiles: [...fixture.filePaths],
        requiredCommands: fixture.filePaths.map((filePath) =>
            `node --check ${filePath}`),
        sliceId: 'slice-1874-terminal-gate-001',
        sliceCount: 2,
        runId: 'run-1874-permanent-terminal-gate',
        stageAttemptId: 'attempt-1874-permanent-terminal-gate'
    })
    const plan = artifacts.stageWorkPlan
    const artifactsFor = (index) => ({
        ...artifacts,
        executableSlice: artifacts.executableSlices[index],
        compiledPrompt: artifacts.compiledPrompts[index]
    })
    const firstArtifacts = artifactsFor(0)
    const finalArtifacts = artifactsFor(1)
    const firstSlice = firstArtifacts.executableSlice
    const finalSlice = finalArtifacts.executableSlice
    const sealedAuthority = {
        expectedSourceEventDigest: plan.sourceEventDigest,
        expectedSourceLedgerDigest: plan.sourceLedgerDigest
    }
    const first = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: firstArtifacts,
        fixture,
        activateIndexes: [0],
        routeDigest: plan.routingInputDigest,
        completedSlicePrefixDigest: digest([])
    })
    const firstReceipt = writerProgress.sealSliceTerminalReceipt({
        plan,
        slice: firstSlice,
        checkpoint: first.checkpoint,
        compiledPrompt: firstArtifacts.compiledPrompt,
        compiledPromptDigest: firstArtifacts.compiledPrompt.promptDigest,
        routeDigest: first.routeDigest,
        checkpointVerificationReceipt:
            first.checkpointVerificationReceipt,
        sealedAuthority,
        completedSlicePrefixDigest: digest([]),
        priorTerminalReceipts: [],
        changedPaths: [firstSlice.requiredCreatedOrModifiedFiles[0]],
        commandEvidenceDigests:
            first.checkpoint.evidence.commands.map(
                ({ outputDigest }) => outputDigest
            )
    })
    assertDeclaredSchemaProperties(first.checkpoint)
    assertDeclaredSchemaProperties(first.checkpointVerificationReceipt)
    assertDeclaredSchemaProperties(firstReceipt)

    const next = writerProgress.evaluateSliceTerminalGate({
        plan,
        currentSlice: firstSlice,
        currentCheckpoint: first.checkpoint,
        compiledPrompt: firstArtifacts.compiledPrompt,
        checkpointVerificationReceipt:
            first.checkpointVerificationReceipt,
        sealedAuthority,
        completedSlicePrefixDigest: digest([]),
        terminalReceipts: [firstReceipt],
        nextSlice: finalSlice
    })
    assert.equal(next.status, 'completed')
    assert.equal(next.nextState, 'next-slice')
    assert.equal(next.candidateEligible, false)
    assert.equal(next.nextSlice.sliceId, finalSlice.sliceId)
    assert.notEqual(next.nextState, 'candidate-green')

    const prematureGreen = resealReceipt(firstReceipt, {
        stageComplete: true,
        candidateEligible: true
    })
    assert.throws(
        () => writerProgress.evaluateSliceTerminalGate({
            plan,
            currentSlice: firstSlice,
            currentCheckpoint: first.checkpoint,
            compiledPrompt: firstArtifacts.compiledPrompt,
            checkpointVerificationReceipt:
                first.checkpointVerificationReceipt,
            sealedAuthority,
            completedSlicePrefixDigest: digest([]),
            terminalReceipts: [prematureGreen],
            nextSlice: finalSlice
        }),
        /candidate|complete plan|premature|remaining slice|terminal/iu
    )

    const firstPrefix = [{
        planDigest: plan.planDigest,
        sliceId: firstSlice.sliceId,
        sliceDigest: firstSlice.sliceDigest,
        checkpointDigest: first.checkpoint.checkpointDigest,
        checkpointVerificationReceiptDigest:
            first.checkpointVerificationReceipt.receiptDigest,
        tracePrefixDigest:
            first.checkpointVerificationReceipt.machineTracePrefixDigest,
        changedPaths: [...firstReceipt.changedPaths].sort(),
        terminalReceiptDigest: firstReceipt.receiptDigest,
        stageRole: firstSlice.stageRole,
        stagePhase: firstSlice.stagePhase,
        stageAttemptId: plan.stageAttemptId
    }]
    const completedSlicePrefixDigest = digest(firstPrefix)
    const acceptedPriorChangedPaths = [
        firstSlice.requiredCreatedOrModifiedFiles[0]
    ]
    const final = buildVerifiedWriterProgressCheckpoint({
        current,
        artifacts: finalArtifacts,
        fixture,
        activateIndexes: [0, 1],
        routeDigest: plan.routingInputDigest,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest
    })
    const finalReceipt = writerProgress.sealSliceTerminalReceipt({
        plan,
        slice: finalSlice,
        checkpoint: final.checkpoint,
        compiledPrompt: finalArtifacts.compiledPrompt,
        compiledPromptDigest: finalArtifacts.compiledPrompt.promptDigest,
        routeDigest: final.routeDigest,
        checkpointVerificationReceipt:
            final.checkpointVerificationReceipt,
        sealedAuthority,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest,
        priorTerminalReceipts: [firstReceipt],
        changedPaths: [finalSlice.requiredCreatedOrModifiedFiles[0]],
        commandEvidenceDigests:
            final.checkpoint.evidence.commands.map(
                ({ outputDigest }) => outputDigest
            )
    })
    assertDeclaredSchemaProperties(final.checkpoint)
    assertDeclaredSchemaProperties(final.checkpointVerificationReceipt)
    assertDeclaredSchemaProperties(finalReceipt)
    assert.throws(
        () => writerProgress.evaluateSliceTerminalGate({
            plan,
            currentSlice: finalSlice,
            currentCheckpoint: final.checkpoint,
            compiledPrompt: finalArtifacts.compiledPrompt,
            checkpointVerificationReceipt:
                final.checkpointVerificationReceipt,
            sealedAuthority,
            acceptedPriorChangedPaths,
            completedSlicePrefixDigest,
            terminalReceipts: [finalReceipt]
        }),
        /missing|duplicated|out of order|ordered terminal receipts/iu
    )
    const complete = writerProgress.evaluateSliceTerminalGate({
        plan,
        currentSlice: finalSlice,
        currentCheckpoint: final.checkpoint,
        compiledPrompt: finalArtifacts.compiledPrompt,
        checkpointVerificationReceipt:
            final.checkpointVerificationReceipt,
        sealedAuthority,
        acceptedPriorChangedPaths,
        completedSlicePrefixDigest,
        terminalReceipts: [firstReceipt, finalReceipt]
    })
    assert.equal(complete.status, 'completed')
    assert.equal(complete.nextState, 'candidate-green')
    assert.equal(complete.candidateEligible, true)
    assert.equal(complete.nextSlice, null)
})
