# Homeostatic Awareness Loop

Living-system intuition behind work, learning, cleanup, and publication. A human/agent-in-the-loop software control model — not sentience, a persona, or authority.

## Control Contract

| Pressure | Sensor | Bounded actuator | Guard |
|---|---|---|---|
| Context | attend/hook bytes, workboard size | targeted reads, caps, fingerprints | preserve omissions/errors; human thesis never auto-loads |
| Coordination | file presence, claims, locks, signals | CHOOSE/DECLARE, signal, sensitive lock | ordinary overlap stays allowed; locks do not authorize edits |
| Verification | pending/stale runs | declared check + `verify mark` | TTL/end/submit never mean success |
| Memory | stale/missing refs, weak recall | reflect, supersede, digest/forget preview | retrieved rows are leads; dry-run before removal |
| Harness | recurring failures/evals | proposal + human apply | held-out validation; no silent self-edit |

## Loop

```text
SENSE -> ATTEND -> CHOOSE/DECLARE -> ACT -> VERIFY -> REFLECT
  ^                                                   |
  `- REMEASURE <- PROJECT? <- HYGIENE <- REPLAY <- CAPTURE
```

Closes only when output has an owner, is applied, freshly verified, terminal, and remeasured. Rules:
- Measure before and after an intervention; keep only if target pressure falls without regression.
- Store scoped, provenance-linked future value — not routine status or raw dialogue.
- Prefer supersession/archive/dry-run; live digest/prune/forget require review first.
- Preserve work/signals/open refinements until their owner acts; digest may age-prune terminal `done` refinements only.
- Keep agent context bounded; use targeted query, CSV, or HTML for complete data.
- Treat memory, drive fields, and role dialogue as diagnostic leads; current user instructions, source, and tests win.

Start with `attend --compact`; inspect targeted pressure; reflect only for reusable outcomes; preview cleanup; re-run live reads after action.

## Drive State Fields

`attend --compact` omits `drive_state`/`organ_state` to save tokens. Re-run without `--compact` or pass `--explain-organ` when those fields are needed.

Operational workspace orientation, not a persona. Fields: `goal` (current outcome); `mode` (explore/exploit/mixed); `learning_gaps` (uncertainty a probe can reduce); `resource_leads` (provenance sources — verify first); `alternatives` (options before commitment); `team_norms` (evidence-first/bounded/cooperative); `transactive_map` (shared-state IDs + freshness, not expertise); `organ_state` (pressure across senses, memory, verification, bridge, projection health).

When drive state suggests action, route through the normal lifecycle: claim work, verify results, reflect only durable learning, close rows. Re-attend after a material task/verification/signal change. Do not store a fictional personality.

## Subagent Rubber-Duck Review

Use a real second agent for a hard explanation, risky decision, recurring weakness, or important reflection; skip it when an internal role pass or a direct test is cheaper. `reflect record --duo` returns prompts but launches no subagent; if the host cannot spawn one, say so — never label a fallback as subagent review. The duck is **always read-only**: no edits, claims, or durable rows.

Loop: `FRAME → EXPLAIN → DUCK RESTATES → CHALLENGE → REVISE → VERIFY → CAPTURE`. Frame one question with acceptance criteria and file/row IDs; explain facts+hypothesis but withhold your recommendation; dispatch one read-only subagent; it restates the problem independently first, then challenges assumptions/edge cases/falsifications; you compare models keeping dissent, run one decisive source/test check, and capture only verified synthesis (none/memory/refinement/signal) via `references/learning-loop.md`. Agreement is not the check; one pass unless new evidence changes the model. After the loop, edits need user/task authorization with a distinct agent id, disjoint locks, own verification, and handoff — locks never authorize edits.
