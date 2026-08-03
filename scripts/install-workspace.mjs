#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
    canonical,
    expectedInstall,
    fail,
    fileDigest,
    output,
    parseArguments,
    reportError
} from './package-lib.mjs'

const OWNERSHIP_RELATIVE =
    '.agents/issue-orchestration-install.json'

function safeTarget(workspaceRoot, relative) {
    if (path.isAbsolute(relative)
        || relative.split(/[\\/]/u).includes('..')
        || (!relative.startsWith('.agents/')
            && !relative.startsWith('.codex/'))) {
        fail('workspace-install-target-invalid', relative)
    }
    const target = path.resolve(workspaceRoot, relative)
    const boundary = path.relative(workspaceRoot, target)
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
        fail('workspace-install-target-invalid', relative)
    }
    return target
}

function readOwnership(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        fail('workspace-install-ownership-invalid')
    }
}

function verifyOwnedFiles(workspaceRoot, ownership) {
    if (ownership?.schema
            !== 'issue-orchestration.shared-install-ownership.v1'
        || ownership?.packageIdentity !== 'issue-orchestration'
        || !ownership.files
        || typeof ownership.files !== 'object'
        || Array.isArray(ownership.files)) {
        fail('workspace-install-ownership-invalid')
    }
    for (const [relative, digest] of Object.entries(ownership.files)) {
        const target = safeTarget(workspaceRoot, relative)
        let stat
        try {
            stat = fs.lstatSync(target)
        } catch {
            fail('workspace-install-ownership-drift', relative)
        }
        if (!stat.isFile() || stat.isSymbolicLink()
            || fileDigest(target) !== digest) {
            fail('workspace-install-ownership-drift', relative)
        }
    }
}

function removeEmptyParents(file, workspaceRoot) {
    let cursor = path.dirname(file)
    while (cursor !== workspaceRoot) {
        try {
            fs.rmdirSync(cursor)
        } catch {
            return
        }
        cursor = path.dirname(cursor)
    }
}

function installWorkspace() {
    const args = parseArguments(process.argv.slice(2))
    if (!args.sourceRoot || !args.workspaceRoot) {
        fail('workspace-install-path-required')
    }
    const sourceRoot = fs.realpathSync(args.sourceRoot)
    const workspaceRoot = fs.realpathSync(args.workspaceRoot)
    if (!fs.statSync(workspaceRoot).isDirectory()) {
        fail('workspace-install-root-invalid')
    }
    const expected = expectedInstall(sourceRoot)
    const ownershipFile = path.join(
        workspaceRoot,
        OWNERSHIP_RELATIVE
    )
    if (fs.existsSync(ownershipFile)) {
        const installed = readOwnership(ownershipFile)
        verifyOwnedFiles(workspaceRoot, installed)
        if (JSON.stringify(canonical(installed))
            !== JSON.stringify(canonical(expected.ownership))) {
            fail('workspace-install-version-drift')
        }
        output({
            schema:
                'issue-orchestration.workspace-install-receipt.v1',
            status: 'already-current',
            packageIdentity: expected.manifest.packageIdentity,
            packageDigest: expected.manifest.sourceTreeDigest,
            manifestDigest: expected.manifest.manifestDigest,
            installDigest: expected.ownership.installDigest,
            workspaceRoot
        })
        return
    }

    const targets = expected.mappings.map((mapping) => ({
        ...mapping,
        target: safeTarget(workspaceRoot, mapping.targetRelative)
    }))
    for (const { target, targetRelative } of targets) {
        if (fs.existsSync(target)) {
            fail('workspace-install-target-conflict', targetRelative)
        }
    }
    if (fs.existsSync(ownershipFile)) {
        fail('workspace-install-target-conflict', OWNERSHIP_RELATIVE)
    }

    const created = []
    try {
        for (const mapping of targets) {
            fs.mkdirSync(path.dirname(mapping.target), {
                recursive: true
            })
            fs.copyFileSync(
                path.join(sourceRoot, mapping.sourceRelative),
                mapping.target,
                fs.constants.COPYFILE_EXCL
            )
            created.push(mapping.target)
        }
        fs.mkdirSync(path.dirname(ownershipFile), {
            recursive: true
        })
        fs.writeFileSync(
            ownershipFile,
            `${JSON.stringify(expected.ownership, null, 2)}\n`,
            { flag: 'wx' }
        )
        created.push(ownershipFile)
    } catch (error) {
        for (const file of created.toReversed()) {
            fs.rmSync(file, { force: true })
            removeEmptyParents(file, workspaceRoot)
        }
        throw error
    }

    output({
        schema: 'issue-orchestration.workspace-install-receipt.v1',
        status: 'installed',
        packageIdentity: expected.manifest.packageIdentity,
        packageDigest: expected.manifest.sourceTreeDigest,
        manifestDigest: expected.manifest.manifestDigest,
        installDigest: expected.ownership.installDigest,
        workspaceRoot
    })
}

try {
    installWorkspace()
} catch (error) {
    reportError(error)
}
