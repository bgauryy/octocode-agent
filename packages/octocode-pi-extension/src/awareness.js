// Awareness runtime — @octocodeai/octocode-awareness compiled output (zero-dep,
// self-contained rollup bundle: index.js + ./chunks + node: builtins only).
//
// Repo-time: this re-export resolves via the workspace link (tests, src/index.ts).
// Build: scripts/build.mjs copies the compiled awareness out/ into dist/awareness-runtime/
// and overwrites dist/awareness.js to re-export it — so the published extension carries the
// runtime itself. @octocodeai/octocode-awareness is a build-time (dev) dependency only,
// never a runtime/published dependency (same pattern as dist/env.js for @octocodeai/config).
export * from '@octocodeai/octocode-awareness';
