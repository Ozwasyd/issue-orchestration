import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
    canonical,
    digest
} from './runtime-contract-lib.mjs'

const SCHEMA = 'issue-orchestration.repository-evidence-pack.v1'
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const FILE_LIMIT = 65536
const FAILURE_LIMIT = 16384
const SEARCH_OUTPUT_LIMIT = 8192
const MAX_SEARCHES = 16
const MAX_MATCHES = 32

const TOP_LEVEL_KEYS = new Set([
    'schema', 'status', 'authority', 'role', 'phase', 'nodeId',
    'inputIdentity', 'scopeMap', 'instructions', 'commands',
    'testOwnership', 'gitEvidence', 'sourceReferences', 'searches',
    'failureEvidence', 'measurement', 'packDigest'
])
const INPUT_IDENTITY_KEYS = new Set([
    'repository', 'baseSha', 'actionDigest', 'sliceDigest',
    'instructionSetDigest', 'requestDigest'
])
const SCOPE_KEYS = new Set([
    'path', 'access', 'exists', 'kind', 'bytes', 'contentDigest'
])
const INSTRUCTION_KEYS = new Set(['path', 'digest', 'appliesToPaths'])
const COMMAND_KEYS = new Set(['command', 'digest', 'declaredPaths'])
const OWNERSHIP_KEYS = new Set(['testPath', 'commandDigest', 'nearbyPaths'])
const GIT_KEYS = new Set([
    'status', 'observedHead', 'baseReachable', 'candidateSha',
    'candidateReachable', 'pathStatus', 'diffStat', 'observationDigest'
])
const REFERENCE_KEYS = new Set([
    'sourceId', 'kind', 'path', 'digest', 'bytes'
])
const SEARCH_KEYS = new Set([
    'query', 'path', 'matchCount', 'sourceId', 'digest'
])
const FAILURE_KEYS = new Set([
    'command', 'failureDigest', 'sourceId', 'digest', 'bytes'
])
const MEASUREMENT_KEYS = new Set([
    'packBytes', 'sourceBytes', 'filesObserved', 'searchesExecuted',
    'commandsBound'
])

export class RepositoryEvidencePackError extends Error {
    constructor(code, details = {}) {
        super(code)
        this.name = 'RepositoryEvidencePackError'
        this.code = code
        this.details = details
    }
}

function fail(code, details = {}) {
    throw new RepositoryEvidencePackError(code, details)
}

function object(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
    return value
}

function text(value, code) {
    if (typeof value !== 'string' || value.length === 0) fail(code)
    return value
}

function exactKeys(value, allowed, code) {
    object(value, code)
    const extras = Object.keys(value).filter((key) => !allowed.has(key))
    if (extras.length > 0) fail(code, { extras: extras.sort() })
}

function bytes(value) {
    return Buffer.byteLength(value, 'utf8')
}

function stringList(value = []) {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((entry) =>
        typeof entry === 'string' && entry.length > 0))].sort()
}

function containsSecret(value) {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\b(password|credential|api[_-]?key|secret[_-]?key)\s*[:=]/iu
        .test(value)
}

function normalizeRelative(value, code) {
    text(value, code)
    if (path.isAbsolute(value)) fail(code)
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '')
    if (normalized === '..' || normalized.startsWith('../') ||
        normalized.includes('/../') || normalized.includes('\0')) {
        fail(code)
    }
    return normalized
}

function regexEscape(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function patternRegex(pattern) {
    const normalized = normalizeRelative(pattern, 'evidence-pack-pattern-invalid')
    const tokens = normalized.split('/').map((token) => {
        if (token === '**') return '.*'
        return regexEscape(token)
            .replaceAll('\\*', '[^/]*')
            .replaceAll('\\?', '[^/]')
    })
    return new RegExp(`^${tokens.join('/')}$`, 'u')
}

function pathAllowed(relative, patterns) {
    return patterns.some((pattern) => patternRegex(pattern).test(relative))
}

function safeRoot(repositoryPath) {
    text(repositoryPath, 'evidence-pack-repository-path-required')
    if (!fs.existsSync(repositoryPath) ||
        !fs.statSync(repositoryPath).isDirectory()) {
        fail('evidence-pack-repository-path-invalid')
    }
    return fs.realpathSync(repositoryPath)
}

function resolvePath(root, relative) {
    const normalized = normalizeRelative(relative,
        'evidence-pack-path-invalid')
    if (normalized.includes('*') || normalized.includes('?')) return null
    const absolute = path.resolve(root, normalized)
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        fail('evidence-pack-path-escape', { path: normalized })
    }
    if (fs.existsSync(absolute)) {
        const real = fs.realpathSync(absolute)
        if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
            fail('evidence-pack-path-symlink-escape', { path: normalized })
        }
    }
    return { normalized, absolute }
}

function fileObservation(root, relative, access) {
    const resolved = resolvePath(root, relative)
    if (!resolved) {
        return canonical({
            path: normalizeRelative(relative, 'evidence-pack-path-invalid'),
            access,
            exists: false,
            kind: 'pattern',
            bytes: 0,
            contentDigest: null
        })
    }
    if (!fs.existsSync(resolved.absolute)) {
        return canonical({
            path: resolved.normalized,
            access,
            exists: false,
            kind: 'missing',
            bytes: 0,
            contentDigest: null
        })
    }
    const stat = fs.statSync(resolved.absolute)
    if (stat.isDirectory()) {
        return canonical({
            path: resolved.normalized,
            access,
            exists: true,
            kind: 'directory',
            bytes: 0,
            contentDigest: null
        })
    }
    if (!stat.isFile()) fail('evidence-pack-path-kind-unsupported', {
        path: resolved.normalized
    })
    const content = fs.readFileSync(resolved.absolute, 'utf8')
    if (bytes(content) > FILE_LIMIT || containsSecret(content)) {
        fail('evidence-pack-file-size-or-secret-invalid', {
            path: resolved.normalized
        })
    }
    return canonical({
        path: resolved.normalized,
        access,
        exists: true,
        kind: 'file',
        bytes: bytes(content),
        contentDigest: digest(content)
    })
}

function sourceBlock({ sourceId, kind, relative, content, role, phase, nodeId }) {
    if (bytes(content) > FILE_LIMIT || containsSecret(content)) {
        fail('evidence-pack-source-size-or-secret-invalid', { sourceId })
    }
    return Object.freeze({
        sourceId,
        kind,
        path: relative,
        text: content,
        allowedRoles: [role],
        allowedPhases: [phase],
        nodeId
    })
}

function commandPaths(command, allowedPatterns) {
    const candidates = command.match(/(?:^|\s)([^\s'";|&]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md))(?:\s|$)/gu) ?? []
    return stringList(candidates.map((entry) => entry.trim())
        .filter((entry) => {
            try {
                return pathAllowed(normalizeRelative(entry,
                    'evidence-pack-command-path-invalid'), allowedPatterns)
            } catch {
                return false
            }
        }))
}

function commandEvidence(commands, patterns) {
    return commands.map((command) => canonical({
        command,
        digest: digest(command),
        declaredPaths: commandPaths(command, patterns)
    }))
}

function testOwnership(commands, readTargets, writeAllowlist) {
    const patterns = [...readTargets, ...writeAllowlist]
    const result = []
    for (const entry of commands) {
        for (const candidate of entry.declaredPaths) {
            if (!/(^|\/)(tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/u
                .test(candidate)) continue
            const stem = path.basename(candidate)
                .replace(/\.(?:test|spec)\.[^.]+$/u, '')
            const nearby = stringList(patterns.filter((item) =>
                !item.includes('*') && item !== candidate &&
                path.basename(item).startsWith(stem)))
            result.push(canonical({
                testPath: candidate,
                commandDigest: entry.digest,
                nearbyPaths: nearby
            }))
        }
    }
    return result.sort((left, right) =>
        left.testPath.localeCompare(right.testPath) ||
        left.commandDigest.localeCompare(right.commandDigest))
}

function runGit(root, args, { allowFailure = false } = {}) {
    try {
        return execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10000
        }).trimEnd()
    } catch (error) {
        if (allowFailure) return null
        fail('evidence-pack-git-observation-failed', {
            args,
            status: error.status ?? null
        })
    }
}

function gitEvidence(root, identities, scopePaths, candidateSha = null) {
    const inside = runGit(root, ['rev-parse', '--is-inside-work-tree'], {
        allowFailure: true
    })
    if (inside !== 'true') {
        return canonical({
            status: 'not-a-git-worktree',
            observedHead: null,
            baseReachable: false,
            candidateSha: candidateSha ?? null,
            candidateReachable: false,
            pathStatus: [],
            diffStat: [],
            observationDigest: digest({ status: 'not-a-git-worktree' })
        })
    }
    const observedHead = runGit(root, ['rev-parse', 'HEAD'])
    const reachable = (sha) => SHA.test(sha ?? '') &&
        runGit(root, ['cat-file', '-e', `${sha}^{commit}`], {
            allowFailure: true
        }) === ''
    const exactPaths = stringList(scopePaths.filter((item) =>
        !item.includes('*') && !item.includes('?')))
    const separator = ['--', ...exactPaths]
    const status = exactPaths.length > 0 ? runGit(root, [
        'status', '--porcelain=v1', '--untracked-files=all', ...separator
    ]) : ''
    const diff = exactPaths.length > 0 && reachable(identities.baseSha)
        ? runGit(root, [
            'diff', '--stat', '--no-ext-diff', '--no-renames',
            identities.baseSha, ...separator
        ])
        : ''
    const value = {
        status: 'observed',
        observedHead,
        baseReachable: reachable(identities.baseSha),
        candidateSha: candidateSha ?? null,
        candidateReachable: candidateSha ? reachable(candidateSha) : false,
        pathStatus: status ? status.split('\n') : [],
        diffStat: diff ? diff.split('\n') : []
    }
    value.observationDigest = digest(value)
    return canonical(value)
}

function readDeclaredFiles(root, readTargets, role, phase, nodeId) {
    const references = []
    const sourceBlocks = []
    for (const relative of readTargets) {
        const resolved = resolvePath(root, relative)
        if (!resolved || !fs.existsSync(resolved.absolute) ||
            !fs.statSync(resolved.absolute).isFile()) continue
        const content = fs.readFileSync(resolved.absolute, 'utf8')
        if (bytes(content) > FILE_LIMIT || containsSecret(content)) {
            fail('evidence-pack-file-size-or-secret-invalid', {
                path: resolved.normalized
            })
        }
        const contentDigest = digest(content)
        const sourceId = `evidence-file-${contentDigest.slice(0, 16)}`
        references.push(canonical({
            sourceId,
            kind: 'repository-evidence-file',
            path: resolved.normalized,
            digest: contentDigest,
            bytes: bytes(content)
        }))
        sourceBlocks.push(sourceBlock({
            sourceId,
            kind: 'repository-evidence-file',
            relative: resolved.normalized,
            content,
            role,
            phase,
            nodeId
        }))
    }
    return { references, sourceBlocks }
}

function compileSearches({ root, searches, patterns, role, phase, nodeId }) {
    if (!Array.isArray(searches)) fail('evidence-pack-searches-invalid')
    if (searches.length > MAX_SEARCHES) fail('evidence-pack-search-count-exceeded')
    const documents = []
    const sourceBlocks = []
    for (const request of searches) {
        exactKeys(request, new Set(['path', 'query', 'maxMatches']),
            'evidence-pack-search-fields-invalid')
        const relative = normalizeRelative(request.path,
            'evidence-pack-search-path-invalid')
        if (!pathAllowed(relative, patterns)) {
            fail('evidence-pack-search-path-forbidden', { path: relative })
        }
        const query = text(request.query, 'evidence-pack-search-query-required')
        if (query.length > 128 || containsSecret(query)) {
            fail('evidence-pack-search-query-invalid')
        }
        const maxMatches = request.maxMatches ?? MAX_MATCHES
        if (!Number.isInteger(maxMatches) || maxMatches < 1 ||
            maxMatches > MAX_MATCHES) {
            fail('evidence-pack-search-limit-invalid')
        }
        const resolved = resolvePath(root, relative)
        if (!resolved || !fs.existsSync(resolved.absolute) ||
            !fs.statSync(resolved.absolute).isFile()) {
            fail('evidence-pack-search-path-missing', { path: relative })
        }
        const content = fs.readFileSync(resolved.absolute, 'utf8')
        if (bytes(content) > FILE_LIMIT || containsSecret(content)) {
            fail('evidence-pack-file-size-or-secret-invalid', { path: relative })
        }
        const matches = []
        content.split(/\r?\n/u).forEach((line, index) => {
            if (line.includes(query)) matches.push({ line: index + 1, text: line })
        })
        if (matches.length > maxMatches) {
            fail('evidence-pack-search-limit-exceeded', {
                path: relative,
                query,
                matches: matches.length,
                maxMatches
            })
        }
        const output = `${JSON.stringify(canonical({
            path: relative,
            query,
            matches
        }), null, 2)}\n`
        if (bytes(output) > SEARCH_OUTPUT_LIMIT) {
            fail('evidence-pack-search-output-limit-exceeded')
        }
        const outputDigest = digest(output)
        const sourceId = `evidence-search-${outputDigest.slice(0, 16)}`
        documents.push(canonical({
            query,
            path: relative,
            matchCount: matches.length,
            sourceId,
            digest: outputDigest
        }))
        sourceBlocks.push(sourceBlock({
            sourceId,
            kind: 'repository-evidence-search',
            relative,
            content: output,
            role,
            phase,
            nodeId
        }))
    }
    return {
        documents: documents.sort((left, right) =>
            left.path.localeCompare(right.path) ||
            left.query.localeCompare(right.query)),
        sourceBlocks
    }
}

function compileFailure({ request, stageContext, commands, role, phase, nodeId }) {
    if (request === undefined || request === null) {
        return { document: null, sourceBlocks: [] }
    }
    exactKeys(request, new Set(['command', 'failureDigest', 'output']),
        'evidence-pack-failure-fields-invalid')
    const command = text(request.command, 'evidence-pack-failure-command-required')
    const failureDigest = text(request.failureDigest,
        'evidence-pack-failure-digest-required')
    if (!HASH.test(failureDigest) ||
        failureDigest !== stageContext.recovery?.firstFailure?.digest ||
        !commands.some((entry) => entry.command === command)) {
        fail('evidence-pack-failure-binding-mismatch')
    }
    const output = text(request.output, 'evidence-pack-failure-output-required')
    if (bytes(output) > FAILURE_LIMIT || containsSecret(output)) {
        fail('evidence-pack-failure-output-invalid')
    }
    const outputDigest = digest(output)
    const sourceId = `evidence-failure-${outputDigest.slice(0, 16)}`
    return {
        document: canonical({
            command,
            failureDigest,
            sourceId,
            digest: outputDigest,
            bytes: bytes(output)
        }),
        sourceBlocks: [sourceBlock({
            sourceId,
            kind: 'repository-evidence-failure',
            relative: `failure://${failureDigest}`,
            content: output,
            role,
            phase,
            nodeId
        })]
    }
}

function validateReferences(pack, sourceBlocks = []) {
    const sources = new Map(sourceBlocks.map((entry) => [entry.sourceId, entry]))
    for (const reference of pack.sourceReferences) {
        const source = sources.get(reference.sourceId)
        if (!source || source.path !== reference.path ||
            source.kind !== reference.kind ||
            digest(source.text) !== reference.digest ||
            bytes(source.text) !== reference.bytes) {
            fail('evidence-pack-source-reference-mismatch', {
                sourceId: reference.sourceId
            })
        }
    }
    for (const search of pack.searches) {
        const source = sources.get(search.sourceId)
        if (!source || digest(source.text) !== search.digest) {
            fail('evidence-pack-search-reference-mismatch')
        }
    }
    if (pack.failureEvidence) {
        const source = sources.get(pack.failureEvidence.sourceId)
        if (!source || digest(source.text) !== pack.failureEvidence.digest) {
            fail('evidence-pack-failure-reference-mismatch')
        }
    }
}

export function compileRepositoryEvidencePack({
    repositoryPath,
    role,
    phase,
    nodeId,
    identities,
    stageContext,
    instructions,
    request = {}
} = {}) {
    text(role, 'evidence-pack-role-required')
    text(phase, 'evidence-pack-phase-required')
    text(nodeId, 'evidence-pack-node-required')
    object(identities, 'evidence-pack-identities-required')
    object(stageContext, 'evidence-pack-stage-context-required')
    object(instructions, 'evidence-pack-instructions-required')
    exactKeys(request, new Set(['searches', 'failureOutput', 'candidateSha']),
        'evidence-pack-request-fields-invalid')
    if (request.candidateSha !== undefined && request.candidateSha !== null &&
        !SHA.test(request.candidateSha)) {
        fail('evidence-pack-candidate-sha-invalid')
    }
    if (stageContext.kind !== 'writer') {
        fail('evidence-pack-writer-stage-required')
    }
    const root = safeRoot(repositoryPath)
    const readTargets = stringList(stageContext.readTargets)
    const writeAllowlist = stringList(stageContext.writeAllowlist)
    const patterns = stringList([...readTargets, ...writeAllowlist])
    if (patterns.length === 0) fail('evidence-pack-scope-required')
    const scopeMap = [
        ...readTargets.map((relative) => fileObservation(root, relative, 'read')),
        ...writeAllowlist.map((relative) => fileObservation(root, relative, 'write'))
    ]
    const uniqueScope = new Map(scopeMap.map((entry) => [
        `${entry.path}:${entry.access}`,
        entry
    ]))
    const commands = commandEvidence(
        stringList(stageContext.requiredCommands),
        patterns
    )
    const instructionEntries = (instructions.entries ?? []).map((entry) =>
        canonical({
            path: entry.path,
            digest: entry.digest,
            appliesToPaths: stringList(entry.appliesToPaths)
        }))
    const files = readDeclaredFiles(root, readTargets, role, phase, nodeId)
    const searches = compileSearches({
        root,
        searches: request.searches ?? [],
        patterns,
        role,
        phase,
        nodeId
    })
    const failure = compileFailure({
        request: request.failureOutput,
        stageContext,
        commands,
        role,
        phase,
        nodeId
    })
    const sourceBlocks = [
        ...files.sourceBlocks,
        ...searches.sourceBlocks,
        ...failure.sourceBlocks
    ]
    const sourceReferences = [
        ...files.references,
        ...searches.documents.map((entry) => canonical({
            sourceId: entry.sourceId,
            kind: 'repository-evidence-search',
            path: entry.path,
            digest: entry.digest,
            bytes: bytes(sourceBlocks.find((source) =>
                source.sourceId === entry.sourceId).text)
        })),
        ...(failure.document ? [canonical({
            sourceId: failure.document.sourceId,
            kind: 'repository-evidence-failure',
            path: `failure://${failure.document.failureDigest}`,
            digest: failure.document.digest,
            bytes: failure.document.bytes
        })] : [])
    ].sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    const requestIdentity = canonical({
        searches: request.searches ?? [],
        failure: request.failureOutput ? {
            command: request.failureOutput.command,
            failureDigest: request.failureOutput.failureDigest,
            outputDigest: digest(request.failureOutput.output)
        } : null,
        candidateSha: request.candidateSha ?? null
    })
    const inputIdentity = canonical({
        repository: identities.repository,
        baseSha: identities.baseSha,
        actionDigest: identities.actionDigest,
        sliceDigest: digest(stageContext.executableSlice),
        instructionSetDigest: digest(instructionEntries),
        requestDigest: digest(requestIdentity)
    })
    const core = canonical({
        schema: SCHEMA,
        status: 'compiled',
        authority: { kind: 'actor-input-only', grants: [] },
        role,
        phase,
        nodeId,
        inputIdentity,
        scopeMap: [...uniqueScope.values()].sort((left, right) =>
            left.path.localeCompare(right.path) ||
            left.access.localeCompare(right.access)),
        instructions: instructionEntries.sort((left, right) =>
            left.path.localeCompare(right.path)),
        commands,
        testOwnership: testOwnership(commands, readTargets, writeAllowlist),
        gitEvidence: gitEvidence(
            root,
            identities,
            patterns,
            request.candidateSha ?? null
        ),
        sourceReferences,
        searches: searches.documents,
        failureEvidence: failure.document
    })
    const packBytes = bytes(JSON.stringify(core))
    const result = {
        ...core,
        measurement: canonical({
            packBytes,
            sourceBytes: sourceReferences.reduce((sum, entry) =>
                sum + entry.bytes, 0),
            filesObserved: core.scopeMap.length,
            searchesExecuted: core.searches.length,
            commandsBound: core.commands.length
        })
    }
    result.packDigest = digest(result)
    const pack = validateRepositoryEvidencePack(result)
    validateReferences(pack, sourceBlocks)
    return Object.freeze({
        pack,
        sourceBlocks: Object.freeze(sourceBlocks)
    })
}

function validateClosedShape(pack) {
    exactKeys(pack, TOP_LEVEL_KEYS, 'evidence-pack-top-level-fields-invalid')
    for (const field of [
        'scopeMap', 'instructions', 'commands', 'testOwnership',
        'sourceReferences', 'searches'
    ]) {
        if (!Array.isArray(pack[field])) fail('evidence-pack-array-required', {
            field
        })
    }
    exactKeys(pack.authority, new Set(['kind', 'grants']),
        'evidence-pack-authority-fields-invalid')
    exactKeys(pack.inputIdentity, INPUT_IDENTITY_KEYS,
        'evidence-pack-input-identity-fields-invalid')
    for (const entry of pack.scopeMap) exactKeys(entry, SCOPE_KEYS,
        'evidence-pack-scope-fields-invalid')
    for (const entry of pack.instructions) exactKeys(entry, INSTRUCTION_KEYS,
        'evidence-pack-instruction-fields-invalid')
    for (const entry of pack.commands) exactKeys(entry, COMMAND_KEYS,
        'evidence-pack-command-fields-invalid')
    for (const entry of pack.testOwnership) exactKeys(entry, OWNERSHIP_KEYS,
        'evidence-pack-test-ownership-fields-invalid')
    exactKeys(pack.gitEvidence, GIT_KEYS, 'evidence-pack-git-fields-invalid')
    for (const entry of pack.sourceReferences) exactKeys(entry, REFERENCE_KEYS,
        'evidence-pack-reference-fields-invalid')
    for (const entry of pack.searches) exactKeys(entry, SEARCH_KEYS,
        'evidence-pack-search-document-fields-invalid')
    if (pack.failureEvidence) exactKeys(pack.failureEvidence, FAILURE_KEYS,
        'evidence-pack-failure-document-fields-invalid')
    exactKeys(pack.measurement, MEASUREMENT_KEYS,
        'evidence-pack-measurement-fields-invalid')
}

export function validateRepositoryEvidencePack(pack, {
    role,
    phase,
    nodeId,
    identities,
    sourceBlocks
} = {}) {
    object(pack, 'evidence-pack-required')
    validateClosedShape(pack)
    if (pack.schema !== SCHEMA || pack.status !== 'compiled' ||
        pack.authority?.kind !== 'actor-input-only' ||
        !Array.isArray(pack.authority?.grants) ||
        pack.authority.grants.length !== 0 ||
        !HASH.test(pack.packDigest ?? '') ||
        !HASH.test(pack.inputIdentity?.actionDigest ?? '') ||
        !SHA.test(pack.inputIdentity?.baseSha ?? '') ||
        !Array.isArray(pack.scopeMap) ||
        !Array.isArray(pack.sourceReferences) ||
        !Array.isArray(pack.searches)) {
        fail('evidence-pack-invalid')
    }
    const unsigned = structuredClone(pack)
    delete unsigned.packDigest
    if (digest(unsigned) !== pack.packDigest) {
        fail('evidence-pack-digest-mismatch')
    }
    if ((role !== undefined && pack.role !== role) ||
        (phase !== undefined && pack.phase !== phase) ||
        (nodeId !== undefined && pack.nodeId !== nodeId) ||
        (identities && (
            pack.inputIdentity.repository !== identities.repository ||
            pack.inputIdentity.baseSha !== identities.baseSha ||
            pack.inputIdentity.actionDigest !== identities.actionDigest
        ))) {
        fail('evidence-pack-binding-mismatch')
    }
    if (sourceBlocks) validateReferences(pack, sourceBlocks)
    return Object.freeze(structuredClone(pack))
}

export function repositoryEvidencePackSourceIds(pack) {
    const value = validateRepositoryEvidencePack(pack)
    return Object.freeze(value.sourceReferences.map(({ sourceId }) => sourceId))
}

export const repositoryEvidencePackLimits = Object.freeze({
    fileBytes: FILE_LIMIT,
    failureBytes: FAILURE_LIMIT,
    searchOutputBytes: SEARCH_OUTPUT_LIMIT,
    searches: MAX_SEARCHES,
    matches: MAX_MATCHES
})
