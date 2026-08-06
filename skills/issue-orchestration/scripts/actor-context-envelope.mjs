import fs from 'node:fs'
import path from 'node:path'

import {
    canonical,
    digest,
    sameValue
} from './runtime-contract-lib.mjs'

const SCHEMA = 'issue-orchestration.actor-context-envelope.v1'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const INLINE_SOURCE_LIMIT = 2048
const SOURCE_LIMIT = 65536
const TOTAL_SOURCE_LIMIT = 262144
const INSTRUCTION_LIMIT = 32768

const ACTION_SPECS = Object.freeze({
    'request-semantic-proposal': Object.freeze({
        role: 'dag-creator-updater',
        phase: 'semantic-proposal',
        contextKind: 'semantic',
        outputSchema: 'issue-orchestration.semantic-proposal-output.v1',
        requiredOutputFields: ['semanticProposal']
    }),
    'request-test-contract-planning': Object.freeze({
        role: 'test-owner',
        phase: 'test-contract-planning',
        contextKind: 'planning',
        outputSchema: 'issue-orchestration.test-contract-planning-output.v1',
        requiredOutputFields: [
            'planningReceipt',
            'investigationReceipt',
            'sliceProposal',
            'dispatchInvestigation'
        ]
    }),
    'dispatch-test-contract-writer': Object.freeze({
        role: 'test-owner',
        phase: 'test-contract',
        contextKind: 'writer',
        outputSchema: 'issue-orchestration.test-contract-writer-output.v1',
        requiredOutputFields: [
            'rolloutRecords',
            'machineObservations',
            'checkpoint'
        ]
    }),
    'dispatch-implementation-writer': Object.freeze({
        role: null,
        phase: null,
        contextKind: 'writer',
        outputSchema: 'issue-orchestration.implementation-writer-output.v1',
        requiredOutputFields: [
            'rolloutRecords',
            'machineObservations',
            'checkpoint'
        ]
    }),
    'dispatch-behavior-verifier': Object.freeze({
        role: 'test-owner',
        phase: 'behavior-verification',
        contextKind: 'verifier',
        outputSchema: 'issue-orchestration.behavior-verifier-output.v1',
        requiredOutputFields: ['behaviorEvidence']
    }),
    'request-ui-adjudication': Object.freeze({
        role: 'ui-system-adjudicator',
        phase: 'adjudication',
        contextKind: 'adjudicator',
        outputSchema: 'issue-orchestration.ui-adjudication-output.v1',
        requiredOutputFields: ['uiAdjudication']
    }),
    'dispatch-ux-acceptance-verifier': Object.freeze({
        role: 'ux-acceptance-verifier',
        phase: 'ux-acceptance',
        contextKind: 'verifier',
        outputSchema: 'issue-orchestration.ux-acceptance-output.v1',
        requiredOutputFields: ['uxAcceptance']
    }),
    'dispatch-documentation-writer': Object.freeze({
        role: 'documentation-writer',
        phase: 'documentation',
        contextKind: 'writer',
        outputSchema: 'issue-orchestration.documentation-writer-output.v1',
        requiredOutputFields: [
            'rolloutRecords',
            'machineObservations',
            'checkpoint'
        ]
    })
})

const IDENTITY_FIELDS = Object.freeze([
    'runId',
    'memberId',
    'repository',
    'issueNumber',
    'baseSha',
    'nodeEpoch',
    'selectorReceiptDigest',
    'remoteSnapshotDigest',
    'semanticGraphDigest',
    'aggregateProjectionDigest',
    'nodeProjectionDigest',
    'priorLedgerHeadDigest',
    'policyDigest',
    'runtimeCapabilityBindingDigest',
    'lifecycleAuthorityBindingDigest',
    'startupAttestationDigest',
    'runtimeInvocationId',
    'runtimeSessionId',
    'rootAuthorityEpoch',
    'runtimeTrustBindingDigest',
    'repositoryIdentitySetDigest',
    'repositoryBindingSetDigest',
    'repositoryBindingDigest',
    'packageDigest',
    'manifestDigest',
    'policySetDigest'
])

const TOP_LEVEL_KEYS = new Set([
    'schema', 'status', 'authority', 'role', 'phase', 'actionType',
    'identities', 'acceptanceItemIds', 'stageContext', 'instructions',
    'sources', 'outputInterface', 'measurement', 'envelopeDigest'
])
const IDENTITY_KEYS = new Set([
    'actionDigest', 'actionSetDigest', 'nodeId', ...IDENTITY_FIELDS
])
const STAGE_CONTEXT_KEYS = Object.freeze({
    semantic: new Set([
        'kind', 'lifecycleState', 'owner', 'sourceCoverage',
        'selectorReceiptDigest', 'semanticFactsDigest'
    ]),
    planning: new Set([
        'kind', 'lifecycleState', 'owner', 'acceptanceContract',
        'testContractDigest', 'planningAttemptId', 'sourceCoverage'
    ]),
    writer: new Set([
        'kind', 'lifecycleState', 'owner', 'stageWorkPlan',
        'executableSlice', 'compiledPrompt', 'firstRequiredAction',
        'readTargets', 'writeAllowlist', 'requiredCommands', 'recovery'
    ]),
    adjudicator: new Set([
        'kind', 'lifecycleState', 'owner', 'candidate',
        'candidateDigest', 'acceptanceContract', 'testContractDigest'
    ]),
    verifier: new Set([
        'kind', 'lifecycleState', 'owner', 'candidate',
        'candidateDigest', 'acceptanceContract', 'testContractDigest',
        'uiAdjudication', 'uiAdjudicationDigest', 'recovery'
    ])
})
const INSTRUCTION_KEYS = new Set([
    'path', 'digest', 'text', 'appliesToPaths'
])
const SOURCE_BASE_KEYS = new Set([
    'sourceId', 'kind', 'path', 'digest', 'bytes', 'role', 'phase', 'nodeId'
])

const FORBIDDEN_SOURCE_KINDS = new Set([
    'secret',
    'credential',
    'private-key',
    'complete-ledger',
    'complete-projection',
    'complete-dag',
    'unrelated-node',
    'future-stage-history',
    'root-summary',
    'complete-log'
])

const FORBIDDEN_ENVELOPE_KEYS = new Set([
    'ledger',
    'actionSet',
    'semanticGraph',
    'aggregateProjection',
    'nodeIndex',
    'startup',
    'repositoryTargets',
    'runtimeTrustBinding',
    'lifecycleAuthority',
    'rootSummary',
    'completeIssueHistory',
    'writerConversation',
    'futureStageHistory'
])

const FAILURE_VOCABULARY = Object.freeze([
    'actor-input-incomplete',
    'actor-authority-disputed',
    'actor-progressive-read-rejected',
    'actor-output-schema-invalid'
])

export class ActorContextEnvelopeError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'ActorContextEnvelopeError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new ActorContextEnvelopeError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function clone(value) {
    return structuredClone(value)
}

function exactKeys(value, allowed, code) {
    object(value, code)
    const extras = Object.keys(value).filter((key) => !allowed.has(key))
    if (extras.length > 0) fail(code, { extras: extras.sort() })
    return value
}

function sameList(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
        left.length === right.length &&
        left.every((entry, index) => entry === right[index])
}

function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8')
}

function normalizeStringList(value = []) {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((entry) =>
        typeof entry === 'string' && entry.length > 0))].sort()
}

function acceptanceIds(plan, slice, contract) {
    const values = [
        ...(slice?.acceptanceItemIds ?? []),
        ...(plan?.acceptanceItems ?? []),
        ...(contract?.acceptanceItems ?? [])
    ]
    return [...new Set(values.map((entry) => {
        if (typeof entry === 'string') return entry
        if (!entry || typeof entry !== 'object') return null
        return entry.id ?? entry.acceptanceItemId ?? entry.key ?? null
    }).filter(Boolean))].sort()
}

function actionSpec(action, node) {
    const spec = ACTION_SPECS[action?.type]
    if (!spec) fail('actor-context-action-unsupported', {
        actionType: action?.type ?? null
    })
    if (action.type !== 'dispatch-implementation-writer') return spec
    const ui = node?.uiClass === 'ui'
    return Object.freeze({
        ...spec,
        role: ui ? 'ui-ux-implementer' : 'code-implementer',
        phase: ui ? 'ui-implementation' : 'implementation'
    })
}

function exactAction(action, actionSet) {
    object(action, 'actor-context-action-required')
    object(action.bindings, 'actor-context-action-bindings-required')
    text(action.actionDigest, 'actor-context-action-digest-required')
    if (!HASH.test(action.actionDigest)) {
        fail('actor-context-action-digest-invalid')
    }
    if (actionSet?.schema !== 'issue-orchestration.lifecycle-action-set.v1' ||
        !Array.isArray(actionSet.actions) ||
        !HASH.test(actionSet.actionSetDigest ?? '')) {
        fail('actor-context-action-set-invalid')
    }
    const current = actionSet.actions.find((candidate) =>
        candidate.actionDigest === action.actionDigest)
    if (!current || !sameValue(current, action)) {
        fail('actor-context-action-stale')
    }
    return action
}

function projectionNode(projection, action) {
    object(projection, 'actor-context-projection-required')
    const nodes = projection?.state?.nodes
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
        fail('actor-context-node-projection-required')
    }
    const node = nodes[action.nodeId]
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        fail('actor-context-node-missing', { nodeId: action.nodeId })
    }
    return node
}

function receiptPayload(receipt, field) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        return null
    }
    if (receipt[field] !== undefined) return receipt[field]
    if (receipt.evidence?.[field] !== undefined) {
        return receipt.evidence[field]
    }
    return null
}

function receiptDigest(receipt) {
    if (!receipt || typeof receipt !== 'object') return null
    for (const field of [
        'receiptDigest',
        'contractDigest',
        'workPlanDigest',
        'sliceDigest',
        'promptDigest',
        'routeDecisionDigest',
        'bindingDigest',
        'proposalDigest'
    ]) {
        if (HASH.test(receipt[field] ?? '')) return receipt[field]
    }
    return digest(receipt)
}

function recoveryContext(node) {
    const failure = node.firstFailure
    const recovery = node.recoveryState
    if (!failure && !recovery) return null
    return canonical({
        firstFailure: failure ? {
            category: failure.category ?? failure.failureCategory ?? null,
            identity: failure.identity ?? failure.failureId ?? null,
            digest: receiptDigest(failure)
        } : null,
        checkpointCursor:
            recovery?.checkpointCursor ??
            recovery?.cursor ??
            recovery?.nextRequiredAction ??
            null,
        continuationDigest:
            receiptDigest(node.receipts?.continuation) ??
            receiptDigest(node.receipts?.retryAuthorization) ??
            null
    })
}

function stageArtifacts(node) {
    const receipts = node.receipts ?? {}
    return {
        acceptanceContract:
            receiptPayload(receipts.acceptanceContract, 'acceptanceContract'),
        workPlan: receiptPayload(receipts.workPlan, 'plan'),
        executableSlice: receiptPayload(receipts.executableSlice, 'slice'),
        compiledPrompt: receiptPayload(receipts.compiledPrompt, 'prompt'),
        candidate: receiptPayload(receipts.candidate, 'candidate') ??
            receipts.candidate?.evidence ?? null,
        uiAdjudication: receiptPayload(
            receipts.uiAdjudication,
            'uiAdjudication'
        ) ?? receipts.uiAdjudication?.evidence ?? null,
        testContractDigest:
            receiptDigest(receipts.testContract) ??
            receiptDigest(receipts.acceptanceContract),
        candidateDigest: receiptDigest(receipts.candidate),
        adjudicationDigest: receiptDigest(receipts.uiAdjudication)
    }
}

function boundedIssueFacts(issue) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return null
    const value = {}
    for (const field of [
        'repository',
        'number',
        'state',
        'stateReason',
        'updatedAt',
        'title',
        'body',
        'comments',
        'labels',
        'milestone',
        'dependsOn',
        'acceptanceGroup'
    ]) {
        if (issue[field] !== undefined) value[field] = clone(issue[field])
    }
    return canonical(value)
}

function stageContext({ action, node, spec, preparedContext }) {
    const artifacts = stageArtifacts(node)
    const recovery = recoveryContext(node)
    const common = {
        kind: spec.contextKind,
        lifecycleState: node.lifecycleState ?? null,
        owner: node.owner ?? null
    }
    if (spec.contextKind === 'semantic') {
        const issue = boundedIssueFacts(preparedContext?.inputs?.issue)
        return canonical({
            ...common,
            sourceCoverage: issue ? {
                issueFactsDigest: digest(issue),
                issueSourceId: 'authoritative-issue-facts'
            } : null,
            selectorReceiptDigest:
                action.bindings.selectorReceiptDigest,
            semanticFactsDigest: node.semanticFactsDigest ?? null
        })
    }
    if (spec.contextKind === 'planning') {
        if (!artifacts.acceptanceContract) {
            fail('actor-context-acceptance-contract-required')
        }
        return canonical({
            ...common,
            acceptanceContract: clone(artifacts.acceptanceContract),
            testContractDigest: artifacts.testContractDigest,
            planningAttemptId: preparedContext?.inputs?.attemptId ?? null,
            sourceCoverage: preparedContext?.inputs?.issue ? {
                issueFactsDigest: digest(
                    boundedIssueFacts(preparedContext.inputs.issue)
                ),
                issueSourceId: 'authoritative-issue-facts'
            } : null
        })
    }
    if (spec.contextKind === 'writer') {
        if (!artifacts.workPlan ||
            !artifacts.executableSlice ||
            !artifacts.compiledPrompt) {
            fail('actor-context-writer-artifacts-required')
        }
        const slice = artifacts.executableSlice
        return canonical({
            ...common,
            stageWorkPlan: clone(artifacts.workPlan),
            executableSlice: clone(slice),
            compiledPrompt: clone(artifacts.compiledPrompt),
            firstRequiredAction: slice.firstRequiredAction ?? null,
            readTargets: normalizeStringList(
                slice.requiredFiles ?? slice.readTargets ?? []
            ),
            writeAllowlist: normalizeStringList(slice.allowedPaths ?? []),
            requiredCommands: normalizeStringList(
                slice.requiredCommands ?? []
            ),
            recovery
        })
    }
    if (spec.contextKind === 'adjudicator') {
        if (!artifacts.candidate || !artifacts.acceptanceContract) {
            fail('actor-context-adjudication-evidence-required')
        }
        return canonical({
            ...common,
            candidate: clone(artifacts.candidate),
            candidateDigest: artifacts.candidateDigest,
            acceptanceContract: clone(artifacts.acceptanceContract),
            testContractDigest: artifacts.testContractDigest
        })
    }
    if (!artifacts.candidate || !artifacts.acceptanceContract) {
        fail('actor-context-verifier-evidence-required')
    }
    if (action.type === 'dispatch-ux-acceptance-verifier' &&
        !artifacts.uiAdjudication) {
        fail('actor-context-ui-adjudication-required')
    }
    return canonical({
        ...common,
        candidate: clone(artifacts.candidate),
        candidateDigest: artifacts.candidateDigest,
        acceptanceContract: clone(artifacts.acceptanceContract),
        testContractDigest: artifacts.testContractDigest,
        uiAdjudication: artifacts.uiAdjudication ?
            clone(artifacts.uiAdjudication) : null,
        uiAdjudicationDigest: artifacts.adjudicationDigest,
        recovery
    })
}

function identityEnvelope(action, actionSet) {
    const result = {
        actionDigest: action.actionDigest,
        actionSetDigest: actionSet.actionSetDigest,
        nodeId: action.nodeId ?? null
    }
    for (const field of IDENTITY_FIELDS) {
        if (action.bindings[field] !== undefined) {
            result[field] = clone(action.bindings[field])
        }
    }
    for (const field of [
        'selectorReceiptDigest',
        'remoteSnapshotDigest',
        'semanticGraphDigest',
        'aggregateProjectionDigest',
        'policyDigest',
        'runtimeCapabilityBindingDigest',
        'lifecycleAuthorityBindingDigest',
        'startupAttestationDigest'
    ]) {
        if (result[field] !== actionSet[field]) {
            fail('actor-context-identity-mismatch', { field })
        }
    }
    if (!text(result.runId, 'actor-context-run-id-required') ||
        !text(result.repository, 'actor-context-repository-required') ||
        !Number.isInteger(result.issueNumber) ||
        !SHA.test(result.baseSha ?? '')) {
        fail('actor-context-core-identity-invalid')
    }
    return canonical(result)
}

function safeRelativePath(value, code) {
    text(value, code)
    if (value.startsWith('issue://')) return value
    if (path.isAbsolute(value)) fail(code)
    const normalized = value.replaceAll('\\', '/')
    if (normalized === '..' || normalized.startsWith('../') ||
        normalized.includes('/../')) {
        fail(code)
    }
    return normalized
}

function containsSecret(value) {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\b(password|credential|api[_-]?key|secret[_-]?key)\s*[:=]/iu
        .test(value)
}

function instructionFiles(repositoryPath, allowedPaths) {
    if (!repositoryPath || !fs.existsSync(repositoryPath)) return []
    const root = fs.realpathSync(repositoryPath)
    const directories = new Set([root])
    for (const target of allowedPaths) {
        if (target.includes('*')) continue
        const absolute = path.resolve(root, target)
        if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) {
            fail('actor-context-instruction-path-escape')
        }
        let current = path.dirname(absolute)
        while (current.startsWith(root)) {
            directories.add(current)
            if (current === root) break
            current = path.dirname(current)
        }
    }
    const files = []
    for (const directory of [...directories].sort()) {
        for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
            const absolute = path.join(directory, name)
            if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
                continue
            }
            const source = fs.readFileSync(absolute, 'utf8')
            if (utf8Bytes(source) > INSTRUCTION_LIMIT) {
                fail('actor-context-instruction-too-large', {
                    path: path.relative(root, absolute)
                })
            }
            files.push({
                path: path.relative(root, absolute).replaceAll('\\', '/'),
                digest: digest(source),
                text: source,
                appliesToPaths: allowedPaths
            })
        }
    }
    return files
}

function compileInstructions({ repositoryPath, allowedPaths, explicit }) {
    const entries = [
        ...instructionFiles(repositoryPath, allowedPaths),
        ...(explicit ?? [])
    ].map((entry) => {
        object(entry, 'actor-context-instruction-invalid')
        const source = text(
            entry.text,
            'actor-context-instruction-text-required'
        )
        if (utf8Bytes(source) > INSTRUCTION_LIMIT || containsSecret(source)) {
            fail('actor-context-instruction-unsafe')
        }
        const instructionPath = safeRelativePath(
            entry.path,
            'actor-context-instruction-path-invalid'
        )
        const computed = digest(source)
        if (entry.digest && entry.digest !== computed) {
            fail('actor-context-instruction-digest-mismatch')
        }
        return canonical({
            path: instructionPath,
            digest: computed,
            text: source,
            appliesToPaths: normalizeStringList(
                entry.appliesToPaths ?? allowedPaths
            )
        })
    })
    const unique = new Map(entries.map((entry) => [
        `${entry.path}:${entry.digest}`,
        entry
    ]))
    const sorted = [...unique.values()].sort((left, right) =>
        left.path.localeCompare(right.path) ||
        left.digest.localeCompare(right.digest))
    return canonical({
        status: sorted.length > 0 ? 'resolved' : 'none-applicable',
        entries: sorted
    })
}

function automaticSourceBlocks(action, spec, preparedContext) {
    if (!['semantic', 'planning'].includes(spec.contextKind)) return []
    const issue = boundedIssueFacts(preparedContext?.inputs?.issue)
    if (!issue) return []
    const source = JSON.stringify(canonical(issue))
    return [{
        sourceId: 'authoritative-issue-facts',
        kind: 'authoritative-issue-facts',
        path: `issue://${action.bindings.repository}#${action.bindings.issueNumber}`,
        text: source,
        allowedRoles: [spec.role],
        allowedPhases: [spec.phase],
        nodeId: action.nodeId
    }]
}

function compileSources({ action, spec, explicit, preparedContext }) {
    const blocks = [
        ...automaticSourceBlocks(action, spec, preparedContext),
        ...(explicit ?? [])
    ]
    let totalBytes = 0
    const inline = []
    const progressive = []
    for (const entry of blocks) {
        object(entry, 'actor-context-source-invalid')
        const kind = text(entry.kind, 'actor-context-source-kind-required')
        if (FORBIDDEN_SOURCE_KINDS.has(kind) ||
            (spec.contextKind === 'writer' &&
                kind === 'raw-complete-issue')) {
            fail('actor-context-source-kind-forbidden', { kind })
        }
        const sourcePath = safeRelativePath(
            entry.path,
            'actor-context-source-path-invalid'
        )
        if (/(secret|credential|private[-_]?key)/iu.test(
            `${kind}:${sourcePath}`
        )) {
            fail('actor-context-source-kind-forbidden', { kind })
        }
        const source = text(entry.text, 'actor-context-source-text-required')
        const bytes = utf8Bytes(source)
        totalBytes += bytes
        if (bytes > SOURCE_LIMIT || totalBytes > TOTAL_SOURCE_LIMIT ||
            containsSecret(source)) {
            fail('actor-context-source-size-or-secret-invalid', {
                sourceId: entry.sourceId ?? null
            })
        }
        const allowedRoles = normalizeStringList(
            entry.allowedRoles ?? [spec.role]
        )
        const allowedPhases = normalizeStringList(
            entry.allowedPhases ?? [spec.phase]
        )
        if (!allowedRoles.includes(spec.role) ||
            !allowedPhases.includes(spec.phase) ||
            (entry.nodeId ?? action.nodeId) !== action.nodeId) {
            fail('actor-context-source-scope-invalid')
        }
        const sourceDigest = digest(source)
        if (entry.digest && entry.digest !== sourceDigest) {
            fail('actor-context-source-digest-mismatch')
        }
        const sourceId = entry.sourceId ??
            `source-${sourceDigest.slice(0, 16)}`
        const common = canonical({
            sourceId,
            kind,
            path: sourcePath,
            digest: sourceDigest,
            bytes,
            role: spec.role,
            phase: spec.phase,
            nodeId: action.nodeId
        })
        if (bytes <= INLINE_SOURCE_LIMIT) {
            inline.push(canonical({ ...common, text: source }))
        } else {
            progressive.push(canonical({
                ...common,
                referenceId: `ref-${sourceDigest.slice(0, 24)}`
            }))
        }
    }
    return {
        document: canonical({
            inline: inline.sort((left, right) =>
                left.sourceId.localeCompare(right.sourceId)),
            progressive: progressive.sort((left, right) =>
                left.referenceId.localeCompare(right.referenceId)),
            totalSourceBytes: totalBytes
        }),
        catalog: blocks.map((entry) => Object.freeze({
            sourceId: entry.sourceId ??
                `source-${digest(entry.text).slice(0, 16)}`,
            kind: entry.kind,
            path: entry.path,
            text: entry.text
        }))
    }
}

function allowedPaths(stage) {
    if (stage?.kind !== 'writer') return []
    return normalizeStringList(stage.executableSlice?.allowedPaths ?? [])
}

function scanForbiddenKeys(value, location = '$') {
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            scanForbiddenKeys(entry, `${location}[${index}]`))
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_ENVELOPE_KEYS.has(key)) {
            fail('actor-context-forbidden-field', { key, location })
        }
        scanForbiddenKeys(entry, `${location}.${key}`)
    }
}

function measurement(core, sources, instructions) {
    const envelopeBytes = utf8Bytes(JSON.stringify(canonical(core)))
    const inlineSourceBytes = sources.inline.reduce(
        (sum, entry) => sum + entry.bytes,
        0
    )
    const instructionBytes = instructions.entries.reduce(
        (sum, entry) => sum + utf8Bytes(entry.text),
        0
    )
    return canonical({
        envelopeBytes,
        estimatedTokens: Math.ceil(envelopeBytes / 4),
        inlineSourceBytes,
        progressiveSourceBytes:
            sources.progressive.reduce((sum, entry) => sum + entry.bytes, 0),
        instructionBytes
    })
}

export function compileActorContextBundle({
    action,
    actionSet,
    projection,
    preparedContext = {},
    actorContext = {},
    repositoryPath = null
} = {}) {
    exactAction(action, actionSet)
    const node = projectionNode(projection, action)
    const spec = actionSpec(action, node)
    const stage = stageContext({
        action,
        node,
        spec,
        preparedContext
    })
    const paths = allowedPaths(stage)
    const instructions = compileInstructions({
        repositoryPath,
        allowedPaths: paths,
        explicit: actorContext.instructions
    })
    if (actorContext.requiredInstructionDigests) {
        const actual = new Set(instructions.entries.map(({ digest: item }) =>
            item))
        for (const required of actorContext.requiredInstructionDigests) {
            if (!actual.has(required)) {
                fail('actor-context-required-instruction-missing', {
                    digest: required
                })
            }
        }
    }
    const compiledSources = compileSources({
        action,
        spec,
        explicit: actorContext.sourceBlocks,
        preparedContext
    })
    const sources = compiledSources.document
    const artifacts = stageArtifacts(node)
    const core = canonical({
        schema: SCHEMA,
        status: 'compiled',
        authority: {
            kind: 'actor-input-only',
            grants: []
        },
        role: spec.role,
        phase: spec.phase,
        actionType: action.type,
        identities: identityEnvelope(action, actionSet),
        acceptanceItemIds: acceptanceIds(
            artifacts.workPlan,
            artifacts.executableSlice,
            artifacts.acceptanceContract
        ),
        stageContext: stage,
        instructions,
        sources,
        outputInterface: {
            schema: spec.outputSchema,
            requiredFields: [...spec.requiredOutputFields],
            failureVocabulary: [...FAILURE_VOCABULARY]
        }
    })
    scanForbiddenKeys(core)
    const result = {
        ...core,
        measurement: measurement(core, sources, instructions)
    }
    result.envelopeDigest = digest(result)
    return Object.freeze({
        envelope: validateActorContextEnvelope(result),
        sourceCatalog: Object.freeze(compiledSources.catalog)
    })
}

export function compileActorContextEnvelope(options = {}) {
    return compileActorContextBundle(options).envelope
}

function validateClosedEnvelopeShape(envelope) {
    exactKeys(envelope, TOP_LEVEL_KEYS, 'actor-context-top-level-fields-invalid')
    exactKeys(envelope.authority, new Set(['kind', 'grants']),
        'actor-context-authority-fields-invalid')
    exactKeys(envelope.identities, IDENTITY_KEYS,
        'actor-context-identity-fields-invalid')
    const stageKeys = STAGE_CONTEXT_KEYS[envelope.stageContext?.kind]
    if (!stageKeys) fail('actor-context-stage-kind-invalid')
    exactKeys(envelope.stageContext, stageKeys,
        'actor-context-stage-fields-invalid')
    exactKeys(envelope.instructions, new Set(['status', 'entries']),
        'actor-context-instruction-container-invalid')
    if (!Array.isArray(envelope.instructions.entries)) {
        fail('actor-context-instruction-container-invalid')
    }
    for (const entry of envelope.instructions.entries) {
        exactKeys(entry, INSTRUCTION_KEYS,
            'actor-context-instruction-fields-invalid')
    }
    exactKeys(envelope.sources,
        new Set(['inline', 'progressive', 'totalSourceBytes']),
        'actor-context-source-container-invalid')
    if (!Array.isArray(envelope.sources.inline) ||
        !Array.isArray(envelope.sources.progressive)) {
        fail('actor-context-source-container-invalid')
    }
    for (const entry of envelope.sources.inline) {
        exactKeys(entry, new Set([...SOURCE_BASE_KEYS, 'text']),
            'actor-context-inline-source-fields-invalid')
    }
    for (const entry of envelope.sources.progressive) {
        exactKeys(entry, new Set([...SOURCE_BASE_KEYS, 'referenceId']),
            'actor-context-progressive-source-fields-invalid')
    }
    exactKeys(envelope.outputInterface,
        new Set(['schema', 'requiredFields', 'failureVocabulary']),
        'actor-context-output-interface-fields-invalid')
    exactKeys(envelope.measurement, new Set([
        'envelopeBytes', 'estimatedTokens', 'inlineSourceBytes',
        'progressiveSourceBytes', 'instructionBytes'
    ]), 'actor-context-measurement-fields-invalid')
}

function validateActionInterface(envelope) {
    const spec = ACTION_SPECS[envelope.actionType]
    const validImplementationPair =
        envelope.actionType === 'dispatch-implementation-writer' && (
            (envelope.role === 'code-implementer' &&
                envelope.phase === 'implementation') ||
            (envelope.role === 'ui-ux-implementer' &&
                envelope.phase === 'ui-implementation')
        )
    if (!validImplementationPair &&
        (envelope.role !== spec.role || envelope.phase !== spec.phase)) {
        fail('actor-context-role-phase-invalid')
    }
    if (envelope.stageContext.kind !== spec.contextKind ||
        envelope.outputInterface.schema !== spec.outputSchema ||
        !sameList(
            envelope.outputInterface.requiredFields,
            spec.requiredOutputFields
        ) ||
        !sameList(
            envelope.outputInterface.failureVocabulary,
            FAILURE_VOCABULARY
        )) {
        fail('actor-context-interface-mismatch')
    }
}

export function validateActorContextEnvelope(envelope) {
    object(envelope, 'actor-context-envelope-required')
    validateClosedEnvelopeShape(envelope)
    validateActionInterface(envelope)
    if (envelope.schema !== SCHEMA ||
        envelope.status !== 'compiled' ||
        envelope.authority?.kind !== 'actor-input-only' ||
        !Array.isArray(envelope.authority?.grants) ||
        envelope.authority.grants.length !== 0 ||
        !ACTION_SPECS[envelope.actionType] ||
        !HASH.test(envelope.identities?.actionDigest ?? '') ||
        !HASH.test(envelope.identities?.actionSetDigest ?? '') ||
        !HASH.test(envelope.envelopeDigest ?? '')) {
        fail('actor-context-envelope-invalid')
    }
    const unsigned = clone(envelope)
    delete unsigned.envelopeDigest
    if (digest(unsigned) !== envelope.envelopeDigest) {
        fail('actor-context-envelope-digest-mismatch')
    }
    scanForbiddenKeys(envelope)
    return Object.freeze(clone(envelope))
}

export function validateActorContextEnvelopeBinding(envelope, {
    action,
    role,
    phase,
    nodeId = action?.nodeId
} = {}) {
    const value = validateActorContextEnvelope(envelope)
    if (value.actionType !== action?.type ||
        value.identities.actionDigest !== action?.actionDigest ||
        value.identities.nodeId !== nodeId ||
        value.role !== role ||
        value.phase !== phase) {
        fail('actor-context-envelope-binding-mismatch')
    }
    return value
}

export function resolveActorContextReference({
    envelope,
    referenceId,
    role,
    phase,
    nodeId,
    path: expectedPath,
    digest: expectedDigest,
    sourceBlocks = []
} = {}) {
    const value = validateActorContextEnvelope(envelope)
    const reference = value.sources.progressive.find((entry) =>
        entry.referenceId === referenceId)
    if (!reference ||
        reference.role !== role ||
        reference.phase !== phase ||
        reference.nodeId !== nodeId ||
        reference.path !== expectedPath ||
        reference.digest !== expectedDigest ||
        value.role !== role ||
        value.phase !== phase ||
        value.identities.nodeId !== nodeId) {
        fail('actor-context-progressive-reference-rejected')
    }
    const source = sourceBlocks.find((entry) =>
        (entry.sourceId ?? `source-${digest(entry.text).slice(0, 16)}`) ===
            reference.sourceId)
    if (!source ||
        source.path !== reference.path ||
        digest(source.text) !== reference.digest) {
        fail('actor-context-progressive-source-mismatch')
    }
    return Object.freeze({
        referenceId,
        path: reference.path,
        digest: reference.digest,
        text: source.text
    })
}

export function createActorContextProgressiveReader({
    envelope,
    sourceCatalog = []
} = {}) {
    validateActorContextEnvelope(envelope)
    return Object.freeze((request = {}) => resolveActorContextReference({
        envelope,
        sourceBlocks: sourceCatalog,
        ...request
    }))
}

export const actorContextEnvelopeActionTypes = Object.freeze(
    Object.keys(ACTION_SPECS).sort()
)
