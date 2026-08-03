import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = JSON.parse(fs.readFileSync(
  path.join(
    root,
    'tests/fixtures/issue-orchestration/completed-prerequisite-runtime-probes.json'
  ),
  'utf8'
))

function gh(endpoint, jq = null) {
  const args = ['api', endpoint]
  if (jq) args.push('--jq', jq)
  const result = spawnSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000
  })
  assert.equal(
    result.status,
    0,
    `gh api ${endpoint}\n${result.stderr || result.stdout}`
  )
  return JSON.parse(result.stdout)
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

for (const probe of fixture.probes) {
  test(`LIVE ${probe.id} binds issue state, exact evidence, and remote default-branch reachability`, () => {
    const repository = gh(`repos/${probe.repository}`)
    assert.equal(repository.default_branch, probe.defaultBranch)

    const issue = gh(`repos/${probe.repository}/issues/${probe.issueNumber}`)
    assert.equal(issue.state, probe.expectedState)
    assert.equal(issue.state_reason, probe.expectedStateReason)
    assert.equal(issue.closed_at, probe.expectedClosedAt)

    const comment = gh(
      `repos/${probe.repository}/issues/comments/${probe.evidenceCommentId}`
    )
    assert.equal(comment.id, probe.evidenceCommentId)
    assert.equal(digest(comment.body), probe.evidenceCommentDigest)

    const comparison = gh(
      `repos/${probe.repository}/compare/${probe.deliveredCommit}...${probe.defaultBranch}`,
      '{status,base_commit:{sha:.base_commit.sha}}'
    )
    assert.ok(
      comparison.status === 'ahead' || comparison.status === 'identical',
      `${probe.deliveredCommit} is not reachable from ${probe.defaultBranch}: ${comparison.status}`
    )
    assert.equal(comparison.base_commit.sha, probe.deliveredCommit)
  })
}

test('LIVE a reachable delivery commit and completion-sounding comment do not satisfy an OPEN issue', () => {
  const probe = fixture.probes.find((entry) => entry.id === 'live-open-is-not-completed')
  assert.ok(probe)
  assert.equal(probe.expectedState, 'open')
  assert.equal(probe.expectedStateReason, null)
  assert.equal(probe.expectedClosedAt, null)
})
