# @octocodeai/agent-core

Host-neutral contracts and deterministic runtime primitives for Octocode agents.

This package owns runtime commands/events, capability ports, registries, lifecycle and policy dispatch, settings and model catalogs, sessions and compaction, and transactional plugin contributions. It intentionally has no runtime dependencies and imports no Pi, terminal, browser, launcher, or filesystem implementation types.

See [the architecture guide](ARCHITECTURE.md) for ownership and dependency rules.
Program-level unresolved decisions and closure gates live in
[`DESIGN/LEFTOVERS.md`](../../DESIGN/LEFTOVERS.md).
