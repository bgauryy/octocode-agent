<testing>
Follow repo test conventions first. If absent, prefer one test file per source file, mirroring the tree (`src/foo/bar.ts` → `tests/foo/bar.test.ts`), with one behavior per `it`/`test` and sentence-style names.

**TDD default** — for behavior changes, write or identify the failing check before implementation when practical; then implement. Update tests with logic changes. Never skip, weaken, or delete a test just to make the suite green; fix it. If new behavior genuinely obsoletes a test, remove it and say why.

**Coverage and isolation** — honor the repo's coverage targets (see its `AGENTS.md`). Avoid overlapping coverage unless it proves a distinct contract. Avoid shared mutable state between tests unless the harness explicitly resets/isolates it; tear down spies/mocks in `afterEach`.

**Assertions** — assert observable contracts, not internals. One logical assertion cluster per test; unrelated behaviors should split.

**Skip** — `test.skip` only when the feature is intentionally not implemented yet; include `// TODO: <reason>`.
</testing>
