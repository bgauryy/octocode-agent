# Octocode Orchestrator

`octocode-orchestrator` turns the active agent into the accountable coordinator for substantial multi-stage work. It decides whether work should stay solo, be batched, or be delegated; defines measurable acceptance before mutation; and owns integration, documentation, cleanup, and final evidence.

## Capabilities

- Dependency-aware solo, batch, manager-worker, and explicit-handoff routing
- Bounded worker packets, cost/authority ceilings, and disjoint write ownership
- Goal-to-KPI eval contracts and red→green TDD
- Diverse fresh-context verification that does not mistake consensus for proof
- Conditional Awareness coordination for shared repositories
- End-to-end verification, documentation, and redundancy cleanup

## Activation

Implicit invocation is enabled. The trigger targets explicit orchestration/delegation requests and consequential programs with independent workstreams. Routine edits, explanations, and strictly sequential tasks remain with the parent without unnecessary fan-out.

Explicit use:

```text
Use $octocode-orchestrator to coordinate this migration, validate it end to end, update the docs, and remove obsolete paths.
```

## Validation

Run the standalone contract check:

```bash
node scripts/eval-contract.mjs
```

The command validates a stored receipt; it does not invoke a model. The receipt contains raw outputs from separately executed fresh-context agents, and the grader checks activation/topology/TDD/eval/Awareness plus declared ownership, authority, proof, cleanup, and budget boundaries, together with exact instruction and case digests. Any instruction or case edit makes the receipt stale until isolated forward tests run again. New held-out prompts must remain outside the folder until their verdict so edits cannot overfit them.
