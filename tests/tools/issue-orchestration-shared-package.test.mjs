import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
    collectArtifactDigests,
    resolveSourceCommit,
    WRITER_STAGE_CONTRACT_FILES,
    WRITER_STAGE_RUNTIME_FILES
} from '../../scripts/package-lib.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const packageRoot = path.join(root, '.')
const manifestPath = path.join(packageRoot, 'manifest.json')
const discoverScript = path.join(packageRoot, 'scripts/discover.mjs')
const installScript = path.join(packageRoot, 'scripts/install.mjs')
const verifyScript = path.join(packageRoot, 'scripts/verify-install.mjs')
const uninstallScript = path.join(packageRoot, 'scripts/uninstall.mjs')
const contract = readJson('shared-package-test-contract.json')
const acceptance = readJson('shared-package-acceptance-map.json')
const expectedFailures =
    readJson('shared-package-expected-initial-failures.json')
const probes = readJson('shared-package-runtime-probes.json').probes
const controls = readJson('shared-package-mutation-controls.json').controls

const agentIds = [
    'code-implementer',
    'dag-creator-updater',
    'documentation-writer',
    'test-owner',
    'ui-system-adjudicator',
    'ui-ux-implementer',
    'ux-acceptance-verifier'
]
const writerAgentIds = [
    'code-implementer',
    'documentation-writer',
    'test-owner',
    'ui-ux-implementer'
]
const writerStageSchemas = {
    'contracts/compiled-dispatch-prompt.schema.json':
        'issue-orchestration.compiled-dispatch-prompt.v1',
    'contracts/executable-slice.schema.json':
        'issue-orchestration.executable-slice.v1',
    'contracts/slice-terminal-receipt.schema.json':
        'issue-orchestration.slice-terminal-receipt.v1',
    'contracts/stage-continuation-receipt.schema.json':
        'issue-orchestration.stage-continuation-receipt.v1',
    'contracts/stage-progress-checkpoint.schema.json':
        'issue-orchestration.stage-progress-checkpoint.v1',
    'contracts/stage-work-plan.schema.json':
        'issue-orchestration.stage-work-plan.v1',
    'contracts/writer-stage-checkpoint-verification-receipt.schema.json':
        'issue-orchestration.writer-stage-checkpoint-verification-receipt.v1',
    'contracts/writer-stage-failure-receipt.schema.json':
        'issue-orchestration.writer-stage-failure-receipt.v1',
    'contracts/writer-stage-retry-authorization.schema.json':
        'issue-orchestration.writer-stage-retry-authorization.v1'
}
const requiredPackageFiles = [
    'manifest.json',
    'policy/model-pool.json',
    'policy/control-plane-advisor-policy.json',
    'policy/git-resource-cleanup-policy.json',
    'policy/remote-mutation-policy.json',
    'policy/root-takeover-policy.json',
    'policy/routing-policy.json',
    'policy/runtime-execution-binding-policy.json',
    'policy/runtime-startup-policy.json',
    'policy/stage-mutation-guard-policy.json',
    'policy/stage-permissions.json',
    'graph/graph-patch.schema.json',
    'graph/runtime-projection.schema.json',
    'graph/semantic-graph.schema.json',
    'contracts/aggregate-runtime-projection.schema.json',
    'contracts/node-index.schema.json',
    'contracts/node-ledger-header.schema.json',
    'contracts/node-ledger.schema.json',
    'contracts/node-projection.schema.json',
    'contracts/run-control-ledger.schema.json',
    'contracts/run-control-projection.schema.json',
    'scripts/discover.mjs',
    'scripts/install.mjs',
    'scripts/uninstall.mjs',
    'scripts/verify-install.mjs',
    'skills/issue-orchestration/SKILL.md',
    ...WRITER_STAGE_CONTRACT_FILES,
    ...agentIds.map((id) => `agents/${id}.toml`)
]
const requiredRuntimeModules = [
    'delivery-epoch.mjs',
    'control-plane-advisor.mjs',
    'dispatch-batch-selector.mjs',
    'dispatch-receipt.mjs',
    'executable-slice-compiler.mjs',
    'event-ledger.mjs',
    'frontier-compiler.mjs',
    'git-resource-cleanup.mjs',
    'human-decision.mjs',
    'multi-node-state.mjs',
    'remote-mutation-authority.mjs',
    'resource-lifecycle.mjs',
    'root-takeover-supervisor.mjs',
    'runtime-authority-chain.mjs',
    'runtime-execution-binding.mjs',
    'runtime-startup-attestation.mjs',
    'scope-selector.mjs',
    'semantic-runtime-projection.mjs',
    'stage-profile-policy.mjs',
    'stage-runtime-guard.mjs',
    'validate-state-root.mjs',
    'writer-stage-progress.mjs'
]
const runtimeStateNames = new Set([
    'aggregate-runtime-projection.json',
    'control-ledger.jsonl',
    'control-projection.json',
    'dag.json',
    'event-ledger.jsonl',
    'ledger.jsonl',
    'node-index.json',
    'projection.json',
    'receipts',
    'resource-registry.json',
    'runtime-projection.json',
    'semantic-graph.json',
    'state-root'
])

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    const input = Buffer.isBuffer(value)
        ? value
        : Buffer.from(JSON.stringify(canonical(value)))
    return createHash('sha256').update(input).digest('hex')
}

function fileDigest(file) {
    return digest(fs.readFileSync(file))
}

function unsignedDigest(value, field) {
    const unsigned = structuredClone(value)
    delete unsigned[field]
    return digest(unsigned)
}

function walkFiles(directory) {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const child = path.join(directory, entry.name)
            return entry.isDirectory() ? walkFiles(child) : [child]
        })
}

function run(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: options.cwd ?? root,
        encoding: 'utf8',
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe']
    })
}

function assertCommand(result, label) {
    assert.equal(
        result.status,
        0,
        `${label}: status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`
    )
}

function parseReceipt(result, label) {
    assertCommand(result, label)
    const source = result.stdout.trim()
    assert.notEqual(source, '', `${label}: receipt missing`)
    return JSON.parse(source)
}

function parseFailureCode(result) {
    assert.notEqual(result.status, 0, 'negative command unexpectedly succeeded')
    for (const source of [result.stderr, result.stdout]) {
        const lines = source.trim().split('\n').filter(Boolean).toReversed()
        for (const line of lines) {
            try {
                const value = JSON.parse(line)
                if (typeof value?.code === 'string') return value.code
            } catch {
                // Continue past ordinary Node diagnostics.
            }
        }
    }
    return null
}

function git(directory, args) {
    const result = run('git', args, { cwd: directory })
    assertCommand(result, `git ${args.join(' ')}`)
    return result.stdout.trim()
}

function topology(t) {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'issue-orchestration-shared-package-')
    )
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    const protectedRoot = path.join(temporaryRoot, 'protected-root')
    const probeRoot = path.join(temporaryRoot, 'cwd-probes')
    const isolatedProbeCwds = Array.from(
        { length: 4 },
        (_, index) => path.join(probeRoot, `probe-${index + 1}`)
    )
    const externalRoot = path.join(temporaryRoot, 'external')
    const installRoot = path.join(externalRoot, 'shared-install')
    const stateRoot = path.join(externalRoot, 'runtime-state')
    fs.mkdirSync(protectedRoot, { recursive: true })
    for (const cwd of isolatedProbeCwds) {
        fs.mkdirSync(cwd, { recursive: true })
    }
    fs.mkdirSync(externalRoot, { recursive: true })
    return {
        temporaryRoot,
        protectedRoot,
        isolatedProbeCwds,
        installRoot,
        stateRoot,
        discoveryCwds: [
            packageRoot,
            ...isolatedProbeCwds
        ]
    }
}

function installArguments(value, target = value.installRoot) {
    return [
        '--source-root', packageRoot,
        '--install-root', target,
        '--protected-root', value.protectedRoot,
        '--protected-root', value.isolatedProbeCwds[0],
        '--json'
    ]
}

function verifyArguments(value) {
    return [
        '--source-root', packageRoot,
        '--install-root', value.installRoot,
        '--runtime-state-root', value.stateRoot,
        ...value.discoveryCwds.flatMap((cwd) => ['--probe-cwd', cwd]),
        '--json'
    ]
}

function install(value) {
    return parseReceipt(
        run(process.execPath, [installScript, ...installArguments(value)]),
        'shared package install'
    )
}

async function installedRuntimeModule(installRoot, name) {
    const modulePath = path.join(
        installRoot,
        '.agents/skills/issue-orchestration/scripts',
        name
    )
    assert.ok(fs.existsSync(modulePath),
        `installed-runtime-module-missing:${name}`)
    return import(`${pathToFileURL(modulePath).href}?probe=${Date.now()}-${Math.random()}`)
}

test('P01 freezes the complete issue-specific test contract', () => {
    assert.equal(contract.schema,
        'issue-orchestration.shared-package-test-contract.v1')
    assert.equal(contract.issueId, 'ExampleOrg/RepositoryA#1823')
    assert.equal(contract.baseSha,
        'd98bed01a76fcca5dc1657e63886b8da48ce346d')
    assert.match(contract.testOwnerId, /^test-owner-repositorya-1823-/u)
    assert.deepEqual(contract.allowedTestPaths.toSorted(), [
        'tests/fixtures/issue-orchestration/shared-package-acceptance-map.json',
        'tests/fixtures/issue-orchestration/shared-package-expected-initial-failures.json',
        'tests/fixtures/issue-orchestration/shared-package-mutation-controls.json',
        'tests/fixtures/issue-orchestration/shared-package-runtime-probes.json',
        'tests/fixtures/issue-orchestration/shared-package-test-contract.json',
        'tests/tools/issue-orchestration-shared-package.test.mjs'
    ])
    for (const [relative, expected] of Object.entries(contract.fileHashes)) {
        assert.equal(fileDigest(path.join(root, relative)), expected,
            `frozen-test-file-drift:${relative}`)
    }
    assert.equal(contract.frozenTreeDigest, digest(contract.fileHashes))
    assert.equal(contract.testContractDigest,
        unsignedDigest(contract, 'testContractDigest'))
})

test('P02 requires one complete authoring package and a self-consistent manifest', () => {
    for (const relative of requiredPackageFiles) {
        assert.ok(fs.existsSync(path.join(packageRoot, relative)),
            `shared-package-file-missing:${relative}`)
    }
    for (const module of requiredRuntimeModules) {
        assert.ok(fs.existsSync(path.join(
            packageRoot,
            'skills/issue-orchestration/scripts',
            module
        )), `shared-runtime-module-missing:${module}`)
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.schema,
        'issue-orchestration.shared-package-manifest.v1')
    assert.match(manifest.packageVersion, /^\d+\.\d+\.\d+$/u)
    assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/u)
    assert.equal(
        manifest.repositoryTargetPolicy,
        'caller-supplied-operator-owned-remote-identity'
    )
    assert.deepEqual(manifest.sourceRepositoryDependencies, [])
    assert.equal(manifest.modelPoolPolicyVersion, 'stage-model-pool.v3')
    for (const field of [
        'sourceTreeDigest',
        'skillDigest',
        'modelPoolDigest',
        'routingPolicyDigest',
        'stagePermissionDigest',
        'remoteMutationPolicyDigest',
        'runtimeTrustPolicyDigest',
        'runtimeStartupPolicyDigest',
        'executionRoutingPolicyDigest',
        'runtimeExecutionBindingPolicyDigest',
        'stageMutationGuardPolicyDigest',
        'rootTakeoverPolicyDigest',
        'controlPlaneAdvisorPolicyDigest',
        'graphSchemaDigest',
        'patchSchemaDigest',
        'runtimeProjectionSchemaDigest',
        'projectorDigest',
        'manifestDigest'
    ]) {
        assert.match(manifest[field], /^[a-f0-9]{64}$/u,
            `manifest-digest-invalid:${field}`)
    }
    assert.equal(manifest.manifestDigest,
        unsignedDigest(manifest, 'manifestDigest'))
    assert.deepEqual(Object.keys(manifest.agentDigests).sort(), agentIds)
    const actualContractDigests = Object.fromEntries(
        WRITER_STAGE_CONTRACT_FILES.map((relative) => [
            relative,
            manifest.artifactDigests[relative]
        ])
    )
    const actualRuntimeDigests = Object.fromEntries(
        WRITER_STAGE_RUNTIME_FILES.map((relative) => [
            relative,
            manifest.artifactDigests[relative]
        ])
    )
    assert.deepEqual(
        manifest.writerStageContractDigests,
        actualContractDigests,
        'manifest-writer-stage-contract-binding-drift'
    )
    assert.deepEqual(
        manifest.writerStageRuntimeDigests,
        actualRuntimeDigests,
        'manifest-writer-stage-runtime-binding-drift'
    )
    assert.deepEqual(
        Object.keys(writerStageSchemas).sort(),
        [...WRITER_STAGE_CONTRACT_FILES].sort()
    )
    for (const [relative, schema] of Object.entries(writerStageSchemas)) {
        const document = JSON.parse(fs.readFileSync(
            path.join(packageRoot, relative),
            'utf8'
        ))
        assert.equal(document.title, schema, `contract-title:${relative}`)
        assert.equal(document.properties?.schema?.const, schema,
            `contract-schema:${relative}`)
    }
    assert.equal(Object.hasOwn(manifest.artifactDigests ?? {}, 'manifest.json'),
        false, 'manifest-cannot-digest-itself-as-an-artifact')
    const actualArtifacts = collectArtifactDigests(packageRoot)
    const comparePaths = (left, right) => left.localeCompare(right)
    assert.deepEqual(
        Object.keys(manifest.artifactDigests ?? {}).sort(comparePaths),
        Object.keys(actualArtifacts).sort(comparePaths),
        'manifest-artifact-set-drift'
    )
    for (const [relative, expected] of
        Object.entries(manifest.artifactDigests ?? {})) {
        assert.equal(actualArtifacts[relative], expected,
            `manifest-artifact-drift:${relative}`)
    }
    assert.equal(manifest.sourceTreeDigest,
        digest(manifest.artifactDigests))
    assert.equal(
        resolveSourceCommit(packageRoot),
        git(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
        'manifest-builder-source-identity-drift'
    )
})

test('P03 removes repo-local authority and exposes exactly seven shared roles', () => {
    assert.equal(fs.existsSync(path.join(
        root, '.agents/skills/issue-orchestration'
    )), false, 'repo-local-skill-authority-present')
    const repoLocalAgents = walkFiles(path.join(root, '.codex/agents'))
        .filter((file) => path.basename(file).startsWith('issue-'))
    assert.deepEqual(repoLocalAgents, [], 'repo-local-agent-authority-present')
    const packageAgents = fs.readdirSync(path.join(packageRoot, 'agents'))
        .filter((name) => name.endsWith('.toml'))
        .map((name) => name.slice(0, -5))
        .sort()
    assert.deepEqual(packageAgents, agentIds)
    const permissions = JSON.parse(fs.readFileSync(path.join(
        packageRoot,
        'policy/stage-permissions.json'
    ), 'utf8'))
    for (const key of [
        'code-implementer:landing-conflict-resolution',
        'ui-ux-implementer:landing-conflict-resolution'
    ]) {
        assert.equal(
            permissions.stages[key].executionClass,
            'leased-writer',
            `landing-conflict-execution-class:${key}`
        )
        assert.equal(
            permissions.stages[key].writeScope,
            'implementation-only',
            `landing-conflict-write-scope:${key}`
        )
        assert.equal(
            permissions.stages[key].freshContext,
            false,
            `landing-conflict-fresh-context:${key}`
        )
    }
    assert.equal(JSON.stringify(permissions).includes('landing-owner'), false,
        'landing-observation-label-became-dispatch-role')
    for (const agentId of writerAgentIds) {
        const source = fs.readFileSync(path.join(
            packageRoot,
            'agents',
            `${agentId}.toml`
        ), 'utf8')
        for (const required of [
            'issue-orchestration.stage-work-plan.v1',
            'issue-orchestration.executable-slice.v1',
            'issue-orchestration.compiled-dispatch-prompt.v1',
            'firstRequiredAction',
            'firstReadTargets',
            'firstWritablePath',
            'explicitReadOnlyOutput',
            'issue-orchestration.stage-progress-checkpoint.v1',
            'issue-orchestration.writer-stage-checkpoint-verification-receipt.v1',
            'issue-orchestration.stage-continuation-receipt.v1',
            'issue-orchestration.slice-terminal-receipt.v1',
            'issue-orchestration.writer-stage-failure-receipt.v1'
        ]) {
            assert.ok(source.includes(required),
                `writer-agent-contract-missing:${agentId}:${required}`)
        }
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const packageText = Object.keys(manifest.artifactDigests)
        .map((relative) => fs.readFileSync(
            path.join(packageRoot, relative),
            'utf8'
        ))
        .join('\n')
    for (const forbidden of [
        'issue-implementer',
        'issue-reviewer',
        'cleanup-verifier',
        'fixed-Sol',
        'fixed Sol',
        'generic subagent'
    ]) {
        assert.equal(packageText.includes(forbidden), false,
            `retired-authority-discoverable:${forbidden}`)
    }
})

test('P04 performs a real atomic install and five-cwd discovery probe', (t) => {
    const value = topology(t)
    const installReceipt = install(value)
    assert.equal(installReceipt.schema,
        'issue-orchestration.shared-install-receipt.v1')
    assert.equal(installReceipt.status, 'installed')
    const receipt = parseReceipt(
        run(process.execPath, [verifyScript, ...verifyArguments(value)]),
        'shared package verification'
    )
    assert.equal(receipt.schema,
        'issue-orchestration.shared-install-verification.v1')
    assert.equal(receipt.status, 'verified')
    assert.equal(receipt.discoveries.length, 5)
    assert.deepEqual(receipt.discoveries.map(({ cwd }) =>
        fs.realpathSync(cwd)), value.discoveryCwds.map((cwd) =>
        fs.realpathSync(cwd)))
    const identities = new Set(receipt.discoveries.map((entry) =>
        JSON.stringify({
            packageIdentity: entry.packageIdentity,
            packageDigest: entry.packageDigest,
            skillIdentity: entry.skillIdentity,
            skillDigest: entry.skillDigest,
            agentIds: entry.agentIds,
            modelPoolDigest: entry.modelPoolDigest,
            routingPolicyDigest: entry.routingPolicyDigest,
            stagePermissionDigest: entry.stagePermissionDigest,
            remoteMutationPolicyDigest: entry.remoteMutationPolicyDigest,
            runtimeTrustPolicyDigest: entry.runtimeTrustPolicyDigest,
            runtimeStartupPolicyDigest: entry.runtimeStartupPolicyDigest,
            executionRoutingPolicyDigest:
                entry.executionRoutingPolicyDigest,
            runtimeExecutionBindingPolicyDigest:
                entry.runtimeExecutionBindingPolicyDigest,
            stageMutationGuardPolicyDigest:
                entry.stageMutationGuardPolicyDigest,
            rootTakeoverPolicyDigest: entry.rootTakeoverPolicyDigest,
            controlPlaneAdvisorPolicyDigest:
                entry.controlPlaneAdvisorPolicyDigest,
            graphSchemaDigest: entry.graphSchemaDigest,
            patchSchemaDigest: entry.patchSchemaDigest,
            runtimeProjectionSchemaDigest:
                entry.runtimeProjectionSchemaDigest,
            writerStageContractDigests:
                entry.writerStageContractDigests,
            writerStageRuntimeDigests:
                entry.writerStageRuntimeDigests,
            projectorDigest: entry.projectorDigest
        })))
    assert.equal(identities.size, 1, 'discovery-identity-drift')
    assert.deepEqual(receipt.discoveries[0].agentIds.toSorted(), agentIds)
    const standalone = parseReceipt(run(process.execPath, [
        discoverScript,
        '--source-root', packageRoot,
        '--install-root', value.installRoot,
        '--cwd', value.discoveryCwds[0],
        '--json'
    ]), 'standalone shared package discovery')
    for (const field of [
        'stagePermissionDigest',
        'runtimeTrustPolicyDigest',
        'runtimeStartupPolicyDigest',
        'executionRoutingPolicyDigest',
        'runtimeExecutionBindingPolicyDigest',
        'stageMutationGuardPolicyDigest',
        'rootTakeoverPolicyDigest',
        'controlPlaneAdvisorPolicyDigest',
        'runtimeProjectionSchemaDigest',
        'writerStageContractDigests',
        'writerStageRuntimeDigests'
    ]) {
        assert.deepEqual(standalone[field], receipt.discoveries[0][field],
            `standalone-discovery-binding-drift:${field}`)
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const relative of WRITER_STAGE_CONTRACT_FILES) {
        const installed = path.join(
            value.installRoot,
            '.agents/contracts',
            path.basename(relative)
        )
        assert.equal(fileDigest(installed),
            manifest.writerStageContractDigests[relative],
            `installed-writer-contract-drift:${relative}`)
    }
    for (const relative of WRITER_STAGE_RUNTIME_FILES) {
        const installed = path.join(
            value.installRoot,
            '.agents/skills/issue-orchestration/scripts',
            path.basename(relative)
        )
        assert.equal(fileDigest(installed),
            manifest.writerStageRuntimeDigests[relative],
            `installed-writer-runtime-drift:${relative}`)
    }
})

test('P05 reinstall is deterministic and cannot leave half-installed artifacts', (t) => {
    const value = topology(t)
    const first = install(value)
    const before = digest(walkFiles(value.installRoot)
        .map((file) => [path.relative(value.installRoot, file), fileDigest(file)]))
    const second = parseReceipt(
        run(process.execPath, [installScript, ...installArguments(value)]),
        'shared package reinstall'
    )
    const after = digest(walkFiles(value.installRoot)
        .map((file) => [path.relative(value.installRoot, file), fileDigest(file)]))
    assert.equal(second.status, 'already-current')
    assert.equal(second.installDigest, first.installDigest)
    assert.equal(after, before)
    assert.deepEqual(walkFiles(value.installRoot)
        .filter((file) => /\.(?:tmp|partial)$/u.test(file)), [])
})

test('P06 unknown installed edits fail closed and are never overwritten', (t) => {
    const value = topology(t)
    install(value)
    const installedSkill = path.join(
        value.installRoot,
        '.agents/skills/issue-orchestration/SKILL.md'
    )
    fs.appendFileSync(installedSkill, '\nunknown hand edit\n')
    const driftDigest = fileDigest(installedSkill)
    const verifyResult = run(process.execPath,
        [verifyScript, ...verifyArguments(value)])
    assert.equal(parseFailureCode(verifyResult), 'installed-artifact-drift')
    const reinstallResult = run(process.execPath,
        [installScript, ...installArguments(value)])
    assert.equal(parseFailureCode(reinstallResult),
        'install-target-ownership-drift')
    assert.equal(fileDigest(installedSkill), driftDigest,
        'installer-overwrote-unknown-hand-edit')
})

test('P07 protected targets and ownership-unsafe uninstall fail closed', (t) => {
    const value = topology(t)
    const protectedTarget = path.join(
        value.protectedRoot,
        '.shared-control-plane'
    )
    const refused = run(process.execPath, [
        installScript,
        ...installArguments(value, protectedTarget)
    ])
    assert.equal(parseFailureCode(refused), 'install-target-protected-overlap')
    assert.equal(fs.existsSync(protectedTarget), false)
    install(value)
    const sibling = path.join(path.dirname(value.installRoot), 'keep.txt')
    fs.writeFileSync(sibling, 'external owner\n')
    const receipt = parseReceipt(run(process.execPath, [
        uninstallScript,
        '--source-root', packageRoot,
        '--install-root', value.installRoot,
        '--json'
    ]), 'shared package uninstall')
    assert.equal(receipt.status, 'uninstalled')
    assert.equal(fs.existsSync(value.installRoot), false)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'external owner\n')
})

test('P08 installed runtime carries routing, graph and receipt authority', async (t) => {
    const value = topology(t)
    install(value)
    const stage = await installedRuntimeModule(
        value.installRoot,
        'stage-profile-policy.mjs'
    )
    const semantic = await installedRuntimeModule(
        value.installRoot,
        'semantic-runtime-projection.mjs'
    )
    const dispatch = await installedRuntimeModule(
        value.installRoot,
        'dispatch-receipt.mjs'
    )
    const compiler = await installedRuntimeModule(
        value.installRoot,
        'executable-slice-compiler.mjs'
    )
    const progress = await installedRuntimeModule(
        value.installRoot,
        'writer-stage-progress.mjs'
    )
    assert.equal(stage.STAGE_MODEL_POOL_POLICY.version,
        'stage-model-pool.v3')
    assert.equal(stage.STAGE_MODEL_POOL_POLICY.stages[
        'root-scheduler:scheduling'
    ].defaultProfile, 'terra-low')
    for (const name of [
        'classifyRemoteMutations',
        'createSemanticGraph',
        'projectRuntime',
        'sealSemanticGraphPatch',
        'validateFullSemanticGraphProposal'
    ]) assert.equal(typeof semantic[name], 'function', `runtime-export:${name}`)
    for (const name of [
        'sealDispatchRequest',
        'verifyRuntimeDispatch',
        'sealImplementerSelfTestReceipt'
    ]) assert.equal(typeof dispatch[name], 'function', `runtime-export:${name}`)
    for (const name of [
        'compileContinuation',
        'compileDispatchPrompt',
        'compileExecutableSlice',
        'compileStageWorkPlan',
        'sealProgressCheckpoint',
        'validateCompiledDispatchPrompt',
        'validateProgressCheckpoint'
    ]) assert.equal(typeof compiler[name], 'function', `runtime-export:${name}`)
    for (const name of [
        'authorizeWriterStageRetry',
        'evaluateSliceTerminalGate',
        'evaluateWriterStageObservation',
        'sealSliceTerminalReceipt'
    ]) assert.equal(typeof progress[name], 'function', `runtime-export:${name}`)
})

test('P09 runtime state is external to source and installed artifacts', (t) => {
    const value = topology(t)
    install(value)
    fs.mkdirSync(value.stateRoot, { recursive: true })
    fs.writeFileSync(path.join(value.stateRoot, 'semantic-graph.json'), '{}\n')
    fs.writeFileSync(path.join(value.stateRoot, 'runtime-projection.json'), '{}\n')
    const receipt = parseReceipt(
        run(process.execPath, [verifyScript, ...verifyArguments(value)]),
        'runtime isolation verification'
    )
    assert.equal(receipt.runtimeStateRoot, fs.realpathSync(value.stateRoot))
    for (const candidateRoot of [packageRoot, value.installRoot]) {
        const leaked = walkFiles(candidateRoot).filter((file) =>
            [...runtimeStateNames].some((name) =>
                file.split(path.sep).includes(name) ||
                path.basename(file) === name))
        assert.deepEqual(leaked, [], `runtime-state-leaked:${candidateRoot}`)
    }
})

test('P10 package carries orchestration facts, not product design facts', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.deepEqual(manifest.ownedDomains.toSorted(), [
        'acceptance-group',
        'control-plane-advisor',
        'delivery',
        'lifecycle-action-compilation',
        'model-routing',
        'mutation-postcondition',
        'receipts',
        'remote-mutation-authority',
        'resource-lifecycle',
        'root-recovery-takeover',
        'run-control-ledger',
        'runtime-projection',
        'runtime-startup',
        'scope-selector',
        'semantic-graph',
        'stage-dispatch',
        'test-contract-cold-start'
    ])
    assert.deepEqual(manifest.excludedAuthorities.toSorted(), [
        'bootstrap-executor',
        'product-api',
        'product-design',
        'product-documentation',
        'product-runtime',
        'repo-local-orchestration-copy',
        'repository-agents',
        'temporary-scheduler'
    ])
    const forbiddenPaths = walkFiles(packageRoot)
        .map((file) => path.relative(packageRoot, file))
        .filter((relative) =>
            /(^|\/)(design|frontend|product|ui-facts)(\/|$)/u.test(relative))
    assert.deepEqual(forbiddenPaths, [], 'product-design-copy-present')
})

test('P11 acceptance, probes and mutation controls cover every issue gate', () => {
    assert.equal(acceptance.schema,
        'issue-orchestration.shared-package-acceptance-map.v1')
    assert.equal(probes.length, 9)
    assert.equal(controls.length, 12)
    const testIds = new Set([
        'P01', 'P02', 'P03', 'P04', 'P05', 'P06',
        'P07', 'P08', 'P09', 'P10', 'P11', 'P12'
    ])
    const mappedTests = new Set(acceptance.acceptance
        .flatMap((entry) => entry.tests))
    assert.deepEqual(mappedTests, testIds)
    const mappedMutations = new Set(acceptance.acceptance
        .flatMap((entry) => entry.mutations))
    assert.deepEqual(mappedMutations,
        new Set(controls.map(({ id }) => id)))
    assert.deepEqual(new Set(probes.map(({ test }) => test)), new Set([
        'P04', 'P05', 'P06', 'P07', 'P08', 'P09'
    ]))
    assert.equal(expectedFailures.baseSha, contract.baseSha)
    assert.equal(expectedFailures.expectedOutcome, 'red')
    assert.deepEqual(expectedFailures.expectedFailingTests.toSorted(), [
        'P02', 'P03', 'P04', 'P05', 'P06',
        'P07', 'P08', 'P09', 'P10'
    ])
})

test('P12 package has no product-repository identity or sibling-checkout dependency', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const trustPolicy = JSON.parse(fs.readFileSync(path.join(
        packageRoot,
        'policy/runtime-trust-policy.json'
    ), 'utf8'))
    assert.deepEqual(manifest.sourceRepositoryDependencies, [])
    assert.equal(Object.hasOwn(manifest, 'supportedRepositories'), false)
    for (const mode of Object.values(trustPolicy.modes)) {
        assert.equal(Object.hasOwn(mode, 'repositoryAllowlist'), false)
        assert.equal(
            mode.repositoryAdmission,
            'caller-supplied-operator-owned-remote-identity'
        )
    }
    for (const relative of Object.keys(manifest.artifactDigests)) {
        const source = fs.readFileSync(path.join(packageRoot, relative), 'utf8')
        assert.doesNotMatch(source, /fsus[-_ ]?(?:blog|ui)/iu, relative)
    }
})
