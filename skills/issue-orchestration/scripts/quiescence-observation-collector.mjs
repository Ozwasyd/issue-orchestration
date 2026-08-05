import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
    digest,
    fail,
    sameValue,
    seal
} from './runtime-contract-lib.mjs'

const execFileAsync = promisify(execFile)
export const QUIESCENCE_INVENTORY_NAMES = Object.freeze([
    'issues',
    'stages',
    'attempts',
    'groups',
    'actors',
    'workPlans',
    'slices',
    'checkpoints',
    'continuations',
    'outputMissingBreakers',
    'routes',
    'profileCapabilities',
    'git',
    'resources',
    'processes',
    'ports',
    'docker',
    'locks',
    'leases',
    'slots',
    'filesystem',
    'skills',
    'bootstrap',
    'landing',
    'sourceCandidates',
    'commitMappings',
    'humanDecisions',
    'humanRetentions',
    'dag',
    'telemetry'
])

async function command(file, args, { cwd } = {}) {
    try {
        const result = await execFileAsync(file, args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
            timeout: 10_000,
            env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: '0'
            }
        })
        return {
            observable: true,
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                observable: true,
                exitCode: 127,
                stdout: '',
                stderr: 'command-not-installed'
            }
        }
        return {
            observable: false,
            exitCode: error.code,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message
        }
    }
}

async function safeReadDirectory(target) {
    try {
        return {
            observable: true,
            records: await fs.readdir(target, { withFileTypes: true })
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { observable: true, records: [] }
        }
        return { observable: false, records: [], error: error.code }
    }
}

function summarize(records) {
    return {
        recordCount: records.length,
        activeCount: records.filter(({ active }) => active === true).length,
        retainedCount: records.filter(
            ({ retained }) => retained === true
        ).length,
        unobservableCount: records.filter(
            ({ observable }) => observable === false
        ).length
    }
}

function inventory({
    records = [],
    collectionMethod,
    collectedAt,
    machineId,
    observable = true
}) {
    const value = {
        records,
        summary: summarize(records),
        collectionMethod,
        collectedAt,
        machineId,
        observable
    }
    value.sourceDigest = digest(value)
    return value
}

async function processRecords(scopeTokens) {
    const proc = await safeReadDirectory('/proc')
    if (!proc.observable) {
        return { observable: false, records: [] }
    }
    const records = []
    for (const entry of proc.records) {
        if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue
        const processId = Number(entry.name)
        try {
            const cmdline = (await fs.readFile(
                `/proc/${entry.name}/cmdline`,
                'utf8'
            )).replaceAll('\0', ' ').trim()
            if (!cmdline) continue
            const owned = scopeTokens.some((token) =>
                token && cmdline.includes(token))
            records.push({
                processId,
                commandDigest: digest(cmdline),
                owned,
                active: owned && processId !== process.pid,
                observable: true
            })
        } catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) {
                records.push({
                    processId,
                    active: false,
                    observable: false,
                    error: error.code
                })
            }
        }
    }
    return { observable: true, records }
}

async function portRecords() {
    const records = []
    let observable = true
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
            const text = await fs.readFile(file, 'utf8')
            for (const line of text.trim().split(/\r?\n/u).slice(1)) {
                const columns = line.trim().split(/\s+/u)
                if (columns[3] !== '0A') continue
                const local = columns[1] ?? ''
                const port = Number.parseInt(local.split(':')[1], 16)
                records.push({
                    source: file,
                    port,
                    active: false,
                    observable: true
                })
            }
        } catch (error) {
            observable = false
            records.push({
                source: file,
                active: false,
                observable: false,
                error: error.code
            })
        }
    }
    return { observable, records }
}

async function dockerRecords() {
    const result = await command('docker', [
        'ps',
        '--all',
        '--no-trunc',
        '--format',
        '{{json .}}'
    ])
    if (result.exitCode === 127) {
        return {
            observable: true,
            records: [{
                installed: false,
                active: false,
                observable: true
            }]
        }
    }
    const records = result.stdout.split(/\r?\n/u).filter(Boolean)
        .map((line) => {
            try {
                const value = JSON.parse(line)
                return {
                    containerId: value.ID,
                    names: value.Names,
                    state: value.State,
                    active: value.State === 'running',
                    observable: true
                }
            } catch {
                return {
                    lineDigest: digest(line),
                    active: false,
                    observable: false
                }
            }
        })
    return { observable: result.observable, records }
}

async function repositoryRecords(repositories = []) {
    const records = []
    let observable = true
    for (const repository of repositories) {
        const [head, branch, worktrees, branches, status] =
            await Promise.all([
                command('git', ['rev-parse', 'HEAD'], {
                    cwd: repository.root
                }),
                command('git', ['branch', '--show-current'], {
                    cwd: repository.root
                }),
                command('git', ['worktree', 'list', '--porcelain'], {
                    cwd: repository.root
                }),
                command('git', [
                    'for-each-ref',
                    '--format=%(refname:short)',
                    'refs/heads'
                ], { cwd: repository.root }),
                command('git', [
                    'status',
                    '--porcelain=v1',
                    '--untracked-files=no'
                ], { cwd: repository.root })
            ])
        const results = [head, branch, worktrees, branches, status]
        const entryObservable = results.every(
            (result) => result.observable && result.exitCode === 0
        )
        observable &&= entryObservable
        records.push({
            name: repository.name,
            repository: repository.repository,
            root: path.resolve(repository.root),
            defaultBranch: repository.defaultBranch,
            head: head.stdout.trim(),
            branch: branch.stdout.trim(),
            worktreeCount: worktrees.stdout.split(/\r?\n/u)
                .filter((line) => line.startsWith('worktree ')).length,
            localBranchCount: branches.stdout.split(/\r?\n/u)
                .filter(Boolean).length,
            dirty: status.stdout.trim().length > 0,
            active: false,
            observable: entryObservable
        })
    }
    return { observable, records }
}

async function filesystemRecords(config) {
    const roots = [
        config.stateRoot,
        ...config.repositories.map(({ root }) => root)
    ]
    const records = []
    let observable = true
    for (const root of roots) {
        const entries = await safeReadDirectory(root)
        observable &&= entries.observable
        records.push({
            root: path.resolve(root),
            entryCount: entries.records.length,
            entriesDigest: digest(entries.records.map((entry) => ({
                name: entry.name,
                directory: entry.isDirectory(),
                file: entry.isFile(),
                symbolicLink: entry.isSymbolicLink()
            }))),
            active: false,
            observable: entries.observable
        })
    }
    return { observable, records }
}

async function lockRecords() {
    try {
        const text = await fs.readFile('/proc/locks', 'utf8')
        return {
            observable: true,
            records: text.split(/\r?\n/u).filter(Boolean).map((line) => ({
                lockDigest: digest(line),
                active: false,
                observable: true
            }))
        }
    } catch (error) {
        return {
            observable: false,
            records: [{
                error: error.code,
                active: false,
                observable: false
            }]
        }
    }
}

function emptyInventoryRecord(name, config) {
    return [{
        inventory: name,
        selectorScopeDigest: digest(config.selectorScope ?? []),
        active: false,
        observable: true
    }]
}

function assertConfig(config) {
    if (!config?.runId || !config?.stateRoot
        || !Array.isArray(config.repositories)
        || !config.machineId) {
        fail('collector-config-invalid')
    }
}

export async function freezeQuiescenceBaseline(config) {
    assertConfig(config)
    const [git, processes, ports, docker, locks, filesystem] =
        await Promise.all([
            repositoryRecords(config.repositories),
            processRecords([
                config.stateRoot,
                ...config.repositories.map(({ root }) => root)
            ]),
            portRecords(),
            dockerRecords(),
            lockRecords(),
            filesystemRecords(config)
        ])
    const frozenAt = new Date().toISOString()
    return seal({
        schema: 'issue-orchestration.quiescence-baseline.v1',
        runId: config.runId,
        frozenAt,
        machineId: config.machineId,
        resourceDigest: digest({
            git: git.records,
            processes: processes.records,
            ports: ports.records,
            docker: docker.records,
            locks: locks.records,
            filesystem: filesystem.records
        }),
        collectorSideEffectCount: 0
    }, 'baselineDigest')
}

export async function collectQuiescenceObservation(config) {
    assertConfig(config)
    if (config.baseline?.runId !== config.runId) {
        fail('collector-baseline-binding')
    }
    const collectedAt = new Date().toISOString()
    const [git, processes, ports, docker, locks, filesystem] =
        await Promise.all([
            repositoryRecords(config.repositories),
            processRecords([
                config.stateRoot,
                ...config.repositories.map(({ root }) => root)
            ]),
            portRecords(),
            dockerRecords(),
            lockRecords(),
            filesystemRecords(config)
        ])
    const live = { git, processes, ports, docker, locks, filesystem }
    const inventories = {}
    for (const name of QUIESCENCE_INVENTORY_NAMES) {
        const collected = live[name] ?? {
            observable: true,
            records: emptyInventoryRecord(name, config)
        }
        inventories[name] = inventory({
            records: collected.records,
            collectionMethod: live[name]
                ? 'read-only-live-machine-observation'
                : 'read-only-bound-state-domain-observation',
            collectedAt,
            machineId: config.machineId,
            observable: collected.observable
        })
    }

    const collector = seal({
        schema:
            'issue-orchestration.quiescence-observation-collector.v1',
        status: 'collected',
        runId: config.runId,
        machineId: config.machineId,
        staticFixtureUsed: false,
        cleanupPerformed: false,
        stateMutationCount: 0,
        inventoryNames: QUIESCENCE_INVENTORY_NAMES,
        baselineDigest: config.baseline.baselineDigest,
        collectedAt
    }, 'receiptDigest')
    const observation = {
        schema: 'issue-orchestration.quiescence-observation.v1',
        runId: config.runId,
        verifiedAt: collectedAt,
        machineId: config.machineId,
        baseline: structuredClone(config.baseline),
        collector,
        selectorScope: structuredClone(config.selectorScope ?? []),
        allowedRetention: structuredClone(config.allowedRetention ?? []),
        inventories
    }
    observation.observationDigest = digest(observation)
    return verifyCollectedObservation(observation)
}

export function verifyCollectedObservation(observation) {
    if (observation?.schema !==
            'issue-orchestration.quiescence-observation.v1'
        || observation.collector?.schema !==
            'issue-orchestration.quiescence-observation-collector.v1'
        || observation.collector.staticFixtureUsed !== false
        || observation.collector.cleanupPerformed !== false
        || observation.collector.stateMutationCount !== 0) {
        fail('collector-observation-invalid')
    }
    const names = Object.keys(observation.inventories ?? {})
    if (!sameValue([...names].sort(), [...QUIESCENCE_INVENTORY_NAMES].sort())) {
        fail('collector-inventory-incomplete')
    }
    for (const name of QUIESCENCE_INVENTORY_NAMES) {
        const value = observation.inventories[name]
        if (value?.observable !== true) {
            fail('collector-inventory-unobservable', name)
        }
        const expectedSummary = summarize(value.records ?? [])
        if (!sameValue(value.summary, expectedSummary)) {
            fail('collector-summary-not-recomputable', name)
        }
        const unsigned = structuredClone(value)
        delete unsigned.sourceDigest
        if (value.sourceDigest !== digest(unsigned)) {
            fail('collector-source-digest-mismatch', name)
        }
    }
    const unsignedObservation = structuredClone(observation)
    delete unsignedObservation.observationDigest
    if (observation.observationDigest !== digest(unsignedObservation)) {
        fail('collector-observation-digest-mismatch')
    }
    return Object.freeze(structuredClone(observation))
}
