<code>
**Before writing** — stop at first yes: not needed? already exists? stdlib/platform? dependency? one-line config? Reimplementing what already exists creates divergence that compounds over time.

**Plan before editing** — use the canonical evidence flow and Octocode local tools (search, AST, LSP) to define change, blast radius, and impact before touching anything. Blast radius = callers, type consumers, and runtime paths that break if this change is wrong. Inspect peer work to avoid overlap.

**Before/after edit review** — before editing, review relevant code, architecture, and logic flows; sketch the input → processing → output graph when it clarifies behavior. After editing, re-check the same flow and report flaws that remain or were introduced, with reasons. Look specifically for rigidities, workaround layers, looks-fixed patches, hidden blockers, and choices likely to fail future refactoring.

**Quality bar** — correctness and maintainability beat “get it done at any cost.” Do not hide uncertainty with rigid rules, workarounds, or surface patches; fix the cause or state the blocker. Use checks, evals, and relevant skills to verify claims and solutions.

**Scope** — only changes directly requested or clearly necessary. Bug fixed = done. Add tests, refactors, or cleanup only when needed to prove or safely complete the requested change, or when the user asks.

**Change rules**
- Bug fix — find failure path first (failing test / trace / call site); mirror surrounding style, naming, and patterns.
- Contract change — trace real flow; find callers/producers/consumers; modify the owner; replace old paths instead of layering. Out-of-scope → cite `file:line`, do not fix.
- Options — when multiple fixes are viable, explain choices and impact to the user before broad, risky, or user-visible changes.
- Compatibility — no shims or workaround paths unless required; remove legacy paths; no backward compat unless explicitly asked or public contract requires.

**Clean code** — names state intent not type · one function = one thing at one level · guard clauses · no magic numbers · no dead/speculative params · comments explain why not what · boring over clever. Abstract on the third use, not the first. Side effects at edges; parse at boundaries; config via startup schema.

**Comments** — never attribute external sources, libraries, or prior art in code comments. Mark deliberate simplifications with the ceiling and upgrade path, e.g. `// note: global lock; per-account if throughput matters`.

**FORBIDDEN** — stubs · placeholder wiring · looks-fixed patches · no-op boilerplate · inline suppressions · `_unused` naming · skipped/weakened tests · hardcoded green paths · suppressed lint/type errors. Implement the real path or state the blocker.

**Errors and retry** — no silent catches/fallbacks unless the contract requires it. Surface errors with context; fix the cause. If an approach fails, diagnose, adjust, retry once; never retry blindly.
</code>
