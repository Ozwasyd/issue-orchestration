# Repository evidence pack

`repository-evidence-pack.mjs` deterministically compiles `issue-orchestration.repository-evidence-pack.v1` before a writer actor is invoked. The pack is embedded in the current actor context envelope and is model input only.

## Bounded inputs

The compiler observes only exact paths and patterns already present in the current executable slice. It records declared read/write scope, applicable instruction digests, exact required commands, declared test ownership, scoped Git base/candidate/status facts, content-addressed read files, bounded literal searches, and a command failure output bound to the current first-failure digest.

It does not crawl the repository, query the network, run models, mutate Git or files, read unrelated logs, or make semantic, acceptance, routing, implementation, verification, candidate, checkpoint, or delivery decisions. Exact byte, search, match, and failure-output ceilings fail closed rather than silently truncating evidence.

## Progressive reads

File content, search output, and failure output become stage-, role-, node-, path-, and digest-bound source references in `actor-context-envelope.v1`. Actors can resolve them only through the existing progressive reader. A wrong reference, role, phase, node, path, or digest is rejected.

Source, base, candidate, instruction, slice, request, or first-failure drift changes the pack identity and requires recompilation. The pack has no persistent cache or lifecycle authority.
