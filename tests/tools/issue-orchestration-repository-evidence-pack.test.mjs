import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    compileRepositoryEvidencePack,
    repositoryEvidencePackLimits,
    validateRepositoryEvidencePack
} from '../../skills/issue-orchestration/scripts/repository-evidence-pack.mjs'
import {
    digest
} from '../../skills/issue-orchestration/scripts/runtime-contract-lib.mjs'

function git(root, args) {
    return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
}

function repository(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pack-'))
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(root, 'AGENTS.md'),
        'Modify only declared paths and run the declared test.\n')
    fs.writeFileSync(path.join(root, 'src', 'current.mjs'),
        `export const targetSymbol = 1\n${'export const filler = 0\n'.repeat(120)}`)
    fs.writeFileSync(path.join(root, 'tests', 'current.test.mjs'),
        "import { targetSymbol } from '../src/current.mjs'\n" +
        "if (targetSymbol !== 1) throw new Error('red')\n")
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'fixture@example.test'])
    git(root, ['config', 'user.name', 'Fixture'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return { root, baseSha: git(root, ['rev-parse', 'HEAD']) }
}

function input(t, overrides = {}) {
    const repo = repository(t)
    const failureDigest = digest('failure-75')
    const identities = {
        repository: 'Fixture/Repo',
        baseSha: repo.baseSha,
        actionDigest: digest('action-75')
    }
    const stageContext = {
        kind: 'writer',
        executableSlice: {
            sliceId: 'slice-75',
            allowedPaths: ['src/current.mjs', 'tests/current.test.mjs'],
            requiredFiles: ['src/current.mjs', 'tests/current.test.mjs'],
            requiredCommands: ['node --test tests/current.test.mjs']
        },
        readTargets: ['src/current.mjs', 'tests/current.test.mjs'],
        writeAllowlist: ['src/current.mjs', 'tests/current.test.mjs'],
        requiredCommands: ['node --test tests/current.test.mjs'],
        recovery: {
            firstFailure: {
                category: 'required-command-red',
                identity: 'failure-75',
                digest: failureDigest
            },
            checkpointCursor: 'rerun-focused-test',
            continuationDigest: digest('continuation-75')
        }
    }
    const instructions = {
        status: 'resolved',
        entries: [{
            path: 'AGENTS.md',
            digest: digest(fs.readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8')),
            text: fs.readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8'),
            appliesToPaths: ['src/current.mjs', 'tests/current.test.mjs']
        }]
    }
    return {
        repositoryPath: repo.root,
        role: 'code-implementer',
        phase: 'implementation',
        nodeId: 'Fixture/Repo#75',
        identities,
        stageContext,
        instructions,
        request: {
            searches: [{
                path: 'src/current.mjs',
                query: 'targetSymbol',
                maxMatches: 4
            }],
            failureOutput: {
                command: 'node --test tests/current.test.mjs',
                failureDigest,
                output: 'AssertionError: targetSymbol expected 2 but received 1\n'
            },
            candidateSha: repo.baseSha
        },
        ...overrides,
        repo
    }
}

function compile(t, overrides = {}) {
    const value = input(t, overrides)
    const { repo, ...options } = value
    return { repo, options, ...compileRepositoryEvidencePack(options) }
}

test('fixed writer scope produces a byte-identical deterministic evidence pack', (t) => {
    const first = compile(t)
    const second = compileRepositoryEvidencePack(first.options)
    assert.deepEqual(second.pack, first.pack)
    assert.deepEqual(second.sourceBlocks, first.sourceBlocks)
    assert.equal(first.pack.schema,
        'issue-orchestration.repository-evidence-pack.v1')
    assert.deepEqual(first.pack.authority, {
        kind: 'actor-input-only',
        grants: []
    })
    assert.equal(first.pack.gitEvidence.status, 'observed')
    assert.equal(first.pack.gitEvidence.baseReachable, true)
    assert.equal(first.pack.gitEvidence.candidateReachable, true)
    assert.equal(first.pack.searches[0].matchCount, 1)
    assert.equal(first.pack.commands.length, 1)
    assert.equal(first.pack.testOwnership[0].testPath,
        'tests/current.test.mjs')
    assert.equal(validateRepositoryEvidencePack(first.pack).packDigest,
        first.pack.packDigest)
})

test('the pack contains only slice-authorized paths and content-addressed sources', (t) => {
    const { pack, sourceBlocks } = compile(t)
    const paths = new Set(pack.scopeMap.map((entry) => entry.path))
    assert.deepEqual([...paths].sort(), [
        'src/current.mjs',
        'tests/current.test.mjs'
    ])
    assert.ok(pack.sourceReferences.length >= 4)
    for (const reference of pack.sourceReferences) {
        const source = sourceBlocks.find((entry) =>
            entry.sourceId === reference.sourceId)
        assert.ok(source)
        assert.equal(digest(source.text), reference.digest)
        assert.equal(Buffer.byteLength(source.text, 'utf8'), reference.bytes)
        assert.ok(paths.has(reference.path) ||
            reference.path.startsWith('failure://'))
    }
    const serialized = JSON.stringify(pack)
    for (const forbidden of [
        'routeDecision', 'acceptanceDecision', 'checkpointReceipt',
        'mutationAuthority', 'deliveryAuthority', 'completeRepositoryDump'
    ]) assert.equal(serialized.includes(forbidden), false, forbidden)
})

test('source, base, candidate, instruction and request drift change exact identities', (t) => {
    const value = input(t)
    const { repo, ...options } = value
    const before = compileRepositoryEvidencePack(options).pack
    fs.appendFileSync(path.join(repo.root, 'src', 'current.mjs'),
        'export const changed = true\n')
    const sourceChanged = compileRepositoryEvidencePack(options).pack
    assert.notEqual(sourceChanged.packDigest, before.packDigest)
    assert.notEqual(
        sourceChanged.sourceReferences.find((entry) =>
            entry.path === 'src/current.mjs').digest,
        before.sourceReferences.find((entry) =>
            entry.path === 'src/current.mjs').digest
    )

    const instructionChanged = compileRepositoryEvidencePack({
        ...options,
        instructions: {
            status: 'resolved',
            entries: [{
                ...options.instructions.entries[0],
                digest: digest('changed instruction'),
                text: 'changed instruction'
            }]
        }
    }).pack
    assert.notEqual(instructionChanged.inputIdentity.instructionSetDigest,
        before.inputIdentity.instructionSetDigest)

    const requestChanged = compileRepositoryEvidencePack({
        ...options,
        request: {
            ...options.request,
            searches: [{
                path: 'src/current.mjs',
                query: 'changed',
                maxMatches: 4
            }]
        }
    }).pack
    assert.notEqual(requestChanged.inputIdentity.requestDigest,
        before.inputIdentity.requestDigest)

    const candidateChanged = compileRepositoryEvidencePack({
        ...options,
        request: {
            ...options.request,
            candidateSha: 'a'.repeat(40)
        }
    }).pack
    assert.notEqual(candidateChanged.inputIdentity.requestDigest,
        before.inputIdentity.requestDigest)

    const baseChanged = compileRepositoryEvidencePack({
        ...options,
        identities: {
            ...options.identities,
            baseSha: 'c'.repeat(40)
        }
    }).pack
    assert.equal(baseChanged.gitEvidence.baseReachable, false)
    assert.notEqual(baseChanged.inputIdentity.baseSha,
        before.inputIdentity.baseSha)
})

test('wrong paths, excess searches, search overflow and failure drift fail closed', (t) => {
    const value = input(t)
    const { repo, ...options } = value
    assert.throws(() => compileRepositoryEvidencePack({
        ...options,
        request: {
            ...options.request,
            searches: [{
                path: 'secrets.txt',
                query: 'x',
                maxMatches: 1
            }]
        }
    }), (error) => error?.code === 'evidence-pack-search-path-forbidden')

    assert.throws(() => compileRepositoryEvidencePack({
        ...options,
        request: {
            ...options.request,
            searches: Array.from({
                length: repositoryEvidencePackLimits.searches + 1
            }, () => ({
                path: 'src/current.mjs',
                query: 'targetSymbol',
                maxMatches: 1
            }))
        }
    }), (error) => error?.code === 'evidence-pack-search-count-exceeded')

    fs.writeFileSync(path.join(repo.root, 'src', 'current.mjs'),
        'targetSymbol\n'.repeat(40))
    assert.throws(() => compileRepositoryEvidencePack({
        ...options,
        request: {
            ...options.request,
            searches: [{
                path: 'src/current.mjs',
                query: 'targetSymbol',
                maxMatches: 2
            }]
        }
    }), (error) => error?.code === 'evidence-pack-search-limit-exceeded')

    assert.throws(() => compileRepositoryEvidencePack({
        ...options,
        request: {
            ...options.request,
            searches: [],
            failureOutput: {
                ...options.request.failureOutput,
                failureDigest: digest('wrong failure')
            }
        }
    }), (error) => error?.code === 'evidence-pack-failure-binding-mismatch')
})

test('explicit source limits fail instead of silently truncating evidence', (t) => {
    const value = input(t)
    const { repo, ...options } = value
    fs.writeFileSync(path.join(repo.root, 'src', 'current.mjs'),
        'x'.repeat(repositoryEvidencePackLimits.fileBytes + 1))
    assert.throws(() => compileRepositoryEvidencePack(options),
        (error) => error?.code ===
            'evidence-pack-file-size-or-secret-invalid')
})

test('self-signed unknown fields and copied digests do not create authority', (t) => {
    const { pack } = compile(t)
    const changed = structuredClone(pack)
    changed.routeDecision = { profile: 'sol-max' }
    delete changed.packDigest
    changed.packDigest = digest(changed)
    assert.throws(() => validateRepositoryEvidencePack(changed),
        (error) => error?.code === 'evidence-pack-top-level-fields-invalid')

    assert.throws(() => validateRepositoryEvidencePack(pack, {
        role: 'documentation-writer',
        phase: pack.phase,
        nodeId: pack.nodeId,
        identities: {
            repository: pack.inputIdentity.repository,
            baseSha: pack.inputIdentity.baseSha,
            actionDigest: pack.inputIdentity.actionDigest
        }
    }), (error) => error?.code === 'evidence-pack-binding-mismatch')
})
