import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const OWNERSHIP_FILE = '.issue-orchestration-install.json'
export const INSTALL_SCHEMA =
    'issue-orchestration.shared-install-ownership.v1'
export const WRITER_STAGE_CONTRACT_FILES = Object.freeze([
    'contracts/compiled-dispatch-prompt.schema.json',
    'contracts/executable-slice.schema.json',
    'contracts/slice-terminal-receipt.schema.json',
    'contracts/stage-continuation-receipt.schema.json',
    'contracts/stage-progress-checkpoint.schema.json',
    'contracts/stage-work-plan.schema.json',
    'contracts/writer-stage-checkpoint-verification-receipt.schema.json',
    'contracts/writer-stage-failure-receipt.schema.json',
    'contracts/writer-stage-retry-authorization.schema.json'
])
export const WRITER_STAGE_RUNTIME_FILES = Object.freeze([
    'skills/issue-orchestration/scripts/executable-slice-compiler.mjs',
    'skills/issue-orchestration/scripts/writer-stage-progress.mjs'
])

export class SharedPackageError extends Error {
    constructor(code, message = code, details = {}) {
        super(message)
        this.name = 'SharedPackageError'
        this.code = code
        this.details = details
    }
}

export function fail(code, message = code, details = {}) {
    throw new SharedPackageError(code, message, details)
}

export function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

export function digest(value) {
    const input = Buffer.isBuffer(value)
        ? value
        : Buffer.from(JSON.stringify(canonical(value)))
    return createHash('sha256').update(input).digest('hex')
}

export function fileDigest(file) {
    return digest(fs.readFileSync(file))
}

export function unsignedDigest(value, field) {
    const unsigned = structuredClone(value)
    delete unsigned[field]
    return digest(unsigned)
}

export function walkFiles(directory) {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const child = path.join(directory, entry.name)
            if (entry.isSymbolicLink()) {
                fail('artifact-symlink-forbidden',
                    `Symbolic links are forbidden: ${child}.`)
            }
            return entry.isDirectory() ? walkFiles(child) : [child]
        })
}

export function packageRelativePath(sourceRoot, file) {
    const resolvedRoot = path.resolve(sourceRoot)
    const relative = path.relative(resolvedRoot, path.resolve(file))
    if (relative === ''
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        fail(
            'manifest-artifact-path-invalid',
            'Package artifacts must be files below the source root.',
            { sourceRoot: resolvedRoot, file: path.resolve(file) }
        )
    }
    return relative.split(path.sep).join('/')
}

export function collectArtifactDigests(sourceRoot) {
    const resolvedRoot = path.resolve(sourceRoot)
    const manifestPath = path.join(resolvedRoot, 'manifest.json')
    return Object.fromEntries(walkFiles(resolvedRoot)
        .filter((file) => path.resolve(file) !== manifestPath)
        .map((file) => [
            packageRelativePath(resolvedRoot, file),
            fileDigest(file)
        ])
        .sort(([left], [right]) => left.localeCompare(right)))
}

export function resolveSourceCommit(
    sourceRoot,
    explicitCommit = process.env.ISSUE_ORCHESTRATION_SOURCE_COMMIT
) {
    if (explicitCommit !== undefined && explicitCommit !== '') {
        const normalized = explicitCommit.trim().toLowerCase()
        if (!/^[a-f0-9]{40}$/u.test(normalized)) {
            fail(
                'manifest-source-commit-invalid',
                'The explicit source commit must be a 40-character Git object ID.'
            )
        }
        return normalized
    }
    const result = spawnSync(
        'git',
        ['-C', path.resolve(sourceRoot), 'rev-parse', '--verify', 'HEAD^{commit}'],
        { encoding: 'utf8' }
    )
    const sourceCommit = result.status === 0
        ? result.stdout.trim().toLowerCase()
        : ''
    if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
        fail(
            'manifest-source-commit-unavailable',
            'Unable to resolve the package source commit.',
            {
                sourceRoot: path.resolve(sourceRoot),
                gitStatus: result.status
            }
        )
    }
    return sourceCommit
}

export function parseArguments(argv) {
    const result = {
        protectedRoots: [],
        probeCwds: [],
        json: false
    }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--json') {
            result.json = true
            continue
        }
        const key = {
            '--source-root': 'sourceRoot',
            '--install-root': 'installRoot',
            '--protected-root': 'protectedRoots',
            '--probe-cwd': 'probeCwds',
            '--runtime-state-root': 'runtimeStateRoot',
            '--cwd': 'cwd'
        }[argument]
        if (!key || index + 1 >= argv.length) {
            fail('invalid-arguments', `Unknown or incomplete argument: ${argument}.`)
        }
        const value = path.resolve(argv[index += 1])
        if (Array.isArray(result[key])) result[key].push(value)
        else result[key] = value
    }
    return result
}

export function output(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function reportError(error) {
    const body = {
        schema: 'issue-orchestration.shared-package-error.v1',
        code: error?.code ?? 'shared-package-failed',
        message: error?.message ?? String(error)
    }
    if (error?.details && Object.keys(error.details).length > 0) {
        body.details = error.details
    }
    process.stderr.write(`${JSON.stringify(body)}\n`)
    process.exitCode = 1
}

function requireObject(value, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function requireDigest(value, code) {
    if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail(code)
}

function requireArtifactBindings(manifest, field, requiredFiles, code) {
    requireObject(manifest[field], code)
    const expected = Object.fromEntries(requiredFiles.map((relative) => [
        relative,
        manifest.artifactDigests[relative]
    ]))
    if (Object.values(expected).some((value) => value === undefined)
        || JSON.stringify(canonical(manifest[field]))
            !== JSON.stringify(canonical(expected))) {
        fail(code)
    }
}

function canonicalPath(candidate) {
    const absolute = path.resolve(candidate)
    const missing = []
    let cursor = absolute
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor)
        if (parent === cursor) fail('path-unresolvable')
        missing.unshift(path.basename(cursor))
        cursor = parent
    }
    const resolved = fs.realpathSync(cursor)
    return path.join(resolved, ...missing)
}

export function overlaps(left, right) {
    const relative = path.relative(left, right)
    const rightWithinLeft = relative === ''
        || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
            && !path.isAbsolute(relative))
    const reverse = path.relative(right, left)
    const leftWithinRight = reverse === ''
        || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..'
            && !path.isAbsolute(reverse))
    return rightWithinLeft || leftWithinRight
}

export function validateInstallBoundary({
    sourceRoot,
    installRoot,
    protectedRoots = []
}) {
    if (!sourceRoot || !installRoot) fail('install-path-required')
    const source = canonicalPath(sourceRoot)
    const target = canonicalPath(installRoot)
    if (target === path.parse(target).root) fail('install-target-unsafe')
    const protectedCandidates = [source, ...protectedRoots.map(canonicalPath)]
    for (const protectedRoot of protectedCandidates) {
        if (overlaps(target, protectedRoot)) {
            fail(
                'install-target-protected-overlap',
                `Install target overlaps protected root: ${protectedRoot}.`,
                { installRoot: target, protectedRoot }
            )
        }
    }
    return { sourceRoot: source, installRoot: target }
}

export function readManifest(sourceRoot) {
    const resolvedRoot = path.resolve(sourceRoot)
    const manifestPath = path.join(resolvedRoot, 'manifest.json')
    let manifest
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
        fail('manifest-unreadable', error.message)
    }
    requireObject(manifest, 'manifest-invalid')
    if (manifest.schema
        !== 'issue-orchestration.shared-package-manifest.v1') {
        fail('manifest-schema-invalid')
    }
    requireDigest(manifest.manifestDigest, 'manifest-digest-invalid')
    if (unsignedDigest(manifest, 'manifestDigest')
        !== manifest.manifestDigest) {
        fail('manifest-digest-mismatch')
    }
    requireObject(manifest.artifactDigests, 'manifest-artifacts-invalid')
    if (Object.hasOwn(manifest.artifactDigests, 'manifest.json')) {
        fail('manifest-self-artifact-forbidden')
    }
    const actualArtifacts = collectArtifactDigests(resolvedRoot)
    const actualPaths = Object.keys(actualArtifacts)
    const manifestPaths = Object.keys(manifest.artifactDigests).sort()
    const actualPathSet = new Set(actualPaths)
    const manifestPathSet = new Set(manifestPaths)
    const missingFromManifest = actualPaths.filter((relative) =>
        !manifestPathSet.has(relative))
    const missingFromSource = manifestPaths.filter((relative) =>
        !actualPathSet.has(relative))
    if (missingFromManifest.length > 0 || missingFromSource.length > 0) {
        fail(
            'manifest-artifact-set-drift',
            'The manifest artifact set does not exactly match the package.',
            { missingFromManifest, missingFromSource }
        )
    }
    for (const [relative, expected] of
        Object.entries(manifest.artifactDigests)) {
        requireDigest(expected, 'manifest-artifact-digest-invalid')
        if (actualArtifacts[relative] !== expected) {
            fail('manifest-artifact-drift', relative)
        }
    }
    if (digest(manifest.artifactDigests) !== manifest.sourceTreeDigest) {
        fail('manifest-source-tree-drift')
    }
    const expectedBindings = {
        skillDigest:
            manifest.artifactDigests['skills/issue-orchestration/SKILL.md'],
        modelPoolDigest:
            manifest.artifactDigests['policy/model-pool.json'],
        routingPolicyDigest:
            manifest.artifactDigests['policy/routing-policy.json'],
        stagePermissionDigest:
            manifest.artifactDigests['policy/stage-permissions.json'],
        remoteMutationPolicyDigest:
            manifest.artifactDigests['policy/remote-mutation-policy.json'],
        graphSchemaDigest:
            manifest.artifactDigests['graph/semantic-graph.schema.json'],
        patchSchemaDigest:
            manifest.artifactDigests['graph/graph-patch.schema.json'],
        runtimeProjectionSchemaDigest:
            manifest.artifactDigests['graph/runtime-projection.schema.json'],
        projectorDigest: manifest.artifactDigests[
            'skills/issue-orchestration/scripts/semantic-runtime-projection.mjs'
        ]
    }
    for (const [field, expected] of Object.entries(expectedBindings)) {
        if (!expected || manifest[field] !== expected) {
            fail('manifest-binding-drift', field)
        }
    }
    requireArtifactBindings(
        manifest,
        'writerStageContractDigests',
        WRITER_STAGE_CONTRACT_FILES,
        'manifest-writer-stage-contract-binding-drift'
    )
    requireArtifactBindings(
        manifest,
        'writerStageRuntimeDigests',
        WRITER_STAGE_RUNTIME_FILES,
        'manifest-writer-stage-runtime-binding-drift'
    )
    requireObject(manifest.agentDigests, 'manifest-agent-digests-invalid')
    for (const [agentId, expected] of Object.entries(manifest.agentDigests)) {
        if (manifest.artifactDigests[`agents/${agentId}.toml`] !== expected) {
            fail('manifest-agent-binding-drift', agentId)
        }
    }
    return manifest
}

function collectSourceMappings(sourceRoot, manifest) {
    const mappings = []
    for (const installTarget of manifest.installTargets ?? []) {
        requireObject(installTarget, 'manifest-install-target-invalid')
        if (typeof installTarget.source !== 'string'
            || typeof installTarget.target !== 'string') {
            fail('manifest-install-target-invalid')
        }
        const source = path.resolve(sourceRoot, installTarget.source)
        if (!source.startsWith(`${sourceRoot}${path.sep}`)
            || !fs.existsSync(source)) {
            fail('manifest-install-source-invalid')
        }
        const sourceStat = fs.statSync(source)
        if (sourceStat.isDirectory()) {
            for (const file of walkFiles(source)) {
                const sourceRelative = path.relative(sourceRoot, file)
                const targetRelative = path.join(
                    installTarget.target,
                    path.relative(source, file)
                )
                mappings.push({
                    sourceRelative,
                    targetRelative,
                    digest: manifest.artifactDigests[sourceRelative]
                })
            }
        } else {
            mappings.push({
                sourceRelative: path.relative(sourceRoot, source),
                targetRelative: installTarget.target,
                digest: sourceRelativeDigest(manifest, sourceRoot, source)
            })
        }
    }
    for (const mapping of mappings) {
        if (!mapping.digest
            || path.isAbsolute(mapping.targetRelative)
            || mapping.targetRelative.split(path.sep).includes('..')) {
            fail('manifest-install-target-invalid')
        }
    }
    const targets = mappings.map(({ targetRelative }) => targetRelative)
    if (new Set(targets).size !== targets.length) {
        fail('manifest-install-target-collision')
    }
    return mappings.sort((left, right) =>
        left.targetRelative.localeCompare(right.targetRelative))
}

function sourceRelativeDigest(manifest, sourceRoot, source) {
    const relative = path.relative(sourceRoot, source)
    if (relative === 'manifest.json') return fileDigest(source)
    return manifest.artifactDigests[relative]
}

function ownershipBody(manifest, mappings) {
    const body = {
        schema: INSTALL_SCHEMA,
        packageIdentity: manifest.packageIdentity,
        packageVersion: manifest.packageVersion,
        manifestDigest: manifest.manifestDigest,
        sourceTreeDigest: manifest.sourceTreeDigest,
        files: Object.fromEntries(mappings.map((mapping) =>
            [mapping.targetRelative, mapping.digest]))
    }
    body.installDigest = digest(body)
    return body
}

export function expectedInstall(sourceRoot, manifest = readManifest(sourceRoot)) {
    const mappings = collectSourceMappings(sourceRoot, manifest)
    return {
        manifest,
        mappings,
        ownership: ownershipBody(manifest, mappings)
    }
}

export function copyInstallTree({
    sourceRoot,
    stagingRoot,
    mappings,
    ownership
}) {
    for (const mapping of mappings) {
        const source = path.join(sourceRoot, mapping.sourceRelative)
        const target = path.join(stagingRoot, mapping.targetRelative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    }
    fs.writeFileSync(
        path.join(stagingRoot, OWNERSHIP_FILE),
        `${JSON.stringify(ownership, null, 2)}\n`,
        { flag: 'wx' }
    )
}

export function verifyInstalled({
    sourceRoot,
    installRoot,
    driftCode = 'installed-artifact-drift'
}) {
    const expected = expectedInstall(sourceRoot)
    const ownershipPath = path.join(installRoot, OWNERSHIP_FILE)
    if (!fs.existsSync(ownershipPath)) fail(driftCode)
    let actualOwnership
    try {
        actualOwnership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'))
    } catch {
        fail(driftCode)
    }
    if (JSON.stringify(canonical(actualOwnership))
        !== JSON.stringify(canonical(expected.ownership))) {
        fail(driftCode)
    }
    const expectedFiles = new Set([
        ...Object.keys(expected.ownership.files),
        OWNERSHIP_FILE
    ])
    let actualFiles
    try {
        actualFiles = walkFiles(installRoot).map((file) =>
            path.relative(installRoot, file))
    } catch {
        fail(driftCode)
    }
    if (actualFiles.length !== expectedFiles.size
        || actualFiles.some((relative) => !expectedFiles.has(relative))) {
        fail(driftCode)
    }
    for (const [relative, expectedDigest] of
        Object.entries(expected.ownership.files)) {
        const file = path.join(installRoot, relative)
        if (!fs.existsSync(file)
            || !fs.statSync(file).isFile()
            || fileDigest(file) !== expectedDigest) {
            fail(driftCode, relative)
        }
    }
    return expected
}

export function temporarySibling(installRoot) {
    return `${installRoot}.partial-${process.pid}-${randomBytes(8).toString('hex')}`
}

export function hasIncompleteTransaction(installRoot) {
    const parent = path.dirname(installRoot)
    const prefix = `${path.basename(installRoot)}.partial`
    if (fs.existsSync(parent)
        && fs.readdirSync(parent).some((name) => name.startsWith(prefix))) {
        return true
    }
    if (!fs.existsSync(installRoot)) return false
    try {
        return walkFiles(installRoot).some((file) =>
            /\.(?:tmp|partial)$/u.test(path.basename(file)))
    } catch {
        return true
    }
}

export function assertExternalRuntimeRoot({
    runtimeStateRoot,
    sourceRoot,
    installRoot
}) {
    if (!runtimeStateRoot) fail('runtime-state-root-required')
    const resolved = canonicalPath(runtimeStateRoot)
    if (overlaps(resolved, canonicalPath(sourceRoot))
        || overlaps(resolved, canonicalPath(installRoot))) {
        fail('runtime-state-root-artifact-overlap')
    }
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
}

export function assertNoRuntimeState(root) {
    const names = new Set([
        'dag.json',
        'event-ledger.jsonl',
        'ledger.jsonl',
        'projection.json',
        'receipts',
        'resource-registry.json',
        'runtime-projection.json',
        'semantic-graph.json',
        'state-root'
    ])
    for (const file of walkFiles(root)) {
        if (file.split(path.sep).some((part) => names.has(part))) {
            fail('runtime-state-leaked', file)
        }
    }
}
