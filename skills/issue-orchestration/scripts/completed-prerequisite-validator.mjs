import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export class CompletedPrerequisiteError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CompletedPrerequisiteError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new CompletedPrerequisiteError(code, message, details)
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

export function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeJson(value)))
    .digest('hex')
}

function parseTimestamp(value, label) {
  const result = Date.parse(value)
  if (!Number.isFinite(result)) fail('invalid-timestamp', `${label} must be an RFC 3339 timestamp.`)
  return result
}

function issueKey(value) {
  return `${value.repository}#${value.issueNumber ?? value.number}`
}

function isAncestor(repositoryPath, commit, defaultBranch) {
  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', commit, defaultBranch],
    { cwd: repositoryPath, encoding: 'utf8', timeout: 15_000 }
  )
  if (result.status === 0) return true
  if (result.status === 1) return false
  fail('tombstone-delivered-commit-unreachable', 'Unable to verify delivered commit ancestry.', {
    stderr: result.stderr.trim()
  })
}

function validateObservation(observation, seen) {
  const key = observation?.dependencyKey
  if (typeof key !== 'string' || key.length === 0) {
    fail('dependency-unknown', 'A prerequisite observation lacks dependencyKey.')
  }
  if (seen.has(key)) fail('tombstone-duplicate', `Remote observations repeat ${key}.`)
  seen.add(key)
}

function validateSatisfiedDependency({
  node,
  tombstone,
  observationsByKey,
  repositoriesByName,
  refreshedAt
}) {
  const key = tombstone?.issue
  const declared = new Set(node.dependencyKeys)
  if (!declared.has(key)) {
    fail('tombstone-identity-mismatch', `Tombstone ${key ?? '<missing>'} does not match a declared dependency key.`)
  }
  const observation = observationsByKey.get(key)
  if (!observation) fail('dependency-unknown', `Node ${node.id} has an unobserved satisfied dependency ${key}.`)
  if (observation.remoteState !== 'CLOSED') fail('tombstone-remote-state-drift', `${key} is no longer closed.`)
  if (observation.disposition === 'duplicate') fail('tombstone-duplicate-disposition', `${key} is a duplicate without a valid substitute.`)
  if (observation.stateReason !== 'completed') fail('tombstone-state-reason', `${key} was not closed as completed.`)
  if (!observation.deliveredCommit) fail('tombstone-delivered-commit-missing', `${key} lacks a delivered commit.`)
  if (!observation.completionEvidence) fail('tombstone-completion-evidence-missing', `${key} lacks completion evidence.`)
  if (observation.evidenceDigest !== fingerprint(observation.completionEvidence)) {
    fail('tombstone-evidence-tampered', `${key} completion evidence has been tampered with.`)
  }
  if (tombstone.evidenceDigest !== observation.evidenceDigest) {
    fail('tombstone-evidence-digest-mismatch', `${key} evidence digest does not match the live observation.`)
  }
  if (key !== observation.dependencyKey) fail('tombstone-identity-mismatch', `${key} does not match its dependency key.`)
  if (tombstone.repository !== observation.repository) fail('tombstone-repository-mismatch', `${key} repository does not match.`)
  if (tombstone.issueNumber !== observation.issueNumber) fail('tombstone-issue-number-mismatch', `${key} issue number does not match.`)
  if (key !== issueKey(tombstone)) fail('tombstone-identity-mismatch', `${key} identity fields disagree.`)
  if (!/^[a-f0-9]{40}$/u.test(tombstone.deliveredCommit ?? '')) {
    fail('tombstone-delivered-commit-format', `${key} delivered commit must be a full SHA.`)
  }
  if (tombstone.deliveredCommit !== observation.deliveredCommit) {
    fail('tombstone-identity-mismatch', `${key} delivered commit does not match.`)
  }
  const repository = repositoriesByName.get(tombstone.repository)
  if (
    !repository ||
    tombstone.remoteDefaultBranch !== repository.defaultBranch ||
    tombstone.remoteDefaultBranch !== observation.remoteDefaultBranch
  ) {
    fail('tombstone-default-branch-mismatch', `${key} default branch does not match repository facts.`)
  }
  if (!isAncestor(repository.path, tombstone.deliveredCommit, repository.defaultBranch)) {
    fail('tombstone-delivered-commit-unreachable', `${key} delivered commit is not reachable from the default branch.`)
  }
  if (parseTimestamp(tombstone.closedAt, `${key}.closedAt`) > refreshedAt) {
    fail('tombstone-closed-at-future', `${key} closedAt is later than the snapshot.`)
  }
  for (const field of ['remoteState', 'stateReason', 'closedAt', 'verifiedAt']) {
    if (tombstone[field] !== observation[field]) {
      fail('tombstone-identity-mismatch', `${key}.${field} does not match the observation.`)
    }
  }
  return key
}

export function validateCompletedPrerequisites({
  nodes,
  prerequisiteObservations = [],
  repositories,
  refreshedAt,
  readyFrontier = [],
  activeAttempts = []
}) {
  if (!Array.isArray(nodes) || !Array.isArray(repositories)) {
    fail('invalid-schema', 'nodes and repositories must be arrays.')
  }
  const refreshedAtValue = parseTimestamp(refreshedAt, 'refreshedAt')
  const observationsByKey = new Map()
  const observationKeys = new Set()
  for (const observation of prerequisiteObservations) {
    validateObservation(observation, observationKeys)
    observationsByKey.set(observation.dependencyKey, observation)
  }
  const nodesById = new Map()
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || nodesById.has(node.id)) {
      fail('node-duplicate', `Active node identity ${node?.id ?? '<missing>'} is missing or duplicated.`)
    }
    if (observationKeys.has(node.id)) {
      fail('tombstone-active-node-forbidden', 'A closed prerequisite cannot be an active node.')
    }
    if (
      !Array.isArray(node.dependencyKeys) ||
      !Array.isArray(node.activeDependencies) ||
      !Array.isArray(node.satisfiedDependencies)
    ) {
      fail('node-dependencies', `${node.id} must declare all dependency classification arrays.`)
    }
    nodesById.set(node.id, node)
  }
  const repositoriesByName = new Map(repositories.map((entry) => [entry.name, entry]))
  const dependencyResolutions = []
  const closedKeys = new Set()

  for (const node of nodes) {
    const dependencyKeys = new Set(node.dependencyKeys)
    if (dependencyKeys.size !== node.dependencyKeys.length) {
      fail('dependency-unknown', `Node ${node.id} repeats a dependency key.`)
    }
    const active = new Set(node.activeDependencies)
    const satisfied = new Set()
    for (const tombstone of node.satisfiedDependencies) {
      if (satisfied.has(tombstone?.issue)) {
        fail('tombstone-duplicate', `Node ${node.id} repeats tombstone ${tombstone?.issue}.`)
      }
      satisfied.add(tombstone?.issue)
    }
    if ([...active].some((key) => satisfied.has(key))) {
      fail('dependency-classification-overlap', `Node ${node.id} classifies a dependency as both active and satisfied.`)
    }
    for (const dependency of active) {
      if (!dependencyKeys.has(dependency) || !nodesById.has(dependency)) {
        fail('dependency-unknown', `Node ${node.id} has unknown active dependency ${dependency}.`)
      }
      if (dependency === node.id) fail('dependency-cycle', `Node ${node.id} depends on itself.`)
      dependencyResolutions.push({ code: 'dependency-active', dependency, node: node.id })
    }
    for (const tombstone of node.satisfiedDependencies) {
      const key = validateSatisfiedDependency({
        node,
        tombstone,
        observationsByKey,
        repositoriesByName,
        refreshedAt: refreshedAtValue
      })
      closedKeys.add(key)
      dependencyResolutions.push({ code: 'dependency-satisfied', dependency: key, node: node.id })
    }
    for (const dependency of dependencyKeys) {
      if (!active.has(dependency) && !satisfied.has(dependency)) {
        if (observationsByKey.has(dependency)) {
          fail('dependency-edge-deleted', `Node ${node.id} deleted dependency edge ${dependency}.`)
        }
        fail('dependency-unknown', `Node ${node.id} has unknown dependency ${dependency}.`)
      }
    }
    for (const classified of [...active, ...satisfied]) {
      if (!dependencyKeys.has(classified)) {
        fail('dependency-unknown', `Node ${node.id} classifies undeclared dependency ${classified}.`)
      }
    }
  }

  if (readyFrontier.some((id) => closedKeys.has(id))) {
    fail('tombstone-frontier-forbidden', 'A closed prerequisite cannot enter the ready frontier.')
  }
  if (activeAttempts.some((attempt) => closedKeys.has(attempt.issue ?? attempt.nodeId))) {
    fail('tombstone-attempt-forbidden', 'A closed prerequisite cannot have an active attempt.')
  }

  return {
    closedPrerequisiteCount: closedKeys.size,
    dependencyResolutions: dependencyResolutions.sort((left, right) =>
      `${left.node}:${left.dependency}:${left.code}`.localeCompare(`${right.node}:${right.dependency}:${right.code}`)
    ),
    nodeCount: nodes.length,
    valid: true
  }
}
