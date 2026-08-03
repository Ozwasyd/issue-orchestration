import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimePath = path.join(
    root,
    'skills/issue-orchestration/scripts/executable-slice-compiler.mjs'
)
const runtimeRelativePath = path.relative(root, runtimePath)
const sliceId = 'slice-1874-implementation-compiled-prompt'
const wholeIssueBody = [
    'Depends on: #1817, #1818, #1820, #1832, #1852',
    'Build executable slices, prompts, checkpoints and every writer gate.',
    'Complete the full issue and every acceptance requirement in one dispatch.'
].join('\n')

function clone(value) {
    return structuredClone(value)
}

async function runtime() {
    assert.equal(
        fs.existsSync(runtimePath),
        true,
        `missing #1874 compiled-prompt runtime owner: ${runtimeRelativePath}`
    )
    return import(
        `${pathToFileURL(runtimePath).href}?compiled-prompt=${Date.now()}-${Math.random()}`
    )
}

function planInput() {
    return {
        schema: 'issue-orchestration.stage-work-plan-input.v1',
        runId: 'run-1874-compiled-prompt-contract',
        repository: 'ExampleOrg/RepositoryA',
        issue: 1874,
        node: 'ExampleOrg/RepositoryA#1874',
        stageRole: 'code-implementer',
        stagePhase: 'implementation',
        baseSha: '2499db9517ec4e340bb475443c6ec2984203323c',
        epochId: 'epoch-1874-compiled-prompt-001',
        worktreeIdentity: '/worktrees/issue-1874-implementation',
        semanticContractDigest: 'a'.repeat(64),
        testContractDigest: 'b'.repeat(64),
        authorityDigest: 'c'.repeat(64),
        skillDigest: 'd'.repeat(64),
        baselineDigest: 'e'.repeat(64),
        routingInputDigest: 'f'.repeat(64),
        stageObjective: 'Implement deterministic compiled dispatch prompts',
        acceptanceItems: ['A03-prompt-is-deterministic'],
        orderedSlices: [
            {
                sliceId,
                order: 1,
                prerequisiteSliceIds: [],
                singleObjective: 'Implement deterministic compiled dispatch prompts',
                firstRequiredAction: 'Run the focused prompt compiler test',
                firstReadTargets: [
                    'tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs'
                ],
                firstWritablePath: runtimeRelativePath,
                allowedPaths: [runtimeRelativePath],
                forbiddenPaths: ['tests/**', 'docs/**'],
                requiredCreatedOrModifiedFiles: [runtimeRelativePath],
                requiredCommands: [
                    'node --test tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs'
                ],
                requiredEvidence: [
                    'compiled-prompt-digest',
                    'focused-test'
                ],
                expectedFailureOrProgressSignal: 'compiled prompt assertions pass',
                explicitNonGoals: [
                    'rewrite issue semantics',
                    'test checkpoints',
                    'test writer-stage failures'
                ],
                maxChangedFiles: 1,
                maxOwnedModules: 1,
                maxReadOnlyOperationsBeforeCheckpoint: 8,
                maxNoArtifactToolCalls: 6,
                maxNoArtifactActiveDurationClass: 'short',
                safeCheckpointKind: 'slice-terminal',
                acceptanceItemIds: ['A03-prompt-is-deterministic'],
                completionPredicate: 'compiled prompt is deterministic',
                continuationPredicate: 'verified checkpoint binds the same slice'
            }
        ],
        sliceDependencyGraph: {
            [sliceId]: []
        },
        stageAllowedPaths: [runtimeRelativePath],
        stageForbiddenPaths: ['tests/**', 'docs/**'],
        stageRequiredCommands: [
            'node --test tests/tools/issue-orchestration-compiled-dispatch-prompt.test.mjs'
        ],
        stageTerminalArtifacts: [
            'issue-orchestration.slice-terminal-receipt.v1'
        ]
    }
}

async function compiledContext() {
    const module = await runtime()
    const plan = module.compileStageWorkPlan(planInput())
    const slice = module.compileExecutableSlice({ plan, sliceId })
    return { module, plan, slice }
}

test('formal compiled-prompt implementation exists before contract assertions run', async () => {
    const module = await runtime()

    assert.equal(typeof module.compileDispatchPrompt, 'function')
    assert.equal(typeof module.validateCompiledDispatchPrompt, 'function')
})

test('complete issue direct dispatch is rejected dynamically', async () => {
    const { module, plan, slice } = await compiledContext()

    assert.throws(
        () => module.compileDispatchPrompt({
            plan,
            slice: {
                ...slice,
                singleObjective: wholeIssueBody
            }
        }),
        /whole issue|single objective|executable slice/iu
    )
})

for (const {
    label,
    fields,
    expected
} of [
    {
        label: 'firstRequiredAction',
        fields: ['firstRequiredAction'],
        expected: /first required action|firstRequiredAction|missing/iu
    },
    {
        label: 'firstWritablePath',
        fields: ['firstWritablePath', 'explicitReadOnlyOutput'],
        expected: /first writable path|firstWritablePath|read-only output|missing/iu
    },
    {
        label: 'requiredFiles',
        fields: ['requiredCreatedOrModifiedFiles', 'requiredFiles'],
        expected: /required files|requiredCreatedOrModifiedFiles|requiredFiles|missing/iu
    },
    {
        label: 'requiredCommands',
        fields: ['requiredCommands'],
        expected: /required commands|requiredCommands|missing/iu
    },
    {
        label: 'explicitNonGoals',
        fields: ['explicitNonGoals'],
        expected: /explicit non-goals|explicitNonGoals|missing/iu
    }
]) {
    test(`compiled prompt rejects missing ${label} dynamically`, async () => {
        const { module, plan, slice } = await compiledContext()
        const incomplete = clone(slice)
        for (const field of fields) delete incomplete[field]

        assert.throws(
            () => module.compileDispatchPrompt({ plan, slice: incomplete }),
            expected
        )
    })
}

test('Root modification of a compiled prompt is rejected dynamically', async () => {
    const { module, plan, slice } = await compiledContext()
    const compiled = module.compileDispatchPrompt({ plan, slice })
    const rootEdited = clone(compiled)
    rootEdited.prompt = `${rootEdited.prompt}\nRoot addition: also update docs.`

    assert.match(
        module.validateCompiledDispatchPrompt({
            plan,
            slice,
            compiled: rootEdited
        }).join('\n'),
        /digest|deterministic|root-authored/iu
    )
})
