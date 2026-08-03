import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const gate = path.join(
  root,
  'skills/issue-orchestration/scripts/check-dag-gate.mjs'
)
const controls = JSON.parse(fs.readFileSync(
  path.join(
    root,
    'tests/fixtures/issue-orchestration/completed-prerequisite-mutation-controls.json'
  ),
  'utf8'
)).controls
const contractDigest = 'c'.repeat(64)
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'fsusblog-completed-prerequisite-')
)
const workspace = path.join(fixtureRoot, 'workspace')
const statesRoot = path.join(fixtureRoot, 'states')

fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(statesRoot, { recursive: true })

after(() => {
  fs.rmSync(fixtureRoot, { force: true, recursive: true })
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])])
  )
}

function fingerprint(value) {
  return sha256(JSON.stringify(normalizeJson(value)))
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    timeout: 15_000
  })
  assert.equal(
    result.status,
    options.expectedStatus ?? 0,
    `${commandName} ${args.join(' ')}\n${result.stderr}`
  )
  return result.stdout.trim()
}

function createRepository(name, defaultBranch) {
  const repository = path.join(fixtureRoot, 'repositories', name)
  fs.mkdirSync(repository, { recursive: true })
  command('git', ['init', '--initial-branch', defaultBranch, repository])
  command('git', ['config', 'user.name', 'Tombstone Test'], { cwd: repository })
  command(
    'git',
    ['config', 'user.email', 'tombstone-test@example.invalid'],
    { cwd: repository }
  )
  command(
    'git',
    ['remote', 'add', 'origin', `https://github.test/Ozwasyd/${name}.git`],
    { cwd: repository }
  )
  fs.writeFileSync(path.join(repository, 'delivered.txt'), `${name} delivered\n`)
  command('git', ['add', 'delivered.txt'], { cwd: repository })
  command('git', ['commit', '-m', 'delivered prerequisite'], { cwd: repository })
  const deliveredCommit = command('git', ['rev-parse', 'HEAD'], { cwd: repository })

  command('git', ['switch', '-c', 'unreachable-evidence'], { cwd: repository })
  fs.writeFileSync(path.join(repository, 'refs-only.txt'), 'Refs #1700\n')
  command('git', ['add', 'refs-only.txt'], { cwd: repository })
  command('git', ['commit', '-m', 'Refs #1700'], { cwd: repository })
  const unreachableCommit = command('git', ['rev-parse', 'HEAD'], { cwd: repository })
  command('git', ['switch', defaultBranch], { cwd: repository })

  return {
    defaultBranch,
    deliveredCommit,
    name,
    path: fs.realpathSync(repository),
    remote: `https://github.test/Ozwasyd/${name}.git`,
    unreachableCommit
  }
}

const repositories = {
  FsusBlog: createRepository('FsusBlog', 'master'),
  FsusUI: createRepository('FsusUI', 'main')
}

function repositoryFacts() {
  return Object.values(repositories)
    .map((repository) => ({
      defaultBranch: repository.defaultBranch,
      dirtyFingerprint: sha256(''),
      headSha: repository.deliveredCommit,
      name: repository.name,
      path: repository.path,
      remote: repository.remote
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function openIssue(repository, number) {
  return {
    commentsFingerprint: sha256(`${repository}#${number}:comments`),
    number,
    repository,
    state: 'OPEN',
    updatedAt: '2026-01-01T12:00:00Z'
  }
}

function nodeFor(issue, {
  activeDependencies = [],
  dependencyKeys = [],
  satisfiedDependencies = [],
  status = 'investigated'
} = {}) {
  const id = `${issue.repository}#${issue.number}`
  return {
    acceptanceGroup: 'completed-prerequisite',
    activeDependencies,
    commentsFingerprint: issue.commentsFingerprint,
    dependencyKeys,
    difficultyBand: 'hard-to-extreme',
    effort: 'max',
    id,
    investigation: {
      checkedAt: '2026-01-01T12:30:00Z',
      codePaths: [
        'skills/issue-orchestration/scripts/check-dag-gate.mjs'
      ],
      constraints: ['completed prerequisites remain auditable'],
      currentDocs: [
        'skills/issue-orchestration/references/dag-and-scheduling.md'
      ],
      testPaths: [
        'tests/tools/issue-orchestration-completed-prerequisite.test.mjs'
      ]
    },
    issueNumber: issue.number,
    issueUpdatedAt: issue.updatedAt,
    model: 'gpt-5.6-sol',
    ownerRepository: issue.repository,
    repository: issue.repository,
    reworkCount: 0,
    satisfiedDependencies,
    status
  }
}

function completionEvidence(repository, issueNumber) {
  return {
    schema: 'issue-orchestration.completion-evidence.v1',
    sourceId: `${repository.toLowerCase()}-${issueNumber}-completion`,
    sourceType: 'verified-completion-receipt',
    sourceUrl: `https://github.test/Ozwasyd/${repository}/issues/${issueNumber}#completion`,
    verifiedChecks: [
      {
        command: 'focused acceptance',
        outcome: 'passed'
      }
    ]
  }
}

function closedObservation(repository, issueNumber) {
  const repo = repositories[repository]
  const evidence = completionEvidence(repository, issueNumber)
  return {
    closedAt: '2026-01-01T10:00:00Z',
    completionEvidence: evidence,
    deliveredCommit: repo.deliveredCommit,
    dependencyKey: `${repository}#${issueNumber}`,
    evidenceDigest: fingerprint(evidence),
    issue: `${repository}#${issueNumber}`,
    issueNumber,
    remoteDefaultBranch: repo.defaultBranch,
    remoteState: 'CLOSED',
    repository,
    stateReason: 'completed',
    verifiedAt: '2026-01-01T11:00:00Z'
  }
}

function tombstoneFrom(observation) {
  return {
    closedAt: observation.closedAt,
    deliveredCommit: observation.deliveredCommit,
    evidenceDigest: observation.evidenceDigest,
    issue: observation.issue,
    issueNumber: observation.issueNumber,
    remoteDefaultBranch: observation.remoteDefaultBranch,
    remoteState: observation.remoteState,
    repository: observation.repository,
    stateReason: observation.stateReason,
    verifiedAt: observation.verifiedAt
  }
}

function stageReceipts(candidateSha, remoteSnapshotDigest) {
  const common = {
    candidateSha,
    remoteSnapshotDigest,
    testContractDigest: contractDigest
  }
  const behavior = {
    ...common,
    actorId: 'test-owner-1',
    phase: 'behavior-verification',
    sequence: 40,
    stageRole: 'test-owner',
    status: 'passed'
  }
  return {
    behavior,
    dispatch: {
      ...common,
      action: 'dispatch',
      actorId: 'root-scheduler-1',
      effort: 'low',
      model: 'gpt-5.6-sol',
      sequence: 20,
      stageRole: 'root-scheduler'
    },
    documentation: {
      ...common,
      action: 'documentation',
      behaviorReceiptDigest: fingerprint(behavior),
      sequence: 50,
      stageRole: 'documentation-writer'
    },
    implementation: {
      ...common,
      actorId: 'code-implementer-1',
      allowedWriteClasses: ['schema', 'generator', 'validator'],
      changedPaths: [
        'skills/issue-orchestration/scripts/check-dag-gate.mjs'
      ],
      effort: 'low',
      model: 'gpt-5.6-sol',
      sequence: 30,
      stageRole: 'code-implementer'
    },
    proposal: {
      ...common,
      actorId: 'dag-updater-1',
      directWrites: [],
      effort: 'max',
      freshContext: true,
      mode: 'read-only',
      model: 'gpt-5.6-sol',
      previousRemoteSnapshotDigest: '0'.repeat(64),
      proposalOnly: true,
      sequence: 10,
      spawnedByStageRole: 'root-scheduler',
      stageRole: 'dag-updater',
      trigger: 'remote-live-snapshot-digest-changed'
    },
    testContract: {
      ...common,
      actorId: 'test-owner-1',
      allowedWriteClasses: [
        'tests',
        'fixtures',
        'runtime-probes',
        'mutation-controls',
        'acceptance-mapping'
      ],
      effort: 'max',
      model: 'gpt-5.6-sol',
      sequence: 15,
      stageRole: 'test-owner'
    },
    verification: {
      ...common,
      actorId: 'test-owner-1',
      phase: 'verification',
      sequence: 35,
      stageRole: 'test-owner'
    }
  }
}

function activeSnapshotFingerprint(snapshot) {
  return fingerprint(
    [...snapshot.issues].sort((left, right) =>
      `${left.repository}#${left.number}`.localeCompare(
        `${right.repository}#${right.number}`
      )
    )
  )
}

function remoteSnapshotDigest(snapshot) {
  return fingerprint({
    issues: [...snapshot.issues].sort((left, right) =>
      `${left.repository}#${left.number}`.localeCompare(
        `${right.repository}#${right.number}`
      )
    ),
    prerequisiteObservations: [...snapshot.prerequisiteObservations].sort(
      (left, right) => left.dependencyKey.localeCompare(right.dependencyKey)
    )
  })
}

function finalizeFixture(fixture) {
  fixture.snapshot.remoteSnapshotDigest = remoteSnapshotDigest(fixture.snapshot)
  fixture.dag.issueSnapshotFingerprint = activeSnapshotFingerprint(fixture.snapshot)
  fixture.dag.remoteSnapshotDigest = fixture.snapshot.remoteSnapshotDigest
  fixture.dag.repositoryFingerprint = fingerprint(repositoryFacts())
  fixture.dag.consistency = {
    issueSnapshotFingerprint: fixture.dag.issueSnapshotFingerprint,
    remoteSnapshotDigest: fixture.dag.remoteSnapshotDigest,
    repositoryFingerprint: fixture.dag.repositoryFingerprint,
    status: 'passed',
    validatedAt: '2026-01-02T00:00:00Z'
  }
  for (const receipt of Object.values(fixture.dag.stageReceipts)) {
    receipt.remoteSnapshotDigest = fixture.dag.remoteSnapshotDigest
  }
  fixture.dag.stageReceipts.documentation.behaviorReceiptDigest = fingerprint(
    fixture.dag.stageReceipts.behavior
  )
  return fixture
}

function baseDag(snapshot, nodes, ownerRepository) {
  const liveFacts = repositoryFacts()
  const candidateSha = repositories[ownerRepository].deliveredCommit
  const snapshotDigest = remoteSnapshotDigest(snapshot)
  return {
    acceptanceGroups: [
      {
        id: 'completed-prerequisite',
        nodes: nodes.map((node) => node.id)
      }
    ],
    activeAttempts: [],
    readyFrontier: nodes
      .filter((node) => node.status === 'ready')
      .map((node) => node.id),
    refreshedAt: '2026-01-02T00:00:00Z',
    repositories: liveFacts.map((repository) => ({
      ...repository,
      baseSha: repository.headSha
    })),
    repositoryFingerprint: fingerprint(liveFacts),
    runId: 'completed-prerequisite-contract',
    runtimeFiles: {
      evidence: 'runtime/evidence',
      issueState: 'runtime/issues.json',
      ledger: 'runtime/ledger.jsonl',
      locks: 'runtime/locks',
      recoveryFingerprints: 'runtime/recovery.json',
      slots: 'runtime/slots.json'
    },
    schema: 'issue-orchestration.dag.v2',
    stageReceipts: stageReceipts(candidateSha, snapshotDigest),
    stateRootCanonical: null,
    subagentCapacityEvidence: 'fixture capacity=2',
    subagentSlotsConfigured: 15,
    subagentSlotsEffective: 2,
    testContractDigest: contractDigest,
    nodes
  }
}

function satisfiedFixture({
  dependentNumber = 2001,
  dependentRepository = 'FsusBlog',
  prerequisiteNumber = 1700,
  prerequisiteRepository = 'FsusBlog'
} = {}) {
  const dependent = openIssue(dependentRepository, dependentNumber)
  const observation = closedObservation(
    prerequisiteRepository,
    prerequisiteNumber
  )
  const dependencyKey = observation.dependencyKey
  const snapshot = {
    issues: [dependent],
    prerequisiteObservations: [observation],
    refreshedAt: '2026-01-02T00:00:00Z',
    schema: 'issue-orchestration.issue-snapshot.v1'
  }
  const nodes = [
    nodeFor(dependent, {
      dependencyKeys: [dependencyKey],
      satisfiedDependencies: [tombstoneFrom(observation)],
      status: 'ready'
    })
  ]
  return finalizeFixture({
    dag: baseDag(snapshot, nodes, dependentRepository),
    snapshot
  })
}

function activeFixture({
  dependentNumber = 2001,
  dependentRepository = 'FsusBlog',
  prerequisiteNumber = 1700,
  prerequisiteRepository = 'FsusBlog'
} = {}) {
  const dependent = openIssue(dependentRepository, dependentNumber)
  const prerequisite = openIssue(
    prerequisiteRepository,
    prerequisiteNumber
  )
  const dependencyKey = `${prerequisiteRepository}#${prerequisiteNumber}`
  const snapshot = {
    issues: [dependent, prerequisite],
    prerequisiteObservations: [],
    refreshedAt: '2026-01-02T00:00:00Z',
    schema: 'issue-orchestration.issue-snapshot.v1'
  }
  const nodes = [
    nodeFor(dependent, {
      activeDependencies: [dependencyKey],
      dependencyKeys: [dependencyKey]
    }),
    nodeFor(prerequisite)
  ]
  return finalizeFixture({
    dag: baseDag(snapshot, nodes, dependentRepository),
    snapshot
  })
}

function clone(value) {
  return structuredClone(value)
}

function writeFixture(fixture, id) {
  const stateRoot = path.join(
    statesRoot,
    `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  fixture.dag.stateRootCanonical = fs.realpathSync(stateRoot)
  const snapshotPath = path.join(stateRoot, 'issue-snapshot.json')
  const dagPath = path.join(stateRoot, 'dag.json')
  fs.writeFileSync(snapshotPath, `${JSON.stringify(fixture.snapshot, null, 2)}\n`)
  fs.writeFileSync(dagPath, `${JSON.stringify(fixture.dag, null, 2)}\n`)
  return { dagPath, snapshotPath, stateRoot }
}

function runGate(fixture, id) {
  const files = writeFixture(fixture, id)
  const result = spawnSync(process.execPath, [
    gate,
    '--state-root', files.stateRoot,
    '--dag', files.dagPath,
    '--issues-snapshot', files.snapshotPath,
    '--repository', `FsusBlog=${repositories.FsusBlog.path}`,
    '--repository', `FsusUI=${repositories.FsusUI.path}`,
    '--default-branch', 'FsusBlog=master',
    '--default-branch', 'FsusUI=main',
    '--workspace', workspace,
    '--startup-time', '2026-01-01T00:00:00Z'
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000
  })
  const source = result.status === 0 ? result.stdout : result.stderr
  let payload
  try {
    payload = JSON.parse(source)
  } catch {
    assert.fail(`gate did not emit JSON for ${id}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
  return {
    payload,
    status: result.status
  }
}

function assertAccepted(fixture, id, expectedResolutionCodes) {
  const result = runGate(fixture, id)
  assert.equal(result.status, 0, JSON.stringify(result.payload, null, 2))
  assert.equal(result.payload.valid, true)
  assert.equal(result.payload.dispatchEnabled, true)
  assert.deepEqual(
    result.payload.dependencyResolutions.map((entry) => entry.code).sort(),
    [...expectedResolutionCodes].sort()
  )
  return result.payload
}

function assertRejected(fixture, id, expectedCode) {
  const result = runGate(fixture, id)
  assert.equal(result.status, 2, JSON.stringify(result.payload, null, 2))
  assert.equal(result.payload.valid, false)
  assert.equal(result.payload.dispatchEnabled, false)
  assert.equal(result.payload.code, expectedCode)
}

function legacyFixture({ placeholder = false } = {}) {
  const source = satisfiedFixture()
  const node = clone(source.dag.nodes[0])
  node.dependencies = placeholder ? ['FsusBlog#1700'] : []
  delete node.activeDependencies
  delete node.dependencyKeys
  if (!placeholder) delete node.satisfiedDependencies
  if (placeholder) node.satisfiedDependencies = [{ status: 'closed' }]
  source.dag.schema = 'issue-orchestration.dag.v1'
  source.dag.nodes = [node]
  source.dag.acceptanceGroups[0].nodes = [node.id]
  delete source.dag.activeAttempts
  delete source.dag.readyFrontier
  delete source.dag.remoteSnapshotDigest
  delete source.dag.stageReceipts
  delete source.dag.testContractDigest
  source.snapshot.prerequisiteObservations = []
  delete source.snapshot.remoteSnapshotDigest
  source.dag.issueSnapshotFingerprint = activeSnapshotFingerprint(source.snapshot)
  source.dag.consistency.issueSnapshotFingerprint =
    source.dag.issueSnapshotFingerprint
  delete source.dag.consistency.remoteSnapshotDigest
  return source
}

const mutations = {
  'remote-reopened': (fixture) => {
    fixture.snapshot.prerequisiteObservations[0].remoteState = 'OPEN'
    fixture.snapshot.prerequisiteObservations[0].stateReason = null
  },
  'closed-not-planned': (fixture) => {
    fixture.snapshot.prerequisiteObservations[0].stateReason = 'not_planned'
    fixture.dag.nodes[0].satisfiedDependencies[0].stateReason = 'not_planned'
  },
  'duplicate-without-substitute': (fixture) => {
    fixture.snapshot.prerequisiteObservations[0].disposition = 'duplicate'
    fixture.snapshot.prerequisiteObservations[0].stateReason = 'not_planned'
    fixture.dag.nodes[0].satisfiedDependencies[0].disposition = 'duplicate'
    fixture.dag.nodes[0].satisfiedDependencies[0].stateReason = 'not_planned'
  },
  'delivered-commit-missing': (fixture) => {
    delete fixture.snapshot.prerequisiteObservations[0].deliveredCommit
    delete fixture.dag.nodes[0].satisfiedDependencies[0].deliveredCommit
  },
  'delivered-commit-unreachable': (fixture) => {
    const unreachable = repositories.FsusBlog.unreachableCommit
    fixture.snapshot.prerequisiteObservations[0].deliveredCommit = unreachable
    fixture.dag.nodes[0].satisfiedDependencies[0].deliveredCommit = unreachable
  },
  'evidence-digest-mismatch': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies[0].evidenceDigest = 'f'.repeat(64)
  },
  'evidence-payload-tampered': (fixture) => {
    fixture.snapshot.prerequisiteObservations[0]
      .completionEvidence.verifiedChecks[0].outcome = 'failed'
  },
  'dependency-identity-mismatch': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies[0].issue = 'FsusBlog#1701'
  },
  'active-satisfied-overlap': (fixture) => {
    fixture.dag.nodes[0].activeDependencies = ['FsusBlog#1700']
  },
  'dependency-edge-deleted': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies = []
  },
  'duplicate-tombstone': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies.push(
      clone(fixture.dag.nodes[0].satisfiedDependencies[0])
    )
  },
  'wrong-repository': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies[0].repository = 'FsusUI'
  },
  'wrong-issue-number': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies[0].issueNumber = 1701
  },
  'short-delivered-commit': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies[0].deliveredCommit =
      repositories.FsusBlog.deliveredCommit.slice(0, 12)
  },
  'wrong-default-branch': (fixture) => {
    fixture.dag.nodes[0].satisfiedDependencies[0].remoteDefaultBranch = 'main'
  },
  'future-closed-at': (fixture) => {
    fixture.snapshot.prerequisiteObservations[0].closedAt =
      '2026-01-03T00:00:00Z'
    fixture.dag.nodes[0].satisfiedDependencies[0].closedAt =
      '2026-01-03T00:00:00Z'
  },
  'completion-evidence-missing': (fixture) => {
    delete fixture.snapshot.prerequisiteObservations[0].completionEvidence
  },
  'unknown-dependency': (fixture) => {
    fixture.dag.nodes[0].dependencyKeys = ['FsusBlog#9999']
    fixture.dag.nodes[0].satisfiedDependencies = []
    fixture.snapshot.prerequisiteObservations = []
  },
  'closed-prerequisite-in-active-nodes': (fixture) => {
    const closed = clone(fixture.dag.nodes[0])
    closed.id = 'FsusBlog#1700'
    closed.issueNumber = 1700
    closed.activeDependencies = []
    closed.dependencyKeys = []
    closed.satisfiedDependencies = []
    fixture.dag.nodes.push(closed)
    fixture.dag.acceptanceGroups[0].nodes.push(closed.id)
  },
  'closed-prerequisite-in-frontier': (fixture) => {
    fixture.dag.readyFrontier.push('FsusBlog#1700')
  },
  'closed-prerequisite-has-attempt': (fixture) => {
    fixture.dag.activeAttempts.push({
      issue: 'FsusBlog#1700',
      slot: 'slot-02'
    })
  },
  'root-authored-tombstone': (fixture) => {
    fixture.dag.stageReceipts.proposal.stageRole = 'root-scheduler'
  },
  'non-root-spawns-dag-updater': (fixture) => {
    fixture.dag.stageReceipts.proposal.spawnedByStageRole = 'code-implementer'
  },
  'dag-updater-direct-write': (fixture) => {
    fixture.dag.stageReceipts.proposal.directWrites = ['dag.json']
  },
  'local-event-refresh-trigger': (fixture) => {
    fixture.dag.stageReceipts.proposal.trigger = 'local-execution-event'
  },
  'test-owner-implementer-same-actor': (fixture) => {
    fixture.dag.stageReceipts.implementation.actorId =
      fixture.dag.stageReceipts.testContract.actorId
  },
  'implementer-modifies-frozen-test': (fixture) => {
    fixture.dag.stageReceipts.implementation.changedPaths.push(
      'tests/tools/issue-orchestration-completed-prerequisite.test.mjs'
    )
  },
  'dispatch-stage-role-missing': (fixture) => {
    delete fixture.dag.stageReceipts.dispatch.stageRole
  },
  'verification-candidate-sha-drift': (fixture) => {
    fixture.dag.stageReceipts.verification.candidateSha = 'f'.repeat(40)
  },
  'dispatch-remote-snapshot-drift': (fixture) => {
    fixture.dag.stageReceipts.dispatch.remoteSnapshotDigest = 'f'.repeat(64)
  },
  'verification-test-contract-drift': (fixture) => {
    fixture.dag.stageReceipts.verification.testContractDigest = 'f'.repeat(64)
  },
  'documentation-before-behavior-green': (fixture) => {
    fixture.dag.stageReceipts.behavior.status = 'failed'
  },
  'root-runtime-identity-drift': (fixture) => {
    fixture.dag.stageReceipts.dispatch.effort = 'max'
  },
  'dag-updater-runtime-identity-drift': (fixture) => {
    fixture.dag.stageReceipts.proposal.effort = 'low'
  },
  'test-owner-runtime-identity-drift': (fixture) => {
    fixture.dag.stageReceipts.testContract.effort = 'low'
  },
  'implementer-runtime-identity-drift': (fixture) => {
    fixture.dag.stageReceipts.implementation.effort = 'max'
  }
}

test('P01 active dependencies resolve to active DAG nodes with a stable reason code', () => {
  assertAccepted(activeFixture(), 'active-dependency', ['dependency-active'])
})

for (const scenario of [
  {
    id: 'P02-fsusblog-open-to-closed',
    options: {}
  },
  {
    id: 'P03-fsusui-open-to-closed',
    options: {
      dependentNumber: 3001,
      dependentRepository: 'FsusUI',
      prerequisiteNumber: 260,
      prerequisiteRepository: 'FsusUI'
    }
  },
  {
    id: 'P04-cross-repository-closed-prerequisite',
    options: {
      dependentNumber: 2002,
      dependentRepository: 'FsusBlog',
      prerequisiteNumber: 260,
      prerequisiteRepository: 'FsusUI'
    }
  }
]) {
  test(`${scenario.id} preserves the edge while moving only its classification`, () => {
    const before = activeFixture(scenario.options)
    const after = satisfiedFixture(scenario.options)
    const dependencyKey = before.dag.nodes[0].dependencyKeys[0]
    assert.equal(after.dag.nodes[0].dependencyKeys[0], dependencyKey)
    assertAccepted(before, `${scenario.id}-before`, ['dependency-active'])
    const result = assertAccepted(
      after,
      `${scenario.id}-after`,
      ['dependency-satisfied']
    )
    assert.equal(result.nodeCount, 1)
    assert.equal(result.closedPrerequisiteCount, 1)
  })
}

test('P05 a completed prerequisite is not an execution node, frontier member, or attempt', () => {
  const fixture = satisfiedFixture()
  assert.deepEqual(fixture.snapshot.issues.map((issue) => issue.number), [2001])
  assert.deepEqual(fixture.dag.nodes.map((node) => node.id), ['FsusBlog#2001'])
  assert.deepEqual(fixture.dag.readyFrontier, ['FsusBlog#2001'])
  assert.deepEqual(fixture.dag.activeAttempts, [])
  assertAccepted(fixture, 'closed-is-not-executable', ['dependency-satisfied'])
})

test('P06 a valid role and receipt chain binds candidate, remote snapshot, and frozen tests', () => {
  const fixture = satisfiedFixture()
  const receipts = fixture.dag.stageReceipts
  assert.equal(receipts.dispatch.remoteSnapshotDigest, fixture.dag.remoteSnapshotDigest)
  assert.equal(receipts.verification.testContractDigest, contractDigest)
  assert.equal(receipts.testContract.actorId, receipts.verification.actorId)
  assert.notEqual(receipts.testContract.actorId, receipts.implementation.actorId)
  assertAccepted(fixture, 'valid-stage-receipts', ['dependency-satisfied'])
})

test('P07 a legacy v1 DAG is diagnostic-only and cannot dispatch even when internally valid', () => {
  assertRejected(
    legacyFixture(),
    'legacy-v1-valid',
    'dag-v1-rebuild-required'
  )
})

test('mutation catalog and executable controls are exact-set equal', () => {
  assert.deepEqual(
    Object.keys(mutations).sort(),
    controls
      .filter((control) => control.id !== 'legacy-v1-placeholder')
      .map((control) => control.id)
      .sort()
  )
  assert.equal(new Set(controls.map((control) => control.id)).size, controls.length)
})

for (const control of controls) {
  test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async (current) => {
    if (control.id === 'legacy-v1-placeholder') {
      assertRejected(
        legacyFixture({ placeholder: true }),
        control.id,
        control.expectedCode
      )
      return
    }

    if (control.id === 'remote-reopened') {
      for (const status of [
        'ready',
        'implementing',
        'review',
        'verifying',
        'deliverable'
      ]) {
        await current.test(status, () => {
          const fixture = satisfiedFixture()
          fixture.dag.nodes[0].status = status
          mutations[control.id](fixture)
          finalizeFixture(fixture)
          assertRejected(fixture, `${control.id}-${status}`, control.expectedCode)
        })
      }
      return
    }

    const fixture = satisfiedFixture()
    mutations[control.id](fixture)
    finalizeFixture(fixture)
    if (control.id === 'dispatch-remote-snapshot-drift') {
      fixture.dag.stageReceipts.dispatch.remoteSnapshotDigest = 'f'.repeat(64)
    }
    if (control.id === 'verification-candidate-sha-drift') {
      fixture.dag.stageReceipts.verification.candidateSha = 'f'.repeat(40)
    }
    if (control.id === 'verification-test-contract-drift') {
      fixture.dag.stageReceipts.verification.testContractDigest = 'f'.repeat(64)
    }
    assertRejected(fixture, control.id, control.expectedCode)
  })
}
