# Terminal design system

Octocode's native terminal and protected browser control center share one semantic
design system. The system defines meaning and content independently of OpenTUI or
HTML; adapters decide how those semantics are rendered.

## Product model

The interactive surface has five layers, in priority order:

1. Persistent chrome: trust, permission mode, model, connection, and working state.
2. Conversation: user and assistant messages plus a safe observable thinking state.
3. Activity: bounded, redacted tool, worker, permission, provider, retry, compaction,
   settings, and turn transitions.
4. Action plane: the one approval, question, or edit that needs input.
5. Footer: context-sensitive keys and truthful context usage.

Required actions displace informational content. The composer and action plane remain
visible at every supported terminal size. Activity remains reachable when the wide
rail collapses.

## State ownership

The OpenTUI composition creates one vanilla Zustand store per renderer with two
explicit data domains and stable named actions:

- `presentation`: immutable runtime-derived state reduced only from typed
  `PresentationEvent` values.
- `view`: serializable terminal state such as viewport, active rail pane, focused
  semantic surface, composer draft, compact-rail override, and shortcut overlay.

Selectors derive active turn, interaction generation, Discuss availability, and
current key hints. OpenTUI renderables, widget instances, abort controllers,
subscriptions, pending promises, filesystem catalogs, and terminal resources never
enter Zustand. Runtime, session, settings, policy, and durable state remain outside
the terminal store.

## Renderer ownership

The fixed terminal shell belongs to `terminal/opentui/renderer.ts`. Semantic
widget components belong under `terminal/opentui/widgets/`, and
`terminal/opentui/opentui-adapter.ts` is the only dynamic widget-to-toolkit
materialization boundary. Rich Markdown, code, diff, and table content remains in
`terminal/opentui/rich-content.ts`. Shared breakpoint and semantic-surface sizing
belongs to `terminal/opentui/layout-policy.ts`.

This separation keeps rendering components discoverable without creating a
single module that mixes shell lifecycle, widget semantics, rich content, input,
and toolkit resources.

## Semantic design

Shared tokens live under `src/presentation/design/`. They own dark and light
palettes, semantic tones, color-independent markers, layout thresholds, browser
typography, and shared action/status content. OpenTUI and browser adapters import
those owners directly.

Every state uses text and a marker in addition to color:

| Tone    | Marker | Meaning                        |
| ------- | -----: | ------------------------------ |
| info    |    `i` | neutral work or information    |
| success |    `✓` | completed positive outcome     |
| warning |    `!` | attention or approval required |
| error   |    `×` | failure, rejection, or denial  |
| focus   |    `>` | current keyboard focus         |

Normal text targets 4.5:1 contrast. Focus, boundaries, and non-text state target
3:1. Automatic color resolution applies `FORCE_COLOR`, then a non-empty
`NO_COLOR`, then `TERM=dumb` and TTY detection. Color never changes semantics.

The protected browser control center consumes the shared sans-serif and monospace
font stacks. A terminal emulator owns terminal font family, size, line height, and
letter spacing. OpenTUI controls only cell-level color and text attributes such as
bold, dim, and underline.

Render regions carry a typed semantic tone. Adapters must not infer severity by
matching words in user-visible prose.

## Content rules

- Show `Thinking…`, `Planning…`, or another runtime-supplied safe phase; never show
  hidden chain-of-thought or vendor reasoning payloads.
- Tool activity shows a human name, sanitized target/input summary, truthful state,
  truthful progress, elapsed time for slow work, and a bounded result or error.
- Worker activity uses a dedicated card keyed by stable worker ID. It shows only the
  optional agent type, canonical running/terminal state, and presentation-derived
  elapsed time. Capabilities, prompts, reasons, handback payloads, and child process
  details never enter the presentation contract.
- The worker inbox opens read-only and is keyed by a monotonic generation. Inspect,
  send, follow-up, steer, and graceful-abort intents carry the visible generation
  and stable worker ID. Force kill is shown separately with explicit approval
  language. Visual and alternate output expose the same semantic command forms,
  while prompt-derived task labels and plan attribution remain internal.
- Plan snapshots allow up to four concurrent `doing` steps. Stable-ID reorder is a
  normal revisioned update; stale revisions, duplicate IDs, unknown dependencies,
  and a fifth active step fail closed. Edit, dependency, reopen, approval,
  rejection, change-request, and review-diff operations use typed intents rather
  than generic patch documents, and affected verification receipts are invalidated.
- Permission cards state the exact action, target, consequence, reason for review,
  supported decisions, and safe default.
- Activity entries are versioned, typed, redacted operational summaries. Raw runtime
  events remain debugging data and never become the public timeline contract.
- Errors say what failed, why when safe, what state remains, and the next action.
- Browser handoffs announce the action, retain the loopback URL as a fallback, and
  state whether changes apply now or next session.
- Binary image paste and terminal-dropped PNG, JPEG, GIF, or WebP paths appear as
  bounded attachment markers containing only a basename, type, and size. Image
  bytes stay outside the visual draft, and workspace paths are read only through
  the capability-rooted filesystem service. Invalid, escaped, or oversized images
  remain visible as input validation failures and never become silent text or OCR
  fallbacks.
- Large multiline text paste may use a compact view marker. Submission expands the
  retained full text; truncation and compaction are presentation concerns only.

## Interaction rules

- `Tab` and `Shift-Tab` traverse focus.
- When the Activity/Context tablist has focus, Left/Right changes the highlighted
  pane and Enter activates it.
- Completion may consume Tab only while its popup is open.
- Every pointer action has a keyboard equivalent; every keyboard-only consequential
  action has a visible affordance.
- `Esc` closes the current overlay or returns focus before it interrupts active work.
- `?` opens a complete shortcut overlay; the footer shows only current high-priority
  actions.

## Responsive behavior

- Wide: conversation and Activity/Context rail are visible together.
- Narrow: conversation is primary and Activity/Context becomes a reachable tab or
  drawer; it is never discarded. A persistent one-line operational summary remains
  beside the composer/footer and prioritizes approval, failure or blocking, active
  worker/tool counts, plan progress, and compaction state.
- Short: lower-priority chrome collapses before the composer or pending action.
- Content wraps by grapheme. Primary content never requires horizontal scrolling.
- Alternate output preserves the complete sanitized reading order independently of
  visual clipping.

## Acceptance contract

Goal: make current work, required actions, and available controls understandable at
every supported terminal size without leaking hidden reasoning.

Primary KPI: the frozen terminal UX scenario suite passes 100% at 120x40, 80x24,
60x20, and 40x18.

Leading indicators:

- every meaningful lifecycle family has a typed activity projection or a documented
  presentation owner;
- terminal and browser adapters consume the same palette tokens;
- no ordinary visual option is duplicated by the semantic and native control paths;
- all pointer actions have tested keyboard parity.

Guardrails:

- existing renderer, PTY restoration, Unicode stream integrity, settings security,
  package boundary, and `NO_COLOR` tests remain green;
- first render remains below 1 second, resize below 1 second, shutdown below 500 ms,
  and peak RSS below 1 GiB in the guarded sensor;
- no hidden thinking text, credentials, raw permission payloads, or raw lifecycle
  payloads enter visual or alternate output.

Accept only when the new held-out scenarios pass and every guardrail holds.
