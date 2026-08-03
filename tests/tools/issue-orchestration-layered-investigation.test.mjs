import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    verifiedRuntimeStartup
} from './issue-orchestration-runtime-startup-test-helper.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtimeStartup = verifiedRuntimeStartup({})
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const implementationPath = resolve(
    root,
    'skills/issue-orchestration/scripts/investigation-compiler.mjs'
)
const frontierPath = resolve(
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
const dagAgentPolicyPath = resolve(root, 'agents/dag-creator-updater.toml')
const testOwnerPolicyPath = resolve(root, 'agents/test-owner.toml')
const implementerPolicyPath = resolve(root, 'agents/code-implementer.toml')

const artifactPaths = {
    test: 'tests/tools/issue-orchestration-layered-investigation.test.mjs',
    cases: 'tests/fixtures/issue-orchestration/layered-investigation-cases.json',
    acceptance:
        'tests/fixtures/issue-orchestration/layered-investigation-acceptance-map.json',
    expectedFailures:
        'tests/fixtures/issue-orchestration/layered-investigation-expected-initial-failures.json',
    runtimeProbes:
        'tests/fixtures/issue-orchestration/layered-investigation-runtime-probes.json',
    mutations:
        'tests/fixtures/issue-orchestration/layered-investigation-mutation-controls.json',
    contract:
        'tests/fixtures/issue-orchestration/layered-investigation-test-contract.json'
}

function readJson(path) {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

const cases = readJson(artifactPaths.cases)
const acceptanceMap = readJson(artifactPaths.acceptance)
const expectedFailures = readJson(artifactPaths.expectedFailures)
const runtimeProbes = readJson(artifactPaths.runtimeProbes)
const mutationControls = readJson(artifactPaths.mutations).controls
const frozenContract = readJson(artifactPaths.contract)

const requiredExports = [
    'compileInvestigationProjection',
    'validateInvestigationProjection',
    'evaluateInvestigationFreshness',
    'authorizeInvestigationTransition',
    'selectInvestigationActions',
    'validateInvestigationActions',
    'buildImplementationTask'
]

let implementationPromise
let selectorPromise
let frontierPromise

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value
            .map(canonical)
            .sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right))
            )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return sha256(JSON.stringify(canonical(value)))
}

function clone(value) {
    return structuredClone(value)
}

async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1822 layered investigation compiler: ${implementationPath}`
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

async function frontierImplementation() {
    frontierPromise ??= import(pathToFileURL(frontierPath).href)
    return frontierPromise
}

function remoteIssue(index, dependencies = []) {
    const issueNumber = 10000 + index
    return {
        repository: 'Ozwasyd/FsusBlog',
        number: issueNumber,
        state: 'OPEN',
        stateReason: null,
        updatedAt: `2026-08-01T03:${String(index % 60).padStart(2, '0')}:00.000Z`,
        title: `layered investigation member ${issueNumber}`,
        body: dependencies.length === 0
            ? 'Independent issue contract.'
            : `Depends on: ${dependencies.join(', ')}`,
        comments: [{
            id: `comment-${issueNumber}`,
            body: `owner evidence for ${issueNumber}`,
            updatedAt:
                `2026-08-01T03:${String(index % 60).padStart(2, '0')}:30.000Z`,
            relevant: true
        }],
        labels: index % 5 === 0 ? ['priority:high'] : ['area:tooling'],
        milestone: null,
        dependsOn: dependencies,
        related: [],
        mentioned: [],
        trackedIssueIds: []
    }
}

function selectorFor(issueIds, version = 'layered-investigation.v1') {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: version,
        type: 'explicit-issues',
        repositories: ['Ozwasyd/FsusBlog'],
        statePolicy: {
            open: 'include',
            closed: 'retain-if-explicit',
            reopen: 'retain'
        },
        dependencyClosure: 'none',
        implicitExpansion: 'forbidden',
        parameters: { issueIds },
        remoteQueryIdentity: `fixture:${version}`
    }
}

function actor(role, overrides = {}) {
    const defaults = {
        'root-scheduler': {
            role,
            actorId: 'root-scheduler-1',
            model: 'gpt-5.6-sol',
            effort: 'low',
            mode: 'root-only'
        },
        'dag-creator': {
            role,
            actorId: 'dag-creator-1',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation',
            freshContext: true,
            proposalOnly: true
        },
        'dag-updater': {
            role,
            actorId: 'dag-updater-1',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'observe-only',
            mutationContract: 'no-protected-mutation',
            freshContext: true,
            proposalOnly: true
        },
        'test-owner': {
            role,
            actorId: 'test-owner-1822',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'leased-writer',
            mutationContract: 'lease-and-slice-allowlist',
            writeScope: 'tests-only'
        },
        'code-implementer': {
            role,
            actorId: 'code-implementer-1822',
            model: 'gpt-5.6-sol',
            effort: 'low',
            executionClass: 'leased-writer',
            mutationContract: 'lease-and-slice-allowlist',
            writeScope: 'implementation-only'
        },
        'discovery-agent': {
            role,
            actorId: 'discovery-agent-1',
            model: 'gpt-5.6-sol',
            effort: 'max',
            executionClass: 'observe-only'
        }
    }
    return { ...defaults[role], ...overrides }
}

function withDigest(record) {
    return { ...record, digest: digest(record) }
}

function redigest(record) {
    const changed = clone(record)
    delete changed.digest
    return withDigest(changed)
}

function discoveryFacts(issue, selectorReceipt) {
    const issueId = `${issue.repository}#${issue.number}`
    return withDigest({
        schema: cases.schemas.discovery,
        status: 'complete',
        authoredBy: actor('dag-creator'),
        checkedAt: cases.computedAt,
        inputDigest: digest({
            selectorDigest: selectorReceipt.selectorDigest,
            scopeMembership: 'selected',
            issueId,
            memberRemoteFactDigest: selectorReceipt.remoteFactDigests[issueId]
        }),
        issueIdentity: issueId,
        issueTitle: issue.title,
        issueState: issue.state,
        issueUpdatedAt: issue.updatedAt,
        commentsFingerprint: digest(issue.comments.filter(({ relevant }) => relevant)),
        explicitDependencyReferences: [...issue.dependsOn],
        priority: issue.labels.includes('priority:high') ? 'high' : 'normal',
        scopeMembership: 'selected',
        candidateRepositoryOwner: 'Ozwasyd/FsusBlog',
        selectorDigest: selectorReceipt.selectorDigest,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        memberRemoteFactDigest: selectorReceipt.remoteFactDigests[issueId]
    })
}

function classificationFacts(issue, discovery, { candidateReady, index }) {
    return withDigest({
        schema: cases.schemas.classification,
        status: 'complete',
        authoredBy: actor('dag-creator'),
        checkedAt: cases.computedAt,
        inputDigest: digest({
            discoveryFactsDigest: discovery.digest,
            activeDependencies: issue.dependsOn,
            candidateOwnerEvidenceDigest: digest({
                repository: 'Ozwasyd/FsusBlog',
                roots: ['AGENTS.md']
            }),
            conflictResourceEvidenceDigest: digest({
                domains: ['issue-orchestration-schema'],
                resources: []
            }),
            requiredInstructionRoots: ['AGENTS.md']
        }),
        candidateOwner: 'Ozwasyd/FsusBlog',
        candidateOwnerEvidence: [{
            path: 'skills/issue-orchestration/scripts/check-dag-gate.mjs',
            claim: 'existing DAG schema owner'
        }],
        activeDependencies: [...issue.dependsOn],
        satisfiedDependencies: [],
        candidateConflictDomains: ['issue-orchestration-schema'],
        candidateResourceDomains: [],
        riskFlags: index % 7 === 0 ? ['critical-path'] : [],
        requiredInstructionRoots: ['AGENTS.md'],
        confidence: 'confirmed',
        unresolvedDecisions: [],
        candidateReady,
        priorityReasons: candidateReady
            ? [
                index % 2 === 0 ? 'critical-path' : 'high-priority',
                'candidate-ready'
            ]
            : ['unlocks-ready-dependent']
    })
}

const allowedTestPaths = Object.values(artifactPaths)
const minimalAllowedImplementationPaths = [
    'skills/issue-orchestration/scripts/investigation-compiler.mjs',
    'skills/issue-orchestration/scripts/frontier-compiler.mjs',
    'skills/issue-orchestration/scripts/check-dag-gate.mjs',
    'agents/dag-creator-updater.toml',
    'agents/test-owner.toml',
    'agents/code-implementer.toml'
]
const candidateImplementationPaths = [...minimalAllowedImplementationPaths]
const correctiveAllowedImplementationPaths = [
    'agents/dag-creator-updater.toml',
    'agents/test-owner.toml'
]
const baseDependencyPaths = [
    'skills/issue-orchestration/scripts/dispatch-receipt.mjs'
]
const currentPathDigests = {
    'AGENTS.md': sha256(readFileSync(resolve(root, 'AGENTS.md'))),
    'skills/issue-orchestration/scripts/check-dag-gate.mjs':
        sha256(readFileSync(gatePath)),
    'skills/issue-orchestration/scripts/frontier-compiler.mjs':
        sha256(readFileSync(frontierPath)),
    'tests/tools/issue-orchestration-layered-investigation.test.mjs':
        sha256(readFileSync(resolve(root, artifactPaths.test))),
    'docs/development/issue-orchestration-scope.md': sha256(readFileSync(
        resolve(root, 'docs/development/issue-orchestration-scope.md')
    ))
}

function pathEvidence(path) {
    return { path, digest: currentPathDigests[path] ?? digest({ path }) }
}

function dispatchInvestigation(issue, classification, selectorReceipt) {
    const issueId = `${issue.repository}#${issue.number}`
    const record = {
        schema: cases.schemas.dispatch,
        status: 'complete',
        authoredBy: actor('test-owner'),
        testOwnerId: 'test-owner-1822',
        checkedAt: cases.computedAt,
        blockedSince: null,
        blockerOwner: null,
        baseSha: cases.baseSha,
        worktree:
            '/home/lyuaoss/.local/state/codex/bootstrap-issue-orchestration-repair/'
            + 'cdfdbdbe-d901-4482-bafe-c4ba92c17779/tmp/worktrees/1822-corrective',
        deliveryEpoch: cases.deliveryEpoch,
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        memberRemoteFactDigest: selectorReceipt.remoteFactDigests[issueId],
        classificationFactsDigest: classification.digest,
        nearestAgentsChain: [pathEvidence('AGENTS.md')],
        confirmedOwner: 'Ozwasyd/FsusBlog',
        allowedTestPaths: [...allowedTestPaths],
        allowedImplementationPaths: [...minimalAllowedImplementationPaths],
        forbiddenPaths: [
            'src/backend/**',
            'src/frontend/**',
            'docs/**',
            'tests/**'
        ],
        codePaths: [
            pathEvidence(
                'skills/issue-orchestration/scripts/check-dag-gate.mjs'
            ),
            pathEvidence(
                'skills/issue-orchestration/scripts/frontier-compiler.mjs'
            )
        ],
        testPaths: [
            pathEvidence(
                'tests/tools/issue-orchestration-layered-investigation.test.mjs'
            )
        ],
        currentDocs: [
            pathEvidence('docs/development/issue-orchestration-scope.md')
        ],
        implementationDecision: {
            decision: 'replace the single full-investigation gate with one layered authority',
            noFallback: true
        },
        acceptanceGroup: `issue-${issue.number}`,
        acceptanceMap: acceptanceMap.acceptance.map(({ id }) => ({
            id,
            issueId,
            evidenceRequired: true
        })),
        runtimeProbes: {
            status: 'not-applicable',
            reasonCode: 'no-external-runtime-boundary'
        },
        mutationControls: mutationControls.map(({ id }) => id),
        promptInputs: {
            testCommands: [
                'node --test tests/tools/issue-orchestration-layered-investigation.test.mjs'
            ],
            counterexamples: [
                'root constructs arbitrary scope',
                'classified node dispatches without a frozen test contract',
                'future investigation suppresses machine-ready work'
            ],
            failureClassification: [
                'contract-red',
                'implementation-defect',
                'environment-unavailable'
            ],
            stopConditions: [
                'return test-contract-disputed for an unresolved owner, design, or acceptance boundary'
            ]
        },
        issueSpecificEvidenceDigest: digest({
            issueId,
            codePaths: [
                'skills/issue-orchestration/scripts/check-dag-gate.mjs',
                'skills/issue-orchestration/scripts/frontier-compiler.mjs'
            ],
            acceptanceIds: acceptanceMap.acceptance.map(({ id }) => id)
        })
    }
    record.inputDigest = digest({
        classificationFactsDigest: record.classificationFactsDigest,
        baseSha: record.baseSha,
        worktree: record.worktree,
        deliveryEpoch: record.deliveryEpoch,
        nearestAgentsChain: record.nearestAgentsChain,
        codePaths: record.codePaths,
        testPaths: record.testPaths,
        currentDocs: record.currentDocs,
        implementationDecision: record.implementationDecision,
        acceptanceMap: record.acceptanceMap,
        runtimeProbes: record.runtimeProbes,
        mutationControls: record.mutationControls
    })
    return withDigest(record)
}

async function scenario({
    count = 4,
    candidateCount = 2,
    deepIndices = [],
    selectorVersion = 'layered-investigation.v1'
} = {}) {
    const issues = Array.from({ length: count }, (_, index) => {
        const dependencies = index < candidateCount
            ? []
            : [`Ozwasyd/FsusBlog#${10000 + (index % candidateCount)}`]
        return remoteIssue(index, dependencies)
    })
    const selector = selectorFor(
        issues.map((issue) => `${issue.repository}#${issue.number}`),
        selectorVersion
    )
    const { resolveSelector } = await selectorImplementation()
    const selectorReceipt = resolveSelector({
        selector,
        remoteIssues: issues,
        resolvedAt: cases.computedAt,
        startup: runtimeStartup
    })
    const nodes = issues.map((issue, index) => {
        const discovery = discoveryFacts(issue, selectorReceipt)
        const classification = classificationFacts(issue, discovery, {
            candidateReady: index < candidateCount,
            index
        })
        return {
            id: `${issue.repository}#${issue.number}`,
            repository: issue.repository,
            issueNumber: issue.number,
            discoveryFacts: discovery,
            classificationFacts: classification,
            dispatchInvestigation: deepIndices.includes(index)
                ? dispatchInvestigation(issue, classification, selectorReceipt)
                : null
        }
    })
    const proposal = {
        schema: 'issue-orchestration.semantic-dag-proposal.v1',
        authoredBy: actor('dag-creator'),
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        selectorDigest: selectorReceipt.selectorDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        resolvedIssueSet: [...selectorReceipt.resolvedIssueSet],
        nodes
    }
    proposal.proposalDigest = digest(proposal)
    return {
        selector,
        selectorReceipt,
        remoteIssues: issues,
        dagProposal: proposal,
        runtimeState: {
            repositoryBases: {
                'Ozwasyd/FsusBlog': cases.baseSha
            },
            deliveryEpoch: cases.deliveryEpoch,
            currentPathDigests: clone(currentPathDigests),
            availableSlots: cases.configuredSlots,
            readyStageCandidates: [],
            requestedReinvestigationIssueIds: [],
            reinvestigationReasons: {},
            starvationThresholdMs: 30 * 60 * 1000,
            observedAt: cases.computedAt
        }
    }
}

async function compile(input, computedAt = cases.computedAt) {
    const { compileInvestigationProjection } = await implementation()
    return compileInvestigationProjection({
        selectorReceipt: clone(input.selectorReceipt),
        dagProposal: clone(input.dagProposal),
        runtimeState: clone(input.runtimeState),
        computedAt
    })
}

async function validate(input, projection) {
    const { validateInvestigationProjection } = await implementation()
    return validateInvestigationProjection({
        selectorReceipt: clone(input.selectorReceipt),
        dagProposal: clone(input.dagProposal),
        runtimeState: clone(input.runtimeState),
        recordedProjection: clone(projection)
    })
}

async function freshness(input, projection) {
    const { evaluateInvestigationFreshness } = await implementation()
    return evaluateInvestigationFreshness({
        selectorReceipt: clone(input.selectorReceipt),
        dagProposal: clone(input.dagProposal),
        runtimeState: clone(input.runtimeState),
        previousProjection: clone(projection)
    })
}

async function transition(input, issueId, layer, transitionActor, value) {
    const { authorizeInvestigationTransition } = await implementation()
    return authorizeInvestigationTransition({
        selectorReceipt: clone(input.selectorReceipt),
        dagProposal: clone(input.dagProposal),
        node: clone(input.dagProposal.nodes.find(({ id }) => id === issueId)),
        transition: { layer, operation: 'replace', value: clone(value) },
        actor: clone(transitionActor)
    })
}

async function selectActions(input, projection) {
    const { selectInvestigationActions } = await implementation()
    return selectInvestigationActions({
        projection: clone(projection),
        runtimeState: clone(input.runtimeState)
    })
}

async function validateActions(input, projection, recordedActions) {
    const { validateInvestigationActions } = await implementation()
    return validateInvestigationActions({
        projection: clone(projection),
        runtimeState: clone(input.runtimeState),
        recordedActions: clone(recordedActions)
    })
}

async function buildPrompt(input, issueId) {
    const { buildImplementationTask } = await implementation()
    const node = input.dagProposal.nodes.find(({ id }) => id === issueId)
    return buildImplementationTask({
        selectorReceipt: clone(input.selectorReceipt),
        node: clone(node),
        dispatchInvestigation: clone(node.dispatchInvestigation),
        runtimeState: clone(input.runtimeState),
        implementer: actor('code-implementer')
    })
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

function nodeOutcome(projection, issueId) {
    return projection.nodes.find((node) => node.issueId === issueId)
}

test('frozen test-owner manifest, acceptance map, and mutation identities are self-consistent', () => {
    assert.equal(cases.issue, 'Ozwasyd/FsusBlog#1822')
    assert.equal(cases.baseSha, expectedFailures.baseSha)
    assert.equal(runtimeProbes.baseProbe.worktreeHead, cases.baseSha)
    assert.equal(frozenContract.testOwnerId, 'test-owner-1822')
    assert.equal(frozenContract.base.sha, cases.baseSha)
    assert.deepEqual(
        frozenContract.allowedTestPaths.toSorted(),
        allowedTestPaths.toSorted()
    )
    assert.deepEqual(
        frozenContract.minimalAllowedImplementationPaths,
        minimalAllowedImplementationPaths
    )
    assert.deepEqual(
        frozenContract.correctiveAllowedImplementationPaths,
        correctiveAllowedImplementationPaths
    )
    assert.equal(frozenContract.acceptanceMap, artifactPaths.acceptance)
    assert.equal(frozenContract.expectedInitialFailures, artifactPaths.expectedFailures)
    assert.equal(frozenContract.runtimeProbes, artifactPaths.runtimeProbes)
    assert.equal(frozenContract.mutations, artifactPaths.mutations)
    assert.deepEqual(
        Object.keys(frozenContract.fileHashes).sort(),
        allowedTestPaths.filter((path) => path !== artifactPaths.contract).sort()
    )
    for (const [path, expectedHash] of Object.entries(frozenContract.fileHashes)) {
        assert.equal(
            sha256(readFileSync(resolve(root, path))),
            expectedHash,
            `${path} drifted after the test contract was frozen`
        )
    }
    assert.equal(
        digest(frozenContract.fileHashes),
        frozenContract.frozenTreeDigest
    )
    const matrixIdentity = clone(expectedFailures.matrixIdentity)
    delete matrixIdentity.matrixDigest
    assert.equal(
        digest(matrixIdentity),
        expectedFailures.matrixIdentity.matrixDigest
    )
    assert.equal(
        frozenContract.matrixIdentityDigest,
        expectedFailures.matrixIdentity.matrixDigest
    )
    const digestInput = clone(frozenContract)
    delete digestInput.contractDigest
    delete digestInput.candidateIdentity
    assert.equal(digest(digestInput), frozenContract.contractDigest)
    const implementationFiles = candidateImplementationPaths.map((path) => {
        const absolute = resolve(root, path)
        if (!existsSync(absolute)) return { path, presence: 'missing' }
        return {
            path,
            presence: 'present',
            sha256: sha256(readFileSync(absolute)),
            gitMode: statSync(absolute).mode & 0o111
                ? '100755'
                : '100644'
        }
    })
    const baseDependencyFiles = baseDependencyPaths.map((path) => ({
        path,
        sha256: sha256(readFileSync(resolve(root, path))),
        gitMode: statSync(resolve(root, path)).mode & 0o111
            ? '100755'
            : '100644',
        ownerIssue: 'Ozwasyd/FsusBlog#1818',
        disposition: 'base-dependency-not-candidate'
    }))
    assert.deepEqual(frozenContract.baseDependencyFiles, baseDependencyFiles)
    assert.equal(
        implementationFiles.some(({ path }) => baseDependencyPaths.includes(path)),
        false
    )
    assert.deepEqual(
        frozenContract.candidateIdentity.implementationFiles,
        implementationFiles
    )
    assert.deepEqual(
        implementationFiles
            .filter(({ presence }) => presence === 'missing')
            .map(({ path }) => path),
        frozenContract.expectedMissingCandidatePaths
    )
    assert.equal(
        frozenContract.candidateIdentity.candidateDigest,
        digest({
            baseSha: frozenContract.base.sha,
            contractDigest: frozenContract.contractDigest,
            matrixIdentityDigest: frozenContract.matrixIdentityDigest,
            implementationFiles
        })
    )
    assert.deepEqual(
        cases.phaseTruthTable.map(({ phase }) => phase),
        cases.phases
    )
    assert.equal(new Set(acceptanceMap.acceptance.map(({ id }) => id)).size, 31)
    assert.equal(new Set(mutationControls.map(({ id }) => id)).size, 32)
    const mapped = new Set(
        acceptanceMap.acceptance.flatMap(({ mutations }) => mutations)
    )
    assert.deepEqual(
        [...mapped].sort(),
        mutationControls.map(({ id }) => id).sort()
    )
    for (const control of mutationControls) {
        assert.ok(control.acceptanceIds.length > 0)
        for (const id of control.acceptanceIds) {
            assert.ok(
                acceptanceMap.acceptance.some((entry) => entry.id === id),
                `${control.id} references missing ${id}`
            )
        }
    }
})

test('mutation catalog and executable controls are exact-set equal', () => {
    assert.deepEqual(
        mutationControls.map(({ id }) => id).sort(),
        [
            'root-constructs-scope',
            'dag-agent-writes-dispatch-investigation',
            'test-owner-writes-classification',
            'discovery-agent-writes-ready',
            'classified-node-dispatched-to-implementer',
            'placeholder-code-path',
            'empty-not-applicable-reason',
            'affected-comment-reuses-classification',
            'base-reuses-dispatch-investigation',
            'agents-digest-reuses-dispatch-investigation',
            'current-doc-reuses-dispatch-investigation',
            'legacy-full-investigation-schema',
            'prompt-missing-counterexample',
            'prompt-missing-test-command',
            'full-scope-reinvestigated-without-drift',
            'priority-changes-with-array-order',
            'ready-work-suppressed-by-future-investigation',
            'group-evidence-replaces-member-contract',
            'starvation-without-owner',
            'implementer-fills-contract-gap',
            'gate-validator-import-only',
            'bracket-legacy-fallback',
            'legacy-node-compat-accepted',
            'discovered-phase-rejected',
            'root-authored-investigation-layer',
            'arbitrary-layer-digest',
            'nonexistent-evidence-path',
            'implementation-task-missing-required-bindings',
            'test-owner-runtime-identity-drift',
            'code-digest-drift-reused',
            'test-digest-drift-reused',
            'deep-member-dual-dispatched'
        ].sort()
    )
})

test('[L01] projection uses three independent layers and permits shallow future members', async () => {
    const input = await scenario()
    const projection = await compile(input)
    assert.equal(projection.schema, cases.schemas.projection)
    assert.equal(projection.nodes.length, 4)
    assert.deepEqual(
        projection.nodes.map(({ phase }) => phase),
        [
            'candidate-ready',
            'candidate-ready',
            'dependency-classified',
            'dependency-classified'
        ]
    )
    for (const node of input.dagProposal.nodes.slice(2)) {
        assert.equal(node.dispatchInvestigation, null)
        assert.equal('codePaths' in node.discoveryFacts, false)
        assert.equal('testPaths' in node.classificationFacts, false)
        assert.equal('currentDocs' in node.classificationFacts, false)
    }
})

test('[L02] complete dispatch evidence uses real issue-specific paths', async () => {
    const input = await scenario({ deepIndices: [0] })
    const projection = await compile(input)
    assert.equal(nodeOutcome(projection, input.dagProposal.nodes[0].id).phase,
        'dispatch-investigated')
    const record = input.dagProposal.nodes[0].dispatchInvestigation
    for (const entry of [
        ...record.nearestAgentsChain,
        ...record.codePaths,
        ...record.testPaths,
        ...record.currentDocs
    ]) {
        assert.equal(existsSync(resolve(root, entry.path)), true, entry.path)
        assert.match(entry.digest, /^[a-f0-9]{64}$/u)
        assert.doesNotMatch(entry.path, /(?:^|\/)(?:TODO|N\/A)(?:\/|$)/iu)
    }
})

test('[L03] not-applicable fields require a stable machine reason', async () => {
    const input = await scenario({ deepIndices: [0] })
    const projection = await compile(input)
    assert.equal(projection.valid, true)
    assert.deepEqual(
        input.dagProposal.nodes[0].dispatchInvestigation.runtimeProbes,
        {
            status: 'not-applicable',
            reasonCode: 'no-external-runtime-boundary'
        }
    )
})

test('[L04] classification is test-owner-ready but not implementation-ready', async () => {
    const input = await scenario()
    const projection = await compile(input)
    assert.deepEqual(
        projection.testOwnerCandidates.map(({ issueId }) => issueId),
        input.dagProposal.nodes.slice(0, 2).map(({ id }) => id)
    )
    assert.deepEqual(projection.implementationReady, [])
    await expectDenied(
        () => buildPrompt(input, input.dagProposal.nodes[0].id),
        'test-contract-disputed'
    )
})

test('[L05] discovered is reachable without classification or dispatch evidence', async () => {
    const input = await scenario({ count: 1, candidateCount: 0 })
    input.dagProposal.nodes[0].classificationFacts = null
    input.dagProposal.nodes[0].dispatchInvestigation = null
    const projection = await compile(input)
    assert.equal(projection.nodes.length, 1)
    assert.equal(projection.nodes[0].phase, 'discovered')
    assert.ok(projection.nodes[0].reasons.some(
        ({ code }) => code === 'classification-incomplete'
    ))
    assert.deepEqual(projection.testOwnerCandidates, [])
    assert.deepEqual(projection.implementationReady, [])
})

test('[L06] root-authored facts, arbitrary digests, and nonexistent paths fail closed', async () => {
    const rootAuthored = await scenario({ deepIndices: [0] })
    rootAuthored.dagProposal.nodes[0].discoveryFacts.authoredBy =
        actor('root-scheduler')
    rootAuthored.dagProposal.nodes[0].discoveryFacts =
        redigest(rootAuthored.dagProposal.nodes[0].discoveryFacts)
    await expectDenied(
        () => compile(rootAuthored),
        'investigation-layer-authority'
    )

    const forged = await scenario({ deepIndices: [0] })
    forged.dagProposal.nodes[0].classificationFacts.candidateOwner =
        'Ozwasyd/FsusUI'
    await expectDenied(
        () => compile(forged),
        'investigation-layer-digest-mismatch'
    )

    const nonexistent = await scenario({ deepIndices: [0] })
    nonexistent.dagProposal.nodes[0].dispatchInvestigation.codePaths[0] = {
        path: 'skills/issue-orchestration/scripts/does-not-exist.mjs',
        digest: 'a'.repeat(64)
    }
    await expectDenied(() => compile(nonexistent), 'path-missing')
})

test('[S01] selector receipt is the only scope and root cannot rewrite it', async () => {
    const input = await scenario()
    const projection = await compile(input)
    assert.equal(projection.selectorReceiptDigest, input.selectorReceipt.receiptDigest)
    assert.deepEqual(
        projection.nodes.map(({ issueId }) => issueId).sort(),
        input.selectorReceipt.resolvedIssueSet
    )
    const changed = clone(input)
    changed.dagProposal.resolvedIssueSet.pop()
    await expectDenied(() => compile(changed), 'selector-receipt-mismatch')
})

test('[F01] canonical replay reuses unchanged members across unrelated drift', async () => {
    const input = await scenario({ deepIndices: [0] })
    const original = await compile(input, cases.computedAt)
    const changedIssues = clone(input.remoteIssues)
    changedIssues[3].comments[0].body += ' unrelated drift'
    const { resolveSelector } = await selectorImplementation()
    const changedReceipt = resolveSelector({
        selector: {
            ...input.selector,
            selectorVersion: 'layered-investigation.v2'
        },
        remoteIssues: changedIssues,
        previousReceipt: input.selectorReceipt,
        resolvedAt: cases.laterComputedAt,
        startup: runtimeStartup
    })
    const changed = clone(input)
    changed.selectorReceipt = changedReceipt
    changed.dagProposal.selectorReceiptDigest = changedReceipt.receiptDigest
    changed.dagProposal.selectorDigest = changedReceipt.selectorDigest
    changed.dagProposal.remoteSnapshotDigest = changedReceipt.remoteSnapshotDigest
    changed.dagProposal.resolvedIssueSet = [...changedReceipt.resolvedIssueSet]
    changed.dagProposal.nodes[3].discoveryFacts =
        discoveryFacts(changedIssues[3], changedReceipt)
    changed.dagProposal.nodes[3].classificationFacts = classificationFacts(
        changedIssues[3],
        changed.dagProposal.nodes[3].discoveryFacts,
        { candidateReady: false, index: 3 }
    )
    changed.dagProposal.proposalDigest = digest({
        ...changed.dagProposal,
        proposalDigest: undefined
    })
    const report = await freshness(changed, original)
    for (const node of changed.dagProposal.nodes.slice(0, 3)) {
        assert.deepEqual(report.byIssue[node.id].staleLayers, [])
        assert.equal(report.byIssue[node.id].reuse, true)
    }
    assert.deepEqual(
        report.byIssue[changed.dagProposal.nodes[3].id].staleLayers,
        ['discoveryFacts', 'classificationFacts', 'dispatchInvestigation']
    )
})

test('[F02] changed member comment invalidates only that member and downstream layers', async () => {
    const input = await scenario({ deepIndices: [0, 1] })
    const original = await compile(input)
    const changedIssues = clone(input.remoteIssues)
    changedIssues[0].comments[0].body += ' owner changed'
    const { resolveSelector } = await selectorImplementation()
    const changed = clone(input)
    changed.selectorReceipt = resolveSelector({
        selector: {
            ...input.selector,
            selectorVersion: 'layered-investigation.comment-v2'
        },
        remoteIssues: changedIssues,
        previousReceipt: input.selectorReceipt,
        resolvedAt: cases.laterComputedAt,
        startup: runtimeStartup
    })
    const report = await freshness(changed, original)
    assert.deepEqual(
        report.byIssue[input.dagProposal.nodes[0].id].staleLayers,
        ['discoveryFacts', 'classificationFacts', 'dispatchInvestigation']
    )
    assert.ok(
        report.byIssue[input.dagProposal.nodes[0].id].reasons.some(
            ({ code }) => code === 'issue-facts-stale'
        )
    )
    assert.deepEqual(report.byIssue[input.dagProposal.nodes[1].id].staleLayers, [])
})

test('[F03] base and epoch drift invalidate dispatch only', async () => {
    for (const mutate of [
        (changed) => {
            changed.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
        },
        (changed) => {
            changed.runtimeState.deliveryEpoch = 'bootstrap-repair-1822-epoch-5'
        }
    ]) {
        const input = await scenario({ deepIndices: [0] })
        const original = await compile(input)
        mutate(input)
        const report = await freshness(input, original)
        assert.deepEqual(
            report.byIssue[input.dagProposal.nodes[0].id].staleLayers,
            ['dispatchInvestigation']
        )
    }
})

test('[F04] instruction and current-doc drift invalidate dispatch only', async () => {
    for (const path of [
        'AGENTS.md',
        'docs/development/issue-orchestration-scope.md'
    ]) {
        const input = await scenario({ deepIndices: [0] })
        const original = await compile(input)
        input.runtimeState.currentPathDigests[path] = 'f'.repeat(64)
        const report = await freshness(input, original)
        assert.deepEqual(
            report.byIssue[input.dagProposal.nodes[0].id].staleLayers,
            ['dispatchInvestigation']
        )
    }
})

test('[F05] owner-code and test-entry drift invalidate dispatch and disable reuse', async () => {
    const driftCases = [
        {
            path: 'skills/issue-orchestration/scripts/check-dag-gate.mjs',
            expectedCode: 'owner-code-drift'
        },
        {
            path: 'tests/tools/issue-orchestration-layered-investigation.test.mjs',
            expectedCode: 'test-entry-drift'
        }
    ]
    for (const { path, expectedCode } of driftCases) {
        const input = await scenario({ deepIndices: [0] })
        const original = await compile(input)
        input.runtimeState.currentPathDigests[path] = 'f'.repeat(64)
        const report = await freshness(input, original)
        const member = report.byIssue[input.dagProposal.nodes[0].id]
        assert.equal(member.reuse, false)
        assert.deepEqual(member.staleLayers, ['dispatchInvestigation'])
        assert.ok(member.reasons.some(({ code }) => code === expectedCode))
    }
})

test('[Q01] investigation priority is stable, deterministic, and auditable', async () => {
    const input = await scenario({ count: 8, candidateCount: 5 })
    input.dagProposal.nodes[0].classificationFacts.priorityReasons =
        ['long-wait', 'candidate-ready']
    input.dagProposal.nodes[1].classificationFacts.priorityReasons =
        ['high-priority', 'candidate-ready']
    input.dagProposal.nodes[2].classificationFacts.priorityReasons =
        ['critical-path', 'candidate-ready']
    input.dagProposal.nodes[3].classificationFacts.priorityReasons =
        ['unlocks-ready-dependent', 'candidate-ready']
    input.dagProposal.nodes[4].classificationFacts.priorityReasons =
        ['candidate-ready']
    for (const node of input.dagProposal.nodes.slice(0, 5)) {
        node.classificationFacts = redigest(node.classificationFacts)
    }
    const original = await compile(input)
    const reordered = clone(input)
    reordered.dagProposal.nodes.reverse()
    for (const node of reordered.dagProposal.nodes) {
        node.classificationFacts.priorityReasons.reverse()
        node.classificationFacts = redigest(node.classificationFacts)
    }
    const replay = await compile(reordered, cases.laterComputedAt)
    assert.deepEqual(replay.investigationQueue, original.investigationQueue)
    assert.equal(replay.inputDigest, original.inputDigest)
    for (const candidate of original.investigationQueue) {
        assert.ok(candidate.priorityReasons.length > 0)
        assert.match(candidate.priorityEvidenceDigest, /^[a-f0-9]{64}$/u)
    }
})

test('[Q02] ready stage work cannot be suppressed by future investigation', async () => {
    const input = await scenario({ count: 8, candidateCount: 5 })
    input.runtimeState.readyStageCandidates = [{
        issueId: 'Ozwasyd/FsusBlog#9901',
        stage: 'implementation-ready',
        capabilityReceiptDigest: 'a'.repeat(64)
    }]
    input.runtimeState.availableSlots = 2
    const projection = await compile(input)
    const selected = await selectActions(input, projection)
    assert.deepEqual(selected.dispatchCandidates,
        input.runtimeState.readyStageCandidates)
    assert.equal(selected.investigationCandidates.length, 1)
    const suppressed = clone(selected)
    suppressed.dispatchCandidates = []
    suppressed.investigationCandidates = projection.investigationQueue.slice(0, 2)
    await expectDenied(
        () => validateActions(input, projection, suppressed),
        'dispatch-work-conservation'
    )
})

test('[Q03] starved investigation has a blocker owner and direct evidence', async () => {
    const input = await scenario({ deepIndices: [0] })
    const record = input.dagProposal.nodes[0].dispatchInvestigation
    record.status = 'blocked'
    record.blockedSince = '2026-08-01T02:00:00.000Z'
    record.blockerOwner = 'test-owner-1822'
    record.blockerEvidenceDigest = 'b'.repeat(64)
    const projection = await compile(input)
    const outcome = nodeOutcome(projection, input.dagProposal.nodes[0].id)
    assert.ok(outcome.reasons.some(({ code }) => code === 'investigation-starved'))
    assert.equal(outcome.blockerOwner, 'test-owner-1822')
})

test('[R01] DAG agent, test owner, discovery agent, and root authorities are disjoint', async () => {
    const input = await scenario({ deepIndices: [0] })
    const node = input.dagProposal.nodes[0]
    const dagAllowed = await transition(
        input,
        node.id,
        'classificationFacts',
        actor('dag-updater'),
        node.classificationFacts
    )
    assert.equal(dagAllowed.valid, true)
    const ownerAllowed = await transition(
        input,
        node.id,
        'dispatchInvestigation',
        actor('test-owner'),
        node.dispatchInvestigation
    )
    assert.equal(ownerAllowed.valid, true)
    await expectDenied(
        () => transition(
            input,
            node.id,
            'dispatchInvestigation',
            actor('dag-updater'),
            node.dispatchInvestigation
        ),
        'dag-agent-dispatch-authority-forbidden'
    )
    await expectDenied(
        () => transition(
            input,
            node.id,
            'classificationFacts',
            actor('test-owner'),
            node.classificationFacts
        ),
        'test-owner-semantic-authority-forbidden'
    )
    await expectDenied(
        () => transition(input, node.id, 'ready', actor('discovery-agent'), {}),
        'investigation-transition-authority'
    )
})

test('[R02] operational agent policies freeze authority and dispute behavior', async () => {
    await implementation()
    for (const path of [dagAgentPolicyPath, testOwnerPolicyPath, implementerPolicyPath]) {
        assert.equal(existsSync(path), true, path)
    }
    const dagPolicy = readFileSync(dagAgentPolicyPath, 'utf8')
    const ownerPolicy = readFileSync(testOwnerPolicyPath, 'utf8')
    const implementerPolicy = readFileSync(implementerPolicyPath, 'utf8')
    assert.match(dagPolicy, /executionClass=observe-only/u)
    assert.match(dagPolicy, /semantic graph/iu)
    assert.match(dagPolicy, /dispatchInvestigation/iu)
    assert.match(ownerPolicy, /stage-model-pool\.v3/iu)
    assert.match(ownerPolicy, /never select|never.*profile/iu)
    assert.doesNotMatch(ownerPolicy, /^\s*(?:model|effort)\s*=/mu)
    assert.match(ownerPolicy, /tests\/fixtures\/probes\/contract|tests.*fixtures.*probes/iu)
    assert.match(ownerPolicy, /cannot|must not|不得/iu)
    assert.match(implementerPolicy, /test-contract-disputed/u)
    assert.match(
        implementerPolicy,
        /contract[\s\S]*work plan[\s\S]*slice[\s\S]*compiled prompt[\s\S]*incomplete/iu
    )
})

test('[R03] root cannot author discovery or classification facts', async () => {
    for (const layer of ['discoveryFacts', 'classificationFacts']) {
        const input = await scenario({ deepIndices: [0] })
        const record = input.dagProposal.nodes[0][layer]
        record.authoredBy = actor('root-scheduler')
        input.dagProposal.nodes[0][layer] = redigest(record)
        await expectDenied(() => compile(input), 'investigation-layer-authority')
    }
})

test('[R04] test-owner transition requires exact Sol/max runtime identity', async () => {
    for (const changedActor of [
        actor('test-owner', { model: 'gpt-5.6-luna' }),
        actor('test-owner', { effort: 'low' })
    ]) {
        const input = await scenario({ deepIndices: [0] })
        const node = input.dagProposal.nodes[0]
        await expectDenied(
            () => transition(
                input,
                node.id,
                'dispatchInvestigation',
                changedActor,
                node.dispatchInvestigation
            ),
            'test-owner-runtime-identity'
        )
    }
})

test('[P01] implementation task is complete, member-specific, and base-bound', async () => {
    const input = await scenario({ deepIndices: [0] })
    const issueId = input.dagProposal.nodes[0].id
    const built = await buildPrompt(input, issueId)
    assert.equal(built.valid, true)
    assert.equal(built.task.schema, cases.schemas.prompt)
    for (const field of cases.implementationPromptRequiredFields) {
        assert.notEqual(built.task[field], undefined, field)
        assert.notEqual(built.task[field], null, field)
        if (typeof built.task[field] === 'string') {
            assert.notEqual(built.task[field].trim(), '', field)
        }
        if (Array.isArray(built.task[field])) {
            assert.ok(built.task[field].length > 0, field)
        }
    }
    assert.equal(built.task.issueId, issueId)
    assert.equal(built.task.baseSha, cases.baseSha)
    assert.equal(
        built.task.selectorReceiptDigest,
        input.selectorReceipt.receiptDigest
    )
})

test('[P02] implementation task carries all seven revision-1 bindings', async () => {
    const input = await scenario({ deepIndices: [0] })
    const built = await buildPrompt(input, input.dagProposal.nodes[0].id)
    assert.equal(built.valid, true)
    assert.deepEqual(
        cases.revision1RequiredTaskFields.filter(
            (field) => built.task[field] === undefined
        ),
        [],
        'valid implementation task omitted revision-1 bindings'
    )
    assert.equal(built.task.testOwnerId, 'test-owner-1822')
    assert.equal(built.task.deliveryEpoch, cases.deliveryEpoch)
    assert.equal(
        built.task.classificationFactsDigest,
        input.dagProposal.nodes[0].classificationFacts.digest
    )
})

test('[D01] 100-node scope dispatches two test owners without 98 deep investigations', async () => {
    const input = await scenario({
        count: cases.largeScopeNodeCount,
        candidateCount: 2
    })
    const projection = await compile(input)
    assert.equal(projection.nodes.length, 100)
    assert.equal(projection.testOwnerCandidates.length, 2)
    assert.equal(projection.implementationReady.length, 0)
    assert.equal(
        input.dagProposal.nodes.filter(({ dispatchInvestigation }) =>
            dispatchInvestigation !== null
        ).length,
        0
    )
    const investigated = await scenario({
        count: cases.largeScopeNodeCount,
        candidateCount: 2,
        deepIndices: [0, 1]
    })
    const after = await compile(investigated)
    assert.equal(after.implementationReady.length, 2)
    assert.equal(
        investigated.dagProposal.nodes.slice(2).every(
            ({ dispatchInvestigation }) => dispatchInvestigation === null
        ),
        true
    )
    const actions = await selectActions(investigated, after)
    assert.equal(actions.dispatchCandidates.length, 2)
})

test('[D02] fifteen slots stay full while background investigation remains queued', async () => {
    const input = await scenario({
        count: cases.saturationNodeCount,
        candidateCount: 20
    })
    input.runtimeState.availableSlots = cases.configuredSlots
    const projection = await compile(input)
    const actions = await selectActions(input, projection)
    assert.equal(projection.testOwnerCandidates.length, 20)
    assert.equal(actions.investigationCandidates.length, 15)
    assert.equal(actions.dispatchCandidates.length, 0)
    assert.equal(actions.availableSlotsAfterSelection, 0)
})

test('[D03] deep members are implementation-only and never dual-dispatched', async () => {
    const input = await scenario({
        count: cases.largeScopeNodeCount,
        candidateCount: 2,
        deepIndices: [0, 1]
    })
    const projection = await compile(input)
    const actions = await selectActions(input, projection)
    const implementationIds = new Set(
        actions.dispatchCandidates.map(({ issueId }) => issueId)
    )
    const investigationIds = new Set(
        actions.investigationCandidates.map(({ issueId }) => issueId)
    )
    assert.equal(
        [...implementationIds].some((issueId) => investigationIds.has(issueId)),
        false,
        'one deeply investigated issue was dispatched as implementation and investigation'
    )
    assert.equal(
        projection.investigationQueue.some(
            ({ issueId }) => implementationIds.has(issueId)
        ),
        false,
        'deeply investigated issues remained in the investigation queue'
    )
})

test('[G01] shared group indexes never replace per-member dispatch evidence', async () => {
    const input = await scenario({ deepIndices: [0, 1] })
    const projection = await compile(input)
    assert.equal(projection.implementationReady.length, 2)
    const [first, second] = input.dagProposal.nodes
    assert.notEqual(
        first.dispatchInvestigation.issueSpecificEvidenceDigest,
        second.dispatchInvestigation.issueSpecificEvidenceDigest
    )
    assert.notEqual(
        first.dispatchInvestigation.acceptanceGroup,
        second.dispatchInvestigation.acceptanceGroup
    )
    assert.equal(
        first.dispatchInvestigation.acceptanceMap.every(
            ({ issueId }) => issueId === first.id
        ),
        true
    )
    assert.equal(
        second.dispatchInvestigation.acceptanceMap.every(
            ({ issueId }) => issueId === second.id
        ),
        true
    )
})

test('[I01] gate and frontier consume layered investigation without legacy fallback', async () => {
    await implementation()
    const gateSource = readFileSync(gatePath, 'utf8')
    const frontierSource = readFileSync(frontierPath, 'utf8')
    assert.match(gateSource, /investigation-compiler\.mjs/u)
    assert.match(gateSource, /validateInvestigationProjection/u)
    assert.doesNotMatch(gateSource, /node\.investigation\?\.codePaths/u)
    assert.doesNotMatch(gateSource, /node\.investigation\?\.testPaths/u)
    assert.doesNotMatch(gateSource, /node\.investigation\?\.currentDocs/u)
    const legacyPropertyRead =
        /node\s*(?:\.\s*investigation\b|\[\s*['"]investigation['"]\s*\])/u
    assert.doesNotMatch(frontierSource, legacyPropertyRead)
    assert.match(frontierSource, /classificationFacts/u)
    assert.match(frontierSource, /dispatchInvestigation/u)
})

test('[I02] gate invokes the investigation validator instead of import-only wiring', async () => {
    await implementation()
    const gateSource = readFileSync(gatePath, 'utf8')
    const calls = gateSource.match(/\bvalidateInvestigationProjection\s*\(/gu) ?? []
    assert.ok(
        calls.length >= 1,
        'check-dag-gate imports validateInvestigationProjection but never calls it'
    )
})

test('[MIG01] corrected #1816 is layered-only and legacy input has no dispatch authority', async () => {
    await implementation()
    const corrected1816Source = readFileSync(
        resolve(root, cases.legacyFixtureMigration.correctedLayeredTestPath),
        'utf8'
    )
    assert.doesNotMatch(corrected1816Source, /\binvestigation\s*:/u)
    assert.match(corrected1816Source, /\binvestigationProjection\b/u)
    assert.equal(
        sha256(corrected1816Source),
        cases.legacyFixtureMigration.correctedLayeredTestSha256
    )
    assert.equal(cases.legacyFixtureMigration.legacyDiagnosticReplayAllowed,
        false)
    assert.equal(cases.legacyFixtureMigration.runtimeLegacyPropertyReadsAllowed,
        false)
    assert.equal(cases.legacyFixtureMigration.compatibilityModeAllowed, false)
    assert.equal(cases.legacyFixtureMigration.fallbackAuthorityAllowed, false)
    const frontierSource = readFileSync(frontierPath, 'utf8')
    assert.match(frontierSource, /legacy-investigation-schema-forbidden/u)
    assert.match(
        frontierSource,
        /hasOwnProperty\.call\(node,\s*['"]investigation['"]\)/u
    )

    const input = await scenario({ count: 1, candidateCount: 1 })
    const layered = input.dagProposal.nodes[0]
    const legacyNode = {
        ...layered,
        ownerRepository: layered.repository,
        baseSha: cases.baseSha,
        surface: 'code',
        activeDependencies: [],
        satisfiedDependencies: [],
        allowedTestPaths: [...allowedTestPaths],
        allowedImplementationPaths: [...minimalAllowedImplementationPaths],
        investigation: {
            status: 'complete',
            codePaths: ['TODO'],
            testPaths: ['TODO'],
            currentDocs: ['N/A'],
            constraints: ['legacy']
        }
    }
    delete legacyNode.discoveryFacts
    delete legacyNode.classificationFacts
    delete legacyNode.dispatchInvestigation
    const { computeNodeEligibility } = await frontierImplementation()
    const outcome = computeNodeEligibility({
        node: legacyNode,
        dag: { nodes: [legacyNode] },
        runtimeState: {
            ...input.runtimeState,
            nodeStates: { [legacyNode.id]: { receipts: {}, terminal: null } },
            candidates: [],
            activeAttempts: [],
            deliveryFreezes: [],
            exclusiveLeases: [],
            remoteFacts: { fresh: true }
        },
        selectorReceipt: input.selectorReceipt,
        investigationProjection: null
    })
    assert.equal(outcome.ready, false)
    assert.ok(outcome.reasons.some(
        ({ code }) => code
            === cases.legacyFixtureMigration.legacyNonDispatchReasonCode
    ))
})

for (const control of mutationControls) {
    test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async () => {
        const input = await scenario({ deepIndices: [0, 1] })
        const first = input.dagProposal.nodes[0]

        if (control.id === 'root-constructs-scope') {
            input.dagProposal.resolvedIssueSet.push('Ozwasyd/FsusBlog#99999')
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'dag-agent-writes-dispatch-investigation') {
            await expectDenied(
                () => transition(
                    input,
                    first.id,
                    'dispatchInvestigation',
                    actor('dag-updater'),
                    first.dispatchInvestigation
                ),
                control.expectedCode
            )
            return
        }
        if (control.id === 'test-owner-writes-classification') {
            await expectDenied(
                () => transition(
                    input,
                    first.id,
                    'classificationFacts',
                    actor('test-owner'),
                    first.classificationFacts
                ),
                control.expectedCode
            )
            return
        }
        if (control.id === 'discovery-agent-writes-ready') {
            await expectDenied(
                () => transition(input, first.id, 'ready', actor('discovery-agent'), {}),
                control.expectedCode
            )
            return
        }
        if (control.id === 'classified-node-dispatched-to-implementer') {
            first.dispatchInvestigation = null
            await expectDenied(() => buildPrompt(input, first.id), control.expectedCode)
            return
        }
        if (control.id === 'placeholder-code-path') {
            first.dispatchInvestigation.codePaths[0].path = 'TODO'
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'empty-not-applicable-reason') {
            first.dispatchInvestigation.runtimeProbes.reasonCode = ''
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'affected-comment-reuses-classification') {
            const projection = await compile(input)
            const changedIssues = clone(input.remoteIssues)
            changedIssues[0].comments[0].body += ' owner changed'
            const { resolveSelector } = await selectorImplementation()
            input.selectorReceipt = resolveSelector({
                selector: {
                    ...input.selector,
                    selectorVersion: 'layered-investigation.mutation-comment-v2'
                },
                remoteIssues: changedIssues,
                previousReceipt: input.selectorReceipt,
                resolvedAt: cases.laterComputedAt,
                startup: runtimeStartup
            })
            const report = await freshness(input, projection)
            const reason = report.byIssue[first.id].reasons.find(
                ({ code }) => code === control.expectedCode
            )
            assert.ok(reason, JSON.stringify(report, null, 2))
            return
        }
        if (control.id === 'base-reuses-dispatch-investigation') {
            const projection = await compile(input)
            input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
            const report = await freshness(input, projection)
            assert.ok(report.byIssue[first.id].reasons.some(
                ({ code }) => code === control.expectedCode
            ))
            return
        }
        if (control.id === 'agents-digest-reuses-dispatch-investigation'
            || control.id === 'current-doc-reuses-dispatch-investigation') {
            const projection = await compile(input)
            const path = control.id.startsWith('agents')
                ? 'AGENTS.md'
                : 'docs/development/issue-orchestration-scope.md'
            input.runtimeState.currentPathDigests[path] = 'f'.repeat(64)
            const report = await freshness(input, projection)
            assert.ok(report.byIssue[first.id].reasons.some(
                ({ code }) => code === control.expectedCode
            ))
            return
        }
        if (control.id === 'legacy-full-investigation-schema') {
            first.investigation = {
                status: 'complete',
                codePaths: ['TODO'],
                testPaths: ['TODO'],
                currentDocs: ['N/A'],
                constraints: ['legacy']
            }
            delete first.discoveryFacts
            delete first.classificationFacts
            delete first.dispatchInvestigation
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'prompt-missing-counterexample'
            || control.id === 'prompt-missing-test-command') {
            const field = control.id.endsWith('counterexample')
                ? 'counterexamples'
                : 'testCommands'
            first.dispatchInvestigation.promptInputs[field] = []
            await expectDenied(() => buildPrompt(input, first.id), control.expectedCode)
            return
        }
        if (control.id === 'full-scope-reinvestigated-without-drift') {
            input.runtimeState.requestedReinvestigationIssueIds =
                input.dagProposal.nodes.map(({ id }) => id)
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'priority-changes-with-array-order') {
            const priorityInput = await scenario({
                count: 5,
                candidateCount: 5,
                deepIndices: []
            })
            const projection = await compile(priorityInput)
            assert.ok(
                projection.investigationQueue.length > 1,
                'priority mutation requires at least two queued candidates'
            )
            projection.investigationQueue.reverse()
            await expectDenied(
                () => validate(priorityInput, projection),
                control.expectedCode
            )
            return
        }
        if (control.id === 'ready-work-suppressed-by-future-investigation') {
            input.runtimeState.readyStageCandidates = [{
                issueId: 'Ozwasyd/FsusBlog#9998',
                stage: 'implementation-ready',
                capabilityReceiptDigest: 'a'.repeat(64)
            }]
            const projection = await compile(input)
            const recorded = await selectActions(input, projection)
            recorded.dispatchCandidates = []
            recorded.investigationCandidates = projection.investigationQueue.slice(0, 1)
            await expectDenied(
                () => validateActions(input, projection, recorded),
                control.expectedCode
            )
            return
        }
        if (control.id === 'group-evidence-replaces-member-contract') {
            const second = input.dagProposal.nodes[1]
            second.dispatchInvestigation = clone(first.dispatchInvestigation)
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'starvation-without-owner') {
            first.dispatchInvestigation.status = 'blocked'
            first.dispatchInvestigation.blockedSince = '2026-08-01T02:00:00.000Z'
            first.dispatchInvestigation.blockerOwner = null
            first.dispatchInvestigation.blockerEvidenceDigest = 'b'.repeat(64)
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'implementer-fills-contract-gap') {
            first.dispatchInvestigation = null
            await expectDenied(
                () => transition(
                    input,
                    first.id,
                    'dispatchInvestigation',
                    actor('code-implementer'),
                    { status: 'complete' }
                ),
                control.expectedCode
            )
            return
        }
        if (control.id === 'gate-validator-import-only') {
            const source = readFileSync(gatePath, 'utf8')
            const calls =
                source.match(/\bvalidateInvestigationProjection\s*\(/gu) ?? []
            assert.ok(calls.length >= 1, control.expectedCode)
            return
        }
        if (control.id === 'bracket-legacy-fallback') {
            const source = readFileSync(frontierPath, 'utf8')
            assert.doesNotMatch(
                source,
                /node\s*(?:\.\s*investigation\b|\[\s*['"]investigation['"]\s*\])/u,
                control.expectedCode
            )
            return
        }
        if (control.id === 'legacy-node-compat-accepted') {
            const legacyNode = {
                ...first,
                ownerRepository: first.repository,
                baseSha: cases.baseSha,
                surface: 'code',
                activeDependencies: [],
                satisfiedDependencies: [],
                allowedTestPaths: [...allowedTestPaths],
                allowedImplementationPaths: [...minimalAllowedImplementationPaths],
                investigation: { status: 'complete' }
            }
            delete legacyNode.discoveryFacts
            delete legacyNode.classificationFacts
            delete legacyNode.dispatchInvestigation
            const frontierSource = readFileSync(frontierPath, 'utf8')
            assert.match(frontierSource, new RegExp(control.expectedCode, 'u'))
            const { computeNodeEligibility } = await frontierImplementation()
            const outcome = computeNodeEligibility({
                node: legacyNode,
                dag: { nodes: [legacyNode] },
                runtimeState: {
                    ...input.runtimeState,
                    nodeStates: {
                        [legacyNode.id]: { receipts: {}, terminal: null }
                    },
                    candidates: [],
                    activeAttempts: [],
                    deliveryFreezes: [],
                    exclusiveLeases: [],
                    remoteFacts: { fresh: true }
                },
                selectorReceipt: input.selectorReceipt,
                investigationProjection: null
            })
            assert.equal(outcome.ready, false, control.expectedCode)
            assert.ok(outcome.reasons.some(
                ({ code }) => code === 'investigation-incomplete'
            ), control.expectedCode)
            return
        }
        if (control.id === 'discovered-phase-rejected') {
            first.classificationFacts = null
            first.dispatchInvestigation = null
            const projection = await compile(input)
            assert.equal(
                nodeOutcome(projection, first.id).phase,
                'discovered',
                control.expectedCode
            )
            return
        }
        if (control.id === 'root-authored-investigation-layer') {
            first.discoveryFacts.authoredBy = actor('root-scheduler')
            first.discoveryFacts = redigest(first.discoveryFacts)
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'arbitrary-layer-digest') {
            first.classificationFacts.candidateOwner = 'Ozwasyd/FsusUI'
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'nonexistent-evidence-path') {
            first.dispatchInvestigation.codePaths[0] = {
                path: 'skills/issue-orchestration/scripts/missing.mjs',
                digest: 'a'.repeat(64)
            }
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }
        if (control.id === 'implementation-task-missing-required-bindings') {
            const built = await buildPrompt(input, first.id)
            assert.deepEqual(
                cases.revision1RequiredTaskFields.filter(
                    (field) => built.task[field] === undefined
                ),
                [],
                control.expectedCode
            )
            return
        }
        if (control.id === 'test-owner-runtime-identity-drift') {
            await expectDenied(
                () => transition(
                    input,
                    first.id,
                    'dispatchInvestigation',
                    actor('test-owner', { effort: 'low' }),
                    first.dispatchInvestigation
                ),
                control.expectedCode
            )
            return
        }
        if (control.id === 'code-digest-drift-reused'
            || control.id === 'test-digest-drift-reused') {
            const projection = await compile(input)
            const path = control.id.startsWith('code')
                ? 'skills/issue-orchestration/scripts/check-dag-gate.mjs'
                : 'tests/tools/issue-orchestration-layered-investigation.test.mjs'
            input.runtimeState.currentPathDigests[path] = 'f'.repeat(64)
            const report = await freshness(input, projection)
            const member = report.byIssue[first.id]
            assert.equal(member.reuse, false, control.expectedCode)
            assert.ok(member.reasons.some(
                ({ code }) => code === control.expectedCode
            ))
            return
        }
        if (control.id === 'deep-member-dual-dispatched') {
            const projection = await compile(input)
            const actions = await selectActions(input, projection)
            const dispatchIds = new Set(
                actions.dispatchCandidates.map(({ issueId }) => issueId)
            )
            assert.equal(
                actions.investigationCandidates.some(
                    ({ issueId }) => dispatchIds.has(issueId)
                ),
                false,
                control.expectedCode
            )
            return
        }
        assert.fail(`unhandled mutation ${control.id}`)
    })
}
