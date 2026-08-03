import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temporaryRoots = new Set()

function git(repository, ...args) {
    return execFileSync(
        'git',
        ['-C', repository, ...args],
        { encoding: 'utf8' }
    ).trim()
}

export function createTrustedRepositoryFixture(
    remoteUrl = 'https://github.com/ExampleOrg/RepositoryA.git'
) {
    const repositoryPath = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'issue-orchestration-trusted-repository-'
    ))
    temporaryRoots.add(repositoryPath)
    git(repositoryPath, 'init', '--quiet')
    git(repositoryPath, 'remote', 'add', 'origin', remoteUrl)
    return repositoryPath
}

process.once('exit', () => {
    for (const temporaryRoot of temporaryRoots) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
})
