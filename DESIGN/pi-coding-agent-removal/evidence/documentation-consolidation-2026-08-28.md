# Documentation consolidation receipt — 2026-08-28

Scope: all Markdown under `DESIGN/`, with dated evidence treated as immutable history.

Release decision: `HOLD`.

## Changes

- Established `DESIGN/README.md` as the main navigation guide and kept the RFC folder normative.
- Removed the redundant root hooks/plugins specification after merging current implementation state into `HOOKS_AND_PLUGINS.md`.
- Removed the redundant `LEFTOVERS.md` summary.
- Replaced the duplicate 65 KB remaining-work specification with a concise dependency-grouped index.
- Replaced the overlapping TUI/settings root specification with an implementation route guide.
- Reconciled the current-state audit, traceability ledger, readiness matrix, status, specialist specs, steps, implementation guide, and test plan with the real runtime surface evaluation.
- Preserved every pre-existing dated evidence receipt unchanged.

The active document set contains 28 files: 11 root design guides and 17 RFC documents. After this receipt, the full tree contains 51 Markdown files.

## Validation

| Check | Result |
| --- | --- |
| Active-document style lint | 28 files; 0 errors; 0 warnings; 98 informational suggestions |
| Local Markdown targets | 51 files; 100 local links; 0 missing targets |
| Local heading fragments | 1 fragment; 0 missing anchors |
| Deleted-document reference scan | 0 active references to `LEFTOVERS.md` or `05-HOOKS-AND-PLUGINS.md` |
| Stale score/count scan | 0 active `3,294` references; the only `6/10` reference is an immutable dated status change-log entry |
| Whitespace and conflict-marker check | `git diff --check -- DESIGN` passed |

The link and style checks are rerun after adding this receipt. Informational style suggestions are non-blocking and include deliberate contract language, passive constructions, and established technical terms.

## Current state retained

- Native-editor implementation readiness: 8.5/10.
- Native canary readiness: 2/10.
- Pi-retirement readiness: 2/10.
- Weighted cutover readiness: 5/10.
- Release: `HOLD`.

The consolidation changes documentation authority and accuracy only. It does not close the clean-baseline, provider, session/compaction, MCP/hook, settings, PTY/platform, real-host conformance, canary, rollback, observation, or Pi-removal gates.
