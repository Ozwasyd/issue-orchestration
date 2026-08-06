#!/usr/bin/env node

import { main } from '../skills/issue-orchestration/scripts/model-pool-qualification.mjs'

main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
        status: 'failed',
        code: error.code ?? 'model-qualification-unexpected',
        message: error.message
    })}\n`)
    process.exitCode = 1
})
