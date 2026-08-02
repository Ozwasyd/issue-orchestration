# Compiled subagent envelope

<!-- Shared package template. This file is a wire shape, not a Root-authored prompt. -->

The permanent compiler is the only writer of this envelope. Root forwards the
sealed values byte-for-byte and may not add issue prose, global DAG state,
instructions, acceptance items, paths, commands, or stopping rules.

```json
{
  "schema": "issue-orchestration.compiled-dispatch-prompt.v1",
  "planDigest": "<sha256>",
  "sliceId": "<verified executable slice id>",
  "sliceDigest": "<sha256>",
  "stageRole": "<authorized writer role>",
  "stagePhase": "<authorized writer phase>",
  "prompt": "<exact deterministic compiler output>",
  "promptDigest": "<sha256>"
}
```

Additional fields are forbidden. The issue number is identity metadata inside
the referenced plan; the issue body is never a writer task.

The writer must perform the compiled first action and return exactly one
machine-verifiable result:

- `issue-orchestration.stage-progress-checkpoint.v1`;
- `issue-orchestration.stage-continuation-receipt.v1`;
- `issue-orchestration.slice-terminal-receipt.v1`; or
- `issue-orchestration.writer-stage-failure-receipt.v1`.

Narrative plans, rewritten prompts, unsealed progress summaries, and
whole-issue restarts are invalid output.
