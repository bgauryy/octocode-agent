---
name: octocode-orchestrator
description: "Use when a substantial task needs one agent to coordinate independent workstreams, subagents, measurable evals, TDD, integration, documentation, cleanup, and end-to-end validation. Trigger when an explicit orchestration/delegation request makes coordination choices material, or when a multi-surface program has parallel width beyond batchable reads; skip routine solo edits, explanations, dependent work, and ceremonial agent requests for cheap batchable reads."
---
# Octocode Orchestrator

Turn the running agent into the accountable orchestrator. The parent owns user intent, scope, integration, evidence, and the final verdict; workers supply bounded results, never authority.

Flow: `FRAME → DECOMPOSE → ROUTE → EXECUTE → VERIFY → SYNTHESIZE → CLEANUP → REPORT`.

## Activation gate

- Activate for a substantial explicit orchestrate/delegate/manage-agents request or a consequential task with at least two independently useful workstreams beyond batchable reads. Explicit agent wording never overrides the value/cost gate.
- Stay solo when steps share evolving context, approvals are pending, or delegation would cost more than the work. Batch independent tool reads without spawning.
- Never broaden permissions, external effects, deletion scope, or user intent because this skill activated.

## Workflow

1. **FRAME** success and **DECOMPOSE** the dependency graph with [the orchestration contract](references/orchestration-contract.md) when scope, ownership, or the critical path needs definition.
2. **ROUTE** work with [delegation](references/delegation.md) when a subagent can improve speed, expertise, isolation, or independent verification; otherwise keep it in the parent.
3. **EXECUTE** behavior changes with red→green TDD; add a frozen outcome sensor from [evaluation](references/evaluation.md) only when judging improvement beyond ordinary ship checks.
4. During shared-repository **EXECUTE/VERIFY**, use [Awareness](references/awareness.md) only when peers, overlap, locks, messages, recovery, verification debt, or reusable memory can change the next action.
5. **VERIFY** anchors in the parent, then **SYNTHESIZE**, **CLEANUP**, and **REPORT** through [the completion gate](references/completion.md); never merge worker confidence into proof.

## Hard rules

- After choosing SPAWN, start all independent workers before waiting; give each one bounded scope, disjoint write ownership, acceptance criteria, and a structured return.
- Default to parent-managed workers. Use HANDOFF only when the user wants a specialist to own the rest of the turn; filter its context and preserve the same authority ceiling.
- Keep known routing, gates, budgets, retries, and stop rules deterministic. Spawn agents only for open-ended judgment or genuinely independent work.
- Keep implementation and verifier contexts independent. Treat every worker result as a claim until the parent rechecks load-bearing anchors.
- Worker agreement is not proof. Diversify evidence lanes where practical, preserve dissent, and never delegate approval or permission escalation.
- Do not synthesize while a needed worker is live. Preserve `partial` and `blocked`; disagreement is a finding.
- Tests, types, builds, linters, and observed receipts outrank narrative review. Update affected docs and remove obsolete paths before done.
- Stop or replan on missing authority, undefined success, no runnable sensor for an eval loop, write collisions, failed guardrails, or an unbounded worker graph.

## Resources and checks

- Read [sources](references/references.md) only when auditing why this contract exists.
- Run `node scripts/eval-contract.mjs --help`, then the grader after editing; it rejects stale provenance/subject/case receipts and grades raw fresh-agent decisions.
- Use `evals/cases.json` and `evals/forward-results.json` for auditable regression evidence; keep new held-out prompts outside the folder until their verdict.
