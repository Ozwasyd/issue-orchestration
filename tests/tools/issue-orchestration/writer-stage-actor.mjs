import fs from 'node:fs'
import path from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const target = path.resolve(input.repositoryPath, input.relativePath)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, input.content)
process.stdout.write(JSON.stringify({
    status: 'completed',
    changedPath: input.relativePath
}))
