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
        stagePermissionDigest: manifest.stagePermissionDigest,
        remoteMutationPolicyDigest: manifest.remoteMutationPolicyDigest,
        runtimeTrustPolicyDigest: manifest.runtimeTrustPolicyDigest,
        runtimeStartupPolicyDigest: manifest.runtimeStartupPolicyDigest,
        executionRoutingPolicyDigest:
            manifest.executionRoutingPolicyDigest,
        runtimeExecutionBindingPolicyDigest:
            manifest.runtimeExecutionBindingPolicyDigest,
        stageMutationGuardPolicyDigest:
            manifest.stageMutationGuardPolicyDigest,
        rootTakeoverPolicyDigest: manifest.rootTakeoverPolicyDigest,
        controlPlaneAdvisorPolicyDigest:
            manifest.controlPlaneAdvisorPolicyDigest,
        graphSchemaDigest: manifest.graphSchemaDigest,
        patchSchemaDigest: manifest.patchSchemaDigest,
        runtimeProjectionSchemaDigest:
            manifest.runtimeProjectionSchemaDigest,
        writerStageContractDigests:
            manifest.writerStageContractDigests,
        writerStageRuntimeDigests:
            manifest.writerStageRuntimeDigests,
        projectorDigest: manifest.projectorDigest
    })
}

try {
    discover()
} catch (error) {
    reportError(error)
}
