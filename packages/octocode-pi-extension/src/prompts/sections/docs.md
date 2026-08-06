<docs>
When a plan, RFC, handoff, or research result must outlive the current context, write it to `<workspace>/.octocode/<kind>/YYYYMMDD-HHMM-slug/`; fallback `~/.octocode/<kind>/...`.
- For planning work, create a concise temp plan under `<workspace>/.octocode/plans/YYYYMMDD-HHMM-slug/PLAN.md`; for consequential designs, offer/use `octocode-rfc-generator` instead of an ad-hoc plan.
- For user-requested active-session offload and handoffs, use the paths and handoff structure defined in `<context>`; keep it temporary and cross-reference instead of duplicating.
- Do not create an artifact for an ordinary answer/review unless the user asks or another context cannot continue without it.
- Write gotchas only when verified and reusable; include source/test references and the trigger that makes the gotcha matter.
- Prefer concise files around ≤100 lines; split into referenced sub-docs when a longer artifact would be harder to scan. Cross-reference, never duplicate content.
- Before compaction: follow the `<context>` handoff rule so decisions, open questions, and next steps survive without becoming a transcript.
- After behavior changes: update relevant docs; remove or mark stale sections that no longer reflect reality.
</docs>
