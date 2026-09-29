# Compaction

How Octocode keeps long Pi sessions within the context window, and why it is built this way.

## Two layers

1. **Tool-result trimming (every turn, no model call).** At `turn_end`, old tool results over 3,000 characters are cut to 1,200 characters with append-only `context_edit` entries. The 12 most recent results are never touched, and edits are batched 10 at a time so the cached prompt prefix changes rarely. Images are replaced with a placeholder. Subagent (`agent`) reports are never trimmed because they are expensive to regenerate. Pi keeps the raw output in the session file. This is the cheap layer: research on SWE-agent–style agents found that masking old observations matches LLM summarization at about half the cost ([JetBrains, 2025](https://arxiv.org/html/2508.21433)).
2. **Summary compaction (when Pi decides to compact).** Octocode answers `session_before_compact` with its own summary, built on Pi's preparation: the cut point, split turns, the previous summary and token budgets.

## Summary pipeline

```
Pi prepares (cut point, split turn, previous summary, budgets)
  → pick model: small-tier model of the same provider, else the session model
  → summary request through ctx.modelRegistry.streamSimple
      (request-time auth: API key, headers, per-token base URL, provider env;
       the user's retry policy and HTTP/provider timeouts; no prompt cache)
  → keep only the <summary> block; reject it if required sections are missing
  → append <read-files>/<modified-files> computed in code
fallbacks: small model → session model → Pi's default summarizer
a cancelled compaction stays cancelled
```

What Pi's own summarizer still does that Octocode cannot: provider attribution headers and other extensions' `before_provider_headers` hooks. Both live inside Pi's session and are not exposed to extensions.

## The prompt

`src/compaction-prompt.ts`. The summary is a handoff to the model that continues the work, with these sections:

| Section | Why |
|---|---|
| User Intent | The goal and what "done" means; how it changed |
| User Messages (verbatim) | Changing intent and feedback survive exactly (Claude Code: "List ALL user messages") |
| Constraints & Preferences | Must survive every checkpoint (Gemini CLI `active_constraints`) |
| Work Flow | Chronological action → outcome; dead ends marked "ruled out" |
| Files & Code | Paths, symbols and why they matter (Gemini `artifact_trail`) |
| Errors & Fixes | Exact error → cause → fix |
| Verification | Commands and results, and what is still unverified (OpenHands `TESTS`) |
| Decisions & Rejected Approaches | Keeps the agent from retrying rejected ideas; most prompts lack this |
| Delegated & External Results | Subagent, research and askUser outcomes |
| Pending Tasks | Only tasks the user explicitly asked for |
| Current Work | Precisely what was in progress at the cut |
| Next Step | Quotes the latest request verbatim to prevent drift; never revives old requests |

Techniques:

- An `<analysis>` scratchpad comes before the `<summary>`, and only the summary is kept.
- "Text only, no tools" appears at both the start and the end.
- The transcript is treated as data, not instructions.
- Exact paths, errors and commands are preserved.
- Empty sections are written as `(none)` rather than dropped.
- Updates merge into `<previous-summary>` and never drop constraints, decisions or user messages. This avoids the "progressive amnesia" reported after repeated compactions ([openai/codex#14347](https://github.com/openai/codex/issues/14347)).
- `/compact <focus>` adds the user's focus to the prompt.
- A split turn gets its own prefix summary, as in Pi.

File lists are computed in code, not by the model. They combine:

- Pi's own tracking;
- Octocode's `file` tool and its local file reads;
- the lists from earlier Octocode checkpoints, which Pi only carries forward for its own summaries.

## Summary model

Pi's summarizer serializes the conversation as plain text and turns the prompt cache off, so a summary request never reuses the session's cache. That makes a cheaper model a real saving here. Claude Code keeps the session model for a different reason: it reuses the parent prompt cache ([Anthropic](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)).

- **Default:** the strongest small-tier model of the same provider (Haiku, luna, mini, nano, Flash, Lite). The strongest one is judged by input price, because that is the best capability signal the catalog has. The model must be:
  - authenticated;
  - cheaper than the session model;
  - able to fit the whole summary input in its context window;
  - allowed at least 8k output tokens (Cline raised its cap to 8k because reasoning models returned empty summaries).
- **Quality guard:** a summary missing required sections is rejected, and the session model writes it instead.
- **Override:** `OCTOCODE_COMPACTION_MODEL=provider/id` pins a model. `OCTOCODE_COMPACTION_MODEL=current` always uses the session model.

## Sources

- Claude Code compact prompt (reconstruction): https://github.com/LocoreMind/locoagent/blob/main/src/services/compact/prompt.ts
- Codex CLI compact prompt: https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md
- Gemini CLI state snapshot: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts
- OpenHands summarizing condenser: https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/prompts/summarizing_system.j2
- Cline compaction: https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/context/compaction-shared.ts
- Factory, evaluating compression: https://factory.com/news/evaluating-compression
- Anthropic, effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

## Tests

`tests/e2e.test.ts` › `compaction` runs a real Pi session with a scripted provider. It checks:

- the small model is chosen;
- transient errors are retried according to the user's settings;
- user messages reach the prompt verbatim;
- the scratchpad is stripped;
- file lists include Octocode tools and carry across checkpoints;
- a summary that drifts from the format moves to the session model, and the update prompt merges the previous checkpoint;
- a hard failure falls back to Pi's default summarizer;
- the file guard requires fresh reads after compaction.
