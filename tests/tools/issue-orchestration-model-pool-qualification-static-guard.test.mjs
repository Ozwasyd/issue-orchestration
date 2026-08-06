import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FORBIDDEN = [
    'ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_LIVE',
    'model-pool-qualification.mjs'
]

function files(root) {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(root, entry.name)
        if (entry.isDirectory()) return files(target)
        return entry.isFile() ? [target] : []
    })
}

test('GitHub Actions cannot reference or enable paid model qualification', () => {
    const workflows = files(path.join(ROOT, '.github/workflows'))
    const violations = workflows.flatMap((file) => {
        const text = fs.readFileSync(file, 'utf8')
        return FORBIDDEN.filter((token) => text.includes(token))
            .map((token) => ({ file: path.relative(ROOT, file), token }))
    })
    assert.deepEqual(violations, [])
})

test('normal install and manifest scripts cannot invoke qualification', () => {
    const scripts = [
        'scripts/build-manifest.mjs',
        'scripts/install.mjs',
        'scripts/install-workspace.mjs',
        'scripts/verify-install.mjs',
        'scripts/verify-workspace-install.mjs'
    ]
    const violations = scripts.flatMap((relative) => {
        const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
        return [
            'ISSUE_ORCHESTRATION_MODEL_QUALIFICATION_LIVE',
            'scripts/model-pool-qualification.mjs'
        ].filter((token) => text.includes(token))
            .map((token) => ({ relative, token }))
    })
    assert.deepEqual(violations, [])
})
