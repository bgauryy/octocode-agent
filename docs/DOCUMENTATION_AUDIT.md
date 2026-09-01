# Documentation audit and ratings

Status: audited against the working tree on 2026-08-31.

This page rates maintained documentation by authority, navigation,
verifiability, completeness, and maintainability. It does not treat generated
skill mirrors, prompt fixtures, research snapshots, or dated evidence receipts
as current product documentation.

## Score calculation

Each area receives 10 points:

- authority and freshness: 3 points;
- navigation and ownership: 2 points;
- executable or code-backed verification: 2 points;
- coverage of supported behavior and limits: 2 points;
- maintainability without duplicated inventories: 1 point.

A score below 7 means the area needs structural follow-up. A score below 5
means readers cannot safely use it as an implementation authority.

## Scorecard

| Area | Rating | Authority | Remaining gap |
|---|---:|---|---|
| Repository overview | 8/10 | [`README.md`](../README.md) | Product narrative remains long; keep exact inventories in package/runtime owners. |
| Agent instructions | 7/10 | [`AGENTS.md`](../AGENTS.md) | Strong operational rules, but the file exceeds the preferred index-only size. |
| Completion ledger | 9/10 | [`DESIGN/LEFTOVERS.md`](../DESIGN/LEFTOVERS.md) | Open decisions and external release evidence remain; package documents own implementation detail. |
| Agent core | 9/10 | [Core architecture](../packages/octocode-agent-core/ARCHITECTURE.md) | Some host/session/worker/UI event payloads and version dispatch remain intentionally opaque. |
| Agent testing | 9/10 | [Testing architecture](../packages/octocode-agent-testing/ARCHITECTURE.md) | The dirty-tree mandatory matrix covers all canonical scenarios; a clean candidate and external release matrices remain. |
| Native agent | 9/10 | [Native architecture](../packages/octocode-agent/ARCHITECTURE.md) and [parallelism guide](../packages/octocode-agent/docs/PARALLELISM_AND_WORKERS.md) | The renderer-neutral port is defined; alternate-renderer real-host evidence remains incomplete. |
| Rust native services | 9/10 | [Rust architecture](../packages/octocode-agent-core-rust/ARCHITECTURE.md) | Cross-platform release evidence remains separate from the process-boundary reference. |
| Pi extension | 8/10 | [Pi architecture](../packages/octocode-pi-extension/ARCHITECTURE.md) | Canonical registry composition is live, but complete event, effect, settings, and receipt parity remains open. |
| Awareness | 9/10 | [Awareness architecture](../packages/octocode-awareness/ARCHITECTURE.md) | The large reference set needs periodic command/schema drift checks. |
| Shared contracts | 8/10 | [Shared architecture](../packages/octocode-shared/ARCHITECTURE.md) | Public subpath ownership is documented, but API reference remains source-first. |
| Discovery and MCP | 9/10 | [`docs/DISCOVERY.md`](DISCOVERY.md), [`docs/MCP.md`](MCP.md), and the [native concurrency guide](../packages/octocode-agent/docs/PARALLELISM_AND_WORKERS.md) | Runtime schemas remain the exact field-level authority. |
| Release documentation | 4/10 | [`release/RELEASE_GUIDE.md`](../release/RELEASE_GUIDE.md) | The guide belongs to the sibling platform repository and is retained here only as a migration pointer. |

Overall maintained-documentation rating: **8.2/10** (98 points across 12 areas).

## Authority order

When documents disagree, use this order:

1. executable schemas, package manifests, tests, and production code;
2. package architecture documents and the live completion ledger;
3. package `ARCHITECTURE.md` and package documentation indexes;
4. repository and package READMEs;
5. dated evidence, research notes, and historical migration comparisons.

Correct the owning document first, and then update links or summaries. Do not edit a
historical evidence receipt to make it match later behavior.

## Required follow-up

- Resolve the open decisions in
  [`DESIGN/LEFTOVERS.md`](../DESIGN/LEFTOVERS.md) before documenting cutover as
  complete.
- Replace brittle tool and test counts with runtime or manifest pointers.
- Add an automated internal-link and documented-command check to the repository
  verification gate.
- Move or regenerate release documentation from the sibling `octocode`
  monorepo; do not maintain two authoritative copies.
- Keep Agent Skill documentation under the canonical skill source and use the
  skill build to refresh mirrors.
