import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CompletedPrerequisiteError,
  fingerprint,
  validateCompletedPrerequisites
} from '../../skills/issue-orchestration/scripts/completed-prerequisite-validator.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const controls = JSON.parse(fs.readFileSync(
  path.join(root, 'tests/fixtures/issue-orchestration/completed-prerequisite-mutation-controls.json'),
  'utf8'
)).controls
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-prerequisite-'))

after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 0, `${commandName} ${args.join(' ')}\n${result.stderr}`)
  return result.stdout.trim()
}

function createRepository(name, defaultBranch) {
  const repository = path.join(fixtureRoot, name)
  fs.mkdirSync(repository, { recursive: true })
  command('git', ['init', '--initial-branch', defaultBranch, repository], root)
  command('git', ['config', 'user.name', 'Prerequisite Test'], repository)
  command('git', ['config', 'user.email', 'prerequisite@example.invalid'], repository)
  fs.writeFileSync(path.join(repository, 'delivered.txt'), `${name}\n`)
  command('git', ['add', 'delivered.txt'], repository)
  command('git', ['commit', '-m', 'delivered'], repository)
  const deliveredCommit = command('git', ['rev-parse', 'HEAD'], repository)
  command('git', ['switch', '-c', 'unreachable'], repository)
  fs.writeFileSync(path.join(repository, 'unreachable.txt'), 'not delivered\n')
  command('git', ['add', 'unreachable.txt'], repository)
  command('git', ['commit', '-m', 'unreachable'], repository)
  const unreachableCommit = command('git', ['rev-parse', 'HEAD'], repository)
  command('git', ['switch', defaultBranch], repository)
  return { defaultBranch, deliveredCommit, name, path: fs.realpathSync(repository), unreachableCommit }
}

const repositoriesByName = {
  RepositoryA: createRepository('RepositoryA', 'master'),
  RepositoryB: createRepository('RepositoryB', 'main')
}

function repositoryFacts() {
  return Object.values(repositoriesByName).map(({ defaultBranch, name, path: repositoryPath }) => ({
    defaultBranch,
    name,
    path: repositoryPath
  }))
}

function completionEvidence(repository, issueNumber) {
  return {
    schema: 'issue-orchestration.completion-evidence.v1',
    sourceId: `${repository.toLowerCase()}-${issueNumber}`,
    sourceType: 'verified-completion-receipt',
    verifiedChecks: [{ command: 'focused acceptance', outcome: 'passed' }]
  }
}

function observation(repository, issueNumber) {
  const repo = repositoriesByName[repository]
  const completion = completionEvidence(repository, issueNumber)
  return {
    closedAt: '2026-01-01T10:00:00Z',
    completionEvidence: completion,
    deliveredCommit: repo.deliveredCommit,
    dependencyKey: `${repository}#${issueNumber}`,
    evidenceDigest: fingerprint(completion),
    issue: `${repository}#${issueNumber}`,
    issueNumber,
    remoteDefaultBranch: repo.defaultBranch,
    remoteState: 'CLOSED',
    repository,
    stateReason: 'completed',
    verifiedAt: '2026-01-01T11:00:00Z'
  }
}

function tombstone(source) {
  return Object.fromEntries([
    'closedAt', 'deliveredCommit', 'evidenceDigest', 'issue', 'issueNumber',
    'remoteDefaultBranch', 'remoteState', 'repository', 'stateReason', 'verifiedAt'
  ].map((key) => [key, source[key]]))
}

function activeFixture({
  dependentRepository = 'RepositoryA',
  dependentNumber = 2001,
  prerequisiteRepository = 'RepositoryA',
  prerequisiteNumber = 1700
} = {}) {
  const dependency = `${prerequisiteRepository}#${prerequisiteNumber}`
  return {
    activeAttempts: [],
    nodes: [
      {
        id: `${dependentRepository}#${dependentNumber}`,
        activeDependencies: [dependency],
        dependencyKeys: [dependency],
        satisfiedDependencies: []
      },
      {
        id: dependency,
        activeDependencies: [],
        dependencyKeys: [],
        satisfiedDependencies: []
      }
    ],
    prerequisiteObservations: [],
    readyFrontier: [],
    refreshedAt: '2026-01-02T00:00:00Z',
    repositories: repositoryFacts()
  }
}

function satisfiedFixture({
  dependentRepository = 'RepositoryA',
  dependentNumber = 2001,
  prerequisiteRepository = 'RepositoryA',
  prerequisiteNumber = 1700
} = {}) {
  const remote = observation(prerequisiteRepository, prerequisiteNumber)
  return {
    activeAttempts: [],
    nodes: [{
      id: `${dependentRepository}#${dependentNumber}`,
      activeDependencies: [],
      dependencyKeys: [remote.dependencyKey],
      satisfiedDependencies: [tombstone(remote)]
    }],
    prerequisiteObservations: [remote],
    readyFrontier: [`${dependentRepository}#${dependentNumber}`],
    refreshedAt: '2026-01-02T00:00:00Z',
    repositories: repositoryFacts()
  }
}

function clone(value) {
  return structuredClone(value)
}

function accepted(fixture, expectedCodes) {
  const result = validateCompletedPrerequisites(fixture)
  assert.equal(result.valid, true)
  assert.deepEqual(
    result.dependencyResolutions.map((entry) => entry.code).sort(),
    [...expectedCodes].sort()
  )
  return result
}

function rejected(fixture, expectedCode) {
  assert.throws(
    () => validateCompletedPrerequisites(fixture),
    (error) => error instanceof CompletedPrerequisiteError && error.code === expectedCode
  )
}

const mutations = {
  'remote-reopened': (fixture) => {
    fixture.prerequisiteObservations[0].remoteState = 'OPEN'
    fixture.prerequisiteObservations[0].stateReason = null
  },
  'closed-not-planned': (fixture) => {
    fixture.prerequisiteObservations[0].stateReason = 'not_planned'
    fixture.nodes[0].satisfiedDependencies[0].stateReason = 'not_planned'
  },
  'duplicate-without-substitute': (fixture) => {
    fixture.prerequisiteObservations[0].disposition = 'duplicate'
    fixture.prerequisiteObservations[0].stateReason = 'not_planned'
    fixture.nodes[0].satisfiedDependencies[0].stateReason = 'not_planned'
  },
  'delivered-commit-missing': (fixture) => {
    delete fixture.prerequisiteObservations[0].deliveredCommit
    delete fixture.nodes[0].satisfiedDependencies[0].deliveredCommit
  },
  'delivered-commit-unreachable': (fixture) => {
    const unreachable = repositoriesByName.RepositoryA.unreachableCommit
    fixture.prerequisiteObservations[0].deliveredCommit = unreachable
    fixture.nodes[0].satisfiedDependencies[0].deliveredCommit = unreachable
  },
  'evidence-digest-mismatch': (fixture) => {
    fixture.nodes[0].satisfiedDependencies[0].evidenceDigest = 'f'.repeat(64)
  },
  'evidence-payload-tampered': (fixture) => {
    fixture.prerequisiteObservations[0].completionEvidence.verifiedChecks[0].outcome = 'failed'
  },
  'dependency-identity-mismatch': (fixture) => {
    fixture.nodes[0].satisfiedDependencies[0].issue = 'RepositoryA#1701'
  },
  'active-satisfied-overlap': (fixture) => {
    fixture.nodes[0].activeDependencies = ['RepositoryA#1700']
  },
  'dependency-edge-deleted': (fixture) => {
    fixture.nodes[0].satisfiedDependencies = []
  },
  'duplicate-tombstone': (fixture) => {
    fixture.nodes[0].satisfiedDependencies.push(clone(fixture.nodes[0].satisfiedDependencies[0]))
  },
  'wrong-repository': (fixture) => {
    fixture.nodes[0].satisfiedDependencies[0].repository = 'RepositoryB'
  },
  'wrong-issue-number': (fixture) => {
    fixture.nodes[0].satisfiedDependencies[0].issueNumber = 1701
  },
  'short-delivered-commit': (fixture) => {
    fixture.nodes[0].satisfiedDependencies[0].deliveredCommit =
      repositoriesByName.RepositoryA.deliveredCommit.slice(0, 12)
  },
  'wrong-default-branch': (fixture) => {
    fixture.nodes[0].satisfiedDependencies[0].remoteDefaultBranch = 'main'
  },
  'future-closed-at': (fixture) => {
    fixture.prerequisiteObservations[0].closedAt = '2026-01-03T00:00:00Z'
    fixture.nodes[0].satisfiedDependencies[0].closedAt = '2026-01-03T00:00:00Z'
  },
  'completion-evidence-missing': (fixture) => {
    delete fixture.prerequisiteObservations[0].completionEvidence
  },
  'unknown-dependency': (fixture) => {
    fixture.nodes[0].dependencyKeys = ['RepositoryA#9999']
    fixture.nodes[0].satisfiedDependencies = []
    fixture.prerequisiteObservations = []
  },
  'closed-prerequisite-in-active-nodes': (fixture) => {
    fixture.nodes.push({
      id: 'RepositoryA#1700',
      activeDependencies: [],
      dependencyKeys: [],
      satisfiedDependencies: []
    })
  },
  'closed-prerequisite-in-frontier': (fixture) => {
    fixture.readyFrontier.push('RepositoryA#1700')
  },
  'closed-prerequisite-has-attempt': (fixture) => {
    fixture.activeAttempts.push({ issue: 'RepositoryA#1700', slot: 'slot-02' })
  }
}

test('active prerequisites resolve to active nodes', () => {
  accepted(activeFixture(), ['dependency-active'])
})

for (const scenario of [
  {},
  { dependentRepository: 'RepositoryB', dependentNumber: 3001, prerequisiteRepository: 'RepositoryB', prerequisiteNumber: 260 },
  { dependentRepository: 'RepositoryA', dependentNumber: 2002, prerequisiteRepository: 'RepositoryB', prerequisiteNumber: 260 }
]) {
  test(`completed prerequisite preserves dependency edge ${sha256(JSON.stringify(scenario)).slice(0, 8)}`, () => {
    const before = activeFixture(scenario)
    const after = satisfiedFixture(scenario)
    assert.equal(before.nodes[0].dependencyKeys[0], after.nodes[0].dependencyKeys[0])
    accepted(before, ['dependency-active'])
    const result = accepted(after, ['dependency-satisfied'])
    assert.equal(result.closedPrerequisiteCount, 1)
  })
}

test('completed prerequisite is not an executable node, frontier member, or active attempt', () => {
  const fixture = satisfiedFixture()
  assert.deepEqual(fixture.nodes.map((node) => node.id), ['RepositoryA#2001'])
  accepted(fixture, ['dependency-satisfied'])
})

test('mutation catalog and executable controls are exact-set equal', () => {
  assert.deepEqual(Object.keys(mutations).sort(), controls.map((control) => control.id).sort())
  assert.equal(new Set(controls.map((control) => control.id)).size, controls.length)
})

for (const control of controls) {
  test(`MUTATION ${control.id} is rejected with ${control.expectedCode}`, () => {
    const fixture = satisfiedFixture()
    mutations[control.id](fixture)
    rejected(fixture, control.expectedCode)
  })
}
