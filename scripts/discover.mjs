#!/usr/bin/env node

import fs from 'node:fs'

import {
    fail,
    output,
    parseArguments,
    reportError,
    verifyInstalled
} from './package-lib.mjs'

function discover() {
    const args = parseArguments(process.argv.slice(2))
    if (!args.sourceRoot || !args.installRoot || !args.cwd) {
        fail('discovery-arguments-required')
    }
    if (!fs.existsSync(args.cwd) || !fs.statSync(args.cwd).isDirectory()) {
        fail('discovery-cwd-invalid')
    }
    const { manifest, ownership } = verifyInstalled(args)
    output({
        schema: 'issue-orchestration.shared-discovery.v1',
        status: 'discovered',
        cwd: fs.realpathSync(args.cwd),
        installRoot: fs.realpathSync(args.installRoot),
        packageIdentity: manifest.packageIdentity,
        packageDigest: manifest.sourceTreeDigest,
        installDigest: ownership.installDigest,
        skillIdentity: manifest.skillIdentity,
        skillDigest: manifest.skillDigest,
        agentIds: Object.keys(manifest.agentDigests).sort(),
        modelPoolDigest: manifest.modelPoolDigest,
        routingPolicyDigest: manifest.routingPolicyDigest,
        remoteMutationPolicyDigest: manifest.remoteMutationPolicyDigest,
        graphSchemaDigest: manifest.graphSchemaDigest,
        patchSchemaDigest: manifest.patchSchemaDigest,
        projectorDigest: manifest.projectorDigest
    })
}

try {
    discover()
} catch (error) {
    reportError(error)
}
