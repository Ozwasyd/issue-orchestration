#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
    assertExternalRuntimeRoot,
    assertNoRuntimeState,
    fail,
    output,
    parseArguments,
    reportError,
    verifyInstalled
} from './package-lib.mjs'

function discovery(cwd, manifest) {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        fail('discovery-cwd-invalid', cwd)
    }
    const localSkill = path.join(
        cwd,
        '.agents/skills/issue-orchestration'
    )
    if (fs.existsSync(localSkill)) {
        fail('repo-local-skill-authority-present', cwd)
    }
    const localAgents = path.join(cwd, '.codex/agents')
    if (fs.existsSync(localAgents)) {
        const sharedAgentIds = new Set(Object.keys(manifest.agentDigests))
        const conflicting = fs.readdirSync(localAgents)
            .filter((name) => name.endsWith('.toml'))
            .map((name) => name.slice(0, -5))
            .filter((id) => id.startsWith('issue-')
                || sharedAgentIds.has(id))
        if (conflicting.length > 0) {
            fail('repo-local-agent-authority-present', cwd)
        }
    }
    const localManifest = path.join(
        cwd,
        '.agents/issue-orchestration-manifest.json'
    )
    if (fs.existsSync(localManifest)) {
        let discovered
        try {
            discovered = JSON.parse(fs.readFileSync(localManifest, 'utf8'))
        } catch {
            fail('discovery-identity-drift', cwd)
        }
        if (discovered.manifestDigest !== manifest.manifestDigest) {
            fail('discovery-identity-drift', cwd)
        }
    }
    return {
        cwd,
        packageIdentity: manifest.packageIdentity,
        packageDigest: manifest.sourceTreeDigest,
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
    }
}

function verify() {
    const args = parseArguments(process.argv.slice(2))
    if (!args.sourceRoot || !args.installRoot) {
        fail('install-path-required')
    }
    const expected = verifyInstalled(args)
    const runtimeStateRoot = assertExternalRuntimeRoot(args)
    assertNoRuntimeState(args.sourceRoot)
    assertNoRuntimeState(args.installRoot)
    const discoveries = args.probeCwds.map((cwd) =>
        discovery(cwd, expected.manifest))
    output({
        schema: 'issue-orchestration.shared-install-verification.v1',
        status: 'verified',
        packageIdentity: expected.manifest.packageIdentity,
        packageDigest: expected.manifest.sourceTreeDigest,
        manifestDigest: expected.manifest.manifestDigest,
        installDigest: expected.ownership.installDigest,
        installRoot: fs.realpathSync(args.installRoot),
        runtimeStateRoot,
        discoveries
    })
}

try {
    verify()
} catch (error) {
    reportError(error)
}
