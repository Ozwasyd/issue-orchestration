#!/usr/bin/env node

import fs from 'node:fs'

import {
    fail,
    output,
    parseArguments,
    reportError,
    validateInstallBoundary,
    verifyInstalled
} from './package-lib.mjs'

function uninstall() {
    const args = parseArguments(process.argv.slice(2))
    const boundary = validateInstallBoundary(args)
    if (!fs.existsSync(boundary.installRoot)) {
        fail('install-target-missing')
    }
    const expected = verifyInstalled({
        sourceRoot: boundary.sourceRoot,
        installRoot: boundary.installRoot,
        driftCode: 'uninstall-target-ownership-drift'
    })
    fs.rmSync(boundary.installRoot, { recursive: true })
    output({
        schema: 'issue-orchestration.shared-uninstall-receipt.v1',
        status: 'uninstalled',
        packageIdentity: expected.manifest.packageIdentity,
        installDigest: expected.ownership.installDigest,
        installRoot: boundary.installRoot
    })
}

try {
    uninstall()
} catch (error) {
    reportError(error)
}
