#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
    copyInstallTree,
    expectedInstall,
    fail,
    hasIncompleteTransaction,
    output,
    parseArguments,
    reportError,
    temporarySibling,
    validateInstallBoundary,
    verifyInstalled
} from './package-lib.mjs'

function install() {
    const args = parseArguments(process.argv.slice(2))
    const boundary = validateInstallBoundary(args)
    const expected = expectedInstall(boundary.sourceRoot)
    if (hasIncompleteTransaction(boundary.installRoot)) {
        fail('install-transaction-incomplete')
    }
    if (fs.existsSync(boundary.installRoot)) {
        verifyInstalled({
            sourceRoot: boundary.sourceRoot,
            installRoot: boundary.installRoot,
            driftCode: 'install-target-ownership-drift'
        })
        output({
            schema: 'issue-orchestration.shared-install-receipt.v1',
            status: 'already-current',
            packageIdentity: expected.manifest.packageIdentity,
            packageDigest: expected.manifest.sourceTreeDigest,
            manifestDigest: expected.manifest.manifestDigest,
            installDigest: expected.ownership.installDigest,
            installRoot: fs.realpathSync(boundary.installRoot)
        })
        return
    }
    const stagingRoot = temporarySibling(boundary.installRoot)
    if (fs.existsSync(stagingRoot)) fail('install-transaction-incomplete')
    try {
        fs.mkdirSync(path.dirname(boundary.installRoot), { recursive: true })
        fs.mkdirSync(stagingRoot)
        copyInstallTree({
            sourceRoot: boundary.sourceRoot,
            stagingRoot,
            mappings: expected.mappings,
            ownership: expected.ownership
        })
        verifyInstalled({
            sourceRoot: boundary.sourceRoot,
            installRoot: stagingRoot,
            driftCode: 'install-transaction-incomplete'
        })
        fs.renameSync(stagingRoot, boundary.installRoot)
    } catch (error) {
        if (fs.existsSync(stagingRoot)) {
            fs.rmSync(stagingRoot, { recursive: true, force: true })
        }
        throw error
    }
    output({
        schema: 'issue-orchestration.shared-install-receipt.v1',
        status: 'installed',
        packageIdentity: expected.manifest.packageIdentity,
        packageDigest: expected.manifest.sourceTreeDigest,
        manifestDigest: expected.manifest.manifestDigest,
        installDigest: expected.ownership.installDigest,
        installRoot: fs.realpathSync(boundary.installRoot)
    })
}

try {
    install()
} catch (error) {
    reportError(error)
}
