# Memory Recall

Read before planning, editing, recording, superseding, or trusting a remembered fact. Output selection: `references/output-routing.md`.

## Recall

`memory recall` reads canonical SQLite rows, not `.octocode/MEMORY.md`. Run when prior lessons may change the plan. Explicit recall updates bounded popularity metadata; startup `attend` opts out.

```bash
octocode-awareness memory recall --query "<task>" --workspace "$PWD" --smart --compact
```

Useful filters:

- Applicability: `--workspace`, `--artifact`, `--repo`, `--ref`; add `--strict-scope` for exact-only or `--global-only` for unscoped rows.
- Kind: repeat `--label`, `--tag`, or lifecycle `--state`; default state is `ACTIVE`.
- Provenance: repeat `--file`, `--file-regex`, `--reference`, or broad `--regex`.
- Time/value: `--as-of`, `--min-importance`, `--limit`, `--sort`.
- Judgment: `--smart`, `--semantic`, `--explain`; explain adds score components and effective `applied_filters` after widening.

Use `schema command memory recall` when payload fields matter. CLI flags and schema property names can differ, such as `--file` versus stored arrays.

## Ranking

- `--sort smart|score` (default) blends lexical relevance, importance, recency, and access.
- `--sort importance|recent|accessed` isolates one ordering signal.
- `--explain` adds score components so the agent can justify selection.
- `--smart` safely broadens an under-filled strict query by lowering minimum importance then dropping label/tag filters.
- `--as-of <ISO>` evaluates memory validity at a prior time.

`--semantic` reranks only when embeddings exist. Configure `OCTOCODE_EMBED_CMD` as a command that reads text on stdin and prints JSON:

```json
{"embedding":[0.1,0.2],"model":"host-model"}
```

With the command set, `memory record` stores vectors and semantic recall ranks by cosine similarity. When unset/failing, CLI warns and falls back to lexical/salience mode. Pi needs the same host env/API; library callers may use `storeEmbedding` and `searchByEmbedding`. Inspect mode and `score_components` before trusting order. Increase `--limit` only when comparison needs more candidates; compact context is the default. Treat semantic similarity as retrieval help, not truth.

## Automatic Prompt-Time Lead

`format=hook` searches the bounded normal 50-candidate pool, then requires two meaningful query-token matches. It emits at most one scoped `Memory lead — verify` or stays silent; signals and `OVERRIDE` items remain independent. The prompt is transient: no access-count update, memory row, or prompt text in delivery state; Pi clears empty, consumed, and shutdown state.

## Trust And Recording

A hit is a lead. Current user instructions, source, tests, and fresh command output win. Validate file-backed claims and inspect `missing_references`/`query files` before acting. Record only a scoped, reusable, evidence-backed lesson, decision, gotcha, or source lead. Routine status belongs in tasks/signals/refinements, not memory.

If new evidence corrects an active row, use `memory record --supersedes <id>`; replacement history stays immutable.
For reversible cleanup, preview/apply `memory archive`; `memory restore` revives only archived rows, never rows carrying `superseded_by`.
Reserve `memory forget --dry-run` plus apply for reviewed irreversible deletion; keep raw IDs and scope narrow.

## Closure

- Zero results mean broaden vocabulary/filtering or use `--smart`; they do not prove absence.
- A low-confidence result with `judgment_required` needs more evidence before use.
- After using a memory, verify the claim in current context. An existing path is only a lead.
- When the claim changes, supersede/archive it; forget only after review.

Use recall to inform the plan; proof comes from current artifacts and checks.
