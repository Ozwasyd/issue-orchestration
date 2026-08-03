import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    compileWriterStageTestArtifacts
} from './issue-orchestration-writer-stage-test-helper.mjs'
import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtimeStartup = verifiedRuntimeStartup({})
const implementationPath = resolve(
    root,
    'skills/issue-orchestration/scripts/frontier-compiler.mjs'
)
const gatePath = resolve(
    root,
    'skills/issue-orchestration/scripts/check-dag-gate.mjs'
)
const selectorPath = resolve(
    root,
    'skills/issue-orchestration/scripts/scope-selector.mjs'
)
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const artifactPaths = {
    test: 'tests/tools/issue-orchestration-ready-frontier.test.mjs',
    cases: 'tests/fixtures/issue-orchestration/ready-frontier-cases.json',
    acceptance:
        'tests/fixtures/issue-orchestration/ready-frontier-acceptance-map.json',
    expectedFailures:
        'tests/fixtures/issue-orchestration/ready-frontier-expected-initial-failures.json',
    runtimeProbes:
        'tests/fixtures/issue-orchestration/ready-frontier-runtime-probes.json',
    mutations:
        'tests/fixtures/issue-orchestration/ready-frontier-mutation-controls.json',
    contract:
        'tests/fixtures/issue-orchestration/ready-frontier-test-contract.json'
}

function readFixture(path) {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

const cases = readFixture(artifactPaths.cases)
const mutationControls = readFixture(artifactPaths.mutations).controls
const acceptanceMap = readFixture(artifactPaths.acceptance)
const expectedInitialFailures = readFixture(artifactPaths.expectedFailures)
const runtimeProbes = readFixture(artifactPaths.runtimeProbes)
const frozenContract = readFixture(artifactPaths.contract)
const writerEpochId = 'epoch-ready-frontier-1816-001'
const repositoryWorktrees = Object.freeze({
    'Ozwasyd/FsusBlog': resolve(root, '../FsusBlog'),
    'Ozwasyd/FsusUI': resolve(root, '../FsusUI')
})
const repositoryBaseShas = Object.freeze(Object.fromEntries(
    Object.entries(repositoryWorktrees).map(([repository, worktree]) => [
        repository,
        execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: worktree,
            encoding: 'utf8'
        }).trim()
    ])
))
const requiredExports = [
    'computeNodeEligibility',
    'compileReadyFrontier',
    'validateReadyFrontier',
    'selectDispatchCandidates',
    'validateDispatchCandidates'
]

let implementationPromise
let selectorPromise

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function canonical(input) {
    if (Array.isArray(input)) {
        return input
            .map(canonical)
            .sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right))
            )
    }
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(
        Object.keys(input).sort().map((key) => [key, canonical(input[key])])
    )
}

function digest(value) {
    return sha256(JSON.stringify(canonical(value)))
}

function sha256File(path) {
    return sha256(readFileSync(resolve(root, path)))
}

function withDigest(record) {
    return { ...record, digest: digest(record) }
}

function redigest(record) {
    const changed = clone(record)
    delete changed.digest
    return withDigest(changed)
}

async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1816 frontier compiler: ${implementationPath}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing exported function ${name}`)
    }
    return loaded
}

async function selectorImplementation() {
    selectorPromise ??= import(pathToFileURL(selectorPath).href)
    return selectorPromise
}

function remoteIssue(member, index = 0) {
    return {
        repository: member.repository,
        number: member.issueNumber,
        state: 'OPEN',
        stateReason: null,
        updatedAt: `2026-07-31T10:${String(index).padStart(2, '0')}:00.000Z`,
        title: `frontier member ${member.issueId}`,
        body: `Acceptance contract for ${member.issueId}`,
        comments: [
            {
                id: `comment-${member.issueNumber}`,
                body: `Relevant acceptance ${member.issueId}`,
                updatedAt: `2026-07-31T10:${String(index).padStart(2, '0')}:30.000Z`,
                relevant: true
            }
        ],
        labels: ['area:tooling'],
        milestone: null,
        dependsOn: member.dependsOn,
        related: [],
        mentioned: [],
        trackedIssueIds: []
    }
}

function selectorFor(members, version = 'frontier-contract.v1') {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: version,
        type: 'explicit-issues',
        repositories: [...new Set(members.map(({ repository }) => repository))],
        statePolicy: {
            open: 'include',
            closed: 'retain-if-explicit',
            reopen: 'retain'
        },
        dependencyClosure: 'none',
        implicitExpansion: 'forbidden',
        parameters: {
            issueIds: members.map(({ issueId }) => issueId)
        },
        remoteQueryIdentity: `fixture:${version}`
    }
}

function layeredActor(role) {
    if (role === 'test-owner') {
        return clone(cases.layerAuthorityPolicy.testOwnerDispatchFacts)
    }
    if (role === 'dag-creator-updater') {
        return clone(cases.layerAuthorityPolicy.semanticFacts)
    }
    throw new Error(`unsupported layered actor role: ${role}`)
}

function discoveryFacts(member, selectorReceipt) {
    return withDigest({
        schema: cases.layeredSchemas.discovery,
        status: 'complete',
        authoredBy: layeredActor('dag-creator-updater'),
        checkedAt: cases.computedAt,
        inputDigest: digest({
            selectorDigest: selectorReceipt.selectorDigest,
            issueId: member.issueId,
            memberRemoteFactDigest:
                selectorReceipt.remoteFactDigests[member.issueId]
        }),
        issueIdentity: member.issueId,
        issueState: 'OPEN',
        explicitDependencyReferences: [...member.dependsOn],
        scopeMembership: 'selected',
        candidateRepositoryOwner: member.repository,
        selectorDigest: selectorReceipt.selectorDigest,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        memberRemoteFactDigest:
            selectorReceipt.remoteFactDigests[member.issueId]
    })
}

function classificationFacts(member, discovery) {
    return withDigest({
        schema: cases.layeredSchemas.classification,
        status: 'complete',
        authoredBy: layeredActor('dag-creator-updater'),
        checkedAt: cases.computedAt,
        inputDigest: digest({
            discoveryFactsDigest: discovery.digest,
            activeDependencies: member.dependsOn,
            candidateOwnerEvidenceDigest: digest({
                repository: member.repository,
                roots: ['AGENTS.md']
            }),
            requiredInstructionRoots: ['AGENTS.md']
        }),
        discoveryFactsDigest: discovery.digest,
        candidateOwner: member.repository,
        candidateOwnerEvidenceDigest: digest({
            repository: member.repository,
            path: 'skills/issue-orchestration/scripts/frontier-compiler.mjs'
        }),
        activeDependencies: [...member.dependsOn],
        satisfiedDependencies: [],
        candidateConflictDomains: ['issue-orchestration-frontier'],
        candidateResourceDomains: [],
        riskFlags: [],
        requiredInstructionRoots: ['AGENTS.md'],
        confidence: 'confirmed',
        unresolvedDecisions: [],
        candidateReady: true,
        blockedSince: null,
        blockerOwner: null
    })
}

function pathEvidence(path) {
    return {
        path,
        digest: sha256File(path)
    }
}

function sealDispatchInvestigation(record) {
    const sealed = clone(record)
    delete sealed.digest
    sealed.inputDigest = digest({
        classificationFactsDigest: sealed.classificationFactsDigest,
        baseSha: sealed.baseSha,
        worktree: sealed.worktree,
        deliveryEpoch: sealed.deliveryEpoch,
        selectorReceiptDigest: sealed.selectorReceiptDigest,
        memberRemoteFactDigest: sealed.memberRemoteFactDigest,
        nearestAgentsChain: sealed.nearestAgentsChain,
        codePaths: sealed.codePaths,
        testPaths: sealed.testPaths,
        currentDocs: sealed.currentDocs,
        implementationDecision: sealed.implementationDecision,
        acceptanceMap: sealed.acceptanceMap,
        runtimeProbes: sealed.runtimeProbes,
        mutationControls: sealed.mutationControls
    })
    return withDigest(sealed)
}

function dispatchInvestigation(node, selectorReceipt) {
    const record = {
        schema: cases.layeredSchemas.dispatch,
        status: 'complete',
        authoredBy: layeredActor('test-owner'),
        testOwnerId: frozenContract.testOwnerId,
        checkedAt: cases.computedAt,
        blockedSince: null,
        blockerOwner: null,
        baseSha: node.baseSha,
        worktree: frozenContract.worktree,
        deliveryEpoch: cases.deliveryEpoch,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        memberRemoteFactDigest:
            selectorReceipt.remoteFactDigests[node.id],
        classificationFactsDigest: node.classificationFacts.digest,
        nearestAgentsChain: [pathEvidence('AGENTS.md')],
        confirmedOwner: node.ownerRepository,
        allowedTestPaths: [...node.allowedTestPaths],
        allowedImplementationPaths: [...node.allowedImplementationPaths],
        forbiddenPaths: [
            'src/backend/**',
            'src/frontend/**',
            'docs/**',
            'DAG/bootstrap runtime state'
        ],
        codePaths: [
            pathEvidence(
                'skills/issue-orchestration/scripts/frontier-compiler.mjs'
            ),
            pathEvidence(
                'skills/issue-orchestration/scripts/check-dag-gate.mjs'
            )
        ],
        testPaths: [pathEvidence(artifactPaths.test)],
        currentDocs: [
            pathEvidence('docs/development/issue-orchestration-scope.md')
        ],
        implementationDecision: {
            decision:
                'consume one validated layered investigation projection '
                + 'without legacy node investigation fallback',
            noFallback: true
        },
        acceptanceGroup: node.acceptanceGroup,
        acceptanceMap: acceptanceMap.acceptance.map(({ id }) => ({
            id,
            issueId: node.id,
            evidenceRequired: true
        })),
        runtimeProbes: {
            status: 'not-applicable',
            reasonCode: 'deterministic-local-frontier-runtime'
        },
        mutationControls: mutationControls.map(({ id }) => id),
        promptInputs: {
            testCommands: [
                'node --test tests/tools/issue-orchestration-ready-frontier.test.mjs'
            ],
            counterexamples: [
                'legacy node investigation is accepted as dispatch authority',
                'an unvalidated or stale layered projection enters the frontier',
                'root-authored layered facts are trusted'
            ],
            failureClassification: [
                'contract-red',
                'implementation-defect',
                'environment-unavailable'
            ],
            stopConditions: [
                'do not implement a compatibility fallback'
            ]
        },
        issueSpecificEvidenceDigest: digest({
            issueId: node.id,
            classificationFactsDigest: node.classificationFacts.digest,
            acceptanceGroup: node.acceptanceGroup
        })
    }
    return sealDispatchInvestigation(record)
}

function nodeFor(member, selectorReceipt) {
    const allowedTestPaths = [
        `tests/contracts/${member.issueNumber}.test.mjs`,
        `tests/fixtures/contracts/${member.issueNumber}.json`
    ]
    const allowedImplementationPaths = member.surface === 'ui-ux'
        ? [`src/components/frontier-${member.issueNumber}.tsx`]
        : [`.agents/runtime/frontier-${member.issueNumber}.mjs`]
    const node = {
        id: member.issueId,
        repository: member.repository,
        issueNumber: member.issueNumber,
        ownerRepository: member.repository,
        baseSha: repositoryBaseShas[member.repository],
        acceptanceGroup: `member-${member.issueNumber}`,
        surface: member.surface,
        documentationRequired: true,
        activeDependencies: [...member.dependsOn],
        satisfiedDependencies: [],
        allowedTestPaths,
        allowedImplementationPaths,
        modificationBoundaryDigest: digest({
            allowedImplementationPaths,
            allowedTestPaths
        }),
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteFactDigest: selectorReceipt.remoteFactDigests[member.issueId],
        status: 'investigated',
        narration: 'Root-authored prose is deliberately non-authoritative.'
    }
    node.discoveryFacts = discoveryFacts(member, selectorReceipt)
    node.classificationFacts = classificationFacts(
        member,
        node.discoveryFacts
    )
    node.dispatchInvestigation = null
    return node
}

function receipt(status = 'passed', extra = {}) {
    return {
        status,
        receiptDigest: extra.receiptDigest ?? digest({ status, ...extra }),
        ...extra
    }
}

function bindWriterCandidate(member, candidate, stageKind) {
    const stagePhase = stageKind === 'test-contract'
        ? 'test-contract'
        : stageKind === 'documentation'
            ? 'documentation'
            : member.surface === 'ui-ux'
                ? 'ui-implementation'
                : 'implementation'
    return {
        ...candidate,
        ...compileWriterStageTestArtifacts({
            repository: member.repository,
            issue: member.issueNumber,
            node: member.issueId,
            stageRole: candidate.role,
            stagePhase,
            baseSha: repositoryBaseShas[member.repository],
            runId:
                `run-ready-frontier-${member.issueNumber}-${stagePhase}`,
            epochId: writerEpochId,
            worktreeIdentity: repositoryWorktrees[member.repository],
            allowedPaths: candidate.allowedPaths,
            requiredFiles: [candidate.allowedPaths[0]],
            requiredCommands: [
                `node --check ${candidate.allowedPaths[0]}`
            ]
        })
    }
}

function bindTwoSliceTestCandidate(input, member, sliceIndex) {
    const node = input.dag.nodes.find(({ id }) => id === member.issueId)
    const candidate = input.runtimeState.candidates.find(
        (item) => item.issueId === member.issueId &&
            item.stage === 'test-contract-ready'
    )
    const requiredFiles = [...node.allowedTestPaths]
    const artifacts = compileWriterStageTestArtifacts({
        repository: member.repository,
        issue: member.issueNumber,
        node: member.issueId,
        stageRole: 'test-owner',
        stagePhase: 'test-contract',
        baseSha: node.baseSha,
        epochId: writerEpochId,
        worktreeIdentity: repositoryWorktrees[member.repository],
        allowedPaths: requiredFiles,
        requiredFiles,
        requiredCommands: requiredFiles.map((file) =>
            `node --check ${file}`),
        sliceCount: 2
    })
    const slice = artifacts.executableSlices[sliceIndex]
    const compiledPrompt = artifacts.compiledPrompts[sliceIndex]
    Object.assign(candidate, artifacts, {
        executableSlice: slice,
        compiledPrompt,
        sliceDigest: slice.sliceDigest,
        compiledPromptDigest: compiledPrompt.promptDigest,
        promptDigest: compiledPrompt.promptDigest,
        allowedPathsDigest: digest(slice.allowedPaths),
        forbiddenPathsDigest: digest(slice.forbiddenPaths)
    })
    return { artifacts, candidate, compiledPrompt, slice }
}

function roleCandidate(member, stage) {
    const common = {
        issueId: member.issueId,
        stage,
        actorId: `${stage}:${member.issueId}`,
        capabilityReceiptDigest: digest({
            issueId: member.issueId,
            stage,
            capability: true
        })
    }
    if (stage === 'test-contract-ready') {
        return bindWriterCandidate(member, {
            ...common,
            role: 'test-owner',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'leased-writer',
            mutationContract: 'lease-and-slice-allowlist',
            writeScope: 'tests-only',
            allowedPaths: [
                `tests/contracts/${member.issueNumber}.test.mjs`,
                `tests/fixtures/contracts/${member.issueNumber}.json`
            ]
        }, 'test-contract')
    }
    if (stage === 'implementation-ready') {
        if (member.surface === 'ui-ux') {
            return bindWriterCandidate(member, {
                ...common,
                role: 'ui-ux-implementer',
                model: 'gpt-5.6-sol',
                effort: 'low',
                executionClass: 'leased-writer',
                mutationContract: 'lease-and-slice-allowlist',
                writeScope: 'implementation-only',
                allowedPaths: [`src/components/frontier-${member.issueNumber}.tsx`],
                designSkillDigest: 'a'.repeat(64),
                designAuthorityDigests: ['b'.repeat(64)]
            }, 'ui-ux-implementation')
        }
        return bindWriterCandidate(member, {
            ...common,
            role: 'code-implementer',
            model: 'gpt-5.6-sol',
            effort: 'low',
            executionClass: 'leased-writer',
            mutationContract: 'lease-and-slice-allowlist',
            writeScope: 'implementation-only',
            allowedPaths: [`.agents/runtime/frontier-${member.issueNumber}.mjs`]
        }, 'code-implementation')
    }
    if (stage === 'behavior-verification-ready') {
        return {
            ...common,
            role: 'test-owner',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation',
            writeScope: 'none',
            allowedPaths: []
        }
    }
    if (stage === 'ux-acceptance-ready') {
        return {
            ...common,
            role: 'ux-acceptance-verifier',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation',
            writeScope: 'none',
            allowedPaths: [],
            designSkillDigest: 'a'.repeat(64),
            designAuthorityDigests: ['b'.repeat(64)]
        }
    }
    if (stage === 'documentation-ready') {
        return bindWriterCandidate(member, {
            ...common,
            role: 'documentation-writer',
            model: 'gpt-5.6-terra',
            effort: 'medium',
            executionClass: 'leased-writer',
            mutationContract: 'lease-and-slice-allowlist',
            writeScope: 'documentation-only',
            allowedPaths: [`docs/frontier-${member.issueNumber}.md`]
        }, 'documentation')
    }
    return {
        ...common,
        role: 'root-scheduler',
        model: 'gpt-5.6-terra',
        effort: 'low',
        executionClass: 'root-control',
        mutationContract: 'control-plane-and-delivery-gated',
        writeScope: 'orchestration-control-only',
        allowedPaths: []
    }
}

function bindLandingConflictResolution(input, member) {
    const node = input.dag.nodes.find(({ id }) => id === member.issueId)
    setProgress(input, member.issueId, ['testContract'])
    const memberWriterRole = member.surface === 'ui-ux'
        ? 'ui-ux-implementer'
        : 'code-implementer'
    const conflictPaths = [...node.allowedImplementationPaths]
    const conflict = {
        schema: 'issue-orchestration.landing-conflict-resolution.v1',
        status: 'active',
        node: member.issueId,
        baseSha: node.baseSha,
        epochId: writerEpochId,
        worktreeIdentity: repositoryWorktrees[member.repository],
        memberWriterRole,
        conflictSource: 'delivery-failure-receipt',
        conflictSourceDigest: digest({
            node: member.issueId,
            source: 'machine-observed-landing-conflict'
        }),
        deliveryFailureReceiptDigest: digest({
            node: member.issueId,
            eventType: 'delivery.failed',
            failure: 'merge-conflict'
        }),
        conflictMappingDigest: digest({
            node: member.issueId,
            conflictPaths,
            mapping: 'ours-theirs-base'
        }),
        conflictPaths
    }
    conflict.resolutionDigest = digest(conflict)
    const requiredEvidence = [
        `landing-conflict-source:${conflict.conflictSourceDigest}`,
        `delivery-failure-receipt:${conflict.deliveryFailureReceiptDigest}`,
        `landing-conflict-mapping:${conflict.conflictMappingDigest}`
    ]
    const artifacts = compileWriterStageTestArtifacts({
        repository: member.repository,
        issue: member.issueNumber,
        node: member.issueId,
        stageRole: memberWriterRole,
        stagePhase: 'landing-conflict-resolution',
        baseSha: node.baseSha,
        runId: `run-ready-frontier-${member.issueNumber}-landing`,
        epochId: conflict.epochId,
        worktreeIdentity: conflict.worktreeIdentity,
        allowedPaths: conflictPaths,
        requiredFiles: conflictPaths,
        requiredCommands: [
            `node --check ${conflictPaths[0]}`
        ],
        requiredEvidence
    })
    const candidate = {
        issueId: member.issueId,
        stage: 'landing-conflict-resolution-ready',
        actorId:
            `landing-conflict-resolution-ready:${member.issueId}`,
        role: memberWriterRole,
        model: 'gpt-5.6-sol',
        effort: 'low',
        executionClass: 'leased-writer',
        mutationContract: 'lease-and-slice-allowlist',
        writeScope: 'implementation-only',
        allowedPaths: conflictPaths,
        capabilityReceiptDigest: digest({
            issueId: member.issueId,
            stage: 'landing-conflict-resolution-ready',
            capability: true
        }),
        landingConflictResolutionDigest: conflict.resolutionDigest,
        ...(memberWriterRole === 'ui-ux-implementer'
            ? {
                designSkillDigest: 'a'.repeat(64),
                designAuthorityDigests: ['b'.repeat(64)]
            }
            : {}),
        ...artifacts
    }
    input.runtimeState.landingConflictResolutions ??= {}
    input.runtimeState.landingConflictResolutions[member.issueId] =
        conflict
    input.runtimeState.candidates.push(candidate)
    return { candidate, conflict }
}

function runtimeFor(members) {
    return {
        schema: 'issue-orchestration.frontier-runtime.v1',
        repositoryBases: Object.fromEntries(
            Object.entries(cases.repositories).map(([repository]) => [
                repository,
                repositoryBaseShas[repository]
            ])
        ),
        nodeStates: Object.fromEntries(members.map(({ issueId }) => [
            issueId,
            {
                receipts: {},
                terminal: null
            }
        ])),
        activeAttempts: [],
        deliveryFreezes: [],
        exclusiveLeases: [],
        candidates: members.flatMap((member) =>
            cases.stages.map((stage) => roleCandidate(member, stage))
        ),
        remoteFacts: {
            fresh: true,
            observedAt: '2026-08-01T00:00:00.000Z'
        },
        availableSlots: 15,
        rootOnlyDeliveryAction: null
    }
}

function investigationPhase(node) {
    if (!node.discoveryFacts) return null
    if (!node.classificationFacts) return 'discovered'
    if (node.dispatchInvestigation?.status === 'complete') {
        return 'dispatch-investigated'
    }
    return node.classificationFacts.candidateReady
        ? 'candidate-ready'
        : 'dependency-classified'
}

function sealInvestigationProjection(projection, freshness = null) {
    const sealed = clone(projection)
    const previousFreshness = freshness ?? sealed.validation?.freshness
    delete sealed.validation
    delete sealed.projectionDigest
    sealed.inputDigest = digest({
        selectorReceiptDigest: sealed.selectorReceiptDigest,
        remoteSnapshotDigest: sealed.remoteSnapshotDigest,
        nodes: sealed.nodes
    })
    sealed.projectionDigest = digest(sealed)
    const validation = {
        schema: cases.layeredSchemas.validation,
        status: 'passed',
        validator: {
            role: 'layered-investigation-validator',
            model: 'machine',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation'
        },
        selectorReceiptDigest: sealed.selectorReceiptDigest,
        remoteSnapshotDigest: sealed.remoteSnapshotDigest,
        projectionInputDigest: sealed.inputDigest,
        projectionDigest: sealed.projectionDigest,
        validatedAt: cases.computedAt,
        freshness: clone(previousFreshness)
    }
    validation.receiptDigest = digest(validation)
    sealed.validation = validation
    return sealed
}

function rebuildInvestigationProjection(input) {
    const nodes = input.dag.nodes.map((node) => ({
        issueId: node.id,
        phase: investigationPhase(node),
        discoveryFactsDigest: node.discoveryFacts?.digest ?? null,
        classificationFactsDigest: node.classificationFacts?.digest ?? null,
        dispatchInvestigationDigest:
            node.dispatchInvestigation?.digest ?? null,
        selectorReceiptDigest:
            node.discoveryFacts?.selectorReceiptDigest ?? null,
        memberRemoteFactDigest:
            node.discoveryFacts?.memberRemoteFactDigest ?? null,
        baseSha: node.dispatchInvestigation?.baseSha ?? node.baseSha,
        blockedSince: node.classificationFacts?.blockedSince
            ?? node.dispatchInvestigation?.blockedSince
            ?? null,
        blockerOwner: node.classificationFacts?.blockerOwner
            ?? node.dispatchInvestigation?.blockerOwner
            ?? null
    })).sort((left, right) => left.issueId.localeCompare(right.issueId))
    const projection = {
        schema: cases.layeredSchemas.projection,
        valid: true,
        selectorReceiptDigest: input.selectorReceipt.receiptDigest,
        remoteSnapshotDigest: input.selectorReceipt.remoteSnapshotDigest,
        nodes,
        testOwnerCandidates: nodes
            .filter(({ phase }) => phase === 'candidate-ready')
            .map(({ issueId }) => ({ issueId, stage: 'test-contract-ready' })),
        implementationReady: nodes
            .filter(({ phase }) => phase === 'dispatch-investigated')
            .map(({ issueId }) => ({ issueId, stage: 'implementation-ready' })),
        computedAt: cases.computedAt
    }
    const freshness = {
        status: 'current',
        observedAt: cases.computedAt,
        selectorReceiptDigest: input.selectorReceipt.receiptDigest,
        remoteSnapshotDigest: input.selectorReceipt.remoteSnapshotDigest,
        memberRemoteFactDigests: Object.fromEntries(nodes.map((node) => [
            node.issueId,
            node.memberRemoteFactDigest
        ]))
    }
    input.investigationProjection = sealInvestigationProjection(
        projection,
        freshness
    )
}

async function scenario(
    members = cases.canonicalMembers,
    {
        remoteIssues = members.map(remoteIssue),
        selector = selectorFor(members),
        resolvedAt = '2026-08-01T00:00:00.000Z'
    } = {}
) {
    const { resolveSelector } = await selectorImplementation()
    const selectorReceipt = resolveSelector({
        selector: clone(selector),
        remoteIssues: clone(remoteIssues),
        resolvedAt,
        startup: runtimeStartup
    })
    const dag = {
        schema: 'issue-orchestration.dag.v3',
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        nodes: members.map((member) => nodeFor(member, selectorReceipt))
    }
    const runtimeState = runtimeFor(members)
    runtimeState.remoteFacts.selectorReceiptDigest = selectorReceipt.receiptDigest
    runtimeState.remoteFacts.remoteSnapshotDigest =
        selectorReceipt.remoteSnapshotDigest
    const input = {
        dag,
        members: clone(members),
        remoteIssues: clone(remoteIssues),
        runtimeState,
        selector: clone(selector),
        selectorReceipt,
        investigationProjection: null
    }
    const uiMember = members.find(({ surface }) => surface === 'ui-ux')
    if (uiMember) {
        setProgress(input, uiMember.issueId, ['testContract'])
    } else {
        rebuildInvestigationProjection(input)
    }
    return input
}

async function compile(input, computedAt = cases.computedAt) {
    const { compileReadyFrontier } = await implementation()
    return compileReadyFrontier({
        dag: clone(input.dag),
        runtimeState: clone(input.runtimeState),
        selectorReceipt: clone(input.selectorReceipt),
        investigationProjection: clone(input.investigationProjection),
        computedAt
    })
}

function readyKey(candidate) {
    return `${candidate.issueId}@${candidate.stage}`
}

function assertDigest(value, label) {
    assert.match(value, /^[a-f0-9]{64}$/u, `${label} must be lowercase SHA-256`)
}

function assertCanonicalProjection(projection) {
    assert.equal(projection.schema, 'issue-orchestration.frontier-projection.v1')
    assertDigest(projection.eligibilityInputDigest, 'eligibilityInputDigest')
    assertDigest(projection.frontierDigest, 'frontierDigest')
    assert.ok(Array.isArray(projection.readyFrontier))
    assert.ok(Array.isArray(projection.executionProjection))
    assert.deepEqual(
        projection.readyFrontier.map(readyKey),
        projection.readyFrontier.map(readyKey).toSorted()
    )
    assert.equal(typeof projection.notReadyReasons, 'object')
    assert.ok(projection.notReadyReasons && !Array.isArray(projection.notReadyReasons))
    for (const reasons of Object.values(projection.notReadyReasons)) {
        assert.ok(Array.isArray(reasons) && reasons.length > 0)
        const indexes = reasons.map(({ code }) => cases.reasonOrder.indexOf(code))
        assert.ok(indexes.every((index) => index >= 0))
        assert.deepEqual(indexes, indexes.toSorted((left, right) => left - right))
        for (const reason of reasons) {
            assert.equal(typeof reason.evidence, 'object')
            assert.ok(reason.evidence && !Array.isArray(reason.evidence))
            assert.ok(
                typeof reason.evidence.identity === 'string'
                || /^[a-f0-9]{64}$/u.test(reason.evidence.digest ?? ''),
                `${reason.code} must bind direct evidence or identity`
            )
        }
    }
}

async function expectDenied(operation, expectedCode) {
    try {
        const result = await operation()
        assert.equal(result?.valid, false, `expected denial ${expectedCode}`)
        assert.equal(result.code, expectedCode)
        return result
    } catch (error) {
        assert.equal(error?.code, expectedCode, error?.stack ?? String(error))
        return error
    }
}

async function validateFrontier(input, recordedProjection) {
    const { validateReadyFrontier } = await implementation()
    return validateReadyFrontier({
        dag: clone(input.dag),
        runtimeState: clone(input.runtimeState),
        selectorReceipt: clone(input.selectorReceipt),
        investigationProjection: clone(input.investigationProjection),
        recordedProjection: clone(recordedProjection)
    })
}

async function selectDispatch(input, projection, groupProposals = []) {
    const { selectDispatchCandidates } = await implementation()
    return selectDispatchCandidates({
        projection: clone(projection),
        runtimeState: clone(input.runtimeState),
        groupProposals: clone(groupProposals)
    })
}

async function validateDispatch(input, projection, recordedCandidateSet, groupProposals = []) {
    const { validateDispatchCandidates } = await implementation()
    return validateDispatchCandidates({
        projection: clone(projection),
        runtimeState: clone(input.runtimeState),
        groupProposals: clone(groupProposals),
        recordedCandidateSet: clone(recordedCandidateSet)
    })
}

function independentMembers(count, repository = 'Ozwasyd/FsusBlog') {
    return Array.from({ length: count }, (_, index) => ({
        issueId: `${repository}#${9200 + index}`,
        repository,
        issueNumber: 9200 + index,
        surface: 'code',
        dependsOn: []
    }))
}

function setProgress(input, issueId, completedReceipts) {
    const receipts = {}
    for (const name of completedReceipts) {
        receipts[name] = receipt('passed', {
            testOwnerId: name === 'testContract'
                ? frozenContract.testOwnerId
                : undefined,
            testContractDigest: name === 'testContract' ? 'd'.repeat(64) : undefined,
            candidateDigest: name === 'implementation' ? 'e'.repeat(64) : undefined
        })
    }
    input.runtimeState.nodeStates[issueId].receipts = receipts
    const node = input.dag.nodes.find(({ id }) => id === issueId)
    if (completedReceipts.includes('testContract')) {
        node.dispatchInvestigation = dispatchInvestigation(
            node,
            input.selectorReceipt
        )
    } else {
        node.dispatchInvestigation = null
    }
    rebuildInvestigationProjection(input)
}

function markInvestigationIncomplete(input, node) {
    node.classificationFacts.candidateReady = false
    node.classificationFacts.confidence = 'unresolved'
    node.classificationFacts.unresolvedDecisions = ['test-boundary']
    node.classificationFacts.blockedSince = '2026-07-31T23:00:00.000Z'
    node.classificationFacts.blockerOwner = frozenContract.testOwnerId
    node.classificationFacts = redigest(node.classificationFacts)
    node.dispatchInvestigation = null
    rebuildInvestigationProjection(input)
}

function resealSemanticAuthority(input, node) {
    node.discoveryFacts = redigest(node.discoveryFacts)
    node.classificationFacts.discoveryFactsDigest =
        node.discoveryFacts.digest
    node.classificationFacts = redigest(node.classificationFacts)
    if (node.dispatchInvestigation) {
        node.dispatchInvestigation.classificationFactsDigest =
            node.classificationFacts.digest
        node.dispatchInvestigation = sealDispatchInvestigation(
            node.dispatchInvestigation
        )
    }
    rebuildInvestigationProjection(input)
}

function replaceSemanticLayerActors(input, actor) {
    const node = input.dag.nodes[0]
    node.discoveryFacts.authoredBy = clone(actor)
    node.classificationFacts.authoredBy = clone(actor)
    resealSemanticAuthority(input, node)
}

function driftSemanticLayerAuthority(input, layer, field, value) {
    const node = input.dag.nodes[0]
    node[layer].authoredBy[field] = value
    resealSemanticAuthority(input, node)
}

function driftTestOwnerAuthority(input, field, value) {
    const node = input.dag.nodes[0]
    if (field === 'testOwnerId') {
        node.dispatchInvestigation.testOwnerId = value
    } else {
        node.dispatchInvestigation.authoredBy[field] = value
    }
    node.dispatchInvestigation = sealDispatchInvestigation(
        node.dispatchInvestigation
    )
    rebuildInvestigationProjection(input)
}

async function assertLayerAuthorityRuntimePolicy(expectedCode) {
    const rejectionProbe = runtimeProbes.freshVerifierRejectionProbe
    const mutation = rejectionProbe.mutation
    assert.equal(mutation.expectedCode, expectedCode)
    assert.equal(
        rejectionProbe.rejectedReceiptDigest,
        '58f18e70fcd0e716308ba4554bb6815fdccaec49e44171ed5cfcabc7009155c5'
    )
    assert.equal(
        rejectionProbe.candidateIdentityDigest,
        'dcfd8a86f2b6c04a052475e8c95c63efcd42a51c588969179acf2aefef586caf'
    )
    assert.equal(
        rejectionProbe.firstFailureEvidenceDigest,
        '451e9961742d23b09fe909be7fa1158749928bcf8c3acbcabfcf8dc76e4252e3'
    )

    const verifierReplay = await scenario(independentMembers(1))
    replaceSemanticLayerActors(verifierReplay, {
        ...mutation.previousRevisionAcceptedActor,
        [mutation.field]: mutation.to
    })
    await expectDenied(
        () => compile(verifierReplay),
        expectedCode
    )

    const semanticDriftValues = {
        role: 'dag-creator',
        model: 'gpt-5.6-luna',
        effort: 'low',
        executionClass: 'leased-writer',
        freshContext: false
    }
    for (const layer of mutation.layers) {
        for (const field of cases.layerAuthorityPolicy.semanticDriftFields) {
            const input = await scenario(independentMembers(1))
            driftSemanticLayerAuthority(
                input,
                layer,
                field,
                semanticDriftValues[field]
            )
            await expectDenied(() => compile(input), expectedCode)
        }
    }

    const testOwnerDriftValues = {
        role: 'root-scheduler',
        actorId: 'different-test-owner',
        model: 'gpt-5.6-luna',
        effort: 'low',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        writeScope: 'none',
        testOwnerId: 'different-test-owner'
    }
    for (const field of cases.layerAuthorityPolicy.testOwnerDriftFields) {
        const input = await scenario(independentMembers(1))
        setProgress(input, input.dag.nodes[0].id, ['testContract'])
        driftTestOwnerAuthority(input, field, testOwnerDriftValues[field])
        await expectDenied(() => compile(input), expectedCode)
    }
}

async function assertRevision4LayeredIntegrityMutation(control) {
    const verifierProbe =
        runtimeProbes.revision3FreshVerifierRejectionProbe
    const evidence = verifierProbe.mutations.find(
        ({ id }) => id === control.id
    )
    assert.ok(evidence, `missing verifier probe for ${control.id}`)
    assert.equal(evidence.evidenceDigest, control.verifierEvidenceDigest)

    const input = await scenario(independentMembers(1))
    const node = input.dag.nodes[0]
    if (control.id === 'discovery-root-like-actor-id') {
        node.discoveryFacts.authoredBy.actorId =
            'root-scheduler:forged'
        resealSemanticAuthority(input, node)
    } else if (control.id === 'classification-root-like-actor-id') {
        node.classificationFacts.authoredBy.actorId =
            'root-scheduler:forged'
        resealSemanticAuthority(input, node)
    } else if (
        control.id === 'semantic-layer-actor-continuity-drift'
    ) {
        node.classificationFacts.authoredBy.actorId =
            'dag-creator-updater:other'
        resealSemanticAuthority(input, node)
    } else if (control.id === 'dispatch-owner-substitution') {
        setProgress(input, node.id, ['testContract'])
        node.dispatchInvestigation.authoredBy.actorId =
            'test-owner-fsusblog-1816-other'
        node.dispatchInvestigation.testOwnerId =
            'test-owner-fsusblog-1816-other'
        node.dispatchInvestigation = sealDispatchInvestigation(
            node.dispatchInvestigation
        )
        rebuildInvestigationProjection(input)
    } else if (control.id === 'discovery-schema-resigned') {
        node.discoveryFacts.schema =
            'issue-orchestration.discovery-facts.v999'
        resealSemanticAuthority(input, node)
    } else if (
        control.id === 'discovery-status-incomplete-resigned'
    ) {
        node.discoveryFacts.status = 'incomplete'
        resealSemanticAuthority(input, node)
    } else if (control.id === 'discovery-input-digest-resigned') {
        node.discoveryFacts.inputDigest = 'f'.repeat(64)
        resealSemanticAuthority(input, node)
    } else if (control.id === 'validation-root-authored-resigned') {
        const validation = input.investigationProjection.validation
        validation.validator = {
            role: 'root-scheduler',
            actorId: 'root-scheduler:forged',
            model: 'gpt-5.6-sol',
            effort: 'low',
            mode: 'root-only'
        }
        delete validation.receiptDigest
        validation.receiptDigest = digest(validation)
    } else {
        const changed = clone(input.investigationProjection)
        const freshness = clone(changed.validation.freshness)
        if (control.id === 'projection-schema-resigned') {
            changed.schema =
                'issue-orchestration.investigation-projection.v999'
        } else if (
            control.id === 'projection-duplicate-member-resigned'
        ) {
            changed.nodes.push(clone(changed.nodes[0]))
        } else if (
            control.id === 'projection-derived-lists-forged'
        ) {
            changed.testOwnerCandidates = []
            changed.implementationReady = [{
                issueId: node.id,
                stage: 'implementation-ready'
            }]
        } else {
            assert.fail(`unknown revision-4 mutation ${control.id}`)
        }
        input.investigationProjection = sealInvestigationProjection(
            changed,
            freshness
        )
    }
    await expectDenied(() => compile(input), control.expectedCode)
}

function inspectProductionLayeredBinding(
    frontierSource = readFileSync(implementationPath, 'utf8'),
    gateSource = readFileSync(gatePath, 'utf8')
) {
    const legacyRead =
        /\bnode\s*(?:\.\s*investigation\b|\[\s*['"]investigation['"]\s*\])/u
    if (legacyRead.test(frontierSource) || legacyRead.test(gateSource)) {
        return {
            valid: false,
            code: 'legacy-investigation-fallback-forbidden'
        }
    }
    if (!/\binvestigationProjection\b/u.test(frontierSource)) {
        return {
            valid: false,
            code: 'layered-projection-consumer-missing'
        }
    }
    if (!/\binvestigationProjection\b/u.test(gateSource)
        || !/\bvalidateReadyFrontier\s*\(/u.test(gateSource)) {
        return {
            valid: false,
            code: 'layered-projection-binding-missing'
        }
    }
    return { valid: true }
}

test('frozen corrective contract covers every acceptance, probe, and mutation identity', () => {
    assert.equal(cases.schema, 'issue-orchestration.ready-frontier-cases.v2')
    assert.equal(
        acceptanceMap.schema,
        'issue-orchestration.ready-frontier-acceptance-map.v2'
    )
    assert.equal(
        expectedInitialFailures.schema,
        'issue-orchestration.ready-frontier-expected-initial-failures.v2'
    )
    assert.equal(
        runtimeProbes.schema,
        'issue-orchestration.ready-frontier-runtime-probes.v2'
    )
    assert.equal(
        readFixture(artifactPaths.mutations).schema,
        'issue-orchestration.ready-frontier-mutation-controls.v2'
    )
    assert.equal(
        frozenContract.schema,
        'issue-orchestration.ready-frontier-test-contract.v2'
    )
    assert.equal(frozenContract.testOwnerId,
        'test-owner-fsusblog-1816-corrective-18c6003eb5ad')
    assert.equal(frozenContract.issueId, 'Ozwasyd/FsusBlog#1816')
    assert.equal(frozenContract.baseSha,
        '18c6003eb5ad8697f4b74ac2d42a45e74fe18756')
    for (const artifact of [
        cases,
        acceptanceMap,
        expectedInitialFailures,
        runtimeProbes,
        readFixture(artifactPaths.mutations),
        frozenContract
    ]) {
        assert.equal(
            artifact.revision,
            'corrective-layered-integrity-4'
        )
    }
    const exactImplementationPaths = [
        'skills/issue-orchestration/scripts/frontier-compiler.mjs',
        'skills/issue-orchestration/scripts/check-dag-gate.mjs'
    ]
    assert.deepEqual(
        frozenContract.allowedImplementationPaths,
        exactImplementationPaths
    )
    assert.deepEqual(
        frozenContract.minimalImplementationPaths,
        exactImplementationPaths
    )
    assert.equal(
        frozenContract.supersedesTestContractDigest,
        'c61e9ba9a231e7f2dea43b77df7b02b8869e8234a07fdfd777e0b94c5219699d'
    )
    assert.deepEqual(
        frozenContract.testContractHistory.map(
            ({ testContractDigest }) => testContractDigest
        ),
        [
            '0d1a03bf57e6bee57194b35f79e16222c1e5ec6af7311b18310b2c8bac47d976',
            'f19115196b933b984c6d5107141127380ffa47f6bafbc059b150b1b39b534fb3',
            'c61e9ba9a231e7f2dea43b77df7b02b8869e8234a07fdfd777e0b94c5219699d'
        ]
    )
    assert.equal(
        frozenContract.freshVerifierRejection.rejectedReceiptDigest,
        '58f18e70fcd0e716308ba4554bb6815fdccaec49e44171ed5cfcabc7009155c5'
    )
    assert.equal(
        frozenContract.freshVerifierRejection.firstFailureEvidenceDigest,
        '451e9961742d23b09fe909be7fa1158749928bcf8c3acbcabfcf8dc76e4252e3'
    )
    assert.equal(
        frozenContract.revision3FreshVerifierRejection
            .rejectedReceiptDigest,
        'cc0b0e8be529cd507b7aec12b64b5a605dda168dcb12823f494cd96bcd06b7f9'
    )
    assert.equal(
        frozenContract.revision3FreshVerifierRejection
            .aggregateFailureEvidenceDigest,
        '0d1626b6ac055d68c94f0d63a5360e188906eae98929b414841f8bff11a82305'
    )
    assert.deepEqual(cases.layerAuthorityPolicy.semanticFacts, {
        role: 'dag-creator-updater',
        actorId: 'dag-creator-updater:frontier-fixture',
        model: 'gpt-5.6-sol',
        effort: 'max',
        executionClass: 'observe-only',
        mutationContract: 'no-protected-mutation',
        freshContext: true,
        proposalOnly: true
    })
    assert.deepEqual(
        cases.layerAuthorityPolicy.testOwnerDispatchFacts,
        {
            role: 'test-owner',
            actorId: frozenContract.testOwnerId,
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'leased-writer',
            mutationContract: 'lease-and-slice-allowlist',
            writeScope: 'tests-only'
        }
    )
    assert.deepEqual(
        cases.layerIntegrityPolicy.validationActor,
        {
            role: 'layered-investigation-validator',
            model: 'machine',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation'
        }
    )
    assert.deepEqual(
        frozenContract.allowedTestPaths.toSorted(),
        Object.values(artifactPaths).toSorted()
    )
    assert.equal(frozenContract.acceptanceMap, artifactPaths.acceptance)
    assert.equal(
        frozenContract.expectedInitialFailures,
        artifactPaths.expectedFailures
    )
    assert.equal(frozenContract.runtimeProbes, artifactPaths.runtimeProbes)
    assert.equal(frozenContract.mutationControls, artifactPaths.mutations)
    const observedHashes = Object.fromEntries(
        Object.values(artifactPaths)
            .filter((path) => path !== artifactPaths.contract)
            .map((path) => [path, sha256File(path)])
    )
    assert.deepEqual(frozenContract.fileHashes, observedHashes)
    assert.equal(
        frozenContract.frozenTreeDigest,
        digest(observedHashes)
    )
    const unsignedContract = clone(frozenContract)
    delete unsignedContract.testContractDigest
    assert.equal(
        frozenContract.testContractDigest,
        digest(unsignedContract)
    )
    assert.deepEqual(cases.reasonOrder, [
        'dependency-unsatisfied',
        'investigation-incomplete',
        'owner-unresolved',
        'base-drift',
        'scope-drift',
        'active-attempt',
        'terminal-unchanged',
        'executable-slice-missing',
        'runtime-capability-missing',
        'delivery-frozen',
        'exclusive-lease-held',
        'remote-facts-stale'
    ])
    assert.equal(new Set(cases.stages).size, 7)
    assert.equal(new Set(mutationControls.map(({ id }) => id)).size, mutationControls.length)
    const mapped = new Set(
        acceptanceMap.acceptance.flatMap(({ mutations }) => mutations)
    )
    assert.deepEqual(
        [...mapped].sort(),
        mutationControls.map(({ id }) => id).sort()
    )
    assert.equal(runtimeProbes.oldCorrectBaselineProbe.tests, 48)
    assert.equal(runtimeProbes.oldCorrectBaselineProbe.passed, 48)
    assert.equal(runtimeProbes.oldCorrectBaselineProbe.failed, 0)
    assert.equal(expectedInitialFailures.expectedStatus, 'red')
    assert.ok(expectedInitialFailures.firstFailure)
})

test('[L01] canonical fixture is layered-only and carries a validated projection', async () => {
    const input = await scenario()
    for (const node of input.dag.nodes) {
        assert.equal(Object.hasOwn(node, 'investigation'), false)
        assert.equal(node.discoveryFacts.schema, cases.layeredSchemas.discovery)
        assert.equal(node.discoveryFacts.status, 'complete')
        assert.equal(
            node.discoveryFacts.inputDigest,
            digest({
                selectorDigest: node.discoveryFacts.selectorDigest,
                issueId: node.id,
                memberRemoteFactDigest:
                    node.discoveryFacts.memberRemoteFactDigest
            })
        )
        assert.equal(
            node.classificationFacts.schema,
            cases.layeredSchemas.classification
        )
        assert.deepEqual(
            node.discoveryFacts.authoredBy,
            cases.layerAuthorityPolicy.semanticFacts
        )
        assert.deepEqual(
            node.classificationFacts.authoredBy,
            cases.layerAuthorityPolicy.semanticFacts
        )
        if (node.dispatchInvestigation) {
            assert.deepEqual(
                node.dispatchInvestigation.authoredBy,
                cases.layerAuthorityPolicy.testOwnerDispatchFacts
            )
            assert.equal(
                node.dispatchInvestigation.testOwnerId,
                frozenContract.testOwnerId
            )
        }
        assert.equal(
            node.discoveryFacts.digest,
            digest(Object.fromEntries(Object.entries(node.discoveryFacts)
                .filter(([key]) => key !== 'digest')))
        )
        assert.equal(
            node.classificationFacts.digest,
            digest(Object.fromEntries(Object.entries(node.classificationFacts)
                .filter(([key]) => key !== 'digest')))
        )
    }
    assert.equal(
        input.investigationProjection.schema,
        cases.layeredSchemas.projection
    )
    assert.equal(input.investigationProjection.validation.status, 'passed')
    assert.deepEqual(
        input.investigationProjection.validation.validator,
        cases.layerIntegrityPolicy.validationActor
    )
    assert.equal(
        input.investigationProjection.validation.projectionDigest,
        input.investigationProjection.projectionDigest
    )
    assert.equal(
        input.investigationProjection.validation.selectorReceiptDigest,
        input.selectorReceipt.receiptDigest
    )
    const projectedIds = input.investigationProjection.nodes.map(
        ({ issueId }) => issueId
    )
    assert.equal(new Set(projectedIds).size, input.dag.nodes.length)
    assert.equal(projectedIds.length, input.dag.nodes.length)
    assert.deepEqual(
        input.investigationProjection.testOwnerCandidates,
        input.investigationProjection.nodes
            .filter(({ phase }) => phase === 'candidate-ready')
            .map(({ issueId }) => ({
                issueId,
                stage: 'test-contract-ready'
            }))
    )
    assert.deepEqual(
        input.investigationProjection.implementationReady,
        input.investigationProjection.nodes
            .filter(({ phase }) => phase === 'dispatch-investigated')
            .map(({ issueId }) => ({
                issueId,
                stage: 'implementation-ready'
            }))
    )
})

test('[TRUST-01] MUTATION layer-authority-runtime-policy-drift is killed with investigation-layer-authority', async () => {
    await assertLayerAuthorityRuntimePolicy(
        'investigation-layer-authority'
    )
})

test('[F01] compiler emits the canonical maximal member-stage projection', async () => {
    const input = await scenario()
    const projection = await compile(input)
    assertCanonicalProjection(projection)
    assert.deepEqual(
        projection.readyFrontier,
        cases.expectedCanonicalReadyFrontier
    )
    assert.deepEqual(
        Object.fromEntries(Object.entries(projection.notReadyReasons).map(
            ([issueId, reasons]) => [issueId, reasons.map(({ code }) => code)]
        )),
        cases.expectedCanonicalNotReady
    )
    const validation = await validateFrontier(input, projection)
    assert.equal(validation.valid, true)
})

test('[L02] candidate-ready unlocks only test-contract and later stages require dispatch investigation', async () => {
    const input = await scenario(independentMembers(1))
    const issueId = input.dag.nodes[0].id
    assert.equal(
        input.investigationProjection.nodes[0].phase,
        'candidate-ready'
    )
    const testContractFrontier = await compile(input)
    assert.deepEqual(testContractFrontier.readyFrontier, [{
        issueId,
        stage: 'test-contract-ready'
    }])

    setProgress(input, issueId, ['testContract'])
    assert.equal(
        input.investigationProjection.nodes[0].phase,
        'dispatch-investigated'
    )
    const implementationFrontier = await compile(input)
    assert.deepEqual(implementationFrontier.readyFrontier, [{
        issueId,
        stage: 'implementation-ready'
    }])

    input.dag.nodes[0].dispatchInvestigation = null
    rebuildInvestigationProjection(input)
    const missingDispatch = await compile(input)
    assert.deepEqual(missingDispatch.readyFrontier, [])
    assert.deepEqual(
        missingDispatch.notReadyReasons[issueId].map(({ code }) => code),
        ['investigation-incomplete']
    )
})

test('[F02] issue, dependency, candidate, and traversal order do not affect digests', async () => {
    const input = await scenario()
    const original = await compile(input, cases.computedAt)
    const reordered = clone(input)
    reordered.dag.nodes.reverse()
    for (const node of reordered.dag.nodes) {
        node.activeDependencies.reverse()
        node.allowedTestPaths.reverse()
        node.allowedImplementationPaths.reverse()
        node.discoveryFacts.explicitDependencyReferences.reverse()
        node.classificationFacts.activeDependencies.reverse()
        node.classificationFacts.requiredInstructionRoots.reverse()
        node.dispatchInvestigation?.codePaths.reverse()
        node.dispatchInvestigation?.testPaths.reverse()
        node.dispatchInvestigation?.currentDocs.reverse()
        node.dispatchInvestigation?.acceptanceMap.reverse()
        node.dispatchInvestigation?.mutationControls.reverse()
    }
    reordered.runtimeState.candidates.reverse()
    reordered.investigationProjection.nodes.reverse()
    reordered.investigationProjection.testOwnerCandidates.reverse()
    reordered.investigationProjection.implementationReady.reverse()
    const replay = await compile(reordered, cases.laterComputedAt)
    assert.deepEqual(replay.readyFrontier, original.readyFrontier)
    assert.deepEqual(replay.notReadyReasons, original.notReadyReasons)
    assert.equal(replay.eligibilityInputDigest, original.eligibilityInputDigest)
    assert.equal(replay.frontierDigest, original.frontierDigest)
})

test('[F03] all twelve blocker reasons are stable and directly evidence-bound', async (current) => {
    const reasonCases = {
        'dependency-unsatisfied': async () => scenario(),
        'investigation-incomplete': async () => {
            const input = await scenario(independentMembers(1))
            markInvestigationIncomplete(input, input.dag.nodes[0])
            return input
        },
        'owner-unresolved': async () => {
            const input = await scenario(independentMembers(1))
            delete input.dag.nodes[0].ownerRepository
            return input
        },
        'base-drift': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
            return input
        },
        'scope-drift': async () => {
            const input = await scenario(independentMembers(1))
            input.dag.nodes[0].remoteFactDigest = 'f'.repeat(64)
            return input
        },
        'active-attempt': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.activeAttempts.push({
                attemptId: 'attempt-1',
                issueId: input.dag.nodes[0].id,
                stage: 'test-contract-ready',
                leaseId: 'lease-attempt-1'
            })
            return input
        },
        'terminal-unchanged': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.nodeStates[input.dag.nodes[0].id].terminal = {
                category: 'externally_blocked',
                recoveryFingerprint: 'terminal-fingerprint-1',
                observedRecoveryFingerprint: 'terminal-fingerprint-1',
                evidenceDigest: '1'.repeat(64)
            }
            return input
        },
        'executable-slice-missing': async () => {
            const input = await scenario(independentMembers(1))
            delete input.runtimeState.candidates[0].compiledPrompt
            return input
        },
        'runtime-capability-missing': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.candidates = []
            return input
        },
        'delivery-frozen': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.deliveryFreezes.push({
                freezeId: 'delivery-freeze-1',
                issueIds: [input.dag.nodes[0].id],
                evidenceDigest: '2'.repeat(64)
            })
            return input
        },
        'exclusive-lease-held': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.exclusiveLeases.push({
                leaseId: 'exclusive-lease-1',
                issueId: input.dag.nodes[0].id,
                holderIssueId: 'Ozwasyd/FsusBlog#9999',
                conflictKey: 'orchestration-schema'
            })
            return input
        },
        'remote-facts-stale': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.remoteFacts.fresh = false
            return input
        }
    }

    for (const reason of cases.reasonOrder) {
        await current.test(reason, async () => {
            const input = await reasonCases[reason]()
            const projection = await compile(input)
            const issueId = reason === 'dependency-unsatisfied'
                ? 'Ozwasyd/FsusBlog#9102'
                : input.dag.nodes[0].id
            const emitted = projection.notReadyReasons[issueId]
            assert.ok(emitted, `${reason} was not emitted`)
            const observed = emitted.find(({ code }) => code === reason)
            assert.ok(observed, JSON.stringify(emitted, null, 2))
            assert.ok(
                typeof observed.evidence.identity === 'string'
                || /^[a-f0-9]{64}$/u.test(observed.evidence.digest ?? '')
            )
        })
    }
})

test('[F04] multiple blocker reasons follow the frozen canonical reason order', async () => {
    const input = await scenario(independentMembers(1))
    const issueId = input.dag.nodes[0].id
    delete input.dag.nodes[0].ownerRepository
    markInvestigationIncomplete(input, input.dag.nodes[0])
    input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
    input.runtimeState.candidates = []
    input.runtimeState.remoteFacts.fresh = false
    const projection = await compile(input)
    assert.deepEqual(
        projection.notReadyReasons[issueId].map(({ code }) => code),
        [
            'investigation-incomplete',
            'owner-unresolved',
            'base-drift',
            'executable-slice-missing',
            'runtime-capability-missing',
            'remote-facts-stale'
        ]
    )
})

test('[F05] the validator independently rejects root-edited frontier and reasons', async () => {
    const input = await scenario()
    const projection = await compile(input)
    const omitted = clone(projection)
    omitted.readyFrontier.shift()
    await expectDenied(
        () => validateFrontier(input, omitted),
        'frontier-projection-mismatch'
    )
    const editedReason = clone(projection)
    editedReason.notReadyReasons['Ozwasyd/FsusBlog#9102'][0].code =
        'investigation-incomplete'
    await expectDenied(
        () => validateFrontier(input, editedReason),
        'frontier-projection-mismatch'
    )
})

test('[F05A] writer readiness fails closed without any compiler-owned artifact link', async () => {
    const fields = [
        'planDigest',
        'sliceDigest',
        'compiledPromptDigest',
        'stageWorkPlan',
        'executableSlice',
        'compiledPrompt'
    ]
    for (const field of fields) {
        const input = await scenario(independentMembers(1))
        delete input.runtimeState.candidates[0][field]
        const projection = await compile(input)
        const issueId = input.dag.nodes[0].id
        assert.deepEqual(projection.readyFrontier, [], field)
        assert.equal(
            projection.notReadyReasons[issueId][0].code,
            'executable-slice-missing',
            field
        )
    }
})

test('[F05AA] two-slice writer readiness consumes only the projection-owned next slice', async () => {
    const member = independentMembers(1)[0]

    const initial = await scenario([member])
    const first = bindTwoSliceTestCandidate(initial, member, 0)
    const initialProjection = await compile(initial)
    assert.deepEqual(initialProjection.readyFrontier, [{
        issueId: member.issueId,
        stage: 'test-contract-ready'
    }])
    assert.equal(
        initialProjection.executionProjection[0]
            .writerSequenceBinding.source,
        'initial-stage-plan'
    )
    assert.equal(
        initialProjection.executionProjection[0]
            .writerSequenceBinding.sliceIndex,
        0
    )

    const outOfOrder = await scenario([member])
    bindTwoSliceTestCandidate(outOfOrder, member, 1)
    const deniedOutOfOrder = await compile(outOfOrder)
    assert.deepEqual(deniedOutOfOrder.readyFrontier, [])
    assert.ok(deniedOutOfOrder.notReadyReasons[member.issueId]
        .some(({ code }) => code === 'executable-slice-missing'))

    const next = await scenario([member])
    const second = bindTwoSliceTestCandidate(next, member, 1)
    next.runtimeState.writerStageProjection = {
        [member.issueId]: {
            runId: second.artifacts.stageWorkPlan.runId,
            repository: second.artifacts.stageWorkPlan.repository,
            issue: second.artifacts.stageWorkPlan.issue,
            node: member.issueId,
            baseSha: second.artifacts.stageWorkPlan.baseSha,
            epochId: second.artifacts.stageWorkPlan.epochId,
            worktreeIdentity:
                second.artifacts.stageWorkPlan.worktreeIdentity,
            stageRole: second.artifacts.stageWorkPlan.stageRole,
            stagePhase: second.artifacts.stageWorkPlan.stagePhase,
            stageAttemptId:
                second.artifacts.stageWorkPlan.stageAttemptId,
            planDigest: second.artifacts.planDigest,
            sliceId: second.artifacts.executableSlices[0].sliceId,
            sliceDigest:
                second.artifacts.executableSlices[0].sliceDigest,
            compiledPromptDigest:
                second.artifacts.compiledPrompts[0].promptDigest,
            completedSliceReceiptDigests: ['8'.repeat(64)],
            expectedNextSliceId: second.slice.sliceId,
            expectedNextSliceDigest: second.slice.sliceDigest,
            status: 'next-slice'
        }
    }
    const nextProjection = await compile(next)
    assert.deepEqual(nextProjection.readyFrontier, [{
        issueId: member.issueId,
        stage: 'test-contract-ready'
    }])
    assert.equal(
        nextProjection.executionProjection[0]
            .writerSequenceBinding.source,
        'semantic-runtime-projection'
    )
    assert.equal(
        nextProjection.executionProjection[0]
            .writerSequenceBinding.sliceIndex,
        1
    )
    assert.deepEqual(
        nextProjection.executionProjection[0]
            .writerSequenceBinding.completedSliceReceiptDigests,
        ['8'.repeat(64)]
    )

    const forged = clone(next)
    forged.runtimeState.writerStageProjection[member.issueId]
        .expectedNextSliceDigest = '0'.repeat(64)
    const deniedForgery = await compile(forged)
    assert.deepEqual(deniedForgery.readyFrontier, [])
    assert.ok(deniedForgery.notReadyReasons[member.issueId]
        .some(({ code }) => code === 'executable-slice-missing'))

    const newAttempt = clone(next)
    newAttempt.runtimeState.writerStageProjection[member.issueId]
        .stageAttemptId = 'caller-defined-new-attempt'
    const deniedAttempt = await compile(newAttempt)
    assert.deepEqual(deniedAttempt.readyFrontier, [])
    assert.ok(deniedAttempt.notReadyReasons[member.issueId]
        .some(({ code }) => code === 'executable-slice-missing'))

    assert.equal(first.artifacts.stageWorkPlan.orderedSlices.length, 2)
})

test('[F05B] landing conflict readiness reuses the member code or UI writer with a verified slice chain', async () => {
    for (const member of [
        independentMembers(1)[0],
        {
            issueId: 'Ozwasyd/FsusBlog#9298',
            repository: 'Ozwasyd/FsusBlog',
            issueNumber: 9298,
            surface: 'ui-ux',
            dependsOn: []
        }
    ]) {
        const input = await scenario([member])
        const { candidate, conflict } =
            bindLandingConflictResolution(input, member)
        const projection = await compile(input)
        assert.deepEqual(projection.readyFrontier, [{
            issueId: member.issueId,
            stage: 'landing-conflict-resolution-ready'
        }])
        assert.equal(
            projection.executionProjection[0]
                .landingConflictResolutionDigest,
            conflict.resolutionDigest
        )
        assert.equal(candidate.stageWorkPlan.stageRole,
            conflict.memberWriterRole)
        assert.equal(candidate.stageWorkPlan.stagePhase,
            'landing-conflict-resolution')
        assert.notEqual(candidate.role, 'landing-owner')
    }
})

test('[F05C] incomplete or identity-drifted landing evidence blocks readiness without implementation fallback', async () => {
    const requiredFields = [
        'conflictSourceDigest',
        'deliveryFailureReceiptDigest',
        'conflictMappingDigest',
        'node',
        'baseSha',
        'epochId',
        'worktreeIdentity',
        'memberWriterRole',
        'resolutionDigest'
    ]
    for (const field of requiredFields) {
        const member = independentMembers(1)[0]
        const input = await scenario([member])
        bindLandingConflictResolution(input, member)
        delete input.runtimeState
            .landingConflictResolutions[member.issueId][field]
        const projection = await compile(input)
        assert.deepEqual(projection.readyFrontier, [], field)
        assert.ok(
            projection.notReadyReasons[member.issueId]
                .some(({ code }) => code === 'executable-slice-missing'),
            field
        )
    }

    const member = independentMembers(1)[0]
    const fallback = await scenario([member])
    bindLandingConflictResolution(fallback, member)
    fallback.runtimeState.candidates =
        fallback.runtimeState.candidates.filter(
            ({ stage }) =>
                stage !== 'landing-conflict-resolution-ready'
        )
    const fallbackProjection = await compile(fallback)
    assert.deepEqual(fallbackProjection.readyFrontier, [])
    assert.deepEqual(
        fallbackProjection.notReadyReasons[member.issueId]
            .map(({ code }) => code),
        ['executable-slice-missing', 'runtime-capability-missing']
    )

    const forged = await scenario([member])
    const { conflict } =
        bindLandingConflictResolution(forged, member)
    conflict.worktreeIdentity = 'different-worktree'
    delete conflict.resolutionDigest
    conflict.resolutionDigest = digest(conflict)
    forged.runtimeState.landingConflictResolutions[member.issueId] =
        conflict
    const forgedProjection = await compile(forged)
    assert.deepEqual(forgedProjection.readyFrontier, [])
    assert.ok(
        forgedProjection.notReadyReasons[member.issueId]
            .some(({ code }) => code === 'executable-slice-missing')
    )
})

test('[F05D] landing-owner and ordinary implementation prompts cannot enter the landing frontier', async () => {
    const member = independentMembers(1)[0]
    const input = await scenario([member])
    const { candidate } =
        bindLandingConflictResolution(input, member)
    candidate.role = 'landing-owner'
    const ownerProjection = await compile(input)
    assert.deepEqual(ownerProjection.readyFrontier, [])
    assert.ok(
        ownerProjection.notReadyReasons[member.issueId]
            .some(({ code }) => code === 'runtime-capability-missing')
    )

    const fallback = await scenario([member])
    const { conflict } =
        bindLandingConflictResolution(fallback, member)
    const ordinary = fallback.runtimeState.candidates.find(
        ({ stage }) => stage === 'implementation-ready'
    )
    ordinary.stage = 'landing-conflict-resolution-ready'
    ordinary.landingConflictResolutionDigest =
        conflict.resolutionDigest
    fallback.runtimeState.candidates =
        fallback.runtimeState.candidates.filter(
            (entry) => entry === ordinary ||
                entry.stage !== 'landing-conflict-resolution-ready'
        )
    const ordinaryProjection = await compile(fallback)
    assert.deepEqual(ordinaryProjection.readyFrontier, [])
    assert.ok(
        ordinaryProjection.notReadyReasons[member.issueId]
            .some(({ code }) => code === 'executable-slice-missing')
    )
})

test('[F06] an empty frontier is proven by complete blocker coverage', async () => {
    const input = await scenario(independentMembers(3))
    for (const node of input.dag.nodes) {
        markInvestigationIncomplete(input, node)
    }
    const projection = await compile(input)
    assert.deepEqual(projection.readyFrontier, [])
    assert.deepEqual(
        Object.keys(projection.notReadyReasons).sort(),
        input.dag.nodes.map(({ id }) => id).sort()
    )
})

test('[F07] valid completed tombstones unlock and reopen removes dependents', async () => {
    const dependent = {
        issueId: 'Ozwasyd/FsusBlog#9301',
        repository: 'Ozwasyd/FsusBlog',
        issueNumber: 9301,
        surface: 'code',
        dependsOn: ['Ozwasyd/FsusBlog#9300']
    }
    const input = await scenario([dependent])
    input.dag.nodes[0].activeDependencies = []
    input.dag.nodes[0].satisfiedDependencies = [{
        issue: 'Ozwasyd/FsusBlog#9300',
        repository: 'Ozwasyd/FsusBlog',
        issueNumber: 9300,
        remoteState: 'CLOSED',
        stateReason: 'completed',
        evidenceDigest: '3'.repeat(64),
        deliveredCommit: cases.repositories['Ozwasyd/FsusBlog'].baseSha
    }]
    const unlocked = await compile(input)
    assert.deepEqual(unlocked.readyFrontier, [{
        issueId: dependent.issueId,
        stage: 'test-contract-ready'
    }])
    input.dag.nodes[0].satisfiedDependencies[0].remoteState = 'OPEN'
    input.dag.nodes[0].satisfiedDependencies[0].stateReason = null
    const reopened = await compile(input)
    assert.deepEqual(reopened.readyFrontier, [])
    assert.deepEqual(
        reopened.notReadyReasons[dependent.issueId].map(({ code }) => code),
        ['dependency-unsatisfied']
    )
})

test('[F08] remote, base, terminal, and candidate permission drift invalidate old input', async () => {
    const input = await scenario(independentMembers(1))
    const projection = await compile(input)
    const drifts = [
        (changed) => {
            changed.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
        },
        (changed) => {
            changed.runtimeState.candidates[0].allowedPaths.push('tests/forbidden.test.mjs')
        },
        (changed) => {
            changed.runtimeState.nodeStates[changed.dag.nodes[0].id].terminal = {
                category: 'externally_blocked',
                recoveryFingerprint: 'before',
                observedRecoveryFingerprint: 'after',
                evidenceDigest: '4'.repeat(64)
            }
        }
    ]
    for (const mutate of drifts) {
        const changed = clone(input)
        mutate(changed)
        await expectDenied(
            () => validateFrontier(changed, projection),
            'frontier-input-digest-mismatch'
        )
    }

    const changedIssues = clone(input.remoteIssues)
    changedIssues[0].comments[0].body += ' changed'
    const changed = await scenario(input.members, {
        remoteIssues: changedIssues,
        selector: {
            ...input.selector,
            selectorVersion: 'frontier-contract.v2'
        }
    })
    await expectDenied(
        () => validateFrontier(changed, projection),
        'frontier-input-digest-mismatch'
    )
})

test('[S01] non-UI stage progression is deterministic through cleanup', async () => {
    const input = await scenario(independentMembers(1))
    const issueId = input.dag.nodes[0].id
    const progression = [
        [[], 'test-contract-ready'],
        [['testContract'], 'implementation-ready'],
        [['testContract', 'implementation'], 'behavior-verification-ready'],
        [['testContract', 'implementation', 'behavior'], 'documentation-ready'],
        [['testContract', 'implementation', 'behavior', 'documentation'], 'delivery-ready'],
        [['testContract', 'implementation', 'behavior', 'documentation', 'delivery'], 'cleanup-ready']
    ]
    for (const [receipts, expectedStage] of progression) {
        setProgress(input, issueId, receipts)
        const projection = await compile(input)
        assert.deepEqual(projection.readyFrontier, [{
            issueId,
            stage: expectedStage
        }])
    }
    setProgress(input, issueId, [
        'testContract',
        'implementation',
        'behavior',
        'documentation',
        'delivery',
        'cleanup'
    ])
    const closed = await compile(input)
    assert.deepEqual(closed.readyFrontier, [])
    assert.deepEqual(closed.notReadyReasons, {})
})

test('[S02] UI behavior green advances only to UX acceptance, then documentation', async () => {
    const member = {
        issueId: 'Ozwasyd/FsusUI#2950',
        repository: 'Ozwasyd/FsusUI',
        issueNumber: 2950,
        surface: 'ui-ux',
        dependsOn: []
    }
    const input = await scenario([member])
    setProgress(input, member.issueId, [
        'testContract',
        'implementation',
        'behavior'
    ])
    const beforeUx = await compile(input)
    assert.deepEqual(beforeUx.readyFrontier, [{
        issueId: member.issueId,
        stage: 'ux-acceptance-ready'
    }])
    setProgress(input, member.issueId, [
        'testContract',
        'implementation',
        'behavior',
        'uxAcceptance'
    ])
    const afterUx = await compile(input)
    assert.deepEqual(afterUx.readyFrontier, [{
        issueId: member.issueId,
        stage: 'documentation-ready'
    }])
})

test('[S03] local stage progress changes execution frontier without semantic DAG update', async () => {
    const input = await scenario(independentMembers(1))
    const first = await compile(input)
    setProgress(input, input.dag.nodes[0].id, ['testContract'])
    const second = await compile(input)
    assert.notEqual(second.frontierDigest, first.frontierDigest)
    assert.equal(
        input.selectorReceipt.remoteSnapshotDigest,
        input.dag.remoteSnapshotDigest
    )
    const { evaluateDagUpdate } = await selectorImplementation()
    const update = evaluateDagUpdate({
        previousRemoteSnapshotDigest: input.selectorReceipt.remoteSnapshotDigest,
        currentReceipt: input.selectorReceipt,
        executionEvents: [{ type: 'local-stage-progressed' }],
        launchRequest: null
    })
    assert.equal(update.semanticAction, 'none')
    assert.equal(update.dagUpdateRequired, false)
})

test('[R01] node model and effort fields have no routing authority', async () => {
    const input = await scenario(independentMembers(1))
    const candidate = input.runtimeState.candidates.find(
        ({ stage }) => stage === 'test-contract-ready'
    )
    candidate.effort = 'low'
    const projection = await compile(input)
    assert.deepEqual(projection.notReadyReasons, {})
    assert.equal(
        Object.hasOwn(projection.executionProjection[0], 'model'),
        false
    )
    assert.equal(
        Object.hasOwn(projection.executionProjection[0], 'effort'),
        false
    )
})

test('[R02] UI implementation rejects ordinary code role or missing design authority', async () => {
    const member = {
        issueId: 'Ozwasyd/FsusUI#2951',
        repository: 'Ozwasyd/FsusUI',
        issueNumber: 2951,
        surface: 'ui-ux',
        dependsOn: []
    }
    const input = await scenario([member])
    const candidate = input.runtimeState.candidates.find(
        ({ stage }) => stage === 'implementation-ready'
    )
    candidate.role = 'code-implementer'
    delete candidate.designSkillDigest
    delete candidate.designAuthorityDigests
    const projection = await compile(input)
    assert.deepEqual(
        projection.notReadyReasons[member.issueId].map(({ code }) => code),
        ['runtime-capability-missing']
    )
})

test('[D01] fifteen eligible members fill fifteen available slots', async () => {
    const input = await scenario(independentMembers(15))
    input.runtimeState.availableSlots = 15
    const projection = await compile(input)
    const candidates = await selectDispatch(input, projection)
    assert.equal(projection.readyFrontier.length, 15)
    assert.equal(candidates.dispatchCandidates.length, 15)
})

test('[D02] N eligible members produce exactly N candidates', async () => {
    const input = await scenario(independentMembers(4))
    input.runtimeState.availableSlots = 15
    const projection = await compile(input)
    const candidates = await selectDispatch(input, projection)
    assert.equal(candidates.dispatchCandidates.length, 4)
    assert.deepEqual(candidates.dispatchCandidates, projection.readyFrontier)
})

test('[D03] root-only delivery action is the sole permitted ready-work empty batch', async () => {
    const input = await scenario(independentMembers(2))
    input.runtimeState.rootOnlyDeliveryAction = {
        actionId: 'delivery-window-1',
        evidenceDigest: '5'.repeat(64)
    }
    const projection = await compile(input)
    const candidates = await selectDispatch(input, projection)
    assert.deepEqual(candidates.dispatchCandidates, [])
    assert.equal(candidates.noDispatchReason.code, 'root-only-delivery-action')
    assert.equal(
        candidates.noDispatchReason.evidence.identity,
        'delivery-window-1'
    )
})

test('[G01] group ready cannot mask a blocked member', async () => {
    const input = await scenario()
    const projection = await compile(input)
    const groupProposals = [{
        groupId: 'group-1',
        repository: 'Ozwasyd/FsusBlog',
        memberIssueIds: [
            'Ozwasyd/FsusBlog#9101',
            'Ozwasyd/FsusBlog#9102'
        ],
        eligible: true
    }]
    const selected = await selectDispatch(input, projection, groupProposals)
    assert.equal(
        selected.dispatchCandidates.some(
            ({ issueId }) => issueId === 'Ozwasyd/FsusBlog#9102'
        ),
        false
    )
})

test('[G02] group green cannot advance an individually failed member', async () => {
    const input = await scenario(independentMembers(2))
    const failedId = input.dag.nodes[1].id
    setProgress(input, failedId, [
        'testContract',
        'implementation'
    ])
    input.runtimeState.nodeStates[failedId].receipts.behavior =
        receipt('failed', { failureDigest: '6'.repeat(64) })
    const projection = await compile(input)
    assert.equal(
        projection.readyFrontier.some(
            ({ issueId, stage }) =>
                issueId === failedId && stage === 'delivery-ready'
        ),
        false
    )
})

test('[G03] ineligible grouping falls back without serializing independent members', async () => {
    const input = await scenario(independentMembers(2))
    const projection = await compile(input)
    const groupProposals = [{
        groupId: 'bad-group',
        repository: 'Ozwasyd/FsusBlog',
        memberIssueIds: input.dag.nodes.map(({ id }) => id),
        eligible: false,
        denialCode: 'independent-low-conflict-members'
    }]
    const selected = await selectDispatch(input, projection, groupProposals)
    assert.equal(selected.dispatchCandidates.length, 2)
    assert.deepEqual(selected.dispatchCandidates, projection.readyFrontier)
})

test('mutation catalog and executable controls are exact-set equal', () => {
    assert.deepEqual(
        mutationControls.map(({ id }) => id).sort(),
        [
            'eligible-member-omitted',
            'blocked-member-overreported',
            'free-text-reason',
            'reason-code-or-evidence-modified',
            'non-current-stage-dispatched',
            'frontier-digest-forged',
            'remote-comment-drift',
            'base-sha-drift',
            'selector-member-omitted',
            'terminal-fingerprint-changed',
            'candidate-permission-drift',
            'ready-slots-empty-batch',
            'group-ready-masks-blocked-member',
            'group-green-masks-member-failure',
            'group-serializes-independent-members',
            'legacy-node-investigation-accepted',
            'legacy-property-fallback-present',
            'layered-projection-binding-removed',
            'unvalidated-layered-projection',
            'layered-projection-digest-forged',
            'layered-selector-drift',
            'layered-freshness-stale',
            'layered-member-fact-drift',
            'root-authored-discovery-facts',
            'root-authored-classification-facts',
            'root-authored-dispatch-investigation',
            'layer-authority-runtime-policy-drift',
            'discovery-root-like-actor-id',
            'classification-root-like-actor-id',
            'semantic-layer-actor-continuity-drift',
            'dispatch-owner-substitution',
            'discovery-schema-resigned',
            'discovery-status-incomplete-resigned',
            'discovery-input-digest-resigned',
            'projection-schema-resigned',
            'validation-root-authored-resigned',
            'projection-duplicate-member-resigned',
            'projection-derived-lists-forged',
            'layer-digest-forged',
            'dispatch-investigation-base-drift'
        ].sort()
    )
})

for (const control of mutationControls.filter(
    ({ id }) => id !== 'layer-authority-runtime-policy-drift'
)) {
    test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async () => {
        if (control.surface === 'layered-integrity-r4') {
            await assertRevision4LayeredIntegrityMutation(control)
            return
        }

        if (control.surface === 'integration') {
            const frontierSource = readFileSync(implementationPath, 'utf8')
            const gateSource = readFileSync(gatePath, 'utf8')
            const current = inspectProductionLayeredBinding(
                frontierSource,
                gateSource
            )
            assert.equal(current.valid, true, current.code)
            const mutated = control.id === 'legacy-property-fallback-present'
                ? inspectProductionLayeredBinding(
                    `${frontierSource}\nnode['investigation']`,
                    gateSource
                )
                : inspectProductionLayeredBinding(
                    frontierSource,
                    gateSource.replaceAll(
                        'investigationProjection',
                        'projectionBindingRemoved'
                    )
                )
            assert.equal(mutated.valid, false)
            assert.equal(mutated.code, control.expectedCode)
            return
        }

        if (control.surface === 'legacy-input') {
            const input = await scenario(independentMembers(1))
            const node = input.dag.nodes[0]
            delete node.discoveryFacts
            delete node.classificationFacts
            delete node.dispatchInvestigation
            node.investigation = {
                status: 'complete',
                checkedAt: cases.computedAt,
                blockedSince: null,
                ownerId: 'legacy-investigator',
                codePaths: [
                    'skills/issue-orchestration/scripts/frontier-compiler.mjs'
                ],
                testPaths: [artifactPaths.test],
                currentDocs: [
                    'docs/development/issue-orchestration-scope.md'
                ],
                constraints: ['legacy compatibility is forbidden']
            }
            input.investigationProjection = null
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }

        if (control.surface === 'layered-input') {
            const input = await scenario(independentMembers(1))
            if (control.id === 'unvalidated-layered-projection') {
                input.investigationProjection.validation = null
            } else if (control.id === 'layered-projection-digest-forged') {
                input.investigationProjection.projectionDigest = 'f'.repeat(64)
            } else if (control.id === 'layered-selector-drift') {
                const changed = clone(input.investigationProjection)
                changed.selectorReceiptDigest = 'f'.repeat(64)
                const freshness = clone(changed.validation.freshness)
                freshness.selectorReceiptDigest = 'f'.repeat(64)
                input.investigationProjection = sealInvestigationProjection(
                    changed,
                    freshness
                )
            } else if (control.id === 'layered-freshness-stale') {
                const validation =
                    input.investigationProjection.validation
                validation.freshness.status = 'stale'
                delete validation.receiptDigest
                validation.receiptDigest = digest(validation)
            } else if (control.id === 'layered-member-fact-drift') {
                const changed = clone(input.investigationProjection)
                changed.nodes[0].memberRemoteFactDigest = 'f'.repeat(64)
                const freshness = clone(changed.validation.freshness)
                freshness.memberRemoteFactDigests[
                    changed.nodes[0].issueId
                ] = 'f'.repeat(64)
                input.investigationProjection = sealInvestigationProjection(
                    changed,
                    freshness
                )
            }
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }

        if (control.surface === 'layered-authority') {
            const input = await scenario(independentMembers(1))
            const node = input.dag.nodes[0]
            const rootActor = {
                role: 'root-scheduler',
                actorId: 'root-scheduler-1',
                model: 'gpt-5.6-sol',
                effort: 'low',
                mode: 'root-only'
            }
            if (control.id === 'root-authored-discovery-facts') {
                node.discoveryFacts.authoredBy = rootActor
                node.discoveryFacts = redigest(node.discoveryFacts)
                node.classificationFacts.discoveryFactsDigest =
                    node.discoveryFacts.digest
                node.classificationFacts = redigest(
                    node.classificationFacts
                )
            } else if (control.id === 'root-authored-classification-facts') {
                node.classificationFacts.authoredBy = rootActor
                node.classificationFacts = redigest(
                    node.classificationFacts
                )
            } else if (control.id === 'layer-digest-forged') {
                node.classificationFacts.digest = 'f'.repeat(64)
            } else {
                setProgress(input, node.id, ['testContract'])
                if (control.id === 'root-authored-dispatch-investigation') {
                    node.dispatchInvestigation.authoredBy = rootActor
                } else if (
                    control.id === 'dispatch-investigation-base-drift'
                ) {
                    node.dispatchInvestigation.baseSha = 'f'.repeat(40)
                }
                node.dispatchInvestigation = sealDispatchInvestigation(
                    node.dispatchInvestigation
                )
            }
            rebuildInvestigationProjection(input)
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }

        if (control.id === 'selector-member-omitted') {
            const input = await scenario(independentMembers(2))
            input.dag.nodes.pop()
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }

        if (control.surface === 'frontier') {
            const input = await scenario()
            const projection = await compile(input)
            if (control.id === 'eligible-member-omitted') {
                projection.readyFrontier.shift()
            } else if (control.id === 'blocked-member-overreported') {
                projection.readyFrontier.push({
                    issueId: 'Ozwasyd/FsusBlog#9102',
                    stage: 'test-contract-ready'
                })
            } else if (control.id === 'free-text-reason') {
                projection.notReadyReasons['Ozwasyd/FsusBlog#9102'] =
                    '暂时不处理'
            } else if (control.id === 'reason-code-or-evidence-modified') {
                projection.notReadyReasons['Ozwasyd/FsusBlog#9102'][0]
                    .evidence.identity = 'root-authored'
            } else if (control.id === 'frontier-digest-forged') {
                projection.frontierDigest = 'f'.repeat(64)
            }
            await expectDenied(
                () => validateFrontier(input, projection),
                control.expectedCode
            )
            return
        }

        if (control.surface === 'input') {
            const input = await scenario(independentMembers(1))
            if (control.id === 'terminal-fingerprint-changed') {
                input.runtimeState.nodeStates[input.dag.nodes[0].id].terminal = {
                    category: 'externally_blocked',
                    recoveryFingerprint: 'same',
                    observedRecoveryFingerprint: 'same',
                    evidenceDigest: '7'.repeat(64)
                }
            }
            const projection = await compile(input)
            if (control.id === 'base-sha-drift') {
                input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] =
                    'f'.repeat(40)
            } else if (control.id === 'candidate-permission-drift') {
                input.runtimeState.candidates[0].allowedPaths.push(
                    'tests/forbidden.test.mjs'
                )
            } else if (control.id === 'terminal-fingerprint-changed') {
                input.runtimeState.nodeStates[input.dag.nodes[0].id]
                    .terminal.observedRecoveryFingerprint = 'changed'
            } else if (control.id === 'remote-comment-drift') {
                input.selectorReceipt.receiptDigest = 'd'.repeat(64)
                input.selectorReceipt.remoteFactDigests[input.dag.nodes[0].id] =
                    'f'.repeat(64)
                input.selectorReceipt.remoteSnapshotDigest = 'e'.repeat(64)
                input.dag.selectorReceiptDigest =
                    input.selectorReceipt.receiptDigest
                input.dag.remoteSnapshotDigest =
                    input.selectorReceipt.remoteSnapshotDigest
                input.dag.nodes[0].selectorReceiptDigest =
                    input.selectorReceipt.receiptDigest
                input.dag.nodes[0].remoteFactDigest =
                    input.selectorReceipt.remoteFactDigests[
                        input.dag.nodes[0].id
                    ]
                input.dag.nodes[0].discoveryFacts = discoveryFacts(
                    input.members[0],
                    input.selectorReceipt
                )
                input.dag.nodes[0].classificationFacts =
                    classificationFacts(
                        input.members[0],
                        input.dag.nodes[0].discoveryFacts
                    )
                input.runtimeState.remoteFacts.selectorReceiptDigest =
                    input.selectorReceipt.receiptDigest
                input.runtimeState.remoteFacts.remoteSnapshotDigest =
                    input.selectorReceipt.remoteSnapshotDigest
                rebuildInvestigationProjection(input)
            }
            await expectDenied(
                () => validateFrontier(input, projection),
                control.expectedCode
            )
            return
        }

        const input = control.id === 'group-serializes-independent-members'
            ? await scenario(independentMembers(2))
            : await scenario()
        const projection = await compile(input)
        const groupProposals = control.id.startsWith('group-')
            ? [{
                groupId: 'mutant-group',
                repository: 'Ozwasyd/FsusBlog',
                memberIssueIds: input.dag.nodes.map(({ id }) => id),
                eligible: control.id !== 'group-serializes-independent-members'
            }]
            : []
        const recorded = await selectDispatch(input, projection, groupProposals)
        if (control.id === 'non-current-stage-dispatched') {
            recorded.dispatchCandidates[0].stage = 'implementation-ready'
        } else if (control.id === 'ready-slots-empty-batch') {
            recorded.dispatchCandidates = []
            recorded.noDispatchReason = null
        } else if (control.id === 'group-ready-masks-blocked-member') {
            recorded.dispatchCandidates.push({
                issueId: 'Ozwasyd/FsusBlog#9102',
                stage: 'test-contract-ready'
            })
        } else if (control.id === 'group-green-masks-member-failure') {
            recorded.dispatchCandidates.push({
                issueId: 'Ozwasyd/FsusBlog#9102',
                stage: 'delivery-ready'
            })
        } else if (control.id === 'group-serializes-independent-members') {
            recorded.dispatchCandidates = recorded.dispatchCandidates.slice(0, 1)
        }
        await expectDenied(
            () => validateDispatch(
                input,
                projection,
                recorded,
                groupProposals
            ),
            control.expectedCode
        )
    })
}

test('[B01] gate and compiler bind validated layered projection without legacy authority', async () => {
    await implementation()
    const source = readFileSync(gatePath, 'utf8')
    assert.match(source, /frontier-compiler\.mjs/u)
    assert.match(source, /validateReadyFrontier/u)
    const binding = inspectProductionLayeredBinding()
    assert.equal(binding.valid, true, binding.code)
})
