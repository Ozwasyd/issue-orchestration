#!/usr/bin/env node
// Shared issue-orchestration package runtime.

import { execFileSync } from 'node:child_process'
import {
    lstatSync,
    readFileSync,
    realpathSync,
    statSync
} from 'node:fs'
import {
    basename,
    dirname,
    isAbsolute,
    parse,
    relative,
    resolve,
    sep
} from 'node:path'
import { fileURLToPath } from 'node:url'

export class StateRootValidationError extends Error {
    constructor(code, message, details = {}) {
        super(message)
        this.name = 'StateRootValidationError'
        this.code = code
        this.details = details
    }
}

function fail(code, message, details = {}) {
    throw new StateRootValidationError(code, message, details)
}

function tryLstat(target) {
    try {
        return lstatSync(target)
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
        throw error
    }
}

export function isWithinOrEqual(candidate, boundary) {
    const offset = relative(boundary, candidate)
    return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
}

function pathsOverlap(left, right) {
    return isWithinOrEqual(left, right) || isWithinOrEqual(right, left)
}

function decodeMountPath(value) {
    return value.replace(/\\([0-7]{3})/gu, (_, digits) => String.fromCharCode(Number.parseInt(digits, 8)))
}

function readMountTable() {
    if (process.platform !== 'linux') {
        fail('mount-proof-unavailable', 'State-root validation requires Linux mount identity evidence.')
    }

    let source
    try {
        source = readFileSync('/proc/self/mountinfo', 'utf8')
    } catch (error) {
        fail('mount-proof-unavailable', 'Unable to read /proc/self/mountinfo.', {
            error: error.message
        })
    }

    return source
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const separatorIndex = line.indexOf(' - ')
            if (separatorIndex < 0) {
                fail('invalid-mountinfo', 'Encountered an invalid mountinfo record.')
            }
            const fields = line.slice(0, separatorIndex).split(' ')
            const filesystemFields = line.slice(separatorIndex + 3).split(' ')
            return {
                device: fields[2],
                root: decodeMountPath(fields[3]),
                mountPoint: decodeMountPath(fields[4]),
                filesystemType: filesystemFields[0],
                source: decodeMountPath(filesystemFields[1])
            }
        })
        .sort((left, right) => right.mountPoint.length - left.mountPoint.length)
}

function filesystemCoordinate(target, mountTable) {
    const mount = mountTable.find((entry) => isWithinOrEqual(target, entry.mountPoint))
    if (!mount) {
        fail('mount-proof-unavailable', `No mount identity covers ${target}.`, { target })
    }

    const offset = relative(mount.mountPoint, target).split(sep).join('/')
    const coordinate = resolve('/', mount.root, offset).split(sep).join('/')
    return {
        device: mount.device,
        coordinate,
        filesystemType: mount.filesystemType,
        source: mount.source
    }
}

function coordinatesOverlap(left, right) {
    if (left.device !== right.device) return false
    return pathsOverlap(left.coordinate, right.coordinate)
}

function statIdentity(target) {
    const stat = statSync(target)
    return `${stat.dev}:${stat.ino}`
}

function ancestorIdentities(target) {
    const identities = new Set()
    let cursor = target
    while (true) {
        identities.add(statIdentity(cursor))
        const parent = dirname(cursor)
        if (parent === cursor) return identities
        cursor = parent
    }
}

function findNearestExisting(absolutePath) {
    const suffix = []
    let cursor = absolutePath

    while (!tryLstat(cursor)) {
        const parent = dirname(cursor)
        if (parent === cursor) {
            fail('no-existing-ancestor', `No existing ancestor could be resolved for ${absolutePath}.`)
        }
        suffix.unshift(basename(cursor))
        cursor = parent
    }

    let canonicalAncestor
    try {
        canonicalAncestor = realpathSync.native(cursor)
    } catch (error) {
        fail('unresolvable-ancestor', `The nearest existing ancestor is not safely resolvable: ${cursor}.`, {
            error: error.message
        })
    }

    return {
        existing: cursor,
        canonicalExisting: canonicalAncestor,
        canonicalProjected: resolve(canonicalAncestor, ...suffix),
        exists: suffix.length === 0
    }
}

function resolveCandidatePath(input, cwd) {
    const raw = String(input)
    const absoluteInput = isAbsolute(raw)
    let cursor
    try {
        cursor = absoluteInput
            ? parse(raw).root
            : realpathSync.native(resolve(cwd))
    } catch (error) {
        fail('cwd-unresolvable', `The candidate working directory cannot be resolved: ${cwd}.`, {
            cwd,
            error: error.message
        })
    }

    const components = raw
        .slice(absoluteInput ? parse(raw).root.length : 0)
        .split(sep)
    const links = []

    for (const component of components) {
        if (!component || component === '.') continue
        if (component === '..') {
            cursor = dirname(cursor)
            continue
        }
        cursor = resolve(cursor, component)
        const stat = tryLstat(cursor)
        if (stat?.isSymbolicLink()) links.push(cursor)
    }

    return {
        absolute: cursor,
        links
    }
}

function canonicalProtectedRoot(kind, input, mountTable) {
    const absolute = resolve(input)
    let canonical
    try {
        canonical = realpathSync.native(absolute)
    } catch (error) {
        fail('protected-root-unreadable', `Protected ${kind} path cannot be resolved: ${absolute}.`, {
            kind,
            input,
            error: error.message
        })
    }

    const stat = statSync(canonical)
    if (!stat.isDirectory()) {
        fail('protected-root-not-directory', `Protected ${kind} path is not a directory: ${canonical}.`, {
            kind,
            input
        })
    }

    return {
        kind,
        input,
        canonical,
        identity: statIdentity(canonical),
        filesystem: filesystemCoordinate(canonical, mountTable)
    }
}

function discoverWorktrees(repository) {
    let output
    try {
        output = execFileSync(
            'git',
            ['-C', repository, 'worktree', 'list', '--porcelain'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
    } catch (error) {
        fail('worktree-discovery-failed', `Unable to enumerate worktrees for ${repository}.`, {
            repository,
            stderr: error.stderr?.toString().trim() ?? ''
        })
    }

    return output
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
}

export function validateStateRoot({
    candidate,
    repositories,
    workspaces,
    worktrees = [],
    cwd = process.cwd()
}) {
    if (!candidate) fail('missing-candidate', 'A state-root candidate is required.')
    if (!Array.isArray(repositories) || repositories.length < 2) {
        fail('missing-repositories', 'Both FsusBlog and FsusUI repository paths are required.')
    }
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
        fail('missing-workspace', 'At least one launch or common workspace path is required.')
    }

    const resolvedCandidate = resolveCandidatePath(candidate, cwd)
    if (resolvedCandidate.links.length > 0) {
        fail('symlink-component', `State-root candidate contains a symbolic-link component: ${resolvedCandidate.links[0]}.`, {
            candidate: resolvedCandidate.absolute,
            symlinks: resolvedCandidate.links
        })
    }
    const candidateAbsolute = resolvedCandidate.absolute

    const mountTable = readMountTable()
    const projected = findNearestExisting(candidateAbsolute)
    if (projected.exists) {
        const stat = statSync(projected.canonicalProjected)
        if (!stat.isDirectory()) {
            fail('candidate-not-directory', `State-root candidate is not a directory: ${candidateAbsolute}.`)
        }
    }

    const discoveredWorktrees = repositories.flatMap(discoverWorktrees)
    const rawProtected = [
        ...repositories.map((path) => ({ kind: 'repository', path })),
        ...workspaces.map((path) => ({ kind: 'workspace', path })),
        ...discoveredWorktrees.map((path) => ({ kind: 'worktree', path })),
        ...worktrees.map((path) => ({ kind: 'worktree', path }))
    ]

    const protectedRoots = []
    const protectedKeys = new Set()
    for (const entry of rawProtected) {
        const root = canonicalProtectedRoot(entry.kind, entry.path, mountTable)
        const key = `${root.kind}:${root.canonical}`
        if (protectedKeys.has(key)) continue
        protectedKeys.add(key)
        protectedRoots.push(root)
    }

    const candidateFilesystem = filesystemCoordinate(projected.canonicalProjected, mountTable)
    if (
        candidateFilesystem.filesystemType === 'overlay'
        || candidateFilesystem.filesystemType.startsWith('fuse')
    ) {
        fail('mount-source-unverifiable', `State-root candidate uses an alias-capable mount whose backing path cannot be proven disjoint: ${candidateFilesystem.filesystemType}.`, {
            candidate: projected.canonicalProjected,
            candidateFilesystem
        })
    }
    const candidateAncestorIdentities = ancestorIdentities(projected.canonicalExisting)

    for (const boundary of protectedRoots) {
        if (pathsOverlap(projected.canonicalProjected, boundary.canonical)) {
            fail('path-overlap', `State-root candidate overlaps protected ${boundary.kind}: ${boundary.canonical}.`, {
                candidate: projected.canonicalProjected,
                protectedKind: boundary.kind,
                protectedPath: boundary.canonical
            })
        }

        if (coordinatesOverlap(candidateFilesystem, boundary.filesystem)) {
            fail('filesystem-overlap', `State-root candidate shares protected filesystem coordinates with ${boundary.kind}: ${boundary.canonical}.`, {
                candidate: projected.canonicalProjected,
                candidateFilesystem,
                protectedKind: boundary.kind,
                protectedPath: boundary.canonical,
                protectedFilesystem: boundary.filesystem
            })
        }

        if (candidateAncestorIdentities.has(boundary.identity)) {
            fail('identity-overlap', `State-root candidate resolves through protected ${boundary.kind}: ${boundary.canonical}.`, {
                candidate: projected.canonicalProjected,
                protectedKind: boundary.kind,
                protectedPath: boundary.canonical
            })
        }
    }

    return {
        schema: 'issue-orchestration.state-root-validation.v1',
        valid: true,
        candidate: {
            input: candidate,
            absolute: candidateAbsolute,
            canonical: projected.canonicalProjected,
            exists: projected.exists,
            filesystem: candidateFilesystem
        },
        protectedRoots: protectedRoots.map(({ kind, canonical, identity, filesystem }) => ({
            kind,
            canonical,
            identity,
            filesystem
        }))
    }
}

function valuesFor(argv, name) {
    const values = []
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== name) continue
        if (!argv[index + 1]) fail('missing-option-value', `Missing value for ${name}.`)
        values.push(argv[index + 1])
        index += 1
    }
    return values
}

function valueFor(argv, name) {
    return valuesFor(argv, name)[0] ?? null
}

function runCli() {
    try {
        const argv = process.argv.slice(2)
        const result = validateStateRoot({
            candidate: valueFor(argv, '--candidate'),
            repositories: valuesFor(argv, '--repository'),
            workspaces: valuesFor(argv, '--workspace'),
            worktrees: valuesFor(argv, '--worktree')
        })
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
        const payload = error instanceof StateRootValidationError
            ? {
                schema: 'issue-orchestration.state-root-validation.v1',
                valid: false,
                code: error.code,
                reason: error.message,
                details: error.details
            }
            : {
                schema: 'issue-orchestration.state-root-validation.v1',
                valid: false,
                code: 'unexpected-error',
                reason: error.message
            }
        process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
        process.exitCode = 2
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
