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
    return path.resolve(workspaceRoot, relative)
}

function verifyWorkspace() {
    const args = parseArguments(process.argv.slice(2))
    if (!args.sourceRoot || !args.workspaceRoot) {
        fail('workspace-install-path-required')
    }
    const sourceRoot = fs.realpathSync(args.sourceRoot)
    const workspaceRoot = fs.realpathSync(args.workspaceRoot)
    const expected = expectedInstall(sourceRoot)
    const ownershipFile = path.join(
        workspaceRoot,
        OWNERSHIP_RELATIVE
    )
    let installed
    try {
        installed = JSON.parse(fs.readFileSync(ownershipFile, 'utf8'))
    } catch {
        fail('workspace-install-ownership-invalid')
    }
    if (JSON.stringify(canonical(installed))
        !== JSON.stringify(canonical(expected.ownership))) {
        fail('workspace-install-version-drift')
    }
    for (const [relative, digest] of Object.entries(installed.files)) {
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
    output({
        schema:
            'issue-orchestration.workspace-install-verification.v1',
        status: 'verified',
        packageIdentity: expected.manifest.packageIdentity,
        packageDigest: expected.manifest.sourceTreeDigest,
        manifestDigest: expected.manifest.manifestDigest,
        installDigest: expected.ownership.installDigest,
        workspaceRoot,
        skillPath: path.join(
            workspaceRoot,
            '.agents/skills/issue-orchestration/SKILL.md'
        ),
        agentIds: Object.keys(expected.manifest.agentDigests).sort()
    })
}

try {
    verifyWorkspace()
} catch (error) {
    reportError(error)
}
