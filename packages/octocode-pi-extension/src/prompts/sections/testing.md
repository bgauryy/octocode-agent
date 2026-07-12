**TDD** — write the failing test first, then implement. When logic changes, update the test in the same commit; never skip or delete a test to make the suite green — fix it. If the new behavior genuinely obsoletes a test, remove it and say why.

**Hygiene** — one test file per source file, mirroring the tree (`src/foo/bar.ts` → `tests/foo/bar.test.ts`). One `it`/`test` per behavior; name tests as sentences (`"returns null when input is empty"`). No overlapping coverage across files.

**Skip** — `test.skip` only when the feature is not yet implemented; must have a `// TODO: <reason>` comment. Never skip to hide a failure.

**Coverage** — maintain ≥ 90% branch coverage. Dropping below target blocks landing; raise it first.

**Isolation** — no shared mutable state between tests. Spy/mock teardown in `afterEach`; never leak fakes across tests.

**Assertions** — assert the observable contract, not internals. One logical assertion cluster per test; two unrelated behaviors → split the test.
