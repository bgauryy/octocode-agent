# Architecture

`@octocodeai/agent-core` is the inward dependency boundary for the native agent and supported host adapters.

- `contracts/` contains host-neutral, versioned wire and process-local capability types.
- `runtime/` contains the kernel, canonical registries, and deny-first policy chain.
- `events/` owns ordered lifecycle dispatch and decision aggregation.
- `session/` owns revision-safe append/replay, deterministic projections, and compaction state.
- `settings/` and `models/` own deterministic registries, precedence, redaction, and concurrency semantics.
- `plugins/` owns transactional contribution publication and reverse unload.

Host adapters own persistence, process execution, transport framing, UI rendering, browser composition, provider translation, and Pi compatibility. Dependencies point from those adapters into this package and never back out.
