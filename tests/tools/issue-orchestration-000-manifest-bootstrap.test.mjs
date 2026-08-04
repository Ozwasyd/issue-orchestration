import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const sourceCommit = '3b422ce115d505a03313a16284639d2d69802cf8'

test('emit exact rebuilt manifest for selector binding', () => {
    const result = spawnSync(process.execPath, ['scripts/build-manifest.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            ISSUE_ORCHESTRATION_SOURCE_COMMIT: sourceCommit
        }
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const manifest = fs.readFileSync(path.resolve(root, 'manifest.json'))
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: root,
        encoding: 'utf8'
    })
    assert.equal(tree.status, 0, tree.stderr)
    console.log(`MANIFEST_TREE_SHA=${tree.stdout.trim()}`)
    console.log(`MANIFEST_BASE64=${manifest.toString('base64')}`)
})
